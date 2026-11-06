'use strict'

/**
 * Text previews and search snapshots for log entries.
 *
 * - size-bounded UTF-8 previews of body buffers (`bufferToTextPreview`,
 *   `applyLogPreviewLimit`);
 * - tolerant JSON parsing for previews and WebSocket frames, including the
 *   Socket.IO/Engine.IO prefixes and JSON embedded in string fields;
 * - lower-cased, size-limited search snapshots consumed by the log filters.
 */

const { LOG_PREVIEW_MAX_BYTES } = require('../../config')
const { logDebug } = require('../util/logger')

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

// Precompiled regex for bufferToTextPreview to avoid repeated compilation
// Control characters (minus tab/newline/carriage return) and U+FFFD, which
// is what invalid UTF-8 decodes to; every other code point, accented letters
// included, counts as printable.
const NON_PRINTABLE_REGEX = /(?![\x09\x0A\x0D])[\p{C}�]/gu
const ASCII_SEGMENT_REGEX = /[\x20-\x7E]{4,}/g

/**
 * Truncate a preview string to LOG_PREVIEW_MAX_BYTES characters, appending a
 * marker with the number of omitted characters.
 *
 * @param {string | null | undefined} text
 * @returns {string}
 */
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
 * Build a size-limited UTF-8 preview string from a Buffer for logging/search.
 *
 * The preview length is bounded using LOG_PREVIEW_MAX_BYTES so that very large
 * bodies do not require decoding the entire payload.
 *
 * @param {Buffer | null | undefined} buffer
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
 * @param {string | null | undefined} text
 * @returns {any} Parsed value, or null when no candidate parses.
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

  /** @type {any[]} */
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
 * @param {string | null | undefined} text
 * @returns {any} Parsed (and nested-JSON normalised) value, or null.
 */
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
 * Normalize a WebSocket payload into a Buffer, regardless of whether it
 * arrived as a Buffer, string or other binary-like value.
 *
 * @param {unknown} data
 * @returns {Buffer}
 */
function normalizeWebSocketPayload (data) {
  if (Buffer.isBuffer(data)) return data
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (data == null) return Buffer.alloc(0)
  return Buffer.from(/** @type {any} */ (data))
}

/**
 * Build a lower-cased search snapshot from a list of string parts, applying
 * a maximum size guard with early termination. Stops processing parts as soon
 * as the limit is reached to avoid unnecessary string operations.
 *
 * @param {unknown[] | null | undefined} parts Non-string entries are skipped.
 * @returns {string} lower-cased snapshot or an empty string
 */
function buildSearchSnapshot (parts) {
  if (!Array.isArray(parts) || parts.length === 0) return ''

  const maxBytes = Number.isFinite(SEARCH_SNAPSHOT_MAX_BYTES) && SEARCH_SNAPSHOT_MAX_BYTES > 0
    ? SEARCH_SNAPSHOT_MAX_BYTES
    : 0

  /** @type {string[]} */
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
 * @param {unknown} value
 * @returns {string} search snapshot or an empty string
 */
function buildJsonSearchSnapshot (value) {
  if (!value) return ''

  // Fast path for flat objects (common case: headers)
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = /** @type {Record<string, unknown>} */ (value)
    /** @type {string[]} */
    const parts = []
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue
      const v = record[key]
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

module.exports = {
  SEARCH_SNAPSHOT_MAX_BYTES,
  NON_PRINTABLE_REGEX,
  ASCII_SEGMENT_REGEX,
  applyLogPreviewLimit,
  bufferToTextPreview,
  tryParseJsonString,
  normalizeNestedJsonStrings,
  stripSocketIoPrefix,
  tryParseWebSocketJson,
  normalizeWebSocketPayload,
  buildSearchSnapshot,
  buildJsonSearchSnapshot
}
