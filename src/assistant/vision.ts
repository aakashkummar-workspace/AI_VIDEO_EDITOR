/**
 * What the footage LOOKS like.
 *
 * The counterpart to `transcript.ts`, and it splits the same way: where the
 * shots CHANGE is arithmetic and lives in `shots.ts`, because that question has
 * one right answer and a model would only be a slower, dearer way to get it
 * wrong occasionally. What is IN a shot is not arithmetic, and that is what
 * this asks for.
 *
 * Like a transcript, a description belongs to the SOURCE and is measured in
 * SOURCE seconds, so it survives a trim and a split. Like a transcript it is
 * derived from media rather than authored, so it lives in component state and
 * never enters the store or a draft.
 *
 * THE PICTURES LEAVE THE MACHINE. This is the one thing in the application that
 * sends footage anywhere - the transcriber is local, and the assistant otherwise
 * sends only names and times. It is behind its own deliberate verb for that
 * reason, and the UI has to say so plainly rather than burying it.
 */

export const VISION_ENDPOINT = '/api/vision'

/** One moment of the source, described. */
export type Shot = {
  /** SOURCE seconds. Where the shot begins. */
  startSeconds: number
  endSeconds: number
  /** What can be seen, in a sentence or two. */
  text: string
}

export type Visuals = {
  /** How often a frame was taken, in seconds. The resolution of every answer. */
  everySeconds: number
  shots: Shot[]
  /** Set when the film was long enough that only part of it was looked at. */
  truncatedAfterSeconds?: number
}

type VisionError = { error: string }

/**
 * How much film is worth looking at, and how closely.
 *
 * A frame every two seconds catches anything a person would call a shot. The
 * cap is what stops a long film turning one click into hundreds of images: past
 * it the sampling simply stops, and `truncatedAfterSeconds` says where, because
 * an agent told nothing would take the description for the whole film.
 */
export const VISION_SAMPLE_SECONDS = 2
export const VISION_MAX_FRAMES = 120

/**
 * Sends sampled frames away to be described.
 *
 * The frames are already small - the worker scales them before they get here -
 * and they are sent as one multipart-ish JSON body with the pictures base64'd,
 * because the shot boundaries have to travel with them and a model asked to
 * describe unlabelled images cannot say when anything happened.
 */
export async function requestVisuals(
  frames: { atMicros: number; jpeg: ArrayBuffer }[],
  boundariesMicros: number[],
  durationMicros: number,
  signal?: AbortSignal,
): Promise<Visuals> {
  if (frames.length === 0) {
    throw new Error('There is no picture in this clip to look at.')
  }

  const response = await fetch(VISION_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      durationMicros,
      boundariesMicros,
      frames: frames.map((frame) => ({
        atMicros: frame.atMicros,
        jpegBase64: base64Of(frame.jpeg),
      })),
    }),
    signal,
  })

  const body = (await response.json().catch(() => null)) as
    | Visuals
    | VisionError
    | null

  if (!response.ok || body === null || 'error' in body) {
    throw new Error(
      body && 'error' in body
        ? body.error
        : `Could not look at the video (${response.status}).`,
    )
  }

  return body
}

/**
 * Bytes as base64.
 *
 * Chunked rather than spread into `String.fromCharCode` in one go: a frame is
 * tens of thousands of bytes and passing that many arguments overflows the
 * call stack in every browser.
 */
function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunks: string[] = []
  const size = 0x8000

  for (let at = 0; at < bytes.length; at += size) {
    chunks.push(String.fromCharCode(...bytes.subarray(at, at + size)))
  }

  return btoa(chunks.join(''))
}
