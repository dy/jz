// Performance regression tests — jz WASM must be competitive with JS
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import jz, { compile } from '../index.js'

// Helper: time N iterations, return ms
function bench(fn, n) {
  // Warmup
  for (let i = 0; i < Math.min(n, 100); i++) fn()
  const t = performance.now()
  for (let i = 0; i < n; i++) fn()
  return performance.now() - t
}

// === Correctness + codegen quality tests ===

test('perf: fib(30) — WASM faster than JS', () => {
  const { exports: { fib } } = jz('export let fib = (n) => n <= 1 ? n : fib(n-1) + fib(n-2)')
  const jsFib = n => n <= 1 ? n : jsFib(n - 1) + jsFib(n - 2)

  is(fib(30), 832040)
  is(jsFib(30), 832040)

  const N = 5
  const jsTime = bench(() => jsFib(30), N)
  const wasmTime = bench(() => fib(30), N)
  console.log(`  fib(30) x${N}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  ok(wasmTime < jsTime * 1.5, `fib: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.5`)
})

test('perf: mandelbrot — WASM competitive with JS', () => {
  const { exports: { mandelbrot } } = jz('export let mandelbrot = (cx, cy, max) => { let zx = 0, zy = 0, i = 0; while (zx*zx + zy*zy < 4 && i < max) { let tx = zx*zx - zy*zy + cx; zy = 2*zx*zy + cy; zx = tx; i++ } return i }')
  const jsMandelbrot = (cx, cy, max) => { let zx = 0, zy = 0, i = 0; while (zx*zx + zy*zy < 4 && i < max) { let tx = zx*zx - zy*zy + cx; zy = 2*zx*zy + cy; zx = tx; i++ } return i }

  is(mandelbrot(-0.5, 0.5, 100), jsMandelbrot(-0.5, 0.5, 100))
  is(mandelbrot(0, 0, 1000), jsMandelbrot(0, 0, 1000))

  const N = 200000
  const jsTime = bench(() => jsMandelbrot(-0.5, 0.5, 100), N)
  const wasmTime = bench(() => mandelbrot(-0.5, 0.5, 100), N)
  console.log(`  mandelbrot x${N}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  ok(wasmTime < jsTime * 2, `mandelbrot: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 2`)
})

test('perf: typed array sum — WASM competitive', () => {
  const { exports: { sum }, memory } = jz(`
    export let sum = (arr) => {
      let buf = new Float64Array(arr)
      let s = 0
      for (let i = 0; i < buf.length; i++) s += buf[i]
      return s
    }
  `)
  const N = 10000
  const data = new Float64Array(N)
  for (let i = 0; i < N; i++) data[i] = i * 0.1
  const wasmArr = memory.Float64Array(data)

  const jsSum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }
  const expected = jsSum(data)
  const got = sum(wasmArr)
  ok(Math.abs(got - expected) < 1e-6, `sum: ${got} ~ ${expected}`)

  const ITERS = 500
  const jsTime = bench(() => jsSum(data), ITERS)
  const wasmTime = bench(() => sum(wasmArr), ITERS)
  console.log(`  typed sum (${N}) x${ITERS}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  ok(wasmTime < jsTime * 3, `typed sum: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 3`)
})

// === Codegen quality assertions ===

test('codegen: boolean propagation — no __is_truthy on comparisons', () => {
  const wat = compile('export let f = (a, b) => { while (a < b && b > 0) { a++; b-- } return a }', { wat: true })
  // Comparisons in && should not need __is_truthy
  const trustyCalls = (wat.match(/__is_truthy/g) || []).length
  ok(trustyCalls === 0, `expected 0 __is_truthy calls in boolean &&, got ${trustyCalls}`)
})

test('codegen: i++ void context — no subtract-and-drop', () => {
  const wat = compile('export let f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s }', { wat: true })
  // Should not contain (i32.sub ... (i32.const 1)) pattern from postfix desugaring
  // Check there's no "i32.sub" followed shortly by "drop" for the loop counter
  const subDrops = wat.match(/i32\.sub[\s\S]{0,20}i32\.const 1[\s\S]{0,20}drop/g)
  ok(!subDrops, `expected no sub-1-drop pattern, got ${subDrops?.length || 0}`)
})

test('codegen: asF64 on int constants — no unnecessary convert', () => {
  const wat = compile('export let f = (x) => { let s = 0; s = x * 2; return s }', { wat: true })
  // `0` and `2` in f64 context should emit f64.const, not f64.convert_i32_s(i32.const N)
  // Count f64.convert_i32_s of i32.const (the specific bad pattern)
  const converts = (wat.match(/f64\.convert_i32_s[\s\S]{0,30}i32\.const/g) || []).length
  ok(converts === 0, `expected 0 const-int-to-f64 converts, got ${converts}`)
})

test('codegen: for-loop counter matches .length type — no converts in loop', () => {
  const wat = compile('export let f = (arr) => { let buf = new Float64Array(arr); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i]; return s }', { wat: true })
  // .length emits as f64, so i should be f64 to avoid per-iter convert
  const loopMatch = wat.match(/\(loop[^]*?\(br \$loop/s)
  if (loopMatch) {
    const converts = (loopMatch[0].match(/f64\.convert_i32/g) || []).length
    ok(converts === 0, `expected 0 i32->f64 converts inside loop, got ${converts}`)
  }
})

test('codegen: loop counter widens to f64 when compared to f64 param', () => {
  const wat = compile('export let f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s }', { wat: true })
  // When compared against f64 param n, i should be f64 to avoid per-iter convert
  ok(wat.includes('(local $i f64)'), 'loop counter i should be f64 when compared to f64 param')
})

test('codegen: pure scalar function — minimal binary', () => {
  const wasm = compile('export let add = (a, b) => a + b')
  // Pure scalar: no arrays, strings, objects. Should be tiny.
  ok(wasm.byteLength < 150, `pure scalar add should be < 150 bytes, got ${wasm.byteLength}`)
})

test('compile profile reports phase timings', () => {
  const profile = {}
  const wasm = compile('export let add = (a, b) => a + b', { profile })
  ok(wasm.byteLength > 0, 'compile still returns wasm bytes')
  for (const name of ['parse', 'prepare', 'compile', 'plan', 'watrCompile'])
    ok(typeof profile.totals?.[name] === 'number', `expected ${name} timing`)
  ok(profile.totals.compile >= profile.totals.plan, 'compile timing should include plan timing')
})

test('codegen: .length hoisted out of for-loop', () => {
  const wat = compile('export let f = (arr) => { let buf = new Float64Array(arr); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i]; return s }', { wat: true })
  // Scope to user function $f, then find its outer for-loop body
  const fMatch = wat.match(/\(func \$f[\s\S]*?^\s\s\)$/m)
  ok(fMatch, 'expected $f function in WAT')
  const loopMatch = fMatch[0].match(/\(loop[^]*?\(br(_if)? \$loop/s)
  if (loopMatch) {
    const lenCalls = (loopMatch[0].match(/__len|__length/g) || []).length
    ok(lenCalls === 0, `expected 0 __len calls inside loop body, got ${lenCalls}`)
  }
})

// === Golden size tests ===
// Snapshot WASM byte count for representative shapes. Catches accidental stdlib
// or feature-gate regressions. On improvement, update the baseline; the printed
// "actual N" makes drift visible.
//
// Tolerance is ±5% rounded to nearest 10 bytes (min 20). Tight enough to catch
// regressions, loose enough to absorb harmless codegen jitter.
const golden = (name, src, expected) => test(`golden size: ${name}`, () => {
  const wasm = compile(src)
  const actual = wasm.byteLength
  const tol = Math.max(20, Math.round(expected * 0.05 / 10) * 10)
  ok(Math.abs(actual - expected) <= tol,
    `${name}: expected ${expected}±${tol} bytes, got ${actual}`)
})

golden('known-shape object', 'export let f = (x) => { let p = { x: x, y: x * 2, z: x + 1 }; return p.x + p.y + p.z }', 3306)
golden('unknown/dynamic object', 'export let f = (k) => { let p = {}; p[k] = 1; p.b = 2; return p[k] + p.b }', 6072)
golden('closure-heavy parser', `export let f = (s) => {
  let i = 0, n = s.length
  let peek = () => i < n ? s[i] : ''
  let next = () => { let c = peek(); i++; return c }
  let isDigit = (c) => c >= '0' && c <= '9'
  let total = 0
  while (i < n) { let c = next(); if (isDigit(c)) total = total * 10 + (c.charCodeAt(0) - 48) }
  return total
}`, 3034)
golden('typed-array loop', `export let f = (arr) => {
  let buf = new Float64Array(arr)
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * 2
  return s
}`, 937)
