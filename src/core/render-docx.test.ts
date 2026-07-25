import { describe, it, expect } from 'vitest'
import { Packer } from 'docx'
import { buildDocxDocument } from './render-docx'
import type { SpecDocument } from './spec'

const doc: SpecDocument = {
  title: 'Sample BR',
  subtitle: 'Business Rule · Design Specification',
  meta: [{ key: 'Instance', value: 'x.service-now.com' }],
  sections: [
    { heading: 'Overview', blocks: [{ kind: 'paragraph', text: 'Hello' }] },
    {
      heading: 'Logic',
      blocks: [
        { kind: 'code', caption: 'Script', code: 'gs.info("x");\nreturn 1;' },
        { kind: 'table', columns: ['A', 'B'], rows: [['1', '2']] },
      ],
    },
  ],
}

// Recursively collect every node in the docx object graph whose rootKey === key.
function collect(node: unknown, key: string, seen = new Set<unknown>()): any[] {
  const out: any[] = []
  if (node == null || typeof node !== 'object') return out
  if (seen.has(node)) return out
  seen.add(node)
  const n = node as any
  if (n.rootKey === key) out.push(n)
  for (const k of Object.keys(n)) out.push(...collect(n[k], key, seen))
  return out
}

// True if any descendant of node carries `.fill === fill` (code paragraph shading).
function containsFill(node: unknown, fill: string, seen = new Set<unknown>()): boolean {
  if (node == null || typeof node !== 'object') return false
  if (seen.has(node)) return false
  seen.add(node)
  const n = node as any
  if (n.fill === fill) return true
  return Object.keys(n).some((k) => containsFill(n[k], fill, seen))
}

const CODE_SHADING = 'F4F6FB' // SURFACE_ALT — the fill unique to code blocks

// True if `text` appears verbatim as a string leaf anywhere in the docx object graph
// (a TextRun's text content is stored as a raw string element inside its `w:t` node).
function containsText(node: unknown, text: string, seen = new Set<unknown>()): boolean {
  if (typeof node === 'string') return node === text
  if (node == null || typeof node !== 'object') return false
  if (seen.has(node)) return false
  seen.add(node)
  const n = node as any
  return Object.keys(n).some((k) => containsText(n[k], text, seen))
}

describe('buildDocxDocument / packing', () => {
  it('builds a Document and packs to a non-empty buffer', async () => {
    const document = buildDocxDocument(doc)
    const buffer = await Packer.toBuffer(document)
    // .docx is a zip — starts with "PK".
    expect(buffer.length).toBeGreaterThan(500)
    expect(buffer[0]).toBe(0x50) // 'P'
    expect(buffer[1]).toBe(0x4b) // 'K'
  })

  it('renders a K-line code block as ONE shaded paragraph with K-1 break runs (not K paragraphs)', async () => {
    const lines = ['line1', 'line2', 'line3', 'line4', 'line5']
    const K = lines.length
    const codeDoc: SpecDocument = {
      title: 'Code perf',
      subtitle: 'x',
      meta: [],
      sections: [{ heading: 'Logic', blocks: [{ kind: 'code', code: lines.join('\n') }] }],
    }
    const document = buildDocxDocument(codeDoc)

    // Paragraphs carrying the code shading fill are exactly the code-block paragraphs.
    const codeParas = collect(document, 'w:p').filter((p) => containsFill(p, CODE_SHADING))
    expect(codeParas.length).toBe(1)

    // The single paragraph must contain a run per line: K-1 explicit line breaks (w:br)
    // after the first line, so the visual line count is preserved.
    const breaks = collect(codeParas[0], 'w:br')
    expect(breaks.length).toBe(K - 1)

    // Packing still succeeds.
    const buffer = await Packer.toBuffer(document)
    expect(buffer.length).toBeGreaterThan(500)
  })

  it('includes an AI-generated overview paragraph when aiOverview is set', () => {
    const withAi: SpecDocument = { ...doc, aiOverview: 'Prose about the module.' }
    const documentWithAi = buildDocxDocument(withAi)
    expect(containsText(documentWithAi, 'Prose about the module.')).toBe(true)
    expect(containsText(documentWithAi, 'Overview (AI-generated)')).toBe(true)

    const documentWithoutAi = buildDocxDocument(doc)
    expect(containsText(documentWithoutAi, 'Prose about the module.')).toBe(false)
    expect(containsText(documentWithoutAi, 'Overview (AI-generated)')).toBe(false)
  })
})
