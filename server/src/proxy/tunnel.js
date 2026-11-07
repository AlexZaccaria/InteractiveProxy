'use strict'

/**
 * Raw tunnels used when a flow is bypassed: a CONNECT tunnel piped byte for
 * byte to the target, and a WebSocket upgrade replayed verbatim on a plain
 * TCP or TLS socket. Nothing is inspected, rewritten or logged here; the
 * callers decide and log.
 */

const net = require('net')
const tls = require('tls')
const { URL } = require('url')

/**
 * Pipe a CONNECT tunnel to the target without decrypting anything: answer
 * `200 Connection Established`, replay the bytes already read after the
 * request head and pipe both directions until either side closes.
 *
 * @param {object} params
 * @param {import('stream').Duplex} params.clientSocket
 * @param {string} params.targetHost
 * @param {number} params.targetPort
 * @param {Buffer} [params.head] Bytes read past the CONNECT request line.
 * @returns {import('net').Socket} The socket to the target.
 */
function createRawTunnel({ clientSocket, targetHost, targetPort, head }) {
  const targetSocket = net.connect(targetPort, targetHost, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length) {
      targetSocket.write(head)
    }
    clientSocket.pipe(targetSocket)
    targetSocket.pipe(clientSocket)
  })

  const closeSockets = () => {
    try {
      clientSocket.destroy()
    } catch {
      /* already destroyed */
    }
    try {
      targetSocket.destroy()
    } catch {
      /* already destroyed */
    }
  }

  targetSocket.on('error', closeSockets)
  clientSocket.on('error', closeSockets)

  clientSocket.on('close', () => {
    try {
      targetSocket.end()
    } catch {
      /* already closed */
    }
  })

  targetSocket.on('close', () => {
    try {
      clientSocket.end()
    } catch {
      /* already closed */
    }
  })

  return targetSocket
}

/**
 * Replay a WebSocket upgrade request verbatim to the target (plain TCP or
 * TLS depending on the target URL scheme) and pipe both sockets, so the
 * handshake and every frame pass through untouched.
 *
 * @param {object} params
 * @param {import('http').IncomingMessage} params.req The upgrade request.
 * @param {import('stream').Duplex} params.clientSocket
 * @param {Buffer} [params.head] Bytes read past the upgrade request head.
 * @param {string} params.targetUrl
 * @param {boolean} params.strictTls Verify the target certificate (false accepts self-signed certificates, the dev default).
 * @param {string | null} params.caBundle Additional CA bundle (PEM) used in strict mode.
 * @returns {void}
 */
function createRawWebSocketTunnel({ req, clientSocket, head, targetUrl, strictTls, caBundle }) {
  let parsed
  try {
    parsed = new URL(targetUrl)
  } catch (error) {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    clientSocket.destroy()
    return
  }

  const isSecure = parsed.protocol === 'https:' || parsed.protocol === 'wss:'
  const port = parsed.port ? Number(parsed.port) : isSecure ? 443 : 80
  const connectHandler = () => {
    const pathWithQuery = (parsed.pathname || '/') + (parsed.search || '')
    const requestLine = `${req.method} ${pathWithQuery || '/'} HTTP/${req.httpVersion}\r\n`
    const headerLines = []
    const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : []
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const name = rawHeaders[i]
      const value = rawHeaders[i + 1]
      if (!name || value === undefined) continue
      headerLines.push(`${name}: ${value}`)
    }

    targetSocket.write(requestLine + headerLines.join('\r\n') + '\r\n\r\n')
    if (head && head.length) {
      targetSocket.write(head)
    }

    clientSocket.pipe(targetSocket)
    targetSocket.pipe(clientSocket)
  }

  const socketOptions = {
    host: parsed.hostname,
    port
  }

  /** @type {import('net').Socket} */
  let targetSocket

  if (isSecure) {
    /** @type {import('tls').ConnectionOptions} */
    const tlsOptions = {
      ...socketOptions,
      servername: parsed.hostname
    }

    if (strictTls) {
      tlsOptions.rejectUnauthorized = true
      if (caBundle) {
        tlsOptions.ca = caBundle
      }
    } else {
      tlsOptions.rejectUnauthorized = false
    }

    targetSocket = tls.connect(tlsOptions, connectHandler)
  } else {
    targetSocket = net.connect(socketOptions, connectHandler)
  }

  const destroyBoth = () => {
    try {
      clientSocket.destroy()
    } catch {
      /* already destroyed */
    }
    try {
      targetSocket.destroy()
    } catch {
      /* already destroyed */
    }
  }

  targetSocket.on('error', () => {
    destroyBoth()
  })

  clientSocket.on('error', () => {
    destroyBoth()
  })

  clientSocket.on('close', () => {
    try {
      targetSocket.end()
    } catch {
      /* already closed */
    }
  })

  targetSocket.on('close', () => {
    try {
      clientSocket.end()
    } catch {
      /* already closed */
    }
  })
}

module.exports = {
  createRawTunnel,
  createRawWebSocketTunnel
}
