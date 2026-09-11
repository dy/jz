/**
 * Body scan passes — free vars, mutations, binding-use taxonomy, SRoA/slice eligibility.
 * @module analyze-scans
 */

import { ASSIGN_OPS, MUTATE_OPS, ACCESSOR_GET, ACCESSOR_SET, collectAssignedNames, collectParamName, collectParamNames, extractParams, REFS_IN_EXPR, refsName, some, T, isLiteralStr, walkAst, isReassigned, takeScratchMap, releaseScratchMap } from '../ast.js'
import { ctx, getFactStore } from '../ctx.js'
import {
  staticObjectProps, staticArrayElems, staticIndexKey, staticValue, intExprRange, NO_VALUE,
  constIntExpr, guardCounterName, forCounterRange,
} from '../static.js'
import { exprType } from '../type.js'
import { maxAdvanceBudget } from '../type/canonical-bounds.js'
import { repOf, updateRep } from '../reps.js'

export function findFreeVars(node, bound, free, scope) {
  if (node == null) return
  if (typeof node === 'string') {
    if (bound.has(node) || free.includes(node)) return
    // repOf(node)?.intConst: a name the CURRENT function itself received as a
    // constant-folded capture (module/function.js's ctx.closure.make/
    // legacyDerive, mirrored in src/compile/closure-plan.js's mintArrow) has
    // no entry in ctx.func.locals — folding it away IS the point, there's no
    // slot to declare. Without this arm, a closure nested inside THIS one
    // that references the same name reads as "not in scope" here and gets
    // silently dropped from `free` entirely (not merely unclassified) —
    // ctx.closure.make then believes the nested closure captures nothing,
    // while that closure's own body still contains the bare reference with
    // no local, no param, no capture and no inherited fold to resolve it: a
    // reference emitted with no declaration behind it (2026-08-19 banked
    // defect, .work/archive/todo.md — self-compile closure-capture depth≥2 repro).
    // A name that's a real int constant one level up is exactly as
    // "in scope" here as one that's a real local — same value, just a
    // different (slot-free) storage decision upstream.
    const inScope = scope
      ? scope.has(node)
      : (ctx.func.locals?.has(node) || ctx.func.current?.params.some(p => p.name === node) || repOf(node)?.intConst != null)
    if (inScope) free.push(node)
    return
  }
  if (!Array.isArray(node)) return
  const op = node[0]
  if (op === '=>') {
    const innerBound = collectParamNames(extractParams(node[1]), new Set(bound))
    findFreeVars(node[2], innerBound, free, scope)
    return
  }
  if (op === 'catch') {
    findFreeVars(node[1], bound, free, scope)
    const errName = node[2]
    const handlerBound = typeof errName === 'string' && errName
      ? new Set(bound).add(errName) : bound
    findFreeVars(node[3], handlerBound, free, scope)
    return
  }
  if (op === 'let' || op === 'const') {
    const decls = node.slice(1)
    collectParamNames(decls, bound)
    if (scope) collectParamNames(decls, scope)
  }
  if (op === 'for' && Array.isArray(node[1]) && (node[1][0] === 'let' || node[1][0] === 'const')) {
    const decls = node[1].slice(1)
    collectParamNames(decls, bound)
    if (scope) collectParamNames(decls, scope)
  }
  for (let i = 1; i < node.length; i++) findFreeVars(node[i], bound, free, scope)
}

/** Check which queried names are assigned in an AST subtree. The complete
 * mutation set is body-identity-cached because narrowing and closure planning
 * ask the same question with different candidate sets. */
export function findMutations(node, names, mutated) {
  if (!Array.isArray(node)) return
  const cache = getFactStore().mutationNames
  let all = cache.get(node)
  if (!all) {
    all = collectAssignedNames(node, new Set())
    cache.set(node, all)
  }
  for (const name of all) if (names.has(name)) mutated.add(name)
}

const NO_NAMES = []

/**
 * Pre-scan function body for captured variables that are mutated.
 * Marks mutably-captured vars in ctx.func.boxed for cell-based capture.
 * `params` and `captures` name a closure body's own parameters and the names
 * it captured from its parent: values in hand at entry, so a nested closure
 * capturing one copies the value (a cell only when the body mutates it), as
 * it does a function's parameter.
 */
export function boxedCaptures(body, params = NO_NAMES, captures = NO_NAMES) {
  const outerScope = new Set()
  walkAst(body, { enter: node => {
    const op = node[0]
    if (op === '=>') return false
    if (op === 'let' || op === 'const') collectParamNames(node, outerScope, 1)
  } })
  if (ctx.func.current?.params) for (const p of ctx.func.current.params) outerScope.add(p.name)
  if (ctx.func.locals) for (const k of ctx.func.locals.keys()) outerScope.add(k)

  // The names declared so far on the path from the body's entry: one set,
  // block-scoped by an undo log (a block's declarations are forgotten at its
  // exit), instead of a copy of the set per block.
  const seen = new Set()
  if (ctx.func.current?.params) for (const p of ctx.func.current.params) seen.add(p.name)
  for (const name of params) seen.add(name)
  for (const name of captures) seen.add(name)
  const undo = []
  const declare = { add: (name) => { if (!seen.has(name)) { seen.add(name); undo.push(name) } } }

  const markArrowCaptures = (node, assignTarget) => {
    const pnode = node[1]
    let p = pnode
    if (Array.isArray(p) && p[0] === '()') p = p[1]
    const raw = p == null ? [] : Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : [p]) : [p]
    const paramSet = new Set(raw.map(r => Array.isArray(r) && r[0] === '...' ? r[1] : r))
    const captures = []
    findFreeVars(node[2], paramSet, captures, outerScope)
    // Record EVERY captured name (mutated or not) — src/compile/emit.js's
    // emitDecl consults this to decide whether a captured, ambiguous
    // BOOL∪NUMBER-merge init (kind.js hasAmbiguousBoolMerge) needs an
    // identity-safe shadow for the closure's env-slot store (module/
    // function.js ctx.closure.make, the 'value'-mode capture copy). Broader
    // than `boxed` below (mutation-gated, cell storage) by design — this is
    // capture-status ALONE, independent of mutation.
    for (const v of captures) (ctx.func.capturedNames ??= new Set()).add(v)
    if (captures.length === 0) return
    const captureSet = new Set(captures)
    const boxed = new Set()
    findMutations(body, captureSet, boxed)
    for (const v of captures) if (!seen.has(v)) boxed.add(v)
    if (assignTarget && captureSet.has(assignTarget)) boxed.add(assignTarget)
    for (const v of boxed) if (!ctx.func.boxed.has(v)) ctx.func.boxed.set(v, `${T}cell_${v}`)
  }

  // `seen` starts at what is in hand at entry (passed in: an IIFE's default
  // parameter cannot read the enclosing function's locals under the
  // self-compile).
  ;(function walk(node, assignTarget) {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') {
      markArrowCaptures(node, assignTarget)
      return
    }

    if (op === ';' || op === '{}') {
      const mark = undo.length
      for (let i = 1; i < node.length; i++) walk(node[i], null)
      while (undo.length > mark) seen.delete(undo.pop())
      return
    }

    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const decl = node[i]
        if (Array.isArray(decl) && decl[0] === '=') walk(decl[2], typeof decl[1] === 'string' ? decl[1] : null)
        else walk(decl, null)
        collectParamName(decl, declare)
      }
      return
    }

    if (op === '=' && typeof node[1] === 'string' && Array.isArray(node[2]) && node[2][0] === '=>')
      return walk(node[2], node[1])
    for (let i = 1; i < node.length; i++) walk(node[i], null)
  })(body, null)
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
  MEMBER_CALL: 13,   // receiver of a member call — never a plain property read
}
// Immutable singleton records for uses with no metadata. scanBindingUses
// creates hundreds of thousands of these in self-hosted analysis; sharing by
// kind preserves every read-only consumer while removing one object + HASH
// sidecar per occurrence.
export const BINDING_USE_KIND = 0
export const BINDING_USE_KEY = 1
export const BINDING_USE_OPTIONAL = 2
export const BINDING_USE_COMPUTED = 3
export const BINDING_USE_COMPOUND = 4
export const BINDING_USE_NULL_CMP = 7
export const BINDING_USE_OP = 8
const SIMPLE_USE = Array.from({ length: 13 }, (_, kind) => [kind])
// The records with metadata are read-only too and hold primitives alone, so
// equal ones are shared as well: a member read or write is one record per
// (key, optional/compound), a call argument one per (callee, position), a
// comparison one per nullish-partner flag, a test one per operator. A body
// reads the same few keys many times; the self-compile made one record per
// occurrence (6.5 KB per body).
const MEMBER_READS = Array.from({ length: 8 }, () => new Map())
const memberRead = (key, optional, indexed = false, called = false) => {
  const row = MEMBER_READS[(optional ? 1 : 0) | (indexed ? 2 : 0) | (called ? 4 : 0)]
  let r = row.get(key)
  if (r === undefined) {
    r = [called ? USE.MEMBER_CALL : USE.MEMBER_R, key, optional, indexed && key == null,
      undefined, undefined, undefined, undefined, indexed ? '[]' : optional ? '?.' : '.']
    row.set(key, r)
  }
  return r
}
const MEMBER_WRITES = Array.from({ length: 4 }, () => new Map())
const memberWrite = (key, indexed, compound) => {
  const row = MEMBER_WRITES[(indexed ? 1 : 0) | (compound ? 2 : 0)]
  let r = row.get(key)
  if (r === undefined) {
    r = [USE.MEMBER_W, key, undefined, indexed && key == null, compound,
      undefined, undefined, undefined, indexed ? '[]' : '.']
    row.set(key, r)
  }
  return r
}
const CALL_ARG_BY_CALLEE = new Map(), CALL_ARG_ANY = []
const callArg = (callee, index) => {
  let row = CALL_ARG_ANY
  if (callee != null) {
    row = CALL_ARG_BY_CALLEE.get(callee)
    if (row === undefined) CALL_ARG_BY_CALLEE.set(callee, row = [])
  }
  let r = row[index]
  if (r === undefined) row[index] = r = [USE.CALL_ARG, undefined, undefined, undefined, undefined, callee, index]
  return r
}
const COMPARE_PLAIN = [USE.COMPARE, undefined, undefined, undefined, undefined, undefined, undefined, false]
const COMPARE_NULLISH = [USE.COMPARE, undefined, undefined, undefined, undefined, undefined, undefined, true]
const BOOL_TEST_BY_OP = new Map()
const boolTest = (op) => {
  let r = BOOL_TEST_BY_OP.get(op)
  if (r === undefined) BOOL_TEST_BY_OP.set(op, r = [USE.BOOL_TEST, undefined, undefined, undefined, undefined, undefined, undefined, undefined, op])
  return r
}
export const BINDING_USE_DECLS = 0
export const BINDING_USE_INIT = 1
export const BINDING_USE_USES = 2
// Self-compile-only: see resetProgramFactsCache (program-facts.js) — a fresh
// factStore (src/session.js) swaps in a fresh WeakMap each session so a
// warm-instance compile-clear-compile loop never reads a dangling arena
// pointer out of the old backing storage. This cache lives at
// getFactStore().bindingUses, NOT a private module-level WeakMap, for that
// reason.
//
// No surgical invalidation (session.js DEPS table) — by design, not gap: this
// cache is body-keyed with no widen/narrow-in-place hazard like bodyFacts',
// because nothing ever mutates a body's binding-use SHAPE without also
// changing the body's own AST identity first. Every pass that restructures a
// function's AST does so through analyze.js's setFuncBody, which assigns a
// NEW func.body reference — so a caller reading scanBindingUses(func.body)
// after a rewrite is, by construction, keying off a fresh node this WeakMap
// has never seen. Stale entries for orphaned old bodies just sit unreachable
// until GC; nothing ever reads them.
export function resetBindingUsesCache() { getFactStore().bindingUses = new WeakMap() }
export function invalidateBindingUsesCache(body) { getFactStore().bindingUses.delete(body) }
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

  const summary = new Map()                    // name → [decls, initRhs, uses]
  const slot = (name) => {
    let s = summary.get(name)
    if (!s) { s = [0, undefined, []]; summary.set(name, s) }
    return s
  }
  const use = (name, kind, record) => { slot(name)[BINDING_USE_USES].push(record || SIMPLE_USE[kind]) }

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
      use(t[1], USE.MEMBER_W, memberWrite(typeof t[2] === 'string' ? t[2] : null, false, compound))
      return
    }
    if (o === '[]' && typeof t[1] === 'string') {
      const k = litKey(t[2])
      use(t[1], USE.MEMBER_W, memberWrite(k, true, compound))
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
        if (typeof d === 'string') { if (!inClosure) slot(d)[BINDING_USE_DECLS]++; continue }
        if (Array.isArray(d) && d[0] === '=') {
          const lhs = d[1], rhs = d[2]
          if (typeof lhs === 'string') {
            if (!inClosure) { const s = slot(lhs); s[BINDING_USE_DECLS]++; if (s[BINDING_USE_INIT] === undefined) s[BINDING_USE_INIT] = rhs }
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
        use(recv, USE.MEMBER_R, memberRead(typeof node[2] === 'string' ? node[2] : null, op === '?.'))
      else walk(recv)
      return                                    // node[2] is the property name
    }
    if (op === '[]') {
      const recv = node[1], k = litKey(node[2])
      if (typeof recv === 'string') use(recv, USE.MEMBER_R, memberRead(k, false, true))
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
      else if (Array.isArray(callee) && typeof callee[1] === 'string' &&
          (callee[0] === '.' || callee[0] === '?.' || callee[0] === '[]' || callee[0] === '?.[]')) {
        const indexed = callee[0] === '[]' || callee[0] === '?.[]'
        use(callee[1], USE.MEMBER_CALL, memberRead(indexed ? litKey(callee[2]) : callee[2],
          callee[0] === '?.' || callee[0] === '?.[]', indexed, true))
        if (indexed) val(callee[2])
      } else walk(callee)
      const argNode = node[2]
      if (argNode != null) {
        const args = (Array.isArray(argNode) && argNode[0] === ',') ? argNode.slice(1) : [argNode]
        for (let ai = 0; ai < args.length; ai++) {
          const a = args[ai]
          if (Array.isArray(a) && a[0] === '...') { val(a[1]); continue }
          if (typeof a === 'string') use(a, USE.CALL_ARG, callArg(typeof callee === 'string' ? callee : null, ai))
          else walk(a)
        }
      }
      return
    }
    if (_CMP_OPS.has(op) && node.length === 3) {
      for (let i = 1; i <= 2; i++) {
        const side = node[i]
        if (typeof side === 'string') use(side, USE.COMPARE, _isNullishLit(node[3 - i]) ? COMPARE_NULLISH : COMPARE_PLAIN)
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
      if (typeof c === 'string') use(c, USE.BOOL_TEST, boolTest(op))
      else walk(c)
      return
    }
    if (op === 'if' || op === 'while' || op === '?:') {  // `prepare` normalizes `?` → `?:`
      const c = node[1]
      if (typeof c === 'string') use(c, USE.BOOL_TEST, boolTest(op))
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

  for (const [name, s] of summary) if (s[BINDING_USE_DECLS] === 0 && !trackNames?.has(name)) summary.delete(name)
  // `body` can be null (a module whose every top-level statement got lifted
  // into ctx.funcs.list, e.g. a single `export const f = () => …` leaves
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
  walkAst(body, { enter: n => {
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
  } })
  const out = new Set()
  for (const k of written) if (safe.get(k) === true) out.add(k)
  return out
}

// Per-binding classification shared by scanFlatObjects and scanObjectArrayFacts
// (walk-count design A1, .work/archive/walk-count-design.md §5 item 1) — the exact
// per-candidate logic scanFlatObjects always ran, factored out so the fused
// scan can run it inline inside one scanBindingUses(body) loop instead of a
// second one. Returns the `{names, values, written, selfPreserving}` entry,
// or null when `name` doesn't dissolve.
function flatObjectCandidate(name, s, body) {
  if (s[BINDING_USE_DECLS] !== 1 || !Array.isArray(s[BINDING_USE_INIT])) return null
  // Candidate aggregate: an object literal `{…}` (string keys) or a small array
  // literal `[…]` (index keys "0","1",…). An array dissolves into `name#i` scalar
  // locals exactly like an object — same `.`/`[]` flat hooks, no heap alloc — when
  // every use is a static-index read/write. Capped at FLAT_ARRAY_MAX: a larger
  // literal belongs in one constant data-segment region, not N spilled locals.
  let props
  if (s[BINDING_USE_INIT][0] === '{}') {
    props = staticObjectProps(s[BINDING_USE_INIT].slice(1))
  } else if (s[BINDING_USE_INIT][0] === '[' || s[BINDING_USE_INIT][0] === '[]') {
    const elems = staticArrayElems(s[BINDING_USE_INIT])
    if (!elems || !elems.length || elems.length > FLAT_ARRAY_MAX) return null
    // Holes (`[1,,3]`) and spreads (`[...x]`) aren't a fixed positional schema.
    if (elems.some(e => e == null || (Array.isArray(e) && e[0] === '...'))) return null
    // Only compile-time-constant *value* elements dissolve — number/string/bool/null
    // ("arrays hold JSON values"). A non-literal element (identifier, call, closure,
    // arithmetic on a runtime var) can carry a function/closure whose call-indirect
    // table index binds to the array, not a scalar local — dissolving the slot
    // desyncs the `elem` section. Conservative: any non-constant element keeps the
    // array heap-backed.
    if (!elems.every(e => staticValue(e) !== NO_VALUE)) return null
    props = { names: elems.map((_, i) => String(i)), values: elems }
  } else return null
  const isArr = s[BINDING_USE_INIT][0] !== '{}'
  if (!props || new Set(props.names).size !== props.names.length) return null
  if (props.values.some(v => refsName(v, name, REFS_IN_EXPR))) return null

  // Schema = literal keys ∪ plain literal-key member writes. For an OBJECT such a
  // write monotonically extends the static field universe (the new field reads
  // `undefined` until the write runs, exactly as JS does). An ARRAY has a *fixed*
  // positional schema: `a.length = …` / `a[n] = …` (off the literal indices) resize
  // or grow it — not a field add — so arrays never extend, and any off-schema write
  // (including `.length`, which isn't a slot) disqualifies below. A class
  // instance's literal (jzify/classes.js, branded) has the class's members
  // beside its fields: an access under a member's name is the accessor or the
  // method, never a slot, so it keeps the instance whole.
  // `written` = the keys a MEMBER_W reassigns — a slot is write-once (its
  // value-type is exactly its literal initializer's) iff its key is absent here.
  const cls = props.brand ? ctx.transform.classes?.get(props.brand) : null
  const member = (k) => cls != null && (cls.methods.has(k) || cls.methods.has(k + ACCESSOR_GET) || cls.methods.has(k + ACCESSOR_SET))
  const schema = new Set(props.names)
  const written = new Set()
  for (const u of s[BINDING_USE_USES])
    if (u[BINDING_USE_KIND] === USE.MEMBER_W && !u[BINDING_USE_COMPOUND] &&
        !u[BINDING_USE_COMPUTED] && u[BINDING_USE_KEY] != null && !member(u[BINDING_USE_KEY])) {
      if (!isArr) schema.add(u[BINDING_USE_KEY])
      written.add(u[BINDING_USE_KEY])
    }

  // Flat iff every mention is an in-schema literal-key `.`/`[]` READ, or an
  // in-schema literal-key plain `.`/`[]` WRITE. Any other use kind — `?.`,
  // computed/off-schema key, a class member, reassignment, compound or `delete`
  // member write, `++`/`--`, call arg, closure capture, bare ref — leaves the
  // object live.
  const flat = s[BINDING_USE_USES].every(u =>
    (u[BINDING_USE_KIND] === USE.MEMBER_R && !u[BINDING_USE_OPTIONAL] &&
      !u[BINDING_USE_COMPUTED] && schema.has(u[BINDING_USE_KEY]) && !member(u[BINDING_USE_KEY])) ||
    (u[BINDING_USE_KIND] === USE.MEMBER_W && !u[BINDING_USE_COMPOUND] &&
      !u[BINDING_USE_COMPUTED] && schema.has(u[BINDING_USE_KEY])))
  if (!flat) return null

  // Materialize the parallel {names, values}: literal props first, then each
  // extension field (value `undefined`), in first-write order.
  const names = props.names.slice(), values = props.values.slice()
  for (const k of schema)
    if (!names.includes(k)) { names.push(k); values.push(undefined) }
  const selfPreserving = written.size ? selfPreservingWrittenKeys(body, name, written) : null
  return { names, values, written, selfPreserving }
}

export function scanFlatObjects(body) {
  const cand = new Map()                 // name → {names, values}
  for (const [name, s] of scanBindingUses(body)) {
    const entry = flatObjectCandidate(name, s, body)
    if (entry) cand.set(name, entry)
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
const _SLICE_VIEW_OK = new Set([USE.MEMBER_R, USE.MEMBER_CALL, USE.MEMBER_W, USE.COMPARE, USE.CONCAT, USE.BOOL_TEST])

const _isSliceCall = (n) =>
  Array.isArray(n) && n[0] === '()' && Array.isArray(n[1])
  && n[1][0] === '.' && n[1][2] === 'slice'

// Per-binding classification shared by scanSliceViews and scanObjectArrayFacts
// (walk-count design A1) — factored out for the same reason as
// flatObjectCandidate above.
function sliceViewCandidate(s) {
  return s[BINDING_USE_DECLS] === 1 && _isSliceCall(s[BINDING_USE_INIT]) && s[BINDING_USE_USES].every(u => _SLICE_VIEW_OK.has(u[BINDING_USE_KIND]))
}

export function scanSliceViews(body) {
  const views = new Set()
  for (const [name, s] of scanBindingUses(body)) if (sliceViewCandidate(s)) views.add(name)
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
 * `a[0].push(x)`, never relocates `a` itself, so `a` stays eligible — see arrayUsesSafe.)
 */
const grownOrEscapes = (op) => MUTATE_OPS.has(op) || op === 'delete'
/** Default-deny policies over the already-classified uses. Indexed reads of
 * inner values are safe; a call on the array itself is a distinct use. */
export function arrayUsesSafe(s, own = false) {
  if (!s) return true
  return s[BINDING_USE_USES].every(u => {
    const kind = u[BINDING_USE_KIND], key = u[BINDING_USE_KEY], op = u[BINDING_USE_OP]
    if (kind === USE.MEMBER_R) return key === 'length' || op === '[]'
    if (!own) return false
    if (kind === USE.RETURN) return true
    if (kind === USE.MEMBER_CALL) return op === '.' && key === 'push'
    return kind === USE.MEMBER_W && !u[BINDING_USE_COMPOUND] && (key === 'length' || op === '[]')
  })
}

/**
 * A rest parameter that never escapes is a view of the argument slots
 * (closure-emit.js): no array is built at entry, `rest.length` is the
 * argument count and `rest[i]` reads the slot. The proof admits pure reads
 * (every mention an element read or a length read) with two additions: a
 * mention inside a nested arrow escapes (the closure would capture a value
 * the view does not have), and `for…of`'s lowering (`let a = __iter_arr(rest)`,
 * prepare/handlers.js) binds an alias that reads the same slots, itself held
 * to the same proof. Returns the alias names, or null when the rest escapes.
 */
export function restViewAliases(body, rest) {
  const names = new Set([rest])
  walkAst(body, { enter: n => {
    if (n[0] !== 'let' && n[0] !== 'const') return
    for (let i = 1; i < n.length; i++) {
      const d = n[i]
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && Array.isArray(d[2])
          && d[2][0] === '()' && d[2][1] === '__iter_arr' && d[2][2] === rest) names.add(d[1])
    }
  } })
  const reads = (node) => {
    if (typeof node === 'string') return !names.has(node)
    if (!Array.isArray(node)) return true
    const op = node[0]
    if (op === '=>') { for (const name of names) if (refsName(node, name, REFS_IN_EXPR)) return false; return true }
    if (op === '()') {
      const c = node[1]
      if (names.has(c)) return false
      if (Array.isArray(c) && (c[0] === '.' || c[0] === '?.' || c[0] === '[]' || c[0] === '?.[]') && names.has(c[1])) return false
    }
    if (grownOrEscapes(op)) {
      const t = node[1]
      if (names.has(t)) return false
      if (Array.isArray(t) && (t[0] === '[]' || t[0] === '.' || t[0] === '?.') && names.has(t[1])) return false
    }
    if (op === 'let' || op === 'const' || op === 'var') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (!Array.isArray(d) || d[0] !== '=') continue
        if (names.has(d[1]) && d[1] !== rest && Array.isArray(d[2]) && d[2][0] === '()' && d[2][1] === '__iter_arr' && d[2][2] === rest) continue
        if (!reads(d[2])) return false
      }
      return true
    }
    if ((op === '.' || op === '?.') && names.has(node[1])) return node[2] === 'length'
    if (op === '[]' && names.has(node[1])) return reads(node[2])
    if (op === '...' && names.has(node[1])) return false
    for (let i = 1; i < node.length; i++) if (!reads(node[i])) return false
    return true
  }
  if (!reads(body)) return null
  names.delete(rest)
  return names
}

// Per-binding classification shared by scanNeverGrown and scanObjectArrayFacts
// (walk-count design A1) — factored out for the same reason as
// flatObjectCandidate above.
const freshArrayInit = (s) => s[BINDING_USE_DECLS] === 1 && Array.isArray(s[BINDING_USE_INIT])
  && (s[BINDING_USE_INIT][0] === '[' || (s[BINDING_USE_INIT][0] === '[]' && s[BINDING_USE_INIT].length <= 2))
function neverGrownCandidate(s) {
  // Candidate: a single-declaration binding initialized from a fresh array literal.
  return freshArrayInit(s) && arrayUsesSafe(s)
}

/**
 * Own-name-current array bindings — reads through them may skip the forwarding
 * follow like a neverGrown binding's, though the array DOES grow: every grow
 * runs through the binding's own name and writes the (possibly relocated)
 * pointer back to it, so the binding is never stale. Beyond pure
 * reads this admits exactly the grow sites whose emitters persist the pointer:
 * `a.push(…)` (module/array.js writeBack), `a[i] = v` (emit-assign.js
 * persistBinding) and `a.length = n` (`__arr_set_length` with persist); and
 * `return a`, after which no read of this function follows. A bare alias, a
 * capture, a call argument, a store into a container — anything that could
 * grow the array through another name — disqualifies as for read-only arrays.
 * The fact is NOT neverGrown: the header relocates, so no base hoists across a
 * grow (licm.js keys off neverGrown alone). A nested function holding the name
 * disqualifies too: it captures the pointer by value and a push inside it
 * would relocate behind this function's copy.
 */
const ownCurrentCandidate = (s) => freshArrayInit(s) && arrayUsesSafe(s, true)

export function scanNeverGrown(body) {
  const out = new Set()
  for (const [name, s] of scanBindingUses(body)) if (neverGrownCandidate(s)) out.add(name)
  return out
}

/** Classify object and array storage from one cached binding-use census.
 * Array policies inspect each binding's uses, never rescan the whole body. */
export function scanObjectArrayFacts(body) {
  let flatObjects = null, sliceViews = null, neverGrown = null, ownCurrent = null
  for (const [name, s] of scanBindingUses(body)) {
    const entry = flatObjectCandidate(name, s, body)
    if (entry) (flatObjects ||= new Map()).set(name, entry)
    if (sliceViewCandidate(s)) (sliceViews ||= new Set()).add(name)
    if (neverGrownCandidate(s)) (neverGrown ||= new Set()).add(name)
    else if (ownCurrentCandidate(s)) (ownCurrent ||= new Set()).add(name)
  }
  return [flatObjects || EMPTY_SCAN_MAP, sliceViews || EMPTY_SCAN_SET, neverGrown || EMPTY_SCAN_SET, ownCurrent || EMPTY_SCAN_SET]
}

// Both `Array(n)` and `new Array(n)` normalize to a `new.Array` call by prepare; an
// empty literal stays `['[]', null]`. (Typed ctors become `new.Float64Array` etc. — the
// exact-match on `new.Array` keeps them out.) A decl so initialized described its own
// initial contents: the schema census's push observations may settle on it.
export const isFreshArrayCtor = (rhs) =>
  Array.isArray(rhs) && (
    (rhs[0] === '[]' && rhs.length <= 2) ||             // empty `[]`
    (rhs[0] === '()' && rhs[1] === 'new.Array')         // `Array(n)` / `new Array(n)` / `Array()`
  )

/**
 * Narrow uint32 accumulator locals to unsigned i32. A local qualifies when its
 * initializer is a non-negative integer literal in [0, 2^32) or itself a
 * `(…) >>> k` (`const u = s >>> 0`, the xorshift draw) and every
 * reassignment is `name = (…) >>> k` — that WRITE invariant alone proves the
 * local always holds a canonical uint32 bit pattern (ToUint32 is idempotent:
 * re-masking an already-masked value is a no-op), independent of how the
 * local is later read. Names that escape the invariant itself (closures — a
 * captured binding must keep the outer f64 capture convention; `++`/`--`; a
 * reassignment whose RHS isn't `>>>`-shaped) are disqualified; everything
 * else — bare `return`, arithmetic, relational/equality compares, division —
 * reads the proven bit pattern as-is. Returns the qualifying set; callers
 * retype `locals` to 'i32' and tag `readVar` reads `.unsigned`, so every
 * consumer that already dispatches on that flag (asF64 → convert_i32_u,
 * cmpOp/+/-/*|% → f64-widen by true sign, foldConst → skip) sees its true
 * [0, 2^32) value instead of silently reboxing the bit pattern signed.
 */
const EMPTY_SCAN_SET = new Set()
const EMPTY_SCAN_MAP = new Map()
export function narrowUint32(body, locals) {
  const states = takeScratchMap()
  try { return narrowUint32In(body, locals, states) } finally { releaseScratchMap(states) }
}
function narrowUint32In(body, locals, states) {
  // One state map replaces initLit/disq/seen's three hash tables.
  // 1 = one valid u32 initializer and no unsafe write; 0 = disqualified.
  const isU32Lit = e => {
    const v = typeof e === 'number' ? e
      : Array.isArray(e) && e[0] == null && typeof e[1] === 'number' ? e[1] : NaN
    return Number.isInteger(v) && v >= 0 && v < 4294967296
  }
  const banNames = n => {
    if (typeof n === 'string') states.set(n, 0)
    else if (Array.isArray(n)) for (let i = 1; i < n.length; i++) banNames(n[i])
  }
  const walk = (node, inClosure) => {
    if (typeof node === 'string') { if (inClosure) states.set(node, 0); return }
    if (!Array.isArray(node)) return
    const op = node[0]
    if (typeof op !== 'string') {
      for (let i = 1; i < node.length; i++) walk(node[i], inClosure)
      return
    }
    if (op === '=>') { for (let i = 1; i < node.length; i++) walk(node[i], true); return }
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
          const nm = d[1]
          if (states.has(nm) || inClosure || !(isU32Lit(d[2]) || (Array.isArray(d[2]) && d[2][0] === '>>>'))) states.set(nm, 0)
          else states.set(nm, 1)
          walk(d[2], inClosure)
        } else if (typeof d === 'string') states.set(d, 0)
        else if (Array.isArray(d) && d[0] === '=') { banNames(d[1]); walk(d[2], inClosure) }
      }
      return
    }
    if ((op === '++' || op === '--') && typeof node[1] === 'string') { states.set(node[1], 0); return }
    if (ASSIGN_OPS.has(op)) {
      const lhs = node[1]
      if (typeof lhs === 'string') {
        if (op !== '=' || inClosure || !(Array.isArray(node[2]) && node[2][0] === '>>>')) states.set(lhs, 0)
      } else banNames(lhs)
      walk(node[2], inClosure)
      return
    }
    for (let i = 1; i < node.length; i++) walk(node[i], inClosure)
  }
  walk(body, false)
  let result = null
  for (const nm of states.keys()) {
    if (states.get(nm) !== 1) continue
    const t = locals.get(nm)
    if (t !== 'i32' && t !== 'f64') continue
    locals.set(nm, 'i32')
    ;(result ||= new Set()).add(nm)
  }
  return result || EMPTY_SCAN_SET
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
 * THIRD requirement, layered on top of both sources above (.work/archive/todo.md
 * KNOWN GAP #1): membership alone is NOT sufficient — a var is
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
// blaming either). Without this exemption these ops fall through to the
// generic value-mode walker (they're not affine, not `[]`, not a math-fn
// call, not in ESCAPE_EDGE_OPS), which walks BOTH node[1] (the target, a
// bare string) AND node[2] in 'value' mode — misreading the compound-
// assign's implicit self-read of the target as a bare escape and blaming it
// (`x ^= x << 7` in a sieve/PRNG-style bitwise kernel: `x` never compared,
// so blamed on every such statement, disqualifying an otherwise textbook
// ESCAPE_SAFE_ROOT_OPS var from i32 storage). Target skipped here
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
// callback (`.forEach(x => { g = x })`) is not lifted to its own ctx.funcs.list
// entry at prepare time (only named function/arrow bindings are), so it stays
// an inline `=>` node in the enclosing body and would be invisible to a scan
// that stops there. See collectBareEscapes' own crossClosure doc.
function collectComparedNames(body, crossClosure) {
  let names = null
  const enter = (node) => {
    if (node[0] === '=>') { if (crossClosure) walkAst(node[2], { enter }); return false }
    if (CMP_OPS_SET.has(node[0])) {
      if (typeof node[1] === 'string') (names ||= new Set()).add(node[1])
      if (typeof node[2] === 'string') (names ||= new Set()).add(node[2])
    }
  }
  walkAst(body, { enter })
  return names || EMPTY_SCAN_SET
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
 * and .work/archive/todo.md's KNOWN GAP #1 entry for the full diagnosis.
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
 * inside an inline closure (never lifted to its own ctx.funcs.list entry,
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
  let escaped = null
  const compared = collectComparedNames(body, crossClosure)
  const walk = (node, mode) => {   // mode: 'idx' | 'edge' | 'value'
    // A BARE NAME leaf must apply the SAME `escapeInRangeI32` proof (rule a,
    // doc above) the generic array-node fallthrough below applies to a
    // COMPOUND value-mode node — checking it HERE, not only at the compound
    // level, is what lets a name whose own closed hull IS provable
    // (`repOf(name)?.range`, stamped by processDecl's early declRange pass for
    // any never-reassigned decl — see analyze.js) clear an escaping use that
    // sits under an operator `intExprRange` doesn't model (division:
    // `(dq/65536)|0` walks `dq` in 'value' mode directly, since `/` isn't
    // ESCAPE_SAFE_ROOT_OPS/AFFINE_INDEX_OPS and intExprRange has no '/' case
    // to hull the OUTER node — the ONLY chance to prove `dq` itself safe is
    // checking the LEAF's own range, which this line does). Same proof, same
    // soundness contract as the compound-node check, applied one level
    // earlier: a reassigned accumulator (`id` after `id *= 100000`) gets no
    // processDecl range stamp either way, so this adds no new tolerance.
    if (typeof node === 'string') { if (mode === 'value' && !compared.has(node) && !escapeInRangeI32(node)) (escaped ||= new Set()).add(node); return }
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
  return escaped || EMPTY_SCAN_SET
}

// === Co-induction accumulator fact (INDUCTION-VARIABLE FACT project) ===
// A local declared BEFORE a loop, mutated ONLY inside its body by a compile-
// time-constant step, executes at most the loop's own trip count — so its
// range is `[init, init + step × maxTrips]`, sign-aware, whenever the loop's
// own trip count is provable (static.js's forCounterRange). base64's
// `encode`/`decode` `op` (`let op = 0` before `for(let i=0;i+3<=n;i+=3)`,
// stepped `op += 4` once per iteration, its final value bare-`return`ed) is
// the motivating shape — see .work/archive/todo.md's design entry for the full
// rationale.
//
// STAMPED HERE (analyze time, via `updateRep`, the SAME durable channel
// processDecl's own never-reassigned declRange stamp uses just above in
// analyze.js) rather than installed as an emit-time `ctx.func.refinements`
// entry: the consumer that actually decides `op`'s WASM STORAGE TYPE is
// `widenLocalTypes`'s Pass D (this file's own `collectBareEscapes`/
// `escapeInRangeI32`, called from analyze.js — a phase that completes
// BEFORE emit.js ever runs), not an emit-time expression-level proof. A
// durable `repOf(name).range` stamp is picked up by `intExprRange` (static.js)
// unconditionally — no `ctx.func.refinements` needed — so ONE stamp here
// serves Pass D's local-type decision AND every later emit-time consumer
// (`addLiteralFitsI32`/`boundedHi` etc.) uniformly. Sound as a WHOLE-FUNCTION
// fact, not just "sound inside the loop": `writesOutsideLoop` (below) already
// proves nothing touches `name` before loop entry or after loop exit, so its
// value stays within this same hull for the function's entire lifetime —
// the exact durability `updateRep`'s `range` field already assumes.

/** Every bare-name MUTATE_OPS write target inside `root` (any depth, any
 *  shape) — candidates for the co-induction scan below. Over-inclusive by
 *  design (a name from a nested/conditional/shadowed write is filtered out
 *  downstream by collectConstStep/writesOutsideLoop, not here). Mirrors
 *  isReassigned's own 'let'/'const' special-case: a declarator's `=` binds
 *  the name, it doesn't write it. */
function collectMutatedNames(root, out = new Set()) {
  if (!Array.isArray(root)) return out
  const op = root[0]
  if (MUTATE_OPS.has(op) && typeof root[1] === 'string') out.add(root[1])
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < root.length; i++) {
      const d = root[i]
      if (Array.isArray(d) && d[0] === '=' && d[2] != null) collectMutatedNames(d[2], out)
    }
    return out
  }
  for (let i = 1; i < root.length; i++) collectMutatedNames(root[i], out)
  return out
}

/** Does `name` get WRITTEN anywhere in `root` OUTSIDE `exclude`'s subtree
 *  (reference identity, not structural equality — `exclude` is the loop's
 *  own body node, still embedded in `root` at this point in the pipeline)?
 *  Mirrors isReassigned's own tree walk verbatim, plus the exclude-subtree
 *  skip. A write here anywhere else in the enclosing function invalidates
 *  the whole fact — the hull's `init` value assumes NOTHING touches `name`
 *  between its declaration and loop entry, or after the loop exits. */
function writesOutsideLoop(root, exclude, name) {
  if (!Array.isArray(root) || root === exclude) return false
  const op = root[0]
  if (MUTATE_OPS.has(op) && root[1] === name) return true
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < root.length; i++) {
      const d = root[i]
      if (Array.isArray(d) && d[0] === '=' && d[2] != null && writesOutsideLoop(d[2], exclude, name)) return true
    }
    return false
  }
  for (let i = 1; i < root.length; i++) if (writesOutsideLoop(root[i], exclude, name)) return true
  return false
}

/** The unique `let`/`const NAME = initExpr` declarator's initializer,
 *  searched anywhere in `root` OUTSIDE `exclude`'s subtree — the
 *  co-induction candidate's OWN declaration (temporal-dead-zone scoping in
 *  valid JS guarantees it textually precedes any use, so no separate
 *  position check is needed). Returns null for zero OR more-than-one match
 *  (ambiguous — possibly a real shadow in a disjoint block; this compiler's
 *  flat per-function local model makes that rare, but bail rather than
 *  guess) and for an uninitialized `let NAME` (nothing to prove a range
 *  from). */
function findOuterDeclInit(root, exclude, name) {
  let found, count = 0
  ;(function walk(n) {
    if (!Array.isArray(n) || n === exclude) return
    if (n[0] === 'let' || n[0] === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (Array.isArray(d) && d[0] === '=' && d[1] === name) { found = d[2]; count++ }
      }
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  })(root)
  return count === 1 ? found : null
}

/** Per-iteration constant-step delta for `name` inside `node` (this loop's
 *  body) — `{P, N, D}`: P/N are the total POSITIVE/NEGATIVE step magnitudes
 *  straight-line execution accumulates in one pass (P, N ≥ 0), D = P − N the
 *  net. Tracking P/N separately (not just D) is what makes a `+K; …; −M`
 *  pair inside one iteration sound: the true value can transiently reach
 *  `start + P` or dip to `start − N` mid-iteration even though the NET
 *  motion is smaller — the whole-loop hull built from this (stampCoInduction-
 *  Ranges, below) folds BOTH bounds in, not just the net.
 *  Returns null (poison — no fact) for: any write to `name` that isn't
 *  `++`/`--`/`+=K`/`-=K` (K a compile-time int — a plain `=` reset or a
 *  non-constant compound assign changes the whole shape of the value, not
 *  just its magnitude); a step inside an `if`/`?:` whose two arms don't
 *  yield the IDENTICAL `{P,N,D}` (non-deterministic per-iteration motion —
 *  differing-but-individually-provable arms, e.g. `+1` vs `+2`, are a named,
 *  conscious scope boundary — see the design doc — not unioned into an
 *  interval-valued step); any reference to `name` inside a nested loop/
 *  switch/try/closure (its own iteration count is unknown here); a nested
 *  decl that REBINDS `name` (a shadow — genuinely a different variable past
 *  that point). */
function collectConstStep(node, name) {
  if (!Array.isArray(node)) return { P: 0, N: 0, D: 0 }
  const op = node[0]
  if (MUTATE_OPS.has(op) && node[1] === name) {
    if (op === '++') return { P: 1, N: 0, D: 1 }
    if (op === '--') return { P: 0, N: 1, D: -1 }
    if (op === '+=') { const k = constIntExpr(node[2]); return Number.isInteger(k) ? (k >= 0 ? { P: k, N: 0, D: k } : { P: 0, N: -k, D: k }) : null }
    if (op === '-=') { const k = constIntExpr(node[2]); return Number.isInteger(k) ? (k >= 0 ? { P: 0, N: k, D: -k } : { P: -k, N: 0, D: -k }) : null }
    return null   // '=' or another compound op — not a provable constant step
  }
  if (op === 'let' || op === 'const') {
    let P = 0, N = 0, D = 0
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (d === name) return null                                     // bare uninitialized shadow decl
      if (Array.isArray(d) && d[1] === name) return null               // shadow — a fresh `name` rebinds here
      if (Array.isArray(d) && d[0] === '=') {
        const s = collectConstStep(d[2], name)
        if (s == null) return null
        P += s.P; N += s.N; D += s.D
      }
    }
    return { P, N, D }
  }
  if (op === 'if' || op === '?:') {
    const c = collectConstStep(node[1], name)
    if (c == null || c.P || c.N) return null   // a write to `name` inside the CONDITION itself — reject, too exotic
    const t = collectConstStep(node[2], name)
    const e = node.length > 3 && node[3] !== undefined ? collectConstStep(node[3], name) : { P: 0, N: 0, D: 0 }
    if (t == null || e == null) return null
    if (t.D !== e.D || t.P !== e.P || t.N !== e.N) return null   // arms disagree — non-deterministic per-iteration motion
    return t
  }
  if (op === 'for' || op === 'for-in' || op === 'for-of' || op === 'while' || op === 'do'
      || op === 'switch' || op === 'try' || op === '=>')
    return refsName(node, name, REFS_IN_EXPR) ? null : { P: 0, N: 0, D: 0 }
  let P = 0, N = 0, D = 0
  for (let i = 1; i < node.length; i++) {
    const s = collectConstStep(node[i], name)
    if (s == null) return null
    P += s.P; N += s.N; D += s.D
  }
  return { P, N, D }
}

/** Scan `body` (a whole function body, analyze-time — see this section's own
 *  header doc for why here and not emit.js) for co-induction accumulators
 *  and durably stamp each proven one via `updateRep(name, {range})`. Called
 *  once from analyzeBody, AFTER the top-down decl walk (so module consts and
 *  earlier never-reassigned decls are already resolvable through
 *  intExprRange) and BEFORE `widenLocalTypes` (so Pass D's bare-escape check
 *  sees the stamp). Never overwrites an existing rep range (defensive — a
 *  never-reassigned decl's own declRange stamp, if one somehow existed here,
 *  takes precedence; in practice the two are mutually exclusive since
 *  processDecl only stamps non-reassigned names and this only considers
 *  MUTATE_OPS-written ones). */
// A name written inside any closure of `body` can change at any call.
const closureWrites = (body, name) => some(body, n => n[0] === '=>' && isReassigned(n, name))

export function stampCoInductionRanges(body) {
  walkAst(body, { enter: node => {
    if (node[0] === 'for' && node.length === 5) {
      const [, init, cond, step, loopBody] = node
      const counterName = guardCounterName(cond)
      const counterRange = counterName ? forCounterRange(init, cond, step, counterName) : null
      if (counterRange && counterRange.step > 0) {
        const trips = Math.floor((counterRange[1] - counterRange[0]) / counterRange.step) + 1
        if (trips > 0) {
          for (const name of collectMutatedNames(loopBody)) {
            if (name === counterName || repOf(name)?.range) continue
            const initExpr = findOuterDeclInit(body, loopBody, name)
            if (initExpr == null) continue
            const initRange = intExprRange(initExpr)
            if (!initRange) continue
            if (writesOutsideLoop(body, loopBody, name)) continue
            const delta = collectConstStep(loopBody, name)
            if (delta == null) {
              // Not a fixed per-iteration step (arms that advance differently,
              // a nested counted loop): a monotone cursor still has the budget
              // hull `[init, init + trips × maxAdvance]` when every write is a
              // positive constant step (maxAdvanceBudget, canonical-bounds.js).
              const adv = maxAdvanceBudget(loopBody, name, { constInt: constIntExpr, evRange: intExprRange, closureWrites: EMPTY_SCAN_SET, MUTATE_OPS })
              const hi = adv != null ? initRange[1] + trips * adv : null
              if (adv != null && adv > 0 && Number.isFinite(hi) && !closureWrites(body, name)) updateRep(name, { range: [initRange[0], hi] })
              continue
            }
            if (delta.P === 0 && delta.N === 0 && delta.D === 0) continue
            const { P, N, D } = delta
            const lastStart = D * (trips - 1)
            const lo = Math.min(initRange[0], initRange[0] + lastStart) - N
            const hi = Math.max(initRange[1], initRange[1] + lastStart) + P
            if (Number.isFinite(lo) && Number.isFinite(hi)) updateRep(name, { range: [lo, hi] })
          }
        }
      }
    }
  } })
}

const isDynamicIndexNode = n => n[0] === '[]' && !isLiteralStr(n[2])
// `bareEscapesOf` (optional): a zero-arg thunk returning `collectBareEscapes(body,
// locals)`, for a caller (widenLocalTypes) that ALSO needs that same fact for its
// own Pass D and would otherwise trigger it twice — collectBareEscapes is itself a
// full-body walk plus a collectComparedNames sub-walk, so a shared, once-computed
// value (the caller's thunk typically memoizes) avoids a real duplicate traversal
// whenever both consumers fire. Defaults to a fresh call, matching prior behavior
// exactly for any other caller.
export function collectI32SafeIndexVars(body, locals, bareEscapesOf = () => collectBareEscapes(body, locals)) {
  if (!some(body, isDynamicIndexNode)) return EMPTY_SCAN_SET
  const defs = takeScratchMap()
  try { return collectI32SafeIndexVarsIn(body, locals, bareEscapesOf, defs) } finally { releaseScratchMap(defs) }
}
function collectI32SafeIndexVarsIn(body, locals, bareEscapesOf, defs) {
  const safe = new Set()
  let changed = false
  // Add the names reachable from `node` through affine ops only to `safe`,
  // noting whether any was new.
  const addAffine = (node) => {
    if (typeof node === 'string') { if (!safe.has(node)) { safe.add(node); changed = true } return }
    if (!Array.isArray(node)) return
    if (AFFINE_INDEX_OPS.has(node[0])) for (let i = 1; i < node.length; i++) addAffine(node[i])
  }
  // Pass 1: record assignment edges (back-prop; target and rhs as two parallel
  // lists) + a name→definitions map (for the integer-shape test). `+= …`
  // reconstructs to `name + …` so its shape includes the prior value.
  const edgeTargets = [], edgeSources = []
  const addEdge = (name, rhs) => { edgeTargets.push(name); edgeSources.push(rhs) }
  const addDef = (name, rhs) => { (defs.get(name) ?? defs.set(name, []).get(name)).push(rhs) }
  const collect = (node) => {
    const op = node[0]
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') { addEdge(d[1], d[2]); addDef(d[1], d[2]) }
      }
    } else if (op === '=' && typeof node[1] === 'string') { addEdge(node[1], node[2]); addDef(node[1], node[2]) }
    else if ((op === '+=' || op === '-=' || op === '*=') && typeof node[1] === 'string') { addEdge(node[1], node[2]); addDef(node[1], [op[0], node[1], node[2]]) }
    if (op === '=>') return false
  }
  walkAst(body, { enter: collect })

  // Integer-shaped AND i32-representable: provably an integer through `+ - * << u-`
  // (AFFINE_INDEX_OPS — excludes `/`/`**`/fractional ops) over leaves that are
  // i32-typed, i32-range integer literals, or other integer-shaped locals. Lets a
  // hoisted offset `let o = y*w` (f64-typed product, integer-valued) qualify as an
  // index leaf before narrowing. A fractional leaf, an out-of-i32-range literal, or
  // a param of unknown type disqualifies — so no truncation and no f64.const→i32.
  // `seen` holds the names on the current definition path: a name is added
  // before its definitions are checked and removed after, so the set is what
  // it was at entry whenever a call returns, and one set serves every call.
  const seen = new Set()
  const isIntShaped = (node) => {
    if (typeof node === 'number') return isI32Lit(node)
    if (typeof node === 'string') {
      if (exprType(node, locals) === 'i32') return true
      if (seen.has(node)) return true  // recursion through a self-step — other defs still gate
      const ds = defs.get(node)
      if (!ds || !ds.length) return false  // param / unknown source — not provably integer
      seen.add(node)
      const r = ds.every(d => isIntShaped(d))
      seen.delete(node)
      return r
    }
    if (!Array.isArray(node)) return false
    const op = node[0]
    if (op == null) return isI32Lit(node[1])  // [null, value] literal
    if (!AFFINE_INDEX_OPS.has(op)) return false
    for (let i = 1; i < node.length; i++) if (node[i] != null && !isIntShaped(node[i])) return false
    return true
  }

  // Pass 2: seed from array indices already i32 OR integer-shaped (the latter
  // rescues hoisted integer offsets the type pass left at f64). A fractional index
  // (`mem[y*w+x]` with fractional `w`) is not integer-shaped → still truncs per
  // access and is left to widen, preserving the prior guard.
  const seed = (node) => {
    const op = node[0]
    if (op === '[]' && !isLiteralStr(node[2]) && (exprType(node[2], locals) === 'i32' || isIntShaped(node[2]))) addAffine(node[2])
    if (op === '=>') return false
  }
  walkAst(body, { enter: seed })

  // Back-propagate to a fixpoint: feeders of a bounded index var are bounded.
  changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < edgeTargets.length; i++) if (safe.has(edgeTargets[i])) addAffine(edgeSources[i])
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
  for (const n of bareEscapesOf()) safe.delete(n)
  // Promote integer-shaped index feeders the type pass left at f64 (a hoisted
  // `o = y*w`). The byte offset must fit i32-addressable memory, so the i32-wrap
  // residue reproduces the true in-bounds value — same contract as inline `a[y*w+x]`.
  // Skip boxed (closure-captured) cells — those live as f64 in memory.
  for (const n of safe) if (locals.get(n) === 'f64' && !ctx.func.boxed?.has(n) && isIntShaped(n)) locals.set(n, 'i32')
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
  if (!some(body, isDynamicIndexNode)) return EMPTY_SCAN_SET
  let set = null
  const addAffine = (node) => {
    if (typeof node === 'string') { (set ||= new Set()).add(node); return }
    if (Array.isArray(node) && AFFINE_INDEX_OPS.has(node[0])) for (let i = 1; i < node.length; i++) addAffine(node[i])
  }
  walkAst(body, { enter: node => {
    if (node[0] === '[]' && !isLiteralStr(node[2]) && exprType(node[2], locals) === 'f64') addAffine(node[2])
    if (node[0] === '=>') return false
  } })
  return set || EMPTY_SCAN_SET
}
