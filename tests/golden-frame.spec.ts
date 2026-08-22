import { expect, test } from '@playwright/test'
import {
  FIXTURE,
  GAPPED_TIMELINE_DURATION,
  gappedTimelineSpec,
  wholeSourceSpec,
} from './fixture.config.mjs'

const SECOND = 1_000_000

const TIMELINE = gappedTimelineSpec()

const TIMELINE_DURATION = GAPPED_TIMELINE_DURATION

/** Inside clip A: timeline 1s maps to source 1s. */
const INSIDE_A = 1 * SECOND
/** Inside the gap: nothing is on the timeline here. */
const IN_GAP = 2_500_000
/** Inside clip B: timeline 4s maps to source 5s, i.e. the golden frame 150. */
const INSIDE_B = 4 * SECOND
const INSIDE_B_SOURCE = 5 * SECOND

const WHOLE_SOURCE = wholeSourceSpec()

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
  // Absolute references, taken straight from the source.
  await page.evaluate((spec) => window.harness.loadProject(spec), WHOLE_SOURCE)
  const sourceAt1s = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    INSIDE_A,
  )
  const sourceAt5s = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    INSIDE_B_SOURCE,
  )
  expect(meanChannelDifference(sourceAt1s, sourceAt5s)).toBeGreaterThan(3)

  const info = await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    TIMELINE,
  )
  expect(info).not.toBeNull()

  // Clip A sits at the same place in its source as on the timeline.
  const previewA = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    INSIDE_A,
  )
  expectMatch('clip A', sourceAt1s, previewA)

  // Clip B is offset by a second: timeline 4s must render source 5s.
  const previewB = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    INSIDE_B,
  )
  expectMatch('clip B (offset source range)', sourceAt5s, previewB)

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

  // Five seconds of timeline, including the one second gap - not the six
  // seconds of the underlying source.
  expect(duration).toBeGreaterThan(TIMELINE_DURATION - 100_000)
  expect(duration).toBeLessThan(TIMELINE_DURATION + 100_000)
})

test('a different frame does not match, so the comparison is real', async ({
  page,
}) => {
  const frameMicros = SECOND / FIXTURE.fps

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
