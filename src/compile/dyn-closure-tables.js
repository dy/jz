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
import { scanBindingUses, USE } from './analyze-scans.js'

// A candidate table may safely appear as: a `V[idx]` READ (any key — call
// sites read-then-call, `.length`, comparisons, whatever) or a PLAIN
// (non-compound) `V[idx] = RHS` WRITE with a COMPUTED index. Anything else —
// aliasing (`let b = V`), a call argument, a return, a `.`-property write, a
// compound/delete element write, mention inside a nested closure, a bare
// comparison — disqualifies. Default-deny, mirrors scanNeverGrown/
// scanFlatObjects (analyze-scans.js): any use kind not explicitly allowed here
// poisons the candidate.
const safeTableUse = (u) =>
  u.kind === USE.MEMBER_R || (u.kind === USE.MEMBER_W && !u.compound && u.computed)

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
      if (s.decls === 1 && ctx.scope.globals?.has(name) && isEmptyArrayLit(s.initRhs)) candidates.add(name)
  }
  if (!candidates.size) return candidates

  // Pass 2: every USE of a candidate, anywhere in the program, must be safe.
  // `trackNames` makes scanBindingUses report on these globals even in bodies
  // that never declare them (the normal case — a global's uses are scattered
  // across every function that touches it, not just its declaring scope).
  const bodies = [...topRoots]
  for (const func of ctx.func.list) {
    if (func.body && !func.raw) bodies.push(func.body)
    if (func.defaults) for (const dv of Object.values(func.defaults)) bodies.push(dv)
  }
  for (const body of bodies) {
    const uses = scanBindingUses(body, candidates)
    for (const name of candidates) {
      if (!candidates.has(name)) continue
      const s = uses.get(name)
      if (s && !s.uses.every(safeTableUse)) candidates.delete(name)
    }
  }
  return candidates
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
  if (Array.isArray(node) && node[0] === '()' && typeof node[1] === 'string' && ctx.func.names.has(node[1]))
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
    const fn = ctx.func.map?.get(calleeName)
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
