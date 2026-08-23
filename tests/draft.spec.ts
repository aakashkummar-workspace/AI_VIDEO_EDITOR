import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

/**
 * Saving and reopening a project, through the real app rather than the model.
 *
 * The interesting half is what a draft CANNOT carry: the media. A reopened
 * draft has a complete timeline and no files, and has to say so rather than
 * quietly rendering black.
 */

const SECOND = 1_000_000

function project(page: Page) {
  return page.evaluate(() => window.__timelineStore.getState().project)
}

function undoDepth(page: Page) {
  return page.evaluate(() => window.__timelineStore.getState().past.length)
}

/** Clicks Save and returns the text of the file it downloads. */
async function save(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('save-draft').click(),
  ])

  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Hands the Open control a draft with this text. */
async function open(page: Page, text: string, name = 'timeline.draft.json') {
  await page.getByTestId('open-draft').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  })
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/')

  // A timeline worth saving: a clip, a caption, a transform and an effect.
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toBeVisible()

  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)

  await page.getByTestId('clip').click()
  await page.getByTestId('transform-scale').fill('0.5')
  await page.getByTestId('add-effect').selectOption('grayscale')
  await expect(page.getByTestId('effect-row')).toHaveCount(1)
})

test('a saved draft is the project, and says what wrote it', async ({
  page,
}) => {
  const text = await save(page)
  const draft = JSON.parse(text)

  expect(draft.kind).toBe('video-editor-draft')
  expect(draft.version).toBe(1)
  expect(draft.project).toEqual(await project(page))
})

test('reopening a draft restores the timeline it was saved from', async ({
  page,
}) => {
  const before = await project(page)
  const text = await save(page)

  await open(page, text)
  await expect(page.getByTestId('offline-panel')).toBeVisible()

  expect(await project(page)).toEqual(before)
})

test('a reopened draft starts with an empty undo history', async ({ page }) => {
  expect(await undoDepth(page)).toBeGreaterThan(0)

  await open(page, await save(page))
  await expect(page.getByTestId('offline-panel')).toBeVisible()

  // Undoing across a file being opened is not what undo means.
  expect(await undoDepth(page)).toBe(0)
})

test('a reopened draft lists its media as needing to be relinked', async ({
  page,
}) => {
  await open(page, await save(page))

  await expect(page.getByTestId('offline-item')).toHaveCount(1)
  await expect(page.getByTestId('offline-name')).toHaveText(
    FIXTURE.path.split('/').pop()!,
  )
})

test('handing the file back clears the warning and plays again', async ({
  page,
}) => {
  await open(page, await save(page))
  await expect(page.getByTestId('offline-panel')).toBeVisible()

  await page.getByTestId('relink-input').setInputFiles(FIXTURE.path)

  await expect(page.getByTestId('offline-panel')).toHaveCount(0)
  await expect(page.getByTestId('clip')).toBeVisible()

  // The timeline is whole again, so the transport is usable.
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled()
})

test('relinking refuses a file too short for the timeline', async ({ page }) => {
  // Trim the clip to the whole source first, then claim a longer one in the
  // draft than the file can supply.
  const text = await save(page)
  const draft = JSON.parse(text)
  const source = Object.values(draft.project.sources)[0] as {
    durationMicros: number
  }
  source.durationMicros = 60 * SECOND

  const videoTrack = draft.project.tracks.find(
    (track: { kind: string }) => track.kind === 'video',
  )
  videoTrack.segments[0].content.sourceOutMicros = 60 * SECOND

  await open(page, JSON.stringify(draft))
  await expect(page.getByTestId('offline-panel')).toBeVisible()

  await page.getByTestId('relink-input').setInputFiles(FIXTURE.path)

  await expect(page.locator('.status-error')).toContainText('too short')
  // And it stays offline rather than half-linking.
  await expect(page.getByTestId('offline-panel')).toBeVisible()
})

test('a draft that cannot be read says why and leaves the timeline alone', async ({
  page,
}) => {
  const before = await project(page)

  await open(page, '{ "kind": "something-else" }')

  await expect(page.locator('.status-error')).toContainText(
    'not a project file',
  )
  expect(await project(page)).toEqual(before)
})

test('a draft from a newer version is refused rather than guessed at', async ({
  page,
}) => {
  const draft = JSON.parse(await save(page))
  draft.version = 99

  await open(page, JSON.stringify(draft))

  await expect(page.locator('.status-error')).toContainText('newer version')
})
