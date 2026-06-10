/**
 * Module-scope planning — type-narrowing and structural rewrites of
 * module-level bindings. Runs once per program (post fact-collection,
 * pre whole-program narrowing) under `plan()`.
 *
 * Concerns owned here (each operates on `ctx.scope` / `ctx.func` / `ctx.schema`,
 * not on AST shape — except `flattenFuncNamespaces` and `devirtGlobalCalls`,
 * which mutate the AST as their final step):
 *
 *   - `inferModuleLetTypes`        — module-level `let` typed-array union
 *   - `unboxConstTypedGlobals`     — const typed-array → unboxed i32 offset
 *   - `inferModuleIntGlobals`      — purpose-focused f64→i32 numeric demotion
 *   - `flattenFuncNamespaces`      — `f.prop` slot SROA + dead-write drop
 *   - `devirtGlobalCalls`          — `call_indirect $global` → direct `call`
 *   - `materializeAutoBoxSchemas`  — schema registration for object propMap
 *   - `resolveClosureWidth`        — uniform closure ABI width
 *   - `canSkipWholeProgramNarrowing` — fast-path gate for monomorphic programs
 *
 * @module compile/plan/scope
 */

import { ctx, warn } from '../../ctx.js'
import { ASSIGN_OPS, T, refsAny } from '../../ast.js'
import { VAL, updateGlobalRep } from '../../reps.js'
import { typedElemCtor, ternaryCtorOfRhs, MIXED_CTORS } from '../../type.js'
import { typedElemAux } from '../../../layout.js'
import { MAX_CLOSURE_ARITY, UNDEF_WAT } from '../../ir.js'
import { analyzeFuncNamespaces } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'

// `scanGlobalValueFacts` was deleted — prepare's depth-0 catch (calling
// `recordGlobalRep` from src/infer.js) is the authoritative pass and a
// strict superset of what this top-level walker observed.

// Flow-insensitive type inference for module-level `let` bindings whose
// initial RHS doesn't pin a type (most often `let mem;` followed later by
// `mem = new TypedArray(...)` inside an init function). Without this the
// read site has to runtime-check the NaN-box tag on every access — game-of-life's
// inner step does that 9× per cell, blowing up the hot loop. We union RHS types
// across every assignment (initial decl + every `name = …` in any function);
// if every observed RHS is either a typed-array ctor of the same kind, a known
// VAL.TYPED binding of the same ctor, or null/undefined, the binding is
// monomorphically VAL.TYPED. Anything else (literal number, non-typed call,
// mixed ctors) clears the candidacy, keeping the read site polymorphic.
export const inferModuleLetTypes = (ast) => {
  if (!ctx.scope.userGlobals) return
  // candidates: name → { ctor: string|null, valid: true } | { valid: false }
  // valid=true with ctor=null means "still no positive evidence"; we promote
  // only when ctor is non-null at the end. Assignments to nullish (undef/null)
  // don't change ctor — they're consistent with any typed-array value.
  // Per-candidate state in PARALLEL maps, not a shared mutable `{ctor, valid}` object
  // per name: `ctorOf` holds the positive ctor evidence (name absent ⇒ not a candidate),
  // `invalid` the demoted names. A prior shape stored one mutable object per name in a
  // Map; under self-host those per-name objects aliased (every candidate ended up sharing
  // one record), so a second global of a different kind invalidated the typed one and any
  // two-global program lost its typed-array fast path. String/Set values can't alias.
  const ctorOf = new Map()
  const invalid = new Set()
  for (const name of ctx.scope.userGlobals) ctorOf.set(name, null)

  const isNullishLit = (e) => e == null || e === 'undefined' || e === 'null'
    || (Array.isArray(e) && e[0] == null && (e[1] === undefined || e[1] === null))

  const observe = (name, rhs) => {
    if (!ctorOf.has(name) || invalid.has(name)) return
    if (isNullishLit(rhs)) return
    // Resolve typed-array ctor from `new TypedArrayCtor(...)`, ternary of typed,
    // or a reference to a name we already know is typed.
    let ctor = typedElemCtor(rhs) ?? ternaryCtorOfRhs(rhs)
    if (ctor === MIXED_CTORS) { invalid.add(name); return }
    if (!ctor && typeof rhs === 'string') {
      if (ctx.scope.globalValTypes?.get(rhs) === VAL.TYPED)
        ctor = ctx.scope.globalTypedElem?.get(rhs) ?? null
    }
    if (!ctor) { invalid.add(name); return }
    const prev = ctorOf.get(name)
    if (prev && prev !== ctor) { invalid.add(name); return }
    ctorOf.set(name, ctor)
  }

  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=' && typeof node[1] === 'string' && ctorOf.has(node[1])) observe(node[1], node[2])
    if ((op === 'let' || op === 'const') && node.length > 1) {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && ctorOf.has(d[1]))
          observe(d[1], d[2])
      }
    }
    // Compound-assigns (`+=`, etc.) to a typed-array binding can't preserve
    // the typed-array kind — invalidate.
    if (ASSIGN_OPS.has(op) && op !== '=' && typeof node[1] === 'string' && ctorOf.has(node[1]))
      invalid.add(node[1])
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(ast)
  for (const f of ctx.func.list) if (f.body && !f.raw) walk(f.body)

  for (const [name, ctor] of ctorOf) {
    if (invalid.has(name) || !ctor) continue
    if (ctx.scope.globalValTypes?.get(name) === VAL.TYPED) continue
    ;(ctx.scope.globalValTypes ||= new Map()).set(name, VAL.TYPED)
    ;(ctx.scope.globalTypedElem ||= new Map()).set(name, ctor)
  }
}

export const unboxConstTypedGlobals = () => {
  if (!ctx.scope.globalTypedElem || !ctx.scope.consts) return
  for (const [name, ctor] of ctx.scope.globalTypedElem) {
    if (!ctx.scope.consts.has(name)) continue
    if (ctx.scope.globalValTypes?.get(name) !== VAL.TYPED) continue
    const aux = typedElemAux(ctor)
    if (aux == null) continue
    const decl = ctx.scope.globals.get(name)
    if (typeof decl !== 'string' || !decl.includes('mut f64')) continue
    ctx.scope.globals.set(name, `(global $${name} (mut i32) (i32.const 0))`)
    ctx.scope.globalTypes.set(name, 'i32')
    updateGlobalRep(name, { ptrKind: VAL.TYPED, ptrAux: aux })
  }
}

// Integer-global type inference — narrow purpose-focused numeric module globals
// (counters, sizes, strides, indices: `N`, `width`, `offset`, …) from f64 to i32.
//
// Principle: in purpose-focused code an integer-initialized numeric global is an
// integer unless an assignment *proves* it fractional. Sizes/strides/indices are
// the overwhelming majority; demanding the user annotate them (asm.js `x | 0`)
// defeats clean code. So we assume i32 and demote only on positive proof of a
// fraction — a non-integer literal, `/` or `**`, a float-valued `Math.*`, or a
// reference to an already-fractional value. (jz already truncates fractional
// array indices, so a stray fraction in an integer slot is a pre-existing bug,
// not one this introduces; a future advisory can flag it.)
//
// The payoff cascades: an i32 `width` makes `mem[y*width+x]` a fully-i32 index
// (the per-access `trunc_sat` and the index-counter widen both vanish), and an
// i32 `N` makes the loop guard `i < N` pure-i32 (no per-iteration convert),
// unlocking SIMD — all from idiomatic source, no hints.
const FRACTIONAL_MATH = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'sqrt', 'cbrt', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p',
  'pow', 'hypot', 'random', 'fround',
])
const INT_COERCE_OPS = new Set(['&', '|', '^', '<<', '>>', '>>>', '~'])
const COMPARE_OPS = new Set(['<', '>', '<=', '>=', '==', '===', '!=', '!==', '!', 'in', 'instanceof'])
const FRAC_COMPOUND = new Set(['/=', '**='])
const INT_COMPOUND = new Set(['&=', '|=', '^=', '<<=', '>>=', '>>>='])

export const inferModuleIntGlobals = (ast) => {
  if (!ctx.scope.userGlobals?.size) return
  // Candidates: mutable f64 scalar globals with positive numeric-initializer
  // evidence and not a function. (const-folded / typed-pointer globals already
  // carry a non-`(mut f64)` decl, so they're excluded.)
  const candidates = new Set()
  for (const name of ctx.scope.userGlobals) {
    const decl = ctx.scope.globals.get(name)
    if (typeof decl !== 'string' || !decl.includes('(mut f64)')) continue
    if (ctx.scope.globalValTypes?.get(name) !== VAL.NUMBER) continue
    if (ctx.func.names?.has(name)) continue
    candidates.add(name)
  }
  if (!candidates.size) return

  const fractional = new Set()
  const refIsFractional = (ref) => {
    if (candidates.has(ref)) return fractional.has(ref)
    const gt = ctx.scope.globalTypes?.get(ref)
    if (gt === 'i32') return false
    if (gt === 'f64') {
      const vt = ctx.scope.globalValTypes?.get(ref)
      return vt === VAL.NUMBER || vt == null  // a fractional f64 number; pointers aren't
    }
    return false  // param / local / unknown numeric → assume integer
  }
  // Does `e` provably evaluate to a non-integer? Integer-coercing ops (bitwise,
  // shifts) and comparisons launder any fraction; only the *value*-bearing
  // branches of ternary/logical ops carry it.
  const producesFraction = (e) => {
    if (e == null) return false
    if (typeof e === 'number') return !Number.isInteger(e)
    if (typeof e === 'string') return refIsFractional(e)
    if (!Array.isArray(e)) return false
    const op = e[0]
    if (op == null) return typeof e[1] === 'number' && !Number.isInteger(e[1])
    if (op === '/' || op === '**') return true
    if (INT_COERCE_OPS.has(op) || COMPARE_OPS.has(op)) return false
    if (op === '?:') return producesFraction(e[2]) || producesFraction(e[3])
    if (op === '&&' || op === '||' || op === '??') return producesFraction(e[1]) || producesFraction(e[2])
    if (op === '()') {
      const callee = e[1]
      if (Array.isArray(callee) && callee[0] === '?') return producesFraction(callee[2]) || producesFraction(callee[3])
      if (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Math' && FRACTIONAL_MATH.has(callee[2])) return true
      return false  // unknown call → assume integer
    }
    for (let i = 1; i < e.length; i++) if (producesFraction(e[i])) return true
    return false
  }

  // A numeric-initialized global later assigned a provably non-numeric value
  // (string/object/array/arrow/`new`/boolean literal) must stay the f64 NaN-box
  // carrier — narrowing it to i32 would corrupt the boxed value. Disqualify it.
  const looksNonNumeric = (e) => {
    if (!Array.isArray(e)) return false
    const op = e[0]
    if (op == null) { const v = e[1]; return typeof v === 'string' || typeof v === 'boolean' }
    // `[` is prepare's array-literal form; `[]` length-2 is the raw (pre-prepare) one.
    return op === '{}' || op === '[' || (op === '[]' && e.length === 2) || op === '=>' || op === 'new' || op === 'str' || op === '`'
  }

  // Collect every assignment RHS (init + reassignments, program-wide). `fromParam`
  // records (global → the function it was assigned a parameter-derived value in) —
  // a parameter is an f64 of unknown integrality, so an i32-narrowed global fed from
  // one may silently truncate a fractional Number (DSP/filter state). We do NOT
  // demote on this (the integer default is the load-bearing index/size perf win);
  // we surface it on the opt-in warn channel below.
  const rhsByName = new Map()
  const fromParam = new Map()
  for (const name of candidates) rhsByName.set(name, [])
  const record = (name, rhs, scope) => {
    if (!candidates.has(name)) return
    if (looksNonNumeric(rhs)) { candidates.delete(name); rhsByName.delete(name); return }
    rhsByName.get(name)?.push(rhs)
    if (scope && !fromParam.has(name) && refsAny(rhs, scope.params, { skipBindingPositions: true }))
      fromParam.set(name, scope.fn)
  }
  const walk = (node, scope) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=' && typeof node[1] === 'string') record(node[1], node[2], scope)
    else if ((op === 'let' || op === 'const') && node.length > 1) {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') record(d[1], d[2], scope)
      }
    } else if (ASSIGN_OPS.has(op) && op !== '=' && typeof node[1] === 'string' && candidates.has(node[1])) {
      if (FRAC_COMPOUND.has(op)) fractional.add(node[1])               // `/=`, `**=` → fractional outright
      else if (!INT_COMPOUND.has(op)) record(node[1], node[2], scope)  // `+= -= *= %= ||= &&= ??=` → as their rhs
    }
    for (let i = 1; i < node.length; i++) walk(node[i], scope)
  }
  walk(ast, null)
  for (const f of ctx.func.list) {
    if (!f.body || f.raw) continue
    const params = new Set((f.sig?.params || []).map(p => p.name))
    walk(f.body, params.size ? { params, fn: f.name } : null)
  }

  // Fixpoint: demote any candidate with a provably-fractional assignment; repeat
  // so fractionality propagates through globals that reference each other.
  let changed = true
  while (changed) {
    changed = false
    for (const name of candidates) {
      if (fractional.has(name)) continue
      if (rhsByName.get(name).some(producesFraction)) { fractional.add(name); changed = true }
    }
  }

  for (const name of candidates) {
    if (fractional.has(name)) continue
    ctx.scope.globals.set(name, `(global $${name} (mut i32) (i32.const 0))`)
    ctx.scope.globalTypes.set(name, 'i32')
    // Advisory only (off unless opts.warnings): the value flows in from a parameter,
    // which may be a fractional Number that the i32 carrier truncates.
    if (ctx.warnings && fromParam.has(name))
      warn('int-global-truncation',
        `module global '${name}' is inferred i32 (integer) but is assigned from a parameter — if it can hold a fractional Number (e.g. DSP/filter state), the fraction is truncated; store fractional state in a Float64Array instead`,
        { fn: fromParam.get(name) })
  }
}

/**
 * Function-namespace scalar replacement + devirtualization.
 *
 * A property of a user function compiles, by default, as a dynamic object: each
 * `f.prop` write is a `__dyn_set` into a closure-keyed hash side-table, each
 * read a `__dyn_get`. But a function's property table can never be observed by
 * the host (the host receives only the callable; the table lives in jz linear
 * memory), so jz sees every `f.prop` site — the slot is a closed, fully-known
 * cell. Per property of a non-escaping namespace:
 *
 *   - reassigned (`multiProp`) slot → dissolve into a plain f64 module global:
 *     `__dyn_get/__dyn_set` → `global.get/global.set`. The indirect call stays
 *     (a genuinely reassigned function pointer needs `call_indirect`). Pure
 *     storage relocation: the global inits to `UNDEF_WAT`, exactly mirroring
 *     "key never set → __dyn_get yields undefined".
 *   - written once to its lifted `$f$prop` function and only ever *called*
 *     (never read as a value) → the `__dyn_set` is dead: emit already lowers
 *     `f.prop()` to a direct `call $f$prop`. Drop the write entirely.
 *
 * Disqualified namespaces (`f` escapes as a bare value / is computed-indexed —
 * an alias could reach the table) keep the dynamic path. Together these can
 * eliminate the `__dyn_*` machinery from a namespace-only program outright.
 */
export const flattenFuncNamespaces = (ast) => {
  const names = ctx.func.names
  if (!names?.size) return false
  // Cheap structural gate: a flattenable namespace exists only if some lifted
  // `f$prop` name's `f` is itself a function (prepare lifts every `f.prop =
  // arrow` — multiProp slots included). The base `f` may itself carry a module
  // prefix (`mod$f`), so scan every `$` boundary, not just the first; a
  // populated `multiProp` registry is itself a direct namespace witness.
  let hasNs = ctx.func.multiProp.size > 0
  if (!hasNs) outer: for (const n of names) {
    for (let i = n.indexOf('$'); i > 0; i = n.indexOf('$', i + 1))
      if (names.has(n.slice(0, i))) { hasNs = true; break outer }
  }
  if (!hasNs) return false
  const ns = analyzeFuncNamespaces(ast)
  if (!ns.size) return false
  // f → Map<prop, decision>; decision is { global } (SROA) or { drop } (dead
  // write to an only-called single-write slot).
  const flat = new Map()
  for (const [f, info] of ns) {
    if (info.disq) continue
    let decide
    const plan = (prop, d) => { if (!decide) flat.set(f, decide = new Map()); decide.set(prop, d) }
    for (const prop of info.props) {
      if (ctx.func.multiProp.has(`${f}.${prop}`)) { plan(prop, { global: `${f}${T}${prop}` }); continue }
      const w = info.writes.get(prop)
      // Single write of the lifted `$f$prop`, never read as a value → drop it.
      if (w && w.length === 1 && w[0].atInit && w[0].rhs === `${f}$${prop}` && !info.valRead.has(prop))
        plan(prop, { drop: true })
    }
  }
  if (!flat.size) return false
  for (const decide of flat.values())
    for (const d of decide.values())
      if (d.global && !ctx.scope.globals.has(d.global)) {
        ctx.scope.globals.set(d.global, `(global $${d.global} (mut f64) ${UNDEF_WAT})`)
        ctx.scope.globalTypes.set(d.global, 'f64')
      }
  const decisionFor = (obj, prop) =>
    typeof obj === 'string' && typeof prop === 'string' && flat.has(obj)
      ? flat.get(obj).get(prop) : undefined
  const isEmptySeq = (n) => Array.isArray(n) && n.length === 1 && n[0] === ';'
  const rewrite = (node) => {
    if (!Array.isArray(node)) return node
    const op = node[0]
    if (op === '.' || op === '?.') {
      const d = decisionFor(node[1], node[2])
      if (d?.global) return d.global  // drop-decisions leave reads/calls alone
    }
    if (op === '=' && Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.')) {
      const d = decisionFor(node[1][1], node[1][2])
      if (d?.global) return ['=', d.global, rewrite(node[2])]
      if (d?.drop) return [';']  // dead write — emit nothing
    }
    const out = [op]
    // Filter dropped writes out of statement sequences (an empty `[';']` left in
    // a body would lower to an unrenderable node).
    for (let i = 1; i < node.length; i++) {
      const c = rewrite(node[i])
      if (op === ';' && isEmptySeq(c)) continue
      out.push(c)
    }
    return out
  }
  const newAst = rewrite(ast)
  ast.length = 0
  for (let i = 0; i < newAst.length; i++) ast.push(newAst[i])
  invalidateProgramFactsCache(ast)
  for (const fn of ctx.func.list)
    if (fn.body && !fn.raw) fn.body = rewrite(fn.body)
  // The defining `f.prop = …` writes live in moduleInits for bundled programs —
  // rewrite them too, or reads would resolve to an unwritten global.
  if (ctx.module.moduleInits)
    for (let i = 0; i < ctx.module.moduleInits.length; i++)
      ctx.module.moduleInits[i] = rewrite(ctx.module.moduleInits[i])
  return true
}

/**
 * Closure devirtualization.
 *
 * `flattenFuncNamespaces` dissolves a reassigned `f.prop` function slot into a
 * module global, but the call through it stays a `call_indirect` on a
 * `global.get`, dispatched via an ABI-adapting trampoline. When that global is
 * written *only* by unconditional module-init assignments it holds, for the
 * entire post-init program, one statically-known function — so every call
 * through it collapses to a direct `call`: no table lookup, no trampoline, no
 * 8-wide padding ABI, no closure type guard.
 *
 * A global G qualifies iff:
 *   1. every assignment to G is an unconditional module-init statement — none in
 *      a function body, none nested inside init control flow;
 *   2. G's final init value resolves (through global aliases) to a top-level
 *      function F;
 *   3. G is never *called* by module-init code, nor by any function reachable
 *      from it — so every call site runs strictly post-init, where G ≡ F.
 * Devirt then only swaps an indirect call for a direct call to the very same
 * callee: it cannot change behavior, only drop dispatch overhead. The result is
 * recorded in `ctx.func.globalDevirt` (`Map<global, fn>`) and consumed by emit.
 */
export const devirtGlobalCalls = (ast) => {
  const fnNames = ctx.func.names
  if (!fnNames?.size || !ctx.scope.globals?.size) return

  // Module-init statement stream, in execution order: moduleInits run first in
  // `$__start`, then the main module's top-level.
  const initStmts = []
  const flatten = (n) => {
    if (Array.isArray(n) && n[0] === ';') for (let i = 1; i < n.length; i++) flatten(n[i])
    else if (n != null) initStmts.push(n)
  }
  for (const mi of ctx.module.moduleInits || []) flatten(mi)
  flatten(ast)

  const isGlobal = (s) => typeof s === 'string' && ctx.scope.globals.has(s)
  // `[target, rhs]` pairs for a `=` / `let` / `const` node assigning a global.
  const writesOf = (node) => {
    if (!Array.isArray(node)) return []
    if (node[0] === '=' && isGlobal(node[1])) return [[node[1], node[2]]]
    if (node[0] === 'let' || node[0] === 'const') {
      const out = []
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && isGlobal(d[1])) out.push([d[1], d[2]])
      }
      return out
    }
    return []
  }

  // Poison a global assigned anywhere but an unconditional init statement — in a
  // function body, or nested in init control flow. Its value is then not a
  // fixed post-init constant.
  const poison = new Set()
  const scanWrites = (node, topInit) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'let' || op === 'const') {
      // A declarator `=` is part of the declaration, not a nested assignment —
      // poison only when the declaration itself is non-top-level.
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=') {
          if (!topInit && isGlobal(d[1])) poison.add(d[1])
          scanWrites(d[2], false)
        } else scanWrites(d, false)
      }
      return
    }
    if (op === '=') {
      if (!topInit && isGlobal(node[1])) poison.add(node[1])
      scanWrites(node[1], false)
      scanWrites(node[2], false)
      return
    }
    for (let i = 1; i < node.length; i++) scanWrites(node[i], false)
  }
  for (const stmt of initStmts) scanWrites(stmt, true)
  for (const fn of ctx.func.map.values())
    if (fn.body && !fn.raw) scanWrites(fn.body, false)

  // Resolve each global's value by a linear pass over init in execution order.
  const env = new Map()
  const evalFn = (rhs) =>
    typeof rhs !== 'string' ? null
      : fnNames.has(rhs) ? rhs
      : env.has(rhs) ? env.get(rhs)
      : null
  for (const stmt of initStmts)
    for (const [g, rhs] of writesOf(stmt)) env.set(g, evalFn(rhs))

  const devirt = new Map()
  for (const [g, fn] of env)
    if (fn && fnNames.has(fn) && !poison.has(g)) devirt.set(g, fn)
  if (!devirt.size) return

  // Condition 3: a call through G that runs *during* init would see an
  // intermediate value. Drop any candidate G called by init code, or by a
  // function reachable from it.
  //
  // `walkStraightLine` follows only straight-line execution: a nested `=>`
  // literal is a closure *constructed* here, not run here, so its body is
  // skipped — an IIFE callee `(=> …)()` is the one exception, its body does
  // run. This is what keeps operator-registration init (`binary('+', 11)`
  // builds, but does not invoke, a parselet closure) from dragging the parser
  // into the init-reachable set, and keeps a wrapper body's `space()` call —
  // which fires at parse time — from counting as an init call. (Soundness
  // rests on a closure constructed during init not also being invoked during
  // init: true of function-slot wrappers, which are registered then called at
  // use time.)
  const walkStraightLine = (node, onCall) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '()') {
      onCall(node[1])
      if (Array.isArray(node[1]) && node[1][0] === '=>') walkStraightLine(node[1][2], onCall)
      for (let i = 2; i < node.length; i++) walkStraightLine(node[i], onCall)
      return
    }
    if (op === '=>' || op === 'function') return
    for (let i = 1; i < node.length; i++) walkStraightLine(node[i], onCall)
  }
  const reachable = new Set()
  const queue = []
  const seedCalls = (node) => walkStraightLine(node, (c) => {
    if (typeof c === 'string' && fnNames.has(c)) queue.push(c)
  })
  for (const s of initStmts) seedCalls(s)
  while (queue.length) {
    const f = queue.pop()
    if (reachable.has(f)) continue
    reachable.add(f)
    const fn = ctx.func.map.get(f)
    if (fn?.body && !fn.raw) seedCalls(fn.body)
  }
  const calledInInit = new Set()
  const collectCalled = (node) => walkStraightLine(node, (c) => {
    if (devirt.has(c)) calledInInit.add(c)
  })
  for (const s of initStmts) collectCalled(s)
  for (const f of reachable) { const fn = ctx.func.map.get(f); if (fn?.body) collectCalled(fn.body) }
  for (const g of calledInInit) devirt.delete(g)

  if (devirt.size) ctx.func.globalDevirt = devirt
}

export const materializeAutoBoxSchemas = (programFacts) => {
  if (!ctx.schema.register) return
  for (const [name, props] of programFacts.propMap) {
    if (ctx.schema.vars.has(name)) {
      const existing = ctx.schema.resolve(name)
      const newProps = [...props].filter(prop => !existing.includes(prop))
      if (newProps.length) {
        const merged = [...existing, ...newProps]
        const mergedId = ctx.schema.register(merged)
        ctx.schema.vars.set(name, mergedId)
      }
      continue
    }
    const valueProps = [...props].filter(prop => !ctx.func.names.has(`${name}$${prop}`))
    if (!valueProps.length) continue
    const allProps = [...props]
    const schema = ['__inner__', ...allProps]
    const schemaId = ctx.schema.register(schema)
    ctx.schema.vars.set(name, schemaId)
    if (ctx.func.names.has(name) && !ctx.scope.globals.has(name))
      ctx.scope.globals.set(name, `(global $${name} (mut f64) (f64.const 0))`)
    if (!ctx.schema.autoBox) ctx.schema.autoBox = new Map()
    ctx.schema.autoBox.set(name, { schemaId, schema })
  }
}

export const resolveClosureWidth = (programFacts) => {
  if (!ctx.closure.make) return
  const { hasSpread, hasRest, maxCall, maxDef, valueUsed } = programFacts
  const floor = ctx.closure.floor ?? 0
  // A top-level function used as a first-class value gets a boundary trampoline
  // that forwards $__a0..$__a{arity-1} into it (emit.js). The uniform closure
  // ABI must therefore be at least as wide as any table-resident function's
  // fixed arity — maxDef only counts surviving `=>` literals, so lifted/hoisted
  // function definitions slip past it (their bodies are walked, their param
  // lists aren't). Without this, e.g. an arity-3 function used only via a
  // 1-arg indirect call emits `(local.get $__a2)` against a 2-param trampoline.
  let maxValueArity = 0
  if (valueUsed) for (const name of valueUsed) {
    const n = ctx.func.map.get(name)?.sig?.params?.length ?? 0
    if (n > maxValueArity) maxValueArity = n
  }
  ctx.closure.width = (hasSpread && hasRest)
    ? MAX_CLOSURE_ARITY
    : Math.min(MAX_CLOSURE_ARITY, Math.max(maxCall, maxDef + (hasRest ? 1 : 0), maxValueArity, floor))
}

export const canSkipWholeProgramNarrowing = (programFacts) =>
  programFacts.callSites.length === 0 &&
  programFacts.valueUsed.size === 0 &&
  !programFacts.anyDyn &&
  programFacts.propMap.size === 0 &&
  !programFacts.hasSchemaLiterals &&
  !ctx.closure.make
