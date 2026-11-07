import { afterEach, describe, expect, it } from 'vitest'
import { THEME_STORAGE_KEY } from '../lib/theme'
import { useProxyStore } from './useProxyStore'

afterEach(() => {
  document.documentElement.classList.remove('dark')
  useProxyStore.setState({ theme: 'dark', showShortcutsHelp: false, showAuditPanel: false })
})

describe('useProxyStore theme', () => {
  it('setTheme applies the class to <html> and stores the choice', () => {
    useProxyStore.getState().setTheme('light')
    expect(useProxyStore.getState().theme).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')

    useProxyStore.getState().setTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('setTheme without persistence leaves the storage alone', () => {
    useProxyStore.getState().setTheme('light', { persist: false })
    expect(useProxyStore.getState().theme).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('toggleTheme switches and stores', () => {
    useProxyStore.setState({ theme: 'dark' })
    useProxyStore.getState().toggleTheme()
    expect(useProxyStore.getState().theme).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    useProxyStore.getState().toggleTheme()
    expect(useProxyStore.getState().theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})

describe('useProxyStore panels', () => {
  it('toggles the shortcuts help and the audit panel', () => {
    const store = useProxyStore.getState()
    store.toggleShortcutsHelp()
    expect(useProxyStore.getState().showShortcutsHelp).toBe(true)
    store.setShowShortcutsHelp(false)
    expect(useProxyStore.getState().showShortcutsHelp).toBe(false)
    store.toggleAuditPanel()
    expect(useProxyStore.getState().showAuditPanel).toBe(true)
    store.setShowAuditPanel(false)
    expect(useProxyStore.getState().showAuditPanel).toBe(false)
  })
})
