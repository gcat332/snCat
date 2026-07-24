/**
 * Side panel entry.
 * M0: context detection.  M1: Condition Tester + schema loader.
 * M2: Script Tester Layer 1 — static lints (LLM-free), with auto-load of the
 *     script from the current Business Rule / Client Script / Script Include.
 */
import type { PageContext, RuntimeMessage } from '@core/types'
import { cellDisplay, cellValue, pickLabel } from '@core/api'
import { countRecords, getDictionary, getRecord, queryRecords } from '@core/api-client'
import { lintScript, type BrTiming, type LintFinding, type ScriptKind } from '@core/lint'
import { normalizeTiming, scriptTableInfo } from '@core/script-meta'
import { SandboxRunner } from '@core/sandbox-host'
import type { SimulationJob, SimulationResult, TraceEvent } from '@core/trace'

let current: PageContext | null = null
const sandbox = new SandboxRunner()

/* ---------- helpers ---------- */

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

function elText(tag: string, cls: string, text: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = cls
  node.textContent = text
  return node
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

function isServiceNow(url: string | undefined): boolean {
  return !!url && /^https:\/\/[^/]+\.service-now\.com\//.test(url)
}

/* ---------- tabs ---------- */

function initTabs() {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'))
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('is-active'))
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('is-active'))
      tab.classList.add('is-active')
      el(tab.dataset.panel!).classList.add('is-active')
    })
  }
}

/* ---------- context (M0) ---------- */

const gridEl = el('ctx-grid')
const refreshBtn = el<HTMLButtonElement>('refresh-btn')

function ctxRow(term: string, value: string, opts: { mono?: boolean; html?: boolean } = {}) {
  const dt = document.createElement('dt')
  dt.textContent = term
  const dd = document.createElement('dd')
  if (opts.mono) dd.classList.add('mono')
  if (opts.html) dd.innerHTML = value
  else dd.textContent = value
  gridEl.append(dt, dd)
}

function renderContext(ctx: PageContext) {
  gridEl.replaceChildren()
  ctxRow('Instance', ctx.host, { mono: true })
  ctxRow('Table', ctx.table ?? '—', { mono: true })
  ctxRow('sys_id', ctx.sysId ?? '—', { mono: true })
  ctxRow('View', `<span class="pill">${ctx.view}</span>`, { html: true })
  ctxRow('UI', `<span class="pill warn">${ctx.ui}</span>`, { html: true })
  ctxRow('Source', ctx.source)
}

function renderStatus(text: string, cls = 'detecting') {
  gridEl.replaceChildren()
  const dt = document.createElement('dt')
  dt.textContent = 'Status'
  const dd = document.createElement('dd')
  dd.className = cls
  dd.textContent = text
  gridEl.append(dt, dd)
}

/* ---------- Condition Tester + schema (M1) ---------- */

const condHint = el('cond-table-hint')
const condQuery = el<HTMLTextAreaElement>('cond-query')
const condRun = el<HTMLButtonElement>('cond-run')
const condCount = el('cond-count')
const condResults = el('cond-results')
const schemaLoad = el<HTMLButtonElement>('schema-load')
const schemaCount = el('schema-count')
const schemaResults = el('schema-results')

function updateEnabledState() {
  const hasTable = !!current?.table
  condRun.disabled = !hasTable
  schemaLoad.disabled = !hasTable
  condHint.textContent = hasTable && current ? `Table: ${current.table}` : 'Detect a table first.'
}

async function runCondition() {
  if (!current?.table) return
  const { host, table } = current
  const query = condQuery.value.trim()

  condRun.disabled = true
  condCount.hidden = true
  condResults.replaceChildren(elText('div', 'empty', 'Running…'))

  const [countRes, rowsRes] = await Promise.all([
    countRecords(host, table, query || undefined),
    queryRecords(host, table, { query: query || undefined, limit: 10, displayValue: 'all' }),
  ])
  condRun.disabled = false

  if (!countRes.ok) {
    condResults.replaceChildren(elText('div', 'error', countRes.error))
    return
  }
  condCount.hidden = false
  condCount.textContent = `${countRes.data.count} match${countRes.data.count === 1 ? '' : 'es'}`

  if (!rowsRes.ok) {
    condResults.replaceChildren(elText('div', 'error', rowsRes.error))
    return
  }
  condResults.replaceChildren()
  if (rowsRes.data.length === 0) {
    condResults.append(elText('div', 'empty', 'No records match this query.'))
    return
  }
  for (const rec of rowsRes.data) {
    const wrap = document.createElement('div')
    wrap.className = 'result-row'
    const label = elText('span', 'label', pickLabel(rec))
    const sid = elText('span', 'sysid', cellValue(rec['sys_id']).slice(0, 8) || '—')
    wrap.append(label, sid)
    condResults.append(wrap)
  }
}

async function loadSchema() {
  if (!current?.table) return
  const { host, table } = current
  schemaLoad.disabled = true
  schemaCount.hidden = true
  schemaResults.replaceChildren(elText('div', 'empty', 'Loading fields…'))

  const res = await getDictionary(host, table)
  schemaLoad.disabled = false
  if (!res.ok) {
    schemaResults.replaceChildren(elText('div', 'error', res.error))
    return
  }
  schemaCount.hidden = false
  schemaCount.textContent = `${res.data.length} fields`
  schemaResults.replaceChildren()
  if (res.data.length === 0) {
    schemaResults.append(elText('div', 'empty', 'No dictionary rows returned.'))
    return
  }
  for (const f of res.data) {
    const wrap = document.createElement('div')
    wrap.className = 'schema-row'
    wrap.append(
      elText('span', 'col', cellValue(f.element as unknown)),
      elText('span', 'type', cellDisplay(f.internal_type as unknown)),
      elText('span', 'lbl', cellDisplay(f.column_label as unknown)),
    )
    schemaResults.append(wrap)
  }
}

/* ---------- Script Tester Layer 1 (M2) ---------- */

const testerSource = el('tester-source')
const scriptKind = el<HTMLSelectElement>('script-kind')
const timingWrap = el('timing-wrap')
const scriptTiming = el<HTMLSelectElement>('script-timing')
const scriptBody = el<HTMLTextAreaElement>('script-body')
const analyzeBtn = el<HTMLButtonElement>('analyze-btn')
const lintSummary = el('lint-summary')
const lintResults = el('lint-results')

function syncTimingVisibility() {
  timingWrap.style.display = scriptKind.value === 'business_rule' ? '' : 'none'
}

/** If the current record is a script table, pull its script into the tester. */
async function maybeAutoLoadScript() {
  if (!current?.table || !current.sysId) return
  const info = scriptTableInfo(current.table)
  if (!info) return

  testerSource.textContent = 'Loading script from record…'
  const fields = [info.scriptField, info.nameField]
  if (info.timingField) fields.push(info.timingField)
  if (info.tableField) fields.push(info.tableField)

  const res = await getRecord(current.host, current.table, current.sysId, fields)
  if (!res.ok) {
    testerSource.textContent = `Could not auto-load: ${res.error}`
    return
  }
  const rec = res.data
  scriptBody.value = cellValue(rec[info.scriptField])
  scriptKind.value = info.kind
  if (info.timingField) {
    scriptTiming.value = normalizeTiming(cellValue(rec[info.timingField]))
  }
  // Layer 2: point `current` at the table this script runs against.
  if (info.tableField) {
    const target = cellValue(rec[info.tableField])
    if (target) simTable.value = target
  }
  syncTimingVisibility()
  const name = cellDisplay(rec[info.nameField]) || current.table
  testerSource.textContent = `Loaded "${name}" (${info.kind.replace('_', ' ')}).`
}

function analyze() {
  const script = scriptBody.value
  const kind = scriptKind.value as ScriptKind
  const timing = scriptTiming.value as BrTiming
  const findings = lintScript({ script, kind, timing })

  lintResults.replaceChildren()
  lintSummary.hidden = false

  if (!script.trim()) {
    lintSummary.hidden = true
    lintResults.append(elText('div', 'empty', 'Paste or load a script, then Analyze.'))
    return
  }

  const counts = { error: 0, warning: 0, info: 0 }
  findings.forEach((f) => (counts[f.severity] += 1))
  lintSummary.textContent = `${counts.error} error · ${counts.warning} warning · ${counts.info} info`

  if (findings.length === 0) {
    lintResults.append(elText('div', 'ok-banner', '✓ No anti-patterns found by Layer 1 lints.'))
    return
  }
  for (const f of findings) renderFinding(f)
}

function renderFinding(f: LintFinding) {
  const wrap = document.createElement('div')
  wrap.className = `finding ${f.severity}`

  const head = document.createElement('div')
  head.className = 'fhead'
  const rule = document.createElement('span')
  rule.className = 'rule'
  const dot = document.createElement('span')
  dot.className = `sev-dot ${f.severity}`
  rule.append(dot, document.createTextNode(f.rule))
  const loc = elText('span', 'loc', `line ${f.line}`)
  head.append(rule, loc)

  const msg = elText('div', 'msg', f.message)
  wrap.append(head, msg)
  if (f.snippet) wrap.append(elText('code', 'code-snippet', f.snippet))
  lintResults.append(wrap)
}

/* ---------- Layer 2 — Sandbox Simulation (M3) ---------- */

const simTable = el<HTMLInputElement>('sim-table')
const simFill = el<HTMLButtonElement>('sim-fill')
const simCurrent = el<HTMLTextAreaElement>('sim-current')
const simPrevious = el<HTMLTextAreaElement>('sim-previous')
const simRun = el<HTMLButtonElement>('sim-run')
const simStatus = el('sim-status')
const simResults = el('sim-results')

/** Parse "field=value" lines into a map (first '=' splits). */
function parseFields(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

function fieldsToText(rec: Record<string, unknown>): string {
  return Object.entries(rec)
    .filter(([k]) => !k.startsWith('__'))
    .map(([k, v]) => `${k}=${cellValue(v)}`)
    .join('\n')
}

async function fillFromRecord() {
  const table = simTable.value.trim()
  if (!current || !table) return
  simFill.disabled = true
  const prev = simFill.textContent
  simFill.textContent = 'Loading…'
  const res = await queryRecords(current.host, table, { limit: 1, displayValue: false })
  simFill.disabled = false
  simFill.textContent = prev
  if (!res.ok) {
    simResults.replaceChildren(elText('div', 'error', res.error))
    return
  }
  if (res.data.length === 0) {
    simResults.replaceChildren(elText('div', 'empty', `No records in ${table} to sample.`))
    return
  }
  simCurrent.value = fieldsToText(res.data[0])
}

async function runSimulation() {
  const script = scriptBody.value
  if (!script.trim()) {
    simResults.replaceChildren(elText('div', 'empty', 'Load or paste a script in Layer 1 first.'))
    return
  }
  const job: SimulationJob = {
    script,
    kind: scriptKind.value as ScriptKind,
    timing: scriptTiming.value as BrTiming,
    table: simTable.value.trim() || 'incident',
    currentFields: parseFields(simCurrent.value),
    previousFields: simPrevious.value.trim() ? parseFields(simPrevious.value) : undefined,
  }

  simRun.disabled = true
  simStatus.hidden = true
  simResults.replaceChildren(elText('div', 'empty', 'Running in sandbox…'))

  try {
    const result = await sandbox.run(job)
    renderSimResult(result)
  } catch (err) {
    simResults.replaceChildren(elText('div', 'error', (err as Error).message))
  } finally {
    simRun.disabled = false
  }
}

const TRACE_LABEL: Record<TraceEvent['type'], string> = {
  'field-set': 'set',
  message: 'msg',
  log: 'log',
  abort: 'abort',
  query: 'query',
  'write-blocked': 'blocked',
  call: 'call',
  exception: 'error',
}

function traceText(e: TraceEvent): string {
  switch (e.type) {
    case 'field-set':
      return `${e.target}.${e.field}: "${e.from}" → "${e.to}"`
    case 'message':
      return `addMessage(${e.level}): ${e.text}`
    case 'log':
      return `gs.${e.level}: ${e.text}`
    case 'abort':
      return `setAbortAction(${e.value})`
    case 'query':
      return `${e.table}.query(${e.encodedQuery || 'no filter'})`
    case 'write-blocked':
      return `${e.op}() on ${e.table} — ${e.note}`
    case 'call':
      return `${e.api}(${e.detail})`
    case 'exception':
      return e.message
  }
}

function traceSeverity(e: TraceEvent): 'error' | 'warning' | 'info' {
  if (e.type === 'exception') return 'error'
  if (e.type === 'write-blocked' || e.type === 'abort') return 'warning'
  if (e.type === 'message' && e.level === 'error') return 'warning'
  return 'info'
}

function renderSimResult(result: SimulationResult) {
  simResults.replaceChildren()
  simStatus.hidden = false
  simStatus.textContent = result.ok
    ? `${result.events.length} events`
    : 'threw an exception'

  if (result.events.length === 0 && result.ok) {
    simResults.append(elText('div', 'ok-banner', '✓ Script ran; no observable Glide effects.'))
  }

  for (const e of result.events) {
    const sev = traceSeverity(e)
    const wrap = document.createElement('div')
    wrap.className = `finding ${sev}`
    const head = document.createElement('div')
    head.className = 'fhead'
    const rule = document.createElement('span')
    rule.className = 'rule'
    rule.append(
      Object.assign(document.createElement('span'), { className: `sev-dot ${sev}` }),
      document.createTextNode(TRACE_LABEL[e.type]),
    )
    head.append(rule)
    wrap.append(head, elText('div', 'msg', traceText(e)))
    simResults.append(wrap)
  }

  // "current after" summary
  const after = Object.entries(result.currentAfter)
  if (after.length) {
    const box = document.createElement('div')
    box.className = 'sim-after'
    box.append(elText('div', 'sim-after-title', 'current (after)'))
    for (const [k, v] of after) {
      const r = document.createElement('div')
      r.className = 'schema-row'
      r.append(elText('span', 'col', k), elText('span', 'lbl', v))
      box.append(r)
    }
    simResults.append(box)
  }

  simResults.append(elText('div', 'ai-note', result.note))
}

/* ---------- detect + wiring ---------- */

async function detect() {
  renderStatus('Detecting…')
  current = null
  updateEnabledState()

  const tab = await getActiveTab()
  if (!tab?.id || !isServiceNow(tab.url)) {
    renderStatus('Open a ServiceNow page to detect context.')
    return
  }
  try {
    const res = (await chrome.tabs.sendMessage(tab.id, {
      kind: 'sncat:get-context',
    } satisfies RuntimeMessage)) as RuntimeMessage | undefined

    if (res?.kind === 'sncat:context' && res.context) {
      current = res.context
      renderContext(res.context)
    } else {
      renderStatus('No record detected on this page.')
    }
  } catch {
    renderStatus('Content script not loaded — reload the ServiceNow tab, then Refresh.', 'error')
  }
  updateEnabledState()

  // Layer 2: default the simulation target to the current table unless it's a
  // script table (a BR sets the target from its `collection` on auto-load).
  if (current?.table && !scriptTableInfo(current.table) && !simTable.value.trim()) {
    simTable.value = current.table
  }
  void maybeAutoLoadScript()
}

initTabs()
syncTimingVisibility()

refreshBtn.addEventListener('click', detect)
condRun.addEventListener('click', runCondition)
schemaLoad.addEventListener('click', loadSchema)
scriptKind.addEventListener('change', syncTimingVisibility)
analyzeBtn.addEventListener('click', analyze)
simFill.addEventListener('click', fillFromRecord)
simRun.addEventListener('click', runSimulation)

chrome.tabs.onActivated.addListener(detect)
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === 'complete' && tab.active) detect()
})

detect()
