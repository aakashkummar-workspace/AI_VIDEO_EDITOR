import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PIXELS_PER_SECOND,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  TRAILING_PIXELS,
  clampToTimeline,
  clampZoom,
  fitPixelsPerSecond,
  microsToPixels,
  pixelsToMicros,
  rulerTicks,
  tickIntervalSeconds,
  tickLabel,
  trackWidth,
  zoomAround,
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
    expect(microsToPixels(SECOND)).toBe(DEFAULT_PIXELS_PER_SECOND)
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
  it('marks every second at the default zoom, including one past the end', () => {
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

describe('clampZoom', () => {
  it('holds the zoom inside its range', () => {
    expect(clampZoom(1)).toBe(MIN_PIXELS_PER_SECOND)
    expect(clampZoom(9999)).toBe(MAX_PIXELS_PER_SECOND)
    expect(clampZoom(100)).toBe(100)
  })

  it('falls back to the default for a nonsense value', () => {
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_PIXELS_PER_SECOND)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PIXELS_PER_SECOND)
  })
})

describe('zoomAround', () => {
  it('keeps the time under the cursor under the cursor', () => {
    // 3s is under a cursor 100px into a strip scrolled to 200px, at 100px/s.
    const before = { pixelsPerSecond: 100, scrollLeft: 200 }
    const cursorOffsetPixels = 100
    const timeUnderCursor =
      (before.scrollLeft + cursorOffsetPixels) / before.pixelsPerSecond

    const after = zoomAround({ ...before, cursorOffsetPixels, factor: 2 })

    expect(timeUnderCursor).toBe(3)
    expect(
      (after.scrollLeft + cursorOffsetPixels) / after.pixelsPerSecond,
    ).toBeCloseTo(timeUnderCursor, 6)
  })

  it('holds the anchor when zooming out too', () => {
    const cursorOffsetPixels = 250
    const after = zoomAround({
      pixelsPerSecond: 200,
      scrollLeft: 400,
      cursorOffsetPixels,
      factor: 0.5,
    })

    expect((after.scrollLeft + cursorOffsetPixels) / after.pixelsPerSecond)
      .toBeCloseTo((400 + cursorOffsetPixels) / 200, 6)
  })

  it('never scrolls to a negative position', () => {
    const after = zoomAround({
      pixelsPerSecond: 100,
      scrollLeft: 0,
      cursorOffsetPixels: 10,
      factor: 0.5,
    })

    expect(after.scrollLeft).toBeGreaterThanOrEqual(0)
  })

  it('respects the zoom limits', () => {
    expect(
      zoomAround({
        pixelsPerSecond: MAX_PIXELS_PER_SECOND,
        scrollLeft: 0,
        cursorOffsetPixels: 0,
        factor: 4,
      }).pixelsPerSecond,
    ).toBe(MAX_PIXELS_PER_SECOND)

    expect(
      zoomAround({
        pixelsPerSecond: MIN_PIXELS_PER_SECOND,
        scrollLeft: 0,
        cursorOffsetPixels: 0,
        factor: 0.25,
      }).pixelsPerSecond,
    ).toBe(MIN_PIXELS_PER_SECOND)
  })
})

describe('fitPixelsPerSecond', () => {
  it('makes the timeline just fit the strip', () => {
    // 10s into 1040px of strip, less the trailing room, is 100px/s.
    expect(fitPixelsPerSecond(10 * SECOND, 1040)).toBe(100)
  })

  it('stays inside the zoom range for extreme timelines', () => {
    expect(fitPixelsPerSecond(3 * 60 * 60 * SECOND, 800)).toBe(
      MIN_PIXELS_PER_SECOND,
    )
    expect(fitPixelsPerSecond(100_000, 2000)).toBe(MAX_PIXELS_PER_SECOND)
  })

  it('falls back to the default with nothing to fit', () => {
    expect(fitPixelsPerSecond(0, 800)).toBe(DEFAULT_PIXELS_PER_SECOND)
    expect(fitPixelsPerSecond(5 * SECOND, 0)).toBe(DEFAULT_PIXELS_PER_SECOND)
  })
})

describe('tickIntervalSeconds', () => {
  it('widens the interval as the zoom drops', () => {
    expect(tickIntervalSeconds(400)).toBe(1)
    expect(tickIntervalSeconds(100)).toBe(1)
    expect(tickIntervalSeconds(60)).toBe(1)
    expect(tickIntervalSeconds(30)).toBe(5)
    expect(tickIntervalSeconds(10)).toBe(10)
    expect(tickIntervalSeconds(5)).toBe(30)
  })

  it('never lets labels come closer than the minimum spacing', () => {
    for (let zoom = MIN_PIXELS_PER_SECOND; zoom <= MAX_PIXELS_PER_SECOND; zoom++) {
      expect(tickIntervalSeconds(zoom) * zoom).toBeGreaterThanOrEqual(60)
    }
  })
})

describe('tickLabel', () => {
  it('counts seconds up to a minute', () => {
    expect(tickLabel(0)).toBe('0s')
    expect(tickLabel(45)).toBe('45s')
  })

  it('switches to minutes and seconds past that', () => {
    expect(tickLabel(60)).toBe('1:00')
    expect(tickLabel(90)).toBe('1:30')
    expect(tickLabel(605)).toBe('10:05')
  })
})

describe('rulerTicks at other zooms', () => {
  it('thins out when zoomed far out', () => {
    const ticks = rulerTicks(60 * SECOND, MIN_PIXELS_PER_SECOND)

    expect(ticks.map((tick) => tick.label)).toEqual(['0s', '30s', '1:00'])
  })

  it('always reaches past the end of the timeline', () => {
    for (const zoom of [5, 10, 30, 100, 400]) {
      const ticks = rulerTicks(7_300_000, zoom)
      expect(ticks.at(-1)!.micros).toBeGreaterThanOrEqual(7_300_000)
    }
  })
})
