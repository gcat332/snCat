/**
 * Naming convention for generated (F1/Generate-tab) artifacts.
 *
 * Script records created by the Generate tab get a name prefixed with
 * `[MF-AI][<CODE>] ` so they're easy to spot and attribute in the instance,
 * where CODE is a short module code derived from the table the script targets
 * (incident -> INC, change_request -> CHG, …). Only script records are
 * prefixed (Business Rule, Client Script, Script Include, Fix Script); fields,
 * ACLs and choices keep the model's chosen name.
 */

/** Metadata tables whose created records are "scripts" and get the name prefix. */
export const SCRIPT_TARGET_TABLES = new Set<string>([
  'sys_script', // Business Rule
  'sys_script_client', // Client Script
  'sys_script_include', // Script Include
  'sys_script_fix', // Fix Script
])

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
 * Prepend the `[MF-AI][<CODE>] ` convention to a script record name. Idempotent:
 * an existing prefix (any code) is stripped first, so re-running never stacks.
 */
export function prefixScriptName(name: string, table: string | null | undefined): string {
  const base = (name ?? '').replace(PREFIX_RE, '').trim()
  return `[MF-AI][${moduleCode(table)}] ${base}`.trim()
}
