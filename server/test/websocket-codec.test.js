'use strict'

// Characterization tests for the hand-written WebSocket frame codec and the
// Socket.IO / JSON helpers in server/index.js. They assert the behaviour
// observed on the current implementation, including its known limitations
// (marked "current behavior"), so that a rewrite on top of `ws` can be
// checked against it.

const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const { loadServer } = require('./helpers/load-server')

let I

before(async () => {
  const { proxy } = await loadServer()
  I = proxy.internals
})

// Build a client-style masked frame by hand (RFC 6455 §5.3).
function maskedFrame (payload, { opcode = 0x1, fin = true, mask = [0x37, 0xfa, 0x21, 0x3d] } = {}) {
  const data = Buffer.from(payload)
  const frame = Buffer.alloc(2 + 4 + data.length)
  frame[0] = (fin ? 0x80 : 0x00) | opcode
  frame[1] = 0x80 | data.length
  Buffer.from(mask).copy(frame, 2)
  for (let i = 0; i < data.length; i++) frame[6 + i] = data[i] ^ mask[i % 4]
  return frame
}

describe('createWebSocketFrame', () => {
  test('payloads shorter than 126 bytes use the 7-bit length and the text opcode', () => {
    assert.deepEqual([...I.createWebSocketFrame('hi', false)], [0x81, 0x02, 0x68, 0x69])
  })

  test('binary frames use opcode 2', () => {
    assert.deepEqual([...I.createWebSocketFrame(Buffer.from([1, 2]), true)], [0x82, 0x02, 0x01, 0x02])
  })

  test('126..65535 bytes use the 16-bit extended length', () => {
    const frame126 = I.createWebSocketFrame(Buffer.alloc(126, 0x61), false)
    assert.deepEqual([...frame126.subarray(0, 4)], [0x81, 126, 0x00, 0x7e])
    assert.equal(frame126.length, 4 + 126)

    const frameMax = I.createWebSocketFrame(Buffer.alloc(65535, 0x61), false)
    assert.deepEqual([...frameMax.subarray(0, 4)], [0x81, 126, 0xff, 0xff])
  })

  test('65536 bytes and above use the 64-bit length with the high 32 bits always zero', () => {
    const frame = I.createWebSocketFrame(Buffer.alloc(65536, 0x61), false)
    assert.deepEqual([...frame.subarray(0, 10)], [0x81, 127, 0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00])
    assert.equal(frame.length, 10 + 65536)
  })

  test('current behavior: outgoing frames are never masked (server-to-client direction only)', () => {
    const frame = I.createWebSocketFrame('x', false)
    assert.equal(frame[1] & 0x80, 0)
  })
})

describe('decodeWebSocketFrame', () => {
  test('round-trips frames produced by createWebSocketFrame', () => {
    assert.deepEqual(I.decodeWebSocketFrame(I.createWebSocketFrame('hi', false)), {
      isFinal: true, opcode: 1, isBinary: false, payload: Buffer.from('hi')
    })
    assert.deepEqual(I.decodeWebSocketFrame(I.createWebSocketFrame(Buffer.from([1, 2]), true)), {
      isFinal: true, opcode: 2, isBinary: true, payload: Buffer.from([1, 2])
    })
    const big = I.decodeWebSocketFrame(I.createWebSocketFrame(Buffer.alloc(65536, 0x61), false))
    assert.equal(big.payload.length, 65536)
  })

  test('unmasks a client frame with the 4-byte masking key', () => {
    const frame = maskedFrame('Hello')
    assert.deepEqual([...frame], [0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58])
    const decoded = I.decodeWebSocketFrame(frame)
    assert.equal(decoded.payload.toString(), 'Hello')
    assert.equal(decoded.isBinary, false)
    assert.equal(decoded.isFinal, true)
  })

  test('returns null for truncated buffers', () => {
    assert.equal(I.decodeWebSocketFrame(Buffer.from([0x81])), null)
    assert.equal(I.decodeWebSocketFrame(Buffer.from([0x81, 0x05, 0x48, 0x65])), null)
    assert.equal(I.decodeWebSocketFrame(Buffer.from([0x81, 126, 0x00])), null)
    assert.equal(I.decodeWebSocketFrame(Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 0, 0])), null)
    assert.equal(I.decodeWebSocketFrame(Buffer.from([0x81, 0x85, 0x37, 0xfa])), null)
  })

  test('current behavior: a buffer holding two frames yields only the first one', () => {
    const two = Buffer.concat([I.createWebSocketFrame('one', false), I.createWebSocketFrame('two', false)])
    const decoded = I.decodeWebSocketFrame(two)
    assert.equal(decoded.payload.toString(), 'one')
    assert.equal('consumed' in decoded, false)
  })

  test('current behavior: control frames decode as non-binary data frames (opcode is reported, not acted on)', () => {
    assert.deepEqual(I.decodeWebSocketFrame(Buffer.from([0x89, 0x02, 0x68, 0x69])), {
      isFinal: true, opcode: 9, isBinary: false, payload: Buffer.from('hi')
    })
    assert.deepEqual(I.decodeWebSocketFrame(Buffer.from([0x88, 0x02, 0x03, 0xe8])), {
      isFinal: true, opcode: 8, isBinary: false, payload: Buffer.from([0x03, 0xe8])
    })
  })

  test('current behavior: fragments are reported through isFinal/opcode 0 but not reassembled', () => {
    assert.deepEqual(I.decodeWebSocketFrame(Buffer.from([0x01, 0x01, 0x61])), {
      isFinal: false, opcode: 1, isBinary: false, payload: Buffer.from('a')
    })
    assert.deepEqual(I.decodeWebSocketFrame(Buffer.from([0x00, 0x01, 0x61])), {
      isFinal: false, opcode: 0, isBinary: false, payload: Buffer.from('a')
    })
  })
})

describe('handshake and URL helpers', () => {
  test('generateWebSocketAccept matches the RFC 6455 example', () => {
    assert.equal(I.generateWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

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
