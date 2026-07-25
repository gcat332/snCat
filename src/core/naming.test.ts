import { describe, it, expect } from 'vitest'
import { moduleCode, prefixArtifactName, namePrefixField } from './naming'

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

describe('prefixArtifactName', () => {
  it('prepends [MF-AI][CODE] then the name', () => {
    expect(prefixArtifactName('Notify group', 'incident')).toBe('[MF-AI][INC] Notify group')
  })

  it('is idempotent — re-prefixing does not stack', () => {
    const once = prefixArtifactName('Notify group', 'incident')
    expect(prefixArtifactName(once, 'incident')).toBe('[MF-AI][INC] Notify group')
  })

  it('replaces an existing prefix if the code changed', () => {
    const asIncident = prefixArtifactName('Escalate', 'incident')
    expect(prefixArtifactName(asIncident, 'change_request')).toBe('[MF-AI][CHG] Escalate')
  })

  it('trims surrounding whitespace on the base name', () => {
    expect(prefixArtifactName('  Set priority  ', 'incident')).toBe('[MF-AI][INC] Set priority')
  })

  it('uses GEN when the table is unknown/absent', () => {
    expect(prefixArtifactName('Helper', null)).toBe('[MF-AI][GEN] Helper')
  })
})

describe('namePrefixField', () => {
  it('prefixes script + config records via their name column', () => {
    expect(namePrefixField('sys_script')).toBe('name') // Business Rule
    expect(namePrefixField('sys_script_client')).toBe('name') // Client Script
    expect(namePrefixField('sys_script_include')).toBe('name') // Script Include
    expect(namePrefixField('sys_script_fix')).toBe('name') // Fix Script
    expect(namePrefixField('sys_ui_action')).toBe('name') // UI Action
    expect(namePrefixField('sysevent_email_action')).toBe('name') // Notification
  })

  it('uses short_description for UI/Data Policies', () => {
    expect(namePrefixField('sys_ui_policy')).toBe('short_description')
    expect(namePrefixField('sys_data_policy2')).toBe('short_description')
  })

  it('never prefixes Field / Table / ACL', () => {
    expect(namePrefixField('sys_dictionary')).toBeNull()
    expect(namePrefixField('sys_db_object')).toBeNull()
    expect(namePrefixField('sys_security_acl')).toBeNull()
  })

  it('never prefixes user-facing Choice labels', () => {
    expect(namePrefixField('sys_choice')).toBeNull()
  })

  it('never prefixes business data records (non-sys tables)', () => {
    expect(namePrefixField('incident')).toBeNull()
    expect(namePrefixField('change_request')).toBeNull()
    expect(namePrefixField(null)).toBeNull()
  })
})
