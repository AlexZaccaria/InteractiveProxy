'use strict'

/**
 * http(s) -> ws(s) URL conversion for WebSocket targets. Targets travel
 * through the routing layer as their HTTP equivalent (see `parseUrlCandidate`
 * in rules/url-match.js) and are converted back when a connection is opened.
 */

/**
 * Convert an HTTP(S) URL string to its WebSocket equivalent. Existing ws:/wss:
 * URLs are returned unchanged.
 *
 * @param {string} url
 * @returns {string}
 */
function httpUrlToWebSocketUrl (url = '') {
  if (!url) return ''
  if (/^wss?:\/\//i.test(url)) return url
  // Only the scheme at the start is rewritten, never a URL inside the query.
  return url.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://')
}

module.exports = { httpUrlToWebSocketUrl }
