'use strict'

// Characterization tests for target resolution, block/filter decisions and
// header forwarding helpers in server/index.js. Rules are loaded through the
// real storage files and mode/flag toggles go through the management API of
// a started proxy, so the tests exercise the same paths as the UI.

const { describe, test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { loadServer } = require('./helpers/load-server')

let I
let port
let proxy
let writeStorageFile

const req = (headers, url, extra = {}) => ({ headers, url, originalUrl: url, method: 'GET', socket: {}, ...extra })

async function api (method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: res.status, body: await res.json() }
}

before(async () => {
  ;({ proxy, port, writeStorageFile } = await loadServer())
  I = proxy.internals
  await proxy.start()
})

after(async () => {
  await proxy.stop()
})

describe('resolveTargetFromRequest', () => {
  test('X-Target-URL wins and is parsed into url/host/hostWithPort', () => {
    assert.deepEqual(
      I.resolveTargetFromRequest(req({ 'x-target-url': 'https://api.example.com:8443/v1/x?q=1', host: `localhost:${port}` }, '/v1/x')),
      { url: 'https://api.example.com:8443/v1/x?q=1', host: 'api.example.com', hostWithPort: 'api.example.com:8443' }
    )
  })

  test('an unparsable or non-http X-Target-URL is ignored', () => {
    assert.deepEqual(I.resolveTargetFromRequest(req({ 'x-target-url': 'notaurl', host: `localhost:${port}` }, '/v1/x')), { url: null, host: 'localhost' })
    assert.deepEqual(I.resolveTargetFromRequest(req({ 'x-target-url': 'ftp://x/y', host: `localhost:${port}` }, '/v1/x')), { url: null, host: 'localhost' })
  })

  test('a proxy-style absolute request URL is used as the target', () => {
    assert.deepEqual(I.resolveTargetFromRequest(req({ host: 'example.com' }, 'http://example.com/a/b?c=1')), { url: 'http://example.com/a/b?c=1', host: 'example.com', hostWithPort: 'example.com' })
    assert.deepEqual(I.resolveTargetFromRequest(req({ host: 'example.com' }, 'HTTPS://Example.com/P')), { url: 'HTTPS://Example.com/P', host: 'example.com', hostWithPort: 'example.com' })
  })

  test('ws:// and wss:// targets are carried as their http/https equivalent', () => {
    assert.deepEqual(I.resolveTargetFromRequest(req({ host: 'example.com' }, 'ws://example.com/sock')), {
      url: 'http://example.com/sock', host: 'example.com', hostWithPort: 'example.com'
    })
    assert.deepEqual(I.resolveTargetFromRequest(req({ host: 'example.com' }, 'WSS://Example.com/P')), {
      url: 'https://Example.com/P', host: 'example.com', hostWithPort: 'example.com'
    })
    assert.deepEqual(I.resolveTargetFromRequest(req({ 'x-target-url': 'wss://a/b', host: `localhost:${port}` }, '/x')), {
      url: 'https://a/b', host: 'a', hostWithPort: 'a'
    })
  })

  test('a foreign Host header builds the target from the assumed protocol', () => {
    assert.deepEqual(I.resolveTargetFromRequest(req({ host: 'upstream.test:9099' }, '/path?x=1')), { url: 'http://upstream.test:9099/path?x=1', host: 'upstream.test', hostWithPort: 'upstream.test:9099' })
    assert.equal(I.resolveTargetFromRequest(req({ host: 'upstream.test', 'x-forwarded-proto': 'https, http' }, '/p')).url, 'https://upstream.test/p')
    assert.equal(I.resolveTargetFromRequest(req({ host: 'upstream.test' }, '/p', { socket: { encrypted: true } })).url, 'https://upstream.test/p')
    assert.deepEqual(I.resolveTargetFromRequest(req({ host: '  a.test ' }, '/p')), { url: 'http://a.test/p', host: 'a.test', hostWithPort: 'a.test' })
    assert.deepEqual(I.resolveTargetFromRequest(req({ host: 'a.test' }, '')), { url: 'http://a.test', host: 'a.test', hostWithPort: 'a.test' })
  })

  test('the proxy\'s own authority and a missing Host give no target', () => {
    assert.deepEqual(I.resolveTargetFromRequest(req({ host: `localhost:${port}` }, '/api/config')), { url: null, host: 'localhost' })
    assert.deepEqual(I.resolveTargetFromRequest(req({ host: `127.0.0.1:${port}` }, '/api/config')), { url: null, host: '127.0.0.1' })
    assert.deepEqual(I.resolveTargetFromRequest(req({}, '/p')), { url: null, host: null })
    assert.deepEqual(I.resolveTargetFromRequest(req({ host: 'bad host' }, '/p')), { url: null, host: 'bad host' })
  })

  test('the own-authority comparison is case-insensitive and covers the IPv6 loopback; a bare "localhost" is another host', () => {
    assert.deepEqual(I.resolveTargetFromRequest(req({ host: `LOCALHOST:${port}` }, '/api/config')), { url: null, host: 'localhost' })
    assert.equal(I.resolveTargetFromRequest(req({ host: `[::1]:${port}` }, '/api/config')).url, null)
    assert.equal(I.resolveTargetFromRequest(req({ host: 'localhost' }, '/api/config')).url, 'http://localhost/api/config')
  })
})

describe('isProxyTargetedRequest', () => {
  test('true for X-Target-URL, absolute URLs and foreign Host headers', () => {
    assert.equal(I.isProxyTargetedRequest(req({ 'x-target-url': 'http://a/b', host: `localhost:${port}` }, '/api/x')), true)
    assert.equal(I.isProxyTargetedRequest(req({ host: `localhost:${port}` }, 'http://a/api/x')), true)
    assert.equal(I.isProxyTargetedRequest(req({ host: 'a.test:80' }, '/api/x')), true)
    assert.equal(I.isProxyTargetedRequest(req({ host: 'localhost' }, '/api/x')), true)
  })

  test('false for the proxy\'s own authorities (case-insensitive), IPv6 loopback, no Host or an empty X-Target-URL', () => {
    assert.equal(I.isProxyTargetedRequest(req({ host: `127.0.0.1:${port}` }, '/api/x')), false)
    assert.equal(I.isProxyTargetedRequest(req({ host: `LocalHost:${port}` }, '/api/x')), false)
    assert.equal(I.isProxyTargetedRequest(req({ host: `[::1]:${port}` }, '/api/x')), false)
    assert.equal(I.isProxyTargetedRequest(req({}, '/api/x')), false)
    assert.equal(I.isProxyTargetedRequest(req({ 'x-target-url': '', host: `localhost:${port}` }, '/api/x')), false)
  })
})

describe('routing context helpers', () => {
  test('buildRoutingContext fills defaults and stringifies the host', () => {
    assert.deepEqual(I.buildRoutingContext(), { requestUrl: '/', fullUrl: null, host: null, path: null, targetUrl: null, method: undefined })
    assert.deepEqual(I.buildRoutingContext({ host: 123 }).host, '123')
    assert.deepEqual(
      I.buildRoutingContext({ requestUrl: '/a', fullUrl: 'https://h/a', host: 'h', path: '/a', targetUrl: 'https://h/a', method: 'POST' }),
      { requestUrl: '/a', fullUrl: 'https://h/a', host: 'h', path: '/a', targetUrl: 'https://h/a', method: 'POST' }
    )
  })

  test('createBypassContext lower-cases hosts (without port) and collects URL, path and pathname candidates', () => {
    assert.deepEqual(
      I.createBypassContext({ requestUrl: '/A?x=1', fullUrl: 'https://CDN.Example.com/Img/a.PNG?x=1', host: 'Other.host:443', path: '/Img/a.PNG', targetUrl: 'https://t.example/T' }),
      {
        hostCandidates: ['other.host', 't.example', 'cdn.example.com'],
        valueCandidates: ['/a?x=1', 'https://t.example/t', '/t', 'https://cdn.example.com/img/a.png?x=1', '/img/a.png', '/img/a.png']
      }
    )
    assert.deepEqual(I.createBypassContext({}), { hostCandidates: [], valueCandidates: [] })
    assert.deepEqual(I.createBypassContext({ targetUrl: 'not a url' }), { hostCandidates: [], valueCandidates: ['not a url'] })
  })

  test('hostPatternMatches: a leading dot or a bare domain both match the domain and its subdomains', () => {
    assert.equal(I.hostPatternMatches('.example.com', 'example.com'), true)
    assert.equal(I.hostPatternMatches('.example.com', 'a.example.com'), true)
    assert.equal(I.hostPatternMatches('.example.com', 'notexample.com'), false)
    assert.equal(I.hostPatternMatches('example.com', 'example.com'), true)
    assert.equal(I.hostPatternMatches('example.com', 'sub.example.com'), true)
    assert.equal(I.hostPatternMatches('example.com', 'notexample.com'), false)
    assert.equal(I.hostPatternMatches('', 'x'), false)
    assert.equal(I.hostPatternMatches('x', ''), false)
  })

  test('isInternalProxyRequest recognises loopback hosts and URLs containing the proxy authority', () => {
    assert.equal(I.isInternalProxyRequest({ host: 'localhost' }), true)
    assert.equal(I.isInternalProxyRequest({ host: '127.0.0.1:9999' }), true)
    assert.equal(I.isInternalProxyRequest({ host: 'LOCALHOST' }), true)
    assert.equal(I.isInternalProxyRequest({ host: 'example.com', fullUrl: `http://localhost:${port}/x` }), true)
    assert.equal(I.isInternalProxyRequest({ host: 'example.com', requestUrl: '/x' }), false)
    assert.equal(I.isInternalProxyRequest({ requestUrl: '/x' }), false)
    assert.equal(I.isInternalProxyRequest({}), false)
    assert.equal(I.isInternalProxyRequest(), false)
  })

  test('a targetUrl alone is enough for isInternalProxyRequest, and null contexts decide like empty ones', () => {
    assert.equal(I.isInternalProxyRequest({ targetUrl: `http://127.0.0.1:${port}/x` }), true)
    assert.equal(I.isInternalProxyRequest({ targetUrl: 'http://example.com/x' }), false)
    assert.equal(I.isInternalProxyRequest(null), false)
    assert.equal(I.decideHttpHandling(null), 'proxy')
    assert.deepEqual(I.decideWebSocketHandling(null), { action: 'mitm', requestUrl: '/', fullUrl: null })
    assert.equal(I.decideHttpHandling(undefined), 'proxy')
    assert.equal(I.decideHttpHandling({}), 'proxy')
    assert.deepEqual(I.decideWebSocketHandling(undefined), { action: 'mitm', requestUrl: '/', fullUrl: null })
  })
})

describe('blocked rules', () => {
  const adsCtx = { requestUrl: '/ads/x', fullUrl: 'https://ads.example.com/ads/x', host: 'ads.example.com' }

  test('without rules nothing is blocked', () => {
    assert.equal(I.isRequestBlocked('/ads/x', 'https://ads.example.com/ads/x'), false)
    assert.equal(I.decideHttpHandling(adsCtx), 'proxy')
  })

  test('enabled rules match by substring on the request URL or the full URL; disabled rules do not', async () => {
    writeStorageFile('blocked-urls.json', [
      { id: 'b1', enabled: true, name: 'Ads', url: 'ads.example.com' },
      { id: 'b2', enabled: false, name: 'Off', url: 'disabled.example.com' },
      { url: '/tracking/' }
    ])
    I.loadBlockedUrls()

    assert.equal(I.isRequestBlocked('/ads/x', 'https://ads.example.com/ads/x'), true)
    assert.equal(I.isRequestBlocked('/tracking/pixel', null), true)
    assert.equal(I.isRequestBlocked('/x', 'https://disabled.example.com/x'), false)
    assert.equal(I.isRequestBlocked('/x', 'https://ok.example.com/x'), false)
    assert.equal(I.isRequestBlocked(null, undefined), false)
    assert.equal(I.decideHttpHandling(adsCtx), 'block')
    assert.deepEqual(I.decideWebSocketHandling(adsCtx), { action: 'block', requestUrl: '/ads/x', fullUrl: 'https://ads.example.com/ads/x' })

    // A rule without id/name gets a generated id and a derived (here empty) name.
    const { body } = await api('GET', '/api/blocked')
    assert.equal(body.length, 3)
    assert.match(body[2].id, /^blocked-\d+-[a-z0-9]+$/)
    assert.equal(body[2].name, '')
    assert.equal(body[2].enabled, true)
  })

  test('the global blocked-rules switch disables matching without touching the rules', async () => {
    assert.deepEqual((await api('POST', '/api/blocked-rules-mode', { enabled: false })).body, { success: true, blockedRulesEnabled: false })
    assert.equal(I.isRequestBlocked('/ads/x', 'https://ads.example.com/ads/x'), false)
    assert.deepEqual((await api('POST', '/api/blocked-rules-mode', { enabled: true })).body, { success: true, blockedRulesEnabled: true })
    assert.equal(I.isRequestBlocked('/ads/x', 'https://ads.example.com/ads/x'), true)
  })
})

describe('filter rules', () => {
  const cdnCtx = { requestUrl: '/a.js', fullUrl: 'https://cdn.example.com/a.js', host: 'cdn.example.com', path: '/a.js', targetUrl: 'https://cdn.example.com/a.js' }
  const subCdnCtx = { requestUrl: '/a.js', fullUrl: 'https://img.cdn.example.com/a.js', host: 'img.cdn.example.com' }
  const pathCtx = { requestUrl: '/static/app.js', fullUrl: 'https://app.test/static/app.js', host: 'app.test' }
  const upperPathCtx = { requestUrl: '/STATIC/x', fullUrl: 'https://App.test/STATIC/x', host: 'App.test' }
  const focusCtx = { requestUrl: '/v1', fullUrl: 'https://api.focus.test/v1', host: 'api.focus.test' }
  const otherCtx = { requestUrl: '/v1', fullUrl: 'https://other.test/v1', host: 'other.test' }
  const disabledCtx = { requestUrl: '/x', fullUrl: 'https://disabled.cdn.test/x', host: 'disabled.cdn.test' }
  const suffixCtx = { requestUrl: '/x', fullUrl: 'https://a.suffix.test/x', host: 'a.suffix.test' }
  const notCdnCtx = { requestUrl: '/x', fullUrl: 'https://notcdn.example.com/x', host: 'notcdn.example.com' }
  const internalCtx = { requestUrl: '/static/x', fullUrl: `http://localhost:${port}/static/x`, host: 'localhost' }

  const decide = ctx => ({
    bypass: I.shouldBypassRequest(ctx),
    direct: I.shouldUseDirectConnection(ctx),
    http: I.decideHttpHandling(ctx),
    ws: I.decideWebSocketHandling(ctx).action
  })

  before(() => {
    writeStorageFile('filter-urls.json', [
      { id: 'f1', enabled: true, name: 'CDN', url: 'cdn.example.com', mode: 'ignore' },
      { id: 'f2', enabled: true, name: 'Path', url: '/static/', mode: 'ignore' },
      { id: 'f3', enabled: true, name: 'Focus only', url: 'api.focus.test', mode: 'focus' },
      { id: 'f4', enabled: false, name: 'Disabled', url: 'disabled.cdn.test', mode: 'ignore' },
      { id: 'f5', enabled: true, name: 'Dot', url: '.suffix.test', mode: 'ignore' }
    ])
    I.loadBypassUrls()
  })

  test('ignore mode (default): matching hosts, subdomains and path substrings go direct, everything else is proxied', () => {
    assert.equal(I.getBypassMode(), 'ignore')
    const direct = { bypass: true, direct: true, http: 'direct', ws: 'direct' }
    const proxied = { bypass: false, direct: false, http: 'proxy', ws: 'mitm' }
    assert.deepEqual(decide(cdnCtx), direct)
    assert.deepEqual(decide(subCdnCtx), direct)
    assert.deepEqual(decide(pathCtx), direct)
    assert.deepEqual(decide(upperPathCtx), direct)
    assert.deepEqual(decide(suffixCtx), direct)
    assert.deepEqual(decide(focusCtx), proxied, 'focus-mode rules are inactive in ignore mode')
    assert.deepEqual(decide(otherCtx), proxied)
    assert.deepEqual(decide(disabledCtx), proxied)
    assert.deepEqual(decide(notCdnCtx), proxied, 'host patterns do not match a longer label')
  })

  test('internal proxy requests are never sent direct even when a rule matches', () => {
    assert.deepEqual(decide(internalCtx), { bypass: true, direct: false, http: 'proxy', ws: 'mitm' })
  })

  test('focus mode: only requests matching a focus rule are proxied, the rest go direct', async () => {
    assert.deepEqual((await api('POST', '/api/filter-mode', { mode: 'focus' })).body, { success: true, filterMode: 'focus' })
    assert.equal(I.getBypassMode(), 'focus')
    assert.deepEqual(decide(focusCtx), { bypass: true, direct: false, http: 'proxy', ws: 'mitm' })
    assert.deepEqual(decide(cdnCtx), { bypass: false, direct: true, http: 'direct', ws: 'direct' })
    assert.deepEqual(decide(otherCtx), { bypass: false, direct: true, http: 'direct', ws: 'direct' })
    assert.deepEqual(decide(internalCtx), { bypass: false, direct: false, http: 'proxy', ws: 'mitm' })

    const bad = await api('POST', '/api/filter-mode', { mode: 'nope' })
    assert.equal(bad.status, 400)
    assert.deepEqual((await api('POST', '/api/filter-mode', { mode: 'ignore' })).body, { success: true, filterMode: 'ignore' })
    assert.equal(I.getBypassMode(), 'ignore')
  })

  test('the global filter-rules switch turns every decision into proxy', async () => {
    assert.deepEqual((await api('POST', '/api/filter-rules-mode', { enabled: false })).body, { success: true, filterRulesEnabled: false })
    assert.deepEqual(decide(cdnCtx), { bypass: false, direct: false, http: 'proxy', ws: 'mitm' })
    assert.deepEqual((await api('POST', '/api/filter-rules-mode', { enabled: true })).body, { success: true, filterRulesEnabled: true })
    assert.equal(I.decideHttpHandling(cdnCtx), 'direct')
  })

  test('GET /api/filters lists only the rules of the current mode', async () => {
    const { body } = await api('GET', '/api/filters')
    assert.deepEqual(body.map(rule => rule.id), ['f1', 'f2', 'f4', 'f5'])
  })

  test('blocked rules win over filter rules', () => {
    assert.equal(I.decideHttpHandling({ requestUrl: '/ads/x', fullUrl: 'https://ads.example.com/ads/x', host: 'ads.example.com' }), 'block')
  })
})

describe('header helpers', () => {
  const source = { Host: 'orig', 'X-Target-URL': 'http://t', connection: 'keep-alive', 'Proxy-Connection': 'keep-alive', 'content-length': '5', 'if-none-match': 'etag', accept: 'x', undef: undefined }

  test('createForwardHeaders copies defined headers, omits case-insensitively and applies overrides as given', () => {
    assert.deepEqual(I.createForwardHeaders(source), {
      Host: 'orig', 'X-Target-URL': 'http://t', connection: 'keep-alive', 'Proxy-Connection': 'keep-alive', 'content-length': '5', 'if-none-match': 'etag', accept: 'x'
    })
    assert.deepEqual(I.createForwardHeaders(source, ['X-TARGET-URL', 'Connection'], { host: 'new', accept: 'y' }), {
      Host: 'orig', 'Proxy-Connection': 'keep-alive', 'content-length': '5', 'if-none-match': 'etag', accept: 'y', host: 'new'
    })
    assert.deepEqual(I.createForwardHeaders(null), {})
  })

  test('current behavior: an override with an undefined value is kept as a key', () => {
    assert.equal('host' in I.createForwardHeaders(source, [], { host: undefined }), true)
  })

  test('stripIdentifyingHeaders removes baggage, sentry-trace and sentry-* in any case', () => {
    const headers = { 'Sentry-Trace': 'x', baggage: 'y', 'sentry-public-key': 'z', 'X-Sentry': 'keep', traceparent: 'tp', accept: 'a', u: undefined }
    assert.deepEqual(I.stripIdentifyingHeaders(headers), { 'X-Sentry': 'keep', traceparent: 'tp', accept: 'a' })
    assert.deepEqual(I.stripIdentifyingHeaders(null), {})
  })

  test('sanitizeHeaders omits the listed names and caches the result per headers object until its keys change', () => {
    const headers = { 'Sentry-Trace': 'x', accept: 'a', u: undefined }
    const first = I.sanitizeHeaders(headers, ['ACCEPT'])
    assert.deepEqual(first, { 'Sentry-Trace': 'x' })
    assert.equal(I.sanitizeHeaders(headers, ['accept']), first, 'same omit list returns the cached object')
    headers.late = 'late'
    const afterAdd = I.sanitizeHeaders(headers, ['accept'])
    assert.deepEqual(afterAdd, { 'Sentry-Trace': 'x', late: 'late' })
    assert.notEqual(afterAdd, first, 'a key added to the headers object invalidates the cache')
    assert.deepEqual(I.sanitizeHeaders({ a: '1', b: undefined }), { a: '1' })
    assert.deepEqual(I.sanitizeHeaders(null), {})
  })

  test('sanitizeAndStripIdentifyingHeaders combines both passes', () => {
    assert.deepEqual(
      I.sanitizeAndStripIdentifyingHeaders({ 'Transfer-Encoding': 'chunked', Connection: 'close', 'sentry-trace': 'x', baggage: 'b', 'content-type': 'ct', n: undefined }, ['transfer-encoding', 'connection']),
      { 'content-type': 'ct' }
    )
    assert.deepEqual(I.sanitizeAndStripIdentifyingHeaders({ 'transfer-encoding': 'chunked', 'sentry-trace': 'x', ok: '1' }), { 'transfer-encoding': 'chunked', ok: '1' })
  })
})
