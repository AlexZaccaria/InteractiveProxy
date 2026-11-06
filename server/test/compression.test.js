'use strict'

// Characterization tests for compression codecs, content-type heuristics,
// header lookup and body preview helpers in server/index.js.

const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('zlib')
const { loadServer } = require('./helpers/load-server')

let I

before(async () => {
  const { proxy } = await loadServer()
  I = proxy.internals
})

const SAMPLE = Buffer.from('{"hello":"world","n":[1,2,3]}')

describe('getCompressionCodec', () => {
  for (const encoding of ['gzip', 'x-gzip', 'GZIP', 'deflate', 'br', 'Br', 'zstd']) {
    test(`${encoding}: compress/decompress round-trip through Node's zlib`, () => {
      const codec = I.getCompressionCodec(encoding)
      assert.deepEqual(Object.keys(codec), ['decompress', 'compress'])
      const compressed = codec.compress(SAMPLE)
      assert.notDeepEqual(compressed, SAMPLE)
      assert.deepEqual(codec.decompress(compressed), SAMPLE)
    })
  }

  test('gzip output is readable by zlib and zstd by zstdDecompressSync', () => {
    assert.deepEqual(zlib.gunzipSync(I.getCompressionCodec('gzip').compress(SAMPLE)), SAMPLE)
    assert.deepEqual(zlib.zstdDecompressSync(I.getCompressionCodec('zstd').compress(SAMPLE)), SAMPLE)
  })

  test('identity, empty, undefined and unknown encodings have no codec', () => {
    for (const encoding of ['identity', '', undefined, 'unknown', 'compress']) {
      assert.equal(I.getCompressionCodec(encoding), null)
    }
  })
})

describe('decompressData', () => {
  test('decompresses allowed content types', () => {
    assert.equal(I.decompressData(zlib.gzipSync(SAMPLE), 'gzip', 'application/json').toString(), SAMPLE.toString())
    assert.equal(I.decompressData(zlib.brotliCompressSync(SAMPLE), 'br', 'text/html; charset=utf-8').toString(), SAMPLE.toString())
    assert.equal(I.decompressData(zlib.zstdCompressSync(SAMPLE), 'zstd', 'application/vnd.api+json').toString(), SAMPLE.toString())
  })

  test('returns the input Buffer itself when the content type is not worth decompressing', () => {
    const gz = zlib.gzipSync(SAMPLE)
    assert.equal(I.decompressData(gz, 'gzip', 'image/png'), gz)
    assert.equal(I.decompressData(gz, 'gzip', undefined), gz)
  })

  test('returns the input Buffer for identity, missing or unknown encodings', () => {
    const gz = zlib.gzipSync(SAMPLE)
    assert.equal(I.decompressData(gz, 'identity', 'application/json'), gz)
    assert.equal(I.decompressData(gz, '', 'application/json'), gz)
    assert.equal(I.decompressData(gz, 'sdch', 'application/json'), gz)
  })

  test('returns the input Buffer when the data does not match the encoding', () => {
    const corrupt = Buffer.from('not gzip at all')
    assert.equal(I.decompressData(corrupt, 'gzip', 'application/json'), corrupt)
    const gz = zlib.gzipSync(SAMPLE)
    assert.equal(I.decompressData(gz, 'deflate', 'application/json'), gz)
  })

  test('empty and null inputs pass through', () => {
    const empty = Buffer.alloc(0)
    assert.equal(I.decompressData(empty, 'gzip', 'application/json'), empty)
    assert.equal(I.decompressData(null, 'gzip', 'application/json'), null)
  })
})

describe('content-type heuristics', () => {
  const classify = ct => ({
    decompress: I.shouldDecompress(ct),
    textual: I.isTextualContentType(ct),
    binary: I.isClearlyBinaryContentType(ct),
    proto: I.isProtoContentType(ct)
  })

  test('JSON, text, JavaScript, XML and form bodies are textual and decompressed', () => {
    for (const ct of ['application/json', 'application/vnd.api+json', 'text/html; charset=utf-8', 'text/plain', 'application/javascript', 'application/xml', 'application/x-www-form-urlencoded', 'APPLICATION/JSON', 'application/connect+json']) {
      assert.deepEqual(classify(ct), { decompress: true, textual: true, binary: false, proto: false }, ct)
    }
  })

  test('protobuf and gRPC types are decompressed and flagged as proto but not textual', () => {
    for (const ct of ['application/grpc', 'application/grpc+proto', 'application/connect+proto', 'application/proto']) {
      assert.deepEqual(classify(ct), { decompress: true, textual: false, binary: false, proto: true }, ct)
    }
    // current behavior: the proto check is a substring match, so grpc-web counts as well.
    assert.equal(I.isProtoContentType('application/grpc-web+proto'), true)
    assert.deepEqual(classify('application/graphql'), { decompress: true, textual: false, binary: false, proto: false })
  })

  test('images, media, fonts and octet-stream are clearly binary and never decompressed', () => {
    for (const ct of ['application/octet-stream', 'image/png', 'video/mp4', 'audio/mpeg', 'font/woff2', 'application/font-woff']) {
      assert.deepEqual(classify(ct), { decompress: false, textual: false, binary: true, proto: false }, ct)
    }
  })

  test('image/svg+xml is XML text, not clearly binary; PDF is neither', () => {
    assert.deepEqual(classify('image/svg+xml'), { decompress: true, textual: true, binary: false, proto: false })
    assert.deepEqual(classify('application/pdf'), { decompress: false, textual: false, binary: false, proto: false })
  })

  test('missing content types are nothing', () => {
    assert.deepEqual(classify(''), { decompress: false, textual: false, binary: false, proto: false })
    assert.deepEqual(classify(undefined), { decompress: false, textual: false, binary: false, proto: false })
  })
})

describe('header lookup', () => {
  test('getContentType / getContentEncoding are case-insensitive and default to an empty string', () => {
    const headers = { 'Content-Type': 'application/json', 'content-encoding': 'gzip' }
    assert.equal(I.getContentType(headers), 'application/json')
    assert.equal(I.getContentEncoding(headers), 'gzip')
    assert.equal(I.getContentType(undefined), '')
    assert.equal(I.getContentEncoding({}), '')
  })

  test('getHeaderCaseInsensitive takes the first value of arrays and the first of duplicate keys', () => {
    assert.equal(I.getHeaderCaseInsensitive({ 'X-Multi': ['a', 'b'] }, 'x-multi'), 'a')
    assert.equal(I.getHeaderCaseInsensitive({ 'content-type': 'first', 'Content-Type': 'second' }, 'content-type'), 'first')
    assert.equal(I.getHeaderCaseInsensitive({ a: '1' }, 'x-none'), undefined)
    assert.equal(I.getHeaderCaseInsensitive(null, 'x'), undefined)
  })

  test('the per-object lookup cache follows keys added or removed after the first lookup', () => {
    const headers = { a: '1' }
    assert.equal(I.getHeaderCaseInsensitive(headers, 'a'), '1')
    headers['X-Late'] = 'late'
    assert.equal(I.getHeaderCaseInsensitive(headers, 'x-late'), 'late')
    delete headers['X-Late']
    assert.equal(I.getHeaderCaseInsensitive(headers, 'x-late'), undefined)
  })
})

describe('getFileTypeFromLogEntry', () => {
  const ft = log => I.getFileTypeFromLogEntry(log)

  test('classifies by response content type', () => {
    assert.equal(ft({ responseHeaders: { 'content-type': 'application/json' }, url: '/x' }), 'json')
    assert.equal(ft({ responseHeaders: { 'Content-Type': 'text/html' } }), 'html')
    assert.equal(ft({ responseHeaders: { 'content-type': 'text/css' } }), 'css')
    assert.equal(ft({ responseHeaders: { 'content-type': 'application/javascript' } }), 'js')
    assert.equal(ft({ responseHeaders: { 'content-type': 'image/png' } }), 'image')
    assert.equal(ft({ responseHeaders: { 'content-type': 'image/svg+xml' } }), 'image')
    assert.equal(ft({ responseHeaders: { 'content-type': 'video/mp4' } }), 'video')
    assert.equal(ft({ responseHeaders: { 'content-type': 'audio/ogg' } }), 'audio')
    assert.equal(ft({ responseHeaders: { 'content-type': 'font/woff2' } }), 'font')
    // json wins over html when both substrings are present
    assert.equal(ft({ responseHeaders: { 'content-type': 'text/html+json' } }), 'json')
  })

  test('without a content type the URL extension decides, ignoring query string and fragment', () => {
    assert.equal(ft({ url: 'https://a/b/c.woff2' }), 'font')
    assert.equal(ft({ url: 'https://a/b/c.woff2?v=1' }), 'font')
    assert.equal(ft({ url: 'https://a/b/c.woff2#frag' }), 'font')
    assert.equal(ft({ url: 'https://a/b/style.css' }), 'css')
    assert.equal(ft({ url: '/app.js' }), 'js')
    assert.equal(ft({ url: '/m.mjs' }), 'js')
    assert.equal(ft({ url: '/d.json?x' }), 'json')
    assert.equal(ft({ url: '/p.html' }), 'html')
    assert.equal(ft({ url: '/i.png' }), 'image')
    assert.equal(ft({ url: '/i.svg' }), 'image')
    assert.equal(ft({ url: '/v.mp4' }), 'video')
    assert.equal(ft({ url: '/a.mp3' }), 'audio')
    // A dot in a directory segment is not an extension; unknown extensions are "other".
    assert.equal(ft({ url: '/v1.2/users' }), 'other')
    assert.equal(ft({ url: '/noext' }), 'other')
    assert.equal(ft({ url: '/x.unknown' }), 'other')
  })

  test('the extension also decides for application/octet-stream, but any other content type wins', () => {
    assert.equal(ft({ url: '/a.css', responseHeaders: { 'content-type': 'application/octet-stream' } }), 'css')
    assert.equal(ft({ url: '/a.css', responseHeaders: { 'content-type': 'application/json' } }), 'json')
    assert.equal(ft({ url: '/a.css', responseHeaders: { 'content-type': 'text/plain' } }), 'other')
  })

  test('object bodies and parseable JSON strings count as json; binary markers do not', () => {
    assert.equal(ft({ responseBody: { a: 1 } }), 'json')
    assert.equal(ft({ body: { a: 1 } }), 'json')
    assert.equal(ft({ responseBody: ' {"a":1} ' }), 'json')
    assert.equal(ft({ body: '[1]' }), 'json')
    assert.equal(ft({ responseBody: '[Binary data: 3 bytes]' }), 'other')
    assert.equal(ft({ url: '/x', responseBody: 'hello' }), 'other')
    assert.equal(ft(null), 'other')
  })

  test('a cached fileType short-circuits the classification', () => {
    assert.equal(ft({ fileType: 'image', responseHeaders: { 'content-type': 'application/json' } }), 'image')
  })
})

describe('bufferToTextPreview', () => {
  test('returns printable text unchanged and empty for blank input', () => {
    assert.equal(I.bufferToTextPreview(Buffer.from('hello world')), 'hello world')
    assert.equal(I.bufferToTextPreview(Buffer.alloc(0)), '')
    assert.equal(I.bufferToTextPreview(Buffer.from('   \n ')), '')
    assert.equal(I.bufferToTextPreview(null), '')
  })

  test('keeps the printable characters when at least 35% of the text is printable', () => {
    assert.equal(I.bufferToTextPreview(Buffer.concat([Buffer.from('abcdefghij'), Buffer.from([0x00, 0x01])])), 'abcdefghij')
    assert.equal(I.bufferToTextPreview(Buffer.concat([Buffer.from('abcdef'), Buffer.alloc(6)])), 'abcdef')
  })

  test('joins ASCII runs of at least four characters when the buffer is mostly binary', () => {
    const mixed = Buffer.concat([
      Buffer.from([0, 1, 2, 3, 0xff, 0xfe]),
      Buffer.from('ab'),
      Buffer.from([0, 0]),
      Buffer.from('segment-one'),
      Buffer.alloc(14, 0x80),
      Buffer.from('segment-two')
    ])
    assert.equal(I.bufferToTextPreview(mixed), 'absegment-onesegment-two')
  })

  test('non-ASCII letters count as printable and are kept', () => {
    assert.equal(I.bufferToTextPreview(Buffer.from('héllo wörld')), 'héllo wörld')
    assert.equal(I.bufferToTextPreview(Buffer.from('日本語 テキスト')), '日本語 テキスト')
  })

  test('invalid UTF-8 (U+FFFD) still counts as non-printable, so binary-ish buffers degrade as before', () => {
    assert.equal(I.bufferToTextPreview(Buffer.concat([Buffer.from('abcdefghij'), Buffer.from([0xff, 0xfe, 0xc3])])), 'abcdefghij')
    assert.equal(
      I.bufferToTextPreview(Buffer.concat([Buffer.from('ab'), Buffer.alloc(14, 0xff), Buffer.from('segment-one')])),
      'absegment-one'
    )
  })
})

describe('tryParseJsonString', () => {
  test('parses whole strings and the outermost {...} or [...] slice of a longer string', () => {
    assert.deepEqual(I.tryParseJsonString('{"a":1}'), { a: 1 })
    assert.deepEqual(I.tryParseJsonString('prefix {"a":1} suffix'), { a: 1 })
    assert.deepEqual(I.tryParseJsonString('[1,2]'), [1, 2])
    assert.deepEqual(I.tryParseJsonString('xx[1]yy'), [1])
    assert.deepEqual(I.tryParseJsonString('{"a":[1]}'), { a: [1] })
    assert.deepEqual(I.tryParseJsonString('log: [{"k":1}] end'), { k: 1 })
  })

  test('returns null for blank, non-JSON and strings holding two separate JSON values', () => {
    for (const text of ['x', '', '   ', 'a{b}c', null, '{"a":1} and {"b":2}', '[1] and [2]']) {
      assert.equal(I.tryParseJsonString(text), null, JSON.stringify(text))
    }
  })
})
