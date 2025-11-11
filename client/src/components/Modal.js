import React, { useState, useEffect } from 'react';
import { X, AlertCircle, HelpCircle, Info } from 'lucide-react';

function Modal({ isOpen, onClose, title, message, type = 'info', onConfirm, showInput = false, inputValue = '', inputPlaceholder = '', examples = [] }) {
  const [inputText, setInputText] = useState(inputValue);

  useEffect(() => {
    setInputText(inputValue);
  }, [inputValue]);

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
              className="w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-white hover:bg-[#2a2a2a] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors ${
              type === 'warning' || type === 'error'
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-blue-600 hover:bg-blue-700'
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
