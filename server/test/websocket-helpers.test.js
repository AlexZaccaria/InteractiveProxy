'use strict'

// Characterization tests for the WebSocket helpers exposed by the server:
// URL conversion, payload normalisation, the Socket.IO / JSON helpers and the
// rewrite entry point. Framing is handled by `ws` and is covered by the
// integration tests.

const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const { loadServer } = require('./helpers/load-server')

let I

before(async () => {
  const { proxy } = await loadServer()
  I = proxy.internals
})

describe('URL helpers', () => {
  test('httpUrlToWebSocketUrl maps http(s) to ws(s) and leaves ws(s) and empty values alone', () => {
    assert.equal(I.httpUrlToWebSocketUrl('https://a.example/x'), 'wss://a.example/x')
    assert.equal(I.httpUrlToWebSocketUrl('http://a.example/x'), 'ws://a.example/x')
    assert.equal(I.httpUrlToWebSocketUrl('ws://a.example/x'), 'ws://a.example/x')
    assert.equal(I.httpUrlToWebSocketUrl('wss://a.example/x'), 'wss://a.example/x')
    assert.equal(I.httpUrlToWebSocketUrl(''), '')
    assert.equal(I.httpUrlToWebSocketUrl(), '')
    assert.equal(I.httpUrlToWebSocketUrl('/path'), '/path')
  })

  test('httpUrlToWebSocketUrl rewrites only the leading scheme, case-insensitively', () => {
    assert.equal(I.httpUrlToWebSocketUrl('https://a.example/?u=http://b.example'), 'wss://a.example/?u=http://b.example')
    assert.equal(I.httpUrlToWebSocketUrl('HTTPS://a/x'), 'wss://a/x')
    assert.equal(I.httpUrlToWebSocketUrl('WSS://a/x'), 'WSS://a/x')
    assert.equal(I.httpUrlToWebSocketUrl('Ws://a/x'), 'Ws://a/x')
  })
})

describe('normalizeWebSocketPayload', () => {
  test('returns the same Buffer, encodes strings as UTF-8 and maps nullish to an empty Buffer', () => {
    const buf = Buffer.from('x')
    assert.equal(I.normalizeWebSocketPayload(buf), buf)
    assert.deepEqual(I.normalizeWebSocketPayload('héllo'), Buffer.from('héllo', 'utf8'))
    assert.deepEqual(I.normalizeWebSocketPayload(null), Buffer.alloc(0))
    assert.deepEqual(I.normalizeWebSocketPayload(undefined), Buffer.alloc(0))
    assert.deepEqual(I.normalizeWebSocketPayload(new Uint8Array([1, 2, 3])), Buffer.from([1, 2, 3]))
    assert.deepEqual(I.normalizeWebSocketPayload([65, 66]), Buffer.from('AB'))
  })
})

describe('Socket.IO prefix handling', () => {
  test('stripSocketIoPrefix drops the engine.io code and a namespace prefix ending with a comma', () => {
    assert.equal(I.stripSocketIoPrefix('42["event",{"a":1}]'), '["event",{"a":1}]')
    assert.equal(I.stripSocketIoPrefix('42/ws/ns,["e",1]'), '["e",1]')
    assert.equal(I.stripSocketIoPrefix('0{"sid":"x"}'), '{"sid":"x"}')
    assert.equal(I.stripSocketIoPrefix('3probe'), 'probe')
    assert.equal(I.stripSocketIoPrefix('2'), '')
    assert.equal(I.stripSocketIoPrefix('12345'), '')
    assert.equal(I.stripSocketIoPrefix('plain'), 'plain')
    assert.equal(I.stripSocketIoPrefix(''), '')
    assert.equal(I.stripSocketIoPrefix(null), null)
  })

  test('current behavior: a namespace with nothing after the comma is kept, and any leading slash segment is cut at the first comma', () => {
    assert.equal(I.stripSocketIoPrefix('/path/no-comma'), '/path/no-comma')
    assert.equal(I.stripSocketIoPrefix('/ns,'), '/ns,')
    assert.equal(I.stripSocketIoPrefix('40/chat,'), '/chat,')
    assert.equal(I.stripSocketIoPrefix('/a,b,c'), 'b,c')
  })

  test('tryParseWebSocketJson parses Socket.IO frames and expands nested JSON strings', () => {
    assert.deepEqual(I.tryParseWebSocketJson('42["event",{"a":"{\\"b\\":1}"}]'), ['event', { a: { b: 1 } }])
    assert.deepEqual(I.tryParseWebSocketJson('42/ws/ns,["e",{"d":"[1,2]"}]'), ['e', { d: [1, 2] }])
    assert.deepEqual(I.tryParseWebSocketJson('0{"sid":"abc"}'), { sid: 'abc' })
    assert.deepEqual(I.tryParseWebSocketJson('  {"a":1}  '), { a: 1 })
  })

  test('tryParseWebSocketJson returns null for placeholders, non-JSON and non-strings', () => {
    assert.equal(I.tryParseWebSocketJson('[Binary data: 3 bytes]'), null)
    assert.equal(I.tryParseWebSocketJson('[WS summary] x'), null)
    assert.equal(I.tryParseWebSocketJson('[WebSocket text frame too large for rewrite: 1 bytes, limit=1]'), null)
    assert.equal(I.tryParseWebSocketJson('hello'), null)
    assert.equal(I.tryParseWebSocketJson('2'), null)
    assert.equal(I.tryParseWebSocketJson('{"a":1}trailing'), null)
    assert.equal(I.tryParseWebSocketJson(null), null)
    assert.equal(I.tryParseWebSocketJson(42), null)
  })
})

describe('normalizeNestedJsonStrings', () => {
  test('mutates the tree in place, parsing strings that start with { or [ and keeping everything else', () => {
    const tree = {
      data: '{"x":1,"y":"[1,2]"}',
      list: ['{"k":"v"}', 'plain', ' [true] '],
      num: 5,
      bad: '{oops',
      str: '"quoted"',
      nul: null,
      arr: '[]',
      obj: '{}'
    }
    assert.equal(I.normalizeNestedJsonStrings(tree), tree)
    assert.deepEqual(tree, {
      data: { x: 1, y: [1, 2] },
      list: [{ k: 'v' }, 'plain', [true]],
      num: 5,
      bad: '{oops',
      str: '"quoted"',
      nul: null,
      arr: [],
      obj: {}
    })
  })

  test('non-object roots are returned unchanged', () => {
    assert.equal(I.normalizeNestedJsonStrings('{"a":1}'), '{"a":1}')
    assert.equal(I.normalizeNestedJsonStrings(null), null)
    assert.deepEqual(I.normalizeNestedJsonStrings(['{"a":1}', 1]), [{ a: 1 }, 1])
  })
})

describe('rewriteWebSocketPayload without edit rules', () => {
  test('text frames come back as the same Buffer with no applied rules', () => {
    const text = Buffer.from('{"a":1}')
    const result = I.rewriteWebSocketPayload(text, false, { requestUrl: '/x', fullUrl: 'ws://a/x', phase: 'request' })
    assert.equal(result.buffer, text)
    assert.deepEqual(result, { buffer: text, appliedRuleIds: [], changed: false })
  })

  test('binary frames and mostly non-printable text frames are never touched', () => {
    const text = Buffer.from('{"a":1}')
    assert.equal(I.rewriteWebSocketPayload(text, true, {}).buffer, text)

    const binary = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.equal(I.printableRatio(binary), 0.1)
    assert.equal(I.rewriteWebSocketPayload(binary, false, {}).buffer, binary)
  })

  test('empty or non-Buffer payloads yield an empty Buffer', () => {
    assert.deepEqual(I.rewriteWebSocketPayload(Buffer.alloc(0), false, {}), { buffer: Buffer.alloc(0), appliedRuleIds: [], changed: false })
    assert.deepEqual(I.rewriteWebSocketPayload(null, false, {}), { buffer: Buffer.alloc(0), appliedRuleIds: [], changed: false })
    assert.deepEqual(I.rewriteWebSocketPayload('str', false, {}), { buffer: Buffer.alloc(0), appliedRuleIds: [], changed: false })
  })

  test('printableRatio counts tab, LF, CR and 0x20..0x7e as printable', () => {
    assert.equal(I.printableRatio(Buffer.from('{"a":1}')), 1)
    assert.equal(I.printableRatio(Buffer.from('a\tb\nc\r')), 1)
    assert.equal(I.printableRatio(Buffer.alloc(0)), 0)
    assert.equal(I.printableRatio(Buffer.from([0x61, 0x00])), 0.5)
  })
})
