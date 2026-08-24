import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

/**
 * The action strip.
 *
 * Split and Delete were keyboard-only, which meant the two commonest edits in
 * the application were invisible unless you had read the shortcut list. These
 * are the same operations the keys run - not a second implementation - so what
 * matters here is that each verb reaches the right one, and that a verb with
 * nothing to act on is disabled rather than a no-op you can click.
 */

async function clipCount(page: Page) {
  return page.getByTestId('clip').count()
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

test('every verb is dead until something is selected', async ({ page }) => {
  for (const verb of [
    'verb-split',
    'verb-duplicate',
    'verb-delete',
    'verb-transition',
  ]) {
    await expect(page.getByTestId(verb), verb).toBeDisabled()
  }

  // Add text is the exception: it makes a selection rather than needing one.
  await expect(page.getByTestId('add-overlay')).toBeEnabled()
})

test('Split cuts at the playhead', async ({ page }) => {
  await page.getByTestId('clip').click()
  expect(await clipCount(page)).toBe(1)

  // Somewhere inside the clip, so the cut lands on both sides of the playhead.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.getByTestId('verb-split').click()

  expect(await clipCount(page)).toBe(2)
})

test('Delete removes what the strip named, and clears the strip', async ({
  page,
}) => {
  await page.getByTestId('clip').click()
  await expect(page.getByTestId('actions-name')).toHaveText(
    FIXTURE.path.split('/').pop()!,
  )

  await page.getByTestId('verb-delete').click()

  expect(await clipCount(page)).toBe(0)
  // The strip must not go on naming a segment that is gone, or the next click
  // on a verb would act on nothing.
  await expect(page.getByTestId('actions')).toContainText('Nothing selected')
  await expect(page.getByTestId('verb-delete')).toBeDisabled()
})

test('Duplicate puts the copy straight after the original', async ({
  page,
}) => {
  await page.getByTestId('clip').click()
  const original = (await page.getByTestId('clip').boundingBox())!

  await page.getByTestId('verb-duplicate').click()
  await expect(page.getByTestId('clip')).toHaveCount(2)

  const copy = (await page.getByTestId('clip').nth(1).boundingBox())!
  // Butted up against it, and the same length - a copy is not a trim.
  expect(copy.x).toBeCloseTo(original.x + original.width, 0)
  expect(copy.width).toBeCloseTo(original.width, 0)
})

test('Duplicate makes room rather than overlapping', async ({ page }) => {
  await page.getByTestId('add-to-timeline').click()
  await expect(page.getByTestId('clip')).toHaveCount(2)

  const before = await page.getByTestId('time').textContent()

  await page.getByTestId('clip').first().click()
  await page.getByTestId('verb-duplicate').click()
  await expect(page.getByTestId('clip')).toHaveCount(3)

  // A packed row has no room for a copy, so the project gets longer by its
  // length and the clip that was second is now third.
  const after = await page.getByTestId('time').textContent()
  expect(after).not.toBe(before)

  const boxes = await page.getByTestId('clip').all()
  const rects = await Promise.all(boxes.map((box) => box.boundingBox()))
  for (let i = 1; i < rects.length; i++) {
    expect(rects[i]!.x).toBeGreaterThanOrEqual(
      rects[i - 1]!.x + rects[i - 1]!.width - 1,
    )
  }
})

test('Transition needs a cut to blend across', async ({ page }) => {
  // One clip has nothing before it, so there is no cut and no transition.
  await page.getByTestId('clip').click()
  await expect(page.getByTestId('verb-transition')).toBeDisabled()

  await page.getByTestId('add-to-timeline').click()
  await expect(page.getByTestId('clip')).toHaveCount(2)

  await page.getByTestId('clip').first().click()
  await expect(page.getByTestId('verb-transition')).toBeDisabled()

  await page.getByTestId('clip').nth(1).click()
  await expect(page.getByTestId('verb-transition')).toBeEnabled()
})

test('Transition is a toggle, and agrees with the panel', async ({ page }) => {
  await page.getByTestId('add-to-timeline').click()
  await expect(page.getByTestId('clip')).toHaveCount(2)
  await page.getByTestId('clip').nth(1).click()

  await page.getByTestId('verb-transition').click()

  // The verb applies one; WHICH kind it is stays a field, and the field has to
  // show what the verb did rather than its own idea of the default.
  await expect(page.getByTestId('transition-kind')).toHaveValue('crossfade')
  await expect(page.getByTestId('verb-transition')).toHaveClass(/is-current/)

  await page.getByTestId('verb-transition').click()
  await expect(page.getByTestId('transition-kind')).toHaveValue('none')
  await expect(page.getByTestId('verb-transition')).not.toHaveClass(
    /is-current/,
  )
})

test('a verb is one undo step, like the key it stands for', async ({ page }) => {
  await page.getByTestId('clip').click()
  await page.keyboard.press('ArrowRight')
  await page.getByTestId('verb-split').click()
  expect(await clipCount(page)).toBe(2)

  await page.keyboard.press('Control+z')
  expect(await clipCount(page)).toBe(1)
})

test('Trim silence declines when there is nothing to cut', async ({ page }) => {
  // The fixtures carry a continuous tone from end to end - there is no silence
  // in any of them - so this is the case the committed media can actually
  // prove: the verb must decline rather than cut something arbitrary.
  await page.getByTestId('clip').click()

  await expect(page.getByTestId('verb-trim-silence')).toBeDisabled()
  await expect(page.getByTestId('verb-trim-silence')).toHaveAttribute(
    'title',
    /No silence worth cutting/,
  )
})

test('Trim silence is dead until something with sound is selected', async ({
  page,
}) => {
  await expect(page.getByTestId('verb-trim-silence')).toBeDisabled()

  // A caption makes no sound, so there is nothing to trim out of it.
  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)
  await expect(page.getByTestId('verb-trim-silence')).toBeDisabled()
})
