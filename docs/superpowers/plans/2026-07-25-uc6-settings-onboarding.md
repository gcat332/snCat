# UC-6 Settings / Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Complete the Settings tab: connection test, prod-guard sub-prod patterns editor, redaction preview, and a first-run hint.

**Architecture:** A pure `parseSubProdPatterns` in `prod-guard.ts` + `testLlmConnection` in `llm.ts` (reuses `callProvider`); a `'test'` background op; and three Settings-card UI additions in `main.ts`/`index.html`.

**Tech Stack:** TypeScript, Vitest, existing LLM + storage infra.

## Global Constraints

- Pure logic in `src/core/*` with colocated tests; no chrome/DOM in core.
- Reuse `callProvider` (allowlist enforced) for the test and `redactScript` for the preview.
- Prod-guard editor writes ONLY `chrome.storage.local['prodGuardConfig'] = { subProdPatterns }` (the key `content/index.ts loadGuardConfig` reads); production markers in `prod-guard.ts` stay hard-coded.
- Do not change `classifyInstance`/prod-marker logic or review/generate behavior.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Reference (read first)

- `src/core/prod-guard.ts`: `DEFAULT_PROD_GUARD_CONFIG.subProdPatterns`, `ProdGuardConfig`.
- `src/core/llm.ts`: `LlmConfig`, `callProvider` (internal, allowlist-gated), `redactScript`.
- `src/content/index.ts`: `loadGuardConfig` reads `store['prodGuardConfig'].subProdPatterns`, else defaults.
- `src/background/index.ts`: `LlmRunMessage` (~12), the `onMessage` handler replies with the job entry via `sendResponse` (~53), `runLlmJob` switch (~51), the `tabs.onRemoved` cleanup (removes `llmJob:<tab>:review`+`:generate`).
- `src/sidepanel/main.ts`: AI settings inputs `aiEndpoint`/`aiKey`/`aiModel`/`aiFormat` (~1331), `saveAiSettings`/`loadAiSettings` (~2505), `currentTabId`, `updateSpecAiButton` (config-gated show/hide), `showToast`.
- `src/sidepanel/index.html`: `#settings-card` (~316), `#ai-save`/`#ai-saved` (~339).

---

### Task 1: Pure helpers — `parseSubProdPatterns` + `testLlmConnection`

**Files:** Modify `src/core/prod-guard.ts`, `src/core/prod-guard.test.ts`, `src/core/llm.ts`.

**Interfaces produced:**
- `parseSubProdPatterns(text: string): string[]`
- `testLlmConnection(config: LlmConfig): Promise<{ ok: boolean; error?: string; ms?: number }>`

- [ ] **Step 1: Failing test** (append to `src/core/prod-guard.test.ts`):

```ts
import { parseSubProdPatterns } from './prod-guard'

describe('parseSubProdPatterns', () => {
  it('splits on comma/newline, trims, drops empties and invalid regex', () => {
    expect(parseSubProdPatterns('dev, test\nuat ,, sub-?prod')).toEqual(['dev', 'test', 'uat', 'sub-?prod'])
    expect(parseSubProdPatterns('good, [unclosed, qa')).toEqual(['good', 'qa'])
    expect(parseSubProdPatterns('   ')).toEqual([])
  })
})
```

- [ ] **Step 2: Run — verify fail:** `npx vitest run src/core/prod-guard.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement**

Add to `src/core/prod-guard.ts`:
```ts
/** Parse a comma/newline-separated sub-prod pattern list into valid regex sources. */
export function parseSubProdPatterns(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => {
      try {
        new RegExp(p, 'i')
        return true
      } catch {
        return false
      }
    })
}
```

Add to `src/core/llm.ts` (near the other runners; `callProvider` is already in this file):
```ts
/** Quick connectivity/auth check against the configured provider. */
export async function testLlmConnection(
  config: LlmConfig,
): Promise<{ ok: boolean; error?: string; ms?: number }> {
  const t0 = Date.now()
  try {
    await callProvider(config, 'You are a connection test.', 'Reply with the single word: OK')
    return { ok: true, ms: Date.now() - t0 }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/core/prod-guard.test.ts` PASS; `npm test` green; `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**
```bash
git add src/core/prod-guard.ts src/core/prod-guard.test.ts src/core/llm.ts
git commit -m "$(printf 'feat(settings): parseSubProdPatterns + testLlmConnection helpers\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Background `'test'` op + Test-connection button

**Files:** Modify `src/background/index.ts`, `src/sidepanel/main.ts`, `src/sidepanel/index.html`.

- [ ] **Step 1: Background op**

In `src/background/index.ts`: import `testLlmConnection` + `type LlmConfig` from `@core/llm`. Add `'test'` to `LlmRunMessage.op`. In `runLlmJob`, branch: when `msg.op === 'test'`, `outcome = await testLlmConnection(msg.payload as unknown as LlmConfig)`. Keep review/generate/narrative unchanged. Add `jobKey(tabId, 'test')` to the `tabs.onRemoved` cleanup list (so the transient test entry is also purged).

- [ ] **Step 2: HTML — button + result**

In `src/sidepanel/index.html`, in the `#settings-card` btn-row with `#ai-save`, add after `#ai-saved`:
```html
            <button class="btn btn-ghost" id="ai-test" type="button">Test connection</button>
            <span class="ai-note" id="ai-test-result"></span>
```

- [ ] **Step 3: main.ts — wire the test**

Add near the AI settings handlers:
```ts
const aiTestBtn = el<HTMLButtonElement>('ai-test')
const aiTestResult = el('ai-test-result')

/** Build an LlmConfig from the current Settings form (unsaved values). */
function currentFormConfig(): LlmConfig {
  return {
    endpoint: aiEndpoint.value.trim(),
    apiKey: aiKey.value.trim(),
    model: aiModel.value.trim() || 'claude-opus-4-8',
    format: aiFormat.value as LlmFormat,
  }
}

aiTestBtn.addEventListener('click', async () => {
  const cfg = currentFormConfig()
  if (!cfg.endpoint || !cfg.apiKey) {
    aiTestResult.textContent = 'Fill endpoint + key first.'
    return
  }
  aiTestResult.textContent = 'Testing…'
  aiTestBtn.disabled = true
  try {
    const entry = (await chrome.runtime.sendMessage({
      kind: 'snjava:llm-run',
      tabId: currentTabId ?? -1,
      op: 'test',
      payload: cfg,
    })) as { outcome?: { ok: boolean; ms?: number; error?: string }; error?: string } | undefined
    const o = entry?.outcome
    aiTestResult.textContent = o?.ok
      ? `✓ Connected (${o.ms} ms)`
      : `✗ ${o?.error ?? entry?.error ?? 'failed'}`
  } catch (e) {
    aiTestResult.textContent = `✗ ${(e as Error).message}`
  } finally {
    aiTestBtn.disabled = false
  }
})
```
(If `LlmFormat` isn't already imported in main.ts, add it to the `@core/llm` import.)

- [ ] **Step 4: Verify** — `npm run typecheck` (exit 0, run first), `npm run build` (0), `npm test` (green), `npm run test:smoke` (Settings tab boots; the button is inert with no config).

- [ ] **Step 5: Commit**
```bash
git add src/background/index.ts src/sidepanel/main.ts src/sidepanel/index.html
git commit -m "$(printf 'feat(settings): Test-connection button (background test op)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Prod-guard editor + redaction preview + first-run hint

**Files:** Modify `src/sidepanel/index.html`, `src/sidepanel/main.ts`, `src/sidepanel/styles.css` (only if a new style is needed).

- [ ] **Step 1: HTML**

In `#settings-card`, after the AI settings btn-row, add:
```html
          <p class="ai-note" id="ai-firstrun-hint" hidden>Add an endpoint + key above to enable the AI features (Java review, Generate, AI spec overview). They stay hidden until configured.</p>

          <h2 class="card-title" style="margin-top:18px">Prod guard — sub-prod patterns</h2>
          <p class="hint">Instances whose first label matches one of these (regex, case-insensitive) allow guarded writes. Production markers always hard-block regardless. One per line or comma-separated.</p>
          <textarea id="guard-patterns" class="query-input" rows="3" placeholder="dev, test, uat, sandbox, staging, qa, demo, sub-?prod, training"></textarea>
          <div class="btn-row">
            <button class="btn" id="guard-save" type="button">Save patterns</button>
            <span class="count-badge" id="guard-saved" hidden>Saved ✓</span>
          </div>

          <h2 class="card-title" style="margin-top:18px">Redaction preview</h2>
          <p class="hint">See exactly what leaves the instance when AI features send a script. Display-only — nothing is sent.</p>
          <textarea id="redact-input" class="query-input" rows="4" placeholder="var pw = 'hunter2'; gs.info(new GlideRecord('incident'));"></textarea>
          <pre class="code-block" id="redact-output" style="white-space:pre-wrap"></pre>
```

- [ ] **Step 2: main.ts — imports + guard editor**

Add imports: `import { DEFAULT_PROD_GUARD_CONFIG, parseSubProdPatterns } from '@core/prod-guard'` and ensure `redactScript` is imported from `@core/llm`.

Add:
```ts
const guardPatterns = el<HTMLTextAreaElement>('guard-patterns')
const guardSaved = el('guard-saved')

async function loadGuardPatterns() {
  let patterns = DEFAULT_PROD_GUARD_CONFIG.subProdPatterns
  try {
    const store = await chrome.storage.local.get('prodGuardConfig')
    const override = store['prodGuardConfig'] as { subProdPatterns?: string[] } | undefined
    if (override?.subProdPatterns?.length) patterns = override.subProdPatterns
  } catch {
    /* defaults */
  }
  guardPatterns.value = patterns.join(', ')
}

el<HTMLButtonElement>('guard-save').addEventListener('click', async () => {
  const subProdPatterns = parseSubProdPatterns(guardPatterns.value)
  await chrome.storage.local.set({ prodGuardConfig: { subProdPatterns } })
  guardPatterns.value = subProdPatterns.join(', ')
  guardSaved.hidden = false
  setTimeout(() => (guardSaved.hidden = true), 1500)
})
```

- [ ] **Step 3: main.ts — redaction preview**

```ts
const redactInput = el<HTMLTextAreaElement>('redact-input')
const redactOutput = el('redact-output')
redactInput.addEventListener('input', () => {
  redactOutput.textContent = redactInput.value ? redactScript(redactInput.value) : ''
})
```

- [ ] **Step 4: main.ts — first-run hint**

Add:
```ts
async function updateFirstRunHint() {
  const configured = !!(await loadLlmConfig())
  el('ai-firstrun-hint').hidden = configured
}
```
Call `void updateFirstRunHint()` from `loadAiSettings()` and at the end of `saveAiSettings()` (next to the existing `void updateSpecAiButton()`). Also call `void loadGuardPatterns()` from wherever `loadAiSettings()` is invoked at startup (so the guard editor is populated on load).

- [ ] **Step 5: Verify** — `npm run typecheck` (0, first), `npm run build` (0), `npm test` (green), `npm run test:smoke` (Settings tab boots; redaction preview + guard editor present, inert without interaction).

- [ ] **Step 6: Commit**
```bash
git add src/sidepanel/index.html src/sidepanel/main.ts src/sidepanel/styles.css
git commit -m "$(printf 'feat(settings): prod-guard patterns editor, redaction preview, first-run hint\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- Test connection ✓/✗+latency, no dispatch when blank (AC #1) → Task 1 (`testLlmConnection`) + Task 2 (op + button + blank guard). ✓
- Guard patterns editor → storage.local, drops invalid, note about prod markers (AC #2) → Task 1 (`parseSubProdPatterns`) + Task 3 Step 1-2. ✓
- Redaction preview, nothing sent (AC #3) → Task 3 Step 3. ✓
- First-run hint appears/disappears with config (AC #4) → Task 3 Step 4. ✓
- `parseSubProdPatterns` unit-tested; smoke boots (AC #5) → Task 1 tests + Task 2/3 Step verify. ✓
- Guard write-gate logic unchanged; only pattern source UI-editable (AC #6) → no change to `classifyInstance`; editor only writes `prodGuardConfig`. ✓

**Placeholder scan:** none. `styles.css` "only if needed" is conditional, not a placeholder (the new markup reuses existing classes `query-input`/`btn`/`code-block`/`ai-note`/`count-badge`).

**Type/name consistency:** `parseSubProdPatterns`, `testLlmConnection`, op `'test'`, `prodGuardConfig` key, `currentFormConfig`, element ids (`ai-test`/`guard-patterns`/`redact-input`/`ai-firstrun-hint`) used consistently across tasks. `LlmConfig`/`LlmFormat` imported where used.
