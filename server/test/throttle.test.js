'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PassThrough } = require('stream')
const { normalizeThrottleRule, createThrottleStore } = require('../src/rules/throttle-store')
const {
  kbpsToBytesPerSecond,
  createThrottleTransform,
  createNetworkConditions
} = require('../src/proxy/throttle')

function storeWith(rules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-test-'))
  const store = createThrottleStore({ file: path.join(dir, 'throttle-rules.json') })
  store.setRules(rules.map(normalizeThrottleRule))
  return store
}

test('normalizeThrottleRule fills the defaults and bounds the numbers', () => {
  const rule = normalizeThrottleRule({ url: ' /slow ', delayMs: '250.4', throttleKbps: 64 })
  assert.match(rule.id, /^net-/)
  assert.equal(rule.enabled, true)
  assert.equal(rule.name, '/slow')
  assert.equal(rule.url, '/slow')
  assert.equal(rule.delayMs, 250)
  assert.equal(rule.throttleKbps, 64)
  assert.equal(normalizeThrottleRule({ url: 'x', delayMs: -5 }).delayMs, 0)
  assert.equal(normalizeThrottleRule({ url: 'x', delayMs: 'abc' }).delayMs, 0)
  assert.equal(normalizeThrottleRule({ url: 'x', delayMs: 10_000_000 }).delayMs, 600_000)
  assert.equal(normalizeThrottleRule({ url: 'x' }).throttleKbps, 0)
})

test('the store matches the first enabled rule that does something', () => {
  const store = storeWith([
    { id: 'off', url: '/a', enabled: false, delayMs: 100 },
    { id: 'idle', url: '/a' },
    { id: 'slow', url: '/a', delayMs: 100 },
    { id: 'cap', url: 'example.com', throttleKbps: 8 }
  ])
  assert.equal(store.match('/a', 'https://example.org/a').id, 'slow')
  assert.equal(store.match('/b', 'https://example.com/b').id, 'cap')
  assert.equal(store.match('/b', 'https://example.org/b'), null)
})

test('the matcher honours the flag and converts the cap to bytes per second', () => {
  const store = storeWith([{ id: 'r', url: '/a', name: 'Slow', delayMs: 100, throttleKbps: 64 }])
  const on = createNetworkConditions({ store, isEnabled: () => true })
  const conditions = on.match({ requestUrl: '/a', fullUrl: 'https://x/a' })
  assert.deepEqual(conditions, {
    delayMs: 100,
    throttleKbps: 64,
    bytesPerSecond: 8000,
    summary: { ruleId: 'r', ruleName: 'Slow', delayMs: 100, throttleKbps: 64 }
  })
  const off = createNetworkConditions({ store, isEnabled: () => false })
  assert.equal(off.match({ requestUrl: '/a', fullUrl: 'https://x/a' }), null)
  assert.equal(kbpsToBytesPerSecond(0), 0)
  assert.equal(kbpsToBytesPerSecond(1), 125)
})

test('the throttle transform paces the bytes and keeps them intact', async () => {
  // 4000 bytes at 8000 B/s: about half a second.
  const input = Buffer.alloc(4000, 7)
  const throttle = createThrottleTransform(8000)
  const sink = new PassThrough()
  const chunks = []
  sink.on('data', chunk => chunks.push(chunk))
  const started = Date.now()
  const done = new Promise(resolve => sink.on('end', resolve))
  throttle.pipe(sink)
  throttle.end(input)
  await done
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 400, `took ${elapsed} ms`)
  assert.ok(elapsed < 1500, `took ${elapsed} ms`)
  assert.equal(Buffer.concat(chunks).equals(input), true)
  assert.ok(chunks.length >= 9, `${chunks.length} slices`)
})
