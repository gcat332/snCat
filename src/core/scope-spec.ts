/**
 * Whole-application spec sweep (F1).
 *
 * The record/table spec walks a dependency graph from one root. A scope spec
 * answers a different question — "what is in this application?" — so it is a
 * FLAT sweep: one query per artifact table, filtered on sys_scope, depth 0.
 * No graph walk, so the size is predictable and one pass covers the app.
 *
 * The trade-off is deliberate: artifacts this app depends on that live OUTSIDE
 * the scope (a global Script Include, say) are not pulled in.
 */
import type { ArtifactType, FetchSpec } from './graph'

export interface ScopeSweep {
  table: string
  type: ArtifactType
  relation: string
  labelField: string
  fields: string[]
  limit: number
}

/** Artifact tables swept for a scope spec, in presentation order. */
export const SCOPE_ARTIFACT_TABLES: ScopeSweep[] = [
  {
    table: 'sys_db_object',
    type: 'table',
    relation: 'Table',
    labelField: 'label',
    fields: ['sys_id', 'name', 'label', 'super_class', 'sys_scope'],
    limit: 200,
  },
  {
    table: 'sys_script',
    type: 'business_rule',
    relation: 'Business Rule',
    labelField: 'name',
    fields: [
      'sys_id', 'name', 'collection', 'when', 'order', 'active', 'condition',
      'filter_condition', 'script', 'action_insert', 'action_update',
      'action_delete', 'action_query', 'description',
    ],
    limit: 500,
  },
  {
    table: 'sys_script_client',
    type: 'client_script',
    relation: 'Client Script',
    labelField: 'name',
    fields: ['sys_id', 'name', 'table', 'type', 'field', 'active', 'global', 'isolate_script', 'description', 'script'],
    limit: 500,
  },
  {
    table: 'sys_script_include',
    type: 'script_include',
    relation: 'Script Include',
    labelField: 'name',
    fields: ['sys_id', 'name', 'api_name', 'active', 'client_callable', 'description', 'script'],
    limit: 500,
  },
  {
    table: 'sys_ui_policy',
    type: 'ui_policy',
    relation: 'UI Policy',
    labelField: 'short_description',
    fields: ['sys_id', 'short_description', 'table', 'active', 'conditions', 'on_load', 'reverse_if_false', 'global', 'order'],
    limit: 500,
  },
  {
    table: 'sys_ui_action',
    type: 'ui_action',
    relation: 'UI Action',
    labelField: 'name',
    fields: ['sys_id', 'name', 'table', 'active', 'action_name', 'condition', 'script', 'client', 'form_button', 'list_button'],
    limit: 500,
  },
  {
    table: 'sys_security_acl',
    type: 'acl',
    relation: 'ACL',
    labelField: 'name',
    fields: ['sys_id', 'name', 'operation', 'active', 'admin_overrides', 'condition', 'script', 'description'],
    limit: 1000,
  },
  {
    table: 'sysevent_email_action',
    type: 'notification',
    relation: 'Notification',
    labelField: 'name',
    fields: ['sys_id', 'name', 'collection', 'active', 'event_name', 'action_insert', 'action_update'],
    limit: 200,
  },
  {
    table: 'sys_data_policy2',
    type: 'data_policy',
    relation: 'Data Policy',
    labelField: 'short_description',
    fields: ['sys_id', 'short_description', 'model_table', 'active', 'enforce_ui', 'apply_import_set', 'reverse_if_false'],
    limit: 200,
  },
  {
    table: 'sc_cat_item',
    type: 'catalog_item',
    relation: 'Catalog Item',
    labelField: 'name',
    fields: ['sys_id', 'name', 'short_description', 'active', 'category', 'workflow'],
    limit: 200,
  },
  {
    table: 'sys_transform_map',
    type: 'transform_map',
    relation: 'Transform Map',
    labelField: 'name',
    fields: ['sys_id', 'name', 'source_table', 'target_table', 'active', 'order'],
    limit: 200,
  },
]

/** One FetchSpec per artifact table, all filtered to the given application. */
export function scopeFetchSpecs(scopeSysId: string): FetchSpec[] {
  return SCOPE_ARTIFACT_TABLES.map((s) => ({
    table: s.table,
    query: `sys_scope=${scopeSysId}`,
    type: s.type,
    relation: s.relation,
    labelField: s.labelField,
    fields: s.fields,
    limit: s.limit,
  }))
}
