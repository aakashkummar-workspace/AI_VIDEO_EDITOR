import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, wholeSourceSpec } from './fixture.config.mjs'

/**
 * What the exported file actually is, as opposed to what the project is
 * authored at. The two are allowed to differ, and the picture must not.
 */

const SECOND = 1_000_000

function meanBrightness(pixels: number[]): number {
  let total = 0
  let count = 0
  for (let i = 0; i < pixels.length; i += 4) {
    total += pixels[i]! + pixels[i + 1]! + pixels[i + 2]!
    count += 3
  }
  return total / count
}

function pixelsAt(page: Page, micros: number) {
  return page.evaluate((t) => window.harness.pixelsAt(t), micros)
}

async function loadClip(page: Page) {
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    wholeSourceSpec('a'),
  )
}

async function setExport(
  page: Page,
  settings: { heightPx?: number | null; quality?: string },
) {
  await page.evaluate((next) => {
    const store = window.__timelineStore.getState()
    store.setExportSettings(next as never)
    window.harness.setProject(window.__timelineStore.getState().project)
  }, settings)
}

/** Exports, reloads the result, and reports what came out. */
async function exportAndReload(page: Page) {
  const exported = await page.evaluate(() => window.harness.exportMp4())
  const geometry = await page.evaluate(() => window.harness.loadExported())
  return { byteLength: exported.byteLength, ...geometry! }
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('by default the file is the size of the composition', async ({ page }) => {
  await loadClip(page)
  const result = await exportAndReload(page)

  expect(result.width).toBe(FIXTURE.width)
  expect(result.height).toBe(FIXTURE.height)
})

test('a chosen height decides the file, and the shape is kept', async ({
  page,
}) => {
  await loadClip(page)
  await setExport(page, { heightPx: 480 })

  const result = await exportAndReload(page)

  // The composition is 4:3, so 480 tall means 640 wide.
  expect(result.height).toBe(480)
  expect(result.width).toBe(640)
})

test('exporting smaller than the composition works too', async ({ page }) => {
  await loadClip(page)
  await setExport(page, { heightPx: 120 })

  const result = await exportAndReload(page)

  expect(result.height).toBe(120)
  expect(result.width).toBe(160)
})

test('the picture survives being exported at another size', async ({
  page,
}) => {
  await loadClip(page)
  const preview = meanBrightness(await pixelsAt(page, 2 * SECOND))

  await setExport(page, { heightPx: 480 })
  await exportAndReload(page)
  const exported = meanBrightness(await pixelsAt(page, 2 * SECOND))

  console.log(
    `mean brightness: preview ${preview.toFixed(1)},` +
      ` exported at 480p ${exported.toFixed(1)}`,
  )

  // Brightness does not depend on resolution, so scaling must not shift it.
  // A stretched or cropped frame, or one rendered onto black, would.
  expect(Math.abs(exported - preview)).toBeLessThan(4)
  expect(exported).toBeGreaterThan(0)
})

test('the export is as long as the timeline whatever size it is', async ({
  page,
}) => {
  await loadClip(page)
  await setExport(page, { heightPx: 480 })

  const result = await exportAndReload(page)
  const expected = (FIXTURE.frames / FIXTURE.fps) * SECOND

  expect(result.durationMicros).toBeGreaterThan(expected - 100_000)
  expect(result.durationMicros).toBeLessThan(expected + 100_000)
})

test('quality changes the size of the file', async ({ page }) => {
  await loadClip(page)

  await setExport(page, { heightPx: 480, quality: 'low' })
  const low = await exportAndReload(page)

  await loadClip(page)
  await setExport(page, { heightPx: 480, quality: 'very-high' })
  const high = await exportAndReload(page)

  console.log(
    `bytes: low ${low.byteLength}, very-high ${high.byteLength}` +
      ` (${(high.byteLength / low.byteLength).toFixed(2)}x)`,
  )

  expect(low.byteLength).toBeGreaterThan(0)
  expect(high.byteLength).toBeGreaterThan(low.byteLength)
})

test('the settings travel with the project, not with the session', async ({
  page,
}) => {
  await loadClip(page)
  await setExport(page, { heightPx: 1080, quality: 'low' })

  const settings = await page.evaluate(
    () => window.__timelineStore.getState().project.exportSettings,
  )

  expect(settings).toEqual({ heightPx: 1080, quality: 'low' })
})

test.describe('the export panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
    await expect(page.getByTestId('clip')).toBeVisible()
  })

  test('offers the composition size by default and says what it will write', async ({
    page,
  }) => {
    await expect(page.getByTestId('export-height')).toHaveValue('source')
    await expect(page.getByTestId('export-summary')).toContainText(
      `${FIXTURE.width}x${FIXTURE.height}`,
    )
  })

  test('picking a size updates the project and the summary', async ({
    page,
  }) => {
    await page.getByTestId('export-height').selectOption('1080')

    await expect(page.getByTestId('export-summary')).toContainText('1440x1080')
    expect(
      await page.evaluate(
        () => window.__timelineStore.getState().project.exportSettings,
      ),
    ).toMatchObject({ heightPx: 1080 })
  })

  test('warns when the chosen size is bigger than the composition', async ({
    page,
  }) => {
    await page.getByTestId('export-height').selectOption('2160')
    await expect(page.getByTestId('export-summary')).toContainText('scaled up')

    await page.getByTestId('export-height').selectOption('source')
    await expect(page.getByTestId('export-summary')).not.toContainText(
      'scaled up',
    )
  })

  test('changing the size is an undoable edit like any other', async ({
    page,
  }) => {
    const depth = await page.evaluate(
      () => window.__timelineStore.getState().past.length,
    )

    await page.getByTestId('export-quality').selectOption('low')
    expect(
      await page.evaluate(
        () => window.__timelineStore.getState().past.length,
      ),
    ).toBe(depth + 1)

    await page.keyboard.press('Control+z')
    expect(
      await page.evaluate(
        () => window.__timelineStore.getState().project.exportSettings,
      ),
    ).toBeUndefined()
  })
})
