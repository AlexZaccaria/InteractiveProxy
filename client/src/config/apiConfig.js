/**
 * Ports and base URL of the backend.
 *
 * The values come from `ports.config.json` at the repository root, injected
 * by `vite.config.js` as the compile-time constant `__PROXY_PORTS__`.
 */

/**
 * @typedef {Object} ProxyPorts
 * @property {number} uiPort Port of the UI development server.
 * @property {number} backendPort Port the proxy listens on.
 * @property {string} backendHost Host name of the proxy.
 * @property {'http' | 'https'} backendProtocol Protocol used to reach the proxy.
 */

/* global __PROXY_PORTS__ */

/** @type {ProxyPorts} */
const ports = typeof __PROXY_PORTS__ !== 'undefined'
  ? __PROXY_PORTS__
  : { uiPort: 3050, backendPort: 8050, backendHost: 'localhost', backendProtocol: 'http' };

/**
 * Port where the UI development server runs.
 *
 * @type {number}
 */
export const UI_PORT = ports.uiPort;

/**
 * Port where the proxy/backend HTTP server listens.
 *
 * @type {number}
 */
export const BACKEND_PORT = ports.backendPort;

/**
 * Hostname for the backend server.
 *
 * @type {string}
 */
export const BACKEND_HOST = ports.backendHost;

/**
 * Protocol used to talk to the backend server.
 *
 * @type {'http' | 'https'}
 */
export const BACKEND_PROTOCOL = ports.backendProtocol;

/**
 * True when the UI is being served by the proxy itself (production build)
 * rather than by the development server: API calls then stay on the current
 * origin instead of the configured backend host/port.
 *
 * @type {boolean}
 */
const SERVED_BY_BACKEND =
  typeof window !== 'undefined' &&
  Boolean(window.location) &&
  String(window.location.port) === String(BACKEND_PORT);

/**
 * Base URL for all backend API requests.
 *
 * Example: "http://localhost:8050", or "" (same origin) when the UI is served
 * by the proxy.
 *
 * @type {string}
 */
export const API_BASE_URL = SERVED_BY_BACKEND
  ? ''
  : `${BACKEND_PROTOCOL}://${BACKEND_HOST}:${BACKEND_PORT}`;

/**
 * Build a fully-qualified backend URL from a relative API path.
 *
 * If an absolute URL is provided, it is returned unchanged. Otherwise
 * the path is resolved against {@link API_BASE_URL}.
 *
 * @param {string} path Relative path such as "/api/logs" or "api/logs".
 * @returns {string} Fully-qualified backend URL.
 */
export function buildApiUrl(path) {
  if (!path) {
    return API_BASE_URL;
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}
