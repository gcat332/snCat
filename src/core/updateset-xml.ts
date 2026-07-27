/**
 * Parser for a ServiceNow UPDATE SET export.
 *
 * Different shape from the record unload XML that F3 handles (`xml.ts`): an
 * update-set export nests a second XML document inside each row —
 *   <unload> → <sys_update_xml> → <payload> → <record_update table="X"> → <X>
 * — where the payload is either CDATA-wrapped or entity-escaped depending on the
 * record. So this is a sibling of xml.ts, reusing its CDATA-aware helpers rather
 * than extending its parser.
 *
 * Used to install the vendored Add to Update Set Utility (see
 * public/vendor/README.md) on an instance that lacks it.
 */
import { extractFields, findRecordInners } from './xml'

export interface UpdateRecord {
  /** Human label from the export, e.g. 'Script Include'. */
  type: string
  /** The record's display name, e.g. 'addToUpdateSetUtils'. */
  targetName: string
  /** Target table the payload writes to, e.g. 'sys_script_include'. */
  table: string
  /** Original sys_id — preserved on insert so a later real import reconciles. */
  sysId: string
  /** Every field in the payload. */
  fields: Record<string, string>
}

const RECORD_UPDATE_TABLE = /<record_update\s[^>]*\btable="([^"]+)"/i

export function parseUpdateSetXml(text: string): UpdateRecord[] {
  const out: UpdateRecord[] = []
  for (const inner of findRecordInners(text, 'sys_update_xml')) {
    // extractFields handles both payload encodings: a CDATA body is taken
    // verbatim, an escaped body is unescaped exactly once — either way `payload`
    // comes back as real XML ready for a second parse.
    const row = extractFields(inner)
    const payload = row['payload']
    if (!payload) continue

    const m = payload.match(RECORD_UPDATE_TABLE)
    if (!m) continue
    const table = m[1]

    const [recordInner] = findRecordInners(payload, table)
    if (!recordInner) continue
    const fields = extractFields(recordInner)

    out.push({
      type: row['type'] ?? '',
      targetName: row['target_name'] ?? fields['name'] ?? '',
      table,
      sysId: fields['sys_id'] ?? '',
      fields,
    })
  }
  return out
}

/**
 * UTF-8-safe base64. `btoa` alone throws on any code point above U+00FF, and
 * these payloads carry Thai and typographic characters in descriptions.
 */
export function toBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/**
 * Fields the platform owns. Writing them is either rejected or misleading — the
 * install should look like what it is (a fresh insert by the current user), not
 * forge the original author and timestamps.
 */
export const INSTALL_SKIP_FIELDS = new Set([
  'sys_id',
  'sys_created_on',
  'sys_created_by',
  'sys_updated_on',
  'sys_updated_by',
  'sys_mod_count',
  'sys_update_name',
  'sys_recorded_at',
])

/**
 * Background script that inserts (or updates) one exported record, preserving
 * its original sys_id so a later real update-set import reconciles against the
 * same record instead of duplicating it.
 *
 * Every value is base64-encoded rather than embedded as a JS string literal.
 * The Script Include body alone is 212 KB of JavaScript containing quotes,
 * backslashes, newlines and `]]>` sequences; base64 removes that entire class of
 * escaping bug in one move.
 */
export function buildInstallScript(rec: UpdateRecord): string {
  const pairs = Object.entries(rec.fields)
    .filter(([k, v]) => !INSTALL_SKIP_FIELDS.has(k) && v !== undefined)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(toBase64Utf8(v))}`)
    .join(',\n')

  // Single-quoted so the table name reads as `new GlideRecord('table_name')`,
  // matching the idiom used throughout ServiceNow background scripts.
  const tableLiteral = `'${rec.table.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

  return `var enc = {
${pairs}
};
var gr = new GlideRecord(${tableLiteral});
var existed = gr.get(${JSON.stringify(rec.sysId)});
if (!existed) {
  gr.initialize();
  gr.setNewGuidValue(${JSON.stringify(rec.sysId)});
}
for (var k in enc) {
  gr.setValue(k, GlideStringUtil.base64Decode(enc[k]));
}
var id = existed ? (gr.update(), ${JSON.stringify(rec.sysId)}) : gr.insert();
gs.print('snJava: installed ' + ${JSON.stringify(rec.table)} + ' ' + id + (existed ? ' (updated)' : ' (inserted)'));`
}
