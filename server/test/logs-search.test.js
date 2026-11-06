'use strict'

// Characterization tests for the in-memory log window: entry creation,
// addLog enrichment, filterLogsCore search/filters, client views and the
// bypass suggestions. Entries are added directly through the internals and
// the window is cleared through DELETE /api/logs between groups.

const { describe, test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { loadServer } = require('./helpers/load-server')

let I
let port
let proxy
let writeStorageFile

async function api (method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: res.status, body: await res.json() }
}

// One timestamp for every entry so that suggestion ordering (count, then
// lastSeen, then pattern) does not depend on the millisecond the test ran.
const STAMP = new Date().toISOString()

const entry = over => ({
  id: Math.random(),
  timestamp: STAMP,
  method: 'GET',
  url: '/p',
  fullUrl: 'https://h.test/p',
  source: 'proxied',
  headers: {},
  ...over
})

const labels = result => result.ordered.map(log => `${log.method} ${log.url}`)

before(async () => {
  ;({ proxy, port, writeStorageFile } = await loadServer())
  I = proxy.internals
  await proxy.start()
})

after(async () => {
  await proxy.stop()
})

describe('createLogEntry', () => {
  test('HTTP entries carry id, ISO timestamp, start timestamp, null body and client ip', () => {
    const log = I.createLogEntry({ requestStart: 1700000000000, method: 'GET', url: '/one', fullUrl: 'https://api.test/one', headers: { host: 'api.test', 'sentry-trace': 'x' }, source: 'proxied', clientIp: '1.2.3.4' })
    assert.equal(typeof log.id, 'number')
    assert.equal(log.timestamp, '2023-11-14T22:13:20.000Z')
    assert.equal(log.requestStartTs, 1700000000000)
    assert.equal(log.body, null)
    assert.equal(log.clientIp, '1.2.3.4')
    assert.deepEqual(log.headers, { host: 'api.test', 'sentry-trace': 'x' }, 'headers are kept as-is unless sanitizeHeaders is set')
    assert.equal(typeof I.createLogEntry({ method: 'GET', url: '/x', fullUrl: 'http://h/x', source: 'proxied' }).requestStartTs, 'number')
  })

  test('sanitizeHeaders strips identifying headers', () => {
    const log = I.createLogEntry({ method: 'GET', url: '/one', fullUrl: 'https://api.test/one', headers: { host: 'api.test', 'sentry-trace': 'x' }, source: 'proxied', sanitizeHeaders: true })
    assert.deepEqual(log.headers, { host: 'api.test' })
  })

  test('WebSocket connection entries are flagged and default their message and direction', () => {
    const log = I.createLogEntry({ method: 'WS', url: 'wss://s.test/sock', fullUrl: 'wss://s.test/sock', headers: {}, source: 'websocket', wsOptions: { direction: 'connected', message: 'hello', connectionId: 42 } })
    assert.equal(log.isConnectionLog, true)
    assert.equal(log.statusCode, 101)
    assert.equal(log.body, 'hello')
    assert.equal(log.connectionId, 42)
    assert.equal(log.responseBody, null)

    const defaults = I.createLogEntry({ method: 'WS', url: 'wss://s.test/sock', fullUrl: 'wss://s.test/sock', headers: {}, source: 'websocket', wsOptions: {} })
    assert.equal(defaults.direction, 'connected')
    assert.equal(defaults.body, 'WebSocket connection established')
    assert.equal('connectionId' in defaults, false)
  })
})

describe('addLog and filterLogsCore', () => {
  let a, b

  before(async () => {
    await api('DELETE', '/api/logs')
    writeStorageFile('blocked-urls.json', [{ id: 'b1', enabled: true, url: 'ads.example.com' }, { id: 'b2', enabled: false, url: '/tracking/' }])
    I.loadBlockedUrls()

    a = entry({ url: '/alpha', fullUrl: 'https://alpha.test/alpha?x=1', body: '{"q":"needle-req"}', responseBody: 'needle-resp body', responseHeaders: { 'content-type': 'application/json', 'x-resp': 'RESP-HDR' }, headers: { 'x-req': 'REQ-HDR', host: 'alpha.test' }, statusCode: 200, requestStartTs: Date.now() - 50, upstreamDurationMs: 20, responseSize: 16 })
    b = entry({ method: 'POST', url: '/beta', fullUrl: 'https://beta.test/beta', source: 'mitm', targetUrl: 'https://beta.test/beta', body: { nested: { deep: 'json-needle' } }, rewrites: [{ id: 'r1', target: 'request' }] })
    const rest = [
      entry({ method: 'OPTIONS', url: '/gamma', fullUrl: 'https://gamma.test/gamma' }),
      entry({ url: '/delta', fullUrl: 'https://delta.test/delta', source: 'direct' }),
      entry({ url: '/eps', fullUrl: 'https://eps.test/eps', source: 'local', localResource: '/eps-local' }),
      entry({ method: 'WS', url: 'wss://ws.test/s', fullUrl: 'wss://ws.test/s', source: 'websocket', isConnectionLog: true, direction: 'connected' }),
      entry({ method: 'WS', url: 'wss://ws.test/s', fullUrl: 'wss://ws.test/s', source: 'websocket', direction: 'client->server', body: 'msg-needle' }),
      entry({ url: '/blocked', fullUrl: 'https://ads.example.com/blocked', source: 'blocked', statusCode: 204 }),
      entry({ url: '/hidden', fullUrl: 'https://other.test/tracking/pixel' }),
      entry({ url: '/resp-rw', fullUrl: 'https://rw.test/resp', rewrites: [{ id: 'r2', target: 'response' }], responseHeaders: { 'content-type': 'text/css' } }),
      entry({ url: '/both-rw', fullUrl: 'https://rw.test/both', rewrites: [{ id: 'r3', target: 'both' }], responseHeaders: { 'content-type': 'image/png' } }),
      entry({ url: '/err', fullUrl: 'https://err.test/x', source: 'error', error: 'boom' })
    ]
    for (const log of [a, b, ...rest]) I.addLog(log)
  })

  test('addLog precomputes search text, file type, snapshots and metrics on the entry', () => {
    assert.equal(a.searchBase, '/alpha get  ', 'url + method + targetUrl + localResource, lower-cased (fullUrl is not part of it)')
    assert.equal(a.fileType, 'json')
    assert.equal(a.requestSearchContent, '{"q":"needle-req"}')
    assert.equal(a.headersSearch, 'x-req:req-hdr\nhost:alpha.test')
    assert.equal(a.responseSearchContent, 'needle-resp body')
    assert.equal(a.responseHeadersSearch, 'content-type:application/json\nx-resp:resp-hdr')
    assert.equal(typeof a.totalDurationMs, 'number')
    assert.equal(a.proxyOverheadMs, a.totalDurationMs - 20)
    assert.equal(a.responseBytes, 16)
    assert.equal(a.hiddenByBlockedRules, false)

    assert.equal(b.searchBase, '/beta post https://beta.test/beta ')
    assert.equal(b.requestSearchContent, '{\n  "nested": {\n    "deep": "json-needle"\n  }\n}', 'object bodies are indexed as pretty-printed JSON')
    assert.equal(b.headersSearch, '{}', 'an empty headers object falls back to its JSON text')
    assert.equal(b.rewriteCount, 1)
  })

  test('entries matching any blocked pattern, enabled or not, are flagged hidden', () => {
    const hidden = I.filterLogsCore({ sources: 'proxied,blocked' }).ordered.filter(log => log.hiddenByBlockedRules)
    assert.equal(hidden.length, 0)
    assert.equal(I.filterLogsCore({ search: 'hidden' }).total, 0)
    assert.equal(I.filterLogsCore({ search: 'blocked' }).total, 0)
  })

  test('the default view is oldest-first, limited to proxied/mitm/websocket plus local/blocked/error, GET/POST/PUT/DELETE/PATCH and no connection entries', () => {
    const result = I.filterLogsCore({})
    assert.equal(result.total, 7)
    assert.deepEqual(labels(result), ['GET /alpha', 'POST /beta', 'GET /eps', 'WS wss://ws.test/s', 'GET /resp-rw', 'GET /both-rw', 'GET /err'])
  })

  test('sources, methods and showWsConnections widen the default view', () => {
    assert.deepEqual(labels(I.filterLogsCore({ sources: 'proxied,mitm,websocket,direct,tunnel' })), ['GET /alpha', 'POST /beta', 'GET /delta', 'GET /eps', 'WS wss://ws.test/s', 'GET /resp-rw', 'GET /both-rw', 'GET /err'])
    assert.deepEqual(labels(I.filterLogsCore({ sources: ['local', 'blocked'] })), ['GET /eps', 'GET /err'], 'local/blocked/error are always included; blocked entries here are hidden by the blocked pattern')
    assert.deepEqual(labels(I.filterLogsCore({ methods: 'OPTIONS' })), ['OPTIONS /gamma', 'WS wss://ws.test/s'], 'WS entries ignore the method filter')
    assert.deepEqual(labels(I.filterLogsCore({ showWsConnections: 'true' })), ['GET /alpha', 'POST /beta', 'GET /eps', 'WS wss://ws.test/s', 'WS wss://ws.test/s', 'GET /resp-rw', 'GET /both-rw', 'GET /err'])
  })

  test('search runs on url/method/targetUrl/localResource with ; (AND), ! (NOT) and || (OR groups)', () => {
    assert.deepEqual(labels(I.filterLogsCore({ search: 'ALPHA' })), ['GET /alpha'])
    assert.deepEqual(labels(I.filterLogsCore({ search: 'test; beta' })), ['POST /beta'])
    assert.deepEqual(labels(I.filterLogsCore({ search: '!alpha; !beta; !ws' })), ['GET /eps', 'GET /resp-rw', 'GET /both-rw', 'GET /err'])
    assert.deepEqual(labels(I.filterLogsCore({ search: 'alpha || beta' })), ['GET /alpha', 'POST /beta'])
    assert.deepEqual(labels(I.filterLogsCore({ search: 'beta.test/beta' })), ['POST /beta'])
    assert.deepEqual(labels(I.filterLogsCore({ search: 'eps-local' })), ['GET /eps'])
    assert.deepEqual(labels(I.filterLogsCore({ search: 'post' })), ['POST /beta'])
  })

  test('current behavior: search does not look at fullUrl or bodies, so a host is only found through targetUrl', () => {
    assert.deepEqual(labels(I.filterLogsCore({ search: 'alpha.test' })), [])
    assert.deepEqual(labels(I.filterLogsCore({ search: 'needle-req' })), [])
  })

  test('requestSearch and responseSearch look at body snapshots and header name:value pairs', () => {
    assert.deepEqual(labels(I.filterLogsCore({ requestSearch: 'NEEDLE-REQ' })), ['GET /alpha'])
    assert.deepEqual(labels(I.filterLogsCore({ requestSearch: 'json-needle' })), ['POST /beta'])
    assert.deepEqual(labels(I.filterLogsCore({ requestSearch: 'req-hdr' })), ['GET /alpha'])
    assert.deepEqual(labels(I.filterLogsCore({ requestSearch: 'x-req:' })), ['GET /alpha'])
    assert.deepEqual(labels(I.filterLogsCore({ requestSearch: 'msg-needle' })), ['WS wss://ws.test/s'])
    assert.deepEqual(labels(I.filterLogsCore({ responseSearch: 'needle-resp' })), ['GET /alpha'])
    assert.deepEqual(labels(I.filterLogsCore({ responseSearch: 'resp-hdr' })), ['GET /alpha'])
  })

  test('fileTypes and rewritten-only filters', () => {
    assert.deepEqual(labels(I.filterLogsCore({ fileTypes: 'json' })), ['GET /alpha', 'POST /beta'])
    assert.deepEqual(labels(I.filterLogsCore({ fileTypes: 'css' })), ['GET /resp-rw'])
    assert.deepEqual(labels(I.filterLogsCore({ fileTypes: 'image' })), ['GET /both-rw'])
    assert.deepEqual(labels(I.filterLogsCore({ requestRewrittenOnly: 'true' })), ['POST /beta', 'GET /both-rw'])
    assert.deepEqual(labels(I.filterLogsCore({ responseRewrittenOnly: 'true' })), ['GET /resp-rw', 'GET /both-rw'])
    assert.deepEqual(labels(I.filterLogsCore({ requestRewrittenOnly: 'true', responseRewrittenOnly: 'true' })), ['GET /both-rw'])
  })

  test('buildClientLogView returns the full view with bodies; /api/logs?view=summary omits them', async () => {
    const view = I.buildClientLogView(a)
    assert.equal(view.id, a.id)
    assert.equal(view.fileType, 'json')
    assert.equal(view.body, '{"q":"needle-req"}')
    assert.equal(view.responseBody, 'needle-resp body')
    assert.deepEqual(view.responseHeaders, { 'content-type': 'application/json', 'x-resp': 'RESP-HDR' })
    assert.equal(view.proxyOverheadMs, a.proxyOverheadMs)
    assert.equal('searchBase' in view, false)
    assert.equal('requestSearchContent' in view, false)

    const viewB = I.buildClientLogView(b)
    assert.deepEqual(viewB.rewrites, [{ id: 'r1', target: 'request' }])
    assert.equal(viewB.rewriteCount, 1)
    assert.deepEqual(viewB.body, { nested: { deep: 'json-needle' } })
    assert.equal(I.buildClientLogView(null), null)

    const { body } = await api('GET', '/api/logs?view=summary&limit=2')
    assert.equal(body.total, 7)
    assert.equal(body.hasMore, true)
    assert.deepEqual(body.items.map(item => item.url), ['/alpha', '/beta'])
    assert.equal('body' in body.items[0], false)
    assert.equal('responseBody' in body.items[0], false)
    assert.deepEqual(body.items[0].headers, { 'x-req': 'REQ-HDR', host: 'alpha.test' })

    const detail = await api('GET', `/api/logs/${encodeURIComponent(a.id)}`)
    assert.equal(detail.body.body, '{"q":"needle-req"}')
  })

  test('computeBypassSuggestions groups hosts by count with their top paths and skips hosts covered by a host rule', () => {
    writeStorageFile('filter-urls.json', [{ id: 'f1', enabled: true, url: 'rw.test', mode: 'ignore' }])
    I.loadBypassUrls()
    const suggestions = I.computeBypassSuggestions({ limit: 3 })
    assert.deepEqual(suggestions.map(s => [s.pattern, s.count]), [['ws.test', 2], ['ads.example.com', 1], ['alpha.test', 1]])
    assert.deepEqual(suggestions[0].samplePaths, [{ path: '/s', count: 2 }])
    assert.equal(typeof suggestions[0].lastSeen, 'number')
    assert.equal(I.computeBypassSuggestions({ limit: 0 }).length, 1, 'limit is clamped to 1..50')
    writeStorageFile('filter-urls.json', [])
    I.loadBypassUrls()
  })
})

describe('log window eviction', () => {
  beforeEach(async () => {
    await api('DELETE', '/api/logs')
  })

  test('DELETE /api/logs empties the window', () => {
    assert.equal(I.filterLogsCore({}).total, 0)
  })

  test('the window keeps the newest 5000 entries (default PROXY_MAX_LOG_ENTRIES) and drops the oldest', () => {
    for (let n = 0; n <= 5000; n++) I.addLog(entry({ url: `/ev${n}`, fullUrl: `https://ev.test/ev${n}` }))
    const result = I.filterLogsCore({})
    assert.equal(result.total, 5000)
    assert.equal(result.ordered[0].url, '/ev1')
    assert.equal(result.ordered[4999].url, '/ev5000')
  })
})

describe('metrics and snapshots', () => {
  test('computeLogEntryMetrics derives durations, byte counts, rewrite count and Connect summary', () => {
    const log = { requestStartTs: Date.now() - 100, upstreamDurationMs: 30, rawRequestBodyBase64: Buffer.from('abc').toString('base64'), rawResponseBodyBase64: Buffer.from('abcdef').toString('base64'), rewrites: [1, 2], connectRequest: { frames: [1, 2, 3] } }
    I.computeLogEntryMetrics(log)
    assert.ok(log.totalDurationMs >= 100)
    assert.equal(log.proxyOverheadMs, log.totalDurationMs - 30)
    assert.equal(log.requestBytes, 3)
    assert.equal(log.responseBytes, 6)
    assert.equal(log.rewriteCount, 2)
    assert.deepEqual(log.connectSummary, { hasRequest: true, hasResponse: false, requestFrameCount: 3, responseFrameCount: 0 })
  })

  test('computeLogEntryMetrics falls back to Content-Length, never overwrites existing numbers and clamps overhead at 0', () => {
    const fromHeader = { headers: { 'Content-Length': '77' }, responseSize: 0 }
    I.computeLogEntryMetrics(fromHeader)
    assert.equal(fromHeader.requestBytes, 77)
    assert.equal('responseBytes' in fromHeader, false)

    const preserved = { totalDurationMs: 5, upstreamDurationMs: 10, requestBytes: 1, responseBytes: 2, rewriteCount: 9, rewrites: [] }
    I.computeLogEntryMetrics(preserved)
    assert.deepEqual(preserved, { totalDurationMs: 5, upstreamDurationMs: 10, requestBytes: 1, responseBytes: 2, rewriteCount: 9, rewrites: [], proxyOverheadMs: 0 })
    assert.equal(I.computeLogEntryMetrics(null), undefined)
  })

  test('ensureLogSearchSnapshots lower-cases bodies and headers and skips absent sides', () => {
    const log = { body: { a: 1 }, headers: { H: 'v', u: undefined }, responseBody: 'R', responseHeaders: { 'X-Y': 'z' } }
    I.ensureLogSearchSnapshots(log)
    assert.equal(log.requestSearchContent, '{\n  "a": 1\n}')
    assert.equal(log.headersSearch, 'h:v')
    assert.equal(log.responseSearchContent, 'r')
    assert.equal(log.responseHeadersSearch, 'x-y:z')
    const empty = {}
    I.ensureLogSearchSnapshots(empty)
    assert.deepEqual(empty, {})
  })

  test('buildSearchSnapshot joins lower-cased parts with newlines and truncates at 256 KiB', () => {
    assert.equal(I.buildSearchSnapshot(['Abc', '', null, 'DEF']), 'abc\ndef')
    assert.equal(I.buildSearchSnapshot([]), '')
    assert.equal(I.buildSearchSnapshot('x'), '')
    const big = I.buildSearchSnapshot(['x'.repeat(256 * 1024 + 10), 'more'])
    assert.equal(big.length, 256 * 1024 + '\n[search snapshot truncated]'.length)
    assert.ok(big.endsWith('\n[search snapshot truncated]'))
  })

  test('buildJsonSearchSnapshot indexes flat objects as key:value lines and other values as JSON', () => {
    assert.equal(I.buildJsonSearchSnapshot({ A: 'B', n: 1, u: undefined }), 'a:b\nn:1')
    assert.equal(I.buildJsonSearchSnapshot([1, 'X']), '[1,"x"]')
    assert.equal(I.buildJsonSearchSnapshot({}), '{}')
    assert.equal(I.buildJsonSearchSnapshot('STR'), '"str"')
    assert.equal(I.buildJsonSearchSnapshot(null), '')
  })
})

describe('query helpers', () => {
  test('parseListQuery splits on commas, trims, dedupes and copies the default list', () => {
    assert.deepEqual(I.parseListQuery('a, b,,a'), ['a', 'b'])
    assert.deepEqual(I.parseListQuery(['a', 'b,c', ''], ['d']), ['a', 'b', 'c'])
    assert.deepEqual(I.parseListQuery('', ['d']), ['d'])
    assert.deepEqual(I.parseListQuery(undefined, ['d']), ['d'])
    assert.deepEqual(I.parseListQuery(5, ['d']), ['d'])
    const defaults = ['x']
    assert.notEqual(I.parseListQuery(undefined, defaults), defaults)
  })

  test('queryBool is true only for the string "true" (any case) or boolean true', () => {
    assert.deepEqual(['true', 'TRUE', 'false', '1', undefined, null, true, 'yes'].map(v => I.queryBool(v)), [true, true, false, false, false, false, true, false])
  })

  test('safeString keeps strings as-is and safeTrim trims; non-strings become empty', () => {
    assert.deepEqual([I.safeString(' a '), I.safeString(1), I.safeString(null)], [' a ', '', ''])
    assert.deepEqual([I.safeTrim(' a '), I.safeTrim(1), I.safeTrim(null)], ['a', '', ''])
  })
})
