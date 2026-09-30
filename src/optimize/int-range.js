// Value intervals of the numeric locals, read off the control flow.
//
// A number that holds an integer computes in f64 wherever its local was typed
// before its range was known: `base = f * 3` over an element `f` may pass 2^31,
// so `base` is an f64, and every index and comparison it reaches converts.
// This walk gives each value the closed interval it lies in and whether it is
// an integer, so that a later pass can carry it in an integer register
// (optimize/int-narrow.js).
//
// A value is { lo, hi, int, nz, nan }: a number, never a boxed value, within
// [lo, hi] unless it is NaN (`nan`: it may be), an integer when `int`, maybe
// -0 when `nz`. An infinite bound leaves the magnitude open; an integer with
// finite bounds is a finite integer. Null is any value at all: a box, which
// arithmetic can hand on as the NaN it is. An i64 that holds the bits of a
// number (`i64.reinterpret_f64`) is any word with `of`, the number's value:
// a test of its bits for a box fails, and it is no operand of integer
// arithmetic (`mask`: the bits an `i64.and` kept).
//
// The walk follows the statements in evaluation order and keeps the interval
// of every i32, i64 and f64 local at each point. A comparison refines the
// interval in the arm it guards; arms hull at their join. A loop is walked to
// a fixpoint: its head is the hull of its entry and its back edges, bounds
// that still move after two walks widen to infinity, and two more walks
// without widening take back what the loop's own tests bound (a counter
// `e >= 0; e--` from E lies in [-1, E]). The function is walked whole each
// time, every loop from the head it had: the walks are as many as the heads
// take to settle, whatever the nesting. Only the last walk records.

const isArr = Array.isArray

export const LIMIT = 2 ** 52
const I32 = Object.freeze({ lo: -(2 ** 31), hi: 2 ** 31 - 1, int: true, nz: false, nan: false })
const BOOL = Object.freeze({ lo: 0, hi: 1, int: true, nz: false, nan: false })
/** Any number: what a float element holds. */
const NUMBER = Object.freeze({ lo: -Infinity, hi: Infinity, int: false, nz: true, nan: true })
const NAN = Object.freeze({ lo: Infinity, hi: -Infinity, int: true, nz: false, nan: true })
const val = (lo, hi, int = true, nz = false, nan = false) => lo <= hi ? { lo, hi, int, nz, nan } : nan ? NAN : null
const exact = v => val(v, v, Number.isInteger(v), Object.is(v, -0))
const none = v => v.lo > v.hi   // NaN alone

export const hull = (a, b) => !a || !b ? null : a.of || b.of ? (a.of && b.of && a.mask === b.mask ? bitsOf(hull(a.of, b.of), a.mask) : null)
  : { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi), int: a.int && b.int, nz: a.nz || b.nz, nan: a.nan || b.nan }
const within = (a, b) => !b || (!!a && (b.of ? !!a.of && a.mask === b.mask && within(a.of, b.of) : !a.of &&
  (none(a) || (a.lo >= b.lo && a.hi <= b.hi)) && (a.int || !b.int) && (!a.nz || b.nz) && (!a.nan || b.nan)))
/** The bits of a number that holds `v`, as the word they are. */
const bitsOf = (v, mask = undefined) => v && { lo: -Infinity, hi: Infinity, int: false, nz: true, nan: true, of: v, mask }
const EXPONENT = 0x7FF0000000000000n
/** Whether `a` is an integer within the magnitude i64 and f64 agree on. */
export const isInt = a => !!a && a.int && !a.nan && a.lo >= -LIMIT && a.hi <= LIMIT
export const fitsI32 = a => isInt(a) && a.lo >= I32.lo && a.hi <= I32.hi
/** Whether the value is a number that is never NaN. */
const real = a => !!a && !a.nan
const unbounded = a => a.lo === -Infinity || a.hi === Infinity

// The intervals of the locals at one point: a slot a local (`index`, one for
// every point of a function's walks), null where nothing bounds it, the slots
// in runs of 32. A stretch of code that starts from a point (an arm, a branch
// taken, a loop body) shares the runs until either writes: the writer takes
// its copy of the list of runs first (`own`), then of the run it writes
// (`mine`). A join shares the runs its two sides share, so a branch costs
// the runs it wrote, whatever the function's size.
const RUN = 32
const emptyRun = () => { const r = []; for (let k = 0; k < RUN; k++) r.push(null); return r }
const envOf = index => ({ index, runs: [], own: true, mine: [] })
const slot = (env, name) => {
  let i = env.index.get(name)
  if (i === undefined) { i = env.index.size; env.index.set(name, i) }
  return i
}
/** The interval of a local at this point, or null where nothing bounds it. */
export const boundOf = (env, name) => {
  const i = env.index.get(name)
  if (i === undefined) return null
  const run = env.runs[i >> 5]
  return run === undefined ? null : run[i & 31]
}
const bind = (env, name, v) => {
  const i = slot(env, name), c = i >> 5
  if (!env.own) { env.runs = env.runs.slice(); env.mine = env.runs.map(() => false); env.own = true }
  while (env.runs.length <= c) { env.runs.push(emptyRun()); env.mine.push(true) }
  if (!env.mine[c]) { env.runs[c] = env.runs[c].slice(); env.mine[c] = true }
  env.runs[c][i & 31] = v ?? null
}
/** A stretch that starts here. */
const fork = env => { env.own = false; return { index: env.index, runs: env.runs, own: false, mine: null } }
const joinEnv = (a, b) => {
  if (!a) return b
  if (!b) return a
  if (a === b) return a
  const x = a.runs, y = b.runs
  // (what the join shares, neither side writes in place from here on)
  a.own = b.own = false
  if (x === y) return fork(a)
  const runs = [], mine = []
  for (let c = 0, n = Math.min(x.length, y.length); c < n; c++) {
    const p = x[c], q = y[c]
    if (p === q) { runs.push(p); mine.push(false); continue }
    const r = []
    for (let k = 0; k < RUN; k++) { const u = p[k], v = q[k]; r.push(u === v ? u : u && v ? hull(u, v) : null) }
    runs.push(r)
    mine.push(true)
  }
  return { index: a.index, runs, own: true, mine }
}
const envWithin = (a, b) => {
  const x = a.runs, y = b.runs
  for (let c = 0; c < y.length; c++) {
    const p = x[c], q = y[c]
    for (let k = 0; k < RUN; k++) { const v = q[k]; if (v && !within(p === undefined ? null : p[k], v)) return false }
  }
  return true
}
// (`open`: the slots of the locals whose bounds may move without end, the ones on
// a cycle of writes; every other bound is a hull of theirs and settles once they do)
const widen = (old, next, open) => {
  const x = old.runs, y = next.runs, runs = [], mine = []
  for (let c = 0; c < x.length; c++) {
    const p = x[c], q = y[c], r = []
    for (let k = 0; k < RUN; k++) {
      const u = p[k], v = u && q !== undefined ? q[k] : null
      if (!v) r.push(null)
      else if (u.of || v.of || !open.has(c * RUN + k)) r.push(hull(u, v))
      else r.push({ lo: v.lo < u.lo ? -Infinity : u.lo, hi: v.hi > u.hi ? Infinity : u.hi, int: u.int && v.int, nz: u.nz || v.nz, nan: u.nan || v.nan })
    }
    runs.push(r)
    mine.push(true)
  }
  return { index: old.index, runs, own: true, mine }
}

const LEAVES = new Set(['return', 'unreachable', 'throw', 'throw_ref', 'rethrow', 'return_call', 'return_call_indirect', 'return_call_ref'])
const F64_CMP = { 'f64.eq': 'eq', 'f64.ne': 'ne', 'f64.lt': 'lt', 'f64.le': 'le', 'f64.gt': 'gt', 'f64.ge': 'ge' }
const INT_CMP = {
  'i32.eq': 'eq', 'i32.ne': 'ne', 'i32.lt_s': 'lt', 'i32.le_s': 'le', 'i32.gt_s': 'gt', 'i32.ge_s': 'ge',
  'i64.eq': 'eq', 'i64.ne': 'ne', 'i64.lt_s': 'lt', 'i64.le_s': 'le', 'i64.gt_s': 'gt', 'i64.ge_s': 'ge',
}
const UNSIGNED_CMP = { 'i32.lt_u': 'lt', 'i32.le_u': 'le', 'i32.gt_u': 'gt', 'i32.ge_u': 'ge', 'i64.lt_u': 'lt', 'i64.le_u': 'le', 'i64.gt_u': 'gt', 'i64.ge_u': 'ge' }
const FLIP = { eq: 'eq', ne: 'ne', lt: 'gt', le: 'ge', gt: 'lt', ge: 'le' }
const NOT = { eq: 'ne', ne: 'eq', lt: 'ge', le: 'gt', gt: 'le', ge: 'lt' }

const numConst = n => isArr(n) && (n[0] === 'f64.const' || n[0] === 'i32.const' || n[0] === 'i64.const') ? constValue(n) : null
const constValue = n => {
  const v = n[1]
  // Intervals use Number endpoints. An i64 payload beyond its exact integer
  // range must not round onto a neighbouring value and prove a false equality.
  if (n[0] === 'i64.const') {
    try {
      const c = Number(BigInt.asIntN(64, BigInt(typeof v === 'string' ? v.replace(/_/g, '') : v)))
      return Number.isSafeInteger(c) ? c : null
    } catch { return null }
  }
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(BigInt.asIntN(64, v))
  if (typeof v !== 'string') return null
  if (n[0] === 'f64.const') return /^[-+]?(?:\d|\.\d)/.test(v) && !/^[-+]?0x/i.test(v) ? Number(v) : v === 'inf' || v === '+inf' ? Infinity : v === '-inf' ? -Infinity : null
  try { return Number(BigInt.asIntN(64, BigInt(v.replace(/_/g, '')))) } catch { return null }
}
/** The bits of an `i64.const`, or null. */
export const constBits = n => {
  if (!isArr(n) || n[0] !== 'i64.const') return null
  const v = n[1]
  try { return BigInt.asUintN(64, typeof v === 'string' ? BigInt(v.replace(/_/g, '')) : BigInt(v)) } catch { return null }
}
/** Whether the bits are a boxed value's: a NaN with a payload, which no number carries. */
export const boxBits = b => b != null && (b & 0x7FF0000000000000n) === 0x7FF0000000000000n && (b & 0x0007FFFFFFFFFFFFn) !== 0n
const f64bits = new BigUint64Array(1), f64of = new Float64Array(f64bits.buffer)
/** Whether an `f64.const` is the NaN a number can be (not a box, whose payload names a value). */
export const plainNaN = n => {
  if (!isArr(n) || n[0] !== 'f64.const') return false
  if (typeof n[1] === 'string') return n[1] === 'nan' || n[1] === '-nan' || n[1] === '+nan'
  if (!Number.isNaN(n[1])) return false
  f64of[0] = n[1]
  return (f64bits[0] & 0x7FFFFFFFFFFFFFFFn) === 0x7FF8000000000000n
}

export const pure = n => !isArr(n) || (n[0] !== 'local.set' && n[0] !== 'local.tee' && n[0] !== 'call' && n[0] !== 'call_indirect' && n[0] !== 'call_ref' &&
  n[0] !== 'br' && n[0] !== 'br_if' && n[0] !== 'br_table' && n[0] !== 'global.set' && !LEAVES.has(n[0]) &&
  !/\.store|^memory\.|^table\.|^atomic/.test(n[0]) && n.every(pure))
const same = (a, b) => a === b || (isArr(a) && isArr(b) && a.length === b.length && a.every((x, i) => same(x, b[i]))) ||
  (!isArr(a) && !isArr(b) && String(a) === String(b))

/** The parts of an `if`: its test, and its arms where it has them. A kernel
 *  written as text keeps its comments among its children. */
export const conditional = n => {
  let test = null, then = null, otherwise = null
  for (let i = 1; i < n.length; i++) {
    const c = n[i]
    if (!isArr(c) || c[0] === 'result' || c[0] === 'param' || c[0] === 'type') continue
    if (c[0] === 'then') then = c
    else if (c[0] === 'else') otherwise = c
    else if (test == null) test = c
    else if (then == null) then = c        // an arm written without its keyword
    else otherwise = c
  }
  return { test, then, otherwise }
}

/** How `y` reads the local `x` back: 'self' (the local itself: equal where
 *  it is a number), 'whole' (its truncation: equal where it is an integer),
 *  'i32', 'u32', 'i64' (its truncation through that integer: equal where it
 *  is one the integer holds), or null. A tee on the way keeps the value. */
export const readBack = (y, x) => {
  const ops = []
  for (; isArr(y) && y[0] !== 'local.get'; y = y[y.length - 1]) {
    if (y[0] === 'local.tee' && y.length === 3) continue
    if (y.length !== 2 || ops.length === 2) return null
    ops.push(y[0])
  }
  if (!isArr(y) || y[1] !== x) return null
  const [out, inner] = ops
  return out == null ? 'self' : inner == null ? (out === 'f64.trunc' ? 'whole' : null)
    : out === 'f64.convert_i32_s' && inner === 'i32.trunc_sat_f64_s' ? 'i32'
    : out === 'f64.convert_i32_u' && inner === 'i32.trunc_sat_f64_u' ? 'u32'
    : out === 'f64.convert_i64_s' && inner === 'i64.trunc_sat_f64_s' ? 'i64' : null
}
// The values each way of reading back holds exactly.
const BACK = { whole: [-Infinity, Infinity], i32: [-(2 ** 31), 2 ** 31 - 1], u32: [0, 2 ** 32 - 1], i64: [-(2 ** 63), 2 ** 63] }
export const KIND = /^\$__is_(str_key|nullish|null|object)$/

/** The remainder the emitter lowers `x % K` to for a constant K:
 *  `copysign(x - trunc(x / K) * K, x)` with `x` written out three times, or
 *  teed once and read twice. Returns { x, k, again } or null. */
export const remainderOf = n => {
  if (!isArr(n) || n[0] !== 'f64.copysign' || n.length !== 3) return null
  const sub = n[1], mul = sub?.[2], tr = mul?.[1], div = tr?.[1]
  if (sub?.[0] !== 'f64.sub' || mul?.[0] !== 'f64.mul' || tr?.[0] !== 'f64.trunc' || div?.[0] !== 'f64.div') return null
  const k = numConst(div[2])
  if (k == null || !Number.isInteger(k) || k === 0 || Math.abs(k) > 2 ** 31 || numConst(mul[2]) !== k) return null
  const x = sub[1], again = [div[1], n[2]]
  if (!isArr(x)) return null
  const read = x[0] === 'local.tee' ? ['local.get', x[1]] : x
  if (x[0] !== 'local.tee' && !pure(x)) return null
  return again.every(a => same(a, read)) ? { x, k, again } : null
}
/** `trunc(x / K)` for a constant K, the quotient of `(x / K) | 0`. */
export const quotientOf = n => {
  if (!isArr(n) || n[0] !== 'f64.trunc' || n[1]?.[0] !== 'f64.div') return null
  const k = numConst(n[1][2])
  return k != null && Number.isInteger(k) && k !== 0 && k !== -1 && Math.abs(k) <= 2 ** 31 ? { x: n[1][1], k } : null
}

/**
 * Walk `fn` and return what its values hold:
 *   av      node → interval, for every value node reached
 *   types   local → wasm type
 *   writes  local → its `local.set`/`local.tee` nodes
 *   loops   write node → the loops around it
 *   reads   local → [read node, ancestors] (a tee is a read of its own value)
 *   entry   node of `regions` → the intervals of the locals where it starts
 * or null when the control flow has a shape the walk does not follow (a
 * `try`). `assume` maps a node to the intervals of the locals a test in front
 * of it established (a specialized loop's entry).
 */
export function intRanges(fn, bodyStart, assume = null, regions = null) {
  const types = new Map(), params = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const d = fn[i]
    if (isArr(d) && (d[0] === 'param' || d[0] === 'local') && typeof d[1] === 'string') {
      types.set(d[1], d[2])
      if (d[0] === 'param') params.add(d[1])
    }
  }
  const tracked = name => { const t = types.get(name); return t === 'f64' || t === 'i32' || t === 'i64' }
  // The locals on a cycle of writes (a counter, a running sum, a pair that feed each
  // other): the ones a loop can move without end, which widen; the rest follow them.
  const feeds = new Map()
  const readsOf = (n, out) => { if (!isArr(n)) return out; if ((n[0] === 'local.get' || n[0] === 'local.tee') && typeof n[1] === 'string') out.add(n[1]); for (let i = 1; i < n.length; i++) readsOf(n[i], out); return out }
  const noteWrites = n => { if (!isArr(n)) return; if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') { const out = feeds.get(n[1]) ?? feeds.set(n[1], new Set()).get(n[1]); for (let i = 2; i < n.length; i++) readsOf(n[i], out) } for (let i = 1; i < n.length; i++) noteWrites(n[i]) }
  for (let i = bodyStart; i < fn.length; i++) noteWrites(fn[i])
  const cyclic = new Set()
  // The typed arrays this function makes (`__alloc_hdr_n`, zeroed) and reads and
  // writes through locals alone (`elements`): a load of one is bounded by what
  // the function stores into it. A local is one of them where its every write is
  // an allocation, boxed or not; an alias where its every write copies, boxes or
  // unboxes one; the array escapes where a local of it is read anywhere but an
  // address, a header, a fill, a copy, a box, an unbox or a compare of its box.
  const wexprs = new Map()
  const noteExprs = n => { if (!isArr(n)) return; if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string' && n.length === 3) (wexprs.get(n[1]) ?? wexprs.set(n[1], []).get(n[1])).push(n[2]); for (let i = 1; i < n.length; i++) noteExprs(n[i]) }
  for (let i = bodyStart; i < fn.length; i++) noteExprs(fn[i])
  const isAlloc = e => isArr(e) && e[0] === 'call' && typeof e[1] === 'string' && /^\$__alloc_hdr_n(_|$)/.test(e[1])
  const boxed = e => isArr(e) && e[0] === 'f64.reinterpret_i64' && e[1]?.[0] === 'i64.or' && e[1].length === 3 && (e[1][1]?.[0] === 'i64.const' || e[1][1]?.[0] === 'global.get') && e[1][2]?.[0] === 'i64.extend_i32_u' ? e[1][2][1] : null
  const mkptr = e => isArr(e) && e[0] === 'call' && typeof e[1] === 'string' && /^\$__mkptr(_|$)/.test(e[1]) && e.length > 2 ? e[e.length - 1] : null
  const unboxed = e => isArr(e) && e[0] === 'i32.wrap_i64' && e.length === 2 ? (e[1]?.[0] === 'i64.and' && e[1][2]?.[0] === 'i64.const' && e[1][1]?.[0] === 'i64.reinterpret_f64' ? e[1][1][1] : e[1]?.[0] === 'i64.reinterpret_f64' ? e[1][1] : null) : null
  const fresh = e => isAlloc(e) || (boxed(e) ? fresh(boxed(e)) : mkptr(e) ? fresh(mkptr(e)) : false)
  const nameRead = e => isArr(e) && (e[0] === 'local.get' || e[0] === 'local.tee') && typeof e[1] === 'string' ? e[1] : null
  // the local an alias form reads, or null
  const aliasOf = e => nameRead(e) ?? (boxed(e) ? nameRead(boxed(e)) : mkptr(e) ? nameRead(mkptr(e)) : unboxed(e) ? nameRead(unboxed(e)) : null)
  const rootOf = new Map()
  for (const [x, es] of wexprs) if (es.every(fresh)) rootOf.set(x, x)
  for (let changed = true; changed;) {
    changed = false
    for (const [x, es] of wexprs) {
      if (rootOf.has(x)) continue
      const roots = new Set(es.map(e => { const y = aliasOf(e); return y == null ? null : rootOf.get(y) ?? null }))
      if (roots.size === 1 && !roots.has(null)) { rootOf.set(x, [...roots][0]); changed = true }
    }
  }
  const escaped = new Set()
  // the base local an address reads, through the adds of an index
  const baseOf = e => { if (!isArr(e)) return null; if (nameRead(e) != null) return rootOf.has(nameRead(e)) ? nameRead(e) : null; if (e[0] === 'i32.add' && e.length === 3) return baseOf(e[1]) ?? baseOf(e[2]); return null }
  const LOAD = /^(i32|i64|f32|f64)\.(load|store)/
  const escapes = (n, parent, at) => {
    if (!isArr(n)) return
    const x = nameRead(n)
    if (x != null && rootOf.has(x)) {
      const p = parent?.[0]
      const ok = (LOAD.test(p) && at === 1 && baseOf(n) != null) ||
        (p === 'i32.add' && at !== 0) || (p === 'i32.sub' && at === 1 && parent[2]?.[0] === 'i32.const') ||
        (p === 'memory.fill' && at === 1) || ((p === 'local.set' || p === 'local.tee') && rootOf.has(parent[1])) ||
        p === 'i64.extend_i32_u' || p === 'i64.reinterpret_f64' || (mkptr(parent) != null && at === parent.length - 1) ||
        /^(i64|f64)\.(eq|ne)$/.test(p)
      if (!ok) escaped.add(rootOf.get(x))
      if (n[0] === 'local.get') return
    }
    // (an add or a header offset is an address where its own use is one; the chain ends at a load or a store)
    if (n[0] === 'i32.add' || n[0] === 'i32.sub') { const b = baseOf(n); if (b != null && !(LOAD.test(parent?.[0]) && at === 1) && !(parent?.[0] === 'i32.add' || parent?.[0] === 'i32.sub' || parent?.[0] === 'memory.fill')) escaped.add(rootOf.get(b)) }
    if (n[0] === 'memory.copy' || n[0] === 'memory.init') { const b = baseOf(n[1]); if (b != null) escaped.add(rootOf.get(b)) }
    for (let i = 1; i < n.length; i++) escapes(n[i], n, i)
  }
  for (let i = bodyStart; i < fn.length; i++) escapes(fn[i], null, 0)
  const elements = new Map()   // root → { hull, ones, unknown }: what the function stored, whether it filled with ones
  for (const r of new Set(rootOf.values())) if (!escaped.has(r)) elements.set(r, { hull: exact(0), ones: false, unknown: false, moves: 0 })
  let elementsMoved = false
  const rootAt = e => { const b = baseOf(e); return b == null ? null : elements.get(rootOf.get(b)) ?? null }
  const stored = (el, v, fits) => {
    if (el.unknown) return
    const next = v && !v.of && v.int && !v.nan && fits(v) ? hull(el.hull, v) : null
    if (!next) { el.unknown = true; elementsMoved = true }
    // (a hull that keeps growing, a chain of arrays feeding one another, is any word after a few rounds)
    else if (!within(next, el.hull)) { el.hull = ++el.moves > 3 ? val(I32.lo, I32.hi) : next; elementsMoved = true }
  }
  const FITS = { 'i32.store': v => v.lo >= I32.lo && v.hi <= I32.hi, 'i64.store32': v => v.lo >= I32.lo && v.hi <= I32.hi, 'i32.store16': v => v.lo >= -32768 && v.hi <= 65535, 'i32.store8': v => v.lo >= -128 && v.hi <= 255 }
  const loaded = (el, op) => {
    if (!el || el.unknown) return null
    const range = op === 'i32.load8_u' ? [0, 255] : op === 'i32.load8_s' ? [-128, 127] : op === 'i32.load16_u' ? [0, 65535] : op === 'i32.load16_s' ? [-32768, 32767] : [I32.lo, I32.hi]
    let h = el.hull
    if (el.ones) h = hull(h, exact(range[0] === 0 ? range[1] : -1))
    // (a store of a wider element than the load reads gives the bytes the load's kind reads: any)
    return h.lo >= range[0] && h.hi <= range[1] ? h : null
  }
  for (const start of feeds.keys()) {
    const seen = new Set(), stack = [...feeds.get(start)]
    while (stack.length) { const x = stack.pop(); if (x === start) { cyclic.add(start); break } if (seen.has(x)) continue; seen.add(x); for (const y of feeds.get(x) ?? []) stack.push(y) }
  }
  const av = new Map(), writes = new Map(), reads = new Map(), loops = new Map(), entry = new Map()
  const labels = [], stack = []
  const heads = new Map(), backs = new Map()
  let abort = false, provisional = 0, phase = 'up', round = 0, moved = false
  const note = (n, v) => {
    if (provisional) return v
    av.set(n, av.has(n) ? hull(av.get(n), v) : v)
    return v
  }
  const frameOf = name => {
    for (let i = labels.length - 1; i >= 0; i--) if (labels[i].name === name) return labels[i]
    abort = true
    return null
  }
  // The interval of an integer word read as the number it converts to.
  const word = v => v && v.int && !v.nan ? v : null

  // The interval each operand had when its operator ran (the recorded `av` is
  // the hull of every visit; a refinement uses this visit's).
  const seenAt = new Map()
  // What a test establishes: the intervals of the locals it compares, in the
  // environment where it holds (`truth`) or fails.
  const readName = x => isArr(x) && (x[0] === 'local.get' || x[0] === 'local.tee') && typeof x[1] === 'string' && tracked(x[1]) ? x[1] : null
  const bound = (env, name, rel, o, floats) => {
    const x = boundOf(env, name)
    if (x?.of || o.of) return
    // An integer's strict bound steps to the next integer.
    const whole = x ? x.int : !floats
    let lo = x && !none(x) ? x.lo : -Infinity, hi = x && !none(x) ? x.hi : Infinity
    const up = v => whole ? Math.floor(v) : v, down = v => whole ? Math.ceil(v) : v
    if (rel === 'lt') hi = Math.min(hi, whole && Number.isInteger(o.hi) ? o.hi - 1 : up(o.hi))
    else if (rel === 'le') hi = Math.min(hi, up(o.hi))
    else if (rel === 'gt') lo = Math.max(lo, whole && Number.isInteger(o.lo) ? o.lo + 1 : down(o.lo))
    else if (rel === 'ge') lo = Math.max(lo, down(o.lo))
    else if (rel === 'eq') { lo = Math.max(lo, down(o.lo)); hi = Math.min(hi, up(o.hi)) }
    else if (rel === 'ne') {
      if (!x || !whole || o.lo !== o.hi) return
      if (lo === o.lo) lo++
      if (hi === o.lo) hi--
      if (lo <= hi) bind(env, name, { lo, hi, int: x.int, nz: x.nz && lo <= 0 && hi >= 0, nan: x.nan })
      return
    }
    if (!(lo <= hi)) return
    // A comparison that holds has numbers on both sides: NaN fails it, and a
    // box is a NaN.
    bind(env, name, { lo, hi, int: whole, nz: (x ? x.nz : floats) && lo <= 0 && hi >= 0, nan: false })
  }
  const refine = (c, truth, env) => {
    if (!isArr(c)) return
    const op = c[0]
    if (op === 'i32.eqz') return refine(c.find(isArr), !truth, env)
    if ((op === 'i32.and' && truth) || (op === 'i32.or' && !truth)) { for (const k of c) if (isArr(k)) refine(k, truth, env); return }
    if ((op === 'local.get' || op === 'local.tee') && types.get(c[1]) === 'i32') {
      bound(env, c[1], truth ? 'ne' : 'eq', { lo: 0, hi: 0 }, false)
      return
    }
    const [p, q] = c.filter(isArr)
    const a = seenAt.get(p) ?? null, b = seenAt.get(q) ?? null
    const x = readName(p), y = readName(q)
    const floats = op in F64_CMP
    const back = (op === 'f64.eq' || op === 'f64.ne') && x != null ? readBack(q, x) : null
    if (back) {
      // (where it fails the value is a box, a NaN, or a number the way back does not hold)
      if (truth !== (op === 'f64.eq')) return
      const v = boundOf(env, x)
      if (v && none(v)) return
      if (back === 'self') { bind(env, x, v ? { lo: v.lo, hi: v.hi, int: v.int, nz: v.nz, nan: false } : { lo: -Infinity, hi: Infinity, int: false, nz: true, nan: false }); return }
      const lo = Math.max(v ? Math.ceil(v.lo) : -Infinity, BACK[back][0]), hi = Math.min(v ? Math.floor(v.hi) : Infinity, BACK[back][1])
      if (lo <= hi) bind(env, x, { lo, hi, int: true, nz: (v ? v.nz : true) && lo <= 0 && hi >= 0, nan: false })
      return
    }
    let rel = F64_CMP[op] ?? INT_CMP[op]
    if (rel == null) {
      rel = UNSIGNED_CMP[op]
      if (rel == null || !truth) return
      // `x <u n` with n non-negative holds for 0 ≤ x < n alone.
      if ((rel === 'lt' || rel === 'le') && x && b && b.lo >= 0) { bound(env, x, 'ge', { lo: 0, hi: 0 }, false); bound(env, x, rel, b, false) }
      if ((rel === 'gt' || rel === 'ge') && y && a && a.lo >= 0) { bound(env, y, 'ge', { lo: 0, hi: 0 }, false); bound(env, y, FLIP[rel], a, false) }
      return
    }
    // Where an f64 test fails, either operand may be NaN: only numbers that
    // are none turn the failure into the opposite test.
    if (floats && (truth ? rel === 'ne' : rel !== 'ne') && !(real(a) && real(b))) return
    if (!truth) rel = NOT[rel]
    if (x && b && !none(b)) bound(env, x, rel, b, floats)
    if (y && a && !none(a)) bound(env, y, FLIP[rel], a, floats)
  }

  const answer = t => val(t, t)
  const decide = (rel, a, b) => {
    if (!real(a) || !real(b)) return BOOL
    const one = a.lo === a.hi && b.lo === b.hi && a.lo === b.lo, apart = a.hi < b.lo || a.lo > b.hi
    const t = rel === 'eq' ? (one ? 1 : apart ? 0 : null)
      : rel === 'ne' ? (one ? 0 : apart ? 1 : null)
      : rel === 'lt' ? (a.hi < b.lo ? 1 : a.lo >= b.hi ? 0 : null)
      : rel === 'le' ? (a.hi <= b.lo ? 1 : a.lo > b.hi ? 0 : null)
      : rel === 'gt' ? (a.lo > b.hi ? 1 : a.hi <= b.lo ? 0 : null)
      : (a.lo >= b.hi ? 1 : a.hi < b.lo ? 0 : null)
    return t == null ? BOOL : answer(t)
  }

  const seq = (list, st) => {
    let last = null
    for (const s of list) { if (!st.env) return null; last = ev(s, st) }
    return st.env ? last : null
  }
  const exitTo = (name, st, value) => {
    const f = frameOf(name)
    if (!f || !st.env) return
    if (f.loop) f.backs.push(st.env)
    else { f.exits.push(st.env); f.values.push(value) }
  }

  const ev = (n, st) => {
    if (abort || !st.env || !isArr(n)) return null
    stack.push(n)
    try { return note(n, visit(n, st)) } finally { stack.pop() }
  }
  const args = (n, st, from = 1) => { const out = []; for (let i = from; i < n.length; i++) out.push(isArr(n[i]) ? ev(n[i], st) : null); return out }
  const given = (n, st) => {
    if (assume?.has(n)) for (const [k, v] of assume.get(n)) bind(st.env, k, v)
  }
  const starts = (n, st) => {
    if (provisional || !regions?.has(n)) return
    const here = fork(st.env)
    entry.set(n, entry.has(n) ? joinEnv(entry.get(n), here) : here)
  }

  const visit = (n, st) => {
    const op = n[0]
    given(n, st)
    starts(n, st)
    if (op === 'local.get') {
      if (typeof n[1] !== 'string') { abort = true; return null }
      if (!provisional && tracked(n[1])) (reads.get(n[1]) ?? reads.set(n[1], []).get(n[1])).push([n, stack.slice(0, -1)])
      return boundOf(st.env, n[1])
    }
    if (op === 'local.set' || op === 'local.tee') {
      if (typeof n[1] !== 'string') { abort = true; return null }
      // (the value is the operand; one taken from the stack is any value)
      let v = null
      for (let i = 2; i < n.length; i++) if (isArr(n[i])) v = i === 2 && n.length === 3 ? ev(n[i], st) : (ev(n[i], st), null)
      if (!st.env) return null
      if (tracked(n[1])) {
        bind(st.env, n[1], v)
        if (!provisional) {
          const ws = writes.get(n[1]) ?? writes.set(n[1], []).get(n[1])
          if (!ws.includes(n)) { ws.push(n); loops.set(n, stack.reduce((d, p) => d + (p[0] === 'loop'), 0)) }
          if (op === 'local.tee') (reads.get(n[1]) ?? reads.set(n[1], []).get(n[1])).push([n, stack.slice(0, -1)])
        }
      }
      return op === 'local.tee' ? v : null
    }
    if (op === 'f64.const' || op === 'i32.const' || op === 'i64.const') {
      if (op === 'f64.const' && plainNaN(n)) return NAN
      const c = constValue(n)
      if (c == null || Number.isNaN(c)) return null
      return Number.isFinite(c) ? exact(op === 'i32.const' ? c | 0 : c) : val(c, c, false)
    }
    if (op === 'block' || op === 'loop') return region(n, st)
    if (op === 'if') return branch(n, st)
    if (op === 'br') {
      const value = n.find(isArr), v = value ? ev(value, st) : null
      exitTo(n[1], st, v)
      st.env = null
      return null
    }
    if (op === 'br_if') {
      const parts = n.filter(isArr), c = parts[parts.length - 1]
      const v = parts.length > 1 ? ev(parts[0], st) : null
      const t = ev(c, st)
      if (!st.env) return null
      const here = st.env
      if (!(t && t.hi === 0)) { const taken = { env: fork(here) }; refine(c, true, taken.env); exitTo(n[1], taken, v) }
      if (t && t.lo >= 1) { st.env = null; return null }
      st.env = fork(here)
      refine(c, false, st.env)
      return v
    }
    if (op === 'br_table') {
      for (let i = 1; i < n.length; i++) if (isArr(n[i])) ev(n[i], st)
      for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string') exitTo(n[i], st, null)
      st.env = null
      return null
    }
    if (op === 'try' || op === 'try_table' || op === 'catch' || op === 'catch_all' || op === 'delegate') { abort = true; return null }
    if (LEAVES.has(op)) { args(n, st); st.env = null; return null }
    if (op === 'select' && n.length === 4) {
      const a = ev(n[1], st), b = ev(n[2], st), c = ev(n[3], st)
      return c && c.lo === c.hi ? (c.lo ? a : b) : hull(a, b)
    }
    // The operands are the children that are nodes: a memory argument, or a
    // comment a kernel written as text keeps, is none.
    const kids = n.filter(isArr), vs = []
    for (const k of kids) vs.push(ev(k, st))
    if (!st.env) return null
    if (FITS[op] && kids.length === 2) { const el = rootAt(kids[0]); if (el) stored(el, vs[1], FITS[op]) }
    else if (op === 'memory.fill' && kids.length === 3) { const el = rootAt(kids[0]); if (el && !el.unknown) { const b = vs[1]; if (b && b.lo === b.hi && (b.lo & 255) === 0) {} else if (b && b.lo === b.hi && (b.lo & 255) === 255) { if (!el.ones) { el.ones = true; elementsMoved = true } } else { el.unknown = true; elementsMoved = true } } }
    for (let i = 0; i < kids.length; i++) seenAt.set(kids[i], vs[i])
    const r = kids.length === n.length - 1 ? remainderOf(n) : null
    if (r) {
      const v = seenAt.get(r.x) ?? null, m = Math.abs(r.k) - 1
      return isInt(v) ? val(v.lo < 0 ? -Math.min(m, -v.lo) : 0, v.hi > 0 ? Math.min(m, v.hi) : 0, true, v.lo < 0 || v.nz) : v ? NUMBER : null
    }
    return value(n, op, vs[0], vs[1], kids[0], kids[1])
  }

  // A sum or a product of numbers is a number; of reals within bounds, a real.
  const arith = (lo, hi, a, b, nz) => Number.isNaN(lo) || Number.isNaN(hi) ? NUMBER
    : { lo, hi, int: a.int && b.int, nz, nan: a.nan || b.nan || ((unbounded(a) || unbounded(b)) && !(a.int && b.int)) }

  // The interval of an operator over the intervals of its operands.
  const value = (n, op, a, b, x, y) => {
    switch (op) {
      case 'f64.convert_i32_s': case 'i64.extend_i32_s': return word(a) ?? I32
      case 'f64.convert_i32_u': case 'i64.extend_i32_u': return word(a) && a.lo >= 0 ? a : val(0, 2 ** 32 - 1)
      case 'f64.convert_i64_s': return word(a)
      case 'f64.promote_f32': return NUMBER
      case 'i64.reinterpret_f64': return bitsOf(a?.of ? null : a)
      case 'f64.reinterpret_i64': return a?.of && a.mask == null ? a.of : null
      case 'i64.and': {
        const m = constBits(y) ?? constBits(x), v = constBits(y) != null ? a : b
        return v?.of && m != null && (m & EXPONENT) === EXPONENT ? bitsOf(v.of, v.mask == null ? m : v.mask & m) : null
      }
      // An f64 slot holds any value, boxes included: an element of an array, a
      // field. A Float64Array's element is a number where its read says so
      // (the emitter's mark on a read it proved, a specialized loop's on one
      // it tests).
      case 'f64.load': return n.presentNumRead || n.numberRead ? NUMBER : null
      case 'i32.wrap_i64': return fitsI32(a) ? a : I32
      case 'i64.trunc_sat_f64_s': return !a ? null : none(a) ? answer(0) : val(Math.min(Math.trunc(a.lo), a.nan ? 0 : Infinity), Math.max(Math.trunc(a.hi), a.nan ? 0 : -Infinity))
      case 'i32.trunc_sat_f64_s': return !a ? I32 : none(a) ? answer(0)
        : val(Math.max(I32.lo, Math.min(Math.trunc(a.lo), a.nan ? 0 : Infinity)), Math.min(I32.hi, Math.max(Math.trunc(a.hi), a.nan ? 0 : -Infinity)))
      case 'i32.trunc_sat_f64_u': return real(a) && a.lo >= 0 && a.hi <= I32.hi ? val(Math.trunc(a.lo), Math.trunc(a.hi)) : I32
      case 'f64.add': case 'f64.sub': case 'i64.add': case 'i64.sub': {
        if (!a || !b) return null
        if (none(a) || none(b)) return NAN
        const sub = op.endsWith('sub')
        const lo = sub ? a.lo - b.hi : a.lo + b.lo, hi = sub ? a.hi - b.lo : a.hi + b.hi
        if (op[0] === 'i' && !(lo >= -LIMIT && hi <= LIMIT)) return null
        // -0 + -0, and -0 - 0, are the sums that give -0.
        return arith(lo, hi, a, b, sub ? a.nz && b.lo <= 0 && b.hi >= 0 : a.nz && b.nz)
      }
      case 'f64.mul': case 'i64.mul': {
        if (!a || !b) return null
        if (none(a) || none(b)) return NAN
        const p = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi]
        if (p.some(Number.isNaN)) return NUMBER
        const lo = Math.min(...p), hi = Math.max(...p)
        if (op[0] === 'i' && !(lo >= -LIMIT && hi <= LIMIT)) return null
        // A product past every double is an infinity, which is no integer.
        if (!(lo >= -(2 ** 500) && hi <= 2 ** 500)) return { ...NUMBER, nan: a.nan || b.nan || unbounded(a) || unbounded(b) }
        const zero = v => v.lo <= 0 && v.hi >= 0
        return arith(lo, hi, a, b, a.nz || b.nz || (zero(a) && b.lo < 0) || (zero(b) && a.lo < 0))
      }
      case 'f64.div': {
        const k = numConst(y)
        if (!a || !b) return null
        if (k == null || k === 0 || !Number.isFinite(k) || none(a)) return NUMBER
        const p = [a.lo / k, a.hi / k]
        return val(Math.min(...p), Math.max(...p), false, a.nz || (a.lo <= 0 && a.hi >= 0), a.nan)
      }
      case 'f64.neg': return a && (none(a) ? NAN : val(-a.hi, -a.lo, a.int, a.lo <= 0 && a.hi >= 0, a.nan))
      case 'f64.abs': return a && (none(a) ? NAN : val(a.lo > 0 ? a.lo : a.hi < 0 ? -a.hi : 0, Math.max(-a.lo, a.hi), a.int, false, a.nan))
      case 'f64.min': return a && b && (none(a) || none(b) ? NAN : val(Math.min(a.lo, b.lo), Math.min(a.hi, b.hi), a.int && b.int, a.nz || b.nz, a.nan || b.nan))
      case 'f64.max': return a && b && (none(a) || none(b) ? NAN : val(Math.max(a.lo, b.lo), Math.max(a.hi, b.hi), a.int && b.int, a.nz || b.nz, a.nan || b.nan))
      case 'f64.sqrt': return a && (a.hi < 0 || none(a) ? NAN : val(Math.sqrt(Math.max(0, a.lo)), Math.sqrt(a.hi), false, a.nz, a.nan || a.lo < 0))
      case 'f64.copysign': return a && b ? NUMBER : null
      case 'f64.floor': return a && (none(a) ? NAN : val(Math.floor(a.lo), Math.floor(a.hi), true, a.int ? a.nz : a.lo <= 0 && a.hi >= 0, a.nan))
      case 'f64.ceil': return a && (none(a) ? NAN : val(Math.ceil(a.lo), Math.ceil(a.hi), true, a.int ? a.nz : a.lo <= 0 && a.hi > -1, a.nan))
      case 'f64.trunc': return a && (none(a) ? NAN : val(Math.trunc(a.lo), Math.trunc(a.hi), true, a.int ? a.nz : a.lo <= 0 && a.hi > -1, a.nan))
      case 'f64.nearest': return a && (none(a) ? NAN : val(Math.floor(a.lo), Math.ceil(a.hi), true, a.int ? a.nz : a.lo <= 0 && a.hi >= -0.5, a.nan))
      case 'i32.add': case 'i32.sub': case 'i32.mul': {
        if (!a || !b) return n.irange ? val(n.irange[0], n.irange[1]) : I32
        const p = op === 'i32.add' ? [a.lo + b.lo, a.hi + b.hi] : op === 'i32.sub' ? [a.lo - b.hi, a.hi - b.lo]
          : [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi]
        const lo = Math.min(...p), hi = Math.max(...p)
        return lo >= I32.lo && hi <= I32.hi ? val(lo, hi) : I32
      }
      case 'i32.and': {
        const ha = a && a.lo >= 0 ? a.hi : Infinity, hb = b && b.lo >= 0 ? b.hi : Infinity
        return Math.min(ha, hb) === Infinity ? I32 : val(0, Math.min(ha, hb))
      }
      case 'i32.shr_u': {
        const k = numConst(y)
        // (by a count that is not known: anything from the value down to zero)
        if (k == null) return a && a.lo >= 0 ? val(0, a.hi) : I32
        if ((k & 31) === 0) return a && a.lo >= 0 ? a : I32
        return a && a.lo >= 0 ? val(Math.floor(a.lo / 2 ** (k & 31)), Math.floor(a.hi / 2 ** (k & 31))) : val(0, 2 ** (32 - (k & 31)) - 1)
      }
      case 'i32.shr_s': {
        const k = numConst(y), v = a ?? I32
        return k == null ? I32 : val(Math.floor(v.lo / 2 ** (k & 31)), Math.floor(v.hi / 2 ** (k & 31)))
      }
      case 'i32.shl': {
        const k = numConst(y)
        if (!a || k == null) return I32
        const lo = a.lo * 2 ** (k & 31), hi = a.hi * 2 ** (k & 31)
        return lo >= I32.lo && hi <= I32.hi ? val(lo, hi) : I32
      }
      case 'i32.rem_s': case 'i64.rem_s': {
        const k = numConst(y)
        if (k == null || k === 0) return op === 'i32.rem_s' ? I32 : null
        const m = Math.abs(k) - 1, v = a ?? (op === 'i32.rem_s' ? I32 : null)
        return v ? val(v.lo < 0 ? -Math.min(m, -v.lo) : 0, v.hi > 0 ? Math.min(m, v.hi) : 0) : val(-m, m)
      }
      case 'i32.div_s': case 'i64.div_s': {
        const k = numConst(y), v = a ?? (op === 'i32.div_s' ? I32 : null)
        if (k == null || k === 0 || k === -1 || !v) return op === 'i32.div_s' ? I32 : null
        const p = [Math.trunc(v.lo / k), Math.trunc(v.hi / k)]
        return val(Math.min(...p), Math.max(...p))
      }
      case 'i32.load': return loaded(rootAt(x), op)
      case 'i32.load8_u': return loaded(rootAt(x), op) ?? val(0, 255)
      case 'i32.load8_s': return loaded(rootAt(x), op) ?? val(-128, 127)
      case 'i32.load16_u': return loaded(rootAt(x), op) ?? val(0, 65535)
      case 'i32.load16_s': return loaded(rootAt(x), op) ?? val(-32768, 32767)
      case 'i32.eqz': return a && (a.lo > 0 || a.hi < 0) ? answer(0) : a && a.lo === 0 && a.hi === 0 ? answer(1) : BOOL
      case 'i32.popcnt': case 'i32.clz': case 'i32.ctz': return val(0, 32)
    }
    if (op in F64_CMP) {
      // A number that is never NaN equals itself, an integer its truncation:
      // the tests of what kind of value it is.
      const back = (op === 'f64.eq' || op === 'f64.ne') && readName(x) != null ? readBack(y, readName(x)) : null
      if (back) {
        const holds = back === 'self' ? real(a) : real(a) && a.int && a.lo >= BACK[back][0] && a.hi <= BACK[back][1] && (back === 'whole' || !unbounded(a))
        return holds ? answer(op === 'f64.eq' ? 1 : 0) : BOOL
      }
      return decide(F64_CMP[op], a, b)
    }
    if (op === 'i64.eq' || op === 'i64.ne') {
      // A number's bits are no box's: the test for a boxed value fails.
      const box = constBits(y) ?? constBits(x), v = constBits(y) != null ? a : constBits(x) != null ? b : null
      if (v?.of) return boxBits(box) && (v.mask == null || (box & v.mask) === box) ? answer(op === 'i64.eq' ? 0 : 1) : BOOL
      if (a?.of || b?.of) return BOOL
    }
    if (op in INT_CMP) return a?.of || b?.of ? BOOL : decide(INT_CMP[op], a, b)
    if (op in UNSIGNED_CMP) return a && b && !a.of && !b.of && a.lo >= 0 && b.lo >= 0 ? decide(UNSIGNED_CMP[op], a, b) : BOOL
    if (n.irange) return val(n.irange[0], n.irange[1])
    // A number is no string key, no missing value and no object; two values
    // are equal or they are not.
    if (op === 'call' && typeof n[1] === 'string' && KIND.test(n[1])) return a?.of && a.mask == null ? answer(0) : BOOL
    if (op === 'call' && n[1] === '$__eq_strict') return BOOL
    return null
  }

  const region = (n, st) => {
    let i = 1, name = null
    if (typeof n[i] === 'string') name = n[i++]
    while (isArr(n[i]) && (n[i][0] === 'result' || n[i][0] === 'param' || n[i][0] === 'type')) i++
    const body = n.slice(i)
    if (n[0] === 'block') {
      const frame = { name, loop: false, exits: [], values: [] }
      labels.push(frame)
      let v = seq(body, st)
      labels.pop()
      let reached = !!st.env
      for (let k = 0; k < frame.exits.length; k++) {
        st.env = joinEnv(st.env, frame.exits[k])
        v = reached ? hull(v, frame.values[k]) : frame.values[k]
        reached = true
      }
      return v
    }
    // One head per loop, kept across the walks of the function: the hull of
    // what enters and what its back edges carried on the walk before.
    const entering = joinEnv(st.env, backs.get(n) ?? null)
    let head = heads.get(n)
    if (phase === 'up') {
      if (!head) { head = entering; moved = true }
      else if (!envWithin(entering, head)) { head = round > 2 ? widen(head, entering, open()) : joinEnv(head, entering); moved = true }
    } else if (phase === 'down' && head && envWithin(entering, head)) head = entering
    else if (!head) head = entering
    heads.set(n, head)
    const frame = { name, loop: true, backs: [] }
    labels.push(frame)
    const inner = { env: fork(head) }
    const v = seq(body, inner)
    labels.pop()
    let back = null
    for (const b of frame.backs) back = joinEnv(back, b)
    backs.set(n, back)
    st.env = inner.env
    return v
  }

  const branch = (n, st) => {
    const { test: c, then, otherwise } = conditional(n)
    const t = ev(c, st)
    if (!st.env) return null
    const arm = (a, truth) => {
      if (t && (truth ? t.hi === 0 : t.lo >= 1)) return { env: null, v: null }
      const s = { env: fork(st.env) }
      refine(c, truth, s.env)
      if (a == null) return { env: s.env, v: null }
      stack.push(a)
      try {
        given(a, s)
        const v = a[0] === 'then' || a[0] === 'else' ? seq(a.slice(1), s) : ev(a, s)
        return { env: s.env, v }
      } finally { stack.pop() }
    }
    const yes = arm(then, true), no = arm(otherwise, false)
    st.env = joinEnv(yes.env, no.env)
    return !yes.env ? no.v : !no.env ? yes.v : hull(yes.v, no.v)
  }

  const env = envOf(new Map())
  let openSlots = null
  const open = () => { if (!openSlots) { openSlots = new Set(); for (const [name, i] of env.index) if (cyclic.has(name)) openSlots.add(i) } return openSlots }
  for (const [name, type] of types) if (type === 'f64' || type === 'i32' || type === 'i64') bind(env, name, params.has(name) ? null : exact(0))
  const body = fn.slice(bodyStart)
  const walk = () => seq(body, { env: fork(env) })
  // Up: heads grow until a walk moves none (a bound still moving after two
  // walks widens). Down: two walks take back what the loops' tests bound.
  // Then the walk that records.
  provisional = 1
  for (round = 0, moved = true; moved && !abort; round++) {
    if (round > 24) return null
    moved = false
    elementsMoved = false
    walk()
    if (elementsMoved) moved = true
  }
  phase = 'down'
  for (let k = 0; k < 2 && !abort; k++) walk()
  phase = 'last'
  provisional = 0
  walk()
  return abort ? null : { av, types, params, writes, reads, loops, entry }
}
