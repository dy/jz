// Loops specialized on what their values hold.
//
// A typed element read that may miss yields the element or `undefined`, so
// every value it reaches is a number or a box: it stays an f64, its index
// converts through a box test, and an integer it holds never reaches an
// integer register. An engine that watches the program run compiles the loop
// for the values it saw and leaves that code when another value appears.
// Ahead of time the same loop is compiled twice: a copy for reads that hit and
// integers that are integers, and the loop as written for everything else.
//
//   (block $done
//     (block $brk                              the loop's own exit, as written
//       (block $go
//           (block $slow
//             (block $at2
//               (block $at1
//                 (br_if $slow ¬(each integer the copy assumes is one))
//                 entry: the copy's own locals take the values of the ones it renames
//                 COPY: a read that may miss leaves where it would
//                         (br_if $at1 ¬in-bounds), then loads
//                 exit: the renamed locals give their values back
//                 (br $done))
//               the renamed locals that statement 1 finds live give their values back
//               (local.set $from 1) (br $go))
//             the same for statement 2
//             (local.set $from 2) (br $go))
//           what the loop as written computes ahead of itself)
//       (loop                                  the loop as written, which
//         (local.set $at (local.get $from))    starts at the statement `$from` names
//         (local.set $from 0)
//         (block $in2
//           (block $in1
//             (block $in0 (br_table $in1 $in2 $in0 (at - 1)))
//             its statements up to the first one a read left from)
//           up to the second)
//         the rest)))
//
// A read leaves to a statement of the loop as written that every way to the
// read passes, with no store and no call between the two: the first of the
// stretch the read is in. The loop as written runs again from there, on the
// memory the copy left and on the locals as they stood there: a local the
// stretch read and then wrote is put back from a copy taken where the stretch
// starts, one it wrote first is written again. A block or a conditional that
// holds the statement is entered at it: a block jumps past the statements
// before, a conditional takes the arm without its test.
//
// A conditional that tests what kind of value a local holds (a number, an
// integer, a box) and calls the runtime in the arm a number does not take is
// the same case: the copy leaves where that arm would run. So is the checked
// twin of a loop the emitter versioned on its extents.
//
// The copy's locals are its own, so the integer pass (int-narrow.js) types
// them by the copy's values alone. A copy that narrows nothing is dropped.
//
// Runs where a versioned loop may keep its original beside it (speed tiers).

import { integerPlan } from './int-narrow.js'
import { plainNaN, conditional, boundOf, boxBits, constBits, LIMIT } from './int-range.js'
import { pureKernel } from './pure-funcs.js'

const isArr = Array.isArray
const isLabel = s => typeof s === 'string' && s[0] === '$'
const marks = n => { const m = {}; for (const k of Object.keys(n)) if (!/^\d+$/.test(k)) m[k] = n[k]; return m }
const clone = n => isArr(n) ? Object.assign(n.map(clone), marks(n)) : n
const size = n => isArr(n) ? 1 + n.reduce((s, c) => s + size(c), 0) : 0
// A copy of a local made where a read leaves: it runs once, whatever loop is
// around it, and the integer pass weighs it so (int-narrow.js).
const once = (to, from) => Object.assign(['local.set', to, Object.assign(['local.get', from], { cold: true })], { cold: true })
const ASSUMED = LIMIT / 2   // the magnitude an assumed integer is tested for
const SMALL = 12, PLAIN = 32, LARGE = 24000

const STORE = /\.store|^memory\.|^table\.|^atomic|^global\.set$/
const LEAVES = new Set(['return', 'unreachable', 'throw', 'throw_ref', 'rethrow', 'return_call', 'return_call_indirect', 'return_call_ref'])
// A call that writes nothing the loop as written could read differently: the
// math kernels, the integer conversion, the tests of a value's kind, an
// allocation (the block it bumped is unreachable).
const quiet = name => pureKernel(name) || name === '$__to_int32' || name === '$__rem' || /^\$__(alloc|mkptr|is_)/.test(name)
const calls = n => n[0] === 'call' || n[0] === 'return_call' ? !(typeof n[1] === 'string' && quiet(n[1])) : n[0] === 'call_indirect' || n[0] === 'call_ref'
const typed = n => n.some(c => isArr(c) && (c[0] === 'result' || c[0] === 'param'))
const writesMemory = n => isArr(n) && (STORE.test(n[0]) || calls(n) || n.some(writesMemory))

const nanConst = n => isArr(n) && n[0] === 'f64.const' && (plainNaN(n) || (typeof n[1] === 'number' && Number.isNaN(n[1])) || (typeof n[1] === 'string' && /^[-+]?nan/.test(n[1])))
const zeroConst = n => isArr(n) && n[0] === 'i32.const' && Number(n[1]) === 0
const LOADS = /^(f64\.load|f32\.load|i32\.load|i64\.load)/
// A Number normalized on its way into a generic slot (ir/sentinels.js
// canonicalNumberIR): `(block (result f64) (local.set $t V) (select nan $t ($t != $t)))`. The value V, or null.
const canonOf = n => isArr(n) && n[0] === 'block' && n.length === 4 && n[1]?.[0] === 'result' && n[1][1] === 'f64' &&
  n[2]?.[0] === 'local.set' && n[3]?.[0] === 'select' && n[3][1]?.[0] === 'f64.const' && n[3][1][1] === 'nan' &&
  n[3][2]?.[0] === 'local.get' && n[3][2][1] === n[2][1] && n[3][3]?.[0] === 'f64.ne' ? n[2][2] : null
const loads = n => isArr(n) && (LOADS.test(n[0]) || ((n[0] === 'f64.convert_i32_s' || n[0] === 'f64.convert_i32_u' || n[0] === 'f64.promote_f32') && loads(n[1])) ||
  loads(canonOf(n)))
const wordLoad = n => isArr(n) && /^i32\.load/.test(n[0])
// The clamp of a checked read's address: `select(index, 0, valid)`.
const clampOf = (n, valid) => isArr(n) && n[0] === 'select' && n.length === 4 && n[2]?.[0] === 'i32.const' && Number(n[2][1]) === 0 &&
  n[3]?.[0] === 'local.get' && n[3][1] === valid
const hasClamp = (n, valid) => isArr(n) && (clampOf(n, valid) || n.some(c => hasClamp(c, valid)))
const unclamp = (n, valid) => !isArr(n) ? n : clampOf(n, valid) ? n[1] : Object.assign(n.map(c => unclamp(c, valid)), marks(n))
/** A read that may miss: the element or what a miss reads as (a NaN, a
 *  number's or the undefined box; zero where its reader truncates), selected
 *  by its bounds test. Returns { type, valid } (the test's local), { type,
 *  test } (the test itself, of the branch form), or null. */
const checkedRead = n => {
  if (!isArr(n)) return null
  if (n[0] === 'select' && n.length === 4 && n[3]?.[0] === 'local.get' && typeof n[3][1] === 'string' && hasClamp(n[1], n[3][1])) {
    if (nanConst(n[2]) && loads(n[1])) return { type: 'f64', valid: n[3][1] }
    if (zeroConst(n[2]) && wordLoad(n[1])) return { type: 'i32', valid: n[3][1] }
    return null
  }
  if (n[0] === 'if' && n.length === 5 && n[1]?.[0] === 'result' && n[3]?.[0] === 'then' && n[3].length === 2 &&
      n[4]?.[0] === 'else' && n[4].length === 2 && !writesMemory(n[2])) {
    if (n[1][1] === 'f64' && nanConst(n[4][1]) && loads(n[3][1])) return { type: 'f64', test: n[2] }
    if (n[1][1] === 'i32' && zeroConst(n[4][1]) && wordLoad(n[3][1]) && n[2]?.[0] === 'i32.lt_u') return { type: 'i32', test: n[2] }
  }
  return null
}

// A test of what kind of value a local holds, by what it answers for a number
// that is an integer: a number equals itself and its own truncation, its bits
// are no box's and no key's. Null for a test of anything else.
const readOf = n => isArr(n) && (n[0] === 'local.get' || n[0] === 'local.tee') && typeof n[1] === 'string' ? n[1] : null
const BACK = new Set(['f64.trunc', 'f64.convert_i32_s', 'f64.convert_i32_u', 'f64.convert_i64_s', 'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u', 'i64.trunc_sat_f64_s', 'i32.wrap_i64'])
const EXPONENT = 0x7FF0000000000000n
// The local whose bits these are, where a mask keeps the bits `of` is made of.
const bitsOf = (n, of) => {
  if (isArr(n) && n[0] === 'i64.and' && n.length === 3) {
    const mask = constBits(n[2])
    if (mask == null || (of != null && ((mask & EXPONENT) !== EXPONENT || (of & mask) !== of))) return null
    n = n[1]
  }
  if (isArr(n) && n[0] === 'i64.reinterpret_f64' && n.length === 2) n = n[1]
  return readOf(n)
}
const forNumber = n => {
  if (!isArr(n)) return null
  const op = n[0]
  if (op === 'i32.eqz') { const t = n.length === 2 ? forNumber(n[1]) : null; return t == null ? null : 1 - t }
  if (op === 'i32.and' || op === 'i32.or') {
    if (n.length !== 3) return null
    const a = forNumber(n[1]), b = forNumber(n[2]), stop = op === 'i32.and' ? 0 : 1
    return a === stop || b === stop ? stop : a == null || b == null ? null : 1 - stop
  }
  if (op === 'f64.eq' || op === 'f64.ne') {
    const x = readOf(n[1])
    if (n.length !== 3 || x == null) return null
    let y = n[2]
    while (isArr(y) && (y[0] === 'local.tee' ? y.length === 3 : y.length === 2 && BACK.has(y[0]))) y = y[y.length - 1]
    return readOf(y) !== x ? null : op === 'f64.eq' ? 1 : 0
  }
  if (op === 'i64.eq' || op === 'i64.ne') {
    if (n.length !== 3) return null
    const box = constBits(n[2]) ?? constBits(n[1]), of = constBits(n[2]) != null ? n[1] : n[2]
    return boxBits(box) && bitsOf(of, box) != null ? (op === 'i64.eq' ? 0 : 1) : null
  }
  if (op === 'call') return n.length === 3 && /^\$__is_(str_key|nullish|null|object)$/.test(n[1]) && bitsOf(n[2], null) != null ? 0 : null
  return null
}
// Whether the arm calls the runtime where it runs: a call under a conditional
// of its own is that conditional's.
const runtime = n => (n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string' && n[1].startsWith('$__') && !quiet(n[1])
const callsOut = n => isArr(n) && (runtime(n) || n.some(c => isArr(c) && (c[0] === 'if' ? callsOut(conditional(c).test) : callsOut(c))))

const hasLoop = n => isArr(n) && (n[0] === 'loop' || n.some(hasLoop))
const loopCount = n => isArr(n) ? (n[0] === 'loop' ? 1 : 0) + n.reduce((k, c) => k + loopCount(c), 0) : 0
/** The loops of `node` that no other loop of it contains, each with the block
 *  that holds its hoisted values when it has one: { region, holder, at, loop }. */
const loopsOf = (node) => {
  const out = []
  const walk = (n) => {
    if (!isArr(n)) return
    // A loop versioned on its extents keeps its checked twin in the other
    // arm: the same nest, entered when the test fails. It stays as it is.
    const twin = n[0] === 'if' ? n.find(c => isArr(c) && c[0] === 'else') : null
    const kept = twin && n.find(c => isArr(c) && c[0] === 'then')
    const cold = twin && kept && loopCount(twin) > 0 && loopCount(twin) === loopCount(kept) ? twin : null
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (!isArr(c) || c === cold || c.checkedTwin === true) continue   // (the emitter's own mark, compile/emit/control-flow.js)
      if (c[0] === 'loop') { out.push({ region: c, holder: n, at: i, loop: c }); continue }
      if (c[0] === 'block' && isLabel(c[1]) && !typed(c) &&
          isArr(c[c.length - 1]) && c[c.length - 1][0] === 'loop' && !c.slice(2, -1).some(hasLoop)) {
        out.push({ region: c, holder: n, at: i, loop: c[c.length - 1] })
        continue
      }
      walk(c)
    }
  }
  walk(node)
  return out
}

/** The statements of a loop, a block or an arm: what a read can leave to. A
 *  block that only groups them and a conditional's arms hold their own; a
 *  loop inside is one statement. */
const statementsOf = (list, start, out = []) => {
  for (let i = start; i < list.length; i++) {
    const x = list[i]
    if (!isArr(x) || x[0] === 'loop') continue
    if (x[0] === 'block' && !typed(x)) { statementsOf(x, isLabel(x[1]) ? 2 : 1, out); continue }
    out.push(x)
    if (x[0] === 'if' && !typed(x)) for (const arm of x) if (isArr(arm) && (arm[0] === 'then' || arm[0] === 'else')) statementsOf(arm, 1, out)
  }
  return out
}

/** Which locals are live where each of `targets` starts (`in`) and ends
 *  (`out`): read later on some path before they are written. One backward
 *  walk of the function; a loop's head settles in a few rounds. */
const liveness = (fn, bodyStart, targets) => {
  const found = new Map()
  const frames = []
  const EMPTY = new Set()
  const add = (s, x) => s.has(x) ? s : new Set(s).add(x)
  const drop = (s, x) => { if (!s.has(x)) return s; const t = new Set(s); t.delete(x); return t }
  const union = (a, b) => { if (a === b || !b.size) return a; if (!a.size) return b; let t = a; for (const x of b) if (!t.has(x)) { if (t === a) t = new Set(a); t.add(x) } return t }
  const within = (a, b) => { for (const x of a) if (!b.has(x)) return false; return true }
  const at = name => { for (let i = frames.length - 1; i >= 0; i--) if (frames[i].name === name) return frames[i].live; return EMPTY }
  const seq = (n, from, out) => { for (let i = n.length - 1; i >= from; i--) out = live(n[i], out); return out }
  const live = (n, out) => {
    if (!isArr(n)) return out
    const op = n[0]
    let res
    if (op === 'local.get') res = add(out, n[1])
    else if (op === 'local.set' || op === 'local.tee') res = live(n[2], drop(out, n[1]))
    else if (op === 'block') {
      frames.push({ name: isLabel(n[1]) ? n[1] : null, live: out })
      res = seq(n, 1, out)
      frames.pop()
    } else if (op === 'loop') {
      let head = EMPTY
      for (;;) {
        frames.push({ name: isLabel(n[1]) ? n[1] : null, live: head })
        res = seq(n, 1, out)
        frames.pop()
        if (within(res, head)) break
        head = union(head, res)
      }
    } else if (op === 'if') {
      const { test, then, otherwise } = conditional(n)
      frames.push({ name: isLabel(n[1]) ? n[1] : null, live: out })
      const arm = x => !x ? out : x[0] === 'then' || x[0] === 'else' ? seq(x, 1, out) : live(x, out)
      const a = arm(then), b = arm(otherwise)
      frames.pop()
      res = live(test, union(a, b))
    } else if (op === 'br') res = seq(n, 2, at(n[1]))
    else if (op === 'br_if') res = seq(n, 2, union(at(n[1]), out))
    else if (op === 'br_table') {
      let t = EMPTY
      for (let i = 1; i < n.length; i++) if (!isArr(n[i])) t = union(t, at(n[i]))
      res = seq(n, 1, t)
    } else if (LEAVES.has(op)) res = seq(n, 1, EMPTY)
    else res = seq(n, 1, out)
    if (targets.has(n)) {
      const f = found.get(n)
      found.set(n, f ? { in: union(f.in, res), out: union(f.out, out) } : { in: res, out })
    }
    return res
  }
  let out = EMPTY
  for (let i = fn.length - 1; i >= bodyStart; i--) out = live(fn[i], out)
  return found
}

/** The loop as written with a way in at each of `targets` ({ id, stmt, path }:
 *  a statement and the blocks, arms and conditionals that hold it, from the
 *  loop down): built beside the loop, which stays whole for a copy that is
 *  dropped. `from` names the statement to start at, `taken` holds it while the
 *  iteration that starts there runs. */
const entered = (loop, targets, tag, from, taken) => {
  // what each holder holds: child → the first and the last target inside it
  const holds = new Map()
  for (const t of targets) {
    const chain = [...t.path, t.stmt]
    for (let i = 0; i + 1 < chain.length; i++) {
      const kids = holds.get(chain[i]) ?? holds.set(chain[i], new Map()).get(chain[i])
      const span = kids.get(chain[i + 1])
      if (span) { span[0] = Math.min(span[0], t.id); span[1] = Math.max(span[1], t.id) }
      else kids.set(chain[i + 1], [t.id, t.id])
    }
  }
  let labels = 0
  const at = () => ['local.get', taken]
  const within = span => ['i32.lt_u', ['i32.sub', at(), ['i32.const', span[0]]], ['i32.const', span[1] - span[0] + 1]]
  const enter = (n) => {
    const kids = holds.get(n)
    if (!kids) return n
    if (n[0] === 'if') {
      const { test, then, otherwise } = conditional(n)
      const a = then ? kids.get(then) : null, b = otherwise ? kids.get(otherwise) : null
      let t = test
      if (b) t = ['if', ['result', 'i32'], within(b), ['then', ['i32.const', 0]], ['else', t]]
      if (a) t = ['if', ['result', 'i32'], within(a), ['then', ['i32.const', 1]], ['else', t]]
      return Object.assign(n.map(c => c === test ? t : c === then || c === otherwise ? enter(c) : c), marks(n))
    }
    // a run of statements: the loop, a block, an arm
    const start = n[0] === 'then' || n[0] === 'else' ? 1 : isLabel(n[1]) ? 2 : 1
    const body = n.slice(start), made = body.map(c => kids.has(c) ? enter(c) : c)
    const spans = [...kids].map(([child, span]) => ({ span, at: body.indexOf(child) })).sort((p, q) => p.at - q.at)
    const lo = spans[0].span[0], hi = spans[spans.length - 1].span[1]
    const names = spans.map(() => `$__sp${tag}e${labels++}`), none = `$__sp${tag}e${labels++}`
    const table = []
    for (let k = lo; k <= hi; k++) { const i = spans.findIndex(s => k >= s.span[0] && k <= s.span[1]); table.push(i < 0 ? none : names[i]) }
    let inner = ['block', none, ['br_table', ...table, none, ['i32.sub', at(), ['i32.const', lo]]]]
    let prev = 0
    spans.forEach((s, i) => { inner = ['block', names[i], inner, ...made.slice(prev, s.at)]; prev = s.at })
    const first = n === loop ? [['local.set', taken, ['local.get', from]], ['local.set', from, ['i32.const', 0]]] : []
    return Object.assign([...n.slice(0, start), ...first, inner, ...made.slice(prev)], marks(n))
  }
  return enter(loop)
}

/** Specialize the loops of `fn`. Returns the entry facts of the copies for the
 *  integer pass, or null when nothing changed. */
export function specializeLoops(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return null
  // (the runtime's own functions are written in their types)
  if (typeof fn[1] === 'string' && (fn[1].startsWith('$__') || fn[1].startsWith('$math.'))) return null
  let bodyStart = 2
  const types = new Map()
  for (; bodyStart < fn.length; bodyStart++) {
    const d = fn[bodyStart]
    if (!isArr(d) || (d[0] !== 'param' && d[0] !== 'local' && d[0] !== 'result' && d[0] !== 'export' && d[0] !== 'type')) break
    if ((d[0] === 'param' || d[0] === 'local') && typeof d[1] === 'string') types.set(d[1], d[2])
    else if (d[0] === 'param' || d[0] === 'local') return null   // an unnamed local: indices alias names
  }
  let unsafe = false, id = 0
  const scan = n => {
    if (!isArr(n)) return
    if (/^(try|try_table|catch|catch_all|delegate)$/.test(n[0])) unsafe = true
    if (/^local\.(get|set|tee)$/.test(n[0]) && !isLabel(n[1])) unsafe = true
    if ((n[0] === 'block' || n[0] === 'loop' || n[0] === 'local') && isLabel(n[1])) { const m = /\.f(\d+)$/.exec(n[1]); if (m) id = Math.max(id, +m[1] + 1) }
    n.forEach(scan)
  }
  scan(fn)
  if (unsafe) return null
  const budget = { left: Math.max(2 * size(fn), 400) }
  const assume = new Map()

  const declare = (name, type) => {
    const d = ['local', name, type]
    fn.splice(bodyStart++, 0, d)
    types.set(name, type)
    return d
  }
  const undo = (b) => {
    b.r.holder[b.r.holder.indexOf(b.whole)] = b.r.region
    assume.delete(b.fast)
    for (const d of b.decls) { fn.splice(fn.indexOf(d), 1); bodyStart--; types.delete(d[1]) }
    budget.left += b.size
  }
  const dropGuard = (b, g) => {
    for (const t of g.tests) b.entry.splice(b.entry.indexOf(t), 1)
    assume.get(b.fast).delete(g.name)
  }

  /** Build the specialized copy of one loop in place; null when it has
   *  nothing to specialize on or a shape that cannot leave cleanly. */
  const build = (r, plan0, alive) => {
    const { region, loop } = r
    if (!alive.has(region)) return null
    const n0 = size(region)
    if (n0 > LARGE || n0 > budget.left) return null
    if (!isLabel(loop[1]) || typed(loop)) return null
    const setup = region === loop ? [] : region.slice(2, -1)
    // Branches: inside the region, to the region's own exit, or outward without a value.
    const inside = new Set()
    const label = n => { if (!isArr(n)) return; if ((n[0] === 'block' || n[0] === 'loop' || n[0] === 'if') && isLabel(n[1])) inside.add(n[1]); n.forEach(label) }
    label(region)
    let bad = false
    const outward = new Set()
    const branches = n => {
      if (!isArr(n) || bad) return
      if (n[0] === 'br' || n[0] === 'br_if') {
        if (!isLabel(n[1])) bad = true
        else if (!inside.has(n[1])) { if (n.length > (n[0] === 'br' ? 2 : 3)) bad = true; outward.add(n[1]) }
      } else if (n[0] === 'br_table') { for (const l of n.slice(1)) if (!isArr(l) && !inside.has(l)) bad = true }
      else if (n[0] === 'br_on_null' || n[0] === 'br_on_non_null' || n[0] === 'br_on_cast' || n[0] === 'br_on_cast_fail') bad = true
      n.forEach(branches)
    }
    branches(region)
    if (bad) return null

    // Locals: what the region writes, what it reads, what is live around it.
    // (`boxes`: the locals whose low word the region takes, as the address a box holds)
    const written = new Set(), loopReads = new Set(), boxes = new Set()
    const census = n => {
      if (!isArr(n)) return
      if (n[0] === 'local.set' || n[0] === 'local.tee') written.add(n[1])
      else if (n[0] === 'i32.wrap_i64') { const x = bitsOf(n[1], null); if (x != null) boxes.add(x) }
      n.forEach(census)
    }
    census(region)
    // An already guarded loop uses integer snapshots in its fast body. Reads
    // used only to construct that guard (or in its checked twin) cannot pay
    // for a second copy of the body. Their actual conversion costs remain in
    // integerPlan; this only identifies useful speculative entry assumptions.
    const readsLoop = n => {
      if (!isArr(n) || n.checkedTwin === true || n.boundsSnapshot === true) return
      if (n[0] === 'if' && n.some(c => isArr(c) && c.checkedTwin === true)) {
        const arm = n.find(c => isArr(c) && c[0] === 'then')
        if (arm) readsLoop(arm)
        return
      }
      if (n[0] === 'local.get') loopReads.add(n[1])
      for (let i = 1; i < n.length; i++) readsLoop(n[i])
    }
    readsLoop(loop)
    const entering = alive.get(region).in, leaving = alive.get(region).out

    const at0 = plan0.facts.entry.get(region)
    if (!at0) return null   // never reached
    const known = name => { const v = boundOf(at0, name); return !!v && v.int && !v.nan && v.lo >= -LIMIT && v.hi <= LIMIT }

    // The copy: its labels and the f64 locals it writes are its own.
    const tag = `.f${id++}`
    const own = new Map()
    for (const name of written) if (types.get(name) === 'f64') own.set(name, name + tag)
    // an integer it only reads is carried in a local of its own as well
    const assumed = []
    for (const name of entering) if (loopReads.has(name) && types.get(name) === 'f64' && !known(name) && !boxes.has(name)) { assumed.push(name); if (!own.has(name)) own.set(name, name + tag) }
    // a node of the copy → the node it copies; a node the region holds at two
    // places has two copies, and names no one place
    const twin = new Map(), times = new Map()
    const rename = n => {
      if (!isArr(n)) return n
      const c = Object.assign(n.map(rename), marks(n))
      if ((c[0] === 'local.get' || c[0] === 'local.set' || c[0] === 'local.tee') && own.has(c[1])) c[1] = own.get(c[1])
      else if ((c[0] === 'block' || c[0] === 'loop' || c[0] === 'if') && inside.has(c[1])) c[1] += tag
      else if ((c[0] === 'br' || c[0] === 'br_if') && inside.has(c[1])) c[1] += tag
      else if (c[0] === 'br_table') for (let i = 1; i < c.length; i++) if (!isArr(c[i]) && inside.has(c[i])) c[i] += tag
      twin.set(c, n)
      times.set(n, (times.get(n) ?? 0) + 1)
      return c
    }
    const copy = rename(region)
    const fastLoop = region === loop ? copy : copy[copy.length - 1]
    const done = `$__sp${tag}d`, slow = `$__sp${tag}s`, go = `$__sp${tag}g`
    const from = `$__sp${tag}r`, taken = `$__sp${tag}t`
    const decls = []
    const local = (name, type) => { decls.push(declare(name, type)); return name }
    for (const mine of own.values()) local(mine, 'f64')

    // A stretch of statements that writes no memory and calls nothing: a read
    // anywhere in it leaves to its first statement, of the loop as written,
    // which every way to the read passes. The targets are the stretches a
    // read left.
    const targets = new Map()
    // (`all`: what every way through the stretch wrote and read first, shared by its arms)
    const stretchAt = (stmt, path, list) => ({ stmt, path, list, saves: new Map(), all: { may: new Set(), exposed: new Set() }, st: { dirty: false, must: new Set(), may: new Set(), exposed: new Set() } })
    const placed = rg => {
      const chain = [...rg.path, rg.stmt].map(c => twin.get(c)), stmt = chain[chain.length - 1]
      let t = targets.get(stmt)
      if (t !== undefined) return t
      const live = alive.get(stmt)
      t = null
      if (live && chain.every(n => times.get(n) === 1)) {
        // the locals the statement finds live, of the ones the copy keeps in its own
        const back = []
        for (const [name, mine] of own) if (written.has(name) && live.in.has(name)) back.push(once(name, mine))
        t = { id: 0, stmt, path: chain.slice(0, -1), saved: [], back, first: rg.stmt, list: rg.list, saves: rg.saves, all: rg.all, uses: [] }
      }
      targets.set(stmt, t)
      return t
    }
    // What a stretch has done so far: whether it wrote memory or called out,
    // the locals every way through it wrote (`must`), the ones some way wrote
    // (`may`), the ones it read that some way had not written (`exposed`).
    const fork = st => ({ dirty: st.dirty, must: new Set(st.must), may: new Set(st.may), exposed: new Set(st.exposed) })
    const join = (st, a, b) => {
      st.dirty = a.dirty || b.dirty
      st.must = new Set([...a.must].filter(x => b.must.has(x)))
      st.may = new Set([...a.may, ...b.may])
      st.exposed = new Set([...a.exposed, ...b.exposed])
    }
    let guards = 0, weight = 0, saved = 0
    /** The branch a read at this point leaves by, or null where its stretch
     *  cannot run again. `worth`: what the copy gains by it. */
    const leaveBy = (rg, op, test, worth = 4) => {
      const st = rg.st
      if (st.dirty) return null
      const t = placed(rg)
      if (!t) return null
      if (worth) guards++
      weight += worth
      const by = test ? [op, null, test] : [op, null]
      t.uses.push(by)
      return by
    }

    // (`num`: the read is one the emitter marked a number or a miss, on the
    // read itself or on the block it is the value of: a typed element. An
    // array's slot holds any value, a hole among them.)
    const expr = (n, holder, at, rg, num = false) => {
      if (!isArr(n)) return
      const op = n[0], st = rg.st
      if (n.checkedNumRead === true) num = true
      if (op === 'loop') { st.dirty = true; return }   // (a loop inside a statement runs its writes more than once)
      if (op === 'local.get') { if (!st.must.has(n[1])) { st.exposed.add(n[1]); rg.all.exposed.add(n[1]) } return }
      if (op === 'if') {
        const read = checkedRead(n)
        if (!read) { branch(n, rg, null); return }
        expr(n[2], n, 2, rg)
        const by = leaveBy(rg, 'br_if', ['i32.eqz', n[2]])
        if (by) {
          const hit = n[3][1]
          const load = canonOf(hit) ?? hit
          if (num && load[0] === 'f64.load') load.numberRead = true   // a typed element, where it is read at all
          holder[at] = ['block', ['result', read.type], by, hit]
          expr(hit, holder[at], 3, rg)
          return
        }
        expr(n[3][1], n[3], 1, rg)
        return
      }
      const read = op === 'select' ? checkedRead(n) : null
      if (read) {
        if (!st.must.has(read.valid)) { st.exposed.add(read.valid); rg.all.exposed.add(read.valid) }
        const by = leaveBy(rg, 'br_if', ['i32.eqz', ['local.get', read.valid]])
        if (by) {
          const hit = unclamp(n[1], read.valid)
          const load = canonOf(hit) ?? hit
          if (num && load[0] === 'f64.load') load.numberRead = true
          holder[at] = ['block', ['result', read.type], by, hit]
          expr(hit, holder[at], 3, rg)
          return
        }
      }
      const value = op === 'block' && num ? n.length - 1 : 0
      for (let i = 1; i < n.length; i++) expr(n[i], n, i, rg, i === value)
      if (op === 'local.set' || op === 'local.tee') { st.must.add(n[1]); st.may.add(n[1]); rg.all.may.add(n[1]) }
      else if (STORE.test(op) || calls(n)) st.dirty = true
    }
    // A conditional: its test, then its arms from what the test left. The arm
    // a number does not take, where it calls the runtime, leaves instead.
    // `seq` walks an arm that holds statements and answers the stretch it ends
    // in. Answers the stretch that goes on after the conditional, or null.
    const branch = (n, rg, seq) => {
      const { test, then, otherwise } = conditional(n)
      expr(test, n, n.indexOf(test), rg)
      // (the checked twin of a loop the emitter versioned is the third case:
      // where the extents fail, the loop as written runs it. The arm it leaves
      // in the copy is as fast in the loop as written: no copy is worth it alone)
      const twin = then?.[0] === 'then' && otherwise?.checkedTwin === true
      const taken = twin ? 1 : then?.[0] === 'then' && otherwise?.[0] === 'else' ? forNumber(test) : null
      const cold = taken == null ? null : taken ? otherwise : then, kept = cold && (taken ? then : otherwise)
      const by = cold && (twin || (callsOut(cold) && !callsOut(kept))) ? leaveBy(rg, 'br', null, twin ? 0 : 4) : null
      const walk = (arm, sub) => {
        if (!arm) return sub
        if (arm[0] !== 'then' && arm[0] !== 'else') { expr(arm, n, n.indexOf(arm), sub); return sub }
        if (seq) return seq(arm, sub)
        for (let k = 1; k < arm.length; k++) expr(arm[k], arm, k, sub)
        return sub
      }
      if (by) {
        cold.length = 1
        cold.push(by)
        return walk(kept, rg) === rg && !rg.st.dirty ? rg : null
      }
      const a = { stmt: rg.stmt, path: rg.path, list: rg.list, saves: rg.saves, all: rg.all, st: fork(rg.st) }
      const b = { stmt: rg.stmt, path: rg.path, list: rg.list, saves: rg.saves, all: rg.all, st: fork(rg.st) }
      const same = walk(then, a) === a && walk(otherwise, b) === b
      join(rg.st, a.st, b.st)
      return same && !rg.st.dirty ? rg : null
    }
    // The statements of a block, a loop or an arm, one after another, from
    // the stretch `rg` (null: the first statement starts one). Answers the
    // stretch the last one ends in.
    const statements = (list, start, path, rg) => {
      const here = [...path, list]
      for (let i = start; i < list.length; i++) {
        const x = list[i]
        if (!isArr(x)) continue
        if (x[0] === 'loop') { rg = null; continue }   // a loop inside has a copy of its own; what follows starts anew
        if (rg && rg.st.dirty) rg = null
        if (x[0] === 'block' && !typed(x)) {
          rg = statements(x, isLabel(x[1]) ? 2 : 1, here, rg)
          if (isLabel(x[1])) rg = null   // a branch to its end arrives from another stretch
          continue
        }
        if (!rg) rg = stretchAt(x, here, list)
        if (x[0] !== 'if' || typed(x)) { expr(x, list, i, rg); continue }
        rg = branch(x, rg, (arm, sub) => statements(arm, 1, [...here, x], sub))
        if (isLabel(x[1])) rg = null
      }
      return rg
    }
    statements(fastLoop, 2, [], null)
    // A local the stretch reads and then writes is saved where the stretch
    // starts and put back where a read leaves. Every such local of the whole
    // stretch, not only of what precedes the read: the generic optimizer may
    // move a read later within its stretch (past a write of a local it does
    // not read), and the loop as written runs the stretch again from its start.
    for (const t of targets.values()) if (t && t.uses.length) for (const x of t.all.may) if (t.all.exposed.has(x) && !t.saves.has(x)) {
      const s = local(`${x}.t${tag.slice(2)}_${saved++}`, types.get(x))
      decls[decls.length - 1].copyOf = x   // it takes the type its local is narrowed to
      t.saves.set(x, s)
      t.saved.push(once(x, s))
    }
    // The targets in the order the loop as written runs them; each stretch
    // takes its copies where it starts.
    const spot = new Map(statementsOf(loop, 2).map((s, k) => [s, k]))
    const ids = [...targets.values()].filter(t => t && t.uses.length).sort((p, q) => spot.get(p.stmt) - spot.get(q.stmt))
    ids.forEach((t, k) => {
      t.id = k + 1
      for (const by of t.uses) by[1] = `$__sp${tag}a${t.id}`
      if (t.saves.size) t.list.splice(t.list.indexOf(t.first), 0, ...[...t.saves].map(([name, s]) => ['local.set', s, ['local.get', name]]))
    })
    if (!guards && !assumed.length) { for (const d of decls) { fn.splice(fn.indexOf(d), 1); bodyStart--; types.delete(d[1]) } return null }

    // Entry: the integers the copy assumes, then its own locals' values.
    const get = name => ['local.get', name]
    const entry = [], guardList = []
    for (const name of assumed) {
      const tests = [
        ['br_if', slow, ['i64.ne', ['i64.reinterpret_f64', ['f64.convert_i64_s', ['i64.trunc_sat_f64_s', get(name)]]], ['i64.reinterpret_f64', get(name)]]],
        ['br_if', slow, ['f64.gt', ['f64.abs', get(name)], ['f64.const', ASSUMED]]],
      ]
      entry.push(...tests)
      guardList.push({ name, own: own.get(name), tests })
    }
    const facts = new Map(assumed.map(name => [name, { lo: -ASSUMED, hi: ASSUMED, int: true, nz: false, nan: false }]))
    const enter = [], leave = [], exit = []
    for (const [name, mine] of own) {
      if (entering.has(name)) enter.push(['local.set', mine, get(name)])
      if (written.has(name) && leaving.has(name)) leave.push(['local.set', name, get(mine)])
      if (written.has(name) && outward.size) exit.push(['local.set', name, get(mine)])
    }
    // Fallthrough liveness does not describe an outward branch's destination.
    // Restore every written copy there, including an enclosing copy's exits.
    if (exit.length) {
      const guardOut = (n) => {
        if (!isArr(n)) return n
        for (let i = 1; i < n.length; i++) n[i] = guardOut(n[i])
        if (n[0] === 'br' && outward.has(n[1])) return ['block', ...exit.map(clone), n]
        if (n[0] === 'br_if' && outward.has(n[1])) return ['if', n[2], ['then', ...exit.map(clone), ['br', n[1]]]]
        return n
      }
      guardOut(copy)
    }
    const fast = ['block', `$__sp${tag}f`, ...enter, copy, ...leave]
    assume.set(fast, facts)
    // the block the copy runs in: the tests of the assumed integers are its first statements
    const entryBlock = ['block', ids.length ? `$__sp${tag}a1` : slow, ...entry, fast, ['br', done]]
    let whole
    if (!ids.length) whole = ['block', done, entryBlock, region]
    else {
      local(from, 'i32')
      local(taken, 'i32')
      // Where a read leaves: the locals its statement saved, then the ones it
      // finds live, from the copy's own.
      let run = entryBlock
      for (let k = 1; k <= ids.length; k++)
        run = ['block', k < ids.length ? `$__sp${tag}a${k + 1}` : slow, run, ...ids[k - 1].saved, ...ids[k - 1].back, ['local.set', from, ['i32.const', k]], ['br', go]]
      const way = ['block', go, run, ...setup]
      const asWritten = entered(loop, ids, tag, from, taken)
      whole = region === loop ? ['block', done, way, asWritten] : ['block', done, ['block', region[1], way, asWritten]]
    }
    r.holder[r.holder.indexOf(region)] = whole
    const grown = size(whole) - n0
    budget.left -= grown
    return { r, whole, fast, fastLoop, entry: entryBlock, guards: guardList, own: new Set(own.values()), reads: weight, decls, size: grown }
  }

  // One level of loops at a time: the loops no loop contains, then the loops
  // inside what was built (or inside what was left as written).
  const top = ['block', ...fn.slice(bodyStart)]
  let level = loopsOf(top)
  for (const r of level) if (r.holder === top) r.holder = fn   // the function holds its own statements
  // The intervals are read for every loop of the function at once, so the
  // walk that weighs one level's copies serves the next level where no copy
  // was dropped since.
  const everyLoop = () => {
    const out = new Set()
    const walk = n => { if (!isArr(n)) return; if (n[0] === 'loop') out.add(n); else if (n[0] === 'block' && isArr(n[n.length - 1]) && n[n.length - 1][0] === 'loop') out.add(n); n.forEach(walk) }
    for (let i = bodyStart; i < fn.length; i++) walk(fn[i])
    return out
  }
  let held = null
  for (let depth = 0; depth < 3 && level.length; depth++) {
    const plan0 = held ?? integerPlan(fn, assume, everyLoop())
    held = null
    if (!plan0) break
    const wanted = new Set(level.map(r => r.region))
    for (const r of level) for (const s of statementsOf(r.loop, 2)) wanted.add(s)
    const alive = liveness(fn, bodyStart, wanted)
    const built = []
    for (const r of level) {
      const b = build(r, plan0, alive)
      if (b) built.push(b)
    }
    // Which copies narrow anything, and which assumed integers are read as integers.
    let kept = built
    if (built.length) {
      const plan = integerPlan(fn, assume, everyLoop())
      kept = []
      for (const b of built) {
        if (!plan) { undo(b); continue }
        let gain = b.reads
        for (const name of b.own) if (plan.N.has(name)) gain += Math.max(0, plan.score(name))
        // (a loop inside a copy costs its own size alone: the copy around it is
        // there; a copy that tests no read is worth its size for more)
        if (gain < (depth ? 4 : b.reads ? SMALL : PLAIN)) { undo(b); continue }
        for (const g of b.guards) if (!plan.N.has(g.own)) dropGuard(b, g)
        kept.push(b)
      }
      if (kept.length === built.length) held = plan
    } else held = plan0
    const next = []
    for (const r of level) {
      const b = kept.find(k => k.r === r)
      next.push(...loopsOf(b ? b.fastLoop : r.loop))
    }
    level = next
  }
  return assume.size ? assume : null
}
