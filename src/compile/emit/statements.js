/**
 * canThrow, emitFinalizers plus the '...' catch-all and the ;/{/,/let/const/export/block/throw/catch/finally/return emitter properties.
 *
 * @module compile/emit/statements
 */

import { ctx, err } from '../../ctx.js'
import {
  applyBigintRepresentationAction, asF64, asParamType, asPtrOffset, block64, carrierF64Narrow, freshId, tcoTailRewrite, temp, tempI32, tempI64, typed, undefExpr,
} from '../../ir.js'
import { hasAmbiguousBoolMerge, valTypeOf } from '../../kind.js'
import { VAL } from '../../reps.js'
import { staticPropertyKey } from '../../static.js'
import { isTerminator } from '../../type.js'
import { withFinallyStack, withTryState } from '../flow-state.js'
import { representationReturnAction } from '../representation-plan.js'
import { emit, emitDecl, emitIdentitySafe, emitVoid, toBool } from './dispatch.js'
import { storedValue } from './method-dispatch.js'


function canThrow(body, seen = new Set()) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'throw') return true
  // Unresolved ordinary `.length` now performs a real property Get, including
  // the nullish TypeError. Keep a surrounding source try/catch live even when
  // there is no explicit `throw` node in the AST. Optional chaining does not
  // throw and stays excluded.
  if (op === '.' && body[2] === 'length' && valTypeOf(body[1]) == null) return true
  if (op === '[]' && staticPropertyKey(body[2]) === 'length' && valTypeOf(body[1]) == null) return true
  // Typed element assignment can throw during ToNumber/ToBigInt even for an
  // OOB index. Keep a surrounding catch visible; the typed emitter either
  // emits the supported runtime throw or rejects an unrepresentable catch.
  if (op === '=' && Array.isArray(body[1]) && body[1][0] === '[]' && valTypeOf(body[1][1]) === VAL.TYPED) return true
  if (op === '=>') return false
  if (op === '()') {
    const callee = body[1]
    // A call can throw unless we can see the whole callee and prove it can't:
    // only direct calls into a resolvable, non-raw function body are traceable.
    // Indirect/method/builtin calls (callee not a plain name, or a name we can't
    // resolve) are conservatively throwing — a user `try` must wrap them.
    if (typeof callee !== 'string') return true
    const bodyName = ctx.func.directClosures?.get(callee)
    const f = ctx.funcs.map?.get(bodyName || callee)
    if (!f?.body || f.raw) return true
    if (!seen.has(f.name)) {
      seen.add(f.name)
      if (canThrow(f.body, seen)) return true
    }
  }
  for (let i = 1; i < body.length; i++) if (canThrow(body[i], seen)) return true
  return false
}

/** Emit pending `finally` cleanups for an abrupt control-flow exit.
 *  Inner cleanups run before outer cleanups. While emitting each cleanup, remove
 *  it from the active stack so `return` inside `finally` does not re-enter it.
 *  `minDepth` scopes the exit: only trys ENTERED at control-frame depth >= minDepth
 *  are being exited by this branch. A `continue`/`break` targeting a loop that
 *  CONTAINS the try runs its finally (the branch leaves the try body); a try that
 *  contains the whole loop stays live (control never leaves it) and must not run —
 *  each entry records ctx.func.stack.length at try entry, so a frame at index i
 *  scopes to entries with depth > i. `return` exits every frame (minDepth 0). */
export function emitFinalizers(minDepth = 0) {
  const stack = ctx.func.finallyStack || []
  if (stack.length === 0) return []
  const saved = stack.slice()
  const out = []
  for (let i = saved.length - 1; i >= 0 && saved[i].depth >= minDepth; i--)
    out.push(...withFinallyStack(saved.slice(0, i), () => emitVoid(saved[i].cleanup)))
  return out
}
export const spreadOp = {
  // === Spread operator ===
  // Note: spread is handled specially in call contexts; this catches stray uses
  '...': () => err('Spread (...) can only be used in function/method calls or array literals'),

}
export const statementOps = {
  // === Statements ===

  ';': (...args) => {
    const out = []
    for (const a of args) {
      out.push(...emitVoid(a))
      // Same dead-tail truncation as emitBlockBody's own statement loop (see
      // that function's comment for the full rationale) — needed HERE too,
      // separately: a `;`-list can arrive at emit already NESTED one level
      // inside a `{}`-block's own list (e.g. jzify's `do…while` desugaring —
      // transform.js `'do'` — wraps the loop body as `[';', flagReset,
      // userBody]`, so a user body of `break; FOR1;` lands as ONE list item,
      // `[';', ['break'], 'FOR1']`, from emitBlockBody's OUTER loop — that
      // loop's own isTerminator check sees only the LAST inner statement
      // (FOR1, not a terminator) and never looks inside). Without this, a
      // bare `break`/`continue`/`return`/`throw` mid-list here left its
      // FOLLOWING dead siblings walked anyway, wrongly hitting the bare-
      // identifier-fallback reject (src/compile/emit.js) for code real JS
      // never evaluates (confirmed live via test262 statements/break+continue/
      // line-terminators.js's ASI-split shape, a do…while body).
      if (isTerminator(a)) break
    }
    return out
  },
  '{': (...args) => args.map(emit).filter(x => x != null),
  ',': (...args) => {
    const results = args.map(emit).filter(x => x != null)
    if (results.length === 0) return null
    if (results.length === 1) return results[0]
    const last = results[results.length - 1]
    // Flatten: multi-instruction arrays (from ';') need spreading, typed nodes need drop
    const spread = r => Array.isArray(r) && Array.isArray(r[0]) ? r : [r]
    const dropSpread = r => r.type ? [['drop', r]] : spread(r)
    // If last expression is void (store, etc.), add explicit return value
    if (!last.type) {
      return block64(
        ...results.flatMap(dropSpread),
        ['f64.const', 0])
    }
    const seq = typed(['block', ['result', last.type],
      ...results.slice(0, -1).flatMap(dropSpread), last], last.type)
    // The sequence's VALUE is `last` — carry its value metadata, or downstream
    // coercions misread the carrier: an i32 OBJECT/CLOSURE pointer without its
    // ptrKind gets f64.convert_i32_s'd (`return (fn.a = 1, fn)` returned the raw
    // heap offset as a number). Same bug-class as the ternary's tagPtr (below).
    if (last.ptrKind != null) { seq.ptrKind = last.ptrKind; if (last.ptrAux != null) seq.ptrAux = last.ptrAux }
    if (last.unsigned) seq.unsigned = last.unsigned
    return seq
  },
  'let': emitDecl,
  'const': emitDecl,
  'export': () => null,
  // 'block' can appear from jzify transforming labeled blocks or as WASM block IR
  'block': (...args) => {
    // WASM block IR: first arg is ['result', type] → pass through, preserve type
    if (Array.isArray(args[0]) && args[0][0] === 'result')
      return typed(['block', ...args], args[0][1])
    const inner = args.length === 1 ? args[0] : [';', ...args]
    return emitVoid(['{}', inner])
  },

  'throw': expr => {
    ctx.runtime.throws = ctx.runtime.userThrows = true
    const thrown = temp()
    // The exception payload is an untyped ANY slot — exactly the boxed-value
    // contract storedValue exists for (container stores, collection keys/
    // values, generic call args; see its own doc comment above). A plain
    // `asF64(emit(expr))` was the 18th unnamed site of the MECHANISM A gap
    // bridge.js's storedValue doc comment describes: a bare Boolean thrown
    // value (`throw true`) emits as a raw i32 0/1 then f64-converts to a
    // plain 0.0/1.0 float — bit-identical to a genuinely thrown 0/1 number —
    // so `catch (e) { e === true }` reads false and `typeof e` reads
    // 'number', both wrong per ES 12.13 (audit-#12, BOOL_CARRIER family).
    // storedValue also correctly boxes an AMBIGUOUS BOOL∪NUMBER throw
    // (`throw cond && 1`) via emitIdentitySafe, and leaves every other kind
    // (number/string/object/BigInt) byte-identical to the old asF64(emit()).
    return typed(['block',
      ['local.set', `$${thrown}`, storedValue(expr)],
      ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['local.get', `$${thrown}`]]],
      ['throw', '$__jz_err', ['local.get', `$${thrown}`]]], 'void')
  },

  'catch': (body, errName, handler) => {
    if (!canThrow(body)) return emitVoid(body)

    ctx.runtime.throws = ctx.runtime.userThrows = true
    const id = freshId(ctx)
    ctx.func.locals.set(errName, 'f64')
    const bodyIR = withTryState(true, () => emitVoid(body))
    const handlerIR = emitVoid(handler)
    return typed(['block', `$outer${id}`, ['result', 'f64'],
      ['block', `$catch${id}`, ['result', 'f64'],
        ['try_table', ['catch', '$__jz_err', `$catch${id}`],
          ...bodyIR],
        ['f64.const', 0],
        ['br', `$outer${id}`]],
      ['local.set', `$${errName}`],
      // This catch fully HANDLES the error — nothing downstream
      // rethrows it — so $__jz_last_err_bits must not keep pointing at it. Left
      // set, a LATER genuine trap (OOB, stack overflow, …) unrelated to this
      // catch would read this stale marker at the host boundary and misdecode
      // as the already-handled error instead of a RuntimeError (interop.js's
      // decodeThrown only resets the marker on a decode that reaches the host —
      // an error fully handled in-wasm never does). Zeroed here, BEFORE the
      // handler runs, mirroring decodeThrown's own "consume on every decode"
      // reset — a `throw` inside the handler (rethrow or a new error) sets the
      // marker again via the 'throw' emitter above, so escaping-throw decode is
      // unaffected.
      ['global.set', '$__jz_last_err_bits', ['i64.const', 0]],
      ...handlerIR,
      ['f64.const', 0]], 'f64')
  },

  'finally': (body, cleanup) => {
    if (!canThrow(body)) {
      const parentStack = ctx.func.finallyStack || []
      const activeStack = parentStack.concat([{ cleanup, depth: ctx.func.stack.length }])
      const bodyIR = withFinallyStack(activeStack, () => emitVoid(body))
      const cleanupIR = isTerminator(body) ? [] : withFinallyStack(parentStack, () => emitVoid(cleanup))
      return [...bodyIR, ...cleanupIR]
    }

    ctx.runtime.throws = ctx.runtime.userThrows = true
    const id = freshId(ctx)
    const errLocal = temp('err')
    const parentStack = ctx.func.finallyStack || []
    const activeStack = parentStack.concat([{ cleanup, depth: ctx.func.stack.length }])

    const bodyIR = withTryState(true, () => withFinallyStack(activeStack, () => emitVoid(body)))
    const normalCleanup = withFinallyStack(parentStack, () => emitVoid(cleanup))
    const throwCleanup = withFinallyStack(parentStack, () => emitVoid(cleanup))

    return ['block', `$fin_done${id}`,
      ['block', `$fin_catch${id}`, ['result', 'f64'],
        ['try_table', ['catch', '$__jz_err', `$fin_catch${id}`],
          ...bodyIR],
        ...normalCleanup,
        ['br', `$fin_done${id}`]],
      ['local.set', `$${errLocal}`],
      // Mirrors 'catch' above: zero BEFORE throwCleanup runs, not
      // after. Two outcomes, both correct: (1) throwCleanup falls through
      // normally → the rethrow below unconditionally re-sets the marker to
      // errLocal's real bits before throwing, so escaping-throw decode is
      // unaffected. (2) throwCleanup itself terminates early (a `return`/`break`
      // in the `finally` block, which per spec SWALLOWS the pending exception —
      // the rethrow below is then dead code, never reached) → the marker stays
      // zeroed instead of dangling at the now-suppressed error's stale value,
      // so a later genuine trap in this instance decodes as RuntimeError, not
      // the swallowed error.
      ['global.set', '$__jz_last_err_bits', ['i64.const', 0]],
      ...throwCleanup,
      ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['local.get', `$${errLocal}`]]],
      ['throw', '$__jz_err', ['local.get', `$${errLocal}`]]]
  },

  'return': expr => {
    const finalizers = emitFinalizers()
    const finalizerBlock = () => [['block', ...finalizers]]
    if (ctx.func.current?.results.length > 1 && Array.isArray(expr) && expr[0] === '[') {
      const vals = expr.slice(1).map(e => asF64(emit(e)))
      if (finalizers.length === 0) return typed(['return', ...vals], 'void')
      const names = vals.map(() => temp('ret'))
      return [
        ...vals.map((v, i) => ['local.set', `$${names[i]}`, v]),
        ...finalizerBlock(),
        typed(['return', ...names.map(n => ['local.get', `$${n}`])], 'void'),
      ]
    }
    // A value-less `return;` yields `undefined` per spec (not null). The function
    // result is never i32-narrowed when a bare return is present (see hasBareReturn
    // guard in narrowI32Results), so the f64 UNDEF carrier is type-compatible.
    if (expr == null) return [...finalizers, typed(['return', undefExpr()], 'void')]
    const rt = ctx.func.current?.results[0] || 'f64'
    const pk = ctx.func.current?.ptrKind
    // Emit ONCE, before branching on pk — self-compile miscompile: the equivalent inline
    // form `pk != null ? asPtrOffset(emit(expr), pk) : asParamType(emit(expr), rt)`
    // (emit(expr) repeated once per ternary arm, only one ever executing) is behaviorally
    // identical in JS but the self-compiled kernel drops the f64.convert_i32_s/u rebox on
    // the taken arm's result — an i32-typed return tail comes back bare (unconverted) in
    // a non-narrowed (f64-result) function, so the wasm validator sees "expected f64, got
    // i32" at every return site shaped like `return (expr)|0` inside a function whose
    // result the narrower left at f64 (e.g. blocked by an unrelated same-name shadow
    // elsewhere — narrowI32Results itself is unaffected either way). compile/index.js's
    // sibling call site (`const ir = emit(body); … ptrKind != null ? asPtrOffset(ir, …) :
    // asParamType(ir, …)`) already used this materialize-then-branch shape and was never
    // affected — mirroring it here is both the fix and the more idiomatic form (DRY: one
    // emit call instead of a copy per arm). Root cause not fully localized beyond "the
    // self-compiled kernel, at every optimize level 0-2, treats a value produced by a call
    // repeated textually across both arms of a ternary differently from one materialized
    // to a local first" — pinned in test/parser-bugs.js rather than chased further into
    // the kernel's own call/branch codegen. See .work/todo.md (groundtruth archive).
    // Closure-convention bodies return into a boxed-value position (the ftN f64
    // slot): a BOOL value must cross as its true/false atom — the result-side
    // mirror of closure.call's carrierF64 args. Raw funcs keep the plain 0/1
    // ONLY when the function's return kind is proven uniformly BOOL, OR when
    // there's just one return statement at all (see ctx.func.mixedAtomReturn,
    // set in index.js emitFunc — its comment has the full "why >=2 returns"
    // rationale, including the Set/Map single-return regression a coarser
    // `valResult !== VAL.BOOL` gate caused; also documents the ADDITIVE
    // single-return admission when the lone return is an ambiguous BOOL-merge).
    // A genuinely mixed func (>= 2 return statements, not provably uniform
    // BOOL, or a single ambiguous-merge return) must box a statically-BOOL
    // return tail here: an unproven-kind call result is exactly the
    // "dynamic/unknown" operand the rest of the compiler already assumes
    // carries booleans as their atom (emitStrictEq's BOOL-vs-unknown branch,
    // '+'​'s atom-aware numSide, __to_num) — leaving it raw silently crossed
    // `return false` as the plain float 0, indistinguishable from a real 0 at
    // the call site (audit #5 item 2, ledger "KERNEL LEG ZERO FAILS" —
    // boolconst). carrierF64 is a no-op (byte-identical to asParamType/asF64)
    // whenever this return's own static valType isn't BOOL, so uniform-NUMBER
    // (or any non-bool-mixed) funcs are untouched.
    //
    // An ambiguous BOOL-merge return (`s => cond ? 1 : false`,
    // .work/todo.md §deletion-sweep) needs the SAME box but carrierF64
    // is post-hoc powerless for it: `expr`'s own valTypeOf collapses to NUMBER
    // (the merge's benign coercion), so carrierF64 never recognizes it as
    // BOOL-carrying — by the time `emitted` exists, the coerced false and a
    // genuine 0 are already the same bits. emitIdentitySafe re-emits the merge
    // with its own BOOL arm boxed to its atom BEFORE that collapse, so it must
    // replace `emit(expr)` itself here (not wrap its result) — single emission
    // preserved (still exactly one of emit/emitIdentitySafe runs).
    const boxes = pk == null && rt === 'f64' && (ctx.func.boxedResult || ctx.func.mixedAtomReturn)
    const resultBool = pk == null && rt === 'i32' && ctx.func.valResult === VAL.BOOL
    const ambiguous = boxes && hasAmbiguousBoolMerge(expr)
    // A proven boolean i32 result needs truthiness conversion. ToInt32 on an
    // opaque f64 boolean carrier turns every NaN-boxed true/false atom into 0.
    // Select the boolean emitter up front so expr is still evaluated once.
    let emitted = resultBool ? toBool(expr) : ambiguous ? emitIdentitySafe(expr) : emit(expr)
    if (!resultBool)
      emitted = applyBigintRepresentationAction(emitted, expr, representationReturnAction(ctx, expr))
    // Slice 2 (CARRIER PROGRAM, .work/carrier-representation-design.md §7)
    // return def-side wiring — carrierF64Narrow (ir.js), NOT the plain
    // carrierF64 `boxes` used pre-Slice-2: see its own doc comment for why an
    // unconditional inline-BIGINT box is wrong at ANY return position (a
    // uniform function OR a closure/mixed-atom-return one) — it only fires
    // for a bare name independently proven boxed by some OTHER sink in this
    // same body (a dict store earlier, a closure capture, …), the one case
    // where re-using the decision here introduces no NEW ambiguity a caller
    // wasn't already going to see. `ctx.func.boxedResult`/`mixedAtomReturn`
    // (`boxes`) keep their PRE-Slice-2 BOOL-atom-boxing behavior verbatim —
    // carrierF64Narrow's BOOL branch is carrierF64's, untouched.
    //
    // `!ctx.func.exported` gates only the plain (non-`boxes`) path: even the
    // bare-name-proven case must skip a proven-BIGINT export's own
    // unambiguous i64 ABI (Bug 1, synthesizeBoundaryWrappers — see below).
    // Not needed on the `boxes` path: `ctx.func.boxedResult` never applies to
    // a top-level export (closures aren't exports), and `mixedAtomReturn` on
    // an exported function means the export's OWN return type isn't a proven
    // uniform BIGINT (mixedAtomReturn's condition is `valResult !== VAL.BOOL`
    // regardless of what it IS, but a proven-uniform-BIGINT export would take
    // the OTHER, `needsBox`-shaped ABI instead) — so its wrapper already takes
    // the dynamic/tagged result ABI a box is correct for.
    const ir = resultBool ? emitted
      : pk != null ? asPtrOffset(emitted, pk)
      : boxes ? (ambiguous ? emitted : carrierF64Narrow(expr, emitted, 'return'))
      : asParamType(emitted, rt)
    const ty = pk != null ? 'i32' : rt
    const tcoed = tcoTailRewrite(ir, ty)
    if (Array.isArray(tcoed) && tcoed[0] === 'return_call' && finalizers.length === 0) {
      return typed(tcoed, 'void')
    }
    if (finalizers.length > 0) {
      const name = ty === 'i32' ? tempI32('ret') : ty === 'i64' ? tempI64('ret') : temp('ret')
      return [
        ['local.set', `$${name}`, tcoed],
        ...finalizerBlock(),
        typed(['return', ['local.get', `$${name}`]], 'void'),
      ]
    }
    return typed(['return', tcoed], 'void')
  },

}
