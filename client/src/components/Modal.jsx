import React, { useState, useEffect, useRef } from 'react'
import { X, AlertCircle, HelpCircle, Info } from 'lucide-react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Generic modal dialog used for alerts, confirmations and optional text input.
 * While open it keeps the keyboard focus inside (Tab cycles through its
 * controls), Escape cancels, and the element focused before it opened gets
 * the focus back when it closes.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen Whether the modal is visible.
 * @param {() => void} props.onClose Callback to close the modal.
 * @param {string} props.title Modal title.
 * @param {string} props.message Main message body (supports newlines).
 * @param {'info'|'confirm'|'warning'|'error'} [props.type] Visual style and icon type.
 * @param {(value: boolean|string) => void} [props.onConfirm] Called when the user confirms or cancels.
 * @param {boolean} [props.showInput] When true, shows a single-line text input.
 * @param {string} [props.inputValue] Initial value for the input field.
 * @param {string} [props.inputPlaceholder] Placeholder text for the input field.
 * @param {string[]} [props.examples] Optional list of example strings rendered below the message.
 */
function Modal({
  isOpen,
  onClose,
  title,
  message,
  type = 'info',
  onConfirm,
  showInput = false,
  inputValue = '',
  inputPlaceholder = '',
  examples = []
}) {
  const [inputText, setInputText] = useState(inputValue)
  const dialogRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const confirmButtonRef = useRef(/** @type {HTMLButtonElement | null} */ (null))

  useEffect(() => {
    setInputText(inputValue)
  }, [inputValue])

  // Initial focus: the text input when there is one, else the primary
  // action so that Enter confirms. The previously focused element is
  // restored when the dialog closes.
  useEffect(() => {
    if (!isOpen) return undefined
    const previous = document.activeElement
    if (!showInput && confirmButtonRef.current) {
      confirmButtonRef.current.focus()
    }
    return () => {
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus()
    }
  }, [isOpen, showInput])

  if (!isOpen) return null

  const handleConfirm = () => {
    if (onConfirm) {
      onConfirm(showInput ? inputText : true)
    }
    onClose()
  }

  const handleCancel = () => {
    if (onConfirm) {
      onConfirm(false)
    }
    onClose()
  }

  /** @param {React.KeyboardEvent<HTMLDivElement>} event */
  const handleKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      handleCancel()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      element => element instanceof HTMLElement
    )
    if (focusable.length === 0) return
    const first = /** @type {HTMLElement} */ (focusable[0])
    const last = /** @type {HTMLElement} */ (focusable[focusable.length - 1])
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const getIcon = () => {
    switch (type) {
      case 'confirm':
        return <HelpCircle className="w-6 h-6 text-blue-400" />
      case 'warning':
        return <AlertCircle className="w-6 h-6 text-yellow-400" />
      case 'error':
        return <AlertCircle className="w-6 h-6 text-red-400" />
      default:
        return <Info className="w-6 h-6 text-blue-400" />
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby="modal-message"
        onKeyDown={handleKeyDown}
        className="bg-surface-raised border border-edge rounded-lg shadow-2xl max-w-md w-full animate-in fade-in zoom-in duration-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-edge">
          <div className="flex items-center gap-3">
            {getIcon()}
            <h3 id="modal-title" className="text-lg font-semibold text-fg">
              {title}
            </h3>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            aria-label="Close"
            className="p-1 hover:bg-surface-highlight rounded transition-colors"
          >
            <X className="w-5 h-5 text-fg-muted" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          <p id="modal-message" className="text-sm text-fg-body whitespace-pre-line">
            {message}
          </p>

          {/* Examples */}
          {examples.length > 0 && (
            <div className="bg-surface border border-edge rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-fg-muted">Examples:</p>
              {examples.map((example, index) => (
                <div key={index} className="text-xs text-fg-muted">
                  <span className="text-blue-400">•</span> {example}
                </div>
              ))}
            </div>
          )}

          {/* Input */}
          {showInput && (
            <>
              <label htmlFor="modal-input" className="sr-only">
                {title}
              </label>
              <input
                type="text"
                id="modal-input"
                name="modal-input"
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                placeholder={inputPlaceholder}
                className="w-full px-3 h-8 bg-surface border border-edge rounded-lg text-xs text-fg placeholder-fg-faint focus:outline-hidden focus:ring-1 focus:ring-blue-500"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') handleConfirm()
                }}
              />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-edge">
          <button
            type="button"
            onClick={handleCancel}
            className="inline-flex items-center justify-center px-4 h-8 rounded-lg bg-surface border border-edge text-xs font-medium text-fg-body hover:bg-surface-raised hover:text-fg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            ref={confirmButtonRef}
            onClick={handleConfirm}
            className={`inline-flex items-center justify-center px-4 h-8 rounded-lg text-xs font-medium transition-colors border ${
              type === 'warning' || type === 'error'
                ? 'bg-red-600/20 border-red-500/40 text-red-300 hover:bg-red-600/30 hover:text-fg'
                : 'bg-blue-600/20 border-blue-500/40 text-blue-300 hover:bg-blue-600/30 hover:text-fg'
            }`}
          >
            {type === 'confirm' || type === 'warning' ? 'Confirm' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default Modal
