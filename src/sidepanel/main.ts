/**
 * Side panel entry.
 * M0: ask the active tab's content script for the current PageContext.
 * M1: run the Condition Tester (query → count + sample rows) and load the
 *     table schema (sys_dictionary) through the background REST broker.
 */
import type { PageContext, RuntimeMessage } from '@core/types'
import { cellDisplay, pickLabel, cellValue } from '@core/api'
import { countRecords, queryRecords, getDictionary } from '@core/api-client'

const gridEl = el('ctx-grid')
const refreshBtn = el<HTMLButtonElement>('refresh-btn')

const condHint = el('cond-table-hint')
const condQuery = el<HTMLTextAreaElement>('cond-query')
const condRun = el<HTMLButtonElement>('cond-run')
const condCount = el('cond-count')
const condResults = el('cond-results')

const schemaLoad = el<HTMLButtonElement>('schema-load')
const schemaCount = el('schema-count')
const schemaResults = el('schema-results')

let current: PageContext | null = null

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

function isServiceNow(url: string | undefined): boolean {
  return !!url && /^https:\/\/[^/]+\.service-now\.com\//.test(url)
}

/* ---------- context (M0) ---------- */

function row(term: string, value: string, opts: { mono?: boolean; html?: boolean } = {}) {
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
  row('Instance', ctx.host, { mono: true })
  row('Table', ctx.table ?? '—', { mono: true })
  row('sys_id', ctx.sysId ?? '—', { mono: true })
  row('View', `<span class="pill">${ctx.view}</span>`, { html: true })
  row('UI', `<span class="pill warn">${ctx.ui}</span>`, { html: true })
  row('Source', ctx.source)
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

function updateEnabledState() {
  const hasTable = !!current?.table
  condRun.disabled = !hasTable
  schemaLoad.disabled = !hasTable
  if (hasTable && current) {
    condHint.textContent = `Table: ${current.table}`
  } else {
    condHint.textContent = 'Detect a table first.'
  }
}

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
}

/* ---------- Condition Tester (M1) ---------- */

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
  renderRows(rowsRes.data)
}

function renderRows(rows: Record<string, unknown>[]) {
  condResults.replaceChildren()
  if (rows.length === 0) {
    condResults.append(elText('div', 'empty', 'No records match this query.'))
    return
  }
  for (const rec of rows) {
    const wrap = document.createElement('div')
    wrap.className = 'result-row'
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = pickLabel(rec)
    const sid = document.createElement('span')
    sid.className = 'sysid'
    sid.textContent = cellValue(rec['sys_id']).slice(0, 8) || '—'
    wrap.append(label, sid)
    condResults.append(wrap)
  }
}

/* ---------- Schema (M1) ---------- */

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
    const col = document.createElement('span')
    col.className = 'col'
    col.textContent = cellValue(f.element as unknown)
    const type = document.createElement('span')
    type.className = 'type'
    type.textContent = cellDisplay(f.internal_type as unknown)
    const lbl = document.createElement('span')
    lbl.className = 'lbl'
    lbl.textContent = cellDisplay(f.column_label as unknown)
    wrap.append(col, type, lbl)
    schemaResults.append(wrap)
  }
}

function elText(tag: string, cls: string, text: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = cls
  node.textContent = text
  return node
}

/* ---------- wiring ---------- */

refreshBtn.addEventListener('click', detect)
condRun.addEventListener('click', runCondition)
schemaLoad.addEventListener('click', loadSchema)

chrome.tabs.onActivated.addListener(detect)
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === 'complete' && tab.active) detect()
})

detect()
