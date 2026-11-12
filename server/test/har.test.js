'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildHar, parseHar, fromHarHeaders } = require('../src/logs/har')
const { retainRequestBody } = require('../src/logs/replay')
const { mergeById } = require('../src/api/rules-transfer')

function httpEntry(overrides = {}) {
  const entry = {
    id: 'e1',
    timestamp: '2026-11-11T10:00:00.000Z',
    requestStartTs: Date.parse('2026-11-11T10:00:00.000Z'),
    method: 'POST',
    url: '/items?x=1',
    fullUrl: 'https://api.example.com/items?x=1',
    targetUrl: 'https://api.example.com/items?x=1',
    source: 'mitm',
    headers: { 'content-type': 'application/json', cookie: 'a=1; b=2', 'x-list': ['p', 'q'] },
    responseHeaders: { 'content-type': 'application/json', location: '/next' },
    statusCode: 201,
    responseBody: '{"ok":true}',
    responseSize: 11,
    totalDurationMs: 120,
    upstreamDurationMs: 100,
    replayOf: 'e0',
    ...overrides
  }
  return entry
}

test('buildHar renders HTTP entries and skips WebSocket ones', () => {
  const entry = httpEntry()
  retainRequestBody(entry, Buffer.from('{"name":"x"}'), 1024)
  const ws = { id: 'w', method: 'WS', source: 'websocket', url: 'wss://a/b', headers: {} }

  const har = buildHar([entry, ws], { version: '2.0.0' })
  assert.equal(har.log.version, '1.2')
  assert.deepEqual(har.log.creator, { name: 'Interactive Proxy', version: '2.0.0' })
  assert.equal(har.log.entries.length, 1)

  const [first] = har.log.entries
  assert.equal(first.startedDateTime, '2026-11-11T10:00:00.000Z')
  assert.equal(first.time, 120)
  assert.equal(first.request.method, 'POST')
  assert.equal(first.request.url, 'https://api.example.com/items?x=1')
  assert.deepEqual(first.request.queryString, [{ name: 'x', value: '1' }])
  assert.deepEqual(first.request.cookies, [
    { name: 'a', value: '1' },
    { name: 'b', value: '2' }
  ])
  assert.deepEqual(first.request.headers, [
    { name: 'content-type', value: 'application/json' },
    { name: 'cookie', value: 'a=1; b=2' },
    { name: 'x-list', value: 'p' },
    { name: 'x-list', value: 'q' }
  ])
  assert.deepEqual(first.request.postData, { mimeType: 'application/json', text: '{"name":"x"}' })
  assert.equal(first.request.bodySize, 12)
  assert.equal(first.response.status, 201)
  assert.equal(first.response.statusText, 'Created')
  assert.deepEqual(first.response.content, {
    size: 11,
    mimeType: 'application/json',
    text: '{"ok":true}'
  })
  assert.equal(first.response.redirectURL, '/next')
  assert.deepEqual(first.timings, { send: 0, wait: 100, receive: 20 })
  assert.equal(first.comment, 'source=mitm replayOf=e0')
})

test('buildHar leaves out bodies the log does not hold and marks binary ones', () => {
  const streamed = httpEntry({ responseBody: '[streamed response]', responseSize: 5000 })
  const har = buildHar([streamed], { version: '2.0.0' })
  assert.deepEqual(har.log.entries[0].response.content, {
    size: 5000,
    mimeType: 'application/json'
  })
  assert.equal(har.log.entries[0].request.postData, undefined)

  const binary = httpEntry({ headers: { 'content-type': 'application/octet-stream' } })
  retainRequestBody(binary, Buffer.from([0, 1, 2]), 1024)
  const encoded = buildHar([binary], { version: '2.0.0' })
  assert.deepEqual(encoded.log.entries[0].request.postData, {
    mimeType: 'application/octet-stream',
    text: 'AAEC',
    comment: 'base64'
  })

  const errored = httpEntry({ statusCode: undefined, error: 'boom', source: 'error' })
  const failed = buildHar([errored], { version: '2.0.0' })
  assert.equal(failed.log.entries[0].response.status, 0)
  assert.equal(failed.log.entries[0].comment, 'source=error replayOf=e0 error=boom')
})

test('parseHar turns HAR entries into importable log entries, oldest first', () => {
  const har = {
    log: {
      version: '1.2',
      entries: [
        {
          startedDateTime: '2026-11-11T10:00:02.000Z',
          time: 50,
          request: {
            method: 'get',
            url: 'https://b.test/second?y=2',
            headers: [{ name: 'Accept', value: '*/*' }],
            queryString: [],
            headersSize: -1,
            bodySize: 0
          },
          response: {
            status: 200,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            content: { size: 9, mimeType: 'application/json', text: '{"n":2}' }
          },
          timings: { send: 0, wait: 40, receive: 10 }
        },
        {
          startedDateTime: '2026-11-11T10:00:01.000Z',
          time: 30,
          request: {
            method: 'POST',
            url: 'https://a.test/first',
            headers: [
              { name: 'Content-Type', value: 'application/json' },
              { name: ':authority', value: 'a.test' }
            ],
            postData: { mimeType: 'application/json', text: '{"k":1}' }
          },
          response: {
            status: 404,
            headers: [],
            content: { size: 0, mimeType: 'x-unknown' }
          }
        },
        { request: { method: 'GET', url: '/relative' }, response: {} },
        { startedDateTime: 'x', request: { url: 'https://c.test/no-method' } }
      ]
    }
  }

  const { entries, skipped } = parseHar(har, { maxEntries: 10, retainBodyBytes: 1024 })
  assert.equal(skipped, 2)
  assert.equal(entries.length, 2)

  const [first, second] = entries
  assert.equal(first.method, 'POST')
  assert.equal(first.fullUrl, 'https://a.test/first')
  assert.equal(first.url, '/first')
  assert.equal(first.source, 'imported')
  assert.deepEqual(first.headers, { 'content-type': 'application/json' })
  assert.equal(first.body, '{"k":1}')
  assert.deepEqual(first.requestBodyJson, { k: 1 })
  assert.equal(first.requestBodyRaw.toString(), '{"k":1}')
  assert.equal(first.statusCode, 404)
  assert.equal(first.responseBody, null)
  assert.equal(first.totalDurationMs, 30)

  assert.equal(second.method, 'GET')
  assert.equal(second.url, '/second?y=2')
  assert.deepEqual(second.headers, { accept: '*/*' })
  assert.equal(second.responseBody, '{"n":2}')
  assert.deepEqual(second.responseBodyJson, { n: 2 })
  assert.equal(second.upstreamDurationMs, 40)
  assert.equal(second.responseSize, 9)
  assert.equal(second.requestBodyRaw, undefined)

  const limited = parseHar(har, { maxEntries: 1, retainBodyBytes: 1024 })
  assert.equal(limited.entries.length, 1)
  assert.equal(limited.skipped, 3)

  assert.throws(() => parseHar({ nope: true }, { maxEntries: 1, retainBodyBytes: 1 }), /HAR/)
})

test('fromHarHeaders lower-cases names and joins repeats; mergeById replaces by id', () => {
  assert.deepEqual(
    fromHarHeaders([
      { name: 'Set-Cookie', value: 'a=1' },
      { name: 'set-cookie', value: 'b=2' },
      { name: 'X-Empty' }
    ]),
    { 'set-cookie': 'a=1, b=2', 'x-empty': '' }
  )
  assert.deepEqual(
    mergeById(
      [
        { id: 'a', v: 1 },
        { id: 'b', v: 1 }
      ],
      [
        { id: 'b', v: 2 },
        { id: 'c', v: 2 }
      ]
    ),
    [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
      { id: 'c', v: 2 }
    ]
  )
})
