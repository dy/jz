/**
 * Spread/argument marshalling for calls: attachSigMeta, materializeMulti (public), emitSpreadCopy, buildArrayWithSpreads (public), parseCallArgs, emitBulkPushSpread, emitSpreadElementLoop, emitAsValue, emit{Single,Multi}SpreadMethodCall, emitMethodCallSpread.
 *
 * @module compile/emit/call-args
 */

import { T, commaList } from '../../ast.js'
import { includeForArrayLiteral, includeForStringOnly } from '../../autoload.js'
import { PTR, ctx, emitArity, inc } from '../../ctx.js'
import {
  SPREAD_MUTATORS, allocPtr, asF64, block64, dispatchByPtrType, freshId, multiCount, reconstructArgsWithSpreads, temp, tempI32,
} from '../../ir.js'
import { valTypeOf } from '../../kind.js'
import { VAL, lookupValType } from '../../reps.js'
import { persistBindingPtr } from '../emit-assign.js'
import { withExpectedValue } from '../flow-state.js'
import { emit, emitCallArgs } from './dispatch.js'


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
  const emittedArgs = emitCallArgs(argList, func.sig.params)
  const temps = Array.from({ length: n }, () => temp())
  const out = allocPtr({ type: 1, len: n, tag: 'marr' })
  const ir = [out.init, ['call', `$${name}`, ...emittedArgs]]
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
function emitSpreadCopy(dest, posLocal, srcLocal, srcLenLocal, staticVT) {
  const srcI64 = () => ['i64.reinterpret_f64', ['local.get', `$${srcLocal}`]]
  const destAddr = idx => ['i32.add', ['local.get', `$${dest}`], ['i32.shl', idx, ['i32.const', 3]]]
  const arrCopy = () => (inc('__ptr_offset'),
    ['memory.copy', destAddr(['local.get', `$${posLocal}`]),
      ['call', '$__ptr_offset', srcI64()],
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
    const elem = staticVT === VAL.TYPED
      ? (inc('__typed_idx'), ['call', '$__typed_idx', srcI64(), ['local.get', `$${sidx}`]])
      : (includeForStringOnly(),
        ['if', ['result', 'f64'],
          ['i32.eq', ['call', '$__ptr_type', srcI64()], ['i32.const', PTR.STRING]],
          ['then', (inc('__str_idx'), ['call', '$__str_idx', srcI64(), ['local.get', `$${sidx}`]])],
          ['else', (inc('__typed_idx'), ['call', '$__typed_idx', srcI64(), ['local.get', `$${sidx}`]])]
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
  const spreads = []
  for (let i = 0; i < items.length; i++) {
    if (Array.isArray(items[i]) && items[i][0] === '__spread') {
      spreads.push({ pos: i, expr: items[i][1] })
    }
  }

  if (spreads.length === 0) {
    return emit(['[', ...items])
  }

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

  // A single all-normal section is a plain literal — defer to the `[` emitter.
  // A single *spread* section is NOT shortcut to `emit(sec.expr)`: that would
  // alias the source, but `[...x]` must yield a fresh array. It falls through
  // to the alloc + emitSpreadCopy path below, which copies.
  if (sections.length === 1 && sections[0].type === 'array') {
    return emit(['[', ...sections[0].items])
  }

  const len = tempI32('len')
  const pos = tempI32('pos')
  const out = allocPtr({ type: 1, len: ['local.get', `$${len}`], tag: 'arr' })
  const result = out.local

  const ir = []
  inc('__len')

  // Pass 1 — evaluate every section IN SOURCE ORDER into temps. JS spread keeps
  // strict left-to-right order: a later spread whose source mutates an earlier
  // element's input must still observe the pre-mutation value. Array items
  // become per-item f64 temps; spreads become a ptr temp + a cached __len.
  for (const sec of sections) {
    if (sec.type === 'array') {
      sec.itemLocals = []
      for (let i = 0; i < sec.items.length; i++) {
        const it = `${T}ai${freshId(ctx)}`
        ctx.func.locals.set(it, 'f64')
        sec.itemLocals.push(it)
        ir.push(['local.set', `$${it}`, asF64(emit(sec.items[i]))])
      }
    } else {
      sec.local = `${T}sp${freshId(ctx)}`
      ctx.func.locals.set(sec.local, 'f64')
      sec.lenLocal = `${T}spl${freshId(ctx)}`
      ctx.func.locals.set(sec.lenLocal, 'i32')
      const n = multiCount(sec.expr)
      // Normalize a (non-multi) spread source to an index-iterable: Set→keys /
      // Map→[k,v] arrays, others pass through. Only when `collection` is loaded —
      // otherwise no Set/Map can exist and the source is already index-iterable.
      const srcExpr = !n && ctx.module.modules.collection ? ['()', '__iter_arr', sec.expr] : sec.expr
      // A materialized multi-value is not a statically-typed pointer — let
      // emitSpreadCopy resolve its kind at runtime via its one-time __ptr_type branch.
      sec.val = n ? undefined : valTypeOf(srcExpr)
      ir.push(['local.set', `$${sec.local}`, n ? materializeMulti(sec.expr) : asF64(emit(srcExpr))])
      // Cache the source length once per spread (reused for the total-len sum and the
      // copy). `__len` is ARRAY/typed length — WRONG for a STRING (returns 0, so `[...str]`
      // spreads an empty array). Pick the length to MATCH emitSpreadCopy's element decode:
      // a known string counts chars (__str_len, paired with the __str_idx per-char copy); a
      // statically-unknown source — `[...x]` / `[...fnParam]`, the compiler's own
      // `[...key]` — dispatches once at runtime (STRING→__str_len, else→__len), mirroring
      // emitSpreadCopy's ARRAY-vs-scalar branch. (Not __length: its `off>=8` guard returns
      // undefined for host/static typed arrays.) Known array/typed/multi keep plain __len.
      const srcI64 = () => ['i64.reinterpret_f64', ['local.get', `$${sec.local}`]]
      const lenIR = sec.val === VAL.STRING
        ? (inc('__str_len'), ['call', '$__str_len', srcI64()])
        : (sec.val === VAL.ARRAY || sec.val === VAL.TYPED || n)
          ? (inc('__len'), ['call', '$__len', srcI64()])
          : (inc('__str_len', '__len', '__ptr_type'),
            ['if', ['result', 'i32'],
              ['i32.eq', ['call', '$__ptr_type', srcI64()], ['i32.const', PTR.STRING]],
              ['then', ['call', '$__str_len', srcI64()]],
              ['else', ['call', '$__len', srcI64()]]])
      ir.push(['local.set', `$${sec.lenLocal}`, lenIR])
    }
  }

  // Pass 2 — total length (array sections statically sized, spreads cached above).
  ir.push(['local.set', `$${len}`, ['i32.const', 0]])
  for (const sec of sections) {
    if (sec.type === 'array') {
      ir.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['i32.const', sec.items.length]]])
    } else {
      ir.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['local.get', `$${sec.lenLocal}`]]])
    }
  }

  // Pass 3 — allocate exact, then store the pre-evaluated temps.
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

/** Bulk `obj.push(...src)` fast path — single trailing spread, no normal args, named
 *  receiver. Amortizes the per-element grow + set_len of the generic loop into one
 *  __arr_grow / __set_len pair, then bulk-copies the source via emitSpreadCopy.
 *  Hot path in watr's `out.push(...HANDLER[op](...))` (~24M bytes/iter on raycast). */
function emitBulkPushSpread(objArg, parsed) {
  const spreadExpr = parsed.spreads[0].expr
  inc('__len'); inc('__arr_grow'); inc('__set_len'); inc('__ptr_offset')
  const o = `${T}po${freshId(ctx)}`,
        sa = `${T}psa${freshId(ctx)}`,
        sl = `${T}psl${freshId(ctx)}`,
        ol = `${T}pol${freshId(ctx)}`,
        si = `${T}psi${freshId(ctx)}`,
        base = `${T}pb${freshId(ctx)}`
  ctx.func.locals.set(o, 'f64'); ctx.func.locals.set(sa, 'f64')
  ctx.func.locals.set(sl, 'i32'); ctx.func.locals.set(ol, 'i32')
  ctx.func.locals.set(si, 'i32'); ctx.func.locals.set(base, 'i32')

  const objIsArr = lookupValType(objArg) === VAL.ARRAY
  const n = multiCount(spreadExpr)
  // Normalize a (non-multi) spread source to an index-iterable: Set→keys /
  // Map→[k,v] arrays, others pass through. Only when `collection` is loaded.
  const srcExpr = !n && ctx.module.modules.collection ? ['()', '__iter_arr', spreadExpr] : spreadExpr
  // A materialized multi-value is not a statically-typed pointer — let
  // emitSpreadCopy resolve its kind once at runtime.
  const srcVT = n ? undefined : valTypeOf(srcExpr)
  const ir = []
  ir.push(['local.set', `$${o}`, asF64(emit(objArg))])
  ir.push(['local.set', `$${sa}`, n ? materializeMulti(spreadExpr) : asF64(emit(srcExpr))])
  ir.push(['local.set', `$${sl}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${sa}`]]]])
  // Old length: inline as `i32.load (off-8)` if obj is known ARRAY (matches .push handler).
  if (objIsArr) {
    ir.push(['local.set', `$${ol}`,
      ['i32.load', ['i32.sub', ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${o}`]]], ['i32.const', 8]]]])
  } else {
    ir.push(['local.set', `$${ol}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${o}`]]]])
  }
  // Single grow for the full spread (vs per-element grow check in the generic loop).
  ir.push(['local.set', `$${o}`, ['call', '$__arr_grow', ['i64.reinterpret_f64', ['local.get', `$${o}`]],
    ['i32.add', ['local.get', `$${ol}`], ['local.get', `$${sl}`]]]])
  // base captured AFTER grow (grow may relocate the array).
  ir.push(['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${o}`]]]])
  // Bulk-copy the spread: an ARRAY source is a contiguous f64 block → memory.copy.
  ir.push(['local.set', `$${si}`, ['local.get', `$${ol}`]])
  ir.push(...emitSpreadCopy(base, si, sa, sl, srcVT))
  // Single set_len for the full spread.
  ir.push(['call', '$__set_len', ['i64.reinterpret_f64', ['local.get', `$${o}`]],
    ['i32.add', ['local.get', `$${ol}`], ['local.get', `$${sl}`]]])
  // Update source variable: grow may have moved the pointer.
  ir.push(persistBindingPtr(objArg, ['local.get', `$${o}`]))
  ir.push(['f64.convert_i32_s', ['i32.add', ['local.get', `$${ol}`], ['local.get', `$${sl}`]]])
  return block64(...ir)
}

/** Single trailing spread, with optional preceding normal args. Calls methodEmitter
 *  once for the normal args (if any), then loops methodEmitter over each spread
 *  element. `unshift` walks the spread end-to-start so prepend order matches JS. */
/** Emit a per-element loop over `spreadExpr`: allocate arr/len/idx locals, seed
 *  the arr rep when the spread VT is known, run `bodyFn(arr, idx, len)` once per
 *  element. When `reverse` is set, walks the spread from end to start (used by
 *  `unshift` to preserve argument order under successive prepends). Returns the
 *  IR instruction list (caller embeds it into its own block64). */
function emitSpreadElementLoop(spreadExpr, bodyFn, { reverse = false } = {}) {
  const arr = `${T}sp${freshId(ctx)}`
  const len = `${T}splen${freshId(ctx)}`
  const idx = `${T}spidx${freshId(ctx)}`
  ctx.func.locals.set(arr, 'f64'); ctx.func.locals.set(len, 'i32'); ctx.func.locals.set(idx, 'i32')
  // Emission-minted temp seed → transient overlay (slice 3c-a class): the fresh
  // spread-staging local's VT rides the overlay for the loop-body IR generation.
  // Without it, the body's `[]` read on `arr` falls back to polymorphic dispatch —
  // VAL.* elides the STRING gate for ARRAY/TYPED spreads. Durable reps stay clean.
  const spreadVT = valTypeOf(spreadExpr)
  if (spreadVT) ctx.func.localValTypesOverlay.set(arr, spreadVT)
  inc('__len')
  const n = multiCount(spreadExpr)
  const loopId = freshId(ctx)
  const exhausted = reverse
    ? ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]]
    : ['i32.ge_u', ['local.get', `$${idx}`], ['local.get', `$${len}`]]
  return [
    ['local.set', `$${arr}`, n ? materializeMulti(spreadExpr) : asF64(emit(spreadExpr))],
    ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${arr}`]]]],
    ['local.set', `$${idx}`, reverse ? ['i32.sub', ['local.get', `$${len}`], ['i32.const', 1]] : ['i32.const', 0]],
    ['block', `$break${loopId}`,
      ['loop', `$continue${loopId}`,
        ['br_if', `$break${loopId}`, exhausted],
        ...bodyFn(arr, idx, len),
        ['local.set', `$${idx}`, ['i32.add', ['local.get', `$${idx}`], ['i32.const', reverse ? -1 : 1]]],
        ['br', `$continue${loopId}`]]],
  ]
}

function emitAsValue(fn) {
  return withExpectedValue(null, fn)
}

function emitSingleSpreadMethodCall(objArg, parsed, method, methodEmitter) {
  const inPlace = SPREAD_MUTATORS.has(method)
  // unshift prepends each arg to the front — forward iteration reverses intent.
  const reverse = method === 'unshift'
  const acc = `${T}acc${freshId(ctx)}`
  ctx.func.locals.set(acc, 'f64')
  const ir = [['local.set', `$${acc}`, asF64(emit(objArg))]]
  if (reverse) {
    // unshift(a, b, ...s): ES yields [a, b, ...s, ...existing]. Per-element
    // PREPENDS must run right-to-left over the WHOLE argument list — spread
    // elements first (end→start), the normal args last — or the spread lands
    // in front of the normals ([...s, a, b, ...] — the order bug that broke
    // the kernel's own `inject.unshift(setBase, ...stores)`). Argument
    // EVALUATION order stays left-to-right: normals spill to temps first.
    const temps = parsed.normal.map((a) => {
      const t = `${T}usv${freshId(ctx)}`
      ctx.func.locals.set(t, 'f64')
      ir.push(['local.set', `$${t}`, asF64(emitAsValue(() => emit(a)))])
      return t
    })
    ir.push(...emitSpreadElementLoop(parsed.spreads[0].expr, (arr, idx) => {
      const body = asF64(emitAsValue(() => methodEmitter(objArg, ['[]', arr, idx])))
      return [['drop', body]]
    }, { reverse: true }))
    if (temps.length) ir.push(['drop', asF64(emitAsValue(() => methodEmitter(objArg, ...temps)))])
    ir.push(asF64(emit(objArg)))
    return block64(...ir)
  }
  if (parsed.normal.length > 0) {
    const r = asF64(emitAsValue(() => methodEmitter(objArg, ...parsed.normal)))
    ir.push(inPlace ? ['drop', r] : ['local.set', `$${acc}`, r])
  }
  ir.push(...emitSpreadElementLoop(parsed.spreads[0].expr, (arr, idx) => {
    const body = asF64(emitAsValue(() => methodEmitter(inPlace ? objArg : acc, ['[]', arr, idx])))
    return [inPlace ? ['drop', body] : ['local.set', `$${acc}`, body]]
  }, { reverse }))
  ir.push(inPlace ? asF64(emit(objArg)) : ['local.get', `$${acc}`])
  return block64(...ir)
}

/** General spread mix: iterate combined args in original order, batch contiguous
 *  normal args into a single methodEmitter call, emit a per-element loop for each
 *  spread. For in-place methods chains via `objArg` (source variable); otherwise
 *  threads through an accumulator local. */
function emitMultiSpreadMethodCall(objArg, parsed, method, methodEmitter) {
  const inPlace = SPREAD_MUTATORS.has(method)
  const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
  // Accumulator (only used when not in-place); recv passed to methodEmitter is the live target.
  const acc = inPlace ? null : `${T}acc${freshId(ctx)}`
  if (acc) ctx.func.locals.set(acc, 'f64')
  const recv = inPlace ? objArg : acc
  const ir = inPlace ? [] : [['local.set', `$${acc}`, asF64(emit(objArg))]]
  if (method === 'unshift') {
    // Prepends compose right-to-left (see emitSingleSpreadMethodCall's reverse
    // arm). Evaluation order stays left-to-right: spill every segment first —
    // normal args to value temps, each spread's source array to a temp — then
    // walk the segments END→START, spreads iterating end→start, each normal
    // batch prepended through the multi-arg emitter (which lands its own args
    // in argument order).
    const segs = []
    for (const item of combined) {
      if (Array.isArray(item) && item[0] === '__spread') {
        const t = `${T}ussp${freshId(ctx)}`
        ctx.func.locals.set(t, 'f64')
        ir.push(['local.set', `$${t}`, asF64(emitAsValue(() => emit(item[1])))])
        segs.push(['spread', t])
      } else {
        const t = `${T}usv${freshId(ctx)}`
        ctx.func.locals.set(t, 'f64')
        ir.push(['local.set', `$${t}`, asF64(emitAsValue(() => emit(item)))])
        if (segs.length && segs[segs.length - 1][0] === 'batch') segs[segs.length - 1].push(t)
        else segs.push(['batch', t])
      }
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      const [kind, ...temps] = segs[i]
      if (kind === 'spread') {
        ir.push(...emitSpreadElementLoop(temps[0], (arr, idx) => {
          const body = asF64(emitAsValue(() => methodEmitter(objArg, ['[]', arr, idx])))
          return [['drop', body]]
        }, { reverse: true }))
      } else {
        ir.push(['drop', asF64(emitAsValue(() => methodEmitter(objArg, ...temps)))])
      }
    }
    ir.push(asF64(emit(objArg)))
    return block64(...ir)
  }
  let batch = []
  const flushBatch = () => {
    if (!batch.length) return
    const r = asF64(emitAsValue(() => methodEmitter(recv, ...batch)))
    ir.push(inPlace ? ['drop', r] : ['local.set', `$${acc}`, r])
    batch = []
  }
  for (const item of combined) {
    if (Array.isArray(item) && item[0] === '__spread') {
      flushBatch()
      ir.push(...emitSpreadElementLoop(item[1], (arr, idx) => {
        const body = asF64(emitAsValue(() => methodEmitter(recv, ['[]', arr, idx])))
        return [inPlace ? ['drop', body] : ['local.set', `$${acc}`, body]]
      }))
    } else {
      batch.push(item)
    }
  }
  flushBatch()
  ir.push(inPlace ? asF64(emit(objArg)) : ['local.get', `$${acc}`])
  return block64(...ir)
}

/** Method-emitter call: directly, or via one of the spread fast paths. */
export function emitMethodCallSpread(objArg, methodEmitter, parsed, method) {
  if (!parsed.hasSpread) return methodEmitter(objArg, ...parsed.normal)
  // A zero-argument Date method ignores supplied values, but JS still
  // evaluates and iterates every spread exactly once before the call.
  if (ctx.core.emit[`.date:${method}`] === methodEmitter && emitArity(methodEmitter) <= 1) {
    const recv = temp('dateSpreadRecv')
    const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
    return block64(
      ['local.set', `$${recv}`, asF64(emit(objArg))],
      ['drop', asF64(buildArrayWithSpreads(combined))],
      asF64(methodEmitter(recv)))
  }
  if (method === 'push' && parsed.normal.length === 0 &&
      parsed.spreads.length === 1 && typeof objArg === 'string')
    return emitBulkPushSpread(objArg, parsed)
  if (parsed.spreads.length === 1 && parsed.spreads[0].pos === parsed.normal.length)
    return emitSingleSpreadMethodCall(objArg, parsed, method, methodEmitter)
  return emitMultiSpreadMethodCall(objArg, parsed, method, methodEmitter)
}
