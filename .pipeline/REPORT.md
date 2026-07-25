# Production-Readiness Pipeline — Report

**STATUS: COMPLETE & MERGED.** `main` fast-forwarded (zero conflict) to **`20b25ca`** = **26 commits** off baseline `ab94407`. Deliverable branch `pipeline/hardening`.
Final gate: typecheck **0**, single-pass build **0**, **153 tests pass** (baseline 110). Final independent verification (non-author, whole branch): **PASS** — 5/5 spot-checks, 0 regressions, no dead refs, no merge markers.

Scope delivered in three rounds: (1) **highs** — 6 fixed + 2 closed-by-removal; (2) **cleanup** — dead sandbox chain + dead write path + dead CSS/asset removed; (3) **medium + long tail (all remaining)** — 15 correctness/security/reliability/perf fixes + 1 behavior-preserving refactor. Only two items deliberately NOT changed (documented): the prod-guard `demo`/`training` pattern breadth (MFEC's dev instance genuinely uses `demo`) and the `@codemirror/view` dep pin. `runBgMarked` extraction deferred (heterogeneous sites; risk > reward).

### Round 2+3 ledger (medium + long tail)
| Task | Fix | Commit |
|---|---|---|
| T-301/T-302 | Spec reference fields → names not sys_ids (Data Model refs + variable_set/super_class labels) | 7004d6b / fcdc0ab |
| T-303 | Anchor ACL query (no sibling-table leak) | 3df0c4f |
| T-304 | XML: strip sys_scope/sys_package; capture self-closing tags | ff69d71 |
| T-305 | Lint ignores anti-patterns inside string literals (keeps hardcoded-sys-id) | ae20bd2 |
| T-306 | LLM JSON via brace-depth scan (trailing prose safe) | 3eaf608 |
| T-401 | sn-rest fetch timeouts (no infinite hang) | 92b6d56 |
| T-402 | Validate table identifiers (query-operator injection) | cf1b7cc |
| T-403 | LLM secret redaction + endpoint allowlist before send | d9d9391 |
| T-404 | LLM job coalesce + tab-close purge + surfaced write errors | e87ba83 |
| T-405 | Per-walk fetch memoization (kill BR fetch amplification) | bd4bbb6 |
| T-406 | .docx code block = one paragraph (not per-line) | ee18a2f |
| T-407 | HTML: esc single-quote, guard logo URI, curl lang, L3 anchors | b3786ea |
| T-408 | Context: first valid workspace route (not lastIndexOf) | af48cd0 |
| T-409 | XML record-boundary scanning CDATA-aware (T-203 residual) | 474c593 |
| T-410 | Side-panel reliability cluster (popups, listeners, jobs, TOCTOU host) ×8 | 31f56b4 |
| T-411 | Extract makeModal() (behavior-preserving); runBgMarked deferred | 20b25ca |

Deferred (documented, not blockers): bounded-concurrency in the graph walk (would risk BFS order).

## Concurrency — RESOLVED
A separate session was committing XML-Mover work to `pipeline/production-readiness` in parallel (`86ca92c`, `e732f49`, `39bf479`, `4b8354d`, `b46e80d`) — that is why `buildListXmlUrl` looked "dead" then live. Per the owner's decision, the 9 hardening commits were **cherry-picked onto a clean `pipeline/hardening` branch off `main`** in an isolated git worktree, so the two efforts are now separated:
- `pipeline/hardening` — this pipeline (hardening + dead-code removal). Clean, gated, verified.
- `pipeline/production-readiness` — the other session's XML-Mover feature work (left intact).

Only `pasteXml` (T-207) conflicted during cherry-pick (the other session had reworked it); resolved to the base's paste semantics + this pipeline's `checkTarget` scope-guard, independently verified coherent (no dangling `buildImportScript`/`rows`/`ins`/`upd`).

## Findings → resolutions

### High severity — all resolved (6 live) or closed (2 dead-code)
| Finding | Fix | Commit | Evidence |
|---|---|---|---|
| Prod guard misclassifies vanity domains (prod writes allowed / sub-prod blocked) | Restrict first-label heuristic to `*.service-now.com`; else default-DENY | `35c2ea1` | +6 tests |
| `apiWrite`/`apiGetText`/`apiBgRun` treat expired-session login redirect as success | Login-redirect → 401 on the **live** text+bgrun paths; new `sn-rest.test.ts` | `90588cb` | +5 tests (Phase-0 gap closed) |
| XML CDATA-unaware regex truncates fields & desyncs the record scan | CDATA read verbatim to `]]>`; shared `extractFields()` | `b6da9f5` | +3 tests |
| `ruleUnconditionedQuery` false pos+neg on reused GlideRecord var name | Scope query window per declaration | `5a69e9e` | +2 tests |
| resolveScope silent `global` fallback vs confirm-dialog text | `checkScope`/`checkTarget` block unresolved names; dialogs show real target | `4869bc6` | typecheck+build |
| deleteTestRecord not host-pinned → cross-instance delete | `l3Created` stores host; delete targets it; cleared on host change | `4869bc6` | typecheck+build |
| LLM job stuck `running` forever after SW death | `startedAt` + `isStaleJob` → retryable | `df5a89b` | typecheck+build |
| T-205 sandbox `ensure()` hang / T-206 sandbox CSP egress | **Closed won't-fix** — code was dead at runtime, removed in T-209 | — | E-01 |

### Adjudications (downgrades with rationale — `decisions.log`)
- guardConfig-over-postMessage "bypass": high→**medium** (forging script already has full page session; no escalation).
- Sandbox `new Function` egress: critical→**high** then **moot** (sandbox was dead; removed).

### Phase 4 cleanup (user-requested unused-feature removal)
| Removal | Commit |
|---|---|
| Dead Layer-2 in-extension sandbox (~660 LOC, 8 files) + manifest keys + 2nd build pass; single-pass build now; docs updated | `0370633` |
| Dead direct Table-API write path (createRecord/updateRecord/deleteRecord, apiWrite, buildCreateUrl, write ops) | `3ee81de` |
| Dead CSS (`.schema-row*`, `.dk-same`) + duplicate root `java-emoji.svg` | `d0e88d9` |
| T-106 CORRECTION: `buildListXmlUrl` was a **false** SAFE-REMOVE — it is live at main.ts:466; kept | — |

## Explicitly NOT done
- **Medium/low findings** (not requested this run): reference-field display-as-sys_id bugs (T-102), unanchored ACL `STARTSWITH` (T-102), BR→sys_db_object fetch amplification (T-102), lint string-literal awareness (T-103), sandbox/main sender-validation (moot post-removal), xml `sys_scope`/`sys_package` strip + self-closing tags (T-104), `extractJson` brace-scan (T-104), background job dedupe + `tabs.onRemoved` cleanup (T-104), main.ts `runBgMarked`/`makeModal` de-dup + dead `detect()` branch (T-105), LLM endpoint allowlist + redaction (T-104), fetch timeouts/AbortController (T-101).
- **Residual** (logged): XML record-boundary regex still foolable by CDATA containing the record's exact closing tag.
- **UNCLEAR** left as-is: `@codemirror/view` direct dep (possible deliberate duplicate-instance pin).
- **Phase 5 independent verify** and a formal Phase 6 sign-off — deferred pending the concurrency decision below.

## Rollback
Each fix is an isolated commit; revert any by hash. The whole pipeline is `git revert 35c2ea1..d0e88d9` minus the three foreign commits (86ca92c/e732f49/39bf479) — which is precisely why the entanglement (below) needs resolving first.

## Phase 6 — Production gate (evidence)
| Item | Verdict |
|---|---|
| Test suite green, ≥ baseline, new tests cover fixed bugs | PASS — 115/115 (baseline 110); +16 tests for the 4 testable highs; UI/background highs verified by typecheck+build+independent review; 11 engine tests removed with the dead code they covered |
| No critical/high findings open | PASS — 6 live highs fixed; 2 sandbox highs closed by removal |
| Production build succeeds | PASS — single Vite pass, exit 0 |
| Lint/static analysis | WAIVER — no ESLint/Biome in repo; `tsc --noEmit` exit 0 is the sole static gate |
| No secrets/debug/TODO-hacks/commented-out code introduced | PASS — every fix diff reviewed |
| Error handling on external calls | PARTIAL — 401/login-redirect/non-2xx/network-error handled on read+text+bgrun; **no fetch timeout yet** (deferred medium, see residuals) |
| Changelog (finding→fix→evidence) | PASS — table above + `decisions.log` |
| Rollback | PASS — isolated commits; `git revert dc88652..5ccf50c` cleanly backs out the whole set (no foreign commits on this branch) |

## Phase 5 — Independent verification (non-author)
PASS. typecheck 0 · single-pass build 0 · 115 tests · no merge markers · 4/4 acceptance spot-checks PASS (prod-guard vanity default-DENY, sn-rest redirect on live paths + write-path gone, main.ts checkTarget+host-pin+coherent pasteXml, sandbox fully removed) · 0 regressions.

## Next (optional)
Open a PR from `pipeline/hardening`. Remaining medium/low findings (reference-field display, ACL STARTSWITH, fetch timeouts, BR fetch-amplification, LLM endpoint allowlist/redaction, job dedupe, main.ts helper de-dup) are catalogued above for a follow-up pass.
