'use strict'

/**
 * JSONPath edit rules applied to JSON objects and to single Protobuf messages
 * (decoded to a JSON view, rewritten, re-encoded).
 *
 * `createJsonPathRewriter(store)` returns functions closing over a rule
 * store: the compiled JSONPath rules (always URL-scoped) come from it, as does
 * the storage directory used to resolve file-backed rule values.
 */

const { isEmptyBuffer } = require('../codecs/compression')
const { extractJsonFromProtobufBuffer, encodeJsonToProtobuf } = require('../codecs/protobuf')
const { normalizeNestedJsonStrings } = require('../logs/preview')
const { buildUrlMatchContext, jsonPathRuleMatchesUrl } = require('./url-match')
const { resolveJsonPathValueFromSource, coerceJsonPathScalarFromText } = require('./schema')

/** @typedef {import('./store').RuleStore} RuleStore */
/** @typedef {import('./url-match').UrlMatchContext} UrlMatchContext */

/**
 * @typedef {object} JsonPathObjectResult
 * @property {any} object The (mutated) root.
 * @property {string[]} appliedRuleIds
 * @property {boolean} changed
 */

/**
 * @typedef {object} JsonPathBufferResult
 * @property {Buffer} buffer
 * @property {any} json
 * @property {string[]} appliedRuleIds
 * @property {boolean} changed
 */

/**
 * Create the JSONPath rewriter bound to a rule store.
 *
 * @param {RuleStore} store
 */
function createJsonPathRewriter(store) {
  /**
   * Apply the JSONPath rules matching the context to an object, in place.
   *
   * @param {any} root
   * @param {UrlMatchContext} [context]
   * @returns {JsonPathObjectResult}
   */
  function applyJsonPathRulesToObject(root, context = {}) {
    if (!root || typeof root !== 'object') {
      return { object: root, appliedRuleIds: [], changed: false }
    }

    const rules = store.getCompiledJsonPathRules()
    if (!Array.isArray(rules) || rules.length === 0) {
      return { object: root, appliedRuleIds: [], changed: false }
    }

    const baseContext = context && typeof context === 'object' ? context : {}
    const matchContext = baseContext.candidates ? baseContext : buildUrlMatchContext(baseContext)

    const phase = matchContext && matchContext.phase === 'response' ? 'response' : 'request'

    /** @type {Set<string>} */
    const appliedSet = new Set()
    let changed = false

    for (const rule of rules) {
      if (!rule || !Array.isArray(rule.segments) || rule.segments.length === 0) continue

      const target = rule.target === 'response' || rule.target === 'both' ? rule.target : 'request'

      if (target === 'request' && phase !== 'request') continue
      if (target === 'response' && phase !== 'response') continue

      // Le regole jsonPath vengono applicate solo se l'URL corrente matcha il
      // pattern associato alla regola.
      if (!jsonPathRuleMatchesUrl(rule, matchContext)) continue

      let effectiveValue = rule.value
      /** @type {string} */
      let effectiveValueType = rule.valueType
      if (rule.valueSource && rule.valueSource.type === 'file') {
        const fileText = resolveJsonPathValueFromSource(rule.valueSource, store.storageDir)
        if (fileText === null) continue
        const coerced = coerceJsonPathScalarFromText(fileText)
        effectiveValue = coerced.value
        effectiveValueType = coerced.valueType
      }

      const segments = rule.segments
      /** @type {any} */
      let parent = root
      let validPath = true

      // Traverse all but the last segment to find the parent container
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i]
        if (!parent || typeof parent !== 'object') {
          validPath = false
          break
        }

        if (seg.type === 'key') {
          if (!Object.hasOwn(parent, seg.key)) {
            validPath = false
            break
          }
          parent = parent[seg.key]
        } else if (seg.type === 'index') {
          if (!Array.isArray(parent)) {
            validPath = false
            break
          }
          const idx = seg.index
          if (idx < 0 || idx >= parent.length) {
            validPath = false
            break
          }
          parent = parent[idx]
        } else if (seg.type === 'filter') {
          // Filter segment: find the first array element where element[key] === value
          if (!Array.isArray(parent)) {
            validPath = false
            break
          }
          const found = parent.find(
            item => item && typeof item === 'object' && item[seg.key] === seg.value
          )
          if (!found) {
            validPath = false
            break
          }
          parent = found
        } else {
          validPath = false
          break
        }
      }

      if (!validPath) continue

      const lastSeg = segments[segments.length - 1]
      /** @type {any} */
      const container = parent
      /** @type {string|number} */
      let keyOrIndex
      /** @type {any} */
      let currentValue

      if (lastSeg.type === 'key') {
        if (!container || typeof container !== 'object' || !Object.hasOwn(container, lastSeg.key)) {
          continue
        }
        keyOrIndex = lastSeg.key
        currentValue = container[lastSeg.key]
      } else if (lastSeg.type === 'index') {
        if (!Array.isArray(container)) continue
        const idx = lastSeg.index
        if (idx < 0 || idx >= container.length) continue
        keyOrIndex = idx
        currentValue = container[idx]
      } else if (lastSeg.type === 'filter') {
        // Filter as last segment: find the matching element in the array and replace it
        if (!Array.isArray(container)) continue
        const foundIndex = container.findIndex(
          item => item && typeof item === 'object' && item[lastSeg.key] === lastSeg.value
        )
        if (foundIndex === -1) continue
        keyOrIndex = foundIndex
        currentValue = container[foundIndex]
      } else {
        continue
      }

      // Compute the new value based on valueType
      /** @type {any} */
      let newValue
      if (effectiveValueType === 'number') {
        if (typeof effectiveValue === 'number') {
          newValue = effectiveValue
        } else if (typeof effectiveValue === 'string') {
          const parsed = Number(effectiveValue.trim())
          if (!Number.isFinite(parsed)) continue
          newValue = parsed
        } else {
          continue
        }
      } else if (effectiveValueType === 'boolean') {
        if (typeof effectiveValue === 'boolean') {
          newValue = effectiveValue
        } else if (typeof effectiveValue === 'string') {
          const lower = effectiveValue.trim().toLowerCase()
          if (lower === 'true') newValue = true
          else if (lower === 'false') newValue = false
          else continue
        } else {
          continue
        }
      } else if (effectiveValueType === 'null') {
        newValue = null
      } else if (effectiveValueType === 'json') {
        // Explicit JSON value type: treat the rule value as JSON and replace the
        // target with the parsed object/array. This is primarily for advanced
        // callers using the HTTP API directly.
        if (effectiveValue && typeof effectiveValue === 'object') {
          // Insert a copy: the rule's own value must never be reachable from a
          // body or a log view, which are mutated and normalised later.
          newValue = structuredClone(effectiveValue)
        } else if (typeof effectiveValue === 'string') {
          try {
            newValue = JSON.parse(effectiveValue)
          } catch {
            // Invalid JSON payload for this rule; skip instead of inserting a
            // malformed value into the object tree.
            continue
          }
        } else {
          // Unsupported representation for a JSON value; ignore the rule.
          continue
        }
      } else {
        // Default branch: treat the rule value as a string, but when the current
        // JSON value at the target path is an object/array we optimistically
        // attempt to parse the rule value as JSON so that whole objects can be
        // replaced even when the UI only exposes a "string" value type.
        if (
          currentValue &&
          typeof currentValue === 'object' &&
          typeof effectiveValue === 'string'
        ) {
          const text = effectiveValue.trim()
          if (text) {
            try {
              newValue = JSON.parse(text)
            } catch {
              // If parsing fails, fall back to the raw string representation.
              newValue = effectiveValue
            }
          } else {
            newValue = effectiveValue
          }
        } else {
          newValue = effectiveValue != null ? String(effectiveValue) : ''
        }
      }

      const isSame =
        newValue === currentValue ||
        (typeof newValue === 'number' &&
          Number.isNaN(newValue) &&
          typeof currentValue === 'number' &&
          Number.isNaN(currentValue))

      if (isSame) continue

      container[keyOrIndex] = newValue
      changed = true
      if (rule.id) {
        appliedSet.add(rule.id)
      }
    }

    return {
      object: root,
      appliedRuleIds: Array.from(appliedSet),
      changed
    }
  }

  /**
   * Apply JSONPath rules directly to a protobuf message buffer when possible.
   *
   * The helper:
   * - quickly checks whether there are any JSONPath rules that could match the
   *   current URL context before attempting protobuf/JSON decoding;
   * - extracts a lightweight JSON view from the protobuf buffer only when such
   *   rules are present;
   * - re-encodes the protobuf message when top-level string fields are changed.
   *
   * This keeps behaviour identical while avoiding expensive protobuf parsing
   * when no JSONPath rules are applicable to the current Connect payload.
   *
   * @param {Buffer} buffer - Protobuf message buffer for a single Connect frame.
   * @param {any} initialJson - Optional pre-extracted JSON view.
   * @param {UrlMatchContext} [context] - URL/phase context used for JSONPath rule matching.
   * @returns {JsonPathBufferResult}
   */
  function applyJsonPathRulesToProtobufBuffer(buffer, initialJson, context = {}) {
    if (isEmptyBuffer(buffer)) {
      return { buffer, json: initialJson, appliedRuleIds: [], changed: false }
    }

    const rules = store.getCompiledJsonPathRules()
    if (!Array.isArray(rules) || rules.length === 0) {
      return { buffer, json: initialJson, appliedRuleIds: [], changed: false }
    }

    // Cheap URL-based prefilter: if no rule matches the current URL/phase
    // context, skip protobuf/JSON work entirely for this frame.
    const baseContext = context && typeof context === 'object' ? context : {}
    const matchContext = baseContext.candidates ? baseContext : buildUrlMatchContext(baseContext)
    const hasMatchingRule = rules.some(rule => jsonPathRuleMatchesUrl(rule, matchContext))
    if (!hasMatchingRule) {
      return { buffer, json: initialJson, appliedRuleIds: [], changed: false }
    }

    let json = initialJson
    if (!json || typeof json !== 'object') {
      json = extractJsonFromProtobufBuffer(buffer)
      if (!json || typeof json !== 'object') {
        return { buffer, json: initialJson || json, appliedRuleIds: [], changed: false }
      }
    }

    const normalizedJson = normalizeNestedJsonStrings(json)
    const result = applyJsonPathRulesToObject(normalizedJson, matchContext)
    if (!result || !result.changed) {
      return {
        buffer,
        json: result ? result.object : json,
        appliedRuleIds: result ? result.appliedRuleIds || [] : [],
        changed: false
      }
    }

    const after = result.object || {}
    let nextBuffer = buffer
    let mutated = false

    // Always re-encode the entire object from the modified JSON.
    try {
      nextBuffer = encodeJsonToProtobuf(after)
      mutated = true
    } catch {
      // Re-encoding failed; return original buffer but keep the JSON view
      // changes for logging purposes.
      return {
        buffer,
        json: after,
        appliedRuleIds: result.appliedRuleIds || [],
        changed: false
      }
    }

    return {
      buffer: nextBuffer,
      json: after,
      appliedRuleIds: result.appliedRuleIds || [],
      changed: mutated
    }
  }

  return { applyJsonPathRulesToObject, applyJsonPathRulesToProtobufBuffer }
}

module.exports = { createJsonPathRewriter }
