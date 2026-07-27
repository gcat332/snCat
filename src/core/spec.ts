/**
 * F1 spec composer (handoff §3, §7 decision 2 — template-driven, LLM-free).
 *
 * Turns the walked artifacts into a structured SpecDocument following the fixed
 * skeleton: Overview → Data Model → Logic → Integration Points → Security/ACL.
 * Pure and testable; renderers (HTML/docx) consume this model.
 */
import type { ArtifactRef } from './graph'

export type SpecBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'subheading'; level: 2 | 3; text: string }
  | { kind: 'keyvalue'; rows: { key: string; value: string }[] }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'code'; caption?: string; code: string; lang?: 'javascript' | 'text' }
  | { kind: 'list'; items: string[] }

export interface SpecSection {
  heading: string
  blocks: SpecBlock[]
}

export interface SpecDocument {
  title: string
  subtitle: string
  meta: { key: string; value: string }[]
  sections: SpecSection[]
  /** Optional AI-drafted narrative overview, rendered as a labeled block by both renderers. */
  aiOverview?: string
}

export interface ComposeInput {
  instance: string
  rootTable: string
  rootLabel: string
  rootFields: Record<string, string>
  /** All discovered artifacts EXCLUDING the root. */
  artifacts: ArtifactRef[]
  /** Primary data table whose schema is documented in Data Model. */
  primaryTable?: string
  /** Dictionary fields of the primary table. */
  schema?: SpecSchemaField[]
  /** Optional AI-drafted narrative overview to pass through onto the SpecDocument. */
  aiOverview?: string
  /**
   * Set when the document describes a whole application rather than a record or
   * table. Overrides the title/subtitle/meta and suppresses the table-specific
   * REST API section.
   */
  scope?: { label: string; prefix: string }
}

export interface SpecSchemaField {
  element: string
  type: string
  label: string
  reference: string
  mandatory: string
  maxLength: string
  defaultValue: string
}

const TYPE_LABEL: Record<string, string> = {
  sys_script: 'Business Rule',
  sc_cat_item: 'Catalog Item',
  sys_script_include: 'Script Include',
  sys_transform_map: 'Transform Map',
}

function byType(artifacts: ArtifactRef[], type: string): ArtifactRef[] {
  return artifacts.filter((a) => a.type === type)
}

/** Human-readable name for a table/module id: "change_request" → "Change Request". */
function titleCase(name: string): string {
  return name
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function emptyNote(text: string): SpecBlock {
  return { kind: 'paragraph', text }
}

export function composeSpec(input: ComposeInput): SpecDocument {
  const { instance, rootTable, rootLabel, rootFields, artifacts, primaryTable, schema } = input
  const rootKind = TYPE_LABEL[rootTable] ?? rootTable
  // A "table spec" documents the whole table/module; a "record spec" documents a
  // single customization record (BR, Script Include, Catalog Item, Transform Map).
  const isTableSpec = !TYPE_LABEL[rootTable]
  // In scope mode there is no primary table: rootTable is the synthetic
  // 'sys_scope' root and primaryTable is deliberately '' (not undefined), so
  // `primaryTable ?? rootTable` would silently fall through to 'sys_scope'
  // ('??' doesn't catch empty string). Every consumer of `table` below is
  // scope-gated already (dataModelSection only prints it inside an
  // `if (schema.length)` guard, which is empty for scope; apiSpecSection is
  // omitted entirely for scope — see the sections array below), so make the
  // "no primary table in scope mode" fact explicit rather than accidental.
  const table = input.scope ? '' : (primaryTable ?? rootTable)
  const tableDisplay = titleCase(table)

  const title = input.scope ? input.scope.label : isTableSpec ? tableDisplay : rootLabel || rootKind
  const subtitle = input.scope
    ? 'Application Design Specification'
    : isTableSpec
      ? 'Table / Module Design Specification'
      : `${rootKind} · Design Specification`

  const meta = input.scope
    ? [
        { key: 'Instance', value: instance },
        { key: 'Application', value: `${input.scope.label} (${input.scope.prefix})` },
        { key: 'Artifacts documented', value: String(artifacts.length) },
      ]
    : isTableSpec
      ? [
          { key: 'Instance', value: instance },
          { key: 'Table', value: `${tableDisplay} (${table})` },
          { key: 'Artifacts documented', value: String(artifacts.length) },
        ]
      : [
          { key: 'Instance', value: instance },
          { key: 'Artifact type', value: rootKind },
          { key: 'Table', value: `${titleCase(rootTable)} (${rootTable})` },
          { key: 'sys_id', value: rootFields['sys_id'] ?? '' },
          { key: 'Artifacts included', value: String(artifacts.length + 1) },
        ]

  return {
    title,
    subtitle,
    meta,
    aiOverview: input.aiOverview,
    sections: [
      overviewSection(rootKind, isTableSpec ? tableDisplay : rootLabel, instance, rootFields, isTableSpec, input.scope),
      dataModelSection(table, rootFields, artifacts, schema, input.scope),
      logicSection(rootFields, artifacts, isTableSpec ? '' : `${rootKind}: ${rootLabel || rootKind}`),
      integrationSection(artifacts),
      securitySection(artifacts),
      // The Table API section documents ONE table's endpoints; an application
      // spans many, so it is omitted rather than emitted against a nonsense path.
      ...(input.scope ? [] : [apiSpecSection(instance, table, schema)]),
    ],
  }
}

/**
 * REST API reference for the primary table, using ServiceNow's standard Table
 * API (/api/now/table/{table}). Documents the CRUD endpoints, common query
 * parameters, and a sample JSON payload derived from the table schema.
 */
function apiSpecSection(instance: string, table: string, schema?: SpecSchemaField[]): SpecSection {
  const host = instance.startsWith('http') ? instance.replace(/\/+$/, '') : `https://${instance}`
  const base = `${host}/api/now/table/${table}`
  const blocks: SpecBlock[] = [
    {
      kind: 'paragraph',
      text: `The "${table}" table is exposed through the ServiceNow REST Table API. All requests require authentication (Basic auth or an OAuth 2.0 bearer token) and honor the caller's ACLs. Set the headers "Accept: application/json" and, for writes, "Content-Type: application/json".`,
    },
    { kind: 'subheading', level: 2, text: 'Endpoints' },
    {
      kind: 'table',
      columns: ['Method', 'Path', 'Purpose'],
      rows: [
        ['GET', `/api/now/table/${table}`, 'List / query records'],
        ['GET', `/api/now/table/${table}/{sys_id}`, 'Retrieve a single record'],
        ['POST', `/api/now/table/${table}`, 'Create a record'],
        ['PUT', `/api/now/table/${table}/{sys_id}`, 'Replace a record'],
        ['PATCH', `/api/now/table/${table}/{sys_id}`, 'Update selected fields'],
        ['DELETE', `/api/now/table/${table}/{sys_id}`, 'Delete a record'],
      ],
    },
    { kind: 'subheading', level: 2, text: 'Common query parameters' },
    {
      kind: 'table',
      columns: ['Parameter', 'Description', 'Example'],
      rows: [
        ['sysparm_query', 'Encoded query string (same syntax as a list filter).', 'active=true^ORDERBYnumber'],
        ['sysparm_fields', 'Comma-separated list of fields to return.', 'sys_id,number,short_description'],
        ['sysparm_display_value', 'Return display values (true), raw values (false), or both.', 'all'],
        ['sysparm_limit', 'Maximum number of records to return.', '100'],
        ['sysparm_offset', 'Row offset for pagination.', '0'],
        ['sysparm_exclude_reference_link', 'Omit reference link metadata.', 'true'],
      ],
    },
    { kind: 'subheading', level: 2, text: 'Example — list records' },
    {
      kind: 'code',
      lang: 'text',
      caption: 'GET (query)',
      code: `curl -s -u "USER:PASS" \\
  -H "Accept: application/json" \\
  "${base}?sysparm_limit=10&sysparm_display_value=all"`,
    },
  ]

  // Sample create payload from the schema (skip read-only system columns).
  if (schema && schema.length) {
    const SKIP = new Set([
      'sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by',
      'sys_mod_count', 'sys_tags', 'sys_class_name', 'sys_domain', 'sys_domain_path',
    ])
    const sample = schema
      .filter((f) => f.element && !SKIP.has(f.element))
      .slice(0, 12)
      .map((f) => `  ${JSON.stringify(f.element)}: ${JSON.stringify(sampleValue(f))}`)
      .join(',\n')
    blocks.push({ kind: 'subheading', level: 2, text: 'Example — create a record' })
    blocks.push({
      kind: 'code',
      lang: 'javascript',
      caption: `POST ${base}`,
      code: `// Request body (application/json)\n{\n${sample}\n}`,
    })
  }

  return { heading: 'REST API (Table API)', blocks }
}

/** A placeholder value for a schema field, keyed off its type. */
function sampleValue(f: SpecSchemaField): string {
  if (f.defaultValue) return f.defaultValue
  const t = (f.type || '').toLowerCase()
  if (f.reference) return '<sys_id of ' + f.reference + '>'
  if (t.includes('boolean')) return 'true'
  if (t.includes('integer') || t.includes('decimal') || t.includes('numeric')) return '0'
  if (t.includes('date') || t.includes('glide_date')) return 'YYYY-MM-DD hh:mm:ss'
  if (t.includes('choice')) return '<choice value>'
  return `<${f.label || f.element}>`
}

function overviewSection(
  kind: string,
  label: string,
  instance: string,
  f: Record<string, string>,
  isTableSpec: boolean,
  scope?: { label: string; prefix: string },
): SpecSection {
  const rows: { key: string; value: string }[] = []
  const add = (k: string, v?: string) => {
    if (v) rows.push({ key: k, value: v })
  }
  if (scope) {
    add('Application', scope.label)
    add('Scope', scope.prefix)
  } else if (isTableSpec) {
    add('Table', label)
    add('Application', f['sys_scope'])
  } else {
    add('Name', f['name'] || label)
    add('When', f['when'])
    add('Order', f['order'])
    add('Active', f['active'])
    add('Table / Collection', f['collection'])
    add('Application', f['sys_scope'])
    add('Short description', f['short_description'])
  }

  const intro = scope
    ? `This Design Specification documents the "${scope.label}" application (${scope.prefix}) on ${instance} — every configuration record scoped to it: tables, business rules, client scripts, script includes, UI policies, UI actions, ACLs, notifications, data policies, catalog items and transform maps. It is a flat inventory of the application's contents rather than a dependency walk, so configuration this application depends on that lives outside its scope is not included.`
    : isTableSpec
      ? `This Design Specification documents the "${label}" table on ${instance} — its data model (fields), business rules, client scripts, UI policies, notifications, and security (ACLs / data policies).`
      : `This Design Specification documents the ${kind} "${label}" on ${instance}, together with the related configuration it depends on (scripts, policies, and security).`

  return {
    heading: 'Overview',
    blocks: [
      { kind: 'paragraph', text: intro },
      rows.length ? { kind: 'keyvalue', rows } : emptyNote('No overview metadata available.'),
    ],
  }
}

function dataModelSection(
  primaryTable: string,
  rootFields: Record<string, string>,
  artifacts: ArtifactRef[],
  schema?: SpecSchemaField[],
  scope?: { label: string; prefix: string },
): SpecSection {
  const blocks: SpecBlock[] = []

  // The primary table's own schema (fields) — the core of the data model.
  if (schema && schema.length) {
    blocks.push({ kind: 'paragraph', text: `Primary table: ${primaryTable} (${schema.length} fields).` })
    blocks.push({
      kind: 'table',
      columns: ['Field', 'Type', 'Label', 'References', 'Mandatory', 'Max', 'Default'],
      rows: schema.map((f) => [
        f.element,
        f.type,
        f.label,
        f.reference,
        f.mandatory === 'true' ? 'yes' : '',
        f.maxLength,
        f.defaultValue,
      ]),
    })
  }

  const variables = byType(artifacts, 'variable')
  if (variables.length) {
    blocks.push({
      kind: 'table',
      columns: ['Variable', 'Question', 'Type', 'Mandatory'],
      rows: variables.map((v) => [
        v.fields['name'] ?? '',
        v.fields['question_text'] ?? '',
        v.fields['type'] ?? '',
        v.fields['mandatory'] ?? '',
      ]),
    })
  }

  const varSets = byType(artifacts, 'variable_set')
  if (varSets.length) {
    blocks.push({
      kind: 'list',
      items: varSets.map((v) => v.label || v.fields['variable_set'] || v.sysId),
    })
  }

  const tables = byType(artifacts, 'table')
  if (tables.length) {
    blocks.push({
      kind: 'table',
      columns: ['Related table', 'Name', 'Extends'],
      rows: tables.map((t) => [t.label, t.fields['name'] ?? '', t.fields['super_class'] ?? '']),
    })
  }

  // Catalog Items (scope-sweep only today — a record/table walk never discovers
  // OTHER catalog items, only the root's own variables/UI policies/etc via
  // resolveCatalogItem). Listed here, alongside the other structural/data-model
  // inventory (tables, variables), rather than in Logic: a catalog item's own
  // page-layout/behavior is what Logic already documents when it IS the root;
  // this is just the inventory of which catalog items exist in the application.
  const catalogItems = byType(artifacts, 'catalog_item')
  if (catalogItems.length) {
    blocks.push({ kind: 'subheading', level: 2, text: `Catalog Items (${catalogItems.length})` })
    blocks.push({
      kind: 'table',
      columns: ['Catalog Item', 'Category', 'Active', 'Workflow'],
      rows: catalogItems.map((c) => [
        c.label || c.fields['name'] || '',
        c.fields['category'] ?? '',
        c.fields['active'] ?? '',
        c.fields['workflow'] ?? '',
      ]),
    })
  }

  if (!blocks.length) {
    blocks.push(
      scope
        ? emptyNote('No tables are defined in this application.')
        : emptyNote(`Primary table: ${rootFields['collection'] || primaryTable}. No additional data-model artifacts were discovered within the depth limit.`),
    )
  }
  return { heading: 'Data Model', blocks }
}

/**
 * A detail key/value block. Empty values are dropped, EXCEPT "Description",
 * which is always shown (blank when empty) so authors can fill it in.
 */
function detailBlock(pairs: [string, string | undefined][]): SpecBlock {
  const rows = pairs
    .filter(([key, v]) => key === 'Description' || (v && v.trim()))
    .map(([key, value]) => ({ key, value: value && value.trim() ? value : '' }))
  return { kind: 'keyvalue', rows }
}

function logicSection(rootFields: Record<string, string>, artifacts: ArtifactRef[], rootTitle: string): SpecSection {
  const blocks: SpecBlock[] = []

  // If the spec's ROOT is itself a script record, document it first, by name.
  const rootScript = rootFields['script']
  const rootCond = rootFields['condition'] || rootFields['filter_condition']
  if (rootScript || rootCond) {
    blocks.push({ kind: 'subheading', level: 2, text: rootTitle || 'Primary logic' })
    if (rootFields['description']) blocks.push({ kind: 'paragraph', text: rootFields['description'] })
    if (rootCond) blocks.push({ kind: 'code', caption: 'Condition', code: rootCond, lang: 'text' })
    if (rootScript) blocks.push({ kind: 'code', caption: 'Script', code: rootScript, lang: 'javascript' })
  }

  // Business Rules
  const brs = byType(artifacts, 'business_rule')
  if (brs.length) {
    blocks.push({ kind: 'subheading', level: 2, text: `Business Rules (${brs.length})` })
    for (const br of brs) {
      const acts = (['insert', 'update', 'delete', 'query'] as const).filter((a) => br.fields[`action_${a}`] === 'true')
      blocks.push({ kind: 'subheading', level: 3, text: br.label })
      blocks.push(
        detailBlock([
          ['When', br.fields['when']],
          ['Order', br.fields['order']],
          ['Runs on', acts.join(', ')],
          ['Active', br.fields['active']],
          ['Description', br.fields['description']],
        ]),
      )
      const cond = br.fields['condition'] || br.fields['filter_condition']
      if (cond) blocks.push({ kind: 'code', caption: 'Condition', code: cond, lang: 'text' })
      if (br.fields['script']) blocks.push({ kind: 'code', caption: 'Script', code: br.fields['script'], lang: 'javascript' })
    }
  }

  // Client Scripts
  const css = byType(artifacts, 'client_script')
  if (css.length) {
    blocks.push({ kind: 'subheading', level: 2, text: `Client Scripts (${css.length})` })
    for (const cs of css) {
      blocks.push({ kind: 'subheading', level: 3, text: cs.label })
      blocks.push(
        detailBlock([
          ['Type', cs.fields['type']],
          ['Field', cs.fields['field']],
          ['Global', cs.fields['global']],
          ['Active', cs.fields['active']],
          ['Description', cs.fields['description']],
        ]),
      )
      if (cs.fields['script']) blocks.push({ kind: 'code', caption: 'Script', code: cs.fields['script'], lang: 'javascript' })
    }
  }

  // Script Includes
  const sis = byType(artifacts, 'script_include')
  if (sis.length) {
    blocks.push({ kind: 'subheading', level: 2, text: `Script Includes (${sis.length})` })
    for (const si of sis) {
      blocks.push({ kind: 'subheading', level: 3, text: si.label })
      blocks.push(
        detailBlock([
          ['API name', si.fields['api_name']],
          ['Active', si.fields['active']],
          ['Description', si.fields['description']],
        ]),
      )
      if (si.fields['script']) blocks.push({ kind: 'code', caption: 'Script', code: si.fields['script'], lang: 'javascript' })
    }
  }

  // Catalog Client Scripts
  const ccs = byType(artifacts, 'catalog_client_script')
  if (ccs.length) {
    blocks.push({ kind: 'subheading', level: 2, text: `Catalog Client Scripts (${ccs.length})` })
    for (const c of ccs) {
      blocks.push({ kind: 'subheading', level: 3, text: c.label })
      if (c.fields['script']) blocks.push({ kind: 'code', caption: 'Script', code: c.fields['script'], lang: 'javascript' })
    }
  }

  // UI Policies (+ actions grouped under each)
  const policies = byType(artifacts, 'ui_policy')
  const uiActions = byType(artifacts, 'ui_policy_action')
  if (policies.length) {
    blocks.push({ kind: 'subheading', level: 2, text: `UI Policies (${policies.length})` })
    for (const p of policies) {
      blocks.push({ kind: 'subheading', level: 3, text: p.label || p.fields['short_description'] || '(UI policy)' })
      blocks.push(
        detailBlock([
          ['On load', p.fields['on_load']],
          ['Reverse if false', p.fields['reverse_if_false']],
          ['Active', p.fields['active']],
        ]),
      )
      if (p.fields['conditions']) blocks.push({ kind: 'code', caption: 'When (condition)', code: p.fields['conditions'], lang: 'text' })
      const mine = uiActions.filter((x) => x.fields['ui_policy'] === p.sysId)
      if (mine.length) {
        blocks.push({
          kind: 'table',
          columns: ['Field', 'Mandatory', 'Visible', 'Read-only'],
          rows: mine.map((x) => [x.fields['field'] ?? '', x.fields['mandatory'] ?? '', x.fields['visible'] ?? '', x.fields['disabled'] ?? '']),
        })
      }
    }
  }

  // UI Actions — distinct from UI Policy actions above (those are field
  // behaviors driven by a UI Policy; these are buttons/links/menu items with
  // their own condition + client/server script).
  const uiActionRecords = byType(artifacts, 'ui_action')
  if (uiActionRecords.length) {
    blocks.push({ kind: 'subheading', level: 2, text: `UI Actions (${uiActionRecords.length})` })
    for (const ua of uiActionRecords) {
      blocks.push({ kind: 'subheading', level: 3, text: ua.label })
      blocks.push(
        detailBlock([
          ['Table', ua.fields['table']],
          ['Action name', ua.fields['action_name']],
          ['Client', ua.fields['client']],
          ['Form button', ua.fields['form_button']],
          ['List button', ua.fields['list_button']],
          ['Active', ua.fields['active']],
        ]),
      )
      if (ua.fields['condition']) blocks.push({ kind: 'code', caption: 'Condition', code: ua.fields['condition'], lang: 'text' })
      if (ua.fields['script']) blocks.push({ kind: 'code', caption: 'Script', code: ua.fields['script'], lang: 'javascript' })
    }
  }

  if (!blocks.length) blocks.push(emptyNote('No script logic discovered.'))
  return { heading: 'Logic', blocks }
}

function integrationSection(artifacts: ArtifactRef[]): SpecSection {
  const blocks: SpecBlock[] = []

  const workflows = byType(artifacts, 'workflow')
  if (workflows.length) {
    blocks.push({ kind: 'list', items: workflows.map((w) => `Workflow: ${w.label}`) })
  }

  const maps = byType(artifacts, 'transform_map')
  const entries = byType(artifacts, 'transform_entry')
  if (maps.length) blocks.push({ kind: 'list', items: maps.map((m) => `Transform Map: ${m.label}`) })
  if (entries.length) {
    blocks.push({
      kind: 'table',
      columns: ['Source field', 'Target field', 'Coalesce'],
      rows: entries.map((e) => [
        e.fields['source_field'] ?? '',
        e.fields['target_field'] ?? '',
        e.fields['coalesce'] ?? '',
      ]),
    })
  }

  const notifications = byType(artifacts, 'notification')
  if (notifications.length) {
    blocks.push({
      kind: 'table',
      columns: ['Notification', 'Event', 'Active'],
      rows: notifications.map((n) => [n.label, n.fields['event_name'] ?? '', n.fields['active'] ?? '']),
    })
  }

  if (!blocks.length) blocks.push(emptyNote('No integration points (workflows, transform maps, notifications) discovered.'))
  return { heading: 'Integration Points', blocks }
}

function securitySection(artifacts: ArtifactRef[]): SpecSection {
  const acls = byType(artifacts, 'acl')
  const dataPolicies = byType(artifacts, 'data_policy')
  if (!acls.length && !dataPolicies.length) {
    return { heading: 'Security / ACL', blocks: [emptyNote('No ACLs or data policies discovered for this artifact.')] }
  }
  const blocks: SpecBlock[] = []

  if (acls.length) {
    blocks.push({ kind: 'subheading', level: 2, text: `Access Controls (${acls.length})` })

    // Each ACL as one self-contained unit: its details, condition, and script.
    for (const a of acls) {
      const name = a.fields['name'] || a.label || '(acl)'
      const op = a.fields['operation']
      blocks.push({ kind: 'subheading', level: 3, text: op ? `${name} — ${op}` : name })
      blocks.push(
        detailBlock([
          ['Operation', a.fields['operation']],
          ['Type', a.fields['type']],
          ['Active', a.fields['active']],
          ['Admin overrides', a.fields['admin_overrides']],
          ['Requires role', a.fields['roles'] || a.fields['role']],
          ['Description', a.fields['description']],
        ]),
      )
      const cond = a.fields['condition']
      if (cond?.trim()) blocks.push({ kind: 'code', caption: 'Condition', code: cond, lang: 'text' })
      if (a.fields['script']?.trim()) blocks.push({ kind: 'code', caption: 'Script', code: a.fields['script'], lang: 'javascript' })
    }
  }

  if (dataPolicies.length) {
    blocks.push({ kind: 'subheading', level: 2, text: `Data Policies (${dataPolicies.length})` })
    blocks.push({
      kind: 'table',
      columns: ['Data Policy', 'Enforce UI', 'Import set', 'Active'],
      rows: dataPolicies.map((d) => [
        d.label || d.fields['short_description'] || '',
        d.fields['enforce_ui'] ?? '',
        d.fields['apply_import_set'] ?? '',
        d.fields['active'] ?? '',
      ]),
    })
  }
  return { heading: 'Security / ACL', blocks }
}
