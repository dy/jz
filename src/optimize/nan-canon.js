// A Number's canonical-NaN step whose value only arithmetic reads is dead, and
// so is its undefined test whose value only comparisons read.
//
//   (block (result f64) (local.set $t V) (select (f64.const nan) (local.get $t) (f64.ne (local.get $t) (local.get $t))))
//
// The emitter folds any NaN a negation, a root or a sum produces back to the one
// NaN bit pattern (ir/sentinels.js canonicalNumberIR, emit/arithmetic.js): a
// sign-flipped NaN lies in the NaN-boxed value space, where `===` and `typeof`
// would read it as a tagged value. An f64 arithmetic operator propagates every
// NaN alike, and its own result is canonicalized where it escapes; a comparison
// answers the same for every NaN; a saturating truncation yields zero for every
// NaN. So a canon whose value only such operators consume guards nothing. The
// emitter strips the ones it can link at the consumer (emit/arithmetic.js
// stripCanon); a value through a local loses the link: a gradient's sign-select
// (`const u = h & 1 ? x : -x; … u + v`), a sum's accumulator the next sum reads.
// This pass finds the rest. A value flows up through the arms of a conditional,
// a block's result, a unary operator and a reinterpretation to its consumer, or
// into a local, every read of which must flow so too, through locals alike (a
// cycle, an accumulator's, holds). Then the canon is its value.
//
// The undefined a read may answer converts to NaN the same way, by a test of its
// bits (ir/coerce.js missToNaN, toNumF64):
//
//   (block (result f64) (local.set $t V) (select (f64.const nan) (local.get $t) (i64.eq (i64.reinterpret_f64 (local.get $t)) (i64.const UNDEF))))
//
// That test is NaN for NaN: a value flows through it, and its compare reads no
// more of the bits than whether they are a NaN. A value whose every path ends in
// a comparison, a saturating truncation or a drop, through arithmetic, which
// carries a NaN on, has no payload anyone reads, so its test is its value: the
// distance a culling or an intersection test compares (`n·c + d < -r` over fields
// a reader may leave undefined). Arithmetic is no end here: it hands the box's
// bits on to its result, and the test stays wherever a result may leave.
//
// A canon in a loop whose value lands in locals only arithmetic reads there, read
// past the loop by what needs the one NaN, runs once, at those reads. A local that
// holds a field through the loop (plan/loop-fields.js) may hold a box from ahead of
// it, which such a read must keep, and every pass writes it first: a flag says that
// a pass ran, and the read normalizes only then: three's Box3.setFromArray and the
// normalize of computeVertexNormals over Vector3 scratch (bench/threegeom 0.88x the
// time). A conversion to single precision is no arithmetic here: it keeps the top of a
// NaN's payload, and a box's bits come back out of a Float32Array as the box.
import { walkAst } from '../ast.js'
import { ATOM, atomNanHex } from '../../layout.js'

const isArr = Array.isArray
const UNDEF_BITS = atomNanHex(ATOM.UNDEF), NULL_BITS = atomNanHex(ATOM.NULL)
// NaN-propagating consumers whose result is canonical where it escapes, or no Number
const PROPAGATES = new Set(['f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.min', 'f64.max',
  'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge', 'i64.trunc_sat_f64_s', 'i64.trunc_sat_f64_u', 'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u'])
// Operators whose f64 result is a Number whatever their operands: a NaN of theirs is no box
const NUMERIC = new Set(['f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.min', 'f64.max', 'f64.neg', 'f64.abs', 'f64.sqrt',
  'f64.floor', 'f64.ceil', 'f64.trunc', 'f64.nearest', 'f64.copysign', 'f64.promote_f32',
  'f64.convert_i32_s', 'f64.convert_i32_u', 'f64.convert_i64_s', 'f64.convert_i64_u'])
// (a unary operator passes a NaN on to its consumer, a reinterpretation the bits: that consumer decides)
const THROUGH = new Set(['f64.neg', 'f64.abs', 'f64.sqrt', 'f64.floor', 'f64.ceil', 'f64.trunc', 'f64.nearest', 'i64.reinterpret_f64', 'f64.reinterpret_i64'])
// Consumers that answer the same for every NaN, whatever its bits
const BLIND = new Set(['f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge', 'i64.trunc_sat_f64_s', 'i64.trunc_sat_f64_u', 'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u'])
// Operators that carry a NaN operand into a NaN result: the result's consumer decides
const CARRIES = new Set(['f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.min', 'f64.max', 'f64.neg', 'f64.abs', 'f64.sqrt', 'f64.floor', 'f64.ceil', 'f64.trunc', 'f64.nearest'])

// A test of `t`'s bits against an atom's, `(i64.eq (i64.reinterpret_f64 (local.get $t)) (i64.const UNDEF))`
const isBitsTest = (c, t, bits) => isArr(c) && c[0] === 'i64.eq' && c.length === 3 && isArr(c[1]) && c[1][0] === 'i64.reinterpret_f64' &&
  isGet(c[1][1], t) && isArr(c[2]) && c[2][0] === 'i64.const' && c[2][1] === bits
const isUndefTest = (c, t) => isBitsTest(c, t, UNDEF_BITS)
/** A miss test's parts, or null: `test` its compare, `set` the write of its temp
 *  (a value in that write goes where the test's own value goes), and `value` what
 *  stands in for the test where it is dead. The block form, the tee form, the
 *  select over a local, and the if a nullish conversion ends in. */
const missOf = (n) => {
  if (!isArr(n)) return null
  if (n[0] === 'block' && n.length === 4 && n[1]?.[0] === 'result' && n[1][1] === 'f64' && n[2]?.[0] === 'local.set' && typeof n[2][1] === 'string') {
    const s = n[3], t = n[2][1]
    return isArr(s) && s[0] === 'select' && s.length === 4 && isNaN_(s[1]) && isGet(s[2], t) && isUndefTest(s[3], t) ? { test: s[3], set: n[2], value: n[2][2] } : null
  }
  if (n[0] === 'select' && n.length === 4 && isNaN_(n[1]) && isArr(n[2])) {
    const v = n[2]
    if (v[0] === 'local.tee' && typeof v[1] === 'string' && isUndefTest(n[3], v[1])) return { test: n[3], set: v, value: v }
    if (v[0] === 'local.get' && typeof v[1] === 'string' && isUndefTest(n[3], v[1])) return { test: n[3], set: null, value: v }
    return null
  }
  if (n[0] === 'if' && n.length === 5 && n[1]?.[0] === 'result' && n[1][1] === 'f64' && n[3]?.[0] === 'then' && n[3].length === 2 && n[4]?.[0] === 'else' && n[4].length === 2) {
    const e = n[4][1]
    if (isNaN_(n[3][1]) && isArr(e) && e[0] === 'local.get' && isUndefTest(n[2], e[1])) return { test: n[2], set: null, value: e }
    // (ToNumber of a value of no kind but these: null is 0, undefined the miss in its else arm, or what that arm left)
    if (isArr(n[3][1]) && n[3][1][0] === 'f64.const' && n[3][1][1] === 0 && isArr(e)) {
      const v = e[0] === 'local.get' ? e : missOf(e)?.value
      if (isArr(v) && v[0] === 'local.get' && isBitsTest(n[2], v[1], NULL_BITS)) return { test: n[2], set: null, value: v, zero: true }
    }
  }
  return null
}

/** The value a canon normalizes, or null: the block form, and the tee form a propagation leaves. */
const canonValue = (n) => {
  if (!isArr(n)) return null
  if (n[0] === 'block' && n.length === 4 && n[1]?.[0] === 'result' && n[1][1] === 'f64' && n[2]?.[0] === 'local.set' && typeof n[2][1] === 'string' && isCanonSelect(n[3], n[2][1])) return n[2][2]
  if (n[0] === 'select' && isCanonSelect(n, null)) return n[2][2]
  return null
}
const isNaN_ = (n) => isArr(n) && n[0] === 'f64.const' && (n[1] === 'nan' || Number.isNaN(n[1]))
const isGet = (n, t) => isArr(n) && n[0] === 'local.get' && n[1] === t
const isCanonSelect = (s, t) => {
  if (!isArr(s) || s[0] !== 'select' || s.length !== 4 || !isNaN_(s[1])) return false
  const v = s[2]
  if (t == null) { if (!isArr(v) || v[0] !== 'local.tee' || typeof v[1] !== 'string') return false; t = v[1] }
  else if (!isGet(v, t)) return false
  const ne = s[3]
  return isArr(ne) && ne[0] === 'f64.ne' && isGet(ne[1], t) && isGet(ne[2], t)
}

/** Where the value of `chain[i]` goes: 'ok' (a propagating consumer, or dropped), a local's name, or 'escape'.
 *  `blind`: 'ok' only where no NaN's bits matter, arithmetic carrying the value on.
 *  A miss test (`miss`: its compares and its temps' writes) passes the value through. */
const sinkOf = (chain, i, miss, blind = false) => {
  for (let k = i; k > 0; k--) {
    const node = chain[k].node, idx = chain[k].idx, parent = chain[k - 1].node, op = parent[0]
    if (miss.tests.has(parent)) return 'ok'
    if (blind ? BLIND.has(op) : PROPAGATES.has(op)) return 'ok'
    if (blind && CARRIES.has(op)) continue
    if (op === 'drop') return 'ok'
    // (a statement's value a flat `drop` after it discards: an assignment expression's, in a body)
    if (parent[idx + 1] === 'drop' && (op === 'block' || op === 'loop' || op === 'then' || op === 'else' || op === 'func')) return 'ok'
    // (on from the test itself, the write's parent)
    if (miss.sets.has(parent)) { k--; continue }
    if (op === 'local.set' || op === 'local.tee') return typeof parent[1] === 'string' ? parent[1] : 'escape'
    if (THROUGH.has(op)) continue
    if (op === 'select' && (idx === 1 || idx === 2)) continue
    if ((op === 'then' || op === 'else') && idx === parent.length - 1) continue
    if (op === 'if' && node[0] !== 'then' && node[0] !== 'else') return 'escape'   // the condition
    if (op === 'if') continue
    if (op === 'block' && idx === parent.length - 1 && isArr(parent[1]) && parent[1][0] === 'result') continue
    return 'escape'
  }
  return 'escape'
}

const SEQUENCE = new Set(['func', 'block', 'loop', 'then', 'else'])
// Whether a branch in `n` leaves it: to a label no node of `n` declares.
const leaves = (n, inner) => {
  if (!isArr(n)) return false
  const op = n[0]
  if (op === 'br' || op === 'br_if' || op === 'br_table') {
    for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string' && n[i][0] === '$' && !inner.has(n[i]) || typeof n[i] === 'number') return true
    return n.slice(1).some(c => leaves(c, inner))
  }
  const own = (op === 'block' || op === 'loop') && typeof n[1] === 'string' ? n[1] : null
  if (own) inner.add(own)
  const out = n.slice(1).some(c => leaves(c, inner))
  if (own) inner.delete(own)
  return out
}
// The first statement's index of a block or a loop, past its label and its type.
const bodyAt = (n) => {
  let i = typeof n[1] === 'string' ? 2 : 1
  while (isArr(n[i]) && (n[i][0] === 'result' || n[i][0] === 'param' || n[i][0] === 'type')) i++
  return i
}
const firstLocalAt = (fn) => {
  for (let i = 1; i < fn.length; i++) if (isArr(fn[i]) && !(fn[i][0] === 'param' || fn[i][0] === 'result' || fn[i][0] === 'export' || fn[i][0] === 'type')) return i
  return fn.length
}

export function stripDeadCanons(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return false
  const reads = new Map()     // local → the sinks of its reads
  const readSites = new Map() // local → its reads: { sink, parent, idx, loops }
  const canons = new Map()    // canon node → the sinks of its positions (a node two parents share has two)
  const canonLoops = new Map()  // canon node → the loops around each position
  const blindReads = new Map()  // local → the sinks of its reads where only a NaN's bits would matter
  const misses = new Map()      // miss test → those sinks of its positions
  const missLoops = new Map()   // miss test → the innermost loop around it
  const miss = { tests: new Set(), sets: new Set(), inner: new Set() }
  const chain = [], loops = []
  // the walk's order, each sequence's end in it, each local's writes, each loop's place, and
  // the first thing a pass does to each local: its write's index in the loop, or null
  let order = 0
  const ends = new Map(), writeSites = new Map(), homes = new Map(), firsts = new Map()
  const starts = new Map()
  const firstAccess = (name, at) => { for (const l of loops) { const f = firsts.get(l); if (!f.has(name)) f.set(name, at === -1 || loops[loops.length - 1] !== l ? null : at) } }
  const visit = (node, parent, idx) => {
    if (!isArr(node)) return
    chain.push({ node, idx })
    const op = node[0], at = ++order
    if (SEQUENCE.has(op)) starts.set(node, at)
    const m = miss.inner.has(node) ? null : missOf(node)
    if (m) {
      miss.tests.add(m.test)
      if (m.set) miss.sets.add(m.set)
      if (op === 'block') miss.inner.add(node[3])
      if (parent) { const s = sinkOf(chain, chain.length - 1, miss, true); const l = misses.get(node); if (l) l.push(s); else misses.set(node, [s]) }
      if (loops.length) missLoops.set(node, loops[loops.length - 1])
    }
    if ((op === 'local.get' || op === 'local.tee') && typeof node[1] === 'string') {
      const s = sinkOf(chain, chain.length - 1, miss)
      const l = reads.get(node[1]); if (l) l.push(s); else reads.set(node[1], [s])
      if (op === 'local.get') firstAccess(node[1], -1)
      const site = { sink: s, parent, idx, loops: loops.slice(), at }
      const r = readSites.get(node[1]); if (r) r.push(site); else readSites.set(node[1], [site])
      const b = sinkOf(chain, chain.length - 1, miss, true)
      const lb = blindReads.get(node[1]); if (lb) lb.push(b); else blindReads.set(node[1], [b])
    }
    if (canonValue(node) != null && parent) {
      const s = sinkOf(chain, chain.length - 1, miss); const l = canons.get(node); if (l) l.push(s); else canons.set(node, [s])
      const p = canonLoops.get(node); if (p) p.push(loops.slice()); else canonLoops.set(node, [loops.slice()])
    }
    if (op === 'loop') {
      // the statements the loop may stand for: its block, and an `if` of two versions of it
      const places = [], others = []
      for (let k = chain.length - 1; ;) {
        while (k > 0 && chain[k - 1].node[0] === 'block' && chain[k - 1].node.filter(isArr).length === 1) k--
        const list = k > 0 ? chain[k - 1].node : fn
        places.push({ list, stmt: chain[k].node, others: others.slice() })
        if (k < 2 || (list[0] !== 'then' && list[0] !== 'else') || chain[k - 2].node[0] !== 'if') break
        const arm = list, cond = chain[k - 2].node
        for (const c of cond) if (isArr(c) && (c[0] === 'then' || c[0] === 'else') && c !== arm) others.push(c)
        k -= 2
      }
      homes.set(node, places)
      firsts.set(node, new Map())
      loops.push(node)
    }
    for (let i = 1; i < node.length; i++) visit(node[i], node, i)
    if (op === 'loop') loops.pop()
    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string') {
      // (the statement of the loop the write stands in: plain blocks lie between them, nothing else)
      let k = chain.length - 1
      while (k > 0 && chain[k - 1].node[0] === 'block' && typeof chain[k - 1].node[1] !== 'string') k--
      firstAccess(node[1], k > 0 && chain[k - 1].node === loops[loops.length - 1] ? chain[k].idx : -1)
      const w = writeSites.get(node[1]), site = { value: node[2], parent, idx, loops: loops.slice(), at }
      if (w) w.push(site); else writeSites.set(node[1], [site])
    }
    if (SEQUENCE.has(op) || op === 'if') ends.set(node, ++order)
    chain.pop()
  }
  for (let i = 1; i < fn.length; i++) visit(fn[i], fn, i)
  ends.set(fn, ++order)
  if (!canons.size && !misses.size) return false
  // (a local every read of which flows to a propagating consumer, or to such a local)
  const badOf = (sinksOf) => {
    const bad = new Set()
    for (let grew = true; grew;) {
      grew = false
      for (const [name, sinks] of sinksOf) {
        if (bad.has(name)) continue
        if (sinks.some(s => s === 'escape' || (s !== 'ok' && bad.has(s)))) { bad.add(name); grew = true }
      }
    }
    return bad
  }
  const bad = badOf(reads), blindBad = badOf(blindReads)
  const dead = (s) => s === 'ok' || (s !== 'escape' && !bad.has(s))
  const unseen = (s) => s === 'ok' || (s !== 'escape' && !blindBad.has(s))
  // A canon in a loop whose value lands in locals that the loop reads only by
  // arithmetic, and that a read needing the one NaN reads only outside the loop
  // (`data[i] = x` after a cascade of stages, `x = y` in each): those reads take
  // the canon, the loop none. Every read that is no propagating consumer, of every
  // local the value reaches, normalizes what it reads, so it reads what the canon
  // would have written; the arithmetic reads propagate a NaN either way. Only for
  // locals that never hold a box: every value written to one is a Number by its
  // operator (arithmetic, a conversion, a numeric constant, a canon) or a read of
  // such a local. A parameter's entry value, a load, a call may be a box (`let s =
  // bag.sum; if (s == null) …`), which a normalizing read would turn into a NaN.
  const numbers = new Set(), writes = new Map()
  for (const d of fn) if (isArr(d) && d[0] === 'local' && typeof d[1] === 'string' && d[2] === 'f64') numbers.add(d[1])
  walkAst(fn, { enter: (n) => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') { const w = writes.get(n[1]); if (w) w.push(n[2]); else writes.set(n[1], [n[2]]) } } })
  const numeric = (v, known = numbers) => {
    if (!isArr(v)) return false
    const op = v[0]
    if (canonValue(v) != null || isCanonSelect(v, isArr(v[2]) && v[2][0] === 'local.get' ? v[2][1] : null)) return true
    if (op === 'f64.const') return typeof v[1] === 'number' || typeof v[1] === 'string' && !/nan:/.test(v[1])
    if (NUMERIC.has(op)) return true
    // (a miss test of a Number is the Number)
    const m = missOf(v)
    if (m) return numeric(m.set ? m.set[2] : m.value, known)
    if (op === 'local.get') return known.has(v[1])
    if (op === 'local.tee') return known.has(v[1]) && numeric(v[2], known)
    if (op === 'select') return numeric(v[1], known) && numeric(v[2], known)
    if (op === 'block') return isArr(v[1]) && v[1][0] === 'result' && numeric(v[v.length - 1], known)
    if (op === 'if') { const t = v.find(c => isArr(c) && c[0] === 'then'), e = v.find(c => isArr(c) && c[0] === 'else'); return !!(t && e && numeric(t[t.length - 1], known) && numeric(e[e.length - 1], known)) }
    return false
  }
  for (let grew = true; grew;) { grew = false; for (const name of numbers) if ((writes.get(name) ?? []).some(v => !numeric(v))) { numbers.delete(name); grew = true } }
  const sunk = new Set(), wraps = new Map()
  // The flag of a loop whose locals may hold a box from ahead of it (`gated`), FREE where none
  // may, or null where it cannot say. A box from ahead stands in the list that holds the loop
  // (or comes from the other arm of the `if` of its two versions, which leaves the flag down),
  // and what reads it follows the loop there, so a read past the loop has passed the flag's
  // reset. Each local holding such a box ahead of the loop is the first thing a pass writes,
  // with no way out of the pass between the first and the last, so that a raised flag answers
  // for all of them; a copy past the loop is gated as its source is.
  const flags = new Map(), FREE = {}
  const fits = (loop, place, reach, sites) => {
    const { list, stmt, others } = place
    if (!SEQUENCE.has(list[0])) return null
    const before = list.indexOf(stmt), end = ends.get(stmt), past = ends.get(list)
    if (end == null || past == null || sites.some(s => s.at < end || s.at > past)) return null
    const known = new Set([...numbers, ...reach]), held = new Set(), gated = new Set(), copies = []
    const inArm = (w, arm) => w.at > starts.get(arm) && w.at < ends.get(arm)
    for (const name of reach) for (const w of writeSites.get(name) ?? []) {
      if (w.loops.includes(loop)) { if (!numeric(w.value, known)) return null; continue }
      if (numeric(w.value)) continue
      if (others.some(a => inArm(w, a))) { gated.add(name); continue }
      if (isArr(w.value) && w.value[0] === 'local.get' && reach.has(w.value[1]) && w.at > end) { copies.push([name, w.value[1]]); continue }
      if (w.parent !== list || w.idx >= before) return null
      held.add(name); gated.add(name)
    }
    for (const name of held) gated.add(name)
    for (let grew = true; grew;) { grew = false; for (const [to, from] of copies) if (gated.has(from) && !gated.has(to)) { gated.add(to); grew = true } }
    return { held, gated }
  }
  const flagOf = (loop, reach, sites) => {
    const f = flags.get(loop) ?? { name: null, lo: Infinity, hi: 0, numbers: new Set(), gated: new Set(), place: null }, first = firsts.get(loop)
    let place = f.place, got = place && fits(loop, place, reach, sites)
    if (!place) for (const p of homes.get(loop) ?? []) if (got = fits(loop, p, reach, sites)) { place = p; break }
    if (!got) return null
    if (!got.gated.size) return FREE
    let lo = f.lo, hi = f.hi
    for (const name of got.held) {
      const i = first.get(name)
      if (i == null) return null
      lo = Math.min(lo, i); hi = Math.max(hi, i)
    }
    for (let i = lo; i <= hi; i++) if (leaves(loop[i], new Set())) return null
    f.lo = lo; f.hi = hi; f.place = place
    for (const name of reach) f.numbers.add(name)
    for (const name of got.gated) f.gated.add(name)
    flags.set(loop, f)
    return f
  }
  for (const [node, sinks] of canons) {
    if (sinks.every(dead) || sinks.includes('escape')) continue
    const around = canonLoops.get(node)
    if (around.some(l => !l.length)) continue
    const reach = new Set(sinks.filter(s => s !== 'ok')), stack = [...reach]
    while (stack.length) for (const s of reads.get(stack.pop()) ?? []) if (s !== 'ok' && s !== 'escape' && !reach.has(s)) { reach.add(s); stack.push(s) }
    const sites = []
    for (const name of reach) for (const site of readSites.get(name) ?? []) if (site.sink === 'escape') sites.push(site)
    // (outside the canon's innermost loop: once per pass of a loop around it, or on another path)
    if (sites.some(site => around.some(l => site.loops.includes(l[l.length - 1])))) continue
    let flag = null
    if ([...reach].some(name => !numbers.has(name))) {
      if (around.length !== 1) continue
      flag = flagOf(around[0][around[0].length - 1], reach, sites)
      if (!flag) continue
      if (flag === FREE) flag = null
    }
    sunk.add(node)
    for (const site of sites) {
      let at = wraps.get(site.parent); if (!at) wraps.set(site.parent, at = new Map())
      const f = at.get(site.idx), gate = flag?.gated.has(site.parent[site.idx][1]) ? flag : null
      if (!gate) at.set(site.idx, null); else if (f !== null) at.set(site.idx, (f ?? new Set()).add(gate))
    }
  }
  let ran = 0
  const ranName = (f) => f.name ??= `$__ran${ran++}`
  for (const [parent, at] of wraps) for (const [i, only] of at) {
    const get = parent[i], name = get[1]
    const test = () => {
      const ne = ['f64.ne', ['local.get', name], ['local.get', name]]
      if (!only) return ne
      const any = [...only].map(f => ['local.get', ranName(f)]).reduce((a, b) => ['i32.or', a, b])
      return ['i32.and', ne, any]
    }
    if (isArr(get) && get[0] === 'local.get') parent[i] = ['select', ['f64.const', 'nan'], get, test()]
    else parent[i] = ['block', ['result', 'f64'], ['local.set', name, get[2]], ['select', ['f64.const', 'nan'], ['local.get', name], test()]]
  }
  // (each flag a pass raises past the writes it speaks for, and the loop's place lowers ahead of it)
  for (const [loop, f] of flags) {
    if (!f.name) continue
    loop.splice(f.lo === Infinity ? bodyAt(loop) : f.hi + 1, 0, ['local.set', f.name, ['i32.const', 1]])
    const { list, stmt } = f.place
    list.splice(list.indexOf(stmt), 0, ['local.set', f.name, ['i32.const', 0]])
    fn.splice(firstLocalAt(fn), 0, ['local', f.name, 'i32'])
  }
  // (bottom up, in the tree as it stands: a canon in the value of another is
  // replaced there first, and one two parents share is replaced under each)
  let changed = wraps.size > 0
  // (a miss test whose temp something else reads leaves the temp written)
  const missValue = (n) => {
    const m = missOf(n)
    return n[0] !== 'block' || readSites.get(m.set[1])?.length === 2 ? m.value : ['local.tee', m.set[1], m.value]
  }
  // (in the loop a flag speaks for, its locals hold Numbers: a pass writes them first)
  const heldThere = (n) => {
    const f = flags.get(missLoops.get(n)), m = missOf(n), v = m.set ? m.set[2] : m.value
    return !!f?.name && isArr(v) && v[0] === 'local.get' && f.numbers.has(v[1])
  }
  const replace = (n) => {
    if (!isArr(n)) return n
    for (let i = 1; i < n.length; i++) n[i] = replace(n[i])
    // (null converts to 0, a Number of its own: a comparison reads it apart from a NaN, so its
    // test is dead only where the value is held a Number)
    if (misses.has(n) && (!missOf(n).zero && misses.get(n).every(unseen) || heldThere(n))) { changed = true; return missValue(n) }
    const sinks = canons.get(n)
    if (sinks == null || !(sunk.has(n) || sinks.every(dead))) return n
    changed = true
    return canonValue(n)
  }
  for (let i = 1; i < fn.length; i++) fn[i] = replace(fn[i])
  if (!changed) return false
  // The emitter's sum lands in a temp the canon reads into its accumulator
  // (`num = acc + p; acc = canon(num)`): with the canon gone the temp is a copy,
  // read once, which the lifts would not see through. The value lands directly.
  const once = (t) => (reads.get(t)?.length ?? 0) === 1
  const fold = (list, from) => {
    for (let i = from; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1]
      if (isArr(a) && a[0] === 'local.set' && isArr(b) && b[0] === 'local.set' && isGet(b[2], a[1]) && once(a[1])) { list.splice(i, 2, ['local.set', b[1], a[2]]); i-- }
    }
  }
  walkAst(fn, { enter: (n) => {
    if (n[0] === 'func') fold(n, 1)
    else if (n[0] === 'loop' || n[0] === 'block') fold(n, 1)
    else if (n[0] === 'then' || n[0] === 'else') fold(n, 1)
  } })
  return true
}
