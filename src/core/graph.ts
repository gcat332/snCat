/**
 * Dependency graph walker for F1 (handoff §2 decision 2, §3).
 *
 * "Everything related" in ServiceNow is unbounded, so the walk is bounded:
 * a default depth limit and per-artifact-type resolvers that declare WHAT to
 * fetch next. The actual fetching is injected (fetchPage) so the walker is pure
 * and unit-testable without an instance.
 */

export type ArtifactType =
  | 'root'
  | 'table'
  | 'business_rule'
  | 'client_script'
  | 'script_include'
  | 'ui_policy'
  | 'ui_policy_action'
  | 'variable'
  | 'variable_set'
  | 'catalog_client_script'
  | 'acl'
  | 'transform_map'
  | 'transform_entry'
  | 'workflow'
  | 'notification'
  | 'data_policy'

export interface ArtifactRef {
  /** Stable dedupe key: `${table}:${sysId}`. */
  id: string
  table: string
  sysId: string
  type: ArtifactType
  label: string
  /** How it relates to its parent, e.g. "referenced Script Include". */
  relation: string
  depth: number
  /** Fetched field values (raw), populated when the artifact is loaded. */
  fields: Record<string, string>
}

/** A resolver's declaration of related records to fetch. */
export interface FetchSpec {
  table: string
  /** Encoded query. */
  query: string
  type: ArtifactType
  relation: string
  /** Field to use as the artifact label (falls back to name/number/sys_id). */
  labelField?: string
  /** Columns to fetch. */
  fields?: string[]
  limit?: number
}

/** Given a loaded artifact, declare what related records to fetch next. */
export type Resolver = (artifact: ArtifactRef) => FetchSpec[]

export type ResolverRegistry = Partial<Record<ArtifactType, Resolver>>

export interface WalkOptions {
  maxDepth?: number
  /** Executes a FetchSpec at a given depth → discovered artifacts (with fields). */
  fetchPage: (spec: FetchSpec, depth: number) => Promise<ArtifactRef[]>
  /** Optional progress callback. */
  onProgress?: (discovered: number) => void
}

export function makeId(table: string, sysId: string): string {
  return `${table}:${sysId}`
}

/**
 * Breadth-first walk from `root`, applying resolvers and fetching each level,
 * deduping by id, stopping at maxDepth (default 2). Returns every discovered
 * artifact INCLUDING the root, in discovery order.
 */
export async function walkGraph(
  root: ArtifactRef,
  resolvers: ResolverRegistry,
  opts: WalkOptions,
): Promise<ArtifactRef[]> {
  const maxDepth = opts.maxDepth ?? 2
  const seen = new Set<string>([root.id])
  const all: ArtifactRef[] = [root]
  let frontier: ArtifactRef[] = [root]

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: ArtifactRef[] = []
    for (const artifact of frontier) {
      const resolver = resolvers[artifact.type]
      if (!resolver) continue
      const specs = resolver(artifact)
      for (const spec of specs) {
        const found = await opts.fetchPage(spec, depth + 1)
        for (const ref of found) {
          if (seen.has(ref.id)) continue
          seen.add(ref.id)
          all.push(ref)
          next.push(ref)
          opts.onProgress?.(all.length)
        }
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }

  return all
}
