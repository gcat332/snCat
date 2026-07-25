# UC-1 F3 Import Safety — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make F3 Paste show a per-row preview (INSERT/UPDATE) before writing, report per-row results after, and offer a persistent full Undo (delete inserts, restore updated fields).

**Architecture:** Extract the F3 import logic into a pure, unit-tested `src/core/f3-import.ts` (types, `buildUndoLog`, `partitionPreview`, `buildImportScript`, `buildUndoScript`), then rewire `pasteXmlInner` in `src/sidepanel/main.ts` into preview → confirm → import → per-row results, and add a persistent "Undo last import" button. Preview uses a **read-only Table API existence query** (works on any instance); import and undo run through the existing prod-guarded `runBackground`.

**Tech Stack:** TypeScript, Vitest, existing `@core/api-client` (`queryRecords`, `runBackground`), `chrome.storage.local`.

## Global Constraints

- Pure logic goes in `src/core/*` with a colocated `*.test.ts`; no `chrome.*`/DOM in core (keeps it Node-testable) — per CLAUDE.md.
- Writes (import, undo) MUST go through `runBackground` (prod-guarded). Preview MUST be a read-only Table API query, never a background script (so it works on any instance, per the spec's AC #6).
- Before-snapshots store ONLY the fields the import overwrites.
- Undo log = last import per host in `chrome.storage.local['undoLog:' + host]`; a new import overwrites it; wrap `storage.set` in try/catch and warn (not fail) on quota error.
- Snapshot the host into a local BEFORE any confirm dialog (existing host-pin pattern).
- Server-side background scripts emit results as `gs.info('snJava:<marker> ' + JSON.stringify({rows:[...]}))`; the panel parses with the existing `parseSnjava(output, 'snJava:<marker> ')` (balanced-brace object scanner).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Reference — current code (read before starting)

- `src/sidepanel/main.ts`: `XmlClip` interface (~352); `pasteXml`/`pasteInFlight` (~531); `pasteXmlInner` (~545, the flow to rewrite); `buildImportScript` (~630, to MOVE to core and extend); `extractBgOutput` (~1719); `parseSnjava(output, marker)` (~1910, returns the first balanced `{...}` object after the marker, or null); `refreshXmlControls` (~437); `xmlOut = el('xml-out')` (~350).
- `src/core/api-client.ts`: `queryRecords(host, table, options)`, `runBackground(host, script, opts)`.
- `src/core/api.ts`: `QueryOptions` (has `query?`, `fields?`).
- UI ids (`src/sidepanel/index.html`): `#xml-paste`, `#xml-out`, `#xml-row`.

---

### Task 1: Pure F3 import core (`src/core/f3-import.ts`) + tests

**Files:**
- Create: `src/core/f3-import.ts`
- Create: `src/core/f3-import.test.ts`
- Modify: `src/sidepanel/main.ts` (remove the local `buildImportScript`, import it from `@core/f3-import` instead — done fully in Task 2; in THIS task just create the core module + tests)

**Interfaces produced:**
- `type ImportAction = 'insert' | 'update'`
- `interface PreviewRow { sysId: string; action: ImportAction }`
- `interface ImportRowResult { sysId: string; action: ImportAction; ok: boolean; error?: string; before?: Record<string, string> }`
- `interface UndoRow { sysId: string; action: ImportAction; before?: Record<string, string> }`
- `interface UndoLog { host: string; table: string; importedAt: string; rows: UndoRow[] }`
- `partitionPreview(rows: Record<string,string>[], existingSysIds: Set<string>): PreviewRow[]`
- `buildUndoLog(host: string, table: string, results: ImportRowResult[], importedAt: string): UndoLog`
- `buildImportScript(table: string, records: Record<string,string>[]): string`
- `buildUndoScript(table: string, rows: UndoRow[]): string`

- [ ] **Step 1: Write the failing tests**

Create `src/core/f3-import.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { partitionPreview, buildUndoLog, buildImportScript, buildUndoScript } from './f3-import'

describe('partitionPreview', () => {
  it('marks rows whose sys_id exists on the target as update, others as insert', () => {
    const rows = [{ sys_id: 'a', name: 'x' }, { sys_id: 'b', name: 'y' }, { sys_id: 'c' }]
    const out = partitionPreview(rows, new Set(['b']))
    expect(out).toEqual([
      { sysId: 'a', action: 'insert' },
      { sysId: 'b', action: 'update' },
      { sysId: 'c', action: 'insert' },
    ])
  })
})

describe('buildUndoLog', () => {
  it('keeps only successful rows; updates carry before-values, inserts do not', () => {
    const results = [
      { sysId: 'a', action: 'insert' as const, ok: true },
      { sysId: 'b', action: 'update' as const, ok: true, before: { name: 'old' } },
      { sysId: 'c', action: 'insert' as const, ok: false, error: 'ACL' },
    ]
    expect(buildUndoLog('dev.service-now.com', 'incident', results, '2026-07-25T00:00:00Z')).toEqual({
      host: 'dev.service-now.com',
      table: 'incident',
      importedAt: '2026-07-25T00:00:00Z',
      rows: [
        { sysId: 'a', action: 'insert' },
        { sysId: 'b', action: 'update', before: { name: 'old' } },
      ],
    })
  })
})

describe('buildImportScript', () => {
  it('captures before-values for updates and emits a snJava:import marker', () => {
    const s = buildImportScript('incident', [{ sys_id: 'a', short_description: 'hi' }])
    expect(s).toContain('new GlideRecord("incident")')
    expect(s).toContain('setWorkflow(false)')
    expect(s).toContain('setNewGuidValue')
    expect(s).toContain('before[k]') // snapshots overwritten fields before update
    expect(s).toContain("snJava:import ")
    expect(s).toContain('JSON.stringify')
  })
})

describe('buildUndoScript', () => {
  it('deletes inserts and restores update before-values, emitting snJava:undo', () => {
    const s = buildUndoScript('incident', [
      { sysId: 'a', action: 'insert' },
      { sysId: 'b', action: 'update', before: { name: 'old' } },
    ])
    expect(s).toContain('deleteRecord()')
    expect(s).toContain('setValue') // restore path
    expect(s).toContain("snJava:undo ")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/f3-import.test.ts`
Expected: FAIL — cannot find module `./f3-import`.

- [ ] **Step 3: Write the implementation**

Create `src/core/f3-import.ts`:

```ts
/**
 * F3 XML Mover — pure import/undo logic (no chrome.*, Node-testable).
 * Preview uses a read-only Table API query in the panel (see main.ts); this
 * module partitions the result, shapes the undo log, and builds the server-side
 * background scripts for import (INSERT_OR_UPDATE, capturing before-values of
 * overwritten fields) and undo (delete inserts / restore updated fields).
 */
export type ImportAction = 'insert' | 'update'

export interface PreviewRow {
  sysId: string
  action: ImportAction
}

export interface ImportRowResult {
  sysId: string
  action: ImportAction
  ok: boolean
  error?: string
  before?: Record<string, string>
}

export interface UndoRow {
  sysId: string
  action: ImportAction
  before?: Record<string, string>
}

export interface UndoLog {
  host: string
  table: string
  importedAt: string
  rows: UndoRow[]
}

/** Fields never copied/overwritten (recomputed or unsafe across instances). */
const DROP = ['sys_mod_count', 'sys_tags', 'sys_domain', 'sys_domain_path']

/** Client-side preview: which rows already exist on the target (→ update). */
export function partitionPreview(
  rows: Record<string, string>[],
  existingSysIds: Set<string>,
): PreviewRow[] {
  return rows.map((r) => {
    const sysId = r['sys_id'] ?? ''
    return { sysId, action: existingSysIds.has(sysId) ? 'update' : 'insert' }
  })
}

/** Undo log = only successfully-written rows; updates carry their before-values. */
export function buildUndoLog(
  host: string,
  table: string,
  results: ImportRowResult[],
  importedAt: string,
): UndoLog {
  const rows: UndoRow[] = results
    .filter((r) => r.ok)
    .map((r) =>
      r.action === 'update'
        ? { sysId: r.sysId, action: 'update' as const, before: r.before ?? {} }
        : { sysId: r.sysId, action: 'insert' as const },
    )
  return { host, table, importedAt, rows }
}

/**
 * Server-side import script. INSERT_OR_UPDATE by sys_id. For updates, captures
 * the CURRENT values of exactly the fields it is about to overwrite, BEFORE
 * writing, and returns them per row so the panel can build an undo log.
 * Emits: gs.info('snJava:import ' + JSON.stringify({rows:[{sysId,action,ok,error?,before?}]})).
 */
export function buildImportScript(table: string, records: Record<string, string>[]): string {
  const T = JSON.stringify(table)
  const DROPJSON = JSON.stringify(Object.fromEntries(DROP.map((k) => [k, 1])))
  return [
    `var rows = ${JSON.stringify(records)};`,
    `var DROP = ${DROPJSON};`,
    `var results = [];`,
    `for (var i = 0; i < rows.length; i++) {`,
    `  var row = rows[i];`,
    `  var sysId = row['sys_id'];`,
    `  try {`,
    `    var keys = [];`,
    `    for (var k in row) { if (row.hasOwnProperty(k) && k !== 'sys_id' && !DROP[k]) keys.push(k); }`,
    `    var chk = null;`,
    `    if (sysId) { var g = new GlideRecord(${T}); if (g.get(sysId)) { chk = g; } }`,
    `    if (chk) {`,
    `      var before = {};`,
    `      for (var bi = 0; bi < keys.length; bi++) { before[keys[bi]] = '' + chk.getValue(keys[bi]); }`,
    `      for (var ui = 0; ui < keys.length; ui++) { chk.setValue(keys[ui], row[keys[ui]]); }`,
    `      chk.setWorkflow(false); chk.autoSysFields(false);`,
    `      if (chk.update()) { results.push({sysId: sysId, action: 'update', ok: true, before: before}); }`,
    `      else { results.push({sysId: sysId, action: 'update', ok: false, error: '' + (chk.getLastErrorMessage() || 'update rejected')}); }`,
    `    } else {`,
    `      var gr = new GlideRecord(${T});`,
    `      gr.initialize();`,
    `      for (var ii = 0; ii < keys.length; ii++) { gr.setValue(keys[ii], row[keys[ii]]); }`,
    `      if (sysId) gr.setNewGuidValue(sysId);`,
    `      gr.setWorkflow(false); gr.autoSysFields(false);`,
    `      var id = gr.insert();`,
    `      if (id) { results.push({sysId: '' + id, action: 'insert', ok: true}); }`,
    `      else { results.push({sysId: sysId, action: 'insert', ok: false, error: '' + (gr.getLastErrorMessage() || 'insert rejected')}); }`,
    `    }`,
    `  } catch (e) { results.push({sysId: sysId, action: (chk ? 'update' : 'insert'), ok: false, error: '' + e}); }`,
    `}`,
    `gs.info('snJava:import ' + JSON.stringify({rows: results}));`,
  ].join('\n')
}

/**
 * Server-side undo script. Inserts → deleteRecord by sys_id; updates → restore
 * the recorded before-values. Emits:
 * gs.info('snJava:undo ' + JSON.stringify({rows:[{sysId,ok,error?}]})).
 */
export function buildUndoScript(table: string, rows: UndoRow[]): string {
  const T = JSON.stringify(table)
  return [
    `var rows = ${JSON.stringify(rows)};`,
    `var results = [];`,
    `for (var i = 0; i < rows.length; i++) {`,
    `  var r = rows[i];`,
    `  try {`,
    `    var gr = new GlideRecord(${T});`,
    `    if (!gr.get(r.sysId)) { results.push({sysId: r.sysId, ok: false, error: 'record not found'}); continue; }`,
    `    if (r.action === 'insert') {`,
    `      if (gr.deleteRecord()) { results.push({sysId: r.sysId, ok: true}); }`,
    `      else { results.push({sysId: r.sysId, ok: false, error: '' + (gr.getLastErrorMessage() || 'delete rejected')}); }`,
    `    } else {`,
    `      var before = r.before || {};`,
    `      for (var k in before) { if (before.hasOwnProperty(k)) gr.setValue(k, before[k]); }`,
    `      gr.setWorkflow(false); gr.autoSysFields(false);`,
    `      if (gr.update()) { results.push({sysId: r.sysId, ok: true}); }`,
    `      else { results.push({sysId: r.sysId, ok: false, error: '' + (gr.getLastErrorMessage() || 'restore rejected')}); }`,
    `    }`,
    `  } catch (e) { results.push({sysId: r.sysId, ok: false, error: '' + e}); }`,
    `}`,
    `gs.info('snJava:undo ' + JSON.stringify({rows: results}));`,
  ].join('\n')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/f3-import.test.ts`
Expected: PASS (4 describe blocks). Then full `npm test` — expect the prior 153 + these new tests, all green.

- [ ] **Step 5: Commit**

```bash
git add src/core/f3-import.ts src/core/f3-import.test.ts
git commit -m "$(printf 'feat(f3): pure import/undo core — preview partition, undo-log, bg scripts\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Rewire Paste into preview → confirm → import with per-row results

**Files:**
- Modify: `src/sidepanel/main.ts` — rewrite `pasteXmlInner` (~545-605); remove the local `buildImportScript` (~630-664); add `import { partitionPreview, buildUndoLog, buildImportScript, type ImportRowResult, type UndoLog } from '@core/f3-import'`; ensure `queryRecords` is imported from `@core/api-client`.

**Interfaces:**
- Consumes: Task 1's `partitionPreview`, `buildImportScript`, `buildUndoLog`, `ImportRowResult`, `UndoLog`; existing `queryRecords`, `runBackground`, `parseSnjava`, `extractBgOutput`, `refreshXmlControls`, `xmlOut`.
- Produces: after a successful/partial import, `chrome.storage.local['undoLog:'+host]` holds an `UndoLog`; the panel shows a per-row result list. (Task 3 consumes the stored `undoLog:<host>`.)

- [ ] **Step 1: Update imports and remove the moved builder**

At the top of `main.ts`, remove the local `buildImportScript` function (~630-664) and add:
```ts
import { partitionPreview, buildUndoLog, buildImportScript, buildUndoScript, type ImportRowResult, type UndoLog } from '@core/f3-import'
```
Confirm `queryRecords` is in the existing `@core/api-client` import list (add it if missing).

- [ ] **Step 2: Rewrite `pasteXmlInner`**

Replace the body of `pasteXmlInner` (from `const rows = parseUnloadXmlAll(...)` through the end of the function) with:

```ts
  const rows = parseUnloadXmlAll(clip.xml, clip.table).map((r) => r.fields)
  if (rows.length === 0) {
    xmlOut.replaceChildren(elText('div', 'error', 'No records found in the copied XML.'))
    return
  }
  const noun = rows.length === 1 ? 'record' : 'records'

  // PREVIEW (read-only, works on any instance): which sys_ids already exist?
  xmlOut.replaceChildren(elText('div', 'empty', `Checking ${rows.length} ${noun} on ${host}…`))
  const ids = rows.map((r) => r['sys_id']).filter(Boolean)
  const q = await queryRecords(host, clip.table, { query: `sys_idIN${ids.join(',')}`, fields: ['sys_id'] })
  if (!q.ok) {
    xmlOut.replaceChildren(elText('div', 'error', `Preview failed: ${q.error}`))
    return
  }
  const existing = new Set((q.data as Array<Record<string, unknown>>).map((r) => String(r['sys_id'])))
  const preview = partitionPreview(rows, existing)
  const nUpd = preview.filter((p) => p.action === 'update').length
  const nIns = preview.length - nUpd

  // Render the preview table.
  xmlOut.replaceChildren()
  xmlOut.append(elText('div', 'sim-after-title', `Preview — ${nIns} insert, ${nUpd} update`))
  const tbl = document.createElement('div')
  tbl.className = 'diff-kv'
  preview.forEach((p, i) => {
    const r = document.createElement('div')
    r.className = 'info-row'
    r.append(
      elText('span', 'info-name', `${i + 1}. ${p.sysId.slice(0, 8)}…`),
      elText('span', p.action === 'update' ? 'dk-tag engine' : 'dk-tag sent', p.action === 'update' ? '⚠ UPDATE' : 'INSERT'),
    )
    tbl.append(r)
  })
  xmlOut.append(tbl)

  if (
    !(await confirmDialog(
      `Import ${rows.length} "${clip.table}" ${noun} into ${host}?\n\n${nIns} new record(s) inserted (sys_id preserved), ${nUpd} existing record(s) UPDATED (overwritten). Business rules skipped. You can Undo this afterwards.`,
    ))
  ) {
    xmlOut.append(elText('div', 'info-sub', 'Cancelled — nothing was written.'))
    return
  }

  // IMPORT (prod-guarded write).
  xmlOut.append(elText('div', 'empty', `Importing ${rows.length} ${noun}…`))
  const res = await runBackground(host, buildImportScript(clip.table, rows), {})
  if (!res.ok) {
    xmlOut.append(elText('div', 'error', res.error))
    return
  }
  const parsed = parseSnjava(extractBgOutput(res.data), 'snJava:import ') as { rows?: ImportRowResult[] } | null
  const results: ImportRowResult[] = parsed?.rows ?? []
  if (results.length === 0) {
    xmlOut.append(elText('div', 'error', `Import may have failed — output: ${extractBgOutput(res.data).slice(0, 400)}`))
    return
  }
  const okCount = results.filter((r) => r.ok).length

  // Persist the undo log (last import per host). Quota failure ⇒ warn, don't fail.
  const log: UndoLog = buildUndoLog(host, clip.table, results, new Date().toISOString())
  let undoAvailable = log.rows.length > 0
  try {
    await chrome.storage.local.set({ [`undoLog:${host}`]: log })
  } catch {
    undoAvailable = false
  }

  // Per-row result list.
  xmlOut.replaceChildren(
    elText('div', okCount === results.length ? 'ok-banner' : 'error', `${okCount === results.length ? '✓' : '⚠'} Imported ${okCount}/${results.length} ${clip.table} ${noun}`),
  )
  const list = document.createElement('div')
  list.className = 'diff-kv'
  results.forEach((r, i) => {
    const row = document.createElement('div')
    row.className = 'info-row'
    row.append(
      elText('span', 'info-name', `${i + 1}. ${r.sysId.slice(0, 8)}…`),
      elText('span', r.ok ? 'dk-tag sent' : 'error', r.ok ? `✓ ${r.action}` : `✗ ${r.error ?? 'failed'}`),
    )
    list.append(row)
  })
  xmlOut.append(list)
  if (!undoAvailable) xmlOut.append(elText('div', 'info-sub', 'Note: Undo is unavailable for this import (nothing undoable or storage full).'))

  // Consume the clip once anything imported (matches prior one-shot semantics).
  if (okCount > 0) {
    await chrome.storage.local.remove('xmlClip')
  }
  await renderUndoControls(host) // defined in Task 3
  await refreshXmlControls()
```

Note: `renderUndoControls(host)` is added in Task 3. Until Task 3 lands, add a temporary stub near the other F3 helpers so this task builds:
```ts
async function renderUndoControls(_host: string): Promise<void> {}
```
(Task 3 replaces the stub with the real implementation.)

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0. (No unit test for main.ts — it is chrome/DOM-bound.)

- [ ] **Step 4: Run the full test suite + CI smoke**

Run: `npm test && npm run build && npm run test:smoke`
Expected: unit tests green (Task 1 tests included); smoke still boots the panel with no error.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/main.ts
git commit -m "$(printf 'feat(f3): preview + per-row results before/after import; persist undo log\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: "Undo last import" button — restore + persistence

**Files:**
- Modify: `src/sidepanel/main.ts` — replace the `renderUndoControls` stub with the real implementation; call it on panel load and whenever the host changes (in the existing `detect()`/XML-controls refresh path).

**Interfaces:**
- Consumes: Task 1's `buildUndoScript`, `type UndoLog`; the `undoLog:<host>` written by Task 2; existing `runBackground`, `parseSnjava`, `extractBgOutput`, `confirmDialog`, `xmlOut`, `current`.

- [ ] **Step 1: Implement `renderUndoControls`**

Replace the `renderUndoControls` stub with:

```ts
/** Show/refresh the "Undo last import" button for the current host, if a log exists. */
async function renderUndoControls(host: string): Promise<void> {
  const existing = document.getElementById('undo-last')
  if (existing) existing.remove()
  const store = await chrome.storage.local.get(`undoLog:${host}`)
  const log = store[`undoLog:${host}`] as UndoLog | undefined
  if (!log || log.rows.length === 0) return

  const btn = document.createElement('button')
  btn.id = 'undo-last'
  btn.className = 'btn btn-ghost'
  const nIns = log.rows.filter((r) => r.action === 'insert').length
  const nUpd = log.rows.length - nIns
  btn.textContent = `Undo last import (${nIns} inserted, ${nUpd} updated)`
  btn.addEventListener('click', () => void undoLastImport(host))
  xmlOut.before(btn)
}

/** Reverse the last import on `host`: delete inserts, restore updated fields. */
async function undoLastImport(host: string): Promise<void> {
  const store = await chrome.storage.local.get(`undoLog:${host}`)
  const log = store[`undoLog:${host}`] as UndoLog | undefined
  if (!log || log.rows.length === 0) return
  if (
    !(await confirmDialog(
      `Undo the last import on ${host}?\n\nDeletes ${log.rows.filter((r) => r.action === 'insert').length} inserted record(s) and restores ${log.rows.filter((r) => r.action === 'update').length} updated record(s) to their previous values.`,
    ))
  ) {
    return
  }
  xmlOut.replaceChildren(elText('div', 'empty', `Undoing ${log.rows.length} change(s) on ${host}…`))
  const res = await runBackground(host, buildUndoScript(log.table, log.rows), {})
  if (!res.ok) {
    xmlOut.replaceChildren(elText('div', 'error', res.error))
    return
  }
  const parsed = parseSnjava(extractBgOutput(res.data), 'snJava:undo ') as { rows?: Array<{ sysId: string; ok: boolean; error?: string }> } | null
  const undone = parsed?.rows ?? []
  const okIds = new Set(undone.filter((r) => r.ok).map((r) => r.sysId))
  const okCount = okIds.size

  // Keep only the rows that FAILED to undo; clear the log if all undone.
  const remaining = log.rows.filter((r) => !okIds.has(r.sysId))
  if (remaining.length === 0) {
    await chrome.storage.local.remove(`undoLog:${host}`)
  } else {
    await chrome.storage.local.set({ [`undoLog:${host}`]: { ...log, rows: remaining } })
  }

  xmlOut.replaceChildren(
    elText('div', okCount === log.rows.length ? 'ok-banner' : 'error', `${okCount === log.rows.length ? '✓' : '⚠'} Undid ${okCount}/${log.rows.length} change(s)`),
  )
  undone.filter((r) => !r.ok).forEach((r) => xmlOut.append(elText('div', 'error', `${r.sysId.slice(0, 8)}…: ${r.error ?? 'failed'}`)))
  await renderUndoControls(host)
}
```

- [ ] **Step 2: Call `renderUndoControls` on load and host change**

Find where `refreshXmlControls()` is called after context is detected (the XML-controls refresh path invoked from `detect()`). Immediately after `refreshXmlControls()` resolves there, and guarded by a current host, call:
```ts
if (current?.host) void renderUndoControls(current.host)
```
(Add it in the same place `refreshXmlControls()` is invoked so the button restores on panel open and updates on host change.)

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 4: Full suite + CI smoke**

Run: `npm test && npm run build && npm run test:smoke`
Expected: unit tests green; smoke boots the panel with no error (the Undo button is absent when no log exists, so boot is unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/main.ts
git commit -m "$(printf 'feat(f3): persistent Undo last import (delete inserts, restore updates)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- Preview table before write (AC #1) → Task 2 Step 2 (preview via read-only query). ✓
- Per-row results (AC #2) → Task 2 Step 2 result list. ✓
- Persistent Undo button, restored on reopen (AC #3) → Task 3 (`renderUndoControls` called on load/host change; storage.local). ✓
- Undo deletes inserts / restores updates, per-row, clears log (AC #4) → Task 1 `buildUndoScript` + Task 3 `undoLastImport`. ✓
- Before-snapshots only overwritten fields (AC #5) → Task 1 `buildImportScript` snapshots exactly `keys` (the written fields). ✓
- Writes prod-guarded; preview read-only on any instance (AC #6) → import/undo via `runBackground`; preview via `queryRecords`. ✓ (This is why preview is a Table-API query, not a bg script — noted as a plan refinement of the spec's `buildPreviewScript`.)
- `buildUndoLog` unit-tested; CI smoke still boots (AC #7) → Task 1 tests; Task 2/3 Step 4. ✓

**Placeholder scan:** No TBD/TODO. The `renderUndoControls` stub in Task 2 is an explicit, named temporary that Task 3 replaces — not an open placeholder; its real code is fully given in Task 3.

**Type/name consistency:** `ImportRowResult`, `UndoLog`, `UndoRow`, `PreviewRow`, `partitionPreview`, `buildUndoLog`, `buildImportScript`, `buildUndoScript`, marker strings `snJava:import ` / `snJava:undo `, and the storage key `undoLog:<host>` are used identically across Tasks 1–3. `buildUndoScript` is imported in Task 2's import line (used in Task 3) — consistent.
