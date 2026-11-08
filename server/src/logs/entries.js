'use strict'

/**
 * Log entry construction: the unified factory for HTTP and WebSocket entries
 * (pure) and the helpers that build and submit WebSocket connection, tunnel
 * and message entries or record an upstream error on an entry.
 *
 * `createLogEntryFactory` binds the latter to the interactive-mode getter, the
 * log sink and the rewrite-metadata writer; index.js creates the instance.
 */

const { WS_MAX_TEXT_BYTES } = require('../../config')
const { sanitizeAndStripIdentifyingHeaders } = require('../proxy/headers')
const { httpUrlToWebSocketUrl } = require('../proxy/websocket-url')
const { tryParseWebSocketJson } = require('./preview')
const { classifyUpstreamError } = require('./stats')

/** @typedef {import('./search').LogEntry} LogEntry */
/** @typedef {import('../proxy/headers').HeaderMap} HeaderMap */

/**
 * @typedef {object} WebSocketEntryOptions
 * @property {string} [direction]
 * @property {string} [message]
 * @property {number} [connectionId]
 */

/**
 * @typedef {object} LogEntryParams
 * @property {number} [requestStart] Timestamp for HTTP flows.
 * @property {string} method HTTP method or 'WS'.
 * @property {string} url
 * @property {string} fullUrl
 * @property {HeaderMap} [headers]
 * @property {string} source
 * @property {string} [clientIp]
 * @property {boolean} [sanitizeHeaders] Strip identifying headers.
 * @property {WebSocketEntryOptions} [wsOptions] WebSocket-specific options.
 */

/**
 * @typedef {object} HttpFlowLogEntryParams
 * @property {number} [requestStart]
 * @property {string} method
 * @property {string} url
 * @property {string} fullUrl
 * @property {HeaderMap} [headers]
 * @property {string} source
 * @property {string} [clientIp]
 */

/**
 * Unified log entry factory for HTTP and WebSocket flows.
 * Consolidates createBaseLogEntry, createHttpFlowLogEntry and createWebSocketConnectionLog.
 *
 * @param {LogEntryParams} params
 * @returns {LogEntry}
 */
function createLogEntry({
  requestStart,
  method,
  url,
  fullUrl,
  headers,
  source,
  clientIp,
  sanitizeHeaders = false,
  wsOptions
}) {
  const ts =
    Number.isFinite(requestStart) && typeof requestStart === 'number' ? requestStart : Date.now()
  const processedHeaders = sanitizeHeaders
    ? sanitizeAndStripIdentifyingHeaders(headers || {})
    : headers || {}

  const base = {
    id: ts + Math.random(),
    timestamp: new Date(ts).toISOString(),
    method,
    url,
    fullUrl,
    source,
    headers: processedHeaders
  }

  if (wsOptions) {
    return {
      ...base,
      direction: wsOptions.direction || 'connected',
      isConnectionLog: true,
      body: wsOptions.message || 'WebSocket connection established',
      responseBody: null,
      responseHeaders: null,
      statusCode: 101,
      ...(typeof wsOptions.connectionId === 'number' && { connectionId: wsOptions.connectionId })
    }
  }

  return {
    ...base,
    requestStartTs: ts,
    body: null,
    clientIp
  }
}

/**
 * Create a base HTTP log entry for a proxied/bypass/MITM HTTP flow.
 * Wrapper around createLogEntry with header sanitisation enabled.
 *
 * @param {HttpFlowLogEntryParams} params
 * @returns {LogEntry}
 */
function createHttpFlowLogEntry({ requestStart, method, url, fullUrl, headers, source, clientIp }) {
  return createLogEntry({
    requestStart,
    method,
    url,
    fullUrl,
    headers,
    source,
    clientIp,
    sanitizeHeaders: true
  })
}

/**
 * Build a standardised WebSocket connection log entry.
 * Delegates to createLogEntry with wsOptions.
 *
 * @param {{ wsUrl: string, source: string, headers?: HeaderMap, connectionId?: number, message?: string }} params
 * @returns {LogEntry}
 */
function createWebSocketConnectionLog({ wsUrl, source, headers, connectionId, message }) {
  return createLogEntry({
    method: 'WS',
    url: wsUrl,
    fullUrl: wsUrl,
    headers,
    source,
    wsOptions: { direction: 'connected', message, connectionId }
  })
}

/**
 * @typedef {object} WebSocketMessageLogParams
 * @property {'server->client'|'client->server'} direction
 * @property {string} wsUrl
 * @property {number} connectionId
 * @property {Buffer} payloadBuffer
 * @property {boolean} isBinary
 * @property {string|null} [bodyText]
 * @property {string[]|null} [rewrites]
 * @property {boolean} [loggingDisabled]
 * @property {string} [originalBodyText]
 * @property {any} [bodyJson] Parsed JSON view of the final body when available.
 * @property {any} [originalBodyJson] Parsed JSON view of the original body when available.
 */

/**
 * @typedef {object} LogEntryFactoryDeps
 * @property {() => boolean} isInteractive Whether interactive logging is on.
 * @property {(logEntry: LogEntry) => void} addLog Log sink for completed entries.
 * @property {(logEntry: LogEntry, appliedRuleIds: string[], phase: string) => void} attachRewriteMetadata
 */

/**
 * @typedef {object} LogEntryFactory
 * @property {typeof createLogEntry} createLogEntry
 * @property {typeof createHttpFlowLogEntry} createHttpFlowLogEntry
 * @property {typeof createWebSocketConnectionLog} createWebSocketConnectionLog
 * @property {(params: { targetUrl: string, headers: HeaderMap, suffix?: string }) => void} logWebSocketDirectTunnel
 * @property {(params: WebSocketMessageLogParams) => void} logWebSocketMessage
 * @property {(logEntry: LogEntry | null | undefined, error: Error & { code?: string, name?: string, type?: string }) => void} recordUpstreamErrorOnLog
 */

/**
 * @param {LogEntryFactoryDeps} deps
 * @returns {LogEntryFactory}
 */
function createLogEntryFactory({ isInteractive, addLog, attachRewriteMetadata }) {
  /**
   * Log a WebSocket direct tunnel establishment when interactive mode is enabled.
   * Centralises the common pattern used by both HTTP upgrade and HTTPS MITM flows.
   *
   * @param {object} params
   * @param {string} params.targetUrl - Raw target URL (HTTP or WS).
   * @param {HeaderMap} params.headers - Request headers to sanitize and log.
   * @param {string} [params.suffix=''] - Optional suffix for the log message.
   */
  function logWebSocketDirectTunnel({ targetUrl, headers, suffix = '' }) {
    if (!isInteractive()) return

    const rawUrl = targetUrl || ''
    const wsUrl = httpUrlToWebSocketUrl(rawUrl) || rawUrl
    const message = suffix
      ? `WebSocket direct tunnel established${suffix}`
      : 'WebSocket direct tunnel established'

    const logEntry = createWebSocketConnectionLog({
      wsUrl,
      source: 'direct',
      headers: sanitizeAndStripIdentifyingHeaders(headers || {}),
      message
    })
    addLog(logEntry)
  }

  /**
   * Build and log a WebSocket message entry with consistent structure for both
   * directions. This centralises logging so that server->client and
   * client->server flows behave identically.
   *
   * In addition to the raw body string, this helper enriches the log entry
   * with:
   *   - rewrites: fully described rule metadata via attachRewriteMetadata
   *   - wsBodyJsonAfter: parsed JSON for the final (possibly rewritten) body
   *   - wsBodyJsonBefore: parsed JSON for the original body, when available
   *
   * @param {WebSocketMessageLogParams} params
   */
  function logWebSocketMessage({
    direction,
    wsUrl,
    connectionId,
    payloadBuffer,
    isBinary,
    bodyText,
    rewrites,
    loggingDisabled = false,
    originalBodyText,
    bodyJson,
    originalBodyJson
  }) {
    if (!isInteractive()) return

    const appliedRuleIds = Array.isArray(rewrites) && rewrites.length ? rewrites : null

    let body = bodyText

    if (!body) {
      if (loggingDisabled) {
        body = `[WS ${isBinary ? 'binary' : 'text'} message: ${payloadBuffer.length} bytes, body logging disabled]`
      } else if (isBinary) {
        body = `[Binary data: ${payloadBuffer.length} bytes]`
      } else if (WS_MAX_TEXT_BYTES > 0 && payloadBuffer.length > WS_MAX_TEXT_BYTES) {
        body = `[WebSocket text frame too large to log: ${payloadBuffer.length} bytes, limit=${WS_MAX_TEXT_BYTES}]`
      } else {
        try {
          body = payloadBuffer.toString('utf8')
        } catch {
          body = `[WebSocket text frame decode error: ${payloadBuffer.length} bytes]`
        }
      }
    }

    /** @type {LogEntry} */
    const messageLog = {
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      method: 'WS',
      url: wsUrl,
      fullUrl: wsUrl,
      source: 'websocket',
      direction,
      connectionId,
      headers: {},
      body,
      responseBody: null,
      responseHeaders: null
    }

    if (appliedRuleIds) {
      // WebSocket messages conceptually behave like "request"-side rewrites
      // from the perspective of the originating endpoint.
      attachRewriteMetadata(messageLog, appliedRuleIds, 'request')
    }

    if (typeof originalBodyText === 'string' && originalBodyText.length > 0) {
      messageLog.originalBody = originalBodyText
    }

    // For text frames where we logged the actual payload string, attempt to
    // derive structured JSON snapshots for before/after previews so the
    // frontend can remain a pure rendering layer. Prefer any pre-parsed JSON
    // provided by applyWebSocketRewritesAndDescribe to avoid reparsing.
    if (!isBinary && !loggingDisabled && typeof body === 'string') {
      const afterJson = bodyJson != null ? bodyJson : tryParseWebSocketJson(body)
      if (afterJson !== null) {
        messageLog.wsBodyJsonAfter = afterJson
      }

      if (typeof originalBodyText === 'string' && originalBodyText.length > 0) {
        const beforeJson =
          originalBodyJson != null ? originalBodyJson : tryParseWebSocketJson(originalBodyText)
        if (beforeJson !== null) {
          messageLog.wsBodyJsonBefore = beforeJson
        }
      }
    }

    addLog(messageLog)
  }

  /**
   * Record an upstream error on a log entry in a consistent way and submit
   * the entry.
   *
   * @param {LogEntry | null | undefined} logEntry
   * @param {Error & { code?: string, name?: string, type?: string }} error
   */
  function recordUpstreamErrorOnLog(logEntry, error) {
    if (!logEntry || typeof logEntry !== 'object') return

    logEntry.source = 'error'
    logEntry.error = error && error.message ? error.message : String(error)

    if (typeof logEntry.upstreamDurationMs !== 'number') {
      const startTs =
        typeof logEntry.requestStartTs === 'number'
          ? logEntry.requestStartTs
          : logEntry.timestamp
            ? Date.parse(logEntry.timestamp) || Date.now()
            : Date.now()
      logEntry.upstreamDurationMs = Date.now() - startTs
    }

    logEntry.upstreamErrorCategory = classifyUpstreamError(error)
    addLog(logEntry)
  }

  return {
    createLogEntry,
    createHttpFlowLogEntry,
    createWebSocketConnectionLog,
    logWebSocketDirectTunnel,
    logWebSocketMessage,
    recordUpstreamErrorOnLog
  }
}

module.exports = {
  createLogEntry,
  createHttpFlowLogEntry,
  createWebSocketConnectionLog,
  createLogEntryFactory
}
