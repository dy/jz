// The address model the straight-line memory passes share (the SLP packer, store
// forwarding): what an access reads or writes as `base ⊕ off`, resolved over the
// locals a window of statements defines, and which statements a value may be
// evaluated across.
import { nodeEqual as exprEq, walkAst } from '../../ast.js'
import { isArr } from './node-utils.js'

// Decompose a load/store node, normalizing the optional `offset=K` attribute jz
// folds adjacent accesses into: `(op addr …)` → off 0, `(op offset=K addr …)` → K.
export const memAccess = (n) => {
  if (typeof n[1] === 'string' && n[1].startsWith('offset=')) return { off: +n[1].slice(7), addr: n[2], val: n[3] }
  return { off: 0, addr: n[1], val: n[2] }
}
// A constant i32 subtree's value, folding the arithmetic jz leaves in a constant index
// (`(i32.shl (i32.const 3) (i32.const 3))`); NaN when it is not constant.
export const constOf = (n) => {
  if (!isArr(n)) return NaN
  if (n[0] === 'i32.const') return Number(n[1])
  if (n.length !== 3) return NaN
  const a = constOf(n[1]), b = constOf(n[2])
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN
  switch (n[0]) {
    case 'i32.add': return (a + b) | 0
    case 'i32.sub': return (a - b) | 0
    case 'i32.mul': return Math.imul(a, b)
    case 'i32.shl': return a << (b & 31)
  }
  return NaN
}
// An access as `base ⊕ off`: the memarg plus every constant the address adds. `base`
// is the remaining address subtree, kept as emitted (its tee included) for reuse.
export const accessOf = (n) => {
  const m = memAccess(n)
  let base = m.addr, off = m.off
  while (isArr(base) && base[0] === 'i32.add' && base.length === 3) {
    const k = constOf(base[2]), j = constOf(base[1])
    if (!Number.isNaN(k)) { off += k; base = base[1] }
    else if (!Number.isNaN(j)) { off += j; base = base[2] }
    else break
  }
  return { base, off, addr: m.addr, val: m.val }
}
export const memarg = (op, off, base, ...rest) => off ? [op, `offset=${off}`, base, ...rest] : [op, base, ...rest]
export const clone = n => isArr(n) ? n.map(clone) : n

export const hasOp = (n, ops) => { let hit = false; walkAst(n, { enter: x => { if (hit) return false; if (ops.has(x[0])) hit = true } }); return hit }
export const BRANCH_OPS = new Set(['br', 'br_if', 'br_table', 'return', 'return_call', 'unreachable', 'throw', 'try_table', 'loop', 'block', 'call_indirect'])
export const CONTROL_OPS = new Set([...BRANCH_OPS, 'if'])
export const TEE = new Set(['local.tee'])

// The locals a window of statements defines, by statement index: a top-level
// `local.set`, or a `local.tee` inside a statement with no control op (it runs whenever
// the statement does). A name defined twice resolves to nothing; `writes` has every
// name the window writes, defined or not. The window opens a few statements before the
// accesses compared, where jz stages their receivers.
export const windowDefs = (stmts, from, to) => {
  const defs = new Map(), writes = new Set()
  for (let at = from; at <= to; at++) {
    const s = stmts[at]
    if (!isArr(s)) continue
    const whole = !hasOp(s, CONTROL_OPS)
    walkAst(s, { enter: n => {
      if (n[0] === 'global.set') { writes.add('global:' + n[1]); return }
      if ((n[0] !== 'local.set' && n[0] !== 'local.tee') || typeof n[1] !== 'string') return
      writes.add(n[1])
      if (n === s || n[0] === 'local.tee' && whole) defs.set(n[1], defs.has(n[1]) ? null : { e: n[2], at })
    } })
  }
  return { defs, writes }
}
// Pure register arithmetic an address is made of. No load: memory may change between
// the two accesses compared.
export const ADDR_OPS = new Set(['i32.add', 'i32.sub', 'i32.mul', 'i32.shl', 'i32.shr_u', 'i32.shr_s', 'i32.and', 'i32.or', 'i32.xor', 'i32.wrap_i64', 'i32.const',
  'i64.and', 'i64.or', 'i64.shl', 'i64.shr_u', 'i64.const', 'i64.reinterpret_f64', 'i64.extend_i32_u', 'f64.const'])
// What an address subtree computes at statement `at` of the window, over locals the
// window never writes: a tee dissolves into its body, a local the window defined
// EARLIER into its definition, and a definition that is no register arithmetic (an
// allocation call, or an opaque `{ e: null }` write) stands as the local at that
// definition, `name@at` — one identity per definition; a global the window never sets
// stands as itself. null when a load, a call or a local written in the window stands
// in the way — the value could differ between the two accesses.
export const resolveAddr = (n, w, at, depth = 0) => {
  if (!isArr(n) || depth > 16) return null
  const op = n[0]
  if (op === 'local.tee' || op === 'local.get') {
    if (typeof n[1] !== 'string') return null
    const d = w.defs.get(n[1])
    if (op === 'local.get' && d === undefined) return w.writes.has(n[1]) ? null : n
    if (!d || op === 'local.get' && d.at >= at || op === 'local.tee' && d.e !== n[2]) return null
    return (d.e && resolveAddr(d.e, w, d.at, depth + 1)) ?? ['local.get', `${n[1]}@${d.at}`]
  }
  if (op === 'global.get') return typeof n[1] === 'string' && !w.writes.has('global:' + n[1]) ? n : null
  if (!ADDR_OPS.has(op)) return null
  const out = [op]
  for (let i = 1; i < n.length; i++) {
    if (!isArr(n[i])) { out.push(n[i]); continue }
    const r = resolveAddr(n[i], w, at, depth)
    if (!r) return null
    out.push(r)
  }
  return out
}
// The two accesses, at statements `atX` and `atY` of the window, address the same base.
export const sameBase = (x, atX, y, atY, w) => {
  const a = resolveAddr(x, w, atX), b = a && resolveAddr(y, w, atY)
  return !!b && exprEq(a, b)
}
// The locals a value reads.
export const localReads = (n) => {
  const r = new Set()
  walkAst(n, { enter: x => { if (x[0] === 'local.get' && typeof x[1] === 'string') r.add(x[1]) } })
  return r
}
// A statement a value (or a load) may be evaluated across: it writes none of the value's
// locals or any global, stores nothing, branches nowhere, and calls only what writes
// no memory: the durable-array snapshot (which records an array), the header reads
// behind an element access (a pointer's forwarding hop, a length), or a throw guard
// (which either does nothing or ends the activation, whose locals then no one reads).
// A store crossing it (`strict`) needs more: no load could see the store's slot, no
// call could, and a guard that throws would leave the store made.
export const INERT_CALLS = new Set(['$__durable_arr_snap', '$__ptr_offset_fwd', '$__ptr_offset', '$__len'])
export const inertFor = (stmt, reads, strict = false) => {
  if (!isArr(stmt)) return typeof stmt === 'string'
  let ok = true
  walkAst(stmt, { enter: n => {
    if (!ok) return false
    const op = n[0]
    if (typeof op !== 'string') { ok = false; return false }
    if (op === 'local.set' || op === 'local.tee') { if (reads.has(n[1])) ok = false; return }
    if (op === 'call') { if (strict || !INERT_CALLS.has(n[1]) && !n[1].startsWith('$__throw_')) ok = false; return }
    if (op === 'unreachable') { if (strict) ok = false; return }
    if (op === 'global.set' || op.includes('.store') || op.startsWith('memory.') || op.includes('.atomic.') || op.startsWith('call') || BRANCH_OPS.has(op)
        || strict && op.includes('.load')) ok = false
  } })
  return ok
}
// Every tee in `n` defines a local nothing reads: the subtree can dissolve (jz stages
// each access's base in a fresh temp) without leaving a read of an unset local.
export const deadTees = (n, counts) => {
  let ok = true
  walkAst(n, { enter: x => { if (x[0] === 'local.tee' && counts.has(x[1])) ok = false } })
  return ok
}
// Count `(local.get NAME)` occurrences across a function: a temp read once can dissolve
// into what reads it; a tee whose local is never read can dissolve with its subtree.
export const localGetCounts = (fn) => {
  const counts = new Map()
  walkAst(fn, { enter: n => {
    if (isArr(n) && n[0] === 'local.get' && typeof n[1] === 'string') counts.set(n[1], (counts.get(n[1]) || 0) + 1)
  } })
  return counts
}
