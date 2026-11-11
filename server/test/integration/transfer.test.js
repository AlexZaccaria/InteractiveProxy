'use strict'

/**
 * Integration tests of the HAR export and import and of the rules export
 * and import.
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

before(async () => {
  const loaded = await loadServer()
  proxy = loaded.proxy
  proxyPort = loaded.port
  await proxy.start()

  upstreamPort = await getFreePort()
  upstreamBase = `http://127.0.0.1:${upstreamPort}`
  upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
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

test('the log window exports as HAR and a HAR file imports as entries that can be replayed', async () => {
  const url = `${upstreamBase}/items`
  await viaProxy('POST', url, { 'content-type': 'application/json' }, '{"name":"one"}')

  const exported = await api('GET', '/api/logs/export?format=har')
  assert.equal(exported.status, 200)
  assert.equal(exported.json.log.version, '1.2')
  assert.equal(exported.json.log.creator.name, 'Interactive Proxy')
  const entry = exported.json.log.entries.find(item => item.request.url === url)
  assert.ok(entry, 'the proxied request is in the archive')
  assert.equal(entry.request.method, 'POST')
  assert.deepEqual(entry.request.postData, { mimeType: 'application/json', text: '{"name":"one"}' })
  assert.equal(entry.response.status, 200)
  assert.equal(entry.response.content.text, JSON.stringify({ ok: true, path: '/items' }))
  assert.match(entry.comment, /^source=proxied/)

  // Import the archive with the URL changed, so that the entry is told apart.
  const archive = {
    log: {
      version: '1.2',
      entries: [
        {
          ...entry,
          startedDateTime: '2026-01-01T00:00:00.000Z',
          request: { ...entry.request, url: `${upstreamBase}/imported` }
        },
        { request: { method: 'GET', url: 'not a url' }, response: {} }
      ]
    }
  }
  const imported = await api('POST', '/api/logs/import', archive)
  assert.equal(imported.status, 200, imported.body)
  assert.deepEqual(imported.json, { success: true, imported: 1, skipped: 1 })

  const listed = await api('GET', '/api/logs?view=summary&limit=200&sources=imported')
  const logged = listed.json.items.find(item => item.fullUrl === `${upstreamBase}/imported`)
  assert.ok(logged, 'the imported entry is in the window')
  assert.equal(logged.source, 'imported')
  assert.equal(logged.timestamp, '2026-01-01T00:00:00.000Z')
  assert.equal(logged.statusCode, 200)

  const detail = await api('GET', `/api/logs/${encodeURIComponent(logged.id)}`)
  assert.equal(detail.json.body, '{"name":"one"}')
  assert.deepEqual(detail.json.responseBodyJson, { ok: true, path: '/items' })

  const form = await api('GET', `/api/logs/${encodeURIComponent(logged.id)}/replay`)
  assert.equal(form.status, 200)
  assert.equal(form.json.body, '{"name":"one"}')
  assert.equal(form.json.bodyCaptured, true)

  assert.equal((await api('POST', '/api/logs/import', { not: 'har' })).status, 400)
})

test('every rule kind exports to one file and imports back, merged or replaced', async () => {
  await api('POST', '/api/edit-rules', {
    kind: 'text',
    name: 'Text rule',
    url: '/items',
    startVariants: ['one'],
    endVariants: [],
    replacement: 'uno',
    target: 'response'
  })
  await api('POST', '/api/blocked', { action: 'add', url: '/blocked-me', name: 'Blocked' })
  await api('POST', '/api/filters', { action: 'add', url: '/filtered-me', mode: 'ignore' })
  await api('POST', '/api/breakpoints', { action: 'add', url: '/paused-me', phase: 'request' })
  await api('POST', '/api/edit-rule-presets', {
    name: 'Preset',
    kind: 'text',
    rule: { url: '/items', target: 'response' }
  })

  const exported = await api('GET', '/api/rules/export')
  assert.equal(exported.status, 200)
  const file = exported.json
  assert.equal(file.format, 'interactive-proxy-rules')
  assert.equal(file.version, 1)
  assert.equal(file.editRules.length, 1)
  assert.equal(file.presets.length, 1)
  assert.equal(file.blockedRules.length, 1)
  assert.equal(file.filterRules.length, 1)
  assert.equal(file.breakpointRules.length, 1)

  // Merge: a changed record with a known id replaces it, a new one is added.
  const merged = await api('POST', '/api/rules/import', {
    ...file,
    editRules: [{ ...file.editRules[0], name: 'Text rule renamed' }],
    blockedRules: [...file.blockedRules, { id: 'blocked-new', url: '/blocked-two' }],
    breakpointRules: [{ ...file.breakpointRules[0], phase: 'response' }]
  })
  assert.equal(merged.status, 200, merged.body)
  assert.equal(merged.json.mode, 'merge')
  assert.deepEqual(merged.json.counts, {
    editRules: 1,
    presets: 1,
    blockedRules: 2,
    filterRules: 1,
    breakpointRules: 1
  })

  const rules = (await api('GET', '/api/edit-rules')).json.rules
  assert.equal(rules.length, 1)
  assert.equal(rules[0].id, file.editRules[0].id)
  assert.equal(rules[0].name, 'Text rule renamed')
  const blocked = (await api('GET', '/api/blocked')).json
  assert.deepEqual(
    blocked.map(rule => rule.url),
    ['/blocked-me', '/blocked-two']
  )
  const breakpoints = (await api('GET', '/api/breakpoints')).json
  assert.equal(breakpoints.length, 1)
  assert.equal(breakpoints[0].phase, 'response')
  assert.equal((await api('GET', '/api/edit-rule-presets')).json.presets.length, 1)

  // Replace: only the records of the file remain.
  const replaced = await api('POST', '/api/rules/import', {
    format: 'interactive-proxy-rules',
    version: 1,
    mode: 'replace',
    editRules: [],
    presets: [],
    blockedRules: [{ id: 'only', url: '/only' }],
    filterRules: [],
    breakpointRules: []
  })
  assert.equal(replaced.status, 200, replaced.body)
  assert.equal(replaced.json.mode, 'replace')
  assert.deepEqual((await api('GET', '/api/edit-rules')).json.rules, [])
  assert.deepEqual((await api('GET', '/api/edit-rule-presets')).json.presets, [])
  assert.deepEqual(
    (await api('GET', '/api/blocked')).json.map(rule => rule.url),
    ['/only']
  )
  assert.deepEqual((await api('GET', '/api/breakpoints')).json, [])

  assert.equal((await api('POST', '/api/rules/import', { editRules: [] })).status, 400)
  assert.equal(
    (await api('POST', '/api/rules/import', { format: 'interactive-proxy-rules', version: 9 }))
      .status,
    400
  )
})
