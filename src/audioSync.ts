/**
 * The playback clock.
 *
 * `AudioContext.currentTime` is authoritative, and it is authoritative even
 * when the timeline is silent - a silent project schedules nothing but still
 * reads its position from the audio clock. There is deliberately no second
 * clock path: a fallback that only runs for silent projects would take all the
 * testing while the audio path took all the risk.
 *
 * Audio hardware runs on its own crystal and drifts from performance.now() by
 * tens of ppm, which is tens of milliseconds of lip-sync error over a long
 * timeline. More to the point the failure is asymmetric: a late video frame is
 * invisible, an audio underrun is an audible click that cannot be un-heard. So
 * video follows audio, never the other way round.
 */

import { MICROS_PER_SECOND } from './playback'

/** Ties a moment on the audio clock to a moment on the timeline. */
export type ClockAnchor = {
  /** A reading of AudioContext.currentTime, in seconds. */
  contextTime: number
  /** The timeline position at that moment, in microseconds. */
  timelineMicros: number
}

/**
 * How far ahead of the audio clock playback starts, giving the first buffers
 * somewhere to be scheduled. Below the ~95ms worst-case seek measured for
 * video (scripts/measure-seek.mjs) the first frames would already be late.
 */
export const SCHEDULE_LEAD_SECONDS = 0.2

/** Where the timeline is, given a reading of the audio clock. */
export function timelineMicrosAt(
  anchor: ClockAnchor,
  contextTime: number,
): number {
  return Math.round(
    anchor.timelineMicros +
      (contextTime - anchor.contextTime) * MICROS_PER_SECOND,
  )
}

/** When on the audio clock a given timeline position falls. */
export function contextTimeFor(
  anchor: ClockAnchor,
  timelineMicros: number,
): number {
  return (
    anchor.contextTime +
    (timelineMicros - anchor.timelineMicros) / MICROS_PER_SECOND
  )
}
