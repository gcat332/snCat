# Project Handoff: ServiceNow AI Assistant — Chrome Extension

> Handoff date: 2026-07-24
> Origin: Design discussion in Claude.ai (Gust @ MFEC)
> Target: Continue implementation in Claude Code

---

## 1. What we are building

A single Chrome Extension (Manifest V3) with a shared core engine and two user-facing features:

| # | Feature | One-liner |
|---|---------|-----------|
| F1 | **Design Spec Generator** | On any ServiceNow record page, generate a Design Spec presentation as a self-contained reveal.js HTML file, styled with the MFEC brand theme |
| F2 | **Script Tester** | Test Business Rules / Client Scripts through a 3-layer approach: static AI review → sandbox simulation with real data → guarded real execution |

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
5. Output = single self-contained `reveal.js` HTML file (all CSS inline, fonts via Google Fonts link), downloadable.

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

**reveal.js theme rules:**
- Title/section slides: `--mfec-gradient` background, white Prompt Medium headings, cyan accent line usage sparingly
- Content slides: dark navy background, translucent white cards (`rgba(255,255,255,0.06)` + 1px `rgba(255,255,255,0.15)` border), cyan `#00A2E9` for emphasis/inline code accents
- Diagrams (Mermaid if used): dark theme, edge color cyan, node fill `#0031B4`

Hardcode this theme into the extension as a CSS template — the PPTX does not need to ship with the project.

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
├── sidepanel/               # UI (artifact checklist, tester UI, results)
├── sandbox/                 # sandboxed iframe: Glide mock runtime + script executor
│   └── glide-mocks/         # current/previous/gs/GlideRecord/g_form implementations
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

## 7. Open questions (carry into Claude Code)

1. Sandbox scope: global-scope Glide API first, or also scoped-app (`GlideRecordSecure`, scoped `gs`) from day one? *(Lean: global first, design mocks with scope in mind.)*
2. LLM endpoint: Anthropic API direct with org key, or an internal MFEC proxy? Affects redaction requirements.
3. Which instance(s) to develop against — is there a stable sub-prod with representative ITSM data?
4. F1 artifact resolvers: which record types to prioritize after Catalog Item + Business Rule? (Flow, Script Include, ACL, Transform Map?)
5. Does reveal.js output need PDF export (reveal print CSS) as well?

## 8. Reference notes

- Brand tokens sourced from `MFEC_Company_Profile_2026_version_1.pptx` — theme1.xml accents + frequency analysis of slide XML + visual render. Keep the PPTX for future re-extraction if branding updates.
- Related prior work by Gust that connects here: `itsm-deploy` ATF regression gates (Layer 3), Chesterton's Fence refactoring framing (Impact Analysis future feature), reasoning-trace skill (could drive the graph-walk audit trail).