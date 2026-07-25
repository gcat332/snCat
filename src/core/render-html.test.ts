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

  it('escapes single-quotes (and the other special chars) in content', () => {
    const d: SpecDocument = { ...doc, title: `O'Brien "x" <b> & y` }
    const html = renderSpecHtml(d)
    expect(html).toContain('&#39;') // single-quote escaped
    expect(html).toContain('O&#39;Brien &quot;x&quot; &lt;b&gt; &amp; y')
    expect(html).not.toContain("O'Brien") // raw single-quote not present in title
  })

  it('does not emit a non-data:image logoDataUri raw in the img src', () => {
    const html = renderSpecHtml(doc, { logoDataUri: 'javascript:alert(1)' })
    expect(html).not.toContain('javascript:alert(1)')
    expect(html).not.toContain('src="javascript')
    // falls back to the safe text logo instead
    expect(html).toContain('logo-text')
    // a genuine embedded image is still emitted
    expect(renderSpecHtml(doc, { logoDataUri: 'data:image/png;base64,AAAA' })).toContain(
      'src="data:image/png;base64,AAAA"',
    )
  })

  it('assigns an id to level-3 artifact subheadings so the TOC can deep-link', () => {
    const d: SpecDocument = {
      ...doc,
      sections: [
        {
          heading: 'Logic',
          blocks: [
            { kind: 'subheading', level: 2, text: 'Business Rules (1)' },
            { kind: 'subheading', level: 3, text: 'HelperBR' },
            { kind: 'code', caption: 'Script', code: 'gs.info("x");' },
          ],
        },
      ],
    }
    const html = renderSpecHtml(d)
    expect(html).toMatch(/<h4 class="sub3" id="[^"]+">HelperBR<\/h4>/)
  })
})
