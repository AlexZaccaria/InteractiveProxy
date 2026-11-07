import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { SHORTCUT_DESCRIPTIONS } from '../lib/shortcuts'

/**
 * The keyboard shortcuts panel, anchored under the header button that opens
 * it. A click outside, the close button, `?` and Escape (handled in App)
 * close it.
 *
 * @param {Object} props
 * @param {() => void} props.onClose
 */
function ShortcutsHelp({ onClose }) {
  const panelRef = useRef(/** @type {HTMLDivElement | null} */ (null))

  useEffect(() => {
    /** @param {MouseEvent} event */
    const handleMouseDown = event => {
      const panel = panelRef.current
      if (!panel || !(event.target instanceof Node)) return
      if (panel.contains(event.target)) return
      const anchor = panel.parentElement
      if (anchor && anchor.contains(event.target)) return
      onClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [onClose])

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="absolute right-0 top-full mt-2 z-9999 w-80 max-w-[calc(100vw-2rem)] bg-surface-raised border border-edge rounded-lg shadow-2xl p-3 text-xs text-fg-body"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold text-fg-base">Keyboard shortcuts</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close keyboard shortcuts"
          className="p-1 rounded hover:bg-surface-highlight text-fg-muted hover:text-fg transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <dl className="space-y-1.5">
        {SHORTCUT_DESCRIPTIONS.map(shortcut => (
          <div key={shortcut.description} className="flex items-start gap-3">
            <dt className="shrink-0 w-14 flex items-center gap-1">
              {shortcut.keys.map((key, index) => (
                <span key={key} className="inline-flex items-center gap-1">
                  {index > 0 && <span className="text-fg-faint">–</span>}
                  <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1 rounded border border-edge bg-surface text-[11px] text-fg-base">
                    {key}
                  </kbd>
                </span>
              ))}
            </dt>
            <dd className="flex-1">{shortcut.description}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-fg-faint">
        Shortcuts are off while a text field has the focus or a dialog is open.
      </p>
    </div>
  )
}

export default ShortcutsHelp
