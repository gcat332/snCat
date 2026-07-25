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

async function apiGetText(url: string, deps: RestDeps): Promise<ApiResult<string>> {
  const headers: Record<string, string> = {}
  if (deps.token) headers['X-UserToken'] = deps.token
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', credentials: 'same-origin', headers })
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${(err as Error).message}` }
  }
  if (res.status === 401) return { ok: false, status: 401, error: 'Not authenticated.' }
  if (res.redirected && /login|sso/i.test(res.url)) {
    return { ok: false, status: 401, error: 'Redirected to login — session expired.' }
  }
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
  return { ok: true, data: await res.text() }
}

/**
 * Run a server-side background script via the classic sys.scripts.do form.
 * This executes REAL code on the instance (Rhino), so it is prod-guarded and
 * needs the session's g_ck. Returns the raw HTML response for the caller to
 * extract output from.
 */
async function apiBgRun(
  host: string,
  script: string,
  deps: RestDeps,
  opts: { scope?: string; updateSet?: string } = {},
): Promise<ApiResult<string>> {
  const verdict = classifyInstance(host, deps.guardConfig)
  if (!verdict.allowed) return { ok: false, status: 403, error: `Prod guard: ${verdict.reason}` }
  if (!deps.token) {
    return { ok: false, status: 401, error: 'Background run needs g_ck; open a classic ServiceNow page and retry.' }
  }
  // Run inside the chosen update set by switching it at the top of the script.
  const full = opts.updateSet
    ? `new GlideUpdateSet().set(${JSON.stringify(opts.updateSet)});\n${script}`
    : script
  const body = new URLSearchParams()
  body.set('script', full)
  body.set('sysparm_ck', deps.token)
  body.set('runscript', 'Run script')
  body.set('quota_managed_transaction', 'on')
  if (opts.scope) body.set('sys_scope', opts.scope)

  let res: Response
  try {
    res = await fetch(`https://${host}/sys.scripts.do`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${(err as Error).message}` }
  }
  if (res.redirected && /login|sso/i.test(res.url)) {
    return { ok: false, status: 401, error: 'Redirected to login — session expired.' }
  }
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
  return { ok: true, data: await res.text() }
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
    case 'text':
      return apiGetText(req.url, deps)
    case 'bgrun':
      return apiBgRun(req.host, req.script, deps, { scope: req.scope, updateSet: req.updateSet })
    default: {
      const _exhaustive: never = req
      return { ok: false, status: 0, error: `Unknown op: ${JSON.stringify(_exhaustive)}` }
    }
  }
}
