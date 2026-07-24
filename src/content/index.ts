/**
 * Isolated content script. Resolves page context two ways and merges them:
 *   1. URL parsing (parseServiceNowContext) — works everywhere, primary source.
 *   2. g_form snapshot from the MAIN-world bridge — fills gaps on classic forms
 *      where the URL is ambiguous, and carries g_ck for later REST use.
 *
 * The side panel asks for context via chrome.runtime message; we answer with the
 * best current PageContext.
 */
import { parseServiceNowContext } from '@core/context'
import type { GFormSnapshot, PageContext, RuntimeMessage } from '@core/types'

let lastGForm: GFormSnapshot | null = null

// Cache g_ck for the background/REST layer to pick up later (handoff §5).
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data as GFormSnapshot | undefined
  if (data?.kind === 'sncat:g_form') {
    lastGForm = data
    if (data.gCk) {
      chrome.storage.session
        .set({ [`gck:${location.host}`]: data.gCk })
        .catch(() => {})
    }
  }
})

function resolveContext(): PageContext | null {
  const fromUrl = parseServiceNowContext(location.href)

  // If the URL already identified a record, trust it (it's the most specific).
  if (fromUrl && fromUrl.table && (fromUrl.sysId || fromUrl.view !== 'form')) {
    return fromUrl
  }

  // Otherwise, let g_form fill in the identity if it has one.
  if (lastGForm?.table) {
    return {
      host: location.host,
      table: lastGForm.table,
      sysId: lastGForm.sysId,
      view: lastGForm.sysId ? 'form' : 'unknown',
      ui: fromUrl?.ui ?? 'unknown',
      url: location.href,
      source: 'g_form',
    }
  }

  return fromUrl
}

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, _sender, sendResponse) => {
    if (message.kind === 'sncat:get-context') {
      // Ask the MAIN world for a fresh snapshot, then answer.
      window.postMessage({ kind: 'sncat:request-g_form' }, location.origin)
      // Small delay so a late g_form reply can land before we respond.
      setTimeout(() => {
        const context = resolveContext()
        sendResponse({ kind: 'sncat:context', context } satisfies RuntimeMessage)
      }, 120)
      return true // keep the message channel open for the async response
    }
    return undefined
  },
)
