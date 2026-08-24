/**
 * Which language the transcriber should expect.
 *
 * Whisper detects this itself by default, from the first few seconds - and on a
 * quiet opening, a bit of music or an accent it has heard little of, it guesses
 * wrong. There is no recovery from that: every word afterwards is transcribed as
 * a language nobody spoke, and what comes back is fluent nonsense rather than an
 * obvious failure.
 *
 * So it can be pinned. Like the theme this is a preference about the EDITOR
 * rather than a fact about the film - somebody who works in Tamil works in Tamil
 * - so it lives in this browser and must never travel in a draft.
 *
 * The list is short on purpose. Whisper speaks ninety-odd languages and a
 * ninety-item menu is not a control anybody can use; `auto` is still here for
 * everything not named, and it is still the default because it is right most of
 * the time.
 *
 * MIXED is not a language, and is the reason this is a string rather than a
 * language code. Plenty of speech switches - Tamil with English words dropped
 * into it, a bilingual interview - and neither pinning one language nor
 * detecting once at the top gets that right: the first mangles half the words,
 * the second commits the whole file to whatever the opening happened to be in.
 * It asks the transcriber to decide again for every line instead.
 */

export type SpokenLanguage = {
  /**
   * The ISO code Whisper takes, '' for detect-it-yourself, or MIXED for
   * decide-again-every-line.
   */
  code: string
  label: string
}

/** Not a language: an instruction to detect one per line rather than per file. */
export const MIXED = 'mixed'

export const SPOKEN_LANGUAGES: readonly SpokenLanguage[] = [
  { code: '', label: 'Detect' },
  { code: MIXED, label: 'Mixed' },
  { code: 'en', label: 'English' },
  { code: 'ta', label: 'Tamil' },
  { code: 'hi', label: 'Hindi' },
  { code: 'te', label: 'Telugu' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'kn', label: 'Kannada' },
  { code: 'ar', label: 'Arabic' },
  { code: 'zh', label: 'Chinese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'ja', label: 'Japanese' },
]

export const LANGUAGE_STORAGE_KEY = 'video-editor:spoken-language'

export function isSpokenLanguage(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SPOKEN_LANGUAGES.some((language) => language.code === value)
  )
}

/**
 * Storage can be absent or throw outright, and a missing preference is not an
 * error - every failure lands on detect-it-yourself, which is what the
 * transcriber would have done anyway.
 */
export function readSpokenLanguage(storage?: Storage | null): string {
  try {
    const stored = storage?.getItem(LANGUAGE_STORAGE_KEY)
    return isSpokenLanguage(stored) ? stored : ''
  } catch {
    return ''
  }
}

export function writeSpokenLanguage(
  code: string,
  storage?: Storage | null,
): void {
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, code)
  } catch {
    // A choice that cannot be remembered is still usable this session.
  }
}
