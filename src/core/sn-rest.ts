/**
 * ServiceNow REST executor. Runs in the CONTENT SCRIPT (the ServiceNow page's
 * own origin) so the session cookie is first-party and is actually sent — a
 * background/service-worker fetch is cross-site and ServiceNow's SameSite=Lax
 * session cookie would be withheld, yielding 401 even when the user is logged in.
 *
 * Auth: same-origin cookie for reads; X-UserToken (g_ck) added when available
 * and required for writes. Writes are hard-gated by the prod guard first.
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
} from './api'
import { classifyInstance, type ProdGuardConfig } from './prod-guard'

export interface RestDeps {
  /** X-UserToken (g_ck) for this instance, if captured. */
  token: string | null
  /** Prod-guard config for write gating. */
  guardConfig?: ProdGuardConfig
}

async function safeErrorDetail(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { message?: string; detail?: string } }
    return body.error?.message || body.error?.detail || null
  } catch {
    return null
  }
}

async function apiGet<T>(url: string, deps: RestDeps): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (deps.token) headers['X-UserToken'] = deps.token

  let res: Response
  try {
    res = await fetch(url, { method: 'GET', credentials: 'same-origin', headers })
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${(err as Error).message}` }
  }

  if (res.status === 401) {
    return { ok: false, status: 401, error: 'Not authenticated — log in to the instance in this browser.' }
  }
  if (res.redirected && /login|sso/i.test(res.url)) {
    return { ok: false, status: 401, error: 'Redirected to login — session expired.' }
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: (await safeErrorDetail(res)) || `HTTP ${res.status}` }
  }
  try {
    const body = (await res.json()) as { result: T }
    return { ok: true, data: body.result }
  } catch (err) {
    return { ok: false, status: res.status, error: `Bad JSON: ${(err as Error).message}` }
  }
}

async function apiWrite<T>(
  host: string,
  url: string,
  method: 'POST' | 'DELETE',
  deps: RestDeps,
  body?: unknown,
): Promise<ApiResult<T>> {
  // HARD GATE (handoff §2 decision 5): refuse to write unless sub-prod.
  const verdict = classifyInstance(host, deps.guardConfig)
  if (!verdict.allowed) return { ok: false, status: 403, error: `Prod guard: ${verdict.reason}` }

  if (!deps.token) {
    return {
      ok: false,
      status: 401,
      error: 'Writes need X-UserToken (g_ck), which was not captured on this page. Open a classic ServiceNow form and retry.',
    }
  }
  const headers: Record<string, string> = { Accept: 'application/json', 'X-UserToken': deps.token }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${(err as Error).message}` }
  }

  if (!res.ok) {
    return { ok: false, status: res.status, error: (await safeErrorDetail(res)) || `HTTP ${res.status}` }
  }
  if (res.status === 204) return { ok: true, data: undefined as T }
  try {
    const parsed = (await res.json()) as { result: T }
    return { ok: true, data: parsed.result }
  } catch {
    return { ok: true, data: undefined as T }
  }
}

type RecordRow = Record<string, unknown>

export async function executeApiRequest(
  req: ApiRequest,
  deps: RestDeps,
): Promise<ApiResult<unknown>> {
  switch (req.op) {
    case 'query':
      return apiGet<RecordRow[]>(buildTableQueryUrl(req.host, req.table, req.options), deps)
    case 'record':
      return apiGet<RecordRow>(buildRecordUrl(req.host, req.table, req.sysId, req.fields), deps)
    case 'dictionary':
      return apiGet<DictionaryField[]>(buildDictionaryUrl(req.host, req.table), deps)
    case 'count': {
      const res = await apiGet<{ stats?: { count?: string } }>(
        buildStatsCountUrl(req.host, req.table, req.query),
        deps,
      )
      if (!res.ok) return res
      return { ok: true, data: { count: Number(res.data.stats?.count ?? '0') } }
    }
    case 'create':
      return apiWrite<RecordRow>(req.host, buildCreateUrl(req.host, req.table), 'POST', deps, req.fields)
    case 'delete':
      return apiWrite<void>(req.host, buildRecordUrl(req.host, req.table, req.sysId), 'DELETE', deps)
    default: {
      const _exhaustive: never = req
      return { ok: false, status: 0, error: `Unknown op: ${JSON.stringify(_exhaustive)}` }
    }
  }
}
