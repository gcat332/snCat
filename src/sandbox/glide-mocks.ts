/**
 * Mocked Glide APIs for Layer 2 simulation (handoff §4).
 *
 * Scope decision (§7 #1): built for global scope, structured so scoped-app
 * variants (GlideRecordSecure, scoped gs) drop in — GlideRecordSecure is
 * currently an alias to the same mock, to be tightened with ACL-aware reads.
 *
 * INVARIANT: nothing here performs a real write. insert/update/deleteRecord are
 * recorded as `write-blocked` and never touch the instance.
 */
import type { TraceEvent } from '@core/trace'

export type PushEvent = (event: TraceEvent) => void

const METHOD_KEYS = new Set([
  'getValue', 'setValue', 'getDisplayValue', 'setDisplayValue', 'getTableName',
  'getUniqueValue', 'getRecordClassName', 'canWrite', 'canRead', 'canCreate',
  'update', 'insert', 'deleteRecord', 'deleteMultiple', 'setAbortAction',
  'setWorkflow', 'autoSysFields', 'addQuery', 'addEncodedQuery', 'addActiveQuery',
  'addNullQuery', 'addNotNullQuery', 'addJoinQuery', 'addOrCondition', 'query',
  'get', 'next', '_next', 'hasNext', 'initialize', 'newRecord', 'setLimit',
  'orderBy', 'orderByDesc', 'isValidRecord', 'getRowCount', 'operation',
  'isNewRecord', 'setValue', 'toString', 'getEncodedQuery',
])

interface RecordOpts {
  role: 'current' | 'previous' | 'gr'
  readonly?: boolean
  operation?: 'insert' | 'update' | 'delete'
}

export interface MockRecord {
  proxy: Record<string, unknown>
  dump: () => Record<string, string>
}

/**
 * Build a GlideRecord-like Proxy. Field access reads/writes a backing map;
 * method access returns the Glide API surface. Used for current/previous and
 * for `new GlideRecord()` (query mode).
 */
export function createRecordProxy(
  table: string,
  seed: Record<string, string>,
  push: PushEvent,
  opts: RecordOpts,
): MockRecord {
  const fields: Record<string, string> = { ...seed }
  const conditions: string[] = []

  function setField(field: string, value: unknown): void {
    const to = value == null ? '' : String(value)
    const from = fields[field] ?? ''
    if (from !== to) {
      push({ type: 'field-set', target: opts.role, table, field, from, to })
    }
    fields[field] = to
  }

  const methods: Record<string, (...args: unknown[]) => unknown> = {
    getValue: (f) => fields[String(f)] ?? '',
    getDisplayValue: (f) => fields[String(f)] ?? '',
    setValue: (f, v) => {
      setField(String(f), v)
    },
    setDisplayValue: (f, v) => {
      setField(String(f), v)
    },
    getTableName: () => table,
    getRecordClassName: () => table,
    getUniqueValue: () => fields['sys_id'] ?? '',
    canWrite: () => true,
    canRead: () => true,
    canCreate: () => true,
    isValidRecord: () => opts.role !== 'gr',
    isNewRecord: () => opts.operation === 'insert',
    operation: () => opts.operation ?? 'update',
    getRowCount: () => 0,
    autoSysFields: () => undefined,
    setWorkflow: (b) => push({ type: 'call', api: `${opts.role}.setWorkflow`, detail: String(b) }),
    setAbortAction: (b) => push({ type: 'abort', value: Boolean(b) }),
    update: () =>
      push({
        type: 'write-blocked',
        op: 'update',
        table,
        note:
          opts.role === 'current'
            ? 'current.update() — not executed in simulation.'
            : 'update() — not executed in simulation.',
      }),
    insert: () => {
      push({ type: 'write-blocked', op: 'insert', table, note: 'insert() — not executed.' })
      return 'sim_' + table + '_new'
    },
    deleteRecord: () => {
      push({ type: 'write-blocked', op: 'deleteRecord', table, note: 'deleteRecord() — not executed.' })
      return true
    },
    deleteMultiple: () =>
      push({ type: 'write-blocked', op: 'deleteMultiple', table, note: 'deleteMultiple() — not executed.' }),
    addQuery: (f, op, val) => {
      conditions.push(val === undefined ? `${f}=${op}` : `${f}${op}${val}`)
      return { addOrCondition: () => undefined }
    },
    addActiveQuery: () => conditions.push('active=true'),
    addNullQuery: (f) => conditions.push(`${f}ISEMPTY`),
    addNotNullQuery: (f) => conditions.push(`${f}ISNOTEMPTY`),
    addEncodedQuery: (q) => conditions.push(String(q)),
    addJoinQuery: () => undefined,
    getEncodedQuery: () => conditions.join('^'),
    orderBy: () => undefined,
    orderByDesc: () => undefined,
    setLimit: () => undefined,
    initialize: () => undefined,
    newRecord: () => undefined,
    query: () => push({ type: 'query', table, encodedQuery: conditions.join('^') }),
    get: (a, b) => {
      const q = b === undefined ? `sys_id=${a}` : `${a}=${b}`
      push({ type: 'query', table, encodedQuery: q })
      return false // read-through against the instance is a later milestone
    },
    next: () => false,
    _next: () => false,
    hasNext: () => false,
    toString: () => fields['sys_id'] ?? `[GlideRecord:${table}]`,
  }

  const proxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'then') return undefined // never look thenable
        if (METHOD_KEYS.has(prop) && methods[prop]) return methods[prop]
        if (prop in methods) return methods[prop]
        return fields[prop] ?? ''
      },
      set(_t, prop, value) {
        if (typeof prop === 'symbol') return true
        if (opts.readonly) {
          push({ type: 'call', api: `${opts.role}.${prop}=`, detail: 'ignored (read-only)' })
          return true
        }
        setField(prop, value)
        return true
      },
      has: () => true,
    },
  ) as Record<string, unknown>

  return { proxy, dump: () => ({ ...fields }) }
}

/** GlideSystem (gs) mock — all output captured to the trace. */
export function createGlideSystem(push: PushEvent) {
  const join = (args: unknown[]) => args.map((a) => String(a)).join(' ')
  return {
    addInfoMessage: (m: unknown) => push({ type: 'message', level: 'info', text: String(m) }),
    addErrorMessage: (m: unknown) => push({ type: 'message', level: 'error', text: String(m) }),
    info: (...a: unknown[]) => push({ type: 'log', level: 'info', text: join(a) }),
    warn: (...a: unknown[]) => push({ type: 'log', level: 'warn', text: join(a) }),
    error: (...a: unknown[]) => push({ type: 'log', level: 'error', text: join(a) }),
    debug: (...a: unknown[]) => push({ type: 'log', level: 'info', text: join(a) }),
    log: (...a: unknown[]) => push({ type: 'log', level: 'info', text: join(a) }),
    print: (...a: unknown[]) => push({ type: 'log', level: 'info', text: join(a) }),
    getUserID: () => 'sim_user_sys_id',
    getUserName: () => 'sim.user',
    getUserDisplayName: () => 'Simulated User',
    getUser: () => ({
      getID: () => 'sim_user_sys_id',
      getFullName: () => 'Simulated User',
      hasRole: () => true,
    }),
    hasRole: () => true,
    getProperty: (_k: unknown, d?: unknown) => (d !== undefined ? String(d) : ''),
    getMessage: (k: unknown) => String(k),
    nowDateTime: () => '2026-01-01 00:00:00',
    now: () => '2026-01-01',
    isInteractive: () => true,
    eventQueue: (name: unknown, ..._rest: unknown[]) =>
      push({ type: 'call', api: 'gs.eventQueue', detail: String(name) }),
  }
}

/** BR `action` mock (redirects etc.) — captured, never navigated. */
export function createAction(push: PushEvent) {
  const rec = (api: string) => (v?: unknown) =>
    push({ type: 'call', api: `action.${api}`, detail: v === undefined ? '' : String(v) })
  return {
    setRedirectURL: rec('setRedirectURL'),
    setReturnURL: rec('setReturnURL'),
    setNoPop: rec('setNoPop'),
    getGlideURI: () => ({ toString: () => '' }),
  }
}

/** Minimal g_form / g_user for client-script bodies that reference them. */
export function createClientGlobals(push: PushEvent, table: string) {
  const g_form = {
    getValue: (_f: unknown) => '',
    setValue: (f: unknown, v: unknown) =>
      push({ type: 'field-set', target: 'g_form', table, field: String(f), from: '', to: String(v) }),
    getControl: () => null,
    setMandatory: (f: unknown, b: unknown) =>
      push({ type: 'call', api: 'g_form.setMandatory', detail: `${f}=${b}` }),
    setVisible: (f: unknown, b: unknown) =>
      push({ type: 'call', api: 'g_form.setVisible', detail: `${f}=${b}` }),
    setDisplay: (f: unknown, b: unknown) =>
      push({ type: 'call', api: 'g_form.setDisplay', detail: `${f}=${b}` }),
    addInfoMessage: (m: unknown) => push({ type: 'message', level: 'info', text: String(m) }),
    addErrorMessage: (m: unknown) => push({ type: 'message', level: 'error', text: String(m) }),
    showFieldMsg: (...a: unknown[]) =>
      push({ type: 'call', api: 'g_form.showFieldMsg', detail: a.map(String).join(',') }),
    clearMessages: () => undefined,
    getTableName: () => table,
  }
  const g_user = {
    userID: 'sim_user_sys_id',
    userName: 'sim.user',
    firstName: 'Sim',
    lastName: 'User',
    hasRole: () => true,
    hasRoleExactly: () => true,
  }
  return { g_form, g_user }
}
