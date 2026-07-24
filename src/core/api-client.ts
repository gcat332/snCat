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
  try {
    const res = (await chrome.runtime.sendMessage({
      kind: 'sncat:api',
      request,
    } satisfies RuntimeMessage)) as ApiResult<T> | undefined
    if (!res) return { ok: false, status: 0, error: 'No response from background.' }
    return res
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message }
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
