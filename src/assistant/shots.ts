/**
 * Where the picture changes.
 *
 * This has no model in it, and that is deliberate - the same reasoning
 * `silence.ts` is built on. "Did the shot change here?" has one right answer and
 * it is a question about pixels, so it is arithmetic: a model would be slower,
 * cost money, and disagree with itself between runs. What a model IS for is
 * saying what is IN the shot, and that is `vision.ts`.
 *
 * The input is a SIGNATURE per sampled frame, not the frame: a small grid of
 * brightnesses, measured in the worker while the frame was already decoded. That
 * keeps this module pure and testable without a browser, and it means the frames
 * themselves - which are large - never have to be held to answer this.
 *
 * All times are integer MICROSECONDS of SOURCE time, like everything else that
 * belongs to a file rather than to the timeline.
 */

/** One sampled frame, reduced to something comparable. */
export type FrameSignature = {
  atMicros: number
  /**
   * Brightnesses on a small grid, 0-255, row by row. Every signature in a run
   * has to be the same length or they cannot be compared.
   */
  grid: number[]
}

export type ShotOptions = {
  /**
   * How different two frames have to be to count as a cut, 0 to 1.
   *
   * This is the mean absolute difference across the grid, divided by 255. A
   * hard cut between two unrelated shots lands well above 0.2; a camera pan
   * within one shot stays below 0.1, and so does a face moving in front of a
   * static background.
   */
  threshold: number
  /**
   * How close two boundaries may be, in microseconds.
   *
   * A dissolve reads as several large differences in a row rather than one, and
   * reporting each of them as its own shot would turn a single transition into
   * four one-frame shots. The first is kept and the rest are absorbed.
   */
  minShotMicros: number
}

export const DEFAULT_SHOT_OPTIONS: ShotOptions = {
  threshold: 0.18,
  minShotMicros: 700_000,
}

/**
 * How different two signatures are, from 0 (identical) to 1.
 *
 * Mean absolute difference rather than a histogram comparison: a histogram is
 * blind to WHERE the brightness is, so a shot of a light sky over a dark field
 * and the same shot upside down would read as identical.
 */
export function frameDistance(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0

  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!)
  return total / a.length / 255
}

/**
 * The moments the picture changed, as SOURCE microseconds.
 *
 * Never includes the start of the file. The first frame is not a change - it is
 * simply where the footage begins - and reporting it as one would have a caller
 * cut at zero.
 *
 * Sampling is coarse by nature: a boundary is only known to lie somewhere
 * between the frame before it and the frame reported. What is returned is the
 * later of the two, so a cut made here never keeps a frame of the outgoing shot.
 */
export function shotBoundaries(
  frames: FrameSignature[],
  options: ShotOptions = DEFAULT_SHOT_OPTIONS,
): number[] {
  const boundaries: number[] = []
  let lastKept = -Infinity

  for (let i = 1; i < frames.length; i++) {
    const previous = frames[i - 1]!
    const frame = frames[i]!

    if (frameDistance(previous.grid, frame.grid) < options.threshold) continue

    // A dissolve is several big differences running together. The first of them
    // is the change; the rest are the same change still happening.
    if (frame.atMicros - lastKept < options.minShotMicros) continue

    boundaries.push(frame.atMicros)
    lastKept = frame.atMicros
  }

  return boundaries
}

/**
 * The boundaries turned into the shots they divide the source into.
 *
 * Always at least one shot, covering everything: footage that never cuts is one
 * shot, not none, and a caller asking "which shot is this moment in" has to get
 * an answer for every moment.
 */
export function shotsFrom(
  boundaries: number[],
  durationMicros: number,
): { startMicros: number; endMicros: number }[] {
  const shots: { startMicros: number; endMicros: number }[] = []
  let at = 0

  for (const boundary of boundaries) {
    if (boundary <= at || boundary >= durationMicros) continue
    shots.push({ startMicros: at, endMicros: boundary })
    at = boundary
  }

  shots.push({ startMicros: at, endMicros: durationMicros })
  return shots
}
