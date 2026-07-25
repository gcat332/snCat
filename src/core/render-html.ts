/**
 * Renders a SpecDocument to a self-contained HTML string in the MFEC light
 * document theme (handoff §3b): white page, MFEC colors as accents, logo in a
 * gradient cover band, print/PDF CSS. No external assets except the Google
 * Fonts link; the logo is embedded as a data URI when provided.
 */
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import type { SpecBlock, SpecDocument } from './spec'

hljs.registerLanguage('javascript', javascript)

function highlightJs(code: string): string {
  try {
    return hljs.highlight(code, { language: 'javascript', ignoreIllegals: true }).value
  } catch {
    return esc(code)
  }
}

export interface RenderHtmlOptions {
  /** MFEC logo as a data: URI (white variant, sits on the gradient band). */
  logoDataUri?: string
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderBlock(block: SpecBlock): string {
  switch (block.kind) {
    case 'paragraph':
      return `<p>${esc(block.text)}</p>`
    case 'subheading':
      return block.level === 2
        ? `<h3 class="sub2">${esc(block.text)}</h3>`
        : `<h4 class="sub3">${esc(block.text)}</h4>`
    case 'keyvalue':
      return `<table class="kv"><tbody>${block.rows
        .map((r) => `<tr><th>${esc(r.key)}</th><td>${esc(r.value)}</td></tr>`)
        .join('')}</tbody></table>`
    case 'table':
      return `<table class="data"><thead><tr>${block.columns
        .map((c) => `<th>${esc(c)}</th>`)
        .join('')}</tr></thead><tbody>${block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    case 'code': {
      const caption = block.caption ? `<p class="code-caption">${esc(block.caption)}</p>` : ''
      const body = block.lang === 'javascript' ? highlightJs(block.code) : esc(block.code)
      return `${caption}<pre class="code hljs"><code>${body}</code></pre>`
    }
    case 'list':
      return `<ul>${block.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
  }
}

const STYLE = `
:root{
  --navy:#000960; --blue-dark:#0031B4; --blue:#0062EC; --cyan:#00A2E9;
  --purple:#9063CD; --violet:#6968AB; --ink:#1F1F1F; --soft:#5b6172;
  --border:#e2e7f2; --surface-alt:#F4F6FB;
  --gradient:linear-gradient(135deg,#000960 0%,#0031B4 45%,#6968AB 80%,#9063CD 100%);
}
*{box-sizing:border-box}
body{font-family:'Sarabun',system-ui,-apple-system,'Segoe UI',Tahoma,'Noto Sans Thai',Arial,sans-serif;font-weight:400;color:var(--ink);margin:0;background:#fff;line-height:1.6}
.cover{background:var(--gradient);color:#fff;padding:48px 56px}
.cover img{height:34px;margin-bottom:28px;filter:brightness(0) invert(1)}
.cover .logo-text{font-weight:500;font-size:20px;letter-spacing:1px;margin-bottom:28px}
.cover h1{font-weight:500;font-size:30px;margin:0 0 8px}
.cover .subtitle{font-weight:300;opacity:.9;font-size:15px}
.meta{display:flex;flex-wrap:wrap;gap:6px 28px;margin-top:22px;font-size:12.5px}
.meta div{opacity:.92}
.meta b{font-weight:500}
main{padding:36px 56px 64px;max-width:900px}
section{margin-bottom:48px;padding-bottom:8px}
h2{color:#fff;background:var(--gradient);font-weight:600;font-size:18px;padding:10px 14px;border-radius:8px;margin:0 0 18px}
h3.sub2{color:var(--blue-dark);font-weight:600;font-size:15px;margin:26px 0 8px;padding-bottom:5px;border-bottom:2px solid var(--cyan)}
h4.sub3{color:var(--ink);font-weight:600;font-size:13px;margin:18px 0 6px;padding-left:9px;border-left:3px solid var(--purple)}
p{margin:0 0 12px}
ul{margin:0 0 12px;padding-left:20px}
li{margin:3px 0}
table{border-collapse:collapse;width:100%;margin:0 0 18px;font-size:13px}
table.data th,table.kv th{background:var(--blue-dark);color:#fff;font-weight:500;text-align:left;padding:7px 10px}
table.kv th{width:200px;background:var(--surface-alt);color:var(--blue-dark)}
table td{padding:7px 10px;border:1px solid var(--border);vertical-align:top}
table.data tbody tr:nth-child(even){background:rgba(0,49,180,0.04)}
/* Each script renders as a labeled unit: header bar attached to the code block. */
.code-caption{font-weight:600;color:#dfe6f5;background:#21252b;margin:28px 0 0;padding:9px 14px;font-size:12.5px;
  border-top-left-radius:6px;border-top-right-radius:6px;border-left:3px solid var(--purple)}
.code-caption + pre.code{margin-top:0;border-top-left-radius:0;border-top-right-radius:0;border-left-color:var(--purple)}
pre.code{background:#282c34;color:#abb2bf;border:1px solid #1c1f26;border-left:3px solid var(--cyan);
  border-radius:6px;margin:14px 0 18px;padding:12px 14px;overflow-x:auto;font-family:'SFMono-Regular',ui-monospace,Menlo,monospace;
  font-size:12px;line-height:1.55;white-space:pre;tab-size:2}
pre.code code{font-family:inherit}
/* one-dark syntax highlighting (self-contained) */
.hljs-comment,.hljs-quote{color:#7f848e;font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in,.hljs-name,.hljs-tag{color:#c678dd}
.hljs-string,.hljs-title,.hljs-section,.hljs-attribute,.hljs-literal,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-addition{color:#98c379}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-meta,.hljs-link{color:#d19a66}
.hljs-title.function_,.hljs-function .hljs-title{color:#61afef}
.hljs-variable,.hljs-attr,.hljs-property{color:#e06c75}
.hljs-regexp,.hljs-deletion{color:#e06c75}
.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}
/* Table of contents */
.toc{border:1px solid var(--border);background:var(--surface-alt);border-radius:8px;padding:18px 22px;margin:0 0 40px}
.toc-title{all:unset;display:block;color:var(--blue-dark);font-weight:600;font-size:15px;margin:0 0 10px}
.toc ol{margin:0;padding-left:20px}
.toc>ol{counter-reset:sec}
.toc>ol>li{margin:5px 0;font-weight:500;color:var(--blue-dark)}
.toc ul{list-style:none;padding-left:14px;margin:4px 0}
.toc ul li{font-weight:300;margin:2px 0}
.toc a{color:inherit;text-decoration:none}
.toc a:hover{text-decoration:underline}
footer{padding:18px 56px;color:var(--soft);font-size:11px;border-top:1px solid var(--border)}
.ai-overview{background:var(--surface-alt);border:1px solid var(--border);border-radius:8px;padding:22px 26px;margin:0 0 40px}
.ai-overview h2{margin:0 0 12px}
.ai-tag{display:inline-block;margin-left:10px;padding:2px 9px;border-radius:999px;background:rgba(255,255,255,0.22);color:#fff;font-size:10.5px;font-weight:500;letter-spacing:.3px;vertical-align:middle}
.ai-overview p:last-child{margin-bottom:0}
@media print{
  .toc{break-inside:avoid}
  .cover{padding:36px 40px}
  main{padding:24px 40px}
  section{page-break-inside:auto;break-inside:auto}
  h2{page-break-after:avoid}
  table{page-break-inside:auto}
  thead{display:table-header-group}
  pre.code{page-break-inside:avoid}
  @page{margin:14mm}
}
`

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

export function renderSpecHtml(doc: SpecDocument, opts: RenderHtmlOptions = {}): string {
  // Only emit an <img> when the logo is a safe embedded image (a data:image/…
  // URI). Any other value (e.g. a javascript: or http: URL) is rejected to
  // prevent an attribute-breakout / untrusted resource, falling back to text.
  const logo = opts.logoDataUri?.startsWith('data:image/')
    ? `<img src="${esc(opts.logoDataUri)}" alt="MFEC" />`
    : `<div class="logo-text">MFEC</div>`

  const meta = doc.meta
    .filter((m) => m.value)
    .map((m) => `<div><b>${esc(m.key)}:</b> ${esc(m.value)}</div>`)
    .join('')

  // Render sections while assigning stable ids to each section and its level-2
  // and level-3 subheadings, and collect a matching table-of-contents tree.
  // Level-3 links nest under the preceding level-2 entry so deep links resolve.
  const toc: string[] = []
  const sections = doc.sections
    .map((s, i) => {
      const secId = `sec-${i}-${slug(s.heading)}`
      // Each entry is a level-2 (or orphan level-3) link plus its level-3 children.
      const subEntries: { link: string; children: string[] }[] = []
      let subIdx = 0
      const body = s.blocks
        .map((b) => {
          if (b.kind === 'subheading' && (b.level === 2 || b.level === 3)) {
            const subId = `${secId}-${subIdx++}-${slug(b.text)}`
            const link = `<li><a href="#${subId}">${esc(b.text)}</a></li>`
            if (b.level === 2) {
              subEntries.push({ link, children: [] })
              return `<h3 class="sub2" id="${subId}">${esc(b.text)}</h3>`
            }
            // level 3: attach to the current level-2, or stand alone if none yet.
            const parent = subEntries[subEntries.length - 1]
            if (parent) parent.children.push(link)
            else subEntries.push({ link, children: [] })
            return `<h4 class="sub3" id="${subId}">${esc(b.text)}</h4>`
          }
          return renderBlock(b)
        })
        .join('')
      const subLinks = subEntries
        .map((e) =>
          e.children.length
            ? e.link.replace(/<\/li>$/, `<ul>${e.children.join('')}</ul></li>`)
            : e.link,
        )
        .join('')
      toc.push(
        `<li><a href="#${secId}">${esc(s.heading)}</a>${subLinks ? `<ul>${subLinks}</ul>` : ''}</li>`,
      )
      return `<section><h2 id="${secId}">${esc(s.heading)}</h2>${body}</section>`
    })
    .join('')

  const tocHtml = `<nav class="toc"><h2 class="toc-title">Contents</h2><ol>${toc.join('')}</ol></nav>`

  const aiBlock = doc.aiOverview
    ? `<section class="ai-overview"><h2>Overview <span class="ai-tag">AI-generated</span></h2>` +
      doc.aiOverview.split(/\n\n+/).map((p) => `<p>${esc(p)}</p>`).join('') +
      `</section>`
    : ''

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(doc.title)} — Design Spec</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>${STYLE}</style></head>
<body>
<div class="cover">${logo}<h1>${esc(doc.title)}</h1><div class="subtitle">${esc(doc.subtitle)}</div>
<div class="meta">${meta}</div></div>
<main>${aiBlock}${tocHtml}${sections}</main>
<footer>Generated by snJava — ServiceNow Java Assistant. Template output is deterministic; the Overview above is AI-drafted only when present.</footer>
</body></html>`
}
