// An index a loop body advances between its accesses: the split-radix
// butterfly declares `i1 = i0, i2 = i1 + n4 …`, reads and writes, then steps
// every index by n8 and reads and writes again. Each access takes the index's
// form at its own statement (type/loop-versioning.js positionalAffineEnvs), so
// the loop is versioned over both extents; an index advanced by anything but
// an invariant step keeps every access with its text checked.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, jz, compile } from './util.js'

const butterfly = (step, extra = '') => `
export let f = (N, seed) => {
  const x = new Float64Array(N)
  for (let i = 0; i < N; i++) x[i] = ((i * 7919) % 97) * seed + i * 0.01
  let n2 = 2, nn = N >>> 1
  while ((nn = nn >>> 1)) {
    n2 = n2 << 1
    const n4 = n2 >>> 2, n8 = n2 >>> 3
    let id = n2 << 1
    for (let ix = 0; ix < N; ix = (id << 1) - n2, id <<= 2) {
      for (let i0 = ix; i0 < N; i0 += id) {
        let i1 = i0, i2 = i1 + n4, i3 = i2 + n4, i4 = i3 + n4
        let t1 = x[i3] + x[i4]
        x[i4] -= x[i3]; x[i3] = x[i1] - t1; x[i1] += t1
        ${step}
        t1 = x[i3] + x[i4]
        let t2 = x[i3] - x[i4]
        x[i4] = t1 + x[i2]; x[i3] = t1 - x[i2]; x[i2] = x[i1] - t2; x[i1] += t2${extra}
      }
    }
  }
  let h = 0
  for (let i = 0; i < N; i++) h = h * 1.0001 + (x[i] === undefined ? 7 : x[i])
  return h
}`
const cases = [
  ['a step by an invariant', butterfly('i1 += n8; i2 += n8; i3 += n8; i4 += n8')],
  ['a step past the end', butterfly('i1 += n8; i2 += n8; i3 += N; i4 += n8')],
  ['an advance that is no step', butterfly('i1 += n8; i2 += n8; i3 = (i3 * 3) % N; i4 += n8')],
]

for (const optimize of levels(0, 2, 3))
  test(`advanced index: accesses around an advanced index agree with the host at ${optimize}`, () => {
    for (const [label, src] of cases) {
      const f = jz(src, { optimize }).exports.f, g = oracle(src).f
      for (const [N, seed] of [[64, 0.3], [256, 0.07]]) is(f(N, seed), g(N, seed), `${label}, N=${N}`)
    }
  })

test('advanced index: the butterfly is versioned over both extents', () => {
  if (belowOpt(2)) return
  const wat = compile(cases[0][1], { optimize: 2, wat: true })
  // the innermost loops holding the butterfly's eight stores
  const loops = []
  for (let from = wat.indexOf('(loop'); from >= 0; from = wat.indexOf('(loop', from + 5)) {
    let depth = 0, i = from
    for (; i < wat.length; i++) { if (wat[i] === '(') depth++; else if (wat[i] === ')' && --depth === 0) break }
    const seg = wat.slice(from, i + 1)
    if (!seg.slice(5).includes('(loop') && (seg.match(/f64\.store/g) || []).length >= 7) loops.push(seg)
  }
  ok(loops.some(l => !/i32\.lt_u/.test(l)), 'a butterfly loop with no bounds test')
})

// A loop written twice holds two calls of every function its body calls. A kernel
// called there alone is spliced into the loop by the single-caller inliner; the
// second copy kept its call, a bound test a round saved for a call a round
// (worley: two kernels a pixel, 15% of its time).
test('versioning: a loop that holds the one call of a kernel is written once, the kernel spliced into it', () => {
  const src = `const T = new Uint8Array(256)
for (let i = 0; i < 256; i++) T[i] = (i * 37 + 11) & 255
const kernel = (t, x, y) => {
  let best = 1e9
  for (let gy = -1; gy <= 1; gy++) {
    const py = t[(y + gy) & 255]
    for (let gx = -1; gx <= 1; gx++) {
      const d = t[(x + gx + py) & 255] * 0.5 + gx * gx + gy * gy
      if (d < best) best = d
    }
  }
  return best
}
const fill = (out) => {
  let k = 0
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) out[k++] = kernel(T, x, y)
}
export const main = () => { const out = new Float64Array(576); fill(out); let s = 0; for (let i = 0; i < 576; i++) s += out[i]; return s }`
  const want = oracle(src).main()
  for (const optimize of levels(false, true, 'size', 'speed')) is(jz(src, { optimize }).exports.main(), want, `answers as Node at ${optimize}`)
  for (const optimize of levels(true, 'speed')) {
    const text = String(compile(src, { optimize, wat: true }))
    is((text.match(/\(call \$[^\s)]*kernel/g) || []).length, 0, `the kernel is spliced into its loop at ${optimize}`)
  }
})
