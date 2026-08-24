/**
 * Turning a transcript into captions.
 *
 * The interesting part is not the words, it is the CLOCK. A transcript is
 * measured in source time, because it belongs to the file; a caption sits on the
 * timeline. So every line has to be mapped through the segment that plays it -
 * which is what makes trimmed clips and sped-up clips come out right, and what
 * makes a line spoken in a part of the file nobody kept simply not appear.
 *
 * One segment of speech becomes one caption. Splitting further would need to
 * know how wide the words are on screen, which is a measuring problem belonging
 * to `fontStringFor`, not to this.
 */

import { secondsToMicros } from '../playback'
import type { PlanStepInput } from '../timeline/store'
import {
  segmentEndMicros,
  soundContent,
  timelineSpanFor,
  type Composition,
  type Project,
  type Segment,
  type Track,
} from '../timeline/types'
import type { Transcript } from './transcript'

export type CaptionOptions = {
  /** Where the words sit, as a fraction of the frame height. */
  verticalFraction: number
  /** Type size, as a fraction of the frame height. */
  sizeFraction: number
  color: string
  /** A box behind the words, or '' for none. */
  backgroundColor: string
}

export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = {
  // Lower third, which is where a viewer looks for them and where they are
  // least likely to cover a face.
  verticalFraction: 0.82,
  sizeFraction: 0.055,
  color: '#ffffff',
  backgroundColor: 'rgb(0 0 0 / 55%)',
}

/**
 * Where a moment of SOURCE time lands on the timeline for a given segment, or
 * null if that moment is not part of what the segment plays.
 *
 * Exported so `inspect.ts` can read the timeline back as speech through the
 * same arithmetic that puts captions on it. Two functions mapping source time
 * onto the timeline would eventually disagree, and the disagreement would show
 * up as a caption in one place and a cut in another.
 */
export function timelineMicrosFor(
  segment: Segment,
  sourceSeconds: number,
): number | null {
  const sound = soundContent(segment)
  if (!sound) return null

  const sourceMicros = secondsToMicros(sourceSeconds)
  if (
    sourceMicros < sound.sourceInMicros ||
    sourceMicros >= sound.sourceOutMicros
  ) {
    return null
  }

  return (
    segment.timelineStartMicros +
    timelineSpanFor(segment, sourceMicros - sound.sourceInMicros)
  )
}

/**
 * The captions for one segment, as store operations.
 *
 * Returned as steps rather than applied, so a whole run of them is ONE undo
 * step - a caption pass over a long interview is one decision, and undoing it a
 * line at a time would be unusable.
 */
export function captionSteps(
  segment: Segment,
  transcript: Transcript,
  textTrack: Track,
  composition: Composition,
  mintId: () => string,
  options: CaptionOptions = DEFAULT_CAPTION_OPTIONS,
): PlanStepInput[] {
  const steps: PlanStepInput[] = []
  const endOfSegment = segmentEndMicros(segment)

  for (const line of transcript.segments) {
    const words = line.text.trim()
    if (words.length === 0) continue

    const startMicros = timelineMicrosFor(segment, line.start)
    if (startMicros === null) continue

    // The end is clamped to the segment rather than dropped: a line half of
    // which was trimmed away should still caption the half that survived.
    const rawEnd =
      timelineMicrosFor(segment, line.end) ??
      Math.min(endOfSegment, startMicros + timelineSpanFor(segment, secondsToMicros(line.end - line.start)))
    const endMicros = Math.min(endOfSegment, rawEnd)

    const durationMicros = endMicros - startMicros
    if (durationMicros <= 0) continue

    steps.push({
      mutator: 'addSegment',
      input: {
        trackId: textTrack.id,
        segment: {
          id: mintId(),
          timelineStartMicros: startMicros,
          content: {
            kind: 'text',
            content: words,
            x: Math.round(composition.width / 2),
            y: Math.round(composition.height * options.verticalFraction),
            sizePx: Math.max(
              8,
              Math.round(composition.height * options.sizeFraction),
            ),
            color: options.color,
            durationMicros,
            align: 'center',
            ...(options.backgroundColor
              ? {
                  backgroundColor: options.backgroundColor,
                  backgroundPaddingPx: Math.round(
                    composition.height * options.sizeFraction * 0.25,
                  ),
                }
              : {}),
          },
        },
      },
    })
  }

  return steps
}

/** Every segment on the timeline that plays a given source. */
export function segmentsUsing(project: Project, sourceId: string): Segment[] {
  const found: Segment[] = []
  for (const track of project.tracks) {
    for (const segment of track.segments) {
      const sound = soundContent(segment)
      if (sound?.sourceId === sourceId) found.push(segment)
    }
  }
  return found
}
