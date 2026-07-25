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

import { walkSpecGraph, tableRootArtifact } from './spec-runner'
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
