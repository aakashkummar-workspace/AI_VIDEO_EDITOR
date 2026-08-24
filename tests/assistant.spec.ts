import { expect, test, type Page } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

/**
 * Editing by asking.
 *
 * The planning loop runs on the SERVER now - that is where the key is - so what
 * the browser can be shown here is the plan itself. These stub that endpoint,
 * deliberately and permanently: a suite that called a real model would flake on
 * the weather and bill somebody for the privilege.
 *
 * What is worth testing is not whether the model is clever. It is that a plan is
 * held back until somebody approves it, that approving one is a single undo
 * step, and that discarding one leaves the timeline exactly as it was. The other
 * half of the chain - a tool call becoming a real edit - is covered without a
 * browser in `src/assistant/tools.test.ts` and `src/assistant/plan.test.ts`.
 */

const BRIDGE = '**/api/assistant/plan'

const SECOND = 1_000_000

/** A plan as the server sends one: resolved mutator inputs, in microseconds. */
function planOf(steps: unknown[], reply = 'Done as asked.') {
  return { steps, reply }
}

const SPLIT_AT_ONE_SECOND = {
  tool: 'split_segment',
  mutator: 'splitSegmentAt',
  input: { timelineMicros: 1 * SECOND, newSegmentId: 'plan-half' },
  summary: 'split_segment: new segment plan-half',
  label: 'Split "counter-30fps.mp4" at 1.000s',
}

const CAPTION = {
  tool: 'add_text',
  mutator: 'addSegment',
  input: {
    trackId: 'text-1',
    segment: {
      id: 'plan-caption',
      timelineStartMicros: 0,
      content: {
        kind: 'text',
        content: 'Chapter one',
        x: 160,
        y: 120,
        sizePx: 20,
        color: '#ffffff',
        durationMicros: 2 * SECOND,
        align: 'center',
      },
    },
  },
  summary: 'add_text: plan-caption',
  label: 'Add a caption "Chapter one" (0.000s-2.000s)',
}

/** A step naming a segment that is not there, which applyPlan must refuse. */
const IMPOSSIBLE = {
  tool: 'delete_segment',
  mutator: 'removeSegment',
  input: 'no-such-segment',
  summary: 'delete_segment: no-such-segment removed',
  label: 'Delete that segment',
}

async function stubBridge(page: Page, body: unknown, status = 200) {
  await page.route(BRIDGE, async (route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

async function ask(page: Page, request: string) {
  await page.getByTestId('assistant-prompt').fill(request)
  await page.getByTestId('assistant-send').click()
}

/** How many undo steps exist, which is what "one undo step" is measured in. */
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
  await page.setInputFiles('[data-testid=media-input]', FIXTURE.path)
  await expect(page.getByTestId('clip')).toBeVisible()
})

test('asks for nothing: there is no key in the page', async ({ page }) => {
  // The whole point of moving the loop to the server. A field here would mean a
  // secret in a document, which is the thing being avoided.
  await expect(page.getByTestId('assistant-prompt')).toBeVisible()
  await expect(page.getByTestId('assistant-key')).toHaveCount(0)
})

test('says how to fix it when the server has no key', async ({ page }) => {
  await stubBridge(
    page,
    { error: 'No API key on the server. Put ANTHROPIC_API_KEY=sk-ant-... in a .env file at the project root and restart npm run dev.' },
    503,
  )

  await ask(page, 'split the clip')

  // An unconfigured key is how this always starts, so the message has to carry
  // the fix rather than just the failure.
  await expect(page.getByTestId('assistant-error')).toContainText('.env')
  await expect(page.getByTestId('assistant-plan')).toHaveCount(0)
})

test('a plan is shown and nothing happens until it is applied', async ({
  page,
}) => {
  await stubBridge(page, planOf([SPLIT_AT_ONE_SECOND]))

  // Loading the fixture is itself an edit, so what matters is that nothing is
  // added to the history - not that the history is empty.
  const depthBefore = await historyDepth(page)
  await ask(page, 'split the clip at one second')

  await expect(page.getByTestId('assistant-plan')).toBeVisible()
  await expect(page.getByTestId('assistant-step')).toHaveCount(1)

  // Readable, or it is not really being offered for review. Segments carry
  // minted uuids and a plan listing those is one nobody will check.
  const step = await page.getByTestId('assistant-step').first().textContent()
  expect(step).toContain(FIXTURE.path.split('/').pop()!)
  expect(step).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)

  // The timeline is untouched while the plan sits there waiting to be read.
  await expect(page.getByTestId('clip')).toHaveCount(1)
  expect(await historyDepth(page)).toBe(depthBefore)
})

test('applying a plan is one undo step, however many edits it holds', async ({
  page,
}) => {
  await stubBridge(page, planOf([SPLIT_AT_ONE_SECOND, CAPTION]))

  await ask(page, 'split it and title the opening')
  await expect(page.getByTestId('assistant-step')).toHaveCount(2)

  const depthBefore = await historyDepth(page)
  await page.getByTestId('assistant-approve').click()

  await expect(page.getByTestId('clip')).toHaveCount(2)
  await expect(page.getByTestId('overlay-block')).toHaveCount(1)
  expect(await historyDepth(page)).toBe(depthBefore + 1)

  // One keystroke takes the whole run back, or rejecting it would be worse than
  // never having asked.
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('clip')).toHaveCount(1)
  await expect(page.getByTestId('overlay-block')).toHaveCount(0)
})

test('discarding a plan leaves the timeline alone', async ({ page }) => {
  await stubBridge(page, planOf([SPLIT_AT_ONE_SECOND]))

  const depthBefore = await historyDepth(page)
  await ask(page, 'split the clip')
  await page.getByTestId('assistant-discard').click()

  await expect(page.getByTestId('assistant-plan')).toHaveCount(0)
  await expect(page.getByTestId('clip')).toHaveCount(1)
  expect(await historyDepth(page)).toBe(depthBefore)
})

test('a plan that no longer applies is refused whole, not half', async ({
  page,
}) => {
  await stubBridge(page, planOf([SPLIT_AT_ONE_SECOND, IMPOSSIBLE]))

  const depthBefore = await historyDepth(page)
  await ask(page, 'split it and delete something that is gone')
  await page.getByTestId('assistant-approve').click()

  // Half a plan would leave nothing sensible to point undo at, so the good step
  // must not survive either.
  await expect(page.getByTestId('assistant-error')).toBeVisible()
  await expect(page.getByTestId('clip')).toHaveCount(1)
  expect(await historyDepth(page)).toBe(depthBefore)
})

test('a request that fails says so instead of looking finished', async ({
  page,
}) => {
  await stubBridge(page, { error: 'the model was unreachable' }, 500)

  await ask(page, 'split the clip')

  await expect(page.getByTestId('assistant-error')).toContainText('unreachable')
  await expect(page.getByTestId('assistant-busy')).toHaveCount(0)
  await expect(page.getByTestId('assistant-plan')).toHaveCount(0)
})
