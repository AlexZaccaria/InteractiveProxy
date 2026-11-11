'use strict'

/**
 * Client-facing views of log entries: the summary view used by the list
 * endpoint, the full view with bodies and Connect frames used by the detail
 * endpoint, and the pagination helper behind `/api/logs`.
 */

const { safeString } = require('../util/strings')
const { buildConnectViewForClient } = require('../codecs/connect')
const { getFileTypeFromLogEntry, filterLogsCore } = require('./search')

/** @typedef {import('./search').LogEntry} LogEntry */
/** @typedef {import('./store').LogStore} LogStore */

/**
 * Build the base client-facing log view shared by full and summary variants.
 *
 * @param {LogEntry | null | undefined} log
 * @returns {Record<string, any> | null}
 */
function buildBaseClientLogView(log) {
  if (!log || typeof log !== 'object') return null

  return {
    id: log.id,
    timestamp: log.timestamp,
    method: log.method,
    url: log.url,
    fullUrl: log.fullUrl,
    source: log.source,
    statusCode: log.statusCode,
    direction: log.direction,
    responseSize: log.responseSize,
    error: log.error,
    localResource: log.localResource,
    targetUrl: log.targetUrl,
    fileType: getFileTypeFromLogEntry(log)
  }
}

// Fields to copy if they have a truthy/defined value (common to both views)
const LOG_VIEW_COMMON_FIELDS = [
  'upstreamDurationMs',
  'upstreamErrorCategory',
  'requestStartTs',
  'totalDurationMs',
  'proxyOverheadMs',
  'requestBytes',
  'responseBytes',
  'rewriteCount',
  'replayOf',
  'breakpoint',
  'connectionId',
  'isConnectionLog',
  'isWebSocketSummary',
  'headers',
  'responseHeaders',
  'requestBodySummary',
  'responseBodySummary',
  'rewrites',
  'connectSummary',
  'wsSummary'
]

// Fields to copy only in full view (not summary)
const LOG_VIEW_FULL_FIELDS = [
  'body',
  'responseBody',
  'requestBodyJson',
  'responseBodyJson',
  'requestBodyJsonBefore',
  'responseBodyJsonBefore',
  'requestBodyTextBefore',
  'requestBodyTextAfter',
  'responseBodyTextBefore',
  'responseBodyTextAfter',
  'wsBodyJsonAfter',
  'wsBodyJsonBefore',
  'originalBody',
  'rawRequestBodyPreview',
  'rawResponseBodyPreview'
]

/**
 * Build client log view with optional body/preview fields.
 * When summary=true, omits heavy body/preview data for list endpoints.
 *
 * @param {LogEntry | null | undefined} log
 * @param {{summary?: boolean}} [options]
 * @returns {Record<string, any> | null}
 */
function buildClientLogViewInternal(log, options = {}) {
  const summary = options.summary === true
  const view = buildBaseClientLogView(log)
  if (!view || !log) return null

  // Copy common fields if they have a value
  for (const field of LOG_VIEW_COMMON_FIELDS) {
    const value = log[field]
    if (value !== undefined && value !== null && value !== '') {
      // Special handling for arrays (rewrites) - only include if non-empty
      if (Array.isArray(value)) {
        if (value.length > 0) view[field] = value
      } else {
        view[field] = value
      }
    }
  }

  // Full view only: bodies, previews, frame data
  if (!summary) {
    for (const field of LOG_VIEW_FULL_FIELDS) {
      if (field in log) {
        const value = log[field]
        // Skip empty strings for preview fields
        if (typeof value === 'string' && value.length === 0) continue
        view[field] = value
      }
    }

    // Connect views need special transformation
    if (log.connectRequest) view.connectRequest = buildConnectViewForClient(log.connectRequest)
    if (log.connectResponse) view.connectResponse = buildConnectViewForClient(log.connectResponse)
  }

  return view
}

/**
 * Full view: bodies, previews and Connect frames included.
 *
 * @param {LogEntry | null | undefined} log
 * @returns {Record<string, any> | null}
 */
const buildClientLogView = log => buildClientLogViewInternal(log, { summary: false })

/**
 * Summary view for list endpoints: no bodies or previews.
 *
 * @param {LogEntry | null | undefined} log
 * @returns {Record<string, any> | null}
 */
const buildClientLogSummaryView = log => buildClientLogViewInternal(log, { summary: true })

/**
 * Helper used by /api/logs to apply filtering, pagination and view selection
 * in a single pass over the in-memory log window.
 *
 * @param {import('express').Request} req
 * @param {LogStore} store
 * @returns {{ items: any[], total: number, hasMore: boolean, offset: number, limit: number }}
 */
function filterLogsForApiRequest(req, store) {
  const query = req.query || {}

  const { ordered, total } = filterLogsCore(query, store)

  let offset = 0
  if (typeof query.offset === 'string') {
    const parsed = parseInt(query.offset, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      offset = parsed
    }
  }

  let limit = 50
  if (typeof query.limit === 'string') {
    const parsed = parseInt(query.limit, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = parsed
    }
  }

  if (!Number.isFinite(limit) || limit <= 0) {
    limit = 50
  }

  limit = Math.min(Math.max(limit, 1), store.capacity)

  const start = Math.min(offset, total)
  const end = Math.min(start + limit, total)

  const useSummaryView = safeString(query.view).toLowerCase() === 'summary'
  const items = ordered
    .slice(start, end)
    .map(log => (useSummaryView ? buildClientLogSummaryView(log) : buildClientLogView(log)))
  const hasMore = end < total

  return { items, total, hasMore, offset, limit }
}

module.exports = {
  LOG_VIEW_COMMON_FIELDS,
  LOG_VIEW_FULL_FIELDS,
  buildBaseClientLogView,
  buildClientLogViewInternal,
  buildClientLogView,
  buildClientLogSummaryView,
  filterLogsForApiRequest
}
