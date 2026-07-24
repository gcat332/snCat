/**
 * Layer 2 simulation engine (handoff §4). Pure and DOM-free so it runs both in
 * the sandboxed iframe (browser) and under Vitest (Node) — the hard logic is
 * fully unit-tested without a live instance.
 *
 * It builds the mocked Glide scope, executes the user's script with
 * `new Function`, and returns the collected trace. It performs ZERO instance
 * writes.
 */
import type { SimulationJob, SimulationResult, TraceEvent } from '@core/trace'
import { SIM_NOTE } from '@core/trace'
import {
  createAction,
  createClientGlobals,
  createGlideSystem,
  createRecordProxy,
  type PushEvent,
} from './glide-mocks'

export function runSimulation(job: SimulationJob): SimulationResult {
  const events: TraceEvent[] = []
  const push: PushEvent = (e) => events.push(e)

  const current = createRecordProxy(job.table, job.currentFields, push, {
    role: 'current',
    operation: job.operation,
  })
  const previous = createRecordProxy(
    job.table,
    job.previousFields ?? job.currentFields,
    push,
    { role: 'previous', readonly: true },
  )
  const gs = createGlideSystem(push)
  const action = createAction(push)
  const { g_form, g_user } = createClientGlobals(push, job.table)

  // GlideRecord constructor (works with or without `new`).
  function GlideRecord(this: unknown, table: string) {
    return createRecordProxy(table, {}, push, { role: 'gr' }).proxy
  }
  // Scoped alias — tightened to ACL-aware reads in a later pass (§7 #1).
  const GlideRecordSecure = GlideRecord

  const scope: Record<string, unknown> = {
    current: current.proxy,
    previous: previous.proxy,
    gs,
    action,
    GlideRecord,
    GlideRecordSecure,
    g_form,
    g_user,
  }

  let ok = true
  let error: string | undefined

  try {
    const keys = Object.keys(scope)
    const fn = new Function(...keys, `"use strict";\n${job.script}\n`)
    fn(...keys.map((k) => scope[k]))
  } catch (err) {
    ok = false
    error = (err as Error).message
    push({ type: 'exception', message: error })
  }

  return {
    ok,
    events,
    currentAfter: current.dump(),
    error,
    note: SIM_NOTE,
  }
}
