import { apiGet, apiPost } from '../../lib/api'
import { triggerDownload } from '../logs/exportLogs'

/**
 * Export and import of every rule kind in one file (`GET /api/rules/export`,
 * `POST /api/rules/import`): edit rules and presets, blocked, filter and
 * breakpoint rules.
 */

/**
 * @typedef {Object} RulesImportResult
 * @property {boolean} success
 * @property {'merge' | 'replace'} mode
 * @property {{ editRules: number, presets: number, blockedRules: number, filterRules: number, breakpointRules: number, throttleRules?: number, passthroughRules?: number }} counts
 */

/**
 * @param {Date} [now]
 * @returns {string}
 */
export function rulesFilename(now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-')
  return `proxy-rules-${timestamp}.json`
}

/** @returns {Promise<void>} */
export async function downloadRulesExport() {
  const data = await apiGet('/api/rules/export')
  triggerDownload(JSON.stringify(data, null, 2), rulesFilename())
}

/**
 * Import a rules file. In `merge` mode a record with the id of an existing
 * one replaces it and the others are added; `replace` keeps only the file's.
 *
 * @param {File} file
 * @param {'merge' | 'replace'} [mode]
 * @returns {Promise<RulesImportResult>}
 */
export async function importRulesFile(file, mode = 'merge') {
  const text = await file.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('The file is not valid JSON')
  }
  return apiPost('/api/rules/import', { ...data, mode })
}

/**
 * One line that sums up an import, for the confirmation dialog.
 *
 * @param {RulesImportResult} result
 * @returns {string}
 */
export function describeImport(result) {
  const { counts } = result
  /** @type {Array<[number, string]>} */
  const entries = [
    [counts.editRules, 'edit rule'],
    [counts.presets, 'preset'],
    [counts.blockedRules, 'blocked rule'],
    [counts.filterRules, 'filter rule'],
    [counts.breakpointRules, 'breakpoint rule'],
    [counts.throttleRules || 0, 'network-condition rule'],
    [counts.passthroughRules || 0, 'passthrough host']
  ]
  const parts = entries
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}${count === 1 ? '' : 's'}`)
  const summary = parts.length > 0 ? parts.join(', ') : 'nothing'
  return result.mode === 'replace'
    ? `Rules replaced with the file's: ${summary}.`
    : `Imported ${summary}; records with a known id replaced the existing ones.`
}
