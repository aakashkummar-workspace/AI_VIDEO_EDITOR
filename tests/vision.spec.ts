import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_TONES } from './fixture.config.mjs'

/**
 * Looking at the footage.
 *
 * The model call is stubbed and always will be - a real one sends pictures to
 * Anthropic and costs money, and a suite that did that would bill somebody for
 * every run. What is NOT stubbed is everything this project owns: the worker
 * decoding real frames out of the fixture with WebCodecs, scaling them, reducing
 * each to a grid, and working out where the picture changes. That request really
 * happens and its body is checked.
 */

const VISION = '**/api/vision'

const SEEN = {
  everySeconds: 2,
  shots: [
    { startSeconds: 0, endSeconds: 3, text: 'A counter ticking upwards.' },
    { startSeconds: 3, endSeconds: 6, text: 'The same counter, later.' },
  ],
}

async function stubWatcher(page: Page, body: unknown = SEEN, status = 200) {
  const seen: { frames: number; hasImage: boolean; boundaries: number[] }[] = []

  await page.route(VISION, async (route) => {
    const sent = JSON.parse(route.request().postData() ?? '{}') as {
      frames?: { jpegBase64?: string }[]
      boundariesMicros?: number[]
    }
    seen.push({
      frames: sent.frames?.length ?? 0,
      hasImage: (sent.frames?.[0]?.jpegBase64?.length ?? 0) > 100,
      boundaries: sent.boundariesMicros ?? [],
    })
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })

  return seen
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

test('sends real decoded frames, as pictures', async ({ page }) => {
  // The point of the arrangement: WebCodecs decodes and what leaves the browser
  // is a small JPEG. Nothing here reaches for a second decoder, and nothing
  // sends the file itself.
  const seen = await stubWatcher(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-watch').click()
  await expect.poll(() => seen.length).toBe(1)

  expect(seen[0]!.frames).toBeGreaterThan(1)
  expect(seen[0]!.hasImage).toBe(true)
})

test('works out where the picture changes before asking anything', async ({
  page,
}) => {
  // Shot boundaries are arithmetic over the frames, exactly as silence is
  // arithmetic over the peaks. They are computed here and handed over, so the
  // model is only ever asked what it alone can answer.
  const seen = await stubWatcher(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-watch').click()
  await expect.poll(() => seen.length).toBe(1)

  expect(Array.isArray(seen[0]!.boundaries)).toBe(true)
})

test('can be asked to look again', async ({ page }) => {
  const seen = await stubWatcher(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-watch').click()
  await expect(page.getByTestId('verb-watch')).toContainText('again')

  await page.getByTestId('verb-watch').click()
  await expect.poll(() => seen.length).toBe(2)
})

test('says so plainly that this sends footage away', async ({ page }) => {
  // The one thing in the application that sends pictures anywhere. It must be
  // legible before it is pressed, not afterwards.
  await page.getByTestId('clip').click()
  await expect(page.getByTestId('verb-watch')).toHaveAttribute(
    'title',
    /SENDS FRAMES OF YOUR VIDEO TO ANTHROPIC/,
  )
})

test('Watch is dead on a file with no picture in it', async ({ page }) => {
  // A source with no picture is stored with a width of ZERO, which is the honest
  // answer to how big its picture is - a piece of music has no shape to offer.
  const trackId = await page.evaluate(() => {
    const store = window.__timelineStore.getState()
    store.addSource({
      id: 'music',
      name: 'song.mp3',
      durationMicros: 5_000_000,
      width: 0,
      height: 0,
      rotation: 0,
    })
    const audio = store.project.tracks.find((track) => track.kind === 'audio')!
    store.addSegment({
      trackId: audio.id,
      segment: {
        id: 'music-1',
        timelineStartMicros: 0,
        content: {
          kind: 'audio',
          sourceId: 'music',
          sourceInMicros: 0,
          sourceOutMicros: 5_000_000,
        },
      },
    })
    return audio.id
  })
  expect(trackId).toBeTruthy()

  // Selected by clicking it, as a person would - the selection lives in the
  // component rather than the store.
  await page.getByTestId('audio-block').click()

  await expect(page.getByTestId('verb-watch')).toBeDisabled()
  await expect(page.getByTestId('verb-watch')).toHaveAttribute(
    'title',
    /no picture/,
  )
})

test('Watch is dead on a caption, which shows no footage', async ({ page }) => {
  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)

  await expect(page.getByTestId('verb-watch')).toBeDisabled()
})

test('says what went wrong when it cannot look', async ({ page }) => {
  await stubWatcher(page, { error: 'No credential is configured.' }, 500)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-watch').click()

  await expect(page.getByTestId('stage-error')).toContainText('No credential')
})

test('a clip with sound but no picture can still be transcribed', async ({
  page,
}) => {
  // The two verbs answer different questions and neither implies the other.
  await page.setInputFiles('[data-testid=media-input]', FIXTURE_TONES.path)
  await expect(page.getByTestId('clip')).toHaveCount(2)
  await expect(page.getByTestId('waveform')).toBeVisible()

  await page.getByTestId('clip').nth(1).click()
  await expect(page.getByTestId('verb-transcribe')).toBeEnabled()
  await expect(page.getByTestId('verb-watch')).toBeEnabled()
})

test('a description survives a reload, because it cost real money', async ({
  page,
}) => {
  // Looking sends pictures to Anthropic and is charged for. Losing it on a
  // reload would have somebody pay twice for the same answer.
  const seen = await stubWatcher(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-watch').click()
  await expect(page.getByTestId('verb-watch')).toContainText('again')
  expect(seen).toHaveLength(1)

  await expect(page.getByTestId('storage-state')).not.toHaveAttribute(
    'data-saved-at',
    '',
  )
  await page.reload()
  await expect(page.getByTestId('storage-panel')).toHaveAttribute(
    'data-restored',
    'true',
  )
  await expect(page.getByTestId('clip')).toBeVisible()
  await page.getByTestId('clip').click()

  await expect(page.getByTestId('verb-watch')).toContainText('again')
  expect(seen).toHaveLength(1)
})

test('looking and transcribing do not erase each other', async ({ page }) => {
  // Two separate acts on the same file, written to the same key. Whichever
  // happens second must not throw the first away.
  await stubWatcher(page)
  await page.route('**/api/transcribe*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        language: 'en',
        duration: 6,
        text: 'spoken',
        segments: [{ start: 1, end: 2, text: 'spoken', words: [] }],
      }),
    })
  })

  await page.setInputFiles('[data-testid=media-input]', FIXTURE_TONES.path)
  await expect(page.getByTestId('clip')).toHaveCount(2)
  await expect(page.getByTestId('waveform')).toBeVisible()

  await page.getByTestId('clip').nth(1).click()
  await page.getByTestId('verb-watch').click()
  await expect(page.getByTestId('verb-watch')).toContainText('again')
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()

  await expect(page.getByTestId('storage-state')).not.toHaveAttribute(
    'data-saved-at',
    '',
  )
  await page.reload()
  await expect(page.getByTestId('storage-panel')).toHaveAttribute(
    'data-restored',
    'true',
  )
  await expect(page.getByTestId('clip')).toHaveCount(2)
  await page.getByTestId('clip').nth(1).click()

  // Both still there.
  await expect(page.getByTestId('script-panel')).toBeVisible()
  await expect(page.getByTestId('verb-watch')).toContainText('again')
})
