#!/usr/bin/env node
// One-time setup: create .venv, install Python+Node deps, copy .env.
import { spawnSync } from 'node:child_process'
import { existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { platform } from 'node:os'
import { resolve, join } from 'node:path'

const isWin = platform() === 'win32'
const ROOT = resolve(process.cwd())
const BACKEND = join(ROOT, 'backend')
const VENV = join(BACKEND, '.venv')
const PY_BIN = isWin ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python')
const ENV = join(BACKEND, '.env')
const ENV_EXAMPLE = join(BACKEND, '.env.example')

function run(cmd, args, opts = {}) {
  const label = [cmd, ...args].join(' ')
  console.log(`\n▸ ${label}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts })
  if (r.status !== 0) {
    console.error(`\n✘ failed: ${label}`)
    process.exit(r.status ?? 1)
  }
}

function findPython() {
  for (const cmd of ['python3', 'python']) {
    const r = spawnSync(cmd, ['--version'], { shell: isWin })
    if (r.status === 0) return cmd
  }
  console.error('✘ python 3.10+ 을 찾을 수 없습니다. https://www.python.org/ 에서 설치해주세요.')
  process.exit(1)
}

// 1) Python venv
if (!existsSync(VENV)) {
  const py = findPython()
  console.log(`→ ${VENV} 에 Python 가상환경 생성`)
  run(py, ['-m', 'venv', VENV])
} else {
  console.log('✓ .venv 이미 존재 — 건너뜀')
}

// 2) pip install
run(PY_BIN, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet'])
run(PY_BIN, ['-m', 'pip', 'install', '-r', join(BACKEND, 'requirements.txt')])

// 3) .env
if (!existsSync(ENV)) {
  if (existsSync(ENV_EXAMPLE)) {
    copyFileSync(ENV_EXAMPLE, ENV)
    console.log(`✓ backend/.env 생성 (.env.example 복사)`)
    console.log('  ↳ 편집해서 API 키를 입력하거나, 앱 내 설정 UI에서 입력해도 됩니다.')
  }
} else {
  console.log('✓ backend/.env 이미 존재 — 건너뜀')
}

// 4) npm install
if (!existsSync(join(ROOT, 'node_modules'))) {
  run(isWin ? 'npm.cmd' : 'npm', ['install'])
} else {
  console.log('✓ node_modules 이미 존재 — 건너뜀')
}

// 5) ~/vibe-notebooks (backend가 첫 요청 시 자동 생성하므로 필수는 아님)
try { mkdirSync(join(process.env.HOME || process.env.USERPROFILE || '', 'vibe-notebooks'), { recursive: true }) } catch {}

console.log('\n✅ 준비 완료!  `npm run dev` 로 시작하세요.')
