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
 *
 * NOTE — this is deliberately SHORTER than `xml.ts`'s `SYSTEM_FIELDS`, which also
 * strips `sys_class_name`, `sys_scope`, `sys_package`, `sys_domain` and
 * `sys_domain_path` because F3 copies arbitrary user records between instances,
 * where those values routinely name a class or scope the target does not have.
 * Here the input is not arbitrary: it is one pinned, vendored export, and every
 * one of those values in it is a no-op or already correct —
 *   - `sys_class_name` equals the record's own table in all 21 records,
 *   - `sys_scope` and `sys_package` are `global` in all 21 (and this installer is
 *     always run with `scope: 'global'`),
 *   - the 3 records carrying `sys_domain`/`sys_domain_path` use `global` / `/`.
 * Keeping them is what makes the installed records byte-comparable to a real
 * update-set import of the same file. `updateset-xml.test.ts` pins each of those
 * claims against the real file, so a re-vendor that breaks one fails the suite
 * rather than silently producing broken inserts.
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
var id = existed ? gr.update() : gr.insert();
if (!id) {
  gs.print('snJava: FAILED ' + ${JSON.stringify(rec.table)});
} else {
  gs.print('snJava: installed ' + ${JSON.stringify(rec.table)} + ' ' + id + (existed ? ' (updated)' : ' (inserted)'));
}`
}

/**
 * Outcome of one `buildInstallScript` run, read back from the background output.
 *
 * The success marker MUST carry a real 32-hex sys_id, and this parser is the only
 * thing allowed to declare success. Both `insert()` and `update()` return null on
 * failure (ACL, data policy, engine error), so the script prints `FAILED` in that
 * case and never the `installed` marker. That matters more than it looks: the
 * Script Include is installed LAST precisely so that "the Script Include exists"
 * is a truthful completeness marker for the whole 21-record set. A success gate
 * that passed on a failed write (e.g. matching the marker substring alone, or
 * printing a hardcoded sys_id regardless of the return value) would let record 7
 * of 21 vanish silently, then install the Script Include anyway — after which the
 * detection query returns true forever and the missing record is undetectable.
 */
export type InstallOutcome =
  | { status: 'installed'; table: string; sysId: string; updated: boolean }
  | { status: 'failed'; table: string }
  | { status: 'unrecognised' }

const INSTALLED_RE = /snJava: installed (\S+) ([0-9a-f]{32}) \((inserted|updated)\)/
const INSTALL_FAILED_RE = /snJava: FAILED (\S+)/

export function parseInstallResult(output: string): InstallOutcome {
  const ok = output.match(INSTALLED_RE)
  if (ok) {
    return { status: 'installed', table: ok[1], sysId: ok[2], updated: ok[3] === 'updated' }
  }
  const bad = output.match(INSTALL_FAILED_RE)
  if (bad) return { status: 'failed', table: bad[1] }
  return { status: 'unrecognised' }
}
