import { describe, it, expect } from 'vitest'
import { extractRefTokens } from './condition-clip'

describe('extractRefTokens', () => {
  it('pairs a sys_id with the field in its clause', () => {
    const q = 'active=true^assigned_to=6816f79cc0a8016401c5a33be04be441'
    expect(extractRefTokens(q)).toEqual([
      { field: 'assigned_to', sysId: '6816f79cc0a8016401c5a33be04be441' },
    ])
  })

  it('handles IN lists and ^OR / ^NQ separators', () => {
    const q =
      'assignment_groupIN287ee6fea9fe198100ada7950d0b1b73,d625dccec0a8016700a222a0f7900d06' +
      '^ORcaller_id=5137153cc611227c000bbd1bd8cd2005'
    expect(extractRefTokens(q)).toEqual([
      { field: 'assignment_group', sysId: '287ee6fea9fe198100ada7950d0b1b73' },
      { field: 'assignment_group', sysId: 'd625dccec0a8016700a222a0f7900d06' },
      { field: 'caller_id', sysId: '5137153cc611227c000bbd1bd8cd2005' },
    ])
  })

  it('ignores clauses with no sys_id, including ORDERBY', () => {
    expect(extractRefTokens('active=true^priority=1^ORDERBYnumber')).toEqual([])
  })

  it('does not match 32-char non-hex or a substring of a longer hex run', () => {
    const nonHex = 'short_descriptionLIKEzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
    const long = 'u_hash=6816f79cc0a8016401c5a33be04be441aaaaaaaa'
    expect(extractRefTokens(nonHex)).toEqual([])
    expect(extractRefTokens(long)).toEqual([])
  })

  it('dedupes a repeated field+sys_id pair', () => {
    const id = '6816f79cc0a8016401c5a33be04be441'
    expect(extractRefTokens(`assigned_to=${id}^ORassigned_to=${id}`)).toHaveLength(1)
  })
})
