/**
 * Service worker (broker). MV3 note (handoff §7a): the SW never executes user
 * script — it only opens the side panel and relays messages. Script execution
 * happens in sandboxed iframes hosted by the side panel / runner page.
 */

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
