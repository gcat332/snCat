# "Fix script" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A 🔧 icon next to SN script fields pipes the code into the Script Tester tab, where the user adds a problem/requirement and asks the AI to fix it (corrected script + explanation + diff).

**Architecture:** New pure `buildFixScriptPrompt`/`coerceFix`/`runFixScript` in `llm.ts`; a `'fixscript'` background op; MAIN-world icon injection + read in `mainworld.ts`; a `storage.session` relay in `content/index.ts`; and panel pickup + Script-Tester wiring in `main.ts`.

**Tech Stack:** TypeScript, Vitest, existing LLM + content-script + storage.session infra.

## Global Constraints

- Pure logic in `src/core/*` with colocated tests; no chrome/DOM in core.
- Reuse `redactScript` + `callProvider` (allowlist) + `extractJson`; reuse the Script Tester editor/diff/save infra — no new tab.
- Page→panel handoff is via `chrome.storage.session['fixScriptRequest']`; a page click cannot force-open a closed panel (documented).
- Classic UI + `g_form` script fields only for v1; icon injection is best-effort/idempotent and must never throw on the page.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do not change prod-guard/review/generate/narrative behavior.

## Reference (read first)

- `src/core/llm.ts`: `LlmConfig`, `redactScript`, `callProvider`, `extractJson`, `loadLlmConfig`, `PlanOutcome`/`coercePlan` (the shape to mirror).
- `src/content/mainworld.ts`: `Window.g_form` type, `snapshot()`, the `post()` calls, the `message` listener.
- `src/content/index.ts`: the `window.addEventListener('message', …)` handling `sncat:g_form`/`sncat:fetch-result`.
- `src/sidepanel/main.ts`: `startLlmJob(op,payload)`; the `chrome.storage.session.onChanged` listener + `restoreLlmJobs` init; `testerEd`/`optimizeEd` (Script Tester editors); `showDiff(before,after)`; `saveOptimizedToRecord` + `loadedScriptRecord` ({host,table,sysId,scriptField}); `activateTab`; `showToast`; the configured-gate.
- `src/background/index.ts`: `LlmRunMessage.op`, `runLlmJob` switch.

---

### Task 1: `llm.ts` — fix-script prompt + runner (+ tests)

**Files:** Modify `src/core/llm.ts`, `src/core/llm.test.ts`.

**Interfaces produced:**
- `interface FixScriptInput { script: string; problem: string; table?: string; field?: string }`
- `interface FixScriptResult { fixedScript: string; explanation: string }`
- `buildFixScriptPrompt(input: FixScriptInput): { system: string; user: string }`
- `type FixScriptOutcome = { configured: false } | { configured: true; ok: true; result: FixScriptResult } | { configured: true; ok: false; error: string }`
- `runFixScript(input: FixScriptInput, config?: LlmConfig | null): Promise<FixScriptOutcome>`

- [ ] **Step 1: Failing tests** (append to `src/core/llm.test.ts`; add `buildFixScriptPrompt` to the `./llm` import):

```ts
describe('buildFixScriptPrompt', () => {
  it('redacts the script, includes the problem, and asks for JSON', () => {
    const p = buildFixScriptPrompt({ script: 'var pw = "hunter2"; gs.info(pw);', problem: 'leaks password', table: 'sys_script', field: 'script' })
    expect(p.user).toContain('leaks password')
    expect(p.user).toContain('sys_script')
    expect(p.user).not.toContain('hunter2')
    expect(p.user).toContain('REDACTED')
    expect(p.system).toContain('fixedScript')
  })
})
```

- [ ] **Step 2: Run — verify fail:** `npx vitest run src/core/llm.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement** (add to `src/core/llm.ts`, near the other prompt builders/runners):

```ts
export interface FixScriptInput {
  script: string
  problem: string
  table?: string
  field?: string
}
export interface FixScriptResult {
  fixedScript: string
  explanation: string
}

/** Prompt to fix a ServiceNow script given a problem/requirement. Script redacted. */
export function buildFixScriptPrompt(input: FixScriptInput): { system: string; user: string } {
  const system =
    'You are a ServiceNow developer fixing a script. Reply with ONLY a JSON object ' +
    '{"fixedScript": string, "explanation": string} — fixedScript is the corrected script, ' +
    'explanation is 1-3 sentences on what you changed. No markdown, no code fences.'
  const ctx = [input.table && `Table: ${input.table}`, input.field && `Field: ${input.field}`]
    .filter(Boolean)
    .join('\n')
  const user =
    `${ctx ? ctx + '\n' : ''}Problem / requirement:\n${input.problem || '(none given — improve correctness and clarity)'}\n\n` +
    `Script (secrets redacted):\n${redactScript(input.script)}\n\nReturn the JSON.`
  return { system, user }
}

function coerceFix(parsed: unknown): FixScriptResult {
  const o = (parsed ?? {}) as Record<string, unknown>
  return {
    fixedScript: typeof o.fixedScript === 'string' ? o.fixedScript : '',
    explanation: typeof o.explanation === 'string' ? o.explanation : '',
  }
}

export type FixScriptOutcome =
  | { configured: false }
  | { configured: true; ok: true; result: FixScriptResult }
  | { configured: true; ok: false; error: string }

export async function runFixScript(
  input: FixScriptInput,
  config?: LlmConfig | null,
): Promise<FixScriptOutcome> {
  const cfg = config ?? (await loadLlmConfig())
  if (!cfg) return { configured: false }
  const { system, user } = buildFixScriptPrompt(input)
  try {
    const text = await callProvider(cfg, system, user)
    return { configured: true, ok: true, result: coerceFix(extractJson(text)) }
  } catch (err) {
    return { configured: true, ok: false, error: (err as Error).message }
  }
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/core/llm.test.ts` PASS; `npm test` green; `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**
```bash
git add src/core/llm.ts src/core/llm.test.ts
git commit -m "$(printf 'feat(llm): fix-script prompt + runner (redacted, allowlisted)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: MAIN-world icon injection + content relay + background op

**Files:** Modify `src/content/mainworld.ts`, `src/content/index.ts`, `src/background/index.ts`.

- [ ] **Step 1: Background op**

`src/background/index.ts`: import `runFixScript` + `type FixScriptInput`; add `'fixscript'` to `LlmRunMessage.op`; in `runLlmJob`, when `msg.op === 'fixscript'` → `outcome = await runFixScript(msg.payload as unknown as FixScriptInput)`. Add `jobKey(tabId,'fixscript')` to the `tabs.onRemoved` cleanup list.

- [ ] **Step 2: content relay**

`src/content/index.ts`: extend the `window.addEventListener('message', …)` handler with:
```ts
  } else if (data?.kind === 'sncat:fix-script') {
    const p = (event.data as { payload?: unknown }).payload
    chrome.storage.session.set({ fixScriptRequest: p }).catch(() => {})
  }
```
(alongside the existing `sncat:g_form`/`sncat:fetch-result` branches; keep the `event.source === window` guard).

- [ ] **Step 3: MAIN-world icon injection**

`src/content/mainworld.ts`: extend the `Window.g_form` type with `getValue?: (f: string) => string` and `getEditableFields?: () => string[]`. Add:
```ts
const SCRIPT_FIELDS = ['script', 'script_plain', 'client_script', 'code']
const injected = new Set<string>()

function injectFixIcons() {
  const gf = window.g_form
  if (!gf?.getValue) return
  const fields = new Set<string>([...(gf.getEditableFields?.() ?? []), ...SCRIPT_FIELDS])
  for (const field of fields) {
    if (injected.has(field)) continue
    let value: string
    try {
      value = gf.getValue(field)
    } catch {
      continue // field not on this form
    }
    if (typeof value !== 'string') continue
    // Classic form: the field control lives under an element whose id is the field name.
    const control = document.getElementById(field)
    const mount = control?.closest('.form-group, td, .sn-widget-list_v2') ?? control?.parentElement
    if (!mount) continue
    const icon = document.createElement('span')
    icon.textContent = '🔧'
    icon.title = 'snJava — fix this script with AI'
    icon.style.cssText = 'cursor:pointer;margin-left:6px;font-size:14px;user-select:none'
    icon.addEventListener('click', () => {
      let script = ''
      try {
        script = gf.getValue!(field)
      } catch {
        return
      }
      window.postMessage(
        {
          kind: 'sncat:fix-script',
          payload: {
            table: gf.getTableName?.() ?? null,
            sysId: gf.getUniqueValue?.() ?? null,
            field,
            script,
          },
        },
        window.location.origin,
      )
    })
    mount.appendChild(icon)
    injected.add(field)
  }
}
```
Call `injectFixIcons()` in both the immediate and the delayed `post()` path (script fields render after `g_form` init). Wrap the call in try/catch so a DOM quirk never breaks the bridge. Do NOT touch the existing snapshot/fetch logic.

- [ ] **Step 4: Verify**

`npm run build` (0 — content scripts compile) + `npm run typecheck` (0) + `npm test` (green). (No smoke change — content scripts don't load in the smoke's static page.) Confirm `dist/` still builds via `npm run verify:dist`.

- [ ] **Step 5: Commit**
```bash
git add src/content/mainworld.ts src/content/index.ts src/background/index.ts
git commit -m "$(printf 'feat(fix-script): SN-page fix icon + content relay + background op\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Panel pickup + Script-Tester "Ask AI to fix"

**Files:** Modify `src/sidepanel/main.ts`, `src/sidepanel/index.html`.

- [ ] **Step 1: HTML** — in the Script Tester card (near the tester editor / `#sim-run`), add a hidden fix-script block:
```html
          <div id="fix-script-box" hidden>
            <label class="field-label" for="fix-problem">Problem / requirement</label>
            <textarea id="fix-problem" class="query-input" rows="2" placeholder="What's wrong, or what it should do…"></textarea>
            <div class="btn-row">
              <button class="btn" id="fix-run" type="button">Ask AI to fix</button>
              <span class="spinner" id="fix-spinner" hidden></span>
            </div>
          </div>
```

- [ ] **Step 2: Consume the relayed request**

In `main.ts`: add `let fixScriptTarget: { table: string | null; sysId: string | null; field: string } | null = null`. Add:
```ts
async function consumeFixScriptRequest() {
  const store = await chrome.storage.session.get('fixScriptRequest')
  const req = store['fixScriptRequest'] as { table: string | null; sysId: string | null; field: string; script: string } | undefined
  if (!req) return
  await chrome.storage.session.remove('fixScriptRequest')
  activateTab('tab-tester') // use the actual Script Tester tab id from index.html
  testerEd.setValue(req.script)
  fixScriptTarget = { table: req.table, sysId: req.sysId, field: req.field }
  // So a later "save optimized to record" can target the source field:
  if (req.table && req.sysId) loadedScriptRecord = { host: current?.host ?? '', table: req.table, sysId: req.sysId, scriptField: req.field }
  el('fix-script-box').hidden = false
  showToast('Script loaded from ServiceNow — describe the problem, then Ask AI to fix')
}
```
Wire it: (a) call `void consumeFixScriptRequest()` once on panel init (near `restoreLlmJobs()`); (b) in the existing `chrome.storage.session.onChanged` listener, when `changes['fixScriptRequest']?.newValue` is set → `void consumeFixScriptRequest()`. (Confirm the real Script Tester tab id and `loadedScriptRecord`'s exact field names from the file; adjust the two references to match.)

- [ ] **Step 3: "Ask AI to fix"**

```ts
const fixRun = el<HTMLButtonElement>('fix-run')
const fixSpinner = el('fix-spinner')
fixRun.addEventListener('click', async () => {
  const script = testerEd.getValue()
  if (!script.trim()) return
  if (!(await loadLlmConfig())) { showToast('AI not configured — open Settings'); return }
  fixSpinner.hidden = false
  fixRun.disabled = true
  const before = script
  const started = await startLlmJob('fixscript', {
    script,
    problem: el<HTMLTextAreaElement>('fix-problem').value,
    table: fixScriptTarget?.table ?? undefined,
    field: fixScriptTarget?.field,
  })
  if (!started) { fixSpinner.hidden = true; fixRun.disabled = false; return }
  // The job result flows through the existing job plumbing; handle its 'fixscript' outcome
  // in the same place review/generate outcomes are applied (see Step 4).
  ;(fixRun as HTMLButtonElement).dataset.before = before
})
```
Extend `startLlmJob`'s `op` type to include `'fixscript'`.

- [ ] **Step 4: Apply the fix outcome**

Where the panel applies a finished job (the review/generate apply path / storage `onChanged` → apply), add handling for op `'fixscript'`: on `{configured:true, ok:true, result}` → `optimizeEd.setValue(result.fixedScript)`, reveal the optimize section, `showDiff(fixRun.dataset.before ?? '', result.fixedScript)`, show `result.explanation` (in `aiStatus` or a note), and enable the existing save-to-record button (works because `loadedScriptRecord` was set in Step 2). On `!ok` → `showToast(error)`; on `!configured` → hint to Settings. Always clear `fixSpinner`/re-enable `fixRun`. Follow the exact structure the existing `applyReviewJob`/`applyGenerateJob` use so the storage-mirror + direct-reply dual delivery is handled the same way (reuse, don't invent).

- [ ] **Step 5: Verify** — `npm run typecheck` (0, first), `npm run build` (0), `npm test` (green), `npm run test:smoke` (panel boots; `#fix-script-box` hidden, nothing runs without a relayed request).

- [ ] **Step 6: Commit**
```bash
git add src/sidepanel/main.ts src/sidepanel/index.html
git commit -m "$(printf 'feat(fix-script): panel pickup + Ask-AI-to-fix in Script Tester\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:** icon→stash (Task 2), panel pickup + requirement + Ask-AI (Task 3), redacted+allowlisted AI fix + diff + save-to-record (Task 1 + Task 3), unit-tested prompt/coerce (Task 1), off-page no-op + smoke boots (Task 2/3 verify). ✓ all ACs.

**Placeholder scan:** Task 3 says "confirm the real Script Tester tab id / `loadedScriptRecord` field names" — that's a concrete read-the-file instruction (the ids exist in index.html / the type in main.ts), not an open placeholder. The apply-path (Step 4) points at the existing `applyReviewJob`/`applyGenerateJob` structure to mirror.

**Type/name consistency:** `FixScriptInput`/`FixScriptResult`/`FixScriptOutcome`, `buildFixScriptPrompt`/`runFixScript`, op `'fixscript'`, `fixScriptRequest` storage key, `fixScriptTarget`, element ids (`fix-script-box`/`fix-problem`/`fix-run`/`fix-spinner`) consistent across tasks.
