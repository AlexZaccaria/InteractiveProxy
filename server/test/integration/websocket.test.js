'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const https = require('https')
const WebSocket = require('ws')
const { loadServer, getFreePort } = require('../helpers/load-server')
const { createSelfSignedCert, openTunnel, secureTunnel } = require('../helpers/mitm')

let proxy
let proxyPort
let upstream
let upstreamPort
const upstreamConnections = []

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

/** WebSocket client that goes through the proxy to the echo upstream. */
function connectThroughProxy (targetUrl = `http://127.0.0.1:${upstreamPort}/socket`, protocols) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/socket`, protocols, {
      headers: { 'x-target-url': targetUrl },
      perMessageDeflate: false
    })
    client.once('open', () => resolve(client))
    client.once('error', reject)
  })
}

/** Resolve with the next message or with null after `timeoutMs`. */
function nextMessage (client, timeoutMs = 2000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      client.removeListener('message', onMessage)
      resolve(null)
    }, timeoutMs)
    const onMessage = (data, isBinary) => {
      clearTimeout(timer)
      resolve({ data: Buffer.from(data), isBinary })
    }
    client.once('message', onMessage)
  })
}

/** Resolve with { code, reason } when the client emits 'close'. */
function closed (client) {
  return new Promise(resolve => {
    if (client.readyState === WebSocket.CLOSED) return resolve(null)
    client.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })
}

function waitFor (condition, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (condition()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('condition not met in time'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

function lastUpstreamConnection () {
  return upstreamConnections[upstreamConnections.length - 1]
}

/** Echo server bookkeeping shared by every upstream of this file. */
function trackEcho (server) {
  server.on('connection', ws => {
    const record = { ws, closed: false, closeCode: null, closeReason: null, received: [], pings: [] }
    upstreamConnections.push(record)
    ws.on('message', (data, isBinary) => {
      record.received.push({ data: Buffer.from(data), isBinary })
      ws.send(data, { binary: isBinary })
    })
    ws.on('ping', data => record.pings.push(Buffer.from(data)))
    ws.on('close', (code, reason) => {
      record.closed = true
      record.closeCode = code
      record.closeReason = reason.toString()
    })
  })
}

async function summariesFor (connectionId) {
  const logs = await api('GET', '/api/logs?showWsConnections=true&limit=200')
  return logs.json.items.filter(item => item.isWebSocketSummary && item.connectionId === connectionId)
}

async function connectionLogFor (wsUrl) {
  const logs = await api('GET', '/api/logs?showWsConnections=true&limit=200')
  return logs.json.items.find(item => item.isConnectionLog && item.direction === 'connected' && item.url === wsUrl)
}

before(async () => {
  const loaded = await loadServer()
  proxy = loaded.proxy
  proxyPort = loaded.port
  await proxy.start()

  upstreamPort = await getFreePort()
  upstream = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: upstreamPort, perMessageDeflate: false })
  trackEcho(upstream)
  await new Promise(resolve => upstream.once('listening', resolve))
})

after(async () => {
  for (const { ws } of upstreamConnections) ws.terminate()
  await new Promise(resolve => upstream.close(resolve))
  await proxy.stop()
})

test('an X-Target-URL with the ws:// scheme is accepted like the http:// form', async () => {
  const client = await connectThroughProxy(`ws://127.0.0.1:${upstreamPort}/socket`)
  const upstreamSide = lastUpstreamConnection()
  assert.ok(upstreamSide, 'the proxy opened a connection to the upstream')

  client.send('via ws target')
  const echo = await nextMessage(client)
  assert.ok(echo, 'echo received through the ws:// target')
  assert.equal(echo.isBinary, false)
  assert.equal(echo.data.toString('utf8'), 'via ws target')
  assert.equal(upstreamSide.received.length, 1)

  client.close(1000)
  await closed(client)
  await waitFor(() => upstreamSide.closed)
})

test('text, binary and JSON messages are relayed in both directions and logged', async () => {
  await api('DELETE', '/api/logs')

  const client = await connectThroughProxy()
  const upstreamSide = lastUpstreamConnection()
  assert.ok(upstreamSide, 'the proxy opened a connection to the upstream')

  client.send('hello proxy')
  const text = await nextMessage(client)
  assert.ok(text, 'text echo received')
  assert.equal(text.isBinary, false)
  assert.equal(text.data.toString('utf8'), 'hello proxy')

  const bytes = Buffer.from([0, 1, 2, 3, 254, 255])
  client.send(bytes)
  const binary = await nextMessage(client)
  assert.ok(binary, 'binary echo received')
  assert.equal(binary.isBinary, true)
  assert.deepEqual(binary.data, bytes)

  client.send('{"type":"ping","n":1}')
  const json = await nextMessage(client)
  assert.equal(json.data.toString('utf8'), '{"type":"ping","n":1}')

  assert.equal(upstreamSide.received.length, 3)
  assert.equal(upstreamSide.received[0].data.toString('utf8'), 'hello proxy')
  assert.equal(upstreamSide.received[1].isBinary, true)
  assert.deepEqual(upstreamSide.received[1].data, bytes)

  // Close from the upstream side: the close frame (code and reason) is relayed
  // to the client and the summary is logged.
  upstreamSide.ws.close(1000, 'bye')
  const closeInfo = await closed(client)
  assert.deepEqual(closeInfo, { code: 1000, reason: 'bye' })
  await waitFor(() => upstreamSide.closed)

  const logs = await api('GET', '/api/logs?showWsConnections=true&limit=100')
  const ws = logs.json.items.filter(item => item.source === 'websocket')
  const wsUrl = `ws://127.0.0.1:${upstreamPort}/socket`

  const connection = ws.find(item => item.isConnectionLog && item.direction === 'connected')
  assert.ok(connection, 'connection log present')
  assert.equal(connection.url, wsUrl)
  assert.equal(connection.method, 'WS')
  assert.equal(connection.statusCode, 101)

  const outbound = ws.filter(item => item.direction === 'client->server')
  const inbound = ws.filter(item => item.direction === 'server->client')
  assert.equal(outbound.length, 3)
  assert.equal(inbound.length, 3)
  assert.equal(outbound[0].connectionId, connection.connectionId)
  assert.equal(outbound[0].url, wsUrl)

  const textLog = await api('GET', `/api/logs/${encodeURIComponent(String(outbound[0].id))}`)
  assert.equal(textLog.json.body, 'hello proxy')
  const binaryLog = await api('GET', `/api/logs/${encodeURIComponent(String(outbound[1].id))}`)
  assert.equal(binaryLog.json.body, `[Binary data: ${bytes.length} bytes]`)
  const jsonLog = await api('GET', `/api/logs/${encodeURIComponent(String(outbound[2].id))}`)
  assert.deepEqual(jsonLog.json.wsBodyJsonAfter, { type: 'ping', n: 1 })

  const summary = ws.find(item => item.isWebSocketSummary)
  assert.ok(summary, 'summary logged when the upstream closes')
  assert.equal(summary.direction, 'summary')
  assert.equal(summary.wsSummary.closeReason, 'target-closed')
  assert.equal(summary.wsSummary.messagesClientToServer, 3)
  assert.equal(summary.wsSummary.messagesServerToClient, 3)
  assert.equal(summary.wsSummary.rewrittenMessages, 0)
  assert.equal(typeof summary.wsSummary.durationMs, 'number')
})

test('connection logs are hidden from /api/logs unless showWsConnections is set', async () => {
  const hidden = await api('GET', '/api/logs?limit=100')
  assert.equal(hidden.json.items.some(item => item.isConnectionLog), false)
  const shown = await api('GET', '/api/logs?showWsConnections=true&limit=100')
  assert.equal(shown.json.items.some(item => item.isConnectionLog), true)
})

test('a client-initiated close is relayed as a close frame with its code and reason', async () => {
  await api('DELETE', '/api/logs')
  const client = await connectThroughProxy()
  const upstreamSide = lastUpstreamConnection()
  client.send('bye')
  await nextMessage(client)
  assert.equal(upstreamSide.received.length, 1)

  client.close(1000, 'done')
  const closeInfo = await closed(client)
  assert.deepEqual(closeInfo, { code: 1000, reason: 'done' }, 'the client completes a clean close handshake')

  await waitFor(() => upstreamSide.closed)
  assert.equal(upstreamSide.received.length, 1, 'no message was relayed for the close frame')
  assert.equal(upstreamSide.closeCode, 1000)
  assert.equal(upstreamSide.closeReason, 'done')

  const connection = await connectionLogFor(`ws://127.0.0.1:${upstreamPort}/socket`)
  const summaries = await summariesFor(connection.connectionId)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].wsSummary.closeReason, 'client-closed')
  assert.equal(summaries[0].wsSummary.messagesClientToServer, 1)
})

test('a client that drops the connection makes the proxy terminate the upstream side', async () => {
  await api('DELETE', '/api/logs')
  const client = await connectThroughProxy()
  const upstreamSide = lastUpstreamConnection()

  client.terminate()
  const closeInfo = await closed(client)
  assert.equal(closeInfo.code, 1006)

  await waitFor(() => upstreamSide.closed)
  assert.equal(upstreamSide.closeCode, 1006, 'the upstream sees an abnormal closure, like the client produced')

  const connection = await connectionLogFor(`ws://127.0.0.1:${upstreamPort}/socket`)
  const summaries = await summariesFor(connection.connectionId)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].wsSummary.closeReason, 'client-closed')
})

test('messages larger than one socket read are relayed intact in both directions', async () => {
  const client = await connectThroughProxy()
  const upstreamSide = lastUpstreamConnection()

  const text = 'x'.repeat(70_000)
  client.send(text)
  const textEcho = await nextMessage(client, 5000)
  assert.ok(textEcho, 'large text echo received')
  assert.equal(textEcho.isBinary, false)
  assert.equal(textEcho.data.length, text.length)
  assert.equal(textEcho.data.toString('utf8'), text)

  const binary = Buffer.alloc(1024 * 1024)
  for (let i = 0; i < binary.length; i++) binary[i] = i & 0xff
  client.send(binary)
  const binaryEcho = await nextMessage(client, 5000)
  assert.ok(binaryEcho, 'large binary echo received')
  assert.equal(binaryEcho.isBinary, true)
  assert.equal(binaryEcho.data.length, binary.length)
  assert.ok(binaryEcho.data.equals(binary))

  assert.equal(upstreamSide.received.length, 2)
  assert.equal(upstreamSide.received[0].data.length, text.length)
  assert.equal(upstreamSide.received[1].data.length, binary.length)

  client.close(1000)
  await closed(client)
  await waitFor(() => upstreamSide.closed)
})

test('pings are relayed to the upstream and its pongs come back; the connection stays open', async () => {
  const client = await connectThroughProxy()
  const upstreamSide = lastUpstreamConnection()

  const pong = new Promise(resolve => client.once('pong', data => resolve(Buffer.from(data))))
  client.ping('are-you-there')
  assert.equal((await pong).toString('utf8'), 'are-you-there')
  await waitFor(() => upstreamSide.pings.length === 1)
  assert.equal(upstreamSide.pings[0].toString('utf8'), 'are-you-there')

  client.send('still here')
  const echo = await nextMessage(client)
  assert.equal(echo.data.toString('utf8'), 'still here')
  assert.equal(client.readyState, WebSocket.OPEN)
  assert.equal(upstreamSide.ws.readyState, WebSocket.OPEN)

  client.close(1000)
  await closed(client)
  await waitFor(() => upstreamSide.closed)
})

test('an upstream close with an application code and reason reaches the client unchanged', async () => {
  const client = await connectThroughProxy()
  const upstreamSide = lastUpstreamConnection()

  upstreamSide.ws.close(4000, 'maintenance')
  const closeInfo = await closed(client)
  assert.deepEqual(closeInfo, { code: 4000, reason: 'maintenance' })
  await waitFor(() => upstreamSide.closed)
})

test('the subprotocol selected by the upstream is the one announced to the client', async () => {
  const chatPort = await getFreePort()
  const chatUpstream = new WebSocket.WebSocketServer({
    host: '127.0.0.1',
    port: chatPort,
    perMessageDeflate: false,
    handleProtocols: () => 'chat'
  })
  trackEcho(chatUpstream)
  await new Promise(resolve => chatUpstream.once('listening', resolve))

  try {
    const client = await connectThroughProxy(`http://127.0.0.1:${chatPort}/socket`, ['other', 'chat'])
    const upstreamSide = lastUpstreamConnection()
    assert.equal(client.protocol, 'chat')
    assert.equal(upstreamSide.ws.protocol, 'chat')

    client.send('negotiated')
    const echo = await nextMessage(client)
    assert.equal(echo.data.toString('utf8'), 'negotiated')

    client.close(1000)
    await closed(client)
    await waitFor(() => upstreamSide.closed)
  } finally {
    await new Promise(resolve => chatUpstream.close(resolve))
  }
})

test('a wss:// upgrade through a CONNECT tunnel is relayed to a TLS upstream and logged', async () => {
  await api('DELETE', '/api/logs')

  const tlsPort = await getFreePort()
  const tlsUpstream = https.createServer(createSelfSignedCert('ws-upstream.test'))
  const tlsEcho = new WebSocket.WebSocketServer({ server: tlsUpstream, perMessageDeflate: false })
  trackEcho(tlsEcho)
  await new Promise(resolve => tlsUpstream.listen(tlsPort, '127.0.0.1', resolve))

  try {
    const { socket, statusLine } = await openTunnel(proxyPort, `127.0.0.1:${tlsPort}`)
    assert.equal(statusLine, 'HTTP/1.1 200 Connection Established')
    const secure = await secureTunnel(socket)
    assert.equal(secure.getPeerCertificate().issuer.CN, 'Cascade Proxy CA')

    const client = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${tlsPort}/secure-socket`, {
        createConnection: () => secure,
        perMessageDeflate: false
      })
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
    const upstreamSide = lastUpstreamConnection()
    assert.ok(upstreamSide, 'the proxy opened a TLS connection to the upstream')

    client.send('over tls')
    const text = await nextMessage(client)
    assert.equal(text.isBinary, false)
    assert.equal(text.data.toString('utf8'), 'over tls')

    const bytes = Buffer.from([9, 8, 7, 6])
    client.send(bytes)
    const binary = await nextMessage(client)
    assert.equal(binary.isBinary, true)
    assert.deepEqual(binary.data, bytes)
    assert.equal(upstreamSide.received.length, 2)

    client.close(1000, 'done')
    const closeInfo = await closed(client)
    assert.deepEqual(closeInfo, { code: 1000, reason: 'done' })
    await waitFor(() => upstreamSide.closed)
    assert.equal(upstreamSide.closeCode, 1000)

    const wsUrl = `wss://127.0.0.1:${tlsPort}/secure-socket`
    const connection = await connectionLogFor(wsUrl)
    assert.ok(connection, 'connection log for the TLS WebSocket')
    assert.equal(connection.source, 'websocket')
    const logs = await api('GET', '/api/logs?showWsConnections=true&limit=100')
    const messages = logs.json.items.filter(item => item.source === 'websocket' && item.connectionId === connection.connectionId && !item.isConnectionLog)
    assert.equal(messages.filter(item => item.direction === 'client->server').length, 2)
    assert.equal(messages.filter(item => item.direction === 'server->client').length, 2)
    const summaries = await summariesFor(connection.connectionId)
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].wsSummary.closeReason, 'client-closed')
  } finally {
    await new Promise(resolve => tlsEcho.close(resolve))
    await new Promise(resolve => tlsUpstream.close(resolve))
  }
})
