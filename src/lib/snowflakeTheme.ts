import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

// ── 스노우플레이크 다크 에디터 색상 ─────────────────────────────
const BG        = '#1a1f35'   // 에디터 배경
const BG_SEL    = '#2d3452'   // 선택 영역
const CARET     = '#c5cee0'   // 커서
const FG        = '#c5cee0'   // 기본 텍스트
const KW        = '#79b8ff'   // 키워드 (select, with, case, when, as...)
const STR       = '#f0883e'   // 문자열 리터럴 ('SITTING', '착석'...)
const NUM       = '#56d364'   // 숫자
const FN        = '#56d364'   // 함수명 (date, dayofweek, count...)
const OP        = '#c5cee0'   // 연산자 (=, *, .)
const COMMENT   = '#6a737d'   // 주석
const PUNCT     = '#8b97b0'   // 괄호, 쉼표

const snowflakeBaseTheme = EditorView.theme({
  '&': {
    backgroundColor: BG,
    color: FG,
  },
  '.cm-content': {
    caretColor: CARET,
    padding: '10px 0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: CARET,
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: BG_SEL,
  },
  '.cm-gutters': {
    backgroundColor: BG,
    color: '#4a5270',
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    scrollbarWidth: 'thin',
    scrollbarColor: '#3a4160 transparent',
  },
  '.cm-scroller::-webkit-scrollbar': {
    width: '6px',
    height: '6px',
  },
  '.cm-scroller::-webkit-scrollbar-track': {
    background: 'transparent',
  },
  '.cm-scroller::-webkit-scrollbar-thumb': {
    backgroundColor: '#3a4160',
    borderRadius: '3px',
  },
  '.cm-scroller::-webkit-scrollbar-thumb:hover': {
    backgroundColor: '#4a5270',
  },
  '.cm-scroller::-webkit-scrollbar-corner': {
    background: 'transparent',
  },
  '.cm-line': {
    padding: '0 12px',
  },
  '.cm-tooltip': {
    backgroundColor: '#252b45',
    border: '1px solid #3a4160',
    color: FG,
  },
}, { dark: true })

const snowflakeSyntax = HighlightStyle.define([
  // 키워드: select, from, where, with, as, case, when, then, else, end, join, on, group, order, by, having, limit, null, is, in, not, and, or, distinct, left, inner, right, full, outer, union, all, insert, update, delete, create, drop, alter
  { tag: t.keyword,               color: KW,      fontWeight: 'normal' },
  { tag: t.controlKeyword,        color: KW },
  { tag: t.operatorKeyword,       color: KW },
  { tag: t.definitionKeyword,     color: KW },
  { tag: t.moduleKeyword,         color: KW },

  // 문자열
  { tag: t.string,                color: STR },
  { tag: t.character,             color: STR },
  { tag: t.special(t.string),     color: STR },

  // 숫자
  { tag: t.number,                color: NUM },
  { tag: t.integer,               color: NUM },
  { tag: t.float,                 color: NUM },

  // 함수명 / 내장 함수 (dayofweek, date, count, sum 등)
  { tag: t.function(t.variableName), color: FN },
  { tag: t.function(t.name),         color: FN },
  { tag: t.standard(t.name),         color: FN },
  { tag: t.standard(t.variableName), color: FN },

  // 식별자 (컬럼명, 테이블명, 별칭)
  { tag: t.variableName,          color: FG },
  { tag: t.name,                  color: FG },
  { tag: t.propertyName,          color: FG },
  { tag: t.labelName,             color: FG },
  { tag: t.namespace,             color: FG },

  // 연산자
  { tag: t.operator,              color: OP },
  { tag: t.punctuation,           color: PUNCT },
  { tag: t.separator,             color: PUNCT },
  { tag: t.bracket,               color: PUNCT },
  { tag: t.paren,                 color: PUNCT },

  // 주석
  { tag: t.comment,               color: COMMENT, fontStyle: 'italic' },
  { tag: t.lineComment,           color: COMMENT, fontStyle: 'italic' },
  { tag: t.blockComment,          color: COMMENT, fontStyle: 'italic' },

  // Python 추가
  { tag: t.className,             color: '#b2d7ff' },
  { tag: t.typeName,              color: KW },
  { tag: t.self,                  color: KW },
  { tag: t.bool,                  color: KW },
  { tag: t.null,                  color: KW },

  // Markdown
  { tag: t.heading,               color: '#b2d7ff', fontWeight: 'bold' },
  { tag: t.emphasis,              fontStyle: 'italic' },
  { tag: t.strong,                fontWeight: 'bold' },
  { tag: t.link,                  color: STR, textDecoration: 'underline' },
])

export const snowflakeTheme = [
  snowflakeBaseTheme,
  syntaxHighlighting(snowflakeSyntax),
]
