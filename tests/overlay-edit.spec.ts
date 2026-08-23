import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

const PIXELS_PER_SECOND = 100
const SECOND = 1_000_000

function overlays(page: Page) {
  return page.evaluate(
    () => {
      const project = window.__timelineStore.getState().project
      return project.tracks
        .filter((track) => track.kind === 'text')
        .flatMap((track) => track.segments)
        .flatMap((segment) =>
          segment.content.kind === 'text'
            ? [
                {
                  id: segment.id,
                  timelineStartMicros: segment.timelineStartMicros,
                  ...segment.content,
                },
              ]
            : [],
        )
    },
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
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
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

  // Rows are stacked the way they composite: the text row draws over the
  // video row, so it sits above it here rather than below.
  const clip = (await page.getByTestId('clip').first().boundingBox())!
  const overlay = await overlayBox(page)
  expect(overlay.y).toBeLessThan(clip.y)
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

test('typing a caption is one undo step, not one per letter', async ({
  page,
}) => {
  const before = await undoDepth(page)

  const field = page.getByTestId('overlay-text')
  await field.click()
  await page.keyboard.press('Control+a')
  await field.pressSequentially('CAPTION', { delay: 15 })
  expect(await overlays(page)).toMatchObject([{ content: 'CAPTION' }])

  // A continuous interaction is one edit, the same as a drag is.
  expect(await undoDepth(page)).toBe(before + 1)

  // Ctrl+Z is ignored while a field has focus, so the browser's own field
  // undo does not shadow the app's. Leave the field first.
  await page.locator('.wordmark').click()
  await page.keyboard.press('Control+z')
  expect(await overlays(page)).toMatchObject([{ content: 'Text' }])
})

test('nudging a number field is one undo step per visit', async ({ page }) => {
  const before = await undoDepth(page)
  const x = page.getByTestId('overlay-x')

  await x.click()
  for (let press = 0; press < 5; press++) await page.keyboard.press('ArrowUp')
  expect(await overlays(page)).toMatchObject([{ x: 37 }])
  expect(await undoDepth(page)).toBe(before + 1)

  // Leaving the field and coming back starts a fresh step.
  await page.getByTestId('overlay-y').click()
  await x.click()
  await page.keyboard.press('ArrowUp')

  expect(await undoDepth(page)).toBe(before + 2)

  await page.locator('.wordmark').click()
  await page.keyboard.press('Control+z')
  expect(await overlays(page)).toMatchObject([{ x: 37 }])
})
