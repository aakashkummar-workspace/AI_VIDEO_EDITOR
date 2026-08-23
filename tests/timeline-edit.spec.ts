import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

/** Matches PIXELS_PER_SECOND in src/timeline/layout.ts. */
const PIXELS_PER_SECOND = 100
const SECOND = 1_000_000
const SOURCE_DURATION = (FIXTURE.frames / FIXTURE.fps) * SECOND

/** The project state itself, not what it happens to look like on screen. */
function clips(page: Page) {
  return page.evaluate(
    () => {
      const project = window.__timelineStore.getState().project
      return project.tracks
        .filter((track) => track.kind === 'video')
        .flatMap((track) => track.segments)
        .flatMap((segment) =>
          segment.content.kind === 'video'
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

/** Drags from one point to another in steps, as a real mouse would. */
async function drag(page: Page, fromX: number, fromY: number, toX: number) {
  await page.mouse.move(fromX, fromY)
  await page.mouse.down()

  const steps = 10
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(fromX + ((toX - fromX) * step) / steps, fromY)
  }

  await page.mouse.up()
}

/** Screen coordinates of a clip block. */
async function clipBox(page: Page, index = 0) {
  const box = await page.getByTestId('clip').nth(index).boundingBox()
  if (!box) throw new Error('the clip has no box')
  return box
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/')
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toBeVisible()

  // One clip covering the whole source, at the start of the timeline.
  expect(await clips(page)).toMatchObject([
    {
      sourceInMicros: 0,
      sourceOutMicros: SOURCE_DURATION,
      timelineStartMicros: 0,
    },
  ])
})

test('dragging a clip changes only where it sits', async ({ page }) => {
  const box = await clipBox(page)
  const middleX = box.x + box.width / 2
  const middleY = box.y + box.height / 2

  await drag(page, middleX, middleY, middleX + 2 * PIXELS_PER_SECOND)

  expect(await clips(page)).toMatchObject([
    {
      sourceInMicros: 0,
      sourceOutMicros: SOURCE_DURATION,
      timelineStartMicros: 2 * SECOND,
    },
  ])
})

test('dragging the right edge moves the out-point', async ({ page }) => {
  const box = await clipBox(page)
  const y = box.y + box.height / 2

  const grabX = box.x + box.width - 2
  await drag(page, grabX, y, grabX - 2 * PIXELS_PER_SECOND)

  expect(await clips(page)).toMatchObject([
    {
      sourceInMicros: 0,
      sourceOutMicros: 4 * SECOND,
      timelineStartMicros: 0,
    },
  ])
})

test('dragging the left edge moves the head and the in-point together', async ({
  page,
}) => {
  const box = await clipBox(page)
  const y = box.y + box.height / 2

  const grabX = box.x + 2
  await drag(page, grabX, y, grabX + 2 * PIXELS_PER_SECOND)

  // The frames under the clip stay put: head and in-point move as one.
  expect(await clips(page)).toMatchObject([
    {
      sourceInMicros: 2 * SECOND,
      sourceOutMicros: SOURCE_DURATION,
      timelineStartMicros: 2 * SECOND,
    },
  ])
})

test('a whole drag is exactly one undo step', async ({ page }) => {
  const before = await undoDepth(page)
  const box = await clipBox(page)
  const middleY = box.y + box.height / 2

  // Ten intermediate mouse positions, one edit.
  await drag(page, box.x + box.width / 2, middleY, box.x + box.width / 2 + 300)

  expect(await undoDepth(page)).toBe(before + 1)

  await page.keyboard.press('Control+z')
  expect(await clips(page)).toMatchObject([{ timelineStartMicros: 0 }])

  await page.keyboard.press('Control+y')
  expect(await clips(page)).toMatchObject([{ timelineStartMicros: 3 * SECOND }])
})

test('S splits the clip under the playhead', async ({ page }) => {
  await page
    .getByTestId('timeline')
    .click({ position: { x: 2 * PIXELS_PER_SECOND, y: 30 } })
  await expect(page.getByTestId('time')).toHaveText('0:02.00 / 0:06.00')

  await page.keyboard.press('s')

  // Two clips meeting exactly at the playhead, covering the same source range.
  expect(await clips(page)).toMatchObject([
    {
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 0,
    },
    {
      sourceInMicros: 2 * SECOND,
      sourceOutMicros: SOURCE_DURATION,
      timelineStartMicros: 2 * SECOND,
    },
  ])
  await expect(page.getByTestId('clip')).toHaveCount(2)
})

test('a clip dragged into its neighbour stops at the edge', async ({
  page,
}) => {
  // Split at 2s, then drag the right half hard into the left one.
  // No waiting between the click and the shortcut: the playhead the split
  // uses must be the one the click just set, not the last rendered frame.
  await page
    .getByTestId('timeline')
    .click({ position: { x: 2 * PIXELS_PER_SECOND, y: 30 } })
  await page.keyboard.press('s')
  await expect(page.getByTestId('clip')).toHaveCount(2)

  const right = await clipBox(page, 1)
  const y = right.y + right.height / 2
  await drag(page, right.x + right.width / 2, y, right.x - 500)

  const after = await clips(page)
  expect(after[1]!.timelineStartMicros).toBe(2 * SECOND)
  // Still touching, still not overlapping.
  expect(after[0]!.sourceOutMicros - after[0]!.sourceInMicros).toBe(2 * SECOND)
})

test('a drag that changes nothing costs no undo step', async ({ page }) => {
  const before = await undoDepth(page)
  const box = await clipBox(page)
  const y = box.y + box.height / 2

  // Already hard against the start of the timeline; dragging left does nothing.
  await drag(page, box.x + box.width / 2, y, box.x + box.width / 2 - 400)

  expect(await clips(page)).toMatchObject([{ timelineStartMicros: 0 }])
  expect(await undoDepth(page)).toBe(before)
})

test('the timeline shows a resize cursor on the edges and move in between', async ({
  page,
}) => {
  const clip = page.getByTestId('clip').first()
  const box = await clipBox(page)
  const y = box.y + box.height / 2

  await page.mouse.move(box.x + 2, y)
  await expect(clip).toHaveCSS('cursor', 'ew-resize')

  await page.mouse.move(box.x + box.width / 2, y)
  await expect(clip).toHaveCSS('cursor', 'move')

  await page.mouse.move(box.x + box.width - 2, y)
  await expect(clip).toHaveCSS('cursor', 'ew-resize')
})
