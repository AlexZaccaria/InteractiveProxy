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
const { URL } = require('url')
const WebSocket = require('ws')
const { request, Agent } = require('undici')
const {
  PORT,
  HOST,
  UI_ORIGINS,
  STORAGE_DIR,
  LOGS_DIR,
  CERTS_DIR,
  MAX_LOG_ENTRIES,
  LOG_PREVIEW_MAX_BYTES,
  MITM_BYPASS_REWRITES_ENABLED,
  STRICT_TLS_ENABLED,
  STRICT_TLS_CA_FILE,
  BODY_LIMIT,
  WS_MAX_TEXT_BYTES,
  UPSTREAM_HEADERS_TIMEOUT_MS,
  UPSTREAM_BODY_TIMEOUT_MS,
  STREAM_UNINSPECTED_RESPONSES,
  WS_LOG_BODY_ENABLED
} = require('./config')

const {
  generateWebSocketAccept,
  httpUrlToWebSocketUrl,
  createWebSocketFrame,
  decodeWebSocketFrame
} = require('./src/proxy/websocket-codec')

const { logDebug, logWarn } = require('./src/util/logger')

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

const { getCA, generateCertForHost } = require('./src/tls/ca')

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

const {
  normalizeEditRule,
  normalizeEditRulePreset,
  deserializeEditRuleFromDisk,
  serializeEditRuleForDisk,
  splitLongStringIntoSegments,
  parseJsonPath,
  compileEditRule,
  replaceTextLiteral,
  coerceJsonPathScalarFromText
} = require('./src/rules/schema')
const { createRuleStore } = require('./src/rules/store')
const { createTextRewriter } = require('./src/rules/text-rules')
const { createJsonPathRewriter } = require('./src/rules/jsonpath')
const {
  attachRewriteMetadata: attachRewriteMetadataToStore,
  hasAppliedRules
} = require('./src/rules/metadata')

// Live edit rules: rules, presets, compiled caches, the enabled flag and the
// usage counters live in the store; the rewriters close over it.
const ruleStore = createRuleStore({
  rulesFile: EDIT_RULES_FILE,
  presetsFile: EDIT_RULE_PRESETS_FILE,
  storageDir: STORAGE_DIR
})
const textRules = createTextRewriter(ruleStore)
const jsonPathRules = createJsonPathRewriter(ruleStore)

const loadEditRules = () => ruleStore.load()
const loadEditRulePresets = () => ruleStore.loadPresets()
const rebuildEditRuleCache = () => ruleStore.rebuildCache()
const {
  getCompiledRules,
  getCompiledRulesForContext,
  getCompiledJsonPathRules,
  hasCompiledTextRules,
  hasCompiledJsonPathRules,
  hasAnyEditOrJsonPathRules
} = ruleStore
const {
  applyCompiledRuleToText,
  applyEditRulesToText,
  applyEditRulesToHeaders,
  applyEditRulesToBuffer
} = textRules
const { applyJsonPathRulesToObject, applyJsonPathRulesToProtobufBuffer } = jsonPathRules
const attachRewriteMetadata = (logEntry, appliedRuleIds, phase) =>
  attachRewriteMetadataToStore(logEntry, appliedRuleIds, phase, ruleStore)

const { safeTrim, queryBool, safeString, parseListQuery, isValidId } = require('./src/util/strings')

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
  // Activate the rules in memory before the (asynchronous) write so that a
  // request arriving right after the API call already sees them.
  blockedUrls = blockedRules.filter(rule => rule.enabled).map(rule => rule.url)
  // Keep the log filtering patterns in sync with the latest blocked rules.
  recomputeBlockedUrlSubstringsForFilter()

  try {
    const payload = JSON.stringify(blockedRules, null, 2)
    await fsPromises.writeFile(BLOCKED_URLS_FILE, payload)
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

const {
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
} = require('./src/rules/url-match')

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

const {
  CONNECT_MAX_FRAMES_LIMIT,
  CONNECT_MAX_FRAME_BYTES_LIMIT,
  getConnectEncodingHeader,
  looksLikeConnectEnvelope,
  rebuildConnectEnvelope,
  decodeConnectPayload,
  countConnectFrames,
  buildConnectSearchContentForLog,
  buildConnectViewForClient
} = require('./src/codecs/connect')


const {
  readVarint,
  parseMessageDetailed,
  parseProtobuf,
  encodeVarint32,
  encodeProtobufKey,
  encodeLengthDelimitedField,
  printableRatio,
  rewriteMessage,
  rewriteProtobufFields,
  encodeProtobufFromFields,
  encodeJsonToProtobuf,
  extractJsonFromProtobufBuffer,
  stripTrivialBinaryBlobs
} = require('./src/codecs/protobuf')


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

const {
  getHeaderCaseInsensitive,
  getContentType,
  getContentEncoding,
  shouldDecompress,
  isProtoContentType,
  isTextualContentType,
  isClearlyBinaryContentType,
  getCompressionCodec,
  decompressData,
  decompressDataForLogging,
  isEmptyBuffer
} = require('./src/codecs/compression')

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
          if (jsonPathResult && jsonPathResult.json != null) {
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

const {
  bufferToTextPreview,
  tryParseJsonString,
  normalizeNestedJsonStrings,
  stripSocketIoPrefix,
  tryParseWebSocketJson,
  normalizeWebSocketPayload,
  buildSearchSnapshot,
  buildJsonSearchSnapshot
} = require('./src/logs/preview')

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

  // Rules operate on the body exactly as parsed: a string field that happens
  // to contain JSON stays a string in what goes upstream. The nested-JSON
  // normalisation is applied only to the views returned for logging, which
  // are deep clones so the forwarded object is never touched. The clones are
  // gated by captureBeforeJson so non-logging callers skip them.
  const toDisplayJson = (value) => {
    try {
      return normalizeNestedJsonStrings(JSON.parse(JSON.stringify(value)))
    } catch {
      return value
    }
  }

  const beforeJson = captureBeforeJson ? toDisplayJson(parsed) : null

  const jsonPathResult = applyJsonPathRulesToObject(parsed, jsonPathContext)
  const resultObject = jsonPathResult ? jsonPathResult.object : parsed
  const json = captureBeforeJson ? toDisplayJson(resultObject) : resultObject

  if (!jsonPathResult || !jsonPathResult.changed) {
    return {
      buffer,
      json,
      beforeJson,
      appliedRuleIds: jsonPathResult ? (jsonPathResult.appliedRuleIds || []) : [],
      changed: false,
      decompressed
    }
  }

  const updatedDecoded = Buffer.from(JSON.stringify(resultObject), 'utf8')

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
    json,
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
        // Same URL/phase context as the Connect and JSONPath paths, so that
        // URL-scoped and request/response-scoped text rules apply here too.
        const bodyRewriteResult = applyEditRulesToBuffer(workingBuffer, jsonPathContext)
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
      {
        role: 'request',
        allowBodyRewriteFallback,
        updateContentEncoding: true,
        urlContext: { requestUrl, fullUrl }
      }
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
    {
      role: 'response',
      allowBodyRewriteFallback: true,
      updateContentEncoding: true,
      urlContext: { requestUrl, fullUrl: jsonPathFullUrl }
    }
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
      ruleStore.setEnabled(config.editRulesEnabled)
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
        editRulesEnabled: ruleStore.isEnabled(),
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
        ruleStore.releaseUsage(removed.rewrites.map(rewrite => rewrite && rewrite.id))
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
    return {
      ok: false,
      value: defaultEnabled,
      error: 'Missing "enabled" flag: expected a boolean.'
    }
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

// File types derived from the URL extension when the response carries no
// content-type (or a generic octet-stream).
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

  if (hostHeader && !PROXY_OWN_AUTHORITIES.has(hostHeader.toLowerCase())) {
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
 * Determine whether a request should be treated as an internal proxy/UI call
 * that must never be bypassed.
 *
 * @param {{host?: string|null, requestUrl?: string, fullUrl?: string|null, targetUrl?: string|null}} [input]
 * @returns {boolean}
 */
function isInternalProxyRequest (rawInput = {}) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {}
  const host = normalizeHostValue(input.host) || ''
  if (
    !host &&
    typeof input.requestUrl !== 'string' &&
    typeof input.fullUrl !== 'string' &&
    typeof input.targetUrl !== 'string'
  ) {
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

const {
  OMIT_HEADERS_BASE,
  OMIT_HEADERS_PROXY,
  OMIT_HEADERS_MITM,
  OMIT_RESPONSE_HEADERS,
  createForwardHeaders,
  stripIdentifyingHeaders,
  sanitizeHeaders,
  sanitizeAndStripIdentifyingHeaders,
  applyCacheBypassHeadersToResponse,
  applyCacheBypassHeadersToObject
} = require('./src/proxy/headers')

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
  // Proxy-style requests carry an absolute request line already.
  const clientFacingUrl = /^https?:\/\//i.test(requestUrl)
    ? requestUrl
    : `${protocol}://${authority}${requestUrl}`
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
app.use(cors({
  origin: (origin, callback) => {
    // Requests without an Origin header come from non-browser clients
    // (curl, scripts) and are allowed. Browser requests are allowed only
    // from the UI origins so other websites cannot read API responses.
    callback(null, !origin || UI_ORIGINS.includes(origin))
  }
}))

app.set('trust proxy', true)
app.use(bodyParser.raw({
  type: req => isProtoContentType(getContentType(req.headers)),
  limit: BODY_LIMIT,
  verify: captureRawBody,
  inflate: false
}))
app.use(bodyParser.json({ limit: BODY_LIMIT, verify: captureRawBody }))
app.use(bodyParser.urlencoded({ extended: true, limit: BODY_LIMIT, verify: captureRawBody }))
// Every other body (text/plain, XML, binary, multipart of proxied traffic) is
// captured raw so the proxy flow forwards it byte for byte. Multipart bodies
// addressed to the management API are left to multer.
app.use(bodyParser.raw({
  type: req => {
    const contentType = getContentType(req.headers).toLowerCase()
    if (contentType.startsWith('multipart/')) return isProxyTargetedRequest(req)
    return true
  },
  limit: BODY_LIMIT,
  verify: captureRawBody,
  inflate: false
}))

/**
 * `host:port` values under which the proxy itself is addressed. A request
 * whose Host header is not one of these is traffic for another server.
 *
 * @type {Set<string>}
 */
const PROXY_OWN_AUTHORITIES = new Set(
  ['localhost', '127.0.0.1', '[::1]', HOST]
    .concat(UI_ORIGINS.map(origin => {
      try {
        return new URL(origin).hostname
      } catch {
        return null
      }
    }))
    .filter(host => host && host !== '0.0.0.0' && host !== '::')
    .map(host => `${host.toLowerCase()}:${PORT}`)
)

/**
 * True when a request that reached the Express app is traffic to forward
 * (proxy-style absolute URL, X-Target-URL header or a Host header that is not
 * the proxy itself) rather than a call to the management API.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isProxyTargetedRequest (req) {
  if (safeString(req.headers['x-target-url'])) return true

  const rawUrl = safeString(req.originalUrl) || safeString(req.url)
  if (/^(https?|wss?):\/\//i.test(rawUrl)) return true

  const hostHeader = safeTrim(req.headers.host).toLowerCase()
  return Boolean(hostHeader) && !PROXY_OWN_AUTHORITIES.has(hostHeader)
}

// Express routes by path, so a proxied request such as
// http://example.com/api/users or http://example.com/index.html would
// otherwise be answered by the management API or the bundled UI. Hand traffic
// addressed to other hosts to the proxy flow before any route is considered.
app.use((req, res, next) => {
  if (isProxyTargetedRequest(req)) {
    return handleProxiedHttpRequest(req, res)
  }
  next()
})

app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next()
  }

  // CORS alone does not stop "simple" cross-site POSTs from reaching the
  // handlers, so mutations on the management API additionally reject
  // requests that a browser marks as coming from another site. Non-browser
  // clients send neither Origin nor Sec-Fetch-Site and keep working.
  const origin = safeString(req.headers.origin)
  const fetchSite = safeString(req.headers['sec-fetch-site']).toLowerCase()

  if ((origin && !UI_ORIGINS.includes(origin)) || fetchSite === 'cross-site') {
    return res.status(403).json({ error: 'Cross-site requests to the proxy API are not allowed' })
  }

  next()
})

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, STORAGE_DIR)
  },
  filename: (req, file, cb) => {
    // Keep only the base name and replace characters that are unsafe in file
    // names so an upload can never escape STORAGE_DIR.
    const baseName = path.basename(file.originalname || 'upload').replace(/[^\w.-]+/g, '_')
    cb(null, `${Date.now()}-${baseName}`)
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
    editRulesEnabled: ruleStore.isEnabled(),
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
  { path: '/api/edit-rules-mode', field: 'editRulesEnabled', set: v => { ruleStore.setEnabled(v) } },
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
  if (process.platform !== 'win32') {
    return res.status(501).json({ error: 'The native file picker is only available on Windows.' })
  }

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
  res.json({ presets: ruleStore.getPresets() })
})

app.post('/api/edit-rule-presets', async (req, res) => {
  const raw = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null

  if (!raw) {
    return res.status(400).json({ error: 'Invalid payload: expected JSON object.' })
  }

  const preset = ruleStore.addPreset(raw)
  await ruleStore.savePresets()

  res.status(201).json({ preset })
})

app.delete('/api/edit-rule-presets/:id', async (req, res) => {
  const { id } = req.params

  if (!ruleStore.removePreset(id)) {
    return res.status(404).json({ error: 'Preset not found' })
  }

  await ruleStore.savePresets()
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
  ruleStore.clearUsage()
  res.json({ success: true, message: 'Logs cleared' })
})

// Get all blocked rules
app.get('/api/blocked', (req, res) => {
  res.json(blockedRules)
})

// Add/update/remove blocked URL
app.post('/api/blocked', async (req, res) => {
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
    await saveBlockedUrls()
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
      await saveBlockedUrls()
    } else {
      return res.status(404).json({ error: 'Rule not found' })
    }
  } else if (action === 'remove') {
    if (!isValidId(id)) {
      return res.status(400).json({ error: 'ID is required for remove' })
    }
    blockedRules = blockedRules.filter(r => r.id !== id)
    await saveBlockedUrls()
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
  res.json({ rules: ruleStore.getRules() })
})

/**
 * Return a lightweight usage report for live edit rules.
 *
 * The payload is intentionally compact: a flat id->count map that the
 * frontend can join with /api/edit-rules metadata without duplicating
 * rule configuration on the wire.
 */
app.get('/api/edit-rules/usage', (req, res) => {
  res.json(ruleStore.getUsageSnapshot())
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

  const rule = ruleStore.addRule(raw)
  ruleStore.save()

  res.status(201).json({ rule })
})

app.put('/api/edit-rules/:id', (req, res) => {
  const { id } = req.params
  if (!ruleStore.findRule(id)) {
    return res.status(404).json({ error: 'Rule not found' })
  }

  const patch = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null

  if (!patch) {
    return res.status(400).json({ error: 'Invalid payload: expected JSON object.' })
  }

  const updated = ruleStore.updateRule(id, patch)
  ruleStore.save()

  res.json({ rule: updated })
})

app.delete('/api/edit-rules/:id', (req, res) => {
  const { id } = req.params

  if (!ruleStore.removeRule(id)) {
    return res.status(404).json({ error: 'Rule not found' })
  }

  ruleStore.save()

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

/**
 * Proxy flow for every request that is not a call to the management API:
 * local resources, forwarding to the resolved target and logging. Also used
 * by the `/api` guard for traffic addressed to other hosts.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleProxiedHttpRequest (req, res) {
  const requestUrl = req.originalUrl
  // Proxy-style requests carry an absolute request line already.
  const fullUrl = /^https?:\/\//i.test(requestUrl)
    ? requestUrl
    : req.protocol + '://' + req.get('host') + requestUrl
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

        if (logEntry) {
          logEntry.upstreamDurationMs = Date.now() - upstreamStart
        }

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
}

// Bundled UI: when the client has been built (`npm run build`), serve it from
// the proxy's own origin so a single process is enough. Only requests
// addressed to the proxy itself get here (see isProxyTargetedRequest), and
// paths that are not files of the build fall through to the proxy flow.
const CLIENT_BUILD_DIR = path.join(__dirname, '..', 'client', 'build')
if (fs.existsSync(path.join(CLIENT_BUILD_DIR, 'index.html'))) {
  app.use(express.static(CLIENT_BUILD_DIR, { index: 'index.html' }))
}

// Proxy middleware - handles all other requests
app.use('*', handleProxiedHttpRequest)

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
  const targetPort = targetUrl.port ? Number(targetUrl.port) : 443
  // Authority used in every URL built for this tunnel: the port is kept when
  // it is not the HTTPS default, otherwise upstream requests would go to 443.
  const targetAuthority = targetPort === 443 ? targetHost : `${targetHost}:${targetPort}`

  const routingContext = buildRoutingContext({
    requestUrl: '/',
    fullUrl: `https://${targetAuthority}`,
    host: targetHost,
    path: '/',
    targetUrl: `https://${targetAuthority}`,
    method: req.method
  })

  const httpHandling = decideHttpHandling(routingContext)

  if (httpHandling === 'direct') {
    incrementBypassedCount()

    if (interactiveModeEnabled) {
      const requestStart = Date.now()
      const fullUrl = `https://${targetAuthority}`
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
  const cert = generateCertForHost(targetHost, getCA())

  // Create HTTPS server for this connection
  const httpsServerOptions = {
    key: cert.key,
    cert: cert.cert,
    maxHeaderSize: 16384, // 16KB header limit (default is 8KB)
    SNICallback: (servername, cb) => {
      const sniCert = generateCertForHost(servername, getCA())
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
    const fullUrl = `https://${targetAuthority}${requestUrl}`
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
          targetHost: targetAuthority,
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
            host: targetAuthority
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

          if (logEntry) {
            logEntry.upstreamDurationMs = Date.now() - upstreamStart
          }

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

/**
 * Start listening. `node server/index.js` starts immediately; tests and
 * embedders require this module and call start() themselves.
 *
 * @param {{ port?: number, host?: string }} [options]
 * @returns {Promise<import('net').AddressInfo>}
 */
function start ({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve(server.address())
    })
  })
}

/**
 * Stop listening and drop open connections (upstream keep-alive sockets of
 * the undici dispatchers are closed too, so a test process can exit).
 *
 * @returns {Promise<void>}
 */
async function stop () {
  await new Promise(resolve => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections()
    }
    server.close(() => resolve())
  })
  await Promise.allSettled([httpDispatcher.close(), httpsDispatcher.close()])
}

if (require.main === module) {
  start()
    .then(address => {
      console.log(`[proxy] listening on http://${address.address}:${address.port}`)
    })
    .catch(error => {
      console.error(`[proxy] failed to start on ${HOST}:${PORT}:`, error.message)
      process.exit(1)
    })
}

module.exports = {
  app,
  server,
  start,
  stop,
  config: { PORT, HOST, UI_ORIGINS, STORAGE_DIR, CERTS_DIR },
  files: {
    BLOCKED_URLS_FILE,
    FILTER_URLS_FILE,
    EDIT_RULES_FILE,
    EDIT_RULE_PRESETS_FILE
  },
  // Internal functions exposed for characterization tests. Not a public API:
  // names and signatures follow the implementation and change with it.
  internals: {
    // protobuf
    readVarint,
    encodeVarint32,
    encodeProtobufKey,
    encodeLengthDelimitedField,
    parseMessageDetailed,
    parseProtobuf,
    encodeProtobufFromFields,
    encodeJsonToProtobuf,
    rewriteMessage,
    rewriteProtobufFields,
    extractJsonFromProtobufBuffer,
    stripTrivialBinaryBlobs,
    printableRatio,
    // connect
    looksLikeConnectEnvelope,
    rebuildConnectEnvelope,
    decodeConnectPayload,
    applyConnectFrameRewrites,
    applyConnectRewritesForBypass,
    getConnectEncodingHeader,
    // edit rules
    parseJsonPath,
    applyJsonPathRulesToObject,
    applyJsonPathRulesToProtobufBuffer,
    normalizeEditRule,
    normalizeEditRulePreset,
    serializeEditRuleForDisk,
    deserializeEditRuleFromDisk,
    splitLongStringIntoSegments,
    compileEditRule,
    rebuildEditRuleCache,
    getCompiledRules,
    getCompiledRulesForContext,
    getCompiledJsonPathRules,
    hasAnyEditOrJsonPathRules,
    replaceTextLiteral,
    applyCompiledRuleToText,
    applyEditRulesToText,
    applyEditRulesToHeaders,
    applyEditRulesToBuffer,
    rewriteJsonHttpBody,
    coerceJsonPathScalarFromText,
    loadEditRules,
    loadEditRulePresets,
    // url matching
    getCachedUrlParse,
    buildUrlMatchCandidatesFromContext,
    buildUrlMatchContext,
    urlPatternMatchesCandidates,
    urlPatternMatchesContext,
    textRuleMatchesUrl,
    jsonPathRuleMatchesUrl,
    deriveDisplayNameFromUrlPattern,
    hostPatternMatches,
    // websocket
    createWebSocketFrame,
    decodeWebSocketFrame,
    generateWebSocketAccept,
    httpUrlToWebSocketUrl,
    normalizeWebSocketPayload,
    stripSocketIoPrefix,
    tryParseWebSocketJson,
    normalizeNestedJsonStrings,
    rewriteWebSocketPayload,
    // compression and content types
    getCompressionCodec,
    decompressData,
    shouldDecompress,
    isTextualContentType,
    isClearlyBinaryContentType,
    isProtoContentType,
    getContentType,
    getContentEncoding,
    getHeaderCaseInsensitive,
    // routing and headers
    resolveTargetFromRequest,
    buildRoutingContext,
    createBypassContext,
    decideHttpHandling,
    decideWebSocketHandling,
    isInternalProxyRequest,
    shouldUseDirectConnection,
    shouldBypassRequest,
    isRequestBlocked,
    isProxyTargetedRequest,
    createForwardHeaders,
    sanitizeHeaders,
    stripIdentifyingHeaders,
    sanitizeAndStripIdentifyingHeaders,
    loadBlockedUrls,
    loadBypassUrls,
    getBypassMode,
    // logs and search
    createLogEntry,
    addLog,
    filterLogsCore,
    buildSearchSnapshot,
    buildJsonSearchSnapshot,
    ensureLogSearchSnapshots,
    tryParseJsonString,
    bufferToTextPreview,
    getFileTypeFromLogEntry,
    buildClientLogView,
    computeLogEntryMetrics,
    computeBypassSuggestions,
    // misc helpers
    safeTrim,
    safeString,
    queryBool,
    parseListQuery
  }
}
