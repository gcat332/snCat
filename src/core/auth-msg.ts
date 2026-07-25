/**
 * Session-expiry detection + a friendly, actionable message for the panel.
 * Pure (no chrome/DOM). sn-rest returns {ok:false, status:401, error:'…session
 * expired'} on expiry; this turns that into a user-facing prompt.
 */
const SESSION_EXPIRED_RE = /session expired|redirected to login|not authenticated/i

/** True when a REST result reflects an expired/absent ServiceNow session. */
export function isAuthError(status: number, error?: string): boolean {
  if (status === 401) return true
  return !!error && SESSION_EXPIRED_RE.test(error)
}

/** Actionable, SSO-aware message naming the instance host. */
export function authExpiredMessage(host: string): string {
  return (
    `Session expired on ${host}. Open the instance in your browser and sign in, ` +
    `then try this again. (If your organization uses SSO, open a ServiceNow tab ` +
    `and complete sign-in there first.)`
  )
}
