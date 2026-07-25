import type { PageContext, UiKind, ViewKind } from './types'

/**
 * Parse a ServiceNow URL into a PageContext (table / sys_id / view / ui).
 *
 * Handoff §2 decision 1: DOM is only for identity — this resolves *which*
 * record the user is on from the URL alone. It must work on both the classic UI
 * and Next Experience / Polaris, whose URL shapes differ (§5).
 *
 * Returns null only when the string is not a parseable URL. A page with no
 * record (home/landing) returns a PageContext with view:'home' | 'unknown'.
 */
export function parseServiceNowContext(urlString: string): PageContext | null {
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    return null
  }

  const base = {
    host: url.host,
    url: urlString,
    source: 'url' as const,
  }

  // 1. Next Experience / Polaris classic-target wrapper:
  //    /now/nav/ui/classic/params/target/<url-encoded classic .do url>
  const target = extractPolarisClassicTarget(url)
  if (target) {
    const inner = parseClassicPath(target)
    if (inner) return { ...base, ...inner, ui: 'polaris' }
  }

  // 2. Workspace / Next Experience record routes:
  //    /now/<scope>/record/<table>/<sys_id>[/...]
  const record = extractNextRecordRoute(url.pathname)
  if (record) {
    return {
      ...base,
      table: record.table,
      sysId: record.sysId,
      view: 'form',
      ui: 'workspace',
    }
  }

  // 3. Workspace list route: /now/<scope>/list/params/... or .../list/<table>
  const listTable = extractNextListRoute(url.pathname)
  if (listTable) {
    return { ...base, table: listTable, sysId: null, view: 'list', ui: 'workspace' }
  }

  // 4. Classic nav wrapper: /nav_to.do?uri=<url-encoded classic .do url>
  if (url.pathname.endsWith('/nav_to.do') || url.pathname === '/nav_to.do') {
    const uri = url.searchParams.get('uri')
    if (uri) {
      const inner = parseClassicPath(decodeMaybe(uri))
      if (inner) return { ...base, ...inner, ui: 'classic' }
    }
  }

  // 5. Plain classic path: /<table>.do or /<table>_list.do
  const classic = parseClassicPath(url.pathname + url.search)
  if (classic) return { ...base, ...classic, ui: 'classic' }

  // 6. Nothing matched — a home/landing/unknown page.
  const ui: UiKind = url.pathname.startsWith('/now/') ? 'polaris' : 'classic'
  const view: ViewKind = isHomeish(url.pathname) ? 'home' : 'unknown'
  return { ...base, table: null, sysId: null, view, ui }
}

/** A ServiceNow sys_id is a 32-char hex string. */
const SYS_ID_RE = /^[0-9a-f]{32}$/i
/** A table/record name: letters, digits, underscores. */
const TABLE_RE = /^[a-z][a-z0-9_]*$/i

function isSysId(value: string | null | undefined): value is string {
  return !!value && SYS_ID_RE.test(value)
}

/** Decode a possibly-encoded (sometimes double-encoded) URI component. */
function decodeMaybe(value: string): string {
  let out = value
  for (let i = 0; i < 2; i++) {
    if (!/%[0-9a-f]{2}/i.test(out)) break
    try {
      out = decodeURIComponent(out)
    } catch {
      break
    }
  }
  return out
}

/**
 * Parse a classic-style path fragment like:
 *   "incident.do?sys_id=abc..."   → { table:'incident', sysId, view:'form' }
 *   "/sys_script.do?sys_id=abc"   → form
 *   "incident_list.do?..."        → { table:'incident', view:'list' }
 * Returns null if there is no ".do" table segment.
 */
function parseClassicPath(
  fragment: string,
): Pick<PageContext, 'table' | 'sysId' | 'view'> | null {
  const decoded = decodeMaybe(fragment)
  const qIndex = decoded.indexOf('?')
  const path = qIndex >= 0 ? decoded.slice(0, qIndex) : decoded
  const query = qIndex >= 0 ? decoded.slice(qIndex + 1) : ''

  // last path segment, e.g. "incident.do"
  const segment = path.split('/').filter(Boolean).pop() ?? ''
  const doMatch = segment.match(/^([a-z0-9_]+)\.do$/i)
  if (!doMatch) return null

  let table = doMatch[1]
  let view: ViewKind = 'form'

  if (table.endsWith('_list')) {
    table = table.slice(0, -'_list'.length)
    view = 'list'
  }

  if (!TABLE_RE.test(table)) return null

  const params = new URLSearchParams(query)
  const sysIdRaw = params.get('sys_id')
  const sysId = isSysId(sysIdRaw) ? sysIdRaw : null

  // A form view with sys_id="-1" means "new record"; treat as form, no sysId.
  if (view === 'form' && !sysId && sysIdRaw !== '-1') {
    // No sys_id at all on a *.do (not _list) → could be a list-ish default.
    // Keep as form only if the .do explicitly carries a sys_id param slot.
    if (!params.has('sys_id')) view = 'unknown'
  }

  return { table, sysId, view }
}

/**
 * Extract the classic target from a Polaris URL:
 *   /now/nav/ui/classic/params/target/<encoded>
 */
function extractPolarisClassicTarget(url: URL): string | null {
  const marker = '/params/target/'
  const idx = url.pathname.indexOf(marker)
  if (idx === -1) return null
  let rest = url.pathname.slice(idx + marker.length)
  // Anything after the target may itself carry the classic query (encoded).
  rest = decodeMaybe(rest)
  if (url.search) rest += url.search
  return rest
}

/**
 * Match Next Experience record routes:
 *   /now/sow/record/incident/<sys_id>
 *   /now/cwf/agent/record/<table>/<sys_id>/...
 *   /now/<...>/record/<table>/<sys_id>
 */
function extractNextRecordRoute(
  pathname: string,
): { table: string; sysId: string } | null {
  const segs = pathname.split('/').filter(Boolean)
  // A path may contain more than one "record" marker (e.g. a related-list
  // drill-down nested under a record route). Anchoring on the last one can
  // land on a segment not followed by a valid <table>/<sysId> pair, so scan
  // occurrences and take the FIRST marker followed by a valid pair.
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] !== 'record') continue
    const table = segs[i + 1]
    const sysId = segs[i + 2]
    if (table && sysId && TABLE_RE.test(table) && isSysId(sysId)) {
      return { table, sysId }
    }
  }
  return null
}

/**
 * Match Next Experience list routes:
 *   /now/<...>/list/<table>
 *   /now/<...>/list/params/...tableName=<table>...
 */
function extractNextListRoute(pathname: string): string | null {
  const segs = pathname.split('/').filter(Boolean)
  // As with record routes, a path may carry more than one "list" marker; scan
  // occurrences and take the FIRST marker immediately followed by a valid
  // <table> segment rather than unconditionally anchoring on the last.
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] !== 'list') continue
    const next = segs[i + 1]
    if (next && next !== 'params' && TABLE_RE.test(next)) return next
  }
  // params form: try to find a "tableName" pair anywhere in the path
  const tnIdx = segs.indexOf('tableName')
  if (tnIdx !== -1 && segs[tnIdx + 1] && TABLE_RE.test(segs[tnIdx + 1])) {
    return segs[tnIdx + 1]
  }
  return null
}

function isHomeish(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/now/nav/ui' ||
    pathname.endsWith('/home') ||
    pathname.endsWith('/homepage.do') ||
    pathname === '/now/nav/ui/home'
  )
}
