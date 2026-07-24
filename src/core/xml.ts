/**
 * Parse ServiceNow record unload XML (from `<table>.do?sys_id=..&XML`) into a
 * field map (F3 XML Mover). Regex-based (fields are XML-escaped text, no nested
 * same-tag elements) so it is pure and unit-testable without a DOM.
 */
export interface ParsedRecord {
  table: string
  fields: Record<string, string>
}

/** System-managed fields that should not be re-sent when importing a copy. */
export const SYSTEM_FIELDS = new Set([
  'sys_id',
  'sys_created_on',
  'sys_created_by',
  'sys_updated_on',
  'sys_updated_by',
  'sys_mod_count',
  'sys_tags',
  // Copying these across records/instances breaks inserts (class mismatch,
  // domain that doesn't exist here). Let the platform set them.
  'sys_class_name',
  'sys_domain',
  'sys_domain_path',
])

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

/**
 * Extract a record block's fields into a map. Handles `<tag><![CDATA[...]]></tag>`
 * fields explicitly: ServiceNow wraps script/HTML-bearing fields in CDATA so
 * their content isn't escaped, and that content can contain `</...>`-looking
 * substrings (e.g. a script string `"</script>"`). A plain non-greedy regex
 * would stop at that FIRST spurious closing tag, truncating the field and
 * desynchronizing every field after it. So for a CDATA field the body is taken
 * verbatim up to the FIRST `]]>` terminator (no XML-entity unescaping — CDATA
 * content is literal) and the scan resumes past the field's real `</tag>`,
 * making a `</tag>`-looking substring inside CDATA unable to end the field
 * early. Non-CDATA bodies keep the original entity-unescape path.
 */
function extractFields(inner: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const openRe = /<([a-zA-Z0-9_]+)(?:\s[^>]*)?>/g
  const CDATA_OPEN = '<![CDATA['
  const CDATA_CLOSE = ']]>'
  let m: RegExpExecArray | null
  while ((m = openRe.exec(inner))) {
    const tag = m[1]
    const contentStart = m.index + m[0].length
    const closeTag = `</${tag}>`
    if (inner.startsWith(CDATA_OPEN, contentStart)) {
      const bodyStart = contentStart + CDATA_OPEN.length
      const bodyEnd = inner.indexOf(CDATA_CLOSE, bodyStart)
      if (bodyEnd === -1) continue // malformed CDATA; skip this open tag
      fields[tag] = inner.slice(bodyStart, bodyEnd)
      const closeIdx = inner.indexOf(closeTag, bodyEnd + CDATA_CLOSE.length)
      openRe.lastIndex =
        closeIdx === -1 ? bodyEnd + CDATA_CLOSE.length : closeIdx + closeTag.length
    } else {
      const closeIdx = inner.indexOf(closeTag, contentStart)
      if (closeIdx === -1) continue // no matching close; skip this open tag
      fields[tag] = unescapeXml(inner.slice(contentStart, closeIdx))
      openRe.lastIndex = closeIdx + closeTag.length
    }
  }
  return fields
}

/** Extract the record's fields from its unload XML for the given table. */
export function parseUnloadXml(xml: string, table: string): ParsedRecord | null {
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = xml.match(new RegExp(`<${esc}\\b[^>]*>([\\s\\S]*?)</${esc}>`, 'i'))
  const inner = block ? block[1] : null
  if (!inner) return null

  return { table, fields: extractFields(inner) }
}

/**
 * Extract ALL records of the given table from an unload XML. A list export
 * (`<table>_list.do?...&XML`) wraps many `<table>` blocks in an `<unload>`
 * element; a single-record export has exactly one. Works for both.
 */
export function parseUnloadXmlAll(xml: string, table: string): ParsedRecord[] {
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const blockRe = new RegExp(`<${esc}\\b[^>]*>([\\s\\S]*?)</${esc}>`, 'gi')
  const out: ParsedRecord[] = []
  let block: RegExpExecArray | null
  while ((block = blockRe.exec(xml))) {
    const fields = extractFields(block[1])
    if (Object.keys(fields).length) out.push({ table, fields })
  }
  return out
}

/**
 * Collapse records that share a sys_id. A ServiceNow `&XML` unload is a DEEP
 * unload — it can emit the same record more than once (self-references, related
 * lists), which would otherwise be imported as duplicates.
 */
export function dedupeRecords(records: ParsedRecord[]): ParsedRecord[] {
  const seen = new Set<string>()
  const out: ParsedRecord[] = []
  for (const r of records) {
    const id = r.fields['sys_id']
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    out.push(r)
  }
  return out
}

/**
 * Fields dropped when importing a COPY (beyond the system fields): the record's
 * auto-number. Copying `number` verbatim makes every copy share the source's
 * number (e.g. INC0010571), which reads as a duplicate in any list — so drop it
 * and let ServiceNow assign a fresh one on insert.
 */
export const COPY_DROP_FIELDS = new Set([...SYSTEM_FIELDS, 'number'])

/** Drop system-managed + auto-number fields so an import creates a fresh record. */
export function importableFields(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (!COPY_DROP_FIELDS.has(k)) out[k] = v
  }
  return out
}
