'use strict'

/**
 * Certificate authority of the HTTPS MITM.
 *
 * - The CA key pair and certificate live under CERTS_DIR (`ca-key.pem`,
 *   `ca-cert.pem`), created on first use so that requiring this module costs
 *   nothing; existing files are loaded unchanged.
 * - One leaf key pair (`leaf-key.pem`) is shared by every host certificate,
 *   so issuing a certificate is a signature, not an RSA key generation. Keys
 *   are generated with Node's native `crypto` (milliseconds) instead of
 *   node-forge's pure-JS RSA (seconds); forge still builds and signs X.509.
 * - Host certificates are persisted under `CERTS_DIR/hosts/<host>.pem` and
 *   reloaded on cache miss when they are still valid, signed by this CA and
 *   bound to the shared leaf key; a bounded in-memory cache sits in front.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const forge = require('node-forge')
const { CERTS_DIR } = require('../../config')
const { createLruCache } = require('../util/lru')

/**
 * CA material as loaded from disk or freshly generated.
 *
 * @typedef {object} CaMaterial
 * @property {import('node-forge').pki.rsa.PrivateKey} key
 * @property {import('node-forge').pki.Certificate} cert
 * @property {string} keyPem
 * @property {string} certPem
 */

/**
 * PEM pair of a leaf certificate issued for one host (the key is the shared
 * leaf key).
 *
 * @typedef {object} HostCertificate
 * @property {string} key Private key PEM.
 * @property {string} cert Certificate PEM.
 */

/**
 * An RSA key pair as forge objects plus its PKCS#1 PEM.
 *
 * @typedef {object} RsaKeyPair
 * @property {import('node-forge').pki.rsa.PrivateKey} privateKey
 * @property {import('node-forge').pki.rsa.PublicKey} publicKey
 * @property {string} keyPem
 */

const CA_KEY_PATH = path.join(CERTS_DIR, 'ca-key.pem')
const CA_CERT_PATH = path.join(CERTS_DIR, 'ca-cert.pem')
const LEAF_KEY_PATH = path.join(CERTS_DIR, 'leaf-key.pem')
const HOST_CERTS_DIR = path.join(CERTS_DIR, 'hosts')

/** Host certificates kept in memory; older ones are reloaded from disk. */
const HOST_CERT_CACHE_MAX = 500

/** A persisted host certificate is reused only if it stays valid this long. */
const HOST_CERT_MIN_REMAINING_MS = 24 * 60 * 60 * 1000

if (!fs.existsSync(CERTS_DIR)) {
  fs.mkdirSync(CERTS_DIR, { recursive: true })
}

/** @type {import('../util/lru').LruCache<string, HostCertificate>} */
const certCache = createLruCache(HOST_CERT_CACHE_MAX)

/**
 * Generate an RSA-2048 key pair with Node's native crypto and hand it to
 * forge (which only needs the numbers to sign and to embed public keys).
 *
 * @returns {RsaKeyPair}
 */
function generateRsaKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keyPem = /** @type {string} */ (privateKey.export({ type: 'pkcs1', format: 'pem' }))
  const publicPem = /** @type {string} */ (publicKey.export({ type: 'spki', format: 'pem' }))
  return {
    privateKey: forge.pki.privateKeyFromPem(keyPem),
    publicKey: forge.pki.publicKeyFromPem(publicPem),
    keyPem
  }
}

/**
 * Rebuild a key pair from a private key PEM (the public key is derived from
 * the modulus and exponent).
 *
 * @param {string} keyPem
 * @returns {RsaKeyPair}
 */
function loadRsaKeyPair(keyPem) {
  const privateKey = forge.pki.privateKeyFromPem(keyPem)
  return {
    privateKey,
    publicKey: forge.pki.rsa.setPublicKey(privateKey.n, privateKey.e),
    keyPem
  }
}

/**
 * Write a file through a temporary sibling and a rename, so a reader never
 * sees a partially written PEM.
 *
 * @param {string} target
 * @param {string} contents
 */
function writeFileAtomic(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(temp, contents)
  fs.renameSync(temp, target)
}

/**
 * A random positive 128-bit serial number as the hex string forge expects.
 * (`Date.now()` collided for two hosts issued in the same millisecond.)
 *
 * @returns {string}
 */
function randomSerialNumber() {
  const bytes = crypto.randomBytes(16)
  // Clear the high bit so the DER integer is positive.
  bytes[0] &= 0x7f
  return bytes.toString('hex')
}

/**
 * Load the CA from CERTS_DIR, generating and persisting a new RSA-2048 CA
 * valid for ten years when the files do not exist yet.
 *
 * @returns {CaMaterial}
 */
function getOrCreateCA() {
  if (fs.existsSync(CA_KEY_PATH) && fs.existsSync(CA_CERT_PATH)) {
    const caKeyPem = fs.readFileSync(CA_KEY_PATH, 'utf8')
    const caCertPem = fs.readFileSync(CA_CERT_PATH, 'utf8')

    return {
      key: forge.pki.privateKeyFromPem(caKeyPem),
      cert: forge.pki.certificateFromPem(caCertPem),
      keyPem: caKeyPem,
      certPem: caCertPem
    }
  }

  const keys = generateRsaKeyPair()
  const cert = forge.pki.createCertificate()

  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10)

  const attrs = [
    { name: 'commonName', value: 'Cascade Proxy CA' },
    { name: 'countryName', value: 'US' },
    { name: 'organizationName', value: 'Cascade Proxy' },
    { shortName: 'OU', value: 'Development' }
  ]

  cert.setSubject(attrs)
  cert.setIssuer(attrs)

  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: true
    },
    {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true,
      codeSigning: true,
      emailProtection: true,
      timeStamping: true
    },
    {
      name: 'subjectKeyIdentifier'
    }
  ])

  cert.sign(keys.privateKey, forge.md.sha256.create())

  const certPem = forge.pki.certificateToPem(cert)

  writeFileAtomic(CA_KEY_PATH, keys.keyPem)
  writeFileAtomic(CA_CERT_PATH, certPem)

  return {
    key: keys.privateKey,
    cert,
    keyPem: keys.keyPem,
    certPem
  }
}

// Shared leaf key, loaded or generated on first use.
/** @type {RsaKeyPair|null} */
let leafKeyCache = null

/**
 * The key pair embedded in every host certificate: loaded from
 * `leaf-key.pem`, generated and persisted when missing or unreadable.
 *
 * @returns {RsaKeyPair}
 */
function getLeafKey() {
  if (leafKeyCache) return leafKeyCache

  if (fs.existsSync(LEAF_KEY_PATH)) {
    try {
      leafKeyCache = loadRsaKeyPair(fs.readFileSync(LEAF_KEY_PATH, 'utf8'))
      return leafKeyCache
    } catch (error) {
      // Unreadable or corrupt: a fresh key is generated below.
    }
  }

  const keys = generateRsaKeyPair()
  writeFileAtomic(LEAF_KEY_PATH, keys.keyPem)
  leafKeyCache = keys
  return keys
}

/**
 * File that persists the certificate of a host (hostnames are DNS labels,
 * anything else is replaced so the name stays a plain file name).
 *
 * @param {string} hostname
 * @returns {string}
 */
function hostCertPath(hostname) {
  const safe = hostname
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '_')
    .replace(/^\.+/, '_')
  return path.join(HOST_CERTS_DIR, `${safe || '_'}.pem`)
}

/**
 * Reload a persisted host certificate when it is still valid for at least a
 * day, signed by this CA and bound to the shared leaf key; anything else
 * (missing, corrupt, expired, issued by a previous CA or with another key)
 * yields null and the certificate is issued again.
 *
 * @param {string} hostname
 * @param {CaMaterial} ca
 * @param {RsaKeyPair} leafKey
 * @returns {HostCertificate|null}
 */
function loadHostCertificate(hostname, ca, leafKey) {
  let certPem
  try {
    certPem = fs.readFileSync(hostCertPath(hostname), 'utf8')
  } catch (error) {
    return null
  }

  try {
    const cert = forge.pki.certificateFromPem(certPem)
    const now = Date.now()
    if (cert.validity.notBefore.getTime() > now) return null
    if (cert.validity.notAfter.getTime() - now < HOST_CERT_MIN_REMAINING_MS) return null
    if (!ca.cert.verify(cert)) return null

    const certKey = /** @type {import('node-forge').pki.rsa.PublicKey} */ (cert.publicKey)
    if (
      certKey.n.compareTo(leafKey.publicKey.n) !== 0 ||
      certKey.e.compareTo(leafKey.publicKey.e) !== 0
    ) {
      return null
    }

    return { key: leafKey.keyPem, cert: certPem }
  } catch (error) {
    return null
  }
}

/**
 * Issue (or return from cache or disk) a one-year leaf certificate for a
 * host, with the host and its wildcard as subject alternative names, signed
 * by the CA and carrying the shared leaf key.
 *
 * @param {string} hostname
 * @param {CaMaterial} ca
 * @returns {HostCertificate}
 */
function generateCertForHost(hostname, ca) {
  const cached = certCache.get(hostname)
  if (cached) {
    return cached
  }

  const leafKey = getLeafKey()

  const persisted = loadHostCertificate(hostname, ca, leafKey)
  if (persisted) {
    certCache.set(hostname, persisted)
    return persisted
  }

  const cert = forge.pki.createCertificate()

  cert.publicKey = leafKey.publicKey
  cert.serialNumber = randomSerialNumber()
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1)

  const attrs = [
    { name: 'commonName', value: hostname },
    { name: 'countryName', value: 'US' },
    { name: 'organizationName', value: 'Cascade Proxy' }
  ]

  cert.setSubject(attrs)
  cert.setIssuer(ca.cert.subject.attributes)

  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: false
    },
    {
      name: 'keyUsage',
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true
    },
    {
      name: 'subjectAltName',
      altNames: [
        {
          type: 2,
          value: hostname
        },
        {
          type: 2,
          value: '*.' + hostname
        }
      ]
    },
    {
      name: 'subjectKeyIdentifier'
    }
  ])

  cert.sign(ca.key, forge.md.sha256.create())

  const result = {
    key: leafKey.keyPem,
    cert: forge.pki.certificateToPem(cert)
  }

  try {
    writeFileAtomic(hostCertPath(hostname), result.cert)
  } catch (error) {
    // The disk copy only saves work on the next start; keep serving.
  }

  certCache.set(hostname, result)

  return result
}

// CA certificate, created on first use so that loading this module (tests,
// embedders) pays neither the RSA key generation nor a write to CERTS_DIR.
/** @type {CaMaterial|null} */
let caCache = null

/**
 * The process-wide CA, loaded or generated on the first call.
 *
 * @returns {CaMaterial}
 */
function getCA() {
  if (!caCache) {
    caCache = getOrCreateCA()
  }
  return caCache
}

/**
 * Drop the in-memory host certificates and the loaded leaf key, so the next
 * request goes back to disk (used by tests; the CA stays loaded).
 */
function clearCache() {
  certCache.clear()
  leafKeyCache = null
}

module.exports = {
  CA_KEY_PATH,
  CA_CERT_PATH,
  LEAF_KEY_PATH,
  HOST_CERTS_DIR,
  HOST_CERT_CACHE_MAX,
  getOrCreateCA,
  getLeafKey,
  hostCertPath,
  generateCertForHost,
  getCA,
  clearCache
}
