'use strict'

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { Readable, PassThrough } = require('stream')
const { STREAM_THRESHOLD_BYTES, STREAM_UNINSPECTED_RESPONSES } = require('../config')
const {
  shouldStreamResponse,
  pipeUpstreamBody,
  STREAMED_BODY_MARKER
} = require('../src/proxy/streaming')

describe('shouldStreamResponse', () => {
  test('defaults: streaming is on and the size threshold is 1 MiB', () => {
    assert.equal(STREAM_UNINSPECTED_RESPONSES, true)
    assert.equal(STREAM_THRESHOLD_BYTES, 1024 * 1024)
    assert.equal(STREAMED_BODY_MARKER, '[streamed response]')
  })

  test('never streams HEAD responses or bodies a rule can rewrite', () => {
    assert.equal(
      shouldStreamResponse({
        method: 'HEAD',
        contentType: 'video/mp4',
        hasRules: false,
        interactive: false
      }),
      false
    )
    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: 'video/mp4',
        hasRules: true,
        interactive: false
      }),
      false
    )
    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: 'text/event-stream',
        hasRules: true,
        interactive: true
      }),
      false
    )
  })

  test('with interactive logging off every uninspected body is streamed', () => {
    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: 'text/html',
        hasRules: false,
        interactive: false
      }),
      true
    )
    assert.equal(
      shouldStreamResponse({
        method: 'POST',
        contentType: 'application/json',
        contentLength: '12',
        hasRules: false,
        interactive: false
      }),
      true
    )
    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: undefined,
        hasRules: false,
        interactive: false
      }),
      true
    )
  })

  test('with interactive logging on only binary, event streams and large bodies are streamed', () => {
    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: 'application/octet-stream',
        hasRules: false,
        interactive: true
      }),
      true
    )
    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: 'image/png',
        hasRules: false,
        interactive: true
      }),
      true
    )
    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: 'text/event-stream; charset=utf-8',
        hasRules: false,
        interactive: true
      }),
      true
    )
    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: 'text/plain',
        contentLength: String(STREAM_THRESHOLD_BYTES + 1),
        hasRules: false,
        interactive: true
      }),
      true
    )
    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: 'application/json',
        contentLength: 5 * 1024 * 1024,
        hasRules: false,
        interactive: true
      }),
      true
    )

    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: 'text/plain',
        contentLength: '12',
        hasRules: false,
        interactive: true
      }),
      false
    )
    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: 'application/json',
        hasRules: false,
        interactive: true
      }),
      false
    )
    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: 'text/plain',
        contentLength: String(STREAM_THRESHOLD_BYTES),
        hasRules: false,
        interactive: true
      }),
      false
    )
    assert.equal(
      shouldStreamResponse({
        method: 'GET',
        contentType: 'image/svg+xml',
        hasRules: false,
        interactive: true
      }),
      false,
      'SVG is text, not a binary type'
    )
  })
})

describe('pipeUpstreamBody', () => {
  test('pipes every chunk, ends the response and counts the bytes', async () => {
    const chunks = [Buffer.from('abc'), Buffer.from('defgh'), Buffer.alloc(1000, 1)]
    const body = Readable.from(chunks)
    const res = new PassThrough()
    const received = []
    res.on('data', chunk => received.push(chunk))

    const result = await pipeUpstreamBody(body, /** @type {any} */ (res))

    assert.equal(result.error, null)
    assert.equal(result.bytes, 1008)
    assert.equal(Buffer.concat(received).length, 1008)
    assert.equal(res.writableEnded, true)
  })

  test('an upstream failure mid-stream destroys the response and is reported', async () => {
    const body = new Readable({
      read() {
        this.push(Buffer.from('partial'))
        this.destroy(new Error('upstream reset'))
      }
    })
    const res = new PassThrough()
    res.on('data', () => {})
    res.on('error', () => {})

    const result = await pipeUpstreamBody(body, /** @type {any} */ (res))

    assert.ok(result.error)
    assert.equal(result.error.message, 'upstream reset')
    assert.equal(res.destroyed, true)
    assert.equal(
      res.writableEnded,
      false,
      'a truncated body is not terminated as if it were complete'
    )
  })
})
