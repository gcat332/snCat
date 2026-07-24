/**
 * Service worker (broker). MV3 note (handoff §7a): the SW never executes user
 * script — it only opens the side panel and relays messages.
 *
 * It DOES run LLM jobs (Java review / Generate) so an in-flight request survives
 * the side panel being closed — the pending fetch keeps the worker alive. Job
 * state is stored per browser TAB in chrome.storage.session so each tab has its
 * own review/generate result and the panel restores it on reopen / tab switch.
 */
import { runGeneratePlan, runJavaReview, type ReviewInput } from '@core/llm'

interface LlmRunMessage {
  kind: 'snjava:llm-run'
  tabId: number
  op: 'review' | 'generate'
  payload: ReviewInput & { requirement?: string; table?: string; sysId?: string; fields?: string[] }
}

function jobKey(tabId: number, op: string): string {
  return `llmJob:${tabId}:${op}`
}

async function runLlmJob(msg: LlmRunMessage): Promise<unknown> {
  const key = jobKey(msg.tabId, msg.op)
  await setJob(key, { status: 'running', op: msg.op })
  let entry: unknown
  try {
    const outcome =
      msg.op === 'review'
        ? await runJavaReview(msg.payload)
        : await runGeneratePlan(msg.payload.requirement ?? '', {
            table: msg.payload.table,
            sysId: msg.payload.sysId,
            fields: msg.payload.fields,
          })
    entry = { status: 'done', op: msg.op, outcome }
  } catch (err) {
    entry = { status: 'error', op: msg.op, error: (err as Error).message }
  }
  await setJob(key, entry)
  return entry
}

async function setJob(key: string, value: unknown): Promise<void> {
  try {
    await chrome.storage.session.set({ [key]: value })
  } catch {
    /* session storage may be unavailable in some contexts — ignore */
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as { kind?: string })?.kind === 'snjava:llm-run') {
    // Run the job (the in-flight fetch keeps the SW alive) and reply directly so
    // the panel updates even if storage events don't reach it. If the panel has
    // closed, sendResponse throws harmlessly and the result is still in storage.
    runLlmJob(message as LlmRunMessage)
      .then((entry) => {
        try {
          sendResponse(entry)
        } catch {
          /* panel gone */
        }
      })
      .catch((err) => {
        try {
          sendResponse({ status: 'error', op: (message as LlmRunMessage).op, error: String(err) })
        } catch {
          /* panel gone */
        }
      })
    return true // keep the channel open for the async response
  }
  return undefined
})

// Open the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[snJava] setPanelBehavior failed', err))
})

// Also handle the click explicitly for browsers/timing where the behavior flag
// hasn't taken effect yet.
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {
      /* panel may already be open */
    })
  }
})

// Note: ServiceNow REST calls are executed by the content script (page origin)
// so the session cookie is sent — see core/sn-rest.ts and content/index.ts.
