# Feature — "Fix script" (SN-page icon → AI fix) — Design

- Date: 2026-07-25
- Status: Approved (design)
- Feature area: content script (SN page) + Script Tester tab + LLM

## Problem / Use Case

**Actor:** a ServiceNow developer looking at a script field (Business Rule, Script Include, Client Script, etc.) that has a problem.
**Goal:** click an icon next to the script field → its code lands in the extension → describe the problem/requirement → ask the AI to fix it → get a corrected script + explanation, with a diff.

## Locked decisions

- **Reuse the Script Tester tab** (not a new tab) — it already has a code editor, Java-review LLM wiring, a diff view (`lineDiff`/`showDiff`), and save-to-record.
- **Classic UI + `g_form` script fields first** (the fragile DOM-injection surface). Next Experience / workspace deferred.
- **Page → panel handoff via `chrome.storage.session`** + the panel's existing `onChanged` listener. A page-context click **cannot force-open a closed side panel** (Chrome restricts `sidePanel.open` to extension user-gestures) → the payload is stashed and the panel consumes it when open (via `onChanged`) or on next open (read on init). This limitation is surfaced to the user (a one-time toast/hint: "open the snJava panel to see it").
- Script content is **redacted** before the AI send and the endpoint is **allowlisted** (reuse existing infra), like the other AI features.

## Components

- **`src/content/mainworld.ts`** (MAIN world, has `g_form`):
  - Detect script-type fields on the current form. `g_form.getEditableFields()` + a known set (`sys_script.script`, `sys_script_include.script`, `sys_script_client.script`, `catalog_script_client.script`, `sys_ui_action.script`) — for each present script field, inject a small clickable icon (🔧) near its label/container. Idempotent (don't double-inject; re-run on the late `post()`).
  - On icon click: read `g_form.getValue(field)` + `getTableName()`/`getUniqueValue()` → `postMessage({ kind: 'sncat:fix-script', payload: { table, sysId, field, script } }, origin)`.
  - Extend the `Window.g_form` type with `getValue?`, `getEditableFields?`.
- **`src/content/index.ts`** (isolated): on `sncat:fix-script` → `chrome.storage.session.set({ fixScriptRequest: payload })` (host-agnostic single slot; a new request overwrites).
- **`src/sidepanel/main.ts`:**
  - On the existing `chrome.storage.session.onChanged` listener, when `fixScriptRequest` appears → consume it: switch to the Script Tester tab, load the script into the tester editor, reveal a **"Problem / requirement"** textarea + an **"Ask AI to fix"** button, remember `{table, sysId, field}` (so a later save-to-record can target it), then clear the storage slot.
  - Also read `fixScriptRequest` once on panel init (covers "stashed while the panel was closed").
  - **"Ask AI to fix"**: gate on LLM configured; `startLlmJob('fixscript', { script, problem, table, field })` → on done, put the fixed script in the optimize editor + show a diff (original vs fixed) via the existing diff view + the AI's explanation; reuse the existing "save optimized to record" path when `{table, sysId, field}` is known.
- **`src/core/llm.ts`:** `buildFixScriptPrompt(input: { script: string; problem: string; table?: string; field?: string })` (redacts `script`, asks for a corrected script + short explanation as JSON `{ fixedScript, explanation }`) + `runFixScript(input, config?): FixScriptOutcome` (mirrors the review/plan pattern; reuse `callProvider` + `extractJson` + a `coerceFix`). Unit-tested (prompt redaction + coerce).
- **`src/background/index.ts`:** op `'fixscript'` → `runFixScript`.

## Error handling / edge cases

- Panel closed at click time → payload stays in `storage.session`; consumed on next open. One-time hint tells the user to open the panel.
- LLM unconfigured → "Ask AI to fix" hidden/disabled (reuse the configured gate).
- No script field on the form → no icon injected (nothing to do).
- Re-injection guard so switching records / late `post()` doesn't duplicate icons.
- Redaction + allowlist as elsewhere; AI failure surfaces the error, editor keeps the original.

## Testing

- **Unit (Vitest):** `buildFixScriptPrompt` (redacts the script, includes the problem/requirement, asks for `{fixedScript,explanation}`); `coerceFix` (normalizes a parsed reply; missing fields → safe empties). 
- **Not unit-testable (manual on a live classic SN form):** the MAIN-world icon injection, the storage relay, and the panel pickup — verified via typecheck + build + smoke (panel boots; no icon logic runs without a SN page).

## Acceptance criteria

1. On a classic SN form with a script field, a 🔧 icon appears next to it; clicking it stashes `{table,sysId,field,script}`.
2. With the panel open, the script loads into the Script Tester tab with a Problem/requirement field and an "Ask AI to fix" button; if the panel was closed, opening it consumes the stashed request (with a hint shown).
3. "Ask AI to fix" sends the redacted script + problem to the allowlisted endpoint and returns a corrected script + explanation, shown with a diff; the original is preserved on failure.
4. When `{table,sysId,field}` is known, the fixed script can be saved back via the existing save-to-record path.
5. `buildFixScriptPrompt`/`coerceFix` are unit-tested; CI smoke still boots; injection does nothing off a SN page.
6. No change to prod-guard/review/generate/narrative behavior.
