/**
 * Glue between the F1 graph walker and the live REST client. Loads the root
 * record, provides a fetchPage that executes FetchSpecs via the Table API, and
 * maps rows into ArtifactRefs. A failed fetch (e.g. a table absent on this
 * instance) yields no artifacts rather than aborting the whole walk.
 */
import { cellDisplay, cellValue, pickLabel } from './api'
import { getDictionary, getRecord, queryRecords } from './api-client'
import { makeId, walkGraph, type ArtifactRef, type FetchSpec } from './graph'
import { resolveHierarchy, type HierarchyFetch, type TableHierarchy } from './hierarchy'
import type { ArtifactOrigin } from './graph'
import { RESOLVERS } from './resolvers'
import { scopeFetchSpecs } from './scope-spec'
import type { SpecSchemaField } from './spec'

/** Flatten a Table API row (raw or {value} cells) into a string map. */
function rawFields(rec: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec)) out[k] = cellValue(v)
  return out
}

/**
 * Reference fields whose sys_id is only ever rendered as a human label (never
 * used to build a sub-query), so the display value must win over the raw sys_id
 * (T-302). `fields` stays raw for every other key, keeping resolver queries and
 * sys_id extraction untouched.
 */
const REFERENCE_LABEL_FIELDS = new Set(['variable_set', 'super_class'])

function toArtifact(spec: FetchSpec, rec: Record<string, unknown>, depth: number): ArtifactRef {
  const fields = rawFields(rec)
  // Overlay display names for reference LABEL fields so lists/columns show the
  // referenced record's name, not its sys_id. Requires the bulk fetch to have
  // requested display values (displayValue:'all', see fetchPage).
  for (const key of REFERENCE_LABEL_FIELDS) {
    if (key in rec) {
      const display = cellDisplay(rec[key])
      if (display) fields[key] = display
    }
  }
  const sysId = cellValue(rec['sys_id'])
  const label = spec.labelField ? fields[spec.labelField] || pickLabel(rec) : pickLabel(rec)
  return {
    id: makeId(spec.table, sysId),
    table: spec.table,
    sysId,
    type: spec.type,
    label,
    relation: spec.relation,
    depth,
    fields,
  }
}

export async function loadRootArtifact(
  host: string,
  table: string,
  sysId: string,
): Promise<ArtifactRef | null> {
  const res = await getRecord(host, table, sysId)
  if (!res.ok) return null
  const fields = rawFields(res.data)
  return {
    id: makeId(table, sysId),
    table,
    sysId,
    type: 'root',
    label: pickLabel(res.data),
    relation: 'root',
    depth: 0,
    fields,
  }
}

/**
 * A synthetic root for a whole-table ("module") spec, used when the user is on
 * a list view (no specific record). The root resolver dispatches by table, so a
 * plain data table falls through to resolveTable and surfaces its BRs, client
 * scripts, UI policies, ACLs, etc.
 */
export function tableRootArtifact(table: string): ArtifactRef {
  return {
    id: makeId(table, 'table'),
    table,
    sysId: '',
    type: 'root',
    label: table,
    relation: 'root',
    depth: 0,
    fields: { name: table },
  }
}

export interface WalkOutcome {
  root: ArtifactRef
  artifacts: ArtifactRef[] // discovered, excluding root
  primaryTable: string
  schema: SpecSchemaField[]
  /** Resolved ancestors/children, or null when the option was off. */
  hierarchy: TableHierarchy | null
}

/** The data table a spec is about: BR's collection, else the root table. */
function primaryTableOf(root: ArtifactRef): string {
  return root.fields['collection'] || root.table
}

export async function walkSpecGraph(
  host: string,
  root: ArtifactRef,
  onProgress?: (n: number) => void,
  opts: { includeHierarchy?: boolean } = {},
): Promise<WalkOutcome> {
  // Per-walk fetch memo (T-405). On a table-root spec every Business Rule
  // resolves the SAME `sys_db_object?name=<collection>` FetchSpec; walkGraph only
  // dedupes AFTER the network call, so those fire as N identical live fetches.
  // Cache the in-flight fetch by (table + query + fields) so identical specs
  // within THIS walk collapse to one round-trip. The cache is created fresh here
  // on every walkSpecGraph call, so nothing leaks between separate walks.
  //
  // Behaviour is preserved: the cache is keyed only on the inputs that determine
  // the returned rows (table/query/fields — displayValue and limit are fixed for
  // a given spec shape), and walkGraph dedupes the returned refs by id regardless
  // of the depth a cached result was first produced at, so the discovered set,
  // dedupe, depth-2 bound and discovery order are all unchanged.
  const fetchCache = new Map<string, Promise<ArtifactRef[]>>()
  // NUL delimiter: ServiceNow table names and encoded queries can never contain
  // 0x00, making it an unambiguous separator for (table, query, fields) tuples.
  // Without it, table 'a' + query 'bc' would key identically to table 'ab' + query 'c'.
  const cacheKey = (spec: FetchSpec): string =>
    `${spec.table}\x00${spec.query}\x00${(spec.fields ?? []).join(',')}`

  const fetchPage = async (spec: FetchSpec, depth: number): Promise<ArtifactRef[]> => {
    const key = cacheKey(spec)
    const cached = fetchCache.get(key)
    if (cached) return cached
    const pending = (async () => {
      const res = await queryRecords(host, spec.table, {
        query: spec.query,
        fields: spec.fields,
        limit: spec.limit ?? 50,
        // Request both raw + display so reference LABEL fields (variable_set,
        // super_class) can render the referenced record's name (T-302). rawFields
        // still keeps the raw value for every field, so resolver queries are
        // unaffected.
        displayValue: 'all',
      })
      if (!res.ok) return []
      return res.data.map((rec) => toArtifact(spec, rec, depth))
    })()
    fetchCache.set(key, pending)
    return pending
  }

  const all = await walkGraph(root, RESOLVERS, { maxDepth: 2, fetchPage, onProgress })

  const primaryTable = primaryTableOf(root)

  // Hierarchy seeding. Each ancestor/child table is walked as its own `table`
  // root at depth 1, so the EXISTING resolveTable resolver discovers its BRs,
  // client scripts, UI policies, ACLs and so on. The refs carry `origin`, which
  // is what makes resolveTable mark the relation string. Results are merged by
  // id, so an artifact both walks reach appears exactly once.
  let hierarchy: TableHierarchy | null = null
  if (opts.includeHierarchy) {
    const hierarchyFetch: HierarchyFetch = async (table, query, fields, limit) => {
      const res = await queryRecords(host, table, { query, fields, limit })
      return res.ok ? res.data.map(rawFields) : []
    }
    hierarchy = await resolveHierarchy(primaryTable, hierarchyFetch)

    const seeds: { name: string; origin: ArtifactOrigin }[] = [
      ...hierarchy.ancestors.map((name) => ({ name, origin: 'ancestor' as const })),
      ...hierarchy.children.map((name) => ({ name, origin: 'child' as const })),
    ]

    const byId = new Map(all.map((a) => [a.id, a]))
    // Tracks the highest count reported to onProgress so far (starts at what the
    // main walk already reported, i.e. its final length). Used to guarantee the
    // combined main+seed progress sequence never goes backward, even in the edge
    // case where a seed walk's own discoveries turn out to be entirely duplicates
    // of what's already merged (see below).
    let progressPeak = all.length
    for (const seed of seeds) {
      const seedRoot: ArtifactRef = {
        id: makeId('sys_db_object', seed.name),
        table: 'sys_db_object',
        sysId: '',
        type: 'table',
        label: seed.name,
        relation: seed.origin === 'ancestor' ? `inherited from ${seed.name}` : `child table ${seed.name}`,
        depth: 1,
        fields: { name: seed.name },
        origin: seed.origin,
      }
      // onProgress reports a count local to each walkGraph call (it starts fresh
      // from [root] every time — graph.ts:94), so wiring the same callback into
      // every seed walk would make a live "Discovering… N artifacts" counter jump
      // backward once per ancestor/child. Report a running total instead: `base`
      // is how many artifacts are already merged before this seed walk starts, and
      // `n - 1` discounts the seed root itself (walkGraph's own count starts at 1
      // for the root, before any real discovery is reported). The `Math.max` with
      // `progressPeak` is a safety net for when this seed's raw discoveries (n)
      // don't all survive the outer dedupe (some were already known) — without it,
      // the next seed's base (drawn from the real, deduped `all.length`) could dip
      // below what this seed already reported.
      const base = all.length
      const seedOnProgress = onProgress
        ? (n: number) => {
            const total = Math.max(progressPeak, base + n - 1)
            progressPeak = total
            onProgress(total)
          }
        : undefined
      const found = await walkGraph(seedRoot, RESOLVERS, {
        maxDepth: 1,
        fetchPage,
        onProgress: seedOnProgress,
      })
      for (const a of found) {
        // The synthetic seed root is a data-carrier for `origin` only — it was
        // never a real fetched record (empty sysId) and must not surface as a
        // near-blank 'table' row in the spec's data model / artifact list. The
        // covered-tables hint (spec.ts) already tells the user which
        // ancestors/children were included.
        if (a.id === seedRoot.id) continue
        if (!byId.has(a.id)) {
          byId.set(a.id, a)
          all.push(a)
        }
      }
    }
  }

  // Fetch the primary table's schema for the Data Model section.
  let schema: SpecSchemaField[] = []
  const dict = await getDictionary(host, primaryTable)
  if (dict.ok) {
    schema = dict.data.map((d) => ({
      element: cellValue(d.element as unknown),
      type: cellDisplay(d.internal_type as unknown) || cellValue(d.internal_type as unknown),
      label: cellDisplay(d.column_label as unknown),
      reference: cellDisplay(d.reference as unknown) || cellValue(d.reference as unknown),
      mandatory: cellValue(d.mandatory as unknown),
      maxLength: cellValue(d.max_length as unknown),
      defaultValue: cellValue(d.default_value as unknown),
    }))
  }

  return { root, artifacts: all.filter((a) => a.id !== root.id), primaryTable, schema, hierarchy }
}

/**
 * Synthetic root for an application spec. There is no single record or table at
 * the centre of a scope, but composeSpec and the checklist both want a root, so
 * this stands in. `composeSpec` is given `scope` separately and uses that for
 * the title/meta — this root only carries the label.
 */
export function scopeRootArtifact(label: string): ArtifactRef {
  return {
    id: makeId('sys_scope', 'scope'),
    table: 'sys_scope',
    sysId: '',
    type: 'root',
    label,
    relation: 'root',
    depth: 0,
    fields: { name: label },
  }
}

/**
 * Result of a scope sweep. `failed` and `truncated` exist so a per-table
 * problem is surfaced to the user rather than read back as absence — a 403 on
 * `sys_security_acl` must not read as "no ACLs in this application", and a
 * table that hit its row limit must not silently drop the remainder (the same
 * Global Constraint hierarchy.ts already applies via `childrenTruncated`).
 */
export interface ScopeSweepOutcome {
  artifacts: ArtifactRef[]
  /** Table names whose query was not ok (permission error, absent table, etc). */
  failed: string[]
  /** Table names whose result hit the sweep's configured row limit. */
  truncated: string[]
}

/**
 * Flat sweep of every artifact table for one application scope. Depth 0 — no
 * graph walk. A table that fails (absent on this instance, blocked by ACL)
 * contributes no artifacts rather than aborting the sweep, matching how
 * fetchPage treats a failed FetchSpec in the graph walk — but unlike that
 * silent-continue, the failure is recorded in `failed` so the caller can tell
 * the user, instead of the document reading the gap as "nothing to report".
 */
export async function sweepScopeSpec(
  host: string,
  scopeSysId: string,
  onProgress?: (n: number) => void,
): Promise<ScopeSweepOutcome> {
  const out: ArtifactRef[] = []
  const failed: string[] = []
  const truncated: string[] = []
  const seen = new Set<string>()
  for (const spec of scopeFetchSpecs(scopeSysId)) {
    const limit = spec.limit ?? 200
    const res = await queryRecords(host, spec.table, {
      query: spec.query,
      fields: spec.fields,
      limit,
      displayValue: 'all',
    })
    if (!res.ok) {
      failed.push(spec.table)
      continue
    }
    if (res.data.length >= limit) truncated.push(spec.table)
    for (const rec of res.data) {
      const artifact = toArtifact(spec, rec, 1)
      if (seen.has(artifact.id)) continue
      seen.add(artifact.id)
      out.push(artifact)
    }
    onProgress?.(out.length)
  }
  return { artifacts: out, failed, truncated }
}
