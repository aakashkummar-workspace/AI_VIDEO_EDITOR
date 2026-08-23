import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_MUSIC, FIXTURE_TONES } from './fixture.config.mjs'

/**
 * Waveforms, and the three controls that had operations but no buttons.
 */

/** How much of a waveform canvas has been drawn on. */
async function inkedColumns(page: Page, index = 0): Promise<number> {
  return page.evaluate((at) => {
    const canvas = document.querySelectorAll('canvas.timeline-waveform')[at] as
      | HTMLCanvasElement
      | undefined
    if (!canvas) return -1

    const context = canvas.getContext('2d')
    if (!context) return -1

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let columns = 0
    for (let x = 0; x < canvas.width; x++) {
      for (let y = 0; y < canvas.height; y++) {
        if (data[(y * canvas.width + x) * 4 + 3]! > 0) {
          columns++
          break
        }
      }
    }
    return columns
  }, index)
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

test('a music block grows a waveform once it has been measured', async ({
  page,
}) => {
  await page.setInputFiles('[data-testid=media-input]', FIXTURE_MUSIC.path)
  await expect(page.getByTestId('audio-block')).toHaveCount(1)

  await expect(page.getByTestId('waveform')).toHaveCount(1)
  await expect.poll(() => inkedColumns(page)).toBeGreaterThan(20)
})

test('a clip with sound gets one too, and a silent one does not', async ({
  page,
}) => {
  // The counter fixture carries no audio at all.
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toHaveCount(1)
  await page.waitForTimeout(600)
  await expect(page.getByTestId('waveform')).toHaveCount(0)

  // The tone fixture does.
  await page.setInputFiles(
    '[data-testid=media-input]',
    FIXTURE_TONES.path,
  )
  await expect(page.getByTestId('clip')).toHaveCount(2)
  await expect(page.getByTestId('waveform')).toHaveCount(1)
  await expect.poll(() => inkedColumns(page)).toBeGreaterThan(20)
})

test('trimming re-slices the same measurements', async ({ page }) => {
  await page.setInputFiles('[data-testid=media-input]', FIXTURE_MUSIC.path)
  await expect(page.getByTestId('waveform')).toHaveCount(1)
  await expect.poll(() => inkedColumns(page)).toBeGreaterThan(20)

  const before = await page.evaluate(() => {
    const canvas = document.querySelector(
      'canvas.timeline-waveform',
    ) as HTMLCanvasElement
    return canvas.width
  })

  // Trim the tail in; the block narrows and so does its waveform, without
  // anything being measured again.
  await page.evaluate(() => {
    const store = window.__timelineStore.getState()
    const segment = store.project.tracks.flatMap((t) => t.segments)[0]!
    store.trimSegmentEnd({
      segmentId: segment.id,
      timelineMicros: segment.timelineStartMicros + 1_000_000,
    })
  })

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const canvas = document.querySelector(
          'canvas.timeline-waveform',
        ) as HTMLCanvasElement | null
        return canvas?.width ?? -1
      }),
    )
    .toBeLessThan(before)

  expect(await inkedColumns(page)).toBeGreaterThan(5)
})

test.describe('the controls that had no buttons', () => {
  test.beforeEach(async ({ page }) => {
    await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
    await expect(page.getByTestId('clip')).toBeVisible()
  })

  test('a row can be moved up and down the stack', async ({ page }) => {
    const kinds = () =>
      page.evaluate(() =>
        window.__timelineStore
          .getState()
          .project.tracks.map((track) => track.kind),
      )

    expect(await kinds()).toEqual(['audio', 'video', 'text'])

    // The list is drawn top of the stack first, so the video row's "up"
    // should put it above the text row.
    await page
      .getByTestId('track-up')
      .and(page.locator('[data-track-id=video-1]'))
      .click()
    expect(await kinds()).toEqual(['audio', 'text', 'video'])

    await page
      .getByTestId('track-down')
      .and(page.locator('[data-track-id=video-1]'))
      .click()
    expect(await kinds()).toEqual(['audio', 'video', 'text'])
  })

  test('the topmost and bottommost rows cannot go further', async ({
    page,
  }) => {
    await expect(
      page.getByTestId('track-up').and(page.locator('[data-track-id=text-1]')),
    ).toBeDisabled()
    await expect(
      page
        .getByTestId('track-down')
        .and(page.locator('[data-track-id=audio-1]')),
    ).toBeDisabled()
  })

  test('an effect can be moved along the chain', async ({ page }) => {
    await page.getByTestId('clip').click()
    await page.getByTestId('add-effect').selectOption('blur')
    await page.getByTestId('add-effect').selectOption('contrast')

    const order = () =>
      page.evaluate(() =>
        (
          window.__timelineStore
            .getState()
            .project.tracks.flatMap((t) => t.segments)[0]!.effects ?? []
        ).map((effect) => effect.kind),
      )

    expect(await order()).toEqual(['blur', 'contrast'])

    await page.getByTestId('effect-up-contrast').click()
    expect(await order()).toEqual(['contrast', 'blur'])

    await page.getByTestId('effect-down-contrast').click()
    expect(await order()).toEqual(['blur', 'contrast'])
  })

  test('the ends of the chain cannot go further', async ({ page }) => {
    await page.getByTestId('clip').click()
    await page.getByTestId('add-effect').selectOption('blur')

    await expect(page.getByTestId('effect-up-blur')).toBeDisabled()
    await expect(page.getByTestId('effect-down-blur')).toBeDisabled()
  })

  test('every keyframe can be cleared at once', async ({ page }) => {
    await page.getByTestId('clip').click()
    await expect(page.getByTestId('clear-keyframes')).toHaveCount(0)

    await page.getByTestId('keyframe-scale').click()
    await page.getByTestId('keyframe-opacity').click()
    await expect(page.getByTestId('clear-keyframes')).toBeVisible()

    await page.getByTestId('clear-keyframes').click()

    expect(
      await page.evaluate(
        () =>
          window.__timelineStore
            .getState()
            .project.tracks.flatMap((t) => t.segments)[0]!.keyframes,
      ),
    ).toEqual({})
    await expect(page.getByTestId('clear-keyframes')).toHaveCount(0)
  })

  test('clearing keyframes is one undo step', async ({ page }) => {
    await page.getByTestId('clip').click()
    await page.getByTestId('keyframe-scale').click()

    const before = await page.evaluate(
      () => window.__timelineStore.getState().project,
    )

    await page.getByTestId('clear-keyframes').click()
    await page.keyboard.press('Control+z')

    expect(
      await page.evaluate(() => window.__timelineStore.getState().project),
    ).toEqual(before)
  })
})
