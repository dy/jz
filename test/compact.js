// Compaction of what the module keeps (module/core/compact.js): as the
// outermost call returns, once the kept memory holds twice what the last
// compaction walked and a page besides, the host asks the module to keep only
// what its roots reach. State replaced call after call stays bounded, every
// kind of value survives the move with its identity (Map keys, closures'
// cells, slices, views), the host's own storage never moves, and
// `memory.reset()` still returns the module to its start.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels, onWasi, belowOpt } from './_matrix.js'
import { oracle } from './util.js'

// Calls `step(i)` on both the module and the oracle, comparing each result;
// counts the compactions (the kept memory shrinking between calls) and the peak.
const drive = (src, n, opts, label = '') => {
  const want = oracle(src), { exports, memory } = jz(src, opts)
  let last = 0, compactions = 0, peak = 0
  for (let i = 0; i < n; i++) {
    const got = exports.step(i), expect = want.step(i)
    is(got, expect, `${label} step(${i})`)
    const used = memory.used
    if (used < last) compactions++
    last = used
    if (used > peak) peak = used
  }
  return { exports, memory, want, compactions, peak }
}

const STATE = {
  object: `let st = { x: 0, y: 'a' }; export const step = (i) => { st = { x: st.x + i, y: st.y + (i % 7) }; if (st.y.length > 200) st = { x: st.x, y: 'a' }; return st.x + st.y.length }`,
  spread: `let st = { a: 1, b: 2, c: [1] }; export const step = (i) => { st = { ...st, a: i, c: [...st.c, i].slice(-5) }; return st.a + st.b + st.c.length + st.c[0] }`,
  particles: `let ps = [{x:0,vx:1},{x:1,vx:2},{x:2,vx:3}]; export const step = (i) => { ps = ps.map(p => ({ x: p.x + p.vx, vx: p.vx })); return ps[0].x + ps[2].x }`,
  buffer: `let a = new Float64Array(64); export const step = (i) => { const b = new Float64Array(64); for (let k = 0; k < 64; k++) b[k] = a[k] + k; a = b; return a[3] + a[63] }`,
  log: `let log = ''; export const step = (i) => { log = log + String.fromCharCode(97 + i % 26); if (log.length > 300) log = log.slice(100); return log.length + log.charCodeAt(0) }`,
  map: `const m = new Map(); export const step = (i) => { m.set('k' + (i % 97), { n: i }); let s = 0; for (const [k, v] of m) s += v.n + k.length; return s }`,
  history: `const hist = []; export const step = (i) => { hist.push({ t: i, v: i * 2 }); if (hist.length > 100) hist.shift(); let s = 0; for (let k = 0; k < hist.length; k += 10) s += hist[k].v; return s }`,
}

// The O0 leg compiles without the rewind, and without it nothing compacts:
// the programs still agree with the host there, the counts are not asserted.
const counted = () => !belowOpt(1)

test('compact: state replaced call after call stays bounded', () => {
  if (onWasi()) return
  for (const [name, src] of Object.entries(STATE)) {
    const { memory, compactions, peak } = drive(src, 4000, undefined, name)
    if (!counted()) continue
    ok(compactions >= 1, `${name}: compacted (${compactions})`)
    ok(peak < 300 * 1024, `${name}: peak ${peak} bytes stays under 300 KB`)
    ok(memory.used < 120 * 1024, `${name}: ${memory.used} bytes kept after 4000 calls`)
  }
})

test('compact: off, the replaced state accumulates', () => {
  if (onWasi()) return
  const { memory, compactions } = drive(STATE.particles, 2000, { optimize: { compact: false } }, 'particles off')
  is(compactions, 0, 'no compaction')
  ok(memory.used > 200 * 1024, `grows without compaction (${memory.used})`)
})

const KINDS = {
  slices: `let parts = []; const base = 'the quick brown fox jumps over the lazy dog'; export const step = (i) => { parts.push(base.slice(i % 20, i % 20 + 9)); if (parts.length > 40) parts = parts.slice(20); return parts.join('|').length + parts[0].charCodeAt(2) }`,
  template: `let s = 'x'; export const step = (i) => { s = \`\${i}-\${s.slice(0, 20)}-\${i * 2}\`; return s.length + s.charCodeAt(1) }`,
  shifted: `let a = []; export const step = (i) => { a.push({ i }, { i: i + 1 }); if (a.length > 30) a.splice(0, 7); if (i % 5 == 0) a.shift(); if (i % 13 == 0) a = a.slice().sort((p, q) => q.i - p.i); return a.length + a[0].i + a[a.length - 1].i }`,
  mapObjKeys: `const m = new Map(); let keys = []; export const step = (i) => { const k = { id: i }; keys.push(k); m.set(k, i * 3); if (keys.length > 50) { m.delete(keys.shift()) } let s = 0; for (const k of keys) s += m.get(k); return s + m.size }`,
  setObjKeys: `const s = new Set(); let held = []; export const step = (i) => { const o = [i]; held.push(o); s.add(o); if (held.length > 20) s.delete(held.shift()); let c = 0; for (const o of held) if (s.has(o)) c++; return c + s.size }`,
  closures: `let counters = []; const mk = (start) => { let n = start; return () => ++n }; export const step = (i) => { counters.push(mk(i)); if (counters.length > 30) counters = counters.slice(10); let s = 0; for (const c of counters) s += c(); return s }`,
  closureCells: `let fs = []; export const step = (i) => { const o = { v: i, arr: [i] }; let m = i; fs.push(() => { m += o.v; o.arr.push(m); return o.arr.length + m }); if (fs.length > 15) fs = fs.slice(5); let s = 0; for (const f of fs) s += f(); return s }`,
  tree: `let tree = { l: null, r: null, v: 0 }; const ins = (t, v) => t == null ? { l: null, r: null, v } : v < t.v ? { l: ins(t.l, v), r: t.r, v: t.v } : { l: t.l, r: ins(t.r, v), v: t.v }; const sum = (t) => t == null ? 0 : t.v + sum(t.l) + sum(t.r); export const step = (i) => { tree = ins(tree, (i * 7919) % 1000); if (i % 50 == 49) tree = { l: null, r: null, v: i }; return sum(tree) }`,
  numberSlots: `let st = { a: 0.5, b: 1e300, c: -0 }; export const step = (i) => { st = { a: st.a * 1.0001 + i, b: st.b / 2 || i, c: st.c - i }; return st.a + st.b + st.c }`,
  nanPayload: `let st = { v: NaN, w: 0 }; const dv = new DataView(new ArrayBuffer(8)); export const step = (i) => { dv.setBigUint64(0, 0x7FF8800000001000n + BigInt(i), true); st = { v: dv.getFloat64(0, true), w: st.w + i }; return (st.v !== st.v ? 1 : 0) + st.w }`,
  views: `let views = []; export const step = (i) => { const buf = new Float32Array(16); for (let k = 0; k < 16; k++) buf[k] = i + k; views.push(buf.subarray(4, 12)); if (views.length > 10) views = views.slice(5); let s = 0; for (const v of views) s += v[0] + v.length; return s }`,
  dataViews: `let dvs = []; export const step = (i) => { const b = new ArrayBuffer(16); const dv = new DataView(b); dv.setInt32(4, i, true); dvs.push(dv); if (dvs.length > 8) dvs = dvs.slice(4); let s = 0; for (const d of dvs) s += d.getInt32(4, true); return s }`,
  bigints: `let acc = 1n; let list = []; export const step = (i) => { acc = acc * 3n % 1000000007n; list.push(acc + BigInt(i)); if (list.length > 20) list = list.slice(10); let s = 0n; for (const b of list) s += b; return Number(s % 1000n) }`,
  json: `let st = { a: 1, b: [1, 2], c: 'x' }; export const step = (i) => { st = JSON.parse(JSON.stringify({ a: st.a + i, b: st.b.concat([i]).slice(-4), c: st.c + (i % 3) })); if (st.c.length > 10) st.c = 'x'; return st.a + st.b.length + st.c.length }`,
  classes: `class V { constructor(x, y) { this.x = x; this.y = y } add(o) { return new V(this.x + o.x, this.y + o.y) } get len() { return this.x + this.y } } let v = new V(0, 0); export const step = (i) => { v = v.add(new V(i, 1)); return v.len }`,
  dynProps: `const cfg = { a: 1 }; export const step = (i) => { cfg['p' + (i % 5)] = [i]; let s = 0; for (const k in cfg) s += cfg[k].length ?? cfg[k]; return s }`,
  forIn: `let o = {}; export const step = (i) => { o['k' + (i % 31)] = { v: i }; if (i % 200 == 199) o = {}; let s = 0; for (const k in o) s += o[k].v; return s }`,
  errors: `let last = null; export const step = (i) => { try { if (i % 3 == 0) throw new Error('e' + i); last = { ok: i } } catch (e) { last = { msg: e.message } } return last.ok ?? last.msg.length }`,
  regex: `let last = /a(b+)c/; let found = []; export const step = (i) => { const m = last.exec('xxab' + 'b'.repeat(i % 4) + 'cyy'); found.push(m ? m[1] : '-'); if (found.length > 10) found = found.slice(5); return found.join('').length }`,
  holes: `let a = []; export const step = (i) => { a[i % 40] = i; if (i % 7 == 0) delete a[(i + 3) % 40]; let s = 0, c = 0; for (let k = 0; k < a.length; k++) if (k in a) { s += a[k]; c++ } return s + c }`,
}

// A numeric array written in place leaves nothing to compact.
const IN_PLACE = new Set(['holes'])

test('compact: every kind of value survives the move', () => {
  if (onWasi()) return
  for (const [name, src] of Object.entries(KINDS)) {
    const { compactions } = drive(src, 3000, undefined, name)
    if (!IN_PLACE.has(name) && counted()) ok(compactions >= 1, `${name}: compacted (${compactions})`)
  }
})

test('compact: the same programs at every level', () => {
  if (onWasi()) return
  for (const level of levels(0, 1, 3, 'size'))
    for (const name of ['spread', 'log', 'history']) drive(STATE[name], 1200, { optimize: { level } }, `${name} O${level}`)
})

test('compact: what the host holds does not move', () => {
  if (onWasi()) return
  const src = `let st = { items: [] }
    export const churn = (i) => { st = { items: [...st.items, { i }].slice(-20) }; return st.items.length }
    export const sum = (buf) => { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i]; return s }
    export const view = () => { const t = new Float64Array(8); for (let i = 0; i < 8; i++) t[i] = i * 3; return t }`
  const { exports, memory } = jz(src)
  // storage the host made before the state churns is below the floor
  const data = new Float64Array(64).map((_, i) => i + 0.5)
  const buf = memory.Float64Array(data)
  let last = 0, compactions = 0
  for (let i = 0; i < 3000; i++) { exports.churn(i); if (memory.used < last) compactions++; last = memory.used }
  if (counted()) ok(compactions >= 1, `compacted (${compactions})`)
  is(exports.sum(buf), data.reduce((a, b) => a + b, 0), 'the host\'s buffer reads as made')
  // a view the host received pins the heap below it (without compaction the
  // heap grows past the buffer and the view detaches, as documented)
  if (!counted()) return
  const v = exports.view()
  const before = Array.from(v)
  for (let i = 0; i < 3000; i++) exports.churn(i)
  is(Array.from(v), before, 'the returned view still reads its values')
  is(exports.sum(buf), data.reduce((a, b) => a + b, 0), 'and the buffer too')
})

// Within one call, a loop whose iteration allocates and keeps some of it
// compacts what it keeps in place (optimize/loop-compact.js): the carried
// string, array or object stays, and every one it replaced goes.
const LOOPS = {
  prefix: `export const f = n => { let s = ''; for (let i = 0; i < n; i++) s = (i % 10) + s; return s.length * 7 + s.charCodeAt(0) + s.charCodeAt(s.length - 1) }`,
  concat: `export const f = n => { let a = []; for (let i = 0; i < n; i++) { a = a.concat([i]); if (a.length > 50) a = a.slice(25) } return a.length + a[0] + a[a.length - 1] }`,
  object: `export const f = n => { let cur = { x: 0, tag: 'a', list: [1] }; for (let i = 0; i < n; i++) { cur = { x: cur.x + i, tag: cur.tag + (i % 3), list: [...cur.list, i].slice(-4) }; if (cur.tag.length > 20) cur = { ...cur, tag: 'z' } } return cur.x + cur.tag.length + cur.list[0] + cur.list.length }`,
  map: `export const f = n => { let a = [1, 2, 3, 4]; for (let i = 0; i < n; i++) a = a.map(x => x + i); return a[0] + a[3] }`,
  shifted: `export const f = n => { let a = []; for (let i = 0; i < 40; i++) a.push({ i: -i }); for (let i = 0; i < n; i++) { a.push({ i }); a.shift() } let s = 0; for (const o of a) s += o.i; return s + a.length }`,
  mapKeys: `export const f = n => { const m = new Map(); let keys = []; for (let i = 0; i < n; i++) { const k = { id: i }; keys.push(k); m.set(k, i * 3); if (keys.length > 50) m.delete(keys.shift()) } let s = 0; for (const k of keys) s += m.get(k); return s + m.size }`,
  closures: `export const f = n => { let fs = []; for (let i = 0; i < n; i++) { let c = i; fs.push(() => ++c); if (fs.length > 30) fs = fs.slice(10) } let s = 0; for (const g of fs) s += g() + g(); return s }`,
  views: `export const f = n => { let views = []; for (let i = 0; i < n; i++) { const buf = new Float32Array(16); for (let k = 0; k < 16; k++) buf[k] = i + k; views.push(buf.subarray(4, 12)); if (views.length > 10) views = views.slice(5) } let s = 0; for (const v of views) s += v[0] + v.length; return s }`,
  typed: `export const f = n => { let a = new Float64Array(32); for (let i = 0; i < n; i++) { const b = new Float64Array(32); for (let k = 0; k < 32; k++) b[k] = a[k] + k; a = b } return a[3] + a[31] }`,
  json: `export const f = n => { let st = { a: 1, b: [1, 2], c: 'x' }; for (let i = 0; i < n; i++) { st = JSON.parse(JSON.stringify({ a: st.a + i, b: st.b.concat([i]).slice(-4), c: st.c + (i % 3) })); if (st.c.length > 10) st.c = 'x' } return st.a + st.b.length + st.c.length }`,
  tokens: `export const f = n => { let out = []; const src = 'let x = 10 + y * (3 - z);'; for (let r = 0; r < n; r++) { const toks = []; let i = 0; while (i < src.length) { const ch = src[i]; if (ch == ' ') { i++; continue } let j = i; while (j < src.length && src[j] != ' ') j++; toks.push(src.slice(i, j)); i = j } out.push(toks.join('|')); if (out.length > 10) out = out.slice(5) } return out.join('').length }`,
  param: `const fill = (bag, i) => { bag.items.push({ i }); if (bag.items.length > 40) bag.items = bag.items.slice(20) }; export const f = n => { const bag = { items: [] }; for (let i = 0; i < n; i++) fill(bag, i); let s = 0; for (const it of bag.items) s += it.i; return s }`,
  numbers: `export const f = n => { let st = { a: 0.5, b: 1e300, c: -0 }; for (let i = 0; i < n; i++) st = { a: st.a * 1.0001 + i, b: st.b / 2 || i, c: st.c - i }; return st.a + st.b + st.c }`,
  forIn: `export const f = n => { let o = {}; for (let i = 0; i < n; i++) { o['k' + (i % 31)] = { v: i }; if (i % 200 == 199) o = {} } let s = 0; for (const k in o) s += o[k].v; return s }`,
}

test('compact: a loop keeps what it carries and no more', () => {
  if (onWasi()) return
  for (const [name, src] of Object.entries(LOOPS)) {
    const want = oracle(src), { exports, memory } = jz(src)
    for (const n of [7, 250, 4000]) is(exports.f(n), want.f(n), `${name} f(${n})`)
    if ((name === 'prefix' || name === 'concat') && counted()) {
      // unbounded, the prefix string alone would reach 3.6 GB; a loop compacts
      // past 16 MB of slack, and wasm memory grows by doubling
      exports.f(60000)
      ok(memory.buffer.byteLength <= 64 * 1024 * 1024, `${name}: 60000 iterations stay within 64 MB (${memory.buffer.byteLength >> 10} KB)`)
    }
  }
})

test('compact: loops at every level', () => {
  if (onWasi()) return
  for (const level of levels(0, 1, 3, 'size'))
    for (const name of ['prefix', 'shifted', 'closures', 'json']) {
      const src = LOOPS[name], want = oracle(src), { exports } = jz(src, { optimize: { level } })
      for (const n of [7, 3000]) is(exports.f(n), want.f(n), `${name} O${level} f(${n})`)
    }
})

test('compact: a site roots the locals live at the loop, not every pointer the function holds', () => {
  if (onWasi() || !counted()) return
  // a, b, c are read before the loop only: dead at its top, not roots; the
  // carried s is one, with n as the parameter the loop reads. The function
  // holds a dozen pointer-capable locals; a site marks the few live ones.
  const src = `export const f = n => { const a = [n], b = 'x' + n, c = { v: n }; let t = a.length + b.length + c.v; let s = ''; for (let i = 0; i < n; i++) s = (i % 10) + s; return s.length + t }`
  const want = oracle(src), { exports } = jz(src)
  for (const n of [5, 3000]) is(exports.f(n), want.f(n), `f(${n})`)
  const wat = jz.compile(src, { wat: true })
  const sites = wat.split('call $__gc_begin').slice(1).map(site => (site.slice(0, site.indexOf('call $__gc_walk')).match(/call \$__gc_mark/g) ?? []).length)
  ok(sites.length > 0, 'the loop has a compaction site')
  ok(/\(global\.get \$__g_cost\)/.test(wat), 'a site takes what the compaction walked as the next trigger')
  for (const marks of sites) ok(marks >= 1 && marks <= 6, `a site marks its live roots only (${sites.join(' ')})`)
})

// A pointer a loop's top still leads to is a root wherever its reads are:
// past the loop, past a break, in a handler, in an enclosing loop's next
// round, or written in the loop and read after it. Each runs the loop long
// enough to compact several times; a missed root would read moved memory.
const LIVE = {
  after: `export const f = n => { const a = [n, n + 1]; let s = ''; for (let i = 0; i < n; i++) s = (i % 10) + s; return s.length + a[1] }`,
  broken: `export const f = n => { const a = { v: n }; let s = ''; for (let i = 0; ; i++) { s = (i % 10) + s; if (i == n - 1) break } return s.length + a.v }`,
  // a labeled break out of a compacting inner loop, a continue of its outer, and work after the inner loop in the outer's body
  labeled: `export const f = n => { const a = [n]; let s = '', t = 0; outer: for (let r = 0; r < 4; r++) { for (let i = 0; ; i++) { s = (i % 10) + s; if (i == n - 1) break outer; if (i % 1000 == 999) continue outer } t += 1 } for (let r = 0; r < 3; r++) { let k = 0; for (let i = 0; i < n; i++) { s = (i % 10) + s; if (i == n - 1) break; k++ } t += k; s = s.slice(0, 10) } return s.length + a[0] + t }`,
  written: `export const f = n => { let last = [0]; let s = ''; for (let i = 0; i < n; i++) { s = (i % 10) + s; if (i % 1000 == 0) last = [i] } return s.length + last[0] }`,
  caught: `export const f = n => { const a = [n]; let s = '', c = 0; for (let i = 0; i < n; i++) { try { s = (i % 10) + s; if (i % 5000 == 4999) throw new Error('x') } catch (e) { c += a[0] } } return s.length + c }`,
  outer: `export const f = n => { let s = '', t = 0; for (let r = 0; r < 3; r++) { const b = [r + 1]; for (let i = 0; i < n; i++) s = (i % 10) + s; t += b[0]; s = s.slice(0, 100) } return s.length + t }`,
  // the caller's binding of an array the inlined callee grows: live across
  // the inlined loop, it names the array's old block, a stub once it grew
  inlined: `const g = (log, n) => { let s = ''; for (let i = 0; i < n; i++) { s = (i % 10) + s; if (i % 500 == 0) log.push({ i, s: s.length }) } return s.length }; export const f = n => { const log = []; const r = g(log, n); let t = 0; for (const e of log) t += e.i + e.s; return r + t }`,
  // the caller's binding of a container the callee's loop grows: a Map, and
  // an array reached through an object's field the callee read once
  mapAlias: `const g = (m, n) => { let s = ''; for (let i = 0; i < n; i++) { s = (i % 10) + s; if (i % 100 == 0) m.set('k' + i, { i }) } return s.length }; export const f = n => { const m = new Map(); const r = g(m, n); let t = 0; for (const [k, v] of m) t += v.i + k.length; return r + t + m.size }`,
  fieldAlias: `const g = (o, n) => { const l = o.list; let s = ''; for (let i = 0; i < n; i++) { s = (i % 10) + s; if (i % 500 == 0) l.push({ i }) } return s.length }; export const f = n => { const o = { list: [] }; const r = g(o, n); let t = 0; for (const e of o.list) t += e.i; return r + t + o.list.length }`,
  // a container a closure captures and grows in its loop, reached through
  // the environment address the closure took at its entry
  captured: `export const f = n => { const log = []; const g = () => { let s = ''; for (let i = 0; i < n; i++) { s = (i % 10) + s; if (i % 500 == 0) log.push({ i, s: s.length }) } return s.length }; const r = g(); let t = 0; for (const e of log) t += e.i + e.s; return r + t }`,
}

test('compact: every pointer a loop still leads to survives its compactions', () => {
  if (onWasi() || !counted()) return
  for (const [name, src] of Object.entries(LIVE)) {
    const want = oracle(src), { exports } = jz(src)
    for (const n of [7, 60000]) is(exports.f(n), want.f(n), `${name} f(${n})`)
  }
})

test('compact: compactions amortize what they walk, not only what they keep above the floor', () => {
  if (onWasi() || !counted()) return
  // a module holding a large structure below the floor: every compaction
  // walks it (an old container may name a new value), so a compaction
  // comes once per twice its size of churn, not once per page
  const src = `let keep = []; for (let i = 0; i < 20000; i++) keep.push({ v: i, w: [i] })
    let st = { n: 0, tags: ['a'] }
    export const step = (i) => { st = { n: st.n + i, tags: [...st.tags, 't' + i].slice(-6) }; return st.n + st.tags.length + keep.length }`
  const want = oracle(src), { exports, memory } = jz(src)
  let last = 0, compactions = 0
  for (let i = 0; i < 4000; i++) { is(exports.step(i), want.step(i), `step(${i})`); if (memory.used < last) compactions++; last = memory.used }
  ok(compactions >= 1 && compactions <= 3, `4000 small steps beside 20000 kept objects compact a few times, not every page (${compactions})`)
})

test('compact: dynamic properties on a static literal, replaced call after call, at every level', () => {
  if (onWasi()) return
  const src = `const cfg = { a: 1 }; export const step = (i) => { cfg['p' + (i % 5)] = [i]; let s = 0; for (const k in cfg) s += cfg[k].length ?? cfg[k]; return s }`
  for (const level of levels(0, 1, 2, 3)) {
    const want = oracle(src), { exports } = jz(src, { optimize: { level } })
    for (let i = 0; i < 3000; i++) { const got = exports.step(i), ref = want.step(i); if (got !== ref) { is(got, ref, `O${level} step(${i})`); break } }
    ok(true, `O${level}: 3000 steps agree`)
  }
})

// A closure's loops compact as a function's do: a pipeline runs its phases
// and passes in callbacks, and their loops are where a compile's memory goes.
const CLOSURE_LOOPS = {
  thunk: `const t = (name, fn) => fn(); export const f = n => { let out = 0; t('a', () => { let s = ''; for (let i = 0; i < n; i++) s = (i % 10) + s; out += s.length }); return out }`,
  module: `let out = 0; const t = (name, fn) => fn(); const run = (n) => t('a', () => { const arr = []; for (let i = 0; i < n; i++) { arr.push([i]); out += arr.length } }); export const f = n => { run(n); return out }`,
  direct: `export const f = n => { let out = 0; const g = k => { let s = ''; for (let i = 0; i < n; i++) s = (i % 10) + s; out += s.length * k }; g(1); g(2); return out }`,
}

test('compact: a loop in a closure compacts what it keeps', () => {
  if (onWasi() || !counted()) return
  for (const [name, src] of Object.entries(CLOSURE_LOOPS)) {
    ok((jz.compile(src, { wat: true }).match(/call \$__gc_begin/g) ?? []).length > 0, `${name}: the closure's loop has a site`)
    const want = oracle(src), { exports, memory } = jz(src)
    for (const n of [7, 60000]) is(exports.f(n), want.f(n), `${name} f(${n})`)
    ok(memory.buffer.byteLength <= 64 * 1024 * 1024, `${name}: 60000 iterations stay within 64 MB (${memory.buffer.byteLength >> 10} KB)`)
  }
})

test('compact: a stub log too small for the call declines compaction, never corrupts', () => {
  if (onWasi() || !counted()) return
  // two containers older than the loop grow past a one-entry log: the loop
  // stops compacting for the call and the caller's aliases stay right
  const src = `const g = (log, m, n) => { let s = ''; for (let i = 0; i < n; i++) { s = (i % 10) + s; if (i % 500 == 0) { log.push({ i }); m.set('k' + i, i) } } return s.length }
    export const f = n => { const log = [], m = new Map(); const r = g(log, m, n); let t = 0; for (const e of log) t += e.i; for (const [k, v] of m) t += v + k.length; return r + t + log.length + m.size }`
  const want = oracle(src)
  const small = jz(src, { optimize: { compactStubs: 1 } }), wide = jz(src, { optimize: { compactStubs: 1024 } })
  for (const n of [7, 20000]) { is(small.exports.f(n), want.f(n), `compactStubs 1: f(${n})`); is(wide.exports.f(n), want.f(n), `default log: f(${n})`) }
  ok(small.memory.buffer.byteLength >= wide.memory.buffer.byteLength, `the declined loop kept more (${small.memory.buffer.byteLength >> 20} vs ${wide.memory.buffer.byteLength >> 20} MB)`)
})

test('compact: a loop compacts before the memory\'s cap, not only at its amortized trigger', () => {
  if (onWasi() || !counted()) return
  // 20 MB kept beside the loop: the amortizing trigger (twice the walk plus
  // 16 MB above the mark) would land past a 64 MB cap; under pressure the
  // loop compacts once an eighth of the walk and the slack have gone by
  const src = `export const f = n => { const keep = []; for (let i = 0; i < 500000; i++) keep.push([i]); let s = ''; for (let i = 0; i < n; i++) s = (i % 10) + s; return s.length + keep.length }`
  const want = oracle(src), { exports, memory } = jz(src, { memory: { initial: 2, maximum: 1024 } })
  is(exports.f(40000), want.f(40000), 'f(40000) under a 64 MB cap')
  ok(memory.buffer.byteLength <= 64 * 1024 * 1024, `the memory stayed within its cap (${memory.buffer.byteLength >> 20} MB)`)
})

test('compact: durable arrays below and above the stub log\'s table heal at a reset', () => {
  if (onWasi() || !counted()) return
  // the stub log's table is the first thing the start makes: a static
  // literal lies below it, an array the start builds above; the durable
  // bitmaps skip the table's addresses, so both log their first write of a
  // round and reset to what they held
  const src = `const lit = [3, 5]; const built = []; for (let i = 0; i < 4; i++) built.push(i * 10)
    export const write = (i) => { lit[0] = i; built[1] = i; let s = ''; for (let k = 0; k < 2000; k++) s = (k % 10) + s; return lit[0] + built[1] + s.length }
    export const read = () => lit[0] + lit[1] + built[0] + built[1] + built.length`
  const want = oracle(src), { exports, memory } = jz(src)
  is(exports.read(), want.read(), 'as started')
  for (const i of [7, 9]) is(exports.write(i), want.write(i), `write(${i})`)
  is(exports.read(), 9 + 5 + 0 + 9 + 4, 'after the writes')
  memory.reset()
  is(exports.read(), 3 + 5 + 0 + 10 + 4, 'a reset heals both durable arrays')
})

test('compact: a reset after compactions returns the module to its start', () => {
  if (onWasi()) return
  const src = `let st = { n: 0, tags: ['a'] }; const start = { n: 0 }
    export const step = (i) => { st = { n: st.n + i, tags: [...st.tags, 't' + i].slice(-6) }; return st.n + st.tags.length + start.n }`
  const want = oracle(src), { exports, memory } = jz(src)
  let last = 0, compactions = 0
  for (let i = 0; i < 2500; i++) { is(exports.step(i), want.step(i), `step(${i})`); if (memory.used < last) compactions++; last = memory.used }
  if (counted()) ok(compactions >= 1, `compacted (${compactions})`)
  memory.reset()
  is(memory.used, 0, 'nothing kept after a reset')
  const fresh = oracle(src)
  for (let i = 0; i < 2500; i++) is(exports.step(i), fresh.step(i), `after reset step(${i})`)
})
