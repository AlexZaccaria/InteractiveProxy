'use strict'

/**
 * HTTP content codecs and content-type heuristics.
 *
 * - compression codecs (gzip, deflate, br, zstd) backed by Node's built-in
 *   zlib, with the guards used by the logging/preview paths;
 * - content-type classification (textual, binary, protobuf) shared by the
 *   rewrite and logging pipelines;
 * - case-insensitive header lookup with a per-object cache.
 */

const zlib = require('zlib')
const { LOG_DECOMPRESS_MAX_BYTES } = require('../../config')
const { logDebug, logWarn } = require('../util/logger')
const { safeString } = require('../util/strings')

/**
 * A plain object of HTTP headers as produced by Node or undici.
 *
 * @typedef {Record<string, string | string[] | number | undefined>} HeadersLike
 */

/**
 * @typedef {object} CompressionCodec
 * @property {(data: Buffer) => Buffer} decompress
 * @property {(data: Buffer) => Buffer} compress
 */

// Zstandard support comes from Node's built-in zlib (Node >= 22.15 / 23.8).
const ZSTD_SUPPORTED =
  typeof zlib.zstdCompressSync === 'function' &&
  typeof zlib.zstdDecompressSync === 'function'

if (!ZSTD_SUPPORTED) {
  logWarn('codecs', 'zstd is not supported by this Node.js version; zstd bodies will be forwarded untouched')
}

// Content types whose bodies are worth decompressing for inspection.
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

// Content types carrying protobuf payloads (Connect/gRPC included).
const PROTO_CONTENT_TYPES = [
  'application/proto',
  'application/grpc',
  'application/grpc+proto',
  'application/connect+proto'
]

// Cache for case-insensitive header lookups to avoid repeated full scans.
/** @type {WeakMap<object, { count: number, map: Record<string, string | number | undefined> }>} */
const headerLookupCache = new WeakMap()

/**
 * Look up a header by name regardless of its case. Array values yield their
 * first entry.
 *
 * @param {HeadersLike | null | undefined} headers
 * @param {string} name
 * @returns {string | number | undefined}
 */
function getHeaderCaseInsensitive (headers, name) {
  if (!headers || typeof headers !== 'object') return undefined
  const keys = Object.keys(headers)
  let cache = headerLookupCache.get(headers)

  // The cache is keyed by object identity; rebuild it when keys were added
  // or removed since it was built (header rewrites mutate the same object).
  if (!cache || cache.count !== keys.length) {
    /** @type {Record<string, string | number | undefined>} */
    const map = {}
    for (const key of keys) {
      const lower = key.toLowerCase()
      // Preserve the first occurrence for a given lower-cased key
      if (!Object.hasOwn(map, lower)) {
        const value = headers[key]
        map[lower] = Array.isArray(value) ? value[0] : value
      }
    }
    cache = { count: keys.length, map }
    headerLookupCache.set(headers, cache)
  }

  return cache.map[name.toLowerCase()]
}

/**
 * Get the Content-Type header value from a headers object.
 * Returns empty string if not found.
 *
 * @param {HeadersLike | null | undefined} headers
 * @returns {string}
 */
function getContentType (headers) {
  return String(getHeaderCaseInsensitive(headers, 'content-type') || '')
}

/**
 * Get the Content-Encoding header value from a headers object.
 * Returns empty string if not found.
 *
 * @param {HeadersLike | null | undefined} headers
 * @returns {string}
 */
function getContentEncoding (headers) {
  return String(getHeaderCaseInsensitive(headers, 'content-encoding') || '')
}

/**
 * Check if a content-type matches any pattern in a list.
 * Optimized to avoid creating intermediate arrays.
 *
 * @param {string | undefined} contentType
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

/**
 * @param {string | undefined} contentType
 * @returns {boolean}
 */
function shouldDecompress (contentType) {
  return contentTypeMatchesAny(contentType, DECOMPRESS_ALLOWED_TYPES)
}

/**
 * @param {string | undefined} contentType
 * @returns {boolean}
 */
function isProtoContentType (contentType = '') {
  return contentTypeMatchesAny(contentType, PROTO_CONTENT_TYPES)
}

/**
 * Check if a content-type indicates textual content suitable for text-based
 * rewrites and logging. This centralises the heuristic used by multiple
 * rewrite and logging paths.
 *
 * @param {string | undefined} contentType
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

/**
 * Determine whether a content-type is clearly binary and should never be
 * decoded as text for logging or Connect/HTTP previews.
 *
 * @param {string | undefined} contentType
 * @returns {boolean}
 */
function isClearlyBinaryContentType (contentType = '') {
  if (!contentType) return false
  const lower = contentType.toLowerCase()
  // SVG is XML text even though it is an image/* type.
  if (lower.includes('svg')) return false
  return (
    lower.includes('font/') ||
    lower.includes('woff') ||
    lower.includes('image/') ||
    lower.includes('video/') ||
    lower.includes('audio/') ||
    lower.includes('octet-stream')
  )
}

/**
 * Return the codec for a Content-Encoding value, or null when the encoding
 * is identity, unknown, or zstd on a Node without built-in support.
 *
 * @param {string} [encoding]
 * @returns {CompressionCodec | null}
 */
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
    if (!ZSTD_SUPPORTED) return null
    return {
      decompress: data => zlib.zstdDecompressSync(data),
      compress: data => zlib.zstdCompressSync(data)
    }
  }

  return null
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

/**
 * Decompression helper used only for logging/preview paths. It honours the
 * LOG_DECOMPRESS_MAX_BYTES safeguard so that we avoid fully decompressing
 * very large compressed bodies purely for UI previews.
 *
 * @param {Buffer} buffer
 * @param {string} encoding
 * @param {string} [contentType]
 * @returns {Buffer}
 */
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
 * @param {unknown} buffer
 * @returns {boolean}
 */
function isEmptyBuffer (buffer) {
  return !buffer || !Buffer.isBuffer(buffer) || buffer.length === 0
}

module.exports = {
  ZSTD_SUPPORTED,
  DECOMPRESS_ALLOWED_TYPES,
  PROTO_CONTENT_TYPES,
  getHeaderCaseInsensitive,
  getContentType,
  getContentEncoding,
  contentTypeMatchesAny,
  shouldDecompress,
  isProtoContentType,
  isTextualContentType,
  isClearlyBinaryContentType,
  getCompressionCodec,
  decompressData,
  decompressDataForLogging,
  isEmptyBuffer
}
