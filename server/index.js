const http = require('http')
const https = require('https')
const net = require('net')
const tls = require('tls')
const path = require('path')
const fs = require('fs')
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

const { loadCaBundle, createUpstream, handleUpstreamError: handleUpstreamErrorWithRecorder } = require('./src/proxy/upstream')
const { createConfigStore } = require('./src/state/config-store')
const { createRouter } = require('./src/proxy/router')
const { createResourceStore } = require('./src/resources/store')
const { createApiRouter } = require('./src/api')
const { createApp } = require('./src/app')

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
  loadBypassUrls
} = router
const handleUpstreamError = params => handleUpstreamErrorWithRecorder(params, recordUpstreamErrorOnLog)

const { safeTrim, queryBool, safeString, parseListQuery } = require('./src/util/strings')

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
const { buildClientLogView } = require('./src/logs/views')
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

// Load resources and blocked URLs on startup
resourceStore.load()
router.loadBlockedUrls()
router.loadBypassUrls()
loadEditRules()
loadEditRulePresets()
rebuildEditRuleCache()

// Management API and Express application. The bypass counter stays here
// because the flows below increment it; the API reads and resets it.
// `handleProxiedHttpRequest` is a hoisted function declaration, so the app
// can reference it before its definition.
const bypassCounter = {
  get: () => bypassedRequestCount,
  increment: incrementBypassedCount,
  reset: () => { bypassedRequestCount = 0 }
}
const apiRouter = createApiRouter({
  logStore,
  stats,
  suggestions,
  ruleStore,
  configStore,
  router,
  resourceStore,
  storageDir: STORAGE_DIR,
  uiOrigins: UI_ORIGINS,
  bypassCounter
})
const app = createApp({
  uiOrigins: UI_ORIGINS,
  bodyLimit: BODY_LIMIT,
  isProxyTargetedRequest,
  handleProxiedHttpRequest,
  apiRouter,
  clientBuildDir: path.join(__dirname, '..', 'client', 'build')
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
