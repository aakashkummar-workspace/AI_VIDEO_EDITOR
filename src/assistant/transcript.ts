/**
 * What was said, and when.
 *
 * Claude cannot help with this: it accepts no audio input at all. So the words
 * come from a Whisper running locally, behind `/api/transcribe`, and this is the
 * shape they come back in. Times are SECONDS of SOURCE time - the same clock the
 * waveform is measured against - because a transcript belongs to the FILE, not
 * to whatever is currently on the timeline. Trim a clip and the transcript is
 * re-sliced, exactly as the peaks are.
 *
 * Like the peaks, a transcript is derived from media rather than authored, so it
 * lives in component state and never goes near the store.
 */

import { encodeWav16 } from './wav'

export const TRANSCRIBE_ENDPOINT = '/api/transcribe'

export type TranscriptWord = {
  start: number
  end: number
  word: string
  /** How sure the model was, 0 to 1. Low values are worth showing as doubtful. */
  probability: number
}

export type TranscriptSegment = {
  start: number
  end: number
  text: string
  words: TranscriptWord[]
}

export type Transcript = {
  language: string
  duration: number
  /** Everything said, as one string. */
  text: string
  segments: TranscriptSegment[]
  /**
   * What the sidecar ran on, as 'cuda (int8_float16)' or 'cpu (int8)'.
   *
   * Worth showing: the difference between the two is minutes and seconds, and
   * without it a transcription that fell back to the CPU is indistinguishable
   * from one that is simply long.
   */
  device?: string
  /** Why it is not on the faster thing, when it is not. */
  note?: string
}

type TranscribeError = { error: string }

/**
 * Sends decoded audio away to be transcribed and waits.
 *
 * There is no timeout on purpose. A minute of speech through the medium model on
 * a CPU takes minutes, and abandoning it halfway would throw away the work and
 * leave nothing to show for it.
 */
export async function requestTranscript(
  samples: Float32Array,
  sampleRate: number,
  options: { language?: string; signal?: AbortSignal } = {},
): Promise<Transcript> {
  if (samples.length === 0) {
    throw new Error('That file carries no sound to transcribe.')
  }

  // Left off entirely when nothing is pinned, so the default request is the
  // bare endpoint and the model detects the language itself.
  const query = options.language ? `?language=${options.language}` : ''

  const response = await fetch(`${TRANSCRIBE_ENDPOINT}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: encodeWav16(samples, sampleRate),
    signal: options.signal,
  })

  const body = (await response.json().catch(() => null)) as
    | Transcript
    | TranscribeError
    | null

  if (!response.ok || body === null || 'error' in body) {
    throw new Error(
      body && 'error' in body
        ? body.error
        : `The transcriber could not be reached (${response.status}).`,
    )
  }

  return dropRunawayRepeats(body)
}

/**
 * Throws away a transcript's repetition loops.
 *
 * Whisper has one spectacular failure mode: it gets stuck. A phrase comes out
 * twice, that makes the phrase the likeliest thing to come next, and the model
 * emits it three hundred times. `scripts/transcribe.py` now decodes with the
 * settings that stop it happening, and this is the guard for what still gets
 * through - the two are not redundant, because the decoder fixes each 30-second
 * window on its own and cannot see a loop that spans several of them.
 *
 * It is deliberately blunt. Three consecutive identical phrases is not something
 * anybody says, and a transcript that admits it heard one thing is worth far
 * more than one that pretends to have heard it three hundred times: the point of
 * this text is to cut against, and a fabricated minute of speech would put the
 * cut in the wrong place.
 *
 * A collapsed line loses its word timings, which is the honest answer - the
 * timings inside a loop describe words that were never spoken.
 */
export function dropRunawayRepeats(transcript: Transcript): Transcript {
  const kept: TranscriptSegment[] = []
  let previous = ''

  for (const segment of transcript.segments) {
    const collapsed = collapsePhraseLoop(segment.text)
    const looped = collapsed !== segment.text
    const fingerprint = normalise(collapsed)
    if (fingerprint.length === 0) continue

    // A loop that spans several windows shows up as consecutive segments saying
    // the same thing. Only the first is real.
    if (fingerprint === previous) continue

    // And the window a loop STARTED in ends with the phrase, so the windows
    // after it are a continuation rather than a repeat of the whole line. The
    // suffix is only read as one when this segment was itself collapsed, so a
    // sentence that happens to end on the word somebody says next is safe.
    if (looped && previous.endsWith(` ${fingerprint}`)) continue

    previous = fingerprint
    kept.push(looped ? { ...segment, text: collapsed, words: [] } : segment)
  }

  return {
    ...transcript,
    text: kept.map((segment) => segment.text).join(' '),
    segments: kept,
  }
}

/** For comparing two pieces of text as SPEECH, ignoring how it was punctuated. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"()[\]{}‘’“”…।]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The longest phrase a loop is looked for at, in words. */
const LONGEST_LOOP_WORDS = 8

/** How many times a phrase has to repeat before it is read as a loop. */
const LOOP_REPEATS = 3

/**
 * Collapses a phrase repeated back to back into one copy of it.
 *
 * The shortest phrase wins, because the periods ascend: a single word said over
 * and over is caught at length one rather than being read as a longer phrase
 * repeated fewer times.
 */
function collapsePhraseLoop(text: string): string {
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let at = 0

  while (at < words.length) {
    let looped = false

    for (
      let period = 1;
      period <= LONGEST_LOOP_WORDS && at + period * LOOP_REPEATS <= words.length;
      period++
    ) {
      const unit = normalise(words.slice(at, at + period).join(' '))
      if (unit.length === 0) continue

      let repeats = 1
      while (
        at + (repeats + 1) * period <= words.length &&
        normalise(
          words.slice(at + repeats * period, at + (repeats + 1) * period).join(' '),
        ) === unit
      ) {
        repeats++
      }

      if (repeats >= LOOP_REPEATS) {
        out.push(...words.slice(at, at + period))
        at += repeats * period
        looped = true
        break
      }
    }

    if (!looped) {
      out.push(words[at]!)
      at++
    }
  }

  return out.join(' ')
}
