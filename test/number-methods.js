// Number method tests
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run } from './util.js'
import compile from '../index.js'
import { writeFileSync } from 'fs'
import { execSync } from 'child_process'

// === toString ===

test('Number: toString integer', () => {
  is(run(`export let f = () => { let n = 42; return n.toString().length }`).f(), 2)
})

test('Number: toString zero', () => {
  is(run(`export let f = () => { let n = 0; return n.toString().length }`).f(), 1)
})

test('Number: toString negative', () => {
  is(run(`export let f = () => { let n = -7; return n.toString().length }`).f(), 2)
})

test('Number: toString float', () => {
  is(run(`export let f = () => { let n = 1.5; return n.toString().length }`).f(), 3)
})

test('Number: toString large', () => {
  is(run(`export let f = () => { let n = 123456; return n.toString().length }`).f(), 6)
})

test('Number: toString NaN', () => {
  is(run(`export let f = () => (0/0).toString().length`).f(), 3)  // "NaN"
})

test('Number: toString Infinity', () => {
  is(run(`export let f = () => (1/0).toString().length`).f(), 8)  // "Infinity"
})

test('Number: toString -Infinity', () => {
  is(run(`export let f = () => (-1/0).toString().length`).f(), 9)  // "-Infinity"
})

// === toFixed ===

test('Number: toFixed(2)', () => {
  is(run(`export let f = () => { let n = 3.14159; return n.toFixed(2).length }`).f(), 4)  // "3.14"
})

test('Number: toFixed(0) rounds', () => {
  is(run(`export let f = () => { let n = 3.7; return n.toFixed(0).length }`).f(), 1)  // "4"
})

test('Number: toFixed(3) pads', () => {
  is(run(`export let f = () => { let n = 1; return n.toFixed(3).length }`).f(), 5)  // "1.000"
})

// === String() coercion ===

test('Number: String(42)', () => {
  is(run(`export let f = () => String(42).length`).f(), 2)
})

test('Number: String(0)', () => {
  is(run(`export let f = () => String(0).length`).f(), 1)
})

// === Expression .toString() ===

test('Number: (1+2).toString()', () => {
  is(run(`export let f = () => (1+2).toString().length`).f(), 1)  // "3"
})

// === String methods: charAt, charCodeAt, at ===

test('String: charAt', () => {
  is(run(`export let f = () => "hello".charAt(1).charCodeAt(0)`).f(), 101)  // 'e'
})

test('String: charCodeAt', () => {
  is(run(`export let f = () => "ABC".charCodeAt(0)`).f(), 65)
})

test('String: charCodeAt(2)', () => {
  is(run(`export let f = () => "ABC".charCodeAt(2)`).f(), 67)
})

test('String: at positive', () => {
  is(run(`export let f = () => "hello".at(0).charCodeAt(0)`).f(), 104)  // 'h'
})

test('String: at negative', () => {
  is(run(`export let f = () => "hello".at(-1).charCodeAt(0)`).f(), 111)  // 'o'
})

// === console.log (WASI fd_write) ===

test('console.log: string', () => {
  is(run(`export let f = () => { console.log("ok"); return 1 }`).f(), 1)
})

test('console.log: number', () => {
  is(run(`export let f = () => { console.log(42); return 1 }`).f(), 1)
})

test('console.log: multiple args', () => {
  is(run(`export let f = () => { console.log("x", 1, "y"); return 1 }`).f(), 1)
})

// === Template literal coercion ===

test('Template: number interpolation', () => {
  is(run('export let f = () => `n=${42}`.length').f(), 4)  // "n=42"
})

test('Template: multiple interpolations', () => {
  is(run('export let f = () => `${1}+${2}=${1+2}`.length').f(), 5)  // "1+2=3"
})

test('Template: string var interpolation', () => {
  is(run('export let f = () => { let s = "world"; return `hello ${s}`.length }').f(), 11)
})

test('Template: float interpolation', () => {
  is(run('export let f = () => `pi=${3.14}`.length').f(), 7)  // "pi=3.14"
})

// === toExponential ===

test('Number: toExponential(2)', () => {
  is(run(`export let f = () => { let n = 123; return n.toExponential(2).length }`).f(), 7)  // "1.23e+2"
})

test('Number: toExponential(0)', () => {
  is(run(`export let f = () => { let n = 5; return n.toExponential(0).length }`).f(), 4)  // "5e+0"
})

test('Number: toExponential small', () => {
  is(run(`export let f = () => { let n = 0.0042; return n.toExponential(1).length }`).f(), 6)  // "4.2e-3"
})

// === toPrecision ===

test('Number: toPrecision(5) fixed', () => {
  is(run(`export let f = () => { let n = 123; return n.toPrecision(5).length }`).f(), 6)  // "123.00"
})

test('Number: toPrecision(2) exponential', () => {
  is(run(`export let f = () => { let n = 123; return n.toPrecision(2).length }`).f(), 6)  // "1.2e+2"
})

test('Number: toPrecision(3) float', () => {
  is(run(`export let f = () => { let n = 1.5; return n.toPrecision(3).length }`).f(), 4)  // "1.50"
})

// === Large numbers ===

test('Number: toString large int', () => {
  is(run(`export let f = () => { let n = 9999999999; return n.toString().length }`).f(), 10)
})

test('Number: toString 1e15', () => {
  is(run(`export let f = () => { let n = 1000000000000000; return n.toString().length }`).f(), 16)
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
