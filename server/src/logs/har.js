'use strict'

/**
 * HTTP Archive (HAR 1.2) export and import of the log window.
 *
 * `buildHar` renders HTTP entries as HAR entries (WebSocket connections,
 * messages and summaries have no HAR form and are skipped); `parseHar`
 * turns the entries of a HAR file into log entries marked `imported`, with
 * the request body kept so that they can be replayed.
 */

const { STATUS_CODES } = require('http')
const { getContentType } = require('../codecs/compression')
const { bodyAsText, retainRequestBody } = require('./replay')

/** @typedef {import('./search').LogEntry} LogEntry */

/** Placeholders the log uses in place of a body it does not hold. */
const BODY_MARKER = /^\[(streamed|bypass|Binary|WS |WebSocket)/

/**
 * @param {Record<string, unknown> | null | undefined} headers
 * @returns {Array<{ name: string, value: string }>}
 */
function toHarHeaders(headers) {
  if (!headers || typeof headers !== 'object') return []
  /** @type {Array<{ name: string, value: string }>} */
  const result = []
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) result.push({ name, value: String(item) })
    } else {
      result.push({ name, value: String(value) })
    }
  }
  return result
}

/**
 * @param {string} url
 * @returns {Array<{ name: string, value: string }>}
 */
function queryStringOf(url) {
  try {
    return Array.from(new URL(url).searchParams, ([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}

/**
 * @param {unknown} header The Cookie request header.
 * @returns {Array<{ name: string, value: string }>}
 */
function cookiesOf(header) {
  if (typeof header !== 'string' || !header) return []
  return header
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const equals = part.indexOf('=')
      return equals === -1
        ? { name: part, value: '' }
        : { name: part.slice(0, equals), value: part.slice(equals + 1) }
    })
}

/**
 * The request body of an entry as HAR `postData`, or null.
 *
 * @param {LogEntry} log
 * @returns {{ mimeType: string, text: string, comment?: string } | null}
 */
function postDataOf(log) {
  const mimeType = getContentType(log.headers || {}) || 'application/octet-stream'
  if (Buffer.isBuffer(log.requestBodyRaw) && log.requestBodyRaw.length > 0) {
    const text = bodyAsText(log.requestBodyRaw)
    return text !== null
      ? { mimeType, text }
      : { mimeType, text: log.requestBodyRaw.toString('base64'), comment: 'base64' }
  }
  if (typeof log.body === 'string' && log.body && !BODY_MARKER.test(log.body)) {
    return { mimeType, text: log.body }
  }
  if (log.body && typeof log.body === 'object') {
    try {
      return { mimeType, text: JSON.stringify(log.body) }
    } catch {
      return null
    }
  }
  return null
}

/**
 * @param {LogEntry} log
 * @returns {boolean}
 */
function isHttpEntry(log) {
  if (!log || typeof log !== 'object') return false
  if (log.isConnectionLog || log.isWebSocketSummary || log.source === 'websocket') return false
  return log.method !== 'WS' && typeof log.method === 'string'
}

/**
 * @param {LogEntry} log
 */
function entryToHar(log) {
  const url = String(log.fullUrl || log.targetUrl || log.url || '')
  const total = typeof log.totalDurationMs === 'number' ? log.totalDurationMs : null
  const upstream = typeof log.upstreamDurationMs === 'number' ? log.upstreamDurationMs : null
  const time = total ?? upstream ?? 0
  const status = typeof log.statusCode === 'number' ? log.statusCode : 0
  const responseHeaders = log.responseHeaders || {}
  const responseText =
    typeof log.responseBody === 'string' && log.responseBody && !BODY_MARKER.test(log.responseBody)
      ? log.responseBody
      : null
  const responseSize =
    typeof log.responseSize === 'number'
      ? log.responseSize
      : typeof log.responseBytes === 'number'
        ? log.responseBytes
        : responseText !== null
          ? Buffer.byteLength(responseText)
          : 0
  const postData = postDataOf(log)
  const requestSize =
    typeof log.requestBytes === 'number'
      ? log.requestBytes
      : postData
        ? Buffer.byteLength(postData.text)
        : 0
  const location = responseHeaders.location

  const comments = [`source=${log.source || 'unknown'}`]
  if (log.replayOf !== undefined) comments.push(`replayOf=${log.replayOf}`)
  if (log.breakpoint && typeof log.breakpoint === 'object') {
    comments.push(`breakpoint=${JSON.stringify(log.breakpoint)}`)
  }
  if (log.error) comments.push(`error=${log.error}`)

  return {
    startedDateTime: log.timestamp || new Date().toISOString(),
    time,
    request: {
      method: log.method,
      url,
      httpVersion: 'HTTP/1.1',
      cookies: cookiesOf(log.headers && log.headers.cookie),
      headers: toHarHeaders(log.headers),
      queryString: queryStringOf(url),
      ...(postData ? { postData } : {}),
      headersSize: -1,
      bodySize: requestSize
    },
    response: {
      status,
      statusText: STATUS_CODES[status] || '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: toHarHeaders(responseHeaders),
      content: {
        size: responseSize,
        mimeType: getContentType(responseHeaders) || 'x-unknown',
        ...(responseText !== null ? { text: responseText } : {})
      },
      redirectURL: typeof location === 'string' ? location : '',
      headersSize: -1,
      bodySize: responseSize
    },
    cache: {},
    timings: {
      send: 0,
      wait: upstream ?? time,
      receive: upstream !== null && total !== null ? Math.max(0, total - upstream) : 0
    },
    comment: comments.join(' ')
  }
}

/**
 * @param {LogEntry[]} entries Oldest first.
 * @param {{ version: string }} options
 */
function buildHar(entries, { version }) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Interactive Proxy', version },
      entries: entries.filter(isHttpEntry).map(entryToHar)
    }
  }
}

/**
 * @param {unknown} list HAR header or query list.
 * @returns {Record<string, string>}
 */
function fromHarHeaders(list) {
  /** @type {Record<string, string>} */
  const headers = {}
  if (!Array.isArray(list)) return headers
  for (const item of list) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string') continue
    const name = item.name.toLowerCase()
    if (name.startsWith(':')) continue
    const value = item.value === undefined || item.value === null ? '' : String(item.value)
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value
  }
  return headers
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
 * The log entries of a HAR document, oldest first. Entries without a
 * method or an absolute URL are skipped and counted.
 *
 * @param {unknown} har
 * @param {{ maxEntries: number, retainBodyBytes: number }} options
 * @returns {{ entries: LogEntry[], skipped: number }}
 */
function parseHar(har, { maxEntries, retainBodyBytes }) {
  const log = har && typeof har === 'object' ? /** @type {any} */ (har).log : null
  if (!log || typeof log !== 'object' || !Array.isArray(log.entries)) {
    throw new Error('Not a HAR document: "log.entries" is missing')
  }

  /** @type {LogEntry[]} */
  const entries = []
  let skipped = 0

  for (const raw of log.entries) {
    if (entries.length >= maxEntries) {
      skipped += 1
      continue
    }
    const request = raw && typeof raw === 'object' ? raw.request : null
    const response = raw && typeof raw === 'object' ? raw.response : null
    const method = request && typeof request.method === 'string' ? request.method.toUpperCase() : ''
    const url = request && typeof request.url === 'string' ? request.url : ''
    if (!method || !/^https?:\/\//i.test(url)) {
      skipped += 1
      continue
    }

    let parsedUrl
    try {
      parsedUrl = new URL(url)
    } catch {
      skipped += 1
      continue
    }

    const started = Date.parse(raw.startedDateTime)
    const ts = Number.isFinite(started) ? started : Date.now()
    const headers = fromHarHeaders(request.headers)
    const responseHeaders = fromHarHeaders(response && response.headers)
    const postData =
      request.postData && typeof request.postData === 'object' ? request.postData : null
    const bodyText =
      postData && typeof postData.text === 'string' && postData.text.length > 0
        ? postData.text
        : null
    const bodyBuffer =
      bodyText === null
        ? null
        : postData.comment === 'base64'
          ? Buffer.from(bodyText, 'base64')
          : Buffer.from(bodyText, 'utf8')
    if (bodyBuffer && postData.mimeType && !headers['content-type']) {
      headers['content-type'] = String(postData.mimeType)
    }
    const content =
      response && response.content && typeof response.content === 'object' ? response.content : null
    const responseText =
      content && typeof content.text === 'string' && content.text.length > 0
        ? content.encoding === 'base64'
          ? bodyAsText(Buffer.from(content.text, 'base64'))
          : content.text
        : null
    const statusCode = response && Number.isInteger(response.status) ? response.status : undefined
    const time = Number.isFinite(raw.time) ? Math.max(0, raw.time) : undefined
    const wait =
      raw.timings && Number.isFinite(raw.timings.wait) ? Math.max(0, raw.timings.wait) : undefined
    const responseSize =
      content && Number.isFinite(content.size)
        ? content.size
        : responseText !== null
          ? Buffer.byteLength(responseText)
          : 0

    /** @type {LogEntry} */
    const entry = {
      id: ts + Math.random(),
      timestamp: new Date(ts).toISOString(),
      requestStartTs: ts,
      method,
      url: `${parsedUrl.pathname}${parsedUrl.search}`,
      fullUrl: url,
      targetUrl: url,
      source: 'imported',
      headers,
      body: bodyBuffer
        ? (bodyAsText(bodyBuffer) ?? `[Binary data: ${bodyBuffer.length} bytes]`)
        : null,
      responseHeaders,
      responseBody: responseText,
      responseSize,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(time !== undefined ? { totalDurationMs: time } : {}),
      ...(wait !== undefined ? { upstreamDurationMs: wait } : {}),
      ...(bodyBuffer ? { requestBytes: bodyBuffer.length } : {}),
      responseBytes: responseSize
    }
    const requestJson = parseJsonIfAny(typeof entry.body === 'string' ? entry.body : null, headers)
    if (requestJson !== undefined) entry.requestBodyJson = requestJson
    const responseJson = parseJsonIfAny(responseText, responseHeaders)
    if (responseJson !== undefined) entry.responseBodyJson = responseJson
    if (bodyBuffer) retainRequestBody(entry, bodyBuffer, retainBodyBytes)

    entries.push(entry)
  }

  entries.sort((a, b) => a.requestStartTs - b.requestStartTs)
  return { entries, skipped }
}

module.exports = { toHarHeaders, fromHarHeaders, entryToHar, buildHar, parseHar }
