#!/usr/bin/env node
// Run the FastAPI backend using the venv's uvicorn binary (no shell sourcing needed).
import { spawn } from 'node:child_process'
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
const args = ['main:app', '--reload', '--port', port]
const child = spawn(bin, args, { cwd: BACKEND, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
