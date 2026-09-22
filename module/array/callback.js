/**
 * Callback-invocation strategy for array iteration methods: makeCallback's
 * inline-vs-closure fast path (a literal pure-expression arrow body is
 * inlined with fresh locals, zero closure allocation, zero call_indirect;
 * anything else falls back to ctx.closure.call), callbackArgReps' val-type
 * hints, hoistArrayValue's once-only receiver evaluation, and idxF64/idxArg
 * (skip the f64-convert when a callback's index param is unused).
 *
 * Pure move from module/array.js (pipeline-minimality). Extracted as a leaf
 * (no dependency on array.js): module/array/from.js (Array.from) and
 * module/array/early-exit.js (.some/.every/.find*) both need these names,
 * and array.js's own map/filter/reduce/forEach still need them too —
 * importing back from array.js would create a two-node cycle (mirrors
 * module/collection/durable.js / module/typedarray/elem-tables.js).
 *
 * @module array/callback
 */
import { DBG_INVARIANTS } from '../../src/debug.js'
import { typed, asF64, UNDEF_NAN, temp, throwTypeErrorIR, ptrTypeEq, undefExpr } from '../../src/ir.js'
import { emit, storedValue } from '../../src/bridge.js'
import { valTypeOf } from '../../src/kind.js'
import { typedCtorElemValType } from '../../src/kind-traits.js'
import { plannedTypedStorageCtor } from '../../src/compile/typed-storage-plan.js'
import { extractParams, refsName, REFS_IN_EXPR, T } from '../../src/ast.js'
import { VAL, lookupValType } from '../../src/reps.js'
import { ctx, PTR } from '../../src/ctx.js'
import { valOf as summaryValOf } from '../../src/summary/index.js'

export function hoistArrayValue(arr) {
  const recv = temp('ar')
  return {
    setup: ['local.set', `$${recv}`, asF64(emit(arr))],
    value: typed(['local.get', `$${recv}`], 'f64'),
  }
}

// Capture first; check only after the caller has evaluated its other arguments.
// Even an empty loop must reject a non-callable callback.
export function captureCallback(fn, name = temp('af'), thisArg) {
  ctx.module.include('fn')
  const value = typed(['local.get', `$${name}`], 'f64')
  const known = valTypeOf(fn) === VAL.CLOSURE &&
    ctx.summary?.at(ctx.func.current).mayBeNullishExpr(fn) === false
  const receiver = thisArg === undefined ? null : temp('cbthis')
  const call = args => ctx.closure.call(value, args, false, false,
    receiver && typed(['local.get', `$${receiver}`], 'f64'))
  let setup = ['local.set', `$${name}`, fn == null ? undefExpr() : storedValue(fn)]
  if (receiver) setup = ['block', setup, ['local.set', `$${receiver}`, storedValue(thisArg)]]
  return {
    setup,
    check: known ? ['nop'] : ['if', ['i32.eqz', ['i32.and',
      ['f64.ne', value, value], ptrTypeEq(value, PTR.CLOSURE)]],
      ['then', ['drop', throwTypeErrorIR('call')]]],
    value, dynamic: true, call, stored: call,
  }
}

// Pure-expression check: no statements, binders, control flow, or assignments.
// Inlining is only safe for these — anything else needs the full closure machinery.
const NOT_PURE_OPS = new Set([
  ';', '{}', 'let', 'const', 'var', '=>', 'function', 'return', 'throw',
  'if', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'try', 'catch', 'finally', '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '<<=', '>>=', '>>>=', '||=', '&&=', '??=', '++', '--', 'delete', 'yield', 'await',
])
function isPureExpr(node) {
  if (node == null || typeof node !== 'object' || !Array.isArray(node)) return true
  const op = node[0]
  if (op == null) return true
  if (NOT_PURE_OPS.has(op)) return false
  for (let i = 1; i < node.length; i++) if (!isPureExpr(node[i])) return false
  return true
}

// Substitute variable references in a pure expression. Skips property names on `.` / `?.`
// and object-literal keys on `:`. Body must be pre-checked with isPureExpr.
function substExpr(node, mapping) {
  if (typeof node === 'string') return mapping.has(node) ? mapping.get(node) : node
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === '.' || op === '?.') return [op, substExpr(node[1], mapping), node[2]]
  if (op === ':') return [op, node[1], substExpr(node[2], mapping)]
  const out = [op]
  for (let i = 1; i < node.length; i++) out.push(substExpr(node[i], mapping))
  return out
}

function exprUses(node, name) {
  return refsName(node, name, REFS_IN_EXPR)
}

// Callback factory: returns { setup, call, usedParams } where call(argExprs) emits the invocation.
// Fast path: literal arrow with simple-string params and pure expression body → inline,
// substituting param refs with fresh locals. Zero closure alloc, zero call_indirect, zero
// args-array alloc. Captures resolve naturally to outer locals.
// Slow path: fall back to ctx.closure.call (heap-allocated args array per iteration).
// usedParams: boolean array (fast path only) — callers can skip computing args for unused params.
// elem: `{ index, expr }`, the parameter position that receives the array's
// element and the read it stands for (callbackElem): the inlined local reads
// as that element to the summary, so the body's member reads resolve the
// element's layouts as the loop's own read would.
export function makeCallback(fn, argReps, elem = null, thisArg) {
  if (Array.isArray(fn) && fn[0] === '=>') {
    const raw = extractParams(fn[1])
    const body = fn[2]
    if (raw.every(p => typeof p === 'string') && isPureExpr(body)) {
      const usedParams = raw.map(p => exprUses(body, p))
      // `call` yields the body's value in its own form (an i32 boolean stays
      // i32 for a test); `stored` yields the container store's form (a
      // boolean its atom, a BigInt its planned box), for a result kept as a
      // value: stored into an array, handed to another callback, folded.
      const inline = (argExprs, produce) => {
          const stmts = []
          const mapping = new Map()
          const freshNames = []
          for (let i = 0; i < raw.length; i++) {
            if (!usedParams[i]) { freshNames.push(null); continue }  // skip dead local + arg evaluation
            const fresh = temp('inl')
            mapping.set(raw[i], fresh)
            freshNames.push(fresh)
            const ae = i < argExprs.length && argExprs[i] != null
              ? asF64(argExprs[i])
              : typed(['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]], 'f64')
            stmts.push(['local.set', `$${fresh}`, ae])
          }
          // Emission-minted temp seeds → transient overlay (slice 3c-a class):
          // these `inl_i` names didn't exist at analysis time. The argReps hints
          // (caller knows recv elem val type) ride the overlay so emit(subst)
          // sees `inl_i.val=NUMBER` and elides __to_num/__is_str_key; durable
          // reps stay clean. Every producer (callbackArgReps, upReps) is
          // val (and the tagged-carrier mark) only — a future hint needs its
          // own transient channel, not a durable write, so fail loud rather
          // than drop it silently.
          if (argReps) {
            for (let i = 0; i < raw.length && i < argReps.length; i++) {
              const fresh = freshNames[i]
              if (!fresh || !argReps[i]) continue
              if (DBG_INVARIANTS && Object.keys(argReps[i]).some(k => k !== 'val' && k !== 'tagged'))
                throw new Error(`inline argReps hint carries non-val fields: ${Object.keys(argReps[i])}`)
              if (argReps[i].val) ctx.func.localValTypesOverlay.set(fresh, argReps[i].val)
              if (argReps[i].tagged) (ctx.func.taggedLocals ??= new Set()).add(fresh)
            }
          }
          const subst = substExpr(body, mapping)
          const view = elem && freshNames[elem.index] ? ctx.summary?.at(ctx.func.current) : null
          if (view) view.alias(freshNames[elem.index], elem.expr, false)
          let result
          try { result = produce(subst) } finally { if (view) view.unalias(freshNames[elem.index]) }
          // Preserve i32 result type so callers (truthyIR, etc.) can skip f64↔i32 round-trips.
          const ty = result.type === 'i32' ? 'i32' : 'f64'
          const wrapped = typed(['block', ['result', ty], ...stmts, result], ty)
          // An i32 result carrying ptrKind is an UNBOXED POINTER (a narrowed-return
          // callee: the caller must rebox via this metadata) — the block wrapper must
          // carry it through or downstream asF64 numeric-converts the raw offset
          // (map stored [1104,1128] instead of the objects a named ctor fn returned).
          if (result.ptrKind != null) { wrapped.ptrKind = result.ptrKind; wrapped.ptrAux = result.ptrAux }
          return wrapped
      }
      // The rebuilt body has no plan facts of its own: for a store it names
      // the tagged slot it lands in (representationComputedExprAction).
      const stored = node => {
        if (Array.isArray(node)) ctx.plans.compoundOf.set(node, true)
        return storedValue(node)
      }
      return {
        setup: thisArg === undefined ? ['nop'] : ['drop', asF64(storedValue(thisArg))],
        check: ['nop'],
        usedParams,
        call: (argExprs) => inline(argExprs, emit),
        stored: (argExprs) => inline(argExprs, stored),
      }
    }
  }
  // Fallback: closure call — all params are potentially used; a closure's
  // result already crosses its ABI in the store's form.
  return captureCallback(fn, undefined, thisArg)
}

/** The element a callback's parameter `index` receives: a read of `arr` at a
 *  position the summary does not know, which is every element's kind. */
export const callbackElem = (arr, index = 0) => ({ index, expr: ['[]', arr, T + 'i'] })

// Derive callback argReps from a receiver AST. For .map/.filter/etc., callbacks
// receive (item, idx, arr). idx is always a NUMBER. item depends on recv kind:
//  - VAL.TYPED → NUMBER (BigInt typed-arrays excluded; we don't track elem prec
//    here, but the .typed:[] path handles them, and __to_num elision is safe
//    because BigInt's f64-cast in arithmetic still yields a Number).
//  - VAL.ARRAY whose summary cell names one present kind → that val.
//  - else → no hint (slow path, runtime dispatch as today).
export function callbackArgReps(arr) {
  const idxRep = { val: VAL.NUMBER }
  const arrRep = { val: VAL.ARRAY }
  let itemRep = null
  // A typed element is a Number, or a BigInt64Array's raw i64 payload.
  const typedItem = () => ({ val: typedCtorElemValType(plannedTypedStorageCtor(ctx, arr)) ?? VAL.NUMBER })
  if (typeof arr === 'string') {
    const vt = lookupValType(arr)
    if (vt === VAL.TYPED) itemRep = typedItem()
    else if (vt === VAL.ARRAY) {
      // The summary's element cell carries presence: a nullable element
      // (`xs.map(v => bits(v))`, bits returning null or a string) gets no
      // exact hint, so `b !== null` in the callback stays a real test. The
      // body census (rep.arrayElemValType) names a kind without presence,
      // so it hints nothing (`slots.every(b => b !== null)` folded to true
      // over a null slot: module/array.js's static literal path).
      const ek = ctx.summary?.at(ctx.func.current)?.elemKindOf(arr)
      const elemVt = ek != null ? summaryValOf(ek) : null
      // An element is a tagged slot: a BigInt item arrives boxed.
      if (elemVt) itemRep = elemVt === VAL.BIGINT ? { val: elemVt, tagged: true } : { val: elemVt }
    }
  } else {
    const vt = valTypeOf(arr)
    if (vt === VAL.TYPED) itemRep = typedItem()
  }
  return [itemRep, idxRep, arrRep]
}

export function idxF64(i) { return typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64') }
// Skip f64-convert when callback's index param is unused — saves per-iteration conversion.
export function idxArg(cb, i, slot = 1) {
  return cb.usedParams && !cb.usedParams[slot] ? null : idxF64(i)
}
// The callback's array argument (`(v, i, arr) =>`, reduce's fourth): the
// receiver value, or null when an inlined arrow provably never reads it.
export function arrArg(cb, recvValue, slot = 2) {
  return cb.usedParams && !cb.usedParams[slot] ? null : recvValue
}
// Whether `fn` may read the array argument at `slot`. A literal arrow proves
// the negative by its parameter list; any other callee may read it. A fused
// pipeline (`a.map(f).filter(g)`) never materializes the intermediate array a
// downstream callback would receive, so it fuses only when this is false.
export function callbackReadsArray(fn, slot = 2) {
  if (!Array.isArray(fn) || fn[0] !== '=>') return true
  const params = extractParams(fn[1])
  if (params.some(p => p == null)) return true   // a rest parameter can hold it
  if (params.length <= slot) return false
  const p = params[slot]
  return typeof p !== 'string' || refsName(fn[2], p, REFS_IN_EXPR)
}
