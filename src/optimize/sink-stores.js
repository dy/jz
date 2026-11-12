/**
 * A store a loop makes every round to a slot nothing in the loop reads is a local the
 * round sets, stored once as the loop leaves (speed tier):
 *
 *   (block $B (loop $L (br_if $B done) …(f64.store (local.get $out) V)… (br $L)))
 *
 * becomes
 *
 *   (block $B (local.set $ran (i32.const 0))
 *     (loop $L (br_if $B done) …(local.set $p V)… (local.set $ran (i32.const 1)) (br $L)))
 *   (if (local.get $ran) (then (f64.store (local.get $out) (local.get $p))))
 *
 * and a value computed only for such a store is computed there instead, from the
 * locals the last round left it in. The out-parameter a chain of library calls writes
 * each round and its caller reads past the loop: pmndrs/math's `quat.multiply(out,
 * inv, b[i])` stores four products a round, two of which the round never reads. clang
 * keeps `out` in registers and multiplies those two once, past the loop; V8 stores
 * and multiplies each round.
 *
 * Exact under these conditions:
 *  - the loop is `(br_if $B …)` first and `(br $L)` last, the last of its block, with
 *    no other branch out, no loop within and no call but a throw guard's;
 *  - the slot is an f64 at an address of locals the loop never writes, stored every
 *    round, by a statement of the body or by both arms of an `if` of it whose arms
 *    only set locals and store;
 *  - nothing else in the loop may read or write it (src/ir/mem-alias.js); slots of two
 *    names that may be one array are stored in one order each round, and past the
 *    loop in that order;
 *  - each throw guard comes before the first such store: it stores what the round
 *    before left (nothing, in the first round) before it throws;
 *  - a value moves past the loop where it is one statement's local, read by the store
 *    alone, of arithmetic over locals that no later statement of the round writes,
 *    nor any statement up to the last throw guard.
 *
 * @module optimize/sink-stores
 */
import { walkAst, nodeKey } from '../ast.js'
import { findBodyStart } from '../ir.js'
import { accessOf, hasOp, localGetCounts, resolveAddr, clone, CONTROL_OPS } from './vectorize/access.js'
import { isArr } from './vectorize/node-utils.js'
import { mayAlias } from '../ir/mem-alias.js'
import { copyRoots } from './forward-store.js'
import { pureKernel } from './pure-funcs.js'

const NONE = new Set()
const BRANCH = new Set(['br', 'br_if', 'br_table'])
const EXIT = new Set(['return', 'return_call', 'return_call_indirect', 'return_call_ref', 'throw', 'rethrow', 'try', 'try_table', 'delegate', 'call_indirect', 'call_ref', 'loop', 'global.set'])
const ARITH = /^(?:(?:f64|f32|i32|i64)\.(?:const|add|sub|mul|div|neg|abs|sqrt|min|max|copysign|floor|ceil|trunc|nearest|eq|ne|lt|gt|le|ge|convert_\w+|promote_f32|demote_f64|reinterpret_\w+)|local\.get|global\.get|select)$/
// (the header reads behind an element access: a block's forwarding hop, a length)
const HEADERS = new Set(['$__ptr_offset_fwd', '$__ptr_offset', '$__len'])
const isThrow = n => n[0] === 'call' && typeof n[1] === 'string' && n[1].startsWith('$__throw_')

export function sinkStores(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  const names = new Set(), added = []
  for (let i = 2; i < bodyStart; i++) if (isArr(fn[i]) && typeof fn[i][1] === 'string') names.add(fn[i][1])
  let next = 0, copies
  const fresh = type => { let n = `$__sk${next++}`; while (names.has(n)) n = `$__sk${next++}`; names.add(n); added.push(['local', n, type]); return n }
  const visit = (list, from, path) => {
    for (let i = from; i < list.length; i++) {
      const s = list[i]
      if (!isArr(s)) continue
      const here = [...path, [list, s]]
      if (s[0] === 'block' && isArr(s.at(-1)) && s.at(-1)[0] === 'loop') {
        if (copies === undefined) copies = copyRoots(fn, bodyStart)
        const flush = sinkLoop(fn, s, here, copies, fresh)
        if (flush) { list.splice(i + 1, 0, flush); i++; continue }
      }
      visit(s, 1, here)
    }
  }
  visit(fn, bodyStart, [])
  if (added.length) fn.splice(bodyStart, 0, ...added)
}

// The flush past the block, the loop rewritten; or null, the loop as it was
function sinkLoop(fn, block, path, copies, fresh) {
  const loop = block.at(-1), B = block[1], L = loop[1]
  if (typeof B !== 'string' || typeof L !== 'string' || loop.length < 5) return null
  const head = loop[2], tail = loop.at(-1), end = loop.length - 1
  if (block.some((x, i) => i > 1 && isArr(x) && x[0] === 'result')) return null
  if (!isArr(head) || head[0] !== 'br_if' || head[1] !== B || head.length !== 3 || !isArr(tail) || tail[0] !== 'br' || tail[1] !== L || tail.length !== 2) return null
  // no way out but the head, no call but a throw guard's
  const inner = new Set(), writes = new Set()
  let ok = true
  for (let j = 2; j < end && ok; j++) walkAst(loop[j], { enter: n => {
    if (!ok || !isArr(n) || typeof n[0] !== 'string') return false
    const op = n[0]
    if ((op === 'block' || op === 'if') && typeof n[1] === 'string') inner.add(n[1])
    if ((op === 'local.set' || op === 'local.tee') && typeof n[1] === 'string') writes.add(n[1])
    if (EXIT.has(op) || op.startsWith('memory.') || op.includes('.atomic.')) ok = false
    else if (op === 'call' && !isThrow(n) && !pureKernel(n[1]) && !HEADERS.has(n[1])) ok = false
    else if (BRANCH.has(op) && n !== loop[2] && !(op === 'br_table' ? n.slice(1).filter(x => typeof x === 'string').every(x => inner.has(x)) : inner.has(n[1]))) ok = false
  } })
  if (!ok) return null
  // the round's definitions, statement by statement: what an address resolves through
  const w = { defs: new Map(), writes: NONE, root: copies && (name => copies.root(name, [...path, [block, loop]])) }
  const define = (win, s, at) => {
    const whole = !hasOp(s, CONTROL_OPS)
    walkAst(s, { enter: n => {
      if ((n[0] !== 'local.set' && n[0] !== 'local.tee') || typeof n[1] !== 'string') return
      win.defs.set(n[1], { e: whole && (n === s || n[0] === 'local.tee') ? n[2] : null, at })
    } })
  }
  // an address the round does not move: of locals and globals no statement of the loop writes
  const keyOf = (base, win, at) => {
    const r = resolveAddr(base, win, at)
    if (!r) return null
    let fixed = true
    walkAst(r, { enter: n => { if (n[0] === 'local.get' && (n[1].includes('@') || writes.has(n[1]))) fixed = false } })
    return fixed ? nodeKey(r) : null
  }
  const stores = []     // { slot, key, off, mem, at, node, list, arm, base }: the candidates
  const others = []     // { key, off, f64, mem }: every other access
  const throws = []     // { at, list, node }: each guard's call, in the list it stands in
  const access = (n, win, at) => {
    const a = accessOf(n)
    others.push({ key: keyOf(a.base, win, at), off: a.off, f64: n[0] === 'f64.load' || n[0] === 'f64.store', mem: n.mem })
  }
  const scan = (s, win, at, top) => walkAst(s, { enter: (n, parent, idx) => {
    if (!isArr(n) || typeof n[0] !== 'string') return
    if (isThrow(n)) throws.push({ at, list: parent, node: n })
    if (n === top) return
    if (n[0].includes('.load') || n[0].includes('.store')) access(n, win, at)
  } })
  // an arm of an `if` that only sets locals and stores f64s, of operands that compute only
  const plain = a => isArr(a) && (a[0] === 'then' || a[0] === 'else') && a.slice(1).every(t => isArr(t) &&
    (t[0] === 'f64.store' || t[0] === 'local.set' && typeof t[1] === 'string') && !hasOp(t, CONTROL_OPS) && !hasOp(t, new Set(['call', 'local.tee'])))
  define(w, head, 2)
  scan(head, w, 2, null)
  for (let j = 3; j < end; j++) {
    const s = loop[j]
    if (!isArr(s)) continue
    let k = 1
    if (s[0] === 'if' && typeof s[k] === 'string') k++
    if (s[0] === 'if' && !(isArr(s[k]) && s[k][0] === 'result') && s.slice(k + 1).length && s.slice(k + 1).every(plain) && !hasOp(s[k], CONTROL_OPS)) {
      scan(s[k], w, j, null)
      for (const a of s.slice(k + 1)) {
        const win = { defs: new Map(w.defs), writes: NONE, root: w.root }
        for (let m = 1; m < a.length; m++) {
          const t = a[m], at = j + m / (a.length + 1)
          if (t[0] === 'local.set') { scan(t, win, at, null); define(win, t, at); continue }
          const acc = accessOf(t), key = keyOf(acc.base, win, at)
          scan(t, win, at, t)
          if (key && !hasOp(acc.addr, new Set(['local.tee']))) stores.push({ slot: `${key}|${acc.off}`, key, off: acc.off, mem: t.mem, at: j, node: t, list: a, arm: a, base: JSON.parse(key) })
          else access(t, win, at)
        }
      }
      define(w, s, j)
      continue
    }
    define(w, s, j)
    if (s[0] === 'f64.store') {
      const acc = accessOf(s), key = keyOf(acc.base, w, j)
      scan(s, w, j, s)
      if (key && !hasOp(acc.addr, new Set(['local.tee', 'call']))) { stores.push({ slot: `${key}|${acc.off}`, key, off: acc.off, mem: s.mem, at: j, node: s, list: loop, arm: null, base: JSON.parse(key) }); continue }
      access(s, w, j)
      continue
    }
    scan(s, w, j, null)
  }
  if (!stores.length) return null
  // every round stores the slot: a statement does, or both arms of one `if`
  const every = new Map()   // slot → its stores
  for (const st of stores) { if (!every.has(st.slot)) every.set(st.slot, []); every.get(st.slot).push(st) }
  const overlaps = (o, c) => o.key === c.key ? !(o.f64 && Math.abs(o.off - c.off) >= 8) : mayAlias(o.mem, c.mem)
  const slots = []
  for (const [slot, sts] of every) {
    const top = sts.some(s => !s.arm)
    const arms = new Map()
    for (const s of sts) if (s.arm) { if (!arms.has(s.at)) arms.set(s.at, new Set()); arms.get(s.at).add(s.arm) }
    const both = [...arms.values()].some(set => set.size === 2)
    const c = sts[0]
    if (!top && !both) { for (const s of sts) others.push({ key: s.key, off: s.off, f64: true, mem: s.mem }); continue }
    slots.push({ slot, key: c.key, off: c.off, mem: c.mem, base: c.base, sts, first: Math.min(...sts.map(s => s.at)), last: Math.max(...sts.map(s => s.at)) })
  }
  // (of one name, the slots are eight bytes apart: one f64 each)
  const kept = slots.filter(c => !others.some(o => overlaps(o, c)) && !slots.some(d => d !== c && d.key === c.key && Math.abs(d.off - c.off) < 8))
  if (!kept.length) return null
  // names that may be one array store in one order each round; every guard comes first
  const groups = new Map()
  for (const c of kept) { if (!groups.has(c.key)) groups.set(c.key, []); groups.get(c.key).push(c) }
  const span = g => [Math.min(...g.map(c => c.first)), Math.max(...g.map(c => c.last))]
  const gs = [...groups.values()].sort((a, b) => span(a)[0] - span(b)[0])
  for (let x = 0; x < gs.length; x++) for (let y = x + 1; y < gs.length; y++)
    if (gs[x].some(c => gs[y].some(d => mayAlias(c.mem, d.mem))) && span(gs[x])[1] >= span(gs[y])[0]) return null
  const firstStore = Math.min(...kept.map(c => c.first))
  if (throws.some(t => t.at >= firstStore || !isArr(t.list) || !['then', 'else', 'block'].includes(t.list[0]))) return null
  const lastThrow = throws.length ? Math.max(...throws.map(t => t.at)) : 1
  // a value only its store reads, of arithmetic over locals the rest of the round and
  // the statements up to the last guard leave as they were: computed where it is stored
  const counts = localGetCounts(fn)
  const writesIn = (from, to) => { const ws = new Set(); for (let j = from; j <= to && j < end; j++) walkAst(loop[j], { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') ws.add(n[1]) } }); return ws }
  const sunk = new Map()   // slot → { def index, expr }
  for (const c of kept) {
    if (c.sts.length !== 1 || c.sts[0].arm) continue
    const st = c.sts[0], v = accessOf(st.node).val
    if (!isArr(v) || v[0] !== 'local.get' || counts.get(v[1]) !== 1) continue
    let d = -1
    for (let j = 3; j < st.at; j++) if (isArr(loop[j]) && loop[j][0] === 'local.set' && loop[j][1] === v[1]) d = j
    if (d < 0) continue
    const e = loop[d][2]
    let pure = true
    const ops = new Set()
    walkAst(e, { enter: n => { if (!isArr(n) || typeof n[0] !== 'string' || !ARITH.test(n[0])) { pure = false; return false } if (n[0] === 'local.get') ops.add(n[1]) } })
    if (!pure) continue
    // (past the last round its body's rest runs, then the head that leaves)
    const late = new Set([...writesIn(d + 1, end - 1), ...writesIn(2, 2)]), early = writesIn(2, lastThrow)
    if ([...ops].some(o => late.has(o) || early.has(o) || o === v[1])) continue
    let defs = 0
    walkAst(fn, { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === v[1]) defs++ } })
    if (defs !== 1) continue
    sunk.set(c.slot, { d, e })
  }
  // the rewrite: each store a set of the slot's local (or nothing, its value moving past the loop)
  const local = new Map()
  for (const c of kept) if (!sunk.has(c.slot)) local.set(c.slot, fresh('f64'))
  const gone = [...sunk.values()].map(x => loop[x.d])
  for (const c of kept) for (const st of c.sts) {
    const at = st.list.indexOf(st.node)
    if (sunk.has(c.slot)) st.list.splice(at, 1)
    else st.list[at] = ['local.set', local.get(c.slot), accessOf(st.node).val]
  }
  for (const def of gone) loop.splice(loop.indexOf(def), 1)
  const ran = fresh('i32')
  const order = gs.flatMap(g => g.filter(c => kept.includes(c)).sort((a, b) => a.last - b.last || a.off - b.off))
  const flush = () => order.map(c => {
    const v = sunk.has(c.slot) ? clone(sunk.get(c.slot).e) : ['local.get', local.get(c.slot)]
    return c.off ? ['f64.store', `offset=${c.off}`, clone(c.base), v] : ['f64.store', clone(c.base), v]
  })
  for (const t of throws) t.list.splice(t.list.indexOf(t.node), 0, ['if', ['local.get', ran], ['then', ...flush()]])
  loop.splice(loop.length - 1, 0, ['local.set', ran, ['i32.const', 1]])
  block.splice(2, 0, ['local.set', ran, ['i32.const', 0]])
  return ['if', ['local.get', ran], ['then', ...flush()]]
}
