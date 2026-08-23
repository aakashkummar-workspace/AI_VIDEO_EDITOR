import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_MUSIC } from './fixture.config.mjs'
import { openTab } from './inspector'

/**
 * Where the controls live.
 *
 * Nouns are in the columns and verbs are in the strip. The left column is what
 * the PROJECT is, the right column is what the SELECTION is, and the strip
 * between the picture and the timeline is what you can DO - to the selection,
 * or to the timeline. Nothing appears in two of them, or they would disagree
 * about which is the real one.
 *
 * Everything had been one scrolling column, which meant going past the media
 * list and the export settings to reach the clip you had just clicked.
 */

/** Which part of the layout a control is in, by its test id. */
async function columnOf(page: Page, testId: string): Promise<string> {
  return page.evaluate((id) => {
    const panel = document.querySelector(`[data-testid="${id}"]`)
    if (!panel) return 'absent'
    if (panel.closest('.inspector')) return 'inspector'
    if (panel.closest('.sidebar')) return 'sidebar'
    if (panel.closest('.actions')) return 'actions'
    return 'elsewhere'
  }, testId)
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

test('the project lives on the left', async ({ page }) => {
  for (const panel of ['export-panel', 'storage-panel']) {
    expect(await columnOf(page, panel), panel).toBe('sidebar')
  }
})

test('the selection lives on the right, one aspect per tab', async ({
  page,
}) => {
  await page.getByTestId('clip').click()

  // Each panel is behind exactly one tab. Six panels in one scroll is what the
  // tabs replaced, so a panel reachable from two of them would be the old
  // problem coming back.
  const home: Record<string, string> = {
    'transform-panel': 'clip',
    'compositing-panel': 'clip',
    'speed-panel': 'clip',
    'levels-panel': 'audio',
    'effects-panel': 'effects',
  }

  for (const [panel, tab] of Object.entries(home)) {
    await openTab(page, tab)
    expect(await columnOf(page, panel), panel).toBe('inspector')

    for (const other of ['clip', 'audio', 'effects']) {
      if (other === tab) continue
      await openTab(page, other)
      expect(await columnOf(page, panel), `${panel} under ${other}`).toBe(
        'absent',
      )
    }
  }
})

test('the verbs live in the strip, and nowhere else', async ({ page }) => {
  await page.getByTestId('clip').click()

  for (const verb of [
    'verb-split',
    'verb-duplicate',
    'verb-transition',
    'verb-delete',
    'add-overlay',
  ]) {
    expect(await columnOf(page, verb), verb).toBe('actions')
    // One button each. A verb duplicated into a column is two things that can
    // disagree about whether they are enabled.
    await expect(page.getByTestId(verb), verb).toHaveCount(1)
  }
})

test('the strip says what it is about to act on', async ({ page }) => {
  await expect(page.getByTestId('actions')).toContainText('Nothing selected')
  await expect(page.getByTestId('verb-split')).toBeDisabled()
  await expect(page.getByTestId('verb-delete')).toBeDisabled()

  await page.getByTestId('clip').click()
  await expect(page.getByTestId('actions-name')).toHaveText(
    FIXTURE.path.split('/').pop()!,
  )
  await expect(page.getByTestId('verb-split')).toBeEnabled()
  await expect(page.getByTestId('verb-delete')).toBeEnabled()
})

test('the inspector is empty until something is selected', async ({ page }) => {
  await expect(page.getByTestId('inspector-empty')).toBeVisible()
  expect(await columnOf(page, 'transform-panel')).toBe('absent')

  await page.getByTestId('clip').click()
  await expect(page.getByTestId('inspector-empty')).toHaveCount(0)
  await expect(page.getByTestId('transform-panel')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('inspector-empty')).toBeVisible()
})

test('adding text is a verb, styling it is not', async ({ page }) => {
  // Making a caption is something you DO, so it is in the strip, and it is
  // there whatever is selected - including a video clip.
  await page.getByTestId('clip').click()
  await expect(page.getByTestId('add-overlay')).toBeEnabled()
  await expect(page.getByTestId('caption-panel')).toHaveCount(0)

  // A caption's own fields are a property of a selection, so they exist only
  // once there is a caption selected, and then on the right.
  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)
  expect(await columnOf(page, 'caption-panel')).toBe('inspector')
})

test('a segment only offers what applies to it', async ({ page }) => {
  await page.setInputFiles('[data-testid=media-input]', FIXTURE_MUSIC.path)
  await expect(page.getByTestId('audio-block')).toHaveCount(1)

  // Sound has no picture to transform or composite, but it has a volume and a
  // speed - which is why "clip" is a tab anything can have. A rate on a piece
  // of music would be unreachable if the first tab were about the picture.
  await page.getByTestId('audio-block').click()
  await expect(page.getByTestId('tab-audio')).toBeVisible()
  await expect(page.getByTestId('tab-text')).toHaveCount(0)
  await expect(page.getByTestId('speed-panel')).toBeVisible()
  await expect(page.getByTestId('transform-panel')).toHaveCount(0)
  await expect(page.getByTestId('compositing-panel')).toHaveCount(0)
  await openTab(page, 'audio')
  await expect(page.getByTestId('levels-panel')).toBeVisible()

  // A caption has a look but no volume and no speed, so it is offered no Audio
  // tab at all rather than an empty one.
  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('tab-text')).toBeVisible()
  await expect(page.getByTestId('tab-audio')).toHaveCount(0)
  await expect(page.getByTestId('caption-panel')).toBeVisible()
  await openTab(page, 'clip')
  await expect(page.getByTestId('transform-panel')).toBeVisible()
  await expect(page.getByTestId('speed-panel')).toHaveCount(0)
})

test('a tab that stops applying is left rather than shown empty', async ({
  page,
}) => {
  await page.setInputFiles('[data-testid=media-input]', FIXTURE_MUSIC.path)
  await expect(page.getByTestId('audio-block')).toHaveCount(1)

  await page.getByTestId('audio-block').click()
  await openTab(page, 'audio')
  await expect(page.getByTestId('levels-panel')).toBeVisible()

  // A caption has no Audio tab. Selecting one while it is open has to land
  // somewhere real - and for a caption that is its own words, not whichever
  // tab happened to survive.
  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('tab-text')).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByTestId('overlay-text')).toBeVisible()

  // Going back to the music re-homes it: the Text tab is gone with the caption.
  await page.getByTestId('audio-block').click()
  await expect(page.getByTestId('tab-clip')).toHaveAttribute(
    'aria-selected',
    'true',
  )
})

test('a tab picked by hand survives an edit to the same segment', async ({
  page,
}) => {
  await page.getByTestId('clip').click()
  await page.getByTestId('tab-effects').click()
  await page.getByTestId('add-effect').selectOption({ index: 1 })

  // Re-homing on every change to the selection would throw you out of the tab
  // the moment you used it.
  await expect(page.getByTestId('tab-effects')).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByTestId('effects-panel')).toBeVisible()
})

test('the rows say what they are', async ({ page }) => {
  await expect(page.getByTestId('track-label')).toHaveCount(3)
  await expect(page.getByTestId('track-label').first()).toHaveText('text')
  await expect(page.getByTestId('track-label').last()).toHaveText('audio')
})

test('a row label does not sit on top of the blocks', async ({ page }) => {
  const label = (await page
    .getByTestId('track-label')
    .nth(1)
    .boundingBox())!
  const clip = (await page.getByTestId('clip').boundingBox())!

  // The label band is above the block, not over it.
  expect(label.y + label.height).toBeLessThanOrEqual(clip.y + 1)
})

test('the timeline stops growing rather than eating the picture', async ({
  page,
}) => {
  const canvasBefore = (await page.locator('.stage-canvas canvas').boundingBox())!

  for (let i = 0; i < 6; i++) {
    await page.getByTestId('add-video-track').click()
  }
  await expect(page.getByTestId('track')).toHaveCount(9)

  const dock = (await page.locator('.dock').boundingBox())!
  const viewport = page.viewportSize()!

  expect(dock.height).toBeLessThanOrEqual(viewport.height * 0.45)

  // The picture is still there and still a sensible size.
  const canvasAfter = (await page.locator('.stage-canvas canvas').boundingBox())!
  expect(canvasAfter.height).toBeGreaterThan(0)
  expect(canvasAfter.height).toBeLessThanOrEqual(canvasBefore.height)
})
