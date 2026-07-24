/**
 * Maps ServiceNow script-bearing tables to how the Script Tester should read
 * them: which field holds the script, which holds the timing, and the lint kind.
 */
import type { BrTiming, ScriptKind } from './lint'

export interface ScriptTableInfo {
  kind: ScriptKind
  /** Field holding the script body. */
  scriptField: string
  /** Field holding the BR timing (`when`), if applicable. */
  timingField?: string
  /** Field holding the record's display name. */
  nameField: string
}

export const SCRIPT_TABLES: Record<string, ScriptTableInfo> = {
  sys_script: {
    kind: 'business_rule',
    scriptField: 'script',
    timingField: 'when',
    nameField: 'name',
  },
  sys_script_client: {
    kind: 'client_script',
    scriptField: 'script',
    nameField: 'name',
  },
  sys_script_include: {
    kind: 'script_include',
    scriptField: 'script',
    nameField: 'name',
  },
}

export function scriptTableInfo(table: string | null | undefined): ScriptTableInfo | null {
  if (!table) return null
  return SCRIPT_TABLES[table] ?? null
}

const VALID_TIMINGS: BrTiming[] = ['before', 'after', 'async', 'display']

/** Coerce a raw `when` value into a BrTiming, defaulting to 'before'. */
export function normalizeTiming(raw: string | null | undefined): BrTiming {
  const v = (raw ?? '').toLowerCase() as BrTiming
  return VALID_TIMINGS.includes(v) ? v : 'before'
}
