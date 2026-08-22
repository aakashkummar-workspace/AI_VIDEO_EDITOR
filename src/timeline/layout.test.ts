import { describe, expect, it } from 'vitest'
import {
  PIXELS_PER_SECOND,
  TRAILING_PIXELS,
  clampToTimeline,
  microsToPixels,
  pixelsToMicros,
  rulerTicks,
  trackWidth,
} from './layout'

const SECOND = 1_000_000

describe('microsToPixels', () => {
  it('scales at the given pixels per second', () => {
    expect(microsToPixels(SECOND, 100)).toBe(100)
    expect(microsToPixels(2 * SECOND, 100)).toBe(200)
    expect(microsToPixels(500_000, 100)).toBe(50)
    expect(microsToPixels(0, 100)).toBe(0)
  })

  it('defaults to the fixed project scale', () => {
    expect(microsToPixels(SECOND)).toBe(PIXELS_PER_SECOND)
  })
})

describe('pixelsToMicros', () => {
  it('inverts microsToPixels', () => {
    for (const micros of [0, 250_000, SECOND, 7_333_000]) {
      expect(pixelsToMicros(microsToPixels(micros, 100), 100)).toBe(micros)
    }
  })

  it('always returns whole microseconds', () => {
    const micros = pixelsToMicros(33.7, 100)

    expect(Number.isInteger(micros)).toBe(true)
    expect(micros).toBe(337_000)
  })
})

describe('trackWidth', () => {
  it('is the timeline length plus a little trailing room', () => {
    expect(trackWidth(2 * SECOND, 100)).toBe(200 + TRAILING_PIXELS)
  })

  it('is never negative for an empty timeline', () => {
    expect(trackWidth(0, 100)).toBe(TRAILING_PIXELS)
  })
})

describe('clampToTimeline', () => {
  it('keeps a click inside the timeline', () => {
    expect(clampToTimeline(-500, 5 * SECOND)).toBe(0)
    expect(clampToTimeline(9 * SECOND, 5 * SECOND)).toBe(5 * SECOND)
    expect(clampToTimeline(2 * SECOND, 5 * SECOND)).toBe(2 * SECOND)
  })

  it('rounds to whole microseconds', () => {
    expect(clampToTimeline(1234.6, 5 * SECOND)).toBe(1235)
  })

  it('collapses to zero on an empty timeline', () => {
    expect(clampToTimeline(1234, 0)).toBe(0)
  })
})

describe('rulerTicks', () => {
  it('marks every second, including one past the end', () => {
    const ticks = rulerTicks(2_500_000, 100)

    expect(ticks.map((tick) => tick.label)).toEqual(['0s', '1s', '2s', '3s'])
    expect(ticks.map((tick) => tick.x)).toEqual([0, 100, 200, 300])
  })

  it('marks whole-second timelines without an extra tick', () => {
    expect(rulerTicks(3 * SECOND, 100).map((tick) => tick.label)).toEqual([
      '0s',
      '1s',
      '2s',
      '3s',
    ])
  })

  it('still marks zero on an empty timeline', () => {
    expect(rulerTicks(0, 100)).toEqual([{ micros: 0, x: 0, label: '0s' }])
  })
})
