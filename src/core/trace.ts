/**
 * Script Tester — Layer 2 simulation trace model (handoff §4).
 *
 * The simulation runs the user's script against mocked Glide APIs and records
 * everything it did as a list of TraceEvents. ZERO writes hit the instance —
 * insert/update/delete are captured as `write-blocked`, never executed.
 */
import type { BrTiming, ScriptKind } from './lint'

export type TraceLevel = 'info' | 'warn' | 'error'

/** What the running script did, in order. */
export type TraceEvent =
  | {
      type: 'field-set'
      target: 'current' | 'gr' | 'g_form' | 'previous'
      table: string
      field: string
      from: string
      to: string
    }
  | { type: 'message'; level: TraceLevel; text: string }
  | { type: 'log'; level: TraceLevel; text: string }
  | { type: 'abort'; value: boolean }
  | { type: 'query'; table: string; encodedQuery: string }
  | { type: 'write-blocked'; op: string; table: string; note: string }
  | { type: 'call'; api: string; detail: string }
  | { type: 'exception'; message: string }

/** The job handed to the sandbox. */
export interface SimulationJob {
  script: string
  kind: ScriptKind
  timing?: BrTiming
  table: string
  sysId?: string
  /** Seed values for `current` (field → string value). */
  currentFields: Record<string, string>
  /** Seed values for `previous`; defaults to currentFields when omitted. */
  previousFields?: Record<string, string>
  /** current.operation() result: 'insert' | 'update' | 'delete'. */
  operation?: 'insert' | 'update' | 'delete'
}

/** What the sandbox returns. */
export interface SimulationResult {
  ok: boolean
  events: TraceEvent[]
  /** `current` field values after the script ran. */
  currentAfter: Record<string, string>
  /** Present when the script threw. */
  error?: string
  /** Human note about fidelity (Rhino vs V8, zero writes). */
  note: string
}

/** postMessage envelopes between the side panel host and the sandbox iframe. */
export type SandboxMessage =
  | { kind: 'sncat:sim:run'; id: string; job: SimulationJob }
  | { kind: 'sncat:sim:result'; id: string; result: SimulationResult }
  | { kind: 'sncat:sim:ready' }

export const SIM_NOTE =
  'Simulation runs in V8; the instance is Rhino (ES5), so results are indicative, not ground truth. No writes were made to the instance.'
