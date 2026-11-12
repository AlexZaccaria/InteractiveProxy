'use strict'

/**
 * Local resources: uploaded files or inline text served in place of the
 * upstream when a request URL matches. Metadata lives in `resources.json`
 * under the storage directory, the payloads in files next to it.
 *
 * @module resources/store
 */

const fs = require('fs')
const path = require('path')
const fsPromises = fs.promises
const { safeString } = require('../util/strings')
const { logError } = require('../util/logger')

/**
 * @typedef {object} LocalResource
 * @property {'file' | 'text' | 'folder'} [type]
 * @property {string} filename File under the storage directory (empty for a folder).
 * @property {string} [originalName]
 * @property {string} contentType Empty for a folder: the type follows the file served.
 * @property {number} [size]
 * @property {string} [createdAt]
 * @property {boolean} [enabled] Disabled resources are never served.
 * @property {string} [path] Folder mapping: the directory the request path is resolved in.
 * @property {boolean} [fallthrough] Folder mapping: forward to the upstream when the file is missing.
 */

/**
 * A resource resolved for one request: a folder mapping carries the file
 * found (`absolutePath`, its content type) or `status: 404` when the
 * mapping answers the miss itself.
 *
 * @typedef {LocalResource & { absolutePath?: string, status?: number }} ResolvedResource
 */

/**
 * Content types by extension for the files served from a mapped folder.
 *
 * @type {Record<string, string>}
 */
const CONTENT_TYPES_BY_EXTENSION = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function contentTypeForFile(filePath) {
  return (
    CONTENT_TYPES_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  )
}

/**
 * The file a folder mapping serves for a request: the part of the URL path
 * after the mapped prefix, resolved inside the folder (never outside it; a
 * path ending in `/` or empty means `index.html`). Null when there is no
 * such file.
 *
 * @param {string} folder
 * @param {string} resourceUrl The mapped prefix.
 * @param {string} requestUrl
 * @param {string} fullUrl
 * @returns {{ absolutePath: string, contentType: string } | null}
 */
function resolveFolderFile(folder, resourceUrl, requestUrl, fullUrl) {
  const source = fullUrl && fullUrl.includes(resourceUrl) ? fullUrl : requestUrl
  const index = source.indexOf(resourceUrl)
  if (index === -1) return null
  let remainder = source.slice(index + resourceUrl.length)
  const stop = remainder.search(/[?#]/)
  if (stop !== -1) remainder = remainder.slice(0, stop)
  try {
    remainder = decodeURIComponent(remainder)
  } catch {
    return null
  }
  if (remainder.includes('\0')) return null
  if (remainder === '' || remainder.endsWith('/')) remainder = `${remainder}index.html`

  const root = path.resolve(folder)
  const absolutePath = path.resolve(
    root,
    `.${remainder.startsWith('/') ? remainder : `/${remainder}`}`
  )
  if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) return null

  try {
    if (!fs.statSync(absolutePath).isFile()) return null
  } catch {
    return null
  }
  return { absolutePath, contentType: contentTypeForFile(absolutePath) }
}

/** @typedef {LocalResource & { url: string }} LocalResourceListItem */

/**
 * @typedef {object} ResourceStoreOptions
 * @property {string} file Path of resources.json.
 * @property {string} storageDir Directory holding the resource payloads.
 * @property {{ localResourcesEnabled: boolean }} configStore Global local-resources flag.
 */

/**
 * Create the resource store. Nothing is read from disk until `load()`.
 *
 * @param {ResourceStoreOptions} options
 */
function createResourceStore({ file, storageDir, configStore }) {
  /** @type {Map<string, LocalResource>} */
  let localResources = new Map()
  /** @type {Set<() => void>} */
  const changeListeners = new Set()

  /**
   * Subscribe to changes (every mutation ends with `save()`, which notifies).
   *
   * @param {() => void} listener
   * @returns {() => void} Unsubscribe.
   */
  function onChange(listener) {
    changeListeners.add(listener)
    return () => {
      changeListeners.delete(listener)
    }
  }

  function notifyChange() {
    for (const listener of changeListeners) {
      try {
        listener()
      } catch (error) {
        logError('resources', 'Resource change listener failed', error)
      }
    }
  }

  /**
   * Load existing local resources on startup.
   */
  function load() {
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        localResources = new Map(Object.entries(data))
      } catch (error) {
        logError('resources', 'Error loading local resources', error)
      }
    }
  }

  async function save() {
    // Subscribers learn about the change before the write lands on disk, so
    // the UI reflects it as soon as the API answers.
    notifyChange()
    const data = Object.fromEntries(localResources)
    try {
      await fsPromises.writeFile(file, JSON.stringify(data, null, 2))
    } catch (error) {
      logError('resources', 'Error saving local resources', error)
    }
  }

  /**
   * @returns {LocalResourceListItem[]}
   */
  function list() {
    return Array.from(localResources.entries()).map(([url, data]) => ({
      url,
      ...data
    }))
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function has(url) {
    return localResources.has(url)
  }

  /**
   * @param {string} url
   * @returns {LocalResource | undefined}
   */
  function get(url) {
    return localResources.get(url)
  }

  /**
   * @param {string} url
   * @param {LocalResource} resource
   */
  function set(url, resource) {
    localResources.set(url, resource)
  }

  /**
   * Enable or disable a resource.
   *
   * @param {string} url
   * @param {boolean} enabled
   * @returns {LocalResource | null} The updated resource, or null when unknown.
   */
  function toggle(url, enabled) {
    if (!localResources.has(url)) return null
    const resource = localResources.get(url) || /** @type {LocalResource} */ ({})
    const updated = {
      ...resource,
      enabled
    }
    localResources.set(url, updated)
    return updated
  }

  /**
   * Delete a resource and its payload file. A payload that is already missing
   * is tolerated; any other file-system error is logged and rethrown.
   *
   * @param {string} url
   * @returns {Promise<boolean>} False when the URL was not a resource.
   */
  async function remove(url) {
    const resource = localResources.get(url)
    if (!resource) return false

    // A folder mapping owns no payload under the storage directory.
    if (resource.type === 'folder' || !resource.filename) {
      localResources.delete(url)
      return true
    }

    const filePath = path.join(storageDir, resource.filename)

    try {
      await fsPromises.unlink(filePath)
    } catch (fsError) {
      // If the file is already missing, keep behaviour simple and just log
      const code = /** @type {{ code?: string } | null} */ (fsError)?.code
      if (!fsError || code !== 'ENOENT') {
        logError('resources', 'Error deleting local resource file', fsError)
        throw fsError
      }
    }

    localResources.delete(url)
    return true
  }

  /**
   * Find the enabled resource whose URL is contained in the request URL or
   * in the full URL. Null when local resources are globally disabled. A
   * folder mapping resolves the file for the request: a missing file is
   * answered with a 404, or left to the upstream when the mapping falls
   * through.
   *
   * @param {unknown} requestUrl
   * @param {unknown} fullUrl
   * @returns {{ url: string, resource: ResolvedResource } | null}
   */
  function findMatching(requestUrl, fullUrl) {
    if (!configStore.localResourcesEnabled || localResources.size === 0) return null

    const req = safeString(requestUrl)
    const full = safeString(fullUrl)

    for (const [resourceUrl, resourceData] of localResources.entries()) {
      if (!resourceData || resourceData.enabled === false) continue
      if (!((req && req.includes(resourceUrl)) || (full && full.includes(resourceUrl)))) continue

      if (resourceData.type === 'folder') {
        const found = resolveFolderFile(resourceData.path || '', resourceUrl, req, full)
        if (found) {
          return { url: resourceUrl, resource: { ...resourceData, ...found } }
        }
        if (resourceData.fallthrough) continue
        return { url: resourceUrl, resource: { ...resourceData, status: 404 } }
      }

      return { url: resourceUrl, resource: resourceData }
    }

    return null
  }

  /**
   * Stream a local resource file to an HTTP response with consistent
   * headers and error handling for both proxy and MITM flows.
   *
   * On error, a 500 JSON payload with a generic error message is sent.
   *
   * @param {import('http').ServerResponse} res
   * @param {{ filename: string, contentType: string, absolutePath?: string, status?: number }} resource
   * @param {{ sourceTag: string, errorPrefix: string }} options
   */
  function serveStream(res, resource, { sourceTag, errorPrefix }) {
    // A folder mapping that found no file answers the miss itself.
    if (resource.status === 404) {
      const payload = JSON.stringify({ error: 'Not found in the mapped folder' })
      res.writeHead(404, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'X-Proxy-Source': sourceTag
      })
      res.end(payload)
      return
    }

    const filePath = resource.absolutePath || path.join(storageDir, resource.filename)

    const sendError = () => {
      try {
        if (!res.headersSent) {
          res.statusCode = 500
          try {
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
          } catch {
            // Headers already sent: the error body goes out without a content type.
          }
          res.end(JSON.stringify({ error: 'Error serving local resource' }))
        } else {
          res.end()
        }
      } catch {
        try {
          res.end()
        } catch {
          // Response already closed by the client.
        }
      }
    }

    try {
      const stream = fs.createReadStream(filePath)

      try {
        if (!res.headersSent) {
          res.setHeader('Content-Type', resource.contentType)
          res.setHeader('X-Proxy-Source', sourceTag)
        }
      } catch {
        // Headers already sent by an earlier error path: the stream is still piped.
      }

      stream.on('error', error => {
        logError('resources', errorPrefix, error)
        sendError()
      })

      stream.pipe(res)
    } catch (error) {
      logError('resources', errorPrefix, error)
      sendError()
    }
  }

  return {
    storageDir,
    load,
    save,
    list,
    resolveFolderFile,
    has,
    get,
    set,
    toggle,
    remove,
    findMatching,
    serveStream,
    onChange,
    get size() {
      return localResources.size
    }
  }
}

/** @typedef {ReturnType<typeof createResourceStore>} ResourceStore */

module.exports = {
  CONTENT_TYPES_BY_EXTENSION,
  contentTypeForFile,
  resolveFolderFile,
  createResourceStore
}
