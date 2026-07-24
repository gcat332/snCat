import { describe, it, expect, vi, afterEach } from 'vitest'
import { executeApiRequest, type RestDeps } from './sn-rest'

/** Default deps: g_ck token present, no custom guard config. */
const deps: RestDeps = { token: 'g_ck', guardConfig: undefined }

/** Sub-prod host — passes the prod guard. */
const SUBPROD = 'mfecplcdemo10.service-now.com'
/** Prod host — blocked by the prod guard. */
const PROD = 'acmeprod.service-now.com'

/** A ServiceNow "session expired" response: 302→200 login page that fetch followed. */
function loginRedirectResponse(): Partial<Response> {
  return {
    ok: true,
    status: 200,
    redirected: true,
    url: 'https://x.service-now.com/login.do',
    text: async () => '<html><body>Login here</body></html>',
    json: async () => ({}),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('executeApiRequest — session-expired login redirect (T-202)', () => {
  it('(a) op "text": treats a followed login redirect as 401, not real data', async () => {
    const fetchMock = vi.fn(async () => loginRedirectResponse() as Response)
    vi.stubGlobal('fetch', fetchMock)

    const res = await executeApiRequest(
      { op: 'text', host: SUBPROD, url: `https://${SUBPROD}/incident.do?XML` },
      deps,
    )

    expect(res.ok).toBe(false)
    expect(res).toMatchObject({ ok: false, status: 401 })
  })

  it('(b) op "bgrun": treats a followed login redirect as 401, not ok data', async () => {
    const fetchMock = vi.fn(async () => loginRedirectResponse() as Response)
    vi.stubGlobal('fetch', fetchMock)

    const res = await executeApiRequest(
      { op: 'bgrun', host: SUBPROD, script: 'gs.print("hi");' },
      deps,
    )

    expect(res.ok).toBe(false)
    expect(res).toMatchObject({ ok: false, status: 401 })
  })
})

describe('executeApiRequest — bgrun guards fire before any I/O (T-202)', () => {
  it('(c) op "bgrun" on a prod host: 403 and fetch never called', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await executeApiRequest(
      { op: 'bgrun', host: PROD, script: 'gs.print("hi");' },
      deps,
    )

    expect(res).toMatchObject({ ok: false, status: 403 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('(d) op "bgrun" with token:null on a sub-prod host: 401 and fetch never called', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await executeApiRequest(
      { op: 'bgrun', host: SUBPROD, script: 'gs.print("hi");' },
      { token: null, guardConfig: undefined },
    )

    expect(res).toMatchObject({ ok: false, status: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('executeApiRequest — happy path (T-202)', () => {
  it('(e) op "text": a non-redirected ok response returns the body as data', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      redirected: false,
      url: `https://${SUBPROD}/incident.do?XML`,
      text: async () => '<record>real data</record>',
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    const res = await executeApiRequest(
      { op: 'text', host: SUBPROD, url: `https://${SUBPROD}/incident.do?XML` },
      deps,
    )

    expect(res).toEqual({ ok: true, data: '<record>real data</record>' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
