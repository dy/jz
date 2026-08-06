/**
 * Body scan passes — free vars, mutations, binding-use taxonomy, SRoA/slice eligibility.
 * @module analyze-scans
 */

import { ASSIGN_OPS, MUTATE_OPS, collectParamNames, extractParams, REFS_IN_EXPR, refsName, T, isLiteralStr } from '../ast.js'
import { ctx, getFactStore } from '../ctx.js'
import { staticObjectProps, staticArrayElems, staticIndexKey, staticValue, intExprRange, NO_VALUE } from '../static.js'
import { exprType } from '../type.js'

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

export const USE = {
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
// Self-host-only: see resetProgramFactsCache (program-facts.js) — a fresh
// factStore (src/session.js) swaps in a fresh WeakMap each session so a
// warm-instance compile-clear-compile loop never reads a dangling arena
// pointer out of the old backing storage. Session-owned (audit P1 stage 5) —
// getFactStore().bindingUses, NOT a private module-level WeakMap.
//
// No surgical invalidation (session.js DEPS table) — by design, not gap: this
// cache is body-keyed with no widen/narrow-in-place hazard like bodyFacts',
// because nothing ever mutates a body's binding-use SHAPE without also
// changing the body's own AST identity first. That identity change is now
// structural (audit P1 next-slice) — every pass that restructures a
// function's AST does so through analyze.js's setFuncBody, which assigns a
// NEW func.body reference — so a caller reading scanBindingUses(func.body)
// after a rewrite is, by construction, keying off a fresh node this WeakMap
// has never seen. Stale entries for orphaned old bodies just sit unreachable
// until GC; nothing ever reads them.
export function resetBindingUsesCache() { getFactStore().bindingUses = new WeakMap() }
const _CMP_OPS = new Set(['==', '!=', '===', '!==', '<', '>', '<=', '>='])
const _isNullishLit = (e) =>
  e === 'null' || e === 'undefined' ||
  (Array.isArray(e) && e[0] == null && (e[1] === null || e[1] === undefined))

// `trackNames` (optional): also report uses of these names even though they're
// never `let`/`const`-declared IN THIS body — the program-wide dyn-fn-table scan
// (compile/dyn-closure-tables.js) uses this to see a GLOBAL's uses inside every
// function body, not just its one module-scope declaration site. Bypasses the
// cache (a different `trackNames` on the same body would otherwise read a stale
// entry keyed only by `body`) — fine, this path is a one-shot pre-pass, not hot.
export function scanBindingUses(body, trackNames) {
  const bindingUses = getFactStore().bindingUses
  if (!trackNames) {
    const hit = bindingUses.get(body)
    if (hit) return hit
  }

  const summary = new Map()                    // name → { decls, initRhs, uses }
  const slot = (name) => {
    let s = summary.get(name)
    if (!s) { s = { decls: 0, initRhs: undefined, uses: [] }; summary.set(name, s) }
    return s
  }
  const use = (name, kind, extra) => slot(name).uses.push(extra ? { kind, ...extra } : { kind })

  // Static string key of a `[]` index node, else null (computed).
  const litKey = (k) => (Array.isArray(k) && k[0] === 'str' && typeof k[1] === 'string') ? k[1] : staticIndexKey(k)

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

  for (const [name, s] of summary) if (s.decls === 0 && !trackNames?.has(name)) summary.delete(name)
  // `body` can be null (a module whose every top-level statement got lifted
  // into ctx.func.list, e.g. a single `export const f = () => …` leaves
  // nothing at module scope) — WeakMap keys must be objects.
  if (!trackNames && body != null && typeof body === 'object') bindingUses.set(body, summary)
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
// Largest array literal that dissolves into scalar slots. Beyond this a single
// constant data segment is cheaper than N locals (+ the per-slot init prologue).
const FLAT_ARRAY_MAX = 8

// A WRITTEN flat slot is normally unanswerable by kind (VT['.'] in kind.js —
// "its runtime value may differ from the literal"). It stays answerable when
// EVERY write to that key is a self-referential compound update (`o.k =
// o.k <op> x`, `o.k <op>= x`, `o.k++`/`o.k--`) whose non-self operand can't
// independently prove a conflicting kind: such a write can only ever PRESERVE
// the slot's existing kind (BigInt stays BigInt, Number stays Number), never
// change it. Mirrors the schema-slot census's self-preserving-write abstain
// (program-facts.js isSelfPreservingPropWrite) for the flat (schema-less)
// SRoA representation — same problem (a self-referential write hard-
// poisoning a provable kind), same fix shape, different storage.
const SELF_PRESERVING_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>'])
// Local twin of program-facts.js's effectiveWriteValue (program-facts.js
// imports FROM this module — importing back would cycle). Small and pure;
// not worth threading through a shared module for one caller each side.
const _effectiveWriteValue = (op, lhs, rhs) => {
  if (op === '=') return rhs
  if (op === '++' || op === '--') return [op === '++' ? '+' : '-', lhs, [null, 1]]
  if (op === '&&=' || op === '||=' || op === '??=') return ['?:', lhs, lhs, rhs]
  return [op.slice(0, -1), lhs, rhs]
}

/** Which of `written`'s keys on binding `name` are safely still described by
 *  the literal initializer's kind — see SELF_PRESERVING_OPS above. */
function selfPreservingWrittenKeys(body, name, written) {
  const litKey = (k) => (Array.isArray(k) && k[0] === 'str' && typeof k[1] === 'string') ? k[1] : staticIndexKey(k)
  const keyOf = (t) => {
    if (!Array.isArray(t) || t[1] !== name) return null
    if (t[0] === '.' || t[0] === '?.') return typeof t[2] === 'string' ? t[2] : null
    if (t[0] === '[]') return litKey(t[2])
    return null
  }
  const isSelf = (n, key) => keyOf(n) === key
  const preserves = (rhs, key) => {
    if (isSelf(rhs, key)) return true
    if (!Array.isArray(rhs)) return false
    const [op, a, b] = rhs
    // prepare's dedicated member ++/-- unary (index.js): "a, ±1, same kind" —
    // trivially self-preserving, no second operand to check.
    if (b === undefined && (op === '+1' || op === '-1')) return isSelf(a, key)
    if (b === undefined || !SELF_PRESERVING_OPS.has(op)) return false
    const aSelf = isSelf(a, key), bSelf = isSelf(b, key)
    if (!aSelf && !bSelf) return false
    const other = aSelf ? b : a
    if (isSelf(other, key)) return true                              // `o.k = o.k + o.k`
    if (Array.isArray(other) && other[0] == null && typeof other[1] === 'number') return true  // number literal
    if (Array.isArray(other) && other[0] === 'bigint') return true    // bigint literal
    return preserves(other, key)
  }
  const safe = new Map()  // key → observed-safe-so-far (absent = unobserved)
  const observe = (key, ok) => { if (safe.get(key) !== false) safe.set(key, ok) }
  const walk = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === '=' && Array.isArray(n[1])) {
      const key = keyOf(n[1])
      if (key != null && written.has(key)) observe(key, preserves(n[2], key))
    } else if (MUTATE_OPS.has(op) && op !== '=' && Array.isArray(n[1])) {
      // Covers '+=' et al AND '++'/'--' (MUTATE_OPS = ASSIGN_OPS ∪ {++,--}) —
      // though a member '++'/'--' never reaches here today (prepare/index.js
      // desugars it to a plain '=' before analyze runs), effectiveWriteValue
      // handles that shape too if that ever changes.
      const key = keyOf(n[1])
      if (key != null && written.has(key)) observe(key, preserves(_effectiveWriteValue(op, n[1], n[2]), key))
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(body)
  const out = new Set()
  for (const k of written) if (safe.get(k) === true) out.add(k)
  return out
}

export function scanFlatObjects(body) {
  const cand = new Map()                 // name → {names, values}

  // A binding referenced as a value inside `node` (skips `:`/`.` property-name
  // slots). Used only to reject a self-referential initializer — a literal
  // whose own field values mention the binding is not a self-contained object.
  for (const [name, s] of scanBindingUses(body)) {
    if (s.decls !== 1 || !Array.isArray(s.initRhs)) continue
    // Candidate aggregate: an object literal `{…}` (string keys) or a small array
    // literal `[…]` (index keys "0","1",…). An array dissolves into `name#i` scalar
    // locals exactly like an object — same `.`/`[]` flat hooks, no heap alloc — when
    // every use is a static-index read/write. Capped at FLAT_ARRAY_MAX: a larger
    // literal belongs in one constant data-segment region, not N spilled locals.
    let props
    if (s.initRhs[0] === '{}') {
      props = staticObjectProps(s.initRhs.slice(1))
    } else if (s.initRhs[0] === '[' || s.initRhs[0] === '[]') {
      const elems = staticArrayElems(s.initRhs)
      if (!elems || !elems.length || elems.length > FLAT_ARRAY_MAX) continue
      // Holes (`[1,,3]`) and spreads (`[...x]`) aren't a fixed positional schema.
      if (elems.some(e => e == null || (Array.isArray(e) && e[0] === '...'))) continue
      // Only compile-time-constant *value* elements dissolve — number/string/bool/null
      // ("arrays hold JSON values"). A non-literal element (identifier, call, closure,
      // arithmetic on a runtime var) can carry a function/closure whose call-indirect
      // table index binds to the array, not a scalar local — dissolving the slot
      // desyncs the `elem` section. Conservative: any non-constant element keeps the
      // array heap-backed.
      if (!elems.every(e => staticValue(e) !== NO_VALUE)) continue
      props = { names: elems.map((_, i) => String(i)), values: elems }
    } else continue
    const isArr = s.initRhs[0] !== '{}'
    if (!props || new Set(props.names).size !== props.names.length) continue
    if (props.values.some(v => refsName(v, name, REFS_IN_EXPR))) continue

    // Schema = literal keys ∪ plain literal-key member writes. For an OBJECT such a
    // write monotonically extends the static field universe (the new field reads
    // `undefined` until the write runs, exactly as JS does). An ARRAY has a *fixed*
    // positional schema: `a.length = …` / `a[n] = …` (off the literal indices) resize
    // or grow it — not a field add — so arrays never extend, and any off-schema write
    // (including `.length`, which isn't a slot) disqualifies below.
    // `written` = the keys a MEMBER_W reassigns — a slot is write-once (its
    // value-type is exactly its literal initializer's) iff its key is absent here.
    const schema = new Set(props.names)
    const written = new Set()
    for (const u of s.uses)
      if (u.kind === USE.MEMBER_W && !u.compound && !u.computed && u.key != null) {
        if (!isArr) schema.add(u.key)
        written.add(u.key)
      }

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
    const selfPreserving = written.size ? selfPreservingWrittenKeys(body, name, written) : null
    cand.set(name, { names, values, written, selfPreserving })
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

export function scanSliceViews(body) {
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
 * Never-relocated array bindings — reads through them may skip the realloc-forwarding
 * follow (`__ptr_offset`). A fresh array-literal binding is never relocated iff EVERY
 * occurrence of it is a pure READ — `a[i]` (any index) or `a.length`. Anything else
 * grows or escapes it: a grow method (push/unshift/shift/splice), a `.length`/element
 * write (incl. compound `a.length += 1`), a bare value use (alias `let b=a`, store
 * `w.x=a`, return, call argument, spread), a reassignment, or a dynamic call
 * `a[i]()`/`a.m()`.
 *
 * MEMORY-SAFETY CRITICAL and so DEFAULT-DENY + self-contained: it does NOT trust the
 * `escapes` map, which misses member-write RHS (`w.data = a`) and compound assigns. If
 * the analysis is wrong and the array IS relocated, a read through the stale base
 * corrupts memory — so any unrecognized use disqualifies. (Growing an INNER array,
 * `a[0].push(x)`, never relocates `a` itself, so `a` stays eligible — see safeReads.)
 */
const grownOrEscapes = (op) => MUTATE_OPS.has(op) || op === 'delete'
export function safeReads(node, name) {
  if (typeof node === 'string') return node !== name            // bare value use → escape
  if (!Array.isArray(node)) return true
  const op = node[0]
  // `a(…)` / `a.m(…)` / `a[i](…)` — calling `a` or a method/element of it may grow/escape it.
  if (op === '()') {
    const c = node[1]
    if (c === name) return false
    if (Array.isArray(c) && (c[0] === '.' || c[0] === '?.' || c[0] === '[]' || c[0] === '?.[]') && c[1] === name) return false
  }
  // write / update / delete on `a`, `a[..]`, or `a.x` (incl. `a.length = …` and compounds)
  if (grownOrEscapes(op)) {
    const t = node[1]
    if (t === name) return false
    if (Array.isArray(t) && (t[0] === '[]' || t[0] === '.' || t[0] === '?.') && t[1] === name) return false
  }
  // declaration: check each initializer RHS (so `let b = a` aliasing disqualifies);
  // the bound names themselves are definitions, not uses (skips `a`'s own decl).
  if (op === 'let' || op === 'const' || op === 'var') {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (Array.isArray(d) && d[0] === '=' && !safeReads(d[2], name)) return false
    }
    return true
  }
  // the only safe forms: `a.length` read, and `a[i]` index read (recurse the index expr).
  if ((op === '.' || op === '?.') && node[1] === name) return node[2] === 'length'
  if (op === '[]' && node[1] === name) return safeReads(node[2], name)
  if (op === '...' && node[1] === name) return false            // spread → escape
  for (let i = 1; i < node.length; i++) if (!safeReads(node[i], name)) return false
  return true
}

export function scanNeverGrown(body) {
  const out = new Set()
  for (const [name, s] of scanBindingUses(body)) {
    // Candidate: a single-declaration binding initialized from a fresh array literal.
    if (s.decls !== 1 || !Array.isArray(s.initRhs)) continue
    if (s.initRhs[0] !== '[' && !(s.initRhs[0] === '[]' && s.initRhs.length <= 2)) continue
    if (safeReads(body, name)) out.add(name)
  }
  return out
}

/**
 * Numeric-fill arrays — the construct-then-fill counterpart of an all-number array
 * literal. A fresh `Array(n)` / `new Array(n)` / `[]` binding whose EVERY element write
 * stores a provably-NUMBER value, and which never escapes, aliases, is reassigned, grows
 * by method, or takes a non-numeric / compound element write, holds only Numbers (unwritten
 * holes read as 0 in jz, also a Number). So its `a[i]` reads can skip the polymorphic
 * `__to_num` coercion — exactly the win `[1,2,3]` already gets, extended to the dominant
 * numeric-kernel shape `let a = Array(n); for (..) a[i] = expr`.
 *
 * Default-deny and self-contained, like scanNeverGrown (the same memory-safety discipline):
 * any occurrence that isn't a pure index/length READ or a NUMBER-valued `a[i] = …` write
 * disqualifies — so `w.x = a`, `f(a)`, `let b = a`, `a.push(x)`, `a[i] += x` all bail.
 * `isNumericRhs` injects the value-type judgement (valTypeOf === VAL.NUMBER) the syntactic
 * scan can't make itself.
 */
// Both `Array(n)` and `new Array(n)` normalize to a `new.Array` call by prepare; an
// empty literal stays `['[]', null]`. (Typed ctors become `new.Float64Array` etc. — the
// exact-match on `new.Array` keeps them out.)
export const isFreshArrayCtor = (rhs) =>
  Array.isArray(rhs) && (
    (rhs[0] === '[]' && rhs.length <= 2) ||             // empty `[]`
    (rhs[0] === '()' && rhs[1] === 'new.Array')         // `Array(n)` / `new Array(n)` / `Array()`
  )

function numFillSafe(node, name, isNumericRhs) {
  if (typeof node === 'string') return node !== name              // bare value use → escape
  if (!Array.isArray(node)) return true
  const op = node[0]
  // `a[i] = rhs` — the fill write. Allowed iff rhs is provably NUMBER; recurse the index
  // and rhs so a stray `a` inside either still disqualifies. (Compound `a[i] += …` is NOT
  // matched here, so it falls through to the deny below — conservative for v1.)
  if (op === '=' && Array.isArray(node[1]) && node[1][0] === '[]' && node[1][1] === name)
    return isNumericRhs(node[2], name) &&
      numFillSafe(node[1][2], name, isNumericRhs) && numFillSafe(node[2], name, isNumericRhs)
  // calling `a`, `a.m(…)`, `a[i](…)` may grow/escape it
  if (op === '()') {
    const c = node[1]
    if (c === name) return false
    if (Array.isArray(c) && (c[0] === '.' || c[0] === '?.' || c[0] === '[]' || c[0] === '?.[]') && c[1] === name) return false
  }
  // any other write/update/delete on `a`, `a[..]`, `a.x` (incl. `a.length = …`, compounds)
  if (grownOrEscapes(op)) {
    const t = node[1]
    if (t === name) return false
    if (Array.isArray(t) && (t[0] === '[]' || t[0] === '.' || t[0] === '?.') && t[1] === name) return false
  }
  if (op === 'let' || op === 'const' || op === 'var') {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (Array.isArray(d) && d[0] === '=' && !numFillSafe(d[2], name, isNumericRhs)) return false
    }
    return true
  }
  // the only safe forms: `a.length` read, and `a[i]` index read (recurse the index expr).
  if ((op === '.' || op === '?.') && node[1] === name) return node[2] === 'length'
  if (op === '[]' && node[1] === name) return numFillSafe(node[2], name, isNumericRhs)
  if (op === '...' && node[1] === name) return false              // spread → escape
  for (let i = 1; i < node.length; i++) if (!numFillSafe(node[i], name, isNumericRhs)) return false
  return true
}

export function scanNumericFill(body, isNumericRhs) {
  const out = new Set()
  for (const [name, s] of scanBindingUses(body)) {
    if (s.decls !== 1 || !isFreshArrayCtor(s.initRhs)) continue
    if (numFillSafe(body, name, isNumericRhs)) out.add(name)
  }
  return out
}

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
export function narrowUint32(body, locals) {
  const TRANSPARENT = new Set(['^', '&', '|', '~', '<<', '>>', '+', '-', '*'])
  const initLit = new Set()   // names with a valid u32-literal initializer
  const disq = new Set()      // names disqualified by an unsafe occurrence
  const seen = new Set()
  const isU32Lit = e => {
    const v = typeof e === 'number' ? e
      : Array.isArray(e) && e[0] == null && typeof e[1] === 'number' ? e[1] : NaN
    return Number.isInteger(v) && v >= 0 && v < 4294967296
  }
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
    if (ASSIGN_OPS.has(op)) {
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
 *
 * THIRD requirement, layered on top of both sources above (fixed 2026-08-02,
 * .work/todo.md KNOWN GAP #1): membership alone is NOT sufficient — a var is
 * excluded from the returned set if `collectBareEscapes` finds it in an
 * unresolved bare-escape position anywhere in `body`. Both sources' proofs
 * are true only AT THE POINT of the index/edge use; the var's WASM storage is
 * ONE slot for the whole function, so a later unguarded bare read (`return
 * id` after `id *= 100000`) would silently read back a wrapped value. See
 * collectBareEscapes' own doc for the exemption rules (index position,
 * ToInt32-rooted, provable range, or a governing comparison).
 */
// An integer literal that fits signed i32 — the only constant a promoted i32
// local may hold. A larger integer (`0xFFFFFFFF`, a NaN-box mask) is emitted as
// an f64.const, so treating it as an i32 leaf would store f64 into an i32 local.
const isI32Lit = (v) => typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647

// ToInt32-rooted operators (`&|^~<<>>>>>`) AND comparisons: JS applies the
// identical truncation — or collapses to a fresh i32 boolean — to the TRUE
// value before these run, so a wrapped-i32 read here reproduces exactly what
// JS would compute from the untruncated double. Comparisons additionally
// carry their own SEPARATE, pre-existing, deliberately-scoped soundness
// contract ("sound for n ≤ 2³¹", widenLocalTypes' CMP_OPS pass) — folding
// them into a fresh proof obligation here would just double-count that
// already-accepted tolerance, not add real safety.
const ESCAPE_SAFE_ROOT_OPS = new Set(['&', '|', '^', '~', '<<', '>>', '>>>', '<', '>', '<=', '>=', '==', '!=', '===', '!=='])

// Assignment forms whose RHS merely feeds the TARGET's OWN storage — no
// magnitude proof needed for the feeder, because the write's wrap-consistency
// is the TARGET var's own qualification to prove (this is exactly what the
// backprop fixpoint below already trusts for these same four ops).
const ESCAPE_EDGE_OPS = new Set(['=', '+=', '-=', '*='])

// Compound-assignment sugar for a ToInt32-rooted binary op — `x ^= y` is
// exactly `x = x ^ y` (JS ToInt32-coerces both operands identically either
// way), the SAME root-op exemption ESCAPE_SAFE_ROOT_OPS already grants the
// expanded binary form (`x ^ y` walks both operands in 'idx' mode, never
// blaming either). Before this fix these ops fell through to the generic
// value-mode walker (they're not affine, not `[]`, not a math-fn call, not
// in ESCAPE_EDGE_OPS), which walks BOTH node[1] (the target, a bare string)
// AND node[2] in 'value' mode — misreading the compound-assign's implicit
// self-read of the target as a bare escape and blaming it (`x ^= x << 7` in
// a sieve/PRNG-style bitwise kernel: `x` never compared, so blamed on every
// such statement, disqualifying an otherwise textbook ESCAPE_SAFE_ROOT_OPS
// var from i32 storage — the reference-refresh top-priority regression at
// 2f0720a5, root-caused to 28b2530b, bench/bitwise.js: 0 v128 ops, was 12+
// before). Target skipped here
// for the identical reason ESCAPE_EDGE_OPS skips its target: a compound
// assign's self-read never independently reveals unsoundness (any true
// divergence needs a DIFFERENT, unguarded bare read elsewhere in the body,
// which the whole-body scan already catches). RHS gets 'idx' tolerance
// (behaviorally identical to 'edge' in this walk — see the mode checks
// below — chosen for the closer semantic match to the binary form).
const ESCAPE_ROOT_EDGE_OPS = new Set(['^=', '|=', '&=', '<<=', '>>=', '>>>='])

const escapeInRangeI32 = (node) => {
  const r = intExprRange(node)
  return r != null && r[0] >= -2147483648 && r[1] <= 2147483647
}

const CMP_OPS_SET = new Set(['<', '>', '<=', '>=', '==', '!=', '===', '!=='])

// Names appearing as a DIRECT operand of a comparison anywhere in `body` —
// the canonical loop-counter shape (`i < n`). These already carry their OWN
// separate, deliberately-scoped soundness tolerance ("sound for n ≤ 2³¹",
// widenLocalTypes' CMP_OPS pass, untouched by this fix) — a var governed by
// SOME comparison is exactly a loop-counter-shaped var, and its OTHER
// arithmetic (`a[i] = (i+1)*0.125`, the mat4 perf-guard shape) inherits that
// SAME accepted tolerance rather than a fresh, stricter one: keeping it i32
// storage is no riskier than the comparison itself already accepts. A var
// with NO governing comparison anywhere (an unbounded accumulator like `id`
// in `id *= 100000` / `id += d`) gets no such pass, so it stays subject to
// the full bare-escape proof below.
// Math.imul/Math.clz32: JS ToInt32-coerces every argument before computing
// (spec-defined, unconditionally — same "wrap IS the semantics" contract as
// the bitwise operators; mirrors type.js intLevelMap's INT_MATH_FNS_I32,
// the level-2/STRICT math-fn subset). Math.floor/ceil/round/trunc are
// deliberately EXCLUDED — those need the argument's ACTUAL magnitude
// (floor(NaN) is NaN, not 0), so a wrapped-i32 read there is NOT safe.
const INT_MATH_FNS_I32 = new Set(['imul', 'clz32'])
const mathFnName = (callee) =>
  typeof callee === 'string' && callee.startsWith('math.') ? callee.slice(5)
    : Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Math' ? callee[2] : null

// `crossClosure`: descend into nested `=>` bodies instead of stopping at the
// boundary. A LOCAL's relevant scope is exactly its one function body (nested
// arrows are a separate scope for a same-named local, boxed-capture handles
// the mutated-and-shared case), so the default (false) stops there. A MODULE
// GLOBAL's relevant scope is the WHOLE PROGRAM — an inline arrow passed as a
// callback (`.forEach(x => { g = x })`) is not lifted to its own ctx.func.list
// entry at prepare time (only named function/arrow bindings are), so it stays
// an inline `=>` node in the enclosing body and would be invisible to a scan
// that stops there. See collectBareEscapes' own crossClosure doc.
function collectComparedNames(body, crossClosure) {
  const names = new Set()
  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') { if (crossClosure) walk(node[2]); return }
    if (CMP_OPS_SET.has(op)) {
      if (typeof node[1] === 'string') names.add(node[1])
      if (typeof node[2] === 'string') names.add(node[2])
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return names
}

/**
 * Names with at least one "bare escape" anywhere in `body` — a value-position
 * read whose exact double value could diverge from a wrapped-i32
 * approximation, with no static proof it stays in range. A var with ANY such
 * escape must never be promoted to permanent i32 storage: once a local's WASM
 * storage is i32, `writeVar`'s `toI32` coercion (ir.js) wraps EVERY write mod
 * 2^32 unconditionally — sound for a value ONLY ever consumed by another
 * ToInt32 sink (an index, a bitwise op, another i32-storage local), unsound
 * the instant it's read bare (`return id` after `id *= 100000`) even though
 * some OTHER, earlier use of the same var (feeding an array index) was
 * perfectly sound at that point of use. See collectI32SafeIndexVars' own doc
 * and .work/todo.md's KNOWN GAP #1 entry (2026-08-02) for the full diagnosis.
 *
 * Occurrences exempt from the proof requirement (mirrors the three-source
 * contract in collectI32SafeIndexVars' doc):
 *   'idx'  — an affine component of a `[]` index, a direct operand of a
 *            ToInt32-rooted op / comparison (ESCAPE_SAFE_ROOT_OPS), the
 *            target OR rhs of a ToInt32-rooted COMPOUND assign (`x ^= y` ≡
 *            `x = x ^ y`, ESCAPE_ROOT_EDGE_OPS — same root-op exemption as
 *            the binary form, just spelled as assignment sugar), or an
 *            argument to Math.imul/Math.clz32 (INT_MATH_FNS_I32 — spec-
 *            defined ToInt32 on every argument, including through the `,`
 *            multi-arg-list wrapper node): the wasm32 trap bound, or JS's
 *            own truncation, already proves it (rules b,c).
 *   'edge' — the affine-reachable RHS of a tracked assignment edge into
 *            ANOTHER local (ESCAPE_EDGE_OPS): identical to what the backprop
 *            fixpoint below already trusts — the feeder inherits the TARGET's
 *            own contract, not a fresh one.
 * Anything else needs a static `intExprRange` proof (rule a) or it's blamed.
 *
 * `crossClosure` (default false, LOCAL mode — unchanged behavior: a nested
 * `=>` is a separate scope/body, not scanned): pass `true` for a MODULE
 * GLOBAL's whole-program scan (plan/scope.js `inferModuleIntGlobals`) — a
 * global's storage is ONE cell for the entire program, so an escape hiding
 * inside an inline closure (never lifted to its own ctx.func.list entry,
 * e.g. `.forEach(x => { g = x })`) is exactly as disqualifying as one at
 * top level. Callers pass a synthetic whole-program body (module-init AST +
 * every function body concatenated) so the SAME comparison-governed
 * tolerance this function already grants a local — "compared ANYWHERE in
 * the relevant scope" — is evaluated over the global's true relevant scope
 * (the whole program) rather than one function at a time. No shadow
 * tracking: a same-named local elsewhere only makes the scan MORE
 * conservative (a spurious blame just keeps a global at f64, never the
 * reverse), matching the flat by-name matching inferModuleIntGlobals's own
 * evidence walk already uses program-wide.
 */
export function collectBareEscapes(body, locals, crossClosure) {
  const escaped = new Set()
  const compared = collectComparedNames(body, crossClosure)
  const walk = (node, mode) => {   // mode: 'idx' | 'edge' | 'value'
    // audit-#12 delayline residual: `escapeInRangeI32` (rule a, doc above) was
    // already wired for a COMPOUND value-mode node (the generic array-node
    // fallthrough below) — but a BARE NAME leaf returns HERE, before ever
    // reaching that check, so a name whose own closed hull IS provable
    // (`repOf(name)?.range`, stamped by processDecl's early declRange pass for
    // any never-reassigned decl — see analyze.js) still got blamed whenever
    // its only escaping use sat under an operator `intExprRange` doesn't model
    // (division: `(dq/65536)|0` walks `dq` in 'value' mode directly, since
    // `/` isn't ESCAPE_SAFE_ROOT_OPS/AFFINE_INDEX_OPS and intExprRange has no
    // '/' case to hull the OUTER node — the ONLY chance to prove `dq` itself
    // safe is checking the LEAF's own range, which this line now does). Same
    // proof, same soundness contract as the compound-node check just reached
    // one level too late — a reassigned accumulator (`id` after `id *=
    // 100000`) gets no processDecl range stamp either way, so this is a
    // strict widening, not a new tolerance.
    if (typeof node === 'string') { if (mode === 'value' && !compared.has(node) && !escapeInRangeI32(node)) escaped.add(node); return }
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') { if (crossClosure) walk(node[2], 'value'); return }  // local mode: separate scope/body; global mode: descend (see doc)
    if ((op === '++' || op === '--') && typeof node[1] === 'string') return  // pure self-step, no value consumed
    if (op === '[]' && !isLiteralStr(node[2])) { walk(node[1], 'value'); walk(node[2], 'idx'); return }
    if (ESCAPE_SAFE_ROOT_OPS.has(op)) { for (let i = 1; i < node.length; i++) walk(node[i], 'idx'); return }
    if (op === '()' && INT_MATH_FNS_I32.has(mathFnName(node[1]))) { walk(node[2], 'idx'); return }
    // A multi-arg call's argument list is a `,`-headed node (`Math.imul(i, i)`
    // → `['()', 'math.imul', [',', i, i]]`) — reached above via `walk(node[2],
    // 'idx')`. Without this, `,` isn't in AFFINE_INDEX_OPS so the idx/edge
    // pass-through below never fires, the args node falls to the generic
    // value-mode walker, and each argument gets scanned in 'value' mode —
    // exactly the shape loop-square.js produces rewriting a sieve's `i*i`
    // guard to `Math.imul(i,i)`: `i` is no longer a direct comparison operand
    // post-rewrite, so it's uncompared AND now blamed as a bare escape,
    // despite sitting inside the very call this function's own doc names as
    // exempt (INT_MATH_FNS_I32 — spec-defined ToInt32 on every argument).
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') walk(d[2], 'edge')
        else walk(d, mode)
      }
      return
    }
    if (ESCAPE_EDGE_OPS.has(op) && typeof node[1] === 'string') { walk(node[2], 'edge'); return }
    if (ESCAPE_ROOT_EDGE_OPS.has(op) && typeof node[1] === 'string') { walk(node[2], 'idx'); return }
    if ((mode === 'idx' || mode === 'edge') && (op === ',' || AFFINE_INDEX_OPS.has(op))) {
      for (let i = 1; i < node.length; i++) walk(node[i], mode)
      return
    }
    mode = 'value'   // fell out of an idx/edge-affine chain (or already were in 'value' mode)
    if (escapeInRangeI32(node)) return
    for (let i = 1; i < node.length; i++) walk(node[i], mode)
  }
  walk(body, 'value')
  return escaped
}

export function collectI32SafeIndexVars(body, locals) {
  const safe = new Set()
  // Collect names reachable from `node` through affine ops only, into `sink`.
  const addAffine = (node, sink) => {
    if (typeof node === 'string') { sink.add(node); return }
    if (!Array.isArray(node)) return
    if (AFFINE_INDEX_OPS.has(node[0])) for (let i = 1; i < node.length; i++) addAffine(node[i], sink)
  }
  // Pass 1: record assignment edges (back-prop) + a name→definitions map (for the
  // integer-shape test). `+= …` reconstructs to `name + …` so its shape includes
  // the prior value.
  const edges = []
  const defs = new Map()
  const addDef = (name, rhs) => { (defs.get(name) ?? defs.set(name, []).get(name)).push(rhs) }
  const collect = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') { edges.push({ target: d[1], rhs: d[2] }); addDef(d[1], d[2]) }
      }
    } else if (op === '=' && typeof node[1] === 'string') { edges.push({ target: node[1], rhs: node[2] }); addDef(node[1], node[2]) }
    else if ((op === '+=' || op === '-=' || op === '*=') && typeof node[1] === 'string') { edges.push({ target: node[1], rhs: node[2] }); addDef(node[1], [op[0], node[1], node[2]]) }
    if (op === '=>') return
    for (let i = 1; i < node.length; i++) collect(node[i])
  }
  collect(body)

  // Integer-shaped AND i32-representable: provably an integer through `+ - * << u-`
  // (AFFINE_INDEX_OPS — excludes `/`/`**`/fractional ops) over leaves that are
  // i32-typed, i32-range integer literals, or other integer-shaped locals. Lets a
  // hoisted offset `let o = y*w` (f64-typed product, integer-valued) qualify as an
  // index leaf before narrowing. A fractional leaf, an out-of-i32-range literal, or
  // a param of unknown type disqualifies — so no truncation and no f64.const→i32.
  const isIntShaped = (node, seen) => {
    if (typeof node === 'number') return isI32Lit(node)
    if (typeof node === 'string') {
      if (exprType(node, locals) === 'i32') return true
      if (seen.has(node)) return true  // recursion through a self-step — other defs still gate
      const ds = defs.get(node)
      if (!ds || !ds.length) return false  // param / unknown source — not provably integer
      seen.add(node)
      const r = ds.every(d => isIntShaped(d, seen))
      seen.delete(node)
      return r
    }
    if (!Array.isArray(node)) return false
    const op = node[0]
    if (op == null) return isI32Lit(node[1])  // [null, value] literal
    if (!AFFINE_INDEX_OPS.has(op)) return false
    for (let i = 1; i < node.length; i++) if (node[i] != null && !isIntShaped(node[i], new Set(seen))) return false
    return true
  }

  // Pass 2: seed from array indices already i32 OR integer-shaped (the latter
  // rescues hoisted integer offsets the type pass left at f64). A fractional index
  // (`mem[y*w+x]` with fractional `w`) is not integer-shaped → still truncs per
  // access and is left to widen, preserving the prior guard.
  const seed = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '[]' && !isLiteralStr(node[2]) && (exprType(node[2], locals) === 'i32' || isIntShaped(node[2], new Set()))) addAffine(node[2], safe)
    if (op === '=>') return
    for (let i = 1; i < node.length; i++) seed(node[i])
  }
  seed(body)

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
  // A var promoted to PERMANENT i32 storage must have NO unproven bare escape
  // ANYWHERE in the body — the storage is a single WASM local slot, so ANY
  // later unguarded bare read (`return id` after `id *= 100000`, the
  // FFT-butterfly KNOWN-FAIL this closes — see collectBareEscapes' doc)
  // corrupts the value regardless of where in the function the escape sits
  // relative to the sound index-feeding use. Filtering AFTER the fixpoint
  // (rather than gating each backprop step) is sound without a re-fixpoint:
  // removing a var here never needs to cascade to vars that reached `safe`
  // THROUGH it — each var's own storage-safety rests on ITS OWN index/edge
  // role, not on some other excluded var's escape status (a plain local
  // copy `e = id` already routes through the SAME edge-exemption regardless
  // of id's verdict, so e's own qualification — if any — is unaffected).
  for (const n of collectBareEscapes(body, locals)) safe.delete(n)
  // Promote integer-shaped index feeders the type pass left at f64 (a hoisted
  // `o = y*w`). The byte offset must fit i32-addressable memory, so the i32-wrap
  // residue reproduces the true in-bounds value — same contract as inline `a[y*w+x]`.
  // Skip boxed (closure-captured) cells — those live as f64 in memory.
  for (const n of safe) if (locals.get(n) === 'f64' && !ctx.func.boxed?.has(n) && isIntShaped(n, new Set())) locals.set(n, 'i32')
  return safe
}

/**
 * Locals that affinely feed an *f64-typed* array index (e.g. `mem[i*w + x]` with
 * an f64 stride/global `w`). The access truncs the byte offset regardless, so
 * keeping such a counter i32 buys no trunc savings and ADDS a per-iteration
 * compare-convert — a net loss (the game-of-life regression). These are excluded
 * from the integer-counter i32-keep in analyzeBody's widenPass, so they widen to
 * f64 as before. (A counter used only in arithmetic — no f64 index — is NOT here,
 * so it stays i32, where the i32 body + increment is the real win.)
 */
export function collectF64StridedIndexVars(body, locals) {
  const set = new Set()
  const addAffine = (node) => {
    if (typeof node === 'string') { set.add(node); return }
    if (Array.isArray(node) && AFFINE_INDEX_OPS.has(node[0])) for (let i = 1; i < node.length; i++) addAffine(node[i])
  }
  const walk = (node) => {
    if (!Array.isArray(node)) return
    if (node[0] === '[]' && !isLiteralStr(node[2]) && exprType(node[2], locals) === 'f64') addAffine(node[2])
    if (node[0] === '=>') return
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return set
}

/**
 * Returns the cached facts object directly — DO NOT MUTATE the returned maps.
 * Callers that need to extend (e.g. add params to locals) must clone explicitly
 * before mutating. Slice reads via `analyzeBody(body).<slice>`.
 */
