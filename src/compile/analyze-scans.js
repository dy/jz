/**
 * Body scan passes — free vars, mutations, binding-use taxonomy, SRoA/slice eligibility.
 * @module analyze-scans
 */

import { ASSIGN_OPS, collectParamNames, extractParams, REFS_IN_EXPR, refsName, T, isLiteralStr } from '../ast.js'
import { ctx } from '../ctx.js'
import { staticObjectProps, staticArrayElems, staticIndexKey, staticValue, NO_VALUE } from '../static.js'
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
let _bindingUsesCache = new WeakMap()
// Self-host-only: see resetProgramFactsCache (program-facts.js) — swap in a fresh
// WeakMap so a warm-instance compile-clear-compile loop never reads a dangling
// arena pointer out of the old backing storage.
export function resetBindingUsesCache() { _bindingUsesCache = new WeakMap() }
const _CMP_OPS = new Set(['==', '!=', '===', '!==', '<', '>', '<=', '>='])
const _isNullishLit = (e) =>
  e === 'null' || e === 'undefined' ||
  (Array.isArray(e) && e[0] == null && (e[1] === null || e[1] === undefined))

export function scanBindingUses(body) {
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
// Largest array literal that dissolves into scalar slots. Beyond this a single
// constant data segment is cheaper than N locals (+ the per-slot init prologue).
const FLAT_ARRAY_MAX = 8

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
    cand.set(name, { names, values, written })
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
const grownOrEscapes = (op) => ASSIGN_OPS.has(op) || op === '++' || op === '--' || op === 'delete'
function safeReads(node, name) {
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
const isFreshArrayCtor = (rhs) =>
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
 */
// An integer literal that fits signed i32 — the only constant a promoted i32
// local may hold. A larger integer (`0xFFFFFFFF`, a NaN-box mask) is emitted as
// an f64.const, so treating it as an i32 leaf would store f64 into an i32 local.
const isI32Lit = (v) => typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647

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
