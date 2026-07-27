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
 * — the file's only uses of `gs.action` and `RP` — plus `clientSession` for update-set
 * switching and `gs.addInfoMessage`/`gs.flushMessages` for user feedback. None of that
 * exists in `sys.scripts.do`, so calling it there throws per record.
 *
 * `checkTable` contains zero references to `gs.action`, `RP.` or `clientSession`. It is
 * the dispatcher: a switch over table names invoking ~65 `_addXxx` related-record
 * handlers (attachments, variables, workflows, catalog items, ACL and UI-policy
 * dependencies, …), and its `default:` arm falls through to `_executeScopeScript()` and
 * `saveRecord(gr)`, so an ordinary record such as an incident is still captured.
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

  // `checkTable` is the utility's UI-free dispatcher; see the module comment for why
  // `addToUpdateSet` cannot be used here. Success is MEASURED by the delta in
  // sys_update_xml rows, because neither checkTable nor saveRecord reports it: both
  // return bare `undefined` on refusal (excluded table, invalid record, scope mismatch).
  return `var ids = ${JSON.stringify(sysIds)};
var util = new global.addToUpdateSetUtils();
var setId = new GlideUpdateSet().get() + '';

function capturedCount(id) {
  var agg = new GlideAggregate('sys_update_xml');
  agg.addQuery('update_set', id);
  agg.addAggregate('COUNT');
  agg.query();
  return agg.next() ? parseInt(agg.getAggregate('COUNT'), 10) : 0;
}

var before = capturedCount(setId);
var seen = 0, missing = 0;
for (var i = 0; i < ids.length; i++) {
  var gr = new GlideRecord('${table}');
  if (gr.get(ids[i])) {
    util.checkTable(gr, gr.getTableName());
    seen++;
  } else {
    missing++;
  }
}
var captured = capturedCount(setId) - before;
gs.print('snJava: seen ' + seen + ', missing ' + missing + ', captured ' + captured);`
}

/**
 * `seen` is how many records existed and were handed to the utility; `captured` is how
 * many sys_update_xml rows actually appeared. They differ legitimately — one record can
 * pull in related records (captured > seen), and an excluded table or scope mismatch
 * captures nothing (captured < seen) — so the UI must report both rather than conflating
 * them into a single "added" number.
 */
export function parseAddResult(
  output: string,
): { seen: number; missing: number; captured: number } | null {
  const m = output.match(/snJava: seen (\d+), missing (\d+), captured (\d+)/)
  return m ? { seen: Number(m[1]), missing: Number(m[2]), captured: Number(m[3]) } : null
}

export function batchSysIds(sysIds: string[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < sysIds.length; i += ADD_BATCH_SIZE) {
    out.push(sysIds.slice(i, i + ADD_BATCH_SIZE))
  }
  return out
}
