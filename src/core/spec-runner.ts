/**
 * Glue between the F1 graph walker and the live REST client. Loads the root
 * record, provides a fetchPage that executes FetchSpecs via the Table API, and
 * maps rows into ArtifactRefs. A failed fetch (e.g. a table absent on this
 * instance) yields no artifacts rather than aborting the whole walk.
 */
import { cellDisplay, cellValue, pickLabel } from './api'
import { getDictionary, getRecord, queryRecords } from './api-client'
import { makeId, walkGraph, type ArtifactRef, type FetchSpec } from './graph'
import { RESOLVERS } from './resolvers'
import type { SpecSchemaField } from './spec'

/** Flatten a Table API row (raw or {value} cells) into a string map. */
function rawFields(rec: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec)) out[k] = cellValue(v)
  return out
}

function toArtifact(spec: FetchSpec, rec: Record<string, unknown>, depth: number): ArtifactRef {
  const fields = rawFields(rec)
  const sysId = fields['sys_id'] ?? ''
  const label = spec.labelField ? fields[spec.labelField] || pickLabel(rec) : pickLabel(rec)
  return {
    id: makeId(spec.table, sysId),
    table: spec.table,
    sysId,
    type: spec.type,
    label,
    relation: spec.relation,
    depth,
    fields,
  }
}

export async function loadRootArtifact(
  host: string,
  table: string,
  sysId: string,
): Promise<ArtifactRef | null> {
  const res = await getRecord(host, table, sysId)
  if (!res.ok) return null
  const fields = rawFields(res.data)
  return {
    id: makeId(table, sysId),
    table,
    sysId,
    type: 'root',
    label: pickLabel(res.data),
    relation: 'root',
    depth: 0,
    fields,
  }
}

/**
 * A synthetic root for a whole-table ("module") spec, used when the user is on
 * a list view (no specific record). The root resolver dispatches by table, so a
 * plain data table falls through to resolveTable and surfaces its BRs, client
 * scripts, UI policies, ACLs, etc.
 */
export function tableRootArtifact(table: string): ArtifactRef {
  return {
    id: makeId(table, 'table'),
    table,
    sysId: '',
    type: 'root',
    label: table,
    relation: 'root',
    depth: 0,
    fields: { name: table },
  }
}

export interface WalkOutcome {
  root: ArtifactRef
  artifacts: ArtifactRef[] // discovered, excluding root
  primaryTable: string
  schema: SpecSchemaField[]
}

/** The data table a spec is about: BR's collection, else the root table. */
function primaryTableOf(root: ArtifactRef): string {
  return root.fields['collection'] || root.table
}

export async function walkSpecGraph(
  host: string,
  root: ArtifactRef,
  onProgress?: (n: number) => void,
): Promise<WalkOutcome> {
  const fetchPage = async (spec: FetchSpec, depth: number): Promise<ArtifactRef[]> => {
    const res = await queryRecords(host, spec.table, {
      query: spec.query,
      fields: spec.fields,
      limit: spec.limit ?? 50,
      displayValue: false,
    })
    if (!res.ok) return []
    return res.data.map((rec) => toArtifact(spec, rec, depth))
  }

  const all = await walkGraph(root, RESOLVERS, { maxDepth: 2, fetchPage, onProgress })

  // Fetch the primary table's schema for the Data Model section.
  const primaryTable = primaryTableOf(root)
  let schema: SpecSchemaField[] = []
  const dict = await getDictionary(host, primaryTable)
  if (dict.ok) {
    schema = dict.data.map((d) => ({
      element: cellValue(d.element as unknown),
      type: cellDisplay(d.internal_type as unknown) || cellValue(d.internal_type as unknown),
      label: cellDisplay(d.column_label as unknown),
      reference: cellValue(d.reference as unknown),
      mandatory: cellValue(d.mandatory as unknown),
      maxLength: cellValue(d.max_length as unknown),
      defaultValue: cellValue(d.default_value as unknown),
    }))
  }

  return { root, artifacts: all.filter((a) => a.id !== root.id), primaryTable, schema }
}
