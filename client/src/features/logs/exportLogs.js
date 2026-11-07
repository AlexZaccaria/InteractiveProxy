import { apiGet } from '../../lib/api'
import { buildExportQuery } from './filters'

/** @typedef {import('./filters').LogFilters} LogFilters */

/**
 * @param {Date} [now]
 * @returns {string}
 */
export function exportFilename(now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-')
  return `proxy-logs-${timestamp}.json`
}

/**
 * Hand a text file to the browser as a download.
 *
 * @param {string} content
 * @param {string} filename
 * @param {string} type
 */
export function triggerDownload(content, filename, type = 'application/json') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * Download the entries `GET /api/logs/export` returns for the marked ids
 * (or, with none marked, for the current filters) as a pretty-printed JSON
 * file.
 *
 * @param {LogFilters} filters
 * @param {string[]} selectedIds
 * @returns {Promise<void>}
 */
export async function downloadLogsExport(filters, selectedIds) {
  try {
    const data = await apiGet('/api/logs/export', { query: buildExportQuery(filters, selectedIds) })
    const items = data && Array.isArray(data.items) ? data.items : []
    triggerDownload(JSON.stringify(items, null, 2), exportFilename())
  } catch (error) {
    console.error('Error exporting logs:', error)
  }
}
