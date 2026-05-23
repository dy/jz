/**
 * Pre-analysis passes — type inference, local analysis, capture detection.
 *
 * # Stage contract
 *   IN:  prepared AST + ctx.func.list (from prepare).
 *   OUT: per-function populated `ctx.func.localReps` (val field) + `ctx.func.locals` + `ctx.func.boxed`,
 *        module-global `ctx.scope.globalValTypes`, type-analysis `ctx.types.typedElem` /
 *        `.dynKeyVars` / `.anyDynKey`.
 *
 * # Passes (all walk AST; none mutate AST itself — only ctx)
 *   - boxedCaptures:       detect mutably-captured vars → ctx.func.boxed cells
 *
 * Value KIND inference: src/kind.js. WASM local typing: src/type.js. Static eval: src/static.js.
 *
 * Ordering: all passes run per function during compile(). plan.js owns the
 * cross-function dynKey scan via programFacts (results land in ctx.types.dynKeyVars).
 *
 * @module analyze
 */

import { commaList, ASSIGN_OPS, isReassigned, STMT_OPS, isBlockBody, isLiteralStr, isFuncRef, I32_MIN, I32_MAX, isI32, T, extractParams, classifyParam, collectParamNames, alwaysReturns, returnExprs, refsName, REFS_IN_EXPR } from './ast.js'
import { ctx, err } from './ctx.js'
import { VAL, repOf, repOfGlobal, updateRep, updateGlobalRep, lookupValType, lookupNotString } from './reps.js'
import { valTypeOf, jsonConstString, shapeOf, shapeOfObjectLiteralAst } from './kind.js'
import { intLiteralValue, nonNegIntLiteral, constIntExpr, NO_VALUE, staticPropertyKey, staticValue, staticObjectProps, staticArrayElems, objLiteralSchemaId, exprSchemaId, inlineArraySid } from './static.js'
import { typedElemCtor, TYPED_ELEM_CODE, TYPED_ELEM_VIEW_FLAG, TYPED_ELEM_BIGINT_FLAG, encodeTypedElemAux, typedElemAux, TYPED_ELEM_NAMES, ctorFromElemAux, MIXED_CTORS, isCondExpr, ternaryCtorOfRhs, scanBoundedLoops, inBoundsCharCodeAt, exprType, intCertainMap } from './type.js'

// ValueRep field docs + ParamReps lattice helpers — storage lives in src/reps.js.

// === ParamReps lattice helpers (cross-call fixpoint) ===
// programFacts.paramReps: Map<funcName, Map<paramIdx, ValueRep>>. Per-field lattice:
// undefined unobserved, null sticky-poison (cross-site disagreement), value = consensus.

// Cross-call argument inference helpers (`infer*`) live in src/infer.js.
// paramReps lattice lives in src/param-reps.js.

/**
 * Per-binding use-summary — the substrate the representation analyses share.
 *
 * One traversal classifies every mention of each `let`/`const` binding into a
 * closed taxonomy of use-kinds (`USE.*`). The eligibility analyses below
 * (`scanFlatObjects`, `scanSliceViews`, `unboxablePtrs`) are then *policies* —
 * subset predicates over this summary — rather than three independent body
 * re-walks. The classification logic is the union of those walks; a use-kind
 * exists for every distinction at least one consumer needs.
 *
 * Deliberately NOT a consumer: `analyzeBody`'s `escapes` map. It looks like a
 * fourth escape analysis but is not — it is context-sensitive *taint* over
 * value-expression positions (member access short-circuits, a static index
 * does not escape but a dynamic one does), woven into the main typing walk it
 * shares with six other facts. Re-expressing it here would need `BARE` split
 * by enclosing construct (a plain `name;` statement vs `return name`) and a
 * second traversal — adding a walk, not removing one. It stays where it is.
 *
 * Returns `Map<name, { decls, initRhs, uses }>` for every name the body
 * `let`/`const`-declares. `uses` is a `UseRecord[]`; a record is
 * `{ kind, key?, optional?, computed?, compound?, nullCmp?, callee?, argIndex? }`.
 *
 * Scoping: decls are collected only outside closures (a `let` inside a nested
 * `=>` is a different scope), but uses ARE collected inside closures — every
 * mention there becomes a `CAPTURE`, which every policy treats as
 * disqualifying. A binding shadowed by an inner closure decl is conservatively
 * still flagged `CAPTURE`; sound, since it only ever forfeits an optimization.
 *
 * Order-independent: uses bucket by name, so a mention before its decl is fine.
 */



// === param helpers / AST predicates ===

// === Param / closure helpers ===

/** Find free variables in AST: referenced in node, not in `bound`, present in `scope`. */
export function findFreeVars(node, bound, free, scope) {
  if (node == null) return
  if (typeof node === 'string') {
    if (bound.has(node) || free.includes(node)) return
    const inScope = scope
      ? scope.has(node)
      : (ctx.func.locals?.has(node) || ctx.func.current?.params.some(p => p.name === node))
    if (inScope) free.push(node)
    return
  }
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  if (op === '=>') {
    const innerBound = collectParamNames(extractParams(args[0]), new Set(bound))
    findFreeVars(args[1], innerBound, free, scope)
    return
  }
  if (op === 'catch') {
    findFreeVars(args[0], bound, free, scope)
    const errName = args[1]
    const handlerBound = typeof errName === 'string' && errName
      ? new Set(bound).add(errName) : bound
    findFreeVars(args[2], handlerBound, free, scope)
    return
  }
  if (op === 'let' || op === 'const') {
    collectParamNames(args, bound)
    if (scope) collectParamNames(args, scope)
  }
  if (op === 'for' && Array.isArray(args[0]) && (args[0][0] === 'let' || args[0][0] === 'const')) {
    collectParamNames(args[0].slice(1), bound)
    if (scope) collectParamNames(args[0].slice(1), scope)
  }
  for (const a of args) findFreeVars(a, bound, free, scope)
}

/** Check if any of the given variable names are assigned anywhere in the AST. */
export function findMutations(node, names, mutated) {
  if (node == null || typeof node !== 'object' || !Array.isArray(node)) return
  const [op, ...args] = node
  if (op === 'let' || op === 'const') {
    for (const decl of args)
      if (Array.isArray(decl) && decl[0] === '=') findMutations(decl[2], names, mutated)
    return
  }
  if (ASSIGN_OPS.has(op) && typeof args[0] === 'string' && names.has(args[0]))
    mutated.add(args[0])
  if ((op === '++' || op === '--') && typeof args[0] === 'string' && names.has(args[0]))
    mutated.add(args[0])
  for (const a of args) findMutations(a, names, mutated)
}

/**
 * Pre-scan function body for captured variables that are mutated.
 * Marks mutably-captured vars in ctx.func.boxed for cell-based capture.
 */
export function boxedCaptures(body) {
  const outerScope = new Set()
  ;(function collectDecls(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'let' || op === 'const')
      collectParamNames(args, outerScope)
    for (const a of args) collectDecls(a)
  })(body)
  if (ctx.func.current?.params) for (const p of ctx.func.current.params) outerScope.add(p.name)
  if (ctx.func.locals) for (const k of ctx.func.locals.keys()) outerScope.add(k)

  const markArrowCaptures = (node, assignTarget, seen) => {
    const pnode = node[1]
    let p = pnode
    if (Array.isArray(p) && p[0] === '()') p = p[1]
    const raw = p == null ? [] : Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : [p]) : [p]
    const paramSet = new Set(raw.map(r => Array.isArray(r) && r[0] === '...' ? r[1] : r))
    const captures = []
    findFreeVars(node[2], paramSet, captures, outerScope)
    if (captures.length === 0) return
    const captureSet = new Set(captures)
    const boxed = new Set()
    findMutations(body, captureSet, boxed)
    for (const v of captures) if (!seen.has(v)) boxed.add(v)
    if (assignTarget && captureSet.has(assignTarget)) boxed.add(assignTarget)
    for (const v of boxed) if (!ctx.func.boxed.has(v)) ctx.func.boxed.set(v, `${T}cell_${v}`)
  }

  ;(function walk(node, assignTarget, seen = new Set(ctx.func.current?.params?.map(p => p.name) || [])) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') {
      markArrowCaptures(node, assignTarget, seen)
      return
    }

    if (op === ';' || op === '{}') {
      const blockSeen = new Set(seen)
      for (const a of args) walk(a, null, blockSeen)
      return
    }

    if (op === 'let' || op === 'const') {
      for (const decl of args) {
        if (Array.isArray(decl) && decl[0] === '=') walk(decl[2], typeof decl[1] === 'string' ? decl[1] : null, seen)
        else walk(decl, null, seen)
        collectParamNames([decl], seen)
      }
      return
    }

    if (op === '=' && typeof args[0] === 'string' && Array.isArray(args[1]) && args[1][0] === '=>')
      return walk(args[1], args[0], seen)
    for (const a of args) walk(a, null, seen)
  })(body)
}

/**
 * Narrow return arr-elem-{schema|valType}: for each non-exported, non-value-used
 * user func with `valResult === VAL.ARRAY` and `func[field] == null`, walk return
 * exprs (and trailing-fallthrough literal), resolve each via body-local elem map
 * + caller-param facts + transitive user-fn results, and if all agree set `func[field]`.
 * Lets callers' `const rows = initRows()` gain the elem fact, propagating to
 * runKernel params via paramReps. `field` selects which fact ('arrayElemSchema'
 * | 'arrayElemValType') — slice key is derived.
 */

// === body walks / program facts ===

const USE = {
  MEMBER_R: 1,       // receiver of a `.`/`?.`/`[]` READ   — {key, optional, computed}
  MEMBER_W: 2,       // base of a `.`/`[]` WRITE           — {key, computed, compound}
  REASSIGN: 3,       // `=`(non-init) / `++` / `--` / compound-assign of the name
  CALL_ARG: 4,       // passed as a call argument          — {callee, argIndex}
  CALL_CALLEE: 5,    // invoked: `name(...)`
  RETURN: 6,         // `return name`
  CAPTURE: 7,        // mentioned inside a nested `=>`
  COMPARE: 8,        // operand of a comparison            — {nullCmp}
  CONCAT: 9,         // operand of `+`
  BOOL_TEST: 10,     // operand of `!`/`typeof`/`void`, or an `if`/`while`/`?:` test
  DELETE_MEMBER: 11, // `delete name.member`
  BARE: 12,          // any other value position — the conservative catch-all
}
const _bindingUsesCache = new WeakMap()
const _CMP_OPS = new Set(['==', '!=', '===', '!==', '<', '>', '<=', '>='])
const _isNullishLit = (e) =>
  e === 'null' || e === 'undefined' ||
  (Array.isArray(e) && e[0] == null && (e[1] === null || e[1] === undefined))

function scanBindingUses(body) {
  const hit = _bindingUsesCache.get(body)
  if (hit) return hit

  const summary = new Map()                    // name → { decls, initRhs, uses }
  const slot = (name) => {
    let s = summary.get(name)
    if (!s) { s = { decls: 0, initRhs: undefined, uses: [] }; summary.set(name, s) }
    return s
  }
  const use = (name, kind, extra) => slot(name).uses.push(extra ? { kind, ...extra } : { kind })

  // Static string key of a `[]` index node, else null (computed).
  const litKey = (k) => (Array.isArray(k) && k[0] === 'str' && typeof k[1] === 'string') ? k[1] : null

  // A child sitting in a value position. A bare string there is a real use —
  // `walk` alone silently drops non-array children, so every value-position
  // child (let-rhs, assign-rhs, call/index args, closure body, …) must route
  // through here or its use goes unrecorded (a latent miscompile: the binding
  // looks unused and an optimization fires unsoundly).
  const val = (child, inClosure) => {
    if (typeof child === 'string') use(child, inClosure ? USE.CAPTURE : USE.BARE)
    else walk(child, inClosure)
  }

  // Classify the target of an assignment-like node (`=`, compound, `++`, `--`).
  const assignTarget = (t, compound) => {
    if (typeof t === 'string') { use(t, USE.REASSIGN); return }
    if (!Array.isArray(t)) return
    const o = t[0]
    if ((o === '.' || o === '?.') && typeof t[1] === 'string') {
      use(t[1], USE.MEMBER_W, { key: typeof t[2] === 'string' ? t[2] : null, computed: false, compound })
      return
    }
    if (o === '[]' && typeof t[1] === 'string') {
      const k = litKey(t[2])
      use(t[1], USE.MEMBER_W, { key: k, computed: k == null, compound })
      if (t[2] != null) val(t[2])
      return
    }
    walk(t)                                     // some other LHS shape — generic
  }

  function walk(node, inClosure) {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (typeof op !== 'string') return          // literal node `[null, value]`
    if (op === 'str') return                    // string literal
    if (op === '=>') { for (let i = 1; i < node.length; i++) val(node[i], true); return }

    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (typeof d === 'string') { if (!inClosure) slot(d).decls++; continue }
        if (Array.isArray(d) && d[0] === '=') {
          const lhs = d[1], rhs = d[2]
          if (typeof lhs === 'string') {
            if (!inClosure) { const s = slot(lhs); s.decls++; if (s.initRhs === undefined) s.initRhs = rhs }
          } else {
            walk(lhs, inClosure)                // pattern — computed keys/defaults are real uses
          }
          val(rhs, inClosure)
        } else walk(d, inClosure)
      }
      return
    }

    if (inClosure) {                            // every mention here is a CAPTURE
      for (let i = 1; i < node.length; i++) {
        const c = node[i]
        if (typeof c === 'string') use(c, USE.CAPTURE)
        else walk(c, true)
      }
      return
    }

    // === precise classification (outside any closure) ===
    if (ASSIGN_OPS.has(op)) { assignTarget(node[1], op !== '='); val(node[2]); return }
    if (op === '++' || op === '--') { assignTarget(node[1], true); return }
    if (op === 'delete') {
      const t = node[1]
      if (Array.isArray(t) && (t[0] === '.' || t[0] === '?.' || t[0] === '[]') && typeof t[1] === 'string') {
        use(t[1], USE.DELETE_MEMBER)
        if (t[0] === '[]' && t[2] != null) val(t[2])
      } else val(t)
      return
    }
    if (op === '.' || op === '?.') {
      const recv = node[1]
      if (typeof recv === 'string')
        use(recv, USE.MEMBER_R, { key: typeof node[2] === 'string' ? node[2] : null, optional: op === '?.', computed: false })
      else walk(recv)
      return                                    // node[2] is the property name
    }
    if (op === '[]') {
      const recv = node[1], k = litKey(node[2])
      if (typeof recv === 'string') use(recv, USE.MEMBER_R, { key: k, optional: false, computed: k == null })
      else walk(recv)
      if (node[2] != null) val(node[2])
      return
    }
    if (op === ':') {                           // object property `{k:v}` / labeled statement
      if (Array.isArray(node[1])) walk(node[1]) // computed key `{[expr]:v}` — a real use
      val(node[2])                              // property value (or the labeled statement)
      return                                    // string node[1] = plain key / label — not a use
    }
    if (op === 'return') {
      const e = node[1]
      if (typeof e === 'string') use(e, USE.RETURN)
      else walk(e)
      return
    }
    if (op === '()') {
      const callee = node[1]
      if (typeof callee === 'string') use(callee, USE.CALL_CALLEE)
      else walk(callee)
      const argNode = node[2]
      if (argNode != null) {
        const args = (Array.isArray(argNode) && argNode[0] === ',') ? argNode.slice(1) : [argNode]
        for (let ai = 0; ai < args.length; ai++) {
          const a = args[ai]
          if (Array.isArray(a) && a[0] === '...') { val(a[1]); continue }
          if (typeof a === 'string') use(a, USE.CALL_ARG, { callee: typeof callee === 'string' ? callee : null, argIndex: ai })
          else walk(a)
        }
      }
      return
    }
    if (_CMP_OPS.has(op) && node.length === 3) {
      for (let i = 1; i <= 2; i++) {
        const side = node[i]
        if (typeof side === 'string') use(side, USE.COMPARE, { nullCmp: _isNullishLit(node[3 - i]) })
        else walk(side)
      }
      return
    }
    if (op === '+') {
      for (let i = 1; i < node.length; i++) {
        const c = node[i]
        if (typeof c === 'string') use(c, USE.CONCAT)
        else walk(c)
      }
      return
    }
    if (op === '!' || op === 'typeof' || op === 'void') {
      const c = node[1]
      if (typeof c === 'string') use(c, USE.BOOL_TEST)
      else walk(c)
      return
    }
    if (op === 'if' || op === 'while' || op === '?:') {  // `prepare` normalizes `?` → `?:`
      const c = node[1]
      if (typeof c === 'string') use(c, USE.BOOL_TEST)
      else walk(c)
      for (let i = 2; i < node.length; i++) val(node[i])
      return
    }

    // generic — every string child is a BARE value use
    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (typeof c === 'string') use(c, USE.BARE)
      else walk(c)
    }
  }

  walk(body, false)

  for (const [name, s] of summary) if (s.decls === 0) summary.delete(name)
  _bindingUsesCache.set(body, summary)
  return summary
}

/**
 * SRoA eligibility scan — which `let/const o = {staticLiteral}` bindings can
 * have their fields dissolved into plain WASM locals (`flat` carrier): no heap
 * alloc, no field load/store, `o.prop` becomes `local.get`.
 *
 * A binding is flat-eligible iff `o` appears ONLY as a literal-key `.`/`[]`
 * READ of an in-schema prop, or the member LHS of a literal-key `.`/`[]` WRITE
 * of an in-schema prop. Any other mention — bare ref, dynamic/numeric key,
 * off-schema prop, `?.`, reassignment, compound assign, `++`/`--`, `delete`,
 * closure capture, self-referential initializer, duplicate keys, or a second
 * declaration — disqualifies it. A non-escaping object is never observed by
 * any object walk (keys/values/entries/assign/spread/JSON/for-in/dyn), so the
 * transform is additive and sound. Conservative: any doubt → not flat.
 *
 * A policy over `scanBindingUses`: the shared traversal classifies every
 * mention; this scan keeps a binding only if its initializer is a self-
 * contained static literal and every use is an in-schema literal-key access.
 *
 * Returns `Map<name, {names, values}>` — the literal's parallel prop arrays.
 * Field `i` of binding `o` lives in WASM local `o#${i}` (`#` cannot occur in a
 * jz identifier, so the name is collision-free).
 */
function scanFlatObjects(body) {
  const cand = new Map()                 // name → {names, values}

  // A binding referenced as a value inside `node` (skips `:`/`.` property-name
  // slots). Used only to reject a self-referential initializer — a literal
  // whose own field values mention the binding is not a self-contained object.
  for (const [name, s] of scanBindingUses(body)) {
    if (s.decls !== 1 || !Array.isArray(s.initRhs) || s.initRhs[0] !== '{}') continue
    const props = staticObjectProps(s.initRhs.slice(1))
    if (!props || new Set(props.names).size !== props.names.length) continue
    if (props.values.some(v => refsName(v, name, REFS_IN_EXPR))) continue

    // Schema = literal keys ∪ plain literal-key member writes. Such a write
    // monotonically extends the static field universe (the new field reads
    // `undefined` until the write runs, exactly as JS does); the schema stays
    // closed because any computed/off-schema access disqualifies below.
    const schema = new Set(props.names)
    for (const u of s.uses)
      if (u.kind === USE.MEMBER_W && !u.compound && !u.computed && u.key != null)
        schema.add(u.key)

    // Flat iff every mention is an in-schema literal-key `.`/`[]` READ, or an
    // in-schema literal-key plain `.`/`[]` WRITE. Any other use kind — `?.`,
    // computed/off-schema key, reassignment, compound or `delete` member write,
    // `++`/`--`, call arg, closure capture, bare ref — leaves the object live.
    const flat = s.uses.every(u =>
      (u.kind === USE.MEMBER_R && !u.optional && !u.computed && schema.has(u.key)) ||
      (u.kind === USE.MEMBER_W && !u.compound && !u.computed && schema.has(u.key)))
    if (!flat) continue

    // Materialize the parallel {names, values}: literal props first, then each
    // extension field (value `undefined`), in first-write order.
    const names = props.names.slice(), values = props.values.slice()
    for (const k of schema)
      if (!names.includes(k)) { names.push(k); values.push(undefined) }
    cand.set(name, { names, values })
  }
  return cand
}

/**
 * No-copy slice scan — which `let/const t = s.slice(...)` bindings can be a
 * VIEW (a SLICE_BIT pointer straight into `s`'s buffer) instead of a fresh
 * byte copy.
 *
 * jz rewinds the bump arena only at function exit, so every string the
 * function can observe stays alive until it returns. A view is therefore sound
 * exactly when its binding does NOT escape the function: `t` must never be
 * returned, passed as a call argument, stored into a heap object/array,
 * captured by a closure, aliased to another binding, reassigned, or
 * compound-assigned. The permitted uses — receiver of a `.`/`[]`, operand of a
 * comparison or `+`, a boolean test — read `t` synchronously and never persist
 * it past the function.
 *
 * Declared exactly once as `let/const`. The result is purely structural —
 * whether the receiver is actually a string (so `.slice` lowers to the string
 * view) is settled later, at emit time, when param types are known; emitDecl
 * keeps the ordinary copying slice for any non-string receiver. Conservative:
 * any unrecognised position disqualifies the binding.
 *
 * Returns `Set<name>` of view-eligible binding names.
 */
// Permitted use-kinds for a slice view — the value is read synchronously and
// never persisted past the function. `MEMBER_R`/`MEMBER_W` cover any `.`/`[]`
// receiver; `COMPARE` any comparison; `CONCAT`/`BOOL_TEST` the copy / test
// positions. Any other kind (reassign, call arg, return, capture, bare alias)
// escapes and disqualifies the binding.
const _SLICE_VIEW_OK = new Set([USE.MEMBER_R, USE.MEMBER_W, USE.COMPARE, USE.CONCAT, USE.BOOL_TEST])

function scanSliceViews(body) {
  const isSliceCall = (n) =>
    Array.isArray(n) && n[0] === '()' && Array.isArray(n[1])
    && n[1][0] === '.' && n[1][2] === 'slice'

  const views = new Set()
  for (const [name, s] of scanBindingUses(body)) {
    if (s.decls !== 1 || !isSliceCall(s.initRhs)) continue
    if (s.uses.every(u => _SLICE_VIEW_OK.has(u.kind))) views.add(name)
  }
  return views
}

/**
 * Unified per-body analysis. Single AST traversal producing every per-binding
 * fact the emitter needs:
 *
 *   {
 *     locals:           Map<name, 'i32'|'f64'>     // wasm type per local
 *     valTypes:         Map<name, VAL.*>           // value-type for dispatch
 *     arrElemSchemas:   Map<name, schemaId|null>   // Array<schema> facts
 *     arrElemValTypes:  Map<name, VAL.*|null>      // Array<val-kind> facts
 *     typedElems:       Map<name, ctorString>      // typed-array ctor binding
 *   }
 *
 * Recursion shape: after a `let`/`const` decl, the rhs is walked but the `=`
 * node itself is skipped — arrElemSchemas/ValTypes have a reassignment
 * invalidation rule that would misfire on init. Other slices' `=`-visit is
 * idempotent with the decl handler, so skipping it is safe for them too.
 *
 * Forward-only observation order: every rule reads only state already produced
 * earlier in the same walk (alias chains, push observations, etc.), so a single
 * traversal is sound.
 *
 * After the walk a `widenPass` runs to widen `i32` locals compared against `f64`
 * operands.
 *
 * Caching: body-keyed via `_bodyFactsCache`. See
 * `invalidateLocalsCache` / `invalidateValTypesCache` for the invalidation hooks.
 */
const _bodyFactsCache = new WeakMap()

/**
 * Narrow uint32 accumulator locals to unsigned i32. A local qualifies when its
 * initializer is a non-negative integer literal in [0, 2^32), every
 * reassignment is `name = (…) >>> k` (so it always holds a canonical uint32),
 * and every read sits inside a `>>>` (ToUint32) sink reached only through
 * bit-faithful operators (`^ & | ~ << >> + - *`). Under those constraints the
 * raw i32 bit pattern reproduces JS semantics exactly — every observable use is
 * funnelled through ToUint32 — so the f64 round-trip on the hot path is pure
 * overhead. Names that escape (closures, bare `return`, signed-sensitive
 * operands) keep their wider type. Returns the qualifying set; callers retype
 * `locals` to 'i32' and tag `readVar` reads `.unsigned` for convert_i32_u.
 */
function narrowUint32(body, locals) {
  const TRANSPARENT = new Set(['^', '&', '|', '~', '<<', '>>', '+', '-', '*'])
  const initLit = new Set()   // names with a valid u32-literal initializer
  const disq = new Set()      // names disqualified by an unsafe occurrence
  const seen = new Set()
  const isU32Lit = e => {
    const v = typeof e === 'number' ? e
      : Array.isArray(e) && e[0] == null && typeof e[1] === 'number' ? e[1] : NaN
    return Number.isInteger(v) && v >= 0 && v < 4294967296
  }
  const isAssignOp = op => op[op.length - 1] === '=' &&
    op !== '==' && op !== '===' && op !== '!=' && op !== '!==' && op !== '<=' && op !== '>='
  const banNames = n => {
    if (typeof n === 'string') disq.add(n)
    else if (Array.isArray(n)) for (let i = 1; i < n.length; i++) banNames(n[i])
  }
  const walk = (node, underShr, inClosure) => {
    if (typeof node === 'string') { if (inClosure) disq.add(node); return }
    if (!Array.isArray(node)) return
    const op = node[0]
    if (typeof op !== 'string') {
      for (let i = 1; i < node.length; i++) walk(node[i], false, inClosure)
      return
    }
    if (op === '=>') { for (let i = 1; i < node.length; i++) walk(node[i], false, true); return }
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
          const nm = d[1]
          if (seen.has(nm) || inClosure || !isU32Lit(d[2])) disq.add(nm)
          else initLit.add(nm)
          seen.add(nm)
          walk(d[2], false, inClosure)
        } else if (typeof d === 'string') { disq.add(d); seen.add(d) }
        else if (Array.isArray(d) && d[0] === '=') { banNames(d[1]); walk(d[2], false, inClosure) }
      }
      return
    }
    if ((op === '++' || op === '--') && typeof node[1] === 'string') { disq.add(node[1]); return }
    if (isAssignOp(op)) {
      const lhs = node[1]
      if (typeof lhs === 'string') {
        if (op !== '=' || inClosure || !(Array.isArray(node[2]) && node[2][0] === '>>>')) disq.add(lhs)
      } else banNames(lhs)
      walk(node[2], false, inClosure)
      return
    }
    const childShr = op === '>>>' ? true : TRANSPARENT.has(op) ? underShr : false
    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (typeof c === 'string') { if (inClosure || !childShr) disq.add(c) }
      else walk(c, childShr, inClosure)
    }
  }
  walk(body, false, false)
  const result = new Set()
  for (const nm of initLit) {
    if (disq.has(nm)) continue
    const t = locals.get(nm)
    if (t !== 'i32' && t !== 'f64') continue
    locals.set(nm, 'i32')
    result.add(nm)
  }
  return result
}

// Operators under which a counter remains a *monotone, bounded* function of the
// index root: an affine index `base + i*stride` (and `i << k`) whose computed
// offset must fit i32-addressable wasm32 memory therefore bounds the counter to
// i32 range. `/ % & | ^ >> >>>` are excluded — they decouple the index magnitude
// from the counter (`arr[i & 7]` stays small however large `i` grows), so they
// prove nothing about the counter's range.
const AFFINE_INDEX_OPS = new Set(['+', '-', '*', '<<', 'u-'])

/**
 * Locals proven to stay within i32 range, so they need not widen to f64 when
 * compared against an f64 loop bound. Keeping them i32 yields direct i32 indexing
 * (no per-access `trunc_sat_f64_s`) and lets the relational compare coerce the
 * counter instead — the compiler-inferred form of the manual `let n = N | 0` hoist.
 *
 * Two sound sources of an i32-range proof:
 *   1. Direct: a local appears as an *affine* component of an array index. A valid
 *      wasm32 access requires the byte offset to fit i32, and an affine index is
 *      monotone in the local, so the local is i32-bounded for every non-trapping run.
 *   2. Transitive (back-propagation): a local that flows — via affine
 *      assignment/step (`let i0 = ix`, `i0 += id`) — into an already-bounded index
 *      var is itself bounded by that var's range. This captures the common
 *      nested-loop shape where the outer bound seeds an inner index (FFT butterflies:
 *      `while (ix < N) { let i0 = ix; while (i0 < N) … x[i0] … i0 += id }`).
 *
 * Fractional locals are unaffected: this set only suppresses *comparison*-driven
 * widening; the assignment fixpoint that follows still widens any local with an
 * f64-typed RHS (`i = i / 3`), overriding membership here.
 */
function collectI32SafeIndexVars(body, locals) {
  const safe = new Set()
  // Collect names reachable from `node` through affine ops only, into `sink`.
  const addAffine = (node, sink) => {
    if (typeof node === 'string') { sink.add(node); return }
    if (!Array.isArray(node)) return
    if (AFFINE_INDEX_OPS.has(node[0])) for (let i = 1; i < node.length; i++) addAffine(node[i], sink)
  }
  const edges = []  // { target, rhs } for affine assignment/step propagation
  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    // Direct seed: computed member `obj[idx]` whose index is *already fully i32*.
    // Only then does keeping its counters i32 eliminate a real per-access trunc.
    // If the index carries an f64 operand (an f64 stride/global, e.g. `mem[y*w+x]`
    // with f64 `w`), the access truncs regardless — narrowing the counter would add
    // a compare-convert for zero trunc savings (net loss), so we leave it to widen.
    if (op === '[]' && !isLiteralStr(node[2]) && exprType(node[2], locals) === 'i32') addAffine(node[2], safe)
    // Record assignment edges (decl init, `=`, and `+= -= *=` steps).
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') edges.push({ target: d[1], rhs: d[2] })
      }
    } else if (op === '=' && typeof node[1] === 'string') {
      edges.push({ target: node[1], rhs: node[2] })
    } else if ((op === '+=' || op === '-=' || op === '*=') && typeof node[1] === 'string') {
      edges.push({ target: node[1], rhs: node[2] })
    }
    if (op === '=>') return  // nested arrows are separate scopes with their own counters
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  // Back-propagate to a fixpoint: feeders of a bounded index var are bounded.
  let changed = true
  while (changed) {
    changed = false
    for (const { target, rhs } of edges) {
      if (!safe.has(target)) continue
      const src = new Set()
      addAffine(rhs, src)
      for (const s of src) if (!safe.has(s)) { safe.add(s); changed = true }
    }
  }
  return safe
}

/**
 * Returns the cached facts object directly — DO NOT MUTATE the returned maps.
 * Callers that need to extend (e.g. add params to locals) must clone explicitly
 * before mutating. Slice reads via `analyzeBody(body).<slice>`.
 */
export function analyzeBody(body) {
  // Non-object bodies (`() => 0`, `() => x`, missing) have nothing to observe
  // for any slice and can't be WeakMap-keyed. Return empty maps without caching.
  if (body === null || typeof body !== 'object') return {
    locals: new Map(), valTypes: new Map(), arrElemSchemas: new Map(),
    arrElemValTypes: new Map(), typedElems: new Map(), escapes: new Map(),
    flatObjects: new Map(),
  }
  const hit = _bodyFactsCache.get(body)
  if (hit) return hit

  const locals = new Map()
  const valTypes = new Map()
  const arrElemSchemas = new Map()
  const arrElemValTypes = new Map()
  const typedElems = new Map()
  const escapes = new Map() // name → bool: local holds allocation, true if it escapes
  const valPoison = new Set()

  const doSchemas = !!ctx.schema?.register
  // Per-walk local schema map for chained `arr.push(name)` resolution.
  const localSchemaMap = new Map()

  // === Observation helpers ===
  //
  // These trust the AST: any `arr.push(...)` syntactically present has `arr` as
  // a body-relevant name (decl, param, or global) since closure boundaries are
  // skipped at walk time. Pure typo names produce harmless dead Map entries
  // that are never queried (consumers index by known local/param names).
  // Removing the legacy `ctx.func.locals.has(arr)` filter makes analyzeBody's
  // output context-pure — cache hits don't depend on transient ctx state.

  const observeArrSchema = (arr, sid) => {
    if (!doSchemas) return
    if (typeof arr !== 'string') return
    if (arrElemSchemas.get(arr) === null) return
    if (sid == null) { arrElemSchemas.set(arr, null); return }
    if (!arrElemSchemas.has(arr)) arrElemSchemas.set(arr, sid)
    else if (arrElemSchemas.get(arr) !== sid) arrElemSchemas.set(arr, null)
  }

  const observeArrValType = (arr, vt) => {
    if (typeof arr !== 'string') return
    if (arrElemValTypes.get(arr) === null) return
    if (!vt) { arrElemValTypes.set(arr, null); return }
    if (!arrElemValTypes.has(arr)) arrElemValTypes.set(arr, vt)
    else if (arrElemValTypes.get(arr) !== vt) arrElemValTypes.set(arr, null)
  }

  const elemValOf = (name) => {
    if (typeof name !== 'string') return null
    const repVt = ctx.func.localReps?.get(name)?.arrayElemValType
    if (repVt) return repVt
    return arrElemValTypes.get(name) || null
  }

  const exprElemSourceVal = (expr) => {
    if (typeof expr === 'string') {
      const repVt = ctx.func.localReps?.get(expr)?.val
      if (repVt) return repVt
      return ctx.scope.globalValTypes?.get(expr) || null
    }
    return valTypeOf(expr)
  }

  const typedPoison = new Set()
  const trackVal = (name, vt) => {
    if (valPoison.has(name)) return
    const prev = valTypes.get(name)
    if (!vt) {
      if (prev) valPoison.add(name)
      valTypes.delete(name)
      return
    }
    if (prev && prev !== vt) {
      valPoison.add(name)
      valTypes.delete(name)
      return
    }
    valTypes.set(name, vt)
  }
  const invalidateTyped = (name) => {
    typedPoison.add(name)
    typedElems.delete(name)
  }
  const trackTyped = (name, rhs) => {
    if (typedPoison.has(name)) return
    const setOrInvalidate = (c) => {
      if (c === MIXED_CTORS) return invalidateTyped(name)
      const prev = typedElems.get(name)
      if (prev && prev !== c) invalidateTyped(name)
      else typedElems.set(name, c)
    }
    const ctor = typedElemCtor(rhs)
    if (ctor) return setOrInvalidate(ctor)
    if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
      const f = ctx.func.map?.get(rhs[1])
      if (f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null) {
        const c = ctorFromElemAux(f.sig.ptrAux)
        if (c) setOrInvalidate(c)
      }
      return
    }
    // Heterogeneous ternary: ctors that don't unify must invalidate so a sibling
    // decl (jz hoists `let` to function scope) can't lock in the wrong width.
    const tc = ternaryCtorOfRhs(rhs)
    if (tc) setOrInvalidate(tc)
  }

  // === Per-decl observation (called for each `let`/`const` `name = rhs`) ===
  const processDecl = (name, rhs) => {
    // wasm type (locals slice)
    const wt = exprType(rhs, locals)
    if (!locals.has(name)) locals.set(name, wt)
    else if (locals.get(name) === 'i32' && wt === 'f64') locals.set(name, 'f64')

    // val type (valTypes slice)
    trackVal(name, valTypeOf(rhs))

    // typed-array element ctor (typedElems slice)
    trackTyped(name, rhs)

    // arr-elem schema (arrElemSchemas slice) — schema bindings + array-literal init + alias + call return
    if (doSchemas) {
      const sid = exprSchemaId(rhs, localSchemaMap)
      if (sid != null) localSchemaMap.set(name, sid)
      {
        const rawElems = staticArrayElems(rhs)
        if (rawElems) {
          const elems = rawElems.filter(e => e != null)
          if (elems.length && elems.length === rawElems.length) {
            let common = exprSchemaId(elems[0], localSchemaMap)
            for (let k = 1; k < elems.length && common != null; k++) {
              if (exprSchemaId(elems[k], localSchemaMap) !== common) common = null
            }
            if (common != null) observeArrSchema(name, common)
          }
        }
      }
      if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
        const f = ctx.func.map?.get(rhs[1])
        if (f?.arrayElemSchema != null) observeArrSchema(name, f.arrayElemSchema)
      }
      if (typeof rhs === 'string' && arrElemSchemas.has(rhs)) {
        const sid2 = arrElemSchemas.get(rhs)
        if (sid2 != null) observeArrSchema(name, sid2)
      }
      if (typeof rhs === 'string') {
        const repSid = ctx.func.localReps?.get(rhs)?.arrayElemSchema
        if (repSid != null) observeArrSchema(name, repSid)
      }
    }

    // arr-elem val type (arrElemValTypes slice) — array-literal init + call return + alias + .map/.filter/.slice/.concat chain
    {
      const rawElems = staticArrayElems(rhs)
      if (rawElems) {
        const elems = rawElems.filter(e => e != null)
        if (elems.length && elems.length === rawElems.length) {
          let common = exprElemSourceVal(elems[0])
          for (let k = 1; k < elems.length && common != null; k++) {
            if (exprElemSourceVal(elems[k]) !== common) common = null
          }
          if (common != null) observeArrValType(name, common)
        }
      }
    }
    if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
      const f = ctx.func.map?.get(rhs[1])
      if (f?.arrayElemValType) observeArrValType(name, f.arrayElemValType)
    }
    if (typeof rhs === 'string') {
      const v = elemValOf(rhs)
      if (v) observeArrValType(name, v)
    }
    if (Array.isArray(rhs) && rhs[0] === '()' &&
        Array.isArray(rhs[1]) && rhs[1][0] === '.' &&
        typeof rhs[1][1] === 'string') {
      const recvName = rhs[1][1], method = rhs[1][2]
      if (method === 'filter' || method === 'slice' || method === 'concat') {
        const v = elemValOf(recvName)
        if (v) observeArrValType(name, v)
      } else if (method === 'split' && valTypeOf(recvName) === VAL.STRING) {
        observeArrValType(name, VAL.STRING)
      } else if (method === 'map') {
        const arrowFn = rhs[2]
        const recvVt = elemValOf(recvName)
        const param = Array.isArray(arrowFn) && arrowFn[0] === '=>' ? arrowFn[1] : null
        const paramName = typeof param === 'string' ? param :
          (Array.isArray(param) && param[0] === '()' && typeof param[1] === 'string' ? param[1] : null)
        const arrowBody = paramName ? arrowFn[2] : null
        const exprBody = (Array.isArray(arrowBody) && arrowBody[0] === '{}' &&
          Array.isArray(arrowBody[1]) && arrowBody[1][0] === 'return') ? arrowBody[1][1] : arrowBody
        if (paramName && exprBody != null) {
          const refs = ctx.func.refinements
          const hadParam = refs?.has(paramName)
          const prev = hadParam ? refs.get(paramName) : undefined
          if (refs && recvVt) refs.set(paramName, { val: recvVt })
          let bodyVt = null
          try { bodyVt = valTypeOf(exprBody) }
          finally {
            if (refs && recvVt) {
              if (hadParam) refs.set(paramName, prev); else refs.delete(paramName)
            }
          }
          if (bodyVt) observeArrValType(name, bodyVt)
        }
      }
    }
    if (Array.isArray(rhs) && rhs[0] === '()' &&
        Array.isArray(rhs[1]) && rhs[1][0] === '.' && rhs[1][2] === 'split' &&
        valTypeOf(rhs[1][1]) === VAL.STRING) {
      observeArrValType(name, VAL.STRING)
    }
  }

  // arrElem invalidation rule — fires on `=` reassign of tracked name to non-array
  const isArrayProducingRhs = (rhs) =>
    Array.isArray(rhs) && (staticArrayElems(rhs) != null ||
      (rhs[0] === '()' && Array.isArray(rhs[1]) && rhs[1][0] === '.' &&
       (rhs[1][2] === 'slice' || rhs[1][2] === 'concat')))

  const markEscape = (name) => { if (escapes.has(name)) escapes.set(name, true) }

  const isStaticIndex = (key) =>
    typeof key === 'number' || typeof key === 'string' ||
    (Array.isArray(key) && ((key[0] == null && Number.isInteger(key[1])) || key[0] === 'str')) ||
    staticPropertyKey(key) != null

  const markEscapeValue = (expr) => {
    if (typeof expr === 'string') { markEscape(expr); return }
    if (!Array.isArray(expr)) return
    const op = expr[0]
    if (op === 'str') return
    if (op === ':') { markEscapeValue(expr[2]); return }
    if ((op === '.' || op === '?.') && typeof expr[1] === 'string' && escapes.has(expr[1])) return
    if (op === '[]' && typeof expr[1] === 'string' && escapes.has(expr[1])) {
      if (!isStaticIndex(expr[2])) markEscape(expr[1])
      markEscapeValue(expr[2])
      return
    }
    for (let i = 1; i < expr.length; i++) markEscapeValue(expr[i])
  }

  const markEscapeArgs = (args) => {
    if (args == null) return
    const list = Array.isArray(args) && args[0] === ',' ? args.slice(1) : [args]
    for (const a of list) markEscapeValue(Array.isArray(a) && a[0] === '...' ? a[1] : a)
  }

  // === Single walk ===
  function walk(node) {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return  // don't cross closure boundary

    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const a = node[i]
        // analyzeBody: bare-name decl
        if (typeof a === 'string') { if (!locals.has(a)) locals.set(a, 'f64'); continue }
        if (!Array.isArray(a) || a[0] !== '=') continue
        // analyzeBody: destructuring decl — set destructured names to f64, walk rhs only
        if (typeof a[1] !== 'string') {
          for (const n of collectParamNames([a[1]])) if (!locals.has(n)) locals.set(n, 'f64')
          walk(a[2])
          continue
        }
        const name = a[1], rhs = a[2]
        processDecl(name, rhs)
        if (Array.isArray(rhs) && (rhs[0] === '[' || rhs[0] === '{}')) {
          escapes.set(name, false)
        }
        markEscapeValue(rhs)
        // Walk rhs only — never enter the `=` node so the reassignment-invalidation
        // rule won't misfire on the binding's own initializer.
        walk(rhs)
      }
      return
    }

    if (op === 'return' && node[1] != null) {
      markEscapeValue(node[1])
    }

    if (op === '()' && node.length > 2) {
      markEscapeArgs(node[2])
    }

    // arr.push(...) — observe both schemas and val types in one pass
    if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' && node[1][2] === 'push' && typeof node[1][1] === 'string') {
      const arr = node[1][1]
      const list = commaList(node[2])
      for (const a of list) {
        if (Array.isArray(a) && a[0] === '...') {
          observeArrSchema(arr, null); observeArrValType(arr, null); continue
        }
        observeArrSchema(arr, exprSchemaId(a, localSchemaMap))
        observeArrValType(arr, exprElemSourceVal(a))
      }
    }

    // `=` reassignment — locals widen, valTypes/typedElems track,
    // arrElemSchemas/ValTypes invalidate when rhs isn't array-producing.
    if (op === '=' && typeof node[1] === 'string') {
      const name = node[1], rhs = node[2]
      walk(rhs)
      markEscape(name)
      markEscapeValue(rhs)
      const wt = exprType(rhs, locals)
      if (locals.has(name) && locals.get(name) === 'i32' && wt === 'f64') locals.set(name, 'f64')
      trackVal(name, valTypeOf(rhs))
      trackTyped(name, rhs)
      if (arrElemSchemas.has(name) && !isArrayProducingRhs(rhs)) observeArrSchema(name, null)
      if (arrElemValTypes.has(name) && !isArrayProducingRhs(rhs)) observeArrValType(name, null)
      return
    }

    // compound-assign widening (locals slice)
    if ((op === '+=' || op === '-=' || op === '*=' || op === '%=') && typeof node[1] === 'string') {
      const name = node[1], opChar = op[0]
      const t = exprType([opChar, node[1], node[2]], locals)
      if (locals.has(name) && locals.get(name) === 'i32' && t === 'f64') locals.set(name, 'f64')
    }
    if (op === '/=' && typeof node[1] === 'string') {
      if (locals.has(node[1])) locals.set(node[1], 'f64')
    }

    if (op === 'for' || op === 'for-in' || op === 'for-of') {
      if (node[1] != null) markEscapeValue(node[1])
    }

    if (op === '[' || op === '{}') {
      for (let i = 1; i < node.length; i++) {
        const c = node[i]
        if (Array.isArray(c) && c[0] === ',') {
          for (let j = 1; j < c.length; j++) {
            if (Array.isArray(c[j]) && c[j][0] === '...') markEscapeValue(c[j][1])
          }
        } else if (Array.isArray(c) && c[0] === '...') {
          markEscapeValue(c[1])
        }
      }
    }

    if (op === '[]' && typeof node[1] === 'string' && escapes.has(node[1])) {
      const key = node[2]
      if (!isStaticIndex(key)) markEscape(node[1])
    }

    for (let i = 1; i < node.length; i++) walk(node[i])
  }

  // Install the in-progress valTypes as a lookup overlay so successive decls
  // resolve chains (`const a = new TypedArr(); const b = a[0]` → b: NUMBER)
  // and shorthand-bound `{a}` props see a's type. Restored after walk completes.
  const prevOverlay = ctx.func.localValTypesOverlay
  const prevTypedOverlay = ctx.func.localTypedElemsOverlay
  ctx.func.localValTypesOverlay = valTypes
  ctx.func.localTypedElemsOverlay = typedElems
  let unsignedLocals
  try {
    walk(body)

    // Second pass: widen i32 locals compared against f64 — EXCEPT integer counters
    // used as affine array indices, which provably stay in i32 range (see
    // collectI32SafeIndexVars). Keeping those i32 gives direct indexing with no
    // per-access trunc_sat; the compare coerces the counter to f64 instead. A
    // genuinely-fractional counter (`i = i / 3`) is still widened by the assignment
    // fixpoint below, which runs after this pass and overrides the i32 decision.
  const i32SafeIdx = collectI32SafeIndexVars(body, locals)
  const CMP_OPS = new Set(['<', '>', '<=', '>=', '==', '!='])
  function widenPass(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (CMP_OPS.has(op)) {
      const [a, b] = args
      const ta = exprType(a, locals), tb = exprType(b, locals)
      if (ta === 'i32' && tb === 'f64' && typeof a === 'string' && locals.has(a) && !i32SafeIdx.has(a)) locals.set(a, 'f64')
      if (tb === 'i32' && ta === 'f64' && typeof b === 'string' && locals.has(b) && !i32SafeIdx.has(b)) locals.set(b, 'f64')
    }
    if (op !== '=>') for (const a of args) widenPass(a)
  }
  widenPass(body)

  // Re-resolve let-decl RHS types now that widenPass has widened. A `let x2 =
  // zx*zx` declared at i32 because zx was i32 at scan time must widen if zx
  // was later re-typed to f64. Without this, integer-init locals shadowed
  // by f64-arithmetic RHSs end up with `i32.trunc_sat_f64_s` truncating the
  // fractional value (e.g. mandelbrot escape: `x2 = zx*zx` losing 3.515 → 3).
  // Also re-checks `=` and compound-assign reassignments — single-pass walk
  // visits each assign once with stale operand types, missing widens through
  // back-edges (`iy = 2.0 * ix * iy + 1.0` where `ix` widens later in the loop
  // body, demanding `iy` widen on the next iteration).
  // Monotonic: only widens i32 → f64. Bound by locals count so no infinite loop.
  let widened = true
  while (widened) {
    widened = false
    const recheck = (node) => {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === '=>') return
      if (op === 'let' || op === 'const') {
        for (let i = 1; i < node.length; i++) {
          const a = node[i]
          if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') {
            const name = a[1], rhs = a[2]
            if (locals.get(name) === 'i32' && exprType(rhs, locals) === 'f64') {
              locals.set(name, 'f64'); widened = true
            }
          }
        }
      }
      if (op === '=' && typeof node[1] === 'string') {
        const name = node[1], rhs = node[2]
        if (locals.get(name) === 'i32' && exprType(rhs, locals) === 'f64') {
          locals.set(name, 'f64'); widened = true
        }
      }
      if ((op === '+=' || op === '-=' || op === '*=' || op === '%=') && typeof node[1] === 'string') {
        const name = node[1]
        if (locals.get(name) === 'i32' && exprType([op[0], name, node[2]], locals) === 'f64') {
          locals.set(name, 'f64'); widened = true
        }
      }
      if (op === '/=' && typeof node[1] === 'string') {
        const name = node[1]
        if (locals.get(name) === 'i32') { locals.set(name, 'f64'); widened = true }
      }
      for (let i = 1; i < node.length; i++) recheck(node[i])
    }
    recheck(body)
  }

  // Narrow proven uint32 accumulator locals to unsigned i32. Runs post-widen so
  // a local already demoted to f64 above (e.g. compared against an f64) is
  // reconsidered with final types — and stays f64, since a relational compare
  // is a non-transparent read that disqualifies narrowing anyway.
  unsignedLocals = narrowUint32(body, locals)
} finally {
    ctx.func.localValTypesOverlay = prevOverlay
    ctx.func.localTypedElemsOverlay = prevTypedOverlay
  }

  // SRoA: dissolve non-escaping object-literal bindings into field locals.
  // The dead `o` local is dropped — every `o` reference is rewritten by the
  // codegen flat hooks, so a stray `local.get $o` becomes a loud wasm
  // validation error instead of a silent miscompile.
  const flatObjects = doSchemas ? scanFlatObjects(body) : new Map()
  for (const [name, props] of flatObjects) {
    for (let i = 0; i < props.names.length; i++) locals.set(`${name}#${i}`, 'f64')
    locals.delete(name)
  }

  // No-copy slice views — `let t = s.slice(...)` bindings proven non-escaping.
  // Consumed by emitDecl, which lowers the initializer to a SLICE_BIT view.
  const sliceViews = doSchemas ? scanSliceViews(body) : new Set()

  const result = { locals, valTypes, arrElemSchemas, arrElemValTypes, typedElems, escapes, flatObjects, sliceViews, unsignedLocals }
  _bodyFactsCache.set(body, result)
  return result
}

/** Drop the cached analyzeBody entry for this body. Used by emitFunc after
 *  seeding cross-call param VAL facts so the next walk picks up fresh
 *  `ctx.func.localReps` (drives exprType receiver-type lookups).
 *  Same hook as `invalidateValTypesCache` — split names preserve caller intent. */
export function invalidateLocalsCache(body) {
  if (body && typeof body === 'object') _bodyFactsCache.delete(body)
}

/** @deprecated alias — same invalidation as `invalidateLocalsCache`. */

/**
 * Analyze all local value types from declarations and assignments.
 * Writes the per-name `val` field of `ctx.func.localReps` for method dispatch
 * and schema resolution.
 */
export function analyzeValTypes(body) {
  const valPoison = new Set()
  const setVal = (name, vt) => {
    if (valPoison.has(name)) return
    const prev = ctx.func.localReps?.get(name)?.val
    if (!vt) {
      if (prev) valPoison.add(name)
      updateRep(name, { val: undefined })
      return
    }
    if (prev && prev !== vt) {
      valPoison.add(name)
      updateRep(name, { val: undefined })
      return
    }
    updateRep(name, { val: vt })
  }
  const getVal = name => ctx.func.localReps?.get(name)?.val
  // Pre-walk: observe Array<schema> facts so `const p = arr[i]` can bind a schemaId
  // on `p`, unlocking schema slot reads + skipping str_key dispatch on `.prop` access.
  // Parallel arrElemValTypes walk records VAL.* element kinds into
  // rep.arrayElemValType so valTypeOf's `arr[i]` rule can elide __to_num and route
  // method dispatch on `arr[i].method()`. Both come from a single unified walk.
  const facts = analyzeBody(body)
  const arrElems = facts.arrElemSchemas
  for (const [name, vt] of facts.arrElemValTypes) {
    if (vt != null) updateRep(name, { arrayElemValType: vt })
  }
  // Propagate body-observed array-elem schemas to localReps so unboxablePtrs's
  // `let p = arr[i]` rule (which only consults rep) sees the schema and can unbox `p`
  // to an i32 offset. Without this, `arr.push({x,y,z})` followed by `arr[i].x` reads
  // pay an i64.reinterpret/i32.wrap on every slot access (no aliasing → CSE can't fold).
  for (const [name, sid] of arrElems) {
    if (sid != null) updateRep(name, { arrayElemSchema: sid })
  }
  // Resolve a name's array-elem-schema, preferring rep.arrayElemSchema (set from
  // paramReps[k].arrayElemSchema at emit start) over local body observations.
  const arrElemSchemaOf = (name) => {
    if (typeof name !== 'string') return null
    const repSid = ctx.func.localReps?.get(name)?.arrayElemSchema
    if (repSid != null) return repSid
    const localSid = arrElems.get(name)
    return localSid != null ? localSid : null
  }
  function trackRegex(name, rhs) {
    if (ctx.runtime.regex && Array.isArray(rhs) && rhs[0] === '//') ctx.runtime.regex.vars.set(name, rhs)
  }
  // Names whose decls disagree on element ctor (e.g. two `let arr = ...` decls
  // in different scopes — jz hoists `let` to function scope so they share a name).
  // Once invalidated, no later setter can re-establish a definite ctor.
  const typedPoison = new Set()
  const invalidate = (name) => {
    typedPoison.add(name)
    ctx.types.typedElem?.delete(name)
  }
  function trackTyped(name, rhs) {
    if (!ctx.types.typedElem) ctx.types.typedElem = new Map() // first use in this function scope
    if (typedPoison.has(name)) return
    const setOrInvalidate = (c) => {
      if (c === MIXED_CTORS) return invalidate(name)
      const prev = ctx.types.typedElem.get(name)
      if (prev && prev !== c) invalidate(name)
      else ctx.types.typedElem.set(name, c)
    }
    const ctor = typedElemCtor(rhs)
    if (ctor) return setOrInvalidate(ctor)
    // TYPED-narrowed call result carries elem aux on f.sig.ptrAux — reverse-map it
    // back to a canonical ctor string so unboxablePtrs's typedElemAux lookup
    // (compile.js) restores the same aux on the unboxed local's rep.
    if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
      const f = ctx.func.map?.get(rhs[1])
      if (f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null) {
        const c = ctorFromElemAux(f.sig.ptrAux)
        if (c) setOrInvalidate(c)
      }
      return
    }
    // Heterogeneous ternary (e.g. `n === 16 ? new Uint8Array(16) : new Uint16Array(8)`):
    // typedElemCtor returns null for `?:`. When branches don't unify to the same ctor,
    // poison the name so a later sibling-scope decl (jz hoists `let` to function scope)
    // can't lock in the wrong store width.
    const tc = ternaryCtorOfRhs(rhs)
    if (tc) setOrInvalidate(tc)
  }
  // Total write count for `name` across the whole body, recursing into nested
  // closures so a closure that reassigns the var is also counted. Capped at 2 —
  // callers only need the "exactly one write" verdict.
  function writeCount(node, name, n) {
    if (n > 1 || !Array.isArray(node)) return n
    const o = node[0]
    if ((ASSIGN_OPS.has(o) || o === '++' || o === '--') && node[1] === name) n++
    if (o === 'let' || o === 'const') {
      for (let i = 1; i < node.length && n <= 1; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && d[2] != null) n = writeCount(d[2], name, n)
      }
      return n
    }
    for (let i = 1; i < node.length && n <= 1; i++) n = writeCount(node[i], name, n)
    return n
  }
  // Bind an object-literal's schemaId onto its holding local's rep so that
  // `o.prop` / `o.method()` dispatch is precise instead of falling back to
  // structural subtyping (which mis-resolves when another in-scope object
  // shares a member at a different slot). `shapeOf` already covers plain-data
  // literals on a direct `let o = {…}` decl, but not literals with
  // function-valued props — and `var o = {…}` is rewritten by jzify into
  // `let o; o = {…}`, so the schemaId never reaches `o` either way.
  // `expectWrites` is the reassignment count that marks `o` single-assignment:
  // 1 for the jzify `=` form (the synthesized assignment IS the only write),
  // 0 for a direct `let`/`const` decl (the initializer is not counted as a
  // write). A polymorphically reassigned holder keeps dynamic dispatch.
  // A name already in `ctx.schema.vars` carries a prepare-phase schema
  // (Object.assign merge via `inferAssignSchema`, destructure tracking) that
  // supersedes the bare-literal one — binding here would shadow the merged
  // schema (rep schemaId wins over `ctx.schema.vars` in `idOf`).
  function bindObjSchema(name, rhs, expectWrites = 1) {
    if (ctx.func.current?.params?.some(p => p.name === name)) return
    if (ctx.schema.vars?.has(name)) return
    const sid = objLiteralSchemaId(rhs)
    if (sid != null && writeCount(body, name, 0) === expectWrites) updateRep(name, { schemaId: sid })
  }
  function walk(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return  // don't leak inner-closure val types
    // Propagate typed array type through method calls (e.g. buf.map → typed)
    function propagateTyped(name, rhs) {
      if (!Array.isArray(rhs) || rhs[0] !== '()') return
      const callee = rhs[1]
      if (!Array.isArray(callee) || callee[0] !== '.') return
      const src = callee[1], method = callee[2]
      if (typeof src === 'string' && getVal(src) === VAL.TYPED && method === 'map') {
        setVal(name, VAL.TYPED)
        if (ctx.types.typedElem?.has(src)) {
          const srcCtor = ctx.types.typedElem.get(src)
          ctx.types.typedElem.set(name, srcCtor.endsWith('.view') ? srcCtor.slice(0, -5) : srcCtor)
        }
      }
    }
    if (op === 'let' || op === 'const') {
      for (const a of args) {
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') continue
        const vt = valTypeOf(a[2])
        setVal(a[1], vt)
        if (vt === VAL.REGEX) trackRegex(a[1], a[2])
        // VAL gate covers definite-typed RHS; `?:`/`&&`/`||` slip through valTypeOf
        // returning null but may still need ctor unification (or poisoning when
        // branches disagree, since jz hoists `let` to function scope).
        if (vt === VAL.TYPED || vt === VAL.BUFFER || isCondExpr(a[2])) trackTyped(a[1], a[2])
        propagateTyped(a[1], a[2])
        // JSON-shape propagation. When the RHS resolves to a known JSON shape
        // (root: `JSON.parse(literal)`; nested: `o.meta`, `items[j]` from a known
        // root), record it on the binding so subsequent `.prop`/`[i]` accesses
        // skip dynamic dispatch and propagate VAL kinds. Generic for any
        // compile-time JSON literal.
        const sh = shapeOf(a[2])
        if (sh) {
          updateRep(a[1], { jsonShape: sh })
          if (sh.val === VAL.ARRAY && sh.elem?.val) {
            updateRep(a[1], { arrayElemValType: sh.elem.val })
            // Array of fixed-shape OBJECTs: register elem schema so `it = items[j]`
            // → `it.prop` lowers to slot read via the existing arr-elem-schema path.
            if (sh.elem.val === VAL.OBJECT && sh.elem.names && ctx.schema.register) {
              const elemSid = ctx.schema.register(sh.elem.names)
              updateRep(a[1], { arrayElemSchema: elemSid })
            }
          }
          if (sh.val === VAL.OBJECT && sh.names && ctx.schema.register) {
            const sid = ctx.schema.register(sh.names)
            updateRep(a[1], { schemaId: sid })
            ctx.schema.vars.set(a[1], sid)
          }
        }
        // `shapeOf` misses object literals with function-valued props; bind
        // their schemaId here so number-hint ToPrimitive (valueOf/toString slot
        // dispatch) resolves. expectWrites=0: a decl initializer is not a write.
        if (vt === VAL.OBJECT) bindObjSchema(a[1], a[2], 0)
        // Propagate schemaId from a narrowed call result so subsequent valTypeOf
        // calls in this function body see the precise schema. emitDecl rebinds
        // this at emission time too — analyze-time binding is what unlocks the
        // slotVT lookup chain in `analyzeValTypes`'s own walk + per-func emit
        // dispatch reading localReps.
        if (vt === VAL.OBJECT && Array.isArray(a[2]) && a[2][0] === '()' && typeof a[2][1] === 'string') {
          const f = ctx.func.map?.get(a[2][1])
          if (f?.sig?.ptrAux != null) updateRep(a[1], { schemaId: f.sig.ptrAux })
        }
        // `const p = arr[i]` — when arr's element schema is known (from .push observations
        // or from paramReps arrayElemSchema binding), p inherits the schema. Unlocks slotVT-driven
        // numeric typing on `.prop` reads + slot-direct loads.
        if (Array.isArray(a[2]) && a[2][0] === '[]' && typeof a[2][1] === 'string') {
          const elemSid = arrElemSchemaOf(a[2][1])
          if (elemSid != null) {
            updateRep(a[1], { schemaId: elemSid })
            // Also set the val so structural call dispatch + valTypeOf see VAL.OBJECT.
            setVal(a[1], VAL.OBJECT)
          }
        }
      }
    }
    if (op === '=' && typeof args[0] === 'string') {
      walk(args[1])
      const vt = valTypeOf(args[1])
      setVal(args[0], vt)
      if (vt === VAL.REGEX) trackRegex(args[0], args[1])
      if (vt === VAL.TYPED || vt === VAL.BUFFER || isCondExpr(args[1])) trackTyped(args[0], args[1])
      propagateTyped(args[0], args[1])
      if (vt === VAL.OBJECT) bindObjSchema(args[0], args[1])
      return
    }
    // Track property assignments for auto-boxing: x.prop = val
    if (op === '=' && Array.isArray(args[0]) && args[0][0] === '.' && typeof args[0][1] === 'string') {
      const [, obj, prop] = args[0]
      const vt = getVal(obj)
      if ((vt === VAL.NUMBER || vt === VAL.BIGINT) && ctx.func.locals?.has(obj) && ctx.schema.register) {
        if (!ctx.func.localProps) ctx.func.localProps = new Map()
        if (!ctx.func.localProps.has(obj)) ctx.func.localProps.set(obj, new Set())
        ctx.func.localProps.get(obj).add(prop)
      }
    }
    for (const a of args) walk(a)
  }
  walk(body)

  // Register boxed schemas for local variables with property assignments
  if (ctx.func.localProps) {
    for (const [name, props] of ctx.func.localProps) {
      if (ctx.schema.vars.has(name)) continue
      const schema = ['__inner__', ...props]
      const sid = ctx.schema.register(schema)
      ctx.schema.vars.set(name, sid)
      updateRep(name, { schemaId: sid })
    }
  }
}

/** Forward-propagate `intCertain` on local bindings. Fixpoint lives in type.js. */
export function analyzeIntCertain(body) {
  for (const [name, intC] of intCertainMap(body)) {
    if (intC) updateRep(name, { intCertain: true })
  }
}

// A directly-uint32 expression: `x >>> 0` (zero-fill shift) or a call to a function
// already proven `unsignedResult`. Such a value lives in i32 but ranges [0, 2^32),
// so signed i32 ops on it are wrong — exprType widens its arithmetic to f64 to
// match emit (which reboxes via `f64.convert_i32_u`). Unsignedness through a local
// assignment is intentionally not tracked here — kept in lockstep with narrow.js's
// `isUnsignedTail`, so emit and exprType agree (no trunc_sat saturation).

// `analyzeBody` was inlined to `analyzeBody(body).locals` at its three real
// call sites in src/compile.js and src/narrow.js — the one-line facade existed
// only as a historical surface and obscured the unified-walk relationship.

/**
 * Identify locals that can be stored as an unboxed i32 pointer offset instead of
 * a NaN-boxed f64. Static type is tracked out-of-band so reads skip `__ptr_offset`
 * and `__ptr_type` entirely and writes unbox once at the assignment site.
 *
 * Criteria — the local must be:
 *   - declared once with `let`/`const`, never reassigned or compound-assigned
 *   - valType is an unambiguous non-forwarding pointer kind:
 *       OBJECT, SET, MAP, CLOSURE, TYPED, BUFFER
 *     (excluded: ARRAY — forwards on realloc; STRING — SSO/heap dual encoding.)
 *   - initialized from a form that guarantees a fresh, non-null pointer of that VAL:
 *       OBJECT ← `{…}`
 *       SET    ← `new Set(...)`
 *       MAP    ← `new Map(...)`
 *       CLOSURE← `=>` literal
 *       BUFFER ← `new ArrayBuffer(...)`
 *       TYPED  ← `new XxxArray(...)` / method returning typed array
 *                (`new DataView(...)` is TYPED but stays boxed — no elem aux)
 *   - not captured in boxed storage (boxed locals stay f64 for the heap slot)
 *   - never compared to null/undefined (we lose the nullish NaN representation)
 *
 * Returns Map<name, VAL> of locals to unbox.
 */
export function unboxablePtrs(body, locals, boxed) {
  const valOf = name => ctx.func.localReps?.get(name)?.val
  const UNBOXABLE_KINDS = new Set([VAL.OBJECT, VAL.SET, VAL.MAP, VAL.BUFFER, VAL.TYPED, VAL.CLOSURE, VAL.DATE])

  // RHS must produce a fresh, non-null pointer of the declared VAL kind.
  //   OBJECT  ← `{…}`
  //   CLOSURE ← `=>`
  //   SET/MAP/BUFFER/TYPED ← `new X(...)`
  // Validating the exact ctor→VAL match keeps the analysis tied to valTypeOf, so when
  // that helper grows (e.g. `Array.from` → ARRAY), we don't drift out of sync.
  const isFreshInit = (expr, kind) => {
    if (!Array.isArray(expr)) return false
    if (kind === VAL.OBJECT) {
      if (expr[0] === '{}') return true
      // Call to a narrow-ABI'd helper: returns i32 ptr-offset of the same VAL kind.
      // Unboxing skips the f64-rebox at the callsite. Verifying via sig (not just
      // valResult) ensures the call already produces an i32 — which dual-write picks
      // up to bind ptrKind/schemaId on the local.
      if (expr[0] === '()' && typeof expr[1] === 'string') {
        const f = ctx.func.map?.get(expr[1])
        return f?.sig?.ptrKind === kind
      }
      // `let p = arr[i]` where arr has a known elem schema: the runtime helper
      // returns f64 (NaN-box of an OBJECT pointer), but its low 32 bits are
      // exactly the pointer offset. Dual-write coerces once via reinterpret/wrap;
      // subsequent `p.x` reads then become direct `f64.load offset=K (local.get $p)`
      // (since ptrOffsetIR sees ptrKind=OBJECT and skips the per-access wrap).
      if (expr[0] === '[]' && typeof expr[1] === 'string') {
        const repSid = ctx.func.localReps?.get(expr[1])?.arrayElemSchema
        return repSid != null
      }
      return false
    }
    if (kind === VAL.CLOSURE) return expr[0] === '=>'
    if (expr[0] === '()' && typeof expr[1] === 'string') {
      const callee = expr[1]
      if (callee.startsWith('new.')) {
        if (kind === VAL.SET) return callee === 'new.Set'
        if (kind === VAL.MAP) return callee === 'new.Map'
        if (kind === VAL.DATE) return callee === 'new.Date'
        if (kind === VAL.BUFFER) return callee === 'new.ArrayBuffer'
        if (kind === VAL.TYPED) return callee.endsWith('Array') && callee !== 'new.ArrayBuffer'
      }
      // Call to narrow-ABI'd helper of matching VAL kind.
      const f = ctx.func.map?.get(callee)
      if (f?.sig?.ptrKind === kind) return true
    }
    // Method call returning TYPED: `arr.map(fn)` where `arr` is in typedElem
    // (locally TYPED with a known elem ctor). Only `.typed:map` is registered
    // as TYPED-returning — `.filter`/`.slice` fall back to ARRAY emit. The
    // typedElem.has(src) gate ensures we don't accept the polymorphic-receiver
    // path that emits a plain ARRAY result. propagateTyped already mirrored
    // the src ctor onto the receiver, so the unbox path picks up its aux.
    if (kind === VAL.TYPED && expr[0] === '()' &&
        Array.isArray(expr[1]) && expr[1][0] === '.' &&
        typeof expr[1][1] === 'string' && expr[1][2] === 'map' &&
        ctx.types.typedElem?.has(expr[1][1])) {
      return true
    }
    return false
  }
  // A policy over `scanBindingUses`: an UNBOXABLE-kind `let/const` local with a
  // fresh-pointer initializer stays unboxable unless some use forbids it. The
  // only forbidding uses are a reassignment (`=`/compound/`++`/`--`) or a
  // null/undefined comparison (an unboxed pointer has no nullish NaN form).
  // Closure captures do not disqualify — a capture-*mutated* local is already
  // in `boxed`, and a capture-*read* leaves the pointer in its own slot.
  const result = new Map()
  for (const [name, s] of scanBindingUses(body)) {
    const vt = valOf(name)
    if (!UNBOXABLE_KINDS.has(vt)) continue
    if (locals.get(name) !== 'f64') continue
    if (boxed?.has(name)) continue
    if (!isFreshInit(s.initRhs, vt)) continue
    const ok = s.uses.every(u =>
      u.kind !== USE.REASSIGN && !(u.kind === USE.COMPARE && u.nullCmp))
    if (ok) result.set(name, vt)
  }
  return result
}

/**
 * CSE-safe load bases — `let/const` pointer locals whose `(f64.load offset=K $X)`
 * reads `cseScalarLoad` (src/optimize.js) may scalar-replace without a store
 * clobbering them. `cseScalarLoad` is module-wide disabled because it scanned
 * *every* i32 local; a store through an i32 local legitimately aliasing the load
 * base returned stale bytes. This pass is the missing soundness gate: a
 * per-function whitelist, each entry proven non-aliasing — guarantee, not guess.
 *
 * `X` qualifies iff ALL hold:
 *  (a) X is an unboxed pointer — `localReps.get(X).ptrKind` set, `locals[X]==='i32'`.
 *  (b) X is bound exactly once (no re-decl, no `=`/`++`/`--`/compound reassign).
 *  (c) Every occurrence of X is the receiver of a `.`/`?.`/`[]` *read* — never a
 *      write target, never a bare value (alias / arg / return / stored element),
 *      never captured by a closure. So X's pointer lives only in `$X`; nothing
 *      else holds it, and no store names it.
 *  (d) The allocation X's bytes live in is disjoint from every store target.
 *      jz allocations carry one kind each and distinct kinds never share bytes,
 *      so X is store-safe when every store's base has a determinable kind ≠ X's
 *      source kind. Any indeterminable store target disqualifies the whole set
 *      (a store through unknown memory could alias anything).
 *
 * (c)+(d): no store in the function can touch a cell reachable via `$X + K`, so
 * a load on `$X` is invariant between two control-flow boundaries — exactly
 * `cseScalarLoad`'s straight-line region model. Method-call mutations (`.push`,
 * …) need no accounting here: the pass already flushes its table on every call.
 *
 * Returns `Set<name>` — names only, no `$` prefix (the caller stamps it).
 */
export function cseSafeLoadBases(body, locals, localReps) {
  if (body === null || typeof body !== 'object') return new Set()

  // Allocation kind a pointer name's bytes live in: ptrKind (unboxed) wins,
  // else value-kind, else an array-schema'd binding is an ARRAY, else unknown.
  const kindOf = (name) => {
    if (typeof name !== 'string') return null
    const r = localReps?.get(name)
    return r?.ptrKind || r?.val || (r?.arrayElemSchema != null ? VAL.ARRAY : null) ||
      ctx.scope.globalValTypes?.get(name) || null
  }
  // X's bytes live in: the array/object an element read drew it from
  // (`X = src[i]` / `X = src.f`), else a fresh `{}`/`new` (X's own kind).
  const srcKind = (rhs) =>
    Array.isArray(rhs) && (rhs[0] === '[]' || rhs[0] === '.' || rhs[0] === '?.') &&
      typeof rhs[1] === 'string' ? kindOf(rhs[1]) : valTypeOf(rhs)

  // Pass 1 — bound-once unboxed-pointer candidates; record each source kind.
  const cand = new Map()                 // name → source allocation kind
  const declCount = new Map()
  const collect = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const a = node[i]
        if (typeof a === 'string') { declCount.set(a, (declCount.get(a) || 0) + 1); continue }
        if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') {
          const name = a[1]
          declCount.set(name, (declCount.get(name) || 0) + 1)
          if (localReps?.get(name)?.ptrKind != null && locals.get(name) === 'i32')
            cand.set(name, srcKind(a[2]))
          collect(a[2])
        } else collect(a)
      }
      return
    }
    for (let i = 1; i < node.length; i++) collect(node[i])
  }
  collect(body)
  for (const [n, c] of declCount) if (c > 1) cand.delete(n)
  if (!cand.size) return new Set()

  // Pass 2 — every occurrence must be a `.`/`?.`/`[]` read receiver (c).
  const live = new Set(cand.keys())
  const walk = (node, inClosure) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'str') return
    const closured = inClosure || op === '=>'
    if (op === 'let' || op === 'const') {        // decl `=` — bound name is not a use
      for (let i = 1; i < node.length; i++) {
        const a = node[i]
        if (typeof a === 'string') continue
        if (Array.isArray(a) && a[0] === '=') {
          if (typeof a[1] !== 'string') walk(a[1], closured)
          walk(a[2], closured)
        } else walk(a, closured)
      }
      return
    }
    if (op === '.' || op === '?.' || op === '[]') {   // member READ — receiver is safe
      const o = node[1]
      if (typeof o === 'string') { if (inClosure && cand.has(o)) live.delete(o) }
      else walk(o, closured)
      if (op === '[]' && node[2] != null) walk(node[2], closured)
      return
    }
    if (ASSIGN_OPS.has(op) || op === '++' || op === '--' || op === 'delete') {
      const t = node[1]                            // write target — X here disqualifies
      if (typeof t === 'string') { if (cand.has(t)) live.delete(t) }
      else if (Array.isArray(t) && (t[0] === '.' || t[0] === '?.' || t[0] === '[]') &&
               typeof t[1] === 'string' && cand.has(t[1])) live.delete(t[1])
      else walk(t, closured)
      for (let i = 2; i < node.length; i++) walk(node[i], closured)
      return
    }
    for (let i = 1; i < node.length; i++) {        // any other position — bare X escapes
      const c = node[i]
      if (typeof c === 'string') { if (cand.has(c)) live.delete(c) }
      else walk(c, closured)
    }
  }
  walk(body, false)
  if (!live.size) return live

  // Pass 3 — store-target disjointness (d). A store lands in `base`'s allocation.
  let unknownStore = false
  const storeKinds = new Set()
  const scanStores = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if ((ASSIGN_OPS.has(op) || op === '++' || op === '--') && Array.isArray(node[1]) &&
        (node[1][0] === '.' || node[1][0] === '?.' || node[1][0] === '[]') &&
        typeof node[1][1] === 'string') {
      const k = kindOf(node[1][1])
      if (k == null) unknownStore = true
      else storeKinds.add(k)
    }
    for (let i = 1; i < node.length; i++) scanStores(node[i])
  }
  scanStores(body)
  if (unknownStore) return new Set()

  const safe = new Set()
  for (const name of live) {
    const k = cand.get(name)
    if (k != null && !storeKinds.has(k)) safe.add(name)
  }
  return safe
}


/**
 * Whole-program SRoA eligibility — decides which object schemas may back an
 * `Array<S>` with the `structInline` carrier (the K f64 schema fields inlined
 * per element, no per-row heap object). Writes `ctx.schema.inlineArray:
 * Set<sid>`, read by the array push / index / length codegen.
 *
 * Default-disqualify: a schema is inlinable only when *every* observed use of
 * every `Array<S>` binding — across all user functions and module inits — is
 * one the structInline codegen handles. A missed or unrecognized use poisons
 * the schema, so the worst outcome is a lost optimization, never a stride
 * mismatch (miscompile).
 *
 * Handled uses of an `Array<S>` binding `a`:
 *   - decl/reassign from `[]` (empty), a call returning `Array<S>`, or an alias
 *   - `a.push({S-literal})`        — struct push (K-cell store)
 *   - `a.length`                  — physical len / K
 *   - `a[i]` consumed as `const p = a[i]` cursor, or directly `a[i].field`
 *   - `a` passed where the callee param is `Array<S>` (paramReps agreement)
 *   - `return a` when the enclosing function returns `Array<S>`
 * A cursor `p` (`const p = a[i]`) may only be read/written as `p.field`.
 * Anything else — bare ref, value escape, other array method, `a[i] = …`
 * element-replace — poisons S.
 *
 * Reads codegen truth: a binding is `Array<S>` iff its settled rep
 * (`funcFacts.get(func).localReps`) carries `arrayElemSchema = S` — the exact
 * map the emitter consults — so the analysis and the emitter never disagree on
 * which bindings are inline-carried.
 *
 * Conservative corners (sound, give up the optimization): closures and module
 * inits are not walked in detail — any schema reachable as a `.push({S})`
 * argument, an `Array<S>`-returning call, an `[{S}, …]` literal, or a captured
 * tracked array inside one is poisoned.
 */
export function analyzeStructInline(funcFacts, programFacts) {
  const inlineArray = ctx.schema?.inlineArray
  if (!inlineArray || !ctx.schema?.list) return
  const { paramReps } = programFacts
  const cand = new Set()      // sids observed as an `Array<S>` element schema
  const black = new Set()     // sids disqualified by some use

  const propsOf = (sid) => ctx.schema.list[sid] || []
  const inSchema = (sid, p) => typeof p === 'string' && propsOf(sid).includes(p)
  const isStrLit = (k) => Array.isArray(k) && k[0] === 'str' && typeof k[1] === 'string'

  // Argument list of a `['()', callee, argNode]` call node.
  const argsOf = (node) => {
    const a = node[2]
    return a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
  }

  // `name` referenced anywhere as a value (skips `:`/`.` property-name slots).
  const mentions = (node, name) => {
    if (typeof node === 'string') return node === name
    if (!Array.isArray(node)) return false
    const op = node[0]
    if (op === 'str') return false
    if (op === ':') return mentions(node[2], name)
    if (op === '.' || op === '?.') return mentions(node[1], name)
    for (let i = 1; i < node.length; i++) if (mentions(node[i], name)) return true
    return false
  }

  // Poison every schema whose `Array<S>` could materialize inside an un-walked
  // subtree (closure body / module init): `.push({S})` args, `Array<S>`-returning
  // calls, `[{S}, …]` array literals. Standalone `{S}` objects are independent
  // of array layout and intentionally left alone.
  const poisonAll = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '()') {
      const callee = node[1]
      if (typeof callee === 'string') {
        const sid = ctx.func.map?.get(callee)?.arrayElemSchema
        if (sid != null) black.add(sid)
      } else if (Array.isArray(callee) && callee[0] === '.' && callee[2] === 'push') {
        for (const a of argsOf(node)) {
          const sid = objLiteralSchemaId(a)
          if (sid != null) black.add(sid)
        }
      }
    } else if (op === '[' || op === '[]') {
      for (const el of staticArrayElems(node) || []) {
        const sid = objLiteralSchemaId(el)
        if (sid != null) black.add(sid)
      }
    }
    for (let i = 1; i < node.length; i++) poisonAll(node[i])
  }

  for (const [func, facts] of funcFacts) {
    const body = func?.body
    const reps = facts?.localReps
    if (func?.raw || !reps || body == null || typeof body !== 'object') continue

    // `Array<S>` bindings of this function (codegen truth) and their schemas.
    const arrName = new Map()       // name → sid
    for (const [name, r] of reps) {
      const sid = r?.arrayElemSchema
      if (sid == null) continue
      if ((propsOf(sid).length || 0) < 1) continue   // K=0 — not inlinable
      cand.add(sid)
      arrName.set(name, sid)
    }
    if (!arrName.size) continue

    // A structInline `Array<S>` value is only ever born from an empty `[]`
    // grown by structInline `.push`. `expr` is such a producer of `Array<sid>`
    // iff it is: a tracked `Array<sid>` alias, an empty `[]` literal, or a call
    // to a user function (whose returned array is structInline whenever sid
    // survives this whole-program pass). Every other source — a non-empty
    // `[{S},…]` literal, a builtin call (`JSON.parse`, `Object.values`, `.map`,
    // `.slice`, a member access onto a parsed object) — yields a taggedLinear
    // array and must poison sid.
    const safeArrSource = (expr, sid) => {
      if (typeof expr === 'string') return arrName.get(expr) === sid
      if (!Array.isArray(expr)) return false
      const elems = staticArrayElems(expr)
      if (elems) return elems.length === 0
      return expr[0] === '()' && typeof expr[1] === 'string' && !!ctx.func.map?.has(expr[1])
    }

    // Pass 1 — collect `const p = a[i]` cursors; drop on name clash / re-decl.
    const cursor = new Map()        // name → sid
    const declSeen = new Set()
    const collectCursors = (node) => {
      if (!Array.isArray(node) || node[0] === '=>') return
      if (node[0] === 'let' || node[0] === 'const') {
        for (let i = 1; i < node.length; i++) {
          const d = node[i]
          if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
          const name = d[1], rhs = d[2]
          if (declSeen.has(name)) { const s = cursor.get(name); if (s != null) black.add(s) }
          declSeen.add(name)
          if (Array.isArray(rhs) && rhs[0] === '[]' && rhs.length === 3 &&
              typeof rhs[1] === 'string' && arrName.has(rhs[1]) && !isStrLit(rhs[2])) {
            const sid = arrName.get(rhs[1])
            if (cursor.has(name) || arrName.has(name)) black.add(sid)
            else cursor.set(name, sid)
          }
        }
      }
      for (let i = 1; i < node.length; i++) collectCursors(node[i])
    }
    collectCursors(body)

    // A `['[]', arrName, idx]` element read of a tracked array → its sid.
    const elemArrSid = (n) =>
      Array.isArray(n) && n[0] === '[]' && n.length === 3 &&
      typeof n[1] === 'string' && arrName.has(n[1]) && !isStrLit(n[2])
        ? arrName.get(n[1]) : null

    // Pass 2 — verify every occurrence is a structInline-handled use.
    const flag = (c) => {
      if (typeof c !== 'string') return false
      if (arrName.has(c)) { black.add(arrName.get(c)); return true }
      if (cursor.has(c)) { black.add(cursor.get(c)); return true }
      return false
    }
    const visitChild = (c) => { if (!flag(c)) verify(c) }

    function verify(node) {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'str') return
      if (op === '=>') {                       // closure — un-walked, poison
        for (const n of arrName.keys()) if (mentions(node, n)) black.add(arrName.get(n))
        for (const [n, s] of cursor) if (mentions(node, n)) black.add(s)
        poisonAll(node)
        return
      }
      if (op === ':') { visitChild(node[2]); return }

      if (op === '.' || op === '?.') {
        const o = node[1], p = node[2]
        if (typeof o === 'string') {
          if (arrName.has(o)) { if (!(op === '.' && p === 'length')) black.add(arrName.get(o)) }
          else if (cursor.has(o)) { if (!(op === '.' && inSchema(cursor.get(o), p))) black.add(cursor.get(o)) }
          return
        }
        const esid = elemArrSid(o)
        if (esid != null) {
          if (!(op === '.' && inSchema(esid, p))) black.add(esid)
          visitChild(o[2])
          return
        }
        visitChild(o)
        return
      }

      if (op === '[]') {
        const o = node[1], k = node[2]
        if (typeof o === 'string') {
          if (arrName.has(o)) black.add(arrName.get(o))   // element value escape
          else if (cursor.has(o)) { if (!(isStrLit(k) && inSchema(cursor.get(o), k[1]))) black.add(cursor.get(o)) }
          if (k != null) visitChild(k)
          return
        }
        const esid = elemArrSid(o)
        if (esid != null) {
          if (!(isStrLit(k) && inSchema(esid, k[1]))) black.add(esid)
          visitChild(o[2])
        } else if (o != null) visitChild(o)
        if (k != null) visitChild(k)
        return
      }

      // Reassignment of the array binding — the rhs must be a structInline
      // `Array<S>` producer; an alias is left un-walked (flagging it would
      // self-poison), other producers are walked to verify their subtree.
      if (op === '=' && typeof node[1] === 'string' && arrName.has(node[1])) {
        const sid = arrName.get(node[1])
        if (!safeArrSource(node[2], sid)) black.add(sid)
        else if (typeof node[2] !== 'string') visitChild(node[2])
        return
      }

      if (op === '()') {
        const callee = node[1]
        if (Array.isArray(callee) && callee[0] === '.') {
          const recv = callee[1], method = callee[2]
          if (typeof recv === 'string' && arrName.has(recv)) {
            const sid = arrName.get(recv)
            const args = argsOf(node)
            if (method !== 'push' || !args.length) black.add(sid)
            else for (const arg of args) {
              if (Array.isArray(arg) && arg[0] === '{}' && objLiteralSchemaId(arg) === sid) {
                for (let i = 1; i < arg.length; i++) {
                  const pr = arg[i]
                  visitChild(Array.isArray(pr) && pr[0] === ':' ? pr[2] : pr)
                }
              } else black.add(sid)
            }
            return
          }
          if (typeof recv === 'string' && cursor.has(recv)) { black.add(cursor.get(recv)); return }
          const esid = elemArrSid(recv)
          if (esid != null) { black.add(esid); visitChild(recv[2]) }
          else visitChild(recv)
          for (const a of argsOf(node)) visitChild(a)
          return
        }
        if (typeof callee === 'string') {
          const args = argsOf(node)
          const known = ctx.func.map?.has(callee)
          const cParams = paramReps?.get(callee)
          for (let k = 0; k < args.length; k++) {
            const arg = args[k]
            if (typeof arg === 'string' && arrName.has(arg)) {
              const sid = arrName.get(arg)
              if (!(known && cParams?.get(k)?.arrayElemSchema === sid)) black.add(sid)
            } else if (!flag(arg)) verify(arg)
          }
          return
        }
        visitChild(callee)
        for (const a of argsOf(node)) visitChild(a)
        return
      }

      if (op === 'return') {
        const e = node[1]
        if (typeof e === 'string') {
          if (arrName.has(e)) { if (func.arrayElemSchema !== arrName.get(e)) black.add(arrName.get(e)) }
          else flag(e)
          return
        }
        // A function typed `Array<S>` must return a structInline producer —
        // a non-empty literal / builtin call here yields a taggedLinear array.
        if (func.arrayElemSchema != null && !safeArrSource(e, func.arrayElemSchema))
          black.add(func.arrayElemSchema)
        const esid = elemArrSid(e)
        if (esid != null) { black.add(esid); visitChild(e[2]); return }
        if (e != null) visitChild(e)
        return
      }

      if (op === 'let' || op === 'const') {
        for (let i = 1; i < node.length; i++) {
          const d = node[i]
          if (!Array.isArray(d) || d[0] !== '=') { if (Array.isArray(d)) visitChild(d); continue }
          const name = d[1], rhs = d[2]
          if (typeof name === 'string' && cursor.has(name) &&
              Array.isArray(rhs) && rhs[0] === '[]') {
            if (rhs[2] != null) visitChild(rhs[2])   // cursor decl — verify index only
            continue
          }
          if (typeof name === 'string' && arrName.has(name)) {
            const sid = arrName.get(name)
            if (!safeArrSource(rhs, sid)) black.add(sid)               // non-structInline producer
            else if (typeof rhs !== 'string') visitChild(rhs)          // [] / user-call — verify subtree
            continue
          }
          if (typeof name !== 'string') visitChild(name)
          visitChild(rhs)
        }
        return
      }

      for (let i = 1; i < node.length; i++) visitChild(node[i])
    }
    verify(body)
  }

  // Module inits are not walked in detail — poison any schema whose array form
  // could appear there (struct-array consumed/built at module scope).
  if (ctx.module?.moduleInits) for (const mi of ctx.module.moduleInits) poisonAll(mi)

  for (const sid of cand) if (!black.has(sid)) inlineArray.add(sid)
}

/** Schema id when `name` is bound (codegen truth) to a structInline `Array<S>`,
 *  else null. `ctx.func.localReps` is the per-function rep map the emitter
 *  consults for element-schema facts; `ctx.schema.inlineArray` is the
 *  whole-program eligibility set filled by `analyzeStructInline`. Read together
 *  so the emitter never inline-carries a binding the analysis rejected. */

/**
 * Whole-program function-namespace SRoA analysis.
 *
 * A user function used as a property bag — `parse.space = …; parse.step()` —
 * is otherwise compiled as a dynamic object: each `f.prop` write becomes a
 * `__dyn_set` into a hash side-table keyed by the closure pointer, each read a
 * `__dyn_get`. But a function's property table can never be observed by the
 * host (the host gets only the callable; the table lives in jz linear memory),
 * so the property set is statically closed — jz sees every `f.PROP` site. When
 * `f` never escapes as a bare value, each property dissolves:
 *   - written once, at module top level, to a known function → the property is
 *     constant: every `f.PROP` site rewrites straight to that function name
 *     (direct calls, no storage at all).
 *   - otherwise → a mutable f64 module global (`global.get` / `global.set`).
 *
 * Returns `Map<funcName, { disq, props:Set, valRead:Set,
 * writes:Map<prop,[{rhs,atInit}]> }>` — `valRead` is the subset of props read
 * as a value (not merely called). `flattenFuncNamespaces` (plan.js) turns it
 * into the rewrite. A name carrying `disq` escapes / is reassigned / is
 * computed-indexed and must not be touched.
 */
export function analyzeFuncNamespaces(ast) {
  const funcNames = ctx.func.names
  if (!funcNames || !funcNames.size) return new Map()

  const ns = new Map()
  const rec = (name) => {
    let r = ns.get(name)
    if (!r) ns.set(name, r = { disq: false, props: new Set(), valRead: new Set(), writes: new Map() })
    return r
  }
  // `['.'|'?.', f, P]` member where f is a known function and P a string key.
  const memberOf = (n) =>
    Array.isArray(n) && (n[0] === '.' || n[0] === '?.') &&
    isFuncRef(n[1], funcNames) && typeof n[2] === 'string' ? n : null

  // `atInit` — node is a direct top-level statement (constant-fold candidate);
  // read only at the `=` handler, never propagated into sub-expressions.
  function visit(node, atInit) {
    if (typeof node === 'string') {
      // Bare mention of a known function in value position — it escapes; an
      // alias could reach its property table. Disqualify.
      if (funcNames.has(node)) rec(node).disq = true
      return
    }
    if (!Array.isArray(node)) return
    const op = node[0]

    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=') {
          if (!isFuncRef(d[1], funcNames)) visit(d[1], false)  // skip f's own decl
          // `let f = f` is prepare's self-name placeholder for a lifted function —
          // skip it (a bare visit would falsely disqualify f). Any other funcRef
          // rhs (`let g = f`) is a real alias and must disqualify f.
          if (!(isFuncRef(d[2], funcNames) && d[2] === d[1])) visit(d[2], false)
        } else visit(d, false)
      }
      return
    }

    if (op === 'export') {
      // Exporting the function value is safe — the host gets the callable,
      // never the linear-memory property table. Skip bare function children.
      for (let i = 1; i < node.length; i++)
        if (!isFuncRef(node[i], funcNames)) visit(node[i], false)
      return
    }

    if (op === '=') {
      const m = memberOf(node[1])
      if (m) {
        const r = rec(m[1]); r.props.add(m[2])
        let w = r.writes.get(m[2]); if (!w) r.writes.set(m[2], w = [])
        w.push({ rhs: node[2], atInit })
        visit(node[2], false)
        return
      }
      if (isFuncRef(node[1], funcNames)) rec(node[1]).disq = true  // reassignment
      else visit(node[1], false)
      visit(node[2], false)
      return
    }

    if (op === '()') {
      const m = memberOf(node[1])
      if (m) rec(m[1]).props.add(m[2])
      else if (!isFuncRef(node[1], funcNames)) visit(node[1], false)  // bare f(...) ok
      for (let i = 2; i < node.length; i++) visit(node[i], false)
      return
    }

    // `f.PROP` / `f?.PROP` as a plain value (read) — not the callee of a call
    // (those are handled by the `()` branch above). A value-read means the
    // property's stored value must stay retrievable; devirt cannot drop it.
    const m = memberOf(node)
    if (m) { const r = rec(m[1]); r.props.add(m[2]); r.valRead.add(m[2]); return }

    // Computed `f[k]` — the key set is no longer static.
    if (op === '[]' && isFuncRef(node[1], funcNames)) {
      rec(node[1]).disq = true
      for (let i = 2; i < node.length; i++) visit(node[i], false)
      return
    }

    for (let i = 1; i < node.length; i++) visit(node[i], false)
  }

  const visitTop = (n) => {
    if (Array.isArray(n) && n[0] === ';')
      for (let i = 1; i < n.length; i++) visit(n[i], true)
    else visit(n, true)
  }
  visitTop(ast)
  // Bundled multi-module programs keep each module's top-level statements in
  // moduleInits, not `ast` — the `f.prop = …` writes that define a namespace
  // live there. Walk them at init scope so writes are recorded and an escape
  // inside init code still disqualifies.
  for (const mi of ctx.module.moduleInits || []) visitTop(mi)
  for (const fn of ctx.func.list) if (fn.body && !fn.raw) visit(fn.body, false)

  return ns
}

