import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

/** Adding rows and moving segments between them, through the real UI. */

const PIXELS_PER_SECOND = 100

function tracks(page: Page) {
  return page.evaluate(() =>
    window.__timelineStore
      .getState()
      .project.tracks.map((track) => ({
        id: track.id,
        kind: track.kind,
        segments: track.segments.map((segment) => segment.id),
      })),
  )
}

function undoDepth(page: Page) {
  return page.evaluate(() => window.__timelineStore.getState().past.length)
}

/** Drags from one point to another in steps, as a real mouse would. */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()

  const steps = 10
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / steps,
      from.y + ((to.y - from.y) * step) / steps,
    )
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
})

test('a new project starts with one video row under one text row', async ({
  page,
}) => {
  expect((await tracks(page)).map((track) => track.kind)).toEqual([
    'video',
    'text',
  ])

  // Listed top of the stack first, the way they are drawn.
  await expect(page.getByTestId('track-item')).toHaveCount(2)
  await expect(page.getByTestId('track-item').first()).toHaveAttribute(
    'data-track-kind',
    'text',
  )
})

test('a row can be added and shows up on the timeline', async ({ page }) => {
  await page.getByTestId('add-video-track').click()

  const after = await tracks(page)
  expect(after.map((track) => track.kind)).toEqual(['video', 'text', 'video'])
  await expect(page.getByTestId('track')).toHaveCount(3)
})

test('a row can be removed, taking what is on it', async ({ page }) => {
  const videoTrackId = (await tracks(page)).find(
    (track) => track.kind === 'video',
  )!.id

  await page
    .getByTestId('remove-track')
    .and(page.locator(`[data-track-id="${videoTrackId}"]`))
    .click()

  expect((await tracks(page)).map((track) => track.kind)).toEqual(['text'])
  await expect(page.getByTestId('clip')).toHaveCount(0)
})

test('removing a row is one undo step and comes back whole', async ({
  page,
}) => {
  const before = await tracks(page)
  const depth = await undoDepth(page)
  const videoTrackId = before.find((track) => track.kind === 'video')!.id

  await page
    .getByTestId('remove-track')
    .and(page.locator(`[data-track-id="${videoTrackId}"]`))
    .click()

  expect(await undoDepth(page)).toBe(depth + 1)

  await page.keyboard.press('Control+z')
  expect(await tracks(page)).toEqual(before)
})

test('a clip can be dragged onto another video row', async ({ page }) => {
  await page.getByTestId('add-video-track').click()
  const rows = await tracks(page)
  const upper = rows[2]!.id
  const lower = rows[0]!.id

  const clip = (await page.getByTestId('clip').boundingBox())!
  const target = (await page
    .getByTestId('track')
    .and(page.locator(`[data-track-id="${upper}"]`))
    .boundingBox())!

  await drag(
    page,
    { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 },
    {
      x: clip.x + clip.width / 2 + PIXELS_PER_SECOND,
      y: target.y + target.height / 2,
    },
  )

  const after = await tracks(page)
  expect(after.find((track) => track.id === lower)!.segments).toEqual([])
  expect(after.find((track) => track.id === upper)!.segments).toHaveLength(1)
})

test('a clip dropped on a text row snaps back instead of throwing', async ({
  page,
}) => {
  const before = await tracks(page)
  const textTrackId = before.find((track) => track.kind === 'text')!.id

  const clip = (await page.getByTestId('clip').boundingBox())!
  const target = (await page
    .getByTestId('track')
    .and(page.locator(`[data-track-id="${textTrackId}"]`))
    .boundingBox())!

  await drag(
    page,
    { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 },
    { x: clip.x + clip.width / 2, y: target.y + target.height / 2 },
  )

  // A row that cannot hold it refuses it, and nothing moves.
  expect(await tracks(page)).toEqual(before)
})
