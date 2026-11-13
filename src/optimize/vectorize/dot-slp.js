import { nodeEqual as exprEq, nodeKey, walkAst } from '../../ast.js'
import { collectWrites, laneAccess } from './addr-model.js'
import { arrayPointers, linearIndex } from './alias.js'
import { accessOf, constOf, deadTees, hasOp, inertFor, localGetCounts, localReads, memarg, resolveAddr, sameBase, windowDefs, clone, TEE } from './access.js'
import { f64Zero, forEachLocalDef, isArr, localGetName } from './node-utils.js'

const matchF64MulLocals = n => {
  if (!isArr(n) || n[0] !== 'f64.mul') return null
  const a = localGetName(n[1])
  const b = localGetName(n[2])
  return a && b ? [a, b] : null
}

const matchAccumStep = (n, acc) => {
  if (!isArr(n) || n[0] !== 'local.set' || n[1] !== acc) return null
  const e = n[2]
  if (!isArr(e) || e[0] !== 'f64.add') return null
  if (localGetName(e[1]) === acc) return matchF64MulLocals(e[2])
  if (localGetName(e[2]) === acc) return matchF64MulLocals(e[1])
  return null
}

const matchDotStore = (n, acc) => {
  if (!isArr(n) || n[0] !== 'local.set' || typeof n[1] !== 'string') return null
  const e = n[2]
  if (localGetName(e) === acc) return { out: n[1], addend: null }
  if (!isArr(e) || e[0] !== 'f64.add') return null
  if (localGetName(e[1]) === acc) return { out: n[1], addend: e[2] }
  if (localGetName(e[2]) === acc) return { out: n[1], addend: e[1] }
  return null
}

// Unroll width this dot-product recognizer expects: a `acc=0` reset, exactly this
// many `acc += L[k]*R[k]` steps, then the store. Tied to the emitter's 4-wide dot
// unroll — matchDotStore / f64x2Pair / dotPairExpr below are hardwired to it.
const DOT_UNROLL = 4

const matchF64DotSeq = (stmts, i) => {
  const reset = stmts[i]
  if (!isArr(reset) || reset[0] !== 'local.set' || typeof reset[1] !== 'string' || !f64Zero(reset[2])) return null
  const acc = reset[1]
  const left = [], right = []
  for (let k = 0; k < DOT_UNROLL; k++) {
    const pair = matchAccumStep(stmts[i + 1 + k], acc)
    if (!pair) return null
    left.push(pair[0])
    right.push(pair[1])
  }
  const store = matchDotStore(stmts[i + 1 + DOT_UNROLL], acc)
  return store ? { end: i + 2 + DOT_UNROLL, acc, zero: reset[2], left, right, ...store } : null
}

const f64x2Pair = (lo, hi) => ['f64x2.replace_lane', 1, ['f64x2.splat', ['local.get', lo]], ['local.get', hi]]

// Build the 2-lane dot expression `a0*p0 + a1*p1 + a2*p2 + a3*p3`.
// Default: explicit mul/add pairs (one rounding per op) — bit-identical to the
// scalar `a*b+c` a JS engine emits. With `useRelaxedFma`, each accumulate folds
// to `f64x2.relaxed_madd(splat(a[i]), p[i], acc)` — one VFMADD instruction with
// a single rounding. Faster and more accurate, but the fused rounding diverges
// from the non-fused reference (the bench `fma` parity class). Opt-in only.
// The scalar sum starts from its reset: `+0 + p0` is +0 where p0 is -0, so a +0
// reset is added first (a -0 one adds nothing: `-0 + x` is x).
const dotPairExpr = (a, pairs, useRelaxedFma = false, plusZero = false) => {
  const zero = ['v128.const', 'i64x2', '0', '0']
  let expr = useRelaxedFma && plusZero ? ['f64x2.relaxed_madd', ['f64x2.splat', ['local.get', a[0]]], pairs[0], zero]
    : ['f64x2.mul', ['f64x2.splat', ['local.get', a[0]]], pairs[0]]
  if (plusZero && !useRelaxedFma) expr = ['f64x2.add', zero, expr]
  for (let i = 1; i < 4; i++) {
    expr = useRelaxedFma
      ? ['f64x2.relaxed_madd', ['f64x2.splat', ['local.get', a[i]]], pairs[i], expr]
      : ['f64x2.add', expr, ['f64x2.mul', ['f64x2.splat', ['local.get', a[i]]], pairs[i]]]
  }
  return expr
}

// SLP unification (.work/archive/vectorizer-generality-design.md §2 "SLP (#15-17) → 2"): this is
// the DOT-SEQUENCE seed tier of the unified SLP packer (`slpPairsIn`, defined after
// `slpStorePairsIn` below) — seeds on 2 adjacent `matchF64DotSeq` instances (a 4-wide
// unrolled dot reduction ending in a store) instead of `slpStorePairsIn`'s adjacent
// element-store seed. Operates on SCALAR register operands only (matchF64DotSeq's
// `left`/`right` are `local.get` names off an already scalar-replaced unrolled dot, e.g.
// mat4's cells) — no memory access at all, so unlike the store-pair tier it needs no
// aliasing/typed-view gate; always tried. Kept as its own matcher rather than rewritten
// into `slpPackF64x2`'s general recursive walker: its 0/130 corpus reach (census §9 row
// 18, "unknown(precondition)") means there is no specimen to validate a widened match
// surface against, and the byte-identical gate would have no way to distinguish a sound
// generalization from an unintended new-vectorization case — folded in AS-IS (design's own
// instruction: "do not debug or delete it standalone").
// The pair computes both dots before either output lands, keeps one copy of the addend and
// of each lane pair for the whole list, and drops every write of the accumulator: the two
// dots must not read the first's output or each other's accumulator, the addend must be
// register arithmetic (evaluated once, before both), a kept copy must read nothing written
// since it was made, and nothing past the pair may read the accumulator it no longer sets.
const dotPairHolds = (fn, node, i, a, b) => {
  const acc = a.acc
  if (a.out === acc || b.out === acc || a.left.includes(a.out) || b.right.includes(a.out)) return false
  if (a.addend && (!slpSplatSafe(a.addend) || localReads(a.addend).has(acc) || localReads(a.addend).has(a.out))) return false
  const after = laneAccess(node.slice(b.end), acc)
  if (after) return after === 'write'
  let elsewhere = false
  walkAst(fn, { enter: (x, parent) => { if (parent === node || elsewhere) return false; if (x[0] === 'local.get' && x[1] === acc) elsewhere = true } })
  return !elsewhere && laneAccess(node.slice(1, i), acc) !== 'read'
}
// A kept copy (`memo` name → { tmp, def, reads }) still holds its value at `i` when no
// statement since its definition writes what it read.
const keptAt = (node, memo, key, i) => {
  const m = memo.get(key)
  if (!m) return null
  const from = node.indexOf(m.def), written = new Set()
  for (let j = from + 1; j < i; j++) collectWrites(node[j], written)
  for (const r of m.reads) if (written.has(r)) return null
  return m.tmp
}
const vectorizeStraightLineF64DotPairsIn = (node, fnLocals, freshIdRef, newLocalDecls, useRelaxedFma = false, fn = node) => {
  if (!isArr(node)) return
  for (let i = 0; i < node.length; i++) {
    const child = node[i]
    if (isArr(child)) vectorizeStraightLineF64DotPairsIn(child, fnLocals, freshIdRef, newLocalDecls, useRelaxedFma, fn)
  }
  // Allocate dedup tables only after this statement list proves it contains a
  // packable pair. Most compiler IR nodes never contain a dot seed; eagerly
  // allocating two Maps at every recursive node dominated self-hosted SLP.
  let addendTemps = null
  let pairTemps = null
  for (let i = 0; i < node.length;) {
    const a = matchF64DotSeq(node, i)
    if (!a) { i++; continue }
    const b = matchF64DotSeq(node, a.end)
    if (!b || a.acc !== b.acc || !exprEq(a.left, b.left) || !exprEq(a.addend, b.addend) ||
        fnLocals.get(a.out) !== 'f64' || fnLocals.get(b.out) !== 'f64' || !dotPairHolds(fn, node, i, a, b)) {
      i++
      continue
    }
    addendTemps ||= new Map()
    pairTemps ||= new Map()
    const v = `$__dot2_${freshIdRef.next++}`
    newLocalDecls.push(['local', v, 'v128'])
    fnLocals.set(v, 'v128')
    let prefix = []
    let addend = a.addend
    if (addend) {
      const key = nodeKey(addend)
      let tmp = keptAt(node, addendTemps, key, i)
      if (!tmp) {
        tmp = `$__dotadd_${freshIdRef.next++}`
        const def = ['local.set', tmp, addend]
        addendTemps.set(key, { tmp, def, reads: localReads(addend) })
        newLocalDecls.push(['local', tmp, 'f64'])
        fnLocals.set(tmp, 'f64')
        prefix = [def]
      }
      addend = ['local.get', tmp]
    }
    const pairs = []
    for (let k = 0; k < DOT_UNROLL; k++) {
      const key = `${a.right[k]}\0${b.right[k]}`
      let tmp = keptAt(node, pairTemps, key, i)
      if (!tmp) {
        tmp = `$__dotpair_${freshIdRef.next++}`
        const def = ['local.set', tmp, f64x2Pair(a.right[k], b.right[k])]
        pairTemps.set(key, { tmp, def, reads: new Set([a.right[k], b.right[k]]) })
        newLocalDecls.push(['local', tmp, 'v128'])
        fnLocals.set(tmp, 'v128')
        prefix.push(def)
      }
      pairs.push(['local.get', tmp])
    }
    const dot = dotPairExpr(a.left, pairs, useRelaxedFma, Object.is(Number(a.zero[1]), 0))
    const expr = addend ? ['f64x2.add', dot, ['f64x2.splat', addend]] : dot
    node.splice(i, b.end - i,
      ...prefix,
      ['local.set', v, expr],
      ['local.set', a.out, ['f64x2.extract_lane', 0, ['local.get', v]]],
      ['local.set', b.out, ['f64x2.extract_lane', 1, ['local.get', v]]],
    )
    i += prefix.length + 3
  }
}

// =============================================================================
// Loop-invariant partial-product hoist for unrolled f64 dot reductions.
//
// A fully-unrolled inner reduction over scalar-replaced array cells (mat4's
// `out[r][c] = Σ a[r][k]·b[k][c]`) lives in the body of an OUTER loop that
// mutates only a few of those cells (mat4: a[0],a[5],b[0],b[5]). Every product
// whose two operands are both outer-loop-invariant is therefore the SAME every
// iteration — yet the body recomputes all of them. rust/LLVM precomputes those
// invariant partials in a loop prologue (mat4.rs → ~294 lines before its loop);
// V8/wasmtime/JSC cannot, because at the wasm level they can't prove the cells
// are loop-invariant (no aliasing model). So jz must hoist them itself.
//
// Splitting `s = t0+t1+t2+t3` into `INV = Σ(invariant tk)` (hoisted) + `Σ(variant
// tk)` (kept) REASSOCIATES the float sum — invariant terms are summed first,
// regardless of original position — so results differ by ULPs from the strict
// left-to-right order. That is the SAME class of reorder jz already ships for
// horizontal/multi-accumulator reductions (policy at lines ~620 and ~1584), and
// rust itself does it at -O3 without fast-math. Gated to the relaxedFloat/speed
// tier exactly like those, so strict opts keep bit-exact order.
//
// Surgical by construction: fires only on a dot that MIXES invariant and variant
// terms inside a loop. A pure-variant dot (a real matmul kernel, every operand
// streaming) has no invariant term → untouched. Runs BEFORE the dot-pair
// vectorizer; a hoisted dot has < DOT_UNROLL accumulate steps so matchF64DotSeq
// no longer matches it — it stays the (faster here) scalar form, like rust.
const hoistDotInvariant = (loop, parent, idx, fnLocals, freshIdRef, newLocalDecls) => {
  const writeSet = new Set()
  collectWrites(loop, writeSet)
  const isInv = name => typeof name === 'string' && !writeSet.has(name) && fnLocals.get(name) === 'f64'
  const invInits = []
  const processList = (list) => {
    for (let i = 0; i < list.length;) {
      const seq = matchF64DotSeq(list, i)
      if (!seq) { i++; continue }
      const invKs = [], varKs = []
      for (let k = 0; k < DOT_UNROLL; k++) (isInv(seq.left[k]) && isInv(seq.right[k]) ? invKs : varKs).push(k)
      if (invKs.length === 0) { i = seq.end; continue }  // nothing loop-invariant — leave for the vectorizer
      // (a product of the sum itself, `s += s * y`, reads what the reorder changes: not a reassociation)
      if (seq.left.includes(seq.acc) || seq.right.includes(seq.acc)) { i = seq.end; continue }
      // INV = Σ invariant products, in original k-order, computed once before the loop, from
      // the reset's own zero (a -0 start keeps a sum of -0 products -0).
      let inv = ['f64.const', seq.zero[1]]
      for (const k of invKs) inv = ['f64.add', inv, ['f64.mul', ['local.get', seq.left[k]], ['local.get', seq.right[k]]]]
      const invName = `$__rinv_${freshIdRef.next++}`
      newLocalDecls.push(['local', invName, 'f64']); fnLocals.set(invName, 'f64')
      invInits.push(['local.set', invName, inv])
      // In-loop: seed acc with INV, add only the variant products, then the unchanged store.
      const repl = [['local.set', seq.acc, ['local.get', invName]]]
      for (const k of varKs) repl.push(['local.set', seq.acc, ['f64.add', ['local.get', seq.acc], ['f64.mul', ['local.get', seq.left[k]], ['local.get', seq.right[k]]]]])
      repl.push(['local.set', seq.out, seq.addend ? ['f64.add', ['local.get', seq.acc], seq.addend] : ['local.get', seq.acc]])
      list.splice(i, seq.end - i, ...repl)
      i += repl.length
    }
  }
  walkAst(loop, { enter: n => { if (isArr(n)) processList(n) } })
  if (invInits.length) parent.splice(idx, 0, ...invInits)
}

// Walk a function, hoisting invariant reduction partials out of each loop. Inner
// loops first (post-order) so a dot is hoisted relative to its tightest enclosing
// loop, and an already-rewritten dot can't re-match in an outer pass.
export const hoistReductionInvariantsIn = (fn, fnLocals, freshIdRef, newLocalDecls) => {
  walkAst(fn, { exit: (node, parent, idx) => {
    if (node[0] === 'loop' && isArr(parent)) hoistDotInvariant(node, parent, idx, fnLocals, freshIdRef, newLocalDecls)
  } })
}

// =============================================================================
// SLP (superword-level parallelism): pack two ADJACENT isomorphic f64 element
// stores into one f64x2 store — the WITHIN-iteration 2-lane class the loop
// vectorizer (which packs ACROSS iterations) structurally cannot reach.
//
// Soundness has TWO obligations, because the pack reorders memory: it materializes
// BOTH lane values BEFORE either store, turning [read0, write0, read1, write1] into
// [read0, read1, write0, write1].
//   1. CROSS-base aliasing — guarded by one module fact: no typed-array VIEW exists
//      (`ctx.linkDemand.typedView` false, checked at the dispatch, vectorize/index.js). A view (subarray /
//      buffer-backed ctor) is the only way two DISTINCT typed bases can overlap;
//      without one, distinct bases own disjoint allocations and can't alias.
//   2. Read-after-write — the high value (read1) must not load the slot the low store
//      writes (write0), or the pack reads write0's PRE-store value. Through the same
//      base (`o[k+1]=o[k]; o[k+2]=o[k+1]`, a forward shift) and through any other: two
//      names can be one array (`multiply(m, m, x)`), so a load at the low store's slot
//      offset is a hazard whatever its base (slpReadsSlot). The own-index map reads its
//      OWN slot, one above, so it survives; so does the field-first idiom, whose values
//      read locals loaded before every store.
// The pack is admitted ONLY when overhead-free (adjacent loads → v128.load, a pair of
// field locals → their v128 (below), identical pure scalar → splat, matching op →
// recurse); anything that would need a per-lane `replace_lane` build bails, which makes
// the rewrite both PROFITABLE and unable to grow code. Every f64x2 lane op is
// bit-identical to its scalar f64 op (IEEE element-wise), so the result is byte-equal
// to the scalar form.
// =============================================================================
const F64X2_BIN = { 'f64.add': 'f64x2.add', 'f64.sub': 'f64x2.sub', 'f64.mul': 'f64x2.mul', 'f64.div': 'f64x2.div', 'f64.min': 'f64x2.min', 'f64.max': 'f64x2.max' }
const F64X2_UN = { 'f64.neg': 'f64x2.neg', 'f64.abs': 'f64x2.abs', 'f64.sqrt': 'f64x2.sqrt' }
// How many statements apart a store and the staging of its value may sit.
const SLP_WINDOW = 8

// The subtree's value is the SAME evaluated once (splat) or twice (the two source
// statements, which are adjacent — no store/reassign between): a pure, side-effect-free,
// DETERMINISTIC expression. Rejects calls (a `new TypedArray()` alloc returns a fresh
// pointer per call — splatting it would make the two lanes ALIAS, the array-literal
// scatter miscompile), loads, and any store/set/memory op.
const slpSplatSafe = (n) => {
  let unsafe = false
  walkAst(n, { enter: x => {
    if (unsafe) return false
    const op = x[0]
    if (typeof op !== 'string') { unsafe = true; return false }
    if (op.startsWith('call') || op.includes('.load') || op.includes('.store')
        || op === 'local.set' || op === 'local.tee' || op === 'global.set'
        || op.startsWith('memory.') || op.includes('.atomic.')) { unsafe = true; return false }
  } })
  return !unsafe
}

// Whether `value`, evaluated at statement `at` of the window `w`, may load a byte the low
// store `u0` writes, through any name (obligation 2). Each address is an allocation's start
// (`pointerOf`, or a global array) plus an index: two starts are one array or two disjoint
// ones, so the bytes meet only where the indices do, with the starts taken equal. Equal
// indices meet where the constants do; indices apart by multiples of g (`x[4 * i + 1]`
// against `x[4 * j + 2]`) meet where the constants' difference does modulo g; an address with
// no start found (`x[i]` against `y[j]` through locals the proof does not take) may meet any.
// A low store within an allocation the window makes (`p = __alloc_hdr(2, 2)`, a Map entry's
// pair) is met by no address made of what the window held before it: the allocator hands
// out bytes no live value points into.
const LOAD_WIDTH = { 'f64.load': 8, 'i64.load': 8, 'f32.load': 4, 'i32.load': 4 }
// (the bytes past the pointer an allocation returns: module/core.js __alloc_hdr, __alloc_hdr_n)
const allocBytes = e => e[1] === '$__alloc_hdr' ? constOf(e[3]) * 8 : e[1] === '$__alloc_hdr_n' ? constOf(e[3]) * constOf(e[4]) : NaN
// a local of a resolved address (access.js resolveAddr) as [name, the statement of its window
// definition, or -1 for a value from before the window]
const defSite = n => { const [name, at] = String(n[1]).split('@'); return [name, at === undefined ? -1 : Number(at)] }
const slpMayReadSlot = (value, u0, at, w, pointerOf) => {
  const isStart = n => isArr(n) && (n[0] === 'global.get' || n[0] === 'local.get' && pointerOf(String(n[1]).split('@')[0]))
  // the address `b` at statement `k` as { start, form }, its start's term dropped from the form
  const split = (b, k) => {
    const r = resolveAddr(b, w, k)
    if (!r) return null
    const form = linearIndex(r)
    let start = null
    for (const t of form.terms.values()) if (t.coeff === 1 && isStart(t.node)) { if (start) return null; start = t }
    if (!start) return null
    form.terms.delete(start.key)
    form.start = start.node
    return form
  }
  const S = split(u0.base, u0.at)
  // the statement of the window's allocation the low store writes within, or -1
  const [name, made] = S && !S.terms.size && isArr(S.start) && S.start[0] === 'local.get' ? defSite(S.start) : ['', -1]
  const d = made >= 0 && w.defs.get(name), e = d && d.at === made && d.e
  const fresh = isArr(e) && e[0] === 'call' && S.k + u0.off >= 0 && S.k + u0.off + 8 <= allocBytes(e) ? made : -1
  // (every local the address reads holds a value from before that statement)
  const before = r => {
    let ok = true
    walkAst(r, { enter: n => { if (!ok) return false; if (n[0] === 'local.get' && defSite(n)[1] >= fresh) ok = false } })
    return ok
  }
  let hit = false
  walkAst(value, { enter: n => {
    if (hit || !isArr(n)) return false
    if (typeof n[0] !== 'string' || !n[0].includes('.load')) return
    const a = accessOf(n), width = LOAD_WIDTH[n[0]] ?? (/8/.test(n[0]) ? 1 : /16/.test(n[0]) ? 2 : /32/.test(n[0]) ? 4 : 16)
    if (fresh >= 0) { const r = resolveAddr(a.base, w, at); if (r && before(r)) return false }
    const L = !sameBase(a.base, at, u0.base, u0.at, w) && split(a.base, at)
    if (L === null || L && !S) { hit = true; return false }
    // the load's bytes less the store's: c plus a multiple of g (g a power of two, as 2^32 is)
    let c = a.off - u0.off, g = 0
    if (L) {
      c += L.k - S.k
      const coeffs = new Map()
      for (const t of L.terms.values()) coeffs.set(t.key, t.coeff)
      for (const t of S.terms.values()) coeffs.set(t.key, (coeffs.get(t.key) || 0) - t.coeff)
      for (const k of coeffs.values()) if (k) g = g ? gcd(g, Math.abs(k)) : Math.abs(k)
      g = g & -g
    }
    // (some c + g * m within (-width, 8): the two accesses overlap)
    const r = g ? ((c % g) + g) % g : c
    if (g ? r < 8 || r - g > -width : c > -width && c < 8) hit = true
  } })
  return hit
}
const gcd = (a, b) => b ? gcd(b, a % b) : a

// ---- Field pairs ---------------------------------------------------------------
// A kernel that loads its operands' fields into locals first (`ax = a[0], ay = a[1]`,
// the alias-safe idiom every vector and matrix library writes) leaves the packer no
// adjacent loads: each lane leaf is a different local. Two locals defined once each,
// by loads of consecutive slots with only staging or other loads between (no store, no
// call but a guard), are one v128 loaded beside them: a lane pair of those two locals
// reads it. The v128 is loaded only where a pack uses it, right after the second scalar
// — same memory, no write between, one definition each — so it equals [X, Y] wherever
// the scalars are read.
const slpFieldPairs = (fn) => {
  const sets = new Map()
  forEachLocalDef([fn], name => sets.set(name, (sets.get(name) || 0) + 1))
  const loadDef = s => isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && sets.get(s[1]) === 1
    && isArr(s[2]) && s[2][0] === 'f64.load' ? { name: s[1], ...accessOf(s[2]) } : null
  const none = new Set()
  const pairs = new Map()
  walkAst(fn, { enter: list => {
    for (let j = 1; j + 1 < list.length; j++) {
      const x = loadDef(list[j])
      if (!x || x.off < 0) continue
      for (let k = j + 1; k < list.length && k - j <= SLP_WINDOW; k++) {
        const y = loadDef(list[k])
        if (y && y.off - x.off === 8 && sameBase(x.base, j, y.base, k, windowDefs(list, Math.max(1, j - SLP_WINDOW), k))) {
          // The v128 reads through the second scalar's base: its tee, or a copy of a tee-free expression.
          const base = y.base[0] === 'local.tee' ? ['local.get', y.base[1]] : hasOp(y.base, TEE) ? null : clone(y.base)
          if (base) pairs.set(x.name + '\0' + y.name, { off: x.off, base, x: list[j], y: list[k], list })
          break
        }
        if (!inertFor(list[k], none)) break
      }
    }
  } })
  return pairs
}
// Load every pair a pack took, after its second scalar; drop a scalar nothing reads any
// more, whose address tees nothing read either (the v128 load covers its bytes, so it
// traps exactly where the scalar would).
const slpPlaceFieldPairs = (fn, sp) => {
  const used = [...sp.pairs.values()].filter(p => p.name)
  if (!used.length) return
  for (const p of used) {
    const k = p.list.indexOf(p.y)
    if (k < 0) throw new Error('slp: a field pair lost its definition')
    p.list.splice(k + 1, 0, ['local.set', p.name, memarg('v128.load', p.off, p.base)])
  }
  const counts = localGetCounts(fn)
  const dead = s => !counts.has(s[1]) && deadTees(s[2], counts)
  for (const p of used) for (const s of [p.x, p.y]) {
    if (!dead(s)) continue
    const k = p.list.indexOf(s)
    if (k >= 0) p.list.splice(k, 1)
  }
}

// A NaN-canonicalized lane — `select(C, X, ne(X, X))`, a Number entering generic
// storage — with X staged in a temp the test alone reads (the result may tee it once
// more, unread): { val: X, C }, else null. `own` is the lane's refilled local: a temp
// of that name may be read elsewhere too, since those reads see the refill.
const slpCanonLane = (n, counts, own) => {
  let sel = n, outer = null
  if (isArr(sel) && sel[0] === 'local.tee' && sel.length === 3) { outer = sel[1]; sel = sel[2] }
  if (!isArr(sel) || sel[0] !== 'select' || sel.length !== 4) return null
  const [, C, x, test] = sel
  if (!(isArr(C) && (C[0] === 'f64.const' && String(C[1]).toLowerCase() === 'nan' || C[0] === 'global.get'))) return null
  if (!(isArr(test) && test[0] === 'f64.ne' && isArr(x) && x[0] === 'local.tee' && x.length === 3)) return null
  const t = x[1]
  if (localGetName(test[1]) !== t || localGetName(test[2]) !== t || counts.get(t) !== 2 && t !== own) return null
  if (outer !== null && outer !== t && counts.has(outer)) return null
  return { val: x[2], C }
}

// Pack two isomorphic f64 trees [lo, hi] into an f64x2 value, or null if it isn't
// overhead-free (adjacent loads → v128.load, a field pair → its v128, identical pure
// scalar → splat, matching op → recurse). The overhead-free restriction is what makes it
// both profitable and unable to grow code; every f64x2 lane op is bit-identical to its
// scalar f64 op. `ownLo`/`ownHi` name the top-level lanes' refilled locals.
const slpPackF64x2 = (lo, hi, sp, ownLo, ownHi) => {
  if (!isArr(lo) || !isArr(hi)) return null
  if (lo[0] === 'f64.load' && hi[0] === 'f64.load') {
    const a = accessOf(lo), b = accessOf(hi)
    // The high address dissolves into the pack: a tee there must define a local nothing reads.
    if (a.off < 0 || b.off - a.off !== 8 || !deadTees(b.addr, sp.getCounts) || !sameBase(a.base, 0, b.base, 1, windowDefs([lo, hi], 0, 1))) return null
    return memarg('v128.load', a.off, a.base)
  }
  const x = localGetName(lo), y = localGetName(hi)
  if (x && y && x !== y) {
    const p = sp.pairs.get(x + '\0' + y)
    if (!p) return null
    if (!p.name) { p.name = `$__slpp${sp.freshIdRef.next++}`; sp.touched.push(p) }
    return ['local.get', p.name]
  }
  if (exprEq(lo, hi) && slpSplatSafe(lo)) return ['f64x2.splat', lo]
  // Two canonicalized lanes: the pair of their values, canonicalized per lane — the
  // scalar selects' bits exactly (C in a NaN lane, the value elsewhere).
  const cl = slpCanonLane(lo, sp.getCounts, ownLo), ch = cl && slpCanonLane(hi, sp.getCounts, ownHi)
  if (cl && ch && exprEq(cl.C, ch.C)) {
    const v = slpPackF64x2(cl.val, ch.val, sp)
    if (!v) return null
    const t = `$__slpc${sp.freshIdRef.next++}`
    sp.pendingLocals.push(t)
    return ['v128.bitselect', ['f64x2.splat', cl.C], ['local.tee', t, v], ['f64x2.ne', ['local.get', t], ['local.get', t]]]
  }
  if (lo[0] === hi[0]) {
    const bin = F64X2_BIN[lo[0]]
    if (bin && lo.length === 3 && hi.length === 3) {
      const a = slpPackF64x2(lo[1], hi[1], sp); if (!a) return null
      const b = slpPackF64x2(lo[2], hi[2], sp); return b ? [bin, a, b] : null
    }
    const un = F64X2_UN[lo[0]]
    if (un && lo.length === 2 && hi.length === 2) {
      const a = slpPackF64x2(lo[1], hi[1], sp); return a ? [un, a] : null
    }
  }
  return null
}

// The element store at `stmts[i]`: its slot, its value and the statement that stages the
// value. jz stages a store's value and base in temps — `(local.set $v V) (local.set $b B)
// … (f64.store (local.get $b) (local.get $v))` — so the value temp resolves to V when
// every statement between its definition and the store is inert for V and reads no
// `$v`: the pack evaluates V at the store. A temp read elsewhere too (a forwarded
// load) is `keep`: the pack refills it from its lane.
const slpUnitAt = (stmts, i, getCounts) => {
  const s = stmts[i]
  if (!isArr(s) || s[0] !== 'f64.store') return null
  const a = accessOf(s)
  const u = { at: i, off: a.off, base: a.base, addr: a.addr, value: a.val, def: -1, keep: null }
  const t = localGetName(a.val)
  if (t && getCounts.has(t)) for (let j = i - 1; j >= 1 && i - j <= SLP_WINDOW; j--) {
    const d = stmts[j]
    if (!isArr(d) || d[0] !== 'local.set' || d[1] !== t) continue
    const reads = localReads(d[2])
    let inert = true
    for (let k = j + 1; k < i && inert; k++) inert = inertFor(stmts[k], reads) && !localReads(stmts[k]).has(t)
    if (inert) { u.value = d[2]; u.def = j; u.keep = getCounts.get(t) > 1 ? t : null }
    break
  }
  // A value teed into a local read elsewhere (a forwarded load) is `keep` too, unless
  // the address reads it: the refill lands before the packed store's address.
  const v = u.value
  if (!u.keep && isArr(v) && v[0] === 'local.tee' && v.length === 3 && getCounts.has(v[1]) && !localReads(u.addr).has(v[1])) { u.keep = v[1]; u.value = v[2] }
  return u
}

// Rewrite two element stores one f64 apart with isomorphic values into a single v128
// store at the low store's place. The packed value is computed into a fresh v128 local
// FIRST, then stored — preserving jz's value-before-address evaluation order (the store
// address can read a `local.tee` the value defines, e.g. the shared `i<<3` offset). The
// low store's address stays (its tee that defines the shared pointer is kept); the high
// store, its value and the staging of its base dissolve into the high lane. Sound only
// under the no-view gate at dispatch.
const slpStorePairsIn = (node, sp) => {
  if (!isArr(node)) return
  for (let i = 1; i < node.length; i++) if (isArr(node[i])) slpStorePairsIn(node[i], sp)
  for (let i = 1; i < node.length; i++) {
    const u0 = slpUnitAt(node, i, sp.getCounts)
    if (!u0 || u0.off < 0) continue
    let k = i + 1
    while (k < node.length && k - i <= SLP_WINDOW && !(isArr(node[k]) && node[k][0] === 'f64.store')) k++
    const u1 = k < node.length ? slpUnitAt(node, k, sp.getCounts) : null
    if (!u1 || u1.off - u0.off !== 8 || u1.def >= 0 && u1.def <= i || !deadTees(u1.addr, sp.getCounts)) continue
    const lo = u0.def >= 0 ? u0.def : i
    if (!sameBase(u0.base, i, u1.base, k, windowDefs(node, Math.max(1, lo - SLP_WINDOW), k))) continue
    // Between the stores: the high value moves up, the high store moves up to the low one;
    // the high refill moves up too — before the low address, past the high value.
    const reads = new Set([...localReads(u0.value), ...localReads(u1.value)])
    if (u1.keep) reads.add(u1.keep)
    if (u0.keep && localReads(u1.value).has(u0.keep) || u1.keep && localReads(u0.addr).has(u1.keep)) continue
    let inert = true
    for (let j = i + 1; j < k && inert; j++) inert = j === u1.def || inertFor(node[j], reads, true) && !(u1.keep && localReads(node[j]).has(u1.keep))
    if (!inert || slpMayReadSlot(u1.value, u0, u1.def >= 0 ? u1.def : k, windowDefs(node, Math.max(1, lo - SLP_WINDOW), k), sp.pointerOf)) continue
    sp.touched = []
    sp.pendingLocals = []
    const packed = slpPackF64x2(u0.value, u1.value, sp, u0.keep, u1.keep)
    // A pair the pack named stays a pair only with the pack: an abandoned pack unnames it.
    if (!packed) { for (const p of sp.touched) p.name = null; continue }
    for (const p of sp.touched) { sp.newLocalDecls.push(['local', p.name, 'v128']); sp.fnLocals.set(p.name, 'v128') }
    for (const name of sp.pendingLocals) { sp.newLocalDecls.push(['local', name, 'v128']); sp.fnLocals.set(name, 'v128') }
    const t = `$__slp${sp.freshIdRef.next++}`
    sp.newLocalDecls.push(['local', t, 'v128']); sp.fnLocals.set(t, 'v128')
    const baseReads = localReads(u1.addr)
    // High index first, so the lower indices stay valid.
    node.splice(k, 1)
    for (let j = k - 1; j > i; j--) {
      const d = node[j]
      if (j === u1.def || isArr(d) && d[0] === 'local.set' && baseReads.has(d[1]) && sp.getCounts.get(d[1]) === 1) node.splice(j, 1)
    }
    const refill = [u0, u1].flatMap((u, lane) => u.keep ? [['local.set', u.keep, ['f64x2.extract_lane', lane, ['local.get', t]]]] : [])
    node.splice(i, 1, ['local.set', t, packed], ...refill, memarg('v128.store', u0.off, u0.base, ['local.get', t]))
    if (u0.def >= 0) { node.splice(u0.def, 1); i-- }
    i += 1 + refill.length
  }
}

// jz stages a canonicalized store value in two statements — `(local.set $c X)` then
// `(local.set $v (select C (local.get $c) (f64.ne (local.get $c) (local.get $c))))`.
// Adjacent, they are one: `(local.set $v (select C (local.tee $c X) (f64.ne …)))`
// evaluates the same (C is a constant), and the store packer sees the lane whole.
// Only a value an element store reads: a reduction keeps its own shape.
const fuseCanonStaging = (node, stored) => {
  if (!isArr(node)) return
  for (let i = 1; i < node.length; i++) if (isArr(node[i])) fuseCanonStaging(node[i], stored)
  for (let i = node.length - 1; i > 1; i--) {
    const a = node[i - 1], b = node[i]
    if (!(isArr(a) && a[0] === 'local.set' && a.length === 3 && isArr(b) && b[0] === 'local.set' && b.length === 3 && b[1] !== a[1])) continue
    if (!stored.has(b[1])) continue
    const c = a[1], sel = b[2]
    if (isArr(sel) && sel[0] === 'select' && sel.length === 4 && localGetName(sel[2]) === c &&
        isArr(sel[1]) && (sel[1][0] === 'f64.const' || sel[1][0] === 'global.get') &&
        isArr(sel[3]) && sel[3][0] === 'f64.ne' && localGetName(sel[3][1]) === c && localGetName(sel[3][2]) === c)
      node.splice(i - 1, 2, ['local.set', b[1], ['select', sel[1], ['local.tee', c, a[2]], sel[3]]])
  }
}

// ---- Unified SLP recognizer (dispatch entry) --------------------------------
//
// Design §2 "SLP (#15-17) → 2 (1 general pack + 1 generalized LICM)": the two PACKERS
// (`vectorizeStraightLineF64DotPairsIn`'s dot-sequence seed, `slpStorePairsIn`'s
// element-store seed) are both instances of classic bottom-up SLP — seed on 2 adjacent
// isomorphic roots, pack when both operand trees match (`slpPackF64x2` does the shared
// recursive walk for both). Folded into ONE entry point here: same call order as before
// the merge (dot-sequence tier — unconditional, no memory aliasing — then the
// element-store tier, gated by `slp`, which the dispatch clears where a typed view exists, for aliasing safety), so this is a
// pure entry-point consolidation — behavior is unchanged by construction.
// `hoistReductionInvariantsIn` is NOT folded in here — it is a different transform
// category (LICM: reassociating hoist of loop-invariant partial products, not a packer;
// design §2 keeps it distinct) and is called separately, before this, at the dispatch.
export function slpPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFma, slp) {
  let hasF64Mul = false
  let f64Stores = 0
  walkAst(fn, { enter: node => {
    if (node[0] === 'f64.mul') hasF64Mul = true
    else if (node[0] === 'f64.store') f64Stores++
  } })
  // Necessary-op gates keep scalar/compiler functions out of both recursive
  // SLP walkers. They only reject functions that cannot contain either seed.
  if (hasF64Mul) vectorizeStraightLineF64DotPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFma)
  if (f64Stores >= 2 && slp) {
    const stored = new Set()
    walkAst(fn, { enter: n => { if (n[0] === 'f64.store') { const v = localGetName(n[n.length - 1]); if (v) stored.add(v) } } })
    fuseCanonStaging(fn, stored)
    const sp = { fnLocals, freshIdRef, newLocalDecls: newLocalDeclsAll, getCounts: localGetCounts(fn), pairs: slpFieldPairs(fn), touched: [], pendingLocals: [], pointerOf: arrayPointers(fn) }
    slpStorePairsIn(fn, sp)
    slpPlaceFieldPairs(fn, sp)
  }
}

// ---- Lane type tables ------------------------------------------------------
