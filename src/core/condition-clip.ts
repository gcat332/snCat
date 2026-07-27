/**
 * Cross-instance clipboard for a list condition (encoded query).
 *
 * Copying a filter between instances is safe for the query text but NOT for the
 * sys_ids embedded in it — a `assigned_to=<sys_id>` clause points at a user
 * record that very likely has a different sys_id (or no record at all) on the
 * target. This module extracts those tokens so the UI can warn about them; the
 * query itself is always pasted verbatim, never rewritten.
 */

export interface ConditionClip {
  /** Host the condition was copied FROM. */
  host: string
  /** Table the condition applies to. */
  table: string
  /** Encoded query, exactly as read from the source list. */
  query: string
  /** sys_id → display value, for the tokens we could resolve at copy time. */
  labels: Record<string, string>
  savedAt: string
}

/** A sys_id appearing in an encoded query, with the field it was compared to. */
export interface RefToken {
  field: string
  sysId: string
}

/** Clause separators in an encoded query: `^`, `^OR`, `^NQ`. */
const CLAUSE_SPLIT = /\^(?:OR|NQ)?/
/** A bare 32-char lowercase hex token — negative lookbehind/lookahead for hex
 *  chars keeps it from matching inside a longer hex run (e.g. a 40-char hash). */
const SYS_ID_RE = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g
const FIELD_RE = /^([a-z0-9_.]+)/

export function extractRefTokens(query: string): RefToken[] {
  const out: RefToken[] = []
  const seen = new Set<string>()
  for (const clause of query.split(CLAUSE_SPLIT)) {
    const m = clause.match(FIELD_RE)
    if (!m) continue
    const field = m[1]
    const rest = clause.slice(field.length)
    for (const sysId of rest.match(SYS_ID_RE) ?? []) {
      const key = `${field}:${sysId}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ field, sysId })
    }
  }
  return out
}

/**
 * Human-readable cautions to show before pasting. A differing HOST is never a
 * warning — carrying a filter to another instance is the whole feature. What
 * matters is a table mismatch and every sys_id the query depends on.
 */
export function clipWarnings(
  clip: ConditionClip,
  current: { host: string; table?: string | null },
): string[] {
  const out: string[] = []
  if (current.table && current.table !== clip.table) {
    out.push(`Clip is for \`${clip.table}\`, this page is \`${current.table}\`.`)
  }
  for (const { field, sysId } of extractRefTokens(clip.query)) {
    const label = clip.labels[sysId]
    out.push(
      label
        ? `${field} = ${label} — sys_id may not exist on this instance.`
        : `${field} = ${sysId.slice(0, 8)}… — could not resolve.`,
    )
  }
  return out
}

/**
 * Bucket tokens by the table their field references, so labels can be fetched
 * with one batched `sys_idIN…` query per referenced table instead of one call
 * per sys_id. `refByField` comes from the table's sys_dictionary.
 */
export function groupTokensByRefTable(
  tokens: RefToken[],
  refByField: Record<string, string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const { field, sysId } of tokens) {
    const refTable = refByField[field]
    if (!refTable) continue
    const ids = out.get(refTable) ?? []
    if (!ids.includes(sysId)) ids.push(sysId)
    out.set(refTable, ids)
  }
  return out
}
