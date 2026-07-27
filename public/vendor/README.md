# Vendored third-party content

## `add-to-update-set-v9.5.xml`

The **Add to Update Set Utility**, version 9.5 — a community utility published on
ServiceNow Share. It is vendored verbatim, exactly as exported; nothing in this
repo modifies it.

snJava uses one part of it: the `addToUpdateSetUtils` Script Include, which forces
an otherwise-untracked record into the session's current update set. The Inspect
tab's "Add to update set" button calls it, and offers to install this export when
the instance does not already have the Script Include.

snJava calls `checkTable(record, tableName)` rather than the more obvious
`addToUpdateSet(record)`. `addToUpdateSet` is a UI Action wrapper: it reads
`gs.action.getGlideURI()` and `RP.getParameterValue(...)` to detect list context and
uses the client session to swap update sets, none of which exist in a background
script. `checkTable` is the dispatcher underneath it — it references none of those
globals, invokes the same related-record handlers, and its default branch falls
through to `saveRecord`, so ordinary records are still captured.

All 21 records are installed, so an instance ends up equivalent to a manual
update-set import: the Script Include, the "Add to Update Set" UI Action, the
summary-message Business Rule, the Preferences module, and 16 properties.

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
