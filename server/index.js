const http = require('http')
const https = require('https')
const net = require('net')
const tls = require('tls')
const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const fsPromises = fs.promises
const crypto = require('crypto')
const { URL } = require('url')
const WebSocket = require('ws')
const zlib = require('zlib')
const { decompress: zstdDecompress } = require('fzstd')
const forge = require('node-forge')
const { request, Agent } = require('undici')
const {
  PORT,
  STORAGE_DIR,
  LOGS_DIR,
  CERTS_DIR,
  MAX_LOG_ENTRIES,
  LOG_PREVIEW_MAX_BYTES,
  LOG_DECOMPRESS_MAX_BYTES,
  MITM_BYPASS_REWRITES_ENABLED,
  DEBUG_LOG_ENABLED,
  STRICT_TLS_ENABLED,
  STRICT_TLS_CA_FILE,
  BODY_LIMIT,
  PROTOBUF_MAX_FIELDS,
  PROTOBUF_MAX_BYTES,
  CONNECT_MAX_FRAMES,
  CONNECT_MAX_FRAME_BYTES,
  WS_MAX_TEXT_BYTES,
  UPSTREAM_HEADERS_TIMEOUT_MS,
  UPSTREAM_BODY_TIMEOUT_MS,
  STREAM_UNINSPECTED_RESPONSES,
  WS_LOG_BODY_ENABLED
} = require('./config')

// Normalised protobuf/Connect limits computed once at startup to avoid
// repeated ternaries and allocations on hot paths.
const PROTOBUF_MAX_FIELDS_LIMIT = PROTOBUF_MAX_FIELDS > 0
  ? PROTOBUF_MAX_FIELDS
  : Number.POSITIVE_INFINITY

const PROTOBUF_MAX_BYTES_LIMIT = PROTOBUF_MAX_BYTES > 0
  ? PROTOBUF_MAX_BYTES
  : Number.POSITIVE_INFINITY

const CONNECT_MAX_FRAMES_LIMIT = CONNECT_MAX_FRAMES > 0
  ? CONNECT_MAX_FRAMES
  : Number.POSITIVE_INFINITY

const CONNECT_MAX_FRAME_BYTES_LIMIT = CONNECT_MAX_FRAME_BYTES > 0
  ? CONNECT_MAX_FRAME_BYTES
  : Number.POSITIVE_INFINITY

// Constant GUID used for WebSocket Sec-WebSocket-Accept computation
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

let zstdCodec = null

;(async () => {
  try {
    const mod = await import('@foxglove/wasm-zstd')
    const zstd = mod.default || mod
    await zstd.isLoaded
    zstdCodec = zstd
    console.log('[proxy] zstd codec loaded')
  } catch (error) {
    console.warn('[proxy] zstd codec not available, zstd rewrites disabled:', error?.message || error)
  }
})();

/**
 * Structured logging helpers used for internal diagnostics.
 *
 * - logDebug: gated by DEBUG_LOG_ENABLED so it can be safely enabled in
 *   development without impacting production noise levels.
 * - logWarn: always logged (console.warn) for misconfigurations and
 *   unexpected but non-fatal conditions.
 */
function logDebug (scope, message, error) {
	if (!DEBUG_LOG_ENABLED) return
	if (error) {
		console.debug(`[proxy][${scope}] ${message}`, error)
	} else {
		console.debug(`[proxy][${scope}] ${message}`)
	}
}

function logWarn (scope, message, error) {
	if (error) {
		console.warn(`[proxy][${scope}] ${message}`, error)
	} else {
		console.warn(`[proxy][${scope}] ${message}`)
	}
}

// Optional upstream CA bundle for strict TLS mode
let upstreamCaBundle = null
if (STRICT_TLS_CA_FILE) {
	try {
		upstreamCaBundle = fs.readFileSync(STRICT_TLS_CA_FILE, 'utf8')
	} catch (error) {
		upstreamCaBundle = null
		logWarn('tls', `Failed to read STRICT TLS CA file at ${STRICT_TLS_CA_FILE}`, error)
	}
}

const app = express()

const httpDispatcher = new Agent({
  connections: 128,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000
})

const httpsConnectOptions = STRICT_TLS_ENABLED
  ? {
      rejectUnauthorized: true,
      ca: upstreamCaBundle || undefined
    }
  : {
      rejectUnauthorized: false
    }

const httpsDispatcher = new Agent({
  connections: 128,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connect: httpsConnectOptions
})

// Directories
const BLOCKED_URLS_FILE = path.join(STORAGE_DIR, 'blocked-urls.json')
const FILTER_URLS_FILE = path.join(STORAGE_DIR, 'filter-urls.json')
const LEGACY_BYPASS_URLS_FILE = path.join(STORAGE_DIR, 'bypass-urls.json')
const EDIT_RULES_FILE = path.join(STORAGE_DIR, 'edit-rules.json')

// Certificate paths (inlined from cert-manager.js)
const CA_KEY_PATH = path.join(CERTS_DIR, 'ca-key.pem')
const CA_CERT_PATH = path.join(CERTS_DIR, 'ca-cert.pem')

if (!fs.existsSync(CERTS_DIR)) {
  fs.mkdirSync(CERTS_DIR, { recursive: true })
}

const certCache = new Map()

function getOrCreateCA () {
  if (fs.existsSync(CA_KEY_PATH) && fs.existsSync(CA_CERT_PATH)) {
    const caKeyPem = fs.readFileSync(CA_KEY_PATH, 'utf8')
    const caCertPem = fs.readFileSync(CA_CERT_PATH, 'utf8')

    return {
      key: forge.pki.privateKeyFromPem(caKeyPem),
      cert: forge.pki.certificateFromPem(caCertPem),
      keyPem: caKeyPem,
      certPem: caCertPem
    }
  }

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()

  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10)

  const attrs = [
    { name: 'commonName', value: 'Cascade Proxy CA' },
    { name: 'countryName', value: 'US' },
    { name: 'organizationName', value: 'Cascade Proxy' },
    { shortName: 'OU', value: 'Development' }
  ]

  cert.setSubject(attrs)
  cert.setIssuer(attrs)

  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: true
    },
    {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true,
      codeSigning: true,
      emailProtection: true,
      timeStamping: true
    },
    {
      name: 'subjectKeyIdentifier'
    }
  ])

  cert.sign(keys.privateKey, forge.md.sha256.create())

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
  const certPem = forge.pki.certificateToPem(cert)

  fs.writeFileSync(CA_KEY_PATH, keyPem)
  fs.writeFileSync(CA_CERT_PATH, certPem)

  return {
    key: keys.privateKey,
    cert,
    keyPem,
    certPem
  }
}

function generateCertForHost (hostname, ca) {
  if (certCache.has(hostname)) {
    return certCache.get(hostname)
  }

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()

  cert.publicKey = keys.publicKey
  cert.serialNumber = Date.now().toString()
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1)

  const attrs = [
    { name: 'commonName', value: hostname },
    { name: 'countryName', value: 'US' },
    { name: 'organizationName', value: 'Cascade Proxy' }
  ]

  cert.setSubject(attrs)
  cert.setIssuer(ca.cert.subject.attributes)

  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: false
    },
    {
      name: 'keyUsage',
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true
    },
    {
      name: 'subjectAltName',
      altNames: [
        {
          type: 2,
          value: hostname
        },
        {
          type: 2,
          value: '*.' + hostname
        }
      ]
    },
    {
      name: 'subjectKeyIdentifier'
    }
  ])

  cert.sign(ca.key, forge.md.sha256.create())

  const result = {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert)
  }

  certCache.set(hostname, result)

  return result
}

// Blocked/BYPASS URL lists
let blockedUrls = [] // Array of URL strings (enabled only)
let bypassUrls = [] // Array of URL strings (enabled only, current mode)
let blockedRules = [] // Full rule objects with id, enabled, name, url
let bypassRules = [] // Full rule objects with id, enabled, name, url, mode
let bypassMatchers = []
// Precomputed blocked URL patterns used by filterLogsCore to cheaply hide
// blocked traffic from the log view without rebuilding the pattern list on
// every /api/logs request.
let blockedUrlSubstringsForFilter = []
const bypassSuggestionStats = new Map()
let logSuggestionMetadata = new WeakMap()
let editRules = []

/**
 * Safely trim a value that may not be a string.
 *
 * @param {any} value
 * @returns {string}
 */
function safeTrim (value) {
  return typeof value === 'string' ? value.trim() : ''
}

function sanitizePathForSuggestions (path) {
  if (!path || typeof path !== 'string') return '/'
  const base = path.split('?')[0] || '/'
  const segments = base.split('/').filter(Boolean).slice(0, 2)
  return segments.length ? `/${segments.join('/')}` : '/'
}

function updateSuggestionStatsOnAdd (logEntry) {
  const hostInfo = extractHostInfoFromLog(logEntry)
  if (!hostInfo?.host) return

  const hostKey = hostInfo.host
  let record = bypassSuggestionStats.get(hostKey)
  if (!record) {
    record = {
      host: hostKey,
      count: 0,
      lastSeen: 0,
      pathCounts: new Map()
    }
    bypassSuggestionStats.set(hostKey, record)
  }

  record.count += 1

  if (logEntry.timestamp) {
    const ts = Date.parse(logEntry.timestamp)
    if (!Number.isNaN(ts)) {
      record.lastSeen = Math.max(record.lastSeen, ts)
    }
  }

  const pathKey = sanitizePathForSuggestions(hostInfo.path)
  const prevPathCount = record.pathCounts.get(pathKey) || 0
  record.pathCounts.set(pathKey, prevPathCount + 1)

  logSuggestionMetadata.set(logEntry, {
    host: hostKey,
    pathKey,
    timestamp: logEntry.timestamp ? Date.parse(logEntry.timestamp) : null
  })
}

function updateSuggestionStatsOnRemove (logEntry) {
  const meta = logSuggestionMetadata.get(logEntry)
  if (!meta?.host) return

  const record = bypassSuggestionStats.get(meta.host)
  if (!record) {
    logSuggestionMetadata.delete(logEntry)
    return
  }

  record.count = Math.max(0, record.count - 1)

  if (meta.pathKey && record.pathCounts.has(meta.pathKey)) {
    const next = record.pathCounts.get(meta.pathKey) - 1
    if (next > 0) {
      record.pathCounts.set(meta.pathKey, next)
    } else {
      record.pathCounts.delete(meta.pathKey)
    }
  }

  if (record.count === 0) {
    bypassSuggestionStats.delete(meta.host)
  } else if (meta.timestamp && record.lastSeen === meta.timestamp) {
    let newLastSeen = 0
    for (const log of requestLogs) {
      const info = logSuggestionMetadata.get(log)
      if (info?.host === meta.host && info.timestamp && info.timestamp > newLastSeen) {
        newLastSeen = info.timestamp
      }
    }
    record.lastSeen = newLastSeen
  }

  logSuggestionMetadata.delete(logEntry)
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
        type: isHostPattern ? 'host' : 'path'
      }
    })
}

// Load blocked URLs from file
function loadBlockedUrls () {
  try {
    if (fs.existsSync(BLOCKED_URLS_FILE)) {
      const data = fs.readFileSync(BLOCKED_URLS_FILE, 'utf8')
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

    if (fs.existsSync(FILTER_URLS_FILE)) {
      fileToRead = FILTER_URLS_FILE
    } else if (fs.existsSync(LEGACY_BYPASS_URLS_FILE)) {
      fileToRead = LEGACY_BYPASS_URLS_FILE
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

      if (fileToRead === LEGACY_BYPASS_URLS_FILE) {
        saveBypassUrlsSync()
      }
    }
  } catch (error) {
    console.error('[proxy] Error loading bypass URLs:', error)
  }
}

// Save blocked URLs to file
async function saveBlockedUrls () {
  try {
    const payload = JSON.stringify(blockedRules, null, 2)
    await fsPromises.writeFile(BLOCKED_URLS_FILE, payload)
    // Update the active URLs array
    blockedUrls = blockedRules.filter(rule => rule.enabled).map(rule => rule.url)
    // Keep the log filtering patterns in sync with the latest blocked rules.
    recomputeBlockedUrlSubstringsForFilter()
  } catch (error) {
    console.error('[proxy] Error saving blocked URLs:', error)
  }
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
        .map(rule => (rule && typeof rule.url === 'string' ? rule.url : ''))
        .filter(Boolean)
    : []
}

function isRequestBlocked (requestUrl, fullUrl) {
  if (!blockedRulesEnabled) return false
  if (!Array.isArray(blockedUrls) || blockedUrls.length === 0) return false

  const req = typeof requestUrl === 'string' ? requestUrl : ''
  const full = typeof fullUrl === 'string' ? fullUrl : ''

  return blockedUrls.some(blockedUrl => {
    if (!blockedUrl || typeof blockedUrl !== 'string') return false
    return (req && req.includes(blockedUrl)) || (full && full.includes(blockedUrl))
  })
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
    fs.writeFileSync(FILTER_URLS_FILE, payload)
  } catch (error) {
    console.error('[proxy] Error saving bypass URLs (sync):', error)
  }
}

async function saveBypassUrls () {
  try {
    const payload = buildBypassRulesSnapshot()
    await fsPromises.writeFile(FILTER_URLS_FILE, payload)
  } catch (error) {
    console.error('[proxy] Error saving bypass URLs:', error)
  }
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
 * @param {string} pattern
 * @returns {string}
 */
function deriveDisplayNameFromUrlPattern (pattern) {
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
 * Normalise a raw bypass rule into the canonical internal representation.
 *
 * All entries stored inside bypassRules must pass through this helper so
 * that runtime paths can safely assume rules are already normalised.
 */
function normalizeBypassRule (rule = {}) {
  const url = typeof rule.url === 'string' ? rule.url : ''
  let name = ''
  if (typeof rule.name === 'string' && rule.name.trim()) {
    name = rule.name.trim()
  } else {
    name = deriveDisplayNameFromUrlPattern(url)
  }

  return {
    id: rule.id || `bypass-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    enabled: rule.enabled !== false,
    name,
    url,
    mode: rule.mode === 'focus' ? 'focus' : 'ignore'
  }
}

/**
 * Normalise a raw blocked-rule entry into a canonical representation.
 * Used when loading from disk and when mutating rules via /api/blocked so
 * that the UI always receives a stable id, url, enabled flag and a
 * human-friendly name.
 */
function normalizeBlockedRule (rule = {}) {
  const url = typeof rule.url === 'string' ? rule.url : ''
  let name = ''
  if (typeof rule.name === 'string' && rule.name.trim()) {
    name = rule.name.trim()
  } else {
    name = deriveDisplayNameFromUrlPattern(url)
  }

  const id = (typeof rule.id === 'string' && rule.id.trim())
    ? rule.id
    : `blocked-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  return {
    id,
    enabled: rule.enabled !== false,
    name,
    url
  }
}

/**
 * Rebuild the list of bypass URLs and matchers for the current mode from the
 * already-normalised bypassRules array.
 */
function rebuildBypassUrlsForCurrentMode () {
  const mode = getBypassMode()
  // Filter only enabled rules for the active mode and extract URLs
  const normalizedRules = bypassRules
  bypassUrls = normalizedRules
    .filter(rule => rule && rule.enabled && rule.mode === mode)
    .map(rule => rule.url)
  buildBypassMatchers()
}

function normalizeEditRule (rule = {}) {
  const kind = rule.kind === 'jsonPath' ? 'jsonPath' : 'text'

  if (kind === 'jsonPath') {
    let valueType = 'string'
    if (rule.valueType === 'number' || rule.valueType === 'boolean' || rule.valueType === 'null') {
      valueType = rule.valueType
    }

    const normalizedTarget =
      rule.target === 'response' || rule.target === 'both'
        ? rule.target
        : 'request'

    return {
      id: rule.id || crypto.randomUUID(),
      enabled: rule.enabled !== false,
      kind,
      name: rule.name || '',
      path: typeof rule.path === 'string' ? rule.path : '',
      value: Object.prototype.hasOwnProperty.call(rule, 'value') ? rule.value : '',
      valueType,
      // URL pattern su cui applicare la regola jsonPath; se vuoto la regola
      // non verrà inclusa nella cache compilata.
      url: typeof rule.url === 'string' ? rule.url : '',
      // Bersaglio della regola: 'request', 'response' oppure 'both'. Per
      // compatibilità all'indietro, le regole esistenti senza target esplicito
      // vengono trattate come 'request'.
      target: normalizedTarget
    }
  }

  // Default/legacy text rule. Text rules now support optional URL scoping and
  // request/response/both targeting, but for backwards compatibility existing
  // rules without an explicit target continue to apply to both directions.
  let normalizedTarget = 'both'
  if (rule.target === 'request' || rule.target === 'response' || rule.target === 'both') {
    normalizedTarget = rule.target
  }

  return {
    id: rule.id || crypto.randomUUID(),
    enabled: rule.enabled !== false,
    kind: 'text',
    name: rule.name || '',
    start: rule.start || '',
    end: rule.end || '',
    replacement: rule.replacement || '',
    useRegex: rule.useRegex === true,
    caseSensitive: rule.caseSensitive === true,
    // Optional URL pattern; when non-empty, the rule will only be applied
    // when the current URL context matches it (see textRuleMatchesUrl).
    url: typeof rule.url === 'string' ? rule.url : '',
    // Optional phase target; defaults to 'both' for text rules so that legacy
    // rules keep affecting both requests and responses unless narrowed.
    target: normalizedTarget
  }
}

function loadEditRules () {
  try {
    if (fs.existsSync(EDIT_RULES_FILE)) {
      const data = JSON.parse(fs.readFileSync(EDIT_RULES_FILE, 'utf8'))
      if (Array.isArray(data)) {
        editRules = data.map(normalizeEditRule)
      }
    }
  } catch (error) {
    console.error('[proxy] Error loading edit rules:', error)
    editRules = []
  }
}

async function saveEditRules () {
  try {
    const payload = JSON.stringify(editRules, null, 2)
    await fsPromises.writeFile(EDIT_RULES_FILE, payload)
  } catch (error) {
    console.error('[proxy] Error saving edit rules:', error)
  }
}

let compiledEditRules = []
let compiledJsonPathRules = []

function parseJsonPath (path) {
  if (!path || typeof path !== 'string') return []

  const trimmed = path.trim()
  if (!trimmed) return []

  let s = trimmed

  // Support optional leading symbols like "root" or "$" (e.g. "root.f1.f2" or "$.f1[0]")
  if (s === 'root' || s === '$') {
    return []
  }

  if (s.startsWith('root.')) {
    s = s.slice(5)
  } else if (s.startsWith('root[')) {
    s = s.slice(4)
  } else if (s.startsWith('$.')) {
    s = s.slice(2)
  } else if (s.startsWith('$[')) {
    s = s.slice(1)
  }

  const segments = []
  let i = 0

  while (i < s.length) {
    const ch = s[i]

    if (ch === '.') {
      i += 1
      continue
    }

    if (ch === '[') {
      const end = s.indexOf(']', i + 1)
      if (end === -1) return []

      const inside = s.slice(i + 1, end).trim()
      if (!inside) return []

      // Only support numeric indices for now: root.items[3].name
      if (!/^\d+$/.test(inside)) return []
      const index = Number.parseInt(inside, 10)
      if (!Number.isFinite(index) || index < 0) return []

      segments.push({ type: 'index', index })
      i = end + 1
      continue
    }

    // Parse identifier segment until next '.', '[' or ']' (dot-notation key)
    let j = i
    while (j < s.length && s[j] !== '.' && s[j] !== '[' && s[j] !== ']') {
      j += 1
    }

    const key = s.slice(i, j).trim()
    if (!key) return []

    segments.push({ type: 'key', key })
    i = j
  }

  return segments
}

function getCompiledJsonPathRules () {
  if (!editRulesEnabled) return []
  return compiledJsonPathRules
}

function rebuildConnectEnvelope (frames = []) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return Buffer.alloc(0)
  }

  let totalLength = 0
  for (const frame of frames) {
    const dataLength = Buffer.isBuffer(frame?.data) ? frame.data.length : 0
    totalLength += 5 + dataLength
  }

  const rebuilt = Buffer.allocUnsafe(totalLength)
  let offset = 0

  for (const frame of frames) {
    const flags = typeof frame?.flags === 'number' ? frame.flags : 0
    const data = Buffer.isBuffer(frame?.data) ? frame.data : Buffer.alloc(0)
    rebuilt.writeUInt8(flags & 0xFF, offset)
    rebuilt.writeUInt32BE(data.length, offset + 1)
    if (data.length > 0) {
      data.copy(rebuilt, offset + 5)
    }
    offset += 5 + data.length
  }

  return rebuilt
}

function replaceAllLiteral (text, needle, replacement, caseSensitive) {
  if (!needle || needle.length === 0) {
    return { text, count: 0 }
  }

  const searchNeedle = caseSensitive ? needle : needle.toLowerCase()
  const haystack = caseSensitive ? text : text.toLowerCase()
  const parts = []
  let lastIndex = 0
  let count = 0

  let index = haystack.indexOf(searchNeedle, lastIndex)

  while (index !== -1) {
    parts.push(text.slice(lastIndex, index))
    parts.push(replacement)
    lastIndex = index + needle.length
    count += 1
    index = haystack.indexOf(searchNeedle, lastIndex)
  }

  if (count === 0) {
    return { text, count }
  }

  parts.push(text.slice(lastIndex))
  return { text: parts.join(''), count }
}

function replaceBetweenLiteral (text, start, end, replacement, caseSensitive) {
  if (!start || !end || start.length === 0 || end.length === 0) {
    return { text, count: 0 }
  }

  const startSearch = caseSensitive ? start : start.toLowerCase()
  const endSearch = caseSensitive ? end : end.toLowerCase()
  const haystack = caseSensitive ? text : text.toLowerCase()

  let result = ''
  let lastIndex = 0
  let count = 0

  let startIndex = haystack.indexOf(startSearch, lastIndex)

  while (startIndex !== -1) {
    const endIndex = haystack.indexOf(endSearch, startIndex + start.length)
    if (endIndex === -1) break

    result += text.slice(lastIndex, startIndex)
    result += replacement

    lastIndex = endIndex + end.length
    count += 1

    startIndex = haystack.indexOf(startSearch, lastIndex)
  }

  if (count === 0) {
    return { text, count }
  }

  result += text.slice(lastIndex)
  return { text: result, count }
}

function compileEditRule (rule) {
  if (!rule || !rule.enabled) return null

  const startRaw = typeof rule.start === 'string' ? rule.start : ''
  const endRaw = typeof rule.end === 'string' ? rule.end : ''

  if (!startRaw && !endRaw) {
    return null
  }

  const useRegex = !!rule.useRegex
  const caseSensitive = !!rule.caseSensitive
  const flags = `g${caseSensitive ? '' : 'i'}`

  const compiled = {
    rule,
    mode: null,
    useRegex,
    caseSensitive,
    start: startRaw,
    end: endRaw
  }

  if (useRegex) {
    if (startRaw && endRaw) {
      compiled.mode = 'between'
      compiled.regex = new RegExp(`${startRaw}[\\s\\S]*?${endRaw}`, flags)
    } else if (startRaw) {
      compiled.mode = 'prefix'
      compiled.regex = new RegExp(startRaw, flags)
    } else {
      compiled.mode = 'suffix'
      compiled.regex = new RegExp(endRaw, flags)
    }
    return compiled
  }

  if (startRaw && endRaw) {
    compiled.mode = 'between'
  } else if (startRaw) {
    compiled.mode = 'prefix'
  } else {
    compiled.mode = 'suffix'
  }

  return compiled
}

function rebuildEditRuleCache () {
  compiledEditRules = []
  compiledJsonPathRules = []

  for (const rule of editRules) {
    if (!rule || rule.enabled === false) continue

    if (rule.kind === 'jsonPath') {
      // Pre-parse the path into structured segments for fast traversal at runtime.
      // Le regole jsonPath richiedono anche un URL non vuoto per essere attive.
      const urlPatternRaw = typeof rule.url === 'string' ? rule.url : ''
      const urlPattern = urlPatternRaw.trim()
      if (!urlPattern) continue

      const segments = parseJsonPath(rule.path)
      if (!segments || !segments.length) continue

      let valueType = 'string'
      if (rule.valueType === 'number' || rule.valueType === 'boolean' || rule.valueType === 'null') {
        valueType = rule.valueType
      }

      const normalizedTarget =
        rule.target === 'response' || rule.target === 'both'
          ? rule.target
          : 'request'

      compiledJsonPathRules.push({
        id: rule.id,
        kind: 'jsonPath',
        name: rule.name || '',
        path: rule.path,
        segments,
        value: rule.value,
        valueType,
        url: urlPattern,
        target: normalizedTarget
      })
      continue
    }

    const compiled = compileEditRule(rule)
    if (compiled) {
      compiledEditRules.push(compiled)
    }
  }
}

function getCompiledRules () {
  if (!editRulesEnabled) return []
  return compiledEditRules
}

function jsonPathRuleMatchesUrl (rule, context = {}) {
  const rawPattern = typeof rule.url === 'string' ? rule.url : ''
  const trimmed = rawPattern.trim()
  if (!trimmed) return false

  const pattern = trimmed.toLowerCase()

  const candidates = []
  if (typeof context.requestUrl === 'string' && context.requestUrl) {
    candidates.push(context.requestUrl.toLowerCase())
  }
  if (typeof context.fullUrl === 'string' && context.fullUrl) {
    candidates.push(context.fullUrl.toLowerCase())
  }

  if (candidates.length === 0) return false

  // Consider a match if either the URL contains the pattern or the pattern
  // contains the URL. This allows rules defined with the full upstream URL
  // to still match when we only know the path (e.g. "/exa.api_server_pb..."),
  // and vice versa.
  return candidates.some(url => url.includes(pattern) || pattern.includes(url))
}

/**
 * Determine whether a text edit rule should run for the given URL context.
 *
 * Text rules treat an empty URL pattern as "no constraint" (match all URLs),
 * while non-empty patterns behave like JSONPath rules and are matched using a
 * bidirectional contains check against requestUrl/fullUrl.
 *
 * @param {{url?: string}} rule
 * @param {{requestUrl?: string, fullUrl?: string}} [context]
 * @returns {boolean}
 */
function textRuleMatchesUrl (rule, context = {}) {
  if (!rule || typeof rule !== 'object') return true

  const rawPattern = typeof rule.url === 'string' ? rule.url : ''
  const trimmed = rawPattern.trim()

  // When no URL pattern is provided, treat the rule as global.
  if (!trimmed) return true

  const pattern = trimmed.toLowerCase()

  const candidates = []
  if (typeof context.requestUrl === 'string' && context.requestUrl) {
    candidates.push(context.requestUrl.toLowerCase())
  }
  if (typeof context.fullUrl === 'string' && context.fullUrl) {
    candidates.push(context.fullUrl.toLowerCase())
  }

  if (candidates.length === 0) return false

  return candidates.some(url => url.includes(pattern) || pattern.includes(url))
}

function applyJsonPathRulesToObject (root, context = {}) {
  if (!root || typeof root !== 'object') {
    return { object: root, appliedRuleIds: [], changed: false, changedTopLevelKeys: [] }
  }

  const rules = getCompiledJsonPathRules()
  if (!Array.isArray(rules) || rules.length === 0) {
    return { object: root, appliedRuleIds: [], changed: false }
  }

  const phase = context && context.phase === 'response' ? 'response' : 'request'

  const appliedSet = new Set()
  const changedRootKeys = new Set()
  let changed = false

  for (const rule of rules) {
    if (!rule || !Array.isArray(rule.segments) || rule.segments.length === 0) continue

    const target = rule.target === 'response' || rule.target === 'both' ? rule.target : 'request'

    if (target === 'request' && phase !== 'request') continue
    if (target === 'response' && phase !== 'response') continue

    // Le regole jsonPath vengono applicate solo se l'URL corrente matcha il
    // pattern associato alla regola.
    if (!jsonPathRuleMatchesUrl(rule, context)) continue

    const segments = rule.segments
    let parent = root
    let validPath = true

    // Traverse all but the last segment to find the parent container
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      if (!parent || typeof parent !== 'object') {
        validPath = false
        break
      }

      if (seg.type === 'key') {
        if (!Object.prototype.hasOwnProperty.call(parent, seg.key)) {
          validPath = false
          break
        }
        parent = parent[seg.key]
      } else if (seg.type === 'index') {
        if (!Array.isArray(parent)) {
          validPath = false
          break
        }
        const idx = seg.index
        if (idx < 0 || idx >= parent.length) {
          validPath = false
          break
        }
        parent = parent[idx]
      } else {
        validPath = false
        break
      }
    }

    if (!validPath) continue

    const lastSeg = segments[segments.length - 1]
    let container = parent
    let keyOrIndex
    let currentValue

    if (lastSeg.type === 'key') {
      if (!container || typeof container !== 'object' || !Object.prototype.hasOwnProperty.call(container, lastSeg.key)) {
        continue
      }
      keyOrIndex = lastSeg.key
      currentValue = container[lastSeg.key]
    } else if (lastSeg.type === 'index') {
      if (!Array.isArray(container)) continue
      const idx = lastSeg.index
      if (idx < 0 || idx >= container.length) continue
      keyOrIndex = idx
      currentValue = container[idx]
    } else {
      continue
    }

    // Compute the new value based on valueType
    let newValue
    if (rule.valueType === 'number') {
      if (typeof rule.value === 'number') {
        newValue = rule.value
      } else if (typeof rule.value === 'string') {
        const parsed = Number(rule.value.trim())
        if (!Number.isFinite(parsed)) continue
        newValue = parsed
      } else {
        continue
      }
    } else if (rule.valueType === 'boolean') {
      if (typeof rule.value === 'boolean') {
        newValue = rule.value
      } else if (typeof rule.value === 'string') {
        const lower = rule.value.trim().toLowerCase()
        if (lower === 'true') newValue = true
        else if (lower === 'false') newValue = false
        else continue
      } else {
        continue
      }
    } else if (rule.valueType === 'null') {
      newValue = null
    } else {
      // Default: treat as string
      newValue = rule.value != null ? String(rule.value) : ''
    }

    const isSame =
      (newValue === currentValue) ||
      (typeof newValue === 'number' && Number.isNaN(newValue) && typeof currentValue === 'number' && Number.isNaN(currentValue))

    if (isSame) continue

    container[keyOrIndex] = newValue
    changed = true
    if (rule.id) {
      appliedSet.add(rule.id)
    }

    // Track changed top-level fN keys to avoid deep clones in protobuf paths.
    if (
      container === root &&
      typeof keyOrIndex === 'string' &&
      /^f\d+$/.test(keyOrIndex) &&
      typeof newValue === 'string'
    ) {
      changedRootKeys.add(keyOrIndex)
    }
  }

  return {
    object: root,
    appliedRuleIds: Array.from(appliedSet),
    changed,
    changedTopLevelKeys: Array.from(changedRootKeys)
  }
}

// Protobuf helpers (inlined from protobuf-rewriter.js)
function readVarint (buffer, offset) {
  let result = 0
  let shift = 0
  let length = 0

  while (offset < buffer.length && length < 10) {
    const byte = buffer[offset++]
    result |= (byte & 0x7F) << shift
    length++
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, length }
    }
    shift += 7
  }

  throw new Error('Invalid varint encoding')
}

// Reuse the existing varint/key encoding helpers defined below
function encodeVarint (value) {
  return encodeVarint32(value)
}

function encodeKey (fieldNumber, wireType) {
  return encodeProtobufKey(fieldNumber, wireType)
}

function parseMessageDetailed (buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('Expected Buffer')
  }

  const fields = []
  let offset = 0
  const len = buffer.length

  while (offset < len) {
    const start = offset
    const keyInfo = readVarint(buffer, offset)
    const key = keyInfo.value
    const keyLen = keyInfo.length
    offset += keyLen

    const fieldNumber = key >>> 3
    const wireType = key & 0x07
    if (fieldNumber <= 0) {
      throw new Error('Invalid field number')
    }

    const field = {
      fieldNumber,
      wireType,
      value: null,
      data: null,
      raw: null
    }

    if (wireType === 0) {
      const vInfo = readVarint(buffer, offset)
      field.value = vInfo.value
      offset += vInfo.length
    } else if (wireType === 1) {
      if (offset + 8 > len) {
        throw new Error('Truncated 64-bit field')
      }
      field.data = buffer.slice(offset, offset + 8)
      offset += 8
    } else if (wireType === 2) {
      const lInfo = readVarint(buffer, offset)
      const n = lInfo.value >>> 0
      offset += lInfo.length
      if (offset + n > len) {
        throw new Error('Truncated length-delimited field')
      }
      field.data = buffer.slice(offset, offset + n)
      offset += n
    } else if (wireType === 5) {
      if (offset + 4 > len) {
        throw new Error('Truncated 32-bit field')
      }
      field.data = buffer.slice(offset, offset + 4)
      offset += 4
    } else {
      throw new Error('Unsupported wire type ' + wireType)
    }

    field.raw = buffer.slice(start, offset)
    fields.push(field)
  }

  return { fields }
}

function parseProtobuf (buffer) {
  const { fields } = parseMessageDetailed(buffer)
  return {
    fields: fields.map(field => ({
      fieldNumber: field.fieldNumber,
      wireType: field.wireType,
      value: field.value,
      data: field.data
    }))
  }
}

function encodeLengthDelimitedField (fieldNumber, dataBuffer) {
  const key = encodeKey(fieldNumber, 2)
  const lenBuf = encodeVarint(dataBuffer.length >>> 0)
  return Buffer.concat([key, lenBuf, dataBuffer])
}

function printableRatio (buffer) {
  if (!buffer || buffer.length === 0) return 0
  let printable = 0
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i]
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) {
      printable++
    }
  }
  return printable / buffer.length
}

/**
 * Recursively rewrite printable text segments inside a protobuf message using
 * the provided textRewriter. Size/field limits are enforced via the
 * PROTOBUF_MAX_*_LIMIT constants to keep CPU usage bounded on large payloads.
 *
 * @param {Buffer} buffer - Raw protobuf message buffer.
 * @param {(text: string) => { text: string, changed: boolean, appliedRuleIds?: string[] }} textRewriter
 * @param {number} depth - Current recursion depth.
 * @param {number} maxDepth - Maximum allowed recursion depth.
 * @returns {{ buffer: Buffer, appliedRuleIds: string[], changed: boolean }}
 */
function rewriteMessage (buffer, textRewriter, depth, maxDepth) {
  const maxFields = PROTOBUF_MAX_FIELDS_LIMIT
  const maxBytes = PROTOBUF_MAX_BYTES_LIMIT

  if (buffer && Buffer.isBuffer(buffer) && buffer.length > maxBytes) {
    return {
      buffer,
      appliedRuleIds: [],
      changed: false
    }
  }

  const { fields } = parseMessageDetailed(buffer)
  const chunks = []
  const applied = new Set()
  let changed = false

  let processedFields = 0

  for (const field of fields) {
    if (processedFields >= maxFields) {
      chunks.push(field.raw)
      continue
    }
    processedFields++
    let fieldBuffer = field.raw
    let fieldChanged = false

    if (field.wireType === 2 && Buffer.isBuffer(field.data) && field.data.length > 0) {
      let newData = field.data

      if (depth < maxDepth) {
        try {
          const nested = rewriteMessage(field.data, textRewriter, depth + 1, maxDepth)
          if (nested.changed && Buffer.isBuffer(nested.buffer)) {
            newData = nested.buffer
            fieldChanged = true
            nested.appliedRuleIds.forEach(id => applied.add(id))
          }
        } catch (error) {
          logDebug('rewriteMessage', 'Failed to rewrite nested protobuf field', error)
        }
      }

      if (!fieldChanged) {
        const ratio = printableRatio(field.data)
        if (ratio >= 0.7) {
          let text = null
          try {
            text = field.data.toString('utf8')
          } catch (error) {
            text = null
          }
          if (text && text.length > 0) {
            const result = textRewriter(text)
            if (result && result.changed && typeof result.text === 'string') {
              newData = Buffer.from(result.text, 'utf8')
              fieldChanged = true
              if (Array.isArray(result.appliedRuleIds)) {
                for (const id of result.appliedRuleIds) {
                  if (id) applied.add(id)
                }
              }
            }
          }
        }
      }

      if (fieldChanged) {
        fieldBuffer = encodeLengthDelimitedField(field.fieldNumber, newData)
      }
    }

    if (fieldChanged) {
      changed = true
    }

    chunks.push(fieldBuffer)
  }

  if (!changed) {
    return {
      buffer,
      appliedRuleIds: [],
      changed: false
    }
  }

  const outBuffer = Buffer.concat(chunks)
  return {
    buffer: outBuffer,
    appliedRuleIds: Array.from(applied),
    changed: true
  }
}

function rewriteProtobufFields (buffer, textRewriter) {
  if (!Buffer.isBuffer(buffer) || typeof textRewriter !== 'function') {
    return { buffer, appliedRuleIds: [], changed: false }
  }

  try {
    const result = rewriteMessage(buffer, textRewriter, 0, 4)
    if (!result || !Buffer.isBuffer(result.buffer)) {
      return { buffer, appliedRuleIds: [], changed: false }
    }
    return {
      buffer: result.buffer,
      appliedRuleIds: result.appliedRuleIds || [],
      changed: !!result.changed
    }
  } catch (error) {
    logDebug('rewriteProtobufFields', 'Failed to rewrite protobuf fields', error)
    return { buffer, appliedRuleIds: [], changed: false }
  }
}

// Encode a 32-bit unsigned integer as protobuf varint.
function encodeVarint32 (value) {
  let v = value >>> 0
  const bytes = []
  while (v > 127) {
    bytes.push((v & 0x7F) | 0x80)
    v >>>= 7
  }
  bytes.push(v)
  return Buffer.from(bytes)
}

// Encode protobuf key (field number + wire type) as varint.
function encodeProtobufKey (fieldNumber, wireType) {
  if (!Number.isInteger(fieldNumber) || fieldNumber <= 0) {
    throw new Error('Invalid field number')
  }
  return encodeVarint32((fieldNumber << 3) | (wireType & 0x07))
}

// Re-encode a protobuf message from the simplified field representation
// returned by parseProtobuf.
function encodeProtobufFromFields (fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return Buffer.alloc(0)
  }

  const chunks = []

  for (const field of fields) {
    if (!field || typeof field.fieldNumber !== 'number' || typeof field.wireType !== 'number') {
      continue
    }

    const fieldNumber = field.fieldNumber
    const wireType = field.wireType

    try {
      chunks.push(encodeProtobufKey(fieldNumber, wireType))
    } catch {
      continue
    }

    if (wireType === 0) {
      // Varint
      const value = typeof field.value === 'number' ? field.value : 0
      chunks.push(encodeVarint32(value))
    } else if (wireType === 2) {
      // Length-delimited
      const data = Buffer.isBuffer(field.data) ? field.data : Buffer.alloc(0)
      const lenBuf = encodeVarint32(data.length >>> 0)
      chunks.push(lenBuf, data)
    } else if (wireType === 1 || wireType === 5) {
      // Fixed 64/32-bit
      const data = Buffer.isBuffer(field.data)
        ? field.data
        : Buffer.alloc(wireType === 1 ? 8 : 4)
      chunks.push(data)
    } else {
      // Unsupported wire type; drop the field entirely.
      chunks.pop()
      continue
    }
  }

  return Buffer.concat(chunks)
}

/**
 * Apply JSONPath rules directly to a protobuf message buffer when possible,
 * currently limited to simple top-level string fields such as "root.f2".
 *
 * The helper:
 * - quickly checks whether there are any JSONPath rules that could match the
 *   current URL context before attempting protobuf/JSON decoding;
 * - extracts a lightweight JSON view from the protobuf buffer only when such
 *   rules are present;
 * - re-encodes the protobuf message when top-level string fields are changed.
 *
 * This keeps behaviour identical while avoiding expensive protobuf parsing
 * when no JSONPath rules are applicable to the current Connect payload.
 *
 * @param {Buffer} buffer - Protobuf message buffer for a single Connect frame.
 * @param {object|null} initialJson - Optional pre-extracted JSON view.
 * @param {object} [context] - URL/phase context used for JSONPath rule matching.
 * @returns {{buffer: Buffer, json: any, appliedRuleIds: string[], changed: boolean}}
 */
function applyJsonPathRulesToProtobufBuffer (buffer, initialJson, context = {}) {
  if (isEmptyBuffer(buffer)) {
    return { buffer, json: initialJson, appliedRuleIds: [], changed: false }
  }

  const rules = getCompiledJsonPathRules()
  if (!Array.isArray(rules) || rules.length === 0) {
    return { buffer, json: initialJson, appliedRuleIds: [], changed: false }
  }

  // Cheap URL-based prefilter: if no rule matches the current URL/phase
  // context, skip protobuf/JSON work entirely for this frame.
  const jsonPathContext = context || {}
  const hasMatchingRule = rules.some(rule => jsonPathRuleMatchesUrl(rule, jsonPathContext))
  if (!hasMatchingRule) {
    return { buffer, json: initialJson, appliedRuleIds: [], changed: false }
  }

  let json = initialJson
  if (!json || typeof json !== 'object') {
    json = extractJsonFromProtobufBuffer(buffer)
    if (!json || typeof json !== 'object') {
      return { buffer, json: initialJson || json, appliedRuleIds: [], changed: false }
    }
  }

  const result = applyJsonPathRulesToObject(json, context)
  if (!result || !result.changed) {
    return {
      buffer,
      json: result ? result.object : json,
      appliedRuleIds: result ? (result.appliedRuleIds || []) : [],
      changed: false
    }
  }

  const after = result.object || {}

  const patches = []
  const keysToCheck = Array.isArray(result.changedTopLevelKeys) && result.changedTopLevelKeys.length
    ? result.changedTopLevelKeys
    : Object.keys(after)

  for (const key of keysToCheck) {
    if (!/^f\d+$/.test(key)) continue

    const afterVal = after[key]
    if (typeof afterVal !== 'string') continue

    const fieldNumber = Number.parseInt(key.slice(1), 10)
    if (!Number.isFinite(fieldNumber) || fieldNumber <= 0) continue

    patches.push({ fieldNumber, newValue: afterVal })
  }

  if (patches.length === 0) {
    return {
      buffer,
      json: after,
      appliedRuleIds: result.appliedRuleIds || [],
      changed: false
    }
  }

  let proto
  try {
    proto = parseProtobuf(buffer)
  } catch {
    return {
      buffer,
      json: after,
      appliedRuleIds: result.appliedRuleIds || [],
      changed: false
    }
  }

  if (!proto || !Array.isArray(proto.fields) || proto.fields.length === 0) {
    return {
      buffer,
      json: after,
      appliedRuleIds: result.appliedRuleIds || [],
      changed: false
    }
  }

  const fields = proto.fields.map(field => ({ ...field }))

  let mutated = false
  for (const patch of patches) {
    const { fieldNumber, newValue } = patch
    const field = fields.find(
      f => f.fieldNumber === fieldNumber && f.wireType === 2 && Buffer.isBuffer(f.data)
    )
    if (!field) continue

    field.data = Buffer.from(newValue, 'utf8')
    mutated = true
  }

  if (!mutated) {
    return {
      buffer,
      json: after,
      appliedRuleIds: result.appliedRuleIds || [],
      changed: false
    }
  }

  const nextBuffer = encodeProtobufFromFields(fields)

  return {
    buffer: nextBuffer,
    json: after,
    appliedRuleIds: result.appliedRuleIds || [],
    changed: true
  }
}

function applyCompiledRuleToText (compiled, text, appliedSet, context) {
  const { rule, mode, useRegex, caseSensitive } = compiled

  // When a context is provided, honour per-rule target (request/response/both)
  // and optional URL scoping before attempting any text replacement.
  if (context && typeof context === 'object' && rule && typeof rule === 'object') {
    const phase = context.phase === 'response' ? 'response' : 'request'

    let target = 'both'
    if (rule.target === 'request' || rule.target === 'response' || rule.target === 'both') {
      target = rule.target
    }

    if (target === 'request' && phase === 'response') {
      return { text, changed: false }
    }
    if (target === 'response' && phase === 'request') {
      return { text, changed: false }
    }

    if (!textRuleMatchesUrl(rule, context)) {
      return { text, changed: false }
    }
  }

  if (useRegex) {
    if (!compiled.regex) {
      return { text, changed: false }
    }

    compiled.regex.lastIndex = 0
    let changed = false
    const next = text.replace(compiled.regex, () => {
      appliedSet.add(rule.id)
      changed = true
      return rule.replacement
    })

    return {
      text: next,
      changed
    }
  }

  let result
  if (mode === 'between') {
    result = replaceBetweenLiteral(text, compiled.start, compiled.end, rule.replacement, caseSensitive)
  } else if (mode === 'prefix') {
    result = replaceAllLiteral(text, compiled.start, rule.replacement, caseSensitive)
  } else {
    result = replaceAllLiteral(text, compiled.end, rule.replacement, caseSensitive)
  }

  if (result.count > 0) {
    appliedSet.add(rule.id)
    return {
      text: result.text,
      changed: true
    }
  }

  return {
    text,
    changed: false
  }
}

function applyEditRulesToText (text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, appliedRuleIds: [], changed: false }
  }

  const compiledRules = getCompiledRules()
  if (!compiledRules.length) {
    return { text, appliedRuleIds: [], changed: false }
  }

  const appliedSet = new Set()
  let current = text
  let changed = false

  // Optional URL/phase context is forwarded to individual rules so they can
  // implement scoping similar to JSONPath-based rules.
  const context = arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : null

  for (const compiled of compiledRules) {
    const result = applyCompiledRuleToText(compiled, current, appliedSet, context)
    if (result.changed) {
      current = result.text
      changed = true
    }
  }

  return {
    text: current,
    appliedRuleIds: Array.from(appliedSet),
    changed
  }
}

/**
 * Apply edit rules to HTTP headers.
 *
 * Contract:
 * - Call this before sending any upstream request to allow header rewrites.
 * - Call this before sending upstream response headers back to the client.
 *
 * This keeps header rewrite behaviour consistent across proxy/MITM/bypass
 * flows without duplicating inline header-munging logic.
 */
function applyEditRulesToHeaders (headers = {}, context) {
  const compiledRules = getCompiledRules()
  if (!compiledRules.length) {
    return { headers, appliedRuleIds: [], changed: false }
  }

  const appliedSet = new Set()
  const resultHeaders = {}
  let changed = false

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      const updatedValues = value.map(entry => {
        if (typeof entry !== 'string') return entry
        let current = entry
        let entryChanged = false
        for (const compiled of compiledRules) {
          const result = applyCompiledRuleToText(compiled, current, appliedSet, context)
          if (result.changed) {
            current = result.text
            entryChanged = true
          }
        }
        if (entryChanged) changed = true
        return current
      })
      resultHeaders[key] = updatedValues
    } else if (typeof value === 'string') {
      let current = value
      let entryChanged = false
      for (const compiled of compiledRules) {
        const result = applyCompiledRuleToText(compiled, current, appliedSet, context)
        if (result.changed) {
          current = result.text
          entryChanged = true
        }
      }
      if (entryChanged) changed = true
      resultHeaders[key] = current
    } else {
      resultHeaders[key] = value
    }
  }

  return {
    headers: resultHeaders,
    appliedRuleIds: Array.from(appliedSet),
    changed
  }
}

function applyEditRulesToBuffer (buffer, context) {
  if (isEmptyBuffer(buffer)) {
    return { buffer, appliedRuleIds: [], changed: false }
  }

  // Skip clearly binary payloads to avoid wasted UTF-8 decoding and regex work.
  // This reuses the same printable heuristics used in protobuf paths.
  const ratio = printableRatio(buffer)
  if (ratio < 0.3) {
    return { buffer, appliedRuleIds: [], changed: false }
  }

  let text
  try {
    text = buffer.toString('utf8')
  } catch (error) {
    logDebug('applyEditRulesToBuffer', 'Failed to decode buffer as UTF‑8', error)
    return { buffer, appliedRuleIds: [], changed: false }
  }

  const { text: nextText, appliedRuleIds, changed } = applyEditRulesToText(text, context)
  if (!changed) {
    return { buffer, appliedRuleIds, changed: false }
  }

  return {
    buffer: Buffer.from(nextText, 'utf8'),
    appliedRuleIds,
    changed: true
  }
}

function attachRewriteMetadata (logEntry, appliedRuleIds) {
  if (!logEntry || !Array.isArray(appliedRuleIds) || appliedRuleIds.length === 0) return
  if (!logEntry.rewrites) {
    logEntry.rewrites = []
  }

  for (const id of appliedRuleIds) {
    if (!id) continue

    // Avoid duplicating the same rule id for a single log entry.
    if (logEntry.rewrites.some(entry => entry && entry.id === id)) continue

    const rule = Array.isArray(editRules)
      ? editRules.find(r => r && r.id === id)
      : null

    const entry = { id }

    if (rule) {
      if (typeof rule.name === 'string' && rule.name.trim()) {
        entry.name = rule.name.trim()
      }

      if (typeof rule.kind === 'string' && rule.kind.trim()) {
        entry.kind = rule.kind.trim()
      }

      if (typeof rule.url === 'string' && rule.url.trim()) {
        entry.url = rule.url.trim()
      }

      // Normalise target so the frontend can simply render it.
      const rawTarget = typeof rule.target === 'string' ? rule.target.trim() : ''
      if (rawTarget === 'request' || rawTarget === 'response' || rawTarget === 'both') {
        entry.target = rawTarget
      } else if (rule.kind === 'text') {
        // Text rules historically applied to both phases when target was omitted.
        entry.target = 'both'
      } else if (rule.kind === 'jsonPath') {
        // JSONPath rules default to request when not explicitly set.
        entry.target = 'request'
      }
    } else {
      // Rule has been deleted or is otherwise missing; keep a minimal stub
      // so the UI can still surface that a rewrite occurred.
      entry.kind = 'unknown'
    }

    logEntry.rewrites.push(entry)
  }
}

// Cache for case-insensitive header lookups to avoid repeated full scans
const headerLookupCache = new WeakMap()

function getHeaderCaseInsensitive (headers, name) {
  if (!headers || typeof headers !== 'object') return undefined
  let cache = headerLookupCache.get(headers)

  if (!cache) {
    cache = {}
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase()
      // Preserve the first occurrence for a given lower-cased key
      if (!Object.prototype.hasOwnProperty.call(cache, lower)) {
        cache[lower] = Array.isArray(value) ? value[0] : value
      }
    }
    headerLookupCache.set(headers, cache)
  }

  const target = name.toLowerCase()
  return cache[target]
}

function looksLikeConnectEnvelope (buffer) {
  if (!buffer || buffer.length < 5 || !Buffer.isBuffer(buffer)) return false
  try {
    let offset = 0
    while (offset + 5 <= buffer.length) {
      const flags = buffer.readUInt8(offset)
      if ((flags & 0xFC) !== 0) return false
      const length = buffer.readUInt32BE(offset + 1)
      offset += 5
      if (length < 0 || offset + length > buffer.length) return false
      offset += length
    }
    return offset === buffer.length
  } catch (error) {
    logDebug('looksLikeConnectEnvelope', 'Failed while scanning Connect envelope', error)
    return false
  }
}

/**
 * Apply Connect/gRPC frame-level rewrites (text + JSONPath) to a raw HTTP
 * body buffer, optionally collecting per-frame metadata for logging.
 *
 * When logging is disabled via the options, the function still performs all
 * binary rewrites but skips preview/JSON extraction work for individual
 * frames to reduce CPU overhead.
 *
 * @param {Buffer} buffer - Raw HTTP body buffer.
 * @param {object} headers - HTTP headers for the message.
 * @param {object|null} decodedConnect - Optional Connect decode view.
 * @param {object} jsonPathContext - Context forwarded to JSONPath rules.
 * @param {{ loggingEnabled?: boolean }} [options] - Controls frame metadata/logging work.
 * @returns {{ buffer: Buffer, appliedRuleIds: string[], changed: boolean, encoding?: string, updatedFrames?: any[] }}
 */
function applyConnectFrameRewrites (buffer, headers = {}, decodedConnect = null, jsonPathContext = {}, options = {}) {
  if (isEmptyBuffer(buffer)) {
    return { buffer, appliedRuleIds: [], changed: false }
  }

  const loggingEnabled = options && options.loggingEnabled === true

  const compiledTextRules = getCompiledRules()
  const compiledJsonPathRulesLocal = getCompiledJsonPathRules()

  const hasTextRules = Array.isArray(compiledTextRules) && compiledTextRules.length > 0
  const hasJsonPathRules = Array.isArray(compiledJsonPathRulesLocal) && compiledJsonPathRulesLocal.length > 0

  if (!hasTextRules && !hasJsonPathRules) {
    return { buffer, appliedRuleIds: [], changed: false }
  }

  if (!hasTextRules && hasJsonPathRules) {
    const context = jsonPathContext || {}
    const candidates = []
    if (typeof context.requestUrl === 'string' && context.requestUrl) {
      candidates.push(context.requestUrl.toLowerCase())
    }
    if (typeof context.fullUrl === 'string' && context.fullUrl) {
      candidates.push(context.fullUrl.toLowerCase())
    }

    if (candidates.length > 0) {
      const anyJsonPathRuleMatchesUrl = compiledJsonPathRulesLocal.some(rule => {
        const rawPattern = typeof rule.url === 'string' ? rule.url : ''
        const trimmed = rawPattern.trim()
        if (!trimmed) return false
        const pattern = trimmed.toLowerCase()
        return candidates.some(url => url.includes(pattern) || pattern.includes(url))
      })

      if (!anyJsonPathRuleMatchesUrl) {
        return { buffer, appliedRuleIds: [], changed: false }
      }
    }
  }

  const contentType = getHeaderCaseInsensitive(headers, 'content-type') || ''
  if (!isProtoContentType(contentType) && !looksLikeConnectEnvelope(buffer)) {
    return { buffer, appliedRuleIds: [], changed: false }
  }

  const encodingHeader = (getHeaderCaseInsensitive(headers, 'content-encoding') || '').toLowerCase()
  let decodedBuffer = buffer
  let recompress

  // If we already decoded the HTTP body for Connect logging and the decoded
  // encoding matches the declared HTTP encoding, reuse that decompressed body
  // here to avoid a second HTTP-level decompression pass (including zstd).
  const decodedHttpBuffer =
    decodedConnect && Buffer.isBuffer(decodedConnect.httpDecodedBuffer)
      ? decodedConnect.httpDecodedBuffer
      : null
  const canReuseDecodedHttpBody =
    decodedConnect &&
    decodedConnect.httpDecompressed === true &&
    typeof decodedConnect.httpEncoding === 'string' &&
    decodedConnect.httpEncoding.toLowerCase() === encodingHeader &&
    (decodedHttpBuffer || typeof decodedConnect.rawBase64 === 'string')

  if (canReuseDecodedHttpBody && encodingHeader && encodingHeader !== 'identity') {
    try {
      if (decodedHttpBuffer) {
        decodedBuffer = decodedHttpBuffer
      } else {
        decodedBuffer = Buffer.from(decodedConnect.rawBase64, 'base64')
      }

      if (encodingHeader === 'gzip' || encodingHeader === 'x-gzip') {
        recompress = data => zlib.gzipSync(data)
      } else if (encodingHeader === 'deflate') {
        recompress = data => zlib.deflateSync(data)
      } else if (encodingHeader === 'br') {
        recompress = data => zlib.brotliCompressSync(data)
      } else if (encodingHeader === 'zstd') {
        if (!zstdCodec) {
          return { buffer, appliedRuleIds: [], changed: false }
        }
        recompress = data => zstdCodec.compress(data)
      } else {
        return { buffer, appliedRuleIds: [], changed: false }
      }
    } catch (error) {
      return { buffer, appliedRuleIds: [], changed: false }
    }
  } else if (encodingHeader && encodingHeader !== 'identity') {
    try {
      if (encodingHeader === 'gzip' || encodingHeader === 'x-gzip') {
        decodedBuffer = zlib.gunzipSync(buffer)
        recompress = data => zlib.gzipSync(data)
      } else if (encodingHeader === 'deflate') {
        decodedBuffer = zlib.inflateSync(buffer)
        recompress = data => zlib.deflateSync(data)
      } else if (encodingHeader === 'br') {
        decodedBuffer = zlib.brotliDecompressSync(buffer)
        recompress = data => zlib.brotliCompressSync(data)
      } else if (encodingHeader === 'zstd') {
        if (!zstdCodec) {
          return { buffer, appliedRuleIds: [], changed: false }
        }
        decodedBuffer = Buffer.from(zstdDecompress(buffer))
        recompress = data => zstdCodec.compress(data)
      } else {
        return { buffer, appliedRuleIds: [], changed: false }
      }
    } catch (error) {
      return { buffer, appliedRuleIds: [], changed: false }
    }
  }

  const connectEncodingHeader =
    getHeaderCaseInsensitive(headers, 'connect-content-encoding') ||
    getHeaderCaseInsensitive(headers, 'connect-encoding') ||
    getHeaderCaseInsensitive(headers, 'grpc-encoding') ||
    ''
  const connectCodec = getCompressionCodec(connectEncodingHeader)

  const maxFrames = CONNECT_MAX_FRAMES_LIMIT
  const maxFrameBytes = CONNECT_MAX_FRAME_BYTES_LIMIT

  const attemptEnvelopeRewrite = (inputBuffer) => {
    if (inputBuffer.length < 5) {
      return { buffer: inputBuffer, appliedRuleIds: [], changed: false, success: false }
    }

    let offset = 0
    const frames = []
    let envelopeValid = true

    while (offset + 5 <= inputBuffer.length) {
      const flags = inputBuffer.readUInt8(offset)
      const length = inputBuffer.readUInt32BE(offset + 1)
      offset += 5

      if (length < 0 || offset + length > inputBuffer.length) {
        envelopeValid = false
        break
      }

      frames.push({
        flags,
        data: inputBuffer.slice(offset, offset + length)
      })

      offset += length
    }

    if (!envelopeValid || offset !== inputBuffer.length || frames.length === 0) {
      return { buffer: inputBuffer, appliedRuleIds: [], changed: false, success: false }
    }

    let changed = false
    const appliedSet = new Set()
    const updatedFrames = []

    frames.forEach((frame, index) => {
      const isCompressed = (frame.flags & 0x01) === 0x01
      const isEndStream = (frame.flags & 0x02) === 0x02
      let framePayload = frame.data
      let needsRecompress = false

      const withinFrameLimit = index < maxFrames
      const withinSizeLimit = frame.data.length <= maxFrameBytes

      if (!withinFrameLimit || !withinSizeLimit) {
        updatedFrames.push({
          index,
          flags: frame.flags,
          data: frame.data,
          length: frame.data.length,
          compressed: isCompressed,
          endStream: isEndStream,
          frameDecompressed: false,
          preview: '',
          json: null
        })
        return
      }

      if (isCompressed) {
        let reusedDecodedPayload = false

        // When decodeConnectPayload has already decompressed individual
        // Connect frames for logging, reuse that decoded payload instead of
        // decompressing the frame a second time here. This avoids extra
        // zlib/zstd work while keeping the rewrite semantics unchanged.
        if (decodedConnect && decodedConnect.envelope && Array.isArray(decodedConnect.frames)) {
          const decodedFrame = decodedConnect.frames[index]
          if (decodedFrame && decodedFrame.frameDecompressed && typeof decodedFrame.dataBase64 === 'string') {
            try {
              framePayload = Buffer.from(decodedFrame.dataBase64, 'base64')
              needsRecompress = true
              reusedDecodedPayload = true
            } catch (error) {
              // Fall through to the normal decompression path below
            }
          }
        }

        if (!reusedDecodedPayload) {
          if (!connectCodec) {
            updatedFrames.push({
              index,
              flags: frame.flags,
              data: frame.data,
              length: frame.data.length,
              compressed: true,
              endStream: isEndStream,
              preview: '',
              json: null
            })
            return
          }
          try {
            framePayload = connectCodec.decompress(frame.data)
            needsRecompress = true
          } catch (error) {
            updatedFrames.push({
              index,
              flags: frame.flags,
              data: frame.data,
              length: frame.data.length,
              compressed: true,
              endStream: isEndStream,
              preview: '',
              json: null
            })
            return
          }
        }
      }

      let outputBuffer = frame.data
      let preview = ''
      let parsedJson = null

      // Step 1: apply legacy text-based edit rules (headers/inline text).
      const textRewriter = text => applyEditRulesToText(text, jsonPathContext || {})

      const rewriteResult = rewriteProtobufFields(framePayload, textRewriter)

      let baseBuffer = framePayload
      if (rewriteResult.changed) {
        baseBuffer = rewriteResult.buffer
      }

      // Step 2: apply JSONPath rules scoped by URL directly to the protobuf
      // payload for simple JSON fields. This allows rules like "root.f2" to
      // affect the actual Connect payload, not just the logged JSON.
      const jsonPathResult = applyJsonPathRulesToProtobufBuffer(
        baseBuffer,
        null,
        jsonPathContext || {}
      )

      const finalBufferUncompressed = jsonPathResult.changed ? jsonPathResult.buffer : baseBuffer

      // Recompress if needed for this frame
      try {
        outputBuffer = needsRecompress ? connectCodec.compress(finalBufferUncompressed) : finalBufferUncompressed
      } catch (error) {
        // Fall back to original compressed data if recompression fails
        outputBuffer = frame.data
      }

      // Build preview/JSON from the uncompressed buffer so the UI sees the
      // same content that is actually sent over the wire. This is only
      // required when interactive logging is enabled; rewrite-only paths
      // can skip this extra decoding/parsing work.
      if (loggingEnabled) {
        preview = bufferToTextPreview(finalBufferUncompressed)
        parsedJson = tryParseJsonString(preview)
        if (parsedJson === null) {
          parsedJson = extractJsonFromProtobufBuffer(finalBufferUncompressed)
        }
      }

      if (rewriteResult.changed && Array.isArray(rewriteResult.appliedRuleIds)) {
        rewriteResult.appliedRuleIds.forEach(id => appliedSet.add(id))
        changed = true
      }

      if (jsonPathResult.changed && Array.isArray(jsonPathResult.appliedRuleIds)) {
        jsonPathResult.appliedRuleIds.forEach(id => appliedSet.add(id))
        changed = true
      }

      updatedFrames.push({
        index,
        flags: frame.flags,
        data: outputBuffer,
        length: outputBuffer.length,
        compressed: isCompressed,
        endStream: isEndStream,
        frameDecompressed: needsRecompress,
        preview,
        json: parsedJson
      })
    })

    if (!changed) {
      return {
        buffer: inputBuffer,
        appliedRuleIds: [],
        changed: false,
        success: true,
        updatedFrames
      }
    }

    const rebuiltBuffer = rebuildConnectEnvelope(updatedFrames)
    return {
      buffer: rebuiltBuffer,
      appliedRuleIds: Array.from(appliedSet),
      changed: true,
      success: true,
      updatedFrames
    }
  }

  const envelopeResult = attemptEnvelopeRewrite(decodedBuffer)
  let workingBuffer = envelopeResult.buffer
  const appliedSet = new Set(envelopeResult.appliedRuleIds || [])
  const updatedFrames = envelopeResult.updatedFrames
  let changed = envelopeResult.changed

  if (!changed) {
    let unaryBuffer = workingBuffer
    let unaryNeedsRecompress = false

    if (connectCodec) {
      try {
        unaryBuffer = connectCodec.decompress(workingBuffer)
        unaryNeedsRecompress = true
      } catch (error) {
        unaryBuffer = workingBuffer
        unaryNeedsRecompress = false
      }
    }

    const fallbackResult = applyEditRulesToBuffer(unaryBuffer, jsonPathContext || {})
    if (fallbackResult.changed) {
      let updatedBuffer = fallbackResult.buffer

      if (unaryNeedsRecompress) {
        try {
          updatedBuffer = connectCodec.compress(updatedBuffer)
        } catch (error) {
          logDebug('applyConnectFrameRewrites', 'Failed to recompress unary Connect body after text rewrites', error)
          updatedBuffer = null
        }
      }

      if (updatedBuffer) {
        workingBuffer = updatedBuffer
        fallbackResult.appliedRuleIds.forEach(id => appliedSet.add(id))
        changed = true
      }
    }
  }

  if (!changed) {
    return { buffer, appliedRuleIds: [], changed: false }
  }

  let finalBuffer = workingBuffer
  let finalEncoding = encodingHeader || ''
  if (recompress) {
    try {
      finalBuffer = recompress(workingBuffer)
    } catch (error) {
      logDebug('applyConnectFrameRewrites', 'Failed to recompress updated Connect payload', error)
      return { buffer, appliedRuleIds: [], changed: false }
    }
  } else {
    finalEncoding = ''
  }

  return {
    buffer: finalBuffer,
    appliedRuleIds: Array.from(appliedSet),
    changed: true,
    encoding: finalEncoding,
    updatedFrames
  }
}

/**
 * Apply text edit rules to a WebSocket payload that has already been
 * normalised into a Buffer by higher-level helpers.
 *
 * Binary frames are passed through unchanged; for text frames this will
 * optionally rewrite the UTF-8 content according to the active text rules
 * while preserving the original byte-level framing.
 *
 * @param {Buffer} payloadBuffer - Normalised WebSocket payload buffer.
 * @param {boolean} isBinary - Whether the frame is binary.
 * @returns {{ buffer: Buffer, appliedRuleIds: string[], changed: boolean }}
 */
function rewriteWebSocketPayload (payloadBuffer, isBinary, context) {
  if (!payloadBuffer || !Buffer.isBuffer(payloadBuffer) || payloadBuffer.length === 0) {
    const emptyBuffer = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.alloc(0)
    return { buffer: emptyBuffer, appliedRuleIds: [], changed: false }
  }

  if (isBinary) {
    return { buffer: payloadBuffer, appliedRuleIds: [], changed: false }
  }

  // Avoid attempting text rewrites on obviously binary WebSocket frames, even
  // when they are reported as non-binary.
  const wsPrintableRatio = printableRatio(payloadBuffer)
  if (wsPrintableRatio < 0.3) {
    return { buffer: payloadBuffer, appliedRuleIds: [], changed: false }
  }

  let text
  try {
    text = payloadBuffer.toString('utf8')
  } catch (error) {
    logDebug('rewriteWebSocketPayload', 'Failed to decode WebSocket payload as UTF‑8', error)
    return { buffer: payloadBuffer, appliedRuleIds: [], changed: false }
  }

  const rewriteResult = applyEditRulesToText(text, context)
  if (!rewriteResult.changed) {
    return { buffer: payloadBuffer, appliedRuleIds: [], changed: false }
  }

  return {
    buffer: Buffer.from(rewriteResult.text, 'utf8'),
    appliedRuleIds: rewriteResult.appliedRuleIds,
    changed: true
  }
}

/**
 * Apply text edit rules to a WebSocket payload and build a human-readable body
 * description for logging. The payload is normalised to a Buffer, optionally
 * rewritten (for text frames) and then decoded once as UTF‑8 for logging.
 *
 * Binary frames are never rewritten and are represented by a size-only
 * placeholder string.
 *
 * @param {Buffer|string|any} payload
 * @param {boolean} isBinary
 * @returns {{ buffer: Buffer, rewrites: string[]|null, body: string }}
 */
function applyWebSocketRewritesAndDescribe (payload, isBinary, context) {
  let payloadBuffer = normalizeWebSocketPayload(payload)

  let rewrites = null
  let originalBody = null

  const tooLargeTextFrame =
    !isBinary &&
    WS_MAX_TEXT_BYTES > 0 &&
    payloadBuffer.length > WS_MAX_TEXT_BYTES

  // Only attempt rewrites on reasonably-sized text frames when we have
  // compiled rules. This avoids decoding and scanning frames when edit rules
  // or JSONPath rules are disabled.
  if (!isBinary && !tooLargeTextFrame) {
    const compiledTextRules = getCompiledRules()
    const compiledJsonPathRulesLocal = getCompiledJsonPathRules()

    const hasTextRules = Array.isArray(compiledTextRules) && compiledTextRules.length > 0
    const hasJsonPathRules = Array.isArray(compiledJsonPathRulesLocal) && compiledJsonPathRulesLocal.length > 0

    // Capture the original textual payload (before any rewrites) so that the
    // UI can render a true "before rewrite" preview for WebSocket messages.
    try {
      originalBody = payloadBuffer.toString('utf8')
    } catch (error) {
      logDebug('applyWebSocketRewritesAndDescribe', 'Failed to decode original WebSocket payload as UTF‑8', error)
      originalBody = null
    }

    // 1) Apply legacy text rules over the WebSocket frame payload.
    if (hasTextRules) {
      const rewriteResult = rewriteWebSocketPayload(payloadBuffer, false, context)
      if (rewriteResult && Buffer.isBuffer(rewriteResult.buffer)) {
        if (rewriteResult.changed) {
          payloadBuffer = rewriteResult.buffer
        }

        if (Array.isArray(rewriteResult.appliedRuleIds) && rewriteResult.appliedRuleIds.length) {
          rewrites = Array.isArray(rewrites) ? rewrites : []
          for (const id of rewriteResult.appliedRuleIds) {
            if (!id) continue
            if (!rewrites.includes(id)) rewrites.push(id)
          }
        }
      }
    }

    // 2) Apply JSONPath rules when the frame body contains JSON and rules are
    // configured for the current URL/phase context.
    if (hasJsonPathRules) {
      let textForJson = null

      try {
        textForJson = payloadBuffer.toString('utf8')
      } catch (error) {
        logDebug('applyWebSocketRewritesAndDescribe', 'Failed to decode WebSocket payload as UTF‑8 for JSONPath', error)
      }

      if (typeof textForJson === 'string') {
        // WebSocket payloads (especially Socket.IO) often prefix JSON with an
        // envelope like "42/ws/character," or "0". To support JSONPath
        // rules on these frames, locate the first JSON structure character and
        // parse only that tail while preserving the original prefix.

        const firstBrace = textForJson.indexOf('{')
        const firstBracket = textForJson.indexOf('[')

        const jsonStartIndex =
          firstBrace === -1
            ? firstBracket
            : firstBracket === -1
              ? firstBrace
              : Math.min(firstBrace, firstBracket)

        if (jsonStartIndex !== -1) {
          const prefix = textForJson.slice(0, jsonStartIndex)
          const jsonText = textForJson.slice(jsonStartIndex)

          try {
            const parsed = JSON.parse(jsonText)

            const jsonPathContext = {
              ...(context && typeof context === 'object' ? context : {}),
              phase: context && typeof context.phase === 'string' ? context.phase : 'request'
            }

            const jsonResult = applyJsonPathRulesToObject(parsed, jsonPathContext)
            if (jsonResult && jsonResult.changed) {
              const updatedObject = jsonResult.object
              const updatedText = prefix + JSON.stringify(updatedObject)
              payloadBuffer = Buffer.from(updatedText, 'utf8')

              if (Array.isArray(jsonResult.appliedRuleIds) && jsonResult.appliedRuleIds.length) {
                rewrites = Array.isArray(rewrites) ? rewrites : []
                for (const id of jsonResult.appliedRuleIds) {
                  if (!id) continue
                  if (!rewrites.includes(id)) rewrites.push(id)
                }
              }
            }
          } catch (error) {
            logDebug('applyWebSocketRewritesAndDescribe', 'Failed to parse WebSocket JSON payload for JSONPath', error)
          }
        }
      }
    }
  }

  let body
  if (isBinary) {
    body = `[Binary data: ${payloadBuffer.length} bytes]`
  } else if (tooLargeTextFrame) {
    body = `[WebSocket text frame too large for rewrite: ${payloadBuffer.length} bytes, limit=${WS_MAX_TEXT_BYTES}]`
  } else {
    // Single UTF‑8 decode shared between rewrites and logging.
    body = payloadBuffer.toString('utf8')
  }

  return { buffer: payloadBuffer, rewrites, body, originalBody }
}

/**
 * Normalize a WebSocket payload into a Buffer, regardless of whether it
 * arrived as a Buffer, string or other binary-like value.
 *
 * @param {Buffer|string|any} data
 * @returns {Buffer}
 */
function normalizeWebSocketPayload (data) {
  if (Buffer.isBuffer(data)) return data
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (data == null) return Buffer.alloc(0)
  return Buffer.from(data)
}

/**
 * Attempt to extract and parse a JSON payload from a WebSocket text frame.
 *
 * This mirrors the Socket.IO normalisation that previously lived in the
 * frontend so that WebSocket logs already contain structured JSON suitable
 * for before/after previews. It understands frames such as
 * "42/ws/namespace,[\"event\",{...}]" or "0{...}", stripping the numeric
 * engine.io code and optional namespace/path prefix before calling
 * JSON.parse.
 *
 * Non-JSON bodies (binary markers, oversized-frame markers, etc.) yield
 * null so that the caller can gracefully fall back to a raw string view.
 *
 * @param {string} text
 * @returns {any|null}
 */
function tryParseWebSocketJson (text) {
  if (!text || typeof text !== 'string') return null

  // Skip placeholder bodies that are clearly not JSON payloads.
  if (
    text.startsWith('[Binary data:') ||
    text.startsWith('[WebSocket text frame too large') ||
    text.startsWith('[WS ') ||
    text.startsWith('[WebSocket text frame decode error:')
  ) {
    return null
  }

  let body = text

  // Drop leading engine.io numeric code(s), e.g. "42" or "0".
  let i = 0
  while (i < body.length && body.charCodeAt(i) >= 48 && body.charCodeAt(i) <= 57) {
    i += 1
  }
  if (i > 0) {
    body = body.slice(i)
  }

  // Drop Socket.IO namespace/path prefix like "/ws/character,".
  if (body.startsWith('/')) {
    const commaIndex = body.indexOf(',')
    if (commaIndex > 0 && commaIndex + 1 < body.length) {
      body = body.slice(commaIndex + 1)
    }
  }

  try {
    return JSON.parse(body)
  } catch (error) {
    logDebug('tryParseWebSocketJson', 'Failed to parse WebSocket JSON payload for logging', error)
    return null
  }
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
 * @param {Object} params
 * @param {'server->client'|'client->server'} params.direction
 * @param {string} params.wsUrl
 * @param {number} params.connectionId
 * @param {Buffer} params.payloadBuffer
 * @param {boolean} params.isBinary
 * @param {string|null} [params.bodyText]
 * @param {string[]|null} [params.rewrites]
 * @param {boolean} [params.loggingDisabled]
 * @param {string} [params.originalBodyText]
 */
function logWebSocketMessage ({
  direction,
  wsUrl,
  connectionId,
  payloadBuffer,
  isBinary,
  bodyText,
  rewrites,
  loggingDisabled = false,
  originalBodyText
}) {
  if (!interactiveModeEnabled) return

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
    attachRewriteMetadata(messageLog, appliedRuleIds)
  }

  if (typeof originalBodyText === 'string' && originalBodyText.length > 0) {
    messageLog.originalBody = originalBodyText
  }

  // For text frames where we logged the actual payload string, attempt to
  // derive structured JSON snapshots for before/after previews so the
  // frontend can remain a pure rendering layer.
  if (!isBinary && !loggingDisabled && typeof body === 'string') {
    const afterJson = tryParseWebSocketJson(body)
    if (afterJson !== null) {
      messageLog.wsBodyJsonAfter = afterJson
    }

    if (typeof originalBodyText === 'string' && originalBodyText.length > 0) {
      const beforeJson = tryParseWebSocketJson(originalBodyText)
      if (beforeJson !== null) {
        messageLog.wsBodyJsonBefore = beforeJson
      }
    }
  }

  addLog(messageLog)
}

// Content-types we bother to decompress for preview/logging
const DECOMPRESS_ALLOWED_TYPES = [
  'json',
  'text/',
  'javascript',
  'xml',
  '+json',
  'x-www-form-urlencoded',
  'application/graphql',
  'application/grpc',
  'application/connect+proto',
  'application/proto'
]

function shouldDecompress (contentType) {
  if (!contentType) return false
  const lower = contentType.toLowerCase()
  return DECOMPRESS_ALLOWED_TYPES.some(token => lower.includes(token))
}

// Decompress response data when beneficial for analysis
function decompressData (buffer, encoding, contentType) {
  if (!buffer || buffer.length === 0) return buffer
  if (!shouldDecompress(contentType)) return buffer

  try {
    if (!encoding || encoding === 'identity') {
      return buffer
    }

    if (encoding === 'gzip' || encoding === 'x-gzip') {
      return zlib.gunzipSync(buffer)
    } else if (encoding === 'deflate') {
      return zlib.inflateSync(buffer)
    } else if (encoding === 'br') {
      return zlib.brotliDecompressSync(buffer)
    } else if (encoding === 'zstd') {
      return Buffer.from(zstdDecompress(buffer))
    }

    return buffer
  } catch (error) {
    logDebug('decompressData', `Failed to decompress buffer (encoding=${encoding || 'identity'})`, error)
    return buffer
  }
}

// Decompression helper used only for logging/preview paths. It honours the
// LOG_DECOMPRESS_MAX_BYTES safeguard so that we avoid fully decompressing
// very large compressed bodies purely for UI previews.
function decompressDataForLogging (buffer, encoding, contentType) {
  if (!buffer || buffer.length === 0) return buffer

  if (LOG_DECOMPRESS_MAX_BYTES > 0 && buffer.length > LOG_DECOMPRESS_MAX_BYTES) {
    return buffer
  }

  return decompressData(buffer, encoding, contentType)
}

/**
 * Return true when the provided value is not a non-empty Buffer.
 *
 * Centralises the common guard pattern used throughout the proxy pipeline to
 * early-return when there is no usable body buffer.
 *
 * @param {any} buffer
 * @returns {boolean}
 */
function isEmptyBuffer (buffer) {
  return !buffer || !Buffer.isBuffer(buffer) || buffer.length === 0
}

function getCompressionCodec (encoding = '') {
  if (!encoding || encoding === 'identity') return null
  const normalized = encoding.toLowerCase()

  if (normalized === 'gzip' || normalized === 'x-gzip') {
    return {
      decompress: data => zlib.gunzipSync(data),
      compress: data => zlib.gzipSync(data)
    }
  }

  if (normalized === 'deflate') {
    return {
      decompress: data => zlib.inflateSync(data),
      compress: data => zlib.deflateSync(data)
    }
  }

  if (normalized === 'br') {
    return {
      decompress: data => zlib.brotliDecompressSync(data),
      compress: data => zlib.brotliCompressSync(data)
    }
  }

  if (normalized === 'zstd') {
    if (!zstdCodec) return null
    return {
      decompress: data => Buffer.from(zstdDecompress(data)),
      compress: data => zstdCodec.compress(data)
    }
  }

  return null
}

/**
 * Rewrite a plain HTTP JSON body using JSONPath rules while handling optional
 * HTTP compression transparently.
 *
 * The helper:
 * - recognises `application/json` content type;
 * - optionally decompresses the body using decompressData when an encoding is
 *   present;
 * - parses the JSON payload and applies JSONPath rules via
 *   applyJsonPathRulesToObject using the provided URL/phase context;
 * - when rules change the object, re-encodes it as JSON and, if necessary,
 *   recompresses it using getCompressionCodec.
 *
 * Behaviour is kept aligned with the previous inlined implementations in both
 * the Express proxy and the HTTPS MITM request path.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - Raw HTTP body buffer (compressed or not).
 * @param {string} [params.encoding] - Content-Encoding header value.
 * @param {string} [params.contentType] - Content-Type header value.
 * @param {{requestUrl?: string, fullUrl?: string}} [params.urlContext] - URL context.
 * @param {('request'|'response')} [params.phase] - JSONPath phase, defaults to 'request'.
 * @returns {{
 *   buffer: Buffer,
 *   json: any,
 *   appliedRuleIds: string[],
 *   changed: boolean,
 *   decompressed: Buffer|null
 * }}
 */
function rewriteJsonHttpBody ({
  buffer,
  encoding = '',
  contentType = '',
  urlContext = {},
  phase = 'request'
} = {}) {
  if (isEmptyBuffer(buffer)) {
    return { buffer, json: null, appliedRuleIds: [], changed: false, decompressed: null }
  }

  const lowerType = typeof contentType === 'string' ? contentType.toLowerCase() : ''
  if (!lowerType.includes('application/json')) {
    return { buffer, json: null, appliedRuleIds: [], changed: false, decompressed: null }
  }

  const normalizedEncoding = typeof encoding === 'string' ? encoding.toLowerCase() : ''
  const needsDecompress = normalizedEncoding && normalizedEncoding !== 'identity'
  let decompressed = needsDecompress
    ? decompressData(buffer, normalizedEncoding, contentType)
    : null

  const bufferForJson = decompressed || buffer

  let parsed
  try {
    parsed = JSON.parse(bufferForJson.toString('utf8'))
  } catch (error) {
    // Malformed JSON – surface to callers via a null json field while keeping
    // the original buffer so that logging can still fall back to text.
    return { buffer, json: null, appliedRuleIds: [], changed: false, decompressed }
  }

  const jsonPathContext = {
    ...(urlContext || {}),
    phase
  }

  const jsonPathResult = applyJsonPathRulesToObject(parsed, jsonPathContext)
  if (!jsonPathResult || !jsonPathResult.changed) {
    return {
      buffer,
      json: jsonPathResult ? jsonPathResult.object : parsed,
      appliedRuleIds: jsonPathResult ? (jsonPathResult.appliedRuleIds || []) : [],
      changed: false,
      decompressed
    }
  }

  const updatedObject = jsonPathResult.object
  const updatedDecoded = Buffer.from(JSON.stringify(updatedObject), 'utf8')

  let nextBuffer = buffer
  if (decompressed) {
    const codec = getCompressionCodec(normalizedEncoding)
    if (codec) {
      try {
        nextBuffer = codec.compress(updatedDecoded)
      } catch (error) {
        // If recompression fails, fall back to the original body.
        nextBuffer = buffer
      }
    }
    // Even if recompression fails, keep decompressed preview up to date.
    decompressed = updatedDecoded
  } else {
    nextBuffer = updatedDecoded
  }

  return {
    buffer: nextBuffer,
    json: updatedObject,
    appliedRuleIds: jsonPathResult.appliedRuleIds || [],
    changed: true,
    decompressed
  }
}

/**
 * Apply JSONPath-based rewrites to a plain JSON HTTP request body and
 * update the associated log entry (body, preview, rewrite metadata).
 *
 * This helper centralises the common pattern used by both the main
 * Express proxy pipeline and the HTTPS MITM pipeline when dealing with
 * non-Connect JSON request bodies.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - Raw HTTP request body buffer.
 * @param {Object} params.headers - Request headers.
 * @param {string} params.requestUrl - Request URL/path as seen by the proxy.
 * @param {string} params.fullUrl - Fully-qualified URL when available.
 * @param {Object} params.logEntry - Mutable log entry to enrich.
 * @returns {{ buffer: Buffer }} Updated body buffer.
 */
function applyJsonRequestRewritesForLog ({
  buffer,
  headers,
  requestUrl,
  fullUrl,
  logEntry
}, options = {}) {
  if (isEmptyBuffer(buffer)) {
    return { buffer }
  }

  const { logNonJsonBody = false } = options || {}

  const encoding = getHeaderCaseInsensitive(headers, 'content-encoding') || ''
  const contentType = getHeaderCaseInsensitive(headers, 'content-type') || ''
  const isJsonContentType = typeof contentType === 'string' && contentType.toLowerCase().includes('application/json')

  const jsonRewrite = rewriteJsonHttpBody({
    buffer,
    encoding,
    contentType,
    urlContext: { requestUrl, fullUrl },
    phase: 'request'
  })

  let nextBuffer = buffer

  if (jsonRewrite.changed && Buffer.isBuffer(jsonRewrite.buffer)) {
    nextBuffer = jsonRewrite.buffer
  }

  if (logEntry && jsonRewrite.json !== null && jsonRewrite.json !== undefined) {
    // For HTTP JSON requests, store the parsed object directly on the log
    // entry so that the frontend can render structured JSON without having to
    // re-parse the body string.
    logEntry.body = jsonRewrite.json
    logEntry.requestBodyJson = jsonRewrite.json
  }

  const previewSource = jsonRewrite.decompressed || nextBuffer
  if (logEntry) {
    const preview = bufferToTextPreview(previewSource)
    if (preview) {
      logEntry.rawRequestBodyPreview = preview
    }

    if (Array.isArray(jsonRewrite.appliedRuleIds) && jsonRewrite.appliedRuleIds.length) {
      attachRewriteMetadata(logEntry, jsonRewrite.appliedRuleIds)
    }
  }

  // Fallback for malformed JSON bodies advertised as application/json:
  // keep a textual representation in the log when parsing failed.
  if (logEntry && !logEntry.body && isJsonContentType) {
    try {
      const fallbackText = preview || previewSource.toString('utf8')
      if (fallbackText) {
        logEntry.body = fallbackText
      }
    } catch {}
  }

  // Optional fallback for non-JSON content-types in contexts (such as HTTPS
  // MITM) where it is still useful to retain a textual representation of the
  // request body in logs.
  if (logEntry && !logEntry.body && logNonJsonBody && !isJsonContentType) {
    try {
      const fallbackText = preview || previewSource.toString('utf8')
      if (fallbackText) {
        logEntry.body = fallbackText
      }
    } catch {}
  }

  return { buffer: nextBuffer }
}

const PROTO_CONTENT_TYPES = [
  'application/proto',
  'application/grpc',
  'application/grpc+proto',
  'application/connect+proto'
]

function isProtoContentType (contentType = '') {
  if (!contentType) return false
  const normalized = contentType.toLowerCase()
  return PROTO_CONTENT_TYPES.some(type => normalized.includes(type))
}

/**
 * Determine whether a content-type is clearly binary and should never be
 * decoded as text for logging or Connect/HTTP previews.
 *
 * @param {string} contentType
 * @returns {boolean}
 */
function isClearlyBinaryContentType (contentType = '') {
  if (!contentType) return false
  const lower = contentType.toLowerCase()
  return (
    lower.includes('font/') ||
    lower.includes('woff') ||
    lower.includes('image/') ||
    lower.includes('video/') ||
    lower.includes('audio/') ||
    lower.includes('octet-stream')
  )
}

function applyLogPreviewLimit (text) {
  if (!text) return ''
  if (!Number.isFinite(LOG_PREVIEW_MAX_BYTES) || LOG_PREVIEW_MAX_BYTES <= 0) {
    return text
  }

  if (text.length <= LOG_PREVIEW_MAX_BYTES) {
    return text
  }

  const truncated = text.slice(0, LOG_PREVIEW_MAX_BYTES)
  const omitted = text.length - LOG_PREVIEW_MAX_BYTES

  return `${truncated}\n[preview truncated: ${omitted} chars not shown]`
}

/**
 * Maximum size for precomputed search snapshots such as
 * requestSearchContent/responseSearchContent and header snapshots. This
 * guards against very large strings for huge bodies or many frames.
 *
 * The limit is intentionally generous to preserve useful searchability while
 * avoiding unbounded CPU and memory usage when building and storing
 * snapshots.
 */
const SEARCH_SNAPSHOT_MAX_BYTES = 256 * 1024

/**
 * Build a lower-cased search snapshot from a list of string parts, applying
 * a maximum size guard. When the concatenated content exceeds the limit, a
 * short placeholder is returned instead.
 *
 * @param {string[]} parts
 * @returns {string} lower-cased snapshot or an empty string
 */
function buildSearchSnapshot (parts) {
  if (!Array.isArray(parts) || parts.length === 0) return ''

  const joined = parts
    .filter(part => typeof part === 'string' && part)
    .join('\n')

  if (!joined) return ''

  const lower = joined.toLowerCase()

  if (!Number.isFinite(SEARCH_SNAPSHOT_MAX_BYTES) || SEARCH_SNAPSHOT_MAX_BYTES <= 0) {
    return lower
  }

  if (lower.length <= SEARCH_SNAPSHOT_MAX_BYTES) {
    return lower
  }

  const truncated = lower.slice(0, SEARCH_SNAPSHOT_MAX_BYTES)
  const omitted = lower.length - SEARCH_SNAPSHOT_MAX_BYTES

  return `${truncated}\n[search snapshot truncated: ${omitted} chars omitted]`
}

/**
 * Convenience helper to build a size-limited, lower-cased search snapshot
 * from a JSON-serializable object (typically headers).
 *
 * @param {any} value
 * @returns {string} search snapshot or an empty string
 */
function buildJsonSearchSnapshot (value) {
  if (!value) return ''

  let jsonString
  try {
    jsonString = JSON.stringify(value)
  } catch (error) {
    return ''
  }

  return buildSearchSnapshot([jsonString])
}

/**
 * Ensure request/response body and header search snapshots are populated on a
 * log entry. This centralises snapshot construction so that addLog and
 * filterLogsCore share the same logic.
 *
 * @param {object} log
 */
function ensureLogSearchSnapshots (log) {
  if (!log || typeof log !== 'object') return

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
      const requestRawPreview = typeof log.rawRequestBodyPreview === 'string' ? log.rawRequestBodyPreview : ''

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
      const responseRawPreview = typeof log.rawResponseBodyPreview === 'string' ? log.rawResponseBodyPreview : ''

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
 * Build a size-limited UTF-8 preview string from a Buffer for logging/search.
 *
 * The preview length is bounded using LOG_PREVIEW_MAX_BYTES so that very large
 * bodies do not require decoding the entire payload.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function bufferToTextPreview (buffer) {
  if (!buffer || buffer.length === 0) return ''

  let source = buffer
  if (Number.isFinite(LOG_PREVIEW_MAX_BYTES) && LOG_PREVIEW_MAX_BYTES > 0) {
    const maxDecodeBytes = LOG_PREVIEW_MAX_BYTES * 4
    if (buffer.length > maxDecodeBytes) {
      source = buffer.slice(0, maxDecodeBytes)
    }
  }

  const text = source.toString('utf8')
  if (!text.trim()) return ''

  const printable = text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
  const ratio = printable.length / text.length

  let result = ''

  if (ratio >= 0.85) {
    result = text
  } else if (ratio >= 0.35 && printable.trim()) {
    result = printable.trim()
  } else {
    const asciiSegments = printable.match(/[\x20-\x7E]{4,}/g)
    if (asciiSegments && asciiSegments.length) {
      result = asciiSegments.join('\n')
    }
  }

  if (!result) return ''

  return applyLogPreviewLimit(result)
}

/**
 * Try to parse a string (or a substring) as JSON for logging purposes.
 * This scans for top-level object/array candidates and logs at most one
 * parse failure per invocation in debug mode.
 *
 * @param {string} text
 * @returns {any|null}
 */
function tryParseJsonString (text) {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed) return null

  const candidates = [trimmed]

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  const firstBracket = trimmed.indexOf('[')
  const lastBracket = trimmed.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1))
  }

  let loggedFailure = false

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch (error) {
      if (!loggedFailure) {
        logDebug('tryParseJsonString', 'Failed to parse JSON candidate', error)
        loggedFailure = true
      }
    }
  }

  return null
}

/**
 * Build a textual body and preview for HTTP/HTTPS responses for logging.
 *
 * This helper is shared between the plain HTTP proxy pipeline and the HTTPS
 * MITM pipeline. It keeps the existing conservative behaviour for
 * Connect/protobuf payloads:
 * - Envelope-style Connect responses rely on structured Connect logging and
 *   do not produce a separate textual body.
 * - Callers can opt in to UTF-8 decoding for unary (non-envelope) Connect
 *   responses via the allowUnaryConnectText flag.
 *
 * @param {Object} params
 * @param {Object} params.logEntry - Log entry object to mutate (previews).
 * @param {Buffer} params.buffer - Final response buffer after rewrites.
 * @param {string} params.contentType - HTTP Content-Type header value.
 * @param {string} params.contentEncoding - HTTP Content-Encoding header value.
 * @param {boolean} params.isBinary - Whether the content-type is considered binary.
 * @param {Object|null} [params.connectResponse] - Optional Connect decode view.
 * @param {boolean} [params.allowUnaryConnectText=false] - Allow UTF-8 decoding
 * for unary Connect responses while still avoiding envelope-style streams.
 * @returns {{ body: string }}
 */
function buildHttpResponseLoggingView ({
  logEntry,
  buffer,
  contentType,
  contentEncoding,
  isBinary,
  connectResponse,
  allowUnaryConnectText = false
}) {
  if (isEmptyBuffer(buffer)) {
    return { body: '' }
  }

  let dataToLog = buffer

  if (contentEncoding && !isBinary) {
    const decompressed = decompressDataForLogging(buffer, contentEncoding, contentType)
    if (decompressed && Buffer.isBuffer(decompressed)) {
      dataToLog = decompressed
    }
  }

  if (!connectResponse && dataToLog.length) {
    const decompressedPreview = bufferToTextPreview(dataToLog)
    if (decompressedPreview && !logEntry.rawResponseBodyPreview) {
      logEntry.rawResponseBodyPreview = decompressedPreview
    }
  }

  let responseBody = ''
  let responseBodyJson = null

  const hasConnect = !!connectResponse
  const isEnvelope = hasConnect && !!connectResponse.envelope
  const allowConnectText =
    !hasConnect || (allowUnaryConnectText && hasConnect && !isEnvelope)

  const lowerType = typeof contentType === 'string' ? contentType.toLowerCase() : ''

  // Treat any "*json"-like content-type (including application/manifest+json
  // and other +json variants) as textual so that we can safely log and parse
  // it for the UI.
  const shouldTryText = allowConnectText && !isBinary && (
    lowerType.includes('json') ||
    lowerType.includes('text/') ||
    lowerType.includes('javascript') ||
    (contentEncoding && dataToLog !== buffer)
  )

  if (shouldTryText) {
    try {
      responseBody = dataToLog.toString('utf8')
    } catch (error) {
      responseBody = `[Binary data: ${buffer.length} bytes]`
    }
  } else if (!connectResponse && buffer.length > 0) {
    responseBody = `[Binary/Compressed data: ${buffer.length} bytes, type: ${contentType}, encoding: ${contentEncoding || 'none'}]`
  }

  // When we have a textual HTTP response body and a JSON-like content-type,
  // attempt to parse it once here so the frontend can render structured JSON
  // without re-parsing large strings.
  if (
    !hasConnect &&
    typeof responseBody === 'string' &&
    responseBody.length > 0 &&
    typeof contentType === 'string' &&
    contentType.toLowerCase().includes('json') &&
    !responseBody.startsWith('[Binary data:') &&
    !responseBody.startsWith('[Binary/Compressed data:')
  ) {
    try {
      responseBodyJson = JSON.parse(responseBody)
    } catch (error) {
      logDebug('buildHttpResponseLoggingView', 'Failed to parse HTTP JSON response for logging', error)
    }
  }

  if (logEntry && responseBodyJson && typeof responseBodyJson === 'object') {
    logEntry.responseBodyJson = responseBodyJson
  }

  return { body: responseBody }
}

/**
 * Decode a potential Connect/gRPC over HTTP payload into a structured view
 * used for interactive logging.
 *
 * The decoder:
 * - validates the content-type / envelope shape;
 * - transparently decompresses the HTTP body when needed;
 * - splits Connect envelopes into frames while enforcing CONNECT_MAX_FRAMES
 *   and CONNECT_MAX_FRAME_BYTES;
 * - extracts a small text preview and a best-effort JSON representation for
 *   each frame via extractJsonFromProtobufBuffer.
 *
 * All size limits are enforced before attempting expensive protobuf/JSON
 * work to keep CPU usage under control on large payloads.
 *
 * @param {Buffer} buffer - Raw HTTP body buffer.
 * @param {object} headers - HTTP headers associated with the body.
 * @returns {null|{
 *   contentType: string,
 *   envelope: boolean,
 *   frameCount: number,
 *   frames: Array<{
 *     index: number,
 *     length: number,
 *     compressed: boolean,
 *     endStream: boolean,
 *     frameDecompressed: boolean,
 *     preview: string,
 *     json: any,
 *     dataBase64: string|null,
 *     note: string|null
 *   }>,
 *   httpDecompressed: boolean,
 *   httpEncoding: string,
 *   rawBase64: string,
 *   httpDecodedBuffer?: Buffer
 * }>} Decoded Connect payload suitable for logging, or null if the payload
 * is not recognised as Connect/gRPC.
 */
function decodeConnectPayload (buffer, headers = {}) {
  if (isEmptyBuffer(buffer)) return null

  const contentType = getHeaderCaseInsensitive(headers, 'content-type') || ''

  if (!isProtoContentType(contentType) && !looksLikeConnectEnvelope(buffer)) {
    return null
  }

  const encodingHeader = (getHeaderCaseInsensitive(headers, 'content-encoding') || '').toLowerCase()
  let decodedBuffer = buffer
  let httpDecompressed = false
  const httpEncoding = encodingHeader || ''

  if (encodingHeader && encodingHeader !== 'identity') {
    const maybeDecoded = decompressData(buffer, encodingHeader, contentType)
    if (maybeDecoded && Buffer.isBuffer(maybeDecoded) && maybeDecoded !== buffer) {
      decodedBuffer = maybeDecoded
      httpDecompressed = true
    }
  }

  const rawBase64 = decodedBuffer.toString('base64')

  const connectEncodingHeader =
    getHeaderCaseInsensitive(headers, 'connect-content-encoding') ||
    getHeaderCaseInsensitive(headers, 'connect-encoding') ||
    getHeaderCaseInsensitive(headers, 'grpc-encoding') ||
    ''
  const connectCodec = getCompressionCodec(connectEncodingHeader)

  const maxFrames = CONNECT_MAX_FRAMES_LIMIT
  const maxFrameBytes = CONNECT_MAX_FRAME_BYTES_LIMIT

  const frames = []
  let envelope = false

  if (looksLikeConnectEnvelope(decodedBuffer)) {
    envelope = true
    let offset = 0
    let frameIndex = 0
    let envelopeValid = true

    while (offset + 5 <= decodedBuffer.length) {
      const flags = decodedBuffer.readUInt8(offset)
      const length = decodedBuffer.readUInt32BE(offset + 1)
      offset += 5

      if (length < 0 || offset + length > decodedBuffer.length) {
        envelopeValid = false
        break
      }

      const frameData = decodedBuffer.slice(offset, offset + length)
      offset += length

      const isCompressed = (flags & 0x01) === 0x01
      const endStream = (flags & 0x02) === 0x02

      const withinFrameLimit = frameIndex < maxFrames
      const withinSizeLimit = length <= maxFrameBytes

      let framePayload = frameData
      let frameDecompressed = false
      let preview = ''
      let json = null
      let note = null

      if (withinFrameLimit && withinSizeLimit) {
        if (isCompressed && connectCodec) {
          try {
            framePayload = connectCodec.decompress(frameData)
            frameDecompressed = true
          } catch (error) {
            framePayload = frameData
            frameDecompressed = false
          }
        }

        preview = bufferToTextPreview(framePayload)
        json = tryParseJsonString(preview)
        if (json === null) {
          json = extractJsonFromProtobufBuffer(framePayload)
        }
      } else {
        if (!withinFrameLimit) {
          note = 'skipped by CONNECT_MAX_FRAMES'
        } else if (!withinSizeLimit) {
          note = 'skipped by CONNECT_MAX_FRAME_BYTES'
        }
      }

      frames.push({
        index: frameIndex,
        length,
        compressed: isCompressed,
        endStream,
        frameDecompressed,
        preview,
        json,
        dataBase64: frameDecompressed ? framePayload.toString('base64') : null,
        note
      })

      frameIndex += 1
    }

    if (!envelopeValid || offset !== decodedBuffer.length || frames.length === 0) {
      return null
    }
  } else {
    // Unary Connect payload – treat the whole decoded buffer as a single frame
    const payload = decodedBuffer
    const withinSizeLimit = payload.length <= maxFrameBytes

    let preview = ''
    let json = null
    let note = null

    if (withinSizeLimit) {
      preview = bufferToTextPreview(payload)
      json = tryParseJsonString(preview)
      if (json === null) {
        json = extractJsonFromProtobufBuffer(payload)
      }
    } else {
      note = 'skipped by CONNECT_MAX_FRAME_BYTES'
    }

    frames.push({
      index: 0,
      length: payload.length,
      compressed: false,
      endStream: true,
      frameDecompressed: false,
      preview,
      json,
      dataBase64: withinSizeLimit ? payload.toString('base64') : null,
      note
    })
  }

  if (!frames.length) return null

  const result = {
    contentType,
    envelope,
    frameCount: frames.length,
    frames,
    httpDecompressed,
    httpEncoding,
    rawBase64
  }

  // Expose the HTTP-decompressed buffer on a non-enumerable property so that
  // rewrite paths can reuse it without going through an expensive
  // base64 encode/decode round-trip. This keeps existing JSON behaviour
  // unchanged while avoiding redundant work on large Connect payloads.
  Object.defineProperty(result, 'httpDecodedBuffer', {
    value: decodedBuffer,
    writable: false,
    enumerable: false,
    configurable: false
  })

  return result
}

function extractJsonFromProtobufBuffer (buffer, maxDepth = 4) {
  if (isEmptyBuffer(buffer)) return null

  if (buffer.length > PROTOBUF_MAX_BYTES_LIMIT) return null

  let root
  try {
    root = parseProtobuf(buffer)
  } catch {
    return null
  }

  if (!root || !Array.isArray(root.fields) || root.fields.length === 0) return null

  const maxFields = PROTOBUF_MAX_FIELDS_LIMIT
  let processedFields = 0

  const toJsonFromFields = (fields, depth = 0) => {
    if (!fields || !fields.length || depth > maxDepth) return null

    const bucket = new Map()

    const pushValue = (fieldNumber, value) => {
      if (value === null || value === undefined) return
      const existing = bucket.get(fieldNumber)
      if (existing) {
        existing.push(value)
      } else {
        bucket.set(fieldNumber, [value])
      }
    }

    for (const field of fields) {
      if (processedFields >= maxFields) break
      processedFields++
      if (!field || typeof field.fieldNumber !== 'number') continue

      let value = null

      if (field.wireType === 0) {
        // Varint
        if (typeof field.value === 'number') {
          value = field.value
        }
      } else if (field.wireType === 2 && Buffer.isBuffer(field.data)) {
        // Length-delimited: try nested message first
        let handled = false
        try {
          const nested = parseProtobuf(field.data)
          if (nested && Array.isArray(nested.fields) && nested.fields.length && depth + 1 <= maxDepth) {
            const nestedJson = toJsonFromFields(nested.fields, depth + 1)
            if (nestedJson && Object.keys(nestedJson).length > 0) {
              value = nestedJson
              handled = true
            }
          }
        } catch {}

        if (!handled) {
          try {
            const text = field.data.toString('utf8')
            if (text && text.trim()) {
              const printableMatches = text.match(/[\x20-\x7E\n\r\t]/g) || []
              const printableRatio = printableMatches.length / text.length

              if (printableRatio >= 0.5) {
                const json = tryParseJsonString(text)
                value = json !== null ? json : text.trim()
                handled = true
              }
            }
          } catch {}
        }

        if (!handled) {
          value = {
            base64: field.data.toString('base64'),
            length: field.data.length
          }
        }
      } else if ((field.wireType === 1 || field.wireType === 5) && Buffer.isBuffer(field.data)) {
        // Fixed 32/64-bit: expose as hex blob
        value = {
          bytesHex: field.data.toString('hex'),
          length: field.data.length
        }
      }

      if (value !== null) {
        pushValue(field.fieldNumber, value)
      }
    }

    const result = {}
    for (const [fieldNumber, values] of bucket.entries()) {
      const key = `f${fieldNumber}`
      result[key] = values.length === 1 ? values[0] : values
    }

    return Object.keys(result).length > 0 ? result : null
  }

  return toJsonFromFields(root.fields, 0)
}

/**
 * Apply Connect/gRPC/protobuf-aware body rewrites and optionally decode a
 * structured logging view of the payload for the UI.
 *
 * This helper:
 * - optionally decodes a Connect payload into frames for logging when
 *   interactiveModeEnabled is true and a log entry is provided;
 * - runs Connect-aware frame rewrites and JSONPath protobuf rewrites when
 *   edit/JSONPath rules are active;
 * - can fall back to plain text body rewrites when allowed and the content
 *   type looks textual;
 * - stores raw/preview/base64 fields on the provided logEntry.
 *
 * Behaviour is preserved compared to the previous inlined logic; the
 * implementation only gates expensive decoding work when it would not have
 * been observable (for example, when interactive logging is disabled).
 *
 * @param {object|null} logEntry - Mutable log entry object to enrich, or null.
 * @param {Buffer} buffer - Raw HTTP body buffer.
 * @param {object} headers - Mutable headers object for the HTTP message.
 * @param {object} [options]
 * @param {('request'|'response')} [options.role] - Whether this is a request or response body.
 * @param {boolean} [options.allowBodyRewriteFallback] - Allow fallback to text rewrites.
 * @param {boolean} [options.updateContentEncoding] - Update content-encoding after rewrites.
 * @param {{requestUrl?: string, fullUrl?: string}} [options.urlContext] - Optional URL context used for JSONPath rules when no log entry is present.
 * @returns {{buffer: Buffer, connect: object|null}} Final body buffer and optional Connect view.
 */
function applyConnectRewritesAndDecode (logEntry, buffer, headers, options = {}) {
  const role = options.role === 'response' ? 'response' : 'request'
  const allowBodyRewriteFallback = options.allowBodyRewriteFallback === true
  const updateContentEncoding = options.updateContentEncoding === true
  const urlContext = options && typeof options.urlContext === 'object' ? options.urlContext : null

  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { buffer, connect: null }
  }

  const isResponse = role === 'response'
  const base64Field = isResponse ? 'rawResponseBodyBase64' : 'rawRequestBodyBase64'
  const previewField = isResponse ? 'rawResponseBodyPreview' : 'rawRequestBodyPreview'
  const connectField = isResponse ? 'connectResponse' : 'connectRequest'
  const summaryField = isResponse ? 'responseBodySummary' : 'requestBodySummary'
  const bodyField = isResponse ? 'responseBody' : 'body'

  // Determine whether there are any active edit/JSONPath rules that may
  // require Connect/protobuf handling for rewriting.
  const compiledRules = getCompiledRules()
  const compiledJsonPathRules = getCompiledJsonPathRules()
  const hasRulesForConnect =
    (Array.isArray(compiledRules) && compiledRules.length > 0) ||
    (Array.isArray(compiledJsonPathRules) && compiledJsonPathRules.length > 0)

  // Heavy Connect/protobuf *logging* is only needed when we have interactive
  // logging enabled and a real log entry to enrich. When interactive mode is
  // disabled we still perform rewrites, but we skip the extra Connect decode
  // pass used purely for logging.
  const wantsLogging = interactiveModeEnabled && !!logEntry

  let jsonPathContext = { phase: role }
  if (urlContext && (urlContext.requestUrl || urlContext.fullUrl)) {
    jsonPathContext = {
      requestUrl: urlContext.requestUrl,
      fullUrl: urlContext.fullUrl,
      phase: role
    }
  } else if (logEntry && (logEntry.url || logEntry.fullUrl)) {
    jsonPathContext = {
      requestUrl: logEntry.url,
      fullUrl: logEntry.fullUrl,
      phase: role
    }
  }

  // Decode the original payload once to build a true "before rewrite" view,
  // but only when required for logging. Rewrites operate on the raw HTTP
  // buffer and may optionally reuse decoded frames when logging is enabled.
  const originalConnect = wantsLogging
    ? decodeConnectPayload(buffer, headers)
    : null

  // Apply binary/protobuf rewrites to the HTTP body buffer.
  // We operate on the original HTTP body here; decodeConnectPayload above
  // already performs a separate pass for logging/decoding purposes.
  let workingBuffer = buffer
  let updatedFrames = null

  if (hasRulesForConnect) {
    const connectRewriteResult = applyConnectFrameRewrites(
      workingBuffer,
      headers,
      originalConnect,
      jsonPathContext,
      { loggingEnabled: wantsLogging }
    )
    if (connectRewriteResult.changed) {
      workingBuffer = connectRewriteResult.buffer
      if (Array.isArray(connectRewriteResult.updatedFrames)) {
        updatedFrames = connectRewriteResult.updatedFrames
      }
      if (logEntry && Array.isArray(connectRewriteResult.appliedRuleIds) && connectRewriteResult.appliedRuleIds.length) {
        attachRewriteMetadata(logEntry, connectRewriteResult.appliedRuleIds)
      }

      if (updateContentEncoding && Object.prototype.hasOwnProperty.call(connectRewriteResult, 'encoding')) {
        if (connectRewriteResult.encoding) {
          headers['content-encoding'] = connectRewriteResult.encoding
        } else {
          delete headers['content-encoding']
        }
      }
    } else if (allowBodyRewriteFallback && Array.isArray(compiledRules) && compiledRules.length > 0) {
      // Fallback to plain text rewrites only when the content-type suggests
      // textual payloads. This avoids unnecessary UTF-8 decoding and regex
      // work on clearly binary data.
      const contentType = getHeaderCaseInsensitive(headers, 'content-type') || ''
      const lowerContentType = typeof contentType === 'string' ? contentType.toLowerCase() : ''
      const looksTextual =
        lowerContentType.includes('json') ||
        lowerContentType.includes('text/') ||
        lowerContentType.includes('javascript') ||
        lowerContentType.includes('xml') ||
        lowerContentType.includes('x-www-form-urlencoded')

      if (looksTextual) {
        const bodyRewriteResult = applyEditRulesToBuffer(workingBuffer)
        if (bodyRewriteResult.changed) {
          workingBuffer = bodyRewriteResult.buffer
          if (logEntry && Array.isArray(bodyRewriteResult.appliedRuleIds) && bodyRewriteResult.appliedRuleIds.length) {
            attachRewriteMetadata(logEntry, bodyRewriteResult.appliedRuleIds)
          }
        }
      }
    }
  }

  // Store the final (possibly rewritten) raw body for export.
  if (logEntry && base64Field) {
    const base64 = workingBuffer.toString('base64')
    logEntry[base64Field] = base64

    // When we have a concrete Buffer for the final on-wire payload, also
    // seed request/response byte metrics so addLog can avoid re-decoding
    // base64 just to compute sizes.
    const length = workingBuffer.length
    if (!Number.isNaN(length) && length > 0) {
      if (!isResponse && typeof logEntry.requestBytes !== 'number') {
        logEntry.requestBytes = length
      } else if (isResponse && typeof logEntry.responseBytes !== 'number') {
        logEntry.responseBytes = length
      }
    }
  }

  // Build a preview from the final buffer, but do not mutate the underlying frames.
  if (logEntry && previewField) {
    const preview = bufferToTextPreview(workingBuffer)
    if (preview) {
      const maxPreviewLength =
        Number.isFinite(LOG_PREVIEW_MAX_BYTES) && LOG_PREVIEW_MAX_BYTES > 0
          ? LOG_PREVIEW_MAX_BYTES * 2
          : 0

      if (maxPreviewLength && preview.length > maxPreviewLength) {
        // Skip preview rewrites on very large previews to avoid running regexes
        // over huge strings produced by misclassified content.
        logEntry[previewField] = preview
      } else {
        const previewRewrite = applyEditRulesToText(preview, jsonPathContext)
        if (previewRewrite.changed) {
          logEntry[previewField] = previewRewrite.text
          if (previewRewrite.appliedRuleIds?.length) {
            attachRewriteMetadata(logEntry, previewRewrite.appliedRuleIds)
          }
        } else {
          logEntry[previewField] = preview
        }
      }
    }
  }

  let connect = null

  if (originalConnect && Array.isArray(originalConnect.frames) && originalConnect.frames.length > 0) {
    // Normalised "before" frames (decoded from the original payload).
    const originalFrames = originalConnect.frames.map((frame, idx) => ({
      index: typeof frame.index === 'number' ? frame.index : idx,
      length: frame.length,
      compressed: !!frame.compressed,
      endStream: !!frame.endStream,
      frameDecompressed: !!frame.frameDecompressed,
      preview: typeof frame.preview === 'string' ? frame.preview : '',
      json: frame.json ?? null,
      dataBase64: typeof frame.dataBase64 === 'string' ? frame.dataBase64 : null,
      note: frame.note ?? null
    }))

    // Normalised "after" frames (decoded from the rewritten payload, if any).
    let frames = originalFrames
    if (Array.isArray(updatedFrames) && updatedFrames.length > 0) {
      frames = updatedFrames.map((frame, idx) => ({
        index: typeof frame.index === 'number' ? frame.index : idx,
        length: typeof frame.length === 'number'
          ? frame.length
          : (Buffer.isBuffer(frame.data) ? frame.data.length : 0),
        compressed: !!((frame.flags & 0x01) === 0x01),
        endStream: !!((frame.flags & 0x02) === 0x02),
        frameDecompressed: false,
        preview: typeof frame.preview === 'string' ? frame.preview : '',
        json: frame.json ?? null,
        note: frame.note ?? null
      }))
    }

    connect = {
      ...originalConnect,
      frames,
      originalFrames
    }

    if (logEntry) {
      logEntry[connectField] = connect

      const summaryParts = [
        'Connect proto',
        connect.envelope ? `frames=${connect.frameCount}` : 'unary'
      ]
      if (connect.frames?.some(frame => frame.json)) {
        summaryParts.push('json')
      }
      summaryParts.push('base64')
      logEntry[summaryField] = summaryParts.join(' | ')

      logEntry[bodyField] = frames.map(frame => ({
        index: frame.index,
        length: frame.length,
        compressed: frame.compressed,
        endStream: frame.endStream,
        frameDecompressed: frame.frameDecompressed,
        preview: frame.preview,
        json: frame.json,
        note: frame.note || null
      }))
    }
  }

  return { buffer: workingBuffer, connect }
}

/**
 * Apply Connect/protobuf-aware rewrites for HTTPS MITM bypass responses.
 *
 * This wrapper delegates to applyConnectRewritesAndDecode with logging
 * disabled and a URL-based JSONPath context, while still allowing plain text
 * fallback rewrites for textual payloads.
 *
 * @param {Buffer} buffer - Raw HTTP response body buffer.
 * @param {object} headers - Response headers object, mutated when encoding changes.
 * @param {{requestUrl?: string, fullUrl?: string}} [urlContext] - URL context for JSONPath rules.
 * @returns {{buffer: Buffer}} Object containing the final response buffer.
 */
function applyConnectRewritesForBypass (buffer, headers, urlContext) {
  if (isEmptyBuffer(buffer)) {
    return { buffer }
  }

  const { buffer: nextBuffer } = applyConnectRewritesAndDecode(
    null,
    buffer,
    headers,
    {
      role: 'response',
      allowBodyRewriteFallback: true,
      updateContentEncoding: true,
      urlContext: urlContext || {}
    }
  )

  return { buffer: nextBuffer }
}

function captureRawBody (req, res, buf) {
  if (buf && buf.length) {
    req.rawBody = Buffer.from(buf)
  }
}

// Ensure directories exist
try {
  [STORAGE_DIR, LOGS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  })
} catch (error) {
  console.error('[proxy] Error ensuring storage/log directories:', error)
}

// In-memory storage for request logs
let requestLogs = []
let localResources = new Map()
let bypassedRequestCount = 0
let bypassMode = 'ignore' // bypass mode: 'ignore' (default) or 'focus'

/**
 * Proxied sources considered "proxied" in dashboard statistics.
 * Kept in sync with the /api/dashboard logic.
 * @type {Set<string>}
 */
const DASHBOARD_PROXIED_SOURCES = new Set(['proxied', 'tunnel', 'mitm', 'websocket', 'direct'])

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
function createEmptyDashboardStats () {
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
 * Aggregate performance statistics for the dashboard derived from request logs.
 *
 * @typedef {Object} DashboardPerformanceStats
 * @property {{count:number,totalMs:number,maxMs:number}} upstream
 * @property {{count:number,totalMs:number,maxMs:number}} total
 * @property {{count:number,totalMs:number,maxMs:number}} proxy
 * @property {{
 *   request: {count:number,totalBytes:number,maxBytes:number},
 *   response: {count:number,totalBytes:number,maxBytes:number}
 * }} payloads
 */

/**
 * Create an empty performance statistics structure for the dashboard.
 *
 * @returns {DashboardPerformanceStats}
 */
function createEmptyPerformanceStats () {
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
 * In-memory dashboard statistics derived from the current requestLogs contents.
 * Always updated incrementally when logs are added, removed, or cleared.
 *
 * @type {DashboardStats}
 */
let dashboardStats = createEmptyDashboardStats()

/**
 * In-memory performance statistics derived from the current requestLogs contents.
 * Always updated incrementally when logs are added, removed, or cleared.
 *
 * @type {DashboardPerformanceStats}
 */
let performanceStats = createEmptyPerformanceStats()

/**
 * Route-level statistics used for hotspot detection in the dashboard.
 * Key: `${host}${pathKey}` where `pathKey` is derived from sanitizePathForSuggestions.
 *
 * Each route aggregates timing/payload metrics plus lightweight source counts so
 * that the audit panel can infer whether a route is typically processed,
 * blocked, redirected (direct/tunnel) or served from a local resource based on
 * *observed* traffic rather than re-evaluating routing rules on a truncated
 * path.
 *
 * @type {Map<string, {
 *   host: string,
 *   path: string,
 *   count: number,
 *   totalMs: number,
 *   maxMs: number,
 *   totalResponseBytes: number,
 *   sourceCounts: Record<string, number>
 * }>}
 */
let routeStats = new Map()

/**
 * Apply the contribution of a log entry to the aggregated dashboard statistics.
 * Uses the same rules as the original /api/dashboard implementation.
 *
 * @param {object} logEntry - The log entry to apply.
 * @param {1|-1} direction - +1 when adding, -1 when removing.
 */
function applyDashboardStatsDelta (logEntry, direction) {
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
      performanceStats.payloads.request.maxBytes = Math.max(performanceStats.payloads.request.maxBytes, value)
    }
  }

  if (typeof logEntry.responseBytes === 'number') {
    const value = logEntry.responseBytes
    performanceStats.payloads.response.count += dir
    performanceStats.payloads.response.totalBytes += dir * value
    if (dir === 1) {
      performanceStats.payloads.response.maxBytes = Math.max(performanceStats.payloads.response.maxBytes, value)
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
    const src = typeof logEntry.source === 'string' && logEntry.source ? logEntry.source : 'unknown'
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

function incrementBypassedCount (increment = 1) {
  const value = Number(increment)
  if (!Number.isFinite(value) || value <= 0) return
  bypassedRequestCount += value
}

function findMatchingLocalResource (requestUrl, fullUrl) {
  if (!localResourcesEnabled || localResources.size === 0) return null

  const req = typeof requestUrl === 'string' ? requestUrl : ''
  const full = typeof fullUrl === 'string' ? fullUrl : ''

  for (const [resourceUrl, resourceData] of localResources.entries()) {
    if (!resourceData || resourceData.enabled === false) continue
    if ((req && req.includes(resourceUrl)) || (full && full.includes(resourceUrl))) {
      return { url: resourceUrl, resource: resourceData }
    }
  }

  return null
}

// Load interactive mode, filter mode, and global feature modes from disk
const CONFIG_FILE = path.join(STORAGE_DIR, 'config.json')
let interactiveModeEnabled = true // interactive mode flag
let editRulesEnabled = true // global live edit rules flag
let localResourcesEnabled = true // global local resources flag
let filterRulesEnabled = true // global filter rules flag
let blockedRulesEnabled = true // global blocked rules flag
let persistConfigWritePromise = null
let persistConfigQueued = false
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    interactiveModeEnabled = config.interactiveModeEnabled !== false
    if (typeof config.editRulesEnabled === 'boolean') {
      editRulesEnabled = config.editRulesEnabled
    }
    if (typeof config.localResourcesEnabled === 'boolean') {
      localResourcesEnabled = config.localResourcesEnabled
    }
    if (typeof config.filterRulesEnabled === 'boolean') {
      filterRulesEnabled = config.filterRulesEnabled
    }
    if (typeof config.blockedRulesEnabled === 'boolean') {
      blockedRulesEnabled = config.blockedRulesEnabled
    }

    let rawMode = null
    if (typeof config.filterMode === 'string') {
      rawMode = config.filterMode
    } else if (typeof config.bypassMode === 'string') {
      // Legacy key, kept for backward compatibility
      rawMode = config.bypassMode
    }

    if (typeof rawMode === 'string') {
      const normalized = rawMode.toLowerCase()
      if (normalized === 'focus' || normalized === 'ignore') {
        bypassMode = normalized
      }
    }
  }
} catch (error) {
  console.error('Error loading config:', error)
}

function getBypassMode () {
  return bypassMode === 'focus' ? 'focus' : 'ignore'
}

function persistConfig () {
  if (persistConfigWritePromise) {
    persistConfigQueued = true
    return
  }

  persistConfigWritePromise = (async () => {
    try {
      let existing = {}
      try {
        const raw = await fsPromises.readFile(CONFIG_FILE, 'utf8')
        existing = JSON.parse(raw) || {}
      } catch (readError) {
        if (readError && readError.code !== 'ENOENT') {
          console.error('Error reading config file:', readError)
        }
        existing = {}
      }

      const updated = {
        ...existing,
        interactiveModeEnabled,
        editRulesEnabled,
        localResourcesEnabled,
        filterRulesEnabled,
        blockedRulesEnabled,
        filterMode: getBypassMode()
      }

      // Drop legacy key if present
      if (Object.prototype.hasOwnProperty.call(updated, 'bypassMode')) {
        delete updated.bypassMode
      }

      await fsPromises.writeFile(CONFIG_FILE, JSON.stringify(updated, null, 2))
    } catch (error) {
      console.error('Error saving config:', error)
    } finally {
      persistConfigWritePromise = null
      if (persistConfigQueued) {
        persistConfigQueued = false
        persistConfig()
      }
    }
  })()
}

function isIgnoreMode () {
  return getBypassMode() === 'ignore'
}

function isFocusMode () {
  return getBypassMode() === 'focus'
}

/**
 * Create a base HTTP log entry with consistent identifiers and timestamps.
 *
 * @param {Object} params
 * @param {number} params.requestStart
 * @param {string} params.method
 * @param {string} params.url
 * @param {string} params.fullUrl
 * @param {Object} params.headers
 * @param {string} params.source
 * @param {string} [params.clientIp]
 * @returns {Object}
 */
function createBaseLogEntry ({ requestStart, method, url, fullUrl, headers, source, clientIp }) {
  const ts = Number.isFinite(requestStart) ? requestStart : Date.now()

  return {
    id: ts + Math.random(),
    timestamp: new Date(ts).toISOString(),
    requestStartTs: ts,
    method,
    url,
    fullUrl,
    headers,
    body: null,
    source,
    clientIp
  }
}

// Helper to add log only if interactive mode is enabled
function addLog (logEntry) {
  if (!interactiveModeEnabled) return
  if (logEntry && typeof logEntry === 'object') {
    // Precompute base search text for global search (URL, method, target/local info)
    const parts = [
      logEntry.url || '',
      logEntry.method || '',
      logEntry.targetUrl || '',
      logEntry.localResource || ''
    ]
    logEntry.searchBase = parts.join(' ').toLowerCase()

    // Precompute fileType once per log entry when it's first added
    if (!logEntry.fileType) {
      logEntry.fileType = getFileTypeFromLogEntry(logEntry)
    }

    // Precompute request/response search snapshots (body + Connect + raw preview)
    ensureLogSearchSnapshots(logEntry)

    // Compute lightweight per-request metrics used by the audit panel. This is
    // done once when the log entry is first added.
    try {
      // Timing metrics
      if (typeof logEntry.requestStartTs === 'number' && typeof logEntry.totalDurationMs !== 'number') {
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
          } catch {}
        }

        if (!requestBytes && logEntry.headers) {
          const contentLength = getHeaderCaseInsensitive(logEntry.headers, 'content-length')
          const parsed = contentLength && Number(contentLength)
          if (Number.isFinite(parsed) && parsed > 0) {
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
        } else if (typeof logEntry.rawResponseBodyBase64 === 'string' && logEntry.rawResponseBodyBase64) {
          try {
            responseBytes = Buffer.from(logEntry.rawResponseBodyBase64, 'base64').length
          } catch {}
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
          const countFrames = (connect) => {
            if (!connect || typeof connect !== 'object') return 0
            if (typeof connect.frameCount === 'number') return connect.frameCount
            if (Array.isArray(connect.frames)) return connect.frames.length
            return 0
          }

          logEntry.connectSummary = {
            hasRequest,
            hasResponse,
            requestFrameCount: countFrames(logEntry.connectRequest),
            responseFrameCount: countFrames(logEntry.connectResponse)
          }
        }
      }
    } catch (error) {
      // Defensive: never block logging if metric computation fails
      logDebug('addLog', 'Failed to compute per-request metrics', error)
    }
  }
  requestLogs.unshift(logEntry)
  updateSuggestionStatsOnAdd(logEntry)
  applyDashboardStatsDelta(logEntry, 1)
  if (requestLogs.length > MAX_LOG_ENTRIES) {
    const removed = requestLogs.pop()
    if (removed) {
      updateSuggestionStatsOnRemove(removed)
      applyDashboardStatsDelta(removed, -1)
    }
  }
}

/**
 * Classify an upstream error into a coarse category for diagnostics.
 * This is intentionally conservative and based on the error's code/name/
 * message without depending on Undici internals.
 *
 * @param {Error & { code?: string, name?: string, type?: string }} error
 * @returns {string} One of: 'timeout', 'aborted', 'connection', 'protocol', 'upstream', 'unknown'.
 */
function classifyUpstreamError (error) {
  if (!error || typeof error !== 'object') return 'unknown'

  const code = typeof error.code === 'string' ? error.code.toUpperCase() : ''
  const name = typeof error.name === 'string' ? error.name.toUpperCase() : ''
  const type = typeof error.type === 'string' ? error.type.toUpperCase() : ''
  const message = typeof error.message === 'string' ? error.message.toUpperCase() : ''

  const combined = `${code} ${name} ${type} ${message}`

  if (combined.includes('TIMEOUT')) return 'timeout'
  if (combined.includes('ABORT') || combined.includes('CANCEL')) return 'aborted'

  if (code.startsWith('E') && (
    code.includes('CONN') ||
    code.includes('REFUSED') ||
    code.includes('RESET') ||
    code.includes('UNREACH') ||
    code.includes('PIPE') ||
    code.includes('ADDR')
  )) {
    return 'connection'
  }

  if (combined.includes('PROTOCOL') || combined.includes('HTTP_PARSER') || combined.includes('UND_ERR')) {
    return 'protocol'
  }

  // Default bucket for other upstream failures.
  return 'upstream'
}

/**
 * Record an upstream error on a log entry in a consistent way.
 *
 * @param {object|null} logEntry
 * @param {Error & { code?: string, name?: string, type?: string }} error
 */
function recordUpstreamErrorOnLog (logEntry, error) {
  if (!logEntry || typeof logEntry !== 'object') return

  logEntry.source = 'error'
  logEntry.error = error && error.message ? error.message : String(error)

  if (typeof logEntry.upstreamDurationMs !== 'number') {
    const startTs =
      typeof logEntry.requestStartTs === 'number'
        ? logEntry.requestStartTs
        : (logEntry.timestamp ? Date.parse(logEntry.timestamp) || Date.now() : Date.now())
    logEntry.upstreamDurationMs = Date.now() - startTs
  }

  logEntry.upstreamErrorCategory = classifyUpstreamError(error)
  addLog(logEntry)
}

function extractHostInfoFromLog (logEntry) {
  if (!logEntry || typeof logEntry !== 'object') return null

  if (logEntry._hostInfo && logEntry._hostInfo.host) {
    return logEntry._hostInfo
  }

  const headerHost = typeof logEntry.headers?.host === 'string'
    ? logEntry.headers.host.toLowerCase()
    : null

  const normalizeHost = (host) => {
    if (!host) return null
    return host.toLowerCase().split(':')[0]
  }

  const tryParseUrl = (candidate) => {
    if (!candidate || typeof candidate !== 'string') return null
    const trimmed = candidate.trim()
    if (!trimmed) return null

    try {
      const parsed = new URL(trimmed)
      return {
        host: normalizeHost(parsed.hostname),
        path: parsed.pathname || '/'
      }
    } catch (error) {
      if (headerHost && trimmed.startsWith('/')) {
        try {
          const parsed = new URL(`http://${headerHost}${trimmed}`)
          return {
            host: normalizeHost(parsed.hostname),
            path: parsed.pathname || '/'
          }
        } catch (innerError) {
          return null
        }
      } else if (!trimmed.includes('://')) {
        try {
          const parsed = new URL(`http://${trimmed}`)
          return {
            host: normalizeHost(parsed.hostname),
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
      } catch {}
      return parsed
    }
  }

  if (headerHost) {
    const info = {
      host: normalizeHost(headerHost),
      path: '/'
    }
    try {
      Object.defineProperty(logEntry, '_hostInfo', {
        value: info,
        writable: false,
        configurable: false,
        enumerable: false
      })
    } catch {}
    return info
  }

  return null
}

function computeBypassSuggestions ({ limit = 10, _windowSize = 500 } = {}) {
  const cappedLimit = Math.max(1, Math.min(50, limit))

  const results = Array.from(bypassSuggestionStats.values())
    .filter(record => !bypassMatchers.some(matcher => matcher.type === 'host' && hostPatternMatches(matcher.value, record.host)))
    .map(record => {
      const topPaths = Array.from(record.pathCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([path, count]) => ({ path, count }))

      return {
        pattern: record.host,
        count: record.count,
        lastSeen: record.lastSeen || null,
        samplePaths: topPaths
      }
    })
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      if (b.lastSeen !== a.lastSeen) return (b.lastSeen || 0) - (a.lastSeen || 0)
      return a.pattern.localeCompare(b.pattern)
    })
    .slice(0, cappedLimit)

  return results
}

function parseListQuery (value, defaultList = []) {
  if (Array.isArray(value)) {
    const parts = value
      .flatMap(v => String(v || '').split(','))
      .map(v => v.trim())
      .filter(Boolean)
    return parts.length ? Array.from(new Set(parts)) : [...defaultList]
  }

  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
    return parts.length ? Array.from(new Set(parts)) : [...defaultList]
  }

  return [...defaultList]
}

/**
 * Normalize a simple toggle payload coming from the UI.
 *
 * This keeps the existing default behaviour (omitted `enabled` means
 * `defaultEnabled`) but ensures that, when present, `enabled` is a boolean.
 * Invalid values produce a 400 with a clear message.
 *
 * @param {any} body
 * @param {boolean} defaultEnabled
 * @returns {{ ok: boolean, value: boolean, error?: string }}
 */
function validateTogglePayload (body, defaultEnabled) {
  const source = (body && typeof body === 'object') ? body : {}

  if (!Object.prototype.hasOwnProperty.call(source, 'enabled')) {
    return { ok: true, value: defaultEnabled }
  }

  const { enabled } = source

  if (typeof enabled === 'boolean') {
    return { ok: true, value: enabled }
  }

  return {
    ok: false,
    value: defaultEnabled,
    error: 'Invalid "enabled" flag: expected a boolean.'
  }
}

function handleBooleanToggleEndpoint ({ req, res, assignValue, responseFieldName, defaultEnabled = true }) {
  const result = validateTogglePayload(req.body, defaultEnabled)
  if (!result.ok) {
    return res.status(400).json({ error: result.error })
  }

  assignValue(result.value)
  persistConfig()

  const payload = { success: true }
  payload[responseFieldName] = result.value
  return res.json(payload)
}

/**
 * Build a textual search snapshot for Connect/gRPC frame data stored in a
 * log entry. This is used only for search indexing; the full structured
 * frame data remains in connectRequest/connectResponse.
 *
 * To keep this affordable for long-lived streams with many frames, we:
 * - Apply a max-size guard based on SEARCH_SNAPSHOT_MAX_BYTES.
 * - Prefer human-readable fields (preview/note/error/json) and omit raw
 *   base64 data from the snapshot.
 *
 * @param {object|null} connectData
 * @returns {string}
 */
function buildConnectSearchContentForLog (connectData) {
  if (!connectData || typeof connectData !== 'object') return ''

  const maxBytes = Number.isFinite(SEARCH_SNAPSHOT_MAX_BYTES) && SEARCH_SNAPSHOT_MAX_BYTES > 0
    ? SEARCH_SNAPSHOT_MAX_BYTES
    : 0

  const parts = []
  let totalLength = 0
  let truncated = false

  const appendSegment = (value) => {
    if (truncated || !value) return
    const text = String(value)
    if (!text) return

    if (!maxBytes) {
      parts.push(text)
      return
    }

    const remaining = maxBytes - totalLength
    if (remaining <= 0) {
      truncated = true
      return
    }

    if (text.length <= remaining) {
      parts.push(text)
      totalLength += text.length
      return
    }

    parts.push(text.slice(0, remaining))
    totalLength += remaining
    truncated = true
  }

  const collectFromFrames = (frames) => {
    if (!Array.isArray(frames) || !frames.length || truncated) return

    for (const frame of frames) {
      if (truncated) break
      if (!frame || typeof frame !== 'object') continue

      // Prefer human-readable fields for search.
      if (frame.preview) appendSegment(frame.preview)
      if (frame.note) appendSegment(frame.note)
      if (frame.error) appendSegment(frame.error)

      if (frame.json) {
        try {
          appendSegment(JSON.stringify(frame.json))
        } catch {}
      }

      // Intentionally skip frame.dataBase64 here to avoid huge base64
      // blobs in the search index. The full data remains available on the
      // underlying frame structure.
    }
  }

  // Prefer searching over the pre-rewrite (original) frames, but also include
  // the final transformed frames so searches can hit both views.
  if (Array.isArray(connectData.originalFrames) && connectData.originalFrames.length) {
    collectFromFrames(connectData.originalFrames)
  }

  if (!truncated && Array.isArray(connectData.frames) && connectData.frames.length) {
    collectFromFrames(connectData.frames)
  }

  if (!parts.length) return ''

  return parts.join('\n')
}

function getFileTypeFromLogEntry (log) {
  const contentType = (log && log.responseHeaders)
    ? (getHeaderCaseInsensitive(log.responseHeaders, 'content-type') || '')
    : ''
  const url = ((log && (log.fullUrl || log.url)) || '').toString().toLowerCase()

  if (contentType.includes('json')) return 'json'
  if (contentType.includes('html')) return 'html'
  if (contentType.includes('css')) return 'css'
  if (contentType.includes('javascript')) return 'js'
  if (contentType.includes('image/')) return 'image'
  if (contentType.includes('video/')) return 'video'
  if (contentType.includes('audio/')) return 'audio'

  const fontExtensions = ['.woff', '.woff2', '.ttf', '.otf', '.eot']
  if (contentType.includes('font/') || fontExtensions.some(ext => url.endsWith(ext))) return 'font'

  // If bodies are structured objects, treat them as JSON for cosmetic purposes
  if (log && (typeof log.responseBody === 'object' && log.responseBody !== null)) return 'json'
  if (log && (typeof log.body === 'object' && log.body !== null)) return 'json'

  // Best-effort JSON detection on string bodies when content-type is missing or generic
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

function buildConnectViewForClient (connectData) {
  if (!connectData || typeof connectData !== 'object') return null

  const mapFrames = (frames) => {
    if (!Array.isArray(frames)) return []
    return frames
      .map((frame, idx) => {
        if (!frame || typeof frame !== 'object') return null
        const frameIndex = typeof frame.index === 'number' ? frame.index : idx

        return {
          index: frameIndex,
          length: frame.length,
          compressed: !!frame.compressed,
          endStream: !!frame.endStream,
          frameDecompressed: !!frame.frameDecompressed,
          preview: typeof frame.preview === 'string' ? frame.preview : '',
          json: frame.json ?? null,
          note: frame.note ?? null,
          error: frame.error ?? null
        }
      })
      .filter(Boolean)
  }

  return {
    contentType: connectData.contentType || null,
    envelope: !!connectData.envelope,
    frameCount: typeof connectData.frameCount === 'number'
      ? connectData.frameCount
      : (Array.isArray(connectData.frames) ? connectData.frames.length : 0),
    frames: mapFrames(connectData.frames),
    originalFrames: mapFrames(connectData.originalFrames)
  }
}

function buildClientLogView (log) {
  if (!log || typeof log !== 'object') return null

  const view = {
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

  // Expose upstream performance metrics (used by the hidden audit panel).
  if (typeof log.upstreamDurationMs === 'number') {
    view.upstreamDurationMs = log.upstreamDurationMs
  }
  if (typeof log.upstreamErrorCategory === 'string' && log.upstreamErrorCategory) {
    view.upstreamErrorCategory = log.upstreamErrorCategory
  }

  // Per-request timing metrics
  if (typeof log.requestStartTs === 'number') {
    view.requestStartTs = log.requestStartTs
  }
  if (typeof log.totalDurationMs === 'number') {
    view.totalDurationMs = log.totalDurationMs
  }
  if (typeof log.proxyOverheadMs === 'number') {
    view.proxyOverheadMs = log.proxyOverheadMs
  }

  // Payload size metrics
  if (typeof log.requestBytes === 'number') {
    view.requestBytes = log.requestBytes
  }
  if (typeof log.responseBytes === 'number') {
    view.responseBytes = log.responseBytes
  }

  // Rewrite usage summary
  if (typeof log.rewriteCount === 'number') {
    view.rewriteCount = log.rewriteCount
  }

  if (typeof log.connectionId !== 'undefined') {
    view.connectionId = log.connectionId
  }
  if (log.isConnectionLog) {
    view.isConnectionLog = true
  }
  if (log.isWebSocketSummary) {
    view.isWebSocketSummary = true
  }

  if (log.headers) view.headers = log.headers
  if (log.responseHeaders) view.responseHeaders = log.responseHeaders

  if ('body' in log) view.body = log.body
  if ('responseBody' in log) view.responseBody = log.responseBody
  if (typeof log.requestBodyJson !== 'undefined') {
    view.requestBodyJson = log.requestBodyJson
  }
  if (typeof log.responseBodyJson !== 'undefined') {
    view.responseBodyJson = log.responseBodyJson
  }
  if (typeof log.originalBody === 'string' && log.originalBody.length > 0) {
    view.originalBody = log.originalBody
  }
  if (log.requestBodySummary) view.requestBodySummary = log.requestBodySummary
  if (log.responseBodySummary) view.responseBodySummary = log.responseBodySummary

  if (typeof log.rawRequestBodyPreview === 'string' && log.rawRequestBodyPreview.length > 0) {
    view.rawRequestBodyPreview = log.rawRequestBodyPreview
  }
  if (typeof log.rawResponseBodyPreview === 'string' && log.rawResponseBodyPreview.length > 0) {
    view.rawResponseBodyPreview = log.rawResponseBodyPreview
  }

  if (log.connectRequest) {
    view.connectRequest = buildConnectViewForClient(log.connectRequest)
  }
  if (log.connectResponse) {
    view.connectResponse = buildConnectViewForClient(log.connectResponse)
  }

  if (log.connectSummary && typeof log.connectSummary === 'object') {
    view.connectSummary = log.connectSummary
  }

  if (log.wsSummary && typeof log.wsSummary === 'object') {
    view.wsSummary = log.wsSummary
  }

  if (Array.isArray(log.rewrites) && log.rewrites.length > 0) {
    view.rewrites = log.rewrites
  }

  return view
}

/**
 * Core log filtering implementation used by /api/logs and /api/logs/export.
 *
 * Applies text search, body/header search snapshots, source/method/fileType
 * filters and respects ALWAYS_INCLUDED_SOURCES for local/blocked/error
 * entries.
 *
 * @param {object} [query]
 * @returns {{ ordered: any[], total: number }}
 */
function filterLogsCore (query = {}) {
  const searchTerm = typeof query.search === 'string' ? query.search : ''
  const requestBodySearch = typeof query.requestSearch === 'string' ? query.requestSearch : ''
  const responseSearchTerm = typeof query.responseSearch === 'string' ? query.responseSearch : ''

  const selectedSources = parseListQuery(query.sources, ['proxied', 'mitm', 'websocket'])
  const selectedMethods = parseListQuery(query.methods, ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
  const selectedFileTypes = parseListQuery(query.fileTypes, ['json', 'html', 'css', 'js', 'image', 'video', 'audio', 'font', 'other'])

  const showWsConnections = String(query.showWsConnections || '').toLowerCase() === 'true'

  const requestRewrittenOnly = String(query.requestRewrittenOnly || '').toLowerCase() === 'true'
  const responseRewrittenOnly = String(query.responseRewrittenOnly || '').toLowerCase() === 'true'

  const requestBodySearchLower = requestBodySearch.toLowerCase()
  const responseSearchLower = responseSearchTerm.toLowerCase()

  // Use the precomputed blockedUrlSubstringsForFilter list so we don't
  // rebuild the pattern set on every /api/logs call.
  const patterns = Array.isArray(blockedUrlSubstringsForFilter)
    ? blockedUrlSubstringsForFilter
    : []

  // Precompute search OR-groups once per API call so we do not repeatedly
  // split and trim the same search term for every log entry.
  const searchOrGroups = searchTerm
    ? searchTerm
        .split('||')
        .map(group => group.trim())
        .filter(group => group)
    : []

  const filtered = requestLogs.filter(log => {
    const urlString = ((log && (log.fullUrl || log.url)) || '').toString()

    // Hide any entries whose URL matches a blocked rule pattern (enabled or
    // disabled) so that the Requests view stays focused on traffic that has
    // not already been handled by the user. The blocked rules list acts as a
    // global noise filter for telemetry/analytics endpoints regardless of the
    // current "enabled" flag, while the routing engine itself still only
    // blocks requests when the corresponding rule is enabled.
    if (patterns.length > 0 && patterns.some(pattern => urlString.includes(pattern))) {
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

    let requestSearchContentLower = (log && typeof log.requestSearchContent === 'string')
      ? log.requestSearchContent
      : ''
    let headersSearchLower = (log && typeof log.headersSearch === 'string')
      ? log.headersSearch
      : ''

    const matchesRequestBodySearch = requestBodySearch === '' || (
      (requestSearchContentLower && requestSearchContentLower.includes(requestBodySearchLower)) ||
      (headersSearchLower && headersSearchLower.includes(requestBodySearchLower))
    )

    if (!matchesRequestBodySearch) return false

    // Response body/headers search snapshot (cached when available)
    let responseSearchContentLower = (log && typeof log.responseSearchContent === 'string')
      ? log.responseSearchContent
      : ''
    let responseHeadersSearchLower = (log && typeof log.responseHeadersSearch === 'string')
      ? log.responseHeadersSearch
      : ''

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
  })

  const ordered = filtered.slice().reverse()
  const total = ordered.length

  return { ordered, total }
}

function filterLogsForApiRequest (req) {
  const query = req.query || {}

  const { ordered, total } = filterLogsCore(query)

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

  limit = Math.min(Math.max(limit, 1), MAX_LOG_ENTRIES)

  const start = Math.min(offset, total)
  const end = Math.min(start + limit, total)

  const items = ordered.slice(start, end).map(buildClientLogView)
  const hasMore = end < total

  return { items, total, hasMore }
}

function normalizeHostValue (value) {
  if (!value || typeof value !== 'string') return null
  return value.trim().toLowerCase().split(':')[0]
}

function parseUrlCandidate (candidate) {
  if (!candidate || typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
		const protocol = typeof parsed.protocol === 'string' ? parsed.protocol.toLowerCase() : ''
		if (protocol !== 'http:' && protocol !== 'https:') {
			return null
		}
    return {
      url: trimmed,
      host: normalizeHostValue(parsed.hostname) || null,
      hostWithPort: parsed.host.toLowerCase()
    }
  } catch (error) {
    return null
  }
}

function resolveTargetFromRequest (req) {
  const targetHeader = parseUrlCandidate(req.headers['x-target-url'])
  if (targetHeader) {
    return targetHeader
  }

  const rawUrl = typeof req.originalUrl === 'string' ? req.originalUrl : (typeof req.url === 'string' ? req.url : '')
  const requestUrl = rawUrl || ''

  if (/^(https?|wss?):\/\//i.test(requestUrl)) {
    const parsedRequestUrl = parseUrlCandidate(requestUrl)
    if (parsedRequestUrl) {
      return parsedRequestUrl
    }
  }

  const hostHeader = safeTrim(req.headers.host)
  const normalizedHeaderHost = normalizeHostValue(hostHeader)

  if (hostHeader && hostHeader !== `localhost:${PORT}` && hostHeader !== `127.0.0.1:${PORT}`) {
    const assumedProtocol = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || (req.protocol || (req.socket?.encrypted ? 'https' : 'http'))
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
 * Build a canonical routing context used for block/bypass decisions across
 * HTTP, HTTPS MITM, CONNECT and WebSocket flows.
 *
 * @param {object} [params]
 * @param {string} [params.requestUrl]
 * @param {string} [params.fullUrl]
 * @param {string} [params.host]
 * @param {string} [params.path]
 * @param {string} [params.targetUrl]
 * @param {string} [params.method]
 * @returns {{requestUrl: string, fullUrl: (string|null), host: (string|null), path: (string|null), targetUrl: (string|null), method: (string|undefined)}}
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
 * @param {{requestUrl?: string, fullUrl?: string|null, host?: string|null, path?: string|null, targetUrl?: string|null}} [params]
 * @returns {{hostCandidates: string[], valueCandidates: string[]}}
 */
function createBypassContext ({ requestUrl, fullUrl, host, path, targetUrl } = {}) {
  const hostCandidates = []
  const valueCandidates = []

  const pushHostCandidate = candidate => {
    const normalized = normalizeHostValue(candidate)
    if (normalized) hostCandidates.push(normalized)
  }

  const pushValueCandidate = candidate => {
    if (!candidate) return
    valueCandidates.push(candidate.toString().toLowerCase())
  }

  pushHostCandidate(host)
  pushValueCandidate(requestUrl)

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
 * Check whether a host string matches a bypass host pattern.
 *
 * @param {string} patternValue
 * @param {string} host
 * @returns {boolean}
 */
function hostPatternMatches (patternValue, host) {
  if (!patternValue || !host) return false
  if (patternValue.startsWith('.')) {
    const suffix = patternValue.slice(1)
    return host === suffix || host.endsWith(`.${suffix}`)
  }

  if (host === patternValue) return true
  if (host.endsWith(`.${patternValue}`)) return true

  return false
}

/**
 * Determine whether a request should be treated as an internal proxy/UI call
 * that must never be bypassed.
 *
 * @param {{host?: string|null, requestUrl?: string, fullUrl?: string|null, targetUrl?: string|null}} [input]
 * @returns {boolean}
 */
function isInternalProxyRequest (input = {}) {
  const host = normalizeHostValue(input.host) || ''
  if (!host && typeof input.requestUrl !== 'string' && typeof input.fullUrl !== 'string') {
    return false
  }

  const localHostnames = new Set(['localhost', '127.0.0.1'])
  if (host && localHostnames.has(host)) {
    return true
  }

  const portSuffixes = [`localhost:${PORT}`, `127.0.0.1:${PORT}`]
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
 * Decide whether a request should use a direct upstream connection instead of
 * going through the proxy/MITM logic, based on bypass mode and rules.
 *
 * @param {{requestUrl?: string, fullUrl?: string|null, host?: string|null, path?: string|null, targetUrl?: string|null}} input
 * @returns {boolean}
 */
function shouldUseDirectConnection (input) {
  // Never bypass internal proxy requests (API calls, UI, etc.)
  if (isInternalProxyRequest(input)) {
    return false
  }

  if (!filterRulesEnabled) {
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
 * @param {{requestUrl?: string, fullUrl?: string|null, host?: string|null, path?: string|null, targetUrl?: string|null, method?: string}} context
 * @returns {'block'|'direct'|'proxy'}
 */
function decideHttpHandling (context) {
  const requestUrl = context?.requestUrl || '/'
  const fullUrl = context?.fullUrl || null

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
 * @param {{requestUrl?: string, fullUrl?: string|null, host?: string|null, path?: string|null, targetUrl?: string|null, method?: string}} routingContext
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

const OMIT_HEADERS_BASE = ['proxy-connection', 'connection']
const OMIT_HEADERS_CONDITIONAL = ['if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since']

// Composed header omission sets used across different upstream flows to keep
// behaviour consistent while avoiding inline array duplication.
const OMIT_HEADERS_PROXY = ['x-target-url', ...OMIT_HEADERS_BASE, 'content-length', ...OMIT_HEADERS_CONDITIONAL]
const OMIT_HEADERS_MITM = [...OMIT_HEADERS_BASE, ...OMIT_HEADERS_CONDITIONAL]

// Precomputed omit sets for hot-path header forwarding helpers to avoid
// repeatedly lower-casing and allocating Sets for the same static lists.
const OMIT_HEADERS_PROXY_SET = new Set(OMIT_HEADERS_PROXY.map(header => header.toLowerCase()))
const OMIT_HEADERS_MITM_SET = new Set(OMIT_HEADERS_MITM.map(header => header.toLowerCase()))
const OMIT_HEADERS_BASE_SET = new Set(OMIT_HEADERS_BASE.map(header => header.toLowerCase()))

// Common response header omissions used when forwarding upstream responses.
// This constant is shared across call sites so sanitizeHeaders can cheaply
// specialise caching for this very frequent omit set.
const OMIT_RESPONSE_HEADERS = ['transfer-encoding', 'connection']
const OMIT_RESPONSE_HEADERS_KEY = 'connection,transfer-encoding'
const OMIT_RESPONSE_HEADERS_SET = new Set(OMIT_RESPONSE_HEADERS_KEY.split(','))

function createForwardHeaders (sourceHeaders, omit = [], overrides = {}) {
  const result = {}
  let omitSet

  if (omit === OMIT_HEADERS_PROXY) {
    omitSet = OMIT_HEADERS_PROXY_SET
  } else if (omit === OMIT_HEADERS_MITM) {
    omitSet = OMIT_HEADERS_MITM_SET
  } else if (omit === OMIT_HEADERS_BASE) {
    omitSet = OMIT_HEADERS_BASE_SET
  } else {
    omitSet = new Set(omit.map(header => header.toLowerCase()))
  }

  for (const headerName in sourceHeaders) {
    if (!Object.prototype.hasOwnProperty.call(sourceHeaders, headerName)) continue
    const lower = headerName.toLowerCase()
    if (omitSet.has(lower)) continue
    const value = sourceHeaders[headerName]
    if (value !== undefined) {
      result[headerName] = value
    }
  }

  for (const overrideName in overrides) {
    if (!Object.prototype.hasOwnProperty.call(overrides, overrideName)) continue
    result[overrideName] = overrides[overrideName]
  }

  return result
}

function selectDispatcher (urlString) {
  try {
    const parsed = new URL(urlString)
    return parsed.protocol === 'https:' ? httpsDispatcher : httpDispatcher
  } catch (error) {
    return httpDispatcher
  }
}

function createUpstreamRequestOptions (url, baseOptions, abortSignal) {
	const options = {
		...baseOptions,
		dispatcher: selectDispatcher(url),
		maxRedirections: 0
	}

	if (UPSTREAM_HEADERS_TIMEOUT_MS > 0) {
		options.headersTimeout = UPSTREAM_HEADERS_TIMEOUT_MS
	}

	if (UPSTREAM_BODY_TIMEOUT_MS > 0) {
		options.bodyTimeout = UPSTREAM_BODY_TIMEOUT_MS
	}

	if (abortSignal) {
		options.signal = abortSignal
	}

	return options
}

/**
 * Perform an upstream HTTP(S) request via Undici with standard dispatcher
 * selection and timeout handling, returning the raw response plus an
 * optional buffered body.
 *
 * This helper centralises the common request pattern used by the HTTP
 * bypass path, the main proxy middleware and the HTTPS MITM flows while
 * leaving logging and rewrite responsibilities to callers.
 *
 * @param {object} params
 * @param {string} params.url - Fully qualified upstream URL.
 * @param {string} params.method - HTTP method.
 * @param {object} params.headers - Headers to send upstream.
 * @param {any} [params.body] - Optional request body (Buffer, stream or string).
 * @param {AbortSignal} [params.abortSignal] - Optional abort signal.
 * @param {boolean} [params.bufferResponse=false] - Whether to buffer the entire response body.
 * @returns {Promise<{response: import('undici').Dispatcher.ResponseData, buffer: Buffer|null}>}
 */
async function performUpstreamRequest ({
  url,
  method,
  headers,
  body,
  abortSignal,
  bufferResponse = false
}) {
  const response = await request(
    url,
    createUpstreamRequestOptions(
      url,
      {
        method,
        headers,
        body
      },
      abortSignal
    )
  )

  let buffer = null
  if (bufferResponse) {
    buffer = response.body
      ? Buffer.from(await response.body.arrayBuffer())
      : Buffer.alloc(0)
  }

  return { response, buffer }
}

/**
 * Attach an AbortController to an HTTP response so that an upstream
 * request can be aborted automatically when the client connection
 * closes.
 *
 * @param {import('http').ServerResponse} res - HTTP response object.
 * @param {AbortController} abortController - Controller to abort.
 * @returns {() => void} The close listener that was attached.
 */
function attachAbortOnClose (res, abortController) {
  const onClose = () => {
    try {
      abortController.abort()
    } catch {}
  }

  res.on('close', onClose)
  return onClose
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
 * @param {object} [headers]
 * @returns {object}
 */
function stripIdentifyingHeaders (headers = {}) {
  if (!headers || typeof headers !== 'object') return {}

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

const sanitizedHeadersCache = new WeakMap()

/**
 * Return a copy of the given headers object with a specific set of header
 * names omitted. Results are cached per (headers, omitKey) pair to avoid
 * repeatedly walking large header objects for the same omit configuration.
 *
 * The OMIT_RESPONSE_HEADERS constant is special-cased to avoid rebuilding
 * both the cache key and omission Set on every call.
 *
 * @param {object} [headers]
 * @param {string[]} [omit]
 * @returns {object}
 */
function sanitizeHeaders (headers = {}, omit = []) {
  if (!headers || typeof headers !== 'object') return {}

  let omitKey = ''
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

  let cacheForHeaders = sanitizedHeadersCache.get(headers)
  if (!cacheForHeaders) {
    cacheForHeaders = new Map()
    sanitizedHeadersCache.set(headers, cacheForHeaders)
  }

  if (cacheForHeaders.has(omitKey)) {
    return cacheForHeaders.get(omitKey)
  }

  const sanitized = {}

  for (const [key, value] of Object.entries(headers)) {
    if (omitSet.has(key.toLowerCase())) continue
    if (value === undefined) continue
    sanitized[key] = value
  }

  cacheForHeaders.set(omitKey, sanitized)
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
 * @param {object} [headers]
 * @param {string[]} [omit]
 * @returns {object}
 */
function sanitizeAndStripIdentifyingHeaders (headers = {}, omit = []) {
  if (!headers || typeof headers !== 'object') return {}

  let omitSet = null

  if (omit === OMIT_RESPONSE_HEADERS) {
    // Fast-path for the most common omit configuration used when forwarding
    // upstream responses.
    omitSet = OMIT_RESPONSE_HEADERS_SET
  } else if (Array.isArray(omit) && omit.length) {
    omitSet = new Set(omit.map(header => header.toLowerCase()))
  }

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
function applyCacheBypassHeadersToResponse (res, sourceTag) {
  if (!res || typeof res.setHeader !== 'function') return
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    if (sourceTag) {
      res.setHeader('X-Proxy-Source', sourceTag)
    }
  } catch {}
}

/**
 * Attach cache-busting headers to a plain headers object used when forwarding
 * upstream responses (for example in HTTPS MITM flows).
 *
 * @param {object} headers
 */
function applyCacheBypassHeadersToObject (headers) {
  if (!headers || typeof headers !== 'object') return
  headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate'
  headers.Pragma = 'no-cache'
  headers.Expires = '0'
}

function createRawTunnel ({ clientSocket, targetHost, targetPort, head }) {
  const targetSocket = net.connect(targetPort, targetHost, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length) {
      targetSocket.write(head)
    }
    clientSocket.pipe(targetSocket)
    targetSocket.pipe(clientSocket)
  })

  const closeSockets = () => {
    try { clientSocket.destroy() } catch {}
    try { targetSocket.destroy() } catch {}
  }

  targetSocket.on('error', closeSockets)
  clientSocket.on('error', closeSockets)

  clientSocket.on('close', () => {
    try { targetSocket.end() } catch {}
  })

  targetSocket.on('close', () => {
    try { clientSocket.end() } catch {}
  })

  return targetSocket
}

function buildBypassInputFromHttpRequest (req, resolvedTarget) {
  const requestUrl = typeof req.url === 'string' ? req.url : '/'
  const hostHeader = typeof req.headers?.host === 'string' ? req.headers.host : ''
  const host = resolvedTarget?.host || normalizeHostValue(hostHeader)

  const assumedProtocol = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || (req.socket?.encrypted ? 'https' : 'http')

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
    host,
    path,
    targetUrl: resolvedTarget?.url,
    method: req.method
  })
}

/**
 * Try to handle an HTTP request using a direct upstream bypass when allowed
 * by the current block/bypass rules. Returns true if the request was fully
 * handled here.
 *
 * When a request is blocked we emit a "blocked" log entry. When it is
 * bypassed (handling === 'direct') we now emit a lightweight "direct"
 * log entry so redirected resources are visible in /api/logs and the
 * audit panel without changing the bypass behaviour itself.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
async function tryHandleHttpBypass (req, res) {
  if (req.method === 'CONNECT') return false
  const connectionHeader = typeof req.headers?.connection === 'string' ? req.headers.connection.toLowerCase() : ''
  const wantsUpgrade = Boolean(req.headers?.upgrade) || connectionHeader.includes('upgrade')
  if (wantsUpgrade) return false

  const resolvedTarget = resolveTargetFromRequest(req)
  const routingContext = buildBypassInputFromHttpRequest(req, resolvedTarget)
  const handling = decideHttpHandling(routingContext)

  const requestStart = Date.now()
  const requestUrl = typeof req.url === 'string' ? req.url : '/'
  const hostHeader = typeof req.headers?.host === 'string' ? req.headers.host : ''
  const protocol = req.socket?.encrypted ? 'https' : 'http'
  const authority = hostHeader || `localhost:${PORT}`
  const clientFacingUrl = `${protocol}://${authority}${requestUrl}`
  const clientIp = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown'

  if (handling === 'block') {
    if (interactiveModeEnabled) {
      const logEntry = createBaseLogEntry({
        requestStart,
        method: req.method,
        url: requestUrl,
        fullUrl: clientFacingUrl,
        headers: sanitizeAndStripIdentifyingHeaders(req.headers),
        source: 'blocked',
        clientIp
      })
      logEntry.statusCode = 204
      addLog(logEntry)
    }

    res.writeHead(204)
    res.end()
    return true
  }

  if (handling !== 'direct') {
    // Either blocked or proxied by the main Express pipeline.
    return false
  }

  const targetUrl = routingContext.targetUrl || routingContext.fullUrl

  if (!targetUrl) {
    res.writeHead(404)
    res.end('Bypass target unavailable')
    return true
  }

  const hasLogging = interactiveModeEnabled === true
  const logEntry = hasLogging
    ? createBaseLogEntry({
        requestStart,
        method: req.method,
        url: requestUrl,
        fullUrl: targetUrl,
        headers: sanitizeAndStripIdentifyingHeaders(req.headers),
        source: 'direct',
        clientIp
      })
    : null

  const abortController = new AbortController()
  const onClose = attachAbortOnClose(res, abortController)

  try {
    const upstreamStart = Date.now()
    incrementBypassedCount()

    const target = new URL(targetUrl)
    const omitHeaders = OMIT_HEADERS_BASE
    const headersToForward = createForwardHeaders(req.headers, omitHeaders, {
      host: target.host
    })

    const hasBody = !(req.method === 'GET' || req.method === 'HEAD')

    const { response: upstreamResponse } = await performUpstreamRequest({
      url: targetUrl,
      method: req.method,
      headers: headersToForward,
      body: hasBody ? req : undefined,
      abortSignal: abortController.signal,
      bufferResponse: false
    })

    if (logEntry) {
      logEntry.upstreamDurationMs = Date.now() - upstreamStart
      logEntry.targetUrl = targetUrl
      logEntry.statusCode = upstreamResponse.statusCode
      logEntry.responseHeaders = upstreamResponse.headers
      logEntry.responseBody = '[streamed direct response]'
      logEntry.responseSize = null
      addLog(logEntry)
    }

    const responseHeaders = sanitizeHeaders(upstreamResponse.headers, OMIT_RESPONSE_HEADERS)
    res.writeHead(upstreamResponse.statusCode, responseHeaders)

    if (req.method === 'HEAD') {
      res.end()
      if (upstreamResponse.body) {
        upstreamResponse.body.resume()
      }
    } else if (upstreamResponse.body) {
      upstreamResponse.body.pipe(res)
    } else {
      res.end()
    }
  } catch (error) {
    if (logEntry) {
      recordUpstreamErrorOnLog(logEntry, error)
    }
    if (!res.headersSent) {
      res.writeHead(502)
    }
    res.end('Bypass proxy error')
  } finally {
    res.removeListener('close', onClose)
  }

  return true
}

function createRawWebSocketTunnel ({ req, clientSocket, head, targetUrl }) {
  let parsed
  try {
    parsed = new URL(targetUrl)
  } catch (error) {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    clientSocket.destroy()
    return
  }

  const isSecure = parsed.protocol === 'https:' || parsed.protocol === 'wss:'
  const port = parsed.port ? Number(parsed.port) : (isSecure ? 443 : 80)
  const connectHandler = () => {
    const pathWithQuery = (parsed.pathname || '/') + (parsed.search || '')
    const requestLine = `${req.method} ${pathWithQuery || '/'} HTTP/${req.httpVersion}\r\n`
    const headerLines = []
    const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : []
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const name = rawHeaders[i]
      const value = rawHeaders[i + 1]
      if (!name || value === undefined) continue
      headerLines.push(`${name}: ${value}`)
    }

    targetSocket.write(requestLine + headerLines.join('\r\n') + '\r\n\r\n')
    if (head && head.length) {
      targetSocket.write(head)
    }

    clientSocket.pipe(targetSocket)
    targetSocket.pipe(clientSocket)
  }

  const socketOptions = {
    host: parsed.hostname,
    port
  }

  let targetSocket

  if (isSecure) {
    const tlsOptions = {
      ...socketOptions,
      servername: parsed.hostname
    }

    if (STRICT_TLS_ENABLED) {
      tlsOptions.rejectUnauthorized = true
      if (upstreamCaBundle) {
        tlsOptions.ca = upstreamCaBundle
      }
    } else {
      tlsOptions.rejectUnauthorized = false
    }

    targetSocket = tls.connect(tlsOptions, connectHandler)
  } else {
    targetSocket = net.connect(socketOptions, connectHandler)
  }

  const destroyBoth = () => {
    try { clientSocket.destroy() } catch {}
    try { targetSocket.destroy() } catch {}
  }

  targetSocket.on('error', () => {
    destroyBoth()
  })

  clientSocket.on('error', () => {
    destroyBoth()
  })

  clientSocket.on('close', () => {
    try { targetSocket.end() } catch {}
  })

  targetSocket.on('close', () => {
    try { clientSocket.end() } catch {}
  })
}

function shouldBypassRequest (input) {
  if (!filterRulesEnabled) return false
  if (!bypassMatchers.length) return false

  const context = createBypassContext(input)
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

// Load existing local resources on startup
function loadLocalResources () {
  const resourcesFile = path.join(STORAGE_DIR, 'resources.json')
  if (fs.existsSync(resourcesFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(resourcesFile, 'utf8'))
      localResources = new Map(Object.entries(data))
    } catch (error) {
      console.error('[proxy] Error loading local resources:', error)
    }
  }
}

async function saveLocalResources () {
  const resourcesFile = path.join(STORAGE_DIR, 'resources.json')
  const data = Object.fromEntries(localResources)
  try {
    await fsPromises.writeFile(resourcesFile, JSON.stringify(data, null, 2))
  } catch (error) {
    console.error('[proxy] Error saving local resources:', error)
  }
}

function getLocalResourcesList () {
  return Array.from(localResources.entries()).map(([url, data]) => ({
    url,
    ...data
  }))
}

/**
 * Stream a local resource file to an HTTP response with consistent
 * headers and error handling for both proxy and MITM flows.
 *
 * On error, a 500 JSON payload with a generic error message is sent.
 *
 * @param {import('http').ServerResponse} res
 * @param {{ filename: string, contentType: string }} resource
 * @param {{ sourceTag: string, errorPrefix: string }} options
 */
function serveLocalResourceStream (res, resource, { sourceTag, errorPrefix }) {
  const filePath = path.join(STORAGE_DIR, resource.filename)

  const sendError = () => {
    try {
      if (!res.headersSent) {
        res.statusCode = 500
        try {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
        } catch {}
        res.end(JSON.stringify({ error: 'Error serving local resource' }))
      } else {
        res.end()
      }
    } catch {
      try {
        res.end()
      } catch {}
    }
  }

  try {
    const stream = fs.createReadStream(filePath)

    try {
      if (!res.headersSent) {
        res.setHeader('Content-Type', resource.contentType)
        res.setHeader('X-Proxy-Source', sourceTag)
      }
    } catch {}

    stream.on('error', error => {
      console.error(`${errorPrefix}:`, error)
      sendError()
    })

    stream.pipe(res)
  } catch (error) {
    console.error(`${errorPrefix}:`, error)
    sendError()
  }
}

// Middleware
app.use(cors())
app.set('trust proxy', true)
app.use(bodyParser.raw({
  type: req => isProtoContentType(getHeaderCaseInsensitive(req.headers, 'content-type') || ''),
  limit: BODY_LIMIT,
  verify: captureRawBody,
  inflate: false
}))
app.use(bodyParser.json({ limit: BODY_LIMIT, verify: captureRawBody }))
app.use(bodyParser.urlencoded({ extended: true, limit: BODY_LIMIT, verify: captureRawBody }))

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, STORAGE_DIR)
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`
    cb(null, uniqueName)
  }
})
const upload = multer({ storage })

// Load resources and blocked URLs on startup
loadLocalResources()
loadBlockedUrls()
loadBypassUrls()
loadEditRules()
rebuildEditRuleCache()

// Initialize CA certificate
const CA = getOrCreateCA()

// API Routes for UI
app.get('/api/logs', (req, res) => {
  try {
    const { items, total, hasMore } = filterLogsForApiRequest(req)
    const offset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) || 0 : 0
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) || items.length : items.length

    res.json({
      items,
      total,
      hasMore,
      offset,
      limit
    })
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch logs' })
  }
})

app.get('/api/logs/export', (req, res) => {
  try {
    const query = req.query || {}
    const { ordered, total } = filterLogsCore(query)

    const items = ordered.map(log => ({
      ...log,
      fileType: getFileTypeFromLogEntry(log)
    }))

    res.json({ items, total })
  } catch (error) {
    res.status(500).json({ error: 'Failed to export logs' })
  }
})

// Get config
app.get('/api/config', (req, res) => {
  res.json({
    interactiveModeEnabled,
    editRulesEnabled,
    localResourcesEnabled,
    filterRulesEnabled,
    blockedRulesEnabled,
    filteredRequestCount: bypassedRequestCount,
    filterMode: getBypassMode()
  })
})

// Set interactive mode
app.post('/api/interactive-mode', (req, res) => {
  handleBooleanToggleEndpoint({
    req,
    res,
    assignValue: value => { interactiveModeEnabled = value },
    responseFieldName: 'interactiveModeEnabled',
    defaultEnabled: true
  })
})

// Set live edit rules mode
app.post('/api/edit-rules-mode', (req, res) => {
  handleBooleanToggleEndpoint({
    req,
    res,
    assignValue: value => { editRulesEnabled = value },
    responseFieldName: 'editRulesEnabled',
    defaultEnabled: true
  })
})

// Set local resources mode
app.post('/api/local-resources-mode', (req, res) => {
  handleBooleanToggleEndpoint({
    req,
    res,
    assignValue: value => { localResourcesEnabled = value },
    responseFieldName: 'localResourcesEnabled',
    defaultEnabled: true
  })
})

// Set global filter rules mode (enable/disable bypass/focus engine)
app.post('/api/filter-rules-mode', (req, res) => {
  handleBooleanToggleEndpoint({
    req,
    res,
    assignValue: value => { filterRulesEnabled = value },
    responseFieldName: 'filterRulesEnabled',
    defaultEnabled: true
  })
})

// Set blocked rules mode
app.post('/api/blocked-rules-mode', (req, res) => {
  handleBooleanToggleEndpoint({
    req,
    res,
    assignValue: value => { blockedRulesEnabled = value },
    responseFieldName: 'blockedRulesEnabled',
    defaultEnabled: true
  })
})

// Get filter mode
app.get('/api/filter-mode', (req, res) => {
  res.json({ filterMode: getBypassMode() })
})

// Set filter mode ("ignore" or "focus")
app.post('/api/filter-mode', (req, res) => {
  const { mode } = req.body || {}
  const normalized = typeof mode === 'string' ? mode.toLowerCase() : ''

  if (normalized !== 'ignore' && normalized !== 'focus') {
    return res.status(400).json({ error: 'Invalid filter mode. Expected "ignore" or "focus".' })
  }

  bypassMode = normalized
  persistConfig()
  rebuildBypassUrlsForCurrentMode()

  res.json({ success: true, filterMode: getBypassMode() })
})

app.get('/api/resources', (req, res) => {
  res.json(getLocalResourcesList())
})

app.post('/api/resources', upload.single('file'), async (req, res) => {
  try {
    const { url, contentType } = req.body || {}
    const rawUrl = safeTrim(url)

    if (!rawUrl) {
      return res.status(400).json({ error: 'URL is required' })
    }

    const normalizedContentType = safeTrim(contentType)

    let resourceData

    if (req.file) {
      // File upload
      resourceData = {
        type: 'file',
        filename: req.file.filename,
        originalName: req.file.originalname,
        contentType: normalizedContentType || req.file.mimetype,
        size: req.file.size,
        createdAt: new Date().toISOString(),
        enabled: true
      }
    } else if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'content') && req.body.content) {
      // Text/JSON content
      const filename = `${Date.now()}-content.txt`
      await fsPromises.writeFile(path.join(STORAGE_DIR, filename), req.body.content)
      resourceData = {
        type: 'text',
        filename,
        contentType: normalizedContentType || 'text/plain',
        size: req.body.content.length,
        createdAt: new Date().toISOString(),
        enabled: true
      }
    } else {
      return res.status(400).json({ error: 'File or content is required' })
    }

    localResources.set(rawUrl, resourceData)
    await saveLocalResources()

    res.json({
      success: true,
      message: 'Resource added successfully',
      resource: { url: rawUrl, ...resourceData }
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/resources/toggle', async (req, res) => {
  try {
    const { url, enabled } = req.body || {}
    const rawUrl = safeTrim(url)

    if (!rawUrl) {
      return res.status(400).json({ error: 'URL is required' })
    }

    if (!localResources.has(rawUrl)) {
      return res.status(404).json({ error: 'Resource not found' })
    }

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid "enabled" flag: expected a boolean.' })
    }

    const resource = localResources.get(rawUrl) || {}
    const nextEnabled = enabled !== false

    const updated = {
      ...resource,
      enabled: nextEnabled
    }

    localResources.set(rawUrl, updated)
    await saveLocalResources()

    res.json({ success: true, resource: { url: rawUrl, ...updated } })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.delete('/api/resources/:encodedUrl', async (req, res) => {
  try {
    const url = decodeURIComponent(req.params.encodedUrl)

    if (localResources.has(url)) {
      const resource = localResources.get(url)
      const filePath = path.join(STORAGE_DIR, resource.filename)

      try {
        await fsPromises.unlink(filePath)
      } catch (fsError) {
        // If the file is already missing, keep behaviour simple and just log
        if (!fsError || fsError.code !== 'ENOENT') {
          console.error('[proxy] Error deleting local resource file:', fsError)
          throw fsError
        }
      }

      localResources.delete(url)
      await saveLocalResources()

      res.json({ success: true, message: 'Resource deleted successfully' })
    } else {
      res.status(404).json({ error: 'Resource not found' })
    }
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.delete('/api/logs', (req, res) => {
  requestLogs = []
  bypassedRequestCount = 0
  bypassSuggestionStats.clear()
  logSuggestionMetadata = new WeakMap()
  dashboardStats = createEmptyDashboardStats()
  performanceStats = createEmptyPerformanceStats()
  routeStats = new Map()
  res.json({ success: true, message: 'Logs cleared' })
})

// Get all blocked rules
app.get('/api/blocked', (req, res) => {
  res.json(blockedRules)
})

// Add/update/remove blocked URL
app.post('/api/blocked', (req, res) => {
  const { id, url, action, enabled, name } = req.body || {}

  if (typeof action !== 'string') {
    return res.status(400).json({ error: 'Invalid action. Expected "add", "update" or "remove".' })
  }

  if (action === 'add') {
    const normalizedUrl = safeTrim(url)
    if (!normalizedUrl) {
      return res.status(400).json({ error: 'URL is required' })
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid "enabled" flag: expected a boolean.' })
    }

    const newRule = normalizeBlockedRule({ id, enabled, name, url: normalizedUrl })
    blockedRules.push(newRule)
    saveBlockedUrls()
  } else if (action === 'update') {
    if (typeof id !== 'string' || !id.trim()) {
      return res.status(400).json({ error: 'ID is required for update' })
    }
    const idx = blockedRules.findIndex(r => r.id === id)
    if (idx !== -1) {
      const existing = blockedRules[idx]
      const next = { ...existing }

      if (url !== undefined) {
        const normalizedUrl = safeTrim(url)
        if (!normalizedUrl) {
          return res.status(400).json({ error: 'URL is required' })
        }
        next.url = normalizedUrl
      }

      if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({ error: 'Invalid "enabled" flag: expected a boolean.' })
        }
        next.enabled = enabled
      }

      if (name !== undefined) {
        if (typeof name !== 'string') {
          return res.status(400).json({ error: 'Invalid "name" field: expected a string.' })
        }
        next.name = name
      }

      blockedRules[idx] = normalizeBlockedRule(next)
      saveBlockedUrls()
    } else {
      return res.status(404).json({ error: 'Rule not found' })
    }
  } else if (action === 'remove') {
    if (typeof id !== 'string' || !id.trim()) {
      return res.status(400).json({ error: 'ID is required for remove' })
    }
    blockedRules = blockedRules.filter(r => r.id !== id)
    saveBlockedUrls()
  } else {
    return res.status(400).json({ error: 'Invalid action. Expected "add", "update" or "remove".' })
  }

  res.json({ success: true, blockedRules })
})

// Get all filter rules
app.get('/api/filters', (req, res) => {
  try {
    const queryModeRaw = typeof req.query.mode === 'string' ? req.query.mode.toLowerCase() : null
    const effectiveMode = (queryModeRaw === 'focus' || queryModeRaw === 'ignore')
      ? queryModeRaw
      : getBypassMode()

    const rulesForMode = bypassRules
      .filter(rule => rule && rule.mode === effectiveMode)

    res.json(rulesForMode)
  } catch (error) {
    res.status(500).json({ error: 'Failed to load filter rules' })
  }
})

// Add/update/remove filter URL
app.post('/api/filters', (req, res) => {
  const { id, url, action, enabled, name, mode } = req.body || {}

  if (typeof action !== 'string') {
    return res.status(400).json({ error: 'Invalid action. Expected "add", "update" or "remove".' })
  }

  if (action === 'add') {
    const normalizedUrl = safeTrim(url)
    if (!normalizedUrl) {
      return res.status(400).json({ error: 'URL is required' })
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid "enabled" flag: expected a boolean.' })
    }

    const baseRule = {
      id,
      enabled,
      name,
      url: normalizedUrl,
      mode: typeof mode === 'string' ? mode : getBypassMode()
    }
    const newRule = normalizeBypassRule(baseRule)
    bypassRules.push(newRule)
    saveBypassUrls()
  } else if (action === 'update') {
    if (typeof id !== 'string' || !id.trim()) {
      return res.status(400).json({ error: 'ID is required for update' })
    }
    const ruleIndex = bypassRules.findIndex(r => r.id === id)
    if (ruleIndex !== -1) {
      const existing = normalizeBypassRule(bypassRules[ruleIndex])
      const nextModeRaw = typeof mode === 'string' ? mode.toLowerCase() : existing.mode
      const nextMode = (nextModeRaw === 'focus' || nextModeRaw === 'ignore') ? nextModeRaw : existing.mode

      let nextUrl = existing.url
      if (url !== undefined) {
        const normalizedUrl = safeTrim(url)
        if (!normalizedUrl) {
          return res.status(400).json({ error: 'URL is required' })
        }
        nextUrl = normalizedUrl
      }

      if (enabled !== undefined && typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Invalid "enabled" flag: expected a boolean.' })
      }

      if (name !== undefined && typeof name !== 'string') {
        return res.status(400).json({ error: 'Invalid "name" field: expected a string.' })
      }

      const updated = normalizeBypassRule({
        ...existing,
        url: nextUrl,
        enabled: enabled !== undefined ? enabled : existing.enabled,
        name: name !== undefined ? name : existing.name,
        mode: nextMode
      })

      bypassRules[ruleIndex] = updated
      saveBypassUrls()
    } else {
      return res.status(404).json({ error: 'Rule not found' })
    }
  } else if (action === 'remove') {
    if (typeof id !== 'string' || !id.trim()) {
      return res.status(400).json({ error: 'ID is required for remove' })
    }
    bypassRules = bypassRules.filter(r => r.id !== id)
    saveBypassUrls()
  } else {
    return res.status(400).json({ error: 'Invalid action. Expected "add", "update" or "remove".' })
  }

  res.json({ success: true, bypassRules })
})

app.get('/api/filters/suggestions', (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit, 10)
    const windowSize = Number.parseInt(req.query.windowSize, 10)

    const suggestions = computeBypassSuggestions({
      limit: Number.isNaN(limit) ? undefined : limit,
      windowSize: Number.isNaN(windowSize) ? undefined : windowSize
    })

    res.json({ suggestions })
  } catch (error) {
    res.status(500).json({ error: 'Failed to compute filter suggestions' })
  }
})

app.get('/api/filters/metrics', (req, res) => {
  res.json({
    totalFiltered: bypassedRequestCount,
    activeRules: bypassUrls.length
  })
})

app.get('/api/edit-rules', (req, res) => {
  res.json({ rules: editRules })
})

app.post('/api/edit-rules', (req, res) => {
  // Allow both legacy text rules and new jsonPath rules. The normalizeEditRule
  // helper is responsible for interpreting the payload and ensuring a
  // consistent internal representation.
  const raw = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null

  if (!raw) {
    return res.status(400).json({ error: 'Invalid payload: expected JSON object.' })
  }

  const rule = normalizeEditRule({
    ...raw,
    id: undefined // ensure normalizeEditRule generates/uses the new id
  })

  editRules.push(rule)
  saveEditRules()
  rebuildEditRuleCache()

  res.status(201).json({ rule })
})

app.put('/api/edit-rules/:id', (req, res) => {
  const { id } = req.params
  const idx = editRules.findIndex(rule => rule.id === id)
  if (idx === -1) {
    return res.status(404).json({ error: 'Rule not found' })
  }

  const existing = editRules[idx]
  const patch = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null

  if (!patch) {
    return res.status(400).json({ error: 'Invalid payload: expected JSON object.' })
  }

  const updated = normalizeEditRule({
    ...existing,
    ...patch,
    id: existing.id
  })

  editRules[idx] = updated
  saveEditRules()
  rebuildEditRuleCache()

  res.json({ rule: updated })
})

app.delete('/api/edit-rules/:id', (req, res) => {
  const { id } = req.params
  const before = editRules.length
  editRules = editRules.filter(rule => rule.id !== id)

  if (editRules.length === before) {
    return res.status(404).json({ error: 'Rule not found' })
  }

  saveEditRules()
  rebuildEditRuleCache()

  res.status(204).end()
})

app.get('/api/dashboard', (req, res) => {
  const { editedRequests, ...stats } = dashboardStats

  const perf = performanceStats

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
  /**
   * Build a serialisable snapshot of a single entry from routeStats with
   * derived averages and an effective handling mode based on observed sources.
   *
   * @param {{ host?: string, path?: string, count: number, totalMs: number, maxMs: number, totalResponseBytes?: number, sourceCounts?: Record<string, number> }} route
   * @returns {{ host: string, path: string, avgMs: number, maxMs: number, count: number, avgBytes: number, kbPerSecond: number, handling: string }}
   */
  const buildRouteSnapshot = route => {
    const avgMs = route.totalMs / route.count
    const totalBytes = typeof route.totalResponseBytes === 'number' ? route.totalResponseBytes : 0
    const avgBytes = route.count > 0 ? totalBytes / route.count : 0
    const kbPerSecond = route.totalMs > 0
      ? (totalBytes * 1000) / (1024 * route.totalMs)
      : 0

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
   * @param {object} a
   * @param {object} b
   * @returns {number}
   */
  const sortRouteSnapshots = (a, b) => {
    if (b.avgMs !== a.avgMs) return b.avgMs - a.avgMs
    if (b.maxMs !== a.maxMs) return b.maxMs - a.maxMs
    return b.count - a.count
  }

  const allRouteSnapshots = Array.from(routeStats.values())
    .filter(route => route.count > 0)
    .map(buildRouteSnapshot)

  const slowestRoutes = allRouteSnapshots
    .slice()
    .sort(sortRouteSnapshots)
    .slice(0, 10)

  const routesByHandling = {
    processed: allRouteSnapshots.filter(route => route.handling === 'processed').sort(sortRouteSnapshots).slice(0, 10),
    redirected: allRouteSnapshots.filter(route => route.handling === 'redirected').sort(sortRouteSnapshots).slice(0, 10),
    blocked: allRouteSnapshots.filter(route => route.handling === 'blocked').sort(sortRouteSnapshots).slice(0, 10),
    served: allRouteSnapshots.filter(route => route.handling === 'served').sort(sortRouteSnapshots).slice(0, 10)
  }

  res.json({
    stats,
    performance,
    payloads,
    routes: {
      slowest: slowestRoutes,
      byHandling: routesByHandling
    },
    resources: getLocalResourcesList(),
    blocked: blockedUrls,
    filterMetrics: {
      totalFiltered: bypassedRequestCount,
      activeRules: bypassUrls.length
    },
    editedRequests
  })
})

app.get('/api/audit', (req, res) => {
  try {
    const durations = []
    const errorBuckets = Object.create(null)
    const hostMap = new Map()

    for (const log of requestLogs) {
      if (typeof log.upstreamDurationMs === 'number' && log.upstreamDurationMs >= 0) {
        durations.push(log.upstreamDurationMs)

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
    }

    let latencyStats = null
    if (durations.length) {
      durations.sort((a, b) => a - b)

      const count = durations.length
      const min = durations[0]
      const max = durations[durations.length - 1]
      const sum = durations.reduce((acc, v) => acc + v, 0)
      const avg = sum / count

      const quantile = p => {
        if (!durations.length) return 0
        const idx = Math.min(durations.length - 1, Math.max(0, Math.round(p * (durations.length - 1))))
        return durations[idx]
      }

      latencyStats = {
        count,
        min,
        max,
        avg,
        median: quantile(0.5),
        p90: quantile(0.9),
        p99: quantile(0.99)
      }
    }

    const hostStats = Array.from(hostMap.values())
      .map(entry => ({
        host: entry.host,
        count: entry.count,
        avgDuration: entry.totalDuration / Math.max(1, entry.count)
      }))
      .sort((a, b) => b.avgDuration - a.avgDuration)
      .slice(0, 20)

    const totalErrors = Object.values(errorBuckets).reduce((acc, v) => acc + v, 0)

    res.json({
      latencyStats,
      errorBuckets,
      totalErrors,
      hostStats
    })
  } catch (error) {
    console.error('[proxy] Error building audit snapshot:', error)
    res.status(500).json({ error: 'Failed to build audit snapshot' })
  }
})

// Proxy middleware - handles all other requests
app.use('*', async (req, res) => {
  const requestUrl = req.originalUrl
  const fullUrl = req.protocol + '://' + req.get('host') + requestUrl
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown'
  const requestStart = Date.now()

  const hasLogging = interactiveModeEnabled === true

  // Log the request (only build a detailed log entry when interactive mode is enabled)
  const logEntry = hasLogging
    ? createBaseLogEntry({
        requestStart,
        method: req.method,
        url: requestUrl,
        fullUrl,
        headers: sanitizeAndStripIdentifyingHeaders(req.headers),
        source: 'unknown',
        clientIp
      })
    : null

  if (req.rawBody) {
    const { buffer: rewrittenRequestBuffer, connect: connectRequest } = applyConnectRewritesAndDecode(
      logEntry,
      req.rawBody,
      req.headers,
      { role: 'request', allowBodyRewriteFallback: false, updateContentEncoding: true }
    )

    req.rawBody = rewrittenRequestBuffer

    // For plain HTTP JSON requests (non-Connect), apply JSONPath rules (if any)
    // and update both the log entry and the raw body buffer so that edits
    // affect the actual forwarded request payload. Skip JSON work entirely
    // when there are no JSONPath rules and interactive logging is disabled.
    if (!connectRequest) {
      const compiledJsonPathRulesLocal = getCompiledJsonPathRules()
      const hasJsonPathRules = Array.isArray(compiledJsonPathRulesLocal) && compiledJsonPathRulesLocal.length > 0
      const wantsLogging = interactiveModeEnabled

      if (hasJsonPathRules || wantsLogging) {
        const { buffer: nextBuffer } = applyJsonRequestRewritesForLog({
          buffer: req.rawBody,
          headers: req.headers,
          requestUrl,
          fullUrl,
          logEntry
        })
        req.rawBody = nextBuffer
      }
    }
  } else if (req.body !== undefined) {
    if (logEntry) {
      logEntry.body = req.body
    }
  }

  // Check if we have an enabled local resource for this URL
  const localMatch = findMatchingLocalResource(requestUrl, fullUrl)

  if (localMatch) {
    const { url: matchedUrl, resource } = localMatch

    if (logEntry) {
      logEntry.source = 'local'
      logEntry.localResource = matchedUrl
      addLog(logEntry)
    }

    serveLocalResourceStream(res, resource, {
      sourceTag: 'local',
      errorPrefix: '[proxy] Error streaming local resource'
    })
  } else {
    // Resolve target URL/host using the same logic as the bypass/upgrade flows.
    const resolvedTarget = resolveTargetFromRequest(req)
    const resolvedTargetUrl = resolvedTarget ? resolvedTarget.url : null

    if (resolvedTargetUrl) {
      // Proxy to target URL
      // Proxying request (silent)

      const abortController = new AbortController()
      const onClose = attachAbortOnClose(res, abortController)

      try {
        const upstreamStart = Date.now()

        const target = new URL(resolvedTargetUrl)
        const omitHeaders = OMIT_HEADERS_PROXY
        let headersToForward = createForwardHeaders(req.headers, omitHeaders, {
          host: target.host,
          connection: 'close'
        })

        // Actively proxied HTTP requests drop identifying tracing headers
        // before any further header rewrites are applied.
        headersToForward = stripIdentifyingHeaders(headersToForward)

        const headerRewriteResult = applyEditRulesToHeaders(headersToForward, {
          requestUrl,
          fullUrl,
          phase: 'request'
        })
        if (headerRewriteResult.changed) {
          headersToForward = headerRewriteResult.headers
          attachRewriteMetadata(logEntry, headerRewriteResult.appliedRuleIds)
        }

        let body
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
            // req.rawBody has already been rewritten by applyConnectFrameRewrites above
            // Just use it directly for forwarding
            body = req.rawBody

            headersToForward['content-length'] = body.length
          } else if (req.body !== undefined) {
            const isJson = (getHeaderCaseInsensitive(headersToForward, 'content-type') || '').includes('application/json')
            const rawBodyString = isJson && typeof req.body !== 'string' ? JSON.stringify(req.body) : req.body
            const textBody = typeof rawBodyString === 'string' ? rawBodyString : ''
            const rewriteResult = applyEditRulesToText(textBody, {
              requestUrl,
              fullUrl,
              phase: 'request'
            })
            body = rewriteResult.changed ? rewriteResult.text : rawBodyString
            if (rewriteResult.changed) {
              attachRewriteMetadata(logEntry, rewriteResult.appliedRuleIds)
            }
            if (typeof body === 'string') {
              headersToForward['content-length'] = Buffer.byteLength(body)
            }
          }
        }

        const { response: upstreamResponse } = await performUpstreamRequest({
          url: resolvedTargetUrl,
          method: req.method,
          headers: headersToForward,
          body,
          abortSignal: abortController.signal,
          bufferResponse: false
        })

        logEntry.upstreamDurationMs = Date.now() - upstreamStart

        let upstreamHeaders = upstreamResponse.headers
        const responseHeaderRewriteResult = applyEditRulesToHeaders(upstreamHeaders, {
          requestUrl,
          fullUrl,
          phase: 'response'
        })
        if (responseHeaderRewriteResult.changed) {
          upstreamHeaders = responseHeaderRewriteResult.headers
          attachRewriteMetadata(logEntry, responseHeaderRewriteResult.appliedRuleIds)
        }

        const contentType = getHeaderCaseInsensitive(upstreamHeaders, 'content-type') || ''
        const contentEncoding = getHeaderCaseInsensitive(upstreamHeaders, 'content-encoding') || ''

        const isBinary = isClearlyBinaryContentType(contentType)

        const compiledTextRules = getCompiledRules()
        const compiledJsonPathRulesLocal = getCompiledJsonPathRules()
        const hasAnyEditRules =
          (Array.isArray(compiledTextRules) && compiledTextRules.length > 0) ||
          (Array.isArray(compiledJsonPathRulesLocal) && compiledJsonPathRulesLocal.length > 0)

        let needsInspection = hasAnyEditRules || !isBinary || shouldDecompress(contentType)

        if (!interactiveModeEnabled && !hasAnyEditRules) {
          // When logging is disabled and there are no active edit rules, avoid
          // buffering large responses purely for preview/logging. Allow
          // uninspected streaming for responses that would otherwise only be
          // inspected for logging purposes.
          needsInspection = false
        }

        const canStreamUninspected =
          STREAM_UNINSPECTED_RESPONSES &&
          upstreamResponse.body &&
          !needsInspection &&
          req.method !== 'HEAD'

        if (canStreamUninspected) {
          if (logEntry) {
            logEntry.source = 'proxied'
            logEntry.targetUrl = resolvedTargetUrl
            logEntry.fullUrl = resolvedTargetUrl // Use target URL instead of proxy URL
            logEntry.statusCode = upstreamResponse.statusCode
            logEntry.responseHeaders = upstreamHeaders
            logEntry.responseBody = '[streamed binary response]'
            logEntry.responseSize = null
            addLog(logEntry)
          }

          const forwardedResponseHeaders = sanitizeAndStripIdentifyingHeaders(
            upstreamHeaders,
            OMIT_RESPONSE_HEADERS
          )
          Object.entries(forwardedResponseHeaders).forEach(([key, value]) => {
            res.setHeader(key, value)
          })

          applyCacheBypassHeadersToResponse(res, 'remote')

          res.status(upstreamResponse.statusCode)
          upstreamResponse.body.pipe(res)
          return
        }

        const responseBuffer = upstreamResponse.body
          ? Buffer.from(await upstreamResponse.body.arrayBuffer())
          : Buffer.alloc(0)

        // Unified Connect pipeline: rewrite (if applicable) and decode from a single pass.
        const {
          buffer: effectiveResponseBuffer,
          connect: connectResponse
        } = applyConnectRewritesAndDecode(
          logEntry,
          responseBuffer,
          upstreamHeaders,
          { role: 'response', allowBodyRewriteFallback: true, updateContentEncoding: true }
        )

        // Parse response body for logging (only when logging is enabled)
        let responseBody = ''

        if (logEntry) {
          const view = buildHttpResponseLoggingView({
            logEntry,
            buffer: effectiveResponseBuffer,
            contentType,
            contentEncoding,
            isBinary,
            connectResponse,
            allowUnaryConnectText: false
          })
          responseBody = view.body

          logEntry.source = 'proxied'
          logEntry.targetUrl = resolvedTargetUrl
          logEntry.fullUrl = resolvedTargetUrl // Use target URL instead of proxy URL
          logEntry.statusCode = upstreamResponse.statusCode
          logEntry.responseHeaders = upstreamHeaders
          if (!connectResponse) {
            logEntry.responseBody = responseBody
          }
          logEntry.responseSize = effectiveResponseBuffer.length
          addLog(logEntry)
        }

        res.status(upstreamResponse.statusCode)

        const forwardedResponseHeaders = sanitizeAndStripIdentifyingHeaders(
          upstreamHeaders,
          OMIT_RESPONSE_HEADERS
        )
        Object.entries(forwardedResponseHeaders).forEach(([key, value]) => {
          res.setHeader(key, value)
        })

        applyCacheBypassHeadersToResponse(res, 'remote')

        if (req.method === 'HEAD') {
          res.end()
        } else {
          res.send(effectiveResponseBuffer)
        }
      } catch (error) {
        if (logEntry) {
          recordUpstreamErrorOnLog(logEntry, error)
        }

        res.status(502).json({ error: 'Proxy error', message: error.message })
      } finally {
        res.removeListener('close', onClose)
      }
    } else {
      // No local resource and no target URL (likely WebSocket or direct connection)
      if (logEntry) {
        logEntry.source = 'websocket'
        addLog(logEntry)
      }

      res.status(404).json({
        error: 'No local resource found and no target URL specified',
        hint: 'Add X-Target-URL header with the destination URL or configure a local resource'
      })
    }
  }
})

const server = http.createServer((req, res) => {
  tryHandleHttpBypass(req, res)
    .then(handled => {
      if (!handled && !res.writableEnded) {
        app(req, res)
      }
    })
    .catch(() => {
      if (!res.headersSent) {
        res.writeHead(500)
      }
      res.end('Internal proxy error')
    })
})

server.on('upgrade', (req, socket, head) => {
  const resolvedTarget = resolveTargetFromRequest(req)
  const bypassInput = buildBypassInputFromHttpRequest(req, resolvedTarget)
  const decision = decideWebSocketHandling(bypassInput)
  const targetUrl = bypassInput.targetUrl || bypassInput.fullUrl

  if (!targetUrl) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }

  if (decision.action === 'block') {
    socket.write('HTTP/1.1 204 No Content\r\n\r\n')
    socket.destroy()
    return
  }

  if (decision.action === 'direct') {
    incrementBypassedCount()

    if (interactiveModeEnabled) {
      const wsUrl = (targetUrl || '').replace('https://', 'wss://').replace('http://', 'ws://')
      const logEntry = {
        id: Date.now() + Math.random(),
        timestamp: new Date().toISOString(),
        method: 'WS',
        url: wsUrl || targetUrl || '',
        fullUrl: wsUrl || targetUrl || '',
        source: 'direct',
        direction: 'connected',
        isConnectionLog: true,
        headers: sanitizeAndStripIdentifyingHeaders(req.headers || {}),
        body: 'WebSocket direct tunnel established',
        responseBody: null,
        responseHeaders: null,
        statusCode: 101
      }
      addLog(logEntry)
    }

    createRawWebSocketTunnel({
      req,
      clientSocket: socket,
      head,
      targetUrl
    })
    return
  }

  let parsed
  try {
    parsed = new URL(targetUrl)
  } catch (error) {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    socket.destroy()
    return
  }

  const targetHost = parsed.hostname
  const targetPort = parsed.port ? Number(parsed.port) : ((parsed.protocol === 'https:' || parsed.protocol === 'wss:') ? 443 : 80)

  handleWebSocketUpgrade(req, socket, targetHost, targetPort, targetUrl, { bypass: false })
})

// WebSocket upgrade handler
function handleWebSocketUpgrade (clientReq, clientSocket, targetHost, targetPort, fullUrl, { bypass = false } = {}) {
  const wsUrl = fullUrl.replace('https://', 'wss://').replace('http://', 'ws://')
  // Establishing WebSocket connection (silent)

  const connectionId = Date.now() + Math.random()
  const connectionStartTs = Date.now()
  const wsMetrics = {
    connectionId,
    wsUrl,
    messagesClientToServer: 0,
    messagesServerToClient: 0,
    bytesClientToServer: 0,
    bytesServerToClient: 0,
    rewrittenMessages: 0
  }
  let summaryLogged = false

  const logWebSocketSummary = (reason) => {
    if (summaryLogged || bypass) return
    summaryLogged = true

    const durationMs = Date.now() - connectionStartTs

    const summaryLog = {
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      method: 'WS',
      url: wsUrl,
      fullUrl: wsUrl,
      source: 'websocket',
      direction: 'summary',
      isConnectionLog: true,
      isWebSocketSummary: true,
      connectionId,
      wsSummary: {
        ...wsMetrics,
        durationMs,
        closeReason: reason || null
      },
      headers: {},
      body: `[WS summary] C->S: ${wsMetrics.messagesClientToServer} messages / ${wsMetrics.bytesClientToServer} bytes, ` +
        `S->C: ${wsMetrics.messagesServerToClient} messages / ${wsMetrics.bytesServerToClient} bytes, ` +
        `rewritten: ${wsMetrics.rewrittenMessages}, duration: ${durationMs}ms`,
      responseBody: null,
      responseHeaders: null
    }

    addLog(summaryLog)
  }

  try {
    // Prepare headers for target WebSocket connection
    const wsHeaders = {}

    // Copy important headers
    const headersToForward = [
      'user-agent',
      'origin',
      'sec-websocket-version',
      'sec-websocket-key',
      'sec-websocket-extensions',
      'sec-websocket-protocol',
      'cookie',
      'authorization'
    ]

    headersToForward.forEach(header => {
      if (clientReq.headers[header]) {
        wsHeaders[header] = clientReq.headers[header]
      }
    })

    // Override host
    wsHeaders.host = targetHost

    // Create WebSocket connection to target server
    const wsTlsOptions = {}
    if (STRICT_TLS_ENABLED) {
      wsTlsOptions.rejectUnauthorized = true
      if (upstreamCaBundle) {
        wsTlsOptions.ca = upstreamCaBundle
      }
    } else {
      wsTlsOptions.rejectUnauthorized = false // Accept self-signed certs (dev default)
    }

    const targetWs = new WebSocket(wsUrl, {
      headers: wsHeaders,
      ...wsTlsOptions
    })

    targetWs.on('open', () => {
      // WebSocket connected (silent)

      if (!bypass) {
        // Log WebSocket connection establishment
        const connectionLog = {
          id: Date.now() + Math.random(),
          timestamp: new Date().toISOString(),
          method: 'WS',
          url: wsUrl,
          fullUrl: wsUrl,
          source: 'websocket',
          direction: 'connected',
          isConnectionLog: true, // Flag to identify connection logs
          connectionId,
          headers: clientReq.headers,
          body: 'WebSocket connection established',
          responseBody: null,
          responseHeaders: null,
          statusCode: 101
        }
        addLog(connectionLog)
      }

      // Send upgrade response to client
      const upgradeHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${generateWebSocketAccept(clientReq.headers['sec-websocket-key'])}`
      ]

      if (clientReq.headers['sec-websocket-protocol']) {
        upgradeHeaders.push(`Sec-WebSocket-Protocol: ${clientReq.headers['sec-websocket-protocol']}`)
      }

      clientSocket.write(upgradeHeaders.join('\r\n') + '\r\n\r\n')

      // Pipe data bidirectionally with logging
      targetWs.on('message', (data, isBinary) => {
        if (!clientSocket.writable) return

        if (bypass) {
          const payloadBuffer = normalizeWebSocketPayload(data)
          const frame = createWebSocketFrame(payloadBuffer, isBinary)
          clientSocket.write(frame)
          return
        }

        if (!WS_LOG_BODY_ENABLED) {
          // Light WebSocket mode: forward payload as-is and log only basic
          // metadata (direction, size, binary/text), without decoding or
          // applying text rewrites.
          const payloadBuffer = normalizeWebSocketPayload(data)
          const size = payloadBuffer.length
          wsMetrics.messagesServerToClient += 1
          wsMetrics.bytesServerToClient += size

          const frame = createWebSocketFrame(payloadBuffer, isBinary)
          clientSocket.write(frame)

          logWebSocketMessage({
            direction: 'server->client',
            wsUrl,
            connectionId,
            payloadBuffer,
            isBinary,
            loggingDisabled: true
          })
          return
        }

        const { buffer: payloadBuffer, rewrites, body, originalBody } = applyWebSocketRewritesAndDescribe(
          data,
          isBinary,
          {
            requestUrl: wsUrl,
            fullUrl: wsUrl,
            // WebSocket frames coming from the upstream server correspond to
            // the "response" phase for JSONPath rules.
            phase: 'response'
          }
        )
        const frame = createWebSocketFrame(payloadBuffer, isBinary)
        clientSocket.write(frame)

        const size = payloadBuffer.length
        wsMetrics.messagesServerToClient += 1
        wsMetrics.bytesServerToClient += size
        if (Array.isArray(rewrites) && rewrites.length) {
          wsMetrics.rewrittenMessages += 1
        }

        // Log WebSocket message from server to client
        logWebSocketMessage({
          direction: 'server->client',
          wsUrl,
          connectionId,
          payloadBuffer,
          isBinary,
          bodyText: body,
          rewrites,
          originalBodyText: originalBody
        })
      })

      clientSocket.on('data', (data) => {
        try {
          const decoded = decodeWebSocketFrame(data)
          if (!decoded || targetWs.readyState !== WebSocket.OPEN) return

          if (bypass) {
            const payloadBuffer = decoded.payload
            if (decoded.isBinary) {
              targetWs.send(payloadBuffer, { binary: true })
            } else {
              targetWs.send(payloadBuffer.toString('utf8'), { binary: false })
            }
            return
          }

          if (!WS_LOG_BODY_ENABLED) {
            // Light WebSocket mode: forward decoded payload as-is and log
            // only basic metadata instead of full body content.
            const payloadBuffer = decoded.payload
            if (decoded.isBinary) {
              targetWs.send(payloadBuffer, { binary: true })
            } else {
              targetWs.send(payloadBuffer.toString('utf8'), { binary: false })
            }

            const size = payloadBuffer.length
            wsMetrics.messagesClientToServer += 1
            wsMetrics.bytesClientToServer += size

            logWebSocketMessage({
              direction: 'client->server',
              wsUrl,
              connectionId,
              payloadBuffer,
              isBinary: decoded.isBinary,
              loggingDisabled: true
            })
            return
          }

          const { buffer: payloadBuffer, rewrites, body, originalBody } = applyWebSocketRewritesAndDescribe(
            decoded.payload,
            decoded.isBinary,
            {
              requestUrl: wsUrl,
              fullUrl: wsUrl,
              // Frames sent by the client map to the "request" phase for
              // JSONPath rules.
              phase: 'request'
            }
          )

          if (decoded.isBinary) {
            targetWs.send(payloadBuffer, { binary: true })
          } else {
            targetWs.send(payloadBuffer.toString('utf8'), { binary: false })
          }

          const size = payloadBuffer.length
          wsMetrics.messagesClientToServer += 1
          wsMetrics.bytesClientToServer += size
          if (Array.isArray(rewrites) && rewrites.length) {
            wsMetrics.rewrittenMessages += 1
          }

          // Log WebSocket message from client to server
          logWebSocketMessage({
            direction: 'client->server',
            wsUrl,
            connectionId,
            payloadBuffer,
            isBinary: decoded.isBinary,
            bodyText: body,
            rewrites,
            originalBodyText: originalBody
          })
        } catch (e) {
        }
      })
    })

    targetWs.on('error', () => {
      logWebSocketSummary('target-error')
      clientSocket.end()
    })

    targetWs.on('close', () => {
      // WebSocket target closed (silent)
      logWebSocketSummary('target-closed')
      clientSocket.end()
    })

    clientSocket.on('error', () => {
      logWebSocketSummary('client-error')
      targetWs.close()
    })

    clientSocket.on('close', () => {
      // WebSocket client closed (silent)
      logWebSocketSummary('client-closed')
      targetWs.close()
    })
  } catch {
    clientSocket.end()
  }
}

// WebSocket helper functions
function generateWebSocketAccept (key) {
  return crypto.createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64')
}

function createWebSocketFrame (data, isBinary) {
  const payload = Buffer.from(data)
  const payloadLength = payload.length
  let frame

  if (payloadLength < 126) {
    frame = Buffer.allocUnsafe(2 + payloadLength)
    frame[0] = isBinary ? 0x82 : 0x81 // FIN + opcode
    frame[1] = payloadLength
    payload.copy(frame, 2)
  } else if (payloadLength < 65536) {
    frame = Buffer.allocUnsafe(4 + payloadLength)
    frame[0] = isBinary ? 0x82 : 0x81
    frame[1] = 126
    frame.writeUInt16BE(payloadLength, 2)
    payload.copy(frame, 4)
  } else {
    frame = Buffer.allocUnsafe(10 + payloadLength)
    frame[0] = isBinary ? 0x82 : 0x81
    frame[1] = 127
    frame.writeUInt32BE(0, 2)
    frame.writeUInt32BE(payloadLength, 6)
    payload.copy(frame, 10)
  }

  return frame
}

function decodeWebSocketFrame (buffer) {
  if (buffer.length < 2) return null

  const firstByte = buffer[0]
  const secondByte = buffer[1]

  const isFinal = (firstByte & 0x80) !== 0
  const opcode = firstByte & 0x0F
  const isMasked = (secondByte & 0x80) !== 0
  let payloadLength = secondByte & 0x7F
  let offset = 2

  if (payloadLength === 126) {
    if (buffer.length < 4) return null
    payloadLength = buffer.readUInt16BE(2)
    offset = 4
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null
    payloadLength = buffer.readUInt32BE(6)
    offset = 10
  }

  let maskingKey
  if (isMasked) {
    if (buffer.length < offset + 4) return null
    maskingKey = buffer.slice(offset, offset + 4)
    offset += 4
  }

  if (buffer.length < offset + payloadLength) return null

  let payload = buffer.slice(offset, offset + payloadLength)

  if (isMasked && maskingKey) {
    payload = Buffer.from(payload)
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskingKey[i % 4]
    }
  }

  return {
    isFinal,
    opcode,
    isBinary: opcode === 2,
    payload
  }
}

server.on('connect', (req, clientSocket, head) => {
  const clientIp = clientSocket.remoteAddress
  // CONNECT MITM requested (silent)

  let targetUrl
  try {
    targetUrl = new URL(`http://${req.url}`)
  } catch (error) {
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    clientSocket.end()
    return
  }

  const targetHost = targetUrl.hostname
  const targetPort = targetUrl.port || 443

  const routingContext = buildRoutingContext({
    requestUrl: '/',
    fullUrl: `https://${targetHost}`,
    host: targetHost,
    path: '/',
    targetUrl: `https://${targetHost}`,
    method: req.method
  })

  const httpHandling = decideHttpHandling(routingContext)

  if (httpHandling === 'direct') {
    incrementBypassedCount()

    if (interactiveModeEnabled) {
      const requestStart = Date.now()
      const fullUrl = `https://${targetHost}`
      const logEntry = createBaseLogEntry({
        requestStart,
        method: req.method,
        url: '/',
        fullUrl,
        headers: sanitizeAndStripIdentifyingHeaders(req.headers),
        source: 'tunnel',
        clientIp
      })
      // Represent the raw CONNECT tunnel by its 200 Connection Established
      // handshake for auditing purposes.
      logEntry.statusCode = 200
      addLog(logEntry)
    }

    const targetSocket = createRawTunnel({
      clientSocket,
      targetHost,
      targetPort,
      head
    })

    targetSocket.on('error', error => {
      if (error && error.code === 'ECONNRESET') {
        return
      }
    })

    return
  }

  // Generate certificate for this host
  const cert = generateCertForHost(targetHost, CA)

  // Create HTTPS server for this connection
  const httpsServerOptions = {
    key: cert.key,
    cert: cert.cert,
    maxHeaderSize: 16384, // 16KB header limit (default is 8KB)
    SNICallback: (servername, cb) => {
      const sniCert = generateCertForHost(servername, CA)
      cb(null, require('tls').createSecureContext({
        key: sniCert.key,
        cert: sniCert.cert
      }))
    }
  }

  // Tell client the tunnel is established
  clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: Cascade-Proxy-MITM\r\n\r\n')

  // Create HTTPS server to decrypt client traffic
  const httpsServer = https.createServer(httpsServerOptions, async (clientReq, clientRes) => {
    const requestUrl = clientReq.url
    const fullUrl = `https://${targetHost}${requestUrl}`
    const method = clientReq.method
    const requestStart = Date.now()
    const clientIp = clientReq.socket?.remoteAddress || clientReq.connection?.remoteAddress || 'unknown'
    const parsedFullUrl = new URL(fullUrl)

    // MITM decrypted request (silent)

    // Check if this is a WebSocket upgrade request
    if (clientReq.headers.upgrade && clientReq.headers.upgrade.toLowerCase() === 'websocket') {
      const wsRoutingContext = buildRoutingContext({
        requestUrl,
        fullUrl,
        host: targetHost,
        path: parsedFullUrl.pathname,
        targetUrl: fullUrl,
        method
      })
      const wsDecision = decideWebSocketHandling(wsRoutingContext)

      if (wsDecision.action === 'block') {
        clientReq.socket.write('HTTP/1.1 204 No Content\r\n\r\n')
        clientReq.socket.destroy()
        return
      }

      // Attach header so WebSocket handler can reuse resolved info
      clientReq.headers['x-target-url'] = clientReq.headers['x-target-url'] ||
        `${parsedFullUrl.protocol}//${parsedFullUrl.host}${parsedFullUrl.pathname || ''}`

      if (wsDecision.action === 'direct') {
        // In HTTPS MITM we cannot create a true raw tunnel here because TLS has
        // already been terminated. Approximate "direct" by disabling rewrites
        // and logging (bypass=true) while still using the MITM TLS tunnel.
        incrementBypassedCount()

        if (interactiveModeEnabled) {
          const wsUrl = fullUrl.replace('https://', 'wss://').replace('http://', 'ws://')
          const logEntry = {
            id: Date.now() + Math.random(),
            timestamp: new Date().toISOString(),
            method: 'WS',
            url: wsUrl,
            fullUrl: wsUrl,
            source: 'direct',
            direction: 'connected',
            isConnectionLog: true,
            headers: sanitizeAndStripIdentifyingHeaders(clientReq.headers || {}),
            body: 'WebSocket direct tunnel established (MITM bypass)',
            responseBody: null,
            responseHeaders: null,
            statusCode: 101
          }
          addLog(logEntry)
        }

        handleWebSocketUpgrade(clientReq, clientReq.socket, targetHost, targetPort, fullUrl, { bypass: true })
        return
      }

      // WebSocket upgrade with full MITM (rewrites + logging)
      handleWebSocketUpgrade(clientReq, clientReq.socket, targetHost, targetPort, fullUrl, { bypass: false })
      return
    }

    // Collect request body
    let body = []
    clientReq.on('data', chunk => body.push(chunk))
    clientReq.on('end', async () => {
      body = Buffer.concat(body)

      const routingContext = buildRoutingContext({
        requestUrl,
        fullUrl,
        host: targetHost,
        path: parsedFullUrl.pathname,
        targetUrl: fullUrl,
        method
      })

      const httpHandling = decideHttpHandling(routingContext)

      if (httpHandling === 'direct') {
        const abortController = new AbortController()
        const onClose = attachAbortOnClose(clientRes, abortController)

        const hasLogging = interactiveModeEnabled === true
        const directLogEntry = hasLogging
          ? createBaseLogEntry({
              requestStart,
              method,
              url: requestUrl,
              fullUrl,
              headers: sanitizeAndStripIdentifyingHeaders(clientReq.headers),
              source: 'direct',
              clientIp
            })
          : null

        try {
          const upstreamStart = Date.now()
          incrementBypassedCount()

          const omitHeaders = OMIT_HEADERS_MITM
          let headersToForward = createForwardHeaders(clientReq.headers, omitHeaders, {
            host: targetHost
          })

          if (MITM_BYPASS_REWRITES_ENABLED) {
            // Actively proxied MITM requests drop identifying tracing headers
            // before header rewrite rules are applied.
            headersToForward = stripIdentifyingHeaders(headersToForward)

            const headerRewriteResult = applyEditRulesToHeaders(headersToForward, {
              requestUrl,
              fullUrl,
              phase: 'request'
            })
            if (headerRewriteResult.changed) {
              headersToForward = headerRewriteResult.headers
              attachRewriteMetadata(directLogEntry, headerRewriteResult.appliedRuleIds)
            }
          }

          if (body.length > 0) {
            headersToForward['content-length'] = body.length
          }

          const shouldBuffer = MITM_BYPASS_REWRITES_ENABLED === true

          const { response: upstreamResponse, buffer: responseBufferRaw } = await performUpstreamRequest({
            url: fullUrl,
            method,
            headers: headersToForward,
            body: body.length > 0 ? body : undefined,
            abortSignal: abortController.signal,
            bufferResponse: shouldBuffer
          })

          let upstreamHeaders = upstreamResponse.headers

          let responseBuffer = responseBufferRaw

          if (MITM_BYPASS_REWRITES_ENABLED && responseBuffer) {
            const responseHeaderRewriteResult = applyEditRulesToHeaders(upstreamHeaders, {
              requestUrl,
              fullUrl,
              phase: 'response'
            })
            if (responseHeaderRewriteResult.changed) {
              upstreamHeaders = responseHeaderRewriteResult.headers
              attachRewriteMetadata(directLogEntry, responseHeaderRewriteResult.appliedRuleIds)
            }

            const connectResult = applyConnectRewritesForBypass(
              responseBufferRaw,
              upstreamHeaders,
              { requestUrl, fullUrl }
            )
            responseBuffer = connectResult.buffer
          }

          if (directLogEntry) {
            directLogEntry.upstreamDurationMs = Date.now() - upstreamStart
            directLogEntry.targetUrl = fullUrl
            directLogEntry.statusCode = upstreamResponse.statusCode
            directLogEntry.responseHeaders = upstreamHeaders
            if (shouldBuffer && responseBuffer) {
              directLogEntry.responseBody = '[bypass mitm buffered response]'
              directLogEntry.responseSize = responseBuffer.length
            } else {
              directLogEntry.responseBody = '[streamed direct response]'
              directLogEntry.responseSize = null
            }
            addLog(directLogEntry)
          }

          const filteredHeaders = sanitizeHeaders(upstreamHeaders, OMIT_RESPONSE_HEADERS)
          clientRes.writeHead(upstreamResponse.statusCode, filteredHeaders)

          if (MITM_BYPASS_REWRITES_ENABLED && responseBuffer && responseBuffer.length > 0) {
            clientRes.end(responseBuffer)
          } else if (upstreamResponse.body) {
            upstreamResponse.body.pipe(clientRes)
          } else {
            clientRes.end()
          }
        } catch (error) {
          if (directLogEntry) {
            recordUpstreamErrorOnLog(directLogEntry, error)
          }
          if (!clientRes.headersSent) {
            clientRes.writeHead(502)
          }
          clientRes.end('Bypass proxy error')
        } finally {
          clientRes.removeListener('close', onClose)
        }
        return
      }

      const hasLogging = interactiveModeEnabled === true

      // Log to UI (only build a detailed log entry when interactive mode is enabled)
      const logEntry = hasLogging
        ? createBaseLogEntry({
            requestStart,
            method,
            url: requestUrl,
            fullUrl,
            headers: sanitizeAndStripIdentifyingHeaders(clientReq.headers),
            source: 'mitm',
            clientIp
          })
        : null

      // Blocked URLs are handled via decideHttpHandling; when the decision
      // is "block" we mirror the existing 204 behaviour while relying on the
      // shared decision logic used by HTTP/WS flows.
      if (httpHandling === 'block') {
        if (logEntry) {
          logEntry.source = 'blocked'
          logEntry.statusCode = 204
          addLog(logEntry)
        }

        // MITM blocked request (silent)
        clientRes.writeHead(204)
        return clientRes.end()
      }

      if (body.length > 0) {
        let { buffer: workingBody, connect: connectRequest } = applyConnectRewritesAndDecode(
          logEntry,
          body,
          clientReq.headers,
          { role: 'request', allowBodyRewriteFallback: true, updateContentEncoding: true }
        )

        if (!connectRequest) {
          const compiledJsonPathRulesLocal = getCompiledJsonPathRules()
          const hasJsonPathRules = Array.isArray(compiledJsonPathRulesLocal) && compiledJsonPathRulesLocal.length > 0
          const wantsLogging = interactiveModeEnabled

          if (hasJsonPathRules || wantsLogging) {
            const { buffer: nextBody } = applyJsonRequestRewritesForLog({
              buffer: workingBody,
              headers: clientReq.headers,
              requestUrl,
              fullUrl,
              logEntry
            }, {
              logNonJsonBody: true
            })

            workingBody = nextBody
          }
        }

        body = workingBody
      }

      // Check for enabled local resource
      const localMatch = findMatchingLocalResource(requestUrl, fullUrl)

      if (localMatch) {
        const { url: matchedUrl, resource } = localMatch

        if (logEntry) {
          logEntry.source = 'local'
          logEntry.localResource = matchedUrl
          addLog(logEntry)
        }

        serveLocalResourceStream(clientRes, resource, {
          sourceTag: 'local',
          errorPrefix: '[proxy] Error streaming local resource (connect)'
        })
      } else {
        // Forward to real server
        const abortController = new AbortController()
        const onClose = attachAbortOnClose(clientRes, abortController)

        try {
          const upstreamStart = Date.now()

          const omitHeaders = OMIT_HEADERS_MITM
          let headersToForward = createForwardHeaders(clientReq.headers, omitHeaders, {
            host: targetHost
          })

          const headerRewriteResult = applyEditRulesToHeaders(headersToForward, {
            requestUrl,
            fullUrl,
            phase: 'request'
          })
          if (headerRewriteResult.changed) {
            headersToForward = headerRewriteResult.headers
            attachRewriteMetadata(logEntry, headerRewriteResult.appliedRuleIds)
          }

          if (body.length > 0) {
            // Body has already been rewritten (Connect/protobuf or fallback) by
            // applyConnectRewritesAndDecode earlier when we built the log entry.
            // We just need to set the correct Content-Length for the upstream request.
            headersToForward['content-length'] = body.length
          }

          const { response: upstreamResponse, buffer: responseBufferRaw } = await performUpstreamRequest({
            url: fullUrl,
            method,
            headers: headersToForward,
            body: body.length > 0 ? body : undefined,
            abortSignal: abortController.signal,
            bufferResponse: true
          })

          logEntry.upstreamDurationMs = Date.now() - upstreamStart

          // Parse response body for logging (only for logging, don't modify actual response)
          let responseBody = ''
          let upstreamHeaders = upstreamResponse.headers
          const responseHeaderRewriteResult = applyEditRulesToHeaders(upstreamHeaders, {
            requestUrl,
            fullUrl,
            phase: 'response'
          })
          if (responseHeaderRewriteResult.changed) {
            upstreamHeaders = responseHeaderRewriteResult.headers
            attachRewriteMetadata(logEntry, responseHeaderRewriteResult.appliedRuleIds)
          }

          const contentType = getHeaderCaseInsensitive(upstreamHeaders, 'content-type') || ''
          const contentEncoding = getHeaderCaseInsensitive(upstreamHeaders, 'content-encoding') || ''

          // Binary types that should never be parsed as text
          const isBinary = isClearlyBinaryContentType(contentType)

          const { buffer: responseBuffer, connect: connectResponse } = applyConnectRewritesAndDecode(
            logEntry,
            responseBufferRaw,
            upstreamHeaders,
            { role: 'response', allowBodyRewriteFallback: true, updateContentEncoding: true }
          )

          if (connectResponse && connectResponse.frames?.length) {
            const rewrittenFrames = []
            const appliedSet = new Set()
            let frameChanged = false

            for (const frame of connectResponse.frames) {
              if (frame.compressed || frame.error) {
                rewrittenFrames.push(frame)
                continue
              }

              const frameText = frame.preview || (frame.json ? JSON.stringify(frame.json) : '')
              const rewriteResult = applyEditRulesToText(frameText, {
                requestUrl,
                fullUrl,
                phase: 'response'
              })
              if (rewriteResult.changed) {
                frameChanged = true
                rewriteResult.appliedRuleIds.forEach(id => appliedSet.add(id))
                rewrittenFrames.push({
                  ...frame,
                  preview: rewriteResult.text,
                  json: tryParseJsonString(rewriteResult.text)
                })
              } else {
                rewrittenFrames.push(frame)
              }
            }

            if (frameChanged) {
              connectResponse.frames = rewrittenFrames
              attachRewriteMetadata(logEntry, Array.from(appliedSet))
            }
          }

          if (logEntry) {
            const view = buildHttpResponseLoggingView({
              logEntry,
              buffer: responseBuffer,
              contentType,
              contentEncoding,
              isBinary,
              connectResponse,
              allowUnaryConnectText: true
            })
            responseBody = view.body

            logEntry.source = 'mitm'
            logEntry.targetUrl = fullUrl
            logEntry.statusCode = upstreamResponse.statusCode
            logEntry.responseHeaders = upstreamHeaders
            if (!connectResponse) {
              logEntry.responseBody = responseBody
            }
            logEntry.responseSize = responseBuffer.length
            addLog(logEntry)
          }

          // Forward response with cache-busting headers, dropping identifying
          // tracing headers for actively MITM-processed responses.
          const responseHeaders = sanitizeAndStripIdentifyingHeaders(
            upstreamHeaders,
            OMIT_RESPONSE_HEADERS
          )
          applyCacheBypassHeadersToObject(responseHeaders)

          clientRes.writeHead(upstreamResponse.statusCode, responseHeaders)
          clientRes.end(responseBuffer)

          // MITM forwarded request (silent)
        } catch (error) {
          if (logEntry) {
            recordUpstreamErrorOnLog(logEntry, error)
          }

          clientRes.writeHead(502)
          clientRes.end('Bad Gateway')
        } finally {
          clientRes.removeListener('close', onClose)
        }
      }
    })
  })

  // Pipe the client socket to the HTTPS server
  httpsServer.emit('connection', clientSocket)
  if (head && head.length) {
    clientSocket.unshift(head)
  }
})

server.listen(PORT, () => {})
