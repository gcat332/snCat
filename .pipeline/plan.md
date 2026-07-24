# Phase 2 — Plan

Branch: `pipeline/production-readiness` off `main@ab94407`. Baseline: 110 tests green, build exit 0.
Ordering per orchestrator contract: **critical/high bugs → security → tests locking behavior → refactors last.** No critical survived adjudication (sandbox egress critical→high; guardConfig high→medium — see decisions.log). So Phase 3 starts at the highs.

Each bugfix task: fix exactly ONE finding, failing test FIRST where the module is unit-testable, minimal fix, no drive-by edits, full `npm test` as evidence. One commit per task. UI/manifest tasks that can't be unit-tested are verified by `npm run typecheck` + `npm run build` + targeted reasoning, and flagged for the M0–M5 manual smoke list.

## Phase 3 — High-severity bug fixes (in order)

| Task | Finding | Files (scope) | Testable? | Acceptance | Verify |
|---|---|---|---|---|---|
| T-201 | prod-guard classifies by first DNS label only → vanity-domain misclassification (prod allowed / sub-prod blocked) | `src/core/prod-guard.ts`, `src/core/prod-guard.test.ts` | yes (TDD) | first-label heuristic restricted to `*.service-now.com`; non-service-now hosts default-DENY unless explicitly allowed; FORCED_PROD still wins; existing 15 tests still pass | `npx vitest run src/core/prod-guard.test.ts` then full `npm test` |
| T-202 | `apiWrite` reports success on expired-session login redirect; `apiGetText` returns login HTML as data | `src/core/sn-rest.ts`, NEW `src/core/sn-rest.test.ts` | yes (new characterization test w/ mocked fetch, Phase 0 gap) | write/getText detect `res.redirected && /login|sso/` and non-JSON success → 401; add characterization tests for guard-403-before-fetch, 401-no-token, 204, redirect | new test file green + full `npm test` |
| T-203 | XML CDATA-unaware field regex truncates fields & desyncs the record scan | `src/core/xml.ts`, `src/core/xml.test.ts` | yes (TDD) | CDATA spans handled (extracted opaque) before tag matching; a BR script containing `</script>` parses intact; existing 8 tests pass | `npx vitest run src/core/xml.test.ts` + full `npm test` |
| T-204 | `ruleUnconditionedQuery` mis-scopes query search on reused GlideRecord var name (false pos + false neg) | `src/core/lint.ts`, `src/core/lint.test.ts` | yes (TDD) | each declaration's query window scoped to `[declIndex, nextDeclOfSameName)`; add the var-reuse fixture as failing test first; existing 13 tests pass | `npx vitest run src/core/lint.test.ts` + full `npm test` |
| T-205 | `SandboxRunner.ensure()` readiness wait has no timeout → sticky hang across all future runs | `src/core/sandbox-host.ts`, NEW `src/core/sandbox-host.test.ts` (light, injected frame factory) | partial | readiness wait has its own timeout that rejects and resets `frame`/`ready`=null so next run reprovisions; per-job timeout unchanged | test if feasible; else typecheck+build + reasoning |
| T-206 | Sandbox CSP has no `connect-src`; `new Function` scripts can `fetch()` seeded instance data out | `src/manifest.config.ts` | no (build) | sandbox CSP adds `connect-src 'none'; navigate-to 'none'`; built `dist/manifest.json` reflects it; extension still builds | `npm run build` + grep dist manifest for connect-src |
| T-207 | (a) `resolveScope` silent `global` fallback disagrees with confirm-dialog text; (b) `deleteTestRecord` not pinned to creation host → cross-instance delete | `src/sidepanel/main.ts` only | no (UI) | (a) unresolved scope name blocks the write with a visible error OR dialog shows the resolved target; (b) `l3Created` stores host, delete targets stored host, cleared on host change, host named in confirm | `npm run typecheck` + `npm run build`; add to manual-smoke list |
| T-208 | `runLlmJob` leaves `status:'running'` forever if SW dies mid-fetch | `src/background/index.ts` | no (build) | running entry carries `startedAt`; stale running (older than fetch timeout + margin) is treated as failed on restore so the user can retry | `npm run typecheck` + `npm run build`; manual-smoke list |

T-207 (a)+(b) are two findings in one file → one sequential worker, but each gets its own commit if practical; no other main.ts change rides along.

## Phase 4 — Refactors (after all highs verified + green). Gated on T-106 dead-code sweep results.
- Behavior-preserving only; same test count, no skips; scope stated in one sentence per task.
- Candidates already identified (mediums/lows): reference-field display bugs (T-102), ACL STARTSWITH anchor (T-102), BR fetch-amplification memoize (T-102), lint string-awareness (T-103), main.ts `runBgMarked`/`makeModal`/`confirmScopedWrite` extractions + dead detect() branch (T-105), xml sys_scope/sys_package strip + shared field-parse helper (T-104), extractJson brace-scan (T-104).
- **User-requested cleanup**: unused features/exports/deps/assets from T-106 → each removal a separate refactor commit with its Chesterton's-Fence purpose note; anything UNCLEAR escalates to `escalations.md`.

## Phase 5 — Independent verify, Phase 6 — Gate + REPORT.md (unchanged from orchestrator spec).
