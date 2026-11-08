import { useCallback, useEffect, useMemo, useState } from 'react'
import { useProxyStore } from '../../store/useProxyStore'
import {
  buildMarkerList,
  coerceJsonPathScalar,
  fileSourceName,
  groupPresetsForRule,
  normalizeJsonPathFormValue,
  parseVariantLines
} from './presets'

/** @typedef {import('../../lib/types').EditRule} EditRule */
/** @typedef {import('../../lib/types').EditRulePreset} EditRulePreset */
/** @typedef {import('../../store/useProxyStore').JsonPathRuleSeed} JsonPathRuleSeed */
/** @typedef {import('./presets').JsonValueType} JsonValueType */
/** @typedef {import('./presets').RuleTarget} RuleTarget */

/**
 * The fields of the create/edit form. Text rules use the marker textareas
 * and the replacement; JSONPath rules the path and the value (typed by hand
 * or read from a file on the proxy's host at runtime).
 *
 * @typedef {Object} RuleFormData
 * @property {'text' | 'jsonPath'} kind
 * @property {string} name
 * @property {string} startVariantsText
 * @property {string} endVariantsText
 * @property {string} replacement
 * @property {boolean} enabled
 * @property {boolean} useRegex
 * @property {boolean} caseSensitive
 * @property {string} path
 * @property {string} value
 * @property {JsonValueType} valueType
 * @property {'text' | 'file'} jsonValueMode
 * @property {string} jsonValueFileName
 * @property {string} jsonValueFileToken Absolute path of the value file on the proxy's host.
 * @property {string} url
 * @property {RuleTarget} target
 */

/**
 * A validation failure: the title and the message of the warning dialog,
 * and the text of the `alert()` used when no dialog helper is available.
 *
 * @typedef {Object} RuleFormError
 * @property {string} title
 * @property {string} message
 * @property {string} fallback
 */

/**
 * An empty text-rule form.
 *
 * @param {RuleTarget} [target] `both` for a new rule, `request` after a cancel.
 * @returns {RuleFormData}
 */
export function createEmptyForm(target = 'request') {
  return {
    kind: 'text',
    name: '',
    startVariantsText: '',
    endVariantsText: '',
    replacement: '',
    enabled: true,
    useRegex: false,
    caseSensitive: false,
    path: '',
    value: '',
    valueType: 'string',
    jsonValueMode: 'text',
    jsonValueFileName: '',
    jsonValueFileToken: '',
    url: '',
    target
  }
}

/**
 * The form that edits an existing rule (or a preset's rule definition).
 *
 * @param {Partial<EditRule>} rule
 * @param {boolean} enabled The form's enabled toggle (the rule's own flag when editing, on for a preset).
 * @returns {RuleFormData}
 */
export function formFromRule(rule, enabled) {
  if (rule.kind === 'jsonPath') {
    const fileSource =
      rule.valueSource && rule.valueSource.type === 'file' ? rule.valueSource : null
    const normalizedValue = normalizeJsonPathFormValue(
      Object.prototype.hasOwnProperty.call(rule, 'value') ? rule.value : ''
    )
    return {
      kind: 'jsonPath',
      name: rule.name || '',
      startVariantsText: '',
      endVariantsText: '',
      replacement: '',
      enabled,
      useRegex: false,
      caseSensitive: false,
      path: rule.path || '',
      value: fileSource ? '' : normalizedValue.valueText,
      valueType: fileSource ? rule.valueType || 'string' : normalizedValue.valueType,
      jsonValueMode: fileSource ? 'file' : 'text',
      jsonValueFileName: fileSourceName(fileSource) || '',
      jsonValueFileToken: fileSource?.path || fileSource?.filename || '',
      url: rule.url || '',
      target: rule.target === 'response' || rule.target === 'both' ? rule.target : 'request'
    }
  }

  // For text rules, URL/target are optional; when missing, they are treated
  // as global and "both" respectively.
  return {
    kind: 'text',
    name: rule.name || '',
    startVariantsText: buildMarkerList(rule.startVariants).join('\n'),
    endVariantsText: buildMarkerList(rule.endVariants).join('\n'),
    replacement: rule.replacement || '',
    enabled,
    useRegex: rule.useRegex === true,
    caseSensitive: rule.caseSensitive === true,
    path: '',
    value: '',
    valueType: 'string',
    jsonValueMode: 'text',
    jsonValueFileName: '',
    jsonValueFileToken: '',
    url: rule.url || '',
    target:
      rule.target === 'request' || rule.target === 'response' || rule.target === 'both'
        ? rule.target
        : 'both'
  }
}

/**
 * The form filled from a saved preset: its rule definition with the preset's kind.
 *
 * @param {EditRulePreset} preset
 * @returns {RuleFormData}
 */
export function formFromPreset(preset) {
  const rule = preset.rule && typeof preset.rule === 'object' ? preset.rule : {}
  return formFromRule({ ...rule, kind: preset.kind }, true)
}

/**
 * A new JSONPath rule prefilled from the seed the log view hands over
 * (the edit icon of a JSON node).
 *
 * @param {JsonPathRuleSeed} seed
 * @returns {RuleFormData}
 */
export function formFromSeed(seed) {
  const normalizedSeedValue = normalizeJsonPathFormValue(seed.value)
  return {
    ...createEmptyForm('request'),
    kind: 'jsonPath',
    name: seed.name || '',
    path: seed.path || '',
    value: normalizedSeedValue.valueText,
    valueType: normalizedSeedValue.valueType,
    url: seed.url || '',
    target: seed.target === 'response' || seed.target === 'both' ? seed.target : 'request'
  }
}

/**
 * Check the form before saving.
 *
 * @param {RuleFormData} formData
 * @returns {RuleFormError | null} The warning to show, or null when the form can be saved.
 */
export function validateRuleForm(formData) {
  if (formData.kind === 'jsonPath') {
    if (!formData.url.trim() || !formData.path.trim()) {
      const message = 'For a JSONPath rule you must specify both the URL and the JSON path.'
      return { title: 'Missing fields', message, fallback: message }
    }
    if (formData.jsonValueMode === 'file' && !formData.jsonValueFileToken) {
      const message = 'Select a file to use as the JSONPath value before saving.'
      return { title: 'Missing file', message, fallback: message }
    }
    return null
  }

  const hasStartMarkers = parseVariantLines(formData.startVariantsText).length > 0
  const hasEndMarkers = parseVariantLines(formData.endVariantsText).length > 0
  if (!hasStartMarkers && !hasEndMarkers) {
    return {
      title: 'Missing match boundaries',
      message:
        'Please provide at least one start or end marker (one per line) so the proxy knows which part of the content to replace.',
      fallback: 'Please provide at least one start or end marker before saving this rule.'
    }
  }
  return null
}

/**
 * The rule definition of the form, as stored in a preset (no `enabled`).
 *
 * For text rules all non-empty lines of the marker textareas are sent as
 * `startVariants` / `endVariants`, which the backend expands into concrete
 * start/end combinations. JSONPath values are coerced (boolean, number,
 * JSON, string) and JSON ones are stored stringified.
 *
 * @param {RuleFormData} formData
 * @returns {Partial<EditRule>}
 */
export function buildPresetRule(formData) {
  if (formData.kind === 'jsonPath') {
    if (formData.jsonValueMode === 'file' && formData.jsonValueFileToken) {
      return {
        kind: 'jsonPath',
        name: formData.name,
        path: formData.path,
        value: '',
        valueType: formData.valueType,
        valueSource: {
          type: 'file',
          path: formData.jsonValueFileToken,
          originalName: formData.jsonValueFileName
        },
        url: formData.url,
        target: formData.target || 'request'
      }
    }

    const normalizedValue = coerceJsonPathScalar(formData.value)
    const storedValue =
      normalizedValue.valueType === 'json'
        ? JSON.stringify(normalizedValue.value)
        : normalizedValue.value

    return {
      kind: 'jsonPath',
      name: formData.name,
      path: formData.path,
      value: storedValue,
      valueType: normalizedValue.valueType,
      valueSource: null,
      url: formData.url,
      target: formData.target || 'request'
    }
  }

  return {
    kind: 'text',
    name: formData.name,
    replacement: formData.replacement,
    useRegex: formData.useRegex === true,
    caseSensitive: formData.caseSensitive === true,
    // Optional URL/target fields for text rules; when url is empty the rule
    // is global, and when target is omitted it defaults to both.
    url: formData.url || '',
    target:
      formData.target === 'request' || formData.target === 'response' || formData.target === 'both'
        ? formData.target
        : 'both',
    startVariants: parseVariantLines(formData.startVariantsText),
    endVariants: parseVariantLines(formData.endVariantsText)
  }
}

/**
 * The payload of `POST`/`PUT /api/edit-rules`: the preset rule plus the enabled flag.
 *
 * @param {RuleFormData} formData
 * @returns {Partial<EditRule>}
 */
export function buildRulePayload(formData) {
  return { ...buildPresetRule(formData), enabled: formData.enabled !== false }
}

/**
 * The state of the create/edit form of the edit-rules tab: the fields, the
 * mode (creating, editing one rule, closed), the preset chosen from the
 * dropdown (applied to the fields as soon as it is known) and the JSONPath
 * seed left in the store by the log view (opens the form on a new JSONPath
 * rule and clears the seed).
 *
 * @param {{ presets: EditRulePreset[] }} options The saved presets, for the selection and the scoped dropdown.
 */
export function useRuleForm({ presets }) {
  const seed = useProxyStore(state => state.jsonPathRuleSeed)
  const setJsonPathRuleSeed = useProxyStore(state => state.setJsonPathRuleSeed)

  const [formData, setFormData] = useState(() => createEmptyForm('request'))
  const [editingRuleId, setEditingRuleId] = useState(/** @type {string | null} */ (null))
  const [isCreating, setIsCreating] = useState(false)
  const [selectedPresetId, setSelectedPresetId] = useState('')

  /** Merge a partial update into the fields. */
  const updateForm = useCallback(
    /** @param {Partial<RuleFormData>} patch */
    patch => setFormData(prev => ({ ...prev, ...patch })),
    []
  )

  /** Open the form on a new text rule (both targets, the legacy default). */
  const startCreate = useCallback(() => {
    setIsCreating(true)
    setSelectedPresetId('')
    setFormData(createEmptyForm('both'))
  }, [])

  /** Open the form on an existing rule. */
  const startEdit = useCallback(
    /** @param {EditRule} rule */
    rule => {
      setIsCreating(false)
      setEditingRuleId(rule.id)
      setSelectedPresetId('')
      setFormData(formFromRule(rule, rule.enabled !== false))
    },
    []
  )

  /** Close the form and reset the fields. */
  const cancel = useCallback(() => {
    setEditingRuleId(null)
    setIsCreating(false)
    setSelectedPresetId('')
    setFormData(createEmptyForm('request'))
  }, [])

  /** Choose a preset in the dropdown; `''` clears the selection. */
  const selectPreset = useCallback(
    /** @param {string} presetId */
    presetId => setSelectedPresetId(String(presetId || '')),
    []
  )

  useEffect(() => {
    if (!selectedPresetId) return
    const preset = presets.find(item => item && String(item.id) === selectedPresetId)
    if (preset) setFormData(formFromPreset(preset))
  }, [presets, selectedPresetId])

  useEffect(() => {
    if (!seed) return
    setIsCreating(true)
    setEditingRuleId(null)
    setSelectedPresetId('')
    setFormData(formFromSeed(seed))
    setJsonPathRuleSeed(null)
  }, [seed, setJsonPathRuleSeed])

  const groupedPresets = useMemo(
    () =>
      groupPresetsForRule(presets, {
        kind: formData.kind,
        url: formData.url || '',
        target: formData.target,
        path: formData.kind === 'jsonPath' ? formData.path : ''
      }),
    [formData.kind, formData.path, formData.target, formData.url, presets]
  )

  return {
    formData,
    updateForm,
    isCreating,
    editingRuleId,
    isOpen: isCreating || editingRuleId !== null,
    startCreate,
    startEdit,
    cancel,
    selectedPresetId,
    selectPreset,
    setSelectedPresetId,
    groupedPresets
  }
}
