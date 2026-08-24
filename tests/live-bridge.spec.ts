import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

/**
 * Editing the open timeline from outside the browser.
 *
 * An agent at a terminal cannot reach into a page, so the page publishes what
 * it is showing and listens for plans coming back. Nothing here is stubbed:
 * these drive the real dev-server endpoints, because the bridge IS the feature
 * and a stubbed one would prove nothing.
 *
 * There is no model involved and no key - the calls name tools directly. That
 * is the point of it: it works on a machine with no API credits at all.
 */

const EDIT = '/api/live/edit'

function historyDepth(page: Page) {
  return page.evaluate(() => window.__timelineStore.getState().past.length)
}

function segmentIds(page: Page) {
  return page.evaluate(() =>
    window.__timelineStore
      .getState()
      .project.tracks.flatMap((track) => track.segments.map((s) => s.id)),
  )
}

/**
 * Waits until the server holds a timeline containing every id given.
 *
 * The page publishes on its own schedule, so asking for an edit the instant
 * something appears on screen can dispatch against the timeline as it was a
 * moment earlier. An agent hits the same race; it just gets a refusal rather
 * than a wrong edit.
 */
async function publishedWith(page: Page, ids: string[] = []) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/live/project')
        if (!response.ok()) return false

        const project = await response.json()
        const known: string[] = project.tracks.flatMap(
          (track: { segments: { id: string }[] }) =>
            track.segments.map((segment) => segment.id),
        )
        return ids.every((id) => known.includes(id))
      },
      { timeout: 5000 },
    )
    .toBe(true)
}

async function edit(
  page: Page,
  calls: { tool: string; args: Record<string, unknown> }[],
  note?: string,
) {
  return page.request.post(EDIT, { data: { calls, note } })
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

  // Every test below names segments, so none of them can start until the
  // server has been told what is on the timeline.
  await publishedWith(page, await segmentIds(page))
})

test('an edit asked for outside the browser lands inside it', async ({
  page,
}) => {
  const response = await edit(page, [
    { tool: 'split_segment', args: { atSeconds: 2 } },
  ])
  expect(response.ok()).toBe(true)

  await expect(page.getByTestId('clip')).toHaveCount(2)
})

test('a run from outside is one undo step, like any other', async ({ page }) => {
  // Whatever asked for it, an edit somebody wants to reject has to go back in
  // one keystroke - the rule does not soften because the request came by socket.
  await edit(page, [{ tool: 'split_segment', args: { atSeconds: 2 } }])
  await expect(page.getByTestId('clip')).toHaveCount(2)
  await publishedWith(page, await segmentIds(page))

  const depthBefore = await historyDepth(page)

  await edit(page, [
    { tool: 'split_segment', args: { atSeconds: 4 } },
    {
      tool: 'add_text',
      args: { text: 'from outside', startSeconds: 0, durationSeconds: 1 },
    },
  ])

  await expect(page.getByTestId('clip')).toHaveCount(3)
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)
  expect(await historyDepth(page)).toBe(depthBefore + 1)

  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('clip')).toHaveCount(2)
  await expect(page.getByTestId('overlay-block')).toHaveCount(0)
})

test('the timeline it publishes is the one being edited', async ({ page }) => {
  // The ids in the published outline have to be the ids the edit can name, or
  // nothing outside could refer to anything.
  const [first] = await segmentIds(page)
  expect(first).toBeTruthy()

  const response = await edit(page, [
    { tool: 'set_speed', args: { segmentId: first, rate: 2 } },
  ])
  expect(response.ok()).toBe(true)

  const rate = await page.evaluate((id) => {
    for (const track of window.__timelineStore.getState().project.tracks) {
      const found = track.segments.find((s) => s.id === id)
      if (found) return found.rate
    }
    return null
  }, first!)

  expect(rate).toBe(2)
})

test('an edit the timeline refuses is reported, not half applied', async ({
  page,
}) => {
  await edit(page, [{ tool: 'split_segment', args: { atSeconds: 2 } }])
  await expect(page.getByTestId('clip')).toHaveCount(2)
  await publishedWith(page, await segmentIds(page))

  const depthBefore = await historyDepth(page)

  // The first call is fine, the second names a segment that is not there. The
  // whole run has to fail on the server, before the page is told anything.
  const response = await page.request.post(EDIT, {
    data: {
      calls: [
        { tool: 'split_segment', args: { atSeconds: 4 } },
        { tool: 'set_speed', args: { segmentId: 'no-such-segment', rate: 2 } },
      ],
    },
  })

  expect(response.status()).toBe(400)
  expect(await response.text()).toContain('no-such-segment')

  await expect(page.getByTestId('clip')).toHaveCount(2)
  expect(await historyDepth(page)).toBe(depthBefore)
})

test('an unknown tool is refused by name', async ({ page }) => {
  const response = await page.request.post(EDIT, {
    data: { calls: [{ tool: 'render_masterpiece', args: {} }] },
  })

  expect(response.status()).toBe(400)
  expect(await response.text()).toContain('render_masterpiece')
})

test('an edit reaches only the page it was meant for', async ({
  page,
  browser,
}) => {
  // This is the bug that wrote a caption into somebody's real project: the dev
  // socket reaches EVERY page, so an unaddressed plan is applied by all of them
  // - including a browser running this suite against the same server.
  const other = await browser.newContext()
  const second = await other.newPage()

  try {
    await second.goto('/')
    await expect(second.getByTestId('storage-panel')).toHaveAttribute(
      'data-restored',
      'true',
    )
    await second.setInputFiles('[data-testid=media-input]', FIXTURE.path)
    await expect(second.getByTestId('clip')).toBeVisible()

    // The second page published last, so the edit belongs to it.
    await publishedWith(second, await segmentIds(second))

    const response = await second.request.post(EDIT, {
      data: { calls: [{ tool: 'split_segment', args: { atSeconds: 2 } }] },
    })
    expect(response.ok()).toBe(true)

    await expect(second.getByTestId('clip')).toHaveCount(2)

    // The first page loaded the same file and is still connected. It must not
    // have moved.
    await expect(page.getByTestId('clip')).toHaveCount(1)
  } finally {
    await other.close()
  }
})
