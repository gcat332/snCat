import { describe, it, expect } from 'vitest'
import { parseUnloadXml, importableFields } from './xml'

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<incident action="INSERT_OR_UPDATE">
  <active>true</active>
  <number>INC0001</number>
  <priority>1</priority>
  <short_description>Printer &amp; scanner &lt;down&gt;</short_description>
  <sys_id>abc123</sys_id>
  <sys_mod_count>4</sys_mod_count>
  <caller_id>def456</caller_id>
</incident>`

describe('parseUnloadXml', () => {
  it('extracts fields and unescapes entities', () => {
    const parsed = parseUnloadXml(XML, 'incident')
    expect(parsed).not.toBeNull()
    expect(parsed!.table).toBe('incident')
    expect(parsed!.fields.number).toBe('INC0001')
    expect(parsed!.fields.priority).toBe('1')
    expect(parsed!.fields.short_description).toBe('Printer & scanner <down>')
    expect(parsed!.fields.caller_id).toBe('def456')
  })

  it('returns null when the table block is absent', () => {
    expect(parseUnloadXml(XML, 'problem')).toBeNull()
  })
})

describe('importableFields', () => {
  it('drops system-managed fields', () => {
    const parsed = parseUnloadXml(XML, 'incident')!
    const imp = importableFields(parsed.fields)
    expect(imp.sys_id).toBeUndefined()
    expect(imp.sys_mod_count).toBeUndefined()
    expect(imp.number).toBe('INC0001')
    expect(imp.caller_id).toBe('def456')
  })
})
