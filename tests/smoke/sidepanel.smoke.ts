import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

// Resolve the emitted side-panel path from the built manifest (hashed by @crxjs).
const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8')) as {
  side_panel: { default_path: string }
}
const panelPath = manifest.side_panel.default_path

// Minimal chrome.* shim injected before the panel's scripts run, so it can boot
// without a real extension host. Everything returns benign empty stubs.
function chromeShim() {
  const noop = () => {}
  const listener = { addListener: noop, removeListener: noop, hasListener: () => false }
  // @ts-expect-error test shim on window
  window.chrome = {
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {}, onChanged: listener },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    runtime: {
      sendMessage: async () => undefined,
      onMessage: listener,
      getManifest: () => ({ content_scripts: [] }),
      getURL: (p: string) => p,
      id: 'smoke',
      lastError: undefined,
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => undefined,
      onActivated: listener,
      onUpdated: listener,
      onRemoved: listener,
    },
    action: { onClicked: listener },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    scripting: { executeScript: async () => [] },
  }
}

test('side panel boots without errors and renders its tabs', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })

  await page.addInitScript(chromeShim)
  await page.goto(`/${panelPath}`)

  // Tab shell renders. Real labels confirmed against src/sidepanel/index.html
  // (Inspect / Tester / Generate / Spec / Settings — not the Design Spec /
  // Script Tester / XML defaults). Scoped to role=tab to avoid ambiguity with
  // in-panel headings that reuse the same words (e.g. "Condition Tester").
  await expect(page.getByRole('tab', { name: 'Inspect', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Tester', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Spec', exact: true })).toBeVisible()

  // Hard gate: nothing threw and nothing logged an error during boot.
  expect(errors, errors.join('\n')).toEqual([])
})
