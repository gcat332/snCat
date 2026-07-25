import { describe, it, expect } from 'vitest'
import { isAuthError, authExpiredMessage } from './auth-msg'

describe('isAuthError', () => {
  it('is true for HTTP 401', () => {
    expect(isAuthError(401)).toBe(true)
  })
  it('is true when the error text signals an expired/absent session', () => {
    expect(isAuthError(0, 'Redirected to login — session expired.')).toBe(true)
    expect(isAuthError(500, 'Not authenticated — log in to the instance.')).toBe(true)
  })
  it('is false for non-auth failures', () => {
    expect(isAuthError(403, 'Forbidden')).toBe(false)
    expect(isAuthError(404, 'Not found')).toBe(false)
    expect(isAuthError(500, 'Internal error')).toBe(false)
    expect(isAuthError(0, 'Network error: timeout')).toBe(false)
    expect(isAuthError(0)).toBe(false)
  })
})

describe('authExpiredMessage', () => {
  it('names the host and includes an SSO hint', () => {
    const m = authExpiredMessage('dev.service-now.com')
    expect(m).toContain('dev.service-now.com')
    expect(m.toLowerCase()).toContain('sign in')
    expect(m.toUpperCase()).toContain('SSO')
  })
})
