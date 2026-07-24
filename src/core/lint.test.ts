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
