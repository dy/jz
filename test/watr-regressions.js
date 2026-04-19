import test from 'tst'
import { ok, is } from 'tst/assert.js'
import jz from '../index.js'
import nativeCompile from '../node_modules/watr/src/compile.js'
import { readFileSync } from 'fs'

const watrSrc = file => readFileSync(new URL(`../node_modules/watr/src/${file}`, import.meta.url), 'utf8')

test('watr: compiled compile.js handles empty func module', async () => {
  const inst = await jz(watrSrc('compile.js'), {
    jzify: true,
    modules: {
      './encode.js': watrSrc('encode.js'),
      './const.js': watrSrc('const.js'),
      './parse.js': watrSrc('parse.js'),
      './util.js': watrSrc('util.js'),
    }
  })

  const compiled = inst.exports.default('(module (func))')
  const native = nativeCompile('(module (func))')

  ok(compiled instanceof Uint8Array, 'compiled watr returns wasm bytes')
  ok(new WebAssembly.Module(compiled) instanceof WebAssembly.Module, 'compiled watr output is valid wasm')
  is(compiled.length, native.length)
})

// Regression: watr CSE used offset-arithmetic to locate the first use of a
// shared subexpression. When an earlier candidate inserted its set AFTER a
// later candidate's first use, the offset over-counted and the set landed
// after its first use — reading the uninitialized default (0) instead.
// Exposed by memarg-like code where `let align` is read before a while loop
// that never executes; align leaked as 0 instead of undefined/NaN.
test('watr optimizer: CSE places local.set before first use', () => {
  const src = `
    const err = (m) => { throw m }
    const isMemParam = n => n?.[0] === 'a'
    export const a1 = (args) => {
      let align, k, v
      while (isMemParam(args[0])) { k = '='; v = '1'; align = +v }
      if (align <= 0 || align > 0xffffffff) err('Bad align ' + align)
      if (align) 1 && err('Bad align ')
      return 'ok'
    }
  `
  const { exports } = jz(src)
  is(exports.a1([]), 'ok')
})

// Regression: watr optimizer's constant-propagation pass did not invalidate
// known values when a nested local.tee rewrote the same local inside an
// expression, folding later local.get to a stale constant.
test('watr optimizer: const-prop invalidates on nested local.tee writes', () => {
  const { exports } = jz(`
    export const f = (x) => (x = x * 2) + 0
  `)
  is(exports.f(3), 6)
})

// Regression: jz's f64rem expansion inlined both operands twice, so side
// effects in the left operand (assignments) executed twice (log2 applied
// twice in memarg: `(align = Math.log2(align)) % 1`).
test('jz: f64rem does not duplicate side effects in operands', () => {
  const { exports } = jz(`
    export const f = (x) => { let a = x; return (a = Math.log2(a)) % 1 }
  `)
  // log2(8)=3, 3%1=0. If log2 applied twice: log2(3) ≈ 1.585, %1 ≠ 0.
  is(exports.f(8), 0)
})