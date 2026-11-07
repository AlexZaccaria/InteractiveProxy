import { describe, expect, it } from 'vitest'
import {
  areStringArraysEqual,
  buildGroupedPresets,
  buildMarkerList,
  coerceJsonPathScalar,
  doesPresetMatchRuleCriteria,
  doesRuleMatchPreset,
  findMatchingPresetId,
  getPresetGroupLabel,
  getRulePreviewText,
  groupPresetsForRule,
  normalizeJsonPathFormValue,
  normalizeRuleTarget,
  parseVariantLines,
  truncatePresetLabel
} from './presets'

/** @typedef {import('../../lib/types').EditRulePreset} EditRulePreset */

/**
 * @param {Partial<EditRulePreset>} overrides
 * @returns {EditRulePreset}
 */
function makePreset(overrides = {}) {
  return {
    id: 'p1',
    name: 'Preset',
    kind: 'text',
    rule: { replacement: 'x', url: '', target: 'both', startVariants: ['a'] },
    createdAt: '2026-11-07T00:00:00.000Z',
    ...overrides
  }
}

describe('parseVariantLines / buildMarkerList', () => {
  it('splits lines, trims them and drops the empty ones', () => {
    expect(parseVariantLines(' a \r\n\n b\n')).toEqual(['a', 'b'])
    expect(parseVariantLines('')).toEqual([])
    expect(parseVariantLines(null)).toEqual([])
  })

  it('keeps unique trimmed markers in order', () => {
    expect(buildMarkerList([' a ', 'b', 'a', '', null, 7])).toEqual(['a', 'b', '7'])
    expect(buildMarkerList(undefined)).toEqual([])
  })
})

describe('getRulePreviewText', () => {
  it('previews the replacement of a text rule and truncates long ones', () => {
    expect(getRulePreviewText({ kind: 'text', replacement: 'hello' })).toBe('hello')
    expect(getRulePreviewText({ kind: 'text', replacement: '' })).toBe('(empty)')
    expect(getRulePreviewText(null)).toBe('(empty)')
    const long = 'x'.repeat(301)
    expect(getRulePreviewText({ kind: 'text', replacement: long })).toBe('x'.repeat(300) + '…')
    expect(getRulePreviewText({ kind: 'text', replacement: long }, { truncate: false })).toBe(long)
    expect(getRulePreviewText({ kind: 'text', replacement: 'abcdef' }, { maxLength: 3 })).toBe(
      'abc…'
    )
  })

  it('previews JSONPath values and file sources', () => {
    expect(getRulePreviewText({ kind: 'jsonPath', value: 42 })).toBe('42')
    expect(getRulePreviewText({ kind: 'jsonPath', value: null })).toBe('(empty)')
    expect(
      getRulePreviewText({
        kind: 'jsonPath',
        valueSource: { type: 'file', path: 'C:\\data\\value.txt' }
      })
    ).toBe('(File Content) value.txt')
    expect(
      getRulePreviewText({
        kind: 'jsonPath',
        valueSource: { type: 'file', filename: 'stored.txt', originalName: 'mine.txt' }
      })
    ).toBe('(File Content) mine.txt')
    expect(getRulePreviewText({ kind: 'jsonPath', valueSource: { type: 'file' } })).toBe(
      '(File Content) file reference'
    )
  })
})

describe('truncatePresetLabel / getPresetGroupLabel', () => {
  it('truncates labels and shows a dash for empty ones', () => {
    expect(truncatePresetLabel('')).toBe('—')
    expect(truncatePresetLabel('  short ')).toBe('short')
    expect(truncatePresetLabel('a'.repeat(40))).toBe('a'.repeat(32) + '…')
    expect(truncatePresetLabel('abcdef', 4)).toBe('abcd…')
  })

  it('labels by target, by path and by replacement', () => {
    const text = makePreset()
    const json = makePreset({
      kind: 'jsonPath',
      rule: { path: 'data.user', url: '/api', target: 'response', value: 'v' }
    })
    const file = makePreset({
      kind: 'jsonPath',
      rule: { path: 'p', valueSource: { type: 'file', originalName: 'f.txt' } }
    })
    expect(getPresetGroupLabel(text, 'mode')).toBe('Both')
    expect(getPresetGroupLabel(json, 'mode')).toBe('Response')
    expect(getPresetGroupLabel(file, 'mode')).toBe('Request')
    expect(getPresetGroupLabel(null, 'mode')).toBe('Request')
    expect(getPresetGroupLabel(text, 'path')).toBe('Any URL')
    expect(getPresetGroupLabel(json, 'path')).toBe('data.user')
    expect(getPresetGroupLabel(text, 'replaceKey')).toBe('x')
    expect(getPresetGroupLabel(makePreset({ rule: {} }), 'replaceKey')).toBe('Empty replacement')
    expect(getPresetGroupLabel(json, 'replaceKey')).toBe('v')
    expect(getPresetGroupLabel(file, 'replaceKey')).toBe('File: f.txt')
  })
})

describe('normalizeRuleTarget / doesPresetMatchRuleCriteria', () => {
  it('defaults text rules to both and JSONPath rules to request', () => {
    expect(normalizeRuleTarget(undefined, 'text')).toBe('both')
    expect(normalizeRuleTarget('request', 'text')).toBe('request')
    expect(normalizeRuleTarget(undefined, 'jsonPath')).toBe('request')
    expect(normalizeRuleTarget('both', 'jsonPath')).toBe('both')
    expect(normalizeRuleTarget('weird', undefined)).toBe('request')
  })

  it('matches on URL, normalized target and JSON path', () => {
    const preset = makePreset({ rule: { url: ' /api ', target: 'both' } })
    expect(doesPresetMatchRuleCriteria(preset, { kind: 'text', url: '/api' })).toBe(true)
    expect(doesPresetMatchRuleCriteria(preset, { kind: 'text', url: '/other' })).toBe(false)
    expect(
      doesPresetMatchRuleCriteria(preset, { kind: 'text', url: '/api', target: 'request' })
    ).toBe(false)
    expect(doesPresetMatchRuleCriteria(preset, { kind: 'jsonPath', url: '/api' })).toBe(false)
    const json = makePreset({ kind: 'jsonPath', rule: { url: '/api', path: 'a.b' } })
    expect(doesPresetMatchRuleCriteria(json, { kind: 'jsonPath', url: '/api', path: 'a.b' })).toBe(
      true
    )
    expect(doesPresetMatchRuleCriteria(json, { kind: 'jsonPath', url: '/api', path: 'a.c' })).toBe(
      false
    )
    expect(doesPresetMatchRuleCriteria(null, { kind: 'text' })).toBe(false)
    expect(doesPresetMatchRuleCriteria(preset, null)).toBe(false)
  })
})

describe('buildGroupedPresets / groupPresetsForRule', () => {
  it('groups by target with the groups sorted by label', () => {
    const response = makePreset({ id: 'r', rule: { target: 'response' } })
    const both = makePreset({ id: 'b', rule: { target: 'both' } })
    const request = makePreset({ id: 'q', rule: {} })
    const groups = buildGroupedPresets([response, both, request, /** @type {any} */ (null)])
    expect(groups.map(([label]) => label)).toEqual(['Both', 'Request', 'Response'])
    expect(groups[1][1]).toEqual([request])
  })

  it('keeps only the presets that apply to the rule', () => {
    const match = makePreset({ id: 'm', rule: { url: '/api', target: 'request' } })
    const other = makePreset({ id: 'o', rule: { url: '/api', target: 'response' } })
    const groups = groupPresetsForRule([match, other], {
      kind: 'text',
      url: '/api',
      target: 'request'
    })
    expect(groups).toEqual([['Request', [match]]])
  })
})

describe('areStringArraysEqual / doesRuleMatchPreset / findMatchingPresetId', () => {
  it('compares arrays regardless of order and blanks', () => {
    expect(areStringArraysEqual(['a', ' b '], ['b', 'a', ''])).toBe(true)
    expect(areStringArraysEqual(['a'], ['a', 'c'])).toBe(false)
    expect(areStringArraysEqual(null, [])).toBe(true)
  })

  it('matches a text rule against a preset definition', () => {
    const preset = makePreset({
      rule: {
        replacement: 'x',
        useRegex: false,
        caseSensitive: false,
        url: '',
        target: 'both',
        startVariants: ['a'],
        endVariants: []
      }
    })
    const rule = {
      kind: /** @type {const} */ ('text'),
      replacement: 'x',
      useRegex: false,
      caseSensitive: false,
      target: /** @type {const} */ ('both'),
      startVariants: ['a']
    }
    expect(doesRuleMatchPreset(rule, preset)).toBe(true)
    expect(doesRuleMatchPreset({ ...rule, replacement: 'y' }, preset)).toBe(false)
    expect(doesRuleMatchPreset({ ...rule, useRegex: true }, preset)).toBe(false)
    expect(doesRuleMatchPreset({ ...rule, kind: 'jsonPath' }, preset)).toBe(false)
    expect(doesRuleMatchPreset(null, preset)).toBe(false)
  })

  it('matches a JSONPath rule by path, value and file source', () => {
    const preset = makePreset({
      kind: 'jsonPath',
      rule: { path: 'a', url: '/u', target: 'request', valueType: 'json', value: { k: 1 } }
    })
    const rule = {
      kind: /** @type {const} */ ('jsonPath'),
      path: 'a',
      url: '/u',
      target: /** @type {const} */ ('request'),
      valueType: /** @type {const} */ ('json'),
      value: { k: 1 }
    }
    expect(doesRuleMatchPreset(rule, preset)).toBe(true)
    expect(doesRuleMatchPreset({ ...rule, value: { k: 2 } }, preset)).toBe(false)
    const filePreset = makePreset({
      kind: 'jsonPath',
      rule: { path: 'a', valueSource: { type: 'file', path: 'C:\\f.txt' } }
    })
    expect(
      doesRuleMatchPreset(
        { kind: 'jsonPath', path: 'a', valueSource: { type: 'file', path: 'C:\\f.txt' } },
        filePreset
      )
    ).toBe(true)
    expect(
      doesRuleMatchPreset(
        { kind: 'jsonPath', path: 'a', valueSource: { type: 'file', path: 'C:\\g.txt' } },
        filePreset
      )
    ).toBe(false)
  })

  it('finds the first applicable preset the rule matches', () => {
    const wrongScope = makePreset({ id: 'w', rule: { replacement: 'x', target: 'request' } })
    const match = makePreset({ id: 'm', rule: { replacement: 'x', target: 'both' } })
    const rule = {
      kind: /** @type {const} */ ('text'),
      replacement: 'x',
      target: /** @type {const} */ ('both')
    }
    expect(findMatchingPresetId([wrongScope, match], rule)).toBe('m')
    expect(findMatchingPresetId([wrongScope], rule)).toBe('')
  })
})

describe('coerceJsonPathScalar / normalizeJsonPathFormValue', () => {
  it('coerces booleans, numbers, JSON and strings in that order', () => {
    expect(coerceJsonPathScalar(' TRUE ')).toEqual({ value: true, valueType: 'boolean' })
    expect(coerceJsonPathScalar('false')).toEqual({ value: false, valueType: 'boolean' })
    expect(coerceJsonPathScalar('42.5')).toEqual({ value: 42.5, valueType: 'number' })
    expect(coerceJsonPathScalar('{"a":1}')).toEqual({ value: { a: 1 }, valueType: 'json' })
    expect(coerceJsonPathScalar('[1,2]')).toEqual({ value: [1, 2], valueType: 'json' })
    expect(coerceJsonPathScalar('"quoted"')).toEqual({ value: '"quoted"', valueType: 'string' })
    expect(coerceJsonPathScalar('null')).toEqual({ value: 'null', valueType: 'string' })
    expect(coerceJsonPathScalar('plain text')).toEqual({ value: 'plain text', valueType: 'string' })
    expect(coerceJsonPathScalar('')).toEqual({ value: '', valueType: 'string' })
    expect(coerceJsonPathScalar(undefined)).toEqual({ value: '', valueType: 'string' })
  })

  it('turns a stored value back into form text and type', () => {
    expect(normalizeJsonPathFormValue(true)).toEqual({ valueText: 'true', valueType: 'boolean' })
    expect(normalizeJsonPathFormValue(7)).toEqual({ valueText: '7', valueType: 'number' })
    expect(normalizeJsonPathFormValue('12')).toEqual({ valueText: '12', valueType: 'number' })
    expect(normalizeJsonPathFormValue('abc')).toEqual({ valueText: 'abc', valueType: 'string' })
    expect(normalizeJsonPathFormValue({ a: 1 })).toEqual({
      valueText: '{"a":1}',
      valueType: 'json'
    })
    expect(normalizeJsonPathFormValue(null)).toEqual({ valueText: '', valueType: 'string' })
    expect(normalizeJsonPathFormValue(undefined)).toEqual({ valueText: '', valueType: 'string' })
  })
})
