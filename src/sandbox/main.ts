/**
 * Sandbox iframe entry. Lives on an opaque origin (manifest `sandbox` CSP) so
 * `new Function` / eval are permitted here but NOT in the trusted side panel.
 * It has no chrome.* access and talks to the host purely via postMessage.
 */
import { runSimulation } from './engine'
import type { SandboxMessage } from '@core/trace'

window.addEventListener('message', (ev: MessageEvent) => {
  const data = ev.data as SandboxMessage | undefined
  if (data?.kind !== 'sncat:sim:run') return

  const result = runSimulation(data.job)
  const reply: SandboxMessage = { kind: 'sncat:sim:result', id: data.id, result }
  // Reply to whoever asked (opaque origin → targetOrigin must be '*').
  const source = ev.source as Window | null
  source?.postMessage(reply, '*')
})

// Announce readiness to the host.
const ready: SandboxMessage = { kind: 'sncat:sim:ready' }
window.parent.postMessage(ready, '*')
