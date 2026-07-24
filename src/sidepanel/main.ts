/**
 * Side panel entry.
 * M0: context detection.  M1: Condition Tester + schema loader.
 * M2: Script Tester Layer 1 — static lints (LLM-free), with auto-load of the
 *     script from the current Business Rule / Client Script / Script Include.
 */
import type { PageContext, RuntimeMessage } from '@core/types'
import { parseServiceNowContext } from '@core/context'
import { buildChoicesQuery, buildRecordXmlUrl, cellDisplay, cellValue } from '@core/api'
import type { ChoiceOption, DictionaryField } from '@core/api'
import {
  countRecords,
  createRecord,
  deleteRecord,
  getDictionary,
  getRecord,
  getText,
  queryRecords,
  runBackground,
  updateRecord,
} from '@core/api-client'
import { importableFields, parseUnloadXml } from '@core/xml'
import { classifyInstance } from '@core/prod-guard'
import { lintScript, type BrTiming, type LintFinding, type ScriptKind } from '@core/lint'
import { buildScriptBrowseQuery, normalizeTiming, scriptTableInfo } from '@core/script-meta'
import {
  loadLlmConfig,
  saveLlmConfig,
  type GenerateOutcome,
  type LlmConfig,
  type LlmFormat,
  type ReviewOutcome,
} from '@core/llm'
import { createCodeEditor } from './editor'
import type { ArtifactRef } from '@core/graph'
import { composeSpec, type SpecDocument } from '@core/spec'
import { renderSpecHtml } from '@core/render-html'
import { renderSpecDocxBlob } from '@core/render-docx'
import { loadRootArtifact, walkSpecGraph } from '@core/spec-runner'

let current: PageContext | null = null
let currentTabId: number | null = null
let hasTesterScript = false

/** Per-tab LLM job state (mirrors what the background writes to storage). */
type LlmJobEntry =
  | { status: 'running'; op: 'review' | 'generate' }
  | { status: 'done'; op: 'review' | 'generate'; outcome: unknown }
  | { status: 'error'; op: 'review' | 'generate'; error: string }

function jobKey(tabId: number, op: 'review' | 'generate'): string {
  return `llmJob:${tabId}:${op}`
}

function applyJob(op: 'review' | 'generate', entry: LlmJobEntry | undefined) {
  if (op === 'review') applyReviewJob(entry)
  else applyGenerateJob(entry)
}

/** Start an LLM job in the background so it survives the panel closing. */
async function startLlmJob(op: 'review' | 'generate', payload: unknown): Promise<boolean> {
  if (currentTabId == null) return false
  try {
    await chrome.storage.session.set({ [jobKey(currentTabId, op)]: { status: 'running', op } })
  } catch {
    /* ignore */
  }
  // Reply comes back directly (reliable) AND is mirrored to storage (survives close).
  chrome.runtime
    .sendMessage({ kind: 'snjava:llm-run', tabId: currentTabId, op, payload })
    .then((entry) => {
      if (entry) applyJob(op, entry as LlmJobEntry)
    })
    .catch(() => {})
  return true
}

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

/* ---------- XML mover (F3) ---------- */

const xmlRow = el('xml-row')
const xmlSave = el<HTMLButtonElement>('xml-save')
const xmlPaste = el<HTMLButtonElement>('xml-paste')
const xmlView = el<HTMLButtonElement>('xml-view')
const xmlOut = el('xml-out')

interface XmlClip {
  host: string
  table: string
  sysId: string
  xml: string
  savedAt: string
}

async function refreshXmlControls() {
  const has = !!(current?.table && current.sysId)
  xmlRow.hidden = !has
  xmlView.hidden = !(has && current?.view === 'form')
  const store = await chrome.storage.local.get('xmlClip')
  const clip = store['xmlClip'] as XmlClip | undefined
  xmlPaste.disabled = !clip
  xmlPaste.title = clip ? `Import saved ${clip.table} record from ${clip.host}` : 'Save a record XML first'
}

async function fetchRecordXml(): Promise<string | null> {
  if (!current?.table || !current.sysId) return null
  const res = await getText(current.host, buildRecordXmlUrl(current.host, current.table, current.sysId))
  if (!res.ok) {
    xmlOut.replaceChildren(elText('div', 'error', res.error))
    return null
  }
  return res.data
}

async function saveXml() {
  xmlSave.disabled = true
  xmlOut.replaceChildren(elText('div', 'empty', 'Exporting record XML…'))
  const xml = await fetchRecordXml()
  xmlSave.disabled = false
  if (!xml || !current) return
  const clip: XmlClip = {
    host: current.host,
    table: current.table!,
    sysId: current.sysId!,
    xml,
    savedAt: new Date().toISOString(),
  }
  await chrome.storage.local.set({ xmlClip: clip })
  await refreshXmlControls()
  xmlOut.replaceChildren(
    elText('div', 'ok-banner', `✓ Saved ${clip.table} XML (${(xml.length / 1024).toFixed(1)} KB). Use “Paste XML” on another instance to import.`),
  )
}

async function pasteXml() {
  const store = await chrome.storage.local.get('xmlClip')
  const clip = store['xmlClip'] as XmlClip | undefined
  if (!clip || !current) return
  const parsed = parseUnloadXml(clip.xml, clip.table)
  if (!parsed) {
    xmlOut.replaceChildren(elText('div', 'error', 'Could not parse the saved XML.'))
    return
  }
  const fields = importableFields(parsed.fields)
  if (
    !(await confirmDialog(
      `Import a "${clip.table}" record into ${current.host}?\n\n${Object.keys(fields).length} fields will be created as a NEW record (system fields dropped).`,
    ))
  ) {
    return
  }
  xmlPaste.disabled = true
  xmlOut.replaceChildren(elText('div', 'empty', 'Importing…'))
  const res = await createRecord(current.host, clip.table, fields)
  xmlPaste.disabled = false
  if (!res.ok) {
    xmlOut.replaceChildren(elText('div', 'error', res.error))
    return
  }
  const newId = cellValue(res.data['sys_id'])
  xmlOut.replaceChildren(elText('div', 'ok-banner', `✓ Imported as ${clip.table} ${newId.slice(0, 8)}…`))
}

let xmlEntries: [string, string][] = []

async function viewXmlValues() {
  xmlOut.replaceChildren(elText('div', 'empty', 'Loading XML values…'))
  const xml = await fetchRecordXml()
  if (!xml || !current?.table) return
  const parsed = parseUnloadXml(xml, current.table)
  if (!parsed) {
    xmlOut.replaceChildren(elText('div', 'error', 'Could not parse the record XML.'))
    return
  }
  xmlEntries = Object.entries(parsed.fields).filter(([, v]) => v !== '')

  xmlOut.replaceChildren()
  const search = document.createElement('input')
  search.className = 'query-input'
  search.style.marginBottom = '8px'
  search.placeholder = 'filter fields by name or value…'
  search.addEventListener('input', () => renderXmlValues(search.value))
  xmlOut.append(search)

  const list = document.createElement('div')
  list.id = 'xml-values-list'
  xmlOut.append(list)
  renderXmlValues('')
}

function renderXmlValues(filter: string) {
  const list = document.getElementById('xml-values-list')
  if (!list) return
  const f = filter.trim().toLowerCase()
  const rows = xmlEntries.filter(
    ([k, v]) => !f || k.toLowerCase().includes(f) || v.toLowerCase().includes(f),
  )
  list.replaceChildren()
  list.append(elText('div', 'chk-group-title', `${rows.length} field${rows.length === 1 ? '' : 's'}`))
  for (const [k, v] of rows) {
    // Same row style as Table schema for consistency.
    const row = document.createElement('div')
    row.className = 'schema-row2'
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'col'
    name.textContent = k
    name.title = `Click to copy the value of ${k}`
    name.addEventListener('click', () => void copyText(v, name))
    row.append(name, elText('span', 'lbl', v.length > 160 ? v.slice(0, 160) + '…' : v))
    list.append(row)
  }
}

/* ---------- Condition Tester + schema (M1) ---------- */

const condHint = el('cond-table-hint')
const condQuery = el<HTMLTextAreaElement>('cond-query')
const condRun = el<HTMLButtonElement>('cond-run')
const condOpen = el<HTMLButtonElement>('cond-open')
const condCount = el('cond-count')
const condResults = el('cond-results')
const schemaLoad = el<HTMLButtonElement>('schema-load')
const schemaCount = el('schema-count')
const schemaSearch = el<HTMLInputElement>('schema-search')
const schemaResults = el('schema-results')
const schemaNav = el('schema-nav')
const schemaBack = el<HTMLButtonElement>('schema-back')
const schemaPath = el('schema-path')

function updateEnabledState() {
  const hasTable = !!current?.table
  condRun.disabled = !hasTable
  condOpen.disabled = !hasTable
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
  condResults.replaceChildren(elText('div', 'empty', 'Counting…'))

  const countRes = await countRecords(host, table, query || undefined)
  condRun.disabled = false

  if (!countRes.ok) {
    condResults.replaceChildren(elText('div', 'error', countRes.error))
    return
  }
  const n = countRes.data.count
  condCount.hidden = false
  condCount.textContent = `${n} match${n === 1 ? '' : 'es'}`
  condResults.replaceChildren(
    elText('div', 'empty', `${n} record${n === 1 ? '' : 's'} match this condition. Use “Open list ↗” to view them in ServiceNow.`),
  )
  condOpen.disabled = false
}

/** Open the filtered list in ServiceNow (classic list view honors sysparm_query). */
function openConditionList() {
  if (!current?.table) return
  const query = condQuery.value.trim()
  const url =
    `https://${current.host}/${current.table}_list.do` +
    (query ? `?sysparm_query=${encodeURIComponent(query)}` : '')
  void chrome.tabs.create({ url })
}

/* --- Table schema (search + reference + choices + copy) --- */

let schemaFields: DictionaryField[] = []
let schemaTable = ''
/** Dot-walk prefix built from reference hops, e.g. "assigned_to.manager." */
let schemaPrefix = ''
/** Navigation history for the "Back" button (reference drill-down). */
const schemaStack: { table: string; prefix: string; fields: DictionaryField[] }[] = []
const choicesCache = new Map<string, ChoiceOption[]>()

async function fetchDictionaryInto(table: string, host: string): Promise<boolean> {
  schemaLoad.disabled = true
  schemaCount.hidden = true
  schemaSearch.hidden = true
  schemaResults.replaceChildren(elText('div', 'empty', `Loading ${table} fields…`))
  const res = await getDictionary(host, table)
  schemaLoad.disabled = false
  if (!res.ok) {
    schemaResults.replaceChildren(elText('div', 'error', res.error))
    return false
  }
  schemaTable = table
  schemaFields = res.data
  schemaCount.hidden = false
  schemaCount.textContent = `${schemaFields.length} fields${schemaPrefix ? ` · ${table}` : ''}`
  schemaSearch.hidden = schemaFields.length === 0
  schemaSearch.value = ''
  updateSchemaNav()
  renderSchema('')
  return true
}

function updateSchemaNav() {
  const nested = schemaStack.length > 0
  schemaNav.hidden = !nested
  schemaPath.textContent = nested ? `${schemaPrefix}…` : ''
}

/** Load the current record's table schema (resets any reference drill-down). */
async function loadSchema() {
  if (!current?.table) return
  schemaStack.length = 0
  schemaPrefix = ''
  await fetchDictionaryInto(current.table, current.host)
}

/** Drill into a referenced table; the reference field becomes a dot-walk hop. */
async function loadSchemaForTable(refTable: string, refElement: string) {
  if (!current) return
  schemaStack.push({ table: schemaTable, prefix: schemaPrefix, fields: schemaFields })
  schemaPrefix = `${schemaPrefix}${refElement}.`
  await fetchDictionaryInto(refTable, current.host)
}

function schemaBackOne() {
  const prev = schemaStack.pop()
  if (!prev) return
  schemaTable = prev.table
  schemaPrefix = prev.prefix
  schemaFields = prev.fields
  schemaCount.hidden = false
  schemaCount.textContent = `${schemaFields.length} fields${schemaPrefix ? ` · ${schemaTable}` : ''}`
  schemaSearch.hidden = schemaFields.length === 0
  updateSchemaNav()
  renderSchema('')
}

function renderSchema(filter: string) {
  const f = filter.trim().toLowerCase()
  const rows = schemaFields.filter((d) => {
    if (!f) return true
    return (
      cellValue(d.element as unknown).toLowerCase().includes(f) ||
      cellDisplay(d.column_label as unknown).toLowerCase().includes(f)
    )
  })
  schemaResults.replaceChildren()
  if (rows.length === 0) {
    schemaResults.append(elText('div', 'empty', 'No matching fields.'))
    return
  }
  for (const d of rows) schemaResults.append(buildSchemaRow(d))
}

/** True when the field carries a choice list (by choice mode or type). */
function isChoiceField(d: DictionaryField): boolean {
  const mode = cellValue(d.choice as unknown)
  const type = cellValue(d.internal_type as unknown).toLowerCase()
  return (!!mode && mode !== '0') || type === 'choice' || type === 'multi_two_lines'
}

function buildSchemaRow(d: DictionaryField): HTMLElement {
  const element = cellValue(d.element as unknown)
  const type = cellDisplay(d.internal_type as unknown) || cellValue(d.internal_type as unknown)
  const label = cellDisplay(d.column_label as unknown)
  const refTable = cellValue(d.reference as unknown)

  const row = document.createElement('div')
  row.className = 'schema-row2'

  // element name — click to copy the full dot-walk path
  const dotPath = schemaPrefix + element
  const name = document.createElement('button')
  name.type = 'button'
  name.className = 'col'
  name.textContent = element
  name.title = `Click to copy "${dotPath}"`
  name.addEventListener('click', () => {
    void copyText(dotPath, name)
  })
  row.append(name)

  row.append(elText('span', 'type', type))

  // reference → target table (click to drill in; the field becomes a dot-walk hop)
  if (refTable) {
    const ref = document.createElement('span')
    ref.className = 'ref'
    ref.textContent = `→ ${refTable}`
    ref.title = `References ${refTable} — click to dot-walk into it`
    ref.addEventListener('click', () => loadSchemaForTable(refTable, element))
    row.append(ref)
  }

  // choices — hover (or click) to load + preview
  if (isChoiceField(d)) {
    const ch = document.createElement('span')
    ch.className = 'choices'
    ch.textContent = 'choices ▾'
    let pop: HTMLElement | null = null
    const open = () => void showChoices(ch, element, (p) => (pop = p))
    const close = () => {
      pop?.remove()
      pop = null
    }
    ch.addEventListener('mouseenter', open)
    ch.addEventListener('mouseleave', close)
    ch.addEventListener('click', open)
    row.append(ch)
  }

  if (label) row.append(elText('span', 'lbl', label))
  return row
}

/**
 * Fetch choices for a field. Choices are often stored under a PARENT table
 * (e.g. incident.state lives under "task"), so if the table-scoped query is
 * empty, fall back to matching the element alone (deduped by value).
 */
async function fetchChoices(host: string, table: string, element: string): Promise<ChoiceOption[]> {
  const scoped = await queryRecords(host, 'sys_choice', {
    query: buildChoicesQuery(table, element),
    fields: ['label', 'value', 'sequence'],
    limit: 200,
    displayValue: false,
  })
  let rows = scoped.ok ? scoped.data : []
  if (rows.length === 0) {
    const anyTable = await queryRecords(host, 'sys_choice', {
      query: `element=${element}^inactive=false^ORDERBYsequence^ORDERBYlabel`,
      fields: ['label', 'value', 'sequence'],
      limit: 200,
      displayValue: false,
    })
    rows = anyTable.ok ? anyTable.data : []
  }
  const seen = new Set<string>()
  const out: ChoiceOption[] = []
  for (const r of rows) {
    const value = cellValue(r['value'])
    if (seen.has(value)) continue
    seen.add(value)
    out.push({ label: cellValue(r['label']), value })
  }
  return out
}

async function showChoices(anchor: HTMLElement, element: string, setPop: (p: HTMLElement) => void) {
  if (!current) return
  const key = `${schemaTable}.${element}`
  let choices = choicesCache.get(key)
  if (!choices) {
    choices = await fetchChoices(current.host, schemaTable, element)
    choicesCache.set(key, choices)
  }
  // Append to <body>, fixed-positioned, so the scroll container can't clip it.
  const pop = document.createElement('div')
  pop.className = 'choice-pop floating'
  const rect = anchor.getBoundingClientRect()
  pop.style.top = `${rect.bottom + 4}px`
  pop.style.left = `${Math.max(8, rect.left - 40)}px`
  if (choices.length === 0) {
    pop.append(elText('div', 'ch', 'No choices found for this field.'))
  } else {
    for (const c of choices) {
      const line = document.createElement('div')
      line.className = 'ch'
      line.append(elText('span', 'l', c.label || '(blank)'), elText('span', 'v', c.value))
      pop.append(line)
    }
  }
  document.body.appendChild(pop)
  setPop(pop)
}

async function copyText(text: string, feedbackEl?: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text)
    showToast(`Copied "${text}"`)
    if (feedbackEl) {
      feedbackEl.classList.add('copied')
      setTimeout(() => feedbackEl.classList.remove('copied'), 800)
    }
  } catch {
    showToast('Copy failed')
  }
}

/** In-panel confirm dialog — window.confirm() is suppressed in side panels. */
function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    const box = document.createElement('div')
    box.className = 'modal-box'
    box.append(elText('div', 'modal-msg', message))
    const row = document.createElement('div')
    row.className = 'btn-row'
    const cancel = document.createElement('button')
    cancel.className = 'btn btn-ghost'
    cancel.textContent = 'Cancel'
    const ok = document.createElement('button')
    ok.className = 'btn'
    ok.textContent = 'Confirm'
    const done = (v: boolean) => {
      overlay.remove()
      resolve(v)
    }
    cancel.addEventListener('click', () => done(false))
    ok.addEventListener('click', () => done(true))
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(false)
    })
    row.append(cancel, ok)
    box.append(row)
    overlay.append(box)
    document.body.append(overlay)
    ok.focus()
  })
}

let toastEl: HTMLElement | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined
function showToast(text: string) {
  if (!toastEl) {
    toastEl = document.createElement('div')
    toastEl.className = 'copy-toast'
    document.body.appendChild(toastEl)
  }
  toastEl.textContent = text
  toastEl.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl?.classList.remove('show'), 1400)
}

/* ---------- Script Tester Layer 1 (M2) ---------- */

const testerSource = el('tester-source')
const scriptKind = el<HTMLSelectElement>('script-kind')
const timingWrap = el('timing-wrap')
const scriptTiming = el<HTMLSelectElement>('script-timing')
const scriptEd = createCodeEditor(el('script-editor'))
const scriptFormat = el<HTMLButtonElement>('script-format')
const scriptCopy = el<HTMLButtonElement>('script-copy')
const analyzeBtn = el<HTMLButtonElement>('analyze-btn')
const reviewSpinner = el('review-spinner')
const aiStatus = el('ai-status')
const lintSummary = el('lint-summary')
const lintResults = el('lint-results')
const simCard = el('sim-card')

// AI review outputs
const optimizeSection = el('optimize-section')
const optimizeEd = createCodeEditor(el('optimize-editor'))
const optimizeFormat = el<HTMLButtonElement>('optimize-format')
const optimizeCopy = el<HTMLButtonElement>('optimize-copy')
const optimizeUse = el<HTMLButtonElement>('optimize-use')
const optimizeSave = el<HTMLButtonElement>('optimize-save')

/** The script record currently loaded into the tester (for "Save to record"). */
let loadedScriptRecord: { host: string; table: string; sysId: string; scriptField: string } | null = null
const testerEd = createCodeEditor(el('tester-editor'))
const testerFormat = el<HTMLButtonElement>('tester-format')
const testerCopy = el<HTMLButtonElement>('tester-copy')

// AI settings (Settings tab)
const aiEndpoint = el<HTMLInputElement>('ai-endpoint')
const aiKey = el<HTMLInputElement>('ai-key')
const aiModel = el<HTMLInputElement>('ai-model')
const aiFormat = el<HTMLSelectElement>('ai-format')
const aiSave = el<HTMLButtonElement>('ai-save')
const aiSaved = el('ai-saved')

const SERVER_KINDS = new Set(['business_rule', 'script_include', 'unknown'])

/** Switch to a named tab programmatically. */
function activateTab(tabId: string) {
  document.getElementById(tabId)?.dispatchEvent(new MouseEvent('click'))
}

/** Toggle the BR timing selector; sandbox visibility is handled separately. */
function syncTimingVisibility() {
  timingWrap.style.display = scriptKind.value === 'business_rule' ? '' : 'none'
  updateSandboxVisibility()
}

/** Sandbox appears only once a tester script exists AND the kind is server-side. */
function updateSandboxVisibility() {
  simCard.hidden = !(hasTesterScript && SERVER_KINDS.has(scriptKind.value))
}

/** Fetch a script record (any script table) and populate the Layer 1 editor. */
async function loadScriptIntoTester(host: string, scriptTable: string, sysId: string) {
  const info = scriptTableInfo(scriptTable)
  if (!info) return
  testerSource.textContent = 'Loading script…'

  const fields = [info.scriptField, info.nameField]
  if (info.timingField) fields.push(info.timingField)
  if (info.tableField) fields.push(info.tableField)

  const res = await getRecord(host, scriptTable, sysId, fields)
  if (!res.ok) {
    testerSource.textContent = `Could not load: ${res.error}`
    return
  }
  const rec = res.data
  loadedScriptRecord = { host, table: scriptTable, sysId, scriptField: info.scriptField }
  scriptEd.setValue(cellValue(rec[info.scriptField]))
  scriptKind.value = info.kind
  if (info.timingField) scriptTiming.value = normalizeTiming(cellValue(rec[info.timingField]))
  // Layer 3: point the target table at what this script runs against.
  if (info.tableField) {
    const target = cellValue(rec[info.tableField])
    if (target) l3Table.value = target
  }
  syncTimingVisibility()
  const name = cellDisplay(rec[info.nameField]) || scriptTable
  testerSource.textContent = `Loaded "${name}" (${info.kind.replace('_', ' ')}).`
  scriptEd.view.scrollDOM.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

/** If the current record is itself a script record, pull it into the tester. */
async function maybeAutoLoadScript() {
  if (!current?.table || !current.sysId) return
  if (!scriptTableInfo(current.table)) return
  await loadScriptIntoTester(current.host, current.table, current.sysId)
}

/* ---------- Script picker (browse scripts on a table) ---------- */

const pickerType = el<HTMLSelectElement>('picker-type')
const pickerTableWrap = el('picker-table-wrap')
const pickerTable = el<HTMLInputElement>('picker-table')
const pickerSearch = el<HTMLInputElement>('picker-search')
const pickerFind = el<HTMLButtonElement>('picker-find')
const pickerResults = el('picker-results')

const PICKER_META: Record<string, { detail: (r: Record<string, unknown>) => string }> = {
  sys_script: { detail: (r) => `${cellValue(r['when']) || 'when?'} · ${cellValue(r['active']) === 'true' ? 'active' : 'inactive'}` },
  sys_script_client: { detail: (r) => `${cellValue(r['type']) || 'type?'} · ${cellValue(r['active']) === 'true' ? 'active' : 'inactive'}` },
  sys_script_include: { detail: (r) => cellValue(r['api_name']) },
}

function syncPickerTableVisibility() {
  // Script Includes are global (no table scope).
  pickerTableWrap.style.display = pickerType.value === 'sys_script_include' ? 'none' : ''
}

async function findScripts() {
  if (!current) return
  const scriptTable = pickerType.value
  const tableFilter = pickerTable.value.trim() || undefined
  const nameSearch = pickerSearch.value.trim() || undefined

  pickerFind.disabled = true
  pickerResults.replaceChildren(elText('div', 'empty', 'Searching…'))

  const query = buildScriptBrowseQuery(scriptTable, tableFilter, nameSearch)
  const fields = ['sys_id', 'name', 'active', 'when', 'type', 'api_name']
  const res = await queryRecords(current.host, scriptTable, { query, fields, limit: 50, displayValue: false })
  pickerFind.disabled = false

  if (!res.ok) {
    pickerResults.replaceChildren(elText('div', 'error', res.error))
    return
  }
  pickerResults.replaceChildren()
  if (res.data.length === 0) {
    pickerResults.append(elText('div', 'empty', 'No scripts found for this filter.'))
    return
  }
  const detailFn = PICKER_META[scriptTable]?.detail ?? (() => '')
  for (const rec of res.data) {
    const sysId = cellValue(rec['sys_id'])
    const rowEl = document.createElement('button')
    rowEl.type = 'button'
    rowEl.className = 'result-row picker-row'
    rowEl.append(
      elText('span', 'label', cellValue(rec['name']) || sysId.slice(0, 8)),
      elText('span', 'sysid', detailFn(rec)),
    )
    rowEl.addEventListener('click', () => {
      void loadScriptIntoTester(current!.host, scriptTable, sysId)
    })
    pickerResults.append(rowEl)
  }
}

/** Local static lints (instant, no AI). Returns true if a script was present. */
function runLints(): boolean {
  const script = scriptEd.getValue()
  const kind = scriptKind.value as ScriptKind
  const timing = scriptTiming.value as BrTiming
  const findings = lintScript({ script, kind, timing })

  lintResults.replaceChildren()
  lintSummary.hidden = false

  if (!script.trim()) {
    lintSummary.hidden = true
    lintResults.append(elText('div', 'empty', 'Paste or load a script, then run Java review.'))
    return false
  }

  const counts = { error: 0, warning: 0, info: 0 }
  findings.forEach((f) => (counts[f.severity] += 1))
  lintSummary.textContent = `${counts.error} error · ${counts.warning} warning · ${counts.info} info`

  if (findings.length === 0) {
    lintResults.append(elText('div', 'ok-banner', '✓ No anti-patterns found by Layer 1 lints.'))
  } else {
    for (const f of findings) renderFinding(f)
  }
  return true
}

/** "Java review": run local lints, then kick off the AI job in the background. */
async function javaReview() {
  const hasScript = runLints()
  if (!hasScript) return

  const started = await startLlmJob('review', {
    script: scriptEd.getValue(),
    kind: scriptKind.value as ScriptKind,
    timing: scriptTiming.value as BrTiming,
    table: current?.table || 'incident',
    intent: (el<HTMLTextAreaElement>('script-intent').value || '').trim() || undefined,
  })
  if (!started) {
    aiStatus.textContent = 'Open a ServiceNow tab first.'
    return
  }
  applyReviewJob({ status: 'running', op: 'review' })
}

/** Render the review UI from a job entry (running / done / error). */
function applyReviewJob(entry: LlmJobEntry | undefined) {
  if (!entry) return
  if (entry.status === 'running') {
    optimizeSection.hidden = true
    reviewSpinner.hidden = false
    analyzeBtn.disabled = true
    aiStatus.textContent = 'Asking the AI for an optimized script and a sandbox tester… (keeps running if you close this panel)'
    return
  }
  reviewSpinner.hidden = true
  analyzeBtn.disabled = false

  if (entry.status === 'error') {
    aiStatus.textContent = `AI error: ${entry.error}`
    return
  }
  const outcome = entry.outcome as ReviewOutcome
  if (!outcome.configured) {
    aiStatus.textContent = 'AI not configured — open Settings and add an endpoint + key.'
    activateTab('tab-settings')
    return
  }
  if (!outcome.ok) {
    aiStatus.textContent = `AI error: ${outcome.error}`
    return
  }
  const { optimizedScript, testScript, notes } = outcome.result
  aiStatus.textContent = notes.length ? `AI review: ${notes.length} note(s).` : 'AI review complete.'
  for (const n of notes) lintResults.append(elText('div', 'review-note', n))
  if (optimizedScript) {
    optimizeEd.setValue(optimizedScript)
    optimizeSection.hidden = false
  }
  if (testScript) {
    testerEd.setValue(testScript)
    hasTesterScript = true
    updateSandboxVisibility() // sandbox appears now that a tester script exists
    updateSandboxGuard()
    simCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
}

/** Write the optimized script back over the source record (prod-guarded). */
async function saveOptimizedToRecord() {
  if (!loadedScriptRecord) {
    showToast('Load a script from a record first (picker or open the record)')
    return
  }
  const { host, table, sysId, scriptField } = loadedScriptRecord
  const code = optimizeEd.getValue()
  if (!code.trim()) return
  if (!(await confirmDialog(`Overwrite the ${table} record's script with the optimized version on ${host}?`))) return

  optimizeSave.disabled = true
  const res = await updateRecord(host, table, sysId, { [scriptField]: code })
  optimizeSave.disabled = false
  if (!res.ok) {
    showToast(`Save failed: ${res.error.slice(0, 60)}`)
    return
  }
  scriptEd.setValue(code)
  showToast('Saved optimized script to the record ✓')
}

async function formatEditor(ed: { getValue: () => string; setValue: (v: string) => void }, btn: HTMLButtonElement) {
  if (!ed.getValue().trim()) return
  const prev = btn.textContent
  btn.disabled = true
  btn.textContent = '…'
  try {
    const { formatJs } = await import('@core/format')
    ed.setValue(await formatJs(ed.getValue()))
    showToast('Formatted')
  } catch (err) {
    showToast(`Format failed: ${(err as Error).message.slice(0, 60)}`)
  } finally {
    btn.disabled = false
    btn.textContent = prev
  }
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

/* ---------- Sandbox — run tester script on the instance (background) ---------- */

const simGuard = el('sim-guard')
const simRun = el<HTMLButtonElement>('sim-run')
const simSpinner = el('sim-spinner')
const simResults = el('sim-results')

/** Parse "field=value" lines into a map (used by Layer 3). */
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

/** Reflect the prod-guard verdict in the sandbox card + gate the Run button. */
function updateSandboxGuard() {
  if (!current) {
    simGuard.className = 'guard-badge'
    simGuard.textContent = 'Checking instance…'
    simRun.disabled = true
    return
  }
  const verdict = classifyInstance(current.host)
  simGuard.className = `guard-badge ${verdict.allowed ? 'ok' : 'blocked'}`
  simGuard.textContent = verdict.allowed
    ? `✓ ${verdict.instance} — sub-prod. Background run permitted.`
    : `⛔ ${verdict.reason}`
  simRun.disabled = !verdict.allowed
}

/** Open the Background Scripts page and pre-fill it with the given script. */
async function openBackgroundScripts(host: string, script: string) {
  const tab = await chrome.tabs.create({ url: `https://${host}/sys.scripts.do` })
  const tabId = tab.id
  if (tabId == null) return
  void copyText(script) // clipboard fallback in case the field can't be filled
  const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
    if (id !== tabId || info.status !== 'complete') return
    chrome.tabs.onUpdated.removeListener(onUpdated)
    chrome.scripting
      .executeScript({
        target: { tabId, allFrames: true },
        func: (code: string) => {
          const ta = document.querySelector(
            'textarea#script, textarea[name="script"], textarea[name="script.script"]',
          ) as HTMLTextAreaElement | null
          if (ta) {
            ta.value = code
            ta.dispatchEvent(new Event('input', { bubbles: true }))
            ta.dispatchEvent(new Event('change', { bubbles: true }))
          }
        },
        args: [script],
      })
      .catch(() => {})
  }
  chrome.tabs.onUpdated.addListener(onUpdated)
}

/** Best-effort extraction of the script output from sys.scripts.do HTML. */
function extractBgOutput(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pres = Array.from(doc.querySelectorAll('pre')).map((p) => p.textContent ?? '').filter(Boolean)
  if (pres.length) return pres.join('\n\n').trim()
  // Fallback: visible body text, trimmed.
  const text = (doc.body?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
  return text.slice(0, 4000)
}

async function runOnInstance() {
  if (!current) return
  const script = testerEd.getValue()
  if (!script.trim()) {
    simResults.replaceChildren(elText('div', 'empty', 'No tester script to run.'))
    return
  }
  if (!(await confirmDialog(`Run this tester script as a REAL background script on ${current.host}?`))) {
    return
  }
  simRun.disabled = true
  simSpinner.hidden = false
  simResults.replaceChildren(elText('div', 'empty', 'Running on the instance…'))

  const res = await runBackground(current.host, script)
  simSpinner.hidden = true
  simRun.disabled = false

  if (!res.ok) {
    simResults.replaceChildren(elText('div', 'error', res.error))
    return
  }
  const output = extractBgOutput(res.data)
  simResults.replaceChildren()
  simResults.append(elText('div', 'chk-group-title', 'Background script output'))
  const pre = document.createElement('pre')
  pre.className = 'code-block'
  pre.textContent = output || '(no textual output captured)'
  simResults.append(pre)
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
    !(await confirmDialog(
      `Create a REAL record in "${table}" on ${current.host}?\n\nThis runs the actual Business Rules on the instance.`,
    ))
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
  if (!(await confirmDialog(`Delete test record ${l3Created.sysId.slice(0, 8)}… from ${l3Created.table}?`))) return

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

/* ---------- AI settings ---------- */

async function loadAiSettings() {
  const cfg = await loadLlmConfig()
  if (!cfg) return
  aiEndpoint.value = cfg.endpoint
  aiKey.value = cfg.apiKey
  aiModel.value = cfg.model
  aiFormat.value = cfg.format
}

async function saveAiSettings() {
  const cfg: LlmConfig = {
    endpoint: aiEndpoint.value.trim(),
    apiKey: aiKey.value.trim(),
    model: aiModel.value.trim() || 'claude-opus-4-8',
    format: aiFormat.value as LlmFormat,
  }
  await saveLlmConfig(cfg)
  aiSaved.hidden = false
  setTimeout(() => (aiSaved.hidden = true), 1500)
  aiStatus.textContent = 'AI settings saved. Run “Java review” to use them.'
}

/* ---------- Generate Background Script ---------- */

let genEd: ReturnType<typeof createCodeEditor> | null = null
const genRun = el<HTMLButtonElement>('gen-run')
const genSpinner = el('gen-spinner')
const genStatus = el('gen-status')
const genSection = el('gen-section')
const genNotes = el('gen-notes')
const genRequirement = el<HTMLTextAreaElement>('gen-requirement')

function initGenerate() {
  genEd = createCodeEditor(el('gen-editor'))

  genRun.addEventListener('click', async () => {
    const requirement = genRequirement.value.trim()
    if (!requirement) {
      genStatus.textContent = 'Describe what the script should do first.'
      return
    }
    const started = await startLlmJob('generate', { requirement, table: current?.table ?? undefined })
    if (!started) {
      genStatus.textContent = 'Open a ServiceNow tab first.'
      return
    }
    applyGenerateJob({ status: 'running', op: 'generate' })
  })

  el<HTMLButtonElement>('gen-format').addEventListener('click', () =>
    formatEditor(genEd!, el<HTMLButtonElement>('gen-format')),
  )
  el<HTMLButtonElement>('gen-copy').addEventListener('click', () => copyText(genEd!.getValue()))
  el<HTMLButtonElement>('gen-open').addEventListener('click', () => {
    const host = current?.host
    if (!host) {
      showToast('Open a ServiceNow tab first')
      return
    }
    void openBackgroundScripts(host, genEd!.getValue())
  })
}

/** Render the Generate UI from a job entry (running / done / error). */
function applyGenerateJob(entry: LlmJobEntry | undefined) {
  if (!entry || !genEd) return
  if (entry.status === 'running') {
    genSpinner.hidden = false
    genRun.disabled = true
    genStatus.textContent = 'Generating background script… (keeps running if you close this panel)'
    return
  }
  genSpinner.hidden = true
  genRun.disabled = false
  if (entry.status === 'error') {
    genStatus.textContent = `AI error: ${entry.error}`
    return
  }
  const outcome = entry.outcome as GenerateOutcome
  if (!outcome.configured) {
    genStatus.textContent = 'AI not configured — open Settings and add an endpoint + key.'
    activateTab('tab-settings')
    return
  }
  if (!outcome.ok) {
    genStatus.textContent = `AI error: ${outcome.error}`
    return
  }
  genStatus.textContent = 'Generated. Review it, then open Background Scripts to run.'
  genEd.setValue(outcome.result.script)
  genNotes.replaceChildren()
  for (const n of outcome.result.notes) genNotes.append(elText('div', 'review-note', n))
  genSection.hidden = false
}

/** Load per-tab job state for the current tab and render it (on switch/reopen). */
async function restoreLlmJobs() {
  if (currentTabId == null) return
  const store = await chrome.storage.session.get([
    jobKey(currentTabId, 'review'),
    jobKey(currentTabId, 'generate'),
  ])
  applyReviewJob(store[jobKey(currentTabId, 'review')] as LlmJobEntry | undefined)
  applyGenerateJob(store[jobKey(currentTabId, 'generate')] as LlmJobEntry | undefined)
}

// Background writes job results to storage — reflect changes for the active tab.
chrome.storage.session.onChanged.addListener((changes) => {
  if (currentTabId == null) return
  const rk = jobKey(currentTabId, 'review')
  const gk = jobKey(currentTabId, 'generate')
  if (changes[rk]) applyReviewJob(changes[rk].newValue as LlmJobEntry | undefined)
  if (changes[gk]) applyGenerateJob(changes[gk].newValue as LlmJobEntry | undefined)
})

/* ---------- detect + wiring ---------- */

async function detect() {
  renderStatus('Detecting…')
  current = null
  updateEnabledState()

  const tab = await getActiveTab()
  currentTabId = tab?.id ?? null
  if (!tab?.id || !isServiceNow(tab.url)) {
    renderStatus('Open a ServiceNow page to detect context.')
    return
  }
  void restoreLlmJobs()

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
  updateSandboxGuard()

  // Default the Layer 3 target table to the current data table.
  if (current?.table && !scriptTableInfo(current.table) && !l3Table.value.trim()) {
    l3Table.value = current.table
  }
  // Prefill the picker's table filter with the current data table.
  if (current?.table && !scriptTableInfo(current.table) && !pickerTable.value.trim()) {
    pickerTable.value = current.table
  }
  updateProdGuard()
  void refreshXmlControls()
  void maybeAutoLoadScript()
}

initTabs()
syncTimingVisibility()

refreshBtn.addEventListener('click', detect)
condRun.addEventListener('click', runCondition)
condOpen.addEventListener('click', openConditionList)
schemaLoad.addEventListener('click', loadSchema)
schemaSearch.addEventListener('input', () => renderSchema(schemaSearch.value))
schemaBack.addEventListener('click', schemaBackOne)
scriptKind.addEventListener('change', syncTimingVisibility)
analyzeBtn.addEventListener('click', javaReview)
scriptFormat.addEventListener('click', () => formatEditor(scriptEd, scriptFormat))
scriptCopy.addEventListener('click', () => copyText(scriptEd.getValue()))
optimizeFormat.addEventListener('click', () => formatEditor(optimizeEd, optimizeFormat))
optimizeCopy.addEventListener('click', () => copyText(optimizeEd.getValue()))
optimizeUse.addEventListener('click', () => {
  scriptEd.setValue(optimizeEd.getValue())
  showToast('Optimized script moved into the editor')
})
optimizeSave.addEventListener('click', saveOptimizedToRecord)
xmlSave.addEventListener('click', saveXml)
xmlPaste.addEventListener('click', pasteXml)
xmlView.addEventListener('click', viewXmlValues)
testerFormat.addEventListener('click', () => formatEditor(testerEd, testerFormat))
testerCopy.addEventListener('click', () => copyText(testerEd.getValue()))
aiSave.addEventListener('click', saveAiSettings)
el<HTMLButtonElement>('ai-preset-agenthub').addEventListener('click', () => {
  aiFormat.value = 'agenthub'
  aiEndpoint.value = 'https://dev-agenthub.mfec.co.th/api/browser-ingest'
  if (!aiModel.value.trim()) aiModel.value = 'claude-opus-4-8'
  showToast('AgentHub preset filled — paste your token and Save')
})
void loadAiSettings()
initGenerate()
pickerType.addEventListener('change', syncPickerTableVisibility)
pickerFind.addEventListener('click', findScripts)
pickerSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') findScripts()
})
syncPickerTableVisibility()
simRun.addEventListener('click', runOnInstance)
el<HTMLButtonElement>('sim-bg').addEventListener('click', () => {
  if (!current?.host) {
    showToast('Open a ServiceNow tab first')
    return
  }
  void openBackgroundScripts(current.host, testerEd.getValue())
})
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
