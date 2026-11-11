'use strict'

/**
 * Breakpoints: a request whose URL matches an enabled breakpoint rule is
 * held before it is forwarded (request phase) or before its response goes
 * back to the client (response phase), so that the UI can edit it by hand,
 * send it on or abort it. The gate keeps the paused flows, tells the event
 * stream about them and resolves each pause when the API resumes or aborts
 * it, or when `timeoutMs` passes (the flow then continues unchanged).
 *
 * A flow is only paused while an event stream is open: without a UI
 * listening, nobody could resume it.
 */

const { randomUUID } = require('crypto')
const { getContentType, decompressDataForLogging } = require('../codecs/compression')
const { ReplayInputError, applyReplayOverrides, bodyAsText } = require('../logs/replay')
const { logError } = require('../util/logger')

/** @typedef {import('../rules/breakpoint-store').BreakpointRule} BreakpointRule */
/** @typedef {import('../logs/search').LogEntry} LogEntry */
/** @typedef {'request' | 'response'} BreakpointPhase */

/**
 * @typedef {object} PausedRequest
 * @property {string} method
 * @property {string} url
 * @property {Record<string, string>} headers Lower-case names.
 * @property {Buffer | null} body
 */

/**
 * @typedef {object} PausedResponse
 * @property {number} statusCode
 * @property {Record<string, string>} headers Lower-case names.
 * @property {Buffer | null} body The bytes as they would go to the client.
 */

/**
 * What a flow hands to `pause`: the headers as the flow holds them (any
 * value type); the gate keeps plain string values.
 *
 * @typedef {{ method: string, url: string, headers: Record<string, any>, body: Buffer | null }} PausedRequestInput
 * @typedef {{ statusCode: number, headers: Record<string, any>, body: Buffer | null }} PausedResponseInput
 */

/**
 * @typedef {object} PausedItem
 * @property {string} id
 * @property {BreakpointPhase} phase
 * @property {{ id: string, name: string, url: string }} rule
 * @property {string} createdAt
 * @property {PausedRequest} request
 * @property {PausedResponse | null} response
 * @property {(resolution: Resolution) => void} settle
 * @property {NodeJS.Timeout} timer
 */

/**
 * @typedef {{ action: 'continue', edited: boolean, request: PausedRequest, response: PausedResponse | null }
 *   | { action: 'abort' }} Resolution
 */

/**
 * @typedef {object} ResponseOverrides
 * @property {number} [statusCode]
 * @property {Record<string, string>} [headers]
 * @property {string | null} [body]
 * @property {string | null} [bodyBase64]
 */

/**
 * @typedef {object} BreakpointGate
 * @property {(phase: BreakpointPhase, context: { requestUrl: string, fullUrl: string }) => BreakpointRule | null} match
 *   The rule that pauses the flow in `phase`, when breakpoints are on and a UI is listening.
 * @property {(params: { phase: BreakpointPhase, rule: BreakpointRule, request: PausedRequestInput, response?: PausedResponseInput | null }) => Promise<Resolution>} pause
 * @property {() => ReturnType<typeof describeItem>[]} list
 * @property {(id: string, overrides: unknown) => boolean} resume Resolves a pause with the edits; false when the id is unknown.
 * @property {(id: string) => boolean} abort
 * @property {() => number} pendingCount
 * @property {() => void} close Resolve every pause as unchanged (shutdown).
 * @property {(listener: (event: BreakpointEvent) => void) => () => void} onChange
 */

/**
 * @typedef {{ action: 'paused', item: ReturnType<typeof describeItem> }
 *   | { action: 'resumed', id: string, reason: 'resume' | 'abort' | 'timeout' }} BreakpointEvent
 */

/**
 * Request headers the editor does not show: the transport and the proxy set
 * them on their own, and a replay drops them anyway.
 */
const REQUEST_HIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'expect',
  'connection',
  'proxy-connection',
  'keep-alive'
])

/**
 * @param {Record<string, string>} headers
 * @param {Set<string>} hidden
 * @returns {Record<string, string>}
 */
function withoutHeaders(headers, hidden) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !hidden.has(name)))
}

/** Response headers a manual edit never sets: the transport computes them. */
const RESPONSE_DROPPED_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive'
])

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * @param {Record<string, unknown> | null | undefined} headers
 * @returns {Record<string, string>}
 */
function plainHeaders(headers) {
  /** @type {Record<string, string>} */
  const result = {}
  if (!headers || typeof headers !== 'object') return result
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue
    result[String(name).toLowerCase()] = Array.isArray(value)
      ? value.map(item => String(item)).join(', ')
      : String(value)
  }
  return result
}

/**
 * @param {Buffer | null} buffer
 */
function describeBody(buffer) {
  const text = buffer && buffer.length > 0 ? bodyAsText(buffer) : buffer ? '' : null
  return {
    body: text,
    bodyBase64: buffer && text === null ? buffer.toString('base64') : null,
    bodyIsText: text !== null,
    bodySize: buffer ? buffer.length : 0
  }
}

/**
 * The bytes of a response as the editor shows them: decompressed when the
 * body is compressed and the decompression succeeds.
 *
 * @param {PausedResponse} response
 * @returns {{ buffer: Buffer | null, decoded: boolean }}
 */
function responseBodyForDisplay(response) {
  const encoding = response.headers['content-encoding']
  if (!response.body || !encoding) return { buffer: response.body, decoded: false }
  try {
    const decompressed = decompressDataForLogging(
      response.body,
      encoding,
      getContentType(response.headers)
    )
    if (decompressed && Buffer.isBuffer(decompressed))
      return { buffer: decompressed, decoded: true }
  } catch {
    // Shown as received.
  }
  return { buffer: response.body, decoded: false }
}

/**
 * The paused flow as the API and the event stream expose it.
 *
 * @param {PausedItem} item
 */
function describeItem(item) {
  const base = {
    id: item.id,
    phase: item.phase,
    rule: item.rule,
    createdAt: item.createdAt,
    method: item.request.method,
    url: item.request.url,
    headers: item.request.headers,
    ...describeBody(item.request.body)
  }
  if (!item.response) return { ...base, response: null }
  const { buffer, decoded } = responseBodyForDisplay(item.response)
  const described = describeBody(buffer)
  return {
    ...base,
    response: {
      statusCode: item.response.statusCode,
      headers: item.response.headers,
      body: described.body,
      bodyBase64: described.bodyBase64,
      bodyIsText: described.bodyIsText,
      bodySize: described.bodySize,
      bodyDecoded: decoded
    }
  }
}

/**
 * Merge the edits of the response editor into a paused response. A changed
 * body is sent as typed, so `content-encoding` is dropped with it.
 *
 * @param {PausedResponse} response
 * @param {unknown} overrides
 * @returns {{ response: PausedResponse, edited: boolean }}
 */
function applyResponseOverrides(response, overrides) {
  const edits =
    overrides && typeof overrides === 'object' ? /** @type {ResponseOverrides} */ (overrides) : {}
  const result = { ...response, headers: { ...response.headers } }
  let edited = false

  if (edits.statusCode !== undefined) {
    const statusCode = Number(edits.statusCode)
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
      throw new ReplayInputError('The status code must be an integer between 100 and 599')
    }
    if (statusCode !== result.statusCode) edited = true
    result.statusCode = statusCode
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
      if (RESPONSE_DROPPED_HEADERS.has(lower)) continue
      const text = Array.isArray(value) ? value.join(', ') : String(value)
      if (/[\r\n]/.test(text)) throw new ReplayInputError(`Invalid value for header "${name}"`)
      headers[lower] = text
    }
    const kept = Object.fromEntries(
      Object.entries(result.headers).filter(([name]) => !RESPONSE_DROPPED_HEADERS.has(name))
    )
    if (JSON.stringify(kept) !== JSON.stringify(headers)) edited = true
    result.headers = headers
  }

  /** @type {Buffer | null | undefined} */
  let body
  if (edits.bodyBase64 !== undefined && edits.bodyBase64 !== null) {
    const base64 = String(edits.bodyBase64)
    if (!/^[A-Za-z0-9+/=\s]*$/.test(base64)) {
      throw new ReplayInputError('The body is not valid base64')
    }
    body = Buffer.from(base64, 'base64')
  } else if (edits.body !== undefined) {
    body = edits.body === null || edits.body === '' ? null : Buffer.from(String(edits.body), 'utf8')
  }

  if (body !== undefined) {
    const { buffer: shown } = responseBodyForDisplay(response)
    const same =
      (body === null && (!shown || shown.length === 0)) ||
      (body !== null && shown !== null && body.equals(shown))
    if (!same) {
      edited = true
      result.body = body
      delete result.headers['content-encoding']
    }
  }

  return { response: result, edited }
}

/**
 * Record the outcome of a breakpoint on the log entry and, after an edit,
 * make the entry show what was sent.
 *
 * @param {LogEntry | null | undefined} logEntry
 * @param {BreakpointPhase} phase
 * @param {'edited' | 'continued' | 'aborted' | 'timeout'} outcome
 * @param {{ request?: PausedRequest, response?: PausedResponse }} [sent]
 */
function recordBreakpointOnLog(logEntry, phase, outcome, sent = {}) {
  if (!logEntry || typeof logEntry !== 'object') return
  const current =
    logEntry.breakpoint && typeof logEntry.breakpoint === 'object' ? logEntry.breakpoint : {}
  logEntry.breakpoint = { ...current, [phase]: outcome }
  if (outcome !== 'edited') return

  if (phase === 'request' && sent.request) {
    const { method, url, headers, body } = sent.request
    logEntry.method = method
    logEntry.fullUrl = url
    logEntry.targetUrl = url
    logEntry.headers = headers
    const text = body ? bodyAsText(body) : null
    logEntry.body = body ? (text !== null ? text : `[Binary data: ${body.length} bytes]`) : null
    logEntry.requestBodyTextAfter = text !== null ? text : undefined
    logEntry.requestBodyJson = parseJsonIfAny(text, headers)
  }

  if (phase === 'response' && sent.response) {
    const { statusCode, headers, body } = sent.response
    logEntry.statusCode = statusCode
    logEntry.responseHeaders = headers
    logEntry.responseSize = body ? body.length : 0
    const text = body ? bodyAsText(body) : null
    logEntry.responseBody = body
      ? text !== null
        ? text
        : `[Binary data: ${body.length} bytes]`
      : ''
    logEntry.responseBodyTextAfter = text !== null ? text : undefined
    logEntry.responseBodyJson = parseJsonIfAny(text, headers)
  }
}

/**
 * @param {string | null} text
 * @param {Record<string, string>} headers
 * @returns {unknown}
 */
function parseJsonIfAny(text, headers) {
  if (text === null || !getContentType(headers).toLowerCase().includes('json')) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * @typedef {object} BreakpointGateOptions
 * @property {import('../rules/breakpoint-store').BreakpointStore} store
 * @property {() => boolean} isEnabled The global breakpoints flag.
 * @property {() => boolean} hasListeners Whether an event stream is open.
 * @property {number} timeoutMs
 */

/**
 * @param {BreakpointGateOptions} options
 * @returns {BreakpointGate}
 */
function createBreakpointGate({ store, isEnabled, hasListeners, timeoutMs }) {
  /** @type {Map<string, PausedItem>} */
  const pending = new Map()
  /** @type {Set<(event: BreakpointEvent) => void>} */
  const listeners = new Set()

  /** @param {BreakpointEvent} event */
  function notify(event) {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        logError('breakpoints', 'Breakpoint listener failed', error)
      }
    }
  }

  /** @type {BreakpointGate['match']} */
  function match(phase, { requestUrl, fullUrl }) {
    if (!isEnabled() || !hasListeners()) return null
    return store.match(requestUrl, fullUrl, phase)
  }

  /** @type {BreakpointGate['pause']} */
  function pause({ phase, rule, request, response = null }) {
    const id = randomUUID()
    return new Promise(resolve => {
      /** @type {PausedItem} */
      const item = {
        id,
        phase,
        rule: { id: rule.id, name: rule.name, url: rule.url },
        createdAt: new Date().toISOString(),
        request: {
          method: request.method,
          url: request.url,
          headers: withoutHeaders(plainHeaders(request.headers), REQUEST_HIDDEN_HEADERS),
          body: request.body || null
        },
        response: response
          ? {
              statusCode: response.statusCode,
              headers: withoutHeaders(plainHeaders(response.headers), RESPONSE_DROPPED_HEADERS),
              body: response.body || null
            }
          : null,
        settle: resolution => {
          clearTimeout(item.timer)
          pending.delete(id)
          resolve(resolution)
        },
        timer: setTimeout(() => {
          if (!pending.has(id)) return
          item.settle({
            action: 'continue',
            edited: false,
            request: item.request,
            response: item.response
          })
          notify({ action: 'resumed', id, reason: 'timeout' })
        }, timeoutMs)
      }
      item.timer.unref()
      pending.set(id, item)
      notify({ action: 'paused', item: describeItem(item) })
    })
  }

  /** @type {BreakpointGate['resume']} */
  function resume(id, overrides) {
    const item = pending.get(id)
    if (!item) return false

    let request = item.request
    let response = item.response
    let edited = false
    if (item.phase === 'request') {
      const merged = applyReplayOverrides(
        { ...item.request, bodyExpected: false, bodyNotKeptBytes: 0 },
        overrides
      )
      request = {
        method: merged.method,
        url: merged.url,
        headers: merged.headers,
        body: merged.body
      }
      edited =
        request.method !== item.request.method ||
        request.url !== item.request.url ||
        JSON.stringify(request.headers) !== JSON.stringify(item.request.headers) ||
        !sameBody(request.body, item.request.body)
    } else if (item.response) {
      const result = applyResponseOverrides(item.response, overrides)
      response = result.response
      edited = result.edited
    }

    item.settle({ action: 'continue', edited, request, response })
    notify({ action: 'resumed', id, reason: 'resume' })
    return true
  }

  /** @type {BreakpointGate['abort']} */
  function abort(id) {
    const item = pending.get(id)
    if (!item) return false
    item.settle({ action: 'abort' })
    notify({ action: 'resumed', id, reason: 'abort' })
    return true
  }

  function close() {
    for (const item of Array.from(pending.values())) {
      item.settle({
        action: 'continue',
        edited: false,
        request: item.request,
        response: item.response
      })
    }
  }

  return {
    match,
    pause,
    list: () => Array.from(pending.values()).map(describeItem),
    resume,
    abort,
    pendingCount: () => pending.size,
    close,
    onChange: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/**
 * @param {Buffer | null} a
 * @param {Buffer | null} b
 */
function sameBody(a, b) {
  if (!a && !b) return true
  if (!a || !b) return (a || b)?.length === 0
  return a.equals(b)
}

/**
 * The headers to forward after a request edit: the Host header follows the
 * URL when the URL's host changed and the header still names the old one.
 *
 * @param {Record<string, string>} headers
 * @param {string} url The URL to forward to.
 * @param {string} previousUrl The URL before the edit.
 * @returns {Record<string, any>}
 */
function headersForTarget(headers, url, previousUrl) {
  const result = { ...headers }
  try {
    const nextHost = new URL(url).host
    const previousHost = new URL(previousUrl).host
    if (nextHost !== previousHost && (!result.host || result.host === previousHost)) {
      result.host = nextHost
    }
  } catch {
    // An unparsable URL is rejected by the upstream request itself.
  }
  return result
}

/**
 * Answer a client whose flow was aborted at a breakpoint with a 502 and
 * record the abort on the log entry: an entry not logged yet becomes an
 * error entry, one already logged is re-published.
 *
 * @param {object} params
 * @param {import('http').ServerResponse} params.res
 * @param {LogEntry | null | undefined} params.logEntry
 * @param {BreakpointPhase} params.phase
 * @param {boolean} params.alreadyLogged
 * @param {(entry: LogEntry) => void} params.addLog
 * @param {(entry: LogEntry) => void} params.touchLog
 */
function abortAtBreakpoint({ res, logEntry, phase, alreadyLogged, addLog, touchLog }) {
  recordBreakpointOnLog(logEntry, phase, 'aborted')
  if (logEntry) {
    if (alreadyLogged) {
      touchLog(logEntry)
    } else {
      logEntry.source = 'error'
      logEntry.error = 'Aborted at a breakpoint'
      logEntry.statusCode = 502
      addLog(logEntry)
    }
  }
  const payload = JSON.stringify({ error: 'Aborted at a breakpoint' })
  res.writeHead(502, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

/**
 * @param {Buffer | string | undefined | null} body
 * @returns {Buffer | null}
 */
function toBodyBuffer(body) {
  if (Buffer.isBuffer(body)) return body.length > 0 ? body : null
  if (typeof body === 'string') return body.length > 0 ? Buffer.from(body, 'utf8') : null
  return null
}

module.exports = {
  plainHeaders,
  describeItem,
  applyResponseOverrides,
  recordBreakpointOnLog,
  abortAtBreakpoint,
  headersForTarget,
  toBodyBuffer,
  createBreakpointGate
}
