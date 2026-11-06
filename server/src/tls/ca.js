'use strict'

/**
 * Certificate authority of the HTTPS MITM: the CA key pair and certificate
 * persisted under CERTS_DIR (created on first use, so requiring this module
 * costs nothing), and the per-host leaf certificates signed with it, kept in
 * an in-memory cache for the life of the process.
 */

const fs = require('fs')
const path = require('path')
const forge = require('node-forge')
const { CERTS_DIR } = require('../../config')

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
 * PEM pair of a leaf certificate issued for one host.
 *
 * @typedef {object} HostCertificate
 * @property {string} key Private key PEM.
 * @property {string} cert Certificate PEM.
 */

// Certificate paths (inlined from cert-manager.js)
const CA_KEY_PATH = path.join(CERTS_DIR, 'ca-key.pem')
const CA_CERT_PATH = path.join(CERTS_DIR, 'ca-cert.pem')

if (!fs.existsSync(CERTS_DIR)) {
  fs.mkdirSync(CERTS_DIR, { recursive: true })
}

/** @type {Map<string, HostCertificate>} */
const certCache = new Map()

/**
 * Load the CA from CERTS_DIR, generating and persisting a new RSA-2048 CA
 * valid for ten years when the files do not exist yet.
 *
 * @returns {CaMaterial}
 */
function getOrCreateCA () {
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

  const keys = forge.pki.rsa.generateKeyPair(2048)
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

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
  const certPem = forge.pki.certificateToPem(cert)

  fs.writeFileSync(CA_KEY_PATH, keyPem)
  fs.writeFileSync(CA_CERT_PATH, certPem)

  return {
    key: keys.privateKey,
    cert,
    keyPem,
    certPem
  }
}

/**
 * Issue (or return from cache) a one-year leaf certificate for a host, with
 * the host and its wildcard as subject alternative names, signed by the CA.
 *
 * @param {string} hostname
 * @param {CaMaterial} ca
 * @returns {HostCertificate}
 */
function generateCertForHost (hostname, ca) {
  const cached = certCache.get(hostname)
  if (cached) {
    return cached
  }

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()

  cert.publicKey = keys.publicKey
  cert.serialNumber = Date.now().toString()
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
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert)
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
function getCA () {
  if (!caCache) {
    caCache = getOrCreateCA()
  }
  return caCache
}

module.exports = {
  CA_KEY_PATH,
  CA_CERT_PATH,
  getOrCreateCA,
  generateCertForHost,
  getCA
}
