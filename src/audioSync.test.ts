import { describe, expect, it } from 'vitest'
import {
  SCHEDULE_LEAD_SECONDS,
  contextTimeFor,
  timelineMicrosAt,
  type ClockAnchor,
} from './audioSync'

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
