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

export type RoleState = 'admin' | 'not-admin' | 'unknown'

export interface RoleStatus {
  state: RoleState
  userName?: string
  roles?: string[]
}

export interface GateVerdict {
  allowed: boolean
  banner: 'none' | 'blocked' | 'unverified'
  /** Text for the banner; empty when there is no banner. */
  message: string
}

export function evaluateGate(status: RoleStatus): GateVerdict {
  if (status.state === 'admin') {
    return { allowed: true, banner: 'none', message: '' }
  }
  if (status.state === 'not-admin') {
    const roles = status.roles?.length ? status.roles.join(', ') : 'none'
    return {
      allowed: false,
      banner: 'blocked',
      message:
        `snJava requires the admin role on this instance.\n` +
        `Signed in as: ${status.userName || 'unknown'}\n` +
        `Roles detected: ${roles}\n` +
        `All features are disabled.`,
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
