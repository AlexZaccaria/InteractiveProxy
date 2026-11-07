'use strict'

/**
 * HTTP/2 upstreams (PROXY_UPSTREAM_H2): with the flag on, the proxy speaks
 * h2 to TLS upstreams that negotiate it through ALPN, on the plain proxy path
 * (X-Target-URL, proxy-style URL) and through a MITM tunnel. The upstream
 * here refuses HTTP/1.1 (`allowHTTP1: false`), so a 200 proves the protocol.
 *
 * config.js reads the flag at its first load, so it is set before
 * loadServer() in this process.
 */
process.env.PROXY_UPSTREAM_H2 = 'true'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const http2 = require('http2')
const { loadServer, getFreePort } = require('../helpers/load-server')
const { createSelfSignedCert, openTunnel, secureTunnel } = require('../helpers/mitm')

let proxy
let proxyPort
/** @type {import('http2').Http2SecureServer} */
let upstream
let upstreamPort

/** Request against the proxy (proxy-style or X-Target-URL), JSON body parsed when possible. */
function request (options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, ...options }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** One HTTP/1.1 request written over an established TLS tunnel socket. */
function requestOverSocket (secureSocket, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, createConnection: () => secureSocket }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, headers: res.headers, body: text, json: JSON.parse(text) })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

before(async () => {
  const loaded = await loadServer()
  proxy = loaded.proxy
  proxyPort = loaded.port
  await proxy.start()

  upstreamPort = await getFreePort()
  upstream = http2.createSecureServer({ ...createSelfSignedCert('h2.test'), allowHTTP1: false }, (req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        httpVersion: req.httpVersion,
        method: req.method,
        url: req.url,
        authority: req.headers[':authority'],
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
  })
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve))
})

after(async () => {
  await new Promise(resolve => upstream.close(() => resolve(undefined)))
  await proxy.stop()
})

test('the flag is read from the environment', () => {
  assert.equal(require('../../config').UPSTREAM_H2, true)
})

test('a request with X-Target-URL reaches an HTTP/2-only upstream over h2', async () => {
  const res = await request({
    method: 'GET',
    path: '/h2',
    headers: { 'x-target-url': `https://127.0.0.1:${upstreamPort}/h2` }
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.httpVersion, '2.0')
  assert.equal(res.json.method, 'GET')
  assert.equal(res.json.url, '/h2')
  assert.equal(res.json.authority, `127.0.0.1:${upstreamPort}`)
})

test('a proxy-style absolute URL reaches the h2 upstream', async () => {
  const res = await request({ method: 'GET', path: `https://127.0.0.1:${upstreamPort}/absolute?x=1` })
  assert.equal(res.status, 200)
  assert.equal(res.json.httpVersion, '2.0')
  assert.equal(res.json.url, '/absolute?x=1')
})

test('a POST with a JSON body is forwarded over h2', async () => {
  const payload = JSON.stringify({ hello: 'h2' })
  const res = await request({
    method: 'POST',
    path: '/post',
    headers: {
      'x-target-url': `https://127.0.0.1:${upstreamPort}/post`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload)
    }
  }, payload)
  assert.equal(res.status, 200)
  assert.equal(res.json.httpVersion, '2.0')
  assert.equal(res.json.method, 'POST')
  assert.equal(res.json.contentType, 'application/json')
  assert.equal(res.json.body, payload)
})

test('a decrypted request of a MITM tunnel is forwarded over h2 too', async () => {
  const { socket, statusLine } = await openTunnel(proxyPort, `127.0.0.1:${upstreamPort}`)
  assert.match(statusLine, /^HTTP\/1\.1 200/)
  const secure = await secureTunnel(socket, 'h2.test')
  const res = await requestOverSocket(secure, {
    method: 'GET',
    path: '/tunnel',
    headers: { host: `127.0.0.1:${upstreamPort}`, connection: 'close' }
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.httpVersion, '2.0')
  assert.equal(res.json.url, '/tunnel')
  secure.destroy()
})
