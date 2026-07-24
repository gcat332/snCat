/**
 * Side panel entry. Asks the active tab's content script for the current
 * ServiceNow PageContext and renders it. This is the M0 acceptance surface:
 * open the panel on a record → see the correct table + sys_id.
 */
import type { PageContext, RuntimeMessage } from '@core/types'

const statusEl = document.getElementById('ctx-status') as HTMLElement
const gridEl = document.getElementById('ctx-grid') as HTMLElement
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

function isServiceNow(url: string | undefined): boolean {
  return !!url && /^https:\/\/[^/]+\.service-now\.com\//.test(url)
}

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
  const viewPill = `<span class="pill">${ctx.view}</span>`
  const uiPill = `<span class="pill warn">${ctx.ui}</span>`
  row('Instance', ctx.host, { mono: true })
  row('Table', ctx.table ?? '—', { mono: true })
  row('sys_id', ctx.sysId ?? '—', { mono: true })
  row('View', viewPill, { html: true })
  row('UI', uiPill, { html: true })
  row('Source', ctx.source)
}

function renderMessage(text: string, cls = 'detecting') {
  gridEl.replaceChildren()
  const dt = document.createElement('dt')
  dt.textContent = 'Status'
  const dd = document.createElement('dd')
  dd.className = cls
  dd.textContent = text
  gridEl.append(dt, dd)
}

async function detect() {
  renderMessage('Detecting…')
  const tab = await getActiveTab()
  if (!tab?.id || !isServiceNow(tab.url)) {
    renderMessage('Open a ServiceNow page to detect context.', 'detecting')
    return
  }
  try {
    const res = (await chrome.tabs.sendMessage(tab.id, {
      kind: 'sncat:get-context',
    } satisfies RuntimeMessage)) as RuntimeMessage | undefined

    if (res?.kind === 'sncat:context' && res.context) {
      renderContext(res.context)
    } else {
      renderMessage('No record detected on this page.', 'detecting')
    }
  } catch {
    renderMessage(
      'Content script not loaded — reload the ServiceNow tab, then Refresh.',
      'error',
    )
  }
}

refreshBtn.addEventListener('click', detect)

// Re-detect when the user switches tabs or navigates.
chrome.tabs.onActivated.addListener(detect)
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === 'complete' && tab.active) detect()
})

void statusEl // referenced for initial markup; replaced on first detect
detect()
