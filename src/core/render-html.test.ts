import { describe, it, expect } from 'vitest'
import { renderSpecHtml } from './render-html'
import type { SpecDocument } from './spec'

const doc: SpecDocument = {
  title: 'My <BR>',
  subtitle: 'Business Rule · Design Specification',
  meta: [
    { key: 'Instance', value: 'x.service-now.com' },
    { key: 'Empty', value: '' },
  ],
  sections: [
    {
      heading: 'Logic',
      blocks: [
        { kind: 'code', caption: 'Script', code: 'if (a < b) { gs.info("x"); }' },
        { kind: 'table', columns: ['A', 'B'], rows: [['1', '2']] },
      ],
    },
  ],
}

describe('renderSpecHtml', () => {
  it('produces a self-contained HTML document', () => {
    const html = renderSpecHtml(doc)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<style>')
    expect(html).toContain('Design Spec')
  })

  it('escapes HTML in content (no injection)', () => {
    const html = renderSpecHtml(doc)
    expect(html).toContain('My &lt;BR&gt;') // title escaped
    expect(html).toContain('if (a &lt; b)') // code escaped
    expect(html).not.toContain('<BR>')
  })

  it('omits empty meta rows', () => {
    const html = renderSpecHtml(doc)
    expect(html).toContain('Instance:')
    expect(html).not.toContain('Empty:')
  })

  it('embeds the logo as a data URI when provided, else falls back to text', () => {
    expect(renderSpecHtml(doc, { logoDataUri: 'data:image/png;base64,AAAA' })).toContain(
      'src="data:image/png;base64,AAAA"',
    )
    expect(renderSpecHtml(doc)).toContain('logo-text')
  })
})
