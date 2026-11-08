'use strict'

/**
 * Edit-rule schema: the canonical in-memory shapes of text and JSONPath rules
 * and presets, their on-disk (de)serialisation, JSONPath parsing, the
 * compilation of a text rule into a matcher and the literal text replacement
 * primitive.
 *
 * Everything in here is pure: no rule state, no logging. The store
 * (`./store`) owns the rules and calls these helpers.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { safeString, safeTrim } = require('../util/strings')

/**
 * Reference to a file whose content is used as the value of a JSONPath rule.
 *
 * @typedef {object} JsonPathValueSource
 * @property {'file'} type
 * @property {string} [filename] File name inside the storage directory.
 * @property {string} [path] Explicit path (absolute, or relative to the storage directory).
 * @property {string} [originalName] Name of the uploaded file, for display.
 */

/**
 * @typedef {'string'|'number'|'boolean'|'null'|'json'} JsonPathValueType
 * @typedef {'request'|'response'|'both'} RuleTarget
 */

/**
 * Text rule: markers are OR-lists; every start/end combination becomes one
 * compiled matcher sharing the rule id.
 *
 * @typedef {object} TextRule
 * @property {string} id
 * @property {boolean} enabled
 * @property {'text'} kind
 * @property {string} name
 * @property {string} replacement
 * @property {boolean} useRegex
 * @property {boolean} caseSensitive
 * @property {string} url Optional URL pattern; empty applies everywhere.
 * @property {string[]} startVariants
 * @property {string[]} endVariants
 * @property {RuleTarget} target
 */

/**
 * JSONPath rule: always URL-scoped, applied to JSON bodies and decoded
 * Protobuf messages.
 *
 * @typedef {object} JsonPathRule
 * @property {string} id
 * @property {boolean} enabled
 * @property {'jsonPath'} kind
 * @property {string} name
 * @property {string} path
 * @property {any} value
 * @property {JsonPathValueType} valueType
 * @property {JsonPathValueSource|null} valueSource
 * @property {string} url
 * @property {RuleTarget} target
 */

/** @typedef {TextRule|JsonPathRule} EditRule */

/**
 * Stored preset: a rule without its runtime fields (id, enabled).
 *
 * @typedef {object} EditRulePreset
 * @property {string} id
 * @property {string} name
 * @property {'text'|'jsonPath'} kind
 * @property {Record<string, any>} rule
 * @property {string} createdAt
 */

/**
 * One step of a parsed JSONPath.
 *
 * @typedef {{ type: 'key', key: string } | { type: 'index', index: number } | { type: 'filter', key: string, value: string }} JsonPathSegment
 */

/**
 * A text rule variant compiled into a matcher.
 *
 * @typedef {object} CompiledTextRule
 * @property {Record<string, any>} rule The rule (with the `start`/`end` of this variant).
 * @property {'between'|'prefix'|'suffix'|null} mode
 * @property {boolean} useRegex
 * @property {boolean} caseSensitive
 * @property {string} start
 * @property {string} end
 * @property {RegExp} [regex]
 */

/**
 * A JSONPath rule with its path pre-parsed.
 *
 * @typedef {object} CompiledJsonPathRule
 * @property {string} id
 * @property {'jsonPath'} kind
 * @property {string} name
 * @property {string} path
 * @property {JsonPathSegment[]} segments
 * @property {any} value
 * @property {JsonPathValueType} valueType
 * @property {JsonPathValueSource|null} valueSource
 * @property {string} url
 * @property {RuleTarget} target
 */

/**
 * Normalize a user-supplied file reference for JSONPath rule values.
 *
 * @param {any} source
 * @returns {JsonPathValueSource | null}
 */
function normalizeJsonPathValueSource(source) {
  if (!source || typeof source !== 'object') return null
  if (source.type !== 'file') return null
  const filename = safeString(source.filename)
  const filePath = safeString(source.path)
  if (!filename && !filePath) return null
  const originalName = safeString(source.originalName)
  return {
    type: 'file',
    ...(filename ? { filename } : {}),
    ...(filePath ? { path: filePath } : {}),
    ...(originalName ? { originalName } : {})
  }
}

/**
 * Resolve a JSONPath rule value from a referenced file on disk.
 *
 * @param {JsonPathValueSource|null|undefined} source
 * @param {string} storageDir Directory that relative references are resolved against.
 * @returns {string | null}
 */
function resolveJsonPathValueFromSource(source, storageDir) {
  if (!source || source.type !== 'file') return null
  const explicitPath = safeString(source.path)
  const filename = safeString(source.filename)
  if (!explicitPath && !filename) return null
  const filePath = explicitPath
    ? path.isAbsolute(explicitPath)
      ? explicitPath
      : path.join(storageDir, explicitPath)
    : path.join(storageDir, filename)
  try {
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Coerce a JSONPath text value into boolean, number, JSON, or string.
 *
 * @param {unknown} rawText
 * @returns {{ value: any, valueType: 'boolean' | 'number' | 'json' | 'string' }}
 */
function coerceJsonPathScalarFromText(rawText) {
  const text = rawText == null ? '' : String(rawText)
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()

  if (lower === 'true') {
    return { value: true, valueType: 'boolean' }
  }

  if (lower === 'false') {
    return { value: false, valueType: 'boolean' }
  }

  if (trimmed.length > 0) {
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) {
      return { value: parsed, valueType: 'number' }
    }
  }

  if (trimmed.length > 0) {
    try {
      const parsedJson = JSON.parse(trimmed)
      if (parsedJson !== null && typeof parsedJson === 'object') {
        return { value: parsedJson, valueType: 'json' }
      }
    } catch {
      // Ignore invalid JSON and fall back to string.
    }
  }

  return { value: text, valueType: 'string' }
}

/**
 * Normalise a raw edit-rule entry loaded from disk into the in-memory format.
 *
 * In particolare consente di rappresentare su disco i campi stringa molto
 * lunghi (per qualsiasi tipo di regola) come array di segmenti, mantenendo
 * però sempre stringhe piatte in memoria durante l'applicazione delle regole.
 * Qualsiasi proprietà che risulta essere un array di stringhe viene
 * ricomposta in una singola stringa.
 *
 * @param {Record<string, any>} [rule]
 * @returns {Record<string, any>}
 */
function deserializeEditRuleFromDisk(rule = {}) {
  const normalized = { ...rule }

  // Convert any multi-segment on-disk representation back into flat strings so
  // that the rest of the code can treat these fields uniformly. This applies
  // to generic string fields shared by both jsonPath and text rules; marker
  // lists for text rules are always represented via startVariants/endVariants.
  const STRING_FIELDS = ['value', 'replacement', 'name', 'path', 'url']

  for (const key of STRING_FIELDS) {
    const current = normalized[key]
    if (Array.isArray(current) && current.every(segment => typeof segment === 'string')) {
      normalized[key] = current.join(' ')
    }
  }

  return normalized
}

/**
 * Normalise a raw edit rule (either jsonPath or text) into the canonical
 * in-memory format used by the proxy.
 *
 * For `jsonPath` rules the structure is kept close to the on-disk
 * representation, with light validation of valueType/target.
 *
 * For `text` rules the canonical model is entirely based on
 * `startVariants` / `endVariants`, which are treated as OR-lists of markers
 * for the start and end boundaries.
 *
 * @param {Record<string, any>} [rule]
 * @returns {EditRule}
 */
function normalizeEditRule(rule = {}) {
  const kind = rule.kind === 'jsonPath' ? 'jsonPath' : 'text'

  if (kind === 'jsonPath') {
    /** @type {JsonPathValueType} */
    let valueType = 'string'
    if (
      rule.valueType === 'number' ||
      rule.valueType === 'boolean' ||
      rule.valueType === 'null' ||
      rule.valueType === 'json'
    ) {
      valueType = rule.valueType
    }

    const valueSource = normalizeJsonPathValueSource(rule.valueSource)

    /** @type {RuleTarget} */
    const normalizedTarget =
      rule.target === 'response' || rule.target === 'both' ? rule.target : 'request'

    return {
      id: rule.id || crypto.randomUUID(),
      enabled: rule.enabled !== false,
      kind,
      name: rule.name || '',
      path: safeString(rule.path),
      value: valueSource ? '' : Object.hasOwn(rule, 'value') ? rule.value : '',
      valueType,
      valueSource,
      // URL pattern su cui applicare la regola jsonPath; se vuoto la regola
      // non verrà inclusa nella cache compilata.
      url: safeString(rule.url),
      // Bersaglio della regola: 'request', 'response' oppure 'both'. Per
      // compatibilità all'indietro, le regole esistenti senza target esplicito
      // vengono trattate come 'request'.
      target: normalizedTarget
    }
  }

  // Default text rule. Text rules now support optional URL scoping and
  // request/response/both targeting, but for backwards compatibility existing
  // rules without an explicit target continue to apply to both directions.
  /** @type {RuleTarget} */
  let normalizedTarget = 'both'
  if (rule.target === 'request' || rule.target === 'response' || rule.target === 'both') {
    normalizedTarget = rule.target
  }

  /**
   * Normalise an optional array of string variants, trimming each entry and
   * rimuovendo le stringhe vuote. Restituisce sempre un nuovo array (anche
   * quando non sono presenti varianti valide).
   *
   * @param {unknown} value
   * @returns {string[]}
   */
  function normaliseVariantArray(value) {
    if (!Array.isArray(value)) return []
    return value.map(entry => safeString(entry).trim()).filter(entry => entry.length > 0)
  }

  // Rules written by older versions (and the documented on-disk format) carry
  // a single `start`/`end` pair; fold it into the variant lists so that they
  // keep applying after an upgrade.
  const legacyStart = safeString(rule.start).trim()
  const legacyEnd = safeString(rule.end).trim()
  const startVariants = normaliseVariantArray(
    Array.isArray(rule.startVariants) && rule.startVariants.length
      ? rule.startVariants
      : legacyStart
        ? [legacyStart]
        : []
  )
  const endVariants = normaliseVariantArray(
    Array.isArray(rule.endVariants) && rule.endVariants.length
      ? rule.endVariants
      : legacyEnd
        ? [legacyEnd]
        : []
  )

  return {
    id: rule.id || crypto.randomUUID(),
    enabled: rule.enabled !== false,
    kind: 'text',
    name: rule.name || '',
    replacement: rule.replacement || '',
    useRegex: rule.useRegex === true,
    caseSensitive: rule.caseSensitive === true,
    // Optional URL pattern; when non-empty, the rule will only be applied
    // when the current URL context matches it (see textRuleMatchesUrl).
    url: safeString(rule.url),
    // Optional arrays of additional start/end variants used for OR matching.
    // Questi non influenzano il formato legacy su disco e vengono espansi in
    // più regole compilate all'interno di rebuildEditRuleCache.
    startVariants,
    endVariants,
    // Optional phase target; defaults to 'both' for text rules so that legacy
    // rules keep affecting both requests and responses unless narrowed.
    target: normalizedTarget
  }
}

/**
 * Strip runtime-only fields from a normalized edit rule before storing it
 * inside a preset.
 *
 * @param {Record<string, any>} [rule]
 * @returns {Record<string, any>}
 */
function stripPresetRuntimeFields(rule = {}) {
  const { id, enabled, ...rest } = rule
  return rest
}

/**
 * Normalize an edit-rule preset payload into a canonical stored shape.
 *
 * @param {Record<string, any>} [preset]
 * @returns {EditRulePreset}
 */
function normalizeEditRulePreset(preset = {}) {
  const kind = preset.kind === 'jsonPath' ? 'jsonPath' : 'text'
  const name = safeTrim(preset.name) || 'Untitled preset'
  const id =
    safeString(preset.id) || `preset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const rawRule = preset.rule && typeof preset.rule === 'object' ? preset.rule : {}
  const normalizedRule = normalizeEditRule({ ...rawRule, kind })

  return {
    id,
    name,
    kind,
    rule: stripPresetRuntimeFields(normalizedRule),
    createdAt:
      typeof preset.createdAt === 'string' && preset.createdAt
        ? preset.createdAt
        : new Date().toISOString()
  }
}

/**
 * Split a long string into whitespace-delimited segments, each with a maximum
 * length. This is used purely for on-disk formatting of very long JSONPath
 * rule values so that the JSON file remains readable/editable by humans.
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]}
 */
function splitLongStringIntoSegments(text, maxLen) {
  const segments = []
  const words = String(text).split(/\s+/).filter(Boolean)

  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
    } else if ((current + ' ' + word).length <= maxLen) {
      current += ' ' + word
    } else {
      segments.push(current)
      current = word
    }
  }

  if (current) {
    segments.push(current)
  }

  return segments
}

/**
 * Prepare an edit-rule entry for JSON serialization to disk.
 *
 * Very long string values in edit rules are emitted as arrays of shorter
 * string segments so that the resulting edit-rules.json is easier to read and
 * edit manually.
 *
 * @param {Record<string, any>} [rule]
 * @returns {Record<string, any>}
 */
function serializeEditRuleForDisk(rule = {}) {
  const out = { ...rule }

  const MAX_SEGMENT_LENGTH = 160

  /** @param {string} key */
  const splitIfLong = key => {
    const current = out[key]
    if (typeof current !== 'string') return
    const trimmed = current.trim()
    if (!trimmed) {
      out[key] = ''
      return
    }
    if (trimmed.length > MAX_SEGMENT_LENGTH) {
      out[key] = splitLongStringIntoSegments(trimmed, MAX_SEGMENT_LENGTH)
    } else {
      out[key] = trimmed
    }
  }

  if (out && out.kind === 'jsonPath') {
    splitIfLong('value')
  }

  if (out && out.kind === 'text') {
    splitIfLong('replacement')

    // The canonical model for text rules uses only startVariants/endVariants
    // as marker lists; drop any legacy positional markers from the on-disk
    // representation to keep the JSON clean and avoid confusion.
    delete out.start
    delete out.end
  }

  return out
}

/**
 * Parse a JSONPath-like expression (`root.a.b`, `$.items[0].name`,
 * `root.items[?(@.id=='x')]`) into traversal segments. Returns an empty
 * array for the root itself and for any input that cannot be parsed.
 *
 * @param {unknown} path
 * @returns {JsonPathSegment[]}
 */
function parseJsonPath(path) {
  if (!path || typeof path !== 'string') return []

  const trimmed = path.trim()
  if (!trimmed) return []

  let s = trimmed

  // Support optional leading symbols like "root" or "$" (e.g. "root.f1.f2" or "$.f1[0]")
  if (s === 'root' || s === '$') {
    return []
  }

  if (s.startsWith('root.')) {
    s = s.slice(5)
  } else if (s.startsWith('root[')) {
    s = s.slice(4)
  } else if (s.startsWith('$.')) {
    s = s.slice(2)
  } else if (s.startsWith('$[')) {
    s = s.slice(1)
  }

  /** @type {JsonPathSegment[]} */
  const segments = []
  let i = 0

  while (i < s.length) {
    const ch = s[i]

    if (ch === '.') {
      i += 1
      continue
    }

    if (ch === '[') {
      const end = s.indexOf(']', i + 1)
      if (end === -1) return []

      const inside = s.slice(i + 1, end).trim()
      if (!inside) return []

      // Support numeric indices: root.items[3].name
      if (/^\d+$/.test(inside)) {
        const index = Number.parseInt(inside, 10)
        if (!Number.isFinite(index) || index < 0) return []
        segments.push({ type: 'index', index })
      } else if (inside.startsWith('?')) {
        // Support filter expressions: [?(@.field=='value')] or [?(@.field=="value")]
        // Pattern: ?(@.key=='value') or ?(@.key=="value")
        const filterMatch = inside.match(/^\?\s*\(\s*@\.(\w+)\s*==\s*['"]([^'"]+)['"]\s*\)$/)
        if (!filterMatch) return []
        const filterKey = filterMatch[1]
        const filterValue = filterMatch[2]
        segments.push({ type: 'filter', key: filterKey, value: filterValue })
      } else {
        return []
      }
      i = end + 1
      continue
    }

    // Parse identifier segment until next '.', '[' or ']' (dot-notation key)
    let j = i
    while (j < s.length && s[j] !== '.' && s[j] !== '[' && s[j] !== ']') {
      j += 1
    }

    const key = s.slice(i, j).trim()
    if (!key) return []

    segments.push({ type: 'key', key })
    i = j
  }

  return segments
}

/**
 * Replace every occurrence of a literal marker (or of the span between two
 * markers) in `text`, optionally ignoring case.
 *
 * @param {string} text
 * @param {string|null|undefined} start
 * @param {string|null|undefined} end
 * @param {string} replacement
 * @param {boolean} caseSensitive
 * @returns {{ text: string, count: number }}
 */
function replaceTextLiteral(text, start, end, replacement, caseSensitive) {
  if (!start && !end) return { text, count: 0 }

  /** @param {string} s */
  const normalize = s => (caseSensitive ? s : s.toLowerCase())
  const haystack = normalize(text)
  const parts = []
  let lastIndex = 0
  let count = 0

  if (start && end) {
    // between mode
    const startSearch = normalize(start)
    const endSearch = normalize(end)
    let startIdx = haystack.indexOf(startSearch, lastIndex)
    while (startIdx !== -1) {
      const endIdx = haystack.indexOf(endSearch, startIdx + start.length)
      if (endIdx === -1) break
      parts.push(text.slice(lastIndex, startIdx), replacement)
      lastIndex = endIdx + end.length
      count++
      startIdx = haystack.indexOf(startSearch, lastIndex)
    }
  } else {
    // simple replace mode
    const needle = /** @type {string} */ (start || end)
    const searchNeedle = normalize(needle)
    let idx = haystack.indexOf(searchNeedle, lastIndex)
    while (idx !== -1) {
      parts.push(text.slice(lastIndex, idx), replacement)
      lastIndex = idx + needle.length
      count++
      idx = haystack.indexOf(searchNeedle, lastIndex)
    }
  }

  if (count === 0) return { text, count }
  parts.push(text.slice(lastIndex))
  return { text: parts.join(''), count }
}

/**
 * Compile one text rule variant (a rule carrying a single `start`/`end`
 * pair) into a matcher. Returns null for disabled rules and for variants
 * without markers; throws `SyntaxError` when a regex marker is invalid.
 *
 * @param {Record<string, any>|null|undefined} rule
 * @returns {CompiledTextRule|null}
 */
function compileEditRule(rule) {
  if (!rule || !rule.enabled) return null

  const startRaw = safeString(rule.start)
  const endRaw = safeString(rule.end)

  if (!startRaw && !endRaw) {
    return null
  }

  const useRegex = !!rule.useRegex
  const caseSensitive = !!rule.caseSensitive
  const flags = `g${caseSensitive ? '' : 'i'}`

  /** @type {CompiledTextRule} */
  const compiled = {
    rule,
    mode: null,
    useRegex,
    caseSensitive,
    start: startRaw,
    end: endRaw
  }

  if (useRegex) {
    if (startRaw && endRaw) {
      compiled.mode = 'between'
      compiled.regex = new RegExp(`${startRaw}[\\s\\S]*?${endRaw}`, flags)
    } else if (startRaw) {
      compiled.mode = 'prefix'
      compiled.regex = new RegExp(startRaw, flags)
    } else {
      compiled.mode = 'suffix'
      compiled.regex = new RegExp(endRaw, flags)
    }
    return compiled
  }

  if (startRaw && endRaw) {
    compiled.mode = 'between'
  } else if (startRaw) {
    compiled.mode = 'prefix'
  } else {
    compiled.mode = 'suffix'
  }

  return compiled
}

module.exports = {
  normalizeJsonPathValueSource,
  resolveJsonPathValueFromSource,
  coerceJsonPathScalarFromText,
  deserializeEditRuleFromDisk,
  normalizeEditRule,
  stripPresetRuntimeFields,
  normalizeEditRulePreset,
  splitLongStringIntoSegments,
  serializeEditRuleForDisk,
  parseJsonPath,
  replaceTextLiteral,
  compileEditRule
}
