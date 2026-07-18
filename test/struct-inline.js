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
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { ctx } from '../src/ctx.js'
import { run } from './util.js'

const jsEval = (src) => {
  const exports = {}
  new Function('exports', src.replace(/export let (\w+) =/g, 'const $1 = exports.$1 ='))(exports)
  return exports
}

const both = (src, name = 'main') => {
  const truth = jsEval(src)[name]()
  for (const optimize of [false, true])
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
  const wat = jz.compile(src, { wat: true, optimize: true })
  const body = wat.split('(func ').find(c => /^\$step\b/.test(c)) || ''
  ok(body, 'step emitted')
  const loop = body.slice(body.indexOf('(loop'))
  ok(/i32\.store offset=12/.test(loop), 'packed 4×i32 element: last field at +12')
  ok(!/trunc_sat/.test(loop), 'no f64→i32 conversions in the kernel loop')
  ok(!/call \$__mkptr/.test(loop), 'no element re-boxing in the kernel loop')
  ok(!/call \$__alloc/.test(loop), 'no allocation in the kernel loop')
})

test('struct-inline: float fields stay on f64 cells, replace store still engages', () => {
  // non-int fields — inlineCellI32 must refuse; the store is still cell writes
  const src = KERNEL('x: nx + 0.5, y: ny, vx: wx, vy: wy', 'x: ((s >>> 2) & 255) + 0.5, y: (s >>> 5) & 255, vx: (1 + (s & 3)) | 0, vy: (1 + ((s >>> 9) & 3)) | 0')
  both(src)
  const wat = jz.compile(src, { wat: true, optimize: true })
  const body = wat.split('(func ').find(c => /^\$step\b/.test(c)) || ''
  const loop = body.slice(body.indexOf('(loop'))
  ok(/f64\.store offset=24/.test(loop), 'f64 cells: last field at +24')
  ok(!/call \$__alloc/.test(loop), 'no allocation in the kernel loop')
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

test('struct-inline: OOB replace store neither traps nor corrupts (drop contract)', () => {
  // i == length: JS extends; the packed arm drops the write (the checked
  // typed-store contract). Deviation pinned deliberately: length and the
  // neighbors must stay intact — never memory corruption. The cursor read at
  // the same OOB index is the carrier's existing unchecked-read deviation.
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
  const w = run(src, { optimize: true })
  const call = w.exports?.main ?? w.main
  is(call(2), 206, 'in-bounds replaces land (1+1, 3+1 → 206)')
  is(call(3), 206, 'i==len write is dropped: length stays 2, elements intact')
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
  const host = jsEval(SRC).main()
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
  const host = jsEval(SRC).main()
  for (const optimize of [false, 'speed']) is(run(SRC, { optimize }).main(), host, `JS-exact (optimize:${optimize})`)
  const wat = String(compile(SRC, { optimize: { level: 'speed', watr: false }, wat: true }))
  const m0 = wat.indexOf('(func $measure')
  const seg = wat.slice(m0, wat.indexOf('\n  (func ', m0 + 10))
  is((seg.match(/__dyn_get/g) || []).length, 0, 'zero dynamic reads in measure')
  is((seg.match(/f64\.(eq|convert|load)/g) || []).length, 0, 'all-i32 dispatch (no f64 ladder)')
  ok(seg.includes('(local $k i32)'), 'discriminant local typed i32')
  is((seg.match(/i64\.reinterpret_f64/g) || []).length, 1, 'single entry unbox of the cell address')
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
  const host = jsEval(SRC).main()
  for (const optimize of [false, 'speed']) is(run(SRC, { optimize }).main(), host, `JS-exact (optimize:${optimize})`)
})
