'use strict'

/**
 * Connect/gRPC envelope codec and logging views.
 *
 * Recognises the 5-byte frame prefix (flags + big-endian length), splits a
 * body into frames, decompresses them with the codec named by the Connect
 * encoding headers, derives previews and JSON views per frame and rebuilds
 * an envelope from (possibly rewritten) frames. The rule application on
 * frames lives with the edit-rules engine.
 */

const { CONNECT_MAX_FRAMES, CONNECT_MAX_FRAME_BYTES } = require('../../config')
const { logDebug } = require('../util/logger')
const { safeString } = require('../util/strings')
const {
  isEmptyBuffer,
  getHeaderCaseInsensitive,
  getContentType,
  getContentEncoding,
  isProtoContentType,
  getCompressionCodec,
  decompressData
} = require('./compression')
const { extractJsonFromProtobufBuffer, stripTrivialBinaryBlobs } = require('./protobuf')
const { SEARCH_SNAPSHOT_MAX_BYTES, bufferToTextPreview, tryParseJsonString } = require('../logs/preview')

/** @typedef {import('./compression').HeadersLike} HeadersLike */

// Normalised Connect limits computed once at startup to avoid repeated
// ternaries and allocations on hot paths.
const CONNECT_MAX_FRAMES_LIMIT = CONNECT_MAX_FRAMES > 0
  ? CONNECT_MAX_FRAMES
  : Number.POSITIVE_INFINITY

const CONNECT_MAX_FRAME_BYTES_LIMIT = CONNECT_MAX_FRAME_BYTES > 0
  ? CONNECT_MAX_FRAME_BYTES
  : Number.POSITIVE_INFINITY

/**
 * One frame of a decoded Connect payload as kept on a log entry. Rewrite
 * paths may add `error` and the non-enumerable `_rawProtobufJson` /
 * `_decodedBuffer` properties.
 *
 * @typedef {object} ConnectFrame
 * @property {number} index
 * @property {number} length
 * @property {boolean} compressed
 * @property {boolean} endStream
 * @property {boolean} frameDecompressed
 * @property {string} preview
 * @property {any} json
 * @property {string | null} note
 * @property {string | null} [error]
 */

/**
 * Structured view of a Connect/gRPC body produced by decodeConnectPayload.
 * `originalFrames` is attached by the rewrite path to keep the pre-rewrite
 * frames next to the rewritten ones.
 *
 * @typedef {object} DecodedConnectPayload
 * @property {string} contentType
 * @property {boolean} envelope
 * @property {number} frameCount
 * @property {ConnectFrame[]} frames
 * @property {boolean} httpDecompressed
 * @property {string} httpEncoding
 * @property {string} rawBase64
 * @property {Buffer} [httpDecodedBuffer] Non-enumerable: HTTP-decompressed body.
 * @property {ConnectFrame[]} [originalFrames]
 */

/**
 * Input frame of rebuildConnectEnvelope: raw flags byte and frame bytes.
 *
 * @typedef {object} EnvelopeFrame
 * @property {number} [flags]
 * @property {Buffer} [data]
 */

/**
 * Frame as sent to the UI by buildConnectViewForClient.
 *
 * @typedef {object} ConnectFrameView
 * @property {number} index
 * @property {number} length
 * @property {boolean} compressed
 * @property {boolean} endStream
 * @property {boolean} frameDecompressed
 * @property {string} preview
 * @property {any} json
 * @property {string | null} note
 * @property {string | null} error
 */

/**
 * @typedef {object} ConnectClientView
 * @property {string | null} contentType
 * @property {boolean} envelope
 * @property {number} frameCount
 * @property {ConnectFrameView[]} frames
 * @property {ConnectFrameView[]} originalFrames
 */

/**
 * Extract the Connect/gRPC frame-level encoding header from an HTTP headers
 * object. Checks connect-content-encoding, connect-encoding, and grpc-encoding
 * in order.
 *
 * @param {HeadersLike | null | undefined} headers
 * @returns {string}
 */
function getConnectEncodingHeader (headers) {
  const value = (
    getHeaderCaseInsensitive(headers, 'connect-content-encoding') ||
    getHeaderCaseInsensitive(headers, 'connect-encoding') ||
    getHeaderCaseInsensitive(headers, 'grpc-encoding') ||
    ''
  )
  return typeof value === 'string' ? value : String(value)
}

/**
 * True when the buffer is a sequence of well-formed Connect frames (flags
 * byte with only the two low bits set, big-endian length, no trailing bytes).
 *
 * @param {Buffer | null | undefined} buffer
 * @returns {boolean}
 */
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
 * Serialise frames back into a Connect envelope (flags byte + big-endian
 * length + data for each frame).
 *
 * @param {Array<EnvelopeFrame | null | undefined>} [frames]
 * @returns {Buffer}
 */
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
 * @param {Buffer | null | undefined} buffer - Raw HTTP body buffer.
 * @param {HeadersLike} [headers] - HTTP headers associated with the body.
 * @returns {DecodedConnectPayload | null} Decoded Connect payload suitable for
 * logging, or null if the payload is not recognised as Connect/gRPC.
 */
function decodeConnectPayload (buffer, headers = {}) {
  if (isEmptyBuffer(buffer)) return null
  // isEmptyBuffer is not a type guard: past it, buffer is a non-empty Buffer.
  // The self-assignment only narrows the type for the checker.
  // eslint-disable-next-line no-self-assign
  buffer = /** @type {Buffer} */ (buffer)

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

  /** @type {ConnectFrame[]} */
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

      /** @type {Buffer} */
      let framePayload = frameData
      let frameDecompressed = false
      let preview = ''
      /** @type {any} */
      let json = null
      /** @type {string | null} */
      let note = null
      /** @type {Record<string, unknown> | null} */
      let rawProtobufJson = null

      if (withinFrameLimit && withinSizeLimit) {
        if (isCompressed && connectCodec) {
          try {
            framePayload = connectCodec.decompress(frameData)
            frameDecompressed = true
          } catch (error) {
            framePayload = frameData
            frameDecompressed = false
            note = 'compressed frame: decompression failed, payload left encoded'
          }
        } else if (isCompressed) {
          note = 'compressed frame: no connect-content-encoding/grpc-encoding header, payload left encoded'
        }

        // A frame that is still compressed has no readable preview or JSON.
        if (!isCompressed || frameDecompressed) {
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
    /** @type {any} */
    let json = null
    /** @type {string | null} */
    let note = null
    /** @type {Record<string, unknown> | null} */
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

  /** @type {DecodedConnectPayload} */
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
 * Count frames in a Connect/gRPC payload structure.
 *
 * @param {{ frameCount?: unknown, frames?: unknown } | null | undefined} connect
 * @returns {number}
 */
function countConnectFrames (connect) {
  if (!connect || typeof connect !== 'object') return 0
  if (typeof connect.frameCount === 'number') return connect.frameCount
  if (Array.isArray(connect.frames)) return connect.frames.length
  return 0
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
 * @param {{ frames?: unknown, originalFrames?: unknown } | null | undefined} connectData
 * @returns {string}
 */
function buildConnectSearchContentForLog (connectData) {
  if (!connectData || typeof connectData !== 'object') return ''

  const maxBytes = Number.isFinite(SEARCH_SNAPSHOT_MAX_BYTES) && SEARCH_SNAPSHOT_MAX_BYTES > 0
    ? SEARCH_SNAPSHOT_MAX_BYTES
    : 0

  /** @type {string[]} */
  const parts = []
  let totalLength = 0
  let truncated = false

  /** @param {unknown} value */
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

  /** @param {unknown} frames */
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

/**
 * Reduce a decoded Connect payload (frames and original frames) to the
 * fields the UI renders.
 *
 * @param {Partial<DecodedConnectPayload> | null | undefined} connectData
 * @returns {ConnectClientView | null}
 */
function buildConnectViewForClient (connectData) {
  if (!connectData || typeof connectData !== 'object') return null

  /**
   * @param {unknown} frames
   * @returns {ConnectFrameView[]}
   */
  const mapFrames = (frames) => {
    if (!Array.isArray(frames)) return []
    return /** @type {ConnectFrameView[]} */ (frames
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
      .filter(Boolean))
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

module.exports = {
  CONNECT_MAX_FRAMES_LIMIT,
  CONNECT_MAX_FRAME_BYTES_LIMIT,
  getConnectEncodingHeader,
  looksLikeConnectEnvelope,
  rebuildConnectEnvelope,
  decodeConnectPayload,
  countConnectFrames,
  buildConnectSearchContentForLog,
  buildConnectViewForClient
}
