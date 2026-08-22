import { describe, expect, it } from 'vitest'
import {
  SCHEDULE_LEAD_SECONDS,
  contextTimeFor,
  timelineMicrosAt,
  type ClockAnchor,
} from './audioSync'
import { joinIntoRuns } from './player'

const SECOND = 1_000_000

/** Playback started at timeline 2s, 10.5s into the context's life. */
const anchor: ClockAnchor = { contextTime: 10.5, timelineMicros: 2 * SECOND }

describe('timelineMicrosAt', () => {
  it('is the anchor position at the anchor moment', () => {
    expect(timelineMicrosAt(anchor, anchor.contextTime)).toBe(2 * SECOND)
  })

  it('advances with the audio clock', () => {
    expect(timelineMicrosAt(anchor, 11.5)).toBe(3 * SECOND)
    expect(timelineMicrosAt(anchor, 13)).toBe(4_500_000)
  })

  it('reads back before the anchor too', () => {
    expect(timelineMicrosAt(anchor, 10)).toBe(1_500_000)
  })

  it('returns whole microseconds', () => {
    expect(Number.isInteger(timelineMicrosAt(anchor, 10.5000001))).toBe(true)
  })
})

describe('contextTimeFor', () => {
  it('is the inverse of timelineMicrosAt', () => {
    for (const contextTime of [10.5, 11, 12.25, 20]) {
      const timeline = timelineMicrosAt(anchor, contextTime)
      expect(contextTimeFor(anchor, timeline)).toBeCloseTo(contextTime, 9)
    }
  })

  it('places the anchor position at the anchor time', () => {
    expect(contextTimeFor(anchor, 2 * SECOND)).toBe(10.5)
  })
})

describe('the scheduling lead', () => {
  it('clears the worst seek measured for video', () => {
    // scripts/measure-seek.mjs put the worst warm seek at 95ms. Starting
    // playback with less lead than that means the first frames are already
    // late before anything is scheduled.
    expect(SCHEDULE_LEAD_SECONDS * 1000).toBeGreaterThan(95)
  })

  it('stays short enough not to feel like a delay', () => {
    expect(SCHEDULE_LEAD_SECONDS).toBeLessThanOrEqual(0.25)
  })
})

describe('joinIntoRuns', () => {
  function chunk(timelineMicros: number, frames: number, sampleRate = 48_000) {
    return {
      timelineMicros,
      sampleRate,
      planes: [new Float32Array(frames)] as Float32Array<ArrayBuffer>[],
    }
  }

  /** 1024 frames at 48kHz is 21333.33us. */
  const STEP = Math.round((1024 / 48_000) * 1e6)

  it('collapses a contiguous stretch to a single run', () => {
    // The reason this exists: one node per decoded packet took
    // OfflineAudioContext 80 seconds to render a two minute timeline.
    const chunks = Array.from({ length: 500 }, (_, index) =>
      chunk(index * STEP, 1024),
    )

    const runs = joinIntoRuns(chunks)

    expect(runs).toHaveLength(1)
    expect(runs[0]!.frames).toBe(500 * 1024)
    expect(runs[0]!.startMicros).toBe(0)
  })

  it('breaks at a gap', () => {
    const runs = joinIntoRuns([
      chunk(0, 1024),
      chunk(STEP, 1024),
      // A second later: a gap in the timeline.
      chunk(1_000_000, 1024),
    ])

    expect(runs).toHaveLength(2)
    expect(runs[0]!.frames).toBe(2048)
    expect(runs[1]!.startMicros).toBe(1_000_000)
  })

  it('breaks when the sample rate changes', () => {
    const runs = joinIntoRuns([chunk(0, 1024), chunk(STEP, 1024, 44_100)])

    expect(runs).toHaveLength(2)
    expect(runs[1]!.sampleRate).toBe(44_100)
  })

  it('breaks when the channel count changes', () => {
    const stereo = {
      timelineMicros: STEP,
      sampleRate: 48_000,
      planes: [
        new Float32Array(1024),
        new Float32Array(1024),
      ] as Float32Array<ArrayBuffer>[],
    }

    expect(joinIntoRuns([chunk(0, 1024), stereo])).toHaveLength(2)
  })

  it('tolerates the rounding in packet timestamps', () => {
    // Timestamps come back as whole microseconds, so a run of packets drifts
    // a fraction of a microsecond from the ideal each time.
    const runs = joinIntoRuns([
      chunk(0, 1024),
      chunk(STEP - 1, 1024),
      chunk(2 * STEP + 1, 1024),
    ])

    expect(runs).toHaveLength(1)
  })

  it('ignores empty chunks', () => {
    expect(joinIntoRuns([chunk(0, 0)])).toEqual([])
    expect(joinIntoRuns([])).toEqual([])
  })
})
