/**
 * Glue between the F1 graph walker and the live REST client. Loads the root
 * record, provides a fetchPage that executes FetchSpecs via the Table API, and
 * maps rows into ArtifactRefs. A failed fetch (e.g. a table absent on this
 * instance) yields no artifacts rather than aborting the whole walk.
 */
import { cellValue, pickLabel } from './api'
import { getRecord, queryRecords } from './api-client'
import { makeId, walkGraph, type ArtifactRef, type FetchSpec } from './graph'
import { RESOLVERS } from './resolvers'

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

export interface WalkOutcome {
  root: ArtifactRef
  artifacts: ArtifactRef[] // discovered, excluding root
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
  return { root, artifacts: all.filter((a) => a.id !== root.id) }
}
