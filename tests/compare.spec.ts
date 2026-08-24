import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

/**
 * Before and after.
 *
 * The picture can show the footage as it ARRIVED instead of as edited. It is a
 * way of looking rather than an edit: nothing about the project changes, the
 * timeline underneath goes on showing the cut, and the whole thing is built as
 * a PROJECT so it goes through the one render function like everything else.
 */

/**
 * Makes the edit genuinely shorter than the footage.
 *
 * Splitting and deleting the FIRST piece leaves a gap rather than closing up,
 * so the timeline ends where it always did. Removing the TAIL is what actually
 * shortens it.
 */
async function cutTheTail(page: Page) {
  await page.getByTestId('timeline').click({ position: { x: 60, y: 10 } })
  await page.getByTestId('clip').first().click()
  await page.getByTestId('verb-split').click()
  await expect(page.getByTestId('clip')).toHaveCount(2)

  await page.getByTestId('clip').nth(1).click()
  await page.getByTestId('verb-delete').click()
  await expect(page.getByTestId('clip')).toHaveCount(1)
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

test('there is nothing to compare until something is loaded', async ({
  page,
}) => {
  await page.getByTestId('project-new').click()
  await expect(page.getByTestId('show-original')).toHaveCount(0)
})

test('shows the footage as it arrived, and goes back', async ({ page }) => {
  const toggle = page.getByTestId('show-original')
  await expect(toggle).toHaveText('After')

  await toggle.click()
  await expect(toggle).toHaveText('Before')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  await toggle.click()
  await expect(toggle).toHaveText('After')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})

test('the timeline goes on showing the edit while the picture does not', async ({
  page,
}) => {
  // Looking at the original must not look like the edit has been undone.
  await page.getByTestId('clip').click()
  await page.getByTestId('verb-split').click()
  const clips = await page.getByTestId('clip').count()

  await page.getByTestId('show-original').click()
  await expect(page.getByTestId('clip')).toHaveCount(clips)
})

test('the time readout follows what is being shown', async ({ page }) => {
  // Cut the timeline down, then look at the original: the length shown is the
  // one belonging to the picture, or the comparison says nothing.
  await cutTheTail(page)

  const edited = await page.getByTestId('time').textContent()

  await page.getByTestId('show-original').click()
  await expect(page.getByTestId('time')).not.toHaveText(edited ?? '')
})

test('says how much shorter the edit is', async ({ page }) => {
  // The question this exists to answer, in numbers as well as in pictures.
  await expect(page.getByTestId('stage-compare')).toHaveCount(0)

  await cutTheTail(page)

  await expect(page.getByTestId('stage-compare')).toContainText(
    'shorter than the original',
  )
})

test('looking at the original changes nothing about the project', async ({
  page,
}) => {
  await page.getByTestId('clip').click()
  await page.getByTestId('verb-split').click()

  const before = await page.evaluate(() =>
    JSON.stringify(window.__timelineStore.getState().project),
  )
  const depth = await page.evaluate(
    () => window.__timelineStore.getState().past.length,
  )

  await page.getByTestId('show-original').click()

  expect(
    await page.evaluate(() =>
      JSON.stringify(window.__timelineStore.getState().project),
    ),
  ).toBe(before)
  expect(
    await page.evaluate(() => window.__timelineStore.getState().past.length),
  ).toBe(depth)
})
