import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_MUSIC } from './fixture.config.mjs'

/**
 * Where the controls live.
 *
 * Scope decides the column: the left is the project, the right is whatever is
 * selected. Every panel had been in one column, which meant scrolling past the
 * media list and the export settings to reach the clip you had just clicked.
 */

/** Which column a panel is in, by its test id. */
async function columnOf(page: Page, testId: string): Promise<string> {
  return page.evaluate((id) => {
    const panel = document.querySelector(`[data-testid="${id}"]`)
    if (!panel) return 'absent'
    if (panel.closest('.inspector')) return 'inspector'
    if (panel.closest('.sidebar')) return 'sidebar'
    return 'elsewhere'
  }, testId)
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/')
  await expect(page.getByTestId('storage-panel')).toHaveAttribute(
    'data-restored',
    'true',
  )
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toBeVisible()
})

test('the project lives on the left', async ({ page }) => {
  for (const panel of ['export-panel', 'storage-panel']) {
    expect(await columnOf(page, panel), panel).toBe('sidebar')
  }
})

test('the selection lives on the right', async ({ page }) => {
  await page.getByTestId('clip').click()

  for (const panel of [
    'transform-panel',
    'compositing-panel',
    'effects-panel',
    'levels-panel',
    'speed-panel',
  ]) {
    expect(await columnOf(page, panel), panel).toBe('inspector')
  }
})

test('the inspector is empty until something is selected', async ({ page }) => {
  await expect(page.getByTestId('inspector-empty')).toBeVisible()
  expect(await columnOf(page, 'transform-panel')).toBe('absent')

  await page.getByTestId('clip').click()
  await expect(page.getByTestId('inspector-empty')).toHaveCount(0)
  await expect(page.getByTestId('transform-panel')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('inspector-empty')).toBeVisible()
})

test('adding text is a project action, styling it is not', async ({ page }) => {
  // The button that makes a caption belongs with the project...
  expect(await columnOf(page, 'add-overlay')).toBe('sidebar')
  // ...and it is there whatever is selected, including a video clip.
  await page.getByTestId('clip').click()
  await expect(page.getByTestId('add-overlay')).toBeVisible()
  await expect(page.getByTestId('caption-panel')).toHaveCount(0)

  // The caption's own fields only exist once there is a caption selected.
  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)
  expect(await columnOf(page, 'caption-panel')).toBe('inspector')
})

test('a segment only offers what applies to it', async ({ page }) => {
  await page.setInputFiles('[data-testid=media-input]', FIXTURE_MUSIC.path)
  await expect(page.getByTestId('audio-block')).toHaveCount(1)

  // Sound has no picture to transform or composite, but it has a volume.
  await page.getByTestId('audio-block').click()
  await expect(page.getByTestId('levels-panel')).toBeVisible()
  await expect(page.getByTestId('speed-panel')).toBeVisible()
  await expect(page.getByTestId('transform-panel')).toHaveCount(0)
  await expect(page.getByTestId('compositing-panel')).toHaveCount(0)

  // A caption has a look but no volume and no speed.
  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('caption-panel')).toBeVisible()
  await expect(page.getByTestId('transform-panel')).toBeVisible()
  await expect(page.getByTestId('levels-panel')).toHaveCount(0)
  await expect(page.getByTestId('speed-panel')).toHaveCount(0)
})

test('the rows say what they are', async ({ page }) => {
  await expect(page.getByTestId('track-label')).toHaveCount(3)
  await expect(page.getByTestId('track-label').first()).toHaveText('text')
  await expect(page.getByTestId('track-label').last()).toHaveText('audio')
})

test('a row label does not sit on top of the blocks', async ({ page }) => {
  const label = (await page
    .getByTestId('track-label')
    .nth(1)
    .boundingBox())!
  const clip = (await page.getByTestId('clip').boundingBox())!

  // The label band is above the block, not over it.
  expect(label.y + label.height).toBeLessThanOrEqual(clip.y + 1)
})

test('the timeline stops growing rather than eating the picture', async ({
  page,
}) => {
  const canvasBefore = (await page.locator('.stage-canvas canvas').boundingBox())!

  for (let i = 0; i < 6; i++) {
    await page.getByTestId('add-video-track').click()
  }
  await expect(page.getByTestId('track')).toHaveCount(9)

  const dock = (await page.locator('.dock').boundingBox())!
  const viewport = page.viewportSize()!

  expect(dock.height).toBeLessThanOrEqual(viewport.height * 0.45)

  // The picture is still there and still a sensible size.
  const canvasAfter = (await page.locator('.stage-canvas canvas').boundingBox())!
  expect(canvasAfter.height).toBeGreaterThan(0)
  expect(canvasAfter.height).toBeLessThanOrEqual(canvasBefore.height)
})
