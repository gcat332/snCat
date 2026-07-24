/**
 * Renders a SpecDocument to a self-contained HTML string in the MFEC light
 * document theme (handoff §3b): white page, MFEC colors as accents, logo in a
 * gradient cover band, print/PDF CSS. No external assets except the Google
 * Fonts link; the logo is embedded as a data URI when provided.
 */
import type { SpecBlock, SpecDocument } from './spec'

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
    case 'code':
      return `${block.caption ? `<p class="code-caption">${esc(block.caption)}</p>` : ''}<pre class="code"><code>${esc(block.code)}</code></pre>`
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
section{margin-bottom:34px}
h2{color:var(--blue-dark);font-weight:500;font-size:19px;border-bottom:2px solid var(--cyan);padding-bottom:6px;margin:0 0 14px}
p{margin:0 0 12px}
ul{margin:0 0 12px;padding-left:20px}
li{margin:3px 0}
table{border-collapse:collapse;width:100%;margin:0 0 14px;font-size:13px}
table.data th,table.kv th{background:var(--blue-dark);color:#fff;font-weight:500;text-align:left;padding:7px 10px}
table.kv th{width:200px;background:var(--surface-alt);color:var(--blue-dark)}
table td{padding:7px 10px;border:1px solid var(--border);vertical-align:top}
table.data tbody tr:nth-child(even){background:rgba(0,49,180,0.04)}
.code-caption{font-weight:500;color:var(--violet);margin:6px 0 4px;font-size:12.5px}
pre.code{background:var(--surface-alt);border:1px solid var(--border);border-left:3px solid var(--cyan);
  border-radius:6px;padding:12px 14px;overflow-x:auto;font-family:'SFMono-Regular',ui-monospace,Menlo,monospace;
  font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
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
<footer>Generated by snJava — Java Assistant. Deterministic template output (no AI-generated prose).</footer>
</body></html>`
}
