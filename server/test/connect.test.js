'use strict'

// Characterization tests for the Connect/gRPC envelope handling in
// server/index.js: envelope detection and rebuild, payload decoding for the
// UI and frame-level rewrites driven by text and JSONPath edit rules.

const { describe, it, before, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('node:zlib')
const { loadServer } = require('./helpers/load-server')

let I
let writeStorageFile

const PROTO = { 'content-type': 'application/connect+proto' }

const hex = buf => Buffer.from(buf).toString('hex')
const ld = (fieldNumber, data) => I.encodeLengthDelimitedField(fieldNumber, Buffer.from(data))

// One Connect frame: 1 byte of flags, 4-byte big-endian length, payload.
const frame = (flags, data) => {
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(data.length, 1)
  return Buffer.concat([header, data])
}

// { f1: 'hello world', f2: 42 }
const protoMessage = () => Buffer.concat([ld(1, 'hello world'), Buffer.from([0x10, 0x2a])])

// Rules are loaded the way the server loads them at startup: from the
// edit-rules.json file in the (temporary) storage directory.
const setRules = rules => {
  writeStorageFile('edit-rules.json', rules)
  I.loadEditRules()
  I.rebuildEditRuleCache()
}

const textRule = {
  id: 't1',
  kind: 'text',
  enabled: true,
  name: 'hello',
  startVariants: ['hello'],
  endVariants: [],
  replacement: 'HELLO',
  useRegex: false,
  caseSensitive: false,
  url: '',
  target: 'both'
}

const jsonPathRule = {
  id: 'jp1',
  kind: 'jsonPath',
  enabled: true,
  name: 'n',
  url: '/svc/Method',
  path: 'root.f1',
  value: 'changed',
  valueType: 'string',
  target: 'request'
}

const ctx = { requestUrl: '/svc/Method', fullUrl: 'https://api.example.com/svc/Method', phase: 'request' }

before(async () => {
  const loaded = await loadServer()
  I = loaded.proxy.internals
  writeStorageFile = loaded.writeStorageFile
})

afterEach(() => {
  setRules([])
})

describe('looksLikeConnectEnvelope', () => {
  it('accepts one or more well-formed frames, including empty ones', () => {
    assert.equal(I.looksLikeConnectEnvelope(frame(0, protoMessage())), true)
    assert.equal(I.looksLikeConnectEnvelope(Buffer.concat([frame(0, protoMessage()), frame(2, Buffer.from('{}'))])), true)
    assert.equal(I.looksLikeConnectEnvelope(Buffer.from([0, 0, 0, 0, 0])), true)
    assert.equal(I.looksLikeConnectEnvelope(frame(3, protoMessage())), true)
  })

  it('rejects unknown flag bits, overflowing lengths, trailing bytes, short and non-buffer input', () => {
    assert.equal(I.looksLikeConnectEnvelope(frame(4, protoMessage())), false)
    assert.equal(I.looksLikeConnectEnvelope(Buffer.from([0, 0, 0, 0, 9, 1, 2])), false)
    assert.equal(I.looksLikeConnectEnvelope(Buffer.concat([frame(0, protoMessage()), Buffer.from([1, 2, 3])])), false)
    assert.equal(I.looksLikeConnectEnvelope(Buffer.from([0, 0, 0, 0])), false)
    assert.equal(I.looksLikeConnectEnvelope('abc'), false)
    assert.equal(I.looksLikeConnectEnvelope(protoMessage()), false)
  })
})

describe('rebuildConnectEnvelope', () => {
  it('serialises frames with flags masked to one byte and missing data as length 0', () => {
    const out = I.rebuildConnectEnvelope([
      { flags: 0, data: Buffer.from('ab') },
      { flags: 2, data: Buffer.alloc(0) },
      { flags: 0x102 },
      null
    ])
    assert.equal(hex(out), '00000000026162020000000002000000000000000000')
    assert.equal(hex(I.rebuildConnectEnvelope([])), '')
  })

  it('reproduces the bytes of a parsed envelope', () => {
    const original = Buffer.concat([frame(0, protoMessage()), frame(2, Buffer.from('{}'))])
    const rebuilt = I.rebuildConnectEnvelope([{ flags: 0, data: protoMessage() }, { flags: 2, data: Buffer.from('{}') }])
    assert.ok(rebuilt.equals(original))
  })
})

describe('getConnectEncodingHeader', () => {
  it('prefers connect-content-encoding, then connect-encoding, then grpc-encoding, case-insensitively', () => {
    assert.equal(I.getConnectEncodingHeader({ 'Grpc-Encoding': 'gzip', 'connect-encoding': 'br', 'Connect-Content-Encoding': 'zstd' }), 'zstd')
    assert.equal(I.getConnectEncodingHeader({ 'grpc-encoding': 'gzip' }), 'gzip')
    assert.equal(I.getConnectEncodingHeader({}), '')
    assert.equal(I.getConnectEncodingHeader(null), '')
  })
})

describe('decodeConnectPayload', () => {
  it('decodes a protobuf envelope frame into preview and fN JSON, with hidden raw views', () => {
    const decoded = I.decodeConnectPayload(frame(0, protoMessage()), PROTO)
    assert.deepEqual(decoded, {
      contentType: 'application/connect+proto',
      envelope: true,
      frameCount: 1,
      frames: [{
        index: 0,
        length: 15,
        compressed: false,
        endStream: false,
        frameDecompressed: false,
        preview: '\n\x0Bhello world\x10*',
        json: { f1: 'hello world', f2: 42 },
        note: null
      }],
      httpDecompressed: false,
      httpEncoding: '',
      rawBase64: 'AAAAAA8KC2hlbGxvIHdvcmxkECo='
    })
    // Non-enumerable helpers reused by the rewrite path.
    assert.deepEqual(decoded.frames[0]._rawProtobufJson, { f1: 'hello world', f2: 42 })
    assert.equal(decoded.frames[0]._decodedBuffer, undefined)
    assert.ok(Buffer.isBuffer(decoded.httpDecodedBuffer))
    assert.ok(!Object.keys(decoded).includes('httpDecodedBuffer'))
  })

  it('decodes a JSON envelope with an end-stream frame', () => {
    const body = Buffer.concat([frame(0, Buffer.from('{"message":"hi"}')), frame(2, Buffer.from('{}'))])
    const decoded = I.decodeConnectPayload(body, { 'Content-Type': 'application/connect+json' })
    assert.equal(decoded.frameCount, 2)
    assert.deepEqual(decoded.frames.map(f => [f.endStream, f.preview, f.json]), [
      [false, '{"message":"hi"}', { message: 'hi' }],
      [true, '{}', {}]
    ])
  })

  it('decompresses a compressed frame only when a Connect encoding header names the codec', () => {
    const gzFrame = frame(1, zlib.gzipSync(protoMessage()))

    const withHeader = I.decodeConnectPayload(gzFrame, { ...PROTO, 'connect-content-encoding': 'gzip' })
    assert.equal(withHeader.frames[0].compressed, true)
    assert.equal(withHeader.frames[0].frameDecompressed, true)
    assert.deepEqual(withHeader.frames[0].json, { f1: 'hello world', f2: 42 })
    assert.ok(Buffer.isBuffer(withHeader.frames[0]._decodedBuffer))

    // Without the header the frame is left encoded and gets a note instead
    // of a preview made of gzip bytes.
    const withoutHeader = I.decodeConnectPayload(gzFrame, PROTO)
    assert.equal(withoutHeader.frames[0].compressed, true)
    assert.equal(withoutHeader.frames[0].frameDecompressed, false)
    assert.equal(withoutHeader.frames[0].json, null)
    assert.equal(withoutHeader.frames[0].preview, '')
    assert.equal(
      withoutHeader.frames[0].note,
      'compressed frame: no connect-content-encoding/grpc-encoding header, payload left encoded'
    )

    // A named codec that cannot decode the payload is reported the same way.
    const undecodable = I.decodeConnectPayload(frame(1, protoMessage()), { ...PROTO, 'connect-content-encoding': 'gzip' })
    assert.equal(undecodable.frames[0].frameDecompressed, false)
    assert.equal(undecodable.frames[0].json, null)
    assert.equal(undecodable.frames[0].preview, '')
    assert.equal(undecodable.frames[0].note, 'compressed frame: decompression failed, payload left encoded')
  })

  it('treats a non-envelope protobuf body as a single unary end-stream frame', () => {
    const decoded = I.decodeConnectPayload(protoMessage(), { 'content-type': 'application/proto' })
    assert.equal(decoded.envelope, false)
    assert.deepEqual(decoded.frames, [{
      index: 0,
      length: 15,
      compressed: false,
      endStream: true,
      frameDecompressed: false,
      preview: '\n\x0Bhello world\x10*',
      json: { f1: 'hello world', f2: 42 },
      note: null
    }])
    assert.equal(decoded.rawBase64, 'CgtoZWxsbyB3b3JsZBAq')
  })

  it('decodes an HTTP-compressed envelope when the content type allows decompression', () => {
    const decoded = I.decodeConnectPayload(zlib.gzipSync(frame(0, protoMessage())), { ...PROTO, 'content-encoding': 'gzip' })
    assert.equal(decoded.httpDecompressed, true)
    assert.equal(decoded.httpEncoding, 'gzip')
    assert.deepEqual(decoded.frames[0].json, { f1: 'hello world', f2: 42 })
    assert.equal(decoded.rawBase64, 'AAAAAA8KC2hlbGxvIHdvcmxkECo=')
  })

  it('decodes an envelope regardless of content type, and returns null otherwise', () => {
    assert.equal(I.decodeConnectPayload(frame(0, protoMessage()), { 'content-type': 'application/octet-stream' }).envelope, true)
    assert.equal(I.decodeConnectPayload(Buffer.alloc(0), PROTO), null)
    assert.equal(I.decodeConnectPayload(Buffer.from('hello'), { 'content-type': 'text/plain' }), null)
    assert.equal(I.decodeConnectPayload(Buffer.from('{"a":1}'), { 'content-type': 'application/json' }), null)
  })
})

describe('edit rule loading', () => {
  it('folds legacy start/end markers of on-disk text rules into the variant lists', () => {
    setRules([{ id: 'legacy', kind: 'text', enabled: true, start: 'hello', end: '', replacement: 'X' }])
    const compiled = I.getCompiledRules()
    assert.equal(compiled.length, 1)
    assert.equal(compiled[0].mode, 'prefix')
    assert.deepEqual(compiled[0].rule.startVariants, ['hello'])
    assert.deepEqual(compiled[0].rule.endVariants, [])
    assert.deepEqual(I.applyEditRulesToText('say hello Hello', { requestUrl: '/x', phase: 'request' }), {
      text: 'say X X',
      appliedRuleIds: ['legacy'],
      changed: true
    })

    setRules([{ id: 'legacy2', kind: 'text', enabled: true, start: '[', end: ']', replacement: '<x>' }])
    assert.equal(I.getCompiledRules()[0].mode, 'between')
    assert.deepEqual(I.applyEditRulesToText('a [b] c [d]', { requestUrl: '/x', phase: 'request' }), {
      text: 'a <x> c <x>',
      appliedRuleIds: ['legacy2'],
      changed: true
    })

    setRules([textRule])
    assert.equal(I.getCompiledRules().length, 1)
    assert.deepEqual(I.applyEditRulesToText('say hello Hello', { requestUrl: '/x', phase: 'request' }), {
      text: 'say HELLO HELLO',
      appliedRuleIds: ['t1'],
      changed: true
    })
  })
})

describe('applyConnectFrameRewrites', () => {
  it('is an identity (same buffer instance) without rules or with an empty buffer', () => {
    const env = frame(0, protoMessage())
    assert.equal(I.applyConnectFrameRewrites(env, PROTO, null, ctx).buffer, env)
    assert.deepEqual(I.applyConnectFrameRewrites(Buffer.alloc(0), PROTO), { buffer: Buffer.alloc(0), appliedRuleIds: [], changed: false })
  })

  it('applies a text rule inside a protobuf frame and rebuilds a valid envelope', () => {
    setRules([textRule])
    const result = I.applyConnectFrameRewrites(frame(0, protoMessage()), PROTO, null, ctx, { loggingEnabled: true })
    assert.equal(result.changed, true)
    assert.deepEqual(result.appliedRuleIds, ['t1'])
    assert.equal(result.encoding, '')
    assert.ok(I.looksLikeConnectEnvelope(result.buffer))
    assert.deepEqual(I.decodeConnectPayload(result.buffer, PROTO).frames[0].json, { f1: 'HELLO world', f2: 42 })

    const [updated] = result.updatedFrames
    assert.equal(hex(updated.data), '0a0b48454c4c4f20776f726c64102a')
    assert.equal(updated.preview, '\n\x0BHELLO world\x10*')
    // The json view is re-extracted from the rewritten payload.
    assert.deepEqual(updated.json, { f1: 'HELLO world', f2: 42 })
  })

  it('skips preview work when logging is disabled', () => {
    setRules([textRule])
    const result = I.applyConnectFrameRewrites(frame(0, protoMessage()), PROTO, null, ctx, { loggingEnabled: false })
    assert.equal(result.changed, true)
    assert.equal(result.updatedFrames[0].preview, '')
    assert.equal(result.updatedFrames[0].json, null)
  })

  it('decompresses and recompresses an HTTP gzip body, reporting the encoding', () => {
    setRules([textRule])
    const result = I.applyConnectFrameRewrites(zlib.gzipSync(frame(0, protoMessage())), { ...PROTO, 'content-encoding': 'gzip' }, null, ctx)
    assert.equal(result.changed, true)
    assert.equal(result.encoding, 'gzip')
    assert.deepEqual(I.decodeConnectPayload(zlib.gunzipSync(result.buffer), PROTO).frames[0].json, { f1: 'HELLO world', f2: 42 })
  })

  it('rewrites a gzip-compressed frame and keeps it compressed', () => {
    setRules([textRule])
    const headers = { ...PROTO, 'connect-content-encoding': 'gzip' }
    const result = I.applyConnectFrameRewrites(frame(1, zlib.gzipSync(protoMessage())), headers, null, ctx)
    assert.equal(result.changed, true)
    assert.equal(result.buffer[0], 1)
    assert.deepEqual(I.decodeConnectPayload(result.buffer, headers).frames[0].json, { f1: 'HELLO world', f2: 42 })
  })

  it('falls back to a plain text rewrite for a unary protobuf body', () => {
    setRules([textRule])
    const result = I.applyConnectFrameRewrites(protoMessage(), { 'content-type': 'application/proto' }, null, ctx)
    assert.equal(result.changed, true)
    assert.deepEqual(result.appliedRuleIds, ['t1'])
    assert.equal(result.encoding, '')
    assert.equal(result.updatedFrames, undefined)
    assert.equal(result.buffer.toString('latin1'), '\n\x0BHELLO world\x10*')
  })

  it('leaves non-protobuf, non-envelope bodies alone', () => {
    setRules([textRule])
    const body = Buffer.from('hello there')
    assert.deepEqual(I.applyConnectFrameRewrites(body, { 'content-type': 'text/plain' }, null, ctx), { buffer: body, appliedRuleIds: [], changed: false })
  })

  it('applies a URL-scoped JSONPath rule to a protobuf frame', () => {
    setRules([jsonPathRule])
    const result = I.applyConnectFrameRewrites(frame(0, protoMessage()), PROTO, null, ctx, { loggingEnabled: true })
    assert.equal(result.changed, true)
    assert.deepEqual(result.appliedRuleIds, ['jp1'])
    assert.deepEqual(result.updatedFrames[0].json, { f1: 'changed', f2: 42 })
    assert.deepEqual(I.decodeConnectPayload(result.buffer, PROTO).frames[0].json, { f1: 'changed', f2: 42 })
  })

  it('reuses the JSON view of a previously decoded payload as the JSONPath seed', () => {
    setRules([jsonPathRule])
    const env = frame(0, protoMessage())
    const decoded = I.decodeConnectPayload(env, PROTO)
    const result = I.applyConnectFrameRewrites(env, PROTO, decoded, ctx, { loggingEnabled: true })
    assert.deepEqual(result.updatedFrames[0].json, { f1: 'changed', f2: 42 })
  })

  it('skips JSONPath-only rule sets whose URL does not match the context', () => {
    setRules([jsonPathRule])
    const other = { requestUrl: '/other', fullUrl: 'https://x/other', phase: 'request' }
    assert.equal(I.applyConnectFrameRewrites(frame(0, protoMessage()), PROTO, null, other).changed, false)
  })
})

describe('applyJsonPathRulesToProtobufBuffer', () => {
  it('is an identity without rules or with an empty buffer', () => {
    const msg = protoMessage()
    assert.equal(I.applyJsonPathRulesToProtobufBuffer(msg, null, ctx).buffer, msg)
    assert.deepEqual(I.applyJsonPathRulesToProtobufBuffer(Buffer.alloc(0), { a: 1 }), {
      buffer: Buffer.alloc(0), json: { a: 1 }, appliedRuleIds: [], changed: false
    })
  })

  it('replaces the targeted field and re-encodes the message', () => {
    setRules([jsonPathRule])
    const result = I.applyJsonPathRulesToProtobufBuffer(protoMessage(), null, ctx)
    assert.equal(result.changed, true)
    assert.deepEqual(result.appliedRuleIds, ['jp1'])
    assert.deepEqual(result.json, { f1: 'changed', f2: 42 })
    assert.deepEqual(I.extractJsonFromProtobufBuffer(result.buffer), { f1: 'changed', f2: 42 })
  })

  it('honours the rule URL and target phase', () => {
    setRules([jsonPathRule])
    assert.equal(I.applyJsonPathRulesToProtobufBuffer(protoMessage(), null, { requestUrl: '/other', phase: 'request' }).changed, false)
    assert.equal(I.applyJsonPathRulesToProtobufBuffer(protoMessage(), null, { ...ctx, phase: 'response' }).changed, false)
  })

  it('current behavior: a seed JSON view replaces the buffer content entirely on re-encode', () => {
    setRules([jsonPathRule])
    const result = I.applyJsonPathRulesToProtobufBuffer(protoMessage(), { f1: 'seed', f2: 1 }, ctx)
    assert.equal(result.changed, true)
    assert.deepEqual(result.json, { f1: 'changed', f2: 1 })
    assert.equal(hex(result.buffer), '0a076368616e6765641001')
  })
})

describe('applyConnectRewritesForBypass', () => {
  it('returns the same buffer without rules', () => {
    const env = frame(0, protoMessage())
    assert.equal(I.applyConnectRewritesForBypass(env, {}, ctx).buffer, env)
    assert.deepEqual(I.applyConnectRewritesForBypass(Buffer.alloc(0), {}), { buffer: Buffer.alloc(0) })
  })

  it('rewrites textual bodies through the text fallback and leaves binary content types alone', () => {
    setRules([textRule])
    assert.equal(I.applyConnectRewritesForBypass(Buffer.from('{"msg":"hello"}'), { 'content-type': 'application/json' }, ctx).buffer.toString(), '{"msg":"HELLO"}')
    assert.equal(I.applyConnectRewritesForBypass(Buffer.from('hello'), { 'content-type': 'image/png' }, ctx).buffer.toString(), 'hello')
  })

  it('rewrites a gzip envelope and keeps the content-encoding header', () => {
    setRules([textRule])
    const headers = { ...PROTO, 'content-encoding': 'gzip' }
    const { buffer } = I.applyConnectRewritesForBypass(zlib.gzipSync(frame(0, protoMessage())), headers, ctx)
    assert.equal(headers['content-encoding'], 'gzip')
    assert.deepEqual(I.decodeConnectPayload(zlib.gunzipSync(buffer), PROTO).frames[0].json, { f1: 'HELLO world', f2: 42 })
  })
})
