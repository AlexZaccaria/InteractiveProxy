'use strict'

/**
 * Integration tests of the TLS passthrough rules: a CONNECT tunnel to a
 * covered host is relayed as raw bytes (the client sees the upstream's own
 * certificate), the others are terminated by the proxy.
 */

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const https = require('https')
const { loadServer, getFreePort } = require('../helpers/load-server')
const { createSelfSignedCert, openTunnel, secureTunnel } = require('../helpers/mitm')

let proxy
let proxyPort
let upstream
let upstreamPort

function api(method, apiPath, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method,
        path: apiPath,
        headers: {
          host: `127.0.0.1:${proxyPort}`,
          ...(body
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
            : {})
        }
      },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {}
          resolve({ status: res.statusCode, json })
        })
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** One request over an established TLS socket, resolving with the body. */
function requestOverSocket(secureSocket, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', path: '/pinned', headers: { host }, createConnection: () => secureSocket },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
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
  const cert = createSelfSignedCert('pinned.test')
  upstream = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('from the upstream')
  })
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve))
})

after(async () => {
  await new Promise(resolve => upstream.close(resolve))
  await proxy.stop()
})

test('a covered host is tunnelled raw; without the rule the proxy terminates TLS', async () => {
  const target = `127.0.0.1:${upstreamPort}`

  // Terminated: the certificate the client sees is issued by the proxy's CA.
  const mitm = await openTunnel(proxyPort, target)
  assert.equal(mitm.statusLine, 'HTTP/1.1 200 Connection Established')
  const mitmSocket = await secureTunnel(mitm.socket, 'pinned.test')
  assert.equal(mitmSocket.getPeerCertificate().issuer.CN, 'Cascade Proxy CA')
  mitmSocket.destroy()

  const added = await api('POST', '/api/passthrough', {
    action: 'add',
    host: ' 127.0.0.1 ',
    name: 'Pinned upstream'
  })
  assert.equal(added.status, 200)
  const [rule] = added.json.passthroughRules
  assert.equal(rule.host, '127.0.0.1')
  assert.deepEqual((await api('GET', '/api/passthrough')).json, [rule])
  assert.equal((await api('POST', '/api/passthrough', { action: 'add', host: 'a b' })).status, 400)

  // Passthrough: the upstream's own self-signed certificate reaches the client.
  const raw = await openTunnel(proxyPort, target)
  assert.equal(raw.statusLine, 'HTTP/1.1 200 Connection Established')
  const rawSocket = await secureTunnel(raw.socket, 'pinned.test')
  const peer = rawSocket.getPeerCertificate()
  assert.equal(peer.subject.CN, 'pinned.test')
  assert.equal(peer.issuer.CN, 'pinned.test')
  const answer = await requestOverSocket(rawSocket, 'pinned.test')
  assert.equal(answer.status, 200)
  assert.equal(answer.body, 'from the upstream')
  rawSocket.destroy()

  const logs = await api(
    'GET',
    '/api/logs?view=summary&limit=200&sources=proxied,mitm,websocket,tunnel,direct&methods=GET,POST,CONNECT'
  )
  const tunnel = logs.json.items.find(
    item => item.source === 'tunnel' && item.passthrough && item.passthrough.ruleId === rule.id
  )
  assert.ok(tunnel, 'the tunnel is logged with the rule that covered it')
  assert.equal(tunnel.passthrough.ruleName, 'Pinned upstream')

  const disabled = await api('POST', '/api/passthrough', {
    action: 'update',
    id: rule.id,
    enabled: false
  })
  assert.equal(disabled.json.passthroughRules[0].enabled, false)
  const again = await openTunnel(proxyPort, target)
  const againSocket = await secureTunnel(again.socket, 'pinned.test')
  assert.equal(againSocket.getPeerCertificate().issuer.CN, 'Cascade Proxy CA')
  againSocket.destroy()

  const removed = await api('POST', '/api/passthrough', { action: 'remove', id: rule.id })
  assert.deepEqual(removed.json.passthroughRules, [])
})
