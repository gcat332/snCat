/**
 * Forces records into the session's current update set via the Add to Update Set
 * Utility's Script Include.
 *
 * The originating snippet is that utility's UI ACTION script:
 *   new global.addToUpdateSetUtils().addToUpdateSet(current);
 *   action.setRedirectURL(GlideSession.get().getStack().bottom());
 * Neither `current` nor `action` exists in a background script, so this module
 * builds the equivalent — an explicit GlideRecord per sys_id — and drops the
 * redirect, which is UI Action plumbing with no meaning outside a form.
 *
 * IMPORTANT — we call `checkTable(gr, tableName)`, NOT `addToUpdateSet(gr)`.
 * Verified against the vendored v9.5 source: `addToUpdateSet` is a UI WRAPPER whose
 * only real work is delegated to `checkTable`. Around that it uses
 * `gs.action.getGlideURI().getMap()` and `RP.getParameterValue('sysparm_checked_items')`
 * — the file's only uses of `gs.action` and `RP` — plus `gs.addInfoMessage`/
 * `gs.flushMessages` for user feedback. None of that exists in `sys.scripts.do`, so
 * calling it there throws per record.
 *
 * `checkTable` contains zero references to `gs.action` or `RP.`. It is the
 * dispatcher: a switch over table names invoking ~65 `_addXxx` related-record
 * handlers (attachments, variables, workflows, catalog items, ACL and UI-policy
 * dependencies, …), and its `default:` arm falls through to `_executeScopeScript()`
 * and `saveRecord(gr)`, so an ordinary record such as an incident is still captured.
 *
 * It does NOT avoid `clientSession`. That claim used to be made here and was wrong:
 * `saveRecord` — reached from `checkTable`'s `default:` arm — and `_checkSetScope`
 * and `_addErrorMessage` below it all use `clientSession.getClientData` /
 * `putClientData`. This works, because `clientSession = gs.getSession()` and a
 * session exists in `sys.scripts.do`; it is a live dependency we rely on rather
 * than one we avoid, and the script below reads those same session keys back to
 * recover the utility's own refusal reasons. The narrow, accurate statement is:
 * `checkTable` avoids the two globals that only exist inside a UI Action
 * (`gs.action`, `RP`) and the two calls that only make sense in a page response
 * (`gs.addInfoMessage`, `gs.flushMessages`).
 *
 * Three behaviours of the wrapper we bypass have to be reproduced here, or the run
 * is either unsafe or silently wrong. All three are implemented in
 * `buildAddToUpdateSetScript`:
 *  1. It wraps its `checkTable` call in try/catch. `checkTable` genuinely throws —
 *     `_getTableBase` calls `new global.TableUtils(tableName)` unguarded, the ~65
 *     `_addXxx` handlers are unguarded, and `GlideUpdateManager2.saveRecord` can
 *     throw. Without a per-record catch, record 23 of a 50-record batch aborts the
 *     run *after* records 1–22 have already been committed as individual DB writes.
 *  2. It restores the session's original update set afterwards. `_checkSetScope`
 *     does far more than validate: on a scope mismatch it INSERTS a
 *     "<name> - Batch Parent" update set, RENAMES the user's selected set to
 *     "<name> - Batch Child", updates it, and calls `updateSetAPI.set(newSetID)`.
 *     `sys.scripts.do` runs in the user's own session, so skipping the restore
 *     leaves their browser pointed at an auto-created child set.
 *  3. It seeds and then reads back the `errorMessages` / `warningMessages` session
 *     keys, which is where the utility records *why* it refused a record. Nothing
 *     else reports that: `checkTable` and `saveRecord` both return bare `undefined`
 *     on refusal.
 */

/** Records per background run, keeping each run inside the sys.scripts.do timeout. */
export const ADD_BATCH_SIZE = 50
/** Above this, the confirm dialog demands a second explicit click. */
export const BULK_CONFIRM_THRESHOLD = 200

const TABLE_RE = /^[a-z0-9_]+$/i
const SYS_ID_RE = /^[0-9a-f]{32}$/i

/**
 * The table name and sys_ids are interpolated into executable server-side code,
 * so they are validated as strict identifiers rather than escaped. Anything that
 * is not a plain table name or a 32-hex sys_id is a bug or an injection attempt;
 * either way it must not reach the instance.
 */
export function buildAddToUpdateSetScript(table: string, sysIds: string[]): string {
  if (!TABLE_RE.test(table)) throw new Error(`Refusing to run: invalid table name "${table}"`)
  for (const id of sysIds) {
    if (!SYS_ID_RE.test(id)) throw new Error(`Refusing to run: invalid sys_id "${id}"`)
  }

  // Wrapped in an IIFE so the Default-update-set check can `return` early; a bare
  // `return` at the top level of a background script is not reliably legal.
  //
  // `captured` is MEASURED as the delta in sys_update_xml rows, because neither
  // checkTable nor saveRecord reports success: both return bare `undefined` on
  // refusal. The delta is measured against the ORIGINAL set id, so a run that
  // triggers the utility's scope batching (see `sets` in the output) can report
  // captured 0 while rows really landed in an auto-created child set — which is
  // why the set list is printed rather than left to be inferred from a zero.
  return `(function () {
var ids = ${JSON.stringify(sysIds)};
var util = new global.addToUpdateSetUtils();
var session = gs.getSession();
var updateSetAPI = new GlideUpdateSet();
var originalSet = updateSetAPI.get() + '';

// The utility refuses EVERY record when the session sits on the system Default
// update set, and reports it only through gs.addErrorMessage — invisible to a
// background run. Refuse up front with a real message instead of running 50
// records and reporting "captured 0". The property is read the same way the
// utility's initialize() reads it, so an admin who turned the check off is
// still allowed to add to Default.
if (gs.getProperty('addToUpdateSetUtils.prevent_default_updatesets', 'true') == 'true'
    && originalSet == (updateSetAPI.getDefault() + '')) {
  gs.print('snJava: refused The session update set is the system Default. The Add to Update Set Utility refuses every record in that case (addToUpdateSetUtils.prevent_default_updatesets is true). Select or create a real update set and try again.');
  return;
}

// Strip the HTML the utility embeds in its messages and flatten to one line, so
// the panel can show them as text and the output stays line-parseable.
function clean(v) {
  var s = v + '';
  if (s == 'null') return '';
  return s.replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim();
}

// Seed the session keys the utility appends to. The UI Action wrapper does this
// before it runs; without it we would read a previous run's messages back and
// report them as this run's.
session.putClientData('errorMessages', '');
session.putClientData('warningMessages', '');
session.putClientData('setsUtilized', '');
session.putClientData('tablesUtilized', '');
session.clearClientData('parentSet');

function capturedCount(id) {
  var agg = new GlideAggregate('sys_update_xml');
  agg.addQuery('update_set', id);
  agg.addAggregate('COUNT');
  agg.query();
  return agg.next() ? parseInt(agg.getAggregate('COUNT'), 10) : 0;
}

var before = capturedCount(originalSet);
var seen = 0, missing = 0, errors = 0, firstErr = '';
for (var i = 0; i < ids.length; i++) {
  var gr = new GlideRecord('${table}');
  if (!gr.get(ids[i])) {
    missing++;
    continue;
  }
  try {
    // The table name came from the page URL, so a list on a parent table
    // (task_list.do, cmdb_ci_list.do) would hand 'task'/'cmdb_ci' to checkTable
    // and take a different switch branch than the UI Action does on the form.
    // Re-read the record as its own class so the dispatch matches.
    var cls = gr.getRecordClassName() + '';
    if (cls && cls != '${table}') {
      var g2 = new GlideRecord(cls);
      if (g2.get(ids[i])) gr = g2;
    }
    util.checkTable(gr, gr.getTableName());
    seen++;
  } catch (e) {
    errors++;
    if (!firstErr) firstErr = clean(e && e.message ? e.message : e);
  }
}
var captured = capturedCount(originalSet) - before;
var setsUsed = clean(session.getClientData('setsUtilized'));
var utilErrors = clean(session.getClientData('errorMessages'));
var utilWarnings = clean(session.getClientData('warningMessages'));

// _checkSetScope may have switched the session onto an auto-created child set.
// sys.scripts.do runs in the user's own session, so put it back.
if ((updateSetAPI.get() + '') != originalSet) {
  updateSetAPI.set(originalSet);
}

gs.print('snJava: seen ' + seen + ', missing ' + missing + ', captured ' + captured + ', errors ' + errors);
if (firstErr) gs.print('snJava: firstError ' + firstErr);
if (utilErrors) gs.print('snJava: utilityErrors ' + utilErrors);
if (utilWarnings) gs.print('snJava: utilityWarnings ' + utilWarnings);
if (setsUsed) gs.print('snJava: sets ' + setsUsed);
})();`
}

/**
 * What one add run reported.
 *
 * `seen` is how many records existed and were handed to the utility WITHOUT
 * throwing; `errors` is how many threw (their records may be partially captured);
 * `captured` is how many sys_update_xml rows appeared in the original update set.
 * `seen` and `captured` differ legitimately — one record can pull in related
 * records (captured > seen), and a refusal captures nothing (captured < seen) — so
 * the UI must report them separately rather than collapsing them into one "added"
 * number. When the utility refuses, the REASON comes from `utilityErrors` /
 * `utilityWarnings`, read back out of the session keys the utility writes; it must
 * not be guessed from the numbers.
 */
export interface AddCounts {
  seen: number
  missing: number
  captured: number
  errors: number
  /** First thrown message, if any record threw. */
  firstError: string
  /** The utility's own refusal reasons (`errorMessages` session key). */
  utilityErrors: string
  /** The utility's own warnings (`warningMessages` session key). */
  utilityWarnings: string
  /** Update sets the utility actually wrote to — more than one means scope batching. */
  sets: string[]
}

export type AddOutcome =
  | ({ status: 'ran' } & AddCounts)
  /** The script declined before touching anything, with a reason to show verbatim. */
  | { status: 'refused'; reason: string }
  /** No recognisable marker — treat as a failed run of unknown extent. */
  | { status: 'unrecognised' }

const COUNTS_RE = /snJava: seen (\d+), missing (\d+), captured (-?\d+), errors (\d+)/
const REFUSED_RE = /snJava: refused (.*)/
const FIRST_ERR_RE = /snJava: firstError (.*)/
const UTIL_ERR_RE = /snJava: utilityErrors (.*)/
const UTIL_WARN_RE = /snJava: utilityWarnings (.*)/
const SETS_RE = /snJava: sets (.*)/

function line(output: string, re: RegExp): string {
  const m = output.match(re)
  return m ? m[1].trim() : ''
}

export function parseAddResult(output: string): AddOutcome {
  const c = output.match(COUNTS_RE)
  if (c) {
    return {
      status: 'ran',
      seen: Number(c[1]),
      missing: Number(c[2]),
      captured: Number(c[3]),
      errors: Number(c[4]),
      firstError: line(output, FIRST_ERR_RE),
      utilityErrors: line(output, UTIL_ERR_RE),
      utilityWarnings: line(output, UTIL_WARN_RE),
      sets: line(output, SETS_RE)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }
  }
  const refused = line(output, REFUSED_RE)
  if (refused) return { status: 'refused', reason: refused }
  return { status: 'unrecognised' }
}

export function batchSysIds(sysIds: string[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < sysIds.length; i += ADD_BATCH_SIZE) {
    out.push(sysIds.slice(i, i + ADD_BATCH_SIZE))
  }
  return out
}
