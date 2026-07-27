# Inspect & Spec enhancements — design

Date: 2026-07-27
Status: approved in brainstorm, pending implementation plan

Five changes, four of them independent, one cross-cutting:

| # | Feature | Area |
|---|---------|------|
| 1 | Copy/paste a list condition across instances | Inspect → Condition Tester |
| 2 | Cover parent & child tables in a spec | Spec (F1) |
| 3 | Spec a whole application scope | Spec (F1) |
| 4 | Add open record(s) to the current update set | Inspect |
| 5 | Gate every feature on the `admin` role | cross-cutting |

Items 1–4 can ship in any order. Item 5 touches all panels and should land last so
it wraps finished surfaces rather than moving ones.

**Delivery:** each item gets its own implementation plan and its own branch. They
share no state and touch mostly disjoint files; bundling them into one plan would
make review harder without making the work shorter. Item 4 is the largest by a
wide margin — the bundled installer is most of it.

---

## 1. Condition copy/paste across instances

### Problem

Reproducing a list filter on another instance means retyping the encoded query by
hand. The condition builder gives no export, and the URL often does not carry the
filter at all — on Next Experience the top-tab URL is clean, and even in the
classic UI a filter applied after page load lives in `GlideList2`, not the URL.

### Solution

Two buttons in the Condition Tester card: **Copy condition** and **Paste**.
The clip lives in `chrome.storage.local` under `condClip`, mirroring how F3's
`xmlClip` already survives switching to a tab on a different instance
(`src/sidepanel/main.ts:470`).

### New module — `src/core/condition-clip.ts`

```ts
export interface ConditionClip {
  host: string
  table: string
  query: string
  /** sys_id → resolved display value, for sys_ids we could look up. */
  labels: Record<string, string>
  savedAt: string
}

/** Pull `field=<sys_id>` / `fieldIN<id>,<id>` pairs out of an encoded query. */
export function extractRefTokens(query: string): { field: string; sysId: string }[]

/** Human-readable warnings to show before pasting. */
export function clipWarnings(
  clip: ConditionClip,
  current: { host: string; table?: string },
): string[]
```

`extractRefTokens` matches 32-char lowercase hex tokens and pairs each with the
field name that precedes it in the same clause. A differing host is *not* a
warning — that is the point of the feature.

### Copy

Source, in priority order:

1. On a list view — `getListQueryFromPage(table)` (`main.ts:415`), which reads the
   live applied `GlideList2` filter. This is the only source that reflects a
   filter applied after page load.
2. The URL's `sysparm_query` via `currentListQuery()` (`main.ts:394`).
3. The Condition Tester textarea.

Label resolution: for each `{field, sysId}` from `extractRefTokens`, look up the
field's `reference` target in `sys_dictionary` for the clip's table (the schema
loader `getDictionary` already does this, and results are cached per table), then
issue one batched `sys_idIN…` query per referenced table with display values on.
Tokens that cannot be resolved are stored bare — no guessing.

### Paste

1. Fill the Condition Tester textarea with `clip.query`, **verbatim**. No
   rewriting of sys_ids, ever.
2. Render `clipWarnings()` above the results:
   - `Clip is for `incident`, this page is `sc_task`` (when tables differ)
   - one line per sys_id: `assigned_to = John Smith — sys_id may not exist here`,
     or `assigned_to = 9f2b… — could not resolve` when unlabelled.
3. Open `https://<current host>/<clip.table>_list.do?sysparm_query=<query>` in a
   new tab. `clip.table`, not the current page's table — the point is to carry an
   `incident` filter to another instance regardless of what page you are on.

Button state mirrors `xmlPaste`: label reads `Paste (incident)`, tooltip carries
origin host and `savedAt`.

### Tests

`src/core/condition-clip.test.ts` — token extraction (single, `IN` lists, tokens
inside string literals, no false positives on 32-char non-hex), field pairing
across `=`/`!=`/`IN`/`NOT IN`, and warning generation for table mismatch and
unresolved sys_ids.

Not unit-testable, needs the real-browser smoke pass: reading the live
`GlideList2` filter, and the cross-instance paste-and-navigate.

---

## 2. Spec: parent & child table coverage

### Problem

A spec for `incident` lists only artifacts whose `collection`/`table` is literally
`incident`. But a Business Rule on `task` genuinely fires on every incident, so
the spec understates what runs. Conversely, a change to `task` affects every child
table, and nothing surfaces that.

### Solution

An opt-in checkbox — **Include parent & child tables**, default **off**. Off keeps
today's behaviour exactly; on a base table like `task` the option multiplies the
artifact count, so it must be a deliberate choice.

### New module — `src/core/hierarchy.ts`

```ts
export interface TableHierarchy {
  /** Nearest ancestor first, e.g. ['task', 'sys_metadata']. */
  ancestors: string[]
  /** One level of direct children. */
  children: string[]
  /** True when children were capped; the count that was dropped. */
  childrenTruncated: number
}

export async function resolveHierarchy(
  table: string,
  fetch: (spec: FetchSpec) => Promise<Record<string, string>[]>,
): Promise<TableHierarchy>
```

Ancestors walk `sys_db_object.super_class` upward, capped at 10 hops with a
visited-set cycle guard. Children are one level: `super_class=<sysId of table>`,
capped at 20. When more than 20 children exist, `childrenTruncated` carries the
remainder and the checklist says so explicitly — never a silent truncation.

The fetch is injected, so the module stays pure and Node-testable.

### Integration

Deliberately minimal. When the option is on, `spec-runner.ts` seeds the ancestor
and child tables into the walk as depth-1 `table` artifacts. The existing
`resolveTable` resolver (`src/core/resolvers.ts:139`) then discovers their
Business Rules, Client Scripts, UI Policies, ACLs, Notifications and Data Policies
at depth 2. **No resolver changes are required.**

To keep them distinguishable, `ArtifactRef` gains one optional field:

```ts
origin?: 'self' | 'ancestor' | 'child'   // default 'self'
```

`resolveTable` suffixes its emitted `relation` accordingly — `Business Rule ↑ task`
for an ancestor, `Business Rule ↓ incident_task` for a child. The checklist and
spec sections already group by `relation` (`main.ts:2351`), so the grouping falls
out for free:

```
Business Rules
  incident (3)
  ↑ task (7)           inherited
  ↑ sys_metadata (1)   inherited
  ↓ incident_task (2)  child
```

After discovery, a hint line under the button states the resolved chain:
`3 tables: incident ↑ task ↑ sys_metadata`.

### Tests

`src/core/hierarchy.test.ts` with a stubbed fetch — a two-level chain, a table
with no parent, a cycle (must terminate), and child truncation reporting.

---

## 3. Spec: whole-scope mode

### Problem

The spec generator is anchored to one record or one table. "What is in this
application?" needs a per-record walk repeated by hand.

### Solution

A source selector at the top of the Spec card:

```
Source  (•) Current record / table   ( ) Application scope
        [ MFEC Onboarding                 ▾ ]
```

The scope input reuses the `#scope-list` datalist the scopebar already populates
(`main.ts:254`), and the existing name→sys_id map.

### New module — `src/core/scope-spec.ts`

```ts
/** Artifact tables swept for a scope spec, in presentation order. */
export const SCOPE_ARTIFACT_TABLES: ScopeSweepSpec[]

/** One FetchSpec per artifact table, each queried `sys_scope=<sysId>`. */
export function scopeFetchSpecs(scopeSysId: string): FetchSpec[]
```

Tables swept: `sys_db_object`, `sys_script`, `sys_script_client`,
`sys_script_include`, `sys_ui_policy`, `sys_security_acl`,
`sysevent_email_action`, `sys_data_policy2`, `sc_cat_item`, `sys_transform_map`,
`sys_ui_action`.

Depth 0 — a flat sweep, no graph walk. One pass, predictable size. It answers
"what is in this app", not "what does this app depend on".

Everything downstream is unchanged: the same checklist, the same `composeSpec`,
the same HTML/PDF/Word exporters. Only the document title differs —
*Application: MFEC Onboarding (x_mfec_onb)*.

The §2 hierarchy checkbox is disabled in scope mode; table hierarchy is not a
scope concept.

### Tests

`src/core/scope-spec.test.ts` — every emitted FetchSpec carries the right table,
`sys_scope=` query and a limit; the sweep list has no duplicates.

---

## 4. Add to current update set

### Problem

Forcing an untracked record into the current update set requires the
"Add to Update Set" UI Action from the ServiceNow Share utility, which is not
installed on every instance, and is a per-record trip through the form UI.

The originating snippet is that UI Action's script:

```js
new global.addToUpdateSetUtils().addToUpdateSet(current);
var url = GlideSession.get().getStack().bottom();
action.setRedirectURL(url);
```

`current` and `action` are UI Action bindings and do not exist in a background
script, so the extension runs the equivalent, and the redirect line is dropped —
it is UI Action plumbing with no meaning here.

### Solution

A button in the Inspect panel. On a record form it acts on the open record; on a
list view it acts on every record in the current filter, with the count in the
button label (`Add to update set (37)`) and in the confirm dialog — mirroring how
F3's Copy already behaves.

On a list view the sys_ids come from a `sys_id`-only Table API query using the
live applied filter — the same source §1 copies from (`getListQueryFromPage`,
falling back to the URL query). Above 200 records the confirm dialog states the
count prominently and requires a second click; there is no silent cap.

### Flow

1. `checkTarget()` (`main.ts:232`) pins the host and resolves scope + update set
   from the scopebar, before any dialog, so a tab switch cannot retarget the write.
2. Preflight: query `sys_script_include` for `name=addToUpdateSetUtils`.
   - Present → use it. Never modified, never overwritten. If the instance has the
     real Share utility, we call it and leave it alone.
   - Missing → the install dialog below, then continue in the same click.
3. Confirm: *Add N record(s) from `incident` to update set "DEV-1042" on
   mfecplcdemo10?*
4. Execute via the existing prod-guarded `runBackground` with the resolved update
   set, in batches of 50 to stay inside the `sys.scripts.do` timeout, reporting
   progress between batches:

```js
var tbl = '<table>', ids = [/* … */];
var util = new global.addToUpdateSetUtils();
var ok = 0, missing = 0;
for (var i = 0; i < ids.length; i++) {
  var gr = new GlideRecord(tbl);
  if (gr.get(ids[i])) { util.addToUpdateSet(gr); ok++; } else { missing++; }
}
gs.print('snJava: added ' + ok + ', missing ' + missing);
```

Output is parsed with the existing `extractBgOutput` + regex pattern used by
`createArtifactCore` (`main.ts:2989`).

This is a write. It is prod-guarded like every other write — refused in the REST
layer before any network I/O on a non-confirmed-sub-prod host.

### Installing the utility

The bundled source is the ServiceNow Share **Add to Update Set Utility v9.5**
export supplied by the user (`Add_to_Update_Set_Global_v9.5.xml`, 298 KB,
21 records). It is stored verbatim at `src/assets/vendor/add-to-update-set-v9.5.xml`
with an adjacent `README.md` naming the utility, its version and its origin —
the normal courtesy for redistributed Share content.

All 21 records are installed, so the instance ends up equivalent to a manual
update-set import: the Script Include, the "Add to Update Set" UI Action, the
summary-message Business Rule, the app module, 8 system properties and 8 category
properties.

New module `src/core/updateset-xml.ts`:

```ts
export interface UpdateRecord {
  type: string        // 'Script Include', 'System Property', …
  targetName: string
  table: string       // sys_script_include, sys_properties, …
  sysId: string
  fields: Record<string, string>
}

/** Parse an update-set export: <unload> → sys_update_xml[] → decoded payload. */
export function parseUpdateSetXml(text: string): UpdateRecord[]
```

This is a different shape from F3's unload XML — each `sys_update_xml.payload` is
an escaped `<record_update>` document that must be unescaped and parsed a second
time — so it is a sibling of `src/core/xml.ts`, reusing its field-extraction
helpers rather than extending its parser.

Install is one prod-guarded `runBackground` per record, preserving the original
`sys_id` so a later real update-set import reconciles rather than duplicating:

```js
var gr = new GlideRecord(table);
if (gr.get(sysId)) { /* setValues */ gr.update(); }
else { /* setValues */ gr.setNewGuid(sysId); gr.insert(); }
```

**Field values are base64-encoded in the generated script and decoded with
`GlideStringUtil.base64Decode()`.** The Script Include body is 212 KB of
JavaScript containing quotes, backslashes and newlines; embedding it as a JS
string literal is a correctness hazard, and base64 removes the entire class of
escaping bugs.

Dialog:

```
addToUpdateSetUtils not found on mfecplcdemo10.

Install Add to Update Set Utility v9.5?
  21 records · Script Include, UI Action, Business Rule,
  Module, 16 properties
  Into update set "DEV-1042"
  ▸ view record list

     [ Cancel ]  [ Install & continue ]
```

Naming: the Script Include keeps the exact name `addToUpdateSetUtils` — it is the
API identifier the UI Action calls, not a display label. No `[MF-AI]` prefix, same
carve-out reasoning as `sys_dictionary` / `sys_db_object` in
`src/core/naming.ts:19`. Every installed record gets an `[MF-AI]` marker in its
`description` instead, where one exists.

### Tests

`src/core/updateset-xml.test.ts` against a trimmed fixture of the real file —
record count and types, payload unescaping, sys_id preservation, a payload
containing nested CDATA and quotes. The 212 KB round-trip through base64 in a live
background script is a smoke-test item, not a unit test.

---

## 5. Admin-role gate

### Requirement

Every feature runs only when the logged-in user holds `admin`.

### Honest framing

This gate is **UX, not security**. The instance's own ACLs are the real authority
and will reject anything the user is not entitled to, with or without this check.
Its value is failing fast with a clear message instead of a wall of 403s.

### New module — `src/core/admin-gate.ts`

```ts
export type RoleState = 'admin' | 'not-admin' | 'unknown'

export interface RoleStatus {
  state: RoleState
  userName?: string
  roles?: string[]
}

export interface GateVerdict {
  allowed: boolean
  banner: 'none' | 'blocked' | 'unverified'
  message?: string
}

export function evaluateGate(status: RoleStatus): GateVerdict
```

- `admin` → `{ allowed: true, banner: 'none' }`
- `not-admin` → `{ allowed: false, banner: 'blocked' }`
- `unknown` → `{ allowed: true, banner: 'unverified' }`

### Detection

Extend the MAIN-world bridge (`src/content/mainworld.ts`), which already reads
`g_form` and `g_ck`, to also snapshot `g_user`:

```ts
g_user?: {
  hasRole?: (r: string) => boolean
  userName?: string
  roles?: string
}
```

`g_user.hasRole('admin')` is authoritative for the *effective* user, so
impersonation is honoured — impersonating a non-admin correctly blocks the
extension. `g_user.roles` populates the banner's role list.

When `g_user` is absent — a Next Experience page, a non-form page, a page where
the bridge could not inject — the state is `unknown`.

### Enforcement

**Blocked** (`not-admin`): a banner replaces the panel bodies and every action
button is disabled.

```
⚠ snJava requires the admin role

  Signed in as: j.somchai
  Instance: mfecplcdemo10
  Roles detected: itil, catalog_admin

  All features are disabled.
```

**Unverified** (`unknown`): features stay usable behind a persistent amber banner
— *Role unverified — the instance will still enforce its own ACLs.* Failing open
here is deliberate: a detection gap must not brick the extension, and the platform
remains the real gate.

A single `applyGate()` in `main.ts`, called after every context refresh, sets
`document.body.dataset.gate` and toggles button state. Panel-level CSS keys off
that attribute, so no per-feature enforcement code is scattered around.

### Tests

`src/core/admin-gate.test.ts` — the three states map to the right verdicts, and
the blocked message renders user, host and roles. Live `g_user` reads and the
impersonation path are smoke-test items.

---

## Files

| Action | Path |
|--------|------|
| New | `src/core/condition-clip.ts` + `.test.ts` |
| New | `src/core/hierarchy.ts` + `.test.ts` |
| New | `src/core/scope-spec.ts` + `.test.ts` |
| New | `src/core/updateset-xml.ts` + `.test.ts` |
| New | `src/core/admin-gate.ts` + `.test.ts` |
| New | `src/assets/vendor/add-to-update-set-v9.5.xml` + `README.md` |
| Edit | `src/core/graph.ts` — `origin?` on `ArtifactRef` |
| Edit | `src/core/resolvers.ts` — relation suffix by origin |
| Edit | `src/core/spec-runner.ts` — seed hierarchy tables; scope sweep runner |
| Edit | `src/core/spec.ts` — scope document title |
| Edit | `src/content/mainworld.ts` — `g_user` snapshot |
| Edit | `src/sidepanel/index.html` — buttons, checkbox, source selector, banner |
| Edit | `src/sidepanel/styles.css` — banner, gate states |
| Edit | `src/sidepanel/main.ts` — wiring only |
| Edit | `README.md` — tabs section, admin requirement |

`src/sidepanel/main.ts` is already 3233 lines. All new logic goes in `src/core/`
so it gains roughly 200 lines of thin wiring rather than absorbing five features.
A wider decomposition of that file is worth doing but is out of scope here.

## Not covered by unit tests

These need the real-browser smoke pass README already tracks:

- Reading the live `GlideList2` filter on a list view
- Cross-instance condition paste and navigate
- The scope sweep against a real application
- Add-to-update-set on a single record and on a filtered list
- Installing all 21 records, including the 212 KB base64 Script Include payload
- The `g_user` read on classic UI vs Next Experience, and under impersonation
