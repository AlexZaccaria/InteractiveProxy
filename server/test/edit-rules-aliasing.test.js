'use strict'

/**
 * A JSONPath rule whose value is an object must not share that object with
 * the bodies it is inserted into: the log views are normalised in place after
 * the forwarded body has been serialised, and that normalisation must never
 * reach the rule's own value (or every later request would see a different
 * value).
 */

const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const { loadServer } = require('./helpers/load-server')

let internals
let writeStorageFile

before(async () => {
  const loaded = await loadServer()
  internals = loaded.proxy.internals
  writeStorageFile = loaded.writeStorageFile
})

test('an object rule value is copied into each body and stays untouched by the log views', () => {
  writeStorageFile('edit-rules.json', [
    {
      id: 'json-object-value',
      enabled: true,
      kind: 'jsonPath',
      name: 'object value with a nested JSON string',
      url: '/alias',
      path: 'root.payload',
      value: { inner: '{"k":1}', label: 'x' },
      valueType: 'json',
      target: 'response'
    }
  ])
  internals.loadEditRules()
  internals.rebuildEditRuleCache()

  const rule = internals.getCompiledJsonPathRules()[0]
  assert.equal(typeof rule.value.inner, 'string')

  const run = () =>
    internals.rewriteJsonHttpBody({
      buffer: Buffer.from('{"payload":null,"other":1}'),
      contentType: 'application/json',
      urlContext: { requestUrl: '/alias', fullUrl: 'http://h.test/alias' },
      phase: 'response',
      captureBeforeJson: true
    })

  const first = run()
  assert.equal(first.changed, true)
  // The forwarded body keeps the nested JSON as a string.
  assert.equal(first.buffer.toString(), '{"payload":{"inner":"{\\"k\\":1}","label":"x"},"other":1}')
  // The log view shows it as an object...
  assert.deepEqual(first.json.payload.inner, { k: 1 })
  // ...and the rule's own value is still a string, so the next request gets
  // the same body as the first.
  assert.equal(typeof rule.value.inner, 'string')
  const second = run()
  assert.equal(second.buffer.toString(), first.buffer.toString())
  assert.notEqual(first.json.payload, rule.value)
})
