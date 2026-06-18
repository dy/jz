import { findBodyStart } from '../ir.js'

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

const exprEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
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
  const neOp = laneType === 'f32' ? 'f32.ne' : 'f64.ne'
  if (!isSplatConst(C, LANE_INFO[laneType].constOp)) return null
  if (!(isArr(cond) && cond[0] === neOp && exprEq(cond[1], val) && exprEq(cond[2], val))) return null
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
  let cond, T, E
  if (rhs[0] === 'if') {
    let i = 1
    if (!(isArr(rhs[i]) && rhs[i][0] === 'result' && rhs[i][1] === 'i32')) return null
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
  const dir = { 'i32.gt_s': 'gt', 'i32.ge_s': 'gt', 'i32.lt_s': 'lt', 'i32.le_s': 'lt' }[cmp[0]]
  if (!dir) return null
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
  return { exprNode: condExpr, isMax: takeExprWhenTrue === predExprGreater }
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

const matchF64DotSeq = (stmts, i) => {
  const reset = stmts[i]
  if (!isArr(reset) || reset[0] !== 'local.set' || typeof reset[1] !== 'string' || !f64Zero(reset[2])) return null
  const acc = reset[1]
  const left = [], right = []
  for (let k = 0; k < 4; k++) {
    const pair = matchAccumStep(stmts[i + 1 + k], acc)
    if (!pair) return null
    left.push(pair[0])
    right.push(pair[1])
  }
  const store = matchDotStore(stmts[i + 5], acc)
  return store ? { end: i + 6, acc, left, right, ...store } : null
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
    for (let k = 0; k < 4; k++) {
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
  ]),
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
function matchLaneOffset(off, ind, offsetTees) {
  if (isArr(off) && off[0] === 'local.get' && typeof off[1] === 'string' &&
      offsetTees && offsetTees.has(off[1])) {
    return { strideLog2: offsetTees.get(off[1]), teeName: null }
  }
  let teeName = null
  let n = off
  if (isArr(n) && n[0] === 'local.tee' && n.length === 3) { teeName = n[1]; n = n[2] }
  // (i32.shl (local.get ind) (i32.const K))
  if (isArr(n) && n[0] === 'i32.shl' && n.length === 3 && isLocalGet(n[1], ind)) {
    const k = constNum(n[2])
    if (k != null && k >= 0 && k <= 3) return { strideLog2: k, teeName }
  }
  // (local.get ind) — stride 1
  if (isLocalGet(n, ind)) return { strideLog2: 0, teeName }
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
function matchLaneAddr(addr, ind, addrLocals, offsetTees) {
  let teeName = null
  let n = addr
  // (local.get $A) where $A holds a previously-tee'd FULL lane-address.
  if (isArr(n) && n[0] === 'local.get' && typeof n[1] === 'string' && addrLocals && addrLocals.has(n[1])) {
    const e = addrLocals.get(n[1])
    return { strideLog2: e.strideLog2, base: e.base, teeName: null, viaLocal: n[1] }
  }
  if (isArr(n) && n[0] === 'local.tee' && n.length === 3) {
    teeName = n[1]
    n = n[2]
  }
  if (!isArr(n) || n[0] !== 'i32.add' || n.length !== 3) return null
  const a = n[1], b = n[2]
  const off = matchLaneOffset(b, ind, offsetTees)
  if (!off) return null
  return { strideLog2: off.strideLog2, base: a, teeName, offsetTeeName: off.teeName }
}

/**
 * A scalar i32 local that is ONLY ever assigned a lane offset — `(i32.shl ind K)`
 * (or bare `ind` for stride 0) — is a CSE'd offset shared across base pointers.
 * Returns the consistent strideLog2, or null if any write to it diverges.
 * This soundness check backs every `(local.get $T)` resolved via `offsetTees`.
 */
function _offsetLocalStride(body, name, ind) {
  let stride = null, found = false, ok = true
  function walk(n) {
    if (!isArr(n)) return
    if ((n[0] === 'local.tee' || n[0] === 'local.set') && n[1] === name && n.length === 3) {
      found = true
      const v = n[2]
      let k = null
      if (isArr(v) && v[0] === 'i32.shl' && v.length === 3 && isLocalGet(v[1], ind)) {
        k = constNum(v[2])
        if (k == null || k < 0 || k > 3) ok = false
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

// True if any node in the tree writes a global. When false for a loop body,
// every `global.get` inside it is loop-invariant — safe to splat for SIMD.
const hasGlobalSet = (node) => {
  if (!isArr(node)) return false
  if (node[0] === 'global.set') return true
  for (let i = 1; i < node.length; i++) if (hasGlobalSet(node[i])) return true
  return false
}

// ---- Recognize a (block (loop)) pair --------------------------------------

/**
 * Try to vectorize the inner loop. Returns the replacement node array
 * (synthetic outer block) or null on no match.
 */
function tryVectorize(blockNode, fnLocals, freshIdRef) {
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null
  // Find label and inner loop.
  let blockLabel = null
  let loopIdx = -1, loopNode = null
  for (let i = 1; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (typeof c === 'string' && c.startsWith('$') && blockLabel == null && i === 1) {
      blockLabel = c; continue
    }
    if (isArr(c) && c[0] === 'loop') {
      if (loopNode) return null  // multiple loops
      loopIdx = i; loopNode = c
    } else if (isArr(c)) {
      return null  // foreign content alongside the loop
    }
  }
  if (!loopNode || !blockLabel) return null

  // Loop layout: ['loop', '$label', ...stmts]
  const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
  if (!loopLabel) return null

  // Find induction increment + back-branch at the END.
  let endIdx = loopNode.length - 1
  if (!(isArr(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return null
  const incIdx = endIdx - 1
  const incVar = matchInc1(loopNode[incIdx])
  if (!incVar) return null

  // First stmt must be the exit br_if.
  const exitInfo = matchExitBrIf(loopNode[2], blockLabel)
  if (!exitInfo) return null
  if (exitInfo.ind !== incVar) return null

  // Body = stmts between exit and increment.
  const body = []
  for (let i = 3; i < incIdx; i++) body.push(loopNode[i])

  // Bound must be loop-invariant. For now, accept (local.get $L) where $L
  // is declared but not written inside the body, OR (i32.const N).
  let bound = exitInfo.bound
  let boundLocal = null
  if (isArr(bound) && bound[0] === 'local.get' && typeof bound[1] === 'string') {
    boundLocal = bound[1]
  } else if (isI32Const(bound)) {
    // ok
  } else {
    return null
  }

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

  function scanForLoadsStores(node, parent, pi) {
    if (!isArr(node)) return true
    const op = node[0]
    if (LOAD_OPS[op]) {
      if (laneType == null) {
        laneType = LOAD_OPS[op]
        stride = LANE_INFO[laneType].stride
      } else if (LOAD_OPS[op] !== laneType) {
        return false
      }
      const m = matchLaneAddr(node[1], incVar, addrLocals, offsetTees)
      if (!m) return false
      if ((1 << m.strideLog2) !== stride) return false
      if (m.teeName) addrLocals.set(m.teeName, { strideLog2: m.strideLog2, base: m.base })
      if (m.offsetTeeName) offsetTees.set(m.offsetTeeName, m.strideLog2)
      loadStoreSites.push({ parent, idx: pi, kind: 'load' })
      return true
    }
    if (STORE_OPS[op]) {
      const sty = STORE_OPS[op]
      if (laneType != null && sty !== laneType) return false
      if (laneType == null) { laneType = sty; stride = LANE_INFO[laneType].stride }
      const m = matchLaneAddr(node[1], incVar, addrLocals, offsetTees)
      if (!m) return false
      if ((1 << m.strideLog2) !== stride) return false
      if (m.teeName) addrLocals.set(m.teeName, { strideLog2: m.strideLog2, base: m.base })
      if (m.offsetTeeName) offsetTees.set(m.offsetTeeName, m.strideLog2)
      loadStoreSites.push({ parent, idx: pi, kind: 'store' })
      // Recurse into VALUE child (idx 2) — it's data, not address.
      if (!scanForLoadsStores(node[2], node, 2)) return false
      return true
    }
    // local.set/tee of an address local outside a load/store context (e.g.
    // `(local.set $a (i32.add base (i32.shl i 2)))` as a standalone stmt) —
    // record so a later `(local.get $a)` resolves.
    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string' && node.length === 3) {
      const valM = matchLaneAddr(['local.tee', node[1], node[2]], incVar, addrLocals, offsetTees)
      if (valM && valM.teeName) {
        addrLocals.set(valM.teeName, { strideLog2: valM.strideLog2, base: valM.base })
      }
      // Standalone offset compute: `(local.set $t (i32.shl i K))`.
      const offM = matchLaneOffset(node[2], incVar, offsetTees)
      if (offM) offsetTees.set(node[1], offM.strideLog2)
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

  // Soundness gate for offset-tee resolution: every `(local.get $T)` we
  // accepted as `i << K` is only valid if EVERY write of $T is that offset.
  for (const [name, k] of offsetTees) {
    if (_offsetLocalStride(body, name, incVar) !== k) return null
  }

  // Classify all locals referenced in body.
  // - induction var (incVar): exempt
  // - bound local (if any): must be invariant
  // - each other local: first access must not be a read-then-written pattern
  const writes = new Set()
  for (const s of body) collectWrites(s, writes)
  if (boundLocal && writes.has(boundLocal)) return null  // bound varies in body → bail

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
      if (decl === 'i32' && (offsetTees.has(name) || _isAddressLocal(body, name, incVar))) {
        localKind.set(name, 'addr')
      } else {
        localKind.set(name, 'lane')
      }
    } else {
      localKind.set(name, 'invariant')
    }
  }

  // Build lifted body. If anything fails to lift, bail.
  const newLanedLocals = new Map()  // origName → { laneName, simdType }
  const extraLocals = []  // canon temps allocated during lift
  const ctx = { laneType, incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, newLanedLocals, extraLocals, freshIdRef, fail: false, failReason: null }
  const lifted = []
  for (const s of body) {
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

  // Bound setup: simdBoundName = bound & ~(lanes-1)
  const boundSetup = ['local.set', simdBoundName,
    ['i32.and', boundExpr, ['i32.const', mask]]]

  // Synthetic outer wrapper — has no result, no label, just sequences.
  // The original block is preserved unchanged as the tail.
  const wrapper = ['block', boundSetup, simdBlock, blockNode]

  // Locals to add to function header.
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ...[...newLanedLocals.values()].map(({ laneName }) => ['local', laneName, 'v128']),
    ...extraLocals,
  ]

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
function tryReduceVectorize(blockNode, fnLocals, freshIdRef, multiAcc = false) {
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null

  // Match outer (block (loop)) structure. Same loop-shape as tryVectorize.
  let blockLabel = null
  let loopNode = null
  for (let i = 1; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (typeof c === 'string' && c.startsWith('$') && blockLabel == null && i === 1) { blockLabel = c; continue }
    if (isArr(c) && c[0] === 'loop') {
      if (loopNode) return null
      loopNode = c
    } else if (isArr(c)) return null
  }
  if (!loopNode || !blockLabel) return null
  const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
  if (!loopLabel) return null
  const endIdx = loopNode.length - 1
  if (!(isArr(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return null
  const incIdx = endIdx - 1
  const incVar = matchInc1(loopNode[incIdx])
  if (!incVar) return null
  const exitInfo = matchExitBrIf(loopNode[2], blockLabel)
  if (!exitInfo) return null
  if (exitInfo.ind !== incVar) return null

  // Body is either a bare single-statement reduction —
  //   (local.set $acc (OP (local.get $acc) EXPR))            add/xor/and/or
  // — or a NaN-canonicalized two-statement min/max reduction —
  //   (local.set $cn  (OP (local.get $acc) EXPR))
  //   (local.set $acc (select C (local.get $cn) (T.ne $cn $cn)))
  const bodyLen = incIdx - 3
  let accName, opName, reduceEntry, exprNode, canonC = null
  if (bodyLen === 1) {
    const stmt = loopNode[3]
    if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
    accName = stmt[1]
    if (typeof accName !== 'string') return null
    const rhs = stmt[2]
    if (!isArr(rhs)) return null
    const minmax = matchIntMinMaxReduce(rhs, accName)
    if (minmax) {
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
    const s1 = loopNode[3], s2 = loopNode[4]
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

  // Bound classification (same as tryVectorize).
  let bound = exitInfo.bound
  let boundLocal = null
  if (isArr(bound) && bound[0] === 'local.get' && typeof bound[1] === 'string') boundLocal = bound[1]
  else if (!isI32Const(bound)) return null

  // Scan EXPR for lane-aligned loads. Stores forbidden. Re-references of
  // accName forbidden (the accumulator only appears in the outer wrapper).
  const laneType = widen ? widen.laneType : reduceEntry.laneType
  const stride = LANE_INFO[laneType].stride
  const addrLocals = new Map()
  const offsetTees = new Map()
  let loadCount = 0
  function scanExpr(node) {
    if (!isArr(node)) return true
    const op = node[0]
    if (LOAD_OPS[op]) {
      if (LOAD_OPS[op] !== laneType) return false
      const m = matchLaneAddr(node[1], incVar, addrLocals, offsetTees)
      if (!m) return false
      if ((1 << m.strideLog2) !== stride) return false
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

  const ctx = { laneType, incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, newLanedLocals: new Map(), extraLocals: [], freshIdRef, fail: false, failReason: null }
  const liftedExpr = liftExprV(exprNode, ctx)
  if (ctx.fail) return null
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
  const plainReduce = !reduceEntry.minmaxSelect && !widen && canonC == null
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
    // No scalar i32.max/min — fold via select through an i32 temp (no exponential
    // operand duplication): ht = lane0; ht = minmax(ht, lane_k); acc = minmax(acc, ht).
    // `select(a,b,(gt|lt)_s a b)` = a when it's the larger/smaller, i.e. minmax(a,b).
    const cmpOp = reduceEntry.isMax ? 'i32.gt_s' : 'i32.lt_s'
    const ht = `$__simd_h${id}`
    extraDecls.push(['local', ht, 'i32'])
    const lane = (k) => [reduceEntry.extract, k, ['local.get', simdAccName]]
    const minmaxSel = (a, b) => ['select', a, b, [cmpOp, a, b]]
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
  const wrapper = ['block', boundSetup, ...core, blockNode]
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ['local', simdAccName, 'v128'],
    ...Array.from({ length: NACC - 1 }, (_, k) => ['local', accK(k + 1), 'v128']),
    ...extraDecls,
  ]
  return { wrapper, newLocalDecls }
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

// ---- Lifter ----------------------------------------------------------------

function getOrAllocLanedLocal(name, ctx) {
  let r = ctx.newLanedLocals.get(name)
  if (!r) {
    r = { laneName: `${name}__v`, origName: name }
    ctx.newLanedLocals.set(name, r)
  }
  return r
}

// Wrap an already-lifted v128 value `coreV` in per-lane NaN canonicalization:
//   v128.bitselect(splat(C), coreV, laneNe(coreV, coreV))
// coreV is referenced three times. When it's a bare local.get (the common
// flattened form, where the core was already hoisted to a temp) we share it
// directly — matching the scalar select, which likewise reads the temp thrice.
// Otherwise we materialize a fresh v128 temp so the core evaluates once.
function liftCanon(coreV, C, ctx, info) {
  const laneNe = ctx.laneType === 'f32' ? 'f32x4.ne' : 'f64x2.ne'
  const splatC = [info.splat, C]
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

/** Lift a statement. Returns lifted stmt, or null to skip, or ['__seq__', ...] for multiple. */
function liftStmt(stmt, ctx) {
  if (!isArr(stmt)) {
    // Bare strings like "drop" — produced by stack-form WAT. We unwrap value-blocks
    // separately so an isolated "drop" should not appear here, but tolerate it.
    if (stmt === 'drop') return null
    ctx.fail = true; return null
  }
  const op = stmt[0]

  if (op === 'local.set' && typeof stmt[1] === 'string' && stmt.length === 3) {
    const name = stmt[1]
    const kind = ctx.localKind.get(name)
    if (kind === 'addr') {
      // Address-only local: lift the value as-is (it's i32 arithmetic on ind).
      return ['local.set', name, stmt[2]]
    }
    if (kind === 'lane') {
      const { laneName } = getOrAllocLanedLocal(name, ctx)
      const v = liftExprV(stmt[2], ctx)
      if (ctx.fail) return null
      return ['local.set', laneName, v]
    }
    ctx.fail = true; return null
  }

  if (STORE_OPS[op]) {
    const simdStore = 'v128.store'
    const addr = stmt[1]  // we leave addresses as-is (scalar i32 expressions)
    const val = liftExprV(stmt[2], ctx)
    if (ctx.fail) return null
    // Handle memarg if present (last positional after addr/val): unlikely in
    // pre-watr IR for this shape; bail if more than 3 children.
    if (stmt.length !== 3) { ctx.fail = true; return null }
    return [simdStore, addr, val]
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

  // Standalone expression-as-statement (e.g. a load that gets dropped) — bail.
  ctx.fail = true; return null
}

/** Lift a value expression into v128 context. */
function liftExprV(expr, ctx) {
  if (!isArr(expr)) { ctx.fail = true; return null }
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

  // Loads → v128.load (preserving address, including any local.tee).
  if (LOAD_OPS[op]) {
    if (LOAD_OPS[op] !== ctx.laneType) { ctx.fail = true; return null }
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
      const { laneName } = getOrAllocLanedLocal(name, ctx)
      return ['local.get', laneName]
    }
    if (kind === 'invariant') {
      return [info.splat, ['local.get', name]]
    }
    if (kind === 'addr' || name === ctx.incVar) {
      ctx.fail = true; return null  // can't be in a value position
    }
    ctx.fail = true; return null
  }

  // Loop-invariant global (e.g. a hoistConstantPool'd const, or any global the
  // loop never writes) → splat. The recognizer bails when the body contains a
  // global.set, so every global.get reaching here is invariant across lanes.
  if (op === 'global.get' && typeof expr[1] === 'string') {
    return [info.splat, expr]
  }

  // NaN-canonicalization wrapper (float lanes only; integer lanes never carry
  // it). Both the flattened `select` form and the un-flattened `block` form
  // lift to a per-lane v128.bitselect — canonical value in NaN lanes, X
  // elsewhere — exactly reproducing the scalar canonicalization lane-by-lane.
  if (ctx.laneType === 'f64' || ctx.laneType === 'f32') {
    if (op === 'select') {
      const m = matchCanonSelect(expr, ctx.laneType)
      if (!m) { ctx.fail = true; return null }
      const coreV = liftExprV(m.val, ctx)
      return ctx.fail ? null : liftCanon(coreV, m.C, ctx, info)
    }
    if (op === 'block') {
      const m = matchCanonBlock(expr, ctx.laneType)
      if (!m) { ctx.fail = true; return null }
      const coreV = liftExprV(m.core, ctx)
      return ctx.fail ? null : liftCanon(coreV, m.C, ctx, info)
    }
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
    if (!isArr(expr[1]) || expr[1][0] !== 'result' || expr[1][1] !== ctx.laneType) { ctx.fail = true; return null }
    const thenN = expr[3], elseN = expr[4]
    if (!isArr(thenN) || thenN[0] !== 'then' || thenN.length !== 2) { ctx.fail = true; return null }
    if (!isArr(elseN) || elseN[0] !== 'else' || elseN.length !== 2) { ctx.fail = true; return null }
    let cond = expr[2]
    if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]  // strip `!= 0`
    const cmpSimd = isArr(cond) && cond.length === 3 ? LANE_COMPARE[ctx.laneType]?.[cond[0]] : null
    if (!cmpSimd) { ctx.fail = true; return null }
    const ca = liftExprV(cond[1], ctx); if (ctx.fail) return null
    const cb = liftExprV(cond[2], ctx); if (ctx.fail) return null
    const x = liftExprV(thenN[1], ctx); if (ctx.fail) return null
    const y = liftExprV(elseN[1], ctx); if (ctx.fail) return null
    const mtmp = `$__mask${ctx.freshIdRef.next++}`
    ctx.extraLocals.push(['local', mtmp, 'v128'])
    return ['block', ['result', 'v128'],
      ['local.set', mtmp, [cmpSimd, ca, cb]],
      ['v128.bitselect', x, y, ['local.get', mtmp]]]
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
        ctx.fail = true; return null
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

  ctx.fail = true; return null
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
function tryStrengthReduceIV(blockNode, fnLocals, freshIdRef) {
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null
  let blockLabel = null, loopNode = null
  for (let i = 1; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (typeof c === 'string' && c.startsWith('$') && blockLabel == null && i === 1) { blockLabel = c; continue }
    if (isArr(c) && c[0] === 'loop') { if (loopNode) return null; loopNode = c }
    else if (isArr(c)) return null
  }
  if (!loopNode || !blockLabel) return null
  const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
  if (!loopLabel) return null
  const endIdx = loopNode.length - 1
  if (!(isArr(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return null
  const incIdx = endIdx - 1
  const incVar = matchInc1(loopNode[incIdx])
  if (!incVar) return null
  const exitInfo = matchExitBrIf(loopNode[2], blockLabel)
  if (!exitInfo || exitInfo.ind !== incVar) return null

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
  return { wrapper: ['block', ...preInits, blockNode], newLocalDecls }
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
function tryMemCopyFill(blockNode, fnLocals, freshIdRef) {
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null
  let blockLabel = null, loopNode = null
  for (let i = 1; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (typeof c === 'string' && c.startsWith('$') && blockLabel == null && i === 1) { blockLabel = c; continue }
    if (isArr(c) && c[0] === 'loop') { if (loopNode) return null; loopNode = c }
    else if (isArr(c)) return null
  }
  if (!loopNode || !blockLabel) return null
  const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
  if (!loopLabel) return null
  // Shape: [loop, $l, boundExit, (set,)? store, inc, br] — 1- or 2-statement body.
  if (loopNode.length !== 6 && loopNode.length !== 7) return null
  const endIdx = loopNode.length - 1
  if (!(isArr(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return null
  const incVar = matchInc1(loopNode[endIdx - 1])
  if (!incVar) return null
  const exitInfo = matchExitBrIf(loopNode[2], blockLabel)
  if (!exitInfo || exitInfo.ind !== incVar) return null
  const bound = exitInfo.bound
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
      ['else', blockNode]]]
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
function tryByteScan(blockNode, fnLocals, freshIdRef) {
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null
  let blockLabel = null, loopNode = null
  for (let i = 1; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (typeof c === 'string' && c.startsWith('$') && blockLabel == null && i === 1) { blockLabel = c; continue }
    if (isArr(c) && c[0] === 'loop') { if (loopNode) return null; loopNode = c }
    else if (isArr(c)) return null
  }
  if (!loopNode || !blockLabel) return null
  const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
  if (!loopLabel) return null
  // Exact shape: [loop, $l, boundExit, matchExit, inc, br] — nothing else.
  if (loopNode.length !== 6) return null
  if (!(isArr(loopNode[5]) && loopNode[5][0] === 'br' && loopNode[5][1] === loopLabel)) return null
  const incVar = matchInc1(loopNode[4])
  if (!incVar) return null
  const exitInfo = matchExitBrIf(loopNode[2], blockLabel)    // (br_if $b (eqz (i < bound)))
  if (!exitInfo || exitInfo.ind !== incVar) return null
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
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null
  // Envelope: (block $brk (loop $L …)) — identical to tryVectorize.
  let blockLabel = null, loopNode = null
  for (let i = 1; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (typeof c === 'string' && c.startsWith('$') && blockLabel == null && i === 1) { blockLabel = c; continue }
    if (isArr(c) && c[0] === 'loop') { if (loopNode) return null; loopNode = c }
    else if (isArr(c)) return null
  }
  if (!loopNode || !blockLabel) return null
  const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
  if (!loopLabel) return null

  // End = (br $L); preceded by a run of trailing `x += C` increments.
  const endIdx = loopNode.length - 1
  if (!(isArr(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return null
  const increments = []
  let bodyEnd = endIdx - 1
  while (bodyEnd >= 2) {
    const inc = matchIncN(loopNode[bodyEnd])
    if (!inc) break
    increments.unshift(inc)
    bodyEnd--
  }
  if (!increments.length) return null

  // First stmt = exit guard → logical IV + bound. IV must advance by exactly 1.
  const exitInfo = matchExitBrIf(loopNode[2], blockLabel)
  if (!exitInfo) return null
  const ivName = exitInfo.ind
  const ivInc = increments.find(x => x.name === ivName)
  if (!ivInc || ivInc.c !== 1) return null
  let bound = exitInfo.bound, boundLocal = null
  if (isArr(bound) && bound[0] === 'local.get' && typeof bound[1] === 'string') boundLocal = bound[1]
  else if (!isI32Const(bound)) return null

  const body = []
  for (let i = 3; i <= bodyEnd; i++) body.push(loopNode[i])
  if (!body.length) return null
  if (body.some(hasGlobalSet)) return null

  // Find exactly one store. Its address is the inline lane address
  // `base + (i << K)` — the IV strength-reducer runs AFTER this pass, so the
  // pointer is still expressed in terms of the IV. We keep the address verbatim
  // (scalar i32) and advance the IV by LANES, so `base + (i<<K)` lands on the
  // next group's first element each SIMD step — for any element width.
  let storeStmt = null, storeIdx = -1
  for (let i = 0; i < body.length; i++) {
    const s = body[i]
    if (isArr(s) && STORE_OPS[s[0]]) {
      if (storeStmt) return null
      storeStmt = s; storeIdx = i
    }
  }
  if (!storeStmt) return null
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

  const storeAddr = storeStmt[1]
  const addrM = matchLaneAddr(storeAddr, ivName, new Map(), offsetTees)
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
      const m = matchLaneAddr(n[1], ivName, new Map(), offsetTees)
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
  const ctx = { laneType: 'i32', incVar: ivName, rampVar: ivName, rampTemp: null, widenLoads: true, localKind, newLanedLocals, extraLocals, freshIdRef, fail: false, failReason: null }

  // A byte store fed by one value expression (inline, or via a single lane-local
  // temp `tw = EXPR; store(addr, tw)`) carries no loop-carried state, so we can
  // run the lane group 4× (16 samples) per iteration off four offset ramps and
  // pack the low bytes into ONE i8x16 v128.store — amortizing store + loop
  // overhead the way clang/zig's 16-wide NEON does. wideValueExpr is the
  // expression to lift per offset; null (i32 stores, multi-stmt bodies, or
  // widening loads — whose addresses would need per-offset advancing) → 4-wide.
  const wideValueExpr = (() => {
    if (storeOp !== 'i32.store8' || hasLoads) return null
    if (body.length === 1 && storeIdx === 0) return storeStmt[2]
    if (body.length === 2 && storeIdx === 1) {
      const set = body[0], sv = storeStmt[2]
      if (isArr(set) && set[0] === 'local.set' && set.length === 3 &&
          isLocalGet(sv, set[1]) && localKind.get(set[1]) === 'lane') return set[2]
    }
    return null
  })()
  const WIDE16 = wideValueExpr != null
  const LANES = WIDE16 ? 16 : 4
  const ramp = (off) => ['i32x4.add', ['i32x4.splat', ['local.get', ivName]],
    ['v128.const', 'i32x4', String(off), String(off + 1), String(off + 2), String(off + 3)]]

  let lifted
  if (WIDE16) {
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
  if (!lifted.length) return null

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
  const boundSetup = ['local.set', simdBoundName, ['i32.and', boundExpr, ['i32.const', -LANES]]]
  const wrapper = ['block', boundSetup, simdBlock, blockNode]
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ...[...newLanedLocals.values()].map(({ laneName }) => ['local', laneName, 'v128']),
    ...extraLocals,
  ]
  return { wrapper, newLocalDecls }
}

// Build the store for a ramp-map iteration: i32x4 `vval` → element width of
// `storeOp` at scalar address `addr`. i32.store is the full vector; i32.store8
// truncates (low byte of each lane) via i8x16.shuffle — exactly matching scalar
// store8, with no value-range assumption (shuffle selects, never saturates).
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
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null
  let blockLabel = null, loopNode = null
  for (let i = 1; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (typeof c === 'string' && c.startsWith('$') && blockLabel == null && i === 1) { blockLabel = c; continue }
    if (isArr(c) && c[0] === 'loop') { if (loopNode) return null; loopNode = c }
  }
  if (!loopNode || !blockLabel) return null
  const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
  if (!loopLabel) return null
  const endIdx = loopNode.length - 1
  if (!(isArr(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return null
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

  // the RGBA store: 4 consecutive i32.store8 at `ab1 + c`, ab1 tee'd in the first.
  let storeIdx = -1
  for (let i = innerIdx + 1; i + 3 <= bodyEnd; i++) {
    const s0 = loopNode[i]
    if (isArr(s0) && s0[0] === 'i32.store8' && s0.length === 3 && isArr(s0[1]) && s0[1][0] === 'local.tee') { storeIdx = i; break }
  }
  if (storeIdx < 0) return null
  const s0 = loopNode[storeIdx]
  const ab1 = s0[1][1], dstExpr = s0[1][2]      // ab1 local, its address expr
  const storeVals = [s0[2]]
  for (let c = 1; c < 4; c++) {
    const s = loopNode[storeIdx + c]
    if (!(isArr(s) && s[0] === 'i32.store8' && s[1] === `offset=${c}` && isLocalGet(s[2], ab1))) return null
    storeVals.push(s[3])
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
  const preStore = loopNode.slice(innerIdx + 1, storeIdx)   // `o = (row+x)<<2` etc.
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
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null
  // Outer pixel loop: (block $brk [invariant preamble…] (loop $L …)). When the
  // pixel loop is nested in an outer row loop, LICM hoists the invariant edge-clamp
  // bound (`w-1`) into this block ahead of the loop; allow any such non-loop
  // preamble — it is preserved verbatim by the wrapper rebuild, which rewrites only
  // the loop. Exactly one loop is still required (a second → bail).
  let blockLabel = null, loopNode = null
  for (let i = 1; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (typeof c === 'string' && c.startsWith('$') && blockLabel == null && i === 1) { blockLabel = c; continue }
    if (isArr(c) && c[0] === 'loop') { if (loopNode) return null; loopNode = c }
  }
  if (!loopNode || !blockLabel) return null
  const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
  if (!loopLabel) return null
  const endIdx = loopNode.length - 1
  if (!(isArr(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return null

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

function tryDivergentEscapeVectorize(blockNode, fnLocals, freshIdRef) {
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null
  const oLabel = (typeof blockNode[1] === 'string' && blockNode[1].startsWith('$')) ? blockNode[1] : null
  if (!oLabel) return null
  // Block may carry LICM-hoisted invariants (`local.set …`) before the loop; they
  // feed both the SIMD path and the scalar tail, so capture them as a preamble.
  let loopNode = null, loopPos = -1
  for (let i = 2; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (!isArr(c)) return null
    if (c[0] === 'loop') { if (loopNode) return null; loopNode = c; loopPos = i }
    else if (loopNode) return null              // statement after the loop → bail
    else if (c[0] !== 'local.set') return null  // preamble must be pure local.set
  }
  if (!loopNode) return null
  const preamble = blockNode.slice(2, loopPos)
  const llabel = (typeof loopNode[1] === 'string' && loopNode[1].startsWith('$')) ? loopNode[1] : null
  if (!llabel) return null
  const oEnd = loopNode.length - 1
  if (!(isArr(loopNode[oEnd]) && loopNode[oEnd][0] === 'br' && loopNode[oEnd][1] === llabel)) return null
  // Trailing `v += 1` statements are the pixel IVs (loop IV + parallel counters like `j`).
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
  const pxVar = oExit.ind                       // the loop-bound pixel IV
  const widthBound = oExit.bound
  const pivType = new Map(pixelIVs.map(p => [p.name, p.type]))
  // The bound is re-evaluated for the SIMD guard, so it must be invariant + pure:
  // a constant, or a local/global that the loop nest never writes.
  if (isI32Const(widthBound)) { /* ok */ }
  else if (isArr(widthBound) && (widthBound[0] === 'local.get' || widthBound[0] === 'global.get')) {
    const setOp = widthBound[0] === 'local.get' ? 'local.set' : 'global.set'
    const writes = (n) => isArr(n) && (((n[0] === setOp || (setOp === 'local.set' && n[0] === 'local.tee')) && n[1] === widthBound[1]) || n.some(writes))
    if (writes(loopNode)) return null
  } else return null

  const obody = loopNode.slice(3, pivStart)     // between exit guard and the pixel-IV bumps
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
  const breakCond = (s) => {
    if (!isArr(s)) return null
    if (s[0] === 'br_if' && s[1] === iLabel) return s[2]
    if (s[0] === 'if' && s.length === 3 && isArr(s[2]) && s[2][0] === 'then' && s[2].length === 2 &&
        isArr(s[2][1]) && s[2][1][0] === 'br' && s[2][1][1] === iLabel) return s[1]
    return null
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
  const topBc = breakCond(innerLoop[2])
  let keepTop = topBc && keepOf(topBc)
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
  if (compoundTop) {
    for (let i = 0; i < ibody.length; i++)
      if (!(isArr(ibody[i]) && ibody[i][0] === 'local.set' && ibody[i].length === 3 && fnLocals.get(ibody[i][1]) === 'f64')) return null
  } else {
    for (let i = 0; i < ibody.length; i++) {
      const bc = breakCond(ibody[i])
      if (bc) { if (midIdx >= 0) return null; midIdx = i; keepMid = keepOf(bc); if (!keepMid) return null }
      else if (!(isArr(ibody[i]) && ibody[i][0] === 'local.set' && ibody[i].length === 3 && fnLocals.get(ibody[i][1]) === 'f64')) return null
    }
    if (midIdx < 0) return null
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
  const keepMidC = { cmp: [keepMid.cmp[0], detee(keepMid.cmp[1]), detee(keepMid.cmp[2])], negate: keepMid.negate }

  // each keep is an it-limit (mentions `it` directly or via convert) or a z-escape; need one of each
  const isIt = (n) => isLocalGet(n, itVar) || (isArr(n) && n[0] === 'f64.convert_i32_s' && isLocalGet(n[1], itVar))
  const kindOf = (k) => (isIt(k.cmp[1]) || isIt(k.cmp[2])) ? 'limit' : 'escape'
  const kTop = kindOf(keepTopC), kMid = kindOf(keepMidC)
  if (kTop === kMid) return null
  const limitKeep = kTop === 'limit' ? keepTopC : keepMidC
  const itLeft = isIt(limitKeep.cmp[1])
  const boundExpr = itLeft ? limitKeep.cmp[2] : limitKeep.cmp[1]
  const boundI32 = limitKeep.cmp[0].startsWith('i32.')
  // limit bound must be loop-invariant (splatted once per pair): no carried/temp ref, not written
  for (const v of [...carried, ...temp]) if (readsVar(boundExpr, v)) return null
  const boundInvariant = (n) => !isArr(n) || ((n[0] !== 'local.get' && n[0] !== 'global.get') || !writesName(loopNode, n[1])) && n.every((c, i) => i === 0 || boundInvariant(c))
  if (!boundInvariant(boundExpr)) return null

  // c-vars: f64 locals read in the lifted exprs but never written there (per-pixel/invariant inputs)
  const cVars = new Set()
  const liftable = (n) => {
    if (!isArr(n)) return false
    if (n[0] === 'local.get') {
      const v = n[1]
      if (v !== itVar && !carried.has(v) && !temp.has(v)) { if (fnLocals.get(v) !== 'f64') return false; cVars.add(v) }
      return true
    }
    if (n[0] === 'f64.const') return true
    if (LANE_PURE.f64.has(n[0])) { for (let i = 1; i < n.length; i++) if (!liftable(n[i])) return false; return true }
    return false
  }
  for (const t of tees) if (!liftable(t.expr)) return null
  for (let i = 0; i < ibody.length; i++) if (i !== midIdx && !liftable(ibody[i][2])) return null
  const escapeKeep = kTop === 'escape' ? keepTopC : keepMidC
  if (!liftable(escapeKeep.cmp[1]) || !liftable(escapeKeep.cmp[2])) return null

  // ---- pre-inner inits + epilogue ----
  const carriedInit = new Map()   // carried var → its f64.const seed (before the loop)
  const perPxInit = new Map()     // c-var → its per-pixel init expr
  for (let i = 0; i < innerIdx; i++) {
    const s = obody[i]
    if (!isArr(s) || s[0] !== 'local.set' || s.length !== 3) return null
    const tgt = s[1]
    if (carried.has(tgt)) {
      // z₀ seed: a constant (mandelbrot/burning-ship z₀=0) OR a per-pixel expr (Julia set, where
      // z₀ = the pixel and c is constant — the dual of mandelbrot). liftCLane handles both at emit.
      carriedInit.set(tgt, s[2])
    } else if (temp.has(tgt)) { /* recomputed each iteration — init ignored */ }
    else if (tgt === itVar) { if (constNum(s[2]) !== 0) return null }
    else if (cVars.has(tgt)) perPxInit.set(tgt, s[2])
    else return null
  }
  for (const c of carried) if (!carriedInit.has(c)) return null
  const epilogue = obody.slice(innerIdx + 1)
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
  // the loop head — a `while (|z|²<T)` (mandelbrot) or the second half of a compound `while (it<MAX
  // && |z|²<T)` (Julia). Both take the fast path; only the tail's `it` resume point differs.
  const escAtMid = !compoundTop && kMid === 'escape' && midIdx === ibody.length - 1
  const escAtTop = compoundTop || kTop === 'escape'
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

// ---- Pass entry ------------------------------------------------------------

/**
 * Walk a function looking for vectorizable (block (loop)) pairs, in-place.
 * Adds new locals to the function header.
 */
export function vectorizeLaneLocal(fn, multiAcc = false, relaxedFma = false, blurMP = true) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

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

  const freshIdRef = { next: 0 }
  const newLocalDeclsAll = []

  vectorizeStraightLineF64DotPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFma)

  // Walk body recursively. Process inner-most matches first (post-order)
  // so we don't try to vectorize an outer loop whose inner is the lane-local one.
  function walk(parent, idx) {
    const node = parent[idx]
    if (!isArr(node)) return
    for (let i = 0; i < node.length; i++) {
      if (isArr(node[i])) walk(node, i)
    }
    if (node[0] === 'block') {
      const r = tryDivergentEscapeVectorize(node, fnLocals, freshIdRef)
        ?? tryMemCopyFill(node, fnLocals, freshIdRef)
        ?? tryVectorize(node, fnLocals, freshIdRef)
        ?? tryReduceVectorize(node, fnLocals, freshIdRef, multiAcc)
        ?? tryRampMap(node, fnLocals, freshIdRef)
        ?? (blurMP ? tryBlurMultiPixel(node, fnLocals, freshIdRef) : null)
        ?? tryChannelReduce(node, fnLocals, freshIdRef)
        ?? tryByteScan(node, fnLocals, freshIdRef)
        ?? tryStrengthReduceIV(node, fnLocals, freshIdRef)
      if (r) {
        parent[idx] = r.wrapper
        newLocalDeclsAll.push(...r.newLocalDecls)
      }
    }
  }
  for (let i = bodyStart; i < fn.length; i++) walk(fn, i)

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
}
