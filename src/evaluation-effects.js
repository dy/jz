/** Whether evaluating a prepared expression invokes user code implicitly.
 * Shared by frame-effect and bounds proofs; imports no IR emitters. */
import { RELATIONAL_OPS } from './ast.js'
import { ctx } from './ctx.js'
import { COMPOUND_NUMERIC_OPS } from './kind-traits.js'
import { K, tagOf, tagsOf, hasTag, bitOf, NUMBER_OPS } from './summary/kind.js'

export const TO_PRIMITIVE = { string: '__jz_tp_str', number: '__jz_tp_num' }
const CONVERTING_OPS = new Set([...NUMBER_OPS, ...COMPOUND_NUMERIC_OPS, ...RELATIONAL_OPS, 'u-', 'u+', '+', '+=', 'strcat', '==', '!='])
const PRIMITIVE_BITS = [K.NUMBER, K.STRING, K.BOOL, K.BIGINT, K.NULLISH, K.ABSENT].reduce((m, t) => m | bitOf(t), 0)
const isArr = Array.isArray
const isName = x => typeof x === 'string'

/** Whether evaluating `node` itself may run an object literal's getter or
 *  setter, in a program whose lowered code builds one (module/schema.js
 *  viewsOn): a member read or store of an accessor's name, a computed key, or
 *  a spread, over a receiver the summary does not prove holds no object. */
export function runsAccessor(view, node, beforeEmit = false) {
  // Source planning precedes settleViews; its accessor census is already complete.
  if (!isArr(node) || !(beforeEmit ? ctx.transform.literalAccessorNames?.size : ctx.schema.views)) return false
  const op = node[0]
  if (op === '.' || op === '?.') return ctx.transform.literalAccessorNames.has(node[2]) && mayHoldObject(view, node[1])
  if (op === '[]' || op === '?.[]') return node.length === 3 && mayHoldObject(view, node[1])
  if (op === '{}') return node.some((p, i) => i > 0 && isArr(p) && (p[0] === '...' ? mayHoldObject(view, p[1])
    : p[0] === ',' && p.some((q, j) => j > 0 && isArr(q) && q[0] === '...' && mayHoldObject(view, q[1]))))
  return false
}

/** The summary does not prove the expression holds no object. */
function mayHoldObject(view, e) {
  if (!view) return true
  let k
  try { k = view.kindOfExpr(e) } catch { return true }
  return k == null || tagOf(k) === K.ANY || tagOf(k) === K.NONE || hasTag(k, K.OBJECT)
}

/** An array or typed array the summary proves holds only primitives. */
export function primitiveElements(view, e) {
  if (!view) return false
  let k
  try { k = view.kindOfExpr(e) } catch { return false }
  const t = k == null ? null : tagOf(k)
  if (t === K.TYPED) return true
  if (t !== K.ARRAY) return false
  const el = view.elemOfKind(k)
  return el != null && tagsOf(el) !== 0 && (tagsOf(el) & ~PRIMITIVE_BITS) === 0
}

/** The summary proves the expression a primitive: converting it runs no user code. */
export function primitiveKind(view, e) {
  if (!isArr(e) && !isName(e)) return true   // a number or bigint literal
  if (isArr(e) && (e[0] == null || e[0] === 'str' || e[0] === 'bool')) return true
  if (!view) return false
  let k
  try { k = view.kindOfExpr(e) } catch { return false }
  return k != null && tagsOf(k) !== 0 && (tagsOf(k) & ~PRIMITIVE_BITS) === 0
}

/** Whether evaluating `node` itself, once its operands are values, may run a user
 *  toString/valueOf: a converting operator (or key conversion) over an operand the
 *  summary cannot prove primitive, in a program that defines those methods. */
export function runsConversion(view, node, beforeEmit = false) {
  // Source planning precedes synthesis of the runtime conversion functions.
  if (!isArr(node) || !beforeEmit && !ctx.funcs.runtimeRoots?.has(TO_PRIMITIVE.number)) return false
  const op = node[0]
  if (CONVERTING_OPS.has(op)) { for (let i = 1; i < node.length; i++) if (!primitiveKind(view, node[i])) return true; return false }
  if ((op === '[]' || op === '?.[]') && node.length === 3) return !primitiveKind(view, node[2])   // ToPropertyKey
  if ((op === '=' || op === '||=' || op === '&&=' || op === '??=') && !primitiveKind(view, node[2])) {
    const lhs = node[1]
    if (lhs?.[0] === '[]' && mayBeTyped(view, lhs[1])) return true
    // ArraySetLength converts its value too, after evaluating the reference
    // and RHS. A valueOf can rebind that reference or mutate other state.
    const bracket = lhs?.[0] === '[]'
    const length = lhs?.[0] === '.' && lhs[2] === 'length' || bracket &&
      (lhs[2]?.[0] === 'str' ? lhs[2][1] === 'length' : !nonStringPrimitive(view, lhs[2]))
    if (length && mayHaveTag(view, lhs[1], K.ARRAY)) return true
  }
  if (op === 'in') return !primitiveKind(view, node[1])
  return false
}

// Only strings and non-primitives can name an array's length property.
function nonStringPrimitive(view, key) {
  if (!view) return typeof key === 'number'
  let k
  try { k = view.kindOfExpr(key) } catch { return false }
  return k != null && tagsOf(k) !== 0 && (tagsOf(k) & ~(PRIMITIVE_BITS & ~bitOf(K.STRING))) === 0
}

/** The receiver may hold a typed array, whose element store converts the value. */
export function mayBeTyped(view, recv) { return mayHaveTag(view, recv, K.TYPED) }

function mayHaveTag(view, recv, tag) {
  if (!view) return true
  let k
  try { k = view.kindOfExpr(recv) } catch { return true }
  return k == null || tagOf(k) === K.ANY || tagOf(k) === K.NONE || hasTag(k, tag)
}
