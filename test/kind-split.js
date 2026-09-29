// A loop reading elements of a name that may hold a typed array or something
// else runs, where it holds the typed array, as a copy reading that array's
// elements by their kind (plan/kind-split.js; the summary narrows a typed
// array class test to its element kind): the same values, the same throws.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, wat } from './util.js'

const res = (f) => { try { return f() } catch (e) { return 'throws ' + e.constructor.name } }
const agrees = (src, calls) => {
  for (const optimize of levels(0, 2, 3)) {
    const js = oracle(src), m = jz(src, { optimize }).exports
    for (const [name, ...args] of calls) {
      const a = res(() => js[name](...args)), b = res(() => m[name](...args))
      ok(Object.is(a, b) || a === b, `${name}(${args.join(', ')}) at ${optimize}: ${b} for ${a}`)
    }
  }
}
const loopsOf = (text) => {
  const out = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    out.push(text.slice(at, end))
  }
  return out
}

// the modal synth's exciter: an impulse the kernel makes, or what the caller passed
const modal = `let render = (exciter, n) => {
  let exc
  if (exciter === 'impulse') { exc = new Float32Array(1); exc[0] = 1 } else exc = exciter
  let out = new Float32Array(n), y = 0
  for (let i = 0; i < n; i++) { let x = i < exc.length ? 0.5 * exc[i] : 0; y = y * 0.9 + x; out[i] = y }
  return out
}
export let f = (k, n) => render(k ? 'impulse' : 'noise', n)[3]
export let g = (n) => render(new Float32Array(8).fill(0.25), n)[5]
export let h = (n) => { let b = new Float32Array(16).fill(0.5); return render(b.subarray(4, 12), n)[6] }`

test('kind split: a name of several kinds reads its typed elements by kind where it holds them', () => {
  agrees(modal, [['f', 1, 50], ['f', 0, 50], ['g', 20], ['h', 20], ['f', 1, 0]])
  // a caller passing another element kind: the test fails for it, the loop reads it as before
  agrees(modal + `\nexport let d = (n) => render(new Float64Array(8).fill(0.125), n)[5]`, [['d', 20], ['g', 20]])
  if (belowOpt(2)) return
  ok(loopsOf(wat(modal, { optimize: 2 })).some(l => /f32\.load/.test(l) && !/call \$__(typed_idx|dyn_get|length)/.test(l)), 'a loop reads the elements as Float32 loads')
})

test('kind split: a name the loop writes or a closure sees keeps one loop', () => {
  agrees(`export let f = (k, n) => { let a = k ? new Float32Array(4).fill(1) : 'abcd', s = 0
    for (let i = 0; i < n; i++) { s += a.length; if (i === 2) a = 'xy' } return s }`, [['f', 1, 5], ['f', 0, 5]])
  agrees(`export let f = (k, n) => { let a = k ? new Float32Array(4).fill(1) : 'abcd', s = 0
    let swap = () => { a = [9, 9] }
    for (let i = 0; i < n; i++) { s += a[i % 4] === undefined ? 0 : 1; if (i === 1) swap() } return s }`, [['f', 1, 5], ['f', 0, 5]])
})

// a kernel taking a mono buffer or a list of channels (the reverbs' `data`):
// its channels are the typed arrays the callers pass, so each copy the loop
// runs as reads them by kind, and sums them as numbers
test('kind split: a mono buffer or a list of channels reads the channels by their kind', () => {
  const src = `const mono = new Float32Array([0.5, -1, 2, 0.25]), left = new Float32Array([1, 2, 3, 4]), right = new Float32Array([4, 3, 2, 1])
const mix = (data, g) => {
  let stereo = data[0]?.length !== undefined
  let L = stereo ? data[0] : data, R = stereo ? data[1] : null, acc = 0
  for (let i = 0; i < L.length; i++) {
    let x = stereo ? (L[i] + R[i]) * 0.5 : L[i]
    acc = acc * g + x
    if (stereo) { L[i] = x; R[i] = -x } else L[i] = x * 2
  }
  return acc
}
export let run = (which, g) => which ? mix([left, right], g) : mix(mono, g)
export let peek = () => [...mono, ...left, ...right].join()`
  agrees(src, [['run', 0, 0.5], ['run', 1, 0.5], ['run', 1, 2], ['peek']])
  // channels of another kind: the test fails for them, the loop reads them as before
  agrees(src + `\nexport let odd = (g) => mix([new Float64Array([1, 2]), 'ab'], g) + mix([new Float32Array(2), new Float64Array(2)], g)`, [['odd', 0.5], ['run', 1, 0.5]])
  if (belowOpt(2)) return
  const f = wat(src, { optimize: 2 }), mix = f.slice(f.indexOf('(func $mix'), f.indexOf('(func', f.indexOf('(func $mix') + 5))
  ok(loopsOf(mix).some(l => /f32\.load/.test(l) && !/call \$__(add_slow|typed_idx|dyn_get)/.test(l)), 'a loop reads the channels as Float32 and adds numbers')
})

// A kernel a tracker's closure calls with the array its factory was given: one
// caller passes a Float32Array, another a Float64Array. Each constructor gets a
// copy of the loop, the class test proving its element kind though the name
// held a number array of either kind before it.
test('kind split: an array of either of two kinds, handed on through a closure, reads each by its kind', () => {
  const src = `function g(data, pos, N, win) { let re = 0, im = 0; for (let i = 0; i < N; i++) { let x = (data[pos + i] || 0) * win[i]; re += x * 0.5; im -= x * 0.25 } return [re, im] }
function mk(source, N) { const win = new Float64Array(N).fill(0.5); return function at(t) { const [r0, i0] = g(source, t, N, win); const [r1, i1] = g(source, t + 1, N, win); return r0 + i1 } }
export let a = (n) => { const m = new Float32Array(n).map((_, i) => i * 0.25); const at = mk(m, 8); return at(1) + at(n - 4) }
export let b = (n) => { const m = new Float64Array(n).map((_, i) => i * 0.1); const at = mk(m, 8); return at(1) + at(n - 2) }
export let c = (n) => { const m = new Int16Array(n).fill(3); const at = mk(m, 8); return at(2) }`
  agrees(src, [['a', 16], ['b', 16], ['a', 6], ['b', 5], ['c', 12]])
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 }), g = text.slice(text.indexOf('(func $g'), text.indexOf('\n  (func ', text.indexOf('(func $g') + 5))
  const loops = loopsOf(g)
  ok(loops.some(l => /f32\.load/.test(l) && !/call \$__typed_idx/.test(l)), 'a copy reads Float32 loads')
  ok(loops.some(l => !/f32\.load/.test(l) && /f64\.load[\s\S]*f64\.load/.test(l) && !/call \$__typed_idx/.test(l)), 'a copy reads Float64 loads')
})
