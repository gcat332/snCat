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

async function call<T>(request: ApiRequest): Promise<ApiResult<T>> {
  // Route to the active tab's top-frame content script, which runs in the
  // ServiceNow page origin so the session cookie is sent (a background fetch is
  // cross-site and the SameSite=Lax session cookie would be withheld → 401).
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return { ok: false, status: 0, error: 'No active tab.' }
    const res = (await chrome.tabs.sendMessage(
      tab.id,
      { kind: 'sncat:api', request } satisfies RuntimeMessage,
      { frameId: 0 },
    )) as ApiResult<T> | undefined
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

/** Layer 3 WRITE — creates a real record (prod-guarded in the background). */
export function createRecord(
  host: string,
  table: string,
  fields: Record<string, string>,
): Promise<ApiResult<Record<string, unknown>>> {
  return call({ op: 'create', host, table, fields })
}

/** Layer 3 WRITE — deletes a record (prod-guarded in the background). */
export function deleteRecord(
  host: string,
  table: string,
  sysId: string,
): Promise<ApiResult<void>> {
  return call({ op: 'delete', host, table, sysId })
}
