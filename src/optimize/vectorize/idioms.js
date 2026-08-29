import { nodeEqual as exprEq } from '../../ast.js'
import { isI32Const, isLocalGet } from './addr-model.js'
import { LANE_INFO } from './lane-tables.js'
import { isArr, isSplatConst } from './node-utils.js'

export function matchCanonSelect(sel, laneType) {
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
export function normTee(n) {
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
export function matchIntMinMaxReduce(rhs, accName) {
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
export function matchCanonBlock(blk, laneType) {
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

