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

// A view the host holds detaches as the memory grows, so a compaction the host
// asks for never grows it to lay out its scratch: a render loop's pixel buffer,
// returned once and painted every frame, stays attached while the kept state
// above it (a density field, a point) is walked every sixteenth call.
test('compact: a returned view outlives the compactions of the calls after it', () => {
  if (onWasi()) return
  const src = `let px, dens, st
    export const resize = (w, h) => { px = new Uint32Array(w * h); dens = new Uint32Array(w * h); st = new Float64Array(2); return px }
    export const frame = (k) => { for (let i = 0; i < px.length; i++) { dens[i] = dens[i] + k; px[i] = dens[i] } st[0] = k }`
  for (const [w, h] of [[300, 200], [640, 400], [1000, 600]]) {
    const { exports } = jz(src)
    const px = exports.resize(w, h)
    for (let i = 0; i < 48; i++) exports.frame(1)
    is(px.length, w * h, `${w}×${h}: the view stays attached`)
    is(px[w * h - 1], 48, `${w}×${h}: and reads what the frames wrote`)
  }
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
    if ((name === 'prefix' || name === 'concat' || name === 'json') && counted()) {
      // unbounded, the prefix string alone would reach 3.6 GB; a loop compacts
      // past 2 MB of slack (34 MB of memory at the former 16), and wasm memory
      // grows by doubling
      exports.f(60000)
      ok(memory.buffer.byteLength <= 8 * 1024 * 1024, `${name}: 60000 iterations stay within 8 MB (${memory.buffer.byteLength >> 10} KB)`)
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
  // the slack above the mark) would land at a 64 MB cap; under pressure the
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

// A closure's named properties, and a shifted array's, live in one table keyed
// by the object's address (module/collection.js `__dyn_props`), which no walk
// reads as a pointer. Across the compactions between calls, and a reset between
// rounds, a closure that writes its captured binding, a shifted array and one
// shifted to no capacity (its words end where its data starts) keep their
// properties wherever the move lays them, and an object later made at an
// address a moved one left takes none of its properties.
test('compact: named properties kept by address follow their objects across the compactions between calls', () => {
  if (onWasi() || !counted()) return
  const src = `let kept = []
    export const step = (i) => {
      let hits = 0
      const f = () => { hits++; return i + hits - hits }
      f.tag = 'f' + i
      const l = [-1, i, i + 1]
      l.shift()
      l.label = 'l' + i
      // emptied to no capacity, garbage right after it
      const z = [i]
      z.shift()
      const junk = [i, i + 1]
      if (junk.length > 2) kept.push(junk)
      z.label = 'z' + i
      kept.push(f)
      kept.push(l)
      kept.push(z)
      kept.push(new Array(24).fill(i))
      if (kept.length > 160) kept = kept.slice(80)
      const g = () => i, m = [0, i]
      m.shift()
      let bad = (g.tag === undefined ? 0 : 1) + (m.label === undefined ? 0 : 1)
      for (let k = 0; k < kept.length; k += 4) {
        const j = kept[k + 3][0]
        if (kept[k].tag !== 'f' + j || kept[k]() !== j) bad++
        if (kept[k + 1].label !== 'l' + j || kept[k + 1][0] !== j) bad++
        if (kept[k + 2].label !== 'z' + j || kept[k + 2].length !== 0) bad++
      }
      return bad
    }`
  for (const level of levels(2, 3)) {
    const { exports, memory } = jz(src, { optimize: level })
    for (let round = 0; round < 2; round++) {
      let last = 0, compactions = 0, bad = 0
      for (let i = 0; i < 2000; i++) { bad += exports.step(i); if (memory.used < last) compactions++; last = memory.used }
      ok(compactions >= 1, `O${level}, round ${round}: compacted (${compactions})`)
      is(bad, 0, `O${level}, round ${round}: every property where its object now stands, none on another`)
      memory.reset()
    }
  }
})

// A table the module's start built (properties given at init) lies below the
// reset mark, and a reset heals the round's entries in it by their slots'
// addresses: the move's rekey carries each logged address to its entry's new
// slot, so the reset drops the round's entries and keeps the init ones.
test('compact: a props table built at init heals at a reset after compactions rekeyed it', () => {
  if (onWasi() || !counted()) return
  const src = `const bases = []
    const mk = (k) => { const b = () => k; b.kind = 'base' + k; return b }
    for (let k = 0; k < 300; k++) bases.push(mk(k))
    let kept = [], junk = []
    export const step = (i) => {
      junk.push(new Array(24).fill(i))
      if (junk.length > 60) junk = junk.slice(30)
      if (i % 50 === 0) {
        const f = () => i
        f.tag = 'f' + i
        const l = [-1, i, i + 1]
        l.shift()
        l.label = 'l' + i
        kept.push(f)
        kept.push(l)
        if (kept.length > 20) kept = kept.slice(10)
      }
      const g = () => i, m = [0, i]
      m.shift()
      let bad = (g.tag === undefined ? 0 : 1) + (m.label === undefined ? 0 : 1)
      for (let k = 0; k < kept.length; k += 2) {
        const j = kept[k]()
        if (kept[k].tag !== 'f' + j) bad++
        if (kept[k + 1].label !== 'l' + j || kept[k + 1][0] !== j) bad++
      }
      for (let k = 0; k < bases.length; k++) if (bases[k].kind !== 'base' + k) bad++
      return bad
    }`
  for (const level of levels(2, 3)) {
    const { exports, memory } = jz(src, { optimize: level })
    for (let round = 0; round < 3; round++) {
      let last = 0, compactions = 0, bad = 0
      for (let i = 0; i < 2000; i++) { bad += exports.step(i); if (memory.used < last) compactions++; last = memory.used }
      ok(compactions >= 1, `O${level}, round ${round}: compacted (${compactions})`)
      is(bad, 0, `O${level}, round ${round}: the init properties kept, the round's where their objects stand`)
      memory.reset()
    }
  }
})

// A Map and a Set built at init lie below the reset mark; the entries a round
// adds to them are logged by their slots' addresses for the reset to drop
// (core/durable-log.js `__durable_slot_log`). A compaction that moves the
// round's keys rehashes the tables in place: each logged address follows its
// entry, so the reset drops the round's entries and keeps the init ones,
// whether or not the round grew the tables past their storage.
test('compact: collections built at init and keyed by objects heal at a reset after compactions rehashed them', () => {
  if (onWasi() || !counted()) return
  const src = (every, until) => `const byKey = new Map(), seen = new Set()
    const base = [0]
    byKey.set(base, 'base'); seen.add(base)
    const fill = (k) => { const o = [k]; byKey.set(o, k); seen.add(o) }
    for (let k = 0; k < 40; k++) fill(k)
    let junk = []
    export const step = (i) => {
      junk.push(new Array(24).fill(i))
      if (junk.length > 60) junk = junk.slice(30)
      if (i % ${every} === 0 && i < ${until}) { const o = [i]; byKey.set(o, 'r' + i); seen.add(o) }
      return byKey.size + seen.size + (byKey.get(base) === 'base' ? 0 : 1000) + (seen.has(base) ? 0 : 1000)
    }
    export const count = () => { let n = 0; for (const [k] of byKey) n += Array.isArray(k) ? 1 : 1000; for (const k of seen) n += Array.isArray(k) ? 1 : 1000; return n }`
  for (const [every, until, name] of [[400, 2000, 'in place'], [50, 1000, 'grown']]) for (const level of levels(2, 3)) {
    const { exports, memory } = jz(src(every, until), { optimize: level })
    const added = 2 * Math.ceil(until / every)
    for (let round = 0; round < 3; round++) {
      let last = 0, compactions = 0, r = 0
      for (let i = 0; i < 2000; i++) { r = exports.step(i); if (memory.used < last) compactions++; last = memory.used }
      ok(compactions >= 1, `${name}, O${level}, round ${round}: compacted (${compactions})`)
      is(r, 82 + added, `${name}, O${level}, round ${round}: the round's entries`)
      memory.reset()
      is(exports.count(), 82, `${name}, O${level}, round ${round}: the reset keeps the init entries alone`)
    }
  }
})

// A Map that grew at init is a chain of stubs below the reset mark, the
// pointer the module holds its first. A round grows it again into new
// storage, which a compaction moves: the stub rewritten to name the moved
// storage is the chain's last below the mark, the one the reset's relocation
// heal restores to the table it was, so the reset reads the init entries again.
test('compact: a collection that grew at init heals at a reset after a compaction moved what the round grew', () => {
  if (onWasi() || !counted()) return
  const src = `const list = [], byName = new Map()
    const fill = (k) => { list.push(k); byName.set('n' + k, k) }
    for (let k = 0; k < 40; k++) fill(k)
    let junk = []
    export const step = (i) => {
      junk.push(new Array(24).fill(i))
      if (junk.length > 60) junk = junk.slice(30)
      if (i % 50 === 0 && i < 1500) { list.push(i); byName.set('r' + i, i) }
      return list.length + byName.size
    }
    export const sum = () => { let s = 0; for (const v of list) s += v; let m = 0; for (const [, v] of byName) m += v; return [list.length, s, byName.size, m].join() }`
  for (const level of levels(2, 3)) {
    const { exports, memory } = jz(src, { optimize: level })
    for (let round = 0; round < 3; round++) {
      let last = 0, compactions = 0
      for (let i = 0; i < 2000; i++) { exports.step(i); if (memory.used < last) compactions++; last = memory.used }
      ok(compactions >= 1, `O${level}, round ${round}: compacted (${compactions})`)
      is(exports.sum(), '70,22530,70,22530', `O${level}, round ${round}: the round's entries`)
      memory.reset()
      is(exports.sum(), '40,780,40,780', `O${level}, round ${round}: the reset reads the init entries again`)
    }
  }
})

// A phase checkpoint that declines (scripts/self.js checkpointPhase: the phase
// wrote into storage older than itself) compacts the phase's memory
// (module/core.js `__gc_phase`): what the phase filed into module state, what
// its closure captured and its result survive with their identities, the
// scratch it dropped goes, and the frames around it, which read the escape
// log, keep the survivors: a compaction within a call leaves the log full,
// not empty (an empty log reads as nothing escaped, and a frame would release
// what the move kept).
test('compact: a phase that wrote into older storage keeps what it made reachable and no more', () => {
  if (onWasi() || !counted()) return
  const src = (compact) => `const filed = new Map(), byKey = new Map(), owners = []
    let last = null
    const phase = (run) => {
      const mark = __park_mark(), esave = __park_enter(), lsave = __park_low_enter(), bsave = __park_base_enter(mark)
      const out = run()
      let kept = out
      ${compact ? 'if (!__park_safe(mark)) kept = __gc_phase(mark, out, run)' : ''}
      __park_end(esave, bsave, lsave)
      return kept
    }
    export const main = (n) => {
      const before = __heap_mark(), seen = { hits: [] }
      const res = phase(() => {
        const scratch = []
        for (let i = 0; i < n; i++) {
          scratch.push(new Array(24).fill(i), 'tmp' + i)
          const rec = { v: i, list: [i * 2], name: 'k' + i }
          filed.set(rec.name, rec)
          if (i % 5 === 0) byKey.set(rec, i)
          if (i % 7 === 0) owners.push(rec)
          if (i % 11 === 0) seen.hits.push([i])
          last = rec
        }
        return { n: scratch.length, first: filed.get('k0') }
      })
      const grew = __heap_mark() - before
      let s = 0
      for (const [k, o] of filed) s += o.v + o.list[0] + (o.name === k ? 1 : 0)
      for (const [o, i] of byKey) s += o.v === i ? 1 : 0
      for (const o of owners) s += o.list[0]
      for (const h of seen.hits) s += h[0]
      return [res.n, res.first.v, last.v, s, grew]
    }`
  // the sum `main` computes after its `call`-th run: the filed records are replaced, byKey and owners keep every run's
  const n = 3000
  const expect = (call) => {
    let s = 0
    for (let i = 0; i < n; i++) { s += 3 * i + 1; if (i % 5 === 0) s += call; if (i % 7 === 0) s += 2 * i * call; if (i % 11 === 0) s += i }
    return [2 * n, 0, n - 1, s].join()
  }
  for (const level of levels(2, 3)) {
    const off = jz(src(false), { optimize: level }).exports, on = jz(src(true), { optimize: level }).exports
    const a = Array.from(off.main(n)), b = Array.from(on.main(n))
    is(b.slice(0, 4).join(), expect(1), `O${level}: every value the phase filed survives the move`)
    is(a.slice(0, 4).join(), expect(1), `O${level}: as without the compaction`)
    ok(b[4] < a[4] / 2, `O${level}: the scratch goes (${b[4]} bytes kept, ${a[4]} without)`)
    // the next call files over the moved records, and the frames kept them
    is(Array.from(on.main(n)).slice(0, 4).join(), expect(2), `O${level}: a second phase over the moved records`)
    is(Array.from(off.main(n)).slice(0, 4).join(), expect(2), `O${level}: as without the compaction, twice`)
  }
})

// The same table across a phase's compaction (module/core.js `__gc_phase`): what
// the phase made keeps its properties under its new address, and the closures
// and arrays made after it where the moved ones stood take none.
test('compact: named properties kept by address follow the objects a phase compaction moves', () => {
  if (onWasi() || !counted()) return
  const src = (compact) => `const fns = [], lists = []
    let count = 0
    const phase = (run) => {
      const mark = __park_mark(), esave = __park_enter(), lsave = __park_low_enter(), bsave = __park_base_enter(mark)
      const out = run()
      let kept = out
      ${compact ? 'if (!__park_safe(mark)) kept = __gc_phase(mark, out, run)' : ''}
      __park_end(esave, bsave, lsave)
      return kept
    }
    export const main = (n) => {
      const made = phase(() => {
        let scratch = []
        for (let i = 0; i < n; i++) {
          scratch.push(new Array(16).fill(i), 'tmp' + i)
          const f = () => i + count
          f.tag = 'f' + i
          fns.push(f)
          const l = [-1, i, i + 1]
          l.shift()
          l.label = 'l' + i
          lists.push(l)
          count = i
        }
        return fns.length
      })
      // new closures and shifted arrays where the moved ones stood
      const after = []
      for (let i = 0; i < n; i++) { const g = () => i; const m = [0, i]; m.shift(); after.push(g, m) }
      let s = 0, bad = 0
      for (let i = 0; i < fns.length; i++) { if (fns[i].tag !== 'f' + (i % n)) bad++; s += fns[i]() }
      for (let i = 0; i < lists.length; i++) { if (lists[i].label !== 'l' + (i % n)) bad++; s += lists[i][0] }
      for (const o of after) if (o.tag !== undefined || o.label !== undefined) bad++
      return [made, bad, s]
    }`
  for (const level of levels(2, 3)) {
    const off = jz(src(false), { optimize: level }).exports, on = jz(src(true), { optimize: level }).exports
    for (let call = 0; call < 2; call++) {
      const a = Array.from(off.main(400)), b = Array.from(on.main(400))
      is(b[1], 0, `O${level}, call ${call}: every property where its object now stands, none on another`)
      is(b.join(), a.join(), `O${level}, call ${call}: as without the compaction`)
    }
  }
})

// The for-in key cache (module/object.js: the key array of the last table a
// for-in enumerated, read only while its epoch holds) names memory it does not
// own. A reset bumps its epoch and leaves the pointer, as a rewound frame that
// filled it does; a compaction rooting it would read the released round,
// whatever the reused memory holds now, as the cached array, and rewrite words
// of live data as its elements.
test('compact: a for-in key cache a reset left is no root of the next round\'s compaction', () => {
  if (onWasi() || !counted()) return
  const src = `const dict = {}
    for (let i = 0; i < 12; i++) dict['k' + i] = i
    let keep = []
    export const keys = () => { let s = 0; for (const k in dict) s += dict[k] + k.length; return s }
    export const step = (i) => { keep = keep.concat([[i, 'x' + i, { i }]]); if (keep.length > 40) keep = keep.slice(20); let s = 0; for (const p of keep) s += p[0] + p[2].i; return s }`
  const { exports, memory } = jz(src)
  const want = oracle(src)
  is(exports.keys(), want.keys(), 'enumerated before the reset')
  for (let i = 0; i < 40; i++) is(exports.step(i), want.step(i), `step(${i})`)
  memory.reset()
  const fresh = oracle(src)
  let last = memory.used, compactions = 0
  for (let i = 0; i < 3000; i++) { is(exports.step(i), fresh.step(i), `after the reset step(${i})`); if (memory.used < last) compactions++; last = memory.used }
  ok(compactions >= 1, `compacted after the reset (${compactions})`)
  is(exports.keys(), fresh.keys(), 'enumerates as before')
})
