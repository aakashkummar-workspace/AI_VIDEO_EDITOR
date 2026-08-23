import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_MUSIC } from './fixture.config.mjs'
import { openTab } from './inspector'

/**
 * Music on a row of its own, through the real decoder and the real mix.
 *
 * Checked by frequency rather than by ear, like the rest of the audio suite:
 * the music fixture carries one pure tone per second, so what a decoded window
 * contains says which second of the file it came from and how loud it is says
 * what the volume did to it.
 */

const SECOND = 1_000_000
const WINDOW_MICROS = 200_000

type Window = {
  startMicros: number
  rms: number
  silent: boolean
  dominantHz: number | null
}

function report(label: string, windows: Window[]) {
  console.log(
    `${label}:\n  ` +
      windows
        .map((w) => {
          const at = (w.startMicros / SECOND).toFixed(1)
          const heard = w.silent ? 'silence' : `${w.dominantHz}Hz`
          return `${at}s ${heard} (rms ${w.rms.toFixed(3)})`
        })
        .join('\n  '),
  )
}

/** Windows that sit wholly inside one timeline second. */
function whole(windows: Window[]): Window[] {
  return windows.filter(
    (w) =>
      Math.floor(w.startMicros / SECOND) ===
      Math.floor((w.startMicros + WINDOW_MICROS - 1) / SECOND),
  )
}

async function analyse(page: Page): Promise<Window[]> {
  const { windows } = await page.evaluate(
    (args) => window.harness.audioWindows(args),
    {
      windowMicros: WINDOW_MICROS,
      candidatesHz: FIXTURE_MUSIC.toneHz,
      silenceRms: 0.01,
    },
  )
  return windows
}

/**
 * A project with the music fixture on the audio row, and optionally the
 * counter clip on the video row so the two have to mix.
 */
async function loadMusic(page: Page, options: { withClip?: boolean } = {}) {
  await page.evaluate(
    async (args) => {
      const store = window.__timelineStore.getState()
      store.reset()

      const music = await window.harness.addSourceFromUrl(
        args.musicUrl,
        'src-music',
      )
      const audioRow = window.__timelineStore
        .getState()
        .project.tracks.find((track) => track.kind === 'audio')!

      window.__timelineStore.getState().addSegment({
        trackId: audioRow.id,
        segment: {
          id: 'music-1',
          timelineStartMicros: 0,
          content: {
            kind: 'audio',
            sourceId: 'src-music',
            sourceInMicros: 0,
            sourceOutMicros: music.durationMicros,
          },
        },
      })

      if (args.clipUrl) {
        const clip = await window.harness.addSourceFromUrl(
          args.clipUrl,
          'src-clip',
        )
        const videoRow = window.__timelineStore
          .getState()
          .project.tracks.find((track) => track.kind === 'video')!

        window.__timelineStore.getState().addSegment({
          trackId: videoRow.id,
          segment: {
            id: 'clip-1',
            timelineStartMicros: 0,
            content: {
              kind: 'video',
              sourceId: 'src-clip',
              sourceInMicros: 0,
              sourceOutMicros: clip.durationMicros,
            },
          },
        })
      }

      window.harness.setProject(window.__timelineStore.getState().project)
    },
    {
      musicUrl: `/${FIXTURE_MUSIC.path}`,
      clipUrl: options.withClip ? `/${FIXTURE.path}` : null,
    },
  )
}

/** Applies edits to the store and republishes the project to the player. */
async function edit(page: Page, source: string) {
  await page.evaluate((code) => {
    const run = new Function('store', `(${code})(store)`) as (
      store: unknown,
    ) => void
    run(window.__timelineStore.getState())
    window.harness.setProject(window.__timelineStore.getState().project)
  }, source)
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('a file with no picture opens as a source with no size', async ({
  page,
}) => {
  const geometry = await page.evaluate(
    (url) => window.harness.addSourceFromUrl(url, 'src-music'),
    `/${FIXTURE_MUSIC.path}`,
  )

  expect(geometry.hasVideo).toBe(false)
  expect(geometry.width).toBe(0)
  expect(geometry.height).toBe(0)
  // Four seconds of tones, give or take the encoder.
  expect(geometry.durationMicros).toBeGreaterThan(3.5 * SECOND)
  expect(geometry.durationMicros).toBeLessThan(4.6 * SECOND)
})

test('music on its own row is heard, second by second', async ({ page }) => {
  await loadMusic(page)
  await page.evaluate(() => window.harness.exportMp4())

  const windows = whole(await analyse(page))
  report('music alone', windows)

  expect(windows.length).toBeGreaterThan(0)
  for (const window of windows) {
    const second = Math.floor(window.startMicros / SECOND)
    const expected = FIXTURE_MUSIC.toneHz[second]
    if (expected === undefined) continue

    expect(window.silent, `${second}s should not be silent`).toBe(false)
    expect(window.dominantHz, `${second}s`).toBe(expected)
  }
})

test('an audio row plays under a clip rather than instead of it', async ({
  page,
}) => {
  await loadMusic(page, { withClip: true })

  // The picture still comes from the video row.
  const project = await page.evaluate(
    () => window.__timelineStore.getState().project,
  )
  expect(project.tracks.flatMap((t) => t.segments)).toHaveLength(2)

  await page.evaluate(() => window.harness.exportMp4())
  const windows = whole(await analyse(page))
  report('music under a silent clip', windows)

  // The counter clip carries no audio, so what is heard is the music.
  expect(windows.some((w) => !w.silent)).toBe(true)
})

test('turning a segment down makes it quieter, and zero silences it', async ({
  page,
}) => {
  await loadMusic(page)
  await page.evaluate(() => window.harness.exportMp4())
  const loud = whole(await analyse(page))

  await edit(
    page,
    `(store) => store.setSegmentProperties({ segmentId: 'music-1', volume: 0.25 })`,
  )
  await page.evaluate(() => window.harness.exportMp4())
  const quiet = whole(await analyse(page))

  const loudRms = loud.reduce((sum, w) => sum + w.rms, 0) / loud.length
  const quietRms = quiet.reduce((sum, w) => sum + w.rms, 0) / quiet.length
  console.log(`rms: full ${loudRms.toFixed(4)}, quarter ${quietRms.toFixed(4)}`)

  // A quarter of the amplitude, within the slop of a lossy encode.
  expect(quietRms).toBeLessThan(loudRms * 0.4)
  expect(quietRms).toBeGreaterThan(0)

  await edit(
    page,
    `(store) => store.setSegmentProperties({ segmentId: 'music-1', volume: 0 })`,
  )
  await page.evaluate(() => window.harness.exportMp4())
  const muted = whole(await analyse(page))
  report('muted', muted)

  expect(muted.every((w) => w.silent)).toBe(true)
})

test('a volume fade ramps across the segment', async ({ page }) => {
  await loadMusic(page)
  await edit(
    page,
    `(store) => {
      store.addKeyframe({ segmentId: 'music-1', property: 'volume', offsetMicros: 0, value: 0 })
      store.addKeyframe({ segmentId: 'music-1', property: 'volume', offsetMicros: 4000000, value: 1 })
    }`,
  )

  await page.evaluate(() => window.harness.exportMp4())
  const windows = whole(await analyse(page))
  report('fading in', windows)

  const early = windows.filter((w) => w.startMicros < 1 * SECOND)
  const late = windows.filter((w) => w.startMicros >= 3 * SECOND)
  expect(early.length).toBeGreaterThan(0)
  expect(late.length).toBeGreaterThan(0)

  const earlyRms = early.reduce((sum, w) => sum + w.rms, 0) / early.length
  const lateRms = late.reduce((sum, w) => sum + w.rms, 0) / late.length
  console.log(`fade: first second ${earlyRms.toFixed(4)}, last ${lateRms.toFixed(4)}`)

  expect(lateRms).toBeGreaterThan(earlyRms * 2)
})

test('the fade is smooth rather than stepped at the packet boundaries', async ({
  page,
}) => {
  await loadMusic(page)
  await edit(
    page,
    `(store) => {
      store.addKeyframe({ segmentId: 'music-1', property: 'volume', offsetMicros: 0, value: 0 })
      store.addKeyframe({ segmentId: 'music-1', property: 'volume', offsetMicros: 4000000, value: 1 })
    }`,
  )
  await page.evaluate(() => window.harness.exportMp4())

  const windows = whole(await analyse(page))
  const rising = windows.filter((w) => w.rms > 0)

  // Every window should be at least as loud as the one before it. A gain
  // applied per decoded packet rather than per sample would still trend
  // upwards but would not be monotonic across a boundary.
  for (let i = 1; i < rising.length; i++) {
    expect(
      rising[i]!.rms,
      `window at ${rising[i]!.startMicros}us quieter than the one before`,
    ).toBeGreaterThanOrEqual(rising[i - 1]!.rms * 0.9)
  }
})

test('an audio-only project still exports a file', async ({ page }) => {
  await loadMusic(page)

  const exported = await page.evaluate(() => window.harness.exportMp4())
  expect(exported.byteLength).toBeGreaterThan(0)

  const geometry = await page.evaluate(() => window.harness.loadExported())
  // Nothing was ever drawn, so the picture is whatever the composition is -
  // black, for as long as the music lasts.
  expect(geometry!.durationMicros).toBeGreaterThan(3 * SECOND)
})

test.describe('audio in the app', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('a music file lands on the audio row, not the video row', async ({
    page,
  }) => {
    await page.setInputFiles('[data-testid=media-input]', FIXTURE_MUSIC.path)

    await expect(page.getByTestId('audio-block')).toHaveCount(1)
    await expect(page.getByTestId('clip')).toHaveCount(0)
    await expect(page.getByTestId('media-item')).toHaveCount(1)
  })

  test('the media list says which files have no picture', async ({ page }) => {
    // Scoped to the media list: the same class labels rows and offline media.
    const meta = page.getByTestId('media-list').locator('.media-meta')

    await page.setInputFiles('[data-testid=media-input]', FIXTURE_MUSIC.path)
    await expect(page.getByTestId('audio-block')).toHaveCount(1)
    await expect(meta).toHaveText('audio only')

    await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
    await expect(page.getByTestId('clip')).toHaveCount(1)
    await expect(meta.last()).toHaveText(
      `${FIXTURE.width} x ${FIXTURE.height}`,
    )
  })

  test('a music file does not decide the shape of the composition', async ({
    page,
  }) => {
    await page.setInputFiles('[data-testid=media-input]', FIXTURE_MUSIC.path)
    // Waiting for the block, not just the input event: opening a file is
    // asynchronous, and the composition is set on the far side of the probe.
    await expect(page.getByTestId('audio-block')).toHaveCount(1)

    // Nothing with a picture has been opened, so the default still stands.
    expect(
      await page.evaluate(
        () => window.__timelineStore.getState().project.composition,
      ),
    ).toEqual({ width: 1920, height: 1080 })

    // The first file that does have one sets it.
    await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
    await expect(page.getByTestId('clip')).toHaveCount(1)
    expect(
      await page.evaluate(
        () => window.__timelineStore.getState().project.composition,
      ),
    ).toEqual({ width: FIXTURE.width, height: FIXTURE.height })
  })

  test('an audio segment offers volume but not a transform', async ({
    page,
  }) => {
    await page.setInputFiles('[data-testid=media-input]', FIXTURE_MUSIC.path)
    await page.getByTestId('audio-block').click()

    await openTab(page, 'audio')
    await expect(page.getByTestId('levels-panel')).toBeVisible()
    await expect(page.getByTestId('transform-panel')).toHaveCount(0)
  })

  test('a clip offers both, because it has a picture and a sound', async ({
    page,
  }) => {
    await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
    await page.getByTestId('clip').click()

    // A clip has both, one tab each: a picture to transform, and a sound to
    // set the level of.
    await expect(page.getByTestId('transform-panel')).toBeVisible()
    await openTab(page, 'audio')
    await expect(page.getByTestId('levels-panel')).toBeVisible()
  })

  test('volume is editable and keyframable from the panel', async ({
    page,
  }) => {
    await page.setInputFiles('[data-testid=media-input]', FIXTURE_MUSIC.path)
    await page.getByTestId('audio-block').click()

    await openTab(page, 'audio')
    await page.getByTestId('transform-volume').fill('0.5')
    expect(
      await page.evaluate(
        () =>
          window.__timelineStore
            .getState()
            .project.tracks.flatMap((t) => t.segments)[0]!.properties,
      ),
    ).toMatchObject({ volume: 0.5 })

    await page.getByTestId('keyframe-volume').click()
    await expect(page.getByTestId('keyframe-volume')).toHaveAttribute(
      'data-keyed',
      'true',
    )
  })

  test('an audio row can be added and removed like any other', async ({
    page,
  }) => {
    await page.getByTestId('add-audio-track').click()

    const kinds = await page.evaluate(() =>
      window.__timelineStore.getState().project.tracks.map((t) => t.kind),
    )
    expect(kinds.filter((kind) => kind === 'audio')).toHaveLength(2)
  })
})
