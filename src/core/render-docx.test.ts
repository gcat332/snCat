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

describe('buildDocxDocument / packing', () => {
  it('builds a Document and packs to a non-empty buffer', async () => {
    const document = buildDocxDocument(doc)
    const buffer = await Packer.toBuffer(document)
    // .docx is a zip — starts with "PK".
    expect(buffer.length).toBeGreaterThan(500)
    expect(buffer[0]).toBe(0x50) // 'P'
    expect(buffer[1]).toBe(0x4b) // 'K'
  })
})
