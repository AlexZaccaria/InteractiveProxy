const forge = require('node-forge')
const fs = require('fs')
const path = require('path')

const CERTS_DIR = path.join(__dirname, 'certs')
const CA_KEY_PATH = path.join(CERTS_DIR, 'ca-key.pem')
const CA_CERT_PATH = path.join(CERTS_DIR, 'ca-cert.pem')

// Ensure certs directory exists
if (!fs.existsSync(CERTS_DIR)) {
  fs.mkdirSync(CERTS_DIR, { recursive: true })
}

// Certificate cache
const certCache = new Map()

/**
 * Generate or load CA certificate
 */
function getOrCreateCA () {
  if (fs.existsSync(CA_KEY_PATH) && fs.existsSync(CA_CERT_PATH)) {
    // Load existing CA
    const caKeyPem = fs.readFileSync(CA_KEY_PATH, 'utf8')
    const caCertPem = fs.readFileSync(CA_CERT_PATH, 'utf8')

    return {
      key: forge.pki.privateKeyFromPem(caKeyPem),
      cert: forge.pki.certificateFromPem(caCertPem),
      keyPem: caKeyPem,
      certPem: caCertPem
    }
  }

  // Generate new CA
  console.log('Generating new CA certificate...')

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

  console.log('CA certificate generated and saved')
  console.log(`CA certificate: ${CA_CERT_PATH}`)
  console.log('Install this certificate in your system to trust MITM connections')

  return {
    key: keys.privateKey,
    cert,
    keyPem,
    certPem
  }
}

/**
 * Generate certificate for a specific hostname
 */
function generateCertForHost (hostname, ca) {
  // Check cache
  if (certCache.has(hostname)) {
    return certCache.get(hostname)
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
          type: 2, // DNS
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

  // Cache the certificate
  certCache.set(hostname, result)

  return result
}

module.exports = {
  getOrCreateCA,
  generateCertForHost,
  CA_CERT_PATH
}
