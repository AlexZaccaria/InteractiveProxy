'use strict'

const { test, before, describe } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const forge = require('node-forge')
const { loadServer } = require('./helpers/load-server')
const { createLruCache } = require('../src/util/lru')

let ca
let certsDir

before(async () => {
  const { proxy } = await loadServer()
  certsDir = proxy.config.CERTS_DIR
  ca = require('../src/tls/ca')
})

/** DER SubjectPublicKeyInfo of a certificate PEM. */
const spkiDer = pem =>
  new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })

/** A certificate for `hostname` carrying a fresh key, signed by the CA. */
function certWithForeignKey(hostname, material) {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }))
  cert.serialNumber = '0a'
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600_000)
  cert.setSubject([{ name: 'commonName', value: hostname }])
  cert.setIssuer(material.cert.subject.attributes)
  cert.sign(material.key, forge.md.sha256.create())
  return forge.pki.certificateToPem(cert)
}

describe('CA', () => {
  test('is created on first use with a native key and reloaded from its files afterwards', () => {
    assert.equal(certsDir, path.dirname(ca.CA_CERT_PATH))
    assert.equal(fs.existsSync(ca.CA_CERT_PATH), false, 'no CA before the first use')

    const material = ca.getCA()

    assert.equal(fs.existsSync(ca.CA_CERT_PATH), true)
    assert.equal(fs.existsSync(ca.CA_KEY_PATH), true)
    assert.equal(material.cert.subject.getField('CN').value, 'Cascade Proxy CA')
    assert.equal(new crypto.X509Certificate(material.certPem).ca, true)
    assert.match(fs.readFileSync(ca.CA_KEY_PATH, 'utf8'), /^-----BEGIN RSA PRIVATE KEY-----/)
    assert.equal(crypto.createPrivateKey(material.keyPem).asymmetricKeyDetails.modulusLength, 2048)

    const reloaded = ca.getOrCreateCA()
    assert.equal(reloaded.certPem, material.certPem)
    assert.equal(reloaded.keyPem, material.keyPem)
    assert.equal(ca.getCA(), material, 'getCA keeps the loaded material')
  })
})

describe('host certificates', () => {
  test('share one leaf key, written with the first certificate', () => {
    assert.equal(fs.existsSync(ca.LEAF_KEY_PATH), false, 'no leaf key before the first host')
    const material = ca.getCA()

    const alpha = ca.generateCertForHost('alpha.test', material)
    assert.equal(fs.existsSync(ca.LEAF_KEY_PATH), true)
    assert.equal(alpha.key, fs.readFileSync(ca.LEAF_KEY_PATH, 'utf8'))

    const beta = ca.generateCertForHost('beta.test', material)
    assert.equal(beta.key, alpha.key)
    assert.ok(
      spkiDer(alpha.cert).equals(spkiDer(beta.cert)),
      'same public key in both certificates'
    )

    const caCert = new crypto.X509Certificate(material.certPem)
    const xa = new crypto.X509Certificate(alpha.cert)
    const xb = new crypto.X509Certificate(beta.cert)
    assert.match(xa.subject, /CN=alpha\.test/)
    assert.match(xb.subject, /CN=beta\.test/)
    assert.equal(xa.subjectAltName, 'DNS:alpha.test, DNS:*.alpha.test')
    assert.equal(xa.checkIssued(caCert), true)
    assert.equal(xa.verify(caCert.publicKey), true)
    assert.notEqual(xa.fingerprint256, xb.fingerprint256)
    assert.equal(xa.ca, false)
  })

  test('get a random positive serial number each', () => {
    const material = ca.getCA()
    const serials = ['s1.test', 's2.test', 's3.test'].map(host => {
      const serial = new crypto.X509Certificate(ca.generateCertForHost(host, material).cert)
        .serialNumber
      assert.match(serial, /^[0-9A-F]{1,32}$/)
      assert.ok(
        BigInt(`0x${serial}`) > 0n && BigInt(`0x${serial}`) < 2n ** 127n,
        'positive 128-bit integer'
      )
      return serial
    })
    assert.equal(new Set(serials).size, 3)
  })

  test('are persisted under hosts/ and reloaded instead of reissued', () => {
    const material = ca.getCA()
    const first = ca.generateCertForHost('persist.test', material)
    const file = ca.hostCertPath('persist.test')
    assert.equal(file, path.join(ca.HOST_CERTS_DIR, 'persist.test.pem'))
    assert.equal(path.dirname(ca.HOST_CERTS_DIR), certsDir)
    assert.equal(fs.readFileSync(file, 'utf8'), first.cert)
    const stat = fs.statSync(file)

    ca.clearCache()
    const again = ca.generateCertForHost('persist.test', material)
    assert.equal(again.cert, first.cert)
    assert.equal(again.key, first.key)
    const statAfter = fs.statSync(file)
    assert.equal(statAfter.mtimeMs, stat.mtimeMs, 'the file was not rewritten')
    assert.equal(statAfter.size, stat.size)

    // The leaf key too came back from disk: a regenerated key would differ.
    const later = ca.generateCertForHost('after-clear.test', material)
    assert.ok(spkiDer(later.cert).equals(spkiDer(first.cert)))
  })

  test('are reissued when the persisted file is corrupt or carries another key', () => {
    const material = ca.getCA()

    const corruptFile = ca.hostCertPath('corrupt.test')
    fs.mkdirSync(path.dirname(corruptFile), { recursive: true })
    fs.writeFileSync(corruptFile, 'not a certificate')
    const reissued = ca.generateCertForHost('corrupt.test', material)
    assert.match(reissued.cert, /^-----BEGIN CERTIFICATE-----/)
    assert.equal(fs.readFileSync(corruptFile, 'utf8'), reissued.cert)

    const foreignPem = certWithForeignKey('foreign.test', material)
    fs.writeFileSync(ca.hostCertPath('foreign.test'), foreignPem)
    ca.clearCache()
    const replaced = ca.generateCertForHost('foreign.test', material)
    assert.notEqual(replaced.cert, foreignPem)
    assert.ok(spkiDer(replaced.cert).equals(spkiDer(reissued.cert)), 'bound to the leaf key again')
    assert.equal(fs.readFileSync(ca.hostCertPath('foreign.test'), 'utf8'), replaced.cert)
  })

  test('file names stay inside hosts/ whatever the host name', () => {
    assert.equal(path.dirname(ca.hostCertPath('../../outside')), ca.HOST_CERTS_DIR)
    assert.equal(path.basename(ca.hostCertPath('Upper.Test')), 'upper.test.pem')
    assert.equal(path.basename(ca.hostCertPath('a/b:c')), 'a_b_c.pem')
    assert.equal(path.basename(ca.hostCertPath('')), '_.pem')
  })

  test('the in-memory cache is bounded', () => {
    assert.equal(ca.HOST_CERT_CACHE_MAX, 500)
  })
})

describe('lru cache', () => {
  test('evicts the least recently used entry beyond its capacity', () => {
    const cache = createLruCache(2)
    cache.set('a', 1)
    cache.set('b', 2)
    assert.equal(cache.get('a'), 1, 'a becomes the most recently used')
    cache.set('c', 3)
    assert.equal(cache.has('b'), false, 'b was the least recently used')
    assert.equal(cache.get('a'), 1)
    assert.equal(cache.get('c'), 3)
    assert.equal(cache.size(), 2)
    cache.set('a', 10)
    assert.equal(cache.get('a'), 10)
    assert.equal(cache.size(), 2)
    cache.delete('a')
    assert.equal(cache.has('a'), false)
    cache.clear()
    assert.equal(cache.size(), 0)
  })
})
