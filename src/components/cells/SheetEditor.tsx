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
  /** Univer 하단 footer (시트 탭/줌 컨트롤) 표시 여부 */
  showFooter?: boolean
}

export interface SheetEditorHandle {
  /** 현재 선택 범위 A1 표기(예: "B2:D5"), 없으면 null */
  getSelection: () => string | null
  /** 현재 시트 데이터의 2D 배열 (used range) 과 시작 셀(A1 표기) */
  getDataRegion: () => { data: (string | number | boolean | null)[][]; origin: string }
  /** 패치 배열을 시트에 적용. {range:"A1", value:"=SUM(..)"} */
  applyPatches: (patches: { range: string; value: string | number | boolean }[]) => void
  /** 격자선 토글 — 반환값은 토글 후 "숨김 여부" */
  toggleGridlines: () => boolean
  /** 현재 격자선 숨김 상태 */
  areGridlinesHidden: () => boolean
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

// A1, B10 → {col, row} (0-indexed)
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
            else cell.setValue?.(p.value) // fallback — Univer는 '=' 시작값을 수식으로 해석
          } else {
            cell.setValue?.(p.value)
          }
        }
      } catch (err) {
        console.error('[SheetEditor] applyPatches failed', err)
      }
    },
  }))

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const mount = document.createElement('div')
    mount.style.width = '100%'
    mount.style.height = '100%'
    host.appendChild(mount)

    let univer: any = null
    let listenerDispose: (() => void) | null = null

    try {
      const initial = parseSnapshot(value) ?? emptyWorkbook()

      const created = createUniver({
        locale: LocaleType.KO_KR,
        locales: { [LocaleType.KO_KR]: mergeLocales(sheetsCoreKoKR as any) },
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

      // 내부 injector 참조 — 서비스 직접 접근용
      const getInjector = () => (created.univerAPI as any)._injector
      const getSvc = (tokens: string[]) => {
        const injector = getInjector()
        if (!injector?.get) return null
        for (const t of tokens) {
          try {
            const s = injector.get(t)
            if (s) return s
          } catch {}
        }
        return null
      }

      // 포커스 헬퍼 — pointerdown 시 Univer LayoutService.focus() 호출해서
      // React 중첩 마운트 안에서도 Univer 단축키(화살표, Ctrl+C/V/Z, Tab, F2 등) 가 동작하게 함.
      const focusUniver = () => {
        try {
          const layout = getSvc(['ui.layout-service', 'ILayoutService', 'LayoutService', 'DesktopLayoutService'])
          layout?.focus?.()
        } catch {}
      }

      // 복사 마커 상태 추적 — ClipboardChanged 시 true, 제거 후 false
      let hasCopyMarker = false
      const clearCopyMarker = () => {
        const svc = getSvc(['ISheetClipboardService', 'SheetClipboardService'])
        try { svc?.removeMarkSelection?.() } catch {}
        hasCopyMarker = false
      }

      // Google Sheets 스타일 Enter 동작 등록:
      // 기본 Univer 는 "편집중 아닐 때 Enter = 아래로 이동" 인데,
      // 같은 priority 이상의 shortcut 을 등록해 "Enter = 같은 셀 편집 시작" 으로 override.
      try {
        const shortcutSvc = getSvc(['IShortcutService', 'ShortcutService'])
        if (shortcutSvc?.registerShortcut) {
          shortcutSvc.registerShortcut({
            id: 'sheet.operation.set-cell-edit-visible',
            binding: 13, // KeyCode.ENTER
            priority: 10000,
            description: 'vibe-eda.sheet.enter-edit-same-cell',
            preconditions: (ctx: any) => {
              try {
                const focusingSheet = ctx?.getContextValue?.('FOCUSING_SHEET')
                const editorActivated = ctx?.getContextValue?.('EDITOR_ACTIVATED')
                // 시트 focus 중 + 편집 중 아닐 때만 (편집 중 Enter 는 기존 커밋+이동 유지)
                return !!focusingSheet && !editorActivated
              } catch {
                return false
              }
            },
            staticParameters: {
              visible: true,
              eventType: 4, // DeviceInputEventType.Keyboard
              keycode: 13,
            },
          })
        }
      } catch (err) {
        console.warn('[SheetEditor] Enter shortcut override failed', err)
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
        // 복사/잘라내기 시작 시 마커 상태 플래그 설정
        if (ev?.ClipboardChanged) {
          disposables.push(
            created.univerAPI.addEvent(ev.ClipboardChanged, () => { hasCopyMarker = true }),
          )
        }
        // 붙여넣기 후 마커 자동 제거 (구글 시트와 달리 다중 붙여넣기 수요 낮다고 판단)
        if (ev?.ClipboardPasted) {
          disposables.push(
            created.univerAPI.addEvent(ev.ClipboardPasted, () => {
              window.setTimeout(clearCopyMarker, 50)
              saveSnapshot()
            }),
          )
        }
        listenerDispose = () => {
          for (const d of disposables) {
            try { d?.dispose?.() } catch {}
          }
        }
      } catch (err) {
        console.warn('[SheetEditor] event binding failed', err)
      }

      // 최근 포인터 상호작용이 sheet 내부였는지 추적 — 포커스가 body 로 빠져도 활성 판정.
      let lastPointerInside = false
      const onPointerDown = (ev: PointerEvent) => {
        const t = ev.target as Node | null
        lastPointerInside = !!(t && mount.contains(t))
        if (lastPointerInside) {
          // 마이크로태스크로 늦춰 Univer 가 포커스 세팅한 뒤 재확인
          queueMicrotask(focusUniver)
        }
      }
      document.addEventListener('pointerdown', onPointerDown, true)

      // 단축키 핸들러 — 구글 시트 느낌의 UX 를 보장하기 위한 capture 레벨 가드.
      // 포커스가 살아있으면 Univer 가 대부분 처리하므로, 여기선 "Univer 가 놓치는 케이스" 만 폴백.
      const onKeyDown = (e: KeyboardEvent) => {
        const active = document.activeElement as Element | null

        // 다른 editable (VibeEDA 바이브 채팅 등) 에 포커스 있으면 개입 금지
        const tag = (active?.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea') return
        if (active && !mount.contains(active)) {
          if (active.getAttribute?.('contenteditable') === 'true') return
          if (active.closest?.('[contenteditable="true"]')) return
        }

        // 이 sheet 가 "활성" 인지 판단
        const inside = lastPointerInside || (active && mount.contains(active))
        if (!inside) return

        const wb = created.univerAPI.getActiveWorkbook?.()
        const editing = !!wb?.isCellEditing?.()

        // ── Escape: 편집 > 마커 > (나머지) 순서로 소비 ─────────────────
        if (e.key === 'Escape') {
          if (editing) {
            try { wb?.endEditingAsync?.(false) } catch {}
            e.preventDefault()
            e.stopImmediatePropagation()
            return
          }
          if (hasCopyMarker) {
            clearCopyMarker()
            e.preventDefault()
            e.stopImmediatePropagation()
            return
          }
          // 아무것도 없으면 그대로 흘려보냄 → CellContainer 가 전체화면 해제
          return
        }

        // Enter 는 Univer ShortcutService 로 override 처리 (registerShortcut 참조)

        // ── Delete / Backspace: 선택 영역 클리어 ────────────────────
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (editing) return // 편집 중에는 브라우저/Univer 가 문자 삭제 처리
          try {
            const sheet = wb?.getActiveSheet?.()
            const range = sheet?.getSelection?.()?.getActiveRange?.()
            if (!range) return
            if (typeof range.clearContent === 'function') range.clearContent()
            else if (typeof range.clear === 'function') range.clear()
            else if (typeof range.setValue === 'function') range.setValue('')
            e.preventDefault()
            saveSnapshot()
          } catch (err) {
            console.warn('[SheetEditor] delete fallback failed', err)
          }
          return
        }
      }
      // window 레벨 capture 로 등록 — Univer 의 document-level 리스너보다 먼저 실행되어 override 가능
      window.addEventListener('keydown', onKeyDown, true)
      const prevDispose = listenerDispose
      listenerDispose = () => {
        try { prevDispose?.() } catch {}
        window.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('pointerdown', onPointerDown, true)
      }
    } catch (err) {
      console.error('[SheetEditor] init failed', err)
    }

    return () => {
      try { listenerDispose?.() } catch {}
      try { univer?.dispose?.() } catch {}
      apiRef.current = null
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
