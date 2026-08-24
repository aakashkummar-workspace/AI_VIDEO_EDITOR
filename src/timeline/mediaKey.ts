/**
 * Which FILE a source is, as opposed to which import it was.
 *
 * A sourceId is minted per import, so the same file brought into two projects
 * has two of them. That is right for the timeline - the two projects trim it
 * differently and must not share a range - but it is wrong for everything
 * MEASURED from the file. A transcript costs minutes of somebody's machine and
 * a shot description costs real money, and neither of them changes because the
 * file was opened again somewhere else.
 *
 * So measured things are keyed by this instead: what identifies the bytes,
 * rather than what identifies the import.
 *
 * Size, modified time and name rather than a hash of the contents. Hashing 400
 * megabytes takes seconds and would have to happen before the editor could say
 * whether it already knew the file - and the failure this guards against is
 * somebody re-importing their own footage, not somebody forging a collision.
 * Two different files agreeing on all three is not a thing that happens by
 * accident; if it ever did, the cost is one transcript being wrong and one
 * press of Transcribe again.
 */

export type MediaIdentity = {
  name: string
  size: number
  lastModified?: number
}

export function mediaKeyFor(file: MediaIdentity): string {
  // Ordered most-distinguishing first, so two keys differ as early as possible
  // when read by a person looking at the database.
  return [
    file.size,
    file.lastModified ?? 0,
    // Only the name, never a path: the same file dragged in from two places is
    // the same file, and browsers do not give us a path anyway.
    file.name.trim(),
  ].join(':')
}
