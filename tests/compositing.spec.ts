import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_B } from './fixture.config.mjs'

/**
 * Blend modes and masks, through the one render function.
 *
 * Both are things the canvas already knows how to do, so the tests are about
 * whether the RIGHT thing is asked of it: that a blend really reads the row
 * underneath, that a mask cuts only its own segment and not the composition,
 * and that the export agrees with the preview about both.
 */

const SECOND = 1_000_000

/** Two clips stacked, from different sources so they cannot be confused. */
const STACKED_SPEC = {
  composition: { width: FIXTURE.width, height: FIXTURE.height },
  sources: [
    { id: 'src-a', url: `/${FIXTURE.path}` },
    { id: 'src-b', url: `/${FIXTURE_B.path}` },
  ],
  clips: [
    {
      sourceId: 'src-a',
      sourceInMicros: 0,
      sourceOutMicros: 4 * SECOND,
      timelineStartMicros: 0,
    },
  ],
}

function meanChannelDifference(a: number[], b: number[]): number {
  expect(a.length).toBe(b.length)
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!)
  return total / a.length
}

function meanBrightness(pixels: number[]): number {
  let total = 0
  for (let i = 0; i < pixels.length; i += 4) {
    total += pixels[i]! + pixels[i + 1]! + pixels[i + 2]!
  }
  return total / ((pixels.length / 4) * 3)
}

function pixelsAt(page: Page, micros: number) {
  return page.evaluate((t) => window.harness.pixelsAt(t), micros)
}

/** The pixel at a point in the composition. */
function pixelAt(pixels: number[], x: number, y: number): number[] {
  const i = (y * FIXTURE.width + x) * 4
  return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!]
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

/** Loads clip A on the main row with clip B stacked over it. */
async function loadStacked(page: Page) {
  await page.evaluate((spec) => window.harness.loadProject(spec), STACKED_SPEC)
  await edit(
    page,
    `(store) => {
      store.addTrack({ id: 'video-2', kind: 'video' })
      store.addSegment({
        trackId: 'video-2',
        segment: {
          id: 'over',
          timelineStartMicros: 0,
          content: {
            kind: 'video',
            sourceId: 'src-b',
            sourceInMicros: 0,
            sourceOutMicros: 4000000,
          },
        },
      })
    }`,
  )
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('normal blending is exactly what it was', async ({ page }) => {
  await loadStacked(page)
  const before = await pixelsAt(page, 1 * SECOND)

  await edit(
    page,
    `(store) => store.setSegmentBlendMode({ segmentId: 'over', blendMode: 'normal' })`,
  )

  expect(meanChannelDifference(before, await pixelsAt(page, 1 * SECOND))).toBe(
    0,
  )
})

test('multiply darkens, because it reads the row underneath', async ({
  page,
}) => {
  await loadStacked(page)
  const plain = await pixelsAt(page, 1 * SECOND)

  await edit(
    page,
    `(store) => store.setSegmentBlendMode({ segmentId: 'over', blendMode: 'multiply' })`,
  )
  const multiplied = await pixelsAt(page, 1 * SECOND)

  console.log(
    `brightness: normal ${meanBrightness(plain).toFixed(1)},` +
      ` multiply ${meanBrightness(multiplied).toFixed(1)}`,
  )

  // Multiplying two pictures can only darken.
  expect(meanBrightness(multiplied)).toBeLessThan(meanBrightness(plain))
  expect(meanChannelDifference(plain, multiplied)).toBeGreaterThan(5)
})

test('screen lightens, for the same reason', async ({ page }) => {
  await loadStacked(page)
  const plain = await pixelsAt(page, 1 * SECOND)

  await edit(
    page,
    `(store) => store.setSegmentBlendMode({ segmentId: 'over', blendMode: 'screen' })`,
  )
  const screened = await pixelsAt(page, 1 * SECOND)

  expect(meanBrightness(screened)).toBeGreaterThan(meanBrightness(plain))
})

test('a blend really uses the lower row, not black', async ({ page }) => {
  await loadStacked(page)
  await edit(
    page,
    `(store) => store.setSegmentBlendMode({ segmentId: 'over', blendMode: 'multiply' })`,
  )
  const overClip = await pixelsAt(page, 1 * SECOND)

  // Take the lower row away. Multiplying against the cleared black
  // composition gives black, so if the result is unchanged the lower row was
  // never being read in the first place.
  await edit(page, `(store) => store.removeSegment('clip-0')`)
  const overNothing = await pixelsAt(page, 1 * SECOND)

  console.log(
    `multiply over a clip ${meanBrightness(overClip).toFixed(1)},` +
      ` over nothing ${meanBrightness(overNothing).toFixed(1)}`,
  )

  expect(meanBrightness(overNothing)).toBe(0)
  expect(meanBrightness(overClip)).toBeGreaterThan(0)
})

test('a mask cuts its own segment and leaves the row below alone', async ({
  page,
}) => {
  await loadStacked(page)

  // Only the lower row, for reference.
  await edit(page, `(store) => store.removeSegment('over')`)
  const lowerOnly = await pixelsAt(page, 1 * SECOND)

  await loadStacked(page)
  await edit(
    page,
    `(store) => store.setSegmentMask({
      segmentId: 'over',
      shape: 'rectangle',
      x: ${Math.round(FIXTURE.width / 4)},
      y: ${Math.round(FIXTURE.height / 2)},
      width: ${Math.round(FIXTURE.width / 2)},
      height: ${FIXTURE.height},
    })`,
  )
  const masked = await pixelsAt(page, 1 * SECOND)

  // Outside the mask the upper clip is gone, so what shows is the lower row -
  // NOT a hole in the composition.
  const outsideX = Math.round(FIXTURE.width * 0.85)
  const y = Math.round(FIXTURE.height / 2)
  expect(pixelAt(masked, outsideX, y)).toEqual(pixelAt(lowerOnly, outsideX, y))
  expect(pixelAt(masked, outsideX, y)[3]).toBe(255)

  // Inside it, the upper clip is still there and differs from the lower row.
  const insideX = Math.round(FIXTURE.width * 0.15)
  expect(
    Math.abs(
      pixelAt(masked, insideX, y)[0]! - pixelAt(lowerOnly, insideX, y)[0]!,
    ) +
      Math.abs(
        pixelAt(masked, insideX, y)[1]! - pixelAt(lowerOnly, insideX, y)[1]!,
      ),
  ).toBeGreaterThan(10)
})

test('inverting a mask keeps the other half', async ({ page }) => {
  const maskEdit = (inverted: boolean) => `(store) => store.setSegmentMask({
    segmentId: 'over',
    shape: 'rectangle',
    x: ${Math.round(FIXTURE.width / 4)},
    y: ${Math.round(FIXTURE.height / 2)},
    width: ${Math.round(FIXTURE.width / 2)},
    height: ${FIXTURE.height},
    inverted: ${inverted},
  })`

  await loadStacked(page)
  await edit(page, maskEdit(false))
  const normal = await pixelsAt(page, 1 * SECOND)

  await edit(page, maskEdit(true))
  const inverted = await pixelsAt(page, 1 * SECOND)

  const y = Math.round(FIXTURE.height / 2)
  const left = Math.round(FIXTURE.width * 0.15)
  const right = Math.round(FIXTURE.width * 0.85)

  // What was kept on the left is now kept on the right, and the reverse.
  expect(pixelAt(inverted, right, y)).toEqual(pixelAt(normal, left, y))
  expect(pixelAt(inverted, left, y)).toEqual(pixelAt(normal, right, y))
})

test('a feather softens the edge instead of stepping at it', async ({
  page,
}) => {
  const maskEdit = (featherPx: number) => `(store) => store.setSegmentMask({
    segmentId: 'over',
    shape: 'rectangle',
    x: ${Math.round(FIXTURE.width / 4)},
    y: ${Math.round(FIXTURE.height / 2)},
    width: ${Math.round(FIXTURE.width / 2)},
    height: ${FIXTURE.height},
    featherPx: ${featherPx},
  })`

  await loadStacked(page)
  await edit(page, maskEdit(0))
  const hard = await pixelsAt(page, 1 * SECOND)

  await edit(page, maskEdit(24))
  const soft = await pixelsAt(page, 1 * SECOND)

  // Sample a run of pixels across the mask edge and count how many steps
  // between neighbours are large. A hard edge has one big jump; a soft one
  // spreads the same change over many small ones.
  const y = Math.round(FIXTURE.height / 2)
  const edgeX = Math.round(FIXTURE.width / 2)

  function biggestStep(pixels: number[]): number {
    let biggest = 0
    for (let x = edgeX - 30; x < edgeX + 30; x++) {
      const a = pixelAt(pixels, x, y)
      const b = pixelAt(pixels, x + 1, y)
      const step =
        Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!)
      biggest = Math.max(biggest, step)
    }
    return biggest
  }

  console.log(
    `biggest step across the edge: hard ${biggestStep(hard)},` +
      ` feathered ${biggestStep(soft)}`,
  )
  expect(biggestStep(soft)).toBeLessThan(biggestStep(hard))
})

test('the export matches the preview with a blend and a mask', async ({
  page,
}) => {
  await loadStacked(page)
  await edit(
    page,
    `(store) => {
      store.setSegmentBlendMode({ segmentId: 'over', blendMode: 'screen' })
      store.setSegmentMask({ segmentId: 'over', shape: 'ellipse', featherPx: 16 })
    }`,
  )

  const preview = await pixelsAt(page, 1 * SECOND)

  const exported = await page.evaluate(() => window.harness.exportMp4())
  expect(exported.byteLength).toBeGreaterThan(0)
  await page.evaluate(() => window.harness.loadExported())

  const diff = meanChannelDifference(preview, await pixelsAt(page, 1 * SECOND))
  console.log(`export vs preview: mean channel diff ${diff.toFixed(3)}`)
  expect(diff).toBeLessThan(3)
})

test('compositing leaks no frames over a full play-through', async ({
  page,
}) => {
  await loadStacked(page)
  await edit(
    page,
    `(store) => {
      store.setSegmentBlendMode({ segmentId: 'over', blendMode: 'overlay' })
      store.setSegmentMask({ segmentId: 'over', shape: 'ellipse' })
    }`,
  )
  await page.evaluate(() => window.harness.playThrough())

  const counts = await page.evaluate(() => window.harness.frameCounts())
  expect(counts.worker.created).toBeGreaterThan(0)
  expect(counts.worker.closed + counts.main.closed).toBe(counts.worker.created)
})

test.describe('the compositing panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
    await expect(page.getByTestId('clip')).toBeVisible()
    await page.getByTestId('clip').click()
  })

  test('offers a blend mode and stores what is chosen', async ({ page }) => {
    await expect(page.getByTestId('compositing-panel')).toBeVisible()
    await page.getByTestId('blend-mode').selectOption('multiply')

    expect(
      await page.evaluate(
        () =>
          window.__timelineStore
            .getState()
            .project.tracks.flatMap((t) => t.segments)[0]!.blendMode,
      ),
    ).toBe('multiply')
  })

  test('reveals the mask fields once a shape is chosen', async ({ page }) => {
    await expect(page.getByTestId('mask-width')).toHaveCount(0)

    await page.getByTestId('mask-shape').selectOption('ellipse')
    await expect(page.getByTestId('mask-width')).toBeVisible()
    await expect(page.getByTestId('mask-feather' + 'Px')).toBeVisible()

    await page.getByTestId('mask-shape').selectOption('none')
    await expect(page.getByTestId('mask-width')).toHaveCount(0)
  })

  test('is not offered on a segment nobody looks at', async ({ page }) => {
    await page.setInputFiles(
      '[data-testid=media-input]',
      'tests/fixtures/music-only.mp4',
    )
    await expect(page.getByTestId('audio-block')).toHaveCount(1)
    await page.getByTestId('audio-block').click()

    await expect(page.getByTestId('compositing-panel')).toHaveCount(0)
  })

  test('is undoable like any other edit', async ({ page }) => {
    const before = await page.evaluate(
      () => window.__timelineStore.getState().project,
    )

    await page.getByTestId('blend-mode').selectOption('difference')
    await page.keyboard.press('Control+z')

    expect(
      await page.evaluate(() => window.__timelineStore.getState().project),
    ).toEqual(before)
  })
})
