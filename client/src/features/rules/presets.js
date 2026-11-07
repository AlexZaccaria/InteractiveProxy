/**
 * Pure helpers of the edit-rules tab: marker lists, preset grouping and
 * matching, and the type coercion of JSONPath values. No React, no I/O.
 */

/** @typedef {import('../../lib/types').EditRule} EditRule */
/** @typedef {import('../../lib/types').EditRulePreset} EditRulePreset */
/** @typedef {'string' | 'number' | 'boolean' | 'null' | 'json'} JsonValueType */
/** @typedef {'request' | 'response' | 'both'} RuleTarget */

/** Characters of the replacement preview shown before the "Expand" control. */
export const PREVIEW_MAX_LENGTH = 300

/**
 * The display name of a file value source: the original name, else the last
 * segment of the path, else the stored filename.
 *
 * @param {EditRule['valueSource'] | undefined} source
 * @returns {string | undefined}
 */
export function fileSourceName(source) {
  if (!source) return undefined
  const fallbackName = source.path ? source.path.split(/[\\/]/).pop() : source.filename
  return source.originalName || fallbackName || undefined
}

/**
 * Build a human-readable preview string for a rule's replacement/value.
 *
 * For long values the text can optionally be truncated with an ellipsis so the
 * rule list remains compact, while still allowing a full view when expanded.
 *
 * @param {Partial<EditRule> | null | undefined} rule
 * @param {{ truncate?: boolean, maxLength?: number }} [options]
 * @returns {string}
 */
export function getRulePreviewText(rule, options = {}) {
  const { truncate = true, maxLength = PREVIEW_MAX_LENGTH } = options

  if (!rule || typeof rule !== 'object') return '(empty)'

  let rawValue
  if (rule.kind === 'jsonPath') {
    if (rule.valueSource && rule.valueSource.type === 'file') {
      rawValue = `(File Content) ${fileSourceName(rule.valueSource) || 'file reference'}`
    } else {
      rawValue = Object.prototype.hasOwnProperty.call(rule, 'value') ? rule.value : ''
    }
  } else {
    rawValue = Object.prototype.hasOwnProperty.call(rule, 'replacement') ? rule.replacement : ''
  }

  if (rawValue === null || rawValue === undefined) return '(empty)'
  const text = String(rawValue)
  if (!text) return '(empty)'

  if (!truncate) return text
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '…'
}

/**
 * Parse a raw multiline string into an array of non-empty trimmed variants.
 * Used to map the UI representation of start/end markers (one per line)
 * into the array format expected by the backend edit-rule normaliser.
 *
 * @param {string | null | undefined} value
 * @returns {string[]}
 */
export function parseVariantLines(value) {
  if (!value) return []
  return String(value)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * Build a normalised list of unique, trimmed markers from an optional array
 * of variant markers. Used both when editing a rule and when rendering the
 * rule summary.
 *
 * @param {unknown[] | undefined | null} variants
 * @returns {string[]}
 */
export function buildMarkerList(variants) {
  /** @type {string[]} */
  const markers = []
  const seen = new Set()

  if (Array.isArray(variants)) {
    for (const raw of variants) {
      if (raw === null || raw === undefined) continue
      const value = String(raw).trim()
      if (!value || seen.has(value)) continue
      seen.add(value)
      markers.push(value)
    }
  }

  return markers
}

/**
 * Truncate a preset label for compact display.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function truncatePresetLabel(value, maxLength = 32) {
  const text = String(value || '').trim()
  if (!text) return '—'
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}…`
}

/**
 * Normalize a value to a string for comparison.
 *
 * @param {unknown} value
 * @returns {string}
 */
const safePresetString = value => (value == null ? '' : String(value))

/**
 * Normalize a rule target for comparison: text rules default to `both`,
 * JSONPath rules to `request`.
 *
 * @param {string | undefined} target
 * @param {'text' | 'jsonPath' | undefined} kind
 * @returns {RuleTarget}
 */
export function normalizeRuleTarget(target, kind) {
  if (kind === 'text') {
    return target === 'request' || target === 'response' || target === 'both' ? target : 'both'
  }

  return target === 'response' || target === 'both' ? target : 'request'
}

/**
 * Build a group label for an edit-rule preset.
 *
 * @param {EditRulePreset | null | undefined} preset
 * @param {'mode' | 'path' | 'replaceKey'} groupBy
 * @returns {string}
 */
export function getPresetGroupLabel(preset, groupBy) {
  const rule = preset && typeof preset === 'object' ? preset.rule || {} : {}

  if (groupBy === 'mode') {
    const target = rule.target === 'response' || rule.target === 'both' ? rule.target : 'request'
    return target === 'both' ? 'Both' : target === 'response' ? 'Response' : 'Request'
  }

  if (groupBy === 'path') {
    if (preset?.kind === 'jsonPath') {
      return truncatePresetLabel(rule.path || 'No JSON path')
    }
    return truncatePresetLabel(rule.url || 'Any URL')
  }

  if (preset?.kind === 'jsonPath') {
    if (rule.valueSource && rule.valueSource.type === 'file') {
      return `File: ${truncatePresetLabel(fileSourceName(rule.valueSource) || 'file reference')}`
    }
    return truncatePresetLabel(rule.value || 'Empty value')
  }

  return truncatePresetLabel(rule.replacement || 'Empty replacement')
}

/**
 * Check whether a preset matches a rule by target, URL pattern, and JSON path.
 *
 * @param {EditRulePreset | null | undefined} preset
 * @param {Partial<EditRule> | null | undefined} rule
 * @returns {boolean}
 */
export function doesPresetMatchRuleCriteria(preset, rule) {
  if (!preset || !rule) return false
  const presetRule = preset.rule && typeof preset.rule === 'object' ? preset.rule : {}
  const ruleUrl = safePresetString(rule.url).trim()
  const presetUrl = safePresetString(presetRule.url).trim()
  if (ruleUrl !== presetUrl) return false
  const ruleTarget = normalizeRuleTarget(rule.target, rule.kind)
  const presetTarget = normalizeRuleTarget(presetRule.target, preset.kind)
  if (ruleTarget !== presetTarget) return false
  const rulePath = safePresetString(rule.path).trim()
  const presetPath = safePresetString(presetRule.path).trim()
  if (rulePath || presetPath) {
    return rulePath === presetPath
  }
  return true
}

/**
 * Group presets by target for a dropdown list, groups sorted by label.
 *
 * @param {EditRulePreset[]} presetList
 * @returns {Array<[string, EditRulePreset[]]>}
 */
export function buildGroupedPresets(presetList) {
  /** @type {Map<string, EditRulePreset[]>} */
  const groups = new Map()
  presetList.forEach(preset => {
    if (!preset) return
    const groupLabel = getPresetGroupLabel(preset, 'mode')
    const bucket = groups.get(groupLabel)
    if (bucket) {
      bucket.push(preset)
    } else {
      groups.set(groupLabel, [preset])
    }
  })

  return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))
}

/**
 * The presets that apply to a rule (same target, URL pattern and JSON path), grouped.
 *
 * @param {EditRulePreset[]} presets
 * @param {Partial<EditRule>} rule
 * @returns {Array<[string, EditRulePreset[]]>}
 */
export function groupPresetsForRule(presets, rule) {
  return buildGroupedPresets(presets.filter(preset => doesPresetMatchRuleCriteria(preset, rule)))
}

/**
 * Compare two string arrays for equality regardless of order.
 *
 * @param {unknown[] | undefined | null} left
 * @param {unknown[] | undefined | null} right
 * @returns {boolean}
 */
export function areStringArraysEqual(left, right) {
  const leftArr = Array.isArray(left) ? left.map(entry => String(entry).trim()).filter(Boolean) : []
  const rightArr = Array.isArray(right)
    ? right.map(entry => String(entry).trim()).filter(Boolean)
    : []
  if (leftArr.length !== rightArr.length) return false
  const leftSorted = leftArr.slice().sort()
  const rightSorted = rightArr.slice().sort()
  return leftSorted.every((value, index) => value === rightSorted[index])
}

/**
 * Determine whether a rule matches a preset definition.
 *
 * @param {Partial<EditRule> | null | undefined} rule
 * @param {EditRulePreset | null | undefined} preset
 * @returns {boolean}
 */
export function doesRuleMatchPreset(rule, preset) {
  if (!rule || !preset || rule.kind !== preset.kind) return false
  const presetRule = preset.rule && typeof preset.rule === 'object' ? preset.rule : {}

  if (rule.kind === 'jsonPath') {
    const ruleSource =
      rule.valueSource && rule.valueSource.type === 'file' ? rule.valueSource : null
    const presetSource =
      presetRule.valueSource && presetRule.valueSource.type === 'file'
        ? presetRule.valueSource
        : null
    const ruleFile = ruleSource
      ? ruleSource.path || ruleSource.filename || ruleSource.originalName
      : ''
    const presetFile = presetSource
      ? presetSource.path || presetSource.filename || presetSource.originalName
      : ''

    return (
      safePresetString(rule.path) === safePresetString(presetRule.path) &&
      safePresetString(rule.url) === safePresetString(presetRule.url) &&
      safePresetString(rule.target) === safePresetString(presetRule.target) &&
      safePresetString(rule.valueType) === safePresetString(presetRule.valueType) &&
      String(ruleFile) === String(presetFile) &&
      (ruleSource || presetSource
        ? true
        : JSON.stringify(rule.value ?? '') === JSON.stringify(presetRule.value ?? ''))
    )
  }

  return (
    safePresetString(rule.replacement) === safePresetString(presetRule.replacement) &&
    rule.useRegex === presetRule.useRegex &&
    rule.caseSensitive === presetRule.caseSensitive &&
    safePresetString(rule.url || '') === safePresetString(presetRule.url || '') &&
    safePresetString(rule.target || '') === safePresetString(presetRule.target || '') &&
    areStringArraysEqual(rule.startVariants, presetRule.startVariants) &&
    areStringArraysEqual(rule.endVariants, presetRule.endVariants)
  )
}

/**
 * The id of the first preset (among those applicable to the rule) whose
 * definition the rule matches, else `''`.
 *
 * @param {EditRulePreset[]} presets
 * @param {Partial<EditRule>} rule
 * @returns {string}
 */
export function findMatchingPresetId(presets, rule) {
  const match = presets.find(
    preset => doesPresetMatchRuleCriteria(preset, rule) && doesRuleMatchPreset(rule, preset)
  )
  return match ? String(match.id) : ''
}

/**
 * Coerce a raw JSONPath input into a boolean, number, JSON, or string.
 *
 * The conversion applies cascading rules (boolean -> number -> JSON -> string) so
 * users can paste or upload a value without specifying an explicit type.
 *
 * @param {unknown} rawValue
 * @returns {{ value: boolean | number | string | object, valueType: 'boolean' | 'number' | 'json' | 'string' }}
 */
export function coerceJsonPathScalar(rawValue) {
  const text = rawValue == null ? '' : String(rawValue)
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
      // Invalid JSON: fall back to string.
    }
  }

  return { value: text, valueType: 'string' }
}

/**
 * Normalize an existing JSONPath rule value for form editing.
 *
 * @param {unknown} rawValue
 * @returns {{ valueText: string, valueType: 'boolean' | 'number' | 'json' | 'string' }}
 */
export function normalizeJsonPathFormValue(rawValue) {
  if (typeof rawValue === 'boolean') {
    return { valueText: rawValue ? 'true' : 'false', valueType: 'boolean' }
  }

  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return { valueText: String(rawValue), valueType: 'number' }
  }

  if (typeof rawValue === 'string') {
    const { valueType } = coerceJsonPathScalar(rawValue)
    return { valueText: rawValue, valueType }
  }

  if (rawValue && typeof rawValue === 'object') {
    try {
      return { valueText: JSON.stringify(rawValue), valueType: 'json' }
    } catch {
      return { valueText: String(rawValue), valueType: 'string' }
    }
  }

  return {
    valueText: rawValue == null ? '' : String(rawValue),
    valueType: 'string'
  }
}
