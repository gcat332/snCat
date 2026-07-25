import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  agentHubErrorMessage,
  buildPlanPrompt,
  buildReviewPrompt,
  buildSpecNarrativePrompt,
  extractJson,
  redactScript,
  isAllowedEndpoint,
  runJavaReview,
  runGeneratePlan,
} from './llm'

describe('buildReviewPrompt', () => {
  it('includes the script, table, kind and intent', () => {
    const { system, user } = buildReviewPrompt({
      script: 'current.update();',
      kind: 'business_rule',
      timing: 'before',
      table: 'incident',
      intent: 'set priority',
    })
    expect(system).toContain('ServiceNow')
    expect(user).toContain('current.update();')
    expect(user).toContain('incident')
    expect(user).toContain('Business Rule')
    expect(user).toContain('when: before')
    expect(user).toContain('set priority')
    expect(user).toContain('optimizedScript')
    expect(user).toContain('testScript')
  })
})

describe('buildPlanPrompt', () => {
  it('includes the requirement, table, and asks for an artifacts array', () => {
    const { system, user } = buildPlanPrompt('Add a VIP field and an ACL', {
      table: 'incident',
      fields: ['priority', 'state'],
    })
    expect(system).toContain('ServiceNow')
    expect(user).toContain('Add a VIP field and an ACL')
    expect(user).toContain('incident')
    expect(user).toContain('"artifacts"')
    expect(user).toContain('targetTable')
  })
})

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('parses fenced JSON', () => {
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 })
  })
  it('parses JSON embedded in prose', () => {
    expect(extractJson('Here you go: {"a":3} thanks')).toEqual({ a: 3 })
  })
  it('parses a valid object whose string values and trailing prose both contain braces (T-104)', () => {
    const reply =
      '{"optimizedScript":"function f(){ return {a:1}; }","testScript":"gs.info(\'x\');","notes":["ok"]}' +
      '\n\nHope this helps! :)}'
    expect(extractJson(reply)).toEqual({
      optimizedScript: 'function f(){ return {a:1}; }',
      testScript: "gs.info('x');",
      notes: ['ok'],
    })
  })
  it('throws on non-JSON', () => {
    expect(() => extractJson('no json here')).toThrow()
  })
})

describe('redactScript (T-104 — mask secrets before content leaves the instance)', () => {
  it('masks values assigned to secret-named identifiers/properties', () => {
    const script = [
      'var pw = "hunter2";',
      "var apiKey = 'sk-live-super-secret-value';",
      'var token = "abc.def.ghi";',
      'this.credential = "topsecret";',
    ].join('\n')
    const out = redactScript(script)
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('sk-live-super-secret-value')
    expect(out).not.toContain('abc.def.ghi')
    expect(out).not.toContain('topsecret')
    expect(out).toContain('***REDACTED***')
  })

  it('masks gs.getProperty secret keys and long hardcoded key literals', () => {
    const script = [
      "var k = gs.getProperty('x_myapp.api.key');",
      'var raw = "0123456789abcdef0123456789abcdef0123";',
    ].join('\n')
    const out = redactScript(script)
    expect(out).not.toContain('0123456789abcdef0123456789abcdef0123')
    // the getProperty secret-key argument is masked
    expect(out).toMatch(/getProperty\(\s*['"]\*\*\*REDACTED\*\*\*['"]\s*\)/)
  })

  it('leaves ordinary Glide code, field names and table names intact', () => {
    const script = [
      'var gr = new GlideRecord("incident");',
      'gr.addQuery("active", true);',
      'gr.addQuery("priority", 1);',
      'gr.query();',
      'while (gr.next()) { gs.info(gr.getValue("short_description")); }',
    ].join('\n')
    const out = redactScript(script)
    expect(out).toBe(script)
    expect(out).not.toContain('***REDACTED***')
  })

  it('is applied by buildReviewPrompt (secret never reaches the prompt)', () => {
    const { user } = buildReviewPrompt({
      script: 'var password = "hunter2";\nvar gr = new GlideRecord("incident");',
      kind: 'business_rule',
      timing: 'before',
      table: 'incident',
    })
    expect(user).not.toContain('hunter2')
    expect(user).toContain('***REDACTED***')
    // ordinary code still present
    expect(user).toContain('new GlideRecord("incident")')
  })

  it('is applied by buildPlanPrompt via a script-bearing context/requirement', () => {
    const { user } = buildPlanPrompt('Store this key: var secret = "hunter2";', {
      table: 'incident',
    })
    expect(user).not.toContain('hunter2')
    expect(user).toContain('***REDACTED***')
  })
})

describe('isAllowedEndpoint (T-104 — endpoint allowlist)', () => {
  it('allows only known-good provider hosts over https', () => {
    expect(isAllowedEndpoint('https://api.anthropic.com/v1/messages')).toBe(true)
    expect(isAllowedEndpoint('https://api.openai.com/v1/chat/completions')).toBe(true)
    expect(isAllowedEndpoint('https://dev-agenthub.mfec.co.th/api/browser-ingest')).toBe(true)
  })

  it('rejects random/tampered hosts, http, and garbage', () => {
    expect(isAllowedEndpoint('https://evil.example.com/v1/messages')).toBe(false)
    expect(isAllowedEndpoint('https://api.anthropic.com.evil.com/v1')).toBe(false)
    expect(isAllowedEndpoint('http://api.anthropic.com/v1/messages')).toBe(false)
    expect(isAllowedEndpoint('not a url')).toBe(false)
  })
})

describe('network gate (T-104 — refuse to send to a disallowed endpoint)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runJavaReview refuses without calling fetch when endpoint is not allowlisted', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const out = await runJavaReview(
      { script: 'gs.info(1);', kind: 'business_rule', table: 'incident' },
      { endpoint: 'https://evil.example.com/v1', apiKey: 'k', model: 'm', format: 'anthropic' },
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(out).toMatchObject({ configured: true, ok: false })
  })

  it('runGeneratePlan refuses without calling fetch when endpoint is not allowlisted', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const out = await runGeneratePlan(
      'Add a field',
      { table: 'incident' },
      { endpoint: 'https://evil.example.com/v1', apiKey: 'k', model: 'm', format: 'openai' },
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(out).toMatchObject({ configured: true, ok: false })
  })

  it('allowed endpoint is unaffected — fetch is called and the result flows through', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ text: '{"optimizedScript":"x","testScript":"y","notes":["ok"]}' }] }),
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const out = await runJavaReview(
      { script: 'gs.info(1);', kind: 'business_rule', table: 'incident' },
      { endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'k', model: 'm', format: 'anthropic' },
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ configured: true, ok: true })
  })
})

describe('buildSpecNarrativePrompt', () => {
  it('lists artifacts, redacts scripts, and asks for plain prose', () => {
    const p = buildSpecNarrativePrompt({
      table: 'incident',
      rootLabel: 'Incident',
      artifacts: [{ name: 'Notify BR', type: 'Business Rule', script: 'var pw = "hunter2"; gs.info(pw);' }],
    })
    expect(p.user).toContain('incident')
    expect(p.user).toContain('Notify BR')
    expect(p.user).not.toContain('hunter2')
    expect(p.user).toContain('REDACTED')
    expect(p.system.toLowerCase()).toContain('prose')
  })
})

describe('agentHubErrorMessage', () => {
  it('gives an actionable message when the body is an HTML block page', () => {
    const m = agentHubErrorMessage(403, '<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX"></head></html>')
    expect(m.toLowerCase()).toContain('html page')
    expect(m.toLowerCase()).toContain('token')
    expect(m).toContain('Test connection')
    expect(m).not.toContain('<html')
  })
  it('passes through a plain/JSON error body (truncated)', () => {
    expect(agentHubErrorMessage(500, '{"error":"boom"}')).toBe('AgentHub HTTP 500: {"error":"boom"}')
  })
})
