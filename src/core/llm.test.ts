import { describe, it, expect } from 'vitest'
import { buildPlanPrompt, buildReviewPrompt, extractJson } from './llm'

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

describe('buildPlanPrompt', () => {
  it('includes the requirement, table, and asks for an artifacts array', () => {
    const { system, user } = buildPlanPrompt('Add a VIP field and an ACL', {
      table: 'incident',
      fields: ['priority', 'state'],
    })
    expect(system).toContain('ServiceNow')
    expect(user).toContain('Add a VIP field and an ACL')
    expect(user).toContain('incident')
    expect(user).toContain('"artifacts"')
    expect(user).toContain('targetTable')
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
  it('parses a valid object whose string values and trailing prose both contain braces (T-104)', () => {
    const reply =
      '{"optimizedScript":"function f(){ return {a:1}; }","testScript":"gs.info(\'x\');","notes":["ok"]}' +
      '\n\nHope this helps! :)}'
    expect(extractJson(reply)).toEqual({
      optimizedScript: 'function f(){ return {a:1}; }',
      testScript: "gs.info('x');",
      notes: ['ok'],
    })
  })
  it('throws on non-JSON', () => {
    expect(() => extractJson('no json here')).toThrow()
  })
})
