/**
 * ServiceNow table-hierarchy resolution for F1 specs.
 *
 * A Business Rule on `task` genuinely fires on every incident, so a spec that
 * lists only artifacts whose collection is literally `incident` understates what
 * runs. This module resolves the `sys_db_object.super_class` chain upward and
 * one level of children downward, so spec-runner can seed those tables into the
 * walk. The fetch is injected, keeping the module pure and Node-testable.
 */

/** Injected reader: one sys_db_object query → raw string rows. */
export type HierarchyFetch = (
  table: string,
  query: string,
  fields: string[],
  limit: number,
) => Promise<Record<string, string>[]>

export interface TableHierarchy {
  /** Nearest ancestor first, e.g. ['task', 'sys_metadata']. */
  ancestors: string[]
  /** Direct children, capped at MAX_CHILDREN. */
  children: string[]
  /** How many children were dropped by the cap. Surfaced in the UI, never silent. */
  childrenTruncated: number
}

/** Guards against a pathological or cyclic super_class chain. */
const MAX_ANCESTOR_HOPS = 10
/** Children beyond this are dropped; the count is reported to the user. */
export const MAX_CHILDREN = 20
/**
 * Upper bound on the children fetch. `childrenTruncated` is exact for any table
 * with at most this many direct subclasses, which covers every real ServiceNow
 * schema (`task`, among the most-extended base tables, has on the order of 30).
 * Beyond this bound the fetch itself truncates, so the reported dropped count
 * would be an under-count rather than a wrong-shaped answer.
 */
const CHILD_FETCH_LIMIT = 500

const DB_OBJECT_FIELDS = ['sys_id', 'name', 'super_class']

/**
 * The table's ancestor chain, nearest first, excluding the table itself.
 * Split out from resolveHierarchy because callers that only need inheritance
 * (e.g. resolving which table declares a field) must not pay for the children query.
 */
export async function resolveAncestors(
  table: string,
  fetch: HierarchyFetch,
): Promise<string[]> {
  const [self] = await fetch('sys_db_object', `name=${table}`, DB_OBJECT_FIELDS, 1)
  if (!self?.sys_id) return []

  // Follow super_class upward. `seen` holds sys_ids already visited, so a
  // cycle terminates instead of spinning to the hop cap every time.
  const ancestors: string[] = []
  const seen = new Set<string>([self.sys_id])
  let parentId = self.super_class
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS && parentId && !seen.has(parentId); hop++) {
    seen.add(parentId)
    const [parent] = await fetch('sys_db_object', `sys_id=${parentId}`, DB_OBJECT_FIELDS, 1)
    if (!parent?.name) break
    ancestors.push(parent.name)
    parentId = parent.super_class
  }
  return ancestors
}

/**
 * Resolves a table's ancestor chain (via super_class, nearest-first) and direct children.
 * Returns ancestors, children list (capped at MAX_CHILDREN), and the count of children dropped by the cap.
 */
export async function resolveHierarchy(
  table: string,
  fetch: HierarchyFetch,
): Promise<TableHierarchy> {
  const empty: TableHierarchy = { ancestors: [], children: [], childrenTruncated: 0 }

  const [self] = await fetch('sys_db_object', `name=${table}`, DB_OBJECT_FIELDS, 1)
  if (!self?.sys_id) return empty

  const ancestors = await resolveAncestors(table, fetch)

  // Children: one level only.
  const kidRows = await fetch(
    'sys_db_object',
    `super_class=${self.sys_id}`,
    DB_OBJECT_FIELDS,
    CHILD_FETCH_LIMIT,
  )
  const allKids = kidRows.map((r) => r.name).filter(Boolean)

  return {
    ancestors,
    children: allKids.slice(0, MAX_CHILDREN),
    childrenTruncated: Math.max(0, allKids.length - MAX_CHILDREN),
  }
}
