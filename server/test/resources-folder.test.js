'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { resolveFolderFile, contentTypeForFile } = require('../src/resources/store')

function makeSite() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-map-'))
  fs.mkdirSync(path.join(root, 'css'))
  fs.mkdirSync(path.join(root, 'docs'))
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>home</h1>')
  fs.writeFileSync(path.join(root, 'css', 'app.css'), 'body{}')
  fs.writeFileSync(path.join(root, 'docs', 'index.html'), '<h1>docs</h1>')
  fs.writeFileSync(path.join(path.dirname(root), 'outside.txt'), 'secret')
  return root
}

test('contentTypeForFile follows the extension', () => {
  assert.equal(contentTypeForFile('a/b.css'), 'text/css; charset=utf-8')
  assert.equal(contentTypeForFile('x.PNG'), 'image/png')
  assert.equal(contentTypeForFile('x.unknown'), 'application/octet-stream')
})

test('resolveFolderFile maps the URL remainder inside the folder', () => {
  const root = makeSite()
  const found = resolveFolderFile(
    root,
    '/static',
    '/static/css/app.css?v=1',
    'http://h/static/css/app.css?v=1'
  )
  assert.equal(found.absolutePath, path.join(root, 'css', 'app.css'))
  assert.equal(found.contentType, 'text/css; charset=utf-8')

  const home = resolveFolderFile(root, 'h/static', '/static', 'http://h/static')
  assert.equal(home.absolutePath, path.join(root, 'index.html'))
  const docs = resolveFolderFile(root, '/static', '/static/docs/', 'http://h/static/docs/')
  assert.equal(docs.absolutePath, path.join(root, 'docs', 'index.html'))

  const encoded = resolveFolderFile(
    root,
    '/static',
    '/static/css%2Fapp.css',
    'http://h/static/css%2Fapp.css'
  )
  assert.equal(encoded.absolutePath, path.join(root, 'css', 'app.css'))

  assert.equal(
    resolveFolderFile(root, '/static', '/static/missing.txt', 'http://h/static/missing.txt'),
    null
  )
  assert.equal(resolveFolderFile(root, '/static', '/static/css', 'http://h/static/css'), null)
})

test('resolveFolderFile never leaves the folder', () => {
  const root = makeSite()
  for (const remainder of ['/../outside.txt', '/%2e%2e/outside.txt', '/css/../../outside.txt']) {
    assert.equal(
      resolveFolderFile(root, '/static', `/static${remainder}`, `http://h/static${remainder}`),
      null,
      remainder
    )
  }
  assert.equal(resolveFolderFile(root, '/static', '/static/%zz', 'http://h/static/%zz'), null)
  assert.equal(resolveFolderFile(root, '/static', '/other', 'http://h/other'), null)
})
