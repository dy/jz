/**
 * structInline Array<S> — the wholesale replace store (`ps[i] = {S-literal}`,
 * the immutable-update idiom) and the packed i32 cell layout
 * (ctx.schema.inlineCellI32: all-strict-int32 schemas store K raw i32 fields
 * per element — C's record layout, no per-field trunc_sat/convert).
 *
 * MEMORY-LAYOUT CRITICAL — a boxed store on cell memory (or a plain read of a
 * packed array) is silent corruption, so the fail-closed directions get equal
 * pinning: alias observation, value-position stores, element escape, schema
 * conflicts across call sites, and the call-expr-arg param-agreement hole all
 * must poison the sid back to the plain layout.
 */
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { ctx } from '../src/ctx.js'
import { run, oracle, compile, compileInProcess } from './util.js'
import { levels, onKernel } from './_matrix.js'


// The innermost loops of a function's text: the kernel's own, apart from what
// stands before them in the loops around (a save of the array for the reset,
// once ahead of a loop whose stores are in bounds, emit/control-flow.js).
const innerLoops = (text) => {
  const out = []
  for (let at = text.indexOf('(loop '); at >= 0; at = text.indexOf('(loop ', at + 1)) {
    let depth = 0, end = at
    for (; end < text.length; end++) { if (text[end] === '(') depth++; else if (text[end] === ')' && --depth === 0) break }
    const body = text.slice(at, end)
    if (!body.slice(6).includes('(loop ')) out.push(body)
  }
  return out
}

const both = (src, name = 'main') => {
  const truth = oracle(src)[name]()
  for (const optimize of levels(false, true))
    is(run(src, { optimize }).exports?.[name]() ?? run(src, { optimize })[name](), truth, `${name} bit-matches JS (optimize:${optimize})`)
}

// The immutable-update kernel shape: int-certain 4-field records, cursor read
// → projections → wholesale literal replace, threaded through init → main →
// step as the bench case does.
const KERNEL = (fields = 'x: nx, y: ny, vx: wx, vy: wy', init = 'x: (s >>> 2) & 255, y: (s >>> 5) & 255, vx: (1 + (s & 3)) | 0, vy: (1 + ((s >>> 9) & 3)) | 0') => `
const init = () => {
  const ps = []
  let s = 0x9e3779b9 | 0
  for (let i = 0; i < 24; i++) {
    s = (s ^ (s << 7)) | 0
    s = (s ^ (s >>> 9)) | 0
    ps.push({ ${init} })
  }
  return ps
}
const step = (ps) => {
  let h = 0
  for (let it = 0; it < 5; it++) {
    for (let i = 0; i < 24; i++) {
      const p = ps[i]
      const nx = (p.x + p.vx) & 1023, ny = (p.y + p.vy) & 1023
      const wx = (p.vx ^ it) | 0, wy = (p.vy + 1) | 0
      ps[i] = { ${fields} }
      h = Math.imul(h ^ (nx + ny * 31), 16777619)
    }
  }
  return h >>> 0
}
export let main = () => {
  let cs = step(init())
  const ps = init()
  cs = (cs + step(ps) + ps.length) | 0
  return cs
}`

test('struct-inline: replace store engages the packed i32 layout (values + wat)', () => {
  const src = KERNEL()
  both(src)
  const wat = compile(src, { wat: true, optimize: true })
  const body = wat.split('(func ').find(c => /^\$step\b/.test(c)) || ''
  ok(body, 'step emitted')
  const loop = body.slice(body.indexOf('(loop'))
  ok(/i32\.store offset=12/.test(loop), 'packed 4×i32 element: last field at +12')
  ok(!/trunc_sat/.test(loop), 'no f64→i32 conversions in the kernel loop')
  ok(!/call \$__mkptr/.test(loop), 'no element re-boxing in the kernel loop')
  ok(innerLoops(body).every(l => !/call \$__alloc/.test(l)), 'no allocation in the kernel loop')
})

test('struct-inline: float fields stay on f64 cells, replace store still engages', () => {
  // non-int fields — inlineCellI32 must refuse; the store is still cell writes
  const src = KERNEL('x: nx + 0.5, y: ny, vx: wx, vy: wy', 'x: ((s >>> 2) & 255) + 0.5, y: (s >>> 5) & 255, vx: (1 + (s & 3)) | 0, vy: (1 + ((s >>> 9) & 3)) | 0')
  both(src)
  const wat = compile(src, { wat: true, optimize: true })
  const body = wat.split('(func ').find(c => /^\$step\b/.test(c)) || ''
  const loop = body.slice(body.indexOf('(loop'))
  ok(/f64\.store offset=24/.test(loop), 'f64 cells: last field at +24')
  ok(innerLoops(body).every(l => !/call \$__alloc/.test(l)), 'no allocation in the kernel loop')
})

test('struct-inline: odd field count packs with a pad cell', () => {
  const src = `
const init = () => {
  const ps = []
  for (let i = 0; i < 9; i++) ps.push({ a: i, b: i * 2, c: i * 3 })
  return ps
}
export let main = () => {
  const ps = init()
  let h = 0
  for (let i = 0; i < 9; i++) {
    const p = ps[i]
    ps[i] = { a: (p.a + 1) | 0, b: (p.b + p.c) | 0, c: (p.c ^ p.a) | 0 }
    h = (h * 31 + p.a) | 0
  }
  const q = ps[8]
  return (h + q.a + q.b * 7 + q.c * 13 + ps.length) | 0
}`
  both(src)
})

test('struct-inline: cursor field write hits the packed cell', () => {
  const src = `
const init = () => {
  const ps = []
  for (let i = 0; i < 6; i++) ps.push({ n: i, m: i * 5 })
  return ps
}
export let main = () => {
  const ps = init()
  let h = 0
  for (let i = 0; i < 6; i++) {
    const p = ps[i]
    p.n = (p.n + p.m) | 0
    h = (h * 31 + p.n) | 0
  }
  const t = ps[3]
  return (h + t.n) | 0
}`
  both(src)
})

test('struct-inline: alias read after the replace store keeps JS identity (plain layout)', () => {
  // p observed AFTER ps[i] is replaced — JS: p still sees the OLD record.
  // The sweep's alias-liveness must refuse, keeping the boxed layout.
  const src = `
const init = () => {
  const ps = []
  ps.push({ x: 41, y: 2 })
  ps.push({ x: 7, y: 9 })
  return ps
}
export let main = () => {
  const ps = init()
  const p = ps[0]
  ps[0] = { x: 100, y: 200 }
  return (p.x * 1000 + ps[0].x) | 0   // JS: 41100
}`
  both(src)
})

test('struct-inline: value-position store keeps JS semantics (plain layout)', () => {
  const src = `
const init = () => {
  const ps = []
  ps.push({ x: 5, y: 6 })
  return ps
}
export let main = () => {
  const ps = init()
  const q = (ps[0] = { x: 8, y: 9 })
  return (q.x * 10 + ps[0].y) | 0   // 89
}`
  both(src)
})

test('struct-inline: element escape as call arg poisons the sid', () => {
  const src = `
const take = (o) => o.x + 1
const init = () => {
  const ps = []
  ps.push({ x: 3, y: 4 })
  return ps
}
export let main = () => {
  const ps = init()
  const p = ps[0]
  ps[0] = { x: 30, y: 40 }
  return (take(p) + ps[0].y) | 0   // old p escapes → 4 + 40 = 44
}`
  both(src)
})

test('struct-inline: call-expr arg into a schema-conflicted param stays plain (.length semantics)', () => {
  // use() receives Array<{x,y}> AND Array<{z,w,q}> — its param carries no elem
  // fact. If mk's return were inline-carried, the plain `.length` read inside
  // use() would see the PHYSICAL cell count (K·n) instead of n.
  const src = `
const mk = () => {
  const a = []
  a.push({ x: 41, y: 2 })
  return a
}
const other = () => {
  const b = []
  b.push({ z: 3, w: 4, q: 5 })
  return b
}
const use = (ps) => ps.length
export let main = () => (use(mk()) * 10 + use(other())) | 0   // 11
`
  both(src)
})

test('struct-inline: push returns the logical length; .length agrees', () => {
  const src = `
export let main = () => {
  const ps = []
  const r1 = ps.push({ u: 1, v: 2, w: 3, t: 4 })
  const r2 = ps.push({ u: 5, v: 6, w: 7, t: 8 })
  const p = ps[1]
  ps[1] = { u: (p.u + 1) | 0, v: p.v, w: p.w, t: p.t }
  return (r1 * 100 + r2 * 10 + ps.length) | 0   // 122
}`
  both(src)
})

test('struct-inline: .length write poisons the sid (logical vs physical cells)', () => {
  // `ps.length = n` resizes in LOGICAL units; the inline carrier's header
  // counts physical cells — the write must force the plain layout.
  const src = `
const init = () => {
  const ps = []
  ps.push({ x: 1, y: 2 })
  ps.push({ x: 3, y: 4 })
  ps.push({ x: 5, y: 6 })
  return ps
}
export let main = () => {
  const ps = init()
  const p = ps[0]
  ps[0] = { x: (p.x + 10) | 0, y: p.y }
  ps.length = 1
  return (ps.length * 100 + ps[0].x) | 0   // 111
}`
  both(src)
})

test('struct-inline: an absent replace receiver throws before the store and recovers', () => {
  // The RHS reads p.x before the assignment can extend ps. At i == length,
  // p is undefined: a packed carrier must preserve the property-read error.
  const src = `
const init = () => {
  const ps = []
  ps.push({ x: 1, y: 2 })
  ps.push({ x: 3, y: 4 })
  return ps
}
export let main = (n) => {
  const ps = init()
  const k = n | 0
  for (let i = 0; i < k; i++) {
    const p = ps[i]
    ps[i] = { x: (p.x + 1) | 0, y: p.y }
  }
  return (ps.length * 100 + ps[0].x + ps[1].x) | 0
}`
  const host = oracle(src).main
  throws(() => host(3), /undefined/, 'the source throws on the first absent receiver')
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const w = run(src, { optimize }), call = w.exports?.main ?? w.main
    for (const n of [0, 1, 2, 2, 0, 2]) {
      is(call(n), host(n), `O${optimize}: ${n} replacements preserve the fields and length`)
      throws(() => call(3), /undefined/, 'the absent receiver throws before the store')
    }
  }
})

test('struct-inline: inplace idx evaluation order (a[i++] = {…} sees post-increment values)', () => {
  // JS: the member target (i++) evaluates before the RHS — x must read the
  // incremented i while the store lands at the old index. The values-first
  // spill order shipped this divergence at every optimize level.
  const src = `
export let main = () => {
  const a = []
  a.push({ x: 7, y: 8 })
  a.push({ x: 9, y: 10 })
  let i = 0
  const p = a[i]
  const dummy = p.x
  a[i++] = { x: i + 100, y: 2 }
  return (a[0].x * 1000 + i + dummy) | 0   // 101008
}`
  both(src)
})

// --- closed-union carrier eligibility (analyzeUnionInline, stage 1) ---
// The verifier must accept the canonical tagged-record stream (cursor + tag
// alias + discriminant chain incl. the exclusion-proven trailing else) and
// fail closed on a stale tag alias or an unguarded variant read.
test('union inline: eligibility verdicts (positive + fail-closed negatives)', () => {
  const BODY = (reads) => `
    const NSHAPES = 4
    export let main = () => {
      const rows = []
      let s = 0x1234abcd | 0
      for (let i = 0; i < 64; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        const k = s & (NSHAPES - 1)
        const a = (s >>> 3) & 255, b = (s >>> 13) & 255
        if (k === 0) rows.push({ k: k, x: a, y: b })
        else if (k === 1) rows.push({ k: k, r: a })
        else if (k === 2) rows.push({ k: k, w: a, h: b })
        else rows.push({ k: k, n: a, s: b })
      }
      let h = 0
      for (let i = 0; i < rows.length; i++) {
        const o = rows[i]
        ${reads}
      }
      return h
    }`
  const elig = (src) => { compile(src, { optimize: 'speed' }); return [...(ctx.schema.inlineUnion?.keys() || [])] }
  is(elig(BODY(`const k = o.k
        if (k === 0) h = (h + o.x) | 0
        else if (k === 1) h = (h + o.r) | 0
        else if (k === 2) h = (h + o.w) | 0
        else h = (h + o.n) | 0`)).join(';'), '0,1,2,3', 'discriminant chain eligible')
  is(elig(BODY(`let k = o.k
        k = 0
        if (k === 0) h = (h + o.x) | 0`)).join(';'), '', 'stale tag alias fails closed')
  is(elig(BODY(`h = (h + o.x) | 0`)).join(';'), '', 'unguarded variant read fails closed')
  is(elig(BODY(`h = (h + o.k) | 0`)).join(';'), '0,1,2,3', 'union-agreeing tag read eligible')
  // Exported return crosses to the HOST — memory.read would decode packed
  // cells as a plain array. narrowReturnArrayElems never sets the fact on
  // exported functions, so the return sanction must fail closed.
  const exp = `
    export let make = () => {
      const rows = []
      let s = 1
      for (let i = 0; i < 8; i++) {
        s = (s * 3) | 0
        const k = s & 1
        if (k === 0) rows.push({ k: k, x: s })
        else rows.push({ k: k, r: s, q: s })
      }
      return rows
    }`
  compile(exp, { optimize: 'speed' })
  is([...(ctx.schema.inlineUnion?.keys() || [])].join(';'), '', 'exported union return fails closed')
})

// --- union carrier end-to-end: packed cells, exact values ---
// One-function tagged-record stream through the max-K-stride packed i32
// carrier: contiguous ⌈stride/2⌉-cell records, raw i32 field reads resolved
// by the discriminant ladder (positive + exclusion refinements). Value must
// equal the JS oracle exactly; the WAT must carry ZERO dynamic reads.
test('union inline: packed carrier is JS-exact and fully devirtualized', () => {
  const SRC = `
    const NSHAPES = 4
    export let main = () => {
      const rows = []
      let s = 0x1234abcd | 0
      for (let i = 0; i < 256; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        const k = s & (NSHAPES - 1)
        const a = (s >>> 3) & 255, b = (s >>> 13) & 255
        if (k === 0) rows.push({ k: k, x: a, y: b })
        else if (k === 1) rows.push({ k: k, r: a })
        else if (k === 2) rows.push({ k: k, w: a, h: b })
        else rows.push({ k: k, n: a, s: b })
      }
      let h = 0
      for (let it = 0; it < 4; it++) {
        let sum = it | 0
        for (let i = 0; i < rows.length; i++) {
          const o = rows[i]
          const k = o.k
          let m = 0
          if (k === 0) m = (o.x + o.y) | 0
          else if (k === 1) m = Math.imul(o.r, 3)
          else if (k === 2) m = Math.imul(o.w, o.h)
          else m = Math.imul(o.n, o.s)
          sum = (sum + m) | 0
        }
        h = (Math.imul(h, 31) + sum) | 0
      }
      return h
    }`
  const host = oracle(SRC).main()
  is(run(SRC, { optimize: 'speed' }).main(), host)
  const wat = compile(SRC, { optimize: { level: 'speed', watr: false }, wat: true })
  const seg = String(wat)
  const mainSeg = seg.slice(seg.indexOf('(func $main'), seg.indexOf('\n  (func ', seg.indexOf('(func $main') + 10))
  is((mainSeg.match(/__dyn_get/g) || []).length, 0, 'zero dynamic reads in the kernel')
  ok(/i32\.load offset=/.test(mainSeg), 'raw packed-cell field reads')
})

// --- union carrier stage 3: cursor crosses a user call (measure(rows[i])) ---
// The shapes-bench shape: rows born from a returning call, the element cursor
// passed to a callee whose param carries the settled union, a full terminator
// else-if ladder with a TRAILING fallback (narrowed by exclusion stacking),
// the discriminant local typed i32, and ONE entry unbox for the cell address.
test('union inline: cursor param crosses the call — packed, i32 ladder, exact', () => {
  const SRC = `
    const NSHAPES = 4
    const initRows = () => {
      const rows = []
      let s = 0x1234abcd | 0
      for (let i = 0; i < 256; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        const k = s & (NSHAPES - 1)
        const a = (s >>> 3) & 255, b = (s >>> 13) & 255
        if (k === 0) rows.push({ k: k, x: a, y: b })
        else if (k === 1) rows.push({ k: k, r: a })
        else if (k === 2) rows.push({ k: k, w: a, h: b })
        else rows.push({ k: k, n: a, s: b })
      }
      return rows
    }
    const measure = (o) => {
      const k = o.k
      if (k === 0) return (o.x + o.y) | 0
      else if (k === 1) return Math.imul(o.r, 3)
      else if (k === 2) return Math.imul(o.w, o.h)
      return Math.imul(o.n, o.s)
    }
    export let main = () => {
      const rows = initRows()
      let h = 0
      for (let it = 0; it < 4; it++) {
        let sum = it | 0
        for (let i = 0; i < rows.length; i++) sum = (sum + measure(rows[i])) | 0
        h = (Math.imul(h, 31) + sum) | 0
      }
      return h
    }`
  const host = oracle(SRC).main()
  for (const optimize of levels(false, 'speed')) is(run(SRC, { optimize }).main(), host, `JS-exact (optimize:${optimize})`)
  // Reference mode: unionInline:false disables the representation wholesale —
  // the three-way differential leg (off / on / plain JS above).
  is(run(SRC, { optimize: { level: 'speed', unionInline: false } }).main(), host, 'JS-exact (unionInline:false)')
  is([...(ctx.schema.inlineUnion?.keys() || [])].join(';'), '', 'reference mode registers no union')
  // The source inliner splices `measure` into the loop (its ladder keeps its
  // shape, and the reads stay packed); the clone is the call crossing's form.
  const wat = String(compile(SRC, { optimize: { level: 'speed', watr: false, sourceInline: false }, wat: true }))
  // The carrier-specialized CLONE (audit decision 2): raw-i32 cell-address
  // param, packed loads, no NaN-box anywhere in the callee.
  const m0 = wat.indexOf('(func $measure$union')
  ok(m0 >= 0, 'carrier-specialized clone emitted')
  const seg = wat.slice(m0, wat.indexOf('\n  (func ', m0 + 10))
  ok(/\(param \$o i32\)/.test(seg), 'cursor param is a raw i32 cell address')
  is((seg.match(/__dyn_get/g) || []).length, 0, 'zero dynamic reads in measure$union')
  is((seg.match(/f64\.(eq|convert|load)/g) || []).length, 0, 'all-i32 dispatch (no f64 ladder)')
  ok(seg.includes('(local $k i32)'), 'discriminant local typed i32')
  is((seg.match(/i64\.reinterpret_f64/g) || []).length, 0, 'ZERO unbox — the address arrives raw')
  // Byte-stride ratchet: this union's max member is 3 fields → records are
  // 12 B (stride·4, NO pad cell — not ⌈3/2⌉·8 = 16). The caller's element
  // math must multiply by the byte stride.
  ok(/\(i32\.mul[\s\S]{0,80}?\(i32\.const 12\)|\(i32\.const 12\)[\s\S]{0,80}?\(i32\.mul/.test(wat),
    'byte-stride element math (12 B records, no pad cell)')
})

// The 2026-07-18 re-audit's miscompile class: a cursor-param body whose uses
// escape the cursor grammar (bracket read, alias, return, closure capture,
// forwarding) must BLACK the union — schema membership alone is not carrier
// provenance. Each case pins VALUE EXACTNESS at both opt levels (pre-patch:
// bracket read WRONG VALUES, alias/forward OOB TRAP).
test('union inline: non-grammar cursor-param uses fail closed, values exact', () => {
  const SRC = (read, extra = '') => `
    ${extra}
    const measure = (o) => {
      const k = o.k
      if (k === 0) { ${read} }
      else if (k === 1) return Math.imul(o.r, 3)
      else if (k === 2) return Math.imul(o.w, o.h)
      return Math.imul(o.n, o.s)
    }
    export let main = () => {
      const rows = []
      let s = 0x1234abcd | 0
      for (let i = 0; i < 256; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        const k = s & 3
        const a = (s >>> 3) & 255, b = (s >>> 13) & 255
        if (k === 0) rows.push({ k: k, x: a, y: b })
        else if (k === 1) rows.push({ k: k, r: a })
        else if (k === 2) rows.push({ k: k, w: a, h: b })
        else rows.push({ k: k, n: a, s: b })
      }
      let h = 0
      for (let i = 0; i < rows.length; i++) {
        const m = measure(rows[i])
        h = (h + (typeof m === 'number' ? m : (m.x | 0))) | 0
      }
      return h
    }`
  const CASES = {
    bracket: [`return (o['x'] + o['y']) | 0`],
    alias: [`const q = o
      return (q.x + q.y) | 0`],
    ret_obj: [`return o.x ? { x: o.x } : { x: o.y }`],
    capture: [`const f = () => o.x
      return f() | 0`],
    forward: [`return helper(o)`, 'const helper = (p) => (p.x + p.y) | 0'],
    shadow: [`{ const o = { k: 0, x: 7, y: 9 }
        return (o.x + o.y) | 0 }`],
  }
  for (const [name, [read, extra = '']] of Object.entries(CASES)) {
    const src = SRC(read, extra)
    const truth = oracle(src).main()
    for (const optimize of levels(false, 'speed'))
      is(run(src, { optimize }).main(), truth, `${name} JS-exact (optimize:${optimize})`)
  }
})

// A body reassignment of the cursor param invalidates the entry fact — the
// registration must fail closed (correct value through the plain path).
test('union inline: reassigned cursor param fails closed, value exact', () => {
  const SRC = `
    const measure = (o, alt) => {
      o = alt
      const k = o.k
      if (k === 0) return (o.x + o.y) | 0
      return Math.imul(o.n, o.s)
    }
    export let main = () => {
      const rows = []
      let s = 1
      for (let i = 0; i < 32; i++) {
        s = (Math.imul(s, 3) + 7) | 0
        const k = s & 1
        if (k === 0) rows.push({ k: k, x: s & 255, y: (s >>> 8) & 255 })
        else rows.push({ k: 1, n: s & 255, s: (s >>> 8) & 255 })
      }
      const alt = { k: 0, x: 3, y: 4 }
      let h = 0
      for (let i = 0; i < rows.length; i++) h = (h + measure(rows[i], alt)) | 0
      return h
    }`
  const host = oracle(SRC).main()
  for (const optimize of levels(false, 'speed')) is(run(SRC, { optimize }).main(), host, `JS-exact (optimize:${optimize})`)
})

const cases = [0, 0, 1, 2, -1, 0.5, NaN, Infinity, 4294967296, 1, 0]
const verify = src => {
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const wasm = run(src, { optimize: { level: optimize, sourceInline: false } })
    for (const k of cases) {
      is(wasm.main(k, 0), js.main(k, 0), `unused cursor ${k}, ${optimize}`)
      if (k === 0 || k === 1) is(wasm.main(k, 1), js.main(k, 1), `projection ${k}, ${optimize}`)
      else throws(() => wasm.main(k, 1), `missing projection ${k}, ${optimize}`)
      is(wasm.main(0, 1), js.main(0, 1), `recovery ${k}, ${optimize}`)
    }
  }
}

for (const float of [false, true]) test(`packed bounds: ${float ? 'float' : 'integer'} cursor preserves absence until projection`, () => {
  const src = `
    function rows() { const a=[]; a.push({x:${float ? 1.5 : 1},y:2}); a.push({x:${float ? 3.5 : 3},y:4}); return a }
    export function main(k, flag) { k=+k; const a=rows(); const p=a[k]; if(flag) return p.x+p.y; return 0 }
  `
  verify(src)
  if (!onKernel()) {
    compile(src, { optimize: 'size' })
    ok(ctx.schema.inlineArray.size > 0, 'checked reads retain inline cells')
  }
})

test('packed bounds: direct projections evaluate their index once and recover', () => {
  const src = `
    function rows() { const a=[]; a.push({x:1,y:2}); a.push({x:3,y:4}); return a }
    export function main(k, flag) { k=+k; const a=rows(); if(flag) return a[k++].x*10+k; return 0 }
  `
  verify(src)
})

test('packed bounds: initialized pointer presence ends at a binding write or capture', () => {
  for (const mutation of ['if(flag)p=undefined', 'const clear=()=>{p=undefined};if(flag)clear()',
    'if(flag){p=undefined}else{p={x:7,y:8}}']) {
    const src = `export function main(flag){const a=[];a.push({x:3,y:4});
      for(let i=0;i<a.length;i++){let p=a[i];${mutation};try{return p.x+p.y}catch(e){return e instanceof TypeError?'missing':'wrong'}}
      return 0}`
    const js = oracle(src)
    for (const optimize of levels(0,1,2,3,'size')) {
      const wasm = run(src, {optimize})
      for (const flag of [0,0,1,0,1]) is(wasm.main(flag),js.main(flag), `${mutation}, O${optimize}, flag=${flag}`)
    }
  }
})

test('packed bounds: union cursor checks absence before discriminant and helper projection', () => {
  const src = `
    function rows() { const a=[]; a.push({kind:0,x:3,y:5}); a.push({kind:1,z:7}); return a }
    function get(p) { return p.kind === 0 ? p.x+p.y : p.z }
    export function main(k, flag) { k=+k; const a=rows(); const p=a[k]; if(flag) return get(p); return 0 }
  `
  verify(src)
  if (!onKernel()) {
    compile(src, { optimize: { level: 'size', sourceInline: false } })
    is(ctx.schema.inlineUnion.size, 0, 'unbounded cursor calls retain the ordinary object ABI')
  }
})


test('packed bounds: direct union projections retain packed cells with checked indices', () => {
  const src = `
    function rows() { const a=[]; a.push({kind:0,x:3,y:5}); a.push({kind:1,z:7}); return a }
    export function main(k, flag) { k=+k; const a=rows(); if(flag) return a[k].kind; return 0 }
  `
  verify(src)
  if (!onKernel()) {
    compile(src, { optimize: 'size' })
    ok(ctx.schema.inlineUnion.size > 0, 'checked direct reads retain packed union cells')
  }
})

test('packed bounds: empty arrays and bracket projections preserve lazy absence', () => {
  const src = `
    function rows(n) { const a=[]; for(let i=0;i<n;i++) a.push({x:i+1,y:i+3}); return a }
    export function main(n,k,flag) { const a=rows(n); const p=a[k]; if(flag) return p['x']+p['y']; return 0 }
  `
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const wasm = run(src, { optimize: { level: optimize, sourceInline: false } })
    for (const [n,k] of [[0,0],[0,0],[1,0],[1,1],[2,1],[2,-1],[0,0],[1,0]]) {
      is(wasm.main(n,k,0), 0, `unused empty/changed cursor ${n},${k}, ${optimize}`)
      if(k>=0&&k<n) is(wasm.main(n,k,1), js.main(n,k,1), `bracket projection ${n},${k}, ${optimize}`)
      else throws(() => wasm.main(n,k,1), `missing bracket projection ${n},${k}, ${optimize}`)
      is(wasm.main(1,0,1), js.main(1,0,1), `bracket recovery ${n},${k}, ${optimize}`)
    }
  }
})


test('packed bounds: index calls follow relocated receiver storage after evaluating the key', () => {
  const src = `
    let sink;
    function rows(){const a=[];a.push({x:3,y:4});a.push({x:5,y:6});return a}
    function grow(a){sink=new Array(1000).fill(2);for(let i=0;i<2048;i++)a.push({x:100+i,y:200+i});return 2049}
    export function main(){const a=rows();return a[grow(a)].x}
    export function retained(){return sink.length}
  `
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const wasm = run(src, { optimize: { level: optimize, sourceInline: false } })
    for(let i=0;i<3;i++) {
      is(wasm.main(), js.main(), `relocated last cell ${i}, ${optimize}`)
      is(wasm.retained(), js.retained(), `intervening allocation retained ${i}, ${optimize}`)
    }
  }
})


test('packed bounds: dynamic string keys retain ordinary property-key semantics', () => {
  for(const union of [false,true]) {
    const src = `
      function rows(){const a=[];a.push({x:3,y:4});a.push({${union ? 'x:5,z:6,w:7' : 'x:5,y:6'}});return a}
      export function main(k){k=String(k);const a=rows();return a[k].x}
    `
    const js = oracle(src)
    for(const optimize of levels(0,1,2,3,'size')) {
      const wasm=run(src,{optimize:{level:optimize,sourceInline:false}})
      for(const key of ['0','0','1','2','-1','01','-0','0']) {
        if(['0','1'].includes(key)) is(wasm.main(key),js.main(key), `property ${key}, union:${union}, ${optimize}`)
        else throws(()=>wasm.main(key),`missing property ${key}, union:${union}, ${optimize}`)
        is(wasm.main('0'),js.main('0'),`property recovery ${key}, union:${union}, ${optimize}`)
      }
    }
  }
})

test('packed bounds: unhinted host keys preserve numeric and string element semantics', () => {
  const src = `
    function rows(){const a=[];a.push({x:3,y:4});a.push({x:5,y:6});return a}
    export function main(k,flag){const a=rows();const p=a[k];if(flag)return p.x;return 0}
  `
  verify(src)
  const js=oracle(src)
  for(const optimize of levels(0,1,2,3,'size')) {
    const wasm=run(src,{optimize:{level:optimize,sourceInline:false}})
    for(const key of ['0','0','1','2','01','-0','0']) {
      is(wasm.main(key,0),0,`unused host string ${key}, ${optimize}`)
      if(key==='0'||key==='1') is(wasm.main(key,1),js.main(key,1),`host string ${key}, ${optimize}`)
      else throws(()=>wasm.main(key,1),`missing host string ${key}, ${optimize}`)
      is(wasm.main(0,1),js.main(0,1),`host key recovery ${key}, ${optimize}`)
    }
  }
})


// --- carrier ownership: the frame that builds the records and every frame
// that reads them agree on the layout ---
// Only a named function owns an inline record array. The module's top-level
// statements and closure bodies hold plain arrays (static.js carrierFrame), and
// a function called from where no walk reaches (the host for an export; a
// callback, closure or table for an address-taken function) keeps a plain
// boundary. Each shape below once read inline cells as plain elements or the
// reverse: twice the length, fields of garbage.
const MK = `const init = (n) => { const ps = []; for (let i = 0; i < n; i++) ps.push({ x: i + 1, y: i + 2 }); return ps }\n`
const SUM = `const sum = (ps) => { let s = 0; for (let i = 0; i < ps.length; i++) s += ps[i].x * 10 + ps[i].y; return s }\n`
// A function-local carrier of the same schema, so the layout is in play.
const KEEP = `const keep = () => { const b = []; b.push({ x: 5, y: 6 }); b.push({ x: 7, y: 8 }); let s = 0; for (let i = 0; i < b.length; i++) s += b[i].x; return s }\n`
const agreesAll = (label, src, calls = [['main', []]]) => {
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const wasm = run(src, { optimize })
    for (const [name, args] of calls)
      is(JSON.stringify(wasm[name](...args)), JSON.stringify(js[name](...args)), `${label}: ${name} (optimize:${optimize})`)
  }
}

test('struct-inline ownership: a top-level binding of a returned carrier reads as JS', () => {
  // The 1.0.0 report: 8 items of garbage for 4 pushes.
  agreesAll('map in an export', MK + `const ps = init(4); export let dump = () => ps.map(p => p.x + ',' + p.y).join(' ')`, [['dump', []]])
  agreesAll('index loop in an export', MK + `const ps = init(4); export let main = () => { let s = 0; for (let i = 0; i < ps.length; i++) s += ps[i].x * 10 + ps[i].y; return s }`)
  agreesAll('length at top level', MK + `const n = init(4).length; export let main = () => n`)
  agreesAll('through a wrapper', MK + `const wrap = () => init(3); const ps = wrap(); export let main = () => ps.length`)
  agreesAll('in a container', MK + `const o = { ps: init(3) }; export let main = () => o.ps.map(p => p.x).join()`)
  agreesAll('spread', MK + `const all = [...init(3)]; export let main = () => all.map(p => p.x).join()`)
  agreesAll('ternary', MK + `const ps = 1 ? init(3) : []; export let main = () => ps.map(p => p.x).join()`)
  agreesAll('IIFE', `const ps = (() => { const a = []; a.push({ x: 1, y: 2 }); a.push({ x: 3, y: 4 }); return a })(); export let main = () => ps.map(p => p.x).join()`)
  agreesAll('block binding', MK + `let out = 0; { const a = init(3); for (let i = 0; i < a.length; i++) out += a[i].x } export let main = () => out`)
  agreesAll('module loop capture', KEEP + `const fs = []; for (let k = 0; k < 2; k++) { const a = []; a.push({ x: k, y: 1 }); a.push({ x: k + 1, y: 1 }); fs.push(() => a.length * 10 + a[1].x) } export let main = () => fs[0]() * 1000 + fs[1]() * 100 + keep()`)
  // A plain array at top level into a parameter that also takes the carrier.
  agreesAll('plain argument at top level', MK + SUM + `const r = sum(JSON.parse('[{"x":5,"y":6}]')); export let main = () => r * 1000 + sum(init(3))`)
  agreesAll('plain global into a carried parameter', MK + SUM + KEEP + `let out = 0; { const a = []; a.push({ x: 1, y: 2 }); out = sum(a) } export let main = () => out * 100 + keep() + sum(init(2))`)
})

test('struct-inline ownership: the host and callbacks receive plain arrays', () => {
  const rows = '[{"x":1,"y":2},{"x":2,"y":3},{"x":3,"y":4}]'
  for (const src of [
    MK + `export let main = () => init(3)`,
    MK + `export let main = () => { const a = init(3); return a }`,
    MK + `export { init }; export let main = () => init(3).length`,
    `export let init = (n) => { const ps = []; for (let i = 0; i < n; i++) ps.push({ x: i + 1, y: i + 2 }); return ps }; export let main = () => { const a = init(3); let s = 0; for (let i = 0; i < a.length; i++) s += a[i].x; return s }`,
  ]) {
    const name = /export \{ init \}|export let init/.test(src) ? 'init' : 'main'
    agreesAll('result to the host', src, [[name, [3]]])
    is(JSON.stringify(run(src)[name](3)), rows, 'three whole records')
  }
  agreesAll('address-taken producer', MK + `export let main = () => [3].map(init)[0].map(p => p.x).join()`)
})

test('struct-inline ownership: closure frames and parameter defaults', () => {
  agreesAll('callback-local array', KEEP + `export let main = () => { let t = ''; [1, 2].forEach(k => { const a = []; a.push({ x: k, y: 1 }); a.push({ x: k + 1, y: 2 }); t += a.map(p => p.x).join() + a.length }); return t + keep() }`)
  agreesAll('closure-local array', KEEP + `export let main = () => { const f = () => { const a = []; a.push({ x: 1, y: 2 }); a.push({ x: 3, y: 4 }); return a.map(p => p.x).join() }; return f() + keep() }`)
  agreesAll('literal default for a carried parameter', MK + `const f = (ps = [{ x: 7, y: 8 }]) => { let s = 0; for (let i = 0; i < ps.length; i++) s += ps[i].x; return s }; export let main = () => f(init(3)) * 100 + f()`)
  agreesAll('parsed default for a carried parameter', MK + `const f = (ps = JSON.parse('[{"x":5,"y":1}]')) => { let s = 0; for (let i = 0; i < ps.length; i++) s += ps[i].x; return s }; export let main = () => f(init(3)) * 100 + f()`)
})

test('struct-inline ownership: agreeing flows keep the carrier', () => {
  // The walks verify the module and closures as consumers; they do not
  // blanket-poison. A carrier read where its producer's facts agree stays.
  const carried = (src) => { compileInProcess(src, { optimize: 'speed' }); return [...ctx.schema.inlineArray].map(sid => ctx.schema.list[sid].join()) }
  for (const src of [
    MK + SUM + `const r = sum(init(4)); export let main = () => r`,
    MK + SUM + `export let main = () => { const f = () => sum(init(3)); return f() + [1].push({ x: 1, y: 2 }) }`,
    MK + SUM + `export let main = () => sum(init(3))`,
  ]) {
    is(carried(src).join(';'), 'x,y', 'Array<{x, y}> stays inline')
    agreesAll('agreeing flow', src)
  }
  is(carried(MK + `const ps = init(4); export let main = () => ps.length`).join(';'), '', 'a top-level binding poisons')
  is(carried(MK + `export let main = () => init(3)`).join(';'), '', 'an exported result poisons')
})

// The union carrier shares the contract: a union-returning call outside an
// agreeing binding, return or parameter once read packed cells as elements.
const ROWS = `const initRows = () => { const rows = []; let s = 0x1234abcd | 0; for (let i = 0; i < 16; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const k = s & 1; const a = (s >>> 3) & 255, b = (s >>> 13) & 255; if (k === 0) rows.push({ k: k, x: a, y: b }); else rows.push({ k: k, r: a }) } return rows }
const total = (rows) => { let h = 0; for (let i = 0; i < rows.length; i++) { const o = rows[i]; const k = o.k; if (k === 0) h = (h + o.x + o.y) | 0; else h = (h + o.r) | 0 } return h }
`
const BUILD = `const rows = []; let s = 0x1234abcd | 0; for (let i = 0; i < 16; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const k = s & 1; const a = (s >>> 3) & 255, b = (s >>> 13) & 255; if (k === 0) rows.push({ k: k, x: a, y: b }); else rows.push({ k: k, r: a }) }`

test('union inline ownership: every consumer of a returned union reads as JS', () => {
  agreesAll('length of a call', ROWS + `export let main = () => initRows().length * 10000 + total(initRows())`)
  agreesAll('map of a call', ROWS + `export let main = () => initRows().map(o => o.k).join('')`)
  agreesAll('through a wrapper', ROWS + `const w = () => initRows(); export let main = () => w().length`)
  agreesAll('in a container', ROWS + `export let main = () => { const o = { r: initRows() }; return o.r.length }`)
  agreesAll('spread', ROWS + `export let main = () => [...initRows()].length`)
  agreesAll('ternary', ROWS + `export let main = () => (1 ? initRows() : []).length`)
  agreesAll('top-level binding', ROWS + `const rows = initRows(); export let main = () => rows.length * 10000 + total(rows)`)
  agreesAll('top-level length', ROWS + `const n = initRows().length; export let main = () => n`)
  agreesAll('module loop capture', ROWS + `const fs = []; for (let q = 0; q < 1; q++) { ${BUILD} fs.push(() => rows.length) } export let main = () => fs[0]() * 10000 + total(initRows())`)
  agreesAll('closure-local rows', ROWS + `export let main = () => { const f = () => { ${BUILD} return rows.map(o => o.k).join('') }; return f() + total(initRows()) }`)
  agreesAll('closure returns rows', ROWS + `export let main = () => { const f = () => { ${BUILD} return rows }; return f().length * 10000 + total(initRows()) }`)
  agreesAll('result to the host', ROWS + `export let main = () => initRows()`)
  const carried = (src) => { compileInProcess(src, { optimize: 'speed' }); return [...(ctx.schema.inlineUnion?.keys() || [])].length }
  is(carried(ROWS + `export let main = () => total(initRows())`), 1, 'an agreeing argument keeps the union carrier')
})
