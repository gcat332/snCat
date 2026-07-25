/**
 * Naming convention for generated (Generate-tab) artifacts.
 *
 * Configuration records that an admin/developer browses get their display name
 * prefixed with `[MF-AI][<CODE>] ` so they're easy to spot and attribute in the
 * instance. CODE is a short module code derived from the table the artifact
 * targets (incident -> INC, change_request -> CHG, …).
 *
 * We prefix dev/admin-facing config (Business Rule, Client Script, Script
 * Include, Fix Script, UI Policy, UI Action, notifications, scheduled jobs, …)
 * but NEVER:
 *   - structural records whose name is meaningful/constrained — Field
 *     (sys_dictionary), Table (sys_db_object), ACL (sys_security_acl);
 *   - end-user-facing text — Choice (sys_choice) labels appear in dropdowns to
 *     real users, not just admins;
 *   - business data records (any non-`sys*` table).
 */

/** Config tables whose name must stay untouched (structural or user-facing). */
const NO_PREFIX_TABLES = new Set<string>([
  'sys_dictionary', // Field — column name is an identifier
  'sys_db_object', // Table — name is an identifier
  'sys_security_acl', // ACL — name is "operation.table"
  'sys_choice', // Choice — label is shown to end users
])

/** Tables whose human-visible name lives in a column other than `name`. */
const NAME_FIELD_OVERRIDES: Record<string, string> = {
  sys_ui_policy: 'short_description',
  sys_data_policy2: 'short_description',
}

/**
 * The column that should carry the `[MF-AI]` name prefix for a created
 * artifact, or `null` if this record type must keep its name untouched. Only
 * configuration/metadata tables (`sys*`) qualify — never business data.
 */
export function namePrefixField(targetTable: string | null | undefined): string | null {
  const t = (targetTable ?? '').trim().toLowerCase()
  if (!t || NO_PREFIX_TABLES.has(t)) return null
  if (t in NAME_FIELD_OVERRIDES) return NAME_FIELD_OVERRIDES[t]
  // Configuration/metadata records only — never rename business data records.
  if (!t.startsWith('sys')) return null
  return 'name'
}

/** Well-known ServiceNow module codes (mirrors the platform number prefixes). */
const MODULE_CODES: Record<string, string> = {
  incident: 'INC',
  change_request: 'CHG',
  change_task: 'CTSK',
  problem: 'PRB',
  problem_task: 'PTSK',
  task: 'TSK',
  sc_request: 'REQ',
  sc_req_item: 'RITM',
  sc_task: 'SCT',
  sc_cat_item: 'CAT',
  kb_knowledge: 'KB',
  cmdb_ci: 'CI',
  change_request_imac: 'CHG',
}

/**
 * A short module code standing for the table (e.g. `incident` -> `INC`).
 * Known ITSM tables use their platform code; anything else falls back to the
 * first three letters of the table name (scope/custom prefix stripped).
 */
export function moduleCode(table: string | null | undefined): string {
  const t = (table ?? '').trim().toLowerCase()
  if (!t) return 'GEN'
  if (MODULE_CODES[t]) return MODULE_CODES[t]
  // Strip a scope/custom prefix, then keep letters only. Scoped tables are
  // `x_<vendor>_<app>_<table>`, so drop the two leading scope segments to reach
  // the table name; custom columns/tables use a plain `u_` prefix.
  const bare = t
    .replace(/^u_/, '')
    .replace(/^x_[a-z0-9]+_[a-z0-9]+_/, '')
    .replace(/[^a-z]/g, '')
  const base = bare || t.replace(/[^a-z]/g, '')
  return (base.slice(0, 3) || 'GEN').toUpperCase()
}

// Matches an existing `[MF-AI][CODE] ` prefix so re-prefixing is idempotent.
const PREFIX_RE = /^\s*\[MF-AI\]\[[^\]]*\]\s*/

/**
 * Prepend the `[MF-AI][<CODE>] ` convention to an artifact's display name.
 * Idempotent: an existing prefix (any code) is stripped first, so re-running
 * never stacks.
 */
export function prefixArtifactName(name: string, table: string | null | undefined): string {
  const base = (name ?? '').replace(PREFIX_RE, '').trim()
  return `[MF-AI][${moduleCode(table)}] ${base}`.trim()
}
