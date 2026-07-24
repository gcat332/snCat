/**
 * Script Tester — Layer 1 static analysis (handoff §4, LLM-free).
 *
 * Pure, deterministic anti-pattern lints for ServiceNow server/client scripts.
 * No instance and no LLM required — this is the "zero instance risk" layer.
 * The AI "logic vs. intent" review (§4 Layer 1) is deferred to the pluggable
 * LLM provider; intent text is captured now but not yet evaluated.
 */

export type ScriptKind =
  | 'business_rule'
  | 'client_script'
  | 'script_include'
  | 'unknown'

/** Business Rule timing (from the `when` field). */
export type BrTiming = 'before' | 'after' | 'async' | 'display'

export type Severity = 'error' | 'warning' | 'info'

export interface LintFinding {
  rule: string
  severity: Severity
  line: number
  message: string
  snippet: string
}

export interface LintInput {
  script: string
  kind: ScriptKind
  /** Only meaningful for business rules. */
  timing?: BrTiming
}

/** 1-based line number for a character index in text. */
export function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

/** The (trimmed) source line at a 1-based line number. */
function lineText(text: string, line: number): string {
  return (text.split('\n')[line - 1] ?? '').trim()
}

/**
 * Replace comment bodies with spaces while preserving byte positions and
 * newlines, so line/column math stays accurate and lints don't fire inside
 * comments. String literals are tracked so `//` inside a string is not treated
 * as a comment. (Escapes inside strings are handled; template expressions are
 * not — acceptable for Layer 1.)
 */
export function stripComments(src: string): string {
  const out = src.split('')
  let i = 0
  const n = src.length
  type Mode = 'code' | 'line' | 'block' | 'squote' | 'dquote' | 'tquote'
  let mode: Mode = 'code'

  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && c2 === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        mode = 'line'
        continue
      }
      if (c === '/' && c2 === '*') {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        mode = 'block'
        continue
      }
      if (c === "'") mode = 'squote'
      else if (c === '"') mode = 'dquote'
      else if (c === '`') mode = 'tquote'
      i++
    } else if (mode === 'line') {
      if (c === '\n') mode = 'code'
      else out[i] = ' '
      i++
    } else if (mode === 'block') {
      if (c === '*' && c2 === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        mode = 'code'
        continue
      }
      if (c !== '\n') out[i] = ' '
      i++
    } else {
      // inside a string literal: honor escapes, watch for the closing quote
      if (c === '\\') {
        i += 2
        continue
      }
      if (
        (mode === 'squote' && c === "'") ||
        (mode === 'dquote' && c === '"') ||
        (mode === 'tquote' && c === '`')
      ) {
        mode = 'code'
      }
      i++
    }
  }
  return out.join('')
}

type Rule = (input: LintInput, code: string) => LintFinding[]

function finding(
  input: LintInput,
  code: string,
  index: number,
  rule: string,
  severity: Severity,
  message: string,
): LintFinding {
  const line = lineAt(code, index)
  return { rule, severity, line, message, snippet: lineText(input.script, line) }
}

/** current.update() inside a before Business Rule. */
const ruleUpdateInBefore: Rule = (input, code) => {
  if (input.kind !== 'business_rule' || input.timing !== 'before') return []
  const findings: LintFinding[] = []
  const re = /\bcurrent\.update\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    findings.push(
      finding(
        input,
        code,
        m.index,
        'update-in-before-br',
        'error',
        'current.update() in a "before" Business Rule causes a redundant/recursive write — before rules are saved automatically. Remove it.',
      ),
    )
  }
  return findings
}

/** GlideRecord used in a Client Script (server-side API on the client). */
const ruleGlideRecordInClient: Rule = (input, code) => {
  if (input.kind !== 'client_script') return []
  const findings: LintFinding[] = []
  const re = /\bnew\s+GlideRecord\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    findings.push(
      finding(
        input,
        code,
        m.index,
        'gliderecord-in-client-script',
        'error',
        'GlideRecord is server-side. In a Client Script use GlideAjax, getReference(), or a REST call instead.',
      ),
    )
  }
  return findings
}

/** gs.* used in a Client Script. */
const ruleGsInClient: Rule = (input, code) => {
  if (input.kind !== 'client_script') return []
  const findings: LintFinding[] = []
  const re = /\bgs\.\w+\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    findings.push(
      finding(
        input,
        code,
        m.index,
        'gs-in-client-script',
        'warning',
        'gs (GlideSystem) is server-side and is undefined in Client Scripts. Use g_form / g_user / g_scratchpad.',
      ),
    )
  }
  return findings
}

/** previous referenced in an async Business Rule (not reliably available). */
const rulePreviousInAsync: Rule = (input, code) => {
  if (input.kind !== 'business_rule' || input.timing !== 'async') return []
  const findings: LintFinding[] = []
  const re = /\bprevious\.\w+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    findings.push(
      finding(
        input,
        code,
        m.index,
        'previous-in-async-br',
        'warning',
        '`previous` is not reliably populated in async Business Rules — the record may have changed since the event. Capture needed values in a sync rule.',
      ),
    )
    break // one is enough to flag the pattern
  }
  return findings
}

/** GlideRecord .query() with no addQuery/addEncodedQuery/get first (per var). */
const ruleUnconditionedQuery: Rule = (input, code) => {
  if (input.kind === 'client_script') return [] // handled by the client rule
  const findings: LintFinding[] = []
  const declRe = /\b(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*new\s+GlideRecord\s*\(/g
  let d: RegExpExecArray | null
  while ((d = declRe.exec(code))) {
    const varName = d[1]
    const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const queryRe = new RegExp(`\\b${esc}\\.query\\s*\\(`, 'g')
    let q: RegExpExecArray | null
    while ((q = queryRe.exec(code))) {
      const between = code.slice(d.index, q.index)
      const hasFilter = new RegExp(
        `\\b${esc}\\.(addQuery|addEncodedQuery|addActiveQuery|addNullQuery|addNotNullQuery|get|addJoinQuery)\\s*\\(`,
      ).test(between)
      if (!hasFilter) {
        findings.push(
          finding(
            input,
            code,
            q.index,
            'unconditioned-query',
            'warning',
            `GlideRecord "${varName}" runs query() with no addQuery/addEncodedQuery filter — this reads the entire table. Add a condition or use setLimit().`,
          ),
        )
      }
    }
  }
  return findings
}

/** eval() usage. */
const ruleEval: Rule = (input, code) => {
  const findings: LintFinding[] = []
  const re = /\beval\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    findings.push(
      finding(
        input,
        code,
        m.index,
        'eval-usage',
        'warning',
        'eval() is a security and performance risk. Avoid it; parse/branch explicitly instead.',
      ),
    )
  }
  return findings
}

/** Empty catch blocks that swallow errors. */
const ruleEmptyCatch: Rule = (input, code) => {
  const findings: LintFinding[] = []
  const re = /catch\s*\([^)]*\)\s*\{\s*\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    findings.push(
      finding(
        input,
        code,
        m.index,
        'empty-catch',
        'info',
        'Empty catch block swallows errors silently. Log with gs.error() or handle the failure.',
      ),
    )
  }
  return findings
}

/** Hardcoded sys_id string literals. */
const ruleHardcodedSysId: Rule = (input, code) => {
  const findings: LintFinding[] = []
  const re = /['"]([0-9a-f]{32})['"]/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    findings.push(
      finding(
        input,
        code,
        m.index,
        'hardcoded-sys-id',
        'info',
        `Hardcoded sys_id "${m[1].slice(0, 8)}…" is instance-specific. Move it to a System Property or look it up by a stable key.`,
      ),
    )
  }
  return findings
}

const RULES: Rule[] = [
  ruleUpdateInBefore,
  ruleGlideRecordInClient,
  ruleGsInClient,
  rulePreviousInAsync,
  ruleUnconditionedQuery,
  ruleEval,
  ruleEmptyCatch,
  ruleHardcodedSysId,
]

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** Run all Layer 1 lints against a script. Findings sorted by severity, then line. */
export function lintScript(input: LintInput): LintFinding[] {
  if (!input.script.trim()) return []
  const code = stripComments(input.script)
  const findings = RULES.flatMap((rule) => rule(input, code))
  return findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line,
  )
}
