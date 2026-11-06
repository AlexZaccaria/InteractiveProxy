'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const WebSocket = require('ws')
const { loadServer, getFreePort } = require('../helpers/load-server')

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
function connectThroughProxy (targetUrl = `http://127.0.0.1:${upstreamPort}/socket`) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/socket`, {
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

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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

before(async () => {
  const loaded = await loadServer()
  proxy = loaded.proxy
  proxyPort = loaded.port
  await proxy.start()

  upstreamPort = await getFreePort()
  upstream = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: upstreamPort, perMessageDeflate: false })
  upstream.on('connection', ws => {
    const record = { ws, closed: false, received: [] }
    upstreamConnections.push(record)
    ws.on('message', (data, isBinary) => {
      record.received.push({ data: Buffer.from(data), isBinary })
      ws.send(data, { binary: isBinary })
    })
    ws.on('close', () => { record.closed = true })
  })
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

  client.terminate()
  await closed(client)
  upstreamSide.ws.terminate()
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

  // Close from the upstream side: the proxy ends the client socket and logs
  // the summary. (A client-initiated close is covered by its own test.)
  upstreamSide.ws.close(1000, 'bye')
  const closeInfo = await closed(client)
  // current behavior: the proxy ends the TCP connection without relaying the
  // close frame, so the client sees an abnormal closure.
  assert.equal(closeInfo.code, 1006)
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

test('a client-initiated close is relayed as a text message and leaves the upstream open', async () => {
  const client = await connectThroughProxy()
  const upstreamSide = lastUpstreamConnection()
  client.send('bye')
  await nextMessage(client)
  assert.equal(upstreamSide.received.length, 1)

  client.close(1000, 'done')

  // current behavior: the hand-written frame decoder does not look at the
  // opcode, so the close frame (status 1000 = 0x03 0xE8, then "done") is
  // forwarded to the upstream as a text message and echoed back; the 0xE8
  // byte is not valid UTF-8 and becomes U+FFFD on the way.
  await waitFor(() => upstreamSide.received.length === 2)
  const relayed = upstreamSide.received[1]
  assert.equal(relayed.isBinary, false)
  assert.deepEqual(relayed.data, Buffer.concat([Buffer.from([0x03]), Buffer.from('�'), Buffer.from('done')]))
  assert.equal(upstreamSide.ws.readyState, WebSocket.OPEN)

  // current behavior: the close handshake never completes; the ws client
  // gives up after its 30 s timeout. terminate() ends the TCP side instead.
  client.terminate()
  const closeInfo = await closed(client)
  assert.equal(closeInfo.code, 1006)

  // current behavior: the proxy only listens for 'close' on the client
  // socket, which an HTTP server keeps half-open after the peer's FIN, so the
  // upstream connection is never closed and its summary is never logged.
  await sleep(500)
  assert.equal(upstreamSide.closed, false)
  assert.equal(upstreamSide.ws.readyState, WebSocket.OPEN)
  const logs = await api('GET', '/api/logs?showWsConnections=true&limit=100')
  const summaries = logs.json.items.filter(item => item.isWebSocketSummary)
  assert.equal(summaries.length, 1, 'only the upstream-closed connection of the previous test has a summary')

  upstreamSide.ws.terminate()
  await waitFor(() => upstreamSide.closed)
})

test('a message larger than one TCP read (> 65535 bytes) is not relayed intact', async () => {
  const client = await connectThroughProxy()
  const upstreamSide = lastUpstreamConnection()
  const payload = 'x'.repeat(70_000)
  client.send(payload)

  // current behavior: the client-side frame decoder expects a whole frame in a
  // single socket chunk; a 70 000-byte frame arrives in several reads, so the
  // echo never comes back intact.
  const reply = await nextMessage(client, 1500)
  if (reply) {
    assert.notEqual(reply.data.toString('utf8'), payload)
  }
  assert.equal(upstreamSide.received.some(message => message.data.length === payload.length), false)

  client.terminate()
  await closed(client)
  upstreamSide.ws.terminate()
})
