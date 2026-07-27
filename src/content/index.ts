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
import type { ApiResult } from '@core/api'
import { DEFAULT_PROD_GUARD_CONFIG, type ProdGuardConfig } from '@core/prod-guard'

let lastGForm: GFormSnapshot | null = null

// Pending REST calls forwarded to the MAIN world, keyed by id.
const pending = new Map<string, (result: ApiResult<unknown>) => void>()
let apiSeq = 0

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

// Listen to the MAIN world: g_form snapshots and REST fetch results.
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data as
    | GFormSnapshot
    | { kind: 'sncat:fetch-result'; id: string; result: ApiResult<unknown> }
    | { kind: 'sncat:fix-script'; payload?: unknown }
    | undefined

  if (data?.kind === 'sncat:g_form') {
    lastGForm = data
    if (data.gCk) {
      chrome.storage.session.set({ [`gck:${location.host}`]: data.gCk }).catch(() => {})
    }
  } else if (data?.kind === 'sncat:fetch-result') {
    const resolve = pending.get(data.id)
    if (resolve) {
      pending.delete(data.id)
      resolve(data.result)
    }
  } else if (data?.kind === 'sncat:fix-script') {
    const p = (event.data as { payload?: unknown }).payload
    // Route to the background: content scripts CANNOT write chrome.storage.session
    // by default (its access level is TRUSTED_CONTEXTS), so a direct set() here
    // silently fails. The background (trusted) stashes it + opens the panel.
    chrome.runtime.sendMessage({ kind: 'snjava:fix-script', payload: p }).catch(() => {})
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
      // Forward to the MAIN world, which fetches as the page (cookie is sent).
      loadGuardConfig().then((guardConfig) => {
        const id = `api_${++apiSeq}`
        pending.set(id, sendResponse)
        window.postMessage(
          { kind: 'sncat:fetch', id, request: message.request, guardConfig },
          location.origin,
        )
        // Safety timeout so a lost reply doesn't hang the caller forever.
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            sendResponse({ ok: false, status: 0, error: 'ServiceNow page did not respond (timeout).' })
          }
        }, 20000)
      })
      return true
    }
    return undefined
  },
)
