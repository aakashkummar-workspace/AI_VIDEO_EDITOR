/**
 * Where the non-serializable half of a source lives.
 *
 * The timeline state holds only a Source's plain-JSON metadata; the File itself
 * is kept here, keyed by the same sourceId. Nothing in this module may ever be
 * put into the store.
 */

const files = new Map<string, File>()

export function registerSourceFile(sourceId: string, file: File): void {
  files.set(sourceId, file)
}

export function getSourceFile(sourceId: string): File | undefined {
  return files.get(sourceId)
}

export function requireSourceFile(sourceId: string): File {
  const file = files.get(sourceId)
  if (!file) {
    throw new Error(`No file registered for source ${sourceId}.`)
  }
  return file
}

export function hasSourceFile(sourceId: string): boolean {
  return files.has(sourceId)
}

export function forgetSourceFile(sourceId: string): void {
  files.delete(sourceId)
}

export function clearSourceFiles(): void {
  files.clear()
}
