/**
 * Where a project lives between visits.
 *
 * Two stores, mirroring the split the rest of the app already makes: the
 * timeline is plain JSON and goes in one, the media files are opaque blobs and
 * go in the other, keyed by the same sourceId. Nothing here ever puts a File
 * into the timeline.
 *
 * The saved timeline is written as a DRAFT - the same shape `Save` produces -
 * so it carries a version and comes back through the same validator. An
 * autosave written by an older build of the editor is then handled by exactly
 * the rules a draft file off disk is, rather than by a second set that would
 * have to be kept in step.
 *
 * Media is stored as the File itself rather than as a file-system handle.
 * Handles would avoid duplicating the bytes, but they only exist for files
 * opened through the file picker, and they need permission granting again on
 * every return. A File survives IndexedDB whole - name, type and contents -
 * and comes back with nothing to ask the user.
 */

import { parseDraft, toDraft } from './draft'
import type { Project } from './types'

const DATABASE_NAME = 'video-editor'
const DATABASE_VERSION = 1

const PROJECT_STORE = 'project'
const MEDIA_STORE = 'media'

/** There is one autosave slot, and this is its key. */
const CURRENT = 'current'

export type SavedProject = {
  project: Project
  savedAt: number
}

let database: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database

  database = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no IndexedDB to save into.'))
      return
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        db.createObjectStore(PROJECT_STORE)
      }
      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        db.createObjectStore(MEDIA_STORE)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () =>
      reject(new Error('Another tab is holding the saved project open.'))
  })

  // A failure must not be cached forever: the next call should try again.
  database.catch(() => {
    database = null
  })

  return database
}

/** Runs one transaction and resolves when it has actually committed. */
async function transact<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | undefined> {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    const request = run(transaction.objectStore(storeName))

    let value: T | undefined
    if (request) {
      request.onsuccess = () => {
        value = request.result
      }
    }

    // Resolved on complete rather than on success: a write is not saved until
    // its transaction commits, and reporting otherwise would lose the last
    // edit of a session.
    transaction.oncomplete = () => resolve(value)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

/** Writes the timeline to the autosave slot. */
export async function saveProject(project: Project): Promise<void> {
  const record = { savedAt: Date.now(), draft: toDraft(project) }
  await transact(PROJECT_STORE, 'readwrite', (store) =>
    store.put(record, CURRENT),
  )
}

/**
 * Reads the autosave back, or null if there is none.
 *
 * Throws only for a database that cannot be opened. A stored project that no
 * longer parses is treated as no project at all rather than as a failure: the
 * editor should open empty, not refuse to open.
 */
export async function loadProject(): Promise<SavedProject | null> {
  const record = await transact<{ savedAt: number; draft: unknown }>(
    PROJECT_STORE,
    'readonly',
    (store) => store.get(CURRENT),
  )
  if (!record?.draft) return null

  try {
    return { project: parseDraft(record.draft), savedAt: record.savedAt }
  } catch (error) {
    console.warn('[persistence] discarding an unreadable autosave:', error)
    return null
  }
}

export async function saveMedia(sourceId: string, file: File): Promise<void> {
  await transact(MEDIA_STORE, 'readwrite', (store) => store.put(file, sourceId))
}

export async function forgetMedia(sourceId: string): Promise<void> {
  await transact(MEDIA_STORE, 'readwrite', (store) => store.delete(sourceId))
}

/** Every stored media file, by the sourceId it belongs to. */
export async function loadAllMedia(): Promise<Map<string, File>> {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MEDIA_STORE, 'readonly')
    const store = transaction.objectStore(MEDIA_STORE)
    const found = new Map<string, File>()

    const cursor = store.openCursor()
    cursor.onsuccess = () => {
      const at = cursor.result
      if (!at) return

      const value = at.value
      // Anything that is not a file any more is skipped rather than trusted.
      if (value instanceof File) found.set(String(at.key), value)
      at.continue()
    }

    transaction.oncomplete = () => resolve(found)
    transaction.onerror = () => reject(transaction.error)
  })
}

/** Throws everything away: the timeline and every file it was using. */
export async function clearEverything(): Promise<void> {
  await transact(PROJECT_STORE, 'readwrite', (store) => store.clear())
  await transact(MEDIA_STORE, 'readwrite', (store) => store.clear())
}

/**
 * How much room the saved data is taking, and how much there is.
 *
 * Both are the whole origin's rather than this app's alone, which is what the
 * browser reports and what actually runs out.
 */
export async function storageUsage(): Promise<{
  usageBytes: number
  quotaBytes: number
} | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return null
  }

  const estimate = await navigator.storage.estimate()
  return {
    usageBytes: estimate.usage ?? 0,
    quotaBytes: estimate.quota ?? 0,
  }
}

/**
 * Asks the browser not to evict the saved project under storage pressure.
 *
 * Best effort by design: it is granted or refused on the browser's own terms,
 * and the editor works either way.
 */
export async function requestDurableStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return false
  }

  try {
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** Test seam: forgets the cached connection so a fresh one is opened. */
export function closeDatabase(): void {
  const pending = database
  database = null
  void pending?.then((db) => db.close()).catch(() => {})
}
