'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const https = require('https')
const net = require('net')
const path = require('path')
const tls = require('tls')
const forge = require('node-forge')
const { loadServer, getFreePort } = require('../helpers/load-server')

let proxy
let proxyPort
let certsDir
let upstream
let upstreamPort

/** Self-signed certificate for the test upstream (native key generation, forge for the X.509 part). */
function createSelfSignedCert (commonName) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' })
  const forgeKey = forge.pki.privateKeyFromPem(keyPem)
  const forgePublic = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }))

  const cert = forge.pki.createCertificate()
  cert.publicKey = forgePublic
  cert.serialNumber = '02'
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600_000)
  const attrs = [{ name: 'commonName', value: commonName }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: commonName }] }
  ])
  cert.sign(forgeKey, forge.md.sha256.create())

  return { key: keyPem, cert: forge.pki.certificateToPem(cert) }
}

/**
 * Open a CONNECT tunnel through the proxy and return the raw socket once the
 * proxy has answered, together with the status line it sent.
 */
function openTunnel (target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
    let buffered = ''
    const onData = chunk => {
      buffered += chunk.toString('latin1')
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', onData)
      socket.pause()
      const header = buffered.slice(0, end)
      const rest = Buffer.from(buffered.slice(end + 4), 'latin1')
      if (rest.length) socket.unshift(rest)
      resolve({ socket, statusLine: header.split('\r\n')[0], header })
    }
    socket.on('data', onData)
    socket.on('error', reject)
  })
}

/** TLS handshake with the proxy over an established tunnel. */
function secureTunnel (socket, servername) {
  return new Promise((resolve, reject) => {
    socket.resume()
    const secure = tls.connect({ socket, servername, rejectUnauthorized: false }, () => resolve(secure))
    secure.on('error', reject)
  })
}

/** One HTTP request written over an already established TLS socket. */
function requestOverSocket (secureSocket, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, createConnection: () => secureSocket }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

function api (method, apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path: apiPath }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    req.end()
  })
}

before(async () => {
  const loaded = await loadServer()
  proxy = loaded.proxy
  proxyPort = loaded.port
  certsDir = proxy.config.CERTS_DIR
  await proxy.start()

  upstreamPort = await getFreePort()
  upstream = https.createServer(createSelfSignedCert('upstream.test'), (req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
  })
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve))
})

after(async () => {
  await new Promise(resolve => upstream.close(resolve))
  await proxy.stop()
})

test('the CA is generated lazily on the first CONNECT and signs a per-host leaf', async () => {
  assert.equal(fs.existsSync(path.join(certsDir, 'ca-cert.pem')), false, 'no CA before the first CONNECT')

  const { socket, statusLine } = await openTunnel(`127.0.0.1:${upstreamPort}`)
  assert.equal(statusLine, 'HTTP/1.1 200 Connection Established')

  const secure = await secureTunnel(socket, 'localhost')
  const peer = secure.getPeerCertificate()
  assert.equal(peer.issuer.CN, 'Cascade Proxy CA')
  assert.equal(peer.subject.CN, 'localhost')
  assert.match(peer.subjectaltname, /DNS:localhost/)
  assert.equal(secure.authorized, false, 'the leaf is signed by the proxy CA, which Node does not trust')

  assert.equal(fs.existsSync(path.join(certsDir, 'ca-cert.pem')), true)
  assert.equal(fs.existsSync(path.join(certsDir, 'ca-key.pem')), true)

  const caPem = fs.readFileSync(path.join(certsDir, 'ca-cert.pem'), 'utf8')
  const ca = forge.pki.certificateFromPem(caPem)
  assert.equal(ca.subject.getField('CN').value, 'Cascade Proxy CA')
  assert.ok(ca.getExtension('basicConstraints').cA)

  secure.destroy()
})

test('a MITM request reaches an upstream on a non-443 port (the CONNECT port is kept)', async () => {
  await api('DELETE', '/api/logs')

  const { socket } = await openTunnel(`127.0.0.1:${upstreamPort}`)
  const secure = await secureTunnel(socket, 'localhost')

  const res = await requestOverSocket(secure, {
    method: 'GET',
    path: '/hello?via=mitm',
    headers: { host: `127.0.0.1:${upstreamPort}`, connection: 'close' }
  })

  assert.equal(res.status, 200)
  const echo = JSON.parse(res.body)
  assert.equal(echo.method, 'GET')
  assert.equal(echo.url, '/hello?via=mitm')
  assert.equal(echo.headers.host, `127.0.0.1:${upstreamPort}`)

  const logs = await api('GET', '/api/logs?sources=mitm')
  assert.equal(logs.json.total, 1)
  const entry = logs.json.items[0]
  assert.equal(entry.source, 'mitm')
  assert.equal(entry.statusCode, 200)
  assert.equal(entry.method, 'GET')
  assert.equal(entry.fullUrl, `https://127.0.0.1:${upstreamPort}/hello?via=mitm`)
  assert.equal(entry.upstreamErrorCategory, undefined)

  secure.destroy()
})

test('the leaf certificate for a host is reused across tunnels', async () => {
  const first = await openTunnel(`127.0.0.1:${upstreamPort}`)
  const firstSecure = await secureTunnel(first.socket, 'reuse.test')
  const firstFingerprint = firstSecure.getPeerCertificate().fingerprint256
  assert.equal(firstSecure.getPeerCertificate().subject.CN, 'reuse.test')
  firstSecure.destroy()

  const second = await openTunnel(`127.0.0.1:${upstreamPort}`)
  const secondSecure = await secureTunnel(second.socket, 'reuse.test')
  assert.equal(secondSecure.getPeerCertificate().fingerprint256, firstFingerprint)
  secondSecure.destroy()
})

test('CONNECT with an unparsable target is refused with 400', async () => {
  const { statusLine, socket } = await openTunnel('not a host')
  assert.equal(statusLine, 'HTTP/1.1 400 Bad Request')
  socket.destroy()
})

test('tunnels for different SNI names get their own certificate from the same CA and leaf key', async () => {
  const first = await openTunnel(`127.0.0.1:${upstreamPort}`)
  const alpha = await secureTunnel(first.socket, 'alpha.test')
  const second = await openTunnel(`127.0.0.1:${upstreamPort}`)
  const beta = await secureTunnel(second.socket, 'beta.test')

  const peerAlpha = alpha.getPeerCertificate()
  const peerBeta = beta.getPeerCertificate()
  assert.equal(peerAlpha.subject.CN, 'alpha.test')
  assert.equal(peerBeta.subject.CN, 'beta.test')
  assert.equal(peerAlpha.issuer.CN, 'Cascade Proxy CA')
  assert.equal(peerBeta.issuer.CN, 'Cascade Proxy CA')
  assert.notEqual(peerAlpha.serialNumber, peerBeta.serialNumber)
  assert.notEqual(peerAlpha.fingerprint256, peerBeta.fingerprint256)
  assert.equal(peerAlpha.modulus, peerBeta.modulus, 'both certificates carry the shared leaf key')

  assert.equal(fs.existsSync(path.join(certsDir, 'leaf-key.pem')), true)
  assert.equal(fs.existsSync(path.join(certsDir, 'hosts', 'alpha.test.pem')), true)
  assert.equal(fs.existsSync(path.join(certsDir, 'hosts', 'beta.test.pem')), true)

  alpha.destroy()
  beta.destroy()
})

test('a client that sends no SNI gets the certificate of the CONNECT host and is served', async () => {
  await api('DELETE', '/api/logs')

  const { socket } = await openTunnel(`127.0.0.1:${upstreamPort}`)
  const secure = await new Promise((resolve, reject) => {
    socket.resume()
    // No servername and no host: the ClientHello carries no SNI extension.
    const tlsSocket = tls.connect({ socket, rejectUnauthorized: false }, () => resolve(tlsSocket))
    tlsSocket.on('error', reject)
  })

  const peer = secure.getPeerCertificate()
  assert.equal(peer.subject.CN, '127.0.0.1')
  assert.equal(peer.issuer.CN, 'Cascade Proxy CA')

  const res = await requestOverSocket(secure, {
    method: 'GET',
    path: '/no-sni',
    headers: { host: `127.0.0.1:${upstreamPort}`, connection: 'close' }
  })
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).url, '/no-sni')

  const logs = await api('GET', '/api/logs?sources=mitm')
  assert.equal(logs.json.total, 1)
  assert.equal(logs.json.items[0].fullUrl, `https://127.0.0.1:${upstreamPort}/no-sni`)

  secure.destroy()
})

// --- Response streaming through the MITM tunnel ----------------------------

const BIG_BINARY = crypto.randomBytes(3 * 1024 * 1024)
const BIG_JSON = JSON.stringify({ marker: 'original', pad: 'x'.repeat(2 * 1024 * 1024) })
let streamUpstream
let streamUpstreamPort

/** Management API call with a JSON payload against the proxy's own origin. */
function apiJson (method, apiPath, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method,
      path: apiPath,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * One request over an established TLS socket, returning the raw body and
 * the arrival time of every chunk.
 */
function requestOverSocketTimed (secureSocket, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, createConnection: () => secureSocket }, res => {
      const chunks = []
      const chunkTimes = []
      res.on('data', chunk => {
        chunks.push(chunk)
        chunkTimes.push(Date.now())
      })
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        chunkTimes,
        endAt: Date.now()
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Poll the logs until the entry of `fullUrl` has a numeric responseSize (the pipe may still be finishing). */
async function waitForStreamedEntry (fullUrl) {
  const deadline = Date.now() + 2000
  let entry = null
  while (Date.now() < deadline) {
    const logs = await api('GET', '/api/logs?sources=mitm&limit=200')
    entry = logs.json.items.find(item => item.fullUrl === fullUrl) || null
    if (entry && typeof entry.responseSize === 'number') return entry
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return entry
}

before(async () => {
  streamUpstreamPort = await getFreePort()
  streamUpstream = https.createServer(createSelfSignedCert('stream.test'), (req, res) => {
    if (req.url === '/big.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BIG_BINARY.length })
      res.end(BIG_BINARY)
      return
    }
    if (req.url === '/events') {
      // Three events 100 ms apart: a streaming proxy forwards the first one
      // long before the upstream has finished.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: event-1\n\n')
      setTimeout(() => res.write('data: event-2\n\n'), 100)
      setTimeout(() => res.end('data: event-3\n\n'), 200)
      return
    }
    if (req.url === '/big.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(BIG_JSON) })
      res.end(BIG_JSON)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => streamUpstream.listen(streamUpstreamPort, '127.0.0.1', resolve))
})

after(async () => {
  await new Promise(resolve => streamUpstream.close(resolve))
})

test('a 3 MiB binary response through MITM is streamed intact and logged with its size', async () => {
  await api('DELETE', '/api/logs')

  const { socket } = await openTunnel(`127.0.0.1:${streamUpstreamPort}`)
  const secure = await secureTunnel(socket, 'stream.test')
  const res = await requestOverSocketTimed(secure, {
    method: 'GET',
    path: '/big.bin',
    headers: { host: `127.0.0.1:${streamUpstreamPort}`, connection: 'close' }
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/octet-stream')
  assert.equal(res.body.length, BIG_BINARY.length)
  assert.equal(
    crypto.createHash('sha256').update(res.body).digest('hex'),
    crypto.createHash('sha256').update(BIG_BINARY).digest('hex')
  )

  const fullUrl = `https://127.0.0.1:${streamUpstreamPort}/big.bin`
  const entry = await waitForStreamedEntry(fullUrl)
  assert.ok(entry, 'the streamed request is logged')
  assert.equal(entry.source, 'mitm')
  assert.equal(entry.statusCode, 200)
  assert.equal(entry.responseBody, '[streamed response]')
  assert.equal(entry.responseSize, BIG_BINARY.length)

  secure.destroy()
})

test('an event stream through MITM reaches the client incrementally', async () => {
  const { socket } = await openTunnel(`127.0.0.1:${streamUpstreamPort}`)
  const secure = await secureTunnel(socket, 'stream.test')
  const res = await requestOverSocketTimed(secure, {
    method: 'GET',
    path: '/events',
    headers: { host: `127.0.0.1:${streamUpstreamPort}`, connection: 'close' }
  })
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/event-stream/)
  assert.equal(res.body.toString('utf8'), 'data: event-1\n\ndata: event-2\n\ndata: event-3\n\n')
  assert.ok(res.chunkTimes.length >= 2, `events arrived in ${res.chunkTimes.length} chunk(s): the stream was buffered`)
  assert.ok(
    res.endAt - res.chunkTimes[0] >= 150,
    `first event arrived ${res.endAt - res.chunkTimes[0]} ms before the end: the stream was buffered`
  )

  secure.destroy()
})

test('a large JSON response with a matching JSONPath rule is still rewritten (buffered path)', async () => {
  const fullUrl = `https://127.0.0.1:${streamUpstreamPort}/big.json`
  const created = await apiJson('POST', '/api/edit-rules', {
    kind: 'jsonPath',
    name: 'marker',
    url: fullUrl,
    path: 'root.marker',
    value: 'rewritten',
    valueType: 'string',
    target: 'response'
  })
  assert.equal(created.status, 201)
  const ruleId = created.json.rule.id

  try {
    const { socket } = await openTunnel(`127.0.0.1:${streamUpstreamPort}`)
    const secure = await secureTunnel(socket, 'stream.test')
    const res = await requestOverSocketTimed(secure, {
      method: 'GET',
      path: '/big.json',
      headers: { host: `127.0.0.1:${streamUpstreamPort}`, connection: 'close' }
    })
    assert.equal(res.status, 200)
    const parsed = JSON.parse(res.body.toString('utf8'))
    assert.equal(parsed.marker, 'rewritten')
    assert.equal(parsed.pad.length, 2 * 1024 * 1024)

    const logs = await api('GET', `/api/logs?sources=mitm&limit=200`)
    const entry = logs.json.items.find(item => item.fullUrl === fullUrl)
    assert.ok(entry)
    assert.notEqual(entry.responseBody, '[streamed response]')
    assert.equal(entry.rewrites[0].id, ruleId)

    secure.destroy()
  } finally {
    // 204 with an empty body: the JSON-parsing `api` helper cannot be used.
    await apiJson('DELETE', `/api/edit-rules/${ruleId}`, {})
  }
})
