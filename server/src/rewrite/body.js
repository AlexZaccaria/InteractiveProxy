'use strict'

/**
 * Body orchestration shared by the plain HTTP proxy and the HTTPS MITM
 * flows: request bodies go through the Connect/protobuf and JSON rewriters,
 * buffered upstream responses through the same plus the per-frame Connect
 * text rewrites, and the resulting logging view is written on the log entry
 * which is then handed to the log store.
 *
 * `createBodyRewriter` receives the rule store, the text/JSONPath rewriters,
 * the HTTP JSON and Connect orchestrators, the interactive-mode getter and
 * the log sink. Nothing here is module-level state.
 */

const { safeString } = require('../util/strings')
const { logDebug } = require('../util/logger')
const { attachRewriteMetadata } = require('../rules/metadata')
const {
  getContentType,
  getContentEncoding,
  isClearlyBinaryContentType,
  decompressDataForLogging,
  isEmptyBuffer
} = require('../codecs/compression')
const {
  bufferToTextPreview,
  tryParseJsonString,
  normalizeNestedJsonStrings
} = require('../logs/preview')

/** @typedef {import('../rules/store').RuleStore} RuleStore */
/** @typedef {ReturnType<typeof import('../rules/text-rules').createTextRewriter>} TextRewriter */
/** @typedef {ReturnType<typeof import('./http-json').createHttpJsonRewriter>} HttpJsonRewriter */
/** @typedef {ReturnType<typeof import('./connect').createConnectRewriter>} ConnectRewriter */
/** @typedef {import('../codecs/compression').HeadersLike} HeadersLike */
/** @typedef {import('../codecs/connect').DecodedConnectPayload} DecodedConnectPayload */
/** @typedef {Record<string, any>} LogEntry */

/**
 * @typedef {object} BodyRewriterDeps
 * @property {RuleStore} ruleStore
 * @property {TextRewriter} textRules
 * @property {HttpJsonRewriter} httpJson
 * @property {ConnectRewriter} connect
 * @property {() => boolean} isInteractive Whether interactive logging is on.
 * @property {(logEntry: LogEntry) => void} addLog Log sink for completed entries.
 */

/**
 * Create the body orchestration helpers.
 *
 * @param {BodyRewriterDeps} deps
 */
function createBodyRewriter({ ruleStore, textRules, httpJson, connect, isInteractive, addLog }) {
  /**
   * @param {LogEntry|null|undefined} logEntry
   * @param {string[]} appliedRuleIds
   * @param {string|undefined} phase
   */
  const attach = (logEntry, appliedRuleIds, phase) =>
    attachRewriteMetadata(logEntry, appliedRuleIds, phase, ruleStore)

  /**
   * Build the textual/JSON logging view of a buffered HTTP response body and
   * store the structured JSON view on the log entry when available.
   *
   * @param {object} params
   * @param {LogEntry} params.logEntry
   * @param {Buffer} params.buffer
   * @param {string} params.contentType
   * @param {string} params.contentEncoding
   * @param {boolean} params.isBinary
   * @param {DecodedConnectPayload|null} params.connectResponse
   * @param {boolean} [params.allowUnaryConnectText]
   * @param {Buffer|null} [params.decompressedBuffer]
   * @returns {{ body: string }}
   */
  function buildHttpResponseLoggingView({
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
    /** @type {any} */
    let responseBodyJson = null

    const hasConnect = !!connectResponse
    const isEnvelope = hasConnect && !!connectResponse.envelope
    const allowConnectText = !hasConnect || (allowUnaryConnectText && hasConnect && !isEnvelope)

    const lowerType = safeString(contentType).toLowerCase()

    // Treat any "*json"-like content-type (including application/manifest+json
    // and other +json variants) as textual so that we can safely log and parse
    // it for the UI.
    const shouldTryText =
      allowConnectText &&
      !isBinary &&
      (lowerType.includes('json') ||
        lowerType.includes('text/') ||
        lowerType.includes('javascript') ||
        (contentEncoding && dataToLog !== buffer))

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
        logDebug(
          'buildHttpResponseLoggingView',
          'Failed to parse HTTP JSON response for logging',
          error
        )
      }
    }

    if (logEntry && responseBodyJson && typeof responseBodyJson === 'object') {
      logEntry.responseBodyJson = responseBodyJson
    }

    return { body: responseBody }
  }

  /**
   * Process a request body buffer through Connect/protobuf and JSONPath
   * rewrites, updating the log entry as needed.
   *
   * This helper unifies the common pattern used by both the Express proxy
   * middleware and the HTTPS MITM request handler.
   *
   * @param {object} params
   * @param {Buffer|null|undefined} params.buffer - Raw request body buffer.
   * @param {Record<string, any>} params.headers - Request headers.
   * @param {string} params.requestUrl - Request URL path.
   * @param {string} params.fullUrl - Fully qualified URL.
   * @param {LogEntry|null|undefined} params.logEntry - Mutable log entry to enrich.
   * @param {boolean} [params.allowBodyRewriteFallback=false] - Allow text fallback rewrites.
   * @param {boolean} [params.logNonJsonBody=false] - Log non-JSON body text.
   * @returns {{ buffer: Buffer, connectRequest: DecodedConnectPayload|null }}
   */
  function processRequestBodyWithRewrites({
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
    // isEmptyBuffer is not a type guard: past it the buffer is a Buffer.
    const input = /** @type {Buffer} */ (buffer)

    const shouldTouchConnect =
      (isInteractive() && !!logEntry) || ruleStore.hasAnyEditOrJsonPathRules()

    let workingBuffer = input
    /** @type {DecodedConnectPayload|null} */
    let connectRequest = null

    if (shouldTouchConnect) {
      const connectResult = connect.applyConnectRewritesAndDecode(logEntry, input, headers, {
        role: 'request',
        allowBodyRewriteFallback,
        updateContentEncoding: true,
        urlContext: { requestUrl, fullUrl }
      })
      workingBuffer = connectResult.buffer
      connectRequest = connectResult.connect
    }

    if (!connectRequest) {
      const hasJsonPathRules = ruleStore.hasCompiledJsonPathRules()

      if (hasJsonPathRules || isInteractive()) {
        const { buffer: nextBuffer } = httpJson.applyJsonRequestRewritesForLog(
          {
            buffer: workingBuffer,
            headers,
            requestUrl,
            fullUrl,
            logEntry
          },
          { logNonJsonBody }
        )
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
   * @param {Buffer} [options.responseBuffer] - Raw buffered upstream response body.
   * @param {Record<string, any>} [options.upstreamHeaders] - Mutable upstream response headers.
   * @param {string} [options.requestUrl] - Request URL path used for rule matching.
   * @param {string} [options.jsonPathFullUrl] - Full URL used for JSONPath rules.
   * @param {LogEntry|null} [options.logEntry] - Mutable log entry to enrich, or null.
   * @param {'proxied'|'mitm'} [options.source] - Source tag to set on the log entry.
   * @param {string} [options.targetUrlForLog] - Final upstream target URL for logging.
   * @param {boolean} [options.overrideFullUrlOnLog] - If true, replace logEntry.fullUrl with targetUrlForLog.
   * @param {boolean} [options.allowUnaryConnectText] - Whether unary Connect responses may be rendered as text.
   * @param {number} [options.statusCode] - Upstream HTTP status code.
   * @param {boolean} [options.enableConnectFrameTextRewrites] - Enable per-frame text rewrites for Connect.
   * @param {string} [options.frameRewriteFullUrl] - Full URL used for Connect frame text rule matching.
   * @returns {{
   *   finalResponseBuffer: Buffer,
   *   upstreamHeaders: Record<string, any>,
   *   connectResponse: DecodedConnectPayload|null,
   *   contentType: string,
   *   contentEncoding: string,
   *   isBinary: boolean
   * }}
   */
  function handleBufferedUpstreamResponseWithRewrites(options = {}) {
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
    // Callers always pass the buffered body; the cast keeps the loose
    // options shape without changing behaviour.
    const bodyBuffer = /** @type {Buffer} */ (responseBuffer)

    // Capture the content metadata *before* any Connect rewrites update the
    // content-encoding header, matching the previous behaviour in both the
    // HTTP proxy and HTTPS MITM response paths.
    const contentType = getContentType(headers)
    const contentEncoding = getContentEncoding(headers)
    const isBinary = isClearlyBinaryContentType(contentType)

    const { buffer: effectiveResponseBuffer, connect: connectResponse } =
      connect.applyConnectRewritesAndDecode(logEntry, bodyBuffer, headers, {
        role: 'response',
        allowBodyRewriteFallback: true,
        updateContentEncoding: true,
        urlContext: { requestUrl, fullUrl: jsonPathFullUrl }
      })

    let finalResponseBuffer = effectiveResponseBuffer
    /** @type {Buffer|null} */
    let jsonDecompressedForLog = null

    if (!connectResponse) {
      if (ruleStore.hasCompiledJsonPathRules()) {
        const { buffer: updatedBuffer, jsonRewrite } = httpJson.applyJsonResponseRewritesForLog({
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
      if (ruleStore.hasCompiledTextRules()) {
        /** @type {import('../codecs/connect').ConnectFrame[]} */
        const rewrittenFrames = []
        /** @type {Set<string>} */
        const appliedSet = new Set()
        let frameChanged = false
        const frameFullUrl = frameRewriteFullUrl || jsonPathFullUrl || requestUrl

        for (const frame of connectResponse.frames) {
          if (frame.compressed || frame.error) {
            rewrittenFrames.push(frame)
            continue
          }

          const frameText = frame.preview || (frame.json ? JSON.stringify(frame.json) : '')
          const rewriteResult = textRules.applyEditRulesToText(frameText, {
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
            attach(logEntry, Array.from(appliedSet), 'response')
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

  return {
    buildHttpResponseLoggingView,
    processRequestBodyWithRewrites,
    handleBufferedUpstreamResponseWithRewrites
  }
}

module.exports = { createBodyRewriter }
