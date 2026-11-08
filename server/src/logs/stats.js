'use strict'

/**
 * Dashboard, performance and per-route statistics derived incrementally from
 * the log window, plus the per-entry metrics and host extraction they rely on.
 *
 * `createStats` returns one self-contained instance: the counters are updated
 * with `applyDashboardStatsDelta(entry, +1 | -1)` as entries enter and leave
 * the log store, and `/api/dashboard` / `/api/audit` read plain snapshots.
 */

const { logDebug } = require('../util/logger')
const { getHeaderCaseInsensitive } = require('../codecs/compression')
const { countConnectFrames } = require('../codecs/connect')
const { normalizeHostValue } = require('../rules/url-match')

/** @typedef {import('./search').LogEntry} LogEntry */
/** @typedef {import('./store').LogStore} LogStore */

/**
 * Proxied sources considered "proxied" in dashboard statistics.
 * Kept in sync with the /api/dashboard logic.
 * @type {Set<string>}
 */
const DASHBOARD_PROXIED_SOURCES = new Set(['proxied', 'tunnel', 'mitm', 'websocket', 'direct'])

/**
 * Aggregate statistics for the dashboard derived from request logs.
 * The values mirror what /api/dashboard previously computed by scanning
 * the entire requestLogs array.
 *
 * @typedef {Object} DashboardStats
 * @property {number} total
 * @property {number} served
 * @property {number} proxied
 * @property {number} blocked
 * @property {number} processed
 * @property {number} errors
 * @property {number} editedRequests
 */

/**
 * Create an empty dashboard statistics object.
 *
 * @returns {DashboardStats} Fresh stats with all counters set to zero.
 */
function createEmptyDashboardStats() {
  return {
    total: 0,
    served: 0,
    proxied: 0,
    blocked: 0,
    processed: 0,
    errors: 0,
    editedRequests: 0
  }
}

/**
 * @typedef {{count:number,totalMs:number,maxMs:number}} DurationStats
 * @typedef {{count:number,totalBytes:number,maxBytes:number}} ByteStats
 */

/**
 * Aggregate performance statistics for the dashboard derived from request logs.
 *
 * @typedef {Object} DashboardPerformanceStats
 * @property {DurationStats} upstream
 * @property {DurationStats} total
 * @property {DurationStats} proxy
 * @property {{ request: ByteStats, response: ByteStats }} payloads
 */

/**
 * Create an empty performance statistics structure for the dashboard.
 *
 * @returns {DashboardPerformanceStats}
 */
function createEmptyPerformanceStats() {
  return {
    upstream: { count: 0, totalMs: 0, maxMs: 0 },
    total: { count: 0, totalMs: 0, maxMs: 0 },
    proxy: { count: 0, totalMs: 0, maxMs: 0 },
    payloads: {
      request: { count: 0, totalBytes: 0, maxBytes: 0 },
      response: { count: 0, totalBytes: 0, maxBytes: 0 }
    }
  }
}

/**
 * Route-level statistics entry used for hotspot detection in the dashboard.
 * Keyed by `${host}${pathKey}` where `pathKey` is derived from
 * sanitizePathForSuggestions.
 *
 * Each route aggregates timing/payload metrics plus lightweight source counts so
 * that the audit panel can infer whether a route is typically processed,
 * blocked, redirected (direct/tunnel) or served from a local resource based on
 * *observed* traffic rather than re-evaluating routing rules on a truncated
 * path.
 *
 * @typedef {object} RouteStat
 * @property {string} host
 * @property {string} path
 * @property {number} count
 * @property {number} totalMs
 * @property {number} maxMs
 * @property {number} totalResponseBytes
 * @property {Record<string, number>} sourceCounts
 */

/**
 * Serialisable snapshot of one route with derived averages and the effective
 * handling mode observed for it.
 *
 * @typedef {object} RouteSnapshot
 * @property {string} host
 * @property {string} path
 * @property {number} avgMs
 * @property {number} maxMs
 * @property {number} count
 * @property {number} avgBytes
 * @property {number} kbPerSecond
 * @property {string} handling
 */

/**
 * Host and path of a log entry, used for route and suggestion aggregation.
 *
 * @typedef {{ host: string | null, path: string }} HostInfo
 */

/**
 * Reduce a request path to its first two segments (query string dropped) so
 * that routes and suggestions aggregate by endpoint rather than by id.
 *
 * @param {unknown} path
 * @returns {string}
 */
function sanitizePathForSuggestions(path) {
  if (!path || typeof path !== 'string') return '/'
  const base = path.split('?')[0] || '/'
  const segments = base.split('/').filter(Boolean).slice(0, 2)
  return segments.length ? `/${segments.join('/')}` : '/'
}

/**
 * Extract host and path from a log entry (fullUrl, then url, then the Host
 * header), caching the result on the entry as a non-enumerable property.
 *
 * @param {LogEntry | null | undefined} logEntry
 * @returns {HostInfo | null}
 */
function extractHostInfoFromLog(logEntry) {
  if (!logEntry || typeof logEntry !== 'object') return null

  if (logEntry._hostInfo && logEntry._hostInfo.host) {
    return logEntry._hostInfo
  }

  const headerHost =
    typeof logEntry.headers?.host === 'string' ? logEntry.headers.host.toLowerCase() : null

  /**
   * @param {unknown} candidate
   * @returns {HostInfo | null}
   */
  const tryParseUrl = candidate => {
    if (!candidate || typeof candidate !== 'string') return null
    const trimmed = candidate.trim()
    if (!trimmed) return null

    try {
      const parsed = new URL(trimmed)
      return {
        host: normalizeHostValue(parsed.hostname),
        path: parsed.pathname || '/'
      }
    } catch (error) {
      if (headerHost && trimmed.startsWith('/')) {
        try {
          const parsed = new URL(`http://${headerHost}${trimmed}`)
          return {
            host: normalizeHostValue(parsed.hostname),
            path: parsed.pathname || '/'
          }
        } catch (innerError) {
          return null
        }
      } else if (!trimmed.includes('://')) {
        try {
          const parsed = new URL(`http://${trimmed}`)
          return {
            host: normalizeHostValue(parsed.hostname),
            path: parsed.pathname || '/'
          }
        } catch (innerError) {
          return null
        }
      }
    }
    return null
  }

  const candidates = [logEntry.fullUrl, logEntry.url]
  for (const candidate of candidates) {
    const parsed = tryParseUrl(candidate)
    if (parsed?.host) {
      try {
        Object.defineProperty(logEntry, '_hostInfo', {
          value: parsed,
          writable: false,
          configurable: false,
          enumerable: false
        })
      } catch {
        // The entry may be frozen: the cache is optional and the value is recomputed next time.
      }
      return parsed
    }
  }

  if (headerHost) {
    const info = {
      host: normalizeHostValue(headerHost),
      path: '/'
    }
    try {
      Object.defineProperty(logEntry, '_hostInfo', {
        value: info,
        writable: false,
        configurable: false,
        enumerable: false
      })
    } catch {
      // The entry may be frozen: the cache is optional and the value is recomputed next time.
    }
    return info
  }

  return null
}

/**
 * Classify an upstream error into a coarse category for diagnostics.
 * This is intentionally conservative and based on the error's code/name/
 * message without depending on Undici internals.
 *
 * @param {(Error & { code?: string, name?: string, type?: string }) | null | undefined} error
 * @returns {string} One of: 'timeout', 'aborted', 'connection', 'protocol', 'upstream', 'unknown'.
 */
function classifyUpstreamError(error) {
  if (!error || typeof error !== 'object') return 'unknown'

  const code = typeof error.code === 'string' ? error.code.toUpperCase() : ''
  const name = typeof error.name === 'string' ? error.name.toUpperCase() : ''
  const type = typeof error.type === 'string' ? error.type.toUpperCase() : ''
  const message = typeof error.message === 'string' ? error.message.toUpperCase() : ''

  const combined = `${code} ${name} ${type} ${message}`

  if (combined.includes('TIMEOUT')) return 'timeout'
  if (combined.includes('ABORT') || combined.includes('CANCEL')) return 'aborted'

  if (
    code.startsWith('E') &&
    (code.includes('CONN') ||
      code.includes('REFUSED') ||
      code.includes('RESET') ||
      code.includes('UNREACH') ||
      code.includes('PIPE') ||
      code.includes('ADDR'))
  ) {
    return 'connection'
  }

  if (
    combined.includes('PROTOCOL') ||
    combined.includes('HTTP_PARSER') ||
    combined.includes('UND_ERR')
  ) {
    return 'protocol'
  }

  // Default bucket for other upstream failures.
  return 'upstream'
}

/**
 * Compute lightweight per-request metrics for the audit panel.
 * Mutates the log entry in place.
 *
 * @param {LogEntry | null | undefined} logEntry
 */
function computeLogEntryMetrics(logEntry) {
  if (!logEntry || typeof logEntry !== 'object') return

  try {
    // Timing metrics
    if (
      typeof logEntry.requestStartTs === 'number' &&
      typeof logEntry.totalDurationMs !== 'number'
    ) {
      logEntry.totalDurationMs = Date.now() - logEntry.requestStartTs
    }

    if (
      typeof logEntry.totalDurationMs === 'number' &&
      typeof logEntry.upstreamDurationMs === 'number' &&
      typeof logEntry.proxyOverheadMs !== 'number'
    ) {
      logEntry.proxyOverheadMs = Math.max(0, logEntry.totalDurationMs - logEntry.upstreamDurationMs)
    }

    // Payload sizes
    if (typeof logEntry.requestBytes !== 'number') {
      let requestBytes = 0

      if (typeof logEntry.rawRequestBodyBase64 === 'string' && logEntry.rawRequestBodyBase64) {
        try {
          requestBytes = Buffer.from(logEntry.rawRequestBodyBase64, 'base64').length
        } catch {
          // Malformed base64 preview: the size stays unknown.
        }
      }

      if (!requestBytes && logEntry.headers) {
        const contentLength = getHeaderCaseInsensitive(logEntry.headers, 'content-length')
        const parsed = contentLength && Number(contentLength)
        if (Number.isFinite(parsed) && typeof parsed === 'number' && parsed > 0) {
          requestBytes = parsed
        }
      }

      if (requestBytes > 0) {
        logEntry.requestBytes = requestBytes
      }
    }

    if (typeof logEntry.responseBytes !== 'number') {
      let responseBytes = 0

      if (typeof logEntry.responseSize === 'number' && logEntry.responseSize >= 0) {
        responseBytes = logEntry.responseSize
      } else if (
        typeof logEntry.rawResponseBodyBase64 === 'string' &&
        logEntry.rawResponseBodyBase64
      ) {
        try {
          responseBytes = Buffer.from(logEntry.rawResponseBodyBase64, 'base64').length
        } catch {
          // Malformed base64 preview: the size stays unknown.
        }
      }

      if (responseBytes > 0) {
        logEntry.responseBytes = responseBytes
      }
    }

    // Rewrite summary
    if (typeof logEntry.rewriteCount !== 'number' && Array.isArray(logEntry.rewrites)) {
      logEntry.rewriteCount = logEntry.rewrites.length
    }

    // Connect/gRPC frame summary
    if (!logEntry.connectSummary) {
      const hasRequest = !!logEntry.connectRequest
      const hasResponse = !!logEntry.connectResponse

      if (hasRequest || hasResponse) {
        logEntry.connectSummary = {
          hasRequest,
          hasResponse,
          requestFrameCount: countConnectFrames(logEntry.connectRequest),
          responseFrameCount: countConnectFrames(logEntry.connectResponse)
        }
      }
    }
  } catch (error) {
    // Defensive: never block logging if metric computation fails
    logDebug('computeLogEntryMetrics', 'Failed to compute per-request metrics', error)
  }
}

/**
 * Build a serialisable snapshot of a single entry from routeStats with
 * derived averages and an effective handling mode based on observed sources.
 *
 * @param {RouteStat} route
 * @returns {RouteSnapshot}
 */
function buildRouteSnapshot(route) {
  const avgMs = route.totalMs / route.count
  const totalBytes = typeof route.totalResponseBytes === 'number' ? route.totalResponseBytes : 0
  const avgBytes = route.count > 0 ? totalBytes / route.count : 0
  const kbPerSecond = route.totalMs > 0 ? (totalBytes * 1000) / (1024 * route.totalMs) : 0

  // Derive an effective handling mode for this route from the *observed*
  // traffic sources recorded in routeStats. This powers the audit panel
  // status icon column and keeps it aligned with what actually happened
  // in the log window instead of re-running routing on a truncated path.
  const path = route.path || '/'
  const host = route.host || ''

  const sourceCounts = route.sourceCounts || {}
  const blockedCount = sourceCounts.blocked || 0
  const directCount = (sourceCounts.direct || 0) + (sourceCounts.tunnel || 0)
  const localCount = sourceCounts.local || 0

  let handling = 'processed'
  if (localCount > 0) {
    handling = 'served'
  } else if (blockedCount > 0) {
    handling = 'blocked'
  } else if (directCount > 0) {
    handling = 'redirected'
  }

  return {
    host,
    path,
    avgMs,
    maxMs: route.maxMs,
    count: route.count,
    avgBytes,
    kbPerSecond,
    handling
  }
}

/**
 * Sort comparator for route snapshots, prioritising slower and higher-impact routes.
 *
 * @param {RouteSnapshot} a
 * @param {RouteSnapshot} b
 * @returns {number}
 */
function sortRouteSnapshots(a, b) {
  if (b.avgMs !== a.avgMs) return b.avgMs - a.avgMs
  if (b.maxMs !== a.maxMs) return b.maxMs - a.maxMs
  return b.count - a.count
}

/**
 * Snapshot returned for `/api/dashboard` (the route adds resources, blocked
 * rules and filter metrics).
 *
 * @typedef {object} DashboardSnapshot
 * @property {Omit<DashboardStats, 'editedRequests'>} stats
 * @property {number} editedRequests
 * @property {{ upstreamMs: {avg:number,max:number}, totalMs: {avg:number,max:number}, proxyOverheadMs: {avg:number,max:number} }} performance
 * @property {{ requestBytes: {avg:number,max:number}, responseBytes: {avg:number,max:number} }} payloads
 * @property {{ slowest: RouteSnapshot[], byHandling: Record<'processed'|'redirected'|'blocked'|'served', RouteSnapshot[]> }} routes
 */

/**
 * Snapshot returned for `/api/audit`.
 *
 * @typedef {object} AuditSnapshot
 * @property {Record<string, number>} errorBuckets
 * @property {number} totalErrors
 * @property {{ host: string, count: number, avgDuration: number }[]} hostStats
 */

/**
 * @typedef {object} Stats
 * @property {(logEntry: LogEntry | null | undefined, direction: 1 | -1) => void} applyDashboardStatsDelta
 * @property {(logEntry: LogEntry | null | undefined, bytes: number) => void} recordStreamedResponseSize Account for the body of a streamed response once its size is known.
 * @property {(listener: () => void) => () => void} onChange Listen for changes made outside the add/remove cycle; returns the unsubscribe function.
 * @property {() => void} reset Zero every counter (used by DELETE /api/logs).
 * @property {() => DashboardStats} getDashboardStats The live counters.
 * @property {() => DashboardPerformanceStats} getPerformanceStats The live counters.
 * @property {() => Map<string, RouteStat>} getRouteStats The live map.
 * @property {() => DashboardSnapshot} getDashboardSnapshot
 * @property {(store: LogStore) => AuditSnapshot} buildAuditSnapshot
 */

/**
 * Create the statistics aggregates for one log window.
 *
 * @returns {Stats}
 */
function createStats() {
  /**
   * In-memory dashboard statistics derived from the current log window.
   * Always updated incrementally when logs are added, removed, or cleared.
   *
   * @type {DashboardStats}
   */
  let dashboardStats = createEmptyDashboardStats()

  /**
   * In-memory performance statistics derived from the current log window.
   * Always updated incrementally when logs are added, removed, or cleared.
   *
   * @type {DashboardPerformanceStats}
   */
  let performanceStats = createEmptyPerformanceStats()

  /**
   * Route-level statistics used for hotspot detection in the dashboard.
   *
   * @type {Map<string, RouteStat>}
   */
  let routeStats = new Map()

  /**
   * Apply the contribution of a log entry to the aggregated dashboard statistics.
   * Uses the same rules as the original /api/dashboard implementation.
   *
   * @param {LogEntry | null | undefined} logEntry - The log entry to apply.
   * @param {1|-1} direction - +1 when adding, -1 when removing.
   */
  function applyDashboardStatsDelta(logEntry, direction) {
    if (!logEntry || typeof logEntry !== 'object') return
    if (direction !== 1 && direction !== -1) return

    const source = logEntry.source
    dashboardStats.total += direction

    if (source === 'local') dashboardStats.served += direction
    if (DASHBOARD_PROXIED_SOURCES.has(source)) dashboardStats.proxied += direction
    if (source === 'blocked') dashboardStats.blocked += direction
    if (source === 'error') dashboardStats.errors += direction
    // "processed" tracks traffic that flowed through the proxy internals and
    // was neither blocked nor redirected via the direct/bypass engine. Raw
    // CONNECT tunnels (source === 'tunnel') and explicit direct/bypass flows
    // (source === 'direct') are excluded.
    if (source !== 'blocked' && source !== 'direct' && source !== 'tunnel') {
      dashboardStats.processed += direction
    }

    if (Array.isArray(logEntry.rewrites) && logEntry.rewrites.length > 0) {
      dashboardStats.editedRequests += direction
    }

    // Aggregate lightweight performance metrics for the dashboard.
    const dir = direction

    if (typeof logEntry.upstreamDurationMs === 'number') {
      const value = logEntry.upstreamDurationMs
      performanceStats.upstream.count += dir
      performanceStats.upstream.totalMs += dir * value
      if (dir === 1) {
        performanceStats.upstream.maxMs = Math.max(performanceStats.upstream.maxMs, value)
      }
    }

    if (typeof logEntry.totalDurationMs === 'number') {
      const value = logEntry.totalDurationMs
      performanceStats.total.count += dir
      performanceStats.total.totalMs += dir * value
      if (dir === 1) {
        performanceStats.total.maxMs = Math.max(performanceStats.total.maxMs, value)
      }
    }

    if (typeof logEntry.proxyOverheadMs === 'number') {
      const value = logEntry.proxyOverheadMs
      performanceStats.proxy.count += dir
      performanceStats.proxy.totalMs += dir * value
      if (dir === 1) {
        performanceStats.proxy.maxMs = Math.max(performanceStats.proxy.maxMs, value)
      }
    }

    if (typeof logEntry.requestBytes === 'number') {
      const value = logEntry.requestBytes
      performanceStats.payloads.request.count += dir
      performanceStats.payloads.request.totalBytes += dir * value
      if (dir === 1) {
        performanceStats.payloads.request.maxBytes = Math.max(
          performanceStats.payloads.request.maxBytes,
          value
        )
      }
    }

    if (typeof logEntry.responseBytes === 'number') {
      const value = logEntry.responseBytes
      performanceStats.payloads.response.count += dir
      performanceStats.payloads.response.totalBytes += dir * value
      if (dir === 1) {
        performanceStats.payloads.response.maxBytes = Math.max(
          performanceStats.payloads.response.maxBytes,
          value
        )
      }
    }

    // Route-level hotspot detection statistics.
    const hostInfo = extractHostInfoFromLog(logEntry)
    if (hostInfo && hostInfo.host) {
      const pathKey = sanitizePathForSuggestions(hostInfo.path)
      const routeKey = `${hostInfo.host}${pathKey}`

      let route = routeStats.get(routeKey)
      if (!route) {
        route = {
          host: hostInfo.host,
          path: pathKey,
          count: 0,
          totalMs: 0,
          maxMs: 0,
          totalResponseBytes: 0,
          sourceCounts: Object.create(null)
        }
      }

      const totalMs = typeof logEntry.totalDurationMs === 'number' ? logEntry.totalDurationMs : 0
      const responseBytes = typeof logEntry.responseBytes === 'number' ? logEntry.responseBytes : 0

      route.count += dir
      route.totalMs += dir * totalMs
      route.totalResponseBytes += dir * responseBytes

      if (dir === 1 && totalMs > 0) {
        route.maxMs = Math.max(route.maxMs, totalMs)
      }

      // Track per-source counts so audit handling can be derived from observed
      // traffic for this host/path instead of re-running routing on a truncated
      // path. Counts are adjusted symmetrically when logs roll out of the
      // in-memory window.
      const src =
        typeof logEntry.source === 'string' && logEntry.source ? logEntry.source : 'unknown'
      const sourceCounts = route.sourceCounts || (route.sourceCounts = Object.create(null))
      const prevSourceCount = sourceCounts[src] || 0
      const nextSourceCount = prevSourceCount + dir
      if (nextSourceCount <= 0) {
        delete sourceCounts[src]
      } else {
        sourceCounts[src] = nextSourceCount
      }

      if (route.count <= 0 || route.totalMs <= 0) {
        routeStats.delete(routeKey)
      } else {
        routeStats.set(routeKey, route)
      }
    }
  }

  /** @type {Set<() => void>} */
  const changeListeners = new Set()

  /**
   * Listen for aggregate changes that happen outside the add/remove cycle of
   * the log store (today: the size of a streamed response, known only when
   * its transfer ends).
   *
   * @param {() => void} listener
   * @returns {() => void} Unsubscribe.
   */
  function onChange(listener) {
    changeListeners.add(listener)
    return () => {
      changeListeners.delete(listener)
    }
  }

  function notifyChange() {
    for (const listener of changeListeners) {
      try {
        listener()
      } catch (error) {
        logDebug('stats', 'A stats change listener failed', error)
      }
    }
  }

  /**
   * Account for the body of a streamed response, whose size is known only
   * when the transfer ends: the entry entered the window with
   * `responseSize: null`, so its bytes reached neither the payload
   * aggregates nor its route. Applies what applyDashboardStatsDelta(entry, 1)
   * would have applied for that size and stores it on the entry, so that the
   * entry's eviction subtracts the same amount. Idempotent per entry.
   *
   * @param {LogEntry | null | undefined} logEntry
   * @param {number} bytes
   */
  function recordStreamedResponseSize(logEntry, bytes) {
    if (!logEntry || typeof logEntry !== 'object') return
    if (!Number.isFinite(bytes) || bytes < 0) return
    if (typeof logEntry.responseBytes === 'number') return

    logEntry.responseSize = bytes
    logEntry.responseBytes = bytes

    performanceStats.payloads.response.count += 1
    performanceStats.payloads.response.totalBytes += bytes
    performanceStats.payloads.response.maxBytes = Math.max(
      performanceStats.payloads.response.maxBytes,
      bytes
    )

    const hostInfo = extractHostInfoFromLog(logEntry)
    if (hostInfo && hostInfo.host) {
      const pathKey = sanitizePathForSuggestions(hostInfo.path)
      const routeKey = `${hostInfo.host}${pathKey}`
      let route = routeStats.get(routeKey)
      if (!route) {
        // The entry's route was dropped at add time because its duration
        // rounded to 0 ms (routes exist only with a positive total); recreate
        // it with this entry so the streamed bytes stay visible.
        const src =
          typeof logEntry.source === 'string' && logEntry.source ? logEntry.source : 'unknown'
        const totalMs = typeof logEntry.totalDurationMs === 'number' ? logEntry.totalDurationMs : 0
        route = {
          host: hostInfo.host,
          path: pathKey,
          count: 1,
          totalMs,
          maxMs: totalMs,
          totalResponseBytes: 0,
          sourceCounts: Object.create(null)
        }
        route.sourceCounts[src] = 1
      }
      route.totalResponseBytes += bytes
      routeStats.set(routeKey, route)
    }

    notifyChange()
  }

  function reset() {
    dashboardStats = createEmptyDashboardStats()
    performanceStats = createEmptyPerformanceStats()
    routeStats = new Map()
  }

  /**
   * @returns {DashboardSnapshot}
   */
  function getDashboardSnapshot() {
    const { editedRequests, ...stats } = dashboardStats

    const perf = performanceStats

    /**
     * @param {number} total
     * @param {number} count
     * @returns {number}
     */
    const safeAverage = (total, count) => (count > 0 ? total / count : 0)

    const performance = {
      upstreamMs: {
        avg: safeAverage(perf.upstream.totalMs, perf.upstream.count),
        max: perf.upstream.maxMs
      },
      totalMs: {
        avg: safeAverage(perf.total.totalMs, perf.total.count),
        max: perf.total.maxMs
      },
      proxyOverheadMs: {
        avg: safeAverage(perf.proxy.totalMs, perf.proxy.count),
        max: perf.proxy.maxMs
      }
    }

    const payloads = {
      requestBytes: {
        avg: safeAverage(perf.payloads.request.totalBytes, perf.payloads.request.count),
        max: perf.payloads.request.maxBytes
      },
      responseBytes: {
        avg: safeAverage(perf.payloads.response.totalBytes, perf.payloads.response.count),
        max: perf.payloads.response.maxBytes
      }
    }

    const allRouteSnapshots = Array.from(routeStats.values())
      .filter(route => route.count > 0)
      .map(buildRouteSnapshot)

    const slowestRoutes = allRouteSnapshots.slice().sort(sortRouteSnapshots).slice(0, 10)

    const routesByHandling = {
      processed: allRouteSnapshots
        .filter(route => route.handling === 'processed')
        .sort(sortRouteSnapshots)
        .slice(0, 10),
      redirected: allRouteSnapshots
        .filter(route => route.handling === 'redirected')
        .sort(sortRouteSnapshots)
        .slice(0, 10),
      blocked: allRouteSnapshots
        .filter(route => route.handling === 'blocked')
        .sort(sortRouteSnapshots)
        .slice(0, 10),
      served: allRouteSnapshots
        .filter(route => route.handling === 'served')
        .sort(sortRouteSnapshots)
        .slice(0, 10)
    }

    return {
      stats,
      editedRequests,
      performance,
      payloads,
      routes: {
        slowest: slowestRoutes,
        byHandling: routesByHandling
      }
    }
  }

  /**
   * Build a lightweight audit snapshot from the current in-memory log window.
   *
   * The snapshot focuses on upstream error distribution and per-host latency
   * aggregates, optimised for use by the secret Proxy Audit Panel.
   *
   * @param {LogStore} store
   * @returns {AuditSnapshot}
   */
  function buildAuditSnapshot(store) {
    /** @type {Record<string, number>} */
    const errorBuckets = Object.create(null)
    /** @type {Map<string, { host: string, count: number, totalDuration: number }>} */
    const hostMap = new Map()

    store.forEachNewestFirst(log => {
      if (!log) return
      if (typeof log.upstreamDurationMs === 'number' && log.upstreamDurationMs >= 0) {
        const hostInfo = extractHostInfoFromLog(log)
        const host = hostInfo && hostInfo.host ? hostInfo.host : null
        if (host) {
          let entry = hostMap.get(host)
          if (!entry) {
            entry = { host, count: 0, totalDuration: 0 }
          }
          entry.count += 1
          entry.totalDuration += log.upstreamDurationMs
          hostMap.set(host, entry)
        }
      }

      const category = log.upstreamErrorCategory || (log.source === 'error' ? 'unknown' : null)
      if (category) {
        const key = String(category)
        errorBuckets[key] = (errorBuckets[key] || 0) + 1
      }
    })

    const hostStats = Array.from(hostMap.values())
      .map(entry => ({
        host: entry.host,
        count: entry.count,
        avgDuration: entry.totalDuration / Math.max(1, entry.count)
      }))
      .sort((a, b) => b.avgDuration - a.avgDuration)
      .slice(0, 20)

    const totalErrors = Object.values(errorBuckets).reduce((acc, v) => acc + v, 0)

    return {
      errorBuckets,
      totalErrors,
      hostStats
    }
  }

  return {
    applyDashboardStatsDelta,
    recordStreamedResponseSize,
    onChange,
    reset,
    getDashboardStats: () => dashboardStats,
    getPerformanceStats: () => performanceStats,
    getRouteStats: () => routeStats,
    getDashboardSnapshot,
    buildAuditSnapshot
  }
}

module.exports = {
  DASHBOARD_PROXIED_SOURCES,
  createEmptyDashboardStats,
  createEmptyPerformanceStats,
  sanitizePathForSuggestions,
  extractHostInfoFromLog,
  classifyUpstreamError,
  computeLogEntryMetrics,
  buildRouteSnapshot,
  sortRouteSnapshots,
  createStats
}
