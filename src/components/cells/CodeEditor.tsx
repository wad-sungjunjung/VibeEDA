import { useMemo, useRef, useEffect } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { keymap, EditorView, Decoration, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { Prec, RangeSetBuilder } from '@codemirror/state'
import { snowflakeTheme } from '@/lib/snowflakeTheme'
import type { CellType } from '@/types'

const fnCallTheme = EditorView.theme({
  '.cm-fn-call, .cm-fn-call span': { color: '#56d364 !important' },
})

const fnCallMark = Decoration.mark({ class: 'cm-fn-call' })
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g

function buildFnDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    IDENT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = IDENT_RE.exec(text))) {
      const end = from + m.index + m[0].length
      let i = end
      while (i < view.state.doc.length && /\s/.test(view.state.doc.sliceString(i, i + 1))) i++
      if (view.state.doc.sliceString(i, i + 1) === '(') {
        builder.add(from + m.index, end, fnCallMark)
      }
    }
  }
  return builder.finish()
}

const fnCallHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = buildFnDecorations(view) }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged) this.decorations = buildFnDecorations(u.view)
  }
}, { decorations: (v) => v.decorations })

interface Props {
  type: CellType
  value: string
  onChange: (value: string) => void
  onRun?: () => void
  fixedHeight?: number
  readOnly?: boolean
}

export default function CodeEditor({ type, value, onChange, onRun, fixedHeight, readOnly }: Props) {
  const onRunRef = useRef(onRun)
  useEffect(() => { onRunRef.current = onRun }, [onRun])

  const runKeymap = useMemo(() => Prec.highest(keymap.of([
    { key: 'Ctrl-Enter', run: () => { onRunRef.current?.(); return true } },
    { key: 'Mod-Enter',  run: () => { onRunRef.current?.(); return true } },
  ])), [])

  const extensions = useMemo(() => [
    runKeymap,
    type === 'sql' ? sql() : type === 'python' ? python() : markdown(),
    keymap.of([indentWithTab]),
    ...(type !== 'markdown' ? [...snowflakeTheme, fnCallTheme, fnCallHighlighter] : []),
  ], [type, runKeymap])

  const style: React.CSSProperties = fixedHeight
    ? { height: fixedHeight, overflow: 'hidden', borderRadius: 6 }
    : { minHeight: 360, borderRadius: 6 }

  return (
    <div style={style} onClick={(e) => e.stopPropagation()}>
      <CodeMirror
        value={value}
        height={fixedHeight ? `${fixedHeight}px` : undefined}
        minHeight={fixedHeight ? undefined : '360px'}
        theme={type !== 'markdown' ? 'none' : 'light'}
        extensions={extensions}
        onChange={onChange}
        readOnly={readOnly}
        basicSetup={{
          lineNumbers: type !== 'markdown',
          foldGutter: false,
          dropCursor: false,
          allowMultipleSelections: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
          syntaxHighlighting: true,
          bracketMatching: true,
          closeBrackets: true,
          indentOnInput: true,
        }}
        style={{ fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      />
    </div>
  )
}
