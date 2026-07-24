/**
 * Side panel entry.
 * M0: context detection.  M1: Condition Tester + schema loader.
 * M2: Script Tester Layer 1 — static lints (LLM-free), with auto-load of the
 *     script from the current Business Rule / Client Script / Script Include.
 */
import type { PageContext, RuntimeMessage } from '@core/types'
import { parseServiceNowContext } from '@core/context'
import { cellDisplay, cellValue, pickLabel } from '@core/api'
import {
  countRecords,
  createRecord,
  deleteRecord,
  getDictionary,
  getRecord,
  queryRecords,
} from '@core/api-client'
import { classifyInstance } from '@core/prod-guard'
import { lintScript, type BrTiming, type LintFinding, type ScriptKind } from '@core/lint'
import { normalizeTiming, scriptTableInfo } from '@core/script-meta'
import { SandboxRunner } from '@core/sandbox-host'
import type { SimulationJob, SimulationResult, TraceEvent } from '@core/trace'
import type { ArtifactRef } from '@core/graph'
import { composeSpec, type SpecDocument } from '@core/spec'
import { renderSpecHtml } from '@core/render-html'
import { renderSpecDocxBlob } from '@core/render-docx'
import { loadRootArtifact, walkSpecGraph } from '@core/spec-runner'

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
  specWalk.disabled = !(current?.table && current.sysId)
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
  // Layer 2/3: point the target table at what this script runs against.
  if (info.tableField) {
    const target = cellValue(rec[info.tableField])
    if (target) {
      simTable.value = target
      l3Table.value = target
    }
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

/* ---------- Layer 3 — Guarded Real Execution (M5) ---------- */

const l3Guard = el('l3-guard')
const l3Table = el<HTMLInputElement>('l3-table')
const l3Fields = el<HTMLTextAreaElement>('l3-fields')
const l3Create = el<HTMLButtonElement>('l3-create')
const l3Delete = el<HTMLButtonElement>('l3-delete')
const l3Results = el('l3-results')

let l3Allowed = false
let l3Created: { table: string; sysId: string } | null = null

function updateProdGuard() {
  if (!current) {
    l3Guard.className = 'guard-badge'
    l3Guard.textContent = 'Checking instance…'
    l3Allowed = false
  } else {
    const verdict = classifyInstance(current.host)
    l3Allowed = verdict.allowed
    l3Guard.className = `guard-badge ${verdict.allowed ? 'ok' : 'blocked'}`
    l3Guard.textContent = verdict.allowed
      ? `✓ ${verdict.instance} — sub-prod. Real execution permitted.`
      : `⛔ ${verdict.reason}`
  }
  l3Create.disabled = !(l3Allowed && current)
  l3Delete.disabled = !(l3Allowed && l3Created)
}

async function createTestRecord() {
  if (!current || !l3Allowed) return
  const table = l3Table.value.trim()
  if (!table) {
    l3Results.replaceChildren(elText('div', 'error', 'Enter a target table.'))
    return
  }
  const fields = parseFields(l3Fields.value)
  if (
    !confirm(
      `Create a REAL record in "${table}" on ${current.host}?\n\nThis runs the actual Business Rules on the instance.`,
    )
  ) {
    return
  }

  l3Create.disabled = true
  l3Results.replaceChildren(elText('div', 'empty', 'Creating record…'))

  const res = await createRecord(current.host, table, fields)
  if (!res.ok) {
    l3Results.replaceChildren(elText('div', 'error', res.error))
    updateProdGuard()
    return
  }
  const sysId = cellValue(res.data['sys_id'])
  l3Created = { table, sysId }

  // Read the created record back to observe what the engine actually did.
  const back = await getRecord(current.host, table, sysId)
  renderL3Result(fields, back.ok ? back.data : res.data, sysId)
  updateProdGuard()
}

function renderL3Result(seed: Record<string, string>, rec: Record<string, unknown>, sysId: string) {
  l3Results.replaceChildren()
  l3Results.append(elText('div', 'ok-banner', `✓ Created ${l3Created?.table} record ${sysId.slice(0, 8)}…`))

  // Highlight fields the engine changed vs. what we sent.
  const changed: string[] = []
  for (const [k, v] of Object.entries(rec)) {
    const after = cellValue(v)
    if (k in seed && seed[k] !== after) changed.push(`${k}: "${seed[k]}" → "${after}"`)
  }
  const engineFields = ['sys_created_by', 'sys_updated_on', 'work_notes', 'state', 'number', 'sys_created_on']
  const box = document.createElement('div')
  box.className = 'sim-after'
  box.append(elText('div', 'sim-after-title', changed.length ? 'Changed by the engine' : 'Result (key fields)'))
  const rows = changed.length
    ? changed
    : engineFields.filter((f) => f in rec).map((f) => `${f}: ${cellValue(rec[f])}`)
  for (const line of rows) {
    const r = document.createElement('div')
    r.className = 'schema-row'
    r.append(elText('span', 'lbl', line))
    box.append(r)
  }
  l3Results.append(box)
  l3Results.append(elText('div', 'ai-note', 'Remember to delete the test record when done.'))
}

async function deleteTestRecord() {
  if (!current || !l3Created) return
  if (!confirm(`Delete test record ${l3Created.sysId.slice(0, 8)}… from ${l3Created.table}?`)) return

  l3Delete.disabled = true
  const res = await deleteRecord(current.host, l3Created.table, l3Created.sysId)
  if (!res.ok) {
    l3Results.append(elText('div', 'error', `Delete failed: ${res.error}`))
    l3Delete.disabled = false
    return
  }
  l3Results.replaceChildren(elText('div', 'ok-banner', '✓ Test record deleted.'))
  l3Created = null
  updateProdGuard()
}

/* ---------- Design Spec Generator (M4 / F1) ---------- */

const specWalk = el<HTMLButtonElement>('spec-walk')
const specStatus = el('spec-status')
const specChecklist = el('spec-checklist')
const specOutput = el('spec-output')
const specHtmlBtn = el<HTMLButtonElement>('spec-html')
const specPdfBtn = el<HTMLButtonElement>('spec-pdf')
const specDocxBtn = el<HTMLButtonElement>('spec-docx')

let specRoot: ArtifactRef | null = null
let specArtifacts: ArtifactRef[] = []
const specExcluded = new Set<string>()
let logoDataUriCache: string | undefined

const ARTIFACT_GROUP: Record<string, string> = {
  table: 'Data model',
  variable: 'Variables',
  variable_set: 'Variable sets',
  ui_policy: 'UI policies',
  script_include: 'Script Includes',
  catalog_client_script: 'Catalog client scripts',
  workflow: 'Integration',
  transform_map: 'Transform maps',
  transform_entry: 'Transform entries',
  acl: 'ACLs',
}

async function getLogoDataUri(): Promise<string | undefined> {
  if (logoDataUriCache !== undefined) return logoDataUriCache
  try {
    const res = await fetch(chrome.runtime.getURL('public/brand/mfec-logo-light.png'))
    const blob = await res.blob()
    logoDataUriCache = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(blob)
    })
  } catch {
    logoDataUriCache = undefined
  }
  return logoDataUriCache
}

async function discoverArtifacts() {
  if (!current?.table || !current.sysId) return
  const { host, table, sysId } = current

  specWalk.disabled = true
  specOutput.hidden = true
  specStatus.hidden = true
  specChecklist.replaceChildren(elText('div', 'empty', 'Loading root record…'))

  const root = await loadRootArtifact(host, table, sysId)
  if (!root) {
    specChecklist.replaceChildren(elText('div', 'error', 'Could not load the root record.'))
    specWalk.disabled = false
    return
  }
  specChecklist.replaceChildren(elText('div', 'empty', 'Walking dependency graph…'))

  try {
    const outcome = await walkSpecGraph(host, root)
    specRoot = outcome.root
    specArtifacts = outcome.artifacts
    specExcluded.clear()
    renderChecklist()
  } catch (err) {
    specChecklist.replaceChildren(elText('div', 'error', (err as Error).message))
  } finally {
    specWalk.disabled = false
  }
}

function renderChecklist() {
  specChecklist.replaceChildren()
  specStatus.hidden = false
  specStatus.textContent = `${specArtifacts.length} discovered`

  if (specArtifacts.length === 0) {
    specChecklist.append(
      elText('div', 'empty', 'No related artifacts found within depth 2. You can still export the root spec.'),
    )
  }

  const groups = new Map<string, ArtifactRef[]>()
  for (const a of specArtifacts) {
    const g = ARTIFACT_GROUP[a.type] ?? a.type
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(a)
  }

  for (const [group, items] of groups) {
    specChecklist.append(elText('div', 'chk-group-title', `${group} (${items.length})`))
    for (const a of items) {
      const rowEl = document.createElement('label')
      rowEl.className = 'chk-item'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = true
      cb.addEventListener('change', () => {
        if (cb.checked) specExcluded.delete(a.id)
        else specExcluded.add(a.id)
      })
      const label = elText('span', 'chk-label', a.label || a.sysId)
      const rel = elText('span', 'chk-rel', a.relation)
      rowEl.append(cb, label, rel)
      specChecklist.append(rowEl)
    }
  }

  specOutput.hidden = false
}

function buildSpecDoc(): SpecDocument | null {
  if (!specRoot || !current) return null
  const included = specArtifacts.filter((a) => !specExcluded.has(a.id))
  return composeSpec({
    instance: current.host,
    rootTable: specRoot.table,
    rootLabel: specRoot.label,
    rootFields: specRoot.fields,
    artifacts: included,
  })
}

function safeName(): string {
  return (specRoot?.label || 'design-spec').replace(/[^\w.-]+/g, '_').slice(0, 60)
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

async function exportHtml() {
  const doc = buildSpecDoc()
  if (!doc) return
  const html = renderSpecHtml(doc, { logoDataUri: await getLogoDataUri() })
  download(new Blob([html], { type: 'text/html' }), `${safeName()}.html`)
}

async function exportPdf() {
  const doc = buildSpecDoc()
  if (!doc) return
  const html = renderSpecHtml(doc, { logoDataUri: await getLogoDataUri() }).replace(
    '</body>',
    '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},350)})</script></body>',
  )
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  // Open in a normal tab so the user can Save as PDF (auto-print dialog).
  await chrome.tabs.create({ url })
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

async function exportDocx() {
  const doc = buildSpecDoc()
  if (!doc) return
  specDocxBtn.disabled = true
  try {
    const blob = await renderSpecDocxBlob(doc)
    download(blob, `${safeName()}.docx`)
  } finally {
    specDocxBtn.disabled = false
  }
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

  // Primary: parse the tab URL directly — works without the content script and
  // covers classic, Next Experience/Polaris, and workspace routes.
  let context = parseServiceNowContext(tab.url!)

  // Best-effort enrichment: the content script can add g_form-derived table/
  // sys_id (e.g. deep Next Experience views the URL doesn't expose) and caches
  // g_ck. Never fatal if it isn't loaded.
  try {
    const res = (await chrome.tabs.sendMessage(tab.id, {
      kind: 'sncat:get-context',
    } satisfies RuntimeMessage)) as RuntimeMessage | undefined
    if (res?.kind === 'sncat:context' && res.context?.table) {
      const enriched = res.context
      // Prefer enrichment when the URL parse couldn't resolve the record.
      if (!context?.table || (!context.sysId && enriched.sysId)) context = enriched
    }
  } catch {
    /* content script not present in this frame — URL parse stands. */
  }

  if (context?.table) {
    current = context
    renderContext(context)
  } else if (context) {
    current = context
    renderContext(context)
  } else {
    renderStatus('No record detected on this page.')
  }
  updateEnabledState()

  // Layer 2: default the simulation target to the current table unless it's a
  // script table (a BR sets the target from its `collection` on auto-load).
  if (current?.table && !scriptTableInfo(current.table) && !simTable.value.trim()) {
    simTable.value = current.table
    if (!l3Table.value.trim()) l3Table.value = current.table
  }
  updateProdGuard()
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
l3Create.addEventListener('click', createTestRecord)
l3Delete.addEventListener('click', deleteTestRecord)
specWalk.addEventListener('click', discoverArtifacts)
specHtmlBtn.addEventListener('click', exportHtml)
specPdfBtn.addEventListener('click', exportPdf)
specDocxBtn.addEventListener('click', exportDocx)

chrome.tabs.onActivated.addListener(detect)
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === 'complete' && tab.active) detect()
})

detect()
