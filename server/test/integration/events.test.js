'use strict'

/**
 * Integration tests of the event stream (`GET /api/events`): the proxy is
 * started on a free port with a local HTTP echo upstream, streams are opened
 * with plain `http.request` and parsed in the test.
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { loadServer, getFreePort } = require('../helpers/load-server')

const KEEP_ALIVE_MS = 100

// Required only after loadServer(): the events module pulls in config.js,
// which reads the port and directories from the environment at first load.
/** @type {typeof import('../../src/api/events')} */
let events

/** @type {import('http').Server} */
let upstream
/** @type {number} */
let upstreamPort
/** @type {number} */
let proxyPort
/** @type {Awaited<ReturnType<typeof loadServer>>['proxy']} */
let proxy
/** @type {Set<{ close: () => void }>} */
const openStreams = new Set()

/** A response large enough to be streamed instead of previewed (above the 1 MiB threshold). */
const BIG_BINARY = Buffer.alloc(3 * 1024 * 1024, 0xab)

function startUpstream() {
  return new Promise((resolve, reject) => {
    upstream = http.createServer((req, res) => {
      if (req.url === '/big.bin') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': BIG_BINARY.length
        })
        res.end(BIG_BINARY)
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, url: req.url, method: req.method }))
    })
    upstream.once('error', reject)
    upstream.listen(upstreamPort, '127.0.0.1', () => resolve(undefined))
  })
}

/**
 * JSON request against the proxy (management API or proxy-style forwarding).
 *
 * @param {{ method?: string, path: string, body?: unknown, headers?: Record<string, string> }} options
 * @returns {Promise<{ status: number, headers: import('http').IncomingHttpHeaders, body: string, json: any }>}
 */
function request({ method = 'GET', path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method,
        path,
        headers: {
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
          ...headers
        }
      },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode || 0, headers: res.headers, body: text, json })
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * Open an SSE stream and parse it. `next(name, predicate)` must be called
 * before the action that triggers the event: it resolves with the first
 * matching event received from that moment on.
 *
 * @param {Record<string, string>} [headers]
 */
function openStream(headers = {}) {
  /** @type {{ id: number | null, name: string, data: any }[]} */
  const received = []
  /** @type {string[]} */
  const comments = []
  /** @type {{ from: number, name: string, predicate: (data: any, event: any) => boolean, resolve: (event: any) => void }[]} */
  const waiters = []
  let buffer = ''
  // Events before this index were already handed to a `next()` caller; a
  // later `next()` still sees the ones nobody asked for (e.g. `hello`, which
  // may arrive together with the headers, before the caller registers).
  let cursor = 0

  /**
   * @param {{ from: number, name: string, predicate: (data: any, event: any) => boolean, resolve: (event: any) => void }} waiter
   * @returns {boolean}
   */
  const tryResolve = waiter => {
    for (let i = waiter.from; i < received.length; i++) {
      const event = received[i]
      if (event.name === waiter.name && waiter.predicate(event.data, event)) {
        cursor = Math.max(cursor, i + 1)
        waiter.resolve(event)
        return true
      }
    }
    return false
  }

  const flushWaiters = () => {
    for (const waiter of Array.from(waiters)) {
      if (tryResolve(waiter)) {
        waiters.splice(waiters.indexOf(waiter), 1)
      }
    }
  }

  /** @param {string} block */
  const parseBlock = block => {
    let id = null
    let name = 'message'
    const dataLines = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        comments.push(line)
        continue
      }
      const sep = line.indexOf(':')
      const field = sep === -1 ? line : line.slice(0, sep)
      const value = sep === -1 ? '' : line.slice(sep + 1).replace(/^ /, '')
      if (field === 'id') id = Number(value)
      else if (field === 'event') name = value
      else if (field === 'data') dataLines.push(value)
    }
    if (dataLines.length === 0) return
    received.push({ id, name, data: JSON.parse(dataLines.join('\n')) })
    flushWaiters()
  }

  let closedOnPurpose = false

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: '/api/events',
        headers: { accept: 'text/event-stream', ...headers }
      },
      res => {
        res.setEncoding('utf8')
        res.on('data', chunk => {
          buffer += chunk
          let index
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            parseBlock(block)
          }
        })
        const stream = {
          response: res,
          received,
          comments,
          /**
           * @param {string} name
           * @param {(data: any, event: any) => boolean} [predicate]
           * @param {number} [timeoutMs]
           */
          next(name, predicate = () => true, timeoutMs = 3000) {
            return new Promise((resolveNext, rejectNext) => {
              const timer = setTimeout(() => {
                const idx = waiters.findIndex(w => w.resolve === resolver)
                if (idx !== -1) waiters.splice(idx, 1)
                rejectNext(new Error(`Timed out waiting for "${name}" event`))
              }, timeoutMs)
              /** @param {any} event */
              const resolver = event => {
                clearTimeout(timer)
                resolveNext(event)
              }
              const waiter = { from: cursor, name, predicate, resolve: resolver }
              if (!tryResolve(waiter)) waiters.push(waiter)
            })
          },
          /** @param {number} [timeoutMs] */
          nextComment(timeoutMs = 2000) {
            const from = comments.length
            return new Promise((resolveComment, rejectComment) => {
              const started = Date.now()
              const poll = () => {
                if (comments.length > from) return resolveComment(comments[from])
                if (Date.now() - started > timeoutMs)
                  return rejectComment(new Error('Timed out waiting for a keep-alive comment'))
                setTimeout(poll, 10)
              }
              poll()
            })
          },
          close() {
            closedOnPurpose = true
            openStreams.delete(stream)
            req.destroy()
          }
        }
        openStreams.add(stream)
        resolve(stream)
      }
    )
    req.on('error', error => {
      // A destroyed request reports an error on some Node versions; ignore
      // once the stream was closed on purpose.
      if (closedOnPurpose) return
      reject(error)
    })
    req.end()
  })
}

describe('GET /api/events', () => {
  before(async () => {
    const loaded = await loadServer()
    proxy = loaded.proxy
    proxyPort = loaded.port
    events = require('../../src/api/events')
    upstreamPort = await getFreePort()
    await startUpstream()
    // Short keep-alive so the ping test does not wait 15 s.
    events.setDefaultKeepAliveMs(KEEP_ALIVE_MS)
    await proxy.start()
  })

  after(async () => {
    for (const stream of Array.from(openStreams)) stream.close()
    await new Promise(resolve => upstream.close(() => resolve(undefined)))
    const stopped = await Promise.race([
      proxy.stop().then(() => 'stopped'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
    ])
    assert.equal(stopped, 'stopped', 'stop() must resolve even with streams that were open')
  })

  it('answers with an event stream, the CORS header for a UI origin and a hello event', async () => {
    const stream = await openStream({ origin: `http://localhost:${proxyPort}` })
    assert.equal(stream.response.statusCode, 200)
    assert.match(String(stream.response.headers['content-type']), /^text\/event-stream/)
    assert.equal(stream.response.headers['cache-control'], 'no-cache, no-transform')
    assert.equal(stream.response.headers['x-accel-buffering'], 'no')
    assert.equal(
      stream.response.headers['access-control-allow-origin'],
      `http://localhost:${proxyPort}`
    )

    const hello = await stream.next('hello')
    assert.equal(hello.id, null)
    assert.equal(hello.data.interactiveModeEnabled, true)
    assert.match(hello.data.serverTime, /^\d{4}-\d{2}-\d{2}T/)
    stream.close()
  })

  it('sends a keep-alive comment line', async () => {
    const stream = await openStream()
    await stream.next('hello')
    const comment = await stream.nextComment()
    assert.equal(comment, ': ping')
    stream.close()
  })

  it('publishes a log event for a proxied request, then a coalesced stats event', async () => {
    const stream = await openStream()
    await stream.next('hello')

    const logEvent = stream.next('log')
    const statsEvent = stream.next('stats')
    const target = `http://127.0.0.1:${upstreamPort}/hello?via=events`
    const response = await request({ path: target })
    assert.equal(response.status, 200)

    const log = await logEvent
    assert.ok(typeof log.id === 'number' && log.id > 0)
    assert.equal(log.data.method, 'GET')
    assert.equal(log.data.fullUrl, target)
    assert.ok(log.data.id !== undefined && log.data.id !== null)
    assert.equal(log.data.source, 'proxied')

    const stats = await statsEvent
    assert.ok(stats.id > log.id, 'stats follows the log event')
    assert.ok(stats.data.stats.total >= 1)
    assert.ok(stats.data.stats.proxied >= 1)
    assert.equal(typeof stats.data.filterMetrics.totalFiltered, 'number')
    assert.equal(typeof stats.data.editedRequests, 'number')
    assert.ok(stats.data.performance && stats.data.payloads && stats.data.routes)
    stream.close()
  })

  it('reports the size of a streamed response in a stats event once the transfer ends', async () => {
    const stream = await openStream()
    await stream.next('hello')

    // The log event of a streamed entry arrives before the body has been
    // piped; the stats event that carries its size follows the transfer.
    const sized = stream.next(
      'stats',
      data => data.payloads.responseBytes.max >= BIG_BINARY.length,
      5000
    )
    const response = await request({ path: `http://127.0.0.1:${upstreamPort}/big.bin` })
    assert.equal(response.status, 200)
    assert.equal(Buffer.byteLength(response.body, 'utf8') > 0, true)

    const stats = await sized
    assert.ok(stats.data.payloads.responseBytes.max >= BIG_BINARY.length)
    stream.close()
  })

  it('coalesces stats events while several requests arrive at once', async () => {
    const stream = await openStream()
    await stream.next('hello')

    const firstStats = stream.next('stats')
    const burst = 5
    await Promise.all(
      Array.from({ length: burst }, (_, i) =>
        request({ path: `http://127.0.0.1:${upstreamPort}/burst/${i}` })
      )
    )
    const stats = await firstStats
    // Every request produced a log event, but the burst produced a single
    // stats event (trailing timer) within the coalescing window.
    const logsAfter = stream.received.filter(e => e.name === 'log').length
    assert.ok(logsAfter >= burst)
    await new Promise(resolve => setTimeout(resolve, events.DEFAULT_STATS_COALESCE_MS * 2))
    const statsEvents = stream.received.filter(e => e.name === 'stats')
    assert.equal(statsEvents.length, 1)
    assert.ok(stats.data.stats.total >= burst)
    stream.close()
  })

  it('publishes a config event when a flag or the filter mode changes', async () => {
    const stream = await openStream()
    await stream.next('hello')

    const offEvent = stream.next('config', data => data.interactiveModeEnabled === false)
    const off = await request({
      method: 'POST',
      path: '/api/interactive-mode',
      body: { enabled: false }
    })
    assert.equal(off.status, 200)
    const offConfig = await offEvent
    assert.equal(offConfig.data.interactiveModeEnabled, false)
    assert.equal(typeof offConfig.data.editRulesEnabled, 'boolean')

    const onEvent = stream.next('config', data => data.interactiveModeEnabled === true)
    await request({ method: 'POST', path: '/api/interactive-mode', body: { enabled: true } })
    await onEvent

    const modeEvent = stream.next('config', data => data.filterMode === 'focus')
    await request({ method: 'POST', path: '/api/filter-mode', body: { mode: 'focus' } })
    assert.equal((await modeEvent).data.filterMode, 'focus')
    const backEvent = stream.next('config', data => data.filterMode === 'ignore')
    await request({ method: 'POST', path: '/api/filter-mode', body: { mode: 'ignore' } })
    await backEvent

    const editEvent = stream.next('config', data => data.editRulesEnabled === false)
    await request({ method: 'POST', path: '/api/edit-rules-mode', body: { enabled: false } })
    assert.equal((await editEvent).data.editRulesEnabled, false)
    const editBack = stream.next('config', data => data.editRulesEnabled === true)
    await request({ method: 'POST', path: '/api/edit-rules-mode', body: { enabled: true } })
    await editBack
    stream.close()
  })

  it('publishes rules events for blocked, filter, edit rules and local resources', async () => {
    const stream = await openStream()
    await stream.next('hello')

    const blockedEvent = stream.next('rules', data => data.kind === 'blocked')
    const added = await request({
      method: 'POST',
      path: '/api/blocked',
      body: { action: 'add', url: 'https://events.test/blocked' }
    })
    assert.equal(added.status, 200)
    assert.deepEqual((await blockedEvent).data, { kind: 'blocked' })
    const blockedRule = added.json.blockedRules.find(
      rule => rule.url === 'https://events.test/blocked'
    )
    const blockedRemoved = stream.next('rules', data => data.kind === 'blocked')
    await request({
      method: 'POST',
      path: '/api/blocked',
      body: { action: 'remove', id: blockedRule.id }
    })
    await blockedRemoved

    const filterEvent = stream.next('rules', data => data.kind === 'filter')
    const filterAdded = await request({
      method: 'POST',
      path: '/api/filters',
      body: { action: 'add', url: 'https://events.test/filtered' }
    })
    assert.equal(filterAdded.status, 200)
    assert.deepEqual((await filterEvent).data, { kind: 'filter' })
    const filterRules =
      filterAdded.json.filterRules || filterAdded.json.bypassRules || filterAdded.json.rules || []
    const filterRule = filterRules.find(rule => rule.url === 'https://events.test/filtered')
    if (filterRule) {
      const filterRemoved = stream.next('rules', data => data.kind === 'filter')
      await request({
        method: 'POST',
        path: '/api/filters',
        body: { action: 'remove', id: filterRule.id }
      })
      await filterRemoved
    }

    const editEvent = stream.next('rules', data => data.kind === 'edit')
    const created = await request({
      method: 'POST',
      path: '/api/edit-rules',
      body: { kind: 'text', name: 'events', startVariants: ['alpha'], replacement: 'beta' }
    })
    assert.equal(created.status, 201)
    assert.deepEqual((await editEvent).data, { kind: 'edit' })
    const ruleId = created.json.rule.id
    const editRemoved = stream.next('rules', data => data.kind === 'edit')
    await request({ method: 'DELETE', path: `/api/edit-rules/${encodeURIComponent(ruleId)}` })
    await editRemoved

    const resourceEvent = stream.next('rules', data => data.kind === 'resources')
    const resource = await request({
      method: 'POST',
      path: '/api/resources',
      body: { url: '/events/resource', contentType: 'text/plain', content: 'hello' }
    })
    assert.equal(resource.status, 200)
    assert.deepEqual((await resourceEvent).data, { kind: 'resources' })
    const resourceRemoved = stream.next('rules', data => data.kind === 'resources')
    await request({
      method: 'DELETE',
      path: `/api/resources/${encodeURIComponent('/events/resource')}`
    })
    await resourceRemoved
    stream.close()
  })

  it('publishes logs-cleared and a zeroed stats event after DELETE /api/logs', async () => {
    const stream = await openStream()
    await stream.next('hello')

    const logged = stream.next('log')
    await request({ path: `http://127.0.0.1:${upstreamPort}/before-clear` })
    await logged

    const cleared = stream.next('logs-cleared')
    const zeroed = stream.next('stats', data => data.stats.total === 0)
    const response = await request({ method: 'DELETE', path: '/api/logs' })
    assert.equal(response.status, 200)
    await cleared
    const stats = await zeroed
    assert.equal(stats.data.stats.total, 0)
    assert.equal(stats.data.filterMetrics.totalFiltered, 0)
    stream.close()
  })

  it('delivers the same event ids to every open stream', async () => {
    const first = await openStream()
    const second = await openStream()
    await first.next('hello')
    await second.next('hello')

    const onFirst = first.next('config', data => data.localResourcesEnabled === false)
    const onSecond = second.next('config', data => data.localResourcesEnabled === false)
    await request({ method: 'POST', path: '/api/local-resources-mode', body: { enabled: false } })
    const [a, b] = await Promise.all([onFirst, onSecond])
    assert.equal(a.id, b.id)
    assert.deepEqual(a.data, b.data)

    const backFirst = first.next('config', data => data.localResourcesEnabled === true)
    await request({ method: 'POST', path: '/api/local-resources-mode', body: { enabled: true } })
    await backFirst
    first.close()
    second.close()
  })

  it('keeps serving the other streams after a client aborts', async () => {
    const aborting = await openStream()
    const survivor = await openStream()
    await aborting.next('hello')
    await survivor.next('hello')

    aborting.close()
    // Give the server a tick to observe the closed socket.
    await new Promise(resolve => setTimeout(resolve, 50))

    const configEvent = survivor.next('config', data => data.blockedRulesEnabled === false)
    await request({ method: 'POST', path: '/api/blocked-rules-mode', body: { enabled: false } })
    await configEvent
    const back = survivor.next('config', data => data.blockedRulesEnabled === true)
    await request({ method: 'POST', path: '/api/blocked-rules-mode', body: { enabled: true } })
    await back
    survivor.close()
  })
})

describe('event helpers', () => {
  before(async () => {
    await loadServer()
    events = require('../../src/api/events')
  })

  it('formatEvent writes id, event and data lines; the id line is optional', () => {
    assert.equal(
      events.formatEvent({ id: 7, name: 'config', data: { a: 1 } }),
      'id: 7\nevent: config\ndata: {"a":1}\n\n'
    )
    assert.equal(events.formatEvent({ name: 'hello', data: null }), 'event: hello\ndata: null\n\n')
  })

  it('createEventBus numbers events monotonically and fans them out', () => {
    const bus = events.createEventBus()
    const seen = []
    const unsubscribe = bus.subscribe(event => seen.push(event))
    const first = bus.publish('a', 1)
    const second = bus.publish('b', 2)
    unsubscribe()
    bus.publish('c', 3)
    assert.equal(first.id, 1)
    assert.equal(second.id, 2)
    assert.deepEqual(
      seen.map(e => e.name),
      ['a', 'b']
    )
  })
})
