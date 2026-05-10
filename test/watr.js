import test from 'tst'
import { ok, is } from 'tst/assert.js'
import jz from '../index.js'
import nativeCompile from '../node_modules/watr/src/compile.js'
import { readFileSync, readdirSync } from 'fs'

const watrSrc = file => readFileSync(new URL(`../node_modules/watr/src/${file}`, import.meta.url), 'utf8')
const watrExample = file => readFileSync(new URL(`./watr-examples/${file}`, import.meta.url), 'utf8')

const ENTRY_MODULES = {
  './src/compile.js': watrSrc('compile.js'),
  './src/parse.js': watrSrc('parse.js'),
  './src/print.js': watrSrc('print.js'),
  './src/polyfill.js': watrSrc('polyfill.js'),
  './src/optimize.js': watrSrc('optimize.js'),
  './encode.js': watrSrc('encode.js'),
  './const.js': watrSrc('const.js'),
  './parse.js': watrSrc('parse.js'),
  './util.js': watrSrc('util.js'),
}

const COMPILE_MODULES = {
  './encode.js': watrSrc('encode.js'),
  './const.js': watrSrc('const.js'),
  './parse.js': watrSrc('parse.js'),
  './util.js': watrSrc('util.js'),
}

const watrJs = readFileSync(new URL('../node_modules/watr/watr.js', import.meta.url), 'utf8')
let topLevelCompile

function compiledWatr() {
  if (!topLevelCompile) {
    const inst = jz(watrJs, { jzify: true, modules: ENTRY_MODULES, memoryPages: 4096 })
    topLevelCompile = inst.exports.compile
  }
  return topLevelCompile
}

function sameWasm(name, wat, compile = compiledWatr()) {
  const jzBin = compile(wat)
  const nativeBin = nativeCompile(wat)
  ok(jzBin instanceof Uint8Array, `${name}: jz compile -> Uint8Array`)
  ok(nativeBin instanceof Uint8Array, `${name}: native compile -> Uint8Array`)
  if (jzBin.length !== nativeBin.length) {
    is(jzBin.length, nativeBin.length, `${name}: binary length`)
    return
  }
  for (let i = 0; i < jzBin.length; i++) {
    if (jzBin[i] !== nativeBin[i]) {
      is(jzBin[i], nativeBin[i], `${name}: byte ${i}`)
      return
    }
  }
  ok(true, `${name}: binary matches`)
}

const bugCases = [
  ['memory64 limits', 'BigInt limits encoded as zero', `(module
    (memory i64 1 1)
    (func (export "f") (result i64) (memory.size)))`],
  ['reexport func', 'Unknown func 1', `(module
    (export "f0" (func 0))
    (export "f1" (func 1))
    (import "math" "add" (func (param i32 i32) (result i32)))
    (func (param i32 i32) (result i32)
      (i32.sub (local.get 0) (local.get 1))))`],
  ['int literals', 'i64 constant out of range', `(module
    (func (export "i32.test") (result i32) (return (i32.const 0x0bAdD00D)))
    (func (export "i32.umax") (result i32) (return (i32.const 0xffffffff)))
    (func (export "i64.smax") (result i64) (return (i64.const 0x7fffffffffffffff)))
    (func (export "i64.smin") (result i64) (return (i64.const -0x8000000000000000))))`],
  ['float literals', 'memory access out of bounds', `(module
    (func (export "f32") (result i32) (i32.reinterpret_f32 (f32.const 6.28318548202514648)))
    (func (export "f64") (result i64) (i64.reinterpret_f64 (f64.const 6.28318530717958623))))`],
  ['call indirect case', 'table index out of bounds', `(module
    (type (func (param i32 i64) (result i64 i32)))
    (func $const-i32 (result i32) (i32.const 0x132))
    (table funcref (elem $const-i32))
    (func
      (drop (call_indirect (param i64) (result i32) (i64.const 0) (i32.const 0)))))`],
  ['bulk memory', 'assertion failure', `(module
    (memory 1 1)
    (data "abc")
    (func $x (result f64)
      (local i32)
      (memory.copy (local.get 0) (i32.const 0) (i32.const 16))
      (memory.fill (local.get 0) (i32.const 0) (i32.const 16))
      (memory.init 0 (local.get 0) (i32.const 0) (i32.const 16))))`],
  ['simd load/store', 'Unknown instruction 0', `(module
    (func (param $i i32) (result v128)
      (v128.load (local.get $i)))
    (func (param $i i32) (result v128)
      (v128.load align=1 (local.get $i)))
    (func (param $i i32) (result v128)
      (v128.load offset=1 align=1 (local.get $i))))`],
  ['simd const', 'assertion failure', `(module
    (global v128 (v128.const f32x4 1 1 1 1))
    (global v128 (v128.const i8x16 0xFF 0xFF 0xFF 0xFF -0x80 -0x80 -0x80 -0x80 255 255 255 255 -128 -128 -128 -128))
    (global v128 (v128.const i32x4 0xffffffff -0x80000000 4_294_967_295 0x0_9acf_fBDF)))`],
  ['simd shuffle/swizzle/splat', 'assertion failure', `(module (func
    (i8x16.shuffle 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
      (v128.const f32x4 0 1 2 3) (v128.const f32x4 0 1 2 3))
    (i8x16.swizzle (v128.load (i32.const 0)) (v128.load offset=15 (i32.const 1)))
    (i8x16.splat (i32.const 0))
    (i16x8.splat (i32.const 0))
    (i32x4.splat (i32.const 0))
    (f32x4.splat (i32.const 0))
    (i64x2.splat (i32.const 0))
    (f64x2.splat (i32.const 0))))`],
  ['simd f32x4', 'memory access out of bounds', `(module
    (func (export "f32x4.min") (param v128 v128) (result v128)
      (f32x4.min (local.get 0) (local.get 1)))
    (func (export "f32x4.max") (param v128 v128) (result v128)
      (f32x4.max (local.get 0) (local.get 1))))`],
  ['simd f64x2', 'memory access out of bounds', `(module
    (func (export "f64x2.min") (param v128 v128) (result v128)
      (f64x2.min (local.get 0) (local.get 1)))
    (func (export "f64x2.max") (param v128 v128) (result v128)
      (f64x2.max (local.get 0) (local.get 1))))`],
  ['simd i16x8', 'Unknown instruction -32768', `(module
    (func (export "i16x8.add") (param v128 v128) (result v128)
      (i16x8.add (local.get 0) (local.get 1)))
    (func (export "i16x8.sub") (param v128 v128) (result v128)
      (i16x8.sub (local.get 0) (local.get 1))))`],
  ['simd i32x4 basic ops', 'Unknown instruction -2147483648', `(module
    (func (export "i32x4.add") (param v128 v128) (result v128)
      (i32x4.add (local.get 0) (local.get 1)))
    (func (export "i32x4.sub") (param v128 v128) (result v128)
      (i32x4.sub (local.get 0) (local.get 1))))`],
  ['simd i64x2', 'Unknown instruction -9223372036854775808', `(module
    (func (export "i64x2.add") (param v128 v128) (result v128)
      (i64x2.add (local.get 0) (local.get 1)))
    (func (export "i64x2.sub") (param v128 v128) (result v128)
      (i64x2.sub (local.get 0) (local.get 1))))`],
  ['function refs', 'invalid local index', `(module
    (type $t (func (result i32)))
    (func $nn (param $r (ref $t)) (result i32)
      (call_ref $t
        (block $l (result (ref $t))
          (br_on_non_null $l (local.get $r))
          (return (i32.const -1))))))`],
  ['rec types', 'no signature at index 0', `(module
    (rec (type $f1 (func)) (type (struct)))
    (rec (type (struct)) (type $f2 (func)))
    (table funcref (elem $f1))
    (func $f1 (type $f1))
    (func (export "run") (call_indirect (type $f2) (i32.const 0))))`],
  ['array', 'invalid data segment index', `(module
    (type $vec (array i8))
    (type $mvec (array (mut i8)))
    (global $g (ref $vec) (array.new_default $vec (i32.const 10)))
    (func (export "len") (result i32)
      (array.len (global.get $g))))`],
  ['memory.init with index', 'invalid data segment index', `(module
    (memory $mem1 1)
    (memory $mem2 1)
    (data $d "hello")
    (func (export "init")
      (memory.init $mem1 $d (i32.const 0) (i32.const 0) (i32.const 5)))
    (func (export "load_mem1") (param i32) (result i32)
      (i32.load8_u (local.get 0))))`],
  ['float hex', 'assertion failure', `(module (func (f64.const 0x1p+0) (f64.const -0x1.7f00a2d80faabp-35)))`],
]

for (const [name, reason, wat] of bugCases) {
  test(`watr bug: ${name} - ${reason}`, () => sameWasm(name, wat))
}

test('watr bug: custom sections - custom section not found', () => {
  const bin = compiledWatr()(`(module
    (@custom "my-section" "hello")
    (func (export "answer") (result i32) (i32.const 42)))`)
  ok(new WebAssembly.Module(bin) instanceof WebAssembly.Module)
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bin))
  is(inst.exports.answer(), 42)
})

test('watr bug: branch hints - branch hints section not found', () => {
  const bin = compiledWatr()(`(module
    (func (export "test") (param i32) (result i32)
      (block (result i32)
        (i32.const 10)
        (@metadata.code.branch_hint "\\00")
        (br_if 0 (local.get 0))
        (drop)
        (i32.const 20))))`)
  ok(new WebAssembly.Module(bin) instanceof WebAssembly.Module)
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bin))
  is(inst.exports.test(0), 20)
  is(inst.exports.test(1), 10)
})

test('watr: top-level package entry compiles', () => {
  const compiled = jz.compile(watrJs, { jzify: true, modules: ENTRY_MODULES })
  ok(compiled instanceof Uint8Array, 'top-level watr entry compiles to wasm bytes')
  ok(new WebAssembly.Module(compiled) instanceof WebAssembly.Module, 'top-level watr output is valid wasm')
})

test('watr: top-level package entry instantiates', () => {
  const compiled = compiledWatr()('(module (func))')
  ok(compiled instanceof Uint8Array, 'top-level watr compile export returns wasm bytes')
  ok(new WebAssembly.Module(compiled) instanceof WebAssembly.Module, 'compiled bytes are valid wasm')
})

test('watr: compiled print.js prints module text', () => {
  const inst = jz(watrSrc('print.js'), {
    jzify: true,
    modules: {
      './parse.js': watrSrc('parse.js'),
      './util.js': watrSrc('util.js'),
    },
  })
  is(inst.exports.default('(module)'), '(module)')
})

test('Map.set: omitted value stores undefined and keeps key present', () => {
  const { exports } = jz(`
    export let f = () => {
      const m = new Map()
      m.set('x')
      return m.has('x') && m.get('x') === undefined
    }
  `, { jzify: true })
  is(exports.f(), 1)
})

test('watr: compiled compile.js handles empty func module', async () => {
  const inst = await jz(watrSrc('compile.js'), { jzify: true, modules: COMPILE_MODULES })
  sameWasm('empty func module', '(module (func))', inst.exports.default)
})

test('watr optimizer: CSE places local.set before first use', () => {
  const { exports } = jz(`
    const err = (m) => { throw m }
    const isMemParam = n => n?.[0] === 'a'
    export const a1 = (args) => {
      let align, k, v
      while (isMemParam(args[0])) { k = '='; v = '1'; align = +v }
      if (align <= 0 || align > 0xffffffff) err('Bad align ' + align)
      if (align) 1 && err('Bad align ')
      return 'ok'
    }
  `)
  is(exports.a1([]), 'ok')
})

test('watr optimizer: const-prop invalidates on nested local.tee writes', () => {
  const { exports } = jz(`
    export const f = (x) => (x = x * 2) + 0
  `)
  is(exports.f(3), 6)
})

test('jz: f64rem does not duplicate side effects in operands', () => {
  const { exports } = jz(`
    export const f = (x) => { let a = x; return (a = Math.log2(a)) % 1 }
  `)
  is(exports.f(8), 0)
})

test('watr metacircular: jz-built watr.wasm produces byte-identical output', async () => {
  const inst = await jz(watrSrc('compile.js'), {
    jzify: true,
    memory: 4096,
    modules: COMPILE_MODULES,
  })
  const jzCompile = inst.exports.default
  ok(typeof jzCompile === 'function', 'watr.wasm exports default compile()')

  const dir = new URL('./watr-examples/', import.meta.url)
  const files = readdirSync(dir).filter(f => f.endsWith('.wat')).sort()
  ok(files.length > 0, 'vendored watr-examples present')

  for (const file of files) {
    const src = watrExample(file)
    const jsOut = nativeCompile(src)
    const jzOut = jzCompile(src)
    is(jzOut.length, jsOut.length, `${file}: length match`)
    let diff = -1
    for (let i = 0; i < jsOut.length; i++) if (jsOut[i] !== jzOut[i]) { diff = i; break }
    is(diff, -1, `${file}: byte-identical (first diff at ${diff})`)
  }
})

// ─── jz-compiled watr regression tests ───
// These exercise the full jz→watr pipeline (parse + print + compile) and
// reproduce actual bugs that only manifest when watr is compiled by jz.

let topLevelInstance

function compiledWatrInstance() {
  if (!topLevelInstance) {
    const inst = jz(watrJs, { jzify: true, modules: ENTRY_MODULES, memoryPages: 4096 })
    topLevelInstance = inst.exports
  }
  return topLevelInstance
}

function instantiateWat(wat) {
  const { parse, print, compile } = compiledWatrInstance()
  const ast = parse(wat)
  const printed = print(ast)
  const bin = new Uint8Array(compile(printed))
  const mod = new WebAssembly.Module(bin)
  return new WebAssembly.Instance(mod).exports
}

function f64Value(wat) {
  const { parse, print, compile } = compiledWatrInstance()
  const ast = parse(wat)
  const printed = print(ast)
  const bin = new Uint8Array(compile(printed))
  const idx = bin.findIndex((b, i) => b === 0x44 && i > 20)
  const dv = new DataView(bin.buffer, bin.byteOffset + idx + 1, 8)
  return dv.getFloat64(0, true)
}

test('watr-regression: f64.const rounds correctly after f32.const compile', () => {
  // Prime internal state with first f64
  f64Value('(module (func (export "f") (result f64) (f64.const +5.3575430359313383891e+300)))')
  // Compile an f32 — this used to corrupt shared _buf state in jz-compiled encode.js
  const { parse, print, compile } = compiledWatrInstance()
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

test('watr-regression: f64.const 4.94066e-324 reinterprets to i64.const 1', () => {
  const exports = instantiateWat(`(module
    (func (export "f64_dec.min_positive") (result i64)
      (i64.reinterpret_f64 (f64.const 4.94066e-324))))`)
  is(exports['f64_dec.min_positive'](), 1n)
})

test('watr-regression: ref_cast.wast does not throw illegal cast', () => {
  const wat = `(module
    (type $t (func))
    (func (export "ref_cast_null") (param externref) (result externref)
      (ref.cast (ref null extern) (local.get 0))))`
  const exports = instantiateWat(wat)
  is(exports.ref_cast_null(null), null)
})

test('watr-regression: ref_test_null_data(0) === 1', () => {
  const wat = `(module
    (type $t (func (param i32) (result i32)))
    (func (export "ref_test_null_data") (param $i i32) (result i32)
      (ref.test (ref null data) (ref.null data))))`
  const exports = instantiateWat(wat)
  is(exports.ref_test_null_data(0), 1)
})
