import { describe, it, expect } from 'vitest'
import { extractScriptIncludeCandidates, RESOLVERS, SUPPORTED_ROOT_TABLES } from './resolvers'
import { makeId, type ArtifactRef } from './graph'

function art(table: string, fields: Record<string, string>, type: ArtifactRef['type'] = 'root'): ArtifactRef {
  return { id: makeId(table, 's1'), table, sysId: 's1', type, label: 'X', relation: '', depth: 0, fields }
}

describe('extractScriptIncludeCandidates', () => {
  it('finds new-instantiated and static-called Script Includes', () => {
    const script = `
      var u = new UserUtils();
      var r = PriceCalculator.compute(5);
      var gr = new GlideRecord('incident');
      JSON.stringify({});
    `
    const found = extractScriptIncludeCandidates(script)
    expect(found).toContain('UserUtils')
    expect(found).toContain('PriceCalculator')
  })

  it('excludes known Glide globals and built-ins', () => {
    const found = extractScriptIncludeCandidates(
      "new GlideRecord('x'); new GlideAggregate('y'); JSON.parse('{}'); new Date();",
    )
    expect(found).toEqual([])
  })

  it('ignores lower-case identifiers', () => {
    expect(extractScriptIncludeCandidates('foo.bar(); new widget();')).toEqual([])
  })
})

describe('root resolver dispatch', () => {
  it('resolves a Business Rule root to table + script includes', () => {
    const specs = RESOLVERS.root!(
      art('sys_script', { collection: 'incident', script: 'new HelperSI();' }),
    )
    const tables = specs.map((s) => s.table)
    expect(tables).toContain('sys_db_object') // target table
    expect(tables).toContain('sys_script_include') // referenced SI
    const si = specs.find((s) => s.table === 'sys_script_include')!
    expect(si.query).toContain('HelperSI')
  })

  it('resolves a Catalog Item root to variables/policies/scripts', () => {
    const specs = RESOLVERS.root!(art('sc_cat_item', {}))
    const tables = specs.map((s) => s.table)
    expect(tables).toEqual(
      expect.arrayContaining(['item_option_new', 'catalog_ui_policy', 'catalog_script_client']),
    )
  })

  it('resolves a Transform Map root to its entries', () => {
    const specs = RESOLVERS.root!(art('sys_transform_map', {}))
    expect(specs[0].table).toBe('sys_transform_entry')
    expect(specs[0].query).toContain('map=s1')
  })

  it('falls back to ACLs for an unknown root table', () => {
    const specs = RESOLVERS.root!(art('u_custom', {}))
    expect(specs.some((s) => s.table === 'sys_security_acl')).toBe(true)
  })
})

describe('resolveTable ACL fetch (T-102: sibling-table leak)', () => {
  it('anchors the ACL query to the table\'s own record + field ACLs, not sibling tables', () => {
    const specs = RESOLVERS.table!(art('sys_db_object', { name: 'incident' }, 'table'))
    const acl = specs.find((s) => s.table === 'sys_security_acl')!
    expect(acl).toBeDefined()
    // Anchored form: exact table name OR field ACLs prefixed with `incident.`
    expect(acl.query).toContain('name=incident^ORnameSTARTSWITHincident.')
    // Must NOT use a bare STARTSWITH that would also catch `incident_sla`, `incident_task`, etc.
    expect(acl.query).not.toMatch(/nameSTARTSWITHincident(?![.])/)
  })
})

describe('SUPPORTED_ROOT_TABLES', () => {
  it('includes the priority root types', () => {
    expect(SUPPORTED_ROOT_TABLES.has('sys_script')).toBe(true)
    expect(SUPPORTED_ROOT_TABLES.has('sc_cat_item')).toBe(true)
  })
})
