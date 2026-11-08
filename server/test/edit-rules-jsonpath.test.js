'use strict'

/**
 * Characterization tests for JSONPath edit rules: path grammar, value
 * coercion, normalization, cache rules and application to objects and to
 * JSON HTTP bodies (plain and gzip). Behavior is asserted as observed in
 * server/index.js; oddities are marked "current behavior".
 */

const { test, describe, before } = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('zlib')
const { loadServer } = require('./helpers/load-server')

let internals
let writeStorageFile

const loadRules = rules => {
  writeStorageFile('edit-rules.json', rules)
  internals.loadEditRules()
  internals.rebuildEditRuleCache()
}

before(async () => {
  const loaded = await loadServer()
  internals = loaded.proxy.internals
  writeStorageFile = loaded.writeStorageFile
})

describe('parseJsonPath', () => {
  const key = key => ({ type: 'key', key })
  const index = index => ({ type: 'index', index })

  test('accepts root./$. prefixes, dotted keys, numeric indices and filters', () => {
    assert.deepEqual(internals.parseJsonPath('root.f2'), [key('f2')])
    assert.deepEqual(internals.parseJsonPath('$.a.b'), [key('a'), key('b')])
    assert.deepEqual(internals.parseJsonPath('a.b.c'), [key('a'), key('b'), key('c')])
    assert.deepEqual(internals.parseJsonPath('root.items[3].name'), [
      key('items'),
      index(3),
      key('name')
    ])
    assert.deepEqual(internals.parseJsonPath('root[0]'), [index(0)])
    assert.deepEqual(internals.parseJsonPath('$[1].x'), [index(1), key('x')])
    assert.deepEqual(internals.parseJsonPath('root.a[?(@.id=="x")].name'), [
      key('a'),
      { type: 'filter', key: 'id', value: 'x' },
      key('name')
    ])
  })

  test('root alone, empty, blank and non-string input give no segments', () => {
    for (const input of ['root', '$', '', '  ', null, undefined, 5]) {
      assert.deepEqual(internals.parseJsonPath(input), [], `input ${JSON.stringify(input)}`)
    }
  })

  test('malformed brackets give no segments; stray dots are tolerated', () => {
    for (const input of ['root.a[', 'root.a[]', 'root.a[-1]', 'root.a[abc]', 'root.a[?(@.id)]']) {
      assert.deepEqual(internals.parseJsonPath(input), [], `input ${input}`)
    }
    // current behavior: "root..a" and "root.a." both parse as root.a
    assert.deepEqual(internals.parseJsonPath('root..a'), [key('a')])
    assert.deepEqual(internals.parseJsonPath('root.a.'), [key('a')])
  })
})

describe('coerceJsonPathScalarFromText', () => {
  test('recognizes booleans, numbers and JSON containers, everything else is a string', () => {
    assert.deepEqual(internals.coerceJsonPathScalarFromText('true'), {
      value: true,
      valueType: 'boolean'
    })
    assert.deepEqual(internals.coerceJsonPathScalarFromText(' FALSE '), {
      value: false,
      valueType: 'boolean'
    })
    assert.deepEqual(internals.coerceJsonPathScalarFromText('42'), {
      value: 42,
      valueType: 'number'
    })
    assert.deepEqual(internals.coerceJsonPathScalarFromText('4.5'), {
      value: 4.5,
      valueType: 'number'
    })
    assert.deepEqual(internals.coerceJsonPathScalarFromText('1e3'), {
      value: 1000,
      valueType: 'number'
    })
    assert.deepEqual(internals.coerceJsonPathScalarFromText('{"a":1}'), {
      value: { a: 1 },
      valueType: 'json'
    })
    assert.deepEqual(internals.coerceJsonPathScalarFromText('[1]'), {
      value: [1],
      valueType: 'json'
    })
    assert.deepEqual(internals.coerceJsonPathScalarFromText('hello'), {
      value: 'hello',
      valueType: 'string'
    })
    // current behavior: the text "null" stays a string, it is not the null type
    assert.deepEqual(internals.coerceJsonPathScalarFromText('null'), {
      value: 'null',
      valueType: 'string'
    })
    // the original (untrimmed) text is kept for strings
    assert.deepEqual(internals.coerceJsonPathScalarFromText('  '), {
      value: '  ',
      valueType: 'string'
    })
    assert.deepEqual(internals.coerceJsonPathScalarFromText(null), {
      value: '',
      valueType: 'string'
    })
  })
})

describe('normalizeEditRule (jsonPath)', () => {
  test('keeps valid valueType/target, defaults target to request and value to empty string', () => {
    const rule = internals.normalizeEditRule({
      kind: 'jsonPath',
      path: 'root.f1',
      value: 5,
      valueType: 'number',
      url: '/a',
      target: 'both'
    })
    assert.match(rule.id, /^[0-9a-f-]{36}$/)
    assert.deepEqual(
      { ...rule, id: 'x' },
      {
        id: 'x',
        enabled: true,
        kind: 'jsonPath',
        name: '',
        path: 'root.f1',
        value: 5,
        valueType: 'number',
        valueSource: null,
        url: '/a',
        target: 'both'
      }
    )

    const bad = internals.normalizeEditRule({
      kind: 'jsonPath',
      valueType: 'weird',
      target: 'weird'
    })
    assert.equal(bad.valueType, 'string')
    assert.equal(bad.target, 'request')
    assert.equal(bad.path, '')
    assert.equal(bad.value, '')
  })

  test('a file valueSource replaces the inline value with an empty string', () => {
    const rule = internals.normalizeEditRule({
      kind: 'jsonPath',
      path: 'root.f1',
      value: 'v',
      valueSource: { type: 'file', filename: 'f.txt' }
    })
    assert.equal(rule.value, '')
    assert.deepEqual(rule.valueSource, { type: 'file', filename: 'f.txt' })
    assert.equal(
      internals.normalizeEditRule({ kind: 'jsonPath', valueSource: { type: 'other' } }).valueSource,
      null
    )
  })
})

describe('rule cache and applyJsonPathRulesToObject', () => {
  const sample = () => ({
    name: 'orig',
    n: 1,
    b: false,
    z: 1,
    o: { old: true },
    o2: 'str',
    items: [
      { id: 'a', name: 'first' },
      { id: 'b', name: 'orig2' }
    ],
    n2: 5,
    same: 'same',
    deep: { inner: 'x' }
  })

  before(() => {
    loadRules([
      {
        id: 'j-str',
        kind: 'jsonPath',
        path: 'root.name',
        value: 'Z',
        url: '/v1',
        target: 'request'
      },
      {
        id: 'j-num',
        kind: 'jsonPath',
        path: 'root.n',
        value: '7',
        valueType: 'number',
        url: '/v1',
        target: 'both'
      },
      {
        id: 'j-bool',
        kind: 'jsonPath',
        path: 'root.b',
        value: 'true',
        valueType: 'boolean',
        url: '/v1',
        target: 'response'
      },
      {
        id: 'j-null',
        kind: 'jsonPath',
        path: 'root.z',
        value: 'whatever',
        valueType: 'null',
        url: '/v1'
      },
      {
        id: 'j-json',
        kind: 'jsonPath',
        path: 'root.o',
        value: '{"k":1}',
        valueType: 'json',
        url: '/v1'
      },
      { id: 'j-objstr', kind: 'jsonPath', path: 'root.o2', value: '[1,2]', url: '/v1' },
      { id: 'j-new', kind: 'jsonPath', path: 'root.missing', value: 'x', url: '/v1' },
      { id: 'j-idx', kind: 'jsonPath', path: 'root.items[1].name', value: 'second', url: '/v1' },
      {
        id: 'j-filter',
        kind: 'jsonPath',
        path: "root.items[?(@.id=='a')].name",
        value: 'filtered',
        url: '/v1'
      },
      { id: 'j-nourl', kind: 'jsonPath', path: 'root.name', value: 'NOURL' },
      { id: 'j-badpath', kind: 'jsonPath', path: 'root.a[', value: 'x', url: '/v1' },
      {
        id: 'j-badnum',
        kind: 'jsonPath',
        path: 'root.n2',
        value: 'abc',
        valueType: 'number',
        url: '/v1'
      },
      { id: 'j-same', kind: 'jsonPath', path: 'root.same', value: 'same', url: '/v1' },
      { id: 'j-deep', kind: 'jsonPath', path: 'root.deep.inner', value: 'D', url: '/v1' },
      {
        id: 'j-disabled',
        kind: 'jsonPath',
        path: 'root.name',
        value: 'DISABLED',
        url: '/v1',
        enabled: false
      },
      { id: 't-text', kind: 'text', startVariants: ['x'], replacement: 'y' }
    ])
  })

  test('rules without a URL, with an unparsable path or disabled are not compiled; text rules go to the other cache', () => {
    const compiled = internals
      .getCompiledJsonPathRules()
      .map(r => [r.id, r.valueType, r.target, r.url])
    assert.deepEqual(compiled, [
      ['j-str', 'string', 'request', '/v1'],
      ['j-num', 'number', 'both', '/v1'],
      ['j-bool', 'boolean', 'response', '/v1'],
      ['j-null', 'null', 'request', '/v1'],
      ['j-json', 'json', 'request', '/v1'],
      ['j-objstr', 'string', 'request', '/v1'],
      ['j-new', 'string', 'request', '/v1'],
      ['j-idx', 'string', 'request', '/v1'],
      ['j-filter', 'string', 'request', '/v1'],
      ['j-badnum', 'number', 'request', '/v1'],
      ['j-same', 'string', 'request', '/v1'],
      ['j-deep', 'string', 'request', '/v1']
    ])
    assert.deepEqual(
      internals.getCompiledRules().map(c => c.rule.id),
      ['t-text']
    )
  })

  test('request phase: typed values, index, filter and nested paths are applied in place', () => {
    const root = sample()
    const result = internals.applyJsonPathRulesToObject(root, {
      requestUrl: '/v1/users',
      fullUrl: 'https://h/v1/users',
      phase: 'request'
    })
    assert.equal(result.object, root)
    assert.equal(result.changed, true)
    assert.deepEqual(result.appliedRuleIds, [
      'j-str',
      'j-num',
      'j-null',
      'j-json',
      'j-objstr',
      'j-idx',
      'j-filter',
      'j-deep'
    ])
    assert.deepEqual(root, {
      name: 'Z',
      n: 7,
      b: false, // response-only rule
      z: null,
      o: { k: 1 },
      o2: '[1,2]', // current value is a string, so the value is kept as text
      items: [
        { id: 'a', name: 'filtered' },
        { id: 'b', name: 'second' }
      ],
      n2: 5, // "abc" is not a number: rule skipped
      same: 'same', // identical value: not counted as applied
      deep: { inner: 'D' }
    })
    // missing keys are never created
    assert.equal(Object.hasOwn(root, 'missing'), false)
  })

  test('response phase applies response and both targets only; missing phase means request', () => {
    const response = internals.applyJsonPathRulesToObject(sample(), {
      requestUrl: '/v1/users',
      phase: 'response'
    })
    assert.deepEqual(response.appliedRuleIds, ['j-num', 'j-bool'])
    assert.equal(response.object.b, true)
    assert.equal(response.object.name, 'orig')

    const noPhase = internals.applyJsonPathRulesToObject(sample(), { requestUrl: '/v1/users' })
    assert.deepEqual(noPhase.appliedRuleIds, [
      'j-str',
      'j-num',
      'j-null',
      'j-json',
      'j-objstr',
      'j-idx',
      'j-filter',
      'j-deep'
    ])
  })

  test('nothing applies without a matching URL, without a context or on non-object roots', () => {
    for (const [root, context] of [
      [sample(), { requestUrl: '/v2/users' }],
      [sample(), undefined],
      ['str', { requestUrl: '/v1' }]
    ]) {
      const result = internals.applyJsonPathRulesToObject(root, context)
      assert.deepEqual(result.appliedRuleIds, [])
      assert.equal(result.changed, false)
    }
    // an array root never matches a rule whose first segment is a key
    const array = internals.applyJsonPathRulesToObject([{ id: 'a', name: 'q' }], {
      requestUrl: '/v1'
    })
    assert.equal(array.changed, false)
  })

  test('a string value on an object target is parsed as JSON when possible, else kept as text', () => {
    const fallback = internals.applyJsonPathRulesToObject(
      { name: { nested: true } },
      { requestUrl: '/v1' }
    )
    assert.deepEqual(fallback.object, { name: 'Z' })

    loadRules([
      { id: 'obj', kind: 'jsonPath', path: 'root.name', value: '{"parsed":1}', url: '/v1' }
    ])
    const parsed = internals.applyJsonPathRulesToObject(
      { name: { nested: true } },
      { requestUrl: '/v1' }
    )
    assert.deepEqual(parsed.object, { name: { parsed: 1 } })
  })
})

describe('rewriteJsonHttpBody', () => {
  const body = () => Buffer.from(JSON.stringify({ name: 'orig', nested: '{"inner":1}', n: 1 }))

  before(() => {
    loadRules([
      {
        id: 'j-str',
        kind: 'jsonPath',
        path: 'root.name',
        value: 'Z',
        url: '/v1',
        target: 'request'
      },
      {
        id: 'j-num',
        kind: 'jsonPath',
        path: 'root.n',
        value: '7',
        valueType: 'number',
        url: '/v1',
        target: 'both'
      }
    ])
  })

  test('plain JSON: rewritten buffer, json, beforeJson and applied ids', () => {
    const result = internals.rewriteJsonHttpBody({
      buffer: body(),
      contentType: 'application/json; charset=utf-8',
      urlContext: { requestUrl: '/v1/a', fullUrl: 'https://h/v1/a' },
      phase: 'request'
    })
    assert.equal(result.changed, true)
    assert.deepEqual(result.appliedRuleIds, ['j-str', 'j-num'])
    // the forwarded body keeps a string field that holds JSON as a string;
    // only the json/beforeJson views are normalized (nested JSON shown as objects)
    assert.equal(result.buffer.toString(), '{"name":"Z","nested":"{\\"inner\\":1}","n":7}')
    assert.deepEqual(result.json, { name: 'Z', nested: { inner: 1 }, n: 7 })
    assert.deepEqual(result.beforeJson, { name: 'orig', nested: { inner: 1 }, n: 1 })
    assert.equal(result.decompressed, null)
  })

  test('gzip body is decompressed, rewritten and recompressed', () => {
    const result = internals.rewriteJsonHttpBody({
      buffer: zlib.gzipSync(body()),
      encoding: 'gzip',
      contentType: 'application/json',
      urlContext: { requestUrl: '/v1/a' },
      phase: 'request'
    })
    assert.equal(result.changed, true)
    assert.equal(result.buffer[0], 0x1f)
    assert.equal(
      zlib.gunzipSync(result.buffer).toString(),
      '{"name":"Z","nested":"{\\"inner\\":1}","n":7}'
    )
    assert.equal(result.decompressed.toString(), '{"name":"Z","nested":"{\\"inner\\":1}","n":7}')
    assert.deepEqual(result.json, { name: 'Z', nested: { inner: 1 }, n: 7 })
  })

  test('non-JSON content type, malformed JSON and empty buffers pass through', () => {
    const original = body()
    const text = internals.rewriteJsonHttpBody({
      buffer: original,
      contentType: 'text/plain',
      urlContext: { requestUrl: '/v1/a' }
    })
    assert.equal(text.changed, false)
    assert.equal(text.json, null)
    assert.equal(text.buffer, original)

    const malformed = internals.rewriteJsonHttpBody({
      buffer: Buffer.from('{bad'),
      contentType: 'application/json',
      urlContext: { requestUrl: '/v1/a' }
    })
    assert.deepEqual(
      [malformed.changed, malformed.json, malformed.decompressed],
      [false, null, null]
    )

    const empty = Buffer.alloc(0)
    const result = internals.rewriteJsonHttpBody({ buffer: empty, contentType: 'application/json' })
    assert.deepEqual(result, {
      buffer: empty,
      json: null,
      appliedRuleIds: [],
      changed: false,
      decompressed: null
    })
  })

  test('no matching rule keeps the buffer but still returns the normalized json; captureBeforeJson=false returns the raw object', () => {
    const original = body()
    const noMatch = internals.rewriteJsonHttpBody({
      buffer: original,
      contentType: 'application/json',
      urlContext: { requestUrl: '/v2/a' }
    })
    assert.equal(noMatch.changed, false)
    assert.equal(noMatch.buffer, original)
    assert.deepEqual(noMatch.json, { name: 'orig', nested: { inner: 1 }, n: 1 })
    assert.deepEqual(noMatch.beforeJson, { name: 'orig', nested: { inner: 1 }, n: 1 })

    const noCapture = internals.rewriteJsonHttpBody({
      buffer: body(),
      contentType: 'application/json',
      urlContext: { requestUrl: '/v1/a' },
      captureBeforeJson: false
    })
    assert.equal(noCapture.beforeJson, null)
    assert.equal(noCapture.changed, true)
    // without the logging snapshot the json view is the object as forwarded
    assert.deepEqual(noCapture.json, { name: 'Z', nested: '{"inner":1}', n: 7 })
    assert.equal(noCapture.buffer.toString(), '{"name":"Z","nested":"{\\"inner\\":1}","n":7}')
  })

  test('a path into a string field that holds JSON does not match: the field is a string', () => {
    loadRules([
      {
        id: 'j-str',
        kind: 'jsonPath',
        path: 'root.name',
        value: 'Z',
        url: '/v1',
        target: 'request'
      },
      {
        id: 'j-inner',
        kind: 'jsonPath',
        path: 'root.nested.inner',
        value: '9',
        valueType: 'number',
        url: '/v1',
        target: 'both'
      }
    ])
    const result = internals.rewriteJsonHttpBody({
      buffer: body(),
      contentType: 'application/json',
      urlContext: { requestUrl: '/v1/a' },
      phase: 'request'
    })
    assert.deepEqual(result.appliedRuleIds, ['j-str'])
    assert.equal(result.buffer.toString(), '{"name":"Z","nested":"{\\"inner\\":1}","n":1}')
    assert.deepEqual(result.json, { name: 'Z', nested: { inner: 1 }, n: 1 })
  })
})

describe('on-disk representation', () => {
  test('segment arrays are joined on load; long values are split on save and round-trip', () => {
    loadRules([
      { id: 'seg', kind: 'jsonPath', path: 'root.v', value: ['part one', 'part two'], url: '/v1' }
    ])
    assert.equal(internals.getCompiledJsonPathRules()[0].value, 'part one part two')

    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    const onDisk = internals.serializeEditRuleForDisk({
      id: 'long',
      kind: 'jsonPath',
      path: 'root.v',
      value: long,
      url: '/v1'
    })
    assert.equal(Array.isArray(onDisk.value), true)
    assert.ok(onDisk.value.length > 1)
    assert.ok(onDisk.value.every(segment => segment.length <= 160))

    loadRules([onDisk])
    assert.equal(internals.getCompiledJsonPathRules()[0].value, long)
  })

  test('blank values are stored as empty strings', () => {
    assert.deepEqual(internals.serializeEditRuleForDisk({ kind: 'jsonPath', value: '   ' }), {
      kind: 'jsonPath',
      value: ''
    })
  })
})
