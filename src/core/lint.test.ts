import { describe, it, expect } from 'vitest'
import { lintScript, stripComments, lineAt, type LintInput } from './lint'

function rules(input: LintInput): string[] {
  return lintScript(input).map((f) => f.rule)
}

describe('stripComments', () => {
  it('removes line and block comments but keeps positions/newlines', () => {
    const src = 'var a = 1; // comment\n/* block */ var b = 2;'
    const out = stripComments(src)
    expect(out).toHaveLength(src.length)
    expect(out.split('\n')).toHaveLength(2)
    expect(out).not.toContain('comment')
    expect(out).not.toContain('block')
    expect(out).toContain('var a = 1;')
  })

  it('does not treat // inside a string as a comment', () => {
    const src = 'var url = "http://x.com"; var y = 2;'
    const out = stripComments(src)
    expect(out).toContain('var y = 2;')
  })
})

describe('lineAt', () => {
  it('reports 1-based lines', () => {
    const t = 'a\nb\nc'
    expect(lineAt(t, 0)).toBe(1)
    expect(lineAt(t, 2)).toBe(2)
    expect(lineAt(t, 4)).toBe(3)
  })
})

describe('lintScript — Business Rule', () => {
  it('flags current.update() in a before BR', () => {
    const found = rules({
      kind: 'business_rule',
      timing: 'before',
      script: 'current.short_description = "x";\ncurrent.update();',
    })
    expect(found).toContain('update-in-before-br')
  })

  it('does NOT flag current.update() in an after BR', () => {
    const found = rules({
      kind: 'business_rule',
      timing: 'after',
      script: 'current.update();',
    })
    expect(found).not.toContain('update-in-before-br')
  })

  it('flags previous.* usage in an async BR', () => {
    const found = rules({
      kind: 'business_rule',
      timing: 'async',
      script: 'if (previous.state != current.state) { gs.info("changed"); }',
    })
    expect(found).toContain('previous-in-async-br')
  })

  it('flags an unconditioned GlideRecord query', () => {
    const found = rules({
      kind: 'business_rule',
      timing: 'after',
      script: 'var gr = new GlideRecord("incident");\ngr.query();\nwhile (gr.next()) {}',
    })
    expect(found).toContain('unconditioned-query')
  })

  it('does NOT flag a filtered GlideRecord query', () => {
    const found = rules({
      kind: 'business_rule',
      timing: 'after',
      script:
        'var gr = new GlideRecord("incident");\ngr.addQuery("active", true);\ngr.query();',
    })
    expect(found).not.toContain('unconditioned-query')
  })

  it('scopes filter detection to the nearest declaration when a var name is reused', () => {
    // gr is re-declared: the first (incident) query IS filtered and must not
    // flag; the second (problem) query is unconditioned and MUST flag once.
    const script = [
      'var gr = new GlideRecord("incident");', // line 1
      'gr.addQuery("active", true);', // line 2
      'gr.query();', // line 3 — filtered, must NOT flag
      'gr = new GlideRecord("problem");', // line 4
      'gr.query();', // line 5 — unconditioned, MUST flag
    ].join('\n')
    const findings = lintScript({ kind: 'business_rule', timing: 'after', script })
    const unconditioned = findings.filter((f) => f.rule === 'unconditioned-query')
    expect(unconditioned).toHaveLength(1)
    expect(unconditioned[0].line).toBe(5)
  })

  it('flags every unconditioned query when a reused var name is never filtered', () => {
    const script = [
      'var gr = new GlideRecord("incident");', // line 1
      'gr.query();', // line 2 — unconditioned
      'gr = new GlideRecord("problem");', // line 3
      'gr.query();', // line 4 — unconditioned
    ].join('\n')
    const findings = lintScript({ kind: 'business_rule', timing: 'after', script })
    const unconditioned = findings.filter((f) => f.rule === 'unconditioned-query')
    expect(unconditioned).toHaveLength(2)
    expect(unconditioned.map((f) => f.line)).toEqual([2, 4])
  })
})

describe('lintScript — Client Script', () => {
  it('flags GlideRecord and gs in a client script', () => {
    const found = rules({
      kind: 'client_script',
      script: 'var gr = new GlideRecord("incident");\ngs.info("hi");',
    })
    expect(found).toContain('gliderecord-in-client-script')
    expect(found).toContain('gs-in-client-script')
  })
})

describe('lintScript — general rules', () => {
  it('flags eval, empty catch, and hardcoded sys_id', () => {
    const script = [
      'eval("1+1");',
      'try { doThing(); } catch (e) {}',
      'var ref = "46e8219fa9fe198100b3e7d8f2f5c3a1";',
    ].join('\n')
    const found = rules({ kind: 'script_include', script })
    expect(found).toContain('eval-usage')
    expect(found).toContain('empty-catch')
    expect(found).toContain('hardcoded-sys-id')
  })

  it('ignores anti-patterns that appear only inside comments', () => {
    const found = rules({
      kind: 'business_rule',
      timing: 'before',
      script: '// current.update() is bad\n/* eval("x") */\nvar ok = 1;',
    })
    expect(found).toHaveLength(0)
  })

  it('returns nothing for an empty script', () => {
    expect(lintScript({ kind: 'unknown', script: '   ' })).toEqual([])
  })

  it('ignores anti-patterns that appear only inside string literals', () => {
    // (a) current.update() only inside a message string in a before BR
    const brFound = rules({
      kind: 'business_rule',
      timing: 'before',
      script:
        'gs.addErrorMessage("Do not call current.update() from a before rule");',
    })
    expect(brFound).not.toContain('update-in-before-br')

    // (b) GlideRecord / gs only inside a message string in a client script
    const csFound = rules({
      kind: 'client_script',
      script:
        'g_form.addInfoMessage("Never do new GlideRecord(\'sys_user\') or gs.info() on the client");',
    })
    expect(csFound).not.toContain('gliderecord-in-client-script')
    expect(csFound).not.toContain('gs-in-client-script')
  })

  it('REGRESSION: still flags a real current.update() call in code', () => {
    const found = rules({
      kind: 'business_rule',
      timing: 'before',
      script: 'gs.addErrorMessage("just a message");\ncurrent.update();',
    })
    expect(found).toContain('update-in-before-br')
  })

  it('REGRESSION: still flags a hardcoded sys_id that lives in a string literal', () => {
    const found = rules({
      kind: 'script_include',
      script: 'var ref = "46e8219fa9fe198100b3e7d8f2f5c3a1";',
    })
    expect(found).toContain('hardcoded-sys-id')
  })

  it('sorts errors before warnings before info', () => {
    const findings = lintScript({
      kind: 'client_script',
      script: 'var gr = new GlideRecord("x");\neval("1");',
    })
    const severities = findings.map((f) => f.severity)
    const firstWarning = severities.indexOf('warning')
    const firstError = severities.indexOf('error')
    expect(firstError).toBeLessThan(firstWarning)
  })
})
