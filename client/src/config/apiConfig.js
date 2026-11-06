import { UI_PORT, BACKEND_PORT, BACKEND_HOST, BACKEND_PROTOCOL } from './generatedPorts';

/**
 * Port where the React UI is expected to run in development.
 *
 * Value is sourced from the auto-generated `generatedPorts` module, which in
 * turn is derived from the root `ports.config.json`. Tooling and scripts are
 * responsible for actually serving the UI on this port during development.
 *
 * @type {number}
 */
export { UI_PORT };

/**
 * Port where the proxy/backend HTTP server listens.
 *
 * Sourced from the auto-generated `generatedPorts` module, keeping it
 * synchronized with the backend configuration and root `ports.config.json`.
 *
 * @type {number}
 */
export { BACKEND_PORT };

/**
 * Hostname for the backend server.
 *
 * @type {string}
 */
export { BACKEND_HOST };

/**
 * Protocol used to talk to the backend server.
 *
 * @type {'http' | 'https'}
 */
export { BACKEND_PROTOCOL };

/**
 * True when the UI is being served by the proxy itself (production build
 * under /ui) rather than by the CRA dev server: API calls then stay on the
 * current origin instead of the configured backend host/port.
 *
 * @type {boolean}
 */
const SERVED_BY_BACKEND =
  typeof window !== 'undefined' &&
  window.location &&
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
