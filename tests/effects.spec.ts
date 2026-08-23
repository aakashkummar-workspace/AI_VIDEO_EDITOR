import { expect, test, type Page } from '@playwright/test'
import { wholeSourceSpec } from './fixture.config.mjs'

/**
 * Effects run inside the one render function, so an effect that changes the
 * preview has to change the exported file by exactly the same amount without
 * the export being told anything about it.
 */

const SECOND = 1_000_000

function meanBrightness(pixels: number[]): number {
  let total = 0
  let count = 0
  for (let i = 0; i < pixels.length; i += 4) {
    total += pixels[i]! + pixels[i + 1]! + pixels[i + 2]!
    count += 3
  }
  return total / count
}

/**
 * How far apart the colour channels are, averaged over the image. Colour has a
 * spread; grey does not, whatever its brightness.
 */
function meanChannelSpread(pixels: number[]): number {
  let total = 0
  let count = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!
    const g = pixels[i + 1]!
    const b = pixels[i + 2]!
    total += Math.max(r, g, b) - Math.min(r, g, b)
    count++
  }
  return total / count
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

async function loadClip(page: Page) {
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    wholeSourceSpec('a'),
  )
}

/** Applies edits to the store and republishes the project to the player. */
async function edit(
  page: Page,
  apply: (store: ReturnType<typeof window.__timelineStore.getState>) => void,
) {
  await page.evaluate((source) => {
    const run = new Function('store', `(${source})(store)`) as (
      store: unknown,
    ) => void
    run(window.__timelineStore.getState())
    window.harness.setProject(window.__timelineStore.getState().project)
  }, apply.toString())
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
})

test('an effect at its neutral amount changes nothing at all', async ({
  page,
}) => {
  await loadClip(page)
  const plain = await pixelsAt(page, 2 * SECOND)

  await edit(page, (store) => {
    store.addEffect({ segmentId: 'clip-0', id: 'fx-1', kind: 'brightness' })
    store.addEffect({ segmentId: 'clip-0', id: 'fx-2', kind: 'blur' })
  })

  expect(meanChannelDifference(plain, await pixelsAt(page, 2 * SECOND))).toBe(0)
})

test('grayscale takes the colour out of the picture', async ({ page }) => {
  await loadClip(page)
  const colour = await pixelsAt(page, 2 * SECOND)

  await edit(page, (store) => {
    store.addEffect({
      segmentId: 'clip-0',
      id: 'fx-1',
      kind: 'grayscale',
      amount: 1,
    })
  })
  const grey = await pixelsAt(page, 2 * SECOND)

  console.log(
    `channel spread: colour ${meanChannelSpread(colour).toFixed(1)},` +
      ` grey ${meanChannelSpread(grey).toFixed(1)}`,
  )

  expect(meanChannelSpread(colour)).toBeGreaterThan(20)
  expect(meanChannelSpread(grey)).toBeLessThan(2)
})

test('brightness lifts the picture', async ({ page }) => {
  await loadClip(page)
  const plain = await pixelsAt(page, 2 * SECOND)

  await edit(page, (store) => {
    store.addEffect({
      segmentId: 'clip-0',
      id: 'fx-1',
      kind: 'brightness',
      amount: 1.6,
    })
  })

  expect(meanBrightness(await pixelsAt(page, 2 * SECOND))).toBeGreaterThan(
    meanBrightness(plain) * 1.2,
  )
})

test('the chain applies in order, so reordering changes the result', async ({
  page,
}) => {
  await loadClip(page)

  // Grey first, then saturate: saturating grey leaves it grey.
  await edit(page, (store) => {
    store.addEffect({
      segmentId: 'clip-0',
      id: 'grey',
      kind: 'grayscale',
      amount: 1,
    })
    store.addEffect({
      segmentId: 'clip-0',
      id: 'sat',
      kind: 'saturate',
      amount: 3,
    })
  })
  const greyFirst = await pixelsAt(page, 2 * SECOND)

  // Saturate first, then grey: still grey, but a different grey, because the
  // luminance it collapses to came from boosted colours.
  await edit(page, (store) => {
    store.moveEffect({ segmentId: 'clip-0', effectId: 'sat', index: 0 })
  })
  const satFirst = await pixelsAt(page, 2 * SECOND)

  expect(meanChannelSpread(greyFirst)).toBeLessThan(2)
  expect(meanChannelSpread(satFirst)).toBeLessThan(2)
  expect(meanChannelDifference(greyFirst, satFirst)).toBeGreaterThan(1)
})

test('the export carries the effect', async ({ page }) => {
  await loadClip(page)
  await edit(page, (store) => {
    store.addEffect({
      segmentId: 'clip-0',
      id: 'fx-1',
      kind: 'grayscale',
      amount: 1,
    })
  })

  const preview = await pixelsAt(page, 2 * SECOND)

  await page.evaluate(() => window.harness.exportMp4())
  await page.evaluate(() => window.harness.loadExported())
  const exported = await pixelsAt(page, 2 * SECOND)

  const diff = meanChannelDifference(preview, exported)
  console.log(`export vs preview with grayscale: ${diff.toFixed(3)}`)

  expect(diff).toBeLessThan(3)
  // And the file really is grey, rather than the effect having been dropped.
  expect(meanChannelSpread(exported)).toBeLessThan(3)
})

test('an animated effect ramps across the clip', async ({ page }) => {
  await loadClip(page)
  await edit(page, (store) => {
    store.addEffect({ segmentId: 'clip-0', id: 'fx-1', kind: 'grayscale' })
    store.addEffectKeyframe({
      segmentId: 'clip-0',
      effectId: 'fx-1',
      offsetMicros: 0,
      value: 0,
    })
    store.addEffectKeyframe({
      segmentId: 'clip-0',
      effectId: 'fx-1',
      offsetMicros: 6_000_000,
      value: 1,
    })
  })

  const early = meanChannelSpread(await pixelsAt(page, 1 * SECOND))
  const middle = meanChannelSpread(await pixelsAt(page, 3 * SECOND))
  const late = meanChannelSpread(await pixelsAt(page, 5 * SECOND))

  console.log(
    `desaturating: 1s ${early.toFixed(1)}, 3s ${middle.toFixed(1)},` +
      ` 5s ${late.toFixed(1)}`,
  )

  expect(early).toBeGreaterThan(middle)
  expect(middle).toBeGreaterThan(late)
})
