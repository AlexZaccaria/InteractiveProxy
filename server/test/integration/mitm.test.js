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
