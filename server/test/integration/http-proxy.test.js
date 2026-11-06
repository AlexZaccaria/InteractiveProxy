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

/**
 * Plain HTTP request returning the whole response.
 *
 * @param {import('http').RequestOptions} options
 * @param {string|Buffer} [body]
 * @returns {Promise<{ status: number, headers: import('http').IncomingHttpHeaders, body: string }>}
 */
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

/** Management API call (JSON in, JSON out) against the proxy's own origin. */
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

/** Proxy-style request: absolute URL in the request line, like `curl -x`. */
function viaProxy (method, url, { headers = {}, body } = {}) {
  const target = new URL(url)
  return request({
    method,
    path: url,
    headers: {
      host: target.host,
      ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
      ...headers
    }
  }, body)
}

/** Request to the proxy's own origin carrying an X-Target-URL header. */
function viaTargetHeader (method, path, targetUrl, { headers = {}, body } = {}) {
  return request({
    method,
    path,
    headers: {
      host: `127.0.0.1:${proxyPort}`,
      'x-target-url': targetUrl,
      ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
      ...headers
    }
  }, body)
}

async function listLogs (query = '') {
  const { json } = await api('GET', `/api/logs?limit=200${query}`)
  return json.items
}

before(async () => {
  const loaded = await loadServer()
  proxy = loaded.proxy
  proxyPort = loaded.port
  await proxy.start()

  upstreamPort = await getFreePort()
  upstreamBase = `http://127.0.0.1:${upstreamPort}`
  upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const payload = JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(payload)
    })
  })
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve))
})

after(async () => {
  await new Promise(resolve => upstream.close(resolve))
  await proxy.stop()
})

test('proxy-style GET (absolute URL in the request line) reaches the upstream', async () => {
  const res = await viaProxy('GET', `${upstreamBase}/hello?x=1`)
  assert.equal(res.status, 200)
  const echo = JSON.parse(res.body)
  assert.equal(echo.method, 'GET')
  assert.equal(echo.url, '/hello?x=1')
  assert.equal(echo.headers.host, `127.0.0.1:${upstreamPort}`)
  assert.equal(echo.headers['x-target-url'], undefined)
})

test('X-Target-URL header routes a request to the upstream and is not forwarded', async () => {
  const res = await viaTargetHeader('GET', '/anything', `${upstreamBase}/from-header?q=2`)
  assert.equal(res.status, 200)
  const echo = JSON.parse(res.body)
  assert.equal(echo.url, '/from-header?q=2')
  assert.equal(echo.headers.host, `127.0.0.1:${upstreamPort}`)
  assert.equal(echo.headers['x-target-url'], undefined)
})

test('POST with a JSON body is forwarded byte for byte', async () => {
  const body = '{"a":1,"nested":{"b":[1,2,"three"]},"text":"héllo"}'
  const res = await viaProxy('POST', `${upstreamBase}/post`, {
    headers: { 'content-type': 'application/json' },
    body
  })
  assert.equal(res.status, 200)
  const echo = JSON.parse(res.body)
  assert.equal(echo.method, 'POST')
  assert.equal(echo.body, body)
  assert.match(echo.headers['content-type'], /application\/json/)
  assert.equal(echo.headers['content-length'], String(Buffer.byteLength(body)))
})

test('POST with a text/plain body', async () => {
  const res = await viaProxy('POST', `${upstreamBase}/text`, {
    headers: { 'content-type': 'text/plain' },
    body: 'plain text payload'
  })
  assert.equal(res.status, 200)
  const echo = JSON.parse(res.body)
  assert.equal(echo.method, 'POST')
  // current behavior: no body parser handles text/plain, so req.rawBody and
  // req.body are both unset and the body is dropped before forwarding.
  assert.equal(echo.body, '')
})

test('HEAD is forwarded and answered without a body', async () => {
  const res = await viaTargetHeader('HEAD', '/head', `${upstreamBase}/head`)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  assert.equal(res.body, '')
})

test('404 when there is neither a target nor a local resource', async () => {
  const res = await request({ method: 'GET', path: '/nothing-here', headers: { host: `127.0.0.1:${proxyPort}` } })
  assert.equal(res.status, 404)
  const json = JSON.parse(res.body)
  assert.equal(json.error, 'No local resource found and no target URL specified')
})

test('proxied requests whose path starts with /api reach the upstream (absolute URL)', async () => {
  const res = await viaProxy('GET', `${upstreamBase}/api/config`)
  assert.equal(res.status, 200)
  const echo = JSON.parse(res.body)
  assert.equal(echo.url, '/api/config')
  assert.equal(echo.headers.host, `127.0.0.1:${upstreamPort}`)
})

test('proxied requests whose path starts with /api reach the upstream (X-Target-URL)', async () => {
  const res = await viaTargetHeader('GET', '/api/logs', `${upstreamBase}/api/logs`)
  assert.equal(res.status, 200)
  const echo = JSON.parse(res.body)
  assert.equal(echo.url, '/api/logs')
  assert.equal(Array.isArray(echo.items), false)
})

test('proxied requests whose path starts with /api reach the upstream (foreign Host header)', async () => {
  const res = await request({
    method: 'GET',
    path: '/api/config',
    headers: { host: `127.0.0.1:${upstreamPort}` }
  })
  assert.equal(res.status, 200)
  const echo = JSON.parse(res.body)
  assert.equal(echo.url, '/api/config')
  assert.equal(echo.headers.host, `127.0.0.1:${upstreamPort}`)
})

test('proxied POST to an /api path forwards the JSON body', async () => {
  const body = '{"k":"v"}'
  const res = await viaProxy('POST', `${upstreamBase}/api/anything`, {
    headers: { 'content-type': 'application/json' },
    body
  })
  assert.equal(res.status, 200)
  const echo = JSON.parse(res.body)
  assert.equal(echo.method, 'POST')
  assert.equal(echo.url, '/api/anything')
  assert.equal(echo.body, body)
})

test('the management API still answers on the proxy origin', async () => {
  const { status, json } = await api('GET', '/api/config')
  assert.equal(status, 200)
  assert.equal(typeof json.interactiveModeEnabled, 'boolean')
})

test('interactive mode OFF keeps proxying (and stops logging), ON logs again', async () => {
  await api('DELETE', '/api/logs')

  const off = await api('POST', '/api/interactive-mode', { enabled: false })
  assert.equal(off.status, 200)
  assert.deepEqual(off.json, { success: true, interactiveModeEnabled: false })

  const getOff = await viaProxy('GET', `${upstreamBase}/while-off`)
  assert.equal(getOff.status, 200)
  assert.equal(JSON.parse(getOff.body).url, '/while-off')

  const postOff = await viaProxy('POST', `${upstreamBase}/while-off-post`, {
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}'
  })
  assert.equal(postOff.status, 200)
  assert.equal(JSON.parse(postOff.body).body, '{"a":1}')

  assert.equal((await listLogs()).length, 0)

  const on = await api('POST', '/api/interactive-mode', { enabled: true })
  assert.deepEqual(on.json, { success: true, interactiveModeEnabled: true })

  const getOn = await viaProxy('GET', `${upstreamBase}/while-on`)
  assert.equal(getOn.status, 200)

  const logs = await listLogs()
  assert.equal(logs.length, 1)
  assert.equal(logs[0].fullUrl, `${upstreamBase}/while-on`)
  assert.equal(logs[0].source, 'proxied')
  assert.equal(logs[0].statusCode, 200)
})

test('a local resource is served instead of the upstream', async () => {
  const content = '{"users":[{"id":1}]}'
  const created = await api('POST', '/api/resources', {
    url: '/mock/users',
    contentType: 'application/json',
    content
  })
  assert.equal(created.status, 200)
  assert.equal(created.json.success, true)
  assert.equal(created.json.resource.url, '/mock/users')
  assert.equal(created.json.resource.type, 'text')
  assert.equal(created.json.resource.enabled, true)

  const listed = await api('GET', '/api/resources')
  assert.equal(listed.status, 200)

  await api('DELETE', '/api/logs')

  const res = await viaProxy('GET', `${upstreamBase}/mock/users?page=1`)
  assert.equal(res.status, 200)
  assert.equal(res.body, content)
  assert.equal(res.headers['content-type'], 'application/json')
  assert.equal(res.headers['x-proxy-source'], 'local')

  const logs = await listLogs()
  assert.equal(logs.length, 1)
  assert.equal(logs[0].source, 'local')
  assert.equal(logs[0].localResource, '/mock/users')

  const removed = await api('DELETE', `/api/resources/${encodeURIComponent('/mock/users')}`)
  assert.equal(removed.status, 200)

  const afterRemoval = await viaProxy('GET', `${upstreamBase}/mock/users`)
  assert.equal(afterRemoval.status, 200)
  assert.equal(JSON.parse(afterRemoval.body).url, '/mock/users')
})

test('a blocked rule answers 204 and the entry shows up as blocked once the rule is gone', async () => {
  await api('DELETE', '/api/logs')

  const added = await api('POST', '/api/blocked', { action: 'add', url: '/blocked-path', name: 'test block' })
  assert.equal(added.status, 200)
  assert.equal(added.json.success, true)
  const rule = added.json.blockedRules.find(entry => entry.url === '/blocked-path')
  assert.ok(rule)
  assert.equal(rule.enabled, true)
  assert.equal(rule.name, 'test block')

  // current behavior: POST /api/blocked answers before the rule is active.
  // saveBlockedUrls() is not awaited and only rebuilds the active list after
  // its file write completes, so the first request right after the POST can
  // still go through; retry briefly until the rule applies.
  let blocked = null
  for (let attempt = 0; attempt < 40; attempt++) {
    blocked = await viaProxy('GET', `${upstreamBase}/blocked-path/resource.js`)
    if (blocked.status === 204) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(blocked.status, 204)
  assert.equal(blocked.body, '')

  const unrelated = await viaProxy('GET', `${upstreamBase}/still-open`)
  assert.equal(unrelated.status, 200)

  // current behavior: /api/logs hides every entry whose URL matches a blocked
  // rule (enabled or not) while the rule exists.
  const hidden = await listLogs()
  assert.equal(hidden.some(entry => entry.source === 'blocked'), false)
  assert.equal(hidden.some(entry => entry.fullUrl === `${upstreamBase}/still-open`), true)

  const dashboard = await api('GET', '/api/dashboard')
  assert.equal(dashboard.json.stats.blocked, 1)

  const removed = await api('POST', '/api/blocked', { action: 'remove', id: rule.id })
  assert.equal(removed.status, 200)
  assert.equal(removed.json.blockedRules.some(entry => entry.id === rule.id), false)

  // current behavior: the same unawaited save delays the visibility update
  // of the log entries, so poll until the entry shows up.
  let entries = []
  for (let attempt = 0; attempt < 40 && entries.length === 0; attempt++) {
    entries = (await listLogs()).filter(item => item.source === 'blocked')
    if (entries.length === 0) await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(entries.length >= 1, 'blocked entry becomes visible after the rule is removed')
  const entry = entries[0]
  assert.equal(entry.statusCode, 204)
  assert.equal(entry.method, 'GET')
  assert.equal(entry.url, `${upstreamBase}/blocked-path/resource.js`)
  // current behavior: the blocked log builds fullUrl as `<scheme>://<Host
  // header><request line>`; with a proxy-style absolute request line the
  // origin is doubled.
  assert.equal(entry.fullUrl, `${upstreamBase}${upstreamBase}/blocked-path/resource.js`)

  const afterRemoval = await viaProxy('GET', `${upstreamBase}/blocked-path/resource.js`)
  assert.equal(afterRemoval.status, 200)
})

test('POST /api/blocked validates its payload', async () => {
  const noAction = await api('POST', '/api/blocked', { url: '/x' })
  assert.equal(noAction.status, 400)

  const noUrl = await api('POST', '/api/blocked', { action: 'add' })
  assert.equal(noUrl.status, 400)

  const badEnabled = await api('POST', '/api/blocked', { action: 'add', url: '/x', enabled: 'yes' })
  assert.equal(badEnabled.status, 400)

  const unknownId = await api('POST', '/api/blocked', { action: 'update', id: 'missing', url: '/y' })
  assert.equal(unknownId.status, 404)
})
