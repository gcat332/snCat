import { describe, it, expect } from 'vitest'
import { buildReviewPrompt, extractJson } from './llm'

describe('buildReviewPrompt', () => {
  it('includes the script, table, kind and intent', () => {
    const { system, user } = buildReviewPrompt({
      script: 'current.update();',
      kind: 'business_rule',
      timing: 'before',
      table: 'incident',
      intent: 'set priority',
    })
    expect(system).toContain('ServiceNow')
    expect(user).toContain('current.update();')
    expect(user).toContain('incident')
    expect(user).toContain('Business Rule')
    expect(user).toContain('when: before')
    expect(user).toContain('set priority')
    expect(user).toContain('optimizedScript')
    expect(user).toContain('testScript')
  })
})

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('parses fenced JSON', () => {
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 })
  })
  it('parses JSON embedded in prose', () => {
    expect(extractJson('Here you go: {"a":3} thanks')).toEqual({ a: 3 })
  })
  it('throws on non-JSON', () => {
    expect(() => extractJson('no json here')).toThrow()
  })
})
