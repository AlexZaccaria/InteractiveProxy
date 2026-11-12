'use strict'

/**
 * Replay of a logged request, and its curl form.
 *
 * `retainRequestBody` keeps the client's request bytes on the entry while it
 * is logged. `buildReplayRequest` turns an entry into the request to send
 * again: method, URL, the request headers minus the ones a client must not
 * repeat, and the kept body. `applyReplayOverrides` merges the edits of the
 * replay form into it, `buildCurlCommand` renders it as a command line, and
 * `createReplayRunner` sends it back through the proxy's own port, so that
 * the rules apply and the response is logged as a new entry marked
 * `replayOf`.
 */

const http = require('http')
const { randomUUID } = require('crypto')
const { REPLAY_MARKER_HEADER } = require('../proxy/headers')

/** @typedef {import('./search').LogEntry} LogEntry */

/**
 * The request a replay sends.
 *
 * @typedef {object} ReplayRequest
 * @property {string} method
 * @property {string} url
 * @property {Record<string, string>} headers Lower-case names.
 * @property {Buffer | null} body
 * @property {boolean} bodyExpected The original request carried a body.
 * @property {number} bodyNotKeptBytes Size of a body that was not kept (over the limit), else 0.
 */

/**
 * The replay form of an entry, as answered by `GET /api/logs/:id/replay`.
 *
 * @typedef {object} ReplayDescription
 * @property {string} method
 * @property {string} url
 * @property {Record<string, string>} headers
 * @property {string | null} body The body as text when it is text.
 * @property {string | null} bodyBase64 The body in base64 when it is binary.
 * @property {boolean} bodyIsText
 * @property {number} bodySize
 * @property {boolean} bodyCaptured
 * @property {boolean} bodyExpected
 * @property {number} bodyNotKeptBytes
 */

/**
 * The edits of the replay form.
 *
 * @typedef {object} ReplayOverrides
 * @property {string} [method]
 * @property {string} [url]
 * @property {Record<string, string>} [headers] Replaces the whole header set.
 * @property {string | null} [body] A text body; `null` sends no body.
 * @property {string | null} [bodyBase64] A binary body in base64.
 */

/**
 * @typedef {object} ReplayResult
 * @property {number} statusCode
 * @property {number} responseBytes
 * @property {number} durationMs
 * @property {string | number | null} logId The entry the replay produced, when logging is on.
 */

/**
 * Headers of the original request that a replay does not repeat: the ones
 * the client, the proxy or the transport set on their own.
 */
const REPLAY_DROPPED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'expect',
  'connection',
  'proxy-connection',
  'keep-alive',
  'upgrade',
  'http2-settings',
  'proxy-authorization',
  'x-target-url',
  REPLAY_MARKER_HEADER
])

const REPLAY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** An invalid edit of the replay form (answered with 400). */
class ReplayInputError extends Error {}

/**
 * Keep the client's request bytes on the entry, hidden from the JSON views
 * and the export (non-enumerable), when they fit `maxBytes`; otherwise
 * record their size so that the replay form can say why the body is missing.
 *
 * @param {LogEntry | null | undefined} entry
 * @param {Buffer | null | undefined} buffer
 * @param {number} maxBytes
 */
function retainRequestBody(entry, buffer, maxBytes) {
  if (!entry || typeof entry !== 'object') return
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return
  if (buffer.length > maxBytes) {
    entry.requestBodyNotKept = buffer.length
    return
  }
  Object.defineProperty(entry, 'requestBodyRaw', {
    value: buffer,
    enumerable: false,
    writable: true,
    configurable: true
  })
}

/**
 * @param {LogEntry} entry
 * @returns {string}
 */
function replayUrlOf(entry) {
  const candidate = entry.targetUrl || entry.fullUrl || entry.url
  return typeof candidate === 'string' ? candidate : ''
}

/**
 * HTTP entries with an absolute URL can be replayed; WebSocket connections,
 * messages and summaries cannot.
 *
 * @param {LogEntry | null | undefined} entry
 * @returns {boolean}
 */
function isReplayable(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.isConnectionLog || entry.isWebSocketSummary || entry.source === 'websocket') {
    return false
  }
  const method = String(entry.method || '').toUpperCase()
  if (!REPLAY_METHODS.has(method)) return false
  return /^https?:\/\//i.test(replayUrlOf(entry))
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function headerValueToString(value) {
  if (Array.isArray(value)) return value.map(item => String(item)).join(', ')
  return String(value)
}

/**
 * @param {LogEntry} entry
 * @returns {ReplayRequest}
 */
function buildReplayRequest(entry) {
  const method = String(entry.method || 'GET').toUpperCase()
  const original =
    entry.headers && typeof entry.headers === 'object'
      ? /** @type {Record<string, unknown>} */ (entry.headers)
      : {}

  /** @type {Record<string, string>} */
  const headers = {}
  for (const [name, value] of Object.entries(original)) {
    const lower = String(name).toLowerCase()
    if (REPLAY_DROPPED_HEADERS.has(lower)) continue
    if (value === undefined || value === null) continue
    headers[lower] = headerValueToString(value)
  }

  const body = Buffer.isBuffer(entry.requestBodyRaw) ? entry.requestBodyRaw : null
  const bodyNotKeptBytes =
    typeof entry.requestBodyNotKept === 'number' && entry.requestBodyNotKept > 0
      ? entry.requestBodyNotKept
      : 0
  const declaredLength = Number(original['content-length'])
  const bodyExpected =
    method !== 'GET' &&
    method !== 'HEAD' &&
    (body !== null ||
      bodyNotKeptBytes > 0 ||
      (Number.isFinite(declaredLength) && declaredLength > 0) ||
      original['transfer-encoding'] !== undefined)

  return { method, url: replayUrlOf(entry), headers, body, bodyExpected, bodyNotKeptBytes }
}

/**
 * Whether a body is text: valid UTF-8 without control characters other
 * than tab, line feed and carriage return.
 *
 * @param {Buffer} buffer
 * @returns {string | null} The text, or null for a binary body.
 */
function bodyAsText(buffer) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return null
  return text
}

/**
 * The replay form of an entry.
 *
 * @param {LogEntry} entry
 * @returns {ReplayDescription}
 */
function describeReplayRequest(entry) {
  const request = buildReplayRequest(entry)
  const text = request.body ? bodyAsText(request.body) : null
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: text,
    bodyBase64: request.body && text === null ? request.body.toString('base64') : null,
    bodyIsText: text !== null,
    bodySize: request.body ? request.body.length : 0,
    bodyCaptured: request.body !== null,
    bodyExpected: request.bodyExpected,
    bodyNotKeptBytes: request.bodyNotKeptBytes
  }
}

/**
 * Merge the edits of the replay form into a request. Throws
 * `ReplayInputError` for an invalid method, URL, header or body.
 *
 * @param {ReplayRequest} request
 * @param {unknown} overrides
 * @returns {ReplayRequest}
 */
function applyReplayOverrides(request, overrides) {
  const edits =
    overrides && typeof overrides === 'object' ? /** @type {ReplayOverrides} */ (overrides) : {}
  const result = { ...request, headers: { ...request.headers } }

  if (edits.method !== undefined) {
    const method = String(edits.method).trim().toUpperCase()
    if (!REPLAY_METHODS.has(method)) {
      throw new ReplayInputError(`Unsupported method "${edits.method}"`)
    }
    result.method = method
  }

  if (edits.url !== undefined) {
    const url = String(edits.url).trim()
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new ReplayInputError('The URL is not valid')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ReplayInputError('The URL must start with http:// or https://')
    }
    result.url = parsed.toString()
  }

  if (edits.headers !== undefined) {
    if (!edits.headers || typeof edits.headers !== 'object' || Array.isArray(edits.headers)) {
      throw new ReplayInputError('Headers must be an object of name: value pairs')
    }
    /** @type {Record<string, string>} */
    const headers = {}
    for (const [name, value] of Object.entries(edits.headers)) {
      const trimmed = String(name).trim()
      if (!HEADER_NAME_PATTERN.test(trimmed)) {
        throw new ReplayInputError(`Invalid header name "${name}"`)
      }
      const lower = trimmed.toLowerCase()
      if (REPLAY_DROPPED_HEADERS.has(lower)) continue
      const text = headerValueToString(value)
      if (/[\r\n]/.test(text)) {
        throw new ReplayInputError(`Invalid value for header "${name}"`)
      }
      headers[lower] = text
    }
    result.headers = headers
  }

  if (edits.bodyBase64 !== undefined && edits.bodyBase64 !== null) {
    const base64 = String(edits.bodyBase64)
    if (!/^[A-Za-z0-9+/=\s]*$/.test(base64)) {
      throw new ReplayInputError('The body is not valid base64')
    }
    result.body = Buffer.from(base64, 'base64')
  } else if (edits.body !== undefined) {
    result.body =
      edits.body === null || edits.body === '' ? null : Buffer.from(String(edits.body), 'utf8')
  }

  return result
}

/**
 * Quote a string for a POSIX shell.
 *
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Render a request as a curl command: one option per line, the body as
 * `--data-raw` when it is text and as a base64 pipe into `--data-binary @-`
 * when it is not. `proxyUrl` adds `-x` so that the command goes through
 * the proxy again.
 *
 * @param {ReplayRequest} request
 * @param {{ proxyUrl?: string | null }} [options]
 * @returns {{ command: string, bodyIncluded: boolean, bodyEncoding: 'text' | 'base64' | null }}
 */
function buildCurlCommand(request, options = {}) {
  const lines = []
  const text = request.body ? bodyAsText(request.body) : null
  const binary = request.body !== null && text === null

  const first = ['curl']
  if (request.method === 'HEAD') {
    first.push('-I')
  } else if (request.method !== 'GET') {
    first.push('-X', request.method)
  }
  first.push(shellQuote(request.url))
  lines.push(first.join(' '))

  if (options.proxyUrl) lines.push(`-x ${shellQuote(options.proxyUrl)}`)

  for (const [name, value] of Object.entries(request.headers)) {
    lines.push(`-H ${shellQuote(`${name}: ${value}`)}`)
  }

  if (request.body && text !== null) {
    lines.push(`--data-raw ${shellQuote(text)}`)
  } else if (binary && request.body) {
    lines.push('--data-binary @-')
  }

  let command = lines.join(' \\\n  ')
  if (binary && request.body) {
    command = `printf '%s' '${request.body.toString('base64')}' | base64 -d | ${command}`
  }

  return {
    command,
    bodyIncluded: request.body !== null,
    bodyEncoding: request.body === null ? null : binary ? 'base64' : 'text'
  }
}

/**
 * @typedef {object} ReplayRunnerOptions
 * @property {number} port The proxy's listening port.
 * @property {string} host The proxy's bind host.
 * @property {import('./store').LogStore} logStore
 * @property {number} [timeoutMs] Time allowed to the whole replay (default two minutes).
 */

/**
 * @typedef {object} ReplayRunner
 * @property {string} proxyUrl The `-x` value of a curl command through the proxy.
 * @property {(entry: LogEntry, request: ReplayRequest) => Promise<ReplayResult>} send
 */

/**
 * Sends replays through the proxy's own port, with an absolute request line
 * (proxy style) so that the request takes the same path as the original
 * one: blocked and filter rules, local resources, rewrites and logging.
 *
 * @param {ReplayRunnerOptions} options
 * @returns {ReplayRunner}
 */
function createReplayRunner({ port, host, logStore, timeoutMs = 120_000 }) {
  const connectHost = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const proxyUrl = `http://${connectHost.includes(':') ? `[${connectHost}]` : connectHost}:${port}`

  /**
   * @param {LogEntry} entry
   * @param {ReplayRequest} request
   * @returns {Promise<ReplayResult>}
   */
  function send(entry, request) {
    const token = randomUUID()
    /** @type {Record<string, string>} */
    const headers = { ...request.headers, [REPLAY_MARKER_HEADER]: `${entry.id};${token}` }
    if (request.body) headers['content-length'] = String(request.body.length)

    /** @type {string | number | null} */
    let logId = null
    const unsubscribe = logStore.onEntryAdded(added => {
      if (added && added.replayToken === token) logId = added.id
    })

    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: connectHost, port, method: request.method, path: request.url, headers },
        res => {
          let responseBytes = 0
          res.on('data', chunk => {
            responseBytes += chunk.length
          })
          res.on('end', () =>
            resolve({
              statusCode: res.statusCode || 0,
              responseBytes,
              durationMs: Date.now() - startedAt,
              logId
            })
          )
          res.on('error', reject)
        }
      )
      req.setTimeout(timeoutMs, () => req.destroy(new Error('the replay timed out')))
      req.on('error', reject)
      if (request.body) {
        req.end(request.body)
      } else {
        req.end()
      }
    }).finally(unsubscribe)
  }

  return { proxyUrl, send }
}

module.exports = {
  ReplayInputError,
  bodyAsText,
  retainRequestBody,
  isReplayable,
  buildReplayRequest,
  describeReplayRequest,
  applyReplayOverrides,
  buildCurlCommand,
  createReplayRunner
}
