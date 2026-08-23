/**
 * Which paint the editor wears.
 *
 * This is a preference about the EDITOR, not about the film, so it lives in
 * this browser and is deliberately NOT part of the draft: opening a project
 * somebody else saved must not repaint your application.
 *
 * Dark is the default rather than "follow the system". A bright surround makes
 * footage look darker and less saturated than it really is - it is the reason
 * grading suites are painted grey - so the picture gets a near-black surround
 * unless somebody asks for otherwise.
 */

/** What the user picked. Three states, one of which is not a colour. */
export type ThemePreference = 'dark' | 'light' | 'system'

/** What the document actually wears. Always a real theme. */
export type Theme = 'dark' | 'light'

export const THEME_PREFERENCES: readonly ThemePreference[] = [
  'dark',
  'light',
  'system',
]

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark'

export const THEME_STORAGE_KEY = 'video-editor:theme'

/** The query the "system" preference reads. */
export const DARK_SYSTEM_QUERY = '(prefers-color-scheme: dark)'

export function isThemePreference(value: unknown): value is ThemePreference {
  return (
    typeof value === 'string' &&
    (THEME_PREFERENCES as readonly string[]).includes(value)
  )
}

/**
 * The one place "system" becomes a colour.
 *
 * Resolving here rather than in CSS keeps the stylesheet down to two token
 * blocks - a media query would need the light palette written out twice, and
 * two copies of a palette drift.
 */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): Theme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

/**
 * Storage can be absent or throw outright - Safari in private browsing, a
 * browser told to block site data - and a missing preference is not an error,
 * so every failure lands on the default.
 */
export function readThemePreference(storage?: Storage | null): ThemePreference {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY)
    return isThemePreference(stored) ? stored : DEFAULT_THEME_PREFERENCE
  } catch {
    return DEFAULT_THEME_PREFERENCE
  }
}

export function writeThemePreference(
  preference: ThemePreference,
  storage?: Storage | null,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // A theme that cannot be remembered still has to be wearable.
  }
}

/** The attribute the stylesheet keys on. */
export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.dataset.theme = theme
}
