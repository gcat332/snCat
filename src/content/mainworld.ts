/**
 * MAIN-world bridge. Runs in the page's own JS context (world: 'MAIN') so it can
 * read ServiceNow globals the isolated content script cannot see:
 *   - window.g_form  → table + sys_id on classic form pages
 *   - window.g_ck    → X-UserToken for authenticated REST calls (handoff §5)
 *
 * It cannot use chrome.* APIs, so it relays via window.postMessage; the isolated
 * content script (content/index.ts) listens for the 'sncat:g_form' message.
 */
import type { GFormSnapshot } from '@core/types'

declare global {
  interface Window {
    g_form?: {
      getTableName?: () => string
      getUniqueValue?: () => string
    }
    g_ck?: string
  }
}

function snapshot(): GFormSnapshot {
  const gf = window.g_form
  let table: string | null = null
  let sysId: string | null = null
  try {
    table = gf?.getTableName?.() ?? null
    sysId = gf?.getUniqueValue?.() ?? null
  } catch {
    /* g_form present but not ready */
  }
  return {
    kind: 'sncat:g_form',
    table: table || null,
    sysId: sysId || null,
    gCk: typeof window.g_ck === 'string' ? window.g_ck : null,
  }
}

function post() {
  try {
    window.postMessage(snapshot(), window.location.origin)
  } catch {
    /* ignore */
  }
}

// Post once now, and again shortly after in case g_form initializes late.
post()
setTimeout(post, 800)

// Respond to explicit refresh requests from the isolated content script.
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  if ((event.data as { kind?: string })?.kind === 'sncat:request-g_form') post()
})

export {}
