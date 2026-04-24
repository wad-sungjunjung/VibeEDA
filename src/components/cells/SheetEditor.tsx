import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import sheetsCoreKoKR from '@univerjs/preset-sheets-core/locales/ko-KR'
import '@univerjs/preset-sheets-core/lib/index.css'
import { useModelStore } from '@/store/modelStore'

interface Props {
  value: string
  onChange: (v: string) => void
  height?: number | string
  readOnly?: boolean
  showFooter?: boolean
}

export interface SheetEditorHandle {
  getSelection: () => string | null
  getDataRegion: () => { data: (string | number | boolean | null)[][]; origin: string }
  applyPatches: (patches: { range: string; value: string | number | boolean }[]) => void
  toggleGridlines: () => boolean
  areGridlinesHidden: () => boolean
  /** 시트 캔버스에 포커스를 주고, 선택이 없으면 A1 을 선택한다. 커맨드 모드에서 Enter 로 시트 진입 시 사용. */
  focusGrid: () => void
}

function emptyWorkbook(): any {
  const sheetId = 'sheet-01'
  return {
    id: `wb_${Math.random().toString(36).slice(2, 10)}`,
    locale: 'koKR',
    name: 'VibeEDA Sheet',
    sheetOrder: [sheetId],
    appVersion: '3.0.0-alpha',
    styles: {},
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: 'Sheet1',
        tabColor: '',
        hidden: 0,
        rowCount: 100,
        columnCount: 26,
        zoomRatio: 1,
        scrollTop: 0,
        scrollLeft: 0,
        defaultColumnWidth: 88,
        defaultRowHeight: 24,
        mergeData: [],
        cellData: {},
        rowData: {},
        columnData: {},
        rowHeader: { width: 46, hidden: 0 },
        columnHeader: { height: 20, hidden: 0 },
        showGridlines: 1,
        rightToLeft: 0,
        freeze: { startRow: -1, startColumn: -1, ySplit: 0, xSplit: 0 },
      },
    },
  }
}

function parseSnapshot(v: string): any | null {
  if (!v) return null
  try {
    const parsed = JSON.parse(v)
    if (parsed && typeof parsed === 'object' && parsed.sheets) return parsed
    return null
  } catch {
    return null
  }
}

function parseA1(a1: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(a1.trim())
  if (!m) return null
  const letters = m[1].toUpperCase()
  let col = 0
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64)
  return { col: col - 1, row: parseInt(m[2], 10) - 1 }
}

function colToLetters(col: number): string {
  let n = col + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

const SheetEditor = forwardRef<SheetEditorHandle, Props>(function SheetEditor(
  { value, onChange, height, readOnly, showFooter = true },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  const apiRef = useRef<any>(null)
  const theme = useModelStore((s) => s.theme)

  onChangeRef.current = onChange

  useImperativeHandle(ref, () => ({
    getSelection: () => {
      try {
        const api = apiRef.current
        if (!api) return null
        const sheet = api.getActiveWorkbook?.()?.getActiveSheet?.()
        if (!sheet) return null
        const sel = sheet.getSelection?.()
        const range = sel?.getActiveRange?.() ?? sel?.getRange?.()
        if (!range) return null
        const r = range.getRange?.() ?? range._range
        if (!r) return null
        const start = `${colToLetters(r.startColumn)}${r.startRow + 1}`
        const end = `${colToLetters(r.endColumn)}${r.endRow + 1}`
        return start === end ? start : `${start}:${end}`
      } catch (err) {
        console.warn('[SheetEditor] getSelection failed', err)
        return null
      }
    },
    getDataRegion: () => {
      try {
        const api = apiRef.current
        if (!api) return { data: [], origin: 'A1' }
        const sheet = api.getActiveWorkbook?.()?.getActiveSheet?.()
        if (!sheet) return { data: [], origin: 'A1' }
        const usedRange = sheet.getDataRange?.() ?? sheet.getUsedRange?.()
        if (!usedRange) return { data: [], origin: 'A1' }
        const values: any[][] = usedRange.getValues?.() ?? []
        const r = usedRange.getRange?.() ?? usedRange._range
        const origin = r ? `${colToLetters(r.startColumn)}${r.startRow + 1}` : 'A1'
        const norm = values.map((row) =>
          row.map((v) => (v === undefined || v === '' ? null : (typeof v === 'object' ? (v.v ?? null) : v)))
        )
        return { data: norm, origin }
      } catch (err) {
        console.warn('[SheetEditor] getDataRegion failed', err)
        return { data: [], origin: 'A1' }
      }
    },
    toggleGridlines: () => {
      const api = apiRef.current
      if (!api) return false
      try {
        const sheet = api.getActiveWorkbook?.()?.getActiveSheet?.()
        if (!sheet) return false
        const hiddenNow = typeof sheet.hasHiddenGridLines === 'function' ? sheet.hasHiddenGridLines() : false
        const next = !hiddenNow
        sheet.setHiddenGridlines?.(next)
        return next
      } catch (err) {
        console.warn('[SheetEditor] toggleGridlines failed', err)
        return false
      }
    },
    areGridlinesHidden: () => {
      const api = apiRef.current
      if (!api) return false
      try {
        const sheet = api.getActiveWorkbook?.()?.getActiveSheet?.()
        return !!sheet?.hasHiddenGridLines?.()
      } catch {
        return false
      }
    },
    applyPatches: (patches) => {
      const api = apiRef.current
      if (!api) return
      try {
        const sheet = api.getActiveWorkbook?.()?.getActiveSheet?.()
        if (!sheet) return
        for (const p of patches) {
          const pos = parseA1(p.range)
          if (!pos) continue
          const cell = sheet.getRange?.(pos.row, pos.col, 1, 1)
          if (!cell) continue
          const isFormula = typeof p.value === 'string' && p.value.startsWith('=')
          if (isFormula) {
            if (typeof cell.setFormula === 'function') cell.setFormula(p.value)
            else cell.setValue?.(p.value)
          } else {
            cell.setValue?.(p.value)
          }
        }
      } catch (err) {
        console.error('[SheetEditor] applyPatches failed', err)
      }
    },
    focusGrid: () => {
      const api = apiRef.current
      const host = hostRef.current
      if (!host) return
      try {
        // 현재 선택이 없으면 A1 을 활성 범위로 지정
        const sheet = api?.getActiveWorkbook?.()?.getActiveSheet?.()
        if (sheet) {
          const sel = sheet.getSelection?.()
          const range = sel?.getActiveRange?.() ?? sel?.getRange?.()
          if (!range) {
            const a1 = sheet.getRange?.(0, 0, 1, 1)
            if (a1 && typeof a1.activate === 'function') a1.activate()
            else if (a1 && typeof sheet.setActiveRange === 'function') sheet.setActiveRange(a1)
          }
        }
      } catch (err) {
        console.warn('[SheetEditor] focusGrid selection failed', err)
      }
      // 캔버스/포커스 프록시에 포커스 — UniverJS 는 내부 input 이 아닌 캔버스 이벤트를 처리하므로
      // 마운트 컨테이너에 포커스를 주거나 캔버스를 직접 찾아 click/focus 를 흉내낸다.
      try {
        const canvas = host.querySelector<HTMLElement>('canvas')
        if (canvas) {
          canvas.setAttribute('tabindex', '-1')
          canvas.focus()
        } else {
          host.setAttribute('tabindex', '-1')
          ;(host as HTMLElement).focus()
        }
      } catch {}
    },
  }))

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const mount = document.createElement('div')
    mount.style.width = '100%'
    mount.style.height = '100%'
    if (theme === 'dark') mount.classList.add('univer-dark')
    host.appendChild(mount)

    let univer: any = null
    let univerAPI: any = null  // createUniver 이후 할당
    let disposeEvents: (() => void) | null = null

    // ── 서식 복사 원본 추적 ───────────────────────────────────────────────────
    let copiedFormatRange: { startRow: number; startColumn: number; endRow: number; endColumn: number } | null = null

    // ── 포인터 추적 ───────────────────────────────────────────────────────────
    let sheetActive = false
    const onPointerDown = (ev: PointerEvent) => {
      sheetActive = mount.contains(ev.target as Node)
    }
    document.addEventListener('pointerdown', onPointerDown, true)

    const isSheetFocused = () => {
      const ae = document.activeElement
      if (ae && mount.contains(ae)) return true
      return sheetActive
    }

    const isEditing = () => {
      try {
        const wb = univerAPI?.getActiveWorkbook?.()
        return !!wb?.isCellEditing?.()
      } catch {}
      return false
    }


    // ★ createUniver 이전에 등록 → window capture 순서에서 Univer 보다 앞에 실행됨
    const onKeyDown = (e: KeyboardEvent) => {
      if (!univerAPI) return  // 아직 초기화 전

      const active = document.activeElement as Element | null

      // mount 외부의 editable 요소(바이브 채팅 textarea, 셀 이름 input 등)에
      // 포커스가 있으면 개입 금지. mount 내부의 input/textarea 는 Univer 내부 요소이므로 통과.
      if (active && !mount.contains(active)) {
        const tag = (active?.tagName ?? '').toLowerCase()
        if (tag === 'input' || tag === 'textarea') return
        if (active.getAttribute?.('contenteditable') === 'true') return
        if (active.closest?.('[contenteditable="true"]')) return
      }

      if (!isSheetFocused()) return

      const editing = isEditing()
      const mod = e.ctrlKey || e.metaKey

      // ── Ctrl+C → 서식 복사 원본 범위 캡처 (Univer 복사는 그대로 허용) ─────────
      if (e.key === 'c' && mod && !e.altKey && !e.shiftKey) {
        try {
          const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
          const sel = sheet?.getSelection?.()
          const range = sel?.getActiveRange?.() ?? sel?.getRange?.()
          const r = range?.getRange?.() ?? range?._range
          if (r) copiedFormatRange = { startRow: r.startRow, startColumn: r.startColumn, endRow: r.endRow, endColumn: r.endColumn }
        } catch {}
        // preventDefault 없음 — Univer 가 정상 복사 처리
        return
      }

      // ── Ctrl+Alt+V → 서식만 붙여넣기 ──────────────────────────────────────
      if (e.key === 'v' && mod && e.altKey && !e.shiftKey) {
        e.preventDefault(); e.stopImmediatePropagation()
        if (!copiedFormatRange) return
        try {
          const wb = univerAPI?.getActiveWorkbook?.()
          const sheet = wb?.getActiveSheet?.()
          if (!sheet) return

          const snap = wb?.getSnapshot?.()
          const sheetId = Object.keys(snap?.sheets ?? {})[0]
          const sheetData = snap?.sheets?.[sheetId]
          const srcStyleId = sheetData?.cellData?.[copiedFormatRange.startRow]?.[copiedFormatRange.startColumn]?.s
          const srcStyle = srcStyleId ? snap?.styles?.[srcStyleId] : null
          if (!srcStyle) return

          const sel = sheet.getSelection?.()
          const range = sel?.getActiveRange?.() ?? sel?.getRange?.()
          const r = range?.getRange?.() ?? range?._range
          if (!r) return

          for (let row = r.startRow; row <= r.endRow; row++) {
            for (let col = r.startColumn; col <= r.endColumn; col++) {
              const cell = sheet.getRange?.(row, col, 1, 1)
              if (!cell) continue
              // setStyle 로 테두리·숫자 포맷 등 전체 서식 일괄 적용
              if (typeof cell.setStyle === 'function') {
                cell.setStyle(srcStyle)
              } else {
                // fallback: 개별 속성 설정
                if (srcStyle.bg?.rgb !== undefined) cell.setBackground?.(srcStyle.bg.rgb)
                if (srcStyle.cl?.rgb !== undefined) cell.setFontColor?.(srcStyle.cl.rgb)
                if (srcStyle.bl !== undefined) cell.setFontWeight?.(srcStyle.bl ? 'bold' : 'normal')
                if (srcStyle.it !== undefined) cell.setFontStyle?.(srcStyle.it ? 'italic' : 'normal')
                if (srcStyle.ul?.s !== undefined) cell.setTextDecoration?.(srcStyle.ul.s ? 1 : 0)
                if (srcStyle.fs !== undefined) cell.setFontSize?.(srcStyle.fs)
                if (srcStyle.ff !== undefined) cell.setFontFamily?.(srcStyle.ff)
                if (srcStyle.ht !== undefined) cell.setHorizontalAlignment?.(srcStyle.ht)
                if (srcStyle.vt !== undefined) cell.setVerticalAlignment?.(srcStyle.vt)
              }
            }
          }

          setTimeout(() => {
            try {
              const s = wb?.getSnapshot?.()
              if (s) onChangeRef.current(JSON.stringify(s))
            } catch {}
          }, 100)
        } catch (err) {
          console.warn('[SheetEditor] paste format failed', err)
        }
        return
      }

      // ── Enter (탐색 모드) → 편집 시작 ──────────────────────────────────────
      // ── Enter (편집 모드) → Univer 에 위임 (커밋 + 아래 이동) ────────────────
      if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
        if (!editing) {
          e.preventDefault(); e.stopImmediatePropagation()
          try {
            univerAPI.getActiveWorkbook()?.startEditing()
          } catch {}
        }
        return
      }

      // ── Backspace (탐색 모드) → 선택 범위 내용 삭제 ─────────────────────────
      if (e.key === 'Backspace' && !editing) {
        try {
          const sheet = univerAPI.getActiveWorkbook?.()?.getActiveSheet?.()
          if (!sheet) return
          const sel = sheet.getSelection?.()
          const range = sel?.getActiveRange?.() ?? sel?.getRange?.()
          if (!range) return
          const r = range.getRange?.() ?? range._range
          if (!r) return
          e.preventDefault(); e.stopImmediatePropagation()
          const numRows = r.endRow - r.startRow + 1
          const numCols = r.endColumn - r.startColumn + 1
          const cellRange = sheet.getRange?.(r.startRow, r.startColumn, numRows, numCols)
          if (typeof cellRange?.clearContent === 'function') {
            cellRange.clearContent()
          } else if (typeof cellRange?.clear === 'function') {
            cellRange.clear()
          } else {
            for (let row = r.startRow; row <= r.endRow; row++) {
              for (let col = r.startColumn; col <= r.endColumn; col++) {
                sheet.getRange?.(row, col, 1, 1)?.setValue?.('')
              }
            }
          }
          setTimeout(() => {
            try {
              const wb = univerAPI?.getActiveWorkbook?.()
              const snap = wb?.getSnapshot?.() ?? (wb as any)?.save?.()
              if (snap) onChangeRef.current(JSON.stringify(snap))
            } catch {}
          }, 100)
        } catch (err) {
          console.warn('[SheetEditor] Backspace clear failed', err)
        }
        return
      }

      // ── 방향키 edge wrap-around 방지 (4방향) ───────────────────────────────
      if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(e.key) && !editing && !mod && !e.shiftKey && !e.altKey) {
        try {
          const sheet = univerAPI.getActiveWorkbook?.()?.getActiveSheet?.()
          if (!sheet) return
          const sel = sheet.getSelection?.()
          const range = sel?.getActiveRange?.() ?? sel?.getRange?.()
          if (!range) return
          const r = range.getRange?.() ?? range._range
          if (!r) return
          const maxCol = (sheet.getColumnCount?.() ?? 26) - 1
          const maxRow = (sheet.getRowCount?.() ?? 100) - 1
          if (e.key === 'ArrowLeft'  && r.startColumn === 0)       { e.preventDefault(); e.stopImmediatePropagation() }
          if (e.key === 'ArrowUp'    && r.startRow === 0)           { e.preventDefault(); e.stopImmediatePropagation() }
          if (e.key === 'ArrowRight' && r.endColumn >= maxCol)      { e.preventDefault(); e.stopImmediatePropagation() }
          if (e.key === 'ArrowDown'  && r.endRow >= maxRow)         { e.preventDefault(); e.stopImmediatePropagation() }
        } catch {}
      }
    }
    window.addEventListener('keydown', onKeyDown, true)  // ← Univer 보다 먼저 등록

    try {
      const initial = parseSnapshot(value) ?? emptyWorkbook()

      const created = createUniver({
        locale: LocaleType.KO_KR,
        locales: { [LocaleType.KO_KR]: mergeLocales(sheetsCoreKoKR as any) },
        darkMode: theme === 'dark',
        presets: [
          UniverSheetsCorePreset({
            container: mount,
            header: true,
            toolbar: true,
            footer: showFooter,
            ribbonType: 'simple',
          } as any),
        ],
      })
      univer = created.univer
      univerAPI = created.univerAPI   // ← 이제 onKeyDown 에서 사용 가능
      apiRef.current = created.univerAPI
      created.univerAPI.createWorkbook(initial)

      const saveSnapshot = () => {
        try {
          const wb = created.univerAPI.getActiveWorkbook?.()
          if (!wb) return
          const snap = wb.getSnapshot?.() ?? (wb as any).save?.()
          if (snap) onChangeRef.current(JSON.stringify(snap))
        } catch (err) {
          console.warn('[SheetEditor] snapshot save failed', err)
        }
      }

      try {
        const ev = (created.univerAPI as any).Event
        const disposables: any[] = []
        if (ev?.SheetValueChanged) {
          disposables.push(created.univerAPI.addEvent(ev.SheetValueChanged, saveSnapshot))
        }
        if (ev?.SheetEditEnded) {
          disposables.push(created.univerAPI.addEvent(ev.SheetEditEnded, saveSnapshot))
        }
        disposeEvents = () => {
          for (const d of disposables) {
            try { d?.dispose?.() } catch {}
          }
        }
      } catch (err) {
        console.warn('[SheetEditor] event binding failed', err)
      }
    } catch (err) {
      console.error('[SheetEditor] init failed', err)
    }

    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      try { disposeEvents?.() } catch {}
      try { univer?.dispose?.() } catch {}
      apiRef.current = null
      univerAPI = null
      try {
        if (mount.parentNode === host) host.removeChild(mount)
      } catch {}
    }
  }, [theme, showFooter])

  return (
    <div
      ref={hostRef}
      className="w-full rounded-md overflow-hidden border border-border-subtle bg-surface"
      style={{
        height: typeof height === 'number' ? `${height}px` : (height ?? 480),
        pointerEvents: readOnly ? 'none' : undefined,
        opacity: readOnly ? 0.7 : undefined,
      }}
      onClick={(e) => e.stopPropagation()}
    />
  )
})

export default SheetEditor
