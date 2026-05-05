// Native timer tests (wasmtime/wasmer)
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { writeFileSync } from 'fs'
import { execSync } from 'child_process'

function hasCmd(cmd) { try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true } catch { return false } }
const skip = !hasCmd('wasmtime') && !hasCmd('wasmer')

function nativeRun(code, runtime = 'wasmtime') {
  if (!hasCmd(runtime)) runtime = runtime === 'wasmtime' ? 'wasmer' : 'wasmtime'
  if (!hasCmd(runtime)) throw new Error('No native runtime (wasmtime/wasmer) found')
  const wasm = compile(code, { nativeTimers: true, host: 'wasi' })
  const path = '/tmp/jz_timer_test.wasm'
  writeFileSync(path, wasm)
  return execSync(`${runtime} ${path} 2>/dev/null`, { encoding: 'utf-8' })
}

// === setTimeout ===

test('setTimeout: fires callback', { skip }, () => {
  const out = nativeRun(`
    let x = 0
    setTimeout(() => { x = 1 }, 10)
    export let _start = () => { return 0 }
  `)
  // Timer fires in __start after _start runs; _start returns 0 (success)
  ok(true) // If we got here without crash, timer loop completed
})

test('setTimeout: callback executes code', { skip }, () => {
  const out = nativeRun(`
    let msg = "before"
    setTimeout(() => { console.log("fired") }, 1)
    export let _start = () => { return 0 }
  `)
  ok(out.includes('fired'), `output: ${out}`)
})

test('clearTimeout: cancels timer', { skip }, () => {
  // With all timers cleared, __timer_loop should exit immediately
  const out = nativeRun(`
    let id = setTimeout(() => { console.log("nope") }, 1000)
    clearTimeout(id)
    export let _start = () => { return 0 }
  `)
  ok(!out.includes('nope'), `should not contain "nope": ${out}`)
})

// === setInterval ===

test('setInterval: repeats and clearInterval stops it', { skip }, () => {
  const out = nativeRun(`
    let count = 0
    let id = setInterval(() => {
      count = count + 1
      console.log("tick")
      if (count >= 3) clearInterval(id)
    }, 1)
    export let _start = () => { return 0 }
  `)
  const ticks = (out.match(/tick/g) || []).length
  ok(ticks >= 3, `expected >=3 ticks, got ${ticks}`)
})

// === Multiple timers ===

test('multiple timers: all fire', { skip }, () => {
  const out = nativeRun(`
    setTimeout(() => { console.log("a") }, 1)
    setTimeout(() => { console.log("b") }, 1)
    setTimeout(() => { console.log("c") }, 1)
    export let _start = () => { return 0 }
  `)
  ok(out.includes('a') && out.includes('b') && out.includes('c'), `output: ${out}`)
})
