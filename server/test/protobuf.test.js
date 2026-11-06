'use strict'

// Characterization tests for the hand-written protobuf codec in server/index.js.
// They pin the behaviour observed on the current implementation, including its
// quirks (marked "current behavior"), so the Phase 2 split can be checked
// against them.

const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const { loadServer } = require('./helpers/load-server')

let I

const hex = buf => Buffer.from(buf).toString('hex')
const ld = (fieldNumber, data) => I.encodeLengthDelimitedField(fieldNumber, Buffer.from(data))

before(async () => {
  const { proxy } = await loadServer()
  I = proxy.internals
})

describe('readVarint', () => {
  it('decodes single and multi-byte varints and reports the consumed length', () => {
    assert.deepEqual(I.readVarint(Buffer.from([0x05]), 0), { value: 5, length: 1 })
    assert.deepEqual(I.readVarint(Buffer.from([0xac, 0x02]), 0), { value: 300, length: 2 })
    assert.deepEqual(I.readVarint(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f]), 0), { value: 4294967295, length: 5 })
  })

  it('honours the offset argument', () => {
    assert.deepEqual(I.readVarint(Buffer.from([0x00, 0x96, 0x01]), 1), { value: 150, length: 2 })
  })

  it('throws on a truncated varint and after 10 continuation bytes', () => {
    assert.throws(() => I.readVarint(Buffer.from([0x80]), 0), /Invalid varint encoding/)
    assert.throws(() => I.readVarint(Buffer.from(new Array(11).fill(0x80)), 0), /Invalid varint encoding/)
  })

  it('current behavior: keeps only the low 32 bits of wider varints', () => {
    // 2^32 encoded as a 5-byte varint collapses to 0 (32-bit shifts).
    assert.deepEqual(I.readVarint(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x10]), 0), { value: 0, length: 5 })
    // A 10-byte varint of all ones is accepted and reads as 2^32 - 1.
    assert.deepEqual(
      I.readVarint(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]), 0),
      { value: 4294967295, length: 10 }
    )
  })
})

describe('encodeVarint32 / encodeProtobufKey / encodeLengthDelimitedField', () => {
  it('encodes unsigned 32-bit values', () => {
    assert.equal(hex(I.encodeVarint32(0)), '00')
    assert.equal(hex(I.encodeVarint32(127)), '7f')
    assert.equal(hex(I.encodeVarint32(128)), '8001')
    assert.equal(hex(I.encodeVarint32(300)), 'ac02')
    assert.equal(hex(I.encodeVarint32(4294967295)), 'ffffffff0f')
  })

  it('current behavior: wraps negative and >32-bit values through >>> 0', () => {
    assert.equal(hex(I.encodeVarint32(-1)), 'ffffffff0f')
    assert.equal(hex(I.encodeVarint32(4294967296)), '00')
  })

  it('encodes field keys and rejects invalid field numbers', () => {
    assert.equal(hex(I.encodeProtobufKey(1, 2)), '0a')
    assert.equal(hex(I.encodeProtobufKey(16, 0)), '8001')
    // current behavior: the wire type is masked to 3 bits, 9 becomes 1.
    assert.equal(hex(I.encodeProtobufKey(1, 9)), '09')
    assert.throws(() => I.encodeProtobufKey(0, 2), /Invalid field number/)
    assert.throws(() => I.encodeProtobufKey(1.5, 2), /Invalid field number/)
  })

  it('prefixes length-delimited data with key and length', () => {
    assert.equal(hex(I.encodeLengthDelimitedField(2, Buffer.from('hi'))), '12026869')
  })
})

describe('parseMessageDetailed / parseProtobuf', () => {
  const buildMessage = () => Buffer.concat([
    Buffer.from([0x08, 0x2a]), // f1 varint 42
    ld(2, 'hello'), // f2 string
    Buffer.from([0x19, 1, 2, 3, 4, 5, 6, 7, 8]), // f3 fixed64
    Buffer.from([0x25, 9, 10, 11, 12]), // f4 fixed32
    ld(5, ld(1, 'x')) // f5 nested message
  ])

  it('parses every supported wire type and keeps the raw bytes per field', () => {
    const msg = buildMessage()
    assert.equal(hex(msg), '082a120568656c6c6f19010203040506070825090a0b0c2a030a0178')

    const { fields } = I.parseMessageDetailed(msg)
    assert.equal(fields.length, 5)

    assert.deepEqual(fields[0], { fieldNumber: 1, wireType: 0, value: 42, data: null, raw: Buffer.from([0x08, 0x2a]) })
    assert.equal(fields[1].wireType, 2)
    assert.equal(fields[1].data.toString(), 'hello')
    assert.equal(hex(fields[1].raw), '120568656c6c6f')
    assert.equal(fields[2].wireType, 1)
    assert.equal(hex(fields[2].data), '0102030405060708')
    assert.equal(fields[3].wireType, 5)
    assert.equal(hex(fields[3].data), '090a0b0c')
    assert.equal(fields[4].wireType, 2)
    assert.equal(hex(fields[4].data), '0a0178')
  })

  it('parseProtobuf drops the raw bytes but keeps number, wire type, value and data', () => {
    const { fields } = I.parseProtobuf(buildMessage())
    assert.deepEqual(Object.keys(fields[0]), ['fieldNumber', 'wireType', 'value', 'data'])
    assert.deepEqual(fields[0], { fieldNumber: 1, wireType: 0, value: 42, data: null })
    assert.equal(fields[1].data.toString(), 'hello')
  })

  it('returns no fields for an empty buffer and rejects non-buffers', () => {
    assert.deepEqual(I.parseProtobuf(Buffer.alloc(0)), { fields: [] })
    assert.throws(() => I.parseMessageDetailed('nope'), { name: 'TypeError', message: 'Expected Buffer' })
  })

  it('throws on unsupported wire types, field number 0 and truncated payloads', () => {
    assert.throws(() => I.parseMessageDetailed(Buffer.from([0x0b])), /Unsupported wire type 3/)
    assert.throws(() => I.parseMessageDetailed(Buffer.from([0x02, 0x05])), /Invalid field number/)
    assert.throws(() => I.parseMessageDetailed(Buffer.from([0x0a, 0x05, 0x41])), /Truncated length-delimited field/)
    assert.throws(() => I.parseMessageDetailed(Buffer.from([0x09, 0x01])), /Truncated 64-bit field/)
    assert.throws(() => I.parseMessageDetailed(Buffer.from([0x0d, 0x01])), /Truncated 32-bit field/)
  })

  it('encodeProtobufFromFields reproduces the parsed bytes', () => {
    const msg = buildMessage()
    assert.ok(I.encodeProtobufFromFields(I.parseProtobuf(msg).fields).equals(msg))
  })
})

describe('encodeProtobufFromFields', () => {
  it('returns an empty buffer for an empty list', () => {
    assert.equal(hex(I.encodeProtobufFromFields([])), '')
  })

  it('current behavior: drops unsupported wire types and invalid entries, zero-fills missing fixed data', () => {
    const out = I.encodeProtobufFromFields([
      { fieldNumber: 1, wireType: 3 }, // unsupported: dropped
      { fieldNumber: 2, wireType: 1 }, // fixed64 without data: 8 zero bytes
      { fieldNumber: 3, wireType: 5 }, // fixed32 without data: 4 zero bytes
      { fieldNumber: 4, wireType: 2 }, // length-delimited without data: length 0
      { fieldNumber: 5, wireType: 0 }, // varint without value: 0
      null,
      { fieldNumber: 'x', wireType: 0 },
      { fieldNumber: 0, wireType: 0 }
    ])
    assert.equal(hex(out), '1100000000000000001d0000000022002800')
  })
})

describe('encodeJsonToProtobuf', () => {
  const json = {
    f1: 'hello',
    f2: 42,
    f3: true,
    f4: { f1: 'x' }, // protobuf-shaped object: nested message
    f5: { a: 1 }, // other object: JSON string
    f6: ['a', 'b'], // array: repeated field
    f7: null, // dropped
    f8: { bytesHex: '0102030405060708' }, // 8 bytes: fixed64
    f9: { bytesHex: '01020304' }, // 4 bytes: fixed32
    f10: { base64: 'AAEC' }, // raw bytes
    other: 'ignored', // non-fN key: dropped
    f0: 'zero', // field 0: dropped
    f11: false
  }

  it('encodes strings, numbers, booleans, nested messages, JSON objects, arrays and blobs', () => {
    const enc = I.encodeJsonToProtobuf(json)
    assert.equal(
      hex(enc),
      '0a0568656c6c6f102a180122030a01782a077b2261223a317d3201613201624101020304050607084d0102030452030001025800'
    )
    const { fields } = I.parseProtobuf(enc)
    assert.deepEqual(fields.map(f => [f.fieldNumber, f.wireType]), [
      [1, 2], [2, 0], [3, 0], [4, 2], [5, 2], [6, 2], [6, 2], [8, 1], [9, 5], [10, 2], [11, 0]
    ])
    assert.equal(fields[4].data.toString(), '{"a":1}')
  })

  it('round-trips through extractJsonFromProtobufBuffer, with booleans becoming 1/0', () => {
    // current behavior: true/false are encoded as varints and come back as numbers.
    assert.deepEqual(I.extractJsonFromProtobufBuffer(I.encodeJsonToProtobuf(json)), {
      f1: 'hello',
      f2: 42,
      f3: 1,
      f4: { f1: 'x' },
      f5: { a: 1 },
      f6: ['a', 'b'],
      f8: { bytesHex: '0102030405060708', length: 8 },
      f9: { bytesHex: '01020304', length: 4 },
      f10: { base64: 'AAEC', length: 3 },
      f11: 0
    })
  })

  it('returns an empty buffer for non-objects and objects without fN keys', () => {
    assert.equal(hex(I.encodeJsonToProtobuf('str')), '')
    assert.equal(hex(I.encodeJsonToProtobuf(null)), '')
    assert.equal(hex(I.encodeJsonToProtobuf({})), '')
    assert.equal(hex(I.encodeJsonToProtobuf({ other: 1 })), '')
  })
})

describe('printableRatio', () => {
  it('counts tab, LF, CR and 0x20-0x7E as printable', () => {
    assert.equal(I.printableRatio(Buffer.alloc(0)), 0)
    assert.equal(I.printableRatio(null), 0)
    assert.equal(I.printableRatio(Buffer.from('abc')), 1)
    assert.equal(I.printableRatio(Buffer.from([0x00, 0x41])), 0.5)
    assert.equal(I.printableRatio(Buffer.from([0x09, 0x0a, 0x0d, 0x7f])), 0.75)
  })
})

describe('rewriteProtobufFields', () => {
  const rewriter = text => text.includes('hello')
    ? { text: text.split('hello').join('hi there, friend'), changed: true, appliedRuleIds: ['r1'] }
    : { text, changed: false }

  const buildMessage = () => Buffer.concat([
    ld(1, 'hello world'),
    Buffer.from([0x10, 0x07]),
    ld(3, ld(1, 'hello nested')),
    ld(4, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]))
  ])

  it('rewrites printable string fields (top level and nested) and re-encodes lengths', () => {
    const result = I.rewriteProtobufFields(buildMessage(), rewriter)
    assert.equal(result.changed, true)
    assert.deepEqual(result.appliedRuleIds, ['r1'])
    assert.deepEqual(I.extractJsonFromProtobufBuffer(result.buffer), {
      f1: 'hi there, friend world',
      f2: 7,
      f3: { f1: 'hi there, friend nested' },
      f4: { base64: 'AAECA//+', length: 6 }
    })
  })

  it('returns the same buffer instance when nothing changes', () => {
    const msg = buildMessage()
    const result = I.rewriteProtobufFields(msg, text => ({ text, changed: false }))
    assert.equal(result.changed, false)
    assert.equal(result.buffer, msg)
    assert.deepEqual(result.appliedRuleIds, [])
  })

  it('passes through non-buffers, missing rewriters and invalid protobuf', () => {
    assert.deepEqual(I.rewriteProtobufFields('x', rewriter), { buffer: 'x', appliedRuleIds: [], changed: false })
    assert.equal(I.rewriteProtobufFields(buildMessage(), null).changed, false)
    assert.equal(I.rewriteProtobufFields(Buffer.from([0x0b]), rewriter).changed, false)
  })

  it('reaches strings nested six levels deep', () => {
    let deep = Buffer.from('hello deep')
    for (let i = 0; i < 6; i++) deep = ld(1, deep)
    const result = I.rewriteProtobufFields(deep, rewriter)
    assert.equal(result.changed, true)
    assert.deepEqual(I.extractJsonFromProtobufBuffer(result.buffer), {
      f1: { f1: { f1: { f1: { f1: 'hi there, friend deep' } } } }
    })
  })

  it('rewriteMessage with maxDepth 0 still rewrites top-level strings', () => {
    assert.equal(I.rewriteMessage(buildMessage(), rewriter, 0, 0).changed, true)
  })
})

describe('extractJsonFromProtobufBuffer', () => {
  it('maps fields to fN keys: strings, varints, nested messages, JSON text, blobs, fixed, repeated, empty', () => {
    const msg = Buffer.concat([
      ld(1, 'hello'),
      Buffer.from([0x10, 0x2a]),
      ld(3, ld(1, 'x')),
      ld(4, '{"a":1,"b":[1,2]}'),
      ld(5, Buffer.from([0x00, 0x01, 0x02, 0x80, 0x81, 0x82])),
      Buffer.from([0x35, 1, 2, 3, 4]),
      ld(7, 'one'),
      ld(7, 'two'),
      ld(8, Buffer.alloc(0)),
      Buffer.from([0x49, 1, 2, 3, 4, 5, 6, 7, 8])
    ])
    assert.deepEqual(I.extractJsonFromProtobufBuffer(msg), {
      f1: 'hello',
      f2: 42,
      f3: { f1: 'x' },
      f4: { a: 1, b: [1, 2] },
      f5: { base64: 'AAECgIGC', length: 6 },
      f6: { bytesHex: '01020304', length: 4 },
      f7: ['one', 'two'],
      f8: '',
      f9: { bytesHex: '0102030405060708', length: 8 }
    })
  })

  it('returns null for empty or unparsable input', () => {
    assert.equal(I.extractJsonFromProtobufBuffer(Buffer.alloc(0)), null)
    assert.equal(I.extractJsonFromProtobufBuffer(null), null)
    assert.equal(I.extractJsonFromProtobufBuffer(Buffer.from([0x0b])), null)
  })

  it('keeps an empty length-delimited field as an empty string', () => {
    assert.deepEqual(I.extractJsonFromProtobufBuffer(Buffer.from([0x0a, 0x00])), { f1: '' })
  })
})

describe('stripTrivialBinaryBlobs', () => {
  it('removes { base64: "", length: 0 } placeholders from objects and arrays', () => {
    assert.deepEqual(
      I.stripTrivialBinaryBlobs({
        f1: { base64: '', length: 0 },
        f2: [{ base64: '', length: 0 }, 'x'],
        f3: { base64: 'AA==', length: 1 },
        f4: 5,
        f5: null
      }),
      { f2: ['x'], f3: { base64: 'AA==', length: 1 }, f4: 5, f5: null }
    )
  })

  it('returns undefined for a top-level empty blob and passes primitives through', () => {
    assert.equal(I.stripTrivialBinaryBlobs({ base64: '', length: 0 }), undefined)
    assert.equal(I.stripTrivialBinaryBlobs(null), null)
    assert.equal(I.stripTrivialBinaryBlobs('s'), 's')
    assert.equal(I.stripTrivialBinaryBlobs(0), 0)
  })
})
