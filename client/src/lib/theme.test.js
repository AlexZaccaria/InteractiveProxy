import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  getSystemTheme,
  readStoredTheme,
  resolveInitialTheme,
  storeTheme,
  subscribeToSystemTheme
} from './theme'

/**
 * A `matchMedia` stub answering `matches` for the dark query and recording
 * its change listeners.
 *
 * @param {boolean} matches
 */
function stubMatchMedia(matches) {
  /** @typedef {(event: { matches: boolean }) => void} Listener */
  /** @type {Listener[]} */
  const listeners = []
  vi.stubGlobal(
    'matchMedia',
    /** @param {string} query */
    query => ({
      matches: query.includes('dark') ? matches : !matches,
      /** @type {(type: string, listener: Listener) => void} */
      addEventListener: (_type, listener) => {
        listeners.push(listener)
      },
      /** @type {(type: string, listener: Listener) => void} */
      removeEventListener: (_type, listener) => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    })
  )
  return listeners
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('dark')
})

describe('readStoredTheme / storeTheme', () => {
  it('reads only valid values', () => {
    expect(readStoredTheme()).toBeNull()
    localStorage.setItem(THEME_STORAGE_KEY, 'blue')
    expect(readStoredTheme()).toBeNull()
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    expect(readStoredTheme()).toBe('light')
  })

  it('stores and removes the choice', () => {
    storeTheme('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    storeTheme(null)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })
})

describe('getSystemTheme / resolveInitialTheme', () => {
  it('falls back to dark when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(getSystemTheme()).toBe('dark')
  })

  it('follows the operating system without a stored choice', () => {
    stubMatchMedia(false)
    expect(getSystemTheme()).toBe('light')
    expect(resolveInitialTheme()).toBe('light')
  })

  it('prefers the stored choice', () => {
    stubMatchMedia(false)
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    expect(resolveInitialTheme()).toBe('dark')
  })
})

describe('applyThemeToDocument', () => {
  it('sets and removes the dark class on <html>', () => {
    applyThemeToDocument('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    applyThemeToDocument('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

describe('subscribeToSystemTheme', () => {
  it('reports changes until unsubscribed', () => {
    const listeners = stubMatchMedia(true)
    const listener = vi.fn()
    const unsubscribe = subscribeToSystemTheme(listener)
    expect(listeners).toHaveLength(1)
    listeners[0]({ matches: false })
    expect(listener).toHaveBeenCalledWith('light')
    unsubscribe()
    expect(listeners).toHaveLength(0)
  })

  it('is a no-op without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(() => subscribeToSystemTheme(() => {})()).not.toThrow()
  })
})
