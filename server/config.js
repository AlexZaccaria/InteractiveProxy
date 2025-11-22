'use strict'

const path = require('path')

// Ports
const PORT = Number(process.env.PROXY_PORT) || 8080

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
  : 1000

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
const WS_LOG_BODY_ENABLED = typeof process.env.PROXY_WS_LOG_BODY_ENABLED === 'string'
  ? ['1', 'true', 'yes'].includes(process.env.PROXY_WS_LOG_BODY_ENABLED.toLowerCase())
  : true

// Upstream HTTP client timeouts (0 = use Undici defaults)
const UPSTREAM_HEADERS_TIMEOUT_MS = Number.isFinite(Number(process.env.PROXY_UPSTREAM_HEADERS_TIMEOUT_MS))
  ? Math.max(0, Number(process.env.PROXY_UPSTREAM_HEADERS_TIMEOUT_MS))
  : 0

const UPSTREAM_BODY_TIMEOUT_MS = Number.isFinite(Number(process.env.PROXY_UPSTREAM_BODY_TIMEOUT_MS))
  ? Math.max(0, Number(process.env.PROXY_UPSTREAM_BODY_TIMEOUT_MS))
  : 0

// Streaming optimisation: when enabled, large binary responses that cannot be
// rewritten (no active rules, non‑textual content types) may be streamed
// directly to the client instead of being fully buffered for inspection.
// Defaults to false to preserve current behaviour.
const STREAM_UNINSPECTED_RESPONSES = typeof process.env.PROXY_STREAM_UNINSPECTED_RESPONSES === 'string'
  ? ['1', 'true', 'yes'].includes(process.env.PROXY_STREAM_UNINSPECTED_RESPONSES.toLowerCase())
  : false

// Controls whether HTTPS MITM "direct" flows still apply header/body rewrites
// (Connect/JSONPath/text). Defaults to true to preserve existing behaviour;
// when disabled, direct MITM traffic is forwarded with minimal processing,
// similar to the plain HTTP bypass path.
const MITM_BYPASS_REWRITES_ENABLED = typeof process.env.PROXY_MITM_BYPASS_REWRITES_ENABLED === 'string'
  ? ['1', 'true', 'yes'].includes(process.env.PROXY_MITM_BYPASS_REWRITES_ENABLED.toLowerCase())
  : true

// Debug/diagnostic logging (false by default to preserve current behaviour).
const DEBUG_LOG_ENABLED = typeof process.env.PROXY_DEBUG_LOG === 'string'
  ? ['1', 'true', 'yes'].includes(process.env.PROXY_DEBUG_LOG.toLowerCase())
  : false

// TLS strictness for upstream connections (false by default to preserve current dev behaviour).
const STRICT_TLS_ENABLED = typeof process.env.PROXY_STRICT_TLS === 'string'
  ? ['1', 'true', 'yes'].includes(process.env.PROXY_STRICT_TLS.toLowerCase())
  : false

// Optional CA bundle path for strict TLS mode (PEM file). When provided and
// STRICT_TLS_ENABLED is true, it will be used as an additional trust anchor
// for upstream TLS connections (HTTPS / WSS / raw TLS tunnels).
const STRICT_TLS_CA_FILE = typeof process.env.PROXY_STRICT_TLS_CA_FILE === 'string'
  ? process.env.PROXY_STRICT_TLS_CA_FILE
  : ''

// Body size limit for parsers (Express bodyParser & raw)
// Keep default at 50mb to match current behavior.
const BODY_LIMIT = process.env.PROXY_BODY_LIMIT || '10mb'

module.exports = {
  PORT,
  ROOT_DIR,
  STORAGE_DIR,
  LOGS_DIR,
  CERTS_DIR,
  MAX_LOG_ENTRIES,
  LOG_PREVIEW_MAX_BYTES,
  LOG_DECOMPRESS_MAX_BYTES,
  MITM_BYPASS_REWRITES_ENABLED,
  DEBUG_LOG_ENABLED,
  STRICT_TLS_ENABLED,
  STRICT_TLS_CA_FILE,
  PROTOBUF_MAX_FIELDS,
  PROTOBUF_MAX_BYTES,
  CONNECT_MAX_FRAMES,
  CONNECT_MAX_FRAME_BYTES,
  WS_MAX_TEXT_BYTES,
  UPSTREAM_HEADERS_TIMEOUT_MS,
  UPSTREAM_BODY_TIMEOUT_MS,
  STREAM_UNINSPECTED_RESPONSES,
  WS_LOG_BODY_ENABLED,
  BODY_LIMIT
}
