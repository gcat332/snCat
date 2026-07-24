import { describe, it, expect } from 'vitest'
import { parseServiceNowContext } from './context'

const HOST = 'mfecplcdemo10.service-now.com'
const SID = '46e8219fa9fe198100b3e7d8f2f5c3a1' // valid 32-hex
const SID2 = 'a9e30c7a0a0a0b3400c1a2b3c4d5e6f7'

describe('parseServiceNowContext — classic UI', () => {
  it('parses a classic form URL', () => {
    const ctx = parseServiceNowContext(`https://${HOST}/incident.do?sys_id=${SID}`)
    expect(ctx).toMatchObject({
      host: HOST,
      table: 'incident',
      sysId: SID,
      view: 'form',
      ui: 'classic',
      source: 'url',
    })
  })

  it('parses a classic list URL', () => {
    const ctx = parseServiceNowContext(`https://${HOST}/incident_list.do?sysparm_query=active=true`)
    expect(ctx).toMatchObject({ table: 'incident', sysId: null, view: 'list', ui: 'classic' })
  })

  it('parses a script-include-ish classic table', () => {
    const ctx = parseServiceNowContext(`https://${HOST}/sys_script_include.do?sys_id=${SID}`)
    expect(ctx).toMatchObject({ table: 'sys_script_include', sysId: SID, view: 'form' })
  })

  it('treats a new record (sys_id=-1) as a form with no sysId', () => {
    const ctx = parseServiceNowContext(`https://${HOST}/incident.do?sys_id=-1`)
    expect(ctx).toMatchObject({ table: 'incident', sysId: null, view: 'form' })
  })

  it('unwraps nav_to.do?uri=', () => {
    const inner = encodeURIComponent(`incident.do?sys_id=${SID}`)
    const ctx = parseServiceNowContext(`https://${HOST}/nav_to.do?uri=${inner}`)
    expect(ctx).toMatchObject({ table: 'incident', sysId: SID, view: 'form', ui: 'classic' })
  })

  it('rejects a bogus sys_id (not 32-hex)', () => {
    const ctx = parseServiceNowContext(`https://${HOST}/incident.do?sys_id=not-a-real-id`)
    expect(ctx?.sysId).toBeNull()
  })
})

describe('parseServiceNowContext — Polaris / Next Experience', () => {
  it('unwraps /now/nav/ui/classic/params/target/', () => {
    const target = encodeURIComponent(`sys_script.do?sys_id=${SID}`)
    const ctx = parseServiceNowContext(
      `https://${HOST}/now/nav/ui/classic/params/target/${target}`,
    )
    expect(ctx).toMatchObject({ table: 'sys_script', sysId: SID, view: 'form', ui: 'polaris' })
  })

  it('handles a double-encoded classic target', () => {
    const once = encodeURIComponent(`incident.do?sys_id=${SID}`)
    const twice = encodeURIComponent(once)
    const ctx = parseServiceNowContext(
      `https://${HOST}/now/nav/ui/classic/params/target/${twice}`,
    )
    expect(ctx).toMatchObject({ table: 'incident', sysId: SID, ui: 'polaris' })
  })

  it('parses a workspace record route', () => {
    const ctx = parseServiceNowContext(
      `https://${HOST}/now/sow/record/incident/${SID2}/params/query/foo`,
    )
    expect(ctx).toMatchObject({ table: 'incident', sysId: SID2, view: 'form', ui: 'workspace' })
  })

  it('parses an agent-workspace record route with extra scope segments', () => {
    const ctx = parseServiceNowContext(`https://${HOST}/now/cwf/agent/record/task/${SID}`)
    expect(ctx).toMatchObject({ table: 'task', sysId: SID, view: 'form', ui: 'workspace' })
  })

  it('parses a workspace list route', () => {
    const ctx = parseServiceNowContext(`https://${HOST}/now/sow/list/incident`)
    expect(ctx).toMatchObject({ table: 'incident', sysId: null, view: 'list', ui: 'workspace' })
  })
})

describe('parseServiceNowContext — edge cases', () => {
  it('returns null for a non-URL string', () => {
    expect(parseServiceNowContext('not a url')).toBeNull()
  })

  it('classifies the root as a home view', () => {
    const ctx = parseServiceNowContext(`https://${HOST}/`)
    expect(ctx).toMatchObject({ table: null, sysId: null, view: 'home' })
  })

  it('returns unknown (not crash) for an unrecognized path', () => {
    const ctx = parseServiceNowContext(`https://${HOST}/some/random/page`)
    expect(ctx).toMatchObject({ table: null, sysId: null })
    expect(ctx?.view).toBe('unknown')
  })
})
