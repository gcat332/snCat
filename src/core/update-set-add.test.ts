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
    expect(s).not.toMatch(/\bcurrent\b/)
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

  it('rejects a table name that is not a plain identifier', () => {
    expect(() => buildAddToUpdateSetScript("incident'; gs.print('x", [ID])).toThrow()
  })

  it('rejects a sys_id that is not 32 hex characters', () => {
    expect(() => buildAddToUpdateSetScript('incident', ['not-a-sys-id'])).toThrow()
  })
})

describe('parseAddResult', () => {
  it('reads the counts from the background output', () => {
    expect(parseAddResult('*** Script: snJava: seen 37, missing 2, captured 41')).toEqual({
      seen: 37,
      missing: 2,
      captured: 41,
    })
  })

  it('accepts captured exceeding seen — one record can pull in related records', () => {
    expect(parseAddResult('snJava: seen 1, missing 0, captured 9')).toEqual({
      seen: 1,
      missing: 0,
      captured: 9,
    })
  })

  it('accepts captured below seen — an excluded table captures nothing', () => {
    expect(parseAddResult('snJava: seen 5, missing 0, captured 0')).toEqual({
      seen: 5,
      missing: 0,
      captured: 0,
    })
  })

  it('returns null when the marker is absent', () => {
    expect(parseAddResult('java.lang.NullPointerException')).toBeNull()
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
