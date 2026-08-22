/**
 * Turning timeline microseconds into screen pixels and back.
 *
 * Pure geometry: no DOM, no React. Time in, pixels out.
 */

import { MICROS_PER_SECOND } from '../playback'

/** Fixed zoom, for now. */
export const PIXELS_PER_SECOND = 100

/** How much empty track to show past the end of the last clip. */
export const TRAILING_PIXELS = 40

export function microsToPixels(
  micros: number,
  pixelsPerSecond: number = PIXELS_PER_SECOND,
): number {
  return (micros / MICROS_PER_SECOND) * pixelsPerSecond
}

/** Inverse of microsToPixels. Always returns whole microseconds. */
export function pixelsToMicros(
  pixels: number,
  pixelsPerSecond: number = PIXELS_PER_SECOND,
): number {
  return Math.round((pixels / pixelsPerSecond) * MICROS_PER_SECOND)
}

/** Width of the scrollable track for a timeline of this length. */
export function trackWidth(
  durationMicros: number,
  pixelsPerSecond: number = PIXELS_PER_SECOND,
): number {
  return Math.max(0, microsToPixels(durationMicros, pixelsPerSecond)) +
    TRAILING_PIXELS
}

export function clampToTimeline(micros: number, durationMicros: number): number {
  return Math.min(Math.max(Math.round(micros), 0), Math.max(0, durationMicros))
}

export type RulerTick = {
  micros: number
  x: number
  label: string
}

/**
 * One tick per second, from zero up to and including the second at or past the
 * end of the timeline, so the last clip's tail always has a mark beyond it.
 */
export function rulerTicks(
  durationMicros: number,
  pixelsPerSecond: number = PIXELS_PER_SECOND,
): RulerTick[] {
  const lastSecond = Math.max(0, Math.ceil(durationMicros / MICROS_PER_SECOND))
  const ticks: RulerTick[] = []

  for (let second = 0; second <= lastSecond; second++) {
    const micros = second * MICROS_PER_SECOND
    ticks.push({
      micros,
      x: microsToPixels(micros, pixelsPerSecond),
      label: `${second}s`,
    })
  }

  return ticks
}
