import { describe, it, expect } from 'vitest'
import { classifyInstance, instanceLabel, DEFAULT_PROD_GUARD_CONFIG, parseSubProdPatterns } from './prod-guard'

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

describe('classifyInstance — vanity / custom domains (default-DENY)', () => {
  it('does NOT classify a vanity prod host as sub-prod from its first label', () => {
    // 'dev.acmecorp.com' first label is 'dev' but this is NOT a service-now host.
    // The first-label sub-prod heuristic must not apply → default-DENY.
    const v = classifyInstance('dev.acmecorp.com')
    expect(v.allowed).toBe(false)
    expect(v.classification).toBe('unknown')
  })

  it('blocks a real sub-prod on a vanity domain by default (no auto-allow off-service-now)', () => {
    // 'snow.acmedev.com' — heuristic on the bare first label would mis-handle this;
    // off-service-now hosts are simply default-DENY unless an explicit allow matches.
    const v = classifyInstance('snow.acmedev.com')
    expect(v.allowed).toBe(false)
    expect(v.classification).toBe('unknown')
  })

  it('is case-insensitive about the service-now suffix', () => {
    const v = classifyInstance('acmedev.SERVICE-NOW.COM')
    expect(v.allowed).toBe(true)
    expect(v.classification).toBe('sub-prod')
  })
})

describe('classifyInstance — service-now hosts unchanged', () => {
  it('allows standard sub-prod service-now hosts', () => {
    for (const host of ['mfecplcdemo10.service-now.com', 'acmedev.service-now.com']) {
      const v = classifyInstance(host)
      expect(v.allowed).toBe(true)
      expect(v.classification).toBe('sub-prod')
    }
  })

  it('blocks a genuine prod service-now host with no sub-prod marker', () => {
    const v = classifyInstance('acme.service-now.com')
    expect(v.allowed).toBe(false)
    expect(v.classification).toBe('unknown')
  })

  it('hard-blocks a FORCED_PROD service-now host', () => {
    const v = classifyInstance('acmeprod.service-now.com')
    expect(v.allowed).toBe(false)
    expect(v.classification).toBe('prod')
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

describe('parseSubProdPatterns', () => {
  it('splits on comma/newline, trims, drops empties and invalid regex', () => {
    expect(parseSubProdPatterns('dev, test\nuat ,, sub-?prod')).toEqual(['dev', 'test', 'uat', 'sub-?prod'])
    expect(parseSubProdPatterns('good, [unclosed, qa')).toEqual(['good', 'qa'])
    expect(parseSubProdPatterns('   ')).toEqual([])
  })
})
