import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

const SECOND = 1_000_000
const SOURCE_SECONDS = FIXTURE.frames / FIXTURE.fps

function zoom(page: Page) {
  return page
    .getByTestId('zoom')
    .textContent()
    .then((text) => Number.parseInt(text ?? '0', 10))
}

/** Width of one clip block on screen, which tracks the zoom directly. */
async function clipWidth(page: Page) {
  const box = await page.getByTestId('clip').first().boundingBox()
  return box!.width
}

async function scrollLeft(page: Page) {
  return page.evaluate(
    () => document.querySelector('[data-testid=timeline-scroll]')!.scrollLeft,
  )
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toBeVisible()
})

test('the zoom buttons scale the track', async ({ page }) => {
  const before = await clipWidth(page)
  expect(await zoom(page)).toBe(100)

  await page.getByTestId('zoom-in').click()
  expect(await zoom(page)).toBe(125)
  expect(await clipWidth(page)).toBeCloseTo(before * 1.25, 0)

  await page.getByTestId('zoom-out').click()
  expect(await zoom(page)).toBe(100)
  expect(await clipWidth(page)).toBeCloseTo(before, 0)
})

test('the zoom stops at both ends of its range', async ({ page }) => {
  for (let click = 0; click < 20; click++) {
    await page.getByTestId('zoom-in').click()
  }
  expect(await zoom(page)).toBe(400)

  for (let click = 0; click < 40; click++) {
    await page.getByTestId('zoom-out').click()
  }
  expect(await zoom(page)).toBe(5)
})

test('ctrl+wheel zooms and keeps the position under the cursor', async ({
  page,
}) => {
  // Zoom in far enough that the timeline is wider than the strip and scrolls.
  for (let click = 0; click < 6; click++) {
    await page.getByTestId('zoom-in').click()
  }

  const strip = (await page
    .getByTestId('timeline-scroll')
    .boundingBox())!
  const cursorX = strip.x + 300
  const cursorY = strip.y + 40

  const before = {
    zoom: await zoom(page),
    scroll: await scrollLeft(page),
  }
  const timeUnderCursor =
    (before.scroll + 300) / before.zoom

  // page.mouse.wheel takes no modifiers, so hold Control for real.
  await page.mouse.move(cursorX, cursorY)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await expect.poll(() => zoom(page)).toBeGreaterThan(before.zoom)

  const after = { zoom: await zoom(page), scroll: await scrollLeft(page) }
  const timeAfter = (after.scroll + 300) / after.zoom

  // Within a pixel's worth of time at the new zoom.
  expect(Math.abs(timeAfter - timeUnderCursor)).toBeLessThan(1 / after.zoom + 0.02)
})

test('a plain wheel does not zoom', async ({ page }) => {
  const before = await zoom(page)
  const strip = (await page.getByTestId('timeline-scroll').boundingBox())!

  await page.mouse.move(strip.x + 100, strip.y + 40)
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(100)

  expect(await zoom(page)).toBe(before)
})

test('the track scrolls once it is wider than the strip', async ({ page }) => {
  for (let click = 0; click < 8; click++) {
    await page.getByTestId('zoom-in').click()
  }

  const overflows = await page.evaluate(() => {
    const strip = document.querySelector('[data-testid=timeline-scroll]')!
    return strip.scrollWidth > strip.clientWidth
  })
  expect(overflows).toBe(true)

  await page.evaluate(() => {
    document.querySelector('[data-testid=timeline-scroll]')!.scrollLeft = 200
  })
  expect(await scrollLeft(page)).toBe(200)
})

test('fit sizes the timeline to the strip', async ({ page }) => {
  for (let click = 0; click < 8; click++) {
    await page.getByTestId('zoom-in').click()
  }

  await page.getByTestId('zoom-fit').click()

  const { scrollWidth, clientWidth } = await page.evaluate(() => {
    const strip = document.querySelector('[data-testid=timeline-scroll]')!
    return { scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth }
  })

  // The whole timeline is visible, with no meaningful overflow left.
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2)
  expect(await zoom(page)).toBeGreaterThan(1)
})

test('the ruler thins its labels out as the zoom drops', async ({ page }) => {
  const atDefault = await page.locator('.timeline-tick-label').allTextContents()
  expect(atDefault.slice(0, 3)).toEqual(['0s', '1s', '2s'])

  for (let click = 0; click < 40; click++) {
    await page.getByTestId('zoom-out').click()
  }
  expect(await zoom(page)).toBe(5)

  const zoomedOut = await page.locator('.timeline-tick-label').allTextContents()
  expect(zoomedOut).toEqual(['0s', '30s'])

  // Labels never crowd: at least 60px between neighbours, whatever the zoom.
  const positions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.timeline-tick')).map(
      (tick) => (tick as HTMLElement).getBoundingClientRect().x,
    ),
  )
  for (let i = 1; i < positions.length; i++) {
    expect(positions[i]! - positions[i - 1]!).toBeGreaterThanOrEqual(60)
  }
})

test('editing still uses the right times after a zoom', async ({ page }) => {
  // The drag layer measures in pixels, so a stale zoom would misconvert.
  await page.getByTestId('zoom-out').click()
  await page.getByTestId('zoom-out').click()
  const pixelsPerSecond = await zoom(page)

  const box = (await page.getByTestId('clip').first().boundingBox())!
  const fromX = box.x + box.width / 2
  const y = box.y + box.height / 2

  await page.mouse.move(fromX, y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(fromX + (pixelsPerSecond * 2 * step) / 8, y)
  }
  await page.mouse.up()

  const clips = await page.evaluate(
    () => window.__timelineStore.getState().project.videoTrack.clips,
  )
  // Dragged two seconds' worth of pixels at the current zoom.
  expect(clips[0]!.timelineStartMicros).toBeGreaterThan(1.9 * SECOND)
  expect(clips[0]!.timelineStartMicros).toBeLessThan(2.1 * SECOND)
  expect(clips[0]!.sourceOutMicros).toBe(SOURCE_SECONDS * SECOND)
})
