/**
 * MAIN-world bridge. Runs in the page's own JS context (world: 'MAIN') so it can:
 *   - read window.g_form / window.g_ck (table, sys_id, X-UserToken)
 *   - perform REST fetches AS THE PAGE, so the ServiceNow session cookie is sent
 *     exactly like the instance's own UI calls (an isolated-world or background
 *     fetch is treated as cross-site and the SameSite=Lax cookie is withheld →
 *     401 even when logged in).
 *
 * It has no chrome.* access, so it relays via window.postMessage; the isolated
 * content script (content/index.ts) bridges to the extension.
 */
import type { GFormSnapshot } from '@core/types'
import type { ApiRequest, ApiResult } from '@core/api'
import type { ProdGuardConfig } from '@core/prod-guard'
import { executeApiRequest } from '@core/sn-rest'

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

interface FetchMessage {
  kind: 'sncat:fetch'
  id: string
  request: ApiRequest
  guardConfig?: ProdGuardConfig
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data as { kind?: string } | undefined
  if (data?.kind === 'sncat:request-g_form') {
    post()
    return
  }
  if (data?.kind === 'sncat:fetch') {
    const msg = event.data as FetchMessage
    executeApiRequest(msg.request, {
      token: typeof window.g_ck === 'string' ? window.g_ck : null,
      guardConfig: msg.guardConfig,
    })
      .then((result: ApiResult<unknown>) => {
        window.postMessage({ kind: 'sncat:fetch-result', id: msg.id, result }, window.location.origin)
      })
      .catch((err: unknown) => {
        window.postMessage(
          { kind: 'sncat:fetch-result', id: msg.id, result: { ok: false, status: 0, error: (err as Error).message } },
          window.location.origin,
        )
      })
  }
})

export {}
