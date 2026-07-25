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
      getValue?: (f: string) => string
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

const SCRIPT_FIELDS = ['script', 'script_plain', 'client_script']

// Best-effort injection of a 🔧 "fix with AI" icon next to script fields on
// classic ServiceNow forms. This must NEVER throw on the page — a DOM quirk
// here must not break the g_form snapshot / fetch bridge above. Idempotency
// is scoped to the CURRENT mount's DOM (via a `data-snjava-fix` attribute on
// the icon itself), not a module-level record of field names — that way a
// fresh render after in-page AJAX navigation (classic UI record switch) gets
// its own icon instead of silently staying icon-less forever.
function injectFixIcons() {
  const gf = window.g_form
  if (!gf?.getValue) return
  for (const field of SCRIPT_FIELDS) {
    let value: string
    try {
      value = gf.getValue(field)
    } catch {
      continue // field not on this form
    }
    if (typeof value !== 'string') continue
    // The field control's element id is the field name, but classic forms often
    // qualify it with the table (e.g. "sys_script.script"). Try both, plus a
    // suffix match, so the icon lands regardless of the id convention.
    const table = (() => {
      try {
        return gf.getTableName?.() ?? ''
      } catch {
        return ''
      }
    })()
    const control =
      document.getElementById(field) ??
      (table ? document.getElementById(`${table}.${field}`) : null) ??
      document.querySelector(`[id$=".${field}"]`)
    const mount = control?.closest('.form-group, td, .sn-widget-list_v2') ?? control?.parentElement
    if (!mount) continue
    if (mount.querySelector(`[data-snjava-fix="${field}"]`)) continue
    const icon = document.createElement('span')
    icon.dataset.snjavaFix = field
    icon.textContent = '🔧'
    icon.title = 'snJava — fix this script with AI'
    icon.style.cssText = 'cursor:pointer;margin-left:6px;font-size:14px;user-select:none'
    icon.addEventListener('click', () => {
      let script = ''
      try {
        script = gf.getValue!(field)
      } catch {
        return
      }
      window.postMessage(
        {
          kind: 'sncat:fix-script',
          payload: {
            table: gf.getTableName?.() ?? null,
            sysId: gf.getUniqueValue?.() ?? null,
            field,
            script,
          },
        },
        window.location.origin,
      )
    })
    mount.appendChild(icon)
  }
}

function safeInjectFixIcons() {
  try {
    injectFixIcons()
  } catch {
    /* never break the page for icon injection */
  }
}

// Post once now, and again shortly after in case g_form initializes late.
post()
safeInjectFixIcons()
setTimeout(() => {
  post()
  safeInjectFixIcons()
}, 800)

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
