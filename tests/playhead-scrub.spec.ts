import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

const PIXELS_PER_SECOND = 100

async function headBox(page: Page) {
  const box = await page.getByTestId('playhead-head').boundingBox()
  if (!box) throw new Error('the playhead head has no box')
  return box
}

/** Drags the playhead head by `deltaX` pixels, in steps, like a real mouse. */
async function scrub(page: Page, deltaX: number) {
  const box = await headBox(page)
  const fromX = box.x + box.width / 2
  const y = box.y + box.height / 2

  await page.mouse.move(fromX, y)
  await page.mouse.down()
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(fromX + (deltaX * step) / 10, y)
  }
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/')
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toBeVisible()

  // Park the playhead at 1s so the head is clear of the left edge.
  await page
    .getByTestId('timeline')
    .click({ position: { x: PIXELS_PER_SECOND, y: 30 } })
  await expect(page.getByTestId('time')).toHaveText('0:01.00 / 0:06.00')
})

test('the seek lands where the drag ended', async ({ page }) => {
  await scrub(page, 2.5 * PIXELS_PER_SECOND)

  // Grabbed at 1s, dragged 250px at 100px/s: 3.5s.
  await expect(page.getByTestId('time')).toHaveText('0:03.50 / 0:06.00')

  const timeline = (await page.getByTestId('timeline').boundingBox())!
  const head = await headBox(page)
  expect(head.x + head.width / 2 - timeline.x).toBeCloseTo(
    3.5 * PIXELS_PER_SECOND,
    0,
  )
})

test('dragging left scrubs backwards', async ({ page }) => {
  await scrub(page, -0.75 * PIXELS_PER_SECOND)

  await expect(page.getByTestId('time')).toHaveText('0:00.25 / 0:06.00')
})

test('a scrub stops at both ends of the timeline', async ({ page }) => {
  await scrub(page, -5 * PIXELS_PER_SECOND)
  await expect(page.getByTestId('time')).toHaveText('0:00.00 / 0:06.00')

  await scrub(page, 20 * PIXELS_PER_SECOND)
  await expect(page.getByTestId('time')).toHaveText('0:06.00 / 0:06.00')
})

test('the canvas shows the frame the scrub landed on', async ({ page }) => {
  const before = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!
    const data = canvas
      .getContext('2d')!
      .getImageData(0, 0, canvas.width, canvas.height).data
    let signature = 0
    for (let i = 0; i < data.length; i += 4) {
      signature = (signature * 31 + data[i]!) % 2_147_483_647
    }
    return signature
  })

  await scrub(page, 3 * PIXELS_PER_SECOND)
  await expect(page.getByTestId('time')).toHaveText('0:04.00 / 0:06.00')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const canvas = document.querySelector('canvas')!
        const data = canvas
          .getContext('2d')!
          .getImageData(0, 0, canvas.width, canvas.height).data
        let signature = 0
        for (let i = 0; i < data.length; i += 4) {
          signature = (signature * 31 + data[i]!) % 2_147_483_647
        }
        return signature
      }),
    )
    .not.toBe(before)
})

test('scrubbing does not add to the undo history', async ({ page }) => {
  const before = await page.evaluate(
    () => window.__timelineStore.getState().past.length,
  )

  await scrub(page, 2 * PIXELS_PER_SECOND)

  // Moving the playhead is not an edit to the project.
  expect(
    await page.evaluate(
      () => window.__timelineStore.getState().past.length,
    ),
  ).toBe(before)
})

test('the head does not move a clip it happens to sit over', async ({
  page,
}) => {
  const clipsBefore = await page.evaluate(() =>
    window.__timelineStore
      .getState()
      .project.tracks.flatMap((track) => track.segments),
  )

  await scrub(page, 2 * PIXELS_PER_SECOND)

  expect(
    await page.evaluate(() =>
      window.__timelineStore
        .getState()
        .project.tracks.flatMap((track) => track.segments),
    ),
  ).toEqual(clipsBefore)
})
