import { expect, test, type Page } from '@playwright/test'

/**
 * Dark mode and light mode.
 *
 * The point of these is that the theme reaches the PAINT. An attribute on the
 * root element is easy to set and proves nothing on its own - every assertion
 * below reads a colour back off a real element, so a token the stylesheet
 * forgot to use fails here rather than in somebody's eyes.
 */

/** What the document is actually wearing, as opposed to what was asked for. */
function wornTheme(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.theme)
}

/** A resolved colour, straight off the element that shows it. */
function paintOf(page: Page, selector: string, property: string) {
  return page.evaluate(
    ([sel, prop]) =>
      getComputedStyle(document.querySelector(sel)!).getPropertyValue(prop),
    [selector, property] as const,
  )
}

async function choose(page: Page, preference: string) {
  await page.getByTestId('theme').selectOption(preference)
  await expect(page.getByTestId('theme')).toHaveValue(preference)
  // The attribute is written by an effect, so wait for it rather than for a
  // frame that may not have happened yet. What "system" resolves to is the
  // business of the test that asked for it.
  if (preference !== 'system') {
    await expect.poll(() => wornTheme(page)).toBe(preference)
  }
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

test('dark is what an editor wears until asked otherwise', async ({ page }) => {
  // Not "follow the system": a bright surround makes footage look darker and
  // flatter than it is, so the default is the one that tells the truth.
  await expect(page.getByTestId('theme')).toHaveValue('dark')
  expect(await wornTheme(page)).toBe('dark')
  expect(await paintOf(page, 'body', 'background-color')).toBe('rgb(0, 0, 0)')
})

test('light repaints the chrome, not just the attribute', async ({ page }) => {
  await choose(page, 'light')

  expect(await paintOf(page, 'body', 'background-color')).toBe(
    'rgb(244, 245, 247)',
  )
  // Panels, borders and dimmed text are separate tokens; a palette that only
  // swapped the background would leave pale text on white.
  expect(await paintOf(page, '.topbar', 'background-color')).toBe(
    'rgb(255, 255, 255)',
  )
  expect(await paintOf(page, 'body', 'color')).toBe('rgb(28, 31, 38)')
  expect(await paintOf(page, '.panel-title', 'color')).toBe('rgb(93, 100, 112)')
})

test('native controls are told which theme they are in', async ({ page }) => {
  // Scrollbars, select menus and number spinners are drawn by the browser and
  // ignore every token; color-scheme is the only thing they listen to.
  expect(await paintOf(page, ':root', 'color-scheme')).toBe('dark')
  await choose(page, 'light')
  expect(await paintOf(page, ':root', 'color-scheme')).toBe('light')
})

test('the choice outlives the tab', async ({ page }) => {
  await choose(page, 'light')
  await page.reload()
  await expect(page.getByTestId('storage-panel')).toHaveAttribute(
    'data-restored',
    'true',
  )

  await expect(page.getByTestId('theme')).toHaveValue('light')
  expect(await wornTheme(page)).toBe('light')
  expect(await paintOf(page, 'body', 'background-color')).toBe(
    'rgb(244, 245, 247)',
  )
})

test('the theme is set before the page is painted', async ({ page }) => {
  await choose(page, 'light')

  // Read the attribute at the earliest moment a script can run in the document
  // rather than after load: an app that only sets it from React shows a dark
  // frame to every light-mode user on every reload.
  const atParseTime = await page.evaluate(async () => {
    return new Promise<string | undefined>((resolve) => {
      const frame = document.createElement('iframe')
      frame.src = location.href
      frame.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px'
      frame.addEventListener('load', () => {
        resolve(frame.contentDocument?.documentElement.dataset.theme)
        frame.remove()
      })
      document.body.append(frame)
    })
  })

  expect(atParseTime).toBe('light')
})

test('system follows the desktop, in both directions', async ({ page }) => {
  await choose(page, 'system')

  // Dark first. The test browser starts light, so this way round each step is
  // a real transition rather than an assertion that nothing changed.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => wornTheme(page)).toBe('dark')
  expect(await paintOf(page, 'body', 'background-color')).toBe('rgb(0, 0, 0)')

  // And back, live, without a reload - a desktop can change theme under a tab
  // that is already open, at sunset if nothing else.
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => wornTheme(page)).toBe('light')
  expect(await paintOf(page, 'body', 'background-color')).toBe(
    'rgb(244, 245, 247)',
  )
})

/*
 * The theme describes the editor, not the film. Somebody opening a project you
 * saved should get the timeline and their own paint - which is easy to break
 * later by adding a theme field to the store, and silent when it breaks.
 */
test('the theme does not travel in a draft', async ({ page }) => {
  await choose(page, 'light')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('save-draft').click(),
  ])
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const draft = Buffer.concat(chunks).toString('utf8')

  expect(JSON.parse(draft)).not.toHaveProperty('theme')
  expect(draft).not.toMatch(/theme|light/i)
})

test('a preference nobody wrote is not worn', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('video-editor:theme', 'sepia'))
  await page.reload()
  await expect(page.getByTestId('storage-panel')).toHaveAttribute(
    'data-restored',
    'true',
  )

  await expect(page.getByTestId('theme')).toHaveValue('dark')
  expect(await wornTheme(page)).toBe('dark')
})
