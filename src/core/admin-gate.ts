/**
 * Admin-role gate for the side panel.
 *
 * IMPORTANT: this is UX, not security. The instance's own ACLs are the real
 * authority and will reject anything the user is not entitled to whether or not
 * this check runs. The gate exists so a non-admin gets one clear message instead
 * of a wall of 403s. Never treat it as an access control, and never move a
 * genuine permission decision behind it.
 *
 * The verdict is deliberately asymmetric. A confirmed non-admin is blocked; a
 * user whose roles we could not READ is allowed through behind a warning,
 * because a detection gap (Next Experience, a frame we cannot inject into) must
 * not brick the extension for someone who is in fact an admin.
 */
import { instanceLabel } from './prod-guard'

export type RoleState = 'admin' | 'not-admin' | 'unknown'

export interface RoleStatus {
  state: RoleState
  userName?: string
  roles?: string[]
}

export interface GateVerdict {
  /**
   * Advisory only — no caller enforces on this. The actual blocking is done by
   * `banner === 'blocked'` matching a CSS selector (see the `applyGate()` call
   * site in sidepanel/main.ts). Keep it consistent with `banner` anyway, so a
   * future caller that DOES read it gets the same answer the CSS gives.
   */
  allowed: boolean
  banner: 'none' | 'blocked' | 'unverified'
  /** Text for the banner; empty when there is no banner. */
  message: string
}

/**
 * `opts.host` is the instance hostname the reading came from. Naming it in the
 * banner matters: while blocked, the scope bar and every panel are hidden, so a
 * user with several instances open in different tabs has no other way to tell
 * WHICH host refused them (spec §5's mock-up includes the `Instance:` line for
 * exactly this reason).
 */
export function evaluateGate(status: RoleStatus, opts: { host?: string } = {}): GateVerdict {
  if (status.state === 'admin') {
    return { allowed: true, banner: 'none', message: '' }
  }
  if (status.state === 'not-admin') {
    // Report what was actually checked, not a guess about what the user "has".
    // hasRole is a single yes/no probe for 'admin' — it is not an enumeration
    // of roles, so an empty `roles` list means "not read", never "has none".
    // Saying "Roles detected: none" would assert a false claim about the
    // user's account; only report a role list when one was actually read.
    const lines = [
      `snJava requires the admin role on this instance.`,
      `Signed in as: ${status.userName || 'unknown'}`,
    ]
    if (opts.host) lines.push(`Instance: ${instanceLabel(opts.host)}`)
    lines.push(`Checked for the "admin" role: not held.`)
    if (status.roles?.length) {
      lines.push(`Roles read from the page: ${status.roles.join(', ')}`)
    }
    // "hidden", not "disabled": blocking is purely visual (a CSS attribute on
    // <body>) and the panel's background REST reads keep running — see
    // applyGate() in sidepanel/main.ts. Claiming the features are "disabled"
    // would imply network quiescence this gate does not deliver.
    lines.push(`All features are hidden.`)
    return {
      allowed: false,
      banner: 'blocked',
      message: lines.join('\n'),
    }
  }
  return {
    allowed: true,
    banner: 'unverified',
    message:
      'Role unverified — snJava could not read your roles on this page. ' +
      'Features are enabled; the instance will still enforce its own ACLs.',
  }
}

/**
 * Normalize a raw g_user reading. `hasAdmin: null` means g_user was absent or
 * threw — not that the user lacks the role.
 */
export function roleStatusFrom(snapshot: {
  hasAdmin: boolean | null
  userName?: string | null
  roles?: string | null
}): RoleStatus {
  const roles = (snapshot.roles ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
  if (snapshot.hasAdmin === null || snapshot.hasAdmin === undefined) {
    return { state: 'unknown', userName: snapshot.userName ?? undefined, roles }
  }
  return {
    state: snapshot.hasAdmin ? 'admin' : 'not-admin',
    userName: snapshot.userName ?? undefined,
    roles,
  }
}
