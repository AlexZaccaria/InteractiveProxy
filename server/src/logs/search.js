'use strict'

/**
 * Log search helpers: URL/file-type classification of a log entry, the
 * lower-cased search snapshots computed once per entry, and the filter used by
 * `/api/logs` and `/api/logs/export`.
 *
 * Everything here is stateless; `filterLogsCore` reads the entries from the
 * log store it is given.
 */

const { safeString, queryBool, parseListQuery } = require('../util/strings')
const { logDebug } = require('../util/logger')
const { getContentType } = require('../codecs/compression')
const { buildConnectSearchContentForLog } = require('../codecs/connect')
const { buildSearchSnapshot, buildJsonSearchSnapshot } = require('./preview')

/**
 * In-memory log entry. Entries are plain mutable objects enriched in place by
 * the proxy flows, the rewrite engine and the log store.
 *
 * @typedef {Record<string, any>} LogEntry
 */

/** @typedef {import('./store').LogStore} LogStore */

/**
 * Log sources that are always included in UI filters regardless of the
 * selectedSources query. This mirrors the legacy behaviour inside
 * filterLogsCore but is hoisted to avoid re-allocating the Set on each call.
 *
 * We intentionally *exclude* 'direct' and 'tunnel' here so that bypassed
 * traffic (DIRECT/TUNNEL) does not appear in the default Requests view or
 * audit log sample unless the client explicitly asks for those sources.
 * Their log entries still exist in memory and contribute to dashboard and
 * audit route statistics via applyDashboardStatsDelta/routeStats.
 * @type {Set<string>}
 */
const ALWAYS_INCLUDED_SOURCES = new Set(['local', 'blocked', 'error'])

/**
 * Extract the URL string from a log entry, preferring fullUrl over url.
 * Returns an empty string if neither is available.
 *
 * @param {LogEntry | null | undefined} log
 * @returns {string}
 */
function getLogUrlString (log) {
  if (!log) return ''
  return ((log.fullUrl || log.url) || '').toString()
}

/**
 * File types derived from the URL extension when the response carries no
 * content-type (or a generic octet-stream).
 *
 * @type {Record<string, string>}
 */
const EXTENSION_FILE_TYPES = {
  '.json': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.js': 'js',
  '.mjs': 'js',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.ico': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.wav': 'audio',
  '.woff': 'font',
  '.woff2': 'font',
  '.ttf': 'font',
  '.otf': 'font',
  '.eot': 'font'
}

/**
 * Classify a log entry for the UI file-type filter (json, html, css, js,
 * image, video, audio, font or other) from its response content-type, the
 * URL extension and, as a last resort, the shape of its bodies.
 *
 * @param {LogEntry | null | undefined} log
 * @returns {string}
 */
function getFileTypeFromLogEntry (log) {
  // Early return if already cached
  if (log?.fileType) return log.fileType

  const contentType = (log && log.responseHeaders)
    ? getContentType(log.responseHeaders)
    : ''
  // Extension lookups ignore the query string and fragment.
  const url = getLogUrlString(log).toLowerCase().split(/[?#]/, 1)[0]
  const dot = url.lastIndexOf('.')
  const extension = dot > url.lastIndexOf('/') ? url.slice(dot) : ''

  if (contentType.includes('json')) return 'json'
  if (contentType.includes('html')) return 'html'
  if (contentType.includes('css')) return 'css'
  if (contentType.includes('javascript')) return 'js'
  if (contentType.includes('image/')) return 'image'
  if (contentType.includes('video/')) return 'video'
  if (contentType.includes('audio/')) return 'audio'
  if (contentType.includes('font/') || EXTENSION_FILE_TYPES[extension] === 'font') return 'font'

  if ((!contentType || contentType.includes('octet-stream')) && EXTENSION_FILE_TYPES[extension]) {
    return EXTENSION_FILE_TYPES[extension]
  }

  // If bodies are structured objects, treat them as JSON for cosmetic purposes
  if (log && (typeof log.responseBody === 'object' && log.responseBody !== null)) return 'json'
  if (log && (typeof log.body === 'object' && log.body !== null)) return 'json'

  // Best-effort JSON detection on string bodies when content-type is missing or generic
  /**
   * @param {unknown} value
   * @returns {boolean}
   */
  const tryLooksLikeJsonString = (value) => {
    if (!value || typeof value !== 'string') return false
    if (value.includes('[Binary')) return false
    const trimmed = value.trim()
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return false
    try {
      JSON.parse(trimmed)
      return true
    } catch {
      return false
    }
  }

  if (log) {
    if (tryLooksLikeJsonString(log.responseBody)) return 'json'
    if (tryLooksLikeJsonString(log.body)) return 'json'
  }

  return 'other'
}

/**
 * Ensure request/response body and header search snapshots are populated on a
 * log entry. This centralises snapshot construction so that addLog and
 * filterLogsCore share the same logic.
 *
 * @param {LogEntry | null | undefined} log
 */
function ensureLogSearchSnapshots (log) {
  if (!log || typeof log !== 'object') return

  // Early return if all snapshots are already populated
  const hasAll = typeof log.requestSearchContent === 'string' &&
                 typeof log.headersSearch === 'string' &&
                 typeof log.responseSearchContent === 'string' &&
                 typeof log.responseHeadersSearch === 'string'
  if (hasAll) return

  try {
    // Request side snapshots
    if (typeof log.requestSearchContent !== 'string') {
      const requestBodyString = (() => {
        if (!log.body) return ''
        if (typeof log.body === 'string') return log.body
        try {
          return JSON.stringify(log.body, null, 2)
        } catch {
          return ''
        }
      })()

      const requestConnectContent = buildConnectSearchContentForLog(log.connectRequest)
      const requestRawPreview = safeString(log.rawRequestBodyPreview)

      const requestSearchContent = buildSearchSnapshot([
        requestBodyString,
        requestConnectContent,
        requestRawPreview
      ])

      if (requestSearchContent) {
        log.requestSearchContent = requestSearchContent
      }
    }

    if (typeof log.headersSearch !== 'string' && log.headers) {
      const headersSnapshot = buildJsonSearchSnapshot(log.headers)
      if (headersSnapshot) {
        log.headersSearch = headersSnapshot
      }
    }

    // Response side snapshots
    if (typeof log.responseSearchContent !== 'string') {
      const responseBodyString = (() => {
        if (!log.responseBody) return ''
        if (typeof log.responseBody === 'string') return log.responseBody
        try {
          return JSON.stringify(log.responseBody, null, 2)
        } catch {
          return ''
        }
      })()

      const responseConnectContent = buildConnectSearchContentForLog(log.connectResponse)
      const responseRawPreview = safeString(log.rawResponseBodyPreview)

      const responseSearchContent = buildSearchSnapshot([
        responseBodyString,
        responseConnectContent,
        responseRawPreview
      ])

      if (responseSearchContent) {
        log.responseSearchContent = responseSearchContent
      }
    }

    if (typeof log.responseHeadersSearch !== 'string' && log.responseHeaders) {
      const responseHeadersSnapshot = buildJsonSearchSnapshot(log.responseHeaders)
      if (responseHeadersSnapshot) {
        log.responseHeadersSearch = responseHeadersSnapshot
      }
    }
  } catch (error) {
    // Defensive: never block logging if snapshot computation fails
    logDebug('ensureLogSearchSnapshots', 'Failed to build search snapshots', error)
  }
}

/**
 * Query accepted by {@link filterLogsCore}: the `/api/logs` query string,
 * values as strings (or arrays for repeated keys).
 *
 * @typedef {Record<string, unknown>} LogFilterQuery
 */

/**
 * Core log filtering implementation used by /api/logs and /api/logs/export.
 *
 * Applies text search, body/header search snapshots, source/method/fileType
 * filters and respects ALWAYS_INCLUDED_SOURCES for local/blocked/error
 * entries. The result is in chronological order (oldest entry first).
 *
 * @param {LogFilterQuery | null | undefined} rawQuery
 * @param {LogStore} store
 * @returns {{ ordered: LogEntry[], total: number }}
 */
function filterLogsCore (rawQuery, store) {
  /** @type {LogFilterQuery} */
  const query = rawQuery && typeof rawQuery === 'object' ? rawQuery : {}
  const searchTerm = safeString(query.search)
  const requestBodySearch = safeString(query.requestSearch)
  const responseSearchTerm = safeString(query.responseSearch)

  const selectedSources = parseListQuery(query.sources, ['proxied', 'mitm', 'websocket'])
  const selectedMethods = parseListQuery(query.methods, ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
  const selectedFileTypes = parseListQuery(query.fileTypes, ['json', 'html', 'css', 'js', 'image', 'video', 'audio', 'font', 'other'])

  const showWsConnections = queryBool(query.showWsConnections)

  const requestRewrittenOnly = queryBool(query.requestRewrittenOnly)
  const responseRewrittenOnly = queryBool(query.responseRewrittenOnly)

  const requestBodySearchLower = requestBodySearch.toLowerCase()
  const responseSearchLower = responseSearchTerm.toLowerCase()

  // Use the precomputed blocked pattern list so we don't rebuild the pattern
  // set on every /api/logs call. This is now primarily a fallback for legacy
  // log entries that predate the hiddenByBlockedRules flag; new entries rely
  // on that boolean for a cheap exclusion check.
  const blockedPatterns = store.getBlockedPatterns()
  const patterns = Array.isArray(blockedPatterns) ? blockedPatterns : []

  // Precompute search OR-groups once per API call so we do not repeatedly
  // split and trim the same search term for every log entry.
  const searchOrGroups = searchTerm
    ? searchTerm
        .split('||')
        .map(group => group.trim())
        .filter(group => group)
    : []

  /**
   * @param {LogEntry} log
   * @returns {boolean}
   */
  const matches = log => {
    const urlString = getLogUrlString(log)

    // Hide any entries whose URL matches a blocked rule pattern (enabled or
    // disabled) so that the Requests view stays focused on traffic that has
    // not already been handled by the user. The primary signal is the
    // hiddenByBlockedRules flag computed at insertion time; we fall back to a
    // direct pattern scan only when that flag is not present.
    if (log && typeof log.hiddenByBlockedRules === 'boolean') {
      if (log.hiddenByBlockedRules) return false
    } else if (patterns.length > 0 && urlString && patterns.some(pattern => urlString.includes(pattern))) {
      return false
    }

    if (!showWsConnections && log && log.isConnectionLog) {
      return false
    }

    const matchesSearch = searchTerm === '' || (() => {
      const searchableText =
        (log && typeof log.searchBase === 'string' && log.searchBase.length)
          ? log.searchBase
          : [
              log.url,
              log.method,
              log.targetUrl || '',
              log.localResource || ''
            ].join(' ').toLowerCase()

      if (searchOrGroups.length === 0) return true

      /**
       * @param {string} group
       * @returns {boolean}
       */
      const groupMatches = (group) => {
        const rawTerms = group.split(';').map(t => t.trim()).filter(t => t)
        if (rawTerms.length === 0) return true

        return rawTerms.every(term => {
          if (!term) return true
          if (term.startsWith('!')) {
            const negatedTerm = term.substring(1).toLowerCase()
            return !searchableText.includes(negatedTerm)
          }
          return searchableText.includes(term.toLowerCase())
        })
      }

      return searchOrGroups.some(groupMatches)
    })()

    if (!matchesSearch) return false

    const requestSearchContentLower = safeString(log?.requestSearchContent)
    const headersSearchLower = safeString(log?.headersSearch)

    const matchesRequestBodySearch = requestBodySearch === '' || (
      (requestSearchContentLower && requestSearchContentLower.includes(requestBodySearchLower)) ||
      (headersSearchLower && headersSearchLower.includes(requestBodySearchLower))
    )

    if (!matchesRequestBodySearch) return false

    // Response body/headers search snapshot (cached when available)
    const responseSearchContentLower = safeString(log?.responseSearchContent)
    const responseHeadersSearchLower = safeString(log?.responseHeadersSearch)

    const matchesResponseBodySearch = responseSearchTerm === '' || (
      (responseSearchContentLower && responseSearchContentLower.includes(responseSearchLower)) ||
      (responseHeadersSearchLower && responseHeadersSearchLower.includes(responseSearchLower))
    )

    if (!matchesResponseBodySearch) return false

    // Optional filters: only include logs where rewrites touched the
    // request and/or response side. We infer this from the enriched
    // rewrite metadata attached to each log entry.
    if (requestRewrittenOnly || responseRewrittenOnly) {
      let hasRequestRewrite = false
      let hasResponseRewrite = false

      if (Array.isArray(log.rewrites) && log.rewrites.length > 0) {
        for (const rewrite of log.rewrites) {
          if (!rewrite) continue
          const target = typeof rewrite.target === 'string' ? rewrite.target : 'request'
          if (target === 'request' || target === 'both') hasRequestRewrite = true
          if (target === 'response' || target === 'both') hasResponseRewrite = true
          if (hasRequestRewrite && hasResponseRewrite) break
        }
      }

      if (requestRewrittenOnly && !hasRequestRewrite) return false
      if (responseRewrittenOnly && !hasResponseRewrite) return false
    }

    const source = log && log.source
    const sourceSelected = ALWAYS_INCLUDED_SOURCES.has(source) || selectedSources.includes(source)
    if (!sourceSelected) return false

    const methodSelected = log && (log.method === 'WS' || selectedMethods.includes(log.method))
    if (!methodSelected) return false

    const fileType = (log && log.fileType) ? log.fileType : getFileTypeFromLogEntry(log)
    const fileTypeSelected = selectedFileTypes.includes(fileType)
    if (!fileTypeSelected) return false

    return true
  }

  // The store iterates oldest-first, which is the order the API returns, so
  // no reversal is needed.
  /** @type {LogEntry[]} */
  const ordered = []
  store.forEachOldestFirst(log => {
    if (matches(log)) ordered.push(log)
  })

  return { ordered, total: ordered.length }
}

module.exports = {
  ALWAYS_INCLUDED_SOURCES,
  EXTENSION_FILE_TYPES,
  getLogUrlString,
  getFileTypeFromLogEntry,
  ensureLogSearchSnapshots,
  filterLogsCore
}
