import test from 'tst'
import { is } from 'tst/assert.js'
import { readFileSync } from 'fs'
import { instantiate } from '../src/host.js'

// Load the pre-built watr.wasm from sibling project
const wasmBytes = readFileSync('/Users/div/projects/watr/watr.wasm')
const fakeCompile = () => wasmBytes
const result = instantiate(fakeCompile, '', { memoryPages: 4096 })

const parse = result.exports.parse
const print = result.exports.print
const compile = result.exports.compile

function instantiateWat(wat) {
  const ast = parse(wat)
  const printed = print(ast)
  const bin = new Uint8Array(compile(printed))
  const mod = new WebAssembly.Module(bin)
  return new WebAssembly.Instance(mod).exports
}

// Helper: compile WAT through jz-compiled watr, extract f64.const value
function f64Value(wat) {
  const ast = parse(wat)
  const printed = print(ast)
  const bin = new Uint8Array(compile(printed))
  const idx = bin.findIndex((b, i) => b === 0x44 && i > 20)
  const dv = new DataView(bin.buffer, bin.byteOffset + idx + 1, 8)
  return dv.getFloat64(0, true)
}

// ─── Bug 1 & 5: f64 decimal constant rounding after f32 compile ───
// Reproduces failures in const.wast and simd_const.wast.
// When an f32.const is compiled before an f64.const, jz-compiled watr
// reuses stale bytes from the previous f64 compile due to typed-array
// aliasing being miscompiled.
test('watr-regression: f64.const rounds correctly after f32.const compile', () => {
  // Prime internal state with first f64
  f64Value('(module (func (export "f") (result f64) (f64.const +5.3575430359313383891e+300)))')
  // Compile an f32 — this corrupts shared _buf state in jz-compiled encode.js
  const f32Ast = parse('(module (func (export "f") (result f32) (f32.const 1.5)))')
  const f32Printed = print(f32Ast)
  new Uint8Array(compile(f32Printed))
  // Now compile a different f64 — should get a distinct higher value
  const val = f64Value('(module (func (export "f") (result f64) (f64.const +5.3575430359313383892e+300)))')

  const buf = new ArrayBuffer(8), u8 = new Uint8Array(buf)
  u8.set([0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x60, 0x7e])
  const expected = new Float64Array(buf)[0]
  is(val, expected, `got ${val}, expected ${expected}`)
})

// ─── Bug 2: f64_dec.min_positive (float_literals.wast) ───
test('watr-regression: f64.const 4.94066e-324 reinterprets to i64.const 1', () => {
  const exports = instantiateWat(`(module
    (func (export "f64_dec.min_positive") (result i64)
      (i64.reinterpret_f64 (f64.const 4.94066e-324))))`)
  is(exports['f64_dec.min_positive'](), 1n)
})

// ─── Bug 3: ref_cast illegal cast (ref_cast.wast) ───
test('watr-regression: ref_cast.wast does not throw illegal cast', () => {
  const wat = `(module
    (type $t (func))
    (func (export "ref_cast_null") (param externref) (result externref)
      (ref.cast (ref null extern) (local.get 0))))`
  const exports = instantiateWat(wat)
  is(exports.ref_cast_null(null), null)
})

// ─── Bug 4: ref_test_null_data returns 2 (ref_test.wast) ───
test('watr-regression: ref_test_null_data(0) === 2', () => {
  const wat = `(module
    (type $t (func (param i32) (result i32)))
    (func (export "ref_test_null_data") (param $i i32) (result i32)
      (ref.test (ref null data) (ref.null data))))`
  const exports = instantiateWat(wat)
  is(exports.ref_test_null_data(0), 2)
})


