import React, { useState, useEffect, useRef } from 'react';
import { X, AlertCircle, HelpCircle, Info } from 'lucide-react';

/**
 * Generic modal dialog used for alerts, confirmations and optional text input.
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
function Modal({ isOpen, onClose, title, message, type = 'info', onConfirm, showInput = false, inputValue = '', inputPlaceholder = '', examples = [] }) {
  const [inputText, setInputText] = useState(inputValue);
  const confirmButtonRef = useRef(null);

  useEffect(() => {
    setInputText(inputValue);
  }, [inputValue]);

  // When the modal opens without an input field, move keyboard focus to the
  // primary action button so that users can immediately confirm with Enter.
  useEffect(() => {
    if (!isOpen || showInput) return;
    if (confirmButtonRef.current) {
      confirmButtonRef.current.focus();
    }
  }, [isOpen, showInput]);

  if (!isOpen) return null;

  const handleConfirm = () => {
    if (onConfirm) {
      onConfirm(showInput ? inputText : true);
    }
    onClose();
  };

  const handleCancel = () => {
    if (onConfirm) {
      onConfirm(false);
    }
    onClose();
  };

  const getIcon = () => {
    switch (type) {
      case 'confirm':
        return <HelpCircle className="w-6 h-6 text-blue-400" />;
      case 'warning':
        return <AlertCircle className="w-6 h-6 text-yellow-400" />;
      case 'error':
        return <AlertCircle className="w-6 h-6 text-red-400" />;
      default:
        return <Info className="w-6 h-6 text-blue-400" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg shadow-2xl max-w-md w-full animate-in fade-in zoom-in duration-200">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#2a2a2a]">
          <div className="flex items-center gap-3">
            {getIcon()}
            <h3 className="text-lg font-semibold text-white">{title}</h3>
          </div>
          <button
            onClick={handleCancel}
            className="p-1 hover:bg-[#2a2a2a] rounded transition-colors"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          <p className="text-sm text-slate-300 whitespace-pre-line">{message}</p>

          {/* Examples */}
          {examples.length > 0 && (
            <div className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-slate-400">Examples:</p>
              {examples.map((example, index) => (
                <div key={index} className="text-xs text-slate-400">
                  <span className="text-blue-400">•</span> {example}
                </div>
              ))}
            </div>
          )}

          {/* Input */}
          {showInput && (
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={inputPlaceholder}
              className="w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirm();
                if (e.key === 'Escape') handleCancel();
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-[#2a2a2a]">
          <button
            onClick={handleCancel}
            className="inline-flex items-center justify-center px-4 h-8 rounded-lg bg-[#0a0a0a] border border-[#2a2a2a] text-xs font-medium text-slate-300 hover:bg-[#1a1a1a] hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            ref={confirmButtonRef}
            onClick={handleConfirm}
            className={`inline-flex items-center justify-center px-4 h-8 rounded-lg text-xs font-medium transition-colors border ${
              type === 'warning' || type === 'error'
                ? 'bg-red-600/20 border-red-500/40 text-red-300 hover:bg-red-600/30 hover:text-white'
                : 'bg-blue-600/20 border-blue-500/40 text-blue-300 hover:bg-blue-600/30 hover:text-white'
            }`}
          >
            {type === 'confirm' || type === 'warning' ? 'Confirm' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Modal;
