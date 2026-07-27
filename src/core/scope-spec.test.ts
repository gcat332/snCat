import { describe, it, expect } from 'vitest'
import { SCOPE_ARTIFACT_TABLES, scopeFetchSpecs } from './scope-spec'

describe('scopeFetchSpecs', () => {
  const specs = scopeFetchSpecs('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')

  it('emits one spec per swept artifact table', () => {
    expect(specs).toHaveLength(SCOPE_ARTIFACT_TABLES.length)
  })

  it('queries every table by sys_scope', () => {
    for (const s of specs) {
      expect(s.query).toContain('sys_scope=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')
    }
  })

  it('gives every spec a limit and a fields list', () => {
    for (const s of specs) {
      expect(s.limit).toBeGreaterThan(0)
      expect(s.fields?.length).toBeGreaterThan(0)
      expect(s.fields).toContain('sys_id')
    }
  })

  it('sweeps no table twice', () => {
    const tables = specs.map((s) => s.table)
    expect(new Set(tables).size).toBe(tables.length)
  })

  it('covers the artifact tables the resolvers already know about', () => {
    const tables = specs.map((s) => s.table)
    for (const t of [
      'sys_db_object',
      'sys_script',
      'sys_script_client',
      'sys_script_include',
      'sys_ui_policy',
      'sys_security_acl',
      'sysevent_email_action',
      'sys_data_policy2',
      'sc_cat_item',
      'sys_transform_map',
      'sys_ui_action',
    ]) {
      expect(tables).toContain(t)
    }
  })
})
