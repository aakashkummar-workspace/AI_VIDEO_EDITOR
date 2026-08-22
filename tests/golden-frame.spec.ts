import { expect, test, type Page } from '@playwright/test'
import {
  FIXTURE,
  FIXTURE_B,
  GAPPED_TIMELINE_DURATION,
  gappedTimelineSpec,
  wholeSourceSpec,
} from './fixture.config.mjs'

const SECOND = 1_000_000

const TIMELINE = gappedTimelineSpec()
const TIMELINE_DURATION = GAPPED_TIMELINE_DURATION

/** Inside clip A: timeline 1s maps to 1s in the 30fps, 4:3 source. */
const INSIDE_A = 1 * SECOND
/** Inside the gap: nothing is on the timeline here. */
const IN_GAP = 2_500_000
/** Inside clip B: timeline 4s maps to 3s in the 24fps, 16:9 source. */
const INSIDE_B = 4 * SECOND
const INSIDE_B_SOURCE = 3 * SECOND

const WHOLE_SOURCE_A = wholeSourceSpec('a')
const WHOLE_SOURCE_B = wholeSourceSpec('b')

/** Where source B lands inside the A-shaped composition once letterboxed. */
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

function meanChannelDifference(a: number[], b: number[]): number {
  expect(a.length).toBe(b.length)

  let total = 0
  for (let i = 0; i < a.length; i++) {
    total += Math.abs(a[i]! - b[i]!)
  }
  return total / a.length
}

function fractionAbove(a: number[], b: number[], threshold: number): number {
  let count = 0
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]! - b[i]!) > threshold) count++
  }
  return count / a.length
}

/** Brightest colour channel in the image, ignoring alpha. */
function peakBrightness(pixels: number[]): number {
  let peak = 0
  for (let i = 0; i < pixels.length; i += 4) {
    peak = Math.max(peak, pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)
  }
  return peak
}

/** Cuts a rectangle out of a composition-sized image. */
function cropTo(
  pixels: number[],
  compositionWidth: number,
  rect: { x: number; y: number; width: number; height: number },
): number[] {
  const out: number[] = []
  for (let row = 0; row < rect.height; row++) {
    const start = ((rect.y + row) * compositionWidth + rect.x) * 4
    for (let i = 0; i < rect.width * 4; i++) out.push(pixels[start + i]!)
  }
  return out
}

/**
 * Rescales an image in the browser, so a reference decoded at the source's own
 * size can be compared against the letterboxed version on the timeline.
 */
async function scaleTo(
  page: Page,
  pixels: number[],
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Promise<number[]> {
  return page.evaluate(
    (args) => {
      const source = new OffscreenCanvas(args.sourceWidth, args.sourceHeight)
      const sourceContext = source.getContext('2d')!
      sourceContext.putImageData(
        new ImageData(
          new Uint8ClampedArray(args.pixels),
          args.sourceWidth,
          args.sourceHeight,
        ),
        0,
        0,
      )

      const target = new OffscreenCanvas(args.width, args.height)
      const targetContext = target.getContext('2d')!
      targetContext.drawImage(source, 0, 0, args.width, args.height)

      return Array.from(
        targetContext.getImageData(0, 0, args.width, args.height).data,
      )
    },
    { pixels, sourceWidth, sourceHeight, width, height },
  )
}

function expectMatch(label: string, preview: number[], exported: number[]) {
  const mean = meanChannelDifference(preview, exported)
  const bad = fractionAbove(preview, exported, 40)

  console.log(
    `${label}: mean channel diff ${mean.toFixed(3)},` +
      ` ${(bad * 100).toFixed(3)}% of samples off by >40`,
  )

  expect.soft(mean, `${label} mean difference`).toBeLessThan(3)
  expect.soft(bad, `${label} outlier fraction`).toBeLessThan(0.01)
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('the preview renders the timeline, not the raw source', async ({
  page,
}) => {
  // Absolute reference from source A, decoded at its own size.
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    WHOLE_SOURCE_A,
  )
  const sourceAAt1s = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    INSIDE_A,
  )

  // Absolute reference from source B, decoded at its own size.
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    WHOLE_SOURCE_B,
  )
  const sourceBAt3s = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    INSIDE_B_SOURCE,
  )

  // The two sources must look nothing alike, or none of this proves much.
  const bAtASize = await scaleTo(
    page,
    sourceBAt3s,
    FIXTURE_B.width,
    FIXTURE_B.height,
    FIXTURE.width,
    FIXTURE.height,
  )
  expect(meanChannelDifference(sourceAAt1s, bAtASize)).toBeGreaterThan(3)

  const info = await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    TIMELINE,
  )
  expect(info).toMatchObject({ width: FIXTURE.width, height: FIXTURE.height })

  // Clip A: the same shape as the composition, so it fills it.
  const previewA = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    INSIDE_A,
  )
  expectMatch('clip A (fills the composition)', sourceAAt1s, previewA)

  // Clip B: a different source, shape, frame rate and source offset. It has to
  // appear letterboxed and undistorted, showing the right frame.
  const previewB = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    INSIDE_B,
  )
  const expectedB = await scaleTo(
    page,
    sourceBAt3s,
    FIXTURE_B.width,
    FIXTURE_B.height,
    B_FIT.width,
    B_FIT.height,
  )
  expectMatch(
    'clip B (letterboxed, offset, 24fps source)',
    expectedB,
    cropTo(previewB, FIXTURE.width, B_FIT),
  )

  // The bars above and below source B are black, not stretched picture.
  const topBar = cropTo(previewB, FIXTURE.width, {
    x: 0,
    y: 0,
    width: FIXTURE.width,
    height: B_FIT.y,
  })
  expect
    .soft(peakBrightness(topBar), 'the letterbox bar should be black')
    .toBeLessThan(8)

  // The gap has nothing on it and must render black.
  const previewGap = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    IN_GAP,
  )
  expect
    .soft(peakBrightness(previewGap), 'the gap should be black')
    .toBeLessThan(8)
})

test('the export matches the preview across clips and the gap', async ({
  page,
}) => {
  await page.evaluate((spec) => window.harness.loadProject(spec), TIMELINE)

  const preview = {
    a: await page.evaluate((t) => window.harness.pixelsAt(t), INSIDE_A),
    gap: await page.evaluate((t) => window.harness.pixelsAt(t), IN_GAP),
    b: await page.evaluate((t) => window.harness.pixelsAt(t), INSIDE_B),
  }

  const exported = await page.evaluate(() => window.harness.exportMp4())
  expect(exported.byteLength).toBeGreaterThan(0)

  await page.evaluate(() => window.harness.loadExported())

  expectMatch(
    'clip A',
    preview.a,
    await page.evaluate((t) => window.harness.pixelsAt(t), INSIDE_A),
  )
  expectMatch(
    'gap',
    preview.gap,
    await page.evaluate((t) => window.harness.pixelsAt(t), IN_GAP),
  )
  expectMatch(
    'clip B',
    preview.b,
    await page.evaluate((t) => window.harness.pixelsAt(t), INSIDE_B),
  )
})

test('the exported file is as long as the timeline, not the source', async ({
  page,
}) => {
  await page.evaluate((spec) => window.harness.loadProject(spec), TIMELINE)
  await page.evaluate(() => window.harness.exportMp4())
  await page.evaluate(() => window.harness.loadExported())

  const duration = await page.evaluate(() => window.harness.duration())

  // Five seconds of timeline, including the one second gap.
  expect(duration).toBeGreaterThan(TIMELINE_DURATION - 100_000)
  expect(duration).toBeLessThan(TIMELINE_DURATION + 100_000)
})

test('a different frame does not match, so the comparison is real', async ({
  page,
}) => {
  // Clip B comes from the 24fps source, so step by one of ITS frames.
  const frameMicros = SECOND / FIXTURE_B.fps

  await page.evaluate((spec) => window.harness.loadProject(spec), TIMELINE)

  const golden = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    INSIDE_B,
  )
  const neighbour = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    INSIDE_B + Math.round(1.5 * frameMicros),
  )

  expect(meanChannelDifference(golden, neighbour)).toBeGreaterThan(3)
})
