import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The dictionary→schema mapping lives inside walkSpecGraph and pulls its data
 * from getDictionary (imported directly from ./api-client — no DI seam). We
 * mock that module so the walk yields no related artifacts (queryRecords/
 * getRecord return not-ok) while getDictionary returns a controlled dictionary
 * row, letting us assert on the resulting SpecSchemaField mapping in isolation.
 */
const { getDictionary, queryRecords, getRecord } = vi.hoisted(() => ({
  getDictionary: vi.fn(),
  queryRecords: vi.fn(),
  getRecord: vi.fn(),
}))

vi.mock('./api-client', () => ({ getDictionary, queryRecords, getRecord }))

import { walkSpecGraph, tableRootArtifact, sweepScopeSpec } from './spec-runner'
import { makeId, type ArtifactRef } from './graph'

function rootArt(table: string, fields: Record<string, string>): ArtifactRef {
  return { id: makeId(table, fields.sys_id ?? 'r1'), table, sysId: fields.sys_id ?? 'r1', type: 'root', label: 'X', relation: 'root', depth: 0, fields }
}

describe('walkSpecGraph — dictionary → schema mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // No related artifacts: the graph walk fetches nothing.
    queryRecords.mockResolvedValue({ ok: false, status: 404, error: 'none' })
    getRecord.mockResolvedValue({ ok: false, status: 404, error: 'none' })
  })

  it('maps a Reference field to the referenced table NAME (display), not its sys_id', async () => {
    // sysparm_display_value=all → reference/type arrive as {value, display_value}.
    getDictionary.mockResolvedValue({
      ok: true,
      data: [
        {
          element: 'assigned_to',
          column_label: { value: 'Assigned to', display_value: 'Assigned to' },
          internal_type: { value: 'reference', display_value: 'Reference' },
          reference: { value: '62826bf03710200044e0bfc8bcbe5df1', display_value: 'sys_user' },
          mandatory: 'false',
          max_length: '32',
          default_value: '',
        },
      ],
    })

    const outcome = await walkSpecGraph('example.service-now.com', tableRootArtifact('incident'))

    expect(outcome.schema).toHaveLength(1)
    const field = outcome.schema[0]
    // Regression guard: must be the referenced table label, never the raw sys_id.
    expect(field.reference).toBe('sys_user')
    expect(field.reference).not.toBe('62826bf03710200044e0bfc8bcbe5df1')
    // Sibling type field already resolves the display value — sanity check.
    expect(field.type).toBe('Reference')
  })
})

describe('walkSpecGraph — reference label fields resolve to display names (T-302)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getRecord.mockResolvedValue({ ok: false, status: 404, error: 'none' })
    getDictionary.mockResolvedValue({ ok: false, status: 404, error: 'none' })
  })

  it('renders a variable_set-labelled artifact as the set NAME, not its sys_id', async () => {
    const setSysId = 'aaaa1111bbbb2222cccc3333dddd4444'
    // io_set_item rows carry only sys_id + a reference to the variable set.
    queryRecords.mockImplementation(async (_host: string, table: string) => {
      if (table === 'io_set_item') {
        return {
          ok: true,
          data: [
            {
              sys_id: { value: 'row1', display_value: 'row1' },
              variable_set: { value: setSysId, display_value: 'Hardware Options' },
            },
          ],
        }
      }
      return { ok: false, status: 404, error: 'none' }
    })

    const outcome = await walkSpecGraph('example.service-now.com', rootArt('sc_cat_item', { sys_id: 'c1' }))
    const varSet = outcome.artifacts.find((x) => x.type === 'variable_set')
    expect(varSet).toBeDefined()
    // Must be the human-readable set name, never the raw sys_id.
    expect(varSet!.label).toBe('Hardware Options')
    expect(varSet!.fields['variable_set']).toBe('Hardware Options')
    expect(varSet!.label).not.toBe(setSysId)
    // The bulk fetch must request display values so a display name is available.
    expect(queryRecords).toHaveBeenCalledWith(
      'example.service-now.com',
      'io_set_item',
      expect.objectContaining({ displayValue: 'all' }),
    )
  })

  it('resolves super_class to the parent table NAME for the Extends column', async () => {
    const parentSysId = '9999eeee8888ffff7777000011112222'
    queryRecords.mockImplementation(async (_host: string, table: string) => {
      if (table === 'sys_db_object') {
        return {
          ok: true,
          data: [
            {
              sys_id: { value: 'tbl1', display_value: 'tbl1' },
              name: { value: 'incident', display_value: 'incident' },
              label: { value: 'Incident', display_value: 'Incident' },
              super_class: { value: parentSysId, display_value: 'task' },
            },
          ],
        }
      }
      return { ok: false, status: 404, error: 'none' }
    })

    const outcome = await walkSpecGraph('example.service-now.com', rootArt('sys_script', { sys_id: 'r1', collection: 'incident' }))
    const table = outcome.artifacts.find((x) => x.type === 'table')
    expect(table).toBeDefined()
    // Extends is rendered from fields['super_class'] — must be the parent table name.
    expect(table!.fields['super_class']).toBe('task')
    expect(table!.fields['super_class']).not.toBe(parentSysId)
    // Raw string fields (used to build sub-queries) stay unchanged.
    expect(table!.fields['name']).toBe('incident')
  })
})

describe('walkSpecGraph — per-walk fetch memoization (T-405 perf)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getRecord.mockResolvedValue({ ok: false, status: 404, error: 'none' })
    getDictionary.mockResolvedValue({ ok: false, status: 404, error: 'none' })
  })

  /**
   * Fetch amplification (T-102): on a table-root spec, every Business Rule
   * resolves the SAME `sys_db_object?name=<collection>` FetchSpec. walkGraph only
   * dedupes AFTER the network call, so N BRs fire N identical live fetches.
   * A per-walk cache keyed on (table + query + fields) must collapse those to one
   * WITHOUT changing the discovered artifacts.
   */
  function mockTableWithSharedCollection() {
    // 3 distinct Business Rules, all on the same collection ('incident').
    const brRows = ['br1', 'br2', 'br3'].map((sys_id) => ({
      sys_id,
      name: `BR ${sys_id}`,
      collection: 'incident',
      script: '', // empty → no Script Include sub-queries, isolating the amplification
    }))
    let sysDbObjectCalls = 0
    queryRecords.mockImplementation(async (_host: string, table: string) => {
      if (table === 'sys_script') return { ok: true, data: brRows }
      if (table === 'sys_db_object') {
        sysDbObjectCalls++
        return {
          ok: true,
          data: [{ sys_id: 'tbl_incident', name: 'incident', label: 'Incident', super_class: '' }],
        }
      }
      // Every other table on the root (client scripts, UI policies, ACLs, …) is empty.
      return { ok: false, status: 404, error: 'none' }
    })
    return () => sysDbObjectCalls
  }

  it('collapses identical (table,query,fields) fetches to a single call while discovering the same artifacts', async () => {
    const sysDbObjectCalls = mockTableWithSharedCollection()

    const outcome = await walkSpecGraph('example.service-now.com', tableRootArtifact('incident'))

    // (i) Discovered set unchanged: the 3 BRs + exactly one deduped table artifact.
    const brs = outcome.artifacts.filter((a) => a.type === 'business_rule')
    const tables = outcome.artifacts.filter((a) => a.type === 'table')
    expect(brs.map((b) => b.sysId).sort()).toEqual(['br1', 'br2', 'br3'])
    expect(tables).toHaveLength(1)
    expect(tables[0].id).toBe(makeId('sys_db_object', 'tbl_incident'))
    expect(tables[0].fields['name']).toBe('incident')

    // (ii) The identical BR→table lookup fired exactly ONCE (pre-fix: 3).
    expect(sysDbObjectCalls()).toBe(1)
  })

  it('does not leak the cache across separate walkSpecGraph calls', async () => {
    const sysDbObjectCalls = mockTableWithSharedCollection()

    await walkSpecGraph('example.service-now.com', tableRootArtifact('incident'))
    await walkSpecGraph('example.service-now.com', tableRootArtifact('incident'))

    // One fetch per walk — the second walk must not be served from the first's cache.
    expect(sysDbObjectCalls()).toBe(2)
  })
})

describe('walkSpecGraph with hierarchy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getRecord.mockResolvedValue({ ok: false, status: 404, error: 'none' })
    getDictionary.mockResolvedValue({ ok: false, status: 404, error: 'none' })
    queryRecords.mockImplementation(async (_host: string, table: string, opts: { query?: string }) => {
      if (table === 'sys_db_object' && opts?.query === 'name=incident') {
        return { ok: true, data: [{ sys_id: 'id_inc', name: 'incident', super_class: 'id_task' }] }
      }
      if (table === 'sys_db_object' && opts?.query === 'sys_id=id_task') {
        return { ok: true, data: [{ sys_id: 'id_task', name: 'task', super_class: '' }] }
      }
      if (table === 'sys_db_object' && opts?.query === 'super_class=id_inc') {
        return { ok: true, data: [] }
      }
      if (table === 'sys_script' && opts?.query?.startsWith('collection=task')) {
        return { ok: true, data: [{ sys_id: 'br_task_1', name: 'Task BR' }] }
      }
      // A client script reachable from BOTH the main walk (table=incident) and the
      // ancestor seed walk (table=task), sharing the same sys_id — so the ancestor
      // walk genuinely rediscovers something the main walk already found. This is
      // what makes the "does not duplicate" test load-bearing (Fix 3): with the
      // `!byId.has(a.id)` check removed, this row would be pushed twice.
      if (table === 'sys_script_client' && opts?.query?.startsWith('table=incident')) {
        return { ok: true, data: [{ sys_id: 'shared_cs', name: 'Shared CS', type: 'onLoad' }] }
      }
      if (table === 'sys_script_client' && opts?.query?.startsWith('table=task')) {
        return { ok: true, data: [{ sys_id: 'shared_cs', name: 'Shared CS', type: 'onLoad' }] }
      }
      return { ok: false, status: 404, error: 'none' }
    })
  })

  it('leaves the outcome unchanged when the option is off', async () => {
    const outcome = await walkSpecGraph('h', tableRootArtifact('incident'))
    expect(outcome.hierarchy).toBeNull()
    expect(outcome.artifacts.every((a) => !a.relation.includes('↑'))).toBe(true)
  })

  it('discovers ancestor artifacts and marks them when the option is on', async () => {
    const outcome = await walkSpecGraph('h', tableRootArtifact('incident'), undefined, {
      includeHierarchy: true,
    })
    expect(outcome.hierarchy?.ancestors).toEqual(['task'])
    const inherited = outcome.artifacts.filter((a) => a.relation.includes('↑ task'))
    expect(inherited.length).toBeGreaterThan(0)
  })

  it('does not duplicate an artifact that both walks discover', async () => {
    const outcome = await walkSpecGraph('h', tableRootArtifact('incident'), undefined, {
      includeHierarchy: true,
    })
    const ids = outcome.artifacts.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    // The shared client script must appear exactly once, keeping the version the
    // main walk found first (not re-tagged with the ancestor's '↑ task' marker).
    const shared = outcome.artifacts.filter((a) => a.id === makeId('sys_script_client', 'shared_cs'))
    expect(shared).toHaveLength(1)
  })

  it('does not surface the synthetic seed-table root as its own artifact', async () => {
    const outcome = await walkSpecGraph('h', tableRootArtifact('incident'), undefined, {
      includeHierarchy: true,
    })
    // The seed root (table: 'sys_db_object', sysId: '') only exists to carry
    // `origin` into resolveTable — it was never a real fetched record and must
    // not appear as a near-blank 'table' row in the spec (Fix 1).
    const stub = outcome.artifacts.find((a) => a.table === 'sys_db_object' && a.sysId === '')
    expect(stub).toBeUndefined()
  })

  it('reports a monotonically non-decreasing progress count across the seed walks', async () => {
    const seq: number[] = []
    await walkSpecGraph('h', tableRootArtifact('incident'), (n) => seq.push(n), {
      includeHierarchy: true,
    })
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1])
    }
  })

  it('stays non-decreasing even when an earlier seed rediscovers MULTIPLE duplicates before a later seed finds one new artifact', async () => {
    // Adversarial case for the progress-peak clamp: the ancestor ('task') seed
    // rediscovers TWO artifacts the main walk already found (zero real merges),
    // then the child ('incident_task') seed finds exactly ONE genuinely new
    // artifact. Without clamping to the running peak, the naive `base + n - 1`
    // for the child seed comes out LOWER than what the ancestor seed already
    // reported (its raw discovery count outran what actually got merged) — a
    // real backward jump. This is proven by temporarily removing the
    // `Math.max(progressPeak, …)` clamp in spec-runner.ts and re-running this
    // test: it fails with the sequence [2, 3, 4, 5, 4].
    queryRecords.mockImplementation(async (_host: string, table: string, opts: { query?: string }) => {
      if (table === 'sys_db_object' && opts?.query === 'name=incident') {
        return { ok: true, data: [{ sys_id: 'id_inc', name: 'incident', super_class: 'id_task' }] }
      }
      if (table === 'sys_db_object' && opts?.query === 'sys_id=id_task') {
        return { ok: true, data: [{ sys_id: 'id_task', name: 'task', super_class: '' }] }
      }
      if (table === 'sys_db_object' && opts?.query === 'super_class=id_inc') {
        return { ok: true, data: [{ sys_id: 'id_it', name: 'incident_task', super_class: 'id_inc' }] }
      }
      // Main walk (incident): two artifacts the ancestor walk will rediscover.
      if (table === 'sys_script' && opts?.query?.startsWith('collection=incident^')) {
        return { ok: true, data: [{ sys_id: 'dupA', name: 'DupA BR' }] }
      }
      if (table === 'sys_script_client' && opts?.query?.startsWith('table=incident^')) {
        return { ok: true, data: [{ sys_id: 'dupB', name: 'DupB CS', type: 'onLoad' }] }
      }
      // Ancestor walk (task): rediscovers BOTH as pure duplicates (same sys_ids).
      if (table === 'sys_script' && opts?.query?.startsWith('collection=task')) {
        return { ok: true, data: [{ sys_id: 'dupA', name: 'DupA BR' }] }
      }
      if (table === 'sys_script_client' && opts?.query?.startsWith('table=task')) {
        return { ok: true, data: [{ sys_id: 'dupB', name: 'DupB CS', type: 'onLoad' }] }
      }
      // Child walk (incident_task): exactly one genuinely new artifact.
      if (table === 'sys_script' && opts?.query?.startsWith('collection=incident_task')) {
        return { ok: true, data: [{ sys_id: 'newC', name: 'New Child BR' }] }
      }
      return { ok: false, status: 404, error: 'none' }
    })

    const seq: number[] = []
    await walkSpecGraph('h', tableRootArtifact('incident'), (n) => seq.push(n), {
      includeHierarchy: true,
    })
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1])
    }
  })
})

describe('sweepScopeSpec', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getRecord.mockResolvedValue({ ok: false, status: 404, error: 'none' })
    getDictionary.mockResolvedValue({ ok: false, status: 404, error: 'none' })
    queryRecords.mockImplementation(async (_host: string, table: string, opts: { query?: string }) => {
      if (table === 'sys_security_acl') {
        return { ok: false, status: 403, error: 'forbidden' }
      }
      if (table === 'sys_script' && opts?.query?.startsWith('sys_scope=')) {
        return {
          ok: true,
          data: [
            { sys_id: 'br1', name: 'BR One', collection: 'incident' },
            { sys_id: 'br2', name: 'BR Two', collection: 'problem' },
          ],
        }
      }
      return { ok: true, data: [] }
    })
  })

  it('returns artifacts from every table that had rows', async () => {
    const { artifacts } = await sweepScopeSpec('h', 'scope_sys_id')
    expect(artifacts.map((a) => a.type)).toContain('business_rule')
  })

  it('reports cumulative progress as tables complete', async () => {
    const seen: number[] = []
    await sweepScopeSpec('h', 'scope_sys_id', (n) => seen.push(n))
    expect(seen.length).toBeGreaterThan(0)
    const { artifacts } = await sweepScopeSpec('h', 'scope_sys_id')
    expect(seen[seen.length - 1]).toBe(artifacts.length)
  })

  it('survives a table that errors, rather than aborting the sweep', async () => {
    // The mock returns { ok: false } for sys_security_acl.
    const { artifacts } = await sweepScopeSpec('h', 'scope_sys_id')
    expect(artifacts.every((a) => a.type !== 'acl')).toBe(true)
    expect(artifacts.length).toBeGreaterThan(0)
  })

  it('reports a failed table in `failed`, not as silent absence', async () => {
    // sys_security_acl is mocked to return { ok: false, status: 403 } above —
    // the Security section must not read that as "no ACLs exist".
    const { failed } = await sweepScopeSpec('h', 'scope_sys_id')
    expect(failed).toContain('sys_security_acl')
  })

  it('does not report a table that returned ok as failed', async () => {
    const { failed } = await sweepScopeSpec('h', 'scope_sys_id')
    expect(failed).not.toContain('sys_script')
  })

  it('reports a table that hit its row limit in `truncated`', async () => {
    queryRecords.mockImplementation(async (_host: string, table: string, opts: { query?: string; limit?: number }) => {
      if (table === 'sys_security_acl') return { ok: false, status: 403, error: 'forbidden' }
      if (table === 'sys_script' && opts?.query?.startsWith('sys_scope=')) {
        // Exactly at the configured limit — the sweep can't distinguish "exactly
        // this many rows" from "there are more", so it must report truncation
        // either way rather than assume the boundary case is complete.
        const n = opts.limit ?? 500
        return {
          ok: true,
          data: Array.from({ length: n }, (_, i) => ({ sys_id: `br${i}`, name: `BR ${i}`, collection: 'incident' })),
        }
      }
      return { ok: true, data: [] }
    })
    const { truncated } = await sweepScopeSpec('h', 'scope_sys_id')
    expect(truncated).toContain('sys_script')
  })

  it('does not report a table under its row limit as truncated', async () => {
    const { truncated } = await sweepScopeSpec('h', 'scope_sys_id')
    expect(truncated).not.toContain('sys_script')
  })
})
