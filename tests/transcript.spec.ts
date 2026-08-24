import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_TONES } from './fixture.config.mjs'

/**
 * Working out what is said, and putting it on screen.
 *
 * The Whisper call is stubbed and always will be: a real one needs a 1.5GB model
 * and takes minutes on a CPU, which is not a thing to put in a suite. What is
 * NOT stubbed is the half that this project owns - the worker decoding the
 * fixture's audio with WebCodecs, resampling it to 16kHz mono, and wrapping it
 * in a WAV. That request really happens, and its body is checked.
 *
 * The TONES fixture is used rather than the counter, which carries no audio at
 * all - a file with no sound has nothing to transcribe, and the verb is
 * correctly dead on it.
 */

const TRANSCRIBE = '**/api/transcribe*'

/** Two lines inside the fixture's length, so both can become captions. */
const SPOKEN = {
  language: 'en',
  duration: 6,
  text: 'first line second line',
  segments: [
    {
      start: 1,
      end: 2,
      text: 'first line',
      words: [{ start: 1, end: 1.5, word: 'first', probability: 0.9 }],
    },
    {
      start: 3,
      end: 4,
      text: 'second line',
      words: [{ start: 3, end: 3.5, word: 'second', probability: 0.9 }],
    },
  ],
}

/** Captures what the page actually sent to be transcribed. */
async function stubTranscriber(page: Page, body: unknown = SPOKEN, status = 200) {
  const seen: {
    bytes: number
    contentType: string | undefined
    url: string
  }[] = []

  await page.route(TRANSCRIBE, async (route) => {
    const request = route.request()
    seen.push({
      bytes: (request.postDataBuffer() ?? Buffer.alloc(0)).byteLength,
      contentType: request.headers()['content-type'],
      url: request.url(),
    })
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })

  return seen
}

function historyDepth(page: Page) {
  return page.evaluate(() => window.__timelineStore.getState().past.length)
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
  await page.setInputFiles('[data-testid=media-input]', FIXTURE_TONES.path)
  await expect(page.getByTestId('clip')).toBeVisible()

  // The verb waits on the waveform, which is how it knows there is any sound.
  await expect(page.getByTestId('waveform')).toBeVisible()
})

test('sends real decoded audio, as a WAV', async ({ page }) => {
  // The point of the whole arrangement: WebCodecs decodes, and what leaves the
  // browser is plain PCM. Nothing here reaches for a second decoder.
  const seen = await stubTranscriber(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()

  expect(seen).toHaveLength(1)
  expect(seen[0]!.contentType).toContain('audio/wav')

  // 16kHz mono 16-bit is 32000 bytes a second, plus a 44 byte header. The
  // fixture is a few seconds long, so anything tiny means the decode failed
  // and an empty buffer was sent.
  expect(seen[0]!.bytes).toBeGreaterThan(32_000)
})

test('shows what was said, with the moment it was said', async ({ page }) => {
  await stubTranscriber(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()

  // In the assistant column, not the inspector: a script is what you read
  // WHILE asking for a cut, so both have to be in view at once.
  await expect(page.getByTestId('script-panel')).toBeVisible()
  const zone = await page.evaluate(
    () => !!document.querySelector('[data-testid="script-panel"]')?.closest('.assistant'),
  )
  expect(zone).toBe(true)

  await expect(page.getByTestId('script-line')).toHaveCount(2)
  await expect(page.getByTestId('script-line').first()).toContainText(
    'first line',
  )
  await expect(page.getByTestId('script-line').first()).toContainText('1.00s')
})

test('nothing is shown before there is a transcript', async ({ page }) => {
  await page.getByTestId('clip').click()
  await expect(page.getByTestId('script-panel')).toHaveCount(0)
  await expect(page.getByTestId('verb-captions')).toBeDisabled()
})

test('the script follows the selection', async ({ page }) => {
  await stubTranscriber(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()

  // A caption says nothing, so there is no script to show for one.
  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)
  await expect(page.getByTestId('script-panel')).toHaveCount(0)

  // Coming back to the clip brings it back - it was never lost, just not
  // what was being looked at.
  await page.getByTestId('clip').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()
})

test('lays the lines onto the text row as one undo step', async ({ page }) => {
  await stubTranscriber(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()

  const depthBefore = await historyDepth(page)
  await page.getByTestId('verb-captions').click()

  await expect(page.getByTestId('overlay-block')).toHaveCount(2)
  expect(await historyDepth(page)).toBe(depthBefore + 1)

  // Captioning an interview is one decision, so taking it back is one keystroke.
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('overlay-block')).toHaveCount(0)
})

test('a caption lands where the words were spoken', async ({ page }) => {
  await stubTranscriber(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()
  await page.getByTestId('verb-captions').click()
  await expect(page.getByTestId('overlay-block')).toHaveCount(2)

  const captions = await page.evaluate(() =>
    window.__timelineStore
      .getState()
      .project.tracks.filter((track) => track.kind === 'text')
      .flatMap((track) => track.segments)
      .map((segment) => ({
        at: segment.timelineStartMicros,
        text: segment.content.kind === 'text' ? segment.content.content : '',
      })),
  )

  // The clip is untrimmed and sits at 0, so source time is timeline time here.
  expect(captions).toEqual([
    { at: 1_000_000, text: 'first line' },
    { at: 3_000_000, text: 'second line' },
  ])
})

test('says so when the transcriber is not installed', async ({ page }) => {
  await stubTranscriber(
    page,
    { error: 'The transcriber is not installed. Run: uv venv .venv' },
    503,
  )

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()

  await expect(page.getByTestId('stage-error')).toContainText('not installed')
  await expect(page.getByTestId('script-panel')).toHaveCount(0)
})

test('Transcribe is dead on a file with no sound in it', async ({ page }) => {
  // A video shot with the microphone off is still a video segment, so the
  // segment's kind cannot answer this - only the waveform can.
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toHaveCount(2)

  await page.getByTestId('clip').nth(1).click()
  await expect(page.getByTestId('verb-transcribe')).toBeDisabled()
  await expect(page.getByTestId('verb-transcribe')).toHaveAttribute(
    'title',
    /no sound/,
  )
})

test('Transcribe is dead on a caption, which says nothing', async ({ page }) => {
  await page.getByTestId('add-overlay').click()
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)

  await expect(page.getByTestId('verb-transcribe')).toBeDisabled()
})

test('a loop the transcriber got stuck in is not shown as speech', async ({
  page,
}) => {
  // Whisper's one spectacular failure: a phrase repeated until the window ends.
  // Showing it would be worse than useless - the whole point of this text is to
  // cut against, and a fabricated minute of speech puts the cut in the wrong
  // place.
  await stubTranscriber(page, {
    language: 'ta',
    duration: 6,
    text: 'nonsense',
    segments: [
      {
        start: 1,
        end: 2,
        text: ['this is our website', ...Array(40).fill('booking')].join(' '),
        words: [],
      },
      { start: 3, end: 4, text: 'booking booking booking booking', words: [] },
    ],
  })

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()

  // One line, not two hundred: the window the loop started in, with the phrase
  // it got stuck on shown once, and the windows that carried on with it gone.
  await expect(page.getByTestId('script-line')).toHaveCount(1)
  await expect(page.getByTestId('script-line').first()).toContainText(
    'this is our website booking',
  )
  await expect(page.getByTestId('script-line').first()).not.toContainText(
    'booking booking',
  )
})

test('the spoken language can be pinned, and rides with the audio', async ({
  page,
}) => {
  // Auto-detection reads the first few seconds and, on a quiet opening, guesses
  // wrong - after which every word comes back as a language nobody spoke.
  const seen = await stubTranscriber(page)

  await page.getByTestId('clip').click()
  await expect(page.getByTestId('script-language')).toBeVisible()
  await page.getByTestId('script-language').getByRole('combobox').selectOption('ta')

  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()

  expect(seen[0]!.url).toContain('language=ta')
})

test('nothing is pinned to begin with, so the transcriber decides', async ({
  page,
}) => {
  const seen = await stubTranscriber(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()

  expect(seen[0]!.url).not.toContain('language=')
})

test('the choice of language is remembered, and never enters the project', async ({
  page,
}) => {
  await stubTranscriber(page)
  await page.getByTestId('clip').click()
  await page.getByTestId('script-language').getByRole('combobox').selectOption('hi')

  // Not part of what the project carries: opening a draft somebody else saved
  // must not change what your transcriber listens for.
  const saved = await page.evaluate(() =>
    JSON.stringify(window.__timelineStore.getState().project),
  )
  expect(saved).not.toContain('spoken-language')

  // A preference about this browser, exactly like the theme, so it survives a
  // reload. The clip is handed back rather than waited for: whether the media
  // was restored is the persistence suite's question, not this one's.
  await page.reload()
  await expect(page.getByTestId('storage-panel')).toHaveAttribute(
    'data-restored',
    'true',
  )
  await page.setInputFiles('[data-testid=media-input]', FIXTURE_TONES.path)
  await expect(page.getByTestId('waveform')).toBeVisible()
  await page.getByTestId('clip').first().click()

  await expect(
    page.getByTestId('script-language').getByRole('combobox'),
  ).toHaveValue('hi')
})

test('there is no language to set for a clip with no sound in it', async ({
  page,
}) => {
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toHaveCount(2)

  await page.getByTestId('clip').nth(1).click()
  await expect(page.getByTestId('script-language')).toHaveCount(0)
})

test('it can be asked to listen again, which is how a bad one is retried', async ({
  page,
}) => {
  const seen = await stubTranscriber(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()

  // The wrong language, or a loop, is the whole reason anybody presses this
  // twice - a button that went dead on the first answer would strand them.
  await expect(page.getByTestId('verb-transcribe')).toBeEnabled()
  await expect(page.getByTestId('verb-transcribe')).toContainText('again')

  await page.getByTestId('script-language').getByRole('combobox').selectOption('ta')
  await page.getByTestId('verb-transcribe').click()
  await expect.poll(() => seen.length).toBe(2)
  expect(seen[1]!.url).toContain('language=ta')
})

test('speech that switches languages can be asked for as mixed', async ({
  page,
}) => {
  // Not a language: an instruction to work out the language line by line, which
  // is the only thing that reads Tamil with English words dropped into it.
  const seen = await stubTranscriber(page)

  await page.getByTestId('clip').click()
  await page
    .getByTestId('script-language')
    .getByRole('combobox')
    .selectOption('mixed')
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()

  expect(seen[0]!.url).toContain('language=mixed')
})

test('says which device did the work, so a slow run says why', async ({
  page,
}) => {
  // Minutes against seconds is the whole difference between the two, and
  // without this a fallback to the CPU looks exactly like a long file.
  await stubTranscriber(page, { ...SPOKEN, device: 'cpu (int8)' })

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-device')).toContainText('the CPU')
})

test('says nothing about the device when the sidecar did not report one', async ({
  page,
}) => {
  await stubTranscriber(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-device')).toBeVisible()
  await expect(page.getByTestId('script-device')).not.toContainText(
    'Transcribed on',
  )
})

test('the timeline says how long it now is, so a cut can be seen', async ({
  page,
}) => {
  // "How much did that take off?" is the question after every cut, and until
  // now the answer was nowhere on screen.
  await expect(page.getByTestId('stage-length')).toHaveText(/\d+:\d\d/)
  const before = (await page.getByTestId('stage-length').textContent()) ?? ''

  // A second clip lands after the first, so the timeline gets longer by its
  // length - a change the readout has to follow.
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toHaveCount(2)

  await expect(page.getByTestId('stage-length')).not.toHaveText(before)
})

test('a transcript survives a reload, so nobody pays for it twice', async ({
  page,
}) => {
  // It costs minutes of somebody's machine. Losing it on every reload would
  // leave the assistant blind - and rightly refusing to cut - until it was run
  // again. It is still not part of the project and still never in a draft.
  const seen = await stubTranscriber(page)

  await page.getByTestId('clip').click()
  await page.getByTestId('verb-transcribe').click()
  await expect(page.getByTestId('script-panel')).toBeVisible()
  expect(seen).toHaveLength(1)

  // The project has to have been autosaved before reloading, or there is no
  // clip to come back to and the test would be measuring the wrong thing.
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

  await expect(page.getByTestId('script-panel')).toBeVisible()
  await expect(page.getByTestId('script-line')).toHaveCount(2)

  // Not asked for again: the whole point.
  expect(seen).toHaveLength(1)

  // And still not in the project, which is what a draft would carry.
  const saved = await page.evaluate(() =>
    JSON.stringify(window.__timelineStore.getState().project),
  )
  expect(saved).not.toContain('first line')
})
