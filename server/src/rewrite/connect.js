'use strict'

/**
 * Connect/gRPC body rewrites: text and JSONPath rules applied frame by frame
 * inside a Connect envelope (or to a unary protobuf/text body), with the
 * decoded before/after views stored on the log entry.
 *
 * `createConnectRewriter` returns functions bound to one rule store and its
 * text/JSONPath rewriters; `isInteractive()` says whether the extra decoding
 * pass used purely for logging is wanted. Nothing here is module-level state.
 */

const { LOG_PREVIEW_MAX_BYTES } = require('../../config')
const { safeString } = require('../util/strings')
const { logDebug } = require('../util/logger')
const { attachRewriteMetadata, hasAppliedRules } = require('../rules/metadata')
const {
  getContentType,
  getContentEncoding,
  getCompressionCodec,
  isProtoContentType,
  isTextualContentType,
  isEmptyBuffer
} = require('../codecs/compression')
const {
  CONNECT_MAX_FRAMES_LIMIT,
  CONNECT_MAX_FRAME_BYTES_LIMIT,
  getConnectEncodingHeader,
  looksLikeConnectEnvelope,
  rebuildConnectEnvelope,
  decodeConnectPayload
} = require('../codecs/connect')
const { rewriteProtobufFields, extractJsonFromProtobufBuffer } = require('../codecs/protobuf')
const { bufferToTextPreview, tryParseJsonString } = require('../logs/preview')

/** @typedef {import('../rules/store').RuleStore} RuleStore */
/** @typedef {ReturnType<typeof import('../rules/text-rules').createTextRewriter>} TextRewriter */
/** @typedef {ReturnType<typeof import('../rules/jsonpath').createJsonPathRewriter>} JsonPathRewriter */
/** @typedef {import('../rules/url-match').UrlMatchContext} UrlMatchContext */
/** @typedef {import('../codecs/compression').HeadersLike} HeadersLike */
/** @typedef {import('../codecs/compression').CompressionCodec} CompressionCodec */
/** @typedef {import('../codecs/connect').DecodedConnectPayload} DecodedConnectPayload */
/** @typedef {import('../codecs/connect').ConnectFrame} ConnectFrame */
/** @typedef {Record<string, any>} LogEntry */

/**
 * Decoded frame as produced by decodeConnectPayload, including the
 * non-enumerable caches it attaches for the rewrite pass.
 *
 * @typedef {ConnectFrame & { _decodedBuffer?: Buffer, _rawProtobufJson?: Record<string, unknown> | null }} CachedConnectFrame
 */

/**
 * Frame produced by the envelope rewrite: raw flags/bytes plus the logging
 * view of the (possibly rewritten) payload.
 *
 * @typedef {object} RewrittenFrame
 * @property {number} index
 * @property {number} flags
 * @property {Buffer} data
 * @property {number} length
 * @property {boolean} compressed
 * @property {boolean} endStream
 * @property {boolean} [frameDecompressed]
 * @property {string} preview
 * @property {any} json
 * @property {string|null} [note]
 */

/**
 * @typedef {object} ConnectFrameRewriteResult
 * @property {Buffer} buffer
 * @property {string[]} appliedRuleIds
 * @property {boolean} changed
 * @property {string} [encoding] Content-encoding of the returned buffer ('' when now unencoded).
 * @property {RewrittenFrame[]} [updatedFrames]
 */

/**
 * @typedef {object} EnvelopeRewriteResult
 * @property {Buffer} buffer
 * @property {string[]} appliedRuleIds
 * @property {boolean} changed
 * @property {boolean} success Whether the buffer parsed as a Connect envelope.
 * @property {RewrittenFrame[]} [updatedFrames]
 */

/**
 * @typedef {object} ConnectRewriteOptions
 * @property {string} [role] 'request' or 'response'.
 * @property {boolean} [allowBodyRewriteFallback] Allow fallback to text rewrites.
 * @property {boolean} [updateContentEncoding] Update content-encoding after rewrites.
 * @property {{requestUrl?: string, fullUrl?: string}|null} [urlContext] URL context used for rules when no log entry is present.
 */

/**
 * @typedef {object} ConnectRewriterDeps
 * @property {RuleStore} ruleStore
 * @property {TextRewriter} textRules
 * @property {JsonPathRewriter} jsonPathRules
 * @property {() => boolean} isInteractive Whether interactive logging is on.
 */

/**
 * Create the Connect rewrite helpers bound to one rule store.
 *
 * @param {ConnectRewriterDeps} deps
 */
function createConnectRewriter ({ ruleStore, textRules, jsonPathRules, isInteractive }) {
  /**
   * @param {LogEntry|null|undefined} logEntry
   * @param {string[]} appliedRuleIds
   * @param {string|undefined} phase
   */
  const attach = (logEntry, appliedRuleIds, phase) =>
    attachRewriteMetadata(logEntry, appliedRuleIds, phase, ruleStore)

  /**
   * @param {LogEntry|null|undefined} logEntry
   * @returns {boolean}
   */
  function wantsInteractiveLogging (logEntry) {
    return isInteractive() && !!logEntry
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
   * @param {HeadersLike} [headers] - HTTP headers for the message.
   * @param {DecodedConnectPayload|null} [decodedConnect] - Optional Connect decode view.
   * @param {UrlMatchContext} [jsonPathContext] - Context forwarded to JSONPath rules.
   * @param {{ loggingEnabled?: boolean }} [options] - Controls frame metadata/logging work.
   * @returns {ConnectFrameRewriteResult}
   */
  function applyConnectFrameRewrites (buffer, headers = {}, decodedConnect = null, jsonPathContext = {}, options = {}) {
    if (isEmptyBuffer(buffer)) {
      return { buffer, appliedRuleIds: [], changed: false }
    }

    const loggingEnabled = options && options.loggingEnabled === true

    const compiledTextRules = ruleStore.getCompiledRules()
    const compiledJsonPathRulesLocal = ruleStore.getCompiledJsonPathRules()

    const hasTextRules = Array.isArray(compiledTextRules) && compiledTextRules.length > 0
    const hasJsonPathRules = Array.isArray(compiledJsonPathRulesLocal) && compiledJsonPathRulesLocal.length > 0

    if (!hasTextRules && !hasJsonPathRules) {
      return { buffer, appliedRuleIds: [], changed: false }
    }

    if (!hasTextRules && hasJsonPathRules) {
      const context = jsonPathContext || {}
      /** @type {string[]} */
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
    /** @type {((data: Buffer) => Buffer) | undefined} */
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

    /**
     * @param {Buffer} inputBuffer
     * @returns {EnvelopeRewriteResult}
     */
    const attemptEnvelopeRewrite = (inputBuffer) => {
      if (inputBuffer.length < 5) {
        return { buffer: inputBuffer, appliedRuleIds: [], changed: false, success: false }
      }

      let offset = 0
      /** @type {Array<{ flags: number, data: Buffer }>} */
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
      /** @type {Set<string>} */
      const appliedSet = new Set()
      /** @type {RewrittenFrame[]} */
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
            const decodedFrame = /** @type {CachedConnectFrame | undefined} */ (decodedConnect.frames[index])
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
        /** @type {any} */
        let parsedJson = null

        // When decodeConnectPayload has already parsed a JSON view for this
        // frame, reuse that structure as a seed for JSONPath rules where it is
        // safe to do so (i.e. when no text rewrites have modified the payload).
        /** @type {Record<string, unknown> | null} */
        let seedJson = null
        if (decodedConnect && decodedConnect.envelope && Array.isArray(decodedConnect.frames)) {
          const decodedFrame = /** @type {CachedConnectFrame | undefined} */ (decodedConnect.frames[index])
          if (decodedFrame && typeof decodedFrame._rawProtobufJson === 'object') {
            seedJson = decodedFrame._rawProtobufJson
          }
        }

        // Step 1: apply legacy text-based edit rules (headers/inline text).
        /** @param {string} text */
        const textRewriter = text => textRules.applyEditRulesToText(text, jsonPathContext || {})

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
        const jsonPathResult = jsonPathRules.applyJsonPathRulesToProtobufBuffer(
          baseBuffer,
          initialJson,
          jsonPathContext || {}
        )

        const finalBufferUncompressed = jsonPathResult.changed ? jsonPathResult.buffer : baseBuffer

        // Recompress if needed for this frame. needsRecompress implies a codec
        // (decodeConnectPayload only decompresses with the same headers); the
        // cast keeps the original behaviour of letting a missing codec fail
        // into the catch below.
        try {
          outputBuffer = needsRecompress
            ? /** @type {CompressionCodec} */ (connectCodec).compress(finalBufferUncompressed)
            : finalBufferUncompressed
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

      const fallbackResult = textRules.applyEditRulesToBuffer(unaryBuffer, jsonPathContext || {})
      if (fallbackResult.changed) {
        /** @type {Buffer|null} */
        let updatedBuffer = fallbackResult.buffer

        if (unaryNeedsRecompress && connectCodec) {
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
   * Apply Connect/gRPC/protobuf-aware body rewrites and optionally decode a
   * structured logging view of the payload for the UI.
   *
   * This helper:
   * - optionally decodes a Connect payload into frames for logging when
   *   interactive mode is on and a log entry is provided;
   * - runs Connect-aware frame rewrites and JSONPath protobuf rewrites when
   *   edit/JSONPath rules are active;
   * - can fall back to plain text body rewrites when allowed and the content
   *   type looks textual;
   * - stores raw/preview/base64 fields on the provided logEntry.
   *
   * @param {LogEntry|null|undefined} logEntry - Mutable log entry object to enrich, or null.
   * @param {Buffer} buffer - Raw HTTP body buffer.
   * @param {Record<string, any>} headers - Mutable headers object for the HTTP message.
   * @param {ConnectRewriteOptions} [options]
   * @returns {{ buffer: Buffer, connect: DecodedConnectPayload | null }} Final body buffer and optional Connect view.
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
    const hasRulesForConnect = ruleStore.hasAnyEditOrJsonPathRules()

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

    /** @type {UrlMatchContext} */
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
    /** @type {RewrittenFrame[] | null} */
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
          attach(logEntry, connectRewriteResult.appliedRuleIds, role)
        }

        if (updateContentEncoding && Object.hasOwn(connectRewriteResult, 'encoding')) {
          if (connectRewriteResult.encoding) {
            headers['content-encoding'] = connectRewriteResult.encoding
          } else {
            delete headers['content-encoding']
          }
        }
      } else if (allowBodyRewriteFallback && ruleStore.hasCompiledTextRules()) {
        // Fallback to plain text rewrites only when the content-type suggests
        // textual payloads. This avoids unnecessary UTF-8 decoding and regex
        // work on clearly binary data.
        const contentType = getContentType(headers)

        if (isTextualContentType(contentType)) {
          // Same URL/phase context as the Connect and JSONPath paths, so that
          // URL-scoped and request/response-scoped text rules apply here too.
          const bodyRewriteResult = textRules.applyEditRulesToBuffer(workingBuffer, jsonPathContext)
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
                attach(logEntry, bodyRewriteResult.appliedRuleIds, isResponse ? 'response' : 'request')
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
          const previewRewrite = textRules.applyEditRulesToText(preview, jsonPathContext)
          if (previewRewrite.changed) {
            logEntry[previewField] = previewRewrite.text
            if (previewRewrite.appliedRuleIds?.length) {
              attach(logEntry, previewRewrite.appliedRuleIds, role)
            }
          } else {
            logEntry[previewField] = preview
          }
        }
      }
    }

    /** @type {DecodedConnectPayload | null} */
    let connect = null

    if (originalConnect && Array.isArray(originalConnect.frames) && originalConnect.frames.length > 0) {
      // Normalised "before" frames (decoded from the original payload).
      /** @type {ConnectFrame[]} */
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
   * @param {Record<string, any>} headers - Response headers object, mutated when encoding changes.
   * @param {{requestUrl?: string, fullUrl?: string}} [urlContext] - URL context for JSONPath rules.
   * @returns {{ buffer: Buffer }} Object containing the final response buffer.
   */
  function applyConnectRewritesForBypass (buffer, headers, urlContext) {
    if (isEmptyBuffer(buffer)) {
      return { buffer }
    }

    if (!ruleStore.hasAnyEditOrJsonPathRules()) {
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

  return {
    wantsInteractiveLogging,
    applyConnectFrameRewrites,
    applyConnectRewritesAndDecode,
    applyConnectRewritesForBypass
  }
}

module.exports = { createConnectRewriter }
