'use strict'

const path = require('path')
const fs = require('fs')

// Ports
/**
 * Attempt to load the shared root ports.config.json file. If the file is
 * missing or invalid, this returns an empty object and callers fall back to
 * environment variables or defaults.
 *
 * @returns {{ uiPort?: number, backendPort?: number }} Parsed config, or {} when unavailable.
 */
function loadRootPortsConfig() {
  try {
    const configPath = path.join(__dirname, '..', 'ports.config.json')
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    // Silent fallback – server still starts even if config is missing.
    return {}
  }
}

const rootPortsConfig = loadRootPortsConfig()

/**
 * Port on which the proxy/backend HTTP server listens.
 *
 * Resolution order:
 * 1. `PROXY_PORT` environment variable, if set to a valid positive number.
 * 2. `backendPort` from ports.config.json at the project root.
 * 3. Hard-coded default (8050).
 *
 * @type {number}
 */
const envPort = Number(process.env.PROXY_PORT)
const configPort = Number(rootPortsConfig.backendPort)
const PORT =
  Number.isFinite(envPort) && envPort > 0
    ? envPort
    : Number.isFinite(configPort) && configPort > 0
      ? configPort
      : 8050

/**
 * Interface the proxy listens on. Defaults to the loopback address so that
 * the MITM proxy and its management API are not reachable from the LAN
 * unless explicitly requested via `PROXY_HOST` (e.g. `0.0.0.0`).
 *
 * @type {string}
 */
const HOST =
  typeof process.env.PROXY_HOST === 'string' && process.env.PROXY_HOST.trim()
    ? process.env.PROXY_HOST.trim()
    : '127.0.0.1'

/**
 * Port where the web UI is served in development (from ports.config.json).
 * Used only to derive the browser origins allowed to call the management API.
 *
 * @type {number}
 */
const configUiPort = Number(rootPortsConfig.uiPort)
const UI_PORT = Number.isFinite(configUiPort) && configUiPort > 0 ? configUiPort : 3050

/**
 * Browser origins allowed to call the `/api/*` management endpoints.
 *
 * By default this covers the dev UI and the proxy itself on localhost and
 * 127.0.0.1 (plus `PROXY_HOST` when it is a concrete address). Additional
 * origins can be added with the comma-separated `PROXY_UI_ORIGINS` variable.
 * Requests without an Origin header (curl, scripts) are not affected.
 *
 * @type {string[]}
 */
const defaultOriginHosts = ['localhost', '127.0.0.1']
if (HOST && HOST !== '0.0.0.0' && HOST !== '::' && !defaultOriginHosts.includes(HOST)) {
  defaultOriginHosts.push(HOST)
}
const extraUiOrigins =
  typeof process.env.PROXY_UI_ORIGINS === 'string'
    ? process.env.PROXY_UI_ORIGINS.split(',')
        .map(value => value.trim())
        .filter(Boolean)
    : []
const UI_ORIGINS = Array.from(
  new Set([
    ...defaultOriginHosts.flatMap(host => [`http://${host}:${UI_PORT}`, `http://${host}:${PORT}`]),
    ...extraUiOrigins
  ])
)

// Directories
const ROOT_DIR = __dirname
const STORAGE_DIR = process.env.PROXY_STORAGE_DIR
  ? path.resolve(process.env.PROXY_STORAGE_DIR)
  : path.join(ROOT_DIR, 'storage')

const LOGS_DIR = process.env.PROXY_LOGS_DIR
  ? path.resolve(process.env.PROXY_LOGS_DIR)
  : path.join(ROOT_DIR, 'logs')

const CERTS_DIR = process.env.PROXY_CERTS_DIR
  ? path.resolve(process.env.PROXY_CERTS_DIR)
  : path.join(ROOT_DIR, 'certs')

// Logging & limits
const MAX_LOG_ENTRIES = Number.isFinite(Number(process.env.PROXY_MAX_LOG_ENTRIES))
  ? Math.max(1, Number(process.env.PROXY_MAX_LOG_ENTRIES))
  : 5000

// Maximum size for text previews stored in log entries (0 = no limit, default behaviour).
// This controls how much of rawRequestBodyPreview/rawResponseBodyPreview and similar
// fields are kept in memory for the UI, without affecting the full underlying
// body/decoded data stored elsewhere on the log entry.
const LOG_PREVIEW_MAX_BYTES = Number.isFinite(Number(process.env.PROXY_LOG_PREVIEW_MAX_BYTES))
  ? Math.max(0, Number(process.env.PROXY_LOG_PREVIEW_MAX_BYTES))
  : 0

// Maximum compressed body size that we are willing to fully decompress purely
// for logging/preview purposes (0 = no limit, default behaviour). This does
// not affect semantics-critical decoding paths such as Connect/protobuf
// rewrites; it only applies when building previews for the UI.
const LOG_DECOMPRESS_MAX_BYTES = Number.isFinite(Number(process.env.PROXY_LOG_DECOMPRESS_MAX_BYTES))
  ? Math.max(0, Number(process.env.PROXY_LOG_DECOMPRESS_MAX_BYTES))
  : 0

// Protobuf/Connect safeguards (0 = no limit, default behaviour)
const PROTOBUF_MAX_FIELDS = Number.isFinite(Number(process.env.PROXY_PROTOBUF_MAX_FIELDS))
  ? Math.max(0, Number(process.env.PROXY_PROTOBUF_MAX_FIELDS))
  : 0

const PROTOBUF_MAX_BYTES = Number.isFinite(Number(process.env.PROXY_PROTOBUF_MAX_BYTES))
  ? Math.max(0, Number(process.env.PROXY_PROTOBUF_MAX_BYTES))
  : 0

const CONNECT_MAX_FRAMES = Number.isFinite(Number(process.env.PROXY_CONNECT_MAX_FRAMES))
  ? Math.max(0, Number(process.env.PROXY_CONNECT_MAX_FRAMES))
  : 0

const CONNECT_MAX_FRAME_BYTES = Number.isFinite(Number(process.env.PROXY_CONNECT_MAX_FRAME_BYTES))
  ? Math.max(0, Number(process.env.PROXY_CONNECT_MAX_FRAME_BYTES))
  : 0

// WebSocket text frame size limit (0 = no limit, default behaviour)
const WS_MAX_TEXT_BYTES = Number.isFinite(Number(process.env.PROXY_WS_MAX_TEXT_BYTES))
  ? Math.max(0, Number(process.env.PROXY_WS_MAX_TEXT_BYTES))
  : 0

// Optional flag to disable WebSocket body capture and rewrites for high-throughput
// channels. When false, connection events and basic metadata are still logged,
// but message bodies are not decoded or rewritten.
const WS_LOG_BODY_ENABLED =
  typeof process.env.PROXY_WS_LOG_BODY_ENABLED === 'string'
    ? ['1', 'true', 'yes'].includes(process.env.PROXY_WS_LOG_BODY_ENABLED.toLowerCase())
    : true

// Upstream HTTP client timeouts (0 = use Undici defaults)
const UPSTREAM_HEADERS_TIMEOUT_MS = Number.isFinite(
  Number(process.env.PROXY_UPSTREAM_HEADERS_TIMEOUT_MS)
)
  ? Math.max(0, Number(process.env.PROXY_UPSTREAM_HEADERS_TIMEOUT_MS))
  : 0

const UPSTREAM_BODY_TIMEOUT_MS = Number.isFinite(Number(process.env.PROXY_UPSTREAM_BODY_TIMEOUT_MS))
  ? Math.max(0, Number(process.env.PROXY_UPSTREAM_BODY_TIMEOUT_MS))
  : 0

// HTTP/2 towards TLS upstreams that offer it through ALPN (undici `allowH2`;
// plain http upstreams stay HTTP/1.1). Off by default: h1-only upstreams are
// not affected either way, but h2 changes the header semantics
// (pseudo-headers, no connection-specific headers), so it is opt-in.
const UPSTREAM_H2 =
  typeof process.env.PROXY_UPSTREAM_H2 === 'string'
    ? ['1', 'true', 'yes'].includes(process.env.PROXY_UPSTREAM_H2.toLowerCase())
    : false

// Streaming: responses that no rule can rewrite and that need no inspection
// for logging (interactive mode off, clearly binary content, event streams,
// bodies larger than STREAM_THRESHOLD_BYTES) are piped to the client as they
// arrive instead of being buffered. Applies to the plain HTTP and the HTTPS
// MITM paths; set to false to buffer every response as older versions did.
const STREAM_UNINSPECTED_RESPONSES =
  typeof process.env.PROXY_STREAM_UNINSPECTED_RESPONSES === 'string'
    ? ['1', 'true', 'yes'].includes(process.env.PROXY_STREAM_UNINSPECTED_RESPONSES.toLowerCase())
    : true

// Declared content-length above which a response is streamed even with
// interactive logging on (0 = never stream by size alone). Default 1 MiB.
const STREAM_THRESHOLD_BYTES = Number.isFinite(Number(process.env.PROXY_STREAM_THRESHOLD_BYTES))
  ? Math.max(0, Number(process.env.PROXY_STREAM_THRESHOLD_BYTES))
  : 1024 * 1024

// Controls whether HTTPS MITM "direct" flows still apply header/body rewrites
// (Connect/JSONPath/text). Defaults to true to preserve existing behaviour;
// when disabled, direct MITM traffic is forwarded with minimal processing,
// similar to the plain HTTP bypass path.
const MITM_BYPASS_REWRITES_ENABLED =
  typeof process.env.PROXY_MITM_BYPASS_REWRITES_ENABLED === 'string'
    ? ['1', 'true', 'yes'].includes(process.env.PROXY_MITM_BYPASS_REWRITES_ENABLED.toLowerCase())
    : true

// Debug/diagnostic logging (false by default to preserve current behaviour).
const DEBUG_LOG_ENABLED =
  typeof process.env.PROXY_DEBUG_LOG === 'string'
    ? ['1', 'true', 'yes'].includes(process.env.PROXY_DEBUG_LOG.toLowerCase())
    : false

// Level of the structured logger (pino): PROXY_LOG_LEVEL wins, otherwise
// PROXY_DEBUG_LOG=true means debug and the default is info.
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']
const envLogLevel =
  typeof process.env.PROXY_LOG_LEVEL === 'string'
    ? process.env.PROXY_LOG_LEVEL.trim().toLowerCase()
    : ''
const LOG_LEVEL = LOG_LEVELS.includes(envLogLevel)
  ? envLogLevel
  : DEBUG_LOG_ENABLED
    ? 'debug'
    : 'info'

// Output of the logger: `json` (one object per line, for pino-pretty and log
// collectors) or `pretty` (`[proxy][scope] message` lines through the
// console). Default: pretty on a terminal, json when stdout is piped.
const envLogFormat =
  typeof process.env.PROXY_LOG_FORMAT === 'string'
    ? process.env.PROXY_LOG_FORMAT.trim().toLowerCase()
    : ''
const LOG_FORMAT =
  envLogFormat === 'json' || envLogFormat === 'pretty'
    ? envLogFormat
    : process.stdout.isTTY
      ? 'pretty'
      : 'json'

// TLS strictness for upstream connections (false by default to preserve current dev behaviour).
const STRICT_TLS_ENABLED =
  typeof process.env.PROXY_STRICT_TLS === 'string'
    ? ['1', 'true', 'yes'].includes(process.env.PROXY_STRICT_TLS.toLowerCase())
    : false

// Optional CA bundle path for strict TLS mode (PEM file). When provided and
// STRICT_TLS_ENABLED is true, it will be used as an additional trust anchor
// for upstream TLS connections (HTTPS / WSS / raw TLS tunnels).
const STRICT_TLS_CA_FILE =
  typeof process.env.PROXY_STRICT_TLS_CA_FILE === 'string'
    ? process.env.PROXY_STRICT_TLS_CA_FILE
    : ''

// Body size limit for parsers (Express bodyParser & raw)
// Keep default at 50mb to match current behavior.
const BODY_LIMIT = process.env.PROXY_BODY_LIMIT || '10mb'

module.exports = {
  PORT,
  HOST,
  UI_PORT,
  UI_ORIGINS,
  ROOT_DIR,
  STORAGE_DIR,
  LOGS_DIR,
  CERTS_DIR,
  MAX_LOG_ENTRIES,
  LOG_PREVIEW_MAX_BYTES,
  LOG_DECOMPRESS_MAX_BYTES,
  MITM_BYPASS_REWRITES_ENABLED,
  DEBUG_LOG_ENABLED,
  LOG_LEVEL,
  LOG_FORMAT,
  STRICT_TLS_ENABLED,
  STRICT_TLS_CA_FILE,
  PROTOBUF_MAX_FIELDS,
  PROTOBUF_MAX_BYTES,
  CONNECT_MAX_FRAMES,
  CONNECT_MAX_FRAME_BYTES,
  WS_MAX_TEXT_BYTES,
  UPSTREAM_HEADERS_TIMEOUT_MS,
  UPSTREAM_BODY_TIMEOUT_MS,
  UPSTREAM_H2,
  STREAM_UNINSPECTED_RESPONSES,
  STREAM_THRESHOLD_BYTES,
  WS_LOG_BODY_ENABLED,
  BODY_LIMIT
}
