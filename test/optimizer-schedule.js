// Passes that shape a loop for the engine's registers and pipeline: pooled floats,
// select bits, invariant reads, vector constants, masks, guard scans, gathers ahead,
// early stores, chains and issue order, item jams, select arms, constant bases and
// promoted cells.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, ownedLevels } from './_matrix.js'
import { T } from '../src/ast.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { selectArms } from '../src/optimize/select-arms.js'
import { maskOperands } from '../src/optimize/mask-operands.js'
import { searchLoops } from '../src/optimize/search-loops.js'
import { leadGathers } from '../src/optimize/lead-gathers.js'
import { earlyStores } from '../src/optimize/early-stores.js'
import { leadChains } from '../src/optimize/lead-chains.js'
import { issueOrder } from '../src/optimize/issue-order.js'
import { hoistVectorConsts } from '../src/optimize/vectorize/hoist-consts.js'
import { constBases } from '../src/optimize/const-bases.js'
import { promoteCells } from '../src/optimize/cells.js'
import { funcWat, run, oracle, compile } from './util.js'
import { parse, count, walk } from '../scripts/wat-probe.mjs'
import { findFunc } from './_optimizer.js'

// (a helper whose one `if` a sweep decided leaves `[';', null]`: the stdlib's iterator callback
// check under a known callback, in webaudio) The speed tier reads each nonzero float literal
// from an immutable global: V8 rematerializes a float constant through an integer register at
// each use (two instructions on x64), a global is one load the engine folds into the arithmetic.
test('poolFloats: nonzero float literals read immutable globals at speed, bit for bit', () => {
  const src = `export let f = (n) => {
    let x = 0.1, y = 0, z = 0, s = 0
    for (let i = 0; i < n; i++) {
      const dx = 10 * (y - x), dy = x * (28 - z) - y, dz = x * y - 2.6666666666666665 * z
      x += 0.002 * dx; y += 0.002 * dy; z += 0.002 * dz
      s += x * 0.041666666666666664 + y * 0.04166666666666667 + 1 / (z * -0 - 1)
    }
    return s + (n < 0 ? NaN : 0)
  }`
  const host = oracle(src).f
  for (const optimize of ownedLevels('speed', 2, 'size')) { const f = run(src, { optimize }).f; for (const n of [0, 1, 7, 100]) is(f(n), host(n), `O${optimize} n=${n}`) }
  if (onKernel()) return
  const wat = compile(src, { wat: true, optimize: 'speed' })
  const body = wat.slice(wat.indexOf('(func $f'))
  ok(/\(global \$__ff\d+ f64\s+\(f64\.const 28\)/.test(wat), 'a literal the loop reads is an immutable global')
  is((body.match(/f64\.const (?!0\b|0\))/g) ?? []).length, 0, 'no nonzero float literal left in the function')
  ok(/f64\.const 0\b/.test(body) || !/f64\.const/.test(body), 'zero stays inline')
  // two doubles nine printed digits cannot tell apart stay two globals
  ok(/f64\.const 0\.041666666666666664\)/.test(wat) && /f64\.const 0\.04166666666666667\)/.test(wat), 'neighbouring literals keep their own bits')
  ok(!/\$__ff/.test(compile(src, { wat: true, optimize: 'size' })), 'the size tier keeps its literals')
})

// x64 V8 branches around a float select; a condition the data decides (a hash bit picking a
// gradient's sign) mispredicts half the time.
test('selectBits: a float select the data decides picks the operands\' bits at speed', () => {
  const src = `export let f = (n) => {
    const h = new Int32Array(64), v = new Float64Array(64)
    let s = 0x9e3779b9 | 0
    for (let i = 0; i < 64; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; h[i] = s; v[i] = (s & 1023) / 64 - 8 }
    v[5] = -0; v[9] = NaN
    let acc = 0, best = Infinity
    for (let k = 0; k < n; k++) {
      const i = k & 63, x = v[i], y = v[(i + 7) & 63]
      const u = (h[i] & 1) === 0 ? x : -x
      const w = (h[i] & 2) === 0 ? y : -y
      const d = u * u + w * w
      best = d < best ? d : best
      const c = x > 1 ? 1 : x
      acc += (u === u ? u : 0) + (w === w ? w : 0) + (c === c ? c : 0) + 1 / (u === 0 ? u : 1)
    }
    return acc + best
  }`
  const host = oracle(src).f
  for (const optimize of ownedLevels('speed', 2)) { const f = run(src, { optimize }).f; for (const n of [0, 1, 6, 64, 1000]) is(f(n), host(n), `O${optimize} n=${n}`) }
  if (onKernel()) return
  const ast = parseWat(compile(src, { wat: true, optimize: 'speed' }))
  let bits = 0, plain = 0, pmin = 0
  walk(ast, n => {
    if (n[0] === 'f64.reinterpret_i64' && Array.isArray(n[1]) && n[1][0] === 'select') bits++
    else if (n[0] === 'select' && Array.isArray(n[n.length - 1]) && n[n.length - 1][0] === 'f64.gt') plain++
    else if (n[0] === 'f64x2.pmin') pmin++
  })
  ok(bits >= 2, `the sign picks select bits (${bits})`)
  ok(pmin >= 1, `the running minimum is a pseudo-minimum (${pmin})`)
  ok(plain >= 1, 'the clamp against a literal keeps its float select')
})

// A clamp against limits its loop reads before it (a range record's min and max)
// holds the same way nearly always, as one against a literal does: its select
// stays a float select, whose branch predicts.
test('selectBits: a clamp against bounds its loop never writes keeps its float select', () => {
  const src = `export let f = (lo, hi, n) => {
    const v = new Float64Array(64)
    let s = 0x2545f491 | 0
    for (let i = 0; i < 64; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; v[i] = (s & 4095) / 512 - 4 }
    v[3] = NaN; v[7] = -0
    let acc = 0, best = Infinity
    for (let k = 0; k < n; k++) {
      const x = v[k & 63]
      const c = x > hi ? hi : x
      acc += c < lo ? lo : c
      best = x < best ? x : best
    }
    return acc + best
  }`
  const host = oracle(src).f
  for (const optimize of ownedLevels('speed', 2)) {
    const f = run(src, { optimize }).f
    for (const [lo, hi] of [[-1, 1], [0, 0], [-0, 0], [2, -2], [NaN, 1], [-1, NaN], [-Infinity, Infinity]])
      for (const n of [0, 1, 7, 64, 500]) is(f(lo, hi, n), host(lo, hi, n), `O${optimize} lo=${lo} hi=${hi} n=${n}`)
  }
  if (onKernel()) return
  const ast = parseWat(compile(src, { wat: true, optimize: 'speed' }))
  let pmin = 0, plain = 0
  walk(ast, n => {
    if (n[0] === 'f64x2.pmin') pmin++
    // (a bits select's own select picks i64 operands)
    else if (n[0] === 'select' && Array.isArray(n[n.length - 1]) && /^f64\.[lg]t$/.test(n[n.length - 1][0]) && !(Array.isArray(n[1]) && n[1][0] === 'i64.reinterpret_f64')) plain++
  })
  ok(plain >= 2, `the two clamps keep their float selects (${plain})`)
  ok(pmin >= 1, `the running minimum is a pseudo-minimum (${pmin})`)
})

// A choice between the two operands of its own order test is their pseudo-minimum or
// -maximum, `pmin(m, d)` = `d < m ? d : m` by definition, NaN and signed zeros included:
// lane 0 of f64x2.pmin/pmax over splats, `minpd` on x64 and `fcmgt` + `bsl` on arm64,
// where the bits route moved both operands between register files on the chain a running
// extreme carries to the next iteration (worley's nine feature points).
test('selectBits: a choice between its test\'s operands is their pseudo-minimum or -maximum', () => {
  const src = `export let f = (n, seed) => {
    const v = new Float64Array(64)
    let s = seed | 0
    for (let i = 0; i < 64; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; v[i] = (s & 4095) / 512 - 4 }
    v[3] = NaN; v[7] = -0; v[8] = 0; v[11] = -0; v[20] = NaN
    let lo = Infinity, hi = -Infinity, a = 0, b = -0, acc = 0
    for (let k = 0; k < n; k++) {
      const x = v[k & 63], y = v[(k * 7 + 3) & 63]
      lo = x < lo ? x : lo
      hi = hi < x ? x : hi
      a = x > a ? a : x
      b = y > b ? y : b
      acc += 1 / (x < y ? x : y) + (y > x ? x : y)
    }
    return [lo, hi, a, b, acc, 1 / lo, 1 / hi, 1 / a, 1 / b]
  }`
  const host = oracle(src).f
  const same = (got, want, msg) => is(got.map(x => Object.is(x, -0) ? '-0' : String(x)), want.map(x => Object.is(x, -0) ? '-0' : String(x)), msg)
  for (const optimize of ownedLevels({ level: 'speed' }, 2, { level: 'speed', simd: false })) {
    const f = run(src, { optimize }).f
    for (const seed of [0x2545f491, 7, -99]) for (const n of [0, 1, 4, 9, 64, 500]) same(f(n, seed), host(n, seed), `${JSON.stringify(optimize)} seed=${seed} n=${n}`)
  }
  if (onKernel()) return
  const count = (wat, re) => (wat.match(re) ?? []).length
  const fast = compile(src, { wat: true, optimize: 'speed' }), body = fast.slice(fast.indexOf('(func $f'))
  ok(count(body, /f64x2\.pmin/g) >= 2 && count(body, /f64x2\.pmax/g) >= 2, 'the running extremes are pseudo-extremes')
  ok(!/f64\.reinterpret_i64 \(select|reinterpret_i64\s*\(select/.test(body), 'none of them takes the bits')
  const scalar = compile(src, { wat: true, optimize: { level: 'speed', simd: false } })
  ok(!/v128|f64x2/.test(scalar), 'simd: false stays scalar')
})

// A running minimum of values of no sign (squared distances, worley's nine feature points) chooses
// by their words: for +0, the positives and +Infinity the unsigned order of the bits is the floats'
// order, and every NaN's bits, either sign, lie above +Infinity's, where `d < m` never picks one.
test('selectBits: a running minimum of values of no sign chooses by their words', () => {
  // a nearest feature point over a cell's neighbours (worley's sampler), and beside it the
  // extremes that keep their pseudo-operators
  const src = `const pts = new Float64Array(512)
  let s = 0x2545f491 | 0
  for (let i = 0; i < 512; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; pts[i] = (s & 4095) / 4096 }
  pts[7] = NaN; pts[40] = -0; pts[41] = Infinity
  const nearest = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y)
    let f1 = Infinity
    for (let gy = -1; gy <= 1; gy++) {
      for (let gx = -1; gx <= 1; gx++) {
        const cx = ix + gx, cy = iy + gy, k = ((cx & 15) * 16 + (cy & 15)) * 2
        const dx = cx + pts[k] - x, dy = cy + pts[k + 1] - y
        const d2 = dx * dx + dy * dy
        if (d2 < f1) f1 = d2
      }
    }
    return Math.sqrt(f1)
  }
  const farthest = (x, y, from) => {
    let hi = 0, lo = from, sum = Infinity
    for (let g = 0; g < 9; g++) {
      const dx = pts[g * 2] - x, dy = pts[g * 2 + 1] - y, d2 = dx * dx + dy * dy
      if (d2 > hi) hi = d2
      if (d2 < lo) lo = d2
      if (dx + dy < sum) sum = dx + dy
    }
    return hi + lo + sum
  }
  export let f = (x, y) => [nearest(x, y), 1 / nearest(x, y)]
  export let g = (x, y, from) => farthest(x, y, from)`
  const host = oracle(src)
  const same = (got, want, msg) => is([got].flat().map(x => Object.is(x, -0) ? '-0' : String(x)), [want].flat().map(x => Object.is(x, -0) ? '-0' : String(x)), msg)
  for (const optimize of ownedLevels({ level: 'speed' }, 2, { level: 'speed', simd: false })) {
    const m = run(src, { optimize })
    for (const [x, y] of [[0, 0], [0.5, 3.25], [7.9, 1.1], [NaN, 0], [Infinity, 1], [-0, 0], [-3.5, -12.25], [1e15, 2]]) {
      same(m.f(x, y), host.f(x, y), `${JSON.stringify(optimize)} nearest ${x},${y}`)
      for (const from of [Infinity, 1, -1, NaN, 0]) same(m.g(x, y, from), host.g(x, y, from), `${JSON.stringify(optimize)} farthest ${x},${y} from=${from}`)
    }
  }
  if (onKernel()) return
  const fast = compile(src, { wat: true, optimize: 'speed' })
  // (the second export calls the function it wraps; the first takes its body)
  const f = funcWat(fast, 'f'), g = funcWat(fast, 'farthest') + funcWat(fast, 'g')
  const count = (t, re) => (t.match(re) ?? []).length
  ok(count(f, /i64\.lt_u/g) >= 3, `the nearest point's minimum compares words at each of the row's steps (${count(f, /i64\.lt_u/g)})`)
  ok(count(f, /f64x2\.pmin/g) === 0, 'and takes no pseudo-minimum')
  ok(count(g, /f64x2\.pmax/g) >= 1, 'the maximum keeps its pseudo-maximum')
  ok(count(g, /f64x2\.pmin/g) >= 1, 'the minimum a parameter starts keeps its pseudo-minimum')
  ok(count(g, /i64\.lt_u/g) === 0, 'and no minimum there compares words: one starts at a parameter, one is of a signed sum')
})

// A Number a loop holds unchanged takes a register through the whole loop.
test('fp-registers: a loop keeps the invariant reads its registers have no room for', () => {
  const src = (stages) => `const design = (n) => { const sos = []; for (let i = 0; i < n; i++) sos.push({ b0: 0.1 + i * 0.001, b1: 0.2 - i * 0.0005, b2: 0.1, a1: -1.5 + i * 0.01, a2: 0.6 - i * 0.005 }); return sos }
    const filter = (data, params) => {
      const coefs = params.coefs, n = coefs.length
      if (!params.state) { params.state = new Array(n); for (let i = 0; i < n; i++) params.state[i] = [0, 0] }
      const state = params.state
      for (let i = 0, l = data.length; i < l; i++) {
        let x = data[i]
        for (let j = 0; j < n; j++) { const c = coefs[j], s = state[j]; const y = c.b0 * x + s[0]; s[0] = c.b1 * x - c.a1 * y + s[1]; s[1] = c.b2 * x - c.a2 * y; x = y }
        data[i] = x
      }
      return data
    }
    export let f = (len) => {
      const data = new Float64Array(len)
      for (let i = 0; i < len; i++) data[i] = ((i * 37) % 101) / 101 - 0.5
      const params = { coefs: design(${stages}) }
      filter(data, params)
      filter(data, params)
      let h = 0
      for (let i = 0; i < len; i++) h = h * 0.5 + data[i]
      return h
    }`
  // the loads of the innermost loop whose one store is the filtered sample (the copy that holds
  // the state; the loop as written beside it stores the state too)
  const hot = (wat) => {
    let most = -1
    walk(parseWat(wat), n => {
      if (n[0] !== 'loop' || JSON.stringify(n.slice(2)).includes('"loop"')) return
      const j = JSON.stringify(n), loads = (j.match(/"f64\.load"/g) ?? []).length
      if ((j.match(/"f64\.store"/g) ?? []).length === 1) most = Math.max(most, loads)
    })
    return most
  }
  for (const stages of [8, 2]) {
    const host = oracle(src(stages)).f
    for (const optimize of ownedLevels('speed', 2)) { const f = run(src(stages), { optimize }).f; for (const n of [0, 1, 7, 300]) is(f(n), host(n), `${stages} sections O${optimize} n=${n}`) }
  }
  if (onKernel()) return
  ok(hot(compile(src(8), { wat: true, optimize: 'speed' })) >= 41, 'eight sections: the loop reads its 40 coefficients and its sample')
  ok(hot(compile(src(2), { wat: true, optimize: 'speed' })) <= 1, 'two sections: the coefficients are held, the loop reads its sample alone')
})

// V8 builds a `v128.const` where it stands: a lane ramp `i32x4 0 1 2 3` is five instructions on
// arm64, two immediates through a general register on x64, every iteration of the loop around it.
test('hoistVectorConsts: a vector loop reads its lane ramp from a local set before it', () => {
  const src = `export let f = (n) => {
    const buf = new Uint8Array(n)
    for (let t = 0; t < n; t++) buf[t] = ((t * 5 & t >> 7) | (t * 3 & t >> 10)) + t * ((t >> 12 | t >> 8) & 63 & t >> 4) & 255
    let h = 0
    for (let i = 0; i < n; i++) h = (h * 31 + buf[i]) | 0
    return h
  }`
  const host = oracle(src).f
  for (const optimize of ownedLevels('speed', 2)) { const f = run(src, { optimize }).f; for (const n of [0, 1, 7, 64, 5000]) is(f(n), host(n), `O${optimize} n=${n}`) }
  if (onKernel()) return
  const f = parseWat(compile(src, { wat: true, optimize: 'speed' })).find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$f')
  let inLoop = 0, before = 0
  walk(f, n => {
    if (n[0] === 'loop' && JSON.stringify(n).includes('"v128.const","i32x4","0","1","2","3"')) inLoop++
    if (n[0] === 'local.set' && Array.isArray(n[2]) && n[2][0] === 'v128.const' && n[2][1] === 'i32x4' && n[2].slice(2).join() === '0,1,2,3') before++
  })
  ok(before >= 1 && inLoop === 0, `the ramp is set before the vector loop, read in it (${before} sets, ${inLoop} loops building it)`)

  const k = (...lanes) => ['v128.const', 'i32x4', ...lanes.map(String)], g = n => ['local.get', n]
  const use = (c) => ['local.set', '$v', ['i32x4.add', g('$v'), c]]
  const loop = (label, ...body) => ['loop', label, ...body, ['br_if', label, g('$c')]]
  const m = hoistVectorConsts(['module', ['func', '$f', ['local', '$v', 'v128'], ['local', '$c', 'i32'],
    loop('$o', use(k(0, 1, 2, 3)), loop('$i', use(k(0, 1, 2, 3)), use(k(4, 5, 6, 7)), use(k(0, 0, 0, 0)), use(k(-1, -1, -1, -1))))]])
  const fn = m[1], text = JSON.stringify(fn)
  is(fn.filter(d => Array.isArray(d) && d[0] === 'local' && d[2] === 'v128').length, 3, 'one local per costly constant: the ramp, its second group')
  ok(text.includes('["v128.const","i32x4","0","0","0","0"]') && text.includes('["v128.const","i32x4","-1","-1","-1","-1"]'), 'zeros and ones stay where they are')
  const inner = []; walk(fn, n => { if (n[0] === 'loop' && n[1] === '$o') inner.push(...n.filter(c => Array.isArray(c) && c[0] === 'local.set' && c[2]?.[0] === 'v128.const')) })
  is(inner.length, 2, 'the inner loop\'s constants are set before it, inside the outer loop, once each')
  is(fn.filter(c => Array.isArray(c) && c[0] === 'local.set' && c[2]?.[0] === 'v128.const').length, 1, 'the outer loop\'s own ramp is set before it')
})

// x64 V8 lowers a byte or halfword mask to a zero extension; over `x ^ y` it extends a register into
// itself on every path, over `x` alone (still live after) it is a renamed move.
test('maskOperands: a byte mask over `^`/`|` moves onto the operand it narrows', () => {
  const g = (n) => ['local.get', n], ld8 = (n) => ['i32.load8_u', g(n)], k = (v) => ['i32.const', v]
  const and = (x, m) => ['i32.and', x, k(m)]
  const one = (e) => maskOperands(['module', ['func', ['drop', e]]])[1][1][1]
  is(one(and(['i32.xor', g('$c'), ld8('$p')], 255)), ['i32.xor', and(g('$c'), 255), ld8('$p')], 'the wide operand takes the mask')
  is(one(and(['i32.xor', ld8('$p'), g('$c')], 255)), ['i32.xor', ld8('$p'), and(g('$c'), 255)], 'the operands keep their order')
  is(one(['i32.and', k(255), ['i32.xor', g('$c'), ld8('$p')]]), ['i32.xor', and(g('$c'), 255), ld8('$p')], 'the mask first')
  is(one(and(['i32.or', g('$h'), ['i32.load16_u', 'offset=2', g('$p')]], 0xFFFF)), ['i32.or', and(g('$h'), 0xFFFF), ['i32.load16_u', 'offset=2', g('$p')]], 'a halfword under `|`')
  is(one(and(['i32.xor', ['i32.xor', g('$c'), ld8('$p')], ld8('$q')], 255)), ['i32.xor', ['i32.xor', and(g('$c'), 255), ld8('$p')], ld8('$q')], 'the moved mask narrows further')
  is(one(and(['i32.xor', g('$c'), k(0x5a)], 255)), ['i32.xor', and(g('$c'), 255), k(0x5a)], 'a literal in the mask')
  is(one(and(['i32.xor', ld8('$p'), ['i32.shr_u', g('$c'), k(24)]], 255)), ['i32.xor', ld8('$p'), ['i32.shr_u', g('$c'), k(24)]], 'nothing past the mask: the mask goes')
  is(one(and(['i32.xor', g('$a'), g('$b')], 255)), and(['i32.xor', g('$a'), g('$b')], 255), 'both wide: kept')
  is(one(and(['i32.xor', g('$c'), ld8('$p')], 63)), and(['i32.xor', g('$c'), ld8('$p')], 63), 'a mask no zero extension takes: kept')
  is(one(and(['i32.add', g('$c'), ld8('$p')], 255)), and(['i32.add', g('$c'), ld8('$p')], 255), 'a sum carries: kept')

  const src = `export let f = (n) => {
    const buf = new Uint8Array(256), t = new Int32Array(256), h16 = new Uint16Array(64)
    for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c | 0; buf[i] = (i * 37 + 11) & 0xff }
    for (let i = 0; i < 64; i++) h16[i] = (i * 2654435761) >>> 16
    let c = -1, h = 0
    for (let i = 0; i < n; i++) {
      c = t[(c ^ buf[i & 255]) & 0xff] ^ (c >>> 8)
      h = ((h * 31) | h16[i & 63]) & 0xffff
    }
    return ((c ^ -1) >>> 0) + h
  }`
  const host = oracle(src).f
  for (const optimize of ownedLevels('speed', 2, 'size')) { const f = run(src, { optimize }).f; for (const n of [0, 1, 7, 256, 1000]) is(f(n), host(n), `O${optimize} n=${n}`) }
  if (onKernel()) return
  const masked = (optimize) => {
    let moved = 0
    walk(parseWat(compile(src, { wat: true, optimize })), n => {
      if ((n[0] === 'i32.xor' || n[0] === 'i32.or') && Array.isArray(n[1]) && n[1][0] === 'i32.and' && Array.isArray(n[2]) && (n[2][0] === 'i32.load8_u' || n[2][0] === 'i32.load16_u')) moved++
    })
    return moved
  }
  ok(masked('speed') >= 2, 'the CRC step and the halfword fold mask their carried value')
  is(masked('size'), 0, 'the size tier keeps its masks')
})

// A scan whose rounds mostly leave by the guard paid the loop header (V8's stack
// check) and two taken branches a round; the scan alone, an innermost loop, V8 unrolls
// under one check.
test('searchLoops: a loop whose body is a guarded loop scans for its guard in a loop of its own', () => {
  const g = (n) => ['local.get', n], k = (v) => ['i32.const', v]
  const latch = ['br_if', '$L', ['i32.lt_s', ['local.tee', '$x', ['i32.add', g('$x'), k(1)]], k(9)]]
  const guard = [['br_if', '$B', ['i32.ne', ['i32.load8_u', g('$x')], k(1)]], ['br_if', '$B', ['i32.load8_u', 'offset=1', g('$x')]]]
  const inner = ['loop', '$W', ['br_if', '$W', ['i32.eqz', g('$y')]]]
  const one = (loop) => searchLoops(['module', ['func', '$f', loop]])[1][2]
  const tail = ['local.set', '$h', g('$y')]
  is(one(['loop', '$L', ['block', '$B', ...guard, ['local.set', '$y', g('$x')], inner, tail], latch]),
    ['block', '$out0', ['loop', '$L', ['block', '$B',
      ['block', '$found1', ['loop', '$search2',
        ['block', '$skip3', ['br_if', '$skip3', guard[0][2]], ['br_if', '$skip3', guard[1][2]], ['br', '$found1']],
        ['br_if', '$search2', latch[2]],
        ['br', '$out0']]],
      ['local.set', '$y', g('$x')], inner, tail], latch]], 'the guard scans in an innermost loop, the latch copied after it')
  const kept = (loop, why) => is(one(loop), loop, why)
  kept(['loop', '$L', ['block', '$B', ...guard, ['local.set', '$y', g('$x')]], latch], 'a body without a loop keeps its shape')
  kept(['loop', '$L', ['block', '$B', ['br_if', '$B', ['call', '$p', g('$x')]], inner, tail], latch], 'a guard that calls keeps its shape')
  kept(['loop', '$L', ['block', '$B', ['local.set', '$y', g('$x')], ...guard, inner, tail], latch], 'a body led by anything but its guard keeps its shape')
  kept(['loop', '$L', ['block', '$B', ...guard, inner, tail], ['br', '$L']], 'a loop without a conditional latch keeps its shape')
  kept(['loop', '$L', ['result', 'i32'], ['block', '$B', ...guard, ['local.set', '$y', g('$x')], inner, ['drop', g('$y')]], latch], 'a loop of a value keeps its shape')
  kept(['loop', '$L', ['block', '$B', ...guard, ['local.set', '$y', g('$x')], inner], latch], 'a body ending in its loop, the guard its entry test, keeps its shape')

  // a pixel scan starting a contour walk where it finds a boundary, a sieve crossing off
  // from each prime it finds, and a guard whose round continues the scan or leaves it
  const src = `export let f = (w, n) => {
    const bmp = new Uint8Array(w * w), seen = new Uint8Array(w * w), comp = new Uint8Array(n + 1)
    for (let i = 0; i < w * w; i++) bmp[i] = ((i * 2654435761) >>> 27) < 9 ? 1 : 0
    let h = 0
    for (let y = 1; y < w - 1; y++) for (let x = 1; x < w - 1; x++) {
      if (bmp[y * w + x] === 1 && bmp[y * w + x - 1] === 0 && seen[y * w + x] === 0) {
        let p = y * w + x, s = 0
        while (p < w * w && bmp[p] === 1 && s < 64) { seen[p] = 1; p += w; s++ }
        h = Math.imul(h ^ s, 16777619)
      }
    }
    let primes = 0
    for (let i = 2; i <= n; i++) if (comp[i] === 0) { primes++; for (let j = i * i; j <= n; j += i) comp[j] = 1 }
    outer: for (let i = 1; i < n; i++) {
      if (comp[i] === 1 || (i & 3) === 0) continue
      for (let j = 0; j < 3; j++) { if (i * j > n) break outer; h = (h + i * j) | 0 }
      if (i > 50) break
    }
    return h + primes
  }`
  const host = oracle(src).f
  for (const optimize of ownedLevels('speed', { level: 'speed', searchLoops: false }, 2)) {
    const f = run(src, { optimize }).f
    for (const [w, n] of [[3, 2], [8, 30], [33, 1000], [64, 10000]]) is(f(w, n), host(w, n), `${JSON.stringify(optimize)} w=${w} n=${n}`)
  }
  if (onKernel()) return
  const scans = (optimize) => {
    let k = 0
    walk(findFunc(parseWat(compile(src, { wat: true, optimize })), '$f'), n => { if (n[0] === 'loop' && typeof n[1] === 'string' && n[1].startsWith('$search')) k++ })
    return k
  }
  ok(scans('speed') >= 2, `the pixel scan and the sieve scan for their guards (${scans('speed')})`)
  is(scans(2), 0, 'level 2 keeps its loops')
})

test('leadGathers: a loop over items that searches from a gathered slot reads the next item\'s slot a round ahead', () => {
  const g = (n) => ['local.get', n], k = (v) => ['i32.const', v], set = (x, v) => ['local.set', x, v]
  const slot = (h) => ['i32.load', ['i32.add', g('$keys'), ['i32.shl', h, k(2)]]]
  // the item's key: read at a pointer stepped beside the counter, or at the counter itself
  const byPtr = ['i32.load', g('$p')], byIdx = ['i32.load', ['i32.add', g('$items'), ['i32.shl', g('$i'), k(2)]]]
  const gather = (item, root = true) => {
    const r = slot(['local.tee', '$h', ['i32.and', ['i32.mul', ['local.tee', '$k', item], k(-1640531535)], k(15)]])
    return root ? ['local.tee', '$r', r] : r
  }
  // a linear probe of a 16-slot table for each item, its hits' slots summed; `s1` runs first in a round,
  // `s2` after the search, `head` before the loop's test
  const fn = ({ item = byPtr, root = true, s1 = [], s2 = [], store = [], test = null } = {}) =>
    ['func', '$f', ['param', '$keys', 'i32'], ['param', '$items', 'i32'], ['param', '$n', 'i32'], ['result', 'i32'],
      ['local', '$i', 'i32'], ['local', '$p', 'i32'], ['local', '$k', 'i32'], ['local', '$h', 'i32'], ['local', '$r', 'i32'],
      ['local', '$v', 'i32'], ['local', '$s', 'i32'],
      set('$p', g('$items')),
      ['block', '$B', ['br_if', '$B', ['i32.ge_s', g('$i'), g('$n')]],
        ['loop', '$L', set('$v', k(-1)), ...s1,
          ['block', '$F',
            ['br_if', '$F', ['i32.eq', gather(item, root), k(-1)]],
            ['loop', '$S',
              ['if', ['i32.eq', root ? g('$r') : slot(g('$h')), g('$k')], ['then', set('$v', g('$h')), ['br', '$F']]],
              ['br_if', '$S', ['i32.ne', ['local.tee', '$r', slot(['local.tee', '$h', ['i32.and', ['i32.add', g('$h'), k(1)], k(15)]])], k(-1)]]]],
          ...store, ...s2,
          set('$s', ['i32.add', ['i32.mul', g('$s'), k(31)], g('$v')]),
          set('$p', ['i32.add', g('$p'), k(4)]),
          ['br_if', '$L', test ?? ['i32.lt_s', ['local.tee', '$i', ['i32.add', g('$i'), k(1)]], g('$n')]]]],
      // what the gather wrote lives on after the loop
      ['i32.add', ['i32.add', g('$s'), ['i32.mul', g('$k'), k(7)]], ['i32.add', g('$h'), g('$r')]]]
  const one = (f) => leadGathers(['module', f])[1]
  // the items end where memory does: a read past the last one traps
  const exec = (f, n, seed) => {
    const mod = new WebAssembly.Module(encodeWat(['module', ['memory', ['export', '"mem"'], 1], [...f.slice(0, 2), ['export', '"f"'], ...f.slice(2)]]))
    const inst = new WebAssembly.Instance(mod), mem = new Int32Array(inst.exports.mem.buffer)
    let x = seed
    const rnd = () => (x = Math.imul(x, 1103515245) + 12345 | 0) >>> 8
    for (let j = 0; j < 16; j++) mem[j] = rnd() % 3 ? rnd() & 63 : -1
    const items = mem.length - n
    for (let j = 0; j < n; j++) mem[items + j] = rnd() & 63
    try { return inst.exports.f(0, items * 4, n) } catch (e) { return String(e) }
  }
  const shapes = {
    'a key read at a stepped pointer': fn(),
    'a key read at the counter': fn({ item: byIdx }),
    'a slot read with no local of its own': fn({ root: false }),
    'a statement of locals before the gather': fn({ s1: [set('$v', ['i32.add', g('$v'), k(0)])] }),
    'a gather local read before the gather': fn({ s1: [set('$s', ['i32.xor', g('$s'), g('$k')])] }),
  }
  for (const [why, f] of Object.entries(shapes)) {
    const before = JSON.stringify(f), after = one(JSON.parse(before))
    ok(JSON.stringify(after) !== before && JSON.stringify(after).includes('$__lg'), `${why}: rewritten`)
    let bad = 0, runs = 0
    for (const n of [0, 1, 2, 3, 7, 16, 100]) for (const seed of [1, 2, 3, 99]) {
      runs++
      const want = exec(JSON.parse(before), n, seed), got = exec(after, n, seed)
      if (!Object.is(got, want)) bad++
    }
    is(bad, 0, `${why}: same answer over ${runs} item counts and tables, the last item at memory's end`)
  }
  const kept = (f, why) => is(one(f), JSON.parse(JSON.stringify(f)), why)
  kept(fn({ store: [['i32.store', g('$keys'), g('$v')]] }), 'a loop that stores stays')
  kept(fn({ s2: [['drop', ['call', '$g', g('$v')]]] }), 'a loop that calls stays')
  kept(fn({ s2: [['br_if', '$B', ['i32.eq', g('$v'), k(99)]]] }), 'a branch out of the loop stays')
  kept(fn({ s2: [['br_if', '$L', ['i32.eq', g('$v'), k(99)]]] }), 'a branch back to the loop but by its test stays')
  kept(fn({ s1: [set('$p', ['i32.add', g('$p'), k(0)])] }), 'a pointer stepped before the gather stays')
  kept(fn({ item: ['i32.load', ['i32.add', g('$p'), g('$s')]] }), 'a gather reading what the round computes stays')
  kept(fn({ s1: [set('$v', ['i32.load', g('$keys')])] }), 'a read before the gather stays')
  kept(fn({ s1: [set('$v', ['i32.div_s', g('$n'), g('$v')])] }), 'a trap before the gather stays')
  kept(fn({ item: g('$p') }), 'a search from a slot of no gather stays')
  kept(fn({ test: ['i32.lt_s', ['local.tee', '$i', ['i32.add', g('$i'), k(1)]], g('$v')] }), 'a test reading what the round computes stays')

  // a hash join's probe side and a dictionary's lookups, against the host at every tier
  const src = `const CAP = 256, MASK = CAP - 1, BUILD = 64, PROBE = 999
    const fill = (out, n, seed) => {
      let s = seed | 0
      for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; out[i] = (s >>> 0) & 1023 }
    }
    const hash = (k) => (Math.imul(k, 0x9e3779b1) >>> 0) & MASK
    const insert = (keys, vals, k, v) => {
      let h = hash(k)
      while (keys[h] !== -1) { if (keys[h] === k) { vals[h] = v; return } h = (h + 1) & MASK }
      keys[h] = k
      vals[h] = v
    }
    const probe = (keys, vals, k) => {
      let h = hash(k)
      while (keys[h] !== -1) { if (keys[h] === k) return vals[h]; h = (h + 1) & MASK }
      return 0
    }
    const lookup = (keys, vals, k) => {
      let h = hash(k)
      while (keys[h] !== -1) { if (keys[h] === k) return vals[h]; h = (h + 1) & MASK }
      return -1
    }
    const join = (keys, vals, build, probes) => {
      let h = 0x811c9dc5 | 0
      for (let it = 0; it < 3; it++) {
        for (let i = 0; i < CAP; i++) keys[i] = -1
        for (let i = 0; i < BUILD; i++) insert(keys, vals, build[i], (build[i] + it) | 0)
        let sum = 0
        for (let i = 0; i < PROBE; i++) sum = (sum + probe(keys, vals, probes[i])) | 0
        for (let i = 0; i < PROBE; i++) h = Math.imul(h ^ lookup(keys, vals, build[(i * 7) & (BUILD - 1)]), 16777619)
        h = Math.imul(h ^ sum, 16777619)
      }
      return h >>> 0
    }
    export let f = (seed) => {
      const keys = new Int32Array(CAP), vals = new Int32Array(CAP), build = new Int32Array(BUILD), probes = new Int32Array(PROBE)
      fill(build, BUILD, seed)
      fill(probes, PROBE, seed ^ 0x5bd1e995)
      for (let i = 0; i < PROBE; i += 2) probes[i] = build[(i >>> 1) & (BUILD - 1)]
      return join(keys, vals, build, probes)
    }`
  const host = oracle(src).f
  for (const optimize of ownedLevels('speed', { level: 'speed', leadGathers: false }, 2)) {
    const f = run(src, { optimize }).f
    for (const seed of [1, 0x1234abcd, -7, 99991]) is(f(seed), host(seed), `${JSON.stringify(optimize)} seed=${seed}`)
  }
  if (onKernel()) return
  // the gathers read ahead, by the locals that carry them
  const ahead = (optimize) => count(parseWat(compile(src, { wat: true, optimize })), n => n[0] === 'local.set' && typeof n[1] === 'string' && n[1].startsWith('$__lg'))
  ok(ahead('speed') >= 4, `both probe loops read a round ahead (${ahead('speed')} reads ahead)`)
  is(ahead({ level: 'speed', leadGathers: false }), 0, 'leadGathers: false keeps the loops as written')
  is(ahead(2), 0, 'level 2 keeps its loops')
})

test('earlyStores: a store ready before a long computation it does not read goes ahead of it', () => {
  const g = (n) => ['local.get', n], k = (v) => ['i32.const', v], f = (v) => ['f64.const', v]
  const ld = (b, off) => off ? ['f64.load', `offset=${off}`, g(b)] : ['f64.load', g(b)]
  const st = (b, off, v) => off ? ['f64.store', `offset=${off}`, g(b), v] : ['f64.store', g(b), v]
  const chain = (...xs) => xs.reduce((a, x) => ['f64.add', ['f64.mul', a, x], f(0.5)])
  const fn = (...body) => {
    const n = ['func', '$f', ['param', '$s', 'i32'], ['param', '$c', 'i32'], ['param', '$v', 'f64'], ['result', 'f64'],
      ['local', '$x1', 'f64'], ['local', '$y', 'f64'], ...body, g('$y')]
    n.distinctParams = new Set(['$s', '$c'])
    return n
  }
  const one = (n) => { earlyStores(n); return n }
  // the state's first cell: loaded, stored over before the output its section computes
  const x1 = ['local.set', '$x1', ld('$s', 0)]
  const y = ['local.set', '$y', chain(ld('$c', 0), g('$v'), ld('$c', 8), g('$x1'), ld('$s', 8), ld('$c', 16))]
  const s0 = st('$s', 0, g('$v')), s1 = st('$s', 8, g('$x1')), s2 = st('$s', 16, g('$y'))
  is(one(fn(x1, y, s0, s1, s2)).slice(8, 13), [x1, s0, y, s1, s2], 'the input store goes ahead of the output; the stores the output reads or writes stay')
  const kept = (body, why) => { const n = fn(...body), want = JSON.stringify(n); is(JSON.stringify(one(n)), want, why) }
  const y2 = ['local.set', '$y', chain(ld('$c', 0), g('$v'), g('$x1'), ld('$s', 8), g('$x1'), ld('$c', 16))]
  kept([x1, y2, st('$s', 8, g('$v')), s2], 'a store over a cell the computation reads stays after it')
  kept([x1, y2, ['f64.store', ['i32.const', 64], g('$v')]], 'a constant address may be either buffer')
  kept([x1, y2, st('$s', 0, ['f64.div', g('$y'), f(2)])], 'a store of what the computation yields waits for it')
  kept([x1, ['local.set', '$y', ['f64.add', g('$v'), f(1)]], s0], 'a short computation keeps its stores')
  kept([x1, ['local.set', '$y', ['f64.add', ['call', '$g'], chain(g('$v'), g('$x1'), g('$v'))]], s0], 'a call keeps every store after it')
  const noFacts = fn(x1, y2, s0)
  delete noFacts.distinctParams
  const before = JSON.stringify(noFacts)
  is(JSON.stringify(one(noFacts)), before, 'without distinct buffers nothing moves')

  // a cascade's sections over state and coefficient buffers from a maker, as biquad's
  const src = `const mk = (n) => new Float64Array(n)
    const cascade = (x, c, st, out) => {
      for (let i = 0; i < x.length; i++) {
        let v = x[i]
        for (let s = 0; s < 4; s++) {
          const x1 = st[s * 3], x2 = st[s * 3 + 1], y1 = st[s * 3 + 2]
          const y = c[s * 4] * v + c[s * 4 + 1] * x1 + c[s * 4 + 2] * x2 - c[s * 4 + 3] * y1
          st[s * 3] = v
          st[s * 3 + 1] = x1
          st[s * 3 + 2] = y
          v = y
        }
        out[i] = v
      }
    }
    export let f = (n) => {
      const x = mk(n), c = mk(16), st = mk(12), out = mk(n)
      for (let i = 0; i < n; i++) x[i] = Math.sin(i) * 0.5
      for (let k = 0; k < 16; k++) c[k] = 0.1 + k * 0.01
      cascade(x, c, st, out); cascade(x, c, st, out)
      let h = 0
      for (let i = 0; i < n; i++) h = (h + out[i] * 1e6) | 0
      return h
    }`
  const want = oracle(src).f(100)
  for (const optimize of ownedLevels('speed', { level: 'speed', earlyStores: false }, 2)) is(run(src, { optimize }).f(100), want, JSON.stringify(optimize))
  if (onKernel()) return
  // the statements of the cascade's sample loop: is a store ahead of the first section's output?
  const ahead = (optimize) => {
    // the loop with the most stores: the sections'
    let loop = null, most = 0
    walk(parseWat(compile(src, { wat: true, optimize })), n => {
      if (n[0] !== 'loop') return
      const k = n.filter(s => Array.isArray(s) && s[0] === 'f64.store').length
      if (k > most) { most = k; loop = n }
    })
    const stmts = loop.filter(s => Array.isArray(s))
    const store = stmts.findIndex(s => s[0] === 'f64.store'), mul = stmts.findIndex(s => JSON.stringify(s).includes('f64.mul'))
    return store < mul
  }
  ok(ahead('speed'), 'the first state store goes ahead of the first output')
  ok(!ahead({ level: 'speed', earlyStores: false }), 'earlyStores: false keeps it after')
})

test('leadChains: a cascade computes its output chain ahead of the state updates hanging off it', () => {
  const g = (n) => ['local.get', n], c = (v) => ['f64.const', v]
  const S = 6
  // y_j = b0*in + z0_j; z0_j = b1*in - a1*y_j + z1_j; z1_j = b2*in - a2*y_j — two names for the outputs, alternating
  const y = (j) => j % 2 ? '$yb' : '$ya', inOf = (j) => j ? g(y(j - 1)) : g('$x')
  const body = [['local.set', '$x', ['f64.load', g('$p')]]]
  for (let j = 0; j < S; j++) {
    const k = 0.05 * (j + 1)
    body.push(['local.set', y(j), ['f64.add', ['f64.mul', c(0.1 + k), inOf(j)], g(`$z${j}a`)]],
      ['local.set', `$z${j}a`, ['f64.add', ['f64.sub', ['f64.mul', c(0.2 - k), inOf(j)], ['f64.mul', c(-1.5 + k), g(y(j))]], g(`$z${j}b`)]],
      ['local.set', `$z${j}b`, ['f64.sub', ['f64.mul', c(0.1), inOf(j)], ['f64.mul', c(0.6 - k), g(y(j))]]])
  }
  body.push(['f64.store', g('$p'), g(y(S - 1))], ['local.set', '$p', ['i32.add', g('$p'), ['i32.const', 8]]])
  const zs = []
  for (let j = 0; j < S; j++) zs.push(['local', `$z${j}a`, 'f64'], ['local', `$z${j}b`, 'f64'])
  const fn = (b) => ['func', '$f', ['param', '$p', 'i32'], ['param', '$end', 'i32'], ['local', '$x', 'f64'], ['local', '$ya', 'f64'], ['local', '$yb', 'f64'], ...zs,
    ['loop', '$L', ...b, ['br_if', '$L', ['i32.lt_u', g('$p'), g('$end')]]]]
  const before = fn(JSON.parse(JSON.stringify(body)))
  const after = leadChains(['module', JSON.parse(JSON.stringify(before))])[1]
  const loop = after.find(n => Array.isArray(n) && n[0] === 'loop')
  const stmts = loop.slice(2, -1)
  // the outputs' statements read the state's incoming values: each section's output comes before its updates,
  // and the first four outputs before any update
  const isOut = (s) => s[0] === 'local.set' && JSON.stringify(s[2]).split('f64.mul').length === 2
  const firstUpdate = stmts.findIndex(s => s[0] === 'local.set' && /^\$z\d[ab]$/.test(s[1]))
  ok(stmts.slice(0, firstUpdate).filter(isOut).length >= 4, `four outputs lead the first update (${stmts.slice(0, firstUpdate).filter(isOut).length})`)
  const fresh = after.filter(n => Array.isArray(n) && n[0] === 'local' && /\$l\d+$/.test(n[1]))
  ok(fresh.length >= 4, `the outputs' repeated names take fresh locals (${fresh.length})`)
  // the rewritten loop runs as the original
  const exec = (f) => {
    const m = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module', ['memory', '$m', ['export', '"m"'], 1], [...f.slice(0, 2), ['export', '"f"'], ...f.slice(2)]])))
    const mem = new Float64Array(m.exports.m.buffer, 0, 256)
    for (let i = 0; i < 256; i++) mem[i] = Math.sin(i * 0.37)
    m.exports.f(0, 2040)
    return [...mem.slice(0, 256)]
  }
  is(exec(after), exec(before), 'same samples out')
  // a short chain, or one with nothing weighty hanging off it, stays as written
  const kept = (b, why) => { const f = fn(b), want = JSON.stringify(f); is(JSON.stringify(leadChains(['module', f])[1]), want, why) }
  kept(body.slice(0, 7).concat(body.slice(-2)), 'two sections are too short a chain')
  kept(body.map(s => s[0] === 'local.set' && /^\$z\d[ab]$/.test(s[1]) ? ['local.set', s[1], g('$x')] : s), 'copies hanging off the chain stay')
  kept([...body.slice(0, 4), ['local.set', '$x', ['call', '$g']], ...body.slice(4)], 'a call keeps the run')

  // second-order sections in direct form II transposed, the library idiom: state and
  // coefficients in locals, the signal filtered in place
  const src = `const run = (data) => {
      let a0 = 0, a1 = 0, b0 = 0, b1 = 0, c0 = 0, c1 = 0, d0 = 0, d1 = 0, e0 = 0, e1 = 0, f0 = 0, f1 = 0
      for (let i = 0; i < data.length; i++) {
        const x = data[i]
        const ya = 0.11 * x + a0;  a0 = 0.21 * x + 0.31 * ya + a1;  a1 = 0.12 * x - 0.41 * ya
        const yb = 0.13 * ya + b0; b0 = 0.22 * ya + 0.32 * yb + b1; b1 = 0.14 * ya - 0.42 * yb
        const yc = 0.15 * yb + c0; c0 = 0.23 * yb + 0.33 * yc + c1; c1 = 0.16 * yb - 0.43 * yc
        const yd = 0.17 * yc + d0; d0 = 0.24 * yc + 0.34 * yd + d1; d1 = 0.18 * yc - 0.44 * yd
        const ye = 0.19 * yd + e0; e0 = 0.25 * yd + 0.35 * ye + e1; e1 = 0.20 * yd - 0.45 * ye
        const yf = 0.21 * ye + f0; f0 = 0.26 * ye + 0.36 * yf + f1; f1 = 0.22 * ye - 0.46 * yf
        data[i] = yf
      }
      return data
    }
    export let f = (n) => {
      const d = new Float64Array(n)
      for (let i = 0; i < n; i++) d[i] = Math.sin(i * 0.37)
      run(d); run(d)
      let h = 0
      for (let i = 0; i < n; i++) h = (h + d[i] * 1e9) | 0
      return h
    }`
  const want = oracle(src).f(500)
  for (const optimize of ownedLevels('speed', { level: 'speed', leadChains: false }, 2)) is(run(src, { optimize }).f(500), want, JSON.stringify(optimize))
  if (onKernel()) return
  const fresh2 = (optimize) => count(parseWat(compile(src, { wat: true, optimize })), n => n[0] === 'local' && typeof n[1] === 'string' && /\$l\d+$/.test(n[1]))
  ok(fresh2('speed') >= 4, `the sections' outputs lead (${fresh2('speed')} fresh locals)`)
  is(fresh2({ level: 'speed', leadChains: false }), 0, 'leadChains: false keeps the sections as written')
})

test('leadChains: a value a statement writes inside itself is read after it', () => {
  const g = (n) => ['local.get', n], c = (v) => ['f64.const', v]
  const S = 6
  const y = (j) => j % 2 ? '$yb' : '$ya', inOf = (j) => j ? g(y(j - 1)) : g('$x')
  const body = [['local.set', '$x', ['f64.load', g('$p')]]]
  for (let j = 0; j < S; j++) {
    const k = 0.05 * (j + 1), out = ['f64.add', ['f64.mul', c(0.1 + k), inOf(j)], g(`$z${j}a`)]
    // the third section's output reads a value derived from the running total below
    body.push(['local.set', y(j), j === 2 ? ['f64.add', out, ['f64.mul', c(1e-3), g('$v')]] : out],
      ['local.set', `$z${j}a`, ['f64.add', ['f64.sub', ['f64.mul', c(0.2 - k), inOf(j)], ['f64.mul', c(-1.5 + k), g(y(j))]], g(`$z${j}b`)]],
      ['local.set', `$z${j}b`, ['f64.sub', ['f64.mul', c(0.1), inOf(j)], ['f64.mul', c(0.6 - k), g(y(j))]]])
    // a running total stepped inside a statement: a tee whose operand reads the name it writes
    if (j === 1) body.push(['local.set', '$w', ['f64.mul', c(0.5), ['local.tee', '$acc', ['f64.add', g('$acc'), g(y(j))]]]],
      ['local.set', '$v', ['f64.mul', g('$acc'), c(2)]])
  }
  body.push(['f64.store', g('$p'), ['f64.add', g(y(S - 1)), g('$w')]], ['local.set', '$p', ['i32.add', g('$p'), ['i32.const', 8]]])
  const zs = []
  for (let j = 0; j < S; j++) zs.push(['local', `$z${j}a`, 'f64'], ['local', `$z${j}b`, 'f64'])
  const fn = (b) => ['func', '$f', ['param', '$p', 'i32'], ['param', '$end', 'i32'], ['local', '$x', 'f64'], ['local', '$ya', 'f64'], ['local', '$yb', 'f64'],
    ['local', '$acc', 'f64'], ['local', '$w', 'f64'], ['local', '$v', 'f64'], ...zs,
    ['loop', '$L', ...b, ['br_if', '$L', ['i32.lt_u', g('$p'), g('$end')]]]]
  const before = fn(JSON.parse(JSON.stringify(body)))
  const after = leadChains(['module', JSON.parse(JSON.stringify(before))])[1]
  ok(JSON.stringify(after) !== JSON.stringify(before), 'the run is scheduled: the tee becomes a statement of its own')
  const exec = (f) => {
    const m = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module', ['memory', '$m', ['export', '"m"'], 1], [...f.slice(0, 2), ['export', '"f"'], ...f.slice(2)]])))
    const mem = new Float64Array(m.exports.m.buffer, 0, 256)
    for (let i = 0; i < 256; i++) mem[i] = Math.sin(i * 0.37)
    m.exports.f(0, 2040)
    return [...mem.slice(0, 256)]
  }
  is(exec(after), exec(before), 'the total is read after its step')
  // a tee the split cannot take out (what runs before it reads its name) keeps the run as written
  const held = fn([...body.slice(0, 7), ['local.set', '$w', ['f64.sub', g('$acc'), ['local.tee', '$acc', ['f64.add', g('$acc'), g('$ya')]]]], ...body.slice(7)])
  is(JSON.stringify(leadChains(['module', JSON.parse(JSON.stringify(held))])[1]), JSON.stringify(held), 'a tee left in its statement keeps the run')
})

// The Lorenz attractor's step: three loop-carried values, a 57-cycle chain of 3-cycle operations
const rk4 = `export let f = (n) => {
  let x = 0.1, y = 0.0, z = 0.0
  for (let i = 0; i < n; i++) {
    const k1x = 10 * (y - x), k1y = x * (28 - z) - y, k1z = x * y - 2.6666666666666665 * z
    const ax = x + k1x * 0.001, ay = y + k1y * 0.001, az = z + k1z * 0.001
    const k2x = 10 * (ay - ax), k2y = ax * (28 - az) - ay, k2z = ax * ay - 2.6666666666666665 * az
    const bx = x + k2x * 0.001, by = y + k2y * 0.001, bz = z + k2z * 0.001
    const k3x = 10 * (by - bx), k3y = bx * (28 - bz) - by, k3z = bx * by - 2.6666666666666665 * bz
    const cx = x + k3x * 0.002, cy = y + k3y * 0.002, cz = z + k3z * 0.002
    const k4x = 10 * (cy - cx), k4y = cx * (28 - cz) - cy, k4z = cx * cy - 2.6666666666666665 * cz
    x = x + (k1x + 2 * k2x + 2 * k3x + k4x) / 3000
    y = y + (k1y + 2 * k2y + 2 * k3y + k4y) / 3000
    z = z + (k1z + 2 * k2z + 2 * k3z + k4z) / 3000
  }
  return x * 1e6 + y * 1e3 + z
}`
test('issueOrder: an integrator step is written in the order that issues its chain soonest', () => {
  const want = oracle(rk4).f(5000)
  for (const optimize of ownedLevels('speed', { level: 'speed', issueOrder: false }, 2)) is(run(rk4, { optimize }).f(5000), want, JSON.stringify(optimize))
  if (onKernel()) return
  // the loop's operations each a statement of their own, in a new order (fresh locals); as written when off
  const fresh = (optimize) => count(parse(rk4, optimize), n => n[0] === 'local' && typeof n[1] === 'string' && /^\$io\d+$/.test(n[1]))
  ok(fresh('speed') >= 32, `the step's values take locals of their own (${fresh('speed')})`)
  is(fresh({ level: 'speed', issueOrder: false }), 0, 'issueOrder: false keeps the step as written')
  // a pass over the module twice changes nothing more; a run with a load, or too short a run, stays
  const g = (n) => ['local.get', n], c = (v) => ['f64.const', v]
  const chain = (extra) => {
    const body = [['local.set', '$a', ['f64.add', ['f64.mul', g('$a'), c(0.5)], g('$b')]]]
    for (let k = 0; k < 9; k++) body.push(['local.set', k & 1 ? '$a' : '$b', ['f64.sub', ['f64.mul', g('$a'), g('$b')], ['f64.mul', c(0.25 + k), g(k & 1 ? '$b' : '$a')]]])
    return ['func', '$f', ['param', '$n', 'i32'], ['result', 'f64'], ['local', '$a', 'f64'], ['local', '$b', 'f64'], ['local', '$i', 'i32'],
      ['local.set', '$a', c(0.1)], ['local.set', '$b', c(0.2)],
      ['loop', '$L', ...body, ...extra, ['br_if', '$L', ['i32.lt_s', ['local.tee', '$i', ['i32.add', g('$i'), ['i32.const', 1]]], g('$n')]]],
      ['f64.add', g('$a'), g('$b')]]
  }
  const exec = (f, mem) => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module', ...(mem ? [['memory', 1]] : []), [...f.slice(0, 2), ['export', '"f"'], ...f.slice(2)]]))).exports.f(40)
  const plain = chain([]), ordered = issueOrder(['module', JSON.parse(JSON.stringify(plain))])[1]
  is(exec(ordered), exec(plain), 'the reordered run computes what the run as written does')
  const again = issueOrder(['module', JSON.parse(JSON.stringify(ordered))])[1]
  is(JSON.stringify(again), JSON.stringify(ordered), 'a second pass leaves the order it chose')
  const loaded = chain([['local.set', '$b', ['f64.add', g('$b'), ['f64.load', ['i32.const', 0]]]]])
  is(JSON.stringify(issueOrder(['module', JSON.parse(JSON.stringify(loaded))])[1]), JSON.stringify(loaded), 'a load keeps the run as written')
})

test('issueOrder: the step is written depth first, most operations right after an operand they read', () => {
  if (onKernel()) return
  // the share of the step's arithmetic, in the order it evaluates, that reads the operation evaluated
  // just before it (nested in it, or from the local the statement before set): an Apple M4 ran the
  // Lorenz step 5% slower in a breadth-first order (decreasing height, a share near 0) than depth first
  const ARITH = /^f64\.(?:add|sub|mul)$/
  const share = (optimize) => {
    let run = null
    walk(parse(rk4, optimize), (L) => {
      if (L[0] !== 'loop') return
      const ops = [], from = new Map()
      const value = (e) => {
        if (!Array.isArray(e)) return null
        if (e[0] === 'local.get') return from.get(e[1]) ?? null
        if (e[0] === 'local.tee') { const v = value(e[2]); from.set(e[1], v); return v }
        const args = []
        for (let i = 1; i < e.length; i++) { const v = value(e[i]); if (v != null) args.push(v) }
        if (!ARITH.test(e[0])) return null
        ops.push(args)
        return ops.length - 1
      }
      for (const s of L.slice(1)) if (Array.isArray(s) && s[0] === 'local.set') from.set(s[1], value(s[2]))
      if (ops.length >= 16 && (!run || ops.length > run.length)) run = ops
    })
    let after = 0
    run.forEach((args, k) => { if (args.includes(k - 1)) after++ })
    return after / run.length
  }
  const depth = share('speed')
  ok(depth >= 0.5, `${(depth * 100).toFixed(0)}% of the step's operations follow an operand they read`)
})

// Blocks of a mix bus, each an inner loop carrying its own smoothing chain (slices' kernel)
const jamSrc = (call) => `
const pass = (input, bus, inOff, busOff, len, nb, gain) => {
  for (let b = 0; b < nb; b++) {
    const io = inOff[b], bo = busOff[b], l = len[b]
    let sm = 0.0
    for (let i = 0; i < l; i++) {
      sm = sm * 0.995 + input[io + i] * 0.005
      bus[bo + i] = bus[bo + i] + sm * gain
    }
  }
}
export let f = (nb, seed, spread) => {
  const input = new Float64Array(512), bus = new Float64Array(512)
  const inOff = new Int32Array(64), busOff = new Int32Array(64), len = new Int32Array(64)
  let s = seed | 0
  for (let i = 0; i < 512; i++) { s = (s * 1103515245 + 12345) | 0; input[i] = (s >>> 8) / 16777216 - 0.5 }
  for (let b = 0; b < nb; b++) {
    s = (s * 1103515245 + 12345) | 0; len[b] = ((s >>> 16) % 40) - 3
    s = (s * 1103515245 + 12345) | 0; inOff[b] = (s >>> 16) % 400
    s = (s * 1103515245 + 12345) | 0; busOff[b] = (s >>> 16) % spread
  }
  ${call}
  let h = 0
  for (let i = 0; i < 512; i++) h = (h * 31 + Math.round(bus[i] * 1e9)) | 0
  return h
}`
test('jamItems: two items of an item loop run their inner chains side by side, where their elements are apart', () => {
  const src = jamSrc('pass(input, bus, inOff, busOff, len, nb, 0.5); pass(input, bus, inOff, busOff, len, nb, 0.25)')
  const js = oracle(src).f
  for (const optimize of ownedLevels('speed', { level: 'speed', jamItems: false }, 2)) {
    const f = run(src, { optimize }).f
    // (a narrow spread overlaps the bus ranges of neighbours: the pair runs them one after the other)
    for (const nb of [0, 1, 2, 7, 24]) for (const spread of [8, 60, 400]) is(f(nb, 11 + nb, spread), js(nb, 11 + nb, spread), `${JSON.stringify(optimize)}: nb=${nb} spread=${spread}`)
  }
  // a call passing one buffer under two names: no pair
  const twice = jamSrc('pass(input, input, inOff, busOff, len, nb, 0.5)')
  for (const nb of [3, 8]) is(run(twice, { optimize: 'speed' }).f(nb, 5, 300), oracle(twice).f(nb, 5, 300), `aliased buffers: nb=${nb}`)
  // an inner loop that moves its own bound: no pair
  const moving = src.replace('const io = inOff[b], bo = busOff[b], l = len[b]', 'const io = inOff[b], bo = busOff[b]; let l = len[b]')
    .replace('bus[bo + i] = bus[bo + i] + sm * gain', 'bus[bo + i] = bus[bo + i] + sm * gain\n      l = l - 0.5')
  ok(moving !== src, 'the moving-bound variant differs')
  for (const nb of [3, 8]) is(run(moving, { optimize: 'speed' }).f(nb, 5, 300), oracle(moving).f(nb, 5, 300), `a moving bound: nb=${nb}`)
  if (onKernel()) return
  // the pair's loops: one stepping both items, one finishing each, the pair run in turn, an odd last item
  const loops = (optimize) => count(parse(src, optimize), n => n[0] === 'loop')
  ok(loops('speed') >= loops({ level: 'speed', jamItems: false }) + 4, `the pair's loops (${loops('speed')} vs ${loops({ level: 'speed', jamItems: false })} as written)`)
})

// A choice whose arms compute one tree (optimize/select-arms.js): the tree over a select of
// the leaves the arms differ in, so data that decides the test mispredicts nothing.
test('selectArms: arms that share their tree select their leaves', () => {
  const arm = (round, op) => `(${round} (${op} (f64.mul (f64.const 1.4426950408889634) (local.get $x)) (f64.const 0.5)))`
  const teed = `(f64.trunc (local.tee $t (f64.sub (f64.mul (f64.const 1.4426950408889634) (local.get $x)) (f64.const 0.5))))`
  // (past its overflow tests, as an exponential's argument is)
  const fn = (then, other, tail = '') => `(module (func $f (export "f") (param $x f64) (result f64) (local $t f64) (local $u f64) (local $k f64)
    (if (i32.eqz (f64.lt (f64.abs (local.get $x)) (f64.const 708))) (then (return (local.get $x))))
    (local.set $k (if (result f64) (f64.lt (local.get $x) (f64.const 0)) (then ${then}) (else ${other})))
    ${tail} (f64.add (f64.add (local.get $k) (local.get $t)) (local.get $u))))`
  const cases = [
    ['truncations', fn(arm('f64.trunc', 'f64.sub'), arm('f64.trunc', 'f64.add')), true],
    ['the roundings the arms decide', fn(arm('f64.ceil', 'f64.sub'), arm('f64.floor', 'f64.add')), true],
    ['a dead tee', fn(teed, arm('f64.trunc', 'f64.add'), '(local.set $t (f64.const 2))'), true],
    ['a live tee', fn(teed, arm('f64.trunc', 'f64.add')), false],
    ['two live tees', fn(teed, '(f64.trunc (local.tee $u (f64.add (f64.mul (f64.const 1.4426950408889634) (local.get $x)) (f64.const 0.5))))'), false],
    ['arms that differ in work', fn(arm('f64.trunc', 'f64.sub'), '(f64.trunc (f64.sqrt (local.get $x)))'), false],
    ['roundings no sign decides', fn(arm('f64.floor', 'f64.sub'), arm('f64.ceil', 'f64.add')), false],
  ]
  for (const [label, src, merges] of cases) {
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(parseWat(src)))).exports.f
    const ir = selectArms(parseWat(src))
    is(/"if",\["result"/.test(JSON.stringify(ir)), !merges, `${label}: ${merges ? 'one tree over a select' : 'the choice stays'}`)
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const x of [-3.7, -0.3, -0, 0, 0.3, 2.5, 709, NaN, Infinity, -Infinity, 1e300, -1e300])
      ok(Object.is(after(x), before(x)), `${label}: f(${x})`)
  }
})

// A constant base moves into the memarg (optimize/const-bases.js): where the flow holds a
// local to one address, an access adding it to an index the flow holds non-negative reads
// `offset=N` from the index.
test('constBases: a base the flow holds to one address is the memarg offset', () => {
  const g = (n) => ['local.get', n], k = (v) => ['i32.const', v]
  const load = (base, index, off) => ['i32.load', ...(off ? [`offset=${off}`] : []), ['i32.add', g(base), index]]
  const fn = (...body) => ['func', '$f', ['export', '"f"'], ['param', '$a', 'i32'], ['param', '$n', 'i32'], ['result', 'i32'],
    ['local', '$i', 'i32'], ['local', '$s', 'i32'], ...body, g('$s')]
  // a loop summing a[i], i in [0, 15], at the static address 64: the base write goes
  const counted = (index, init = [['local.set', '$a', k(64)]]) => fn(...init,
    ['block', '$B', ['br_if', '$B', ['i32.ge_s', g('$i'), k(16)]],
      ['loop', '$L', ['local.set', '$s', ['i32.add', g('$s'), load('$a', index)]],
        ['br_if', '$L', ['i32.lt_s', ['local.tee', '$i', ['i32.add', g('$i'), k(1)]], k(16)]]]])
  const shl = (x) => ['i32.shl', g(x), k(2)]
  const one = (f) => constBases(['module', f])[1]
  const text = (f) => JSON.stringify(one(JSON.parse(JSON.stringify(f))))
  ok(text(counted(shl('$i'))).includes('"i32.load","offset=64",["i32.shl"'), 'a counter\'s index reads the base from the memarg')
  ok(!text(counted(shl('$i'))).includes('"local.set","$a"'), 'the base write goes with its last read')
  ok(text(counted(shl('$i'), [['local.set', '$a', k(64)], ['if', g('$n'), ['then', ['local.set', '$a', k(64)]]]])).includes('"offset=64"'),
    'a base written twice with one address')
  const kept = (f, why) => ok(!text(f).includes('"offset=64"') && !text(f).includes('"offset=72"'), why)
  kept(counted(shl('$n')), 'an index of no known sign keeps the add')
  kept(counted(['i32.sub', shl('$i'), k(8)]), 'an index that reaches below zero keeps the add')
  kept(counted(shl('$i'), [['if', g('$n'), ['then', ['local.set', '$a', k(64)]]]]), 'a base written on one way only keeps the add')
  kept(counted(shl('$i'), []), 'a parameter no write fixes keeps the add')
  // `a[j + 1]` down to j = -1: the index is j << 2, the 4 in the memarg
  const shift = fn(['local.set', '$a', k(64)], ['local.set', '$i', ['i32.sub', g('$n'), k(1)]],
    ['block', '$B', ['loop', '$L', ['br_if', '$B', ['i32.lt_s', g('$i'), k(-1)]],
      ['local.set', '$s', ['i32.add', g('$s'), load('$a', shl('$i'), 4)]],
      ['local.set', '$i', ['i32.sub', g('$i'), k(1)]], ['br', '$L']]])
  ok(!text(shift).includes('"offset=68"'), 'an index reaching -4 keeps the add')
  // the rewritten functions read what the originals read
  for (const f of [counted(shl('$i')), counted(['local.get', '$i']), shift]) {
    const exec = (m) => {
      const inst = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module', ['memory', ['export', '"m"'], 1], m])))
      const mem = new Int32Array(inst.exports.m.buffer)
      for (let i = 0; i < 64; i++) mem[i] = Math.imul(i + 1, 2654435761)
      return [0, 1, 5, 16].map(n => inst.exports.f(64, n))
    }
    is(exec(one(JSON.parse(JSON.stringify(f)))), exec(f), 'the folded loop reads the same words')
  }
  // a static array's histogram (compile/fixed-memory.js places it, the call's address a literal)
  const hist = `
const hist = (src, count) => {
  for (let i = 0; i < 256; i++) count[i] = 0
  for (let i = 0; i < 1024; i++) count[src[i]]++
  let m = 0
  for (let i = 0; i < 256; i++) m = (m + count[i] * i) | 0
  return m
}
export let f = () => {
  const src = new Uint8Array(1024), count = new Int32Array(256)
  let h = 0
  for (let it = 0; it < 3; it++) {
    for (let i = 0; i < 1024; i++) src[i] = (i * 7 + it) & 255
    h = (h + hist(src, count)) | 0
  }
  return h
}`
  const w = compile(hist, { wat: true, optimize: 'speed' })
  is((w.match(/\(i32\.(?:load|store) offset=\d{3,}\s+\(i32\.shl/g) || []).length, 2, 'the count increment loads and stores at its address')
  is(run(hist, { optimize: 'speed' }).f(), oracle(hist).f())
})

// A cell is 8 bytes from `$__alloc`, their address in an i32 local, read and
// written through plain loads and stores of one type.
test('promoteCells: a cell is a local only where its address goes nowhere', () => {
  const g = (n) => ['local.get', n], alloc = (n = 8) => ['call', '$__alloc', ['i32.const', n]]
  const fn = (decls, ...body) => ['func', '$f', ['param', '$p', 'f64'], ['param', '$e', 'i32'], ['result', 'f64'], ...decls.map(([n, t]) => ['local', n, t]), ...body]
  const C = '$' + T + 'cell_s', H = '$' + T + 'held_s'
  const after = (f) => { promoteCells(f); return JSON.stringify(f) }
  const kept = (why, decls, ...body) => is(after(fn(decls, ...body)), JSON.stringify(fn(decls, ...body)), why)
  const cell = (c = C) => [['local.set', c, alloc()], ['f64.store', g(c), g('$p')]]

  is(after(fn([[C, 'i32']], ...cell(), ['f64.store', g(C), ['f64.add', ['f64.load', g(C)], g('$p')]], ['f64.load', g(C)])),
    JSON.stringify(fn([[H, 'f64']], ['nop'], ['local.set', H, g('$p')], ['local.set', H, ['f64.add', g(H), g('$p')]], g(H))),
    'the allocation is nothing, a load the local, a store its write, the declaration the value\'s type')
  is(after(fn([[C, 'i32']], ['local.set', C, alloc()], ['i32.store', g(C), ['i32.const', 7]], ['f64.convert_i32_s', ['i32.load', g(C)]])),
    JSON.stringify(fn([[H, 'i32']], ['nop'], ['local.set', H, ['i32.const', 7]], ['f64.convert_i32_s', g(H)])), 'a cell of a word is an i32 local')
  is(after(fn([['$t', 'i32']], ...cell('$t'), ['f64.load', g('$t')])),
    JSON.stringify(fn([['$t', 'f64']], ['nop'], ['local.set', '$t', g('$p')], g('$t'))), 'a local of another name keeps it')
  is(after(fn([[C, 'i32']], ['loop', '$L', ...cell(), ['br_if', '$L', ['f64.lt', ['f64.load', g(C)], ['f64.const', 0]]]], ['f64.load', g(C)])),
    JSON.stringify(fn([[H, 'f64']], ['loop', '$L', ['nop'], ['local.set', H, g('$p')], ['br_if', '$L', ['f64.lt', g(H), ['f64.const', 0]]]], g(H))),
    'a fresh cell each round is the one local')
  // the same node under two parents (the optimizer's passes share subtrees) reads the local under both
  const shared = ['f64.load', g(C)]
  is(after(fn([[C, 'i32']], ...cell(), ['f64.add', shared, shared])),
    JSON.stringify(fn([[H, 'f64']], ['nop'], ['local.set', H, g('$p')], ['f64.add', g(H), g(H)])), 'a shared read is rewritten once for both parents')
  // two cells: the one whose address a closure's environment takes stays, the other goes
  is(after(fn([[C, 'i32'], ['$d', 'i32']], ...cell(), ...cell('$d'), ['i32.store', g('$e'), g('$d')], ['f64.add', ['f64.load', g(C)], ['f64.load', g('$d')]])),
    JSON.stringify(fn([[H, 'f64'], ['$d', 'i32']], ['nop'], ['local.set', H, g('$p')], ...cell('$d'), ['i32.store', g('$e'), g('$d')], ['f64.add', g(H), ['f64.load', g('$d')]])),
    'each cell is judged alone')

  kept('an address stored as a value', [[C, 'i32']], ...cell(), ['i32.store', g('$e'), g(C)], ['f64.load', g(C)])
  kept('an address stored into its own cell', [[C, 'i32']], ['local.set', C, alloc()], ['i32.store', g(C), g(C)], ['f64.convert_i32_s', ['i32.load', g(C)]])
  kept('an address passed to a call', [[C, 'i32']], ...cell(), ['call', '$__durable_cell_snap', g(C)], ['f64.load', g(C)])
  kept('an address compared', [[C, 'i32']], ...cell(), ['if', ['i32.lt_u', g(C), ['global.get', '$__heap_reset']], ['then', ['nop']]], ['f64.load', g(C)])
  kept('an address copied to another local', [[C, 'i32'], ['$t', 'i32']], ...cell(), ['local.set', '$t', g(C)], ['f64.load', g('$t')])
  kept('an address computed on', [[C, 'i32']], ...cell(), ['f64.load', ['i32.add', g(C), ['i32.const', 0]]])
  kept('a local also given another address', [[C, 'i32']], ...cell(), ['local.set', C, g('$e')], ['f64.load', g(C)])
  kept('a local only ever given another address', [[C, 'i32']], ['local.set', C, g('$e')], ['f64.store', g(C), g('$p')], ['f64.load', g(C)])
  kept('a local never given an address', [[C, 'i32']], ['f64.load', g(C)])
  kept('an allocation through a tee', [[C, 'i32']], ['f64.store', ['local.tee', C, alloc()], g('$p')], ['f64.load', g(C)])
  kept('an allocation of another size', [[C, 'i32']], ['local.set', C, alloc(16)], ['f64.store', g(C), g('$p')], ['f64.load', g(C)])
  kept('a cell read as two types', [[C, 'i32']], ...cell(), ['f64.convert_i32_s', ['i32.load', g(C)]])
  kept('a load of another width', [[C, 'i32']], ...cell(), ['f64.convert_i64_s', ['i64.load', g(C)]])
  kept('a load at an offset', [[C, 'i32']], ...cell(), ['f64.load', 'offset=8', g(C)])
  kept('a parameter', [], ['f64.store', g('$e'), g('$p')], ['f64.load', g('$e')])
  kept('a function of no locals', [], g('$p'))
  kept('an allocation nothing reads', [[C, 'i32']], ['local.set', C, alloc()], g('$p'))

  // the rewritten function answers as the original: a sum kept in a cell over a counted loop
  const source = `(module (memory 1) (global $heap (mut i32) (i32.const 16))
    (func $__alloc (param $n i32) (result i32) (global.get $heap) (global.set $heap (i32.add (global.get $heap) (local.get $n))))
    (func $f (export "f") (param $p f64) (param $n i32) (result f64) (local $c i32) (local $i i32)
      (local.set $c (call $__alloc (i32.const 8)))
      (f64.store (local.get $c) (f64.const 0.5))
      (block $B (loop $L (br_if $B (i32.ge_s (local.get $i) (local.get $n)))
        (f64.store (local.get $c) (f64.add (f64.load (local.get $c)) (f64.mul (local.get $p) (f64.convert_i32_s (local.get $i)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $L)))
      (f64.load (local.get $c))))`
  const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(parseWat(source)))).exports.f
  const tree = parseWat(source), f = findFunc(tree, '$f')
  promoteCells(f)
  ok(!JSON.stringify(f).includes('$__alloc') && !JSON.stringify(f).includes('f64.load'), 'the cell is gone')
  const run2 = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(tree))).exports.f
  for (const [p, n] of [[1.5, 0], [1.5, 1], [-0.25, 7], [1e300, 3], [NaN, 2]]) is(run2(p, n), before(p, n), `f(${p}, ${n})`)
})
