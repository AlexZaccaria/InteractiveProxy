'use strict'

/**
 * The listening HTTP server: every request first goes through the bypass
 * flow (blocked / direct), then to the Express app (management API, bundled
 * UI, proxy catch-all); `upgrade` and `connect` events go to the WebSocket
 * proxy and the MITM handler. `start`/`stop` are used by `node server/index.js`
 * and by the tests.
 */

const http = require('http')

/** @typedef {import('./proxy/http-flow').HttpFlow} HttpFlow */
/** @typedef {import('./proxy/websocket').WebSocketProxy} WebSocketProxy */
/** @typedef {import('./proxy/mitm').MitmHandler} MitmHandler */
/** @typedef {import('./proxy/upstream').Upstream} Upstream */

/**
 * @typedef {object} ProxyServerDeps
 * @property {import('express').Express} app
 * @property {Pick<HttpFlow, 'tryHandleHttpBypass'>} httpFlow
 * @property {Pick<WebSocketProxy, 'handleUpgrade'>} webSocketProxy
 * @property {Pick<MitmHandler, 'handleConnect'>} mitm
 * @property {Pick<Upstream, 'close'>} upstream
 * @property {{ port: number, host: string }} defaults Address used when `start()` gets no options.
 */

/**
 * Build the HTTP server and its lifecycle helpers.
 *
 * @param {ProxyServerDeps} deps
 */
function createProxyServer ({ app, httpFlow, webSocketProxy, mitm, upstream, defaults }) {
  const server = http.createServer((req, res) => {
    httpFlow.tryHandleHttpBypass(req, res)
      .then(handled => {
        if (!handled && !res.writableEnded) {
          app(req, res)
        }
      })
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(500)
        }
        res.end('Internal proxy error')
      })
  })

  server.on('upgrade', (req, socket, head) => {
    webSocketProxy.handleUpgrade(req, socket, head)
  })

  server.on('connect', (req, socket, head) => {
    // Node emits a Duplex, which for TCP connections is a net.Socket.
    mitm.handleConnect(req, /** @type {import('net').Socket} */ (socket), head)
  })

  /**
   * Start listening. `node server/index.js` starts immediately; tests and
   * embedders require the module and call start() themselves.
   *
   * @param {{ port?: number, host?: string }} [options]
   * @returns {Promise<import('net').AddressInfo>}
   */
  function start ({ port = defaults.port, host = defaults.host } = {}) {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        // A TCP listener always reports an AddressInfo (strings are for pipes).
        resolve(/** @type {import('net').AddressInfo} */ (server.address()))
      })
    })
  }

  /**
   * Stop listening and drop open connections (upstream keep-alive sockets of
   * the undici dispatchers are closed too, so a test process can exit).
   *
   * @returns {Promise<void>}
   */
  async function stop () {
    await new Promise(resolve => {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections()
      }
      server.close(() => resolve(undefined))
    })
    await upstream.close()
  }

  return { server, start, stop }
}

module.exports = { createProxyServer }
