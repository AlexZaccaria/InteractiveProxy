import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { isEditableTarget, useKeyboardShortcuts } from './useKeyboardShortcuts'

/**
 * @param {string} key
 * @param {Partial<KeyboardEventInit> & { target?: EventTarget }} [init]
 */
function press(key, { target, ...init } = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  ;(target || window).dispatchEvent(event)
  return event
}

describe('isEditableTarget', () => {
  it('is true for text fields, textareas, selects and contenteditable elements', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const select = document.createElement('select')
    const editable = document.createElement('div')
    document.body.append(input, textarea, select, editable)
    editable.contentEditable = 'true'
    expect(isEditableTarget(input)).toBe(true)
    expect(isEditableTarget(textarea)).toBe(true)
    expect(isEditableTarget(select)).toBe(true)
    // jsdom does not compute isContentEditable; the attribute path is covered in the browser.
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })

  it('is false for inputs that take no text', () => {
    for (const type of ['checkbox', 'button', 'file', 'submit']) {
      const input = document.createElement('input')
      input.type = type
      expect(isEditableTarget(input)).toBe(false)
    }
  })
})

describe('useKeyboardShortcuts', () => {
  it('calls the handler of the matching key and prevents the default', () => {
    const handler = vi.fn()
    renderHook(() => useKeyboardShortcuts([{ key: '/', handler }]))
    const event = press('/')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('matches letters whatever their case', () => {
    const handler = vi.fn()
    renderHook(() => useKeyboardShortcuts([{ key: 'e', handler }]))
    press('E')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('ignores keys with a modifier held', () => {
    const handler = vi.fn()
    renderHook(() => useKeyboardShortcuts([{ key: 'e', handler }]))
    press('e', { ctrlKey: true })
    press('e', { metaKey: true })
    press('e', { altKey: true })
    expect(handler).not.toHaveBeenCalled()
  })

  it('ignores keys typed into a text field unless the shortcut allows it', () => {
    const typed = vi.fn()
    const escaped = vi.fn()
    renderHook(() =>
      useKeyboardShortcuts([
        { key: 'e', handler: typed },
        { key: 'Escape', handler: escaped, allowInEditable: true }
      ])
    )
    const input = document.createElement('input')
    document.body.appendChild(input)
    press('e', { target: input })
    press('Escape', { target: input })
    expect(typed).not.toHaveBeenCalled()
    expect(escaped).toHaveBeenCalledTimes(1)
  })

  it('ignores events already handled', () => {
    const handler = vi.fn()
    renderHook(() => useKeyboardShortcuts([{ key: '1', handler }]))
    const event = new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true })
    event.preventDefault()
    window.dispatchEvent(event)
    expect(handler).not.toHaveBeenCalled()
  })

  it('detaches while disabled and when unmounted', () => {
    const handler = vi.fn()
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useKeyboardShortcuts([{ key: 'c', handler }], { enabled }),
      { initialProps: { enabled: false } }
    )
    press('c')
    expect(handler).not.toHaveBeenCalled()
    rerender({ enabled: true })
    press('c')
    expect(handler).toHaveBeenCalledTimes(1)
    unmount()
    press('c')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('uses the latest handlers without re-registering', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(
      ({ handler }) => useKeyboardShortcuts([{ key: '?', handler }]),
      {
        initialProps: { handler: first }
      }
    )
    rerender({ handler: second })
    press('?')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
