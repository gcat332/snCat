/**
 * Prod guard (handoff §2 decision 5 — a HARD block, not a warning).
 *
 * Layer 3 performs REAL writes (create/delete a test record, drive a live form).
 * Those are only permitted when the instance looks like a sub-prod. The posture
 * is default-DENY: if we cannot positively confirm a sub-prod marker, writes are
 * blocked. Patterns are configurable per handoff.
 */

export interface ProdGuardConfig {
  /** Regex source strings (matched case-insensitively) that mark a sub-prod. */
  subProdPatterns: string[]
}

export const DEFAULT_PROD_GUARD_CONFIG: ProdGuardConfig = {
  subProdPatterns: ['dev', 'test', 'uat', 'sandbox', 'staging', 'qa', 'demo', 'sub-?prod', 'training'],
}

export type Classification = 'sub-prod' | 'prod' | 'unknown'

export interface GuardVerdict {
  /** True only when writes are permitted. */
  allowed: boolean
  classification: Classification
  reason: string
  /** The instance label that was evaluated. */
  instance: string
}

/** The instance label = the first DNS label (subdomain). */
export function instanceLabel(host: string): string {
  return host.split('.')[0].toLowerCase()
}

/**
 * 'prod'/'production' that is NOT part of sub-prod / pre-prod / non-prod.
 * A production marker forces a BLOCK even if a sub-prod pattern also matched.
 */
const FORCED_PROD = /(?<!sub)(?<!pre)(?<!non)prod(uction)?/i

/** Parse a comma/newline-separated sub-prod pattern list into valid regex sources. */
export function parseSubProdPatterns(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => {
      try {
        new RegExp(p, 'i')
        return true
      } catch {
        return false
      }
    })
}

export function classifyInstance(
  host: string,
  config: ProdGuardConfig = DEFAULT_PROD_GUARD_CONFIG,
): GuardVerdict {
  const instance = instanceLabel(host)

  // The first-DNS-label sub-prod heuristic is only trustworthy for standard
  // *.service-now.com hosts. On a vanity/custom domain (allowed via
  // optional_host_permissions https://*/*) the first label carries no such
  // meaning — e.g. prod at 'dev.acmecorp.com' would look sub-prod. So for any
  // non-service-now host we default-DENY (unknown) rather than auto-classify.
  if (!/\.service-now\.com$/i.test(host)) {
    return {
      allowed: false,
      classification: 'unknown',
      instance,
      reason: `"${host}" is not a *.service-now.com host — the sub-prod heuristic does not apply; blocked by default (safe).`,
    }
  }

  if (FORCED_PROD.test(instance)) {
    return {
      allowed: false,
      classification: 'prod',
      instance,
      reason: `"${instance}" matches a production marker — Layer 3 is hard-blocked.`,
    }
  }

  const matched = config.subProdPatterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(instance)
    } catch {
      return false
    }
  })

  if (matched) {
    return {
      allowed: true,
      classification: 'sub-prod',
      instance,
      reason: `"${instance}" looks like a sub-prod — Layer 3 real execution is permitted.`,
    }
  }

  return {
    allowed: false,
    classification: 'unknown',
    instance,
    reason: `"${instance}" has no recognized sub-prod marker — blocked by default (safe). Add a pattern to allow it.`,
  }
}
