'use strict'

/**
 * Integration tests of the breakpoints: the proxy is started on a free port
 * with a local echo upstream, an event stream is kept open (flows are held
 * only while one is), and the paused flows are driven through the API.
 */

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { loadServer, getFreePort } = require('../helpers/load-server')

// A pause nobody resumes must not hold a test for the default two minutes.
process.env.PROXY_BREAKPOINT_TIMEOUT_MS = '2000'

let proxy
let proxyPort
let upstream
let upstreamPort
let upstreamBase
/** @type {Array<{ method: string, url: string, headers: Record<string, any>, body: string }>} */
const received = []

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, ...options }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        })
      )
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function api(method, path, payload) {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const response = await request(
    {
      method,
      path,
      headers: {
        host: `127.0.0.1:${proxyPort}`,
        ...(body
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          : {})
      }
    },
    body
  )
  let json = null
  try {
    json = JSON.parse(response.body)
  } catch {}
  return { ...response, json }
}

function viaProxy(method, url, headers = {}, body) {
  return request(
    {
      method,
      path: url,
      headers: {
        host: new URL(url).host,
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
        ...headers
      }
    },
    body
  )
}

/**
 * An open event stream: `events` collects the parsed events, `close()`
 * ends it. Resolves once the `hello` event arrived.
 */
function openEvents() {
  return new Promise((resolve, reject) => {
    /** @type {Array<{ name: string, data: any }>} */
    const events = []
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, path: '/api/events', method: 'GET' },
      res => {
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          buffer += chunk
          let index
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            let name = 'message'
            let data = null
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) name = line.slice(7)
              else if (line.startsWith('data: ')) data = JSON.parse(line.slice(6))
            }
            if (block.startsWith(':')) continue
            events.push({ name, data })
            if (name === 'hello') resolve({ events, close: () => req.destroy() })
          }
        })
      }
    )
    req.on('error', error => {
      if (error.code !== 'ECONNRESET') reject(error)
    })
    req.end()
  })
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Condition not met in time')
}

async function pendingItems() {
  const { json } = await api('GET', '/api/breakpoints/pending')
  return json.items
}

async function findLogByUrl(url) {
  const { json } = await api('GET', '/api/logs?view=summary&limit=200')
  return json.items.find(item => item.fullUrl === url || item.targetUrl === url)
}

/** @type {{ events: Array<{ name: string, data: any }>, close: () => void }} */
let stream

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
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      })
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' })
      res.end(JSON.stringify({ ok: true, path: req.url, method: req.method }))
    })
  })
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve))

  stream = await openEvents()
})

after(async () => {
  if (stream) stream.close()
  await new Promise(resolve => upstream.close(resolve))
  await proxy.stop()
})

test('breakpoint rules are added, listed, updated and removed', async () => {
  const added = await api('POST', '/api/breakpoints', {
    action: 'add',
    url: '/items',
    name: 'Items',
    phase: 'request'
  })
  assert.equal(added.status, 200, added.body)
  assert.equal(added.json.success, true)
  assert.equal(added.json.breakpointRules.length, 1)
  const [rule] = added.json.breakpointRules
  assert.equal(rule.url, '/items')
  assert.equal(rule.phase, 'request')
  assert.equal(rule.enabled, true)

  const listed = await api('GET', '/api/breakpoints')
  assert.deepEqual(listed.json, [rule])

  const updated = await api('POST', '/api/breakpoints', {
    action: 'update',
    id: rule.id,
    phase: 'both',
    enabled: false
  })
  assert.equal(updated.json.breakpointRules[0].phase, 'both')
  assert.equal(updated.json.breakpointRules[0].enabled, false)

  assert.equal((await api('POST', '/api/breakpoints', { action: 'add' })).status, 400)
  assert.equal(
    (await api('POST', '/api/breakpoints', { action: 'add', url: '/x', phase: 'later' })).status,
    400
  )
  assert.equal(
    (await api('POST', '/api/breakpoints', { action: 'update', id: 'missing', url: '/y' })).status,
    404
  )

  const removed = await api('POST', '/api/breakpoints', { action: 'remove', id: rule.id })
  assert.deepEqual(removed.json.breakpointRules, [])

  // The saves were announced on the stream.
  await waitFor(
    () =>
      stream.events.filter(event => event.name === 'rules' && event.data.kind === 'breakpoints')
        .length >= 3
  )
})

test('a request breakpoint holds the request until it is sent on with edits', async () => {
  await api('POST', '/api/breakpoints', { action: 'add', url: '/items', phase: 'request' })
  const url = `${upstreamBase}/items`

  const client = viaProxy('POST', url, { 'content-type': 'application/json' }, '{"a":1}')
  const [item] = await waitFor(async () => {
    const items = await pendingItems()
    return items.length === 1 ? items : null
  })
  assert.equal(item.phase, 'request')
  assert.equal(item.method, 'POST')
  assert.equal(item.url, url)
  assert.equal(item.headers['content-type'], 'application/json')
  assert.equal(item.body, '{"a":1}')
  assert.equal(item.response, null)
  assert.equal(received.length, 0, 'nothing reached the upstream while paused')

  const paused = await waitFor(() =>
    stream.events.find(event => event.name === 'breakpoint' && event.data.action === 'paused')
  )
  assert.equal(paused.data.item.id, item.id)

  const resumed = await api('POST', `/api/breakpoints/pending/${item.id}/resume`, {
    url: `${upstreamBase}/items?edited=1`,
    headers: { 'content-type': 'application/json', 'x-bp': '1' },
    body: '{"a":2}'
  })
  assert.equal(resumed.status, 200, resumed.body)

  const response = await client
  assert.equal(response.status, 200)
  assert.equal(received.length, 1)
  assert.equal(received[0].url, '/items?edited=1')
  assert.equal(received[0].body, '{"a":2}')
  assert.equal(received[0].headers['x-bp'], '1')
  assert.equal(received[0].headers['content-length'], '7')

  assert.deepEqual(await pendingItems(), [])
  const logged = await findLogByUrl(`${upstreamBase}/items?edited=1`)
  assert.ok(logged, 'the entry carries the edited URL')
  assert.deepEqual(logged.breakpoint, { request: 'edited' })

  await waitFor(() =>
    stream.events.find(
      event =>
        event.name === 'breakpoint' && event.data.action === 'resumed' && event.data.id === item.id
    )
  )
  assert.equal((await api('POST', `/api/breakpoints/pending/${item.id}/resume`, {})).status, 404)
})

test('a response breakpoint holds the response, which can be edited before it is sent', async () => {
  await api('POST', '/api/breakpoints', { action: 'add', url: '/resp', phase: 'response' })
  const url = `${upstreamBase}/resp`
  received.length = 0

  const client = viaProxy('GET', url)
  const [item] = await waitFor(async () => {
    const items = await pendingItems()
    return items.length === 1 ? items : null
  })
  assert.equal(item.phase, 'response')
  assert.equal(received.length, 1, 'the upstream answered before the pause')
  assert.equal(item.response.statusCode, 200)
  assert.equal(item.response.headers['x-upstream'], 'yes')
  assert.equal(item.response.body, JSON.stringify({ ok: true, path: '/resp', method: 'GET' }))

  const invalid = await api('POST', `/api/breakpoints/pending/${item.id}/resume`, {
    statusCode: 999
  })
  assert.equal(invalid.status, 400)

  const resumed = await api('POST', `/api/breakpoints/pending/${item.id}/resume`, {
    statusCode: 418,
    headers: { 'content-type': 'application/json', 'x-edited': 'yes' },
    body: '{"teapot":true}'
  })
  assert.equal(resumed.status, 200, resumed.body)

  const response = await client
  assert.equal(response.status, 418)
  assert.equal(response.body, '{"teapot":true}')
  assert.equal(response.headers['x-edited'], 'yes')
  assert.equal(response.headers['x-upstream'], undefined)
  assert.equal(response.headers['content-length'], '15')

  const logged = await findLogByUrl(url)
  assert.deepEqual(logged.breakpoint, { response: 'edited' })
  assert.equal(logged.statusCode, 418)
})

test('a paused flow can be aborted; the client gets a 502 and the entry is an error', async () => {
  const url = `${upstreamBase}/items/abort`
  received.length = 0
  const client = viaProxy('GET', url)
  const [item] = await waitFor(async () => {
    const items = await pendingItems()
    return items.length === 1 ? items : null
  })

  const aborted = await api('POST', `/api/breakpoints/pending/${item.id}/abort`)
  assert.equal(aborted.status, 200)
  const response = await client
  assert.equal(response.status, 502)
  assert.deepEqual(JSON.parse(response.body), { error: 'Aborted at a breakpoint' })
  assert.equal(received.length, 0)

  const logged = await waitFor(async () => {
    const { json } = await api('GET', '/api/logs?view=summary&limit=200&sources=error')
    return json.items.find(entry => entry.fullUrl === url)
  })
  assert.equal(logged.source, 'error')
  assert.deepEqual(logged.breakpoint, { request: 'aborted' })
  assert.equal((await api('POST', `/api/breakpoints/pending/${item.id}/abort`)).status, 404)
})

test('breakpoints are skipped when the flag is off or when no stream is open', async () => {
  const url = `${upstreamBase}/items/skip`
  received.length = 0

  const off = await api('POST', '/api/breakpoints-mode', { enabled: false })
  assert.deepEqual(off.json, { success: true, breakpointsEnabled: false })
  assert.equal((await api('GET', '/api/config')).json.breakpointsEnabled, false)
  assert.equal((await viaProxy('GET', url)).status, 200)
  assert.equal(received.length, 1)
  await api('POST', '/api/breakpoints-mode', { enabled: true })

  // Without an open stream nobody could resume a pause, so none happens.
  stream.close()
  await new Promise(resolve => setTimeout(resolve, 100))
  const started = Date.now()
  assert.equal((await viaProxy('GET', url)).status, 200)
  assert.ok(Date.now() - started < 1500, 'the request was not held')
  assert.equal(received.length, 2)
  assert.deepEqual(await pendingItems(), [])
})
