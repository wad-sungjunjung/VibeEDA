#!/usr/bin/env node
// Run the FastAPI backend using the venv's uvicorn binary (no shell sourcing needed).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { resolve, join } from 'node:path'

const isWin = platform() === 'win32'
const BACKEND = resolve(process.cwd(), 'backend')
const venvUvicorn = isWin
  ? join(BACKEND, '.venv', 'Scripts', 'uvicorn.exe')
  : join(BACKEND, '.venv', 'bin', 'uvicorn')

const bin = existsSync(venvUvicorn) ? venvUvicorn : 'uvicorn'
if (bin === 'uvicorn') {
  console.warn('⚠ backend/.venv 를 찾지 못했습니다. `npm run setup` 을 먼저 실행하세요.')
  console.warn('  (시스템 전역 uvicorn 으로 폴백합니다)')
}

const port = process.env.BACKEND_PORT || '4750'

// Address-already-in-use 로 인한 즉시 종료를 막기 위해 시작 직전 포트를 정리한다.
// (이전 실행의 좀비 uvicorn / 비정상 종료된 reloader 자식 프로세스가 자주 남는다)
function freePort(p) {
  if (isWin) {
    // Windows: netstat 으로 PID 찾고 taskkill
    const out = spawnSync('cmd', ['/c', `netstat -ano | findstr :${p}`], { encoding: 'utf8' })
    const pids = new Set()
    for (const line of (out.stdout || '').split(/\r?\n/)) {
      const m = line.trim().match(/LISTENING\s+(\d+)$/)
      if (m) pids.add(m[1])
    }
    for (const pid of pids) {
      console.warn(`  → 포트 ${p} 점유 중인 PID ${pid} 종료`)
      spawnSync('taskkill', ['/F', '/PID', pid])
    }
  } else {
    const out = spawnSync('lsof', ['-ti', `:${p}`], { encoding: 'utf8' })
    const pids = (out.stdout || '').split(/\s+/).filter(Boolean)
    for (const pid of pids) {
      console.warn(`  → 포트 ${p} 점유 중인 PID ${pid} 종료`)
      spawnSync('kill', ['-9', pid])
    }
  }
}

freePort(port)

const args = ['main:app', '--reload', '--port', port]
const child = spawn(bin, args, { cwd: BACKEND, stdio: 'inherit' })

// 부모(concurrently / 사용자 Ctrl+C)에서 신호를 받으면 자식에도 전달.
// 이 핸들러가 없으면 reloader 마스터만 죽고 worker 가 4750 을 계속 쥐고 있을 수 있다.
const forward = (sig) => {
  if (!child.killed) child.kill(sig)
}
process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))

child.on('exit', (code) => process.exit(code ?? 0))
