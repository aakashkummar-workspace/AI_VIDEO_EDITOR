import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

/**
 * Text styling where it counts: in the pixels, and identically in the export.
 *
 * The caption is drawn over a GAP rather than over footage in most of these,
 * so the composition is black everywhere the text is not and any change can be
 * attributed to the text rather than to the picture behind it.
 */

const SECOND = 1_000_000

/** A timeline with nothing on the video row, so the frame is black. */
const EMPTY_SPEC = {
  composition: { width: FIXTURE.width, height: FIXTURE.height },
  sources: [{ id: 'src-a', url: `/${FIXTURE.path}` }],
  clips: [
    {
      sourceId: 'src-a',
      sourceInMicros: 0,
      sourceOutMicros: 1 * SECOND,
      timelineStartMicros: 4 * SECOND,
    },
  ],
}

/** Well inside the gap before the clip. */
const OVER_BLACK = 1 * SECOND

function pixelsAt(page: Page, micros: number) {
  return page.evaluate((t) => window.harness.pixelsAt(t), micros)
}

/** How many pixels are not black at all. */
function inkedPixels(pixels: number[]): number {
  let count = 0
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i]! > 8 || pixels[i + 1]! > 8 || pixels[i + 2]! > 8) count++
  }
  return count
}

/** How many pixels are close to a colour. */
function pixelsNear(
  pixels: number[],
  [r, g, b]: [number, number, number],
  tolerance = 40,
): number {
  let count = 0
  for (let i = 0; i < pixels.length; i += 4) {
    if (
      Math.abs(pixels[i]! - r) < tolerance &&
      Math.abs(pixels[i + 1]! - g) < tolerance &&
      Math.abs(pixels[i + 2]! - b) < tolerance
    ) {
      count++
    }
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

/** A white caption over the gap, ready to be styled. */
async function loadCaption(page: Page, content = 'HELLO') {
  await page.evaluate((spec) => window.harness.loadProject(spec), EMPTY_SPEC)
  await edit(
    page,
    `(store) => {
      const textRow = store.project.tracks.find((t) => t.kind === 'text')
      store.addSegment({
        trackId: textRow.id,
        segment: {
          id: 'text-1',
          timelineStartMicros: 0,
          content: {
            kind: 'text',
            content: ${JSON.stringify(content)},
            x: 20,
            y: 80,
            sizePx: 60,
            color: '#ffffff',
            durationMicros: 3000000,
          },
        },
      })
    }`,
  )
}

async function restyle(page: Page, style: Record<string, unknown>) {
  await edit(
    page,
    `(store) => store.setTextStyle({ segmentId: 'text-1', ...${JSON.stringify(
      style,
    )} })`,
  )
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('an unstyled caption renders as it always did', async ({ page }) => {
  await loadCaption(page)
  const before = await pixelsAt(page, OVER_BLACK)

  // Setting the defaults explicitly must be a no-op.
  await restyle(page, { fontFamily: 'sans-serif', align: 'left' })

  expect(meanChannelDifference(before, await pixelsAt(page, OVER_BLACK))).toBe(
    0,
  )
})

test('bold puts more ink on the frame than regular', async ({ page }) => {
  await loadCaption(page)
  const regular = inkedPixels(await pixelsAt(page, OVER_BLACK))

  await restyle(page, { bold: true })
  const bold = inkedPixels(await pixelsAt(page, OVER_BLACK))

  console.log(`inked pixels: regular ${regular}, bold ${bold}`)
  expect(bold).toBeGreaterThan(regular)
})

test('a different family lays the text out differently', async ({ page }) => {
  await loadCaption(page)
  const sans = await pixelsAt(page, OVER_BLACK)

  await restyle(page, { fontFamily: 'monospace' })
  const mono = await pixelsAt(page, OVER_BLACK)

  expect(meanChannelDifference(sans, mono)).toBeGreaterThan(0.5)
})

test('alignment moves the text about its anchor', async ({ page }) => {
  await loadCaption(page)

  await restyle(page, { x: Math.round(FIXTURE.width / 2), align: 'left' })
  const left = await pixelsAt(page, OVER_BLACK)

  await restyle(page, { align: 'right' })
  const right = await pixelsAt(page, OVER_BLACK)

  /** Which side of the frame the ink is on. */
  function inkCentreX(pixels: number[]): number {
    let sum = 0
    let count = 0
    for (let y = 0; y < FIXTURE.height; y++) {
      for (let x = 0; x < FIXTURE.width; x++) {
        const i = (y * FIXTURE.width + x) * 4
        if (pixels[i]! > 8) {
          sum += x
          count++
        }
      }
    }
    return count === 0 ? 0 : sum / count
  }

  console.log(
    `ink centre: left-aligned ${inkCentreX(left).toFixed(0)},` +
      ` right-aligned ${inkCentreX(right).toFixed(0)}`,
  )
  expect(inkCentreX(right)).toBeLessThan(inkCentreX(left))
})

test('an outline puts its colour around the glyphs', async ({ page }) => {
  await loadCaption(page)
  const plain = pixelsNear(await pixelsAt(page, OVER_BLACK), [255, 0, 0])

  await restyle(page, { outlineWidthPx: 4, outlineColor: '#ff0000' })
  const outlined = pixelsNear(await pixelsAt(page, OVER_BLACK), [255, 0, 0])

  console.log(`red pixels: without an outline ${plain}, with one ${outlined}`)
  expect(plain).toBe(0)
  expect(outlined).toBeGreaterThan(50)
})

test('a background box fills behind the text', async ({ page }) => {
  await loadCaption(page)
  const withoutBox = pixelsNear(await pixelsAt(page, OVER_BLACK), [0, 0, 255])

  await restyle(page, {
    backgroundColor: '#0000ff',
    backgroundPaddingPx: 16,
  })
  const withBox = pixelsNear(await pixelsAt(page, OVER_BLACK), [0, 0, 255])

  expect(withoutBox).toBe(0)
  // A box is a lot of pixels, far more than an outline would be.
  expect(withBox).toBeGreaterThan(1000)
})

test('the box sits behind the text rather than over it', async ({ page }) => {
  await loadCaption(page)
  await restyle(page, {
    backgroundColor: '#0000ff',
    backgroundPaddingPx: 16,
  })

  const pixels = await pixelsAt(page, OVER_BLACK)
  // The white glyphs are still there on top of the blue.
  expect(pixelsNear(pixels, [255, 255, 255])).toBeGreaterThan(50)
})

test('a newline makes a second line rather than a literal', async ({
  page,
}) => {
  await loadCaption(page, 'ONE')
  const single = await pixelsAt(page, OVER_BLACK)

  await loadCaption(page, 'ONE\nTWO')
  const double = await pixelsAt(page, OVER_BLACK)

  // The second line adds ink lower down the frame, where there was none.
  function lowestInkRow(pixels: number[]): number {
    for (let y = FIXTURE.height - 1; y >= 0; y--) {
      for (let x = 0; x < FIXTURE.width; x++) {
        if (pixels[(y * FIXTURE.width + x) * 4]! > 8) return y
      }
    }
    return -1
  }

  console.log(
    `lowest inked row: one line ${lowestInkRow(single)},` +
      ` two lines ${lowestInkRow(double)}`,
  )
  expect(lowestInkRow(double)).toBeGreaterThan(lowestInkRow(single))
  expect(inkedPixels(double)).toBeGreaterThan(inkedPixels(single))
})

test('a shadow spreads ink beyond the glyphs', async ({ page }) => {
  await loadCaption(page)
  const plain = inkedPixels(await pixelsAt(page, OVER_BLACK))

  await restyle(page, { shadowBlurPx: 12, shadowColor: '#ffffff' })
  const shadowed = inkedPixels(await pixelsAt(page, OVER_BLACK))

  expect(shadowed).toBeGreaterThan(plain)
})

test('the export carries the styling', async ({ page }) => {
  await loadCaption(page)
  await restyle(page, {
    bold: true,
    align: 'center',
    x: Math.round(FIXTURE.width / 2),
    outlineWidthPx: 3,
    outlineColor: '#ff0000',
    backgroundColor: '#003300',
    backgroundPaddingPx: 10,
  })

  const preview = await pixelsAt(page, OVER_BLACK)

  await page.evaluate(() => window.harness.exportMp4())
  await page.evaluate(() => window.harness.loadExported())
  const exported = await pixelsAt(page, OVER_BLACK)

  const diff = meanChannelDifference(preview, exported)
  console.log(`export vs preview: mean channel diff ${diff.toFixed(3)}`)
  expect(diff).toBeLessThan(4)
  expect(pixelsNear(exported, [255, 0, 0])).toBeGreaterThan(20)
})

test.describe('the text panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
    await expect(page.getByTestId('clip')).toBeVisible()
    await page.getByTestId('add-overlay').click()
    await expect(page.getByTestId('overlay-block')).toHaveCount(1)
  })

  function caption(page: Page) {
    return page.evaluate(() => {
      const project = window.__timelineStore.getState().project
      const segment = project.tracks
        .flatMap((track) => track.segments)
        .find((candidate) => candidate.content.kind === 'text')!
      return segment.content as Record<string, unknown>
    })
  }

  test('offers the styling and stores what is chosen', async ({ page }) => {
    await page.getByTestId('overlay-font').selectOption('monospace')
    await page.getByTestId('overlay-align').selectOption('center')
    await page.getByTestId('overlay-bold').check()
    await page.getByTestId('overlay-italic').check()
    await page.getByTestId('overlay-outline').fill('4')

    expect(await caption(page)).toMatchObject({
      fontFamily: 'monospace',
      align: 'center',
      bold: true,
      italic: true,
      outlineWidthPx: 4,
    })
  })

  test('a box appears with a colour and goes away again', async ({ page }) => {
    await page.getByTestId('overlay-box').check()
    await expect(page.getByTestId('overlay-box-color')).toBeVisible()
    expect(await caption(page)).toMatchObject({ backgroundColor: '#000000' })

    await page.getByTestId('overlay-box').uncheck()
    await expect(page.getByTestId('overlay-box-color')).toHaveCount(0)
    expect((await caption(page)).backgroundColor).toBeUndefined()
  })
})
