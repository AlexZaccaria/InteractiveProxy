'use strict'

/**
 * URL matching shared by edit rules (text and JSONPath), filter rules and the
 * routing layer: host/path normalisation, parsing of candidate target URLs and
 * the pattern semantics (absolute URL by host + path prefix, pure path by
 * prefix, anything else by case-insensitive substring).
 *
 * Nothing in here reads rule or log state; callers pass the URL context in.
 */

const { safeString } = require('../util/strings')

/**
 * One URL value of a request, pre-split for pattern matching.
 *
 * @typedef {object} UrlCandidate
 * @property {string} raw Lower-cased trimmed value as received.
 * @property {string|null} host Host name when the value is an absolute HTTP URL.
 * @property {string|null} path Path when the value is an absolute URL or starts with "/".
 */

/**
 * URL/phase context of a request, optionally carrying precomputed candidates.
 *
 * @typedef {object} UrlMatchContext
 * @property {string} [requestUrl] Request path (or absolute request line).
 * @property {string} [fullUrl] Fully qualified URL of the request.
 * @property {string} [phase] "request" or "response".
 * @property {UrlCandidate[]} [candidates] Candidates built by buildUrlMatchContext.
 */

/**
 * Result of parseUrlCandidate: an accepted target URL with its host parts.
 *
 * @typedef {object} ParsedUrlCandidate
 * @property {string} url Target URL (ws/wss carried as http/https).
 * @property {string|null} host Lower-cased host name without port.
 * @property {string} hostWithPort Lower-cased host with port when present.
 */

/**
 * Lower-case a host value and drop any port suffix. A bracketed IPv6
 * literal (`[::1]:8050`) keeps its brackets and its colons.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeHostValue(value) {
  if (!value || typeof value !== 'string') return null
  const lower = value.trim().toLowerCase()
  if (lower.startsWith('[')) {
    const close = lower.indexOf(']')
    return close === -1 ? lower : lower.slice(0, close + 1)
  }
  return lower.split(':')[0]
}

/**
 * Parse a candidate target URL (X-Target-URL header, absolute request line).
 * Only http(s) and ws(s) URLs are accepted; WebSocket targets are carried as
 * their HTTP equivalent and the upgrade path converts them back with
 * httpUrlToWebSocketUrl.
 *
 * @param {unknown} candidate
 * @returns {ParsedUrlCandidate|null}
 */
function parseUrlCandidate(candidate) {
  if (!candidate || typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    const protocol = safeString(parsed.protocol).toLowerCase()
    // WebSocket targets are carried as their HTTP equivalent; the upgrade
    // path converts them back with httpUrlToWebSocketUrl.
    let url = trimmed
    if (protocol === 'ws:' || protocol === 'wss:') {
      url = (protocol === 'wss:' ? 'https:' : 'http:') + trimmed.slice(protocol.length)
    } else if (protocol !== 'http:' && protocol !== 'https:') {
      return null
    }
    return {
      url,
      host: normalizeHostValue(parsed.hostname) || null,
      hostWithPort: parsed.host.toLowerCase()
    }
  } catch (error) {
    return null
  }
}

/**
 * LRU cache for parsed URL components to avoid repeated URL parsing on hot paths.
 * Key: lowercase URL string, Value: { host, path }
 *
 * @type {Map<string, { host: string|null, path: string }>}
 */
const urlParseCache = new Map()
const URL_PARSE_CACHE_MAX = 500

/**
 * Get cached URL parse result or parse and cache it.
 *
 * @param {unknown} url - URL string to parse
 * @returns {{ host: string|null, path: string }|null}
 */
function getCachedUrlParse(url) {
  if (!url || typeof url !== 'string') return null
  const key = url.toLowerCase()

  const cached = urlParseCache.get(key)
  if (cached) {
    return cached
  }

  try {
    const parsed = new URL(url)
    const result = {
      host: normalizeHostValue(parsed.hostname) || null,
      path: parsed.pathname || '/'
    }

    // Simple LRU: delete oldest entry when cache is full
    if (urlParseCache.size >= URL_PARSE_CACHE_MAX) {
      const firstKey = urlParseCache.keys().next().value
      if (firstKey !== undefined) {
        urlParseCache.delete(firstKey)
      }
    }

    urlParseCache.set(key, result)
    return result
  } catch {
    return null
  }
}

/**
 * Build a set of URL candidates (raw, host, path) from the current context,
 * normalising lower-case values and extracting host/path information when the
 * string looks like a full HTTP URL.
 *
 * This is used by both jsonPathRuleMatchesUrl and textRuleMatchesUrl to avoid
 * relying purely on naive substring checks.
 *
 * @param {UrlMatchContext} [context]
 * @returns {UrlCandidate[]}
 */
function buildUrlMatchCandidatesFromContext(context = {}) {
  /** @type {UrlCandidate[]} */
  const candidates = []

  /** @param {unknown} value */
  const pushCandidate = value => {
    if (typeof value !== 'string') return
    const trimmed = value.trim().toLowerCase()
    if (!trimmed) return

    // When the value looks like a full HTTP URL, use cached parsing
    if (/^https?:\/\//.test(trimmed)) {
      const cached = getCachedUrlParse(trimmed)
      if (cached) {
        candidates.push({
          raw: trimmed,
          host: cached.host,
          path: cached.path
        })
        return
      }
    }

    // For non-HTTP values (relative paths, opaque identifiers, etc), keep the
    // raw value and optionally treat leading "/..." strings as paths.
    const path = trimmed.startsWith('/') ? trimmed : null
    candidates.push({ raw: trimmed, host: null, path })
  }

  if (typeof context.requestUrl === 'string' && context.requestUrl) {
    pushCandidate(context.requestUrl)
  }
  if (typeof context.fullUrl === 'string' && context.fullUrl) {
    pushCandidate(context.fullUrl)
  }

  return candidates
}

/**
 * Build a reusable URL match context which includes both the original context
 * properties and a precomputed candidate list. This allows hot paths to share
 * URL parsing work across many rules.
 *
 * @param {UrlMatchContext} [context]
 * @returns {UrlMatchContext & { candidates: UrlCandidate[] }}
 */
function buildUrlMatchContext(context = {}) {
  const baseContext = context && typeof context === 'object' ? context : {}
  const candidates = buildUrlMatchCandidatesFromContext(baseContext)
  return { ...baseContext, candidates }
}

/**
 * Build a JSONPath-aware URL/phase context and precompute URL candidates via
 * buildUrlMatchContext so that downstream helpers can share consistent
 * matching semantics across HTTP, Connect and WebSocket flows.
 *
 * @param {UrlMatchContext} [context]
 * @returns {UrlMatchContext & { phase: string, candidates: UrlCandidate[] }}
 */
function buildJsonPathRuleContext(context = {}) {
  /** @type {UrlMatchContext} */
  const base = context && typeof context === 'object' ? { ...context } : {}
  base.phase = base.phase === 'response' ? 'response' : 'request'
  return { ...buildUrlMatchContext(base), phase: base.phase }
}

/**
 * Core URL pattern matcher shared by jsonPathRuleMatchesUrl and
 * textRuleMatchesUrl.
 *
 * Semantics:
 * - Absolute patterns ("http(s)://...") are matched by host equality and
 *   path equality/prefix against any candidate that has a host/path.
 * - Pure path patterns ("/foo/bar") are matched by path equality/prefix.
 * - Other patterns (e.g. "example.com", "login") fall back to a
 *   case-insensitive substring check against the raw candidate values to
 *   preserve backwards-compatible behaviour for non-URL-like inputs.
 *
 * @param {string} rawPattern Non-empty pattern string.
 * @param {UrlCandidate[]} candidates
 * @returns {boolean}
 */
function urlPatternMatchesCandidates(rawPattern, candidates) {
  const pattern = rawPattern.trim().toLowerCase()
  if (!pattern) return false

  if (!Array.isArray(candidates) || candidates.length === 0) return false

  const isAbsolutePattern = /^https?:\/\//.test(pattern)
  const isPathPattern = !isAbsolutePattern && pattern.startsWith('/')

  // Absolute URL pattern: match on host + path (exact or prefix).
  if (isAbsolutePattern) {
    /** @type {URL|null} */
    let parsed
    try {
      parsed = new URL(pattern)
    } catch (error) {
      // If parsing fails, fall back to raw substring matching below.
      parsed = null
    }

    if (parsed) {
      const patternHost = normalizeHostValue(parsed.hostname)
      const patternPath = parsed.pathname || '/'
      const normalizedPrefix = patternPath.endsWith('/') ? patternPath : `${patternPath}/`

      return candidates.some(candidate => {
        if (!candidate) return false

        // A pattern with a host is satisfied only by candidates that carry
        // the same host; the relative requestUrl candidate (no host) cannot
        // match it on its own.
        if (patternHost && candidate.host !== patternHost) {
          return false
        }

        const candidatePath = candidate.path || '/'
        if (candidatePath === patternPath) return true
        return candidatePath.startsWith(normalizedPrefix)
      })
    }
  }

  // Pure path pattern: match by path equality/prefix only.
  if (isPathPattern) {
    const patternPath = pattern
    const normalizedPrefix = patternPath.endsWith('/') ? patternPath : `${patternPath}/`

    return candidates.some(candidate => {
      if (!candidate) return false
      const candidatePath = candidate.path || '/'
      if (candidatePath === patternPath) return true
      return candidatePath.startsWith(normalizedPrefix)
    })
  }

  // Fallback: legacy substring semantics for non-URL-like patterns
  // (e.g. plain hostnames, generic identifiers).
  return candidates.some(candidate => candidate && candidate.raw.includes(pattern))
}

/**
 * Core URL pattern matcher shared by jsonPathRuleMatchesUrl and
 * textRuleMatchesUrl when only a raw URL/phase context is available.
 *
 * @param {string} rawPattern Non-empty pattern string.
 * @param {UrlMatchContext} [context]
 * @returns {boolean}
 */
function urlPatternMatchesContext(rawPattern, context = {}) {
  const baseContext = context && typeof context === 'object' ? context : {}
  const candidates = buildUrlMatchCandidatesFromContext(baseContext)
  return urlPatternMatchesCandidates(rawPattern, candidates)
}

/**
 * Determine whether a JSONPath rule applies to the given URL context. Unlike
 * text rules, a JSONPath rule without a URL pattern never matches.
 *
 * @param {{ url?: unknown }} rule
 * @param {UrlMatchContext} [contextOrMatch]
 * @returns {boolean}
 */
function jsonPathRuleMatchesUrl(rule, contextOrMatch = {}) {
  const rawPattern = safeString(rule.url)
  const trimmed = rawPattern.trim()
  if (!trimmed) return false

  if (contextOrMatch && Array.isArray(contextOrMatch.candidates)) {
    return urlPatternMatchesCandidates(trimmed, contextOrMatch.candidates)
  }

  return urlPatternMatchesContext(trimmed, contextOrMatch || {})
}

/**
 * Determine whether a text edit rule should run for the given URL context.
 *
 * Text rules treat an empty URL pattern as "no constraint" (match all URLs),
 * while non-empty patterns behave like JSONPath rules and are matched using a
 * bidirectional contains check against requestUrl/fullUrl.
 *
 * @param {{ url?: unknown }|null|undefined} rule
 * @param {UrlMatchContext} [contextOrMatch]
 * @returns {boolean}
 */
function textRuleMatchesUrl(rule, contextOrMatch = {}) {
  if (!rule || typeof rule !== 'object') return true

  const rawPattern = safeString(rule.url)
  const trimmed = rawPattern.trim()

  // When no URL pattern is provided, treat the rule as global.
  if (!trimmed) return true

  if (contextOrMatch && Array.isArray(contextOrMatch.candidates)) {
    return urlPatternMatchesCandidates(trimmed, contextOrMatch.candidates)
  }

  return urlPatternMatchesContext(trimmed, contextOrMatch || {})
}

/**
 * Derive a human-friendly display name from a URL or host pattern.
 *
 * Examples:
 *   "https://api.facebook.com/v1" -> "Facebook.com"
 *   "api.example.co.uk/path"      -> "Co.uk" (last two labels)
 *   "localhost:3000/foo"          -> "Localhost"
 *
 * Used for both filter (bypass) rules and blocked rules so that the
 * frontend does not need to duplicate this normalisation logic.
 *
 * @param {unknown} pattern
 * @returns {string}
 */
function deriveDisplayNameFromUrlPattern(pattern) {
  if (!pattern || typeof pattern !== 'string') return ''

  try {
    // Strip protocol if present
    let domain = pattern.replace(/^https?:\/\//i, '')
    // Drop path
    domain = domain.split('/')[0]
    // Drop port
    domain = domain.split(':')[0]

    const parts = domain.split('.').filter(Boolean)
    if (parts.length >= 2) {
      const mainDomain = parts.slice(-2).join('.')
      return mainDomain.charAt(0).toUpperCase() + mainDomain.slice(1)
    }

    if (!domain) return ''
    return domain.charAt(0).toUpperCase() + domain.slice(1)
  } catch {
    return ''
  }
}

/**
 * Check whether a host string matches a bypass host pattern.
 *
 * @param {string} patternValue
 * @param {string} host
 * @returns {boolean}
 */
function hostPatternMatches(patternValue, host) {
  if (!patternValue || !host) return false
  if (patternValue.startsWith('.')) {
    const suffix = patternValue.slice(1)
    return host === suffix || host.endsWith(`.${suffix}`)
  }

  if (host === patternValue) return true
  if (host.endsWith(`.${patternValue}`)) return true

  return false
}

module.exports = {
  normalizeHostValue,
  parseUrlCandidate,
  getCachedUrlParse,
  buildUrlMatchCandidatesFromContext,
  buildUrlMatchContext,
  buildJsonPathRuleContext,
  urlPatternMatchesCandidates,
  urlPatternMatchesContext,
  jsonPathRuleMatchesUrl,
  textRuleMatchesUrl,
  deriveDisplayNameFromUrlPattern,
  hostPatternMatches
}
