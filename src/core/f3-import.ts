/**
 * F3 XML Mover — pure import/undo logic (no chrome.*, Node-testable).
 * Preview uses a read-only Table API query in the panel (see main.ts); this
 * module partitions the result, shapes the undo log, and builds the server-side
 * background scripts for import (INSERT_OR_UPDATE, capturing before-values of
 * overwritten fields) and undo (delete inserts / restore updated fields).
 */
export type ImportAction = 'insert' | 'update'

export interface PreviewRow {
  sysId: string
  action: ImportAction
}

export interface ImportRowResult {
  sysId: string
  action: ImportAction
  ok: boolean
  error?: string
  before?: Record<string, string>
}

export interface UndoRow {
  sysId: string
  action: ImportAction
  before?: Record<string, string>
}

export interface UndoLog {
  host: string
  table: string
  importedAt: string
  rows: UndoRow[]
}

/** Fields never copied/overwritten (recomputed or unsafe across instances). */
const DROP = ['sys_mod_count', 'sys_tags', 'sys_domain', 'sys_domain_path']

/** Client-side preview: which rows already exist on the target (→ update). */
export function partitionPreview(
  rows: Record<string, string>[],
  existingSysIds: Set<string>,
): PreviewRow[] {
  return rows.map((r) => {
    const sysId = r['sys_id'] ?? ''
    return { sysId, action: existingSysIds.has(sysId) ? 'update' : 'insert' }
  })
}

/** Undo log = only successfully-written rows; updates carry their before-values. */
export function buildUndoLog(
  host: string,
  table: string,
  results: ImportRowResult[],
  importedAt: string,
): UndoLog {
  const rows: UndoRow[] = results
    .filter((r) => r.ok)
    .map((r) =>
      r.action === 'update'
        ? { sysId: r.sysId, action: 'update' as const, before: r.before ?? {} }
        : { sysId: r.sysId, action: 'insert' as const },
    )
  return { host, table, importedAt, rows }
}

/**
 * Server-side import script. INSERT_OR_UPDATE by sys_id. For updates, captures
 * the CURRENT values of exactly the fields it is about to overwrite, BEFORE
 * writing, and returns them per row so the panel can build an undo log.
 * Emits: gs.info('snJava:import ' + JSON.stringify({rows:[{sysId,action,ok,error?,before?}]})).
 */
export function buildImportScript(table: string, records: Record<string, string>[]): string {
  const T = JSON.stringify(table)
  const DROPJSON = JSON.stringify(Object.fromEntries(DROP.map((k) => [k, 1])))
  return [
    `var rows = ${JSON.stringify(records)};`,
    `var DROP = ${DROPJSON};`,
    `var results = [];`,
    `for (var i = 0; i < rows.length; i++) {`,
    `  var row = rows[i];`,
    `  var sysId = row['sys_id'];`,
    `  try {`,
    `    var keys = [];`,
    `    for (var k in row) { if (row.hasOwnProperty(k) && k !== 'sys_id' && !DROP[k]) keys.push(k); }`,
    `    var chk = null;`,
    `    if (sysId) { var g = new GlideRecord(${T}); if (g.get(sysId)) { chk = g; } }`,
    `    if (chk) {`,
    `      var before = {};`,
    `      for (var bi = 0; bi < keys.length; bi++) { var k = keys[bi]; before[k] = '' + chk.getValue(k); }`,
    `      for (var ui = 0; ui < keys.length; ui++) { chk.setValue(keys[ui], row[keys[ui]]); }`,
    `      chk.setWorkflow(false); chk.autoSysFields(false);`,
    `      if (chk.update()) { results.push({sysId: sysId, action: 'update', ok: true, before: before}); }`,
    `      else { results.push({sysId: sysId, action: 'update', ok: false, error: '' + (chk.getLastErrorMessage() || 'update rejected')}); }`,
    `    } else {`,
    `      var gr = new GlideRecord(${T});`,
    `      gr.initialize();`,
    `      for (var ii = 0; ii < keys.length; ii++) { gr.setValue(keys[ii], row[keys[ii]]); }`,
    `      if (sysId) gr.setNewGuidValue(sysId);`,
    `      gr.setWorkflow(false); gr.autoSysFields(false);`,
    `      var id = gr.insert();`,
    `      if (id) { results.push({sysId: '' + id, action: 'insert', ok: true}); }`,
    `      else { results.push({sysId: sysId, action: 'insert', ok: false, error: '' + (gr.getLastErrorMessage() || 'insert rejected')}); }`,
    `    }`,
    `  } catch (e) { results.push({sysId: sysId, action: (chk ? 'update' : 'insert'), ok: false, error: '' + e}); }`,
    `}`,
    `gs.info('snJava:import ' + JSON.stringify({rows: results}));`,
  ].join('\n')
}

/**
 * Server-side undo script. Inserts → deleteRecord by sys_id; updates → restore
 * the recorded before-values. Emits:
 * gs.info('snJava:undo ' + JSON.stringify({rows:[{sysId,ok,error?}]})).
 */
export function buildUndoScript(table: string, rows: UndoRow[]): string {
  const T = JSON.stringify(table)
  return [
    `var rows = ${JSON.stringify(rows)};`,
    `var results = [];`,
    `for (var i = 0; i < rows.length; i++) {`,
    `  var r = rows[i];`,
    `  try {`,
    `    var gr = new GlideRecord(${T});`,
    `    if (!gr.get(r.sysId)) { results.push({sysId: r.sysId, ok: false, error: 'record not found'}); continue; }`,
    `    if (r.action === 'insert') {`,
    `      if (gr.deleteRecord()) { results.push({sysId: r.sysId, ok: true}); }`,
    `      else { results.push({sysId: r.sysId, ok: false, error: '' + (gr.getLastErrorMessage() || 'delete rejected')}); }`,
    `    } else {`,
    `      var before = r.before || {};`,
    `      for (var k in before) { if (before.hasOwnProperty(k)) gr.setValue(k, before[k]); }`,
    `      gr.setWorkflow(false); gr.autoSysFields(false);`,
    `      if (gr.update()) { results.push({sysId: r.sysId, ok: true}); }`,
    `      else { results.push({sysId: r.sysId, ok: false, error: '' + (gr.getLastErrorMessage() || 'restore rejected')}); }`,
    `    }`,
    `  } catch (e) { results.push({sysId: r.sysId, ok: false, error: '' + e}); }`,
    `}`,
    `gs.info('snJava:undo ' + JSON.stringify({rows: results}));`,
  ].join('\n')
}
