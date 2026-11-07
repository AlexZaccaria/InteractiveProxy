/**
 * Pure helpers behind the clickable JSON tree: the path of a node in the
 * dialect the server's JSONPath rules use (`root.items[0].name`), the value
 * found at that path, and the seed of a rewrite rule built from a node.
 */

/**
 * A react-json-tree key path: the node's own key first, the root label last.
 *
 * @typedef {Array<string | number>} KeyPath
 */

/**
 * @typedef {Object} JsonPathRuleSeed
 * @property {'jsonPath'} kind
 * @property {string} path
 * @property {'string'} valueType
 * @property {string} value
 * @property {string} name
 * @property {string} url
 * @property {'request' | 'response' | 'both'} target
 */

/**
 * @param {unknown} key
 * @returns {boolean}
 */
export function isNumericJsonKey(key) {
  if (typeof key === 'number') {
    return Number.isInteger(key) && key >= 0
  }
  if (typeof key === 'string') {
    const trimmed = key.trim()
    if (!trimmed) return false
    return /^\d+$/.test(trimmed)
  }
  return false
}

/**
 * Build the JSONPath of a node. The synthetic root label is dropped and the
 * path always starts with `root`; numeric keys become indexes.
 *
 * - `['f1', 'root']` → `root.f1`
 * - `['0', 'items', 'root']` → `root.items[0]`
 *
 * @param {KeyPath} keyPath
 * @returns {string}
 */
export function buildJsonPathFromKeyPath(keyPath) {
  if (!Array.isArray(keyPath) || keyPath.length === 0) return 'root'

  const full = [...keyPath].reverse() // [root, parent, ..., current]
  const segments = full.slice(1)

  let path = 'root'
  for (const segment of segments) {
    if (isNumericJsonKey(segment)) {
      const index =
        typeof segment === 'number' ? segment : Number.parseInt(String(segment).trim(), 10)
      if (Number.isFinite(index) && index >= 0) {
        path += `[${index}]`
      } else {
        path += `.${String(segment)}`
      }
    } else {
      path += `.${String(segment)}`
    }
  }

  return path
}

/**
 * The value at a key path inside `root`, or `undefined` when the path does
 * not exist.
 *
 * @param {unknown} root
 * @param {KeyPath} [keyPath]
 * @returns {unknown}
 */
export function resolveJsonValueFromKeyPath(root, keyPath = []) {
  if (root === null || root === undefined) return undefined
  if (!Array.isArray(keyPath) || keyPath.length === 0) return root

  const full = [...keyPath].reverse()
  const segments = full.slice(1)

  /** @type {any} */
  let current = root
  for (const segment of segments) {
    if (current == null) return undefined

    if (Array.isArray(current)) {
      let index = null
      if (isNumericJsonKey(segment)) {
        index = typeof segment === 'number' ? segment : Number.parseInt(String(segment).trim(), 10)
      }
      if (index === null || !Number.isFinite(index) || index < 0 || index >= current.length) {
        return undefined
      }
      current = current[index]
    } else if (typeof current === 'object') {
      const key = String(segment)
      if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined
      current = current[key]
    } else {
      return undefined
    }
  }

  return current
}

/**
 * The last non-empty path segment of a URL pattern, without query and hash
 * (`https://h/api/GetChatMessage?x=1` → `GetChatMessage`).
 *
 * @param {unknown} pattern
 * @returns {string}
 */
export function extractEndpointNameFromUrlPattern(pattern) {
  if (!pattern || typeof pattern !== 'string') return ''
  let cleaned = pattern.trim()
  if (!cleaned) return ''

  cleaned = cleaned.split('#')[0]
  cleaned = cleaned.split('?')[0]
  cleaned = cleaned.replace(/\/+$/, '')

  const parts = cleaned.split('/').filter(Boolean)
  if (!parts.length) return cleaned
  return parts[parts.length - 1]
}

/**
 * True for the synthetic node react-json-tree draws for the root value.
 *
 * @param {KeyPath} keyPath
 * @returns {boolean}
 */
export function isJsonTreeRootNode(keyPath) {
  if (!Array.isArray(keyPath) || keyPath.length !== 1) return false
  const [key] = keyPath
  return key === 'root' || key === 'ROOT' || key === '$'
}

/**
 * The textual value a rewrite rule starts from: primitives as they are,
 * objects pretty-printed, `null` and `undefined` as the empty string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatJsonValueForRule(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * The seed of a JSONPath rule for the node at `keyPath`: the path, the
 * current value as text, a name made of the endpoint (or the context label)
 * and the path, the URL pattern and the target phase.
 *
 * @param {{ keyPath: KeyPath, rootData: unknown, urlPattern?: unknown, contextLabel?: string, target?: string }} input
 * @returns {JsonPathRuleSeed}
 */
export function buildJsonPathRuleSeed({ keyPath, rootData, urlPattern, contextLabel, target }) {
  const path = buildJsonPathFromKeyPath(keyPath)
  const value = formatJsonValueForRule(resolveJsonValueFromKeyPath(rootData, keyPath))
  const url = typeof urlPattern === 'string' ? urlPattern : ''

  const endpointName = extractEndpointNameFromUrlPattern(url)
  const namePrefix = endpointName || contextLabel || ''
  const name = namePrefix ? `${namePrefix}: ${path}` : path

  /** @type {'request' | 'response' | 'both'} */
  const normalizedTarget = target === 'response' || target === 'both' ? target : 'request'

  return {
    kind: 'jsonPath',
    path,
    valueType: 'string',
    value,
    name,
    url,
    target: normalizedTarget
  }
}
