# Phase 0 — Inventory (read-only)

- Date: 2026-07-25
- HEAD: `ab94407` (Header: real-colour MFEC logo on a light header; retitle to 'Java, the SN helper.')
- Working tree: clean at pipeline start.

## Repo shape

Chrome Extension MV3 (snJava — ServiceNow assistant). TypeScript + Vite + @crxjs, Vitest. No CI config in repo. No lint config (no eslint/biome) — `tsc --noEmit` is the only static gate.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | vitest run (unit tests, Node) |
| `npm run typecheck` | tsc --noEmit |
| `npm run build` | typecheck + main crx build + sandbox IIFE build → dist/ |
| `npx vitest run <file>` | single test file |

## Test baseline (evidence: `.pipeline/evidence/baseline-test.txt`)

- **14 files / 110 tests / 110 passed / 0 failed / 0 skipped**, exit 0.
- Coverage tool not configured.
- Production build: **exit 0** (warning: sidepanel chunk >500 kB after minification — pre-existing).

## Module map

Entry points (from `src/manifest.config.ts`): background service worker, content scripts (isolated + MAIN world), side panel page, sandbox page.

| Module | Responsibility | Callers | Side effects |
|---|---|---|---|
| `src/background/index.ts` | SW broker: opens side panel; runs LLM jobs so they survive panel close; job state per-tab | chrome runtime events; sidepanel via messages | chrome.storage.session, network (LLM fetch via core/llm) |
| `src/content/index.ts` | Page identity (table/sys_id) + REST executor host (page-origin fetch) | background/sidepanel messages | network (SN REST, first-party cookie), DOM read |
| `src/content/mainworld.ts` | MAIN-world bridge: g_form / g_ck snapshot | content/index.ts via postMessage | DOM/page globals read |
| `src/core/context.ts` ✅tests | Parse URL/g_form → PageContext (classic/polaris/workspace) | content | pure |
| `src/core/api.ts` ✅tests | REST URL builders + cell/label helpers | sn-rest, spec-runner, sidepanel | pure |
| `src/core/sn-rest.ts` ⚠️no tests | REST executor (runs in content script); write ops hard-gated by prod guard **before network I/O** | content/index.ts | network; guarded writes (create/delete) |
| `src/core/api-client.ts` ⚠️no tests | Typed messaging client for extension pages; re-injects orphaned content scripts | sidepanel, spec-runner | chrome.runtime/scripting/tabs |
| `src/core/prod-guard.ts` ✅tests | Default-DENY hostname classifier for writes | sn-rest, sidepanel | pure |
| `src/core/lint.ts` ✅tests | Layer 1 anti-pattern lint engine (comment/string-aware) | sidepanel | pure |
| `src/core/script-meta.ts` ✅tests | Script record kind/timing detection | sidepanel | pure |
| `src/core/trace.ts` | Layer 2 trace event model | engine, sidepanel | pure (types) |
| `src/core/diff.ts` ✅tests | Line-level LCS diff | sidepanel | pure |
| `src/core/sandbox-host.ts` ⚠️no tests | Drives sandbox iframe: postMessage job + timeout + frame reset | sidepanel | DOM (iframe), timers |
| `src/sandbox/engine.ts` ✅tests | Runs user script via `new Function` against Glide mocks → trace. **Invariant: zero instance writes** | sandbox/main.ts | executes user JS (inside sandboxed iframe) |
| `src/sandbox/glide-mocks.ts` | current/previous/gs/GlideRecord/g_form mocks; writes captured as `write-blocked` | engine | pure (in-memory) |
| `src/sandbox/main.ts` | Sandbox page entry: postMessage protocol | host iframe | postMessage |
| `src/core/graph.ts` ✅tests | Bounded BFS (depth 2) artifact walker, injected fetch | spec-runner | pure |
| `src/core/resolvers.ts` ✅tests | Per-artifact-type FetchSpecs (BR, Catalog Item, Script Include, Table→ACL, Transform Map) | spec-runner | pure |
| `src/core/spec-runner.ts` ⚠️no tests | Glue: graph walker ↔ live REST via api-client | sidepanel | network (via messaging) |
| `src/core/spec.ts` ✅tests | Compose SpecDocument (Overview→Data Model→Logic→Integration→Security) | sidepanel | pure |
| `src/core/render-html.ts` ✅tests | Self-contained HTML renderer (MFEC light theme, escaped) | sidepanel | pure |
| `src/core/render-docx.ts` ✅tests | Word .docx renderer (docx lib) | sidepanel | pure |
| `src/core/format.ts` | Small formatting helpers | renderers/sidepanel | pure |
| `src/core/llm.ts` ✅tests | Configurable LLM provider (anthropic/openai/agenthub): Java review + Generate plan prompts, response parsing | background | network when configured |
| `src/core/xml.ts` ✅tests | F3: parse SN unload XML → field map; SYSTEM_FIELDS strip | sidepanel | pure |
| `src/sidepanel/main.ts` ⚠️no tests, 2556 lines | Entire UI: tabs (Spec / Script Tester / XML), state, DOM, feature orchestration | — (entry) | DOM, chrome messaging, downloads |
| `src/sidepanel/editor.ts` | CodeMirror setup | sidepanel | DOM |

## Critical paths lacking tests (Phase 0 rule → `test` tasks before change)

1. `src/core/sn-rest.ts` — the write gate (prod guard enforcement point). Fetch is injectable enough to characterize in Node.
2. `src/core/api-client.ts` / messaging envelope — chrome-bound; characterize pure parts only if a change is planned there.
3. `src/sidepanel/main.ts` — UI glue; characterization impractical (DOM+chrome). Changes here rely on typecheck + build + manual smoke; keep refactors out of it unless scoped tightly.
