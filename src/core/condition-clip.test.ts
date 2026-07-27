import { describe, it, expect } from 'vitest'
import { clipWarnings, extractRefTokens, groupTokensByRefTable, type ConditionClip } from './condition-clip'

describe('extractRefTokens', () => {
  it('pairs a sys_id with the field in its clause', () => {
    const q = 'active=true^assigned_to=6816f79cc0a8016401c5a33be04be441'
    expect(extractRefTokens(q)).toEqual([
      { field: 'assigned_to', sysId: '6816f79cc0a8016401c5a33be04be441' },
    ])
  })

  it('handles IN lists and ^OR separators', () => {
    const q =
      'assignment_groupIN287ee6fea9fe198100ada7950d0b1b73,d625dccec0a8016700a222a0f7900d06' +
      '^ORcaller_id=5137153cc611227c000bbd1bd8cd2005'
    expect(extractRefTokens(q)).toEqual([
      { field: 'assignment_group', sysId: '287ee6fea9fe198100ada7950d0b1b73' },
      { field: 'assignment_group', sysId: 'd625dccec0a8016700a222a0f7900d06' },
      { field: 'caller_id', sysId: '5137153cc611227c000bbd1bd8cd2005' },
    ])
  })

  it('handles a genuine ^NQ separator', () => {
    const q =
      'assigned_to=6816f79cc0a8016401c5a33be04be441' +
      '^NQcaller_id=5137153cc611227c000bbd1bd8cd2005'
    expect(extractRefTokens(q)).toEqual([
      { field: 'assigned_to', sysId: '6816f79cc0a8016401c5a33be04be441' },
      { field: 'caller_id', sysId: '5137153cc611227c000bbd1bd8cd2005' },
    ])
  })

  it('ignores clauses with no sys_id, including ORDERBY and ORDERBYDESC', () => {
    expect(extractRefTokens('active=true^priority=1^ORDERBYnumber')).toEqual([])
    expect(extractRefTokens('active=true^ORDERBYDESCnumber')).toEqual([])
  })

  it('pairs a dot-walked field with its sys_id', () => {
    const id = '6816f79cc0a8016401c5a33be04be441'
    expect(extractRefTokens(`assigned_to.department=${id}`)).toEqual([
      { field: 'assigned_to.department', sysId: id },
    ])
  })

  it('does not match 32-char non-hex or a substring of a longer hex run', () => {
    const nonHex = 'short_descriptionLIKEzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
    const long = 'u_hash=6816f79cc0a8016401c5a33be04be441aaaaaaaa'
    expect(extractRefTokens(nonHex)).toEqual([])
    expect(extractRefTokens(long)).toEqual([])
  })

  it('does not match a 32-hex run immediately preceded by more hex characters', () => {
    const q = 'u_hash=aaaaaaaa6816f79cc0a8016401c5a33be04be441'
    expect(extractRefTokens(q)).toEqual([])
  })

  it('does not match an uppercase-hex sys_id (ServiceNow sys_ids are lowercase)', () => {
    const q = 'assigned_to=6816F79CC0A8016401C5A33BE04BE441'
    expect(extractRefTokens(q)).toEqual([])
  })

  it('dedupes a repeated field+sys_id pair', () => {
    const id = '6816f79cc0a8016401c5a33be04be441'
    expect(extractRefTokens(`assigned_to=${id}^ORassigned_to=${id}`)).toHaveLength(1)
  })
})

const ID_A = '6816f79cc0a8016401c5a33be04be441'
const ID_B = '5137153cc611227c000bbd1bd8cd2005'

function clip(over: Partial<ConditionClip> = {}): ConditionClip {
  return {
    host: 'dev1.service-now.com',
    table: 'incident',
    query: `active=true^assigned_to=${ID_A}`,
    labels: { [ID_A]: 'Abel Tuter' },
    savedAt: '2026-07-27T00:00:00.000Z',
    ...over,
  }
}

describe('clipWarnings', () => {
  it('does not warn about a different host — that is the point', () => {
    const w = clipWarnings(clip({ labels: {}, query: 'active=true' }), {
      host: 'dev2.service-now.com',
      table: 'incident',
    })
    expect(w).toEqual([])
  })

  it('warns when the current table differs from the clip table', () => {
    const w = clipWarnings(clip({ query: 'active=true', labels: {} }), {
      host: 'dev2.service-now.com',
      table: 'sc_task',
    })
    expect(w).toEqual(['Clip is for `incident`, this page is `sc_task`.'])
  })

  it('lists a resolved sys_id with its label', () => {
    const w = clipWarnings(clip(), { host: 'dev2.service-now.com', table: 'incident' })
    expect(w).toEqual(['assigned_to = Abel Tuter — sys_id may not exist on this instance.'])
  })

  it('marks an unresolved sys_id as such', () => {
    const w = clipWarnings(clip({ labels: {} }), { host: 'dev2.service-now.com', table: 'incident' })
    expect(w).toEqual(['assigned_to = 6816f79c… — could not resolve.'])
  })

  it('omits the table warning when the current table is unknown', () => {
    const w = clipWarnings(clip({ query: 'active=true', labels: {} }), {
      host: 'dev2.service-now.com',
      table: null,
    })
    expect(w).toEqual([])
  })
})

describe('groupTokensByRefTable', () => {
  it('groups sys_ids by the field\'s reference table, deduped', () => {
    const tokens = [
      { field: 'assigned_to', sysId: ID_A },
      { field: 'caller_id', sysId: ID_B },
      { field: 'assigned_to', sysId: ID_A },
    ]
    const grouped = groupTokensByRefTable(tokens, { assigned_to: 'sys_user', caller_id: 'sys_user' })
    expect(grouped.get('sys_user')).toEqual([ID_A, ID_B])
  })

  it('skips fields with no reference target', () => {
    const grouped = groupTokensByRefTable([{ field: 'u_thing', sysId: ID_A }], {})
    expect(grouped.size).toBe(0)
  })
})
