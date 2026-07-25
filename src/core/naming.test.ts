import { describe, it, expect } from 'vitest'
import { moduleCode, prefixScriptName, SCRIPT_TARGET_TABLES } from './naming'

describe('moduleCode', () => {
  it('maps well-known ITSM tables to their platform code', () => {
    expect(moduleCode('incident')).toBe('INC')
    expect(moduleCode('change_request')).toBe('CHG')
    expect(moduleCode('problem')).toBe('PRB')
    expect(moduleCode('sc_req_item')).toBe('RITM')
  })

  it('is case-insensitive and trims', () => {
    expect(moduleCode('  Incident ')).toBe('INC')
  })

  it('falls back to first three letters for unknown tables', () => {
    expect(moduleCode('cmdb_rel_ci')).toBe('CMD')
    expect(moduleCode('kb_knowledge_base')).toBe('KBK') // not the known kb_knowledge
  })

  it('strips scope/custom prefixes before deriving', () => {
    expect(moduleCode('u_project_task')).toBe('PRO')
    expect(moduleCode('x_acme_app_widget')).toBe('WID')
  })

  it('returns GEN when there is no table', () => {
    expect(moduleCode('')).toBe('GEN')
    expect(moduleCode(null)).toBe('GEN')
    expect(moduleCode(undefined)).toBe('GEN')
  })
})

describe('prefixScriptName', () => {
  it('prepends [MF-AI][CODE] then the name', () => {
    expect(prefixScriptName('Notify group', 'incident')).toBe('[MF-AI][INC] Notify group')
  })

  it('is idempotent — re-prefixing does not stack', () => {
    const once = prefixScriptName('Notify group', 'incident')
    expect(prefixScriptName(once, 'incident')).toBe('[MF-AI][INC] Notify group')
  })

  it('replaces an existing prefix if the code changed', () => {
    const asIncident = prefixScriptName('Escalate', 'incident')
    expect(prefixScriptName(asIncident, 'change_request')).toBe('[MF-AI][CHG] Escalate')
  })

  it('trims surrounding whitespace on the base name', () => {
    expect(prefixScriptName('  Set priority  ', 'incident')).toBe('[MF-AI][INC] Set priority')
  })

  it('uses GEN when the table is unknown/absent', () => {
    expect(prefixScriptName('Helper', null)).toBe('[MF-AI][GEN] Helper')
  })
})

describe('SCRIPT_TARGET_TABLES', () => {
  it('covers the four script metadata tables', () => {
    expect(SCRIPT_TARGET_TABLES.has('sys_script')).toBe(true)
    expect(SCRIPT_TARGET_TABLES.has('sys_script_client')).toBe(true)
    expect(SCRIPT_TARGET_TABLES.has('sys_script_include')).toBe(true)
    expect(SCRIPT_TARGET_TABLES.has('sys_script_fix')).toBe(true)
    expect(SCRIPT_TARGET_TABLES.has('sys_dictionary')).toBe(false)
  })
})
