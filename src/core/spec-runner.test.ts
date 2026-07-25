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
