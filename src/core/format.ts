import type { SpecDocument } from './spec'

/**
 * JavaScript formatter for the code editors. Prettier is loaded on demand
 * (dynamic import → its own chunk) so it doesn't weigh down the initial panel.
 */
export async function formatJs(code: string): Promise<string> {
  const [prettier, babel, estree] = await Promise.all([
    import('prettier/standalone'),
    import('prettier/plugins/babel'),
    import('prettier/plugins/estree'),
  ])
  const plugins = [
    (babel as { default?: unknown }).default ?? babel,
    (estree as { default?: unknown }).default ?? estree,
  ]
  return prettier.format(code, {
    parser: 'babel',
    plugins: plugins as never,
    semi: true,
    singleQuote: false,
    printWidth: 100,
    tabWidth: 2,
  })
}

/** Format every JavaScript code block in a SpecDocument (best-effort). */
export async function formatSpecDoc(doc: SpecDocument): Promise<SpecDocument> {
  const clone = structuredClone(doc)
  for (const section of clone.sections) {
    for (const block of section.blocks) {
      if (block.kind === 'code' && block.lang === 'javascript' && block.code.trim()) {
        try {
          block.code = (await formatJs(block.code)).replace(/\n$/, '')
        } catch {
          /* leave unformatted */
        }
      }
    }
  }
  return clone
}
