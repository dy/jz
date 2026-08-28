import { assembleView } from '../../session-views.js'
import { nodeEqual as exprEq, walkAst } from '../../ast.js'
import { collectWrites } from './addr-model.js'
import { f64Zero, isArr, localGetName } from './node-utils.js'

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
  return store ? { end: i + 2 + DOT_UNROLL, acc, left, right, ...store } : null
}

const f64x2Pair = (lo, hi) => ['f64x2.replace_lane', 1, ['f64x2.splat', ['local.get', lo]], ['local.get', hi]]

// Build the 2-lane dot expression `a0*p0 + a1*p1 + a2*p2 + a3*p3`.
// Default: explicit mul/add pairs (one rounding per op) — bit-identical to the
// scalar `a*b+c` a JS engine emits. With `useRelaxedFma`, each accumulate folds
// to `f64x2.relaxed_madd(splat(a[i]), p[i], acc)` — one VFMADD instruction with
// a single rounding. Faster and more accurate, but the fused rounding diverges
// from the non-fused reference (the bench `fma` parity class). Opt-in only.
const dotPairExpr = (a, pairs, useRelaxedFma = false) => {
  let expr = ['f64x2.mul', ['f64x2.splat', ['local.get', a[0]]], pairs[0]]
  for (let i = 1; i < 4; i++) {
    expr = useRelaxedFma
      ? ['f64x2.relaxed_madd', ['f64x2.splat', ['local.get', a[i]]], pairs[i], expr]
      : ['f64x2.add', expr, ['f64x2.mul', ['f64x2.splat', ['local.get', a[i]]], pairs[i]]]
  }
  return expr
}

// SLP unification (.work/vectorizer-generality-design.md §2 "SLP (#15-17) → 2"): this is
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
const vectorizeStraightLineF64DotPairsIn = (node, fnLocals, freshIdRef, newLocalDecls, useRelaxedFma = false) => {
  if (!isArr(node)) return
  for (let i = 0; i < node.length; i++) {
    const child = node[i]
    if (isArr(child)) vectorizeStraightLineF64DotPairsIn(child, fnLocals, freshIdRef, newLocalDecls, useRelaxedFma)
  }
  const addendTemps = new Map()
  const pairTemps = new Map()
  for (let i = 0; i < node.length;) {
    const a = matchF64DotSeq(node, i)
    if (!a) { i++; continue }
    const b = matchF64DotSeq(node, a.end)
    if (!b || a.acc !== b.acc || !exprEq(a.left, b.left) || !exprEq(a.addend, b.addend) ||
        fnLocals.get(a.out) !== 'f64' || fnLocals.get(b.out) !== 'f64') {
      i++
      continue
    }
    const v = `$__dot2_${freshIdRef.next++}`
    newLocalDecls.push(['local', v, 'v128'])
    fnLocals.set(v, 'v128')
    let prefix = []
    let addend = a.addend
    if (addend) {
      const key = JSON.stringify(addend)
      let tmp = addendTemps.get(key)
      if (!tmp) {
        tmp = `$__dotadd_${freshIdRef.next++}`
        addendTemps.set(key, tmp)
        newLocalDecls.push(['local', tmp, 'f64'])
        fnLocals.set(tmp, 'f64')
        prefix = [['local.set', tmp, addend]]
      }
      addend = ['local.get', tmp]
    }
    const pairs = []
    for (let k = 0; k < DOT_UNROLL; k++) {
      const key = `${a.right[k]}\0${b.right[k]}`
      let tmp = pairTemps.get(key)
      if (!tmp) {
        tmp = `$__dotpair_${freshIdRef.next++}`
        pairTemps.set(key, tmp)
        newLocalDecls.push(['local', tmp, 'v128'])
        fnLocals.set(tmp, 'v128')
        prefix.push(['local.set', tmp, f64x2Pair(a.right[k], b.right[k])])
      }
      pairs.push(['local.get', tmp])
    }
    const dot = dotPairExpr(a.left, pairs, useRelaxedFma)
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
// rust itself does it at -O3 without fast-math. Gated to the relaxedFma/speed
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
      // INV = Σ invariant products, in original k-order, computed once before the loop.
      let inv = ['f64.const', '0']
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
//      (`ctx.linkDemand.typedView` false, checked at the dispatch). A view (subarray /
//      buffer-backed ctor) is the only way two DISTINCT typed bases can overlap;
//      without one, distinct bases own disjoint allocations and can't alias.
//   2. WITHIN-base read-after-write — the high value (read1) must not load the low
//      store's target (write0), or the pack reads write0's PRE-store value. This is a
//      same-base hazard a view gate can't see (`o[k+1]=o[k]; o[k+2]=o[k+1]` forward
//      shift); slpReadsOffset rejects it. The sound own-index map reads its OWN offset,
//      never the sibling's, so it survives.
// The pack is admitted ONLY when overhead-free (adjacent loads → v128.load,
// identical pure scalar → splat, matching op → recurse); anything that would
// need a per-lane `replace_lane` build bails, which makes the rewrite both
// PROFITABLE and unable to grow code. Every f64x2 lane op is bit-identical to its
// scalar f64 op (IEEE element-wise), so the result is byte-equal to the scalar form.
// =============================================================================
const F64X2_BIN = { 'f64.add': 'f64x2.add', 'f64.sub': 'f64x2.sub', 'f64.mul': 'f64x2.mul', 'f64.div': 'f64x2.div', 'f64.min': 'f64x2.min', 'f64.max': 'f64x2.max' }
const F64X2_UN = { 'f64.neg': 'f64x2.neg', 'f64.abs': 'f64x2.abs', 'f64.sqrt': 'f64x2.sqrt' }

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

// Decompose a load/store node, normalizing the optional `offset=K` attribute jz
// folds adjacent accesses into: `(op addr …)` → off 0, `(op offset=K addr …)` → K.
const slpMem = (n) => {
  if (!isArr(n)) return null
  if (typeof n[1] === 'string' && n[1].startsWith('offset=')) return { off: +n[1].slice(7), addr: n[2], val: n[3] }
  return { off: 0, addr: n[1], val: n[2] }
}
// The two accesses (x = low/first, y = high/second) provably address the SAME base
// pointer. Sound shapes only — `y` must read what `x` produced, never redefine it:
//   • x = (local.tee $X e), y = (local.get $X)  — x defines the shared ptr, y reuses it
//   • x = (local.get $X),   y = (local.get $X)  — both read the same already-set local
//   • exprEq(x, y) with NEITHER a tee            — identical side-effect-free addresses
// REJECTS `(local.tee $X eA), (local.tee $X eB)` (y redefines $X to a different address
// → the high lane would write the wrong place) and `(get $X), (tee $X e)` — the watr.js
// self-compile miscompile came from accepting those by name alone.
const slpSameBase = (x, y) => {
  if (!isArr(x) || !isArr(y)) return false
  if (x[0] === 'local.tee' && y[0] === 'local.get' && typeof x[1] === 'string' && x[1] === y[1]) return true
  if (x[0] === 'local.get' && y[0] === 'local.get' && typeof x[1] === 'string' && x[1] === y[1]) return true
  return x[0] !== 'local.tee' && y[0] !== 'local.tee' && exprEq(x, y)
}

// Two address expressions name the SAME pointer base. Symmetric, tee/get-normalized
// (a `local.tee $X` defines what a `local.get $X` reads, so they're one base); else
// structural exprEq. Used by the RAW guard below — under the no-view gate, a different
// base is a different allocation, so "not same base" ⇒ provably disjoint memory.
const slpSameMem = (a, b) => {
  if (!isArr(a) || !isArr(b)) return false
  const an = (a[0] === 'local.tee' || a[0] === 'local.get') && typeof a[1] === 'string' ? a[1] : null
  const bn = (b[0] === 'local.tee' || b[0] === 'local.get') && typeof b[1] === 'string' ? b[1] : null
  if (an !== null || bn !== null) return an === bn
  return exprEq(a, b)
}

// Does `value` load the element at (addr, off) — the slot u0 stores to? SLP materializes
// BOTH packed values BEFORE either store, so if the high store's VALUE reads the low
// store's TARGET, the original (which stored low first) and the pack (which reads low's
// OLD value) diverge — a within-iteration read-after-write hazard. `o[k+1]=o[k]; o[k+2]=
// o[k+1]` is the canonical miscompile: the second value reads o[k+1], which the first
// store just wrote. (The sound own-index map `o[i]=…; o[i+1]=…` reads u1's OWN offset,
// never u0's, so it never trips this.) f64 accesses are 8-byte and 8-aligned, so two
// overlap iff their offsets are equal.
const slpReadsOffset = (value, addr, off) => {
  let hit = false
  walkAst(value, { enter: n => {
    if (hit || !isArr(n)) return false
    if (n[0] === 'f64.load') {
      const m = slpMem(n)
      if (m && m.off === off && slpSameMem(m.addr, addr)) { hit = true; return false }
    }
  } })
  return hit
}

// Pack two isomorphic f64 trees [lo, hi] into an f64x2 value, or null if it isn't
// overhead-free (adjacent loads → v128.load, identical pure scalar → splat, matching
// op → recurse). The overhead-free restriction is what makes it both profitable and
// unable to grow code; every f64x2 lane op is bit-identical to its scalar f64 op.
const slpPackF64x2 = (lo, hi) => {
  if (!isArr(lo) || !isArr(hi)) return null
  if (lo[0] === 'f64.load' && hi[0] === 'f64.load') {
    const a = slpMem(lo), b = slpMem(hi)
    if (b.off - a.off !== 8 || !slpSameBase(a.addr, b.addr)) return null
    return a.off ? ['v128.load', `offset=${a.off}`, a.addr] : ['v128.load', a.addr]
  }
  if (exprEq(lo, hi) && slpSplatSafe(lo)) return ['f64x2.splat', lo]
  if (lo[0] === hi[0]) {
    const bin = F64X2_BIN[lo[0]]
    if (bin && lo.length === 3 && hi.length === 3) {
      const x = slpPackF64x2(lo[1], hi[1]); if (!x) return null
      const y = slpPackF64x2(lo[2], hi[2]); return y ? [bin, x, y] : null
    }
    const un = F64X2_UN[lo[0]]
    if (un && lo.length === 2 && hi.length === 2) {
      const x = slpPackF64x2(lo[1], hi[1]); return x ? [un, x] : null
    }
  }
  return null
}

// Resolve the element store at `stmts[i]` to { off, addr, value, lo, hi } — the f64
// value to pack and the inclusive statement span it occupies. jz emits an element
// store in three shapes, all handled here so SLP fires both pre- and post-watr:
//   • inline           (f64.store addr V)                                  → span [i,i]
//   • flat tee'd        (local.set $t V) ; (f64.store addr (local.get $t)) → span [i-1,i]
//   • block-wrapped     (block (local.set $t V) (f64.store addr (local.get $t)))
// The tee'd value to pack is V (the definition), not the `(local.get $t)`.
const slpUnitAt = (stmts, i, getCounts) => {
  const s = stmts[i]
  if (!isArr(s)) return null
  if (s[0] === 'block' && s.length === 3
      && isArr(s[1]) && s[1][0] === 'local.set' && isArr(s[2]) && s[2][0] === 'f64.store') {
    const m = slpMem(s[2])
    if (m && isArr(m.val) && m.val[0] === 'local.get' && m.val[1] === s[1][1]) return { off: m.off, addr: m.addr, value: s[1][2], lo: i, hi: i }
    return null
  }
  if (s[0] !== 'f64.store') return null
  const m = slpMem(s)
  if (!m) return null
  // Flat tee'd: `(local.set $t V) ; (f64.store … (local.get $t))`. Resolving the value
  // to V and dropping the set is sound ONLY if $t is used nowhere else — otherwise a
  // later `(local.get $t)` reads a value we deleted (the watr.js self-compile miscompile).
  if (isArr(m.val) && m.val[0] === 'local.get' && typeof m.val[1] === 'string'
      && i > 0 && isArr(stmts[i - 1]) && stmts[i - 1][0] === 'local.set' && stmts[i - 1][1] === m.val[1]
      && getCounts.get(m.val[1]) === 1)
    return { off: m.off, addr: m.addr, value: stmts[i - 1][2], lo: i - 1, hi: i }
  return { off: m.off, addr: m.addr, value: m.val, lo: i, hi: i }
}

// Count `(local.get NAME)` occurrences across the function, so the flat-tee'd
// resolution above can confirm a store value's temp is single-use before removing it.
const slpGetCounts = (fn) => {
  const counts = new Map()
  walkAst(fn, { enter: n => {
    if (isArr(n) && n[0] === 'local.get' && typeof n[1] === 'string') counts.set(n[1], (counts.get(n[1]) || 0) + 1)
  } })
  return counts
}

// Rewrite two back-to-back element stores one f64 apart with isomorphic values into a
// single v128 store. The packed value is computed into a fresh v128 local FIRST, then
// stored — preserving jz's value-before-address evaluation order (the store address can
// read a `local.tee` the value defines, e.g. the shared `i<<3` offset). base is the LOW
// store's address (its tee that defines the shared pointer is kept); the high store +
// its value dissolve into the high lane. Sound only under the no-view gate at dispatch.
const slpStorePairsIn = (node, fnLocals, freshIdRef, newLocalDecls, getCounts) => {
  if (!isArr(node)) return
  for (let i = 0; i < node.length; i++) if (isArr(node[i])) slpStorePairsIn(node[i], fnLocals, freshIdRef, newLocalDecls, getCounts)
  for (let i = 0; i < node.length; i++) {
    const u0 = slpUnitAt(node, i, getCounts)
    if (!u0) continue
    // u1's MATCH index is its store's index, which for the flat tee'd shape is one PAST
    // its span's lo (the tee'd `local.set` precedes it) — try both hi+1 (inline/block-wrapped,
    // where lo===hi) and hi+2 (flat tee'd, where the store sits at lo+1) and keep whichever
    // yields a unit that actually starts right after u0.
    const u1 = slpUnitAt(node, u0.hi + 1, getCounts) || slpUnitAt(node, u0.hi + 2, getCounts)
    if (!u1 || u1.lo !== u0.hi + 1) continue
    if (u1.off - u0.off !== 8 || !slpSameBase(u0.addr, u1.addr)) continue
    // RAW hazard: the high store's value must not read the low store's target — the pack
    // would read its pre-store value. (u0 writes u0.off; reject if u1.value loads it.)
    if (slpReadsOffset(u1.value, u0.addr, u0.off)) continue
    const packed = slpPackF64x2(u0.value, u1.value)
    if (!packed) continue
    const t = `$__slp${freshIdRef.next++}`
    newLocalDecls.push(['local', t, 'v128']); fnLocals.set(t, 'v128')
    const store = u0.off
      ? ['v128.store', `offset=${u0.off}`, u0.addr, ['local.get', t]]
      : ['v128.store', u0.addr, ['local.get', t]]
    node.splice(u0.lo, u1.hi - u0.lo + 1, ['local.set', t, packed], store)
    i = u0.lo
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
// element-store tier, gated by `slp` + no-typed-view for aliasing safety), so this is a
// pure entry-point consolidation — behavior is unchanged by construction.
// `hoistReductionInvariantsIn` is NOT folded in here — it is a different transform
// category (LICM: reassociating hoist of loop-invariant partial products, not a packer;
// design §2 keeps it distinct) and is called separately, before this, at the dispatch.
export function slpPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFma, slp) {
  vectorizeStraightLineF64DotPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFma)
  if (slp && !assembleView().linkDemand.typedView) slpStorePairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, slpGetCounts(fn))
}

// ---- Lane type tables ------------------------------------------------------

