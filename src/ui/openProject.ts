/**
 * Which project is open in THIS browser.
 *
 * A preference about the editor rather than a fact about the work, exactly like
 * the theme and the spoken language: two tabs may reasonably have different
 * projects open, and which one somebody was last looking at says nothing about
 * the timeline. So it lives here and never enters a draft.
 */

export const OPEN_PROJECT_KEY = 'video-editor:open-project'

export function readOpenProjectId(storage?: Storage | null): string | null {
  try {
    const stored = storage?.getItem(OPEN_PROJECT_KEY)
    return stored && stored.length > 0 ? stored : null
  } catch {
    return null
  }
}

export function writeOpenProjectId(
  id: string,
  storage?: Storage | null,
): void {
  try {
    storage?.setItem(OPEN_PROJECT_KEY, id)
  } catch {
    // A choice that cannot be remembered still works for this session.
  }
}
