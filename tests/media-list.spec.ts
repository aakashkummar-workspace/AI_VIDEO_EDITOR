import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_B } from './fixture.config.mjs'

const SECOND = 1_000_000
const A_DURATION = (FIXTURE.frames / FIXTURE.fps) * SECOND
const B_DURATION = (FIXTURE_B.frames / FIXTURE_B.fps) * SECOND

function clips(page: Page) {
  return page.evaluate(
    () => window.__timelineStore.getState().project.videoTrack.clips,
  )
}

function composition(page: Page) {
  return page.evaluate(
    () => window.__timelineStore.getState().project.composition,
  )
}

async function loadFile(page: Page, path: string, expectedCount: number) {
  await page.setInputFiles('input[type=file]', path)
  await expect(page.getByTestId('media-item')).toHaveCount(expectedCount)
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/')
})

test('a second file adds a source and appends a clip after the first', async ({
  page,
}) => {
  await loadFile(page, FIXTURE.path, 1)
  expect(await clips(page)).toMatchObject([
    { sourceInMicros: 0, sourceOutMicros: A_DURATION, timelineStartMicros: 0 },
  ])

  await loadFile(page, FIXTURE_B.path, 2)

  const after = await clips(page)
  expect(after).toHaveLength(2)
  // The second clip starts where the first one ends, not on top of it.
  expect(after[1]!.timelineStartMicros).toBe(A_DURATION)
  expect(after[1]!.sourceOutMicros - after[1]!.sourceInMicros).toBe(B_DURATION)
  expect(after[1]!.sourceId).not.toBe(after[0]!.sourceId)

  await expect(page.getByTestId('time')).toHaveText(
    `0:00.00 / ${formatted(A_DURATION + B_DURATION)}`,
  )
})

test('the composition stays with the first source', async ({ page }) => {
  await loadFile(page, FIXTURE.path, 1)
  expect(await composition(page)).toEqual({
    width: FIXTURE.width,
    height: FIXTURE.height,
  })

  // The wider second file letterboxes into it rather than redefining it.
  await loadFile(page, FIXTURE_B.path, 2)
  expect(await composition(page)).toEqual({
    width: FIXTURE.width,
    height: FIXTURE.height,
  })
})

test('the media list names each source with its real dimensions', async ({
  page,
}) => {
  await loadFile(page, FIXTURE.path, 1)
  await loadFile(page, FIXTURE_B.path, 2)

  const items = page.getByTestId('media-item')
  await expect(items.nth(0)).toContainText('counter-30fps.mp4')
  await expect(items.nth(0)).toContainText(`${FIXTURE.width} x ${FIXTURE.height}`)
  await expect(items.nth(1)).toContainText('counter-24fps-wide.mp4')
  await expect(items.nth(1)).toContainText(
    `${FIXTURE_B.width} x ${FIXTURE_B.height}`,
  )
})

test('a source can be added to the timeline more than once', async ({
  page,
}) => {
  await loadFile(page, FIXTURE.path, 1)

  await page.getByTestId('add-to-timeline').first().click()
  await expect(page.getByTestId('clip')).toHaveCount(2)

  const after = await clips(page)
  // Two clips, one source: the same footage used twice.
  expect(after[0]!.sourceId).toBe(after[1]!.sourceId)
  expect(after[1]!.timelineStartMicros).toBe(A_DURATION)
  // Still only one entry in the media list.
  await expect(page.getByTestId('media-item')).toHaveCount(1)
})

test('adding the same file twice keeps both as separate sources', async ({
  page,
}) => {
  await loadFile(page, FIXTURE.path, 1)
  await loadFile(page, FIXTURE.path, 2)

  const after = await clips(page)
  expect(after).toHaveLength(2)
  expect(after[0]!.sourceId).not.toBe(after[1]!.sourceId)
})

/** Mirrors formatMicros in src/playback.ts. */
function formatted(micros: number): string {
  const totalMillis = Math.round(micros / 1000)
  const minutes = Math.floor(totalMillis / 60_000)
  const seconds = Math.floor((totalMillis % 60_000) / 1000)
  const hundredths = Math.floor((totalMillis % 1000) / 10)

  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(
    hundredths,
  ).padStart(2, '0')}`
}
