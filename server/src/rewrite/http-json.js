'use strict'

/**
 * HTTP JSON body and header rewrites shared by the HTTP and MITM flows:
 * JSONPath rules applied to plain application/json bodies (transparently
 * handling content-encoding) and text rules applied to headers, with the
 * log-entry enrichment the flows share (JSON views, previews, rewrite
 * metadata).
 *
 * `createHttpJsonRewriter` returns functions bound to one rule store and its
 * text/JSONPath rewriters; `isInteractive()` says whether log entries get
 * the before/after views (interactive mode on). Nothing here is module-level
 * state.
 */

const { safeString } = require('../util/strings')
const { logDebug } = require('../util/logger')
const { buildJsonPathRuleContext } = require('../rules/url-match')
const { attachRewriteMetadata, hasAppliedRules } = require('../rules/metadata')
const {
  getContentType,
  getContentEncoding,
  getCompressionCodec,
  decompressData,
  isEmptyBuffer
} = require('../codecs/compression')
const { bufferToTextPreview, normalizeNestedJsonStrings } = require('../logs/preview')

/** @typedef {import('../rules/store').RuleStore} RuleStore */
/** @typedef {ReturnType<typeof import('../rules/text-rules').createTextRewriter>} TextRewriter */
/** @typedef {ReturnType<typeof import('../rules/jsonpath').createJsonPathRewriter>} JsonPathRewriter */
/** @typedef {import('../rules/url-match').UrlMatchContext} UrlMatchContext */
/** @typedef {import('../codecs/compression').HeadersLike} HeadersLike */

/**
 * Mutable log entry enriched by the rewrite helpers. The shape is owned by
 * the log store; the helpers only write the fields they document.
 *
 * @typedef {Record<string, any>} LogEntry
 */

/**
 * Result of rewriteJsonHttpBody.
 *
 * @typedef {object} JsonRewriteResult
 * @property {Buffer} buffer Body to forward (rewritten and recompressed when changed).
 * @property {any} json JSON view for logging, or null when the body is not JSON.
 * @property {any} [beforeJson] JSON view before the rules, when captured.
 * @property {string[]} appliedRuleIds
 * @property {boolean} changed
 * @property {Buffer|null} decompressed Decompressed body when the input was encoded.
 */

/**
 * @typedef {object} HttpJsonRewriterDeps
 * @property {RuleStore} ruleStore
 * @property {TextRewriter} textRules
 * @property {JsonPathRewriter} jsonPathRules
 * @property {() => boolean} isInteractive Whether interactive logging is on.
 */

/**
 * Create the HTTP JSON/header rewrite helpers bound to one rule store.
 *
 * @param {HttpJsonRewriterDeps} deps
 */
function createHttpJsonRewriter ({ ruleStore, textRules, jsonPathRules, isInteractive }) {
  /**
   * @param {LogEntry|null|undefined} logEntry
   * @param {string[]} appliedRuleIds
   * @param {string|undefined} phase
   */
  const attach = (logEntry, appliedRuleIds, phase) =>
    attachRewriteMetadata(logEntry, appliedRuleIds, phase, ruleStore)

  /**
   * Return true when interactive logging is enabled and a log entry is
   * available to enrich. Centralises the common guard used by the body
   * processing paths.
   *
   * @param {LogEntry|null|undefined} logEntry
   * @returns {boolean}
   */
  function wantsInteractiveLogging (logEntry) {
    return isInteractive() && !!logEntry
  }

  /**
   * Apply header rewrites and attach metadata to log entry in one step.
   * Returns the (possibly modified) headers object.
   *
   * @param {Record<string, any>} headers - Headers to rewrite.
   * @param {UrlMatchContext & { phase: string }} context
   * @param {LogEntry|null|undefined} logEntry - Log entry to attach rewrite metadata to.
   * @returns {Record<string, any>} Rewritten headers.
   */
  function applyHeaderRewrites (headers, context, logEntry) {
    const result = textRules.applyEditRulesToHeaders(headers, context)
    if (result.changed && logEntry && hasAppliedRules(result.appliedRuleIds)) {
      attach(logEntry, result.appliedRuleIds, context.phase)
    }
    return result.changed ? result.headers : headers
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
   * @param {object} [params]
   * @param {Buffer} [params.buffer] - Raw HTTP body buffer (compressed or not).
   * @param {string} [params.encoding] - Content-Encoding header value.
   * @param {string} [params.contentType] - Content-Type header value.
   * @param {{requestUrl?: string, fullUrl?: string}} [params.urlContext] - URL context.
   * @param {('request'|'response')} [params.phase] - JSONPath phase, defaults to 'request'.
   * @param {boolean} [params.captureBeforeJson] - When true, capture a
   *   deep-cloned snapshot of the JSON payload before applying JSONPath rules
   *   so that callers (typically logging paths) can render accurate
   *   before/after views. When false, the clone is skipped to reduce CPU/GC
   *   overhead on large payloads.
   * @returns {JsonRewriteResult}
   */
  function rewriteJsonHttpBody ({
    buffer,
    encoding = '',
    contentType = '',
    urlContext = {},
    phase = 'request',
    captureBeforeJson = true
  } = {}) {
    // The guards below are not type guards: once they pass, the buffer is a
    // non-empty Buffer.
    const input = /** @type {Buffer} */ (buffer)

    if (isEmptyBuffer(input)) {
      return { buffer: input, json: null, appliedRuleIds: [], changed: false, decompressed: null }
    }

    const lowerType = safeString(contentType).toLowerCase()
    if (!lowerType.includes('application/json')) {
      return { buffer: input, json: null, appliedRuleIds: [], changed: false, decompressed: null }
    }

    const normalizedEncoding = safeString(encoding).toLowerCase()
    const needsDecompress = normalizedEncoding && normalizedEncoding !== 'identity'
    let decompressed = needsDecompress
      ? decompressData(input, normalizedEncoding, contentType)
      : null

    const bufferForJson = decompressed || input

    let parsed
    try {
      parsed = JSON.parse(bufferForJson.toString('utf8'))
    } catch (error) {
      // Malformed JSON – surface to callers via a null json field while keeping
      // the original buffer so that logging can still fall back to text.
      return { buffer: input, json: null, appliedRuleIds: [], changed: false, decompressed }
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
    /** @param {any} value */
    const toDisplayJson = (value) => {
      try {
        return normalizeNestedJsonStrings(JSON.parse(JSON.stringify(value)))
      } catch {
        return value
      }
    }

    const beforeJson = captureBeforeJson ? toDisplayJson(parsed) : null

    const jsonPathResult = jsonPathRules.applyJsonPathRulesToObject(parsed, jsonPathContext)
    const resultObject = jsonPathResult ? jsonPathResult.object : parsed
    const json = captureBeforeJson ? toDisplayJson(resultObject) : resultObject

    if (!jsonPathResult || !jsonPathResult.changed) {
      return {
        buffer: input,
        json,
        beforeJson,
        appliedRuleIds: jsonPathResult ? (jsonPathResult.appliedRuleIds || []) : [],
        changed: false,
        decompressed
      }
    }

    const updatedDecoded = Buffer.from(JSON.stringify(resultObject), 'utf8')

    let nextBuffer = input
    if (decompressed) {
      const codec = getCompressionCodec(normalizedEncoding)
      if (codec) {
        try {
          nextBuffer = codec.compress(updatedDecoded)
        } catch (error) {
          // If recompression fails, fall back to the original body.
          nextBuffer = input
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
   * @param {object} params
   * @param {Buffer} params.buffer
   * @param {HeadersLike|null|undefined} params.headers
   * @param {string} [params.requestUrl]
   * @param {string} [params.fullUrl]
   * @param {('request'|'response')} [params.phase='request']
   * @param {boolean} [params.captureBeforeJson=true]
   * @returns {{ buffer: Buffer, jsonRewrite: JsonRewriteResult, contentType: string }}
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
   * @param {object} params
   * @param {Buffer} params.buffer - Raw HTTP request body buffer.
   * @param {HeadersLike|null|undefined} params.headers - Request headers.
   * @param {string} [params.requestUrl] - Request URL/path as seen by the proxy.
   * @param {string} [params.fullUrl] - Fully-qualified URL when available.
   * @param {LogEntry|null|undefined} params.logEntry - Mutable log entry to enrich.
   * @param {{ logNonJsonBody?: boolean }} [options]
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
    /** @type {string|undefined} */
    let preview
    if (logEntry) {
      preview = bufferToTextPreview(previewSource)
      if (preview) {
        logEntry.rawRequestBodyPreview = preview
      }

      if (hasAppliedRules(jsonRewrite.appliedRuleIds)) {
        attach(logEntry, jsonRewrite.appliedRuleIds, 'request')
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
      } catch (error) {
        logDebug('rewrite', 'Could not build a text fallback for the request body log', error)
      }
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
      } catch (error) {
        logDebug('rewrite', 'Could not build a text fallback for the request body log', error)
      }
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
   * @param {object} params
   * @param {Buffer} params.buffer - Raw HTTP response body buffer.
   * @param {HeadersLike|null|undefined} params.headers - Response headers.
   * @param {string} [params.requestUrl] - Request URL/path as seen by the proxy.
   * @param {string} [params.fullUrl] - Fully-qualified URL when available.
   * @param {LogEntry|null|undefined} [params.logEntry] - Mutable log entry to enrich.
   * @param {('request'|'response')} [params.phase='response'] - JSONPath phase.
   * @returns {{ buffer: Buffer, jsonRewrite: JsonRewriteResult|null }} Updated body buffer
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
      attach(logEntry, jsonRewrite.appliedRuleIds, phase)
    }

    return { buffer: nextBuffer, jsonRewrite }
  }

  return {
    wantsInteractiveLogging,
    applyHeaderRewrites,
    rewriteJsonHttpBody,
    runJsonBodyRewrite,
    applyJsonRequestRewritesForLog,
    applyJsonResponseRewritesForLog
  }
}

module.exports = { createHttpJsonRewriter }
