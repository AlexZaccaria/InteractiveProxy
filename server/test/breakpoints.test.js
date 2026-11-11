'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { normalizeBreakpointRule, createBreakpointStore } = require('../src/rules/breakpoint-store')
const {
  applyResponseOverrides,
  recordBreakpointOnLog,
  headersForTarget,
  createBreakpointGate
} = require('../src/proxy/breakpoints')
const { ReplayInputError } = require('../src/logs/replay')

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breakpoints-test-'))
  return path.join(dir, 'breakpoints.json')
}

function storeWith(rules) {
  const store = createBreakpointStore({ file: tempFile() })
  store.setRules(rules.map(normalizeBreakpointRule))
  return store
}

function gateWith(rules, options = {}) {
  return createBreakpointGate({
    store: storeWith(rules),
    isEnabled: () => (options.enabled === undefined ? true : options.enabled),
    hasListeners: () => (options.listeners === undefined ? true : options.listeners),
    timeoutMs: options.timeoutMs || 1000
  })
}

const request = () => ({
  method: 'POST',
  url: 'https://api.example.com/items',
  headers: { 'content-type': 'application/json', host: 'api.example.com' },
  body: Buffer.from('{"a":1}')
})

test('normalizeBreakpointRule fills the defaults and the store matches by phase', () => {
  const rule = normalizeBreakpointRule({ url: ' /items ' })
  assert.match(rule.id, /^bp-/)
  assert.equal(rule.enabled, true)
  assert.equal(rule.name, '/items')
  assert.equal(rule.url, '/items')
  assert.equal(rule.phase, 'both')
  assert.equal(normalizeBreakpointRule({ url: 'x', phase: 'RESPONSE' }).phase, 'response')
  assert.equal(normalizeBreakpointRule({ url: 'x', phase: 'nope' }).phase, 'both')

  const store = storeWith([
    { id: 'off', url: '/off', enabled: false },
    { id: 'req', url: '/req', phase: 'request' },
    { id: 'any', url: 'example.com', phase: 'both' }
  ])
  assert.equal(store.match('/off', 'https://example.org/off', 'request'), null)
  assert.equal(store.match('/req', 'https://example.org/req', 'request').id, 'req')
  assert.equal(store.match('/req', 'https://example.org/req', 'response'), null)
  assert.equal(store.match('/x', 'https://example.com/x', 'response').id, 'any')
  assert.equal(store.match('/x', 'https://example.org/x', 'response'), null)
})

test('the store persists its rules and notifies the listeners on save', async () => {
  const file = tempFile()
  const store = createBreakpointStore({ file })
  let notified = 0
  store.onChange(() => {
    notified += 1
  })
  store.setRules([normalizeBreakpointRule({ id: 'a', url: '/a', phase: 'request' })])
  await store.save()
  assert.equal(notified, 1)

  const reloaded = createBreakpointStore({ file })
  reloaded.load()
  assert.deepEqual(reloaded.getRules(), [
    { id: 'a', enabled: true, name: '/a', url: '/a', phase: 'request' }
  ])
})

test('the gate pauses only when enabled and when a UI is listening', () => {
  const context = { requestUrl: '/items', fullUrl: 'https://api.example.com/items' }
  assert.ok(gateWith([{ url: '/items' }]).match('request', context))
  assert.equal(gateWith([{ url: '/items' }], { enabled: false }).match('request', context), null)
  assert.equal(gateWith([{ url: '/items' }], { listeners: false }).match('request', context), null)
  assert.equal(gateWith([{ url: '/other' }]).match('request', context), null)
})

test('a paused request is listed, resumed with edits and reported to the listeners', async () => {
  const gate = gateWith([{ id: 'r1', url: '/items', name: 'Items' }])
  const events = []
  gate.onChange(event => events.push(event))

  const resolution = gate.pause({
    phase: 'request',
    rule: gate.match('request', { requestUrl: '/items', fullUrl: 'https://api.example.com/items' }),
    request: request()
  })

  const [pending] = gate.list()
  assert.equal(gate.pendingCount(), 1)
  assert.equal(pending.phase, 'request')
  assert.deepEqual(pending.rule, { id: 'r1', name: 'Items', url: '/items' })
  assert.equal(pending.method, 'POST')
  assert.equal(pending.url, 'https://api.example.com/items')
  assert.equal(pending.headers['content-type'], 'application/json')
  assert.equal(pending.body, '{"a":1}')
  assert.equal(pending.bodyIsText, true)
  assert.equal(pending.response, null)
  assert.equal(events[0].action, 'paused')
  assert.equal(events[0].item.id, pending.id)

  assert.equal(gate.resume('unknown', {}), false)
  assert.equal(
    gate.resume(pending.id, { method: 'PUT', body: '{"a":2}', headers: { 'x-edit': '1' } }),
    true
  )
  const result = await resolution
  assert.equal(result.action, 'continue')
  assert.equal(result.edited, true)
  assert.equal(result.request.method, 'PUT')
  assert.equal(result.request.body.toString(), '{"a":2}')
  assert.deepEqual(result.request.headers, { 'x-edit': '1' })
  assert.equal(gate.pendingCount(), 0)
  assert.deepEqual(events[1], { action: 'resumed', id: pending.id, reason: 'resume' })
})

test('resuming without changes is not an edit, aborting resolves the abort', async () => {
  const gate = gateWith([{ url: '/items' }])
  const rule = gate.match('request', {
    requestUrl: '/items',
    fullUrl: 'https://api.example.com/items'
  })

  const unchanged = gate.pause({ phase: 'request', rule, request: request() })
  gate.resume(gate.list()[0].id, {})
  const unchangedResult = await unchanged
  assert.equal(unchangedResult.action, 'continue')
  assert.equal(unchangedResult.edited, false)

  const aborted = gate.pause({ phase: 'request', rule, request: request() })
  assert.equal(gate.abort(gate.list()[0].id), true)
  assert.deepEqual(await aborted, { action: 'abort' })
  assert.equal(gate.abort('gone'), false)
})

test('a pause nobody resumes continues unchanged after the timeout', async () => {
  const gate = gateWith([{ url: '/items' }], { timeoutMs: 30 })
  const events = []
  gate.onChange(event => events.push(event))
  const rule = gate.match('request', {
    requestUrl: '/items',
    fullUrl: 'https://api.example.com/items'
  })
  const result = await gate.pause({ phase: 'request', rule, request: request() })
  assert.equal(result.action, 'continue')
  assert.equal(result.edited, false)
  assert.equal(gate.pendingCount(), 0)
  assert.equal(events[1].reason, 'timeout')
})

test('close() resolves every pause as unchanged', async () => {
  const gate = gateWith([{ url: '/items' }])
  const rule = gate.match('request', {
    requestUrl: '/items',
    fullUrl: 'https://api.example.com/items'
  })
  const first = gate.pause({ phase: 'request', rule, request: request() })
  const second = gate.pause({ phase: 'request', rule, request: request() })
  gate.close()
  assert.equal((await first).action, 'continue')
  assert.equal((await second).action, 'continue')
  assert.equal(gate.pendingCount(), 0)
})

test('a paused response shows a decompressed body and sends an edited one uncompressed', async () => {
  const gate = gateWith([{ url: '/items', phase: 'response' }])
  const rule = gate.match('response', {
    requestUrl: '/items',
    fullUrl: 'https://api.example.com/items'
  })
  const compressed = zlib.gzipSync(Buffer.from('{"ok":true}'))

  const resolution = gate.pause({
    phase: 'response',
    rule,
    request: request(),
    response: {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: compressed
    }
  })
  const [pending] = gate.list()
  assert.equal(pending.response.statusCode, 200)
  assert.equal(pending.response.body, '{"ok":true}')
  assert.equal(pending.response.bodyDecoded, true)

  gate.resume(pending.id, { statusCode: 418, body: '{"ok":false}' })
  const result = await resolution
  assert.equal(result.edited, true)
  assert.equal(result.response.statusCode, 418)
  assert.equal(result.response.body.toString(), '{"ok":false}')
  assert.equal(result.response.headers['content-encoding'], undefined)
  assert.equal(result.response.headers['content-type'], 'application/json')
})

test('applyResponseOverrides validates the edits and detects unchanged responses', () => {
  const response = {
    statusCode: 200,
    headers: { 'content-type': 'text/plain', 'content-length': '5' },
    body: Buffer.from('hello')
  }
  const same = applyResponseOverrides(response, {
    statusCode: 200,
    headers: { 'content-type': 'text/plain' },
    body: 'hello'
  })
  assert.equal(same.edited, false)

  const edited = applyResponseOverrides(response, { headers: { 'X-Flag': 'on' } })
  assert.equal(edited.edited, true)
  assert.deepEqual(edited.response.headers, { 'x-flag': 'on' })

  const emptied = applyResponseOverrides(response, { body: null })
  assert.equal(emptied.edited, true)
  assert.equal(emptied.response.body, null)

  const binary = applyResponseOverrides(response, { bodyBase64: 'AAEC' })
  assert.deepEqual([...binary.response.body], [0, 1, 2])

  assert.throws(() => applyResponseOverrides(response, { statusCode: 42 }), ReplayInputError)
  assert.throws(() => applyResponseOverrides(response, { statusCode: 'abc' }), ReplayInputError)
  assert.throws(() => applyResponseOverrides(response, { headers: ['x'] }), ReplayInputError)
  assert.throws(
    () => applyResponseOverrides(response, { headers: { 'a b': '1' } }),
    ReplayInputError
  )
  assert.throws(() => applyResponseOverrides(response, { bodyBase64: '!!' }), ReplayInputError)
})

test('recordBreakpointOnLog keeps the outcome per phase and shows what was sent', () => {
  const entry = { method: 'POST', fullUrl: 'https://a/x', headers: {}, body: null }
  recordBreakpointOnLog(entry, 'request', 'continued')
  assert.deepEqual(entry.breakpoint, { request: 'continued' })

  recordBreakpointOnLog(entry, 'request', 'edited', {
    request: {
      method: 'PUT',
      url: 'https://a/y',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"k":1}')
    }
  })
  assert.equal(entry.method, 'PUT')
  assert.equal(entry.fullUrl, 'https://a/y')
  assert.equal(entry.body, '{"k":1}')
  assert.deepEqual(entry.requestBodyJson, { k: 1 })

  recordBreakpointOnLog(entry, 'response', 'edited', {
    response: {
      statusCode: 201,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('done')
    }
  })
  assert.deepEqual(entry.breakpoint, { request: 'edited', response: 'edited' })
  assert.equal(entry.statusCode, 201)
  assert.equal(entry.responseBody, 'done')
  assert.equal(entry.responseSize, 4)
  assert.equal(entry.responseBodyJson, undefined)

  recordBreakpointOnLog(null, 'request', 'aborted')
})

test('headersForTarget moves the Host header with the URL unless it was edited', () => {
  assert.deepEqual(
    headersForTarget({ host: 'a.test', 'x-y': '1' }, 'https://b.test/x', 'https://a.test/x'),
    { host: 'b.test', 'x-y': '1' }
  )
  assert.deepEqual(
    headersForTarget({ host: 'custom.test' }, 'https://b.test/x', 'https://a.test/x'),
    { host: 'custom.test' }
  )
  assert.deepEqual(headersForTarget({}, 'https://b.test/x', 'https://a.test/x'), {
    host: 'b.test'
  })
  assert.deepEqual(headersForTarget({ host: 'a.test' }, 'not a url', 'https://a.test/x'), {
    host: 'a.test'
  })
})
