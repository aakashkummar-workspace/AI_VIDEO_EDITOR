import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, wholeSourceSpec } from './fixture.config.mjs'

/**
 * Animation, end to end: the keyframes are resolved inside the one render
 * function, so a fade has to look the same in the preview and in the exported
 * file without either being told about it separately.
 */

const SECOND = 1_000_000
const SOURCE_DURATION = (FIXTURE.frames / FIXTURE.fps) * SECOND

/** The one clip loadProject builds from wholeSourceSpec. */
const CLIP_ID = 'clip-0'

/** Mean of every colour channel in the image, ignoring alpha. */
function meanBrightness(pixels: number[]): number {
  let total = 0
  let count = 0
  for (let i = 0; i < pixels.length; i += 4) {
    total += pixels[i]! + pixels[i + 1]! + pixels[i + 2]!
    count += 3
  }
  return total / count
}

function peakBrightness(pixels: number[]): number {
  let peak = 0
  for (let i = 0; i < pixels.length; i += 4) {
    peak = Math.max(peak, pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)
  }
  return peak
}

function meanChannelDifference(a: number[], b: number[]): number {
  expect(a.length).toBe(b.length)

  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!)
  return total / a.length
}

function pixelsAt(page: Page, micros: number) {
  return page.evaluate((t) => window.harness.pixelsAt(t), micros)
}

/** Cuts a rectangle out of a composition-sized image. */
function cropTo(
  pixels: number[],
  rect: { x: number; y: number; width: number; height: number },
): number[] {
  const out: number[] = []
  for (let row = 0; row < rect.height; row++) {
    const start = ((rect.y + row) * FIXTURE.width + rect.x) * 4
    for (let i = 0; i < rect.width * 4; i++) out.push(pixels[start + i]!)
  }
  return out
}

async function loadClip(page: Page) {
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    wholeSourceSpec('a'),
  )
}

/** Applies edits to the store and republishes the project to the player. */
async function edit(
  page: Page,
  apply: (store: ReturnType<typeof window.__timelineStore.getState>) => void,
) {
  await page.evaluate((source) => {
    const run = new Function('store', `(${source})(store)`) as (
      store: unknown,
    ) => void
    run(window.__timelineStore.getState())
    window.harness.setProject(window.__timelineStore.getState().project)
  }, apply.toString())
}

/** Ramps opacity from nothing to solid across the whole clip. */
async function fadeIn(page: Page) {
  await edit(page, (store) => {
    store.addKeyframe({
      segmentId: 'clip-0',
      property: 'opacity',
      offsetMicros: 0,
      value: 0,
    })
    store.addKeyframe({
      segmentId: 'clip-0',
      property: 'opacity',
      offsetMicros: 6_000_000,
      value: 1,
    })
  })
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('a segment with no transform renders exactly as it did before', async ({
  page,
}) => {
  await loadClip(page)
  const plain = await pixelsAt(page, 2 * SECOND)

  // An explicit identity transform must be a no-op, or every existing frame
  // would shift the day transforms were added.
  await edit(page, (store) => {
    store.setSegmentTransform({
      segmentId: 'clip-0',
      scale: 1,
      x: 0,
      y: 0,
      opacity: 1,
    })
  })

  expect(meanChannelDifference(plain, await pixelsAt(page, 2 * SECOND))).toBe(0)
})

test('an opacity ramp fades the picture up over the clip', async ({ page }) => {
  await loadClip(page)
  await fadeIn(page)

  // At the very head the clip is fully transparent, so the composition is the
  // black it is cleared to.
  expect(peakBrightness(await pixelsAt(page, 0))).toBe(0)

  const early = meanBrightness(await pixelsAt(page, 1 * SECOND))
  const middle = meanBrightness(await pixelsAt(page, 3 * SECOND))
  const late = meanBrightness(await pixelsAt(page, 5 * SECOND))

  console.log(
    `fade: 1s ${early.toFixed(1)}, 3s ${middle.toFixed(1)},` +
      ` 5s ${late.toFixed(1)}`,
  )

  expect(early).toBeGreaterThan(0)
  expect(middle).toBeGreaterThan(early)
  expect(late).toBeGreaterThan(middle)
})

test('the exported file carries the animation, not just the last value', async ({
  page,
}) => {
  await loadClip(page)
  await fadeIn(page)

  const preview = {
    early: await pixelsAt(page, 1 * SECOND),
    middle: await pixelsAt(page, 3 * SECOND),
  }

  await page.evaluate(() => window.harness.exportMp4())
  await page.evaluate(() => window.harness.loadExported())

  const exportedEarly = await pixelsAt(page, 1 * SECOND)
  const exportedMiddle = await pixelsAt(page, 3 * SECOND)

  // The ramp runs over six seconds, so one frame of timing slop is well under
  // a percent of opacity - far inside the tolerance the golden test uses.
  const earlyDiff = meanChannelDifference(preview.early, exportedEarly)
  const middleDiff = meanChannelDifference(preview.middle, exportedMiddle)
  console.log(
    `export vs preview: 1s ${earlyDiff.toFixed(3)}, 3s ${middleDiff.toFixed(3)}`,
  )

  expect(earlyDiff).toBeLessThan(3)
  expect(middleDiff).toBeLessThan(3)

  // And the fade really is in the file, rather than one value held throughout.
  expect(meanBrightness(exportedMiddle)).toBeGreaterThan(
    meanBrightness(exportedEarly),
  )
})

test('scaling a segment down leaves the composition black around it', async ({
  page,
}) => {
  await loadClip(page)
  await edit(page, (store) => {
    store.setSegmentTransform({ segmentId: 'clip-0', scale: 0.5 })
  })

  const scaled = await pixelsAt(page, 2 * SECOND)

  // The outermost rows are outside the shrunken picture now.
  const topStrip = { x: 0, y: 0, width: FIXTURE.width, height: 8 }
  expect(peakBrightness(cropTo(scaled, topStrip))).toBe(0)

  // The centre still has picture in it.
  const centre = {
    x: Math.round(FIXTURE.width / 4),
    y: Math.round(FIXTURE.height / 4),
    width: Math.round(FIXTURE.width / 2),
    height: Math.round(FIXTURE.height / 2),
  }
  expect(peakBrightness(cropTo(scaled, centre))).toBeGreaterThan(0)
})

test('an animation moves with the segment it belongs to', async ({ page }) => {
  await loadClip(page)
  await fadeIn(page)

  const atHead = await pixelsAt(page, 0)
  expect(peakBrightness(atHead)).toBe(0)

  // Slide the clip a second later. The fade is stored as offsets from the
  // head, so the black frame should now be at one second, not at zero.
  await edit(page, (store) => {
    store.moveSegment({ segmentId: 'clip-0', timelineStartMicros: 1_000_000 })
  })

  expect(peakBrightness(await pixelsAt(page, 1 * SECOND))).toBe(0)
  expect(peakBrightness(await pixelsAt(page, 3 * SECOND))).toBeGreaterThan(0)
})

test('animating leaks no frames over a full play-through', async ({ page }) => {
  await loadClip(page)
  await fadeIn(page)
  await page.evaluate(() => window.harness.playThrough())

  const counts = await page.evaluate(() => window.harness.frameCounts())
  expect(counts.worker.created).toBeGreaterThan(0)
  expect(counts.worker.closed + counts.main.closed).toBe(counts.worker.created)
})

test('the clip is the length the fixture says, so the offsets above line up', () => {
  expect(SOURCE_DURATION).toBe(6 * SECOND)
  expect(CLIP_ID).toBe('clip-0')
})
