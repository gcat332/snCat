import { describe, it, expect } from 'vitest'
import { partitionPreview, buildUndoLog, buildImportScript, buildUndoScript } from './f3-import'

describe('partitionPreview', () => {
  it('marks rows whose sys_id exists on the target as update, others as insert', () => {
    const rows: Record<string, string>[] = [{ sys_id: 'a', name: 'x' }, { sys_id: 'b', name: 'y' }, { sys_id: 'c' }]
    const out = partitionPreview(rows, new Set(['b']))
    expect(out).toEqual([
      { sysId: 'a', action: 'insert' },
      { sysId: 'b', action: 'update' },
      { sysId: 'c', action: 'insert' },
    ])
  })
})

describe('buildUndoLog', () => {
  it('keeps only successful rows; updates carry before-values, inserts do not', () => {
    const results = [
      { sysId: 'a', action: 'insert' as const, ok: true },
      { sysId: 'b', action: 'update' as const, ok: true, before: { name: 'old' } },
      { sysId: 'c', action: 'insert' as const, ok: false, error: 'ACL' },
    ]
    expect(buildUndoLog('dev.service-now.com', 'incident', results, '2026-07-25T00:00:00Z')).toEqual({
      host: 'dev.service-now.com',
      table: 'incident',
      importedAt: '2026-07-25T00:00:00Z',
      rows: [
        { sysId: 'a', action: 'insert' },
        { sysId: 'b', action: 'update', before: { name: 'old' } },
      ],
    })
  })
})

describe('buildImportScript', () => {
  it('captures before-values for updates and emits a snJava:import marker', () => {
    const s = buildImportScript('incident', [{ sys_id: 'a', short_description: 'hi' }])
    expect(s).toContain('new GlideRecord("incident")')
    expect(s).toContain('setWorkflow(false)')
    expect(s).toContain('setNewGuidValue')
    // Verify before-capture (getValue) happens BEFORE the overwrite loop (setValue)
    expect(s).toContain('getValue(')
    expect(s).toContain('setValue(')
    expect(s.indexOf('getValue(') < s.indexOf('setValue(')).toBe(true)
    expect(s).toContain("snJava:import ")
    expect(s).toContain('JSON.stringify')
  })
})

describe('buildUndoScript', () => {
  it('deletes inserts and restores update before-values, emitting snJava:undo', () => {
    const s = buildUndoScript('incident', [
      { sysId: 'a', action: 'insert' },
      { sysId: 'b', action: 'update', before: { name: 'old' } },
    ])
    expect(s).toContain('deleteRecord()')
    expect(s).toContain('setValue') // restore path
    expect(s).toContain("snJava:undo ")
  })
})
