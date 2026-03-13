const http = require('http')
const https = require('https')
const net = require('net')
const tls = require('tls')
const { spawn } = require('child_process')
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
const logInternal = (level, gated, scope, message, error) => {
  if (gated && !DEBUG_LOG_ENABLED) return
  console[level](`[proxy][${scope}] ${message}`, ...(error ? [error] : []))
}
const logDebug = (scope, msg, err) => logInternal('debug', true, scope, msg, err)
const logWarn = (scope, msg, err) => logInternal('warn', false, scope, msg, err)

/**
 * Escape a string for safe inclusion in a PowerShell double-quoted string.
 *
 * @param {string} value
 * @returns {string}
 */
const escapePowerShellString = (value) => {
  const raw = value == null ? '' : String(value)
  if (!raw) return ''
  return raw.replace(/`/g, '``').replace(/"/g, '`"')
}

/**
 * Open a native Windows file picker and resolve the selected path.
 *
 * @param {{ title?: string, filter?: string }} options
 * @returns {Promise<string | null>}
 */
function showNativeFilePicker (options = {}) {
  return new Promise((resolve, reject) => {
    const title = escapePowerShellString(options.title || 'Select a file')
    const filter = escapePowerShellString(options.filter || 'All files (*.*)|*.*')

    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog;',
      `$dialog.Title = "${title}";`,
      `$dialog.Filter = "${filter}";`,
      '$dialog.Multiselect = $false;',
      '$result = $dialog.ShowDialog();',
      'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }'
    ].join(' ')

    const ps = spawn('powershell', ['-STA', '-NoProfile', '-Command', script])
    let output = ''
    let errorOutput = ''

    ps.stdout.on('data', chunk => {
      output += chunk.toString()
    })

    ps.stderr.on('data', chunk => {
      errorOutput += chunk.toString()
    })

    ps.on('error', reject)
    ps.on('close', code => {
      if (code !== 0 && errorOutput) {
        reject(new Error(errorOutput.trim()))
        return
      }
      const trimmed = output == null ? '' : String(output).trim()
      resolve(trimmed || null)
    })
  })
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
const EDIT_RULE_PRESETS_FILE = path.join(STORAGE_DIR, 'edit-rule-presets.json')

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

/**
 * Recompute the hiddenByBlockedRules flag on all existing log entries after
 * the blocked rules change. This is called from
 * recomputeBlockedUrlSubstringsForFilter so that /api/logs can simply check a
 * boolean per log instead of scanning the blocked patterns list for every
 * entry on each request.
 */
function recomputeBlockedVisibilityForLogs () {
  if (!Array.isArray(requestLogs) || requestLogs.length === 0) return

  const patterns = Array.isArray(blockedUrlSubstringsForFilter) ? blockedUrlSubstringsForFilter : []

  if (!patterns.length) {
    for (const log of requestLogs) {
      if (log && typeof log === 'object' && 'hiddenByBlockedRules' in log) {
        delete log.hiddenByBlockedRules
      }
    }
    return
  }

  for (const log of requestLogs) {
    if (!log || typeof log !== 'object') continue
    const urlString = getLogUrlString(log)
    log.hiddenByBlockedRules = urlString
      ? patterns.some(pattern => urlString.includes(pattern))
      : false
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
let editRulePresets = []

/**
 * In-memory usage counters for live edit rules.
 *
 * Key: rule id, value: number of distinct log entries where the rule
 * was applied at least once within the current in-memory log set.
 *
 * Counters are updated incrementally by attachRewriteMetadata, decremented
 * when log entries are evicted from requestLogs, and cleared together with
 * requestLogs via DELETE /api/logs.
 *
 * This structure is intentionally kept as a Map to provide O(1) updates
 * and compact iteration when building usage snapshots for the frontend.
 *
 * @type {Map<string, number>}
 */
const editRuleUsageCounters = new Map()

/**
 * Normalize a user-supplied file reference for JSONPath rule values.
 *
 * @param {any} source
 * @returns {{ type: 'file', filename?: string, path?: string, originalName?: string } | null}
 */
function normalizeJsonPathValueSource (source) {
  if (!source || typeof source !== 'object') return null
  if (source.type !== 'file') return null
  const filename = safeString(source.filename)
  const filePath = safeString(source.path)
  if (!filename && !filePath) return null
  const originalName = safeString(source.originalName)
  return {
    type: 'file',
    ...(filename ? { filename } : {}),
    ...(filePath ? { path: filePath } : {}),
    ...(originalName ? { originalName } : {})
  }
}

/**
 * Resolve a JSONPath rule value from a referenced file on disk.
 *
 * @param {{ type: 'file', filename?: string, path?: string }} source
 * @returns {string | null}
 */
function resolveJsonPathValueFromSource (source) {
  if (!source || source.type !== 'file') return null
  const explicitPath = safeString(source.path)
  const filename = safeString(source.filename)
  if (!explicitPath && !filename) return null
  const filePath = explicitPath
    ? (path.isAbsolute(explicitPath) ? explicitPath : path.join(STORAGE_DIR, explicitPath))
    : path.join(STORAGE_DIR, filename)
  try {
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Coerce a JSONPath text value into boolean, number, JSON, or string.
 *
 * @param {string} rawText
 * @returns {{ value: any, valueType: 'boolean' | 'number' | 'json' | 'string' }}
 */
function coerceJsonPathScalarFromText (rawText) {
  const text = rawText == null ? '' : String(rawText)
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()

  if (lower === 'true') {
    return { value: true, valueType: 'boolean' }
  }

  if (lower === 'false') {
    return { value: false, valueType: 'boolean' }
  }

  if (trimmed.length > 0) {
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) {
      return { value: parsed, valueType: 'number' }
    }
  }

  if (trimmed.length > 0) {
    try {
      const parsedJson = JSON.parse(trimmed)
      if (parsedJson !== null && typeof parsedJson === 'object') {
        return { value: parsedJson, valueType: 'json' }
      }
    } catch {
      // Ignore invalid JSON and fall back to string.
    }
  }

  return { value: text, valueType: 'string' }
}

/**
 * Safely trim a value that may not be a string.
 *
 * @param {any} value
 * @returns {string}
 */
function safeTrim (value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Parse a query parameter as a boolean. Returns true if the value is 'true'
 * (case-insensitive), false otherwise.
 *
 * @param {any} value
 * @returns {boolean}
 */
function queryBool (value) {
  return String(value || '').toLowerCase() === 'true'
}

/**
 * Safely extract a string value, returning empty string for non-strings.
 * Unlike safeTrim, this preserves whitespace.
 *
 * @param {any} value
 * @returns {string}
 */
function safeString (value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Determine the assumed protocol (http or https) from a request object.
 * Checks x-forwarded-proto header first, then falls back to socket encryption.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function getAssumedProtocol (req) {
  return (
    req.headers['x-forwarded-proto']?.split(',')[0]?.trim() ||
    req.protocol ||
    (req.socket?.encrypted ? 'https' : 'http')
  )
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
        .map(rule => safeString(rule?.url))
        .filter(Boolean)
    : []

  // Keep per-log visibility flags in sync with the latest blocked patterns so
  // that filterLogsCore can rely on a cheap boolean check instead of
  // re-scanning patterns for every log entry on each API call.
  recomputeBlockedVisibilityForLogs()
}

function isRequestBlocked (requestUrl, fullUrl) {
  if (!blockedRulesEnabled) return false
  if (!Array.isArray(blockedUrls) || blockedUrls.length === 0) return false

  const req = safeString(requestUrl)
  const full = safeString(fullUrl)

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
 * Base normalisation logic shared by bypass and blocked rules.
 * Extracts URL, derives name, generates ID with prefix, sets enabled flag.
 *
 * @param {object} rule - Raw rule object.
 * @param {string} idPrefix - Prefix for generated IDs (e.g. 'bypass', 'blocked').
 * @param {object} [extraDefaults] - Additional default properties to merge.
 * @returns {object} Normalised rule object.
 */
function normalizeRuleBase (rule = {}, idPrefix, extraDefaults = {}) {
  const url = safeString(rule.url)
  const name = (typeof rule.name === 'string' && rule.name.trim())
    ? rule.name.trim()
    : deriveDisplayNameFromUrlPattern(url)

  const id = (typeof rule.id === 'string' && rule.id.trim())
    ? rule.id
    : `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  return { id, enabled: rule.enabled !== false, name, url, ...extraDefaults }
}

/**
 * Normalise a raw bypass rule into the canonical internal representation.
 */
function normalizeBypassRule (rule = {}) {
  return normalizeRuleBase(rule, 'bypass', { mode: rule.mode === 'focus' ? 'focus' : 'ignore' })
}

/**
 * Normalise a raw blocked-rule entry into a canonical representation.
 */
function normalizeBlockedRule (rule = {}) {
  return normalizeRuleBase(rule, 'blocked')
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
 * Normalise a raw edit-rule entry loaded from disk into the in-memory format.
 *
 * In particolare consente di rappresentare su disco i campi stringa molto
 * lunghi (per qualsiasi tipo di regola) come array di segmenti, mantenendo
 * però sempre stringhe piatte in memoria durante l'applicazione delle regole.
 * Qualsiasi proprietà che risulta essere un array di stringhe viene
 * ricomposta in una singola stringa.
 *
 * @param {object} [rule]
 * @returns {object}
 */
function deserializeEditRuleFromDisk (rule = {}) {
  const normalized = { ...rule }

  // Convert any multi-segment on-disk representation back into flat strings so
  // that the rest of the code can treat these fields uniformly. This applies
  // to generic string fields shared by both jsonPath and text rules; marker
  // lists for text rules are always represented via startVariants/endVariants.
  const STRING_FIELDS = ['value', 'replacement', 'name', 'path', 'url']

  for (const key of STRING_FIELDS) {
    const current = normalized[key]
    if (Array.isArray(current) && current.every(segment => typeof segment === 'string')) {
      normalized[key] = current.join(' ')
    }
  }

  return normalized
}

/**
 * Normalise a raw edit rule (either jsonPath or text) into the canonical
 * in-memory format used by the proxy.
 *
 * For `jsonPath` rules the structure is kept close to the on-disk
 * representation, with light validation of valueType/target.
 *
 * For `text` rules the canonical model is entirely based on
 * `startVariants` / `endVariants`, which are treated as OR-lists of markers
 * for the start and end boundaries.
 *
 * @param {object} [rule]
 * @returns {object}
 */
function normalizeEditRule (rule = {}) {
  const kind = rule.kind === 'jsonPath' ? 'jsonPath' : 'text'

  if (kind === 'jsonPath') {
    let valueType = 'string'
    if (
      rule.valueType === 'number' ||
      rule.valueType === 'boolean' ||
      rule.valueType === 'null' ||
      rule.valueType === 'json'
    ) {
      valueType = rule.valueType
    }

    const valueSource = normalizeJsonPathValueSource(rule.valueSource)

    const normalizedTarget =
      rule.target === 'response' || rule.target === 'both'
        ? rule.target
        : 'request'

    return {
      id: rule.id || crypto.randomUUID(),
      enabled: rule.enabled !== false,
      kind,
      name: rule.name || '',
      path: safeString(rule.path),
      value: valueSource ? '' : (Object.hasOwn(rule, 'value') ? rule.value : ''),
      valueType,
      valueSource,
      // URL pattern su cui applicare la regola jsonPath; se vuoto la regola
      // non verrà inclusa nella cache compilata.
      url: safeString(rule.url),
      // Bersaglio della regola: 'request', 'response' oppure 'both'. Per
      // compatibilità all'indietro, le regole esistenti senza target esplicito
      // vengono trattate come 'request'.
      target: normalizedTarget
    }
  }

  // Default text rule. Text rules now support optional URL scoping and
  // request/response/both targeting, but for backwards compatibility existing
  // rules without an explicit target continue to apply to both directions.
  let normalizedTarget = 'both'
  if (rule.target === 'request' || rule.target === 'response' || rule.target === 'both') {
    normalizedTarget = rule.target
  }

  /**
   * Normalise an optional array of string variants, trimming each entry and
   * rimuovendo le stringhe vuote. Restituisce sempre un nuovo array (anche
   * quando non sono presenti varianti valide).
   *
   * @param {any} value
   * @returns {string[]}
   */
  function normaliseVariantArray (value) {
    if (!Array.isArray(value)) return []
    return value
      .map(entry => safeString(entry).trim())
      .filter(entry => entry.length > 0)
  }

  const startVariants = normaliseVariantArray(rule.startVariants)
  const endVariants = normaliseVariantArray(rule.endVariants)

  return {
    id: rule.id || crypto.randomUUID(),
    enabled: rule.enabled !== false,
    kind: 'text',
    name: rule.name || '',
    replacement: rule.replacement || '',
    useRegex: rule.useRegex === true,
    caseSensitive: rule.caseSensitive === true,
    // Optional URL pattern; when non-empty, the rule will only be applied
    // when the current URL context matches it (see textRuleMatchesUrl).
    url: safeString(rule.url),
    // Optional arrays of additional start/end variants used for OR matching.
    // Questi non influenzano il formato legacy su disco e vengono espansi in
    // più regole compilate all'interno di rebuildEditRuleCache.
    startVariants,
    endVariants,
    // Optional phase target; defaults to 'both' for text rules so that legacy
    // rules keep affecting both requests and responses unless narrowed.
    target: normalizedTarget
  }
}

/**
 * Strip runtime-only fields from a normalized edit rule before storing it
 * inside a preset.
 *
 * @param {object} rule
 * @returns {object}
 */
function stripPresetRuntimeFields (rule = {}) {
  const { id, enabled, ...rest } = rule
  return rest
}

/**
 * Normalize an edit-rule preset payload into a canonical stored shape.
 *
 * @param {object} [preset]
 * @returns {{ id: string, name: string, kind: 'text' | 'jsonPath', rule: object, createdAt: string }}
 */
function normalizeEditRulePreset (preset = {}) {
  const kind = preset.kind === 'jsonPath' ? 'jsonPath' : 'text'
  const name = safeTrim(preset.name) || 'Untitled preset'
  const id = safeString(preset.id) || `preset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const rawRule = preset.rule && typeof preset.rule === 'object' ? preset.rule : {}
  const normalizedRule = normalizeEditRule({ ...rawRule, kind })

  return {
    id,
    name,
    kind,
    rule: stripPresetRuntimeFields(normalizedRule),
    createdAt: typeof preset.createdAt === 'string' && preset.createdAt ? preset.createdAt : new Date().toISOString()
  }
}

/**
 * Load edit-rule presets from disk into memory.
 */
function loadEditRulePresets () {
  try {
    if (fs.existsSync(EDIT_RULE_PRESETS_FILE)) {
      const data = JSON.parse(fs.readFileSync(EDIT_RULE_PRESETS_FILE, 'utf8'))
      if (Array.isArray(data)) {
        editRulePresets = data.map(normalizeEditRulePreset)
      }
    }
  } catch (error) {
    console.error('[proxy] Error loading edit rule presets:', error)
    editRulePresets = []
  }
}

/**
 * Persist edit-rule presets to disk.
 *
 * @returns {Promise<void>}
 */
async function saveEditRulePresets () {
  try {
    const payload = JSON.stringify(editRulePresets, null, 2)
    await fsPromises.writeFile(EDIT_RULE_PRESETS_FILE, payload)
  } catch (error) {
    console.error('[proxy] Error saving edit rule presets:', error)
  }
}

/**
 * Split a long string into whitespace-delimited segments, each with a maximum
 * length. This is used purely for on-disk formatting of very long JSONPath
 * rule values so that the JSON file remains readable/editable by humans.
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]}
 */
function splitLongStringIntoSegments (text, maxLen) {
  const segments = []
  const words = String(text).split(/\s+/).filter(Boolean)

  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
    } else if ((current + ' ' + word).length <= maxLen) {
      current += ' ' + word
    } else {
      segments.push(current)
      current = word
    }
  }

  if (current) {
    segments.push(current)
  }

  return segments
}

/**
 * Prepare an edit-rule entry for JSON serialization to disk.
 *
 * Very long string values in edit rules are emitted as arrays of shorter
 * string segments so that the resulting edit-rules.json is easier to read and
 * edit manually.
 *
 * @param {object} rule
 * @returns {object}
 */
function serializeEditRuleForDisk (rule = {}) {
  const out = { ...rule }

  const MAX_SEGMENT_LENGTH = 160

  const splitIfLong = key => {
    const current = out[key]
    if (typeof current !== 'string') return
    const trimmed = current.trim()
    if (!trimmed) {
      out[key] = ''
      return
    }
    if (trimmed.length > MAX_SEGMENT_LENGTH) {
      out[key] = splitLongStringIntoSegments(trimmed, MAX_SEGMENT_LENGTH)
    } else {
      out[key] = trimmed
    }
  }

  if (out && out.kind === 'jsonPath') {
    splitIfLong('value')
  }

  if (out && out.kind === 'text') {
    splitIfLong('replacement')

    // The canonical model for text rules uses only startVariants/endVariants
    // as marker lists; drop any legacy positional markers from the on-disk
    // representation to keep the JSON clean and avoid confusion.
    delete out.start
    delete out.end
  }

  return out
}

/**
 * Load edit rules from disk into memory, normalising their structure.
 *
 * This transparently converts any on-disk multi-segment representation of
 * long string fields back into single strings before normalisation, so that
 * the rest of the code always works with flat string values.
 */
function loadEditRules () {
  try {
    if (fs.existsSync(EDIT_RULES_FILE)) {
      const data = JSON.parse(fs.readFileSync(EDIT_RULES_FILE, 'utf8'))
      if (Array.isArray(data)) {
        editRules = data
          .map(deserializeEditRuleFromDisk)
          .map(normalizeEditRule)
      }
    }
  } catch (error) {
    console.error('[proxy] Error loading edit rules:', error)
    editRules = []
  }
}

/**
 * Persist the current in-memory edit rules to disk.
 *
 * Uses serializeEditRuleForDisk so that very long JSONPath rule values (like
 * the Jarvis Persona prompt) are written in a multi-segment form that is
 * easier to inspect and edit by hand.
 *
 * @returns {Promise<void>}
 */
async function saveEditRules () {
  try {
    const diskRules = editRules.map(serializeEditRuleForDisk)
    const payload = JSON.stringify(diskRules, null, 2)
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

      // Support numeric indices: root.items[3].name
      if (/^\d+$/.test(inside)) {
        const index = Number.parseInt(inside, 10)
        if (!Number.isFinite(index) || index < 0) return []
        segments.push({ type: 'index', index })
      } else if (inside.startsWith('?')) {
        // Support filter expressions: [?(@.field=='value')] or [?(@.field=="value")]
        // Pattern: ?(@.key=='value') or ?(@.key=="value")
        const filterMatch = inside.match(/^\?\s*\(\s*@\.(\w+)\s*==\s*['"]([^'"]+)['"]\s*\)$/)
        if (!filterMatch) return []
        const filterKey = filterMatch[1]
        const filterValue = filterMatch[2]
        segments.push({ type: 'filter', key: filterKey, value: filterValue })
      } else {
        return []
      }
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

/**
 * Check if there are any active compiled text edit rules.
 * @returns {boolean}
 */
function hasCompiledTextRules () {
  const rules = getCompiledRules()
  return Array.isArray(rules) && rules.length > 0
}

/**
 * Check if there are any active compiled JSONPath rules.
 * @returns {boolean}
 */
function hasCompiledJsonPathRules () {
  const rules = getCompiledJsonPathRules()
  return Array.isArray(rules) && rules.length > 0
}

/**
 * Determine whether there are any active text edit or JSONPath rules.
 *
 * This is a lightweight helper used by hot paths to decide whether it is
 * worth invoking expensive Connect/protobuf or HTTP body rewriting logic
 * when interactive logging is disabled.
 *
 * @returns {boolean}
 */
function hasAnyEditOrJsonPathRules () {
  return hasCompiledTextRules() || hasCompiledJsonPathRules()
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

function replaceTextLiteral (text, start, end, replacement, caseSensitive) {
  if (!start && !end) return { text, count: 0 }
  
  const normalize = s => caseSensitive ? s : s.toLowerCase()
  const haystack = normalize(text)
  const parts = []
  let lastIndex = 0
  let count = 0

  if (start && end) {
    // between mode
    const startSearch = normalize(start)
    const endSearch = normalize(end)
    let startIdx = haystack.indexOf(startSearch, lastIndex)
    while (startIdx !== -1) {
      const endIdx = haystack.indexOf(endSearch, startIdx + start.length)
      if (endIdx === -1) break
      parts.push(text.slice(lastIndex, startIdx), replacement)
      lastIndex = endIdx + end.length
      count++
      startIdx = haystack.indexOf(startSearch, lastIndex)
    }
  } else {
    // simple replace mode
    const needle = start || end
    const searchNeedle = normalize(needle)
    let idx = haystack.indexOf(searchNeedle, lastIndex)
    while (idx !== -1) {
      parts.push(text.slice(lastIndex, idx), replacement)
      lastIndex = idx + needle.length
      count++
      idx = haystack.indexOf(searchNeedle, lastIndex)
    }
  }

  if (count === 0) return { text, count }
  parts.push(text.slice(lastIndex))
  return { text: parts.join(''), count }
}


function compileEditRule (rule) {
  if (!rule || !rule.enabled) return null

  const startRaw = safeString(rule.start)
  const endRaw = safeString(rule.end)

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

/**
 * Rebuild the in-memory caches for edit rules (text + JSONPath).
 *
 * Behaviour:
 * - JSONPath rules are validated and parsed into segments, and only rules with
 *   a non-empty URL pattern are included.
 * - Text rules support optional OR-variants via `startVariants` and
 *   `endVariants`. All possible marker combinations are expanded into
 *   individual compiled rules which share the same logical rule id.
 *
 * This keeps the on-disk/editable representation compact while allowing the
 * runtime matcher to operate on simple start/end pairs.
 */
function rebuildEditRuleCache () {
  compiledEditRules = []
  compiledJsonPathRules = []

  for (const rule of editRules) {
    if (!rule || rule.enabled === false) continue

    if (rule.kind === 'jsonPath') {
      // Pre-parse the path into structured segments for fast traversal at runtime.
      // Le regole jsonPath richiedono anche un URL non vuoto per essere attive.
      const urlPatternRaw = safeString(rule.url)
      const urlPattern = urlPatternRaw.trim()
      if (!urlPattern) continue

      const segments = parseJsonPath(rule.path)
      if (!segments || !segments.length) continue

      let valueType = 'string'
      if (
        rule.valueType === 'number' ||
        rule.valueType === 'boolean' ||
        rule.valueType === 'null' ||
        rule.valueType === 'json'
      ) {
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
        valueSource: rule.valueSource || null,
        url: urlPattern,
        target: normalizedTarget
      })
      continue
    }

    // Text rules: expand the OR-variant marker lists into a set of simple
    // start/end combinations. All variant combinations share the same logical
    // rule id so that logging and usage reporting remain grouped. The
    // canonical configuration surface for text rules is
    // startVariants/endVariants only.
    const variantStarts = Array.isArray(rule.startVariants)
      ? rule.startVariants.map(entry => safeString(entry)).filter(s => s.length > 0)
      : []
    const variantEnds = Array.isArray(rule.endVariants)
      ? rule.endVariants.map(entry => safeString(entry)).filter(s => s.length > 0)
      : []

    const allStarts = []
    const allEnds = []

    for (const s of variantStarts) {
      if (!allStarts.includes(s)) allStarts.push(s)
    }

    for (const e of variantEnds) {
      if (!allEnds.includes(e)) allEnds.push(e)
    }

    // If there are no usable markers at all, skip this text rule.
    if (!allStarts.length && !allEnds.length) {
      continue
    }

    const combinations = []

    if (allStarts.length && allEnds.length) {
      // Full cartesian product of start/end markers.
      for (const start of allStarts) {
        for (const end of allEnds) {
          combinations.push({ start, end })
        }
      }
    } else if (allStarts.length) {
      // Only prefix markers: each start becomes an independent prefix rule.
      for (const start of allStarts) {
        combinations.push({ start, end: '' })
      }
    } else {
      // Only suffix markers: each end becomes an independent suffix rule.
      for (const end of allEnds) {
        combinations.push({ start: '', end })
      }
    }

    for (const combo of combinations) {
      const variantRule = {
        ...rule,
        start: combo.start,
        end: combo.end
      }
      const compiled = compileEditRule(variantRule)
      if (compiled) {
        compiledEditRules.push(compiled)
      }
    }
  }
}

function getCompiledRules () {
  if (!editRulesEnabled) return []
  return compiledEditRules
}

/**
 * Return the subset of compiled edit rules that are applicable to the given
 * URL/phase context. This performs per-rule phase/URL checks once per
 * call-site so that hot paths (headers/body rewrites) can iterate a smaller
 * ruleset.
 *
 * The function is intentionally conservative: in the absence of a valid
 * context object it returns the full compiled rules array to preserve legacy
 * behaviour.
 *
 * @param {{requestUrl?: string, fullUrl?: string, phase?: string, candidates?: { raw: string, host: (string|null), path: (string|null) }[]}|null} context
 * @returns {Array<{ rule: any }>} Filtered compiled rules.
 */
function getCompiledRulesForContext (context) {
  const all = getCompiledRules()
  if (!all.length || !context || typeof context !== 'object') return all

  const matchContext = context.candidates ? context : buildUrlMatchContext(context)
  const phase = matchContext.phase === 'response' ? 'response' : 'request'

  return all.filter(compiled => {
    const rule = compiled && compiled.rule
    if (!rule || typeof rule !== 'object') return false

    let target = 'both'
    if (rule.target === 'request' || rule.target === 'response' || rule.target === 'both') {
      target = rule.target
    }

    if (target === 'request' && phase === 'response') return false
    if (target === 'response' && phase === 'request') return false

    return textRuleMatchesUrl(rule, matchContext)
  })
}

/**
 * LRU cache for parsed URL components to avoid repeated URL parsing on hot paths.
 * Key: lowercase URL string, Value: { host, path }
 */
const urlParseCache = new Map()
const URL_PARSE_CACHE_MAX = 500

/**
 * Get cached URL parse result or parse and cache it.
 *
 * @param {string} url - URL string to parse
 * @returns {{ host: string|null, path: string }|null}
 */
function getCachedUrlParse (url) {
  if (!url || typeof url !== 'string') return null
  const key = url.toLowerCase()

  if (urlParseCache.has(key)) {
    return urlParseCache.get(key)
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
      urlParseCache.delete(firstKey)
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
 * @param {{requestUrl?: string, fullUrl?: string}} [context]
 * @returns {{ raw: string, host: (string|null), path: (string|null) }[]}
 */
function buildUrlMatchCandidatesFromContext (context = {}) {
  const candidates = []

  const pushCandidate = (value) => {
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
 * @param {{requestUrl?: string, fullUrl?: string, phase?: string}} [context]
 * @returns {{requestUrl?: string, fullUrl?: string, phase?: string, candidates: { raw: string, host: (string|null), path: (string|null) }[]}}
 */
function buildUrlMatchContext (context = {}) {
  const baseContext = context && typeof context === 'object' ? context : {}
  const candidates = buildUrlMatchCandidatesFromContext(baseContext)
  return { ...baseContext, candidates }
}

/**
 * Build a JSONPath-aware URL/phase context and precompute URL candidates via
 * buildUrlMatchContext so that downstream helpers can share consistent
 * matching semantics across HTTP, Connect and WebSocket flows.
 *
 * @param {{requestUrl?: string, fullUrl?: string, phase?: string}} [context]
 * @returns {{requestUrl?: string, fullUrl?: string, phase: string, candidates: { raw: string, host: (string|null), path: (string|null) }[]}}
 */
function buildJsonPathRuleContext (context = {}) {
  const base = context && typeof context === 'object' ? { ...context } : {}
  base.phase = base.phase === 'response' ? 'response' : 'request'
  return buildUrlMatchContext(base)
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
 * @param {{ raw: string, host: (string|null), path: (string|null) }[]} candidates
 * @returns {boolean}
 */
function urlPatternMatchesCandidates (rawPattern, candidates) {
  const pattern = rawPattern.trim().toLowerCase()
  if (!pattern) return false

  if (!Array.isArray(candidates) || candidates.length === 0) return false

  const isAbsolutePattern = /^https?:\/\//.test(pattern)
  const isPathPattern = !isAbsolutePattern && pattern.startsWith('/')

  // Absolute URL pattern: match on host + path (exact or prefix).
  if (isAbsolutePattern) {
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

        if (patternHost && candidate.host && candidate.host !== patternHost) {
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
 * @param {{requestUrl?: string, fullUrl?: string}} [context]
 * @returns {boolean}
 */
function urlPatternMatchesContext (rawPattern, context = {}) {
  const baseContext = context && typeof context === 'object' ? context : {}
  const candidates = buildUrlMatchCandidatesFromContext(baseContext)
  return urlPatternMatchesCandidates(rawPattern, candidates)
}

function jsonPathRuleMatchesUrl (rule, contextOrMatch = {}) {
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
 * @param {{url?: string}} rule
 * @param {{requestUrl?: string, fullUrl?: string, candidates?: { raw: string, host: (string|null), path: (string|null) }[]}} [contextOrMatch]
 * @returns {boolean}
 */
function textRuleMatchesUrl (rule, contextOrMatch = {}) {
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

function applyJsonPathRulesToObject (root, context = {}) {
  if (!root || typeof root !== 'object') {
    return { object: root, appliedRuleIds: [], changed: false }
  }

  const rules = getCompiledJsonPathRules()
  if (!Array.isArray(rules) || rules.length === 0) {
    return { object: root, appliedRuleIds: [], changed: false }
  }

  const baseContext = context && typeof context === 'object' ? context : {}
  const matchContext = baseContext.candidates ? baseContext : buildUrlMatchContext(baseContext)

  const phase = matchContext && matchContext.phase === 'response' ? 'response' : 'request'

  const appliedSet = new Set()
  let changed = false

  for (const rule of rules) {
    if (!rule || !Array.isArray(rule.segments) || rule.segments.length === 0) continue

    const target = rule.target === 'response' || rule.target === 'both' ? rule.target : 'request'

    if (target === 'request' && phase !== 'request') continue
    if (target === 'response' && phase !== 'response') continue

    // Le regole jsonPath vengono applicate solo se l'URL corrente matcha il
    // pattern associato alla regola.
    if (!jsonPathRuleMatchesUrl(rule, matchContext)) continue

    let effectiveValue = rule.value
    let effectiveValueType = rule.valueType
    if (rule.valueSource && rule.valueSource.type === 'file') {
      const fileText = resolveJsonPathValueFromSource(rule.valueSource)
      if (fileText === null) continue
      const coerced = coerceJsonPathScalarFromText(fileText)
      effectiveValue = coerced.value
      effectiveValueType = coerced.valueType
    }

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
        if (!Object.hasOwn(parent, seg.key)) {
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
      } else if (seg.type === 'filter') {
        // Filter segment: find the first array element where element[key] === value
        if (!Array.isArray(parent)) {
          validPath = false
          break
        }
        const found = parent.find(item =>
          item && typeof item === 'object' && item[seg.key] === seg.value
        )
        if (!found) {
          validPath = false
          break
        }
        parent = found
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
      if (!container || typeof container !== 'object' || !Object.hasOwn(container, lastSeg.key)) {
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
    } else if (lastSeg.type === 'filter') {
      // Filter as last segment: find the matching element in the array and replace it
      if (!Array.isArray(container)) continue
      const foundIndex = container.findIndex(item =>
        item && typeof item === 'object' && item[lastSeg.key] === lastSeg.value
      )
      if (foundIndex === -1) continue
      keyOrIndex = foundIndex
      currentValue = container[foundIndex]
    } else {
      continue
    }

    // Compute the new value based on valueType
    let newValue
    if (effectiveValueType === 'number') {
      if (typeof effectiveValue === 'number') {
        newValue = effectiveValue
      } else if (typeof effectiveValue === 'string') {
        const parsed = Number(effectiveValue.trim())
        if (!Number.isFinite(parsed)) continue
        newValue = parsed
      } else {
        continue
      }
    } else if (effectiveValueType === 'boolean') {
      if (typeof effectiveValue === 'boolean') {
        newValue = effectiveValue
      } else if (typeof effectiveValue === 'string') {
        const lower = effectiveValue.trim().toLowerCase()
        if (lower === 'true') newValue = true
        else if (lower === 'false') newValue = false
        else continue
      } else {
        continue
      }
    } else if (effectiveValueType === 'null') {
      newValue = null
    } else if (effectiveValueType === 'json') {
      // Explicit JSON value type: treat the rule value as JSON and replace the
      // target with the parsed object/array. This is primarily for advanced
      // callers using the HTTP API directly.
      if (effectiveValue && typeof effectiveValue === 'object') {
        newValue = effectiveValue
      } else if (typeof effectiveValue === 'string') {
        try {
          newValue = JSON.parse(effectiveValue)
        } catch {
          // Invalid JSON payload for this rule; skip instead of inserting a
          // malformed value into the object tree.
          continue
        }
      } else {
        // Unsupported representation for a JSON value; ignore the rule.
        continue
      }
    } else {
      // Default branch: treat the rule value as a string, but when the current
      // JSON value at the target path is an object/array we optimistically
      // attempt to parse the rule value as JSON so that whole objects can be
      // replaced even when the UI only exposes a "string" value type.
      if (
        currentValue &&
        typeof currentValue === 'object' &&
        typeof effectiveValue === 'string'
      ) {
        const text = effectiveValue.trim()
        if (text) {
          try {
            newValue = JSON.parse(text)
          } catch {
            // If parsing fails, fall back to the raw string representation.
            newValue = effectiveValue
          }
        } else {
          newValue = effectiveValue
        }
      } else {
        newValue = effectiveValue != null ? String(effectiveValue) : ''
      }
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
  }

  return {
    object: root,
    appliedRuleIds: Array.from(appliedSet),
    changed
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
  const key = encodeProtobufKey(fieldNumber, 2)
  const lenBuf = encodeVarint32(dataBuffer.length >>> 0)
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

  // Split fields into processable and passthrough to avoid per-iteration limit check
  const fieldsToProcess = fields.slice(0, maxFields)
  const fieldsToPassthrough = fields.slice(maxFields)

  for (const field of fieldsToProcess) {
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

  // Passthrough fields beyond the limit without processing
  for (const field of fieldsToPassthrough) {
    chunks.push(field.raw)
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
 * Heuristically re-encode a JSON object back into a Protobuf buffer.
 *
 * This is the inverse of extractJsonFromProtobufBuffer and supports:
 * - Nested messages (keys like "f1", "f2"...)
 * - JSON strings (non-protobuf objects encoded as JSON)
 * - Varints (numbers/booleans)
 * - Top-level strings
 *
 * @param {object} json - The JSON object to encode.
 * @returns {Buffer} - The encoded Protobuf message.
 */
function encodeJsonToProtobuf (json) {
  if (!json || typeof json !== 'object') {
    return Buffer.alloc(0)
  }

  const fields = []

  // Helper to check if an object looks like a Protobuf message (keys are f1, f2...)
  const isProtobufObject = (obj) => {
    if (!obj || typeof obj !== 'object') return false
    const keys = Object.keys(obj)
    if (keys.length === 0) return false
    return keys.every(k => /^f\d+$/.test(k))
  }

  // Preserve field order from extraction (JavaScript objects maintain insertion order)
  for (const [key, val] of Object.entries(json)) {
    if (!/^f\d+$/.test(key)) continue
    const fieldNumber = parseInt(key.slice(1), 10)
    if (isNaN(fieldNumber) || fieldNumber <= 0) continue

    const values = Array.isArray(val) ? val : [val]

    for (const value of values) {
      if (value === null || value === undefined) continue

      if (typeof value === 'number') {
        // Assume Varint (WireType 0)
        fields.push({ fieldNumber, wireType: 0, value })
      } else if (typeof value === 'boolean') {
        // Varint (WireType 0)
        fields.push({ fieldNumber, wireType: 0, value: value ? 1 : 0 })
      } else if (typeof value === 'string') {
        // String (WireType 2)
        fields.push({ fieldNumber, wireType: 2, data: Buffer.from(value, 'utf8') })
      } else if (typeof value === 'object') {
        // Complex object: either nested message, JSON-stringified object, or special blob
        if (value.bytesHex && typeof value.bytesHex === 'string') {
          // Fixed 32/64 handling (from extractJson heuristic)
          try {
            const buf = Buffer.from(value.bytesHex, 'hex')
            const wireType = buf.length === 8 ? 1 : 5
            fields.push({ fieldNumber, wireType, data: buf })
          } catch {
            // Ignore invalid hex
          }
        } else if (value.base64 && typeof value.base64 === 'string') {
          // Fallback blob
          try {
            fields.push({ fieldNumber, wireType: 2, data: Buffer.from(value.base64, 'base64') })
          } catch {
            // Ignore invalid base64
          }
        } else {
          // Heuristic: Nested Message vs JSON String
          if (isProtobufObject(value)) {
            // Recursively encode as nested message
            const nestedBuf = encodeJsonToProtobuf(value)
            fields.push({ fieldNumber, wireType: 2, data: nestedBuf })
          } else {
            // Encode as JSON string
            const jsonStr = JSON.stringify(value)
            fields.push({ fieldNumber, wireType: 2, data: Buffer.from(jsonStr, 'utf8') })
          }
        }
      }
    }
  }

  return encodeProtobufFromFields(fields)
}

/**
 * Apply JSONPath rules directly to a protobuf message buffer when possible,
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
  const baseContext = context && typeof context === 'object' ? context : {}
  const matchContext = baseContext.candidates ? baseContext : buildUrlMatchContext(baseContext)
  const hasMatchingRule = rules.some(rule => jsonPathRuleMatchesUrl(rule, matchContext))
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

  const normalizedJson = normalizeNestedJsonStrings(json)
  const result = applyJsonPathRulesToObject(normalizedJson, matchContext)
  if (!result || !result.changed) {
    return {
      buffer,
      json: result ? result.object : json,
      appliedRuleIds: result ? (result.appliedRuleIds || []) : [],
      changed: false
    }
  }

  const after = result.object || {}
  let nextBuffer = buffer
  let mutated = false

  // Always re-encode the entire object from the modified JSON.
  try {
    nextBuffer = encodeJsonToProtobuf(after)
    mutated = true
  } catch {
    // Re-encoding failed; return original buffer but keep the JSON view
    // changes for logging purposes.
    return {
      buffer,
      json: after,
      appliedRuleIds: result.appliedRuleIds || [],
      changed: false
    }
  }

  return {
    buffer: nextBuffer,
    json: after,
    appliedRuleIds: result.appliedRuleIds || [],
    changed: mutated
  }
}

/**
 * Apply a single compiled text edit rule to the provided string.
 *
 * Honours per-rule target (request/response/both) e l'eventuale URL scoping
 * prima di tentare la sostituzione. In caso di match aggiunge l'id della
 * regola a `appliedSet` e restituisce il testo aggiornato.
 *
 * @param {{ rule: object, mode: string|null, useRegex: boolean, caseSensitive: boolean, start: string, end: string, regex?: RegExp }} compiled
 * @param {string} text
 * @param {Set<string>} appliedSet
 * @param {{ requestUrl?: string, fullUrl?: string, phase?: string }|null} [context]
 * @returns {{ text: string, changed: boolean }}
 */
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
    result = replaceTextLiteral(text, compiled.start, compiled.end, rule.replacement, caseSensitive)
  } else if (mode === 'prefix') {
    result = replaceTextLiteral(text, compiled.start, null, rule.replacement, caseSensitive)
  } else {
    result = replaceTextLiteral(text, compiled.end, null, rule.replacement, caseSensitive)
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

  // Optional URL/phase context is forwarded to individual rules so they can
  // implement scoping similar to JSONPath-based rules. When a context is
  // present, we pre-filter the compiled rules once per call to avoid
  // repeating phase/URL checks for every header/body value.
  const rawContext = arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : null
  const matchContext = rawContext ? buildUrlMatchContext(rawContext) : null

  const compiledRules = matchContext ? getCompiledRulesForContext(matchContext) : getCompiledRules()
  if (!compiledRules.length) {
    return { text, appliedRuleIds: [], changed: false }
  }

  const appliedSet = new Set()
  let current = text
  let changed = false

  for (const compiled of compiledRules) {
    const result = applyCompiledRuleToText(compiled, current, appliedSet, matchContext || rawContext)
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
  const rawContext = context && typeof context === 'object' ? context : null
  const matchContext = rawContext
    ? (Array.isArray(rawContext.candidates) ? rawContext : buildUrlMatchContext(rawContext))
    : null

  const compiledRules = matchContext ? getCompiledRulesForContext(matchContext) : getCompiledRules()
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
          const result = applyCompiledRuleToText(
            compiled,
            current,
            appliedSet,
            matchContext || rawContext
          )
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
        const result = applyCompiledRuleToText(
          compiled,
          current,
          appliedSet,
          matchContext || rawContext
        )
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

/**
 * Apply header rewrites and attach metadata to log entry in one step.
 * Returns the (possibly modified) headers object.
 *
 * @param {object} headers - Headers to rewrite.
 * @param {{requestUrl?: string, fullUrl?: string, phase: string}} context
 * @param {object|null} logEntry - Log entry to attach rewrite metadata to.
 * @returns {object} Rewritten headers.
 */
function applyHeaderRewrites (headers, context, logEntry) {
  const result = applyEditRulesToHeaders(headers, context)
  if (result.changed && logEntry && hasAppliedRules(result.appliedRuleIds)) {
    attachRewriteMetadata(logEntry, result.appliedRuleIds, context.phase)
  }
  return result.changed ? result.headers : headers
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
    changed: true,
    // Structured text snapshots for before/after views when pure text rules
    // are applied outside of JSONPath contexts.
    beforeText: text,
    afterText: nextText
  }
}

/**
 * Attach per-rule rewrite metadata to a log entry and update global
 * edit-rule usage counters.
 *
 * For each rule id in appliedRuleIds this function ensures that at most
 * one metadata entry is stored on the log entry, and increments the
 * in-memory usage counter the first time the rule is seen for that log
 * entry. This keeps aggregation O(1) per rule id without rescanning
 * requestLogs when building reports.
 *
 * @param {object|null} logEntry - Mutable log entry to enrich.
 * @param {string[]} appliedRuleIds - Rule identifiers that matched for this operation.
 * @param {string|undefined} phase - Phase hint ('request' | 'response' | 'both').
 * @returns {void}
 */
function attachRewriteMetadata (logEntry, appliedRuleIds, phase) {
  if (!logEntry || !Array.isArray(appliedRuleIds) || appliedRuleIds.length === 0) return
  if (!logEntry.rewrites) {
    logEntry.rewrites = []
  }

  // Normalise the phase hint to one of 'request' | 'response' | 'both' | null.
  const normalizedPhase =
    phase === 'request' || phase === 'response'
      ? phase
      : phase === 'both'
        ? 'both'
        : null

  for (const id of appliedRuleIds) {
    if (!id) continue

    // Reuse or create a single metadata entry per rule id, and accumulate
    // the phases in which it actually applied for this log entry.
    let entry = logEntry.rewrites.find(e => e && e.id === id)

    const isNewEntry = !entry
    if (!entry) {
      entry = { id }

      const rule = Array.isArray(editRules)
        ? editRules.find(r => r && r.id === id)
        : null

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

        // Normalise configured target so the frontend can still surface how
        // the rule is *defined* in the UI when no applied phase metadata is
        // available.
        const rawTarget = safeTrim(rule.target)
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
    }

    if (isNewEntry) {
      const prev = editRuleUsageCounters.get(id) || 0
      editRuleUsageCounters.set(id, prev + 1)
    }

    // Track where the rule actually applied for this specific log entry.
    if (normalizedPhase) {
      if (normalizedPhase === 'both') {
        entry.appliedPhases = ['request', 'response']
        entry.appliedScope = 'both'
      } else {
        const phases = Array.isArray(entry.appliedPhases) ? entry.appliedPhases.slice() : []
        if (!phases.includes(normalizedPhase)) {
          phases.push(normalizedPhase)
        }
        entry.appliedPhases = phases

        if (phases.length === 2) {
          entry.appliedScope = 'both'
        } else if (phases.length === 1) {
          entry.appliedScope = phases[0]
        }
      }
    }

    if (isNewEntry) {
      logEntry.rewrites.push(entry)
    }
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
      if (!Object.hasOwn(cache, lower)) {
        cache[lower] = Array.isArray(value) ? value[0] : value
      }
    }
    headerLookupCache.set(headers, cache)
  }

  const target = name.toLowerCase()
  return cache[target]
}

/**
 * Get the Content-Type header value from a headers object.
 * Returns empty string if not found.
 *
 * @param {object} headers
 * @returns {string}
 */
function getContentType (headers) {
  return getHeaderCaseInsensitive(headers, 'content-type') || ''
}

/**
 * Get the Content-Encoding header value from a headers object.
 * Returns empty string if not found.
 *
 * @param {object} headers
 * @returns {string}
 */
function getContentEncoding (headers) {
  return getHeaderCaseInsensitive(headers, 'content-encoding') || ''
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
        const rawPattern = safeString(rule.url)
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

  const contentType = getContentType(headers)
  if (!isProtoContentType(contentType) && !looksLikeConnectEnvelope(buffer)) {
    return { buffer, appliedRuleIds: [], changed: false }
  }

  const encodingHeader = getContentEncoding(headers).toLowerCase()
  let decodedBuffer = buffer
  let recompress

  if (encodingHeader && encodingHeader !== 'identity') {
    // Try to reuse already-decoded HTTP body from Connect logging pass
    const decodedHttpBuffer = decodedConnect && Buffer.isBuffer(decodedConnect.httpDecodedBuffer)
      ? decodedConnect.httpDecodedBuffer
      : null
    const canReuse = decodedConnect &&
      decodedConnect.httpDecompressed === true &&
      typeof decodedConnect.httpEncoding === 'string' &&
      decodedConnect.httpEncoding.toLowerCase() === encodingHeader &&
      (decodedHttpBuffer || typeof decodedConnect.rawBase64 === 'string')

    const codec = getCompressionCodec(encodingHeader)
    if (!codec) return { buffer, appliedRuleIds: [], changed: false }

    try {
      if (canReuse) {
        decodedBuffer = decodedHttpBuffer || Buffer.from(decodedConnect.rawBase64, 'base64')
      } else {
        decodedBuffer = codec.decompress(buffer)
      }
      recompress = codec.compress
    } catch {
      return { buffer, appliedRuleIds: [], changed: false }
    }
  }

  const connectEncodingHeader = getConnectEncodingHeader(headers)
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
        // decompressing the frame a second time here. Use the cached
        // Buffer when available.
        if (decodedConnect && decodedConnect.envelope && Array.isArray(decodedConnect.frames)) {
          const decodedFrame = decodedConnect.frames[index]
          if (decodedFrame && decodedFrame.frameDecompressed && Buffer.isBuffer(decodedFrame._decodedBuffer)) {
            framePayload = decodedFrame._decodedBuffer
            needsRecompress = true
            reusedDecodedPayload = true
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

      // When decodeConnectPayload has already parsed a JSON view for this
      // frame, reuse that structure as a seed for JSONPath rules where it is
      // safe to do so (i.e. when no text rewrites have modified the payload).
      let seedJson = null
      if (decodedConnect && decodedConnect.envelope && Array.isArray(decodedConnect.frames)) {
        const decodedFrame = decodedConnect.frames[index]
        if (decodedFrame && typeof decodedFrame._rawProtobufJson === 'object') {
          seedJson = decodedFrame._rawProtobufJson
        }
      }

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
      //
      // When there were no text rewrites, we can safely reuse the JSON view
      // parsed during decodeConnectPayload as an initialJson seed, which
      // avoids reparsing the same protobuf payload a second time.
      const initialJson = !rewriteResult.changed ? seedJson : null
      const jsonPathResult = applyJsonPathRulesToProtobufBuffer(
        baseBuffer,
        initialJson,
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
          // Prefer the JSON view already produced by JSONPath rule
          // application when available, to avoid reparsing the protobuf
          // payload purely for logging/search views.
          if (jsonPathResult && jsonPathResult.json !== undefined) {
            parsedJson = jsonPathResult.json
          } else {
            parsedJson = extractJsonFromProtobufBuffer(finalBufferUncompressed)
          }
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
 * @returns {{ buffer: Buffer, rewrites: string[]|null, body: string, originalBody: (string|null), jsonAfter?: any }}
 */
function applyWebSocketRewritesAndDescribe (payload, isBinary, context) {
  let payloadBuffer = normalizeWebSocketPayload(payload)

  let rewrites = null
  let originalBody = null
  let payloadMutatedByTextRules = false
  let jsonAfter = null

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
          payloadMutatedByTextRules = true
        }

        if (hasAppliedRules(rewriteResult.appliedRuleIds)) {
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

      if (payloadMutatedByTextRules || !originalBody) {
        try {
          textForJson = payloadBuffer.toString('utf8')
        } catch (error) {
          logDebug('applyWebSocketRewritesAndDescribe', 'Failed to decode WebSocket payload as UTF‑8 for JSONPath', error)
        }
      } else {
        textForJson = originalBody
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
            const normalizedParsed = normalizeNestedJsonStrings(parsed)

            const jsonPathContext = {
              ...(context && typeof context === 'object' ? context : {}),
              phase: context && typeof context.phase === 'string' ? context.phase : 'request'
            }

            const jsonResult = applyJsonPathRulesToObject(normalizedParsed, jsonPathContext)
            if (jsonResult && jsonResult.changed) {
              const updatedObject = jsonResult.object
              const updatedText = prefix + JSON.stringify(updatedObject)
              payloadBuffer = Buffer.from(updatedText, 'utf8')
              jsonAfter = updatedObject

              if (hasAppliedRules(jsonResult.appliedRuleIds)) {
                rewrites = Array.isArray(rewrites) ? rewrites : []
                for (const id of jsonResult.appliedRuleIds) {
                  if (!id) continue
                  if (!rewrites.includes(id)) rewrites.push(id)
                }
              }
            } else {
              // Even when no rule changed the payload, keep a parsed JSON
              // snapshot so WebSocket logging can reuse it without reparsing.
              jsonAfter = normalizedParsed
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

  return { buffer: payloadBuffer, rewrites, body, originalBody, jsonAfter }
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
/**
 * Recursively normalise an object tree by parsing any properties that contain
 * JSON-as-string into real objects/arrays. This is used to ensure that
 * JSONPath rules and logging see a consistent, fully structured view even
 * when protocols embed JSON inside string fields such as `data` or
 * `channel_data`.
 *
 * The function mutates the provided root object in-place.
 *
 * @param {any} root
 * @returns {any}
 */
function normalizeNestedJsonStrings (root) {
  if (!root || typeof root !== 'object') return root

  const stack = [root]

  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue

    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        const value = current[i]
        if (typeof value === 'string') {
          const trimmed = value.trim()
          if (trimmed.length > 0 && (trimmed[0] === '{' || trimmed[0] === '[')) {
            try {
              const parsed = JSON.parse(trimmed)
              if (parsed && typeof parsed === 'object') {
                current[i] = parsed
                stack.push(parsed)
              }
            } catch {
              // Not valid JSON - keep original string
            }
          }
        } else if (value && typeof value === 'object') {
          stack.push(value)
        }
      }
      continue
    }

    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed.length > 0 && (trimmed[0] === '{' || trimmed[0] === '[')) {
          try {
            const parsed = JSON.parse(trimmed)
            if (parsed && typeof parsed === 'object') {
              current[key] = parsed
              stack.push(parsed)
            }
          } catch {
            // Not valid JSON - keep original string
          }
        }
      } else if (value && typeof value === 'object') {
        stack.push(value)
      }
    }
  }

  return root
}

/**
 * Strip Socket.IO/Engine.IO prefixes from a text payload.
 * Removes leading numeric codes (e.g. "42") and namespace prefixes (e.g. "/ws/character,").
 *
 * @param {string} text
 * @returns {string}
 */
function stripSocketIoPrefix (text) {
  if (!text) return text
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

  return body
}

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

  const body = stripSocketIoPrefix(text)

  try {
    const parsed = JSON.parse(body)
    return normalizeNestedJsonStrings(parsed)
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
 * @param {any} [params.bodyJson] Parsed JSON view of the final body when available.
 * @param {any} [params.originalBodyJson] Parsed JSON view of the original body when available.
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
  originalBodyText,
  bodyJson,
  originalBodyJson
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
      const beforeJson = originalBodyJson != null ? originalBodyJson : tryParseWebSocketJson(originalBodyText)
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

/**
 * Check if a content-type matches any pattern in a list.
 * Optimized to avoid creating intermediate arrays.
 *
 * @param {string} contentType
 * @param {string[]} patterns
 * @returns {boolean}
 */
function contentTypeMatchesAny (contentType, patterns) {
  if (!contentType) return false
  const lower = contentType.toLowerCase()
  for (let i = 0; i < patterns.length; i++) {
    if (lower.includes(patterns[i])) return true
  }
  return false
}

function shouldDecompress (contentType) {
  return contentTypeMatchesAny(contentType, DECOMPRESS_ALLOWED_TYPES)
}

/**
 * Decompress response data when beneficial for analysis.
 * Uses getCompressionCodec internally to avoid duplicating codec logic.
 *
 * @param {Buffer} buffer
 * @param {string} encoding
 * @param {string} [contentType]
 * @returns {Buffer}
 */
function decompressData (buffer, encoding, contentType) {
  if (!buffer || buffer.length === 0) return buffer
  if (!shouldDecompress(contentType)) return buffer
  if (!encoding || encoding === 'identity') return buffer

  const codec = getCompressionCodec(encoding)
  if (!codec) return buffer

  try {
    return codec.decompress(buffer)
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

/**
 * Extract the Connect/gRPC frame-level encoding header from an HTTP headers
 * object. Checks connect-content-encoding, connect-encoding, and grpc-encoding
 * in order.
 *
 * @param {object} headers
 * @returns {string}
 */
function getConnectEncodingHeader (headers) {
  return (
    getHeaderCaseInsensitive(headers, 'connect-content-encoding') ||
    getHeaderCaseInsensitive(headers, 'connect-encoding') ||
    getHeaderCaseInsensitive(headers, 'grpc-encoding') ||
    ''
  )
}

/**
 * Check if a content-type indicates textual content suitable for text-based
 * rewrites and logging. This centralises the heuristic used by multiple
 * rewrite and logging paths.
 *
 * @param {string} contentType
 * @returns {boolean}
 */
function isTextualContentType (contentType) {
  if (!contentType) return false
  const lower = safeString(contentType).toLowerCase()
  return (
    lower.includes('json') ||
    lower.includes('text/') ||
    lower.includes('javascript') ||
    lower.includes('xml') ||
    lower.includes('x-www-form-urlencoded')
  )
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
  phase = 'request',
  /**
   * When true, capture a deep-cloned snapshot of the JSON payload before
   * applying JSONPath rules so that callers (typically logging paths) can
   * render accurate before/after views. When false, the clone is skipped to
   * reduce CPU/GC overhead on large payloads.
   */
  captureBeforeJson = true
} = {}) {
  if (isEmptyBuffer(buffer)) {
    return { buffer, json: null, appliedRuleIds: [], changed: false, decompressed: null }
  }

  const lowerType = safeString(contentType).toLowerCase()
  if (!lowerType.includes('application/json')) {
    return { buffer, json: null, appliedRuleIds: [], changed: false, decompressed: null }
  }

  const normalizedEncoding = safeString(encoding).toLowerCase()
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

  const jsonPathContext = buildJsonPathRuleContext({
    ...(urlContext || {}),
    phase
  })

  const normalized = normalizeNestedJsonStrings(parsed)

  // Capture a structured snapshot of the JSON payload before JSONPath rules
  // are applied so that logs and the UI can render a true "before rewrite"
  // view alongside the final rewritten object. This work is gated by the
  // captureBeforeJson flag so that non-logging callers can skip the deep
  // clone on large payloads.
  let beforeJson = null
  if (captureBeforeJson) {
    try {
      beforeJson = JSON.parse(JSON.stringify(normalized))
    } catch {}
  }

  const jsonPathResult = applyJsonPathRulesToObject(normalized, jsonPathContext)
  if (!jsonPathResult || !jsonPathResult.changed) {
    return {
      buffer,
      json: jsonPathResult ? jsonPathResult.object : parsed,
      beforeJson,
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
    beforeJson,
    appliedRuleIds: jsonPathResult.appliedRuleIds || [],
    changed: true,
    decompressed
  }
}

/**
 * Normalise HTTP JSON body rewriting into a single helper so that
 * rewriteJsonHttpBody does not need to know about raw headers, while
 * callers get a consistent { buffer, jsonRewrite, contentType } contract.
 *
 * The captureBeforeJson flag allows logging-heavy paths to opt into a
 * deep-cloned "before" snapshot while non-logging callers can skip it.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer
 * @param {Object} params.headers
 * @param {string} params.requestUrl
 * @param {string} params.fullUrl
 * @param {('request'|'response')} [params.phase='request']
 * @param {boolean} [params.captureBeforeJson=true]
 * @returns {{ buffer: Buffer, jsonRewrite: object, contentType: string }}
 */
function runJsonBodyRewrite ({
  buffer,
  headers,
  requestUrl,
  fullUrl,
  phase = 'request',
  captureBeforeJson = true
}) {
  const headerSource = headers || {}
  const contentType = getContentType(headerSource)
  const encoding = getContentEncoding(headerSource)

  const jsonRewrite = rewriteJsonHttpBody({
    buffer,
    encoding,
    contentType,
    urlContext: { requestUrl, fullUrl },
    phase,
    captureBeforeJson
  })

  return {
    buffer: jsonRewrite.buffer,
    jsonRewrite,
    contentType
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

  const wantsLogging = wantsInteractiveLogging(logEntry)

  const { buffer: nextBuffer, jsonRewrite, contentType } = runJsonBodyRewrite({
    buffer,
    headers,
    requestUrl,
    fullUrl,
    phase: 'request',
    captureBeforeJson: wantsLogging
  })

  const { logNonJsonBody = false } = options || {}
  const isJsonContentType = typeof contentType === 'string' && contentType.toLowerCase().includes('application/json')

  if (logEntry && jsonRewrite.json !== null && jsonRewrite.json !== undefined) {
    // For HTTP JSON requests, store the parsed object directly on the log
    // entry so that the frontend can render structured JSON without having to
    // re-parse the body string.
    logEntry.body = jsonRewrite.json
    logEntry.requestBodyJson = jsonRewrite.json

    // When a JSONPath rewrite changed the payload, also capture the structured
    // "before" view so the UI can render before/after side-by-side.
    if (jsonRewrite.beforeJson && jsonRewrite.changed) {
      logEntry.requestBodyJsonBefore = jsonRewrite.beforeJson
    }
  }

  const previewSource = jsonRewrite.decompressed || nextBuffer
  let preview
  if (logEntry) {
    preview = bufferToTextPreview(previewSource)
    if (preview) {
      logEntry.rawRequestBodyPreview = preview
    }

    if (hasAppliedRules(jsonRewrite.appliedRuleIds)) {
      attachRewriteMetadata(logEntry, jsonRewrite.appliedRuleIds, 'request')
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

/**
 * Apply JSONPath-based rewrites to a plain JSON HTTP response body and
 * update the associated log entry (JSON views + rewrite metadata).
 *
 * This helper mirrors applyJsonRequestRewritesForLog but for response
 * bodies. It is used by both the main Express proxy and the HTTPS MITM
 * pipeline to keep response-side JSON handling consistent.
 *
 * Callers are expected to gate execution based on whether there are any
 * JSONPath rules for the current URL/phase, so that we avoid unnecessary
 * JSON work when there are no applicable rules.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - Raw HTTP response body buffer.
 * @param {Object} params.headers - Response headers.
 * @param {string} params.requestUrl - Request URL/path as seen by the proxy.
 * @param {string} params.fullUrl - Fully-qualified URL when available.
 * @param {Object} [params.logEntry] - Mutable log entry to enrich.
 * @param {('request'|'response')} [params.phase='response'] - JSONPath phase.
 * @returns {{ buffer: Buffer, jsonRewrite: object|null }} Updated body buffer
 * and raw jsonRewrite result for advanced callers.
 */
function applyJsonResponseRewritesForLog ({
  buffer,
  headers,
  requestUrl,
  fullUrl,
  logEntry,
  phase = 'response'
}) {
  if (isEmptyBuffer(buffer)) {
    return { buffer, jsonRewrite: null }
  }
  const wantsLogging = wantsInteractiveLogging(logEntry)

  const { buffer: nextBuffer, jsonRewrite } = runJsonBodyRewrite({
    buffer,
    headers,
    requestUrl,
    fullUrl,
    phase,
    captureBeforeJson: wantsLogging
  })

  if (logEntry && jsonRewrite.json !== null && jsonRewrite.json !== undefined) {
    logEntry.responseBodyJson = jsonRewrite.json
    if (jsonRewrite.beforeJson && jsonRewrite.changed) {
      logEntry.responseBodyJsonBefore = jsonRewrite.beforeJson
    }
  }

  if (logEntry && Array.isArray(jsonRewrite.appliedRuleIds) && jsonRewrite.appliedRuleIds.length) {
    attachRewriteMetadata(logEntry, jsonRewrite.appliedRuleIds, phase)
  }

  return { buffer: nextBuffer, jsonRewrite }
}

const PROTO_CONTENT_TYPES = [
  'application/proto',
  'application/grpc',
  'application/grpc+proto',
  'application/connect+proto'
]

function isProtoContentType (contentType = '') {
  return contentTypeMatchesAny(contentType, PROTO_CONTENT_TYPES)
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
 * a maximum size guard with early termination. Stops processing parts as soon
 * as the limit is reached to avoid unnecessary string operations.
 *
 * @param {string[]} parts
 * @returns {string} lower-cased snapshot or an empty string
 */
function buildSearchSnapshot (parts) {
  if (!Array.isArray(parts) || parts.length === 0) return ''

  const maxBytes = Number.isFinite(SEARCH_SNAPSHOT_MAX_BYTES) && SEARCH_SNAPSHOT_MAX_BYTES > 0
    ? SEARCH_SNAPSHOT_MAX_BYTES
    : 0

  const result = []
  let totalLength = 0
  let truncated = false

  for (const part of parts) {
    if (typeof part !== 'string' || !part) continue
    if (maxBytes && totalLength >= maxBytes) {
      truncated = true
      break
    }

    const lower = part.toLowerCase()
    if (!maxBytes) {
      result.push(lower)
      continue
    }

    const remaining = maxBytes - totalLength
    if (lower.length <= remaining) {
      result.push(lower)
      totalLength += lower.length
    } else {
      result.push(lower.slice(0, remaining))
      totalLength += remaining
      truncated = true
      break
    }
  }

  if (!result.length) return ''

  const snapshot = result.join('\n')
  if (truncated) {
    return `${snapshot}\n[search snapshot truncated]`
  }
  return snapshot
}

/**
 * Convenience helper to build a size-limited, lower-cased search snapshot
 * from a JSON-serializable object (typically headers).
 * Optimized for flat objects to avoid full JSON.stringify overhead.
 *
 * @param {any} value
 * @returns {string} search snapshot or an empty string
 */
function buildJsonSearchSnapshot (value) {
  if (!value) return ''

  // Fast path for flat objects (common case: headers)
  if (typeof value === 'object' && !Array.isArray(value)) {
    const parts = []
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      const v = value[key]
      if (v === undefined) continue
      parts.push(`${key}:${v}`)
    }
    if (parts.length) {
      return buildSearchSnapshot(parts)
    }
  }

  // Fallback for complex values
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

// Precompiled regex for bufferToTextPreview to avoid repeated compilation
const NON_PRINTABLE_REGEX = /[^\x09\x0A\x0D\x20-\x7E]/g
const ASCII_SEGMENT_REGEX = /[\x20-\x7E]{4,}/g

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

  NON_PRINTABLE_REGEX.lastIndex = 0
  const printable = text.replace(NON_PRINTABLE_REGEX, '')
  const ratio = printable.length / text.length

  let result = ''

  if (ratio >= 0.85) {
    result = text
  } else if (ratio >= 0.35 && printable.trim()) {
    result = printable.trim()
  } else {
    ASCII_SEGMENT_REGEX.lastIndex = 0
    const asciiSegments = printable.match(ASCII_SEGMENT_REGEX)
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
 * @param {Buffer|null} [params.decompressedBuffer] - Optional pre-decompressed
 * HTTP body buffer to reuse for logging, avoiding a second decompression when
 * JSON/Connect helpers have already produced one.
 * @returns {{ body: string }}
 */
function buildHttpResponseLoggingView ({
  logEntry,
  buffer,
  contentType,
  contentEncoding,
  isBinary,
  connectResponse,
  allowUnaryConnectText = false,
  decompressedBuffer = null
}) {
  if (isEmptyBuffer(buffer)) {
    return { body: '' }
  }

  let dataToLog = buffer

  if (contentEncoding && !isBinary) {
    if (decompressedBuffer && Buffer.isBuffer(decompressedBuffer)) {
      dataToLog = decompressedBuffer
    } else {
      const decompressed = decompressDataForLogging(buffer, contentEncoding, contentType)
      if (decompressed && Buffer.isBuffer(decompressed)) {
        dataToLog = decompressed
      }
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

  const lowerType = safeString(contentType).toLowerCase()

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

  // When we already have a structured JSON view on the log entry (for
  // example populated by JSONPath rewrites), prefer that instead of
  // re-parsing the textual body.
  if (logEntry && logEntry.responseBodyJson && typeof logEntry.responseBodyJson === 'object') {
    responseBodyJson = logEntry.responseBodyJson
  }

  // When we have a textual HTTP response body and a JSON-like content-type,
  // attempt to parse it once here so the frontend can render structured JSON
  // without re-parsing large strings. Normalise any nested JSON-as-string
  // fields (for example `channel_data`) so that the UI sees a fully
  // structured object tree.
  if (
    !hasConnect &&
    !responseBodyJson &&
    typeof responseBody === 'string' &&
    responseBody.length > 0 &&
    typeof contentType === 'string' &&
    contentType.toLowerCase().includes('json') &&
    !responseBody.startsWith('[Binary data:') &&
    !responseBody.startsWith('[Binary/Compressed data:')
  ) {
    try {
      const parsed = JSON.parse(responseBody)
      responseBodyJson = normalizeNestedJsonStrings(parsed)
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

  const contentType = getContentType(headers)

  if (!isProtoContentType(contentType) && !looksLikeConnectEnvelope(buffer)) {
    return null
  }

  const encodingHeader = getContentEncoding(headers).toLowerCase()
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

  const connectEncodingHeader = getConnectEncodingHeader(headers)
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
      let rawProtobufJson = null

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
          rawProtobufJson = extractJsonFromProtobufBuffer(framePayload)
          if (rawProtobufJson && typeof rawProtobufJson === 'object') {
            json = stripTrivialBinaryBlobs(rawProtobufJson)
          } else {
            json = rawProtobufJson
          }
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
        note
      })

      const frameEntry = frames[frames.length - 1]
      if (frameEntry && rawProtobufJson && typeof rawProtobufJson === 'object') {
        Object.defineProperty(frameEntry, '_rawProtobufJson', {
          value: rawProtobufJson,
          writable: false,
          enumerable: false,
          configurable: false
        })
      }

      // Cache the decoded frame payload on a non-enumerable property so that
      // applyConnectFrameRewrites can reuse the Buffer directly instead of
      // going through a base64 encode/decode round‑trip.
      if (frameEntry && frameDecompressed && Buffer.isBuffer(framePayload)) {
        try {
          Object.defineProperty(frameEntry, '_decodedBuffer', {
            value: framePayload,
            writable: false,
            enumerable: false,
            configurable: false
          })
        } catch {}
      }

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
    let rawProtobufJson = null

    if (withinSizeLimit) {
      preview = bufferToTextPreview(payload)
      json = tryParseJsonString(preview)
      if (json === null) {
        rawProtobufJson = extractJsonFromProtobufBuffer(payload)
        if (rawProtobufJson && typeof rawProtobufJson === 'object') {
          json = stripTrivialBinaryBlobs(rawProtobufJson)
        } else {
          json = rawProtobufJson
        }
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
      note
    })

    const frameEntry = frames[frames.length - 1]
    if (frameEntry && rawProtobufJson && typeof rawProtobufJson === 'object') {
      Object.defineProperty(frameEntry, '_rawProtobufJson', {
        value: rawProtobufJson,
        writable: false,
        enumerable: false,
        configurable: false
      })
    }
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

/**
 * Extract a JSON representation from a protobuf message buffer.
 *
 * The conversion:
 * - enforces global safeguards such as PROTOBUF_MAX_BYTES_LIMIT and
 *   PROTOBUF_MAX_FIELDS_LIMIT to avoid excessive work on large payloads;
 * - decodes nested messages recursively;
 * - attempts to interpret length-delimited fields as nested messages,
 *   UTF-8 strings or JSON strings before falling back to a binary blob
 *   representation of the form { base64, length }.
 *
 * This helper is used by rewrite paths and therefore must preserve the
 * existing structure so that JSONPath rules continue to behave identically.
 *
 * @param {Buffer} buffer - Protobuf message buffer for a single Connect frame.
 * @returns {object|null} Lightweight JSON view of the message, or null when the
 * payload cannot be safely represented.
 */
function extractJsonFromProtobufBuffer (buffer) {
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
    if (!fields || !fields.length) return null

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
          if (nested && Array.isArray(nested.fields) && nested.fields.length) {
            const nestedJson = toJsonFromFields(nested.fields, depth + 1)
            // Only accept as nested protobuf if result has protobuf-style keys (f1, f2, etc.)
            if (nestedJson && Object.keys(nestedJson).length > 0) {
              const keys = Object.keys(nestedJson)
              const hasProtobufKeys = keys.some(k => /^f\d+$/.test(k))
              if (hasProtobufKeys) {
                value = nestedJson
                handled = true
              }
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
                // Try to parse as JSON for richer JSONPath access.
                // If parsing fails, keep as plain text.
                const trimmedText = text.trim()
                let json = null
                try {
                  json = JSON.parse(trimmedText)
                } catch {
                  // Not valid JSON - preserve as text
                }
                value = json !== null ? json : trimmedText
                handled = true
              }
            }
          } catch {}
        }

        if (!handled) {
          const length = field.data.length
          if (length > 0) {
            value = {
              base64: field.data.toString('base64'),
              length
            }
          } else {
            // Preserve zero-length strings as empty strings to maintain structure.
            // Without this, text rules that empty a field would cause the field
            // to be dropped entirely during JSON extraction -> re-encoding cycle.
            value = ''
          }
        }
      } else if ((field.wireType === 1 || field.wireType === 5) && Buffer.isBuffer(field.data)) {
        // Fixed 32/64-bit: expose as hex blob (skip empty buffers)
        const length = field.data.length
        if (length > 0) {
          value = {
            bytesHex: field.data.toString('hex'),
            length
          }
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
 * Walk a JSON tree produced by extractJsonFromProtobufBuffer and remove
 * trivial binary blobs that only carry empty data, such as
 * { base64: "", length: 0 }.
 *
 * The function preserves the overall shape of the object while pruning
 * obviously useless placeholders from arrays and objects. This is intended
 * for logging/search views only; rewrite paths should continue to use the
 * raw extractJsonFromProtobufBuffer output so JSONPath rules see the full
 * structure.
 *
 * @param {any} value - Arbitrary JSON value to clean.
 * @returns {any} Cleaned JSON value with trivial blobs removed.
 */
function stripTrivialBinaryBlobs (value) {
  if (value === null || value === undefined) return value

  if (Array.isArray(value)) {
    const next = []
    for (const item of value) {
      const cleaned = stripTrivialBinaryBlobs(item)
      if (cleaned !== undefined) {
        next.push(cleaned)
      }
    }
    return next
  }

  if (typeof value !== 'object') {
    return value
  }

  const keys = Object.keys(value)

  // Detect the canonical { base64, length } blob representation produced by
  // extractJsonFromProtobufBuffer and drop it completely when it carries no
  // actual data. This keeps logging views compact for empty binary fields.
  if (keys.length === 2 && keys.includes('base64') && keys.includes('length')) {
    const base64 = value.base64
    const length = value.length

    if ((base64 === '' || base64 === null || base64 === undefined) &&
        typeof length === 'number' &&
        length === 0) {
      // Returning undefined here signals to the caller that this node should
      // be removed from its parent container.
      return undefined
    }
  }

  const result = {}
  for (const key of keys) {
    const cleaned = stripTrivialBinaryBlobs(value[key])
    if (cleaned !== undefined) {
      result[key] = cleaned
    }
  }

  return result
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
  const hasRulesForConnect = hasAnyEditOrJsonPathRules()

  // Heavy Connect/protobuf *logging* is only needed when we have interactive
  // logging enabled and a real log entry to enrich. When interactive mode is
  // disabled we still perform rewrites, but we skip the extra Connect decode
  // pass used purely for logging.
  const wantsLogging = wantsInteractiveLogging(logEntry)

  if (!hasRulesForConnect && !wantsLogging) {
    // No rules and no logging: avoid any Connect/protobuf work and leave the
    // body untouched. Previously this function would also return the original
    // buffer in this case, so the early return is behaviourally equivalent but
    // skips unnecessary setup.
    return { buffer, connect: null }
  }

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
      if (logEntry && hasAppliedRules(connectRewriteResult.appliedRuleIds)) {
        attachRewriteMetadata(logEntry, connectRewriteResult.appliedRuleIds, role)
      }

      if (updateContentEncoding && Object.hasOwn(connectRewriteResult, 'encoding')) {
        if (connectRewriteResult.encoding) {
          headers['content-encoding'] = connectRewriteResult.encoding
        } else {
          delete headers['content-encoding']
        }
      }
    } else if (allowBodyRewriteFallback && hasCompiledTextRules()) {
      // Fallback to plain text rewrites only when the content-type suggests
      // textual payloads. This avoids unnecessary UTF-8 decoding and regex
      // work on clearly binary data.
      const contentType = getContentType(headers)

      if (isTextualContentType(contentType)) {
        const bodyRewriteResult = applyEditRulesToBuffer(workingBuffer)
        if (bodyRewriteResult.changed) {
          workingBuffer = bodyRewriteResult.buffer

          // When logging is enabled, capture before/after text snapshots so the
          // UI can render a true textual diff for pure text rules as well.
          if (logEntry) {
            if (isResponse) {
              if (typeof bodyRewriteResult.beforeText === 'string') {
                logEntry.responseBodyTextBefore = bodyRewriteResult.beforeText
              }
              if (typeof bodyRewriteResult.afterText === 'string') {
                logEntry.responseBodyTextAfter = bodyRewriteResult.afterText
              }
            } else {
              if (typeof bodyRewriteResult.beforeText === 'string') {
                logEntry.requestBodyTextBefore = bodyRewriteResult.beforeText
              }
              if (typeof bodyRewriteResult.afterText === 'string') {
                logEntry.requestBodyTextAfter = bodyRewriteResult.afterText
              }
            }

            if (hasAppliedRules(bodyRewriteResult.appliedRuleIds)) {
              attachRewriteMetadata(logEntry, bodyRewriteResult.appliedRuleIds, isResponse ? 'response' : 'request')
            }
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
            attachRewriteMetadata(logEntry, previewRewrite.appliedRuleIds, role)
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
      preview: safeString(frame.preview),
      json: frame.json ?? null,
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
        preview: safeString(frame.preview),
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

  if (!hasAnyEditOrJsonPathRules()) {
    // No active edit/JSONPath rules and bypass responses never log Connect
    // payloads, so calling applyConnectRewritesAndDecode would be a no-op.
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

/**
 * Process a request body buffer through Connect/protobuf and JSONPath
 * rewrites, updating the log entry as needed.
 *
 * This helper unifies the common pattern used by both the Express proxy
 * middleware and the HTTPS MITM request handler.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - Raw request body buffer.
 * @param {Object} params.headers - Request headers.
 * @param {string} params.requestUrl - Request URL path.
 * @param {string} params.fullUrl - Fully qualified URL.
 * @param {Object|null} params.logEntry - Mutable log entry to enrich.
 * @param {boolean} [params.allowBodyRewriteFallback=false] - Allow text fallback rewrites.
 * @param {boolean} [params.logNonJsonBody=false] - Log non-JSON body text.
 * @returns {{ buffer: Buffer, connectRequest: object|null }}
 */
function processRequestBodyWithRewrites ({
  buffer,
  headers,
  requestUrl,
  fullUrl,
  logEntry,
  allowBodyRewriteFallback = false,
  logNonJsonBody = false
}) {
  if (isEmptyBuffer(buffer)) {
    return { buffer: buffer || Buffer.alloc(0), connectRequest: null }
  }

  const shouldTouchConnect =
    (interactiveModeEnabled && !!logEntry) ||
    hasAnyEditOrJsonPathRules()

  let workingBuffer = buffer
  let connectRequest = null

  if (shouldTouchConnect) {
    const connectResult = applyConnectRewritesAndDecode(
      logEntry,
      buffer,
      headers,
      { role: 'request', allowBodyRewriteFallback, updateContentEncoding: true }
    )
    workingBuffer = connectResult.buffer
    connectRequest = connectResult.connect
  }

  if (!connectRequest) {
    const hasJsonPathRules = hasCompiledJsonPathRules()

    if (hasJsonPathRules || interactiveModeEnabled) {
      const { buffer: nextBuffer } = applyJsonRequestRewritesForLog({
        buffer: workingBuffer,
        headers,
        requestUrl,
        fullUrl,
        logEntry
      }, { logNonJsonBody })
      workingBuffer = nextBuffer
    }
  }

  return { buffer: workingBuffer, connectRequest }
}

/**
 * Orchestrate response-side body rewrites and logging for a buffered
 * upstream HTTP/HTTPS response.
 *
 * This keeps the plain HTTP proxy and HTTPS MITM response handling paths
 * aligned while preserving existing behaviour. The helper:
 * - runs Connect/protobuf-aware rewrites and optional text fallbacks;
 * - applies JSONPath HTTP JSON rewrites for non-Connect payloads;
 * - can optionally apply per-frame text rewrites for Connect responses
 *   (currently only enabled for HTTPS MITM);
 * - builds the HTTP response logging view and updates the provided log entry.
 *
 * It does not write to any client response objects; callers remain responsible
 * for forwarding `finalResponseBuffer` and headers.
 *
 * @param {object} [options]
 * @param {Buffer} options.responseBuffer - Raw buffered upstream response body.
 * @param {object} options.upstreamHeaders - Mutable upstream response headers.
 * @param {string} options.requestUrl - Request URL path used for rule matching.
 * @param {string} options.jsonPathFullUrl - Full URL used for JSONPath rules.
 * @param {object|null} options.logEntry - Mutable log entry to enrich, or null.
 * @param {'proxied'|'mitm'} options.source - Source tag to set on the log entry.
 * @param {string} options.targetUrlForLog - Final upstream target URL for logging.
 * @param {boolean} options.overrideFullUrlOnLog - If true, replace logEntry.fullUrl with targetUrlForLog.
 * @param {boolean} options.allowUnaryConnectText - Whether unary Connect responses may be rendered as text.
 * @param {number} options.statusCode - Upstream HTTP status code.
 * @param {boolean} [options.enableConnectFrameTextRewrites] - Enable per-frame text rewrites for Connect.
 * @param {string} [options.frameRewriteFullUrl] - Full URL used for Connect frame text rule matching.
 * @returns {{
 *   finalResponseBuffer: Buffer,
 *   upstreamHeaders: object,
 *   connectResponse: object|null,
 *   contentType: string,
 *   contentEncoding: string,
 *   isBinary: boolean
 * }}
 */
function handleBufferedUpstreamResponseWithRewrites (options = {}) {
  const {
    responseBuffer,
    upstreamHeaders,
    requestUrl,
    jsonPathFullUrl,
    logEntry,
    source,
    targetUrlForLog,
    overrideFullUrlOnLog,
    allowUnaryConnectText,
    statusCode,
    enableConnectFrameTextRewrites,
    frameRewriteFullUrl
  } = options

  const headers = upstreamHeaders || {}

  // Capture the content metadata *before* any Connect rewrites update the
  // content-encoding header, matching the previous behaviour in both the
  // HTTP proxy and HTTPS MITM response paths.
  const contentType = getContentType(headers)
  const contentEncoding = getContentEncoding(headers)
  const isBinary = isClearlyBinaryContentType(contentType)

  const {
    buffer: effectiveResponseBuffer,
    connect: connectResponse
  } = applyConnectRewritesAndDecode(
    logEntry,
    responseBuffer,
    headers,
    { role: 'response', allowBodyRewriteFallback: true, updateContentEncoding: true }
  )

  let finalResponseBuffer = effectiveResponseBuffer
  let jsonDecompressedForLog = null

  if (!connectResponse) {
    if (hasCompiledJsonPathRules()) {
      const { buffer: updatedBuffer, jsonRewrite } = applyJsonResponseRewritesForLog({
        buffer: finalResponseBuffer,
        headers,
        requestUrl,
        fullUrl: jsonPathFullUrl,
        logEntry,
        phase: 'response'
      })

      finalResponseBuffer = updatedBuffer

      if (jsonRewrite && Buffer.isBuffer(jsonRewrite.decompressed)) {
        jsonDecompressedForLog = jsonRewrite.decompressed
      }
    }
  } else if (enableConnectFrameTextRewrites && connectResponse.frames?.length) {
    if (hasCompiledTextRules()) {
      const rewrittenFrames = []
      const appliedSet = new Set()
      let frameChanged = false
      const frameFullUrl = frameRewriteFullUrl || jsonPathFullUrl || requestUrl

      for (const frame of connectResponse.frames) {
        if (frame.compressed || frame.error) {
          rewrittenFrames.push(frame)
          continue
        }

        const frameText = frame.preview || (frame.json ? JSON.stringify(frame.json) : '')
        const rewriteResult = applyEditRulesToText(frameText, {
          requestUrl,
          fullUrl: frameFullUrl,
          phase: 'response'
        })

        if (rewriteResult.changed) {
          frameChanged = true
          if (Array.isArray(rewriteResult.appliedRuleIds)) {
            rewriteResult.appliedRuleIds.forEach(id => appliedSet.add(id))
          }
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
        if (logEntry && appliedSet.size > 0) {
          attachRewriteMetadata(logEntry, Array.from(appliedSet), 'response')
        }
      }
    }
  }

  if (logEntry) {
    const view = buildHttpResponseLoggingView({
      logEntry,
      buffer: finalResponseBuffer,
      contentType,
      contentEncoding,
      isBinary,
      connectResponse,
      allowUnaryConnectText,
      decompressedBuffer: jsonDecompressedForLog
    })

    const responseBody = view.body

    if (source) {
      logEntry.source = source
    }
    if (targetUrlForLog) {
      logEntry.targetUrl = targetUrlForLog
    }
    if (overrideFullUrlOnLog && targetUrlForLog) {
      logEntry.fullUrl = targetUrlForLog
    }
    if (typeof statusCode === 'number') {
      logEntry.statusCode = statusCode
    }
    logEntry.responseHeaders = headers
    if (!connectResponse) {
      logEntry.responseBody = responseBody
    }

    if (Buffer.isBuffer(finalResponseBuffer)) {
      logEntry.responseSize = finalResponseBuffer.length
    } else if (typeof finalResponseBuffer === 'string') {
      logEntry.responseSize = Buffer.byteLength(finalResponseBuffer)
    }

    addLog(logEntry)
  }

  return {
    finalResponseBuffer,
    upstreamHeaders: headers,
    connectResponse,
    contentType,
    contentEncoding,
    isBinary
  }
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

  const req = safeString(requestUrl)
  const full = safeString(fullUrl)

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
      if (Object.hasOwn(updated, 'bypassMode')) {
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
 * Unified log entry factory for HTTP and WebSocket flows.
 * Consolidates createBaseLogEntry, createHttpFlowLogEntry and createWebSocketConnectionLog.
 *
 * @param {Object} params
 * @param {number} [params.requestStart] - Timestamp for HTTP flows.
 * @param {string} params.method - HTTP method or 'WS'.
 * @param {string} params.url
 * @param {string} params.fullUrl
 * @param {Object} [params.headers]
 * @param {string} params.source
 * @param {string} [params.clientIp]
 * @param {boolean} [params.sanitizeHeaders=false] - Strip identifying headers.
 * @param {Object} [params.wsOptions] - WebSocket-specific options.
 * @param {string} [params.wsOptions.direction]
 * @param {string} [params.wsOptions.message]
 * @param {number} [params.wsOptions.connectionId]
 * @returns {Object}
 */
function createLogEntry ({ requestStart, method, url, fullUrl, headers, source, clientIp, sanitizeHeaders = false, wsOptions }) {
  const ts = Number.isFinite(requestStart) ? requestStart : Date.now()
  const processedHeaders = sanitizeHeaders
    ? sanitizeAndStripIdentifyingHeaders(headers || {})
    : (headers || {})

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
 */
function createHttpFlowLogEntry ({ requestStart, method, url, fullUrl, headers, source, clientIp }) {
  return createLogEntry({ requestStart, method, url, fullUrl, headers, source, clientIp, sanitizeHeaders: true })
}

/**
 * Count frames in a Connect/gRPC payload structure.
 *
 * @param {object|null} connect
 * @returns {number}
 */
function countConnectFrames (connect) {
  if (!connect || typeof connect !== 'object') return 0
  if (typeof connect.frameCount === 'number') return connect.frameCount
  if (Array.isArray(connect.frames)) return connect.frames.length
  return 0
}

/**
 * Compute lightweight per-request metrics for the audit panel.
 * Mutates the log entry in place.
 *
 * @param {object} logEntry
 */
function computeLogEntryMetrics (logEntry) {
  if (!logEntry || typeof logEntry !== 'object') return

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

// Helper to add log only if interactive mode is enabled
function addLog (logEntry) {
  if (!interactiveModeEnabled) return
  if (logEntry && typeof logEntry === 'object') {
    // Precompute whether this log should be hidden by blocked URL rules. This
    // moves the cost of blocked URL matching to log insertion and rules
    // updates instead of every /api/logs request.
    try {
      const patterns = Array.isArray(blockedUrlSubstringsForFilter) ? blockedUrlSubstringsForFilter : []
      if (patterns.length > 0) {
        const urlString = getLogUrlString(logEntry)
        if (urlString) {
          logEntry.hiddenByBlockedRules = patterns.some(pattern => urlString.includes(pattern))
        }
      }
    } catch {}

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

    // Compute lightweight per-request metrics used by the audit panel
    computeLogEntryMetrics(logEntry)
  }
  requestLogs.unshift(logEntry)
  updateSuggestionStatsOnAdd(logEntry)
  applyDashboardStatsDelta(logEntry, 1)
  if (requestLogs.length > MAX_LOG_ENTRIES) {
    const removed = requestLogs.pop()
    if (removed) {
      updateSuggestionStatsOnRemove(removed)
      applyDashboardStatsDelta(removed, -1)
      // Keep edit rule usage counters aligned with the current in-memory
      // requestLogs window by decrementing counts for any rules that were
      // recorded on the evicted log entry.
      if (Array.isArray(removed.rewrites)) {
        for (const rewrite of removed.rewrites) {
          const id = rewrite && rewrite.id
          if (!id) continue

          const current = editRuleUsageCounters.get(id)
          if (typeof current === 'number' && current > 0) {
            const next = current - 1
            if (next > 0) {
              editRuleUsageCounters.set(id, next)
            } else {
              editRuleUsageCounters.delete(id)
            }
          }
        }
      }
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

/**
 * Handle an upstream request error by logging it and sending an appropriate
 * error response to the client. Works with both Express responses and raw
 * HTTP ServerResponse objects.
 *
 * @param {object} params
 * @param {object|null} params.logEntry - Log entry to record the error on.
 * @param {Error} params.error - The upstream error.
 * @param {import('http').ServerResponse} params.res - Response object.
 * @param {string} [params.message='Bad Gateway'] - Error message for raw responses.
 * @param {boolean} [params.useJson=false] - Use JSON response (Express style).
 */
function handleUpstreamError ({ logEntry, error, res, message = 'Bad Gateway', useJson = false }) {
  if (logEntry) {
    recordUpstreamErrorOnLog(logEntry, error)
  }

  if (!res.headersSent) {
    if (useJson && typeof res.status === 'function') {
      res.status(502).json({ error: 'Proxy error', message: error.message })
    } else {
      res.writeHead(502)
      res.end(message)
    }
  } else {
    try { res.end() } catch {}
  }
}

function extractHostInfoFromLog (logEntry) {
  if (!logEntry || typeof logEntry !== 'object') return null

  if (logEntry._hostInfo && logEntry._hostInfo.host) {
    return logEntry._hostInfo
  }

  const headerHost = typeof logEntry.headers?.host === 'string'
    ? logEntry.headers.host.toLowerCase()
    : null

  const tryParseUrl = (candidate) => {
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
      } catch {}
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

  if (!Object.hasOwn(source, 'enabled')) {
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
 * Validate that an ID is a non-empty string.
 *
 * @param {any} id
 * @returns {boolean}
 */
function isValidId (id) {
  return typeof id === 'string' && id.trim().length > 0
}

/**
 * Check if interactive logging is enabled and a log entry is available.
 * This centralises the common guard pattern used across request/response
 * processing paths.
 *
 * @param {object|null} logEntry
 * @returns {boolean}
 */
function wantsInteractiveLogging (logEntry) {
  return interactiveModeEnabled && !!logEntry
}

/**
 * Check if an appliedRuleIds array is non-empty.
 * Centralises the common guard pattern for rewrite metadata attachment.
 *
 * @param {any} appliedRuleIds
 * @returns {boolean}
 */
function hasAppliedRules (appliedRuleIds) {
  return Array.isArray(appliedRuleIds) && appliedRuleIds.length > 0
}

/**
 * Extract the URL string from a log entry, preferring fullUrl over url.
 * Returns an empty string if neither is available.
 *
 * @param {object|null} log
 * @returns {string}
 */
function getLogUrlString (log) {
  if (!log) return ''
  return ((log.fullUrl || log.url) || '').toString()
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

      // Frame binary data is not included in the search index to keep
      // the index lightweight. Only preview and JSON content are indexed.
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
  // Early return if already cached
  if (log?.fileType) return log.fileType

  const contentType = (log && log.responseHeaders)
    ? getContentType(log.responseHeaders)
    : ''
  const url = getLogUrlString(log).toLowerCase()

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
          preview: safeString(frame.preview),
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
/**
 * Build the base client-facing log view shared by full and summary variants.
 *
 * @param {object|null} log
 * @returns {object|null}
 */
function buildBaseClientLogView (log) {
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
  'upstreamDurationMs', 'upstreamErrorCategory', 'requestStartTs', 'totalDurationMs',
  'proxyOverheadMs', 'requestBytes', 'responseBytes', 'rewriteCount', 'connectionId',
  'isConnectionLog', 'isWebSocketSummary', 'headers', 'responseHeaders',
  'requestBodySummary', 'responseBodySummary', 'rewrites', 'connectSummary', 'wsSummary'
]

// Fields to copy only in full view (not summary)
const LOG_VIEW_FULL_FIELDS = [
  'body', 'responseBody', 'requestBodyJson', 'responseBodyJson',
  'requestBodyJsonBefore', 'responseBodyJsonBefore',
  'requestBodyTextBefore', 'requestBodyTextAfter',
  'responseBodyTextBefore', 'responseBodyTextAfter',
  'wsBodyJsonAfter', 'wsBodyJsonBefore', 'originalBody',
  'rawRequestBodyPreview', 'rawResponseBodyPreview'
]

/**
 * Build client log view with optional body/preview fields.
 * When summary=true, omits heavy body/preview data for list endpoints.
 *
 * @param {object|null} log
 * @param {{summary?: boolean}} [options]
 * @returns {object|null}
 */
function buildClientLogViewInternal (log, options = {}) {
  const summary = options.summary === true
  const view = buildBaseClientLogView(log)
  if (!view) return null

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

const buildClientLogView = log => buildClientLogViewInternal(log, { summary: false })
const buildClientLogSummaryView = log => buildClientLogViewInternal(log, { summary: true })

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

  // Use the precomputed blockedUrlSubstringsForFilter list so we don't
  // rebuild the pattern set on every /api/logs call. This is now primarily a
  // fallback for legacy log entries that predate the hiddenByBlockedRules flag;
  // new entries rely on that boolean for a cheap exclusion check.
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

    let requestSearchContentLower = safeString(log?.requestSearchContent)
    let headersSearchLower = safeString(log?.headersSearch)

    const matchesRequestBodySearch = requestBodySearch === '' || (
      (requestSearchContentLower && requestSearchContentLower.includes(requestBodySearchLower)) ||
      (headersSearchLower && headersSearchLower.includes(requestBodySearchLower))
    )

    if (!matchesRequestBodySearch) return false

    // Response body/headers search snapshot (cached when available)
    let responseSearchContentLower = safeString(log?.responseSearchContent)
    let responseHeadersSearchLower = safeString(log?.responseHeadersSearch)

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

  // Reverse without double allocation (avoid slice().reverse())
  const total = filtered.length
  const ordered = new Array(total)
  for (let i = 0; i < total; i++) {
    ordered[i] = filtered[total - 1 - i]
  }

  return { ordered, total }
}

/**
 * Helper used by /api/logs to apply filtering, pagination and view selection
 * in a single pass over the in-memory log window.
 *
 * @param {import('express').Request} req
 * @returns {{ items: any[], total: number, hasMore: boolean, offset: number, limit: number }}
 */
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

  const useSummaryView = safeString(query.view).toLowerCase() === 'summary'
  const items = ordered
    .slice(start, end)
    .map(log => (useSummaryView ? buildClientLogSummaryView(log) : buildClientLogView(log)))
  const hasMore = end < total

  return { items, total, hasMore, offset, limit }
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
		const protocol = safeString(parsed.protocol).toLowerCase()
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

  if (hostHeader && hostHeader !== `localhost:${PORT}` && hostHeader !== `127.0.0.1:${PORT}`) {
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

// Cache for custom omit sets to avoid repeated allocations
const customOmitSetCache = new Map()

/**
 * Get or create a Set for the given omit array, using cached precomputed sets
 * for known constants and caching custom arrays by their joined key.
 */
function getOmitSet (omit) {
  if (omit === OMIT_HEADERS_PROXY) return OMIT_HEADERS_PROXY_SET
  if (omit === OMIT_HEADERS_MITM) return OMIT_HEADERS_MITM_SET
  if (omit === OMIT_HEADERS_BASE) return OMIT_HEADERS_BASE_SET
  if (!Array.isArray(omit) || omit.length === 0) return new Set()

  const key = omit.map(h => h.toLowerCase()).sort().join(',')
  if (customOmitSetCache.has(key)) return customOmitSetCache.get(key)

  const set = new Set(omit.map(h => h.toLowerCase()))
  customOmitSetCache.set(key, set)
  return set
}

function createForwardHeaders (sourceHeaders, omit = [], overrides = {}) {
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
  const requestUrl = safeString(req.url) || '/'
  const hostHeader = safeString(req.headers?.host)
  const host = resolvedTarget?.host || normalizeHostValue(hostHeader)

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
    host,
    path,
    targetUrl: resolvedTarget?.url,
    method: req.method
  })
}

/**
 * Shared helper for direct/bypass HTTP flows. Handles log entry creation,
 * bypass count increment, header forwarding, and upstream request.
 *
 * @param {Object} params
 * @param {import('http').IncomingMessage} params.req
 * @param {import('http').ServerResponse} params.res
 * @param {string} params.targetUrl
 * @param {string} params.requestUrl
 * @param {string} params.fullUrl
 * @param {string} params.targetHost
 * @param {number} params.requestStart
 * @param {string} params.clientIp
 * @param {string[]} params.omitHeaders
 * @param {Buffer|import('stream').Readable|undefined} [params.body]
 * @param {boolean} [params.applyRewrites=false]
 * @param {boolean} [params.bufferResponse=false]
 * @param {boolean} [params.handleHead=false]
 * @returns {Promise<void>}
 */
async function handleDirectHttpFlow ({
  req, res, targetUrl, requestUrl, fullUrl, targetHost, requestStart, clientIp,
  omitHeaders, body, applyRewrites = false, bufferResponse = false, handleHead = false
}) {
  const hasLogging = interactiveModeEnabled === true
  const logEntry = hasLogging
    ? createHttpFlowLogEntry({
        requestStart,
        method: req.method,
        url: requestUrl,
        fullUrl: targetUrl,
        headers: req.headers,
        source: 'direct',
        clientIp
      })
    : null

  incrementBypassedCount()

  let headersToForward = createForwardHeaders(req.headers, omitHeaders, {
    host: targetHost
  })

  if (applyRewrites) {
    headersToForward = stripIdentifyingHeaders(headersToForward)
    headersToForward = applyHeaderRewrites(headersToForward, { requestUrl, fullUrl, phase: 'request' }, logEntry)
  }

  if (body && Buffer.isBuffer(body) && body.length > 0) {
    headersToForward['content-length'] = body.length
  }

  const transformUpstream = applyRewrites
    ? async ({ headers, buffer }) => {
        let upstreamHeaders = headers
        let responseBuffer = buffer

        if (responseBuffer) {
          upstreamHeaders = applyHeaderRewrites(upstreamHeaders, { requestUrl, fullUrl, phase: 'response' }, logEntry)

          const connectResult = applyConnectRewritesForBypass(
            responseBuffer,
            upstreamHeaders,
            { requestUrl, fullUrl }
          )
          responseBuffer = connectResult.buffer
        }

        return { headers: upstreamHeaders, buffer: responseBuffer }
      }
    : undefined

  const abortController = new AbortController()

  await forwardDirectHttp({
    req,
    res,
    url: targetUrl,
    method: req.method,
    headers: headersToForward,
    abortController,
    bufferResponse,
    body,
    logEntry,
    handleHead,
    bufferedLogMessage: '[bypass buffered response]',
    streamedLogMessage: '[streamed direct response]',
    requestUrl,
    fullUrl,
    transformUpstream
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
  const connectionHeader = safeString(req.headers?.connection).toLowerCase()
  const wantsUpgrade = Boolean(req.headers?.upgrade) || connectionHeader.includes('upgrade')
  if (wantsUpgrade) return false

  const resolvedTarget = resolveTargetFromRequest(req)
  const routingContext = buildBypassInputFromHttpRequest(req, resolvedTarget)
  const handling = decideHttpHandling(routingContext)

  const requestStart = Date.now()
  const requestUrl = safeString(req.url) || '/'
  const hostHeader = safeString(req.headers?.host)
  const protocol = req.socket?.encrypted ? 'https' : 'http'
  const authority = hostHeader || `localhost:${PORT}`
  const clientFacingUrl = `${protocol}://${authority}${requestUrl}`
  const clientIp = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown'

  if (handling === 'block') {
    if (interactiveModeEnabled) {
      const logEntry = createHttpFlowLogEntry({
        requestStart,
        method: req.method,
        url: requestUrl,
        fullUrl: clientFacingUrl,
        headers: req.headers,
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

  const target = new URL(targetUrl)
  const hasBody = !(req.method === 'GET' || req.method === 'HEAD')

  await handleDirectHttpFlow({
    req,
    res,
    targetUrl,
    requestUrl,
    fullUrl: targetUrl,
    targetHost: target.host,
    requestStart,
    clientIp,
    omitHeaders: OMIT_HEADERS_BASE,
    body: hasBody ? req : undefined,
    applyRewrites: false,
    bufferResponse: false,
    handleHead: true
  })

  return true
}

/**
 * Forward an HTTP request directly to an upstream target using
 * performUpstreamRequest. Shared by plain HTTP bypass and HTTPS
 * MITM direct flows.
 *
 * This helper focuses on the forwarding/logging/streaming mechanics.
 * Callers are responsible for routing decisions and any header/body
 * rewrites performed before or after the call.
 *
 * For advanced scenarios (such as HTTPS MITM bypass rewrites), callers
 * can provide a transformUpstream hook that receives the upstream
 * response/headers/body and may return updated { headers, buffer }.
 *
 * @param {Object} params
 * @param {import('http').IncomingMessage} params.req
 * @param {import('http').ServerResponse} params.res
 * @param {string} params.url
 * @param {string} params.method
 * @param {Object} params.headers
 * @param {AbortController} params.abortController
 * @param {boolean} [params.bufferResponse=false]
 * @param {Buffer|import('stream').Readable|undefined} [params.body]
 * @param {Object|null} [params.logEntry]
 * @param {boolean} [params.handleHead=false]
 * @param {string} [params.bufferedLogMessage='[bypass mitm buffered response]']
 * @param {string} [params.streamedLogMessage='[streamed direct response]']
 * @param {string} [params.requestUrl]
 * @param {string} [params.fullUrl]
 * @param {function} [params.transformUpstream]
 * @returns {Promise<{response: import('undici').Dispatcher.ResponseData|null, buffer: Buffer|null}>}
 */
async function forwardDirectHttp ({
  req,
  res,
  url,
  method,
  headers,
  abortController,
  bufferResponse = false,
  body,
  logEntry,
  handleHead = false,
  bufferedLogMessage = '[bypass mitm buffered response]',
  streamedLogMessage = '[streamed direct response]',
  requestUrl,
  fullUrl,
  transformUpstream
}) {
  const onClose = attachAbortOnClose(res, abortController)

  try {
    const upstreamStart = Date.now()

    const { response: upstreamResponse, buffer: responseBufferRaw } = await performUpstreamRequest({
      url,
      method,
      headers,
      body,
      abortSignal: abortController.signal,
      bufferResponse
    })

    let upstreamHeaders = upstreamResponse.headers
    let responseBuffer = responseBufferRaw

    if (typeof transformUpstream === 'function') {
      const transformed = await transformUpstream({
        upstreamResponse,
        headers: upstreamHeaders,
        buffer: responseBuffer,
        requestUrl,
        fullUrl,
        logEntry
      }) || {}

      if (transformed.headers) {
        upstreamHeaders = transformed.headers
      }
      if (Object.hasOwn(transformed, 'buffer')) {
        responseBuffer = transformed.buffer
      }
    }

    if (logEntry) {
      logEntry.upstreamDurationMs = Date.now() - upstreamStart
      logEntry.targetUrl = url
      logEntry.statusCode = upstreamResponse.statusCode
      logEntry.responseHeaders = upstreamHeaders
      if (bufferResponse && responseBuffer && Buffer.isBuffer(responseBuffer)) {
        logEntry.responseBody = bufferedLogMessage
        logEntry.responseSize = responseBuffer.length
      } else {
        logEntry.responseBody = streamedLogMessage
        logEntry.responseSize = null
      }
      addLog(logEntry)
    }

    const filteredHeaders = sanitizeHeaders(upstreamHeaders, OMIT_RESPONSE_HEADERS)
    res.writeHead(upstreamResponse.statusCode, filteredHeaders)

    if (bufferResponse && responseBuffer && Buffer.isBuffer(responseBuffer) && responseBuffer.length > 0) {
      res.end(responseBuffer)
    } else if (handleHead && req.method === 'HEAD') {
      res.end()
      if (upstreamResponse.body) {
        upstreamResponse.body.resume()
      }
    } else if (upstreamResponse.body) {
      upstreamResponse.body.pipe(res)
    } else {
      res.end()
    }

    return { response: upstreamResponse, buffer: responseBuffer }
  } catch (error) {
    handleUpstreamError({ logEntry, error, res, message: 'Bypass proxy error' })
    return { response: null, buffer: null }
  } finally {
    res.removeListener('close', onClose)
  }
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
  type: req => isProtoContentType(getContentType(req.headers)),
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
loadEditRulePresets()
rebuildEditRuleCache()

// Initialize CA certificate
const CA = getOrCreateCA()

// API Routes for UI
app.get('/api/logs', (req, res) => {
  try {
    const { items, total, hasMore, offset, limit } = filterLogsForApiRequest(req)

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
    const { ordered } = filterLogsCore(query)

    // When an explicit list of IDs is provided, restrict the export to those
    // entries only. This allows the UI to mark individual logs for export
    // while preserving the legacy behaviour (export all filtered logs) when
    // no IDs are specified.
    const idsParam = safeString(query.ids)
    let effective = ordered
    if (idsParam) {
      const ids = idsParam
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
      if (ids.length > 0) {
        const idSet = new Set(ids.map(id => String(id)))
        effective = ordered.filter(log => log && idSet.has(String(log.id)))
      }
    }

    const items = effective.map(log => ({
      ...log,
      fileType: log && log.fileType ? log.fileType : getFileTypeFromLogEntry(log)
    }))

    res.json({ items, total: items.length })
  } catch (error) {
    res.status(500).json({ error: 'Failed to export logs' })
  }
})

app.get('/api/logs/:id', (req, res) => {
  try {
    const { id } = req.params
    const log = requestLogs.find(entry => entry && String(entry.id) === String(id))

    if (!log) {
      return res.status(404).json({ error: 'Log not found' })
    }

    const view = buildClientLogView(log)
    if (!view) {
      return res.status(500).json({ error: 'Failed to build log view' })
    }

    res.json(view)
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch log details' })
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

// Toggle endpoints for boolean config flags
;[
  { path: '/api/interactive-mode', field: 'interactiveModeEnabled', set: v => { interactiveModeEnabled = v } },
  { path: '/api/edit-rules-mode', field: 'editRulesEnabled', set: v => { editRulesEnabled = v } },
  { path: '/api/local-resources-mode', field: 'localResourcesEnabled', set: v => { localResourcesEnabled = v } },
  { path: '/api/filter-rules-mode', field: 'filterRulesEnabled', set: v => { filterRulesEnabled = v } },
  { path: '/api/blocked-rules-mode', field: 'blockedRulesEnabled', set: v => { blockedRulesEnabled = v } }
].forEach(({ path, field, set }) => {
  app.post(path, (req, res) => handleBooleanToggleEndpoint({
    req, res, assignValue: set, responseFieldName: field, defaultEnabled: true
  }))
})

// Get filter mode
app.get('/api/filter-mode', (req, res) => {
  res.json({ filterMode: getBypassMode() })
})

// Set filter mode ("ignore" or "focus")
app.post('/api/filter-mode', (req, res) => {
  const { mode } = req.body || {}
  const normalized = safeString(mode).toLowerCase()

  if (normalized !== 'ignore' && normalized !== 'focus') {
    return res.status(400).json({ error: 'Invalid filter mode. Expected "ignore" or "focus".' })
  }

  bypassMode = normalized
  persistConfig()
  rebuildBypassUrlsForCurrentMode()

  res.json({ success: true, filterMode: getBypassMode() })
})

// Open a native file picker (Windows) for local path selection.
app.post('/api/system/file-picker', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const title = body.title == null ? undefined : String(body.title)
  const filter = body.filter == null ? undefined : String(body.filter)

  try {
    const filePath = await showNativeFilePicker({ title, filter })
    res.json({ path: filePath || null, canceled: !filePath })
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Failed to open the file picker.' })
  }
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
    } else if (req.body && Object.hasOwn(req.body, 'content') && req.body.content) {
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

app.get('/api/edit-rule-presets', (req, res) => {
  res.json({ presets: editRulePresets })
})

app.post('/api/edit-rule-presets', async (req, res) => {
  const raw = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null

  if (!raw) {
    return res.status(400).json({ error: 'Invalid payload: expected JSON object.' })
  }

  const preset = normalizeEditRulePreset(raw)
  editRulePresets.push(preset)
  await saveEditRulePresets()

  res.status(201).json({ preset })
})

app.delete('/api/edit-rule-presets/:id', async (req, res) => {
  const { id } = req.params
  const before = editRulePresets.length
  editRulePresets = editRulePresets.filter(preset => preset && preset.id !== id)

  if (editRulePresets.length === before) {
    return res.status(404).json({ error: 'Preset not found' })
  }

  await saveEditRulePresets()
  res.status(204).end()
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
  editRuleUsageCounters.clear()
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
    if (!isValidId(id)) {
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
    if (!isValidId(id)) {
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
    if (!isValidId(id)) {
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
    if (!isValidId(id)) {
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

/**
 * Return a lightweight usage report for live edit rules.
 *
 * The payload is intentionally compact: a flat id->count map that the
 * frontend can join with /api/edit-rules metadata without duplicating
 * rule configuration on the wire.
 */
app.get('/api/edit-rules/usage', (req, res) => {
  const usage = Object.create(null)

  for (const [id, count] of editRuleUsageCounters.entries()) {
    usage[id] = count
  }

  res.json({
    usage,
    totalRulesWithUsage: editRuleUsageCounters.size
  })
})

app.post('/api/edit-rules/value-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' })
    }

    let valueType = 'string'
    try {
      const filePath = path.join(STORAGE_DIR, req.file.filename)
      const text = await fsPromises.readFile(filePath, 'utf8')
      valueType = coerceJsonPathScalarFromText(text).valueType
    } catch {
      valueType = 'string'
    }

    res.json({
      filename: req.file.filename,
      originalName: req.file.originalname,
      valueType
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
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

  editRuleUsageCounters.delete(id)
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

/**
 * Build a lightweight audit snapshot from the current in-memory log window.
 *
 * The snapshot focuses on upstream error distribution and per-host latency
 * aggregates, optimised for use by the secret Proxy Audit Panel.
 */
app.get('/api/audit', (req, res) => {
  try {
    const errorBuckets = Object.create(null)
    const hostMap = new Map()

    for (const log of requestLogs) {
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
    ? createHttpFlowLogEntry({
        requestStart,
        method: req.method,
        url: requestUrl,
        fullUrl,
        headers: req.headers,
        source: 'unknown',
        clientIp
      })
    : null

  if (req.rawBody) {
    const { buffer: rewrittenBuffer } = processRequestBodyWithRewrites({
      buffer: req.rawBody,
      headers: req.headers,
      requestUrl,
      fullUrl,
      logEntry,
      allowBodyRewriteFallback: false,
      logNonJsonBody: false
    })
    req.rawBody = rewrittenBuffer
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
        headersToForward = applyHeaderRewrites(headersToForward, { requestUrl, fullUrl, phase: 'request' }, logEntry)

        let body
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
            // req.rawBody has already been rewritten by applyConnectFrameRewrites above
            // Just use it directly for forwarding
            body = req.rawBody

            headersToForward['content-length'] = body.length
          } else if (req.body !== undefined) {
            const isJson = getContentType(headersToForward).includes('application/json')
            const rawBodyString = isJson && typeof req.body !== 'string' ? JSON.stringify(req.body) : req.body
            const textBody = safeString(rawBodyString)
            const rewriteResult = applyEditRulesToText(textBody, {
              requestUrl,
              fullUrl,
              phase: 'request'
            })
            body = rewriteResult.changed ? rewriteResult.text : rawBodyString
            if (rewriteResult.changed) {
              attachRewriteMetadata(logEntry, rewriteResult.appliedRuleIds, 'request')
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
        upstreamHeaders = applyHeaderRewrites(upstreamHeaders, { requestUrl, fullUrl, phase: 'response' }, logEntry)

        const contentType = getContentType(upstreamHeaders)

        const isBinary = isClearlyBinaryContentType(contentType)

        const hasAnyEditRules = hasAnyEditOrJsonPathRules()

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

        const {
          finalResponseBuffer,
          upstreamHeaders: rewrittenHeaders
        } = handleBufferedUpstreamResponseWithRewrites({
          responseBuffer,
          upstreamHeaders,
          requestUrl,
          jsonPathFullUrl: resolvedTargetUrl,
          logEntry,
          source: 'proxied',
          targetUrlForLog: resolvedTargetUrl,
          overrideFullUrlOnLog: true,
          allowUnaryConnectText: false,
          statusCode: upstreamResponse.statusCode,
          enableConnectFrameTextRewrites: false
        })

        res.status(upstreamResponse.statusCode)

        const forwardedResponseHeaders = sanitizeAndStripIdentifyingHeaders(
          rewrittenHeaders,
          OMIT_RESPONSE_HEADERS
        )
        Object.entries(forwardedResponseHeaders).forEach(([key, value]) => {
          res.setHeader(key, value)
        })

        applyCacheBypassHeadersToResponse(res, 'remote')

        if (req.method === 'HEAD') {
          res.end()
        } else {
          res.send(finalResponseBuffer)
        }
      } catch (error) {
        handleUpstreamError({ logEntry, error, res, useJson: true })
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
    logWebSocketDirectTunnel({ targetUrl, headers: req.headers })

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

/**
 * Unified WebSocket frame handler for both directions.
 * Handles bypass mode, light logging mode, and full rewrite mode.
 *
 * @param {Object} params
 * @param {Buffer} params.data - Raw frame data (server->client) or decoded payload (client->server).
 * @param {boolean} params.isBinary
 * @param {string} params.direction - 'server->client' or 'client->server'
 * @param {string} params.wsUrl
 * @param {number} params.connectionId
 * @param {Object} params.wsMetrics - Mutable metrics object.
 * @param {function} params.sendToTarget - Function to send data to target.
 * @param {boolean} params.bypass
 * @returns {void}
 */
function handleWebSocketFrame ({ data, isBinary, direction, wsUrl, connectionId, wsMetrics, sendToTarget, bypass }) {
  const isServerToClient = direction === 'server->client'
  const phase = isServerToClient ? 'response' : 'request'

  // Bypass mode: forward as-is without any processing
  if (bypass) {
    const payloadBuffer = normalizeWebSocketPayload(data)
    sendToTarget(payloadBuffer, isBinary)
    return
  }

  // Light mode: forward as-is but log basic metadata
  if (!WS_LOG_BODY_ENABLED) {
    const payloadBuffer = normalizeWebSocketPayload(data)
    const size = payloadBuffer.length

    if (isServerToClient) {
      wsMetrics.messagesServerToClient += 1
      wsMetrics.bytesServerToClient += size
    } else {
      wsMetrics.messagesClientToServer += 1
      wsMetrics.bytesClientToServer += size
    }

    sendToTarget(payloadBuffer, isBinary)

    logWebSocketMessage({
      direction,
      wsUrl,
      connectionId,
      payloadBuffer,
      isBinary,
      loggingDisabled: true
    })
    return
  }

  // Full mode: apply rewrites and log full content
  const { buffer: payloadBuffer, rewrites, body, originalBody, jsonAfter } = applyWebSocketRewritesAndDescribe(
    data,
    isBinary,
    { requestUrl: wsUrl, fullUrl: wsUrl, phase }
  )

  sendToTarget(payloadBuffer, isBinary)

  const size = payloadBuffer.length
  if (isServerToClient) {
    wsMetrics.messagesServerToClient += 1
    wsMetrics.bytesServerToClient += size
  } else {
    wsMetrics.messagesClientToServer += 1
    wsMetrics.bytesClientToServer += size
  }

  if (Array.isArray(rewrites) && rewrites.length) {
    wsMetrics.rewrittenMessages += 1
  }

  logWebSocketMessage({
    direction,
    wsUrl,
    connectionId,
    payloadBuffer,
    isBinary,
    bodyText: body,
    rewrites,
    originalBodyText: originalBody,
    bodyJson: jsonAfter
  })
}

// WebSocket upgrade handler
function handleWebSocketUpgrade (clientReq, clientSocket, targetHost, targetPort, fullUrl, { bypass = false } = {}) {
  const rawUrl = fullUrl || ''
  const wsUrl = httpUrlToWebSocketUrl(rawUrl) || rawUrl
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
      if (!bypass) {
        const connectionLog = createWebSocketConnectionLog({
          wsUrl,
          source: 'websocket',
          headers: clientReq.headers,
          connectionId,
          message: 'WebSocket connection established'
        })
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

        handleWebSocketFrame({
          data,
          isBinary,
          direction: 'server->client',
          wsUrl,
          connectionId,
          wsMetrics,
          sendToTarget: (payload, binary) => {
            const frame = createWebSocketFrame(payload, binary)
            clientSocket.write(frame)
          },
          bypass
        })
      })

      clientSocket.on('data', (data) => {
        try {
          const decoded = decodeWebSocketFrame(data)
          if (!decoded || targetWs.readyState !== WebSocket.OPEN) return

          handleWebSocketFrame({
            data: decoded.payload,
            isBinary: decoded.isBinary,
            direction: 'client->server',
            wsUrl,
            connectionId,
            wsMetrics,
            sendToTarget: (payload, binary) => {
              if (binary) {
                targetWs.send(payload, { binary: true })
              } else {
                targetWs.send(payload.toString('utf8'), { binary: false })
              }
            },
            bypass
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
      logWebSocketSummary('target-closed')
      clientSocket.end()
    })

    clientSocket.on('error', () => {
      logWebSocketSummary('client-error')
      targetWs.close()
    })

    clientSocket.on('close', () => {
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

/**
 * Convert an HTTP(S) URL string to its WebSocket equivalent. Existing ws:/wss:
 * URLs are returned unchanged.
 *
 * @param {string} url
 * @returns {string}
 */
function httpUrlToWebSocketUrl (url = '') {
  if (!url) return ''
  if (url.startsWith('ws://') || url.startsWith('wss://')) return url
  return url.replace('https://', 'wss://').replace('http://', 'ws://')
}

/**
 * Build a standardised WebSocket connection log entry.
 * Delegates to createLogEntry with wsOptions.
 */
function createWebSocketConnectionLog ({ wsUrl, source, headers, connectionId, message }) {
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
 * Log a WebSocket direct tunnel establishment when interactive mode is enabled.
 * Centralises the common pattern used by both HTTP upgrade and HTTPS MITM flows.
 *
 * @param {object} params
 * @param {string} params.targetUrl - Raw target URL (HTTP or WS).
 * @param {object} params.headers - Request headers to sanitize and log.
 * @param {string} [params.suffix=''] - Optional suffix for the log message.
 */
function logWebSocketDirectTunnel ({ targetUrl, headers, suffix = '' }) {
  if (!interactiveModeEnabled) return

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
      const logEntry = createHttpFlowLogEntry({
        requestStart,
        method: req.method,
        url: '/',
        fullUrl,
        headers: req.headers,
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
        logWebSocketDirectTunnel({ targetUrl: fullUrl, headers: clientReq.headers, suffix: ' (MITM bypass)' })

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
        await handleDirectHttpFlow({
          req: clientReq,
          res: clientRes,
          targetUrl: fullUrl,
          requestUrl,
          fullUrl,
          targetHost,
          requestStart,
          clientIp,
          omitHeaders: OMIT_HEADERS_MITM,
          body: body.length > 0 ? body : undefined,
          applyRewrites: MITM_BYPASS_REWRITES_ENABLED,
          bufferResponse: MITM_BYPASS_REWRITES_ENABLED,
          handleHead: false
        })

        return
      }

      const hasLogging = interactiveModeEnabled === true

      // Log to UI (only build a detailed log entry when interactive mode is enabled)
      const logEntry = hasLogging
        ? createHttpFlowLogEntry({
            requestStart,
            method,
            url: requestUrl,
            fullUrl,
            headers: clientReq.headers,
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

        clientRes.writeHead(204)
        return clientRes.end()
      }

      if (body.length > 0) {
        const { buffer: rewrittenBody } = processRequestBodyWithRewrites({
          buffer: body,
          headers: clientReq.headers,
          requestUrl,
          fullUrl,
          logEntry,
          allowBodyRewriteFallback: true,
          logNonJsonBody: true
        })
        body = rewrittenBody
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
          headersToForward = applyHeaderRewrites(headersToForward, { requestUrl, fullUrl, phase: 'request' }, logEntry)

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

          // Parse and optionally rewrite response body before forwarding/logging.
          let upstreamHeaders = upstreamResponse.headers
          upstreamHeaders = applyHeaderRewrites(upstreamHeaders, { requestUrl, fullUrl, phase: 'response' }, logEntry)

          const {
            finalResponseBuffer,
            upstreamHeaders: rewrittenHeaders
          } = handleBufferedUpstreamResponseWithRewrites({
            responseBuffer: responseBufferRaw,
            upstreamHeaders,
            requestUrl,
            jsonPathFullUrl: fullUrl,
            logEntry,
            source: 'mitm',
            targetUrlForLog: fullUrl,
            overrideFullUrlOnLog: false,
            allowUnaryConnectText: true,
            statusCode: upstreamResponse.statusCode,
            enableConnectFrameTextRewrites: true,
            frameRewriteFullUrl: fullUrl
          })

          // Forward response with cache-busting headers, dropping identifying
          // tracing headers for actively MITM-processed responses.
          const responseHeaders = sanitizeAndStripIdentifyingHeaders(
            rewrittenHeaders,
            OMIT_RESPONSE_HEADERS
          )
          applyCacheBypassHeadersToObject(responseHeaders)

          clientRes.writeHead(upstreamResponse.statusCode, responseHeaders)
          clientRes.end(finalResponseBuffer)
        } catch (error) {
          handleUpstreamError({ logEntry, error, res: clientRes })
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
