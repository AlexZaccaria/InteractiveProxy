'use strict'

/**
 * Structured logging for the server, built on pino.
 *
 * Every line carries a `scope` (subsystem tag) and a message; an Error goes
 * in `err` (pino's standard serializer: type, message, stack), any other
 * detail value in `detail`. Two output formats, chosen by config.LOG_FORMAT
 * (PROXY_LOG_FORMAT, default `pretty` on a terminal and `json` when piped):
 * - `json`: one JSON object per line on stdout, for `pino-pretty`, log
 *   collectors and CI;
 * - `pretty`: the historical `[proxy][scope] message` lines written through
 *   `console.debug/log/warn/error`, so warnings and errors still reach
 *   stderr and tests can capture them by replacing `console.warn`.
 * The level comes from config.LOG_LEVEL (PROXY_LOG_LEVEL; PROXY_DEBUG_LOG=true
 * implies debug).
 */

const pino = require('pino')
const { LOG_LEVEL, LOG_FORMAT } = require('../../config')

/**
 * @typedef {'debug' | 'warn' | 'error' | 'info' | 'log'} LogLevel
 */

/**
 * @typedef {object} PrettyRecord
 * @property {number} [level]
 * @property {string} [scope]
 * @property {string} [msg]
 * @property {{ stack?: string, message?: string }} [err]
 * @property {unknown} [detail]
 */

/**
 * Console method matching a pino level number.
 *
 * @param {number} level
 * @returns {'debug' | 'log' | 'warn' | 'error'}
 */
function consoleMethodFor(level) {
  if (level >= 50) return 'error'
  if (level >= 40) return 'warn'
  if (level >= 30) return 'log'
  return 'debug'
}

/**
 * Destination for the pretty format: takes the record pino serialised and
 * prints `[proxy][scope] message` plus the error (or detail) through the
 * console method of the level.
 */
const prettyDestination = {
  /**
   * @param {string} line
   * @returns {void}
   */
  write(line) {
    /** @type {PrettyRecord} */
    let record
    try {
      record = JSON.parse(line)
    } catch {
      // Not a pino record (cannot happen with our own logger): pass through.
      process.stdout.write(line)
      return
    }
    const method = consoleMethodFor(record.level ?? 30)
    const prefix = record.scope ? `[proxy][${record.scope}]` : '[proxy]'
    /** @type {unknown[]} */
    const args = [`${prefix} ${record.msg ?? ''}`]
    if (record.err) {
      args.push(record.err.stack || record.err.message || record.err)
    } else if (record.detail !== undefined) {
      args.push(record.detail)
    }
    console[method](...args)
  }
}

const logger = pino(
  {
    level: LOG_LEVEL,
    base: null,
    serializers: { err: pino.stdSerializers.err },
    timestamp: pino.stdTimeFunctions.isoTime
  },
  LOG_FORMAT === 'pretty' ? prettyDestination : pino.destination({ fd: 1, sync: true })
)

/**
 * Write one line at the given level. `gated` is kept for API compatibility:
 * debug lines are now filtered by the logger level (config.LOG_LEVEL), which
 * PROXY_DEBUG_LOG=true lowers to debug.
 *
 * @param {LogLevel} level
 * @param {boolean} _gated
 * @param {string} scope Short tag identifying the subsystem.
 * @param {string} message
 * @param {unknown} [error] Optional Error (serialised as `err`) or any detail value.
 * @returns {void}
 */
const logInternal = (level, _gated, scope, message, error) => {
  const method = level === 'log' ? 'info' : level
  /** @type {{ scope: string, err?: Error, detail?: unknown }} */
  const fields = { scope }
  if (error instanceof Error) {
    fields.err = error
  } else if (error !== undefined && error !== null) {
    fields.detail = error
  }
  logger[method](fields, message)
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
const logInfo = (scope, msg, err) => logInternal('info', false, scope, msg, err)

/**
 * @param {string} scope
 * @param {string} msg
 * @param {unknown} [err]
 * @returns {void}
 */
const logWarn = (scope, msg, err) => logInternal('warn', false, scope, msg, err)

/**
 * @param {string} scope
 * @param {string} msg
 * @param {unknown} [err]
 * @returns {void}
 */
const logError = (scope, msg, err) => logInternal('error', false, scope, msg, err)

/**
 * The underlying pino instance (child loggers, custom fields).
 *
 * @returns {import('pino').Logger}
 */
const getLogger = () => logger

module.exports = {
  logInternal,
  logDebug,
  logInfo,
  logWarn,
  logError,
  getLogger
}
