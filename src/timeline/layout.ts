/**
 * Turning timeline microseconds into screen pixels and back.
 *
 * Pure geometry: no DOM, no React. Time in, pixels out.
 */

import { MICROS_PER_SECOND } from '../playback'

/** Zoom level a project opens at. */
export const DEFAULT_PIXELS_PER_SECOND = 100

/** Zoom limits. Below this a long timeline is unreadable, above it useless. */
export const MIN_PIXELS_PER_SECOND = 5
export const MAX_PIXELS_PER_SECOND = 400

/** One notch of the zoom buttons or a wheel click. */
export const ZOOM_STEP = 1.25

/** How much empty track to show past the end of the last clip. */
export const TRAILING_PIXELS = 40

/** Narrowest gap between ruler labels before they start to collide. */
const MIN_LABEL_SPACING_PIXELS = 60

/** The tick intervals the ruler is allowed to use, in seconds. */
const TICK_INTERVALS_SECONDS = [1, 5, 10, 30] as const

export function microsToPixels(
  micros: number,
  pixelsPerSecond: number = DEFAULT_PIXELS_PER_SECOND,
): number {
  return (micros / MICROS_PER_SECOND) * pixelsPerSecond
}

/** Inverse of microsToPixels. Always returns whole microseconds. */
export function pixelsToMicros(
  pixels: number,
  pixelsPerSecond: number = DEFAULT_PIXELS_PER_SECOND,
): number {
  return Math.round((pixels / pixelsPerSecond) * MICROS_PER_SECOND)
}

/** Width of the scrollable track for a timeline of this length. */
export function trackWidth(
  durationMicros: number,
  pixelsPerSecond: number = DEFAULT_PIXELS_PER_SECOND,
): number {
  return (
    Math.max(0, microsToPixels(durationMicros, pixelsPerSecond)) +
    TRAILING_PIXELS
  )
}

export function clampToTimeline(micros: number, durationMicros: number): number {
  return Math.min(Math.max(Math.round(micros), 0), Math.max(0, durationMicros))
}

export function clampZoom(pixelsPerSecond: number): number {
  if (!Number.isFinite(pixelsPerSecond)) return DEFAULT_PIXELS_PER_SECOND
  return Math.min(
    Math.max(pixelsPerSecond, MIN_PIXELS_PER_SECOND),
    MAX_PIXELS_PER_SECOND,
  )
}

/**
 * Zooms by `factor` while keeping whatever is under the cursor under it.
 *
 * `cursorOffsetPixels` is measured from the left edge of the visible strip, so
 * the time under the cursor is (scrollLeft + offset) / pixelsPerSecond. Solving
 * for the scroll position that keeps that time at the same offset afterwards
 * gives the result below.
 */
export function zoomAround(options: {
  pixelsPerSecond: number
  scrollLeft: number
  cursorOffsetPixels: number
  factor: number
}): { pixelsPerSecond: number; scrollLeft: number } {
  const { scrollLeft, cursorOffsetPixels } = options
  const next = clampZoom(options.pixelsPerSecond * options.factor)
  const scale = next / options.pixelsPerSecond

  return {
    pixelsPerSecond: next,
    scrollLeft: Math.max(
      0,
      (scrollLeft + cursorOffsetPixels) * scale - cursorOffsetPixels,
    ),
  }
}

/** The zoom at which the whole timeline just fits the visible width. */
export function fitPixelsPerSecond(
  durationMicros: number,
  availableWidth: number,
): number {
  if (durationMicros <= 0 || availableWidth <= 0) {
    return DEFAULT_PIXELS_PER_SECOND
  }

  const seconds = durationMicros / MICROS_PER_SECOND
  return clampZoom((availableWidth - TRAILING_PIXELS) / seconds)
}

/**
 * The coarsest-looking ruler that still reads: the smallest allowed interval
 * whose labels are at least MIN_LABEL_SPACING_PIXELS apart. Zoomed right out,
 * a tick every second would be an unreadable smear.
 */
export function tickIntervalSeconds(pixelsPerSecond: number): number {
  for (const interval of TICK_INTERVALS_SECONDS) {
    if (interval * pixelsPerSecond >= MIN_LABEL_SPACING_PIXELS) return interval
  }
  return TICK_INTERVALS_SECONDS[TICK_INTERVALS_SECONDS.length - 1]!
}

/** Formats a tick label: seconds while short, m:ss once past a minute. */
export function tickLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export type RulerTick = {
  micros: number
  x: number
  label: string
}

/**
 * Ticks from zero up to and including the first one at or past the end of the
 * timeline, so the last clip's tail always has a mark beyond it. The interval
 * widens as the zoom drops so labels never overlap.
 */
export function rulerTicks(
  durationMicros: number,
  pixelsPerSecond: number = DEFAULT_PIXELS_PER_SECOND,
): RulerTick[] {
  const interval = tickIntervalSeconds(pixelsPerSecond)
  const lastSecond =
    Math.ceil(Math.max(0, durationMicros) / MICROS_PER_SECOND / interval) *
    interval

  const ticks: RulerTick[] = []
  for (let second = 0; second <= lastSecond; second += interval) {
    const micros = second * MICROS_PER_SECOND
    ticks.push({
      micros,
      x: microsToPixels(micros, pixelsPerSecond),
      label: tickLabel(second),
    })
  }

  return ticks
}
