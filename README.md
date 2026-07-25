# snJava — ServiceNow Java Assistant (Chrome Extension, MV3)

A Chrome Extension with a shared core engine and two features:

- **F1 — Design Spec Generator**: generate a Design Spec (PDF / Word `.docx` / HTML) from any ServiceNow record, styled in the MFEC light theme.
- **F2 — Script Tester**: 3-layer testing (static AI review → prod-guarded background-script run → guarded real execution) for Business Rules / Client Scripts.

See [`handoff.md`](./handoff.md) for the full design, decisions, and milestones.

## Stack

TypeScript · Vite · [`@crxjs/vite-plugin`](https://crxjs.dev) (MV3) · Vitest

## Develop

```bash
npm install
npm run dev      # Vite dev server with HMR
```

Then load the extension in Chrome:

1. `npm run build` (or use the `dev` server output)
2. Open `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder
4. Open a ServiceNow page (dev instance: `mfecplcdemo10.service-now.com`) → click the snJava toolbar icon → the side panel opens and reports the current **table + sys_id**.

## Scripts

| Command | What |
|---|---|
| `npm run dev` | Vite dev server (HMR) |
| `npm run build` | Typecheck + production build to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run Vitest unit tests |

## Current status — M1 (API core)

**M0 — Skeleton** ✅
- MV3 scaffold, side panel opens on icon click.
- Content script detects **table + sys_id** from the URL on **classic UI**, **Next Experience / Polaris**, and **workspace** routes, with a `g_form` / `g_ck` MAIN-world bridge fallback.
- Context parser unit-tested (`src/core/context.test.ts`).

**M1 — API core** ✅
- ServiceNow REST client in the service worker (`src/background/api.ts`): Table API, Aggregate/stats count, single record, `sys_dictionary` schema. Session-cookie auth via `credentials:'include'` + `X-UserToken` (g_ck) when available.
- Pure URL builders + cell helpers, unit-tested (`src/core/api.test.ts`).
- **Condition Tester** end-to-end: encoded query → match count + sample rows.
- **Table schema** loader (sys_dictionary → field list).

**M2 — Script Tester Layer 1** ✅ (LLM-free)
- Deterministic anti-pattern lint engine (`src/core/lint.ts`), unit-tested (`src/core/lint.test.ts`): `update-in-before-br`, `gliderecord-in-client-script`, `gs-in-client-script`, `previous-in-async-br`, `unconditioned-query`, `eval-usage`, `empty-catch`, `hardcoded-sys-id`. Comment/string-aware scanner keeps line numbers accurate and avoids false hits inside comments.
- Side panel **Script Tester** tab: auto-loads the script from a Business Rule / Client Script / Script Include record, kind + timing selectors, intent capture, findings list by severity.
- AI logic-vs-intent review is stubbed off (LLM disabled) per handoff §7 decision 2.

**M3 — Script Tester Layer 2** ✅
- **Superseded by commit `8fa4415`:** the original in-extension sandbox — a sandboxed iframe (opaque origin, classic IIFE) that ran user scripts via `new Function` against Glide mocks and returned a typed trace — has been removed as dead code. Layer 2 now runs the tester script as a **real, prod-guarded background-script run** ("bgrun", via `sys.scripts.do` through `src/core/sn-rest.ts`) rather than simulating it in-panel.
- Side panel **Layer 2** card: seed `current` from a real record ("Fill from a record"), edit current/previous, and run the script against the instance under the prod guard.

> ⚠️ **Needs a real-browser smoke test:** the bgrun round-trip (`sys.scripts.do` execution + prod-guard enforcement) can only be confirmed by loading `dist/` in Chrome. Everything else in M0–M3 is verified.

**M4 — F1 Design Spec Generator** ✅ (LLM-free, template-driven)
- **Graph walker** (`src/core/graph.ts`): bounded BFS (depth 2), dedupe, injected fetch — unit-tested.
- **Resolvers** (`src/core/resolvers.ts`): Business Rule (target table + referenced Script Includes via script scan), Catalog Item (variables, variable sets, UI policies, catalog client scripts, workflow), Script Include (recursive refs), Table→ACLs, Transform Map→entries — unit-tested pure helpers.
- **Composer** (`src/core/spec.ts`): artifacts → SpecDocument with the fixed skeleton (Overview → Data Model → Logic → Integration Points → Security/ACL) — unit-tested.
- **Renderers**: HTML (`render-html.ts`, self-contained, MFEC light theme + logo + print CSS, HTML-escaped — unit-tested) and Word `.docx` (`render-docx.ts`, `docx` lib — pack-tested).
- Side panel **Design Spec** tab: discover artifacts → include/exclude checklist → export **HTML / PDF (print) / Word**.

**M5 — Script Tester Layer 3 (guarded real execution) + prod guard** ✅
- **Prod guard** (`src/core/prod-guard.ts`): default-DENY hostname classifier — writes are only allowed on confirmed sub-prods (`dev`/`test`/`uat`/`sandbox`/`demo`/…, configurable); explicit production markers hard-block even if a sub-prod marker is also present. 15 unit tests.
- Guarded write ops in the REST client (`create`/`delete`): the background classifies the host and refuses the write **before any network I/O** on prod; writes also require `X-UserToken` (g_ck).
- Side panel **Layer 3** card: prod-guard badge, create a real test record on a sub-prod → read it back → highlight fields the engine changed → delete it (all with explicit confirmation; disabled on prod).

> ⚠️ **Real-browser smoke test items:** M1 auth (session/g_ck), M3 Layer 2 bgrun round-trip (`sys.scripts.do`), M4 resolver table/field names per instance version, and M5 writes (create/delete on the sub-prod). Pure logic is unit-tested; live I/O needs `dist/` loaded in Chrome against `mfecplcdemo10`.

Next: **F3** — XML Mover (design in handoff §9). Optional later: LLM enhancement layer (Layer 1 intent review, F1 prose), ATF-based Layer 3.

## Layout

```
src/
├── manifest.config.ts   # MV3 manifest (@crxjs defineManifest)
├── background/          # service worker (opens side panel; message broker)
├── content/            # index.ts (isolated) + mainworld.ts (g_form/g_ck bridge)
├── core/               # context parser + shared types (unit-tested)
└── sidepanel/          # side panel UI (MFEC light theme)
public/
├── brand/              # MFEC logos (extracted from company profile PPTX)
└── icons/              # extension icons
```
