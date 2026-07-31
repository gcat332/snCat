# Project Handoff: ServiceNow AI Assistant — Chrome Extension

> Handoff date: 2026-07-24
> Origin: Design discussion in Claude.ai (Gust @ MFEC)
> Target: Continue implementation in Claude Code
> Last reconciled with the code: **2026-07-31**

---

## 0. Status at a glance (2026-07-31)

This document is the **design record**. `README.md` describes the extension **as it
behaves today**; where the two disagree, the README wins and this file is the one
that needs fixing.

| Item | State |
|---|---|
| M0 – M5 (§6) | ✅ Done |
| F1 Design Spec (§3) | ✅ Done — HTML / PDF / `.docx`, plus table-hierarchy and whole-application source modes (§10) |
| F2 Script Tester (§4) | ✅ Layers 1–3 done. **Layer 2 was re-designed**: the in-extension Glide mock sandbox was built, then removed in favour of a prod-guarded background-script run (`bgrun`) — see §4 Layer 2 |
| F3 XML Mover (§9) | ✅ Done — all six §9 open questions resolved, answers recorded in §9 |
| AI layer (§7 #2) | ✅ Implemented and gated on configuration (`configured:false` until an endpoint + key are set) |
| Admin-role gate | ❌ Built, then **reverted** on `main` — see §10 |

Superseded design decisions are marked **SUPERSEDED** in place rather than deleted,
so the reasoning behind a change stays readable: §2 #6, §4 Layer 2, §7 #1, §7a second
bullet.

---

## 1. What we are building

A single Chrome Extension (Manifest V3) with a shared core engine and two user-facing features:

| # | Feature | One-liner |
|---|---------|-----------|
| F1 | **Design Spec Generator** | On any ServiceNow record page, generate a Design Spec as PDF / Word / HTML, styled with the MFEC brand theme |
| F2 | **Script Tester** | Test Business Rules / Client Scripts through a 3-layer approach: static AI review → ~~sandbox simulation with real data~~ **prod-guarded background-script run on the instance** (revised — §4 Layer 2) → guarded real execution |
| F3 | **XML Mover** | On a record or list page, **Copy XML** (ServiceNow unload XML); on another instance, **Paste XML → Import** to recreate the record(s). Cross-instance record transfer without update sets. *(Built — see §9 for the resolved design.)* |

**Strategic decision (agreed):** both features are actions on top of one core engine:
`read page context → walk dependency graph via REST API → feed to AI → render in side panel`.
Architect the core separately from actions so future features (Explain Record, Impact Analysis, Update Set Reviewer, Test Scenario Generator, Incident→RCA) are cheap to add.

---

## 2. Key design decisions (already agreed — do not re-litigate without reason)

1. **DOM is only for identity, API is for data.** Content script reads *which* table/sys_id the user is on (from URL / `g_form`). All actual record data is fetched via Table API / Aggregate API using the existing session cookie. Reason: forms don't render all fields; API is complete and accurate.
2. **Dependency graph walking must be bounded.** "Everything related" in ServiceNow is unbounded (BR → Script Include → Script Include...). Default depth limit = 2 hops, and show the user a checklist of discovered artifacts to include/exclude *before* generation (controls spec bloat + token cost).
3. **Chrome Side Panel API over popup.** The panel stays open while the user navigates records; popups close on blur.
4. **LLM endpoint must be configurable** (org API key / custom endpoint) because customer script content leaves the instance. Add redaction for sensitive `sys_properties` values before sending.
5. **Prod guard is a hard block, not a warning.** If the instance hostname does not look like a sub-prod (`dev`, `test`, `uat`, `sandbox` patterns — make configurable), Layer 3 of the Script Tester is disabled entirely.
   *As built (`src/core/prod-guard.ts`): the guard grew wider than Layer 3 — it now covers **every** write the extension can make (Tester Layer 2 `bgrun` and Layer 3, Generate "create", F3 XML paste/undo, Add to update set). It is **default-DENY** (an unrecognised hostname is refused, not allowed), refuses in the REST layer **before any network I/O**, and an explicit production marker wins over a sub-prod marker in the same hostname.*
6. ~~**Start order:** Script Tester Layers 1+2 first — the Glide mock layer is the highest-risk component of the whole project; prove it early. F1 second.~~
   **SUPERSEDED (outcome, not a reversal).** The order was followed and the Glide mock layer *was* built first (M3) — proving it early is exactly what showed it was the wrong foundation, and it was then removed. See §4 Layer 2 for what replaced it.

---

## 3. Feature F1 — Design Spec Generator (reveal.js)

### Flow
1. User opens a record (e.g., Catalog Item, Business Rule, Flow) → clicks extension action "Generate Design Spec".
2. Core engine walks related artifacts (examples for a Catalog Item: variables, variable sets, UI policies, client scripts, attached flow/workflow, approvals; for a BR: table, condition, script, referenced Script Includes).
3. User reviews the artifact checklist (include/exclude), then confirms.
4. AI composes the spec with a standard skeleton: **Overview → Data Model → Logic → Integration Points → Security/ACL**.
5. Output = the spec in **three formats** (see §3a): **PDF**, **Word `.docx`** (editable), and **self-contained HTML** — all downloadable. HTML is generated first; PDF via print CSS, `.docx` via a client-side `docx` builder. All three use the **light document theme** (§3b), not the dark slide theme.

### MFEC brand theme — extracted from `MFEC_Company_Profile_2026_version_1.pptx` (31 slides, verified against theme XML + rendered slides)

**Mood:** dark enterprise-tech. Near-black navy backgrounds, heavy use of blue→purple gradients (112 gradient fills counted), white text on dark, glowing curved flow lines, large stat numbers, translucent cards.

**Design tokens:**

```css
:root {
  /* Backgrounds */
  --mfec-bg-deep:    #000040;  /* darkest navy, hero background */
  --mfec-bg-navy:    #000960;  /* primary dark background */

  /* Brand blues (theme accents, verified in theme1.xml + slide usage) */
  --mfec-blue-dark:  #0031B4;  /* accent3 — headings on light */
  --mfec-blue:       #0062EC;  /* ~accent1 0061EB, used as 0062EC in slides */
  --mfec-cyan:       #00A2E9;  /* highlight / links / callouts */
  --mfec-sky:        #4DB3F4;  /* dk2 — secondary accents */

  /* Purples */
  --mfec-purple:     #9063CD;
  --mfec-violet:     #6968AB;  /* ~accent2 6766A9 */

  /* Text */
  --mfec-text-light: #FFFFFF;
  --mfec-text-dark:  #1F1F1F;

  /* Signature gradient (approximate slide style) */
  --mfec-gradient: linear-gradient(135deg, #000960 0%, #0031B4 45%, #6968AB 80%, #9063CD 100%);
}
```

**Typography:** family **Prompt** (Google Fonts, Thai-capable — dominant across the deck at 1,600+ runs):
- Headings: Prompt Medium (500)
- Body: Prompt Light (300) / ExtraLight (200)
- Load: `https://fonts.googleapis.com/css2?family=Prompt:wght@200;300;400;500&display=swap`

### 3a. Output formats (REVISED 2026-07-24)

The Design Spec exports in **three formats**, all from one light-themed source:
- **PDF** — generate the HTML, apply print/PDF CSS, print-to-PDF. Primary deliverable.
- **Word `.docx`** — build client-side with the `docx` JS library (editable hand-off doc). Map skeleton sections → Word headings/tables; MFEC accent colors on heading styles + table headers; logo in the header/cover.
- **HTML** — self-contained (CSS inline, fonts via Google Fonts link) for quick preview/share.

The dark reveal.js slide theme is **dropped** for this deliverable — a spec doc is read/printed/edited, so it uses a light theme.

### 3b. Document theme rules — LIGHT (REVISED 2026-07-24)

Keep the MFEC color tokens (§ above) but as **accents on a white page**, and include the **MFEC logo**:
- **Page/background:** white `#FFFFFF`; body text dark `#1F1F1F`; Prompt font family.
- **Cover / section headers:** MFEC blue→purple gradient band or `--mfec-blue-dark #0031B4` bar with white Prompt Medium heading; **MFEC logo** top-left of cover and/or running header.
- **Headings:** `--mfec-blue-dark #0031B4` (H1/H2), `--mfec-blue #0062EC` (H3); Prompt Medium.
- **Accent line / rules / callouts:** cyan `#00A2E9`.
- **Tables (Data Model / ACL):** header row filled `--mfec-blue-dark` with white text; zebra rows very light navy tint (`rgba(0,49,180,0.04)`); 1px light border.
- **Inline code / logic blocks:** light gray surface `#F4F6FB`, cyan accent on keywords.
- **Diagrams (Mermaid if used):** light theme, edge color `--mfec-blue`, node fill light tint with `--mfec-blue-dark` border.
- **Print CSS:** avoid dark fills across full pages (ink), page-break before each section, repeat table headers.

Hardcode this theme into the extension as a CSS template + docx style map — the PPTX does not ship. **The MFEC logo asset (SVG/PNG) is needed** — see §8.

---

## 4. Feature F2 — Script Tester (3-layer design)

Business Rules run server-side (Rhino), Client Scripts run in the browser — test strategies differ per layer.

### Layer 1 — Static Analysis + AI Review (zero instance risk)
- Fetch script + condition + table schema (`sys_dictionary`) via Table API.
- User states intent in plain language; AI checks logic vs intent.
- Anti-pattern lints: `current.update()` in *before* BR, unconditioned `GlideRecord` queries, `GlideRecord` inside Client Scripts, missing `previous` null checks in async, etc.

### Layer 2 — Background-script run on the instance (`bgrun`), prod-guarded (REVISED)

**As built.** The script runs **on the instance** as a real server-side background
script via the classic `sys.scripts.do` form (`src/core/sn-rest.ts`, action `bgrun`),
submitted from the content script so the session cookie and `X-UserToken` (`g_ck`)
travel with it. Output is the script's own printed output, parsed back out of the
returned HTML.

- Real Rhino engine, real data, real APIs — so the result *is* ground truth, not a simulation.
- **Safety is the prod guard's job** (§2 #5): a `bgrun` is a write in the guard's eyes and is refused before any network I/O on anything not confirmed sub-prod.
- Same mechanism is reused by every other server-side operation the panel needs (F3 import/undo, Add to update set, Layer 3 create/read/delete), so there is one audited path to the instance rather than several.

> **SUPERSEDED design — in-extension Glide mock sandbox (M3).**
> The original plan was to execute the script inside a sandboxed iframe (MV3 CSP
> blocks `eval` in extension pages) against **mocked** `current` / `previous` / `gs` /
> `GlideRecord` / `g_form` / `g_user`, seeded read-only from a real record, emitting an
> execution trace and never writing to the instance. It was built, then removed.
> Why: the mock's own stated caveat was the problem — ServiceNow server-side is Rhino
> (ES5) and the sandbox is V8, so every result had to be labelled *simulation, not
> ground truth*, and the mock surface needed endless growth to keep up with real
> scripts. Running the script where it actually runs removes both problems; instance
> safety moves to the prod guard, which is a hard block rather than an approximation.
> Consequences of the removal: no `sandbox/` or `runner/` directory (§5), M3 is
> retired (§6), and §7 #1 / §7a's "3 + 1" run UX no longer apply.

### Layer 3 — Real Execution (guarded)
- **Client Script:** inject into the real form on sub-prod, drive a chosen scenario (set field X), capture all `g_form` calls → this runs on the real engine, high fidelity.
- **Business Rule:** create a real test record on sub-prod → read outcome (changed fields, work notes, `sys_audit`) → delete the record. Alternative/preferred where ATF is adopted: generate an ATF test and run it via API (aligns with the existing `itsm-deploy` ATF regression work; leaves a reusable regression asset).
- **Hard prod guard** (decision #5 above).

**M5 status (2026-07-24):** Implemented — the **Business Rule test-record flow** (create real record on sub-prod → read back → highlight engine-changed fields → delete) behind the **hard prod guard** (`core/prod-guard.ts`, default-deny). Writes require `X-UserToken` and are refused before any network I/O on prod. **Deferred to later passes:** client-script live capture (needs live `g_form` interaction in the page main world) and ATF test generation/run (aligns with `itsm-deploy`; larger sub-project).

### Condition Tester (cheap, high value — build alongside Layer 1)
Before testing the script, test the BR condition/filter itself: run the encoded query via Table API and show which records match. Many "bugs" are mis-triggering conditions, not script logic.

---

## 5. Architecture (MV3)

### 5a. As built (2026-07-31)

```
src/
├── manifest.config.ts   # MV3 manifest (@crxjs defineManifest) — side_panel, no sandbox page
├── background/          # service worker: opens the panel, brokers messages, runs LLM jobs per tab
├── content/             # index.ts (isolated world) + mainworld.ts (g_form / g_ck bridge + javaHelp chip)
├── core/                # ALL pure logic, unit-tested in Node (no chrome.* except api-client.ts)
└── sidepanel/           # the entire UI (main.ts, ~4.1k lines) + editor.ts (CodeMirror 6 wrapper)
public/
├── brand/ icons/        # MFEC logos, extension icon
└── vendor/              # vendored Add to Update Set Utility export (see public/vendor/README.md)
```

Three deviations from the proposed tree below, all deliberate:

1. **`core/` replaces `background/api|graph|llm`.** Because REST must run in the content script (auth note below), the modules cannot live under the service worker. Keeping them pure and chrome-free is what makes them Node-testable — this is the project's main testability seam.
2. **No `sandbox/` or `runner/`.** Both existed only to host the Glide mock runtime, which was removed (§4 Layer 2).
3. **No `themes/mfec-reveal.css`.** reveal.js was dropped for F1 (§3a); the theme lives in `core/render-html.ts` (inline CSS for the self-contained export) and `sidepanel/styles.css`.

### 5b. Originally proposed (kept for reference)

```
extension/
├── manifest.json            # MV3, side_panel, sandbox page declared
├── background/              # service worker
│   ├── api/                 # ServiceNow REST client (Table, Aggregate, ATF)
│   ├── graph/               # dependency walker (depth-limited, per-artifact-type resolvers)
│   └── llm/                 # AI client, configurable endpoint, redaction
├── content/                 # page context detection (table, sys_id, g_form bridge)
├── sidepanel/               # UI (artifact checklist, tester UI, results); hosts inline sandbox iframe
├── runner/                  # dedicated full-page test-runner (extension page); pop-out target for F2
├── sandbox/                 # sandboxed iframe: Glide mock runtime + script executor (loaded by both sidepanel & runner)
│   └── glide-mocks/         # current/previous/gs/GlideRecord/g_form (+ scoped: GlideRecordSecure, scoped gs)
└── themes/
    └── mfec-reveal.css      # brand theme (tokens above)
```

- Auth (RESOLVED in code, 2026-07-24): REST calls **must run in the content script (page origin)**, not the service worker. A background/SW fetch is cross-site, so ServiceNow's `SameSite=Lax` session cookie is withheld → 401 even when the user is logged in. The side panel messages the top-frame content script (`frameId:0`), which fetches same-origin with the cookie; `X-UserToken` (`g_ck`, read by the main-world bridge) is added for writes. See `core/sn-rest.ts`, `content/index.ts`, `core/api-client.ts`.
- Detect context on both **classic UI** (`/nav_to.do`, `/<table>.do?sys_id=`) and **Next Experience/polaris** URLs (`/now/nav/ui/classic/params/target/...`) — parsing differs.

## 6. Milestones (status as of 2026-07-31)

1. ✅ **M0 — Skeleton:** MV3 scaffold, side panel opens, content script correctly reports table + sys_id on both classic and polaris UIs.
2. ✅ **M1 — API core:** REST client with session auth; fetch record + `sys_dictionary` schema; Condition Tester working end-to-end.
3. ✅ **M2 — Tester L1:** static anti-pattern lints (`core/lint.ts`), LLM-free; the AI "logic vs. intent" review landed later as **Java review** (§7 #2).
4. ⛔ **M3 — Tester L2 (sandboxed iframe + Glide mocks): built, then retired.** Replaced by the prod-guarded `bgrun` — see §4 Layer 2.
5. ✅ **M4 — F1 MVP:** graph walker (depth 2), artifact checklist, template-composed spec, HTML/PDF/`.docx` in the light MFEC theme (not reveal.js — §3a).
6. ✅ **M5 — Tester L3:** BR test-record flow (create on sub-prod → read back → highlight engine-changed fields → delete) behind the prod guard. **Still deferred:** client-script live capture and ATF generation/run (see the M5 status note above).

Work after M5 is not milestone-numbered; it is logged in §10.

## 7. Resolved decisions (2026-07-24, Claude Code session)

The section-7 open questions were resolved as follows:

1. ~~**Sandbox scope — Global + scoped from day one.** Glide mocks support both global-scope (`current`, `previous`, `gs`, `GlideRecord`, `g_form`, `g_user`) and scoped-app semantics (`GlideRecordSecure`, scoped `gs`, ACL-aware reads) from the start.~~
   **SUPERSEDED — moot.** There are no Glide mocks any more (§4 Layer 2). Scope is now a real property of the run rather than a mock fidelity setting: the panel's scope bar picks the application a write happens in, `bgrun` executes in the instance's own engine with its own ACLs, and Add to update set is forced to **global** because the vendored utility's APIs are global-only.
2. **LLM endpoint — build LLM-free first; LLM is a pluggable enhancement layer.** *(Held. As built: `core/llm.ts` ships three format adapters — `anthropic`, `openai`, MFEC `agenthub` — restricted to an allowlist of provider hosts, with script bodies redacted before sending. The default is still "not configured", and AI features report `configured:false` rather than failing. The AI surfaces now live: Java review, the Generate tab, and the F1 spec narrative.)* The `llm/` module is a provider interface whose **default provider is `none` (deterministic)**. F1 spec composition uses a **template** that structures fetched artifacts into the skeleton with no prose generation; Layer 1 ships **rule-based anti-pattern lints only**. The LLM-powered parts (Layer 1 "logic vs. intent" review, F1 prose polish) are optional and added later. Consequence: no customer script/record content leaves the instance during early dev, so the redaction + proxy-vs-direct-API decision is **deferred, not blocking**. Reversible: picking proxy vs. direct later = one provider implementation behind the existing interface.
3. **Dev instance — an MFEC sub-prod with representative ITSM data.** Dev/test hostname: **`mfecplcdemo10.service-now.com`**. For real use the extension must work on **any** instance by reading the **active tab's URL dynamically** (no hardcoded instance). Impl: `host_permissions: ["https://*.service-now.com/*"]` covers standard instances; vanity-domain instances handled later via `optional_host_permissions` requested on demand. Feeds prod-guard sub-prod pattern config in decision #5, section 2.
4. **F1 resolver priority (after Catalog Item + Business Rule) — Script Include, ACL, Transform Map.** Flow/Workflow deprioritized (build after these three).
5. **reveal.js PDF export — yes.** Include reveal.js print/PDF CSS in the theme so the self-contained HTML exports cleanly to PDF (print-to-PDF).

### 7a. Feature revisions (2026-07-24, Claude Code session)

- **F1 output — PDF + Word `.docx` + HTML (was: reveal.js HTML only).** All three from one **light** document theme (white page, MFEC colors as accents) **with the MFEC logo**. Dark slide theme dropped for this deliverable. See §3a/§3b. Needs the `docx` JS library and the logo asset (§8).
- ~~**F2 run UX — "3 + 1": inline iframe in the side panel + pop-out full-page runner.** Clicking Run executes the user script in a **sandboxed iframe embedded in the side panel** (fast, in-context). A **pop-out button** opens the same sandbox in a **dedicated full-page runner tab** (`runner/`) for more room / long execution traces. `background/` acts only as the broker that ships `{script, context}` into whichever host — it never executes user script itself (MV3: SW has no DOM + CSP blocks `eval`).~~
  **SUPERSEDED** with the mock sandbox (§4 Layer 2). There is nothing to host locally: Run submits the script to the instance and renders the returned output in the side panel, so no iframe and no pop-out runner. The clause that *did* survive is the last one — the service worker still never executes user script; it only brokers messages and runs LLM jobs so an in-flight request outlives the panel closing.

## 8. Reference notes

- Brand tokens sourced from `MFEC_Company_Profile_2026_version_1.pptx` — theme1.xml accents + frequency analysis of slide XML + visual render. Keep the PPTX for future re-extraction if branding updates.
- **MFEC logo assets — extracted** from the PPTX (`ppt/media/`) into `public/brand/`: `mfec-logo-dark.png` (dark wordmark for white pages, used in side-panel header + as the F1 doc logo source), `mfec-logo-light.png` (white wordmark for the F1 gradient cover band). The `.pptx` itself is **git-ignored** (43 MB) but kept locally for re-extraction.
- **Extension icon** = `public/brand/extension-icon.svg` ("น้อง Java" dog emoji, user-supplied), rasterized to `public/icons/icon-{16,32,48,128}.png` via macOS `qlmanage` after squaring the viewBox. Re-rasterize from the SVG if it changes.
- **Stack chosen: TypeScript + Vite + `@crxjs/vite-plugin`** (MV3, HMR, side panel support). Vitest for the context-parser unit tests.
- Related prior work by Gust that connects here: `itsm-deploy` ATF regression gates (Layer 3), Chesterton's Fence refactoring framing (Impact Analysis future feature), reasoning-trace skill (could drive the graph-walk audit trail).

---

## 9. Feature F3 — XML Mover (added 2026-07-24; **built**, design resolved 2026-07-25)

**Goal:** move a record (or a filtered list of records) from one instance to another without building an update set, using ServiceNow's native record **unload XML**.

### Intended flow
1. On a **record** page → **Copy XML**: fetch the record's unload XML and put it on the clipboard (and/or an in-extension clipboard store keyed per record).
2. On a **list** page → **Copy XML** for the current filtered set (bounded — cap count, warn if truncated).
3. On a **different instance** → **Paste XML → Import**: recreate the record(s) there.

### Technical notes / how ServiceNow exposes this
- **Export XML (source):** classic endpoints serve unload XML directly, e.g. `https://<host>/<table>.do?sys_id=<id>&XML` (single record) and `https://<host>/<table>_list.do?sysparm_query=<q>&XML` (list). Fetchable read-only with the session cookie — same auth path as M1.
- **Import XML (target) — two candidate strategies, pick during design:**
  1. **Parse → Table API create/update.** Parse the `<unload>` XML into a field map, then POST via Table API to the target. Most controlled; lets us diff, remap references, and choose insert-vs-update. Downside: reference fields + sys_id collisions must be handled explicitly.
  2. **Native XML import.** Drive ServiceNow's own single-record XML import (the "Insert XML" path). Higher fidelity to unload semantics but relies on instance UI/endpoints and is harder to script cleanly from an extension.

### Resolved (as built — `core/xml.ts`, `core/f3-import.ts`, Inspect tab)

Strategy **1** (parse → server-side write) was chosen, but executed through a
**background script** rather than the Table API, so one submission handles the whole
batch transactionally-ish and can report per-row outcomes.

1. **sys_id policy — preserve.** Inserts use `gr.setNewGuidValue(sysId)` with `setWorkflow(false)` / `autoSysFields(false)`, so a moved record keeps its identity and inbound references still resolve. That makes collisions real, which is why (5) exists.
2. **References & related lists — not followed.** Only the records the user copied are moved; the F1 graph walker is *not* reused here. Referenced records that do not exist on the target stay dangling, visibly, rather than being silently invented.
3. **List copy — bounded by the same limit as the rest of the panel** (10,000 sys_ids fetched in one pass, `> 200` requires a second confirmation). A list with more matches than can be fetched is **refused with a "narrow the filter" message**, never silently truncated.
4. **Prod guard — reused, unchanged.** Paste and Undo are writes and go through the same default-DENY guard.
5. **Conflict handling — INSERT_OR_UPDATE, with the overwrite recorded.** An existing sys_id is updated, and the **before-values of every field being overwritten** are captured in the same run and stored as an **undo log** (`chrome.storage.local`, keyed per host). Undo deletes the inserts and restores the updated fields. The panel shows the insert/update split as a preview *before* the write.
6. **Clipboard vs. store — in-extension store.** The genuine unload XML from `.do?…&XML` is kept in `chrome.storage.local` under `xmlClip` (one clip, with host/table/count metadata), which is what makes the paste-side preview and the "Paste (n)" label possible. Paste re-parses that XML and strips `SYSTEM_FIELDS` before inserting.

**Reuse:** F3 shares the M1 REST client (fetch), the context detector (record vs list), and the F2 prod-guard. This is exactly the "cheap to add" payoff of the core-engine architecture (§1).

---

## 10. Work log after M5 (2026-07-25 → 2026-07-31)

Per-feature designs and task plans live in `docs/superpowers/specs/` and
`docs/superpowers/plans/`; user-facing behaviour is described in `README.md`.

**Shipped**

| Area | What landed |
|---|---|
| F2 | **Fix Script** flow — apply an LLM-suggested rewrite back to the record, with a line-level diff (`core/diff.ts`) before saving |
| F2 | Script-bearing-table map (`core/script-meta.ts`): which field holds the script/timing per table, so the Tester can load from a record |
| F1 | **Table hierarchy** source option (`core/hierarchy.ts`) — walk `super_class` up (≤10 hops) and one level of children down (cap 20), marking rows `↑ parent` / `↓ child` |
| F1 | **Application scope** source option (`core/scope-spec.ts`) — flat sweep of every artifact in one `sys_scope`, deliberately *not* a dependency walk; Global is refused |
| F1 | AI spec narrative (optional, gated on LLM config) |
| F3 / Inspect | **Copy/paste list condition** across instances (`core/condition-clip.ts`) — query pasted verbatim, embedded sys_ids surfaced as warnings, never rewritten |
| Inspect | **Add to update set** (`core/update-set-add.ts`) via the Add to Update Set Utility's `addToUpdateSetUtils`, calling `checkTable` (not the UI wrapper `addToUpdateSet`, which needs `gs.action`/`RP`); installs the vendored v9.5 export (`core/updateset-xml.ts`, `public/vendor/`) when the instance lacks it, detected by `api_name=global.addToUpdateSetUtils` |
| Cross-cutting | Session-expiry detection + SSO-aware re-auth message (`core/auth-msg.ts`); Settings/onboarding pass (`docs/ONBOARDING.md`); CodeMirror 6 editors with on-demand Prettier formatting (`sidepanel/editor.ts`, `core/format.ts`); `npm run verify:dist` build check and a Playwright panel-boot smoke test (`npm run test:smoke`) |

**Reverted — admin-role gate**

A gate requiring the `admin` role (block a confirmed non-admin, fail **open** behind an
amber banner when roles are unreadable) was built on `feat/admin-gate`, merged, and then
reverted on `main` (`cbec0e9`, 2026-07-27). The branch and its plan
(`docs/superpowers/plans/2026-07-27-admin-role-gate.md`) are retained.

What the attempt established, for whoever picks it up: reading `g_user` through the
mainworld → content-script relay does **not** work on Next Experience, because
`chrome.tabs.sendMessage` is answered by frame 0 (the Polaris shell, which has no
`g_user`) while the classic form and its `g_user` live in a nested iframe — so
`hasAdmin` was always `null` exactly where most users work. The last commit on the
branch (`c2bf104`) switched to `chrome.scripting.executeScript` across **all** frames in
MAIN world, first definite answer wins, `true` preferred on a tie. Also worth keeping:
the gate is **UX, not security** — the instance's ACLs are the real authority, and its
only value is failing fast instead of showing a wall of 403s. None of it is reachable
from unit tests.