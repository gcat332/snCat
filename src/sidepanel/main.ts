/**
 * Side panel entry.
 * M0: context detection.  M1: Condition Tester + schema loader.
 * M2: Script Tester Layer 1 — static lints (LLM-free), with auto-load of the
 *     script from the current Business Rule / Client Script / Script Include.
 */
import type { PageContext, RuntimeMessage } from '@core/types'
import { parseServiceNowContext } from '@core/context'
import { buildChoicesQuery, buildListXmlUrl, buildRecordXmlUrl, cellDisplay, cellValue } from '@core/api'
import type { ChoiceOption, DictionaryField } from '@core/api'
import {
  countRecords,
  getDictionary,
  getRecord,
  getText,
  queryRecords,
  runBackground,
} from '@core/api-client'
import { importableFields, parseUnloadXml, parseUnloadXmlAll } from '@core/xml'
import {
  buildUndoLog,
  buildUndoScript,
  partitionPreview,
  buildImportScript,
  type ImportRowResult,
  type UndoLog,
} from '@core/f3-import'
import { diffStats, lineDiff } from '@core/diff'
import { classifyInstance } from '@core/prod-guard'
import { lintScript, type BrTiming, type LintFinding, type ScriptKind } from '@core/lint'
import { buildScriptBrowseQuery, normalizeTiming, scriptTableInfo } from '@core/script-meta'
import {
  loadLlmConfig,
  saveLlmConfig,
  type LlmConfig,
  type LlmFormat,
  type NarrativeInput,
  type NarrativeOutcome,
  type PlanArtifact,
  type PlanOutcome,
  type ReviewOutcome,
} from '@core/llm'
import { createCodeEditor } from './editor'
import type { ArtifactRef } from '@core/graph'
import { composeSpec, type SpecDocument } from '@core/spec'
import { renderSpecHtml } from '@core/render-html'
import { formatSpecDoc } from '@core/format'
import { renderSpecDocxBlob } from '@core/render-docx'
import { loadRootArtifact, tableRootArtifact, walkSpecGraph } from '@core/spec-runner'
import { isAuthError, authExpiredMessage } from '@core/auth-msg'

let current: PageContext | null = null
let currentTabId: number | null = null

/** Per-tab LLM job state (mirrors what the background writes to storage). */
type LlmJobEntry =
  | { status: 'running'; op: 'review' | 'generate' | 'narrative'; startedAt?: number }
  | { status: 'done'; op: 'review' | 'generate' | 'narrative'; outcome: unknown }
  | { status: 'error'; op: 'review' | 'generate' | 'narrative'; error: string }

/**
 * A 'running' job is stale once its startedAt is older than this. The background
 * runs the fetch in the service worker; if that worker is killed mid-fetch the
 * final done/error write never lands and the entry stays 'running' forever, so
 * we infer failure from elapsed wall-clock time. This MUST exceed the longest
 * expected LLM call — there is no fetch AbortController/timeout yet (separate
 * finding), so wall-clock is our only signal. A running entry with no startedAt
 * is an old-format job (written before this field existed) and is always stale.
 */
const STALE_JOB_MS = 3 * 60_000

/** True when a 'running' entry is from a worker that was interrupted mid-fetch. */
function isStaleJob(entry: LlmJobEntry): boolean {
  if (entry.status !== 'running') return false
  if (entry.startedAt == null) return true
  return Date.now() - entry.startedAt > STALE_JOB_MS
}

function jobKey(tabId: number, op: 'review' | 'generate' | 'narrative'): string {
  return `llmJob:${tabId}:${op}`
}

function applyJob(op: 'review' | 'generate' | 'narrative', entry: LlmJobEntry | undefined) {
  if (op === 'review') applyReviewJob(entry)
  else if (op === 'generate') applyGenerateJob(entry)
  else applyNarrativeJob(entry)
}

/** Start an LLM job in the background so it survives the panel closing. */
async function startLlmJob(op: 'review' | 'generate' | 'narrative', payload: unknown): Promise<boolean> {
  if (currentTabId == null) return false
  const tabId = currentTabId
  try {
    await chrome.storage.session.set({
      [jobKey(tabId, op)]: { status: 'running', op, startedAt: Date.now() },
    })
  } catch {
    /* ignore */
  }
  // Reply comes back directly (reliable) AND is mirrored to storage (survives close).
  chrome.runtime
    .sendMessage({ kind: 'snjava:llm-run', tabId, op, payload })
    .then((entry) => {
      if (entry) applyJob(op, entry as LlmJobEntry)
    })
    .catch((e) => {
      // Messaging failed AFTER we set 'running' — persist an error entry so the UI
      // renders the failure (instead of spinning forever) and stored state agrees.
      const error: LlmJobEntry = { status: 'error', op, error: e instanceof Error ? e.message : 'Failed to start the background job.' }
      void chrome.storage.session.set({ [jobKey(tabId, op)]: error }).catch(() => {})
      if (tabId === currentTabId) applyJob(op, error)
    })
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

/** Render a REST failure into `container`; show a friendly re-auth message on 401. */
function showApiError(container: HTMLElement, host: string, res: { status?: number; error?: string }): void {
  const msg = isAuthError(res.status ?? 0, res.error) ? authExpiredMessage(host) : (res.error ?? 'Request failed.')
  container.replaceChildren(elText('div', 'error', msg))
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

/* ---------- scope + update set bar ---------- */

const scopebar = el('scopebar')
const selScope = el<HTMLInputElement>('sel-scope')
const selUpdateSet = el<HTMLInputElement>('sel-updateset')
const scopeListEl = el('scope-list')
const usListEl = el('updateset-list')
let lastScopeHost = ''
const scopeByName = new Map<string, string>() // name → sys_id
const usByName = new Map<string, string>()

function datalistOption(value: string): HTMLOptionElement {
  const o = document.createElement('option')
  o.value = value
  return o
}

/** Resolve the typed scope name to a sys_id ('global' by default). */
function resolveScope(): string {
  const v = selScope.value.trim()
  if (!v || v.toLowerCase() === 'global') return 'global'
  return scopeByName.get(v) ?? 'global'
}

/** Resolve the typed update-set name to a sys_id (undefined = leave current). */
function resolveUpdateSet(): string | undefined {
  const v = selUpdateSet.value.trim()
  return v ? usByName.get(v) : undefined
}

/** Writes/background runs target this scope + update set. */
function writeTargetOpts(): { scope?: string; updateSet?: string } {
  return { scope: resolveScope(), updateSet: resolveUpdateSet() }
}

function scopeLabel(): string {
  return selScope.value.trim() || 'Global'
}

/**
 * Resolve the typed scope for a WRITE, refusing the dangerous silent fallback.
 * Blank / "global" stays the legitimate explicit global default. A NON-EMPTY
 * name that doesn't map to a known sys_id is blocked with a visible error and
 * returns null — never silently rewritten to 'global', which would create the
 * record somewhere the confirm dialog didn't name. `label` matches the real
 * target so callers can show it in the confirmation.
 */
async function checkScope(): Promise<{ scope: string; label: string } | null> {
  const v = selScope.value.trim()
  if (!v || v.toLowerCase() === 'global') return { scope: 'global', label: 'global' }
  const id = scopeByName.get(v)
  if (id) return { scope: id, label: v }
  await confirmDialog(`Unknown scope "${v}" — reload the scope list and pick a real scope. Nothing was written.`)
  return null
}

/**
 * Full write target (scope + update set) with the same anti-silent-fallback
 * guard as checkScope. A non-empty update-set name that doesn't resolve is
 * blocked too, so the confirm never names an update set the write wouldn't use.
 * Returns the runBackground opts plus display labels, or null (write must not
 * proceed). Blank update set = "leave the current one" (undefined), unchanged.
 */
async function checkTarget(): Promise<
  { opts: { scope?: string; updateSet?: string }; scopeLabel: string; usLabel: string } | null
> {
  const sc = await checkScope()
  if (!sc) return null
  const uv = selUpdateSet.value.trim()
  let updateSet: string | undefined
  if (uv) {
    updateSet = usByName.get(uv)
    if (!updateSet) {
      await confirmDialog(`Unknown update set "${uv}" — reload the update-set list and pick a real one. Nothing was written.`)
      return null
    }
  }
  return { opts: { scope: sc.scope, updateSet }, scopeLabel: sc.label, usLabel: uv }
}

async function populateScopeBar() {
  if (!current) return
  scopebar.hidden = false
  if (lastScopeHost === current.host) return // already populated for this instance
  lastScopeHost = current.host

  const scopes = await queryRecords(current.host, 'sys_scope', {
    query: 'nameISNOTEMPTY^ORDERBYname',
    fields: ['sys_id', 'name'],
    limit: 1000,
    displayValue: false,
  })
  scopeByName.clear()
  scopeListEl.replaceChildren()
  if (scopes.ok) {
    for (const s of scopes.data) {
      const name = cellValue(s['name'])
      if (!name) continue
      scopeByName.set(name, cellValue(s['sys_id']))
      scopeListEl.append(datalistOption(name))
    }
  }
  await refreshUpdateSets()
}

async function refreshUpdateSets(selectName?: string) {
  if (!current) return
  const sets = await queryRecords(current.host, 'sys_update_set', {
    query: 'state=in progress^nameISNOTEMPTY^ORDERBYname',
    fields: ['sys_id', 'name'],
    limit: 500,
    displayValue: false,
  })
  usByName.clear()
  usListEl.replaceChildren()
  if (sets.ok) {
    for (const u of sets.data) {
      const name = cellValue(u['name'])
      if (!name) continue
      usByName.set(name, cellValue(u['sys_id']))
      usListEl.append(datalistOption(name))
    }
  }
  if (selectName) selUpdateSet.value = selectName
}

/** Create a new in-progress update set (in the selected scope) via a bg script. */
async function createUpdateSet() {
  if (!current) return
  // Pin the target host before the prompt/scope dialogs so a tab switch can't
  // retarget the write.
  const host = current.host
  const name = await promptDialog('New update set name:', 'e.g. snJava changes')
  if (!name) return
  const sc = await checkScope()
  if (!sc) return
  const scopeId = sc.scope
  const bg = [
    `var us = new GlideRecord('sys_update_set');`,
    `us.initialize();`,
    `us.setValue('name', ${JSON.stringify(name)});`,
    scopeId && scopeId !== 'global' ? `us.setValue('application', ${JSON.stringify(scopeId)});` : '',
    `us.setValue('state', 'in progress');`,
    `var id = us.insert();`,
    `gs.info('snJava: updateset ' + id);`,
  ]
    .filter(Boolean)
    .join('\n')

  el<HTMLButtonElement>('us-new').disabled = true
  const res = await runBackground(host, bg, { scope: scopeId })
  el<HTMLButtonElement>('us-new').disabled = false
  if (!res.ok) {
    showToast(`Create failed: ${res.error.slice(0, 50)}`)
    return
  }
  const m = extractBgOutput(res.data).match(/snJava: updateset ([0-9a-f]{32})/i)
  if (m) {
    usByName.set(name, m[1])
    usListEl.append(datalistOption(name))
    selUpdateSet.value = name
    showToast(`Update set "${name}" created ✓`)
  } else {
    showToast('Created? Check Background Scripts output')
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
  sysId?: string
  xml: string
  /** Finalized field maps to import (deduped; root-only for a form save). */
  records?: Record<string, string>[]
  count: number
  savedAt: string
}

/** True when the current page is a list view we can export from. */
function isListView(): boolean {
  return !!(current?.table && current.view === 'list')
}

/** The list's active filter, read from the page URL's sysparm_query (if any). */
function currentListQuery(): string {
  const url = current?.url ?? ''
  const m = url.match(/sysparm_query=([^&]*)/i)
  if (!m) return ''
  let q = m[1]
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(q); i++) {
    try {
      q = decodeURIComponent(q)
    } catch {
      break
    }
  }
  return q
}

/**
 * Read the list's ACTUALLY-APPLIED filter from the live page across all frames.
 * The top-tab URL rarely carries the query on Next Experience, and even in the
 * classic UI a filter applied after load lives in GlideList2, not the URL. We
 * ask each frame for GlideList2(table).getQuery() first, then the list frame's
 * sysparm_query. Returns null if nothing could be read (caller falls back).
 */
async function getListQueryFromPage(table: string): Promise<string | null> {
  if (currentTabId == null) return null
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTabId, allFrames: true },
      world: 'MAIN',
      func: (tbl: string) => {
        // 1) GlideList2 reflects the live applied filter (best source).
        try {
          const g = (window as unknown as { GlideList2?: { get?: (id: string) => unknown } }).GlideList2
          if (g && typeof g.get === 'function') {
            for (const id of [tbl, tbl + '.do', tbl + '_list']) {
              const list = g.get(id) as { getQuery?: (o?: unknown) => string } | null
              if (list && typeof list.getQuery === 'function') {
                return { table: tbl, query: list.getQuery({ orderby: false }) || '', found: true }
              }
            }
          }
        } catch {
          /* not a classic list frame */
        }
        // 2) The classic list frame's own URL.
        try {
          const seg = location.pathname.split('/').pop() || ''
          const m = seg.match(/^([a-z0-9_]+)_list\.do$/i)
          if (m) {
            const p = new URLSearchParams(location.search)
            return { table: m[1], query: p.get('sysparm_query') || '', found: true }
          }
        } catch {
          /* ignore */
        }
        return null
      },
      args: [table],
    })
    for (const r of results) {
      const v = r.result as { query?: string; found?: boolean } | null
      if (v && v.found) return v.query ?? ''
    }
  } catch {
    /* scripting blocked (e.g. non-SN frame) → fall back to URL */
  }
  return null
}

async function refreshXmlControls() {
  const formHas = !!(current?.table && current.sysId && current.view === 'form')
  const listHas = isListView()
  xmlRow.hidden = !(formHas || listHas)
  xmlSave.textContent = 'Copy'
  xmlSave.title = listHas ? 'Copy every record in this list' : 'Copy this record'
  xmlView.hidden = !formHas
  const store = await chrome.storage.local.get('xmlClip')
  const clip = store['xmlClip'] as XmlClip | undefined
  xmlPaste.disabled = !clip
  xmlPaste.textContent = clip && clip.count > 1 ? `Paste (${clip.count})` : 'Paste'
  xmlPaste.title = clip
    ? `Insert the ${clip.count} copied ${clip.table} record(s) from ${clip.host} as new records`
    : 'Copy a record first'
}

async function fetchRecordXml(): Promise<string | null> {
  if (!current?.table || !current.sysId) return null
  const res = await getText(current.host, buildRecordXmlUrl(current.host, current.table, current.sysId))
  if (!res.ok) {
    showApiError(xmlOut, current.host, res)
    return null
  }
  return res.data
}

async function saveXml() {
  if (!current?.table) return
  xmlSave.disabled = true
  const list = isListView()
  xmlOut.replaceChildren(elText('div', 'empty', list ? 'Exporting list XML…' : 'Exporting record XML…'))

  // Capture the genuine ServiceNow unload XML (`.do?...&XML`). On Paste this is
  // fed to GlideUpdateManager2.loadXML — a real XML import: sys_id preserved,
  // INSERT_OR_UPDATE (idempotent, never duplicates).
  let xml: string | null
  let query = ''
  if (list) {
    query = (await getListQueryFromPage(current.table)) ?? currentListQuery()
    const res = await getText(current.host, buildListXmlUrl(current.host, current.table, query))
    xml = res.ok ? res.data : (showApiError(xmlOut, current.host, res), null)
  } else {
    xml = await fetchRecordXml()
  }
  xmlSave.disabled = false
  if (!xml) return

  const count = parseUnloadXmlAll(xml, current.table).length
  if (count === 0) {
    xmlOut.replaceChildren(elText('div', 'error', 'The export contained no records.'))
    return
  }
  const clip: XmlClip = {
    host: current.host,
    table: current.table,
    sysId: current.sysId ?? undefined,
    xml,
    count,
    savedAt: new Date().toISOString(),
  }
  // The clip carries the raw unload XML (Paste re-parses it and inserts via
  // GlideRecord, preserving sys_id). Storing can still exceed the local-storage
  // quota on a big export, and that rejection would otherwise be swallowed
  // (stuck on "Exporting…").
  try {
    await chrome.storage.local.set({ xmlClip: clip })
  } catch (e) {
    xmlOut.replaceChildren(
      elText(
        'div',
        'error',
        `Couldn't copy the records — the export is too large for extension storage (${count} records). Try a tighter filter. (${e instanceof Error ? e.message : String(e)})`,
      ),
    )
    return
  }
  await refreshXmlControls()
  const noun = count === 1 ? 'record' : 'records'
  xmlOut.replaceChildren(
    elText(
      'div',
      'ok-banner',
      `✓ Copied ${count} ${clip.table} ${noun} as XML. Use “Paste” on the target instance to import (real XML load — sys_id preserved).`,
    ),
  )
  if (list) {
    xmlOut.append(
      elText('div', 'info-sub', query ? `Filter applied: ${query}` : 'No filter — copied the whole list.'),
    )
  }
}

/** Re-entrancy guard: a paste in flight must not be started again (double-click,
 *  panel re-fire) — otherwise the same clip is read twice and inserted twice. */
let pasteInFlight = false

async function pasteXml() {
  if (pasteInFlight) return
  pasteInFlight = true // set synchronously, before any await, so a second click no-ops
  xmlPaste.disabled = true
  try {
    await pasteXmlInner()
  } finally {
    pasteInFlight = false
    void refreshXmlControls()
  }
}

async function pasteXmlInner() {
  const store = await chrome.storage.local.get('xmlClip')
  const clip = store['xmlClip'] as XmlClip | undefined
  if (!clip || !current) return
  // Pin the target host BEFORE the confirm dialog so a tab switch between confirm
  // and send can't retarget the write to a different instance.
  const host = current.host
  if (!clip.xml) {
    xmlOut.replaceChildren(elText('div', 'error', 'This copy has no XML — Copy again with the latest version.'))
    return
  }
  // Parse the unload XML into rows (with sys_id) and insert them ourselves via
  // GlideRecord. GlideUpdateManager2.loadXML only stages update-set XML and does
  // NOT insert data records — that's why it reported ok but nothing appeared.
  const rows = parseUnloadXmlAll(clip.xml, clip.table).map((r) => r.fields)
  if (rows.length === 0) {
    xmlOut.replaceChildren(elText('div', 'error', 'No records found in the copied XML.'))
    return
  }
  const noun = rows.length === 1 ? 'record' : 'records'

  // PREVIEW (read-only, works on any instance): which sys_ids already exist?
  xmlOut.replaceChildren(elText('div', 'empty', `Checking ${rows.length} ${noun} on ${host}…`))
  const ids = rows.map((r) => r['sys_id']).filter(Boolean)
  const q = await queryRecords(host, clip.table, {
    query: `sys_idIN${ids.join(',')}`,
    fields: ['sys_id'],
    limit: rows.length,
    displayValue: false,
  })
  if (!q.ok) {
    xmlOut.replaceChildren(elText('div', 'error', `Preview failed: ${q.error}`))
    return
  }
  const existing = new Set((q.data as Array<Record<string, unknown>>).map((r) => String(r['sys_id'])))
  const preview = partitionPreview(rows, existing)
  const nUpd = preview.filter((p) => p.action === 'update').length
  const nIns = preview.length - nUpd

  // Render the preview table.
  xmlOut.replaceChildren()
  xmlOut.append(elText('div', 'sim-after-title', `Preview — ${nIns} insert, ${nUpd} update`))
  const tbl = document.createElement('div')
  tbl.className = 'diff-kv'
  preview.forEach((p, i) => {
    const r = document.createElement('div')
    r.className = 'info-row'
    r.append(
      elText('span', 'info-name', `${i + 1}. ${p.sysId.slice(0, 8)}…`),
      elText('span', p.action === 'update' ? 'dk-tag engine' : 'dk-tag sent', p.action === 'update' ? '⚠ UPDATE' : 'INSERT'),
    )
    tbl.append(r)
  })
  xmlOut.append(tbl)

  if (
    !(await confirmDialog(
      `Import ${rows.length} "${clip.table}" ${noun} into ${host}?\n\n${nIns} new record(s) inserted (sys_id preserved), ${nUpd} existing record(s) UPDATED (overwritten). Business rules skipped. You can Undo this afterwards.`,
    ))
  ) {
    xmlOut.append(elText('div', 'info-sub', 'Cancelled — nothing was written.'))
    return
  }

  // IMPORT (prod-guarded write).
  xmlOut.append(elText('div', 'empty', `Importing ${rows.length} ${noun}…`))
  const res = await runBackground(host, buildImportScript(clip.table, rows), {})
  if (!res.ok) {
    showApiError(xmlOut, host, res)
    return
  }
  const parsed = parseSnjava(extractBgOutput(res.data), 'snJava:import ') as { rows?: ImportRowResult[] } | null
  const results: ImportRowResult[] = parsed?.rows ?? []
  if (results.length === 0) {
    xmlOut.append(elText('div', 'error', `Import may have failed — output: ${extractBgOutput(res.data).slice(0, 400)}`))
    return
  }
  const okCount = results.filter((r) => r.ok).length

  // Persist the undo log (last import per host). Quota failure ⇒ warn, don't fail.
  const log: UndoLog = buildUndoLog(host, clip.table, results, new Date().toISOString())
  let undoAvailable = log.rows.length > 0
  if (undoAvailable) {
    try {
      await chrome.storage.local.set({ [`undoLog:${host}`]: log })
    } catch {
      undoAvailable = false
    }
  }

  // Per-row result list.
  xmlOut.replaceChildren(
    elText(
      'div',
      okCount === results.length ? 'ok-banner' : 'error',
      `${okCount === results.length ? '✓' : '⚠'} Imported ${okCount}/${results.length} ${clip.table} ${noun}`,
    ),
  )
  const list = document.createElement('div')
  list.className = 'diff-kv'
  results.forEach((r, i) => {
    const row = document.createElement('div')
    row.className = 'info-row'
    row.append(
      elText('span', 'info-name', `${i + 1}. ${r.sysId.slice(0, 8)}…`),
      elText('span', r.ok ? 'dk-tag sent' : 'error', r.ok ? `✓ ${r.action}` : `✗ ${r.error ?? 'failed'}`),
    )
    list.append(row)
  })
  xmlOut.append(list)
  if (!undoAvailable) xmlOut.append(elText('div', 'info-sub', 'Note: Undo is unavailable for this import (nothing undoable or storage full).'))

  // Consume the clip once anything imported (matches prior one-shot semantics).
  if (okCount > 0) {
    await chrome.storage.local.remove('xmlClip')
  }
  await renderUndoControls(host) // defined in Task 3
  await refreshXmlControls()
}

/** Show/refresh the "Undo last import" button for the current host, if a log exists. */
async function renderUndoControls(host: string): Promise<void> {
  const store = await chrome.storage.local.get(`undoLog:${host}`)
  const log = store[`undoLog:${host}`] as UndoLog | undefined
  if (!log || log.rows.length === 0) {
    // Clear any stale button even when there's nothing to show — overlapping
    // detect() calls (onActivated + onUpdated) can race here, so the removal
    // must happen right before this early return too, not just before append.
    document.querySelectorAll('#undo-last').forEach((n) => n.remove())
    return
  }

  // Remove ALL matching nodes (not just getElementById's first match) right
  // before appending, so the last-completing concurrent call always leaves
  // exactly one button instead of orphaning duplicates from a race.
  document.querySelectorAll('#undo-last').forEach((n) => n.remove())
  const btn = document.createElement('button')
  btn.id = 'undo-last'
  btn.className = 'btn btn-ghost'
  const nIns = log.rows.filter((r) => r.action === 'insert').length
  const nUpd = log.rows.length - nIns
  btn.textContent = `Undo last import (${nIns} inserted, ${nUpd} updated)`
  btn.addEventListener('click', () => void undoLastImport(host))
  xmlOut.before(btn)
}

/** Re-entrancy guard: a double-click must not stack two confirm dialogs / undo runs. */
let undoInFlight = false

/** Reverse the last import on `host`: delete inserts, restore updated fields. */
async function undoLastImport(host: string): Promise<void> {
  if (undoInFlight) return
  undoInFlight = true // set synchronously, before any await, so a second click no-ops
  try {
    const store = await chrome.storage.local.get(`undoLog:${host}`)
    const log = store[`undoLog:${host}`] as UndoLog | undefined
    if (!log || log.rows.length === 0) return
    if (
      !(await confirmDialog(
        `Undo the last import on ${host}?\n\nDeletes ${log.rows.filter((r) => r.action === 'insert').length} inserted record(s) and restores ${log.rows.filter((r) => r.action === 'update').length} updated record(s) to their previous values.`,
      ))
    ) {
      return
    }
    xmlOut.replaceChildren(elText('div', 'empty', `Undoing ${log.rows.length} change(s) on ${host}…`))
    const res = await runBackground(host, buildUndoScript(log.table, log.rows), {})
    if (!res.ok) {
      showApiError(xmlOut, host, res)
      return
    }
    const parsed = parseSnjava(extractBgOutput(res.data), 'snJava:undo ') as { rows?: Array<{ sysId: string; ok: boolean; error?: string }> } | null
    const undone = parsed?.rows ?? []
    const okIds = new Set(undone.filter((r) => r.ok).map((r) => r.sysId))
    const okCount = okIds.size

    // Keep only the rows that FAILED to undo; clear the log if all undone.
    const remaining = log.rows.filter((r) => !okIds.has(r.sysId))
    if (remaining.length === 0) {
      await chrome.storage.local.remove(`undoLog:${host}`)
    } else {
      await chrome.storage.local.set({ [`undoLog:${host}`]: { ...log, rows: remaining } })
    }

    xmlOut.replaceChildren(
      elText('div', okCount === log.rows.length ? 'ok-banner' : 'error', `${okCount === log.rows.length ? '✓' : '⚠'} Undid ${okCount}/${log.rows.length} change(s)`),
    )
    undone.filter((r) => !r.ok).forEach((r) => xmlOut.append(elText('div', 'error', `${r.sysId.slice(0, 8)}…: ${r.error ?? 'failed'}`)))
    await renderUndoControls(host)
  } finally {
    undoInFlight = false
  }
}

/** Background script that inserts a record with the given fields (scope-aware). */
function buildRecordInsertScript(table: string, fields: Record<string, string>): string {
  const sets = Object.entries(fields)
    .map(([k, v]) => `gr.setValue(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n  ')
  return [
    `var gr = new GlideRecord(${JSON.stringify(table)});`,
    `gr.initialize();`,
    `  ${sets}`,
    `var id = gr.insert();`,
    `if (id) { gs.info('snJava: imported ' + id); } else { gs.error('snJava: insert failed'); }`,
  ].join('\n')
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
    // Same single-line card style as Table schema / the script picker.
    const row = document.createElement('div')
    row.className = 'info-row'
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'info-name'
    name.textContent = k
    name.title = `Click to copy the value of ${k}`
    name.addEventListener('click', () => void copyText(v, name))
    const meta = document.createElement('span')
    meta.className = 'info-meta'
    meta.append(elText('span', 'info-sub', v.length > 80 ? v.slice(0, 80) + '…' : v))
    row.append(name, meta)
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
  // Enabled on a form record (record spec) or a list view (whole-table spec).
  specWalk.disabled = !(current?.table && (current.sysId || current.view === 'list'))
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
    showApiError(condResults, host, countRes)
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
/** Field names known to exist on the current table, used to skip re-creating fields. */
let genKnownFields = new Set<string>()
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
    showApiError(schemaResults, host, res)
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
  row.className = 'info-row'

  // element name — click to copy the full dot-walk path
  const dotPath = schemaPrefix + element
  const name = document.createElement('button')
  name.type = 'button'
  name.className = 'info-name'
  name.textContent = element
  name.title = `Click to copy "${dotPath}"`
  name.addEventListener('click', () => void copyText(dotPath, name))
  row.append(name)

  const meta = document.createElement('span')
  meta.className = 'info-meta'

  // reference → target table (click to drill in; the field becomes a dot-walk hop)
  if (refTable) {
    const ref = document.createElement('span')
    ref.className = 'ref'
    ref.textContent = `→ ${refTable}`
    ref.title = `References ${refTable} — click to dot-walk into it`
    ref.addEventListener('click', () => loadSchemaForTable(refTable, element))
    meta.append(ref)
  }

  // choices — hover (or click) to load + preview
  if (isChoiceField(d)) {
    const ch = document.createElement('span')
    ch.className = 'choices'
    ch.textContent = 'choices ▾'
    let pop: HTMLElement | null = null
    let wanted = false // true while the pointer is over the chip / a load is in flight
    const open = () => {
      if (pop || wanted) return // popup already shown or a load already running — don't orphan a second
      wanted = true
      void showChoices(
        ch,
        element,
        () => wanted,
        (p) => (pop = p),
      )
    }
    const close = () => {
      wanted = false
      pop?.remove()
      pop = null
    }
    ch.addEventListener('mouseenter', open)
    ch.addEventListener('mouseleave', close)
    ch.addEventListener('click', open)
    meta.append(ch)
  }

  const sub = label ? `${type} · ${label}` : type
  meta.append(elText('span', 'info-sub', sub))
  row.append(meta)
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

async function showChoices(
  anchor: HTMLElement,
  element: string,
  isWanted: () => boolean,
  setPop: (p: HTMLElement) => void,
) {
  if (!current) return
  const key = `${schemaTable}.${element}`
  let choices = choicesCache.get(key)
  if (!choices) {
    choices = await fetchChoices(current.host, schemaTable, element)
    choicesCache.set(key, choices)
  }
  if (!isWanted()) return // pointer left during the fetch — don't append an orphan popup
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

/**
 * Build the shared modal overlay + box. `wide` selects the "modal-box wide"
 * variant; `onOutsideClick`, when provided, dismisses on a backdrop click with
 * the caller's exact semantics (promptDialog omits it, so it stays put on an
 * outside click, unlike confirmDialog). The caller appends content to `box`,
 * appends `overlay` to the body, and manages any focus.
 */
function makeModal(opts: { wide?: boolean; onOutsideClick?: (overlay: HTMLElement) => void } = {}): {
  overlay: HTMLElement
  box: HTMLElement
} {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const box = document.createElement('div')
  box.className = opts.wide ? 'modal-box wide' : 'modal-box'
  overlay.append(box)
  if (opts.onOutsideClick) {
    const cb = opts.onOutsideClick
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cb(overlay)
    })
  }
  return { overlay, box }
}

/** Show a before/after line diff in a modal. */
function showDiff(before: string, after: string) {
  const lines = lineDiff(before, after)
  const { added, removed } = diffStats(lines)

  const { overlay, box } = makeModal({ wide: true, onOutsideClick: (o) => o.remove() })

  const head = document.createElement('div')
  head.className = 'diff-head'
  head.append(elText('span', 'title', 'Script changes — before → after'))
  const stats = document.createElement('span')
  stats.className = 'diff-stats'
  stats.append(elText('span', 'add', `+${added}`), elText('span', 'del', `−${removed}`))
  head.append(stats)

  const body = document.createElement('div')
  body.className = 'diff-body'
  if (added === 0 && removed === 0) {
    body.append(elText('div', 'diff-line context', '  (no differences)'))
  }
  for (const l of lines) {
    const row = document.createElement('div')
    row.className = `diff-line ${l.op}`
    const sign = l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '
    row.append(elText('span', 'sign', sign), document.createTextNode(l.text))
    body.append(row)
  }

  const row = document.createElement('div')
  row.className = 'btn-row'
  const close = document.createElement('button')
  close.className = 'btn'
  close.textContent = 'Close'
  close.addEventListener('click', () => overlay.remove())
  row.append(close)

  box.append(head, body, row)
  document.body.append(overlay)
}

/** In-panel text prompt — window.prompt() is suppressed in side panels. */
function promptDialog(message: string, placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const { overlay, box } = makeModal()
    box.append(elText('div', 'modal-msg', message))
    const input = document.createElement('input')
    input.className = 'modal-input'
    input.placeholder = placeholder
    box.append(input)
    const row = document.createElement('div')
    row.className = 'btn-row'
    const cancel = document.createElement('button')
    cancel.className = 'btn btn-ghost'
    cancel.textContent = 'Cancel'
    const ok = document.createElement('button')
    ok.className = 'btn'
    ok.textContent = 'Create'
    const done = (v: string | null) => {
      overlay.remove()
      resolve(v)
    }
    cancel.addEventListener('click', () => done(null))
    ok.addEventListener('click', () => done(input.value.trim() || null))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null)
      if (e.key === 'Escape') done(null)
    })
    row.append(cancel, ok)
    box.append(row)
    document.body.append(overlay)
    input.focus()
  })
}

/** In-panel confirm dialog — window.confirm() is suppressed in side panels. */
function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { overlay, box } = makeModal({ onOutsideClick: () => done(false) })
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
    row.append(cancel, ok)
    box.append(row)
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
const scriptOpen = el<HTMLButtonElement>('script-open')
const analyzeBtn = el<HTMLButtonElement>('analyze-btn')
const reviewSpinner = el('review-spinner')
const aiStatus = el('ai-status')
const lintSummary = el('lint-summary')
const lintResults = el('lint-results')
const simCard = el('runner-card')

// AI review outputs
const optimizeSection = el('optimize-section')
const optimizeEd = createCodeEditor(el('optimize-editor'))
const optimizeFormat = el<HTMLButtonElement>('optimize-format')
const optimizeCopy = el<HTMLButtonElement>('optimize-copy')
const optimizeUse = el<HTMLButtonElement>('optimize-use')
const optimizeSave = el<HTMLButtonElement>('optimize-save')

/** The script record currently loaded into the tester (for "Save to record"). */
let loadedScriptRecord: { host: string; table: string; sysId: string; scriptField: string } | null = null
/** Trigger summary of the loaded script (BR when/actions/condition, CS type/field). */
let loadedTrigger = ''
const testerTrigger = el('tester-trigger')

/** Show and remember the loaded script's trigger + condition. */
function showTrigger(kind: ScriptKind, rec: Record<string, unknown>) {
  const cv = (k: string) => cellValue(rec[k])
  let summary = ''
  let condition = ''
  if (kind === 'business_rule') {
    const acts = ['insert', 'update', 'delete', 'query'].filter((a) => cv(`action_${a}`) === 'true')
    const when = cv('when')
    const table = cv('collection')
    summary = [when && `when: ${when}`, table && `table: ${table}`, acts.length && `on: ${acts.join(', ')}`]
      .filter(Boolean)
      .join(' · ')
    condition = cv('condition') || cv('filter_condition')
  } else if (kind === 'client_script') {
    const type = cv('type')
    const field = cv('field')
    summary = [type && `type: ${type}`, field && `field: ${field}`].filter(Boolean).join(' · ')
  } else {
    testerTrigger.hidden = true
    loadedTrigger = ''
    return
  }
  loadedTrigger = [summary, condition && `condition: ${condition}`].filter(Boolean).join(' · ')
  testerTrigger.hidden = !summary && !condition
  testerTrigger.replaceChildren()
  if (summary) {
    const line = document.createElement('div')
    line.append(elText('span', 'tg-label', 'Trigger'), document.createTextNode(summary))
    testerTrigger.append(line)
  }
  if (condition) testerTrigger.append(elText('code', 'tg-cond', `condition: ${condition}`))
}
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

/** Switch to a named tab programmatically. */
function activateTab(tabId: string) {
  document.getElementById(tabId)?.dispatchEvent(new MouseEvent('click'))
}

/** Toggle the BR timing selector. */
function syncTimingVisibility() {
  timingWrap.style.display = scriptKind.value === 'business_rule' ? '' : 'none'
}

/** Fetch a script record (any script table) and populate the Layer 1 editor. */
async function loadScriptIntoTester(host: string, scriptTable: string, sysId: string) {
  const info = scriptTableInfo(scriptTable)
  if (!info) return
  testerSource.textContent = 'Loading script…'

  const fields = [info.scriptField, info.nameField, 'sys_scope']
  if (info.timingField) fields.push(info.timingField)
  if (info.tableField) fields.push(info.tableField)
  // Trigger/condition fields per kind.
  if (info.kind === 'business_rule') {
    fields.push('condition', 'filter_condition', 'action_insert', 'action_update', 'action_delete', 'action_query')
  } else if (info.kind === 'client_script') {
    fields.push('type', 'field')
  }

  const res = await getRecord(host, scriptTable, sysId, fields)
  if (!res.ok) {
    testerSource.textContent = `Could not load: ${res.error}`
    return
  }
  const rec = res.data
  loadedScriptRecord = { host, table: scriptTable, sysId, scriptField: info.scriptField }
  scriptOpen.hidden = false
  showTrigger(info.kind, rec)
  scriptEd.setValue(cellValue(rec[info.scriptField]))
  scriptKind.value = info.kind
  if (info.timingField) scriptTiming.value = normalizeTiming(cellValue(rec[info.timingField]))
  // Layer 3: point the target table at what this script runs against.
  if (info.tableField) {
    const target = cellValue(rec[info.tableField])
    if (target) l3Table.value = target
  }
  // Show the script's application scope, and target writes at it by default.
  const scopeName = cellDisplay(rec['sys_scope'])
  if (scopeName) selScope.value = scopeName
  syncTimingVisibility()
  const name = cellDisplay(rec[info.nameField]) || scriptTable
  testerSource.textContent =
    `Loaded "${name}" (${info.kind.replace('_', ' ')})` + (scopeName ? ` · scope: ${scopeName}` : '') + '.'
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
    showApiError(pickerResults, current.host, res)
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
    lintResults.append(elText('div', 'ok-banner', '✓ No anti-patterns found by the static lints.'))
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
    trigger: loadedTrigger || undefined,
    ...seedInfo(),
  })
  if (!started) {
    aiStatus.textContent = 'Open a ServiceNow tab first.'
    return
  }
  applyReviewJob({ status: 'running', op: 'review', startedAt: Date.now() })
}

/** Render the review UI from a job entry (running / done / error). */
function applyReviewJob(entry: LlmJobEntry | undefined) {
  if (!entry) return
  if (entry.status === 'running') {
    // A running entry that's too old (or has no startedAt) means the background
    // worker was killed mid-fetch and will never write done/error — treat it as
    // a retryable failure instead of spinning forever.
    if (isStaleJob(entry)) {
      optimizeSection.hidden = true
      reviewSpinner.hidden = true
      analyzeBtn.disabled = false
      aiStatus.textContent = "The previous review didn't finish (the background worker was interrupted). Run it again."
      return
    }
    optimizeSection.hidden = true
    reviewSpinner.hidden = false
    analyzeBtn.disabled = true
    aiStatus.textContent = 'Asking the AI for an optimized script and a tester script… (keeps running if you close this panel)'
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
  // Render notes into a dedicated container that is REPLACED on every apply, so a
  // duplicate 'done' delivery (direct sendMessage reply + storage.onChanged) can't
  // append the same notes twice.
  let notesBox = lintResults.querySelector<HTMLElement>('.review-notes')
  if (!notesBox) {
    notesBox = document.createElement('div')
    notesBox.className = 'review-notes'
    lintResults.append(notesBox)
  }
  notesBox.replaceChildren(...notes.map((n) => elText('div', 'review-note', n)))
  if (optimizedScript) {
    optimizeEd.setValue(optimizedScript)
    optimizeSection.hidden = false
  }
  if (testScript) {
    testerEd.setValue(testScript)
    updateGuard()
    simCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
}

/** Background script that updates one field of one record (scope-aware). */
function buildRecordUpdateScript(table: string, sysId: string, field: string, code: string): string {
  return [
    `var gr = new GlideRecord(${JSON.stringify(table)});`,
    `if (gr.get(${JSON.stringify(sysId)})) {`,
    `  gr.setValue(${JSON.stringify(field)}, ${JSON.stringify(code)});`,
    `  gr.update();`,
    `  gs.info('snJava: updated ' + gr.getUniqueValue());`,
    `} else {`,
    `  gs.error('snJava: record not found: ' + ${JSON.stringify(sysId)});`,
    `}`,
  ].join('\n')
}

/**
 * Save the optimized script back to the record. Runs as a background script in
 * the selected Scope + Update Set, so it works for scoped-app records that the
 * Table API rejects with a cross-scope 403.
 */
async function saveOptimizedToRecord() {
  if (!loadedScriptRecord) {
    showToast('Load a script from a record first (picker or open the record)')
    return
  }
  const { host, table, sysId, scriptField } = loadedScriptRecord
  const code = optimizeEd.getValue()
  if (!code.trim()) return
  const tgt = await checkTarget()
  if (!tgt) return
  if (
    !(await confirmDialog(
      `Save the optimized script to ${table} on ${host}?\n\nRuns as a background script in scope "${tgt.scopeLabel}"${
        tgt.usLabel ? ` and update set "${tgt.usLabel}"` : ''
      }.`,
    ))
  ) {
    return
  }

  optimizeSave.disabled = true
  aiStatus.textContent = 'Saving via background script…'
  const bg = buildRecordUpdateScript(table, sysId, scriptField, code)
  const res = await runBackground(host, bg, tgt.opts)
  optimizeSave.disabled = false

  if (!res.ok) {
    aiStatus.textContent = `Save failed (HTTP ${res.status}): ${res.error}`
    showToast('Save failed — see status')
    return
  }
  const out = extractBgOutput(res.data)
  if (/snJava: updated/.test(out)) {
    scriptEd.setValue(code)
    aiStatus.textContent = 'Saved optimized script to the record ✓'
    showToast('Saved ✓')
  } else {
    aiStatus.textContent = `Save may have failed — output: ${out.slice(0, 300)}`
    showToast('Check status')
  }
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
const seedSource = el<HTMLSelectElement>('seed-source')
const seedQuery = el<HTMLInputElement>('seed-query')
const modeSimulate = el('mode-simulate')
const modeReal = el('mode-real')

/** Current seed choice for the tester/guarded flows. */
function seedInfo(): { seedMode: 'blank' | 'record' | 'query'; seedSysId?: string; seedQuery?: string } {
  const mode = seedSource.value as 'blank' | 'record' | 'query'
  return {
    seedMode: mode,
    seedSysId: mode === 'record' ? current?.sysId ?? undefined : undefined,
    seedQuery: mode === 'query' ? seedQuery.value.trim() || undefined : undefined,
  }
}

function initRunnerMode() {
  seedSource.addEventListener('change', () => {
    seedQuery.hidden = seedSource.value !== 'query'
  })
  const btns = [el<HTMLButtonElement>('mode-btn-simulate'), el<HTMLButtonElement>('mode-btn-real')]
  for (const b of btns) {
    b.addEventListener('click', () => {
      btns.forEach((x) => x.classList.remove('is-active'))
      b.classList.add('is-active')
      const real = b.dataset.mode === 'real'
      modeSimulate.hidden = real
      modeReal.hidden = !real
    })
  }
}

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

/** One prod-guard verdict for the whole Test Runner (Simulate + Guarded real). */
function updateGuard() {
  l3Allowed = !!current && classifyInstance(current.host).allowed
  // Only surface the guard when execution is BLOCKED (prod); stay quiet on sub-prod.
  if (current && !l3Allowed) {
    simGuard.hidden = false
    simGuard.className = 'guard-badge blocked'
    simGuard.textContent = `⛔ ${classifyInstance(current.host).reason}`
  } else {
    simGuard.hidden = true
  }
  simRun.disabled = !l3Allowed
  l3Create.disabled = !(l3Allowed && current)
  l3Delete.disabled = !(l3Allowed && l3Created)
}

/** Open the Background Scripts page and pre-fill it with the given script. */
async function openBackgroundScripts(host: string, script: string) {
  // Classic page: it has a plain <textarea id="script"> that we can reliably
  // fill. The modern page (sys.scripts.modern.do) uses a Monaco editor that
  // resists programmatic fill, so we use classic for the auto-fill to work.
  const tab = await chrome.tabs.create({ url: `https://${host}/sys.scripts.do` })
  const tabId = tab.id
  if (tabId == null) return
  void copyText(script) // clipboard fallback in case the field can't be filled
  const cleanup = () => {
    chrome.tabs.onUpdated.removeListener(onUpdated)
    chrome.tabs.onRemoved.removeListener(onRemoved)
  }
  // If the tab is closed before it finishes loading, onUpdated never fires with
  // 'complete' — so also drop the listeners when the tab is removed, else they
  // leak for the panel's lifetime.
  const onRemoved = (id: number) => {
    if (id === tabId) cleanup()
  }
  const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
    if (id !== tabId || info.status !== 'complete') return
    cleanup()
    // Retry a few times — the modern page's editor mounts after load.
    let tries = 0
    const attempt = () => {
      tries++
      chrome.scripting
        .executeScript({
          target: { tabId, allFrames: true },
          world: 'MAIN',
          func: fillBackgroundScriptEditor,
          args: [script],
        })
        .then((results) => {
          const ok = results.some((r) => r.result === true)
          if (!ok && tries < 6) setTimeout(attempt, 700)
        })
        .catch(() => {
          if (tries < 6) setTimeout(attempt, 700)
        })
    }
    attempt()
  }
  chrome.tabs.onUpdated.addListener(onUpdated)
  chrome.tabs.onRemoved.addListener(onRemoved)
}

/**
 * Runs in the page (MAIN world) to fill the Background Scripts editor. Tries the
 * classic textarea, Monaco, CodeMirror 5/6, and ACE. Returns true if it filled.
 */
function fillBackgroundScriptEditor(code: string): boolean {
  const w = window as unknown as {
    monaco?: { editor?: { getModels?: () => { setValue: (v: string) => void }[] } }
    ace?: { edit: (el: Element) => { setValue: (v: string, cursor?: number) => void } }
  }
  // 1. Classic plain textarea
  const ta = document.querySelector(
    'textarea#script, textarea[name="script"], textarea[name="script.script"]',
  ) as HTMLTextAreaElement | null
  if (ta) {
    ta.value = code
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  // 2. Monaco
  const models = w.monaco?.editor?.getModels?.()
  if (models && models.length) {
    models[0].setValue(code)
    return true
  }
  // 3. CodeMirror 6 (contenteditable with a view) or 5 (.CodeMirror.CodeMirror)
  const cm5 = document.querySelector('.CodeMirror') as (Element & { CodeMirror?: { setValue: (v: string) => void } }) | null
  if (cm5?.CodeMirror) {
    cm5.CodeMirror.setValue(code)
    return true
  }
  // 4. ACE
  const aceEl = document.querySelector('.ace_editor')
  if (aceEl && w.ace) {
    try {
      w.ace.edit(aceEl).setValue(code, -1)
      return true
    } catch {
      /* ignore */
    }
  }
  return false
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

  const res = await runBackground(current.host, script, writeTargetOpts())
  simSpinner.hidden = true
  simRun.disabled = false

  if (!res.ok) {
    showApiError(simResults, current.host, res)
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

/* ---------- Guarded Real Execution (create → observe → delete) ---------- */

const l3Table = el<HTMLInputElement>('l3-table')
const l3Fields = el<HTMLTextAreaElement>('l3-fields')
const l3Create = el<HTMLButtonElement>('l3-create')
const l3Delete = el<HTMLButtonElement>('l3-delete')
const l3Results = simResults // shared results area in the Test Runner card

let l3Allowed = false
// Host-pinned so a Delete always targets the instance the record was created on
// (sys_ids collide across update-set-migrated instances — deleting by sys_id on
// the wrong host can destroy a real record). Cleared on any host change.
let l3Created: { host: string; table: string; sysId: string } | null = null

/** Prefill the guarded-real fields from the current record (or a seed query). */
async function l3FillFromRecord() {
  if (!current) return
  const table = l3Table.value.trim() || current.table
  if (!table) return
  l3Results.replaceChildren(elText('div', 'empty', 'Loading record…'))
  let rec: Record<string, unknown> | null = null
  if (seedSource.value === 'query' && seedQuery.value.trim()) {
    const q = await queryRecords(current.host, table, { query: seedQuery.value.trim(), limit: 1, displayValue: false })
    rec = q.ok && q.data[0] ? q.data[0] : null
  } else if (current.sysId) {
    const r = await getRecord(current.host, table, current.sysId)
    rec = r.ok ? r.data : null
  }
  if (!rec) {
    l3Results.replaceChildren(elText('div', 'error', 'No record to fill from.'))
    return
  }
  const fields = importableFields(
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, cellValue(v)])),
  )
  l3Fields.value = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  l3Results.replaceChildren(elText('div', 'ok-banner', `Filled ${Object.keys(fields).length} fields from a ${table} record.`))
}

async function createTestRecord() {
  if (!current || !l3Allowed) return
  // Pin the target host before the confirm dialog so a tab switch can't retarget
  // the write (and so the recorded l3Created.host matches where we wrote).
  const host = current.host
  const table = l3Table.value.trim()
  if (!table) {
    l3Results.replaceChildren(elText('div', 'error', 'Enter a target table.'))
    return
  }
  const fields = parseFields(l3Fields.value)
  const tgt = await checkTarget()
  if (!tgt) return
  if (
    !(await confirmDialog(
      `Create a REAL record in "${table}" on ${host}?\n\nRuns the actual Business Rules, in scope "${tgt.scopeLabel}"${
        tgt.usLabel ? ` / update set "${tgt.usLabel}"` : ''
      }. Then read the result and delete.`,
    ))
  ) {
    return
  }

  l3Create.disabled = true
  const log = document.createElement('div')
  log.className = 'runlog'
  l3Results.replaceChildren(elText('div', 'sim-after-title', 'Guarded run'), log)
  const step = (text: string, cls = '') => log.append(elText('div', `log-step ${cls}`, `• ${text}`))

  step(`Creating a ${table} record on ${host} (scope ${tgt.scopeLabel})…`)
  const t0 = Date.now()
  // Create via a background insert so it runs in the chosen scope + update set
  // (Table API 403s on scoped-app tables). Dumps ALL fields + a default record
  // so we can show exactly what the Business Rules changed.
  const res = await runBackground(host, buildGuardedInsertScript(table, fields), tgt.opts)
  if (!res.ok) {
    step(`✗ Create failed (HTTP ${res.status}): ${res.error}`, 'err')
    l3Create.disabled = false
    updateGuard()
    return
  }
  const out = extractBgOutput(res.data)
  if (/snJava:aborted/.test(out)) {
    step('⛔ insert() returned nothing — a "before" Business Rule aborted the insert.', 'err')
    l3Create.disabled = false
    updateGuard()
    return
  }
  const result = parseSnjava(out, 'snJava:result ') ?? {}
  const defaults = parseSnjava(out, 'snJava:defaults ') ?? {}
  const sysId = typeof result['sys_id'] === 'string' ? (result['sys_id'] as string) : ''
  if (!sysId) {
    step('✗ Could not read the created record’s sys_id (it may still have been created — delete manually if so).', 'err')
    const pre = document.createElement('pre')
    pre.className = 'code-block'
    pre.textContent = out.slice(0, 1500)
    l3Results.append(pre)
    l3Create.disabled = false
    updateGuard()
    return
  }
  l3Created = { host, table, sysId }
  step(`✓ Created ${sysId.slice(0, 8)}… in ${Date.now() - t0}ms — Business Rules ran on insert`, 'ok')
  renderL3Diff(fields, result as Record<string, L3Cell>, defaults as Record<string, L3Cell>)
  step('Done. Delete the test record when finished.')
  l3Create.disabled = false
  updateGuard()
}

/** Background insert (in scope) that dumps all fields after insert + defaults. */
function buildGuardedInsertScript(table: string, fields: Record<string, string>): string {
  const t = JSON.stringify(table)
  const sets = Object.entries(fields)
    .map(([k, v]) => `gr.setValue(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n  ')
  const seedKeys = JSON.stringify([
    ...new Set([...Object.keys(fields), 'number', 'state', 'work_notes', 'approval', 'active', 'assignment_group', 'assigned_to']),
  ])
  return [
    `var gr = new GlideRecord(${t});`,
    `gr.initialize();`,
    `  ${sets}`,
    `var id = gr.insert();`,
    `if (!id) { gs.info('snJava:aborted'); }`,
    `else {`,
    `  gr.get(id);`,
    `  var def = new GlideRecord(${t}); def.initialize();`,
    `  var out = {}; var defs = {};`,
    `  function grab(nm) {`,
    `    var v = gr.getValue(nm), dv = gr.getDisplayValue(nm);`,
    `    out[nm] = { v: (v == null ? '' : '' + v), d: (dv == null ? '' : '' + dv) };`,
    `    var dfv = def.getValue(nm), dfd = def.getDisplayValue(nm);`,
    `    defs[nm] = { v: (dfv == null ? '' : '' + dfv), d: (dfd == null ? '' : '' + dfd) };`,
    `  }`,
    `  try {`,
    `    var fs = gr.getFields();`,
    `    for (var i = 0; i < fs.size(); i++) { grab('' + fs.get(i).getName()); }`,
    `  } catch (e) {`,
    `    var names = ${seedKeys};`,
    `    for (var j = 0; j < names.length; j++) { try { grab(names[j]); } catch (e2) {} }`,
    `    gs.info('snJava:dumpwarn ' + e);`,
    `  }`,
    `  out.sys_id = id;`,
    `  gs.info('snJava:result ' + JSON.stringify(out));`,
    `  gs.info('snJava:defaults ' + JSON.stringify(defs));`,
    `}`,
  ].join('\n')
}

/** Parse the JSON object that follows a marker (balanced-brace, string-aware). */
function parseSnjava(output: string, marker: string): Record<string, unknown> | null {
  const i = output.indexOf(marker)
  if (i === -1) return null
  const s = output.slice(i + marker.length)
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let p = start; p < s.length; p++) {
    const c = s[p]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, p + 1)) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** System-managed fields excluded from the "set by Business Rules" view. */
const L3_NOISE = new Set([
  'sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by',
  'sys_mod_count', 'sys_domain', 'sys_domain_path', 'sys_tags', 'sys_class_name',
])

interface L3Cell {
  v: string
  d: string
}

function cellOf(x: unknown): L3Cell {
  if (x && typeof x === 'object' && 'v' in (x as object)) {
    const c = x as Partial<L3Cell>
    return { v: c.v ?? '', d: c.d ?? '' }
  }
  return { v: typeof x === 'string' ? x : '', d: typeof x === 'string' ? x : '' }
}

/**
 * Guarded-run report: every field whose final value differs from the table
 * default (excluding system noise). Tagged 'you' when we set exactly that value,
 * otherwise 'engine' (a Business Rule / flow / the platform set it). Shows
 * display values.
 */
function renderL3Diff(seed: Record<string, string>, result: Record<string, L3Cell>, defaults: Record<string, L3Cell>) {
  const changed: { field: string; before: string; after: string; you: boolean }[] = []
  for (const k of Object.keys(result)) {
    if (k === 'sys_id' || L3_NOISE.has(k)) continue
    const after = cellOf(result[k])
    const before = cellOf(defaults[k])
    if (after.v === before.v) continue // unchanged from the table default
    // "you" only if we sent exactly this value (the engine didn't override it).
    const you = k in seed && seed[k] === after.v
    changed.push({
      field: k,
      before: before.d || before.v,
      after: after.d || after.v,
      you,
    })
  }
  changed.sort((a, b) => Number(b.you) - Number(a.you) || a.field.localeCompare(b.field))

  const box = document.createElement('div')
  box.className = 'sim-after'
  box.append(elText('div', 'sim-after-title', `${changed.length} field(s) changed`))
  if (changed.length === 0) {
    box.append(elText('div', 'empty', 'No fields changed from the table defaults.'))
    l3Results.append(box)
    return
  }

  const search = document.createElement('input')
  search.className = 'query-input'
  search.placeholder = 'filter changed fields by name or value…'
  search.style.margin = '4px 0 8px'
  box.append(search)

  const rows: { el: HTMLElement; hay: string }[] = []
  for (const c of changed) {
    const row = document.createElement('div')
    row.className = 'diff-kv'
    row.append(elText('span', 'dk-field', c.field))
    row.append(elText('span', c.you ? 'dk-tag sent' : 'dk-tag engine', c.you ? 'you' : 'engine'))
    row.append(
      elText('span', 'dk-before', c.before || '(empty)'),
      elText('span', 'dk-arrow', '→'),
      elText('span', 'dk-after', c.after || '(empty)'),
    )
    box.append(row)
    rows.push({ el: row, hay: `${c.field} ${c.before} ${c.after}`.toLowerCase() })
  }
  search.addEventListener('input', () => {
    const f = search.value.trim().toLowerCase()
    for (const r of rows) r.el.hidden = f !== '' && !r.hay.includes(f)
  })
  l3Results.append(box)
}

async function deleteTestRecord() {
  if (!current || !l3Created) return
  // Pin every reference to the creation host captured at create time — detect()
  // may have reassigned `current` to a different instance since then.
  const target = l3Created
  if (!(await confirmDialog(`Delete test record ${target.sysId.slice(0, 8)}… from ${target.table} on ${target.host}?`))) return

  l3Delete.disabled = true
  // Delete via a background script too, so it runs in the same scope.
  const bg = [
    `var gr = new GlideRecord(${JSON.stringify(target.table)});`,
    `if (gr.get(${JSON.stringify(target.sysId)})) { gr.deleteRecord(); gs.info('snJava:deleted'); }`,
    `else { gs.error('snJava:notfound'); }`,
  ].join('\n')
  const res = await runBackground(target.host, bg, writeTargetOpts())
  if (!res.ok || !/snJava:deleted/.test(extractBgOutput(res.data))) {
    l3Results.append(elText('div', 'error', `Delete failed: ${res.ok ? extractBgOutput(res.data).slice(0, 120) : res.error}`))
    l3Delete.disabled = false
    return
  }
  l3Results.append(elText('div', 'ok-banner', '✓ Test record deleted.'))
  l3Created = null
  updateGuard()
}

/* ---------- Design Spec Generator (M4 / F1) ---------- */

const specWalk = el<HTMLButtonElement>('spec-walk')
const specStatus = el('spec-status')
const specChecklist = el('spec-checklist')
const specOutput = el('spec-output')
const specHtmlBtn = el<HTMLButtonElement>('spec-html')
const specPdfBtn = el<HTMLButtonElement>('spec-pdf')
const specDocxBtn = el<HTMLButtonElement>('spec-docx')
const specAiRow = el('spec-ai-row')
const specAiBtn = el<HTMLButtonElement>('spec-ai')
const specAiSpinner = el('spec-ai-spinner')
const specAiStatus = el('spec-ai-status')

let specRoot: ArtifactRef | null = null
let specArtifacts: ArtifactRef[] = []
let specPrimaryTable = ''
let specSchema: import('@core/spec').SpecSchemaField[] = []
const specExcluded = new Set<string>()
/** AI-drafted overview text for the current spec, or null until generated (or re-discovered). */
let specAiOverview: string | null = null
/** Once the user consents to a narrative send, don't ask again for the rest of this panel session. */
let narrativeDontAskAgain = false
let logoDataUriCache: string | undefined

const ARTIFACT_GROUP: Record<string, string> = {
  table: 'Data model',
  business_rule: 'Business Rules',
  client_script: 'Client Scripts',
  variable: 'Variables',
  variable_set: 'Variable sets',
  ui_policy: 'UI policies',
  ui_policy_action: 'UI policy actions',
  script_include: 'Script Includes',
  catalog_client_script: 'Catalog client scripts',
  workflow: 'Integration',
  transform_map: 'Transform maps',
  transform_entry: 'Transform entries',
  notification: 'Notifications',
  data_policy: 'Data policies',
  acl: 'ACLs',
}

async function getLogoDataUri(): Promise<string | undefined> {
  if (logoDataUriCache !== undefined) return logoDataUriCache
  // Vite copies public/ to the dist root (stripping the prefix), so the packaged
  // path is brand/… — but @crxjs also mirrors manifest-referenced assets under
  // public/. Try both so the real logo loads regardless of the build layout.
  const candidates = ['brand/mfec-logo-light.png', 'public/brand/mfec-logo-light.png']
  for (const path of candidates) {
    try {
      const res = await fetch(chrome.runtime.getURL(path))
      if (!res.ok) continue
      const blob = await res.blob()
      logoDataUriCache = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.readAsDataURL(blob)
      })
      return logoDataUriCache
    } catch {
      /* try next candidate */
    }
  }
  logoDataUriCache = undefined
  return logoDataUriCache
}

async function discoverArtifacts() {
  if (!current?.table) return
  const { host, table, sysId } = current

  specWalk.disabled = true
  specOutput.hidden = true
  specStatus.hidden = true
  specChecklist.replaceChildren(elText('div', 'empty', sysId ? 'Loading root record…' : 'Loading table…'))

  // Form → record spec (rooted at the record). List → whole-table ("module") spec.
  const root = sysId ? await loadRootArtifact(host, table, sysId) : tableRootArtifact(table)
  if (!root) {
    specChecklist.replaceChildren(elText('div', 'error', 'Could not load the root record.'))
    specWalk.disabled = false
    return
  }
  specChecklist.replaceChildren(elText('div', 'empty', 'Walking dependency graph…'))

  try {
    const outcome = await walkSpecGraph(host, root, (n) => {
      specChecklist.replaceChildren(elText('div', 'empty', `Discovering… ${n} artifacts`))
    })
    specRoot = outcome.root
    specArtifacts = outcome.artifacts
    specPrimaryTable = outcome.primaryTable
    specSchema = outcome.schema
    specExcluded.clear()
    // A fresh discovery invalidates any prior AI overview — it described a
    // different root/artifact set and must not silently attach to this one.
    specAiOverview = null
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
  void updateSpecAiButton()
}

/** Artifacts the user hasn't unchecked — the set actually documented/sent. */
function includedSpecArtifacts(): ArtifactRef[] {
  return specArtifacts.filter((a) => !specExcluded.has(a.id))
}

/**
 * Show/enable the "Add AI narrative" button only when there's an LLM endpoint
 * configured (mirrors the configured-check the Generate/Review tabs apply to
 * their own outcomes) and there's something discovered to narrate. Called
 * wherever the spec preview/export buttons are (re)enabled after discovery.
 */
async function updateSpecAiButton() {
  const configured = !!(await loadLlmConfig())
  const show = configured && specArtifacts.length > 0
  specAiRow.hidden = !show
  specAiStatus.hidden = !show
  if (show) {
    specAiBtn.disabled = false
    specAiSpinner.hidden = true
    specAiStatus.textContent =
      'Uses your configured LLM endpoint to draft a plain-English overview. Script bodies are redacted before sending.'
  }
}

function buildSpecDoc(): SpecDocument | null {
  if (!specRoot || !current) return null
  const included = includedSpecArtifacts()
  return composeSpec({
    instance: current.host,
    rootTable: specRoot.table,
    rootLabel: specRoot.label,
    rootFields: specRoot.fields,
    artifacts: included,
    primaryTable: specPrimaryTable,
    schema: specSchema,
    aiOverview: specAiOverview ?? undefined,
  })
}

function safeName(): string {
  // {instance}_{module}_specification_document — instance short name + table.
  const clean = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 40)
  const instance = clean((current?.host ?? '').split('.')[0] || 'instance')
  const module = clean(specPrimaryTable || specRoot?.table || 'design')
  return `${instance}_${module}_specification_document`
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
  const base = buildSpecDoc()
  if (!base) return
  const doc = await formatSpecDoc(base)
  const html = renderSpecHtml(doc, { logoDataUri: await getLogoDataUri() })
  download(new Blob([html], { type: 'text/html' }), `${safeName()}.html`)
}

async function exportPdf() {
  const base = buildSpecDoc()
  if (!base) return
  const doc = await formatSpecDoc(base)
  const html = renderSpecHtml(doc, { logoDataUri: await getLogoDataUri() }).replace(
    '</body>',
    '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},350)})</script></body>',
  )
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  // Open in a normal tab so the user can Save as PDF (auto-print dialog).
  await chrome.tabs.create({ url })
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

async function getLogoBytes(): Promise<Uint8Array | undefined> {
  for (const path of ['brand/mfec-logo-light.png', 'public/brand/mfec-logo-light.png']) {
    try {
      const res = await fetch(chrome.runtime.getURL(path))
      if (!res.ok) continue
      return new Uint8Array(await res.arrayBuffer())
    } catch {
      /* try next */
    }
  }
  return undefined
}

async function exportDocx() {
  const base = buildSpecDoc()
  if (!base) return
  specDocxBtn.disabled = true
  try {
    const doc = await formatSpecDoc(base)
    const blob = await renderSpecDocxBlob(doc, await getLogoBytes())
    download(blob, `${safeName()}.docx`)
  } finally {
    specDocxBtn.disabled = false
  }
}

/* ---------- Spec AI narrative ---------- */

/** Best-effort host for the consent dialog; falls back to the raw string if it doesn't parse as a URL. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint
  } catch {
    return endpoint
  }
}

/**
 * Consent-gated: send a redacted summary of the discovered artifacts to the
 * configured LLM endpoint and draft a plain-English overview for the spec.
 * Runs in the background (op 'narrative'), same plumbing as review/generate.
 */
async function specAiNarrative() {
  if (!specRoot) return
  const included = includedSpecArtifacts()

  if (!narrativeDontAskAgain) {
    const cfg = await loadLlmConfig()
    const host = cfg ? hostOf(cfg.endpoint) : 'the configured endpoint'
    const n = included.length
    const proceed = await confirmDialog(
      `Send a summary of "${specRoot.table}" (${n} artifact${n === 1 ? '' : 's'}) to ${host} to draft an AI overview?\n\n` +
        `Script bodies are redacted (secrets/URLs stripped) before sending. You won't be asked again this session.`,
    )
    if (!proceed) return
    // Consent is per-session, not per-request: once the user proceeds here, don't
    // re-prompt for subsequent narrative sends until the panel is reloaded.
    narrativeDontAskAgain = true
  }

  const input: NarrativeInput = {
    table: specRoot.table,
    rootLabel: specRoot.label,
    artifacts: included.map((a) => ({ name: a.label, type: a.type, script: a.fields.script })),
  }

  specAiBtn.disabled = true
  specAiSpinner.hidden = false
  specAiStatus.hidden = false
  specAiStatus.textContent = 'Asking the AI for a design overview… (keeps running if you close this panel)'

  const started = await startLlmJob('narrative', input)
  if (!started) {
    specAiBtn.disabled = false
    specAiSpinner.hidden = true
    specAiStatus.textContent = 'Open a ServiceNow tab first.'
    return
  }
  applyNarrativeJob({ status: 'running', op: 'narrative', startedAt: Date.now() })
}

/** Render the narrative job from a job entry (running / done / error). */
function applyNarrativeJob(entry: LlmJobEntry | undefined) {
  if (!entry) return
  if (entry.status === 'running') {
    // Stale (or timestamp-less) running entry: the background worker was killed
    // mid-fetch, so no done/error will ever arrive — surface it as retryable.
    if (isStaleJob(entry)) {
      specAiSpinner.hidden = true
      specAiBtn.disabled = false
      specAiStatus.hidden = false
      specAiStatus.textContent = "The previous request didn't finish (the background worker was interrupted). Try again."
      return
    }
    specAiSpinner.hidden = false
    specAiBtn.disabled = true
    specAiStatus.hidden = false
    specAiStatus.textContent = 'Asking the AI for a design overview… (keeps running if you close this panel)'
    return
  }
  specAiSpinner.hidden = true
  specAiBtn.disabled = false

  if (entry.status === 'error') {
    specAiStatus.hidden = false
    specAiStatus.textContent = `AI error: ${entry.error}`
    return
  }
  const outcome = entry.outcome as NarrativeOutcome
  if (!outcome.configured) {
    // Config was removed between click and completion — nothing to attach to.
    specAiRow.hidden = true
    specAiStatus.hidden = true
    return
  }
  if (!outcome.ok) {
    showToast(outcome.error)
    specAiStatus.hidden = false
    specAiStatus.textContent = `AI error: ${outcome.error}`
    return
  }
  specAiOverview = outcome.text
  specAiStatus.hidden = false
  specAiStatus.textContent = 'AI overview attached — included in the next export.'
  showToast('AI overview added')
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
  // Reflect the newly-configured (or newly-cleared) endpoint on the Spec tab
  // immediately, without requiring a re-discovery.
  void updateSpecAiButton()
}

/* ---------- Generate (plan of artifacts) ---------- */

const genRun = el<HTMLButtonElement>('gen-run')
const genSpinner = el('gen-spinner')
const genStatus = el('gen-status')
const genList = el('gen-list')
const genRequirement = el<HTMLTextAreaElement>('gen-requirement')

/**
 * Every column name that exists on a table, INCLUDING fields inherited from
 * parent tables (e.g. incident inherits task's fields). The `name=<table>`
 * dictionary query only returns fields declared directly on the table, so a
 * custom field added on `task` would be missed and re-proposed. A real record
 * row from the Table API exposes ALL columns, so we union the two.
 */
async function getAllFieldNames(host: string, table: string, sysId?: string | null): Promise<string[]> {
  const names = new Set<string>()
  const dict = await getDictionary(host, table)
  if (dict.ok) {
    for (const d of dict.data) {
      const e = cellValue(d.element as unknown)
      if (e) names.add(e)
    }
  }
  let rec: Record<string, unknown> | undefined
  if (sysId) {
    const r = await getRecord(host, table, sysId)
    if (r.ok) rec = r.data
  }
  if (!rec) {
    const q = await queryRecords(host, table, { limit: 1, displayValue: false })
    if (q.ok && q.data[0]) rec = q.data[0]
  }
  if (rec) for (const k of Object.keys(rec)) names.add(k)
  return [...names]
}

function initGenerate() {
  genRun.addEventListener('click', async () => {
    const requirement = genRequirement.value.trim()
    if (!requirement) {
      genStatus.textContent = 'Describe what you need first.'
      return
    }
    // Send every existing column (incl. inherited) so the AI never re-proposes one.
    let fields: string[] | undefined
    if (current?.table) {
      genStatus.textContent = 'Reading the table schema…'
      fields = await getAllFieldNames(current.host, current.table, current.sysId)
    }
    genKnownFields = new Set((fields ?? []).map((f) => f.toLowerCase()).filter(Boolean))
    const started = await startLlmJob('generate', {
      requirement,
      table: current?.table ?? undefined,
      sysId: current?.sysId ?? undefined,
      fields,
      scope: scopeLabel(),
    })
    if (!started) {
      genStatus.textContent = 'Open a ServiceNow tab first.'
      return
    }
    applyGenerateJob({ status: 'running', op: 'generate', startedAt: Date.now() })
  })
}

/** Render the Generate plan from a job entry (running / done / error). */
async function applyGenerateJob(entry: LlmJobEntry | undefined) {
  if (!entry) return
  if (entry.status === 'running') {
    // Stale (or timestamp-less) running entry: the background worker was killed
    // mid-fetch, so no done/error will ever arrive — surface it as retryable.
    if (isStaleJob(entry)) {
      genSpinner.hidden = true
      genRun.disabled = false
      genStatus.textContent = "The previous plan didn't finish (the background worker was interrupted). Run it again."
      return
    }
    genSpinner.hidden = false
    genRun.disabled = true
    genStatus.textContent = 'Planning artifacts… (keeps running if you close this panel)'
    return
  }
  genSpinner.hidden = true
  genRun.disabled = false
  if (entry.status === 'error') {
    genStatus.textContent = `AI error: ${entry.error}`
    return
  }
  const outcome = entry.outcome as PlanOutcome
  if (!outcome.configured) {
    genStatus.textContent = 'AI not configured — open Settings and add an endpoint + key.'
    activateTab('tab-settings')
    return
  }
  if (!outcome.ok) {
    genStatus.textContent = `AI error: ${outcome.error}`
    return
  }
  // On a restored job the in-memory known-fields set is empty; refetch so the
  // "already exists" filter still works after the panel was reopened.
  if (!genKnownFields.size && current?.table) {
    const names = await getAllFieldNames(current.host, current.table, current.sysId)
    genKnownFields = new Set(names.map((f) => f.toLowerCase()).filter(Boolean))
  }
  renderPlan(outcome.result.summary, outcome.result.artifacts)
}

/** Tables whose creation would spin up a new scope/app/update set — never allowed. */
const SCOPE_CREATING_TABLES = new Set([
  'sys_scope',
  'sys_app',
  'sys_store_app',
  'sys_remote_update_set',
  'sys_update_set',
])

/** Record fields that would place a record in a different/new scope — stripped on create. */
const SCOPE_FIELDS = new Set(['sys_scope', 'sys_package', 'sys_scope.name', 'sys_policy'])

/** An artifact that would create a new scope/app instead of using the selected one. */
function createsScope(a: PlanArtifact): boolean {
  return a.action === 'create' && !!a.targetTable && SCOPE_CREATING_TABLES.has(a.targetTable)
}

/** Drop any scope/app-defining fields so the record lands in the selected scope only. */
function stripScopeFields(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (!SCOPE_FIELDS.has(k)) out[k] = v
  }
  return out
}

/**
 * A create-a-field artifact whose target column already exists on the table.
 * Matches scope-prefixed proposals too (e.g. u_x / x_app_x for an existing "x").
 */
function fieldAlreadyExists(a: PlanArtifact): boolean {
  if (a.action !== 'create' || a.targetTable !== 'sys_dictionary' || !a.fields) return false
  // The AI may key the column name as element / column_name, or only spell it in
  // the title (e.g. "AI Resolution Plan (ai_resolution_plan)"). Check all.
  const cands = [a.fields['element'], a.fields['column_name']]
  const paren = a.title.match(/\(([a-z0-9_.]+)\)/i)
  if (paren) cands.push(paren[1])
  for (const raw of cands) {
    const el = (raw ?? '').toLowerCase().trim()
    if (!el) continue
    for (const k of genKnownFields) {
      if (el === k || el.endsWith('_' + k) || k.endsWith('_' + el)) return true
    }
  }
  return false
}

function renderPlan(summary: string, artifacts: PlanArtifact[]) {
  genList.replaceChildren()
  if (artifacts.length === 0) {
    genStatus.textContent = summary || 'No artifacts proposed.'
    genList.append(elText('div', 'empty', 'No artifacts proposed.'))
    return
  }

  // Drop fields that already exist and any artifact that would create a new scope.
  const skipped = artifacts.filter(fieldAlreadyExists)
  const scopeAttempts = artifacts.filter(createsScope)
  const shown = artifacts.filter((a) => !fieldAlreadyExists(a) && !createsScope(a))
  genStatus.textContent = summary || `${shown.length} artifact(s) proposed.`

  if (skipped.length) {
    const names = skipped.map((a) => a.fields?.['element'] || a.title).join(', ')
    const note = elText('div', 'info-sub', `Skipped ${skipped.length} field(s) that already exist on ${current?.table ?? 'the table'}: ${names}`)
    note.style.marginBottom = '6px'
    genList.append(note)
  }
  if (scopeAttempts.length) {
    const note = elText('div', 'info-sub', `Ignored ${scopeAttempts.length} artifact(s) that would create a new scope/app — records use the scope selected above (${scopeLabel()}).`)
    note.style.marginBottom = '6px'
    genList.append(note)
  }
  if (shown.length === 0) {
    genList.append(elText('div', 'empty', 'Nothing new to create.'))
    return
  }

  // "Create all" acts on the creatable artifacts.
  const creatable = shown.filter((a) => a.action === 'create' && a.targetTable && a.fields)
  if (creatable.length > 1) {
    const bar = document.createElement('div')
    bar.className = 'btn-row'
    bar.style.margin = '2px 0 8px'
    const all = document.createElement('button')
    all.className = 'btn'
    all.textContent = `Create all (${creatable.length})`
    all.addEventListener('click', () => void createAllArtifacts(creatable, all))
    bar.append(all)
    genList.append(bar)
  }

  for (const a of shown) {
    const row = document.createElement('div')
    row.className = 'info-row'
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'info-name'
    name.textContent = a.title
    name.title = 'View details'
    name.style.maxWidth = '60%'
    name.addEventListener('click', () => showArtifact(a))
    const meta = document.createElement('span')
    meta.className = 'info-meta'
    meta.append(elText('span', 'ref', a.kind))
    meta.append(elText('span', 'info-sub', a.action === 'create' ? (a.targetTable ?? 'create') : 'script'))
    row.append(name, meta)
    genList.append(row)
  }
}

/** Create several artifacts back-to-back, reporting progress in genStatus. */
async function createAllArtifacts(list: PlanArtifact[], btn: HTMLButtonElement) {
  if (!current) return
  // Pin the target host before the confirm dialog so a tab switch can't retarget.
  const host = current.host
  const tgt = await checkTarget()
  if (!tgt) return
  if (
    !(await confirmDialog(
      `Create ${list.length} artifact(s) on ${host}?\n\nScope "${tgt.scopeLabel}"${
        tgt.usLabel ? `, update set "${tgt.usLabel}"` : ''
      }.`,
    ))
  ) {
    return
  }
  btn.disabled = true
  let ok = 0
  for (let i = 0; i < list.length; i++) {
    genStatus.textContent = `Creating ${i + 1}/${list.length}: ${list[i].title}…`
    const res = await createArtifactCore(list[i], host, tgt.opts)
    if (res.ok) ok++
    else showToast(`Failed: ${list[i].title.slice(0, 40)} — ${res.error?.slice(0, 40) ?? ''}`)
  }
  btn.disabled = false
  genStatus.textContent = `Created ${ok}/${list.length} artifact(s).`
  showToast(ok === list.length ? `Created all ${ok} ✓` : `Created ${ok}/${list.length}`)
}

/** Detail modal for one planned artifact, with a create / open action. */
function showArtifact(a: PlanArtifact) {
  const { overlay, box } = makeModal({ wide: true, onOutsideClick: (o) => o.remove() })
  box.append(elText('div', 'diff-head', ''))
  ;(box.firstChild as HTMLElement).append(
    elText('span', 'title', `${a.kind}: ${a.title}`),
    elText('span', 'info-sub', a.action === 'create' ? `→ ${a.targetTable ?? '?'}` : 'background script'),
  )
  if (a.notes) box.append(elText('p', 'ai-note', a.notes))
  const exists = fieldAlreadyExists(a)
  if (exists) {
    const w = elText('p', 'ai-note', '⚠ A field with this name already exists on the table — creating it again would duplicate it.')
    w.style.color = 'var(--warn, #b26a00)'
    box.append(w)
  }

  const body = document.createElement('div')
  body.className = 'diff-body'
  body.style.padding = '8px'
  if (a.action === 'create' && a.fields) {
    for (const [k, v] of Object.entries(a.fields)) {
      const r = document.createElement('div')
      r.className = 'info-row'
      r.style.background = 'transparent'
      r.append(elText('span', 'info-name', k), elText('span', 'info-sub', v.length > 80 ? v.slice(0, 80) + '…' : v))
      body.append(r)
    }
  } else if (a.script) {
    const pre = document.createElement('pre')
    pre.className = 'code-block'
    pre.textContent = a.script
    body.append(pre)
  }

  const row = document.createElement('div')
  row.className = 'btn-row'
  const close = document.createElement('button')
  close.className = 'btn btn-ghost'
  close.textContent = 'Close'
  close.addEventListener('click', () => overlay.remove())
  const act = document.createElement('button')
  act.className = 'btn'
  if (a.action === 'create') {
    act.textContent = exists ? 'Create anyway' : 'Create in instance'
    act.addEventListener('click', () => void createArtifact(a, act, overlay))
  } else {
    act.textContent = 'Open in Background Scripts'
    act.addEventListener('click', () => {
      if (current?.host && a.script) void openBackgroundScripts(current.host, a.script)
      overlay.remove()
    })
  }
  row.append(close, act)

  box.append(body, row)
  document.body.append(overlay)
}

/** Insert one planned record via a scope-aware background script. No UI. */
async function createArtifactCore(
  a: PlanArtifact,
  host: string,
  opts: { scope?: string; updateSet?: string },
): Promise<{ ok: boolean; sysId?: string; error?: string }> {
  if (!current || !a.targetTable || !a.fields) return { ok: false, error: 'nothing to create' }
  if (createsScope(a)) return { ok: false, error: 'refused: would create a new scope/app' }
  // Never let the plan choose the scope — records go into the scope selected in
  // the header (via sys_scope form field + GlideUpdateSet in the background run).
  const bg = buildRecordInsertScript(a.targetTable, stripScopeFields(a.fields))
  const res = await runBackground(host, bg, opts)
  if (!res.ok) return { ok: false, error: res.error }
  const m = extractBgOutput(res.data).match(/snJava: imported ([0-9a-f]{32})/i)
  return m ? { ok: true, sysId: m[1] } : { ok: false, error: 'no sys_id reported' }
}

/** Create a planned customization record via a background insert (scope-aware). */
async function createArtifact(a: PlanArtifact, btn: HTMLButtonElement, overlay: HTMLElement) {
  if (!current || !a.targetTable || !a.fields) return
  // Pin the target host before the confirm dialog so a tab switch can't retarget.
  const host = current.host
  const tgt = await checkTarget()
  if (!tgt) return
  if (
    !(await confirmDialog(
      `Create this ${a.kind} in ${a.targetTable} on ${host}?\n\nScope "${tgt.scopeLabel}"${
        tgt.usLabel ? `, update set "${tgt.usLabel}"` : ''
      }.`,
    ))
  ) {
    return
  }
  btn.disabled = true
  btn.textContent = 'Creating…'
  const res = await createArtifactCore(a, host, tgt.opts)
  btn.disabled = false
  btn.textContent = 'Create in instance'
  if (res.ok) {
    showToast(`Created ${a.kind} ✓`)
    overlay.remove()
  } else {
    showToast(`Create failed: ${(res.error ?? '').slice(0, 60)}`)
  }
}

/** Load per-tab job state for the current tab and render it (on switch/reopen). */
async function restoreLlmJobs() {
  if (currentTabId == null) return
  const store = await chrome.storage.session.get([
    jobKey(currentTabId, 'review'),
    jobKey(currentTabId, 'generate'),
    jobKey(currentTabId, 'narrative'),
  ])
  applyReviewJob(store[jobKey(currentTabId, 'review')] as LlmJobEntry | undefined)
  applyGenerateJob(store[jobKey(currentTabId, 'generate')] as LlmJobEntry | undefined)
  applyNarrativeJob(store[jobKey(currentTabId, 'narrative')] as LlmJobEntry | undefined)
}

// Background writes job results to storage — reflect changes for the active tab.
chrome.storage.session.onChanged.addListener((changes) => {
  if (currentTabId == null) return
  const rk = jobKey(currentTabId, 'review')
  const gk = jobKey(currentTabId, 'generate')
  const nk = jobKey(currentTabId, 'narrative')
  if (changes[rk]) applyReviewJob(changes[rk].newValue as LlmJobEntry | undefined)
  if (changes[gk]) applyGenerateJob(changes[gk].newValue as LlmJobEntry | undefined)
  if (changes[nk]) applyNarrativeJob(changes[nk].newValue as LlmJobEntry | undefined)
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

  if (context) {
    current = context
    renderContext(context)
  } else {
    renderStatus('No record detected on this page.')
  }
  updateEnabledState()
  // Host-pin safety: if the active tab moved to a different instance (or off
  // ServiceNow), drop the guarded test record so its Delete can never fire
  // against the wrong host. updateGuard() then disables the Delete button.
  if (l3Created && (!current || current.host !== l3Created.host)) l3Created = null
  updateGuard()
  void populateScopeBar()

  // Default the Layer 3 target table to the current data table.
  if (current?.table && !scriptTableInfo(current.table) && !l3Table.value.trim()) {
    l3Table.value = current.table
  }
  // Prefill the picker's table filter with the current data table.
  if (current?.table && !scriptTableInfo(current.table) && !pickerTable.value.trim()) {
    pickerTable.value = current.table
  }
  void refreshXmlControls()
  if (current?.host) void renderUndoControls(current.host)
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
scriptOpen.addEventListener('click', () => {
  if (!loadedScriptRecord) return
  const { host, table, sysId } = loadedScriptRecord
  void chrome.tabs.create({ url: `https://${host}/${table}.do?sys_id=${sysId}` })
})
optimizeFormat.addEventListener('click', () => formatEditor(optimizeEd, optimizeFormat))
optimizeCopy.addEventListener('click', () => copyText(optimizeEd.getValue()))
optimizeUse.addEventListener('click', () => {
  scriptEd.setValue(optimizeEd.getValue())
  showToast('Optimized script moved into the editor')
})
optimizeSave.addEventListener('click', saveOptimizedToRecord)
el<HTMLButtonElement>('optimize-diff').addEventListener('click', () =>
  showDiff(scriptEd.getValue(), optimizeEd.getValue()),
)
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
el<HTMLButtonElement>('us-new').addEventListener('click', createUpdateSet)
el<HTMLButtonElement>('sim-bg').addEventListener('click', () => {
  if (!current?.host) {
    showToast('Open a ServiceNow tab first')
    return
  }
  void openBackgroundScripts(current.host, testerEd.getValue())
})
l3Create.addEventListener('click', createTestRecord)
l3Delete.addEventListener('click', deleteTestRecord)
el<HTMLButtonElement>('l3-fill').addEventListener('click', l3FillFromRecord)
initRunnerMode()
specWalk.addEventListener('click', discoverArtifacts)
specHtmlBtn.addEventListener('click', exportHtml)
specPdfBtn.addEventListener('click', exportPdf)
specDocxBtn.addEventListener('click', exportDocx)
specAiBtn.addEventListener('click', specAiNarrative)

chrome.tabs.onActivated.addListener(detect)
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === 'complete' && tab.active) detect()
})

detect()
