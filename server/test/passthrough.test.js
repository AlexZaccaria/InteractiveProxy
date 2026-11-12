'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  normalizeHost,
  normalizePassthroughRule,
  createPassthroughStore
} = require('../src/rules/passthrough-store')

test('normalizeHost keeps a bare lower-case host name', () => {
  assert.equal(normalizeHost(' API.Example.com '), 'api.example.com')
  assert.equal(normalizeHost('https://api.example.com/path'), 'api.example.com')
  assert.equal(normalizeHost('*.example.com'), 'example.com')
  assert.equal(normalizeHost('.example.com'), 'example.com')
  assert.equal(normalizeHost('example.com:8443'), 'example.com')
  assert.equal(normalizeHost('[::1]:443'), '[::1]')
  assert.equal(normalizeHost(''), '')
})

test('the store matches a host and its subdomains, persists and reloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passthrough-test-'))
  const file = path.join(dir, 'passthrough.json')
  const store = createPassthroughStore({ file })
  store.setRules([
    normalizePassthroughRule({ id: 'off', host: 'off.test', enabled: false }),
    normalizePassthroughRule({ id: 'bank', host: 'Bank.example', name: 'Bank' })
  ])
  assert.equal(store.match('bank.example').id, 'bank')
  assert.equal(store.match('API.bank.example').id, 'bank')
  assert.equal(store.match('notbank.example'), null)
  assert.equal(store.match('off.test'), null)
  assert.equal(store.match(''), null)

  await store.save()
  const reloaded = createPassthroughStore({ file })
  reloaded.load()
  assert.deepEqual(reloaded.getRules(), [
    { id: 'off', enabled: false, name: 'off.test', host: 'off.test' },
    { id: 'bank', enabled: true, name: 'Bank', host: 'bank.example' }
  ])
})
