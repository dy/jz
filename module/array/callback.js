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
import { typed, asF64, UNDEF_NAN, temp, truthyIR } from '../../src/ir.js'
import { emit, storedValue } from '../../src/bridge.js'
import { valTypeOf } from '../../src/kind.js'
import { typedCtorElemValType } from '../../src/kind-traits.js'
import { plannedTypedStorageCtor } from '../../src/compile/typed-storage-plan.js'
import { extractParams, refsName, REFS_IN_EXPR } from '../../src/ast.js'
import { VAL, lookupValType } from '../../src/reps.js'
import { ctx, DBG_INVARIANTS } from '../../src/ctx.js'
import { valOf as summaryValOf } from '../../src/summary/index.js'

export function hoistArrayValue(arr) {
  const recv = temp('ar')
  return {
    setup: ['local.set', `$${recv}`, asF64(emit(arr))],
    value: typed(['local.get', `$${recv}`], 'f64'),
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
export function makeCallback(fn, argReps) {
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
          const result = produce(subst)
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
        setup: ['nop'],
        usedParams,
        call: (argExprs) => inline(argExprs, emit),
        stored: (argExprs) => inline(argExprs, stored),
      }
    }
  }
  // Fallback: closure call — all params are potentially used; a closure's
  // result already crosses its ABI in the store's form.
  const cb = temp('af')
  const call = (argExprs) => ctx.closure.call(typed(['local.get', `$${cb}`], 'f64'), argExprs)
  return {
    setup: ['local.set', `$${cb}`, asF64(emit(fn))],
    value: typed(['local.get', `$${cb}`], 'f64'),
    dynamic: true,
    call,
    stored: call,
  }
}

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
