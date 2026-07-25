# UC-1 — F3 Import Safety: Preview + Dry-run + Per-row + Full Undo (Design)

- Date: 2026-07-25
- Status: Approved (design)
- Feature area: F3 XML Mover (side panel Copy/Paste tab)

## Problem / Use Case

**Actor:** a ServiceNow developer/consultant copying records from one instance and pasting into another.
**Pain:** F3 Paste currently runs one INSERT_OR_UPDATE background import in a single shot with no preview and no way back. If a row updates the wrong record, or a batch partly fails, the user can't see what will happen before it happens and can't reverse it.
**Goal:** before writing, show exactly what each row will do; after writing, show per-row results and offer a real Undo that reverses the import (delete inserts, restore updates).

## Locked decisions

- **Full undo:** inserts are undone by deleting the created record; updates are undone by restoring the previous field values.
- **Undo log scope:** the *last import per host*, persisted in `chrome.storage.local` under `undoLog:<host>`. Surviving panel close; a new import overwrites the previous log for that host.
- **Preview covers all rows** (no row cap).
- **Before-snapshot stores only the fields the import will overwrite** (not the whole record) — smaller and precise.
- Writes remain prod-guarded via `runBackground` (unchanged). Reads (preview) are unguarded, so preview works on any instance.

## Flow (replaces the current single-shot Paste)

1. **Preview / dry-run (read-only).** A background script reads each row by `sys_id` and returns `{ sysId, action: 'insert' | 'update' }` per row **without writing**. The panel renders a preview table: row #, table, action, and a ⚠ marker on `update` rows (they overwrite an existing record). The user confirms or cancels.
2. **Import (write, prod-guarded).** On confirm, a background script performs the INSERT_OR_UPDATE. For every `update` row it captures the **before-values of exactly the fields it is about to overwrite**, *within the same script, immediately before writing* (atomic — no dry-run→import TOCTOU). It returns per-row results `{ sysId, action, ok, error? }` plus the captured before-snapshot for updates and the created sys_id for inserts. The panel persists the undo log to `chrome.storage.local` and shows the per-row result list + an **Undo last import** button.
3. **Undo (write, prod-guarded).** Reads `undoLog:<host>`, runs a background script that per row: `insert` → `deleteRecord` by sys_id; `update` → set the stored before-values back. Returns per-row undo results; clears the rows that undid successfully (keeps any that failed, with their errors shown).

## Components

Most work lives in `src/sidepanel/main.ts` (the F3 flow + UI), following the existing pattern of in-file background-script string builders.

- `buildPreviewScript(table, rows)` — **new** — read-only server script returning per-row `insert|update` (checks `GlideRecord.get(sysId)`), emits a parseable marker (same `snJava:` convention as existing bg output).
- `buildImportScript(...)` — **modified** — in addition to inserting/updating, for each `update` row read the current values of just the fields being written *before* writing, and include them + per-row outcome in the emitted result marker.
- `buildUndoScript(table, undoRows)` — **new** — per row: delete (insert case) or restore before-values (update case); emits per-row undo outcome.
- **Undo-log helper (pure, unit-tested):** `buildUndoLog(host, table, importResults)` → the `{ host, table, importedAt, rows }` object, including only successfully-written rows and, for updates, the before-values. Keeping this pure lets it be unit-tested without chrome/instance.
- **UI functions** in `main.ts`: render the preview table; render per-row results; render/restore the Undo button (shown whenever `undoLog:<current host>` exists, re-checked on panel open / host change — reuse the existing host-change handling).

## Data / storage

- Key: `chrome.storage.local['undoLog:' + host]`.
- Shape: `{ host: string, table: string, importedAt: string, rows: Array<{ sysId: string, action: 'insert' | 'update', before?: Record<string,string> }> }`.
- `before` present only for `update` rows and holds only the overwritten fields.
- Bounded to one import per host. Wrap the `storage.set` in try/catch (per the T-410 pattern): if it fails (quota), warn the user that **Undo is unavailable for this import** — the import itself still succeeded.

## Error handling / failure modes

- Preview fetch fails → show the error, do not proceed to import.
- Import partial failure → show per-row errors; write the undo log for the rows that *did* succeed (a partial import is still undoable).
- Undo partial failure → show per-row undo errors; retain the undo log entries that failed to undo (drop the ones that undid).
- Host change between preview and import is already guarded by the existing host-pin pattern (snapshot host before the confirm) — reuse it here.

## Testing

- **Unit (Vitest):** `buildUndoLog` (constructs the log from import results — includes only successful rows; updates carry before-values of overwritten fields only; inserts carry the created sys_id). Optionally assert the shape of the strings produced by `buildPreviewScript`/`buildUndoScript` (e.g. they reference `GlideRecord`, `deleteRecord`, `get(sysId)`, and set only the recorded fields) via string assertions.
- **Not unit-testable (manual smoke on a real sub-prod):** the bgrun round-trips (preview/import/undo) and the `chrome.storage.local` persistence — same live-I/O caveat as the rest of F1–F3.
- **CI:** the UC-2 Playwright smoke must still boot the panel without error after the new UI is added.

## Acceptance criteria

1. Paste now shows a preview table (row #, table, INSERT/UPDATE per row, ⚠ on updates) before any write; cancel writes nothing.
2. Confirming runs the import and shows a per-row result list (ok/error per row).
3. After a successful (or partially successful) import, an **Undo last import** button appears and persists across panel close (restored on reopen while on the same host).
4. Undo deletes inserted records and restores the overwritten fields of updated records, reporting per-row undo results, then clears the (successfully undone) log.
5. Before-snapshots contain only the fields the import overwrote.
6. Writes (import, undo) stay prod-guarded; preview works read-only on any instance.
7. `buildUndoLog` is unit-tested; the CI smoke still boots the panel.
