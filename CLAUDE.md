# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

snJava — a Chrome Extension (Manifest V3) that assists ServiceNow development: **F1 Design Spec Generator** (record → HTML/PDF/Word spec in the MFEC light theme), **F2 Script Tester** (3 layers: static lint → sandbox simulation → guarded real execution), **F3 XML Mover** (copy/paste record unload XML across instances).

`handoff.md` is the design document. Its §2/§7 decisions are already agreed — **do not re-litigate them without reason**. README.md tracks milestone status (M0–M5 done) and lists what still needs a real-browser smoke test.

## Commands

```bash
npm run dev          # Vite dev server (HMR), port 5199
npm run build        # tsc --noEmit + main build + sandbox build → dist/
npm run typecheck    # tsc --noEmit
npm test             # vitest run (all unit tests)
npx vitest run src/core/lint.test.ts   # single test file
```

Manual testing: load `dist/` via `chrome://extensions` → Load unpacked, then open a ServiceNow page (dev instance: `mfecplcdemo10.service-now.com`) and click the toolbar icon to open the side panel. Live I/O (auth, sandbox iframe round-trip, Layer 3 writes) can only be verified this way — unit tests cover the pure logic only.

## Build is two-pass

`npm run build` runs **two Vite builds**: the main `@crxjs` build, then `vite.sandbox.config.ts`, which bundles `src/sandbox/main.ts` as a **classic self-contained IIFE** into `dist/public/sandbox/sandbox.js`. This is required because MV3 sandboxed pages run on an opaque origin where ES module scripts fail to load. If you touch sandbox code, remember the second build (or just use `npm run build`).

## Architecture

Path alias: `@core` → `src/core`.

### Execution contexts and message flow

- **Content script** (`src/content/index.ts`, isolated world) + **MAIN-world bridge** (`src/content/mainworld.ts`) — reads page identity (table + sys_id) from URL / `g_form` and captures the `g_ck` X-UserToken.
- **ServiceNow REST calls execute in the content script** (`src/core/sn-rest.ts`), *not* the service worker — the session cookie is SameSite=Lax and is only sent on first-party (page-origin) requests; a background fetch gets 401. Extension pages call the API through `src/core/api-client.ts` (typed chrome.runtime messaging), which also re-injects orphaned content scripts after extension reload ("Receiving end does not exist" self-heal).
- **Service worker** (`src/background/index.ts`) is a thin broker: opens the side panel and runs LLM jobs (review/generate) so an in-flight request survives the panel closing; job state is stored per-tab in `chrome.storage.session`.
- **Side panel** (`src/sidepanel/main.ts`, single large file ~2.5k lines) is the entire UI.
- **Sandbox iframe** (`src/sandbox/`) runs user scripts for Layer 2 via `new Function` against Glide mocks; the host driver (`src/core/sandbox-host.ts`) posts jobs and enforces a timeout.

### Core design rules (from handoff.md)

- **DOM is only for identity; API is for data.** The content script determines *which* record; everything else comes from the Table/Aggregate REST API.
- **Zero instance writes from the sandbox.** Glide mocks capture insert/update/deleteRecord as `write-blocked` trace events — never executed.
- **Prod guard is a hard block, default-DENY** (`src/core/prod-guard.ts`): writes are allowed only on confirmed sub-prod hostnames, refused in the REST layer *before any network I/O*, and explicit prod markers win over sub-prod markers.
- **Graph walking is bounded** (depth 2, `src/core/graph.ts`) and the user confirms an artifact checklist before spec generation.
- **LLM endpoint is configurable** (`src/core/llm.ts` — anthropic/openai/agenthub formats); until configured, features report `configured:false` rather than failing.

### Where things live

`src/core/` holds pure, unit-tested modules (Vitest runs them in Node — no `chrome.*` in core except `api-client.ts`, which is the messaging boundary). Feature pipelines:

- **F1 spec**: `graph.ts` (bounded BFS) → `resolvers.ts` (per-artifact-type related-record specs) → `spec-runner.ts` (glue to live REST) → `spec.ts` (compose SpecDocument) → `render-html.ts` / `render-docx.ts`.
- **F2 tester**: `lint.ts` (Layer 1 anti-pattern engine, comment/string-aware) → `src/sandbox/engine.ts` + `glide-mocks.ts` (Layer 2, returns a typed trace, `trace.ts`) → guarded create/delete via `sn-rest.ts` (Layer 3).
- **F3 XML**: `xml.ts` (regex-based unload-XML parser; strips `SYSTEM_FIELDS` before re-insert).

## Convention

New pure logic goes in `src/core/` with a colocated `*.test.ts`; keep chrome-API access out of it so tests stay Node-runnable. Files start with a block comment explaining the module's role (often citing a handoff § decision) — follow that pattern.
