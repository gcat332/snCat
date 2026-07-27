import { describe, it, expect } from 'vitest'
import { evaluateGate, roleStatusFrom } from './admin-gate'

describe('evaluateGate', () => {
  it('allows an admin with no banner', () => {
    expect(evaluateGate({ state: 'admin', userName: 'admin' })).toEqual({
      allowed: true,
      banner: 'none',
      message: '',
    })
  })

  it('blocks a non-admin', () => {
    const v = evaluateGate({ state: 'not-admin', userName: 'j.somchai', roles: ['itil'] })
    expect(v.allowed).toBe(false)
    expect(v.banner).toBe('blocked')
    expect(v.message).toContain('admin role')
  })

  it('names the user and roles in the blocked message', () => {
    const v = evaluateGate({ state: 'not-admin', userName: 'j.somchai', roles: ['itil', 'catalog_admin'] })
    expect(v.message).toContain('j.somchai')
    expect(v.message).toContain('itil, catalog_admin')
  })

  it('says so when a blocked user has no roles at all', () => {
    const v = evaluateGate({ state: 'not-admin', userName: 'guest', roles: [] })
    expect(v.message).toContain('none')
  })

  it('fails OPEN on unknown, with a warning banner', () => {
    const v = evaluateGate({ state: 'unknown' })
    expect(v.allowed).toBe(true)
    expect(v.banner).toBe('unverified')
    expect(v.message).toContain('ACLs')
  })
})

describe('roleStatusFrom', () => {
  it('maps hasAdmin true to admin', () => {
    expect(roleStatusFrom({ hasAdmin: true, userName: 'admin' }).state).toBe('admin')
  })

  it('maps hasAdmin false to not-admin', () => {
    expect(roleStatusFrom({ hasAdmin: false, userName: 'x' }).state).toBe('not-admin')
  })

  it('maps a null hasAdmin to unknown — g_user was unavailable', () => {
    expect(roleStatusFrom({ hasAdmin: null }).state).toBe('unknown')
  })

  it('splits the comma-separated role string', () => {
    expect(roleStatusFrom({ hasAdmin: false, roles: 'itil, catalog_admin ,,' }).roles).toEqual([
      'itil',
      'catalog_admin',
    ])
  })

  it('tolerates a missing role string', () => {
    expect(roleStatusFrom({ hasAdmin: false }).roles).toEqual([])
  })
})
