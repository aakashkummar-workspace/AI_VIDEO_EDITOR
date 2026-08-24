import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHOT_OPTIONS,
  frameDistance,
  shotBoundaries,
  shotsFrom,
  type FrameSignature,
} from './shots'

const SECOND = 1_000_000

/** A signature of one flat brightness, which is enough to compare shots by. */
function flat(value: number): number[] {
  return Array.from({ length: 64 }, () => value)
}

/** Frames one second apart, each given a brightness. */
function everySecond(values: number[][]): FrameSignature[] {
  return values.map((grid, index) => ({ atMicros: index * SECOND, grid }))
}

describe('frameDistance', () => {
  it('is zero for a frame against itself', () => {
    expect(frameDistance(flat(120), flat(120))).toBe(0)
  })

  it('is one for black against white', () => {
    expect(frameDistance(flat(0), flat(255))).toBe(1)
  })

  it('notices WHERE the brightness is, not just how much there is', () => {
    // A histogram would call these identical. A shot of a bright sky over a
    // dark field is not the same shot upside down.
    const top = [...flat(0).slice(0, 32), ...flat(255).slice(0, 32)]
    const bottom = [...flat(255).slice(0, 32), ...flat(0).slice(0, 32)]
    expect(frameDistance(top, bottom)).toBe(1)
  })

  it('refuses to compare signatures of different sizes', () => {
    // Zero rather than a guess: two grids measured differently cannot be
    // compared, and reporting a large difference would invent a cut.
    expect(frameDistance(flat(0), [1, 2, 3])).toBe(0)
    expect(frameDistance([], [])).toBe(0)
  })
})

describe('shotBoundaries', () => {
  it('finds a hard cut', () => {
    const frames = everySecond([flat(30), flat(30), flat(220), flat(220)])
    expect(shotBoundaries(frames)).toEqual([2 * SECOND])
  })

  it('never reports the start of the file', () => {
    // The first frame is where the footage begins, not a change. Reporting it
    // would have a caller cut at zero.
    expect(shotBoundaries(everySecond([flat(30), flat(30)]))).toEqual([])
    expect(shotBoundaries([])).toEqual([])
  })

  it('ignores a change too small to be a cut', () => {
    // A pan, or a face moving in front of a static background.
    const frames = everySecond([flat(100), flat(110), flat(120), flat(128)])
    expect(shotBoundaries(frames)).toEqual([])
  })

  it('reads a dissolve as one change, not four', () => {
    // A dissolve is several large differences running together; the first of
    // them is the cut and the rest are that same cut still happening.
    const frames = [
      { atMicros: 0, grid: flat(0) },
      { atMicros: 200_000, grid: flat(80) },
      { atMicros: 400_000, grid: flat(160) },
      { atMicros: 600_000, grid: flat(240) },
      { atMicros: 800_000, grid: flat(255) },
    ]
    expect(shotBoundaries(frames)).toEqual([200_000])
  })

  it('finds a second cut once the shot has lasted long enough', () => {
    const frames = everySecond([
      flat(20),
      flat(20),
      flat(230),
      flat(230),
      flat(20),
    ])
    expect(shotBoundaries(frames)).toEqual([2 * SECOND, 4 * SECOND])
  })

  it('reports the frame AFTER the change, so a cut keeps none of the old shot', () => {
    // The boundary is only known to lie between two samples. Taking the later
    // one means a cut placed here never keeps a frame of what was outgoing.
    const frames = everySecond([flat(20), flat(230)])
    expect(shotBoundaries(frames)).toEqual([1 * SECOND])
  })

  it('takes the threshold it is given', () => {
    const frames = everySecond([flat(100), flat(140)])
    expect(shotBoundaries(frames)).toEqual([])
    expect(
      shotBoundaries(frames, { ...DEFAULT_SHOT_OPTIONS, threshold: 0.1 }),
    ).toEqual([SECOND])
  })
})

describe('shotsFrom', () => {
  it('divides the source at the boundaries', () => {
    expect(shotsFrom([4 * SECOND], 10 * SECOND)).toEqual([
      { startMicros: 0, endMicros: 4 * SECOND },
      { startMicros: 4 * SECOND, endMicros: 10 * SECOND },
    ])
  })

  it('calls footage that never cuts ONE shot, not none', () => {
    // A caller asking which shot a moment is in has to get an answer for every
    // moment, including in a file that never cuts.
    expect(shotsFrom([], 10 * SECOND)).toEqual([
      { startMicros: 0, endMicros: 10 * SECOND },
    ])
  })

  it('ignores a boundary outside the file', () => {
    expect(shotsFrom([0, 20 * SECOND], 10 * SECOND)).toEqual([
      { startMicros: 0, endMicros: 10 * SECOND },
    ])
  })

  it('covers every moment exactly once', () => {
    const shots = shotsFrom([3 * SECOND, 7 * SECOND], 10 * SECOND)
    expect(shots[0]!.startMicros).toBe(0)
    expect(shots[shots.length - 1]!.endMicros).toBe(10 * SECOND)
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i]!.startMicros).toBe(shots[i - 1]!.endMicros)
    }
  })
})
