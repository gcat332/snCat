import { describe, it, expect } from 'vitest'
import { resolveAncestors, resolveHierarchy, type HierarchyFetch } from './hierarchy'

/**
 * Fake sys_db_object. `rows` is keyed by table name; each row carries its own
 * sys_id and its parent's sys_id (super_class), exactly like the real table.
 */
function fakeFetch(rows: Record<string, { sys_id: string; super_class: string }>): HierarchyFetch {
  const bySysId = new Map(Object.entries(rows).map(([name, r]) => [r.sys_id, { name, ...r }]))
  return async (table, query, _fields, limit) => {
    if (table !== 'sys_db_object') return []
    let m = query.match(/^name=(.+)$/)
    if (m) {
      const r = rows[m[1]]
      return r ? [{ sys_id: r.sys_id, name: m[1], super_class: r.super_class }] : []
    }
    m = query.match(/^sys_id=(.+)$/)
    if (m) {
      const r = bySysId.get(m[1])
      return r ? [{ sys_id: r.sys_id, name: r.name, super_class: r.super_class }] : []
    }
    m = query.match(/^super_class=(.+)$/)
    if (m) {
      const kids = Object.entries(rows)
        .filter(([, r]) => r.super_class === m[1])
        .map(([name, r]) => ({ sys_id: r.sys_id, name, super_class: r.super_class }))
      return kids.slice(0, limit)
    }
    return []
  }
}

const CHAIN = {
  sys_metadata: { sys_id: 'id_meta', super_class: '' },
  task: { sys_id: 'id_task', super_class: 'id_meta' },
  incident: { sys_id: 'id_inc', super_class: 'id_task' },
  incident_task: { sys_id: 'id_inct', super_class: 'id_inc' },
}

describe('resolveHierarchy', () => {
  it('walks ancestors nearest-first and finds direct children', async () => {
    const h = await resolveHierarchy('incident', fakeFetch(CHAIN))
    expect(h.ancestors).toEqual(['task', 'sys_metadata'])
    expect(h.children).toEqual(['incident_task'])
    expect(h.childrenTruncated).toBe(0)
  })

  it('returns no ancestors for a root table, but still finds its children', async () => {
    const h = await resolveHierarchy('sys_metadata', fakeFetch(CHAIN))
    expect(h.ancestors).toEqual([])
    expect(h.children).toEqual(['task'])
  })

  it('returns no children for a leaf table, but still walks its full ancestry', async () => {
    const h = await resolveHierarchy('incident_task', fakeFetch(CHAIN))
    expect(h.ancestors).toEqual(['incident', 'task', 'sys_metadata'])
    expect(h.children).toEqual([])
  })

  it('returns empty lists when the table is not in sys_db_object', async () => {
    const h = await resolveHierarchy('nope', fakeFetch(CHAIN))
    expect(h).toEqual({ ancestors: [], children: [], childrenTruncated: 0 })
  })

  it('terminates on a super_class cycle instead of looping forever', async () => {
    const cyclic = {
      a: { sys_id: 'id_a', super_class: 'id_b' },
      b: { sys_id: 'id_b', super_class: 'id_a' },
    }
    const h = await resolveHierarchy('a', fakeFetch(cyclic))
    expect(h.ancestors).toEqual(['b'])
  })

  it('caps children at 20 and reports how many were dropped', async () => {
    const many: Record<string, { sys_id: string; super_class: string }> = {
      base: { sys_id: 'id_base', super_class: '' },
    }
    for (let i = 0; i < 25; i++) many[`kid${i}`] = { sys_id: `id_kid${i}`, super_class: 'id_base' }
    const h = await resolveHierarchy('base', fakeFetch(many))
    expect(h.children).toHaveLength(20)
    expect(h.childrenTruncated).toBe(5)
  })
})

describe('resolveAncestors', () => {
  it('walks ancestors nearest-first', async () => {
    const ancestors = await resolveAncestors('incident', fakeFetch(CHAIN))
    expect(ancestors).toEqual(['task', 'sys_metadata'])
  })

  it('returns no ancestors for a root table', async () => {
    const ancestors = await resolveAncestors('sys_metadata', fakeFetch(CHAIN))
    expect(ancestors).toEqual([])
  })

  it('terminates on a super_class cycle instead of looping forever', async () => {
    const cyclic = {
      a: { sys_id: 'id_a', super_class: 'id_b' },
      b: { sys_id: 'id_b', super_class: 'id_a' },
    }
    const ancestors = await resolveAncestors('a', fakeFetch(cyclic))
    expect(ancestors).toEqual(['b'])
  })

  it('returns no ancestors for a table absent from sys_db_object', async () => {
    const ancestors = await resolveAncestors('nope', fakeFetch(CHAIN))
    expect(ancestors).toEqual([])
  })

  it('issues no children query — the whole reason this export exists', async () => {
    const queries: string[] = []
    const spyFetch: HierarchyFetch = async (table, query, fields, limit) => {
      queries.push(query)
      return fakeFetch(CHAIN)(table, query, fields, limit)
    }
    await resolveAncestors('incident', spyFetch)
    expect(queries.some((q) => q.startsWith('super_class='))).toBe(false)
  })
})
