/**
 * Module-level prepare state: six independent stacks/scalars that together form the
 * prepare-pass working set (reinitialized by `resetPrepState`, registered as a ctx.js
 * reset-hook so a throw inside a prior prepare() can never leak into the next compile),
 * plus a handful of zero-dependency lookup tables and helpers (GLOBALS, NS_CTORS,
 * builtinMemberKey, freshPrepareId) hoisted here from their thematic homes — left in
 * place, they'd each create a spurious module cycle with a consumer that isn't part of
 * the real handlers.js SCC (see .work/prepare-split.md's §Cycles).
 *
 * @module prepare/state
 */

import { JZ_NULL, JZ_UNDEF } from '../ast.js'
import { ctx, registerResetHook } from '../ctx.js'
import { ERR_CLASS_NAMES } from '../../err-codes.js'
import { TYPED_ELEM_NAMES } from '../../layout.js'



// SIMD intrinsic namespaces — pure namespaces backed by the `simd` module.
export const SIMD_NS = new Set(['f32x4', 'i32x4', 'f64x2', 'v128'])
// prep()'s ctx.features.error scan below — O(1) membership over the 7 built-in
// error classes (.work/archive/todo.md §deletion-sweep §2).
export const ERR_CLASS_SET = new Set(ERR_CLASS_NAMES)

// `instanceof` RHS allowlist (.work/archive/todo.md §deletion-sweep §4). jz has no prototype chain, so
// RHS support is closed: Array/Map/Set fold or tag-compare (PTR.ARRAY/MAP/SET); the 8
// TYPED_ELEM_NAMES ctors + ArrayBuffer tag/aux-compare (PTR.TYPED+aux / PTR.BUFFER); the
// 7 Error classes tag+sid-compare (module/schema.js's ctx.schema.errorSid — one
// distinct sid per class). Deliberately NARROWER than
// layout.js's full TYPED_CTORS (14 names): excluded here —
//   - BigInt64Array / BigUint64Array: layout.js's encodeTypedElemAux collapses BOTH to
//     the identical aux (base code 7 | TYPED_ELEM_BIGINT_FLAG) — no bit distinguishes
//     them once the static ctor is unknown, so a runtime aux-compare can't tell them
//     apart. Same "tag-indistinguishable → reject" call this file already makes for
//     WeakMap/WeakSet below, extended here to a collision the design doc's own RHS
//     table didn't flag.
//   - Float16Array / Uint8ClampedArray: not a collision (their extra flag bit IS unique),
//     simply out of the shipped scope — omitted for symmetry with the two ctors above
//     rather than partially widening TYPED_ELEM_NAMES.
//   - DataView: layout.js encodes a DataView descriptor as PTR.TYPED with aux=
//     TYPED_ELEM_VIEW_FLAG alone (base code 0) — bit-identical to a VIEW Int8Array
//     (`new Int8Array(buffer)`, aux = TYPED_ELEM_CODE.Int8Array(0) | VIEW_FLAG). Same
//     tag-indistinguishable reasoning; the design doc's table never listed DataView as
//     supported RHS in the first place, so this is a confirmation, not a new cut.
export const INSTANCEOF_ALLOW = new Set(['Array', 'Map', 'Set', 'ArrayBuffer', ...TYPED_ELEM_NAMES, ...ERR_CLASS_NAMES])

// Module-level prepare state. Six independent stacks/scalars that together form
// the prepare-pass working set. Lifecycle: reinitialized by `resetPrepState()`,
// registered below as a ctx.js reset-hook —
// every reset()/beginSession() call clears it, so a throw inside a PRIOR prepare()
// can never leak into the next compile either. Kept at module scope (rather than
// ctx.prepare.*) because 78 read sites would mean a single indirection on every
// scope query; the consolidated reset documents the set.
// Reassigned from OUTSIDE this module (handlers.js's '=>' key does depth++/depth--;
// prepareModule and entry.js's prepare() both reassign depth and reassignedTopLevel) —
// ES modules forbid assigning through an imported `let` binding, so exactly these three
// (and only these three; the other 13 module-state lets below are only ever mutated in
// place via .push/.add/indexed writes, safe as plain `export let`) bundle into one
// exported mutable object. Every read/write site became prepState.x (.work/prepare-split.md).
// reassignedTopLevel: Per-module set of top-level names WRITTEN beyond their declaration (bare-name
// assign/compound/++ anywhere in the module, locals-shadowed writes excluded).
// Gates defFunc: a depth-0 `let g = (…) => …` lifts into a fixed NAMED FUNCTION,
// sound only while the binding is immutable — JS lets a `let`/`var` function
// binding be reassigned (even from inside a function), and lifting such a
// binding froze callers onto the first value (reads resolved to the minted
// function; the write targeted a binding that no longer existed — "'g' is not
// in scope" / silently-stale first arrow). Mirror of fn-namespace's multiProp
// demotion: a reassigned name stays an ordinary closure-valued global
// (writable, indirect-callable); devirtGlobalCalls re-devirts the init-order-
// resolvable cases afterward. Stacked per module (recursive imports swap it).
export const prepState = {
  depth: undefined,               // arrow nesting depth (0=top-level, >0=inside function)
  ownerUniq: undefined,
  reassignedTopLevel: undefined,  // see rationale above
}
export let scopes         // block scope stack: [{names: Set, renames: Map}]
export let staticConstScopes  // lexical const facts: [[strings?, arrays?, consts?]]
export const STATIC_STRINGS = 0, STATIC_ARRAYS = 1, STATIC_CONSTS = 2
export let assignedStaticGlobals
export let mutatedArrayNames  // raw names with any indexed/.length/mutating-method op anywhere (census)
// Per-arrow set of names already declared anywhere in the function body. Used
// to force a rename when the same identifier is declared in two sibling blocks
// (else-if arms, separate { ... } chunks): without renaming, both decls lower
// to the same WASM local, but downstream optimizations (directClosures) gate
// on per-decl `isReassigned`, not per-WASM-local — they'd read a stale binding.
export let funcLocalNames
// Per-arrow set of local names bound to a function literal (`let g = () => …`).
// Lets the `.`-handler tell a function receiver — where `.caller`/`.callee` are
// prohibited introspection — from a data object that merely has such a field.
export let funcValueNames
// Names bound directly to jz's own Promise-runtime helper CALLS (jzify/
// async.js's ASYNC_RUNTIME + jzify/transform.js's Promise canonicalization —
// `new Promise(fn)` → __p_exec(fn), `Promise.withResolvers()` →
// __p_withResolvers()): the ONE static proof the `.`-handler's isFuncValueRecv
// check (below) needs to recognize `.then`/`.resolve`/`.reject` read off THESE
// SPECIFIC receivers as function-valued too, alongside the existing bound-name
// case. FLAT (not a per-scope stack like funcValueNames): safe because it's
// keyed by the SAME post-rename-unique spelling every OTHER name-based fact in
// this file already relies on (mintForScope never reuses a spelling across
// live scopes; a module-level name is unique by construction). Populated once,
// at decl-processing time, right where funcValueNames gets its own entries.
export let promiseRecvNames  // `.then`/`.catch`/`.finally` are function-valued
export let withResolversRecvNames  // `.resolve`/`.reject` are function-valued
export let assignSid      // name → sid|null of the agreed literal shape across `=` assignments (consensus/poison; vars binding is module-scope only)
export let declInitUnknown  // Set<name> — bindings whose value source the `=`-assignment consensus
                     // never sees (explicit non-literal decl initializer, params, catch,
                     // destructure targets). BindingId totality makes this a plain
                     // per-binding fact — the old owner-scoped reachability + bar census
                     // (bindSites/assignBindOwners) existed only because bare names could
                     // collide across functions, which is now unrepresentable.
export let ownerStack     // arrow-nesting ids: [0] = module scope; '=>' pushes a fresh id. A
                   // binding's owner is the arrow that declares it; an assignment can reach
                   // any binding whose owner id is on the assignment's stack (shadows are
                   // renamed by prep, so reachable-same-name ⇒ same binding).
export let renameSerial   // per-arrow mint counters for BindingId names (parallel to ownerStack)
// ES §14.7.4.7 per-iteration bindings at MODULE scope (depth 0): names of
// let/const declared directly in a loop BODY (for/for-of/for-in's desugared
// bind, or the for-head captured-let copy-in) that a nested closure inside
// THAT loop captures. `depth` alone can't gate this — it only tracks
// function/arrow nesting, not loop nesting, so a module-top-level loop is
// still "depth 0" and its body-lets would otherwise take the single-instance
// global fast path (declareGlobal) that every OTHER depth-0 binding correctly
// wants (module init runs once). A loop body doesn't: each iteration is its
// own lexical environment, so a captured loop-local needs the SAME per-
// binding-instance treatment a function-scope loop already gets for free
// (its body-lets are always wasm locals, never globals). Pushed/popped
// around a loop's body in the 'for' handler; consulted by declareGlobal,
// prescanBlockDecls, and prepDecl's depth-0 promotion checks so a marked
// name mints a fresh local (mintLocal) instead of a shared global — routing
// it through the EXACT mechanism a function-scope loop-let already uses
// (mintLocal's per-arrow ownerStack id defaults to 0 = module scope, so it
// mints safely with no function context). Once local, the existing emit-time
// per-iteration-cell machinery (emitLoopFreshBoxed/emitDecl, gated on
// ctx.func.boxed) takes over exactly as it does inside a function — value-
// capture-at-closure-creation already gives correct per-iteration semantics
// for the common (unmutated) case with zero extra machinery.
export let loopLocalNames

export const resetPrepState = () => {
  prepState.depth = 0
  scopes = []
  staticConstScopes = []
  assignedStaticGlobals = new Set()
  mutatedArrayNames = new Set()
  funcLocalNames = [new Set()]
  funcValueNames = [new Set()]
  promiseRecvNames = new Set()
  withResolversRecvNames = new Set()
  prepState.reassignedTopLevel = new Set()
  assignSid = new Map()
  declInitUnknown = new Set()
  ownerStack = [0]
  prepState.ownerUniq = 0
  renameSerial = [0]
  loopLocalNames = new Set()
}
registerResetHook(resetPrepState)

export const freshPrepareId = () => ctx.names.prepare++

// Named constants → numeric literals. The JZ_NULL/JZ_UNDEF atom sentinels live
// in ast.js — shared with emit without crossing the prepare↔compile boundary.
// Prototype-less (Object.create(null)): a plain `{}` inherits Object.prototype in V8, so
// `'valueOf' in CONSTANTS` / `CONSTANTS['toString']` would hit an inherited method and
// mis-resolve a user identifier named like an Object method (jz.js-only — kernel objects
// are already prototype-less). Same reason on F64_CONSTANTS / GLOBALS / REJECT_IDENTS.
export const CONSTANTS = Object.assign(Object.create(null), { 'true': true, 'false': false, 'null': JZ_NULL, 'undefined': JZ_UNDEF })
// NaN/Infinity stay as special f64 values in emit()
export const F64_CONSTANTS = Object.assign(Object.create(null), { 'NaN': NaN, 'Infinity': Infinity })

// Identifier prohibitions: op-policy.js REJECT_IDENTS (prep string nodes).

// Predefined globals seeded into scope.chain at ctx.reset().
// used in ctx.core.emit[]. Dotted lookups (Math.sin) go through the '.' handler which
// resolves via scope.chain → module 'math' → registers 'math.sin' emitter.
// Not actually "implicit imports" — these are ambient globals that exist in every jz/JS
// program (they do not live in any module). jzify auto-injecting imports would still
// need a list of these names to know what to emit, so the table lives here either way.
export const GLOBALS = Object.assign(Object.create(null), {
  Math: 'math',
  fs: 'fs',
  fetch: 'web',
  Number: 'Number',
  Array: 'Array',
  Object: 'Object',
  Symbol: 'Symbol',
  JSON: 'JSON',
  Date: 'Date',
  isNaN: 'number',
  isFinite: 'number',
  parseInt: 'number',
  parseFloat: 'number',
  encodeURIComponent: 'encodeURIComponent',
  decodeURIComponent: 'decodeURIComponent',
  encodeURI: 'encodeURI',
  decodeURI: 'decodeURI',
  atob: 'atob',
  btoa: 'btoa',
  crypto: 'crypto',
  navigator: 'navigator',
  Error: 'Error',
  // Error subclasses: distinct names in JS, but jz doesn't carry typed error
  // info — `throw` accepts any value and stringification goes through the
  // host. Treat them all as Error-shaped passthrough constructors so user
  // code that throws specific subclasses (`throw new SyntaxError(msg)`) compiles
  // identically. If we ever model `instanceof SyntaxError`, this is where to
  // distinguish them; until then the surfaced message is what matters.
  TypeError: 'Error',
  SyntaxError: 'Error',
  RangeError: 'Error',
  ReferenceError: 'Error',
  URIError: 'Error',
  EvalError: 'Error',
  BigInt: 'BigInt',
  TextEncoder: 'TextEncoder',
  TextDecoder: 'TextDecoder',
})
// Builtin-namespace constructors expose `prototype`/`length`/`name` as own
// properties; plain namespaces (Math, JSON, Reflect, Atomics) do not.
export const NS_CTORS = new Set(['Number', 'String', 'Boolean', 'BigInt', 'Object',
  'Array', 'Symbol', 'Error', 'Date', 'RegExp', 'Function', 'Map', 'Set',
  'Promise', 'ArrayBuffer', 'DataView', 'WeakMap', 'WeakSet'])

// --- Builtin-namespace member aliasing --------------------------------------
// `let/const name = NS.member` (`let sin = Math.sin`) and destructuring
// (`let { sin, PI } = Math`, incl. rename `{ pow: myPow }`) bind straight to
// the resolved emit key (`math.sin`) instead of materializing a real global —
// there's no first-class "Math.sin" runtime value, only the compiler's own
// dispatch table, so the alias makes every later reference to `name` behave
// exactly as if the source had written `Math.sin` there directly:
//   - `name(x)` — the bare-identifier branch in `prep()` (and `resolveCallee`)
//     already returns a dotted `scope.chain`/block-scope entry bare, so the
//     call lowers straight to `$math.sin`, no boxing, no arity ceiling (the
//     general shape behind the `const alias = fn` fast path above).
//   - a bare non-call reference falls through to the SAME first-class-value /
//     constant-fold path a literal `Math.sin` reference hits at emit time
//     (`builtinFunctionValue` / arity-0 constant fold) — succeeds or fails
//     identically to the dotted form; never silently wrong.
// Exports and reassignment are rejected with a clear error (see `registerBuiltinAlias`
// and the reassignment guard in the main `prep()` dispatch) rather than
// silently targeting no storage.

/** `node` is the flat dotted emit key prep's own `.` handler would produce for
 *  `NS.member` (e.g. `'math.sin'`) — i.e. a real, already-resolved builtin
 *  reference, not an ordinary value/expression. */
export function builtinMemberKey(node) {
  return typeof node === 'string' && node.includes('.') && ctx.core.emit[node] != null ? node : null
}