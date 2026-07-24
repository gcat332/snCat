# Project Handoff: ServiceNow AI Assistant — Chrome Extension

> Handoff date: 2026-07-24
> Origin: Design discussion in Claude.ai (Gust @ MFEC)
> Target: Continue implementation in Claude Code

---

## 1. What we are building

A single Chrome Extension (Manifest V3) with a shared core engine and two user-facing features:

| # | Feature | One-liner |
|---|---------|-----------|
| F1 | **Design Spec Generator** | On any ServiceNow record page, generate a Design Spec as PDF / Word / HTML, styled with the MFEC brand theme |
| F2 | **Script Tester** | Test Business Rules / Client Scripts through a 3-layer approach: static AI review → sandbox simulation with real data → guarded real execution |
| F3 | **XML Mover** | On a record or list page, **Copy XML** (ServiceNow unload XML); on another instance, **Paste XML → Import** to recreate the record(s). Cross-instance record transfer without update sets. *(Design pending — see §9.)* |

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
6. **Start order:** Script Tester Layers 1+2 first — the Glide mock layer is the highest-risk component of the whole project; prove it early. F1 second.

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

### Layer 2 — Sandbox Simulation (the core of this feature; highest technical risk)
- Execute the script inside the extension's JS sandbox with **mocked Glide APIs**: `current`, `previous`, `gs`, `GlideRecord`, `g_form`, `g_user`.
- **Seed mocks with real data**: fetch a real record read-only via Table API into `current`; user edits field values to simulate before/after (`previous` vs `current`).
- Output = execution trace: fields set, `gs.addErrorMessage/addInfoMessage` calls, `setAbortAction`, mock `GlideRecord` queries issued (and optionally resolve those queries read-only against the instance for realistic results).
- **Zero writes to the instance. Ever.**
- **Known limitation to surface in UI:** ServiceNow server-side = Rhino (ES5 semantics); sandbox = V8. Label results as *simulation*, not ground truth.
- MV3 note: no `eval` in extension pages under default CSP → run user script in a **sandboxed iframe** (`"sandbox"` key in manifest) or an offscreen document; communicate via `postMessage`.

### Layer 3 — Real Execution (guarded)
- **Client Script:** inject into the real form on sub-prod, drive a chosen scenario (set field X), capture all `g_form` calls → this runs on the real engine, high fidelity.
- **Business Rule:** create a real test record on sub-prod → read outcome (changed fields, work notes, `sys_audit`) → delete the record. Alternative/preferred where ATF is adopted: generate an ATF test and run it via API (aligns with the existing `itsm-deploy` ATF regression work; leaves a reusable regression asset).
- **Hard prod guard** (decision #5 above).

### Condition Tester (cheap, high value — build alongside Layer 1)
Before testing the script, test the BR condition/filter itself: run the encoded query via Table API and show which records match. Many "bugs" are mis-triggering conditions, not script logic.

---

## 5. Proposed architecture (MV3)

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

- Auth: reuse the browser session (cookies) for same-origin REST calls from the content script, or `host_permissions` + fetch from the service worker with credentials. Also need `X-UserToken` (`g_ck`) for some endpoints — content script can read `window.g_ck` on classic UI pages (needs main-world script injection).
- Detect context on both **classic UI** (`/nav_to.do`, `/<table>.do?sys_id=`) and **Next Experience/polaris** URLs (`/now/nav/ui/classic/params/target/...`) — parsing differs.

## 6. Suggested milestones

1. **M0 — Skeleton:** MV3 scaffold, side panel opens, content script correctly reports table + sys_id on both classic and polaris UIs.
2. **M1 — API core:** REST client with session auth; fetch record + `sys_dictionary` schema; Condition Tester working end-to-end.
3. **M2 — Tester L1:** AI static review with intent input + anti-pattern lints.
4. **M3 — Tester L2:** sandboxed iframe execution, Glide mocks (`current`/`previous`/`gs` first, `GlideRecord` read-through second), execution trace UI. ← highest risk, longest
5. **M4 — F1 MVP:** graph walker (depth 2, Catalog Item + Business Rule resolvers first), artifact checklist, AI spec composition, reveal.js output with MFEC theme.
6. **M5 — Tester L3:** client-script live capture; BR test-record flow or ATF generation; prod guard.

## 7. Resolved decisions (2026-07-24, Claude Code session)

The section-7 open questions were resolved as follows:

1. **Sandbox scope — Global + scoped from day one.** Glide mocks support both global-scope (`current`, `previous`, `gs`, `GlideRecord`, `g_form`, `g_user`) and scoped-app semantics (`GlideRecordSecure`, scoped `gs`, ACL-aware reads) from the start.
2. **LLM endpoint — build LLM-free first; LLM is a pluggable enhancement layer.** The `llm/` module is a provider interface whose **default provider is `none` (deterministic)**. F1 spec composition uses a **template** that structures fetched artifacts into the skeleton with no prose generation; Layer 1 ships **rule-based anti-pattern lints only**. The LLM-powered parts (Layer 1 "logic vs. intent" review, F1 prose polish) are optional and added later. Consequence: no customer script/record content leaves the instance during early dev, so the redaction + proxy-vs-direct-API decision is **deferred, not blocking**. Reversible: picking proxy vs. direct later = one provider implementation behind the existing interface.
3. **Dev instance — an MFEC sub-prod with representative ITSM data.** Dev/test hostname: **`mfecplcdemo10.service-now.com`**. For real use the extension must work on **any** instance by reading the **active tab's URL dynamically** (no hardcoded instance). Impl: `host_permissions: ["https://*.service-now.com/*"]` covers standard instances; vanity-domain instances handled later via `optional_host_permissions` requested on demand. Feeds prod-guard sub-prod pattern config in decision #5, section 2.
4. **F1 resolver priority (after Catalog Item + Business Rule) — Script Include, ACL, Transform Map.** Flow/Workflow deprioritized (build after these three).
5. **reveal.js PDF export — yes.** Include reveal.js print/PDF CSS in the theme so the self-contained HTML exports cleanly to PDF (print-to-PDF).

### 7a. Feature revisions (2026-07-24, Claude Code session)

- **F1 output — PDF + Word `.docx` + HTML (was: reveal.js HTML only).** All three from one **light** document theme (white page, MFEC colors as accents) **with the MFEC logo**. Dark slide theme dropped for this deliverable. See §3a/§3b. Needs the `docx` JS library and the logo asset (§8).
- **F2 run UX — "3 + 1": inline iframe in the side panel + pop-out full-page runner.** Clicking Run executes the user script in a **sandboxed iframe embedded in the side panel** (fast, in-context). A **pop-out button** opens the same sandbox in a **dedicated full-page runner tab** (`runner/`) for more room / long execution traces. `background/` acts only as the broker that ships `{script, context}` into whichever host — it never executes user script itself (MV3: SW has no DOM + CSP blocks `eval`).

## 8. Reference notes

- Brand tokens sourced from `MFEC_Company_Profile_2026_version_1.pptx` — theme1.xml accents + frequency analysis of slide XML + visual render. Keep the PPTX for future re-extraction if branding updates.
- **MFEC logo assets — extracted** from the PPTX (`ppt/media/`) into `public/brand/`: `mfec-logo-dark.png` (dark wordmark for white pages), `mfec-logo-light.png` (white wordmark for gradient cover band). Extension icons in `public/icons/` from the square arrow mark. The `.pptx` itself is **git-ignored** (43 MB) but kept locally for re-extraction.
- **Stack chosen: TypeScript + Vite + `@crxjs/vite-plugin`** (MV3, HMR, side panel support). Vitest for the context-parser unit tests.
- Related prior work by Gust that connects here: `itsm-deploy` ATF regression gates (Layer 3), Chesterton's Fence refactoring framing (Impact Analysis future feature), reasoning-trace skill (could drive the graph-walk audit trail).

---

## 9. Feature F3 — XML Mover (design pending, added 2026-07-24)

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

### Open questions (resolve before building F3)
1. **sys_id policy on import:** preserve original sys_id (true clone, risks collision/overwrite) vs. let target generate a new one (safe copy, breaks inbound references)?
2. **References & related lists:** copy referenced records too (depth-limited, reuse the F1 graph walker) or leave dangling references?
3. **Scope of "list copy":** hard cap (e.g. 50 records) + explicit user confirm; how to surface truncation.
4. **Prod guard:** importing writes to the target — reuse F2's hard prod-guard so imports into prod are blocked/confirmed.
5. **Conflict handling:** target already has a record with that sys_id/unique key → skip / update / duplicate?
6. **Clipboard vs. in-extension store:** raw XML on the system clipboard (portable, user can inspect) vs. structured store in `chrome.storage` (safer, richer metadata). Likely both: store + optional clipboard copy.

**Reuse:** F3 shares the M1 REST client (fetch), the context detector (record vs list), and the F2 prod-guard. This is exactly the "cheap to add" payoff of the core-engine architecture (§1).