import { expect, test } from '@playwright/test'
import { FIXTURE, goldenFrameMicros } from './fixture.config.mjs'

/**
 * Mean absolute difference per RGBA channel, 0-255. Both images are rendered by
 * the same drawFrame(), so anything above codec noise means the export pipeline
 * diverged from the preview.
 */
function meanChannelDifference(a: number[], b: number[]): number {
  expect(a.length).toBe(b.length)

  let total = 0
  for (let i = 0; i < a.length; i++) {
    total += Math.abs(a[i]! - b[i]!)
  }
  return total / a.length
}

/** Fraction of channel samples that differ by more than `threshold`. */
function fractionAbove(a: number[], b: number[], threshold: number): number {
  let count = 0
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]! - b[i]!) > threshold) count++
  }
  return count / a.length
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('export frame matches preview frame', async ({ page }) => {
  const micros = goldenFrameMicros()

  const info = await page.evaluate(
    (url) => window.harness.load(url),
    `/${FIXTURE.path}`,
  )
  expect(info).toEqual({
    width: FIXTURE.width,
    height: FIXTURE.height,
    durationMicros: Math.round((FIXTURE.frames / FIXTURE.fps) * 1_000_000),
  })

  // 1. The golden frame through the preview path.
  const preview = await page.evaluate((t) => window.harness.pixelsAt(t), micros)
  expect(preview.length).toBe(FIXTURE.width * FIXTURE.height * 4)

  // 2. The same frame through the export path, read back out of the MP4 the
  //    export produced.
  const exported = await page.evaluate(() => window.harness.exportMp4())
  expect(exported.byteLength).toBeGreaterThan(0)

  await page.evaluate(() => window.harness.loadExported())
  const exportPixels = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    micros,
  )

  // 3. They must match within codec noise.
  const mean = meanChannelDifference(preview, exportPixels)
  const badFraction = fractionAbove(preview, exportPixels, 40)

  console.log(
    `golden frame ${FIXTURE.goldenFrame}: mean channel diff ${mean.toFixed(3)},` +
      ` ${(badFraction * 100).toFixed(3)}% of samples off by >40`,
  )

  expect(mean).toBeLessThan(3)
  expect(badFraction).toBeLessThan(0.01)
})

test('a different frame does not match, so the comparison is real', async ({
  page,
}) => {
  // Guards the test itself: if every frame looked alike, the golden comparison
  // above would pass even when the export path grabbed the wrong frame.
  const frameMicros = 1_000_000 / FIXTURE.fps

  await page.evaluate((url) => window.harness.load(url), `/${FIXTURE.path}`)

  const golden = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    goldenFrameMicros(),
  )
  const neighbour = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    goldenFrameMicros() + Math.round(frameMicros),
  )

  expect(meanChannelDifference(golden, neighbour)).toBeGreaterThan(3)
})
