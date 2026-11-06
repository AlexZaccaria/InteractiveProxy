'use strict'

/**
 * Schema-less protobuf codec.
 *
 * Parses wire-format messages into their fields, re-encodes them, rewrites
 * printable text segments in place and derives a lightweight JSON view
 * (`f1`, `f2`, ... keys) used by JSONPath rules and by the UI. Field and size
 * limits come from the configuration and bound the work done on large
 * payloads.
 */

const { PROTOBUF_MAX_FIELDS, PROTOBUF_MAX_BYTES } = require('../../config')
const { logDebug } = require('../util/logger')
const { isEmptyBuffer } = require('./compression')

// Normalised limits computed once at startup to avoid repeated ternaries and
// allocations on hot paths.
const PROTOBUF_MAX_FIELDS_LIMIT = PROTOBUF_MAX_FIELDS > 0
  ? PROTOBUF_MAX_FIELDS
  : Number.POSITIVE_INFINITY

const PROTOBUF_MAX_BYTES_LIMIT = PROTOBUF_MAX_BYTES > 0
  ? PROTOBUF_MAX_BYTES
  : Number.POSITIVE_INFINITY

/**
 * A parsed field with its raw bytes, as returned by parseMessageDetailed.
 *
 * @typedef {object} DetailedField
 * @property {number} fieldNumber
 * @property {number} wireType
 * @property {number | null} value Varint value (wire type 0).
 * @property {Buffer | null} data Payload of length-delimited and fixed fields.
 * @property {Buffer | null} raw The field exactly as it appears on the wire.
 */

/**
 * A field in the simplified representation used by parseProtobuf and the
 * encoders.
 *
 * @typedef {object} ProtobufField
 * @property {number} fieldNumber
 * @property {number} wireType
 * @property {number | null} [value]
 * @property {Buffer | null} [data]
 */

/**
 * @typedef {object} TextRewriteResult
 * @property {string} text
 * @property {boolean} changed
 * @property {string[]} [appliedRuleIds]
 */

/**
 * @typedef {(text: string) => TextRewriteResult} TextRewriter
 */

/**
 * @typedef {object} BufferRewriteResult
 * @property {Buffer} buffer
 * @property {string[]} appliedRuleIds
 * @property {boolean} changed
 */

/**
 * Read a varint starting at `offset`.
 *
 * Accumulates with multiplication instead of 32-bit shifts so that int64
 * values (timestamps, ids) are read correctly; exact up to 2^53.
 *
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {{ value: number, length: number }}
 */
function readVarint (buffer, offset) {
  let result = 0
  let multiplier = 1
  let length = 0

  while (offset < buffer.length && length < 10) {
    const byte = buffer[offset++]
    result += (byte & 0x7F) * multiplier
    length++
    if ((byte & 0x80) === 0) {
      return { value: result, length }
    }
    multiplier *= 128
  }

  throw new Error('Invalid varint encoding')
}

/**
 * Parse a message into its fields, keeping the raw bytes of each one.
 *
 * @param {Buffer} buffer
 * @returns {{ fields: DetailedField[] }}
 */
function parseMessageDetailed (buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('Expected Buffer')
  }

  /** @type {DetailedField[]} */
  const fields = []
  let offset = 0
  const len = buffer.length

  while (offset < len) {
    const start = offset
    const keyInfo = readVarint(buffer, offset)
    const key = keyInfo.value
    const keyLen = keyInfo.length
    offset += keyLen

    const fieldNumber = key >>> 3
    const wireType = key & 0x07
    if (fieldNumber <= 0) {
      throw new Error('Invalid field number')
    }

    /** @type {DetailedField} */
    const field = {
      fieldNumber,
      wireType,
      value: null,
      data: null,
      raw: null
    }

    if (wireType === 0) {
      const vInfo = readVarint(buffer, offset)
      field.value = vInfo.value
      offset += vInfo.length
    } else if (wireType === 1) {
      if (offset + 8 > len) {
        throw new Error('Truncated 64-bit field')
      }
      field.data = buffer.slice(offset, offset + 8)
      offset += 8
    } else if (wireType === 2) {
      const lInfo = readVarint(buffer, offset)
      const n = lInfo.value >>> 0
      offset += lInfo.length
      if (offset + n > len) {
        throw new Error('Truncated length-delimited field')
      }
      field.data = buffer.slice(offset, offset + n)
      offset += n
    } else if (wireType === 5) {
      if (offset + 4 > len) {
        throw new Error('Truncated 32-bit field')
      }
      field.data = buffer.slice(offset, offset + 4)
      offset += 4
    } else {
      throw new Error('Unsupported wire type ' + wireType)
    }

    field.raw = buffer.slice(start, offset)
    fields.push(field)
  }

  return { fields }
}

/**
 * Parse a message into the simplified field representation (no raw bytes).
 *
 * @param {Buffer} buffer
 * @returns {{ fields: ProtobufField[] }}
 */
function parseProtobuf (buffer) {
  const { fields } = parseMessageDetailed(buffer)
  return {
    fields: fields.map(field => ({
      fieldNumber: field.fieldNumber,
      wireType: field.wireType,
      value: field.value,
      data: field.data
    }))
  }
}

/**
 * Encode a varint of any width. Negative numbers become their 64-bit two's
 * complement (10 bytes), as protobuf encodes negative int32/int64 values.
 *
 * @param {number | bigint} value
 * @returns {Buffer}
 */
function encodeVarint32 (value) {
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0))
  v = BigInt.asUintN(64, v)
  const bytes = []
  while (v > 127n) {
    bytes.push(Number(v & 0x7Fn) | 0x80)
    v >>= 7n
  }
  bytes.push(Number(v))
  return Buffer.from(bytes)
}

/**
 * Encode a protobuf key (field number + wire type) as a varint.
 *
 * @param {number} fieldNumber
 * @param {number} wireType
 * @returns {Buffer}
 */
function encodeProtobufKey (fieldNumber, wireType) {
  if (!Number.isInteger(fieldNumber) || fieldNumber <= 0) {
    throw new Error('Invalid field number')
  }
  return encodeVarint32((fieldNumber << 3) | (wireType & 0x07))
}

/**
 * Encode a length-delimited field (wire type 2).
 *
 * @param {number} fieldNumber
 * @param {Buffer} dataBuffer
 * @returns {Buffer}
 */
function encodeLengthDelimitedField (fieldNumber, dataBuffer) {
  const key = encodeProtobufKey(fieldNumber, 2)
  const lenBuf = encodeVarint32(dataBuffer.length >>> 0)
  return Buffer.concat([key, lenBuf, dataBuffer])
}

/**
 * Ratio of ASCII-printable bytes (plus tab, LF, CR) in a buffer.
 *
 * @param {Buffer | null | undefined} buffer
 * @returns {number}
 */
function printableRatio (buffer) {
  if (!buffer || buffer.length === 0) return 0
  let printable = 0
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i]
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) {
      printable++
    }
  }
  return printable / buffer.length
}

/**
 * Recursively rewrite printable text segments inside a protobuf message using
 * the provided textRewriter. Size/field limits are enforced via the
 * PROTOBUF_MAX_*_LIMIT constants to keep CPU usage bounded on large payloads.
 *
 * @param {Buffer} buffer - Raw protobuf message buffer.
 * @param {TextRewriter} textRewriter
 * @param {number} depth - Current recursion depth.
 * @param {number} maxDepth - Maximum allowed recursion depth.
 * @returns {BufferRewriteResult}
 */
function rewriteMessage (buffer, textRewriter, depth, maxDepth) {
  const maxFields = PROTOBUF_MAX_FIELDS_LIMIT
  const maxBytes = PROTOBUF_MAX_BYTES_LIMIT

  if (buffer && Buffer.isBuffer(buffer) && buffer.length > maxBytes) {
    return {
      buffer,
      appliedRuleIds: [],
      changed: false
    }
  }

  const { fields } = parseMessageDetailed(buffer)
  /** @type {Buffer[]} */
  const chunks = []
  /** @type {Set<string>} */
  const applied = new Set()
  let changed = false

  // Split fields into processable and passthrough to avoid per-iteration limit check
  const fieldsToProcess = fields.slice(0, maxFields)
  const fieldsToPassthrough = fields.slice(maxFields)

  for (const field of fieldsToProcess) {
    let fieldBuffer = /** @type {Buffer} */ (field.raw)
    let fieldChanged = false

    if (field.wireType === 2 && Buffer.isBuffer(field.data) && field.data.length > 0) {
      let newData = field.data

      if (depth < maxDepth) {
        try {
          const nested = rewriteMessage(field.data, textRewriter, depth + 1, maxDepth)
          if (nested.changed && Buffer.isBuffer(nested.buffer)) {
            newData = nested.buffer
            fieldChanged = true
            nested.appliedRuleIds.forEach(id => applied.add(id))
          }
        } catch (error) {
          logDebug('rewriteMessage', 'Failed to rewrite nested protobuf field', error)
        }
      }

      if (!fieldChanged) {
        const ratio = printableRatio(field.data)
        if (ratio >= 0.7) {
          /** @type {string | null} */
          let text = null
          try {
            text = field.data.toString('utf8')
          } catch (error) {
            text = null
          }
          if (text && text.length > 0) {
            const result = textRewriter(text)
            if (result && result.changed && typeof result.text === 'string') {
              newData = Buffer.from(result.text, 'utf8')
              fieldChanged = true
              if (Array.isArray(result.appliedRuleIds)) {
                for (const id of result.appliedRuleIds) {
                  if (id) applied.add(id)
                }
              }
            }
          }
        }
      }

      if (fieldChanged) {
        fieldBuffer = encodeLengthDelimitedField(field.fieldNumber, newData)
      }
    }

    if (fieldChanged) {
      changed = true
    }

    chunks.push(fieldBuffer)
  }

  // Passthrough fields beyond the limit without processing
  for (const field of fieldsToPassthrough) {
    chunks.push(/** @type {Buffer} */ (field.raw))
  }

  if (!changed) {
    return {
      buffer,
      appliedRuleIds: [],
      changed: false
    }
  }

  const outBuffer = Buffer.concat(chunks)
  return {
    buffer: outBuffer,
    appliedRuleIds: Array.from(applied),
    changed: true
  }
}

/**
 * Rewrite text fields of a message (nested messages up to 4 levels deep),
 * returning the original buffer untouched on any parse failure.
 *
 * @param {Buffer} buffer
 * @param {TextRewriter} textRewriter
 * @returns {BufferRewriteResult}
 */
function rewriteProtobufFields (buffer, textRewriter) {
  if (!Buffer.isBuffer(buffer) || typeof textRewriter !== 'function') {
    return { buffer, appliedRuleIds: [], changed: false }
  }

  try {
    const result = rewriteMessage(buffer, textRewriter, 0, 4)
    if (!result || !Buffer.isBuffer(result.buffer)) {
      return { buffer, appliedRuleIds: [], changed: false }
    }
    return {
      buffer: result.buffer,
      appliedRuleIds: result.appliedRuleIds || [],
      changed: !!result.changed
    }
  } catch (error) {
    logDebug('rewriteProtobufFields', 'Failed to rewrite protobuf fields', error)
    return { buffer, appliedRuleIds: [], changed: false }
  }
}

/**
 * Re-encode a protobuf message from the simplified field representation
 * returned by parseProtobuf.
 *
 * @param {ProtobufField[]} fields
 * @returns {Buffer}
 */
function encodeProtobufFromFields (fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return Buffer.alloc(0)
  }

  /** @type {Buffer[]} */
  const chunks = []

  for (const field of fields) {
    if (!field || typeof field.fieldNumber !== 'number' || typeof field.wireType !== 'number') {
      continue
    }

    const fieldNumber = field.fieldNumber
    const wireType = field.wireType

    try {
      chunks.push(encodeProtobufKey(fieldNumber, wireType))
    } catch {
      continue
    }

    if (wireType === 0) {
      // Varint
      const value = typeof field.value === 'number' ? field.value : 0
      chunks.push(encodeVarint32(value))
    } else if (wireType === 2) {
      // Length-delimited
      const data = Buffer.isBuffer(field.data) ? field.data : Buffer.alloc(0)
      const lenBuf = encodeVarint32(data.length >>> 0)
      chunks.push(lenBuf, data)
    } else if (wireType === 1 || wireType === 5) {
      // Fixed 64/32-bit
      const data = Buffer.isBuffer(field.data)
        ? field.data
        : Buffer.alloc(wireType === 1 ? 8 : 4)
      chunks.push(data)
    } else {
      // Unsupported wire type; drop the field entirely.
      chunks.pop()
      continue
    }
  }

  return Buffer.concat(chunks)
}

/**
 * Heuristically re-encode a JSON object back into a Protobuf buffer.
 *
 * This is the inverse of extractJsonFromProtobufBuffer and supports:
 * - Nested messages (keys like "f1", "f2"...)
 * - JSON strings (non-protobuf objects encoded as JSON)
 * - Varints (numbers/booleans)
 * - Top-level strings
 *
 * @param {unknown} json - The JSON object to encode.
 * @returns {Buffer} - The encoded Protobuf message.
 */
function encodeJsonToProtobuf (json) {
  if (!json || typeof json !== 'object') {
    return Buffer.alloc(0)
  }

  /** @type {ProtobufField[]} */
  const fields = []

  /**
   * Check if an object looks like a Protobuf message (keys are f1, f2...).
   *
   * @param {unknown} obj
   * @returns {boolean}
   */
  const isProtobufObject = (obj) => {
    if (!obj || typeof obj !== 'object') return false
    const keys = Object.keys(obj)
    if (keys.length === 0) return false
    return keys.every(k => /^f\d+$/.test(k))
  }

  // Preserve field order from extraction (JavaScript objects maintain insertion order)
  for (const [key, val] of Object.entries(json)) {
    if (!/^f\d+$/.test(key)) continue
    const fieldNumber = parseInt(key.slice(1), 10)
    if (isNaN(fieldNumber) || fieldNumber <= 0) continue

    const values = Array.isArray(val) ? val : [val]

    for (const value of values) {
      if (value === null || value === undefined) continue

      if (typeof value === 'number') {
        // Assume Varint (WireType 0)
        fields.push({ fieldNumber, wireType: 0, value })
      } else if (typeof value === 'boolean') {
        // Varint (WireType 0)
        fields.push({ fieldNumber, wireType: 0, value: value ? 1 : 0 })
      } else if (typeof value === 'string') {
        // String (WireType 2)
        fields.push({ fieldNumber, wireType: 2, data: Buffer.from(value, 'utf8') })
      } else if (typeof value === 'object') {
        // Complex object: either nested message, JSON-stringified object, or special blob
        if (value.bytesHex && typeof value.bytesHex === 'string') {
          // Fixed 32/64 handling (from extractJson heuristic)
          try {
            const buf = Buffer.from(value.bytesHex, 'hex')
            const wireType = buf.length === 8 ? 1 : 5
            fields.push({ fieldNumber, wireType, data: buf })
          } catch {
            // Ignore invalid hex
          }
        } else if (value.base64 && typeof value.base64 === 'string') {
          // Fallback blob
          try {
            fields.push({ fieldNumber, wireType: 2, data: Buffer.from(value.base64, 'base64') })
          } catch {
            // Ignore invalid base64
          }
        } else {
          // Heuristic: Nested Message vs JSON String
          if (isProtobufObject(value)) {
            // Recursively encode as nested message
            const nestedBuf = encodeJsonToProtobuf(value)
            fields.push({ fieldNumber, wireType: 2, data: nestedBuf })
          } else {
            // Encode as JSON string
            const jsonStr = JSON.stringify(value)
            fields.push({ fieldNumber, wireType: 2, data: Buffer.from(jsonStr, 'utf8') })
          }
        }
      }
    }
  }

  return encodeProtobufFromFields(fields)
}

/**
 * Extract a lightweight JSON view from a protobuf message buffer: keys are
 * `f<fieldNumber>`, repeated fields become arrays, nested messages are
 * recursed into, printable payloads become strings (or parsed JSON), the rest
 * becomes `{ base64, length }` or `{ bytesHex, length }` blobs.
 *
 * This helper is used by rewrite paths and therefore must preserve the
 * existing structure so that JSONPath rules continue to behave identically.
 *
 * @param {Buffer | null | undefined} buffer - Protobuf message buffer for a single Connect frame.
 * @returns {Record<string, unknown> | null} Lightweight JSON view of the message, or null when the
 * payload cannot be safely represented.
 */
function extractJsonFromProtobufBuffer (buffer) {
  if (isEmptyBuffer(buffer) || !buffer) return null
  if (buffer.length > PROTOBUF_MAX_BYTES_LIMIT) return null

  let root
  try {
    root = parseProtobuf(buffer)
  } catch {
    return null
  }

  if (!root || !Array.isArray(root.fields) || root.fields.length === 0) return null

  const maxFields = PROTOBUF_MAX_FIELDS_LIMIT
  let processedFields = 0

  /**
   * @param {ProtobufField[]} fields
   * @param {number} [depth]
   * @returns {Record<string, unknown> | null}
   */
  const toJsonFromFields = (fields, depth = 0) => {
    if (!fields || !fields.length) return null

    /** @type {Map<number, unknown[]>} */
    const bucket = new Map()

    /**
     * @param {number} fieldNumber
     * @param {unknown} value
     */
    const pushValue = (fieldNumber, value) => {
      if (value === null || value === undefined) return
      const existing = bucket.get(fieldNumber)
      if (existing) {
        existing.push(value)
      } else {
        bucket.set(fieldNumber, [value])
      }
    }

    for (const field of fields) {
      if (processedFields >= maxFields) break
      processedFields++
      if (!field || typeof field.fieldNumber !== 'number') continue

      /** @type {unknown} */
      let value = null

      if (field.wireType === 0) {
        // Varint
        if (typeof field.value === 'number') {
          value = field.value
        }
      } else if (field.wireType === 2 && Buffer.isBuffer(field.data)) {
        // Length-delimited: try nested message first
        let handled = false
        try {
          const nested = parseProtobuf(field.data)
          if (nested && Array.isArray(nested.fields) && nested.fields.length) {
            const nestedJson = toJsonFromFields(nested.fields, depth + 1)
            // Only accept as nested protobuf if result has protobuf-style keys (f1, f2, etc.)
            if (nestedJson && Object.keys(nestedJson).length > 0) {
              const keys = Object.keys(nestedJson)
              const hasProtobufKeys = keys.some(k => /^f\d+$/.test(k))
              if (hasProtobufKeys) {
                value = nestedJson
                handled = true
              }
            }
          }
        } catch {}

        if (!handled) {
          try {
            const text = field.data.toString('utf8')
            if (text && text.trim()) {
              const printableMatches = text.match(/[\x20-\x7E\n\r\t]/g) || []
              const printableRatio = printableMatches.length / text.length

              if (printableRatio >= 0.5) {
                // Try to parse as JSON for richer JSONPath access.
                // If parsing fails, keep as plain text.
                const trimmedText = text.trim()
                /** @type {unknown} */
                let json = null
                try {
                  json = JSON.parse(trimmedText)
                } catch {
                  // Not valid JSON - preserve as text
                }
                value = json !== null ? json : trimmedText
                handled = true
              }
            }
          } catch {}
        }

        if (!handled) {
          const length = field.data.length
          if (length > 0) {
            value = {
              base64: field.data.toString('base64'),
              length
            }
          } else {
            // Preserve zero-length strings as empty strings to maintain structure.
            // Without this, text rules that empty a field would cause the field
            // to be dropped entirely during JSON extraction -> re-encoding cycle.
            value = ''
          }
        }
      } else if ((field.wireType === 1 || field.wireType === 5) && Buffer.isBuffer(field.data)) {
        // Fixed 32/64-bit: expose as hex blob (skip empty buffers)
        const length = field.data.length
        if (length > 0) {
          value = {
            bytesHex: field.data.toString('hex'),
            length
          }
        }
      }

      if (value !== null) {
        pushValue(field.fieldNumber, value)
      }
    }

    /** @type {Record<string, unknown>} */
    const result = {}
    for (const [fieldNumber, values] of bucket.entries()) {
      const key = `f${fieldNumber}`
      result[key] = values.length === 1 ? values[0] : values
    }

    return Object.keys(result).length > 0 ? result : null
  }

  return toJsonFromFields(root.fields, 0)
}

/**
 * Walk a JSON tree produced by extractJsonFromProtobufBuffer and remove
 * trivial binary blobs that only carry empty data, such as
 * { base64: "", length: 0 }.
 *
 * The function preserves the overall shape of the object while pruning
 * obviously useless placeholders from arrays and objects. This is intended
 * for logging/search views only; rewrite paths should continue to use the
 * raw extractJsonFromProtobufBuffer output so JSONPath rules see the full
 * structure.
 *
 * @param {any} value - Arbitrary JSON value to clean.
 * @returns {any} Cleaned JSON value with trivial blobs removed.
 */
function stripTrivialBinaryBlobs (value) {
  if (value === null || value === undefined) return value

  if (Array.isArray(value)) {
    const next = []
    for (const item of value) {
      const cleaned = stripTrivialBinaryBlobs(item)
      if (cleaned !== undefined) {
        next.push(cleaned)
      }
    }
    return next
  }

  if (typeof value !== 'object') {
    return value
  }

  const keys = Object.keys(value)

  // Detect the canonical { base64, length } blob representation produced by
  // extractJsonFromProtobufBuffer and drop it completely when it carries no
  // actual data. This keeps logging views compact for empty binary fields.
  if (keys.length === 2 && keys.includes('base64') && keys.includes('length')) {
    const base64 = value.base64
    const length = value.length

    if ((base64 === '' || base64 === null || base64 === undefined) &&
        typeof length === 'number' &&
        length === 0) {
      // Returning undefined here signals to the caller that this node should
      // be removed from its parent container.
      return undefined
    }
  }

  /** @type {Record<string, any>} */
  const result = {}
  for (const key of keys) {
    const cleaned = stripTrivialBinaryBlobs(value[key])
    if (cleaned !== undefined) {
      result[key] = cleaned
    }
  }

  return result
}

module.exports = {
  PROTOBUF_MAX_FIELDS_LIMIT,
  PROTOBUF_MAX_BYTES_LIMIT,
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
}
