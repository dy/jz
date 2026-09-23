// Twin locals (src/compile/twin-locals.js): a counted loop versioned in the
// source, so its checked twin writes locals of its own. The kernel decodes a
// glyph outline's coordinates: a flag per point, then a byte or 16-bit delta
// from a stream cursor, accumulated and hashed per point. Every case runs
// against the host with inputs that fail the extent test (short flags, a
// stream cursor near the end), so the checked twin runs too.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel, levels } from './_matrix.js'
import { funcWat, oracle } from './util.js'

const GLYPH = `
const decode = (s, flags, off, n) => {
  let h = 0, r = off, x = 0, on = 0
  for (let i = 0; i < n; i++) {
    const f = flags[i]
    if (f & 2) { const d = s[r++]; x = (f & 16) ? x + d : x - d }
    else if (!(f & 16)) { x = x + (((s[r] << 8) | s[r + 1]) << 16 >> 16); r += 2 }
    h = Math.imul(h ^ (x | 0), 16777619)
    on += f & 1
  }
  return h + '/' + on + '/' + r
}
export let run = (n, off) => {
  const s = new Uint8Array(40), flags = new Uint8Array(24)
  for (let i = 0; i < 40; i++) s[i] = (i * 37 + 11) & 255
  for (let i = 0; i < 24; i++) flags[i] = (i * 53 + 5) & 63
  return decode(s, flags, off | 0, n | 0)
}`

const TWINS_OFF = { level: 'speed', twinLocals: false }
const kernelOf = (wat) => funcWat(wat, 'decode') || funcWat(wat, 'run') || funcWat(wat, 'run$exp')
const loops = (w) => (w.match(/\(loop /g) || []).length

test('twin locals: the glyph decode matches the host in both copies', () => {
  const native = oracle(GLYPH).run
  for (const optimize of [...levels(0, 2, 3, 'size'), TWINS_OFF]) {
    const wasm = jz(GLYPH, { optimize }).exports.run
    for (const n of [-3, 0, 1, 5, 16, 23, 24, 25, 40]) for (const off of [-2, 0, 3, 30, 39, 40])
      is(wasm(n, off), native(n, off), `${JSON.stringify(optimize)}: n ${n}, off ${off}`)
  }
})

test('twin locals: the fast copy accumulates in i32 while its twin keeps f64', () => {
  if (onKernel()) return
  const split = kernelOf(compile(GLYPH, { optimize: 'speed', wat: true }))
  const shared = kernelOf(compile(GLYPH, { optimize: TWINS_OFF, wat: true }))
  ok(/\(local \$(?:[^\s)]*_)?x i32\)/.test(split), 'the fast coordinate is an i32 local')
  ok(/\(local \$[^\s)]*tw\d+_x f64\)/.test(split), 'the twin coordinate is an f64 local of its own')
  ok(/\(local \$(?:[^\s)]*_)?x f64\)/.test(shared), 'without the split both copies share one f64 coordinate')
  is(loops(split), loops(shared), 'the emitter versions neither copy again')
})

test('twin locals: the size tier copies nothing', () => {
  if (onKernel()) return
  is(compile(GLYPH, { optimize: 'size', wat: true }), compile(GLYPH, { optimize: { level: 'size', twinLocals: false }, wat: true }))
})

// Loops the pass leaves to the emitter: an accumulator live after the loop
// (the twin shares it, so no local narrows), a counter that starts at a
// variable, float reads (a miss is NaN either way) and a closure in the body.
// Each compiles exactly as without the pass, and matches the host.
test('twin locals: a live accumulator, a variable start, float reads and a closure keep the emitted versioning', () => {
  const cases = {
    liveAfter: `const f = (a, n) => { let x = 0
        for (let i = 0; i < n; i++) x = x + a[i]
        return x }
      export let run = (n) => { const a = new Int16Array(16); for (let i = 0; i < 16; i++) a[i] = i * 1000 - 7000; return f(a, n | 0) }`,
    variableStart: `const f = (a, k, n) => { let h = 0
        for (let i = k; i < n; i++) { const v = a[i]; h = h * 31 + v | 0 }
        return h }
      export let run = (n) => { const a = new Uint8Array(16); for (let i = 0; i < 16; i++) a[i] = i * 9; return f(a, n & 3, n | 0) }`,
    floatReads: `const f = (a, n) => { let h = 0
        for (let i = 0; i < n; i++) { const v = a[i]; h = h * 31 + (v | 0) | 0 }
        return h }
      export let run = (n) => { const a = new Float64Array(16); for (let i = 0; i < 16; i++) a[i] = i * 1.5; return f(a, n | 0) }`,
    closure: `const f = (a, n) => { let h = 0
        for (let i = 0; i < n; i++) { const v = a[i]; const g = () => v * 2; h = h * 31 + g() | 0 }
        return h }
      export let run = (n) => { const a = new Uint8Array(16); for (let i = 0; i < 16; i++) a[i] = i * 9; return f(a, n | 0) }`,
  }
  for (const [name, src] of Object.entries(cases)) {
    if (!onKernel()) is(compile(src, { optimize: 'speed', wat: true }), compile(src, { optimize: TWINS_OFF, wat: true }), `${name}: unchanged`)
    const native = oracle(src).run
    for (const optimize of levels(0, 2, 3, 'size')) {
      const wasm = jz(src, { optimize }).exports.run
      for (const n of [-1, 0, 7, 16, 17, 30]) is(wasm(n), native(n), `${name}(${n}), O${optimize}`)
    }
  }
})
