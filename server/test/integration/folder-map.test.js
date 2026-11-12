'use strict'

/**
 * Integration tests of the folder mapping of local resources.
 */

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { loadServer, getFreePort } = require('../helpers/load-server')

let proxy
let proxyPort
let upstream
let upstreamPort
let upstreamBase
let site

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

function viaProxy(url) {
  return request({ method: 'GET', path: url, headers: { host: new URL(url).host } })
}

before(async () => {
  const loaded = await loadServer()
  proxy = loaded.proxy
  proxyPort = loaded.port
  await proxy.start()

  upstreamPort = await getFreePort()
  upstreamBase = `http://127.0.0.1:${upstreamPort}`
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ upstream: true, path: req.url }))
  })
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve))

  site = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-map-site-'))
  fs.mkdirSync(path.join(site, 'css'))
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>home</h1>')
  fs.writeFileSync(path.join(site, 'css', 'app.css'), 'body{color:red}')
})

after(async () => {
  await new Promise(resolve => upstream.close(resolve))
  await proxy.stop()
})

test('a mapped folder serves its files by path, answers misses and can fall through', async () => {
  const missing = await api('POST', '/api/resources', {
    url: '/static',
    folderPath: path.join(site, 'nope')
  })
  assert.equal(missing.status, 400)

  const created = await api('POST', '/api/resources', {
    url: '/static',
    folderPath: site,
    fallthrough: false
  })
  assert.equal(created.status, 200, created.body)
  assert.equal(created.json.resource.type, 'folder')
  assert.equal(created.json.resource.path, path.resolve(site))

  const listed = await api('GET', '/api/resources')
  assert.equal(listed.json[0].type, 'folder')
  assert.equal(listed.json[0].fallthrough, false)

  const css = await viaProxy(`${upstreamBase}/static/css/app.css?v=2`)
  assert.equal(css.status, 200)
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8')
  assert.equal(css.headers['x-proxy-source'], 'local')
  assert.equal(css.body, 'body{color:red}')

  const home = await viaProxy(`${upstreamBase}/static/`)
  assert.equal(home.status, 200)
  assert.equal(home.body, '<h1>home</h1>')

  const miss = await viaProxy(`${upstreamBase}/static/missing.txt`)
  assert.equal(miss.status, 404)
  assert.deepEqual(JSON.parse(miss.body), { error: 'Not found in the mapped folder' })

  const escape = await viaProxy(`${upstreamBase}/static/../index.html`)
  assert.equal(escape.status, 404)

  const logs = await api('GET', '/api/logs?view=summary&limit=200')
  const served = logs.json.items.find(
    item => item.fullUrl === `${upstreamBase}/static/css/app.css?v=2`
  )
  assert.equal(served.source, 'local')
  assert.equal(served.localResource, '/static')
  assert.equal(served.statusCode, 200)
  const missed = logs.json.items.find(item => item.fullUrl === `${upstreamBase}/static/missing.txt`)
  assert.equal(missed.statusCode, 404)

  // With fallthrough the miss goes to the upstream.
  const updated = await api('POST', '/api/resources', {
    url: '/static',
    folderPath: site,
    fallthrough: true
  })
  assert.equal(updated.status, 200)
  const forwarded = await viaProxy(`${upstreamBase}/static/missing.txt`)
  assert.equal(forwarded.status, 200)
  assert.deepEqual(JSON.parse(forwarded.body), { upstream: true, path: '/static/missing.txt' })

  const removed = await api('DELETE', `/api/resources/${encodeURIComponent('/static')}`)
  assert.equal(removed.status, 200)
  assert.deepEqual((await api('GET', '/api/resources')).json, [])
  assert.ok(fs.existsSync(path.join(site, 'index.html')), 'the mapped files are left alone')
})
