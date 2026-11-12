import { cloneNode, nodeEqual as exprEq, nodeKey, walkAst } from '../../ast.js'
import { constNum, hasSideEffect, isI32Const, isLocalGet, laneAccess } from './addr-model.js'
import { normTee } from './idioms.js'
import { isArr } from './node-utils.js'
import { strips } from './scaffold.js'

// ---- Same-array dependences of a lane lift (the general map and stencil) ----
//
// A vector step runs `lanes` iterations at once, so a store and any other access to its base
// must touch elements at least `lanes` apart, or the same element: otherwise a lane reads what
// the scalar loop would not have written yet, or overwrites what it would still read. Every
// index here is affine in the counter at coefficient 1, so the distance between two sites is
// one number for the whole loop: the difference of their linear forms, where the counter
// cancels. A constant distance decides now (the same element or `lanes` apart is fine; closer
// is a windowed recurrence, and the loop declines); an invariant one becomes a check hoisted
// before the loop, `D ≤ −lanes || D ≥ lanes`, one per distinct distance.

/** The i32 index `n` as a constant plus integer multiples of opaque terms (a local, a global,
 *  or a subexpression the form does not decompose), terms keyed by structure. An index
 *  temporary (`defs`) or a tee stands for its value. Arithmetic is modulo 2^32, like the
 *  index itself, so a difference of forms is exact whatever either side wraps to. */
function linearIndex(n, defs) {
  let k = 0
  const terms = new Map()
  const add = (x, m) => {
    if (isI32Const(x)) { k = (k + Math.imul(m, constNum(x))) | 0; return }
    if (isLocalGet(x) && defs?.has(x[1])) return add(defs.get(x[1]), m)
    if (isArr(x) && x[0] === 'local.tee' && x.length === 3) return add(x[2], m)
    if (isArr(x) && (x[0] === 'i32.add' || x[0] === 'i32.sub') && x.length === 3) {
      add(x[1], m); add(x[2], x[0] === 'i32.add' ? m : -m); return
    }
    if (isArr(x) && x[0] === 'i32.mul' && x.length === 3 && isI32Const(x[2])) return add(x[1], Math.imul(m, constNum(x[2])))
    if (isArr(x) && x[0] === 'i32.mul' && x.length === 3 && isI32Const(x[1])) return add(x[2], Math.imul(m, constNum(x[1])))
    if (isArr(x) && x[0] === 'i32.shl' && x.length === 3 && isI32Const(x[2])) return add(x[1], Math.imul(m, 1 << (constNum(x[2]) & 31)))
    const key = nodeKey(normTee(x)), t = terms.get(key)
    if (t) t.coeff = (t.coeff + m) | 0
    else terms.set(key, { key, node: x, coeff: m | 0 })
  }
  add(n, 1)
  return { k, terms }
}

/** `a − b` in elements, oriented so equal and opposite distances share one form. */
function distance(a, b, defs) {
  const A = linearIndex(a, defs), B = linearIndex(b, defs)
  for (const t of B.terms.values()) {
    const u = A.terms.get(t.key)
    if (u) u.coeff = (u.coeff - t.coeff) | 0
    else A.terms.set(t.key, { ...t, coeff: -t.coeff | 0 })
  }
  const terms = [...A.terms.values()].filter(t => t.coeff !== 0).sort((x, y) => x.key < y.key ? -1 : x.key > y.key ? 1 : 0)
  let k = (A.k - B.k) | 0
  if (terms.length && terms[0].coeff < 0) { for (const t of terms) t.coeff = -t.coeff | 0; k = -k | 0 }
  return { k, terms }
}

const distanceExpr = ({ k, terms }) => {
  let e = null
  for (const { node, coeff } of terms) {
    if (e && coeff === -1) { e = ['i32.sub', e, cloneNode(node)]; continue }
    const t = coeff === 1 ? cloneNode(node) : ['i32.mul', cloneNode(node), ['i32.const', coeff]]
    e = e ? ['i32.add', e, t] : t
  }
  return k ? ['i32.add', e, ['i32.const', k]] : e
}

/**
 * The hoisted checks that make a lane lift of these sites safe: [] when none is needed, null
 * when the lift must decline. `sites` are `{ kind, base, idx, memBytes }` (a `gather` reads a
 * base no store touches, and pairs with nothing); `defs` resolves index temporaries; `varying`
 * holds every local the loop writes, which a hoisted check cannot read.
 */
export function aliasGuards(sites, stride, lanes, { defs = null, varying, version = true }) {
  const guards = new Map()
  for (const st of sites) {
    if (st.kind !== 'store') continue
    for (const s of sites) {
      if (s === st || s.kind === 'gather' || !exprEq(normTee(s.base), normTee(st.base))) continue
      if ((st.memBytes - s.memBytes) % stride !== 0) return null
      const d = distance(s.idx, st.idx, defs)
      d.k = (d.k + (s.memBytes - st.memBytes) / stride) | 0
      if (!d.terms.length) {
        if (d.k !== 0 && Math.abs(d.k) < lanes) return null
        continue
      }
      if (!version) return null
      let reads = false
      for (const t of d.terms) walkAst(t.node, { enter: c => { if (c[0] === 'local.get' && varying.has(c[1])) reads = true } })
      if (reads) return null
      const key = nodeKey([d.k, d.terms.map(t => [t.key, t.coeff])])
      if (guards.has(key)) continue
      const D = distanceExpr(d)
      guards.set(key, ['i32.or',
        ['i32.le_s', D, ['i32.const', -lanes]],
        ['i32.ge_s', cloneNode(D), ['i32.const', lanes]]])
    }
  }
  return [...guards.values()]
}

// ---- Two bases that may be one array ----
//
// Different base expressions do not make different arrays: a function's two parameters can
// name one (`up(x, x)`), as a chosen binding can (`const p = flag ? x : y`), and a view can sit
// inside another. So every store answers for every other access of the scalar loop, where the
// strip's bound is set, past the preamble it reads. A failed test leaves the strip empty, and
// the scalar loop every lift keeps runs every iteration; a pair no test can decide keeps the
// loop scalar. A lift with no strip keeps the loop's order (`ordered`: `memory.copy`, which
// guards its own window, a pixel's channels as lanes) or stays scalar.
//
// `distinctParams` proves two bases apart: nothing to test. Two pointers need only one test,
// P ≠ Q: a base the pointer proof takes is where an allocation starts (an allocator's result, a
// pointer's own offset, a parameter narrowed from one), never inside one, as a view's elements
// are reached through its descriptor. So two pointers are one array or two, sites at one index
// need no test (the same element, or none of it), and any others P ≠ Q. The test runs at every
// entry of the loop, often a short one, so this is the case to reach.
//
// Otherwise it comes to bytes. Sites moving at one step S per iteration hold a distance D, read
// at entry: a strip of L lanes is the scalar loop when D = 0 (one element, in order) or
// |D| ≥ L·S. Sites at other steps (`pcm[i] = f[i]`, 2 bytes against 8; `tw[k]` with `k += step`)
// meet nowhere only if the bytes they touch over the loop left are disjoint. An address
// monotone over the iterations touches bytes between where it starts and where it ends.

const accessWidth = op => {
  const m = /(?:load|store)(8|16|32)/.exec(op)
  return m ? +m[1] / 8 : op.startsWith('v128') ? 16 : op.startsWith('i32') || op.startsWith('f32') ? 4 : 8
}

/** The sites of a loop, each at its byte address, memarg included. */
function memorySites(loop) {
  const sites = []
  walkAst(loop, { enter: n => {
    if (typeof n[0] !== 'string' || !/\.(load|store)/.test(n[0])) return
    let i = 1, off = 0
    for (; typeof n[i] === 'string'; i++) if (n[i].startsWith('offset=')) off = +n[i].slice(7)
    sites.push({ store: n[0].includes('.store'), width: accessWidth(n[0]), ptr: n[i], addr: off ? ['i32.add', n[i], ['i32.const', off]] : n[i] })
  } })
  return sites
}

/** What a loop's addresses stand on. `defs`: one i32 definition ahead of every read (`$cse =
 *  base + (i << 3)`) is that value, as every recognizer reads it. `copies`: a preamble local
 *  computing what an earlier one does, which a recognizer reads as a base of its own. `steps`: a
 *  local written once, by a constant or an invariant, moves by it. `written`: every local
 *  written. */
function addressFacts(node, loop, fnLocals) {
  const defs = new Map(), body = loop.slice(2), count = new Map(), held = new Map(), steps = new Map()
  const isWrite = n => (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string' && n.length === 3
  walkAst(loop, { enter: n => { if (isWrite(n)) count.set(n[1], (count.get(n[1]) || 0) + 1) } })
  walkAst(loop, { enter: n => {
    if (!isWrite(n) || count.get(n[1]) !== 1 || fnLocals.get(n[1]) !== 'i32') return
    const v = n[2], by = isArr(v) && v[0] === 'i32.add' && isLocalGet(v[1], n[1]) && v[2]
    if (by && (isI32Const(by) || (isLocalGet(by) && !count.has(by[1])))) steps.set(n[1], by)
    else if (laneAccess(body, n[1]) === 'write') defs.set(n[1], v)
  } })
  const copies = new Map(defs)
  for (const c of node) {
    if (c === loop) break
    if (!isArr(c) || c[0] !== 'local.set' || fnLocals.get(c[1]) !== 'i32') continue
    const key = nodeKey(normTee(c[2])), first = held.get(key)
    if (first) copies.set(c[1], ['local.get', first])
    else held.set(key, c[1])
  }
  return { defs, copies, steps, written: new Set(count.keys()) }
}

/** Whether a local holds the pointer of an array: a parameter known for one, or a local every
 *  write of which decodes one. Never an offset from one (`base + off`), nor an index. */
export function arrayPointers(fn) {
  const writes = new Map(), params = fn.arrayParams
  walkAst(fn, { enter: n => {
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') (writes.get(n[1]) ?? writes.set(n[1], []).get(n[1])).push(n[2])
  } })
  const known = new Map()
  const value = n => {
    if (!isArr(n)) return false
    if (isLocalGet(n)) return local(n[1])
    if (n[0] === 'local.tee') return value(n[2])
    if (n[0] === 'select') return value(n[1]) && value(n[2])
    if (n[0] === 'call') return POINTER_CALLS.has(n[1])
    if (n[0] === 'if') return n.slice(1).filter(c => isArr(c) && (c[0] === 'then' || c[0] === 'else')).every(arm => arm.length === 2 && value(arm[1]))
    if (n[0] !== 'i32.wrap_i64') return false
    const low = isArr(n[1]) && n[1][0] === 'i64.and' && isArr(n[1][2]) && n[1][2][0] === 'i64.const' && BigInt(n[1][2][1]) === 0xFFFFFFFFn
    const v = low ? n[1][1] : n[1]
    return isArr(v) && v[0] === 'i64.reinterpret_f64'
  }
  const local = name => {
    if (known.has(name)) return known.get(name)
    known.set(name, false)   // (a cycle of copies proves nothing)
    const w = writes.get(name)
    const is = (params?.has(name) && !w) || (!!w && !params?.has(name) && w.every(value))
    known.set(name, is)
    return is
  }
  return local
}
// (an allocation's payload is where its pointer points: module/core.js __alloc_hdr)
const POINTER_CALLS = new Set(['$__ptr_offset', '$__ptr_offset_fwd', '$__alloc_hdr', '$__alloc_hdr_n'])

/** The test `D = 0 or |D| ≥ span`. */
const apart = (d, span) => {
  const D = distanceExpr(d)
  return ['i32.or', ['i32.eqz', D],
    ['i32.ge_u', ['i32.add', cloneNode(D), ['i32.const', span - 1]], ['i32.const', 2 * span - 1]]]
}

/** Close the strips of the lift `r` of `node` behind the test its stores need: the lift, or
 *  null when some pair cannot be tested and the loop stays scalar. `distinct`: the parameters
 *  proven separate allocations. */
export function gateStrips(r, node, fnLocals, distinct, pointerOf) {
  const { wrapper } = r
  const loop = node.find(c => isArr(c) && c[0] === 'loop')
  const sites = loop ? memorySites(loop) : []
  if (!sites.some(s => s.store)) return r
  const { defs, copies, steps, written } = addressFacts(node, loop, fnLocals)
  const expand = n => !isArr(n) ? n : isLocalGet(n) && defs.has(n[1]) ? expand(defs.get(n[1])) : n[0] === 'local.tee' ? expand(n[2]) : n.map(expand)
  const invariant = n => {
    let ok = !hasSideEffect(n)
    walkAst(n, { enter: c => { if (c[0] === 'local.tee' || (c[0] === 'local.get' && written.has(c[1]))) ok = false } })
    return ok
  }
  const SCALED = new Set(['i32.shl', 'i32.mul', 'f64.mul'])
  const SUM = new Set(['i32.add', 'i32.sub', 'f64.add', 'f64.sub'])
  // How `n` moves with the iterations: 0 not at all, 1 linearly in the counters, 2 as one
  // truncated linear float; null when no bound on it follows from its ends.
  const motion = n => {
    if (invariant(n)) return 0
    if (!isArr(n)) return null
    if (isLocalGet(n)) return steps.has(n[1]) ? 1 : null
    if (SUM.has(n[0])) {
      const a = motion(n[1]), b = motion(n[2])
      return a == null || b == null || (a && b && a + b > 2) ? null : a || b
    }
    if (SCALED.has(n[0])) return motion(n[2]) === 0 ? motion(n[1]) : n[0] !== 'i32.shl' && motion(n[1]) === 0 ? motion(n[2]) : null
    if (n[0] === 'f64.convert_i32_s' || n[0] === 'i32.wrap_i64') return motion(n[1])
    return n[0] === 'i64.trunc_sat_f64_s' ? motion(n[1]) && 2 : null
  }
  // A site's base as the recognizers read one: of its address `B + offset`, the operand that
  // does not move while the other does (matchStrideAddr), here with temporaries resolved by
  // `by`. A local or a global; null where neither operand is one.
  const leaf = n => (isLocalGet(n) && !written.has(n[1])) || (isArr(n) && n[0] === 'global.get')
  const baseOf = (addr, by) => {
    let n = addr
    for (;;) {
      if (isArr(n) && n[0] === 'local.tee' && n.length === 3) n = n[2]
      else if (isLocalGet(n) && by.has(n[1])) n = by.get(n[1])
      else break
    }
    if (!isArr(n) || n[0] !== 'i32.add' || n.length !== 3) return null
    const resolve = x => isLocalGet(x) && by.has(x[1]) ? resolve(by.get(x[1])) : x
    const a = resolve(n[1]), b = resolve(n[2])
    return leaf(a) && !invariant(b) ? a : leaf(b) && !invariant(a) ? b : null
  }
  const key = n => n && nodeKey(n)
  for (const s of sites) {
    s.at = expand(s.addr)
    s.motion = motion(s.at)
    s.raw = key(baseOf(s.ptr, defs))
    const base = baseOf(s.ptr, copies)
    s.same = key(base)
    // (a pointer: two are one array or two)
    s.base = isLocalGet(base) && pointerOf(base[1]) ? base[1] : null
    // bytes an iteration, where they are one number
    s.step = s.motion === 0 ? 0 : null
    if (s.motion === 1) {
      let step = 0
      for (const t of linearIndex(s.addr, defs).terms.values()) {
        const by = isLocalGet(t.node) ? steps.get(t.node[1]) : null
        if (by && isI32Const(by)) step += t.coeff * constNum(by)
        else if (by || !invariant(t.node)) { step = null; break }
      }
      s.step = step
    }
  }
  const separate = d => {
    const bases = d.terms.filter(t => isLocalGet(t.node) && distinct?.has(t.node[1]))
    return bases.some(t => t.coeff === 1) && bases.some(t => t.coeff === -1)
  }
  const pairs = new Map(), unequal = new Map()
  for (const st of sites) {
    if (!st.store) continue
    for (const s of sites) {
      if (s === st) continue
      // (one base as the recognizers read bases: the lift's own dependence test)
      if (s.raw && s.raw === st.raw) continue
      const d = distance(s.addr, st.addr, copies)
      if (!d.terms.length && !d.k) continue
      if (separate(d)) continue
      if (s.same !== st.same && s.base && st.base) {
        if (d.terms.length === 2 && !d.k) continue
        unequal.set([s.base, st.base].sort().join(), [s.base, st.base])
        continue
      }
      const key = nodeKey([d.k, d.terms.map(t => [t.key, t.coeff]), s.at, st.at])
      if (!pairs.has(key)) pairs.set(key, { d, s, st })
    }
  }
  if (!pairs.size && !unequal.size) return r
  // A site's address with each counter stepped `tail` times: the iterations left, so the far
  // end holds whether the counters step before the access or after it.
  const last = (n, tail) => !isArr(n) ? n : isLocalGet(n) && steps.has(n[1])
    ? ['i32.add', n, ['i32.mul', cloneNode(tail), cloneNode(steps.get(n[1]))]] : n.map(c => last(c, tail))
  // `a` wholly below `b`: every address of `a` that can be its highest under every one of `b`
  // that can be its lowest.
  const below = (a, b, tail) => {
    const ends = (s, up) => s.step == null ? [s.at, last(s.at, tail)] : [s.step && (s.step > 0) === up ? last(s.at, tail) : s.at]
    let all = null
    for (const hi of ends(a, true)) for (const lo of ends(b, false)) {
      const t = ['i32.le_u', ['i32.add', cloneNode(hi), ['i32.const', a.width]], cloneNode(lo)]
      all = all ? ['i32.and', all, t] : t
    }
    return all
  }
  // The test a strip of `lanes` from `iv` to `bound` needs, `true` for none, null for none that
  // holds.
  const open = ({ iv, lanes, bound }) => {
    let test = null
    const and = t => { test = test ? ['i32.and', test, t] : t }
    for (const [p, q] of unequal.values()) and(['i32.ne', ['local.get', p], ['local.get', q]])
    for (const { d, s, st } of pairs.values()) {
      if (s.motion == null || st.motion == null) return null
      if (s.step === st.step && s.width === st.width && s.width <= Math.abs(s.step)) {
        const S = Math.abs(s.step)
        if (d.terms.length) { and(apart(d, S * lanes)); continue }
        // a fixed distance: the elements of other iterations, interleaved or not
        const r = ((d.k % S) + S) % S
        if (r ? r < s.width || S - r < s.width : Math.abs(d.k) < S * lanes) return null
        continue
      }
      if (!bound) return null
      const tail = ['i32.sub', cloneNode(bound), ['local.get', iv]]
      and(['i32.or', below(s, st, tail), below(st, s, tail)])
    }
    return test ?? true
  }
  const gate = (parent) => {
    for (let i = 1; i < parent.length; i++) {
      const c = parent[i]
      if (!isArr(c)) continue
      const at = strips.get(c)
      if (!at) { if (!gate(c)) return false; continue }
      const test = open(at)
      if (!test) return false
      found = true
      if (test !== true) parent[i] = at.block ? ['if', test, ['then', c]] : ['select', c, ['local.get', at.iv], test]
    }
    return true
  }
  let found = false
  return gate(wrapper) && (found || r.ordered) ? r : null
}
