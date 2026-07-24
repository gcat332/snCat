/**
 * ServiceNow REST API contract + pure URL builders.
 *
 * Handoff §2 decision 1: API is the source of truth for data. These builders are
 * kept pure (no fetch) so they can be unit-tested without an instance; the
 * actual authenticated fetch lives in background/api.ts (§5 auth notes).
 */

export interface QueryOptions {
  /** Encoded query, e.g. "active=true^priority=1". */
  query?: string
  /** Restrict returned columns, e.g. ["sys_id","number"]. */
  fields?: string[]
  /** Max rows (Table API sysparm_limit). */
  limit?: number
  /** Row offset (sysparm_offset). */
  offset?: number
  /**
   * Display value mode: true → display values, false → raw, "all" → both.
   * Default "all" so callers get {value, display_value} pairs.
   */
  displayValue?: boolean | 'all'
}

/** A field cell when sysparm_display_value=all. */
export interface FieldCell {
  value: string
  display_value: string
}

/** One dictionary (schema) entry for a column. */
export interface DictionaryField {
  element: string
  column_label: string
  internal_type: string
  reference: string
  mandatory: boolean
  max_length: string
  default_value: string
  /** Choice mode: '0' none, '1' dropdown w/ none, '2' suggestion, '3' dropdown. */
  choice: string
}

/** A single choice option for a field. */
export interface ChoiceOption {
  label: string
  value: string
}

/** Result envelope returned across the message boundary. */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

/** API operations the side panel can ask the background to perform. */
export type ApiRequest =
  | { op: 'query'; host: string; table: string; options?: QueryOptions }
  | { op: 'count'; host: string; table: string; query?: string }
  | { op: 'record'; host: string; table: string; sysId: string; fields?: string[] }
  | { op: 'dictionary'; host: string; table: string }
  // Layer 3 WRITES — gated by the prod guard before any fetch.
  | { op: 'create'; host: string; table: string; fields: Record<string, string> }
  | { op: 'update'; host: string; table: string; sysId: string; fields: Record<string, string> }
  | { op: 'delete'; host: string; table: string; sysId: string }
  // Raw text GET (e.g. record unload XML) — read-only, not JSON.
  | { op: 'text'; host: string; url: string }
  // Run a server-side background script (sys.scripts.do) — prod-guarded WRITE.
  | { op: 'bgrun'; host: string; script: string; scope?: string; updateSet?: string }

const API_BASE = '/api/now'

function origin(host: string): string {
  return `https://${host}`
}

/** Build a Table API query URL. */
export function buildTableQueryUrl(
  host: string,
  table: string,
  options: QueryOptions = {},
): string {
  const params = new URLSearchParams()
  if (options.query) params.set('sysparm_query', options.query)
  if (options.fields?.length) params.set('sysparm_fields', options.fields.join(','))
  params.set('sysparm_limit', String(options.limit ?? 10))
  if (options.offset) params.set('sysparm_offset', String(options.offset))
  params.set('sysparm_display_value', String(options.displayValue ?? 'all'))
  params.set('sysparm_exclude_reference_link', 'true')
  return `${origin(host)}${API_BASE}/table/${encodeURIComponent(table)}?${params.toString()}`
}

/** Build a single-record Table API URL. */
export function buildRecordUrl(
  host: string,
  table: string,
  sysId: string,
  fields?: string[],
): string {
  const params = new URLSearchParams()
  if (fields?.length) params.set('sysparm_fields', fields.join(','))
  params.set('sysparm_display_value', 'all')
  params.set('sysparm_exclude_reference_link', 'true')
  return `${origin(host)}${API_BASE}/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}?${params.toString()}`
}

/** Build the classic record unload-XML URL (e.g. incident.do?sys_id=..&XML). */
export function buildRecordXmlUrl(host: string, table: string, sysId: string): string {
  return `${origin(host)}/${encodeURIComponent(table)}.do?sys_id=${encodeURIComponent(sysId)}&XML`
}

/**
 * Build the classic list unload-XML URL, exporting every record that matches
 * the query (e.g. incident_list.do?sysparm_query=active=true&XML). This is the
 * URL a "Export > XML" from a list view fetches. An empty query exports all.
 */
export function buildListXmlUrl(host: string, table: string, query = '', limit?: number): string {
  const params = new URLSearchParams()
  params.set('sysparm_query', query)
  params.set('XML', '')
  if (limit && limit > 0) params.set('sysparm_record_count', String(limit))
  return `${origin(host)}/${encodeURIComponent(table)}_list.do?${params.toString()}`
}

/** Build the Table API collection URL (for create/POST). */
export function buildCreateUrl(host: string, table: string): string {
  const params = new URLSearchParams()
  params.set('sysparm_display_value', 'all')
  params.set('sysparm_exclude_reference_link', 'true')
  return `${origin(host)}${API_BASE}/table/${encodeURIComponent(table)}?${params.toString()}`
}

/** Build an Aggregate (stats) API URL that returns a row count for a query. */
export function buildStatsCountUrl(host: string, table: string, query?: string): string {
  const params = new URLSearchParams()
  params.set('sysparm_count', 'true')
  if (query) params.set('sysparm_query', query)
  return `${origin(host)}${API_BASE}/stats/${encodeURIComponent(table)}?${params.toString()}`
}

/**
 * Build a sys_dictionary query URL for a table's real columns.
 * Filters to rows that have an element (skips the collection row) for this table.
 */
export function buildDictionaryUrl(host: string, table: string): string {
  const query = `name=${table}^elementISNOTEMPTY^ORDERBYelement`
  return buildTableQueryUrl(host, 'sys_dictionary', {
    query,
    fields: ['element', 'column_label', 'internal_type', 'reference', 'mandatory', 'max_length', 'default_value', 'choice'],
    limit: 1000,
    displayValue: 'all',
  })
}

/** Encoded query for a table+field's choice options (against sys_choice). */
export function buildChoicesQuery(table: string, element: string): string {
  return `name=${table}^element=${element}^inactive=false^ORDERBYsequence^ORDERBYlabel`
}

/** Pull a scalar out of a Table API cell (handles both raw and {value,...} shapes). */
export function cellValue(cell: unknown): string {
  if (cell == null) return ''
  if (typeof cell === 'string') return cell
  if (typeof cell === 'object' && 'value' in (cell as object)) {
    return String((cell as FieldCell).value ?? '')
  }
  return String(cell)
}

/** Pull a display value out of a Table API cell, falling back to the raw value. */
export function cellDisplay(cell: unknown): string {
  if (cell == null) return ''
  if (typeof cell === 'string') return cell
  if (typeof cell === 'object') {
    const c = cell as Partial<FieldCell>
    return String(c.display_value ?? c.value ?? '')
  }
  return String(cell)
}

/** Common human-readable label columns, in priority order. */
export const LABEL_FIELDS = [
  'number',
  'name',
  'short_description',
  'title',
  'u_name',
  'sys_name',
  'label',
] as const

/** Pick a display label for a record row from common label columns. */
export function pickLabel(record: Record<string, unknown>): string {
  for (const key of LABEL_FIELDS) {
    if (key in record) {
      const display = cellDisplay(record[key])
      if (display) return display
    }
  }
  return cellValue(record['sys_id']) || '(record)'
}
