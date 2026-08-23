import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_MUSIC } from './fixture.config.mjs'
import { openTab } from './inspector'

/**
 * What survives closing the tab.
 *
 * Tested through a real reload rather than by calling the storage module,
 * because the thing worth proving is not that IndexedDB works - it is that the
 * timeline, its media and the worker all come back in a state that can be
 * played. Each Playwright test gets its own storage, so these start empty.
 */

function project(page: Page) {
  return page.evaluate(() => window.__timelineStore.getState().project)
}

/**
 * Waits for a save that happens AFTER this call.
 *
 * Waiting for "something has been saved" is not enough: after a reload the
 * restored project has already stamped a time, so a later edit would look
 * saved the moment it was made and the reload would race the debounce.
 */
async function waitForSave(page: Page) {
  const before = await page
    .getByTestId('storage-state')
    .getAttribute('data-saved-at')

  await expect
    .poll(() =>
      page.getByTestId('storage-state').getAttribute('data-saved-at'),
    )
    .not.toBe(before)
}

/**
 * Reloads and waits for the app to have finished restoring.
 *
 * Waiting for the panel to appear is not enough: restoring is asynchronous,
 * and the timeline is the empty starting one until it finishes.
 */
async function reload(page: Page) {
  await page.reload()
  await expect(page.getByTestId('storage-panel')).toHaveAttribute(
    'data-restored',
    'true',
  )
}

async function loadFixture(page: Page) {
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toHaveCount(1)
}

/** Whether the preview canvas has anything on it. */
async function canvasHasPicture(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    if (!canvas) return false
    const context = canvas.getContext('2d')
    if (!context) return false

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! > 0 || data[i + 1]! > 0 || data[i + 2]! > 0) return true
    }
    return false
  })
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
})

test('a fresh browser starts with nothing saved', async ({ page }) => {
  await expect(page.getByTestId('storage-state')).toContainText(
    'Nothing saved yet',
  )
  await expect(page.getByTestId('clip')).toHaveCount(0)
})

test('the timeline comes back after a reload', async ({ page }) => {
  await loadFixture(page)
  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)

  const before = await project(page)
  await waitForSave(page)

  await reload(page)

  await expect(page.getByTestId('clip')).toHaveCount(1)
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)
  expect(await project(page)).toEqual(before)
})

test('the media comes back too, with nothing to re-pick', async ({ page }) => {
  await loadFixture(page)
  await waitForSave(page)
  await reload(page)

  // Nothing is offline, so there is no relinking panel at all.
  await expect(page.getByTestId('offline-panel')).toHaveCount(0)
  await expect(page.getByTestId('media-item')).toHaveCount(1)
})

test('the restored project can actually be played', async ({ page }) => {
  await loadFixture(page)
  await waitForSave(page)
  await reload(page)

  // The worker was handed the file again, so a seek produces a picture.
  await page.getByTestId('timeline').click({ position: { x: 120, y: 30 } })
  await expect.poll(() => canvasHasPicture(page)).toBe(true)

  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled()
})

test('edits made after a reload are saved in their turn', async ({ page }) => {
  await loadFixture(page)
  await waitForSave(page)
  await reload(page)

  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)
  const after = await project(page)
  await waitForSave(page)

  await reload(page)
  expect(await project(page)).toEqual(after)
})

test('a project with several sources comes back whole', async ({ page }) => {
  await loadFixture(page)
  await page.setInputFiles('[data-testid=media-input]', FIXTURE_MUSIC.path)
  await expect(page.getByTestId('audio-block')).toHaveCount(1)

  const before = await project(page)
  await waitForSave(page)
  await reload(page)

  expect(await project(page)).toEqual(before)
  await expect(page.getByTestId('clip')).toHaveCount(1)
  await expect(page.getByTestId('audio-block')).toHaveCount(1)
  await expect(page.getByTestId('offline-panel')).toHaveCount(0)
})

test('everything a project carries survives, not just the segments', async ({
  page,
}) => {
  await loadFixture(page)
  await page.getByTestId('clip').click()

  await page.getByTestId('transform-scale').fill('0.5')
  await page.getByTestId('blend-mode').selectOption('multiply')
  await page.getByTestId('mask-shape').selectOption('ellipse')
  await openTab(page, 'effects')
  await page.getByTestId('add-effect').selectOption('grayscale')
  await openTab(page, 'clip')
  await page.getByTestId('rate-2').click()
  await page.getByTestId('export-height').selectOption('720')

  const before = await project(page)
  await waitForSave(page)
  await reload(page)

  expect(await project(page)).toEqual(before)
})

test('clearing throws it away, and the next visit starts empty', async ({
  page,
}) => {
  await loadFixture(page)
  await waitForSave(page)

  await page.getByTestId('clear-storage').click()
  await expect(page.getByTestId('storage-state')).toContainText(
    'Nothing saved yet',
  )

  await reload(page)
  await expect(page.getByTestId('clip')).toHaveCount(0)
})

test('an unreadable autosave opens empty rather than refusing to open', async ({
  page,
}) => {
  await loadFixture(page)
  await waitForSave(page)

  // Corrupt the stored draft in the way a future version might.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('video-editor')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('project', 'readwrite')
      tx.objectStore('project').put(
        { savedAt: Date.now(), draft: { kind: 'video-editor-draft', version: 99 } },
        'current',
      )
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })

  await reload(page)

  // Empty, usable, and no error shouted at the user.
  await expect(page.getByTestId('clip')).toHaveCount(0)
  await expect(page.locator('.status-error')).toHaveCount(0)
  await expect(page.getByTestId('media-input')).toBeVisible()
})

test('the empty starting state never overwrites what is stored', async ({
  page,
}) => {
  await loadFixture(page)
  const before = await project(page)
  await waitForSave(page)

  // The race this guards: on reload the store is empty for a moment before
  // the saved project arrives, and an autosave fired then would erase it.
  await reload(page)
  await page.waitForTimeout(1200)

  await reload(page)
  expect(await project(page)).toEqual(before)
})

test('reports how much room the saved data is taking', async ({ page }) => {
  await loadFixture(page)
  await waitForSave(page)

  await expect(page.getByTestId('storage-usage')).toContainText('MB of')
})
