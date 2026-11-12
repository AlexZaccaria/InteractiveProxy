/**
 * Copy a text to the clipboard. The asynchronous clipboard API needs a
 * secure context (localhost counts as one); elsewhere, or when it fails,
 * the legacy `execCommand('copy')` on a hidden textarea is tried.
 *
 * @param {string} text
 * @returns {Promise<boolean>} Whether the text was copied.
 */
export async function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy command.
    }
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    return copied
  } catch {
    return false
  }
}
