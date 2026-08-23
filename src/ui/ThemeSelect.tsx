import { useEffect, useState } from 'react'
import {
  DARK_SYSTEM_QUERY,
  applyTheme,
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  type ThemePreference,
} from './theme'

const LABELS: Record<ThemePreference, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.(DARK_SYSTEM_QUERY).matches ?? true
}

/**
 * The theme picker, and the only thing that writes data-theme.
 *
 * It owns the preference outright rather than taking it from the store: the
 * store is the project, and the project has no opinion about what the editor
 * looks like. See theme.ts.
 */
export function ThemeSelect() {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    readThemePreference(window.localStorage),
  )
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark)

  // Subscribed to unconditionally - resolveTheme ignores the system setting
  // unless the preference is "system", and a listener that came and went with
  // the preference would be a second place the tri-state is interpreted.
  useEffect(() => {
    const query = window.matchMedia?.(DARK_SYSTEM_QUERY)
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  // Layout-time would still be after the first paint, so the flash for a
  // light-mode user is headed off by the boot script in index.html; this is
  // what keeps the attribute right for every change after that one.
  useEffect(() => {
    applyTheme(document.documentElement, resolveTheme(preference, prefersDark))
  }, [preference, prefersDark])

  return (
    <label className="theme-select">
      Theme{' '}
      <select
        data-testid="theme"
        value={preference}
        onChange={(event) => {
          const next = event.target.value as ThemePreference
          setPreference(next)
          writeThemePreference(next, window.localStorage)
        }}
      >
        {(Object.keys(LABELS) as ThemePreference[]).map((option) => (
          <option key={option} value={option}>
            {LABELS[option]}
          </option>
        ))}
      </select>
    </label>
  )
}
