import { useState, useCallback } from 'react';

/**
 * @typedef {Object} ModalState
 * @property {boolean} isOpen
 * @property {string} title
 * @property {string} message
 * @property {string} type `'info'`, `'confirm'`, `'error'`, ...
 * @property {boolean} showInput
 * @property {string} inputValue
 * @property {string} inputPlaceholder
 * @property {string[]} examples
 * @property {((result: any) => void) | null} onConfirm
 */

/** @type {ModalState} */
const CLOSED_STATE = {
  isOpen: false,
  title: '',
  message: '',
  type: 'info',
  showInput: false,
  inputValue: '',
  inputPlaceholder: '',
  examples: [],
  onConfirm: null
};

/**
 * State and helpers of the application modal: a confirm dialog, a prompt
 * with a text input, and an alert. Each helper resolves with the user's
 * answer when the modal closes.
 */
export function useModal() {
  const [modalState, setModalState] = useState(CLOSED_STATE);

  const closeModal = useCallback(() => {
    setModalState(prev => ({ ...prev, isOpen: false }));
  }, []);

  const showConfirm = useCallback(
    /**
     * @param {string} title
     * @param {string} message
     * @param {(result: boolean) => void} [onConfirm]
     * @returns {Promise<boolean>}
     */
    (title, message, onConfirm) => {
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
    },
    []
  );

  const showPrompt = useCallback(
    /**
     * @param {string} title
     * @param {string} message
     * @param {string} [defaultValue]
     * @param {string} [placeholder]
     * @param {string[]} [examples]
     * @returns {Promise<string | null>}
     */
    (title, message, defaultValue = '', placeholder = '', examples = []) => {
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
    },
    []
  );

  const showAlert = useCallback(
    /**
     * @param {string} title
     * @param {string} message
     * @param {string} [type]
     * @returns {Promise<boolean>}
     */
    (title, message, type = 'info') => {
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
    },
    []
  );

  return {
    modalState,
    closeModal,
    showConfirm,
    showPrompt,
    showAlert
  };
}
