'use strict'

/**
 * Interactive Proxy entry point: reads the configuration, creates the stores,
 * rewriters, flows and the management API in dependency order, builds the
 * server and starts it when run directly. Behaviour lives under src/; this
 * file only wires instances together and re-exports the internals used by
 * the characterization tests.
 */

const path = require('path')
const fs = require('fs')
const {
  PORT,
  HOST,
  UI_ORIGINS,
  STORAGE_DIR,
  LOGS_DIR,
  CERTS_DIR,
  MAX_LOG_ENTRIES,
  STRICT_TLS_ENABLED,
  STRICT_TLS_CA_FILE,
  BODY_LIMIT,
  UPSTREAM_HEADERS_TIMEOUT_MS,
  UPSTREAM_BODY_TIMEOUT_MS,
  UPSTREAM_H2,
  BREAKPOINT_TIMEOUT_MS
} = require('./config')

const { safeTrim, queryBool, safeString, parseListQuery } = require('./src/util/strings')
const { logInfo, logError } = require('./src/util/logger')
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
const {
  getConnectEncodingHeader,
  looksLikeConnectEnvelope,
  rebuildConnectEnvelope,
  decodeConnectPayload
} = require('./src/codecs/connect')
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
const { createHttpJsonRewriter } = require('./src/rewrite/http-json')
const { createConnectRewriter } = require('./src/rewrite/connect')
const { createBodyRewriter } = require('./src/rewrite/body')
const { createWebSocketRewriter } = require('./src/rewrite/websocket')
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
const { createConfigStore } = require('./src/state/config-store')
const { loadCaBundle, createUpstream } = require('./src/proxy/upstream')
const { createRouter } = require('./src/proxy/router')
const { createResourceStore } = require('./src/resources/store')
const {
  createForwardHeaders,
  stripIdentifyingHeaders,
  sanitizeHeaders,
  sanitizeAndStripIdentifyingHeaders
} = require('./src/proxy/headers')
const { httpUrlToWebSocketUrl } = require('./src/proxy/websocket-url')
const { createHttpFlow } = require('./src/proxy/http-flow')
const { createWebSocketProxy } = require('./src/proxy/websocket')
const { createMitmHandler } = require('./src/proxy/mitm')
const { createApiRouter } = require('./src/api')
const { createReplayRunner } = require('./src/logs/replay')
const { createBreakpointStore } = require('./src/rules/breakpoint-store')
const { createBreakpointGate } = require('./src/proxy/breakpoints')
const { createThrottleStore } = require('./src/rules/throttle-store')
const { createNetworkConditions } = require('./src/proxy/throttle')
const { createApp } = require('./src/app')
const { createProxyServer } = require('./src/server')

// Persistent files under the storage directory.
const BLOCKED_URLS_FILE = path.join(STORAGE_DIR, 'blocked-urls.json')
const FILTER_URLS_FILE = path.join(STORAGE_DIR, 'filter-urls.json')
const LEGACY_BYPASS_URLS_FILE = path.join(STORAGE_DIR, 'bypass-urls.json')
const EDIT_RULES_FILE = path.join(STORAGE_DIR, 'edit-rules.json')
const EDIT_RULE_PRESETS_FILE = path.join(STORAGE_DIR, 'edit-rule-presets.json')
const RESOURCES_FILE = path.join(STORAGE_DIR, 'resources.json')
const CONFIG_FILE = path.join(STORAGE_DIR, 'config.json')
const BREAKPOINTS_FILE = path.join(STORAGE_DIR, 'breakpoints.json')
const THROTTLE_RULES_FILE = path.join(STORAGE_DIR, 'throttle-rules.json')

// Ensure directories exist
try {
  ;[STORAGE_DIR, LOGS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  })
} catch (error) {
  logError('storage', 'Error ensuring storage/log directories', error)
}

// Upstream access: undici dispatchers, TLS strictness and the shared request
// helper used by the HTTP bypass path, the main proxy flow and the MITM flow.
const upstream = createUpstream({
  strictTls: STRICT_TLS_ENABLED,
  caBundle: loadCaBundle(STRICT_TLS_CA_FILE),
  headersTimeoutMs: UPSTREAM_HEADERS_TIMEOUT_MS,
  bodyTimeoutMs: UPSTREAM_BODY_TIMEOUT_MS,
  allowH2: UPSTREAM_H2
})

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
/**
 * @param {Record<string, any> | null | undefined} logEntry
 * @param {string[]} appliedRuleIds
 * @param {string} phase
 */
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
const resourceStore = createResourceStore({
  file: RESOURCES_FILE,
  storageDir: STORAGE_DIR,
  configStore
})

// Breakpoint rules and the gate that holds the matching flows. Flows are
// held only while an event stream is open (`streamPresence` is kept by the
// events route), since only the UI can resume them.
const breakpointStore = createBreakpointStore({ file: BREAKPOINTS_FILE })
breakpointStore.load()
/** @type {import('./src/api/events').StreamPresence} */
const streamPresence = { clients: 0 }
const breakpointGate = createBreakpointGate({
  store: breakpointStore,
  isEnabled: () => configStore.breakpointsEnabled,
  hasListeners: () => streamPresence.clients > 0,
  timeoutMs: BREAKPOINT_TIMEOUT_MS
})

// Network-condition rules (latency, bandwidth cap) and their matcher.
const throttleStore = createThrottleStore({ file: THROTTLE_RULES_FILE })
throttleStore.load()
const network = createNetworkConditions({
  store: throttleStore,
  isEnabled: () => configStore.throttlingEnabled
})

// Rewrite orchestration bound to the rule store. Interactive mode and the
// log store are reached through a getter and a callback (both resolve at
// call time).
const isInteractive = () => configStore.interactiveModeEnabled
const httpJsonRewriter = createHttpJsonRewriter({
  ruleStore,
  textRules,
  jsonPathRules,
  isInteractive
})
const connectRewriter = createConnectRewriter({
  ruleStore,
  textRules,
  jsonPathRules,
  isInteractive
})
const bodyRewriter = createBodyRewriter({
  ruleStore,
  textRules,
  httpJson: httpJsonRewriter,
  connect: connectRewriter,
  isInteractive,
  addLog: entry => addLog(entry)
})
const webSocketRewriter = createWebSocketRewriter({ ruleStore, textRules, jsonPathRules })

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
/** @param {Record<string, any>} entry */
const addLog = entry => logStore.add(entry)
// Streamed responses learn their size only when the transfer ends; the flows
// report it here, and the window may have evicted the entry in the meantime.
/** @type {Pick<import('./src/logs/stats').Stats, 'recordStreamedResponseSize'>} */
const streamedSizeStats = {
  recordStreamedResponseSize: (entry, bytes) => {
    if (entry && logStore.findById(entry.id) === entry) {
      stats.recordStreamedResponseSize(entry, bytes)
    }
  }
}
/** @param {Record<string, any>} [query] */
const filterLogsCore = query => filterLogsCoreForStore(query, logStore)
/** @param {{ limit?: number }} [options] */
const computeBypassSuggestions = options => suggestions.compute(options)
const entries = createLogEntryFactory({ isInteractive, addLog, attachRewriteMetadata })

// Load resources and rules on startup
resourceStore.load()
router.loadBlockedUrls()
router.loadBypassUrls()
loadEditRules()
loadEditRulePresets()
rebuildEditRuleCache()

// Requests redirected by the filter rules (direct tunnels and flows). The
// flows increment the counter; the API reads and resets it.
let bypassedRequestCount = 0
const bypassCounter = {
  get: () => bypassedRequestCount,
  /** @param {number} [increment] */
  increment: (increment = 1) => {
    const value = Number(increment)
    if (!Number.isFinite(value) || value <= 0) return
    bypassedRequestCount += value
  },
  reset: () => {
    bypassedRequestCount = 0
  }
}

// Flows, management API, Express application and the listening server.
const httpFlow = createHttpFlow({
  configStore,
  router,
  upstream,
  resourceStore,
  addLog,
  entries,
  bodyRewriter,
  httpJson: httpJsonRewriter,
  connect: connectRewriter,
  textRules,
  ruleStore,
  attachRewriteMetadata,
  bypassCounter,
  stats: streamedSizeStats,
  breakpoints: breakpointGate,
  network,
  touchLog: entry => logStore.touch(entry),
  port: PORT
})
const replayRunner = createReplayRunner({ port: PORT, host: HOST, logStore })
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
  bypassCounter,
  replay: replayRunner,
  breakpointStore,
  breakpointGate,
  throttleStore,
  streamPresence
})
const app = createApp({
  uiOrigins: UI_ORIGINS,
  bodyLimit: BODY_LIMIT,
  isProxyTargetedRequest: router.isProxyTargetedRequest,
  handleProxiedHttpRequest: httpFlow.handleProxiedHttpRequest,
  apiRouter,
  clientBuildDir: path.join(__dirname, '..', 'client', 'dist')
})
const webSocketProxy = createWebSocketProxy({
  router,
  addLog,
  entries,
  webSocketRewriter,
  caBundle: upstream.caBundle,
  bypassCounter
})
const mitm = createMitmHandler({
  configStore,
  router,
  upstream,
  resourceStore,
  addLog,
  entries,
  bodyRewriter,
  httpJson: httpJsonRewriter,
  httpFlow,
  webSocketProxy,
  bypassCounter,
  stats: streamedSizeStats,
  breakpoints: breakpointGate,
  network,
  touchLog: entry => logStore.touch(entry)
})
const { server, start, stop } = createProxyServer({
  app,
  httpFlow,
  webSocketProxy,
  mitm,
  upstream,
  defaults: { port: PORT, host: HOST }
})

/** Stop the server; flows held at a breakpoint continue unchanged first. */
async function stopProxy() {
  breakpointGate.close()
  return stop()
}

if (require.main === module) {
  start()
    .then(address => {
      logInfo('startup', `listening on http://${address.address}:${address.port}`)
    })
    .catch(error => {
      logError('startup', `failed to start on ${HOST}:${PORT}`, error)
      process.exit(1)
    })
}

module.exports = {
  app,
  server,
  start,
  stop: stopProxy,
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
    applyConnectFrameRewrites: connectRewriter.applyConnectFrameRewrites,
    applyConnectRewritesForBypass: connectRewriter.applyConnectRewritesForBypass,
    getConnectEncodingHeader,
    // edit rules
    parseJsonPath,
    applyJsonPathRulesToObject: jsonPathRules.applyJsonPathRulesToObject,
    applyJsonPathRulesToProtobufBuffer: jsonPathRules.applyJsonPathRulesToProtobufBuffer,
    normalizeEditRule,
    normalizeEditRulePreset,
    serializeEditRuleForDisk,
    deserializeEditRuleFromDisk,
    splitLongStringIntoSegments,
    compileEditRule,
    rebuildEditRuleCache,
    getCompiledRules: ruleStore.getCompiledRules,
    getCompiledRulesForContext: ruleStore.getCompiledRulesForContext,
    getCompiledJsonPathRules: ruleStore.getCompiledJsonPathRules,
    hasAnyEditOrJsonPathRules: ruleStore.hasAnyEditOrJsonPathRules,
    replaceTextLiteral,
    applyCompiledRuleToText: textRules.applyCompiledRuleToText,
    applyEditRulesToText: textRules.applyEditRulesToText,
    applyEditRulesToHeaders: textRules.applyEditRulesToHeaders,
    applyEditRulesToBuffer: textRules.applyEditRulesToBuffer,
    rewriteJsonHttpBody: httpJsonRewriter.rewriteJsonHttpBody,
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
    httpUrlToWebSocketUrl,
    normalizeWebSocketPayload,
    stripSocketIoPrefix,
    tryParseWebSocketJson,
    normalizeNestedJsonStrings,
    rewriteWebSocketPayload: webSocketRewriter.rewriteWebSocketPayload,
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
    resolveTargetFromRequest: router.resolveTargetFromRequest,
    buildRoutingContext: router.buildRoutingContext,
    createBypassContext: router.createBypassContext,
    decideHttpHandling: router.decideHttpHandling,
    decideWebSocketHandling: router.decideWebSocketHandling,
    isInternalProxyRequest: router.isInternalProxyRequest,
    shouldUseDirectConnection: router.shouldUseDirectConnection,
    shouldBypassRequest: router.shouldBypassRequest,
    isRequestBlocked: router.isRequestBlocked,
    isProxyTargetedRequest: router.isProxyTargetedRequest,
    createForwardHeaders,
    sanitizeHeaders,
    stripIdentifyingHeaders,
    sanitizeAndStripIdentifyingHeaders,
    loadBlockedUrls: router.loadBlockedUrls,
    loadBypassUrls: router.loadBypassUrls,
    getBypassMode: router.getBypassMode,
    // logs and search
    createLogEntry: entries.createLogEntry,
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
