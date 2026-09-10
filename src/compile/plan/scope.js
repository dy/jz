/**
 * Module-scope planning — type-narrowing and structural rewrites of
 * module-level bindings. Runs once per program (post fact-collection,
 * pre whole-program narrowing) under `plan()`.
 *
 * Concerns owned here (each operates on `ctx.scope` / `ctx.func` / `ctx.schema`,
 * not on AST shape — except `flattenFuncNamespaces` and `devirtGlobalCalls`,
 * which mutate the AST as their final step):
 *
 *   - `moduleGlobalKinds`         — module-global kinds from the program summary
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

import { ctx, warn, declGlobal } from '../../ctx.js'
import { warningsView } from '../../session-views.js'
import { ASSIGN_OPS, MUTATE_OPS, T, I32_MIN, I32_MAX, ACCESSOR_GET, ACCESSOR_SET, refsAny, extractParams, classifyParam, PARAM_KIND, PARAM_NAME, collectParamNames, walkAst } from '../../ast.js'
import { VAL, updateGlobalRep } from '../../reps.js'
import { constNumExpr } from '../../static.js'
import { typedStaticLen, intLevelMap } from '../../type.js'
import { K, tagOf, paramOf, isNullable, hasTag, valOf, core, UNKNOWN } from '../../summary/index.js'
import { typedElemAux, ctorFromElemAux } from '../../../layout.js'
import { MAX_CLOSURE_ARITY, UNDEF_NAN, freshId } from '../../ir.js'
import { analyzeFuncNamespaces } from '../analyze.js'
import { collectBareEscapes } from '../analyze-scans.js'
import { invalidateProgramFactsCache } from '../program-facts.js'

/** Publish immutable numeric globals before representation planning. */
export function foldModuleConstants(ast) {
  const pending = []
  for (const root of [ast, ...ctx.module.moduleInits]) {
    const stmts = Array.isArray(root) && root[0] === ';' ? root.slice(1) : [root]
    for (const stmt of stmts) {
      if (!Array.isArray(stmt) || stmt[0] !== 'const') continue
      for (const decl of stmt.slice(1))
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' &&
            ctx.scope.globals.has(decl[1]) && ctx.scope.consts?.has(decl[1])) pending.push(decl)
    }
  }
  // Cross-module dependencies may arrive out of order. Only unresolved
  // declarations remain in the next sweep; fractional constants resolve too.
  const lookup = name => ctx.scope.constNums?.get(name) ?? ctx.scope.constInts?.get(name) ?? null
  let changed = true
  while (changed) {
    changed = false
    let remaining = 0
    for (const decl of pending) {
      const [, name, init] = decl
      const value = constNumExpr(init, lookup)
      if (value == null || !Number.isFinite(value)) { pending[remaining++] = decl; continue }
      const int = Number.isInteger(value) && !Object.is(value, -0) && value >= I32_MIN && value <= I32_MAX
      declGlobal(name, int ? 'i32' : 'f64', value, { mut: false })
      if (int) (ctx.scope.constInts ||= new Map()).set(name, value)
      ;(ctx.scope.constNums ||= new Map()).set(name, value)
      changed = true
    }
    pending.length = remaining
  }
  // Constructor lengths depend on the same settled numeric bindings.
  if (ctx.scope.pendingTypedLens) {
    for (const [name, rhs] of ctx.scope.pendingTypedLens) {
      const len = typedStaticLen(rhs)
      if (len != null && ctx.scope.globalTypedElem?.has(name))
        (ctx.scope.globalTypedLen ||= new Map()).set(name, len)
    }
    ctx.scope.pendingTypedLens = null
  }
}

/** Module-global kinds from the program summary: a global's kind is the join of
 *  every assignment in the program, so the declaration's own claim (prepare's
 *  recordGlobalRep, the initializer alone) yields to it: a global a function
 *  stores another kind into is `any`, and a nullish store makes it nullable. A
 *  global assigned nowhere keeps the declaration's claim. A typed-array kind
 *  names its constructor (`let mem; init = n => { mem = new Float64Array(n) }`);
 *  a const bound to an object of one schema names the schema. A hash kind is
 *  not claimed: this runs on the entry summary, before materializeAutoBoxSchemas
 *  gives a dot-written `{}` its schema (classifyHashDictGlobals decides the
 *  dictionaries). An exported global keeps its kind: the host can
 *  store only a number through its export (src/summary). An array global's
 *  element facts are its cell's, the join of every store in the program (a
 *  table `const T = [1.5, …]` reads numbers; `C[i][j]` one level down): the
 *  kind when no producer is nullish, holes as presence, a typed element's
 *  constructor, an array element's own element kind. */
export const moduleGlobalKinds = (summary) => {
  if (!summary || !ctx.scope.userGlobals?.size) return
  for (const name of ctx.scope.userGlobals) {
    if (ctx.funcs.names?.has(name)) continue
    const k = summary.kindOf(name)
    if (tagOf(k) === K.NONE) continue
    if (isNullable(k)) updateGlobalRep(name, { nullable: true })
    const vt = valOf(core(k))
    const vts = ctx.scope.globalValTypes ||= new Map()
    // HASH and payload-less OBJECT are semantic object-family answers, not
    // physical allocation proofs. Leave them to the dictionary/schema plan.
    if (vt === VAL.HASH || (vt === VAL.OBJECT && summary.sidOf(name) == null)) continue
    if (vt == null) { vts.delete(name); ctx.scope.globalTypedElem?.delete(name); continue }
    vts.set(name, vt)
    if (vt === VAL.ARRAY) {
      const e = summary.elemKindOf(name)
      if (e != null && !hasTag(e, K.NULLISH)) {
        const ev = valOf(core(e))
        if (ev != null) {
          const facts = { arrayElemValType: ev }
          if (hasTag(e, K.ABSENT)) facts.arrayHoles = true
          if (ev === VAL.TYPED && paramOf(e) !== UNKNOWN) facts.arrayElemTypedCtor = ctorFromElemAux(paramOf(e))
          if (ev === VAL.ARRAY) { const ee = summary.elemOfKind(e), nested = hasTag(ee, K.NULLISH) ? null : valOf(core(ee)); if (nested != null) facts.arrayElemElemValType = nested }
          updateGlobalRep(name, facts)
        }
      }
    }
    if (vt === VAL.TYPED) {
      const ctor = paramOf(k) !== UNKNOWN ? ctorFromElemAux(paramOf(k)) : null
      if (ctor) (ctx.scope.globalTypedElem ||= new Map()).set(name, ctor)
      else ctx.scope.globalTypedElem?.delete(name)
    }
    if (vt === VAL.OBJECT && ctx.scope.consts?.has(name) && !ctx.schema.vars.has(name) && !ctx.schema.poisoned?.has(name)) {
      const sid = summary.sidOf(name)
      if (sid != null) ctx.schema.vars.set(name, sid)
    }
  }
}

export const classifyHashDictGlobals = (ast, programFacts) => {
  const dynWriteVars = programFacts?.dynWriteVars
  if (!dynWriteVars?.size || !ctx.scope.userGlobals?.size) return
  const propMap = programFacts.propMap
  const mark = (name, init) => {
    if (typeof name !== 'string' || !ctx.scope.userGlobals.has(name)) return
    if (ctx.scope.globalValTypes?.has(name)) return                 // fill only — never overwrite
    if (!Array.isArray(init) || init[0] !== '{}' || init.length !== 1) return
    if (!dynWriteVars.has(name)) return
    if (propMap?.get(name)?.size) return                            // dot-write elsewhere → materializeAutoBoxSchemas binds a real schema later
    if (ctx.schema.resolve?.(name)?.length) return                  // non-empty merged schema — not dict-mode
    ;(ctx.scope.globalValTypes ||= new Map()).set(name, VAL.HASH)
  }
  const enter = (node) => {
    const op = node[0]
    if (op === '=>') return false
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const decl = node[i]
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string') mark(decl[1], decl[2])
      }
    }
  }
  walkAst(ast, { enter })
  if (ctx.module.moduleInits) for (const mi of ctx.module.moduleInits) walkAst(mi, { enter })
}

export const unboxConstTypedGlobals = () => {
  if (!ctx.scope.globalTypedElem || !ctx.scope.consts) return
  for (const [name, ctor] of ctx.scope.globalTypedElem) {
    if (!ctx.scope.consts.has(name)) continue
    if (ctx.scope.globalValTypes?.get(name) !== VAL.TYPED) continue
    const aux = typedElemAux(ctor)
    if (aux == null) continue
    const decl = ctx.scope.globals.get(name)
    if (!(decl?.mut && decl.type === 'f64')) continue
    declGlobal(name, 'i32')
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
    if (!(decl?.mut && decl.type === 'f64')) continue
    if (ctx.scope.globalValTypes?.get(name) !== VAL.NUMBER) continue
    if (ctx.funcs.names?.has(name)) continue
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
  // Post-prepare, `Math.PI` / `Math.sqrt(x)` arrive as FLAT math keys — the bare
  // string 'math.PI' in value position, 'math.sqrt' as a string callee — not the
  // raw ['.','Math','sqrt'] shape. Missing them assumed INTEGER and i32-demoted
  // module consts like `export const TWO_PI = Math.PI * 2` in DEP modules (their
  // inits prep before this scan), truncating 6.283… → 6 at init.
  const FRACTIONAL_MATH_CONSTS = new Set(['PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2'])
  const fractionalMathKey = (k) => typeof k === 'string' && k.startsWith('math.')
    && (FRACTIONAL_MATH.has(k.slice(5)) || FRACTIONAL_MATH_CONSTS.has(k.slice(5)))
  const EXCEEDS_I32_CALLS = new Set(['Date.now', 'performance.now', 'console.now', 'console.perfNow', 'Date.parse', 'Date.UTC'])
  const producesFraction = (e) => {
    if (e == null) return false
    if (typeof e === 'number') return !Number.isInteger(e)
    if (typeof e === 'string') return refIsFractional(e) || fractionalMathKey(e)
    if (!Array.isArray(e)) return false
    const op = e[0]
    if (op == null) return typeof e[1] === 'number' && !Number.isInteger(e[1])
    if (op === 'nan' || op === '/' || op === '**') return true   // NaN is parse.js's marker, not an integer
    if (INT_COERCE_OPS.has(op) || COMPARE_OPS.has(op)) return false
    if (op === '?:') return producesFraction(e[2]) || producesFraction(e[3])
    if (op === '&&' || op === '||' || op === '??') return producesFraction(e[1]) || producesFraction(e[2])
    if (op === '()') {
      const callee = e[1]
      if (Array.isArray(callee) && callee[0] === '?') return producesFraction(callee[2]) || producesFraction(callee[3])
      if (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Math' && FRACTIONAL_MATH.has(callee[2])) return true
      if (fractionalMathKey(callee)) return true
      // Integer-valued but EXCEEDS the i32 range: epoch/monotonic-millisecond
      // clocks (~1.7e12). The integer default would wrap them mod 2^32 at the
      // i32 global store — the old saturating coercion masked this by clamping
      // to INT32_MAX ("t > 0" stayed accidentally true); the ES-correct wrap
      // surfaces it. Disqualify like a fractional producer.
      if (typeof callee === 'string' && EXCEEDS_I32_CALLS.has(callee)) return true
      if (Array.isArray(callee) && callee[0] === '.' && typeof callee[1] === 'string' &&
          EXCEEDS_I32_CALLS.has(`${callee[1]}.${callee[2]}`)) return true
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
  // `scope` is fixed for the whole call (never changes mid-tree, not even at
  // `=>` — the only variation is which top-level root it's invoked on below),
  // so it closes over `enter` rather than threading through a boundary param.
  const walk = (node, scope) => walkAst(node, { enter: n => {
    const op = n[0]
    if (op === '=' && typeof n[1] === 'string') record(n[1], n[2], scope)
    else if ((op === 'let' || op === 'const') && n.length > 1) {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') record(d[1], d[2], scope)
      }
    } else if (ASSIGN_OPS.has(op) && op !== '=' && typeof n[1] === 'string' && candidates.has(n[1])) {
      if (FRAC_COMPOUND.has(op)) fractional.add(n[1])               // `/=`, `**=` → fractional outright
      else if (!INT_COMPOUND.has(op)) record(n[1], n[2], scope)  // `+= -= *= %= ||= &&= ??=` → as their rhs
    }
  }})
  walk(ast, null)
  // DEP-module top-level inits live in ctx.module.moduleInits, NOT the entry ast —
  // without walking them a dep's `export const TWO_PI = Math.PI * 2` records no
  // RHS at all and the integer default i32-demotes it (init truncated 6.283 → 6).
  if (ctx.module.moduleInits) for (const init of ctx.module.moduleInits) walk(init, null)
  for (const f of ctx.funcs.list) {
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

  // Bare-escape veto (module-global twin of widenLocalTypes Pass D,
  // .work/archive/todo.md's KNOWN GAP #1 sibling): `producesFraction` above only
  // proves each candidate INTEGRAL — the same "level 1: integral-closed,
  // range-open" verdict intLevelMap gives a local's `+`/`-`/`*` chain, never
  // a magnitude bound. i32 storage is sound for a value ONLY as long as
  // every read re-applies the same ToInt32 the writes did (declGlobal's own
  // load-bearing tradeoff, identical to type.js's widening-invariant local one) — broken the
  // instant an integral-but-unbounded global (`counter *= 100000`) is ALSO
  // read bare with no governing comparison ANYWHERE. A local's relevant
  // scope for that proof is its one function body; a global's is the WHOLE
  // PROGRAM, since its storage outlives any one function — so both checks
  // below run over module-init code + every function body concatenated.
  //
  // Two-tier, mirroring intLevelMap's own lattice exactly (Pass D's own
  // "level 2 needs no check" exemption, generalized to program scope):
  //   - level 2 (STRICT i32-range-safe by construction — every write is an
  //     int32-range literal, a bitwise/comparison result, or Math.imul/
  //     clz32) needs no escape check: every value it can ever hold already
  //     fits i32, regardless of where it's read. `intLevelMap` over the
  //     SAME whole-program body computes this per name via its own
  //     min-fixpoint over every def's RHS (a namesake local elsewhere can
  //     only pull a shared bucket's level DOWN via that min, never falsely
  //     UP — safe direction only, matches this file's own "over-inclusive
  //     only makes it MORE conservative" convention).
  //   - level < 2 (level 1 "integral, range-open", or 0): needs
  //     collectBareEscapes' full proof — index-positioned, ToInt32-rooted,
  //     statically in-range (intExprRange), or governed by SOME comparison
  //     anywhere in the whole-program scan (the loop-counter tolerance
  //     widenLocalTypes' CMP_OPS pass already accepts, generalized to
  //     program-wide governance the same way the escape scope itself is) —
  //     via collectBareEscapes' crossClosure mode, so an escape hiding
  //     inside an inline arrow (never lifted to its own ctx.funcs.list
  //     entry) is still caught.
  let strictLevel = null, bareEscaped = null
  if (candidates.size) {
    const funcBodies = []
    for (const f of ctx.funcs.list) if (f.body && !f.raw) funcBodies.push(f.body)
    const programBody = [';', ast, ...(ctx.module.moduleInits || []), ...funcBodies]
    strictLevel = intLevelMap(programBody)
    if ([...candidates].some(n => strictLevel.get(n) !== 2))
      bareEscaped = collectBareEscapes(programBody, null, true)
  }

  for (const name of candidates) {
    if (fractional.has(name)) continue
    if (strictLevel.get(name) !== 2 && bareEscaped.has(name)) continue
    declGlobal(name, 'i32')
    // Advisory only (off unless opts.warnings): the value flows in from a parameter,
    // which may be a fractional Number that the i32 carrier truncates.
    if (warningsView().warnings && fromParam.has(name))
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
 *     storage relocation: the global inits to the undefined NaN atom, exactly mirroring
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
  const names = ctx.funcs.names
  if (!names?.size) return false
  // Cheap structural gate: a flattenable namespace exists only if some lifted
  // `f$prop` name's `f` is itself a function (prepare lifts every `f.prop =
  // arrow` — multiProp slots included). The base `f` may itself carry a module
  // prefix (`mod$f`), so scan every `$` boundary, not just the first; a
  // populated `multiProp` registry is itself a direct namespace witness.
  let hasNs = ctx.funcs.multiProp.size > 0
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
      if (ctx.funcs.multiProp.has(`${f}.${prop}`)) { plan(prop, { global: `${f}${T}${prop}` }); continue }
      const w = info.writes.get(prop)
      // Single top-level write of the lifted `$f$prop` (the `f.prop = arrow`
      // definition shape): calls to it already lower to a direct `call $f$prop`,
      // which a global would demote to call_indirect — leave it alone; when it's
      // additionally never read as a value, the write itself is dead → drop it.
      if (w && w.length === 1 && w[0].atInit && w[0].rhs === `${f}$${prop}`) {
        if (!info.valRead.has(prop)) plan(prop, { drop: true })
        continue
      }
      // Everything else dissolves into a module global — the namespace is
      // non-escaping, so every site is visible and the slot is a closed cell.
      // This covers slots multiProp can't see: props reassigned only INSIDE
      // function bodies (prepare's registry counts top-level lifts), and
      // single-write non-function values. The layered-parser state pattern
      // (subscript's parse.comment/newline/semi — read/written per token) was
      // paying a __dyn_get/__dyn_set probe chain per site without this.
      plan(prop, { global: `${f}${T}${prop}` })
    }
  }
  if (!flat.size) return false
  for (const decide of flat.values())
    for (const d of decide.values())
      if (d.global && !ctx.scope.globals.has(d.global)) {
        declGlobal(d.global, 'f64', `nan:${UNDEF_NAN}`)
      }
  const decisionFor = (obj, prop) =>
    typeof obj === 'string' && typeof prop === 'string' && flat.has(obj)
      ? flat.get(obj).get(prop) : undefined
  const isEmptySeq = (n) => Array.isArray(n) && n.length === 1 && n[0] === ';'
  // `stmt` — node sits in statement position (a `;` sequence child). A dropped
  // write there emits nothing; in EXPRESSION position (comma chain, init value,
  // arrow body) `(f.p = v)` must still yield v — the lifted-closure reference —
  // or the surrounding arity breaks (invalid wasm: values left on the stack).
  const rewrite = (node, stmt = false) => {
    if (!Array.isArray(node)) return node
    const op = node[0]
    if (op === '.' || op === '?.') {
      const d = decisionFor(node[1], node[2])
      if (d?.global) return d.global  // drop-decisions leave reads/calls alone
    }
    if (op === '=' && Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.')) {
      const d = decisionFor(node[1][1], node[1][2])
      if (d?.global) return ['=', d.global, rewrite(node[2])]
      if (d?.drop) return stmt ? [';'] : rewrite(node[2])  // dead write — statement: nothing; value: the rhs
    }
    const out = [op]
    // Filter dropped writes out of statement sequences (an empty `[';']` left in
    // a body would lower to an unrenderable node).
    for (let i = 1; i < node.length; i++) {
      const c = rewrite(node[i], op === ';')
      if (op === ';' && isEmptySeq(c)) continue
      out.push(c)
    }
    return out
  }
  const newAst = rewrite(ast)
  ast.length = 0
  for (let i = 0; i < newAst.length; i++) ast.push(newAst[i])
  invalidateProgramFactsCache(ast)
  for (const fn of ctx.funcs.list) {
    if (fn.body && !fn.raw) fn.body = rewrite(fn.body)
    // Default-param values are AST stored OUTSIDE fn.body (fn.defaults) — a
    // closure default like subscript's `dispatch = (ops, tail, fn = (…) => {…
    // parse.id(…) …})` reads func-props too. Missing them left the read on the
    // dynamic __dyn_get path while every write had dissolved into the global —
    // disjoint stores, so the read yielded undefined (the tokenizer's word-guard
    // collapsed and `init` lexed as `in`+`it`).
    if (fn.defaults) for (const k of Object.keys(fn.defaults)) fn.defaults[k] = rewrite(fn.defaults[k])
  }
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
 * recorded in `ctx.funcs.globalDevirt` (`Map<global, fn>`) and consumed by emit.
 */
/** A member access on a receiver the summary names as one class's instance is
 *  the call of the class's function (jzify/classes.js): `p.len()` → `P⟨len⟩(p)`,
 *  `p.twice` → `P⟨twice__get⟩(p)`, the statement `p.twice = v` →
 *  `P⟨twice__set⟩(p, v)`. The direct call inlines like any other, and an
 *  instance that then never escapes scalarizes (plan/literals.js) with its
 *  accessors already lowered. A receiver the summary cannot name, or that may
 *  be nullish, keeps the dispatcher (emit/class-dispatch.js). */
export const devirtClassCalls = () => {
  if (!ctx.transform.classes?.size) return false
  let changed = false
  const call = (fn, recv, args) => { changed = true; return ['()', fn, args.length ? [',', recv, ...args] : recv] }
  // `stmt`: the node is a statement of a `;` list, its value unused (a setter's result is not the value assigned).
  const rewrite = (n, view, stmt = false) => {
    if (!Array.isArray(n)) return n
    if (n[0] === '=>') { const body = rewrite(n[2], ctx.summary.at(n[1])); return body === n[2] ? n : [n[0], n[1], body] }
    let out = n
    // A mutated member is no read: its receiver alone rewrites.
    const target = MUTATE_OPS.has(n[0]) && Array.isArray(n[1]) && n[1][0] === '.'
    for (let i = 1; i < n.length; i++) {
      const c = i === 1 && target ? (r => r === n[1][1] ? n[1] : [n[1][0], r, n[1][2]])(rewrite(n[1][1], view)) : rewrite(n[i], view, n[0] === ';')
      if (c !== n[i]) { if (out === n) out = n.slice(); out[i] = c }
    }
    if (out[0] === '()' && Array.isArray(out[1]) && out[1][0] === '.' && typeof out[1][2] === 'string') {
      const fn = view.classCallee(out[1][1], out[1][2])
      if (fn) return call(fn, out[1][1], out[2] == null ? [] : Array.isArray(out[2]) && out[2][0] === ',' ? out[2].slice(1) : [out[2]])
    }
    else if (out[0] === '.' && typeof out[2] === 'string') {
      const fn = view.classCallee(out[1], out[2] + ACCESSOR_GET)
      if (fn) return call(fn, out[1], [])
    }
    else if (out[0] === '=' && stmt && Array.isArray(out[1]) && out[1][0] === '.' && typeof out[1][2] === 'string') {
      const fn = view.classCallee(out[1][1], out[1][2] + ACCESSOR_SET)
      if (fn) return call(fn, out[1][1], [out[2]])
    }
    return out
  }
  for (const f of ctx.funcs.list) if (f.body && !f.raw) f.body = rewrite(f.body, ctx.summary.at(f.sig))
  return changed
}

export const devirtGlobalCalls = (ast) => {
  const fnNames = ctx.funcs.names
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

  // A node that is ITSELF a compound-assign (`=`/`??=`/`||=`/…) directly
  // targeting a global — the one-hop-deep shape a declarator's or a bare
  // statement's own value position can be (chained assignment: `const x = (G
  // = arrow)`; `const x = (G ??= Y)`, subscript asi.js's `parse._baseSpace ??=
  // parse.space`). Both the poison scan and the env resolver special-case
  // exactly this nesting; anything buried deeper (behind a comma-expression,
  // ternary, call, …) stays outside what either tracks — the same shallow-
  // recognition boundary this pass always had for plain `=`.
  const chainedWrite = (n) => Array.isArray(n) && ASSIGN_OPS.has(n[0]) && typeof n[1] === 'string'

  // `[target, valueNode]` pairs for a `=`/compound-assign / `let` / `const`
  // node assigning a global. `valueNode` is either a plain value expression
  // (declarator RHS) or — for a bare compound-assign statement — the whole
  // write node, so resolveValue's chainedWrite branch can see the operator.
  const writesOf = (node) => {
    if (!Array.isArray(node)) return []
    if (chainedWrite(node) && isGlobal(node[1])) return [[node[1], node]]
    if ((node[0] === '++' || node[0] === '--') && isGlobal(node[1])) return [[node[1], null]]
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
  // fixed post-init constant. A RHS that is itself a direct chainedWrite (one
  // hop) inherits the OUTER statement's topInit instead of being forced
  // conservative — `const asi = parse.asi = arrow` is ONE unconditional
  // top-level statement; poisoning its inner target merely for being nested
  // one assignment deep would be over-conservative, not sound-required.
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
          scanWrites(d[2], chainedWrite(d[2]) ? topInit : false)
        } else scanWrites(d, false)
      }
      return
    }
    // Any assign-op (`=`, `??=`, `||=`, `+=`, …) or `++`/`--` on a global outside
    // unconditional init poisons it — the house write predicate used throughout
    // prepare/narrow/emit (`ASSIGN_OPS.has(op) || op==='++' || op==='--'`).
    if (ASSIGN_OPS.has(op) || op === '++' || op === '--') {
      if (!topInit && isGlobal(node[1])) poison.add(node[1])
      scanWrites(node[1], false)
      scanWrites(node[2], chainedWrite(node[2]) ? topInit : false)
      return
    }
    for (let i = 1; i < node.length; i++) scanWrites(node[i], false)
  }
  for (const stmt of initStmts) scanWrites(stmt, true)
  for (const fn of ctx.funcs.map.values())
    if (fn.body && !fn.raw) scanWrites(fn.body, false)

  // Resolve each global's value by a linear pass over init in execution order.
  const env = new Map()

  // Free identifiers referenced by `node`, skipping property-name / literal-
  // key positions (mirrors ast.js's REFS_IN_EXPR convention: `.`/`?.` only
  // recurse the receiver, `:` only the value) and skipping anything bound by a
  // `=>` param, `let`/`const`, or `catch` clause anywhere within — the same
  // "hoist every local to function scope" approximation the other body-local
  // scans in this file use (over-inclusive `bound` only makes lifting MORE
  // conservative, never less sound).
  const collectFreeIdents = (node, bound, out) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') { collectParamNames(extractParams(node[1]), bound); collectFreeIdents(node[2], bound, out); return }
    if (op === 'str') return
    if (op === '.' || op === '?.') { collectFreeIdents(node[1], bound, out); return }
    if (op === ':') { collectFreeIdents(node[2], bound, out); return }
    if (op === 'catch' && typeof node[2] === 'string') bound.add(node[2])
    if (op === 'let' || op === 'const') collectParamNames(node, bound, 1)
    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (typeof c === 'string') { if (!bound.has(c)) out.add(c) }
      else collectFreeIdents(c, bound, out)
    }
  }

  // Lift a module-init-time arrow literal into a standalone top-level function
  // so its resolved VALUE (the function name) can flow through env like any
  // other devirt candidate — subscript's `parse.space = (r,e) => {…}` shape
  // once flattenFuncNamespaces turns the write into a plain global assign, or
  // an arrow reached one hop through a chainedWrite. Sound only when the arrow
  // captures nothing from an enclosing function's locals: at true module-init
  // depth that's automatic (no enclosing function exists at all — initStmts
  // only holds top-level statements, and this walk never enters a `=>` body
  // except the candidate's own), but an arrow nested inside another init
  // expression is still checked, fail-closed — any free identifier that isn't
  // a module global or a top-level function name aborts the lift, as does any
  // non-plain (rest/default/destructured) param. The ORIGINAL arrow node is
  // left untouched in place: this only ADDS a new function; whatever produced
  // the arrow as a value (closure.make at its own AST position) keeps working
  // unchanged for any other, non-call use of the same global.
  const liftArrow = (node) => {
    const params = []
    for (const p of extractParams(node[1])) {
      const c = classifyParam(p)
      if (c[PARAM_KIND] !== 'plain') return null
      params.push(c[PARAM_NAME])
    }
    const bound = new Set(params)
    const free = new Set()
    collectFreeIdents(node[2], bound, free)
    for (const name of free) if (!ctx.scope.globals.has(name) && !fnNames.has(name)) return null

    const name = `${T}devirt${freshId(ctx)}`
    const funcInfo = { name, body: node[2], exported: false, sig: { params: params.map(n => ({ name: n, type: 'f64' })), results: ['f64'] } }
    ctx.funcs.list.push(funcInfo)
    ctx.funcs.map.set(name, funcInfo)
    fnNames.add(name)
    return name
  }

  // A write node's resolved value: `=` always takes the RHS; `??=`/`||=` keep
  // G's prior env value when one was already recorded (sound because a prior
  // value present in env is always a function — non-nullish AND truthy, so
  // both operators short-circuit without evaluating the RHS at all) and fall
  // back to resolving the RHS only when no prior write was seen (sound because
  // an as-yet-unwritten SROA/module global's declared init is the shared
  // undefined atom — nullish and falsy). Any OTHER compound op (`+=`, `&&=`, …)
  // can't be interpreted here — recorded as a write with an unknown value
  // rather than left silently unset, so a LATER `??=`/`||=` on the same global
  // can't mistake "written but uninterpretable" for "never written".
  const resolveWriteNode = (n) => {
    const [op, g, v] = n
    const val = op === '='
      ? resolveValue(v)
      : (op === '??=' || op === '||=')
        ? (env.has(g) ? env.get(g) : resolveValue(v))
        : null
    env.set(g, val)
    return val
  }
  const resolveValue = (v) => {
    if (typeof v === 'string') return fnNames.has(v) ? v : env.has(v) ? env.get(v) : null
    if (!Array.isArray(v)) return null
    if (v[0] === '=>') return liftArrow(v)
    if (chainedWrite(v) && isGlobal(v[1])) return resolveWriteNode(v)
    return null
  }
  for (const stmt of initStmts)
    for (const [g, valueNode] of writesOf(stmt)) env.set(g, resolveValue(valueNode))

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
    const fn = ctx.funcs.map.get(f)
    if (fn?.body && !fn.raw) seedCalls(fn.body)
  }
  const calledInInit = new Set()
  const collectCalled = (node) => walkStraightLine(node, (c) => {
    if (devirt.has(c)) calledInInit.add(c)
  })
  for (const s of initStmts) collectCalled(s)
  for (const f of reachable) { const fn = ctx.funcs.map.get(f); if (fn?.body) collectCalled(fn.body) }
  for (const g of calledInInit) devirt.delete(g)

  if (devirt.size) ctx.funcs.globalDevirt = devirt
}

export const materializeAutoBoxSchemas = (programFacts) => {
  if (!ctx.schema.register) return
  for (const [name, props] of programFacts.propMap) {
    // A name whose objects are minted elsewhere (`const alias = ns.inner`, a
    // parameter) or whose sources disagree keeps no merged or boxed layout:
    // the declaration's value replaces a box, and a slot store by a layout
    // the object does not carry lands past its fields. Its dot writes take
    // the dynamic path (ctx.schema.unknownInit's doc, ctx.js).
    if (ctx.schema.unknownInit?.has(name) || ctx.schema.poisoned?.has(name)) continue
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
    const valueProps = [...props].filter(prop => !ctx.funcs.names.has(`${name}$${prop}`))
    if (!valueProps.length) continue
    const allProps = [...props]
    const schema = ['__inner__', ...allProps]
    const schemaId = ctx.schema.register(schema)
    ctx.schema.vars.set(name, schemaId)
    if (ctx.funcs.names.has(name) && !ctx.scope.globals.has(name))
      declGlobal(name, 'f64')
    if (!ctx.schema.autoBox) ctx.schema.autoBox = new Map()
    ctx.schema.autoBox.set(name, { schemaId, schema })
  }
}

export const resolveClosureWidth = (programFacts) => {
  if (!ctx.closure.make) return
  const { hasSpread, hasRest, maxCall, maxDef } = programFacts
  const floor = ctx.closure.floor ?? 0
  // A top-level function used as a first-class value gets a boundary trampoline
  // that forwards $__a0..$__a{arity-1} into it (emit.js). The uniform closure
  // ABI must therefore be at least as wide as any table-resident function's
  // fixed arity — maxDef only counts surviving `=>` literals, so lifted/hoisted
  // function definitions slip past it (their bodies are walked, their param
  // lists aren't). Without this, e.g. an arity-3 function used only via a
  // 1-arg indirect call emits `(local.get $__a2)` against a 2-param trampoline.
  let maxValueArity = 0
  const dynamicRoots = programFacts.programIndex.getCallGraph().dynamicRootIds
  for (let i = 0; i < dynamicRoots.length; i++) {
    const n = programFacts.programIndex.graphFunctionById(dynamicRoots[i])?.sig?.params?.length ?? 0
    if (n > maxValueArity) maxValueArity = n
  }
  ctx.closure.width = (hasSpread && hasRest)
    ? MAX_CLOSURE_ARITY
    : Math.min(MAX_CLOSURE_ARITY, Math.max(maxCall, maxDef + (hasRest ? 1 : 0), maxValueArity, floor))
  ctx.closure.spread = hasSpread
}

export const canSkipWholeProgramNarrowing = (programFacts) =>
  programFacts.callSites.length === 0 &&
  programFacts.programIndex.addressTaken.size === 0 &&
  !programFacts.anyDyn &&
  programFacts.propMap.size === 0 &&
  !programFacts.hasSchemaLiterals &&
  // `ctx.closure.make` truthiness means "has the `fn` module's init(ctx) run",
  // NOT "does this program have closures" — front.js's eager includeMods()
  // (region-arena builds) and index.js's `_eagerStdlib` test hook both load
  // `fn` for EVERY compile regardless of source content (the established
  // "module load = registration only" invariant, .work/archive/region-release-
  // notes.md Class 1/2), so the bare-truthy check silently forced the full
  // whole-program narrowing fixpoint to run for programs with zero closures —
  // observable eager-vs-lazy divergence even on `() => 5` (no call sites, no
  // value-used names, nothing else that would ever disqualify the skip path):
  // narrowI32Results, unreached on the lazy skip path, narrowed the literal
  // return to i32 + a boundary-wrap trampoline once the full pass ran, purely
  // because `fn` happened to be loaded. `ctx.module.demanded` (src/ctx.js) is
  // the real, AST-content-driven ledger the Class 2 fix already established
  // for exactly this "loaded vs demanded" distinction — `includeModule` marks
  // it unconditionally (even on the already-loaded early return) while the
  // eager bulk preload (`includeAllMods` → `loadModule` directly) never does,
  // so under normal (non-eager) compiles `demanded` and `ctx.closure.make`
  // always coincide (the only path that loads `fn` at all IS a real
  // `includeModule('fn')` call — no MOD_DEPS edge lists `fn` as a dependency)
  // and this is a pure narrowing of the proxy, not a behavior change.
  !ctx.module.demanded.has('fn') &&
  // Typed default-arg annotations (`arr = new Int32Array(0)`) feed the param
  // lattice even with zero call sites — a host-called SPMD kernel (Workers v1)
  // gets its pointer-ABI lane and Atomics receiver proof from exactly this.
  !ctx.funcs.list.some(f => f.defaults && Object.values(f.defaults).some(d =>
    Array.isArray(d) && d[0] === '()' && typeof d[1] === 'string' &&
    d[1].startsWith('new.') && d[1].endsWith('Array')))
