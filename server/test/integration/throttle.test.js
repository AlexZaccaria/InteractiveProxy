'use strict'

/**
 * Integration tests of the network-condition rules: the latency a rule adds
 * and the bandwidth cap, measured against a local upstream.
 */

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { loadServer, getFreePort } = require('../helpers/load-server')

let proxy
let proxyPort
let upstream
let upstreamPort
let upstreamBase

const BIG = Buffer.alloc(6000, 0x61)

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, ...options }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
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
    json = JSON.parse(response.body.toString('utf8'))
  } catch {}
  return { ...response, json }
}

function viaProxy(url) {
  return request({ method: 'GET', path: url, headers: { host: new URL(url).host } })
}

async function timed(url) {
  const started = Date.now()
  const response = await viaProxy(url)
  return { ...response, elapsed: Date.now() - started }
}

before(async () => {
  const loaded = await loadServer()
  proxy = loaded.proxy
  proxyPort = loaded.port
  await proxy.start()

  upstreamPort = await getFreePort()
  upstreamBase = `http://127.0.0.1:${upstreamPort}`
  upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/big')) {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': BIG.length })
      res.end(BIG)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve))
})

after(async () => {
  await new Promise(resolve => upstream.close(resolve))
  await proxy.stop()
})

test('rules are validated, listed and applied: latency, then bandwidth cap', async () => {
  assert.equal((await api('POST', '/api/throttle', { action: 'add', url: '/x' })).status, 400)
  assert.equal(
    (await api('POST', '/api/throttle', { action: 'add', url: '/x', delayMs: -1 })).status,
    400
  )

  const added = await api('POST', '/api/throttle', {
    action: 'add',
    url: '/slow',
    name: 'Slow',
    delayMs: 300
  })
  assert.equal(added.status, 200, added.body.toString())
  const [rule] = added.json.throttleRules
  assert.equal(rule.delayMs, 300)
  assert.equal(rule.throttleKbps, 0)
  assert.deepEqual((await api('GET', '/api/throttle')).json, [rule])

  const fast = await timed(`${upstreamBase}/fast`)
  assert.equal(fast.status, 200)
  assert.ok(fast.elapsed < 250, `unmatched request took ${fast.elapsed} ms`)

  const slow = await timed(`${upstreamBase}/slow`)
  assert.equal(slow.status, 200)
  assert.ok(slow.elapsed >= 300, `delayed request took ${slow.elapsed} ms`)

  const listed = await api('GET', '/api/logs?view=summary&limit=200')
  const logged = listed.json.items.find(item => item.fullUrl === `${upstreamBase}/slow`)
  assert.deepEqual(logged.network, {
    ruleId: rule.id,
    ruleName: 'Slow',
    delayMs: 300,
    throttleKbps: 0
  })

  // A 6000-byte body at 64 kbps (8000 B/s) takes about three quarters of a second.
  const capped = await api('POST', '/api/throttle', {
    action: 'update',
    id: rule.id,
    url: '/big',
    delayMs: 0,
    throttleKbps: 64
  })
  assert.equal(capped.status, 200, capped.body.toString())
  const big = await timed(`${upstreamBase}/big`)
  assert.equal(big.status, 200)
  assert.equal(big.body.equals(BIG), true)
  assert.equal(big.headers['content-length'], String(BIG.length))
  assert.ok(big.elapsed >= 600, `capped response took ${big.elapsed} ms`)

  // The flag turns every rule off at once.
  const off = await api('POST', '/api/throttling-mode', { enabled: false })
  assert.deepEqual(off.json, { success: true, throttlingEnabled: false })
  const unthrottled = await timed(`${upstreamBase}/big`)
  assert.ok(unthrottled.elapsed < 300, `unthrottled response took ${unthrottled.elapsed} ms`)
  await api('POST', '/api/throttling-mode', { enabled: true })

  const removed = await api('POST', '/api/throttle', { action: 'remove', id: rule.id })
  assert.deepEqual(removed.json.throttleRules, [])
})
