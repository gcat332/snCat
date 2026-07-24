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

let current: PageContext | null = null

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
  void maybeAutoLoadScript()
}

initTabs()
syncTimingVisibility()

refreshBtn.addEventListener('click', detect)
condRun.addEventListener('click', runCondition)
schemaLoad.addEventListener('click', loadSchema)
scriptKind.addEventListener('change', syncTimingVisibility)
analyzeBtn.addEventListener('click', analyze)

chrome.tabs.onActivated.addListener(detect)
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === 'complete' && tab.active) detect()
})

detect()
