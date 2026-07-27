# Condition Copy/Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy a ServiceNow list's active condition on one instance and paste it into the same table's list on another instance, with warnings for embedded sys_ids that may not exist there.

**Architecture:** A pure core module (`src/core/condition-clip.ts`) owns the clip shape, sys_id token extraction and warning text. The side panel owns the live parts: reading the applied filter via the existing `getListQueryFromPage()`, resolving reference labels via `getDictionary` + batched `queryRecords`, and persisting the clip to `chrome.storage.local` under `condClip` — the same mechanism F3's `xmlClip` uses to survive a tab switch to another instance.

**Tech Stack:** TypeScript, Vitest, Chrome MV3 (`chrome.storage.local`, `chrome.tabs`).

## Global Constraints

- New pure logic goes in `src/core/` with a colocated `*.test.ts`; no `chrome.*` in core (Vitest runs core in Node).
- Every core file starts with a block comment explaining the module's role.
- Path alias `@core` → `src/core`.
- The pasted query is written **verbatim**. sys_ids are never rewritten, translated, or dropped.
- A differing host is not a warning — cross-instance transfer is the feature.
- Commands: `npm test`, `npm run typecheck`, `npm run build`.

---

### Task 1: Core module — clip shape and token extraction

**Files:**
- Create: `src/core/condition-clip.ts`
- Test: `src/core/condition-clip.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ConditionClip`, `RefToken`, `extractRefTokens(query: string): RefToken[]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/condition-clip.test.ts
import { describe, it, expect } from 'vitest'
import { extractRefTokens } from './condition-clip'

describe('extractRefTokens', () => {
  it('pairs a sys_id with the field in its clause', () => {
    const q = 'active=true^assigned_to=6816f79cc0a8016401c5a33be04be441'
    expect(extractRefTokens(q)).toEqual([
      { field: 'assigned_to', sysId: '6816f79cc0a8016401c5a33be04be441' },
    ])
  })

  it('handles IN lists and ^OR / ^NQ separators', () => {
    const q =
      'assignment_groupIN287ee6fea9fe198100ada7950d0b1b73,d625dccec0a8016700a222a0f7900d06' +
      '^ORcaller_id=5137153cc611227c000bbd1bd8cd2005'
    expect(extractRefTokens(q)).toEqual([
      { field: 'assignment_group', sysId: '287ee6fea9fe198100ada7950d0b1b73' },
      { field: 'assignment_group', sysId: 'd625dccec0a8016700a222a0f7900d06' },
      { field: 'caller_id', sysId: '5137153cc611227c000bbd1bd8cd2005' },
    ])
  })

  it('ignores clauses with no sys_id, including ORDERBY', () => {
    expect(extractRefTokens('active=true^priority=1^ORDERBYnumber')).toEqual([])
  })

  it('does not match 32-char non-hex or a substring of a longer hex run', () => {
    const nonHex = 'short_descriptionLIKEzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
    const long = 'u_hash=6816f79cc0a8016401c5a33be04be441aaaaaaaa'
    expect(extractRefTokens(nonHex)).toEqual([])
    expect(extractRefTokens(long)).toEqual([])
  })

  it('dedupes a repeated field+sys_id pair', () => {
    const id = '6816f79cc0a8016401c5a33be04be441'
    expect(extractRefTokens(`assigned_to=${id}^ORassigned_to=${id}`)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/condition-clip.test.ts`
Expected: FAIL — `Failed to resolve import "./condition-clip"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/condition-clip.ts
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
/** A bare 32-char lowercase hex token — `\b` keeps it from matching inside a
 *  longer hex run (e.g. a 40-char hash). */
const SYS_ID_RE = /\b[0-9a-f]{32}\b/g
const FIELD_RE = /^([a-z0-9_.]+)/i

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/condition-clip.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/condition-clip.ts src/core/condition-clip.test.ts
git commit -m "feat(condition-clip): extract sys_id reference tokens from an encoded query"
```

---

### Task 2: Core module — warnings and reference-table grouping

**Files:**
- Modify: `src/core/condition-clip.ts`
- Test: `src/core/condition-clip.test.ts`

**Interfaces:**
- Consumes: `ConditionClip`, `RefToken`, `extractRefTokens` from Task 1.
- Produces: `clipWarnings(clip: ConditionClip, current: { host: string; table?: string | null }): string[]` and `groupTokensByRefTable(tokens: RefToken[], refByField: Record<string, string>): Map<string, string[]>` (reference table → deduped sys_ids).

- [ ] **Step 1: Write the failing test**

Append to `src/core/condition-clip.test.ts`:

```ts
import { clipWarnings, groupTokensByRefTable, type ConditionClip } from './condition-clip'

const ID_A = '6816f79cc0a8016401c5a33be04be441'
const ID_B = '5137153cc611227c000bbd1bd8cd2005'

function clip(over: Partial<ConditionClip> = {}): ConditionClip {
  return {
    host: 'dev1.service-now.com',
    table: 'incident',
    query: `active=true^assigned_to=${ID_A}`,
    labels: { [ID_A]: 'Abel Tuter' },
    savedAt: '2026-07-27T00:00:00.000Z',
    ...over,
  }
}

describe('clipWarnings', () => {
  it('does not warn about a different host — that is the point', () => {
    const w = clipWarnings(clip({ labels: {}, query: 'active=true' }), {
      host: 'dev2.service-now.com',
      table: 'incident',
    })
    expect(w).toEqual([])
  })

  it('warns when the current table differs from the clip table', () => {
    const w = clipWarnings(clip({ query: 'active=true', labels: {} }), {
      host: 'dev2.service-now.com',
      table: 'sc_task',
    })
    expect(w).toEqual(['Clip is for `incident`, this page is `sc_task`.'])
  })

  it('lists a resolved sys_id with its label', () => {
    const w = clipWarnings(clip(), { host: 'dev2.service-now.com', table: 'incident' })
    expect(w).toEqual(['assigned_to = Abel Tuter — sys_id may not exist on this instance.'])
  })

  it('marks an unresolved sys_id as such', () => {
    const w = clipWarnings(clip({ labels: {} }), { host: 'dev2.service-now.com', table: 'incident' })
    expect(w).toEqual(['assigned_to = 6816f79c… — could not resolve.'])
  })

  it('omits the table warning when the current table is unknown', () => {
    const w = clipWarnings(clip({ query: 'active=true', labels: {} }), {
      host: 'dev2.service-now.com',
      table: null,
    })
    expect(w).toEqual([])
  })
})

describe('groupTokensByRefTable', () => {
  it('groups sys_ids by the field’s reference table, deduped', () => {
    const tokens = [
      { field: 'assigned_to', sysId: ID_A },
      { field: 'caller_id', sysId: ID_B },
      { field: 'assigned_to', sysId: ID_A },
    ]
    const grouped = groupTokensByRefTable(tokens, { assigned_to: 'sys_user', caller_id: 'sys_user' })
    expect(grouped.get('sys_user')).toEqual([ID_A, ID_B])
  })

  it('skips fields with no reference target', () => {
    const grouped = groupTokensByRefTable([{ field: 'u_thing', sysId: ID_A }], {})
    expect(grouped.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/condition-clip.test.ts`
Expected: FAIL — `clipWarnings is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/condition-clip.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/condition-clip.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/condition-clip.ts src/core/condition-clip.test.ts
git commit -m "feat(condition-clip): warning text and reference-table grouping"
```

---

### Task 3: Side panel — Copy condition

**Files:**
- Modify: `src/sidepanel/index.html` (Condition Tester card, the `btn-row` holding `#cond-run`)
- Modify: `src/sidepanel/main.ts` (Condition Tester section, around `main.ts:848-905`)

**Interfaces:**
- Consumes: `ConditionClip`, `extractRefTokens`, `groupTokensByRefTable` (Tasks 1–2); existing `getListQueryFromPage(table)` (`main.ts:415`), `currentListQuery()` (`main.ts:394`), `isListView()` (`main.ts:390`), `getDictionary`, `queryRecords`, `cellDisplay`, `cellValue`, `showToast`, `el`, `elText`.
- Produces: `condClip` in `chrome.storage.local`; `refreshCondClipButton()` for Task 4.

There is no unit-test harness for `main.ts` — it is DOM + `chrome.*` wiring. Verification for this task is `npm run typecheck` plus the manual smoke steps below, matching how the rest of the side panel is verified.

- [ ] **Step 1: Add the buttons to the markup**

In `src/sidepanel/index.html`, replace the Condition Tester `btn-row`:

```html
          <div class="btn-row">
            <button class="btn" id="cond-run" type="button" disabled>Run condition</button>
            <button class="btn btn-ghost" id="cond-open" type="button" disabled>Open list ↗</button>
            <span class="count-badge" id="cond-count" hidden></span>
          </div>
```

with:

```html
          <div class="btn-row">
            <button class="btn" id="cond-run" type="button" disabled>Run condition</button>
            <button class="btn btn-ghost" id="cond-open" type="button" disabled>Open list ↗</button>
            <span class="count-badge" id="cond-count" hidden></span>
          </div>
          <div class="btn-row" id="cond-clip-row">
            <button class="btn btn-ghost" id="cond-copy" type="button" disabled
              title="Copy this list's condition for use on another instance">Copy condition</button>
            <button class="btn btn-ghost" id="cond-paste" type="button" disabled>Paste</button>
          </div>
          <div class="results" id="cond-warnings" hidden></div>
```

- [ ] **Step 2: Add the element handles and the copy implementation**

In `src/sidepanel/main.ts`, add `LABEL_FIELDS` and `pickLabel` to the existing
`@core/api` import (line 9), then add:

```ts
import {
  clipWarnings,
  extractRefTokens,
  groupTokensByRefTable,
  type ConditionClip,
} from '@core/condition-clip'
```

After the existing `const condResults = el('cond-results')` (`main.ts:855`), add:

```ts
const condCopy = el<HTMLButtonElement>('cond-copy')
const condPaste = el<HTMLButtonElement>('cond-paste')
const condWarnings = el('cond-warnings')
```

Then add, after `openConditionList()` (`main.ts:905`):

```ts
/* --- Condition clip: carry a list filter to another instance --- */

/**
 * The condition to copy, in priority order:
 *   1. the live applied GlideList2 filter (the only source that reflects a
 *      filter applied AFTER page load),
 *   2. the URL's sysparm_query,
 *   3. whatever is typed in the textarea.
 */
async function conditionToCopy(table: string): Promise<string> {
  if (isListView()) {
    const live = await getListQueryFromPage(table)
    if (live !== null) return live
    const fromUrl = currentListQuery()
    if (fromUrl) return fromUrl
  }
  return condQuery.value.trim()
}

/**
 * Resolve display values for the sys_ids in a query: one sys_dictionary read to
 * learn each field's reference table, then one batched `sys_idIN…` query per
 * referenced table. Unresolvable tokens are simply absent from the result —
 * the paste warning says "could not resolve" rather than guessing.
 */
async function resolveClipLabels(
  host: string,
  table: string,
  query: string,
): Promise<Record<string, string>> {
  const tokens = extractRefTokens(query)
  if (tokens.length === 0) return {}

  const dict = await getDictionary(host, table)
  if (!dict.ok) return {}
  const refByField: Record<string, string> = {}
  for (const d of dict.data) {
    const element = cellValue(d.element as unknown)
    const reference = cellValue(d.reference as unknown)
    if (element && reference) refByField[element] = reference
  }

  const labels: Record<string, string> = {}
  for (const [refTable, ids] of groupTokensByRefTable(tokens, refByField)) {
    // Ask for the common label columns and let pickLabel choose. Requesting
    // only sys_id would be useless: with displayValue 'all', the display value
    // OF the sys_id column is the sys_id itself, not the record's name. The
    // Table API ignores sysparm_fields entries a table doesn't have.
    const res = await queryRecords(host, refTable, {
      query: `sys_idIN${ids.join(',')}`,
      fields: ['sys_id', ...LABEL_FIELDS],
      limit: ids.length,
      displayValue: 'all',
    })
    if (!res.ok) continue
    for (const rec of res.data) {
      const id = cellValue(rec['sys_id'])
      const display = pickLabel(rec)
      if (id && display && display !== id) labels[id] = display
    }
  }
  return labels
}

async function copyCondition() {
  if (!current?.table) return
  const { host, table } = current
  condCopy.disabled = true
  condCopy.textContent = 'Copying…'
  try {
    const query = await conditionToCopy(table)
    const labels = await resolveClipLabels(host, table, query)
    const clip: ConditionClip = {
      host,
      table,
      query,
      labels,
      savedAt: new Date().toISOString(),
    }
    await chrome.storage.local.set({ condClip: clip })
    condQuery.value = query
    showToast(query ? `Copied condition (${table})` : `Copied empty condition (${table})`)
  } finally {
    condCopy.textContent = 'Copy condition'
    await refreshCondClipButtons()
  }
}

/** Enable Copy when a table is known; label Paste from the stored clip. */
async function refreshCondClipButtons() {
  condCopy.disabled = !current?.table
  const store = await chrome.storage.local.get('condClip')
  const clip = store.condClip as ConditionClip | undefined
  condPaste.disabled = !clip
  condPaste.textContent = clip ? `Paste (${clip.table})` : 'Paste'
  condPaste.title = clip
    ? `From ${clip.host} · ${new Date(clip.savedAt).toLocaleString()}`
    : 'Nothing copied yet'
}
```

- [ ] **Step 3: Wire the listener and the enabled-state refresh**

In `updateEnabledState()` (`main.ts:854`), add as the last line of the function body:

```ts
  void refreshCondClipButtons()
```

Next to the existing `condRun`/`condOpen` listeners near `main.ts:3163`, add:

```ts
condCopy.addEventListener('click', () => void copyCondition())
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed, no errors.

- [ ] **Step 5: Manual smoke — copy**

1. `chrome://extensions` → reload the unpacked extension from `dist/`.
2. Open `https://<dev instance>/incident_list.do` and apply a filter in the condition builder that includes a reference field (e.g. *Assigned to is <someone>*) — apply it **after** load, so it lives in `GlideList2` and not the URL.
3. Open the side panel → Inspect → **Copy condition**.
4. Expected: toast `Copied condition (incident)`, the textarea fills with the applied query including the sys_id, and **Paste** relabels to `Paste (incident)`.
5. In DevTools for the side panel, run `chrome.storage.local.get('condClip')` and confirm `labels` contains the assignee's display name keyed by sys_id.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/index.html src/sidepanel/main.ts
git commit -m "feat(condition-clip): copy the live list condition with resolved reference labels"
```

---

### Task 4: Side panel — Paste condition

**Files:**
- Modify: `src/sidepanel/main.ts`

**Interfaces:**
- Consumes: `clipWarnings`, `ConditionClip` (Tasks 1–2); `refreshCondClipButtons()` (Task 3).
- Produces: nothing downstream.

- [ ] **Step 1: Implement paste**

In `src/sidepanel/main.ts`, after `refreshCondClipButtons()`, add:

```ts
function renderClipWarnings(warnings: string[]) {
  condWarnings.replaceChildren()
  condWarnings.hidden = warnings.length === 0
  if (warnings.length === 0) return
  condWarnings.append(
    elText('div', 'chk-group-title', 'Check before you trust these results'),
  )
  for (const w of warnings) condWarnings.append(elText('div', 'warn', w))
}

/**
 * Paste the stored condition and open it on THIS instance. The query text is
 * written verbatim — sys_ids are reported, never rewritten, because a name
 * match on the target instance is not proof of the same record.
 *
 * The list opened is `clip.table`, not the current page's table: the point is
 * to carry an `incident` filter across instances regardless of what page the
 * user happens to be on.
 */
async function pasteCondition() {
  if (!current) return
  const store = await chrome.storage.local.get('condClip')
  const clip = store.condClip as ConditionClip | undefined
  if (!clip) return

  condQuery.value = clip.query
  renderClipWarnings(clipWarnings(clip, { host: current.host, table: current.table }))
  condResults.replaceChildren()
  condCount.hidden = true
  condOpen.disabled = false

  const url =
    `https://${current.host}/${clip.table}_list.do` +
    (clip.query ? `?sysparm_query=${encodeURIComponent(clip.query)}` : '')
  void chrome.tabs.create({ url })
}
```

- [ ] **Step 2: Clear stale warnings when the condition changes**

Warnings describe the pasted clip; once the user edits the query or runs a fresh
condition they no longer apply. At the top of `runCondition()` (`main.ts:873`),
directly after `if (!current?.table) return`, add:

```ts
  renderClipWarnings([])
```

And next to the `condCopy` listener from Task 3, add:

```ts
condPaste.addEventListener('click', () => void pasteCondition())
condQuery.addEventListener('input', () => renderClipWarnings([]))
```

- [ ] **Step 3: Add the warning style**

In `src/sidepanel/styles.css`, next to the existing `.error` rule, add:

```css
.warn {
  color: #8a5a00;
  background: #fff6e5;
  border-left: 3px solid #e0a300;
  padding: 6px 8px;
  margin: 4px 0;
  border-radius: 3px;
  font-size: 12px;
}
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 5: Manual smoke — cross-instance paste**

1. Reload the extension. Copy a condition containing a reference sys_id from instance A (Task 3 smoke).
2. Switch to a tab on **instance B** (a different sub-prod instance), any ServiceNow page.
3. Side panel → Inspect → **Paste (incident)**.
4. Expected: the textarea fills with the identical query; an amber warning block lists `assigned_to = <name> — sys_id may not exist on this instance.`; a new tab opens `https://<B>/incident_list.do?sysparm_query=…`.
5. Confirm the query in the opened URL is character-for-character the copied one.
6. On instance B, open a `sc_task` list and paste again — the first warning line must read ``Clip is for `incident`, this page is `sc_task`.``

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/main.ts src/sidepanel/styles.css
git commit -m "feat(condition-clip): paste a condition onto another instance with sys_id warnings"
```

---

### Task 5: Document the feature

**Files:**
- Modify: `README.md` (the `## Tabs` section)

- [ ] **Step 1: Add the entry**

Under the Inspect tab's description in `## Tabs`, add:

```markdown
**Copy/paste condition (cross-instance).** On a list view, *Copy condition* grabs
the filter that is actually applied — read from `GlideList2`, so a filter set
after page load is captured too — together with display labels for any reference
sys_ids in it. On another instance, *Paste* fills the query, lists every sys_id
it depends on as a warning, and opens the matching list there. The query is
pasted verbatim; sys_ids are never rewritten, because a name match on the target
is not proof of the same record.
```

- [ ] **Step 2: Verify the whole suite still passes**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe cross-instance condition copy/paste"
```

---

## Smoke-test checklist (not covered by unit tests)

- [ ] Live `GlideList2` filter read on a classic list view, filter applied after load
- [ ] Fallback to `sysparm_query` when `GlideList2` is unavailable
- [ ] Reference label resolution for a multi-value `IN` clause
- [ ] Cross-instance paste: query identical, warnings shown, list opens on the new host
- [ ] Table-mismatch warning when pasting an `incident` clip on an `sc_task` list
