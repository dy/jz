// Bounded subprocess runner. Logs go to disk, not an ever-growing parent string.
// A timeout or cancellation kills the process group, including nested builders.
import { spawn } from 'node:child_process'
import { openSync, closeSync, readSync, fstatSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function positiveInteger(value, name) {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`)
  return n
}

export async function runTasks(tasks, {
  jobs = positiveInteger(process.env.JZ_TEST_JOBS || 1, 'JZ_TEST_JOBS'),
  timeout = positiveInteger(process.env.JZ_TEST_TIMEOUT || 3_600_000, 'JZ_TEST_TIMEOUT'),
  logDir = mkdtempSync(join(tmpdir(), 'jz-tests-')),
  cwd = process.cwd(),
} = {}) {
  positiveInteger(jobs, 'jobs'); positiveInteger(timeout, 'timeout')
  if (new Set(tasks.map(t => t.name)).size !== tasks.length) throw new Error('Duplicate task name')
  for (const t of tasks) {
    if (!/^[\w-]+$/.test(t.name)) throw new Error(`Invalid task name '${t.name}'`)
    if (t.timeout != null) positiveInteger(t.timeout, 'task timeout')
  }
  const active = new Map(), results = new Array(tasks.length)
  let next = 0, cancelled = false
  const kill = (p, signal) => {
    if (!p.pid) return
    try { process.platform === 'win32' ? p.kill(signal) : process.kill(-p.pid, signal) }
    catch (e) { if (e.code !== 'ESRCH') throw e }
  }
  const cancel = () => {
    cancelled = true
    for (const stop of active.values()) stop()
  }
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  console.log(`test logs: ${logDir} (jobs=${jobs})`)
  const run = task => new Promise(resolve => {
    const started = performance.now(), path = join(logDir, `${task.name}.log`)
    const fd = openSync(path, 'w')
    const env = { ...process.env, TST_FORMAT: 'tap', ...task.env }
    for (const k of Object.keys(env)) if (env[k] == null) delete env[k]
    let p
    try {
      p = spawn(task.command || process.execPath, task.args, {
        cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd],
      })
    } finally { closeSync(fd) }
    let error = null, timedOut = false, stopped
    const stop = () => stopped ||= new Promise(done => {
      kill(p, 'SIGTERM')
      // Do not cancel this when the parent exits: a grandchild may ignore TERM.
      setTimeout(() => { kill(p, 'SIGKILL'); done() }, 2000)
    })
    active.set(p, stop)
    p.on('error', e => { error = e.message })
    const timer = setTimeout(() => { timedOut = true; stop() }, task.timeout || timeout)
    p.on('close', async (code, signal) => {
      clearTimeout(timer)
      if (stopped) await stopped
      active.delete(p)
      const result = { name: task.name, code: error || timedOut || signal || cancelled ? 1 : code ?? 1, signal, error, timedOut, log: path, ms: performance.now() - started }
      console.log(`${result.code ? 'FAIL' : 'PASS'} ${task.name} ${(result.ms / 1000).toFixed(1)}s${timedOut ? ' (timeout)' : ''}${error ? ': ' + error : ''}`)
      if (result.code) {
        const fd = openSync(path, 'r')
        try {
          const n = Math.min(4096, fstatSync(fd).size), tail = Buffer.alloc(n)
          readSync(fd, tail, 0, n, fstatSync(fd).size - n)
          console.error(`${tail}\nlog: ${path}`)
        } finally { closeSync(fd) }
      }
      resolve(result)
    })
  })
  try {
    await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
      while (!cancelled && next < tasks.length) {
        const i = next++
        try { results[i] = await run(tasks[i]) }
        catch (e) { results[i] = { name: tasks[i].name, code: 1, error: e.message }; console.error(e) }
      }
    }))
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel)
  }
  return tasks.map((t, i) => results[i] || { name: t.name, code: 1, skipped: true, error: 'cancelled' })
}

// Every leg starts with a clean matrix environment; explicit task options win.
export const legEnv = (env = {}) => ({
  JZ_TEST_OPTIMIZE: undefined, JZ_TEST_HOST: undefined, JZ_TEST_TARGET: undefined,
  JZ_TEST_SWEEP: undefined, JZ_DEBUG_INVARIANTS: undefined, JZ_KERNEL: undefined,
  JZ_SELF_TEST_KERNEL: undefined, JZ_SELF_TEST_KERNEL_SHA256: undefined, ...env,
})
export const matrixTasks = (suite = 'core') => [
  { name: `${suite}-default`, args: ['test/index.js', `--suite=${suite}`], env: legEnv() },
  { name: `${suite}-opt0`, args: ['test/index.js', `--suite=${suite}`], env: legEnv({ JZ_TEST_OPTIMIZE: '0' }) },
  { name: `${suite}-opt3`, args: ['test/index.js', `--suite=${suite}`], env: legEnv({ JZ_TEST_OPTIMIZE: '3' }) },
  { name: `${suite}-wasi`, args: ['test/index.js', `--suite=${suite}`], env: legEnv({ JZ_TEST_HOST: 'wasi' }) },
]
export const invariantTask = (suite = 'core') => ({ name: `${suite}-invariants`, args: ['test/index.js', `--suite=${suite}`], env: legEnv({ JZ_TEST_OPTIMIZE: '3', JZ_DEBUG_INVARIANTS: '1' }) })
export const extendedTasks = () => [
  ...matrixTasks('integration'),
  { name: 'generated-default', args: ['test/index.js', '--suite=generated'], env: legEnv() },
  { name: 'generated-wasi', args: ['test/index.js', '--suite=generated'], env: legEnv({ JZ_TEST_HOST: 'wasi' }) },
]
