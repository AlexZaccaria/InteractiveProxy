/**
 * The keyboard shortcuts of the UI, as shown by the help panel and as
 * documented in USAGE.md. The handlers are bound in `App.jsx` through
 * `hooks/useKeyboardShortcuts.js`.
 */

/** The tabs in the order of the `1`–`5` shortcuts. */
export const TAB_ORDER = /** @type {const} */ (['logs', 'blocked', 'filters', 'edit', 'resources'])

/**
 * @typedef {Object} ShortcutDescription
 * @property {string[]} keys The keys as shown in the help panel.
 * @property {string} description
 */

/** @type {ShortcutDescription[]} */
export const SHORTCUT_DESCRIPTIONS = [
  { keys: ['/'], description: 'Focus the URL search of the Requests tab' },
  { keys: ['e'], description: 'Export the current log view' },
  { keys: ['c'], description: 'Clear the logs (asks for confirmation)' },
  {
    keys: ['1', '5'],
    description: 'Switch tab: Requests, Blocked, Redirected/Processed, Edited, Local'
  },
  { keys: ['?'], description: 'Show or hide this help' },
  { keys: ['Esc'], description: 'Close the help or the audit panel; leave a text field' }
]
