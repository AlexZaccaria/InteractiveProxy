const http = require('http')
const https = require('https')
const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const axios = require('axios')
const { URL } = require('url')
const WebSocket = require('ws')
const zlib = require('zlib')
const { decompress: zstdDecompress } = require('fzstd')
const { getOrCreateCA, generateCertForHost, CA_CERT_PATH } = require('./cert-manager')

const app = express()
const PORT = 8080
const UI_PORT = 3000

// Directories
const STORAGE_DIR = path.join(__dirname, 'storage')
const LOGS_DIR = path.join(__dirname, 'logs')
const BLOCKED_URLS_FILE = path.join(__dirname, 'blocked-urls.json')

// Blocked URLs list
let blockedUrls = []

// Load blocked URLs from file
function loadBlockedUrls () {
  try {
    if (fs.existsSync(BLOCKED_URLS_FILE)) {
      const data = fs.readFileSync(BLOCKED_URLS_FILE, 'utf8')
      blockedUrls = JSON.parse(data)
      log('info', 'Loaded blocked URLs', { count: blockedUrls.length })
    }
  } catch (error) {
    log('error', 'Error loading blocked URLs', { error: error.message })
  }
}

// Save blocked URLs to file
function saveBlockedUrls () {
  try {
    fs.writeFileSync(BLOCKED_URLS_FILE, JSON.stringify(blockedUrls, null, 2))
    log('info', 'Saved blocked URLs', { count: blockedUrls.length })
  } catch (error) {
    log('error', 'Error saving blocked URLs', { error: error.message })
  }
}

// Decompress response data
function decompressData (buffer, encoding) {
  try {
    if (!encoding || encoding === 'identity') {
      return buffer
    }

    if (encoding === 'gzip' || encoding === 'x-gzip') {
      return zlib.gunzipSync(buffer)
    } else if (encoding === 'deflate') {
      return zlib.inflateSync(buffer)
    } else if (encoding === 'br') {
      return zlib.brotliDecompressSync(buffer)
    } else if (encoding === 'zstd') {
      return Buffer.from(zstdDecompress(buffer))
    }

    return null
  } catch (error) {
    // Decompression failed (silent)
    return null
  }
}

// Logging function
function log (level, message, data = {}) {
  const timestamp = new Date().toISOString()
  const logMessage = `${timestamp} [${level.toUpperCase()}] ${message} ${JSON.stringify(data)}`

  // Only log to console if interactive mode is enabled
  if (interactiveModeEnabled) {
    console.log(logMessage)
  }

  // Always write to log file
  const logFile = path.join(LOGS_DIR, `proxy-${new Date().toISOString().split('T')[0]}.log`)
  fs.appendFileSync(logFile, logMessage + '\n')
}

// Ensure directories exist
[STORAGE_DIR, LOGS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
})

// In-memory storage for request logs
let requestLogs = []
let localResources = new Map()

// Load interactive mode from disk
const CONFIG_FILE = path.join(STORAGE_DIR, 'config.json')
let interactiveModeEnabled = true // interactive mode flag
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    interactiveModeEnabled = config.interactiveModeEnabled !== false
  }
} catch (error) {
  console.error('Error loading config:', error)
}

// Helper to add log only if interactive mode is enabled
function addLog (logEntry) {
  if (!interactiveModeEnabled) return
  requestLogs.unshift(logEntry)
  if (requestLogs.length > 5000) requestLogs.pop()
}

// Load existing local resources on startup
function loadLocalResources () {
  const resourcesFile = path.join(STORAGE_DIR, 'resources.json')
  if (fs.existsSync(resourcesFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(resourcesFile, 'utf8'))
      localResources = new Map(Object.entries(data))
      log('info', 'Local resources loaded', { count: localResources.size })
    } catch (error) {
      log('error', 'Error loading resources', { error: error.message })
    }
  }
}

// Save local resources to disk
function saveLocalResources () {
  const resourcesFile = path.join(STORAGE_DIR, 'resources.json')
  const data = Object.fromEntries(localResources)
  fs.writeFileSync(resourcesFile, JSON.stringify(data, null, 2))
}

// Middleware
app.use(cors())
app.set('trust proxy', true)
app.use(bodyParser.json({ limit: '50mb' }))
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }))

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, STORAGE_DIR)
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`
    cb(null, uniqueName)
  }
})
const upload = multer({ storage })

// Load resources and blocked URLs on startup
loadLocalResources()
loadBlockedUrls()

// Initialize CA certificate
const CA = getOrCreateCA()
log('info', 'CA certificate ready', { path: CA_CERT_PATH })

// API Routes for UI
app.get('/api/logs', (req, res) => {
  res.json(requestLogs)
})

// Get config
app.get('/api/config', (req, res) => {
  res.json({ interactiveModeEnabled })
})

// Set interactive mode
app.post('/api/interactive-mode', (req, res) => {
  const { enabled } = req.body
  interactiveModeEnabled = enabled !== false

  // Save to disk
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ interactiveModeEnabled }, null, 2))
  } catch (error) {
    console.error('Error saving config:', error)
  }

  log('info', 'interactive mode changed', { enabled: interactiveModeEnabled })
  res.json({ success: true, interactiveModeEnabled })
})

app.get('/api/resources', (req, res) => {
  const resources = Array.from(localResources.entries()).map(([url, data]) => ({
    url,
    ...data
  }))
  res.json(resources)
})

app.post('/api/resources', upload.single('file'), (req, res) => {
  try {
    const { url, contentType } = req.body

    if (!url) {
      return res.status(400).json({ error: 'URL is required' })
    }

    let resourceData

    if (req.file) {
      // File upload
      resourceData = {
        type: 'file',
        filename: req.file.filename,
        originalName: req.file.originalname,
        contentType: contentType || req.file.mimetype,
        size: req.file.size,
        createdAt: new Date().toISOString()
      }
    } else if (req.body.content) {
      // Text/JSON content
      const filename = `${Date.now()}-content.txt`
      fs.writeFileSync(path.join(STORAGE_DIR, filename), req.body.content)
      resourceData = {
        type: 'text',
        filename,
        contentType: contentType || 'text/plain',
        size: req.body.content.length,
        createdAt: new Date().toISOString()
      }
    } else {
      return res.status(400).json({ error: 'File or content is required' })
    }

    localResources.set(url, resourceData)
    saveLocalResources()

    res.json({
      success: true,
      message: 'Resource added successfully',
      resource: { url, ...resourceData }
    })
  } catch (error) {
    log('error', 'Error adding resource', { error: error.message })
    res.status(500).json({ error: error.message })
  }
})

app.delete('/api/resources/:encodedUrl', (req, res) => {
  try {
    const url = decodeURIComponent(req.params.encodedUrl)

    if (localResources.has(url)) {
      const resource = localResources.get(url)
      const filePath = path.join(STORAGE_DIR, resource.filename)

      // Delete file if exists
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }

      localResources.delete(url)
      saveLocalResources()

      res.json({ success: true, message: 'Resource deleted successfully' })
    } else {
      res.status(404).json({ error: 'Resource not found' })
    }
  } catch (error) {
    log('error', 'Error deleting resource', { error: error.message })
    res.status(500).json({ error: error.message })
  }
})

app.delete('/api/logs', (req, res) => {
  requestLogs = []
  res.json({ success: true, message: 'Logs cleared' })
})

// Get blocked URLs
app.get('/api/blocked', (req, res) => {
  res.json(blockedUrls)
})

// Add/remove blocked URL
app.post('/api/blocked', (req, res) => {
  const { url, action } = req.body // action: 'add' or 'remove'

  if (!url) {
    return res.status(400).json({ error: 'URL is required' })
  }

  if (action === 'add') {
    if (!blockedUrls.includes(url)) {
      blockedUrls.push(url)
      log('info', 'URL blocked', { url })
      saveBlockedUrls()
    }
  } else if (action === 'remove') {
    blockedUrls = blockedUrls.filter(u => u !== url)
    log('info', 'URL unblocked', { url })
    saveBlockedUrls()
  }

  res.json({ success: true, blockedUrls })
})

// Proxy middleware - handles all other requests
app.use('*', async (req, res) => {
  const requestUrl = req.originalUrl
  const fullUrl = req.protocol + '://' + req.get('host') + requestUrl
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown'

  // Log the request
  const logEntry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toISOString(),
    method: req.method,
    url: requestUrl,
    fullUrl,
    headers: req.headers,
    body: req.body,
    source: 'unknown',
    clientIp
  }

  // Check if URL is blocked
  const isBlocked = blockedUrls.some(blockedUrl =>
    requestUrl.includes(blockedUrl) || fullUrl.includes(blockedUrl)
  )

  if (isBlocked) {
    logEntry.source = 'blocked'
    logEntry.statusCode = 204
    addLog(logEntry)

    // Blocked request (silent)
    return res.status(204).end() // No Content
  }

  // Check if we have a local resource for this URL
  let matchedUrl = null
  for (const [resourceUrl] of localResources.entries()) {
    if (requestUrl.includes(resourceUrl) || fullUrl.includes(resourceUrl)) {
      matchedUrl = resourceUrl
      break
    }
  }

  if (matchedUrl) {
    // Serve local resource
    const resource = localResources.get(matchedUrl)
    const filePath = path.join(STORAGE_DIR, resource.filename)

    logEntry.source = 'local'
    logEntry.localResource = matchedUrl
    addLog(logEntry)

    try {
      const fileContent = fs.readFileSync(filePath)
      res.setHeader('Content-Type', resource.contentType)
      res.setHeader('X-Proxy-Source', 'local')
      res.send(fileContent)
    } catch (error) {
      log('error', 'Error serving local resource', {
        requestUrl,
        matchedUrl,
        error: error.message
      })
      res.status(500).json({ error: 'Error serving local resource' })
    }
  } else {
    // Try to extract target URL from request
    const targetHeader = req.headers['x-target-url']
    let resolvedTargetUrl = targetHeader

    if (!resolvedTargetUrl) {
      if (/^https?:\/\//i.test(requestUrl)) {
        resolvedTargetUrl = requestUrl
      } else if (req.headers.host && req.headers.host !== `localhost:${PORT}` && req.headers.host !== `127.0.0.1:${PORT}`) {
        const assumedProtocol = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || 'http'
        resolvedTargetUrl = `${assumedProtocol}://${req.headers.host}${requestUrl}`
      }
    }

    if (resolvedTargetUrl) {
      // Proxy to target URL
      // Proxying request (silent)

      try {
        const target = new URL(resolvedTargetUrl)
        const headersToForward = { ...req.headers }
        delete headersToForward['x-target-url']
        delete headersToForward['proxy-connection']
        delete headersToForward.connection
        delete headersToForward['content-length']
        // Remove cache validation headers to force fresh responses
        delete headersToForward['if-none-match']
        delete headersToForward['if-modified-since']
        delete headersToForward['if-match']
        delete headersToForward['if-unmodified-since']

        const isJson = headersToForward['content-type']?.includes('application/json')
        const data = req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : (isJson && typeof req.body !== 'string' ? JSON.stringify(req.body) : req.body)

        const response = await axios({
          method: req.method,
          url: resolvedTargetUrl,
          headers: {
            ...headersToForward,
            host: target.host,
            connection: 'close'
          },
          data,
          responseType: 'arraybuffer',
          validateStatus: () => true,
          decompress: false
        })

        // Parse response body for logging (only for logging, don't modify actual response)
        let responseBody = ''
        const contentType = response.headers['content-type'] || ''
        const contentEncoding = response.headers['content-encoding'] || ''

        // Binary types that should never be parsed as text
        const isBinary = contentType.includes('font/') ||
                        contentType.includes('woff') ||
                        contentType.includes('image/') ||
                        contentType.includes('video/') ||
                        contentType.includes('audio/') ||
                        contentType.includes('octet-stream')

        let dataToLog = response.data

        // Try to decompress if encoded
        if (contentEncoding && !isBinary) {
          const decompressed = decompressData(response.data, contentEncoding)
          if (decompressed) {
            dataToLog = decompressed
          }
        }

        // Try to parse as text if not binary
        const shouldTryText = !isBinary && (
          contentType.includes('application/json') ||
          contentType.includes('text/') ||
          contentType.includes('javascript') ||
          (contentEncoding && dataToLog !== response.data) // If we successfully decompressed, try to parse
        )

        if (shouldTryText) {
          try {
            responseBody = dataToLog.toString('utf8')
            // No truncation - keep full response for preview
          } catch (e) {
            responseBody = `[Binary data: ${response.data.length} bytes]`
          }
        } else {
          // Only log if there's actual data
          if (response.data.length > 0) {
            responseBody = `[Binary/Compressed data: ${response.data.length} bytes, type: ${contentType}, encoding: ${contentEncoding || 'none'}]`
          }
        }

        logEntry.source = 'proxied'
        logEntry.targetUrl = resolvedTargetUrl
        logEntry.fullUrl = resolvedTargetUrl // Use target URL instead of proxy URL
        logEntry.statusCode = response.status
        logEntry.responseHeaders = response.headers
        logEntry.responseBody = responseBody
        logEntry.responseSize = response.data?.length || response.data?.byteLength || 0
        addLog(logEntry)

        // Forward response with cache-busting headers
        res.status(response.status)
        Object.entries(response.headers).forEach(([key, value]) => {
          const lowerKey = key.toLowerCase()
          // Skip headers that we'll override or that Express handles
          if (lowerKey !== 'transfer-encoding' &&
              lowerKey !== 'cache-control' &&
              lowerKey !== 'pragma' &&
              lowerKey !== 'expires' &&
              lowerKey !== 'etag' &&
              lowerKey !== 'last-modified') {
            res.setHeader(key, value)
          }
        })
        // Add cache-busting headers
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
        res.setHeader('Pragma', 'no-cache')
        res.setHeader('Expires', '0')
        res.setHeader('X-Proxy-Source', 'remote')
        res.send(response.data)
      } catch (error) {
        log('error', 'Proxy request failed', {
          method: req.method,
          requestUrl,
          targetUrl: resolvedTargetUrl,
          error: error.message
        })
        logEntry.source = 'error'
        logEntry.error = error.message
        addLog(logEntry)

        res.status(502).json({ error: 'Proxy error', message: error.message })
      }
    } else {
      // No local resource and no target URL (likely WebSocket or direct connection)
      logEntry.source = 'websocket'
      addLog(logEntry)

      log('warn', 'Request could not be fulfilled (no local resource or target)', {
        method: req.method,
        requestUrl,
        clientIp
      })

      res.status(404).json({
        error: 'No local resource found and no target URL specified',
        hint: 'Add X-Target-URL header with the destination URL or configure a local resource'
      })
    }
  }
})

const server = http.createServer(app)

// WebSocket upgrade handler
function handleWebSocketUpgrade (clientReq, clientSocket, targetHost, targetPort, fullUrl) {
  const wsUrl = fullUrl.replace('https://', 'wss://').replace('http://', 'ws://')

  // Establishing WebSocket connection (silent)

  try {
    // Prepare headers for target WebSocket connection
    const wsHeaders = {}

    // Copy important headers
    const headersToForward = [
      'user-agent',
      'origin',
      'sec-websocket-version',
      'sec-websocket-key',
      'sec-websocket-extensions',
      'sec-websocket-protocol',
      'cookie',
      'authorization'
    ]

    headersToForward.forEach(header => {
      if (clientReq.headers[header]) {
        wsHeaders[header] = clientReq.headers[header]
      }
    })

    // Override host
    wsHeaders.host = targetHost

    // Create WebSocket connection to target server
    const targetWs = new WebSocket(wsUrl, {
      headers: wsHeaders,
      rejectUnauthorized: false // Accept self-signed certs
    })

    targetWs.on('open', () => {
      // WebSocket connected (silent)

      // Log WebSocket connection establishment
      const connectionLog = {
        id: Date.now() + Math.random(),
        timestamp: new Date().toISOString(),
        method: 'WS',
        url: wsUrl,
        fullUrl: wsUrl,
        source: 'websocket',
        direction: 'connected',
        isConnectionLog: true, // Flag to identify connection logs
        headers: clientReq.headers,
        body: 'WebSocket connection established',
        responseBody: null,
        responseHeaders: null,
        statusCode: 101
      }
      addLog(connectionLog)

      // Send upgrade response to client
      const upgradeHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${generateWebSocketAccept(clientReq.headers['sec-websocket-key'])}`
      ]

      if (clientReq.headers['sec-websocket-protocol']) {
        upgradeHeaders.push(`Sec-WebSocket-Protocol: ${clientReq.headers['sec-websocket-protocol']}`)
      }

      clientSocket.write(upgradeHeaders.join('\r\n') + '\r\n\r\n')

      // Pipe data bidirectionally with logging
      targetWs.on('message', (data, isBinary) => {
        if (clientSocket.writable) {
          const frame = createWebSocketFrame(data, isBinary)
          clientSocket.write(frame)

          // Log WebSocket message from server to client
          const messageLog = {
            id: Date.now() + Math.random(),
            timestamp: new Date().toISOString(),
            method: 'WS',
            url: wsUrl,
            fullUrl: wsUrl,
            source: 'websocket',
            direction: 'server→client',
            headers: {},
            body: isBinary ? `[Binary data: ${data.length} bytes]` : data.toString('utf8'),
            responseBody: null,
            responseHeaders: null
          }
          addLog(messageLog)
        }
      })

      clientSocket.on('data', (data) => {
        try {
          const decoded = decodeWebSocketFrame(data)
          if (decoded && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(decoded.payload, { binary: decoded.isBinary })

            // Log WebSocket message from client to server
            const messageLog = {
              id: Date.now() + Math.random(),
              timestamp: new Date().toISOString(),
              method: 'WS',
              url: wsUrl,
              fullUrl: wsUrl,
              source: 'websocket',
              direction: 'client→server',
              headers: {},
              body: decoded.isBinary ? `[Binary data: ${decoded.payload.length} bytes]` : decoded.payload.toString('utf8'),
              responseBody: null,
              responseHeaders: null
            }
            addLog(messageLog)
          }
        } catch (e) {
          log('error', 'WebSocket frame decode error', { error: e.message })
        }
      })
    })

    targetWs.on('error', (error) => {
      log('error', 'WebSocket target error', { wsUrl, error: error.message })
      clientSocket.end()
    })

    targetWs.on('close', () => {
      // WebSocket target closed (silent)
      clientSocket.end()
    })

    clientSocket.on('error', (error) => {
      log('error', 'WebSocket client error', { error: error.message })
      targetWs.close()
    })

    clientSocket.on('close', () => {
      // WebSocket client closed (silent)
      targetWs.close()
    })
  } catch (error) {
    log('error', 'WebSocket setup error', { wsUrl, error: error.message })
    clientSocket.end()
  }
}

// WebSocket helper functions
function generateWebSocketAccept (key) {
  const crypto = require('crypto')
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
  return crypto.createHash('sha1').update(key + GUID).digest('base64')
}

function createWebSocketFrame (data, isBinary) {
  const payload = Buffer.from(data)
  const payloadLength = payload.length
  let frame

  if (payloadLength < 126) {
    frame = Buffer.allocUnsafe(2 + payloadLength)
    frame[0] = isBinary ? 0x82 : 0x81 // FIN + opcode
    frame[1] = payloadLength
    payload.copy(frame, 2)
  } else if (payloadLength < 65536) {
    frame = Buffer.allocUnsafe(4 + payloadLength)
    frame[0] = isBinary ? 0x82 : 0x81
    frame[1] = 126
    frame.writeUInt16BE(payloadLength, 2)
    payload.copy(frame, 4)
  } else {
    frame = Buffer.allocUnsafe(10 + payloadLength)
    frame[0] = isBinary ? 0x82 : 0x81
    frame[1] = 127
    frame.writeUInt32BE(0, 2)
    frame.writeUInt32BE(payloadLength, 6)
    payload.copy(frame, 10)
  }

  return frame
}

function decodeWebSocketFrame (buffer) {
  if (buffer.length < 2) return null

  const firstByte = buffer[0]
  const secondByte = buffer[1]

  const isFinal = (firstByte & 0x80) !== 0
  const opcode = firstByte & 0x0F
  const isMasked = (secondByte & 0x80) !== 0
  let payloadLength = secondByte & 0x7F
  let offset = 2

  if (payloadLength === 126) {
    if (buffer.length < 4) return null
    payloadLength = buffer.readUInt16BE(2)
    offset = 4
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null
    payloadLength = buffer.readUInt32BE(6)
    offset = 10
  }

  let maskingKey
  if (isMasked) {
    if (buffer.length < offset + 4) return null
    maskingKey = buffer.slice(offset, offset + 4)
    offset += 4
  }

  if (buffer.length < offset + payloadLength) return null

  let payload = buffer.slice(offset, offset + payloadLength)

  if (isMasked && maskingKey) {
    payload = Buffer.from(payload)
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskingKey[i % 4]
    }
  }

  return {
    isFinal,
    opcode,
    isBinary: opcode === 2,
    payload
  }
}

server.on('connect', (req, clientSocket, head) => {
  const clientIp = clientSocket.remoteAddress
  // CONNECT MITM requested (silent)

  let targetUrl
  try {
    targetUrl = new URL(`http://${req.url}`)
  } catch (error) {
    log('error', 'Invalid CONNECT target', { target: req.url, error: error.message })
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    clientSocket.end()
    return
  }

  const targetHost = targetUrl.hostname
  const targetPort = targetUrl.port || 443

  // Generate certificate for this host
  const cert = generateCertForHost(targetHost, CA)

  // Create HTTPS server for this connection
  const httpsServerOptions = {
    key: cert.key,
    cert: cert.cert,
    maxHeaderSize: 16384, // 16KB header limit (default is 8KB)
    SNICallback: (servername, cb) => {
      const sniCert = generateCertForHost(servername, CA)
      cb(null, require('tls').createSecureContext({
        key: sniCert.key,
        cert: sniCert.cert
      }))
    }
  }

  // Tell client the tunnel is established
  clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: Cascade-Proxy-MITM\r\n\r\n')

  // Create HTTPS server to decrypt client traffic
  const httpsServer = https.createServer(httpsServerOptions, async (clientReq, clientRes) => {
    const requestUrl = clientReq.url
    const fullUrl = `https://${targetHost}${requestUrl}`
    const method = clientReq.method

    // MITM decrypted request (silent)

    // Check if this is a WebSocket upgrade request
    if (clientReq.headers.upgrade && clientReq.headers.upgrade.toLowerCase() === 'websocket') {
      // WebSocket upgrade detected (silent)
      handleWebSocketUpgrade(clientReq, clientReq.socket, targetHost, targetPort, fullUrl)
      return
    }

    // Collect request body
    let body = []
    clientReq.on('data', chunk => body.push(chunk))
    clientReq.on('end', async () => {
      body = Buffer.concat(body)
      const bodyString = body.length > 0 ? body.toString('utf8') : ''

      // Log to UI
      const logEntry = {
        id: Date.now() + Math.random(),
        timestamp: new Date().toISOString(),
        method,
        url: requestUrl,
        fullUrl,
        headers: clientReq.headers,
        body: bodyString,
        source: 'mitm',
        clientIp
      }

      // Check if URL is blocked
      const isBlocked = blockedUrls.some(blockedUrl =>
        requestUrl.includes(blockedUrl) || fullUrl.includes(blockedUrl)
      )

      if (isBlocked) {
        logEntry.source = 'blocked'
        logEntry.statusCode = 204
        addLog(logEntry)

        // MITM blocked request (silent)
        clientRes.writeHead(204)
        return clientRes.end()
      }

      // Check for local resource
      let matchedUrl = null
      for (const [resourceUrl] of localResources.entries()) {
        if (requestUrl.includes(resourceUrl) || fullUrl.includes(resourceUrl)) {
          matchedUrl = resourceUrl
          break
        }
      }

      if (matchedUrl) {
        // Serve local resource
        const resource = localResources.get(matchedUrl)
        const filePath = path.join(STORAGE_DIR, resource.filename)

        logEntry.source = 'local'
        logEntry.localResource = matchedUrl
        addLog(logEntry)

        try {
          const fileContent = fs.readFileSync(filePath)
          clientRes.writeHead(200, {
            'Content-Type': resource.contentType,
            'X-Proxy-Source': 'local'
          })
          clientRes.end(fileContent)
        } catch (error) {
          log('error', 'MITM error serving local resource', { error: error.message })
          clientRes.writeHead(500)
          clientRes.end('Error serving local resource')
        }
      } else {
        // Forward to real server
        try {
          // Forward headers (remove proxy-specific and cache validation headers)
          const headersToForward = { ...clientReq.headers }
          delete headersToForward['proxy-connection']
          delete headersToForward.connection
          delete headersToForward['if-none-match']
          delete headersToForward['if-modified-since']
          delete headersToForward['if-match']
          delete headersToForward['if-unmodified-since']

          // Set correct host
          headersToForward.host = targetHost

          // Update content-length if body exists
          if (body.length > 0) {
            headersToForward['content-length'] = body.length
          }

          const response = await axios({
            method,
            url: fullUrl,
            headers: headersToForward,
            data: body.length > 0 ? body : undefined,
            responseType: 'arraybuffer',
            validateStatus: () => true,
            maxRedirects: 0,
            decompress: false, // Don't auto-decompress, let browser handle it
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            httpAgent: new (require('http').Agent)({
              maxHeaderSize: 32768 // 32KB for outgoing requests
            }),
            httpsAgent: new (require('https').Agent)({
              maxHeaderSize: 32768, // 32KB for outgoing requests
              rejectUnauthorized: false
            })
          })

          // Parse response body for logging (only for logging, don't modify actual response)
          let responseBody = ''
          const contentType = response.headers['content-type'] || ''
          const contentEncoding = response.headers['content-encoding'] || ''

          // Binary types that should never be parsed as text
          const isBinary = contentType.includes('font/') ||
                          contentType.includes('woff') ||
                          contentType.includes('image/') ||
                          contentType.includes('video/') ||
                          contentType.includes('audio/') ||
                          contentType.includes('octet-stream')

          let dataToLog = response.data

          // Try to decompress if encoded
          if (contentEncoding && !isBinary) {
            const decompressed = decompressData(response.data, contentEncoding)
            if (decompressed) {
              dataToLog = decompressed
            }
          }

          // Try to parse as text if not binary
          const shouldTryText = !isBinary && (
            contentType.includes('application/json') ||
            contentType.includes('text/') ||
            contentType.includes('javascript') ||
            (contentEncoding && dataToLog !== response.data) // If we successfully decompressed, try to parse
          )

          if (shouldTryText) {
            try {
              responseBody = dataToLog.toString('utf8')
              // No truncation - keep full response for preview
            } catch (e) {
              responseBody = `[Binary data: ${response.data.length} bytes]`
            }
          } else {
            // Only log if there's actual data
            if (response.data.length > 0) {
              responseBody = `[Binary/Compressed data: ${response.data.length} bytes, type: ${contentType}, encoding: ${contentEncoding || 'none'}]`
            }
          }

          logEntry.source = 'mitm'
          logEntry.targetUrl = fullUrl
          logEntry.statusCode = response.status
          logEntry.responseHeaders = response.headers
          logEntry.responseBody = responseBody
          logEntry.responseSize = response.data?.length || response.data?.byteLength || 0
          addLog(logEntry)

          // Forward response with cache-busting headers
          const responseHeaders = {
            ...response.headers,
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            Pragma: 'no-cache',
            Expires: '0'
          }
          // Remove caching headers from original response
          delete responseHeaders.etag
          delete responseHeaders['last-modified']

          clientRes.writeHead(response.status, responseHeaders)
          clientRes.end(response.data)

          // MITM forwarded request (silent)
        } catch (error) {
          log('error', 'MITM proxy error', {
            method,
            fullUrl,
            error: error.message
          })

          logEntry.source = 'error'
          logEntry.error = error.message
          addLog(logEntry)

          clientRes.writeHead(502)
          clientRes.end('Bad Gateway')
        }
      }
    })
  })

  httpsServer.on('error', (error) => {
    log('error', 'MITM HTTPS server error', { host: targetHost, error: error.message })
  })

  // Pipe the client socket to the HTTPS server
  httpsServer.emit('connection', clientSocket)
  if (head && head.length) {
    clientSocket.unshift(head)
  }
})

server.listen(PORT, () => {
  log('info', 'Proxy Server with UI is running', {
    proxyUrl: `http://localhost:${PORT}`,
    uiUrl: `http://localhost:${UI_PORT}`,
    localResources: localResources.size
  })
})
