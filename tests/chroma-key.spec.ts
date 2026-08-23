import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_GREEN } from './fixture.config.mjs'

/**
 * Keying a colour out, end to end.
 *
 * The green fixture is a flat keying green with a red block moving across it,
 * stacked over the counter clip. Keyed, the green should be gone and the
 * counter clip should be visible through it, while the red block stays.
 */

const SECOND = 1_000_000
const AT = 1 * SECOND

const STACKED_SPEC = {
  composition: { width: FIXTURE.width, height: FIXTURE.height },
  sources: [
    { id: 'src-under', url: `/${FIXTURE.path}` },
    { id: 'src-green', url: `/${FIXTURE_GREEN.path}` },
  ],
  clips: [
    {
      sourceId: 'src-under',
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 0,
    },
  ],
}

function pixelsAt(page: Page, micros: number) {
  return page.evaluate((t) => window.harness.pixelsAt(t), micros)
}

function pixelAt(pixels: number[], x: number, y: number): number[] {
  const i = (y * FIXTURE.width + x) * 4
  return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!]
}

/** How many pixels look like the keying green. */
function greenPixels(pixels: number[]): number {
  let count = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]
    if (g > 90 && g > r * 1.6 && g > b * 1.6) count++
  }
  return count
}

/** How many pixels look like the red block. */
function redPixels(pixels: number[]): number {
  let count = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]
    if (r > 120 && r > g * 1.8 && r > b * 1.8) count++
  }
  return count
}

function meanChannelDifference(a: number[], b: number[]): number {
  expect(a.length).toBe(b.length)
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!)
  return total / a.length
}

async function edit(page: Page, source: string) {
  await page.evaluate((code) => {
    const run = new Function('store', `(${code})(store)`) as (
      store: unknown,
    ) => void
    run(window.__timelineStore.getState())
    window.harness.setProject(window.__timelineStore.getState().project)
  }, source)
}

/** The green clip stacked over the counter clip. */
async function loadStacked(page: Page) {
  await page.evaluate((spec) => window.harness.loadProject(spec), STACKED_SPEC)
  await edit(
    page,
    `(store) => {
      store.addTrack({ id: 'video-2', kind: 'video' })
      store.addSegment({
        trackId: 'video-2',
        segment: {
          id: 'green',
          timelineStartMicros: 0,
          content: {
            kind: 'video',
            sourceId: 'src-green',
            sourceInMicros: 0,
            sourceOutMicros: 2000000,
          },
        },
      })
    }`,
  )
}

async function key(page: Page, settings = '{}') {
  await edit(
    page,
    `(store) => store.setChromaKey({ segmentId: 'green', ...${settings} })`,
  )
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('the green screen covers everything until it is keyed', async ({
  page,
}) => {
  await loadStacked(page)
  const pixels = await pixelsAt(page, AT)

  console.log(`unkeyed: ${greenPixels(pixels)} green, ${redPixels(pixels)} red`)
  expect(greenPixels(pixels)).toBeGreaterThan(40_000)
  expect(redPixels(pixels)).toBeGreaterThan(500)
})

test('keying removes the green and keeps the block', async ({ page }) => {
  await loadStacked(page)
  const before = await pixelsAt(page, AT)

  await key(page)
  const after = await pixelsAt(page, AT)

  console.log(
    `keyed: ${greenPixels(after)} green (was ${greenPixels(before)}),` +
      ` ${redPixels(after)} red (was ${redPixels(before)})`,
  )

  // Almost nothing of the screen survives...
  expect(greenPixels(after)).toBeLessThan(greenPixels(before) / 100)
  // ...and the block that was in front of it does.
  expect(redPixels(after)).toBeGreaterThan(redPixels(before) * 0.7)
})

test('what shows through is the row underneath, not a hole', async ({
  page,
}) => {
  // The lower clip on its own, for reference.
  await page.evaluate((spec) => window.harness.loadProject(spec), STACKED_SPEC)
  const lowerOnly = await pixelsAt(page, AT)

  await loadStacked(page)
  await key(page)
  const keyed = await pixelsAt(page, AT)

  // A corner, which the red block never reaches.
  const corner = pixelAt(keyed, 6, 6)
  expect(corner).toEqual(pixelAt(lowerOnly, 6, 6))
  expect(corner[3]).toBe(255)
})

test('a tolerance of nothing keys nothing', async ({ page }) => {
  await loadStacked(page)
  const unkeyed = await pixelsAt(page, AT)

  await key(page, '{ similarity: 0, smoothness: 0 }')
  const keyed = await pixelsAt(page, AT)

  // Everything is further from the key colour than zero, so all of it stays.
  expect(greenPixels(keyed)).toBeGreaterThan(greenPixels(unkeyed) * 0.9)
})

test('a wider tolerance reaches colours a narrow one does not', async ({
  page,
}) => {
  await loadStacked(page)

  // Keyed against a green the screen ISN'T. The fixture is perfectly flat, so
  // its own colour goes at any tolerance at all and says nothing about what
  // tolerance means; a near miss is what tolerance is actually for.
  const nearby = `color: '#00e060'`

  await key(page, `{ ${nearby}, similarity: 0.02, smoothness: 0.01 }`)
  const narrow = greenPixels(await pixelsAt(page, AT))

  await key(page, `{ ${nearby}, similarity: 0.35, smoothness: 0.05 }`)
  const wide = greenPixels(await pixelsAt(page, AT))

  console.log(`green left: narrow ${narrow}, wide ${wide}`)
  expect(narrow).toBeGreaterThan(40_000)
  expect(wide).toBeLessThan(narrow / 100)
})

test('keying a colour that is not there changes nothing', async ({ page }) => {
  await loadStacked(page)
  const before = await pixelsAt(page, AT)

  // Magenta appears nowhere in either fixture.
  await key(page, `{ color: '#ff00ff', similarity: 0.1, smoothness: 0.01 }`)
  const after = await pixelsAt(page, AT)

  expect(meanChannelDifference(before, after)).toBeLessThan(2)
})

test('the export carries the key', async ({ page }) => {
  await loadStacked(page)
  await key(page)
  const preview = await pixelsAt(page, AT)

  const exported = await page.evaluate(() => window.harness.exportMp4())
  expect(exported.byteLength).toBeGreaterThan(0)
  await page.evaluate(() => window.harness.loadExported())
  const after = await pixelsAt(page, AT)

  const diff = meanChannelDifference(preview, after)
  console.log(`export vs preview: mean channel diff ${diff.toFixed(3)}`)

  expect(diff).toBeLessThan(4)
  // And the file really is keyed, rather than the shader having been skipped.
  expect(greenPixels(after)).toBeLessThan(2000)
})

test('a key composes with a transform and a mask', async ({ page }) => {
  await loadStacked(page)
  await key(page)
  await edit(
    page,
    `(store) => {
      store.setSegmentProperties({ segmentId: 'green', scale: 0.5 })
      store.setSegmentMask({ segmentId: 'green', shape: 'ellipse' })
    }`,
  )

  const pixels = await pixelsAt(page, AT)
  // Still keyed, still drawable, and the lower row still shows.
  expect(greenPixels(pixels)).toBeLessThan(2000)
  expect(pixelAt(pixels, 6, 6)[3]).toBe(255)
})

test('keying leaks no frames over a full play-through', async ({ page }) => {
  await loadStacked(page)
  await key(page)
  await page.evaluate(() => window.harness.playThrough())

  const counts = await page.evaluate(() => window.harness.frameCounts())
  expect(counts.worker.created).toBeGreaterThan(0)
  expect(counts.worker.closed + counts.main.closed).toBe(counts.worker.created)
})

test.describe('the chroma key panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.setInputFiles('[data-testid=media-input]', FIXTURE_GREEN.path)
    await expect(page.getByTestId('clip')).toBeVisible()
    await page.getByTestId('clip').click()
  })

  test('is off until it is turned on, and reveals its settings', async ({
    page,
  }) => {
    await expect(page.getByTestId('chroma-toggle')).toHaveValue('off')
    await expect(page.getByTestId('chroma-similarity')).toHaveCount(0)

    await page.getByTestId('chroma-toggle').selectOption('on')
    await expect(page.getByTestId('chroma-similarity')).toBeVisible()
    await expect(page.getByTestId('chroma-color')).toHaveValue('#00b140')

    await page.getByTestId('chroma-toggle').selectOption('off')
    await expect(page.getByTestId('chroma-similarity')).toHaveCount(0)
  })

  test('stores what is set, and is undoable', async ({ page }) => {
    const before = await page.evaluate(
      () => window.__timelineStore.getState().project,
    )

    await page.getByTestId('chroma-toggle').selectOption('on')
    await page.getByTestId('chroma-similarity').fill('0.6')

    expect(
      await page.evaluate(
        () =>
          window.__timelineStore
            .getState()
            .project.tracks.flatMap((t) => t.segments)[0]!.chromaKey,
      ),
    ).toMatchObject({ similarity: 0.6, color: '#00b140' })

    // Out of the field first: Ctrl+Z inside an input is the browser's own
    // undo, and the app deliberately stands down while a field has focus.
    await page.locator('.wordmark').click()
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')

    expect(
      await page.evaluate(() => window.__timelineStore.getState().project),
    ).toEqual(before)
  })

  test('is not offered on a caption, which has no picture to key', async ({
    page,
  }) => {
    await page.getByTestId('add-overlay').click()
    await page.getByTestId('overlay-block').click()

    await expect(page.getByTestId('compositing-panel')).toBeVisible()
    await expect(page.getByTestId('chroma-toggle')).toHaveCount(0)
  })
})
