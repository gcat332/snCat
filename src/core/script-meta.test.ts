import { describe, it, expect } from 'vitest'
import { buildScriptBrowseQuery, scriptTableInfo, normalizeTiming } from './script-meta'

describe('buildScriptBrowseQuery', () => {
  it('scopes Business Rules by collection', () => {
    expect(buildScriptBrowseQuery('sys_script', 'incident')).toBe('collection=incident^ORDERBYname')
  })

  it('scopes Client Scripts by table', () => {
    expect(buildScriptBrowseQuery('sys_script_client', 'incident')).toBe('table=incident^ORDERBYname')
  })

  it('does not scope Script Includes by table (global)', () => {
    expect(buildScriptBrowseQuery('sys_script_include', 'incident')).toBe('ORDERBYname')
  })

  it('adds a name filter', () => {
    expect(buildScriptBrowseQuery('sys_script', 'incident', 'VIP')).toBe(
      'collection=incident^nameLIKEVIP^ORDERBYname',
    )
  })

  it('omits the table clause when no filter given', () => {
    expect(buildScriptBrowseQuery('sys_script', undefined, 'foo')).toBe('nameLIKEfoo^ORDERBYname')
  })
})

describe('scriptTableInfo / normalizeTiming', () => {
  it('maps script tables to kinds', () => {
    expect(scriptTableInfo('sys_script')?.kind).toBe('business_rule')
    expect(scriptTableInfo('sys_script_client')?.kind).toBe('client_script')
    expect(scriptTableInfo('incident')).toBeNull()
  })

  it('normalizes timing with a safe default', () => {
    expect(normalizeTiming('after')).toBe('after')
    expect(normalizeTiming('garbage')).toBe('before')
  })
})
