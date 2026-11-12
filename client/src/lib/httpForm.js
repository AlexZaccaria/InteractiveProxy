/**
 * Helpers shared by the forms that edit an HTTP request or response by hand
 * (the replay form and the breakpoint editor): the header lines, the sizes
 * and the field styles.
 */

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const FIELD_CLASS =
  'w-full px-3 bg-surface border border-edge rounded-lg text-xs text-fg placeholder-fg-faint focus:outline-hidden focus:ring-1 focus:ring-blue-500'
export const INPUT_CLASS = `${FIELD_CLASS} h-8`
export const TEXTAREA_CLASS = `${FIELD_CLASS} py-2 font-mono resize-y`
export const LABEL_CLASS = 'block text-[11px] text-fg-muted mb-1'

/**
 * Parse the header lines of a form, one `name: value` per line; blank
 * lines are ignored.
 *
 * @param {string} text
 * @returns {{ headers: Record<string, string>, error: string | null }}
 */
export function parseHeaderLines(text) {
  /** @type {Record<string, string>} */
  const headers = {}
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) continue
    const colon = line.indexOf(':')
    if (colon <= 0) {
      return { headers, error: `Line ${index + 1} is not "name: value"` }
    }
    const name = line.slice(0, colon).trim()
    if (!HEADER_NAME_PATTERN.test(name)) {
      return { headers, error: `Line ${index + 1}: "${name}" is not a valid header name` }
    }
    headers[name] = line.slice(colon + 1).trim()
  }
  return { headers, error: null }
}

/**
 * @param {Record<string, string> | undefined} headers
 * @returns {string}
 */
export function formatHeaderLines(headers) {
  return Object.entries(headers || {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
