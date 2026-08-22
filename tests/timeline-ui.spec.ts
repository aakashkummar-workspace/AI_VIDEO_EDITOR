import { expect, test } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

/** Matches PIXELS_PER_SECOND in src/timeline/layout.ts. */
const PIXELS_PER_SECOND = 100
const FIXTURE_SECONDS = FIXTURE.frames / FIXTURE.fps

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toBeVisible()
})

test('a loaded file becomes one clip covering the whole source', async ({
  page,
}) => {
  const clips = page.getByTestId('clip')
  await expect(clips).toHaveCount(1)

  const box = await clips.boundingBox()
  expect(box).not.toBeNull()

  // The block spans the full source at the fixed scale.
  expect(box!.width).toBeCloseTo(FIXTURE_SECONDS * PIXELS_PER_SECOND, 0)
})

test('the ruler marks every second', async ({ page }) => {
  const labels = await page
    .locator('.timeline-tick-label')
    .allTextContents()

  // 0s through 6s inclusive for a six second clip.
  expect(labels).toEqual(['0s', '1s', '2s', '3s', '4s', '5s', '6s'])
})

test('clicking the track seeks the preview to that time', async ({ page }) => {
  await expect(page.getByTestId('time')).toHaveText('0:00.00 / 0:06.00')

  const timeline = page.getByTestId('timeline')
  const box = (await timeline.boundingBox())!

  // Two seconds in, at 100 pixels per second.
  await timeline.click({ position: { x: 2 * PIXELS_PER_SECOND, y: 30 } })

  await expect(page.getByTestId('time')).toHaveText('0:02.00 / 0:06.00')

  // The playhead followed the click.
  const playhead = (await page.getByTestId('playhead').boundingBox())!
  expect(playhead.x - box.x).toBeCloseTo(2 * PIXELS_PER_SECOND, 0)
})

test('the canvas actually redraws when the track is clicked', async ({
  page,
}) => {
  const canvas = page.locator('canvas')

  await page
    .getByTestId('timeline')
    .click({ position: { x: 1 * PIXELS_PER_SECOND, y: 30 } })
  const atOneSecond = await canvas.screenshot()

  await page
    .getByTestId('timeline')
    .click({ position: { x: 4 * PIXELS_PER_SECOND, y: 30 } })
  const atFourSeconds = await canvas.screenshot()

  expect(atOneSecond.equals(atFourSeconds)).toBe(false)
})

test('the playhead tracks playback', async ({ page }) => {
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toBeEnabled()

  await expect
    .poll(async () => (await page.getByTestId('playhead').boundingBox())!.x, {
      timeout: 10_000,
    })
    .toBeGreaterThan((await page.getByTestId('timeline').boundingBox())!.x + 50)

  await page.getByRole('button', { name: 'Pause' }).click()
})

test('the playhead lands at the end when playback finishes', async ({
  page,
}) => {
  // Clip ends are exclusive, so a finished player reports a source time no
  // clip contains. The playhead must land on the end, not snap back to zero.
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled({
    timeout: 30_000,
  })

  await expect(page.getByTestId('time')).toHaveText('0:06.00 / 0:06.00')

  const timeline = (await page.getByTestId('timeline').boundingBox())!
  const playhead = (await page.getByTestId('playhead').boundingBox())!
  expect(playhead.x - timeline.x).toBeCloseTo(
    FIXTURE_SECONDS * PIXELS_PER_SECOND,
    0,
  )
})
