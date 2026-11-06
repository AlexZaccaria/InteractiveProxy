'use strict'

/**
 * Small string and query-parameter helpers shared by the whole server.
 *
 * All helpers are total functions: any input is accepted and a safe default
 * is returned for values of the wrong type.
 */

/**
 * Trim a value when it is a string, otherwise return an empty string.
 *
 * @param {unknown} value
 * @returns {string}
 */
function safeTrim (value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Parse a query parameter as a boolean. Returns true if the value is 'true'
 * (case-insensitive), false otherwise.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function queryBool (value) {
  return String(value || '').toLowerCase() === 'true'
}

/**
 * Safely extract a string value, returning empty string for non-strings.
 * Unlike safeTrim, this preserves whitespace.
 *
 * @param {unknown} value
 * @returns {string}
 */
function safeString (value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Parse a comma-separated list query parameter (a string or an array of
 * strings) into a de-duplicated array of trimmed entries. When the parameter
 * carries no entries, a copy of `defaultList` is returned.
 *
 * @param {unknown} value
 * @param {string[]} [defaultList]
 * @returns {string[]}
 */
function parseListQuery (value, defaultList = []) {
  if (Array.isArray(value)) {
    const parts = value
      .flatMap(v => String(v || '').split(','))
      .map(v => v.trim())
      .filter(Boolean)
    return parts.length ? Array.from(new Set(parts)) : [...defaultList]
  }

  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
    return parts.length ? Array.from(new Set(parts)) : [...defaultList]
  }

  return [...defaultList]
}

/**
 * Validate that an ID is a non-empty string.
 *
 * @param {unknown} id
 * @returns {id is string}
 */
function isValidId (id) {
  return typeof id === 'string' && id.trim().length > 0
}

module.exports = {
  safeTrim,
  queryBool,
  safeString,
  parseListQuery,
  isValidId
}
