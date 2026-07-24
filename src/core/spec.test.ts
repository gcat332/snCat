import { describe, it, expect } from 'vitest'
import { composeSpec, type SpecBlock } from './spec'
import { makeId, type ArtifactRef } from './graph'

function a(type: ArtifactRef['type'], fields: Record<string, string>, label = 'X'): ArtifactRef {
  return { id: makeId(type, fields.sys_id ?? 'x'), table: type, sysId: fields.sys_id ?? 'x', type, label, relation: '', depth: 1, fields }
}

function headings(doc: ReturnType<typeof composeSpec>): string[] {
  return doc.sections.map((s) => s.heading)
}

describe('composeSpec', () => {
  it('always emits the five skeleton sections in order', () => {
    const doc = composeSpec({
      instance: 'x.service-now.com',
      rootTable: 'sys_script',
      rootLabel: 'My BR',
      rootFields: { sys_id: 'r1' },
      artifacts: [],
    })
    expect(headings(doc)).toEqual([
      'Overview',
      'Data Model',
      'Logic',
      'Integration Points',
      'Security / ACL',
    ])
  })

  it('puts referenced Script Include scripts into Logic as code blocks', () => {
    const doc = composeSpec({
      instance: 'x',
      rootTable: 'sys_script',
      rootLabel: 'BR',
      rootFields: { sys_id: 'r1', script: 'gs.info("root");' },
      artifacts: [a('script_include', { sys_id: 's2', name: 'HelperSI', script: 'return 1;' }, 'HelperSI')],
    })
    const logic = doc.sections.find((s) => s.heading === 'Logic')!
    const codeCaptions = logic.blocks
      .filter((b): b is Extract<SpecBlock, { kind: 'code' }> => b.kind === 'code')
      .map((b) => b.caption)
    expect(codeCaptions).toContain('Script (root)')
    expect(codeCaptions.some((c) => c?.includes('HelperSI'))).toBe(true)
  })

  it('tabulates catalog variables in Data Model', () => {
    const doc = composeSpec({
      instance: 'x',
      rootTable: 'sc_cat_item',
      rootLabel: 'Laptop Request',
      rootFields: { sys_id: 'c1' },
      artifacts: [
        a('variable', { sys_id: 'v1', name: 'os', question_text: 'Operating system', type: '6', mandatory: 'true' }),
      ],
    })
    const dm = doc.sections.find((s) => s.heading === 'Data Model')!
    const table = dm.blocks.find((b) => b.kind === 'table')
    expect(table).toBeTruthy()
  })

  it('lists ACLs in the Security section', () => {
    const doc = composeSpec({
      instance: 'x',
      rootTable: 'sys_script',
      rootLabel: 'BR',
      rootFields: { sys_id: 'r1' },
      artifacts: [a('acl', { sys_id: 'a1', name: 'incident', operation: 'read', active: 'true' })],
    })
    const sec = doc.sections.find((s) => s.heading === 'Security / ACL')!
    expect(sec.blocks.some((b) => b.kind === 'table')).toBe(true)
  })
})
