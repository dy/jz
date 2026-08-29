// Range-proof regressions for guarded typed-array indices. The kernel is the
// generic shape: an otherwise-unbounded machine-i32 coordinate is bounded by
// conjuncts, the boolean is stored in a const, and a later branch reuses it.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel } from './_matrix.js'

const GUARD = 'x >= 0 && x < 4 && y >= 0 && y < 4 && src[y * 4 + x] === 1'
const KERNEL = `
export let mark = (ax, ay) => {
  const xy = new Int32Array(2)
  const pixels = new Uint8Array(16)
  const src = pixels, dst = pixels
  xy[0] = ax; xy[1] = ay; pixels[5] = 1
  const x = xy[0], y = xy[1]
  const inside = ${GUARD}
  if (inside) dst[y * 4 + x] = 7
  return pixels[5] * 10 + pixels[10]
}`

const INLINE = KERNEL.replace(`  const inside = ${GUARD}\n  if (inside)`, `  if (${GUARD})`)
const LET_FLAG = KERNEL.replace(
  `  const inside = ${GUARD}`,
  `  let inside = ${GUARD}\n  if (ax === 123) inside = true`)
const STALE_DEP = `
export let mark = (ax, ay) => {
  const xy = new Int32Array(2)
  const pixels = new Uint8Array(16)
  const src = pixels, dst = pixels
  xy[0] = ax; xy[1] = ay; pixels[5] = 1
  let x = xy[0]
  const y = xy[1]
  const inside = ${GUARD}
  x += 16
  if (inside) dst[y * 4 + x] = 7
  return pixels[5] * 10 + pixels[10]
}`
const REPEATED_KEY = `
export let mark = (ax, ay) => {
  const xy = new Int32Array(2)
  const pixels = new Uint8Array(16)
  xy[0] = ax; xy[1] = ay; pixels[5] = 1
  const x = xy[0], y = xy[1]
  const inside = x >= 0 && x < 4 && y >= 0 && y < 4 && pixels[y * 4 + x] === 1
  if (inside) pixels[y * 4 + x] = 7
  if (ax === 123) pixels[y * 4 + x] = 9
  return pixels[5] * 10 + pixels[10]
}`
const EFFECTFUL_GUARD = `
let ticks = 0
const note = () => { ticks++; return true }
export let mark = (ax, ay) => {
  const xy = new Int32Array(2)
  const pixels = new Uint8Array(16)
  const src = pixels, dst = pixels
  xy[0] = ax; xy[1] = ay; pixels[5] = 1
  const x = xy[0], y = xy[1]
  const inside = x >= 0 && x < 4 && y >= 0 && y < 4 && note() && src[y * 4 + x] === 1
  if (inside) dst[y * 4 + x] = 7
  return ticks * 100 + pixels[5] * 10 + pixels[10]
}`
const CALL_MUTATION = `
let gx = 1
const move = () => { gx = 20 }
export let mark = () => {
  const pixels = new Uint8Array(4)
  const src = pixels, dst = pixels
  pixels[1] = 1
  const inside = gx >= 0 && gx < 4 && src[gx] === 1
  move()
  if (inside) dst[gx] = 7
  return pixels[1]
}`
const F64_COORDS = `
export let mark = (x, y) => {
  const pixels = new Uint8Array(16)
  const src = pixels, dst = pixels
  pixels[5] = 1
  const inside = ${GUARD}
  if (inside) dst[y * 4 + x] = 7
  return pixels[5] * 10 + pixels[10]
}`
const OR_GUARD = KERNEL.replace('x >= 0 && x < 4', '(x >= 0 || x < 4)')
const OVERFLOW_INDEX = KERNEL.replaceAll('y * 4 + x', 'y * 1073741824 + x')
const AFFINE_WRAP_GUARD = KERNEL.replace(
  'x >= 0 && x < 4',
  'x + 2147483647 >= 0 && x + 2147483647 < 4')

const jsExports = (src) => {
  const exports = {}
  new Function('exports', src.replace(/export let (\w+)\s*=/g, 'exports.$1 ='))(exports)
  return exports
}
const sameOutput = (a, b) => typeof a === 'string' ? a === b
  : a.length === b.length && a.every((x, i) => x === b[i])
const assertCompileHistoryIndependent = (src, predecessors, opts, label) => {
  const cold = compile(src, opts)
  for (const prior of predecessors) {
    compile(prior, opts)
    const warm = compile(src, opts)
    ok(sameOutput(cold, warm), `${label}: matches cold output after a sibling compile`)
  }
}
const hasTypedBoundsTemp = wat => /\$[^\s)]*tbi\d*/.test(wat)

const INPUTS = [
  [1, 1], [2, 2], [-1, 1], [4, 1], [1, 4], [1.9, 1], [-0, 1],
  [NaN, 1], [Infinity, 1], [-Infinity, 1], [4294967297, 1],
  [-4294967295, 1], [2147483647, 1], [2147483648, 1],
]

test('interval proof: a named const carries conjunctive i32 bounds to a typed store', () => {
  const native = jsExports(KERNEL).mark
  for (const optimize of [0, 2, 3]) {
    const wasm = jz(KERNEL, { optimize }).exports.mark
    for (const args of INPUTS)
      is(wasm(...args), native(...args), `O${optimize} (${args.map(String).join(', ')}): Node parity`)
  }
})

test('interval proof: named-guard WAT is raw at O0/O2/O3; sibling controls fail closed', () => {
  if (onKernel()) return // the self-compile kernel returns bytes, not host-inspectable WAT
  for (const optimize of [0, 2, 3]) {
    const named = compile(KERNEL, { optimize, wat: true })
    const inline = compile(INLINE, { optimize, wat: true })
    ok(!hasTypedBoundsTemp(named), `O${optimize}: named guard removes the typed bounds branch`)
    ok(!hasTypedBoundsTemp(inline), `O${optimize}: inline conjuncts establish the same finite hull`)
    ok(/i32\.load8_u/.test(named) && /i32\.store8/.test(named), `O${optimize}: guarded load/store remain live`)

    for (const [name, src] of [
      ['let flag', LET_FLAG],
      ['stale dependency', STALE_DEP],
      ['repeated structural key', REPEATED_KEY],
      ['effectful guard', EFFECTFUL_GUARD],
      ['call-mutated global', CALL_MUTATION],
      ['f64 coordinates', F64_COORDS],
      ['disjunctive guard', OR_GUARD],
      ['overflowing index', OVERFLOW_INDEX],
      ['wrapping affine guard', AFFINE_WRAP_GUARD],
    ]) {
      ok(hasTypedBoundsTemp(compile(src, { optimize, wat: true })),
        `O${optimize}: ${name} retains a checked typed access`)
    }
  }
})

test('interval proof: effects, stale facts, NaN, signed values, and aliasing stay exact', () => {
  for (const optimize of [0, 2, 3]) {
    for (const [name, src, args] of [
      ['aliased read/write', KERNEL, [1, 1]],
      ['stale dependency', STALE_DEP, [1, 1]],
      ['repeated structural key', REPEATED_KEY, [123, 1]],
      ['effectful guard', EFFECTFUL_GUARD, [1, 1]],
      ['call-mutated global', CALL_MUTATION, []],
      ['f64 NaN', F64_COORDS, [NaN, 1]],
      ['f64 signed', F64_COORDS, [-1, 1]],
      ['overflowing index', OVERFLOW_INDEX, [1, 3]],
      ['wrapping affine guard', AFFINE_WRAP_GUARD, [-2147483648, 1]],
    ]) {
      const native = jsExports(src).mark
      const wasm = jz(src, { optimize }).exports.mark
      is(wasm(...args), native(...args), `O${optimize}: ${name} matches Node`)
    }
  }
})

test('interval proof: output is independent of prior guard shapes', () => {
  const predecessors = [LET_FLAG, STALE_DEP, REPEATED_KEY, EFFECTFUL_GUARD, CALL_MUTATION, F64_COORDS, OR_GUARD]
  for (const optimize of [0, 2, 3]) {
    assertCompileHistoryIndependent(KERNEL, predecessors, { optimize }, `O${optimize} binary`)
    if (!onKernel())
      assertCompileHistoryIndependent(KERNEL, predecessors, { optimize, wat: true }, `O${optimize} WAT`)
  }
})
