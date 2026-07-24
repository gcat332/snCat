import { describe, it, expect } from 'vitest'
import { runSimulation } from './engine'
import type { SimulationJob, TraceEvent } from '@core/trace'

function job(partial: Partial<SimulationJob> & Pick<SimulationJob, 'script'>): SimulationJob {
  return {
    kind: 'business_rule',
    timing: 'before',
    table: 'incident',
    currentFields: { sys_id: 'abc', priority: '3', short_description: 'test' },
    ...partial,
  }
}

function types(events: TraceEvent[]): string[] {
  return events.map((e) => e.type)
}

describe('runSimulation — current field changes', () => {
  it('records a field-set when the script sets a field', () => {
    const res = runSimulation(job({ script: 'current.priority = 1;' }))
    expect(res.ok).toBe(true)
    const set = res.events.find((e) => e.type === 'field-set')
    expect(set).toMatchObject({ target: 'current', field: 'priority', from: '3', to: '1' })
    expect(res.currentAfter.priority).toBe('1')
  })

  it('supports setValue() and getValue()', () => {
    const res = runSimulation(
      job({ script: 'current.setValue("priority", current.getValue("priority") * 1 + 1);' }),
    )
    expect(res.currentAfter.priority).toBe('4')
  })

  it('reads seeded values via property access', () => {
    const res = runSimulation(
      job({
        script: 'if (current.short_description == "test") { current.category = "matched"; }',
      }),
    )
    expect(res.currentAfter.category).toBe('matched')
  })
})

describe('runSimulation — gs and abort', () => {
  it('captures gs.addInfoMessage / addErrorMessage', () => {
    const res = runSimulation(
      job({ script: 'gs.addInfoMessage("hi"); gs.addErrorMessage("bad");' }),
    )
    const msgs = res.events.filter((e) => e.type === 'message')
    expect(msgs).toEqual([
      { type: 'message', level: 'info', text: 'hi' },
      { type: 'message', level: 'error', text: 'bad' },
    ])
  })

  it('captures current.setAbortAction as an abort event', () => {
    const res = runSimulation(job({ script: 'current.setAbortAction(true);' }))
    expect(res.events).toContainEqual({ type: 'abort', value: true })
  })
})

describe('runSimulation — GlideRecord', () => {
  it('records a query with its encoded conditions and never returns rows', () => {
    const res = runSimulation(
      job({
        script: [
          'var gr = new GlideRecord("problem");',
          'gr.addQuery("active", true);',
          'gr.addQuery("priority", "<", 3);',
          'gr.query();',
          'while (gr.next()) { current.x = "should not happen"; }',
        ].join('\n'),
      }),
    )
    const query = res.events.find((e) => e.type === 'query')
    expect(query).toMatchObject({ table: 'problem', encodedQuery: 'active=true^priority<3' })
    // next() is always false → the loop body never runs
    expect(res.currentAfter.x).toBeUndefined()
  })

  it('blocks writes: insert/update/deleteRecord are captured, not executed', () => {
    const res = runSimulation(
      job({
        script: [
          'var gr = new GlideRecord("task");',
          'gr.initialize();',
          'gr.setValue("short_description", "x");',
          'gr.insert();',
          'gr.deleteRecord();',
        ].join('\n'),
      }),
    )
    const blocked = res.events.filter((e) => e.type === 'write-blocked').map((e) => (e as { op: string }).op)
    expect(blocked).toEqual(['insert', 'deleteRecord'])
  })
})

describe('runSimulation — before-BR current.update()', () => {
  it('captures current.update() as write-blocked (never executed)', () => {
    const res = runSimulation(job({ script: 'current.update();' }))
    expect(res.events).toContainEqual({
      type: 'write-blocked',
      op: 'update',
      table: 'incident',
      note: 'current.update() — not executed in simulation.',
    })
  })
})

describe('runSimulation — previous is read-only', () => {
  it('ignores writes to previous and reads seeded previous values', () => {
    const res = runSimulation(
      job({
        previousFields: { sys_id: 'abc', priority: '5' },
        script: [
          'if (previous.priority != current.priority) { gs.info("changed"); }',
          'previous.priority = 99;',
        ].join('\n'),
      }),
    )
    expect(res.events.some((e) => e.type === 'log' && e.text === 'changed')).toBe(true)
    // write to previous is ignored (recorded as a call, not a field-set)
    expect(res.events.some((e) => e.type === 'field-set' && e.target === 'previous')).toBe(false)
  })
})

describe('runSimulation — errors', () => {
  it('captures a thrown exception without crashing', () => {
    const res = runSimulation(job({ script: 'throw new Error("boom");' }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('boom')
    expect(types(res.events)).toContain('exception')
  })

  it('reports a syntax error', () => {
    const res = runSimulation(job({ script: 'this is not valid js {' }))
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })
})
