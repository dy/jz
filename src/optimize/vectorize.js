import { findBodyStart } from '../ir.js'
import { warn, ctx } from '../ctx.js'
import { nodeEqual as exprEq } from '../ast.js'

/**
 * Lane-local SIMD-128 vectorizer.
 *
 *   Recognizes inner loops of shape:
 *     for (let i = 0; i < N; i++) arr[i] = f(arr[i], …)
 *   where every body op is "lane-pure" — its k-th lane output depends only
 *   on k-th lane inputs. Lifts the body to SIMD-128, prefixed before the
 *   original (now tail) loop. Original loop runs the remainder.
 *
 * Design:
 *   • Lane-purity is a structural property, not a benchmark match. The op
 *     whitelist is the single source of truth (one entry per (lane-type, op)).
 *   • Lift is mechanical. The recognizer either matches the structure — in
 *     which case lifting is unambiguous — or skips. No bench-specific
 *     heuristics.
 *   • Tail loop is the original WAT, untouched. If anything regresses the
 *     SIMD recognizer just doesn't match, never miscompiles.
 *
 * Match conditions:
 *   1. (block $brk (loop $L (br_if $brk !cond) BODY (i = i+1) (br $L)))
 *   2. cond is `(i32.lt_s i BOUND)` or `i32.lt_u`; BOUND is loop-invariant.
 *   3. All loads/stores in BODY use address `(add base (shl i K))` where
 *      base is loop-invariant and K matches the elem stride. Optional
 *      enclosing `local.tee` is allowed (and reused).
 *   4. All loads share the same opcode → defines lane type.
 *   5. All other ops in BODY are in the lane-pure whitelist for that type.
 *   6. Each non-induction local in BODY is either purely loop-invariant
 *      (only read) or purely lane-local (first action is a write). Never
 *      both — that's a loop-carried scalar (reduction / stencil) → bail.
 *
 * Lift produces, before the original block:
 *     (local.set $__simd_bound{N} (i32.and BOUND (i32.const ~(LANES-1))))
 *     (block $__simd_brk{N}
 *       (loop $__simd_loop{N}
 *         (br_if $__simd_brk{N} (i32.eqz (i32.lt_s i $__simd_bound{N})))
 *         <body lifted op-by-op; lane-local locals routed to v128 shadows>
 *         (local.set $i (i32.add i (i32.const LANES)))
 *         (br $__simd_loop{N})))
 *
 * The original block runs immediately after with i pre-advanced; its own
 * `i < BOUND` guard handles the tail.
 */



const isArr = n => Array.isArray(n)

// Structural node equality — must be non-finite- AND bigint-safe: plain
// JSON.stringify maps Infinity/-Infinity/NaN→null and -0→0, so it would equate a
// `[Inf,-Inf]` lane pair and splat it (dropping -Inf). nodeEqual tags those.
const localGetName = n => isArr(n) && n[0] === 'local.get' && typeof n[1] === 'string' ? n[1] : null
const f64Zero = n => isArr(n) && n[0] === 'f64.const' && Number(n[1]) === 0

// jz wraps every NaN-producing float builtin (Math.sqrt/min/max/…) in a
// canonicalizing select so a non-canonical NaN never crosses to JS:
//   (select C X (T.ne X X))   — "use C where X is NaN, else X".
// The condition `X != X` is true iff X is NaN, so this shape is unambiguously
// the canonicalization idiom. C is the canonical-NaN value, materialized either
// inline (T.const) or hoisted into a const-pool global (global.get $__fcN) when
// reused. We splat C verbatim — faithful regardless of what C holds — so the
// recognizer never needs to resolve the global's value.
const isSplatConst = (n, constOp) =>
  isArr(n) && (n[0] === constOp || n[0] === 'global.get')

// Match `(select C X (T.ne X X))`. Returns { val: X, C } or null.
function matchCanonSelect(sel, laneType) {
  if (!isArr(sel) || sel[0] !== 'select') return null
  const C = sel[1], val = sel[2], cond = sel[3]
  // f32 lane: jz computes the value in f64, so `Math.min/max` (and any NaN-canon'd
  // f32 result) emit the canon with `f64.ne` + an f64 NaN const. Accept that
  // alongside the native f32 form; liftCanon splats the const as f32.
  const f64Canon = laneType === 'f32' && isArr(C) && C[0] === 'f64.const' && isArr(cond) && cond[0] === 'f64.ne'
  if (!f64Canon) {
    const neOp = laneType === 'f32' ? 'f32.ne' : 'f64.ne'
    if (!isSplatConst(C, LANE_INFO[laneType].constOp)) return null
    if (!(isArr(cond) && cond[0] === neOp)) return null
  }
  if (!(exprEq(cond[1], val) && exprEq(cond[2], val))) return null
  return { val, C }
}

// Replace every `(local.tee N v)` with `(local.get N)` so a value that tee's its
// address in one place (the comparison) and reloads it in another (the chosen branch)
// compares structurally equal. Used only for matching — emission keeps the tee.
function normTee(n) {
  if (!isArr(n)) return n
  if (n[0] === 'local.tee' && n.length === 3) return ['local.get', n[1]]
  return n.map(normTee)
}

// Recognize an integer min/max reduction body. WASM has no scalar i32.min/max, so
// `m = max(m, a[i])` — written `Math.max(m,a[i])|0` or `a[i]>m?a[i]:m` — lowers, after
// the ToInt32-through-`?:` fold, to a select-shaped body:
//   (local.set m (if (result i32) COND (then BR_T) (else BR_E)))   [or the (select …) form]
// where {BR_T,BR_E} = {laneLoad, m} and COND is a signed i32 comparison of the two.
// Returns { exprNode, isMax } — exprNode is the lane expr carrying the address tee (fed
// to liftExprV); null when not a clean min/max. All four comparison directions × two
// branch orderings collapse to `isMax` below. gt/ge (and lt/le) are equivalent for the
// RESULT — equal operands tie to the same value — so only the direction axis matters.
function matchIntMinMaxReduce(rhs, accName) {
  if (!isArr(rhs)) return null
  let cond, T, E, resTy = null
  if (rhs[0] === 'if') {
    let i = 1
    if (!(isArr(rhs[i]) && rhs[i][0] === 'result' && (rhs[i][1] === 'i32' || rhs[i][1] === 'f64'))) return null
    resTy = rhs[i][1]
    i++
    if (rhs.length !== i + 3) return null
    cond = rhs[i]
    const thenB = rhs[i + 1], elseB = rhs[i + 2]
    if (!(isArr(thenB) && thenB[0] === 'then' && thenB.length === 2)) return null
    if (!(isArr(elseB) && elseB[0] === 'else' && elseB.length === 2)) return null
    T = thenB[1]; E = elseB[1]
  } else if (rhs[0] === 'select' && rhs.length === 4) {
    T = rhs[1]; E = rhs[2]; cond = rhs[3]            // (select a b c) = a if c else b
  } else return null
  // Which branch is the accumulator, which is the lane EXPR.
  let exprBr, takeExprWhenTrue
  if (isLocalGet(E, accName) && !isLocalGet(T, accName)) { exprBr = T; takeExprWhenTrue = true }
  else if (isLocalGet(T, accName) && !isLocalGet(E, accName)) { exprBr = E; takeExprWhenTrue = false }
  else return null
  // Strip a boolean-normalizing `(i32.ne X 0)` around the comparison (as liftExprV does).
  let cmp = cond
  if (isArr(cmp) && cmp[0] === 'i32.ne' && isI32Const(cmp[2]) && cmp[2][1] === 0) cmp = cmp[1]
  if (!isArr(cmp) || cmp.length !== 3) return null
  // Integer (i32x4.max_s, exact) or float (f64x2.pmax, exact per-element incl NaN/±0) compare.
  const dir = { 'i32.gt_s': 'gt', 'i32.ge_s': 'gt', 'i32.lt_s': 'lt', 'i32.le_s': 'lt',
                'f64.gt': 'gt', 'f64.ge': 'gt', 'f64.lt': 'lt', 'f64.le': 'lt' }[cmp[0]]
  if (!dir) return null
  const laneType = cmp[0].startsWith('f64.') ? 'f64' : 'i32'
  if (resTy != null && resTy !== laneType) return null   // if-form result type must agree with the compare
  // Comparison operands must be {acc, EXPR}; take the non-acc side as the canonical lane
  // expr (it carries the address tee). exprIsLeftOfCmp records its position.
  let condExpr, exprIsLeftOfCmp
  if (isLocalGet(cmp[2], accName)) { condExpr = cmp[1]; exprIsLeftOfCmp = true }
  else if (isLocalGet(cmp[1], accName)) { condExpr = cmp[2]; exprIsLeftOfCmp = false }
  else return null
  // The compared expr and the chosen branch must be the SAME lane (tee vs reload aside).
  if (!exprEq(normTee(condExpr), normTee(exprBr))) return null
  // cond true ⟺ EXPR > acc  ⇒  picking EXPR-when-true is a max; picking-when-false a min.
  const predExprGreater = dir === 'gt' ? exprIsLeftOfCmp : !exprIsLeftOfCmp
  return { exprNode: condExpr, isMax: takeExprWhenTrue === predExprGreater, laneType }
}

// Match the un-flattened canon, emitted when a Math.* result feeds another op
// in expression position:
//   (block (result T) (local.set $t CORE) (select C (local.get $t) (T.ne …)))
// Returns { core: CORE, C } or null.
function matchCanonBlock(blk, laneType) {
  if (!isArr(blk) || blk[0] !== 'block') return null
  let i = 1
  if (typeof blk[i] === 'string' && blk[i].startsWith('$')) i++
  if (!(isArr(blk[i]) && blk[i][0] === 'result')) return null
  i++
  if (blk.length - i !== 2) return null
  const setStmt = blk[i]
  if (!isArr(setStmt) || setStmt[0] !== 'local.set' || typeof setStmt[1] !== 'string') return null
  const m = matchCanonSelect(blk[i + 1], laneType)
  if (!m || !isLocalGet(m.val, setStmt[1])) return null
  return { core: setStmt[2], C: m.C }
}

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
  const scan = (n) => { if (!isArr(n)) return; processList(n); for (let j = 0; j < n.length; j++) if (isArr(n[j])) scan(n[j]) }
  scan(loop)
  if (invInits.length) parent.splice(idx, 0, ...invInits)
}

// Walk a function, hoisting invariant reduction partials out of each loop. Inner
// loops first (post-order) so a dot is hoisted relative to its tightest enclosing
// loop, and an already-rewritten dot can't re-match in an outer pass.
const hoistReductionInvariantsIn = (fn, fnLocals, freshIdRef, newLocalDecls) => {
  const walk = (node, parent, idx) => {
    if (!isArr(node)) return
    for (let i = 0; i < node.length; i++) if (isArr(node[i])) walk(node[i], node, i)
    if (node[0] === 'loop' && isArr(parent)) hoistDotInvariant(node, parent, idx, fnLocals, freshIdRef, newLocalDecls)
  }
  for (let i = 0; i < fn.length; i++) if (isArr(fn[i])) walk(fn[i], fn, i)
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
//      (`ctx.features.typedView` false, checked at the dispatch). A view (subarray /
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
  if (!isArr(n)) return true
  const op = n[0]
  if (typeof op !== 'string') return false
  if (op.startsWith('call') || op.includes('.load') || op.includes('.store')
      || op === 'local.set' || op === 'local.tee' || op === 'global.set'
      || op.startsWith('memory.') || op.includes('.atomic.')) return false
  for (let i = 1; i < n.length; i++) if (!slpSplatSafe(n[i])) return false
  return true
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
// self-host miscompile came from accepting those by name alone.
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
  const walk = (n) => {
    if (hit || !isArr(n)) return
    if (n[0] === 'f64.load') {
      const m = slpMem(n)
      if (m && m.off === off && slpSameMem(m.addr, addr)) { hit = true; return }
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(value)
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
  // later `(local.get $t)` reads a value we deleted (the watr.js self-host miscompile).
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
  const walk = (n) => {
    if (!isArr(n)) return
    if (n[0] === 'local.get' && typeof n[1] === 'string') counts.set(n[1], (counts.get(n[1]) || 0) + 1)
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(fn)
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

// ---- Lane type tables ------------------------------------------------------

const LANE_INFO = {
  i8:  { lanes: 16, strideLog2: 0, stride: 1, splat: 'i8x16.splat', constOp: 'i32.const' },
  i16: { lanes: 8,  strideLog2: 1, stride: 2, splat: 'i16x8.splat', constOp: 'i32.const' },
  i32: { lanes: 4,  strideLog2: 2, stride: 4, splat: 'i32x4.splat', constOp: 'i32.const' },
  i64: { lanes: 2,  strideLog2: 3, stride: 8, splat: 'i64x2.splat', constOp: 'i64.const' },
  f32: { lanes: 4,  strideLog2: 2, stride: 4, splat: 'f32x4.splat', constOp: 'f32.const' },
  f64: { lanes: 2,  strideLog2: 3, stride: 8, splat: 'f64x2.splat', constOp: 'f64.const' },
}

// Narrow loads/stores (i32.load8_u etc.) define i8 / i16 lane types — values
// computed in i32 then truncated by store{8,16}, which matches i{8,16}xN wrap
// semantics exactly.
const LOAD_OPS = {
  'i32.load8_u': 'i8',  'i32.load8_s': 'i8',
  'i32.load16_u': 'i16','i32.load16_s': 'i16',
  'i32.load': 'i32', 'i64.load': 'i64', 'f32.load': 'f32', 'f64.load': 'f64',
}
const STORE_OPS = {
  'i32.store8': 'i8', 'i32.store16': 'i16',
  'i32.store': 'i32', 'i64.store': 'i64', 'f32.store': 'f32', 'f64.store': 'f64',
}

// scalar op → SIMD op. shamtScalar:true means second operand stays scalar i32.
//
// For i8/i16 lanes the SCALAR ops are i32.* — wasm has no native i8/i16 ops,
// values flow as i32 and the trailing store{8,16} truncates. i{8,16}x{N}.add
// wraps within each lane the same way, so the observable result matches.
// Note: wasm SIMD has no i8x16.mul, so multiplication on byte arrays bails.
const LANE_PURE = {
  // Right shifts intentionally omitted for narrow lanes: scalar emits
  // i32.shr_{s,u} on a load8/load16 i32 (zero- or sign-extended), while
  // i{8,16}x{N}.shr_{s,u} treats lanes as their narrow type. The two diverge
  // when load and shift signedness mismatch (e.g. load8_u + shr_s on byte
  // 0xFF: scalar=0x7F, SIMD=0xFF). Safe set excludes shr_*.
  i8: new Map([
    ['i32.add', { simd: 'i8x16.add' }],
    ['i32.sub', { simd: 'i8x16.sub' }],
    ['i32.and', { simd: 'v128.and' }],
    ['i32.or',  { simd: 'v128.or' }],
    ['i32.xor', { simd: 'v128.xor' }],
    ['i32.shl', { simd: 'i8x16.shl', shamtScalar: true }],
  ]),
  i16: new Map([
    ['i32.add', { simd: 'i16x8.add' }],
    ['i32.sub', { simd: 'i16x8.sub' }],
    ['i32.mul', { simd: 'i16x8.mul' }],
    ['i32.and', { simd: 'v128.and' }],
    ['i32.or',  { simd: 'v128.or' }],
    ['i32.xor', { simd: 'v128.xor' }],
    ['i32.shl', { simd: 'i16x8.shl', shamtScalar: true }],
  ]),
  i32: new Map([
    ['i32.add', { simd: 'i32x4.add' }],
    ['i32.sub', { simd: 'i32x4.sub' }],
    ['i32.mul', { simd: 'i32x4.mul' }],
    ['i32.and', { simd: 'v128.and' }],
    ['i32.or',  { simd: 'v128.or' }],
    ['i32.xor', { simd: 'v128.xor' }],
    ['i32.shl', { simd: 'i32x4.shl', shamtScalar: true }],
    ['i32.shr_s', { simd: 'i32x4.shr_s', shamtScalar: true }],
    ['i32.shr_u', { simd: 'i32x4.shr_u', shamtScalar: true }],
  ]),
  i64: new Map([
    ['i64.add', { simd: 'i64x2.add' }],
    ['i64.sub', { simd: 'i64x2.sub' }],
    ['i64.mul', { simd: 'i64x2.mul' }],
    ['i64.and', { simd: 'v128.and' }],
    ['i64.or',  { simd: 'v128.or' }],
    ['i64.xor', { simd: 'v128.xor' }],
    ['i64.shl', { simd: 'i64x2.shl', shamtScalar: true }],
    ['i64.shr_s', { simd: 'i64x2.shr_s', shamtScalar: true }],
    ['i64.shr_u', { simd: 'i64x2.shr_u', shamtScalar: true }],
  ]),
  f32: new Map([
    ['f32.add', { simd: 'f32x4.add' }],
    ['f32.sub', { simd: 'f32x4.sub' }],
    ['f32.mul', { simd: 'f32x4.mul' }],
    ['f32.div', { simd: 'f32x4.div' }],
    ['f32.min', { simd: 'f32x4.min' }],
    ['f32.max', { simd: 'f32x4.max' }],
    ['f32.neg', { simd: 'f32x4.neg' }],
    ['f32.abs', { simd: 'f32x4.abs' }],
    ['f32.sqrt', { simd: 'f32x4.sqrt' }],
    // rounding: each f32x4.* rounds lane-for-lane identically to the scalar f32.* (same
    // IEEE rounding mode), so the lift is bit-exact. Math.floor/ceil/trunc and the bare
    // f64.nearest jz emits all reach here in a Float32Array kernel.
    ['f32.floor', { simd: 'f32x4.floor' }],
    ['f32.ceil', { simd: 'f32x4.ceil' }],
    ['f32.trunc', { simd: 'f32x4.trunc' }],
    ['f32.nearest', { simd: 'f32x4.nearest' }],
  ]),
  f64: new Map([
    ['f64.add', { simd: 'f64x2.add' }],
    ['f64.sub', { simd: 'f64x2.sub' }],
    ['f64.mul', { simd: 'f64x2.mul' }],
    ['f64.div', { simd: 'f64x2.div' }],
    ['f64.min', { simd: 'f64x2.min' }],
    ['f64.max', { simd: 'f64x2.max' }],
    ['f64.neg', { simd: 'f64x2.neg' }],
    ['f64.abs', { simd: 'f64x2.abs' }],
    ['f64.sqrt', { simd: 'f64x2.sqrt' }],
    // rounding: f64x2.* rounds each lane identically to the scalar f64.* op (same IEEE
    // mode), so bit-exact. Unblocks `out[i] = Math.floor/ceil/trunc(f(in[i]))` f64 maps.
    ['f64.floor', { simd: 'f64x2.floor' }],
    ['f64.ceil', { simd: 'f64x2.ceil' }],
    ['f64.trunc', { simd: 'f64x2.trunc' }],
    ['f64.nearest', { simd: 'f64x2.nearest' }],
  ]),
}

// Integer-load → f32x4 widening, for `out[i] = intArr[i] (* k)` (Int16Array →
// Float32Array decode/normalize, the canonical audio/image map). jz emits the
// scalar as `f64.convert_i32_{s,u}(<intload>(addr))`; lift to: load `lanes` ints,
// widen to i32x4, then f32x4.convert. `steps` are applied innermost-first.
// `lossy`: i32→f32 rounds (the scalar converts via exact f64 then demotes — double
// rounding differs by ≤1 ulp), so it needs relaxedSimd; i8/i16 are exact in f32.
const INT_WIDEN_F32 = {
  'i32.load':     { load: 'v128.load',        steps: [],                                                  cvt: 's', lossy: true },
  'i32.load16_s': { load: 'v128.load64_zero', steps: ['i32x4.extend_low_i16x8_s'],                        cvt: 's', lossy: false },
  'i32.load16_u': { load: 'v128.load64_zero', steps: ['i32x4.extend_low_i16x8_u'],                        cvt: 'u', lossy: false },
  'i32.load8_s':  { load: 'v128.load32_zero', steps: ['i16x8.extend_low_i8x16_s', 'i32x4.extend_low_i16x8_s'], cvt: 's', lossy: false },
  'i32.load8_u':  { load: 'v128.load32_zero', steps: ['i16x8.extend_low_i8x16_u', 'i32x4.extend_low_i16x8_u'], cvt: 'u', lossy: false },
}

// f64 scalar op → f32x4 SIMD op, for Float32Array arithmetic jz computes in f64
// (promote→f64 op→demote). Used only in f32-lane context under relaxedSimd, since
// the f64→f32 intermediate-precision drop is not bit-exact (see _relaxF32).
const F64_TO_F32X4 = {
  'f64.add': 'f32x4.add', 'f64.sub': 'f32x4.sub', 'f64.mul': 'f32x4.mul', 'f64.div': 'f32x4.div',
  'f64.min': 'f32x4.min', 'f64.max': 'f32x4.max', 'f64.neg': 'f32x4.neg', 'f64.abs': 'f32x4.abs', 'f64.sqrt': 'f32x4.sqrt',
}

// Horizontal reductions: associative+commutative ops applied to one
// loop-carried accumulator. Each entry maps the SCALAR op (which is also
// the op used to combine the SIMD result back into the accumulator at the
// end) to its SIMD lane op, lane extractor, and identity element.
//
// Floats (add, mul) are not strictly associative — vectorized order produces
// ulp-level differences from scalar order. Acceptable for typical use
// (reductions over typed arrays of well-conditioned data); strict-equal
// callers must keep the pass off.
//
// Integer mul (`p *= a[i]`) IS associative+commutative mod 2³² / 2⁶⁴, so its
// vectorization is value-exact. Identity is 1 (the multiplicative neutral).
//
// Narrow lanes (i8/i16) intentionally absent: `s += a[i]` with a u8/u16
// load expands the value to i32 before the add, so the accumulator's lane
// type is always wider than the load's element type. That widening would
// require pairwise/extending-add ops (i16x8.extadd_pairwise_*) — separate
// recognizer. Integer min/max likewise: WASM has no scalar i32.min, so they
// arrive as a `select`, not a binary op — a separate recognizer branch.
const REDUCE_OPS = {
  i32: {
    'i32.add': { simd: 'i32x4.add', extract: 'i32x4.extract_lane', laneType: 'i32', constNode: ['i32.const', 0] },
    'i32.mul': { simd: 'i32x4.mul', extract: 'i32x4.extract_lane', laneType: 'i32', constNode: ['i32.const', 1] },
    'i32.xor': { simd: 'v128.xor',  extract: 'i32x4.extract_lane', laneType: 'i32', constNode: ['i32.const', 0] },
    'i32.and': { simd: 'v128.and',  extract: 'i32x4.extract_lane', laneType: 'i32', constNode: ['i32.const', -1] },
    'i32.or':  { simd: 'v128.or',   extract: 'i32x4.extract_lane', laneType: 'i32', constNode: ['i32.const', 0] },
  },
  i64: {
    'i64.add': { simd: 'i64x2.add', extract: 'i64x2.extract_lane', laneType: 'i64', constNode: ['i64.const', 0] },
    'i64.mul': { simd: 'i64x2.mul', extract: 'i64x2.extract_lane', laneType: 'i64', constNode: ['i64.const', 1] },
    'i64.xor': { simd: 'v128.xor',  extract: 'i64x2.extract_lane', laneType: 'i64', constNode: ['i64.const', 0] },
    'i64.and': { simd: 'v128.and',  extract: 'i64x2.extract_lane', laneType: 'i64', constNode: ['i64.const', -1] },
    'i64.or':  { simd: 'v128.or',   extract: 'i64x2.extract_lane', laneType: 'i64', constNode: ['i64.const', 0] },
  },
  f32: {
    'f32.add': { simd: 'f32x4.add', extract: 'f32x4.extract_lane', laneType: 'f32', constNode: ['f32.const', 0] },
    'f32.mul': { simd: 'f32x4.mul', extract: 'f32x4.extract_lane', laneType: 'f32', constNode: ['f32.const', 1] },
  },
  f64: {
    'f64.add': { simd: 'f64x2.add', extract: 'f64x2.extract_lane', laneType: 'f64', constNode: ['f64.const', 0] },
    'f64.mul': { simd: 'f64x2.mul', extract: 'f64x2.extract_lane', laneType: 'f64', constNode: ['f64.const', 1] },
  },
}

// Widening byte/short sums: an i32 accumulator fed by ONE bare narrow load
// (`s += u8[i]`). The lane data is i8/i16 but the accumulator is i32, so the
// plain lane-add path can't apply — instead each 16-byte vector collapses via
// extadd_pairwise into i32x4 partial sums. VALUE-EXACT mod 2³² (unlike float
// reductions): pairwise intermediates can't overflow (2×255 < 2¹⁶, 2×(−128)
// fits i16; the i16→i32 step extends before adding), and wrap-add is
// associative+commutative. Restricted to a BARE load: arithmetic on the
// narrow lanes before widening would wrap at lane width where the scalar
// code widens first.
const WIDEN_LOADS = {
  'i32.load8_u':  { laneType: 'i8',  steps: ['i16x8.extadd_pairwise_i8x16_u', 'i32x4.extadd_pairwise_i16x8_u'] },
  'i32.load8_s':  { laneType: 'i8',  steps: ['i16x8.extadd_pairwise_i8x16_s', 'i32x4.extadd_pairwise_i16x8_s'] },
  'i32.load16_u': { laneType: 'i16', steps: ['i32x4.extadd_pairwise_i16x8_u'] },
  'i32.load16_s': { laneType: 'i16', steps: ['i32x4.extadd_pairwise_i16x8_s'] },
}

// Widening min/max over a BARE narrow load (`m = Math.max(m, u8[i])` with an
// i32 accumulator). Unlike the widening SUM there is no overflow concern:
// min/max at the load's own lane width over its own sign is value-exact, so
// the fold stays at lane width (16/8 lanes per vector) and only the final
// horizontal merge widens, via the sign-matched extract. Identity seeds the
// vector accumulator with the op's neutral: type-min for max, type-max for min.
const MINMAX_WIDEN = {
  'i32.load8_u':  { pre: 'i8x16', sign: 'u', laneType: 'i8',  lo: 0,      hi: 255 },
  'i32.load8_s':  { pre: 'i8x16', sign: 's', laneType: 'i8',  lo: -128,   hi: 127 },
  'i32.load16_u': { pre: 'i16x8', sign: 'u', laneType: 'i16', lo: 0,      hi: 65535 },
  'i32.load16_s': { pre: 'i16x8', sign: 's', laneType: 'i16', lo: -32768, hi: 32767 },
}
// jz's number model converts narrow loads to f64 before Math.min/max, so the
// canon reduce arrives as (f64.max acc (f64.convert_i32_x LOAD)). The convert
// sign must match the load sign for the lane fold to be value-exact.
const MINMAX_CVT = { 'f64.convert_i32_u': 'u', 'f64.convert_i32_s': 's' }

// op-name → REDUCE entry across all lane types (the op-name itself encodes
// the lane type prefix, e.g. `i32.add` ⇒ i32 lanes).
const REDUCE_OP_LOOKUP = (() => {
  const m = new Map()
  for (const lt of Object.keys(REDUCE_OPS))
    for (const op of Object.keys(REDUCE_OPS[lt]))
      m.set(op, REDUCE_OPS[lt][op])
  return m
})()

// Min/max reductions (`m = Math.max(m, a[i])`). jz wraps every Math.min/max in
// a NaN-canonicalizing select, so these arrive as a TWO-statement body —
//   (local.set $cn (OP (local.get $acc) EXPR))
//   (local.set $acc (select C (local.get $cn) (OP-type.ne $cn $cn)))
// — handled separately from the bare single-statement reductions above.
//
// max/min ARE associative and commutative (exact reassociation, unlike add),
// so vectorization is value-exact, INCLUDING NaN: f64x2.max/min propagate a
// NaN lane just as scalar does, and we re-apply the canon to the merged result
// so the final NaN bit pattern is canonical even when N is a multiple of LANES
// (zero tail iterations). Identity is the op's annihilator-free neutral:
// -inf for max, +inf for min.
const REDUCE_CANON = {
  'f64.max': { simd: 'f64x2.max', extract: 'f64x2.extract_lane', laneType: 'f64', identity: ['f64.const', '-inf'] },
  'f64.min': { simd: 'f64x2.min', extract: 'f64x2.extract_lane', laneType: 'f64', identity: ['f64.const', 'inf'] },
  'f32.max': { simd: 'f32x4.max', extract: 'f32x4.extract_lane', laneType: 'f32', identity: ['f32.const', '-inf'] },
  'f32.min': { simd: 'f32x4.min', extract: 'f32x4.extract_lane', laneType: 'f32', identity: ['f32.const', 'inf'] },
}

// Scalar comparison op → SIMD lane comparison, per lane type. Used to vectorize a
// conditional map `buf[i] = cond ? X : Y`, which jz lowers to `(if (result T) COND
// (then X)(else Y))`: COND becomes an all-ones/all-zeros lane mask fed to
// `v128.bitselect`. NaN behaves identically lane-wise — every ordered compare is
// false on a NaN operand in both scalar and SIMD, and `ne` is true — so no
// canonicalization is needed. i64x2 has no unsigned compares in baseline SIMD, so
// those simply aren't listed (the loop stays scalar).
const LANE_COMPARE = {
  f64: { 'f64.eq': 'f64x2.eq', 'f64.ne': 'f64x2.ne', 'f64.lt': 'f64x2.lt', 'f64.gt': 'f64x2.gt', 'f64.le': 'f64x2.le', 'f64.ge': 'f64x2.ge' },
  f32: { 'f32.eq': 'f32x4.eq', 'f32.ne': 'f32x4.ne', 'f32.lt': 'f32x4.lt', 'f32.gt': 'f32x4.gt', 'f32.le': 'f32x4.le', 'f32.ge': 'f32x4.ge' },
  i32: { 'i32.eq': 'i32x4.eq', 'i32.ne': 'i32x4.ne', 'i32.lt_s': 'i32x4.lt_s', 'i32.lt_u': 'i32x4.lt_u', 'i32.gt_s': 'i32x4.gt_s', 'i32.gt_u': 'i32x4.gt_u', 'i32.le_s': 'i32x4.le_s', 'i32.le_u': 'i32x4.le_u', 'i32.ge_s': 'i32x4.ge_s', 'i32.ge_u': 'i32x4.ge_u' },
  i64: { 'i64.eq': 'i64x2.eq', 'i64.ne': 'i64x2.ne', 'i64.lt_s': 'i64x2.lt_s', 'i64.gt_s': 'i64x2.gt_s', 'i64.le_s': 'i64x2.le_s', 'i64.ge_s': 'i64x2.ge_s' },
}

// ---- Recognizer ------------------------------------------------------------

function isLocalGet(node, name) {
  return isArr(node) && node[0] === 'local.get' && (name == null || node[1] === name)
}
function isI32Const(node) {
  return isArr(node) && node[0] === 'i32.const'
}
function constNum(node) {
  if (!isI32Const(node)) return null
  const v = node[1]
  return typeof v === 'number' ? v : (typeof v === 'string' ? parseInt(v, 10) : null)
}

/**
 * Match increment shape `(local.set $X (i32.add (local.get $X) (i32.const 1)))`.
 * Returns $X or null.
 */
function matchInc1(stmt) {
  if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
  const x = stmt[1]
  const v = stmt[2]
  if (!isArr(v) || v[0] !== 'i32.add' || v.length !== 3) return null
  if (!isLocalGet(v[1], x)) return null
  if (constNum(v[2]) !== 1) return null
  return x
}

/**
 * Match increment shape `(local.set $X (i32.add (local.get $X) (i32.const C)))`
 * for any constant C. Returns { name, c } or null. Generalizes matchInc1 to the
 * strided-pointer bumps (`p += stride`) the ramp-map recognizer must scale.
 */
function matchIncN(stmt) {
  if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
  const x = stmt[1], v = stmt[2]
  if (!isArr(v) || v[0] !== 'i32.add' || v.length !== 3) return null
  if (!isLocalGet(v[1], x)) return null
  const c = constNum(v[2])
  return c == null ? null : { name: x, c }
}

/**
 * Match `(br_if $LABEL (i32.eqz (i32.lt_{s,u} (local.get $I) BOUND)))`.
 * Returns { ind, bound } or null.
 */
function matchExitBrIf(stmt, label) {
  if (!isArr(stmt) || stmt[0] !== 'br_if' || stmt[1] !== label) return null
  const cond = stmt[2]
  if (!isArr(cond) || cond[0] !== 'i32.eqz') return null
  const cmp = cond[1]
  if (!isArr(cmp) || (cmp[0] !== 'i32.lt_s' && cmp[0] !== 'i32.lt_u')) return null
  if (!isLocalGet(cmp[1])) return null
  return { ind: cmp[1][1], bound: cmp[2] }
}

/**
 * Walk node, collect set of local names that are written via local.set/local.tee
 * anywhere within. Used to detect loop-invariant locals.
 */
function collectWrites(node, out) {
  if (!isArr(node)) return
  const op = node[0]
  if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string') {
    out.add(node[1])
  }
  for (let i = 0; i < node.length; i++) collectWrites(node[i], out)
}

/**
 * Return the FIRST kind of access for `name` in straight-line walk order.
 *   'write' — local.set/local.tee seen first
 *   'read'  — local.get seen first
 *   null    — not referenced
 */
function firstAccess(node, name) {
  if (!isArr(node)) return null
  const op = node[0]
  // Walk children first — operands evaluate before the op. For local.set/tee
  // the VALUE child (idx 2) runs before the write, so a `local.get name` in
  // the value of `local.set name` is a read-before-write.
  if ((op === 'local.set' || op === 'local.tee') && node[1] === name) {
    if (node.length >= 3) {
      const r = firstAccess(node[2], name)
      if (r) return r
    }
    return 'write'
  }
  if (op === 'local.get' && node[1] === name) return 'read'
  for (let i = 1; i < node.length; i++) {
    const r = firstAccess(node[i], name)
    if (r) return r
  }
  return null
}

/**
 * Match the index-offset operand of a lane address — the part that scales the
 * induction variable inside `(i32.add base OFFSET)`. OFFSET is one of:
 *   (i32.shl (local.get IND) (i32.const K))            → strideLog2 K
 *   (local.get IND)                                    → strideLog2 0
 *   (local.tee $T <either of the above>)               → records $T
 *   (local.get $T)  where $T is a recorded offset-tee  → that tee's strideLog2
 *
 * The tee'd form arises from CSE: a map loop `b[i] = f(a[i])` over two distinct
 * base pointers shares one `i << K` offset (`(local.tee $T (i32.shl i K))` in
 * the first address, `(local.get $T)` in the second). `offsetTees` (Map
 * name→strideLog2) carries that across calls.
 *
 * Returns { strideLog2, teeName?: string } or null.
 */
// The per-iteration element count P (≥2) of an array-of-structs index `P*ind`, or null. Accepts the
// `(i32.mul P ind)`/`(i32.mul ind P)` form (non-power-of-2 P — RGB's 3) AND the strength-reduced
// power-of-2 form `(i32.shl ind S)` = ind·2^S (a `const j = 2*i`/`4*i` folds to a shift — complex/
// RGBA). P is the ELEMENT stride, not a byte offset.
function matchConstMulIV(node, ind) {
  if (!isArr(node) || node.length !== 3) return null
  if (node[0] === 'i32.mul') {
    let p = null
    if (isLocalGet(node[1], ind)) p = constNum(node[2])
    else if (isLocalGet(node[2], ind)) p = constNum(node[1])
    return (p != null && p >= 2 && p <= 64) ? p : null
  }
  if (node[0] === 'i32.shl' && isLocalGet(node[1], ind)) {
    const s = constNum(node[2])
    if (s != null && s >= 1 && s <= 6) return 1 << s   // ind·2^S, stride 2..64
  }
  return null
}

function matchLaneOffset(off, ind, offsetTees, allowAos, aosPix, idxTees) {
  if (isArr(off) && off[0] === 'local.get' && typeof off[1] === 'string' &&
      offsetTees && offsetTees.has(off[1])) {
    return { strideLog2: offsetTees.get(off[1]), pixelStride: (aosPix && aosPix.get(off[1])) || 1, teeName: null }
  }
  let teeName = null
  let n = off
  if (isArr(n) && n[0] === 'local.tee' && n.length === 3) { teeName = n[1]; n = n[2] }
  // (i32.shl <ind-scaled> (i32.const K))
  if (isArr(n) && n[0] === 'i32.shl' && n.length === 3) {
    const k = constNum(n[2])
    if (k != null && k >= 0 && k <= 3) {
      if (isLocalGet(n[1], ind)) return { strideLog2: k, pixelStride: 1, teeName }
      // AoS (array-of-structs / interleaved channels), P elements per iteration, element
      // byte-size 1<<K. Only under allowAos (tryVectorize gathers/scatters the lanes); every
      // other recognizer returns null here. Two shapes: the folded `(i32.mul P ind)`, and a
      // pixel-index local `(local.get $J)` with $J = P*ind (the `const j = P*i`, via idxTees).
      if (allowAos) {
        const p = matchConstMulIV(n[1], ind)
        if (p != null) return { strideLog2: k, pixelStride: p, teeName }
        if (isArr(n[1]) && n[1][0] === 'local.get' && idxTees && idxTees.has(n[1][1])) {
          const pj = idxTees.get(n[1][1])
          if (pj > 1) return { strideLog2: k, pixelStride: pj, teeName }
        }
      }
    }
    // POWER-OF-2 AoS stride: `a[P*i]` (P = 2,4,8 — complex/RGBA/…) folds `(P*i)<<3` to a single
    // `(i32.shl ind K)` with K = 3 + log2(P) > 3. The excess shift over the f64 element (3) is the
    // pixel stride. f64 lane only — scanForLoadsStores' `1<<strideLog2 === elemSize` gate keeps
    // strideLog2=3 (=8 bytes), so a folded narrower-lane stride can't be mis-accepted here.
    else if (allowAos && k != null && k >= 4 && k <= 9 && isLocalGet(n[1], ind)) {
      return { strideLog2: 3, pixelStride: 1 << (k - 3), teeName }
    }
  }
  // (local.get ind) — stride 1
  if (isLocalGet(n, ind)) return { strideLog2: 0, pixelStride: 1, teeName }
  return null
}

/**
 * Mirror lane address: `base + ((INV − iv) << K)` — the DESCENDING twin of the
 * canonical lane address (symmetric fills: `inp[N−k] = lm`). INV is an i32
 * const or a bare local; the CALLER must verify a named INV is body-invariant
 * (not in the body writes set). f64 store sites only (2 lanes): the vector for
 * (iv, iv+1) mirrors to (INV−iv, INV−iv−1) — contiguous descending, stored as
 * one v128 at INV−iv−1 with the lanes swapped.
 */
function matchMirrorAddr(addr, ind) {
  if (!isArr(addr) || addr[0] !== 'i32.add' || addr.length !== 3) return null
  for (const k of [1, 2]) {
    const off = addr[k]
    if (!isArr(off) || off[0] !== 'i32.shl' || off.length !== 3) continue
    const K = constNum(off[2])
    if (K == null || K < 0 || K > 3) continue
    const sub = off[1]
    if (!isArr(sub) || sub[0] !== 'i32.sub' || sub.length !== 3) continue
    if (!isLocalGet(sub[2], ind)) continue
    const inv = sub[1]
    const invName = isArr(inv) && inv[0] === 'local.get' && typeof inv[1] === 'string' ? inv[1] : null
    if (!invName && constNum(inv) == null) continue
    return { base: addr[k === 1 ? 2 : 1], invExpr: inv, invName, strideLog2: K }
  }
  return null
}

/**
 * Match an address expression `(i32.add base OFFSET)`, with optional outer
 * `(local.tee $A ...)`. OFFSET is matched by matchLaneOffset (which also
 * accepts a CSE'd `(local.tee $T (i32.shl ind K))` / `(local.get $T)` pair).
 * Also accepts `(local.get $A)` when $A is a previously-recorded address tee.
 *
 * Returns { strideLog2, base, teeName?, offsetTeeName?, viaLocal? } or null.
 *   `strideLog2` = K for i32.shl form, 0 for plain add form.
 *   `base` is the loop-invariant base subtree.
 */
function matchLaneAddr(addr, ind, addrLocals, offsetTees, allowAos, aosPix, idxTees) {
  let teeName = null
  let n = addr
  // (local.get $A) where $A holds a previously-tee'd FULL lane-address.
  if (isArr(n) && n[0] === 'local.get' && typeof n[1] === 'string' && addrLocals && addrLocals.has(n[1])) {
    const e = addrLocals.get(n[1])
    return { strideLog2: e.strideLog2, pixelStride: e.pixelStride || 1, base: e.base, teeName: null, viaLocal: n[1] }
  }
  if (isArr(n) && n[0] === 'local.tee' && n.length === 3) {
    teeName = n[1]
    n = n[2]
  }
  if (!isArr(n) || n[0] !== 'i32.add' || n.length !== 3) return null
  const a = n[1], b = n[2]
  const off = matchLaneOffset(b, ind, offsetTees, allowAos, aosPix, idxTees)
  if (!off) return null
  return { strideLog2: off.strideLog2, pixelStride: off.pixelStride || 1, base: a, teeName, offsetTeeName: off.teeName }
}

/**
 * A scalar i32 local that is ONLY ever assigned a lane offset — `(i32.shl ind K)`
 * (or bare `ind` for stride 0) — is a CSE'd offset shared across base pointers.
 * Returns the consistent strideLog2, or null if any write to it diverges.
 * This soundness check backs every `(local.get $T)` resolved via `offsetTees`.
 */
function _offsetLocalStride(body, name, ind, allowAos, idxTees) {
  let stride = null, found = false, ok = true, pix = null
  function walk(n) {
    if (!isArr(n)) return
    if ((n[0] === 'local.tee' || n[0] === 'local.set') && n[1] === name && n.length === 3) {
      found = true
      const v = n[2]
      let k = null
      if (isArr(v) && v[0] === 'i32.shl' && v.length === 3) {
        const kk = constNum(v[2])
        // Power-of-2 AoS offset local `(i32.shl ind K)` with K>3 — matches matchLaneOffset's
        // power-of-2 arm: element shift 3, pixel stride 2^(K-3). Verify all writes share one P.
        if (allowAos && isLocalGet(v[1], ind) && kk != null && kk >= 4 && kk <= 9) {
          k = 3; const p = 1 << (kk - 3); if (pix == null) pix = p; else if (pix !== p) ok = false
        }
        else if (isLocalGet(v[1], ind)) { k = kk; if (k == null || k < 0 || k > 3) ok = false }
        else if (allowAos && kk != null && kk >= 0 && kk <= 3) {
          // AoS offset local (i32.shl <P·ind> K) — folded `(i32.mul P ind)` or a pixel-index
          // local `(local.get $J)` with $J = P·ind (idxTees). Verify every write shares one P.
          let p = matchConstMulIV(v[1], ind)
          if (p == null && isArr(v[1]) && v[1][0] === 'local.get' && idxTees && idxTees.get(v[1][1]) > 1) p = idxTees.get(v[1][1])
          if (p != null) { k = kk; if (pix == null) pix = p; else if (pix !== p) ok = false }
          else ok = false
        } else ok = false
      } else if (isLocalGet(v, ind)) {
        k = 0
      } else ok = false
      if (k != null) {
        if (stride == null) stride = k
        else if (stride !== k) ok = false
      }
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  for (const s of body) walk(s)
  return found && ok ? stride : null
}

// True if the tree contains any branch or return — control flow that a flattened value-block
// lift can't preserve (an early `br`/`return` out of the block changes which value is produced).
const hasBranchOrReturn = (node) => {
  if (!isArr(node)) return false
  const op = node[0]
  if (op === 'br' || op === 'br_if' || op === 'br_table' || op === 'return') return true
  for (let i = 1; i < node.length; i++) if (hasBranchOrReturn(node[i])) return true
  return false
}

// True if any node in the tree writes a global. When false for a loop body,
// every `global.get` inside it is loop-invariant — safe to splat for SIMD.
const hasGlobalSet = (node) => {
  if (!isArr(node)) return false
  if (node[0] === 'global.set') return true
  for (let i = 1; i < node.length; i++) if (hasGlobalSet(node[i])) return true
  return false
}

// True if EXPR carries any side effect — a call, a memory store/op, or a global
// write. Used to reject an impure preamble we would otherwise clone (run twice).
const hasSideEffect = (node) => {
  if (!isArr(node)) return false
  const op = node[0]
  if (op === 'call' || op === 'call_indirect' || op === 'global.set'
    || (typeof op === 'string' && (op.includes('.store') || op.startsWith('memory.')))) return true
  for (let i = 1; i < node.length; i++) if (hasSideEffect(node[i])) return true
  return false
}

// ---- Recognize a (block (loop)) pair --------------------------------------

/**
 * Match the canonical vectorizable loop SCAFFOLD shared by every inner-loop
 * recognizer:
 *   (block $blk [preamble…]
 *     (loop $loop
 *       (br_if $blk (i32.eqz (i32.lt_{s,u} $i BOUND)))   ; exit guard
 *       BODY…
 *       (local.set $i (i32.add $i 1))                     ; bottom increment
 *       (br $loop)))
 *
 * Returns the structural FACTS only — no policy — or null when the shape
 * doesn't match:
 *   { blockNode, blockLabel, loopNode, loopLabel, endIdx, incIdx, incVar,
 *     exitInfo, bound, boundLocal, body, preamble }
 *   - `blockNode` is the original block, embedded verbatim as the scalar tail by
 *     each lifter's wrapper (the never-miscompile remainder loop).
 *   - `body`       = loopNode.slice(3, incIdx) (between exit guard and increment)
 *   - `bound`      = the raw BOUND expr; `boundLocal` = its local name when it is
 *     `(local.get $L)`, else null. Bound shape is NOT rejected here — callers that
 *     require a local-or-const bound check it themselves (tryStrengthReduceIV is
 *     bound-shape-agnostic, so baking a rejection in would change its behavior).
 *
 * `opts.allowPreamble` (default false): when true, LICM-hoisted invariant
 *   `(local.set $__li* EXPR)` statements BEFORE the loop are collected into
 *   `preamble` (pure & loop-invariant by construction — safe to clone/re-run);
 *   a non-`$__li` preamble, an impure value, or any array content AFTER the loop
 *   bails. When false, ANY non-loop array content in the block bails.
 *
 * Three opt-ins below cover recognizers whose acceptance genuinely differs — see each for
 * its exact contract: `opts.multiInc` (tryRampMap), `opts.envelope: 'loose'`
 * (tryBlurMultiPixel/tryChannelReduce), `opts.envelope: 'pixelIV'` (matchOuterPixelLoop).
 */
// A transparent block — no label (first child isn't a `$label` string) and no result — is
// pure statement grouping: wasm locals are function-scoped, and an unlabeled resultless block
// is neither a branch target nor a value producer, so it can ONLY appear in statement position
// (a resultless block in value position is a type error). jz emits one per source statement
// group; watr's mergeBlocks/vacuum flattens them post-hoc. The vectorizer is jz LOWERING
// (pre-watr), so it normalizes them itself IN PLACE — splicing each transparent block's
// children into its parent's statement list — so every recognizer (scaffold-consuming AND
// raw-node) reads the flat statement lists they were tuned against. Post-order: children are
// already flat when a block is spliced up. A labeled block (branch target) or result-carrying
// block (value producer) is kept — including the `(block $brk (loop …))` SIMD scaffold itself.
function normalizeTransparentBlocks(node) {
  if (!isArr(node)) return
  for (let i = 1; i < node.length; i++) normalizeTransparentBlocks(node[i])
  for (let i = node.length - 1; i >= 1; i--) {
    const c = node[i]
    if (isArr(c) && c[0] === 'block' &&
        !(typeof c[1] === 'string' && c[1].startsWith('$')) &&
        !(isArr(c[1]) && c[1][0] === 'result'))
      node.splice(i, 1, ...c.slice(1))
  }
}

// Fold the arithmetic identities watr's `identity` pass removes but jz emits raw — most
// importantly `i<<0` (a byte-stride address for a u8/i8 array: `base + (i << 0)`), which the
// vectorizer's address matchers, tuned on watr's folded IR, read as bare `i`. Also the trivial
// `x±0`, `x|0`, `x^0`, `x<<0/>>0`, `x*1`. In place, bottom-up; returns the (possibly folded)
// node so a parent can rebind. Pure syntactic identities — always sound, watr-equivalent.
function foldVecIdentities(node) {
  if (!isArr(node)) return node
  for (let i = 1; i < node.length; i++) node[i] = foldVecIdentities(node[i])
  if (node.length !== 3) return node
  const op = node[0], a = node[1], b = node[2]
  const ci = (n) => isArr(n) && (n[0] === 'i32.const' || n[0] === 'i64.const') ? Number(n[1]) : NaN
  const rb = ci(b), ra = ci(a)
  switch (op) {
    case 'i32.shl': case 'i32.shr_s': case 'i32.shr_u':
    case 'i64.shl': case 'i64.shr_s': case 'i64.shr_u':
      return rb === 0 ? a : node                       // x << 0 = x (right-identity only)
    case 'i32.add': case 'i32.or': case 'i32.xor':
    case 'i64.add': case 'i64.or': case 'i64.xor':
      return rb === 0 ? a : (ra === 0 ? b : node)      // x±0, x|0, x^0 (either side)
    case 'i32.sub': case 'i64.sub':
      return rb === 0 ? a : node                       // x - 0 = x
    case 'i32.mul': case 'i64.mul':
      return rb === 1 ? a : (ra === 1 ? b : node)      // x*1
    default: return node
  }
}

// Canonicalize jz's `if COND (then (br L))` break-idiom to watr's `br_if L COND` — the shape the
// loop-scan recognizers (byte-scan, divergent-escape) match. watr's `brif` pass does this
// post-hoc; the pre-watr vectorizer needs it now. Only the statement-form (no result), no-else,
// single-`br`-then shape becomes a br_if — anything richer is left untouched for watr. In place,
// top-down (a converted br_if has no nested `if` to revisit).
function canonicalizeIfBr(node) {
  if (!isArr(node)) return
  for (let i = 1; i < node.length; i++) {
    const c = node[i]
    if (isArr(c) && c[0] === 'if' && c.length === 3 &&
        !(isArr(c[1]) && c[1][0] === 'result') &&
        isArr(c[2]) && c[2][0] === 'then' && c[2].length === 2 &&
        isArr(c[2][1]) && c[2][1][0] === 'br' && c[2][1].length === 2 && typeof c[2][1][1] === 'string')
      // `(br L)` only — a value-carrying `(br L v)` would lose its operand under br_if's 2-arg form.
      node[i] = ['br_if', c[2][1][1], c[1]]
    else canonicalizeIfBr(c)
  }
}

// Shared tail of every envelope below: the loop's own label (position 1) and its bottom
// `(br label)` back-edge. Returns { loopLabel, endIdx } or null.
function matchLoopBrEnd(loopNode) {
  const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
  if (!loopLabel) return null
  const endIdx = loopNode.length - 1
  if (!(isArr(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return null
  return { loopLabel, endIdx }
}

function matchBlockLoop(blockNode, opts = {}) {
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null

  // envelope: 'pixelIV' — matchOuterPixelLoop's scaffold (see its own header doc); exit-guard
  // and increment stay matchOuterPixelLoop's own residual.
  if (opts.envelope === 'pixelIV') {
    if (!(typeof blockNode[1] === 'string' && blockNode[1].startsWith('$'))) return null
    const blockLabel = blockNode[1]
    let loopNode = null
    const preamble = []
    for (let i = 2; i < blockNode.length; i++) {
      const c = blockNode[i]
      if (!isArr(c)) return null
      if (c[0] === 'loop') { if (loopNode) return null; loopNode = c }
      else if (loopNode) return null              // statement after the loop → bail
      else if (c[0] !== 'local.set') return null  // preamble must be pure local.set
      else preamble.push(c)
    }
    if (!loopNode) return null
    const le = matchLoopBrEnd(loopNode)
    if (!le) return null
    return { blockNode, blockLabel, loopNode, loopLabel: le.loopLabel, endIdx: le.endIdx, preamble }
  }

  // envelope: 'loose' (tryBlurMultiPixel/tryChannelReduce) tolerates ANY non-loop content
  // anywhere — before or after the loop — with no validation at all; woven into the same
  // scan as the default/allowPreamble envelope below rather than duplicating it.
  const loose = opts.envelope === 'loose'
  const allowPreamble = loose || !!opts.allowPreamble
  let blockLabel = null, loopNode = null
  const preamble = []
  for (let i = 1; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (typeof c === 'string' && c.startsWith('$') && blockLabel == null && i === 1) { blockLabel = c; continue }
    if (isArr(c) && c[0] === 'loop') {
      if (loopNode) return null  // multiple loops
      loopNode = c
    } else if (isArr(c)) {
      if (loose) continue
      // `loopNode` truthy ⇒ this content is AFTER the loop ⇒ bail (even for a $__li set).
      // A LICM-hoisted invariant is `$__liN`; INLINING renames it (e.g. `$__inl7___li0`). Default
      // accepts only un-inlined `$__li*` (keeps the existing recognizers byte-identical);
      // `allowInlinedLi` (gated callers only) also accepts the `__liN` marker anywhere — both are
      // pure & loop-invariant by construction (belt-and-suspenders: hasSideEffect guard).
      // Under allowInlinedLi a block preamble is loop-invariant by construction (jz hoists only
      // invariants before the loop; IV-dependent work lives in the body), so any PURE local.set is
      // safe to clone ahead of the SIMD — covers $__inl*__li* (schrodinger) AND $_pg0-style
      // peephole-hoisted bounds (slime). The hasSideEffect guard rejects impure setups.
      const liOk = typeof c[1] === 'string' && (opts.allowInlinedLi ? true : c[1].startsWith('$__li'))
      if (!allowPreamble || loopNode || c[0] !== 'local.set' || !liOk || hasSideEffect(c[2])) return null
      preamble.push(c)
    }
  }
  if (!loopNode || !blockLabel) return null

  const le = matchLoopBrEnd(loopNode)
  if (!le) return null
  const { loopLabel, endIdx } = le
  if (loose) return { blockNode, blockLabel, loopNode, loopLabel, endIdx }

  // multiInc (tryRampMap) — trailing RUN of `x += C` (matchIncN); the exit IV must be in
  // the run stepping by exactly 1. Other constraints on the run are tryRampMap's residual.
  if (opts.multiInc) {
    const exitInfo = matchExitBrIf(loopNode[2], blockLabel)
    if (!exitInfo) return null
    const increments = []
    let bodyEnd = endIdx - 1
    while (bodyEnd >= 2) {
      const inc = matchIncN(loopNode[bodyEnd])
      if (!inc) break
      increments.unshift(inc)
      bodyEnd--
    }
    if (!increments.length) return null
    const ivInc = increments.find(x => x.name === exitInfo.ind)
    if (!ivInc || ivInc.c !== 1) return null
    const incVar = exitInfo.ind
    const bound = exitInfo.bound
    const boundLocal = isArr(bound) && bound[0] === 'local.get' && typeof bound[1] === 'string' ? bound[1] : null
    const body = loopNode.slice(3, bodyEnd + 1)
    return { blockNode, blockLabel, loopNode, loopLabel, endIdx, incVar, exitInfo, bound, boundLocal, body, preamble, increments }
  }

  const incIdx = endIdx - 1
  let incVar = matchInc1(loopNode[incIdx])
  // CSE'd increment (gated): O3 may fold `x+1` into a body tee (the `xe = x+1` wrap) and write the
  // increment as `x = $t` reusing it. Recover the IV when `$t` is `(tee/set $t (i32.add x 1))` in body.
  if (!incVar && opts.allowInlinedLi) {
    const inc = loopNode[incIdx]
    if (isArr(inc) && inc[0] === 'local.set' && inc.length === 3 && isLocalGet(inc[2])) {
      const copyOf = inc[2][1], iv = inc[1]
      const findInc1 = (m) => isArr(m) && (((m[0] === 'local.set' || m[0] === 'local.tee') && m[1] === copyOf && isArr(m[2]) && m[2][0] === 'i32.add' && isLocalGet(m[2][1], iv) && constNum(m[2][2]) === 1) || m.some(findInc1))
      if (loopNode.slice(3, incIdx).some(findInc1)) incVar = iv
    }
  }
  if (!incVar) return null

  const exitInfo = matchExitBrIf(loopNode[2], blockLabel)
  if (!exitInfo || exitInfo.ind !== incVar) return null

  const bound = exitInfo.bound
  const boundLocal = isArr(bound) && bound[0] === 'local.get' && typeof bound[1] === 'string' ? bound[1] : null
  const body = loopNode.slice(3, incIdx)
  return { blockNode, blockLabel, loopNode, loopLabel, endIdx, incIdx, incVar, exitInfo, bound, boundLocal, body, preamble }
}

/**
 * Try to vectorize the inner loop. Returns the replacement node array
 * (synthetic outer block) or null on no match.
 */
function tryVectorize(bl, fnLocals, freshIdRef, pureFuncMap, constLocals) {
  // Consumes the shared scaffold descriptor (matchBlockLoop, computed once by the
  // dispatch). The LICM `$__li` preamble is cloned ahead of the SIMD block; each
  // set is pure & loop-invariant, so the kept scalar tail harmlessly re-runs it.
  if (!bl) return null
  const { incVar, bound, boundLocal, body, preamble } = bl

  // Bound must be loop-invariant: (local.get $L) or (i32.const N).
  if (!boundLocal && !isI32Const(bound)) return null

  // Detect lane type from the FIRST load in body.
  let laneType = null
  let stride = -1
  const loadStoreSites = []  // {parent, idx, kind:'load'|'store'}
  // Address tees: name → {strideLog2, base}. A `(local.tee NAME (lane-addr))`
  // both validates the load's address AND records NAME so the matching store's
  // `(local.get NAME)` is accepted as the same lane address.
  const addrLocals = new Map()
  // Offset tees: name → strideLog2. A CSE'd `i << K` shared across base
  // pointers (map loops over distinct arrays). Soundness re-checked post-scan.
  const offsetTees = new Map()
  // AoS (array-of-structs) de-interleave: this recognizer alone accepts a pixel-stride
  // access `base[P*i + c]` (interleaved RGB/vec3/complex). allowAos enables it in every
  // shared matcher; aosPix carries P for a CSE'd offset tee; aosPixelStride is the loop's
  // single P (1 = plain stride-1, unchanged). Set once, verified equal across all sites.
  const allowAos = true
  const aosPix = new Map()
  let aosPixelStride = 1
  const mirrorSites = []   // mirror stores a[INV−iv] — invariance of INV checked post-scan
  // Pixel-INDEX locals: `$J = P*i` (the `const j = 3*i` of an AoS loop, kept as its own local
  // pre-watr). A channel address is then `base + ((local.get $J) << K)`; idxTees lets
  // matchLaneOffset resolve $J → pixel-stride P. Value -1 marks an inconsistent local (bail).
  const idxTees = new Map()
  {
    const walk = (n) => {
      if (!isArr(n)) return
      if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string' && n.length === 3) {
        const p = matchConstMulIV(n[2], incVar)
        if (p != null) idxTees.set(n[1], idxTees.has(n[1]) && idxTees.get(n[1]) !== p ? -1 : p)
      }
      for (let i = 1; i < n.length; i++) walk(n[i])
    }
    for (const s of body) walk(s)
  }

  // The compute/lane type is the WIDEST FLOAT among all loads+stores. A narrower
  // float/int LOAD is then a widening read (INT_WIDEN_F32 / f32→f64), a narrower
  // float/int STORE a narrowing write (demote / trunc+wrap) — both sub-width memory
  // ops around the float lane. Pinning it up front (vs whichever op the recursive
  // scan hits first) is what lets a narrowing map `i16[i] = f32arr[i]*k` keep the
  // f32 compute lane instead of locking onto the i16 store. No float → integer lane
  // (set by the scan below, unchanged).
  const isNarrowStore = (lane, sty) => (lane === 'f32' && (sty === 'i16' || sty === 'i8'))
    || (lane === 'f64' && (sty === 'f32' || sty === 'i32'))
  let preFloat = null
  const scanFloatWidth = (n) => {
    if (!isArr(n)) return
    const t = LOAD_OPS[n[0]] || STORE_OPS[n[0]]
    if (t === 'f64') preFloat = 'f64'
    else if (t === 'f32' && preFloat == null) preFloat = 'f32'
    for (let i = 1; i < n.length; i++) scanFloatWidth(n[i])
  }
  for (const s of body) scanFloatWidth(s)
  if (preFloat) { laneType = preFloat; stride = LANE_INFO[preFloat].stride }

  // Record a memory site's pixel stride. An AoS stride (P>1) is f64-lane only (the gather/scatter
  // lifts 2 f64 lanes). Strides are collected for the post-scan uniformity gate: EVERY site must
  // share one stride, else the loop mixes stride-1 and stride-P accesses (e.g. AoS-struct loads
  // feeding stride-1 array stores) and a single gather/scatter delta would corrupt the odd sites.
  const siteStrides = []
  const recordAos = (m) => {
    const ps = m.pixelStride || 1
    if (ps > 1) {
      if (laneType !== 'f64') return false
      if (aosPixelStride === 1) aosPixelStride = ps
      if (m.offsetTeeName) aosPix.set(m.offsetTeeName, ps)
    }
    siteStrides.push(ps)
    return true
  }
  // The real address is node[1], unless a folded `offset=N` memarg precedes it (node[1] is the
  // string `offset=N`, node[2] the address) — the AoS channels `d[j+1]`,`d[j+2]` and stencil
  // neighbours arrive this way.
  const memAddr = (node) => (typeof node[1] === 'string' && node[1].startsWith('offset=')) ? node[2] : node[1]

  function scanForLoadsStores(node, parent, pi) {
    if (!isArr(node)) return true
    const op = node[0]
    if (LOAD_OPS[op]) {
      const lt = LOAD_OPS[op]
      // int→f32 widening map (`out[i] = intArr[i] (*k)`): an integer load feeding a
      // Float32Array store. Accept under the f32 lane and validate at the int element
      // stride (the loop steps `lanes` f32 = 4 elements; load64_zero/load32_zero read
      // exactly 4 ints). liftExprV widens via INT_WIDEN_F32.
      const widenInt = laneType === 'f32' && lt !== 'f32' && INT_WIDEN_F32[op]
      if (laneType == null) {
        laneType = lt
        stride = LANE_INFO[laneType].stride
      } else if (lt !== laneType && !widenInt) {
        return false
      }
      const m = matchLaneAddr(memAddr(node), incVar, addrLocals, offsetTees, allowAos, aosPix, idxTees)
      if (!m) return false
      if ((1 << m.strideLog2) !== (widenInt ? LANE_INFO[lt].stride : stride)) return false
      if (!recordAos(m)) return false
      if (m.teeName) addrLocals.set(m.teeName, { strideLog2: m.strideLog2, pixelStride: m.pixelStride, base: m.base })
      if (m.offsetTeeName) offsetTees.set(m.offsetTeeName, m.strideLog2)
      loadStoreSites.push({ parent, idx: pi, kind: 'load' })
      return true
    }
    if (STORE_OPS[op]) {
      const sty = STORE_OPS[op]
      // narrowing store: a narrower element under a wider float lane (`o[i]=narrow(f(x))`,
      // codec encode / downsample). Validate the store address at the narrow element stride
      // (the loop steps `lanes` of the float lane; the partial store writes that many).
      const narrowing = laneType != null && sty !== laneType && isNarrowStore(laneType, sty)
      if (laneType != null && sty !== laneType && !narrowing) return false
      if (laneType == null) { laneType = sty; stride = LANE_INFO[laneType].stride }
      const memarg = typeof node[1] === 'string' && node[1].startsWith('offset=')
      let m = matchLaneAddr(memAddr(node), incVar, addrLocals, offsetTees, allowAos, aosPix, idxTees)
      if (!m) {
        // mirror store `a[INV − iv] = lane` (f64, full-width, no memarg): the
        // descending twin — accepted as its own site class; INV invariance is
        // verified post-scan against the body writes set.
        const mm = !memarg && sty === 'f64' && laneType === 'f64' && matchMirrorAddr(memAddr(node), incVar)
        if (mm && (1 << mm.strideLog2) === stride) {
          mirrorSites.push(mm)
          siteStrides.push(1)
          loadStoreSites.push({ parent, idx: pi, kind: 'store' })
          return scanForLoadsStores(node[2], node, 2)
        }
        return false
      }
      if ((1 << m.strideLog2) !== (narrowing ? LANE_INFO[sty].stride : stride)) return false
      if (!recordAos(m)) return false
      if (m.teeName) addrLocals.set(m.teeName, { strideLog2: m.strideLog2, pixelStride: m.pixelStride, base: m.base })
      if (m.offsetTeeName) offsetTees.set(m.offsetTeeName, m.strideLog2)
      loadStoreSites.push({ parent, idx: pi, kind: 'store' })
      // Recurse into VALUE child (idx 2, or 3 past an offset= memarg) — it's data, not address.
      const valIdx = memarg ? 3 : 2
      if (!scanForLoadsStores(node[valIdx], node, valIdx)) return false
      return true
    }
    // local.set/tee of an address local outside a load/store context (e.g.
    // `(local.set $a (i32.add base (i32.shl i 2)))` as a standalone stmt) —
    // record so a later `(local.get $a)` resolves.
    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string' && node.length === 3) {
      const valM = matchLaneAddr(['local.tee', node[1], node[2]], incVar, addrLocals, offsetTees, allowAos, aosPix, idxTees)
      if (valM && valM.teeName) {
        addrLocals.set(valM.teeName, { strideLog2: valM.strideLog2, pixelStride: valM.pixelStride, base: valM.base })
      }
      // Standalone offset compute: `(local.set $t (i32.shl i K))` (or AoS `(i32.shl (mul P i) K)`).
      const offM = matchLaneOffset(node[2], incVar, offsetTees, allowAos, aosPix, idxTees)
      if (offM) { offsetTees.set(node[1], offM.strideLog2); if (offM.pixelStride > 1) aosPix.set(node[1], offM.pixelStride) }
    }
    // Recurse into all children
    for (let i = 1; i < node.length; i++) {
      if (!scanForLoadsStores(node[i], node, i)) return false
    }
    return true
  }
  for (const stmt of body) {
    if (!scanForLoadsStores(stmt, null, -1)) return null
  }
  if (body.some(hasGlobalSet)) return null  // a global write breaks the "global.get is invariant" splat
  if (!laneType) return null  // no memory ops — vectorizing buys nothing
  if (loadStoreSites.length === 0) return null
  // Uniform stride gate: an AoS loop must have EVERY load/store at the same pixel stride. A mix of
  // stride-1 and stride-P sites can't share one lift stride — bail (stays scalar, always correct).
  if (aosPixelStride > 1 && siteStrides.some(s => s !== aosPixelStride)) return null

  // Soundness gate for offset-tee resolution: every `(local.get $T)` we
  // accepted as `i << K` is only valid if EVERY write of $T is that offset.
  for (const [name, k] of offsetTees) {
    if (_offsetLocalStride(body, name, incVar, allowAos, idxTees) !== k) return null
  }

  // Classify all locals referenced in body.
  // - induction var (incVar): exempt
  // - bound local (if any): must be invariant
  // - each other local: first access must not be a read-then-written pattern
  const writes = new Set()
  for (const s of body) collectWrites(s, writes)
  if (boundLocal && writes.has(boundLocal)) return null  // bound varies in body → bail
  // a mirror INV written in the body is not invariant — the descending window would drift
  for (const mm of mirrorSites) if (mm.invName && writes.has(mm.invName)) return null
  // AoS gather/scatter and mirror windows don't compose (distinct per-step deltas)
  if (mirrorSites.length && aosPixelStride > 1) return null

  const localKind = new Map()  // name → 'lane' | 'invariant' | 'addr'
  // Walk to collect ALL referenced names
  const referenced = new Set()
  const collectRefs = (n) => {
    if (!isArr(n)) return
    const op = n[0]
    if ((op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof n[1] === 'string')
      referenced.add(n[1])
    for (let i = 1; i < n.length; i++) collectRefs(n[i])
  }
  for (const s of body) collectRefs(s)

  for (const name of referenced) {
    if (name === incVar) continue
    if (writes.has(name)) {
      // Must be lane-local: first access is a write.
      let firstKind = null
      for (const s of body) {
        const k = firstAccess(s, name)
        if (k) { firstKind = k; break }
      }
      if (firstKind === 'read') return null  // loop-carried (reduction or stencil)
      // Discriminate lane-data vs address-tee. Address tees hold i32 addresses,
      // not vector data. We classify by checking the local's declared type.
      const decl = fnLocals.get(name)
      if (decl === 'i32' && (addrLocals.has(name) || offsetTees.has(name) || _isAddressLocal(body, name, incVar) || _isPixelIndexLocal(body, name, incVar))) {
        localKind.set(name, 'addr')
      } else {
        localKind.set(name, 'lane')
      }
    } else {
      localKind.set(name, 'invariant')
    }
  }

  // A ToInt32 (`|0`) narrowing conversion is commonly CSE'd into its own lane-local just before
  // the store (`set $t (…trunc_sat…); store addr (local.get $t)`), hiding it from the
  // narrowing-store path (liftStmt would then lift the i32 wrap in the f64 lane and bail). When
  // such a lane-local is read exactly once by a narrowing store, inline the conversion back into
  // the store so peelNarrowConv/narrowStore handle it. The original set survives in the scalar
  // remainder; this only reshapes the SIMD lift (and bails cleanly if liftStmt still declines).
  let body2 = body
  {
    const getCount = new Map()
    const countGets = (n) => { if (!isArr(n)) return; if (n[0] === 'local.get' && typeof n[1] === 'string') getCount.set(n[1], (getCount.get(n[1]) || 0) + 1); for (let i = 1; i < n.length; i++) countGets(n[i]) }
    for (const s of body) countGets(s)
    const dropped = new Set()
    const inlined = body.map(s => {
      if (isArr(s) && STORE_OPS[s[0]] && s.length === 3 && STORE_OPS[s[0]] !== laneType &&
          isLocalGet(s[2]) && localKind.get(s[2][1]) === 'lane' && getCount.get(s[2][1]) === 1) {
        const def = body.find(x => isArr(x) && x[0] === 'local.set' && x[1] === s[2][1] && x.length === 3)
        if (def && peelNarrowConv(def[2], STORE_OPS[s[0]])) { dropped.add(def); return [s[0], s[1], def[2]] }
      }
      return s
    })
    if (dropped.size) body2 = inlined.filter(s => !dropped.has(s))
  }

  // A signum ternary (`a<0?-1:1`) is commonly CSE'd into its own lane-local just before its
  // sole use (`set $s (select (i32.const -1)(i32.const 1) COND); … f64.convert_i32_s($s) …`),
  // hiding it from liftExprV's `f64.convert_i32_s(select …)` fusion (below), which only matches
  // the select INLINE. Post-watr this local hop would already be copy-propagated away; pre-watr
  // it survives. When such a lane-local is read exactly once, and that read is inside a
  // `f64.convert_i32_s`, inline the select back — same "sink a single-use def into its sole
  // specialized consumer" trick as the narrowing-store case above.
  {
    const getCount2 = new Map()
    const countGets2 = (n) => { if (!isArr(n)) return; if (n[0] === 'local.get' && typeof n[1] === 'string') getCount2.set(n[1], (getCount2.get(n[1]) || 0) + 1); for (let i = 1; i < n.length; i++) countGets2(n[i]) }
    for (const s of body2) countGets2(s)
    const dropDefs = new Set()
    const inlineSign = (n) => {
      if (!isArr(n)) return n
      if (n[0] === 'f64.convert_i32_s' && n.length === 2 && isArr(n[1]) && n[1][0] === 'local.get' &&
          typeof n[1][1] === 'string' && getCount2.get(n[1][1]) === 1) {
        const nm = n[1][1]
        const def = body2.find(x => isArr(x) && x[0] === 'local.set' && x[1] === nm && x.length === 3)
        if (def && isArr(def[2]) && def[2][0] === 'select' && def[2].length === 4 && isI32Const(def[2][1]) && isI32Const(def[2][2])) {
          dropDefs.add(def)
          return ['f64.convert_i32_s', def[2]]
        }
      }
      return n.map((c, i) => i === 0 ? c : inlineSign(c))
    }
    const inlined2 = body2.map(inlineSign)
    // Two-pass: inlineSign allocates a fresh array for every node it visits (even unchanged
    // ones), so filtering `inlined2` by `dropDefs.has(...)` would fail on reference identity —
    // `dropDefs` holds references into the PRE-map `body2`, so the drop-filter must run against
    // `body2` (matching indices into `inlined2`), not against the mapped output.
    if (dropDefs.size) body2 = body2.map((s, i) => dropDefs.has(s) ? null : inlined2[i]).filter(s => s != null)
  }

  // Build lifted body. If anything fails to lift, bail.
  const newLanedLocals = new Map()  // origName → laneName (bare string; see getOrAllocLanedLocal)
  const extraLocals = []  // canon temps allocated during lift
  const ctx = { laneType, incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, fnLocals, newLanedLocals, extraLocals, freshIdRef, fail: false, failReason: null, aosPixelStride, pureFuncMap, inlineDepth: 0, constLocals }
  const lifted = []
  for (const s of body2) {
    const r = liftStmt(s, ctx)
    if (ctx.fail) return null
    if (r != null) {
      if (Array.isArray(r) && r[0] === '__seq__') lifted.push(...r.slice(1))
      else lifted.push(r)
    }
  }
  if (lifted.length === 0) return null

  // Generate fresh names
  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`
  const simdBrkLabel = `$__simd_brk${id}`
  const simdLoopLabel = `$__simd_loop${id}`

  const info = LANE_INFO[laneType]
  const lanes = info.lanes
  const mask = -lanes  // bit pattern ~(lanes-1) in i32 two's complement

  // Build SIMD prefix block.
  const boundExpr = boundLocal
    ? ['local.get', boundLocal]
    : bound  // i32.const N
  const simdBlock = ['block', simdBrkLabel,
    ['loop', simdLoopLabel,
      ['br_if', simdBrkLabel,
        ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...lifted,
      ['local.set', incVar,
        ['i32.add', ['local.get', incVar], ['i32.const', lanes]]],
      ['br', simdLoopLabel]
    ]
  ]

  // Bound setup: align the SPAN, not the bound — simdBound = iv + ((bound − iv)
  // & ~(lanes−1)). `bound & mask` assumed a 0 entry: a loop entering at k=1
  // (symmetric fills start past the DC bin) would run its last vector step at
  // k = bound−1 and overrun one lane past the bound. iv holds the entry value
  // here (the setup precedes the SIMD block).
  const boundSetup = ['local.set', simdBoundName,
    ['i32.add', ['local.get', incVar],
      ['i32.and', ['i32.sub', boundExpr, ['local.get', incVar]], ['i32.const', mask]]]]

  // Synthetic outer wrapper — has no result, no label, just sequences.
  // A clone of any LICM-hoisted preamble runs first (so the SIMD block sees the
  // invariant); the original block is preserved unchanged as the scalar tail (which
  // re-runs the preamble harmlessly — it is loop-invariant).
  const wrapper = ['block', ...preamble.map(cloneNode), boundSetup, simdBlock, bl.blockNode]

  // Locals to add to function header.
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']),
    ...extraLocals,
  ]

  return { wrapper, newLocalDecls }
}

// ---- Stencil recognizer (neighbour loads: a[i±δ], a[c±δ], a[rn+x]) --------
//
// Vectorizes a map whose loads read NEIGHBOURING elements — `b[i] = f(a[i-1],
// a[i], a[i+1])` and the 2-D form `b[c] = f(a[c-1], a[c+1], a[rn+x], …)` where
// `c = rc + x` is a derived induction var (rc loop-invariant, x the IV).
//
// The lift is bit-exact BY CONSTRUCTION: a scalar `f64.load` at `base+(idx<<K)`
// becomes `v128.load` at the SAME address; for f64x2 lanes (x, x+1) that covers
// `(elem[idx], elem[idx+1])` — exactly the bytes the two scalar iterations read.
// No new memory is touched (scalar tail handles the remainder) ⇒ no boundary
// special-casing, no new OOB. The neighbour `a[i+1]` arrives as
// `(f64.load offset=8 …)` → `v128.load offset=8` (the +1-shifted pair). Stride-1
// in the IV is required (consecutive lanes ⇒ consecutive elements): every index
// must be affine in the IV with coefficient exactly 1 (`ivCoeff`).
//
// Correctness gates:
//   • f64/f32 lanes only — float data locals vs i32 index/address locals are
//     type-distinct, so localKind is by type. An i32-used-as-data case bails in
//     the lifter (never miscompiles). Integer-lane stencils (types collide) decline.
//   • In-place bail: if the WRITTEN base is also accessed at a DIFFERENT element,
//     SIMD reads the old value where scalar reads the just-written one (loop-
//     carried) ⇒ null. Offset-0 read of the written array is safe.
//   • Distinct base subtrees ⇒ assumed non-aliasing — the SAME assumption the
//     plain map path already relies on. A ping-pong buffer swap (waves) is OUTSIDE
//     the loop, so in-loop bases stay distinct globals — safe without a runtime guard.
//   • Reassociation: summing neighbours reorders f64 adds across lanes (ulp, like
//     float reductions) — gated behind cfg.experimentalStencil until proven.
function tryStencil(node, fnLocals, freshIdRef, enabled) {
  if (!enabled) return null
  // Gated, so match here with allowInlinedLi (accepts inlined LICM preambles `$__inl7___li*` —
  // grid loops like schrodinger's stepR carry the row-base `y*w` as such a hoisted invariant).
  const bl = matchBlockLoop(node, { allowPreamble: true, allowInlinedLi: true })
  if (!bl) return null
  const { incVar, bound, body, preamble } = bl   // preamble: LICM-hoisted $__li invariants
  if (body.some(hasGlobalSet)) return null

  // Leaf-stencil guard: a stencil body is pure array arithmetic. A NESTED LOOP (the outer loop of a
  // 2-D sweep, whose body contains the inner loop) or a non-$math call must NOT be lifted as a
  // stencil — its "neighbour reads" would be the nested loop's loads, misaligned. waves/schrodinger/
  // metaballs bodies are pure arithmetic (math calls allowed), so they pass.
  const hasNestedLoopOrCall = (n) => isArr(n) && (n[0] === 'loop'
    || (n[0] === 'call' && (typeof n[1] !== 'string' || !n[1].startsWith('$math.'))) || n[0] === 'call_indirect'
    || n.some(hasNestedLoopOrCall))
  if (body.some(hasNestedLoopOrCall)) return null

  const writes = new Set()
  for (const s of body) collectWrites(s, writes)

  // Bound is re-evaluated for the SIMD guard, so it must be a PURE loop-invariant
  // i32 expression (const / unwritten local / global / +,-,* thereof). Unlike the
  // plain-map path (bare local-or-const only), stencils commonly bound by `w-1`.
  const boundPureInv = (n) =>
    isI32Const(n) ? true
    : isLocalGet(n) ? !writes.has(n[1])
    : (isArr(n) && n[0] === 'global.get') ? true
    : (isArr(n) && (n[0] === 'i32.add' || n[0] === 'i32.sub' || n[0] === 'i32.mul') && n.length === 3)
      ? boundPureInv(n[1]) && boundPureInv(n[2])
    : false
  if (!boundPureInv(bound)) return null

  // Element-index coefficient in the IV: 0 (loop-invariant), 1 (stride-1 affine —
  // IV, a derived IV, or either ± invariant), or null (anything else).
  const derived = new Set()
  let needsPeel = false
  const rightBs = []
  const unTee = (b) => (isArr(b) && b[0] === 'local.tee' && b.length === 3) ? b[2] : b   // CSE folds x±1 into a tee
  const isStep = (b, op) => { b = unTee(b); return isArr(b) && b[0] === op && b.length === 3 && isLocalGet(b[1], incVar) && isI32Const(b[2]) && constNum(b[2]) === 1 }
  const isZeroGuard = (g) => isArr(g) && ((g[0] === 'i32.eqz' && isLocalGet(g[1], incVar)) || (g[0] === 'i32.eq' && isLocalGet(g[1], incVar) && isI32Const(g[2]) && constNum(g[2]) === 0))
  // Toroidal wrap-select: `xw = x>0?x-1:w-1` / `xe = x<w-1?x+1:0`. Fires its wrap value only at a
  // boundary column the peel covers — LEFT (interior x-1) at x=0, RIGHT (interior x+1) at x=B.
  // Returns null | {dir:'L'} | {dir:'R',B}. Sound for ANY B: simdBound caps at min(bound,…B)-(lanes-1)
  // so no chunk reaches x=B (no need to prove B==bound-1, which may be hoisted out of reach).
  const isWrapSelect = (e) => {
    if (!isArr(e) || e[0] !== 'select' || e.length !== 4) return null
    const g = e[3]
    if (isStep(e[1], 'i32.sub') && ivCoeff(e[2]) === 0 && isArr(g) && g[0] === 'i32.gt_s' && isLocalGet(g[1], incVar) && isI32Const(g[2]) && constNum(g[2]) === 0) return { dir: 'L' }
    if (isStep(e[2], 'i32.sub') && ivCoeff(e[1]) === 0 && isZeroGuard(g)) return { dir: 'L' }
    if (isStep(e[1], 'i32.add') && ivCoeff(e[2]) === 0 && isArr(g) && g[0] === 'i32.lt_s' && isLocalGet(g[1], incVar)) return { dir: 'R', B: g[2] }
    if (isStep(e[2], 'i32.add') && ivCoeff(e[1]) === 0 && isArr(g) && g[0] === 'i32.eq' && isLocalGet(g[1], incVar)) return { dir: 'R', B: g[2] }
    return null
  }
  const ivCoeff = (n) => {
    if (isLocalGet(n)) {
      const nm = n[1]
      if (nm === incVar || derived.has(nm)) return 1
      return writes.has(nm) ? null : 0          // unwritten ⇒ loop-invariant
    }
    if (isI32Const(n)) return 0
    if (isArr(n) && n[0] === 'global.get') return 0
    if (isArr(n) && (n[0] === 'i32.add' || n[0] === 'i32.sub') && n.length === 3) {
      const a = ivCoeff(n[1]), b = ivCoeff(n[2])
      if (a == null || b == null) return null
      const c = n[0] === 'i32.add' ? a + b : a - b
      return c === 0 || c === 1 ? c : null
    }
    // `y*w` (inline row base, e.g. idx = y*w + x): invariant×invariant ⇒ coeff 0.
    // Any IV-dependent factor would be non-unit-stride (stride-w) ⇒ reject.
    if (isArr(n) && (n[0] === 'i32.mul' || n[0] === 'f64.mul') && n.length === 3)
      return ivCoeff(n[1]) === 0 && ivCoeff(n[2]) === 0 ? 0 : null
    // Float-derived index (grid loops compute the row base `y*w` in f64): the index arrives as
    // `idx = select(wrap(trunc_sat(INV + convert(x))), 0, ≠Inf)`. For an integer counter x,
    // trunc(C + x) = trunc(C) + x ⇒ stride-1 (the i32 lane offset is added before the trunc); the
    // Infinity-canon select takes the trunc branch for finite coords (grid indices are finite).
    // f64.add/sub mirror i32.add/sub; convert/wrap/trunc_sat/tee are coeff-transparent.
    if (isArr(n) && (n[0] === 'f64.add' || n[0] === 'f64.sub') && n.length === 3) {
      const a = ivCoeff(n[1]), b = ivCoeff(n[2])
      if (a == null || b == null) return null
      const c = n[0] === 'f64.add' ? a + b : a - b
      return c === 0 || c === 1 ? c : null
    }
    if (isArr(n) && (n[0] === 'f64.convert_i32_s' || n[0] === 'i32.wrap_i64' || n[0] === 'i64.trunc_sat_f64_s') && n.length === 2)
      return ivCoeff(n[1])
    if (isArr(n) && n[0] === 'local.tee' && n.length === 3) return ivCoeff(n[2])
    if (isArr(n) && n[0] === 'select') {
      // Toroidal wrap-select (inline in an address or named): stride-1 interior; flag the peel.
      const w = isWrapSelect(n)
      if (w) { needsPeel = true; if (w.dir === 'R' && !rightBs.some(b => exprEq(b, w.B))) rightBs.push(w.B); return 1 }
      // jz overflow-canon `select(wrap(trunc_sat(…)), 0, ≠Inf)`: finite (grids) ⇒ the trunc branch.
      if (n.length === 4 && isI32Const(n[2]) && isArr(n[3]) && n[3][0] === 'f64.ne' && isArr(n[3][2]) && n[3][2][0] === 'f64.const' && /inf/i.test(String(n[3][2][1])))
        return ivCoeff(n[1])
    }
    return null
  }
  const countSets = (name) => {
    let k = 0
    const w = (x) => { if (!isArr(x)) return; if ((x[0] === 'local.set' || x[0] === 'local.tee') && x[1] === name) k++; for (let i = 1; i < x.length; i++) w(x[i]) }
    for (const s of body) w(s)
    return k
  }
  // Derived IVs: `c = INV + x` (coeff 1) or a toroidal wrap-select; set exactly once, first access a
  // write. RECURSES into nested tees — O3 CSEs `rc+x` into `(local.tee $pe (i32.add rc x))` inside a
  // load address, reused by the store. (ivCoeff returns 1 for a wrap-select and flags needsPeel.)
  for (let pass = 0; pass < 4; pass++) {
    let added = false
    const consider = (name, def) => {
      if (derived.has(name) || fnLocals.get(name) !== 'i32' || countSets(name) !== 1 || ivCoeff(def) !== 1) return
      let fk = null; for (const t of body) { const k = firstAccess(t, name); if (k) { fk = k; break } }
      if (fk === 'write') { derived.add(name); added = true }
    }
    const walk = (x) => { if (!isArr(x)) return; if ((x[0] === 'local.set' || x[0] === 'local.tee') && typeof x[1] === 'string' && x.length === 3) consider(x[1], x[2]); for (let i = 1; i < x.length; i++) walk(x[i]) }
    for (const s of body) walk(s)
    if (!added) break
  }

  // Scan loads/stores: address `base + (IDX<<K)`, ivCoeff(IDX)=1, base invariant.
  let laneType = null, stride = -1
  const offTees = new Map()    // $pe → IDX expr  (from $pe = IDX<<K)
  const addrTees = new Map()   // $ab → { base, idx }
  const sites = []             // { kind, base, idx, memBytes }
  const isInvBase = (b) => (isArr(b) && b[0] === 'global.get') || (isLocalGet(b) && !writes.has(b[1]))
  const matchAddr = (addr, expectStride = stride) => {
    let teeName = null, n = addr
    if (isArr(n) && n[0] === 'local.tee' && n.length === 3) { teeName = n[1]; n = n[2] }
    if (isLocalGet(n) && addrTees.has(n[1])) { const e = addrTees.get(n[1]); if (teeName) addrTees.set(teeName, e); return e }
    if (!isArr(n) || n[0] !== 'i32.add' || n.length !== 3) return null
    const tryOff = (off) => {
      let ot = null, o = off
      if (isArr(o) && o[0] === 'local.tee' && o.length === 3) { ot = o[1]; o = o[2] }
      if (isLocalGet(o) && offTees.has(o[1])) return { idx: offTees.get(o[1]) }
      if (isArr(o) && o[0] === 'i32.shl' && o.length === 3 && isI32Const(o[2]) && (1 << o[2][1]) === expectStride && ivCoeff(o[1]) === 1) {
        if (ot) offTees.set(ot, o[1])
        return { idx: o[1] }
      }
      return null
    }
    for (const [bi, oi] of [[1, 2], [2, 1]]) {
      if (!isInvBase(n[bi])) continue
      const om = tryOff(n[oi])
      if (om) { const e = { base: n[bi], idx: om.idx }; if (teeName) addrTees.set(teeName, e); return e }
    }
    return null
  }
  const scan = (node, parent, pi) => {
    if (!isArr(node)) return true
    const op = node[0]
    if (LOAD_OPS[op]) {
      let addr = node[1], memBytes = 0
      if (typeof addr === 'string' && addr.startsWith('offset=')) { memBytes = +addr.slice(7); addr = node[2] }
      const lt = LOAD_OPS[op]
      if (laneType == null) { if (lt !== 'f64' && lt !== 'f32') return false; laneType = lt; stride = LANE_INFO[lt].stride }
      else if (lt !== laneType && !(lt === 'f32' && laneType === 'f64')) return false   // f32→f64 widening OK
      // Validate the address at the LOAD's own element stride (f64=8, widening f32=4); the index
      // must still be stride-1 in elements (ivCoeff===1). The f32 load is promoted in liftExprV.
      const m = matchAddr(addr, LANE_INFO[lt].stride)
      if (!m) return false
      sites.push({ kind: 'load', base: m.base, idx: m.idx, memBytes })
      return true
    }
    if (STORE_OPS[op]) {
      if (node.length !== 3) return false
      const st = STORE_OPS[op]
      if (laneType == null) { if (st !== 'f64' && st !== 'f32') return false; laneType = st; stride = LANE_INFO[st].stride }
      else if (st !== laneType) return false
      const m = matchAddr(node[1])
      if (!m) return false
      sites.push({ kind: 'store', base: m.base, idx: m.idx, memBytes: 0 })
      return scan(node[2], node, 2)                        // value child only
    }
    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string' && node.length === 3) {
      const v = node[2]
      if (isArr(v) && v[0] === 'i32.shl' && v.length === 3 && isI32Const(v[2]) && stride > 0 && (1 << v[2][1]) === stride && ivCoeff(v[1]) === 1) offTees.set(node[1], v[1])
      else matchAddr(['local.tee', node[1], v])
    }
    for (let i = 1; i < node.length; i++) if (!scan(node[i], node, i)) return false
    return true
  }
  for (const s of body) if (!scan(s, null, -1)) return null
  if (!laneType || !sites.some(s => s.kind === "store") || !sites.some(s => s.kind === "load")) return null

  // In-place / loop-carried gate: every access to a WRITTEN base must touch the
  // SAME element (idx + memarg). Else SIMD reads stale data vs scalar.
  const elemKey = (s) => `${JSON.stringify(normTee(s.idx))}@${s.memBytes / stride}`
  for (const st of sites) {
    if (st.kind !== 'store') continue
    for (const s of sites) if (exprEq(normTee(s.base), normTee(st.base)) && elemKey(s) !== elemKey(st)) return null
  }
  // A pure offset-0 map (every access the same element, no memarg) is tryVectorize's
  // job — it ran first. Nothing stencil-specific here. (Defensive; ?? order ensures it.)
  const k0 = elemKey(sites[0])
  if (sites.every(s => elemKey(s) === k0)) return null

  // Classify locals by TYPE: i32 → addr (index/address, kept scalar), laneType
  // written → lane (first access must be a write), laneType unwritten → invariant.
  const referenced = new Set()
  const collectRefs = (n) => { if (!isArr(n)) return; if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') referenced.add(n[1]); for (let i = 1; i < n.length; i++) collectRefs(n[i]) }
  for (const s of body) collectRefs(s)
  const localKind = new Map()
  for (const name of referenced) {
    if (name === incVar) continue
    const ty = fnLocals.get(name)
    if (ty === 'i32') { localKind.set(name, 'addr'); continue }
    // A stencil temp computed in f64 then stored to an f32 array carries `ty === 'f64'`
    // in an f32 lane (jz computes Float32Array math in f64). Treat it as lane/invariant
    // data the same as a native-typed local — the lift lanes it as f32x4 (relaxedSimd).
    if (ty === laneType || (laneType === 'f32' && ty === 'f64')) {
      if (writes.has(name)) {
        let fk = null; for (const s of body) { const k = firstAccess(s, name); if (k) { fk = k; break } }
        if (fk === 'read') return null                    // loop-carried float local
        localKind.set(name, 'lane')
      } else localKind.set(name, 'invariant')
      continue
    }
    if (!writes.has(name)) { localKind.set(name, 'invariant'); continue }
    return null                                            // written non-i32 non-lane local
  }

  // Lift through the shared lifter (addresses kept verbatim; loads → v128.load).
  const newLanedLocals = new Map(), extraLocals = []
  const ctx = { laneType, incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, fnLocals, newLanedLocals, extraLocals, freshIdRef, fail: false, failReason: null }
  const lifted = []
  for (const s of body) {
    const r = liftStmt(s, ctx)
    if (ctx.fail) return null
    if (r != null) { if (Array.isArray(r) && r[0] === '__seq__') lifted.push(...r.slice(1)); else lifted.push(r) }
  }
  if (!lifted.length) return null

  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`, simdBrkLabel = `$__simd_brk${id}`, simdLoopLabel = `$__simd_loop${id}`
  const info = LANE_INFO[laneType], lanes = info.lanes
  const boundExpr = cloneNode(bound)   // cloned: also lives in the scalar-tail exit guard
  // Overshoot-safe bound: a full lanes-wide chunk [x,x+lanes) must stay < bound for
  // ANY start x (stencils start at 1). `bound-(lanes-1)` — NOT `& ~(lanes-1)`, which
  // overshoots for a non-multiple start. SIMD reads ⊆ scalar reads ⇒ no new OOB.
  // A toroidal-wrap stencil additionally PEELS both boundary columns scalar: cap the SIMD at
  // `min(bound, …rightWrapBoundaries) - (lanes-1)` so no chunk reaches a right-wrap column x=B,
  // and run x=0 scalar below (where the left wrap fires) so the SIMD starts in the wrap-free interior.
  const simdCap = rightBs.reduce((acc, b) => ['select', cloneNode(b), acc, ['i32.lt_s', cloneNode(b), acc]], boundExpr)
  const boundSetup = ['local.set', simdBoundName, ['i32.sub', simdCap, ['i32.const', lanes - 1]]]
  const simdBlock = ['block', simdBrkLabel,
    ['loop', simdLoopLabel,
      ['br_if', simdBrkLabel, ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...lifted,
      ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', lanes]]],
      ['br', simdLoopLabel]]]
  // Left-boundary peel for a wrap stencil: run the original scalar body once for x=0 (where the wrap
  // takes its WRAP branch), advancing x to 1 so the SIMD starts in the wrap-free interior. Guarded so
  // an empty loop (x ≥ bound) is untouched. Right boundary + odd tail: the kept scalar tail (blockNode).
  const peelStmts = needsPeel
    ? [['if', ['i32.lt_s', ['local.get', incVar], cloneNode(bound)],
        ['then', ...body.map(cloneNode), cloneNode(bl.loopNode[bl.incIdx])]]]
    : []
  // LICM-hoisted $__li invariants run ahead of the SIMD block (the scalar tail's
  // copy inside bl.blockNode re-runs them harmlessly — pure & loop-invariant).
  const wrapper = ['block', ...preamble.map(cloneNode), ...peelStmts, boundSetup, simdBlock, bl.blockNode]
  const newLocalDecls = [['local', simdBoundName, 'i32'], ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']), ...extraLocals]
  return { wrapper, newLocalDecls }
}

// ---- Reduction recognizer -------------------------------------------------
//
// Matches inner loops of shape:
//     for (let i = 0; i < N; i++) S = OP(S, EXPR(arr[i], ...))
// where OP is associative+commutative (REDUCE_OPS table) and EXPR is lane-
// pure (operates on the loaded element with at most loop-invariant data).
// S is a SCALAR loop-carried accumulator — exempt from the lane-local
// "first access must be a write" check.
//
// Lift:
//   acc = splat(IDENTITY)
//   for (i = 0; i < bound & ~(L-1); i += L) acc = OP_v(acc, lifted EXPR)
//   S = OP(S, horizontal_reduce(acc))
//   <original scalar tail handles the remainder>
//
// Float adds are not strictly associative — vectorized reduction differs
// from scalar reduction by ulps. Acceptable when bit-exact equality is not
// required (which it isn't, by spec, in JS engines either).
function tryReduceVectorize(bl, fnLocals, freshIdRef, multiAcc = false) {
  // Same scaffold as tryVectorize, but no preamble: a reduction block is just the loop.
  if (!bl || bl.preamble.length) return null
  const { loopNode, incIdx, incVar } = bl

  // Body is either a bare single-statement reduction —
  //   (local.set $acc (OP (local.get $acc) EXPR))            add/xor/and/or
  // — or a NaN-canonicalized two-statement min/max reduction —
  //   (local.set $cn  (OP (local.get $acc) EXPR))
  //   (local.set $acc (select C (local.get $cn) (T.ne $cn $cn)))
  // A conditional-store min/max (`if (a[i] > m) m = a[i]`) is the SAME reduction as the ternary
  // `m = a[i] > m ? a[i] : m`; rewrite it to the select-assign form so one recognizer covers both.
  // Sound for recognition: the lane EXPR (an array load) is pure, and the SIMD lift reads it
  // unconditionally anyway (pmax), while the scalar remainder keeps the original conditional store.
  const asSelectAssign = (stmt) => {
    if (isArr(stmt) && stmt[0] === 'if' && stmt.length === 3 && isArr(stmt[2]) && stmt[2][0] === 'then' && stmt[2].length === 2) {
      const set = stmt[2][1]
      if (isArr(set) && set[0] === 'local.set' && set.length === 3 && !hasSideEffect(set[2]))
        return ['local.set', set[1], ['select', set[2], ['local.get', set[1]], stmt[1]]]
    }
    return stmt
  }
  const bodyStmts = []
  for (let i = 3; i < incIdx; i++) bodyStmts.push(asSelectAssign(loopNode[i]))
  // CSE collapse: `m = a[i] > m ? a[i] : m` hoists the load into its own `(local.set $t LOAD)`
  // ahead of the reduction, making a 2-statement body the single-statement min/max recognizer
  // misses. When $t is pure (no side effect, no accumulator reference) inline it back into the
  // reduction so the canonical one-statement shape is recognized. Sound: the lift only consumes
  // the inlined lane expr for the SIMD prefix; the original $t set survives in the scalar
  // remainder (the unchanged blockNode), so $t stays defined wherever else it is read.
  let body0 = bodyStmts
  if (bodyStmts.length === 2) {
    const [s1, s2] = bodyStmts
    if (isArr(s1) && s1[0] === 'local.set' && typeof s1[1] === 'string' && s1.length === 3 &&
        isArr(s2) && s2[0] === 'local.set' && typeof s2[1] === 'string' && s2.length === 3 && s1[1] !== s2[1]) {
      const t = s1[1], expr = s1[2]
      const usesName = (n, name) => isArr(n) && ((n[0] === 'local.get' && n[1] === name) || n.some(c => usesName(c, name)))
      if (!hasSideEffect(expr) && !usesName(expr, s2[1]) && !usesName(expr, t)) {
        const subst = (n) => isArr(n) ? (n[0] === 'local.get' && n[1] === t ? expr : n.map(subst)) : n
        body0 = [['local.set', s2[1], subst(s2[2])]]
      }
    }
  }
  const bodyLen = body0.length
  let accName, opName, reduceEntry, exprNode, canonC = null
  if (bodyLen === 1) {
    const stmt = body0[0]
    if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
    accName = stmt[1]
    if (typeof accName !== 'string') return null
    const rhs = stmt[2]
    if (!isArr(rhs)) return null
    const minmax = matchIntMinMaxReduce(rhs, accName)
    if (minmax && minmax.laneType === 'f64') {
      // Comparison min/max over an f64 array (`m = a[i] > m ? a[i] : m`). f64x2.pmax/pmin
      // replicate the scalar `(a>m)?a:m` EXACTLY per element — pmax(m,a) = (m<a)?a:m keeps the
      // accumulator on NaN (m<NaN is false) and on a ±0 tie, never NaN-poisoning the way
      // f64x2.max would. They preserve the data's exact NaN bits (a selection, not a compute),
      // so no canon is needed. The ONLY divergence from the sequential scalar is the SIGN of a
      // zero RESULT when the extremum is hit by both +0 and −0 in different lanes (a cross-lane
      // reorder) — strictly less than the ULP reassociation the sum reductions already accept,
      // so it rides the relaxedSimd tier (on at 'speed'); strict callers opt out (scalar).
      if (!_relaxF32) return null
      reduceEntry = {
        simd: minmax.isMax ? 'f64x2.pmax' : 'f64x2.pmin',
        extract: 'f64x2.extract_lane', laneType: 'f64',
        identity: ['f64.const', minmax.isMax ? '-inf' : 'inf'],
        minmaxSelect: true, isMax: minmax.isMax, pmaxF64: true,
      }
      exprNode = minmax.exprNode
    } else if (minmax) {
      // Synthetic entry: WASM has the SIMD i32x4.max_s/min_s but no scalar i32.max, so the
      // horizontal fold + merge below use select (flagged by minmaxSelect). Identity is the
      // op's neutral — INT_MIN for max, INT_MAX for min. A bare narrow load instead folds
      // at its own lane width/sign (MINMAX_WIDEN), 16 or 8 lanes per vector.
      const w = isArr(minmax.exprNode) && minmax.exprNode.length === 2
        ? MINMAX_WIDEN[minmax.exprNode[0]] : null
      reduceEntry = w ? {
        simd: `${w.pre}.${minmax.isMax ? 'max' : 'min'}_${w.sign}`,
        extract: `${w.pre}.extract_lane_${w.sign}`, laneType: w.laneType,
        identity: ['i32.const', minmax.isMax ? w.lo : w.hi],
        minmaxSelect: true, isMax: minmax.isMax, accI32: true,
      } : {
        simd: minmax.isMax ? 'i32x4.max_s' : 'i32x4.min_s',
        extract: 'i32x4.extract_lane', laneType: 'i32',
        identity: ['i32.const', minmax.isMax ? -2147483648 : 2147483647],
        minmaxSelect: true, isMax: minmax.isMax,
      }
      exprNode = minmax.exprNode
    } else if (rhs[0] === 'block') {
      // Un-flattened NaN-canon float min/max — the same reduction as the two-statement
      // canon (bodyLen===2 below), but with the cn-temp set + select still wrapped in a
      // value-block: (local.set acc (block (result T) (local.set cn (OP acc expr))
      // (select C (local.get cn) (T.ne cn cn)))). mergeBlocks normally hoists this to the
      // flat form; recognize the block form directly so vectorization doesn't hinge on
      // that hoist having run.
      let bi = 1
      if (typeof rhs[bi] === 'string' && rhs[bi].startsWith('$')) bi++
      if (isArr(rhs[bi]) && rhs[bi][0] === 'result') bi++
      const inner = rhs[bi]
      const op = isArr(inner) && inner[0] === 'local.set' && isArr(inner[2]) ? inner[2][0] : null
      reduceEntry = op ? REDUCE_CANON[op] : null
      if (!reduceEntry) return null
      const cb = matchCanonBlock(rhs, reduceEntry.laneType)
      if (!cb || !isArr(cb.core) || cb.core.length !== 3 || !isLocalGet(cb.core[1], accName)) return null
      opName = op
      exprNode = cb.core[2]
      canonC = cb.C
    } else {
      if (rhs.length !== 3) return null
      opName = rhs[0]
      reduceEntry = REDUCE_OP_LOOKUP.get(opName)
      if (!reduceEntry || !isLocalGet(rhs[1], accName)) return null
      exprNode = rhs[2]
    }
  } else if (bodyLen === 2) {
    const s1 = body0[0], s2 = body0[1]
    if (!isArr(s1) || s1[0] !== 'local.set' || s1.length !== 3) return null
    if (!isArr(s2) || s2[0] !== 'local.set' || s2.length !== 3) return null
    const cnName = s1[1], rhs = s1[2]
    if (typeof cnName !== 'string' || !isArr(rhs) || rhs.length !== 3) return null
    opName = rhs[0]
    reduceEntry = REDUCE_CANON[opName]
    if (!reduceEntry) return null
    accName = s2[1]
    if (typeof accName !== 'string' || accName === cnName) return null
    const canon = matchCanonSelect(s2[2], reduceEntry.laneType)
    if (!canon || !isLocalGet(canon.val, cnName)) return null
    if (!isLocalGet(rhs[1], accName)) return null
    canonC = canon.C
    exprNode = rhs[2]
  } else return null

  // Offset-indexed reductions (matmul `s += A[ai+k]*Bt[bj+k]`): the index `ai+k`
  // lowers to `(i32.shl (i32.add ai i) K)`, which matchLaneAddr rejects (the IV is
  // not the bare shift operand). Fold the loop-invariant part into the base —
  //   (base + (INV+i)<<K)  →  ((base + INV<<K) + i<<K)
  // so the offset is the bare IV the matcher/lifter already accept. The byte address
  // is unchanged, so the v128.load reads the same consecutive pair → bit-exact. INV
  // must be loop-invariant (not written in the loop) and IV-free (coefficient 1).
  {
    const writtenInLoop = new Set()
    ;(function wr(n) { if (!isArr(n)) return; if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') writtenInLoop.add(n[1]); for (let i = 1; i < n.length; i++) wr(n[i]) })(loopNode)
    const invFree = (n) => !isArr(n) || (!(n[0] === 'local.get' && (n[1] === incVar || writtenInLoop.has(n[1]))) && n.every((c, i) => i === 0 || invFree(c)))
    let folded = false
    const foldAddr = (n) => {
      if (!isArr(n)) return n
      if (n[0] === 'i32.add' && n.length === 3) {
        for (const [base, off] of [[n[1], n[2]], [n[2], n[1]]]) {
          if (isArr(off) && off[0] === 'i32.shl' && off.length === 3 && isArr(off[1]) && off[1][0] === 'i32.add' && off[1].length === 3) {
            const k = constNum(off[2]), x = off[1][1], y = off[1][2]
            const xIV = isLocalGet(x, incVar), yIV = isLocalGet(y, incVar)
            if (k != null && k >= 0 && k <= 3 && xIV !== yIV) {
              const inv = xIV ? y : x
              if (invFree(inv)) {
                folded = true
                return ['i32.add', ['i32.add', foldAddr(base), ['i32.shl', inv, ['i32.const', k]]], ['i32.shl', ['local.get', incVar], ['i32.const', k]]]
              }
            }
          }
        }
      }
      return n.map(foldAddr)
    }
    const fe = foldAddr(exprNode)
    if (folded) exprNode = fe
  }

  // Accumulator's declared local type must match the lane element type.
  // Exception: the widening byte/short sum — i32 accumulator fed by ONE bare
  // narrow load (`s += u8[i]`), whose LANE type is i8/i16 but reduces into i32.
  const accType = fnLocals.get(accName)
  const widen = (opName === 'i32.add' && accType === 'i32' && canonC == null
    && isArr(exprNode) && exprNode.length === 2 && WIDEN_LOADS[exprNode[0]]) || null
  // Widening float min/max: the canon over a sign-matched converted narrow load
  // (`m = Math.max(m, u8[i])`, acc f64) folds at the load's own width — exact,
  // since min/max never rounds and u8…i16 values are exact in f64. Only the one
  // horizontal result converts to f64 for the merge (+ re-canon for a NaN acc).
  if (canonC != null && (opName === 'f64.max' || opName === 'f64.min') && accType === 'f64'
      && isArr(exprNode) && exprNode.length === 2 && MINMAX_CVT[exprNode[0]] && isArr(exprNode[1])) {
    const w = MINMAX_WIDEN[exprNode[1][0]]
    if (w && w.sign === MINMAX_CVT[exprNode[0]]) {
      const isMax = opName === 'f64.max'
      reduceEntry = {
        simd: `${w.pre}.${isMax ? 'max' : 'min'}_${w.sign}`,
        extract: `${w.pre}.extract_lane_${w.sign}`, laneType: w.laneType,
        identity: ['i32.const', isMax ? w.lo : w.hi],
        minmaxSelect: true, isMax, accF64: exprNode[0], canonC,
      }
      exprNode = exprNode[1]
      canonC = null
    }
  }
  if (!widen && accType !== (reduceEntry.accI32 ? 'i32' : reduceEntry.accF64 ? 'f64' : reduceEntry.laneType)) return null

  // Bound must be loop-invariant: (local.get $L) or (i32.const N).
  const { bound, boundLocal } = bl
  if (!boundLocal && !isI32Const(bound)) return null

  // Scan EXPR for lane-aligned loads. Stores forbidden. Re-references of
  // accName forbidden (the accumulator only appears in the outer wrapper).
  const laneType = widen ? widen.laneType : reduceEntry.laneType
  const stride = LANE_INFO[laneType].stride
  const addrLocals = new Map()
  const offsetTees = new Map()
  let loadCount = 0, sawWidenF32 = false
  function scanExpr(node) {
    if (!isArr(node)) return true
    const op = node[0]
    if (LOAD_OPS[op]) {
      // f32→f64 widening reduction (`s += f32arr[i]`, acc f64): liftExprV promotes
      // the f32.load to f64x2.promote_low_f32x4, so accept it under an f64 lane and
      // validate at the f32 element stride (4) — the loop still steps `lanes` (2)
      // elements, advancing the f32 address by 8 bytes (the load64_zero the lift reads).
      const ltw = LOAD_OPS[op]
      const widenF32 = ltw === 'f32' && laneType === 'f64'
      if (ltw !== laneType && !widenF32) return false
      if (widenF32) sawWidenF32 = true
      const m = matchLaneAddr(node[1], incVar, addrLocals, offsetTees)
      if (!m) return false
      if ((1 << m.strideLog2) !== (widenF32 ? 4 : stride)) return false
      if (m.teeName) addrLocals.set(m.teeName, { strideLog2: m.strideLog2, base: m.base })
      if (m.offsetTeeName) offsetTees.set(m.offsetTeeName, m.strideLog2)
      loadCount++
      return true
    }
    if (STORE_OPS[op]) return false
    if (op === 'local.set' || op === 'local.tee') return false  // no intermediates
    if (op === 'local.get' && node[1] === accName) return false
    for (let i = 1; i < node.length; i++) if (!scanExpr(node[i])) return false
    return true
  }
  if (!scanExpr(exprNode)) return null
  if (loadCount === 0) return null
  // Soundness gate for offset-tee resolution (see tryVectorize).
  for (const [name, k] of offsetTees) {
    if (_offsetLocalStride([exprNode], name, incVar) !== k) return null
  }

  // Classify locals referenced in EXPR. Anything not the induction var or an
  // address-tee is invariant (we forbade local.set/tee in scanExpr).
  const referenced = new Set()
  const collectRefs = (n) => {
    if (!isArr(n)) return
    if (n[0] === 'local.get' && typeof n[1] === 'string') referenced.add(n[1])
    for (let i = 1; i < n.length; i++) collectRefs(n[i])
  }
  collectRefs(exprNode)
  const localKind = new Map()
  for (const name of referenced) {
    if (name === incVar) continue
    if (addrLocals.has(name) || offsetTees.has(name)) { localKind.set(name, 'addr'); continue }
    localKind.set(name, 'invariant')
  }
  for (const name of addrLocals.keys()) localKind.set(name, 'addr')
  for (const name of offsetTees.keys()) localKind.set(name, 'addr')

  const ctx = { laneType, incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, fnLocals, newLanedLocals: new Map(), extraLocals: [], freshIdRef, fail: false, failReason: null }

  const liftedExpr = liftExprV(exprNode, ctx)
  // liftExprV's contract is "null ⟺ ctx.fail"; under self-host (jz.wasm) it can diverge and
  // return null WITHOUT the flag, which would otherwise splice a literal `null` operand into the
  // emitted `(<reduce>.add acc null)` — invalid wasm ("not enough arguments on the stack"). Treat
  // a null lift as a bail (the loop stays scalar — correct, just unvectorized on that leg).
  if (ctx.fail || liftedExpr == null) return null
  if (ctx.newLanedLocals.size > 0 || ctx.extraLocals.length > 0) return null

  // Synthesize SIMD prefix block + horizontal reduce + (preserved scalar tail).
  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`
  const simdAccName = `$__simd_acc${id}`   // accumulator 0 — the one the merge folds
  const simdBrkLabel = `$__simd_brk${id}`
  const simdLoopLabel = `$__simd_loop${id}`
  const info = LANE_INFO[laneType]
  const lanes = info.lanes
  const boundExpr = boundLocal ? ['local.get', boundLocal] : bound

  // Multi-accumulator unroll. A reduction's loop-carried accumulator is a latency
  // chain — each iteration's op waits on the previous result, so a single vector
  // accumulator runs at FP-op latency, not throughput. N INDEPENDENT accumulators
  // (each summing every Nth lane-chunk, combined at the end) expose instruction-
  // level parallelism and hide the latency — ~2x on a dot/FIR reduction. It is
  // DETERMINISTIC: only the reduction's reassociation widens (8 partial sums vs 2),
  // the same kind the existing 2-lane fold already does, identical on every engine.
  // Restricted to the plain horizontal-fold FP path (not min/max-select, the
  // narrow-widening sums, or NaN-canon — those have their own fold shapes).
  // The f32→f64 widening sum uses half-width load64_zero loads; the multi-accumulator
  // offsetLoads/laneBytes logic assumes full v128 loads, so keep it single-accumulator.
  const plainReduce = !reduceEntry.minmaxSelect && !widen && !sawWidenF32 && canonC == null
  const NACC = (multiAcc && plainReduce && (laneType === 'f64' || laneType === 'f32')) ? 4 : 1
  const accK = (k) => k === 0 ? simdAccName : `$__simd_acc${id}_${k}`
  const laneBytes = lanes * stride

  // Widening sum: the ACCUMULATOR vector is i32x4 regardless of the (narrow)
  // lane type; each iteration's 16-byte load collapses via extadd_pairwise.
  const accSplat = widen ? 'i32x4.splat' : info.splat
  const accumOperand = widen ? widen.steps.reduce((e, s) => [s, e], liftedExpr) : liftedExpr
  // Accumulator k reads the same lane-aligned data as acc 0, shifted by k chunks
  // (k·laneBytes). Acc 0 keeps the address tees (it sets them); acc k>0 reads the
  // tee'd address (normTee → local.get) and adds the byte offset to each load.
  const offsetLoads = (node, off) => !isArr(node) ? node
    : node[0] === 'v128.load' ? ['v128.load', ['i32.add', node[1], ['i32.const', off]]]
    : node.map(c => offsetLoads(c, off))
  const accOperandFor = (k) => k === 0 ? accumOperand : offsetLoads(normTee(accumOperand), k * laneBytes)

  const initAcc = []
  for (let k = 0; k < NACC; k++) initAcc.push(['local.set', accK(k), [accSplat, reduceEntry.constNode ?? reduceEntry.identity]])
  const loopBody = []
  for (let k = 0; k < NACC; k++) loopBody.push(['local.set', accK(k), [reduceEntry.simd, ['local.get', accK(k)], accOperandFor(k)]])
  loopBody.push(['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', lanes * NACC]]])
  const simdBlock = ['block', simdBrkLabel,
    ['loop', simdLoopLabel,
      ['br_if', simdBrkLabel,
        ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...loopBody,
      ['br', simdLoopLabel]
    ]
  ]
  // Combine the N accumulators into acc 0 (lane-wise) before the horizontal fold.
  const combineAccs = []
  for (let k = 1; k < NACC; k++) combineAccs.push(['local.set', simdAccName, [reduceEntry.simd, ['local.get', simdAccName], ['local.get', accK(k)]]])

  // Horizontal fold + merge into the live accumulator.
  const extraDecls = []
  let mergeStmts
  if (reduceEntry.minmaxSelect) {
    // No scalar max/min op — fold via select through a temp (no exponential operand
    // duplication): ht = lane0; ht = minmax(ht, lane_k); acc = minmax(acc, ht). For int,
    // `select(a,b,(gt|lt)_s a b)` = max/min(a,b). For the f64 pmax/pmin reduction the scalar
    // equivalent is the pmax/pmin select — `pmax(a,b) = (a<b)?b:a` — so the merge keeps the
    // same NaN/±0 tie semantics as the f64x2.pmax lanes.
    const ht = `$__simd_h${id}`
    extraDecls.push(['local', ht, reduceEntry.pmaxF64 ? 'f64' : 'i32'])
    const lane = (k) => [reduceEntry.extract, k, ['local.get', simdAccName]]
    const minmaxSel = reduceEntry.pmaxF64
      ? (a, b) => reduceEntry.isMax ? ['select', b, a, ['f64.lt', a, b]] : ['select', b, a, ['f64.lt', b, a]]
      : (a, b) => ['select', a, b, [reduceEntry.isMax ? 'i32.gt_s' : 'i32.lt_s', a, b]]
    mergeStmts = [['local.set', ht, lane(0)]]
    for (let k = 1; k < lanes; k++) mergeStmts.push(['local.set', ht, minmaxSel(lane(k), ['local.get', ht])])
    if (reduceEntry.accF64) {
      // Widening canon merge: one convert of the horizontal result, the scalar
      // f64 op against the live acc, then re-canon (a NaN-seeded acc must still
      // cross as the canonical NaN when the scalar tail is empty).
      mergeStmts.push(['local.set', accName,
        [opName, ['local.get', accName], [reduceEntry.accF64, ['local.get', ht]]]])
      mergeStmts.push(['local.set', accName,
        ['select', reduceEntry.canonC, ['local.get', accName],
          ['f64.ne', ['local.get', accName], ['local.get', accName]]]])
    } else {
      mergeStmts.push(['local.set', accName, minmaxSel(['local.get', accName], ['local.get', ht])])
    }
  } else {
    // Horizontal fold: scalar.op(extract 0, extract 1, …, extract L-1).
    // Widening sum folds the 4 i32x4 PARTIALS, not the (narrow) data lanes.
    const foldLanes = widen ? 4 : lanes
    let horiz = [reduceEntry.extract, 0, ['local.get', simdAccName]]
    for (let k = 1; k < foldLanes; k++) {
      horiz = [opName, horiz, [reduceEntry.extract, k, ['local.get', simdAccName]]]
    }
    // Merge the SIMD result into the live accumulator. For canon (min/max) the
    // merged value is re-canonicalized so a NaN that surfaced only in the SIMD
    // range still crosses as the canonical NaN when the scalar tail is empty.
    const merged = [opName, ['local.get', accName], horiz]
    mergeStmts = canonC == null
      ? [['local.set', accName, merged]]
      : [['local.set', accName, merged],
         ['local.set', accName,
           ['select', canonC, ['local.get', accName],
             [`${laneType}.ne`, ['local.get', accName], ['local.get', accName]]]]]
  }
  // Overshoot-safe SIMD bound: stop while a full `lanes`-wide load stays in
  // range, for ANY induction start (the min/max idiom seeds m=a[0] and starts
  // at i=1, which `& ~(lanes-1)` masking would run one lane past the end). For
  // a lane-aligned start this yields the same iteration set as masking; the
  // scalar tail (original `i<bound` guard) cleans up regardless.
  // A full N·lanes-wide step (all N accumulators) must stay in range.
  const boundSetup = ['local.set', simdBoundName, ['i32.sub', boundExpr, ['i32.const', lanes * NACC - 1]]]

  // Narrow-widened entries seed the vector acc with a LANE-domain neutral (e.g.
  // 0 for u8-max) — only neutral once real lanes fold in. Guard the whole SIMD
  // prefix incl. the merge so a zero-iteration range can't clamp the live acc
  // toward the identity. Full-width entries use absolute neutrals; unguarded.
  // (The guarded path is always NACC=1 — accI32/accF64 are non-plain reductions.)
  const core = reduceEntry.accI32 || reduceEntry.accF64
    ? [['if', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]],
        ['then', ...initAcc, simdBlock, ...combineAccs, ...mergeStmts]]]
    : [...initAcc, simdBlock, ...combineAccs, ...mergeStmts]
  const wrapper = ['block', boundSetup, ...core, bl.blockNode]
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ['local', simdAccName, 'v128'],
    ...Array.from({ length: NACC - 1 }, (_, k) => ['local', accK(k + 1), 'v128']),
    ...extraDecls,
  ]
  return { wrapper, newLocalDecls }
}

// Bit-exact f64 map-reduce (the direct-summation n-body force loop). A loop that
// accumulates one or more f64 reductions whose per-iteration contribution is computed
// INDEPENDENTLY of the accumulators. Process 2 iterations per step in f64x2 — every lane
// op (sub/mul/add/div/sqrt) is IEEE-754-identical to scalar f64 (no FMA in non-relaxed
// SIMD) — then accumulate each accumulator's two lane contributions IN SCALAR ORDER, so
// the reduction is BIT-EXACT (unlike the reassociating tryReduceVectorize). Wins when the
// per-element compute is expensive (a sqrt + reciprocal) so the 2-wide arithmetic
// outweighs the serial lane-accumulation. The original block is preserved as the ≤1
// scalar remainder, continuing the accumulators. Returns {wrapper, newLocalDecls} or null.
function tryMapReduceVectorize(bl, fnLocals, freshIdRef) {
  if (!bl || bl.preamble.length) return null
  const { incVar, bound, boundLocal, body } = bl
  if (!boundLocal && !isI32Const(bound)) return null
  if (body.length < 2) return null

  // Every body stmt must be `(local.set $x EXPR)`. An accumulator reads its own target
  // through `f64.add` (`acc = acc + EXPR`); the rest are per-iteration lane locals. (One
  // write per acc — duplicate writes would break the per-acc ordering.)
  for (const s of body) if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3)) return null
  const accSet = new Set()
  for (const s of body) if (isArr(s[2]) && s[2][0] === 'f64.add' && isLocalGet(s[2][1], s[1])) accSet.add(s[1])
  if (!accSet.size) return null
  const writeCount = new Map()
  for (const s of body) writeCount.set(s[1], (writeCount.get(s[1]) || 0) + 1)
  for (const a of accSet) { if (writeCount.get(a) !== 1 || fnLocals.get(a) !== 'f64') return null }

  // Address tees: locals that equal `ind << K`. f64 loads must be stride-8 (K=3) so one
  // f64x2.load (16 bytes) covers iterations j and j+1 — consecutive elements.
  const offsetTees = new Map()
  const allNames = new Set()
  const gather = (n) => { if (!isArr(n)) return; if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') allNames.add(n[1]); for (let i = 1; i < n.length; i++) gather(n[i]) }
  for (const s of body) gather(s)
  for (const name of allNames) { const k = _offsetLocalStride(body, name, incVar); if (k != null) offsetTees.set(name, k) }

  // f64x2 lift: load → f64x2.load (2 consecutive), const/invariant → splat, a lane local
  // → its f64x2 temp, sub/mul/add/div → f64x2.OP, sqrt → f64x2.sqrt. Anything else bails.
  const laneV = new Map()
  const newLocalDecls = []
  const fresh = () => { const n = `$__mr${freshIdRef.next++}`; newLocalDecls.push(['local', n, 'v128']); return n }
  let bad = false
  const lift = (e) => {
    if (bad || !isArr(e)) { bad = true; return null }
    const op = e[0]
    if (op === 'f64.const') return ['f64x2.splat', e]
    if (op === 'f64.load') {
      const m = matchLaneAddr(e[1], incVar, new Map(), offsetTees)
      if (!m || m.strideLog2 !== 3) { bad = true; return null }
      return ['v128.load', e[1]]   // 16 bytes = 2 consecutive f64s; the f64x2 op reads them
    }
    if (op === 'local.get' && typeof e[1] === 'string') {
      if (e[1] === incVar || accSet.has(e[1])) { bad = true; return null }   // IV-as-data / acc-dependent contribution
      if (laneV.has(e[1])) return ['local.get', laneV.get(e[1])]
      if (writeCount.has(e[1])) { bad = true; return null }   // a body local used BEFORE its set this iteration → loop-carried, not a fresh lane
      return ['f64x2.splat', e]   // genuine loop-invariant scalar (xi, …)
    }
    if ((op === 'f64.add' || op === 'f64.sub' || op === 'f64.mul' || op === 'f64.div') && e.length === 3)
      return [op.replace('f64.', 'f64x2.'), lift(e[1]), lift(e[2])]
    if (op === 'f64.sqrt' && e.length === 2) return ['f64x2.sqrt', lift(e[1])]
    bad = true; return null
  }

  // Lifted body: setup lanes → f64x2 temps (in order, so the offset tee in the first load
  // is set before later loads read it); each accumulator → a temp + two in-order adds.
  const lifted = []
  for (const s of body) {
    if (accSet.has(s[1])) {
      const cV = fresh()
      const v = lift(s[2][2])
      if (bad) return null
      lifted.push(['local.set', cV, v],
        ['local.set', s[1], ['f64.add', ['local.get', s[1]], ['f64x2.extract_lane', 0, ['local.get', cV]]]],
        ['local.set', s[1], ['f64.add', ['local.get', s[1]], ['f64x2.extract_lane', 1, ['local.get', cV]]]])
    } else {
      const tv = fresh()
      laneV.set(s[1], tv)
      const v = lift(s[2])
      if (bad) return null
      lifted.push(['local.set', tv, v])
    }
  }
  if (bad || !lifted.length) return null

  // SIMD prefix over the even prefix [0, bound & ~1); the original block is the ≤1 scalar
  // remainder (continues j and the accumulators). IV advances by 2.
  const id = freshIdRef.next++
  const simdBoundName = `$__mrb${id}`, simdBrk = `$__mrbrk${id}`, simdLoop = `$__mrl${id}`
  const boundExpr = boundLocal ? ['local.get', boundLocal] : ['i32.const', constNum(bound)]
  const simdBlock = ['block', simdBrk,
    ['loop', simdLoop,
      ['br_if', simdBrk, ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...lifted,
      ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', 2]]],
      ['br', simdLoop]]]
  // span-aligned (same entry≠0 hazard as tryVectorize's bound — see there)
  const boundSetup = ['local.set', simdBoundName,
    ['i32.add', ['local.get', incVar],
      ['i32.and', ['i32.sub', boundExpr, ['local.get', incVar]], ['i32.const', -2]]]]
  const wrapper = ['block', boundSetup, simdBlock, bl.blockNode]
  return { wrapper, newLocalDecls: [['local', simdBoundName, 'i32'], ...newLocalDecls] }
}

// Scalar locals that are ALWAYS computed as `(i32.add base (i32.shl ind K))`
// or aliased to such an address are "address tees", not lane data. They stay
// scalar i32 in the lifted body.
function _isAddressLocal(body, name, ind) {
  let onlyAsAddrTee = true
  let foundTee = false
  function walk(n) {
    if (!isArr(n)) return
    if (n[0] === 'local.tee' && n[1] === name) {
      foundTee = true
      // Check the value is a lane-address shape
      const m = matchLaneAddr(['local.tee', name, n[2]], ind)
      if (!m) onlyAsAddrTee = false
      return
    }
    if (n[0] === 'local.set' && n[1] === name) {
      // A set-not-tee: check value shape
      const m = matchLaneAddr(['local.tee', name, n[2]], ind)
      if (!m) onlyAsAddrTee = false
      foundTee = true
      return
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  for (const s of body) walk(s)
  return foundTee && onlyAsAddrTee
}

// A pixel-INDEX local — every write is `(i32.mul P ind)` — is the `const j = P*i` of an
// AoS loop (feeds channel addresses `base + ((j+c)<<K)`). Classified as 'addr' so the lift
// keeps it a recomputed scalar i32, never a v128 lane. (Only tryVectorize consults this.)
function _isPixelIndexLocal(body, name, ind) {
  let found = false, ok = true
  function walk(n) {
    if (!isArr(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === name && n.length === 3) {
      found = true
      if (matchConstMulIV(n[2], ind) == null) ok = false
      return
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  for (const s of body) walk(s)
  return found && ok
}

// ---- Lifter ----------------------------------------------------------------

// Returns the v128 lane-local NAME (a string) for `name`, allocating once. We store the bare
// string — NOT a `{laneName}` object — because a schema-object read back through the Map in a
// DIFFERENT function returns undefined under self-host. Takes `newLanedLocals` directly
// (not ctx) so callers don't need to pass the full ctx object to a helper at call-depth 2.
function getOrAllocLanedLocal(name, newLanedLocals) {
  let laneName = newLanedLocals.get(name)
  if (!laneName) {
    laneName = `${name}__v`
    newLanedLocals.set(name, laneName)
  }
  return laneName
}

// AoS de-interleave gather/scatter (ctx.aosPixelStride P > 1). The SIMD block steps the IV
// by `lanes`, so a scalar address `A` points at pixel i, channel c; pixel i+1's same channel
// is P elements = P*elemSize bytes further — reachable as a static load/store `offset`.
// aosAddrPair yields two address forms that evaluate `A` exactly ONCE (teeing when needed).
function aosAddrPair(addr, ctx) {
  if (isArr(addr) && addr[0] === 'local.get') return { a0: addr, a1: addr }               // live local — read twice, free
  if (isArr(addr) && addr[0] === 'local.tee' && addr.length === 3) return { a0: addr, a1: ['local.get', addr[1]] }
  const g = `$__aosa${ctx.freshIdRef.next++}`                                              // bare expr — tee into a scratch
  ctx.extraLocals.push(['local', g, 'i32'])
  return { a0: ['local.tee', g, addr], a1: ['local.get', g] }
}
const aosLoad = (off, addr) => off ? ['f64.load', `offset=${off}`, addr] : ['f64.load', addr]
const aosStore = (off, addr, val) => off ? ['f64.store', `offset=${off}`, addr, val] : ['f64.store', addr, val]

// A scalar `(f64.load [offset=X] A)` → the f64x2 [pixel i chan, pixel i+1 chan]. Bit-exact:
// the two lanes are the exact bytes the two scalar iterations read.
function aosGather(expr, ctx) {
  const delta = ctx.aosPixelStride * LANE_INFO.f64.stride
  let baseOff = 0, addr
  if (typeof expr[1] === 'string' && expr[1].startsWith('offset=')) { baseOff = parseInt(expr[1].slice(7)) || 0; addr = expr[2] }
  else addr = expr[1]
  const { a0, a1 } = aosAddrPair(addr, ctx)
  return ['f64x2.replace_lane', 1, ['f64x2.splat', aosLoad(baseOff, a0)], aosLoad(baseOff + delta, a1)]
}

// Inline a PURE user function call `(call $f ARG…)` into a single scalar value-BLOCK, feeding
// the result back through liftExprV so the callee's ternaries/compares/transcendentals lift via
// the SAME machinery (no separate restricted inliner). Bails (null) on any non-value statement
// (store/loop/impure) — only straight-line pure helpers (spow, a signed-power, …) inline.
//
// Every argument AND every callee local is bound ONCE to a fresh block-local; param/local reads
// substitute to `(local.get bind)`. This is critical for NESTED calls (spow whose ratio arg is
// used 3× and itself nests spow): naive expr substitution would duplicate each arg per use and
// blow up exponentially (there is no CSE pass after the 'post' vectorizer). Binding keeps the
// SIMD body the same size as the scalar call graph.
// Infer the wasm type of a value node — from its `.type` expando (jz stamps every instruction) or
// the op prefix (`f64.add`→f64, `i32.mul`→i32, v128 ops→v128). Used to declare inline temps.
function nodeWasmType(n) {
  if (isArr(n)) {
    if (typeof n.type === 'string') return n.type
    const op = n[0]
    if (typeof op === 'string') {
      if (op.startsWith('f64.') || op === 'f64x2.extract_lane') return 'f64'
      if (op.startsWith('f32.')) return 'f32'
      if (op.startsWith('i64.')) return 'i64'
      if (op.startsWith('i32.')) return 'i32'
      if (op.startsWith('f64x2.') || op.startsWith('f32x4.') || op.startsWith('i32x4.') || op.startsWith('i8x16.') || op.startsWith('i16x8.') || op.startsWith('i64x2.') || op.startsWith('v128.')) return 'v128'
    }
  }
  return null
}

// Inline a pure function call into an expression, returning a `(block (result T) …binds… value)`
// (or the bare value if no binding was needed) — or null if the callee isn't straight-line pure.
// `resultType` is the callee's result type ('f64' by default, the vectorizer's only use). When a
// `localSink` array is passed, the fresh `$__ia` binding temps are declared into it (`['local', n, T]`)
// so a general caller can hoist them into the enclosing function; the vectorizer omits it (its lane
// lift re-types the block). Params must be read-only (else the substitution model breaks).
export function inlinePureCallExpr(callNode, pureFuncMap, freshIdRef, localSink = null, resultType = 'f64', tempPrefix = '$__ia') {
  const callee = pureFuncMap && pureFuncMap.get(callNode[1])
  if (!callee) return null
  const bodyStart = findBodyStart(callee)
  if (bodyStart < 0) return null
  const params = [], paramType = new Map(), localType = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const d = callee[i]
    if (isArr(d) && d[0] === 'param' && typeof d[1] === 'string') { params.push(d[1]); paramType.set(d[1], d[2]) }
    else if (isArr(d) && d[0] === 'local' && typeof d[1] === 'string') localType.set(d[1], d[2])
  }
  const args = callNode.slice(2)
  if (args.length !== params.length) return null
  const body = callee.slice(bodyStart)
  for (const p of params) if (writesName(body, p)) return null   // params must be read-only
  const subst = new Map()
  // Callee-local RENAMING (general-inliner path, localSink passed): a callee local
  // reached via `local.tee` / control-flow `local.set` isn't captured by bindOnce,
  // so its NAME would collide with same-named caller locals (the canonical trap:
  // arrow `(x,k)=>…` inlined into a caller whose variable is also `x`). Rename at
  // substitution time — sub() returns substituted caller-arg nodes WHOLE without
  // descending, so a rename can never touch a caller node. A tee/set of a name
  // bindOnce already substituted means reads and writes diverged — bail (broken).
  let broken = false
  // Caller-origin subtrees injected by substitution, tracked by node IDENTITY: the
  // leak backstop must skip them — a caller local legitimately named like a callee
  // local (`x`/`k` args into an `(x,k)=>…` arrow) is not a leak.
  const injected = new Set()
  const renames = localSink ? new Map() : null
  const renameOf = (name) => {
    let r = renames.get(name)
    if (!r) {
      r = `${tempPrefix}${freshIdRef.next++}`
      renames.set(name, r)
      localSink.push(['local', r, localType.get(name) || 'f64'])
    }
    return r
  }
  const sub = (n) => {
    if (!isArr(n)) return n
    if (n[0] === 'local.get' && typeof n[1] === 'string') {
      if (subst.has(n[1])) { const v = subst.get(n[1]); injected.add(v); return v }
      if (renames && localType.has(n[1])) return ['local.get', renameOf(n[1])]
    }
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') {
      if (subst.has(n[1])) { broken = true; return n }
      if (renames && localType.has(n[1])) return [n[0], renameOf(n[1]), ...n.slice(2).map(sub)]
    }
    return n.map((c, i) => i === 0 ? c : sub(c))
  }
  // A constant / bare local read is free to duplicate — substitute it directly (no binding),
  // which also keeps a constant exponent literal at the `pow` node so it can lower to 2-wide exp∘log.
  // convert-of-local too: one op over a register read, and keeping the convert SYNTACTIC at
  // every use is what lets the trunc∘convert / guard-vs-impossible-const identities fire
  // (the devirt arm-inline spills i32 args in that exact shape).
  const isTrivial = (n) => isArr(n) && (n[0] === 'f64.const' || n[0] === 'i32.const' ||
    (n[0] === 'local.get' && typeof n[1] === 'string') || (n[0] === 'global.get' && typeof n[1] === 'string') ||
    (n[0] === 'f64.convert_i32_s' && isArr(n[1]) && n[1][0] === 'local.get'))
  const pre = []
  const bindOnce = (name, valueExpr, declType, alreadySubbed) => {
    const v = alreadySubbed ? valueExpr : sub(valueExpr)
    if (isTrivial(v)) { subst.set(name, v); return }   // cheap → substitute directly, no temp
    const bn = `${tempPrefix}${freshIdRef.next++}`
    const t = declType || nodeWasmType(v) || 'f64'
    if (localSink) localSink.push(['local', bn, t])
    pre.push(['local.set', bn, v])
    subst.set(name, ['local.get', bn])
  }
  params.forEach((p, i) => bindOnce(p, args[i], paramType.get(p), true))   // args live in the OUTER scope — do NOT sub
  // Leak guard: a callee local reached only via `local.tee` (a CSE'd subexpression) or set inside
  // control flow is NOT captured by the top-level bindOnce, so its name would survive into the caller
  // where it isn't declared ("$x not in scope"). For the general inliner (localSink passed): RENAME
  // any surviving TRUE-local name to a fresh caller-scope local declared into the sink — sound,
  // locals are function-scoped names (a tee'd NaN-guard local `(x,k)=>(x??0)|0` is the canonical
  // shape). Params are read-only and fully substituted by bindOnce, so a surviving PARAM name means
  // the model broke — bail (keep the call) as the backstop. The VECTORIZER path (localSink == null)
  // re-processes the returned expression in its lane context — a tee'd callee local becomes a lane
  // local there — so it must NOT bail or rename, or pure helpers with a CSE'd tee (spow's `av`)
  // stop vectorizing.
  const calleeLocals = new Set([...paramType.keys(), ...localType.keys()])
  // Backstop: with renaming inlined into sub(), the only way a callee name survives
  // into a sink-spliced result is a broken substitution model (e.g. a param name in
  // write position, or a bindOnce'd local later tee'd). Bail — keep the call. The
  // VECTORIZER path (localSink == null) neither renames nor bails: it re-processes
  // the expression in its lane context, where a tee'd callee local becomes a lane
  // local — bailing there would stop pure helpers with a CSE'd tee (spow's `av`)
  // from vectorizing.
  const leaks = (n) => isArr(n) && !injected.has(n) &&
    (((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && calleeLocals.has(n[1])) || n.some((c, i) => i > 0 && leaks(c)))
  const wrap = (val) => {
    const r = pre.length ? ['block', ['result', resultType], ...pre, val] : val
    return (localSink && (broken || leaks(r))) ? null : r
  }
  for (let k = 0; k < body.length; k++) {
    const stmt = body[k]
    if (!isArr(stmt)) return null
    if (stmt[0] === 'local.set' && typeof stmt[1] === 'string' && stmt.length === 3) { bindOnce(stmt[1], stmt[2], localType.get(stmt[1]), false); continue }
    if (stmt[0] === 'return' && stmt.length === 2) return wrap(sub(stmt[1]))
    // Trailing value expression = implicit return (a bare `if`/`block`/… as the function's last
    // statement, `(v) => cond ? a : b`). Earlier non-set/non-return statements can't be values.
    if (k === body.length - 1) return wrap(sub(stmt))
    return null
  }
  return null
}

// Statement-position containers: a call that is a DIRECT child here may be a statement (void /
// block-fallthrough), where the value-producing `(block (result T) …)` inline form is ill-typed.
// The general inliner only rewrites calls in operand (value) position — the common `x = f(…)`,
// `a[i] = f(…)`, `f(…) * k` shapes — and recurses into these so nested-in-operand calls still inline.
const INLINE_STMT_CTX = new Set(['block', 'loop', 'func', 'then', 'else', 'if'])

// General pre-watr pure-function inlining — jz LOWERING (runs before the vectorizer). Replaces a
// `(call $g …)` in value position with $g's inlined body when $g is PURE (pureFuncMap) and
// straight-line. jz decides by PURITY + TYPES — knowledge watr's untyped, size-gated inliner lacks —
// exposing the callee's arithmetic to the vectorizer / narrower / const-folder. watr keeps only the
// mechanical residual. Bit-exact: params are read-only, args bind once (or substitute if trivial),
// the callee's straight-line body becomes a result-typed block. Fresh temps are declared into `fn`.
export function inlinePureFnsInFn(fn, pureFuncMap, freshIdRef, canInline) {
  if (!isArr(fn) || fn[0] !== 'func' || !pureFuncMap || !pureFuncMap.size || !canInline || !canInline.size) return
  const selfName = fn[1]
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const newLocals = []
  const resultTypeOf = (callee) => {
    for (let i = 2; i < callee.length; i++) {
      const d = callee[i]
      if (!isArr(d)) break
      if (d[0] === 'result') return d[1]
      if (d[0] !== 'param' && d[0] !== 'export' && d[0] !== 'local' && d[0] !== 'type') break
    }
    return 'f64'
  }
  const walk = (node) => {
    if (!isArr(node)) return node
    const parentIsStmt = INLINE_STMT_CTX.has(node[0])
    for (let i = 1; i < node.length; i++) {
      let child = node[i]
      if (!isArr(child)) continue
      child = walk(child)          // recurse first → inline nested calls (e.g. in this call's args)
      node[i] = child
      if (!parentIsStmt && child[0] === 'call' && typeof child[1] === 'string' &&
          child[1] !== selfName && canInline.has(child[1]) && pureFuncMap.has(child[1])) {
        const inlined = inlinePureCallExpr(child, pureFuncMap, freshIdRef, newLocals, resultTypeOf(pureFuncMap.get(child[1])), '$__gi')
        if (inlined != null) node[i] = inlined
      }
    }
    return node
  }
  for (let i = bodyStart; i < fn.length; i++) fn[i] = walk(fn[i])
  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}

// Wrap an already-lifted v128 value `coreV` in per-lane NaN canonicalization:
//   v128.bitselect(splat(C), coreV, laneNe(coreV, coreV))
// coreV is referenced three times. When it's a bare local.get (the common
// flattened form, where the core was already hoisted to a temp) we share it
// directly — matching the scalar select, which likewise reads the temp thrice.
// Otherwise we materialize a fresh v128 temp so the core evaluates once.
function liftCanon(coreV, C, ctx, info) {
  const laneNe = ctx.laneType === 'f32' ? 'f32x4.ne' : 'f64x2.ne'
  // The f32-via-f64 canon carries an f64 NaN const — splat it as f32 (demote is
  // exact for the canonical NaN, and the lane value coreV is already f32x4).
  const cF = ctx.laneType === 'f32' && isArr(C) && C[0] === 'f64.const' ? ['f32.const', C[1]] : C
  const splatC = [info.splat, cF]
  if (isArr(coreV) && coreV[0] === 'local.get') {
    return ['v128.bitselect', splatC, coreV, [laneNe, coreV, coreV]]
  }
  const tmp = `$__canon${ctx.freshIdRef.next++}`
  ctx.extraLocals.push(['local', tmp, 'v128'])
  const g = ['local.get', tmp]
  return ['block', ['result', 'v128'],
    ['local.set', tmp, coreV],
    ['v128.bitselect', splatC, g, [laneNe, g, g]]]
}

// --why-not-simd diagnostics. `_whyNotActive` is armed only for the duration of a
// vectorizeLaneLocal call made with the flag on (cleared on exit — never leaks into
// codegen, which never reads it). `_whyNotReason` captures the FIRST (deepest) lift
// bail for the block currently under the recognizer chain; the walk reads it after.
let _whyNotActive = false
let _whyNotReason = null
// Precision-relaxed f32 SIMD. jz computes Float32Array arithmetic in f64
// (`f32.demote_f64 (f64.mul (f64.promote_f32 …) …)`); lifting that chain to
// `f32x4.mul` over `v128.load` changes the intermediate from f64 to f32 — a
// sub-ulp difference at f32 precision (inaudible for audio/DSP, the canonical
// f32-SIMD trade every audio engine makes), but NOT bit-exact, so it is gated
// on the same `relaxedSimd` opt-in that enables relaxed-FMA. The promote/demote
// *strip* for a pure f32 copy (no arithmetic) round-trips losslessly and stays
// on unconditionally. Armed for the duration of a vectorizeLaneLocal call.
let _relaxF32 = false

// optimize.crPow, armed the same way — the const-exponent pow arm picks its lowering
// from it (lift ctx objects don't carry the optimize config; module flag is the pattern).
let _crPow = false

// Mark a lift bail and record its reason. First-write-wins: the innermost failing op
// sets ctx.failReason; outer frames see ctx.fail already set and return without
// overwriting, so the reason names the actual blocking op, not a wrapper.
const liftFail = (ctx, reason) => {
  ctx.fail = true
  if (ctx.failReason == null) ctx.failReason = reason
  if (_whyNotActive && _whyNotReason == null) _whyNotReason = reason
  return null
}

/** Lift a statement. Returns lifted stmt, or null to skip, or ['__seq__', ...] for multiple. */
// Conditional lane-local assignment in a stencil/map body — the sibling of the
// if-STORE path below, but the destination is a 'lane' LOCAL, not memory:
//   if (C) L = A   [else L = B | else <nested if assigning L>]
// the saturation / clamp shape (waves' amplitude clamp `if(nb>CAP)nb=CAP; else
// if(nb<-CAP)nb=-CAP`). Built as ONE nested `v128.bitselect` EXPRESSION so every
// mask reads the PRE-assignment lane value (no intermediate stores ⇒ order-free,
// and bit-exact with the scalar select chain — a comparison mask is all-ones /
// all-zeros per lane, so bitselect is an exact lane select), then a single
// `local.set` of the laned local. Returns the lifted node, or null when `stmt` is
// not a lane-assignment if (so the if-STORE path can try). Sets ctx.fail only once
// committed (a lane-if shape that cannot be lifted).
function tryLiftLaneIf(stmt, ctx) {
  const armBody = (arm) => {
    let body = arm.slice(1)
    if (body.length === 1 && isArr(body[0]) && body[0][0] === 'block') {
      const b = body[0]; let i = 1
      if (typeof b[i] === 'string' && b[i].startsWith('$')) i++
      if (isArr(b[i]) && b[i][0] === 'result') i++
      body = b.slice(i)
    }
    return body
  }
  // The lane being assigned: the innermost then-arm's single local.set target.
  const laneOf = (node) => {
    if (!isArr(node)) return null
    if (node[0] === 'local.set' && typeof node[1] === 'string' && ctx.localKind.get(node[1]) === 'lane') return node[1]
    if (node[0] === 'if' && isArr(node[2]) && node[2][0] === 'then') {
      const body = armBody(node[2])
      if (body.length === 1) return laneOf(body[0])
    }
    return null
  }
  const lane = laneOf(stmt)
  if (!lane) return null
  // Recurse the if-chain into nested bitselects; each `local.set L = V` is a leaf value.
  const buildVal = (node) => {
    if (isArr(node) && node[0] === 'local.set' && node[1] === lane) return liftExprV(node[2], ctx)
    if (isArr(node) && node[0] === 'if' && isArr(node[2]) && node[2][0] === 'then') {
      const thenBody = armBody(node[2])
      if (thenBody.length !== 1) return liftFail(ctx, 'lane-if: non-single then arm')
      let cond = node[1]
      if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
      const cmp = isArr(cond) && cond.length === 3 ? LANE_COMPARE[ctx.laneType]?.[cond[0]] : null
      if (!cmp) return liftFail(ctx, 'lane-if: condition is not a lane comparison')
      const ca = liftExprV(cond[1], ctx); if (ctx.fail) return null
      const cb = liftExprV(cond[2], ctx); if (ctx.fail) return null
      const thenVal = buildVal(thenBody[0]); if (ctx.fail) return null
      const elseArm = (isArr(node[3]) && node[3][0] === 'else') ? armBody(node[3]) : null
      let elseVal
      if (elseArm) {
        if (elseArm.length !== 1) return liftFail(ctx, 'lane-if: non-single else arm')
        elseVal = buildVal(elseArm[0]); if (ctx.fail) return null
      } else {
        elseVal = ['local.get', getOrAllocLanedLocal(lane, ctx.newLanedLocals)]   // no else ⇒ keep current
      }
      return ['v128.bitselect', thenVal, elseVal, [cmp, ca, cb]]
    }
    return liftFail(ctx, 'lane-if: unrecognized arm shape')
  }
  const val = buildVal(stmt)
  if (ctx.fail || val == null) return null
  return ['local.set', getOrAllocLanedLocal(lane, ctx.newLanedLocals), val]
}

function liftStmt(stmt, ctx) {
  if (!isArr(stmt)) {
    // Bare strings like "drop" — produced by stack-form WAT. We unwrap value-blocks
    // separately so an isolated "drop" should not appear here, but tolerate it.
    if (stmt === 'drop') return null
    return liftFail(ctx, 'non-array statement')
  }
  const op = stmt[0]

  if (op === 'local.set' && typeof stmt[1] === 'string' && stmt.length === 3) {
    const name = stmt[1]
    const kind = ctx.localKind.get(name)
    if (kind === 'addr') {
      // Address-only local: lift the value as-is (it's i32 arithmetic on ind).
      return ['local.set', name, stmt[2]]
    }
    // 'lane', or an UNCLASSIFIED local — which can only be one introduced by an inlined pure
    // callee (classification covers every original body local; a pure helper's temps are fresh
    // per-iteration lane values, never loop-carried). Both lift as lane data.
    if (kind === 'lane' || kind === undefined) {
      const laneName = getOrAllocLanedLocal(name, ctx.newLanedLocals)
      const v = liftExprV(stmt[2], ctx)
      if (ctx.fail) return null
      return ['local.set', laneName, v]
    }
    return liftFail(ctx, `local.set ${name}: loop-carried or unclassified local`)
  }

  if (STORE_OPS[op]) {
    const sty = STORE_OPS[op]
    // AoS de-interleave scatter: `(f64.store [offset=X] A V)` → tee the f64x2 V once, then
    // write lane 0 at X (pixel i) and lane 1 at X + P*elemSize (pixel i+1) — the exact two
    // scalar stores. Handles the folded `offset=` memarg form (channels d[j+1], d[j+2]).
    if (ctx.aosPixelStride > 1) {
      if (sty !== ctx.laneType) return liftFail(ctx, 'AoS narrowing store unsupported')
      let baseOff = 0, addr, val
      if (typeof stmt[1] === 'string' && stmt[1].startsWith('offset=')) { baseOff = parseInt(stmt[1].slice(7)) || 0; addr = stmt[2]; val = stmt[3] }
      else { addr = stmt[1]; val = stmt[2] }
      const v = liftExprV(val, ctx)
      if (ctx.fail) return null
      const delta = ctx.aosPixelStride * LANE_INFO.f64.stride
      const { a0, a1 } = aosAddrPair(addr, ctx)
      const vt = `$__aosv${ctx.freshIdRef.next++}`
      ctx.extraLocals.push(['local', vt, 'v128'])
      return ['__seq__',
        ['local.set', vt, v],
        aosStore(baseOff, a0, ['f64x2.extract_lane', 0, ['local.get', vt]]),
        aosStore(baseOff + delta, a1, ['f64x2.extract_lane', 1, ['local.get', vt]])]
    }
    const addr = stmt[1]  // we leave addresses as-is (scalar i32 expressions)
    // Handle memarg if present (last positional after addr/val): unlikely in
    // pre-watr IR for this shape; bail if more than 3 children.
    if (stmt.length !== 3) return liftFail(ctx, `${op} with memarg`)
    // Mirror store `a[INV − iv] = lane` (f64, 2 lanes): the vector's lanes
    // (iv, iv+1) mirror to (INV−iv, INV−iv−1) — one v128 store at INV−iv−1
    // with the f64 lanes SWAPPED. The scalar remainder keeps the plain form.
    if (ctx.laneType === 'f64' && sty === 'f64') {
      const mm = matchMirrorAddr(addr, ctx.incVar)
      if (mm) {
        const v = liftExprV(stmt[2], ctx)
        if (ctx.fail) return null
        const vt = `$__mirv${ctx.freshIdRef.next++}`
        ctx.extraLocals.push(['local', vt, 'v128'])
        const mAddr = ['i32.add', mm.base,
          ['i32.shl', ['i32.sub', ['i32.sub', mm.invExpr, ['local.get', ctx.incVar]], ['i32.const', 1]],
            ['i32.const', mm.strideLog2]]]
        return ['__seq__',
          ['local.set', vt, v],
          ['v128.store', mAddr,
            ['i8x16.shuffle', '8', '9', '10', '11', '12', '13', '14', '15', '0', '1', '2', '3', '4', '5', '6', '7',
              ['local.get', vt], ['local.get', vt]]]]
      }
    }
    // Narrowing store: a narrower element written from a wider float lane (`o[i] =
    // narrow(f(x))` — codec encode / downsample). The scalar store value carries a
    // conversion (f32.demote_f64, or the float→int ToInt32 idiom); peel it, lift the
    // inner float expr, and let narrowStore apply the SIMD narrow + low-byte store.
    if (sty !== ctx.laneType) {
      // Integer narrowing (`o[i] = (f(x)) | 0` into Int32Array/…) lowers via the saturating
      // i32x4.trunc_sat_f64x2_s_zero, which clamps +Inf / |x|≥2³¹ to INT_MAX where scalar
      // ToInt32 wraps mod 2³² — bit-exact for in-range finite values (every pixel/coordinate/
      // typical-DSP value), divergent only at that edge, so it rides relaxedSimd. Float demote
      // (f64→f32) is bit-exact (round-to-nearest both ways) and stays ungated.
      if (sty !== 'f32' && !_relaxF32) return liftFail(ctx, `narrowing ${ctx.laneType}->${sty} store saturates out-of-range (needs relaxedSimd)`)
      const inner = peelNarrowConv(stmt[2], sty)
      if (!inner) return liftFail(ctx, `narrowing store ${ctx.laneType}->${sty}: unrecognized conversion`)
      const innerV = liftExprV(inner, ctx)
      if (ctx.fail) return null
      const ns = narrowStore(addr, innerV, ctx.laneType, sty, ctx)
      return ns || liftFail(ctx, `no narrowing ${ctx.laneType}->${sty}`)
    }
    const val = liftExprV(stmt[2], ctx)
    if (ctx.fail) return null
    return ['v128.store', addr, val]
  }

  // (block (result T) STMTS... TAIL_EXPR) followed by sibling "drop" — we get
  // the block alone here; the "drop" is a separate sibling and is returned as
  // null by the next call. Strip the wrapper, lift the inner stmts; the
  // dropped-tail expr is discarded.
  if (op === 'block') {
    // Block may be: ['block', LABEL?, RESULT?, ...stmts]
    let i = 1
    if (typeof stmt[i] === 'string' && stmt[i].startsWith('$')) i++
    const hasResult = isArr(stmt[i]) && stmt[i][0] === 'result'
    if (hasResult) i++
    const inner = stmt.slice(i)
    const stmts = hasResult ? inner.slice(0, inner.length - 1) : inner
    const out = ['__seq__']
    for (const s of stmts) {
      const lifted = liftStmt(s, ctx)
      if (ctx.fail) return null
      if (lifted == null) continue
      if (Array.isArray(lifted) && lifted[0] === '__seq__') out.push(...lifted.slice(1))
      else out.push(lifted)
    }
    return out
  }

  // Standalone conditional store: `if (COND) { …inter; store(addr,A) } [else { …inter; store(addr,B) }]`.
  // Both arms end in a store to the SAME address; a missing else keeps the current value. Speculatively
  // lift both arms (intermediate sets become lane locals; masked lanes are discarded — lane-pure ops
  // are trap-free) and emit ONE store of `bitselect(A, B, mask(COND))`. Unlocks per-pixel conditional
  // maps like lorenz's i32x4 trail fade (`if (p & 0xffffff) px[i] = fade(p)`).
  if (op === 'if' && isArr(stmt[2]) && stmt[2][0] === 'then') {
    // First: conditional lane-LOCAL assignment (clamp/saturation) → bitselect into the laned local.
    const laneLifted = tryLiftLaneIf(stmt, ctx)
    if (ctx.fail) return null
    if (laneLifted) return laneLifted
    const armOf = (arm) => {
      let body = arm.slice(1)
      if (body.length === 1 && isArr(body[0]) && body[0][0] === 'block') {   // unwrap a single block arm
        const b = body[0]; let i = 1
        if (typeof b[i] === 'string' && b[i].startsWith('$')) i++
        if (isArr(b[i]) && b[i][0] === 'result') i++
        body = b.slice(i)
      }
      const last = body[body.length - 1]
      if (!isArr(last) || !STORE_OPS[last[0]] || last.length !== 3) return null
      return { inter: body.slice(0, -1), addr: last[1], val: last[2], store: last[0] }
    }
    const thenA = armOf(stmt[2]), elseA = (isArr(stmt[3]) && stmt[3][0] === 'else') ? armOf(stmt[3]) : null
    if (!thenA || (isArr(stmt[3]) && !elseA)) return liftFail(ctx, 'if-store: arm is not a conditional store')
    if (elseA && (JSON.stringify(thenA.addr) !== JSON.stringify(elseA.addr) || thenA.store !== elseA.store)) return liftFail(ctx, 'if-store: arms store differently')
    // mask from COND: a lane comparison, or (i32) a truthy test `lift(cond) != 0`.
    let cond = stmt[1]
    if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
    const cmp = isArr(cond) && cond.length === 3 ? LANE_COMPARE[ctx.laneType]?.[cond[0]] : null
    let mask
    if (cmp) { const ca = liftExprV(cond[1], ctx); if (ctx.fail) return null; const cb = liftExprV(cond[2], ctx); if (ctx.fail) return null; mask = [cmp, ca, cb] }
    else if (ctx.laneType === 'i32') { const lc = liftExprV(cond, ctx); if (ctx.fail) return null; mask = ['i32x4.ne', lc, ['i32x4.splat', ['i32.const', 0]]] }
    else return liftFail(ctx, 'if-store: non-comparison condition')
    const out = ['__seq__']
    const liftInter = (arm) => { for (const s of arm.inter) { const l = liftStmt(s, ctx); if (ctx.fail) return false; if (l != null) { if (Array.isArray(l) && l[0] === '__seq__') out.push(...l.slice(1)); else out.push(l) } } return true }
    if (!liftInter(thenA)) return null
    if (elseA && !liftInter(elseA)) return null
    const thenVal = liftExprV(thenA.val, ctx); if (ctx.fail) return null
    const elseVal = elseA ? liftExprV(elseA.val, ctx) : ['v128.load', thenA.addr]   // no else ⇒ keep current value
    if (ctx.fail) return null
    const mtmp = `$__mask${ctx.freshIdRef.next++}`
    ctx.extraLocals.push(['local', mtmp, 'v128'])
    out.push(['local.set', mtmp, mask], ['v128.store', thenA.addr, ['v128.bitselect', thenVal, elseVal, ['local.get', mtmp]]])
    return out
  }

  // Standalone expression-as-statement (e.g. a load that gets dropped) — bail.
  return liftFail(ctx, `standalone ${op} statement`)
}

/** Lift a value expression into v128 context. */
function liftExprV(expr, ctx) {
  if (!isArr(expr)) return liftFail(ctx, 'non-expression operand')
  const op = expr[0]
  const info = LANE_INFO[ctx.laneType]

  // Widening byte-map: a narrow UNSIGNED load feeding i32-lane arithmetic. Load
  // the 4 elements as a partial vector and zero-extend to i32x4. Only the
  // widening recognizer sets ctx.widenLoads; tryVectorize ties the lane type to
  // the load width and never reaches here with a narrow load under i32 lanes.
  if (ctx.widenLoads && ctx.laneType === 'i32') {
    if (op === 'i32.load8_u')
      return ['i32x4.extend_low_i16x8_u', ['i16x8.extend_low_i8x16_u', ['v128.load32_zero', expr[1]]]]
    if (op === 'i32.load16_u')
      return ['i32x4.extend_low_i16x8_u', ['v128.load64_zero', expr[1]]]
  }

  // Widening f32→f64 load: a Float32Array read promoted to f64 (`f64.promote_f32(f32.load …)`,
  // e.g. schrodinger's f32 potential `V[idx]` inside an f64 stencil). Load the 2 f32 lanes
  // (load64_zero = 8 bytes = V[idx],V[idx+1]) and promote to f64x2 — the consecutive pair the
  // two f64 lanes need. Only in f64-lane context; bit-exact (same promote the scalar does).
  if (op === 'f64.promote_f32' && ctx.laneType === 'f64' && isArr(expr[1]) && expr[1][0] === 'f32.load') {
    const ld = expr[1]
    const addr = typeof ld[1] === 'string' && ld[1].startsWith('offset=') ? ['v128.load64_zero', ld[1], ld[2]] : ['v128.load64_zero', ld[1]]
    return ['f64x2.promote_low_f32x4', addr]
  }

  // f32-lane: jz computes Float32Array arithmetic in f64, wrapping the f32 load in
  // `f64.promote_f32` and the result in `f32.demote_f64`. The promote/demote are
  // lane-space identities — strip them (a promote-of-load + demote round-trips
  // losslessly: a pure `b[i]=a[i]` copy vectorizes bit-exactly, always). The f64
  // arithmetic op and any f64 constant map to their f32x4 forms only under
  // relaxedSimd, since computing in f32 (vs f64-then-demote) drops sub-ulp precision.
  if (ctx.laneType === 'f32') {
    if (op === 'f64.promote_f32') return liftExprV(expr[1], ctx)
    if (op === 'f32.demote_f64') return liftExprV(expr[1], ctx)
    // int→f32 widening load: `f64.convert_i32_{s,u}(<intload>(addr))` → load 4 ints,
    // widen to i32x4, f32x4.convert. i8/i16 are exact in f32; i32 rounds (gated).
    if ((op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u') && isArr(expr[1]) && INT_WIDEN_F32[expr[1][0]]) {
      const ld = expr[1], w = INT_WIDEN_F32[ld[0]]
      if (w.lossy && !_relaxF32) return liftFail(ctx, `${ld[0]}→f32 SIMD rounds (i32 exceeds f32 mantissa) — needs relaxedSimd`)
      const addr = typeof ld[1] === 'string' && ld[1].startsWith('offset=') ? [w.load, ld[1], ld[2]] : [w.load, ld[1]]
      let v = addr
      for (const step of w.steps) v = [step, v]
      return [w.cvt === 'u' ? 'f32x4.convert_i32x4_u' : 'f32x4.convert_i32x4_s', v]
    }
    if (op === 'f64.const') {
      if (!_relaxF32) return liftFail(ctx, 'f64 constant in f32 lane needs relaxedSimd (f32 round of the constant)')
      return ['f32x4.splat', ['f32.const', expr[1]]]
    }
    const f32op = F64_TO_F32X4[op]
    if (f32op) {
      if (!_relaxF32) return liftFail(ctx, `${op}: f32 SIMD computes in f32 not f64 (sub-ulp) — needs relaxedSimd`)
      const a = liftExprV(expr[1], ctx); if (ctx.fail) return null
      if (expr.length === 2) return [f32op, a]                 // unary: neg / abs / sqrt
      const b = liftExprV(expr[2], ctx); if (ctx.fail) return null
      return [f32op, a, b]
    }
  }

  // Loads → v128.load (preserving address, including any local.tee).
  if (LOAD_OPS[op]) {
    if (LOAD_OPS[op] !== ctx.laneType) return liftFail(ctx, `${op}: load type ≠ lane type ${ctx.laneType}`)
    // AoS de-interleave: consecutive elements are DIFFERENT channels, so a plain v128.load
    // would mix channels — gather the same channel of pixels i, i+1 into the f64x2 instead.
    if (ctx.aosPixelStride > 1) return aosGather(expr, ctx)
    // memarg form `(T.load offset=N addr)` — the stencil neighbour `a[i+1]` jz folds
    // onto `a[i]`'s address tee. `v128.load offset=N` reads the N-byte-shifted vector,
    // i.e. the (a[i+1], a[i+2]) pair — exactly the δ-shifted lane data. Preserve it.
    if (typeof expr[1] === 'string' && expr[1].startsWith('offset=')) return ['v128.load', expr[1], expr[2]]
    return ['v128.load', expr[1]]
  }

  // Constants → splat.
  if (op === info.constOp) {
    return [info.splat, expr]
  }

  // local.get
  if (op === 'local.get' && typeof expr[1] === 'string') {
    const name = expr[1]
    // Induction variable used AS DATA (ramp-map) → splat to a ramp vector
    // [i, i+1, … i+LANES-1]. Only set by tryRampMap (i32 lanes); other
    // recognizers leave ctx.rampVar undefined, so the IV stays address-only.
    if (name === ctx.rampVar) {
      // The ramp [i, i+1, i+2, i+3] is materialized once per iteration into
      // ctx.rampTemp (set at the top of the lifted body); every use reads it.
      return ['local.get', ctx.rampTemp]
    }
    const kind = ctx.localKind.get(name)
    if (kind === 'lane') {
      const laneName = getOrAllocLanedLocal(name, ctx.newLanedLocals)
      return ['local.get', laneName]
    }
    if (kind === 'invariant') {
      // An invariant whose wasm type ≠ the lane element type needs a scalar
      // convert before the splat. The common case: an f64 multiplier/gain splat
      // into an f32 lane (`out[i] = in[i] * k`). Demoting k to f32 is the same
      // precision relaxation as the f32 arithmetic itself, so gate it on relaxedSimd.
      if (ctx.laneType === 'f32' && ctx.fnLocals?.get(name) === 'f64') {
        if (!_relaxF32) return liftFail(ctx, `${name}: f64 invariant in f32 lane needs relaxedSimd`)
        return [info.splat, ['f32.demote_f64', ['local.get', name]]]
      }
      return [info.splat, ['local.get', name]]
    }
    if (kind === 'addr' || name === ctx.incVar) {
      return liftFail(ctx, `${name}: address/induction var used as lane data`)
    }
    // Unclassified (undefined) & not the IV/addr: a local introduced by an inlined pure callee —
    // read its lane shadow (the matching lane-set default above allocated it).
    return ['local.get', getOrAllocLanedLocal(name, ctx.newLanedLocals)]
  }

  // `(local.tee $x V)` in value position — a CSE temp inside a value expression (e.g. the base
  // teed for reuse in an inlined `x**(k/5)` fifthroot / a repeated subexpression). Lift V into the
  // lane shadow of $x and tee it: later `(local.get $x)` reads resolve to the same shadow.
  if (op === 'local.tee' && typeof expr[1] === 'string' && expr.length === 3) {
    const name = expr[1]
    const kind = ctx.localKind.get(name)
    if (kind === 'lane' || kind === undefined) {
      const v = liftExprV(expr[2], ctx); if (ctx.fail) return null
      return ['local.tee', getOrAllocLanedLocal(name, ctx.newLanedLocals), v]
    }
    return liftFail(ctx, `local.tee ${name}: non-lane local in value position`)
  }

  // Loop-invariant global (e.g. a hoistConstantPool'd const, or any global the
  // loop never writes) → splat. The recognizer bails when the body contains a
  // global.set, so every global.get reaching here is invariant across lanes.
  if (op === 'global.get' && typeof expr[1] === 'string') {
    return [info.splat, expr]
  }

  // `f64(invariant i32)` — e.g. `x[i] / N` with N an i32 global/invariant: the convert is a
  // loop-invariant scalar, so compute once and splat (== scalar-then-splat, bit-exact). Unblocks
  // pure-f64 maps that scale/divide by an integer count (rfft cepstrum `cep[i] = x[i] / N`).
  if ((op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u') && expr.length === 2) {
    const inner = expr[1]
    const inv = isArr(inner) && (inner[0] === 'global.get' || (inner[0] === 'local.get' && ctx.localKind.get(inner[1]) === 'invariant'))
    if (inv) return [info.splat, expr]
    // Sign / small-int ternary `cond ? A : B` (A,B integer literals) lowered to
    // `(f64.convert_i32_s (select (i32.const A) (i32.const B) COND))` — e.g. `a<0 ? -1 : 1`.
    // Convert the literals to f64 and bitselect by COND's lane mask (the f64-lane ternary).
    if (ctx.laneType === 'f64' && isArr(inner) && inner[0] === 'select' && inner.length === 4 &&
        isI32Const(inner[1]) && isI32Const(inner[2])) {
      let cond = inner[3]
      if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
      const cmpS = isArr(cond) && cond.length === 3 ? LANE_COMPARE.f64?.[cond[0]] : null
      if (cmpS) {
        const ca = liftExprV(cond[1], ctx); if (ctx.fail) return null
        const cb = liftExprV(cond[2], ctx); if (ctx.fail) return null
        const mtmp = `$__mask${ctx.freshIdRef.next++}`
        ctx.extraLocals.push(['local', mtmp, 'v128'])
        return ['block', ['result', 'v128'],
          ['local.set', mtmp, [cmpS, ca, cb]],
          ['v128.bitselect', ['f64x2.splat', ['f64.const', inner[1][1]]], ['f64x2.splat', ['f64.const', inner[2][1]]], ['local.get', mtmp]]]
      }
    }
  }

  // NaN-canonicalization wrapper (float lanes only; integer lanes never carry
  // it). Both the flattened `select` form and the un-flattened `block` form
  // lift to a per-lane v128.bitselect — canonical value in NaN lanes, X
  // elsewhere — exactly reproducing the scalar canonicalization lane-by-lane.
  if (op === 'select') {
    // NaN-canonicalization idiom `(select C X (T.ne X X))` — FLOAT lanes only (an
    // integer lane never carries it, since no i32 value is NaN).
    if (ctx.laneType === 'f64' || ctx.laneType === 'f32') {
      const m = matchCanonSelect(expr, ctx.laneType)
      if (m) {
        const coreV = liftExprV(m.val, ctx)
        return ctx.fail ? null : liftCanon(coreV, m.C, ctx, info)
      }
    }
    // General `select(X, Y, COND)` (wasm: X if COND else Y) — jz lowers a value
    // ternary `COND ? X : Y` to this when both arms are cheap/pure. Lift to
    // v128.bitselect(X, Y, mask) like the `if` form below — valid for EVERY lane type
    // (i32 included: COND maps via LANE_COMPARE[laneType], NaN is irrelevant). Both
    // arms are lane-pure (recursion forbids stores/sets) and trap-free, so evaluating
    // both then selecting is sound. f32 lane promotes operands → f64.* compare → f32x4.
    if (expr.length === 4) {
      const cond = expr[3]
      const cmpOp = isArr(cond) && ctx.laneType === 'f32' && typeof cond[0] === 'string' && cond[0].startsWith('f64.') ? 'f32.' + cond[0].slice(4) : (isArr(cond) ? cond[0] : null)
      const cmpSimd = cmpOp && cond.length === 3 ? LANE_COMPARE[ctx.laneType]?.[cmpOp] : null
      if (!cmpSimd) return liftFail(ctx, `select condition ${isArr(cond) ? cond[0] : '?'} not a lane comparison`)
      const x = liftExprV(expr[1], ctx); if (ctx.fail) return null
      const y = liftExprV(expr[2], ctx); if (ctx.fail) return null
      const ca = liftExprV(cond[1], ctx); if (ctx.fail) return null
      const cb = liftExprV(cond[2], ctx); if (ctx.fail) return null
      const mtmp = `$__mask${ctx.freshIdRef.next++}`
      ctx.extraLocals.push(['local', mtmp, 'v128'])
      return ['block', ['result', 'v128'],
        ['local.set', mtmp, [cmpSimd, ca, cb]],
        ['v128.bitselect', x, y, ['local.get', mtmp]]]
    }
    return liftFail(ctx, 'non-canonical select (not a NaN-canon idiom)')
  }
  if ((ctx.laneType === 'f64' || ctx.laneType === 'f32') && op === 'block') {
    const m = matchCanonBlock(expr, ctx.laneType)
    if (m) { const coreV = liftExprV(m.core, ctx); return ctx.fail ? null : liftCanon(coreV, m.C, ctx, info) }
    // General value-block (a let-binding): `(block [label] (result T) …laneSets… TAILVALUE)`.
    // jz emits these for an inlined value function (e.g. `av ** e` → an exp∘log block). Lift the
    // intermediate lane-local sets, then the tail value. Sound ONLY when the block is straight-line
    // (no br/br_if/br_table/return targeting it — an early-exit can't be flattened) — bail otherwise.
    let bi = 1
    if (typeof expr[bi] === 'string') bi++
    if (isArr(expr[bi]) && expr[bi][0] === 'result') bi++
    const parts = expr.slice(bi)
    if (parts.length === 0 || parts.some(hasBranchOrReturn)) return liftFail(ctx, 'non-canonical value-block')
    const out = ['block', ['result', 'v128']]
    for (let k = 0; k < parts.length - 1; k++) {
      const l = liftStmt(parts[k], ctx); if (ctx.fail) return null
      if (l != null) { if (Array.isArray(l) && l[0] === '__seq__') out.push(...l.slice(1)); else out.push(l) }
    }
    const tail = liftExprV(parts[parts.length - 1], ctx); if (ctx.fail) return null
    out.push(tail)
    return out
  }

  // Conditional select — jz lowers `cond ? X : Y` to (if (result LT) COND (then X)
  // (else Y)). Lift to v128.bitselect(X, Y, mask), where mask is COND as an
  // all-ones/all-zeros lane comparison. Both branches are lane-pure (recursion
  // forbids stores/sets) and trap-free (no liftable op traps — int div/rem aren't
  // lane-pure), so speculatively evaluating both is safe; bitselect keeps the
  // chosen lane. The mask is hoisted to a temp and computed FIRST: bitselect
  // evaluates X,Y before its 3rd operand, but any address `local.tee` lives in
  // COND and must run before the branches read it (matching scalar order).
  if (op === 'if') {
    // jz lowers `cond ? X : Y` to (if (result T) COND (then X)(else Y)). In an f32
    // lane it computes in f64 (promote/demote around the store), so the `if` carries
    // `(result f64)` and COND is an `f64.*` compare — accept both, mapping to f32x4.
    // The branch values are f32-mapped by recursion; gated by relaxedSimd via those.
    const resTy = isArr(expr[1]) && expr[1][0] === 'result' ? expr[1][1] : null
    if (resTy !== ctx.laneType && !(ctx.laneType === 'f32' && resTy === 'f64')) return liftFail(ctx, 'conditional without lane-typed result')
    const thenN = expr[3], elseN = expr[4]
    // A branch is `(then …preludeSets… TAILVALUE)` — usually just the tail (length 2), but jz's
    // NaN-canonicalization of a negation tees the value first (`(then (set $t (neg a)) (canon $t))`),
    // so accept intermediate lane-local sets before the tail. Both branches evaluate speculatively
    // (lane-pure ⇒ trap-free); each tail is snapshotted into its own temp BEFORE the other branch's
    // prelude runs, so a shared prelude local can't clobber the already-computed value.
    if (!isArr(thenN) || thenN[0] !== 'then' || thenN.length < 2) return liftFail(ctx, 'malformed conditional then-branch')
    if (!isArr(elseN) || elseN[0] !== 'else' || elseN.length < 2) return liftFail(ctx, 'malformed conditional else-branch')
    let cond = expr[2]
    if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]  // strip `!= 0`
    // f32 lane: operands were promoted, so the compare is `f64.*` — use its f32x4 form
    // (operands are exact f32→f64 promotions, so the lane comparison is unchanged).
    const cmpOp = isArr(cond) && ctx.laneType === 'f32' && typeof cond[0] === 'string' && cond[0].startsWith('f64.') ? 'f32.' + cond[0].slice(4) : (isArr(cond) ? cond[0] : null)
    const cmpSimd = cmpOp && cond.length === 3 ? LANE_COMPARE[ctx.laneType]?.[cmpOp] : null
    if (!cmpSimd) return liftFail(ctx, `${isArr(cond) ? cond[0] : 'condition'}: not a lane-vectorizable comparison`)
    const ca = liftExprV(cond[1], ctx); if (ctx.fail) return null
    const cb = liftExprV(cond[2], ctx); if (ctx.fail) return null
    // Lift a branch: its prelude sets, then its tail value snapshotted into `outTmp`.
    const liftArm = (arm, outTmp) => {
      const out = []
      for (let i = 1; i < arm.length - 1; i++) {
        const l = liftStmt(arm[i], ctx); if (ctx.fail) return null
        if (l != null) { if (Array.isArray(l) && l[0] === '__seq__') out.push(...l.slice(1)); else out.push(l) }
      }
      const v = liftExprV(arm[arm.length - 1], ctx); if (ctx.fail) return null
      out.push(['local.set', outTmp, v])
      return out
    }
    const id = ctx.freshIdRef.next++
    const tv = `$__then${id}`, ev = `$__else${id}`, mtmp = `$__mask${id}`
    ctx.extraLocals.push(['local', tv, 'v128'], ['local', ev, 'v128'], ['local', mtmp, 'v128'])
    // Mask FIRST: COND may carry an address `local.tee` the branch values read, so it must run
    // before them (matching scalar order — COND evaluates before the taken branch).
    const maskSet = ['local.set', mtmp, [cmpSimd, ca, cb]]
    const thenSeq = liftArm(thenN, tv); if (ctx.fail) return null
    const elseSeq = liftArm(elseN, ev); if (ctx.fail) return null
    return ['block', ['result', 'v128'],
      maskSet, ...thenSeq, ...elseSeq,
      ['v128.bitselect', ['local.get', tv], ['local.get', ev], ['local.get', mtmp]]]
  }

  // Lane-pure op?
  const table = LANE_PURE[ctx.laneType]
  const entry = table?.get(op)
  if (entry) {
    const a = liftExprV(expr[1], ctx)
    if (ctx.fail) return null
    if (entry.shamtScalar) {
      // Second operand stays scalar i32 — must be const or invariant local.
      const b = expr[2]
      if (!isI32Const(b) && !(isArr(b) && b[0] === 'local.get' && ctx.localKind.get(b[1]) === 'invariant')) {
        return liftFail(ctx, `${op}: shift amount not a constant or loop-invariant`)
      }
      return [entry.simd, a, b]
    }
    if (expr.length === 2) {  // unary (neg, abs, sqrt)
      return [entry.simd, a]
    }
    const b = liftExprV(expr[2], ctx)
    if (ctx.fail) return null
    return [entry.simd, a, b]
  }

  // Transcendental call → its bit-exact f64x2 mirror (pow/exp/log/exp2/sin/cos/atan2/hypot).
  // f64 lane only (the *2/_v helpers are f64x2). SIMD_PINNED keeps the scalar target alive
  // through watr's single-caller inlining so the `call` node still exists at lift time.
  // `$__to_num` is a numeric coercion jz wraps around a helper param it couldn't prove is f64
  // (e.g. `decode(src[j])`), boxing it via `i64.reinterpret_f64` first. In the lane every value
  // is already a genuine finite f64, so `__to_num(reinterpret_i64(x)) == x` — lift straight
  // through, peeling the box round-trip.
  if (op === 'call' && expr[1] === '$__to_num' && expr.length === 3) {
    let arg = expr[2]
    if (isArr(arg) && arg[0] === 'i64.reinterpret_f64' && arg.length === 2) arg = arg[1]
    return liftExprV(arg, ctx)
  }

  // `$math.pow(x, c)` with a CONSTANT non-integer exponent, found only during vectorization
  // (`ctx.constLocals`) — e.g. spow's `av ** nv` after pure-function inlining substitutes the
  // literal (module/math.js's own `emitPow` const-exponent fold never reaches here: its constant
  // exponent is known at EMIT time, so it already lowers straight to the scalar const-exponent
  // path, picked up by the generic PPC_CALL2 lift below). `optimize.crPow` picks the lowering,
  // mirroring emitPow's own default/crPow split (see the authoritative comment above emitPow):
  //   OFF (DEFAULT): truly-2-wide `exp_v(c · log_v(x))` — bit-identical to the scalar `$math.pow`
  //     for EVERY x when c is non-integer (verified: negative base → NaN and x=0 → 0/∞ both carry
  //     through log/exp identically; only the integer fast path differs, and it is excluded).
  //   ON: the truly-2-wide correctly-rounded `$math.pow_fold_v` (module/math.js) — the SIMD twin
  //     of the scalar `$math.pow_fold` (c needs no pre-split; the shared kernel twoProd-splits
  //     both multiply operands internally — see its own comment). Bit-identical to the scalar
  //     `$math.pow_fold` for every x — same function, called on both lanes.
  if (op === 'call' && ctx.laneType === 'f64' && expr[1] === '$math.pow' && expr.length === 4) {
    const ex = expr[3]
    let c = null
    if (isArr(ex) && ex[0] === 'f64.const') c = +ex[1]
    else if (isArr(ex) && ex[0] === 'local.get' && ctx.constLocals && ctx.constLocals.has(ex[1])) c = ctx.constLocals.get(ex[1])
    if (c != null && Number.isFinite(c) && !Number.isInteger(c)) {
      const base = liftExprV(expr[2], ctx); if (ctx.fail) return null
      if (_crPow) {
        return ['call', '$math.pow_fold_v', base, ['f64x2.splat', ['f64.const', c]]]
      }
      return ['call', '$math.exp_v', ['f64x2.mul', ['f64x2.splat', ex], ['call', '$math.log_v', base]]]
    }
  }

  if (op === 'call' && ctx.laneType === 'f64' && PPC_CALL2[expr[1]]) {
    const args = []
    for (let i = 2; i < expr.length; i++) { const a = liftExprV(expr[i], ctx); if (ctx.fail) return null; args.push(a) }
    return ['call', PPC_CALL2[expr[1]], ...args]
  }

  // Pure user-function call → inline its body as a value-expr and lift that (handles the callee's
  // ternaries/compares/pow via the arms above). Depth-guarded against pure→pure recursion.
  if (op === 'call' && ctx.laneType === 'f64' && ctx.pureFuncMap && ctx.pureFuncMap.has(expr[1]) && ctx.inlineDepth < 8) {
    const inlined = inlinePureCallExpr(expr, ctx.pureFuncMap, ctx.freshIdRef)
    if (inlined != null) {
      ctx.inlineDepth++
      const v = liftExprV(inlined, ctx)
      ctx.inlineDepth--
      return v
    }
  }

  return liftFail(ctx, `${op}: no lane-pure SIMD mapping for ${ctx.laneType}`)
}

// ---- Induction-variable strength reduction --------------------------------

// Match `(i32.add (local.get $base) (i32.shl (local.get $ind) (i32.const K)))` in either
// operand order, or `(i32.add (local.get $base) (local.get $ind))` (K=0). Returns
// {base, k} — the address of element $ind in array $base, byte stride 1<<k — or null.
function matchAffineAddr(node, ind) {
  if (!isArr(node) || node[0] !== 'i32.add' || node.length !== 3) return null
  const pair = (baseN, offN) => {
    if (!isLocalGet(baseN) || baseN[1] === ind) return null
    if (isLocalGet(offN, ind)) return { base: baseN[1], k: 0 }
    if (isArr(offN) && offN[0] === 'i32.shl' && offN.length === 3 && isLocalGet(offN[1], ind)) {
      const k = constNum(offN[2])
      if (k != null && k >= 0 && k <= 3) return { base: baseN[1], k }
    }
    return null
  }
  return pair(node[1], node[2]) || pair(node[2], node[1])
}

/**
 * Strength-reduce induction-variable addressing in an affine loop the vectorizer
 * couldn't lift (an early `break`, a call, a non-lane body). For each loop-invariant
 * array `base` and shift `K`, every `base + (i<<K)` in the body is replaced by a strided
 * pointer `$p`, initialized to `base + (i<<K)` before the loop and bumped by `1<<K` in
 * lockstep with `i`. Drops the per-iteration shift+add — V8 does NOT strength-reduce this
 * itself (measured ~6% faster, the additive keep-`i` form used here). Canonical shape only
 * (single +1 IV, bottom increment, br_if exit). Bails if the body writes `i` or any `base`
 * (not invariant), or branches to the loop label (which would skip the pointer bump — a
 * `br_if` to the *block* label, i.e. an early break, is fine: the loop is exiting). Runs
 * only where the vectorizer runs (speed levels), so it never grows the size-tuned build.
 */
function tryStrengthReduceIV(bl, fnLocals, freshIdRef) {
  // Bound-shape-agnostic: strength-reduces address arithmetic, not the loop bound,
  // so it accepts any scaffold (no local-or-const bound check). No preamble (was
  // allowPreamble:false).
  if (!bl || bl.preamble.length) return null
  const { loopNode, loopLabel, incIdx, incVar } = bl

  // Scan the body (stmts between the exit br_if and the bottom increment): collect
  // affine-address sites, track every written local, and bail on a loop-label branch.
  const sites = []                 // { parent, idx, base, k }
  const written = new Set()
  let bail = false
  const scan = (node, parent, pi) => {
    if (bail || !isArr(node)) return
    const op = node[0]
    if ((op === 'br' || op === 'br_if') && node[1] === loopLabel) { bail = true; return }
    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string') written.add(node[1])
    const m = matchAffineAddr(node, incVar)
    if (m) sites.push({ parent, idx: pi, base: m.base, k: m.k })
    for (let i = 1; i < node.length; i++) scan(node[i], node, i)
  }
  for (let i = 3; i < incIdx; i++) scan(loopNode[i], loopNode, i)
  if (bail || !sites.length || written.has(incVar)) return null

  // Group by (base, k); keep only loop-invariant i32 bases.
  const groups = new Map()         // `base|k` → { base, k, sites }
  for (const s of sites) {
    if (written.has(s.base) || fnLocals.get(s.base) !== 'i32') continue
    const key = s.base + '|' + s.k
    let g = groups.get(key)
    if (!g) groups.set(key, g = { base: s.base, k: s.k, sites: [] })
    g.sites.push(s)
  }
  if (!groups.size) return null

  // One strided pointer per group: init before the block, bump after the i increment,
  // every matched address → (local.get $p).
  const id = freshIdRef.next++
  const preInits = [], bumps = [], newLocalDecls = []
  let gi = 0
  for (const g of groups.values()) {
    const p = `$__iv${id}_${gi++}`
    newLocalDecls.push(['local', p, 'i32'])
    const off = g.k === 0 ? ['local.get', incVar] : ['i32.shl', ['local.get', incVar], ['i32.const', g.k]]
    preInits.push(['local.set', p, ['i32.add', ['local.get', g.base], off]])
    bumps.push(['local.set', p, ['i32.add', ['local.get', p], ['i32.const', 1 << g.k]]])
    for (const s of g.sites) s.parent[s.idx] = ['local.get', p]
  }
  loopNode.splice(incIdx + 1, 0, ...bumps)   // after the induction increment, before the br
  return { wrapper: ['block', ...preInits, bl.blockNode], newLocalDecls }
}

// ---- memory.copy / memory.fill loop idioms ---------------------------------

// Same-width store←load pairs (byte-window moves) and their element stride.
// Sign-variant narrow loads are interchangeable for a MOVE: load8_u/load8_s
// then store8 write the same byte back.
const MEMOP_STORES = {
  'f64.store':   { k: 3, loads: new Set(['f64.load']) },
  'i64.store':   { k: 3, loads: new Set(['i64.load']) },
  'f32.store':   { k: 2, loads: new Set(['f32.load']) },
  'i32.store':   { k: 2, loads: new Set(['i32.load']) },
  'i32.store16': { k: 1, loads: new Set(['i32.load16_u', 'i32.load16_s']) },
  'i32.store8':  { k: 0, loads: new Set(['i32.load8_u', 'i32.load8_s']) },
}

/**
 * Replace whole copy/fill loops with the engine's bulk-memory ops:
 *
 *   for (i < N) a[i] = b[i]   →  memory.copy (overlap-guarded)
 *   for (i < N) a[i] = 0      →  memory.fill 0    (any element width)
 *   for (i < N) u8[i] = C     →  memory.fill C    (byte stores only)
 *
 * V8 lowers memory.copy/fill to memmove/memset — typically several times the
 * throughput of even a SIMD lane loop, and a handful of bytes instead of one.
 * Runs BEFORE the lane vectorizer so these loops never pay the lift.
 *
 * Exactness:
 *  - COPY moves the same byte window the scalar loop wrote (same-width
 *    store←load pairs only — see MEMOP_STORES; f64 load/store round-trips are
 *    bit-exact per spec, so NaN payloads survive). memory.copy is memmove
 *    (as-if-buffered); the FORWARD loop differs from that exactly when the
 *    destination starts strictly inside the source window (dst reads bytes an
 *    earlier iteration already overwrote), so that case keeps the original
 *    loop behind a two-compare runtime guard — every other layout (disjoint,
 *    dst ≤ src, same array) is bit-identical.
 *  - FILL with 0 is width-agnostic (all-zero bytes; −0.0 is excluded — its
 *    sign bit is not zero). Non-zero fills only for byte stores with a
 *    loop-invariant constant ∈ [0,255].
 *  - The induction variable ends at `bound` exactly as the loop would leave
 *    it; a zero-trip range (i ≥ bound) leaves everything untouched.
 *  - In-bounds for the same reason the lane vectorizer's wide loads are: the
 *    moved window is exactly the byte range the scalar iterations touch.
 */
function tryMemCopyFill(bl, fnLocals, freshIdRef) {
  if (!bl || bl.preamble.length) return null   // no-preamble policy (was allowPreamble:false)
  const { loopNode, incVar, bound } = bl
  // Shape: [loop, $l, boundExit, (set,)? store, inc, br] — 1- or 2-statement body.
  if (loopNode.length !== 6 && loopNode.length !== 7) return null
  // Bound: const or an invariant local that is not the IV itself.
  if (!(isI32Const(bound) || (isArr(bound) && bound[0] === 'local.get' && typeof bound[1] === 'string' && bound[1] !== incVar))) return null

  // Body shapes (emit produces the two-statement form with a temp + shared
  // offset tee; fold/propagate sometimes collapse it to the bare store):
  //   1-stmt:  (T.store DADDR  CONST | (T.load SADDR))
  //   2-stmt:  (local.set $t (T.load SADDR)) (T.store DADDR (local.get $t))
  const addrLocals = new Map(), offsetTees = new Map()
  const laneAddr = (a) => {
    const m = matchLaneAddr(a, incVar, addrLocals, offsetTees)
    if (!m || m.viaLocal) return null
    if (m.offsetTeeName) offsetTees.set(m.offsetTeeName, m.strideLog2)
    if (!(isArr(m.base) && m.base[0] === 'local.get' && typeof m.base[1] === 'string' && m.base[1] !== incVar)) return null
    if (fnLocals.get(m.base[1]) !== 'i32') return null
    return m
  }
  let storeStmt, valNode, tempName = null
  if (loopNode.length === 6) {
    storeStmt = loopNode[3]
    if (!isArr(storeStmt) || storeStmt.length !== 3) return null
    valNode = storeStmt[2]
  } else {
    const s1 = loopNode[3]
    storeStmt = loopNode[4]
    if (!isArr(s1) || s1[0] !== 'local.set' || s1.length !== 3 || typeof s1[1] !== 'string') return null
    if (!isArr(storeStmt) || storeStmt.length !== 3) return null
    if (!(isArr(storeStmt[2]) && storeStmt[2][0] === 'local.get' && storeStmt[2][1] === s1[1])) return null
    tempName = s1[1]
    if (tempName === incVar) return null
    valNode = s1[2]
  }
  const entry = MEMOP_STORES[storeStmt[0]]
  if (!entry) return null

  // Classify VALUE first (the load side carries the offset tee in the 2-stmt form).
  let fillByte = null, srcM = null
  if (isArr(valNode) && valNode.length === 2 && (valNode[0] === 'i32.const' || valNode[0] === 'i64.const' || valNode[0] === 'f64.const' || valNode[0] === 'f32.const') && typeof valNode[1] === 'number') {
    if (valNode[1] === 0 && !Object.is(valNode[1], -0)) fillByte = 0
    else if (storeStmt[0] === 'i32.store8' && valNode[0] === 'i32.const' && Number.isInteger(valNode[1]) && valNode[1] >= 0 && valNode[1] <= 255) fillByte = valNode[1]
    else return null
  } else if (isArr(valNode) && valNode.length === 2 && entry.loads.has(valNode[0])) {
    srcM = laneAddr(valNode[1])
    if (!srcM || srcM.strideLog2 !== entry.k) return null
  } else return null

  const dstM = laneAddr(storeStmt[1])
  if (!dstM || dstM.strideLog2 !== entry.k) return null
  // Soundness for any shared offset tee resolved via `(local.get $T)` (see tryVectorize).
  for (const [name, k] of offsetTees) {
    if (_offsetLocalStride([loopNode[3], storeStmt], name, incVar) !== k) return null
  }

  const id = freshIdRef.next++
  const lenB = `$__mc${id}_len`, dstA = `$__mc${id}_dst`
  const newLocalDecls = [['local', lenB, 'i32'], ['local', dstA, 'i32']]
  const shl = (x) => entry.k === 0 ? x : ['i32.shl', x, ['i32.const', entry.k]]
  const boundC = () => cloneNode(bound)
  const setup = [
    ['local.set', lenB, shl(['i32.sub', boundC(), ['local.get', incVar]])],
    ['local.set', dstA, ['i32.add', ['local.get', dstM.base[1]], shl(['local.get', incVar])]],
  ]
  // Exact loop-exit state: i ends at bound; a matched offset tee holds the
  // LAST iteration's offset; the value temp holds the last element moved.
  const finish = [['local.set', incVar, boundC()]]
  const lastOff = () => shl(['i32.sub', boundC(), ['i32.const', 1]])
  for (const name of offsetTees.keys()) finish.push(['local.set', name, lastOff()])
  if (tempName != null && srcM) finish.push(['local.set', tempName,
    [valNode[0], ['i32.add', ['local.get', srcM.base[1]], lastOff()]]])
  if (tempName != null && srcM == null) finish.push(['local.set', tempName, cloneNode(valNode)])

  let action
  if (srcM == null) {
    action = [['memory.fill', ['local.get', dstA], ['i32.const', fillByte], ['local.get', lenB]], ...finish]
  } else {
    const srcA = `$__mc${id}_src`
    newLocalDecls.push(['local', srcA, 'i32'])
    setup.push(['local.set', srcA, ['i32.add', ['local.get', srcM.base[1]], shl(['local.get', incVar])]])
    // Forward-loop ≡ memmove unless dst starts strictly inside (src, src+len).
    action = [['if',
      ['i32.or',
        ['i32.le_u', ['local.get', dstA], ['local.get', srcA]],
        ['i32.ge_u', ['local.get', dstA], ['i32.add', ['local.get', srcA], ['local.get', lenB]]]],
      ['then',
        ['memory.copy', ['local.get', dstA], ['local.get', srcA], ['local.get', lenB]],
        ...finish],
      ['else', bl.blockNode]]]
  }

  const wrapper = ['block',
    ['if', ['i32.lt_s', ['local.get', incVar], boundC()],
      ['then', ...setup, ...action]]]
  return { wrapper, newLocalDecls }
}

// ---- Byte-scan (memchr) vectorization -------------------------------------

// Match a single-byte compare against a constant or a loop-invariant target:
//   (f64.eq|ne (f64.convert_i32_u|s (i32.load8_u|s (base + i))) TARGET)   [value-model form]
//   (i32.eq|ne (i32.load8_u|s (base + i)) TARGET)                          [folded i32 form]
// TARGET is a const byte or a `local.get` (the `memchr(buf, delim)` runtime case).
// Returns { base, eq, isF64, c, targetLocal } — exactly one of c (∈[0,255]) / targetLocal set.
function matchByteCompare(node, ind) {
  if (!isArr(node) || node.length !== 3) return null
  let eq
  if (node[0] === 'f64.eq' || node[0] === 'i32.eq') eq = true
  else if (node[0] === 'f64.ne' || node[0] === 'i32.ne') eq = false
  else return null
  const isF64 = node[0][0] === 'f'
  const constOf = (x) => isF64
    ? (isArr(x) && x[0] === 'f64.const' && typeof x[1] === 'number' && Number.isInteger(x[1]) ? x[1] : null)
    : constNum(x)
  // Identify which operand is the byte load and which is the target.
  const isLoadSide = (x) => {
    let l = x
    if (isF64) { if (!(isArr(l) && (l[0] === 'f64.convert_i32_u' || l[0] === 'f64.convert_i32_s') && l.length === 2)) return null; l = l[1] }
    if (!(isArr(l) && (l[0] === 'i32.load8_u' || l[0] === 'i32.load8_s') && l.length === 2)) return null
    const m = matchAffineAddr(l[1], ind)
    return m && m.k === 0 ? m.base : null            // byte stride only
  }
  let base = isLoadSide(node[1]), target = node[2]
  if (base == null) { base = isLoadSide(node[2]); target = node[1] }
  if (base == null) return null
  const c = constOf(target)
  if (c != null) return c >= 0 && c <= 255 ? { base, eq, isF64, c } : null
  // Runtime target: a loop-invariant local (the minimal scan body writes only `i`).
  if (isArr(target) && target[0] === 'local.get' && typeof target[1] === 'string' && target[1] !== ind)
    return { base, eq, isF64, targetLocal: target[1] }
  return null
}

/**
 * SIMD byte scan — vectorize a memchr-shaped loop the engine runs one byte at a time.
 * Recognizes the pure scan
 *   (block $b (loop $l (br_if $b (eqz (i<bound))) (br_if $b (buf[i] ==/!= C)) (i := i+1) (br $l)))
 * — "find the first index where buf[i] (Uint8/Int8Array) ==/!= a constant byte" — and
 * rewrites it to scan 16 bytes per step with `i8x16.eq` + `i8x16.bitmask`, locating the
 * exact first match via `i32.ctz`, with the original loop kept as the <16-byte tail.
 * Measured ~8× over the scalar scan on V8 (which doesn't auto-vectorize it). Fails closed:
 * any deviation from the exact shape leaves the scalar loop. The 16-wide `v128.load` is
 * in-bounds because it only fires while `i+16 <= bound` and `bound` bounds the scalar
 * reads too. (charCodeAt over a jz string is out of scope — it lowers to per-char
 * bounds/SSO/heap/decode branches, not a flat byte load.)
 */
function tryByteScan(bl, fnLocals, freshIdRef) {
  if (!bl || bl.preamble.length) return null
  const { blockLabel, loopNode, incVar, exitInfo } = bl
  // Exact shape: [loop, $l, boundExit, matchExit, inc, br] — nothing else. The
  // scaffold already verified boundExit/inc/back-branch; only the extra match-exit
  // br_if at loopNode[3] and the strict length remain.
  if (loopNode.length !== 6) return null
  const matchExit = loopNode[3]
  if (!(isArr(matchExit) && matchExit[0] === 'br_if' && matchExit[1] === blockLabel && matchExit.length === 3)) return null
  const bc = matchByteCompare(matchExit[2], incVar)
  if (!bc) return null
  if (fnLocals.get(bc.base) !== 'i32' || bc.base === incVar) return null

  const id = freshIdRef.next++
  const sd = `$__bscan_brk${id}`, sl = `$__bscan_loop${id}`, mask = `$__bscan_m${id}`
  const baseGet = ['local.get', bc.base]
  const iGet = ['local.get', incVar]
  const bound = exitInfo.bound
  const newLocalDecls = [['local', mask, 'i32']]

  // The byte to splat across 16 lanes, plus a runtime guard. A constant needs none.
  // A runtime `delim` (f64-boxed) is only a valid SIMD target when it's an integer in
  // [0,255]; outside that, NO byte (0–255) equals it, so the scalar tail — which we keep —
  // reproduces the exact result. The guard makes that branch explicit; cb caches the byte.
  let splat, guard = null, cbInit = null
  if (bc.c != null) {
    splat = ['i32.const', bc.c]
  } else {
    const cb = `$__bscan_c${id}`
    newLocalDecls.push(['local', cb, 'i32'])
    const tGet = ['local.get', bc.targetLocal]
    const inRange = ['i32.and', ['i32.ge_s', ['local.get', cb], ['i32.const', 0]], ['i32.le_s', ['local.get', cb], ['i32.const', 255]]]
    if (bc.isF64) {
      // cb = (i32)delim; valid iff it round-trips (delim is an integer) and is in [0,255].
      cbInit = ['local.set', cb, ['i32.trunc_sat_f64_s', cloneNode(tGet)]]
      guard = ['i32.and', ['f64.eq', ['f64.convert_i32_s', ['local.get', cb]], tGet], inRange]
    } else {
      // i32 delim: valid iff already in [0,255] (splat takes the low byte regardless).
      cbInit = ['local.set', cb, tGet]
      guard = inRange
    }
    splat = ['local.get', cb]
  }

  // bitmask of the 16-lane eq; for `!=` flip the low 16 bits so ctz finds the first non-match.
  const eqMask = ['i8x16.bitmask', ['i8x16.eq', ['v128.load', ['i32.add', baseGet, iGet]], ['i8x16.splat', splat]]]
  const scanMask = bc.eq ? eqMask : ['i32.xor', eqMask, ['i32.const', 0xffff]]
  const simdBlock = ['block', sd,
    ['loop', sl,
      // Stop before a 16-wide load would pass `bound`; the scalar tail mops up the rest.
      ['br_if', sd, ['i32.gt_s', ['i32.add', iGet, ['i32.const', 16]], cloneNode(bound)]],
      ['local.set', mask, scanMask],
      ['if', ['local.get', mask],
        ['then',
          ['local.set', incVar, ['i32.add', iGet, ['i32.ctz', ['local.get', mask]]]],
          ['br', blockLabel]]],
      ['local.set', incVar, ['i32.add', iGet, ['i32.const', 16]]],
      ['br', sl]
    ]
  ]
  // Const target: SIMD then scalar tail. Runtime target: cache cb, guard the SIMD, tail.
  const pre = guard ? [cbInit, ['if', guard, ['then', simdBlock]]] : [simdBlock]
  return {
    wrapper: ['block', blockLabel, ...pre, loopNode],
    newLocalDecls,
  }
}

const cloneNode = (n) => Array.isArray(n) ? n.map(cloneNode) : n

// ---- Channel-reduction recognizer (RGBA box-filter accumulation) -----------
//
// The image-convolution hot shape: 4 adjacent-byte accumulators summed over a
// window, then divided + stored — `for k: sr+=src[p]; sg+=src[p+1]; …` (blur,
// box filters, separable convolutions). The 4 channels are 4 i32x4 lanes, the
// 4-byte load is one widening v128.load32_zero. We vectorize ONLY the inner
// accumulation (integer add → associative/exact → bit-identical) and extract the
// lane sums back to the scalars; the edge-clamp address math and the per-pixel
// divide+store stay scalar, untouched. So no float-reduction reordering, no
// lane-juggled divide — just the dense inner loop lifted, safely.
//
// Operates on the OUTER pixel-loop block: its body is [exit, 4×(acc=0), …setup,
// (block (loop INNER)), …uses-of-acc, inc, br]. INNER's body accumulates the 4
// channels off a shared base address.

// Match `(local.set $ACC (i32.add (local.get $ACC) (i32.load8_u ADDR)))` where
// ADDR is `(local.get $base)` or `(local.tee $base EXPR)` at byte offset `off`.
// Returns { acc, base, off, teeExpr? } or null.
function matchChannelAccum(stmt, off) {
  if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
  const acc = stmt[1]
  const add = stmt[2]
  if (!isArr(add) || add[0] !== 'i32.add' || add.length !== 3) return null
  if (!isLocalGet(add[1], acc)) return null
  const load = add[2]
  if (!isArr(load) || load[0] !== 'i32.load8_u') return null
  // memarg offset: bare load → off 0; `i32.load8_u offset=N addr` → off N.
  let addr = load[1], loadOff = 0
  if (typeof load[1] === 'string' && /^offset=/.test(load[1])) { loadOff = +load[1].slice(7); addr = load[2] }
  if (loadOff !== off) return null
  if (isArr(addr) && addr[0] === 'local.tee' && addr.length === 3) return { acc, base: addr[1], off, teeExpr: addr[2] }
  if (isLocalGet(addr)) return { acc, base: addr[1], off }
  return null
}

// Recognize, inside the inner loop body, four consecutive channel accumulations
// `acc0+=base[0]; acc1+=base[1]; acc2+=base[2]; acc3+=base[3]` over ONE shared
// base. Returns { accs:[a0..a3], baseLocal, teeExpr, idx } (idx = position of the
// first accum stmt in `body`) or null.
function matchChannelGroup(body) {
  for (let i = 0; i + 3 < body.length; i++) {
    const m0 = matchChannelAccum(body[i], 0)
    if (!m0 || m0.teeExpr == null) continue   // first load carries the address tee
    const ms = [m0]
    let ok = true
    for (let c = 1; c < 4; c++) {
      const m = matchChannelAccum(body[i + c], c)
      if (!m || m.base !== m0.base || m.teeExpr != null) { ok = false; break }
      ms.push(m)
    }
    if (!ok) continue
    const accs = ms.map(m => m.acc)
    if (new Set(accs).size !== 4) continue   // four distinct accumulators
    return { accs, baseLocal: m0.base, teeExpr: m0.teeExpr, idx: i }
  }
  return null
}

// ---- Byte-map recognizer (ramp + widening loads) ---------------------------
//
// Vectorize `for (i = 0; i < N; i++) out[i] = NARROW(f_i32(…))` where the i32
// value is built from the induction variable used AS DATA (an i32x4 RAMP
// `[i, i+1, i+2, i+3]`) and/or WIDENED narrow loads (`u8[i]` zero-extended to
// i32x4). tryVectorize can't express either: it derives the lane type from an
// input load and ties the compute width to it, so a byte LUT-free map whose
// arithmetic overflows a byte (mul, shifts) — or that has no load at all —
// falls through to here, where everything lifts to i32x4 and narrow-stores.
//   • pure ramp (no loads, i8 store) → 16-wide pack (bytebeat)
//   • widening u8 loads → 4-wide (alpha blend, brightness/color/threshold)
//
// Matches the post-strength-reduction shape (the IV strength-reducer runs
// before this pass): the loop carries the logical IV (`i`, in the exit test,
// += 1) plus one or more strided output pointers (`p += C`). Each increment is
// scaled by LANES; the store narrows i32x4 back to the element width.
//
// Narrowing is truncation-exact for ANY i32 value (matching scalar store8/16):
// `i8x16.shuffle` selects the low byte of each lane — never saturates — so no
// value-range assumption is needed.
function tryRampMap(blockNode, fnLocals, freshIdRef) {
  // Strict envelope (identical to tryVectorize's) + trailing RUN of increments; the "every
  // increment shares the IV's name" check below is tryRampMap's own residual.
  const bl = matchBlockLoop(blockNode, { multiInc: true })
  if (!bl) return null
  const { incVar: ivName, bound, boundLocal, body, increments } = bl
  if (!boundLocal && !isI32Const(bound)) return null
  if (!body.length) return null
  if (body.some(hasGlobalSet)) return null

  // Find exactly one store. Its address is the inline lane address
  // `base + (i << K)` — the IV strength-reducer runs AFTER this pass, so the
  // pointer is still expressed in terms of the IV. We keep the address verbatim
  // (scalar i32) and advance the IV by LANES, so `base + (i<<K)` lands on the
  // next group's first element each SIMD step — for any element width.
  // Collect every store. One store → the original single-map paths (ramp pack / widening /
  // 4-wide). Two or more independent store8s → a multi-channel in-place fade (boids' 4-channel
  // u8 trail), handled by the multi-store WIDEN16 branch below; one pass over memory, N widening
  // stores. Stores beyond the first don't reach the single-store paths.
  const storeStmts = []
  for (let i = 0; i < body.length; i++) {
    const s = body[i]
    if (isArr(s) && STORE_OPS[s[0]]) storeStmts.push({ stmt: s, idx: i })
  }
  if (!storeStmts.length) return null
  const storeStmt = storeStmts[0].stmt, storeIdx = storeStmts[0].idx
  const storeOp = storeStmt[0]
  if (storeStmt.length !== 3) return null
  const elemLog2 = { 'i32.store8': 0, 'i32.store': 2 }[storeOp]
  if (elemLog2 === undefined) return null
  if (increments.some(x => x.name !== ivName)) return null

  // CSE'd lane offsets: a local written ONLY as `i << K` (or bare `i`) is the
  // shared offset the IV stage threads across base pointers (src[i], dst[i],
  // out[i] all reuse one `(local.tee $p (local.get i))`). Resolve them so the
  // load/store address matchers accept the `(local.get $p)` reuses.
  const offsetTees = new Map()
  const allNames = new Set()
  const gatherNames = (n) => { if (!isArr(n)) return; if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') allNames.add(n[1]); for (let i = 1; i < n.length; i++) gatherNames(n[i]) }
  for (const s of body) gatherNames(s)
  for (const name of allNames) { const k = _offsetLocalStride(body, name, ivName); if (k != null) offsetTees.set(name, k) }

  // CSE'd FULL lane address: an in-place map `a[i] = f(a[i])` shares one `(local.tee $A
  // (i32.add base i))` between the load and the store, reused as `(local.get $A)`. Without
  // resolving it the store/load address matchers reject the bare get (the empty-addrLocals
  // bug that kept every in-place trail-fade scalar). Record each such tee — its lifted
  // address (the tee) runs in the hoisted v128.load, so the store's get reads it back.
  const addrLocals = new Map()
  const recordAddrTees = (n) => {
    if (!isArr(n)) return
    if (n[0] === 'local.tee' && typeof n[1] === 'string' && isArr(n[2]) && n[2][0] === 'i32.add') {
      const m = matchLaneAddr(n[2], ivName, addrLocals, offsetTees)
      if (m && m.teeName == null) addrLocals.set(n[1], { strideLog2: m.strideLog2, base: m.base })
    }
    for (let i = 1; i < n.length; i++) recordAddrTees(n[i])
  }
  for (const s of body) recordAddrTees(s)

  const storeAddr = storeStmt[1]
  const addrM = matchLaneAddr(storeAddr, ivName, addrLocals, offsetTees)
  if (!addrM || addrM.strideLog2 !== elemLog2) return null

  // Memory loads turn this into a widening byte-map: out[i] = narrow(f(widen(a[i])…)).
  // Only the u8 shape is supported — every load must be a narrow UNSIGNED u8 load
  // of the same 4 elements the store writes (base + i; the IV strength-reducer
  // runs later). Full-width i32 maps are tryVectorize's job; mixed widths bail.
  let hasLoads = false, loadsOk = true
  const checkLoad = (n) => {
    if (!isArr(n)) return
    if (LOAD_OPS[n[0]]) {
      hasLoads = true
      if (storeOp !== 'i32.store8' || n[0] !== 'i32.load8_u') { loadsOk = false; return }
      const m = matchLaneAddr(n[1], ivName, addrLocals, offsetTees)
      if (!m || m.strideLog2 !== 0) loadsOk = false
      return  // address validated; the IV-strided subtree is not data
    }
    for (let i = 1; i < n.length; i++) checkLoad(n[i])
  }
  for (const s of body) checkLoad(s)
  if (!loadsOk) return null

  // Every other body stmt must be `(local.set $lane EXPR)` — straight-line lane
  // locals feeding the store. Classify locals for the lift.
  const writes = new Set()
  for (const s of body) collectWrites(s, writes)
  if (boundLocal && writes.has(boundLocal)) return null
  const referenced = new Set()
  const collectRefs = (n) => {
    if (!isArr(n)) return
    if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') referenced.add(n[1])
    for (let i = 1; i < n.length; i++) collectRefs(n[i])
  }
  for (const s of body) collectRefs(s)

  const localKind = new Map()
  for (const name of referenced) {
    if (name === ivName) continue
    if (writes.has(name)) {
      let firstKind = null
      for (const s of body) { const kAcc = firstAccess(s, name); if (kAcc) { firstKind = kAcc; break } }
      if (firstKind === 'read') return null   // loop-carried → reduction/stencil, not a pure map
      localKind.set(name, 'lane')
    } else {
      localKind.set(name, 'invariant')
    }
  }

  // Lift. lane type is always i32 (the ramp and all narrow stores compute in i32).
  const newLanedLocals = new Map()
  const extraLocals = []
  const freshV128 = (tag) => { const n = `$__${tag}${freshIdRef.next++}`; extraLocals.push(['local', n, 'v128']); return n }
  const ctx = { laneType: 'i32', incVar: ivName, rampVar: ivName, rampTemp: null, widenLoads: true, localKind, fnLocals: null, newLanedLocals, extraLocals, freshIdRef, fail: false, failReason: null }

  // A byte store fed by one value expression (inline, or via a single lane-local
  // temp `tw = EXPR; store(addr, tw)`) carries no loop-carried state, so we can
  // run the lane group 4× (16 samples) per iteration off four offset ramps and
  // pack the low bytes into ONE i8x16 v128.store — amortizing store + loop
  // overhead the way clang/zig's 16-wide NEON does. wideValueExpr is the
  // expression to lift per offset; null (i32 stores, multi-stmt bodies, or
  // widening loads — whose addresses would need per-offset advancing) → 4-wide.
  // The single byte-value expression feeding the store — inline, or via one lane-local
  // temp `tw = EXPR; store(addr, tw)`. Shared by both 16-wide paths below.
  const byteValueExpr = (() => {
    if (storeOp !== 'i32.store8') return null
    if (body.length === 1 && storeIdx === 0) return storeStmt[2]
    if (body.length === 2 && storeIdx === 1) {
      const set = body[0], sv = storeStmt[2]
      if (isArr(set) && set[0] === 'local.set' && set.length === 3 &&
          isLocalGet(sv, set[1]) && localKind.get(set[1]) === 'lane') return set[2]
    }
    return null
  })()
  // With u8 loads, the byte map can go 16-wide in i16x8 (the alpha-blend shape: out[i] =
  // (src[i]*A + dst[i]*B + bias) >> s) — load 16, extend_low/high, the affine arithmetic
  // in i16x8, narrow_u, store 16 — exactly clang's NEON. Sound ONLY when every
  // intermediate provably fits u16 ([0,65535], so i16x8 mod-2^16 never wraps and shr_u ==
  // the scalar shr_s on a non-negative value) and the result fits a byte ([0,255], so
  // narrow_u never saturates). `byteValueRange` returns [min,max] or null when any node
  // is unanalyzable, can go negative, or exceeds u16. An invariant local of unknown
  // magnitude (local.get) → null → falls back to the bit-exact 4-wide path.
  const byteValueRange = (e) => {
    if (!isArr(e)) return null
    const op = e[0]
    let r
    if (op === 'i32.const') { const v = constNum(e); r = [v, v] }
    else if (op === 'i32.load8_u') r = [0, 255]
    else if (op === 'i32.add') { const a = byteValueRange(e[1]), b = byteValueRange(e[2]); if (!a || !b) return null; r = [a[0] + b[0], a[1] + b[1]] }
    else if (op === 'i32.sub') { const a = byteValueRange(e[1]), b = byteValueRange(e[2]); if (!a || !b) return null; r = [a[0] - b[1], a[1] - b[0]] }
    else if (op === 'i32.mul') { const a = byteValueRange(e[1]), b = byteValueRange(e[2]); if (!a || !b) return null; const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]]; r = [Math.min(...p), Math.max(...p)] }
    else if ((op === 'i32.shr_u' || op === 'i32.shr_s') && isI32Const(e[2])) { const a = byteValueRange(e[1]); if (!a || a[0] < 0) return null; const s = constNum(e[2]); if (s < 0 || s > 16) return null; r = [a[0] >> s, a[1] >> s] }
    else if (op === 'i32.and' && isI32Const(e[2])) { const a = byteValueRange(e[1]); if (!a) return null; const m = constNum(e[2]); if (m < 0) return null; r = [0, Math.min(a[1], m)] }
    else return null
    return (r[0] < 0 || r[1] > 65535) ? null : r
  }
  // The i16x8 widening byte-map emit for ONE store, factored so a multi-channel fade reuses it
  // per channel: load each u8 input once (v128.load 16), extend_low/high to two i16x8 halves,
  // run the affine map in i16x8 on each half, narrow_u to i8x16, store 16. Each load is hoisted
  // (extend_low + extend_high share one load); loads run in source order, so an offset/address
  // `local.tee` in a load is set before the store's `local.get` reads it.
  const widen16Emit = (sAddr, valueExpr) => {
    const loadTemps = new Map()
    const loadSets = []
    const collectLoads = (e) => {
      if (!isArr(e)) return
      if (e[0] === 'i32.load8_u') {
        const k = JSON.stringify(e[1])
        if (!loadTemps.has(k)) { const t = freshV128('win'); loadTemps.set(k, t); loadSets.push(['local.set', t, ['v128.load', e[1]]]) }
      } else for (let i = 1; i < e.length; i++) collectLoads(e[i])
    }
    collectLoads(valueExpr)
    const liftW = (e, half) => {
      const op = e[0]
      if (op === 'i32.const') return ['i16x8.splat', e]
      if (op === 'i32.load8_u') return [`i16x8.extend_${half}_i8x16_u`, ['local.get', loadTemps.get(JSON.stringify(e[1]))]]
      if (op === 'i32.add') return ['i16x8.add', liftW(e[1], half), liftW(e[2], half)]
      if (op === 'i32.sub') return ['i16x8.sub', liftW(e[1], half), liftW(e[2], half)]
      if (op === 'i32.mul') return ['i16x8.mul', liftW(e[1], half), liftW(e[2], half)]
      if (op === 'i32.shr_u' || op === 'i32.shr_s') return ['i16x8.shr_u', liftW(e[1], half), e[2]]
      if (op === 'i32.and') return ['v128.and', liftW(e[1], half), ['i16x8.splat', e[2]]]
      return null   // byteValueRange already proved every op is one of the above
    }
    return [...loadSets,
      ['v128.store', sAddr, ['i8x16.narrow_i16x8_u', liftW(valueExpr, 'low'), liftW(valueExpr, 'high')]]]
  }

  let lifted, LANES
  if (storeStmts.length > 1) {
    // MULTI-CHANNEL in-place byte fade: N independent store8s in one loop (boids' 4-channel u8
    // trail). Each store must be a u8 store of a WIDEN16-eligible value (range ≤ 255); it emits
    // its own load→i16x8→narrow→store sequence, all concatenated into ONE 16-wide pass — so the
    // memory traffic stays single-pass (vs N separate vectorized loops). Every body statement
    // must be a store or the lane-local set feeding one; any other (shared/invariant) compute
    // bails to scalar, since it would be dropped.
    LANES = 16
    lifted = []
    const consumed = new Set()
    for (const { stmt, idx } of storeStmts) {
      if (stmt[0] !== 'i32.store8' || stmt.length !== 3) return null
      const a = matchLaneAddr(stmt[1], ivName, addrLocals, offsetTees)
      if (!a || a.strideLog2 !== 0) return null
      consumed.add(idx)
      let val = stmt[2]
      if (isArr(val) && val[0] === 'local.get' && typeof val[1] === 'string' && localKind.get(val[1]) === 'lane') {
        let setIdx = -1
        for (let j = 0; j < idx; j++) { const s = body[j]; if (isArr(s) && s[0] === 'local.set' && s[1] === val[1] && s.length === 3) { setIdx = j; val = s[2] } }
        if (setIdx < 0) return null
        consumed.add(setIdx)
      }
      const rng = byteValueRange(val)
      if (!rng || rng[1] > 255) return null   // not WIDEN16-eligible (overflows u16 or u8) → scalar
      lifted.push(...widen16Emit(stmt[1], val))
    }
    if (consumed.size !== body.length) return null
  } else {
    const wideValueExpr = (!hasLoads && byteValueExpr) ? byteValueExpr : null   // pure ramp → 16-wide pack
    const widenRange = (hasLoads && byteValueExpr) ? byteValueRange(byteValueExpr) : null
    const WIDEN16 = widenRange != null && widenRange[1] <= 255   // result fits a byte ⇒ narrow_u exact
    const WIDE16 = wideValueExpr != null
    LANES = (WIDE16 || WIDEN16) ? 16 : 4
    const ramp = (off) => ['i32x4.add', ['i32x4.splat', ['local.get', ivName]],
      ['v128.const', 'i32x4', String(off), String(off + 1), String(off + 2), String(off + 3)]]

    if (WIDEN16) {
      lifted = widen16Emit(storeAddr, byteValueExpr)
    } else if (WIDE16) {
      lifted = []
      const vv = []
      for (let j = 0; j < 4; j++) {
        const rt = freshV128('ramp')
        lifted.push(['local.set', rt, ramp(j * 4)])
        ctx.rampTemp = rt
        const v = liftExprV(wideValueExpr, ctx)
        if (ctx.fail) return null
        const vn = freshV128('rampv')
        lifted.push(['local.set', vn, v])
        vv.push(vn)
      }
      // Pack the low byte of all 16 i32 lanes (4 vectors) into one i8x16, in order.
      const g = (n) => ['local.get', n]
      const sh = (a, b, idx) => ['i8x16.shuffle', ...idx.map(String), a, b]
      const lo = freshV128('ramplo'), hi = freshV128('ramphi')
      lifted.push(['local.set', lo, sh(g(vv[0]), g(vv[1]), [0, 4, 8, 12, 16, 20, 24, 28, 0, 0, 0, 0, 0, 0, 0, 0])])
      lifted.push(['local.set', hi, sh(g(vv[2]), g(vv[3]), [0, 4, 8, 12, 16, 20, 24, 28, 0, 0, 0, 0, 0, 0, 0, 0])])
      lifted.push(['v128.store', storeAddr, sh(g(lo), g(hi), [0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23])])
    } else {
      ctx.rampTemp = freshV128('ramp')
      // ramp = [i, i+1, i+2, i+3], computed once per SIMD iteration.
      lifted = [['local.set', ctx.rampTemp, ramp(0)]]
      for (let i = 0; i < body.length; i++) {
        if (i === storeIdx) {
          const vval = liftExprV(storeStmt[2], ctx)
          if (ctx.fail) return null
          lifted.push(buildRampStore(storeOp, storeAddr, vval, ctx))
        } else {
          const r = liftStmt(body[i], ctx)
          if (ctx.fail) return null
          if (r != null) { if (Array.isArray(r) && r[0] === '__seq__') lifted.push(...r.slice(1)); else lifted.push(r) }
        }
      }
    }
  }
  if (!lifted || !lifted.length) return null

  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`
  const simdBrkLabel = `$__simd_brk${id}`
  const simdLoopLabel = `$__simd_loop${id}`
  const boundExpr = boundLocal ? ['local.get', boundLocal] : bound

  const scaledIncs = increments.map(({ name, c }) =>
    ['local.set', name, ['i32.add', ['local.get', name], ['i32.const', c * LANES]]])

  const simdBlock = ['block', simdBrkLabel,
    ['loop', simdLoopLabel,
      ['br_if', simdBrkLabel, ['i32.eqz', ['i32.lt_s', ['local.get', ivName], ['local.get', simdBoundName]]]],
      ...lifted,
      ...scaledIncs,
      ['br', simdLoopLabel]]]
  // span-aligned (same entry≠0 hazard as tryVectorize's bound — see there)
  const boundSetup = ['local.set', simdBoundName,
    ['i32.add', ['local.get', ivName],
      ['i32.and', ['i32.sub', boundExpr, ['local.get', ivName]], ['i32.const', -LANES]]]]
  const wrapper = ['block', boundSetup, simdBlock, blockNode]
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']),
    ...extraLocals,
  ]
  return { wrapper, newLocalDecls }
}

// Build the store for a ramp-map iteration: i32x4 `vval` → element width of
// `storeOp` at scalar address `addr`. i32.store is the full vector; i32.store8
// truncates (low byte of each lane) via i8x16.shuffle — exactly matching scalar
// store8, with no value-range assumption (shuffle selects, never saturates).
// Narrowing-map store: pack a wider float lane vector `val` down to a narrower
// store element and write the low bytes (extract_lane 0 + scalar store, like
// buildRampStore). f64→f32 demotes (bit-exact vs scalar); f64→i32 truncates;
// f32→i16/i8 truncate to i32x4 then WRAP via i8x16.shuffle (low bytes = scalar
// store{8,16}, never saturates). Returns the store stmt or null (unsupported).
// Peel the scalar narrowing conversion off a store value, returning the inner float
// expr to lift (narrowStore then applies the SIMD narrow). f32 store: f32.demote_f64(X).
// int store: the ToInt32 idiom `i32.wrap_i64(X<0 ? trunc_sat_f64_s X : trunc_sat_f64_u X)`
// (or a bare trunc_sat). The inner X is the f64/f32 lane value computed before the cast.
function peelNarrowConv(val, sty) {
  if (!isArr(val)) return null
  if (sty === 'f32') return val[0] === 'f32.demote_f64' ? val[1] : null
  // int element (i8/i16/i32): peel ToInt32 (`x | 0`). jz's general lowering is an
  // Infinity-guarded saturating trunc:
  //   (select (i32.wrap_i64 (i64.trunc_sat_f64_s X)) (i32.const 0) (f64.ne X' Inf))
  // where X is `(local.tee $inf <f64 expr>)` and X' the matching get. Peel to the inner f64.
  // (The SIMD narrow i32x4.trunc_sat_f64x2_s_zero saturates +Inf / |x|≥2³¹ to INT_MAX where
  // ToInt32 wraps mod 2³² — caller gates the int narrowing on relaxedSimd for that edge.)
  if (val[0] === 'select' && val.length === 4 && isI32Const(val[2]) && val[2][1] === 0 &&
      isArr(val[1]) && val[1][0] === 'i32.wrap_i64' && isArr(val[1][1]) && val[1][1][0] === 'i64.trunc_sat_f64_s') {
    let inner = val[1][1][1]   // the f64 operand of the trunc, captured in a `(local.tee $inf …)`
    if (isArr(inner) && inner[0] === 'local.tee' && inner.length === 3) inner = inner[2]   // peel to the tee's VALUE
    return inner
  }
  if (val[0] === 'i32.wrap_i64' && isArr(val[1]) && val[1][0] === 'if') {
    const iff = val[1], thenA = iff[3], elseA = iff[4]
    const s = isArr(thenA) && isArr(thenA[1]) && thenA[1][0] === 'i64.trunc_sat_f64_s' ? thenA[1][1] : null
    const u = isArr(elseA) && isArr(elseA[1]) && elseA[1][0] === 'i64.trunc_sat_f64_u' ? elseA[1][1] : null
    if (s && u && exprEq(s, u)) return s
  }
  if (val[0] === 'i32.trunc_sat_f64_s' || val[0] === 'i32.trunc_sat_f64_u') return val[1]
  return null
}

// i8x16.shuffle masks that pack a 4×i32 vector down to the low bytes of each lane
// (truncating-wrap = scalar store{8,16}), tail zero-filled: _I16 keeps the low 2
// bytes of each lane (→ 8 bytes / i64.store), _I8 the low byte (→ 4 bytes / i32.store).
const PACK_I32_TO_I16 = [0, 1, 4, 5, 8, 9, 12, 13, 0, 0, 0, 0, 0, 0, 0, 0]
const PACK_I32_TO_I8 = [0, 4, 8, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

function narrowStore(addr, val, laneType, sty, ctx) {
  const tmp = `$__nv${ctx.freshIdRef.next++}`
  ctx.extraLocals.push(['local', tmp, 'v128'])
  const g = ['local.get', tmp]
  const sh = (idx) => ['i8x16.shuffle', ...idx.map(String), g, g]
  let pre, lane8, store
  if (laneType === 'f64' && sty === 'f32') { pre = ['f32x4.demote_f64x2_zero', val]; lane8 = g; store = 'i64.store' }
  else if (laneType === 'f64' && sty === 'i32') { pre = ['i32x4.trunc_sat_f64x2_s_zero', val]; lane8 = g; store = 'i64.store' }
  else if (laneType === 'f32' && sty === 'i16') { pre = ['i32x4.trunc_sat_f32x4_s', val]; lane8 = sh(PACK_I32_TO_I16); store = 'i64.store' }
  else if (laneType === 'f32' && sty === 'i8')  { pre = ['i32x4.trunc_sat_f32x4_s', val]; lane8 = sh(PACK_I32_TO_I8); store = 'i32.store' }
  else return null
  // 8-byte stores extract an i64 lane; the 4-byte i8 pack extracts an i32 lane.
  const packed = store === 'i64.store' ? ['i64x2.extract_lane', 0, lane8] : ['i32x4.extract_lane', 0, lane8]
  return ['block', ['local.set', tmp, pre], [store, addr, packed]]
}

function buildRampStore(storeOp, addr, vval, ctx) {
  if (storeOp === 'i32.store') return ['v128.store', addr, vval]   // 4 i32 lanes → 16 bytes
  // i32.store8: hoist vval to a temp so the shuffle reads it once; low byte of
  // each of 4 lanes → bytes 0..3 → one i32.store (4 bytes). Shuffle lane indices
  // are string tokens for watr's binary encoder.
  const tmp = `$__rampv${ctx.freshIdRef.next++}`
  ctx.extraLocals.push(['local', tmp, 'v128'])
  const g = ['local.get', tmp]
  const packed = ['i8x16.shuffle', ...[0, 4, 8, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].map(String), g, g]
  return ['block', ['local.set', tmp, vval], ['i32.store', addr, ['i32x4.extract_lane', 0, packed]]]
}

// Pivot-stride analysis for the multi-pixel lift. The lift reads 16 source bytes
// (4 RGBA pixels) with ONE v128.load at the address for output pixel `pivot`, so the
// 4 outputs are correct ONLY if consecutive output pixels read consecutive source
// pixels — the load address must advance by EXACTLY 4 bytes per pivot step. Build, in
// program order, each local's value-delta per unit-pivot increment (`pivot` → 1, every
// other local → its assigned expr's delta, unknown/outer locals → 0 = pivot-invariant).
// `delta(e)` returns that constant byte-delta, or null when the dependence is non-
// constant (e.g. x*k) or uses an op we don't model — both of which must bail.
// Index arithmetic is often f64-lowered (JS number `*`): `(yi*ww + x)` becomes
// `(f64(yi)*ww + f64(x)) |0` = trunc_sat with a NaN-guard `select`. We model those
// passthrough/arith ops too, so a runtime-dimension vblur (x carried through f64)
// analyses the same as a literal-dimension one (x in plain i32). The select is the
// `|0` coercion (value branch when the index is finite — always so for an integer
// array index); we take the value branch's delta. Multiplies need a compile-time
// constant factor on the pivot-bearing side (else the stride isn't constant).
function buildPivotCoeff(loopNode, pivot) {
  const coeff = new Map([[pivot, 1]])
  const cval = (n) => isI32Const(n) ? constNum(n) : (isArr(n) && n[0] === 'f64.const' && n[1] != null ? Number(n[1]) : null)
  const delta = (e) => {
    if (isI32Const(e)) return 0
    if (isLocalGet(e)) return coeff.has(e[1]) ? coeff.get(e[1]) : 0
    if (!isArr(e)) return null
    const [op, a, b] = e
    switch (op) {
      case 'i32.add': case 'f64.add': { const x = delta(a), y = delta(b); return x == null || y == null ? null : x + y }
      case 'i32.sub': case 'f64.sub': { const x = delta(a), y = delta(b); return x == null || y == null ? null : x - y }
      case 'i32.shl': { const c = cval(b), x = delta(a); return c == null || x == null ? null : x << c }
      case 'i32.mul': case 'f64.mul': {
        const ca = cval(a), cb = cval(b), x = delta(a), y = delta(b)
        if (x == null || y == null) return null
        if (ca != null) return ca * y          // const × expr
        if (cb != null) return cb * x          // expr × const
        return x === 0 && y === 0 ? 0 : null    // var × var: pivot-dependent ⇒ non-constant
      }
      // value-preserving conversions: passthrough. `local.tee $v EXPR` yields EXPR.
      case 'f64.convert_i32_s': case 'f64.convert_i32_u': case 'i64.trunc_sat_f64_s':
      case 'i64.trunc_sat_f64_u': case 'i32.wrap_i64': case 'i64.extend_i32_s':
        return delta(a)
      case 'local.tee': return delta(b)
      // the `(expr)|0` NaN/Inf-guard `select(value, 0, finite?)`: take the value branch
      // (the index is a finite integer in any real blur). Only when the else-branch is
      // the const-0 guard — a general ternary index whose arms differ in stride bails.
      case 'select': return isI32Const(e[2]) && constNum(e[2]) === 0 ? delta(a) : null
      default: return null                     // any other op (and/or/div/…) ⇒ unanalyzable
    }
  }
  const visit = (n) => {
    if (!isArr(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') { coeff.set(n[1], delta(n[2])); visit(n[2]); return }
    n.forEach(visit)
  }
  visit(loopNode)
  return delta
}

// Vectorize the inner accumulation of an RGBA box-filter pixel loop. See the
// matchChannelGroup header. Returns { wrapper, newLocalDecls } or null.
// Multi-pixel SIMD lift of a clamp-free RGBA box-filter interior (produced by the
// clamp-peel pass). Processes 4 output pixels per iteration: at tap k the 4 outputs
// read 4 CONSECUTIVE source pixels — one 16-byte v128.load whose lanes map DIRECTLY
// to the 4 accumulators (no shuffle). Sums (≤ win·255 < 2^16) accumulate in two
// i16x8 vectors; the divide+store reuses the scalar store templates per pixel.
// Validated bit-exact + 4.34× vs scalar. Bails (→ tryChannelReduce 1-pixel lift)
// unless the body is exactly: clamp-free `xi=x+k; p=(row+xi)<<2; acc_c += u8[base+c]`
// over a unit-stride x, then a 4-byte RGBA store `dst[ab1+c] = f(acc_c)`. r≥127 →
// i16 overflow → bail. Leaves a scalar remainder loop for the ≤3 trailing pixels.
function tryBlurMultiPixel(blockNode, fnLocals, freshIdRef) {
  // Loose envelope (block/loop/label/br-end only) — the exit guard below accepts NO label
  // check and lt_s only (not lt_u), a strictly narrower shape than matchExitBrIf, so it stays
  // this recognizer's own residual rather than folding into the shared scaffold.
  const bl = matchBlockLoop(blockNode, { envelope: 'loose' })
  if (!bl) return null
  const { loopNode, endIdx } = bl
  // exit guard: br_if $brk (i32.eqz (i32.lt_s x BOUND))
  const exit = loopNode[2]
  if (!(isArr(exit) && exit[0] === 'br_if' && isArr(exit[2]) && exit[2][0] === 'i32.eqz'
    && isArr(exit[2][1]) && exit[2][1][0] === 'i32.lt_s' && isLocalGet(exit[2][1][1]))) return null
  const pivot = exit[2][1][1][1]          // pixel IV $x
  const bound = exit[2][1][2]              // interior bound (expr)
  const bodyEnd = endIdx - 1
  // increment must be `x = x + 1`
  const inc = loopNode[bodyEnd]
  if (!(isArr(inc) && inc[0] === 'local.set' && inc[1] === pivot && isArr(inc[2]) && inc[2][0] === 'i32.add'
    && isLocalGet(inc[2][1], pivot) && isI32Const(inc[2][2]) && constNum(inc[2][2]) === 1)) return null

  // four `acc_c = 0` inits
  let initIdx = -1, accInits = null
  for (let i = 3; i + 3 <= bodyEnd; i++) {
    const z = []
    for (let c = 0; c < 4; c++) { const s = loopNode[i + c]; if (isArr(s) && s[0] === 'local.set' && s.length === 3 && isI32Const(s[2]) && constNum(s[2]) === 0) z.push(s[1]); else break }
    if (z.length === 4 && new Set(z).size === 4) { initIdx = i; accInits = z; break }
  }
  if (initIdx < 0) return null
  // the tap accumulation loop
  let innerIdx = -1, innerBlock = null
  for (let i = initIdx + 4; i <= bodyEnd; i++) {
    const s = loopNode[i]
    if (isArr(s) && s[0] === 'block' && s.slice(1).some(c => isArr(c) && c[0] === 'loop')) { innerIdx = i; innerBlock = s; break }
    if (isArr(s) && s[0] === 'loop') { innerIdx = i; innerBlock = ['block', s]; break }
  }
  if (!innerBlock) return null
  const innerLoop = innerBlock.find(c => isArr(c) && c[0] === 'loop')
  if (!innerLoop) return null
  const ilEnd = innerLoop.length - 1
  if (!(isArr(innerLoop[ilEnd]) && innerLoop[ilEnd][0] === 'br')) return null
  const innerBody = innerLoop.slice(3, ilEnd - 1)
  const grp = matchChannelGroup(innerBody)
  if (!grp) return null
  if (grp.accs.slice().sort().join('\x00') !== accInits.slice().sort().join('\x00')) return null
  // CLAMP-FREE: nothing before the channel group may be an `if` (the edge clamp).
  for (let i = 0; i < grp.idx; i++) if (isArr(innerBody[i]) && innerBody[i][0] === 'if') return null
  // The tap loop must be the i32 form `k <= r`; extract the radius r (reused in the
  // runtime overflow guard below). f64-typed tap loops (f64 dims) bail to scalar.
  const ic = innerLoop[2]
  if (!(isArr(ic) && ic[0] === 'br_if' && isArr(ic[2]) && ic[2][0] === 'i32.eqz'
    && isArr(ic[2][1]) && ic[2][1][0] === 'i32.le_s' && isLocalGet(ic[2][1][1]))) return null
  const rBound = ic[2][1][2]
  if (!(isLocalGet(rBound) || isI32Const(rBound))) return null

  // the RGBA store: 4 i32.store8 at `ab1 + c`, ab1 tee'd in the first. jz's raw pre-watr
  // emission of `dst[o]=(sr/win)|0` materializes the divide into its own single-use temp
  // (`tw = sr/win; store(tw)`) — pre-watr propagateSingleUse runs AFTER the vectorizer
  // (ordered there so it doesn't scramble the dot-pair matcher), so this indirection is
  // never folded before this recognizer sees it, unlike the old post-watr pipeline where
  // watr's own copy-prop had already inlined it into the store operand. Resolve that one-hop
  // indirection here: if a store's value is a bare local.get and the statement immediately
  // before it is that local's SOLE def in the loop, substitute the def's RHS.
  const resolvedTemps = new Set()
  const resolveStoreVal = (idx, val) => {
    if (!(isArr(val) && val[0] === 'local.get')) return val
    const t = val[1], prev = loopNode[idx - 1]
    if (!(isArr(prev) && prev[0] === 'local.set' && prev.length === 3 && prev[1] === t)) return val
    let uses = 0
    const count = (n) => { if (!isArr(n)) return; if (n[0] === 'local.get' && n[1] === t) uses++; n.forEach(count) }
    count(loopNode)
    if (uses !== 1) return val
    resolvedTemps.add(t)
    return prev[2]
  }
  let storeIdx = -1
  for (let i = innerIdx + 1; i + 3 <= bodyEnd; i++) {
    const s0 = loopNode[i]
    if (isArr(s0) && s0[0] === 'i32.store8' && s0.length === 3 && isArr(s0[1]) && s0[1][0] === 'local.tee') { storeIdx = i; break }
  }
  if (storeIdx < 0) return null
  const s0 = loopNode[storeIdx]
  const ab1 = s0[1][1], dstExpr = s0[1][2]      // ab1 local, its address expr
  const storeVals = [resolveStoreVal(storeIdx, s0[2])]
  let scanIdx = storeIdx + 1
  for (let c = 1; c < 4; c++) {
    if (isArr(loopNode[scanIdx]) && loopNode[scanIdx][0] === 'local.set') scanIdx++   // skip the next store's div-into-temp
    const s = loopNode[scanIdx]
    if (!(isArr(s) && s[0] === 'i32.store8' && s[1] === `offset=${c}` && isLocalGet(s[2], ab1))) return null
    storeVals.push(resolveStoreVal(scanIdx, s[3]))
    scanIdx++
  }
  // each store value must read its accumulator (the divided sum)
  for (let c = 0; c < 4; c++) if (!readsVar(storeVals[c], accInits[c])) return null

  // ── Soundness guards for the 4-pixels-per-load lift ──────────────────────────
  // Scope the stride analysis to THIS pixel loop. A peeled interior is one segment ⇒
  // one inner tap loop, so there is no sibling same-named-`p` ambiguity, and the scope
  // still captures the LICM preamble where the x-dependent index term is hoisted out of
  // the tap loop (e.g. `__li = f64(x)` — x is invariant w.r.t. the tap IV k).
  const pivotDelta = buildPivotCoeff(loopNode, pivot)
  // (a) Source unit-stride: the v128.load address (array base + byte index) must
  // advance by exactly 4 bytes (one RGBA pixel) per output-pixel step, else the
  // 16-byte load spans the wrong source pixels. Bails on strided indices
  // ((xi*2+row)<<2) and non-constant ones ((yi*W + x + k*x)<<2 → x*(1+k)).
  if (pivotDelta(grp.teeExpr) !== 4) return null
  // (b) No dropped pivot-dependent setup: statements before the inits (loopNode[3..
  // initIdx)) are NOT carried into the 4-pixel loop, so a per-pixel value computed
  // there (e.g. `x2 = x*2`) would go stale. Bail if any such statement is pivot-
  // dependent. (Statements between the inits and the inner loop ARE carried.)
  for (let i = 3; i < initIdx; i++) {
    let bad = false
    const chk = (n) => { if (!isArr(n)) return; if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string' && pivotDelta(n[2]) !== 0) bad = true; n.forEach(chk) }
    chk(loopNode[i])
    if (bad) return null
  }
  // (c) Store values must read only the accumulators (set per-pixel by the epilogue)
  // and pivot-invariants — never a per-pixel local like the pivot itself, since the
  // store template is reused verbatim for all 4 pixels (`dst[o]=(sr+x)&255` would use
  // the group-base x for pixels 1-3).
  const perPixel = new Set()
  const collectSet = (n) => { if (!isArr(n)) return; if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') perPixel.add(n[1]); n.forEach(collectSet) }
  collectSet(loopNode)
  for (const a of grp.accs) perPixel.delete(a)   // accumulators are repopulated per pixel
  const readsPerPixel = (n) => isArr(n) ? ((n[0] === 'local.get' && perPixel.has(n[1])) || n.some(readsPerPixel)) : false
  for (let c = 0; c < 4; c++) if (readsPerPixel(storeVals[c])) return null

  // ── Lift ───────────────────────────────────────────────────────────────────
  const id = freshIdRef.next++
  const accLo = `$__bmplo${id}`, accHi = `$__bmphi${id}`, b4 = `$__bmpb${id}`
  const newLocalDecls = [['local', accLo, 'v128'], ['local', accHi, 'v128'], ['local', b4, 'i32']]
  const Z = ['v128.const', 'i64x2', '0', '0']
  // inner body: 4 channel adds → 2 i16 widening adds off the same tee'd base.
  const newInner = []
  for (let i = 0; i < innerBody.length; i++) {
    if (i === grp.idx) {
      newInner.push(['local.set', accLo, ['i16x8.add', ['local.get', accLo], ['i16x8.extend_low_i8x16_u', ['v128.load', ['local.tee', grp.baseLocal, grp.teeExpr]]]]])
      newInner.push(['local.set', accHi, ['i16x8.add', ['local.get', accHi], ['i16x8.extend_high_i8x16_u', ['v128.load', ['local.get', grp.baseLocal]]]]])
    } else if (i > grp.idx && i <= grp.idx + 3) continue
    else newInner.push(innerBody[i])
  }
  const newInnerLoop = [...innerLoop.slice(0, 3), ...newInner, ...innerLoop.slice(ilEnd - 1)]
  const newInnerBlock = innerBlock.map(c => c === innerLoop ? newInnerLoop : c)
  // store epilogue: the o=(row+x)<<2 setup, then ab1, then per pixel j set acc_c to
  // its lane and reuse the scalar store template at byte offset j*4+c.
  // `o = (row+x)<<2` etc. — drop resolved-away div-into-temp defs (unused now; storeVals
  // carries their RHS directly), else a dead `tw15 = sr/win` reading a stale `sr` gets
  // carried into the 4-pixel loop (harmless — unused — but unnecessary bytes/work).
  const preStore = loopNode.slice(innerIdx + 1, storeIdx).filter(s => !(isArr(s) && s[0] === 'local.set' && resolvedTemps.has(s[1])))
  const epilogue = [...preStore, ['local.set', ab1, dstExpr]]
  for (let j = 0; j < 4; j++) {
    const vec = j < 2 ? accLo : accHi, base = (j % 2) * 4
    // lane base+c summed source byte at offset c → grp.accs[c] (the accumulator
    // tied to read-offset c), NOT accInits[c] (zero-init order); see tryChannelReduce.
    for (let c = 0; c < 4; c++) epilogue.push(['local.set', grp.accs[c], ['i16x8.extract_lane_u', String(base + c), ['local.get', vec]]])
    for (let c = 0; c < 4; c++) epilogue.push(['i32.store8', `offset=${j * 4 + c}`, ['local.get', ab1], storeVals[c]])
  }
  // 4-pixel loop body: splat inits, the tap-IV init, the lifted inner loop, the
  // lifted store, x += 4.
  const v4label = `$__bmpx${id}`, v4brk = `$__bmpe${id}`
  const fourBody = [
    ['br_if', v4brk, ['i32.eqz', ['i32.lt_s', ['local.get', pivot], ['local.get', b4]]]],
    ['local.set', accLo, Z], ['local.set', accHi, Z],
    ...loopNode.slice(initIdx + 4, innerIdx),
    newInnerBlock,
    ...epilogue,
    ['local.set', pivot, ['i32.add', ['local.get', pivot], ['i32.const', 4]]],
    ['br', v4label],
  ]
  // Deep-clone the 4-pixel loop: it reuses sub-trees (inner body, store templates,
  // dst expr) that also live in the scalar remainder below — sharing would let a
  // later pass mutating one corrupt the other.
  const dc = (n) => isArr(n) ? n.map(dc) : n
  const fourLoop = dc(['block', v4brk, ['loop', v4label, ...fourBody]])
  // b4 = x + (r<128 ? ((bound-x) & ~3) : 0): the 4-aligned end of the interior from
  // the entry x. The r<128 guard is the i16-overflow check (win·255 < 2^16 ⇔ r<128);
  // when r≥128 the 4-pixel loop runs zero iterations and the scalar remainder covers
  // the whole interior — sound for any runtime r, no duplicated loop body.
  const b4set = ['local.set', b4, ['i32.add', ['local.get', pivot],
    ['select', ['i32.and', ['i32.sub', dc(bound), ['local.get', pivot]], ['i32.const', -4]], ['i32.const', 0],
      ['i32.lt_s', dc(rBound), ['i32.const', 128]]]]]
  // The interior block may carry a LICM-hoisted invariant preamble (e.g. `k=-r`'s
  // value) that the lifted body reads but which the original sets only on block
  // entry — run a clone of it first so the 4-pixel loop sees it. Then b4 setup, the
  // 4-pixel loop, then the ORIGINAL block unchanged (the ≤3-pixel scalar remainder;
  // x continues from b4).
  const loopPos = blockNode.indexOf(loopNode)
  const preamble = blockNode.slice(2, loopPos).map(dc)
  const wrapper = ['block', ...preamble, b4set, fourLoop, blockNode]
  return { wrapper, newLocalDecls }
}

function tryChannelReduce(blockNode, fnLocals, freshIdRef) {
  // Loose envelope: LICM may hoist an invariant edge-clamp bound ahead of the loop when
  // this pixel loop nests in an outer row loop; preserved verbatim by the wrapper rebuild.
  // Unlike tryBlurMultiPixel this never validates the exit/inc shape — it trusts
  // `bodyStart..bodyEnd` as the body outright.
  const bl = matchBlockLoop(blockNode, { envelope: 'loose' })
  if (!bl) return null
  const { loopNode, endIdx } = bl

  // Pixel-loop body (between the exit guard and the back-branch). Find: four
  // `acc_c = 0` inits and the inner accumulation loop that sums into them.
  const bodyStart = 3, bodyEnd = endIdx - 1   // [exit] at 2, [inc?][br] at the end
  // The four zero-inits must be consecutive `(local.set $acc (i32.const 0))`.
  let initIdx = -1, accInits = null
  for (let i = bodyStart; i + 3 <= bodyEnd; i++) {
    const z = []
    for (let c = 0; c < 4; c++) {
      const s = loopNode[i + c]
      if (isArr(s) && s[0] === 'local.set' && s.length === 3 && isI32Const(s[2]) && constNum(s[2]) === 0 && typeof s[1] === 'string') z.push(s[1])
      else break
    }
    if (z.length === 4 && new Set(z).size === 4) { initIdx = i; accInits = z; break }
  }
  if (initIdx < 0) return null

  // The inner accumulation loop is the (block (loop)) appearing after the inits.
  let innerIdx = -1, innerBlock = null
  for (let i = initIdx + 4; i <= bodyEnd; i++) {
    const s = loopNode[i]
    if (isArr(s) && s[0] === 'block' && s.slice(1).some(c => isArr(c) && c[0] === 'loop')) { innerIdx = i; innerBlock = s; break }
    if (isArr(s) && s[0] === 'loop') { innerIdx = i; innerBlock = ['block', s]; break }
  }
  if (!innerBlock) return null
  // Locate the loop within the inner block and its body.
  const innerLoop = innerBlock.find(c => isArr(c) && c[0] === 'loop')
  if (!innerLoop) return null
  const ilEnd = innerLoop.length - 1
  if (!(isArr(innerLoop[ilEnd]) && innerLoop[ilEnd][0] === 'br')) return null
  const innerBody = innerLoop.slice(3, ilEnd - 1)   // between exit guard and the (k+=1)(br)

  const grp = matchChannelGroup(innerBody)
  if (!grp) return null
  // The four accumulators summed must be exactly the four that were zero-inited
  // (same set, in any order).
  if (grp.accs.slice().sort().join('\x00') !== accInits.slice().sort().join('\x00')) return null

  // ── Lift. accv (v128) holds the four channel sums.
  const id = freshIdRef.next++
  const accv = `$__chv${id}`
  const newLocalDecls = [['local', accv, 'v128']]
  // Zero-init → one splat.
  const zeroInit = ['local.set', accv, ['v128.const', 'i32x4', '0', '0', '0', '0']]
  // Inner accumulation: keep the address-producing stmts, replace the 4 channel
  // adds with one widening add off the shared base. The base address is the
  // tee'd expr of the first load (re-tee'd so any later `local.get base` still
  // resolves — though the other channel loads are gone).
  const widen = ['i32x4.extend_low_i16x8_u', ['i16x8.extend_low_i8x16_u',
    ['v128.load32_zero', ['local.tee', grp.baseLocal, grp.teeExpr]]]]
  const newInner = []
  for (let i = 0; i < innerBody.length; i++) {
    if (i === grp.idx) newInner.push(['local.set', accv, ['i32x4.add', ['local.get', accv], widen]])
    else if (i > grp.idx && i <= grp.idx + 3) continue   // drop the other 3 channel adds
    else newInner.push(innerBody[i])
  }
  // Rebuild the inner loop with the lifted body.
  const newInnerLoop = [...innerLoop.slice(0, 3), ...newInner, ...innerLoop.slice(ilEnd - 1)]
  const newInnerBlock = innerBlock.map(c => c === innerLoop ? newInnerLoop : c)
  // After the inner loop, extract the four lane sums back to the scalar
  // accumulators the divide+store code reads. Lane c summed source byte
  // `base+c`, so it must land in grp.accs[c] — the accumulator matchChannelGroup
  // tied to read-offset c — NOT accInits[c] (zero-init order). They coincide only
  // when the program inits/sums in offset order (every real blur); a channel-
  // permuted program (sums offset 0 into a var stored at a later offset) needs the
  // offset-order mapping or the lanes mis-map.
  const extracts = grp.accs.map((acc, c) => ['local.set', acc, ['i32x4.extract_lane', c, ['local.get', accv]]])

  // Reassemble the pixel-loop body: replace the 4 inits with the splat, the inner
  // block with the lifted one, and insert the extracts right after it.
  const newLoop = [...loopNode]
  newLoop.splice(innerIdx, 1, newInnerBlock, ...extracts)   // inner block → lifted + extracts
  newLoop.splice(initIdx, 4, zeroInit)                       // 4 inits → 1 splat (do last; lower index)
  const wrapper = blockNode.map(c => c === loopNode ? newLoop : c)
  return { wrapper, newLocalDecls }
}

/**
 * Divergent escape-time vectorizer — 2-wide f64x2, bit-exact with scalar f64.
 *
 * Recognizes the fractal escape-time nest (mandelbrot / julia / burning-ship / …):
 *
 *   for (qx = 0; qx < W; qx++) {              // outer pixel loop; ≥1 i32 pixel IVs
 *     cx = <expr in qx>                       // per-pixel coordinate(s)
 *     x = 0; y = 0; it = 0                     // loop-carried f64 + i32 counter
 *     while (it < MAXIT) {                     // inner escape loop (it-limited)
 *       <f64 updates to x,y (+ temps); one `if (|z|² > T) break`, ANY position>
 *       it++
 *     }
 *     <epilogue: store(it)  OR  smooth-colour(x,y,it) → store>
 *   }
 *
 * Two adjacent pixels run in f64x2 lockstep with a per-lane active mask. A lane is
 * frozen (v128.bitselect) the instant it would escape or reach MAXIT, so its
 * it/x/y stay bit-identical to the scalar loop — f64x2 add/sub/mul/abs are IEEE-
 * identical to scalar f64 (no FMA fusion). The body is emitted statement-by-
 * statement in source order, so the escape mask lands exactly where the scalar
 * `break` is (before OR after the z-update), and the per-lane state freezes at the
 * matching point. iter is kept as f64x2 (an i32 `it` is exact in f64), so the
 * limit compare and the (possibly fractional) colour math both stay bitwise-exact.
 *
 * Loop-carried vars (first body access is a READ) freeze via bitselect; within-
 * iteration temps (first access a WRITE — inlined squares, `xt`) recompute raw.
 * The colour epilogue runs scalar, twice — once per lane — reading each lane's
 * extracted x/y/it, with the pixel IVs advanced by +0/+1. Odd widths and extra
 * lanes fall through to the original scalar pixel loop (the exact tail).
 */
const CMP_NEG = {  // comparison → its logical negation (active lanes are finite → NaN-free)
  'f64.gt': 'f64.le', 'f64.ge': 'f64.lt', 'f64.lt': 'f64.ge', 'f64.le': 'f64.gt', 'f64.eq': 'f64.ne', 'f64.ne': 'f64.eq',
  'i32.lt_s': 'i32.ge_s', 'i32.ge_s': 'i32.lt_s', 'i32.gt_s': 'i32.le_s', 'i32.le_s': 'i32.gt_s',
  'i32.lt_u': 'i32.ge_u', 'i32.ge_u': 'i32.lt_u', 'i32.gt_u': 'i32.le_u', 'i32.le_u': 'i32.gt_u',
}
const CMP_LANE = {  // f64/i32 scalar compare → f64x2 lane compare (iter is f64x2; z-compares are f64)
  'f64.gt': 'f64x2.gt', 'f64.ge': 'f64x2.ge', 'f64.lt': 'f64x2.lt', 'f64.le': 'f64x2.le', 'f64.eq': 'f64x2.eq', 'f64.ne': 'f64x2.ne',
  'i32.lt_s': 'f64x2.lt', 'i32.le_s': 'f64x2.le', 'i32.ge_s': 'f64x2.ge', 'i32.gt_s': 'f64x2.gt',
  'i32.lt_u': 'f64x2.lt', 'i32.le_u': 'f64x2.le', 'i32.ge_u': 'f64x2.ge', 'i32.gt_u': 'f64x2.gt',
}
const readsVar = (n, v) => isArr(n) && ((n[0] === 'local.get' && n[1] === v) || n.some(c => readsVar(c, v)))
const writesName = (n, name) => isArr(n) && (((n[0] === 'local.set' || n[0] === 'local.tee' || n[0] === 'global.set') && n[1] === name) || n.some(c => writesName(c, name)))
// Pixel induction variables may be i32 (const-bound loops) or f64 (param-bound loops,
// e.g. `for (x=0; x<width; ++x)` with f64 `width`). Match `v += 1` and `v < bound` for both.
const matchPixelInc = (stmt) => {
  if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
  const x = stmt[1], v = stmt[2]
  if (!isArr(v) || v.length !== 3 || !isLocalGet(v[1], x)) return null
  if (v[0] === 'i32.add' && constNum(v[2]) === 1) return { name: x, type: 'i32' }
  if (v[0] === 'f64.add' && isArr(v[2]) && v[2][0] === 'f64.const' && Number(v[2][1]) === 1) return { name: x, type: 'f64' }
  return null
}
const matchPixelExit = (stmt, label) => {
  if (!isArr(stmt) || stmt[0] !== 'br_if' || stmt[1] !== label) return null
  const cond = stmt[2]
  if (!isArr(cond) || cond[0] !== 'i32.eqz') return null
  const cmp = cond[1]
  if (!isArr(cmp) || !isLocalGet(cmp[1])) return null
  if (cmp[0] === 'i32.lt_s' || cmp[0] === 'i32.lt_u') return { ind: cmp[1][1], bound: cmp[2], cmpOp: cmp[0], type: 'i32' }
  if (cmp[0] === 'f64.lt') return { ind: cmp[1][1], bound: cmp[2], cmpOp: cmp[0], type: 'f64' }
  return null
}

/**
 * Match the OUTER per-pixel loop scaffold shared by tryDivergentEscapeVectorize
 * (inner escape loop) and tryPerPixelColor (straight-line body):
 *   (block $o [preamble: pure local.set…]
 *     (loop $l (br_if $o (i32.eqz (IV < WIDTH))) OBODY… (pxIV += 1)… (br $l)))
 * One-or-more trailing `v += 1` are pixel induction vars (the bound IV plus any
 * parallel counters like `j`); the exit bounds one of them by an invariant width.
 *
 * Returns the shared FACTS, or null:
 *   { oLabel, loopNode, preamble, pixelIVs, pivStart, pxVar, widthBound, pivType,
 *     obody }  — obody = loopNode.slice(3, pivStart), the per-pixel work between
 *   the exit guard and the IV bumps. Both consumers branch on `obody` afterward.
 * The bound is re-evaluated for the SIMD guard, so it must be invariant + pure:
 *   a constant, or a local/global the loop nest never writes (`writesName`).
 */
function matchOuterPixelLoop(blockNode) {
  const bl = matchBlockLoop(blockNode, { envelope: 'pixelIV' })
  if (!bl) return null
  const { blockLabel: oLabel, loopNode, preamble, endIdx: oEnd } = bl
  const pixelIVs = []   // [{ name, type }]
  let pivStart = oEnd
  for (let i = oEnd - 1; i >= 3; i--) {
    const m = matchPixelInc(loopNode[i])
    if (!m) break
    pixelIVs.unshift(m); pivStart = i
  }
  if (!pixelIVs.length) return null
  const oExit = matchPixelExit(loopNode[2], oLabel)
  const pxIV = oExit && pixelIVs.find(p => p.name === oExit.ind && p.type === oExit.type)
  if (!pxIV) return null
  const widthBound = oExit.bound
  const pivType = new Map(pixelIVs.map(p => [p.name, p.type]))
  if (isI32Const(widthBound)) { /* ok */ }
  else if (isArr(widthBound) && (widthBound[0] === 'local.get' || widthBound[0] === 'global.get')) {
    if (writesName(loopNode, widthBound[1])) return null
  } else return null
  const obody = loopNode.slice(3, pivStart)     // between exit guard and the pixel-IV bumps
  return { oLabel, loopNode, preamble, pixelIVs, pivStart, pxVar: oExit.ind, widthBound, pivType, obody, oExit }
}

function tryDivergentEscapeVectorize(blockNode, fnLocals, freshIdRef) {
  // Outer per-pixel scaffold (+ LICM preamble feeding both SIMD path and tail).
  const outer = matchOuterPixelLoop(blockNode)
  if (!outer) return null
  const { oLabel, loopNode, preamble, pixelIVs, pxVar, widthBound, pivType, obody, oExit } = outer

  let innerIdx = -1, innerBlock = null
  for (let i = 0; i < obody.length; i++) {
    const s = obody[i]
    if (isArr(s) && s[0] === 'block' && s.slice(1).some(c => isArr(c) && c[0] === 'loop')) {
      if (innerBlock) return null
      innerBlock = s; innerIdx = i
    }
  }
  if (!innerBlock) return null
  const iLabel = (typeof innerBlock[1] === 'string' && innerBlock[1].startsWith('$')) ? innerBlock[1] : null
  if (!iLabel || innerBlock.length < 3) return null
  const innerLoop = innerBlock[innerBlock.length - 1]
  if (!isArr(innerLoop) || innerLoop[0] !== 'loop') return null
  const ilLabel = (typeof innerLoop[1] === 'string' && innerLoop[1].startsWith('$')) ? innerLoop[1] : null
  if (!ilLabel) return null
  // The inner block may also carry LICM-hoisted invariants (e.g. BAILOUT) before the loop.
  // They must be pixel-pair-invariant (read only outer-invariants) so one copy feeds both
  // lanes; hoist them ahead of the SIMD loop.
  const innerPre = innerBlock.slice(2, innerBlock.length - 1)
  for (const s of innerPre) {
    if (!isArr(s) || s[0] !== 'local.set' || s.length !== 3) return null
    const inv = (n) => !isArr(n) || ((n[0] === 'local.get' || n[0] === 'global.get') ? !writesName(loopNode, n[1]) : n.every((c, i) => i === 0 || inv(c)))
    if (!inv(s[2])) return null
  }

  // ---- inner escape loop: a top while-cond + body (f64 updates + one mid-break) + it++.
  // The two continue/break conditions are an `it < MAXIT` limit and a `|z|² vs T` escape,
  // in EITHER order (mandelbrot/ship: limit at top; example-mandelbrot: escape at top). ----
  const iEnd = innerLoop.length - 1
  if (!(isArr(innerLoop[iEnd]) && innerLoop[iEnd][0] === 'br' && innerLoop[iEnd][1] === ilLabel)) return null
  const itVar = matchInc1(innerLoop[iEnd - 1])
  if (!itVar || fnLocals.get(itVar) !== 'i32') return null

  // A break statement (br_if, or `if BC (then (br iLabel))`) → its break-when condition.
  // breakCond: does this statement break the inner loop?  Returns { cond, assigns } where
  // `assigns` is a list of { name, val } local.set stmts extracted from the then-block
  // BEFORE the final br.  Existing single-br form → assigns=[].  Multi-stmt then form (Newton:
  // `if(cond)(then (local.set $root K)(br $iLabel))`) → assigns=[{name,val}].
  const breakCond = (s) => {
    if (!isArr(s)) return null
    if (s[0] === 'br_if' && s[1] === iLabel) return { cond: s[2], assigns: [] }
    if (s[0] !== 'if' || s.length !== 3 || !isArr(s[2]) || s[2][0] !== 'then') return null
    const then = s[2]
    // then-block must end with (br $iLabel); all preceding stmts must be local.set
    if (!isArr(then[then.length - 1]) || then[then.length - 1][0] !== 'br' || then[then.length - 1][1] !== iLabel) return null
    const assigns = []
    for (let k = 1; k < then.length - 1; k++) {
      const st = then[k]
      if (!isArr(st) || st[0] !== 'local.set' || st.length !== 3) return null
      assigns.push({ name: st[1], val: st[2] })
    }
    return { cond: s[1], assigns }
  }
  // keep (continue) condition vs the break-when condition. A while-guard `(i32.eqz CONT)`
  // keeps on CONT directly; a mid-break `if (X) break` keeps on ¬X. We must NOT lower ¬X by
  // flipping the comparison (f64.gt→f64.le): for NaN, scalar `NOT(NaN>T)` is TRUE but
  // `NaN<=T` is FALSE — they disagree, so an orbit that reaches NaN without escaping would
  // wrongly deactivate. Instead keep the DIRECT comparison and negate the lane mask with
  // v128.not (NaN-exact: gt is false on NaN, ¬false = keep, matching scalar).
  const keepOf = (bc) => {
    if (!isArr(bc)) return null
    if (bc[0] === 'i32.eqz' && isArr(bc[1]) && CMP_LANE[bc[1][0]]) return { cmp: bc[1], negate: false }
    if (CMP_NEG[bc[0]]) return { cmp: bc, negate: true }
    return null
  }
  const topBcR = breakCond(innerLoop[2])
  const topBc = topBcR?.cond   // raw condition expr (backward-compat name for compound-top checks)
  let keepTop = topBcR && keepOf(topBcR.cond)
  const ibody = innerLoop.slice(3, iEnd - 1)
  let midIdx = -1, keepMid = null, compoundTop = false
  // Compound while-guard `while (it<MAX && |z|²<T)` → `eqz(and(A,B))`: two keep conditions, both
  // at the top (continue while A AND B). The Julia set is written this way. Split A,B into the two
  // keeps; the body is then pure updates (no mid-break).
  if (!keepTop && isArr(topBc) && topBc[0] === 'i32.eqz' && isArr(topBc[1]) && topBc[1][0] === 'i32.and'
      && isArr(topBc[1][1]) && CMP_LANE[topBc[1][1][0]] && isArr(topBc[1][2]) && CMP_LANE[topBc[1][2][0]]) {
    keepTop = { cmp: topBc[1][1], negate: false }
    keepMid = { cmp: topBc[1][2], negate: false }
    compoundTop = true
  }
  if (!keepTop) return null
  // Collect mid-breaks.  The existing single-break path requires exactly one.
  // The new multi-break path (Newton-style convergence) allows several outcome breaks
  // — each `if(COND)(then (local.set $X K)(br $iLabel))` — when the top guard is the
  // sole limit condition and ALL mid-breaks are escape-kind with i32 outcome assigns.
  const midBreaks = []   // [{ idx, keep, assigns }]
  if (compoundTop) {
    for (let i = 0; i < ibody.length; i++)
      if (!(isArr(ibody[i]) && ibody[i][0] === 'local.set' && ibody[i].length === 3 && fnLocals.get(ibody[i][1]) === 'f64')) return null
  } else {
    for (let i = 0; i < ibody.length; i++) {
      const bcR = breakCond(ibody[i])
      if (bcR) {
        const k = keepOf(bcR.cond)
        if (!k) return null
        midBreaks.push({ idx: i, keep: k, assigns: bcR.assigns })
      } else if (!(isArr(ibody[i]) && ibody[i][0] === 'local.set' && ibody[i].length === 3 && fnLocals.get(ibody[i][1]) === 'f64')) return null
    }
    if (midBreaks.length === 0) return null
    if (midBreaks.length === 1) {
      // single-break: preserve exact existing behaviour
      midIdx = midBreaks[0].idx; keepMid = midBreaks[0].keep
    }
    // multi-break: handled below after classification
  }

  // classify f64 vars written across [top-guard, …body…]: loop-carried (first access a READ)
  // vs within-iteration temp (first access a WRITE — including squares tee'd in the guard).
  const seq = [innerLoop[2], ...ibody]
  const written = new Set()
  const collectW = (n) => { if (!isArr(n)) return; if ((n[0] === 'local.set' || n[0] === 'local.tee') && fnLocals.get(n[1]) === 'f64') written.add(n[1]); for (let i = 1; i < n.length; i++) collectW(n[i]) }
  seq.forEach(collectW)
  const carried = new Set(), temp = new Set(), seen = new Set()
  const classify = (n) => {
    if (!isArr(n)) return
    if (n[0] === 'local.get') { const v = n[1]; if (written.has(v) && !seen.has(v)) { seen.add(v); carried.add(v) }; return }
    if (n[0] === 'local.set' || n[0] === 'local.tee') { classify(n[2]); const v = n[1]; if (written.has(v) && !seen.has(v)) { seen.add(v); temp.add(v) }; return }
    for (let i = 1; i < n.length; i++) classify(n[i])
  }
  seq.forEach(classify)

  // hoist tees out of the keep conditions into explicit temp computations
  const tees = []
  const detee = (n) => isArr(n) ? (n[0] === 'local.tee' ? (tees.push({ tgt: n[1], expr: detee(n[2]) }), ['local.get', n[1]]) : n.map(detee)) : n
  const keepTopC = { cmp: [keepTop.cmp[0], detee(keepTop.cmp[1]), detee(keepTop.cmp[2])], negate: keepTop.negate }
  const teeTop = tees.length
  const keepMidC = keepMid ? { cmp: [keepMid.cmp[0], detee(keepMid.cmp[1]), detee(keepMid.cmp[2])], negate: keepMid.negate } : null

  // each keep is an it-limit (mentions `it` directly or via convert) or a z-escape; need one of each
  const isIt = (n) => isLocalGet(n, itVar) || (isArr(n) && n[0] === 'f64.convert_i32_s' && isLocalGet(n[1], itVar))
  const kindOf = (k) => (isIt(k.cmp[1]) || isIt(k.cmp[2])) ? 'limit' : 'escape'
  const kTop = kindOf(keepTopC)
  const limitKeep = keepTopC   // initialised here; may be reassigned below for single-break
  let kMid = null, boundExpr, boundI32, itLeft
  // Compound-top guard `while (A && B)`: classify the SECOND keep too. Left unclassified (kMid=null),
  // the downstream lift/keepMask treats keepMidC as a per-lane f64 escape — right for the Julia order
  // (limit, escape) but it then lifts the i32 LIMIT of the mandelbrot order (escape, `it<MAX`) into an
  // f64 lane and crashes. Setting kMid routes the limit through the scalar guard instead; for the
  // Julia order kMid='escape' is identical to the old null (both lift). Bail if neither keep is an
  // escape — a two-limit guard has no per-lane divergence for this vectorizer to exploit.
  if (compoundTop) {
    kMid = kindOf(keepMidC)
    if (kTop === 'limit' && kMid === 'limit') return null
  }
  if (midBreaks.length === 1) {
    kMid = kindOf(keepMidC)
    if (kTop === kMid) return null
    const lk = kTop === 'limit' ? keepTopC : keepMidC
    itLeft = isIt(lk.cmp[1])
    boundExpr = itLeft ? lk.cmp[2] : lk.cmp[1]
    boundI32 = lk.cmp[0].startsWith('i32.')
  } else if (midBreaks.length > 1) {
    // Multi-break path: top must be the sole limit; all mid-breaks must be escape-kind.
    if (kTop !== 'limit') return null
    for (const mb of midBreaks) if (kindOf(mb.keep) !== 'escape') return null
    itLeft = isIt(keepTopC.cmp[1])
    boundExpr = itLeft ? keepTopC.cmp[2] : keepTopC.cmp[1]
    boundI32 = keepTopC.cmp[0].startsWith('i32.')
  }
  // limit bound must be loop-invariant (splatted once per pair): no carried/temp ref, not written
  for (const v of [...carried, ...temp]) if (readsVar(boundExpr, v)) return null
  const boundInvariant = (n) => !isArr(n) || ((n[0] !== 'local.get' && n[0] !== 'global.get') || !writesName(loopNode, n[1])) && n.every((c, i) => i === 0 || boundInvariant(c))
  if (!boundInvariant(boundExpr)) return null

  // c-vars: f64 locals read in the lifted exprs but never written there (per-pixel/invariant inputs).
  // Also allow loop-invariant global.get (e.g. module constants like R3 in newton) — splatted inline.
  const cVars = new Set()
  const liftable = (n) => {
    if (!isArr(n)) return false
    if (n[0] === 'local.get') {
      const v = n[1]
      if (v !== itVar && !carried.has(v) && !temp.has(v)) { if (fnLocals.get(v) !== 'f64') return false; cVars.add(v) }
      return true
    }
    if (n[0] === 'f64.const') return true
    if (n[0] === 'global.get') return !writesName(loopNode, n[1])   // loop-invariant global → splat
    if (LANE_PURE.f64.has(n[0])) { for (let i = 1; i < n.length; i++) if (!liftable(n[i])) return false; return true }
    return false
  }
  const midIdxSet = new Set(midBreaks.map(mb => mb.idx))
  for (const t of tees) if (!liftable(t.expr)) return null
  for (let i = 0; i < ibody.length; i++) if (!midIdxSet.has(i) && !liftable(ibody[i][2])) return null
  if (midBreaks.length === 1) {
    const escapeKeep = kTop === 'escape' ? keepTopC : keepMidC
    if (!liftable(escapeKeep.cmp[1]) || !liftable(escapeKeep.cmp[2])) return null
  } else {
    // multi-break: each break's escape condition arguments must be liftable
    for (const mb of midBreaks) {
      const mbC = { cmp: [mb.keep.cmp[0], detee(mb.keep.cmp[1]), detee(mb.keep.cmp[2])], negate: mb.keep.negate }
      mb.keepC = mbC   // store deteed keepC on mb for use in emit
      if (!liftable(mbC.cmp[1]) || !liftable(mbC.cmp[2])) return null
    }
  }

  // ---- pre-inner inits + epilogue ----
  // i32 outcome variables assigned by multi-break outcome stmts (e.g. $root in Newton).
  // Their pre-inner `local.set $root 0` default-init is valid and must not be rejected.
  const outcomeVarSetEarly = new Set(midBreaks.flatMap(mb => mb.assigns.map(a => a.name)))
  const carriedInit = new Map()   // carried var → its f64.const seed (before the loop)
  const perPxInit = new Map()     // c-var → its per-pixel init expr
  // Pre-watr, jz's raw lowering hasn't run DCE yet — obody[0..innerIdx) may hold pre-loop f64
  // locals the OLD post-watr recognizer never saw (watr had already deleted them). Two live
  // shapes beyond direct escape-loop reads (cVars, already populated by the liftable() walk
  // above): (a) truly dead — a per-pixel grid coord the update ignores (Julia fixed-c: cx/cy
  // computed but the orbit never reads them — mandelbrot's dual DOES read them); safe to drop.
  // (b) a carried var's z0 seed reads it INDIRECTLY through one extra local (Julia/Newton
  // per-pixel z0: x0 = <ramp>; zx = x0) — cVars only sees reads INSIDE the escape loop, so x0
  // is invisible to it even though it IS the real seed expression. Close that gap with a
  // needed-set fixpoint before classifying, so x0 promotes to a c-var exactly like a directly
  // read grid coord — liftCLane already resolves a cVar reference at emit.
  const epilogue = obody.slice(innerIdx + 1)
  const preStmts = []
  for (let i = 0; i < innerIdx; i++) {
    const s = obody[i]
    if (!isArr(s) || s[0] !== 'local.set' || s.length !== 3) return null
    preStmts.push({ tgt: s[1], expr: s[2] })
  }
  const preTgt = new Set(preStmts.map(p => p.tgt))
  // A pre-loop local promotes to a c-var only if some OTHER classified site actually reads it —
  // never one of the reserved roles (carried/temp/itVar/outcome), which already have their own
  // per-lane home and must keep taking their existing branch below.
  const promotable = (v) => !carried.has(v) && !temp.has(v) && v !== itVar && !outcomeVarSetEarly.has(v)
  const needed = new Set(cVars)
  for (const { tgt, expr } of preStmts) if (carried.has(tgt)) for (const v of preTgt) if (promotable(v) && readsVar(expr, v)) needed.add(v)
  for (const e of epilogue) for (const v of preTgt) if (promotable(v) && readsVar(e, v)) needed.add(v)
  for (let changed = true; changed;) {
    changed = false
    for (const { tgt, expr } of preStmts) if (needed.has(tgt))
      for (const v of preTgt) if (v !== tgt && promotable(v) && !needed.has(v) && readsVar(expr, v)) { needed.add(v); changed = true }
  }
  for (const { tgt, expr } of preStmts) {
    if (carried.has(tgt)) {
      // z₀ seed: a constant (mandelbrot/burning-ship z₀=0) OR a per-pixel expr (Julia set, where
      // z₀ = the pixel and c is constant — the dual of mandelbrot). liftCLane handles both at emit.
      carriedInit.set(tgt, expr)
    } else if (temp.has(tgt)) { /* recomputed each iteration — init ignored */ }
    else if (tgt === itVar) { if (constNum(expr) !== 0) return null }
    else if (needed.has(tgt)) { cVars.add(tgt); perPxInit.set(tgt, expr) }
    else if (outcomeVarSetEarly.has(tgt)) { /* i32 outcome var default init — ignored, handled per-lane */ }
    else if (!hasSideEffect(expr)) { /* dead per-pixel local — the escape update never reads it, drop */ }
    else return null
  }
  for (const c of carried) if (!carriedInit.has(c)) return null
  // The epilogue runs scalar per lane; it may only read carried/it/pixel-IV/invariant
  // values (each statement's reads, before that statement's writes). A read of an
  // inner-loop temp or a per-pixel c-var has no post-loop per-lane value → bail.
  {
    const written = new Set()
    for (const s of epilogue) {
      const r = new Set(); (function rd(n){ if(!isArr(n)) return; if(n[0]==='local.get') r.add(n[1]); else for(const c of n) rd(c) })(s)
      for (const v of r) if (!written.has(v) && (temp.has(v) || perPxInit.has(v))) return null
      ;(function wr(n){ if(!isArr(n)) return; if((n[0]==='local.set'||n[0]==='local.tee')&&typeof n[1]==='string') written.add(n[1]); for(const c of n.slice(2)) wr(c) })(s)
    }
    if (!epilogue.length) return null
  }

  // ============================ emit ============================
  const id = freshIdRef.next++
  const nm = (s) => `$__esc${id}_${s}`
  const shadow = new Map()                       // carried/temp f64 var → v128 shadow
  for (const v of [...carried, ...temp]) shadow.set(v, nm('z' + v.replace(/\W/g, '')))
  const cLane = new Map()
  for (const cv of cVars) cLane.set(cv, nm('c' + cv.replace(/\W/g, '')))
  const iterV = nm('iter'), activeV = nm('act'), maxitLane = nm('lim')
  const newLocalDecls = []
  for (const n of [...shadow.values(), ...cLane.values()]) newLocalDecls.push(['local', n, 'v128'])

  const lift = (n) => {
    if (n[0] === 'local.get') return ['local.get', shadow.has(n[1]) ? shadow.get(n[1]) : cLane.get(n[1])]
    if (n[0] === 'f64.const') return ['f64x2.splat', n]
    if (n[0] === 'global.get') return ['f64x2.splat', n]   // loop-invariant module global (e.g. R3)
    return [LANE_PURE.f64.get(n[0]).simd, ...n.slice(1).map(lift)]
  }
  const bump = (n, k) => k === 0 ? n           // substitute every pixel-IV with (IV + k), in its type
    : (isArr(n) && n[0] === 'local.get' && pivType.has(n[1]))
      ? [pivType.get(n[1]) + '.add', n, [pivType.get(n[1]) + '.const', k]]
      : (isArr(n) ? n.map(c => bump(c, k)) : n)

  // Build a per-pixel c-var's two lanes by lifting its init to f64x2: the pixel IV becomes the
  // ramp [v, v+1], a dependency on another c-var resolves to that c-var's already-built lane
  // (so chains like `bail = 4 + cx*cx` get the right per-lane value — NOT the px=0 value from a
  // bump that can't follow `cx`), and everything else (grid constants) splats. Returns null if
  // the init reads inner-loop state or an op we can't lift, in which case we decline.
  const liftCLane = (n) => {
    if (!isArr(n)) return null
    if (n[0] === 'local.get' || n[0] === 'global.get') {
      const v = n[1]
      if (n[0] === 'local.get') {
        if (cLane.has(v)) return ['local.get', cLane.get(v)]                 // another c-var's lane
        if (carried.has(v) || temp.has(v)) return null                       // inner-loop state — must not appear
        if (pivType.get(v) === 'f64') return ['f64x2.replace_lane', 1, ['f64x2.splat', n], ['f64.add', n, ['f64.const', 1]]]
      }
      if (writesName(loopNode, v)) return null                               // a per-pixel value we can't ramp → decline
      return ['f64x2.splat', n]                                              // loop-invariant local/global
    }
    if (n[0] === 'f64.const') return ['f64x2.splat', n]
    if (n[0] === 'f64.convert_i32_s' && isArr(n[1]) && n[1][0] === 'local.get' && pivType.get(n[1][1]) === 'i32') {
      const piv = n[1]
      return ['f64x2.replace_lane', 1, ['f64x2.splat', ['f64.convert_i32_s', piv]], ['f64.convert_i32_s', ['i32.add', piv, ['i32.const', 1]]]]
    }
    if (LANE_PURE.f64.has(n[0])) { const ks = n.slice(1).map(liftCLane); return ks.some(k => k === null) ? null : [LANE_PURE.f64.get(n[0]).simd, ...ks] }
    return null
  }
  // c-lanes in dependency order: invariants splat first, then per-pixel inits in source (obody) order
  const cOrder = [...cVars].filter(cv => !perPxInit.has(cv))
  for (let i = 0; i < innerIdx; i++) { const s = obody[i]; if (isArr(s) && s[0] === 'local.set' && perPxInit.has(s[1])) cOrder.push(s[1]) }
  const pre = []
  for (const cv of cOrder) {
    if (perPxInit.has(cv)) {
      const lane = liftCLane(perPxInit.get(cv))
      if (!lane) return null
      pre.push(['local.set', cLane.get(cv), lane])
    } else pre.push(['local.set', cLane.get(cv), ['f64x2.splat', ['local.get', cv]]])
  }
  // Seed each carried lane in dependency order. Seeds reading only non-carried values (z₀ = a
  // const, or a per-pixel ramp for the Julia set) build their lanes via liftCLane. Seeds reading
  // a carried var — the cached squares `zx2 = zx*zx` in Julia's compound guard — lift through the
  // already-built shadow lanes instead.
  const seedDeps = (e) => [...carried].some(c => readsVar(e, c))
  const depLiftable = (n) => !isArr(n) ? false
    : n[0] === 'local.get' ? shadow.has(n[1])
    : n[0] === 'f64.const' ? true
    : (LANE_PURE.f64.has(n[0]) && n.slice(1).every(depLiftable))
  for (const v of carried) if (!seedDeps(carriedInit.get(v))) {
    const lane = liftCLane(carriedInit.get(v))
    if (!lane) return null
    pre.push(['local.set', shadow.get(v), lane])
  }
  for (const v of carried) if (seedDeps(carriedInit.get(v))) {
    if (!depLiftable(carriedInit.get(v))) return null
    pre.push(['local.set', shadow.get(v), lift(carriedInit.get(v))])
  }
  const teeStmts = (range) => range.map(t => ['local.set', shadow.get(t.tgt), lift(t.expr)])
  const sIn = nm('ib'), sIl = nm('il'), sOut = nm('ob'), sOl = nm('ol')

  // FAST PATH — the common escape-time shape `while (it<MAX){ …updates…; if (|z|²>T) break }`:
  // break the pair the instant the FIRST lane escapes (no per-iteration freeze/mask), keep `it`
  // a scalar i32, raw f64x2 updates. A short scalar tail then finishes whichever lane lagged (≈0
  // iterations when the pair is coherent, which adjacent pixels overwhelmingly are). Inside-set
  // pixels (both lanes to MAX) run clean 2× with zero mask overhead — exactly where the masked
  // loop bled its speedup. Other shapes (escape-at-top, body after the break) take the masked path.
  // escape-at-MID: `…updates…; if (|z|²>T) break` (burning-ship). escape-at-TOP: the escape gates
  // the loop head — either syntactically in the while condition, or after only temporary
  // computations such as `x2=zx*zx; y2=zy*zy` and before every carried-state update. The latter
  // is canonical `while(limit){ squares; if(escape) break; update }`. Both take the fast path;
  // only a true post-update break advances `it` before the lagging-lane tail resumes.
  const escAtMid = !compoundTop && kMid === 'escape' && midIdx === ibody.length - 1
  const escBeforeCarry = !compoundTop && kMid === 'escape' && midIdx >= 0 &&
    ibody.slice(0, midIdx).every(s => temp.has(s[1])) &&
    ibody.slice(midIdx + 1).some(s => carried.has(s[1]))
  const escAtTop = compoundTop || kTop === 'escape' || escBeforeCarry
  const fastPath = escAtMid || escAtTop
  let simdInner, epiLane, postLoop = []

  if (fastPath) {
    const shIt = nm('shit'), escF = nm('escf')
    newLocalDecls.push(['local', shIt, 'i32'], ['local', escF, 'i32'])
    pre.push(['local.set', itVar, ['i32.const', 0]], ['local.set', escF, ['i32.const', 0]])
    const limOf = (keepC) => keepC.negate ? [CMP_NEG[keepC.cmp[0]], keepC.cmp[1], keepC.cmp[2]] : keepC.cmp
    // emit a keep at its source position: a LIMIT (it is shared) → a scalar i32 guard; an ESCAPE
    // → an any_true break. `escF` records whether the loop exited via an escape (vs the limit) —
    // they can BOTH land at it=MAX (escape-at-top fires before the limit-at-mid's final update),
    // so `it < MAX` alone can't tell them apart; the tail must run only on an escape exit.
    const fastKeep = (keepC, kind, teeRange) => {
      const out = teeStmts(teeRange)
      if (kind === 'limit') out.push(['br_if', sIn, ['i32.eqz', limOf(keepC)]])
      else {
        const escL = [CMP_LANE[keepC.cmp[0]], lift(keepC.cmp[1]), lift(keepC.cmp[2])]
        out.push(['local.set', escF, ['i32.const', 1]])
        out.push(['br_if', sIn, ['v128.any_true', keepC.negate ? escL : ['v128.not', escL]]])
        out.push(['local.set', escF, ['i32.const', 0]])
      }
      return out
    }
    const sbody = [...fastKeep(keepTopC, kTop, tees.slice(0, teeTop))]
    if (compoundTop) sbody.push(...fastKeep(keepMidC, kMid, tees.slice(teeTop)))   // second top keep
    for (let i = 0; i < ibody.length; i++) {
      if (!compoundTop && i === midIdx) sbody.push(...fastKeep(keepMidC, kMid, tees.slice(teeTop)))
      else sbody.push(['local.set', shadow.get(ibody[i][1]), lift(ibody[i][2])])   // raw update, no freeze
    }
    sbody.push(['local.set', itVar, ['i32.add', ['local.get', itVar], ['i32.const', 1]]])
    simdInner = ['block', sIn, ['loop', sIl, ...sbody, ['br', sIl]]]
    postLoop = [['local.set', shIt, ['local.get', itVar]]]   // capture the break `it` AFTER the block exits

    // a fresh-labelled copy of the inner block, to finish a lagging lane's remaining iterations
    let copyN = 0
    const relabelInner = () => {
      const ni = nm('tb' + copyN), nl = nm('tl' + copyN); copyN++
      const rl = (n) => !isArr(n) ? n
        : ((n[0] === 'block' || n[0] === 'loop' || n[0] === 'br' || n[0] === 'br_if') && (n[1] === iLabel || n[1] === ilLabel))
          ? [n[0], n[1] === iLabel ? ni : nl, ...n.slice(2).map(rl)]
          : n.map(rl)
      return rl(innerBlock)
    }
    const escKeepC = compoundTop ? keepMidC : (kTop === 'escape' ? keepTopC : keepMidC)
    const escTees = (kTop === 'escape' ? tees.slice(0, teeTop) : tees.slice(teeTop)).map(t => ['local.set', t.tgt, t.expr])
    const notEsc = escKeepC.negate ? ['i32.eqz', escKeepC.cmp] : escKeepC.cmp
    epiLane = (k) => {
      const out = []
      // Extract carried AND temp lanes: the escape compare may read a temp (the optimizer
      // copy-propagates `x = xt` so `x*x` becomes `xt*xt`); the skip test below needs it.
      for (const v of [...carried, ...temp]) out.push(['local.set', v, ['f64x2.extract_lane', k, ['local.get', shadow.get(v)]]])
      for (let i = 0; i < innerIdx; i++) { const s = obody[i]; if (isArr(s) && s[0] === 'local.set' && perPxInit.has(s[1])) out.push(bump(s, k)) }
      out.push(['local.set', itVar, ['local.get', shIt]])
      out.push(['if', ['local.get', escF], ['then',                 // exited via escape (not the limit)…
        ...escTees,
        ['if', notEsc, ['then',                                      // …and THIS lane hadn't escaped → finish it
          // escape-at-MID already ran this iteration's update, so step past it before resuming;
          // escape-at-TOP tests before the update, so resume at the same it.
          ...(escAtMid ? [['local.set', itVar, ['i32.add', ['local.get', itVar], ['i32.const', 1]]]] : []),
          relabelInner()]]]])
      for (const s of epilogue) out.push(bump(s, k))
      return out
    }
  } else if (midBreaks.length > 1) {
    // ---- MULTI-OUTCOME masked path (Newton-style convergence loops) ----
    // Each mid-break `if(COND)(then (local.set $X K)(br))` converges a subset of lanes per
    // iteration.  We track which lanes are still running in `activeV` and per-lane outcomes
    // in i32x4 shadow vectors (one per distinct i32 outcome variable).  The break mask for
    // each convergence condition is: v128.and(activeV, breakMaskOf(keepC)).
    // Bit-exactness: i32x4 layout has 4 lanes of 32 bits.  f64x2 has 2 lanes of 64 bits.
    // For f64 lane k, i32 lane 2*k carries the outcome (lower 32 bits of the f64 lane).
    // i32x4.splat(K) fills all 4 i32 lanes with K; v128.bitselect selects at bit level, so
    // for a converged f64 lane (bits 64k…64k+63 = -1 in the mask) both i32 halves get K.
    // i32x4.extract_lane(2*k, outcomeVec) recovers the scalar outcome per lane. ✓

    // Collect distinct i32 outcome variables across all mid-breaks.
    const outcomeVars = []    // distinct i32 local names that get assigned in outcome breaks
    const outcomeVarSet = new Set()
    for (const mb of midBreaks) {
      for (const a of mb.assigns) {
        // itVar is tracked by iterV (f64x2) directly — not as an i32x4 outcome shadow.
        if (a.name !== itVar && !outcomeVarSet.has(a.name)) { outcomeVarSet.add(a.name); outcomeVars.push(a.name) }
      }
    }
    // Each outcome var gets an i32x4 shadow vector (initial value 0 = "no convergence" default).
    const outcomeVec = new Map()
    for (const v of outcomeVars) { const sv = nm('out' + v.replace(/\W/g, '')); outcomeVec.set(v, sv); newLocalDecls.push(['local', sv, 'v128']) }

    newLocalDecls.push(['local', iterV, 'v128'], ['local', activeV, 'v128'], ['local', maxitLane, 'v128'])
    pre.push(['local.set', iterV, ['f64x2.splat', ['f64.const', 0]]])
    pre.push(['local.set', activeV, ['v128.const', 'i32x4', '-1', '-1', '-1', '-1']])
    pre.push(['local.set', maxitLane, ['f64x2.splat', boundI32 ? ['f64.convert_i32_s', boundExpr] : boundExpr]])
    for (const sv of outcomeVec.values()) pre.push(['local.set', sv, ['v128.const', 'i32x4', '0', '0', '0', '0']])

    // keepMask for the limit top-guard (iter < MAXIT)
    const keepMask = (keep, isLimit) => {
      const m = isLimit
        ? [CMP_LANE[keep.cmp[0]], itLeft ? ['local.get', iterV] : ['local.get', maxitLane], itLeft ? ['local.get', maxitLane] : ['local.get', iterV]]
        : [CMP_LANE[keep.cmp[0]], lift(keep.cmp[1]), lift(keep.cmp[2])]
      return keep.negate ? ['v128.not', m] : m
    }
    // breakMaskOf: v128 where bits = -1 for lanes whose break condition is NOW true
    // (opposite of keepMask: keep.negate=true → break is the positive compare).
    const breakMaskOf = (keepC) => {
      const m = [CMP_LANE[keepC.cmp[0]], lift(keepC.cmp[1]), lift(keepC.cmp[2])]
      return keepC.negate ? m : ['v128.not', m]
    }

    const sbody = [
      ...teeStmts(tees.slice(0, teeTop)),
      ['local.set', activeV, ['v128.and', ['local.get', activeV], keepMask(keepTopC, true)]],
      ['br_if', sIn, ['i32.eqz', ['v128.any_true', ['local.get', activeV]]]],
    ]
    for (let i = 0; i < ibody.length; i++) {
      const mb = midBreaks.find(m => m.idx === i)
      if (mb) {
        // Convergence break: compute which lanes converge on THIS step.
        const bm = breakMaskOf(mb.keepC)
        const convV = nm('conv' + i)
        newLocalDecls.push(['local', convV, 'v128'])
        sbody.push(['local.set', convV, ['v128.and', ['local.get', activeV], bm]])
        // Apply each outcome assignment via bitselect on converged-this-step mask.
        for (const a of mb.assigns) {
          if (a.name === itVar) {
            // Assignment to the iteration counter (e.g. it=MAXIT before break): freeze iterV.
            sbody.push(['local.set', iterV, ['v128.bitselect', ['local.get', maxitLane], ['local.get', iterV], ['local.get', convV]]])
          } else if (outcomeVec.has(a.name)) {
            // i32 outcome variable (e.g. root=1/2/3): bitselect into its i32x4 shadow.
            // The scalar value K must be an i32 constant — splat it across all i32x4 lanes.
            if (!isArr(a.val) || a.val[0] !== 'i32.const') return null
            const sv = outcomeVec.get(a.name)
            sbody.push(['local.set', sv, ['v128.bitselect', ['i32x4.splat', a.val], ['local.get', sv], ['local.get', convV]]])
          } else return null   // unexpected assign target
        }
        // Remove newly-converged lanes from active set.
        sbody.push(['local.set', activeV, ['v128.andnot', ['local.get', activeV], ['local.get', convV]]])
      } else {
        const v = ibody[i][1]
        if (carried.has(v)) sbody.push(['local.set', shadow.get(v), ['v128.bitselect', lift(ibody[i][2]), ['local.get', shadow.get(v)], ['local.get', activeV]]])
        else sbody.push(['local.set', shadow.get(v), lift(ibody[i][2])])
      }
    }
    sbody.push(['local.set', iterV, ['v128.bitselect', ['f64x2.add', ['local.get', iterV], ['f64x2.splat', ['f64.const', 1]]], ['local.get', iterV], ['local.get', activeV]]])
    simdInner = ['block', sIn, ['loop', sIl, ...sbody, ['br', sIl]]]
    const carriedInEpi = [...carried].filter(v => epilogue.some(s => readsVar(s, v)))
    epiLane = (k) => {
      const out = []
      for (const v of carriedInEpi) out.push(['local.set', v, ['f64x2.extract_lane', k, ['local.get', shadow.get(v)]]])
      out.push(['local.set', itVar, ['i32.trunc_f64_s', ['f64x2.extract_lane', k, ['local.get', iterV]]]])
      // Extract per-lane outcome variables from their i32x4 shadows (i32 lane = 2*k).
      for (const [v, sv] of outcomeVec) out.push(['local.set', v, ['i32x4.extract_lane', 2 * k, ['local.get', sv]]])
      for (const s of epilogue) out.push(bump(s, k))
      return out
    }
  } else {
    newLocalDecls.push(['local', iterV, 'v128'], ['local', activeV, 'v128'], ['local', maxitLane, 'v128'])
    pre.push(['local.set', iterV, ['f64x2.splat', ['f64.const', 0]]])
    pre.push(['local.set', activeV, ['v128.const', 'i32x4', '-1', '-1', '-1', '-1']])
    pre.push(['local.set', maxitLane, ['f64x2.splat', boundI32 ? ['f64.convert_i32_s', boundExpr] : boundExpr]])
    // AND a keep into the active mask: limit compares iter (f64x2) to the bound; escape lifts its
    // z-comparison; a mid-break's ¬X is the DIRECT compare negated by v128.not (NaN-exact).
    const keepMask = (keep, isLimit) => {
      const m = isLimit
        ? [CMP_LANE[keep.cmp[0]], itLeft ? ['local.get', iterV] : ['local.get', maxitLane], itLeft ? ['local.get', maxitLane] : ['local.get', iterV]]
        : [CMP_LANE[keep.cmp[0]], lift(keep.cmp[1]), lift(keep.cmp[2])]
      return keep.negate ? ['v128.not', m] : m
    }
    const sbody = [
      ...teeStmts(tees.slice(0, teeTop)),
      ['local.set', activeV, ['v128.and', ['local.get', activeV], keepMask(keepTopC, kTop === 'limit')]],
      // compound `while (A && B)`: the second keep (B) also gates at the top, before the body
      ...(compoundTop ? teeStmts(tees.slice(teeTop)).concat([['local.set', activeV, ['v128.and', ['local.get', activeV], keepMask(keepMidC, kMid === 'limit')]]]) : []),
      ['br_if', sIn, ['i32.eqz', ['v128.any_true', ['local.get', activeV]]]],
    ]
    for (let i = 0; i < ibody.length; i++) {
      if (!compoundTop && i === midIdx) {
        sbody.push(...teeStmts(tees.slice(teeTop)))
        sbody.push(['local.set', activeV, ['v128.and', ['local.get', activeV], keepMask(keepMidC, kMid === 'limit')]])
      } else {
        const v = ibody[i][1]
        if (carried.has(v)) sbody.push(['local.set', shadow.get(v), ['v128.bitselect', lift(ibody[i][2]), ['local.get', shadow.get(v)], ['local.get', activeV]]])
        else sbody.push(['local.set', shadow.get(v), lift(ibody[i][2])])
      }
    }
    sbody.push(['local.set', iterV, ['v128.bitselect', ['f64x2.add', ['local.get', iterV], ['f64x2.splat', ['f64.const', 1]]], ['local.get', iterV], ['local.get', activeV]]])
    simdInner = ['block', sIn, ['loop', sIl, ...sbody, ['br', sIl]]]
    const carriedInEpi = [...carried].filter(v => epilogue.some(s => readsVar(s, v)))
    epiLane = (k) => {
      const out = []
      for (const v of carriedInEpi) out.push(['local.set', v, ['f64x2.extract_lane', k, ['local.get', shadow.get(v)]]])
      out.push(['local.set', itVar, ['i32.trunc_f64_s', ['f64x2.extract_lane', k, ['local.get', iterV]]]])
      for (const s of epilogue) out.push(bump(s, k))
      return out
    }
  }

  // SIMD outer loop: process a pair while x+1 is still a valid pixel, then advance every pixel IV
  // by 2. The scalar tail (original block) finishes any last odd pixel.
  const simdOuter = ['block', sOut, ['loop', sOl,
    ['br_if', sOut, ['i32.eqz', [oExit.cmpOp, bump(['local.get', pxVar], 1), widthBound]]],
    ...pre, simdInner, ...postLoop, ...epiLane(0), ...epiLane(1),
    ...pixelIVs.map(p => ['local.set', p.name, [p.type + '.add', ['local.get', p.name], [p.type + '.const', 2]]]),
    ['br', sOl]]]

  // wrapper: hoisted preambles once (outer + inner-block invariants like BAILOUT), then the
  // SIMD even-pixel loop, then the original scalar block handles the odd-pixel tail.
  const tailBlock = ['block', oLabel, loopNode]
  const wrapper = ['block', nm('w'), ...preamble, ...innerPre, simdOuter, tailBlock]
  return { wrapper, newLocalDecls }
}

// Math.sin/cos lower to `call $math.{sin,cos}_core` (the emit-time fast path, math.js:67); the
// public `$math.{sin,cos}` wrap the same core. Their f64x2 mirrors $math.sin2/$math.cos2 (the
// vectorized reduce+horner, module/math.js:543) are BIT-EXACT per lane to the scalar core — so we
// can lift the call straight to the *2 helper. Phase-2 adds pow/log/atan2 here (see PPC_CALL2).
// NOTE: scalar targets here must be kept out of watr's single-caller inlining — jz passes these
// keys (SIMD_PINNED, below) as watOptimize's `pin` list, else the call node is gone before this lift runs.
const PPC_CALL2 = {
  '$math.sin_core': '$math.sin2', '$math.cos_core': '$math.cos2',
  '$math.sin': '$math.sin2', '$math.cos': '$math.cos2',
  '$math.pow': '$math.pow2',   // 2-arg; bit-exact per-lane scalar (cancellation-sensitive — see module/math.js)
  '$math.atan2': '$math.atan2_2', '$math.hypot': '$math.hypot_2',   // 2-arg; bit-exact extract/repack
  '$math.cbrt': '$math.cbrt_v', '$math.fifthroot': '$math.fifthroot_v',   // 1-arg; per-lane scalar repack
  '$math.pow_fold': '$math.pow_fold_v',   // 2-arg (x, c); only reachable under optimize.crPow — see module/math.js
  // log/exp/exp2: TRUE f64x2 polys — both lanes one evaluation (≈2×, beats V8 native log). Bit-exact
  // via hot-path-vectorized + scalar-edge-fallback ($math.log_v/exp_v/exp2_v, module/math.js).
  '$math.log': '$math.log_v', '$math.exp': '$math.exp_v', '$math.exp2': '$math.exp2_v',
}

// Transcendentals the auto-vectorizer bridges to f64x2 mirrors — BOTH the scalar sources (kept
// intact in the vectorized loop's scalar tail) AND the f64x2 mirrors themselves (the calls the
// SIMD path emits). jz passes this to watOptimize's `pin` option so watr's inliner dissolves
// NEITHER: the scalar tail keeps calling `$math.cbrt` and the SIMD body keeps calling
// `$math.cbrt_v` (inlining the small per-lane repack mirror would erase the vectorized call the
// lift produced). The protection policy lives here in jz, not hardcoded in watr.
export const SIMD_PINNED = [...new Set([...Object.keys(PPC_CALL2), ...Object.values(PPC_CALL2)])]

// Per-pixel-color vectorizer. The dual of tryDivergentEscapeVectorize for kernels with NO inner
// escape loop: an outer pixel loop whose body computes an f64 value from the pixel index (via
// cos/sin/sqrt/…), packs it to a u32 colour, and stores it — every pixel independent. We lift the
// liftable f64 PREFIX of the body to f64x2 (two adjacent pixels per lane: the index becomes the
// ramp [x, x+1]; transcendentals map to the bit-exact $math.*2 helpers; conditionals to bitselect),
// then run the SCALAR pack+store once per lane (extract_lane → the original f64 local → the
// untouched integer pack). The expensive transcendentals run 2-wide; the cheap pack stays scalar.
// Bit-exact by construction: f64x2 arithmetic is per-lane IEEE-identical and extract_lane is exact.
// A call we can't yet vectorize (pow in Phase 1) just ends the SIMD prefix — its lane local and the
// rest fall to the scalar epilogue, so the kernel still partially vectorizes. The original scalar
// loop, re-run as the tail, finishes the odd last pixel for free (its own `x < W` guard).
function tryPerPixelColor(blockNode, fnLocals, freshIdRef, pureFuncMap) {
  // Outer per-pixel scaffold — shared with tryDivergentEscapeVectorize; this pass
  // takes the straight-line-body branch (no inner escape loop) below.
  const outer = matchOuterPixelLoop(blockNode)
  if (!outer) return null
  const { oLabel, loopNode, preamble, pixelIVs, pxVar, widthBound, pivType, obody, oExit } = outer

  // ---- body: straight-line (no inner escape loop), no impure call ----
  for (const s of obody)
    if (isArr(s) && s[0] === 'block' && s.slice(1).some(c => isArr(c) && c[0] === 'loop')) return null  // inner escape loop → tryDivergentEscapeVectorize's job
  // A non-pure call (e.g. a ray-march helper that writes a scratch global / memory) can mutate state
  // that a lane local — computed ONCE, before the per-lane epilogue runs the call — would then read
  // stale, breaking bit-exactness. $math.* helpers are pure (no global/memory writes), so allow them.
  // Pure user-defined functions in pureFuncMap are also safe: they have no side effects (verified
  // when the map is built) and liftPPC inlines them expression-level rather than emitting a call.
  const impureCall = (n) => isArr(n) && ((n[0] === 'call' && typeof n[1] === 'string' && !n[1].startsWith('$math.') && !(pureFuncMap && pureFuncMap.has(n[1]))) || n.some(impureCall))
  if (obody.some(impureCall)) return null

  // bump: substitute every pixel IV with (IV + k) in its own type — for the lane-k epilogue.
  const bump = (n, k) => k === 0 ? n
    : (isArr(n) && n[0] === 'local.get' && pivType.has(n[1]))
      ? [pivType.get(n[1]) + '.add', n, [pivType.get(n[1]) + '.const', k]]
      : (isArr(n) ? n.map(c => bump(c, k)) : n)

  // Pixel-coordinate aliases: a local consistently CSE'd to `convert_i32_s(pixelIV)` (jz tees the f64
  // pixel-x once — reused for the store address AND the per-pixel math — so it lives inside the i32
  // offset stmt, out of reach as a lane local). Treat its reads as the ramp, recomputed per lane.
  const pxAlias = new Map()
  {
    const defs = new Map()
    const scan = (n) => { if (!isArr(n)) return; if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') { (defs.get(n[1]) || defs.set(n[1], []).get(n[1])).push(n[2]) } for (let i = 1; i < n.length; i++) scan(n[i]) }
    obody.forEach(scan)
    for (const [name, rhss] of defs) {
      const j = JSON.stringify(rhss[0])
      if (!rhss.every(r => JSON.stringify(r) === j)) continue   // multiple distinct defs → not a stable alias
      const r = rhss[0]
      if (isArr(r) && r[0] === 'f64.convert_i32_s' && isArr(r[1]) && r[1][0] === 'local.get' && pivType.get(r[1][1]) === 'i32') pxAlias.set(name, r[1][1])
      else if (isArr(r) && r[0] === 'local.get' && pivType.get(r[1]) === 'f64') pxAlias.set(name, r[1])
    }
  }
  // The two lanes of a pixel IV (or its alias): [v, v+1], in f64 (an i32 IV is converted per lane).
  const rampOf = (piv) => pivType.get(piv) === 'f64'
    ? ['f64x2.replace_lane', 1, ['f64x2.splat', ['local.get', piv]], ['f64.add', ['local.get', piv], ['f64.const', 1]]]
    : ['f64x2.replace_lane', 1, ['f64x2.splat', ['f64.convert_i32_s', ['local.get', piv]]], ['f64.convert_i32_s', ['i32.add', ['local.get', piv], ['i32.const', 1]]]]

  const id = freshIdRef.next++
  const nm = (s) => `$__ppc${id}_${s}`
  const laneMap = new Map()       // f64 lane-local name → its v128 shadow
  const laneLifted = new Map()    // f64 lane-local name → its lifted f64x2 expr

  // Inline a pure user function call into a lifted f64x2 expression.
  // `callNode` is ['call', '$name', arg0, arg1, ...]; `outerLift` is the liftPPC fn.
  // Walks the callee's body, substituting params with lifted args and inlined-local
  // intermediates. Returns null if any step fails (bail → scalar epilogue).
  // SOUND: only called when callee is in pureFuncMap (no stores/global.sets/impure
  // calls); param names are read-only in the inlinee body (verified below).
  const liftPPCInline = (callNode, outerLift) => {
    const callee = pureFuncMap.get(callNode[1])
    if (!callee) return null
    const calleeBodyStart = findBodyStart(callee)
    if (calleeBodyStart < 0) return null

    // Collect callee params in order.
    const calleeParams = []
    for (let i = 2; i < calleeBodyStart; i++) {
      const d = callee[i]
      if (isArr(d) && d[0] === 'param' && typeof d[1] === 'string') calleeParams.push(d[1])
    }
    // Args supplied by the call site (call node children after the name).
    const callArgs = callNode.slice(2)
    if (callArgs.length !== calleeParams.length) return null

    // Lift each arg with the outer liftPPC.
    const substMap = new Map()
    for (let i = 0; i < calleeParams.length; i++) {
      const lifted = outerLift(callArgs[i])
      if (lifted === null) return null
      substMap.set(calleeParams[i], lifted)
    }

    // Verify no local.set on a param name inside the callee body (params are read-only).
    for (const pname of calleeParams) {
      if (writesName(callee.slice(calleeBodyStart), pname)) return null
    }

    // liftInline: lift a callee-body expression using substMap (params + inlined locals).
    // Handles f64.const, local.get from substMap, LANE_PURE.f64 ops, and PPC_CALL2 calls.
    // Returns null on any unsupported node.
    const liftInline = (n) => {
      if (!isArr(n)) return null
      const op = n[0]
      if (op === 'f64.const') return ['f64x2.splat', n]
      if (op === 'local.get' && typeof n[1] === 'string') {
        return substMap.has(n[1]) ? substMap.get(n[1]) : null
      }
      if (op === 'call') {
        const v2 = PPC_CALL2[n[1]]
        if (v2 && n.length === 3) { const a = liftInline(n[2]); return a && ['call', v2, a] }
        if (v2 && n.length === 4) { const a = liftInline(n[2]), b = liftInline(n[3]); return (a && b) ? ['call', v2, a, b] : null }
        return null
      }
      if (LANE_PURE.f64.has(op)) {
        const ks = n.slice(1).map(liftInline)
        return ks.some(k => k === null) ? null : [LANE_PURE.f64.get(op).simd, ...ks]
      }
      return null
    }

    // Walk callee body: local.set stmts define inlined locals; return stmt gives result.
    for (let i = calleeBodyStart; i < callee.length; i++) {
      const stmt = callee[i]
      if (!isArr(stmt)) return null
      if (stmt[0] === 'local.set' && typeof stmt[1] === 'string') {
        const lifted = liftInline(stmt[2])
        if (lifted === null) return null
        substMap.set(stmt[1], lifted)
        continue
      }
      if (stmt[0] === 'return') {
        return liftInline(stmt[1])
      }
      // Any other statement type → bail (impure or unsupported structure).
      return null
    }
    return null  // no return stmt found
  }

  // Lift a scalar f64 expression to f64x2: pixel IV → ramp [v, v+1]; an earlier lane local → its
  // shadow; an invariant (local/global the loop never writes) → splat; transcendental call → the
  // *2 helper; conditional → bitselect; LANE_PURE.f64 op → recurse. null = not liftable (the lift
  // stops here and the rest becomes the scalar epilogue).
  const liftPPC = (n) => {
    if (!isArr(n)) return null
    const op = n[0]
    if (op === 'f64.const') return ['f64x2.splat', n]
    if (op === 'local.get') {
      const v = n[1]
      if (laneMap.has(v)) return ['local.get', laneMap.get(v)]
      if (pxAlias.has(v)) return rampOf(pxAlias.get(v))
      if (pivType.get(v) === 'f64') return rampOf(v)
      if (writesName(loopNode, v)) return null
      return ['f64x2.splat', n]
    }
    if (op === 'local.tee') {   // CSE temp inside a lane expr (e.g. `dx` reused as dx*dx) → a v128 tee
      const lifted = liftPPC(n[2])
      if (lifted === null) return null
      const lane = laneMap.get(n[1]) || nm('t' + n[1].replace(/\W/g, ''))
      laneMap.set(n[1], lane)   // later local.get $v in this expr resolves to the tee's lane
      return ['local.tee', lane, lifted]
    }
    if (op === 'global.get') return writesName(loopNode, n[1]) ? null : ['f64x2.splat', n]
    if (op === 'f64.convert_i32_s' && isArr(n[1]) && n[1][0] === 'local.get' && pivType.get(n[1][1]) === 'i32') return rampOf(n[1][1])
    if (op === 'call') {
      const v2 = PPC_CALL2[n[1]]
      if (v2 && n.length === 3) { const a = liftPPC(n[2]); return a && ['call', v2, a] }
      if (v2 && n.length === 4) { const a = liftPPC(n[2]), b = liftPPC(n[3]); return (a && b) ? ['call', v2, a, b] : null }
      // Pure user-function inline: substitute params with lifted args, walk body.
      if (pureFuncMap && pureFuncMap.has(n[1])) return liftPPCInline(n, liftPPC)
      return null
    }
    if (op === 'if') {   // `cond ? X : Y` (jz lowers to (if (result f64) COND (then X)(else Y))) → bitselect
      if (!isArr(n[1]) || n[1][0] !== 'result' || n[1][1] !== 'f64') return null
      const thenN = n[3], elseN = n[4]
      if (!isArr(thenN) || thenN[0] !== 'then' || thenN.length !== 2) return null
      if (!isArr(elseN) || elseN[0] !== 'else' || elseN.length !== 2) return null
      let cond = n[2]
      if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
      const cmp = isArr(cond) && cond.length === 3 ? CMP_LANE[cond[0]] : null
      if (!cmp) return null
      const ca = liftPPC(cond[1]), cb = liftPPC(cond[2]), x = liftPPC(thenN[1]), y = liftPPC(elseN[1])
      if (!ca || !cb || !x || !y) return null
      return ['v128.bitselect', x, y, [cmp, ca, cb]]
    }
    if (LANE_PURE.f64.has(op)) {
      const ks = n.slice(1).map(liftPPC)
      return ks.some(k => k === null) ? null : [LANE_PURE.f64.get(op).simd, ...ks]
    }
    return null
  }

  // Classify each body statement: a `local.set $v EXPR` with v an f64 whose EXPR fully lifts is a
  // SIMD lane local (computed once per pair); everything else (the integer pack, the store, an
  // un-liftable call like pow in Phase 1, a recomputed i32 offset) is a scalar EPILOGUE statement,
  // re-run per lane. Lane locals need NOT be a contiguous prefix — `offset = w*y+x` (i32) commonly
  // precedes the f64 work. Processed in source order so a lane local can reference an earlier one;
  // liftPPC returns null on a read of any in-loop value that isn't already a lane local (incl. a
  // later or epilogue local), so the classification self-enforces "lane locals depend only on
  // IVs/invariants/earlier lane locals" — reordering all lane computes ahead of the epilogue is safe.
  const epilogue = []
  for (const s of obody) {
    if (isArr(s) && s[0] === 'local.set' && s.length === 3 && fnLocals.get(s[1]) === 'f64') {
      const before = new Set(laneMap.keys())
      const lifted = liftPPC(s[2])
      if (lifted !== null) { laneMap.set(s[1], nm('l' + s[1].replace(/\W/g, ''))); laneLifted.set(s[1], lifted); continue }
      for (const k of [...laneMap.keys()]) if (!before.has(k)) laneMap.delete(k)   // roll back tee pollution from a failed lift
    }
    epilogue.push(s)
  }
  if (!laneMap.size) return null   // nothing lifted to f64x2
  // HAZARD: a lane local re-written by an epilogue statement leaves its f64x2 shadow STALE.
  // e.g. `let fx=0; if(denom>ε){fx=…}; let mag=hypot(fx,…)` — `fx=0` lifts to a lane local
  // splat(0); the statement-form `if` lands in the scalar epilogue (updates only the SCALAR local),
  // so the lifted `hypot(fx,…)` — emitted BEFORE the epilogue — reads the stale splat(0) → all-zero.
  // Bail ONLY when the stale shadow actually feeds another LANE compute: a lane local whose shadow
  // is CONSUMED by some laneLifted expr and is ALSO reassigned in the epilogue. (A lane local merely
  // extracted for the scalar epilogue — e.g. `gv`, clamped by `if(gv<0)gv=0` then packed — is safe:
  // the clamp runs per-lane after extraction, corrupting no other lane.)
  {
    const consumedShadows = new Set()
    const scanShadow = (n) => { if (!isArr(n)) return; if (n[0] === 'local.get' && typeof n[1] === 'string') consumedShadows.add(n[1]); for (const c of n.slice(1)) scanShadow(c) }
    for (const expr of laneLifted.values()) scanShadow(expr)
    const hazard = (n) => isArr(n) && (((n[0] === 'local.set' || n[0] === 'local.tee') && laneMap.has(n[1]) && consumedShadows.has(laneMap.get(n[1]))) || n.slice(1).some(hazard))
    if (epilogue.some(hazard)) return null
  }
  // Only worth the extract overhead if a costly op (a *2 transcendental or f64x2.sqrt) got lifted.
  const heavy = (n) => isArr(n) && ((n[0] === 'call' && /\$math\.(sin2|cos2|pow2|log_v|atan2_2|hypot_2|exp2_2|tan2)/.test(n[1])) || n[0] === 'f64x2.sqrt' || n.some(heavy))
  if (![...laneLifted.values()].some(heavy)) return null   // only cheap arithmetic lifted — not worth it

  // Exactly one i32.store, found anywhere in the epilogue (jz wraps `mem[off]=…` in a `(block …)`).
  let storeStmt = null
  const findStore = (n) => { if (!isArr(n)) return; if (STORE_OPS[n[0]]) { if (storeStmt) storeStmt = false; else if (storeStmt !== false) storeStmt = n } for (const c of n) findStore(c) }
  epilogue.forEach(findStore)
  if (!storeStmt || storeStmt[0] !== 'i32.store') return null   // not exactly one u32 colour store
  // The store cell must differ per lane, i.e. its address must depend on a pixel IV — directly
  // (chladni's `px[j]`) or transitively through an epilogue local (interference's `mem[offset]`,
  // offset=w*y+x). Follow the address's reads through epilogue local definitions to a pixel IV.
  // Walk every child except a set's name slot (a def nested under an `(if … then)` must still be
  // recorded — the n.slice(2)-everywhere form would miss it, conservatively bailing a valid kernel).
  const epiDef = new Map()
  const collect = (n) => { if (!isArr(n)) return; if (n[0] === 'local.set' && typeof n[1] === 'string' && !epiDef.has(n[1])) epiDef.set(n[1], n[2]); for (const c of (n[0] === 'local.set' ? n.slice(2) : n.slice(1))) collect(c) }
  epilogue.forEach(collect)
  const feedsIV = (n, seen = new Set()) => isArr(n) && (n[0] === 'local.get'
    ? (pivType.has(n[1]) || (epiDef.has(n[1]) && !seen.has(n[1]) && (seen.add(n[1]), feedsIV(epiDef.get(n[1]), seen))))
    : n.some(c => feedsIV(c, seen)))
  if (!feedsIV(storeStmt[1])) return null   // store cell wouldn't vary per lane → can't pair

  // ---- epilogue safety: runs scalar per lane (each statement bumped to pixel j+k). It may read a
  // lane local (extracted below), an invariant/pixel-IV, or a value the epilogue itself computes —
  // incl. within-statement tees (e.g. the Infinity-guard temp inside an `(if … |0)` pack). Straight-
  // line source guarantees write-before-read, so it suffices that every read of an in-loop local is
  // a lane local or written somewhere in the epilogue (a lane local read is satisfied by extraction). ----
  {
    const epiWritten = new Set()
    const wr = (n) => { if (!isArr(n)) return; const st = (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string'; if (st) epiWritten.add(n[1]); for (const c of (st ? n.slice(2) : n.slice(1))) wr(c) }
    epilogue.forEach(wr)
    const reads = new Set(); const rd = (n) => { if (!isArr(n)) return; if (n[0] === 'local.get') reads.add(n[1]); else for (const c of n) rd(c) }
    epilogue.forEach(rd)
    for (const v of reads) if (writesName(loopNode, v) && !laneMap.has(v) && !epiWritten.has(v) && !pivType.has(v)) return null   // reads an in-loop value with no per-lane source
  }
  const epiReads = [...laneMap.keys()].filter(v => epilogue.some(s => readsVar(s, v)))

  // ============================ emit ============================
  const newLocalDecls = [...laneMap.values()].map(n => ['local', n, 'v128'])
  const laneCompute = [...laneLifted.keys()].map(v => ['local.set', laneMap.get(v), laneLifted.get(v)])
  const epiLane = (k) => [
    ...epiReads.map(v => ['local.set', v, ['f64x2.extract_lane', k, ['local.get', laneMap.get(v)]]]),
    ...epilogue.map(s => bump(s, k)),
  ]
  const sOut = nm('ob'), sOl = nm('ol')
  const simdOuter = ['block', sOut, ['loop', sOl,
    ['br_if', sOut, ['i32.eqz', [oExit.cmpOp, bump(['local.get', pxVar], 1), widthBound]]],
    ...laneCompute, ...epiLane(0), ...epiLane(1),
    ...pixelIVs.map(p => ['local.set', p.name, [p.type + '.add', ['local.get', p.name], [p.type + '.const', 2]]]),
    ['br', sOl]]]
  const wrapper = ['block', nm('w'), ...preamble, simdOuter, ['block', oLabel, loopNode]]
  return { wrapper, newLocalDecls }
}

// ---- Outer-loop strip-mine over an inner reduction (tryOuterStrip, experimental) ----
//
// The dual of tryPerPixelColor for pixel loops whose per-pixel value comes from an
// INNER REDUCTION over invariant data — metaballs `sum += r²/((cx-bx[b])²+(cy-by[b])²+ε)`,
// voronoi/lyapunov shapes. Strip-mine the OUTER pixel loop 2-wide: pixels (xi, xi+1) →
// f64x2 lanes. The per-pixel coordinate (`cx = xi/W`) becomes a ramp `[cx, cx+1/W]`; the
// inner loop's loads `bx[b]` are indexed by the INNER IV (same for both pixels) → splat;
// the accumulator `sum` becomes an f64x2 carrying both lanes' running sums. After the inner
// loop, each lane's sum is extracted and the scalar pack+store runs per lane (xi, xi+1).
//
// BIT-EXACT: each lane accumulates in the SAME scalar order as the original (f64x2.add is
// per-lane IEEE-754-identical) — a per-lane reduction reorders nothing, unlike a horizontal
// fold. The inner loop's trip count (b < count) is invariant, so its scaffold stays scalar;
// only the f64 body lifts. Distinct base subtrees assumed non-aliasing (the standing model).
// Gated behind cfg.experimentalOuterStrip until proven across the corpus.
function tryOuterStrip(blockNode, fnLocals, freshIdRef, enabled) {
  if (!enabled) return null
  const outer = matchOuterPixelLoop(blockNode)
  if (!outer) return null
  const { oLabel, loopNode, preamble, pixelIVs, pxVar, widthBound, pivType, obody, oExit } = outer

  // Exactly one inner loop in obody; it is the per-pixel reduction.
  let innerIdx = -1, innerBlock = null
  for (let i = 0; i < obody.length; i++) {
    const s = obody[i]
    if (isArr(s) && s[0] === 'block' && s.slice(1).some(c => isArr(c) && c[0] === 'loop')) {
      if (innerBlock) return null
      innerBlock = s; innerIdx = i
    }
  }
  if (!innerBlock) return null
  const ibl = matchBlockLoop(innerBlock, { allowPreamble: true })
  if (!ibl) return null
  if (ibl.preamble.length) return null
  const innerIV = ibl.incVar, ibody = ibl.body
  // No impure calls (a non-pure call would read stale state in the per-lane epilogue). $math.* pure.
  const impureCall = (n) => isArr(n) && ((n[0] === 'call' && typeof n[1] === 'string' && !n[1].startsWith('$math.')) || n.some(impureCall))
  if (obody.some(impureCall)) return null

  const id = freshIdRef.next++
  const nm = (s) => `$__os${id}_${s}`
  const bump = (n, k) => k === 0 ? n
    : (isArr(n) && n[0] === 'local.get' && pivType.has(n[1])) ? [pivType.get(n[1]) + '.add', n, [pivType.get(n[1]) + '.const', k]]
    : (isArr(n) ? n.map(c => bump(c, k)) : n)
  const rampOf = (piv) => pivType.get(piv) === 'f64'
    ? ['f64x2.replace_lane', 1, ['f64x2.splat', ['local.get', piv]], ['f64.add', ['local.get', piv], ['f64.const', 1]]]
    : ['f64x2.replace_lane', 1, ['f64x2.splat', ['f64.convert_i32_s', ['local.get', piv]]], ['f64.convert_i32_s', ['i32.add', ['local.get', piv], ['i32.const', 1]]]]
  const readsName = (n, name) => isArr(n) && ((n[0] === 'local.get' && n[1] === name) || n.some(c => readsName(c, name)))

  const laneMap = new Map()   // f64 lane-local (per-pixel-varying) name → its v128 shadow
  // Lift a scalar f64 expr to f64x2 (null = not liftable). pxVar → ramp; lane local → shadow;
  // pixel-invariant local/global → splat; pixel-invariant f64.load → splat(scalar load);
  // $math.*2 transcendental; cond → bitselect; LANE_PURE.f64 op → recurse.
  const liftOS = (n) => {
    if (!isArr(n)) return null
    const op = n[0]
    if (op === 'f64.const') return ['f64x2.splat', n]
    if (op === 'local.get') {
      const v = n[1]
      if (laneMap.has(v)) return ['local.get', laneMap.get(v)]
      if (pivType.get(v) === 'f64') return rampOf(v)
      if (writesName(loopNode, v)) return null
      return ['f64x2.splat', n]
    }
    if (op === 'f64.convert_i32_s' && isArr(n[1]) && n[1][0] === 'local.get' && pivType.get(n[1][1]) === 'i32') return rampOf(n[1][1])
    if (op === 'global.get') return writesName(loopNode, n[1]) ? null : ['f64x2.splat', n]
    if (LOAD_OPS[op] === 'f64') {
      // pixel-invariant load (address reads neither the pixel IV nor any per-pixel lane) is the
      // same value for both lanes → load once, splat. A per-pixel gather is not supported.
      const addr = typeof n[1] === 'string' && n[1].startsWith('offset=') ? n[2] : n[1]
      if (readsName(addr, pxVar) || [...laneMap.keys()].some(lv => readsName(addr, lv))) return null
      return ['f64x2.splat', n]
    }
    if (op === 'call') {
      const v2 = PPC_CALL2[n[1]]
      if (v2 && n.length === 3) { const a = liftOS(n[2]); return a && ['call', v2, a] }
      if (v2 && n.length === 4) { const a = liftOS(n[2]), b = liftOS(n[3]); return (a && b) ? ['call', v2, a, b] : null }
      return null
    }
    if (op === 'if') {
      if (!isArr(n[1]) || n[1][0] !== 'result' || n[1][1] !== 'f64') return null
      const thenN = n[3], elseN = n[4]
      if (!isArr(thenN) || thenN[0] !== 'then' || thenN.length !== 2) return null
      if (!isArr(elseN) || elseN[0] !== 'else' || elseN.length !== 2) return null
      let cond = n[2]
      if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
      const cmp = isArr(cond) && cond.length === 3 ? CMP_LANE[cond[0]] : null
      if (!cmp) return null
      const ca = liftOS(cond[1]), cb = liftOS(cond[2]), x = liftOS(thenN[1]), y = liftOS(elseN[1])
      if (!ca || !cb || !x || !y) return null
      return ['v128.bitselect', x, y, [cmp, ca, cb]]
    }
    if (LANE_PURE.f64.has(op)) {
      const ks = n.slice(1).map(liftOS)
      return ks.some(k => k === null) ? null : [LANE_PURE.f64.get(op).simd, ...ks]
    }
    return null
  }

  // ---- lift the inner loop body: temp f64 lane locals + f64 accumulator(s) `acc = acc + EXPR`,
  // the inner IV bump stays scalar. Anything else (or an unliftable expr) → bail. ----
  // Pre-scan: f64 accumulators `acc = acc + EXPR`. Assign their f64x2 shadows up front so laneInit
  // can seed them and the lift can accumulate into them (order-independent of the inner body).
  const accNames = new Set()
  for (const s of ibody) {
    if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3)) continue
    const name = s[1], rhs = s[2]
    if (fnLocals.get(name) !== 'f64' || !isArr(rhs) || rhs[0] !== 'f64.add') continue
    const addend = isLocalGet(rhs[1], name) ? rhs[2] : isLocalGet(rhs[2], name) ? rhs[1] : null
    if (addend != null && !readsName(addend, name)) { accNames.add(name); laneMap.set(name, nm('acc' + name.replace(/\W/g, ''))) }
  }
  if (!accNames.size) return null

  // ---- pre-inner-loop stmts (obody[<innerIdx]): per-pixel coord lanes (cx = f(xi) → ramp),
  // accumulator seeds (→ splat), scalar inner-IV init. MUST run before the inner-body lift so the
  // per-pixel coord lanes are registered when the inner loop references them. ----
  const laneInit = []
  const seededAccs = new Set()
  for (let i = 0; i < innerIdx; i++) {
    const s = obody[i]
    if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3)) { laneInit.push(s); continue }
    const name = s[1]
    if (accNames.has(name)) {                       // accumulator seed → splat
      // The seed must be a FRESH per-pixel value, independent of the accumulator's own carry.
      // A seed that reads `name` (e.g. `acc = acc * decay`) propagates the previous pixel's
      // running value across pixels — that's a loop-carried recurrence, not a per-pixel reset.
      if (readsName(s[2], name)) return null
      const seed = liftOS(s[2])
      if (!seed) return null
      seededAccs.add(name)
      laneInit.push(['local.set', laneMap.get(name), seed]); continue
    }
    if (fnLocals.get(name) === 'f64' && readsName(s[2], pxVar)) {   // per-pixel coord (cx = xi/W) → ramp lane
      const lane = liftOS(s[2])
      if (!lane) return null
      const sh = nm('p' + name.replace(/\W/g, ''))
      laneMap.set(name, sh)
      laneInit.push(['local.set', sh, lane]); continue
    }
    laneInit.push(s)                                // scalar (inner IV init `b=0`, invariant setup)
  }

  // LEGALITY: every accumulator must be FRESHLY SEEDED inside the outer-loop body. An accumulator
  // with no per-pixel seed is live-in — carried across outer iterations (a recurrence like the
  // lorenz `x = x + S·(…)` evolving over the sample loop). The two pixel lanes are then DEPENDENT:
  // lane xi+1 must continue from lane xi's final value, not restart from a splat of the shared
  // carry. Strip-mining it runs both lanes from the same seed in lockstep — halving the real work
  // and producing a wrong result (a bogus speedup on a serial recurrence). Reject.
  for (const a of accNames) if (!seededAccs.has(a)) return null

  // ---- lift the inner-loop body: temp f64 lane locals + accumulate into the acc shadows; the
  // inner IV bump stays scalar. Per-pixel coords now resolve via laneMap. ----
  const liftedInner = []
  for (const s of ibody) {
    if (matchInc1(s) === innerIV || matchIncN(s)?.name === innerIV) { liftedInner.push(s); continue }
    if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3)) return null
    const name = s[1], rhs = s[2]
    if (fnLocals.get(name) !== 'f64') return null
    if (accNames.has(name)) {
      const addend = isLocalGet(rhs[1], name) ? rhs[2] : rhs[1]
      const lifted = liftOS(addend)
      if (!lifted) return null
      liftedInner.push(['local.set', laneMap.get(name), ['f64x2.add', ['local.get', laneMap.get(name)], lifted]]); continue
    }
    if (readsName(rhs, name)) return null   // loop-carried non-accumulator → bail
    const lifted = liftOS(rhs)
    if (!lifted) return null
    const sh = laneMap.get(name) || nm('t' + name.replace(/\W/g, ''))
    laneMap.set(name, sh)
    liftedInner.push(['local.set', sh, lifted])
  }

  // ---- epilogue (obody[>innerIdx]): the per-pixel pack+store, run scalar per lane (bumped to xi+k),
  // reading the extracted accumulator/lane values. Safety: every in-loop read must be a lane local,
  // a pixel IV, or written within the epilogue itself. ----
  const epilogue = obody.slice(innerIdx + 1)
  {
    const epiWritten = new Set()
    const wr = (n) => { if (!isArr(n)) return; const st = (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string'; if (st) epiWritten.add(n[1]); for (const c of (st ? n.slice(2) : n.slice(1))) wr(c) }
    epilogue.forEach(wr)
    const reads = new Set(); const rd = (n) => { if (!isArr(n)) return; if (n[0] === 'local.get') reads.add(n[1]); else for (const c of n) rd(c) }
    epilogue.forEach(rd)
    for (const v of reads) if (writesName(loopNode, v) && !laneMap.has(v) && !epiWritten.has(v) && !pivType.has(v)) return null
  }
  // store must exist + vary per lane
  let hasStore = false
  const findStore = (n) => { if (!isArr(n)) return; if (STORE_OPS[n[0]]) hasStore = true; n.forEach(findStore) }
  epilogue.forEach(findStore)
  if (!hasStore) return null

  // ============================ emit ============================
  const newLocalDecls = [...new Set(laneMap.values())].map(n => ['local', n, 'v128'])
  const epiReads = [...laneMap.keys()].filter(v => epilogue.some(s => readsVar(s, v)))
  // Rebuild the inner loop with its scalar scaffold (exit + the bottom IV bump, which lives at
  // loopNode[incIdx] — NOT in `body`) and the lifted f64x2 body in between.
  const innerLoopNode = ibl.loopNode
  const iExit = innerLoopNode[2]                       // (br_if iBrk (eqz (b < count)))
  const iInc = innerLoopNode[ibl.incIdx]               // (local.set b (i32.add b 1)) — scalar, kept
  const iLabelB = innerBlock[1], iLabelL = innerLoopNode[1]
  const innerSimd = ['block', iLabelB, ['loop', iLabelL, iExit, ...liftedInner, iInc, ['br', iLabelL]]]
  const laneCompute = [...laneInit, innerSimd]
  const epiLane = (k) => [
    ...epiReads.map(v => ['local.set', v, ['f64x2.extract_lane', k, ['local.get', laneMap.get(v)]]]),
    ...epilogue.map(s => bump(s, k)),
  ]
  const sOut = nm('ob'), sOl = nm('ol')
  const simdOuter = ['block', sOut, ['loop', sOl,
    ['br_if', sOut, ['i32.eqz', [oExit.cmpOp, bump(['local.get', pxVar], 1), widthBound]]],
    ...laneCompute, ...epiLane(0), ...epiLane(1),
    ...pixelIVs.map(p => ['local.set', p.name, [p.type + '.add', ['local.get', p.name], [p.type + '.const', 2]]]),
    ['br', sOl]]]
  const wrapper = ['block', nm('w'), ...preamble, simdOuter, ['block', oLabel, loopNode]]
  return { wrapper, newLocalDecls }
}

// ---- Per-pixel iterated-map reduction (tryIteratedReduce, experimental) ----------------------
//
// Generalizes the outer-strip to the ITERATED-MAP fractal shape — lyapunov, bifurcation, smooth-
// escape attractors — whose per-pixel value runs a recurrence many times and accumulates a
// transcendental. Beyond tryOuterStrip (one inner loop, a plain additive accumulator) it handles:
//   • MULTIPLE inner loops carrying per-pixel f64 state between them (lyapunov warmup → accumulate),
//   • loop-carried f64 RECURRENCES   x = r·x·(1−x)   (not just acc = acc + …),
//   • lane-invariant scalar bookkeeping kept SCALAR — integer counters with wraparound and the
//     forcing-sequence gather seq[si] (same index for both lanes → one scalar load),
//   • a scalar-condition select   seq[si]<1 ? a : b   (a ramps per lane, b splats) → a scalar
//     `if (result v128)`, and a per-lane conditional accumulate   if(d>0) L += log(d)   → bitselect.
// Two adjacent pixels (xi, xi+1) run as f64x2 lanes; the colour pack+store runs scalar per lane,
// and the original scalar loop, kept as the tail, finishes the odd last pixel.
//
// BIT-EXACT: f64x2 arithmetic is per-lane IEEE-identical, $math.log_v/exp_v are the per-lane mirrors
// of the scalar polys, and the conditional accumulate adds bitselect(f(x), 0, mask) — exactly the
// scalar add-or-skip. The speculatively-evaluated transcendental of a masked-out lane is discarded
// (the helpers never trap). Gated behind cfg.experimentalOuterStrip; only fires when an inner loop
// carries a transcendental (the latency-bound work SIMD actually accelerates — cheap-arithmetic
// pixel loops are left to the scalar JIT, which already pipelines independent iterations).
function tryIteratedReduce(blockNode, fnLocals, freshIdRef, enabled) {
  if (!enabled) return null
  const outer = matchOuterPixelLoop(blockNode)
  if (!outer) return null
  const { oLabel, loopNode, preamble, pixelIVs, pxVar, widthBound, pivType, obody, oExit } = outer

  const innerIdxs = []
  for (let i = 0; i < obody.length; i++) {
    const s = obody[i]
    if (isArr(s) && s[0] === 'block' && s.slice(1).some(c => isArr(c) && c[0] === 'loop')) innerIdxs.push(i)
  }
  if (!innerIdxs.length) return null
  const lastInner = innerIdxs[innerIdxs.length - 1]
  const innerSet = new Set(innerIdxs)

  const impureCall = (n) => isArr(n) && ((n[0] === 'call' && typeof n[1] === 'string' && !n[1].startsWith('$math.')) || n.some(impureCall))
  if (obody.some(impureCall)) return null

  const id = freshIdRef.next++
  const nm = (s) => `$__ir${id}_${s}`
  const laneMap = new Map()       // f64 per-pixel local → its v128 shadow
  const shadowOf = (v) => { let s = laneMap.get(v); if (!s) { s = nm(v.replace(/\W/g, '')); laneMap.set(v, s) } return s }
  let sawHeavy = false            // a transcendental lifted inside a loop → SIMD is worth it

  const bump = (n, k) => k === 0 ? n
    : (isArr(n) && n[0] === 'local.get' && pivType.has(n[1])) ? [pivType.get(n[1]) + '.add', n, [pivType.get(n[1]) + '.const', k]]
    : (isArr(n) ? n.map(c => bump(c, k)) : n)
  const rampOf = (piv) => pivType.get(piv) === 'f64'
    ? ['f64x2.replace_lane', 1, ['f64x2.splat', ['local.get', piv]], ['f64.add', ['local.get', piv], ['f64.const', 1]]]
    : ['f64x2.replace_lane', 1, ['f64x2.splat', ['f64.convert_i32_s', ['local.get', piv]]], ['f64.convert_i32_s', ['i32.add', ['local.get', piv], ['i32.const', 1]]]]
  const readsName = (n, name) => isArr(n) && ((n[0] === 'local.get' && n[1] === name) || n.some(c => readsName(c, name)))
  // Lane-invariant: reads no per-pixel lane local and no pixel IV → identical value in both lanes.
  const laneInvariant = (n) => !isArr(n) ? true
    : n[0] === 'local.get' ? !(laneMap.has(n[1]) || pivType.has(n[1]))
    : n.slice(1).every(laneInvariant)

  // Build the f64x2 form of `cond ? x : y` from already-lifted arms `x`,`y` and the raw `cond`.
  // A lane-INVARIANT cond (same both lanes — e.g. seq[si]<1) → a v128-typed scalar branch; a
  // per-lane f64 compare → bitselect (x where cond, y elsewhere).
  const liftSelect = (x, y, cond) => {
    if (!x || !y) return null
    if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
    if (laneInvariant(cond)) return ['if', ['result', 'v128'], cond, ['then', x], ['else', y]]
    const cmp = isArr(cond) && cond.length === 3 ? CMP_LANE[cond[0]] : null
    if (!cmp) return null
    const ca = lift(cond[1]), cb = lift(cond[2])
    return (ca && cb) ? ['v128.bitselect', x, y, [cmp, ca, cb]] : null
  }
  // Lift an f64 expression to f64x2 (null = not liftable).
  const lift = (n) => {
    if (!isArr(n)) return null
    const op = n[0]
    if (op === 'f64.const') return ['f64x2.splat', n]
    if (op === 'local.get') {
      const v = n[1]
      if (laneMap.has(v)) return ['local.get', laneMap.get(v)]
      if (pivType.get(v) === 'f64') return rampOf(v)
      if (writesName(loopNode, v)) return null
      return ['f64x2.splat', n]
    }
    if (op === 'f64.convert_i32_s' && isArr(n[1]) && n[1][0] === 'local.get' && pivType.get(n[1][1]) === 'i32') return rampOf(n[1][1])
    if (op === 'global.get') return writesName(loopNode, n[1]) ? null : ['f64x2.splat', n]
    if (LOAD_OPS[op] === 'f64') {
      const addr = typeof n[1] === 'string' && n[1].startsWith('offset=') ? n[2] : n[1]
      if (readsName(addr, pxVar) || [...laneMap.keys()].some(lv => readsName(addr, lv))) return null   // per-lane gather: unsupported
      return ['f64x2.splat', n]
    }
    if (op === 'call') {
      const v2 = PPC_CALL2[n[1]]
      if (!v2) return null
      if (n.length === 3) { const a = lift(n[2]); if (!a) return null; sawHeavy = true; return ['call', v2, a] }
      if (n.length === 4) { const a = lift(n[2]), b = lift(n[3]); if (!a || !b) return null; sawHeavy = true; return ['call', v2, a, b] }
      return null
    }
    if (op === 'if') {
      if (!isArr(n[1]) || n[1][0] !== 'result' || n[1][1] !== 'f64') return null
      const thenN = n[3], elseN = n[4]
      if (!isArr(thenN) || thenN[0] !== 'then' || thenN.length !== 2) return null
      if (!isArr(elseN) || elseN[0] !== 'else' || elseN.length !== 2) return null
      let cond = n[2]
      if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
      return liftSelect(lift(thenN[1]), lift(elseN[1]), cond)
    }
    // jz lowers `cond ? A : B` to a `select` (A if cond else B). Same two cases as the `if` form:
    // lane-invariant cond → a scalar v128-typed branch; per-lane f64 compare → bitselect.
    if (op === 'select' && n.length === 4) return liftSelect(lift(n[1]), lift(n[2]), n[3])
    if (LANE_PURE.f64.has(op)) {
      const ks = n.slice(1).map(lift)
      return ks.some(k => k === null) ? null : [LANE_PURE.f64.get(op).simd, ...ks]
    }
    return null
  }

  // Lift one inner-loop body statement → its lifted form(s), or null to bail.
  const liftInnerStmt = (s, innerIV) => {
    if (matchInc1(s) === innerIV || matchIncN(s)?.name === innerIV) return [s]   // IV bump: scalar
    if (isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3) {
      const name = s[1], rhs = s[2]
      if (fnLocals.get(name) !== 'f64') return laneInvariant(rhs) ? [s] : null   // scalar i32 counter
      const lifted = lift(rhs)   // recurrence (rhs reads name) resolves to the shadow — fine
      return lifted ? [['local.set', shadowOf(name), lifted]] : null
    }
    // Lane-invariant scalar `if` (counter wraparound `if(si>=N) si=0`) → keep scalar.
    if (isArr(s) && s[0] === 'if' && laneInvariant(s[1]) &&
        s.slice(2).every(arm => isArr(arm) && (arm[0] === 'then' || arm[0] === 'else') &&
          arm.slice(1).every(st => isArr(st) && st[0] === 'local.set' && fnLocals.get(st[1]) !== 'f64'))) return [s]
    // Per-lane conditional accumulate `if(cond) acc = acc + E` → acc += bitselect(liftE, 0, mask).
    if (isArr(s) && s[0] === 'if' && s.length === 3 && isArr(s[2]) && s[2][0] === 'then' && s[2].length === 2) {
      const st = s[2][1]
      if (isArr(st) && st[0] === 'local.set' && st.length === 3 && fnLocals.get(st[1]) === 'f64' && laneMap.has(st[1]) &&
          isArr(st[2]) && st[2][0] === 'f64.add' && isLocalGet(st[2][1], st[1])) {
        const cond = s[1], cmp = isArr(cond) && cond.length === 3 ? CMP_LANE[cond[0]] : null
        if (!cmp || laneInvariant(cond)) return null   // need a per-lane mask
        const liftE = lift(st[2][2]), ca = lift(cond[1]), cb = lift(cond[2])
        if (!liftE || !ca || !cb) return null
        const sh = laneMap.get(st[1])
        return [['local.set', sh, ['f64x2.add', ['local.get', sh], ['v128.bitselect', liftE, ['f64x2.splat', ['f64.const', 0]], [cmp, ca, cb]]]]]
      }
    }
    return null
  }

  const liftInnerLoop = (block) => {
    const ibl = matchBlockLoop(block, { allowPreamble: true })
    if (!ibl || ibl.preamble.length) return null
    const lifted = []
    for (const s of ibl.body) { const out = liftInnerStmt(s, ibl.incVar); if (!out) return null; lifted.push(...out) }
    return ['block', ibl.blockLabel, ['loop', ibl.loopLabel, ibl.loopNode[2], ...lifted, ibl.loopNode[ibl.incIdx], ['br', ibl.loopLabel]]]
  }

  // ---- laneCompute = obody[0..lastInner]: f64 seeds → shadow lift; scalar seeds kept; loops lifted ----
  const laneCompute = []
  for (let i = 0; i <= lastInner; i++) {
    const s = obody[i]
    if (innerSet.has(i)) { const li = liftInnerLoop(s); if (!li) return null; laneCompute.push(li); continue }
    if (isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3) {
      const name = s[1], rhs = s[2]
      if (fnLocals.get(name) === 'f64') {
        if (readsName(rhs, name)) return null   // self-reading seed = carry across the OUTER loop → reject
        const lifted = lift(rhs); if (!lifted) return null
        laneCompute.push(['local.set', shadowOf(name), lifted])
      } else { if (!laneInvariant(rhs)) return null; laneCompute.push(s) }   // scalar counter seed
      continue
    }
    return null
  }
  if (!sawHeavy || !laneMap.size) return null   // no transcendental reduction → leave to the scalar JIT

  // ---- epilogue = obody[lastInner+1..]: colour pack+store, run scalar per lane ----
  const epilogue = obody.slice(lastInner + 1)
  let hasStore = false
  const findStore = (n) => { if (!isArr(n)) return; if (STORE_OPS[n[0]]) hasStore = true; n.forEach(findStore) }
  epilogue.forEach(findStore)
  if (!hasStore) return null
  const epiWritten = new Set()
  const wr = (n) => { if (!isArr(n)) return; const st = (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string'; if (st) epiWritten.add(n[1]); for (const c of (st ? n.slice(2) : n.slice(1))) wr(c) }
  epilogue.forEach(wr)
  const epiReadSet = new Set(); const rd = (n) => { if (!isArr(n)) return; if (n[0] === 'local.get') epiReadSet.add(n[1]); else for (const c of n) rd(c) }
  epilogue.forEach(rd)
  for (const v of epiReadSet) if (writesName(loopNode, v) && !laneMap.has(v) && !epiWritten.has(v) && !pivType.has(v)) return null
  const epiReads = [...laneMap.keys()].filter(v => epiReadSet.has(v))
  if (!epiReads.length) return null

  // ============================ emit ============================
  const newLocalDecls = [...new Set(laneMap.values())].map(n => ['local', n, 'v128'])
  const epiLane = (k) => [
    ...epiReads.map(v => ['local.set', v, ['f64x2.extract_lane', k, ['local.get', laneMap.get(v)]]]),
    ...epilogue.map(s => bump(s, k)),
  ]
  const sOut = nm('ob'), sOl = nm('ol')
  const simdOuter = ['block', sOut, ['loop', sOl,
    ['br_if', sOut, ['i32.eqz', [oExit.cmpOp, bump(['local.get', pxVar], 1), widthBound]]],
    ...laneCompute, ...epiLane(0), ...epiLane(1),
    ...pixelIVs.map(p => ['local.set', p.name, [p.type + '.add', ['local.get', p.name], [p.type + '.const', 2]]]),
    ['br', sOl]]]
  const wrapper = ['block', nm('w'), ...preamble, simdOuter, ['block', oLabel, loopNode]]
  return { wrapper, newLocalDecls }
}

// ---- Integer convolution column-strip-mine (tryConvColumn, experimental) ---------------------
//
// The int8 quantized convolution / dense-MAC kernel (conv2d): an OUTER output-pixel loop (ox)
// whose body — after the inner receptive-field loops fully unroll at speed — is a straight-line
// f64 reduction  acc = bias + Σ inp[…+ox]·wt[…]  over int8 taps, then requantize (acc>>SHIFT),
// ReLU-clamp, and store one uint8. jz accumulates in f64, but every product is int8×int8 (≤ 16129)
// and the sum fits i32, so the f64 carries an EXACT integer. That lets us strip-mine the column
// loop 8-wide as pure integer SIMD: 8 adjacent outputs (ox..ox+7) in lanes. Per tap, the per-pixel
// input gather inp[base+ox] is 8 CONTIGUOUS bytes — `v128.load64_zero` + `i16x8.extend_low_i8x16`
// — and the (pixel-invariant) weight broadcasts via `i16x8.splat`; `i16x8.mul` forms 8 products
// (each fits i16), widened (`i32x4.extend_low/high_i16x8_s`) into two i32x4 accumulators so 36 taps
// never overflow. Requant + clamp + store run scalar per lane; the kept scalar loop is the <8 tail.
//
// BIT-EXACT: integer arithmetic reorders nothing — each lane's i32 sum equals the scalar f64's exact
// integer, and ToInt32(acc)>>SHIFT == lane>>SHIFT. Gated behind cfg.experimentalOuterStrip. ~5×
// over the scalar reduction (the serial f64 add-chain is latency-bound; 8 columns hide it).
function tryConvColumn(blockNode, fnLocals, freshIdRef, enabled) {
  if (!enabled) return null
  const outer = matchOuterPixelLoop(blockNode)
  if (!outer) return null
  const { oLabel, loopNode, preamble, pixelIVs, pxVar, widthBound, pivType, obody, oExit } = outer
  if (pivType.get(pxVar) !== 'i32') return null                 // strip-mine an integer column
  for (const s of obody) if (isArr(s) && s[0] === 'block' && s.slice(1).some(c => isArr(c) && c[0] === 'loop')) return null  // body must be unrolled (no inner loop)
  const impureCall = (n) => isArr(n) && ((n[0] === 'call' && typeof n[1] === 'string' && !n[1].startsWith('$math.')) || n.some(impureCall))
  if (obody.some(impureCall)) return null
  const readsName = (n, name) => isArr(n) && ((n[0] === 'local.get' && n[1] === name) || n.some(c => readsName(c, name)))

  // Locals whose value depends on the column IV (transitively) — these address the per-pixel gather.
  const oxDep = new Set([pxVar])
  const allSets = []
  const collectSets = (n) => { if (!isArr(n)) return; if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') allSets.push([n[1], n[2]]); for (const c of n.slice(1)) collectSets(c) }
  obody.forEach(collectSets)
  for (let changed = true; changed;) { changed = false; for (const [name, rhs] of allSets) if (!oxDep.has(name) && [...oxDep].some(d => readsName(rhs, d))) { oxDep.add(name); changed = true } }
  const isGatherAddr = (addr) => [...oxDep].some(d => readsName(addr, d))

  // A byte tap operand: convert_i32_{s,u}(i32.load8_{s,u}(addr)). Returns { load, addr, signed }.
  const matchByteLoad = (n) => {
    // Accept the f64 form (convert_i32_{s,u}(load8)) AND the bare i32 load —
    // the emit-level convert-peel narrows int8·int8 to i32.mul(load8, load8),
    // so the taps arrive unconverted (the better shape: no f64 detour to undo).
    let ld = null
    if (isArr(n) && (n[0] === 'f64.convert_i32_s' || n[0] === 'f64.convert_i32_u') && isArr(n[1])) ld = n[1]
    else if (isArr(n) && (n[0] === 'i32.load8_s' || n[0] === 'i32.load8_u')) ld = n
    if (!ld || (ld[0] !== 'i32.load8_s' && ld[0] !== 'i32.load8_u')) return null
    const addr = (typeof ld[1] === 'string' && ld[1].startsWith('offset=')) ? ld[2] : ld[1]
    return { load: ld, addr, signed: ld[0] === 'i32.load8_s' }
  }
  const load64 = (ld) => (typeof ld[1] === 'string' && ld[1].startsWith('offset=')) ? ['v128.load64_zero', ld[1], ld[2]] : ['v128.load64_zero', ld[1]]
  // Lift a single product addend `inp·wt` (exactly one side gathers on ox) to an i16x8 of 8 products.
  const liftProduct = (prod) => {
    // f64.mul(cvt(load), cvt(load)) — pre-peel — or f64.convert_i32_s(i32.mul(
    // load, load)) / bare i32.mul(load, load) — the peeled faithful product.
    if (isArr(prod) && prod[0] === 'f64.convert_i32_s' && isArr(prod[1]) && prod[1][0] === 'i32.mul') prod = prod[1]
    if (!isArr(prod) || (prod[0] !== 'f64.mul' && prod[0] !== 'i32.mul')) return null
    const a = matchByteLoad(prod[1]), b = matchByteLoad(prod[2])
    if (!a || !b) return null
    const ag = isGatherAddr(a.addr), bg = isGatherAddr(b.addr)
    const g = ag && !bg ? a : bg && !ag ? b : null            // exactly one per-pixel gather
    if (!g) return null
    const inv = g === a ? b : a
    const gI16 = [g.signed ? 'i16x8.extend_low_i8x16_s' : 'i16x8.extend_low_i8x16_u', load64(g.load)]
    return ['i16x8.mul', gI16, ['i16x8.splat', inv.load]]      // splat the invariant weight (fits i16)
  }

  // THE accumulator: an f64 local written as `acc = acc + product` (either operand order). Its FIRST
  // write is the init — a plain invariant `acc = bias`, or (bias folded into the first tap by the
  // reassociator) `acc = bias + product`.
  const macAddend = (rhs, name) => (isArr(rhs) && rhs[0] === 'f64.add') ? (isLocalGet(rhs[1], name) ? rhs[2] : isLocalGet(rhs[2], name) ? rhs[1] : null) : null
  let accName = null
  for (const [name, rhs] of allSets) if (fnLocals.get(name) === 'f64' && macAddend(rhs, name) != null) { if (accName && accName !== name) return null; accName = name }
  if (!accName) return null
  const accIdx = []
  for (let i = 0; i < obody.length; i++) { const s = obody[i]; if (isArr(s) && s[0] === 'local.set' && s[1] === accName && s.length === 3) accIdx.push(i) }
  if (accIdx.length < 4) return null
  const initIdx = accIdx[0], initRhs = obody[initIdx][2]
  if (readsName(initRhs, accName)) return null                   // first write must not read acc

  const id = freshIdRef.next++
  const nm = (s) => `$__cv${id}_${s}`
  const loV = nm('lo'), hiV = nm('hi'), pV = nm('p')
  const splatI32 = (e) => ['i32x4.splat', (isArr(e) && (e[0] === 'f64.convert_i32_s' || e[0] === 'f64.convert_i32_u')) ? e[1] : ['i32.trunc_sat_f64_s', e]]
  const accStmts = (prod) => [
    ['local.set', pV, prod],
    ['local.set', loV, ['i32x4.add', ['local.get', loV], ['i32x4.extend_low_i16x8_s', ['local.get', pV]]]],
    ['local.set', hiV, ['i32x4.add', ['local.get', hiV], ['i32x4.extend_high_i16x8_s', ['local.get', pV]]]],
  ]
  // Init → lo/hi seeded to the invariant bias, plus the folded first tap (if the bias was fused in).
  const initStmts = () => {
    if (isArr(initRhs) && initRhs[0] === 'f64.add') {
      const pA = liftProduct(initRhs[1]), pB = liftProduct(initRhs[2])
      const bias = pA && !pB ? initRhs[2] : pB && !pA ? initRhs[1] : null
      const prod = pA && !pB ? pA : pB && !pA ? pB : null
      if (!prod || isGatherAddr(bias)) return null
      return [['local.set', loV, splatI32(bias)], ['local.set', hiV, splatI32(bias)], ...accStmts(prod)]
    }
    if (isGatherAddr(initRhs)) return null                       // plain seed must be loop-invariant
    return [['local.set', loV, splatI32(initRhs)], ['local.set', hiV, splatI32(initRhs)]]
  }

  // Build the SIMD body: keep scalar address setup; init→lo/hi seed; each MAC→i16x8 product → lo/hi.
  const lastMac = accIdx[accIdx.length - 1]
  const laneCompute = []
  for (let i = 0; i <= lastMac; i++) {
    const s = obody[i]
    if (i === initIdx) { const init = initStmts(); if (!init) return null; laneCompute.push(...init); continue }
    if (isArr(s) && s[0] === 'local.set' && s[1] === accName) {
      const addend = macAddend(s[2], accName)
      if (addend == null) return null                            // an acc write that isn't acc+product
      const prod = liftProduct(addend); if (!prod) return null
      laneCompute.push(...accStmts(prod)); continue
    }
    if (readsName(s, accName)) return null                       // scalar setup must not touch acc
    laneCompute.push(s)
  }

  // Epilogue (requant + clamp + store) runs scalar per lane: acc ← the lane's i32 column sum.
  const epilogue = obody.slice(lastMac + 1)
  let hasStore = false
  const findStore = (n) => { if (!isArr(n)) return; if (STORE_OPS[n[0]]) hasStore = true; n.forEach(findStore) }
  epilogue.forEach(findStore)
  if (!hasStore) return null
  const bump = (n, k) => k === 0 ? n
    : (isArr(n) && n[0] === 'local.get' && pivType.has(n[1])) ? [pivType.get(n[1]) + '.add', n, [pivType.get(n[1]) + '.const', k]]
    : (isArr(n) ? n.map(c => bump(c, k)) : n)
  const epiLane = (k) => [
    ['local.set', accName, ['f64.convert_i32_s', ['i32x4.extract_lane', k & 3, ['local.get', k < 4 ? loV : hiV]]]],
    ...epilogue.map(s => bump(s, k)),
  ]

  const newLocalDecls = [['local', loV, 'v128'], ['local', hiV, 'v128'], ['local', pV, 'v128']]
  const sOut = nm('ob'), sOl = nm('ol')
  // Guard requires 8 columns available (ox+7 < width); the kept scalar loop finishes the <8 tail.
  const simdOuter = ['block', sOut, ['loop', sOl,
    ['br_if', sOut, ['i32.eqz', [oExit.cmpOp, bump(['local.get', pxVar], 7), widthBound]]],
    ...laneCompute, ...epiLane(0), ...epiLane(1), ...epiLane(2), ...epiLane(3), ...epiLane(4), ...epiLane(5), ...epiLane(6), ...epiLane(7),
    ...pixelIVs.map(p => ['local.set', p.name, [p.type + '.add', ['local.get', p.name], [p.type + '.const', 8]]]),
    ['br', sOl]]]
  const wrapper = ['block', nm('w'), ...preamble, simdOuter, ['block', oLabel, loopNode]]
  return { wrapper, newLocalDecls }
}

// ---- Mixed-lane tone-map (tryToneMap, experimental) ------------------------
//
// Vectorizes the log-tonemap TAIL shared by fern / bifurcation / attractors:
//   while (i<n){ let v=dens[i]; if(v>0){ g = trunc(min(log(v+1)*S, 255)) }
//                px[i] = (255<<24)|(g<<16)|(g<<8)|g }
// A flat 1-D loop that loads an i32 density, lifts it to f64 for a log, truncates
// back to i32, packs an ARGB word, and stores it — i32 lanes wrapping an f64 ISLAND.
// The single-lane-type lift can't carry an f64 intermediate inside an i32 store
// (tryVectorize bails on `f64.mul: no lane-pure SIMD mapping for i32`), so this is a
// dedicated 2-wide (f64x2) hybrid: load 2 u32 (`v128.load64_zero` → i32x4 low lanes),
// `f64x2.convert_low_i32x4_s` into the island, `$math.log_v` + f64x2 arith + clamp,
// `i32x4.trunc_sat_f64x2_s_zero` back out, the i32 pack, then a masked
// `i64.store` of `i64x2.extract_lane 0` (the low 2 lanes = 2 pixels). 2 pixels/iter.
//
// BIT-EXACT by construction: each lane runs the scalar op (log_v is the per-lane
// extract/repack mirror; the clamp keeps L finite & in [0,255] so `trunc_sat == |0`,
// the ±Inf canon is a no-op and is dropped; the pack is element-wise). The conditional
// masks are emitted in the SAME lane width as the data they select (`v>0` is i32 and
// gates i32 stores/values; the `L>255` clamp is f64 and gates f64) — a width mismatch
// bails. No cross-lane reordering, so no ulp drift. Speculatively-evaluated arms are
// trap-free (log/convert/mul/min/trunc never trap; there is no div/rem). Gated until
// proven across the corpus, then promoted like the stencil/outer-strip wins.

const _toneStripTee = (n) => isArr(n) && n[0] === 'local.tee' && n.length === 3 ? n[2] : n

// `(i32.wrap_i64 (i64.trunc_sat_f64_{s,u} X))` or `(i32.trunc_sat_f64_{s,u} X)` — the
// f64→i32 `|0` bridge. Returns { inner, signed } (tee on X stripped) or null.
function matchTruncF64(expr) {
  if (!isArr(expr)) return null
  if (expr[0] === 'i32.wrap_i64' && isArr(expr[1])) {
    const t = expr[1]
    if (t[0] === 'i64.trunc_sat_f64_s') return { inner: _toneStripTee(t[1]), signed: true }
    if (t[0] === 'i64.trunc_sat_f64_u') return { inner: _toneStripTee(t[1]), signed: false }
  }
  if (expr[0] === 'i32.trunc_sat_f64_s') return { inner: _toneStripTee(expr[1]), signed: true }
  if (expr[0] === 'i32.trunc_sat_f64_u') return { inner: _toneStripTee(expr[1]), signed: false }
  return null
}

// The `|0` of a known-finite f64: `(select (trunc X) (i32.const 0) (f64.ne X' ±Inf))`.
// Since the tonemap clamps L into [0,255] before the trunc, the `≠Inf` guard is always
// true, so this lowers to a plain `trunc_sat` — returns the inner f64 to truncate.
function matchInfCanonTone(sel) {
  if (!isArr(sel) || sel[0] !== 'select' || sel.length !== 4) return null
  if (!(isI32Const(sel[2]) && constNum(sel[2]) === 0)) return null
  const c = sel[3]
  if (!(isArr(c) && c[0] === 'f64.ne' && isArr(c[2]) && c[2][0] === 'f64.const' && /inf/i.test(String(c[2][1])))) return null
  const tr = matchTruncF64(sel[1])
  return tr ? tr.inner : null
}

// Loads tryToneMap accepts as the f64-island input. `i32.load` is the original (stride-4, no
// widening). Narrow typed-array reads (Uint8/Int8/Uint16/Int16) are widened to the low two i32x4
// lanes before the f64x2.convert — exactly the F/B/T `dist` term over an 8-bit/16-bit buffer.
// `shift` = the address stride exponent (0/1/2). `over` = extra ELEMENTS the widening load reads
// past its lane pair (u8 reads 4 bytes via load32_zero for 2 lanes) — the SIMD bound is shrunk by
// it so the read never runs off the array; the scalar tail finishes the remainder. The widen step
// signedness matches the load op, so the i32x4 lanes hold the exact scalar value.
const TONE_LOAD = {
  'i32.load':     { shift: 2, widen: null, over: 0 },
  'i32.load8_u':  { shift: 0, widen: ['v128.load32_zero', ['i16x8.extend_low_i8x16_u', 'i32x4.extend_low_i16x8_u']], over: 2 },
  'i32.load8_s':  { shift: 0, widen: ['v128.load32_zero', ['i16x8.extend_low_i8x16_s', 'i32x4.extend_low_i16x8_s']], over: 2 },
  'i32.load16_u': { shift: 1, widen: ['v128.load32_zero', ['i32x4.extend_low_i16x8_u']], over: 0 },
  'i32.load16_s': { shift: 1, widen: ['v128.load32_zero', ['i32x4.extend_low_i16x8_s']], over: 0 },
}

// `base + (i << shift)` (shift 0 ⇒ bare `base + i`) with `base` a loop-invariant array pointer.
// The address shape for a load/store at its element stride: the u32 store uses shift 2 (stride-4 ⇒
// load64_zero/i64.store cover exactly 2 consecutive u32); a narrow load uses its own stride (0/1).
function matchToneAddrShift(addr, ind, shift) {
  if (!isArr(addr) || addr[0] !== 'i32.add' || addr.length !== 3) return null
  const pair = (baseN, offN) => {
    if (!isArr(baseN) || (baseN[0] !== 'local.get' && baseN[0] !== 'global.get')) return null
    if (baseN[0] === 'local.get' && baseN[1] === ind) return null
    if (shift === 0) return isLocalGet(offN, ind) ? baseN : null
    if (isArr(offN) && offN[0] === 'i32.shl' && offN.length === 3 && isLocalGet(offN[1], ind) && constNum(offN[2]) === shift) return baseN
    return null
  }
  return pair(addr[1], addr[2]) || pair(addr[2], addr[1])
}

const _toneUnwrapArm = (arm) => {  // arm = ['then'|'else', ...stmts]; unwrap a single nested block
  let body = arm.slice(1)
  if (body.length === 1 && isArr(body[0]) && body[0][0] === 'block') {
    const b = body[0]; let i = 1
    if (typeof b[i] === 'string' && b[i].startsWith('$')) i++
    if (isArr(b[i]) && b[i][0] === 'result') i++
    body = b.slice(i)
  }
  return body
}

const _toneAppears = (n, name) => isArr(n) && (((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === name) || n.some(c => _toneAppears(c, name)))

// First WRITE of `name`: returns { stmtIdx, nested } (nested = inside an `if`) or null.
function _toneFirstWrite(body, name) {
  for (let i = 0; i < body.length; i++) {
    let found = false, nested = false
    const w = (n, depth) => {
      if (found || !isArr(n)) return
      if ((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === name) { found = true; nested = depth > 0; return }
      const d = depth + (n[0] === 'if' ? 1 : 0)
      for (let j = 1; j < n.length; j++) w(n[j], d)
    }
    w(body[i], 0)
    if (found) return { stmtIdx: i, nested }
  }
  return null
}

// Mixed-lane log-tonemap: i32 dens[i] → f64 log → i32 pack → px[i]. See the block comment above.
function tryToneMap(bl, fnLocals, freshIdRef, enabled) {
  if (!enabled || !bl) return null
  const { incVar, bound, boundLocal, body, preamble } = bl
  if (!boundLocal && !isI32Const(bound)) return null   // bound must be loop-invariant

  // Shape gate: exactly one i32.store + ≥1 i32.load, all at `base+(i<<2)`, plus the f64
  // island signature (`f64.convert_i32_*`). Any other-width load/store declines. The
  // f64-convert requirement is what distinguishes this from a plain i32 map (tryVectorize,
  // which runs earlier and already owns those).
  let hasConvert = false, storeCount = 0, loadCount = 0, overread = 0, ok = true
  const scan = (n) => {
    if (!ok || !isArr(n)) return
    const o = n[0]
    if (o === 'f64.convert_i32_s' || o === 'f64.convert_i32_u') hasConvert = true
    if (o === 'i32.store') { storeCount++; if (!matchToneAddrShift(n[1], incVar, 2)) ok = false; scan(n[2]); return }
    const ld = TONE_LOAD[o]
    if (ld && n.length === 2) {   // i32 (stride-4) or a narrow typed-array read at its own stride
      loadCount++
      if (!matchToneAddrShift(n[1], incVar, ld.shift)) { ok = false; return }
      if (ld.over > overread) overread = ld.over
      return
    }
    if (LOAD_OPS[o] || STORE_OPS[o]) { ok = false; return }  // any other-width memop → not this shape
    for (let i = 1; i < n.length; i++) scan(n[i])
  }
  for (const s of body) scan(s)
  // 1 store (unconditional, attractors) or 2 (the then/else arms of a conditional store,
  // bifurcation/fern — both write the same pixel and collapse to one masked store).
  if (!ok || !hasConvert || storeCount < 1 || storeCount > 2 || loadCount < 1) return null
  if (body.some(hasGlobalSet)) return null

  // Classify locals (mirrors tryVectorize): written ⇒ lane (first access must be a write,
  // else loop-carried), unwritten ⇒ invariant.
  const writes = new Set()
  for (const s of body) collectWrites(s, writes)
  if (boundLocal && writes.has(boundLocal)) return null
  const referenced = new Set()
  const collectRefs = (n) => {
    if (!isArr(n)) return
    if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') referenced.add(n[1])
    for (let i = 1; i < n.length; i++) collectRefs(n[i])
  }
  for (const s of body) collectRefs(s)
  const localKind = new Map()
  for (const name of referenced) {
    if (name === incVar) continue
    if (writes.has(name)) {
      let firstKind = null
      for (const s of body) { const k = firstAccess(s, name); if (k) { firstKind = k; break } }
      if (firstKind === 'read') return null   // loop-carried
      localKind.set(name, 'lane')
    } else localKind.set(name, 'invariant')
  }

  // Liveness gate: a lane local first ASSIGNED inside an `if` is set speculatively
  // (unconditionally) — sound only if it never leaks past that statement (else a false
  // lane would read a value scalar never produced). Bail otherwise.
  for (const [name, kind] of localKind) {
    if (kind !== 'lane') continue
    const fw = _toneFirstWrite(body, name)
    if (fw && fw.nested) {
      for (let i = 0; i < body.length; i++) if (i !== fw.stmtIdx && _toneAppears(body[i], name)) return null
    }
  }

  const newLanedLocals = new Map()       // origName → laneName (bare string; see getOrAllocLanedLocal)
  // SAME field set + ORDER as the ctx in tryVectorize / tryReduceVectorize / tryRampMap. The
  // self-host kernel infers ONE struct layout per shared callee, and `liftFail` is shared with
  // liftExprV — so every ctx reaching it MUST have the identical shape, or the inferred layout is
  // wrong for some and field reads corrupt (this is the exact regression 11657cf fixed; the
  // tone-map's old 3-field ctx re-broke the ENTIRE self-host vectorizer). tryToneMap itself only
  // reads fail/failReason/extraLocals, but the unused fields must still be present, in order.
  const ctx = { laneType: 'f64', incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, fnLocals: null, newLanedLocals, extraLocals: [], freshIdRef, fail: false, failReason: null }
  const toneSetBefore = new Set()         // lane locals already assigned (conditional-merge gate)
  const laned = (name) => { let ln = newLanedLocals.get(name); if (!ln) { ln = `${name}__v`; newLanedLocals.set(name, ln) } return ln }
  const freshMask = () => { const mt = `$__mask${freshIdRef.next++}`; ctx.extraLocals.push(['local', mt, 'v128']); return mt }

  // The ctx-using lifters are NESTED function declarations that CAPTURE the state above (like
  // scanForLoadsStores) — taking `ctx` as a param instead would make jz's self-host inference
  // mistype the recursive lifter's `ctx` (the recursive call site can't agree on i32, so it
  // stays boxed f64 and its callers emit a bad i64.reinterpret_f64). Capturing sidesteps that.

  // Result lane width of a value expr ('i32' | 'f64' | 'x') — keeps a conditional's mask the
  // SAME width as the data it selects (a mismatch bails).
  function toneWidth(e) {
    if (!isArr(e)) return 'x'
    const o = e[0]
    if (o === 'f64.const' || o === 'f64.convert_i32_s' || o === 'f64.convert_i32_u' || o === 'call') return 'f64'
    if (o === 'i32.const' || o === 'i32.wrap_i64' || o === 'i32.trunc_sat_f64_s' || o === 'i32.trunc_sat_f64_u') return 'i32'
    if (o === 'local.get') return fnLocals.get(e[1]) === 'f64' ? 'f64' : 'i32'
    if (o === 'select') return toneWidth(e[1])
    if (o === 'if') return isArr(e[1]) && e[1][1] === 'f64' ? 'f64' : 'i32'
    if (o.startsWith('f64.')) return 'f64'
    if (o.startsWith('i32.')) return 'i32'
    return 'x'
  }

  // Lift one value expression to v128. Result lane type comes from the op (f64.* → f64x2,
  // i32.* → i32x4; convert/trunc bridge between them). Bit-exact per lane.
  function liftV(expr) {
    if (!isArr(expr)) return liftFail(ctx, 'tonemap: non-expression operand')
    const op = expr[0]
    if ((op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u') && expr.length === 2) {
      const inner = expr[1]
      if (isArr(inner) && (inner[0] === 'global.get' || inner[0] === 'i32.const' ||
          (inner[0] === 'local.get' && localKind.get(inner[1]) === 'invariant')))
        return ['f64x2.splat', expr]   // loop-invariant convert: scalar-then-splat, bit-exact
      const a = liftV(inner); if (ctx.fail) return null
      return [op === 'f64.convert_i32_s' ? 'f64x2.convert_low_i32x4_s' : 'f64x2.convert_low_i32x4_u', a]
    }
    const tr = matchTruncF64(expr)   // f64 → i32 `|0` bridge
    if (tr) { const a = liftV(tr.inner); if (ctx.fail) return null; return [tr.signed ? 'i32x4.trunc_sat_f64x2_s_zero' : 'i32x4.trunc_sat_f64x2_u_zero', a] }
    if (TONE_LOAD[op] && expr.length === 2) {   // i32 → load64_zero (low 2 lanes); narrow → widen to i32x4 low lanes
      const w = TONE_LOAD[op].widen
      if (!w) return ['v128.load64_zero', expr[1]]   // address kept scalar
      let v = [w[0], expr[1]]
      for (let i = 0; i < w[1].length; i++) v = [w[1][i], v]
      return v
    }
    if (op === 'i32.const') return ['i32x4.splat', expr]
    if (op === 'f64.const') return ['f64x2.splat', expr]
    if (op === 'local.get' && typeof expr[1] === 'string') {
      const name = expr[1], kind = localKind.get(name)
      if (kind === 'lane') return ['local.get', laned(name)]
      if (kind === 'invariant') return [fnLocals.get(name) === 'f64' ? 'f64x2.splat' : 'i32x4.splat', expr]
      return liftFail(ctx, `tonemap: ${name} address/induction var used as lane data`)
    }
    if (op === 'local.tee' && typeof expr[1] === 'string' && expr.length === 3) {
      // `let v = X` reused in the same statement folds to `(local.tee $v X)`; lift it to set the
      // lane local AND yield it (bit-exact — the scalar tee sets $v and returns the same value).
      const name = expr[1]
      if (localKind.get(name) !== 'lane') return liftFail(ctx, `tonemap: tee of non-lane ${name}`)
      const v = liftV(expr[2]); if (ctx.fail) return null
      toneSetBefore.add(name)
      return ['local.tee', laned(name), v]
    }
    if (op === 'call' && PPC_CALL2[expr[1]]) {   // transcendental → its 2-wide mirror
      const args = []
      for (let i = 2; i < expr.length; i++) { const a = liftV(expr[i]); if (ctx.fail) return null; args.push(a) }
      return ['call', PPC_CALL2[expr[1]], ...args]
    }
    if (op === 'select' && expr.length === 4) {
      const inf = matchInfCanonTone(expr)
      if (inf) { const a = liftV(inf); if (ctx.fail) return null; return ['i32x4.trunc_sat_f64x2_s_zero', a] }
      return liftSel(expr[1], expr[2], expr[3])
    }
    if (op === 'if' && isArr(expr[1]) && expr[1][0] === 'result' && isArr(expr[3]) && expr[3][0] === 'then' && isArr(expr[4]) && expr[4][0] === 'else')
      return liftSel(expr[3][1], expr[4][1], expr[2])
    const insl = op.startsWith('f64.') ? 'f64' : (op.startsWith('i32.') ? 'i32' : 'x')
    const entry = LANE_PURE[insl]?.get(op)
    if (entry) {
      const a = liftV(expr[1]); if (ctx.fail) return null
      if (entry.shamtScalar) {
        const b = expr[2]
        if (!isI32Const(b) && !(isArr(b) && b[0] === 'local.get' && localKind.get(b[1]) === 'invariant'))
          return liftFail(ctx, `tonemap: ${op}: shift amount not constant/invariant`)
        return [entry.simd, a, b]
      }
      if (expr.length === 2) return [entry.simd, a]
      const b = liftV(expr[2]); if (ctx.fail) return null
      return [entry.simd, a, b]
    }
    return liftFail(ctx, `tonemap: ${op}: no lane mapping`)
  }

  // Lane-comparison mask, required to match the selected data width (a LOCAL `c` — never
  // reassign the param). Returns the mask expr or null on bail.
  function liftMask(cond, dataTy) {
    let c = cond
    if (isArr(c) && c[0] === 'i32.ne' && isI32Const(c[2]) && c[2][1] === 0) c = c[1]
    if (!isArr(c) || c.length !== 3) return liftFail(ctx, 'tonemap: condition is not a comparison')
    const condTy = c[0].startsWith('f64.') ? 'f64' : (c[0].startsWith('i32.') ? 'i32' : 'x')
    if (condTy !== dataTy) return liftFail(ctx, `tonemap: mask width ${condTy} ≠ data width ${dataTy}`)
    const cmp = LANE_COMPARE[condTy]?.[c[0]]
    if (!cmp) return liftFail(ctx, `tonemap: ${c[0]}: not a lane comparison`)
    const ca = liftV(c[1]); if (ctx.fail) return null
    const cb = liftV(c[2]); if (ctx.fail) return null
    return [cmp, ca, cb]
  }

  // `cond ? a : b` → bitselect(a, b, mask(cond)); mask in the branch's lane width.
  function liftSel(a, b, cond) {
    const m = liftMask(cond, toneWidth(a)); if (ctx.fail) return null
    const av = liftV(a); if (ctx.fail) return null
    const bv = liftV(b); if (ctx.fail) return null
    const mt = freshMask()
    return ['block', ['result', 'v128'], ['local.set', mt, m], ['v128.bitselect', av, bv, ['local.get', mt]]]
  }

  // Lift one statement, pushing v128 stmts into `out`. Sets ctx.fail on any bail.
  function liftS(stmt, out) {
    if (!isArr(stmt)) { liftFail(ctx, 'tonemap: non-array statement'); return }
    const op = stmt[0]
    if (op === 'block') {
      let i = 1
      if (typeof stmt[i] === 'string' && stmt[i].startsWith('$')) i++
      if (isArr(stmt[i]) && stmt[i][0] === 'result') i++
      for (const s of stmt.slice(i)) { liftS(s, out); if (ctx.fail) return }
      return
    }
    if (op === 'local.set' && typeof stmt[1] === 'string' && stmt.length === 3) {
      const name = stmt[1]
      if (localKind.get(name) !== 'lane') { liftFail(ctx, `tonemap: set of non-lane ${name}`); return }
      const v = liftV(stmt[2]); if (ctx.fail) return
      out.push(['local.set', laned(name), v]); toneSetBefore.add(name); return
    }
    if (STORE_OPS[op]) {   // i32.store ADDR VAL → masked i64.store of the low 2 lanes (2 pixels)
      if (op !== 'i32.store' || stmt.length !== 3) { liftFail(ctx, `tonemap: unsupported store ${op}`); return }
      const v = liftV(stmt[2]); if (ctx.fail) return
      out.push(['i64.store', stmt[1], ['i64x2.extract_lane', 0, v]]); return
    }
    if (op === 'if' && isArr(stmt[2]) && stmt[2][0] === 'then') {
      const hasElse = isArr(stmt[3]) && stmt[3][0] === 'else'
      const thenStmts = _toneUnwrapArm(stmt[2])
      const elseStmts = hasElse ? _toneUnwrapArm(stmt[3]) : null
      const thenLast = thenStmts[thenStmts.length - 1]
      const elseLast = elseStmts && elseStmts[elseStmts.length - 1]
      const thenStore = isArr(thenLast) && STORE_OPS[thenLast[0]] && thenLast.length === 3
      const elseStore = elseLast && isArr(elseLast) && STORE_OPS[elseLast[0]] && elseLast.length === 3
      // (a) Conditional STORE — both arms (or then-only) end in a store to the same address.
      if (thenStore && (elseStore || !hasElse)) {
        if (elseStore && JSON.stringify(thenLast[1]) !== JSON.stringify(elseLast[1])) { liftFail(ctx, 'tonemap: arms store to different addresses'); return }
        for (const s of thenStmts.slice(0, -1)) { liftS(s, out); if (ctx.fail) return }
        if (hasElse) for (const s of elseStmts.slice(0, -1)) { liftS(s, out); if (ctx.fail) return }
        const thenVal = liftV(thenLast[2]); if (ctx.fail) return
        const elseVal = elseStore ? liftV(elseLast[2]) : ['v128.load64_zero', thenLast[1]]
        if (ctx.fail) return
        const m = liftMask(stmt[1], 'i32'); if (ctx.fail) return
        const mt = freshMask()
        out.push(['local.set', mt, m],
          ['i64.store', thenLast[1], ['i64x2.extract_lane', 0, ['v128.bitselect', thenVal, elseVal, ['local.get', mt]]]])
        return
      }
      // (b) Conditional VALUE update — `if (cond) { L = …; … }` (no else) updating lane locals.
      if (!hasElse) {
        for (const s of thenStmts) {
          if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3 && localKind.get(s[1]) === 'lane')) {
            liftFail(ctx, 'tonemap: no-else arm is not a lane update'); return
          }
          const name = s[1], ty = fnLocals.get(name) === 'f64' ? 'f64' : 'i32'
          const xv = liftV(s[2]); if (ctx.fail) return
          const ln = laned(name)
          if (toneSetBefore.has(name)) {
            const m = liftMask(stmt[1], ty); if (ctx.fail) return   // conditional merge
            const mt = freshMask()
            out.push(['local.set', mt, m], ['local.set', ln, ['v128.bitselect', xv, ['local.get', ln], ['local.get', mt]]])
          } else {
            out.push(['local.set', ln, xv]); toneSetBefore.add(name)   // first, unconditional (liveness-gated)
          }
        }
        return
      }
      liftFail(ctx, 'tonemap: unsupported if shape'); return
    }
    liftFail(ctx, `tonemap: unsupported statement ${op}`)
  }

  const lifted = []
  for (const s of body) { liftS(s, lifted); if (ctx.fail) return null }
  if (!lifted.length) return null

  // 2-wide SIMD wrapper (LANES=2, the f64x2 island's width). Scalar tail = original block.
  const LANES = 2
  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`, simdBrk = `$__simd_brk${id}`, simdLoop = `$__simd_loop${id}`
  const boundExpr = boundLocal ? ['local.get', boundLocal] : bound
  const simdBlock = ['block', simdBrk,
    ['loop', simdLoop,
      ['br_if', simdBrk, ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...lifted,
      ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', LANES]]],
      ['br', simdLoop]]]
  // A widening narrow load reads more elements than its lane pair (u8: 4 bytes for 2 lanes), so shrink
  // the SIMD bound by that over-read — the widest load stays in-bounds and the scalar tail finishes the
  // remainder. (A negative bound from a tiny array just leaves the whole loop scalar — safe.)
  const boundExprAdj = overread > 0 ? ['i32.sub', boundExpr, ['i32.const', overread]] : boundExpr
  const boundSetup = ['local.set', simdBoundName, ['i32.and', boundExprAdj, ['i32.const', -LANES]]]
  const wrapper = ['block', ...preamble.map(cloneNode), boundSetup, simdBlock, bl.blockNode]
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']),
    ...ctx.extraLocals,
  ]
  return { wrapper, newLocalDecls }
}

// ---- Radix-2 butterfly 2-wide lift (tryButterfly) ----
//
// The Cooley-Tukey inner loop — the one shape the generic lane lift can never take:
// a DUAL-IV scaffold (`j++` carries the exit test, `k += STEP` walks the twiddle
// table) with an in-place complex-rotation update over four disjoint streams
// (re/im × a/b, b = a + HALF, twiddles wre/wim read-only). Lanes j and j+1:
//   - every a/b access is an ADJACENT pair → one v128.load / v128.store,
//   - the twiddle pair is strided by STEP → two scalar f64.loads + lane combine
//     (same load count as two scalar iterations),
//   - the +/−/× rotation lanes with NO reassociation and NO fusion — each lane
//     computes the exact scalar sequence, so the result is bit-identical and the
//     cross-engine checksum contract holds.
// LEGALITY. The strip body runs only while j+1 < half, so b = a + half ≥ a + 2:
// {a,a+1} and {b,b+1} never overlap — the b-pair stores cannot clobber lane 1's
// a-pair loads, and the single im[a] pair load legitimately serves both the
// im[b] store and the im[a] writeback (im[a] ∉ {im[b−1], im[b]}). re/im/wre/wim
// are distinct base locals under the vectorizer's standing distinct-base
// non-aliasing model. HALF/STEP and the four bases must not be written in the
// loop (checked); j/k are exactly reproduced for the scalar tail (each strip
// iteration consumes two scalar iterations), and the tail IS the original loop,
// so an odd half (or half < 2) falls through untouched.
function tryButterfly(blockNode, fnLocals, freshIdRef) {
  if (!isArr(blockNode) || blockNode[0] !== 'block' || typeof blockNode[1] !== 'string') return null
  const brk = blockNode[1]
  if (blockNode.length !== 3 || !isArr(blockNode[2]) || blockNode[2][0] !== 'loop') return null
  const loop = blockNode[2]
  const lbl = loop[1]
  if (typeof lbl !== 'string') return null
  // scaffold: (loop $L (br_if $brk (i32.eqz (i32.lt_s J HALF))) BODY×17 INC 'drop' (br $L))
  const exit = loop[2]
  if (!isArr(exit) || exit[0] !== 'br_if' || exit[1] !== brk) return null
  const ez = exit[2]
  if (!isArr(ez) || ez[0] !== 'i32.eqz' || !isArr(ez[1]) || ez[1][0] !== 'i32.lt_s') return null
  const [, jGet, halfGet] = ez[1]
  if (!isLocalGet(jGet) || !isLocalGet(halfGet)) return null
  const J = jGet[1], HALF = halfGet[1]
  const end = loop.length - 1
  if (!isArr(loop[end]) || loop[end][0] !== 'br' || loop[end][1] !== lbl) return null
  if (loop[end - 1] !== 'drop') return null
  // inc: (block (result i32) (drop (i32.sub (local.tee J (i32.add J 1)) 1)) (local.tee K (i32.add K STEP)))
  const inc = loop[end - 2]
  if (!isArr(inc) || inc[0] !== 'block' || !isArr(inc[1]) || inc[1][0] !== 'result' || inc.length !== 4) return null
  const jInc = inc[2], kInc = inc[3]
  if (!isArr(jInc) || jInc[0] !== 'drop' || !isArr(jInc[1]) || jInc[1][0] !== 'i32.sub') return null
  const jTee = jInc[1][1]
  if (!isArr(jTee) || jTee[0] !== 'local.tee' || jTee[1] !== J || !isArr(jTee[2]) || jTee[2][0] !== 'i32.add'
      || !isLocalGet(jTee[2][1], J) || constNum(jTee[2][2]) !== 1) return null
  if (!isArr(kInc) || kInc[0] !== 'local.tee' || !isArr(kInc[2]) || kInc[2][0] !== 'i32.add') return null
  const K = kInc[1]
  if (typeof K !== 'string' || !isLocalGet(kInc[2][1], K) || !isLocalGet(kInc[2][2])) return null
  const STEP = kInc[2][2][1]
  const body = loop.slice(3, end - 2)
  if (body.length !== 17) return null

  // unification environment over the exact emit shapes
  const U = {}
  const bind = (name, v) => U[name] === undefined ? (U[name] = v, true) : U[name] === v
  const idx8 = (n, base, iv) => isArr(n) && n[0] === 'i32.add'
    && isLocalGet(n[1]) && bind(base, n[1][1])
    && isArr(n[2]) && n[2][0] === 'i32.shl' && isLocalGet(n[2][1]) && bind(iv, n[2][1][1])
    && constNum(n[2][2]) === 3
  const setF64Load = (st, name, base, iv, ab) => {
    if (!isArr(st) || st[0] !== 'local.set' || st.length !== 3 || !isArr(st[2]) || st[2][0] !== 'f64.load') return false
    let addr = st[2][1]
    if (ab != null) {
      if (!isArr(addr) || addr[0] !== 'local.tee') return false
      if (!bind(ab, addr[1])) return false
      addr = addr[2]
    }
    if (!idx8(addr, base, iv)) return false
    return bind(name, st[1])
  }
  const g = (n, name) => isLocalGet(n) && U[name] !== undefined && n[1] === U[name]
  const mulPair = (n, x, y) => isArr(n) && n[0] === 'f64.mul' && g(n[1], x) && g(n[2], y)
  const setArith = (st, name, op, mk) => {
    if (!isArr(st) || st[0] !== 'local.set' || st.length !== 3 || !isArr(st[2]) || st[2][0] !== op) return false
    if (!mk(st[2])) return false
    return bind(name, st[1])
  }
  // flat pair: (local.set T (op LHS VAL)) ; (f64.store (local.get AB) (local.get T))
  const storePair = (setSt, stoSt, op, lhs, val2, ab) => {
    if (!isArr(setSt) || setSt[0] !== 'local.set' || !isArr(setSt[2]) || setSt[2][0] !== op) return false
    const e = setSt[2]
    if (!lhs(e[1]) || !g(e[2], val2)) return false
    if (!isArr(stoSt) || stoSt[0] !== 'f64.store' || !g(stoSt[1], ab) || !isLocalGet(stoSt[2], setSt[1])) return false
    return true
  }

  if (!setF64Load(body[0], 'WR', 'WRE', 'K0', null) || U.K0 !== K) return null
  if (!setF64Load(body[1], 'WI', 'WIM', 'K1', null) || U.K1 !== K) return null
  {  // a = I + j (either order), I ≠ J
    const st = body[2]
    if (!isArr(st) || st[0] !== 'local.set' || !isArr(st[2]) || st[2][0] !== 'i32.add') return null
    const [, l, r] = st[2]
    if (isLocalGet(l) && isLocalGet(r, J) && l[1] !== J) U.I = l[1]
    else if (isLocalGet(r) && isLocalGet(l, J) && r[1] !== J) U.I = r[1]
    else return null
    U.A = st[1]
  }
  {  // b = a + half (either order)
    const st = body[3]
    if (!isArr(st) || st[0] !== 'local.set' || !isArr(st[2]) || st[2][0] !== 'i32.add') return null
    const [, l, r] = st[2]
    if (!((isLocalGet(l, U.A) && isLocalGet(r, HALF)) || (isLocalGet(r, U.A) && isLocalGet(l, HALF)))) return null
    U.B = st[1]
  }
  if (!setF64Load(body[4], 'XR', 'RE', 'B0', 'AB4') || U.B0 !== U.B) return null
  if (!setF64Load(body[5], 'XI', 'IM', 'B1', 'AB5') || U.B1 !== U.B) return null
  if (!setArith(body[6], 'TR', 'f64.sub', e => mulPair(e[1], 'WR', 'XR') && mulPair(e[2], 'WI', 'XI'))) return null
  if (!setArith(body[7], 'TI', 'f64.add', e => mulPair(e[1], 'WR', 'XI') && mulPair(e[2], 'WI', 'XR'))) return null
  if (!setF64Load(body[8], 'C0', 'RE', 'A0', 'AB6') || U.A0 !== U.A) return null
  const c0lhs = (n) => g(n, 'C0')
  const ab7teeLhs = (n) => {  // (f64.load (local.tee AB7 (im + a<<3)))
    if (!isArr(n) || n[0] !== 'f64.load' || !isArr(n[1]) || n[1][0] !== 'local.tee') return false
    if (!bind('AB7', n[1][1])) return false
    return idx8(n[1][2], 'IM', 'A2') && U.A2 === U.A
  }
  const ab7getLhs = (n) => isArr(n) && n[0] === 'f64.load' && g(n[1], 'AB7')
  if (!storePair(body[9], body[10], 'f64.sub', c0lhs, 'TR', 'AB4')) return null
  if (!storePair(body[11], body[12], 'f64.sub', ab7teeLhs, 'TI', 'AB5')) return null
  if (!storePair(body[13], body[14], 'f64.add', c0lhs, 'TR', 'AB6')) return null
  if (!storePair(body[15], body[16], 'f64.add', ab7getLhs, 'TI', 'AB7')) return null
  // loop-invariance: the four bases, HALF/STEP and the outer offset I are never written in the body
  const invariants = new Set([U.RE, U.IM, U.WRE, U.WIM, HALF, STEP, U.I].filter(x => typeof x === 'string'))
  if (invariants.size !== 7) return null
  let clobbered = false
  const wscan = (n) => { if (clobbered || !isArr(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && invariants.has(n[1])) { clobbered = true; return }
    for (let i = 1; i < n.length; i++) wscan(n[i]) }
  for (const st of body) wscan(st)
  if (clobbered) return null
  if (new Set([U.RE, U.IM, U.WRE, U.WIM]).size !== 4) return null

  const id = freshIdRef.next++
  const nm = (t) => `$__bf${id}_${t}`
  const L = (x) => ['local.get', x]
  const addr = (base, iv) => ['i32.add', L(base), ['i32.shl', L(iv), ['i32.const', 3]]]
  const twiddle = (base) => ['f64x2.replace_lane', 1,
    ['f64x2.splat', ['f64.load', addr(base, K)]],
    ['f64.load', ['i32.add', L(base), ['i32.shl', ['i32.add', L(K), L(STEP)], ['i32.const', 3]]]]]
  const wrv = nm('wrv'), wiv = nm('wiv'), xrv = nm('xrv'), xiv = nm('xiv')
  const trv = nm('trv'), tiv = nm('tiv'), c0v = nm('c0v'), iav = nm('iav')
  const av = nm('a'), bv = nm('b'), vl = nm('L'), strip = nm('go')
  const newLocalDecls = [
    ['local', wrv, 'v128'], ['local', wiv, 'v128'], ['local', xrv, 'v128'], ['local', xiv, 'v128'],
    ['local', trv, 'v128'], ['local', tiv, 'v128'], ['local', c0v, 'v128'], ['local', iav, 'v128'],
    ['local', av, 'i32'], ['local', bv, 'i32'],
  ]
  const stripGuard = () => ['i32.lt_s', ['i32.add', L(J), ['i32.const', 1]], L(HALF)]
  const vbody = [
    ['local.set', wrv, twiddle(U.WRE)],
    ['local.set', wiv, twiddle(U.WIM)],
    ['local.set', av, ['i32.add', L(U.I), L(J)]],
    ['local.set', bv, ['i32.add', L(av), L(HALF)]],
    ['local.set', xrv, ['v128.load', addr(U.RE, bv)]],
    ['local.set', xiv, ['v128.load', addr(U.IM, bv)]],
    ['local.set', trv, ['f64x2.sub', ['f64x2.mul', L(wrv), L(xrv)], ['f64x2.mul', L(wiv), L(xiv)]]],
    ['local.set', tiv, ['f64x2.add', ['f64x2.mul', L(wrv), L(xiv)], ['f64x2.mul', L(wiv), L(xrv)]]],
    ['local.set', c0v, ['v128.load', addr(U.RE, av)]],
    ['v128.store', addr(U.RE, bv), ['f64x2.sub', L(c0v), L(trv)]],
    ['local.set', iav, ['v128.load', addr(U.IM, av)]],
    ['v128.store', addr(U.IM, bv), ['f64x2.sub', L(iav), L(tiv)]],
    ['v128.store', addr(U.RE, av), ['f64x2.add', L(c0v), L(trv)]],
    ['v128.store', addr(U.IM, av), ['f64x2.add', L(iav), L(tiv)]],
    ['local.set', J, ['i32.add', L(J), ['i32.const', 2]]],
    ['local.set', K, ['i32.add', L(K), ['i32.add', L(STEP), L(STEP)]]],
    ['br_if', vl, stripGuard()],
  ]
  const wrapper = ['block',
    ['block', strip,
      ['br_if', strip, ['i32.eqz', stripGuard()]],
      ['loop', vl, ...vbody]],
    blockNode]  // the ORIGINAL loop is the scalar tail: 0..1 leftover iterations, or everything when half < 2
  return { wrapper, newLocalDecls }
}


// ---- Pass entry ------------------------------------------------------------

/**
 * Walk a function looking for vectorizable (block (loop)) pairs, in-place.
 * Adds new locals to the function header.
 */
// opts gates the recognizer set + lift variants (all default-safe so a bare
// `vectorizeLaneLocal(fn)` is the conservative scalar-preserving pass):
//   multiAcc, relaxedFma, blurMP, whyNot, stencil, outerStrip, pureFuncMap, toneMap.
export function vectorizeLaneLocal(fn, opts = {}) {
  const { multiAcc = false, relaxedFma = false, blurMP = true, whyNot = false,
    stencil = false, outerStrip = false, pureFuncMap = null, toneMap = false, slp = false, crPow = false } = opts
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const fnName = typeof fn[1] === 'string' ? fn[1] : '(anon)'
  let whyNotN = 0

  // Normalize jz's per-statement `block` grouping into flat statement lists ONCE, up front —
  // the recognizers below (both the scaffold consumers and the raw-node matchers like ramp-map,
  // stencil, per-pixel) were tuned on watr's flattened shape. Pre-watr, jz wraps each source
  // statement group in a transparent block; without this every loop body would arrive as a
  // single opaque `block` node and no lift would fire. Walking `fn` itself also flattens a
  // top-level body block (decls never match — they aren't blocks).
  normalizeTransparentBlocks(fn)
  // Canonicalize the raw arithmetic identities watr would fold (chiefly `i<<0` byte addresses),
  // so the address/value matchers read dataflow, not jz's un-folded emission.
  for (let i = bodyStart; i < fn.length; i++) fn[i] = foldVecIdentities(fn[i])
  // Canonicalize the `if COND (then (br L))` break idiom to `br_if L COND` (watr's brif shape),
  // so the loop-scan recognizers see the branch form they were tuned against.
  canonicalizeIfBr(fn)

  // Build local-name → wasm-type map.
  const fnLocals = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const d = fn[i]
    if (isArr(d) && d[0] === 'local' && typeof d[1] === 'string' && typeof d[2] === 'string') {
      fnLocals.set(d[1], d[2])
    } else if (isArr(d) && d[0] === 'param' && typeof d[1] === 'string' && typeof d[2] === 'string') {
      fnLocals.set(d[1], d[2])
    }
  }

  // Loop-invariant constant locals — hoistConstantPool's `$…_pg` pool (`set $L (f64.const C)`,
  // written exactly once). name → numeric value, used to resolve a constant `pow` exponent that
  // reached the loop as a pooled local rather than a literal.
  const constLocals = new Map()
  {
    const setCount = new Map()
    const walkC = (n) => {
      if (!isArr(n)) return
      if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string' && n.length === 3) {
        setCount.set(n[1], (setCount.get(n[1]) || 0) + 1)
        if (isArr(n[2]) && n[2][0] === 'f64.const') constLocals.set(n[1], +n[2][1])
      }
      for (let i = 1; i < n.length; i++) walkC(n[i])
    }
    for (let i = bodyStart; i < fn.length; i++) walkC(fn[i])
    for (const [k, c] of setCount) if (c !== 1) constLocals.delete(k)   // multiply-written → not invariant
  }

  const freshIdRef = { next: 0 }
  const newLocalDeclsAll = []
  // Whether a REAL SIMD lift happened (as opposed to the scalar tryStrengthReduceIV
  // fallback below, which also populates newLocalDeclsAll with plain i32 locals) —
  // the caller pins the function's $name/$name$exp boundary wrapper on this, so a
  // false positive here would needlessly block watr's inlineOnce on a non-SIMD fn.
  let simdFired = false

  // Hoist loop-invariant partial products out of unrolled dot reductions (rust/LLVM's
  // mat4 prologue trick). Reassociates the float sum, so tied to the relaxedFma tier;
  // runs BEFORE the dot-pair vectorizer so a hoisted dot drops below DOT_UNROLL steps
  // and stays scalar (faster here than the pack/extract SIMD form — see the lab).
  if (relaxedFma) hoistReductionInvariantsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll)
  vectorizeStraightLineF64DotPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFma)
  // SLP within-iteration store pairs. Sound only with no aliasing typed-array view
  // in the module (else a shifted view could reorder-hazard the packed read/write).
  if (slp && !ctx.features.typedView) slpStorePairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, slpGetCounts(fn))
  if (newLocalDeclsAll.length) simdFired = true

  // Walk body recursively. Process inner-most matches first (post-order)
  // so we don't try to vectorize an outer loop whose inner is the lane-local one.
  function walk(parent, idx) {
    const node = parent[idx]
    if (!isArr(node)) return
    for (let i = 0; i < node.length; i++) {
      if (isArr(node[i])) walk(node, i)
    }
    if (node[0] === 'block') {
      if (_whyNotActive) _whyNotReason = null
      // Recognition layer: match the canonical (block (loop)) scaffold ONCE; the
      // inner-scaffold lifters (memcpy/map/reduce/map-reduce/byte-scan) consume the
      // descriptor instead of each re-matching. The outer-pixel + special-shape
      // recognizers (divergent-escape, ramp-map, blur, channel-reduce, per-pixel)
      // do their own matching on the raw node. Order is preserved exactly — it is
      // load-bearing (first match wins).
      // allowInlinedLi: accept an inlined LICM preamble (`$__inl*___li*`) too — jz's
      // LICM hoists ToInt32/casts of loop-invariant params just before the loop (e.g.
      // `a[i] & m` with a runtime `m`), and after inlining the snap is renamed off the
      // bare `$__li*` form. The preamble is pure & loop-invariant by construction
      // (hasSideEffect-guarded) and cloned ahead of the SIMD block, so this only widens
      // which loops the recognizers see, never changes a lifted result.
      const bl = matchBlockLoop(node, { allowPreamble: true, allowInlinedLi: true })
      let r = tryDivergentEscapeVectorize(node, fnLocals, freshIdRef)
        ?? tryMemCopyFill(bl, fnLocals, freshIdRef)
        ?? tryVectorize(bl, fnLocals, freshIdRef, pureFuncMap, constLocals)
        ?? tryReduceVectorize(bl, fnLocals, freshIdRef, multiAcc)
        ?? tryMapReduceVectorize(bl, fnLocals, freshIdRef)
        ?? tryStencil(node, fnLocals, freshIdRef, stencil)
        ?? tryRampMap(node, fnLocals, freshIdRef)
        ?? (blurMP ? tryBlurMultiPixel(node, fnLocals, freshIdRef) : null)
        ?? tryChannelReduce(node, fnLocals, freshIdRef)
        ?? tryByteScan(bl, fnLocals, freshIdRef)
        ?? tryPerPixelColor(node, fnLocals, freshIdRef, pureFuncMap)
        ?? tryOuterStrip(node, fnLocals, freshIdRef, outerStrip)
        ?? tryIteratedReduce(node, fnLocals, freshIdRef, outerStrip)
        ?? tryConvColumn(node, fnLocals, freshIdRef, outerStrip)
        ?? tryToneMap(bl, fnLocals, freshIdRef, toneMap)
        ?? tryButterfly(node, fnLocals, freshIdRef)
      // --why-not-simd: a canonical loop-shaped candidate that no SIMD pass took.
      // Reported BEFORE the scalar strength-reduce fallback (which fires on most
      // affine loops and would otherwise mask "didn't vectorize"). Diagnostic only.
      if (!r && _whyNotActive && (bl || matchOuterPixelLoop(node))) {
        whyNotN++
        warn('simd-why-not',
          `${fnName}: loop #${whyNotN} not vectorized — ${_whyNotReason || 'no SIMD-liftable shape (loop-carried dependency, non-affine address, or unsupported control flow)'}`,
          { fn: `${fnName}#${whyNotN}` })
      }
      if (r) simdFired = true   // one of the real SIMD recognizers above matched
      if (r) {
        // Mark the consumed subtree: the wrapper REUSES these nodes (scalar tail, and the
        // lane splats alias the original load nodes), so a deferred strength-reduce must
        // never rewrite inside them — it would mutate the lifted lanes through the alias.
        const mark = (n) => { if (isArr(n)) { srConsumed.add(n); for (let i = 0; i < n.length; i++) mark(n[i]) } }
        mark(node)
        parent[idx] = r.wrapper
        newLocalDeclsAll.push(...r.newLocalDecls)
      } else if (bl) {
        // Scalar IV strength-reduction is a non-SIMD fallback — DEFERRED to after the
        // whole walk. Applied eagerly here (post-order = innermost first) it rewrites an
        // inner reduction loop into its wrapper before the ENCLOSING loop's outer
        // recognizers (outer-strip / iterated-reduce / conv-column / tone-map) ever run,
        // and they bail on the non-canonical inner shape — metaballs' pixel loop lost its
        // whole f64x2 outer-strip to an eager strength-reduce of the blob loop.
        deferredSR.push([node, parent, idx, bl])
      }
    }
  }
  const deferredSR = [], srConsumed = new Set()
  _whyNotActive = whyNot
  _relaxF32 = relaxedFma
  _crPow = crPow
  for (let i = bodyStart; i < fn.length; i++) walk(fn, i)
  _whyNotActive = false
  _relaxF32 = false
  _crPow = false
  // Apply the deferred scalar fallback innermost-first (push order), skipping candidates
  // inside any SIMD-consumed subtree (see the mark above), plus a same-slot check for
  // wrappers that replaced the candidate node itself.
  for (const [node, parent, idx, bl] of deferredSR) {
    if (srConsumed.has(node) || parent[idx] !== node) continue
    const r = tryStrengthReduceIV(bl, fnLocals, freshIdRef)
    if (r) { parent[idx] = r.wrapper; newLocalDeclsAll.push(...r.newLocalDecls) }
  }

  if (newLocalDeclsAll.length) {
    // Sibling loops (and the straight-line dot pass) can each lift the SAME source
    // local to an identically-named `$name__v` v128 scratch. Post-order vectorizes
    // innermost-first and an outer loop bails once its inner became a wrapper block,
    // so no two NESTED loops ever share a lift — every collision is between
    // SEQUENTIAL loops, where one shared scratch is correct (each writes its lanes
    // before reading). Declaring a local twice is invalid wasm ("duplicate local"),
    // so keep one decl per name (all dups are the identical `['local', name, 'v128']`).
    fn.splice(bodyStart, 0, ...new Map(newLocalDeclsAll.map(d => [d[1], d])).values())
  }
  return simdFired
}
