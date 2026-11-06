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
const { URL } = require('url')
const WebSocket = require('ws')
const {
  PORT,
  HOST,
  UI_ORIGINS,
  STORAGE_DIR,
  LOGS_DIR,
  CERTS_DIR,
  MAX_LOG_ENTRIES,
  MITM_BYPASS_REWRITES_ENABLED,
  STRICT_TLS_ENABLED,
  STRICT_TLS_CA_FILE,
  BODY_LIMIT,
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

const { showNativeFilePicker } = require('./src/system/file-picker')
const { loadCaBundle, createUpstream, handleUpstreamError: handleUpstreamErrorWithRecorder } = require('./src/proxy/upstream')
const { createConfigStore } = require('./src/state/config-store')
const { createRouter } = require('./src/proxy/router')
const { createResourceStore } = require('./src/resources/store')
const { handleBooleanToggleEndpoint } = require('./src/api/toggles')

// Upstream access: undici dispatchers, TLS strictness and the shared request
// helper used by the HTTP bypass path, the main proxy flow and the MITM flow.
const upstream = createUpstream({
  strictTls: STRICT_TLS_ENABLED,
  caBundle: loadCaBundle(STRICT_TLS_CA_FILE),
  headersTimeoutMs: UPSTREAM_HEADERS_TIMEOUT_MS,
  bodyTimeoutMs: UPSTREAM_BODY_TIMEOUT_MS
})
const { performUpstreamRequest, attachAbortOnClose } = upstream
const upstreamCaBundle = upstream.caBundle

const app = express()

// Directories
const BLOCKED_URLS_FILE = path.join(STORAGE_DIR, 'blocked-urls.json')
const FILTER_URLS_FILE = path.join(STORAGE_DIR, 'filter-urls.json')
const LEGACY_BYPASS_URLS_FILE = path.join(STORAGE_DIR, 'bypass-urls.json')
const EDIT_RULES_FILE = path.join(STORAGE_DIR, 'edit-rules.json')
const EDIT_RULE_PRESETS_FILE = path.join(STORAGE_DIR, 'edit-rule-presets.json')
const RESOURCES_FILE = path.join(STORAGE_DIR, 'resources.json')
const CONFIG_FILE = path.join(STORAGE_DIR, 'config.json')

const { getCA, generateCertForHost } = require('./src/tls/ca')

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
const { attachRewriteMetadata: attachRewriteMetadataToStore } = require('./src/rules/metadata')

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

// Persisted global flags, routing rules (blocked / filter) and local
// resources. The router feeds the log store's blocked patterns through a
// callback that resolves at call time (the log store is created below).
const configStore = createConfigStore({ file: CONFIG_FILE, ruleStore })
configStore.load()
const router = createRouter({
  configStore,
  files: {
    blockedFile: BLOCKED_URLS_FILE,
    filterFile: FILTER_URLS_FILE,
    legacyBypassFile: LEGACY_BYPASS_URLS_FILE
  },
  port: PORT,
  host: HOST,
  uiOrigins: UI_ORIGINS,
  onBlockedPatternsChanged: () => logStore.recomputeBlockedVisibility()
})
const resourceStore = createResourceStore({ file: RESOURCES_FILE, storageDir: STORAGE_DIR, configStore })
const {
  resolveTargetFromRequest,
  buildRoutingContext,
  createBypassContext,
  isInternalProxyRequest,
  shouldUseDirectConnection,
  shouldBypassRequest,
  isRequestBlocked,
  decideHttpHandling,
  decideWebSocketHandling,
  buildBypassInputFromHttpRequest,
  isProxyTargetedRequest,
  getBypassMode,
  loadBlockedUrls,
  loadBypassUrls,
  normalizeBlockedRule,
  normalizeBypassRule
} = router
const handleUpstreamError = params => handleUpstreamErrorWithRecorder(params, recordUpstreamErrorOnLog)

const { safeTrim, queryBool, safeString, parseListQuery, isValidId } = require('./src/util/strings')

const {
  getCachedUrlParse,
  buildUrlMatchCandidatesFromContext,
  buildUrlMatchContext,
  urlPatternMatchesCandidates,
  urlPatternMatchesContext,
  jsonPathRuleMatchesUrl,
  textRuleMatchesUrl,
  deriveDisplayNameFromUrlPattern,
  hostPatternMatches
} = require('./src/rules/url-match')

const {
  getConnectEncodingHeader,
  looksLikeConnectEnvelope,
  rebuildConnectEnvelope,
  decodeConnectPayload
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

const { createHttpJsonRewriter } = require('./src/rewrite/http-json')
const { createConnectRewriter } = require('./src/rewrite/connect')
const { createBodyRewriter } = require('./src/rewrite/body')
const { createWebSocketRewriter } = require('./src/rewrite/websocket')

// Rewrite orchestration bound to the rule store. Interactive mode and the
// log store still live in this file, so they are reached through a getter
// and a callback (both resolve at call time).
const isInteractive = () => configStore.interactiveModeEnabled
const httpJsonRewriter = createHttpJsonRewriter({ ruleStore, textRules, jsonPathRules, isInteractive })
const connectRewriter = createConnectRewriter({ ruleStore, textRules, jsonPathRules, isInteractive })
const bodyRewriter = createBodyRewriter({
  ruleStore,
  textRules,
  httpJson: httpJsonRewriter,
  connect: connectRewriter,
  isInteractive,
  addLog: entry => addLog(entry)
})
const webSocketRewriter = createWebSocketRewriter({ ruleStore, textRules, jsonPathRules })

const { applyHeaderRewrites, rewriteJsonHttpBody } = httpJsonRewriter
const { applyConnectFrameRewrites, applyConnectRewritesForBypass } = connectRewriter
const { processRequestBodyWithRewrites, handleBufferedUpstreamResponseWithRewrites } = bodyRewriter
const { rewriteWebSocketPayload, applyWebSocketRewritesAndDescribe } = webSocketRewriter

const {
  getHeaderCaseInsensitive,
  getContentType,
  getContentEncoding,
  shouldDecompress,
  isProtoContentType,
  isTextualContentType,
  isClearlyBinaryContentType,
  getCompressionCodec,
  decompressData
} = require('./src/codecs/compression')

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

const { createLogStore } = require('./src/logs/store')
const {
  getFileTypeFromLogEntry,
  ensureLogSearchSnapshots,
  filterLogsCore: filterLogsCoreForStore
} = require('./src/logs/search')
const { buildClientLogView, filterLogsForApiRequest: filterLogsForApiRequestForStore } = require('./src/logs/views')
const { createStats, computeLogEntryMetrics } = require('./src/logs/stats')
const { createSuggestionTracker } = require('./src/logs/suggestions')
const { createLogEntryFactory } = require('./src/logs/entries')

// In-memory log window (ring buffer of MAX_LOG_ENTRIES entries) and the
// trackers that follow it: dashboard/route statistics and filter-rule
// suggestions. The getters read the routing state declared above lazily.
const stats = createStats()
const suggestions = createSuggestionTracker({ getBypassMatchers: () => router.getBypassMatchers() })
const logStore = createLogStore({
  maxEntries: MAX_LOG_ENTRIES,
  ruleStore,
  isInteractive,
  getBlockedPatterns: () => router.getBlockedPatterns(),
  onAdd: entry => {
    suggestions.onAdd(entry)
    stats.applyDashboardStatsDelta(entry, 1)
  },
  onRemove: entry => {
    suggestions.onRemove(entry, logStore)
    stats.applyDashboardStatsDelta(entry, -1)
  }
})
const addLog = entry => logStore.add(entry)
const filterLogsCore = query => filterLogsCoreForStore(query, logStore)
const filterLogsForApiRequest = req => filterLogsForApiRequestForStore(req, logStore)
const computeBypassSuggestions = options => suggestions.compute(options)
const {
  createLogEntry,
  createHttpFlowLogEntry,
  createWebSocketConnectionLog,
  logWebSocketDirectTunnel,
  logWebSocketMessage,
  recordUpstreamErrorOnLog
} = createLogEntryFactory({ isInteractive, addLog, attachRewriteMetadata })

let bypassedRequestCount = 0
function incrementBypassedCount (increment = 1) {
  const value = Number(increment)
  if (!Number.isFinite(value) || value <= 0) return
  bypassedRequestCount += value
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
  const hasLogging = configStore.interactiveModeEnabled === true
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
    if (configStore.interactiveModeEnabled) {
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
resourceStore.load()
router.loadBlockedUrls()
router.loadBypassUrls()
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
    const log = logStore.findById(id)

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
    ...configStore.snapshot(),
    filteredRequestCount: bypassedRequestCount
  })
})

// Toggle endpoints for boolean config flags
;[
  { path: '/api/interactive-mode', field: 'interactiveModeEnabled', set: v => { configStore.interactiveModeEnabled = v } },
  { path: '/api/edit-rules-mode', field: 'editRulesEnabled', set: v => { ruleStore.setEnabled(v) } },
  { path: '/api/local-resources-mode', field: 'localResourcesEnabled', set: v => { configStore.localResourcesEnabled = v } },
  { path: '/api/filter-rules-mode', field: 'filterRulesEnabled', set: v => { configStore.filterRulesEnabled = v } },
  { path: '/api/blocked-rules-mode', field: 'blockedRulesEnabled', set: v => { configStore.blockedRulesEnabled = v } }
].forEach(({ path, field, set }) => {
  app.post(path, (req, res) => handleBooleanToggleEndpoint({
    req,
    res,
    assignValue: set,
    responseFieldName: field,
    defaultEnabled: true,
    persist: () => configStore.persist()
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

  configStore.filterMode = normalized
  configStore.persist()
  router.rebuildBypassUrlsForCurrentMode()

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
  res.json(resourceStore.list())
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

    resourceStore.set(rawUrl, resourceData)
    await resourceStore.save()

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

    if (!resourceStore.has(rawUrl)) {
      return res.status(404).json({ error: 'Resource not found' })
    }

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid "enabled" flag: expected a boolean.' })
    }

    const updated = resourceStore.toggle(rawUrl, enabled !== false)
    await resourceStore.save()

    res.json({ success: true, resource: { url: rawUrl, ...updated } })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.delete('/api/resources/:encodedUrl', async (req, res) => {
  try {
    const url = decodeURIComponent(req.params.encodedUrl)

    if (await resourceStore.remove(url)) {
      await resourceStore.save()

      res.json({ success: true, message: 'Resource deleted successfully' })
    } else {
      res.status(404).json({ error: 'Resource not found' })
    }
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.delete('/api/logs', (req, res) => {
  logStore.clear()
  bypassedRequestCount = 0
  suggestions.reset()
  stats.reset()
  ruleStore.clearUsage()
  res.json({ success: true, message: 'Logs cleared' })
})

// Get all blocked rules
app.get('/api/blocked', (req, res) => {
  res.json(router.getBlockedRules())
})

// Add/update/remove blocked URL
app.post('/api/blocked', async (req, res) => {
  const { id, url, action, enabled, name } = req.body || {}
  const blockedRules = router.getBlockedRules()

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
    await router.saveBlockedUrls()
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
      await router.saveBlockedUrls()
    } else {
      return res.status(404).json({ error: 'Rule not found' })
    }
  } else if (action === 'remove') {
    if (!isValidId(id)) {
      return res.status(400).json({ error: 'ID is required for remove' })
    }
    router.setBlockedRules(blockedRules.filter(r => r.id !== id))
    await router.saveBlockedUrls()
  } else {
    return res.status(400).json({ error: 'Invalid action. Expected "add", "update" or "remove".' })
  }

  res.json({ success: true, blockedRules: router.getBlockedRules() })
})

// Get all filter rules
app.get('/api/filters', (req, res) => {
  try {
    const queryModeRaw = typeof req.query.mode === 'string' ? req.query.mode.toLowerCase() : null
    const effectiveMode = (queryModeRaw === 'focus' || queryModeRaw === 'ignore')
      ? queryModeRaw
      : getBypassMode()

    const rulesForMode = router.getBypassRules()
      .filter(rule => rule && rule.mode === effectiveMode)

    res.json(rulesForMode)
  } catch (error) {
    res.status(500).json({ error: 'Failed to load filter rules' })
  }
})

// Add/update/remove filter URL
app.post('/api/filters', (req, res) => {
  const { id, url, action, enabled, name, mode } = req.body || {}
  const bypassRules = router.getBypassRules()

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
    router.saveBypassUrls()
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
      router.saveBypassUrls()
    } else {
      return res.status(404).json({ error: 'Rule not found' })
    }
  } else if (action === 'remove') {
    if (!isValidId(id)) {
      return res.status(400).json({ error: 'ID is required for remove' })
    }
    router.setBypassRules(bypassRules.filter(r => r.id !== id))
    router.saveBypassUrls()
  } else {
    return res.status(400).json({ error: 'Invalid action. Expected "add", "update" or "remove".' })
  }

  res.json({ success: true, bypassRules: router.getBypassRules() })
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
    activeRules: router.getBypassUrls().length
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
  const { stats: dashboard, editedRequests, performance, payloads, routes } = stats.getDashboardSnapshot()

  res.json({
    stats: dashboard,
    performance,
    payloads,
    routes,
    resources: resourceStore.list(),
    blocked: router.getBlockedUrls(),
    filterMetrics: {
      totalFiltered: bypassedRequestCount,
      activeRules: router.getBypassUrls().length
    },
    editedRequests
  })
})

// Lightweight audit snapshot of the current in-memory log window (upstream
// error distribution and per-host latency) for the secret Proxy Audit Panel.
app.get('/api/audit', (req, res) => {
  try {
    res.json(stats.buildAuditSnapshot(logStore))
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

  const hasLogging = configStore.interactiveModeEnabled === true

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
  const localMatch = resourceStore.findMatching(requestUrl, fullUrl)

  if (localMatch) {
    const { url: matchedUrl, resource } = localMatch

    if (logEntry) {
      logEntry.source = 'local'
      logEntry.localResource = matchedUrl
      addLog(logEntry)
    }

    resourceStore.serveStream(res, resource, {
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

        if (!configStore.interactiveModeEnabled && !hasAnyEditRules) {
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

    if (configStore.interactiveModeEnabled) {
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

      const hasLogging = configStore.interactiveModeEnabled === true

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
      const localMatch = resourceStore.findMatching(requestUrl, fullUrl)

      if (localMatch) {
        const { url: matchedUrl, resource } = localMatch

        if (logEntry) {
          logEntry.source = 'local'
          logEntry.localResource = matchedUrl
          addLog(logEntry)
        }

        resourceStore.serveStream(clientRes, resource, {
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
  await upstream.close()
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
