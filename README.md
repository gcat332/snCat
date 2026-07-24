# snCat — ServiceNow AI Assistant (Chrome Extension, MV3)

A Chrome Extension with a shared core engine and two features:

- **F1 — Design Spec Generator**: generate a Design Spec (PDF / Word `.docx` / HTML) from any ServiceNow record, styled in the MFEC light theme.
- **F2 — Script Tester**: 3-layer testing (static AI review → sandbox simulation → guarded real execution) for Business Rules / Client Scripts.

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
4. Open a ServiceNow page (dev instance: `mfecplcdemo10.service-now.com`) → click the snCat toolbar icon → the side panel opens and reports the current **table + sys_id**.

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

Next: **M2** — Script Tester Layer 1 (AI-free static anti-pattern lints + intent input).

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
