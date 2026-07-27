import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseUpdateSetXml } from './updateset-xml'
import { buildInstallScript, toBase64Utf8, type UpdateRecord } from './updateset-xml'

function rec(over: Partial<UpdateRecord> = {}): UpdateRecord {
  return {
    type: 'System Property',
    targetName: 'p',
    table: 'sys_properties',
    sysId: 'b7dd13942f6bcc50c6c690bcf699b6bd',
    fields: { name: 'p', value: 'true', sys_id: 'b7dd13942f6bcc50c6c690bcf699b6bd' },
    ...over,
  }
}

describe('toBase64Utf8', () => {
  it('round-trips ASCII', () => {
    expect(atob(toBase64Utf8('hello'))).toBe('hello')
  })

  it('encodes non-Latin1 characters without throwing', () => {
    expect(() => toBase64Utf8('ทดสอบ — ü')).not.toThrow()
    expect(toBase64Utf8('ทดสอบ')).not.toContain('undefined')
  })
})

describe('buildInstallScript', () => {
  it('targets the record’s table and preserves the sys_id', () => {
    const s = buildInstallScript(rec())
    expect(s).toContain("new GlideRecord('sys_properties')")
    expect(s).toContain('b7dd13942f6bcc50c6c690bcf699b6bd')
    expect(s).toContain('setNewGuidValue')
  })

  it('never embeds a raw field value — only base64', () => {
    const s = buildInstallScript(
      rec({ fields: { name: 'p', script: 'var s = "]]>\' + \\ tricky";' } }),
    )
    expect(s).not.toContain('tricky')
    expect(s).toContain('GlideStringUtil.base64Decode')
  })

  it('omits system fields the platform owns', () => {
    const s = buildInstallScript(
      rec({ fields: { name: 'p', sys_created_on: 'x', sys_mod_count: '7', sys_updated_by: 'admin' } }),
    )
    expect(s).not.toContain('sys_created_on')
    expect(s).not.toContain('sys_mod_count')
    expect(s).not.toContain('sys_updated_by')
  })

  it('reports a machine-readable outcome line', () => {
    expect(buildInstallScript(rec())).toContain('snJava: installed')
  })
})

/** Two records: one CDATA payload, one entity-escaped payload. */
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?><unload unload_date="2026-05-20 13:30:54">
<sys_update_xml action="INSERT_OR_UPDATE">
<name>sys_properties_abc</name>
<payload><![CDATA[<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_properties"><sys_properties action="INSERT_OR_UPDATE"><name>addToUpdateSetUtils.include_attachments</name><value>true</value><sys_id>b7dd13942f6bcc50c6c690bcf699b6bd</sys_id><suffix/></sys_properties></record_update>]]></payload>
<target_name>addToUpdateSetUtils.include_attachments</target_name>
<type>System Property</type>
</sys_update_xml>
<sys_update_xml action="INSERT_OR_UPDATE">
<name>sys_script_include_xyz</name>
<payload>&lt;?xml version="1.0" encoding="UTF-8"?&gt;&lt;record_update table="sys_script_include"&gt;&lt;sys_script_include action="INSERT_OR_UPDATE"&gt;&lt;name&gt;addToUpdateSetUtils&lt;/name&gt;&lt;script&gt;var x = "a &amp;amp; b";&lt;/script&gt;&lt;sys_id&gt;6ba1c8a24f5da740d1676bd18110c79a&lt;/sys_id&gt;&lt;/sys_script_include&gt;&lt;/record_update&gt;</payload>
<target_name>addToUpdateSetUtils</target_name>
<type>Script Include</type>
</sys_update_xml>
</unload>`

describe('parseUpdateSetXml', () => {
  const recs = parseUpdateSetXml(SAMPLE)

  it('returns one UpdateRecord per sys_update_xml', () => {
    expect(recs).toHaveLength(2)
  })

  it('reads the target table from the record_update wrapper', () => {
    expect(recs[0].table).toBe('sys_properties')
    expect(recs[1].table).toBe('sys_script_include')
  })

  it('carries the type and target name through', () => {
    expect(recs[0].type).toBe('System Property')
    expect(recs[0].targetName).toBe('addToUpdateSetUtils.include_attachments')
  })

  it('preserves the original sys_id', () => {
    expect(recs[0].sysId).toBe('b7dd13942f6bcc50c6c690bcf699b6bd')
    expect(recs[1].sysId).toBe('6ba1c8a24f5da740d1676bd18110c79a')
  })

  it('extracts payload fields from a CDATA payload', () => {
    expect(recs[0].fields.name).toBe('addToUpdateSetUtils.include_attachments')
    expect(recs[0].fields.value).toBe('true')
    expect(recs[0].fields.suffix).toBe('')
  })

  it('extracts payload fields from an entity-escaped payload, unescaping once', () => {
    expect(recs[1].fields.name).toBe('addToUpdateSetUtils')
    expect(recs[1].fields.script).toBe('var x = "a & b";')
  })

  it('skips a record whose payload has no record_update wrapper', () => {
    const broken = '<unload><sys_update_xml><payload>nonsense</payload></sys_update_xml></unload>'
    expect(parseUpdateSetXml(broken)).toEqual([])
  })
})

describe('the vendored v9.5 export', () => {
  const recs = parseUpdateSetXml(
    readFileSync(join(__dirname, '../../public/vendor/add-to-update-set-v9.5.xml'), 'utf8'),
  )

  it('parses all 21 records', () => {
    expect(recs).toHaveLength(21)
  })

  it('includes the Script Include with its full body', () => {
    const si = recs.find((r) => r.table === 'sys_script_include')!
    expect(si.targetName).toBe('addToUpdateSetUtils')
    expect(si.fields.script.length).toBeGreaterThan(100_000)
    expect(si.fields.script).toContain('addToUpdateSet')
  })

  it('includes the 8 addToUpdateSetUtils system properties', () => {
    const props = recs.filter((r) => r.table === 'sys_properties')
    expect(props).toHaveLength(8)
  })

  it('gives every record a table and a sys_id', () => {
    for (const r of recs) {
      expect(r.table).toBeTruthy()
      expect(r.sysId).toMatch(/^[0-9a-f]{32}$/)
    }
  })
})
