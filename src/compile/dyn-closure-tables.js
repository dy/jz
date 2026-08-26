/**
 * Same-body indirect devirt for closure tables built IMPERATIVELY.
 *
 * devirtConstFnArrayCalls (optimize/index.js) devirtualizes `constOps[idx](args)`
 * when `constOps` is a module-const ARRAY LITERAL of capture-free arrows — the
 * candidate set is known the moment the literal emits (module/array.js tags
 * `.fnElements`). subscript's operator/token dispatch table (the jessie bench's
 * `lookup` array) doesn't qualify: it's built imperatively (`lookup[c] = …`
 * inside `register`, once per operator registration, at module-init time) and
 * every element is a CLOSURE WITH CAPTURES, not a capture-free literal.
 *
 * But every value ever written into `lookup` traces back to ONE lexical arrow.
 * subscript's shape: `dispatch(ops, tail, fn = (a, …) => {…}) => (fn.ops = ops,
 * fn.tail = tail, fn)`. `fn`'s default is a single `=>` node — closure.make sees
 * it once, at `dispatch`'s own emit time, and gives it one funcIdx forever.
 * Every call to `dispatch` (both ternary arms in `register`) omits `fn`, so the
 * default always fires; `dispatch` returns `fn` unmodified. Different calls get
 * different `ops`/`tail` (different captured ENV), but the closure BODY
 * (funcIdx) is the same wasm function every time. Proven program-wide — every
 * write into the table resolves to the same funcIdx, and the table never
 * escapes or aliases — the read-then-call at the use site (`table[idx](args)`,
 * or subscript's `(fn = table[idx]) && fn(args)` guarded idiom) can skip
 * call_indirect for a direct call, guarded by a RUNTIME funcIdx check whose
 * false arm is the untouched original call_indirect — semantics are unchanged
 * if the proof is ever wrong, the slot is empty, or the table diverges through
 * an alias devirtConstFnArrayCalls's own guard-rewrite already defends against.
 *
 * This module gathers the facts (program-wide, fail-closed) and feeds the SAME
 * `ctx.scope.constFnArrays` map devirtConstFnArrayCalls already reads — a
 * monomorphic dynamic table is indistinguishable, at rewrite time, from a
 * monomorphic const array. No changes to the rewrite itself.
 *
 * Three phases, wired from compile/index.js:
 *   1. scanDynClosureTableCandidates (pre-emit, source AST) — which module
 *      globals are structurally safe candidates (never alias/escape).
 *   2. recordDynFnTableWrite / recordParamClosureDefault /
 *      recordDirectReturnClosure — called from emit-assign.js and
 *      compile/index.js as functions emit, accumulating write-family + closure-
 *      factory facts.
 *   3. resolveDynFnTables (post-emit, once every function + module init has
 *      emitted) — resolves each candidate's write family; a table whose every
 *      write agrees on one funcIdx populates ctx.scope.constFnArrays.
 *
 * @module compile/dyn-closure-tables
 */
import { ctx } from '../ctx.js'
import { isReassigned } from '../ast.js'
import {
  BINDING_USE_DECLS, BINDING_USE_INIT, BINDING_USE_USES,
  BINDING_USE_KIND, BINDING_USE_COMPOUND, BINDING_USE_COMPUTED, scanBindingUses, USE,
} from './analyze-scans.js'
import { closureBodyReturnKind } from './flow-types.js'
import { VAL } from '../reps.js'

// A candidate table may safely appear as: a `V[idx]` READ (any key — call
// sites read-then-call, `.length`, comparisons, whatever) or a PLAIN
// (non-compound) `V[idx] = RHS` WRITE with a COMPUTED index. Anything else —
// aliasing (`let b = V`), a call argument, a return, a `.`-property write, a
// compound/delete element write, mention inside a nested closure, a bare
// comparison — disqualifies. Default-deny, mirrors scanNeverGrown/
// scanFlatObjects (analyze-scans.js): any use kind not explicitly allowed here
// poisons the candidate.
const safeTableUse = (u) =>
  u[BINDING_USE_KIND] === USE.MEMBER_R ||
  (u[BINDING_USE_KIND] === USE.MEMBER_W && !u[BINDING_USE_COMPOUND] && u[BINDING_USE_COMPUTED])

const isEmptyArrayLit = (rhs) =>
  Array.isArray(rhs) && ((rhs[0] === '[' && rhs.length === 1) || (rhs[0] === '[]' && rhs.length <= 2))

/** Program-wide structural safety pre-scan (source AST, pre-emit). A candidate
 *  is a GLOBAL `let`/`const` declared exactly once, bound to a fresh empty
 *  array, whose every occurrence — module top level, every function body,
 *  every function's param-default expressions — is one of the safe shapes
 *  above. Returns `Set<name>`. Called once, early (before any function
 *  emits), from compile/index.js; the result is consulted (read-only) by
 *  emit-assign.js's write recorder and emit.js's guarded-dispatch call-site
 *  tagger. */
export function scanDynClosureTableCandidates(ast) {
  // Every top-level AST root: the entry module's own `ast`, plus one root per
  // bundled dependency module — `import`-ed files' top-level statements live
  // in ctx.module.moduleInits, NOT `ast` (see plan/scope.js), so subscript's
  // `export let … lookup = [] …` (declared in its own parse.js) is invisible
  // to a scan of `ast` alone.
  const topRoots = [ast, ...(ctx.module.moduleInits || [])]

  // Pass 1: declarations only happen at module scope — find every
  // `let`/`const V = []` global across every top-level root.
  const candidates = new Set()
  for (const root of topRoots) {
    for (const [name, s] of scanBindingUses(root))
      if (s[BINDING_USE_DECLS] === 1 && ctx.scope.globals?.has(name) && isEmptyArrayLit(s[BINDING_USE_INIT])) candidates.add(name)
  }
  if (!candidates.size) return candidates

  // Pass 2: every USE of a candidate, anywhere in the program, must be safe.
  // `trackNames` makes scanBindingUses report on these globals even in bodies
  // that never declare them (the normal case — a global's uses are scattered
  // across every function that touches it, not just its declaring scope).
  const bodies = [...topRoots]
  for (const func of ctx.funcs.list) {
    if (func.body && !func.raw) bodies.push(func.body)
    if (func.defaults) for (const dv of Object.values(func.defaults)) bodies.push(dv)
  }
  for (const body of bodies) {
    const uses = scanBindingUses(body, candidates)
    for (const name of candidates) {
      if (!candidates.has(name)) continue
      const s = uses.get(name)
      if (s && !s[BINDING_USE_USES].every(safeTableUse)) candidates.delete(name)
    }
  }
  return candidates
}

const isArrowArrayLit = (rhs) =>
  Array.isArray(rhs) && rhs[0] === '[' && rhs.length > 1 && rhs.slice(1).every(e => Array.isArray(e) && e[0] === '=>')

// Strict per-name escape walk for the closure-TABLE call-site PARAM lattice
// (below). Deliberately NOT scanBindingUses/safeTableUse: those classify
// `V[idx]` uniformly as USE.MEMBER_R whether or not it's a call's own callee,
// which is exactly right for devirt's funcIdx-IDENTITY proof (any read still
// dispatches through the same runtime-checked body) but WRONG for a PARAM-KIND
// proof — `let p = V[1]` is a MEMBER_R that reaches the identical compiled
// body through an untracked call path (`p(...)`), and a body trusted numeric
// from V's own call sites alone would skip that path's coercion. (This is the
// dispatch-site lattice that was built and reverted once already — see
// test/closures.js's alias/arity pin and the isGlobal decl comment in
// emit.js.) Safe here means STRUCTURALLY narrower than safeTableUse: the ONLY
// tolerated occurrence of `name` is as the receiver of `name[idx]` sitting in
// the callee slot of an IMMEDIATELY enclosing call — everything else (a bare
// read, `.length`, a member write, an export, a reassignment, a nested
// closure mentioning it) disqualifies. Runs on the raw AST/body — same timing
// scanDynClosureTableCandidates uses (post-plan, pre-emit) — so it sees
// exactly the shapes emit will see.
function everyUseIsIndexedCall(node, name) {
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (op === 'let' || op === 'const' || op === 'var') {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (typeof d === 'string') continue                          // uninitialized decl
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
        if (!everyUseIsIndexedCall(d[2], name)) return false        // d[1] is a BINDING, not a use
      } else if (!everyUseIsIndexedCall(d, name)) return false      // destructuring pattern — generic
    }
    return true
  }
  if (op === '()') {
    const callee = node[1]
    if (Array.isArray(callee) && callee[0] === '[]' && callee.length === 3 && callee[1] === name) {
      if (!everyUseIsIndexedCall(callee[2], name)) return false     // index expression
      const a = node[2]
      if (a === name) return false
      if (!everyUseIsIndexedCall(a, name)) return false             // call args
      return true
    }
  }
  for (let i = 1; i < node.length; i++) {
    const c = node[i]
    if (c === name) return false
    if (!everyUseIsIndexedCall(c, name)) return false
  }
  return true
}

// closureBodyReturnKind's capturedKinds seed for a capture-free element — a
// shared empty Map is safe to reuse across calls (copy-on-write: it's only
// ever read, or cloned before a guard-derived fact is added — see its own
// doc in flow-types.js).
const NO_CAPTURES = new Map()

/** Program-wide safety scan for the closure-TABLE call-site PARAM lattice: a
 *  candidate is a GLOBAL `const NAME = [...]` whose every element is a plain
 *  `=>` arrow literal (no holes/spreads/non-closure elements), and whose only
 *  occurrences program-wide are `NAME[idx](args)` as a call's own callee. When
 *  a name qualifies, emit.js feeds every observed call site's arg kinds into
 *  the SAME per-element paramTypes/paramTypedCtors/minArgc lattice
 *  tryDirectClosureCall already builds for a single directly-bound closure
 *  (narrow.js's direct-call param lattice, extended across indexed dispatch —
 *  the return-side analog of the closure-return-kind pre-pass).
 *  Fail-open by construction: any use this walk can't prove safe leaves the
 *  name out of the returned set, and emit.js/emitClosureBody's existing
 *  consumer path is unchanged — an unproven param just stays boxed/dynamic,
 *  exactly as before this pass existed. Called once, post-plan (mirrors
 *  scanDynClosureTableCandidates's timing), from compile/index.js.
 *
 *  Side effect: for each surviving candidate, also derives the table's own
 *  CALL-EXPRESSION result kind (ctx.scope.closureTableValResult) when every
 *  element's return-tail unifies to one VAL.* kind (closureBodyReturnKind —
 *  AST-only, no compiled form needed, so this runs before any element's
 *  closure.make/emission — the same derivation module/function.js runs at
 *  closure-CREATION time for a single directly-bound closure, here forced
 *  early because a table's elements aren't created until the array LITERAL
 *  itself emits, which is AFTER every function body — including a caller
 *  like `x = ops[code[i]](x, k)` — has already emitted). Consumed by
 *  kind.js's VT['()'] so a loop-carried var fed by table dispatch (dispatch
 *  bench's `x`) is itself provably NUMBER, letting arg evidence at the NEXT
 *  iteration's call site prove numeric too. Gated on the SAME safety-filtered
 *  set as the param lattice — the return-kind claim doesn't strictly need
 *  alias-safety (any caller reaching the same body gets the same kind), but
 *  reusing one proven-const, proven-unaliased set avoids a second soundness
 *  argument (a `let`-reassignable or mutated-elsewhere binding) for zero
 *  benefit — every real table (dispatch.js's `ops`) already satisfies both. */
export function scanClosureTableLatticeCandidates(ast) {
  const topRoots = [ast, ...(ctx.module.moduleInits || [])]
  const candidates = new Set()
  const initRhsOf = new Map()
  for (const root of topRoots)
    for (const [name, s] of scanBindingUses(root))
      if (s[BINDING_USE_DECLS] === 1 && ctx.scope.globals?.has(name) && ctx.scope.consts?.has(name) && isArrowArrayLit(s[BINDING_USE_INIT])) {
        candidates.add(name)
        initRhsOf.set(name, s[BINDING_USE_INIT])
      }
  if (!candidates.size) return candidates

  const bodies = [...topRoots]
  for (const func of ctx.funcs.list) {
    if (func.body && !func.raw) bodies.push(func.body)
    if (func.defaults) for (const dv of Object.values(func.defaults)) bodies.push(dv)
  }
  for (const name of candidates)
    if (!bodies.every(b => everyUseIsIndexedCall(b, name))) candidates.delete(name)

  for (const name of candidates) {
    let kind = null, uniform = true
    const kinds = new Set(), elems = initRhsOf.get(name).slice(1)
    for (const el of elems) {
      const k = closureBodyReturnKind(el[2], NO_CAPTURES)
      if (k) kinds.add(k)
      if (!k) uniform = false
      else if (kind == null) kind = k
      else if (kind !== k) uniform = false
    }
    if (uniform && kind) (ctx.scope.closureTableValResult ||= new Map()).set(name, kind)
    // A mixed Number/BigInt indirect result needs a self-describing carrier.
    // Mark the producer bodies now, before any closure is emitted; their
    // RepresentationPlans box only the BigInt-returning members.
    if (kinds.has(VAL.BIGINT) && kinds.size > 1) {
      const tagged = (ctx.scope.taggedClosureResultBodies ||= new WeakSet())
      const shapes = (ctx.scope.taggedClosureResultShapes ||= new Set())
      for (const el of elems) {
        tagged.add(el[2])
        shapes.add(JSON.stringify(el[2]))
      }
    }
  }
  return candidates
}

// True when `name` is a top-level `export` binding (`export let name = …` /
// `export {name}` / re-export). Mirrors plan/scope.js's isHostWritableGlobal
// shape check (same `ctx.funcs.exports` map: exportName -> bound name, or
// `true` for a same-name shorthand export). An exported imperative table can
// be *reassigned wholesale* by the host between calls (`instance.exports.
// name.value = …`) — no AST scan sees that, so it disqualifies here exactly
// as isHostWritableGlobal disqualifies a mutable exported global elsewhere.
const isExportedName = (name) => {
  for (const [exportName, val] of Object.entries(ctx.funcs.exports || {}))
    if (val === name || (val === true && exportName === name)) return true
  return false
}

// Existence check only — no occurrence classification. Used to test whether
// a candidate is touched by code that actually RUNS at module-init time, as
// opposed to being confined entirely to ordinary function/closure bodies
// (which only run later, on some explicit call — irrelevant to whether the
// TOP-LEVEL walk itself reaches the name). A `function`/`=>` subtree is
// therefore never descended into: its body doesn't execute just because it's
// textually nested inside a topRoot (same skip flow-types.js's
// constPropAliases uses for the same reason). See
// scanImperativeClosureTableLatticeCandidates's "early-mergeable" doc for why
// that distinction is the imperative table's version of the literal array's
// module-init-order guarantee.
function mentionsName(node, name) {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op === '=>' || op === 'function') return false
  if (op === 'let' || op === 'const' || op === 'var') {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (typeof d === 'string') continue                        // uninitialized decl — binding, not a use
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
        if (mentionsName(d[2], name)) return true                 // d[1] is the BINDING, not a use
      } else if (mentionsName(d, name)) return true
    }
    return false
  }
  for (let i = 1; i < node.length; i++) {
    const c = node[i]
    if (c === name || mentionsName(c, name)) return true
  }
  return false
}

// Extended occurrence walk for the closure-TABLE call-site PARAM lattice,
// IMPERATIVE-CONSTRUCTION class: everyUseIsIndexedCall's exact strictness
// (the sole tolerated READ is the indexed callee slot of an immediately
// enclosing call) PLUS one new tolerated occurrence — a PLAIN (non-compound)
// `name[key] = <arrow-literal>` WRITE. The RHS must be the closure literal
// itself, not a call to a factory function: dyn-closure-tables' identity-
// devirt (classifyWriteRhs/proveClosureFactory, above) tolerates that
// indirection because it only needs FUNCIDX identity; a param-KIND proof
// needs the arrow's own body AST, which a factory call doesn't expose here
// without redoing proveClosureFactory's whole proof AST-only (out of scope —
// see the module doc). Anything else (a bare read, a compound/non-computed
// write, a non-literal RHS, an alias, a nested-closure mention) disqualifies,
// same as the read-only walk.
//
// A write reached through a for/while/do loop poisons the WHOLE candidate
// (returns false immediately) rather than trusting per-iteration closure
// identity — jz's closure-in-loop capture handling is a documented kernel-
// bug-adjacent class (ledger: closure-in-loop capture class); this lattice
// doesn't build another proof on top of unsettled ground. `sink.arrows`
// collects every tolerated write's RHS arrow node (closureBodyReturnKind
// material) as a side effect of the same walk.
function everyUseIsIndexedCallOrLiteralWrite(node, name, sink, inLoop) {
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (op === 'for' || op === 'while' || op === 'do') inLoop = true
  if (op === 'let' || op === 'const' || op === 'var') {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (typeof d === 'string') continue                          // uninitialized decl
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
        if (!everyUseIsIndexedCallOrLiteralWrite(d[2], name, sink, inLoop)) return false
      } else if (!everyUseIsIndexedCallOrLiteralWrite(d, name, sink, inLoop)) return false
    }
    return true
  }
  if (op === '()') {
    const callee = node[1]
    if (Array.isArray(callee) && callee[0] === '[]' && callee.length === 3 && callee[1] === name) {
      if (!everyUseIsIndexedCallOrLiteralWrite(callee[2], name, sink, inLoop)) return false
      const a = node[2]
      if (a === name) return false
      if (!everyUseIsIndexedCallOrLiteralWrite(a, name, sink, inLoop)) return false
      return true
    }
  }
  if (op === '=') {
    const lhs = node[1]
    if (Array.isArray(lhs) && lhs[0] === '[]' && lhs.length === 3 && lhs[1] === name) {
      const rhs = node[2]
      if (!(Array.isArray(rhs) && rhs[0] === '=>')) return false    // only a literal arrow RHS is tolerated
      if (!everyUseIsIndexedCallOrLiteralWrite(lhs[2], name, sink, inLoop)) return false   // index expression
      if (!everyUseIsIndexedCallOrLiteralWrite(rhs, name, sink, inLoop)) return false       // arrow body — catches nested self-mentions too
      if (inLoop) return false                                     // closure-in-loop class — fail open, whole candidate
      sink.arrows.push(rhs)
      return true
    }
  }
  for (let i = 1; i < node.length; i++) {
    const c = node[i]
    if (c === name) return false
    if (!everyUseIsIndexedCallOrLiteralWrite(c, name, sink, inLoop)) return false
  }
  return true
}

/** Program-wide safety scan for the closure-TABLE call-site PARAM lattice,
 *  IMPERATIVE-CONSTRUCTION class — the named follow-on to
 *  scanClosureTableLatticeCandidates above (CLOSURE-TABLE PARAM LATTICE
 *  LANDED): dispatch tables built via scattered `NAME[key] = fn` assignments
 *  rather than one `const NAME = [...]` literal (jessie's subscript `lookup`
 *  shape). A candidate is a GLOBAL `let`/`const NAME = []` (empty array —
 *  the SAME universe scanDynClosureTableCandidates draws from, not the
 *  const-literal-array universe above), never exported, whose every
 *  occurrence program-wide is safe per everyUseIsIndexedCallOrLiteralWrite:
 *  read-then-call, or a plain `NAME[key] = <arrow-literal>` write, and
 *  nothing else — no escapes, no aliases (dyn-closure-tables.js's own header
 *  comment documents subscript's `(fn = table[idx]) && fn(args)` guarded
 *  idiom as safe for IDENTITY devirt; that idiom is a bare-read ALIAS by this
 *  scan's stricter definition and disqualifies here, honestly, same as any
 *  other untracked read).
 *
 *  Two facts land per surviving candidate:
 *   1. RESULT kind (ctx.scope.closureTableValResult — the SAME map the
 *      const-literal scan above populates; kind.js's VT['()'] doesn't care
 *      which scan proved it) — every collected write's RHS arrow AST run
 *      through closureBodyReturnKind (AST-only, pre-emit, same timing the
 *      const-literal scan uses) with NO_CAPTURES; every write must agree.
 *   2. PARAM-lattice early-mergeability (ctx.scope.
 *      imperativeClosureTableEarlyMergeable) — compile/index.js's per-body
 *      bodyName only exists once THAT function has emitted, and closure
 *      bodies queued during function emission COMPILE as soon as every
 *      function in ctx.funcs.list has emitted (compilePendingClosures' first
 *      flush) — before module-init code (`ast`/moduleInits) has emitted at
 *      all. A candidate confined ENTIRELY to function bodies (jessie's shape:
 *      writes inside `register`, reads inside `next`, both ordinary named
 *      functions) has every occurrence's evidence in hand by that first
 *      flush — merging right there is sound AND complete. A candidate that
 *      also touches module-init code directly can't make that guarantee (a
 *      module-scope call site's evidence wouldn't be gathered until
 *      buildStartFn, well after the first flush already compiled the body) —
 *      FAIL OPEN for the param lattice specifically in that case (module-
 *      init-order reasoning); it keeps its result-kind fact regardless, since
 *      that fact is pipeline-order-independent (pure whole-program AST
 *      enumeration, not tied to when anything compiles).
 *
 *  Called once, post-plan (mirrors scanClosureTableLatticeCandidates's own
 *  timing), from compile/index.js. Consumed by emit.js (call-site evidence
 *  gate), emit-assign.js (write-site member recorder), and compile/index.js
 *  (the early merge step, right before the first compilePendingClosures). */
export function scanImperativeClosureTableLatticeCandidates(ast) {
  const topRoots = [ast, ...(ctx.module.moduleInits || [])]
  const candidates = new Set()
  for (const root of topRoots)
    for (const [name, s] of scanBindingUses(root))
      if (s[BINDING_USE_DECLS] === 1 && ctx.scope.globals?.has(name) && isEmptyArrayLit(s[BINDING_USE_INIT]) && !isExportedName(name))
        candidates.add(name)
  if (!candidates.size) return candidates

  const bodies = [...topRoots]
  for (const func of ctx.funcs.list) {
    if (func.body && !func.raw) bodies.push(func.body)
    if (func.defaults) for (const dv of Object.values(func.defaults)) bodies.push(dv)
  }

  const arrowsByName = new Map()
  for (const name of candidates) {
    const sink = { arrows: [] }
    const ok = bodies.every(b => everyUseIsIndexedCallOrLiteralWrite(b, name, sink, false))
    if (!ok) { candidates.delete(name); continue }
    arrowsByName.set(name, sink.arrows)
  }
  if (!candidates.size) return candidates

  for (const name of candidates) {
    const arrows = arrowsByName.get(name)
    if (!arrows.length) continue
    let kind = null
    for (const arrow of arrows) {
      const k = closureBodyReturnKind(arrow[2], NO_CAPTURES)
      if (!k || (kind != null && kind !== k)) { kind = null; break }
      kind = k
    }
    if (kind) (ctx.scope.closureTableValResult ||= new Map()).set(name, kind)
  }

  const earlyMergeable = new Set()
  for (const name of candidates)
    if (!topRoots.some(r => mentionsName(r, name))) earlyMergeable.add(name)
  ctx.scope.imperativeClosureTableEarlyMergeable = earlyMergeable

  return candidates
}

/** Record fact: emitting `name[idx] = <arrow-literal>` — a write
 *  scanImperativeClosureTableLatticeCandidates already proved tolerated —
 *  produced a closure body. Its emitted bodyName is an "element"
 *  resolveClosureTableParamLattice (emit.js) merges call-site evidence into,
 *  exactly like a literal array's own fnElements list. Called from
 *  emit-assign.js's emitElementAssign, gated on `name` being a proven-safe
 *  imperative candidate. No-op if the RHS somehow didn't emit as a closure
 *  (shouldn't happen — the scan already required a literal `=>` RHS —
 *  defensive only). */
export function recordImperativeClosureTableWrite(name, emittedVal) {
  if (emittedVal?.closureBodyName == null) return
  const members = (ctx.scope.imperativeClosureTableMembers ||= new Map())
  let list = members.get(name); if (!list) members.set(name, list = [])
  list.push({ name: emittedVal.closureBodyName })
}

// Comma-sequence tail: `(a, b, c)` evaluates to `c`. Unwraps to the value an
// expression-bodied arrow (or a `return` statement) actually produces —
// subscript's `dispatch` returns `(fn.ops = ops, fn.tail = tail, fn)`.
const commaTail = (e) => (Array.isArray(e) && e[0] === ',' ? commaTail(e[e.length - 1]) : e)

// Every `return <expr>` reachable in `body` without descending into a nested
// `=>` — same extraction module/function.js's closureReturnExprs uses for its
// own single-purpose "does every return produce a plain number" check — or,
// for an expression-bodied function (no `{}` block), the body itself is the
// sole "return." `null` means "doesn't end in an explicit return" (may fall
// off the end) — unprovable either way, the caller treats that as failure.
function extractReturnExprs(body) {
  if (!Array.isArray(body) || body[0] !== '{}') return [body]
  const stmts = Array.isArray(body[1]) && body[1][0] === ';' ? body[1].slice(1) : [body[1]]
  const last = stmts[stmts.length - 1]
  if (!Array.isArray(last) || last[0] !== 'return') return null
  const rets = []
  let ok = true
  const walk = (n) => {
    if (!ok || !Array.isArray(n) || n[0] === '=>') return
    if (n[0] === 'return') { if (n.length < 2) ok = false; else rets.push(n[1]); return }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  for (const s of stmts) walk(s)
  return ok ? rets : null
}

/** Record fact: the default value of `funcName`'s param `pname` is provably a
 *  closure of body `{name, idx}`. Called from compile/index.js's per-param
 *  default-init emission (`emittedDefVal = emit(defVal)`) — the exact point a
 *  default arrow's closure.make call resolves its funcIdx. Complete once every
 *  function has emitted (before resolveDynFnTables consumes it). */
export function recordParamClosureDefault(funcName, pname, emittedDefVal) {
  if (emittedDefVal?.closureBodyName == null || emittedDefVal?.closureFuncIdx == null) return
  ;(ctx.scope.paramClosureDefaults ||= new Map()).set(`${funcName}#${pname}`,
    { name: emittedDefVal.closureBodyName, idx: emittedDefVal.closureFuncIdx })
}

/** Record fact: `funcName`'s (expression-bodied) return value is
 *  UNCONDITIONALLY a closure of body `{name, idx}`. Called from
 *  compile/index.js right after `const ir = emit(body)` for a non-block
 *  function body. Sound by construction: a branch inside the expression
 *  (ternary/`&&`/`||`) emits as an `if`/`select` wrapper, which never carries
 *  `.closureBodyName` forward, so this only fires when the WHOLE body
 *  statically reduces to one closure.make call. */
export function recordDirectReturnClosure(funcName, ir) {
  if (ir?.closureBodyName == null || ir?.closureFuncIdx == null) return
  ;(ctx.scope.directReturnClosures ||= new Map()).set(funcName, { name: ir.closureBodyName, idx: ir.closureFuncIdx })
}

// One write-site RHS, classified from its SOURCE shape (+ the top-level
// emitted value, when available): a closure literal directly (`.closureBodyName`
// on `val`, the emit()-produced value — only meaningful for the RHS's OWN top
// node, never a sub-arm: emitting a ternary collapses both arms into one IR
// node and no per-arm tag survives that far), or a direct call to a plain user
// function (resolved later — resolveDynFnTables → proveClosureFactory). `null`
// = unrecognized, the caller poisons.
const classifyWriteRhs = (node, val) => {
  if (val?.closureBodyName != null && val?.closureFuncIdx != null)
    return { kind: 'direct', name: val.closureBodyName, idx: val.closureFuncIdx }
  if (Array.isArray(node) && node[0] === '()' && typeof node[1] === 'string' && ctx.funcs.names.has(node[1]))
    return { kind: 'call', callee: node[1] }
  return null
}

/** Record fact: emitting `arr[idx] = val` (source RHS `rhsNode`, emitted value
 *  `emittedVal`) wrote into candidate table `name`. Called from
 *  emit-assign.js's emitElementAssign, gated on `name` being a proven-safe
 *  candidate (scanDynClosureTableCandidates). A ternary RHS (subscript's
 *  `register` idiom: `lookup[c] = fn?.ops ? dispatch(A) : dispatch(B)`)
 *  classifies each arm independently on source shape alone — SOURCE alone
 *  (not the collapsed emitted value) is all a ternary arm has to offer, so
 *  only the "call to a known function" shape is provable there; a bare
 *  closure-literal arm falls through to poison (see classifyWriteRhs). Any
 *  other RHS shape poisons the table PERMANENTLY (poison fixpoint — mirrors
 *  analyzeSchemaSlotIntCertain's program-facts.js global poison semantics:
 *  once poisoned, stays poisoned; never re-examined). */
export function recordDynFnTableWrite(name, rhsNode, emittedVal) {
  const facts = (ctx.scope.dynFnTableWrites ||= new Map())
  let rec = facts.get(name)
  if (!rec) { rec = { writes: [], poisoned: false }; facts.set(name, rec) }
  if (rec.poisoned) return
  if (Array.isArray(rhsNode) && rhsNode[0] === '?:') {
    const wa = classifyWriteRhs(rhsNode[2], null), wb = classifyWriteRhs(rhsNode[3], null)
    if (wa && wb) { rec.writes.push(wa, wb); return }
    rec.poisoned = true
    return
  }
  const w = classifyWriteRhs(rhsNode, emittedVal)
  if (w) { rec.writes.push(w); return }
  rec.poisoned = true
}

/** Prove `calleeName` (a plain user function) ALWAYS returns a closure of one
 *  statically-known body, regardless of how it's called or what it captures.
 *  Two independently-sufficient shapes:
 *
 *   1. Direct — recordDirectReturnClosure already proved the function's own
 *      return value is unconditionally a closure literal.
 *
 *   2. Forwarded default — every return reduces (after unwrapping a trailing
 *      comma-sequence) to a bare parameter P; P is never reassigned; P's
 *      default value is provably a closure (recordParamClosureDefault); and
 *      every call site of `calleeName`, program-wide, passes fewer args than
 *      P's position — so the default ALWAYS fires. Matches subscript's
 *      `dispatch(ops, tail, fn = (a, …) => {…})`, called only as
 *      `dispatch(a, b)`. Requires `calleeName` never escapes as a bare value
 *      reference or module export — either could hide an uncounted call site
 *      that supplies P explicitly, breaking the "default always fires" proof.
 *
 *  Memoized (a callee can be the shared factory behind many writes). Returns
 *  `{name, idx}` or null — the caller poisons the whole write family on null,
 *  same as any other unprovable write. */
function proveClosureFactory(calleeName, programFacts, cache) {
  if (cache.has(calleeName)) return cache.get(calleeName)
  cache.set(calleeName, null)   // reentrancy guard
  let verdict = ctx.scope.directReturnClosures?.get(calleeName) || null
  if (!verdict) {
    const fn = ctx.funcs.map?.get(calleeName)
    if (fn && !fn.raw && fn.body && fn.defaults && !fn.exported && !programFacts.valueUsed?.has(calleeName)) {
      const rets = extractReturnExprs(fn.body)
      if (rets && rets.length) {
        for (const pname of Object.keys(fn.defaults)) {
          if (!rets.every(r => commaTail(r) === pname)) continue
          if (isReassigned(fn.body, pname)) continue
          const fact = ctx.scope.paramClosureDefaults?.get(`${calleeName}#${pname}`)
          if (!fact) continue
          const paramIdx = fn.sig.params.findIndex(p => p.name === pname)
          if (paramIdx < 0) continue
          const sites = (programFacts.callSites || []).filter(cs => cs.callee === calleeName)
          if (!sites.length || !sites.every(cs => cs.argList.length <= paramIdx)) continue
          verdict = fact
          break
        }
      }
    }
  }
  cache.set(calleeName, verdict)
  return verdict
}

/** Post-emission resolution: for every candidate table with a recorded write
 *  family, resolve each write (direct, or through a proven closure-factory
 *  call) and — iff every write agrees on ONE funcIdx — hand it to
 *  devirtConstFnArrayCalls through the SAME `ctx.scope.constFnArrays` map the
 *  const-literal-array path populates. No changes needed to the rewrite or to
 *  call-site tagging: emitGenericClosureCall (emit.js) already tags every
 *  `V[idx](args)` site (and the `(fn = V[idx]) && fn(args)` guarded idiom,
 *  tagged separately at the `&&` node) regardless of how V was populated.
 *
 *  Must run after every function AND module init has emitted —
 *  callSites/paramClosureDefaults/directReturnClosures are only complete
 *  then. Called once from compile/index.js, right after buildStartFn. */
export function resolveDynFnTables(programFacts) {
  const writeFacts = ctx.scope.dynFnTableWrites
  if (!writeFacts || !writeFacts.size) return
  const cache = new Map()
  for (const [name, rec] of writeFacts) {
    if (rec.poisoned || !rec.writes.length) continue
    let common = null, ok = true
    for (const w of rec.writes) {
      const resolved = w.kind === 'direct' ? { name: w.name, idx: w.idx } : proveClosureFactory(w.callee, programFacts, cache)
      if (!resolved) { ok = false; break }
      if (common == null) common = resolved
      else if (common.idx !== resolved.idx) { ok = false; break }
    }
    if (ok && common) (ctx.scope.constFnArrays ||= new Map()).set(name, [{ idx: common.idx, name: common.name }])
  }
}
