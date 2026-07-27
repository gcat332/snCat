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
import type { GFormSnapshot, UserSnapshot } from '@core/types'
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
    g_user?: {
      hasRole?: (role: string) => boolean
      userName?: string
      roles?: string
    }
  }
}

/**
 * Read the effective user's admin status. g_user.hasRole reflects IMPERSONATION,
 * so impersonating a non-admin correctly reports false — that is wanted, not a
 * bug. A missing or throwing g_user yields hasAdmin: null ("could not tell"),
 * which the gate treats as allow-with-warning rather than deny.
 */
function userSnapshot(): UserSnapshot {
  const gu = window.g_user
  if (!gu || typeof gu.hasRole !== 'function') {
    return { hasAdmin: null, userName: gu?.userName ?? null, roles: gu?.roles ?? null }
  }
  try {
    return {
      hasAdmin: !!gu.hasRole('admin'),
      userName: gu.userName ?? null,
      roles: gu.roles ?? null,
    }
  } catch {
    return { hasAdmin: null, userName: gu.userName ?? null, roles: gu.roles ?? null }
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
    user: userSnapshot(),
  }
}

function post() {
  try {
    window.postMessage(snapshot(), window.location.origin)
  } catch {
    /* ignore */
  }
}

// Script-bearing fields we offer to fix: server script, client script, HTML
// template, CSS, UI-action/link scripts. The AI is told the field name (see
// buildFixScriptPrompt), so `template` reads as HTML, `script` as server JS, etc.
const SCRIPT_FIELDS = ['script', 'script_plain', 'client_script', 'template', 'css', 'link']

function tableNameOf(gf: NonNullable<Window['g_form']>): string {
  try {
    return gf.getTableName?.() ?? ''
  } catch {
    return ''
  }
}

/** Where to place the chip: prefer beside the field LABEL (like ServiceNow's own
 *  "script {}" chips); fall back to the field control's container. */
function fieldAnchor(field: string, table: string): { el: Element; after: boolean } | null {
  const label =
    (table && document.getElementById(`label.${table}.${field}`)) ||
    document.querySelector(`label[for="${field}"]`)
  if (label) return { el: label, after: true }
  const control =
    document.getElementById(field) ??
    (table ? document.getElementById(`${table}.${field}`) : null) ??
    document.querySelector(`[id$=".${field}"]`)
  const container = control?.closest('.form-group, td, .sn-widget-list_v2') ?? control?.parentElement
  return container ? { el: container, after: false } : null
}

// Best-effort injection of a "javaHelp" chip next to script fields. NEVER throws
// on the page (see safeInjectFixIcons) — a DOM quirk must not break the g_form
// snapshot / fetch bridge. Idempotency is scoped to the field's live anchor via
// a `data-snjava-fix` attribute, so a fresh render after in-page AJAX navigation
// gets its own chip instead of silently staying chip-less.
function injectFixIcons() {
  const gf = window.g_form
  if (!gf?.getValue) return
  const table = tableNameOf(gf)
  for (const field of SCRIPT_FIELDS) {
    let value: string
    try {
      value = gf.getValue(field)
    } catch {
      continue // field not on this form
    }
    if (typeof value !== 'string') continue
    const spot = fieldAnchor(field, table)
    if (!spot) continue
    const scope = spot.after ? (spot.el.parentElement ?? spot.el) : spot.el
    if (scope.querySelector(`[data-snjava-fix="${field}"]`)) continue
    const chip = document.createElement('span')
    chip.dataset.snjavaFix = field
    chip.textContent = 'javaHelp'
    chip.title = 'snJava — send this script to the AI helper'
    chip.style.cssText =
      'display:inline-flex;align-items:center;margin-left:6px;padding:1px 8px;' +
      'border:1px solid rgba(0,98,236,.4);border-radius:12px;font-size:11px;' +
      "font-family:'SF Mono',Menlo,Consolas,monospace;color:#0062EC;" +
      'background:rgba(0,98,236,.06);cursor:pointer;user-select:none;vertical-align:middle;line-height:16px'
    chip.addEventListener('click', () => {
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
    if (spot.after) spot.el.after(chip)
    else spot.el.appendChild(chip)
  }
}

function safeInjectFixIcons() {
  try {
    injectFixIcons()
  } catch {
    /* never break the page for icon injection */
  }
}

// Post + inject now, then retry: script editors (CodeMirror/Monaco) frequently
// mount well after document_idle, so a single early pass misses them.
post()
safeInjectFixIcons()
for (const ms of [800, 2000, 3500]) {
  setTimeout(() => {
    post()
    safeInjectFixIcons()
  }, ms)
}

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
