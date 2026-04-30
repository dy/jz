import { spawn } from 'node:child_process'

const [, , timeoutArg, ...command] = process.argv
const timeoutMs = Number(timeoutArg)

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || command.length === 0) {
  console.error('Usage: node scripts/timebox.mjs <timeout-ms> <command> [args...]')
  process.exit(2)
}

const child = spawn(command[0], command.slice(1), {
  stdio: 'inherit',
  detached: process.platform !== 'win32',
})

const killChild = () => {
  if (process.platform === 'win32') {
    child.kill('SIGKILL')
    return
  }

  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

const timer = setTimeout(() => {
  console.error(`\nTimed out after ${timeoutMs}ms; killing process group`)
  killChild()
  process.exit(124)
}, timeoutMs)

child.on('exit', (code, signal) => {
  clearTimeout(timer)

  if (signal) {
    console.error(`Command exited via signal ${signal}`)
    process.exit(1)
  }

  process.exit(code ?? 0)
})

child.on('error', err => {
  clearTimeout(timer)
  console.error(err.message)
  process.exit(1)
})