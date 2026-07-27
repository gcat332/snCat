# snJava — ServiceNow Java Assistant (Chrome Extension, MV3)

A Chrome side-panel extension that assists ServiceNow development. It reads the
record you're on and works through the ServiceNow REST API, all styled in the
MFEC light theme.

Three features plus an optional AI layer:

- **F1 — Design Spec Generator** (Spec tab): walk a record's related artifacts and export a Design Spec as **HTML / PDF / Word `.docx`**.
- **F2 — Script Tester** (Tester tab): 3 layers — static lint (Layer 1) → prod-guarded background-script run "bgrun" (Layer 2) → guarded real create/read/delete (Layer 3) — for Business Rules / Client Scripts / Script Includes.
- **F3 — XML Mover** (Inspect tab): copy a record's unload XML on one instance and paste-import it into another, with an undo log.
- **AI Generate** (Generate tab): turn a requirement into a plan of ServiceNow artifacts and create the dev/admin-facing ones on a sub-prod. Requires an LLM endpoint (see [Configure](#configure-first-run)).

**New here?** Start with the 5-minute [Onboarding guide](./docs/ONBOARDING.md) (install → configure → first use, with screenshots).

See [`handoff.md`](./handoff.md) for the full design, decisions, and milestones, and [`CLAUDE.md`](./CLAUDE.md) for the architecture guide.

## Stack

TypeScript · Vite · [`@crxjs/vite-plugin`](https://crxjs.dev) (MV3) · Vitest

## Install & use

This extension is not on the Chrome Web Store — load it yourself.

### On your machine (Load unpacked)

```bash
npm install          # first time only
npm run build        # produces dist/
```

1. Open `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → select the `dist/` folder.
3. Open a ServiceNow page (dev instance: `mfecplcdemo10.service-now.com`) and click the **snJava** toolbar icon — the side panel opens and reports the current **table + sys_id**.

To update later: `git pull && npm run build`, then click ↻ on the extension card in `chrome://extensions`.

### Share with the team

- **Quick:** zip the `dist/` folder and have teammates Load unpacked (steps 1–3 above).
- **Managed:** publish to the [Chrome Web Store](https://chrome.google.com/webstore/devconsole) as **Unlisted/Private** for the org — this also gives everyone auto-updates.

## Configure (first run)

Open the side panel → **Settings** tab.

- **LLM endpoint** — the AI features (Java review, Generate, AI spec overview) stay hidden until an **Endpoint URL + key** are set. Supported formats: `anthropic`, `openai`, and MFEC **AgentHub** (`dev-agenthub.mfec.co.th`). Script bodies are redacted before being sent. Without config, non-AI features work and AI features report `configured: false` instead of failing.
- **Prod guard** — all writes (Tester Layer 3, Generate "create", XML paste) are **default-DENY**: allowed only on confirmed sub-prod hostnames (`dev`/`test`/`uat`/`sandbox`/`demo`/…), and an explicit production marker hard-blocks even if a sub-prod marker is also present. Adjust the sub-prod patterns here if your instance uses a non-standard hostname.

## Tabs

| Tab | Feature | What it does |
|---|---|---|
| **Inspect** | Context + F3 | Shows table/sys_id/scope; **Copy / Paste** record unload XML across instances with undo; open records/lists. |
| **Tester** | F2 | Load a script (from a record, paste, or the on-page **javaHelp** chip), lint it (Layer 1), run it prod-guarded (Layer 2), and do a guarded real create/delete against a sub-prod (Layer 3). |
| **Generate** | AI | Requirement → plan of artifacts → create the creatable ones on a sub-prod (scope-aware). |
| **Spec** | F1 | Discover related artifacts → include/exclude checklist → export HTML / PDF / Word. Options: include parent/child tables, or set Source to an application scope to spec a whole app instead of one record/table. |
| **Settings** | — | LLM endpoint + prod-guard configuration. |

### Copy/paste condition (cross-instance)

On a list view, *Copy condition* grabs the filter that is actually applied — read
from `GlideList2`, so a filter set after page load is captured too — together with
display labels for any reference sys_ids in it. On another instance, *Paste* fills
the query, lists every sys_id it depends on as a warning, and opens the matching
list there. The query is pasted verbatim; sys_ids are never rewritten, because a
name match on the target is not proof of the same record.

### Add to update set

Forces the open record — or every record in the current list filter — into the
update set selected in the header, using the Add to Update Set Utility's
`addToUpdateSetUtils` Script Include. Prod-guarded like every other write, and always
run in the **global** scope (the utility's APIs are global-only). If the instance does
not have the Script Include — detected by `api_name=global.addToUpdateSetUtils`, not
by name, since scoped Script Includes of the same name legitimately exist — snJava
offers to install the vendored v9.5 export (21 records, global scope, see
`public/vendor/README.md`) and then continues; an existing `addToUpdateSetUtils` is
never overwritten. Records are processed 50 per background run, at most 10,000 per
add, and more than 200 requires a second confirmation.

The run reports four numbers: **seen** (records handed to the utility without
throwing), **missing** (sys_ids with no record), **errors** (records that threw and
were skipped — the rest of the batch is still committed), and **captured** (actual
`sys_update_xml` rows added to the selected update set). `captured` legitimately
differs from `seen` in both directions — one record can pull in related records,
raising it; re-adding a record already in the set REPLACES its existing row rather
than adding one, lowering it — so they are kept separate rather than collapsed into a
single figure, and the panel does not guess at the cause. When the utility refuses a
record it records a reason, and snJava reads those reasons back out of the session and
shows them verbatim instead of inventing an explanation.

Two side effects come from the utility itself and are disclosed on the confirm
dialog: when a record's scope differs from the update set's, it can **create** a
`… - Batch Parent` update set and **rename** the selected set to `… - Batch Child`.
snJava restores the session's original update set after every run.

### javaHelp chip

On a ServiceNow form with a script field, snJava injects a small **javaHelp** chip next to the field label. Clicking it opens the side panel, loads the script into the Tester tab, and sets the Script kind — so you can add the problem and run **Java review** immediately.

### `[MF-AI]` naming convention

When the **Generate** tab creates a dev/admin-facing config record (Business Rule, Client Script, Script Include, Fix Script, UI Policy, UI Action, notification, …), its display name is prefixed with `[MF-AI][<CODE>] `, where `<CODE>` is a short module code derived from the target table (`incident` → `INC`, `change_request` → `CHG`, …). **Not** applied to Field / Table / ACL (structural names), Choice (user-facing labels), or business data. See `src/core/naming.ts`.

### Include parent & child tables (Spec tab)

A checkbox on the Spec tab, only meaningful when Source is "Current record / table". Walks `sys_db_object.super_class` upward and one level of children downward to discover related artifacts from parent and child tables too. Inherited rows are marked `↑ task`, child rows `↓ incident_task` — ancestors matter most, since a Business Rule on `task` genuinely fires on every incident. Off by default because on a base table this multiplies the artifact count; children are capped at 20 and the hint states how many were dropped.

### Application scope (Spec tab)

A Spec-tab Source option — distinct from the scope/update-set bar at the top of the panel, which targets writes. Instead of one record or table, sweep every artifact whose `sys_scope` is the selected app — tables, Business Rules, Client Scripts, Script Includes, UI Policies, UI Actions, ACLs, notifications, data policies, catalog items and transform maps. A flat sweep, no dependency walk, so it answers "what is in this app" and does **not** pull in artifacts the app depends on that live outside the scope. The Table API section is omitted, since an application spans many tables. A table that fails to read or hits its row limit is named in a hint rather than silently read as empty, and sweeping the Global application is refused — it is not what this mode is for.

## Scripts

| Command | What |
|---|---|
| `npm run dev` | Vite dev server (HMR), port 5199 |
| `npm run build` | Typecheck + production build to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run Vitest unit tests |
| `npx vitest run src/core/lint.test.ts` | Run a single test file |

## Status

Milestones **M0–M5** and **F3** are complete; the AI layer (Java review, Generate, spec narrative) is implemented and gated on configuration. See `handoff.md` for the milestone log.

Unit tests cover **pure logic only**, all in `src/core/`. Live I/O can only be confirmed by loading `dist/` in Chrome against a real instance:

> ⚠️ **Needs a real-browser smoke test:** session/`g_ck` auth · Layer 2 bgrun round-trip (`sys.scripts.do`) · Layer 3 create/delete on a sub-prod · Generate artifact creation + `[MF-AI]` prefix · javaHelp chip injection · F1 resolver table/field names per instance version.

## Layout

```
src/
├── manifest.config.ts   # MV3 manifest (@crxjs defineManifest)
├── background/          # service worker: opens the panel, brokers messages, runs LLM jobs per tab
├── content/             # index.ts (isolated world) + mainworld.ts (g_form/g_ck bridge + javaHelp chip)
├── core/                # pure, unit-tested modules (no chrome.* except api-client.ts):
│                        #   context · api · sn-rest · lint · prod-guard · graph · resolvers ·
│                        #   spec · render-html · render-docx · llm · xml · f3-import · naming · diff
└── sidepanel/           # side panel UI (main.ts + index.html + styles.css), MFEC light theme
public/
├── brand/               # MFEC logos
└── icons/               # extension icons
```
