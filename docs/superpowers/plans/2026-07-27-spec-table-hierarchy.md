# Spec Parent/Child Table Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a design spec optionally include artifacts defined on the table's ancestors (which genuinely fire on the record) and on its direct children.

**Architecture:** A new pure module resolves the `sys_db_object.super_class` chain upward and one level of children downward. `spec-runner.ts` then seeds those tables into the spec walk as `table`-type roots — the existing `resolveTable` resolver discovers their Business Rules, Client Scripts, UI Policies, ACLs, Notifications and Data Policies with **no resolver logic changes**. A new optional `origin` field on `ArtifactRef` lets `resolveTable` mark the relation string so inherited and child artifacts are distinguishable in the checklist and the exported spec.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- New pure logic goes in `src/core/` with a colocated `*.test.ts`; no `chrome.*` in core.
- Every core file starts with a block comment explaining the module's role.
- Default **off**. With the option off, discovery output must be byte-identical to today's.
- Ancestor walk capped at 10 hops with a cycle guard; children capped at 20 **with the dropped count reported in the UI** — never a silent truncation.
- Commands: `npm test`, `npm run typecheck`, `npm run build`.

---

### Task 1: Core module — resolve the table hierarchy

**Files:**
- Create: `src/core/hierarchy.ts`
- Test: `src/core/hierarchy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TableHierarchy`, `HierarchyFetch`, `resolveHierarchy(table: string, fetch: HierarchyFetch): Promise<TableHierarchy>`, `MAX_CHILDREN` (20).

- [ ] **Step 1: Write the failing test**

```ts
// src/core/hierarchy.test.ts
import { describe, it, expect } from 'vitest'
import { resolveHierarchy, type HierarchyFetch } from './hierarchy'

/**
 * Fake sys_db_object. `rows` is keyed by table name; each row carries its own
 * sys_id and its parent's sys_id (super_class), exactly like the real table.
 */
function fakeFetch(rows: Record<string, { sys_id: string; super_class: string }>): HierarchyFetch {
  const bySysId = new Map(Object.entries(rows).map(([name, r]) => [r.sys_id, { name, ...r }]))
  return async (table, query, _fields, limit) => {
    if (table !== 'sys_db_object') return []
    let m = query.match(/^name=(.+)$/)
    if (m) {
      const r = rows[m[1]]
      return r ? [{ sys_id: r.sys_id, name: m[1], super_class: r.super_class }] : []
    }
    m = query.match(/^sys_id=(.+)$/)
    if (m) {
      const r = bySysId.get(m[1])
      return r ? [{ sys_id: r.sys_id, name: r.name, super_class: r.super_class }] : []
    }
    m = query.match(/^super_class=(.+)$/)
    if (m) {
      const kids = Object.entries(rows)
        .filter(([, r]) => r.super_class === m[1])
        .map(([name, r]) => ({ sys_id: r.sys_id, name, super_class: r.super_class }))
      return kids.slice(0, limit)
    }
    return []
  }
}

const CHAIN = {
  sys_metadata: { sys_id: 'id_meta', super_class: '' },
  task: { sys_id: 'id_task', super_class: 'id_meta' },
  incident: { sys_id: 'id_inc', super_class: 'id_task' },
  incident_task: { sys_id: 'id_inct', super_class: 'id_inc' },
}

describe('resolveHierarchy', () => {
  it('walks ancestors nearest-first and finds direct children', async () => {
    const h = await resolveHierarchy('incident', fakeFetch(CHAIN))
    expect(h.ancestors).toEqual(['task', 'sys_metadata'])
    expect(h.children).toEqual(['incident_task'])
    expect(h.childrenTruncated).toBe(0)
  })

  it('returns empty lists for a table with no parent and no children', async () => {
    const h = await resolveHierarchy('sys_metadata', fakeFetch(CHAIN))
    expect(h.ancestors).toEqual([])
    expect(h.children).toEqual([])
  })

  it('returns empty lists when the table is not in sys_db_object', async () => {
    const h = await resolveHierarchy('nope', fakeFetch(CHAIN))
    expect(h).toEqual({ ancestors: [], children: [], childrenTruncated: 0 })
  })

  it('terminates on a super_class cycle instead of looping forever', async () => {
    const cyclic = {
      a: { sys_id: 'id_a', super_class: 'id_b' },
      b: { sys_id: 'id_b', super_class: 'id_a' },
    }
    const h = await resolveHierarchy('a', fakeFetch(cyclic))
    expect(h.ancestors).toEqual(['b'])
  })

  it('caps children at 20 and reports how many were dropped', async () => {
    const many: Record<string, { sys_id: string; super_class: string }> = {
      base: { sys_id: 'id_base', super_class: '' },
    }
    for (let i = 0; i < 25; i++) many[`kid${i}`] = { sys_id: `id_kid${i}`, super_class: 'id_base' }
    const h = await resolveHierarchy('base', fakeFetch(many))
    expect(h.children).toHaveLength(20)
    expect(h.childrenTruncated).toBe(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/hierarchy.test.ts`
Expected: FAIL — `Failed to resolve import "./hierarchy"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/hierarchy.ts
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
/** Upper bound on the children fetch, so childrenTruncated is accurate. */
const CHILD_FETCH_LIMIT = 500

const DB_OBJECT_FIELDS = ['sys_id', 'name', 'super_class']

export async function resolveHierarchy(
  table: string,
  fetch: HierarchyFetch,
): Promise<TableHierarchy> {
  const empty: TableHierarchy = { ancestors: [], children: [], childrenTruncated: 0 }

  const [self] = await fetch('sys_db_object', `name=${table}`, DB_OBJECT_FIELDS, 1)
  if (!self?.sys_id) return empty

  // Ancestors: follow super_class upward. `seen` holds sys_ids already visited,
  // so a cycle terminates instead of spinning to the hop cap every time.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/hierarchy.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/hierarchy.ts src/core/hierarchy.test.ts
git commit -m "feat(hierarchy): resolve a table's ancestor chain and direct children"
```

---

### Task 2: Mark artifact origin in the relation string

**Files:**
- Modify: `src/core/graph.ts` (the `ArtifactRef` interface)
- Modify: `src/core/resolvers.ts` (`resolveTable`, around `resolvers.ts:138-205`)
- Test: `src/core/resolvers.test.ts`

**Interfaces:**
- Consumes: `ArtifactRef` from `graph.ts`.
- Produces: `ArtifactRef.origin?: ArtifactOrigin` where `type ArtifactOrigin = 'self' | 'ancestor' | 'child'`; `resolveTable` emits relations suffixed `↑ <table>` / `↓ <table>` when origin is set.

- [ ] **Step 1: Write the failing test**

Append to `src/core/resolvers.test.ts`:

```ts
import { RESOLVERS } from './resolvers'
import { makeId, type ArtifactRef } from './graph'

function tableRef(name: string, origin?: 'self' | 'ancestor' | 'child'): ArtifactRef {
  return {
    id: makeId('sys_db_object', name),
    table: 'sys_db_object',
    sysId: name,
    type: 'table',
    label: name,
    relation: '',
    depth: 1,
    fields: { name },
    origin,
  }
}

describe('resolveTable origin marking', () => {
  it('leaves relations unmarked for the spec’s own table', () => {
    const specs = RESOLVERS.table!(tableRef('incident'))
    const br = specs.find((s) => s.table === 'sys_script')!
    expect(br.relation).toBe('Business Rule')
  })

  it('leaves relations unmarked when origin is explicitly self', () => {
    const specs = RESOLVERS.table!(tableRef('incident', 'self'))
    expect(specs.find((s) => s.table === 'sys_script')!.relation).toBe('Business Rule')
  })

  it('marks ancestor artifacts with an up arrow and the source table', () => {
    const specs = RESOLVERS.table!(tableRef('task', 'ancestor'))
    expect(specs.find((s) => s.table === 'sys_script')!.relation).toBe('Business Rule ↑ task')
    expect(specs.find((s) => s.table === 'sys_ui_policy')!.relation).toBe('UI Policy ↑ task')
  })

  it('marks child artifacts with a down arrow and the source table', () => {
    const specs = RESOLVERS.table!(tableRef('incident_task', 'child'))
    expect(specs.find((s) => s.table === 'sys_security_acl')!.relation).toBe('ACL ↓ incident_task')
  })

  it('still queries the marked table, not the spec root', () => {
    const specs = RESOLVERS.table!(tableRef('task', 'ancestor'))
    expect(specs.find((s) => s.table === 'sys_script')!.query).toContain('collection=task')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/resolvers.test.ts`
Expected: FAIL — the ancestor case returns `'Business Rule'`, not `'Business Rule ↑ task'`.

- [ ] **Step 3: Add `origin` to ArtifactRef**

In `src/core/graph.ts`, after the `ArtifactType` union, add:

```ts
/**
 * Where an artifact's defining table sits relative to the spec's own table.
 * 'ancestor' artifacts are inherited — they genuinely fire on the spec's
 * records. 'child' artifacts do not, but a change here affects them.
 */
export type ArtifactOrigin = 'self' | 'ancestor' | 'child'
```

and inside `interface ArtifactRef`, after the `depth` field:

```ts
  /** Hierarchy provenance; absent or 'self' for the spec's own table. */
  origin?: ArtifactOrigin
```

- [ ] **Step 4: Suffix the relations in resolveTable**

In `src/core/resolvers.ts`, immediately before `const resolveTable: Resolver = (a) => {` (`resolvers.ts:139`), add:

```ts
/**
 * Suffix a relation with its hierarchy provenance, so an inherited Business
 * Rule reads "Business Rule ↑ task" in the checklist and the exported spec.
 * Unmarked (own-table) artifacts keep the exact wording they had before, so
 * discovery output is unchanged when the hierarchy option is off.
 */
function markRelation(a: ArtifactRef, base: string): string {
  if (!a.origin || a.origin === 'self') return base
  const name = a.fields['name'] || a.label
  return `${base} ${a.origin === 'ancestor' ? '↑' : '↓'} ${name}`
}
```

Then in the `resolveTable` return array, replace each literal `relation:` value with a `markRelation` call. The six specs become:

```ts
      relation: markRelation(a, 'Business Rule'),
      // …
      relation: markRelation(a, 'Client Script'),
      // …
      relation: markRelation(a, 'UI Policy'),
      // …
      relation: markRelation(a, 'ACL'),
      // …
      relation: markRelation(a, 'Notification'),
      // …
      relation: markRelation(a, 'Data Policy'),
```

Leave every other field of every spec untouched.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/core/resolvers.test.ts && npm test`
Expected: the 5 new tests pass and the full suite is green — the existing resolver tests assert the unmarked wording, which is exactly what an unset `origin` still produces.

- [ ] **Step 6: Commit**

```bash
git add src/core/graph.ts src/core/resolvers.ts src/core/resolvers.test.ts
git commit -m "feat(spec): mark inherited and child artifacts in the relation string"
```

---

### Task 3: Seed hierarchy tables into the spec walk

**Files:**
- Modify: `src/core/spec-runner.ts` (`walkSpecGraph`, `spec-runner.ts:104-166`)
- Test: `src/core/spec-runner.test.ts`

**Interfaces:**
- Consumes: `resolveHierarchy`, `TableHierarchy` (Task 1); `ArtifactOrigin` (Task 2).
- Produces: `walkSpecGraph(host, root, onProgress?, opts?: { includeHierarchy?: boolean })`; `WalkOutcome` gains `hierarchy: TableHierarchy | null`.

- [ ] **Step 1: Write the failing test**

`walkSpecGraph` calls the live `api-client`, so the existing `spec-runner.test.ts`
already mocks that module. Follow the pattern in place there and append:

```ts
describe('walkSpecGraph with hierarchy', () => {
  it('leaves the outcome unchanged when the option is off', async () => {
    const outcome = await walkSpecGraph('h', tableRootArtifact('incident'))
    expect(outcome.hierarchy).toBeNull()
    expect(outcome.artifacts.every((a) => !a.relation.includes('↑'))).toBe(true)
  })

  it('discovers ancestor artifacts and marks them when the option is on', async () => {
    const outcome = await walkSpecGraph('h', tableRootArtifact('incident'), undefined, {
      includeHierarchy: true,
    })
    expect(outcome.hierarchy?.ancestors).toEqual(['task'])
    const inherited = outcome.artifacts.filter((a) => a.relation.includes('↑ task'))
    expect(inherited.length).toBeGreaterThan(0)
  })

  it('does not duplicate an artifact that both walks discover', async () => {
    const outcome = await walkSpecGraph('h', tableRootArtifact('incident'), undefined, {
      includeHierarchy: true,
    })
    const ids = outcome.artifacts.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
```

Extend the file's existing `queryRecords` mock so that:
- `sys_db_object` + `name=incident` → one row `{ sys_id: 'id_inc', name: 'incident', super_class: 'id_task' }`
- `sys_db_object` + `sys_id=id_task` → one row `{ sys_id: 'id_task', name: 'task', super_class: '' }`
- `sys_db_object` + `super_class=id_inc` → `[]`
- `sys_script` + `collection=task` → one row `{ sys_id: 'br_task_1', name: 'Task BR' }`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/spec-runner.test.ts`
Expected: FAIL — `walkSpecGraph` takes three parameters and `outcome.hierarchy` is undefined.

- [ ] **Step 3: Write the implementation**

In `src/core/spec-runner.ts`, add to the imports:

```ts
import { resolveHierarchy, type HierarchyFetch, type TableHierarchy } from './hierarchy'
import type { ArtifactOrigin } from './graph'
```

Add `hierarchy` to `WalkOutcome`:

```ts
export interface WalkOutcome {
  root: ArtifactRef
  artifacts: ArtifactRef[] // discovered, excluding root
  primaryTable: string
  schema: SpecSchemaField[]
  /** Resolved ancestors/children, or null when the option was off. */
  hierarchy: TableHierarchy | null
}
```

Change the signature and add the seeding. Replace the `const all = await walkGraph(...)` line (`spec-runner.ts:147`) with the block below, and add the `opts` parameter:

```ts
export async function walkSpecGraph(
  host: string,
  root: ArtifactRef,
  onProgress?: (n: number) => void,
  opts: { includeHierarchy?: boolean } = {},
): Promise<WalkOutcome> {
```

```ts
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
      const found = await walkGraph(seedRoot, RESOLVERS, { maxDepth: 1, fetchPage, onProgress })
      for (const a of found) {
        if (!byId.has(a.id)) {
          byId.set(a.id, a)
          all.push(a)
        }
      }
    }
  }
```

Then delete the now-duplicated `const primaryTable = primaryTableOf(root)` further down
(`spec-runner.ts:150`) and add `hierarchy` to the returned object:

```ts
  return { root, artifacts: all.filter((a) => a.id !== root.id), primaryTable, schema, hierarchy }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/spec-runner.test.ts && npm test`
Expected: the 3 new tests pass; the whole suite is green. The existing spec-runner
tests call `walkSpecGraph` with no `opts`, so `hierarchy` is `null` and behaviour
is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/core/spec-runner.ts src/core/spec-runner.test.ts
git commit -m "feat(spec): optionally seed ancestor and child tables into the walk"
```

---

### Task 4: Side panel — the opt-in checkbox

**Files:**
- Modify: `src/sidepanel/index.html` (Spec card, above the `#spec-walk` button row)
- Modify: `src/sidepanel/main.ts` (`discoverArtifacts`, `main.ts:2294-2330`)

**Interfaces:**
- Consumes: `walkSpecGraph(..., { includeHierarchy })` and `WalkOutcome.hierarchy` (Task 3).
- Produces: nothing downstream.

Verification here is `npm run typecheck`, `npm run build` and the manual smoke steps —
`main.ts` has no unit-test harness.

- [ ] **Step 1: Add the checkbox and hint to the markup**

In `src/sidepanel/index.html`, directly before the `<div class="btn-row">` containing
`#spec-walk`, insert:

```html
          <label class="chk-item" id="spec-hierarchy-row">
            <input type="checkbox" id="spec-hierarchy" />
            <span class="chk-label">Include parent &amp; child tables</span>
          </label>
          <p class="hint" id="spec-hierarchy-hint" hidden></p>
```

- [ ] **Step 2: Wire it into discovery**

In `src/sidepanel/main.ts`, next to the other spec element handles (`main.ts:2228`), add:

```ts
const specHierarchy = el<HTMLInputElement>('spec-hierarchy')
const specHierarchyHint = el('spec-hierarchy-hint')
```

In `discoverArtifacts()`, pass the option — replace the `walkSpecGraph` call
(`main.ts:2313`) with:

```ts
    const outcome = await walkSpecGraph(
      host,
      root,
      (n) => {
        specChecklist.replaceChildren(elText('div', 'empty', `Discovering… ${n} artifacts`))
      },
      { includeHierarchy: specHierarchy.checked },
    )
```

and, after the existing `specSchema = outcome.schema` line, add:

```ts
    renderHierarchyHint(outcome.hierarchy, outcome.primaryTable)
```

Then add the renderer next to `renderChecklist()`:

```ts
/**
 * State the tables the spec actually covered. When the child cap dropped some,
 * say so — a spec that silently omitted 27 child tables would read as complete.
 */
function renderHierarchyHint(
  hierarchy: import('@core/hierarchy').TableHierarchy | null,
  primaryTable: string,
) {
  if (!hierarchy) {
    specHierarchyHint.hidden = true
    specHierarchyHint.textContent = ''
    return
  }
  const parts = [
    primaryTable,
    ...hierarchy.ancestors.map((t) => `↑ ${t}`),
    ...hierarchy.children.map((t) => `↓ ${t}`),
  ]
  const total = 1 + hierarchy.ancestors.length + hierarchy.children.length
  let text = `${total} table${total === 1 ? '' : 's'}: ${parts.join(' ')}`
  if (hierarchy.childrenTruncated > 0) {
    text += ` — ${hierarchy.childrenTruncated} more child table${
      hierarchy.childrenTruncated === 1 ? '' : 's'
    } not included (cap 20)`
  }
  specHierarchyHint.textContent = text
  specHierarchyHint.hidden = false
}
```

- [ ] **Step 3: Reset the hint when the checkbox is unticked**

Next to the `specWalk` listener (`main.ts:3222`), add:

```ts
specHierarchy.addEventListener('change', () => {
  if (!specHierarchy.checked) renderHierarchyHint(null, '')
})
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 5: Manual smoke**

1. Reload the unpacked extension from `dist/`.
2. Open an `incident` record form on the dev instance → Spec tab.
3. With the checkbox **off**, click *Discover artifacts*. Note the count in
   `#spec-status`; no `↑` markers appear and no hint line shows.
4. Tick **Include parent & child tables** and discover again.
5. Expected: the count rises; the hint reads roughly
   `4 tables: incident ↑ task ↑ sys_metadata ↓ incident_task`; checklist rows for
   inherited artifacts read `Business Rule ↑ task` in the relation column.
6. Export to HTML and confirm the `↑ task` markers survive into the document.
7. Repeat on a `task` record — a base table with many children — and confirm the
   hint reports the dropped count if there are more than 20.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/index.html src/sidepanel/main.ts
git commit -m "feat(spec): opt-in parent/child table coverage in the Spec tab"
```

---

### Task 5: Document the option

**Files:**
- Modify: `README.md` (the `## Tabs` section, Spec entry)

- [ ] **Step 1: Add the entry**

```markdown
**Include parent & child tables** (off by default). Walks `sys_db_object.super_class`
upward and one level of children downward, then discovers each of those tables'
artifacts too. Inherited rows are marked `↑ task`, child rows `↓ incident_task`.
Ancestors are the ones that matter most — a Business Rule on `task` genuinely
fires on every incident. Off by default because on a base table this multiplies
the artifact count; children are capped at 20 and the hint states how many were
dropped.
```

- [ ] **Step 2: Verify the whole suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the Spec parent/child table option"
```

---

## Smoke-test checklist (not covered by unit tests)

- [ ] Discovery with the option off produces the same count as before the change
- [ ] `incident` resolves `↑ task ↑ sys_metadata` against the real instance
- [ ] Inherited relation markers survive into HTML, PDF and Word exports
- [ ] A base table with >20 children reports the dropped count
