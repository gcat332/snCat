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
import { executeApiRequest } from '@core/sn-rest'
import { DEFAULT_PROD_GUARD_CONFIG, type ProdGuardConfig } from '@core/prod-guard'

let lastGForm: GFormSnapshot | null = null

async function loadGuardConfig(): Promise<ProdGuardConfig> {
  try {
    const store = await chrome.storage.local.get('prodGuardConfig')
    const override = store['prodGuardConfig'] as Partial<ProdGuardConfig> | undefined
    if (override?.subProdPatterns?.length) return { subProdPatterns: override.subProdPatterns }
  } catch {
    /* defaults */
  }
  return DEFAULT_PROD_GUARD_CONFIG
}

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

    if (message.kind === 'sncat:api') {
      // Execute the REST call HERE (page origin) so the session cookie is sent.
      loadGuardConfig().then((guardConfig) => {
        executeApiRequest(message.request, { token: lastGForm?.gCk ?? null, guardConfig })
          .then(sendResponse)
          .catch((err: unknown) =>
            sendResponse({ ok: false, status: 0, error: (err as Error).message }),
          )
      })
      return true
    }
    return undefined
  },
)
