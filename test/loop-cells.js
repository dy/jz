// Loop cells (src/compile/loop-cells.js): the typed elements a loop reads and
// writes at fixed indexes stay in locals while it runs, behind one test that the
// loop's arrays are apart. Every kernel runs against the host, through arrays
// apart and through arrays that share bytes: one array under two names, two
// views of one buffer, an output over the state's bytes. The sums are
// recurrences (`s * 0.5 + v`): no level may reorder them.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import { funcWat, oracle, jz, compile } from './util.js'

const CELLS_OFF = { level: 'speed', loopCells: false }
// The plan's own copies of a loop for a receiver that is there (plan/integral-loops.js, plan/unswitch-loops.js,
// plan/kind-split.js) off: the loop's entry test is then the only one of its receivers.
const UNVERSIONED = { level: 'speed', versionIntegralLoops: false, unswitchLoops: false, splitLoopKinds: false }
const SUM = `
const sum = (out, w, h) => {
  let s = 0
  for (let i = 0; i < out.length; i++) s = s * 0.5 + out[i] * (1 + (i & 7))
  for (let i = 0; i < w.length; i++) s = s * 0.5 + (i + 2) * w[i]
  for (let i = 0; i < h.length; i++) s = s * 0.5 + (i + 7) * h[i]
  return s
}`

// A predictor's shape: four weights and four past samples, read and written every
// sample, the output stored between (QOA's slice loop).
const LMS = `
const clamp = (v) => v < -32768 ? -32768 : v > 32767 ? 32767 : v
const step = (weights, history, out, n, seed) => {
  let x = seed | 0
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0
    const d = (x >> 16) & 511
    const p = weights[0] * history[0] + weights[1] * history[1] + weights[2] * history[2] + weights[3] * history[3] >> 13
    const r = clamp(p + d)
    out[i] = r < 0 ? r / 32768 : r / 32767
    const delta = d >> 4
    weights[0] += history[0] < 0 ? -delta : delta
    weights[1] += history[1] < 0 ? -delta : delta
    weights[2] += history[2] < 0 ? -delta : delta
    weights[3] += history[3] < 0 ? -delta : delta
    history[0] = history[1]
    history[1] = history[2]
    history[2] = history[3]
    history[3] = r
  }
}
const seedW = (w) => { w[0] = -8192; w[1] = 16384; if (w.length > 2) w[2] = 100; if (w.length > 3) w[3] = -200 }
${SUM}
`
const ARRANGED = {
  apart: `export let run = (n) => {
    const w = new Int16Array(4), h = new Int16Array(4), out = new Float32Array(n)
    seedW(w); h[2] = 100; h[3] = -200
    step(w, h, out, n, 7)
    return sum(out, w, h) }`,
  // through an object's fields: no local of the function made them
  fields: `export let run = (n) => {
    const lms = { history: new Int16Array(4), weights: new Int16Array(4) }, out = new Float32Array(n)
    seedW(lms.weights); lms.history[2] = 100; lms.history[3] = -200
    const { weights, history } = lms
    step(weights, history, out, n, 7)
    return sum(out, weights, history) }`,
  // one array under both names: every store to the weights is a store to the history
  same: `export let run = (n) => {
    const w = new Int16Array(4), out = new Float32Array(n)
    seedW(w)
    step(w, w, out, n, 7)
    return sum(out, w, w) }`,
  // two views of one buffer, two elements apart
  overlap: `export let run = (n) => {
    const b = new Int16Array(8), out = new Float32Array(n)
    const w = b.subarray(0, 4), h = b.subarray(2, 6)
    seedW(w); h[2] = 100; h[3] = -200
    step(w, h, out, n, 7)
    return sum(out, w, h) }`,
  // two views of one buffer that share no byte
  views: `export let run = (n) => {
    const b = new Int16Array(12), out = new Float32Array(n)
    const w = b.subarray(1, 5), h = b.subarray(6, 10)
    seedW(w); h[2] = 100; h[3] = -200
    step(w, h, out, n, 7)
    return sum(out, w, h) + b[0] + b[5] + b[10] + b[11] }`,
  // the output over the weights' bytes
  outOver: `export let run = (n) => {
    const buf = new ArrayBuffer(64)
    const w = new Int16Array(buf, 0, 4), h = new Int16Array(buf, 32, 4), out = new Float32Array(buf, 0, n < 16 ? n : 16)
    seedW(w); h[2] = 100; h[3] = -200
    step(w, h, out, out.length, 7)
    return sum(out, w, h) }`,
  // weights one short: the fourth reads undefined and its store is dropped
  short: `export let run = (n) => {
    const w = new Int16Array(3), h = new Int16Array(4), out = new Float32Array(n)
    seedW(w); h[2] = 100; h[3] = -200
    step(w, h, out, n, 7)
    return sum(out, w, h) }`,
}

test('loop cells: a predictor\'s state through arrays apart and arrays that share bytes answers as the host does', () => {
  for (const [name, tail] of Object.entries(ARRANGED)) {
    const src = LMS + tail, native = oracle(src).run
    for (const optimize of [...levels(0, 1, 2, 3, 'size', 'speed'), CELLS_OFF]) {
      const wasm = jz(src, { optimize }).exports.run
      for (const n of [0, 1, 2, 5, 16, 100]) is(wasm(n), native(n), `${name} ${JSON.stringify(optimize)}: run(${n})`)
    }
  }
})

// Each element kind: stores that wrap, compound stores, steps; the held value is
// the converted element. Uint32, BigInt64 and Uint8Clamped cells are not held.
const KIND = (ctor, big = false) => {
  const k = (v) => big ? `${v}n` : `${v}`
  const N = (e) => big ? `Number(${e})` : e
  return `
const kinds = (a, b, out, n) => {
  for (let i = 0; i < n; i++) {
    a[0] += ${k(77)}
    a[1] -= ${k(1000003)}
    a[2] *= ${k(3)}
    a[0]++
    a[1]--
    a[2] = a[0] + a[1] * ${k(2)}
    ${big ? '' : 'a[1] ||= 9; a[2] &&= a[2] + 1; a[0] ??= 4'}
    b[0] = b[0] * 0.5 + i / 7
    b[1] += 0.1
    out[i] = ${N('a[0]')} + ${N('a[1]')} + ${N('a[2]')} + b[0] + b[1]
  }
}
export let run = (n) => {
  const a = new ${ctor}(3), b = new Float32Array(2), out = new Float64Array(n)
  a[0] = ${k(3)}; a[1] = ${k(5)}; a[2] = ${k(7)}; b[0] = 0.5; b[1] = 0.25
  kinds(a, b, out, n)
  let s = 0
  for (let i = 0; i < n; i++) s = s * 0.5 + out[i]
  return s + ${N('a[0]')} * 3 + ${N('a[1]')} * 5 + ${N('a[2]')} * 7 + b[0] + b[1] }`
}
const KINDS = ['Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray']

test('loop cells: each element kind\'s stores, compound stores and steps keep the converted element', () => {
  for (const ctor of [...KINDS, 'BigInt64Array']) {
    const src = KIND(ctor, ctor === 'BigInt64Array'), native = oracle(src).run
    for (const optimize of [...levels(0, 2, 3, 'size', 'speed'), CELLS_OFF]) {
      const wasm = jz(src, { optimize }).exports.run
      for (const n of [0, 1, 2, 9, 60]) is(wasm(n), native(n), `${ctor} ${JSON.stringify(optimize)}: run(${n})`)
    }
  }
})

const SHAPES = {
  // a store under a test, a break before a store, a cell only read (the coefficients)
  gate: `const gated = (st, co, x, n, stop) => {
      let acc = 0
      for (let i = 0; i < n; i++) {
        const v = x[i] * co[0] + st[0] * co[1]
        if (v > st[1]) st[1] = v
        if (i === stop) break
        st[0] = v
        x[i] = v + st[1]
        acc = acc * 0.5 + v
      }
      return acc }
    export let run = (n, stop) => {
      const st = new Float64Array(2), co = new Float64Array(2), x = new Float64Array(n)
      for (let i = 0; i < n; i++) x[i] = ((i * 37) % 11) - 5
      co[0] = 0.5; co[1] = -0.75; st[1] = -1e9
      let s = gated(st, co, x, n, stop) + st[0] + st[1]
      for (let i = 0; i < n; i++) s = s * 0.5 + x[i]
      return s }`,
  // the same loop, its state the signal's own first elements
  gateSame: `const gated = (st, co, x, n, stop) => {
      let acc = 0
      for (let i = 0; i < n; i++) {
        const v = x[i] * co[0] + st[0] * co[1]
        if (v > st[1]) st[1] = v
        if (i === stop) break
        st[0] = v
        x[i] = v + st[1]
        acc = acc * 0.5 + v
      }
      return acc }
    export let run = (n, stop) => {
      const st = new Float64Array(n > 2 ? n : 2), co = new Float64Array(2)
      for (let i = 0; i < n; i++) st[i] = ((i * 37) % 11) - 5
      co[0] = 0.5; co[1] = -0.75
      let s = gated(st, co, st, n, stop)
      for (let i = 0; i < st.length; i++) s = s * 0.5 + st[i]
      return s }`,
  // a store whose value is read: the unconverted right side (70000 in an Int16 is 4464)
  valued: `const valued = (w, out, n) => {
      let t = 0
      for (let i = 0; i < n; i++) { t = t * 0.5 + (w[0] = w[0] * 3 + 70000 + i); out[i] = t + w[1] }
      return t }
    export let run = (n, stop) => {
      const w = new Int16Array(2), out = new Float64Array(n)
      w[0] = 1; w[1] = 2
      let s = valued(w, out, n) + w[0]
      for (let i = 0; i < n; i++) s = s * 0.5 + out[i]
      return s }`,
  // a while whose test reads a cell and whose index is one
  whiled: `const whiled = (st, x) => {
      let i = 0
      while (st[0] < x.length) { x[st[0]] = st[1]; st[1] += 3; st[0]++; i++ }
      return i }
    export let run = (n, stop) => {
      const st = new Int32Array(2), x = new Float64Array(n)
      let s = whiled(st, x) + st[0] + st[1]
      for (let i = 0; i < n; i++) s = s * 0.5 + x[i]
      return s }`,
  // the same, the cells the first two elements of the array it fills
  whiledSame: `const whiled = (st, x) => {
      let i = 0
      while (st[0] < x.length && i < 1000) { x[st[0]] = st[1]; st[1] += 3; st[0]++; i++ }
      return i }
    export let run = (n, stop) => {
      const st = new Int32Array(n + 2)
      let s = whiled(st, st)
      for (let i = 0; i < st.length; i++) s = s * 0.5 + st[i]
      return s }`,
  // a float's word read through a second view of its buffer, both the function's own
  words: `export let run = (n, stop) => { const out = new Float64Array(n); for (let i = 0; i < n; i++) out[i] = i * 0.37 - 5 + stop
      const f = new Float32Array(1), w = new Uint32Array(f.buffer)
      let h = 0x811c9dc5 | 0
      for (let i = 0; i < out.length; i++) { f[0] = out[i]; h = Math.imul(h ^ (w[0] | 0), 0x01000193) | 0 }
      return h >>> 0 }`,
  // a window of the state read beside it
  window: `export let run = (n, stop) => { const st = new Float64Array(4), win = st.subarray(1, 3), out = new Float64Array(n)
      for (let i = 0; i < n; i++) { st[1] += 0.5; st[2] = st[1] * 2; out[i] = win[0] + win[1] }
      let s = st[1]
      for (let i = 0; i < n; i++) s = s * 0.5 + out[i]
      return s }`,
  // values an element already holds, and values that only look it: a masked integer, another cell of the kind,
  // a cell of another kind (-1 in an Int16 is 255 in a Uint8), a fraction inside the range, a negative zero,
  // an integer past the range
  fits: `const f = (a, b, out, n) => {
      for (let i = 0; i < n; i++) {
        a[0] = (i * 37) & 255
        a[1] = a[0]
        b[0] = -1 - (i & 3)
        a[2] = b[0]
        b[1] = (i & 7) * 0.5 + 0.75
        b[2] = (i & 1) * -0
        a[3] = (i * 301) & 1023
        out[i] = a[0] + a[1] * 2 + a[2] * 3 + a[3] * 11 + b[0] * 5 + b[1] * 7 + (1 / b[2] > 0 ? 1 : -1000)
      } }
    export let run = (n, stop) => { const a = new Uint8Array(4), b = new Int16Array(3), out = new Float64Array(n)
      f(a, b, out, n)
      let s = a[2] + a[3] + b[1] + (1 / b[2] > 0 ? 1 : -1000)
      for (let i = 0; i < n; i++) s = s * 0.5 + out[i]
      return s }`,
  // an accumulator in an element, the signal read beside it; then the accumulator in the signal
  accum: `const total = (acc, x, n) => { for (let i = 0; i < n; i++) acc[0] += x[i] * x[i] }
    export let run = (n, stop) => {
      const acc = new Float64Array(1), x = new Float64Array(n + 1)
      for (let i = 0; i <= n; i++) x[i] = (i % 7) - 3
      total(acc, x, n)
      total(x, x, n)
      return acc[0] * 0.5 + x[0] }`,
  // a call in the loop that stores into the state (it calls itself: no caller takes its body): nothing is held
  called: `const bump = (st, d) => { if (d > 0) return bump(st, d - 1); st[0] = st[0] + 2; return 1 }
    const run2 = (st, out, n) => { let c = 0
      for (let i = 0; i < n; i++) { out[i] = st[0] + st[1]; st[1] = st[0] * 3; c += bump(st, i & 1) }
      return c }
    export let run = (n, stop) => {
      const st = new Int32Array(2), out = new Float64Array(n)
      let s = run2(st, out, n) + st[0] + st[1]
      for (let i = 0; i < n; i++) s = s * 0.5 + out[i]
      return s }`,
  // the array rebound in the loop: the cells are another array's by the second round
  rebound: `const swap = (a, b, out, n) => {
      for (let i = 0; i < n; i++) { out[i] = a[0] + b[1]; a[0] += 1; const t = a; a = b; b = t }
      return a[0] * 100 + b[0] }
    export let run = (n, stop) => {
      const a = new Int32Array(2), b = new Int32Array(2), out = new Float64Array(n)
      a[0] = 5; b[0] = 50; b[1] = 7; a[1] = 9
      let s = swap(a, b, out, n)
      for (let i = 0; i < n; i++) s = s * 0.5 + out[i]
      return s }`,
}

test('loop cells: a store under a test, a break, a read value, a while, a call and a rebound array answer as the host does', () => {
  for (const [name, src] of Object.entries(SHAPES)) {
    const native = oracle(src).run
    for (const optimize of [...levels(0, 2, 3, 'size', 'speed'), CELLS_OFF]) {
      const wasm = jz(src, { optimize }).exports.run
      for (const n of [0, 1, 2, 5, 16, 100]) for (const stop of [-1, 0, 3]) is(wasm(n, stop), native(n, stop), `${name} ${JSON.stringify(optimize)}: run(${n}, ${stop})`)
    }
  }
})

// a function's innermost loops (each a paren-matched `(loop …)` holding no other)
const loopsOf = (w) => {
  const out = []
  let i = 0
  while ((i = w.indexOf('(loop ', i)) >= 0) {
    let d = 0, j = i
    for (; j < w.length; j++) { if (w[j] === '(') d++; else if (w[j] === ')' && --d === 0) break }
    const text = w.slice(i, j + 1)
    if (text.indexOf('(loop ', 1) < 0) out.push(text)
    i += 6
  }
  return out
}
const count = (w, re) => (w.match(re) || []).length

test('loop cells: the held copy of the predictor\'s loop loads and stores no state', () => {
  if (onKernel()) return
  const src = LMS + ARRANGED.fields
  // pre-watr, `run` as the compiler wrote it (`step` is its one call, inlined in the source)
  const loops = (optimize) => loopsOf(funcWat(compile(src, { optimize: { ...optimize, watr: false }, wat: true }), 'run'))
    .filter(l => l.includes('(f32.store'))
  const held = loops({ level: 'speed' }), plain = loops(CELLS_OFF)
  ok(plain.length > 0 && plain.every(l => count(l, /\(i32\.load16_s/g) === 19 && count(l, /\(i32\.store16/g) === 8),
    'as written, each copy of the loop loads the state 19 times a round and stores it 8 times')
  ok(held.some(l => !l.includes('(i32.load16_s') && !l.includes('(i32.store16')), 'a copy holds the state in locals: no load, no store of it')
  ok(held.some(l => !l.includes('(i32.load16_s') && count(l, /\(i32\.mul/g) >= 4), 'and multiplies the cells as words: its locals are i32')
  ok(held.some(l => count(l, /\(i32\.load16_s/g) === 19), 'beside the loop as written, for arrays that share bytes')
  // a stored value its element holds already keeps no conversion: the history's three moves and the clamped sample,
  // of the eight stores a round (the four weights wrap)
  const final = loopsOf(funcWat(compile(src, { optimize: 'speed', wat: true }), 'run')).filter(l => l.includes('(f32.store') && !l.includes('(i32.load16_s'))
  ok(final.length > 0 && final.every(l => count(l, /\(i32\.extend16_s/g) + count(l, /\(i32\.shr_s\s*\(i32\.shl/g) === 4), 'the held copy sign-extends the four weights alone')
  // the size tier and the reference level hold nothing
  is(compile(src, { optimize: 'size', wat: true }), compile(src, { optimize: { level: 'size', loopCells: false }, wat: true }))
  is(compile(src, { optimize: 0, wat: true }), compile(src, { optimize: { level: 0, loopCells: false }, wat: true }))
})

test('loop cells: which loops hold their cells', () => {
  if (onKernel()) return
  // a loop that holds cells is compiled twice: the module differs from the one with the pass off
  const holds = (src) => compile(src, { optimize: 'speed', wat: true }) !== compile(src, { optimize: CELLS_OFF, wat: true })
  for (const name of Object.keys(ARRANGED)) is(holds(LMS + ARRANGED[name]), true, `${name}: whether its arrays share bytes, and are long enough, is the run's to test`)
  // a Uint32 fills no word, a clamped store is no conversion of a word, a BigInt is no Number
  const one = (ctor, v) => `const f = (a, out, n) => { for (let i = 0; i < n; i++) { a[0] += ${v}; out[i] = Number(a[0]) } }
    export let run = (n) => { const a = new ${ctor}(1), out = new Float64Array(n); f(a, out, n); return n ? out[n - 1] : 0 }`.replace('Number(a[0])', v === '3n' ? 'Number(a[0])' : 'a[0]')
  for (const ctor of KINDS) is(holds(one(ctor, '3')), ctor !== 'Uint32Array' && ctor !== 'Uint8ClampedArray', ctor)
  is(holds(one('BigInt64Array', '3n')), false, 'BigInt64Array')
  is(holds(SHAPES.gate), true, 'a store under a test and a break')
  is(holds(SHAPES.whiled), true, 'a while')
  is(holds(SHAPES.accum), true, 'an accumulator')
  // a state the function has no record of the constructor of: a module object's fields
  is(holds(LMS + `const lms = { history: new Int16Array(4), weights: new Int16Array(4) }, buf = new Float32Array(256)
    export let run = (n) => { const { weights, history } = lms; seedW(weights); step(weights, history, buf, 256, n); return sum(buf, weights, history) }`), true, 'the fields of a module object')
  // nothing stored: the reads are the invariant motion's
  is(holds(`const f = (co, x, n) => { let s = 0; for (let i = 0; i < n; i++) s = s * co[0] + x[i] * co[1]; return s }
    export let run = (n) => { const co = new Float64Array(2), x = new Float64Array(n); co[0] = 0.5; co[1] = 2; return f(co, x, n) }`), false, 'a loop that stores nothing')
  // an array only read beside a stored one, the two not proven apart: held behind the test
  const proc = (mk) => `${mk}
    const proc = (src, dst, n) => { for (let i = 0; i < n; i++) dst[i] = src[0] + src[1] * i + src[2] - src[3] }
    export let run = (n) => { const src = mk(256), dst = mk(256)
      for (let k = 0; k < 4; k++) src[k] = k + 0.5
      proc(src, dst, 256); proc(src, dst, 256); proc(src, dst, 256)
      return dst[255] }`
  is(holds(proc('let cache = null\n    const mk = (n) => { if (!cache) cache = new Float64Array(n); return cache }')), true, 'coefficients that may be the output')
  // proven apart (each call hands its own fresh arrays): the reads leave the loop on their own
  is(holds(proc('const mk = (n) => new Float64Array(n)')), false, 'coefficients proven apart from the output')
  // the maker's arrays through a module object's fields: the summary names their constructor
  is(holds(`const mk = () => ({ history: new Int16Array(4), weights: new Int16Array(4) })
    ${LMS}
    const lms = mk(), buf = new Float32Array(256)
    export let run = (n) => { const { weights, history } = lms; seedW(weights); for (let k = 0; k < n; k++) step(weights, history, buf, 256, 7 + k); return sum(buf, weights, history) }`), true, 'the fields of an object a function made')
  // a codec's frame: each channel's state the fields of an object in a list, its output an element of another
  is(holds(LMS + `export let run = (n) => { const states = [], data = []
      for (let c = 0; c < 2; c++) { states.push({ history: new Int16Array(4), weights: new Int16Array(4) }); data.push(new Float32Array(n)) }
      for (let c = 0; c < 2; c++) { const { weights, history } = states[c], out = data[c]; seedW(weights); step(weights, history, out, n, 7 + c) }
      return sum(data[1], states[0].weights, states[1].history) }`), true, 'the fields of objects in a list')
  // one array, its length the program's: nothing to test, and no copy of the loop
  const alone = `export let run = (n) => { const st = new Int32Array(2); for (let i = 0; i < n; i++) { st[0] += i; st[1] ^= st[0] * 3 } return st[1] }`
  const loopsIn = (optimize) => compile(alone, { optimize, wat: true }).split('(loop ').length
  is(holds(alone), true, 'one array of the function\'s own')
  is(loopsIn('speed'), loopsIn(CELLS_OFF), 'held where it stands: the loop is not copied')
  // five arrays, each stored into: ten pairs to tell apart
  const many = `const f = (a, b, c, d, e, n) => { for (let i = 0; i < n; i++) { a[0] += 1; b[0] += a[0]; c[0] += b[0]; d[0] += c[0]; e[0] += d[0] } }
    const mk = (d) => d > 0 ? mk(d - 1) : new Int32Array(1)
    export let run = (n) => { const a = mk(1), b = mk(1), c = mk(1), d = mk(1), e = mk(1); f(a, b, c, d, e, n); return e[0] }`
  is(holds(many), false, 'ten pairs')
  // seventeen cells
  const wide = (cells) => `const f = (st, out, n) => { for (let i = 0; i < n; i++) { ${Array.from({ length: cells }, (_, k) => `st[${k}] += ${k + 1}`).join('; ')}; out[i] = st[0] } }
    export let run = (n) => { const st = new Int32Array(${cells}), out = new Float64Array(n); f(st, out, n); return st[${cells - 1}] + (n ? out[n - 1] : 0) }`
  is(holds(wide(16)), true, 'sixteen cells')
  is(holds(wide(17)), false, 'seventeen cells')
  // a state of two beside fifteen coefficients, seventeen cells: the state is held, the coefficients are read where they are
  // (`f` calls itself, so no caller takes its body and its loops are its own)
  const beside = `const f = (st, co, out, n, d) => { if (d > 0) return f(st, co, out, n, d - 1); for (let i = 0; i < n; i++) { st[0] = st[0] * co[0] + ${Array.from({ length: 14 }, (_, k) => `co[${k + 1}]`).join(' + ')}; st[1] += st[0]; out[i] = st[1] } }
    const mk = (n, d) => d > 0 ? mk(n, d - 1) : new Float64Array(n)
    export let run = (n) => { const st = mk(2, 1), co = mk(15, 1), out = mk(n, 1); for (let k = 0; k < 15; k++) co[k] = 0.01 * k; f(st, co, out, n, 1); return st[1] }`
  is(holds(beside), true, 'two cells stored into beside fifteen only read')
  const storesIn = (optimize) => loopsOf(funcWat(compile(beside, { optimize, wat: true }), 'f')).map(l => count(l, /\(f64\.store/g))
  ok(storesIn('speed').some(c => c === 1) && storesIn(CELLS_OFF).every(c => c === 3), 'a copy stores the output alone: the state is the array held')
  is(holds(THROWS.row), true, 'a table\'s row that may be missing: tested where the loop is entered')
  is(holds(THROWS.missing), true, 'an output that may be missing')
  is(holds(THROWS.rebound), false, 'a row the loop rebinds')
  // an array declared from the other: they share bytes by what the program says, and are left as written
  is(holds(SHAPES.words), false, 'a float and the view its words are read through')
  is(holds(SHAPES.window), false, 'a state and a window of it')
  // two module bindings that only ever hold the arrays they made: apart with no test
  is(holds(`const ST = new Float64Array(2), OUT = new Float64Array(64)
    export let run = (n) => { for (let i = 0; i < 64; i++) { ST[0] += 0.5 + n; OUT[i] = ST[0] + ST[1] } return OUT[63] }`), true, 'a module\'s state and its output')
  // an array as long as the other is its own
  is(holds(`const f = (st, n, d) => { if (d > 0) return f(st, n, d - 1); const out = new Float64Array(st.length * n)
      for (let i = 0; i < out.length; i++) { st[0] += 0.5; out[i] = st[0] + st[1] }
      return out[out.length - 1] }
    export let run = (n) => f(new Float64Array(2), n, 1)`), true, 'an output as long as the state')
  is(holds(SHAPES.fits), true, 'stores of values the elements hold already')
  is(holds(SHAPES.valued), false, 'a store whose value is read')
  is(holds(SHAPES.called), false, 'a call')
  is(holds(SHAPES.rebound), false, 'an array rebound in the loop')
})

// A loop that may throw keeps its elements in memory: what a handler reads after
// the throw is what the rounds before it stored. A row past the table's end is
// undefined, a store through a missing array throws, a BigInt beside a Number throws.
const THROWS = {
  row: `const tab = [new Float64Array(3), new Float64Array(3)]
    const f = (st, out, r, n) => { const t = tab[r]; for (let i = 0; i < n; i++) { st[0] += 1; out[i] = st[0] + t[i % 3] } }
    export let run = (r, n) => { const st = new Int32Array(1), out = new Float64Array(n); let threw = 0
      try { f(st, out, r, n) } catch (e) { threw = 1 }
      return st[0] * 10 + threw + (n ? out[n - 1] : 0) }`,
  missing: `const rows = [new Float64Array(8), new Float64Array(8)]
    const f = (st, r, n) => { const out = rows[r]; for (let i = 0; i < n; i++) { st[0] += 3; out[i & 7] = st[0] } }
    export let run = (r, n) => { const st = new Int32Array(1); let threw = 0
      rows[0][0] = 0; rows[1][1] = 0
      try { f(st, r, n) } catch (e) { threw = 1 }
      return st[0] * 10 + threw + rows[0][0] + rows[1][1] }`,
  // a member of an object that may be missing, read after the round's store
  member: `const objs = [{ v: 1.5, w: new Float64Array(2) }, { v: 2.5, w: new Float64Array(2) }]
    const f = (st, out, r, n) => { const o = objs[r]; for (let i = 0; i < n; i++) { st[0] += 1; out[i] = st[0] + o.v } }
    export let run = (r, n) => { const st = new Int32Array(1), out = new Float64Array(n); let threw = 0
      try { f(st, out, r, n) } catch (e) { threw = 1 }
      return st[0] * 10 + threw + (n ? out[n - 1] : 0) }`,
  // the receiver a name the loop rebinds: there at entry, missing two rounds later
  rebound: `const tab = [new Float64Array(3), new Float64Array(3)]
    const f = (st, out, n) => { let t = tab[0]; for (let i = 0; i < n; i++) { st[0] += 1; out[i] = st[0] + t[0]; t = tab[i + 1] } }
    export let run = (r, n) => { const st = new Int32Array(1), out = new Float64Array(n); let threw = 0
      try { f(st, out, n) } catch (e) { threw = 1 }
      return st[0] * 10 + threw + (n ? out[0] : 0) }`,
  bigint: `const f = (st, out, v, n) => { for (let i = 0; i < n; i++) { st[0] += 1; out[i] = Number(st[0] + v) } }
    export let run = (r, n) => { const st = new Int32Array(1), out = new Float64Array(n); let threw = 0
      try { f(st, out, r > 1 ? 5n : 5, n) } catch (e) { threw = 1 }
      return st[0] * 10 + threw + (n ? out[n - 1] : 0) }`,
}

test('loop cells: a throw in the loop finds the elements stored', () => {
  for (const [name, src] of Object.entries(THROWS)) {
    const native = oracle(src).run
    for (const optimize of [...levels(0, 2, 3, 'size', 'speed'), CELLS_OFF, UNVERSIONED]) {
      const wasm = jz(src, { optimize }).exports.run
      for (const r of [0, 1, 5]) for (const n of [0, 1, 4]) is(wasm(r, n), native(r, n), `${name} ${JSON.stringify(optimize)}: run(${r}, ${n})`)
    }
  }
})

// Ways out of the loop and code the loop runs, each of which must find the elements in memory:
// a return, a throw, a jump to an outer loop's next round, a getter and a conversion that store
// into the state, the state reached through an object's field, coefficients that are the output.
const LEAVES = {
  returned: `const f = (st, out, n, stop) => { for (let i = 0; i < n; i++) { st[0] += 2; if (i === stop) return st[0]; out[i] = st[0] } return -1 }
    export let run = (n, stop) => { const st = new Int32Array(1), out = new Float64Array(n)
      const r = f(st, out, n, stop)
      return r * 1000 + st[0] * 10 + (n ? out[0] : 0) }`,
  thrown: `const f = (st, out, n, stop) => { for (let i = 0; i < n; i++) { st[0] += 2; if (i === stop) throw new Error('stop'); out[i] = st[0] } }
    export let run = (n, stop) => { const st = new Int32Array(1), out = new Float64Array(n); let threw = 0
      try { f(st, out, n, stop) } catch (e) { threw = 1 }
      return threw * 1000 + st[0] * 10 + (n ? out[0] : 0) }`,
  // a thrown number (no call in the loop), and a return in a function no caller takes the body of (it calls itself)
  thrownValue: `const f = (st, out, n, stop) => { for (let i = 0; i < n; i++) { st[0] += 2; if (i === stop) throw i; out[i] = st[0] } }
    export let run = (n, stop) => { const st = new Int32Array(1), out = new Float64Array(n); let threw = 0
      try { f(st, out, n, stop) } catch (e) { threw = 1 }
      return threw * 1000 + st[0] * 10 + (n ? out[0] : 0) }`,
  returnedDeep: `const f = (st, out, n, stop, d) => { if (d > 0) return f(st, out, n, stop, d - 1)
      for (let i = 0; i < n; i++) { st[0] += 2; if (i === stop) return st[0]; out[i] = st[0] }
      return -1 }
    export let run = (n, stop) => { const st = new Int32Array(1), out = new Float64Array(n)
      const r = f(st, out, n, stop, 1)
      return r * 1000 + st[0] * 10 + (n ? out[0] : 0) }`,
  outer: `const f = (st, out, n, stop) => { let s = 0
      rows: for (let j = 0; j < 3; j++) {
        for (let i = 0; i < n; i++) { st[0] += 2; if (i === stop) continue rows; out[i] = st[0] }
        s = s * 0.5 + st[0]
      }
      return s }
    export let run = (n, stop) => { const st = new Int32Array(1), out = new Float64Array(n)
      return f(st, out, n, stop) * 1000 + st[0] * 10 + (n ? out[0] : 0) }`,
  getter: `const G = new Int32Array(2)
    const o = { get v() { G[0] += 5; return 1 } }
    const f = (out, n) => { for (let i = 0; i < n; i++) { G[0] += o.v; out[i] = G[0] } }
    export let run = (n, stop) => { const out = new Float64Array(n); G[0] = stop
      f(out, n)
      return G[0] * 10 + (n ? out[n - 1] : 0) }`,
  setter: `const G = new Int32Array(2)
    const o = { set v(x) { G[0] += x } }
    const f = (out, n) => { for (let i = 0; i < n; i++) { G[0] += 1; o.v = 2; out[i] = G[0] } }
    export let run = (n, stop) => { const out = new Float64Array(n); G[0] = stop
      f(out, n)
      return G[0] * 10 + (n ? out[n - 1] : 0) }`,
  // a key that is an object: its conversion stores into the state
  key: `const G = new Int32Array(2)
    const k = { toString() { G[0] += 5; return 'a' } }
    const f = (out, o, n) => { for (let i = 0; i < n; i++) { G[0] += 1; o[k] = i; out[i] = G[0] } }
    export let run = (n, stop) => { const out = new Float64Array(n), o = { a: 0 }; G[0] = stop
      f(out, o, n)
      return G[0] * 10 + o.a + (n ? out[n - 1] : 0) }`,
  conversion: `const G = new Int32Array(2)
    const o = { valueOf() { G[0] += 5; return 1 } }
    const f = (out, n) => { for (let i = 0; i < n; i++) { G[0] += o * 2; out[i] = G[0] } }
    export let run = (n, stop) => { const out = new Float64Array(n); G[0] = stop
      f(out, n)
      return G[0] * 10 + (n ? out[n - 1] : 0) }`,
  field: `const f = (st, o, out, n) => { for (let i = 0; i < n; i++) { st[0] += 1; o.w[0] += 10; out[i] = st[0] } }
    export let run = (n, stop) => { const st = new Int32Array(1), out = new Float64Array(n), o = { w: stop > 0 ? new Int32Array(1) : st }
      f(st, o, out, n)
      return st[0] * 10 + o.w[0] + (n ? out[n - 1] : 0) }`,
  coefficients: `const f = (co, out, n) => { for (let i = 0; i < n; i++) out[i] = co[0] * i + co[1] }
    export let run = (n, stop) => { const out = new Float64Array(n + 2), co = stop > 0 ? new Float64Array(2) : out
      co[0] = 3; co[1] = 0.5
      f(co, out, n)
      let s = 0
      for (let i = 0; i < out.length; i++) s = s * 0.5 + out[i]
      return s }`,
  // a pattern over a row past the table's end, declared and assigned: a TypeError after the round's store
  pattern: `const f = (st, out, rows, n) => { for (let i = 0; i < n; i++) { st[0] += 1; const { v } = rows[i]; out[i] = st[0] + v } }
    export let run = (n, stop) => { const st = new Int32Array(1), out = new Float64Array(n), rows = [{ v: 1 }, { v: 2 }, { v: 3 }]; let threw = 0
      try { f(st, out, rows, n) } catch (e) { threw = 1 }
      return threw * 1000 + st[0] * 10 + (n ? out[0] : 0) }`,
  assigned: `const f = (st, out, pairs, n) => { let a = 0, b = 0
      for (let i = 0; i < n; i++) { st[0] += 1; [a, b] = pairs[i]; out[i] = st[0] + a - b }
      return a + b }
    export let run = (n, stop) => { const st = new Int32Array(1), out = new Float64Array(n), pairs = [[1, 2], [3, 4], [5, 6]]; let threw = 0
      try { f(st, out, pairs, n) } catch (e) { threw = 1 }
      return threw * 1000 + st[0] * 10 + (n ? out[0] : 0) }`,
  // a row read through, past the table's end by the fourth round: the receiver is no name the entry can test
  rowsShort: `const f = (st, out, tab, n) => { for (let i = 0; i < n; i++) { st[0] += 1; out[i] = st[0] + tab[i][0] } }
    export let run = (n, stop) => { const st = new Int32Array(1), out = new Float64Array(n), tab = [[1, 2], [3, 4], [5, 6]]; let threw = 0
      try { f(st, out, tab, n) } catch (e) { threw = 1 }
      return threw * 1000 + st[0] * 10 + (n ? out[0] : 0) }`,
  // the receiver a name the loop rebinds: there at entry, undefined two rounds later
  rebinds: `const f = (st, out, tab, n) => { let t = tab[0]
      for (let i = 0; i < n; i++) { st[0] += 1; out[i] = st[0] + t[0]; t = tab[i + 1] } }
    export let run = (n, stop) => { const st = new Int32Array(1), out = new Float64Array(n), tab = [[1, 2], [3, 4], [5, 6]]; let threw = 0
      try { f(st, out, tab, n) } catch (e) { threw = 1 }
      return threw * 1000 + st[0] * 10 + (n ? out[0] : 0) }`,
  // the state reached through an array's element, by an index the round computes: no name holds it
  reached: `const f = (st, rows, out, n) => { for (let i = 0; i < n; i++) { st[0] += 1; rows[i & 1][0] += 10; out[i] = st[0] } }
    export let run = (n, stop) => { const st = new Int32Array(1), out = new Float64Array(n), rows = [stop > 0 ? new Int32Array(1) : st, new Int32Array(1)]
      f(st, rows, out, n)
      return st[0] * 10 + rows[0][0] + rows[1][0] + (n ? out[n - 1] : 0) }`,
  // a BigInt beside a Number with no call in the loop: a TypeError after the round's store
  mixed: `const f = (st, out, v, n) => { let acc = 0
      for (let i = 0; i < n; i++) { st[0] += 1; out[i] = st[0]; acc = acc + v }
      return acc }
    export let run = (n, stop) => { const st = new Int32Array(1), out = new Float64Array(n); let threw = 0, r = 0
      try { r = Number(f(st, out, stop > 0 ? 5n : 5, n)) } catch (e) { threw = 1 }
      return threw * 1000 + st[0] * 10 + r + (n ? out[0] : 0) }`,
  // an accumulator that is the signal's first element, under two names no caller's body joins (the function calls itself)
  accumulated: `const total = (acc, x, n, d) => { if (d > 0) return total(acc, x, n, d - 1); for (let i = 0; i < n; i++) acc[0] += x[i & 1] * 0.5 + 1; return 0 }
    export let run = (n, stop) => { const x = new Float64Array(n + 1), acc = stop > 0 ? new Float64Array(1) : x
      for (let i = 0; i <= n; i++) x[i] = (i % 7) - 3
      total(acc, x, n, 1)
      return acc[0] * 0.5 + x[0] }`,
  // a state as long as the run says: a cell past its end reads undefined, its store dropped
  length: `const f = (st, out, n) => { for (let i = 0; i < n; i++) { st[0] += 1; st[2] = st[0] * 2; out[i] = st[0] + st[2] } }
    export let run = (n, stop) => { const st = new Int32Array(stop + 2), out = new Float64Array(n)
      f(st, out, n)
      let s = st[0]
      for (let i = 0; i < n; i++) s = s * 0.5 + out[i]
      return s }`,
}

test('loop cells: a return, a throw, a jump out, the program\'s code and an array reached another way find the elements stored', () => {
  for (const [name, src] of Object.entries(LEAVES)) {
    const native = oracle(src).run
    for (const optimize of [...levels(0, 2, 3, 'size', 'speed'), CELLS_OFF, UNVERSIONED]) {
      const wasm = jz(src, { optimize }).exports.run
      for (const n of [0, 1, 2, 5, 16]) for (const stop of [-1, 0, 3]) {
        const a = wasm(n, stop), b = native(n, stop)
        ok(Object.is(a, b), `${name} ${JSON.stringify(optimize)}: run(${n}, ${stop}) is ${a} for ${b}`)
      }
    }
  }
})

test('loop cells: the test at a loop\'s entry is no call', () => {
  if (onKernel()) return
  // (a call may allocate what the frame keeps: one in `run` would cost it the release of what it made)
  const src = LMS + ARRANGED.apart
  const flags = (optimize) => (compile(src, { optimize, wat: true }).match(/global\.set \$__esc\b/g) || []).length
  is(flags('speed'), flags(CELLS_OFF), 'the module writes the escape flag no more often')
})

// A throw that leaves the program: the host calls again and reads the state. No handler in the
// program (one makes every value of unknown kind a possible BigInt, and such a loop is left alone).
const ESCAPES = {
  // a row past the table's end is undefined: its first element read throws after the round's store
  row: `const ST = new Int32Array(1), tab = [[1, 2, 3], [4, 5, 6]]
    const f = (out, r, n) => { const t = tab[r]; for (let i = 0; i < n; i++) { ST[0] += 1; out[i] = ST[0] + t[i % 3] } }
    export let run = (r, n) => { const out = new Float64Array(n); ST[0] = 0; f(out, r, n); return n ? out[n - 1] : 0 }
    export let get = () => ST[0]`,
  // the same through a member
  member: `const ST = new Int32Array(1), objs = [{ v: 1.5 }, { v: 2.5 }]
    const f = (out, r, n) => { const o = objs[r]; for (let i = 0; i < n; i++) { ST[0] += 1; out[i] = ST[0] + o.v } }
    export let run = (r, n) => { const out = new Float64Array(n); ST[0] = 0; f(out, r, n); return n ? out[n - 1] : 0 }
    export let get = () => ST[0]`,
  // a row the loop reads through by its counter: missing from the third round
  counted: `const ST = new Int32Array(1), tab = [[1, 2, 3], [4, 5, 6]]
    const f = (out, r, n) => { for (let i = 0; i < n; i++) { ST[0] += 1; out[i] = ST[0] + tab[i + r][0] } }
    export let run = (r, n) => { const out = new Float64Array(n); ST[0] = 0; f(out, r, n); return n ? out[n - 1] : 0 }
    export let get = () => ST[0]`,
  // a row the loop rebinds: there at entry
  rebound: `const ST = new Int32Array(1), tab = [[1, 2, 3], [4, 5, 6]]
    const f = (out, r, n) => { let t = tab[0]; for (let i = 0; i < n; i++) { ST[0] += 1; out[i] = ST[0] + t[0]; t = tab[i + r] } }
    export let run = (r, n) => { const out = new Float64Array(n); ST[0] = 0; f(out, r, n); return n ? out[n - 1] : 0 }
    export let get = () => ST[0]`,
  // a list's length set below zero: a RangeError after the round's store
  lengthSet: `const ST = new Int32Array(1)
    const f = (out, list, r, n) => { for (let i = 0; i < n; i++) { ST[0] += 1; out[i] = ST[0]; list.length = r - i } }
    export let run = (r, n) => { const out = new Float64Array(n), list = [1, 2, 3]; ST[0] = 0; f(out, list, r, n); return list.length }
    export let get = () => ST[0]`,
  // a Number stored into a BigInt array
  bigStore: `const ST = new Int32Array(1), B = new BigInt64Array(2)
    const f = (out, r, n) => { for (let i = 0; i < n; i++) { ST[0] += 1; out[i] = ST[0]; if (i === r) B[0] = i } }
    export let run = (r, n) => { const out = new Float64Array(n); ST[0] = 0; f(out, r, n); return n ? out[n - 1] : 0 }
    export let get = () => ST[0]`,
}

test('loop cells: a throw that leaves the program finds the elements stored', () => {
  const state = (ex, r, n) => { let v; try { v = ex.run(r, n) } catch (e) { v = 'throws' } return v + '/' + ex.get() }
  for (const [name, src] of Object.entries(ESCAPES)) {
    const native = oracle(src)
    for (const optimize of [...levels(0, 2, 3, 'size', 'speed'), CELLS_OFF, UNVERSIONED]) {
      const ex = jz(src, { optimize }).exports
      for (const r of [0, 1, 2, 5]) for (const n of [0, 1, 4]) is(state(ex, r, n), state(native, r, n), `${name} ${JSON.stringify(optimize)}: run(${r}, ${n})`)
    }
  }
})
