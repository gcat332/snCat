# Add to Current Update Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the Inspect tab, force the open record — or every record in the current list filter — into the selected update set, installing the Add to Update Set Utility first if the instance doesn't have it.

**Architecture:** Two pure core modules. `update-set-add.ts` builds the background script that calls `new global.addToUpdateSetUtils().addToUpdateSet(gr)` per record and parses its output. `updateset-xml.ts` parses the bundled Share export (`<unload>` → `sys_update_xml` → CDATA payload → `<record_update>`) and builds a per-record install script. Both reuse the CDATA-aware regex helpers already in `xml.ts` so they stay Node-testable. Every write goes through the existing prod-guarded `runBackground`; field values are base64-encoded into the generated scripts because the Script Include body is 212 KB of JavaScript.

**Tech Stack:** TypeScript, Vitest, Chrome MV3, ServiceNow `sys.scripts.do` background scripts.

## Global Constraints

- New pure logic goes in `src/core/` with a colocated `*.test.ts`; no `chrome.*` in core.
- Every core file starts with a block comment explaining the module's role.
- Every write is prod-guarded — refused in the REST layer before any network I/O on a non-confirmed-sub-prod host. Do not add a second guard; use `runBackground`.
- The utility's Script Include keeps the exact name `addToUpdateSetUtils`. It is the API identifier the UI Action calls, not a display label — no `[MF-AI]` prefix, same carve-out as `sys_dictionary`/`sys_db_object` in `naming.ts:19`.
- An existing `addToUpdateSetUtils` is **never** modified or overwritten.
- The utility is global-scope. Its install forces `scope: 'global'` regardless of the scope bar.
- Batch size 50 records per background run. Above 200 records the confirm dialog requires a second explicit click. No silent caps.
- Commands: `npm test`, `npm run typecheck`, `npm run build`.

---

### Task 1: Vendor the update-set export

**Files:**
- Create: `src/assets/vendor/add-to-update-set-v9.5.xml` (copy of the supplied file)
- Create: `src/assets/vendor/README.md`
- Modify: `src/manifest.config.ts` (`web_accessible_resources`, if the build needs it)

- [ ] **Step 1: Copy the file in**

```bash
mkdir -p src/assets/vendor
cp ~/Downloads/Add_to_Update_Set_Global_v9.5.xml src/assets/vendor/add-to-update-set-v9.5.xml
```

- [ ] **Step 2: Write the attribution note**

```markdown
<!-- src/assets/vendor/README.md -->
# Vendored third-party content

## `add-to-update-set-v9.5.xml`

The **Add to Update Set Utility**, version 9.5 — a community utility published on
ServiceNow Share. It is vendored verbatim, exactly as exported; nothing in this
repo modifies it.

snJava uses one part of it: the `addToUpdateSetUtils` Script Include, whose
`addToUpdateSet(GlideRecord)` method forces an otherwise-untracked record into
the session's current update set. The Inspect tab's "Add to update set" button
calls that method, and offers to install this export when the instance does not
already have the Script Include.

All 21 records are installed, so an instance ends up equivalent to a manual
update-set import: the Script Include, the "Add to Update Set" UI Action, the
summary-message Business Rule, the Preferences module, and 16 properties.

**An existing `addToUpdateSetUtils` on the instance is never overwritten.** If
the real Share utility is already there, snJava calls it and leaves it alone.
```

- [ ] **Step 3: Verify the file loads as an extension resource**

Add a temporary check in the side panel DevTools console after the next build:

```js
await (await fetch(chrome.runtime.getURL('assets/vendor/add-to-update-set-v9.5.xml'))).text()
```

Run: `npm run build`, reload the unpacked extension, then run the snippet.
Expected: a ~298,000-character string starting with `<?xml version="1.0"`.
If it 404s, add `assets/vendor/*.xml` to `web_accessible_resources` in
`src/manifest.config.ts` and rebuild.

- [ ] **Step 4: Commit**

```bash
git add src/assets/vendor/ src/manifest.config.ts
git commit -m "chore: vendor Add to Update Set Utility v9.5 export with attribution"
```

---

### Task 2: Export the CDATA-aware XML helpers

**Files:**
- Modify: `src/core/xml.ts:33`, `xml.ts:56`, `xml.ts:105`
- Test: `src/core/xml.test.ts`

**Interfaces:**
- Produces: `unescapeXml`, `extractFields`, `findRecordInners` become exported from `xml.ts` with unchanged behaviour.

These three functions already handle the two traps in ServiceNow XML — a CDATA
body containing a fake closing tag, and self-closing empty elements. Task 3 needs
all three. Re-implementing them would mean re-hitting bugs that are already fixed
here, so they are exported rather than copied.

- [ ] **Step 1: Write the failing test**

Append to `src/core/xml.test.ts`:

```ts
import { extractFields, findRecordInners, unescapeXml } from './xml'

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/xml.test.ts`
Expected: FAIL — `unescapeXml is not exported`.

- [ ] **Step 3: Add the `export` keyword**

In `src/core/xml.ts`, change three declarations, touching nothing else:

- `function unescapeXml(` → `export function unescapeXml(`
- `function extractFields(` → `export function extractFields(`
- `function findRecordInners(` → `export function findRecordInners(`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/xml.test.ts && npm test`
Expected: all green — this is a visibility change only.

- [ ] **Step 5: Commit**

```bash
git add src/core/xml.ts src/core/xml.test.ts
git commit -m "refactor(xml): export the CDATA-aware parse helpers for reuse"
```

---

### Task 3: Parse the update-set export

**Files:**
- Create: `src/core/updateset-xml.ts`
- Test: `src/core/updateset-xml.test.ts`

**Interfaces:**
- Consumes: `extractFields`, `findRecordInners` (Task 2).
- Produces: `UpdateRecord { type, targetName, table, sysId, fields }` and
  `parseUpdateSetXml(text: string): UpdateRecord[]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/updateset-xml.test.ts
import { describe, it, expect } from 'vitest'
import { parseUpdateSetXml } from './updateset-xml'

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/updateset-xml.test.ts`
Expected: FAIL — `Failed to resolve import "./updateset-xml"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/updateset-xml.ts
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
 * src/assets/vendor/README.md) on an instance that lacks it.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/updateset-xml.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify against the real 298 KB file**

Add this test, which reads the vendored export directly (Vitest runs in Node, so
`fs` is available in the test file only — never in the module):

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('the vendored v9.5 export', () => {
  const recs = parseUpdateSetXml(
    readFileSync(join(__dirname, '../assets/vendor/add-to-update-set-v9.5.xml'), 'utf8'),
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
```

Run: `npx vitest run src/core/updateset-xml.test.ts`
Expected: PASS, 11 tests. If the record count differs from 21, stop and report —
do not adjust the expectation to match; the parser is what is under test.

- [ ] **Step 6: Commit**

```bash
git add src/core/updateset-xml.ts src/core/updateset-xml.test.ts
git commit -m "feat(updateset-xml): parse a ServiceNow update-set export"
```

---

### Task 4: Build the install script

**Files:**
- Modify: `src/core/updateset-xml.ts`
- Test: `src/core/updateset-xml.test.ts`

**Interfaces:**
- Consumes: `UpdateRecord` (Task 3).
- Produces: `toBase64Utf8(s: string): string`, `INSTALL_SKIP_FIELDS: Set<string>`,
  `buildInstallScript(rec: UpdateRecord): string`.

- [ ] **Step 1: Write the failing test**

Append to `src/core/updateset-xml.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/updateset-xml.test.ts`
Expected: FAIL — `buildInstallScript is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/core/updateset-xml.ts`:

```ts
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

  return `var enc = {
${pairs}
};
var gr = new GlideRecord(${JSON.stringify(rec.table)});
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/updateset-xml.test.ts && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/core/updateset-xml.ts src/core/updateset-xml.test.ts
git commit -m "feat(updateset-xml): build a base64-safe per-record install script"
```

---

### Task 5: Build the add-to-update-set script

**Files:**
- Create: `src/core/update-set-add.ts`
- Test: `src/core/update-set-add.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ADD_BATCH_SIZE` (50), `BULK_CONFIRM_THRESHOLD` (200),
  `buildAddToUpdateSetScript(table: string, sysIds: string[]): string`,
  `parseAddResult(output: string): { added: number; missing: number } | null`,
  `batchSysIds(sysIds: string[]): string[][]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/update-set-add.test.ts
import { describe, it, expect } from 'vitest'
import {
  ADD_BATCH_SIZE,
  batchSysIds,
  buildAddToUpdateSetScript,
  parseAddResult,
} from './update-set-add'

const ID = '6816f79cc0a8016401c5a33be04be441'

describe('buildAddToUpdateSetScript', () => {
  it('calls the utility once per record on the given table', () => {
    const s = buildAddToUpdateSetScript('incident', [ID])
    expect(s).toContain("new GlideRecord('incident')")
    expect(s).toContain('new global.addToUpdateSetUtils()')
    expect(s).toContain('addToUpdateSet(gr)')
    expect(s).toContain(ID)
  })

  it('does not emit the UI Action bindings, which do not exist here', () => {
    const s = buildAddToUpdateSetScript('incident', [ID])
    expect(s).not.toContain('action.setRedirectURL')
    expect(s).not.toContain('GlideSession.get().getStack()')
    expect(s).not.toMatch(/\bcurrent\b/)
  })

  it('counts records that no longer exist separately', () => {
    expect(buildAddToUpdateSetScript('incident', [ID])).toContain('missing')
  })

  it('rejects a table name that is not a plain identifier', () => {
    expect(() => buildAddToUpdateSetScript("incident'; gs.print('x", [ID])).toThrow()
  })

  it('rejects a sys_id that is not 32 hex characters', () => {
    expect(() => buildAddToUpdateSetScript('incident', ['not-a-sys-id'])).toThrow()
  })
})

describe('parseAddResult', () => {
  it('reads the counts from the background output', () => {
    expect(parseAddResult('*** Script: snJava: added 37, missing 2')).toEqual({
      added: 37,
      missing: 2,
    })
  })

  it('returns null when the marker is absent', () => {
    expect(parseAddResult('java.lang.NullPointerException')).toBeNull()
  })
})

describe('batchSysIds', () => {
  it('splits into batches of ADD_BATCH_SIZE', () => {
    const ids = Array.from({ length: 120 }, (_, i) => String(i).padStart(32, '0'))
    const batches = batchSysIds(ids)
    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(ADD_BATCH_SIZE)
    expect(batches[2]).toHaveLength(20)
  })

  it('returns no batches for an empty list', () => {
    expect(batchSysIds([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/update-set-add.test.ts`
Expected: FAIL — `Failed to resolve import "./update-set-add"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/update-set-add.ts
/**
 * Forces records into the session's current update set via the Add to Update Set
 * Utility's Script Include.
 *
 * The originating snippet is that utility's UI ACTION script:
 *   new global.addToUpdateSetUtils().addToUpdateSet(current);
 *   action.setRedirectURL(GlideSession.get().getStack().bottom());
 * Neither `current` nor `action` exists in a background script, so this module
 * builds the equivalent — an explicit GlideRecord per sys_id — and drops the
 * redirect, which is UI Action plumbing with no meaning outside a form.
 */

/** Records per background run, keeping each run inside the sys.scripts.do timeout. */
export const ADD_BATCH_SIZE = 50
/** Above this, the confirm dialog demands a second explicit click. */
export const BULK_CONFIRM_THRESHOLD = 200

const TABLE_RE = /^[a-z0-9_]+$/i
const SYS_ID_RE = /^[0-9a-f]{32}$/i

/**
 * The table name and sys_ids are interpolated into executable server-side code,
 * so they are validated as strict identifiers rather than escaped. Anything that
 * is not a plain table name or a 32-hex sys_id is a bug or an injection attempt;
 * either way it must not reach the instance.
 */
export function buildAddToUpdateSetScript(table: string, sysIds: string[]): string {
  if (!TABLE_RE.test(table)) throw new Error(`Refusing to run: invalid table name "${table}"`)
  for (const id of sysIds) {
    if (!SYS_ID_RE.test(id)) throw new Error(`Refusing to run: invalid sys_id "${id}"`)
  }

  return `var ids = ${JSON.stringify(sysIds)};
var util = new global.addToUpdateSetUtils();
var added = 0, missing = 0;
for (var i = 0; i < ids.length; i++) {
  var gr = new GlideRecord(${JSON.stringify(table)});
  if (gr.get(ids[i])) {
    util.addToUpdateSet(gr);
    added++;
  } else {
    missing++;
  }
}
gs.print('snJava: added ' + added + ', missing ' + missing);`
}

export function parseAddResult(output: string): { added: number; missing: number } | null {
  const m = output.match(/snJava: added (\d+), missing (\d+)/)
  return m ? { added: Number(m[1]), missing: Number(m[2]) } : null
}

export function batchSysIds(sysIds: string[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < sysIds.length; i += ADD_BATCH_SIZE) {
    out.push(sysIds.slice(i, i + ADD_BATCH_SIZE))
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/update-set-add.test.ts && npm test`
Expected: all green, 9 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/update-set-add.ts src/core/update-set-add.test.ts
git commit -m "feat(update-set-add): build and parse the add-to-update-set background run"
```

---

### Task 6: Side panel — the button, detection and install flow

**Files:**
- Modify: `src/sidepanel/index.html` (Inspect panel, the `#xml-row` button row)
- Modify: `src/sidepanel/main.ts`

**Interfaces:**
- Consumes: `buildAddToUpdateSetScript`, `parseAddResult`, `batchSysIds`, `BULK_CONFIRM_THRESHOLD` (Task 5); `parseUpdateSetXml`, `buildInstallScript` (Tasks 3–4); existing `checkTarget()` (`main.ts:231`), `runBackground`, `extractBgOutput` (`main.ts:1895`), `confirmDialog` (`main.ts:1248`), `showToast` (`main.ts:1275`), `getListQueryFromPage` (`main.ts:415`), `currentListQuery` (`main.ts:394`), `isListView` (`main.ts:390`), `queryRecords`.
- Produces: nothing downstream.

`main.ts` has no unit-test harness; verification is `npm run typecheck`,
`npm run build` and the manual smoke steps.

- [ ] **Step 1: Add the button to the markup**

In `src/sidepanel/index.html`, inside the existing `#xml-row` div, after the
`#xml-view` button, add:

```html
            <button class="btn btn-ghost" id="us-add" type="button" disabled
              title="Force this record into the selected update set">Add to update set</button>
```

- [ ] **Step 2: Add the imports and handles**

In `src/sidepanel/main.ts`:

```ts
import {
  batchSysIds,
  buildAddToUpdateSetScript,
  parseAddResult,
  BULK_CONFIRM_THRESHOLD,
} from '@core/update-set-add'
import { buildInstallScript, parseUpdateSetXml } from '@core/updateset-xml'
```

Next to `const xmlView = …` (around `main.ts:375`), add:

```ts
const usAdd = el<HTMLButtonElement>('us-add')
```

- [ ] **Step 3: Implement target-record resolution and the utility check**

Add after the existing XML copy/paste section in `main.ts`:

```ts
/* ---------- Add to current update set ---------- */

/** The sys_ids to act on: the open record, or every record in the list filter. */
async function updateSetTargets(): Promise<{ table: string; sysIds: string[] } | null> {
  if (!current?.table) return null
  const { host, table, sysId } = current
  if (sysId) return { table, sysIds: [sysId] }
  if (!isListView()) return null

  const live = await getListQueryFromPage(table)
  const query = live !== null ? live : currentListQuery()
  const res = await queryRecords(host, table, {
    query,
    fields: ['sys_id'],
    limit: 10_000,
  })
  if (!res.ok) return null
  return { table, sysIds: res.data.map((r) => cellValue(r['sys_id'])).filter(Boolean) }
}

/** True when the instance already has the utility's Script Include. */
async function hasAddToUpdateSetUtils(host: string): Promise<boolean> {
  const res = await queryRecords(host, 'sys_script_include', {
    query: 'name=addToUpdateSetUtils',
    fields: ['sys_id'],
    limit: 1,
  })
  return res.ok && res.data.length > 0
}

/** Read the vendored export and parse it. Cached for the panel's lifetime. */
let vendoredUtilityCache: import('@core/updateset-xml').UpdateRecord[] | null = null
async function loadVendoredUtility() {
  if (vendoredUtilityCache) return vendoredUtilityCache
  const url = chrome.runtime.getURL('assets/vendor/add-to-update-set-v9.5.xml')
  const text = await (await fetch(url)).text()
  vendoredUtilityCache = parseUpdateSetXml(text)
  return vendoredUtilityCache
}
```

- [ ] **Step 4: Implement the install**

```ts
/**
 * Install the vendored Add to Update Set Utility. Global scope is forced: the
 * Script Include is `global.addToUpdateSetUtils`, so installing it into whatever
 * app the scope bar happens to name would produce an unreachable copy.
 *
 * Returns true when every record landed.
 */
async function installUpdateSetUtility(
  host: string,
  updateSet: string | undefined,
): Promise<boolean> {
  const records = await loadVendoredUtility()
  const summary = `${records.length} records · ${[...new Set(records.map((r) => r.type))].join(', ')}`
  const ok = await confirmDialog(
    `addToUpdateSetUtils was not found on ${host}.\n\n` +
      `Install Add to Update Set Utility v9.5?\n${summary}\n\n` +
      `Records are created in the GLOBAL scope and captured by the selected update set. ` +
      `This is a promotable change.`,
  )
  if (!ok) return false

  let done = 0
  for (const rec of records) {
    usAdd.textContent = `Installing ${++done}/${records.length}…`
    const res = await runBackground(host, buildInstallScript(rec), { scope: 'global', updateSet })
    const out = res.ok ? extractBgOutput(res.data) : (res.error ?? '')
    if (!res.ok || !out.includes('snJava: installed')) {
      xmlOut.replaceChildren(
        elText('div', 'error', `Install failed on ${rec.type} "${rec.targetName}": ${out.slice(0, 400)}`),
      )
      return false
    }
  }
  showToast(`Installed Add to Update Set Utility (${records.length} records)`)
  return true
}
```

- [ ] **Step 5: Implement the button handler**

```ts
async function addToUpdateSet() {
  if (!current) return
  const host = current.host

  const targets = await updateSetTargets()
  if (!targets || targets.sysIds.length === 0) {
    xmlOut.replaceChildren(elText('div', 'error', 'Open a record, or a list with matching records.'))
    return
  }

  // Pin the target before any dialog so a tab switch cannot retarget the write.
  const tgt = await checkTarget()
  if (!tgt) return

  const n = targets.sysIds.length
  const usText = tgt.usLabel ? `update set "${tgt.usLabel}"` : 'the current update set'
  if (!(await confirmDialog(`Add ${n} record${n === 1 ? '' : 's'} from \`${targets.table}\` to ${usText} on ${host}?`))) {
    return
  }
  if (n > BULK_CONFIRM_THRESHOLD) {
    if (!(await confirmDialog(`That is ${n} records — more than ${BULK_CONFIRM_THRESHOLD}. Confirm once more to proceed.`))) {
      return
    }
  }

  usAdd.disabled = true
  const originalLabel = usAdd.textContent
  try {
    if (!(await hasAddToUpdateSetUtils(host))) {
      if (!(await installUpdateSetUtility(host, tgt.opts.updateSet))) return
    }

    const batches = batchSysIds(targets.sysIds)
    let added = 0
    let missing = 0
    for (let i = 0; i < batches.length; i++) {
      usAdd.textContent = `Adding ${i + 1}/${batches.length}…`
      const script = buildAddToUpdateSetScript(targets.table, batches[i])
      const res = await runBackground(host, script, tgt.opts)
      if (!res.ok) {
        xmlOut.replaceChildren(elText('div', 'error', res.error ?? 'Background run failed.'))
        return
      }
      const out = extractBgOutput(res.data)
      const parsed = parseAddResult(out)
      if (!parsed) {
        xmlOut.replaceChildren(elText('div', 'error', `Unexpected output: ${out.slice(0, 400)}`))
        return
      }
      added += parsed.added
      missing += parsed.missing
    }

    const lines = [`Added ${added} record${added === 1 ? '' : 's'} to ${usText}.`]
    if (missing > 0) lines.push(`${missing} record${missing === 1 ? '' : 's'} no longer exist and were skipped.`)
    xmlOut.replaceChildren(...lines.map((l) => elText('div', 'empty', l)))
    showToast(`Added ${added} to update set ✓`)
  } finally {
    usAdd.disabled = false
    usAdd.textContent = originalLabel
  }
}
```

- [ ] **Step 6: Wire the enabled state and the listener**

At the end of `refreshXmlControls()` (`main.ts:463`), which already computes
`formHas` and `listHas`, append:

```ts
  // Add to update set: a form record is always exactly one; a list needs a
  // count so the button can say how many it would capture. countRecords is one
  // lightweight aggregate call and only runs on list views.
  usAdd.disabled = !(formHas || listHas)
  usAdd.textContent = 'Add to update set'
  if (listHas && current?.table) {
    const live = await getListQueryFromPage(current.table)
    const query = (live !== null ? live : currentListQuery()) || undefined
    const res = await countRecords(current.host, current.table, query)
    if (res.ok) {
      usAdd.textContent = `Add to update set (${res.data.count})`
      usAdd.disabled = res.data.count === 0
    }
  }
```

Next to `xmlPaste.addEventListener(…)` (`main.ts:3164`), add:

```ts
usAdd.addEventListener('click', () => void addToUpdateSet())
```

- [ ] **Step 7: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 8: Manual smoke — instance that already has the utility**

1. Reload the unpacked extension from `dist/`.
2. Pick an update set in the scope bar.
3. Open an `incident` record → Inspect → **Add to update set**.
4. Expected: one confirm naming the record count, table, update set and host;
   then `Added 1 record to update set "…"`.
5. In ServiceNow, open that update set and confirm a `sys_update_xml` row for the
   incident exists.

- [ ] **Step 9: Manual smoke — instance without the utility**

1. On an instance with no `addToUpdateSetUtils`, click **Add to update set**.
2. Expected: the install dialog appears naming 21 records and the global scope.
3. Confirm. The button label counts `Installing 1/21…` through `21/21`, then the
   add proceeds automatically in the same click.
4. Verify in ServiceNow: `sys_script_include` has `addToUpdateSetUtils` with a
   ~212 KB script, the 8 `addToUpdateSetUtils.*` properties exist, and the
   "Add to Update Set" UI Action appears on forms.
5. **Check the 212 KB base64 round-trip explicitly** — open the Script Include and
   confirm the body is intact JavaScript, not truncated or mangled. Compare its
   length against `src/assets/vendor/add-to-update-set-v9.5.xml`'s payload.
6. Click **Add to update set** again — the install must NOT re-run.

- [ ] **Step 10: Manual smoke — list mode and the prod guard**

1. Open a filtered `incident` list with ~10 records. The button reads
   `Add to update set (10)`. Run it; confirm 10 rows land in the update set.
2. Point the extension at a host the prod guard treats as production and click
   the button. Expected: refused with a prod-guard message, and **no** network
   write — confirm in the Network tab that no `sys.scripts.do` request was sent.

- [ ] **Step 11: Commit**

```bash
git add src/sidepanel/index.html src/sidepanel/main.ts
git commit -m "feat(inspect): add records to the current update set, installing the utility if absent"
```

---

### Task 7: Document the feature

**Files:**
- Modify: `README.md` (the `## Tabs` section, Inspect entry)

- [ ] **Step 1: Add the entry**

```markdown
**Add to update set.** Forces the open record — or every record in the current
list filter — into the update set selected in the header, using the Add to Update
Set Utility's `addToUpdateSetUtils` Script Include. Prod-guarded like every other
write. If the instance does not have the Script Include, snJava offers to install
the vendored v9.5 export (21 records, global scope, see
`src/assets/vendor/README.md`) and then continues; an existing
`addToUpdateSetUtils` is never overwritten. Records are processed 50 per
background run, and more than 200 requires a second confirmation.
```

- [ ] **Step 2: Verify the whole suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe add-to-update-set and the bundled utility installer"
```

---

## Smoke-test checklist (not covered by unit tests)

- [ ] Single record on an instance that already has the utility
- [ ] Install path: all 21 records land, in the global scope, captured by the selected update set
- [ ] The 212 KB Script Include survives the base64 round-trip intact
- [ ] Non-ASCII text in a property description survives `GlideStringUtil.base64Decode`
- [ ] Second click does not re-install
- [ ] A pre-existing `addToUpdateSetUtils` is left untouched
- [ ] List mode with >50 records batches correctly and reports one total
- [ ] Prod guard refuses the write with no network I/O
