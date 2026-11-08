import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useProxyStore } from '../../store/useProxyStore'
import {
  buildPresetRule,
  buildRulePayload,
  createEmptyForm,
  formFromPreset,
  formFromRule,
  formFromSeed,
  useRuleForm,
  validateRuleForm
} from './useRuleForm'

/** @typedef {import('../../lib/types').EditRule} EditRule */
/** @typedef {import('../../lib/types').EditRulePreset} EditRulePreset */

/** @type {EditRule} */
const textRule = {
  id: 'rule-1',
  kind: 'text',
  name: 'Title',
  enabled: false,
  useRegex: true,
  caseSensitive: false,
  url: 'example.com',
  target: 'response',
  startVariants: ['<title>', ' <title>', ''],
  endVariants: ['</title>'],
  replacement: 'Proxied'
}

/** @type {EditRule} */
const jsonRule = {
  id: 'rule-2',
  kind: 'jsonPath',
  name: 'User',
  enabled: true,
  url: '/api/users',
  path: 'data.user.name',
  value: 42,
  valueType: 'number'
}

/** @type {EditRulePreset} */
const preset = {
  id: 'preset-1',
  name: 'Preset',
  kind: 'text',
  rule: { replacement: 'From preset', startVariants: ['a'], target: 'both' },
  createdAt: '2026-11-07T00:00:00.000Z'
}

describe('form builders', () => {
  it('fills the form from a text rule, keeping its enabled flag and unique markers', () => {
    const form = formFromRule(textRule, textRule.enabled !== false)
    expect(form).toMatchObject({
      kind: 'text',
      name: 'Title',
      enabled: false,
      useRegex: true,
      caseSensitive: false,
      url: 'example.com',
      target: 'response',
      startVariantsText: '<title>',
      endVariantsText: '</title>',
      replacement: 'Proxied',
      path: '',
      value: ''
    })
  })

  it('fills the form from a JSONPath rule and from a file-backed one', () => {
    expect(formFromRule(jsonRule, true)).toMatchObject({
      kind: 'jsonPath',
      path: 'data.user.name',
      value: '42',
      valueType: 'number',
      jsonValueMode: 'text',
      url: '/api/users',
      target: 'request'
    })
    const fileRule = {
      ...jsonRule,
      value: '',
      valueType: /** @type {const} */ ('json'),
      valueSource: { type: /** @type {const} */ ('file'), path: 'C:\\data\\value.json' }
    }
    expect(formFromRule(fileRule, true)).toMatchObject({
      jsonValueMode: 'file',
      jsonValueFileName: 'value.json',
      jsonValueFileToken: 'C:\\data\\value.json',
      value: '',
      valueType: 'json'
    })
  })

  it('fills the form from a preset with the enabled toggle on', () => {
    expect(formFromPreset(preset)).toMatchObject({
      kind: 'text',
      enabled: true,
      replacement: 'From preset',
      startVariantsText: 'a',
      target: 'both'
    })
  })

  it('fills a new JSONPath form from the seed of the log view', () => {
    expect(formFromSeed({ path: 'a.b', value: { k: 1 }, url: '/x', target: 'both' })).toMatchObject(
      {
        kind: 'jsonPath',
        path: 'a.b',
        value: '{"k":1}',
        valueType: 'json',
        url: '/x',
        target: 'both',
        enabled: true
      }
    )
    expect(formFromSeed({}).target).toBe('request')
  })
})

describe('validateRuleForm', () => {
  it('requires at least one marker for a text rule', () => {
    const error = validateRuleForm(createEmptyForm('both'))
    expect(error?.title).toBe('Missing match boundaries')
    expect(validateRuleForm({ ...createEmptyForm('both'), endVariantsText: '\n x ' })).toBeNull()
  })

  it('requires URL, path and a file in file mode for a JSONPath rule', () => {
    const base = { ...createEmptyForm(), kind: /** @type {const} */ ('jsonPath') }
    expect(validateRuleForm({ ...base, url: '/u' })?.title).toBe('Missing fields')
    expect(validateRuleForm({ ...base, path: 'p' })?.title).toBe('Missing fields')
    expect(validateRuleForm({ ...base, url: '/u', path: 'p', jsonValueMode: 'file' })?.title).toBe(
      'Missing file'
    )
    expect(
      validateRuleForm({
        ...base,
        url: '/u',
        path: 'p',
        jsonValueMode: 'file',
        jsonValueFileToken: 'C:\\v.txt'
      })
    ).toBeNull()
    expect(validateRuleForm({ ...base, url: '/u', path: 'p' })).toBeNull()
  })
})

describe('payload builders', () => {
  it('sends the marker lines as variants and the enabled flag', () => {
    const form = {
      ...createEmptyForm('both'),
      name: 'n',
      startVariantsText: 'a\n\n b ',
      endVariantsText: '',
      replacement: 'r',
      enabled: false
    }
    expect(buildRulePayload(form)).toEqual({
      kind: 'text',
      name: 'n',
      replacement: 'r',
      useRegex: false,
      caseSensitive: false,
      url: '',
      target: 'both',
      startVariants: ['a', 'b'],
      endVariants: [],
      enabled: false
    })
    expect(buildPresetRule(form)).not.toHaveProperty('enabled')
  })

  it('coerces JSONPath values and stringifies JSON ones', () => {
    const base = {
      ...createEmptyForm(),
      kind: /** @type {const} */ ('jsonPath'),
      url: '/u',
      path: 'p'
    }
    expect(buildRulePayload({ ...base, value: '12' })).toMatchObject({
      value: 12,
      valueType: 'number',
      valueSource: null,
      target: 'request',
      enabled: true
    })
    expect(buildRulePayload({ ...base, value: '{"a":1}' })).toMatchObject({
      value: '{"a":1}',
      valueType: 'json'
    })
    expect(
      buildRulePayload({
        ...base,
        jsonValueMode: 'file',
        jsonValueFileToken: 'C:\\v.txt',
        jsonValueFileName: 'v.txt',
        valueType: 'string'
      })
    ).toMatchObject({
      value: '',
      valueSource: { type: 'file', path: 'C:\\v.txt', originalName: 'v.txt' }
    })
  })
})

/**
 * A stable empty list: a new array per render would re-run the preset effect.
 * @type {EditRulePreset[]}
 */
const NO_PRESETS = []

describe('useRuleForm', () => {
  afterEach(() => {
    useProxyStore.setState({ jsonPathRuleSeed: null })
  })

  it('starts closed and opens on a new text rule targeting both', () => {
    const { result } = renderHook(() => useRuleForm({ presets: NO_PRESETS }))
    expect(result.current.isOpen).toBe(false)
    expect(result.current.formData.target).toBe('request')
    act(() => result.current.startCreate())
    expect(result.current.isCreating).toBe(true)
    expect(result.current.isOpen).toBe(true)
    expect(result.current.formData.target).toBe('both')
    act(() => result.current.updateForm({ name: 'x' }))
    expect(result.current.formData.name).toBe('x')
    act(() => result.current.cancel())
    expect(result.current.isOpen).toBe(false)
    expect(result.current.formData).toEqual(createEmptyForm('request'))
  })

  it('edits a rule and switches to another one', () => {
    const { result } = renderHook(() => useRuleForm({ presets: NO_PRESETS }))
    act(() => result.current.startEdit(textRule))
    expect(result.current.editingRuleId).toBe('rule-1')
    expect(result.current.isCreating).toBe(false)
    expect(result.current.formData.replacement).toBe('Proxied')
    act(() => result.current.startEdit(jsonRule))
    expect(result.current.editingRuleId).toBe('rule-2')
    expect(result.current.formData.kind).toBe('jsonPath')
  })

  it('applies the selected preset and scopes the dropdown to the form', () => {
    /** @type {EditRulePreset} */
    const other = { ...preset, id: 'preset-2', rule: { ...preset.rule, target: 'request' } }
    const presets = [preset, other]
    const { result } = renderHook(() => useRuleForm({ presets }))
    act(() => result.current.startCreate())
    expect(result.current.groupedPresets).toEqual([['Both', [preset]]])
    act(() => result.current.selectPreset('preset-1'))
    expect(result.current.selectedPresetId).toBe('preset-1')
    expect(result.current.formData.replacement).toBe('From preset')
    act(() => result.current.updateForm({ target: 'request' }))
    expect(result.current.groupedPresets).toEqual([['Request', [other]]])
  })

  it('opens a JSONPath form from the store seed and clears the seed', () => {
    useProxyStore.setState({
      jsonPathRuleSeed: {
        name: 'Seeded',
        path: 'data.id',
        value: true,
        url: '/api',
        target: 'both'
      }
    })
    const { result } = renderHook(() => useRuleForm({ presets: NO_PRESETS }))
    expect(result.current.isCreating).toBe(true)
    expect(result.current.editingRuleId).toBeNull()
    expect(result.current.formData).toMatchObject({
      kind: 'jsonPath',
      name: 'Seeded',
      path: 'data.id',
      value: 'true',
      valueType: 'boolean',
      url: '/api',
      target: 'both'
    })
    expect(useProxyStore.getState().jsonPathRuleSeed).toBeNull()
  })
})
