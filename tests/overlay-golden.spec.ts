import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, gappedTimelineSpec } from './fixture.config.mjs'

const SECOND = 1_000_000

/**
 * An overlay that spans a clip boundary AND the gap:
 *
 *   timeline  0s ─── 2s        3s ─── 5s
 *   clip      [ A ]      gap   [ B ]
 *   overlay        [ 1.5s ─────── 3.5s ]
 *
 * So the same overlay has to survive the cut at 2s, the empty stretch, and the
 * change of source at 3s, identically in the preview and in the export.
 */
const OVERLAY = {
  id: 'overlay-1',
  timelineStartMicros: 1_500_000,
  content: {
    kind: 'text' as const,
    content: 'CAPTION',
    x: 20,
    y: 100,
    sizePx: 40,
    // Pure magenta appears nowhere in either fixture, so counting pixels near
    // it answers "is the overlay on screen" without comparing whole frames.
    color: '#ff00ff',
    durationMicros: 2 * SECOND,
  },
}

const FRAME_MICROS = Math.round(SECOND / FIXTURE.fps)

/**
 * Near-pure magenta only. The fixture palette is hsl(h 70% 45%), whose most
 * magenta shade is about (195,34,195) - a looser threshold counts the video
 * itself as overlay whenever the background hue passes 300 degrees.
 */
function isOverlayPixel(r: number, g: number, b: number): boolean {
  return r > 240 && b > 240 && g < 40
}

function countMagenta(pixels: number[]): number {
  let count = 0
  for (let i = 0; i < pixels.length; i += 4) {
    if (isOverlayPixel(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)) count++
  }
  return count
}

function meanChannelDifference(a: number[], b: number[]): number {
  expect(a.length).toBe(b.length)

  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!)
  return total / a.length
}

function expectMatch(label: string, preview: number[], exported: number[]) {
  const mean = meanChannelDifference(preview, exported)
  console.log(`${label}: mean channel diff ${mean.toFixed(3)}`)
  expect.soft(mean, `${label} preview vs export`).toBeLessThan(3)
}

async function loadWithOverlay(page: Page) {
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    gappedTimelineSpec(),
  )
  await page.evaluate((overlay) => {
    const store = window.__timelineStore.getState()
    const textTrack = store.project.tracks.find(
      (track) => track.kind === 'text',
    )
    if (!textTrack) throw new Error('no text track')
    store.addSegment({ trackId: textTrack.id, segment: overlay })
    window.harness.setProject(window.__timelineStore.getState().project)
  }, OVERLAY)
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('the overlay appears exactly when it starts, not a frame earlier', async ({
  page,
}) => {
  await loadWithOverlay(page)

  const before = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    OVERLAY.timelineStartMicros - FRAME_MICROS,
  )
  const after = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    OVERLAY.timelineStartMicros + FRAME_MICROS,
  )

  const beforeCount = countMagenta(before)
  const afterCount = countMagenta(after)
  console.log(
    `one frame before start: ${beforeCount} overlay pixels;` +
      ` one frame after: ${afterCount}`,
  )

  expect(beforeCount).toBe(0)
  expect(afterCount).toBeGreaterThan(100)
})

test('the overlay disappears exactly when it ends', async ({ page }) => {
  await loadWithOverlay(page)

  const endMicros =
    OVERLAY.timelineStartMicros + OVERLAY.content.durationMicros
  const inside = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    endMicros - FRAME_MICROS,
  )
  const past = await page.evaluate(
    (t) => window.harness.pixelsAt(t),
    endMicros + FRAME_MICROS,
  )

  expect(countMagenta(inside)).toBeGreaterThan(100)
  expect(countMagenta(past)).toBe(0)
})

test('the overlay is identical in preview and export across the boundary and the gap', async ({
  page,
}) => {
  await loadWithOverlay(page)

  // One position inside clip A, one in the gap, one inside clip B - all three
  // under the same overlay.
  const positions = {
    'over clip A': 1_800_000,
    'over the gap': 2_500_000,
    'over clip B': 3_200_000,
  }

  const preview: Record<string, number[]> = {}
  for (const [label, micros] of Object.entries(positions)) {
    preview[label] = await page.evaluate(
      (t) => window.harness.pixelsAt(t),
      micros,
    )
    // The overlay is genuinely on screen at each of them.
    expect(countMagenta(preview[label]!), `${label} shows the overlay`)
      .toBeGreaterThan(100)
  }

  await page.evaluate(() => window.harness.exportMp4())
  await page.evaluate(() => window.harness.loadExported())

  for (const [label, micros] of Object.entries(positions)) {
    const exported = await page.evaluate(
      (t) => window.harness.pixelsAt(t),
      micros,
    )
    expectMatch(label, preview[label]!, exported)
    expect
      .soft(countMagenta(exported), `${label} exported shows the overlay`)
      .toBeGreaterThan(100)
  }
})

test('an overlay over a gap draws on black, not on a stale frame', async ({
  page,
}) => {
  await loadWithOverlay(page)

  const inGap = await page.evaluate((t) => window.harness.pixelsAt(t), 2_500_000)

  // Everything that is not the overlay is black: the gap is still a gap.
  let nonBlack = 0
  for (let i = 0; i < inGap.length; i += 4) {
    const [r, g, b] = [inGap[i]!, inGap[i + 1]!, inGap[i + 2]!]
    if (!isOverlayPixel(r, g, b) && (r > 24 || g > 24 || b > 24)) nonBlack++
  }

  const overlayPixels = countMagenta(inGap)
  console.log(
    `in the gap: ${overlayPixels} overlay pixels, ${nonBlack} other non-black`,
  )

  expect(overlayPixels).toBeGreaterThan(100)
  // Antialiasing on the glyph edges leaves a fringe; nothing more than that.
  expect(nonBlack).toBeLessThan(overlayPixels)
})
