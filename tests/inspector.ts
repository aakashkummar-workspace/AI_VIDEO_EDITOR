import type { Page } from '@playwright/test'

/**
 * Reaching a panel in the tabbed inspector.
 *
 * The inspector is one aspect per tab, so a panel is only in the document
 * while its own tab is open. Tests that used to find every field at once go
 * through here instead - one helper rather than a tab click copied into every
 * spec, so a change to how the tabs work lands in one place.
 */
export type InspectorTab = 'clip' | 'audio' | 'effects' | 'text'

export async function openTab(page: Page, tab: InspectorTab): Promise<void> {
  await page.getByTestId(`tab-${tab}`).click()
}
