'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { loadServer, getFreePort } = require('../helpers/load-server')

let proxy
let proxyPort
let upstream
let upstreamPort
let upstreamBase

function request (options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, ...options }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function api (method, path, payload, headers = {}) {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const response = await request({
    method,
    path,
    headers: {
      host: `127.0.0.1:${proxyPort}`,
      ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      ...headers
    }
  }, body)
  let json = null
  try { json = JSON.parse(response.body) } catch {}
  return { ...response, json }
}

function viaProxy (method, url) {
  return request({ method, path: url, headers: { host: new URL(url).host } })
}

before(async () => {
  const loaded = await loadServer()
  proxy = loaded.proxy
  proxyPort = loaded.port
  await proxy.start()

  upstreamPort = await getFreePort()
  upstreamBase = `http://127.0.0.1:${upstreamPort}`
  upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/text')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello world, world!')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url }))
  })
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve))
})

after(async () => {
  await new Promise(resolve => upstream.close(resolve))
  await proxy.stop()
})

test('GET /api/config exposes the global flags', async () => {
  const { status, json } = await api('GET', '/api/config')
  assert.equal(status, 200)
  assert.deepEqual(json, {
    interactiveModeEnabled: true,
    editRulesEnabled: true,
    localResourcesEnabled: true,
    filterRulesEnabled: true,
    blockedRulesEnabled: true,
    filteredRequestCount: 0,
    filterMode: 'ignore'
  })
})

test('boolean toggles validate the payload and are reflected by /api/config', async () => {
  const off = await api('POST', '/api/edit-rules-mode', { enabled: false })
  assert.equal(off.status, 200)
  assert.deepEqual(off.json, { success: true, editRulesEnabled: false })
  assert.equal((await api('GET', '/api/config')).json.editRulesEnabled, false)

  const invalid = await api('POST', '/api/edit-rules-mode', { enabled: 'no' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.error, 'Invalid "enabled" flag: expected a boolean.')

  // current behavior: a payload without "enabled" resets the flag to true.
  const empty = await api('POST', '/api/edit-rules-mode', {})
  assert.deepEqual(empty.json, { success: true, editRulesEnabled: true })

  for (const path of ['/api/local-resources-mode', '/api/filter-rules-mode', '/api/blocked-rules-mode']) {
    const res = await api('POST', path, { enabled: true })
    assert.equal(res.status, 200, path)
    assert.equal(res.json.success, true, path)
  }
})

test('filter mode switches between ignore and focus', async () => {
  const focus = await api('POST', '/api/filter-mode', { mode: 'focus' })
  assert.deepEqual(focus.json, { success: true, filterMode: 'focus' })
  assert.equal((await api('GET', '/api/filter-mode')).json.filterMode, 'focus')

  const invalid = await api('POST', '/api/filter-mode', { mode: 'other' })
  assert.equal(invalid.status, 400)

  const ignore = await api('POST', '/api/filter-mode', { mode: 'ignore' })
  assert.deepEqual(ignore.json, { success: true, filterMode: 'ignore' })
})

test('GET /api/logs paginates the captured traffic; /api/logs/:id gives the full view', async () => {
  await api('DELETE', '/api/logs')
  for (const name of ['one', 'two', 'three']) {
    const res = await viaProxy('GET', `${upstreamBase}/${name}`)
    assert.equal(res.status, 200)
  }

  const page = await api('GET', '/api/logs?view=summary')
  assert.equal(page.status, 200)
  assert.equal(page.json.total, 3)
  assert.equal(page.json.hasMore, false)
  assert.equal(page.json.offset, 0)
  assert.equal(page.json.limit, 50)
  // current behavior: items are returned oldest first.
  assert.deepEqual(
    page.json.items.map(item => item.fullUrl),
    [`${upstreamBase}/one`, `${upstreamBase}/two`, `${upstreamBase}/three`]
  )
  for (const item of page.json.items) {
    assert.equal(item.source, 'proxied')
    assert.equal(item.statusCode, 200)
    assert.equal(item.method, 'GET')
    assert.equal(item.fileType, 'json')
    assert.equal('responseBody' in item, false, 'summary view carries no bodies')
    assert.equal('body' in item, false)
  }

  const firstPage = await api('GET', '/api/logs?view=summary&limit=2')
  assert.equal(firstPage.json.items.length, 2)
  assert.equal(firstPage.json.hasMore, true)

  const lastPage = await api('GET', '/api/logs?view=summary&limit=2&offset=2')
  assert.equal(lastPage.json.items.length, 1)
  assert.equal(lastPage.json.hasMore, false)
  assert.equal(lastPage.json.items[0].fullUrl, `${upstreamBase}/three`)

  const id = page.json.items[0].id
  const full = await api('GET', `/api/logs/${encodeURIComponent(String(id))}`)
  assert.equal(full.status, 200)
  assert.equal(full.json.id, id)
  assert.equal(full.json.source, 'proxied')
  assert.equal(full.json.targetUrl, `${upstreamBase}/one`)
  assert.ok('responseBody' in full.json, 'full view carries the response body')
  assert.ok(full.json.responseHeaders)
  assert.match(full.json.responseHeaders['content-type'], /application\/json/)
  assert.equal(typeof full.json.upstreamDurationMs, 'number')

  const missing = await api('GET', '/api/logs/does-not-exist')
  assert.equal(missing.status, 404)
})

test('search and source filters of /api/logs', async () => {
  const match = await api('GET', '/api/logs?search=two')
  assert.equal(match.json.total, 1)
  assert.equal(match.json.items[0].fullUrl, `${upstreamBase}/two`)

  const negated = await api('GET', `/api/logs?search=${encodeURIComponent('!two')}`)
  assert.equal(negated.json.total, 2)

  const noSource = await api('GET', '/api/logs?sources=mitm')
  assert.equal(noSource.json.total, 0)
})

test('GET /api/dashboard aggregates counters and DELETE /api/logs resets them', async () => {
  const dashboard = await api('GET', '/api/dashboard')
  assert.equal(dashboard.status, 200)
  assert.equal(dashboard.json.stats.total, 3)
  assert.equal(dashboard.json.stats.proxied, 3)
  assert.equal(dashboard.json.stats.blocked, 0)
  assert.equal(dashboard.json.stats.errors, 0)
  assert.equal(dashboard.json.editedRequests, 0)
  assert.ok(Array.isArray(dashboard.json.resources))
  assert.ok(Array.isArray(dashboard.json.blocked))
  assert.equal(typeof dashboard.json.performance.upstreamMs.avg, 'number')
  assert.ok(Array.isArray(dashboard.json.routes.slowest))

  const cleared = await api('DELETE', '/api/logs')
  assert.equal(cleared.status, 200)
  assert.deepEqual(cleared.json, { success: true, message: 'Logs cleared' })
  assert.equal((await api('GET', '/api/logs')).json.total, 0)
  assert.equal((await api('GET', '/api/dashboard')).json.stats.total, 0)
})

test('edit rules: create, rewrite a proxied response body, disable, delete', async () => {
  assert.deepEqual((await api('GET', '/api/edit-rules')).json, { rules: [] })

  const created = await api('POST', '/api/edit-rules', {
    kind: 'text',
    name: 'world to proxy',
    startVariants: ['world'],
    replacement: 'proxy',
    target: 'response'
  })
  assert.equal(created.status, 201)
  const rule = created.json.rule
  assert.equal(typeof rule.id, 'string')
  assert.equal(rule.enabled, true)
  assert.equal(rule.kind, 'text')
  assert.deepEqual(rule.startVariants, ['world'])
  assert.deepEqual(rule.endVariants, [])
  assert.equal(rule.replacement, 'proxy')
  assert.equal(rule.target, 'response')
  assert.equal(rule.useRegex, false)
  assert.equal(rule.caseSensitive, false)

  await api('DELETE', '/api/logs')
  const rewritten = await viaProxy('GET', `${upstreamBase}/text`)
  assert.equal(rewritten.status, 200)
  assert.equal(rewritten.body, 'hello proxy, proxy!')

  const logs = await api('GET', '/api/logs')
  assert.equal(logs.json.total, 1)
  const entry = logs.json.items[0]
  assert.ok(Array.isArray(entry.rewrites))
  assert.equal(entry.rewrites[0].id, rule.id)
  assert.equal((await api('GET', '/api/dashboard')).json.editedRequests, 1)
  assert.equal((await api('GET', '/api/edit-rules/usage')).json.usage[rule.id], 1)

  const disabled = await api('PUT', `/api/edit-rules/${rule.id}`, { enabled: false })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.json.rule.enabled, false)
  assert.equal(disabled.json.rule.id, rule.id)
  const untouched = await viaProxy('GET', `${upstreamBase}/text`)
  assert.equal(untouched.body, 'hello world, world!')

  const reEnabled = await api('PUT', `/api/edit-rules/${rule.id}`, { enabled: true, caseSensitive: true })
  assert.equal(reEnabled.json.rule.caseSensitive, true)
  assert.equal((await viaProxy('GET', `${upstreamBase}/text`)).body, 'hello proxy, proxy!')

  const invalid = await api('PUT', '/api/edit-rules/unknown-id', { enabled: true })
  assert.equal(invalid.status, 404)

  const deleted = await api('DELETE', `/api/edit-rules/${rule.id}`)
  assert.equal(deleted.status, 204)
  assert.equal((await api('DELETE', `/api/edit-rules/${rule.id}`)).status, 404)
  assert.deepEqual((await api('GET', '/api/edit-rules')).json, { rules: [] })
  assert.equal((await viaProxy('GET', `${upstreamBase}/text`)).body, 'hello world, world!')
})

test('a text rule without markers is stored but never applied', async () => {
  const created = await api('POST', '/api/edit-rules', { kind: 'text', replacement: 'x' })
  assert.equal(created.status, 201)
  assert.equal((await viaProxy('GET', `${upstreamBase}/text`)).body, 'hello world, world!')
  await api('DELETE', `/api/edit-rules/${created.json.rule.id}`)
})

test('mutations reject cross-site browser requests and accept everything else', async () => {
  const evil = await api('POST', '/api/interactive-mode', { enabled: true }, { origin: 'http://evil.example' })
  assert.equal(evil.status, 403)
  assert.deepEqual(evil.json, { error: 'Cross-site requests to the proxy API are not allowed' })

  const ui = await api('POST', '/api/interactive-mode', { enabled: true }, { origin: `http://localhost:${proxyPort}` })
  assert.equal(ui.status, 200)

  const devUi = await api('POST', '/api/interactive-mode', { enabled: true }, { origin: 'http://localhost:3050' })
  assert.equal(devUi.status, 200)

  const crossSite = await request({
    method: 'POST',
    path: '/api/interactive-mode',
    headers: {
      host: `127.0.0.1:${proxyPort}`,
      'sec-fetch-site': 'cross-site',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': 13
    }
  }, 'enabled=false')
  assert.equal(crossSite.status, 403)

  const sameSite = await api('POST', '/api/interactive-mode', { enabled: true }, { 'sec-fetch-site': 'same-site' })
  assert.equal(sameSite.status, 200)

  const bare = await api('POST', '/api/interactive-mode', { enabled: true })
  assert.equal(bare.status, 200)

  const readWithEvilOrigin = await api('GET', '/api/config', undefined, { origin: 'http://evil.example' })
  assert.equal(readWithEvilOrigin.status, 200, 'GET is not blocked, only left without CORS headers')
})

test('CORS headers are emitted only for the UI origins', async () => {
  const allowed = await api('GET', '/api/config', undefined, { origin: 'http://localhost:3050' })
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:3050')

  const denied = await api('GET', '/api/config', undefined, { origin: 'http://evil.example' })
  assert.equal(denied.headers['access-control-allow-origin'], undefined)

  const preflight = await request({
    method: 'OPTIONS',
    path: '/api/edit-rules',
    headers: {
      host: `127.0.0.1:${proxyPort}`,
      origin: 'http://localhost:3050',
      'access-control-request-method': 'POST'
    }
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:3050')
  assert.match(preflight.headers['access-control-allow-methods'], /POST/)

  const deniedPreflight = await request({
    method: 'OPTIONS',
    path: '/api/edit-rules',
    headers: {
      host: `127.0.0.1:${proxyPort}`,
      origin: 'http://evil.example',
      'access-control-request-method': 'POST'
    }
  })
  assert.equal(deniedPreflight.headers['access-control-allow-origin'], undefined)
})
