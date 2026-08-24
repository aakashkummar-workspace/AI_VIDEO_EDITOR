/**
 * Reading the edit back.
 *
 * The agent plans against a scratch copy of the project and, until now, could
 * never look at what it had made. It knew what it had asked for and what the
 * timeline was before; whether the result still SAID anything sensible was
 * beyond it. That is the difference between cutting to a script and cutting at
 * numbers taken from one.
 *
 * Nothing here changes a project. These are questions, and they are the only
 * questions in the tool surface - which is why they live beside `tools.ts`
 * rather than in it: every tool in there names a mutator, and these name none.
 */

import { timelineMicrosFor } from './captions'
import {
  segmentEndMicros,
  soundContent,
  type Project,
  type Segment,
} from '../timeline/types'

/** One line of speech, placed where it now falls on the TIMELINE. */
export type SpokenLine = {
  atSeconds: number
  endSeconds: number
  text: string
  /** Which segment plays it, so a further cut can name the right one. */
  segmentId: string
}

/** A transcript as the view carries it, cut down to what this needs. */
export type Scripts = Record<
  string,
  { segments: { start: number; end: number; text: string }[] }
>

/**
 * What the timeline says now, in the order somebody would hear it.
 *
 * Mapped through each segment, so a line spoken in a part that was cut simply
 * is not here - which is the whole point. Reading this after a plan is how the
 * agent finds out that it removed half a sentence.
 */
export function spokenOnTimeline(
  project: Project,
  scripts: Scripts,
): SpokenLine[] {
  const lines: SpokenLine[] = []

  for (const track of project.tracks) {
    for (const segment of track.segments) {
      const sound = soundContent(segment)
      if (!sound) continue

      const script = scripts[sound.sourceId]
      if (!script) continue

      for (const line of script.segments) {
        const text = line.text.trim()
        if (text.length === 0) continue

        const atMicros = timelineMicrosFor(segment, line.start)
        if (atMicros === null) continue

        // Clamped rather than dropped: half a line that survived a cut is
        // still heard, and an agent told otherwise would cut it again.
        const endMicros = Math.min(
          segmentEndMicros(segment),
          timelineMicrosFor(segment, line.end) ?? segmentEndMicros(segment),
        )

        lines.push({
          atSeconds: round(atMicros / 1e6),
          endSeconds: round(endMicros / 1e6),
          text,
          segmentId: segment.id,
        })
      }
    }
  }

  return lines.sort((a, b) => a.atSeconds - b.atSeconds)
}

/** A stretch of source time where nobody is speaking, in seconds. */
export type Pause = { fromSeconds: number; toSeconds: number }

export type BoundaryVerdict = {
  atSeconds: number
  /** The word this lands in the middle of, if it lands in one. */
  insideWord?: string
  /** The pause it lands in, if it lands in one. */
  insidePause?: Pause
  /** Where to put it instead: the middle of the nearest pause. */
  suggestedSeconds?: number
}

/**
 * Whether a proposed cut lands somewhere it can be heard.
 *
 * A boundary taken from a transcript lands where a word BEGINS, which is a
 * moment before the sound and a moment after the breath before it - cutting
 * exactly there clips both. This turns that from something a model has to
 * reason about into something it can look up, which is a far better trade: the
 * arithmetic is trivial and getting it wrong is audible.
 */
export function checkBoundaries(
  seconds: number[],
  words: { start: number; end: number; word: string }[],
  pauses: Pause[],
): BoundaryVerdict[] {
  return seconds.map((atSeconds) => {
    const verdict: BoundaryVerdict = { atSeconds }

    const word = words.find(
      (one) => atSeconds > one.start && atSeconds < one.end,
    )
    if (word) verdict.insideWord = word.word.trim()

    const pause = pauses.find(
      (one) => atSeconds >= one.fromSeconds && atSeconds <= one.toSeconds,
    )
    if (pause) {
      verdict.insidePause = pause
      return verdict
    }

    const nearest = nearestPause(atSeconds, pauses)
    if (nearest) {
      verdict.suggestedSeconds = round(
        (nearest.fromSeconds + nearest.toSeconds) / 2,
      )
    }

    return verdict
  })
}

/** The pause whose nearest edge is closest to a moment. */
function nearestPause(atSeconds: number, pauses: Pause[]): Pause | undefined {
  let best: Pause | undefined
  let bestDistance = Infinity

  for (const pause of pauses) {
    const distance =
      atSeconds < pause.fromSeconds
        ? pause.fromSeconds - atSeconds
        : atSeconds > pause.toSeconds
          ? atSeconds - pause.toSeconds
          : 0

    if (distance < bestDistance) {
      bestDistance = distance
      best = pause
    }
  }

  return best
}

/** Every word of a source's transcript, flattened out of its lines. */
export function wordsOf(script: {
  segments: { words?: { start: number; end: number; word: string }[] }[]
}): { start: number; end: number; word: string }[] {
  return script.segments.flatMap((line) => line.words ?? [])
}

/** Where a segment plays from, for reporting what a cut would touch. */
export function sourceSpanOf(
  segment: Segment,
): { fromSeconds: number; toSeconds: number } | null {
  const sound = soundContent(segment)
  if (!sound) return null
  return {
    fromSeconds: round(sound.sourceInMicros / 1e6),
    toSeconds: round(sound.sourceOutMicros / 1e6),
  }
}

/** Seconds, to the millisecond. Finer than anyone edits by hand. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
