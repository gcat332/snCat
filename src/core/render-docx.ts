/**
 * Renders a SpecDocument to a Word .docx (handoff §3a). Light theme: MFEC colors
 * on headings and table header rows. Uses the `docx` library; buildDocxDocument
 * is separated from packing so it can be exercised in tests (Packer.toBuffer),
 * while the browser uses renderSpecDocxBlob (Packer.toBlob).
 */
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  BorderStyle,
  TableOfContents,
  ImageRun,
} from 'docx'
import type { SpecBlock, SpecDocument } from './spec'

const BLUE_DARK = '0031B4'
const CYAN = '00A2E9'
const INK = '1F1F1F'
const SURFACE_ALT = 'F4F6FB'

function headerCell(text: string): TableCell {
  return new TableCell({
    shading: { type: ShadingType.CLEAR, fill: BLUE_DARK, color: 'auto' },
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: 'FFFFFF' })] })],
  })
}

function bodyCell(text: string): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: text || '', color: INK })] })],
  })
}

function dataTable(columns: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: columns.map(headerCell) }),
      ...rows.map((r) => new TableRow({ children: r.map(bodyCell) })),
    ],
  })
}

function codeParagraphs(caption: string | undefined, code: string): Paragraph[] {
  const out: Paragraph[] = []
  if (caption) {
    out.push(new Paragraph({ children: [new TextRun({ text: caption, bold: true, color: '6968AB' })] }))
  }
  for (const line of code.split('\n')) {
    out.push(
      new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: SURFACE_ALT, color: 'auto' },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: CYAN, space: 4 } },
        children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 18 })],
      }),
    )
  }
  return out
}

function blockToChildren(block: SpecBlock): (Paragraph | Table)[] {
  switch (block.kind) {
    case 'paragraph':
      return [new Paragraph({ children: [new TextRun({ text: block.text, color: INK })] })]
    case 'subheading':
      return [
        new Paragraph({
          heading: block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          spacing: { before: block.level === 2 ? 220 : 140 },
          children: [new TextRun({ text: block.text, color: block.level === 2 ? BLUE_DARK : INK, bold: true })],
        }),
      ]
    case 'keyvalue':
      return [dataTable(['Field', 'Value'], block.rows.map((r) => [r.key, r.value]))]
    case 'table':
      return [dataTable(block.columns, block.rows)]
    case 'code':
      return codeParagraphs(block.caption, block.code)
    case 'list':
      return block.items.map((i) => new Paragraph({ text: i, bullet: { level: 0 } }))
  }
}

export function buildDocxDocument(doc: SpecDocument, logo?: Uint8Array): Document {
  const children: (Paragraph | Table)[] = []

  if (logo && logo.length) {
    children.push(
      new Paragraph({
        spacing: { after: 160 },
        children: [
          new ImageRun({
            data: logo,
            transformation: { width: 168, height: 53 }, // MFEC logo aspect ~3.2:1
          }),
        ],
      }),
    )
  }

  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: doc.title, color: BLUE_DARK })] }))
  children.push(new Paragraph({ children: [new TextRun({ text: doc.subtitle, color: '5B6172' })] }))

  const metaRows = doc.meta.filter((m) => m.value).map((m) => [m.key, m.value])
  if (metaRows.length) children.push(dataTable(['Field', 'Value'], metaRows))

  // Table of contents (built from Heading 1/2 styles; Word updates page numbers
  // on open / F9). Uses hyperlinks so it is navigable even before updating.
  children.push(
    new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240 }, children: [new TextRun({ text: 'Contents', color: BLUE_DARK })] }),
  )
  children.push(new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }))

  for (const section of doc.sections) {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240 }, children: [new TextRun({ text: section.heading, color: BLUE_DARK })] }),
    )
    for (const block of section.blocks) children.push(...blockToChildren(block))
  }

  return new Document({
    creator: 'snJava',
    title: doc.title,
    styles: {
      default: {
        document: { run: { font: 'Prompt', size: 22, color: INK } },
      },
    },
    sections: [{ children }],
  })
}

export async function renderSpecDocxBlob(doc: SpecDocument, logo?: Uint8Array): Promise<Blob> {
  return Packer.toBlob(buildDocxDocument(doc, logo))
}
