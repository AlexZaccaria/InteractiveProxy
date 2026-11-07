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
 * @property {'file' | 'text'} [type]
 * @property {string} filename File under the storage directory.
 * @property {string} [originalName]
 * @property {string} contentType
 * @property {number} [size]
 * @property {string} [createdAt]
 * @property {boolean} [enabled] Disabled resources are never served.
 */

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
function createResourceStore ({ file, storageDir, configStore }) {
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
  function onChange (listener) {
    changeListeners.add(listener)
    return () => { changeListeners.delete(listener) }
  }

  function notifyChange () {
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
  function load () {
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        localResources = new Map(Object.entries(data))
      } catch (error) {
        logError('resources', 'Error loading local resources', error)
      }
    }
  }

  async function save () {
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
  function list () {
    return Array.from(localResources.entries()).map(([url, data]) => ({
      url,
      ...data
    }))
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function has (url) {
    return localResources.has(url)
  }

  /**
   * @param {string} url
   * @returns {LocalResource | undefined}
   */
  function get (url) {
    return localResources.get(url)
  }

  /**
   * @param {string} url
   * @param {LocalResource} resource
   */
  function set (url, resource) {
    localResources.set(url, resource)
  }

  /**
   * Enable or disable a resource.
   *
   * @param {string} url
   * @param {boolean} enabled
   * @returns {LocalResource | null} The updated resource, or null when unknown.
   */
  function toggle (url, enabled) {
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
  async function remove (url) {
    const resource = localResources.get(url)
    if (!resource) return false

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
   * in the full URL. Null when local resources are globally disabled.
   *
   * @param {unknown} requestUrl
   * @param {unknown} fullUrl
   * @returns {{ url: string, resource: LocalResource } | null}
   */
  function findMatching (requestUrl, fullUrl) {
    if (!configStore.localResourcesEnabled || localResources.size === 0) return null

    const req = safeString(requestUrl)
    const full = safeString(fullUrl)

    for (const [resourceUrl, resourceData] of localResources.entries()) {
      if (!resourceData || resourceData.enabled === false) continue
      if ((req && req.includes(resourceUrl)) || (full && full.includes(resourceUrl))) {
        return { url: resourceUrl, resource: resourceData }
      }
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
   * @param {{ filename: string, contentType: string }} resource
   * @param {{ sourceTag: string, errorPrefix: string }} options
   */
  function serveStream (res, resource, { sourceTag, errorPrefix }) {
    const filePath = path.join(storageDir, resource.filename)

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
    has,
    get,
    set,
    toggle,
    remove,
    findMatching,
    serveStream,
    onChange,
    get size () {
      return localResources.size
    }
  }
}

/** @typedef {ReturnType<typeof createResourceStore>} ResourceStore */

module.exports = {
  createResourceStore
}
