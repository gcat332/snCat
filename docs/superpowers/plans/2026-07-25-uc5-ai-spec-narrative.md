# UC-5 AI Spec Narrative — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the user optionally add an AI-authored, consent-gated, redacted "Overview (AI-generated)" narrative to the F1 Design Spec.

**Architecture:** New pure `buildSpecNarrativePrompt` + `runSpecNarrative` in `llm.ts` (reusing `redactScript` + `callProvider`'s allowlist gate); an optional `aiOverview` field threaded through `SpecDocument`/`composeSpec` and rendered by both renderers; a `'narrative'` background op; and Spec-tab wiring in `main.ts` (button + consent + job).

**Tech Stack:** TypeScript, Vitest, existing LLM infra.

## Global Constraints

- Pure logic in `src/core/*` with colocated tests; no chrome/DOM in core.
- Reuse `redactScript` for any script content sent; the endpoint allowlist is enforced inside `callProvider` (do not bypass it).
- Feature absent when LLM unconfigured (`{configured:false}`).
- Narrative runs in the background worker (op `'narrative'`), like `review`/`generate`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Do not change existing review/generate behavior.

## Reference (read first)

- `src/core/llm.ts`: `LlmConfig`, `redactScript` (~86), `isAllowedEndpoint` (~116), `callProvider` (~425, enforces allowlist), `loadLlmConfig` (used by `runGeneratePlan`), `PlanOutcome` shape (~380, the discriminated-union pattern to mirror).
- `src/core/spec.ts`: `SpecDocument` (~23: title/subtitle/meta/sections), `ComposeInput` (~30), `composeSpec`.
- `src/core/render-html.ts`: `renderSpecHtml(doc, opts)` (~138), cover at ~203, `esc()`.
- `src/core/render-docx.ts`: `buildDocxDocument(doc, logo)` (~98), subtitle push ~116, sections loop ~128.
- `src/background/index.ts`: `LlmRunMessage.op: 'review' | 'generate'` (~15), `runLlmJob` switch (~51).
- `src/sidepanel/main.ts`: `startLlmJob(op, payload)` (~87), `buildSpecDoc()` (~2281), export fns (~2318+), spec-tab state (`specRoot`, `specArtifacts`, `specExcluded`, `specPrimaryTable`, `specSchema`).

---

### Task 1: `llm.ts` — narrative prompt + runner

**Files:** Modify `src/core/llm.ts`; Modify `src/core/llm.test.ts`.

**Interfaces produced:**
- `interface NarrativeInput { table: string; rootLabel: string; artifacts: { name: string; type: string; script?: string }[] }`
- `buildSpecNarrativePrompt(input: NarrativeInput): { system: string; user: string }`
- `type NarrativeOutcome = { configured: false } | { configured: true; ok: true; text: string } | { configured: true; ok: false; error: string }`
- `runSpecNarrative(input: NarrativeInput, config?: LlmConfig | null): Promise<NarrativeOutcome>`

- [ ] **Step 1: Write the failing test** (append to `src/core/llm.test.ts`):

```ts
import { buildSpecNarrativePrompt } from './llm'

describe('buildSpecNarrativePrompt', () => {
  it('lists artifacts, redacts scripts, and asks for plain prose', () => {
    const p = buildSpecNarrativePrompt({
      table: 'incident',
      rootLabel: 'Incident',
      artifacts: [{ name: 'Notify BR', type: 'Business Rule', script: 'var pw = "hunter2"; gs.info(pw);' }],
    })
    expect(p.user).toContain('incident')
    expect(p.user).toContain('Notify BR')
    expect(p.user).not.toContain('hunter2')
    expect(p.user).toContain('REDACTED')
    expect(p.system.toLowerCase()).toContain('prose')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/llm.test.ts`
Expected: FAIL — `buildSpecNarrativePrompt` is not exported.

- [ ] **Step 3: Implement** (add to `src/core/llm.ts`, near the other prompt builders/runners; reuse the existing `redactScript`, `callProvider`, `loadLlmConfig`):

```ts
export interface NarrativeInput {
  table: string
  rootLabel: string
  artifacts: { name: string; type: string; script?: string }[]
}

/** Prompt for a concise, plain-prose Design Spec overview. Scripts are redacted. */
export function buildSpecNarrativePrompt(input: NarrativeInput): { system: string; user: string } {
  const system =
    'You are a ServiceNow solution architect writing the overview of a Design Spec. ' +
    'Reply with 2-3 short paragraphs of plain prose only — no markdown, no headings, no code, no JSON. ' +
    'Summarize what this table/module does and the high-level logic of its customizations for a technical reader.'
  const lines = input.artifacts.map((a) => {
    const s = a.script ? `\n    script (secrets redacted):\n${redactScript(a.script)}` : ''
    return `  - ${a.type}: ${a.name}${s}`
  })
  const user =
    `Table/module: ${input.rootLabel} (${input.table})\n` +
    `Discovered customizations:\n${lines.join('\n')}\n\nWrite the overview.`
  return { system, user }
}

export type NarrativeOutcome =
  | { configured: false }
  | { configured: true; ok: true; text: string }
  | { configured: true; ok: false; error: string }

/** Generate the spec overview via the configured provider (allowlist enforced in callProvider). */
export async function runSpecNarrative(
  input: NarrativeInput,
  config?: LlmConfig | null,
): Promise<NarrativeOutcome> {
  const cfg = config ?? (await loadLlmConfig())
  if (!cfg) return { configured: false }
  const { system, user } = buildSpecNarrativePrompt(input)
  try {
    const text = await callProvider(cfg, system, user)
    return { configured: true, ok: true, text: text.trim() }
  } catch (err) {
    return { configured: true, ok: false, error: (err as Error).message }
  }
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/core/llm.test.ts` PASS, then `npm test` green (161 + new). Also `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/llm.ts src/core/llm.test.ts
git commit -m "$(printf 'feat(llm): spec-narrative prompt + runner (redacted, allowlisted)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: `aiOverview` through spec + both renderers

**Files:** Modify `src/core/spec.ts`, `src/core/spec.test.ts`, `src/core/render-html.ts`, `src/core/render-html.test.ts`, `src/core/render-docx.ts`, `src/core/render-docx.test.ts`.

**Interfaces:** `SpecDocument.aiOverview?: string`, `ComposeInput.aiOverview?: string`.

- [ ] **Step 1: Write failing tests**

Append to `src/core/spec.test.ts`:
```ts
it('passes aiOverview through composeSpec when provided', () => {
  const doc = composeSpec({ instance: 'x', rootTable: 'incident', rootLabel: 'Incident', rootFields: {}, artifacts: [], aiOverview: 'This module handles incidents.' })
  expect(doc.aiOverview).toBe('This module handles incidents.')
})
```
Append to `src/core/render-html.test.ts`:
```ts
it('renders a labeled AI-generated overview block when aiOverview is set, omits when absent', () => {
  const base = { title: 'T', subtitle: 'S', meta: [], sections: [] }
  const withAi = renderSpecHtml({ ...base, aiOverview: 'Prose about the module.' })
  expect(withAi).toContain('AI-generated')
  expect(withAi).toContain('Prose about the module.')
  const without = renderSpecHtml(base)
  expect(without).not.toContain('AI-generated')
})
```
Append to `src/core/render-docx.test.ts` (mirror the existing object-graph inspection helper the file already uses to find text/paragraphs):
```ts
it('includes an AI-generated overview paragraph when aiOverview is set', () => {
  const doc = buildDocxDocument({ title: 'T', subtitle: 'S', meta: [], sections: [], aiOverview: 'Prose about the module.' })
  // Use the file's existing node-collecting helper to assert the text appears.
  // (If a helper like collect()/containsText exists, assert 'Prose about the module.' and 'AI-generated' are present.)
})
```
(For the DOCX test, follow whatever assertion style `render-docx.test.ts` already uses — string-collect over the built Document — to assert both the label "AI-generated" and the prose text appear when set, and do NOT appear for a doc without `aiOverview`.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/core/spec.test.ts src/core/render-html.test.ts src/core/render-docx.test.ts` → FAIL (aiOverview unknown / block missing).

- [ ] **Step 3: Implement**

`src/core/spec.ts`: add `aiOverview?: string` to `SpecDocument` and `ComposeInput`; in `composeSpec`'s returned object add `aiOverview: input.aiOverview`.

`src/core/render-html.ts`: in `renderSpecHtml`, immediately AFTER the cover `<div class="cover">…</div>` and BEFORE the sections/TOC body, insert (only when set):
```ts
const aiBlock = doc.aiOverview
  ? `<section class="ai-overview"><h2>Overview <span class="ai-tag">AI-generated</span></h2>` +
    doc.aiOverview.split(/\n\n+/).map((p) => `<p>${esc(p)}</p>`).join('') +
    `</section>`
  : ''
```
and place `${aiBlock}` into the document body right after the cover. Add minimal CSS for `.ai-overview`/`.ai-tag` consistent with the existing light theme (e.g. the `.ai-tag` a small muted pill). Do not alter existing escaping.

`src/core/render-docx.ts`: in `buildDocxDocument`, right after the subtitle paragraph and before the sections loop, when `doc.aiOverview` is set, push a heading paragraph `Overview (AI-generated)` (use the same HeadingLevel the section headings use) and a body paragraph per `doc.aiOverview.split(/\n\n+/)` chunk.

- [ ] **Step 4: Run tests** — the three test files PASS; full `npm test` green; `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/spec.ts src/core/spec.test.ts src/core/render-html.ts src/core/render-html.test.ts src/core/render-docx.ts src/core/render-docx.test.ts
git commit -m "$(printf 'feat(spec): optional AI-generated Overview block (html + docx)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: background op + Spec-tab wiring (button + consent + job)

**Files:** Modify `src/background/index.ts`, `src/sidepanel/main.ts`, `src/sidepanel/index.html` (add the button), `src/sidepanel/styles.css` (optional small style for the button/toast if needed).

**Interfaces consumed:** Task 1's `runSpecNarrative`/`NarrativeInput`/`NarrativeOutcome`; Task 2's `aiOverview`; existing `startLlmJob`, `buildSpecDoc`, `confirmDialog`, `showToast`, spec-tab state, `loadLlmConfig`/the configured-check the Generate tab uses.

- [ ] **Step 1: Background op**

In `src/background/index.ts`: import `runSpecNarrative` (and `type NarrativeInput`) from `@core/llm`. Extend `LlmRunMessage.op` to `'review' | 'generate' | 'narrative'`. In `runLlmJob`'s branch, add: when `msg.op === 'narrative'`, `outcome = await runSpecNarrative(msg.payload as NarrativeInput)`. Keep review/generate unchanged.

- [ ] **Step 2: main.ts — state + startLlmJob op**

Extend `startLlmJob`'s `op` parameter type to include `'narrative'`. Add a module var `let specAiOverview: string | null = null`. In `buildSpecDoc()`, add `aiOverview: specAiOverview ?? undefined` to the `composeSpec({...})` argument. Reset `specAiOverview = null` wherever the spec is re-discovered / root changes (so a stale narrative doesn't attach to a different spec) — find where `specArtifacts`/`specRoot` are (re)assigned and clear it there.

- [ ] **Step 3: main.ts — button + consent + job**

Add a button `#spec-ai` "✨ Add AI narrative" in the Spec tab near the export buttons (`src/sidepanel/index.html`, by the `spec-docx` button). Wire in `main.ts`:
- Show/enable it only when the LLM is configured (mirror the check the Generate tab uses to gate itself — e.g. read `loadLlmConfig()` or the same stored flag) AND `specArtifacts.length > 0`; hide/disable otherwise. Update this in the same place the spec preview/exports are enabled after discovery.
- On click:
  - If not `narrativeDontAskAgain`: show `confirmDialog(...)` naming the table (`specRoot.table`), artifact count (`specArtifacts` minus excluded), and the configured endpoint host, stating secrets are redacted. Offer proceed. (Implement "Don't ask again this session" as: use a second dialog affordance or a checkbox — simplest: a `promptDialog`-style is overkill; use `confirmDialog` for Send/Cancel and, on proceed, set a session flag only if the user opts in. If a 3-way dialog is impractical with the existing helpers, use: first a `confirmDialog` to Send; skip it for the rest of the session only after a successful send — i.e. auto-suppress subsequent confirms once the user has consented once this session. Document whichever you choose in your report.)
  - Build `NarrativeInput` from spec state: `{ table: specRoot.table, rootLabel: specRoot.label, artifacts: includedArtifacts.map(a => ({ name: a.label, type: a.type, script: a.fields?.script })) }` (use the artifact fields actually available; include `script` when the artifact carries one).
  - `startLlmJob('narrative', input)`; show a spinner/status on the button.
  - On the job `done` outcome: if `outcome.configured && outcome.ok`, set `specAiOverview = outcome.text`, refresh the spec preview (re-render whatever shows the composed doc) and `showToast('AI overview added')`. If `!ok`, `showToast(outcome.error)`. If `!configured`, hide the button.
- Keep the exact `applyJob`/storage-mirror pattern the other jobs use (the narrative job entry flows through the same per-tab storage; reuse the existing plumbing — do not invent a new channel).

- [ ] **Step 4: Verify**

Run: `npm run typecheck` (exit 0), `npm run build` (exit 0), `npm test` (green), `npm run test:smoke` (panel still boots; the new button is inert without a configured LLM). Run typecheck FIRST and fix any type errors before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/background/index.ts src/sidepanel/main.ts src/sidepanel/index.html src/sidepanel/styles.css
git commit -m "$(printf 'feat(spec): consent-gated AI narrative button wired to F1 export\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- AI narrative available only when configured (AC #1) → Task 3 Step 3 gate. ✓
- Consent dialog naming table/count/endpoint + redaction note (AC #2) → Task 3 Step 3. ✓
- Background generation, redacted, labeled block in all 3 exports (AC #3) → Task 1 (redaction), Task 2 (renderers), Task 3 (background op + insert). ✓
- Graceful on error/unconfigured (AC #4) → `NarrativeOutcome` handling in Task 3; renderers omit block when absent. ✓
- "Don't ask again this session" session-scoped (AC #5) → Task 3 Step 3 flag. ✓
- Unit tests for prompt redaction, composeSpec passthrough, both renderers; smoke boots (AC #6) → Tasks 1-2 tests + Task 3 Step 4. ✓

**Placeholder scan:** The DOCX test (Task 2 Step 1) defers to "the file's existing assertion style" — that is a real instruction (the file already has an object-graph collector from the UC-2/earlier work), not an open placeholder; the implementer mirrors it. The consent "don't ask again" mechanism gives an explicit fallback if a 3-way dialog is impractical.

**Type/name consistency:** `NarrativeInput`, `NarrativeOutcome`, `runSpecNarrative`, `buildSpecNarrativePrompt`, `aiOverview`, op `'narrative'`, `specAiOverview` used consistently across tasks.
