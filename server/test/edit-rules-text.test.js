'use strict'

/**
 * Characterization tests for text edit rules: normalization, on-disk
 * serialization, compilation and application to text, headers and buffers.
 * They assert the behavior observed in server/index.js as it is, including
 * the Phase 1b fixes (legacy start/end migration, invalid regex skipped,
 * host-scoped URL patterns).
 */

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { loadServer } = require('./helpers/load-server')

let proxy
let internals
let writeStorageFile
let baseUrl

const loadRules = rules => {
  writeStorageFile('edit-rules.json', rules)
  internals.loadEditRules()
  internals.rebuildEditRuleCache()
}

before(async () => {
  const loaded = await loadServer()
  proxy = loaded.proxy
  internals = proxy.internals
  writeStorageFile = loaded.writeStorageFile
  const address = await proxy.start()
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await proxy.stop()
})

describe('normalizeEditRule (text)', () => {
  test('fills defaults and generates a UUID id', () => {
    const rule = internals.normalizeEditRule({})
    assert.match(rule.id, /^[0-9a-f-]{36}$/)
    assert.deepEqual({ ...rule, id: 'x' }, {
      id: 'x',
      enabled: true,
      kind: 'text',
      name: '',
      replacement: '',
      useRegex: false,
      caseSensitive: false,
      url: '',
      startVariants: [],
      endVariants: [],
      target: 'both'
    })
  })

  test('trims variants, drops empty and non-string entries, keeps strict booleans only', () => {
    const rule = internals.normalizeEditRule({
      id: 'x',
      kind: 'text',
      startVariants: [' a ', '', 'b', 3, '   '],
      endVariants: null,
      target: 'request',
      useRegex: 'yes',
      caseSensitive: true,
      url: 42,
      enabled: false
    })
    assert.deepEqual(rule.startVariants, ['a', 'b'])
    assert.deepEqual(rule.endVariants, [])
    assert.equal(rule.target, 'request')
    assert.equal(rule.useRegex, false)
    assert.equal(rule.caseSensitive, true)
    assert.equal(rule.url, '')
    assert.equal(rule.enabled, false)
  })

  test('unknown target falls back to both; unknown kind becomes text', () => {
    assert.equal(internals.normalizeEditRule({ target: 'weird' }).target, 'both')
    assert.equal(internals.normalizeEditRule({ kind: 'other' }).kind, 'text')
  })

  test('legacy start/end markers are folded into the variant lists', () => {
    const rule = internals.normalizeEditRule({ start: 'legacy', end: 'x', replacement: 'r' })
    assert.equal(Object.hasOwn(rule, 'start'), false)
    assert.equal(Object.hasOwn(rule, 'end'), false)
    assert.deepEqual(rule.startVariants, ['legacy'])
    assert.deepEqual(rule.endVariants, ['x'])

    // explicit variants win over the legacy fields; blank legacy fields are dropped
    const mixed = internals.normalizeEditRule({ start: 'legacy', end: 'x', startVariants: ['v'], endVariants: [] })
    assert.deepEqual(mixed.startVariants, ['v'])
    assert.deepEqual(mixed.endVariants, ['x'])
    assert.deepEqual(internals.normalizeEditRule({ start: '  ', end: '' }).startVariants, [])
  })
})

describe('normalizeEditRulePreset', () => {
  test('trims the name, strips id/enabled from the rule and keeps createdAt', () => {
    const preset = internals.normalizeEditRulePreset({
      name: ' P ',
      kind: 'text',
      rule: { startVariants: ['x'], replacement: 'y', id: 'rid', enabled: false },
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    assert.match(preset.id, /^preset-\d+-[a-z0-9]+$/)
    assert.equal(preset.name, 'P')
    assert.equal(preset.kind, 'text')
    assert.equal(preset.createdAt, '2026-01-01T00:00:00.000Z')
    assert.deepEqual(preset.rule, {
      kind: 'text',
      name: '',
      replacement: 'y',
      useRegex: false,
      caseSensitive: false,
      url: '',
      startVariants: ['x'],
      endVariants: [],
      target: 'both'
    })
  })

  test('empty preset gets "Untitled preset", kind text and a fresh createdAt', () => {
    const preset = internals.normalizeEditRulePreset({})
    assert.equal(preset.name, 'Untitled preset')
    assert.equal(preset.kind, 'text')
    assert.match(preset.createdAt, /^\d{4}-\d{2}-\d{2}T/)
  })

  test('presets load from disk and are exposed by GET /api/edit-rule-presets', async () => {
    writeStorageFile('edit-rule-presets.json', [
      { id: 'p1', name: 'One', kind: 'jsonPath', rule: { path: 'root.a', value: 'v', url: '/x', id: 'rid', enabled: false } }
    ])
    internals.loadEditRulePresets()
    const response = await fetch(`${baseUrl}/api/edit-rule-presets`)
    const { presets } = await response.json()
    assert.equal(presets.length, 1)
    assert.equal(presets[0].id, 'p1')
    assert.equal(presets[0].rule.path, 'root.a')
    assert.equal(Object.hasOwn(presets[0].rule, 'id'), false)
    assert.equal(Object.hasOwn(presets[0].rule, 'enabled'), false)
  })
})

describe('serialization to disk', () => {
  test('splitLongStringIntoSegments splits on whitespace within maxLen', () => {
    assert.deepEqual(internals.splitLongStringIntoSegments('aaaa bbbb cccc dddd', 9), ['aaaa bbbb', 'cccc dddd'])
    assert.deepEqual(internals.splitLongStringIntoSegments('aaaaaaaaaaaa bb', 5), ['aaaaaaaaaaaa', 'bb'])
    assert.deepEqual(internals.splitLongStringIntoSegments('', 5), [])
  })

  test('text rules: replacement trimmed, legacy start/end dropped, short strings kept flat', () => {
    const out = internals.serializeEditRuleForDisk({ kind: 'text', replacement: '  r  ', start: 's', end: 'e', startVariants: ['s'] })
    assert.deepEqual(out, { kind: 'text', replacement: 'r', startVariants: ['s'] })
  })

  test('replacement longer than 160 chars becomes an array of segments', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    const out = internals.serializeEditRuleForDisk({ kind: 'text', replacement: long })
    assert.equal(Array.isArray(out.replacement), true)
    assert.ok(out.replacement.every(segment => segment.length <= 160))
    assert.equal(out.replacement.join(' '), long)
  })

  test('deserializeEditRuleFromDisk joins segment arrays of known string fields only', () => {
    const out = internals.deserializeEditRuleFromDisk({
      value: ['a', 'b'], replacement: ['x'], name: ['n', 'm'], path: ['p'], url: ['u'], other: ['keep']
    })
    assert.deepEqual(out, { value: 'a b', replacement: 'x', name: 'n m', path: 'p', url: 'u', other: ['keep'] })
  })
})

describe('replaceTextLiteral', () => {
  test('between mode replaces every start..end span', () => {
    assert.deepEqual(internals.replaceTextLiteral('a<x>b<y>c', '<', '>', '#', true), { text: 'a#b#c', count: 2 })
  })

  test('single marker mode replaces every occurrence, case-insensitive unless asked', () => {
    assert.deepEqual(internals.replaceTextLiteral('Foo foo FOO', 'foo', null, '_', false), { text: '_ _ _', count: 3 })
    assert.deepEqual(internals.replaceTextLiteral('Foo foo FOO', 'foo', null, '_', true), { text: 'Foo _ FOO', count: 1 })
    assert.deepEqual(internals.replaceTextLiteral('a.b.c', null, '.', '-', true), { text: 'a-b-c', count: 2 })
  })

  test('no markers or unterminated span leave the text untouched', () => {
    assert.deepEqual(internals.replaceTextLiteral('abc', '', '', 'x', true), { text: 'abc', count: 0 })
    assert.deepEqual(internals.replaceTextLiteral('a<x b', '<', '>', '#', true), { text: 'a<x b', count: 0 })
  })
})

describe('compileEditRule', () => {
  test('disabled rules and rules without markers compile to null', () => {
    assert.equal(internals.compileEditRule({ enabled: false, start: 'a' }), null)
    assert.equal(internals.compileEditRule({ enabled: true }), null)
  })

  test('regex rules build a global regex, lazy between-span, i flag unless case sensitive', () => {
    const between = internals.compileEditRule({ enabled: true, start: 'a', end: 'b', useRegex: true })
    assert.equal(between.mode, 'between')
    assert.equal(between.regex.source, 'a[\\s\\S]*?b')
    assert.equal(between.regex.flags, 'gi')

    const prefix = internals.compileEditRule({ enabled: true, start: 'a', useRegex: true, caseSensitive: true })
    assert.equal(prefix.mode, 'prefix')
    assert.equal(prefix.regex.flags, 'g')

    assert.equal(internals.compileEditRule({ enabled: true, end: 'z' }).mode, 'suffix')
  })

  test('an invalid regex throws SyntaxError', () => {
    assert.throws(() => internals.compileEditRule({ enabled: true, start: '(', useRegex: true }), SyntaxError)
  })

  test('rebuildEditRuleCache skips an invalid regex rule with a warning and keeps the others', () => {
    const originalWarn = console.warn
    const warnings = []
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      loadRules([
        { id: 'ok1', kind: 'text', startVariants: ['a'], replacement: 'b' },
        { id: 'bad', name: 'Broken', kind: 'text', startVariants: ['('], replacement: 'x', useRegex: true },
        { id: 'ok2', kind: 'text', startVariants: ['c'], replacement: 'd' }
      ])
    } finally {
      console.warn = originalWarn
    }
    assert.deepEqual(internals.getCompiledRules().map(c => c.rule.id), ['ok1', 'ok2'])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /^\[proxy\]\[edit-rules\] Skipping rule bad "Broken": Invalid regular expression/)
  })
})

describe('rule cache and application', () => {
  const context = (phase, fullUrl = 'https://api.example.com/v1/x') => ({ requestUrl: '/v1/x', fullUrl, phase })

  before(() => {
    loadRules([
      { id: 'plain', kind: 'text', startVariants: ['foo'], replacement: 'bar' },
      { id: 'between', kind: 'text', startVariants: ['<'], endVariants: ['>'], replacement: '#' },
      { id: 'cs', kind: 'text', startVariants: ['Hello'], replacement: 'Hi', caseSensitive: true },
      { id: 'rx', kind: 'text', startVariants: ['\\d+'], replacement: 'N', useRegex: true },
      { id: 'off', kind: 'text', startVariants: ['never'], replacement: 'x', enabled: false },
      { id: 'req', kind: 'text', startVariants: ['phase'], replacement: 'REQ', target: 'request' },
      { id: 'res', kind: 'text', startVariants: ['phase'], replacement: 'RES', target: 'response' },
      { id: 'scoped', kind: 'text', startVariants: ['scoped'], replacement: 'S', url: 'https://api.example.com/v1' },
      { id: 'legacy', kind: 'text', start: 'legacy', replacement: 'L' },
      { id: 'variants', kind: 'text', startVariants: ['[a]', '[b]'], endVariants: ['(1)', '(2)'], replacement: 'V' },
      { id: 'suffix', kind: 'text', endVariants: ['END'], replacement: 'E' }
    ])
  })

  test('variants expand to the cartesian product; disabled rules are not compiled, legacy start/end rules are', () => {
    const compiled = internals.getCompiledRules().map(c => [c.rule.id, c.mode, c.start, c.end])
    assert.deepEqual(compiled, [
      ['plain', 'prefix', 'foo', ''],
      ['between', 'between', '<', '>'],
      ['cs', 'prefix', 'Hello', ''],
      ['rx', 'prefix', '\\d+', ''],
      ['req', 'prefix', 'phase', ''],
      ['res', 'prefix', 'phase', ''],
      ['scoped', 'prefix', 'scoped', ''],
      // a rule written with legacy `start`/`end` (the on-disk format shown in
      // ARCHITECTURE.md) is migrated to variants and compiled like the others
      ['legacy', 'prefix', 'legacy', ''],
      ['variants', 'between', '[a]', '(1)'],
      ['variants', 'between', '[a]', '(2)'],
      ['variants', 'between', '[b]', '(1)'],
      ['variants', 'between', '[b]', '(2)'],
      ['suffix', 'suffix', '', 'END']
    ])
    assert.equal(internals.hasAnyEditOrJsonPathRules(), true)
  })

  test('without a context every compiled rule applies in order, ignoring target and URL', () => {
    const result = internals.applyEditRulesToText('foo <x> Hello hello 42 phase scoped legacy [a]..(2) zEND')
    // the regex rule turned "(2)" into "(N)" before the variants rule ran,
    // so the between span never matched: rules see the output of earlier rules
    assert.equal(result.text, 'bar # Hi hello N REQ S L [a]..(N) zE')
    assert.deepEqual(result.appliedRuleIds, ['plain', 'between', 'cs', 'rx', 'req', 'scoped', 'legacy', 'suffix'])
    assert.equal(result.changed, true)
  })

  test('phase selects request/response targets; both-rules always apply', () => {
    assert.deepEqual(internals.applyEditRulesToText('foo phase scoped', context('request')),
      { text: 'bar REQ S', appliedRuleIds: ['plain', 'req', 'scoped'], changed: true })
    assert.deepEqual(internals.applyEditRulesToText('foo phase scoped', context('response')),
      { text: 'bar RES S', appliedRuleIds: ['plain', 'res', 'scoped'], changed: true })
    // a context without phase counts as request
    assert.deepEqual(internals.applyEditRulesToText('phase', { requestUrl: '/x' }),
      { text: 'REQ', appliedRuleIds: ['req'], changed: true })
  })

  test('URL-scoped rules skip other hosts/paths', () => {
    assert.deepEqual(internals.applyEditRulesToText('scoped', { requestUrl: '/other', fullUrl: 'https://other.com/other', phase: 'request' }),
      { text: 'scoped', appliedRuleIds: [], changed: false })
    // the host of an absolute pattern must match: the relative requestUrl
    // candidate (no host) cannot satisfy it on its own
    assert.deepEqual(internals.applyEditRulesToText('scoped', { requestUrl: '/v1/x', fullUrl: 'https://other.com/v1/x', phase: 'request' }),
      { text: 'scoped', appliedRuleIds: [], changed: false })
    assert.deepEqual(internals.applyEditRulesToText('scoped', { requestUrl: '/v1/x', phase: 'request' }),
      { text: 'scoped', appliedRuleIds: [], changed: false })
    assert.deepEqual(internals.applyEditRulesToText('scoped', { requestUrl: '/v1/x', fullUrl: 'https://api.example.com/v1/x', phase: 'request' }),
      { text: 'S', appliedRuleIds: ['scoped'], changed: true })
  })

  test('getCompiledRulesForContext filters by phase and URL; null context returns everything', () => {
    const ids = internals.getCompiledRulesForContext(context('response')).map(c => c.rule.id)
    assert.deepEqual(ids, ['plain', 'between', 'cs', 'rx', 'res', 'scoped', 'legacy', 'variants', 'variants', 'variants', 'variants', 'suffix'])
    assert.equal(internals.getCompiledRulesForContext(null).length, 13)
  })

  test('empty or non-string input is returned untouched', () => {
    assert.deepEqual(internals.applyEditRulesToText(''), { text: '', appliedRuleIds: [], changed: false })
    assert.deepEqual(internals.applyEditRulesToText(5), { text: 5, appliedRuleIds: [], changed: false })
  })

  test('applyEditRulesToHeaders rewrites string and array values, passes other types through', () => {
    const result = internals.applyEditRulesToHeaders(
      { 'x-a': 'foo', 'x-b': ['foo', 'zzz', 7], 'x-c': 'none', 'x-n': 3 },
      { requestUrl: '/x', phase: 'request' }
    )
    assert.deepEqual(result, {
      headers: { 'x-a': 'bar', 'x-b': ['bar', 'zzz', 7], 'x-c': 'none', 'x-n': 3 },
      appliedRuleIds: ['plain'],
      changed: true
    })
    assert.deepEqual(internals.applyEditRulesToHeaders({ 'x-a': 'phase' }),
      { headers: { 'x-a': 'REQ' }, appliedRuleIds: ['req'], changed: true })
  })

  test('applyEditRulesToBuffer decodes UTF-8, rewrites and reports before/after text', () => {
    const result = internals.applyEditRulesToBuffer(Buffer.from('foo è <x>'), { requestUrl: '/x', phase: 'request' })
    assert.equal(result.buffer.toString('utf8'), 'bar è #')
    assert.deepEqual(result.appliedRuleIds, ['plain', 'between'])
    assert.equal(result.changed, true)
    assert.equal(result.beforeText, 'foo è <x>')
    assert.equal(result.afterText, 'bar è #')
  })

  test('applyEditRulesToBuffer skips binary-looking, empty and unchanged buffers', () => {
    const binary = Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0, 0, 102, 111, 111])
    const skipped = internals.applyEditRulesToBuffer(binary, { requestUrl: '/x' })
    assert.equal(skipped.changed, false)
    assert.equal(skipped.buffer, binary)

    const empty = Buffer.alloc(0)
    assert.equal(internals.applyEditRulesToBuffer(empty, {}).buffer, empty)

    const untouched = Buffer.from('nothing')
    const result = internals.applyEditRulesToBuffer(untouched, {})
    assert.equal(result.buffer, untouched)
    assert.deepEqual(result, { buffer: untouched, appliedRuleIds: [], changed: false })
  })

  test('regex between spans, case-insensitive default and whitespace-only variants', () => {
    loadRules([{ id: 'rb', kind: 'text', startVariants: ['<b>'], endVariants: ['</b>'], replacement: 'X', useRegex: true }])
    assert.equal(internals.applyEditRulesToText('a <b>1</b> b <b>2</b>').text, 'a X b X')

    loadRules([{ id: 'ci', kind: 'text', startVariants: ['ABC'], replacement: 'x' }])
    assert.equal(internals.applyEditRulesToText('abc Abc ABC').text, 'x x x')

    loadRules([
      { id: 'ws', kind: 'text', startVariants: ['  '], replacement: 'x' },
      { id: 'ws2', kind: 'text', startVariants: [' a '], replacement: 'x' }
    ])
    assert.deepEqual(internals.getCompiledRules().map(c => [c.rule.id, c.start]), [['ws2', 'a']])
  })

  test('the global edit-rules switch empties the compiled views without touching the rules', async () => {
    loadRules([{ id: 'sw', kind: 'text', startVariants: ['on'], replacement: 'off' }])
    assert.equal(internals.applyEditRulesToText('on').text, 'off')

    const disable = await fetch(`${baseUrl}/api/edit-rules-mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    })
    assert.equal(disable.status, 200)
    assert.deepEqual(internals.getCompiledRules(), [])
    assert.equal(internals.hasAnyEditOrJsonPathRules(), false)
    assert.equal(internals.applyEditRulesToText('on').changed, false)

    const enable = await fetch(`${baseUrl}/api/edit-rules-mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    })
    assert.equal(enable.status, 200)
    assert.equal(internals.applyEditRulesToText('on').text, 'off')
  })
})

describe('loadEditRules from disk', () => {
  test('a file that is not JSON resets the rules; a non-array file keeps the previous ones', () => {
    loadRules([{ id: 'x', kind: 'text', startVariants: ['a'], replacement: 'b' }])
    assert.deepEqual(internals.getCompiledRules().map(c => c.rule.id), ['x'])

    writeStorageFile('edit-rules.json', { not: 'array' })
    internals.loadEditRules()
    internals.rebuildEditRuleCache()
    assert.deepEqual(internals.getCompiledRules().map(c => c.rule.id), ['x'])

    require('fs').writeFileSync(proxy.files.EDIT_RULES_FILE, '{not json')
    internals.loadEditRules()
    internals.rebuildEditRuleCache()
    assert.deepEqual(internals.getCompiledRules(), [])
  })
})
