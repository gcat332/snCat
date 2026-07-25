/**
 * Service worker (broker). MV3 note (handoff §7a): the SW never executes user
 * script — it only opens the side panel and relays messages.
 *
 * It DOES run LLM jobs (Java review / Generate) so an in-flight request survives
 * the side panel being closed — the pending fetch keeps the worker alive. Job
 * state is stored per browser TAB in chrome.storage.session so each tab has its
 * own review/generate result and the panel restores it on reopen / tab switch.
 */
import {
  runGeneratePlan,
  runJavaReview,
  runSpecNarrative,
  testLlmConnection,
  type LlmConfig,
  type NarrativeInput,
  type ReviewInput,
} from '@core/llm'

interface LlmRunMessage {
  kind: 'snjava:llm-run'
  tabId: number
  op: 'review' | 'generate' | 'narrative' | 'test' | 'fixscript'
  payload: ReviewInput & {
    requirement?: string
    table?: string
    sysId?: string
    fields?: string[]
    scope?: string
    rootLabel?: string
    artifacts?: { name: string; type: string; script?: string }[]
  }
}

function jobKey(tabId: number, op: string): string {
  return `llmJob:${tabId}:${op}`
}

// In-memory set of jobKeys with a run currently in flight in THIS worker.
// Two concurrent snjava:llm-run messages for the same tab+op (a double-click, a
// panel retry) would otherwise both run and race to write the final result to
// the same storage key — and a stale earlier run finishing after a fresh retry
// would silently overwrite the newer result. We coalesce instead: while a run
// for a key is in flight, a second request is ignored and the in-flight run's
// result stands. The key is cleared once its run fully settles (see finally).
const inFlight = new Set<string>()

async function runLlmJob(msg: LlmRunMessage): Promise<unknown> {
  const key = jobKey(msg.tabId, msg.op)
  if (inFlight.has(key)) {
    // A run for this tab+op is already active. Coalesce: do not start a second
    // run whose stale result could clobber the in-flight one. Report 'running'
    // so the panel keeps waiting on the existing job's result.
    return { status: 'running', op: msg.op }
  }
  inFlight.add(key)
  try {
    // startedAt lets the panel detect a job that never finished: if this worker
    // is killed mid-fetch (browser/extension update, OS suspend, memory
    // eviction) the done/error write below never happens, so the panel would
    // otherwise spin on 'running' forever. It treats a running entry older than
    // a threshold as failed.
    await setJob(key, { status: 'running', op: msg.op, startedAt: Date.now() })
    let entry: unknown
    try {
      let outcome: unknown
      if (msg.op === 'review') {
        outcome = await runJavaReview(msg.payload)
      } else if (msg.op === 'generate') {
        outcome = await runGeneratePlan(msg.payload.requirement ?? '', {
          table: msg.payload.table,
          sysId: msg.payload.sysId,
          fields: msg.payload.fields,
          scope: msg.payload.scope,
        })
      } else if (msg.op === 'test') {
        outcome = await testLlmConnection(msg.payload as unknown as LlmConfig)
      } else {
        outcome = await runSpecNarrative(msg.payload as NarrativeInput)
      }
      entry = { status: 'done', op: msg.op, outcome }
    } catch (err) {
      entry = { status: 'error', op: msg.op, error: (err as Error).message }
    }
    await setJob(key, entry)
    return entry
  } finally {
    // Clear only after the final write settles, so no second run can begin (and
    // race the final write) until this one is fully persisted.
    inFlight.delete(key)
  }
}

async function setJob(key: string, value: unknown): Promise<void> {
  try {
    await chrome.storage.session.set({ [key]: value })
  } catch (err) {
    // Surface the failure: silently dropping the final done/error write would
    // leave the panel stuck on 'running'. Nothing else can retry this here.
    console.error('[snJava] failed to persist job entry', key, err)
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if ((message as { kind?: string })?.kind === 'snjava:fix-script') {
    // Content scripts can't write chrome.storage.session (TRUSTED_CONTEXTS by
    // default), so the background does it here — this is what makes the script
    // reach the panel (consumeFixScriptRequest fires on the session onChanged).
    const payload = (message as { payload?: unknown }).payload
    void chrome.storage.session.set({ fixScriptRequest: payload }).catch(() => {})
    // Best-effort raise the panel. Chrome may reject sidePanel.open() outside a
    // direct user gesture — fine; the stash above is picked up on next open.
    if (sender.tab?.windowId != null) {
      chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {})
    }
    return undefined
  }
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

// Purge a tab's job entries when it closes. llmJob entries can hold full script
// bodies / plan artifacts; left behind they accumulate in chrome.storage.session
// toward its ~10MB quota. Remove both ops for the closed tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  const keys = [
    jobKey(tabId, 'review'),
    jobKey(tabId, 'generate'),
    jobKey(tabId, 'narrative'),
    jobKey(tabId, 'test'),
  ]
  chrome.storage.session
    .remove(keys)
    .catch((err) => console.error('[snJava] failed to purge job entries for tab', tabId, err))
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
