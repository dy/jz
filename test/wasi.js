// WASI and console.log tests
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run } from './util.js'
import { compile } from '../index.js'
import { writeFileSync } from 'fs'
import { execSync } from 'child_process'

// === console.log ===

test('console.log: string', () => {
  is(run(`export let f = () => { console.log("ok"); return 1 }`).f(), 1)
})

test('console.log: number', () => {
  is(run(`export let f = () => { console.log(42); return 1 }`).f(), 1)
})

test('console.log: multiple args', () => {
  is(run(`export let f = () => { console.log("x", 1, "y"); return 1 }`).f(), 1)
})

// === WASI native runtime tests ===

function hasCmd(cmd) { try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true } catch { return false } }

test('WASI: wasmtime native', () => {
  if (!hasCmd('wasmtime')) return
  const wasm = compile(`export let _start = () => { console.log("jz-wasmtime"); return 0 }`)
  writeFileSync('/tmp/jz_wasi_test.wasm', wasm)
  const out = execSync('wasmtime /tmp/jz_wasi_test.wasm 2>/dev/null', { encoding: 'utf-8' })
  ok(out.includes('jz-wasmtime'))
})

test('WASI: wasmer native', () => {
  if (!hasCmd('wasmer')) return
  const wasm = compile(`export let _start = () => { console.log("jz-wasmer"); return 0 }`)
  writeFileSync('/tmp/jz_wasi_test.wasm', wasm)
  const out = execSync('wasmer /tmp/jz_wasi_test.wasm 2>/dev/null', { encoding: 'utf-8' })
  ok(out.includes('jz-wasmer'))
})
