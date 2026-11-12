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

async function findLogByUrl(url) {
  const { json } = await api('GET', '/api/logs?view=summary&limit=200')
  return json.items.find(item => item.fullUrl === url || item.targetUrl === url)
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
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, path: req.url }))
    })
  })
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve))
})

after(async () => {
  await new Promise(resolve => upstream.close(resolve))
  await proxy.stop()
})

test('a logged request can be described, replayed with edits and rendered as curl', async () => {
  const url = `${upstreamBase}/items?x=1`
  const original = await viaProxy(
    'POST',
    url,
    { 'content-type': 'application/json', 'x-custom': 'a' },
    '{"name":"one"}'
  )
  assert.equal(original.status, 200)
  assert.equal(received.length, 1)

  const logged = await findLogByUrl(url)
  assert.ok(logged, 'the request is in the log window')
  assert.equal(logged.replayOf, undefined)

  // The replay form: method, URL, the client's headers and the text body.
  const form = await api('GET', `/api/logs/${encodeURIComponent(logged.id)}/replay`)
  assert.equal(form.status, 200)
  assert.equal(form.json.method, 'POST')
  assert.equal(form.json.url, url)
  assert.equal(form.json.headers['x-custom'], 'a')
  assert.equal(form.json.headers['content-type'], 'application/json')
  assert.equal(form.json.headers.host, undefined)
  assert.equal(form.json.headers['content-length'], undefined)
  assert.equal(form.json.body, '{"name":"one"}')
  assert.equal(form.json.bodyIsText, true)
  assert.equal(form.json.bodyCaptured, true)
  assert.equal(form.json.bodyExpected, true)

  // The export does not carry the kept bytes.
  const exported = await api('GET', '/api/logs/export')
  const exportedEntry = exported.json.items.find(item => String(item.id) === String(logged.id))
  assert.ok(exportedEntry)
  assert.equal(exportedEntry.requestBodyRaw, undefined)

  // A replay with an edited body and header set reaches the upstream and is
  // logged as a new entry that points at the original one.
  const replayed = await api('POST', `/api/logs/${encodeURIComponent(logged.id)}/replay`, {
    body: '{"name":"two"}',
    headers: { 'content-type': 'application/json', 'x-custom': 'b' }
  })
  assert.equal(replayed.status, 200, replayed.body)
  assert.equal(replayed.json.success, true)
  assert.equal(replayed.json.statusCode, 200)
  assert.ok(replayed.json.responseBytes > 0)
  assert.ok(replayed.json.logId, 'the new entry id is returned')

  assert.equal(received.length, 2)
  const second = received[1]
  assert.equal(second.method, 'POST')
  assert.equal(second.url, '/items?x=1')
  assert.equal(second.body, '{"name":"two"}')
  assert.equal(second.headers['x-custom'], 'b')
  assert.equal(second.headers['content-length'], '14')
  assert.equal(second.headers['x-interactive-proxy-replay'], undefined)

  const detail = await api('GET', `/api/logs/${encodeURIComponent(replayed.json.logId)}`)
  assert.equal(detail.status, 200)
  assert.equal(String(detail.json.replayOf), String(logged.id))
  assert.equal(detail.json.headers['x-interactive-proxy-replay'], undefined)
  assert.equal(detail.json.fullUrl, url)

  // The replay form can change the method and the URL and drop the body.
  const changed = await api('POST', `/api/logs/${encodeURIComponent(logged.id)}/replay`, {
    method: 'GET',
    url: `${upstreamBase}/other`,
    body: null
  })
  assert.equal(changed.status, 200, changed.body)
  assert.equal(received.length, 3)
  assert.equal(received[2].method, 'GET')
  assert.equal(received[2].url, '/other')
  assert.equal(received[2].body, '')
  assert.equal(received[2].headers['content-length'], undefined)

  // Invalid edits are rejected before anything is sent.
  for (const invalid of [{ method: 'TRACE' }, { url: 'ftp://x' }, { headers: { 'a b': '1' } }]) {
    const rejected = await api('POST', `/api/logs/${encodeURIComponent(logged.id)}/replay`, invalid)
    assert.equal(rejected.status, 400)
    assert.ok(rejected.json.error)
  }
  assert.equal(received.length, 3)

  // The curl form, direct and through the proxy.
  const curl = await api('GET', `/api/logs/${encodeURIComponent(logged.id)}/curl`)
  assert.equal(curl.status, 200)
  assert.equal(
    curl.json.command,
    [
      `curl -X POST '${url}'`,
      `-H 'content-type: application/json'`,
      `-H 'x-custom: a'`,
      `--data-raw '{"name":"one"}'`
    ].join(' \\\n  ')
  )
  assert.equal(curl.json.bodyEncoding, 'text')

  const viaProxyCurl = await api(
    'GET',
    `/api/logs/${encodeURIComponent(logged.id)}/curl?viaProxy=1`
  )
  assert.ok(viaProxyCurl.json.command.includes(`-x 'http://127.0.0.1:${proxyPort}'`))
})

test('unknown entries answer 404', async () => {
  assert.equal((await api('GET', '/api/logs/missing/replay')).status, 404)
  assert.equal((await api('POST', '/api/logs/missing/replay', {})).status, 404)
  assert.equal((await api('GET', '/api/logs/missing/curl')).status, 404)
})
