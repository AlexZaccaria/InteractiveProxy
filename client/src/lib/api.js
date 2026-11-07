import { buildApiUrl } from '../config/apiConfig'

/**
 * The management API client: JSON in and out over `fetch`, one error type.
 */

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status of the response.
   * @param {any} body Parsed response body (JSON when possible, text otherwise).
   * @param {string} message
   */
  constructor(status, body, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

/**
 * @typedef {Object} RequestOptions
 * @property {AbortSignal} [signal]
 * @property {Record<string, string | number | boolean | null | undefined>} [query]
 */

/**
 * Append query parameters to an API path; `null`/`undefined` values are skipped.
 *
 * @param {string} path
 * @param {RequestOptions['query']} [query]
 * @returns {string}
 */
function withQuery(path, query) {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue
    params.set(key, String(value))
  }
  const encoded = params.toString()
  if (!encoded) return path
  return `${path}${path.includes('?') ? '&' : '?'}${encoded}`
}

/**
 * Parse a response body: `204` → null, JSON when it parses, text otherwise.
 *
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function parseBody(response) {
  if (response.status === 204) return null
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * @param {any} body
 * @param {number} status
 * @returns {string}
 */
function errorMessage(body, status) {
  if (body && typeof body === 'object') {
    if (typeof body.error === 'string' && body.error) return body.error
    if (typeof body.message === 'string' && body.message) return body.message
  }
  if (typeof body === 'string' && body.trim()) return body.trim()
  return `HTTP ${status}`
}

/**
 * @param {string} method
 * @param {string} path
 * @param {{ body?: any, formData?: FormData } & RequestOptions} [options]
 * @returns {Promise<any>}
 */
async function request(method, path, options = {}) {
  const { body, formData, signal, query } = options
  /** @type {Record<string, string>} */
  const headers = {}
  /** @type {BodyInit | undefined} */
  let payload
  if (formData) {
    payload = formData
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const response = await fetch(buildApiUrl(withQuery(path, query)), {
    method,
    headers,
    body: payload,
    signal
  })
  const data = await parseBody(response)
  if (!response.ok) {
    throw new ApiError(response.status, data, errorMessage(data, response.status))
  }
  return data
}

/**
 * @param {string} path
 * @param {RequestOptions} [options]
 * @returns {Promise<any>}
 */
export function apiGet(path, options) {
  return request('GET', path, options)
}

/**
 * @param {string} path
 * @param {any} [body]
 * @param {RequestOptions} [options]
 * @returns {Promise<any>}
 */
export function apiPost(path, body, options) {
  return request('POST', path, { ...options, body })
}

/**
 * @param {string} path
 * @param {any} [body]
 * @param {RequestOptions} [options]
 * @returns {Promise<any>}
 */
export function apiPut(path, body, options) {
  return request('PUT', path, { ...options, body })
}

/**
 * @param {string} path
 * @param {RequestOptions} [options]
 * @returns {Promise<any>}
 */
export function apiDelete(path, options) {
  return request('DELETE', path, options)
}

/**
 * Multipart upload; the browser sets the boundary header.
 *
 * @param {string} path
 * @param {FormData} formData
 * @param {RequestOptions} [options]
 * @returns {Promise<any>}
 */
export function apiUpload(path, formData, options) {
  return request('POST', path, { ...options, formData })
}
