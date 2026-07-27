/**
 * Per-artifact-type resolvers for the F1 graph walk (handoff §3, §7 decision 4).
 *
 * Priority order implemented: Business Rule + Catalog Item first, then Script
 * Include, ACL, Transform Map. Each resolver returns FetchSpecs (data, not
 * fetches) so it stays pure and testable; ServiceNow table/field assumptions are
 * noted inline and easy to adjust per instance version.
 */
import type { ArtifactRef, FetchSpec, Resolver, ResolverRegistry } from './graph'

/** Globals that look like Script Includes but aren't. */
const KNOWN_GLOBALS = new Set([
  'GlideRecord', 'GlideRecordSecure', 'GlideAggregate', 'GlideDateTime', 'GlideDate',
  'GlideTime', 'GlideDuration', 'GlideSystem', 'GlideElement', 'GlideFilter',
  'GlideQueryCondition', 'GlideStringUtil', 'GlideScopedEvaluator', 'GlideModalForm',
  'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Math', 'RegExp',
  'Error', 'Map', 'Set', 'Promise', 'Function', 'Class', 'GlideAjax', 'GlideForm',
  'GlideUser', 'GlideURI', 'GlideSysAttachment', 'GlideEncrypter', 'GlideDBFunctionBuilder',
])

/**
 * Extract candidate Script Include names referenced in a script: identifiers
 * used as `new X(` or `X.method(` where X is PascalCase and not a known global.
 */
export function extractScriptIncludeCandidates(script: string): string[] {
  const found = new Set<string>()
  const add = (name: string) => {
    if (/^[A-Z][A-Za-z0-9_]+$/.test(name) && !KNOWN_GLOBALS.has(name)) found.add(name)
  }
  // new X(
  for (const m of script.matchAll(/\bnew\s+([A-Z][A-Za-z0-9_]+)\s*\(/g)) add(m[1])
  // X.method(  (static-style calls)
  for (const m of script.matchAll(/\b([A-Z][A-Za-z0-9_]+)\.[A-Za-z_]\w*\s*\(/g)) add(m[1])
  return [...found]
}

/** Build an `IN` encoded query for a field over a list of values. */
function inQuery(field: string, values: string[]): string {
  return `${field}IN${values.join(',')}`
}

const scriptIncludeSpec = (names: string[], relation: string): FetchSpec[] =>
  names.length === 0
    ? []
    : [
        {
          table: 'sys_script_include',
          query: inQuery('name', names),
          type: 'script_include',
          relation,
          labelField: 'name',
          fields: ['sys_id', 'name', 'api_name', 'script', 'active'],
          limit: 1000,
        },
      ]

/** Business Rule → target table def, referenced Script Includes. */
const resolveBusinessRule: Resolver = (a) => {
  const specs: FetchSpec[] = []
  const collection = a.fields['collection']
  if (collection) {
    specs.push({
      table: 'sys_db_object',
      query: `name=${collection}`,
      type: 'table',
      relation: 'runs on table',
      labelField: 'label',
      fields: ['sys_id', 'name', 'label', 'super_class'],
      limit: 1,
    })
  }
  specs.push(...scriptIncludeSpec(extractScriptIncludeCandidates(a.fields['script'] ?? ''), 'referenced Script Include'))
  return specs
}

/** Script Include → further referenced Script Includes (recurses, depth-bounded). */
const resolveScriptInclude: Resolver = (a) =>
  scriptIncludeSpec(
    extractScriptIncludeCandidates(a.fields['script'] ?? '').filter((n) => n !== a.fields['name']),
    'referenced Script Include',
  )

/** Catalog Item → variables, variable sets, UI policies, catalog client scripts, workflow. */
const resolveCatalogItem: Resolver = (a) => {
  const sysId = a.sysId
  const specs: FetchSpec[] = [
    {
      table: 'item_option_new',
      query: `cat_item=${sysId}^ORDERBYorder`,
      type: 'variable',
      relation: 'variable',
      labelField: 'question_text',
      fields: ['sys_id', 'name', 'question_text', 'type', 'mandatory'],
      limit: 1000,
    },
    {
      table: 'io_set_item',
      query: `sc_cat_item=${sysId}`,
      type: 'variable_set',
      relation: 'variable set',
      labelField: 'variable_set',
      fields: ['sys_id', 'variable_set'],
      limit: 50,
    },
    {
      table: 'catalog_ui_policy',
      query: `catalog_item=${sysId}`,
      type: 'ui_policy',
      relation: 'UI policy',
      labelField: 'short_description',
      fields: ['sys_id', 'short_description', 'active'],
      limit: 2000,
    },
    {
      table: 'catalog_script_client',
      query: `cat_item=${sysId}`,
      type: 'catalog_client_script',
      relation: 'catalog client script',
      labelField: 'name',
      fields: ['sys_id', 'name', 'type', 'script'],
      limit: 2000,
    },
  ]
  const workflow = a.fields['workflow']
  if (workflow) {
    specs.push({
      table: 'wf_workflow',
      query: `sys_id=${workflow}`,
      type: 'workflow',
      relation: 'attached workflow',
      labelField: 'name',
      fields: ['sys_id', 'name'],
      limit: 1,
    })
  }
  return specs
}

/**
 * Suffix a relation with its hierarchy provenance, so an inherited Business
 * Rule reads "Business Rule ↑ task" in the checklist and the exported spec.
 * Unmarked (own-table) artifacts keep the exact wording they had before, so
 * discovery output is unchanged when the hierarchy option is off.
 */
function markRelation(a: ArtifactRef, base: string, name: string): string {
  if (!a.origin || a.origin === 'self') return base
  return `${base} ${a.origin === 'ancestor' ? '↑' : '↓'} ${name}`
}

/** Table → the customizations defined on it: BRs, Client Scripts, UI Policies, ACLs. */
const resolveTable: Resolver = (a) => {
  const name = a.fields['name'] || a.label
  if (!name) return []
  return [
    {
      table: 'sys_script',
      query: `collection=${name}^ORDERBYwhen^ORDERBYorder`,
      type: 'business_rule',
      relation: markRelation(a, 'Business Rule', name),
      labelField: 'name',
      fields: [
        'sys_id', 'name', 'when', 'order', 'active', 'condition', 'filter_condition', 'script', 'collection',
        'action_insert', 'action_update', 'action_delete', 'action_query', 'description',
      ],
      limit: 500,
    },
    {
      table: 'sys_script_client',
      query: `table=${name}^ORDERBYtype`,
      type: 'client_script',
      relation: markRelation(a, 'Client Script', name),
      labelField: 'name',
      fields: ['sys_id', 'name', 'type', 'field', 'active', 'global', 'isolate_script', 'description', 'script'],
      limit: 500,
    },
    {
      table: 'sys_ui_policy',
      query: `table=${name}^ORDERBYorder`,
      type: 'ui_policy',
      relation: markRelation(a, 'UI Policy', name),
      labelField: 'short_description',
      fields: ['sys_id', 'short_description', 'active', 'conditions', 'on_load', 'reverse_if_false', 'global', 'order'],
      limit: 500,
    },
    {
      table: 'sys_security_acl',
      // Anchored to this table only: exact record-level ACL `<table>` OR
      // field-level ACLs `<table>.<field>`. A bare STARTSWITH would also
      // catch sibling tables like `incident_sla`/`incident_task` (T-102).
      query: `name=${name}^ORnameSTARTSWITH${name}.`,
      type: 'acl',
      relation: markRelation(a, 'ACL', name),
      labelField: 'name',
      fields: ['sys_id', 'name', 'operation', 'active', 'admin_overrides', 'condition', 'script', 'description'],
      limit: 1000,
    },
    {
      table: 'sysevent_email_action',
      query: `collection=${name}`,
      type: 'notification',
      relation: markRelation(a, 'Notification', name),
      labelField: 'name',
      fields: ['sys_id', 'name', 'active', 'event_name', 'action_insert', 'action_update'],
      limit: 200,
    },
    {
      table: 'sys_data_policy2',
      query: `model_table=${name}`,
      type: 'data_policy',
      relation: markRelation(a, 'Data Policy', name),
      labelField: 'short_description',
      fields: ['sys_id', 'short_description', 'active', 'enforce_ui', 'apply_import_set', 'reverse_if_false'],
      limit: 200,
    },
  ]
}

/** UI Policy → its field actions (mandatory/visible/read-only). */
const resolveUiPolicy: Resolver = (a) => [
  {
    table: 'sys_ui_policy_action',
    query: `ui_policy=${a.sysId}`,
    type: 'ui_policy_action',
    relation: 'UI Policy action',
    labelField: 'field',
    fields: ['sys_id', 'field', 'mandatory', 'visible', 'disabled', 'ui_policy'],
    limit: 200,
  },
]

/** Transform Map → field map entries. */
const resolveTransformMap: Resolver = (a) => [
  {
    table: 'sys_transform_entry',
    query: `map=${a.sysId}^ORDERBYorder`,
    type: 'transform_entry',
    relation: 'field map',
    labelField: 'target_field',
    fields: ['sys_id', 'source_field', 'target_field', 'coalesce'],
    limit: 2000,
  },
]

export const RESOLVERS: ResolverRegistry = {
  business_rule: resolveBusinessRule,
  script_include: resolveScriptInclude,
  catalog_client_script: resolveScriptInclude, // catalog client scripts may call SIs via GlideAjax targets — best-effort
  root: (a: ArtifactRef) => rootResolver(a),
  table: resolveTable,
  ui_policy: resolveUiPolicy,
  transform_map: resolveTransformMap,
}

/** The root's resolver dispatches by the root record's own table. */
function rootResolver(a: ArtifactRef): FetchSpec[] {
  switch (a.table) {
    case 'sys_script':
      return resolveBusinessRule(a)
    case 'sc_cat_item':
      return resolveCatalogItem(a)
    case 'sys_script_include':
      return resolveScriptInclude(a)
    case 'sys_transform_map':
      return resolveTransformMap(a)
    default:
      // Unknown root: still surface ACLs for its own table.
      return resolveTable({ ...a, fields: { ...a.fields, name: a.table } })
  }
}

/** The set of tables F1 knows how to use as a spec root. */
export const SUPPORTED_ROOT_TABLES = new Set([
  'sys_script',
  'sc_cat_item',
  'sys_script_include',
  'sys_transform_map',
])
