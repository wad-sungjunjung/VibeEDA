import { useMemo, useRef, useEffect } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { keymap, EditorView, Decoration, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { Prec, RangeSetBuilder } from '@codemirror/state'
import { search, searchKeymap } from '@codemirror/search'
import { snowflakeTheme } from '@/lib/snowflakeTheme'
import type { CellType } from '@/types'
import { useModelStore } from '@/store/modelStore'

const fnCallTheme = EditorView.theme({
  '.cm-fn-call, .cm-fn-call span': { color: '#56d364 !important' },
})

// .cm-editor가 wrapper 전체 높이를 채우도록 강제. 내부 .cm-scroller가 끝까지
// 늘어나 가로 스크롤바가 박스 하단에 붙는다 (콘텐츠가 짧을 때도 동일).
const fillHeightTheme = EditorView.theme({
  '&': { height: '100%' },
})

// Ctrl+F 검색 패널을 우상단에 떠 있는 컴팩트 카드로 띄운다 (Snowsight 스타일).
const searchPanelTheme = EditorView.theme({
  '.cm-panels': { backgroundColor: 'transparent', border: 'none' },
  '.cm-panels.cm-panels-top': {
    position: 'absolute',
    top: '8px',
    right: '8px',
    left: 'auto',
    width: 'auto',
    zIndex: '10',
    borderBottom: 'none',
  },
  '.cm-panel.cm-search': {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '1fr 26px 26px',
    alignItems: 'center',
    columnGap: '4px',
    rowGap: '6px',
    padding: '10px 12px 10px',
    paddingRight: '28px',
    width: '260px',
    backgroundColor: 'rgb(var(--color-surface))',
    border: '1px solid rgb(var(--color-border))',
    borderRadius: '10px',
    boxShadow: '0 6px 20px rgba(0,0,0,0.22)',
    fontSize: '12px',
    color: 'rgb(var(--color-text-primary))',
  },
  '.cm-panel.cm-search br': { display: 'none' },
  // "all" (전체 선택) 과 "by word" 는 자주 쓰이지 않아 숨긴다.
  '.cm-panel.cm-search button[name=select]': { display: 'none' },
  '.cm-panel.cm-search label:nth-of-type(3)': { display: 'none' },
  '.cm-panel.cm-search input[name=search]': { gridColumn: '1 / 2', gridRow: '1' },
  '.cm-panel.cm-search button[name=prev]': { gridColumn: '2 / 3', gridRow: '1' },
  '.cm-panel.cm-search button[name=next]': { gridColumn: '3 / 4', gridRow: '1' },
  '.cm-panel.cm-search input[name=replace]': { gridColumn: '1 / 2', gridRow: '3' },
  '.cm-panel.cm-search button[name=replace]': { gridColumn: '2 / 3', gridRow: '3' },
  '.cm-panel.cm-search button[name=replaceAll]': { gridColumn: '3 / 4', gridRow: '3' },
  '.cm-panel.cm-search input.cm-textfield': {
    padding: '5px 9px',
    height: '26px',
    backgroundColor: 'rgb(var(--color-bg-page))',
    border: '1px solid rgb(var(--color-border))',
    borderRadius: '6px',
    color: 'rgb(var(--color-text-primary))',
    fontSize: '12px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  '.cm-panel.cm-search input.cm-textfield:focus': {
    borderColor: 'rgb(var(--color-primary))',
    boxShadow: '0 0 0 2px rgb(var(--color-primary-pale))',
  },
  '.cm-panel.cm-search button': {
    width: '26px',
    height: '26px',
    padding: '0',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgb(var(--color-chip))',
    color: 'rgb(var(--color-text-primary))',
    border: '1px solid rgb(var(--color-border))',
    borderRadius: '6px',
    fontSize: '0',
    lineHeight: '0',
    cursor: 'pointer',
    textTransform: 'none',
    backgroundImage: 'none',
  },
  '.cm-panel.cm-search button:hover': {
    backgroundColor: 'rgb(var(--color-chip-hover))',
    borderColor: 'rgb(var(--color-border-hover))',
  },
  '.cm-panel.cm-search button::before': {
    lineHeight: '1',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  '.cm-panel.cm-search button[name=prev]::before': { content: '"‹"', fontSize: '16px' },
  '.cm-panel.cm-search button[name=next]::before': { content: '"›"', fontSize: '16px' },
  '.cm-panel.cm-search button[name=replace]::before': { content: '"↵"', fontSize: '13px' },
  '.cm-panel.cm-search button[name=replaceAll]::before': { content: '"⇊"', fontSize: '13px' },
  '.cm-panel.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    color: 'rgb(var(--color-text-secondary))',
    cursor: 'pointer',
    marginTop: '2px',
  },
  '.cm-panel.cm-search label:nth-of-type(1)': { gridColumn: '1 / 2', gridRow: '2' },
  '.cm-panel.cm-search label:nth-of-type(2)': { gridColumn: '2 / 4', gridRow: '2', justifySelf: 'end' },
  '.cm-panel.cm-search input[type=checkbox]': {
    margin: '0',
    width: '12px',
    height: '12px',
    accentColor: 'rgb(var(--color-primary))',
  },
  '.cm-panel.cm-search button[name=close]': {
    position: 'absolute',
    top: '6px',
    right: '6px',
    width: '20px',
    height: '20px',
    fontSize: '0',
    background: 'transparent',
    border: 'none',
    color: 'rgb(var(--color-text-tertiary))',
  },
  '.cm-panel.cm-search button[name=close]::before': { content: '"×"', fontSize: '16px' },
  '.cm-panel.cm-search button[name=close]:hover': {
    color: 'rgb(var(--color-text-primary))',
    background: 'rgb(var(--color-chip))',
  },
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
  const theme = useModelStore((s) => s.theme)

  const runKeymap = useMemo(() => Prec.highest(keymap.of([
    { key: 'Ctrl-Enter', run: () => { onRunRef.current?.(); return true } },
    { key: 'Mod-Enter',  run: () => { onRunRef.current?.(); return true } },
  ])), [])

  const extensions = useMemo(() => [
    runKeymap,
    type === 'sql' ? sql() : type === 'python' ? python() : markdown(),
    keymap.of([indentWithTab]),
    search({ top: true }),
    keymap.of(searchKeymap),
    ...(type !== 'markdown' ? [...snowflakeTheme, fnCallTheme, fnCallHighlighter] : []),
    fillHeightTheme,
    searchPanelTheme,
  ], [type, runKeymap])

  const style: React.CSSProperties = fixedHeight
    ? { height: fixedHeight, overflow: 'hidden', borderRadius: 6 }
    : { height: '100%', borderRadius: 6, display: 'flex', flexDirection: 'column' }

  return (
    <div style={style} onClick={(e) => e.stopPropagation()} className={fixedHeight ? undefined : '[&>*]:flex-1 [&>*]:min-h-0'}>
      <CodeMirror
        value={value}
        height={fixedHeight ? `${fixedHeight}px` : undefined}
        theme={type !== 'markdown' ? 'none' : (theme === 'dark' ? 'dark' : 'light')}
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
