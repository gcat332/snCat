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
}

function renderBlock(block: SpecBlock): string {
  switch (block.kind) {
    case 'paragraph':
      return `<p>${esc(block.text)}</p>`
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
body{font-family:'Prompt',system-ui,sans-serif;font-weight:300;color:var(--ink);margin:0;background:#fff;line-height:1.55}
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
footer{padding:18px 56px;color:var(--soft);font-size:11px;border-top:1px solid var(--border)}
@media print{
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

export function renderSpecHtml(doc: SpecDocument, opts: RenderHtmlOptions = {}): string {
  const logo = opts.logoDataUri
    ? `<img src="${opts.logoDataUri}" alt="MFEC" />`
    : `<div class="logo-text">MFEC</div>`

  const meta = doc.meta
    .filter((m) => m.value)
    .map((m) => `<div><b>${esc(m.key)}:</b> ${esc(m.value)}</div>`)
    .join('')

  const sections = doc.sections
    .map(
      (s) =>
        `<section><h2>${esc(s.heading)}</h2>${s.blocks.map(renderBlock).join('')}</section>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(doc.title)} — Design Spec</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Prompt:wght@200;300;400;500&display=swap" rel="stylesheet" />
<style>${STYLE}</style></head>
<body>
<div class="cover">${logo}<h1>${esc(doc.title)}</h1><div class="subtitle">${esc(doc.subtitle)}</div>
<div class="meta">${meta}</div></div>
<main>${sections}</main>
<footer>Generated by snJava — ServiceNow Java Assistant. Deterministic template output (no AI-generated prose).</footer>
</body></html>`
}
