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

/** Extract the record's fields from its unload XML for the given table. */
export function parseUnloadXml(xml: string, table: string): ParsedRecord | null {
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = xml.match(new RegExp(`<${esc}\\b[^>]*>([\\s\\S]*?)</${esc}>`, 'i'))
  const inner = block ? block[1] : null
  if (!inner) return null

  const fields: Record<string, string> = {}
  const fieldRe = /<([a-zA-Z0-9_]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = fieldRe.exec(inner))) {
    fields[m[1]] = unescapeXml(m[2])
  }
  return { table, fields }
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
    const inner = block[1]
    const fields: Record<string, string> = {}
    const fieldRe = /<([a-zA-Z0-9_]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g
    let m: RegExpExecArray | null
    while ((m = fieldRe.exec(inner))) fields[m[1]] = unescapeXml(m[2])
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

/** Drop system-managed fields so an import creates a fresh record safely. */
export function importableFields(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (!SYSTEM_FIELDS.has(k)) out[k] = v
  }
  return out
}
