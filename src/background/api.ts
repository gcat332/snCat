/**
 * Authenticated ServiceNow REST client, run in the service worker.
 *
 * Auth (handoff §5): reuse the browser session cookie via credentials:'include'
 * (host_permissions grants cross-origin + cookie access). When available, also
 * send X-UserToken (g_ck) — captured by the MAIN-world bridge and stashed in
 * chrome.storage.session by the content script. GET reads work with the cookie
 * alone; g_ck is required for writes and hardens some endpoints.
 */
import {
  buildTableQueryUrl,
  buildRecordUrl,
  buildStatsCountUrl,
  buildDictionaryUrl,
  buildCreateUrl,
  type ApiRequest,
  type ApiResult,
  type DictionaryField,
} from '@core/api'
import { classifyInstance, DEFAULT_PROD_GUARD_CONFIG, type ProdGuardConfig } from '@core/prod-guard'

async function getUserToken(host: string): Promise<string | null> {
  try {
    const store = await chrome.storage.session.get(`gck:${host}`)
    const token = store[`gck:${host}`]
    return typeof token === 'string' ? token : null
  } catch {
    return null
  }
}

async function apiGet<T>(host: string, url: string): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = await getUserToken(host)
  if (token) headers['X-UserToken'] = token

  let res: Response
  try {
    res = await fetch(url, { method: 'GET', credentials: 'include', headers })
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${(err as Error).message}` }
  }

  if (res.status === 401) {
    return { ok: false, status: 401, error: 'Not authenticated — log in to the instance in this browser.' }
  }
  if (!res.ok) {
    const detail = await safeErrorDetail(res)
    return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` }
  }

  try {
    const body = (await res.json()) as { result: T }
    return { ok: true, data: body.result }
  } catch (err) {
    return { ok: false, status: res.status, error: `Bad JSON: ${(err as Error).message}` }
  }
}

/** Load prod-guard config (defaults + any user overrides in local storage). */
async function loadGuardConfig(): Promise<ProdGuardConfig> {
  try {
    const store = await chrome.storage.local.get('prodGuardConfig')
    const override = store['prodGuardConfig'] as Partial<ProdGuardConfig> | undefined
    if (override?.subProdPatterns?.length) {
      return { subProdPatterns: override.subProdPatterns }
    }
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_PROD_GUARD_CONFIG
}

/** A write (POST/DELETE). Hard-blocked by the prod guard before any network I/O. */
async function apiWrite<T>(
  host: string,
  url: string,
  method: 'POST' | 'DELETE',
  body?: unknown,
): Promise<ApiResult<T>> {
  // HARD GATE (handoff §2 decision 5): refuse to write unless sub-prod.
  const verdict = classifyInstance(host, await loadGuardConfig())
  if (!verdict.allowed) {
    return { ok: false, status: 403, error: `Prod guard: ${verdict.reason}` }
  }

  const token = await getUserToken(host)
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: 'Writes need X-UserToken (g_ck). Open a classic ServiceNow page in this tab so the token can be captured, then retry.',
    }
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-UserToken': token,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(url, {
      method,
      credentials: 'include',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${(err as Error).message}` }
  }

  if (!res.ok) {
    const detail = await safeErrorDetail(res)
    return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` }
  }
  // DELETE returns 204 no content.
  if (res.status === 204) return { ok: true, data: undefined as T }
  try {
    const parsed = (await res.json()) as { result: T }
    return { ok: true, data: parsed.result }
  } catch {
    return { ok: true, data: undefined as T }
  }
}

async function safeErrorDetail(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { message?: string; detail?: string } }
    return body.error?.message || body.error?.detail || null
  } catch {
    return null
  }
}

type RecordRow = Record<string, unknown>

export async function handleApiRequest(req: ApiRequest): Promise<ApiResult<unknown>> {
  switch (req.op) {
    case 'query':
      return apiGet<RecordRow[]>(req.host, buildTableQueryUrl(req.host, req.table, req.options))

    case 'record':
      return apiGet<RecordRow>(
        req.host,
        buildRecordUrl(req.host, req.table, req.sysId, req.fields),
      )

    case 'dictionary':
      return apiGet<DictionaryField[]>(req.host, buildDictionaryUrl(req.host, req.table))

    case 'count': {
      const res = await apiGet<{ stats?: { count?: string } }>(
        req.host,
        buildStatsCountUrl(req.host, req.table, req.query),
      )
      if (!res.ok) return res
      const count = Number(res.data.stats?.count ?? '0')
      return { ok: true, data: { count } }
    }

    case 'create':
      return apiWrite<RecordRow>(req.host, buildCreateUrl(req.host, req.table), 'POST', req.fields)

    case 'delete':
      return apiWrite<void>(
        req.host,
        buildRecordUrl(req.host, req.table, req.sysId),
        'DELETE',
      )

    default: {
      const _exhaustive: never = req
      return { ok: false, status: 0, error: `Unknown op: ${JSON.stringify(_exhaustive)}` }
    }
  }
}
