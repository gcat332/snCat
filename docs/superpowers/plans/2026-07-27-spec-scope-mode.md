# Spec Application-Scope Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a design spec for an entire application scope — every artifact where `sys_scope` is that app — instead of only for one record or table.

**Architecture:** A new pure module declares one `FetchSpec` per artifact table, each queried `sys_scope=<sysId>`. A flat sweep, depth 0, no graph walk: it answers "what is in this app", not "what does this app depend on". Everything downstream is reused unchanged — the same checklist, the same `composeSpec`, the same HTML/PDF/Word exporters. `ComposeInput` gains an optional `scope` field that overrides title, subtitle and meta, and suppresses the table-specific REST API section, which has no meaning for a scope.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- New pure logic goes in `src/core/` with a colocated `*.test.ts`; no `chrome.*` in core.
- Every core file starts with a block comment explaining the module's role.
- Record/table mode must be untouched: with no `scope` on `ComposeInput`, output is byte-identical to today's.
- The parent/child hierarchy checkbox is disabled in scope mode — table hierarchy is not a scope concept.
- Commands: `npm test`, `npm run typecheck`, `npm run build`.

---

### Task 1: Core module — the scope sweep specs

**Files:**
- Create: `src/core/scope-spec.ts`
- Test: `src/core/scope-spec.test.ts`

**Interfaces:**
- Consumes: `FetchSpec`, `ArtifactType` from `./graph`.
- Produces: `SCOPE_ARTIFACT_TABLES: ScopeSweep[]`, `scopeFetchSpecs(scopeSysId: string): FetchSpec[]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/scope-spec.test.ts
import { describe, it, expect } from 'vitest'
import { SCOPE_ARTIFACT_TABLES, scopeFetchSpecs } from './scope-spec'

describe('scopeFetchSpecs', () => {
  const specs = scopeFetchSpecs('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')

  it('emits one spec per swept artifact table', () => {
    expect(specs).toHaveLength(SCOPE_ARTIFACT_TABLES.length)
  })

  it('queries every table by sys_scope', () => {
    for (const s of specs) {
      expect(s.query).toContain('sys_scope=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')
    }
  })

  it('gives every spec a limit and a fields list', () => {
    for (const s of specs) {
      expect(s.limit).toBeGreaterThan(0)
      expect(s.fields?.length).toBeGreaterThan(0)
      expect(s.fields).toContain('sys_id')
    }
  })

  it('sweeps no table twice', () => {
    const tables = specs.map((s) => s.table)
    expect(new Set(tables).size).toBe(tables.length)
  })

  it('covers the artifact tables the resolvers already know about', () => {
    const tables = specs.map((s) => s.table)
    for (const t of [
      'sys_db_object',
      'sys_script',
      'sys_script_client',
      'sys_script_include',
      'sys_ui_policy',
      'sys_security_acl',
      'sysevent_email_action',
      'sys_data_policy2',
      'sc_cat_item',
      'sys_transform_map',
      'sys_ui_action',
    ]) {
      expect(tables).toContain(t)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/scope-spec.test.ts`
Expected: FAIL — `Failed to resolve import "./scope-spec"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/scope-spec.ts
/**
 * Whole-application spec sweep (F1).
 *
 * The record/table spec walks a dependency graph from one root. A scope spec
 * answers a different question — "what is in this application?" — so it is a
 * FLAT sweep: one query per artifact table, filtered on sys_scope, depth 0.
 * No graph walk, so the size is predictable and one pass covers the app.
 *
 * The trade-off is deliberate: artifacts this app depends on that live OUTSIDE
 * the scope (a global Script Include, say) are not pulled in.
 */
import type { ArtifactType, FetchSpec } from './graph'

export interface ScopeSweep {
  table: string
  type: ArtifactType
  relation: string
  labelField: string
  fields: string[]
  limit: number
}

/** Artifact tables swept for a scope spec, in presentation order. */
export const SCOPE_ARTIFACT_TABLES: ScopeSweep[] = [
  {
    table: 'sys_db_object',
    type: 'table',
    relation: 'Table',
    labelField: 'label',
    fields: ['sys_id', 'name', 'label', 'super_class', 'sys_scope'],
    limit: 200,
  },
  {
    table: 'sys_script',
    type: 'business_rule',
    relation: 'Business Rule',
    labelField: 'name',
    fields: [
      'sys_id', 'name', 'collection', 'when', 'order', 'active', 'condition',
      'filter_condition', 'script', 'action_insert', 'action_update',
      'action_delete', 'action_query', 'description',
    ],
    limit: 500,
  },
  {
    table: 'sys_script_client',
    type: 'client_script',
    relation: 'Client Script',
    labelField: 'name',
    fields: ['sys_id', 'name', 'table', 'type', 'field', 'active', 'global', 'isolate_script', 'description', 'script'],
    limit: 500,
  },
  {
    table: 'sys_script_include',
    type: 'script_include',
    relation: 'Script Include',
    labelField: 'name',
    fields: ['sys_id', 'name', 'api_name', 'active', 'client_callable', 'description', 'script'],
    limit: 500,
  },
  {
    table: 'sys_ui_policy',
    type: 'ui_policy',
    relation: 'UI Policy',
    labelField: 'short_description',
    fields: ['sys_id', 'short_description', 'table', 'active', 'conditions', 'on_load', 'reverse_if_false', 'global', 'order'],
    limit: 500,
  },
  {
    table: 'sys_ui_action',
    type: 'ui_policy_action',
    relation: 'UI Action',
    labelField: 'name',
    fields: ['sys_id', 'name', 'table', 'active', 'action_name', 'condition', 'script', 'client', 'form_button', 'list_button'],
    limit: 500,
  },
  {
    table: 'sys_security_acl',
    type: 'acl',
    relation: 'ACL',
    labelField: 'name',
    fields: ['sys_id', 'name', 'operation', 'active', 'admin_overrides', 'condition', 'script', 'description'],
    limit: 1000,
  },
  {
    table: 'sysevent_email_action',
    type: 'notification',
    relation: 'Notification',
    labelField: 'name',
    fields: ['sys_id', 'name', 'collection', 'active', 'event_name', 'action_insert', 'action_update'],
    limit: 200,
  },
  {
    table: 'sys_data_policy2',
    type: 'data_policy',
    relation: 'Data Policy',
    labelField: 'short_description',
    fields: ['sys_id', 'short_description', 'model_table', 'active', 'enforce_ui', 'apply_import_set', 'reverse_if_false'],
    limit: 200,
  },
  {
    table: 'sc_cat_item',
    type: 'root',
    relation: 'Catalog Item',
    labelField: 'name',
    fields: ['sys_id', 'name', 'short_description', 'active', 'category', 'workflow'],
    limit: 200,
  },
  {
    table: 'sys_transform_map',
    type: 'transform_map',
    relation: 'Transform Map',
    labelField: 'name',
    fields: ['sys_id', 'name', 'source_table', 'target_table', 'active', 'order'],
    limit: 200,
  },
]

/** One FetchSpec per artifact table, all filtered to the given application. */
export function scopeFetchSpecs(scopeSysId: string): FetchSpec[] {
  return SCOPE_ARTIFACT_TABLES.map((s) => ({
    table: s.table,
    query: `sys_scope=${scopeSysId}`,
    type: s.type,
    relation: s.relation,
    labelField: s.labelField,
    fields: s.fields,
    limit: s.limit,
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/scope-spec.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/scope-spec.ts src/core/scope-spec.test.ts
git commit -m "feat(scope-spec): declare the flat sys_scope artifact sweep"
```

---

### Task 2: Compose a scope document

**Files:**
- Modify: `src/core/spec.ts` (`ComposeInput`, `composeSpec`, `spec.ts:32-121`)
- Test: `src/core/spec.test.ts`

**Interfaces:**
- Consumes: `ComposeInput` from `spec.ts`.
- Produces: `ComposeInput.scope?: { label: string; prefix: string }`; when set, `composeSpec` emits an application title/subtitle/meta and omits the REST API section.

- [ ] **Step 1: Write the failing test**

Append to `src/core/spec.test.ts`:

```ts
describe('composeSpec in scope mode', () => {
  const base = {
    instance: 'dev1.service-now.com',
    rootTable: 'sys_scope',
    rootLabel: 'MFEC Onboarding',
    rootFields: {},
    artifacts: [],
  }

  it('titles the document after the application', () => {
    const doc = composeSpec({ ...base, scope: { label: 'MFEC Onboarding', prefix: 'x_mfec_onb' } })
    expect(doc.title).toBe('MFEC Onboarding')
    expect(doc.subtitle).toBe('Application Design Specification')
  })

  it('reports the application and instance in meta', () => {
    const doc = composeSpec({ ...base, scope: { label: 'MFEC Onboarding', prefix: 'x_mfec_onb' } })
    expect(doc.meta).toContainEqual({ key: 'Application', value: 'MFEC Onboarding (x_mfec_onb)' })
    expect(doc.meta).toContainEqual({ key: 'Instance', value: 'dev1.service-now.com' })
  })

  it('omits the table REST API section, which has no meaning for a scope', () => {
    const doc = composeSpec({ ...base, scope: { label: 'MFEC Onboarding', prefix: 'x_mfec_onb' } })
    expect(doc.sections.map((s) => s.heading)).not.toContain('REST API (Table API)')
  })

  it('keeps the REST API section when there is no scope', () => {
    const doc = composeSpec({ ...base, rootTable: 'incident', primaryTable: 'incident' })
    expect(doc.sections.map((s) => s.heading)).toContain('REST API (Table API)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/spec.test.ts`
Expected: FAIL — `scope` is not a known property, and the title is `'Sys Scope'`.

- [ ] **Step 3: Write the implementation**

In `src/core/spec.ts`, add to `ComposeInput` after `aiOverview`:

```ts
  /**
   * Set when the document describes a whole application rather than a record or
   * table. Overrides the title/subtitle/meta and suppresses the table-specific
   * REST API section.
   */
  scope?: { label: string; prefix: string }
```

In `composeSpec`, replace the `title`, `subtitle` and `meta` assignments
(`spec.ts:90-105`) with:

```ts
  const title = input.scope ? input.scope.label : isTableSpec ? tableDisplay : rootLabel || rootKind
  const subtitle = input.scope
    ? 'Application Design Specification'
    : isTableSpec
      ? 'Table / Module Design Specification'
      : `${rootKind} · Design Specification`

  const meta = input.scope
    ? [
        { key: 'Instance', value: instance },
        { key: 'Application', value: `${input.scope.label} (${input.scope.prefix})` },
        { key: 'Artifacts documented', value: String(artifacts.length) },
      ]
    : isTableSpec
      ? [
          { key: 'Instance', value: instance },
          { key: 'Table', value: `${tableDisplay} (${table})` },
          { key: 'Artifacts documented', value: String(artifacts.length) },
        ]
      : [
          { key: 'Instance', value: instance },
          { key: 'Artifact type', value: rootKind },
          { key: 'Table', value: `${titleCase(rootTable)} (${rootTable})` },
          { key: 'sys_id', value: rootFields['sys_id'] ?? '' },
          { key: 'Artifacts included', value: String(artifacts.length + 1) },
        ]
```

Then replace the `sections` array (`spec.ts:112-119`) with:

```ts
    sections: [
      overviewSection(rootKind, isTableSpec ? tableDisplay : rootLabel, instance, rootFields, isTableSpec),
      dataModelSection(table, rootFields, artifacts, schema),
      logicSection(rootFields, artifacts, isTableSpec ? '' : `${rootKind}: ${rootLabel || rootKind}`),
      integrationSection(artifacts),
      securitySection(artifacts),
      // The Table API section documents ONE table's endpoints; an application
      // spans many, so it is omitted rather than emitted against a nonsense path.
      ...(input.scope ? [] : [apiSpecSection(instance, table, schema)]),
    ],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/spec.test.ts && npm test`
Expected: the 4 new tests pass and the suite is green — existing tests pass no
`scope`, so they take the unchanged branches.

- [ ] **Step 5: Commit**

```bash
git add src/core/spec.ts src/core/spec.test.ts
git commit -m "feat(spec): compose an application-scope document"
```

---

### Task 3: Run the scope sweep against the instance

**Files:**
- Modify: `src/core/spec-runner.ts`
- Test: `src/core/spec-runner.test.ts`

**Interfaces:**
- Consumes: `scopeFetchSpecs` (Task 1); the private `toArtifact`/`rawFields` already in `spec-runner.ts`.
- Produces: `scopeRootArtifact(label: string): ArtifactRef` and
  `sweepScopeSpec(host: string, scopeSysId: string, onProgress?: (n: number) => void): Promise<ArtifactRef[]>`.

- [ ] **Step 1: Write the failing test**

Append to `src/core/spec-runner.test.ts`, extending the existing `queryRecords`
mock so `sys_script` with a `sys_scope=` query returns two rows and every other
swept table returns `[]`:

```ts
describe('sweepScopeSpec', () => {
  it('returns artifacts from every table that had rows', async () => {
    const artifacts = await sweepScopeSpec('h', 'scope_sys_id')
    expect(artifacts.map((a) => a.type)).toContain('business_rule')
  })

  it('reports cumulative progress as tables complete', async () => {
    const seen: number[] = []
    await sweepScopeSpec('h', 'scope_sys_id', (n) => seen.push(n))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toBe((await sweepScopeSpec('h', 'scope_sys_id')).length)
  })

  it('survives a table that errors, rather than aborting the sweep', async () => {
    // The mock returns { ok: false } for sys_security_acl.
    const artifacts = await sweepScopeSpec('h', 'scope_sys_id')
    expect(artifacts.every((a) => a.type !== 'acl')).toBe(true)
    expect(artifacts.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/spec-runner.test.ts`
Expected: FAIL — `sweepScopeSpec is not exported`.

- [ ] **Step 3: Write the implementation**

In `src/core/spec-runner.ts`, add the import:

```ts
import { scopeFetchSpecs } from './scope-spec'
```

and append:

```ts
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
 * Flat sweep of every artifact table for one application scope. Depth 0 — no
 * graph walk. A table that fails (absent on this instance, blocked by ACL)
 * contributes nothing rather than aborting the sweep, matching how fetchPage
 * treats a failed FetchSpec in the graph walk.
 */
export async function sweepScopeSpec(
  host: string,
  scopeSysId: string,
  onProgress?: (n: number) => void,
): Promise<ArtifactRef[]> {
  const out: ArtifactRef[] = []
  const seen = new Set<string>()
  for (const spec of scopeFetchSpecs(scopeSysId)) {
    const res = await queryRecords(host, spec.table, {
      query: spec.query,
      fields: spec.fields,
      limit: spec.limit ?? 200,
      displayValue: 'all',
    })
    if (!res.ok) continue
    for (const rec of res.data) {
      const artifact = toArtifact(spec, rec, 1)
      if (seen.has(artifact.id)) continue
      seen.add(artifact.id)
      out.push(artifact)
    }
    onProgress?.(out.length)
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/spec-runner.test.ts && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/core/spec-runner.ts src/core/spec-runner.test.ts
git commit -m "feat(spec): sweep an application scope's artifacts"
```

---

### Task 4: Side panel — the source selector

**Files:**
- Modify: `src/sidepanel/index.html` (Spec card)
- Modify: `src/sidepanel/main.ts` (`discoverArtifacts`, `buildSpecDoc`)

**Interfaces:**
- Consumes: `sweepScopeSpec`, `scopeRootArtifact` (Task 3); `ComposeInput.scope` (Task 2); the existing `scopeByName` map and `#scope-list` datalist (`main.ts:176`, `main.ts:254`).
- Produces: nothing downstream.

`main.ts` has no unit-test harness; verification is `npm run typecheck`, `npm run build`
and the manual smoke steps.

- [ ] **Step 1: Add the selector to the markup**

In `src/sidepanel/index.html`, directly after the Spec card's `<p class="hint" id="spec-hint">…</p>`,
insert:

```html
          <label class="field-label" for="spec-source">Source</label>
          <select id="spec-source" class="select">
            <option value="record">Current record / table</option>
            <option value="scope">Application scope</option>
          </select>
          <div id="spec-scope-wrap" hidden>
            <label class="field-label" for="spec-scope">Application</label>
            <input id="spec-scope" class="query-input" list="scope-list"
              placeholder="type to search scopes…" />
          </div>
```

- [ ] **Step 2: Add the handles and mode switching**

In `src/sidepanel/main.ts`, next to the other spec handles (`main.ts:2228`), add:

```ts
const specSource = el<HTMLSelectElement>('spec-source')
const specScopeWrap = el('spec-scope-wrap')
const specScope = el<HTMLInputElement>('spec-scope')
/**
 * The parent/child checkbox row, added by the table-hierarchy plan. Looked up
 * with getElementById rather than el() because the two plans are independent —
 * this one must work whether or not that row exists yet.
 */
const specHierarchyRow = document.getElementById('spec-hierarchy-row')
```

and a module-level:

```ts
/** Set while the current discovery is a scope sweep; drives buildSpecDoc. */
let specScopeInfo: { label: string; prefix: string } | null = null
```

Add the import:

```ts
import { scopeRootArtifact, sweepScopeSpec } from '@core/spec-runner'
```

(merge it into the existing `@core/spec-runner` import line rather than adding a
second one).

Next to the `specWalk` listener (`main.ts:3222`), add:

```ts
specSource.addEventListener('change', () => {
  const isScope = specSource.value === 'scope'
  specScopeWrap.hidden = !isScope
  // Table hierarchy is a table concept — meaningless for a scope.
  if (specHierarchyRow) specHierarchyRow.hidden = isScope
  updateEnabledState()
})
```

- [ ] **Step 3: Branch discovery on the mode**

In `discoverArtifacts()`, replace the opening guard (`main.ts:2295-2296`) and the
root/walk block with a mode branch. The scope path:

```ts
async function discoverArtifacts() {
  if (!current) return
  const { host } = current

  if (specSource.value === 'scope') {
    const label = specScope.value.trim()
    const scopeSysId = scopeByName.get(label)
    if (!scopeSysId) {
      specChecklist.replaceChildren(
        elText('div', 'error', `Unknown application "${label}" — pick one from the list.`),
      )
      return
    }
    specWalk.disabled = true
    specOutput.hidden = true
    specStatus.hidden = true
    specChecklist.replaceChildren(elText('div', 'empty', `Sweeping ${label}…`))
    try {
      const artifacts = await sweepScopeSpec(host, scopeSysId, (n) => {
        specChecklist.replaceChildren(elText('div', 'empty', `Sweeping… ${n} artifacts`))
      })
      specRoot = scopeRootArtifact(label)
      specArtifacts = artifacts
      specPrimaryTable = ''
      specSchema = []
      specScopeInfo = { label, prefix: scopePrefixFor(artifacts, label) }
      specExcluded.clear()
      specAiOverview = null
      renderChecklist()
    } catch (err) {
      specChecklist.replaceChildren(elText('div', 'error', (err as Error).message))
    } finally {
      specWalk.disabled = false
    }
    return
  }

  specScopeInfo = null
  if (!current.table) return
  // …existing record/table path unchanged from here…
}
```

Add the small helper next to it:

```ts
/**
 * The app's scope prefix, taken from any swept artifact's sys_scope display
 * value. Falls back to the typed label when nothing carried it.
 */
function scopePrefixFor(artifacts: ArtifactRef[], fallback: string): string {
  for (const a of artifacts) {
    const p = a.fields['sys_scope']
    if (p && /^x_/.test(p)) return p
  }
  return fallback
}
```

- [ ] **Step 4: Pass the scope through to composeSpec**

In `buildSpecDoc()` (`main.ts:2397`), add `scope: specScopeInfo ?? undefined,` to the
`composeSpec({ … })` argument object.

- [ ] **Step 5: Enable the button in scope mode**

In `updateEnabledState()` (`main.ts:854`), replace the `specWalk.disabled` line
(`main.ts:871`) with:

```ts
  specWalk.disabled =
    specSource.value === 'scope'
      ? !current?.host
      : !(current?.table && (current.sysId || current.view === 'list'))
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 7: Manual smoke**

1. Reload the unpacked extension from `dist/`.
2. Open any page on the dev instance so the scope bar populates.
3. Spec tab → set **Source** to *Application scope*. The Application input appears;
   the parent/child checkbox disappears.
4. Type a scoped app name (autocomplete comes from the same list as the header
   scope picker) and click *Discover artifacts*.
5. Expected: progress counts up per table; the checklist groups by artifact type;
   `#spec-status` shows the total.
6. Export to HTML. Confirm the title is the application name, the subtitle reads
   *Application Design Specification*, meta shows `Application: <name> (x_…)`, and
   there is **no** "REST API (Table API)" section.
7. Switch **Source** back to *Current record / table* on an incident form and
   discover again — output must match pre-change behaviour, including the REST
   API section.

- [ ] **Step 8: Commit**

```bash
git add src/sidepanel/index.html src/sidepanel/main.ts
git commit -m "feat(spec): application-scope source mode in the Spec tab"
```

---

### Task 5: Document the mode

**Files:**
- Modify: `README.md` (the `## Tabs` section, Spec entry)

- [ ] **Step 1: Add the entry**

```markdown
**Source: Application scope.** Instead of one record or table, sweep every
artifact whose `sys_scope` is the selected app — tables, Business Rules, Client
Scripts, Script Includes, UI Policies, UI Actions, ACLs, notifications, data
policies, catalog items and transform maps. A flat sweep, no dependency walk, so
it answers "what is in this app" and does **not** pull in artifacts the app
depends on that live outside the scope. The Table API section is omitted, since
an application spans many tables.
```

- [ ] **Step 2: Verify the whole suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the Spec application-scope mode"
```

---

## Smoke-test checklist (not covered by unit tests)

- [ ] Scope sweep against a real scoped application returns a plausible artifact set
- [ ] A table the user cannot read is skipped without aborting the sweep
- [ ] Scope document exports correctly to HTML, PDF and Word
- [ ] Record/table mode output is unchanged after the switch is added
