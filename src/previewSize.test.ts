import { describe, expect, it } from 'vitest'
import { PREVIEW_MAX_PX, previewScaleFor, previewSizeFor } from './previewSize'

describe('the preview surface', () => {
  it('leaves an ordinary composition exactly alone', () => {
    // Not a quality setting: anything that can reach a screen is untouched, so
    // the common case draws at its own size and nothing is resampled.
    for (const composition of [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 320, height: 240 },
    ]) {
      expect(previewScaleFor(composition)).toBe(1)
      expect(previewSizeFor(composition)).toEqual(composition)
    }
  })

  it('caps a phone recording, which is where the work goes', () => {
    // 2160x3840 is eight and a half megapixels, sixty times a second, drawn
    // into a canvas a few hundred pixels wide on screen.
    const size = previewSizeFor({ width: 2160, height: 3840 })

    expect(size).toEqual({ width: 1080, height: 1920 })
    // A quarter of the pixels, which is a quarter of the compositing.
    expect(size.width * size.height).toBe((2160 * 3840) / 4)
  })

  it('keeps the shape, so nothing is stretched', () => {
    const composition = { width: 3840, height: 2160 }
    const size = previewSizeFor(composition)

    const before = composition.width / composition.height
    const after = size.width / size.height
    expect(Math.abs(before - after)).toBeLessThan(0.01)
  })

  it('caps by the LONGEST side, whichever way up it is', () => {
    const landscape = previewSizeFor({ width: 4000, height: 1000 })
    const portrait = previewSizeFor({ width: 1000, height: 4000 })

    expect(landscape.width).toBe(PREVIEW_MAX_PX)
    expect(portrait.height).toBe(PREVIEW_MAX_PX)
  })

  it('rounds up, so the surface is never short of what is drawn', () => {
    // A canvas a fraction of a pixel small leaves a seam down the edge.
    const size = previewSizeFor({ width: 2161, height: 3841 })
    expect(size.width).toBeGreaterThanOrEqual(2161 * previewScaleFor({ width: 2161, height: 3841 }))
  })

  it('never returns nothing at all', () => {
    expect(previewSizeFor({ width: 0, height: 0 })).toEqual({
      width: 0,
      height: 0,
    })
    const tiny = previewSizeFor({ width: 1, height: 100_000 })
    expect(tiny.width).toBeGreaterThanOrEqual(1)
  })
})
