# UC-2 — CI + Smoke Test (Design)

- Date: 2026-07-25
- Status: Approved (design)
- Scope: infrastructure only — no changes to `src/`

## Problem / Use Case

**Actor:** a developer (or future Claude session) changing the snJava extension.
**Pain:** the side panel (`src/sidepanel/main.ts`, ~2,700 lines) — the actual product surface — has zero automated coverage, and there is no CI. Regressions in build/packaging or UI boot ship silently; the recent hardening pipeline had to rely on manual review for every UI change.
**Goal:** every push/PR to `main` is gated so that typecheck, unit tests, a production build, build-artifact integrity, and a UI-boot smoke all pass before code is considered good.

## Non-goals (YAGNI)

- No full MV3 extension E2E (loading the unpacked extension + content scripts against a live/mock ServiceNow page) — brittle, out of scope.
- No multi-version Node matrix. Single Node 22 (matches `@types/node`).
- No changes to extension behavior or `src/`.
- No coverage thresholds/gates beyond pass/fail (can add later).

## Architecture

A single GitHub Actions workflow runs a linear sequence; any non-zero exit fails the run.

```
push / PR → main
  └─ job: ci (ubuntu-latest, Node 22)
       npm ci
       npm run typecheck        # tsc --noEmit
       npm test                 # vitest run (existing unit tests)
       npm run build            # tsc --noEmit && vite build  → dist/
       npm run verify:dist      # NEW: build-artifact + manifest assertions (no browser)
       npm run test:smoke       # NEW: Playwright UI-boot of the side panel
```

Two new checks, each independently runnable and understandable:

### verify:dist — `scripts/verify-dist.mjs`
Pure Node, runs after `build`, reads `dist/`. Responsibilities:
- Assert required artifacts exist: `dist/manifest.json`; the side-panel HTML and its bundled JS; the background service-worker JS; the content-script JS (isolated + MAIN world); the icon PNGs.
- Parse `dist/manifest.json` and assert MV3 shape: `manifest_version === 3`, and presence of `side_panel`, `background.service_worker`, `content_scripts`, `action`, `icons`.
- Exit non-zero with a clear message naming the first missing/invalid item.

Interface: `node scripts/verify-dist.mjs` (reads `./dist`, exits 0/1). Depends on: a completed `build`. Does not need a browser.

Note: exact bundled filenames are hashed/rewritten by `@crxjs`. The script resolves them from `dist/manifest.json` (which references the real emitted paths) rather than hardcoding names — so it stays correct across builds.

### test:smoke — `tests/smoke/sidepanel.smoke.ts` (Playwright)
- Serve `dist/` over a local static HTTP server (module scripts can't load over `file://` due to CORS). Playwright's `webServer` config (or an in-test server) points at `dist/`.
- `page.addInitScript()` injects a minimal `chrome.*` shim BEFORE page scripts run: `chrome.storage.session`/`local` (get→{}, set→resolve), `chrome.runtime` (sendMessage→resolve, onMessage.addListener→noop, getManifest→content_scripts stub, getURL→identity), `chrome.tabs` (query→[], onActivated/onUpdated/onRemoved.addListener→noop), `chrome.sidePanel`/`chrome.action`/`chrome.scripting` as needed. Goal: let the panel boot without a real extension host.
- Navigate to the side-panel HTML (path resolved from the manifest's `side_panel.default_path` as emitted in `dist/`).
- Assert: the three tab controls (Design Spec / Script Tester / XML Mover) render, and NO uncaught page error and NO `console.error` occurred during boot (collect via `page.on('pageerror')` / `page.on('console')`).

Interface: `npm run test:smoke` (Playwright). Depends on: a completed `build` (needs `dist/`). Faithful because it loads a real static page in real Chromium (CodeMirror etc. initialize properly), but stable because it never loads the MV3 extension runtime or a ServiceNow page.

## Data flow

CI is stateless: checkout → install → verify steps read the repo and the freshly built `dist/`. No secrets, no network beyond npm + Playwright's Chromium download (cached).

## Error handling / failure modes

- Any step's non-zero exit fails the job with that step's output.
- `verify:dist` names the first missing/invalid artifact.
- `test:smoke` surfaces the captured `pageerror`/`console.error` text in the assertion failure.
- Playwright Chromium is installed via `npx playwright install --with-deps chromium` and cached by the actions cache keyed on the Playwright version, so a cold CI run is the only slow one.

## Testing the tests (self-verification)

Before finishing, prove each new check actually fails when it should:
- `verify:dist`: temporarily rename/remove a required `dist/` artifact → confirm red → restore.
- `test:smoke`: temporarily inject a `throw` into the side-panel boot (or point at a broken page) → confirm red → revert.
Then confirm the full green run.

## New dependencies / files

- devDependency: `@playwright/test`.
- New scripts in `package.json`: `"verify:dist"`, `"test:smoke"`.
- New files: `.github/workflows/ci.yml`, `scripts/verify-dist.mjs`, `tests/smoke/sidepanel.smoke.ts`, `playwright.config.ts`.
- No changes under `src/`.

## Acceptance criteria

1. Pushing to `main` / opening a PR triggers the workflow.
2. The workflow runs typecheck + vitest + build + verify:dist + test:smoke, and is green on the current `main`.
3. `verify:dist` fails (red) if a required artifact is missing or the manifest loses an MV3 key; proven by a temporary break.
4. `test:smoke` fails (red) if the side panel throws on boot or a tab control is missing; proven by a temporary break.
5. `npm run verify:dist` and `npm run test:smoke` run locally after `npm run build`.
6. No behavioral change to the extension; `src/` untouched.
