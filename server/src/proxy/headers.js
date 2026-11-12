'use strict'

/**
 * Header handling for forwarded requests and responses: the omit lists of
 * each flow, forwarding with overrides, sanitising upstream response headers,
 * stripping identifying/tracing headers and the cache-busting headers added
 * to every response the proxy produces.
 */

/**
 * A plain header map as found on Node requests and undici responses.
 *
 * @typedef {Record<string, string | string[] | number | undefined>} HeaderMap
 */

// The header a replayed request carries from the management API back into
// the proxy flow (the id of the entry it repeats and a token). It never
// travels upstream; the log entry factory turns it into `replayOf`.
const REPLAY_MARKER_HEADER = 'x-interactive-proxy-replay'

// Hop-by-hop headers never travel upstream: undici rejects `keep-alive`,
// `upgrade` and `http2-settings` outright, and `connection` is managed by
// the dispatcher.
const OMIT_HEADERS_BASE = [
  'proxy-connection',
  'connection',
  'keep-alive',
  'upgrade',
  'http2-settings',
  REPLAY_MARKER_HEADER
]
const OMIT_HEADERS_CONDITIONAL = [
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-unmodified-since'
]

// Composed header omission sets used across different upstream flows to keep
// behaviour consistent while avoiding inline array duplication.
const OMIT_HEADERS_PROXY = [
  'x-target-url',
  ...OMIT_HEADERS_BASE,
  'content-length',
  ...OMIT_HEADERS_CONDITIONAL
]
const OMIT_HEADERS_MITM = [...OMIT_HEADERS_BASE, ...OMIT_HEADERS_CONDITIONAL]

// Precomputed omit sets for hot-path header forwarding helpers to avoid
// repeatedly lower-casing and allocating Sets for the same static lists.
const OMIT_HEADERS_PROXY_SET = new Set(OMIT_HEADERS_PROXY.map(header => header.toLowerCase()))
const OMIT_HEADERS_MITM_SET = new Set(OMIT_HEADERS_MITM.map(header => header.toLowerCase()))
const OMIT_HEADERS_BASE_SET = new Set(OMIT_HEADERS_BASE.map(header => header.toLowerCase()))

// Common response header omissions used when forwarding upstream responses.
// This constant is shared across call sites so sanitizeHeaders can cheaply
// specialise caching for this very frequent omit set.
const OMIT_RESPONSE_HEADERS = ['transfer-encoding', 'connection', 'keep-alive']
const OMIT_RESPONSE_HEADERS_KEY = 'connection,keep-alive,transfer-encoding'
const OMIT_RESPONSE_HEADERS_SET = new Set(OMIT_RESPONSE_HEADERS_KEY.split(','))

/**
 * Cache for custom omit sets to avoid repeated allocations
 *
 * @type {Map<string, Set<string>>}
 */
const customOmitSetCache = new Map()

/**
 * Get or create a Set for the given omit array, using cached precomputed sets
 * for known constants and caching custom arrays by their joined key.
 *
 * @param {string[]|undefined} omit
 * @returns {Set<string>}
 */
function getOmitSet(omit) {
  if (omit === OMIT_HEADERS_PROXY) return OMIT_HEADERS_PROXY_SET
  if (omit === OMIT_HEADERS_MITM) return OMIT_HEADERS_MITM_SET
  if (omit === OMIT_HEADERS_BASE) return OMIT_HEADERS_BASE_SET
  if (!Array.isArray(omit) || omit.length === 0) return new Set()

  const key = omit
    .map(h => h.toLowerCase())
    .sort()
    .join(',')
  const cached = customOmitSetCache.get(key)
  if (cached) return cached

  const set = new Set(omit.map(h => h.toLowerCase()))
  customOmitSetCache.set(key, set)
  return set
}

/**
 * Copy the headers of an incoming request for forwarding, dropping the names
 * in `omit` (case-insensitive) and undefined values, then applying overrides.
 *
 * @param {HeaderMap} sourceHeaders
 * @param {string[]} [omit]
 * @param {HeaderMap} [overrides]
 * @returns {HeaderMap}
 */
function createForwardHeaders(sourceHeaders, omit = [], overrides = {}) {
  /** @type {HeaderMap} */
  const result = {}
  const omitSet = getOmitSet(omit)

  for (const headerName in sourceHeaders) {
    if (!Object.hasOwn(sourceHeaders, headerName)) continue
    const lower = headerName.toLowerCase()
    if (omitSet.has(lower)) continue
    const value = sourceHeaders[headerName]
    if (value !== undefined) {
      result[headerName] = value
    }
  }

  for (const overrideName in overrides) {
    if (!Object.hasOwn(overrides, overrideName)) continue
    result[overrideName] = overrides[overrideName]
  }

  return result
}

/**
 * Header names that are considered identifying for tracing/telemetry and
 * should be stripped from requests/responses that are actively processed
 * by the proxy (non-blocked, non-bypassed flows).
 *
 * This targets Sentry-style tracing headers and related baggage entries.
 *
 * @type {Set<string>}
 */
const IDENTIFYING_HEADER_EXACT_NAMES = new Set(['baggage', 'sentry-trace'])

/**
 * Header name prefixes that should be treated as identifying.
 *
 * @type {string[]}
 */
const IDENTIFYING_HEADER_PREFIXES = ['sentry-']

/**
 * Return a shallow copy of the given headers object with identifying/tracing
 * headers (such as Sentry tracing and baggage) removed.
 *
 * This is applied only on flows that are actively processed by the proxy –
 * proxied HTTP and MITM traffic – and not on plain bypass/direct flows.
 *
 * @param {HeaderMap} [headers]
 * @returns {HeaderMap}
 */
function stripIdentifyingHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object') return {}

  /** @type {HeaderMap} */
  const result = {}

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()

    const isExact = IDENTIFYING_HEADER_EXACT_NAMES.has(lower)
    const hasPrefix = IDENTIFYING_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix))

    if (isExact || hasPrefix) {
      continue
    }

    if (value === undefined) continue
    result[name] = value
  }

  return result
}

/**
 * Sanitised copies per headers object: the key count tells whether the
 * object changed since the cache was built, `byOmit` holds one copy per
 * omit configuration.
 *
 * @type {WeakMap<object, { count: number, byOmit: Map<string, HeaderMap> }>}
 */
const sanitizedHeadersCache = new WeakMap()

/**
 * Return a copy of the given headers object with a specific set of header
 * names omitted. Results are cached per (headers, omitKey) pair to avoid
 * repeatedly walking large header objects for the same omit configuration.
 *
 * The OMIT_RESPONSE_HEADERS constant is special-cased to avoid rebuilding
 * both the cache key and omission Set on every call.
 *
 * @param {HeaderMap} [headers]
 * @param {string[]} [omit]
 * @returns {HeaderMap}
 */
function sanitizeHeaders(headers = {}, omit = []) {
  if (!headers || typeof headers !== 'object') return {}

  let omitKey = ''
  /** @type {Set<string>} */
  let omitSet

  if (omit === OMIT_RESPONSE_HEADERS) {
    omitKey = OMIT_RESPONSE_HEADERS_KEY
    omitSet = OMIT_RESPONSE_HEADERS_SET
  } else if (Array.isArray(omit) && omit.length) {
    const normalized = omit.map(header => header.toLowerCase()).sort()
    omitKey = normalized.join(',')
    omitSet = new Set(normalized)
  } else {
    omitKey = ''
    omitSet = new Set()
  }

  // Cached per headers object and invalidated when keys were added or
  // removed since the cache was built.
  const keys = Object.keys(headers)
  let cacheForHeaders = sanitizedHeadersCache.get(headers)
  if (!cacheForHeaders || cacheForHeaders.count !== keys.length) {
    cacheForHeaders = { count: keys.length, byOmit: new Map() }
    sanitizedHeadersCache.set(headers, cacheForHeaders)
  }

  const cachedCopy = cacheForHeaders.byOmit.get(omitKey)
  if (cachedCopy) {
    return cachedCopy
  }

  /** @type {HeaderMap} */
  const sanitized = {}

  for (const key of keys) {
    const value = headers[key]
    if (omitSet.has(key.toLowerCase())) continue
    if (value === undefined) continue
    sanitized[key] = value
  }

  cacheForHeaders.byOmit.set(omitKey, sanitized)
  return sanitized
}

/**
 * Return a copy of the given headers object with both a specific omit set
 * applied and identifying/tracing headers stripped in a single pass.
 *
 * This is equivalent to calling `sanitizeHeaders(headers, omit)` followed by
 * `stripIdentifyingHeaders(...)` but avoids allocating two intermediate
 * objects and walking the header map twice on hot paths.
 *
 * Behaviour is intentionally identical to the existing combination:
 * - `omit` controls which generic protocol headers (e.g. connection,
 *   transfer-encoding) are removed.
 * - IDENTIFYING_HEADER_EXACT_NAMES / IDENTIFYING_HEADER_PREFIXES decide which
 *   tracing headers (e.g. Sentry baggage) are stripped.
 *
 * This helper is used only for actively processed proxy flows; bypass/direct
 * paths continue to rely on sanitizeHeaders alone to preserve existing
 * semantics.
 *
 * @param {HeaderMap} [headers]
 * @param {string[]} [omit]
 * @returns {HeaderMap}
 */
function sanitizeAndStripIdentifyingHeaders(headers = {}, omit = []) {
  if (!headers || typeof headers !== 'object') return {}

  /** @type {Set<string>|null} */
  let omitSet = null

  if (omit === OMIT_RESPONSE_HEADERS) {
    // Fast-path for the most common omit configuration used when forwarding
    // upstream responses.
    omitSet = OMIT_RESPONSE_HEADERS_SET
  } else if (Array.isArray(omit) && omit.length) {
    omitSet = new Set(omit.map(header => header.toLowerCase()))
  }

  /** @type {HeaderMap} */
  const result = {}

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue

    const lower = name.toLowerCase()

    if (omitSet && omitSet.has(lower)) continue

    const isExact = IDENTIFYING_HEADER_EXACT_NAMES.has(lower)
    const hasPrefix = IDENTIFYING_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix))

    if (isExact || hasPrefix) continue

    result[name] = value
  }

  return result
}

/**
 * Apply cache-busting headers to an HTTP response, optionally tagging the
 * source of the response (for example "remote" or "local").
 *
 * @param {import('http').ServerResponse} res
 * @param {string} [sourceTag]
 */
function applyCacheBypassHeadersToResponse(res, sourceTag) {
  if (!res || typeof res.setHeader !== 'function') return
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    if (sourceTag) {
      res.setHeader('X-Proxy-Source', sourceTag)
    }
  } catch {
    // Headers already sent: nothing can be added.
  }
}

/**
 * Attach cache-busting headers to a plain headers object used when forwarding
 * upstream responses (for example in HTTPS MITM flows).
 *
 * @param {HeaderMap} headers
 */
function applyCacheBypassHeadersToObject(headers) {
  if (!headers || typeof headers !== 'object') return
  headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate'
  headers.Pragma = 'no-cache'
  headers.Expires = '0'
}

/**
 * Make a `content-length` header truthful for a body that may have been
 * rewritten: when the headers declare a length, it is replaced by the length
 * of the buffer actually sent; headers without one (chunked upstream) are
 * left alone and Node chunks the response itself.
 *
 * @param {HeaderMap} headers
 * @param {Buffer} buffer
 */
function setContentLength(headers, buffer) {
  if (!headers || typeof headers !== 'object' || !Buffer.isBuffer(buffer)) return
  const keys = Object.keys(headers).filter(key => key.toLowerCase() === 'content-length')
  if (!keys.length) return
  for (const key of keys) delete headers[key]
  headers['content-length'] = String(buffer.length)
}

module.exports = {
  REPLAY_MARKER_HEADER,
  OMIT_HEADERS_BASE,
  OMIT_HEADERS_CONDITIONAL,
  OMIT_HEADERS_PROXY,
  OMIT_HEADERS_MITM,
  OMIT_RESPONSE_HEADERS,
  IDENTIFYING_HEADER_EXACT_NAMES,
  IDENTIFYING_HEADER_PREFIXES,
  getOmitSet,
  createForwardHeaders,
  stripIdentifyingHeaders,
  sanitizeHeaders,
  sanitizeAndStripIdentifyingHeaders,
  applyCacheBypassHeadersToResponse,
  applyCacheBypassHeadersToObject,
  setContentLength
}
