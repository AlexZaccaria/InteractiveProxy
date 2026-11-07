'use strict'

/**
 * Routing decisions of the proxy: blocked URL rules, filter (bypass) rules
 * with their ignore/focus mode, target resolution from a request, and the
 * block / direct / proxy decision shared by the HTTP, HTTPS MITM, CONNECT and
 * WebSocket flows. The rule lists are owned by the router instance and
 * persisted under the storage directory.
 *
 * @module proxy/router
 */

const fs = require('fs')
const { URL } = require('url')
const fsPromises = fs.promises
const { safeTrim, safeString } = require('../util/strings')
const {
  normalizeHostValue,
  parseUrlCandidate,
  deriveDisplayNameFromUrlPattern,
  hostPatternMatches
} = require('../rules/url-match')

/** @typedef {import('../state/config-store').ConfigStore} ConfigStore */
/** @typedef {import('../state/config-store').FilterMode} FilterMode */
/** @typedef {import('../rules/url-match').ParsedUrlCandidate} ParsedUrlCandidate */

/**
 * A request as seen by the routing helpers: a Node request, possibly
 * decorated by Express (`originalUrl`, `protocol`).
 *
 * @typedef {import('http').IncomingMessage & { originalUrl?: string, protocol?: string }} RoutableRequest
 */

/**
 * @typedef {object} BlockedRule
 * @property {string} id
 * @property {boolean} enabled
 * @property {string} name
 * @property {string} url Substring matched against the request URL and the full URL.
 */

/**
 * @typedef {BlockedRule & { mode: FilterMode }} BypassRule
 */

/**
 * @typedef {object} BypassMatcher
 * @property {string} raw The rule pattern as written.
 * @property {string} value Lower-cased pattern.
 * @property {'host' | 'path'} type Host patterns match the host candidates, path patterns the URL candidates.
 */

/**
 * Canonical routing context used for block/bypass decisions.
 *
 * @typedef {object} RoutingContext
 * @property {string} requestUrl
 * @property {string | null} fullUrl
 * @property {string | null} host
 * @property {string | null} path
 * @property {string | null} targetUrl
 * @property {string | undefined} method
 */

/**
 * Loose input accepted by the decision helpers.
 *
 * @typedef {object} RoutingInput
 * @property {string} [requestUrl]
 * @property {string | null} [fullUrl]
 * @property {string | null} [host]
 * @property {string | null} [path]
 * @property {string | null} [targetUrl]
 * @property {string} [method]
 */

/**
 * Target resolved from a request: a parsed absolute URL, or only the host
 * when the request is addressed to the proxy itself (or carries no target).
 *
 * @typedef {ParsedUrlCandidate | { url: null, host: string | null }} ResolvedTarget
 */

/**
 * Build the `host:port` values under which the proxy itself is addressed. A
 * request whose Host header is not one of these is traffic for another
 * server.
 *
 * @param {{ port: number, host: string, uiOrigins: string[] }} params
 * @returns {Set<string>}
 */
function buildOwnAuthorities ({ port, host, uiOrigins }) {
  /** @type {(string | null)[]} */
  const hosts = ['localhost', '127.0.0.1', '[::1]', host]
  for (const origin of uiOrigins) {
    try {
      hosts.push(new URL(origin).hostname)
    } catch {
      hosts.push(null)
    }
  }

  /** @type {Set<string>} */
  const authorities = new Set()
  for (const candidate of hosts) {
    if (!candidate || candidate === '0.0.0.0' || candidate === '::') continue
    authorities.add(`${candidate.toLowerCase()}:${port}`)
  }
  return authorities
}

/**
 * Determine the assumed protocol (http or https) from a request object.
 * Checks x-forwarded-proto header first, then falls back to socket encryption.
 *
 * @param {RoutableRequest} req
 * @returns {string}
 */
function getAssumedProtocol (req) {
  const forwarded = req.headers['x-forwarded-proto']
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const socket = /** @type {{ encrypted?: boolean } | undefined} */ (req.socket)
  return (
    forwardedValue?.split(',')[0]?.trim() ||
    req.protocol ||
    (socket?.encrypted ? 'https' : 'http')
  )
}

/**
 * Base normalisation logic shared by bypass and blocked rules.
 * Extracts URL, derives name, generates ID with prefix, sets enabled flag.
 *
 * @param {Record<string, any> | null | undefined} rule - Raw rule object.
 * @param {string} idPrefix - Prefix for generated IDs (e.g. 'bypass', 'blocked').
 * @param {Record<string, any>} [extraDefaults] - Additional default properties to merge.
 * @returns {BlockedRule & Record<string, any>} Normalised rule object.
 */
function normalizeRuleBase (rule, idPrefix, extraDefaults = {}) {
  const source = rule && typeof rule === 'object' ? rule : {}
  const url = safeString(source.url)
  const name = (typeof source.name === 'string' && source.name.trim())
    ? source.name.trim()
    : deriveDisplayNameFromUrlPattern(url)

  const id = (typeof source.id === 'string' && source.id.trim())
    ? source.id
    : `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  return { id, enabled: source.enabled !== false, name, url, ...extraDefaults }
}

/**
 * Normalise a raw bypass rule into the canonical internal representation.
 *
 * @param {Record<string, any> | null | undefined} [rule]
 * @returns {BypassRule}
 */
function normalizeBypassRule (rule = {}) {
  const mode = rule && rule.mode === 'focus' ? 'focus' : 'ignore'
  return /** @type {BypassRule} */ (normalizeRuleBase(rule, 'bypass', { mode }))
}

/**
 * Normalise a raw blocked-rule entry into a canonical representation.
 *
 * @param {Record<string, any> | null | undefined} [rule]
 * @returns {BlockedRule}
 */
function normalizeBlockedRule (rule = {}) {
  return normalizeRuleBase(rule, 'blocked')
}

/**
 * Build a canonical routing context used for block/bypass decisions across
 * HTTP, HTTPS MITM, CONNECT and WebSocket flows.
 *
 * @param {RoutingInput} [params]
 * @returns {RoutingContext}
 */
function buildRoutingContext ({ requestUrl, fullUrl, host, path, targetUrl, method } = {}) {
  return {
    requestUrl: typeof requestUrl === 'string' ? requestUrl : '/',
    fullUrl: typeof fullUrl === 'string' ? fullUrl : null,
    host: typeof host === 'string' ? host : (host ? String(host) : null),
    path: typeof path === 'string' ? path : null,
    targetUrl: typeof targetUrl === 'string' ? targetUrl : null,
    method
  }
}

/**
 * Build the bypass matching context (host/value candidates) used by
 * shouldBypassRequest from a routing context-like shape.
 *
 * @param {RoutingInput} [params]
 * @returns {{hostCandidates: string[], valueCandidates: string[]}}
 */
function createBypassContext ({ requestUrl, fullUrl, host, path, targetUrl } = {}) {
  /** @type {string[]} */
  const hostCandidates = []
  /** @type {string[]} */
  const valueCandidates = []

  /** @param {unknown} candidate */
  const pushHostCandidate = candidate => {
    const normalized = normalizeHostValue(candidate)
    if (normalized) hostCandidates.push(normalized)
  }

  /** @param {string | null | undefined} candidate */
  const pushValueCandidate = candidate => {
    if (!candidate) return
    valueCandidates.push(candidate.toString().toLowerCase())
  }

  pushHostCandidate(host)
  pushValueCandidate(requestUrl)

  /** @param {string | null | undefined} url */
  const addUrlCandidates = url => {
    if (!url || typeof url !== 'string') return
    pushValueCandidate(url)
    try {
      const parsed = new URL(url)
      pushHostCandidate(parsed.hostname)
      pushValueCandidate(parsed.pathname || '/')
    } catch (error) {
      // ignore invalid URL
    }
  }

  addUrlCandidates(targetUrl)
  addUrlCandidates(fullUrl)
  pushValueCandidate(path)

  return {
    hostCandidates,
    valueCandidates
  }
}

/**
 * @typedef {object} RouterOptions
 * @property {ConfigStore} configStore Global flags (filter rules, blocked rules, filter mode).
 * @property {{ blockedFile: string, filterFile: string, legacyBypassFile: string }} files Rule files under the storage directory.
 * @property {number} port Port the proxy listens on.
 * @property {string} host Interface the proxy listens on.
 * @property {string[]} uiOrigins Browser origins allowed to call the management API.
 * @property {() => void} [onBlockedPatternsChanged] Called after the blocked patterns used by the log view changed.
 */

/**
 * Create the router: owner of the blocked and filter rules plus the routing
 * decisions. Rules are read from disk by `loadBlockedUrls()` / `loadBypassUrls()`.
 *
 * @param {RouterOptions} options
 */
function createRouter ({ configStore, files, port, host, uiOrigins, onBlockedPatternsChanged }) {
  const { blockedFile, filterFile, legacyBypassFile } = files
  const ownAuthorities = buildOwnAuthorities({ port, host, uiOrigins })

  /** @typedef {{ kind: 'blocked' | 'filter' }} RouterChange */
  /** @type {Set<(change: RouterChange) => void>} */
  const changeListeners = new Set()

  /**
   * Subscribe to rule changes (notified when a rule list is saved).
   *
   * @param {(change: RouterChange) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  function onChange (listener) {
    changeListeners.add(listener)
    return () => { changeListeners.delete(listener) }
  }

  /** @param {RouterChange['kind']} kind */
  function notifyChange (kind) {
    for (const listener of changeListeners) {
      try {
        listener({ kind })
      } catch (error) {
        console.error('[proxy] Router change listener failed:', error)
      }
    }
  }

  // Blocked/BYPASS URL lists
  /** @type {string[]} */
  let blockedUrls = [] // Array of URL strings (enabled only)
  /** @type {string[]} */
  let bypassUrls = [] // Array of URL strings (enabled only, current mode)
  /** @type {BlockedRule[]} */
  let blockedRules = [] // Full rule objects with id, enabled, name, url
  /** @type {BypassRule[]} */
  let bypassRules = [] // Full rule objects with id, enabled, name, url, mode
  /** @type {BypassMatcher[]} */
  let bypassMatchers = []
  // Precomputed blocked URL patterns used by filterLogsCore to cheaply hide
  // blocked traffic from the log view without rebuilding the pattern list on
  // every /api/logs request.
  /** @type {string[]} */
  let blockedUrlSubstringsForFilter = []

  /** @returns {FilterMode} */
  function getBypassMode () {
    return configStore.filterMode === 'focus' ? 'focus' : 'ignore'
  }

  function isIgnoreMode () {
    return getBypassMode() === 'ignore'
  }

  function isFocusMode () {
    return getBypassMode() === 'focus'
  }

  function buildBypassMatchers () {
    bypassMatchers = bypassUrls
      .map(pattern => safeTrim(pattern))
      .filter(pattern => pattern)
      .map(pattern => {
        const lower = pattern.toLowerCase()
        const isHostPattern = lower.startsWith('.') || (lower.includes('.') && !lower.includes('/') && !lower.includes(':'))

        return {
          raw: pattern,
          value: lower,
          type: /** @type {'host' | 'path'} */ (isHostPattern ? 'host' : 'path')
        }
      })
  }

  /**
   * Rebuild the list of bypass URLs and matchers for the current mode from the
   * already-normalised bypassRules array.
   */
  function rebuildBypassUrlsForCurrentMode () {
    const mode = getBypassMode()
    bypassUrls = bypassRules
      .filter(rule => rule && rule.enabled && rule.mode === mode)
      .map(rule => rule.url)
    buildBypassMatchers()
  }

  /**
   * Recompute the list of blocked URL substrings used exclusively by the log
   * filtering layer. Unlike `blockedUrls`, this includes all blocked rules
   * (enabled and disabled) to preserve the legacy behaviour where any blocked
   * pattern hides matching entries from the log view.
   */
  function recomputeBlockedUrlSubstringsForFilter () {
    blockedUrlSubstringsForFilter = Array.isArray(blockedRules)
      ? blockedRules
          .map(rule => safeString(rule?.url))
          .filter(Boolean)
      : []

    // Keep per-log visibility flags in sync with the latest blocked patterns so
    // that filterLogsCore can rely on a cheap boolean check instead of
    // re-scanning patterns for every log entry on each API call.
    if (onBlockedPatternsChanged) {
      onBlockedPatternsChanged()
    }
  }

  // Load blocked URLs from file
  function loadBlockedUrls () {
    try {
      if (fs.existsSync(blockedFile)) {
        const data = fs.readFileSync(blockedFile, 'utf8')
        const parsed = JSON.parse(data)
        blockedRules = Array.isArray(parsed) ? parsed.map(normalizeBlockedRule) : []
        // Filter only enabled rules and extract URLs
        blockedUrls = blockedRules.filter(rule => rule.enabled).map(rule => rule.url)
      }
      // Keep the log filtering patterns in sync with the latest blocked rules.
      recomputeBlockedUrlSubstringsForFilter()
    } catch (error) {
      console.error('[proxy] Error loading blocked URLs:', error)
    }
  }

  function loadBypassUrls () {
    try {
      let fileToRead = null

      if (fs.existsSync(filterFile)) {
        fileToRead = filterFile
      } else if (fs.existsSync(legacyBypassFile)) {
        fileToRead = legacyBypassFile
      }

      if (fileToRead) {
        const data = fs.readFileSync(fileToRead, 'utf8')
        const parsed = JSON.parse(data)
        if (Array.isArray(parsed)) {
          bypassRules = parsed.map(normalizeBypassRule)
        } else {
          bypassRules = []
        }
        rebuildBypassUrlsForCurrentMode()

        if (fileToRead === legacyBypassFile) {
          saveBypassUrlsSync()
        }
      }
    } catch (error) {
      console.error('[proxy] Error loading bypass URLs:', error)
    }
  }

  // Save blocked URLs to file
  async function saveBlockedUrls () {
    // Activate the rules in memory before the (asynchronous) write so that a
    // request arriving right after the API call already sees them.
    blockedUrls = blockedRules.filter(rule => rule.enabled).map(rule => rule.url)
    // Keep the log filtering patterns in sync with the latest blocked rules.
    recomputeBlockedUrlSubstringsForFilter()
    notifyChange('blocked')

    try {
      const payload = JSON.stringify(blockedRules, null, 2)
      await fsPromises.writeFile(blockedFile, payload)
    } catch (error) {
      console.error('[proxy] Error saving blocked URLs:', error)
    }
  }

  /**
   * Build a JSON snapshot of the current bypass rules.
   *
   * Note: bypassRules are stored in normalised form. They are normalised on
   * load (loadBypassUrls) and when mutated via the /api/filters endpoint.
   */
  function buildBypassRulesSnapshot () {
    const payload = JSON.stringify(bypassRules, null, 2)
    rebuildBypassUrlsForCurrentMode()
    return payload
  }

  function saveBypassUrlsSync () {
    try {
      const payload = buildBypassRulesSnapshot()
      notifyChange('filter')
      fs.writeFileSync(filterFile, payload)
    } catch (error) {
      console.error('[proxy] Error saving bypass URLs (sync):', error)
    }
  }

  async function saveBypassUrls () {
    try {
      const payload = buildBypassRulesSnapshot()
      notifyChange('filter')
      await fsPromises.writeFile(filterFile, payload)
    } catch (error) {
      console.error('[proxy] Error saving bypass URLs:', error)
    }
  }

  /**
   * @param {unknown} requestUrl
   * @param {unknown} fullUrl
   * @returns {boolean}
   */
  function isRequestBlocked (requestUrl, fullUrl) {
    if (!configStore.blockedRulesEnabled) return false
    if (!Array.isArray(blockedUrls) || blockedUrls.length === 0) return false

    const req = safeString(requestUrl)
    const full = safeString(fullUrl)

    return blockedUrls.some(blockedUrl => {
      if (!blockedUrl || typeof blockedUrl !== 'string') return false
      return (req && req.includes(blockedUrl)) || (full && full.includes(blockedUrl))
    })
  }

  /**
   * Determine whether a request should be treated as an internal proxy/UI call
   * that must never be bypassed.
   *
   * @param {RoutingInput | null | undefined} [rawInput]
   * @returns {boolean}
   */
  function isInternalProxyRequest (rawInput = {}) {
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {}
    const hostValue = normalizeHostValue(input.host) || ''
    if (
      !hostValue &&
      typeof input.requestUrl !== 'string' &&
      typeof input.fullUrl !== 'string' &&
      typeof input.targetUrl !== 'string'
    ) {
      return false
    }

    const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]'])
    if (hostValue && localHostnames.has(hostValue)) {
      return true
    }

    const portSuffixes = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]
    const urlCandidates = [input.fullUrl, input.targetUrl, input.requestUrl]

    for (const value of urlCandidates) {
      if (typeof value !== 'string' || !value) continue
      const lower = value.toLowerCase()
      if (portSuffixes.some(suffix => lower.includes(suffix))) {
        return true
      }
    }

    return false
  }

  /**
   * @param {RoutingInput | null | undefined} input
   * @returns {boolean}
   */
  function shouldBypassRequest (input) {
    if (!configStore.filterRulesEnabled) return false
    if (!bypassMatchers.length) return false

    const context = createBypassContext(input || undefined)
    if (!context.hostCandidates.length && !context.valueCandidates.length) return false

    for (const matcher of bypassMatchers) {
      if (matcher.type === 'host') {
        for (const hostCandidate of context.hostCandidates) {
          if (hostPatternMatches(matcher.value, hostCandidate)) {
            return true
          }
        }
      } else {
        for (const valueCandidate of context.valueCandidates) {
          if (valueCandidate.includes(matcher.value)) {
            return true
          }
        }
      }
    }

    return false
  }

  /**
   * Decide whether a request should use a direct upstream connection instead of
   * going through the proxy/MITM logic, based on bypass mode and rules.
   *
   * @param {RoutingInput | null | undefined} input
   * @returns {boolean}
   */
  function shouldUseDirectConnection (input) {
    // Never bypass internal proxy requests (API calls, UI, etc.)
    if (isInternalProxyRequest(input)) {
      return false
    }

    if (!configStore.filterRulesEnabled) {
      return false
    }

    const matches = shouldBypassRequest(input)

    if (isIgnoreMode()) {
      // Ignore mode: behave like legacy bypass list
      return matches
    }

    if (isFocusMode()) {
      // Focus mode: only focused (matched) traffic uses proxy logic; others go direct
      return !matches
    }

    // Fallback to legacy behavior
    return matches
  }

  /**
   * Decide how to handle a generic HTTP request based on block and
   * bypass/focus rules.
   *
   * @param {RoutingInput | null | undefined} rawContext
   * @returns {'block'|'direct'|'proxy'}
   */
  function decideHttpHandling (rawContext) {
    const context = rawContext && typeof rawContext === 'object' ? rawContext : {}
    const requestUrl = context.requestUrl || '/'
    const fullUrl = context.fullUrl || null

    // Blocked URLs take precedence over bypass/focus logic
    if (isRequestBlocked(requestUrl, fullUrl)) {
      return 'block'
    }

    return shouldUseDirectConnection(context) ? 'direct' : 'proxy'
  }

  /**
   * Decide how to handle a WebSocket connection based on block and bypass
   * rules, mapping the generic HTTP decision into WebSocket-specific actions.
   *
   * @param {RoutingInput | null | undefined} routingContext
   * @returns {{action: 'block'|'direct'|'mitm', requestUrl: string, fullUrl: (string|null)}}
   */
  function decideWebSocketHandling (routingContext) {
    const requestUrl = routingContext?.requestUrl || '/'
    const fullUrl = routingContext?.fullUrl || null
    const httpDecision = decideHttpHandling(routingContext)

    if (httpDecision === 'block') {
      return { action: 'block', requestUrl, fullUrl }
    }

    if (httpDecision === 'direct') {
      return { action: 'direct', requestUrl, fullUrl }
    }

    return { action: 'mitm', requestUrl, fullUrl }
  }

  /**
   * Resolve the upstream target of a request: the X-Target-URL header, an
   * absolute request URL (proxy-style), or the Host header when it is not
   * the proxy itself.
   *
   * @param {RoutableRequest} req
   * @returns {ResolvedTarget}
   */
  function resolveTargetFromRequest (req) {
    const targetHeaderValue = req.headers['x-target-url']
    const targetHeader = parseUrlCandidate(targetHeaderValue)
    if (targetHeader) {
      return targetHeader
    }

    const rawUrl = safeString(req.originalUrl) || safeString(req.url)
    const requestUrl = rawUrl || ''

    if (/^(https?|wss?):\/\//i.test(requestUrl)) {
      const parsedRequestUrl = parseUrlCandidate(requestUrl)
      if (parsedRequestUrl) {
        return parsedRequestUrl
      }
    }

    const hostHeader = safeTrim(req.headers.host)
    const normalizedHeaderHost = normalizeHostValue(hostHeader)

    if (hostHeader && !ownAuthorities.has(hostHeader.toLowerCase())) {
      const assumedProtocol = getAssumedProtocol(req)
      const candidate = `${assumedProtocol}://${hostHeader}${requestUrl}`
      const parsedCandidate = parseUrlCandidate(candidate)
      if (parsedCandidate) {
        return parsedCandidate
      }

      return {
        url: null,
        host: normalizedHeaderHost
      }
    }

    return {
      url: null,
      host: normalizedHeaderHost
    }
  }

  /**
   * Build the routing context of a plain HTTP request from the resolved
   * target and the request itself.
   *
   * @param {RoutableRequest} req
   * @param {ResolvedTarget | null | undefined} resolvedTarget
   * @returns {RoutingContext}
   */
  function buildBypassInputFromHttpRequest (req, resolvedTarget) {
    const requestUrl = safeString(req.url) || '/'
    const hostHeader = safeString(req.headers?.host)
    const hostValue = resolvedTarget?.host || normalizeHostValue(hostHeader)

    const assumedProtocol = getAssumedProtocol(req)

    let fullUrl = resolvedTarget?.url || null
    if (!fullUrl) {
      if (/^(https?|wss?):\/\//i.test(requestUrl)) {
        fullUrl = requestUrl
      } else if (hostHeader) {
        const prefixedPath = requestUrl.startsWith('/') ? requestUrl : `/${requestUrl}`
        fullUrl = `${assumedProtocol}://${hostHeader}${prefixedPath}`
      }
    }

    let path = null
    if (fullUrl) {
      try {
        path = new URL(fullUrl).pathname || requestUrl
      } catch {
        path = requestUrl
      }
    } else {
      path = requestUrl
    }

    return buildRoutingContext({
      requestUrl,
      fullUrl,
      host: hostValue,
      path,
      targetUrl: resolvedTarget?.url,
      method: req.method
    })
  }

  /**
   * True when a request that reached the Express app is traffic to forward
   * (proxy-style absolute URL, X-Target-URL header or a Host header that is not
   * the proxy itself) rather than a call to the management API.
   *
   * @param {RoutableRequest} req
   * @returns {boolean}
   */
  function isProxyTargetedRequest (req) {
    if (safeString(req.headers['x-target-url'])) return true

    const rawUrl = safeString(req.originalUrl) || safeString(req.url)
    if (/^(https?|wss?):\/\//i.test(rawUrl)) return true

    const hostHeader = safeTrim(req.headers.host).toLowerCase()
    return Boolean(hostHeader) && !ownAuthorities.has(hostHeader)
  }

  return {
    ownAuthorities,
    // rule lists
    loadBlockedUrls,
    saveBlockedUrls,
    loadBypassUrls,
    saveBypassUrls,
    saveBypassUrlsSync,
    buildBypassRulesSnapshot,
    rebuildBypassUrlsForCurrentMode,
    buildBypassMatchers,
    recomputeBlockedUrlSubstringsForFilter,
    /** @returns {BlockedRule[]} The live array (callers may push into it). */
    getBlockedRules: () => blockedRules,
    /** @param {BlockedRule[]} next */
    setBlockedRules: next => { blockedRules = next },
    getBlockedUrls: () => blockedUrls,
    getBlockedPatterns: () => blockedUrlSubstringsForFilter,
    /** @returns {BypassRule[]} The live array (callers may push into it). */
    getBypassRules: () => bypassRules,
    /** @param {BypassRule[]} next */
    setBypassRules: next => { bypassRules = next },
    getBypassUrls: () => bypassUrls,
    getBypassMatchers: () => bypassMatchers,
    normalizeRuleBase,
    normalizeBlockedRule,
    normalizeBypassRule,
    // decisions
    isRequestBlocked,
    getBypassMode,
    isIgnoreMode,
    isFocusMode,
    isInternalProxyRequest,
    shouldUseDirectConnection,
    shouldBypassRequest,
    buildRoutingContext,
    createBypassContext,
    buildBypassInputFromHttpRequest,
    decideHttpHandling,
    decideWebSocketHandling,
    resolveTargetFromRequest,
    isProxyTargetedRequest,
    getAssumedProtocol,
    onChange
  }
}

/** @typedef {ReturnType<typeof createRouter>} Router */

module.exports = {
  buildOwnAuthorities,
  getAssumedProtocol,
  normalizeRuleBase,
  normalizeBypassRule,
  normalizeBlockedRule,
  buildRoutingContext,
  createBypassContext,
  createRouter
}
