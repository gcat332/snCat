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
