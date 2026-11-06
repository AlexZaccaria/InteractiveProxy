'use strict'

/**
 * Helpers for tests that go through the proxy's HTTPS interception: a
 * self-signed certificate for a local TLS upstream, a CONNECT tunnel to the
 * proxy and the TLS handshake over it.
 */

const crypto = require('crypto')
const net = require('net')
const tls = require('tls')
const forge = require('node-forge')

/** Self-signed certificate (native key generation, forge for the X.509 part). */
function createSelfSignedCert (commonName) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' })
  const forgeKey = forge.pki.privateKeyFromPem(keyPem)
  const forgePublic = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }))

  const cert = forge.pki.createCertificate()
  cert.publicKey = forgePublic
  cert.serialNumber = '02'
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600_000)
  const attrs = [{ name: 'commonName', value: commonName }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: commonName }] }
  ])
  cert.sign(forgeKey, forge.md.sha256.create())

  return { key: keyPem, cert: forge.pki.certificateToPem(cert) }
}

/**
 * Open a CONNECT tunnel through the proxy and resolve with the raw socket
 * once the proxy has answered, together with the status line it sent.
 */
function openTunnel (proxyPort, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
    let buffered = ''
    const onData = chunk => {
      buffered += chunk.toString('latin1')
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', onData)
      socket.pause()
      const header = buffered.slice(0, end)
      const rest = Buffer.from(buffered.slice(end + 4), 'latin1')
      if (rest.length) socket.unshift(rest)
      resolve({ socket, statusLine: header.split('\r\n')[0], header })
    }
    socket.on('data', onData)
    socket.on('error', reject)
  })
}

/** TLS handshake with the proxy over an established tunnel (no SNI when `servername` is omitted). */
function secureTunnel (socket, servername) {
  return new Promise((resolve, reject) => {
    socket.resume()
    const options = { socket, rejectUnauthorized: false }
    if (servername) options.servername = servername
    const secure = tls.connect(options, () => resolve(secure))
    secure.on('error', reject)
  })
}

module.exports = { createSelfSignedCert, openTunnel, secureTunnel }
