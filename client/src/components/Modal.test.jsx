import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import Modal from './Modal'

function renderModal(props = {}) {
  const onClose = vi.fn()
  const onConfirm = vi.fn()
  const utils = render(
    <Modal
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      title="Clear All Logs"
      message="Are you sure?"
      type="confirm"
      {...props}
    />
  )
  return { ...utils, onClose, onConfirm }
}

describe('Modal', () => {
  it('is a labelled dialog with the focus on the primary action', () => {
    renderModal()
    const dialog = screen.getByRole('dialog', { name: 'Clear All Logs' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('cancels on Escape', () => {
    const { onClose, onConfirm } = renderModal()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onConfirm).toHaveBeenCalledWith(false)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps Tab inside the dialog', () => {
    renderModal()
    const close = screen.getByRole('button', { name: 'Close' })
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    // Confirm is the last control: Tab wraps to the first one.
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(close).toHaveFocus()
    // Shift+Tab from the first control wraps to the last one.
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
  })

  it('labels the text input by the title and confirms with its value', () => {
    const { onConfirm } = renderModal({ showInput: true, inputPlaceholder: 'Preset name' })
    const input = screen.getByRole('textbox', { name: 'Clear All Logs' })
    fireEvent.change(input, { target: { value: 'My preset' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledWith('My preset')
  })

  it('renders nothing while closed', () => {
    const { container } = renderModal({ isOpen: false })
    expect(container).toBeEmptyDOMElement()
  })
})
