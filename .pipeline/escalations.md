# Escalations — human decision required

## E-01 — Layer 2 in-extension sandbox chain is dead at runtime (affects T-205, T-206)

**Discovered by:** T-106 dead-code sweep, independently verified by orchestrator (grep: `SandboxRunner`/`sandbox-host` has **zero importers**; the "Simulate (no write)" UI button routes through `runBackground` → `bgrun`, not the sandbox iframe).

**What's dead at runtime (~670 LOC):** `src/core/sandbox-host.ts`, `src/sandbox/engine.ts`, `src/sandbox/glide-mocks.ts`, `src/sandbox/main.ts`, `src/core/trace.ts`, `public/sandbox/index.html`, `vite.sandbox.config.ts`, the `sandbox` + sandbox-CSP manifest keys, and the second build pass (`build:sandbox`). The `engine.test.ts` (11 tests) still exercises the pure engine in Node, so the tests pass regardless of runtime reachability.

**Why it's dead:** commit `8fa4415` (2026-07-24, "sandbox→background run") replaced the in-panel V8-mock simulation with executing the AI-generated tester script as a **real** prod-guarded background script via `sys.scripts.do` (`bgrun`) — real Rhino semantics instead of the mock approximation. That commit's message explicitly says **"engine kept in codebase"** — a deliberate owner decision one day before this review. That is why this is escalated, not auto-removed (Chesterton's Fence + the >50-line-deletion rule).

**Impact on the plan:**
- **T-206** (sandbox CSP `connect-src` egress, from T-103): the sandbox page is never loaded, so the `new Function` egress path is **not reachable in the shipped product**. The "high" is effectively moot while the chain stays dead.
- **T-205** (`SandboxRunner.ensure()` sticky hang): `SandboxRunner` is never instantiated, so the hang **cannot occur in production**.

Both are therefore **paused** (status `escalated`) rather than fixed — fixing unreachable code would be wasted effort, and the alternative (deletion) needs the owner's call.

**Decision needed — pick one:**
1. **Remove** the dead L2 sandbox chain (single cut; collapses build to one Vite pass; update CLAUDE.md "Build is two-pass"/"Sandbox iframe" bullets + README line 58). → T-205/T-206 close as WON'T-FIX (code gone); becomes a Phase 4 refactor task.
2. **Keep & re-wire** the in-panel sandbox as a real feature again. → T-205 and T-206 become real high-severity fixes and are re-activated in Phase 3.
3. **Keep dormant as-is** (documented dead code). → T-205/T-206 stay closed as not-reachable; add a one-line "dormant, not wired" note to CLAUDE.md so the next reader isn't misled.

Recommendation: **option 1** (remove) unless the owner still wants offline/no-instance simulation — the `bgrun` path supersedes it with truer semantics, and dead security-sensitive code (an eval sandbox) is a liability to keep shipping.

---

## Other T-106 outcomes (no human decision needed; folded into Phase 4)
- **SAFE-REMOVE (171 LOC total):** direct Table-API write path (`api-client.ts` create/update/deleteRecord + `sn-rest.ts` apiWrite + create/update/delete cases + `api.ts` buildCreateUrl/write arms — superseded by `bgrun`); `api.ts:buildListXmlUrl` (superseded by per-record Table-API fetch, 6ac445c); `styles.css` `.schema-row*` + `.diff-kv.same`/`.dk-same` (superseded UI styles); root `java-emoji.svg` (byte-identical dup of `public/brand/extension-icon.svg`).
  - NOTE: removing the direct Table-API write path deletes `apiWrite`, which is where the T-202 fix lands. **Sequencing decision:** apply the T-202 fix first (it also protects `apiGetText`, which stays), then let the Phase 4 cleanup remove whatever of `apiWrite` remains dead. Do NOT remove the write path before T-202 or the fix has no landing site to validate against.
- **UNCLEAR (minor):** `@codemirror/view` direct dep (may be a deliberate duplicate-instance pin) — leave unless owner confirms.
- **KEEP:** prettier/highlight.js/docx/codemirror (all live via dynamic import or renderers), `extension-icon.svg` (rasterization source), `optional_host_permissions` (planned vanity support).
