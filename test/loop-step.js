// A loop that advances two counters (`for (j = 0, k = 0; j < half; j++, k +=
// step)`) still bounds the one its test names: inside, `half` is positive, so
// `a + half` is another element than `a` and the load of `re[a]` survives the
// store of `re[a + half]` (compile/cse-load.js stepCounter).
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, wat } from './util.js'

const butterfly = `const pass = (re, im, wre, wim, n) => {
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = (n / len) | 0
    for (let i = 0; i < n; i += len) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = wre[k], wi = wim[k]
        const a = i + j, b = a + half
        const xr = re[b], xi = im[b]
        const tr = wr * xr - wi * xi
        const ti = wr * xi + wi * xr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] = re[a] + tr
        im[a] = im[a] + ti
      }
    }
  }
}
export let f = (n) => {
  const N = 64, re = new Float64Array(N), im = new Float64Array(N), wre = new Float64Array(N >> 1), wim = new Float64Array(N >> 1)
  for (let i = 0; i < N; i++) { re[i] = ((i * 7919) % 101) / 50 - 1; im[i] = 0 }
  for (let k = 0; k < (N >> 1); k++) { wre[k] = 1 - k * 0.003; wim[k] = k * 0.002 }
  for (let r = 0; r < n; r++) pass(re, im, wre, wim, N)
  let h = 0
  for (let i = 0; i < N; i++) h = h * 1.000001 + re[i] - im[i] * 0.5
  return h
}`

// The counter's own step is one; a second write of it in the step, or a step
// that is not one, bounds nothing.
const rewritten = `export let f = (n) => {
  const a = new Float64Array(16)
  for (let i = 0; i < 16; i++) a[i] = i + 1
  let h = 0
  for (let j = 0, k = 1; j < n; j++, j += k) { const t = a[j]; a[j + n] = t * 2; h += a[j] + a[j + n] }
  return h
}`

test('loop step: programs agree with the host', () => {
  for (const [src, args] of [[butterfly, [1, 3]], [rewritten, [1, 2, 5]]]) {
    const host = oracle(src).f
    for (const optimize of levels(0, 2, 3, 'size')) {
      const f = jz(src, { optimize }).exports.f
      for (const n of args) ok(Object.is(host(n), f(n)), `f(${n}) at ${optimize}: ${f(n)} for ${host(n)}`)
    }
  }
})

test('loop step: the butterfly reads each element once', () => {
  if (belowOpt(2)) return
  const loads = (text) => (text.match(/f64\.load|v128\.load/g) || []).length
  const on = wat(butterfly, { optimize: 2 }), off = wat(butterfly, { optimize: { level: 2, loadCSE: false } })
  ok(loads(on) < loads(off), `fewer loads with the cache (${loads(on)} against ${loads(off)})`)
})

// A counter that strides by a loop-invariant (`i += len`) takes values from its
// entry to the last its stride reaches below the bound, so the inner butterfly's
// extents lift to one guard ahead of it, its `k += step` counter a word there too
// (type/loop-versioning-nest.js topExtent); twiddle tables too short for a pass
// fail that guard into the checked nest.
const strided = (twiddles) => `const N = 64
const fft = (re, im, wre, wim, n) => {
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = (n / len) | 0
    for (let i = 0; i < n; i += len) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = wre[k], wi = wim[k]
        const a = i + j, b = a + half
        const xr = re[b], xi = im[b]
        const tr = wr * xr - wi * xi
        const ti = wr * xi + wi * xr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] = re[a] + tr
        im[a] = im[a] + ti
      }
    }
  }
}
export let f = (rounds) => {
  const re = new Float64Array(N), im = new Float64Array(N), wre = new Float64Array(${twiddles}), wim = new Float64Array(${twiddles})
  for (let i = 0; i < N; i++) { re[i] = ((i * 7919) % 101) / 50 - 1; im[i] = 0 }
  for (let k = 0; k < wre.length; k++) { wre[k] = 1 - k * 0.003; wim[k] = k * 0.002 }
  for (let r = 0; r < rounds; r++) fft(re, im, wre, wim, N)
  let h = 0
  for (let i = 0; i < N; i++) h = h * 1.000001 + re[i] - im[i] * 0.5
  return h
}`

test('loop step: a strided counter lifts the butterfly guard and agrees with the host', () => {
  for (const twiddles of ['N >> 1', 'N >> 2', '5']) {
    const src = strided(twiddles), host = oracle(src).f
    for (const optimize of levels(0, 2, 3, 'size')) {
      const f = jz(src, { optimize }).exports.f
      for (const n of [1, 2]) ok(Object.is(host(n), f(n)), `${twiddles} twiddles, f(${n}) at ${optimize}: ${f(n)} for ${host(n)}`)
    }
  }
  if (belowOpt(2)) return
  // the strided loop holding the vector butterfly tests no extent of its own
  const fn = wat(strided('N >> 1'), { optimize: 'speed' })
  const seg = (from) => { let d = 0, i = from; for (; i < fn.length; i++) { if (fn[i] === '(') d++; else if (fn[i] === ')' && --d === 0) break } return fn.slice(from, i + 1) }
  const loops = []
  for (let at = fn.indexOf('(loop'); at >= 0; at = fn.indexOf('(loop', at + 5)) loops.push(seg(at))
  ok(loops.some(l => /v128\.store/.test(l) && (l.match(/\(loop/g) || []).length >= 3 && !/i64\.(lt|le|ge|gt)_s/.test(l)),
    'a strided loop around the vector butterfly with no guard inside')
})
