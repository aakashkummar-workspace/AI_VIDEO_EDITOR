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
 * A THIRD store holds what has been MEASURED from the media - the transcript
 * and the shot descriptions. Those are not part of the project and never travel
 * in a draft, which is right: they are derived, not authored, and a draft
 * somebody else opens has its own files. But not being part of the project is
 * not a reason to throw them away on every reload. A transcript costs minutes of
 * somebody's machine and a description costs real money, where the peaks that
 * live beside them cost milliseconds - so these are kept and the peaks are not.
 * Keyed by sourceId, like the media, and dropped with it.
 *
 * Media is stored as the File itself rather than as a file-system handle.
 * Handles would avoid duplicating the bytes, but they only exist for files
 * opened through the file picker, and they need permission granting again on
 * every return. A File survives IndexedDB whole - name, type and contents -
 * and comes back with nothing to ask the user.
 */

import { draftName, parseDraft, toDraft } from './draft'
import type { Project } from './types'

const DATABASE_NAME = 'video-editor'
const DATABASE_VERSION = 2

const PROJECT_STORE = 'project'
const MEDIA_STORE = 'media'
const MEASURED_STORE = 'measured'

/**
 * The key the single autosave slot used to live under.
 *
 * There are many projects now, each under its own id, but a browser that was
 * last used before that still has one project sitting here - and it is
 * somebody's work. It is adopted on first read rather than left behind, which
 * is why this constant survives the feature that replaced it.
 */
const LEGACY_SLOT = 'current'

export type SavedProject = {
  id: string
  name: string
  project: Project
  savedAt: number
}

/** A project as it appears in a list: everything but the timeline itself. */
export type ProjectSummary = {
  id: string
  name: string
  savedAt: number
}

type ProjectRecord = {
  id?: string
  name?: string
  savedAt: number
  draft: unknown
}

/** What a project is called before anybody names it. */
export const UNTITLED = 'Untitled'

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
      if (!db.objectStoreNames.contains(MEASURED_STORE)) {
        db.createObjectStore(MEASURED_STORE)
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

/** Writes one project to its own slot. */
export async function saveProject(
  id: string,
  name: string,
  project: Project,
): Promise<number> {
  const savedAt = Date.now()
  const record: ProjectRecord = {
    id,
    name,
    savedAt,
    draft: toDraft(project, name),
  }
  await transact(PROJECT_STORE, 'readwrite', (store) => store.put(record, id))
  return savedAt
}

/**
 * Reads one project back, or null if there is none under that id.
 *
 * Throws only for a database that cannot be opened. A stored project that no
 * longer parses is treated as no project at all rather than as a failure: the
 * editor should open empty, not refuse to open.
 */
export async function loadProject(id: string): Promise<SavedProject | null> {
  const record = await transact<ProjectRecord>(PROJECT_STORE, 'readonly', (store) =>
    store.get(id),
  )
  if (!record?.draft) return null

  try {
    return {
      id,
      name: record.name ?? draftName(record.draft) ?? UNTITLED,
      project: parseDraft(record.draft),
      savedAt: record.savedAt,
    }
  } catch (error) {
    console.warn('[persistence] discarding an unreadable project:', error)
    return null
  }
}

/**
 * Every project, newest first.
 *
 * An entry that no longer parses is skipped rather than thrown: one corrupt
 * project must not make the other four unreachable.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const db = await openDatabase()

  const found = await new Promise<ProjectSummary[]>((resolve, reject) => {
    const transaction = db.transaction(PROJECT_STORE, 'readonly')
    const store = transaction.objectStore(PROJECT_STORE)
    const out: ProjectSummary[] = []

    const cursor = store.openCursor()
    cursor.onsuccess = () => {
      const at = cursor.result
      if (!at) return

      const record = at.value as ProjectRecord | undefined
      if (record?.draft) {
        const key = String(at.key)
        out.push({
          id: record.id ?? key,
          name: record.name ?? draftName(record.draft) ?? UNTITLED,
          savedAt: record.savedAt ?? 0,
        })
      }
      at.continue()
    }

    transaction.oncomplete = () => resolve(out)
    transaction.onerror = () => reject(transaction.error)
  })

  return found.sort((a, b) => b.savedAt - a.savedAt)
}

/**
 * Gives the one pre-names autosave an id, so it appears in the list.
 *
 * Somebody's work does not stop being theirs because the shape of the store
 * changed underneath it. Returns the id it now has, or null if there was
 * nothing to adopt.
 */
export async function adoptLegacyProject(id: string): Promise<string | null> {
  const record = await transact<ProjectRecord>(PROJECT_STORE, 'readonly', (store) =>
    store.get(LEGACY_SLOT),
  )
  if (!record?.draft) return null

  await transact(PROJECT_STORE, 'readwrite', (store) =>
    store.put({ ...record, id, name: record.name ?? UNTITLED }, id),
  )
  await transact(PROJECT_STORE, 'readwrite', (store) =>
    store.delete(LEGACY_SLOT),
  )
  return id
}

export async function renameProject(id: string, name: string): Promise<void> {
  const record = await transact<ProjectRecord>(PROJECT_STORE, 'readonly', (store) =>
    store.get(id),
  )
  if (!record) return

  await transact(PROJECT_STORE, 'readwrite', (store) =>
    store.put({ ...record, name }, id),
  )
}

/**
 * Throws one project away.
 *
 * The MEDIA is deliberately left alone. A file can be in more than one project,
 * and there is no way to know from here whether it is - deleting it would take
 * a clip out of a project nobody asked about. Unused files are the cheaper
 * mistake.
 */
export async function deleteProject(id: string): Promise<void> {
  await transact(PROJECT_STORE, 'readwrite', (store) => store.delete(id))
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

/**
 * What has been worked out ABOUT a source, as opposed to what it is.
 *
 * Deliberately untyped here: this module knows about storage, not about what a
 * transcript or a shot list looks like. The caller parses what it gets back,
 * which is also what makes an entry written by an older build harmless.
 */
export async function saveMeasured(
  sourceId: string,
  measured: unknown,
): Promise<void> {
  await transact(MEASURED_STORE, 'readwrite', (store) =>
    store.put(measured, sourceId),
  )
}

export async function forgetMeasured(sourceId: string): Promise<void> {
  await transact(MEASURED_STORE, 'readwrite', (store) => store.delete(sourceId))
}

/** Everything measured, by the sourceId it belongs to. */
export async function loadAllMeasured(): Promise<Map<string, unknown>> {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MEASURED_STORE, 'readonly')
    const store = transaction.objectStore(MEASURED_STORE)
    const found = new Map<string, unknown>()

    const cursor = store.openCursor()
    cursor.onsuccess = () => {
      const at = cursor.result
      if (!at) return
      found.set(String(at.key), at.value)
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
  await transact(MEASURED_STORE, 'readwrite', (store) => store.clear())
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
