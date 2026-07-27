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
