'use strict'

/**
 * Hop-by-hop request headers (Keep-Alive, Upgrade, HTTP2-Settings) sent by a
 * client must not reach the upstream: undici refuses to send them, so before
 * they were stripped a plain `Keep-Alive: timeout=5` made the proxy answer
 * 502 (B30).
 */

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { loadServer, getFreePort } = require('../helpers/load-server')

let proxy
let proxyPort
let upstream
let upstreamPort

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString()
        })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

before(async () => {
  const loaded = await loadServer()
  proxy = loaded.proxy
  proxyPort = loaded.port
  await proxy.start()

  upstreamPort = await getFreePort()
  upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    // Echo the request headers so the test can see what reached the upstream.
    res.end(JSON.stringify({ url: req.url, headers: req.headers }))
  })
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve))
})

after(async () => {
  await new Promise(resolve => upstream.close(resolve))
  await proxy.stop()
})

test('Keep-Alive, Upgrade and HTTP2-Settings request headers are dropped before forwarding', async () => {
  const response = await request({
    host: '127.0.0.1',
    port: proxyPort,
    method: 'GET',
    path: `http://127.0.0.1:${upstreamPort}/hop`,
    headers: {
      host: `127.0.0.1:${upstreamPort}`,
      connection: 'keep-alive',
      'keep-alive': 'timeout=5, max=100',
      upgrade: 'h2c',
      'http2-settings': 'AAMAAABkAAQCAAAAAAIAAAAA',
      'x-custom': 'kept'
    }
  })

  assert.equal(response.status, 200)
  const echoed = JSON.parse(response.body)
  assert.equal(echoed.url, '/hop')
  assert.equal(echoed.headers['keep-alive'], undefined)
  assert.equal(echoed.headers.upgrade, undefined)
  assert.equal(echoed.headers['http2-settings'], undefined)
  assert.equal(echoed.headers['x-custom'], 'kept')
})

test('the same headers are dropped on the X-Target-URL path', async () => {
  const response = await request({
    host: '127.0.0.1',
    port: proxyPort,
    method: 'GET',
    path: '/hop-target',
    headers: {
      'x-target-url': `http://127.0.0.1:${upstreamPort}/hop-target`,
      'keep-alive': 'timeout=5',
      'x-custom': 'kept'
    }
  })

  assert.equal(response.status, 200)
  const echoed = JSON.parse(response.body)
  assert.equal(echoed.url, '/hop-target')
  assert.equal(echoed.headers['keep-alive'], undefined)
  assert.equal(echoed.headers['x-custom'], 'kept')
})
