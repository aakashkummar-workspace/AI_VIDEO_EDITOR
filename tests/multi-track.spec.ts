import { expect, test, type Page } from '@playwright/test'
import {
  FIXTURE,
  FIXTURE_B,
  gappedTimelineSpec,
} from './fixture.config.mjs'

/**
 * Stacked video rows, through the real worker and the one render function.
 *
 * The gapped timeline puts clip A at 0-2s and clip B at 3-5s on the main row,
 * with a gap between them. A second row goes on top carrying source B from
 * 1.5s to 3.5s, so it overlaps the tail of A, covers the whole gap, and
 * overlaps the head of the lower B:
 *
 *   row 2 (upper)          [ src-b 0-2s          ]
 *   row 1 (main)  [ A: src-a 0-2s ]     [ B: src-b 2-4s ]
 *   timeline      0s      1.5s   2s    3s  3.5s      5s
 *
 * Everything below is asserted against what the SAME footage renders as on a
 * single row, so the tests say "an upper row draws exactly as it would alone"
 * rather than hard-coding pixels.
 */

const SECOND = 1_000_000

const SOURCE_B = { id: 'src-b', url: `/${FIXTURE_B.path}` }

/** The segment that goes on the upper row. */
const UPPER = {
  sourceId: SOURCE_B.id,
  sourceInMicros: 0,
  sourceOutMicros: 2 * SECOND,
  timelineStartMicros: 1_500_000,
}

/** The same segment, alone on the main row: the reference to compare against. */
const UPPER_ALONE = {
  composition: { width: FIXTURE.width, height: FIXTURE.height },
  sources: [SOURCE_B],
  clips: [UPPER],
}

/** Both rows have something here, so the upper one has to win. */
const OVER_LOWER_A = 1_750_000
/** Only the upper row reaches into the lower row's gap. */
const IN_LOWER_GAP = 2_500_000
/** Both rows again, this time over the lower row's own clip B. */
const OVER_LOWER_B = 3_250_000
/** Past the upper row: the lower row shows through again. */
const BELOW_ONLY = 4 * SECOND

function meanChannelDifference(a: number[], b: number[]): number {
  expect(a.length).toBe(b.length)

  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!)
  return total / a.length
}

/** Brightest colour channel in the image, ignoring alpha. */
function peakBrightness(pixels: number[]): number {
  let peak = 0
  for (let i = 0; i < pixels.length; i += 4) {
    peak = Math.max(peak, pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)
  }
  return peak
}

function expectSame(label: string, a: number[], b: number[]) {
  const mean = meanChannelDifference(a, b)
  console.log(`${label}: mean channel diff ${mean.toFixed(3)}`)
  expect(mean, label).toBeLessThan(3)
}

function pixelsAt(page: Page, micros: number) {
  return page.evaluate((t) => window.harness.pixelsAt(t), micros)
}

/** The gapped timeline with a second video row stacked over it. */
async function loadStacked(page: Page) {
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    gappedTimelineSpec(),
  )
  await page.evaluate((upper) => {
    const store = window.__timelineStore.getState()
    store.addTrack({ id: 'video-2', kind: 'video' })
    store.addSegment({
      trackId: 'video-2',
      segment: {
        id: 'upper-1',
        timelineStartMicros: upper.timelineStartMicros,
        content: {
          kind: 'video',
          sourceId: upper.sourceId,
          sourceInMicros: upper.sourceInMicros,
          sourceOutMicros: upper.sourceOutMicros,
        },
      },
    })
    window.harness.setProject(window.__timelineStore.getState().project)
  }, UPPER)
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

/**
 * Where source B's picture lands inside the 4:3 composition once letterboxed.
 * B is 16:9, so it fills the width and leaves a bar above and below.
 */
const B_FIT = (() => {
  const scale = Math.min(
    FIXTURE.width / FIXTURE_B.width,
    FIXTURE.height / FIXTURE_B.height,
  )
  const width = Math.round(FIXTURE_B.width * scale)
  const height = Math.round(FIXTURE_B.height * scale)

  return {
    x: Math.round((FIXTURE.width - width) / 2),
    y: Math.round((FIXTURE.height - height) / 2),
    width,
    height,
  }
})()

/** The bar above the letterboxed picture, where a lower row can show through. */
const TOP_MARGIN = { x: 0, y: 0, width: FIXTURE.width, height: B_FIT.y }

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

test('an upper row hides the row beneath it where its picture covers', async ({
  page,
}) => {
  await loadStacked(page)
  const stacked = await pixelsAt(page, OVER_LOWER_A)
  const stackedOverB = await pixelsAt(page, OVER_LOWER_B)

  // What the upper segment renders as when it is the only thing there.
  await page.evaluate((spec) => window.harness.loadProject(spec), UPPER_ALONE)
  const alone = await pixelsAt(page, OVER_LOWER_A)
  const aloneOverB = await pixelsAt(page, OVER_LOWER_B)

  // Only inside the upper picture itself: the letterbox bars are not part of
  // it, and what shows there is the next test.
  expectSame(
    'over lower clip A',
    cropTo(stacked, B_FIT),
    cropTo(alone, B_FIT),
  )
  expectSame(
    'over lower clip B',
    cropTo(stackedOverB, B_FIT),
    cropTo(aloneOverB, B_FIT),
  )
})

test('the row beneath shows through the letterbox bars of the row above', async ({
  page,
}) => {
  // Alone, a 16:9 segment in a 4:3 composition has black bars.
  await page.evaluate((spec) => window.harness.loadProject(spec), UPPER_ALONE)
  const alone = await pixelsAt(page, OVER_LOWER_A)
  expect(peakBrightness(cropTo(alone, TOP_MARGIN))).toBe(0)

  // Stacked over a row that does fill the frame, the bars are not black any
  // more: this is the whole point of compositing rather than picking one row.
  await loadStacked(page)
  const stacked = await pixelsAt(page, OVER_LOWER_A)
  expect(peakBrightness(cropTo(stacked, TOP_MARGIN))).toBeGreaterThan(0)

  // And what shows there is the lower row, unchanged.
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    gappedTimelineSpec(),
  )
  const lowerOnly = await pixelsAt(page, OVER_LOWER_A)
  expectSame(
    'in the letterbox bar',
    cropTo(stacked, TOP_MARGIN),
    cropTo(lowerOnly, TOP_MARGIN),
  )
})

test('the picture really changes, so the comparison is not vacuous', async ({
  page,
}) => {
  // Without the upper row, the same moment shows the lower row instead.
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    gappedTimelineSpec(),
  )
  const lowerOnly = await pixelsAt(page, OVER_LOWER_A)

  await loadStacked(page)
  const stacked = await pixelsAt(page, OVER_LOWER_A)

  expect(meanChannelDifference(lowerOnly, stacked)).toBeGreaterThan(3)
})

test('an upper row fills a gap in the row beneath it', async ({ page }) => {
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    gappedTimelineSpec(),
  )
  const gap = await pixelsAt(page, IN_LOWER_GAP)
  // With one row the gap is black, which is what makes the next check mean
  // something.
  expect(peakBrightness(gap)).toBe(0)

  await loadStacked(page)
  const filled = await pixelsAt(page, IN_LOWER_GAP)
  expect(peakBrightness(filled)).toBeGreaterThan(0)

  await page.evaluate((spec) => window.harness.loadProject(spec), UPPER_ALONE)
  expectSame('in the gap', filled, await pixelsAt(page, IN_LOWER_GAP))
})

test('the lower row shows through again past the end of the upper one', async ({
  page,
}) => {
  await loadStacked(page)
  const stacked = await pixelsAt(page, BELOW_ONLY)

  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    gappedTimelineSpec(),
  )
  expectSame('past the upper row', stacked, await pixelsAt(page, BELOW_ONLY))
})

test('the export matches the preview where rows are stacked', async ({
  page,
}) => {
  await loadStacked(page)

  const preview = {
    overA: await pixelsAt(page, OVER_LOWER_A),
    gap: await pixelsAt(page, IN_LOWER_GAP),
    belowOnly: await pixelsAt(page, BELOW_ONLY),
  }

  const exported = await page.evaluate(() => window.harness.exportMp4())
  expect(exported.byteLength).toBeGreaterThan(0)
  await page.evaluate(() => window.harness.loadExported())

  expectSame('over lower clip A', preview.overA, await pixelsAt(page, OVER_LOWER_A))
  expectSame('in the gap', preview.gap, await pixelsAt(page, IN_LOWER_GAP))
  expectSame(
    'past the upper row',
    preview.belowOnly,
    await pixelsAt(page, BELOW_ONLY),
  )
})

test('stacked rows leak no frames over a full play-through', async ({
  page,
}) => {
  await loadStacked(page)
  await page.evaluate(() => window.harness.playThrough())

  const counts = await page.evaluate(() => window.harness.frameCounts())
  console.log(
    `stacked play-through: created ${counts.worker.created}, closed` +
      ` ${counts.worker.closed} in the worker and ${counts.main.closed} on main`,
  )

  expect(counts.worker.created).toBeGreaterThan(0)
  expect(counts.worker.closed + counts.main.closed).toBe(counts.worker.created)
  expect(counts.main.created).toBe(0)
})
