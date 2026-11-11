import { useEffect, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { copyText } from '../../lib/clipboard'

/**
 * The curl command of an entry, shown when it could not be copied to the
 * clipboard on its own (no secure context, or the browser refused): the
 * command is selected for a manual copy, and the Copy button tries again.
 *
 * @param {Object} props
 * @param {string} props.command
 * @param {() => void} props.onClose
 */
export default function CurlCommandDialog({ command, onClose }) {
  const textareaRef = useRef(/** @type {HTMLTextAreaElement | null} */ (null))
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const previous = document.activeElement
    const textarea = textareaRef.current
    if (textarea) {
      textarea.focus()
      textarea.select()
    }
    /** @param {KeyboardEvent} event */
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus()
    }
  }, [onClose])

  const copy = async () => {
    const done = await copyText(command)
    setCopied(done)
    if (!done && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.select()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="curl-dialog-title"
        className="w-full max-w-2xl flex flex-col bg-surface-raised border border-edge rounded-lg shadow-2xl"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <h2 id="curl-dialog-title" className="text-sm font-semibold text-fg-strong">
            Copy as cURL
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the curl command"
            className="p-1 rounded hover:bg-surface-highlight text-fg-muted hover:text-fg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-2">
          <p className="text-xs text-fg-muted">
            The clipboard is not available here. The command is selected: copy it with the keyboard.
          </p>
          <textarea
            ref={textareaRef}
            readOnly
            aria-label="curl command"
            rows={10}
            value={command}
            className="w-full px-3 py-2 bg-surface border border-edge rounded-lg text-xs font-mono text-fg focus:outline-hidden focus:ring-1 focus:ring-blue-500 resize-y"
            spellCheck={false}
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-edge">
          <button
            type="button"
            onClick={onClose}
            className="px-3 h-8 rounded-lg text-xs border border-edge text-fg-body hover:bg-surface-highlight transition-colors"
          >
            Close
          </button>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-medium bg-cyan-600 text-white hover:bg-cyan-500 transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}
