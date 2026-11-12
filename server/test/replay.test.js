'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  ReplayInputError,
  retainRequestBody,
  isReplayable,
  buildReplayRequest,
  describeReplayRequest,
  applyReplayOverrides,
  buildCurlCommand
} = require('../src/logs/replay')

function entry(overrides = {}) {
  return {
    id: 'e1',
    method: 'POST',
    url: '/items',
    fullUrl: 'https://api.example.com/items',
    targetUrl: 'https://api.example.com/items',
    source: 'mitm',
    headers: {
      host: 'api.example.com',
      'content-type': 'application/json',
      'content-length': '12',
      connection: 'keep-alive',
      'x-custom': ['a', 'b']
    },
    ...overrides
  }
}

test('retainRequestBody keeps the bytes hidden from enumeration, or records the size', () => {
  const kept = entry()
  retainRequestBody(kept, Buffer.from('hello'), 10)
  assert.equal(kept.requestBodyRaw.toString(), 'hello')
  assert.deepEqual(Object.keys({ ...kept }).includes('requestBodyRaw'), false)
  assert.equal(JSON.stringify(kept).includes('requestBodyRaw'), false)

  const over = entry()
  retainRequestBody(over, Buffer.alloc(11), 10)
  assert.equal(over.requestBodyRaw, undefined)
  assert.equal(over.requestBodyNotKept, 11)

  const empty = entry()
  retainRequestBody(empty, Buffer.alloc(0), 10)
  assert.equal(empty.requestBodyRaw, undefined)
  assert.equal(empty.requestBodyNotKept, undefined)
})

test('isReplayable accepts HTTP entries with an absolute URL only', () => {
  assert.equal(isReplayable(entry()), true)
  assert.equal(isReplayable(entry({ source: 'blocked' })), true)
  assert.equal(isReplayable(entry({ method: 'WS', source: 'websocket' })), false)
  assert.equal(isReplayable(entry({ isConnectionLog: true })), false)
  assert.equal(isReplayable(entry({ isWebSocketSummary: true })), false)
  assert.equal(isReplayable(entry({ method: 'CONNECT' })), false)
  assert.equal(
    isReplayable(entry({ targetUrl: null, fullUrl: '/relative', url: '/relative' })),
    false
  )
  assert.equal(isReplayable(null), false)
})

test('buildReplayRequest drops the transport headers and joins repeated values', () => {
  const log = entry()
  retainRequestBody(log, Buffer.from('{"name":"x"}'), 1024)
  const request = buildReplayRequest(log)
  assert.equal(request.method, 'POST')
  assert.equal(request.url, 'https://api.example.com/items')
  assert.deepEqual(request.headers, { 'content-type': 'application/json', 'x-custom': 'a, b' })
  assert.equal(request.body.toString(), '{"name":"x"}')
  assert.equal(request.bodyExpected, true)
  assert.equal(request.bodyNotKeptBytes, 0)
})

test('a body that was not kept is reported as expected but missing', () => {
  const log = entry({ requestBodyNotKept: 5000 })
  const request = buildReplayRequest(log)
  assert.equal(request.body, null)
  assert.equal(request.bodyExpected, true)
  assert.equal(request.bodyNotKeptBytes, 5000)

  const get = buildReplayRequest(entry({ method: 'GET', headers: {} }))
  assert.equal(get.bodyExpected, false)
})

test('describeReplayRequest returns text bodies as text and binary bodies as base64', () => {
  const text = entry()
  retainRequestBody(text, Buffer.from('plain text'), 1024)
  const described = describeReplayRequest(text)
  assert.equal(described.body, 'plain text')
  assert.equal(described.bodyBase64, null)
  assert.equal(described.bodyIsText, true)
  assert.equal(described.bodySize, 10)
  assert.equal(described.bodyCaptured, true)

  const binary = entry()
  retainRequestBody(binary, Buffer.from([0, 1, 2, 255]), 1024)
  const describedBinary = describeReplayRequest(binary)
  assert.equal(describedBinary.body, null)
  assert.equal(describedBinary.bodyBase64, Buffer.from([0, 1, 2, 255]).toString('base64'))
  assert.equal(describedBinary.bodyIsText, false)
})

test('applyReplayOverrides validates and normalises the edits', () => {
  const base = buildReplayRequest(entry())

  const edited = applyReplayOverrides(base, {
    method: 'put',
    url: 'http://localhost:3000/x?y=1',
    headers: { 'X-Other': '1', Host: 'ignored', 'Content-Length': '99' },
    body: 'new body'
  })
  assert.equal(edited.method, 'PUT')
  assert.equal(edited.url, 'http://localhost:3000/x?y=1')
  assert.deepEqual(edited.headers, { 'x-other': '1' })
  assert.equal(edited.body.toString(), 'new body')
  // The original request is left untouched.
  assert.deepEqual(base.headers, { 'content-type': 'application/json', 'x-custom': 'a, b' })

  const withoutBody = applyReplayOverrides(base, { body: null })
  assert.equal(withoutBody.body, null)

  const binary = applyReplayOverrides(base, { bodyBase64: 'AAEC' })
  assert.deepEqual([...binary.body], [0, 1, 2])

  assert.throws(() => applyReplayOverrides(base, { method: 'TRACE' }), ReplayInputError)
  assert.throws(() => applyReplayOverrides(base, { url: 'ftp://x' }), ReplayInputError)
  assert.throws(() => applyReplayOverrides(base, { url: 'not a url' }), ReplayInputError)
  assert.throws(() => applyReplayOverrides(base, { headers: ['a'] }), ReplayInputError)
  assert.throws(
    () => applyReplayOverrides(base, { headers: { 'bad name': '1' } }),
    ReplayInputError
  )
  assert.throws(() => applyReplayOverrides(base, { headers: { ok: 'a\r\nb' } }), ReplayInputError)
  assert.throws(() => applyReplayOverrides(base, { bodyBase64: '***' }), ReplayInputError)
})

test('buildCurlCommand quotes for a POSIX shell and encodes binary bodies', () => {
  const log = entry()
  retainRequestBody(log, Buffer.from(`{"quote":"it's"}`), 1024)
  const { command, bodyIncluded, bodyEncoding } = buildCurlCommand(buildReplayRequest(log))
  assert.equal(
    command,
    [
      `curl -X POST 'https://api.example.com/items'`,
      `-H 'content-type: application/json'`,
      `-H 'x-custom: a, b'`,
      `--data-raw '{"quote":"it'\\''s"}'`
    ].join(' \\\n  ')
  )
  assert.equal(bodyIncluded, true)
  assert.equal(bodyEncoding, 'text')

  const get = buildCurlCommand(buildReplayRequest(entry({ method: 'GET', headers: {} })))
  assert.equal(get.command, `curl 'https://api.example.com/items'`)
  assert.equal(get.bodyIncluded, false)
  assert.equal(get.bodyEncoding, null)

  const head = buildCurlCommand(buildReplayRequest(entry({ method: 'HEAD', headers: {} })), {
    proxyUrl: 'http://127.0.0.1:8050'
  })
  assert.equal(
    head.command,
    `curl -I 'https://api.example.com/items' \\\n  -x 'http://127.0.0.1:8050'`
  )

  const binary = entry({ headers: {} })
  retainRequestBody(binary, Buffer.from([0, 1, 2]), 1024)
  const encoded = buildCurlCommand(buildReplayRequest(binary))
  assert.equal(
    encoded.command,
    `printf '%s' 'AAEC' | base64 -d | curl -X POST 'https://api.example.com/items' \\\n  --data-binary @-`
  )
  assert.equal(encoded.bodyEncoding, 'base64')
})
