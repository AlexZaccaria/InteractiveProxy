import { useState, useCallback } from 'react';

export function useModal() {
  const [modalState, setModalState] = useState({
    isOpen: false,
    title: '',
    message: '',
    type: 'info',
    showInput: false,
    inputValue: '',
    inputPlaceholder: '',
    examples: [],
    onConfirm: null
  });

  const closeModal = useCallback(() => {
    setModalState(prev => ({ ...prev, isOpen: false }));
  }, []);

  const showConfirm = useCallback((title, message, onConfirm) => {
    return new Promise((resolve) => {
      setModalState({
        isOpen: true,
        title,
        message,
        type: 'confirm',
        showInput: false,
        inputValue: '',
        inputPlaceholder: '',
        examples: [],
        onConfirm: (result) => {
          resolve(result);
          if (onConfirm) onConfirm(result);
        }
      });
    });
  }, []);

  const showPrompt = useCallback((title, message, defaultValue = '', placeholder = '', examples = []) => {
    return new Promise((resolve) => {
      setModalState({
        isOpen: true,
        title,
        message,
        type: 'info',
        showInput: true,
        inputValue: defaultValue,
        inputPlaceholder: placeholder,
        examples,
        onConfirm: (result) => {
          resolve(result);
        }
      });
    });
  }, []);

  const showAlert = useCallback((title, message, type = 'info') => {
    return new Promise((resolve) => {
      setModalState({
        isOpen: true,
        title,
        message,
        type,
        showInput: false,
        inputValue: '',
        inputPlaceholder: '',
        examples: [],
        onConfirm: () => {
          resolve(true);
        }
      });
    });
  }, []);

  return {
    modalState,
    closeModal,
    showConfirm,
    showPrompt,
    showAlert
  };
}
