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
 *   arenaUnsafe  — a value allocated during the call may outlive the frame:
 *                  a heap-capable value stored into outer storage, a growth
 *                  of an outer container (its storage can extend or relocate
 *                  into fresh memory), a captured or module binding assigned
 *                  a heap-capable value, or a call whose callee is unknown or
 *                  a host import. The arena rewind (optimize/arena-rewind.js)
 *                  restores the heap pointer at return; a function that lets
 *                  an allocation escape its frame must not rewind, or the
 *                  escaped pointer dangles into memory the next allocation
 *                  overwrites.
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
 * Both function facts are transitive over direct calls to same-module
 * functions (`transitiveFrameEffects`, an iterative fixpoint over the call
 * graph); a call whose target is not a known function is unknown and counts
 * as both, and as `callsUnknown`. The transitive facts also carry `callees`,
 * every known function a call reaches, so a consumer can ask what the reached
 * code mentions (the declared-keys pass asks whether a call between a literal
 * and its store can reach the literal's name). A loop is clean when its own
 * census is and every callee it reaches is arena-safe. Everything here is a
 * conservative census: an unrecognized shape counts as an effect, never as
 * its absence.
 *
 * @module compile/analyze/frame-effects
 */
import { ASSIGN_OPS, ACCESSOR_GET, ACCESSOR_SET, isFunctionNode } from '../../ast.js'
import { K, tagOf, hasTag } from '../../summary/kind.js'
import { ctx } from '../../ctx.js'

const isArr = Array.isArray
const isName = (x) => typeof x === 'string'

// Callees that read their arguments and receivers only. Mirrors the summary's
// PURE_BUILTINS (src/summary/index.js) plus the numeric/string globals whose
// results are fresh values or scalars. `math.` is the prepared spelling of `Math.`.
const PURE_CALLEES = /^(Object\.(keys|values|entries|isFrozen|getOwnPropertyNames|getPrototypeOf|hasOwn|is|fromEntries)|JSON\.(stringify|parse)|Array\.(isArray|of|from)|console\.\w+|[Mm]ath\.\w+|Number(\.\w+)?|String(\.\w+)?|Boolean|BigInt(\.\w+)?|Symbol(\.\w+)?|Date\.now|performance\.now|isNaN|isFinite|parseInt|parseFloat|structuredClone|Date\.UTC|Date\.parse)$/
// Callees whose result is a scalar: no allocation.
const SCALAR_CALLEES = /^([Mm]ath\.\w+|Number(\.\w+)?|Boolean|isNaN|isFinite|parseInt|parseFloat|Date\.now|performance\.now)$/

// Constructors whose instances are fresh storage with no user code run.
const FRESH_CTORS = /^(Array|Object|Map|Set|WeakMap|WeakSet|Date|RegExp|Error|TypeError|RangeError|SyntaxError|ReferenceError|String|Number|Boolean|ArrayBuffer|DataView|(Int|Uint|Float|BigInt|BigUint)(8|16|32|64)(Clamped)?Array|Float16Array)$/

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

// Receiver methods that write the receiver in place without changing its
// storage: a write into outer storage, never a growth.
const WRITE_METHODS = new Set(['fill', 'copyWithin', 'reverse',
  'setInt8', 'setUint8', 'setInt16', 'setUint16', 'setInt32', 'setUint32', 'setFloat32', 'setFloat64', 'setBigInt64', 'setBigUint64',
  'setTime', 'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds',
  'setUTCFullYear', 'setUTCMonth', 'setUTCDate', 'setUTCHours', 'setUTCMinutes', 'setUTCSeconds', 'setUTCMilliseconds'])

// Receiver methods that may grow or relocate the receiver's storage, or store
// a heap value into it.
const GROW_METHODS = new Set(['push', 'unshift', 'splice', 'pop', 'shift', 'add', 'delete', 'clear', 'set', 'setPrototypeOf'])

/** The constructor a prepared `new X(...)` call names (`new.X`), or null. */
const ctorOf = (callee) => isName(callee) && callee.startsWith('new.') ? callee.slice(4) : null

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
  if (e.length === 1) return false        // undefined
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
 * run synchronously and for local arrows called from this scope.
 */
function census(view, roots, declRoots, params, typedParams = NO_NAMES) {
  // A parameter the export boundary types (narrow/param-abi.js `boundaryTyped`)
  // is a typed array the summary, built before the narrowing, still holds as
  // any value: element stores into it are numbers into fixed storage.
  const typedRecv = (recv) => typedReceiver(view, recv) || (isName(recv) && typedParams.has(recv))
  const out = { writesOuter: false, arenaUnsafe: false, allocates: false, callsUnknown: false, why: null, callees: new Set() }

  // 1. Fresh locals: declared here, every write a fresh initializer, no write
  //    from any nested function. Arrows bound to a const are scanned inline
  //    when called.
  const decl = new Map()      // name → 'fresh' | 'other'
  const arrows = new Map()    // name → arrow node bound by a const, never reassigned
  const scanned = new Set()   // arrows already walked as part of this scope (a recursive arrow calls itself)
  const writtenNested = new Set()
  // `declared`: a let/const/var of this scope. A write to a name the scope does
  // not declare is a write to an enclosing binding and must not enter `decl`,
  // or the effect walk would take it for a local.
  const note = (name, init, nested, declared) => {
    if (!isName(name)) return
    if (nested) { writtenNested.add(name); return }
    const cur = decl.get(name)
    if (!declared && cur == null) return
    if (init === undefined) { if (cur == null) decl.set(name, 'fresh'); return }   // bare `let x`
    const fresh = freshInit(init)
    decl.set(name, cur === 'other' || !fresh ? 'other' : 'fresh')
    if (isArr(init) && init[0] === '=>') { if (arrows.has(name) || cur != null) arrows.delete(name); else arrows.set(name, init) } else arrows.delete(name)
  }
  const scanDecls = (n, nested) => {
    if (!isArr(n)) return
    const op = n[0]
    if (op === 'let' || op === 'const' || op === 'var') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (isName(d)) note(d, undefined, nested, true)
        else if (isArr(d) && d[0] === '=' && isName(d[1])) note(d[1], d[2], nested, true)
        else if (isArr(d) && d[0] === '=') for (const nm of patternNames(d[1])) note(nm, null, nested, true)
      }
      return
    }
    if (ASSIGN_OPS.has(op)) {
      if (isName(n[1])) note(n[1], op === '=' ? n[2] : null, nested, false)
      else if (isArr(n[1]) && (n[1][0] === '[]' || n[1][0] === '{}')) for (const nm of patternNames(n[1])) note(nm, null, nested, false)
    }
    if (op === '++' || op === '--') { if (isName(n[1])) note(n[1], null, nested, false) }
    if (op === 'for' && isArr(n[1]) && (n[1][0] === 'of' || n[1][0] === 'in')) {
      const head = n[1][1]
      if (isArr(head) && (head[0] === 'const' || head[0] === 'let' || head[0] === 'var')) for (let i = 1; i < head.length; i++) { if (isName(head[i])) note(head[i], null, nested, true); else for (const nm of patternNames(head[i])) note(nm, null, nested, true) }
      else if (isName(head)) note(head, null, nested, false)
    }
    const inner = isFunctionNode(n)
    for (let i = 1; i < n.length; i++) scanDecls(n[i], nested || inner)
  }
  for (const r of declRoots) scanDecls(r, false)
  // A write from a nested function to a name the scope does not declare is a
  // write to a shared cell of an enclosing scope: outer, like the name itself.
  const freshLocal = (name) => isName(name) && decl.get(name) === 'fresh' && !params.has(name) && !writtenNested.has(name)

  // 2. Effects.
  const outer = () => { out.writesOuter = true }
  const unsafe = (why) => { out.writesOuter = true; if (!out.arenaUnsafe) { out.arenaUnsafe = true; out.why = why } }
  const unknownCall = (why) => { out.callsUnknown = true; unsafe(why) }
  const allocates = () => { out.allocates = true }
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
  const reaches = (fns) => { for (const fn of fns) out.callees.add(fn) }

  // A store into `recv`: fresh-local receivers are fresh memory; a nested
  // path below a fresh local (`o.a.b = v`) reaches storage the local's own
  // stores placed there — possibly outer values it aliases — so only the
  // direct receiver counts.
  const store = (recv, val, grows) => {
    if (freshLocal(recv)) return
    if (grows) return unsafe('grows ' + (isName(recv) ? recv : '<expr>'))
    outer()
    if (typedRecv(recv)) return
    if (mayCarryFreshHeap(view, val)) unsafe('heap value into ' + (isName(recv) ? recv : '<expr>'))
  }
  const scanArrow = (arrow) => { if (!scanned.has(arrow)) { scanned.add(arrow); walkExpr(arrow[arrow.length - 1]) } }
  const call = (callee, args) => {
    if (isName(callee)) {
      const c = ctorOf(callee)
      if (c !== null) { allocates(); if (knownFunc(c)) out.callees.add(c); else if (!FRESH_CTORS.test(c)) unknownCall('call ' + callee); return }
      if (knownFunc(callee)) { out.callees.add(callee); return }
      if (arrows.has(callee) && !writtenNested.has(callee) && !params.has(callee)) { scanArrow(arrows.get(callee)); return }
      if (PURE_CALLEES.test(callee)) { if (!SCALAR_CALLEES.test(callee)) allocates(); return }
      if (FRESH_CTORS.test(callee)) { allocates(); return }   // a constructor called plainly (`throw TypeError(m)`): fresh storage, no user code
      return unknownCall('call ' + callee)
    }
    if (isArr(callee) && callee[0] === '.' && isName(callee[2])) {
      const [, recv, method] = callee
      const key = isName(recv) ? `${recv}.${method}` : null
      if (key && PURE_CALLEES.test(key)) { if (!SCALAR_CALLEES.test(key)) allocates(); return }
      if (key && /^(Object|Reflect|Atomics|Array\.prototype|Function|Promise)\./.test(key) || method === 'call' || method === 'apply' || method === 'bind') return unknownCall('call ' + (key ?? method))
      const resolved = resolveMember(recv, method)
      if (resolved) { out.callees.add(resolved.name); return }
      // the class functions of a receiver the index does not resolve (one that may be nullish, or of several classes)
      const fns = memberFunctions(view, recv, method, method, true)
      if (fns) { reaches(fns); return }
      if (accessorFunctions(method, recv, method + ACCESSOR_GET) !== NO_FUNCTIONS) return unknownCall('accessor ' + method)
      const hasClosureArg = argList(args).some(isFunctionNode)
      if (CALLBACK_METHODS.has(method)) {
        allocates()
        for (const a of argList(args)) if (isFunctionNode(a)) scanArrow(a)
        else if (isName(a) && arrows.has(a)) scanArrow(arrows.get(a))
        else if (isArr(a) || isName(a)) { if (!scalarKind(view, a)) return unknownCall('callback value for ' + method) }   // a closure value we cannot see
        if (method === 'sort') store(recv, null, false)
        return
      }
      if (hasClosureArg) return unknownCall('closure argument to ' + method)
      if (GROW_METHODS.has(method)) {
        // `set` on a typed array copies numbers in place; on a Map it stores a
        // value and may relocate the table.
        if (method === 'set' && typedRecv(recv)) return store(recv, null, false)
        if (method === 'delete' || method === 'clear' || method === 'pop' || method === 'shift') { if (!freshLocal(recv)) outer(); return }
        allocates()
        return store(recv, null, true)
      }
      if (WRITE_METHODS.has(method)) return store(recv, method === 'fill' ? argList(args)[0] : null, false)
      if (READ_METHODS.has(method)) { if (!SCALAR_METHODS.has(method)) allocates(); return }
      return unknownCall('method ' + method)
    }
    return unknownCall('computed callee')
  }

  const walkExpr = (n) => {
    if (!isArr(n)) return
    const op = n[0]
    if (op == null || op === 'bool' || op === 'str') return
    if (isFunctionNode(n)) { allocates(); return }   // its own frame; a call to it is counted at the call
    if (isObjectLiteral(n) || op === '[' || op === '`') allocates()
    if (op === '+' && !scalarKind(view, n)) allocates()   // a concatenation
    if (op === 'yield' || op === 'await') unsafe(op)   // the frame is suspended: what runs meanwhile allocates too
    if (ASSIGN_OPS.has(op) || op === '++' || op === '--') {
      const target = n[1], val = n[2]
      if (isName(target)) {
        // A binding the scope does not declare (a module or enclosing-scope
        // binding, a parameter) or one a nested function writes: outer storage.
        // A heap value assigned there escapes; `+=` on a string binding too.
        const outerName = !decl.has(target) && !params.has(target)
        if (outerName) outer()
        if (outerName || writtenNested.has(target)) {
          const heap = op === '=' || op === '||=' || op === '&&=' || op === '??=' ? mayCarryFreshHeap(view, val)
            : op === '+=' ? !scalarKind(view, target) : false
          if (heap) unsafe((outerName ? 'outer binding ' : 'shared cell ') + target)
        }
      } else if (isArr(target) && target[0] === '.') {
        const fns = accessorFunctions(target[2], target[1], target[2] + ACCESSOR_SET)
        if (fns === null) unsafe('accessor ' + target[2])
        else { reaches(fns); store(target[1], val, false) }
      } else if (isArr(target) && target[0] === '[]') {
        // Element store: a plain array may grow past its length; a typed
        // array and a fixed-shape object slot do not.
        const recv = target[1]
        const lit = isArr(target[2]) && target[2][0] == null && typeof target[2][1] === 'string'
        const fns = lit ? accessorFunctions(target[2][1], recv, target[2][1] + ACCESSOR_SET) : NO_FUNCTIONS
        if (fns === null) unsafe('accessor ' + target[2][1])
        else { reaches(fns); store(recv, val, !typedRecv(recv) && !(lit && view?.objectSidOfExpr?.(recv) != null)) }
      } else if (isArr(target) && target[0] === '{}') {
        unsafe('destructuring assignment')   // targets may be member paths
      } else unsafe('assignment target')
      for (let i = 1; i < n.length; i++) walkExpr(n[i])
      return
    }
    if (op === 'delete') { const t = n[1]; if (isArr(t) && (t[0] === '.' || t[0] === '[]')) { if (!freshLocal(t[1])) unsafe('delete') } else unsafe('delete'); return }
    if (op === '()') {
      call(n[1], n[2])
      walkExpr(n[1]); walkExpr(n[2])
      return
    }
    if (op === 'new') {
      allocates()
      const inner = n[1]
      if (isArr(inner) && inner[0] === '()') {
        if (!(isName(inner[1]) && (FRESH_CTORS.test(inner[1]) || knownFunc(inner[1])))) unsafe('new ' + (isName(inner[1]) ? inner[1] : '<expr>'))
        else if (knownFunc(inner[1])) out.callees.add(inner[1])
        walkExpr(inner[2])
      } else if (isName(inner)) { if (!(FRESH_CTORS.test(inner) || knownFunc(inner))) unknownCall('new ' + inner); else if (knownFunc(inner)) out.callees.add(inner) }
      else unsafe('new <expr>')
      return
    }
    if (op === '.') { const fns = accessorFunctions(n[2], n[1], n[2] + ACCESSOR_GET); if (fns === null) unsafe('accessor ' + n[2]); else reaches(fns) }
    if (op === 'for' && isArr(n[1]) && (n[1][0] === 'of' || n[1][0] === 'in')) allocates()   // an iterator record, key strings
    for (let i = 1; i < n.length; i++) walkExpr(n[i])
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
    if (op === 'for' && n[4] !== undefined && !(isArr(n[1]) && (n[1][0] === 'of' || n[1][0] === 'in'))) loops.push({ body: n[4], roots: [n[2], n[3], n[4]].filter(x => x != null) })
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
  if (body == null) return { writesOuter: true, arenaUnsafe: true, allocates: true, callsUnknown: true, why: 'no body', callees: new Set(), loops: [] }
  const params = new Set(), typedParams = new Set()
  for (const p of func.sig?.params ?? []) if (p?.name) { params.add(p.name); if (p.boundaryTyped) typedParams.add(p.name) }
  if (func.rest) params.add(func.rest)
  // a parameter default runs in the frame, before the body
  const out = census(view, func.defaults ? [...Object.values(func.defaults), body] : [body], [body], params, typedParams)
  // a loop's scope declares nothing of the function's: its parameters are
  // outer storage there (a block kept in one outlives the iteration)
  out.loops = loopsOf(body).map(({ body: loopBody, roots }) => ({ body: loopBody, own: census(view, roots, [loopBody], NO_NAMES, typedParams) }))
  return out
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

/**
 * Transitive facts over the direct call graph, for every function in
 * `funcs`. A callee outside the map is unknown. Returns Map<name, facts>,
 * each `{ writesOuter, arenaUnsafe, callsUnknown, callees, why, loops }`:
 * `callees` every known function a call reaches, `allocates` whether the
 * function or a callee allocates, `loops` the body nodes of the loops whose
 * iteration lets no allocation escape and that allocate, themselves or
 * through a callee.
 */
export function transitiveFrameEffects(funcs) {
  const own = new Map()
  for (const f of funcs) if (!f.raw && f.body != null) own.set(f.name, frameEffectsOf(f))
  const facts = new Map()
  for (const [name, o] of own) facts.set(name, { writesOuter: o.writesOuter, arenaUnsafe: o.arenaUnsafe, callsUnknown: o.callsUnknown, allocates: o.allocates, why: o.why, callees: new Set(o.callees), loops: new Set() })
  for (let changed = true; changed;) {
    changed = false
    for (const [name, o] of own) {
      const f = facts.get(name)
      for (const c of o.callees) {
        const g = facts.get(c)
        const w = g ? g.writesOuter : true, u = g ? g.arenaUnsafe : true, k = g ? g.callsUnknown : true
        if (w && !f.writesOuter) { f.writesOuter = true; changed = true }
        if (u && !f.arenaUnsafe) { f.arenaUnsafe = true; f.why = 'calls ' + c + (g ? ': ' + g.why : ' (unknown)'); changed = true }
        if (k && !f.callsUnknown) { f.callsUnknown = true; changed = true }
        if (g?.allocates && !f.allocates) { f.allocates = true; changed = true }
        if (g) for (const cc of g.callees) if (!f.callees.has(cc)) { f.callees.add(cc); changed = true }
      }
    }
  }
  for (const [name, o] of own) {
    const f = facts.get(name)
    for (const { body, own: l } of o.loops)
      if (!l.arenaUnsafe && (l.allocates || [...l.callees].some(c => facts.get(c)?.allocates)) && [...l.callees].every(c => facts.get(c)?.arenaUnsafe === false)) f.loops.add(body)
  }
  return facts
}
