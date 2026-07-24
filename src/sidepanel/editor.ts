/**
 * Thin CodeMirror 6 wrapper — a real code editor with JS syntax highlighting
 * for the script / optimized / tester / generated-script areas. No eval, so it
 * is CSP-safe in an MV3 extension page.
 */
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'

export interface CodeEditor {
  view: EditorView
  getValue: () => string
  setValue: (value: string) => void
}

export function createCodeEditor(
  parent: HTMLElement,
  initial = '',
  opts: { readOnly?: boolean; minHeight?: string } = {},
): CodeEditor {
  const view = new EditorView({
    parent,
    doc: initial,
    extensions: [
      basicSetup,
      javascript(),
      oneDark,
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { fontSize: '12px', borderRadius: '6px', border: '1px solid var(--border)' },
        '.cm-scroller': {
          fontFamily: "'SFMono-Regular', ui-monospace, Menlo, monospace",
          minHeight: opts.minHeight ?? '160px',
          maxHeight: '340px',
        },
        '&.cm-focused': { outline: 'none' },
      }),
      ...(opts.readOnly ? [EditorState.readOnly.of(true)] : []),
    ],
  })

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (value: string) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }),
  }
}
