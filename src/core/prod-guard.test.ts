import { describe, it, expect } from 'vitest'
import { classifyInstance, instanceLabel, DEFAULT_PROD_GUARD_CONFIG } from './prod-guard'

const sn = (label: string) => `${label}.service-now.com`

describe('instanceLabel', () => {
  it('takes the first DNS label', () => {
    expect(instanceLabel('mfecplcdemo10.service-now.com')).toBe('mfecplcdemo10')
  })
})

describe('classifyInstance — allowed sub-prods', () => {
  for (const label of ['mfecplcdemo10', 'dev12345', 'acmetest', 'company-uat', 'sandbox01', 'qa2', 'staging']) {
    it(`allows ${label}`, () => {
      const v = classifyInstance(sn(label))
      expect(v.allowed).toBe(true)
      expect(v.classification).toBe('sub-prod')
    })
  }
})

describe('classifyInstance — blocked prod / unknown', () => {
  it('blocks an explicit production instance', () => {
    const v = classifyInstance(sn('acmeprod'))
    expect(v.allowed).toBe(false)
    expect(v.classification).toBe('prod')
  })

  it('blocks "production"', () => {
    expect(classifyInstance(sn('companyproduction')).allowed).toBe(false)
  })

  it('blocks an unmarked instance by default (safe)', () => {
    const v = classifyInstance(sn('acmecorp'))
    expect(v.allowed).toBe(false)
    expect(v.classification).toBe('unknown')
  })

  it('blocks even when a sub-prod marker AND a prod marker are both present', () => {
    // "testprod" contains 'test' (sub) and 'prod' (forced) → forced prod wins.
    const v = classifyInstance(sn('testprod'))
    expect(v.allowed).toBe(false)
    expect(v.classification).toBe('prod')
  })

  it('does NOT treat sub-prod / pre-prod / non-prod as production', () => {
    expect(classifyInstance(sn('subprod')).allowed).toBe(true) // sub-prod marker
    // preprod/nonprod: not forced-prod, but also no sub-prod marker → blocked as unknown (safe)
    expect(classifyInstance(sn('preprod')).classification).not.toBe('prod')
  })
})

describe('config', () => {
  it('respects a custom sub-prod pattern', () => {
    const v = classifyInstance(sn('acmelab'), { subProdPatterns: ['lab'] })
    expect(v.allowed).toBe(true)
  })

  it('default config includes demo (our dev instance marker)', () => {
    expect(DEFAULT_PROD_GUARD_CONFIG.subProdPatterns).toContain('demo')
  })
})
