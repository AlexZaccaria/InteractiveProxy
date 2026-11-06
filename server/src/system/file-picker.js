'use strict'

/**
 * Native file picker for the management UI (Windows only): opens the
 * WinForms OpenFileDialog through PowerShell and resolves the chosen path.
 *
 * @module system/file-picker
 */

const { spawn } = require('child_process')

/**
 * Escape a string for safe inclusion in a PowerShell double-quoted string.
 *
 * @param {unknown} value
 * @returns {string}
 */
const escapePowerShellString = (value) => {
  const raw = value == null ? '' : String(value)
  if (!raw) return ''
  return raw.replace(/`/g, '``').replace(/"/g, '`"')
}

/**
 * Open a native Windows file picker and resolve the selected path.
 *
 * @param {{ title?: string, filter?: string }} [options]
 * @returns {Promise<string | null>} The selected path, or null when the dialog was cancelled.
 */
function showNativeFilePicker (options = {}) {
  return new Promise((resolve, reject) => {
    const title = escapePowerShellString(options.title || 'Select a file')
    const filter = escapePowerShellString(options.filter || 'All files (*.*)|*.*')

    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog;',
      `$dialog.Title = "${title}";`,
      `$dialog.Filter = "${filter}";`,
      '$dialog.Multiselect = $false;',
      '$result = $dialog.ShowDialog();',
      'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }'
    ].join(' ')

    const ps = spawn('powershell', ['-STA', '-NoProfile', '-Command', script])
    let output = ''
    let errorOutput = ''

    ps.stdout.on('data', chunk => {
      output += chunk.toString()
    })

    ps.stderr.on('data', chunk => {
      errorOutput += chunk.toString()
    })

    ps.on('error', reject)
    ps.on('close', code => {
      if (code !== 0 && errorOutput) {
        reject(new Error(errorOutput.trim()))
        return
      }
      const trimmed = output == null ? '' : String(output).trim()
      resolve(trimmed || null)
    })
  })
}

module.exports = {
  escapePowerShellString,
  showNativeFilePicker
}
