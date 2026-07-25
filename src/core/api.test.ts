import { describe, it, expect } from 'vitest'
import {
  buildTableQueryUrl,
  buildRecordUrl,
  buildStatsCountUrl,
  buildDictionaryUrl,
  buildChoicesQuery,
  cellValue,
  cellDisplay,
  pickLabel,
} from './api'

const HOST = 'mfecplcdemo10.service-now.com'

describe('URL builders', () => {
  it('builds a table query URL with defaults', () => {
    const url = new URL(buildTableQueryUrl(HOST, 'incident'))
    expect(url.origin).toBe(`https://${HOST}`)
    expect(url.pathname).toBe('/api/now/table/incident')
    expect(url.searchParams.get('sysparm_limit')).toBe('10')
    expect(url.searchParams.get('sysparm_display_value')).toBe('all')
  })

  it('encodes the query and fields', () => {
    const url = new URL(
      buildTableQueryUrl(HOST, 'incident', {
        query: 'active=true^priority=1',
        fields: ['sys_id', 'number'],
        limit: 25,
        offset: 50,
      }),
    )
    expect(url.searchParams.get('sysparm_query')).toBe('active=true^priority=1')
    expect(url.searchParams.get('sysparm_fields')).toBe('sys_id,number')
    expect(url.searchParams.get('sysparm_limit')).toBe('25')
    expect(url.searchParams.get('sysparm_offset')).toBe('50')
  })

  it('builds a single-record URL', () => {
    const url = new URL(buildRecordUrl(HOST, 'incident', 'abc123'))
    expect(url.pathname).toBe('/api/now/table/incident/abc123')
    expect(url.searchParams.get('sysparm_display_value')).toBe('all')
  })

  it('builds a stats count URL', () => {
    const url = new URL(buildStatsCountUrl(HOST, 'incident', 'active=true'))
    expect(url.pathname).toBe('/api/now/stats/incident')
    expect(url.searchParams.get('sysparm_count')).toBe('true')
    expect(url.searchParams.get('sysparm_query')).toBe('active=true')
  })

  it('builds a dictionary URL scoped to the table', () => {
    const url = new URL(buildDictionaryUrl(HOST, 'incident'))
    expect(url.pathname).toBe('/api/now/table/sys_dictionary')
    expect(url.searchParams.get('sysparm_query')).toContain('name=incident')
    expect(url.searchParams.get('sysparm_query')).toContain('elementISNOTEMPTY')
  })
})

describe('identifier injection guard (T-101)', () => {
  const VALID_TABLES = ['incident', 'sys_user', 'u_my_table', 'x_scope_app_table']

  it('rejects a table name with an encoded-query metacharacter in buildDictionaryUrl', () => {
    expect(() => buildDictionaryUrl(HOST, 'incident^ORx')).toThrow()
    expect(() => buildDictionaryUrl(HOST, 'incident^ORr:payload=1')).toThrow()
    expect(() => buildDictionaryUrl(HOST, 'foo bar')).toThrow()
    expect(() => buildDictionaryUrl(HOST, 'name=incident^ORDERBYsys_id')).toThrow()
  })

  it('accepts valid table names in buildDictionaryUrl and produces the expected query', () => {
    for (const table of VALID_TABLES) {
      const url = new URL(buildDictionaryUrl(HOST, table))
      expect(url.pathname).toBe('/api/now/table/sys_dictionary')
      expect(url.searchParams.get('sysparm_query')).toBe(
        `name=${table}^elementISNOTEMPTY^ORDERBYelement`,
      )
    }
  })

  it('rejects table/element names with metacharacters in buildChoicesQuery', () => {
    expect(() => buildChoicesQuery('incident^ORx', 'state')).toThrow()
    expect(() => buildChoicesQuery('incident', 'state^ORx')).toThrow()
    expect(() => buildChoicesQuery('incident', 'state=1^ORDERBYx')).toThrow()
    expect(() => buildChoicesQuery('foo bar', 'state')).toThrow()
  })

  it('accepts valid names in buildChoicesQuery and produces the expected query', () => {
    expect(buildChoicesQuery('incident', 'state')).toBe(
      'name=incident^element=state^inactive=false^ORDERBYsequence^ORDERBYlabel',
    )
    expect(buildChoicesQuery('u_my_table', 'u_field')).toBe(
      'name=u_my_table^element=u_field^inactive=false^ORDERBYsequence^ORDERBYlabel',
    )
  })
})

describe('cell helpers', () => {
  it('reads value and display_value from an "all" cell', () => {
    const cell = { value: '1', display_value: 'Critical' }
    expect(cellValue(cell)).toBe('1')
    expect(cellDisplay(cell)).toBe('Critical')
  })

  it('handles raw string cells', () => {
    expect(cellValue('hello')).toBe('hello')
    expect(cellDisplay('hello')).toBe('hello')
  })

  it('falls back display → value when no display_value', () => {
    expect(cellDisplay({ value: 'x' })).toBe('x')
  })

  it('handles null/undefined', () => {
    expect(cellValue(null)).toBe('')
    expect(cellDisplay(undefined)).toBe('')
  })
})

describe('pickLabel', () => {
  it('prefers number over sys_id', () => {
    const rec = { sys_id: { value: 'zzz' }, number: { value: 'INC001', display_value: 'INC001' } }
    expect(pickLabel(rec)).toBe('INC001')
  })

  it('falls back to sys_id when no label field present', () => {
    const rec = { sys_id: { value: 'abc', display_value: 'abc' } }
    expect(pickLabel(rec)).toBe('abc')
  })
})
