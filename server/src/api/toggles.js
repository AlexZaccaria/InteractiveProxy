'use strict'

/**
 * Boolean toggle endpoints of the management API (`POST /api/*-mode`):
 * payload validation and the shared handler.
 *
 * @module api/toggles
 */

/**
 * @typedef {object} TogglePayloadResult
 * @property {boolean} ok
 * @property {boolean} value The validated flag, or `defaultEnabled` when invalid.
 * @property {string} [error]
 */

/**
 * Normalize a simple toggle payload coming from the UI.
 *
 * `enabled` must be present and must be a boolean; a missing or invalid
 * value produces a 400 with a clear message.
 *
 * @param {unknown} body
 * @param {boolean} defaultEnabled
 * @returns {TogglePayloadResult}
 */
function validateTogglePayload(body, defaultEnabled) {
  const source =
    body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {}

  if (!Object.hasOwn(source, 'enabled')) {
    return {
      ok: false,
      value: defaultEnabled,
      error: 'Missing "enabled" flag: expected a boolean.'
    }
  }

  const { enabled } = source

  if (typeof enabled === 'boolean') {
    return { ok: true, value: enabled }
  }

  return {
    ok: false,
    value: defaultEnabled,
    error: 'Invalid "enabled" flag: expected a boolean.'
  }
}

/**
 * @typedef {object} ToggleEndpointParams
 * @property {import('express').Request} req
 * @property {import('express').Response} res
 * @property {(value: boolean) => void} assignValue Store the validated flag.
 * @property {string} responseFieldName Name of the flag in the JSON answer.
 * @property {boolean} [defaultEnabled]
 * @property {() => void} persist Write the configuration after the change.
 */

/**
 * Validate the payload, apply the flag, persist and answer `{ success, <field> }`.
 *
 * @param {ToggleEndpointParams} params
 * @returns {import('express').Response}
 */
function handleBooleanToggleEndpoint({
  req,
  res,
  assignValue,
  responseFieldName,
  defaultEnabled = true,
  persist
}) {
  const result = validateTogglePayload(req.body, defaultEnabled)
  if (!result.ok) {
    return res.status(400).json({ error: result.error })
  }

  assignValue(result.value)
  persist()

  /** @type {Record<string, boolean>} */
  const payload = { success: true }
  payload[responseFieldName] = result.value
  return res.json(payload)
}

module.exports = {
  validateTogglePayload,
  handleBooleanToggleEndpoint
}
