import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_TONES } from './fixture.config.mjs'

/**
 * More than one piece of work.
 *
 * The editor used to have exactly one autosave slot. These prove the several
 * that replaced it stay apart: a name belongs to its own project, a timeline
 * does not leak into the next one, and coming back opens whatever was last
 * being looked at.
 */

async function restored(page: Page) {
  await expect(page.getByTestId('storage-panel')).toHaveAttribute(
    'data-restored',
    'true',
  )
}

async function savedAt(page: Page) {
  return Number(
    (await page.getByTestId('storage-state').getAttribute('data-saved-at')) ?? 0,
  )
}

/**
 * Waits for an autosave that STARTED after `since`.
 *
 * Comparing against the previous value is not enough: the very first save
 * happens on its own shortly after the page opens, and a test that only waited
 * for "a different number" would be satisfied by that one and carry on before
 * its own change had been written.
 */
async function savedAfter(page: Page, since: number) {
  await expect.poll(() => savedAt(page), { timeout: 10_000 }).toBeGreaterThan(since)
}

/** The page's own clock, which is the one `data-saved-at` is stamped from. */
function now(page: Page) {
  return page.evaluate(() => Date.now())
}

/**
 * Names the project and waits for the autosave that carries the new name.
 *
 * Waiting matters: the list shows a STORED name for every project but the open
 * one, so switching away before the write lands would find the old name.
 */
async function nameProject(page: Page, name: string) {
  const before = await now(page)
  await page.getByTestId('project-name').fill(name)
  await page.getByTestId('project-name').blur()
  await savedAfter(page, before)

  // An autosave from something else can satisfy the wait above, so the field is
  // checked too: pressing New and typing straight into it used to lose the name.
  await expect(page.getByTestId('project-name')).toHaveValue(name)
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/')
  await restored(page)
})

test('a project can be named, and keeps its name across a reload', async ({
  page,
}) => {
  await nameProject(page, 'Wedding film')

  await page.reload()
  await restored(page)
  await expect(page.getByTestId('project-name')).toHaveValue('Wedding film')
})

test('a new project starts empty and leaves the first one alone', async ({
  page,
}) => {
  await page.getByTestId('project-name').fill('First')
  await page.getByTestId('project-name').blur()
  const beforeClip = await now(page)
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toHaveCount(1)
  await savedAfter(page, beforeClip)

  await page.getByTestId('project-new').click()

  // Empty: a new piece of work is not the old one with a different name.
  await expect(page.getByTestId('project-name')).toHaveValue('Untitled')
  await expect(page.getByTestId('clip')).toHaveCount(0)

  // And the first is still there, still with its clip.
  await expect(page.getByTestId('project-list')).toBeVisible()
  await page
    .getByTestId('project-item')
    .filter({ hasText: 'First' })
    .getByTestId('project-open')
    .click()

  await expect(page.getByTestId('project-name')).toHaveValue('First')
  await expect(page.getByTestId('clip')).toHaveCount(1)
})

test('the one that was open is the one that comes back', async ({ page }) => {
  await nameProject(page, 'First')

  await page.getByTestId('project-new').click()
  await nameProject(page, 'Second')

  await page.reload()
  await restored(page)
  await expect(page.getByTestId('project-name')).toHaveValue('Second')
})

test('one project has no list, because there is nothing to choose between', async ({
  page,
}) => {
  await expect(page.getByTestId('project-list')).toHaveCount(0)

  const before = await now(page)
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toHaveCount(1)
  await savedAfter(page, before)

  await page.getByTestId('project-new').click()
  await expect(page.getByTestId('project-list')).toBeVisible()
  await expect(page.getByTestId('project-item')).toHaveCount(2)
})

test('an untouched project is not kept when you start another', async ({
  page,
}) => {
  // An empty editor is not work. Keeping it would put a blank project in the
  // list every time somebody pressed New, and make a fresh browser look like it
  // already had something in it.
  await page.getByTestId('project-new').click()
  await expect(page.getByTestId('project-list')).toHaveCount(0)
})

test('work is kept when you start another, even before the autosave', async ({
  page,
}) => {
  // The autosave is debounced. A project edited and then left inside that
  // window has never been written, and switching away would lose it.
  await nameProject(page, 'Has a clip')
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toHaveCount(1)

  // Deliberately no wait: this is the race the keeping exists for.
  await page.getByTestId('project-new').click()
  await expect(page.getByTestId('clip')).toHaveCount(0)

  await page
    .getByTestId('project-item')
    .filter({ hasText: 'Has a clip' })
    .getByTestId('project-open')
    .click()

  await expect(page.getByTestId('clip')).toHaveCount(1)
})

test('deleting the open project opens another rather than nothing', async ({
  page,
}) => {
  await nameProject(page, 'Keep me')
  const before = await now(page)
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toHaveCount(1)
  await savedAfter(page, before)

  await page.getByTestId('project-new').click()
  await nameProject(page, 'Delete me')

  await page
    .getByTestId('project-item')
    .filter({ hasText: 'Delete me' })
    .getByTestId('project-remove')
    .click()

  await expect(page.getByTestId('project-name')).toHaveValue('Keep me')
  await expect(page.getByTestId('project-item')).toHaveCount(0)
})

test('an empty name falls back rather than being kept', async ({ page }) => {
  await page.getByTestId('project-name').fill('   ')
  await page.getByTestId('project-name').blur()
  await expect(page.getByTestId('project-name')).toHaveValue('Untitled')
})

test('which project is open never enters the timeline', async ({ page }) => {
  // A preference about this browser, like the theme: two tabs may reasonably
  // have different projects open.
  await nameProject(page, 'Wedding film')

  const saved = await page.evaluate(() =>
    JSON.stringify(window.__timelineStore.getState().project),
  )
  expect(saved).not.toContain('Wedding film')
})

test('a name typed straight after New is not lost', async ({ page }) => {
  // Creating a project writes to the database. If the switch waited on that,
  // there is a window where the new project is open but the name field still
  // belongs to the old one - and anything typed into it is wiped when the write
  // finishes. The switch is synchronous for exactly this reason.
  await page.getByTestId('project-new').click()
  await page.getByTestId('project-name').fill('Typed immediately')
  await page.getByTestId('project-name').blur()

  await expect(page.getByTestId('project-name')).toHaveValue('Typed immediately')
})

test('a transcript follows the FILE, not the project it was made in', async ({
  page,
}) => {
  // A sourceId is minted per import, so the same footage in a second project
  // has a different one. Keying what was measured by that would make a
  // transcript somebody waited minutes for look lost the moment they switched.
  let asked = 0
  await page.route('**/api/transcribe*', async (route) => {
    asked++
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        language: 'en',
        duration: 6,
        text: 'first line',
        segments: [{ start: 1, end: 2, text: 'first line', words: [] }],
      }),
    })
  })

  await nameProject(page, 'First')
  await page.setInputFiles('[data-testid=media-input]', FIXTURE_TONES.path)
  await expect(page.getByTestId('waveform')).toBeVisible()
  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()
  expect(asked).toBe(1)

  // A second project, the same file off disk, a brand new sourceId.
  await page.getByTestId('project-new').click()
  await nameProject(page, 'Second')
  await page.setInputFiles('[data-testid=media-input]', FIXTURE_TONES.path)
  await expect(page.getByTestId('clip')).toHaveCount(1)
  await page.getByTestId('clip').click()

  // Already known, without asking again.
  await expect(page.getByTestId('script-panel')).toBeVisible()
  await expect(page.getByTestId('script-line')).toHaveCount(1)
  expect(asked).toBe(1)
})

test('switching back to a project brings its transcript with it', async ({
  page,
}) => {
  await page.route('**/api/transcribe*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        language: 'en',
        duration: 6,
        text: 'first line',
        segments: [{ start: 1, end: 2, text: 'first line', words: [] }],
      }),
    })
  })

  await nameProject(page, 'Has words')
  await page.setInputFiles('[data-testid=media-input]', FIXTURE_TONES.path)
  await expect(page.getByTestId('waveform')).toBeVisible()
  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()

  await page.getByTestId('project-new').click()
  await expect(page.getByTestId('clip')).toHaveCount(0)

  await page
    .getByTestId('project-item')
    .filter({ hasText: 'Has words' })
    .getByTestId('project-open')
    .click()

  await page.getByTestId('clip').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()
})

test('a clip still plays after switching away and back', async ({ page }) => {
  // The worker used to drop the FILE for every source the incoming project did
  // not name. Switching projects names entirely different sources, so coming
  // back left the timeline with nothing to decode from - and the main thread
  // still believed the file was there, so the relink panel never offered to
  // help. What you got was a raw error with a uuid in it.
  await nameProject(page, 'First')
  const before = await now(page)
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toHaveCount(1)
  await savedAfter(page, before)

  await page.getByTestId('project-new').click()
  await expect(page.getByTestId('clip')).toHaveCount(0)

  await page
    .getByTestId('project-item')
    .filter({ hasText: 'First' })
    .getByTestId('project-open')
    .click()
  await expect(page.getByTestId('clip')).toHaveCount(1)

  // Seeking makes the worker decode, which is what actually needs the file.
  await page.getByTestId('timeline').click({ position: { x: 40, y: 10 } })

  await expect(page.getByTestId('stage-error')).toHaveCount(0)
  await expect(page.getByTestId('offline-panel')).toHaveCount(0)
})

test('switching projects does not strand the one being left', async ({
  page,
}) => {
  // Two projects, each with the same footage under its own source id. Neither
  // may take the other's file away.
  await nameProject(page, 'First')
  const before = await now(page)
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toHaveCount(1)
  await savedAfter(page, before)

  await page.getByTestId('project-new').click()
  await nameProject(page, 'Second')
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toHaveCount(1)

  for (const name of ['First', 'Second', 'First']) {
    await page
      .getByTestId('project-item')
      .filter({ hasText: name })
      .getByTestId('project-open')
      .click()
    await expect(page.getByTestId('clip')).toHaveCount(1)
    await expect(page.getByTestId('stage-error')).toHaveCount(0)
  }
})
