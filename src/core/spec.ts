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
  | { kind: 'keyvalue'; rows: { key: string; value: string }[] }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'code'; caption?: string; code: string }
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
}

export interface SpecSchemaField {
  element: string
  type: string
  label: string
  reference: string
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

function emptyNote(text: string): SpecBlock {
  return { kind: 'paragraph', text }
}

export function composeSpec(input: ComposeInput): SpecDocument {
  const { instance, rootTable, rootLabel, rootFields, artifacts, primaryTable, schema } = input
  const rootKind = TYPE_LABEL[rootTable] ?? rootTable

  const title = rootLabel || rootKind
  const subtitle = `${rootKind} · Design Specification`

  const meta = [
    { key: 'Instance', value: instance },
    { key: 'Artifact type', value: rootKind },
    { key: 'Table', value: rootTable },
    { key: 'sys_id', value: rootFields['sys_id'] ?? '' },
    { key: 'Artifacts included', value: String(artifacts.length + 1) },
  ]

  return {
    title,
    subtitle,
    meta,
    sections: [
      overviewSection(rootKind, rootLabel, instance, rootFields),
      dataModelSection(primaryTable ?? rootTable, rootFields, artifacts, schema),
      logicSection(rootFields, artifacts),
      integrationSection(artifacts),
      securitySection(artifacts),
    ],
  }
}

function overviewSection(
  kind: string,
  label: string,
  instance: string,
  f: Record<string, string>,
): SpecSection {
  const rows: { key: string; value: string }[] = []
  const add = (k: string, v?: string) => {
    if (v) rows.push({ key: k, value: v })
  }
  add('Name', f['name'] || label)
  add('When', f['when'])
  add('Order', f['order'])
  add('Active', f['active'])
  add('Table / Collection', f['collection'])
  add('Application', f['sys_scope'])
  add('Short description', f['short_description'])

  return {
    heading: 'Overview',
    blocks: [
      {
        kind: 'paragraph',
        text: `This Design Specification documents the ${kind} "${label}" on ${instance}. It was generated automatically from the record and its bounded dependency graph (depth 2).`,
      },
      rows.length ? { kind: 'keyvalue', rows } : emptyNote('No overview metadata available.'),
    ],
  }
}

function dataModelSection(
  primaryTable: string,
  rootFields: Record<string, string>,
  artifacts: ArtifactRef[],
  schema?: SpecSchemaField[],
): SpecSection {
  const blocks: SpecBlock[] = []

  // The primary table's own schema (fields) — the core of the data model.
  if (schema && schema.length) {
    blocks.push({ kind: 'paragraph', text: `Primary table: ${primaryTable} (${schema.length} fields).` })
    blocks.push({
      kind: 'table',
      columns: ['Field', 'Type', 'Label', 'References'],
      rows: schema.map((f) => [f.element, f.type, f.label, f.reference]),
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

  if (!blocks.length) {
    blocks.push(
      emptyNote(`Primary table: ${rootFields['collection'] || primaryTable}. No additional data-model artifacts were discovered within the depth limit.`),
    )
  }
  return { heading: 'Data Model', blocks }
}

function logicSection(
  rootFields: Record<string, string>,
  artifacts: ArtifactRef[],
): SpecSection {
  const blocks: SpecBlock[] = []

  const condition = rootFields['condition'] || rootFields['filter_condition']
  if (condition) blocks.push({ kind: 'code', caption: 'Condition', code: condition })
  if (rootFields['script']) blocks.push({ kind: 'code', caption: 'Script (root)', code: rootFields['script'] })

  for (const br of byType(artifacts, 'business_rule')) {
    const acts = (['insert', 'update', 'delete', 'query'] as const).filter((a) => br.fields[`action_${a}`] === 'true')
    const meta = [
      br.fields['when'],
      br.fields['order'] ? `order ${br.fields['order']}` : '',
      acts.length ? `on: ${acts.join(', ')}` : '',
      br.fields['active'] === 'false' ? 'inactive' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const suffix = meta ? ` — ${meta}` : ''
    if (br.fields['description']) blocks.push({ kind: 'paragraph', text: `${br.label}: ${br.fields['description']}` })
    const cond = br.fields['condition'] || br.fields['filter_condition']
    if (cond) blocks.push({ kind: 'code', caption: `Business Rule condition: ${br.label}${suffix}`, code: cond })
    if (br.fields['script']) blocks.push({ kind: 'code', caption: `Business Rule: ${br.label}${suffix}`, code: br.fields['script'] })
  }
  for (const cs of byType(artifacts, 'client_script')) {
    const meta = [
      cs.fields['type'] || 'client script',
      cs.fields['field'] ? `field: ${cs.fields['field']}` : '',
      cs.fields['global'] === 'true' ? 'global' : '',
      cs.fields['active'] === 'false' ? 'inactive' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    if (cs.fields['description']) blocks.push({ kind: 'paragraph', text: `${cs.label}: ${cs.fields['description']}` })
    if (cs.fields['script']) {
      blocks.push({ kind: 'code', caption: `Client Script: ${cs.label} — ${meta}`, code: cs.fields['script'] })
    }
  }
  for (const si of byType(artifacts, 'script_include')) {
    if (si.fields['script']) {
      blocks.push({ kind: 'code', caption: `Script Include: ${si.label}`, code: si.fields['script'] })
    }
  }
  for (const cs of byType(artifacts, 'catalog_client_script')) {
    if (cs.fields['script']) {
      blocks.push({ kind: 'code', caption: `Catalog Client Script: ${cs.label}`, code: cs.fields['script'] })
    }
  }

  const policies = byType(artifacts, 'ui_policy')
  if (policies.length) {
    blocks.push({
      kind: 'table',
      columns: ['UI Policy', 'Conditions', 'On load', 'Reverse', 'Active'],
      rows: policies.map((p) => [
        p.label || p.fields['short_description'] || '',
        p.fields['conditions'] ?? '',
        p.fields['on_load'] ?? '',
        p.fields['reverse_if_false'] ?? '',
        p.fields['active'] ?? '',
      ]),
    })
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

  if (!blocks.length) blocks.push(emptyNote('No integration points (workflows, transform maps) discovered.'))
  return { heading: 'Integration Points', blocks }
}

function securitySection(artifacts: ArtifactRef[]): SpecSection {
  const acls = byType(artifacts, 'acl')
  if (!acls.length) {
    return { heading: 'Security / ACL', blocks: [emptyNote('No ACLs discovered for this artifact.')] }
  }
  const blocks: SpecBlock[] = [
    {
      kind: 'table',
      columns: ['ACL', 'Operation', 'Active', 'Admin overrides', 'Condition', 'Script?'],
      rows: acls.map((a) => [
        a.fields['name'] ?? '',
        a.fields['operation'] ?? '',
        a.fields['active'] ?? '',
        a.fields['admin_overrides'] ?? '',
        a.fields['condition'] ?? '',
        a.fields['script']?.trim() ? 'yes' : '',
      ]),
    },
  ]
  // Include any ACL scripts verbatim.
  for (const a of acls) {
    if (a.fields['script']?.trim()) {
      blocks.push({ kind: 'code', caption: `ACL script: ${a.fields['name']} (${a.fields['operation']})`, code: a.fields['script'] })
    }
  }
  return { heading: 'Security / ACL', blocks }
}
