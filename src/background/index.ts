/**
 * Service worker (broker). MV3 note (handoff §7a): the SW never executes user
 * script — it only opens the side panel and relays messages.
 *
 * It DOES run LLM jobs (Java review / Generate) so an in-flight request survives
 * the side panel being closed — the pending fetch keeps the worker alive. Job
 * state is stored per browser TAB in chrome.storage.session so each tab has its
 * own review/generate result and the panel restores it on reopen / tab switch.
 */
import { runGenerateScript, runJavaReview, type ReviewInput } from '@core/llm'

interface LlmRunMessage {
  kind: 'snjava:llm-run'
  tabId: number
  op: 'review' | 'generate'
  payload: ReviewInput & { requirement?: string; table?: string }
}

function jobKey(tabId: number, op: string): string {
  return `llmJob:${tabId}:${op}`
}

async function runLlmJob(msg: LlmRunMessage): Promise<void> {
  const key = jobKey(msg.tabId, msg.op)
  await chrome.storage.session.set({ [key]: { status: 'running', op: msg.op } })
  let entry: unknown
  try {
    const outcome =
      msg.op === 'review'
        ? await runJavaReview(msg.payload)
        : await runGenerateScript(msg.payload.requirement ?? '', msg.payload.table)
    entry = { status: 'done', op: msg.op, outcome }
  } catch (err) {
    entry = { status: 'error', op: msg.op, error: (err as Error).message }
  }
  await chrome.storage.session.set({ [key]: entry })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as { kind?: string })?.kind === 'snjava:llm-run') {
    // Ack immediately; the in-flight fetch inside runLlmJob keeps the SW alive.
    void runLlmJob(message as LlmRunMessage)
    sendResponse({ ok: true })
    return true
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
