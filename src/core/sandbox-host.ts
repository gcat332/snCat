/**
 * Host-side driver for the Layer 2 sandbox (used by the side panel / runner).
 * Creates a hidden sandboxed iframe, ships a SimulationJob into it, and awaits
 * the trace. Enforces a timeout — a runaway (infinite-loop) script hangs the
 * sandbox thread, so on timeout we tear the frame down to kill it.
 */
import type { SandboxMessage, SimulationJob, SimulationResult } from './trace'

const SANDBOX_URL = 'public/sandbox/index.html'

export class SandboxRunner {
  private frame: HTMLIFrameElement | null = null
  private ready: Promise<void> | null = null
  private counter = 0

  private ensure(): Promise<void> {
    if (this.frame && this.ready) return this.ready

    const frame = document.createElement('iframe')
    frame.src = chrome.runtime.getURL(SANDBOX_URL)
    frame.style.display = 'none'
    frame.setAttribute('aria-hidden', 'true')
    document.body.appendChild(frame)
    this.frame = frame

    this.ready = new Promise<void>((resolve) => {
      const onReady = (ev: MessageEvent) => {
        const data = ev.data as SandboxMessage | undefined
        if (ev.source === frame.contentWindow && data?.kind === 'sncat:sim:ready') {
          window.removeEventListener('message', onReady)
          resolve()
        }
      }
      window.addEventListener('message', onReady)
    })
    return this.ready
  }

  async run(job: SimulationJob, timeoutMs = 4000): Promise<SimulationResult> {
    await this.ensure()
    const frame = this.frame!
    const id = `sim_${++this.counter}`

    return new Promise<SimulationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg)
        this.destroy() // kill the hung script
        reject(
          new Error(
            `Simulation timed out after ${timeoutMs}ms (possible infinite loop). Sandbox was reset.`,
          ),
        )
      }, timeoutMs)

      const onMsg = (ev: MessageEvent) => {
        const data = ev.data as SandboxMessage | undefined
        if (
          ev.source === frame.contentWindow &&
          data?.kind === 'sncat:sim:result' &&
          data.id === id
        ) {
          clearTimeout(timer)
          window.removeEventListener('message', onMsg)
          resolve(data.result)
        }
      }
      window.addEventListener('message', onMsg)
      frame.contentWindow?.postMessage({ kind: 'sncat:sim:run', id, job } satisfies SandboxMessage, '*')
    })
  }

  destroy(): void {
    this.frame?.remove()
    this.frame = null
    this.ready = null
  }
}
