import { expect, test, type Page } from '@playwright/test'
import {
  ALL_TONE_HZ,
  FIXTURE_TONES,
  TONES_EXPECTED_BY_SECOND,
  tonesTimelineSpec,
} from './fixture.config.mjs'

const SECOND = 1_000_000
/** Short enough to land several windows inside every timeline second. */
const WINDOW_MICROS = 200_000

type Window = {
  startMicros: number
  rms: number
  silent: boolean
  dominantHz: number | null
}

/**
 * The tone each timeline second should carry, from the spec. Windows that
 * straddle a second boundary are excluded by the caller: at a cut the window
 * legitimately contains both tones and neither answer is wrong.
 */
function expectedHzAt(startMicros: number): number | null {
  return TONES_EXPECTED_BY_SECOND[Math.floor(startMicros / SECOND)] ?? null
}

function straddlesABoundary(startMicros: number): boolean {
  const endMicros = startMicros + WINDOW_MICROS
  return Math.floor(startMicros / SECOND) !== Math.floor((endMicros - 1) / SECOND)
}

function report(label: string, windows: Window[]) {
  console.log(
    `${label}:\n  ` +
      windows
        .map((window) => {
          const at = (window.startMicros / SECOND).toFixed(1)
          const heard = window.silent ? 'silence' : `${window.dominantHz}Hz`
          return `${at}s ${heard} (rms ${window.rms})`
        })
        .join('\n  '),
  )
}

async function loadTones(page: Page) {
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    tonesTimelineSpec(),
  )
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('every exported window carries the tone its timeline second should', async ({
  page,
}) => {
  await loadTones(page)
  await page.evaluate(() => window.harness.exportMp4())

  const { sampleRate, windows } = await page.evaluate(
    (args) => window.harness.audioWindows(args),
    { windowMicros: WINDOW_MICROS, candidatesHz: ALL_TONE_HZ },
  )
  report(`exported audio (${sampleRate}Hz)`, windows)

  expect(windows.length).toBeGreaterThan(20)

  const checked = windows.filter(
    (window) => !straddlesABoundary(window.startMicros),
  )
  expect(checked.length).toBeGreaterThan(15)

  for (const window of checked) {
    const expected = expectedHzAt(window.startMicros)
    const at = `${(window.startMicros / SECOND).toFixed(1)}s`

    if (expected === null) {
      // The gap: silence, not a quiet tone and not the neighbouring clip.
      expect.soft(window.silent, `${at} should be silent`).toBe(true)
    } else {
      expect.soft(window.silent, `${at} should not be silent`).toBe(false)
      expect.soft(window.dominantHz, `${at} tone`).toBe(expected)
    }
  }
})

test('trimming a clip trims its audio with it', async ({ page }) => {
  // Clip A already starts one second into its source, so timeline 0 carries
  // the second tone. Trim another second off its head and the third should
  // arrive at timeline 0 instead - the audio moves with the picture.
  await loadTones(page)
  await page.evaluate(() => {
    window.__timelineStore
      .getState()
      .trimClipStart({ clipId: 'clip-0', timelineMicros: 1_000_000 })
  })
  await page.evaluate(() => {
    const project = window.__timelineStore.getState().project
    return window.harness.setProject(project)
  })

  await page.evaluate(() => window.harness.exportMp4())
  const { windows } = await page.evaluate(
    (args) => window.harness.audioWindows(args),
    { windowMicros: WINDOW_MICROS, candidatesHz: ALL_TONE_HZ },
  )
  report('after trimming one second off the head', windows)

  // The clip now sits at timeline 1s and starts at source 2s: 500Hz.
  const inTrimmedClip = windows.filter(
    (window) =>
      window.startMicros >= 1_100_000 && window.startMicros < 1_800_000,
  )
  expect(inTrimmedClip.length).toBeGreaterThan(0)
  for (const window of inTrimmedClip) {
    expect.soft(window.dominantHz, 'trimmed clip tone').toBe(500)
  }

  // And what came before it is gone: nothing plays at timeline 0 any more.
  const beforeTheClip = windows.filter(
    (window) => window.startMicros + WINDOW_MICROS <= 900_000,
  )
  for (const window of beforeTheClip) {
    expect.soft(window.silent, 'before the trimmed clip').toBe(true)
  }
})

test('playback schedules audio without a single underrun', async ({ page }) => {
  await loadTones(page)

  const stats = await page.evaluate(() => window.harness.playThrough())
  console.log(
    `play-through: audioChunks=${stats.audioChunks}` +
      ` audioUnderruns=${stats.audioUnderruns} drawn=${stats.drawn}`,
  )

  // Every chunk was scheduled into the future. A single late one is an
  // audible click, so the tolerance here is zero.
  expect(stats.audioChunks).toBeGreaterThan(0)
  expect(stats.audioUnderruns).toBe(0)
})

test('a silent timeline still plays on the audio clock', async ({ page }) => {
  // The fixture without audio: nothing to schedule, but the clock is the same
  // clock. There is no second code path for silence.
  await page.evaluate((spec) => window.harness.loadProject(spec), {
    composition: { width: FIXTURE_TONES.width, height: FIXTURE_TONES.height },
    sources: [{ id: 'silent', url: '/tests/fixtures/counter-30fps.mp4' }],
    clips: [
      {
        sourceId: 'silent',
        sourceInMicros: 0,
        sourceOutMicros: 2 * SECOND,
        timelineStartMicros: 0,
      },
    ],
  })

  const stats = await page.evaluate(() => window.harness.playThrough())

  expect(stats.audioChunks).toBe(0)
  expect(stats.audioUnderruns).toBe(0)
  // It still reached the end, on time, driven by the audio clock.
  expect(stats.drawn).toBeGreaterThan(30)
  expect(Math.max(...stats.times)).toBeGreaterThan(1_800_000)
})
