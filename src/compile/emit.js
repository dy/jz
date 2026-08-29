/**
 * AST → WASM IR emission — barrel module.
 *
 * # Stage contract
 *   IN:  prepared AST node + ctx state (func.locals/localReps/typedElem, etc.)
 *   OUT: IR node (array) with `.type` ('i32' | 'f64' | 'void'). For statements, a flat
 *        list of WASM instructions (no type tag).
 *   NO-MUTATE: emit does not rewrite the AST. Side effects go to ctx.runtime.*,
 *        ctx.core.includes (via inc()), ctx.func.uniq (local naming), and ctx.features.*.
 *
 * # Dispatch
 *   `emit(node, expect?)` handles literals inline and routes arrays to ctx.core.emit[op].
 *   `emitVoid(node)` emits + drops any value (statement context; routes block bodies to emitBlockBody).
 *   `emitBlockBody(node)` unwraps a `{}` block and concatenates flat statement IR.
 *
 * The emitter table (`emitter` export) is copied into ctx.core.emit by reset();
 * language modules add/override entries to extend dispatch.
 *
 * The implementation lives in src/compile/emit/*.js, split by family (see
 * .work/emit-split.md for the full family map and dependency-order rationale);
 * this file re-exports the same public names every one of its importers already
 * depends on, so no call site needs to change.
 *
 * # Families (src/compile/emit/*.js)
 *   - shared.js          — cross-family helpers (Arithmetic + Bitwise + Logical + dispatch)
 *   - i32-bounds.js       — i32-overflow-safety proofs + the loop-guard-hull channel
 *   - first-class.js      — builtins-as-first-class-closure-values
 *   - dispatch.js         — the SCC-forced core: emit, emitDecl, toBool, emitIdentitySafe,
 *                           emitVoid, emitBlockBody, and everything only they call
 *   - bigint.js           — BigInt joint-domain dispatch
 *   - call-args.js        — spread/argument marshalling for calls
 *   - method-dispatch.js  — the 12-strategy obj.method(args) dispatch chain
 *   - call.js             — direct/closure/generic call emission
 *   - instanceof.js       — the instanceof family
 *   - incdec.js           — ++/--/+1/-1
 *   - arithmetic.js       — +, -, u+, u-, *, / and %
 *   - comparisons.js      — ==/!=/instanceof/===/!==/</>/<=/>=
 *   - logical.js          — !/?:/&&/||/??/void/(
 *   - bitwise.js          — ~/&/|/^/<</>>/>>>
 *   - statements.js       — ;/{/,/let/const/export/block/throw/catch/finally/return
 *   - control-flow.js     — if/for/switch/while/label/break/continue
 *   - assignment.js       — =/+=/-=/*=//=/%=/**=/&=/|=/^=/>>=/<<=/>>>=/||=/&&=/??=
 *   - index.js            — assembles `emitter` from every family's op group
 *
 * @module emit
 */

export { emit, emitDecl, toBool, emitIdentitySafe, emitVoid, emitBlockBody, emitBoolStr, emitIndex, resolveClosureTableParamLattice } from './emit/dispatch.js'
export { FIRST_CLASS_BUILTIN_NAMES } from './emit/first-class.js'
export { emitTypeofCmp } from './emit/comparisons.js'
export { materializeMulti, buildArrayWithSpreads } from './emit/call-args.js'
export { emitLoopFreshBoxed } from './emit/control-flow.js'
export { emitter } from './emit/index.js'
