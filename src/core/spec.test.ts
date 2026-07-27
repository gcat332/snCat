import { describe, it, expect } from 'vitest'
import { composeSpec, type SpecBlock } from './spec'
import { makeId, type ArtifactRef } from './graph'
import { SCOPE_ARTIFACT_TABLES } from './scope-spec'

function a(type: ArtifactRef['type'], fields: Record<string, string>, label = 'X'): ArtifactRef {
  return { id: makeId(type, fields.sys_id ?? 'x'), table: type, sysId: fields.sys_id ?? 'x', type, label, relation: '', depth: 1, fields }
}

function headings(doc: ReturnType<typeof composeSpec>): string[] {
  return doc.sections.map((s) => s.heading)
}

describe('composeSpec', () => {
  it('always emits the skeleton sections in order', () => {
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
      'REST API (Table API)',
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
    // Root script is a code block; the Script Include appears as its own subheading + code.
    const codeBlocks = logic.blocks.filter(
      (b): b is Extract<SpecBlock, { kind: 'code' }> => b.kind === 'code',
    )
    expect(codeBlocks.some((b) => b.code === 'gs.info("root");')).toBe(true)
    expect(codeBlocks.some((b) => b.code === 'return 1;')).toBe(true)
    const subheads = logic.blocks
      .filter((b): b is Extract<SpecBlock, { kind: 'subheading' }> => b.kind === 'subheading')
      .map((b) => b.text)
    expect(subheads.some((t) => t.includes('HelperSI'))).toBe(true)
    expect(subheads.some((t) => t.startsWith('Script Includes'))).toBe(true)
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

  it('documents the primary table schema in Data Model', () => {
    const doc = composeSpec({
      instance: 'x',
      rootTable: 'sys_script',
      rootLabel: 'BR',
      rootFields: { sys_id: 'r1', collection: 'incident' },
      artifacts: [],
      primaryTable: 'incident',
      schema: [
        { element: 'state', type: 'Choice', label: 'State', reference: '', mandatory: 'false', maxLength: '40', defaultValue: '1' },
        { element: 'caller_id', type: 'Reference', label: 'Caller', reference: 'sys_user', mandatory: 'true', maxLength: '32', defaultValue: '' },
      ],
    })
    const dm = doc.sections.find((s) => s.heading === 'Data Model')!
    const table = dm.blocks.find((b) => b.kind === 'table')
    expect(table).toBeTruthy()
    expect(JSON.stringify(table)).toContain('caller_id')
    expect(JSON.stringify(table)).toContain('sys_user')
  })

  it('tags the REST "list records" curl example as text, not javascript', () => {
    const doc = composeSpec({
      instance: 'x.service-now.com',
      rootTable: 'sys_script',
      rootLabel: 'My BR',
      rootFields: { sys_id: 'r1' },
      artifacts: [],
    })
    const api = doc.sections.find((s) => s.heading === 'REST API (Table API)')!
    const listExample = api.blocks.find(
      (b): b is Extract<SpecBlock, { kind: 'code' }> => b.kind === 'code' && b.caption === 'GET (query)',
    )!
    expect(listExample).toBeTruthy()
    expect(listExample.code).toContain('curl')
    expect(listExample.lang).toBe('text')
  })

  it('documents each ACL with its condition and script together', () => {
    const doc = composeSpec({
      instance: 'x',
      rootTable: 'sys_script',
      rootLabel: 'BR',
      rootFields: { sys_id: 'r1' },
      artifacts: [
        a('acl', {
          sys_id: 'a1',
          name: 'incident',
          operation: 'read',
          active: 'true',
          condition: 'active=true',
          script: 'answer = gs.hasRole("itil");',
        }),
      ],
    })
    const sec = doc.sections.find((s) => s.heading === 'Security / ACL')!
    // The ACL appears as its own subheading, and its condition + script are both
    // rendered as code blocks within the same section (grouped, not split apart).
    const subheads = sec.blocks
      .filter((b): b is Extract<SpecBlock, { kind: 'subheading' }> => b.kind === 'subheading')
      .map((b) => b.text)
    expect(subheads.some((t) => t.includes('incident') && t.includes('read'))).toBe(true)
    const code = sec.blocks.filter((b): b is Extract<SpecBlock, { kind: 'code' }> => b.kind === 'code')
    expect(code.some((b) => b.code === 'active=true')).toBe(true)
    expect(code.some((b) => b.code.includes('hasRole'))).toBe(true)
  })

  it('passes aiOverview through composeSpec when provided', () => {
    const doc = composeSpec({ instance: 'x', rootTable: 'incident', rootLabel: 'Incident', rootFields: {}, artifacts: [], aiOverview: 'This module handles incidents.' })
    expect(doc.aiOverview).toBe('This module handles incidents.')
  })
})

describe('composeSpec in scope mode', () => {
  const base = {
    instance: 'dev1.service-now.com',
    rootTable: 'sys_scope',
    rootLabel: 'MFEC Onboarding',
    rootFields: {},
    artifacts: [],
  }

  it('titles the document after the application', () => {
    const doc = composeSpec({ ...base, scope: { label: 'MFEC Onboarding', prefix: 'x_mfec_onb' } })
    expect(doc.title).toBe('MFEC Onboarding')
    expect(doc.subtitle).toBe('Application Design Specification')
  })

  it('reports the application and instance in meta', () => {
    const doc = composeSpec({ ...base, scope: { label: 'MFEC Onboarding', prefix: 'x_mfec_onb' } })
    expect(doc.meta).toContainEqual({ key: 'Application', value: 'MFEC Onboarding (x_mfec_onb)' })
    expect(doc.meta).toContainEqual({ key: 'Instance', value: 'dev1.service-now.com' })
  })

  it('omits the table REST API section, which has no meaning for a scope', () => {
    const doc = composeSpec({ ...base, scope: { label: 'MFEC Onboarding', prefix: 'x_mfec_onb' } })
    expect(doc.sections.map((s) => s.heading)).not.toContain('REST API (Table API)')
  })

  it('keeps the REST API section when there is no scope', () => {
    const doc = composeSpec({ ...base, rootTable: 'incident', primaryTable: 'incident' })
    expect(doc.sections.map((s) => s.heading)).toContain('REST API (Table API)')
  })

  it('describes the application in the Overview intro, not an empty table name', () => {
    const doc = composeSpec({
      ...base,
      primaryTable: '',
      schema: [],
      scope: { label: 'MFEC Onboarding', prefix: 'x_mfec_onb' },
    })
    const overview = doc.sections.find((s) => s.heading === 'Overview')!
    const intro = overview.blocks.find(
      (b): b is Extract<SpecBlock, { kind: 'paragraph' }> => b.kind === 'paragraph',
    )!
    expect(intro.text).toContain('MFEC Onboarding')
    expect(intro.text).toContain('x_mfec_onb')
    expect(intro.text).not.toContain('""')
  })

  it('gives the Overview section real content instead of the no-metadata fallback', () => {
    const doc = composeSpec({
      ...base,
      primaryTable: '',
      schema: [],
      scope: { label: 'MFEC Onboarding', prefix: 'x_mfec_onb' },
    })
    const overview = doc.sections.find((s) => s.heading === 'Overview')!
    const kv = overview.blocks.find((b): b is Extract<SpecBlock, { kind: 'keyvalue' }> => b.kind === 'keyvalue')
    expect(kv).toBeTruthy()
    expect(kv!.rows).toContainEqual({ key: 'Application', value: 'MFEC Onboarding' })
    const notes = overview.blocks.filter(
      (b): b is Extract<SpecBlock, { kind: 'paragraph' }> => b.kind === 'paragraph',
    )
    expect(notes.some((b) => b.text === 'No overview metadata available.')).toBe(false)
  })

  it('does not mention a depth limit in an empty Data Model section', () => {
    const doc = composeSpec({
      ...base,
      primaryTable: '',
      schema: [],
      scope: { label: 'MFEC Onboarding', prefix: 'x_mfec_onb' },
    })
    const dm = doc.sections.find((s) => s.heading === 'Data Model')!
    expect(JSON.stringify(dm.blocks)).not.toContain('depth limit')
  })

  it('leaves the table-spec Overview intro and Data Model fallback unchanged', () => {
    const doc = composeSpec({
      instance: 'x.service-now.com',
      rootTable: 'incident',
      rootLabel: 'Incident',
      rootFields: {},
      artifacts: [],
    })
    const overview = doc.sections.find((s) => s.heading === 'Overview')!
    const intro = overview.blocks.find(
      (b): b is Extract<SpecBlock, { kind: 'paragraph' }> => b.kind === 'paragraph',
    )!
    expect(intro.text).toBe(
      'This Design Specification documents the "Incident" table on x.service-now.com — its data model (fields), business rules, client scripts, UI policies, notifications, and security (ACLs / data policies).',
    )
    const dm = doc.sections.find((s) => s.heading === 'Data Model')!
    const note = dm.blocks.find(
      (b): b is Extract<SpecBlock, { kind: 'paragraph' }> => b.kind === 'paragraph',
    )!
    expect(note.text).toBe(
      'Primary table: incident. No additional data-model artifacts were discovered within the depth limit.',
    )
  })
})

// Guards the class of bug in FINDING 1: a sweep table declared in scope-spec.ts
// whose artifact type has no renderer anywhere in composeSpec. Every table
// scope-spec.ts sweeps must show up somewhere in the composed document, or a
// scope spec silently omits a whole artifact type while still claiming (via
// the checklist and the "Artifacts documented" meta count) to have covered it.
describe('composeSpec renders every scope-swept artifact type', () => {
  for (const sweep of SCOPE_ARTIFACT_TABLES) {
    it(`renders a distinguishing value for type "${sweep.type}" (${sweep.table})`, () => {
      const marker = `MARKER_${sweep.type.toUpperCase()}`
      const fields: Record<string, string> = { sys_id: 'x1', [sweep.labelField]: marker }
      const artifact = a(sweep.type, fields, marker)
      const doc = composeSpec({
        instance: 'x',
        rootTable: 'sys_scope',
        rootLabel: 'App',
        rootFields: {},
        artifacts: [artifact],
        scope: { label: 'App', prefix: 'x_app' },
      })
      expect(JSON.stringify(doc.sections)).toContain(marker)
    })
  }
})
