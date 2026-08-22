import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

const PIXELS_PER_SECOND = 100
const SECOND = 1_000_000

function overlays(page: Page) {
  return page.evaluate(
    () => window.__timelineStore.getState().project.overlays,
  )
}

function undoDepth(page: Page) {
  return page.evaluate(() => window.__timelineStore.getState().past.length)
}

async function drag(page: Page, fromX: number, y: number, toX: number) {
  await page.mouse.move(fromX, y)
  await page.mouse.down()
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(fromX + ((toX - fromX) * step) / 10, y)
  }
  await page.mouse.up()
}

async function overlayBox(page: Page) {
  const box = await page.getByTestId('overlay-block').first().boundingBox()
  if (!box) throw new Error('no overlay block')
  return box
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toBeVisible()

  // Put the playhead at 1s, then drop an overlay there.
  await page
    .getByTestId('timeline')
    .click({ position: { x: PIXELS_PER_SECOND, y: 30 } })
  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)
})

test('adding text puts an overlay on its own row at the playhead', async ({
  page,
}) => {
  expect(await overlays(page)).toMatchObject([
    { content: 'Text', timelineStartMicros: 1 * SECOND, durationMicros: 2 * SECOND },
  ])

  // The overlay row sits below the clip row, not on top of it.
  const clip = (await page.getByTestId('clip').first().boundingBox())!
  const overlay = await overlayBox(page)
  expect(overlay.y).toBeGreaterThan(clip.y)
})

test('an overlay drags along its row', async ({ page }) => {
  const box = await overlayBox(page)
  await drag(page, box.x + box.width / 2, box.y + box.height / 2, box.x + box.width / 2 + 2 * PIXELS_PER_SECOND)

  expect(await overlays(page)).toMatchObject([
    { timelineStartMicros: 3 * SECOND, durationMicros: 2 * SECOND },
  ])
})

test('an overlay trims from either edge', async ({ page }) => {
  const box = await overlayBox(page)
  const y = box.y + box.height / 2

  // Tail in by half a second.
  const tailX = box.x + box.width - 2
  await drag(page, tailX, y, tailX - PIXELS_PER_SECOND / 2)
  expect(await overlays(page)).toMatchObject([
    { timelineStartMicros: 1 * SECOND, durationMicros: 1_500_000 },
  ])

  // Head in by half a second: the tail stays where it is.
  const after = await overlayBox(page)
  const headX = after.x + 2
  await drag(page, headX, y, headX + PIXELS_PER_SECOND / 2)
  expect(await overlays(page)).toMatchObject([
    { timelineStartMicros: 1_500_000, durationMicros: 1 * SECOND },
  ])
})

test('an overlay drag is one undo step, like a clip drag', async ({ page }) => {
  const before = await undoDepth(page)
  const box = await overlayBox(page)

  await drag(page, box.x + box.width / 2, box.y + box.height / 2, box.x + box.width / 2 + 300)

  expect(await undoDepth(page)).toBe(before + 1)

  await page.keyboard.press('Control+z')
  expect(await overlays(page)).toMatchObject([
    { timelineStartMicros: 1 * SECOND },
  ])
})

test('the form edits the selected overlay', async ({ page }) => {
  await page.getByTestId('overlay-x').fill('55')
  await page.getByTestId('overlay-size').fill('64')

  expect(await overlays(page)).toMatchObject([{ x: 55, sizePx: 64 }])

  await page.getByTestId('remove-overlay').click()
  expect(await overlays(page)).toEqual([])
  await expect(page.getByTestId('overlay-block')).toHaveCount(0)
})
