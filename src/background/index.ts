/**
 * Service worker (broker). MV3 note (handoff §7a): the SW never executes user
 * script — it only opens the side panel and relays messages. Script execution
 * happens in sandboxed iframes hosted by the side panel / runner page.
 */
import type { RuntimeMessage } from '@core/types'
import { handleApiRequest } from './api'

// Open the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[snCat] setPanelBehavior failed', err))
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

// REST broker: the side panel asks the background to perform authenticated
// ServiceNow API calls (background has host_permissions + session cookies).
chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.kind === 'sncat:api') {
    handleApiRequest(message.request)
      .then(sendResponse)
      .catch((err: unknown) =>
        sendResponse({ ok: false, status: 0, error: (err as Error).message }),
      )
    return true // async response
  }
  return undefined
})
