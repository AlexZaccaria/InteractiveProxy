import { useEffect, useRef } from 'react'

/**
 * Global single-key shortcuts. A shortcut fires on `keydown` when its key
 * matches `event.key` (letters case-insensitively), no modifier is held,
 * the event is not already handled, and the focus is not in a text field
 * unless the shortcut allows it (`Escape`, to leave the field).
 */

/**
 * @typedef {Object} Shortcut
 * @property {string} key The `event.key` to match: `'/'`, `'e'`, `'1'`, `'?'`, `'Escape'`.
 * @property {(event: KeyboardEvent) => void} handler
 * @property {boolean} [allowInEditable] Fire even while a text field has the focus.
 */

/**
 * True when typing into `target` would insert text: inputs other than
 * buttons and checkboxes, textareas, selects and contenteditable elements.
 *
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
export function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target instanceof HTMLInputElement) {
    const type = (target.type || 'text').toLowerCase()
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes(
      type
    )
  }
  return false
}

/**
 * @param {Shortcut} shortcut
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function matches(shortcut, event) {
  if (shortcut.key === event.key) return true
  return (
    shortcut.key.length === 1 &&
    event.key.length === 1 &&
    shortcut.key.toLowerCase() === event.key.toLowerCase()
  )
}

/**
 * @param {Shortcut[]} shortcuts
 * @param {{ enabled?: boolean }} [options] `enabled: false` detaches every shortcut (a modal is open).
 */
export function useKeyboardShortcuts(shortcuts, { enabled = true } = {}) {
  const shortcutsRef = useRef(shortcuts)
  shortcutsRef.current = shortcuts

  useEffect(() => {
    if (!enabled) return undefined

    /** @param {KeyboardEvent} event */
    const handleKeyDown = event => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const editable = isEditableTarget(event.target)
      const shortcut = shortcutsRef.current.find(
        candidate => (!editable || candidate.allowInEditable) && matches(candidate, event)
      )
      if (!shortcut) return
      event.preventDefault()
      shortcut.handler(event)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled])
}
