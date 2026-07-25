# UC-5 — AI narrative for F1 Design Spec (opt-in, consent-gated) — Design

- Date: 2026-07-25
- Status: Approved (design)
- Feature area: F1 Design Spec Generator + LLM layer

## Problem / Use Case

**Actor:** a consultant generating a Design Spec who wants readable prose, not just a field/artifact dump.
**Pain:** F1 is template-driven (LLM-free); the spec is structurally complete but has no narrative Overview/Logic summary.
**Goal:** let the user optionally add an AI-authored **Overview (AI-generated)** narrative to the spec, gated behind explicit per-send consent (customer content leaves the instance), reusing the existing redaction + endpoint-allowlist safeguards.

## Locked decisions

- **Scope:** F1 spec narrative only. F2 logic-vs-intent review already exists (`runJavaReview`) — out of scope. No per-field AI.
- **Consent model:** per-send confirm dialog with a **"don't ask again this session"** option (session-scoped flag).
- **Placement:** a single labeled **"Overview (AI-generated)"** block at the top of the spec (after the cover, before the template sections).
- **Governance:** every send is consent-gated, script content is **redacted** (`redactScript`), and the endpoint is **allowlisted** (`callProvider`'s existing gate). When the LLM is unconfigured, the feature is absent.
- Runs in the background worker (like the other LLM jobs) so it survives panel close.

## Components

- **`src/core/llm.ts`** (new, pure prompt + runner reusing existing infra):
  - `interface NarrativeInput { table: string; rootLabel: string; artifacts: { name: string; type: string; script?: string }[] }`
  - `buildSpecNarrativePrompt(input: NarrativeInput): { system: string; user: string }` — redacts every `script` via `redactScript`, lists artifacts, asks for a concise plain-prose Overview + Logic summary (no markdown, no JSON).
  - `type NarrativeOutcome = { configured: false } | { configured: true; ok: true; text: string } | { configured: true; ok: false; error: string }`
  - `runSpecNarrative(input: NarrativeInput, config?): Promise<NarrativeOutcome>` — loads config (absent → `{configured:false}`), calls `callProvider` (allowlist enforced there), returns the trimmed prose text (no JSON parse).
- **`src/core/spec.ts`:** add optional `aiOverview?: string` to `SpecDocument` and `ComposeInput`; `composeSpec` passes it through unchanged.
- **`src/core/render-html.ts`:** when `doc.aiOverview` is present, render a labeled `Overview (AI-generated)` block (escaped, with an "AI-generated" tag) right after the cover, before the sections. Omit entirely when absent.
- **`src/core/render-docx.ts`:** same labeled block in the DOCX, after the subtitle, before the sections.
- **`src/background/index.ts`:** add op `'narrative'` → `runSpecNarrative`.
- **`src/sidepanel/main.ts`:** module var `specAiOverview: string | null`; `buildSpecDoc()` sets `aiOverview: specAiOverview ?? undefined`. A **"✨ Add AI narrative"** button in the Spec tab, shown only when the LLM is configured and artifacts are discovered. Click → consent dialog (names table + artifact count + the endpoint host + "content is redacted"; buttons Send / Cancel / Don't ask again this session) → `startLlmJob('narrative', payload)` → on `done`, set `specAiOverview` and refresh the preview + a toast. `startLlmJob`'s `op` union extends to include `'narrative'`.

## Consent dialog copy (example)

`Send this spec's structure and (redacted) scripts for "<table>" — <N> artifact(s) — to the configured AI endpoint (<endpoint-host>)? Secrets are redacted before sending. This is the only data that leaves the instance.` — Send / Cancel / Don't ask again this session.

## Error handling / edge cases

- LLM unconfigured → button hidden; `runSpecNarrative` returns `{configured:false}` (defensive).
- LLM error/refusal → toast the error; `specAiOverview` stays null; spec exports template-only (graceful).
- Endpoint not allowlisted → `callProvider` throws → surfaced as the job error (no send).
- "Don't ask again this session" sets an in-memory flag; cleared on panel reload.

## Testing

- **Unit (Vitest):** `buildSpecNarrativePrompt` (redacts scripts — no raw secret in output; lists artifact names; asks for prose); `composeSpec` passes `aiOverview` through; `render-html` includes the labeled "AI-generated" block when `aiOverview` set and omits it when absent (assert on the built HTML string); `render-docx` `buildDocxDocument` includes an AI-overview paragraph when set (object-graph assert), omits when absent.
- **Not unit-testable:** the live LLM call, the consent dialog, and the background-job round-trip (chrome/network) — verified by `npm run typecheck` + `npm run build` + `npm run test:smoke`.

## Acceptance criteria

1. When the LLM is configured and a spec's artifacts are discovered, an "Add AI narrative" action is available; when unconfigured it is absent.
2. Using it shows a consent dialog naming the table, artifact count, and endpoint host, and stating content is redacted; Cancel sends nothing.
3. On consent, the narrative is generated in the background (survives panel close) with scripts redacted; on success a labeled "Overview (AI-generated)" block appears at the top of all three export formats (HTML/PDF/DOCX).
4. LLM error/refusal or unconfigured → spec still exports template-only; no crash.
5. "Don't ask again this session" suppresses the dialog for the rest of the session only.
6. `buildSpecNarrativePrompt` redaction, `composeSpec` passthrough, and both renderers' AI-block are unit-tested; CI smoke still boots.
