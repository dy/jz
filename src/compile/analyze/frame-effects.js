/**
 * Frame effects: what a function does to memory that outlives its own frame,
 * and what a loop iteration does to memory that outlives the iteration.
 *
 * Two facts per function, read off the prepared AST and the program summary
 * before any function is emitted:
 *
 *   writesOuter  — the body may write storage that exists before the call:
 *                  a store into any receiver that is not a fresh local
 *                  aggregate, a write to a module or captured binding, a
 *                  call whose callee is unknown or a host import. A caller
 *                  may keep a cached memory load across a call to a function
 *                  that does not write outer storage.
 *   arenaUnsafe  — every call lets a value it allocated outlive every
 *                  frame: an escape with no address (below) that runs on
 *                  every call. The arena rewind (optimize/arena-rewind.js)
 *                  restores the heap pointer at return; a function that lets
 *                  an allocation escape its frame must not rewind, or the
 *                  escaped pointer dangles into memory the next allocation
 *                  overwrites.
 *   keeps        — every call writes a value it may have allocated into
 *                  storage older than its own frame (a parameter's, a
 *                  captured binding's): the function's own frame never
 *                  restores, a caller's may, where the storage is the
 *                  caller's own.
 *
 * A fresh local aggregate is a binding declared in this body (not a
 * parameter, not captured from an enclosing scope) whose every assignment is
 * a literal, a `new` expression or an `Array(n)` call: storage allocated
 * inside this frame. Stores into it are stores into fresh memory. Should the
 * aggregate itself escape, the store that lets it escape is a store into
 * outer storage and is counted there.
 *
 * The same census runs per loop, with the loop body as the scope: a binding
 * declared inside the body is the iteration's own, everything else (the
 * function's other locals, its parameters, module state) is outer. A loop
 * whose iteration lets no allocation escape and that builds a value (a
 * literal, a `new`, a concatenation, a fresh-value method, itself or in a
 * function it calls: a callee's allocations belong to the iteration that
 * called it, and go with it) restores the heap pointer at the top of every
 * iteration (emit/control-flow.js), so a loop building a temporary per row
 * runs in constant memory.
 *
 *   callsUnknown — the body runs code the census cannot name: a call whose
 *                  target is no known function (a closure value, a computed
 *                  callee, a host import, an unlisted method, a member of
 *                  a receiver the summary cannot type, a callback the
 *                  census cannot see).
 *
 * An escape is a write that may let a value the call allocated outlive a
 * frame: a heap value stored into storage that is not the scope's own fresh
 * local, a captured or module binding assigned one, a growth of a container
 * (its storage extends or relocates into fresh memory). Whether it outlives a
 * given frame is a question of age: the storage written into is older than
 * the frame, or it is the frame's own and goes with it. So for a function's
 * or a closure's frame an escape is a site (`sites`, `conditional`): where it
 * runs, the emitter lowers the escape flag to the address written into
 * (emit/dispatch.js; `siteKinds` says what the node writes into: its
 * receiver, the binding it assigns, its first argument, or nothing the
 * emitter can read, which lowers the flag to zero), and a frame restores the
 * heap at return when the flag stands at or above its own mark (optimize/
 * arena-rewind.js). A store of a value that holds no heap pointer escapes
 * only where it makes its receiver grow (a relocation, a property's first
 * storage, a key made a string): its site lowers the flag after the store,
 * and only when the store allocated (`siteGrown`), what its operands
 * allocated as they were evaluated not counting (`allocatesNothing`: a
 * temporary the value is computed of, a host's copy). In a loop that allocates
 * nothing else, calls nothing and that neither a `return` nor a jump to a
 * label leaves, the check stands around the outermost such loop the
 * receiver's binding stays the same through (`siteNames`), so a loop of
 * numeric stores pays it once. So does a store of a value its receiver held
 * already, read off it by the store itself (`a[i] = a[j]`) or by the one
 * write of a local (`const t = a[i]`, a swap): had a running call made the
 * value, the store that first put it there lowered the flag to the same
 * receiver. A temporary built of closures, cells and objects inside a call
 * goes with the call; a state made on the first call,
 * `if (!buf) buf = new Float64Array(n)`, keeps that call's memory and
 * releases every later call's; a scratch array kept in a module binding and
 * refilled each call keeps the call in which it outgrows its capacity.
 *
 * An escape may not run on a call when it sits in a branch (an `if` or `?:`
 * arm, the right side of `&&`, `||`, `??`, a logical assignment's store, a
 * `catch` handler) or after a statement that may return. One that runs on
 * every call decides the function's own frame before it runs: with no address
 * it is `arenaUnsafe`, as is a frame that suspends (`yield`, `await`); into
 * storage older than the frame it is `keeps`. Not so an assignment of a value
 * that is not surely made by the call: its site asks the value as it is
 * stored whether a running call made it (a number, a buffer swapped for
 * another, a string of the module's own lower nothing), so the frame waits
 * for the flag. A loop's own census takes every escape for a verdict: its
 * per-iteration restore reads no flag.
 *
 * A call the census cannot name (a closure value, a member of a receiver the
 * summary cannot type, a computed callee) is no escape: it runs code of the
 * module, whose own escapes lower the flag where they run, every closure
 * being censused (transitiveFrameEffects), or the host's, which link flags
 * where the import is called. What a builtin of the called name would store
 * into its receiver is a store into it. A call through a binding the summary
 * resolves to closures (`calleeOf`: the closures the binding may hold, the
 * audio atom's `proc(…)`) joins their arena facts to the caller's
 * (`closureCalls`). Either call stays an unknown for `writesOuter` and
 * `callsUnknown`, whose readers look into a callee by function name, which a
 * closure has none of.
 *
 * The facts are transitive over direct calls to same-module functions
 * (`transitiveFrameEffects`, an iterative fixpoint over the call graph):
 * `writesOuter` and `callsUnknown` over every call; `arenaUnsafe` over the
 * calls that run on every call of the caller (`unguarded`), any other call to
 * such a callee making the caller's frame conditional, as a callee that
 * `keeps` or runs sites does. The facts retain direct `callees`; frameReaches
 * walks those edges when a consumer needs to inspect reached code (the
 * declared-keys pass checks whether an intervening call can see a literal).
 * A loop is clean when its own
 * census is, it calls nothing the census cannot name, and every callee it
 * reaches neither escapes nor runs a site. Everything here is a conservative
 * census: an unrecognized shape counts as an effect, never as its absence.
 *
 * @module compile/analyze/frame-effects
 */
import { ASSIGN_OPS, ACCESSOR_GET, ACCESSOR_SET, RELATIONAL_OPS, isFunctionNode, extractParams } from '../../ast.js'
import { K, tagOf, hasTag, tagsOf, valOf, core, NUMBER_OPS } from '../../summary/kind.js'
import { TO_PRIMITIVE, runsAccessor, runsConversion, primitiveKind, primitiveElements, mayBeTyped } from '../../evaluation-effects.js'
export { runsAccessor, runsConversion } from '../../evaluation-effects.js'
import { ctx } from '../../ctx.js'
import { frameRoots } from '../../function.js'
import { viewsOn } from '../../../module/schema.js'
import { TO_JSON } from '../emit/to-json.js'
import { reachOn } from '../../../module/core/reach.js'

const isArr = Array.isArray
const isName = (x) => typeof x === 'string'

// A branch's first operand that may not run: an `if` or `?:` arm, the right
// side of a short-circuit, a `catch` handler (`['catch', body, name, handler]`).
const BRANCH_ARM = { 'if': 2, '?:': 2, '&&': 2, '||': 2, '??': 2, 'catch': 3 }
/** Whether a statement may return from the function it runs in. */
function mayReturn(n) {
  if (!isArr(n) || isFunctionNode(n)) return false
  if (n[0] === 'return') return true
  for (let i = 1; i < n.length; i++) if (mayReturn(n[i])) return true
  return false
}
/** Whether a loop may be left past what stands right after it: by a return,
 *  or by a jump to a label (the label may stand outside the loop). */
function mayLeave(n) {
  if (!isArr(n) || isFunctionNode(n)) return false
  if (n[0] === 'return' || ((n[0] === 'break' || n[0] === 'continue') && n[1] != null)) return true
  for (let i = 1; i < n.length; i++) if (mayLeave(n[i])) return true
  return false
}
/** Whether evaluating `n` runs no code of the program's: no call, no
 *  construction, no suspension, no accessor, no conversion method. */
function runsNothing(view, n) {
  if (!isArr(n)) return true
  const op = n[0]
  if (op === '()' || op === '?.()' || op === 'new' || op === 'yield' || op === 'await' || op === '__tp_call') return false
  if (runsAccessor(view, n) || runsConversion(view, n)) return false
  for (let i = 1; i < n.length; i++) if (!runsNothing(view, n[i])) return false
  return true
}
/** Whether evaluating `e` allocates nothing, whatever it yields: a name, a
 *  literal that is no aggregate, an operator of scalars over such operands,
 *  an element of an array or a typed array read as a scalar. Anything else
 *  may: a literal, a call, a concatenation, a read the host answers with a
 *  copy. A site that waits for its store to allocate keeps its mark past an
 *  operand that may (emit/dispatch.js). */
const SCALAR_OPS = new Set([...NUMBER_OPS, ...RELATIONAL_OPS, '+', 'u-', 'u+', '!', '==', '!=', '===', '!==', '&&', '||', '??', '?:', 'typeof', 'void'])
export function allocatesNothing(view, e) {
  if (!isArr(e)) return true
  const op = e[0]
  if (op == null || op === 'bool' || op === 'str') return true
  if (e.length === 1) return op !== '[' && op !== '{}'
  if (op === '++' || op === '--' || !scalarKind(view, e) || runsConversion(view, e) || runsAccessor(view, e)) return false
  if (op === '[]' && e.length === 3) {
    let k
    try { k = view.kindOfExpr(e[1]) } catch { return false }
    const t = k == null ? K.ANY : tagOf(k)
    return (t === K.ARRAY || t === K.TYPED) && scalarKind(view, e[2]) && allocatesNothing(view, e[1]) && allocatesNothing(view, e[2])
  }
  if (!SCALAR_OPS.has(op)) return false
  for (let i = 1; i < e.length; i++) if (!allocatesNothing(view, e[i])) return false
  return true
}
/** Whether two expressions are spelled the same. */
function sameSpelling(a, b) {
  if (!isArr(a) || !isArr(b)) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!sameSpelling(a[i], b[i])) return false
  return true
}
/** Whether `name` is assigned or bound (declared, a parameter) anywhere inside `n`. */
function rebinds(n, name) {
  if (!isArr(n)) return false
  const op = n[0]
  if ((ASSIGN_OPS.has(op) || op === '++' || op === '--') && n[1] === name) return true
  if (op === 'let' || op === 'const') for (let i = 1; i < n.length; i++) { const d = n[i]; if (d === name || isArr(d) && d[0] === '=' && patternNames(d[1]).includes(name)) return true }
  if (isFunctionNode(n) && patternNames(n[1]).includes(name)) return true
  for (let i = 1; i < n.length; i++) if (rebinds(n[i], name)) return true
  return false
}
// Callees that read their arguments and receivers only, apart from a callback
// callbackArg names. Mirrors the summary's PURE_BUILTINS (src/summary/index.js)
// plus the numeric/string globals whose results are fresh values or scalars,
// and the lane operations (module/simd.js), which compute on values wasm
// holds outside the heap. `math.` is the prepared spelling of `Math.`.
const PURE_CALLEES = /^(__object_rest|Function|readStdin|(f32x4|f64x2|i32x4|v128)\.\w+|crypto\.(getRandomValues|randomUUID)|Object\.(keys|values|entries|isFrozen|isSealed|isExtensible|freeze|seal|preventExtensions|create|getOwnPropertyDescriptor|getOwnPropertyNames|getPrototypeOf|hasOwn|is|fromEntries|groupBy)|Map\.groupBy|JSON\.(stringify|parse)|Array\.(isArray|of|from)|ArrayBuffer\.isView|((Int|Uint|Float|BigInt|BigUint)(8|16|32|64)(Clamped)?Array|Float16Array)\.(from|fromBase64|fromHex)|console\.\w+|[Mm]ath\.\w+|Number(\.\w+)?|String(\.\w+)?|Boolean|BigInt(\.\w+)?|Symbol(\.\w+)?|Atomics\.\w+|RegExp\.escape|Date\.now|performance\.now|isNaN|isFinite|parseInt|parseFloat|structuredClone|Date\.UTC|Date\.parse|atob|btoa|(en|de)codeURI(Component)?)$/
// Pure callees that read a literal's getters (module/schema.js viewsOn) while
// they list its properties; JSON.stringify also calls toJSON (emit/to-json.js).
const ENUMERATING = /^(__object_rest|Object\.(values|entries)|JSON\.stringify|structuredClone)$/
const runsGetters = (name) => viewsOn() && ENUMERATING.test(name) || name === 'JSON.stringify' && !!ctx.funcs.runtimeRoots?.has(TO_JSON)

// Callees whose result is a scalar: no allocation.
const SCALAR_CALLEES = /^((f32x4|f64x2|i32x4|v128)\.\w+|crypto\.getRandomValues|[Mm]ath\.\w+|Number(\.\w+)?|Boolean|isNaN|isFinite|parseInt|parseFloat|Date\.now|performance\.now)$/

// Constructors whose instances are fresh storage with no user code run.
const FRESH_CTORS = /^(Array|Object|Map|Set|WeakMap|WeakSet|Date|RegExp|Error|TypeError|RangeError|SyntaxError|ReferenceError|URIError|EvalError|TextEncoder|TextDecoder|String|Number|Boolean|ArrayBuffer|DataView|(Int|Uint|Float|BigInt|BigUint)(8|16|32|64)(Clamped)?Array|Float16Array)$/

// Receiver methods that read the receiver and their arguments only; their
// results are scalars or fresh values. Everything not listed (and not a
// mutator below) is unknown.
const READ_METHODS = new Set([
  // array / typed / string reads
  'slice', 'subarray', 'indexOf', 'lastIndexOf', 'includes', 'join', 'concat', 'at', 'entries', 'keys', 'values',
  'toString', 'toReversed', 'toSpliced', 'with', 'flat', 'toLocaleString', 'valueOf',
  'charAt', 'charCodeAt', 'codePointAt', 'startsWith', 'endsWith', 'trim', 'trimStart', 'trimEnd', 'padStart', 'padEnd',
  'split', 'substring', 'substr', 'toUpperCase', 'toLowerCase', 'repeat', 'localeCompare', 'normalize', 'search', 'match', 'matchAll',
  'toFixed', 'toPrecision', 'toExponential',
  // collections
  'get', 'has', 'size',
  // regex / date reads
  'test', 'exec', 'getTime', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds',
  'getUTCFullYear', 'getUTCMonth', 'getUTCDate', 'getUTCDay', 'getUTCHours', 'getUTCMinutes', 'getUTCSeconds', 'getUTCMilliseconds', 'getTimezoneOffset', 'toISOString', 'toJSON',
  // buffers
  'getInt8', 'getUint8', 'getInt16', 'getUint16', 'getInt32', 'getUint32', 'getFloat32', 'getFloat64', 'getBigInt64', 'getBigUint64',
])
// Read methods whose result is a scalar: no allocation.
const SCALAR_METHODS = new Set(['indexOf', 'lastIndexOf', 'includes', 'charCodeAt', 'codePointAt', 'startsWith', 'endsWith', 'localeCompare', 'search', 'test', 'has', 'size',
  'getTime', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds',
  'getUTCFullYear', 'getUTCMonth', 'getUTCDate', 'getUTCDay', 'getUTCHours', 'getUTCMinutes', 'getUTCSeconds', 'getUTCMilliseconds', 'getTimezoneOffset',
  'getInt8', 'getUint8', 'getInt16', 'getUint16', 'getInt32', 'getUint32', 'getFloat32', 'getFloat64'])

// Receiver methods that run a callback synchronously over the receiver and
// retain nothing: the callback body is part of this frame.
const CALLBACK_METHODS = new Set(['forEach', 'map', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'sort', 'toSorted', 'replace', 'replaceAll'])
// Pure callees that call an argument back before they return, by its position:
// `Array.from(src, mapFn)` runs mapFn in this frame, as `map` does; so does a
// typed array's `from`.
const callbackArg = (name) => name === 'Array.from' || name === 'Object.groupBy' || name === 'Map.groupBy' || TYPED_FROM.test(name) ? 1 : undefined
const TYPED_FROM = /^((Int|Uint|Float|BigInt|BigUint)(8|16|32|64)(Clamped)?Array|Float16Array)\.from$/

// Pure callees that convert no argument.
const NON_CONVERTING = /^(__object_rest|Array\.(isArray|of|from)|Object\.(is|getPrototypeOf|isFrozen|keys|values|entries|getOwnPropertyNames)|Boolean|Date\.now|performance\.now)$/
// Constructors that convert their arguments (a typed array each element of an array source).
const CONVERTING_CTORS = /^(Date|String|Number|BigInt|(Int|Uint|Float|BigInt|BigUint)(8|16|32|64)(Clamped)?Array|Float16Array)$/
const TYPED_CTORS = /^((Int|Uint|Float|BigInt|BigUint)(8|16|32|64)(Clamped)?Array|Float16Array)$/
// Receiver methods that convert the receiver's elements (`[p].join()` runs p.toString).
const CONVERTING_RECEIVER_METHODS = new Set(['join', 'toString', 'toLocaleString'])
// Receiver methods that write the receiver in place without changing its
// storage: a write into outer storage, never a growth.
const WRITE_METHODS = new Set(['fill', 'copyWithin', 'reverse',
  'setInt8', 'setUint8', 'setInt16', 'setUint16', 'setInt32', 'setUint32', 'setFloat32', 'setFloat64', 'setBigInt64', 'setBigUint64',
  'setTime', 'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds',
  'setUTCFullYear', 'setUTCMonth', 'setUTCDate', 'setUTCHours', 'setUTCMinutes', 'setUTCSeconds', 'setUTCMilliseconds'])

// Receiver methods that may grow or relocate the receiver's storage, or store
// a heap value into it.
const GROW_METHODS = new Set(['push', 'unshift', 'splice', 'pop', 'shift', 'add', 'delete', 'clear', 'set', 'setPrototypeOf'])
// Builtins whose result is storage they make, and the methods of an array, a
// typed array or a string that hand out a copy.
const MAKES = /^(__object_rest|Array\.(of|from)|Object\.(keys|values|entries|fromEntries)|((Int|Uint|Float|BigInt|BigUint)(8|16|32|64)(Clamped)?Array|Float16Array)\.(of|from)|structuredClone)$/
const COPY_METHODS = new Set(['slice', 'concat', 'map', 'filter', 'flat', 'flatMap', 'toSorted', 'toReversed', 'toSpliced', 'with', 'split'])
// Those of them that store nothing and free no storage.
const SHRINK_METHODS = new Set(['delete', 'clear', 'pop', 'shift'])
// The runtime's own readers of a value's bits, which its library calls by
// name, and the mark a class's constructor puts on a member it just stored
// (jzify/classes.js): a bit of the entry, no value.
const READS_POINTER = /^__(ptr_offset|ptr_type|ptr_aux|mkptr|box_bigint|unbox_bigint|object_toString|heap_mark|heap_large|hide_member)$/
// A builtin's namespace: a call under it the census lists nowhere may do anything with its arguments.
const STATICS = /^(Object|Reflect|Atomics|Array\.prototype|Function|Promise)\./
// Builtins that write into their first argument.
const WRITES_FIRST = /^(Object\.(assign|defineProperty|defineProperties|setPrototypeOf)|Reflect\.(set|defineProperty|setPrototypeOf))$/

// Functions of the runtime whose member stores into their own locals lend a
// value for a time they end themselves: the binding records of std/iter.js,
// which hold an iterator from their opening to their close, within one frame.
const SCRATCH = new Set(['jz_iter$__it_open'])

// What a site writes into, for the emitter to read its address where the site
// runs (emit/dispatch.js): the receiver of the node's store or call, the same
// for a store a typed array turns into numbers, the binding the node assigns,
// the node's first argument; or nothing it can read: the flag goes to zero.
export const SITE = { RECV: 'recv', ELEM: 'elem', CELL: 'cell', ROOT: 'root', ARG: 'arg', ZERO: 'zero' }

/** The constructor a prepared `new X(...)` call names (`new.X`), or null. */
const ctorOf = (callee) => isName(callee) && callee.startsWith('new.') ? callee.slice(4) : null

/** Whether the census lists the builtin a call names, by what it keeps of
 *  its arguments. A call of one it does not list is an escape with no
 *  address wherever it runs: a builtin the runtime gains is listed here, or
 *  named by test/frame-effects.js among those that keep what they are handed. */
export const listedBuiltin = (callee) => {
  const c = ctorOf(callee)
  if (c !== null) return FRESH_CTORS.test(c)
  return callee === '__iter_arr' || callee === '__keys_ro' || callee === '__keys_dyn' || PURE_CALLEES.test(callee) ||
    FRESH_CTORS.test(callee) || WRITES_FIRST.test(callee) || READS_POINTER.test(callee)
}

/** Names a `new` or bare call resolves to a same-module function. */
const knownFunc = (name) => isName(name) && ctx.funcs.map?.get(name) != null

/** The class-method or member callee a `.`-call resolves to, or null. */
const resolveMember = (obj, method) => {
  const programIndex = ctx.plans?.programIndex
  const sourceId = programIndex?.resolveMemberSourceId?.(obj, method) ?? -1
  return sourceId >= 0 ? programIndex.sourceFunctionById(sourceId) : null
}

/** Whether an expression's value may carry a heap pointer allocated during
 *  this call. Literals and proven scalars cannot; a string literal is static
 *  data. Everything the summary cannot prove scalar may. */
function mayCarryFreshHeap(view, e) {
  if (e == null || isName(e)) return isName(e) ? !scalarKind(view, e) : false
  if (!isArr(e)) return false
  const op = e[0]
  if (op == null) return false            // number / string literal / null
  if (op === 'bool' || op === 'str') return false
  if (e.length === 1 && op !== '[' && op !== '{}') return false   // undefined; an empty literal is a value made
  if (op === 'typeof' || op === '!' || op === 'void') return false
  return !scalarKind(view, e)
}

/** The summary proves the expression a scalar (number, boolean, nullish). */
function scalarKind(view, e) {
  if (!view) return false
  let k
  try { k = view.kindOfExpr(e) } catch { return false }
  if (k == null) return false
  const t = tagOf(k)
  if (t === K.NUMBER || t === K.BOOL || t === K.NULLISH || t === K.ABSENT) return true
  if (t === K.ANY || t === K.NONE) return false
  // A union of scalars only.
  return !hasTag(k, K.STRING) && !hasTag(k, K.OBJECT) && !hasTag(k, K.ARRAY) && !hasTag(k, K.CLOSURE) &&
    !hasTag(k, K.MAP) && !hasTag(k, K.SET) && !hasTag(k, K.HASH) && !hasTag(k, K.TYPED) && !hasTag(k, K.BIGINT) &&
    !hasTag(k, K.DATE) && !hasTag(k, K.REGEX) && !hasTag(k, K.BUFFER) && tagOf(k) !== K.ANY
}

/** The summary does not prove the expression holds no BigInt: arithmetic on one makes another. */
function mayBeBigint(view, e) {
  if (!view) return true
  let k
  try { k = view.kindOfExpr(e) } catch { return true }
  return k == null || tagsOf(k) === 0 || hasTag(k, K.BIGINT)
}

/** A store of `prop` into the receiver writes a slot in place: the summary
 *  lists the receiver's layouts and each declares the property. Any other
 *  property takes storage of its own the first time it is written. */
/** The index is an integer literal below the fixed length of the array `recv` holds. */
function withinFixedLen(view, recv, index) {
  if (!view || !isArr(index) || index[0] != null || !Number.isInteger(index[1]) || index[1] < 0) return false
  try { return index[1] < view.fixedLenOfExpr(recv) } catch { return false }
}
function fixedSlot(view, recv, prop) {
  if (!view || !isName(prop)) return false
  let sids
  try { sids = view.shapesOfExpr(recv) } catch { return false }
  return !!sids?.length && sids.every(sid => view.layoutSlot(sid, prop))
}

/** The class functions a member reaches on the receiver's listed layouts: a
 *  method by its name, an accessor's getter or setter by its slot name
 *  (`x__get`, `x__set`). Named when the receiver's kind has an object part,
 *  no own property may shadow the name, and every layout is a class with the
 *  member (a layout without an accessor reads its slot; one without a method
 *  runs code the census cannot name, as does one whose schema declares the
 *  accessor slot, an object literal's own getter or setter closure, or one
 *  that may carry a static pair beside its slots, jzify/classes.js; a lost
 *  layout keeps its class and its slot names, so it resolves like any other).
 *  A receiver that may be nullish throws before any call. Null where the
 *  census cannot name them. */
function memberFunctions(view, recv, prop, slot, method) {
  if (!view) return null
  let k
  try { k = view.kindOfExpr(recv) } catch { return null }
  if (k == null || !hasTag(k, K.OBJECT)) return null
  if (ctx.summary?.memberMayBeOwn?.(prop)) return null
  const sids = view.shapesOfExpr(recv)
  if (!sids?.length) return null
  const dynamic = !method && ctx.transform?.dynamicAccessorNames?.has(prop) === true
  const fns = new Set()
  for (const sid of sids) {
    const fn = view.layoutMember(sid, slot)
    if (fn) fns.add(fn)
    else if (method || view.layoutSlot(sid, slot) || (dynamic && view.layoutSide(sid, slot))) return null
  }
  return fns
}
const NO_FUNCTIONS = Object.freeze(new Set())

/** The receiver is a typed array or ArrayBuffer view: element stores are
 *  numbers into fixed storage. */
const NO_NAMES = new Set()
function typedReceiver(view, recv) {
  if (!view) return false
  let k
  try { k = view.kindOfExpr(recv) } catch { return false }
  return k != null && (tagOf(k) === K.TYPED || tagOf(k) === K.BUFFER)
}

/** Fresh expression: storage allocated in this frame with no user code run
 *  on the way (a class constructor is a call, counted by the call census). */
const freshInit = (e) => {
  if (!isArr(e)) return false
  const op = e[0]
  if (isObjectLiteral(e) || op === '[') return true   // an object literal, an array literal (prepared spelling: `[` builds, `[]` indexes)
  if (op === '?:') return freshInit(e[2]) && freshInit(e[3])   // a choice between fresh values
  if (op === 'new' && isArr(e[1]) && e[1][0] === '()') return isName(e[1][1]) && (FRESH_CTORS.test(e[1][1]) || knownFunc(e[1][1]))
  if (op === '()' && isName(e[1])) { const c = ctorOf(e[1]); return e[1] === 'Array' || (c !== null && (FRESH_CTORS.test(c) || knownFunc(c))) }
  return false
}

// `{}` spells both a block statement (its child a statement list) and an object
// literal (properties `[':', k, v]`, shorthand names, spreads); only the literal allocates.
const isObjectLiteral = (n) => isArr(n) && n[0] === '{}' && (n.length === 1 || isName(n[1]) || (isArr(n[1]) && (n[1][0] === ':' || n[1][0] === '...')))
const argList = (args) => args == null ? [] : isArr(args) && args[0] === ',' ? args.slice(1) : [args]

/**
 * Census of one scope: `roots` are the nodes to walk (a function body, or a
 * loop's condition, step and body), `declRoots` the nodes whose declarations
 * belong to the scope (the body), `params` the names bound by the function.
 * Nested function bodies are entered only for the callbacks CALLBACK_METHODS
 * and callbackArg run synchronously and for local arrows called from this scope.
 */
function census(view, roots, declRoots, params, typedParams = NO_NAMES, conditional = false, scratch = false) {
  // A parameter the export boundary types (narrow/param-abi.js `boundaryTyped`)
  // is a typed array the summary, built before the narrowing, still holds as
  // any value: element stores into it are numbers into fixed storage.
  const typedRecv = (recv) => typedReceiver(view, recv) || (isName(recv) && typedParams.has(recv))
  // `unguarded`: the callees a call reaches on every call of this scope;
  // `closureCalls`: per resolved call, the closures it may run and whether it
  // runs on every call; `inline`: the arrows walked as part of this scope.
  // `siteGrows`: the sites whose store may make its receiver grow, `siteGrown`
  // those that escape no other way; `siteNames`: per loop that is one, the
  // receivers its stores may grow; `siteAsked`: the assignments that ask
  // their value whether a running call made it.
  const out = { writesOuter: false, arenaUnsafe: false, keeps: false, flagged: false, unsited: false, allocates: false, callsUnknown: false, runsAccessor: false, why: null, keepsWhy: null,
    callees: new Set(), unguarded: new Set(), closures: new Set(), closureCalls: [], sites: new Set(), siteWhy: null, siteKinds: new Map(), siteGrows: new Set(), siteGrown: new Set(), siteAsked: new Set(), siteNames: new Map(), siteWhys: new Map(), inline: new Set(), freshObjects: null }
  // The node the walk stands on: an escape found there is a site of it.
  let at = null
  // Branches and early returns around it: nonzero where it may not run on a call.
  let guarded = 0
  // The loop statements around it, outermost first, each with the growths
  // found inside it that wait for its end to learn where their check stands
  // (`pending`); a function's body the walk entered ends the run (`opaque`):
  // its loops are not the enclosing ones'. `noise` counts what may allocate
  // besides a store's own growth: an allocation, a call.
  const loops = [], opaque = { node: null, pending: null }
  let noise = 0
  // A growth's check: around `best`, a loop, or after the store itself.
  const settle = ({ name, kind, at, why, best }) => {
    if (best !== null) {
      const names = out.siteNames.get(best) ?? out.siteNames.set(best, new Map()).get(best)
      names.set(name, names.has(name) && names.get(name) !== kind ? SITE.RECV : kind)
      if (!out.sites.has(best)) { out.sites.add(best); out.siteGrown.add(best); out.siteWhys.set(best, why) }
    } else {
      out.siteGrows.add(at)
      if (out.sites.has(at)) return
      out.sites.add(at); out.siteGrown.add(at); out.siteKinds.set(at, kind); out.siteWhys.set(at, why)
    }
  }
  // The end of a loop: where it is quiet (it allocates nothing but by its
  // stores' growth, and neither a `return` nor a jump to a label leaves it)
  // each growth it holds the receiver of may stand around it, or around a
  // loop further out.
  const endLoop = () => {
    const { node, pending, noise: before } = loops.pop()
    const quiet = noise === before && !mayLeave(node), parent = loops[loops.length - 1]
    for (const g of pending) {
      if (!quiet || rebinds(node, g.name)) { settle(g); continue }
      g.best = node
      if (parent !== undefined && parent !== opaque) parent.pending.push(g); else settle(g)
    }
  }

  // 1. Fresh locals: declared here, every write a fresh initializer, no write
  //    from any nested function. Arrows bound to a const are scanned inline
  //    when called.
  const decl = new Map()      // name → 'fresh' | 'other'
  const arrows = new Map()    // name → arrow node bound by a const, never reassigned
  const reads = new Map()     // name → the member or element read its one write, its declaration, binds
  const assigned = new Set()  // names an assignment of this scope writes
  const scanned = new Set()   // arrows already walked as part of this scope (a recursive arrow calls itself)
  const writtenNested = new Set()
  const nestedDecl = new Set()   // names a nested function declares or binds: its own locals
  // `declared`: a let/const/var of this scope. A write to a name the scope does
  // not declare is a write to an enclosing binding and must not enter `decl`,
  // or the effect walk would take it for a local.
  const note = (name, init, nested, declared) => {
    if (!isName(name)) return
    if (nested) { writtenNested.add(name); if (declared) nestedDecl.add(name); return }
    const cur = decl.get(name)
    if (!declared) assigned.add(name)
    if (!declared && cur == null) return
    // Object literals allocate in this call, after the reset boundary. Keep
    // this narrower than freshInit: a user constructor or Object(existing)
    // can return older storage. Every write must keep the literal origin.
    if (declared && cur == null && (init === undefined || isObjectLiteral(init)))
      (out.freshObjects ??= new Set()).add(name)
    else if (init !== undefined && !isObjectLiteral(init)) out.freshObjects?.delete(name)
    if (declared && cur == null && isArr(init) && (init[0] === '.' || init[0] === '[]') && init.length === 3) reads.set(name, init); else reads.delete(name)
    if (init === undefined) { if (cur == null) decl.set(name, 'fresh'); return }   // bare `let x`
    const fresh = freshInit(init)
    decl.set(name, cur === 'other' || !fresh ? 'other' : 'fresh')
    if (isArr(init) && init[0] === '=>') { if (arrows.has(name) || cur != null) arrows.delete(name); else arrows.set(name, init) } else arrows.delete(name)
  }
  const scanDecls = (n, nested) => {
    if (!isArr(n)) return
    const op = n[0]
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (isName(d)) { note(d, undefined, nested, true); continue }
        if (!isArr(d) || d[0] !== '=') continue
        if (isName(d[1])) note(d[1], d[2], nested, true)
        else for (const nm of patternNames(d[1])) note(nm, null, nested, true)
        scanDecls(d[2], nested)   // the initializer, and the functions it makes (`const f = () => { x = … }`)
      }
      return
    }
    if (ASSIGN_OPS.has(op)) {
      if (isName(n[1])) note(n[1], op === '=' ? n[2] : null, nested, false)
      // an element store (`[]` indexes in the prepared spelling) writes no binding
      else if (isArr(n[1]) && n[1][0] === '{}') for (const nm of patternNames(n[1])) note(nm, null, nested, false)
    }
    if (op === '++' || op === '--') { if (isName(n[1])) note(n[1], null, nested, false) }
    const inner = isFunctionNode(n)
    if (inner) for (const nm of patternNames(n[1])) nestedDecl.add(nm)
    for (let i = 1; i < n.length; i++) scanDecls(n[i], nested || inner)
  }
  for (const r of declRoots) scanDecls(r, false)
  if (out.freshObjects) for (const name of out.freshObjects)
    if (params.has(name) || writtenNested.has(name)) out.freshObjects.delete(name)
  // A write from a nested function to a name the scope does not declare is a
  // write to a shared cell of an enclosing scope: outer, like the name itself.
  const freshLocal = (name) => isName(name) && decl.get(name) === 'fresh' && !params.has(name) && !writtenNested.has(name)
  // A binding of an enclosing scope or of the module: neither this scope's
  // nor a nested function's own.
  const outerName = (name) => !decl.has(name) && !params.has(name) && !nestedDecl.has(name)
  // What the name holds is older than the frame whatever the call does: a
  // parameter's value, an enclosing binding's.
  const olderName = (e) => isName(e) && (params.has(e) || outerName(e))

  // 2. Effects.
  const outer = () => { out.writesOuter = true }
  const verdict = (why) => { if (!out.arenaUnsafe) { out.arenaUnsafe = true; out.why = why } }
  // An escape at the node the walk stands on. A loop's census takes it for a
  // verdict. A frame's (`conditional`) takes it for a site of kind `kind`
  // (SITE), and decides the frame itself where the escape runs on every call:
  // with no address, or suspending the frame, no call restores (`arenaUnsafe`);
  // into storage older than the frame (`older`), none of this function's does
  // (`keeps`). A growth (`grows`) is a site of no node: the runtime lowers the
  // flag where the storage relocates, and only then.
  const escape = (why, kind = SITE.ZERO, { older = false, suspends = false, grows = null, asked = false } = {}) => {
    out.writesOuter = true
    if (!conditional) return verdict(why)
    out.flagged = true
    out.siteWhy ??= why
    if (suspends) verdict(why)
    if (at === null) { out.unsited = true; return verdict(why) }
    if (grows !== null) {
      const g = { name: grows, kind, at, why, best: null }, loop = loops[loops.length - 1]
      if (isName(grows) && loop !== undefined && loop !== opaque) loop.pending.push(g); else settle(g)
      return
    }
    const prev = out.siteGrown.has(at) ? undefined : out.siteKinds.get(at)
    if (prev !== undefined && prev !== kind) kind = SITE.ZERO
    // it asks its value only where every escape of the node does
    if (asked && (prev === undefined || out.siteAsked.has(at))) out.siteAsked.add(at); else out.siteAsked.delete(at)
    out.sites.add(at)
    out.siteGrown.delete(at)
    out.siteKinds.set(at, kind)
    out.siteWhys.set(at, why)
    if (guarded > 0 || suspends || asked) return
    if (kind === SITE.ZERO) verdict(why)
    else if (older && !out.keeps) { out.keeps = true; out.keepsWhy = why }
  }
  // A call the census cannot name: no escape of a frame (the code it runs
  // lowers the flag itself), a verdict of a loop.
  const unknownCall = (why) => {
    out.callsUnknown = true; out.writesOuter = true
    noise++
    if (!conditional) return verdict(why)
    out.flagged = true
    out.siteWhy ??= 'calls code the census cannot name: ' + why
  }
  const allocates = () => { out.allocates = true; noise++ }
  // A callee a call of this scope reaches, on every call where no branch stands before it.
  const reach = (name) => { noise++; out.callees.add(name); if (guarded === 0) out.unguarded.add(name) }
  // What the emitter can read again where a site runs: a name, or a path of
  // members and keys below one that runs no accessor and converts no key.
  const readable = (e) => isName(e) || (isArr(e) && readable(e[1]) && !runsAccessor(view, e) && !runsConversion(view, e) &&
    (e[0] === '.' ? isName(e[2]) && accessorFunctions(e[2], e[1], e[2] + ACCESSOR_GET) === NO_FUNCTIONS
      : e[0] === '[]' && e.length === 3 && (isName(e[2]) || (isArr(e[2]) && e[2][0] == null))))
  const spell = (e) => isName(e) ? e : '<expr>'
  // A read or store of a property named like an accessor: the class getters
  // or setters it reaches on this receiver (none where the summary rules an
  // accessor out: a kind that is no object, an array's or a string's own
  // `length`; layouts without it), or null where the census cannot name them
  // (a class value may carry a static pair, jzify/classes.js).
  const accessorFunctions = (prop, recv, slot) => {
    if (!isName(prop) || !ctx.transform?.accessorNames?.has(prop)) return NO_FUNCTIONS
    if (!view) return null
    let k
    try { k = view.kindOfExpr(recv) } catch { return null }
    if (k == null) return null
    if (hasTag(k, K.CLOSURE) && ctx.transform?.dynamicAccessorNames?.has(prop)) return null
    if (!hasTag(k, K.OBJECT)) return tagOf(k) === K.ANY || tagOf(k) === K.NONE ? null : NO_FUNCTIONS
    return memberFunctions(view, recv, prop, slot, false)
  }
  const reaches = (fns) => { for (const fn of fns) reach(fn) }
  const converts = ctx.funcs.runtimeRoots?.has(TO_PRIMITIVE.number)
  const conversion = () => { reach(TO_PRIMITIVE.number); reach(TO_PRIMITIVE.string) }
  const convert = (e) => { if (converts && e !== undefined && !primitiveKind(view, e)) conversion() }
  // A typed array converts a source's elements: primitive elements run no user code.
  const convertElements = (e) => { if (converts && e !== undefined && !primitiveKind(view, e) && !primitiveElements(view, e)) conversion() }

  // Map entry getters may run on any element, not just the first tuple slot.
  // A direct Map copy and entries with no object/function kind have no accessor.
  const mapEntries = (args) => {
    if (!ctx.transform?.accessorNames?.has('0') && !ctx.transform?.accessorNames?.has('1')) return
    const source = argList(args)[0]
    if (source === undefined) return
    const k = view?.kindOfExpr(source), t = k == null ? K.ANY : tagOf(k)
    if (t === K.MAP) return
    const entry = t === K.ARRAY || t === K.SET ? view.elemOfKind(k) : null
    if (entry != null && tagsOf(entry) !== 0 && !hasTag(entry, K.OBJECT) && !hasTag(entry, K.CLOSURE)) return
    out.runsAccessor = true
    unknownCall('Map entry accessor')
  }

  // A store into `recv`, of a value that may carry a heap pointer (`heap`):
  // fresh-local receivers are fresh memory; a nested path below a fresh local
  // (`o.a.b = v`) reaches storage the local's own stores placed there —
  // possibly outer values it aliases — so only the direct receiver counts.
  // `numeric`: a typed array takes the value as a number (an element store, a
  // method of it); a named property of one is a store like any other. `arg`:
  // the receiver is the call's first argument.
  // `asked`: the site asks the stored value whether a running call made it.
  const store = (recv, heap, grows, numeric = false, arg = false, asked = false) => {
    if (freshLocal(recv) || freshInit(recv) || madeHere(recv)) return
    outer()
    // a typed array takes numbers in place: nothing grows, nothing is held
    if (numeric && typedRecv(recv)) return
    const kind = !readable(recv) ? SITE.ZERO : arg ? SITE.ARG : numeric ? SITE.ELEM : SITE.RECV
    if (grows) escape('grows ' + spell(recv), kind, { grows: arg ? false : recv })
    if (heap) escape('heap value into ' + spell(recv), kind, { asked, older: olderName(recv) && !(numeric && mayBeTyped(view, recv)) })
  }
  const anyHeap = (list) => list.some(v => mayCarryFreshHeap(view, v))
  // A value the receiver of the store `n` held already, read off it by the
  // store itself (`a[i] = a[j]`) or by the one write of a local (`const t =
  // a[i]` … `a[j] = t`): the store hands the receiver nothing a store before
  // it did not. The read runs no accessor, and the receiver names one object
  // at the read and at the store: a path the emitter reads again, below a
  // name nothing rebinds meanwhile, with no code of the program's run between
  // (a conversion of the value itself runs after both are read).
  const heldBy = (recv, val, n) => {
    const local = isName(val)
    const read = local ? (params.has(val) || writtenNested.has(val) ? undefined : reads.get(val)) : val
    if (!isArr(read) || (read[0] !== '.' && read[0] !== '[]') || read.length !== 3) return false
    if (!readable(recv) || !sameSpelling(read[1], recv)) return false
    if (runsAccessor(view, read) || runsConversion(view, read)) return false
    const prop = read[0] === '.' ? read[2] : isArr(read[2]) && read[2][0] == null && typeof read[2][1] === 'string' ? read[2][1] : null
    if (prop !== null && accessorFunctions(prop, recv, prop + ACCESSOR_GET) !== NO_FUNCTIONS) return false
    let root = recv
    while (isArr(root)) root = root[1]
    if (local) return isName(recv) && !assigned.has(root) && !writtenNested.has(root) && (params.has(root) || decl.has(root))
    return runsNothing(view, n[1][2]) && !runsConversion(view, n[1]) && runsNothing(view, read) && !rebinds(n, root)
  }
  // A receiver the expression itself makes: what a builtin builds of its
  // arguments (`Float64Array.from(xs)`), a copy a builtin's receiver hands
  // out (`xs.slice()`). A store into it is a store into fresh memory.
  const madeHere = (e) => {
    if (!isArr(e) || e[0] !== '()') return false
    const callee = e[1]
    if (isName(callee)) return MAKES.test(callee)
    if (!isArr(callee) || callee[0] !== '.' || !isName(callee[2])) return false
    if (isName(callee[1]) && MAKES.test(`${callee[1]}.${callee[2]}`)) return true
    if (!COPY_METHODS.has(callee[2])) return false
    let k
    try { k = view?.kindOfExpr(callee[1]) } catch { return false }
    const t = k == null ? K.ANY : tagOf(k)
    return (t === K.ARRAY || t === K.TYPED || t === K.STRING) && !ctx.summary?.memberMayBeOwnOn(callee[2], valOf(core(k)))
  }
  // An arrow walked as part of this scope: its sites are this census's. A
  // function literal handed to a builtin that calls it and keeps nothing has
  // no other caller (`inline`); an arrow a name holds may be called anywhere.
  const scanArrow = (arrow, literal = false) => {
    if (literal) out.inline.add(arrow)
    noise++
    if (scanned.has(arrow)) return
    scanned.add(arrow)
    loops.push(opaque)
    walkExpr(arrow[arrow.length - 1])
    loops.pop()
  }
  // The arrow a name holds wherever it is called: bound once in this scope,
  // never rebound by a nested function, no parameter.
  const localArrow = (name) => isName(name) && arrows.has(name) && !writtenNested.has(name) && !params.has(name)
  // A callback runs in this frame: a function literal or a local arrow is
  // walked in place; any other value the summary cannot prove a scalar may be
  // a closure the census cannot see (true: the call is unknown).
  const callback = (a, what) => {
    if (isFunctionNode(a)) scanArrow(a, true)
    else if (localArrow(a)) scanArrow(arrows.get(a))
    else if ((isArr(a) || isName(a)) && !scalarKind(view, a)) { unknownCall('callback value for ' + what); return true }
    return false
  }
  // A pure callee allocates unless its result is a scalar, and runs the
  // callback callbackArg names.
  const pure = (name, args) => {
    if (runsGetters(name)) return unknownCall('accessor ' + name)
    if (!SCALAR_CALLEES.test(name)) allocates()
    const i = callbackArg(name), list = argList(args)
    if (i != null && list[i] !== undefined) callback(list[i], name)
    if (TYPED_FROM.test(name)) { if (list[0] !== undefined) convertElements(list[0]) }
    else if (!NON_CONVERTING.test(name)) list.forEach((a, j) => { if (j !== i) convert(a) })
  }
  const call = (callee, args, node) => {
    while (isArr(callee) && callee[0] === '(') callee = callee[1]
    if (isName(callee)) {
      const c = ctorOf(callee)
      if (c !== null) {
        allocates()
        if (knownFunc(c)) reach(c)
        else if (!FRESH_CTORS.test(c)) { unknownCall('call ' + callee); if (ctx.core?.emit?.[callee] != null) escape('call ' + callee) }   // a builtin's constructor not listed as fresh
        else if (CONVERTING_CTORS.test(c)) argList(args).forEach(TYPED_CTORS.test(c) ? convertElements : convert)
        else if (c === 'Map') mapEntries(args)
        return
      }
      if (knownFunc(callee)) { reach(callee); return }
      if (localArrow(callee)) { scanArrow(arrows.get(callee)); return }
      // Registered SIMD intrinsics use registers only. Their argument
      // expressions are still walked below, including calls that allocate.
      if (/^(f32x4|f64x2|i32x4|v128)\./.test(callee) && ctx.core?.emit?.[callee] != null) return
      // for…of's source (prepare/handlers.js): an array, a typed array or a
      // string passes through, a Set or a Map is copied into a fresh array;
      // any other iterable runs its own iterator. for…in's key list reads keys.
      if (callee === '__iter_arr') {
        const k = view?.kindOfExpr(argList(args)[0]), t = k == null ? K.ANY : tagOf(k)
        if (t === K.ARRAY || t === K.TYPED || t === K.STRING || t === K.SET || t === K.MAP) { allocates(); return }
        return unknownCall('call __iter_arr')
      }
      if (callee === '__keys_ro' || callee === '__keys_dyn') { allocates(); return }
      if (PURE_CALLEES.test(callee)) return pure(callee, args)
      if (FRESH_CTORS.test(callee)) { allocates(); if (callee === 'Map') mapEntries(args); return }   // constructors lowered to plain calls still read Map entries
      // a builtin writing into its first argument: a store into it
      if (WRITES_FIRST.test(callee)) { allocates(); const list = argList(args); return list.length ? store(list[0], anyHeap(list.slice(1)), true, false, true) : undefined }
      if (READS_POINTER.test(callee)) return
      // any other builtin the runtime provides by this name: what it does with its arguments is not listed here
      if (ctx.core?.emit?.[callee] != null || STATICS.test(callee)) { unknownCall('call ' + callee); return escape('call ' + callee) }
      // A binding holding closures the summary names: they run here.
      const family = node && !params.has(callee) ? view?.calleeOf(node) : null
      if (typeof family === 'number' && ctx.summary?.closureMembers) {
        out.writesOuter = true; out.callsUnknown = true
        // A member is a closure id, or the name of a function held as a value.
        const members = [...ctx.summary.closureMembers(family)]
        if (members.some(id => typeof id !== 'number' && !knownFunc(id))) return unknownCall('call ' + callee)
        const ids = members.filter(id => typeof id === 'number')
        for (const id of ids) out.closures.add(id)
        // one of them runs: a function among them runs on every call only where it is the one
        for (const id of members) if (typeof id !== 'number') { if (members.length === 1) reach(id); else out.callees.add(id) }
        if (ids.length) out.closureCalls.push({ ids, every: guarded === 0 && ids.length === members.length })
        noise++
        return
      }
      return unknownCall('call ' + callee)
    }
    if (isArr(callee) && (callee[0] === '.' || callee[0] === '?.') && isName(callee[2])) {
      const [, recv, method] = callee
      const key = isName(recv) ? `${recv}.${method}` : null
      if (key && PURE_CALLEES.test(key)) return pure(key, args)
      // a builtin writing into its first argument: a store into it
      if (key && WRITES_FIRST.test(key)) { allocates(); const list = argList(args); return list.length ? store(list[0], anyHeap(list.slice(1)), true, false, true) : undefined }
      if (key && STATICS.test(key)) { unknownCall('call ' + key); return escape('call ' + key) }
      // a function called with its receiver spelled out: the function runs, as any value called
      if (method === 'call' || method === 'apply' || method === 'bind') { if (method === 'bind') allocates(); return unknownCall('call ' + method) }
      const resolved = resolveMember(recv, method)
      if (resolved) { reach(resolved.name); return }
      // the class functions of a receiver the index does not resolve (one that may be nullish, or of several classes)
      const fns = memberFunctions(view, recv, method, method, true)
      if (fns) { reaches(fns); return }
      if (accessorFunctions(method, recv, method + ACCESSOR_GET) !== NO_FUNCTIONS) return unknownCall('accessor ' + method)
      // A method spelling is a builtin proof only on a builtin receiver whose
      // own property cannot override it. Emission uses the same summary query.
      const receiverKind = view?.kindOfExpr(recv)
      const receiverTag = receiverKind == null ? K.ANY : tagOf(receiverKind)
      if (receiverTag === K.ANY || receiverTag === K.NONE || receiverTag === K.OBJECT || receiverTag === K.HASH ||
          ctx.summary?.memberMayBeOwnOn(method, valOf(core(receiverKind)))) {
        // The receiver's own closure of that name, a host's method, or the
        // builtin of that name: what that one would store into the receiver.
        unknownCall('method ' + method)
        allocates()
        if (GROW_METHODS.has(method) || WRITE_METHODS.has(method) || method === 'sort')
          store(recv, !SHRINK_METHODS.has(method) && anyHeap(method === 'fill' ? argList(args).slice(0, 1) : argList(args)), true, true)
        return
      }
      const hasClosureArg = argList(args).some(isFunctionNode)
      if (CALLBACK_METHODS.has(method)) {
        allocates()
        const unknown = argList(args).some(a => callback(a, method))
        if (unknown) return
        if (method === 'sort') { if (!argList(args).length) convert(recv); store(recv, false, true, true) }
        return
      }
      // a builtin the census does not list, handed a closure: it may keep it
      if (hasClosureArg) { unknownCall('closure argument to ' + method); return escape('closure argument to ' + method) }
      if (GROW_METHODS.has(method)) {
        // `set` on a typed array copies numbers in place; on a Map it stores a
        // value and may relocate the table.
        if (method === 'set' && typedRecv(recv)) { convert(argList(args)[0]); return store(recv, false, false, true) }
        // one that only removes allocates where the runtime keeps the receiver's earlier state (a durable array's)
        if (SHRINK_METHODS.has(method)) return store(recv, false, true, true)
        allocates()
        return store(recv, anyHeap(argList(args)), true, true)
      }
      if (WRITE_METHODS.has(method)) { argList(args).forEach(convert); return store(recv, method === 'fill' && anyHeap(argList(args).slice(0, 1)), true, true) }
      if (READ_METHODS.has(method)) {
        if (!SCALAR_METHODS.has(method)) allocates()
        argList(args).forEach(convert)
        if (CONVERTING_RECEIVER_METHODS.has(method)) convert(recv)
        return
      }
      // a builtin the census does not list: it may store what it is handed into its receiver
      unknownCall('method ' + method)
      return store(recv, anyHeap(argList(args)), true, true)
    }
    return unknownCall('computed callee')
  }

  const walkExpr = (n) => {
    if (!isArr(n)) return
    const outerAt = at
    at = n
    try { walkNode(n) } finally { at = outerAt }
  }
  const walkNode = (n) => {
    const op = n[0]
    if (op == null || op === 'bool' || op === 'str') return
    if (isFunctionNode(n)) { allocates(); return }   // its own frame; a call to it is counted at the call
    if (isObjectLiteral(n) || op === '[' || op === 'strcat') allocates()
    if (op === '+' && !scalarKind(view, n)) allocates()   // a concatenation
    if (op === 'yield' || op === 'await') escape(op, SITE.ZERO, { suspends: true })   // the frame is suspended: what runs meanwhile allocates too
    if (op === '__tp_call') unknownCall('conversion method')   // an own toString/valueOf closure (emit/to-primitive.js)
    if (runsConversion(view, n)) conversion()
    if (ASSIGN_OPS.has(op) || op === '++' || op === '--') {
      const target = n[1], val = n[2]
      // A logical assignment evaluates its value and stores only when its test passes.
      const lazy = op === '||=' || op === '&&=' || op === '??=', plain = op === '=' || lazy
      if (lazy) guarded++
      // What the store leaves in its target: the value; a concatenation where
      // `+=` adds to what is no number; else a number, or a BigInt made of one.
      const stored = op === '=' || lazy ? mayCarryFreshHeap(view, val) : op === '+=' ? !scalarKind(view, target) || mayCarryFreshHeap(view, val) : mayBeBigint(view, target)
      // An assignment's site asks its value (emit/dispatch.js), unless the call
      // surely made it; one that computes its value yields the value it stored.
      const asked = op === '=' || lazy ? !freshInit(val) && !isFunctionNode(val) : true
      if (isName(target)) {
        // A binding of the module or of an enclosing scope is outer storage:
        // a heap value assigned there escapes, into the cell the binding
        // lives in (older than this frame) or into the module's global. A
        // binding of this scope a nested function writes lives in a cell this
        // frame made: a store into fresh memory.
        if (outerName(target)) {
          outer()
          if (stored) escape('outer binding ' + target, !ctx.scope.userGlobals?.has(target) ? SITE.CELL : reachOn() ? SITE.ROOT : SITE.ZERO, { older: true, asked })
        }
      } else if (isArr(target) && target[0] === '.') {
        // A setter the census cannot name runs code of the module; the store may be a plain one.
        const fns = accessorFunctions(target[2], target[1], target[2] + ACCESSOR_SET)
        if (fns === null) unknownCall('accessor ' + target[2]); else reaches(fns)
        // a slot of a layout the summary knows is written in place; any other property may take storage
        if (scratch && isName(target[1]) && decl.has(target[1])) outer()
        else store(target[1], stored && !(plain && heldBy(target[1], val, n)), !fixedSlot(view, target[1], target[2]), false, false, asked)
      } else if (isArr(target) && target[0] === '[]') {
        // Element store: a plain array may grow past its length; a typed
        // array and a fixed-shape object slot do not.
        const recv = target[1]
        const lit = isArr(target[2]) && target[2][0] == null && typeof target[2][1] === 'string'
        const fns = lit ? accessorFunctions(target[2][1], recv, target[2][1] + ACCESSOR_SET) : NO_FUNCTIONS
        if (fns === null) unknownCall('accessor ' + target[2][1]); else reaches(fns)
        // An integer literal inside the length the receiver holds for good writes a cell
        // the array has (the emitter's raw store, emit-assign.js storeFixedElement).
        store(recv, stored && !(plain && heldBy(recv, val, n)), !typedRecv(recv) && !(lit && fixedSlot(view, recv, target[2][1])) && !withinFixedLen(view, recv, target[2]), !lit, false, asked)
        if (op === '=' && mayBeTyped(view, recv)) convert(val)   // a typed element store converts its value
      } else if (isArr(target) && target[0] === '{}') {
        escape('destructuring assignment')   // targets may be member paths
      } else escape('assignment target')
      for (let i = 2; i < n.length; i++) walkExpr(n[i])
      if (lazy) guarded--
      walkExpr(target)
      return
    }
    // A delete may move the receiver's properties to storage of their own.
    if (op === 'delete') {
      const t = n[1], flat = n.length === 3, member = flat || isArr(t) && (t[0] === '.' || t[0] === '[]')
      const recv = flat ? t : member ? t[1] : t
      if (!member) escape('delete')
      else if (!freshLocal(recv)) escape('delete', readable(recv) ? SITE.RECV : SITE.ZERO, { older: olderName(recv) })
      walkExpr(recv)
      if (flat) walkExpr(n[2])
      else if (member && t[0] === '[]') walkExpr(t[2])
      return
    }
    if (op === '()') {
      call(n[1], n[2], n)
      walkExpr(n[1]); walkExpr(n[2])
      return
    }
    // an optional call is a call when its callee is present: `['?.()', callee, ...args]`
    if (op === '?.()') {
      call(n[1], n.length > 3 ? [',', ...n.slice(2)] : n[2])
      for (let i = 1; i < n.length; i++) walkExpr(n[i])
      return
    }
    if (op === 'new') {
      allocates()
      const inner = n[1]
      const builtin = (name) => { unknownCall('new ' + name); if (ctx.core?.emit?.['new.' + name] != null) escape('new ' + name) }   // a builtin's constructor not listed as fresh
      if (isArr(inner) && inner[0] === '()') {
        if (!(isName(inner[1]) && (FRESH_CTORS.test(inner[1]) || knownFunc(inner[1])))) { if (isName(inner[1])) builtin(inner[1]); else unknownCall('new <expr>') }
        else if (knownFunc(inner[1])) reach(inner[1])
        else if (inner[1] === 'Map') mapEntries(inner[2])
        walkExpr(inner[2])
      } else if (isName(inner)) { if (!(FRESH_CTORS.test(inner) || knownFunc(inner))) builtin(inner); else if (knownFunc(inner)) reach(inner) }
      else unknownCall('new <expr>')
      return
    }
    if (op === '.') { const fns = accessorFunctions(n[2], n[1], n[2] + ACCESSOR_GET); if (fns === null) unknownCall('accessor ' + n[2]); else reaches(fns) }
    if (runsAccessor(view, n)) { out.runsAccessor = true; unknownCall('accessor') }
    // From a branch's first arm on, and past a statement that may return, the
    // rest may not run; a loop's body and step run no times as well as many.
    const loop = op === 'for' || op === 'while'
    const arm = op === 'for' ? 3 : op === 'while' ? 2 : BRANCH_ARM[op] ?? n.length
    let rest = false
    if (loop) loops.push({ node: n, pending: [], noise })
    for (let i = 1; i < n.length; i++) {
      if (i === arm) guarded++
      walkExpr(n[i])
      if (op === ';' && !rest && mayReturn(n[i])) { rest = true; guarded++ }
    }
    if (arm < n.length) guarded--
    if (rest) guarded--
    if (loop) endLoop()
  }
  for (const r of roots) walkExpr(r)
  return out
}

/** Every loop of a body, outermost first, with the nodes its iteration runs.
 *  Nested function bodies are not entered: their loops belong to them. */
function loopsOf(body) {
  const loops = []
  const walk = (n) => {
    if (!isArr(n) || isFunctionNode(n)) return
    const op = n[0]
    if (op === 'for' && n[4] !== undefined) loops.push({ body: n[4], roots: [n[2], n[3], n[4]].filter(x => x != null) })
    else if (op === 'while' && n[2] !== undefined) loops.push({ body: n[2], roots: [n[1], n[2]] })
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(body)
  return loops
}

/** The function's own facts and, per loop, the iteration's. */
function frameEffectsOf(func) {
  const body = func.body
  // the function's own view (keyed by its signature, as the emitter's), not the module's
  const view = ctx.summary?.at(func.sig ?? func.body)
  if (body == null) return { ...UNKNOWN_FRAME, why: 'no body', callees: new Set(), closures: new Set(), sites: new Set(), siteKinds: new Map(), siteGrows: new Set(), siteGrown: new Set(), siteAsked: new Set(), siteNames: new Map(), siteWhys: new Map(), inline: new Set(), loops: [] }
  const params = new Set(), typedParams = new Set()
  for (const p of func.sig?.params ?? []) if (p?.name) { params.add(p.name); if (p.boundaryTyped) typedParams.add(p.name) }
  if (func.rest) params.add(func.rest)
  // a parameter default runs in the frame, before the body
  const out = census(view, frameRoots(func), [body], params, typedParams, true, SCRATCH.has(func.name))
  // A frame that lends a value it made to a record older than itself keeps
  // it, though the census counts no site there: the frame restores nothing.
  if (SCRATCH.has(func.name) && !out.keeps) { out.keeps = true; out.keepsWhy = 'lends what it made to a record' }
  // a loop's scope declares nothing of the function's: its parameters are
  // outer storage there (a block kept in one outlives the iteration)
  out.loops = loopsOf(body).map(({ body: loopBody, roots }) => ({ body: loopBody, own: census(view, roots, [loopBody], NO_NAMES, typedParams) }))
  return out
}

// A frame the census has no body of: it may do anything, at no site the
// emitter could flag (`unsited`: link lowers the flag where the frame is entered).
const UNKNOWN_FRAME = { writesOuter: true, arenaUnsafe: true, keeps: false, flagged: true, unsited: true, allocates: true, callsUnknown: true, runsAccessor: false, keepsWhy: null, siteWhy: null }

/** A closure's own facts: its arrow's body censused through its own view,
 *  its parameters as the function's are (outer storage), its captures as
 *  outer bindings. Unknown when the summary has no arrow for it. */
function closureEffectsOf(id) {
  const arrow = ctx.summary?.closureArrow?.(id)
  if (!isArr(arrow) || arrow[0] !== '=>') return { ...UNKNOWN_FRAME, why: 'closure ' + id + ' unknown', callees: new Set(), closures: new Set(), sites: new Set(), siteKinds: new Map(), siteGrows: new Set(), siteGrown: new Set(), siteAsked: new Set(), siteNames: new Map(), siteWhys: new Map(), inline: new Set() }
  const body = arrow[2], params = new Set()
  let defaults = null
  for (const p of extractParams(arrow[1])) {
    if (isName(p)) params.add(p)
    else if (isArr(p) && (p[0] === '...' || p[0] === '=') && isName(p[1])) { params.add(p[1]); if (p[0] === '=') (defaults ??= {})[p[1]] = p[2] }
    else for (const nm of patternNames(p)) params.add(nm)
  }
  return census(ctx.summary.at(body), frameRoots({ body, defaults }), [body], params, NO_NAMES, true)
}

function patternNames(p, out = []) {
  if (isName(p)) { out.push(p); return out }
  if (!isArr(p)) return out
  const op = p[0]
  if (op === '[]' || op === '{}' || op === ',') { for (let i = 1; i < p.length; i++) patternNames(p[i], out); return out }
  if (op === ':') { patternNames(p[2], out); return out }
  if (op === '=') { patternNames(p[1], out); return out }
  if (op === '...') { patternNames(p[1], out); return out }
  return out
}

/** Every function literal below `n`, nested ones included. */
function arrowsIn(n, found) {
  if (!isArr(n)) return found
  if (n[0] === '=>') found.push(n)
  for (let i = 1; i < n.length; i++) arrowsIn(n[i], found)
  return found
}

/**
 * Transitive facts over the direct call graph, for every function in
 * `funcs`. Returns Map<name, facts>, each `{ writesOuter, arenaUnsafe, keeps,
 * flagged, unsited, callsUnknown, callees, why, loops }`: `callees` the direct
 * call edges, `allocates` whether the function or a callee
 * allocates, `flagged` whether code the frame runs may lower the escape flag,
 * `unsited` whether an escape of it has no node the emitter could flag,
 * `loops` the body nodes of the loops whose iteration lets no allocation
 * escape and that allocate, themselves or through a callee, `closures` the
 * closures its own resolved calls run. With `roots` (the module's own code,
 * whose closures are no function's) every closure of the program is censused,
 * without them those resolved calls reach:
 * the map's `closureCalls` names, per closure, the closures its own calls
 * run, which link reads as the targets of the indirect calls they compile to;
 * `closureSites` its sites, none for a function literal a builtin calls in
 * place (the census of the scope around it walked it); `closureUnsited`
 * the closures with an escape at no node.
 */
export function transitiveFrameEffects(funcs, roots = null) {
  const own = new Map()
  for (const f of funcs) if (!f.raw && f.body != null) own.set(f.name, frameEffectsOf(f))
  const closureOwn = new Map(), closureKey = (id) => '\0closure' + id
  const pending = []
  const want = (id) => { if (id !== undefined && !closureOwn.has(id)) { closureOwn.set(id, null); pending.push(id) } }
  const need = (o) => { for (const id of o.closures ?? []) want(id) }
  if (roots !== null) {
    const arrows = []
    for (const f of funcs) if (!f.raw && f.body != null) for (const r of frameRoots(f)) arrowsIn(r, arrows)
    for (const r of roots) arrowsIn(r, arrows)
    for (const a of arrows) want(ctx.summary?.closureIdOfBody?.(a[2]))
  }
  for (const o of own.values()) { need(o); for (const l of o.loops ?? []) need(l.own) }
  while (pending.length) { const id = pending.pop(), o = closureEffectsOf(id); closureOwn.set(id, o); need(o) }
  const nodes = new Map(own)
  for (const [id, o] of closureOwn) nodes.set(closureKey(id), o)
  const facts = new Map()
  for (const [name, o] of nodes) facts.set(name, { writesOuter: o.writesOuter, arenaUnsafe: o.arenaUnsafe, keeps: o.keeps, flagged: o.flagged, unsited: o.unsited, callsUnknown: o.callsUnknown, runsAccessor: o.runsAccessor, allocates: o.allocates,
    why: o.why, keepsWhy: o.keepsWhy, siteWhy: o.siteWhy, callees: o.callees, loops: new Set(), freshObjects: o.freshObjects ?? null })
  const spell = (c) => c.startsWith('\0') ? c.slice(1) : c
  // The arena facts of a callee (a function by name, a closure by its key),
  // `every`: reached on every call of the caller. A host's function is
  // flagged where it is called (link: it may keep what it is handed); any
  // other callee the census has no body of may do anything.
  const hosts = (c) => { const e = ctx.funcs.map?.get(c); return e != null && e.body == null && !e.raw && !funcs.includes(e) }
  const joinArena = (f, c, g, every) => {
    let changed = false
    if (!g && hosts(c)) {
      if (!f.flagged) { f.flagged = true; f.siteWhy ??= 'calls ' + spell(c) + ', the host\'s'; changed = true }
      return changed
    }
    if (!g) {
      if (!f.arenaUnsafe) { f.arenaUnsafe = true; f.why = 'calls ' + spell(c) + ' (unknown)'; changed = true }
      if (!f.unsited) { f.unsited = true; changed = true }
      if (!f.allocates) { f.allocates = true; changed = true }
      if (!f.flagged) { f.flagged = true; f.siteWhy ??= 'calls ' + spell(c) + ' (unknown)'; changed = true }
      return changed
    }
    if (g.arenaUnsafe && every && !f.arenaUnsafe) { f.arenaUnsafe = true; f.why = 'calls ' + spell(c) + ': ' + g.why; changed = true }
    if (g.allocates && !f.allocates) { f.allocates = true; changed = true }
    // What the callee runs lowers the flag in this frame: its restore reads it too.
    if ((g.flagged || g.keeps || g.arenaUnsafe) && !f.flagged) { f.flagged = true; f.siteWhy ??= 'calls ' + spell(c) + ': ' + (g.siteWhy ?? g.keepsWhy ?? g.why); changed = true }
    return changed
  }
  for (let changed = true; changed;) {
    changed = false
    for (const [name, o] of nodes) {
      const f = facts.get(name)
      for (const c of o.callees) {
        const g = facts.get(c)
        const w = g ? g.writesOuter : true, k = g ? g.callsUnknown : true
        if (w && !f.writesOuter) { f.writesOuter = true; changed = true }
        if (joinArena(f, c, g, o.unguarded.has(c))) changed = true
        if (k && !f.callsUnknown) { f.callsUnknown = true; changed = true }
      }
      // A resolved call runs one of its closures: it escapes on every call where each of them does.
      for (const { ids, every } of o.closureCalls ?? []) {
        const all = every && ids.every(id => facts.get(closureKey(id)).arenaUnsafe)
        for (const id of ids) if (joinArena(f, closureKey(id), facts.get(closureKey(id)), all)) changed = true
      }
    }
  }
  // A function literal a builtin calls in place: its sites are those of the scope around it.
  const inline = new Set()
  for (const o of nodes.values()) { for (const a of o.inline ?? []) inline.add(a); for (const l of o.loops ?? []) for (const a of l.own.inline ?? []) inline.add(a) }
  const called = (id) => inline.has(ctx.summary?.closureArrow?.(id))
  for (const key of closureOwn.keys()) facts.delete(closureKey(key))
  for (const [name, o] of own) { const f = facts.get(name); f.closures = o.closures; f.sites = o.sites; f.siteKinds = o.siteKinds; f.siteGrows = o.siteGrows; f.siteGrown = o.siteGrown; f.siteAsked = o.siteAsked; f.siteNames = o.siteNames; f.siteWhys = o.siteWhys }
  facts.closureCalls = new Map([...closureOwn].map(([id, o]) => [id, o.closures]))
  facts.closureSites = new Map([...closureOwn].map(([id, o]) => [id, called(id) ? new Set() : o.sites]))
  // what a closure's sites write into, as a function's: `{ siteKinds, siteGrows, siteGrown, siteAsked, siteNames }`
  facts.closureSiteFacts = new Map([...closureOwn].filter(([id]) => !called(id)).map(([id, o]) => [id, o]))
  facts.closureUnsited = new Set([...closureOwn].filter(([id, o]) => o.unsited && !called(id)).map(([id]) => id))
  for (const [name, o] of own) {
    const f = facts.get(name)
    const clean = (c) => { const g = facts.get(c); return g != null && !g.arenaUnsafe && !g.keeps && !g.flagged }
    for (const { body, own: l } of o.loops)
      if (!l.arenaUnsafe && !l.closures?.size && (l.allocates || [...l.callees].some(c => facts.get(c)?.allocates)) && [...l.callees].every(clean)) f.loops.add(body)
  }
  return facts
}

/** Test the starting function and its reachable callees without materializing
 * a transitive name set for every function in the program. */
export function frameReaches(frames, name, matches) {
  const seen = new Set(), pending = [name]
  while (pending.length) {
    const next = pending.pop()
    if (seen.has(next)) continue
    seen.add(next)
    if (matches(next)) return true
    const callees = frames.get(next)?.callees
    if (callees) for (const callee of callees) if (!seen.has(callee)) pending.push(callee)
  }
  return false
}
