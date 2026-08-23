import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

/** The keys that make an editor feel like one. */

const SECOND = 1_000_000
const FRAME_STEP = Math.round(SECOND / 30)

/**
 * The playhead, read off the transport.
 *
 * The label carries the position AND the length - "0:02.50 / 0:06.00" - so
 * only the half before the slash is the answer.
 */
function currentMicros(page: Page) {
  return page.evaluate(() => {
    const label = document.querySelector('[data-testid=time]')?.textContent
    const position = (label ?? '0:00.00').split('/')[0]!.trim()
    const [minutes, rest] = position.split(':')
    const [seconds, hundredths] = (rest ?? '00.00').split('.')

    return (
      Number(minutes) * 60_000_000 +
      Number(seconds) * 1_000_000 +
      Number(hundredths) * 10_000
    )
  })
}

function segments(page: Page) {
  return page.evaluate(() =>
    window.__timelineStore
      .getState()
      .project.tracks.flatMap((track) => track.segments.map((s) => s.id)),
  )
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/')
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toBeVisible()
  // Somewhere in the middle, with room to step either way.
  await page.getByTestId('timeline').click({ position: { x: 200, y: 30 } })
  await expect.poll(() => currentMicros(page)).toBeGreaterThan(0)
})

test('the arrow keys step the playhead a frame at a time', async ({ page }) => {
  const before = await currentMicros(page)

  await page.keyboard.press('ArrowRight')
  const forward = await currentMicros(page)
  expect(forward - before).toBeGreaterThanOrEqual(FRAME_STEP - 10_000)
  expect(forward - before).toBeLessThanOrEqual(FRAME_STEP + 10_000)

  await page.keyboard.press('ArrowLeft')
  expect(await currentMicros(page)).toBe(before)
})

test('shift makes the arrows step a second', async ({ page }) => {
  const before = await currentMicros(page)

  await page.keyboard.press('Shift+ArrowRight')
  const after = await currentMicros(page)

  expect(after - before).toBeGreaterThan(0.9 * SECOND)
  expect(after - before).toBeLessThan(1.1 * SECOND)
})

test('stepping stops at either end rather than running off', async ({
  page,
}) => {
  await page.keyboard.press('Home')
  expect(await currentMicros(page)).toBe(0)

  await page.keyboard.press('ArrowLeft')
  expect(await currentMicros(page)).toBe(0)

  await page.keyboard.press('End')
  const end = await currentMicros(page)
  expect(end).toBeGreaterThan(5 * SECOND)

  await page.keyboard.press('ArrowRight')
  expect(await currentMicros(page)).toBe(end)
})

test('space plays and pauses', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Pause' })).toBeDisabled()

  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeEnabled()

  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeDisabled()
})

test('space does not scroll the page', async ({ page }) => {
  const before = await page.evaluate(() => window.scrollY)
  await page.keyboard.press('Space')
  expect(await page.evaluate(() => window.scrollY)).toBe(before)
})

test('delete removes what is selected, and nothing when nothing is', async ({
  page,
}) => {
  const before = await segments(page)
  expect(before).toHaveLength(1)

  // Nothing selected yet.
  await page.keyboard.press('Delete')
  expect(await segments(page)).toEqual(before)

  await page.getByTestId('clip').click()
  await page.keyboard.press('Delete')
  expect(await segments(page)).toEqual([])
})

test('deleting is one undo step, like every other edit', async ({ page }) => {
  const before = await segments(page)

  await page.getByTestId('clip').click()
  await page.keyboard.press('Delete')
  expect(await segments(page)).toEqual([])

  await page.keyboard.press('Control+z')
  expect(await segments(page)).toEqual(before)
})

test('escape clears the selection', async ({ page }) => {
  await page.getByTestId('clip').click()
  await expect(page.getByTestId('transform-panel')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('transform-panel')).toHaveCount(0)
})

test('the shortcuts stay out of the way while a field has focus', async ({
  page,
}) => {
  const before = await currentMicros(page)

  const field = page.getByTestId('overlay-text')
  await field.click()
  await field.fill('')
  await page.keyboard.type('a b')

  // The space went into the caption, not into the transport.
  expect(await field.inputValue()).toBe('a b')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeDisabled()

  await page.keyboard.press('ArrowLeft')
  expect(await currentMicros(page)).toBe(before)
})

test('the shortcut list says what the keys do', async ({ page }) => {
  const shortcuts = page.locator('.shortcuts')

  await expect(shortcuts).toContainText('Space')
  await expect(shortcuts).toContainText('play or pause')
  await expect(shortcuts).toContainText('Delete')
})
