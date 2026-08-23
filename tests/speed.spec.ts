import { expect, test, type Page } from '@playwright/test'
import {
  ALL_TONE_HZ,
  FIXTURE,
  FIXTURE_TONES,
  wholeSourceSpec,
} from './fixture.config.mjs'

/**
 * Speed, through the real decoder and the real mix.
 *
 * The tone fixture makes this checkable rather than a matter of watching: it
 * carries one pure tone per SOURCE second, so playing it at double speed
 * should put two of those tones into every timeline second, and each of them
 * an octave higher than it was recorded.
 */

const SECOND = 1_000_000
const WINDOW_MICROS = 200_000

type Window = {
  startMicros: number
  rms: number
  silent: boolean
  dominantHz: number | null
}

function meanChannelDifference(a: number[], b: number[]): number {
  expect(a.length).toBe(b.length)
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!)
  return total / a.length
}

function pixelsAt(page: Page, micros: number) {
  return page.evaluate((t) => window.harness.pixelsAt(t), micros)
}

function duration(page: Page) {
  return page.evaluate(() => window.harness.duration())
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

async function setRate(page: Page, rate: number) {
  await edit(
    page,
    `(store) => store.setSegmentRate({ segmentId: 'clip-0', rate: ${rate} })`,
  )
}

async function loadClip(page: Page) {
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    wholeSourceSpec('a'),
  )
}

/** The tone fixture as a single clip, so its seconds can be traced. */
async function loadTones(page: Page) {
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    {
      composition: {
        width: FIXTURE_TONES.width,
        height: FIXTURE_TONES.height,
      },
      sources: [{ id: 'src-tones', url: `/${FIXTURE_TONES.path}` }],
      clips: [
        {
          sourceId: 'src-tones',
          sourceInMicros: 0,
          sourceOutMicros:
            (FIXTURE_TONES.frames / FIXTURE_TONES.fps) * SECOND,
          timelineStartMicros: 0,
        },
      ],
    },
  )
}

async function analyse(page: Page, candidatesHz: number[]): Promise<Window[]> {
  const { windows } = await page.evaluate(
    (args) => window.harness.audioWindows(args),
    { windowMicros: WINDOW_MICROS, candidatesHz, silenceRms: 0.01 },
  )
  return windows.filter(
    (w) =>
      Math.floor(w.startMicros / SECOND) ===
      Math.floor((w.startMicros + WINDOW_MICROS - 1) / SECOND),
  )
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('1x changes nothing at all', async ({ page }) => {
  await loadClip(page)
  const before = await pixelsAt(page, 2 * SECOND)
  const length = await duration(page)

  await setRate(page, 2)
  await setRate(page, 1)

  expect(await duration(page)).toBe(length)
  expect(meanChannelDifference(before, await pixelsAt(page, 2 * SECOND))).toBe(
    0,
  )
})

test('the timeline gets shorter or longer with the speed', async ({ page }) => {
  await loadClip(page)
  const normal = await duration(page)

  await setRate(page, 2)
  expect(await duration(page)).toBe(normal / 2)

  await setRate(page, 0.5)
  expect(await duration(page)).toBe(normal * 2)
})

test('the picture at a moment is the footage that belongs there', async ({
  page,
}) => {
  await loadClip(page)

  // At 2x, one second in shows what used to be two seconds in.
  const twoSecondsIn = await pixelsAt(page, 2 * SECOND)

  await setRate(page, 2)
  const oneSecondInAtDouble = await pixelsAt(page, 1 * SECOND)

  const diff = meanChannelDifference(twoSecondsIn, oneSecondInAtDouble)
  console.log(`same frame through a 2x clip: mean channel diff ${diff}`)
  expect(diff).toBeLessThan(3)
})

test('a slow clip holds each frame longer rather than showing new ones', async ({
  page,
}) => {
  await loadClip(page)
  await setRate(page, 0.5)

  // Half a second apart at half speed is a quarter second of footage: the
  // counter fixture changes every frame, so these must still differ...
  const a = await pixelsAt(page, 2 * SECOND)
  const b = await pixelsAt(page, 2_500_000)
  expect(meanChannelDifference(a, b)).toBeGreaterThan(3)

  // ...but two points inside the same held frame must not.
  const c = await pixelsAt(page, 2_000_000)
  const d = await pixelsAt(page, 2_020_000)
  expect(meanChannelDifference(c, d)).toBe(0)
})

test('the tones come twice as fast and an octave up at 2x', async ({
  page,
}) => {
  await loadTones(page)
  await setRate(page, 2)
  await page.evaluate(() => window.harness.exportMp4())

  // Doubling the rate doubles every frequency, so the tones to look for are
  // the recorded ones and their octaves.
  const candidates = [
    ...FIXTURE_TONES.toneHz,
    ...FIXTURE_TONES.toneHz.map((hz) => hz * 2),
  ]
  const windows = await analyse(page, candidates)

  console.log(
    'at 2x:\n  ' +
      windows
        .map(
          (w) =>
            `${(w.startMicros / SECOND).toFixed(1)}s ` +
            (w.silent ? 'silence' : `${w.dominantHz}Hz`),
        )
        .join('\n  '),
  )

  // Timeline second 0 now holds source seconds 0 and 1, at double pitch.
  const first = windows.find((w) => w.startMicros === 0)!
  expect(first.silent).toBe(false)
  expect(first.dominantHz).toBe(FIXTURE_TONES.toneHz[0]! * 2)

  // Half a second in is already the SECOND recorded tone, also doubled.
  const halfway = windows.find((w) => w.startMicros === 600_000)!
  expect(halfway.dominantHz).toBe(FIXTURE_TONES.toneHz[1]! * 2)
})

test('the tones come half as fast and an octave down at 0.5x', async ({
  page,
}) => {
  await loadTones(page)
  await setRate(page, 0.5)
  await page.evaluate(() => window.harness.exportMp4())

  const candidates = [
    ...FIXTURE_TONES.toneHz,
    ...FIXTURE_TONES.toneHz.map((hz) => hz / 2),
  ]
  const windows = await analyse(page, candidates)

  // The first recorded second now fills two timeline seconds, at half pitch.
  for (const at of [0, 1 * SECOND]) {
    const found = windows.find((w) => w.startMicros === at)!
    expect(found.silent, `${at}us`).toBe(false)
    expect(found.dominantHz, `${at}us`).toBe(FIXTURE_TONES.toneHz[0]! / 2)
  }
})

test('the export matches the preview at a changed speed', async ({ page }) => {
  await loadClip(page)
  await setRate(page, 2)

  const preview = {
    early: await pixelsAt(page, 500_000),
    late: await pixelsAt(page, 2_500_000),
  }

  await page.evaluate(() => window.harness.exportMp4())
  await page.evaluate(() => window.harness.loadExported())

  for (const [label, at] of [
    ['early', 500_000],
    ['late', 2_500_000],
  ] as const) {
    const diff = meanChannelDifference(preview[label], await pixelsAt(page, at))
    console.log(`${label}: mean channel diff ${diff.toFixed(3)}`)
    expect.soft(diff, label).toBeLessThan(3)
  }
})

test('a changed speed leaks no frames over a full play-through', async ({
  page,
}) => {
  await loadClip(page)
  await setRate(page, 2)
  await page.evaluate(() => window.harness.playThrough())

  const counts = await page.evaluate(() => window.harness.frameCounts())
  expect(counts.worker.created).toBeGreaterThan(0)
  expect(counts.worker.closed + counts.main.closed).toBe(counts.worker.created)
})

test('every tone is still one of the fixture tones at 1x', async ({ page }) => {
  // Guards the two speed checks above: the analysis has to be able to fail.
  await loadTones(page)
  await page.evaluate(() => window.harness.exportMp4())
  const windows = await analyse(page, ALL_TONE_HZ)

  const first = windows.find((w) => w.startMicros === 0)!
  expect(first.dominantHz).toBe(FIXTURE_TONES.toneHz[0])
})

test.describe('the speed panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
    await expect(page.getByTestId('clip')).toBeVisible()
    await page.getByTestId('clip').click()
  })

  test('offers the usual speeds and says how long the clip becomes', async ({
    page,
  }) => {
    await expect(page.getByTestId('speed-panel')).toBeVisible()
    await expect(page.getByTestId('speed-summary')).toContainText('0:06.00')

    await page.getByTestId('rate-2').click()
    await expect(page.getByTestId('speed-summary')).toContainText('0:03.00')
    await expect(page.getByTestId('speed-summary')).toContainText('pitched')
  })

  test('marks which speed is current', async ({ page }) => {
    await expect(page.getByTestId('rate-1')).toHaveClass(/is-current/)

    await page.getByTestId('rate-0.5').click()
    await expect(page.getByTestId('rate-0.5')).toHaveClass(/is-current/)
    await expect(page.getByTestId('rate-1')).not.toHaveClass(/is-current/)
  })

  test('is not offered on a caption, which has no source', async ({ page }) => {
    await page.getByTestId('add-overlay').click()
    await page.getByTestId('overlay-block').click()

    await expect(page.getByTestId('speed-panel')).toHaveCount(0)
  })

  test('is undoable like any other edit', async ({ page }) => {
    const before = await page.evaluate(
      () => window.__timelineStore.getState().project,
    )

    await page.getByTestId('rate-4').click()
    await expect(page.getByTestId('speed-summary')).toContainText('0:01.50')

    await page.keyboard.press('Control+z')
    expect(
      await page.evaluate(() => window.__timelineStore.getState().project),
    ).toEqual(before)
  })
})
