import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  isThemePreference,
  readThemePreference,
  resolveTheme,
  writeThemePreference,
} from './theme'

/** Enough of Storage to stand in for it, including one that refuses. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

function hostileStorage(): Storage {
  return {
    getItem() {
      throw new DOMException('denied')
    },
    setItem() {
      throw new DOMException('denied')
    },
  } as unknown as Storage
}

describe('resolveTheme', () => {
  it('passes a real theme straight through, whatever the system says', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
  })

  it('is the only thing that reads the system setting', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('isThemePreference', () => {
  it('accepts the three preferences and nothing else', () => {
    for (const value of ['dark', 'light', 'system']) {
      expect(isThemePreference(value), value).toBe(true)
    }
    for (const value of ['DARK', 'auto', '', null, undefined, 0, {}]) {
      expect(isThemePreference(value), String(value)).toBe(false)
    }
  })
})

describe('readThemePreference', () => {
  it('reads back what was written', () => {
    const storage = fakeStorage()
    writeThemePreference('light', storage)
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(readThemePreference(storage)).toBe('light')
  })

  it('defaults to dark when nothing has been chosen', () => {
    expect(readThemePreference(fakeStorage())).toBe(DEFAULT_THEME_PREFERENCE)
    expect(DEFAULT_THEME_PREFERENCE).toBe('dark')
  })

  /*
   * Storage is shared with every other page on the origin and survives every
   * version of this app, so a value that is not one of the three is a case
   * that happens rather than a case that is imagined.
   */
  it('falls back rather than wearing a value it does not recognise', () => {
    expect(readThemePreference(fakeStorage({ [THEME_STORAGE_KEY]: 'sepia' })))
      .toBe(DEFAULT_THEME_PREFERENCE)
  })

  it('survives storage that is absent or refuses outright', () => {
    expect(readThemePreference(null)).toBe(DEFAULT_THEME_PREFERENCE)
    expect(readThemePreference(undefined)).toBe(DEFAULT_THEME_PREFERENCE)
    expect(readThemePreference(hostileStorage())).toBe(DEFAULT_THEME_PREFERENCE)
    expect(() => writeThemePreference('light', hostileStorage())).not.toThrow()
    expect(() => writeThemePreference('light', null)).not.toThrow()
  })
})
