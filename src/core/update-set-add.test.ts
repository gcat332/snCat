// src/core/update-set-add.test.ts
import { describe, it, expect } from 'vitest'
import {
  ADD_BATCH_SIZE,
  batchSysIds,
  buildAddToUpdateSetScript,
  parseAddResult,
} from './update-set-add'

const ID = '6816f79cc0a8016401c5a33be04be441'

describe('buildAddToUpdateSetScript', () => {
  it('calls the utility once per record on the given table', () => {
    const s = buildAddToUpdateSetScript('incident', [ID])
    expect(s).toContain("new GlideRecord('incident')")
    expect(s).toContain('new global.addToUpdateSetUtils()')
    expect(s).toContain('checkTable(gr, gr.getTableName())')
    expect(s).toContain(ID)
  })

  it('generates syntactically valid JavaScript', () => {
    // Compiles the generated source without running it. The whole risk surface of
    // this feature is server-side code assembled from strings; a syntax error would
    // otherwise only surface as an opaque failure on a live instance.
    const s = buildAddToUpdateSetScript('incident', [ID, 'a'.repeat(32)])
    expect(() => new Function(s)).not.toThrow()
  })

  it('uses checkTable, never the UI-only addToUpdateSet wrapper', () => {
    // addToUpdateSet depends on gs.action and RP, which do not exist in
    // sys.scripts.do — calling it there throws per record while the run still
    // looks successful. checkTable is the UI-free dispatcher.
    const s = buildAddToUpdateSetScript('incident', [ID])
    expect(s).not.toContain('addToUpdateSet(')
    expect(s).not.toContain('gs.action')
    expect(s).not.toContain('RP.')
  })

  it('does not emit the UI Action bindings, which do not exist here', () => {
    const s = buildAddToUpdateSetScript('incident', [ID])
    expect(s).not.toContain('action.setRedirectURL')
    expect(s).not.toContain('GlideSession.get().getStack()')
    // `current` is the UI Action's implicit GlideRecord. Matched where it would be
    // USED as a variable (`current.`, `(current)`, `current,`) rather than as an
    // English word, which appears legitimately in the script's own comments.
    expect(s).not.toMatch(/\bcurrent\s*[.,)\]]/)
  })

  it('counts records that no longer exist separately', () => {
    expect(buildAddToUpdateSetScript('incident', [ID])).toContain('missing')
  })

  it('measures capture from the sys_update_xml delta rather than assuming success', () => {
    // Neither checkTable nor saveRecord reports success — both return bare
    // undefined on refusal — so the script must count what actually landed.
    const s = buildAddToUpdateSetScript('incident', [ID])
    expect(s).toContain('sys_update_xml')
    expect(s).toContain('captured')
  })

  it('wraps every checkTable call in try/catch so one throw cannot abort the batch', () => {
    // checkTable throws for real: _getTableBase calls new global.TableUtils(...)
    // unguarded, the ~65 _addXxx handlers are unguarded, and GlideUpdateManager2 can
    // throw. Records earlier in the batch are already committed as separate DB
    // writes, so an uncaught throw would abandon the run with no report of extent.
    // The vendored UI wrapper wraps its own single call for exactly this reason.
    const s = buildAddToUpdateSetScript('incident', [ID])
    expect(s).toContain('try {')
    expect(s).toContain('} catch (e) {')
    expect(s).toContain('errors++')
    expect(s).toContain('firstErr')
  })

  it('restores the session update set, which _checkSetScope can switch', () => {
    // _checkSetScope inserts a "<name> - Batch Parent" set, renames the selected set
    // to "<name> - Batch Child" and calls updateSetAPI.set() on a scope mismatch.
    // sys.scripts.do runs in the user's own session, so not restoring would leave
    // their browser pointed at an auto-created child set.
    const s = buildAddToUpdateSetScript('incident', [ID])
    expect(s).toContain('var originalSet = updateSetAPI.get()')
    expect(s).toMatch(/if \(\(updateSetAPI\.get\(\) \+ ''\) != originalSet\)/)
    expect(s).toContain('updateSetAPI.set(originalSet)')
  })

  it('reads the utility’s own refusal reasons back out of the session', () => {
    // The utility records why it refused in the errorMessages / warningMessages
    // session keys and nowhere else. They must also be SEEDED, or a previous run's
    // messages are read back and reported as this run's.
    const s = buildAddToUpdateSetScript('incident', [ID])
    expect(s).toContain("putClientData('errorMessages', '')")
    expect(s).toContain("putClientData('warningMessages', '')")
    expect(s).toContain("getClientData('errorMessages')")
    expect(s).toContain("getClientData('warningMessages')")
  })

  it('refuses up front when the session is on the Default update set', () => {
    const s = buildAddToUpdateSetScript('incident', [ID])
    expect(s).toContain('addToUpdateSetUtils.prevent_default_updatesets')
    expect(s).toContain('getDefault()')
    expect(s).toContain('snJava: refused')
  })

  it('re-reads a record as its own class so parent-table lists dispatch correctly', () => {
    // current.table comes from the URL: task_list.do would hand 'task' to checkTable
    // and take a different switch branch than the UI Action does on the form.
    const s = buildAddToUpdateSetScript('task', [ID])
    expect(s).toContain('getRecordClassName()')
    expect(s).toContain("if (cls && cls != 'task')")
  })

  it('rejects a table name that is not a plain identifier', () => {
    expect(() => buildAddToUpdateSetScript("incident'; gs.print('x", [ID])).toThrow()
  })

  it('rejects a sys_id that is not 32 hex characters', () => {
    expect(() => buildAddToUpdateSetScript('incident', ['not-a-sys-id'])).toThrow()
  })
})

describe('parseAddResult', () => {
  const RAN = 'snJava: seen 37, missing 2, captured 41, errors 0'

  it('reads the counts from the background output', () => {
    expect(parseAddResult(`*** Script: ${RAN}`)).toEqual({
      status: 'ran',
      seen: 37,
      missing: 2,
      captured: 41,
      errors: 0,
      firstError: '',
      utilityErrors: '',
      utilityWarnings: '',
      sets: [],
    })
  })

  it('accepts captured exceeding seen — one record can pull in related records', () => {
    const r = parseAddResult('snJava: seen 1, missing 0, captured 9, errors 0')
    expect(r.status).toBe('ran')
    expect(r).toMatchObject({ seen: 1, captured: 9 })
  })

  it('accepts captured below seen — a refusal captures nothing', () => {
    const r = parseAddResult('snJava: seen 5, missing 0, captured 0, errors 0')
    expect(r).toMatchObject({ status: 'ran', seen: 5, captured: 0 })
  })

  it('reports the error count and the first thrown message', () => {
    const out = [
      'snJava: seen 22, missing 0, captured 22, errors 3',
      'snJava: firstError org.mozilla.javascript.EcmaError: Cannot find function getHierarchy',
    ].join('\n')
    const r = parseAddResult(out)
    expect(r).toMatchObject({ status: 'ran', seen: 22, errors: 3 })
    expect(r.status === 'ran' && r.firstError).toContain('Cannot find function getHierarchy')
  })

  it('surfaces the utility’s own error and warning text', () => {
    const out = [
      'snJava: seen 4, missing 0, captured 0, errors 0',
      'snJava: utilityErrors Records from the sys_translated_text table cannot be added to update sets. Record(s) skipped.',
      'snJava: utilityWarnings Attachment exceeds the maximum size',
    ].join('\n')
    const r = parseAddResult(out)
    expect(r.status === 'ran' && r.utilityErrors).toContain('sys_translated_text')
    expect(r.status === 'ran' && r.utilityWarnings).toContain('maximum size')
  })

  it('reports every update set the utility wrote to', () => {
    const a = 'a'.repeat(32)
    const b = 'b'.repeat(32)
    const r = parseAddResult(`snJava: seen 2, missing 0, captured 1, errors 0\nsnJava: sets ${a},${b}`)
    expect(r.status === 'ran' && r.sets).toEqual([a, b])
  })

  it('reports a refusal with the reason to show verbatim', () => {
    const r = parseAddResult('snJava: refused The session update set is the system Default.')
    expect(r.status).toBe('refused')
    expect(r.status === 'refused' && r.reason).toContain('system Default')
  })

  it('reports unrecognised output rather than a zero-count success', () => {
    expect(parseAddResult('java.lang.NullPointerException')).toEqual({ status: 'unrecognised' })
  })
})

describe('batchSysIds', () => {
  it('splits into batches of ADD_BATCH_SIZE', () => {
    const ids = Array.from({ length: 120 }, (_, i) => String(i).padStart(32, '0'))
    const batches = batchSysIds(ids)
    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(ADD_BATCH_SIZE)
    expect(batches[2]).toHaveLength(20)
  })

  it('returns no batches for an empty list', () => {
    expect(batchSysIds([])).toEqual([])
  })
})
