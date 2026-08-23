import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_B } from './fixture.config.mjs'

/**
 * Transitions through the real decoder and the one render function.
 *
 * A dissolve is the first thing in this editor that needs two clips on the
 * SAME row on screen at once, so these tests are mostly about whether both
 * sides are really there - and whether the export agrees with the preview
 * about it, which is where a second decode stream would otherwise drift.
 */

const SECOND = 1_000_000

/** Two clips from different sources, meeting at 3s with no gap. */
const BUTTED_SPEC = {
  composition: { width: FIXTURE.width, height: FIXTURE.height },
  sources: [
    { id: 'src-a', url: `/${FIXTURE.path}` },
    { id: 'src-b', url: `/${FIXTURE_B.path}` },
  ],
  clips: [
    {
      sourceId: 'src-a',
      sourceInMicros: 0,
      sourceOutMicros: 3 * SECOND,
      timelineStartMicros: 0,
    },
    {
      sourceId: 'src-b',
      sourceInMicros: 0,
      sourceOutMicros: 3 * SECOND,
      timelineStartMicros: 3 * SECOND,
    },
  ],
}

function meanChannelDifference(a: number[], b: number[]): number {
  expect(a.length).toBe(b.length)
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!)
  return total / a.length
}

function meanBrightness(pixels: number[]): number {
  let total = 0
  for (let i = 0; i < pixels.length; i += 4) {
    total += pixels[i]! + pixels[i + 1]! + pixels[i + 2]!
  }
  return total / ((pixels.length / 4) * 3)
}

function peakBrightness(pixels: number[]): number {
  let peak = 0
  for (let i = 0; i < pixels.length; i += 4) {
    peak = Math.max(peak, pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)
  }
  return peak
}

function pixelsAt(page: Page, micros: number) {
  return page.evaluate((t) => window.harness.pixelsAt(t), micros)
}

async function loadButted(page: Page) {
  await page.evaluate((spec) => window.harness.loadProject(spec), BUTTED_SPEC)
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

async function applyTransition(
  page: Page,
  kind: string,
  seconds = 2,
): Promise<void> {
  await edit(
    page,
    `(store) => store.setTransition({
      segmentId: 'clip-1',
      kind: '${kind}',
      durationMicros: ${Math.round(seconds * 1e6)},
    })`,
  )
}

/** Where the incoming clip now starts, once the transition has moved it. */
async function incomingStart(page: Page): Promise<number> {
  return page.evaluate(() => {
    const project = window.__timelineStore.getState().project
    const segment = project.tracks
      .flatMap((track) => track.segments)
      .find((candidate) => candidate.id === 'clip-1')!
    return segment.timelineStartMicros
  })
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('a project with no transition renders exactly as it did', async ({
  page,
}) => {
  await loadButted(page)
  const before = await pixelsAt(page, 1 * SECOND)

  // Setting one and taking it off again must land back on the same pixels.
  await applyTransition(page, 'crossfade', 1)
  await edit(page, `(store) => store.removeTransition('clip-1')`)

  expect(meanChannelDifference(before, await pixelsAt(page, 1 * SECOND))).toBe(
    0,
  )
})

test('a crossfade shows both clips at once, and neither on its own', async ({
  page,
}) => {
  await loadButted(page)

  // What each side looks like alone, at the frames the blend will use.
  const outgoingAlone = await pixelsAt(page, 2 * SECOND)
  const incomingAlone = await pixelsAt(page, 4 * SECOND)

  await applyTransition(page, 'crossfade', 2)
  const start = await incomingStart(page)

  const midway = await pixelsAt(page, start + 1 * SECOND)

  const fromOutgoing = meanChannelDifference(midway, outgoingAlone)
  const fromIncoming = meanChannelDifference(midway, incomingAlone)
  console.log(
    `midway differs from outgoing by ${fromOutgoing.toFixed(1)},` +
      ` from incoming by ${fromIncoming.toFixed(1)}`,
  )

  // A blend is neither picture: it must differ from both.
  expect(fromOutgoing).toBeGreaterThan(5)
  expect(fromIncoming).toBeGreaterThan(5)
  // And it must not be black, which is what a missing second stream looks like.
  expect(peakBrightness(midway)).toBeGreaterThan(0)
})

test('a crossfade moves from one clip to the other across its window', async ({
  page,
}) => {
  await loadButted(page)
  await applyTransition(page, 'crossfade', 2)
  const start = await incomingStart(page)

  const incomingAlone = await pixelsAt(page, start + 2 * SECOND)

  const early = await pixelsAt(page, start + 200_000)
  const late = await pixelsAt(page, start + 1_800_000)

  // Late in the window the picture is much closer to the incoming clip than
  // early in it, which is what "dissolving into" means.
  const earlyGap = meanChannelDifference(early, incomingAlone)
  const lateGap = meanChannelDifference(late, incomingAlone)
  console.log(
    `distance to the incoming clip: early ${earlyGap.toFixed(1)},` +
      ` late ${lateGap.toFixed(1)}`,
  )

  expect(lateGap).toBeLessThan(earlyGap)
})

test('a dip to black passes through black in the middle', async ({ page }) => {
  await loadButted(page)
  await applyTransition(page, 'dip-to-black', 2)
  const start = await incomingStart(page)

  const early = meanBrightness(await pixelsAt(page, start + 100_000))
  const middle = meanBrightness(await pixelsAt(page, start + 1 * SECOND))
  const late = meanBrightness(await pixelsAt(page, start + 1_900_000))

  console.log(
    `dip: ${early.toFixed(1)} -> ${middle.toFixed(1)} -> ${late.toFixed(1)}`,
  )

  expect(middle).toBeLessThan(early / 4)
  expect(middle).toBeLessThan(late / 4)
})

test('a wipe reveals the incoming clip across the frame', async ({ page }) => {
  await loadButted(page)
  await applyTransition(page, 'wipe', 2)
  const start = await incomingStart(page)

  const midway = await pixelsAt(page, start + 1 * SECOND)

  // Half way through, the left half is the incoming clip and the right half
  // is still the outgoing one, so the two halves differ sharply.
  const width = FIXTURE.width
  const height = FIXTURE.height
  let leftTotal = 0
  let rightTotal = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const value = midway[i]! + midway[i + 1]! + midway[i + 2]!
      if (x < width / 4) leftTotal += value
      else if (x > (width * 3) / 4) rightTotal += value
    }
  }

  const samples = (width / 4) * height * 3
  console.log(
    `wipe halves: left ${(leftTotal / samples).toFixed(1)},` +
      ` right ${(rightTotal / samples).toFixed(1)}`,
  )
  expect(Math.abs(leftTotal - rightTotal) / samples).toBeGreaterThan(5)
})

test('the export matches the preview through a transition', async ({
  page,
}) => {
  await loadButted(page)
  await applyTransition(page, 'crossfade', 2)
  const start = await incomingStart(page)

  const preview = {
    early: await pixelsAt(page, start + 400_000),
    midway: await pixelsAt(page, start + 1 * SECOND),
    late: await pixelsAt(page, start + 1_600_000),
  }

  const exported = await page.evaluate(() => window.harness.exportMp4())
  expect(exported.byteLength).toBeGreaterThan(0)
  await page.evaluate(() => window.harness.loadExported())

  for (const [label, offset] of [
    ['early', 400_000],
    ['midway', 1 * SECOND],
    ['late', 1_600_000],
  ] as const) {
    const diff = meanChannelDifference(
      preview[label],
      await pixelsAt(page, start + offset),
    )
    console.log(`${label}: mean channel diff ${diff.toFixed(3)}`)
    expect.soft(diff, label).toBeLessThan(4)
  }
})

test('the exported file is shorter by the transition', async ({ page }) => {
  await loadButted(page)
  await page.evaluate(() => window.harness.exportMp4())
  const before = (await page.evaluate(() => window.harness.loadExported()))!

  await loadButted(page)
  await applyTransition(page, 'crossfade', 2)
  await page.evaluate(() => window.harness.exportMp4())
  const after = (await page.evaluate(() => window.harness.loadExported()))!

  const shorterBy = before.durationMicros - after.durationMicros
  console.log(`shorter by ${(shorterBy / SECOND).toFixed(2)}s`)

  expect(shorterBy).toBeGreaterThan(1.8 * SECOND)
  expect(shorterBy).toBeLessThan(2.2 * SECOND)
})

test('a transition leaks no frames over a full play-through', async ({
  page,
}) => {
  await loadButted(page)
  await applyTransition(page, 'crossfade', 2)
  await page.evaluate(() => window.harness.playThrough())

  const counts = await page.evaluate(() => window.harness.frameCounts())
  console.log(
    `transition play-through: created ${counts.worker.created}, closed` +
      ` ${counts.worker.closed} in the worker and ${counts.main.closed} on main`,
  )

  expect(counts.worker.created).toBeGreaterThan(0)
  expect(counts.worker.closed + counts.main.closed).toBe(counts.worker.created)
})

test.describe('the transition panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
    await expect(page.getByTestId('clip')).toHaveCount(1)
    await page.setInputFiles('[data-testid=media-input]', FIXTURE_B.path)
    await expect(page.getByTestId('clip')).toHaveCount(2)
  })

  test('is offered on a clip with something before it, and not the first', async ({
    page,
  }) => {
    await page.getByTestId('clip').first().click()
    await expect(page.getByTestId('transition-panel')).toHaveCount(0)

    await page.getByTestId('clip').last().click()
    await expect(page.getByTestId('transition-panel')).toBeVisible()
  })

  test('applying one marks the overlap on the timeline', async ({ page }) => {
    await page.getByTestId('clip').last().click()
    await page.getByTestId('transition-kind').selectOption('crossfade')

    await expect(page.getByTestId('transition-marker')).toHaveCount(1)
    await expect(page.getByTestId('transition-seconds')).toHaveValue('0.5')
  })

  test('choosing none takes it off again', async ({ page }) => {
    await page.getByTestId('clip').last().click()
    await page.getByTestId('transition-kind').selectOption('crossfade')
    await expect(page.getByTestId('transition-marker')).toHaveCount(1)

    await page.getByTestId('transition-kind').selectOption('none')
    await expect(page.getByTestId('transition-marker')).toHaveCount(0)
  })

  test('is undoable like any other edit', async ({ page }) => {
    const before = await page.evaluate(
      () => window.__timelineStore.getState().project,
    )

    await page.getByTestId('clip').last().click()
    await page.getByTestId('transition-kind').selectOption('crossfade')
    await expect(page.getByTestId('transition-marker')).toHaveCount(1)

    await page.keyboard.press('Control+z')
    expect(
      await page.evaluate(
        () => window.__timelineStore.getState().project,
      ),
    ).toEqual(before)
  })
})
