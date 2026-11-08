/**
 * The colour theme: a stored choice (`localStorage`, key `proxy.theme`) or,
 * without one, the operating system's preference. The theme is applied as
 * the `dark` class on `<html>`; the tokens of `index.css` follow it.
 *
 * The inline script of `index.html` applies the same rule before the first
 * paint, so the page does not flash in the wrong theme while the bundle
 * loads.
 */

/** @typedef {'light' | 'dark'} Theme */

export const THEME_STORAGE_KEY = 'proxy.theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * @param {unknown} value
 * @returns {value is Theme}
 */
export function isTheme(value) {
  return value === 'light' || value === 'dark'
}

/**
 * The theme chosen by the user, or `null` when nothing valid is stored.
 *
 * @returns {Theme | null}
 */
export function readStoredTheme() {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(value) ? value : null
  } catch {
    return null
  }
}

/**
 * @param {Theme | null} theme `null` removes the stored choice.
 */
export function storeTheme(theme) {
  try {
    if (theme) window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    else window.localStorage.removeItem(THEME_STORAGE_KEY)
  } catch {
    // Storage may be unavailable (privacy mode); the choice then lasts the session.
  }
}

/**
 * The operating system's preference; `dark` when it cannot be read.
 *
 * @returns {Theme}
 */
export function getSystemTheme() {
  if (typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

/**
 * The stored choice, else the system preference.
 *
 * @returns {Theme}
 */
export function resolveInitialTheme() {
  return readStoredTheme() || getSystemTheme()
}

/**
 * Set the `dark` class on `<html>` for the theme.
 *
 * @param {Theme} theme
 */
export function applyThemeToDocument(theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

/**
 * Call `listener` whenever the operating system's preference changes.
 *
 * @param {(theme: Theme) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function subscribeToSystemTheme(listener) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(DARK_QUERY)
  /** @param {MediaQueryListEvent} event */
  const handleChange = event => listener(event.matches ? 'dark' : 'light')
  query.addEventListener('change', handleChange)
  return () => query.removeEventListener('change', handleChange)
}
