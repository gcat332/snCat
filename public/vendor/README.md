# Vendored third-party content

## `add-to-update-set-v9.5.xml`

The **Add to Update Set Utility**, version 9.5 — a community utility published on
ServiceNow Share. It is vendored verbatim, exactly as exported; nothing in this
repo modifies it.

### Attribution and license — READ BEFORE REDISTRIBUTING

This is ~298 KB of third-party code committed to this repo and shipped inside the
extension, so its provenance is recorded here as precisely as the export allows:

| | |
|---|---|
| **Name / version** | Add to Update Set Utility, v9.5 |
| **Share listing** | <https://developer.servicenow.com/app.do#!/share/contents/9824957_add_to_update_set_utility> — this URL is not guesswork: it is embedded in the export itself, in the `title` field of the `Add to Update Set Preferences` module record |
| **Attributed to** | `ben.hollifield`, on the audit fields only — `sys_updated_by` on the Script Include and on 11 of the 21 records; `sys_created_by` on 4 of the 21. The remaining records say `admin`, an instance-local account name rather than a person. |
| **Dates in the export** | Script Include created `2018-10-24`, last updated `2026-05-20`, `sys_mod_count` 379 |
| **License** | **NOT RECORDED — see below.** |

**The export contains no license, copyright or author header of any kind.** The
210 KB Script Include body has no such comment block, no record carries a license
field, and there is no `LICENSE` file (an update-set XML cannot carry one). The
"attributed to" row above is therefore *inferred from audit metadata* — who last
touched the record on the originating instance — which is not a formal authorship or
licensing statement and should not be quoted as one.

Consequently: **confirm the author and the license terms on the Share listing above
before distributing snJava outside this organisation.** ServiceNow Share submissions
each carry a license chosen by their publisher; it is not implied by being on Share
and cannot be recovered from the XML. Do not assume permissive terms. If snJava is
ever published externally and the terms cannot be confirmed, the alternative is to
drop this vendored file and require the user to install the utility themselves —
snJava already works against an instance that has it, and never overwrites it.

snJava uses one part of it: the `addToUpdateSetUtils` Script Include, which forces
an otherwise-untracked record into the session's current update set. The Inspect
tab's "Add to update set" button calls it, and offers to install this export when
the instance does not already have the Script Include.

snJava calls `checkTable(record, tableName)` rather than the more obvious
`addToUpdateSet(record)`. `addToUpdateSet` is a UI Action wrapper: it reads
`gs.action.getGlideURI()` and `RP.getParameterValue(...)` to detect list context, and
finishes with `gs.addInfoMessage`/`gs.flushMessages`, none of which exist in a
background script. `checkTable` is the dispatcher underneath it — it references
neither of those globals, invokes the same related-record handlers, and its default
branch falls through to `saveRecord`, so ordinary records are still captured.

`checkTable` does **not** avoid the client session: `saveRecord`, `_checkSetScope` and
`_addErrorMessage` beneath it all use `clientSession.getClientData/putClientData`
(`clientSession = gs.getSession()`). That works in `sys.scripts.do` because a session
exists there, and snJava depends on it — it reads the `errorMessages` /
`warningMessages` session keys back to recover the utility's own refusal reasons. It
also reproduces three things the wrapper does that `checkTable` alone does not: a
per-record try/catch (`checkTable` throws), restoring the session's original update
set (`_checkSetScope` can switch it), and seeding those message keys before the run.

All 21 records are installed, so an instance ends up equivalent to a manual
update-set import:

| Records | Table | What it is |
|---|---|---|
| 1 | `sys_script_include` | `global.addToUpdateSetUtils` — the only part snJava calls |
| 1 | `sys_ui_action` | the "Add to Update Set" UI Action (form/list button) |
| 1 | `sys_script` | the "Add to Update Set Display Summary Msg" Business Rule |
| 1 | `sys_app_module` | the "Add to Update Set Preferences" module |
| 8 | `sys_properties` | the `addToUpdateSetUtils.*` settings |
| 8 | `sys_properties_category_m2m` | each property's membership of the category below |
| 1 | `sys_properties_category` | the `addToUpdateSetUtils` property category |

That is **8 properties**, not 16: the other 8 property-shaped records are
category-membership join rows, and 1 more is the category itself. The counts are
pinned by a test in `src/core/updateset-xml.test.ts`.

**An existing `addToUpdateSetUtils` on the instance is never overwritten.** If
the real Share utility is already there, snJava calls it and leaves it alone.

## Where this file lives, and why

This directory is under `public/`, not `src/`. Vite's `public/` directory is
copied verbatim to the build output root (prefix stripped) with no processing —
that is what makes `chrome.runtime.getURL('vendor/add-to-update-set-v9.5.xml')`
resolve at runtime. `src/assets/` is not copied to `dist/` unless something
actually imports the file as a module; a plain on-disk copy under `src/` would
build successfully but 404 at runtime with nothing pointing that out. This
project's existing `public/brand/*.png` logos use the same mechanism.
