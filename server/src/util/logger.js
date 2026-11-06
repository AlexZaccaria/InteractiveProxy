'use strict'

/**
 * Structured logging helpers used for internal diagnostics.
 *
 * - logDebug: gated by DEBUG_LOG_ENABLED so it can be safely enabled in
 *   development without impacting production noise levels.
 * - logWarn: always logged (console.warn) for misconfigurations and
 *   unexpected but non-fatal conditions.
 */

const { DEBUG_LOG_ENABLED } = require('../../config')

/**
 * @typedef {'debug' | 'warn' | 'error' | 'info' | 'log'} LogLevel
 */

/**
 * Write one line to the console, optionally gated by the debug flag.
 *
 * @param {LogLevel} level Console method to use.
 * @param {boolean} gated When true the line is written only if DEBUG_LOG_ENABLED is set.
 * @param {string} scope Short tag identifying the subsystem.
 * @param {string} message
 * @param {unknown} [error] Optional error (or any value) appended to the line.
 * @returns {void}
 */
const logInternal = (level, gated, scope, message, error) => {
  if (gated && !DEBUG_LOG_ENABLED) return
  console[level](`[proxy][${scope}] ${message}`, ...(error ? [error] : []))
}

/**
 * @param {string} scope
 * @param {string} msg
 * @param {unknown} [err]
 * @returns {void}
 */
const logDebug = (scope, msg, err) => logInternal('debug', true, scope, msg, err)

/**
 * @param {string} scope
 * @param {string} msg
 * @param {unknown} [err]
 * @returns {void}
 */
const logWarn = (scope, msg, err) => logInternal('warn', false, scope, msg, err)

module.exports = {
  logInternal,
  logDebug,
  logWarn
}
