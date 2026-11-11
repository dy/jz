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
import { arrayLoop, typed, asF64, UNDEF_NAN, temp, throwTypeErrorIR, ptrTypeEq, undefExpr } from '../../src/ir.js'
import { emit, emitVoid, storedValue } from '../../src/bridge.js'
import { bodyParts, declaredNames, runsInPlace } from '../../src/compile/in-place.js'
import { withControlFrame } from '../../src/compile/flow-state.js'
import { valTypeOf } from '../../src/kind.js'
import { typedCtorElemValType } from '../../src/kind-traits.js'
import { plannedTypedStorageCtor } from '../../src/compile/typed-storage-plan.js'
import { representationProgramHasBigint } from '../../src/compile/representation-plan.js'
import { extractParams, isUndefinedLiteral, refsName, REFS_IN_EXPR, T } from '../../src/ast.js'
import { VAL, lookupValType } from '../../src/reps.js'
import { ctx, PTR } from '../../src/ctx.js'
import { valOf as summaryValOf } from '../../src/summary/index.js'
import { K, hasTag } from '../../src/summary/kind.js'
import { withRefinements } from '../../src/compile/flow-types.js'

// Callback methods retain the initial bound and observe receiver mutations.
// The visit sees the counter inside that bound (an i32 length where the
// summary fixes none), as a source loop's body sees its counter
// (compile/loop-model.js counterRefinements).
const SKIP_MISSING = {}
export const callbackLoop = (recv, body, len, ptr, reverse, options = SKIP_MISSING) =>
  arrayLoop(recv.value, (...a) => withRefinements(new Map([[a[2], { rlo: 0, rhi: Math.max(0, (recv.len >= 0 ? recv.len : 0x7fffffff) - 1) }]]), null, () => body(...a)),
    len, ptr, reverse, undefined, { ...options, fixed: recv.len >= 0, dense: recv.dense })

export function hoistArrayValue(arr) {
  const recv = temp('ar')
  return {
    setup: ['local.set', `$${recv}`, asF64(emit(arr))],
    value: typed(['local.get', `$${recv}`], 'f64'),
    dense: ctx.summary?.at(ctx.func.current).arrayDenseOfExpr(arr) === true,
    // (the length the summary fixes the receiver at, or -1)
    len: ctx.summary?.at(ctx.func.current).fixedLenOfExpr(arr) ?? -1,
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
    value, dynamic: true, call, stored: call, run: args => [['drop', call(args)]],
  }
}

/** A sort's comparefn (ECMA-262 23.1.3.30 step 1, 23.2.3.29 step 1):
 *  `null` where none is passed or `undefined` is written (the default
 *  order), else whether the value is callable on every run (a function
 *  expression, or a closure the summary proves present). Any other value is
 *  decided at run time: undefined sorts by default, a non-function throws. */
export const sortComparator = (fn) => fn == null || isUndefinedLiteral(fn) ? null
  : { fn, callable: Array.isArray(fn) && fn[0] === '=>' ||
      valTypeOf(fn) === VAL.CLOSURE && ctx.summary?.at(ctx.func.current).mayBeNullishExpr(fn) === false }

// Pure-expression check: no statements, binders, control flow, or assignments.
// Inlining is only safe for these — anything else needs the full closure machinery.
const NOT_PURE_OPS = new Set([
  ';', '{}', 'let', 'const', '=>', 'return', 'throw',
  'if', 'for', 'while', 'break', 'continue',
  'catch', 'finally', '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
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

// Substitution rebuilds nodes without their frozen representation-plan facts.
// Only inline values whose settled kinds exclude BigInt; the normal closure
// path retains the plan for every nested storage and join edge.
function hasInlineCarriers(node, view) {
  if (node == null || typeof node === 'number') return true
  if (!view) return false
  if (Array.isArray(node) && node[0] === ':') return hasInlineCarriers(node[2], view)
  const kind = view.kindOfExpr(node)
  if (!kind || hasTag(kind, K.BIGINT)) return false
  if (!Array.isArray(node) || node[0] == null || node[0] === 'str') return true
  if (node[0] === '.' || node[0] === '?.') return hasInlineCarriers(node[1], view)
  for (let i = node[0] === '()' && typeof node[1] === 'string' ? 2 : 1; i < node.length; i++)
    if (!hasInlineCarriers(node[i], view)) return false
  return true
}

// Substitute variable references: a node no name of `mapping` reaches is kept
// as it is, with what the plan knows of it. Skips literals, property names on
// `.` / `?.` and object-literal keys on `:`.
function substExpr(node, mapping) {
  if (typeof node === 'string') return mapping.has(node) ? mapping.get(node) : node
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op == null || op === 'str') return node
  if (op === '.' || op === '?.') { const o = substExpr(node[1], mapping); return o === node[1] ? node : [op, o, ...node.slice(2)] }
  if (op === ':') { const v = substExpr(node[2], mapping); return v === node[2] ? node : [op, node[1], v] }
  let out = null
  for (let i = 1; i < node.length; i++) {
    const c = substExpr(node[i], mapping)
    if (c !== node[i]) (out ??= node.slice())[i] = c
  }
  return out ?? node
}

function exprUses(node, name) {
  return refsName(node, name, REFS_IN_EXPR)
}

// The local an argument is a bare read of, else null.
const localRead = (ir) => Array.isArray(ir) && ir[0] === 'local.get' && typeof ir[1] === 'string' ? ir[1].slice(1) : null

// Callback factory: returns { setup, call, stored, run, usedParams } where
// call(argExprs) emits the invocation and run(argExprs) its statements, the
// value dropped. An arrow runs inline, its parameters substituted by the walk's
// locals or fresh ones: no closure, no call_indirect, no argument array, its
// captures the function's own locals. It does where its body is a pure
// expression, and where it runs in place (compile/in-place.js): then its
// statements run in the walk, a local of the function it writes is read and
// written through its cell as the function's own code does, and its value is
// its last `return`. Anything else is a closure call (ctx.closure.call).
// usedParams: boolean array (inline only): callers can skip computing args for unused params.
// Each inlined local reads, to the summary, as the parameter it holds: the
// kind the solve bound it to at every call (summary/index.js arrayCallback,
// reduceResult, arrayFrom). elem: `{ index, expr }`, the parameter position
// that receives the array's element and the read it stands for
// (callbackElem): where no call bound that parameter, its local reads as
// that element instead.
export function makeCallback(fn, argReps, elem = null, thisArg) {
  if (Array.isArray(fn) && fn[0] === '=>') {
    const raw = extractParams(fn[1])
    const body = fn[2]
    if (runsInPlace(fn) || raw.every(p => typeof p === 'string') && isPureExpr(body) &&
        (!representationProgramHasBigint(ctx) || hasInlineCarriers(body, ctx.summary?.at(fn[1])))) {
      const usedParams = raw.map(p => exprUses(body, p))
      const { stmts: run, value } = bodyParts(body)
      // (each round declares the body's own bindings anew, in its statements or
      // in its value where a splice left one: the walk's function holds them)
      const declared = declaredNames(body)
      // `call` yields the body's value in its own form (an i32 boolean stays
      // i32 for a test); `stored` yields the container store's form (a
      // boolean its atom, a BigInt its planned box), for a result kept as a
      // value: stored into an array, handed to another callback, folded;
      // a null `produce` its statements alone, the value dropped.
      const inline = (argExprs, produce) => {
          const stmts = []
          const mapping = new Map()
          const freshNames = []
          const view = ctx.summary?.at(ctx.func.current), held = [], overlaid = []
          for (let i = 0; i < raw.length; i++) {
            if (!usedParams[i]) { freshNames.push(null); continue }  // skip dead local + arg evaluation
            // An argument a local already holds is the parameter: the body reads
            // that local, as a source loop's body reads its own (`s + x`, with no
            // copy between the fold and its accumulator). The summary binds the
            // parameter (aliasParam); a tagged carrier stays in a local of its
            // own mark wherever the value may be a BigInt.
            const local = localRead(argExprs[i])
            if (local && view?.aliasParam(local, fn[1], raw[i])) {
              if (!argReps?.[i]?.tagged || !hasTag(view.kindOfExpr(local), K.BIGINT)) {
                mapping.set(raw[i], local)
                freshNames.push(null)
                held.push(local)
                const val = argReps?.[i]?.val
                if (val) { overlaid.push([local, ctx.func.localValTypesOverlay.get(local)]); ctx.func.localValTypesOverlay.set(local, val) }
                continue
              }
              view.unalias(local)
            }
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
          if (view) for (let i = 0; i < raw.length; i++) {
            const t = freshNames[i]
            if (!t) continue
            if (view.aliasParam(t, fn[1], raw[i])) held.push(t)
            else if (elem?.index === i) { view.alias(t, elem.expr, false); held.push(t) }
          }
          for (const name of declared) {
            if (!ctx.func.locals.has(name)) ctx.func.locals.set(name, 'f64')
            if (view?.aliasDeclared(name, fn[1] ?? fn[2])) held.push(name)
          }
          let effects = [], result
          try {
            // (a frame on the control stack: the statements run once a round, as a loop body's do)
            if (run.length) effects = withControlFrame({ brk: null }, () => emitVoid(['{}', [';', ...run.map(s => substExpr(s, mapping))]]))
            const v = value == null ? [null, undefined] : substExpr(value, mapping)
            result = produce ? produce(v) : value == null ? [] : emitVoid(v)
          } finally {
            for (const t of held.reverse()) view.unalias(t)
            for (const [t, was] of overlaid.reverse()) { if (was === undefined) ctx.func.localValTypesOverlay.delete(t); else ctx.func.localValTypesOverlay.set(t, was) }
          }
          if (!produce) return [...stmts, ...effects, ...result]
          // Preserve i32 result type so callers (truthyIR, etc.) can skip f64↔i32 round-trips.
          const ty = result.type === 'i32' ? 'i32' : 'f64'
          const wrapped = typed(['block', ['result', ty], ...stmts, ...effects, result], ty)
          // An i32 result carrying ptrKind is an UNBOXED POINTER (a narrowed-return
          // callee: the caller must rebox via this metadata) — the block wrapper must
          // carry it through or downstream asF64 numeric-converts the raw offset
          // (map stored [1104,1128] instead of the objects a named ctor fn returned).
          if (result.ptrKind != null) { wrapped.ptrKind = result.ptrKind; wrapped.ptrAux = result.ptrAux }
          // (an unsigned word, `x >>> 0`, converts as one: -1 is 4294967295)
          if (result.unsigned) wrapped.unsigned = true
          return wrapped
      }
      // The inlined value has no plan facts in this function: for a store it
      // names the tagged slot it lands in (representationComputedExprAction).
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
        run: (argExprs) => inline(argExprs, null),
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
      // ABSENT can also be a hole read stored into a present cell, so even
      // callbacks that skip holes must preserve its undefined alternative.
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

// The callback's index argument: the walk's counter, an i32 local (an inlined
// arrow reads the counter itself, a closure takes it converted), or null where
// an inlined arrow never reads its index.
export function idxArg(cb, i, slot = 1) {
  return cb.usedParams && !cb.usedParams[slot] ? null : typed(['local.get', `$${i}`], 'i32')
}
// The callback's array argument (`(v, i, arr) =>`, reduce's fourth): the
// receiver value, or null when an inlined arrow provably never reads it.
export function arrArg(cb, recvValue, slot = 2) {
  return cb.usedParams && !cb.usedParams[slot] ? null : recvValue
}
export { callbackReadsArray } from '../../src/ast.js'
