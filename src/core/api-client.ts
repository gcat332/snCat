/**
 * Thin client used by extension pages (side panel, runner) to invoke the
 * background REST broker over chrome.runtime messaging. Keeps callers from
 * hand-rolling message envelopes and gives them typed results.
 */
import type {
  ApiRequest,
  ApiResult,
  DictionaryField,
  QueryOptions,
} from './api'
import type { RuntimeMessage } from './types'

/**
 * Inject the declared content scripts into a tab on demand. After the extension
 * is reloaded, previously-injected content scripts become orphaned ("Receiving
 * end does not exist"); re-injecting them self-heals without a manual refresh.
 */
async function ensureContentScripts(tabId: number): Promise<void> {
  const scripts = chrome.runtime.getManifest().content_scripts ?? []
  for (const cs of scripts) {
    const files = cs.js
    if (!files?.length) continue
    const world = (cs as { world?: string }).world === 'MAIN' ? 'MAIN' : 'ISOLATED'
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: cs.all_frames ?? false },
        files,
        world: world as chrome.scripting.ExecutionWorld,
        injectImmediately: true,
      })
    } catch {
      /* already present, or a frame that can't be injected — ignore */
    }
  }
}

async function call<T>(request: ApiRequest): Promise<ApiResult<T>> {
  // Route to the active tab's top-frame content script, which forwards to the
  // page's MAIN world so the fetch is the page's own (session cookie sent — a
  // background/cross-site fetch would drop the SameSite=Lax cookie → 401).
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return { ok: false, status: 0, error: 'No active tab.' }
  const tabId = tab.id

  const send = () =>
    chrome.tabs.sendMessage(
      tabId,
      { kind: 'sncat:api', request } satisfies RuntimeMessage,
      { frameId: 0 },
    ) as Promise<ApiResult<T> | undefined>

  try {
    let res: ApiResult<T> | undefined
    try {
      res = await send()
    } catch (err) {
      // Content script not there (orphaned after reload) → inject and retry once.
      if (/Receiving end does not exist|Could not establish connection/i.test((err as Error).message)) {
        await ensureContentScripts(tabId)
        await new Promise((r) => setTimeout(r, 150))
        res = await send()
      } else {
        throw err
      }
    }
    if (!res) return { ok: false, status: 0, error: 'No response from the ServiceNow page.' }
    return res
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `Can't reach the ServiceNow page — reload the tab, then retry. (${(err as Error).message})`,
    }
  }
}

export function queryRecords(
  host: string,
  table: string,
  options?: QueryOptions,
): Promise<ApiResult<Record<string, unknown>[]>> {
  return call({ op: 'query', host, table, options })
}

export function countRecords(
  host: string,
  table: string,
  query?: string,
): Promise<ApiResult<{ count: number }>> {
  return call({ op: 'count', host, table, query })
}

export function getRecord(
  host: string,
  table: string,
  sysId: string,
  fields?: string[],
): Promise<ApiResult<Record<string, unknown>>> {
  return call({ op: 'record', host, table, sysId, fields })
}

export function getDictionary(
  host: string,
  table: string,
): Promise<ApiResult<DictionaryField[]>> {
  return call({ op: 'dictionary', host, table })
}

/** Read-only raw text GET (e.g. record unload XML). */
export function getText(host: string, url: string): Promise<ApiResult<string>> {
  return call({ op: 'text', host, url })
}

/** Run a server-side background script (prod-guarded). Returns raw HTML. */
export function runBackground(
  host: string,
  script: string,
  opts: { scope?: string; updateSet?: string } = {},
): Promise<ApiResult<string>> {
  return call({ op: 'bgrun', host, script, scope: opts.scope, updateSet: opts.updateSet })
}
