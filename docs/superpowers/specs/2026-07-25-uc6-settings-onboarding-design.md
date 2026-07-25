# UC-6 — Settings / onboarding completion (Design)

- Date: 2026-07-25
- Status: Approved (design)
- Feature area: Settings tab

## Problem / Use Case

**Actor:** a user/admin setting up snJava for their org.
**Pain:** the Settings tab only holds LLM endpoint/key/model/format. There's no way to (a) verify the LLM config works, (b) configure the prod-guard sub-prod patterns (write-gate) from the UI — today it's raw `chrome.storage.local` only, or (c) see what redaction actually removes before trusting the AI features.
**Goal:** complete the Settings tab with a connection test, a prod-guard patterns editor, a redaction preview, and a first-run hint.

## Locked decisions

- **Test connection** runs via a background op `'test'` (consistent with the other LLM jobs; avoids CORS/host-permission gaps for anthropic/openai hosts).
- **Prod-guard editor** edits the **sub-prod patterns only** (the configurable allow knob); production markers stay hard-coded in `prod-guard.ts` (safe by default).
- Reuse the existing pure `redactScript` for the preview and the existing `callProvider` allowlist gate for the test.

## Components

- **`src/core/llm.ts`:** `testLlmConnection(config: LlmConfig): Promise<{ ok: boolean; error?: string; ms?: number }>` — sends a trivial prompt via `callProvider` (allowlist enforced), measures elapsed ms, returns ok/error. (Not unit-tested — network; exercised via typecheck + manual.)
- **`src/core/prod-guard.ts`:** `parseSubProdPatterns(text: string): string[]` — pure: split on comma/newline, trim, drop empties, drop entries that aren't valid regex (via `new RegExp` try/catch). Unit-tested.
- **`src/background/index.ts`:** op `'test'` → `testLlmConnection(payload as LlmConfig)`.
- **`src/sidepanel/main.ts` + `index.html` + `styles.css`:**
  1. **Test connection** button + result line in the AI Settings card (dispatch op `'test'` with the current form values; show ✓ `<ms>` or ✗ `<error>`).
  2. **Prod-guard patterns editor:** a comma/newline field showing the current sub-prod patterns (from `chrome.storage.local['prodGuardConfig']`, else the `DEFAULT_PROD_GUARD_CONFIG.subProdPatterns`) + a Save that writes `{subProdPatterns: parseSubProdPatterns(text)}` to `chrome.storage.local['prodGuardConfig']` (the key `content/index.ts` reads) + a note that production markers always hard-block regardless.
  3. **Redaction preview:** a small textarea; on input, show `redactScript(value)` live in a read-only `<pre>` so the user sees exactly what leaves the instance.
  4. **First-run hint:** when no LLM is configured, a short note in the card stating AI features stay hidden until an endpoint + key are saved.

## Data / storage

- LLM config: unchanged (`saveLlmConfig`/`loadLlmConfig`).
- Prod-guard: `chrome.storage.local['prodGuardConfig'] = { subProdPatterns: string[] }`. `content/index.ts loadGuardConfig` already consumes `override.subProdPatterns` when non-empty, else falls back to defaults — so an empty/invalid save safely falls back to defaults (no lockout).

## Error handling / edge cases

- Test with an unconfigured/blank endpoint → show a "fill endpoint + key first" message (don't dispatch).
- Test against a non-allowlisted endpoint → `callProvider` throws → shown as ✗ with the allowlist error.
- `parseSubProdPatterns` drops invalid regex entries (so a bad pattern can't crash `classifyInstance`); if the result is empty, saving it means `loadGuardConfig` falls back to `DEFAULT_PROD_GUARD_CONFIG` (documented, safe).
- Redaction preview is display-only; nothing is sent.

## Testing

- **Unit (Vitest):** `parseSubProdPatterns` (comma + newline split, trims, drops empties, drops invalid regex like `[unclosed`, preserves valid like `sub-?prod`).
- **Not unit-testable:** `testLlmConnection` (network), the Settings UI wiring (chrome/DOM) — verified via `npm run typecheck` + `npm run build` + `npm run test:smoke` (Settings tab still boots).

## Acceptance criteria

1. A **Test connection** button in Settings reports ✓ + latency on success or ✗ + a clear error (incl. the allowlist error for a bad endpoint); it doesn't dispatch when endpoint/key are blank.
2. A **prod-guard sub-prod patterns** editor loads the current patterns and saves them to `chrome.storage.local['prodGuardConfig']`; invalid regex entries are dropped; a note explains production markers always hard-block.
3. A **redaction preview** shows the live `redactScript` output of whatever the user types; nothing is sent.
4. When the LLM is unconfigured, a first-run hint appears; it disappears once configured.
5. `parseSubProdPatterns` is unit-tested; CI smoke still boots the Settings tab.
6. The prod-guard write-gate itself (`classifyInstance`, production markers) is unchanged; only the sub-prod pattern source is now UI-editable.
