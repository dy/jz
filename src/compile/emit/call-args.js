/**
 * Spread/argument marshalling for calls: attachSigMeta, materializeMulti (public), emitSpreadCopy, buildArrayWithSpreads (public), parseCallArgs, emitArraySpreadMutation, emitSpreadElementLoop, emitAsValue, emitVariadicSpreadMethodCall, emitMethodCallSpread.
 *
 * @module compile/emit/call-args
 */

import { callWithArgs } from '../../ir.js'
import { T, commaList } from '../../ast.js'
import { includeForArrayLiteral, includeForStringOnly } from '../../autoload.js'
import { PTR, ctx, emitArity, inc } from '../../ctx.js'
import { storedValue } from '../../bridge.js'
import {
  throwTypeErrorIR, allocPtr, asF64, block64, deferBigintBox, dispatchByPtrType, freshId, isPureIR, materializeDeferredBigint, multiCount, reconstructArgsWithSpreads, temp, tempI32,
} from '../../ir.js'
import { valTypeOf } from '../../kind.js'
import { VAL } from '../../reps.js'
import { durableArrSnapNode, hasDurableReset } from '../../../module/collection/durable.js'
import { representationProgramHasBigint } from '../representation-plan.js'
import { persistBindingPtr } from '../emit-assign.js'
import { withExpectedValue } from '../flow-state.js'
import { plannedTypedStorageCtor } from '../typed-storage-plan.js'
import { emit, emitCallArgs } from './dispatch.js'


/** A proven non-callable value still evaluates its arguments before TypeError.
 *  `recvIR` supplies a receiver a caller's nullish guard already evaluated, so
 *  the arguments stay on the arm where the property read actually succeeds. */
export function emitNonCallable(callee, parsed, recvIR = null) {
  const receiver = recvIR ?? asF64(emit(callee))
  const args = parsed.hasSpread
    ? [buildArrayWithSpreads(reconstructArgsWithSpreads(parsed.normal, parsed.spreads))]
    : parsed.normal.map(a => emit(a))
  return block64(['drop', receiver], ...args.map(a => ['drop', asF64(a)]), throwTypeErrorIR('call'))
}

/** Stamp a `call` IR with the pointer-ABI / sign metadata its signature carries.
 *  Returns `callIR` for chaining. Centralizes the three-property copy every
 *  direct-call emission did inline. */
export function attachSigMeta(callIR, sig) {
  if (sig?.ptrKind != null) callIR.ptrKind = sig.ptrKind
  if (sig?.ptrAux != null) callIR.ptrAux = sig.ptrAux
  if (sig?.unsignedResult) callIR.unsigned = true
  return callIR
}

/**
 * Materialize a multi-value function call as a heap array.
 * Call → store each result in temp → copy to allocated array → return pointer.
 */
export function materializeMulti(callNode) {
  const name = callNode[1]
  const func = ctx.funcs.map.get(name)
  const n = func.sig.results.length
  const argList = commaList(callNode[2])
  const emittedArgs = emitCallArgs(argList, func.sig.params, func)
  const temps = Array.from({ length: n }, () => temp())
  const out = allocPtr({ type: 1, len: n, tag: 'marr' })
  const ir = [out.init, callWithArgs(name, emittedArgs, func.sig)]
  for (let k = n - 1; k >= 0; k--) ir.push(['local.set', `$${temps[k]}`])
  for (let k = 0; k < n; k++)
    ir.push(['f64.store', ['i32.add', ['local.get', `$${out.local}`], ['i32.const', k * 8]], ['local.get', `$${temps[k]}`]])
  ir.push(out.ptr)
  return block64(...ir)
}

/**
 * Copy a spread source's elements into a destination array.
 *
 * `dest` is the destination data-base i32 local; `posLocal` the element index to
 * start writing at — advanced by the source length on exit. An ARRAY source is a
 * contiguous block of f64 NaN-boxes, so it copies with a single `memory.copy`; a
 * string/typed source needs a per-element decode. The source's *type* is
 * loop-invariant — it cannot change while the spread runs — so when it is not
 * statically known it is resolved exactly once (one `__ptr_type`) and branched,
 * never re-checked per element. Returns a list of IR instructions.
 */
function emitSpreadCopy(dest, posLocal, srcLocal, srcLenLocal, staticVT, arrayBase = null) {
  const srcI64 = () => ['i64.reinterpret_f64', ['local.get', `$${srcLocal}`]]
  const destAddr = idx => ['i32.add', ['local.get', `$${dest}`], ['i32.shl', idx, ['i32.const', 3]]]
  const arrCopy = () => (inc('__ptr_offset'),
    ['memory.copy', destAddr(['local.get', `$${posLocal}`]),
      arrayBase || ['call', '$__ptr_offset', srcI64()],
      ['i32.shl', ['local.get', `$${srcLenLocal}`], ['i32.const', 3]]])
  const scalarLoop = () => {
    const sidx = `${T}sidx${freshId(ctx)}`
    ctx.func.locals.set(sidx, 'i32')
    const loopId = freshId(ctx)
    // When the source is statically known to be a typed array, __typed_idx suffices.
    // Otherwise (STRING, or unknown type whose runtime value may be a string) dispatch on
    // ptr_type: STRING→__str_idx, else→__typed_idx.
    // The old gate (ctx.module.modules['string']) was wrong: for `[...s]` with an untyped
    // param the string module is never loaded, so __typed_idx was used for strings —
    // __typed_idx calls __len which returns 0 for strings, making i>=len always true and
    // storing UNDEF into every element slot. Pull in the string module here so __str_idx
    // is registered before inc() adds it to the dependency set.
    const read = representationProgramHasBigint(ctx) ? '__typed_idx_tagged' : '__typed_idx'
    const elem = staticVT === VAL.TYPED
      ? (inc(read), ['call', '$' + read, srcI64(), ['local.get', `$${sidx}`]])
      : (includeForStringOnly(),
        ['if', ['result', 'f64'],
          ['i32.eq', ['call', '$__ptr_type', srcI64()], ['i32.const', PTR.STRING]],
          ['then', (inc('__str_idx'), ['call', '$__str_idx', srcI64(), ['local.get', `$${sidx}`]])],
          ['else', (inc(read), ['call', '$' + read, srcI64(), ['local.get', `$${sidx}`]])]
        ])
    // Reset the counter on each entry — WASM zeroes locals once at function
    // entry, but this loop re-executes when the spread sits inside a JS loop;
    // a stale `sidx` (= prior srcLen) would skip the copy entirely.
    return ['block', `$break${loopId}`,
      ['local.set', `$${sidx}`, ['i32.const', 0]],
      ['loop', `$loop${loopId}`,
        ['br_if', `$break${loopId}`, ['i32.ge_s', ['local.get', `$${sidx}`], ['local.get', `$${srcLenLocal}`]]],
        ['f64.store', destAddr(['i32.add', ['local.get', `$${posLocal}`], ['local.get', `$${sidx}`]]), elem],
        ['local.set', `$${sidx}`, ['i32.add', ['local.get', `$${sidx}`], ['i32.const', 1]]],
        ['br', `$loop${loopId}`]]]
  }
  const advance = ['local.set', `$${posLocal}`,
    ['i32.add', ['local.get', `$${posLocal}`], ['local.get', `$${srcLenLocal}`]]]
  if (staticVT === VAL.ARRAY) return [arrCopy(), advance]
  if (staticVT === VAL.STRING || staticVT === VAL.TYPED) return [scalarLoop(), advance]
  inc('__ptr_type')
  const tt = tempI32(`${T}spt`)
  return [
    ['local.set', `$${tt}`, ['call', '$__ptr_type', srcI64()]],
    dispatchByPtrType(tt, [[PTR.ARRAY, arrCopy()]], scalarLoop(), null),
    advance,
  ]
}

/**
 * Stage a spread source once, for every consumer of its elements: the value
 * in an f64 local, normalized to an index-iterable (`__iter_arr`: a Set's
 * keys, a Map's entries; an array, a typed array or a string passes through,
 * only when `collection` is loaded – otherwise no Set or Map exists); its
 * element count in an i32 local, by its kind: a string counts characters
 * (`__str_len`; `__len` reads 0 on a string), an array, a typed array or a
 * materialized multi-value its header, an unknown kind decides at runtime.
 * `val` is the staged value's kind, or undefined for a multi-value.
 */
function stageSpreadSource(expr) {
  const local = `${T}sp${freshId(ctx)}`
  const lenLocal = `${T}spl${freshId(ctx)}`
  ctx.func.locals.set(local, 'f64')
  ctx.func.locals.set(lenLocal, 'i32')
  const n = multiCount(expr)
  if (!n) ctx.module.include('collection')
  const srcExpr = !n ? ['()', '__iter_arr', expr] : expr
  const val = n ? undefined : valTypeOf(srcExpr)
  const srcI64 = () => ['i64.reinterpret_f64', ['local.get', `$${local}`]]
  const lenIR = val === VAL.STRING
    ? (inc('__str_len'), ['call', '$__str_len', srcI64()])
    : (val === VAL.ARRAY || val === VAL.TYPED || n)
      ? (inc('__len'), ['call', '$__len', srcI64()])
      : (inc('__str_len', '__len', '__ptr_type'),
        ['if', ['result', 'i32'],
          ['i32.eq', ['call', '$__ptr_type', srcI64()], ['i32.const', PTR.STRING]],
          ['then', ['call', '$__str_len', srcI64()]],
          ['else', ['call', '$__len', srcI64()]]])
  const ir = [
    ['local.set', `$${local}`, n ? materializeMulti(expr) : asF64(emit(srcExpr))],
    ['local.set', `$${lenLocal}`, lenIR],
  ]
  return { local, lenLocal, val, ir }
}

/**
 * Build an array from items, handling ['__spread', expr] markers.
 * Split into sections (normal arrays and spreads), then copy all into result.
 *
 * Every caller hand-builds a `['[', …]` IR node below (or, on the spread path,
 * allocates a PTR.ARRAY directly) — this is emit-TIME array construction, not
 * a user-source array literal prepare() ever saw, so none of the ordinary
 * `includeForArrayLiteral()` call sites in prepare/index.js run for it. Most
 * callers are safe by COINCIDENCE (spread/rest syntax in the source already
 * pulled 'array' in during prepare — see prepare/index.js's `'...'`/rest-param
 * handlers), but externalMethodFallback's __ext_call arg-marshalling reaches
 * here for a receiver whose method resolves via GENERIC_METHOD_MODULES/the
 * registration-derived RESOLVED_PROP_MODULES row alone (e.g. `.toFixed()`),
 * neither of which mention 'array' — that dependency belongs to THIS
 * mechanism (packing call args for the host boundary), not to whichever
 * property name happened to trigger it. Same fix shape as emitSpreadCopy's
 * own includeForStringOnly() call a few dozen lines up (__str_idx) — pull the
 * module in at the actual point of need instead of trusting an incidental
 * upstream autoload to have already covered it. Idempotent (includeModule
 * no-ops once 'array' is in ctx.module.modules for this compile), so the
 * already-covered callers pay one extra Set/Map lookup, nothing else.
 */
export function buildArrayWithSpreads(items) {
  includeForArrayLiteral()
  if (!items.some(item => Array.isArray(item) && item[0] === '__spread'))
    return emit(['[', ...items])

  const sections = []
  let currentArray = []

  for (let i = 0; i < items.length; i++) {
    if (Array.isArray(items[i]) && items[i][0] === '__spread') {
      if (currentArray.length > 0) {
        sections.push({ type: 'array', items: currentArray })
        currentArray = []
      }
      sections.push({ type: 'spread', expr: items[i][1] })
    } else {
      currentArray.push(items[i])
    }
  }
  if (currentArray.length > 0) {
    sections.push({ type: 'array', items: currentArray })
  }

  const len = tempI32('len')
  const pos = tempI32('pos')
  const out = allocPtr({ type: 1, len: ['local.get', `$${len}`], tag: 'arr' })
  const result = out.local

  const ir = [['local.set', `$${len}`, ['i32.const', 0]]]
  inc('__len')

  // Emit each expression once. Only a later effect requires an earlier spread
  // to snapshot its elements; constants and local reads need no extra copy.
  let lastEffect = -1
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s]
    sec.setup = []
    if (sec.type === 'array') {
      sec.itemLocals = []
      for (let i = 0; i < sec.items.length; i++) {
        const it = `${T}ai${freshId(ctx)}`
        ctx.func.locals.set(it, 'f64')
        sec.itemLocals.push(it)
        const value = storedValue(sec.items[i])
        if (!isPureIR(value)) lastEffect = s
        sec.setup.push(['local.set', `$${it}`, value])
      }
    } else {
      // The length is read once per spread (the total-len sum and the copy);
      // its kind matches emitSpreadCopy's element decode.
      const src = stageSpreadSource(sec.expr)
      sec.local = src.local
      sec.lenLocal = src.lenLocal
      sec.val = src.val
      sec.setup = src.ir
      if (!isPureIR(src.ir[0][2])) lastEffect = s
    }
  }

  // Consume the staged expressions in source order, accumulating their lengths.
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s]
    ir.push(...sec.setup)
    if (sec.type === 'spread') {
      if (s < lastEffect) {
        const copy = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${sec.lenLocal}`], tag: 'spread' })
        const at = tempI32('spreadPos')
        ir.push(copy.init, ['local.set', `$${at}`, ['i32.const', 0]],
          ...emitSpreadCopy(copy.local, at, sec.local, sec.lenLocal, sec.val),
          ['local.set', `$${sec.local}`, copy.ptr])
        sec.val = VAL.ARRAY
      }
    }
    if (sec.type === 'array') {
      ir.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['i32.const', sec.items.length]]])
    } else {
      ir.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['local.get', `$${sec.lenLocal}`]]])
    }
  }

  // Allocate exact, then store the captured values.
  ir.push(out.init, ['local.set', `$${pos}`, ['i32.const', 0]])
  for (const sec of sections) {
    if (sec.type === 'array') {
      for (const it of sec.itemLocals) {
        ir.push(
          ['f64.store',
            ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]],
            ['local.get', `$${it}`]],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]]
        )
      }
    } else {
      ir.push(...emitSpreadCopy(result, pos, sec.local, sec.lenLocal, sec.val))
    }
  }

  ir.push(out.ptr)
  return block64(...ir)
}

// === Call IR helpers ===

/** Split a flat argList into normal positional args + spread positions. */
export function parseCallArgs(args) {
  const normal = []
  const spreads = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (Array.isArray(arg) && arg[0] === '...') {
      spreads.push({ pos: normal.length, expr: arg[1] })
    } else {
      normal.push(arg)
    }
  }
  return { normal, spreads, hasSpread: spreads.length > 0 }
}

/** Capture the receiver and argument values, then append or prepend in bulk.
 * One grow, one optional tail shift and one length update per call. */
function emitArraySpreadMutation(objArg, parsed, method) {
  inc('__len'); inc('__arr_grow'); inc('__set_len'); inc('__ptr_offset')
  const o = `${T}po${freshId(ctx)}`,
        ol = `${T}pol${freshId(ctx)}`,
        si = `${T}psi${freshId(ctx)}`,
        base = `${T}pb${freshId(ctx)}`
  ctx.func.locals.set(o, 'f64'); ctx.func.locals.set(ol, 'i32')
  ctx.func.locals.set(si, 'i32'); ctx.func.locals.set(base, 'i32')

  const objIsArr = valTypeOf(objArg) === VAL.ARRAY
  const ir = []
  ir.push(['local.set', `$${o}`, asF64(emit(objArg))])
  const original = typeof objArg === 'string' ? temp('pushReceiver') : null
  if (original) ir.push(['local.set', `$${original}`, ['local.get', `$${o}`]])
  // A trailing spread keeps its prefix in locals. Other forms first gather
  // the argument values, before any mutation of the captured receiver.
  const trailing = parsed.spreads.length === 1 &&
    parsed.spreads[0].pos === parsed.normal.length
  const prefix = trailing ? parsed.normal.map(value => {
    const t = temp('pushValue')
    ir.push(['local.set', `$${t}`, storedValue(value)])
    return t
  }) : []
  let source = parsed.spreads[0].expr
  if (!trailing) {
    source = temp('pushArgs')
    ctx.func.localValTypesOverlay.set(source, VAL.ARRAY)
    ir.push(['local.set', `$${source}`, buildArrayWithSpreads(reconstructArgsWithSpreads(parsed.normal, parsed.spreads))])
  }
  const { local: sa, lenLocal: sl, val: srcVT, ir: stage } = stageSpreadSource(source)
  ir.push(...stage)
  const count = prefix.length ? ['i32.add', ['local.get', `$${sl}`], ['i32.const', prefix.length]] : ['local.get', `$${sl}`]
  const newLength = ['i32.add', ['local.get', `$${ol}`], count]
  // Old length: inline as `i32.load (off-8)` if obj is known ARRAY (matches .push handler).
  if (objIsArr) {
    ir.push(['local.set', `$${ol}`,
      ['i32.load', ['i32.sub', ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${o}`]]], ['i32.const', 8]]]])
  } else {
    ir.push(['local.set', `$${ol}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${o}`]]]])
  }
  // Single grow for the full spread (vs per-element grow check in the generic loop).
  ir.push(['local.set', `$${o}`, ['call', '$__arr_grow', ['i64.reinterpret_f64', ['local.get', `$${o}`]],
    newLength]])
  // base captured AFTER grow (grow may relocate the array).
  ir.push(['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${o}`]]]])
  let arrayBase = null
  if (method === 'unshift') {
    if (hasDurableReset()) inc('__durable_arr_snap')
    // The tail move preserves an aliased array's argument values. Read that
    // moved range instead of allocating a temporary copy for self-prepend.
    const from = tempI32('prependSource')
    arrayBase = ['local.get', `$${from}`]
    ir.push(['local.set', `$${from}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${sa}`]]]],
      ['if', ['i32.eq', arrayBase, ['local.get', `$${base}`]],
        ['then', ['local.set', `$${from}`, ['i32.add', arrayBase, ['i32.shl', count, ['i32.const', 3]]]]]])
    ir.push(durableArrSnapNode(base),
      ['memory.copy',
        ['i32.add', ['local.get', `$${base}`], ['i32.shl', count, ['i32.const', 3]]],
        ['local.get', `$${base}`], ['i32.shl', ['local.get', `$${ol}`], ['i32.const', 3]]])
  }
  // Bulk-copy the spread: an ARRAY source is a contiguous f64 block → memory.copy.
  ir.push(['local.set', `$${si}`, method === 'unshift' ? ['i32.const', 0] : ['local.get', `$${ol}`]])
  for (const value of prefix) ir.push(
    ['f64.store', ['i32.add', ['local.get', `$${base}`], ['i32.shl', ['local.get', `$${si}`], ['i32.const', 3]]], ['local.get', `$${value}`]],
    ['local.set', `$${si}`, ['i32.add', ['local.get', `$${si}`], ['i32.const', 1]]])
  ir.push(...emitSpreadCopy(base, si, sa, sl, srcVT, arrayBase))
  // Single set_len for the full spread.
  ir.push(['call', '$__set_len', ['i64.reinterpret_f64', ['local.get', `$${o}`]],
    newLength])
  // Keep the local's cached pointer current only while it still names the
  // captured receiver. Argument evaluation can replace that binding.
  if (original) ir.push(['if', ['i64.eq',
    ['i64.reinterpret_f64', asF64(emit(objArg))], ['i64.reinterpret_f64', ['local.get', `$${original}`]]],
    ['then', persistBindingPtr(objArg, ['local.get', `$${o}`])]])
  ir.push(['f64.convert_i32_s', newLength])
  return block64(...ir)
}

/** Consume a spread in order, retaining its kind for each indexed read. */
function emitSpreadElementLoop(spreadExpr, bodyFn) {
  const { local: arr, lenLocal: len, val, ir: stage } = stageSpreadSource(spreadExpr)
  const idx = `${T}spidx${freshId(ctx)}`
  ctx.func.locals.set(idx, 'i32')
  // Emission-minted temps ride the transient overlay (slice 3c-a class) for
  // the loop body's `arr[idx]` read: the staged source's kind (a string reads
  // a character, an array or a typed array its element; an unknown kind keeps
  // the polymorphic read) and the counter's, a number, so the read is an
  // element read and not ToPropertyKey's runtime key dispatch. Durable reps
  // stay clean.
  if (val) ctx.func.localValTypesOverlay.set(arr, val)
  ctx.func.localValTypesOverlay.set(idx, VAL.NUMBER)
  const loopId = freshId(ctx)
  const exhausted = ['i32.ge_u', ['local.get', `$${idx}`], ['local.get', `$${len}`]]
  return [
    ...stage,
    ['local.set', `$${idx}`, ['i32.const', 0]],
    ['block', `$break${loopId}`,
      ['loop', `$continue${loopId}`,
        ['br_if', `$break${loopId}`, exhausted],
        ...bodyFn(arr, idx, len),
        ['local.set', `$${idx}`, ['i32.add', ['local.get', `$${idx}`], ['i32.const', 1]]],
        ['br', `$continue${loopId}`]]],
  ]
}

function emitAsValue(fn) {
  return withExpectedValue(null, fn)
}

/** Methods whose variadic arguments compose successive results (concat). */
function emitVariadicSpreadMethodCall(objArg, parsed, methodEmitter) {
  const acc = temp('spreadResult')
  const ir = [['local.set', `$${acc}`, asF64(emit(objArg))]]
  let batch = []
  const flushBatch = () => {
    if (!batch.length) return
    ir.push(['local.set', `$${acc}`, asF64(emitAsValue(() => methodEmitter(acc, ...batch)))])
    batch = []
  }
  for (const item of reconstructArgsWithSpreads(parsed.normal, parsed.spreads)) {
    if (Array.isArray(item) && item[0] === '__spread') {
      flushBatch()
      ir.push(...emitSpreadElementLoop(item[1], (arr, idx) => [
        ['local.set', `$${acc}`, asF64(emitAsValue(() => methodEmitter(acc, ['[]', arr, idx])))],
      ]))
    } else batch.push(item)
  }
  flushBatch()
  return block64(...ir, ['local.get', `$${acc}`])
}

/** Fixed methods consume an argument list once, not one call per spread item.
 * Keep only the fixed prefix in locals, but evaluate every supplied argument
 * before invoking the method. Dispatch by supplied count so optional arguments
 * retain the distinction between omission and an explicit undefined value. */
function emitFixedSpreadMethodCall(objArg, methodEmitter, parsed, method) {
  const recv = temp('spreadRecv'), count = tempI32('spreadCount')
  const arity = Math.max(0, emitArity(methodEmitter, `.${method}`) - 1)
  // A literal array's iterator contributes exactly its elements. Reuse those
  // expressions directly: no temporary argument array, iterator or count fork.
  const items = []
  for (const item of reconstructArgsWithSpreads(parsed.normal, parsed.spreads)) {
    const source = Array.isArray(item) && item[0] === '__spread' ? item[1] : null
    if (Array.isArray(source) && source[0] === '[' &&
        !source.slice(1).some(n => Array.isArray(n) && n[0] === '...'))
      items.push(...source.slice(1).map(n => n ?? [, undefined]))
    else items.push(item)
  }
  const dynamic = items.some(n => Array.isArray(n) && n[0] === '__spread')
  const slots = Array.from({ length: arity }, () => temp('spreadArg'))
  const setup = [['local.set', `$${recv}`, storedValue(objArg)]]
  if (dynamic) setup.push(['local.set', `$${count}`, ['i32.const', 0]])
  const kind = valTypeOf(objArg), ctor = plannedTypedStorageCtor(ctx, objArg)
  if (kind) ctx.func.localValTypesOverlay.set(recv, kind)
  ctx.func.taggedLocals ??= new Set()
  ctx.func.taggedLocals.add(recv)
  for (const slot of slots) ctx.func.taggedLocals.add(slot)
  if (ctor) (ctx.func.localTypedElemsOverlay ||= new Map()).set(recv, ctor)
  const regex = typeof objArg === 'string' ? ctx.runtime.regex?.vars.get(objArg)
    : Array.isArray(objArg) && objArg[0] === '//' ? objArg : null
  if (regex) ctx.runtime.regex.vars.set(recv, regex)
  let position = 0
  const capture = node => {
    if (!arity || !dynamic && position >= arity) return [['drop', asF64(emit(node))]]
    if (!dynamic) {
      const slot = slots[position++]
      if (valTypeOf(node) === VAL.NUMBER && ctx.summary?.at(ctx.func.current).mayBeNullishExpr(node) === false)
        ctx.func.localValTypesOverlay.set(slot, VAL.NUMBER)
      return [['local.set', `$${slot}`, storedValue(node)]]
    }
    const value = temp('spreadValue')
    return [['local.set', `$${value}`, storedValue(node)],
      ...slots.map((slot, i) => ['if', ['i32.eq', ['local.get', `$${count}`], ['i32.const', i]],
        ['then', ['local.set', `$${slot}`, ['local.get', `$${value}`]]]]),
      ['if', ['i32.lt_u', ['local.get', `$${count}`], ['i32.const', arity]],
        ['then', ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]]
  }
  for (const item of items) {
    if (Array.isArray(item) && item[0] === '__spread')
      setup.push(...emitSpreadElementLoop(item[1], (arr, idx) => capture(['[]', arr, idx])))
    else setup.push(...capture(item))
  }
  const min = Math.min(arity, dynamic ? parsed.normal.length : items.length)
  const max = dynamic ? arity : min
  const calls = Array.from({ length: max - min + 1 }, (_, n) =>
    asF64(emitAsValue(() => methodEmitter(recv, ...slots.slice(0, min + n)))))
  const result = boxed => {
    const arms = boxed ? calls.map(materializeDeferredBigint) : calls
    let call = arms[arms.length - 1]
    for (let n = arms.length - 2; n >= 0; n--)
      call = ['if', ['result', 'f64'], ['i32.eq', ['local.get', `$${count}`], ['i32.const', min + n]],
        ['then', arms[n]], ['else', call]]
    return block64(...setup, call)
  }
  const call = result(false)
  if (calls.every(ir => ir.bigintRaw)) call.bigintRaw = true
  if (calls.some(ir => ir.bigintBox)) deferBigintBox(call, () => result(true))
  return call
}

/** Method-emitter call: directly, or via one of the spread fast paths. */
export function emitMethodCallSpread(objArg, methodEmitter, parsed, method) {
  if (!parsed.hasSpread) return methodEmitter(objArg, ...parsed.normal)
  if (method === 'push' || method === 'unshift')
    return emitArraySpreadMutation(objArg, parsed, method)
  if (method !== 'concat' && method !== 'splice')
    return emitFixedSpreadMethodCall(objArg, methodEmitter, parsed, method)
  return emitVariadicSpreadMethodCall(objArg, parsed, methodEmitter)
}
