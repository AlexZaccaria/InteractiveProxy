'use strict'

/**
 * Loads server/index.js for tests.
 *
 * Storage, certificates and logs are redirected to a fresh temporary
 * directory and the proxy gets a free port of its own, so a test run never
 * touches server/storage or server/certs and never collides with a running
 * proxy. The environment variables are read when server/config.js is first
 * required, so this helper must be the only place that requires the server,
 * and it must be awaited before any other access to it.
 */

const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

let loaded = null

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * @returns {Promise<{
 *   proxy: typeof import('../../index.js'),
 *   port: number,
 *   tmpDir: string,
 *   storageDir: string,
 *   writeStorageFile: (name: string, value: any) => string
 * }>}
 */
async function loadServer() {
  if (loaded) return loaded

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-proxy-test-'))
  const storageDir = path.join(tmpDir, 'storage')
  fs.mkdirSync(storageDir, { recursive: true })

  const port = await getFreePort()

  process.env.PROXY_PORT = String(port)
  process.env.PROXY_HOST = '127.0.0.1'
  process.env.PROXY_STORAGE_DIR = storageDir
  process.env.PROXY_CERTS_DIR = path.join(tmpDir, 'certs')
  process.env.PROXY_LOGS_DIR = path.join(tmpDir, 'logs')
  // Test processes run with stdout piped; keep the console-based log format
  // so tests can capture warnings by replacing console.warn.
  process.env.PROXY_LOG_FORMAT = 'pretty'
  delete process.env.PROXY_UI_ORIGINS

  const proxy = require('../../index.js')

  loaded = {
    proxy,
    port,
    tmpDir,
    storageDir,
    writeStorageFile(name, value) {
      const target = path.join(storageDir, name)
      fs.writeFileSync(target, JSON.stringify(value, null, 2))
      return target
    }
  }

  return loaded
}

module.exports = { loadServer, getFreePort }
