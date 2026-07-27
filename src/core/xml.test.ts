import { describe, it, expect } from 'vitest'
import { parseUnloadXml, parseUnloadXmlAll, dedupeRecords, importableFields, extractFields, findRecordInners, unescapeXml } from './xml'

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

describe('parseUnloadXmlAll', () => {
  const LIST = `<?xml version="1.0" encoding="UTF-8"?>
<unload unload_date="2026-07-25">
<incident action="INSERT_OR_UPDATE"><number>INC0001</number><priority>1</priority></incident>
<incident action="INSERT_OR_UPDATE"><number>INC0002</number><priority>2</priority></incident>
<incident action="INSERT_OR_UPDATE"><number>INC0003</number><priority>3</priority></incident>
</unload>`

  it('extracts every record from a list export', () => {
    const all = parseUnloadXmlAll(LIST, 'incident')
    expect(all).toHaveLength(3)
    expect(all.map((r) => r.fields.number)).toEqual(['INC0001', 'INC0002', 'INC0003'])
  })

  it('handles a single-record export too', () => {
    const all = parseUnloadXmlAll(XML, 'incident')
    expect(all).toHaveLength(1)
    expect(all[0].fields.number).toBe('INC0001')
  })

  it('returns an empty array when the table is absent', () => {
    expect(parseUnloadXmlAll(LIST, 'problem')).toEqual([])
  })
})

describe('CDATA-bearing fields (script/HTML)', () => {
  // A ServiceNow Business Rule unload: the `script` field is wrapped in CDATA so
  // its content isn't escaped. The CDATA contains substrings that LOOK like
  // closing tags (`</record>`, `</script>`) which must NOT terminate the field.
  const SCRIPT = ` gs.info("</record> not really the end"); var x = "</script>"; `
  const BR = `<?xml version="1.0" encoding="UTF-8"?>
<sys_script action="INSERT_OR_UPDATE">
  <active>true</active>
  <name>before_script</name>
  <script><![CDATA[${SCRIPT}]]></script>
  <collection>incident</collection>
</sys_script>`

  it('captures the full CDATA content intact (no truncation)', () => {
    const parsed = parseUnloadXml(BR, 'sys_script')
    expect(parsed).not.toBeNull()
    expect(parsed!.fields.script).toBe(SCRIPT)
    // Explicitly prove the tag-looking substrings survived.
    expect(parsed!.fields.script).toContain('</record>')
    expect(parsed!.fields.script).toContain('</script>')
  })

  it('keeps subsequent fields in sync after a CDATA field (no desync)', () => {
    const parsed = parseUnloadXml(BR, 'sys_script')!
    expect(parsed.fields.name).toBe('before_script')
    // The field AFTER the CDATA must still be parsed correctly.
    expect(parsed.fields.collection).toBe('incident')
  })

  it('parseUnloadXmlAll: a CDATA script in record 1 does not break record 2', () => {
    const LIST = `<?xml version="1.0" encoding="UTF-8"?>
<unload unload_date="2026-07-25">
<sys_script action="INSERT_OR_UPDATE"><name>rec_one</name><script><![CDATA[${SCRIPT}]]></script><collection>incident</collection></sys_script>
<sys_script action="INSERT_OR_UPDATE"><name>rec_two</name><script><![CDATA[ var y = "</script>"; ]]></script><collection>problem</collection></sys_script>
</unload>`
    const all = parseUnloadXmlAll(LIST, 'sys_script')
    expect(all).toHaveLength(2)
    expect(all[0].fields.name).toBe('rec_one')
    expect(all[0].fields.script).toBe(SCRIPT)
    expect(all[0].fields.collection).toBe('incident')
    expect(all[1].fields.name).toBe('rec_two')
    expect(all[1].fields.script).toBe(' var y = "</script>"; ')
    expect(all[1].fields.collection).toBe('problem')
  })
})

describe('CDATA containing the record\'s OWN closing tag (record-boundary safety)', () => {
  // The nastiest case: a script whose CDATA literally contains the record's own
  // closing tag `</sys_script>` BEFORE the real end of the record. The outer
  // record-boundary matcher must skip over CDATA spans, or it terminates the
  // block at the fake tag and truncates the record (losing every later field).
  const EVIL_SCRIPT = ` var s = "</sys_script>"; gs.info("fake </sys_script> here"); `
  const BR = `<?xml version="1.0" encoding="UTF-8"?>
<sys_script action="INSERT_OR_UPDATE">
  <active>true</active>
  <script><![CDATA[${EVIL_SCRIPT}]]></script>
  <name>real_name</name>
</sys_script>`

  it('parses the whole record even when CDATA contains its own closing tag', () => {
    const parsed = parseUnloadXml(BR, 'sys_script')
    expect(parsed).not.toBeNull()
    // Full CDATA survives, including the fake `</sys_script>` text.
    expect(parsed!.fields.script).toBe(EVIL_SCRIPT)
    expect(parsed!.fields.script).toContain('</sys_script>')
    // The field AFTER the CDATA is still captured (record not truncated early).
    expect(parsed!.fields.name).toBe('real_name')
  })

  it('parseUnloadXmlAll: a self-closing-tag CDATA in record 1 does not break record 2', () => {
    const LIST = `<?xml version="1.0" encoding="UTF-8"?>
<unload unload_date="2026-07-25">
<sys_script action="INSERT_OR_UPDATE"><script><![CDATA[${EVIL_SCRIPT}]]></script><name>rec_one</name></sys_script>
<sys_script action="INSERT_OR_UPDATE"><script><![CDATA[ safe ]]></script><name>rec_two</name></sys_script>
</unload>`
    const all = parseUnloadXmlAll(LIST, 'sys_script')
    expect(all).toHaveLength(2)
    expect(all[0].fields.name).toBe('rec_one')
    expect(all[0].fields.script).toBe(EVIL_SCRIPT)
    expect(all[1].fields.name).toBe('rec_two')
    expect(all[1].fields.script).toBe(' safe ')
  })
})

describe('dedupeRecords', () => {
  it('collapses records sharing a sys_id (deep unload duplicates)', () => {
    const recs = [
      { table: 'incident', fields: { sys_id: 'a', number: 'INC1' } },
      { table: 'incident', fields: { sys_id: 'a', number: 'INC1' } },
      { table: 'incident', fields: { sys_id: 'b', number: 'INC2' } },
    ]
    const out = dedupeRecords(recs)
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.fields.sys_id)).toEqual(['a', 'b'])
  })

  it('keeps records that have no sys_id', () => {
    const recs = [
      { table: 'incident', fields: { number: 'INC1' } },
      { table: 'incident', fields: { number: 'INC2' } },
    ]
    expect(dedupeRecords(recs)).toHaveLength(2)
  })
})

describe('importableFields', () => {
  it('drops system-managed and auto-number fields', () => {
    const parsed = parseUnloadXml(XML, 'incident')!
    const imp = importableFields(parsed.fields)
    expect(imp.sys_id).toBeUndefined()
    expect(imp.sys_mod_count).toBeUndefined()
    // number is dropped so the copy gets a fresh one (no duplicate INC number).
    expect(imp.number).toBeUndefined()
    expect(imp.caller_id).toBe('def456')
  })

  it('drops sys_scope and sys_package (cross-instance scope safety)', () => {
    // Copying a scoped record verbatim can fail or silently land in an
    // unrelated app on the target instance; let the platform set scope/package.
    const imp = importableFields({
      sys_id: 'abc123',
      sys_scope: 'x_mfec_myapp',
      sys_package: 'pkg789',
      sys_domain: 'global',
      short_description: 'keep me',
    })
    expect(imp.sys_scope).toBeUndefined()
    expect(imp.sys_package).toBeUndefined()
    // Existing cross-instance drops still hold.
    expect(imp.sys_id).toBeUndefined()
    expect(imp.sys_domain).toBeUndefined()
    // Normal fields survive.
    expect(imp.short_description).toBe('keep me')
  })
})

describe('self-closing empty tags', () => {
  const SELF_CLOSED = `<?xml version="1.0" encoding="UTF-8"?>
<incident action="INSERT_OR_UPDATE">
  <short_description/>
  <number>INC0009</number>
  <close_notes />
</incident>`

  it('captures a self-closing tag as an empty string (present, not absent)', () => {
    const parsed = parseUnloadXml(SELF_CLOSED, 'incident')
    expect(parsed).not.toBeNull()
    // Present in the map with an empty string, distinguishable from absent.
    expect(parsed!.fields).toHaveProperty('short_description')
    expect(parsed!.fields.short_description).toBe('')
    // Self-closing with a space before the slash too.
    expect(parsed!.fields).toHaveProperty('close_notes')
    expect(parsed!.fields.close_notes).toBe('')
    // A normal paired tag mixed in is still parsed.
    expect(parsed!.fields.number).toBe('INC0009')
  })
})

describe('exported XML helpers', () => {
  it('unescapes entities including numeric ones', () => {
    expect(unescapeXml('a &lt;b&gt; &amp;c &#65; &#x42;')).toBe('a <b> &c A B')
  })

  it('extracts fields, including self-closing empties', () => {
    expect(extractFields('<name>x</name><suffix/><active>true</active>')).toEqual({
      name: 'x',
      suffix: '',
      active: 'true',
    })
  })

  it('takes CDATA bodies verbatim, even with a fake closing tag inside', () => {
    const inner = '<script><![CDATA[var s = "</script>";]]></script><name>n</name>'
    expect(extractFields(inner)).toEqual({ script: 'var s = "</script>";', name: 'n' })
  })

  it('splits record blocks by tag', () => {
    const xml = '<unload><rec><a>1</a></rec><rec><a>2</a></rec></unload>'
    expect(findRecordInners(xml, 'rec')).toEqual(['<a>1</a>', '<a>2</a>'])
  })
})
