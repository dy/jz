import { ASSIGN_OPS, commaList, returnExprs, walkAst } from '../../ast.js'
import { nullishArm } from '../../kind.js'
import { KIND_UNIVERSE, VAL } from '../../reps.js'
import {
  ANY_BIGINT, BIGINT_READ_METHODS, BIGINT_REP_NONE, BIGINT_REP_TOP, BIGINT_TYPED_CTORS, BOXED_BIGINT, DEF_RHS,
  NO_BIGINT, NUMERIC_VALUE_OPS, RAW_BIGINT, STORAGE_READ_METHODS, STORAGE_WRITE_METHODS, VALUE_COERCERS,
  bigintRepBits, bigintRepIsClosed, callMember, collectDefs, collectLocalClosures, isBigintOrigin, isExported,
  joinRep, memberReceiver,
} from './common.js'

const EMPTY_SEEN = new Set()

/** baseName → [{params, body}] for every closure literal assigned as a
 *  property VALUE of a `let/const NAME = { … }` object literal declared
 *  anywhere in `roots` — Shape #7's actual watr dispatch-table pattern,
 *  `const HANDLER = { i64: (nodes) => encode.i64(nodes.shift()) }`, called
 *  through a computed member `HANDLER[imm](…)`. A computed-key call can't
 *  name its callee statically, but every closure that could possibly BE
 *  that callee is still syntactically enumerable right here — the same move
 *  collectLocalClosures already makes for a single bound name (`let parse =
 *  (x) => …`), promoted to every property of an object-literal table.
 *  Object-literal-inline only (mirrors collectLocalClosures' own single-
 *  shape scope, and dyn-closure-tables.js's explicit precedent for scoping
 *  a dispatch-table proof to one concrete construction shape): a table
 *  built up imperatively (`HANDLER.foo = (x) => …` after the fact) is a
 *  distinct, rarer shape — not watr's own encode-table pattern — left
 *  uncovered rather than guessed at. */
function collectDispatchTableClosures(roots) {
  const tables = new Map()
  const collect = node => walkAst(node, { enter: n => {
    if ((n[0] === 'let' || n[0] === 'const') && n.length === 2 &&
        Array.isArray(n[1]) && n[1][0] === '=' && typeof n[1][1] === 'string') {
      const init = n[1][2]
      // Match module/object.js's own ctx.core.emit['{}'] flattening EXACTLY
      // (not ast.js's descriptorProps, which assumes a different, pre-
      // compile bundler-stage shape): at THIS stage a multi-property
      // literal is a FLAT list of sibling `[':', key, value]` children
      // (`['{}', p1, p2, p3]`), only ever comma-wrapped into ONE child when
      // there's a single such wrapper node already — object.js's emitter
      // itself special-cases exactly that one shape and nothing else.
      const rawProps = Array.isArray(init) && init[0] === '{}' ? init.slice(1) : null
      const props = rawProps == null ? null
        : rawProps.length === 1 && Array.isArray(rawProps[0]) && rawProps[0][0] === ','
          ? rawProps[0].slice(1) : rawProps
      if (props) for (const prop of props) {
        if (!Array.isArray(prop) || prop[0] !== ':') continue
        const value = prop[2]
        if (!Array.isArray(value) || value[0] !== '=>') continue
        // A single param is a bare name directly under '()' (`['()', 'n']`);
        // more than one arrives comma-wrapped as ONE child (`['()', [',',
        // 'n', 'c', 'op', 'out']]`, watr's own real HANDLER.i64 shape) —
        // commaList (ast.js) already normalizes exactly this either/or,
        // the same helper this file's own call-argument sites use.
        const ps = commaList(value[1]?.[1])
        if (!ps.every(p => typeof p === 'string')) continue
        const name = n[1][1]
        let list = tables.get(name)
        if (!list) { list = []; tables.set(name, list) }
        list.push({ params: ps, body: value[2] })
      }
    }
  } })
  for (const root of roots) collect(root)
  return tables
}

/**
 * Forward existential provenance from real BigInt origins through bindings,
 * calls, returns, and named storage. Unknown semantic kind is not itself an
 * origin: this is the proof v1 lacked when it treated every TOP as raw-capable.
 */
export function solveBigintProvenance(ctx, programFacts, ast) {
  const namesByFunc = new Map()
  const paramsByFunc = new Map()
  const results = new Set()
  const resultReps = new Map()
  const storage = new Set()
  const bigintTyped = new Set()
  const globals = new Set()
  const globalReps = new Map()
  let indirectResult = false
  // Shape #7: every candidate callee a computed-key dispatch call
  // (`HANDLER[imm](nodes)`) could possibly reach, statically enumerated —
  // see collectDispatchTableClosures. Computed once; the AST this pass
  // walks is fixed for the whole fixpoint below.
  const dispatchTables = collectDispatchTableClosures([ast, ...(ctx.module.moduleInits || [])])
  // Shape #8: a `.`-member call's callee, proven (or not) by the frozen
  // call-target index (call-target-index.js) built once in plan/index.js
  // before this whole fixpoint starts. Every direct-callee branch below
  // already gates on `typeof node[1] === 'string'` (a bare name IS its own
  // callee, trivially); this gives the SAME branches a second way to name a
  // callee for a `['.', obj, method]` callee position, without changing
  // their behavior for anything the index can't prove — `resolveMemberCallee`
  // returns null for every other shape (computed dispatch stays on
  // dispatchTables above; an unresolved receiver/property stays exactly as
  // unresolved as it always was).
  const callTargets = programFacts.callTargets
  const resolveMemberCallee = calleeNode =>
    (Array.isArray(calleeNode) && calleeNode[0] === '.' &&
      typeof calleeNode[1] === 'string' && typeof calleeNode[2] === 'string')
      ? callTargets?.resolveMember(calleeNode[1], calleeNode[2]) ?? null
      : null

  const namesFor = func => {
    let names = namesByFunc.get(func)
    if (!names) { names = new Set(); namesByFunc.set(func, names) }
    return names
  }
  const paramsFor = func => {
    let set = paramsByFunc.get(func.name)
    if (!set) { set = new Set(); paramsByFunc.set(func.name, set) }
    return set
  }
  const mark = (set, value) => {
    if (set.has(value)) return false
    set.add(value)
    return true
  }

  const paramNeedsHostTag = (node, name, localClosures, seen, root = true) => {
    if (!Array.isArray(node)) return false
    if (!root && node[0] === '=>') return false
    if (node[0] === 'typeof' && node[1] === name) return true
    if (node[0] === 'u+' && node[1] === name) return true
    if (node[0] === '()' && node[1] === 'Number' && commaList(node[2]).includes(name)) return true
    // BigInt(name) — same producer as Number(name): BigInt() is a total
    // normalizer over string/number/boolean/bigint (ES2024 21.2.1.1), so a
    // param feeding it is well-equipped for the tagged ingress — a plain
    // host bigint there should box and pass through BigInt()'s identity
    // case, not be rejected as zero-evidence (phase-c C4b coordinator fix).
    if (node[0] === '()' && node[1] === 'BigInt' && commaList(node[2]).includes(name)) return true
    // Local-closure forwarding (closure-forwarding slice, .work/phase-c-
    // unification.md §C4b queue): `name` passed positionally into a SAME-BODY
    // closure (`let parse = (x) => …`) whose own param needs the tag —
    // watr's own uleb/limits shape, `f(v){ let parse = x => typeof x ===
    // 'bigint' ? x : BigInt(x); return parse(v)+1n }`. Mirrors
    // paramAllUsesNumeric's identical closure-forwarding judgement (compile/
    // index.js) for the numeric/pointer-proof lattice — same AST shape (a
    // `let NAME = (…) => BODY` local, found via localClosures below), same
    // cycle guard (`seen`, closure names visited on this recursion path) —
    // a different question (host-tag ingress) over the same forwarding
    // structure. Position-exact only (arg K proves param K, no textual
    // `.includes` — unlike Number()/BigInt() above, which are order-
    // insensitive single-arg builtins): `parse(other, name)` must not credit
    // `name` with whatever param 0 needs.
    if (node[0] === '()' && typeof node[1] === 'string' && localClosures?.has(node[1]) && !seen.has(node[1])) {
      const callee = localClosures.get(node[1])
      const args = commaList(node[2])
      const nextSeen = new Set(seen).add(node[1])
      for (let k = 0; k < args.length && k < callee.params.length; k++)
        if (args[k] === name && paramNeedsHostTag(callee.body, callee.params[k], localClosures, nextSeen, true))
          return true
    }
    for (let i = 1; i < node.length; i++) if (paramNeedsHostTag(node[i], name, localClosures, seen, false)) return true
    return false
  }

  for (const func of ctx.funcs.list) {
    if (func.raw || !func.sig) continue
    const row = programFacts.paramReps.get(func.name)
    const pset = paramsFor(func)
    const localClosures = isExported(ctx, func) ? collectLocalClosures(func.body) : null
    for (let k = 0; k < func.sig.params.length; k++) {
      const rep = row?.get(k)
      const observed = rep?.possibleKinds
      if (typeof rep?.typedCtor === 'string' && (rep.typedCtor.includes('BigInt64') || rep.typedCtor.includes('BigUint64')))
        bigintTyped.add(func.sig.params[k].name)
      if (rep?.val === VAL.BIGINT || rep?.presentVal === VAL.BIGINT ||
          (observed instanceof Set && observed.size < KIND_UNIVERSE.length && observed.has(VAL.BIGINT)) ||
          (isExported(ctx, func) && paramNeedsHostTag(func.body, func.sig.params[k].name, localClosures, EMPTY_SEEN)))
        pset.add(k)
    }
    for (const k of pset) namesFor(func).add(func.sig.params[k].name)
    if (func.valResult === VAL.BIGINT) results.add(func.name)
  }

  const defMapByFunc = new Map()
  for (const func of ctx.funcs.list)
    if (!func.raw && func.body) defMapByFunc.set(func, collectDefs(func.body))

  const exprMay = (node, func, localNames) => {
    if (isBigintOrigin(node)) return true
    if (typeof node === 'string') return localNames?.has(node) || globals.has(node)
    if (!Array.isArray(node) || nullishArm(node)) return false
    const op = node[0]
    if (op === '?:') return exprMay(node[2], func, localNames) || exprMay(node[3], func, localNames)
    if (op === '&&' || op === '||' || op === '??')
      return exprMay(node[1], func, localNames) || exprMay(node[2], func, localNames)
    if (op === ',') return exprMay(node[node.length - 1], func, localNames)
    if (op === '=' && typeof node[1] === 'string') return exprMay(node[2], func, localNames)
    if (op === 'typeof' || op === '!' || op === 'u+' || op === '>>>' ||
        op === '==' || op === '!=' || op === '===' || op === '!==' ||
        op === '<' || op === '>' || op === '<=' || op === '>=' || op === 'in' || op === 'instanceof') return false
    if (op === '[]' || op === '.' || op === '?.')
      return typeof node[1] === 'string' && (storage.has(node[1]) || (op === '[]' && bigintTyped.has(node[1])))
    if (op === '()') {
      if (typeof node[1] === 'string') {
        if (VALUE_COERCERS.has(node[1])) return false
        if (node[1] === 'Atomics.load') {
          const recv = commaList(node[2])[0]
          return typeof recv === 'string' && bigintTyped.has(recv)
        }
        if (BIGINT_TYPED_CTORS.has(node[1])) return false // constructor yields a TYPED pointer, not a BigInt value
        const callee = ctx.funcs.map.get(node[1])
        return callee ? results.has(callee.name) : false
      }
      if (Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.')) {
        const method = node[1][2]
        if (BIGINT_READ_METHODS.has(method)) return true
        if (STORAGE_READ_METHODS.has(method) && typeof node[1][1] === 'string')
          return storage.has(node[1][1]) || bigintTyped.has(node[1][1])
        // Shape #8: a same-module named function reached via `.`-member call
        // (`ns.parse(...)`) — proven, or not, by the call-target index.
        const resolved = resolveMemberCallee(node[1])
        return resolved ? results.has(resolved.name) : false
      }
      // Shape #7: a computed-key dispatch call (`HANDLER[imm](nodes)`) can't
      // name its callee statically, but when the base is a KNOWN dispatch
      // table (collectDispatchTableClosures), every closure that could
      // possibly BE that callee is enumerable — if ANY candidate's own
      // result may carry bigint, so may this call's. Additive only: an
      // unknown/untracked base (not in dispatchTables) falls through to the
      // existing indirectResult default, unchanged.
      if (Array.isArray(node[1]) && node[1][0] === '[]' && typeof node[1][1] === 'string') {
        const candidates = dispatchTables.get(node[1][1])
        if (candidates && candidates.some(dispatchClosureMayBigint)) return true
      }
      return indirectResult
    }
    // Arithmetic preserves a BigInt member from a BigInt operand. Object/
    // array/string construction returns a pointer and is not a BigInt value.
    if (op === '[' || op === '{}' || op === 'str' || op === 'bool' || op === 'new' ||
        (typeof op === 'string' && op.startsWith('new.'))) return false
    for (let i = 1; i < node.length; i++) if (exprMay(node[i], func, localNames)) return true
    return false
  }

  const exprRep = (node, func, localNames) => {
    if (!exprMay(node, func, localNames)) return NO_BIGINT
    if (isBigintOrigin(node)) return RAW_BIGINT
    if (typeof node === 'string') return globalReps.get(node) ?? ANY_BIGINT
    if (!Array.isArray(node)) return ANY_BIGINT
    if (node[0] === ',') return exprRep(node[node.length - 1], func, localNames)
    if (node[0] === '=') return exprRep(node[2], func, localNames)
    if (node[0] === '?:') return joinRep(exprRep(node[2], func, localNames), exprRep(node[3], func, localNames))
    if (node[0] === '&&' || node[0] === '||' || node[0] === '??')
      return joinRep(exprRep(node[1], func, localNames), exprRep(node[2], func, localNames))
    if (node[0] === '[]' && typeof node[1] === 'string')
      return bigintTyped.has(node[1]) ? RAW_BIGINT : storage.has(node[1]) ? BOXED_BIGINT : ANY_BIGINT
    if ((node[0] === '.' || node[0] === '?.') && typeof node[1] === 'string')
      return storage.has(node[1]) ? BOXED_BIGINT : ANY_BIGINT
    if (node[0] === '()') {
      if (typeof node[1] === 'string') {
        const callee = ctx.funcs.map.get(node[1])
        return callee ? resultReps.get(callee.name) ?? ANY_BIGINT : RAW_BIGINT
      }
      if (Array.isArray(node[1]) && BIGINT_READ_METHODS.has(node[1][2])) return RAW_BIGINT
      if (Array.isArray(node[1]) && STORAGE_READ_METHODS.has(node[1][2])) return BOXED_BIGINT
      // Shape #8: mirrors exprMay's own resolution above — exprRep is only
      // ever asked once exprMay has already proven `true`, so a resolved
      // member-call callee reads the SAME resultReps entry a bare-name call
      // to it would.
      const resolved = resolveMemberCallee(node[1])
      if (resolved) return resultReps.get(resolved.name) ?? ANY_BIGINT
    }
    if (NUMERIC_VALUE_OPS.has(node[0])) return RAW_BIGINT
    return ANY_BIGINT
  }

  // Shape #7: does ANY return tail of this dispatch-table closure candidate
  // itself carry bigint? A closure's OWN param-local names are unknown at
  // this vantage point (deriveLocalProvenance, a separate per-closure pass,
  // owns that later, once the closure actually mints its own plan) — so
  // this asks only what exprMay can prove without them: a bare BigInt
  // origin, a proven storage read, or (this pin's own shape) a call to an
  // already-provably-bigint NAMED function. Cycle-guarded (false while in
  // progress, mirroring representationResultTagRequired's seen-set idiom)
  // for a dispatch table whose own candidates call back into another one.
  const dispatchResultCache = new Map()
  const dispatchClosureMayBigint = c => {
    if (dispatchResultCache.has(c)) return dispatchResultCache.get(c)
    dispatchResultCache.set(c, false)
    const tails = Array.isArray(c.body) && c.body[0] === '{}' ? returnExprs(c.body) : [c.body]
    const result = tails.some(t => t != null && exprMay(t, null, EMPTY_SEEN))
    dispatchResultCache.set(c, result)
    return result
  }

  const noteResult = (func, expr) => {
    if (!func || !exprMay(expr, func, namesFor(func))) return false
    let changed = mark(results, func.name)
    const rep = exprRep(expr, func, namesFor(func))
    const prev = resultReps.get(func.name)
    const next = prev == null ? rep : joinRep(prev, rep)
    if (prev !== next) { resultReps.set(func.name, next); changed = true }
    return changed
  }

  const scan = (node, func, localNames) => {
    if (!Array.isArray(node)) return false
    let changed = false
    const op = node[0]
    if (Array.isArray(op)) {
      for (let i = 0; i < node.length; i++) if (scan(node[i], func, localNames)) changed = true
      return changed
    }
    if (op === '=>') return false
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const decl = node[i]
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' &&
            Array.isArray(decl[2]) && decl[2][0] === '()' && BIGINT_TYPED_CTORS.has(decl[2][1]))
          if (mark(bigintTyped, decl[1])) changed = true
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' &&
            exprMay(decl[2], func, localNames)) {
          if (mark(localNames, decl[1])) changed = true
          if (!func) {
            const rep = isBigintOrigin(decl[2]) ? RAW_BIGINT : ANY_BIGINT
            const prev = globalReps.get(decl[1])
            const next = prev == null ? rep : joinRep(prev, rep)
            if (prev !== next) { globalReps.set(decl[1], next); changed = true }
          }
        }
      }
    }
    if (op === '()') {
      // Shape #8: widen the direct-callee lookup from "bare name only" to
      // "bare name, or a `.`-member call the call-target index resolves" —
      // every rule below (call-arg BigInt propagation, forward/backward
      // storage taint) is otherwise unchanged and equally sound for either
      // shape once `callee` names a real same-module function.
      const callee = typeof node[1] === 'string' ? ctx.funcs.map.get(node[1]) : resolveMemberCallee(node[1])
      if (callee) {
        const args = commaList(node[2]), pset = paramsFor(callee)
        for (let k = 0; k < args.length && k < callee.sig.params.length; k++)
          if (exprMay(args[k], func, localNames) && mark(pset, k)) changed = true
        for (const k of pset) if (mark(namesFor(callee), callee.sig.params[k].name)) changed = true
        // A callee that mutates a storage-bearing param propagates that
        // storage provenance back to the caller's bare receiver argument.
        for (let k = 0; k < args.length && k < callee.sig.params.length; k++)
          if (storage.has(callee.sig.params[k].name) && typeof args[k] === 'string' && mark(storage, args[k])) changed = true
        // Shape #6 (.work/phase-c-unification.md, watr's actual manifestation
        // — compile.js's `i64: (n,…) => encode.i64(n.shift(), out)` handler
        // passing its OWN array param one level further before any read):
        // the MIRROR of the backward rule just above. A caller passing its
        // OWN storage-tainted bare-name receiver AS AN ARGUMENT hands the
        // callee the identical object (Array/Map/etc. are reference types —
        // no copy crosses the call), so the callee's corresponding param
        // holds that SAME storage-tainted receiver too. Without this, a
        // storage-read INSIDE the callee (`arr.shift()` where `arr` is the
        // callee's OWN param, never itself directly pushed/set) is invisible
        // to exprMay's STORAGE_READ_METHODS branch (which only consults
        // `storage.has(name)` for the read's OWN receiver name) — the callee
        // param's storage status was NEVER seeded, only ever inherited
        // backward from ITS OWN callees' mutations, never forward from ITS
        // OWN callers' arguments. Same soundness argument as the backward
        // rule: a receiver name (not a value) crossing a call boundary by
        // reference, not by copy.
        for (let k = 0; k < args.length && k < callee.sig.params.length; k++)
          if (typeof args[k] === 'string' && storage.has(args[k]) && mark(storage, callee.sig.params[k].name)) changed = true
      }
    }
    // Shape #7: the SAME forward+backward by-reference storage rules just
    // above, mirrored across EVERY candidate closure a computed-key
    // dispatch call could reach (dispatchTables) instead of one statically-
    // named callee. The call site can't narrow which candidate actually
    // fires, so — conservatively, matching how every other computed-arg
    // edge in this file already defaults to the safer/wider answer rather
    // than guessing — each candidate's correspondingly-positioned param
    // inherits the fact independently.
    if (op === '()' && Array.isArray(node[1]) && node[1][0] === '[]' && typeof node[1][1] === 'string') {
      const candidates = dispatchTables.get(node[1][1])
      if (candidates) {
        const args = commaList(node[2])
        for (const callee of candidates) {
          for (let k = 0; k < args.length && k < callee.params.length; k++) {
            if (typeof args[k] === 'string' && storage.has(args[k]) && mark(storage, callee.params[k])) changed = true
            if (storage.has(callee.params[k]) && typeof args[k] === 'string' && mark(storage, args[k])) changed = true
          }
        }
      }
    }
    if (op === '()' && Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.')) {
      const recv = node[1][1], method = node[1][2], args = commaList(node[2])
      if (STORAGE_WRITE_METHODS.has(method)) {
        const start = method === 'set' ? 1 : 0
        for (let k = start; k < args.length; k++)
          if (exprMay(args[k], func, localNames) && typeof recv === 'string' && mark(storage, recv)) changed = true
      }
    }
    if (ASSIGN_OPS.has(op) && typeof node[1] === 'string' && exprMay(node[2], func, localNames)) {
      if (mark(localNames, node[1])) changed = true
      // Body-write acquisition: a param that ACQUIRES its BigInt via a body
      // write (`if (r) v = 4n`, `if (typeof n === 'string') n = BigInt(n)`)
      // is bigint-provenant even when NO call site ever passes one. Without
      // this the boundary's mayBigint stays false, the plan never
      // materializes the tagged carrier for the binding, and the adopted
      // write-kind folds `typeof` wrong for the non-BigInt entries
      // (numberKind() === 'bigint' with Number-only call sites — found by
      // direct probe; the suite's own pin passes only because its source
      // also has a 5n call site that trips the call-arg provenance).
      if (func?.sig?.params) {
        const kp = func.sig.params.findIndex(p => p.name === node[1])
        if (kp >= 0 && mark(paramsFor(func), kp)) changed = true
      }
      if (!func) {
        const rep = isBigintOrigin(node[2]) ? RAW_BIGINT : ANY_BIGINT
        const prev = globalReps.get(node[1])
        const next = prev == null ? rep : joinRep(prev, rep)
        if (prev !== next) { globalReps.set(node[1], next); changed = true }
      }
    }
    if (ASSIGN_OPS.has(op) && Array.isArray(node[1]) && (node[1][0] === '[]' || node[1][0] === '.')) {
      const recv = node[1][1]
      if (exprMay(node[2], func, localNames) && typeof recv === 'string' && mark(storage, recv)) changed = true
    }
    if (op === 'return' && noteResult(func, node[1])) changed = true
    for (let i = 1; i < node.length; i++) if (scan(node[i], func, localNames)) changed = true
    return changed
  }

  // Shape #7 (i64.parse's own real watr shape, sibling gap): bigintTyped's
  // `const _i64 = new BigInt64Array(_buf)`-shaped match is a PURE SYNTACTIC
  // fact — it depends on nothing else in this fixpoint — but scan()'s own
  // discovery of it is still fixpoint-ROUND-timed: a function's OWN body is
  // walked (ctx.funcs.list order) before module-level declarations are
  // (scan(ast,…)/moduleInits run after every function, same round). A
  // typed-array element READ inside that SAME function, textually AFTER a
  // WRITE to it (`_i64[0] = bi; return _i64[0]`), sees `storage` already
  // seeded (the write itself marks it, same scan() call) but `bigintTyped`
  // still unset — exprRep's [] branch checks bigintTyped FIRST, falls
  // through to storage, and answers BOXED_BIGINT for one round. resultReps'
  // own accumulation (noteResult) is a MONOTONE JOIN across every round,
  // never a fresh recompute — that one transient wrong-for-a-round BOXED
  // answer joins permanently against the later, correct RAW_BIGINT answer
  // once bigintTyped catches up, producing a permanently AMBIGUOUS
  // (raw-or-boxed, closed) result the plan can never resolve to one
  // carrier. Fix at the root: seed bigintTyped from every BIGINT_TYPED_CTORS
  // declaration, program-wide, in ONE pass BEFORE the fixpoint's first round
  // — a purely syntactic fact needs no round-by-round discovery at all.
  const seedBigintTyped = node => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (Array.isArray(op)) { for (let i = 0; i < node.length; i++) seedBigintTyped(node[i]); return }
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const decl = node[i]
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' &&
            Array.isArray(decl[2]) && decl[2][0] === '()' && BIGINT_TYPED_CTORS.has(decl[2][1]))
          bigintTyped.add(decl[1])
      }
    }
    for (let i = 1; i < node.length; i++) seedBigintTyped(node[i])
  }
  for (const func of ctx.funcs.list) if (!func.raw && func.body) seedBigintTyped(func.body)
  seedBigintTyped(ast)
  if (ctx.module.moduleInits) for (const init of ctx.module.moduleInits) seedBigintTyped(init)

  let graphChanged = true
  while (graphChanged) {
    graphChanged = false
    for (const func of ctx.funcs.list) {
      if (func.raw || !func.body) continue
      const names = namesFor(func), defs = defMapByFunc.get(func)
      let localChanged = true
      while (localChanged) {
        localChanged = false
        for (const [name, entries] of defs) {
          for (const entry of entries) if (entry[DEF_RHS] != null && exprMay(entry[DEF_RHS], func, names)) {
            if (mark(names, name)) { localChanged = true; graphChanged = true }
            break
          }
          // Storage aliases preserve the receiver's content provenance.
          for (const entry of entries) if (typeof entry[DEF_RHS] === 'string') {
            if (storage.has(entry[DEF_RHS]) && mark(storage, name)) { localChanged = true; graphChanged = true }
            if (bigintTyped.has(entry[DEF_RHS]) && mark(bigintTyped, name)) { localChanged = true; graphChanged = true }
          }
        }
      }
      if (!Array.isArray(func.body) || func.body[0] !== '{}')
        if (noteResult(func, func.body)) graphChanged = true
      if (scan(func.body, func, names)) graphChanged = true
    }
    if (!indirectResult)
      for (const name of programFacts.valueUsed) if (results.has(name)) { indirectResult = true; graphChanged = true; break }
    if (scan(ast, null, globals)) graphChanged = true
    if (ctx.module.moduleInits) for (const init of ctx.module.moduleInits)
      if (scan(init, null, globals)) graphChanged = true
  }

  // Shape #6 layer 5 (.work/phase-c-unification.md): a COVERED function's
  // param semantic (makeBoundaryData's boundaryParamSemantic) trusts the
  // legacy whole-program paramReps census's `possibleKinds` as-is whenever
  // it's closed — but that census has no notion of a storage-read call
  // argument (`g(arr.at(i))`): unable to narrow, it reports the maximal
  // "could be any of the 14 kinds" set, itself marked closed (a confident-
  // looking but uninformative answer). buildBodyData's materializedNames
  // fixpoint reads that closed-ALL semantic, sees the BOOL member it
  // necessarily carries, and vetoes materialization outright — permanently,
  // since a param's semantic only WIDENS from its boundary seed (joinSem
  // is a union, never a narrowing). The reassigned param then never enters
  // its OWN callee body's materializedNames, so every caller's
  // representationCallArgAction sees an empty set — not an ordering race
  // (mintRepresentationPlan/buildBodyData already run callee-before-caller,
  // verified live), a deterministic precision gap.
  //
  // A COVERED boundary enumerates every possible caller by construction —
  // uncovered is exactly generic/exported/value-used (makeBoundaryData), so
  // anything else is unreachable except through its literal, enumerable
  // call sites. This final pass (after the fixpoint above has fully
  // settled — storage/bigintTyped/namesByFunc must already be at their
  // final widened sets, or an early round's exprMay/exprRep verdict would
  // stamp a stale false negative) re-visits every direct call site in the
  // program and asks exprRep's own STORAGE_READ_METHODS-aware proof of each
  // argument. A param earns paramBigintOnly when EVERY call site's argument
  // at that index is a provably CLOSED bigint (RAW or BOXED — representation
  // doesn't matter, only kind purity) — an arity gap (fewer args than the
  // param needs, defaulting to `undefined`) or any non-closed-bigint
  // argument marks it impure, permanently (a genuine union stays a union;
  // this proof fires only when NOTHING else can ever reach the param).
  // Mirrors resultReps' own exprRep-based precision for RESULTS, now giving
  // PARAMS the equivalent it never had. A bare-name argument (`h(n)`, not a
  // direct storage-read/literal/call expression) resolves through exprRep
  // as ANY_BIGINT — open, not closed — so this proof conservatively misses
  // (never wrongly admits) the chained-forwarding case; that is a missed
  // opportunity, not a soundness gap, and stays out of this slice's scope.
  const paramBigintOnly = new Map()
  const paramMixed = new Map()
  const markCallArg = (calleeName, k, pure) => {
    let mixedSet = paramMixed.get(calleeName)
    if (!mixedSet) { mixedSet = new Set(); paramMixed.set(calleeName, mixedSet) }
    if (mixedSet.has(k)) return // already proven mixed elsewhere; sticky
    if (!pure) {
      mixedSet.add(k)
      const priorPure = paramBigintOnly.get(calleeName)
      if (priorPure) priorPure.delete(k)
      return
    }
    let pureSet = paramBigintOnly.get(calleeName)
    if (!pureSet) { pureSet = new Set(); paramBigintOnly.set(calleeName, pureSet) }
    pureSet.add(k)
  }
  // Shape #7 (encode.i64's real watr shape): a param can be BODY-WRITE
  // provenant for BigInt (`if (typeof n==='string') n = BigInt(n)`, a
  // genuine mixed string/number/bigint entry) while its ONLY call-site
  // argument is a storage read on an array that is NOT bigint-pure (watr's
  // `nodes` holds parsed WAT syntax — strings, nested arrays — the actual
  // i64 immediate arrives as text, normalized to BigInt only inside the
  // callee). paramBigintOnly (above) correctly, conservatively answers NO
  // for this shape (the argument truly isn't closed-bigint) — but the
  // boundary semantic that answer feeds still carries the coarse
  // closed-ALL-14-kinds legacy census (the same "confident but
  // uninformative" answer layer 5 names, here for a genuinely mixed
  // receiver rather than an unnarrowable bigint-pure one), whose synthetic
  // BOOL member vetoes materialization outright — even though the value
  // can never actually be a JS boolean at this call site: it comes from a
  // storage READ, which — the SAME invariant the existing identitySafeStorage
  // Flow carve-out already relies on (buildBodyData) — is individually
  // self-tagged per element at the wire, so any bigint-specific edge this
  // plan wires up (a bigint-origin WRITE boxes, a definite-bigint READ
  // unboxes) is gated per-expression by valTypeOf/isBigintOrigin
  // (ir.js's applyBigintRepresentationAction) and simply never fires for
  // whatever OTHER kind actually flows through on a given call — narrowing
  // the SEMANTIC to exclude BOOL specifically (not claiming bigint purity,
  // only boolean-impossibility) cannot misinterpret a real bool the way
  // forcing a raw-carrier guess would. `paramNeverBool` earns the mark when
  // EVERY call-site argument at that index is STRUCTURALLY a storage read
  // (any receiver, any content-kind — a strictly weaker bar than
  // paramBigintOnly's kind-purity one) — an arity gap or any non-storage-
  // read argument marks it impure, permanently, same sticky discipline.
  const paramNeverBool = new Map()
  const paramBoolPossible = new Map()
  const markNeverBoolArg = (calleeName, k, neverBool) => {
    let poss = paramBoolPossible.get(calleeName)
    if (!poss) { poss = new Set(); paramBoolPossible.set(calleeName, poss) }
    if (poss.has(k)) return
    if (!neverBool) {
      poss.add(k)
      const prior = paramNeverBool.get(calleeName)
      if (prior) prior.delete(k)
      return
    }
    let set = paramNeverBool.get(calleeName)
    if (!set) { set = new Set(); paramNeverBool.set(calleeName, set) }
    set.add(k)
  }
  const isStorageReadArgShape = node => {
    if (!Array.isArray(node)) return false
    const recv = memberReceiver(node)
    if (recv != null) return true
    const cm = callMember(node)
    return !!cm && STORAGE_READ_METHODS.has(cm[2])
  }
  // Shape #9 (a bare-name sibling of shape #7's own paramNeverBool gap): a
  // call argument that is a REASSIGNED CALLER LOCAL (`leb(n)` inside
  // `function i64(n) { if (typeof n === 'string') n = parseIt(n); return
  // leb(n) }`) resolves through exprRep/isStorageReadArgShape as neither a
  // literal/call bigint origin nor a storage read — the legacy whole-program
  // paramReps census (feeding makeBoundaryData's `rep`) then has no narrower
  // answer than "any of the 14 kinds, closed" for the CALLEE's param either,
  // whose synthetic BOOL member vetoes materialization permanently (the
  // callee's own body never enters materializedNames for ANY caller). Same
  // root class, same fix shape as storage reads: prove boolean-impossibility
  // STRUCTURALLY, not kind purity. A name's value at any point in its OWN
  // function is drawn from its entry (if a parameter) plus every explicit
  // reassignment RHS (collectDefs is flow-INSENSITIVE — this reasoning
  // already matches how buildBodyData's own semantic/current fixpoints treat
  // the identical defs map elsewhere in this file) — proving EVERY one of
  // those sources excludes boolean is a sound, if conservative,
  // over-approximation regardless of which one actually reaches this call at
  // runtime. Recursing one level into a called function's OWN return
  // tail(s) is pure AST shape inspection (isBigintOrigin), never plan or
  // provenance data, so it carries no ordering hazard against the
  // callee-before-caller settling this file's other cross-function facts
  // rely on.
  const paramEntryExcludesBool = (func, idx) => {
    const rep = programFacts.paramReps.get(func.name)?.get(idx)
    if (!rep) return false
    if (rep.possibleKinds instanceof Set && rep.possibleKinds.size)
      return rep.kindsCoverage === 'closed' && !rep.possibleKinds.has(VAL.BOOL)
    const kind = rep.val || rep.presentVal
    return !!kind && kind !== VAL.BOOL
  }
  const structurallyNeverBoolExpr = (node, seen) => {
    if (isBigintOrigin(node)) return true
    if (isStorageReadArgShape(node)) return true
    // A NUMBER literal (kind.js's own valTypeOf treats a bare JS number as
    // exactly this — never a variable reference, see its "Literal forms"
    // comment) and a STRING literal/concat result (the `['str', …]` tag —
    // per C5b's hardening sweep, the ONLY producer of this shape) are each
    // structurally never-bool by their own AST tag, no recursion needed.
    if (typeof node === 'number') return true
    if (Array.isArray(node) && node[0] === 'str') return true
    if (!Array.isArray(node) || node[0] !== '()') return false
    // Shape #9 sibling: a `.`-member callee the call-target index resolves
    // (Shape #8) is exactly as real a same-module callee as a bare name for
    // this recursion — without this, `n = i64.parse(n)` (watr's own shape)
    // can never prove its own reaching def never-bool, so a caller passing
    // `n` onward never clears the callee's BOOL-veto either.
    const callee = typeof node[1] === 'string' ? ctx.funcs.map.get(node[1]) : resolveMemberCallee(node[1])
    if (!callee || !callee.body || seen.has(callee)) return false
    const tails = Array.isArray(callee.body) && callee.body[0] === '{}' ? returnExprs(callee.body) : [callee.body]
    if (tails.length === 0) return false
    const nextSeen = new Set(seen).add(callee)
    return tails.every(t => t != null && structurallyNeverBoolExpr(t, nextSeen))
  }
  const argStructurallyNeverBool = (node, func) => {
    if (structurallyNeverBoolExpr(node, EMPTY_SEEN)) return true
    if (typeof node !== 'string' || !func) return false
    const list = defMapByFunc.get(func)?.get(node)
    const idx = func.sig?.params?.findIndex(p => p.name === node) ?? -1
    // A `let`/`const` local's declaration is itself a collected def (collect
    // Defs adds the initializer), so `list` alone is its complete reaching
    // set. Only a PARAMETER has an implicit entry value beyond its own
    // explicit reassignment defs.
    if (idx >= 0 && !paramEntryExcludesBool(func, idx)) return false
    if (idx < 0 && (!list || list.length === 0)) return false
    if (!list || list.length === 0) return idx >= 0
    return list.every(def => def[DEF_RHS] != null && structurallyNeverBoolExpr(def[DEF_RHS], EMPTY_SEEN))
  }
  const visitCallSites = (node, func, localNames) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (Array.isArray(op)) { for (let i = 0; i < node.length; i++) visitCallSites(node[i], func, localNames); return }
    // Shape #7: a closure body's call to a NAMED function (watr's dispatch-
    // table shape, `const HANDLER = { i64: (nodes) => leb(nodes.shift()) }`)
    // is a real, enumerable call site for THAT function's param evidence —
    // unlike scan()'s local-name/storage fixpoint (which closures correctly
    // re-derive on their own via deriveLocalProvenance, a different
    // question), this pass only asks "what does every direct call site,
    // anywhere, prove about callee param K" and a closure's own scope is
    // irrelevant to that question for a callee OUTSIDE the closure. Fresh
    // (empty) scope on descent: a bare-name argument inside the closure may
    // shadow an unrelated same-named enclosing binding, so this
    // conservatively MISSES that one narrow shape rather than risk crediting
    // the wrong name — the common real shape (a storage read, a literal, a
    // nested call) resolves through exprMay's whole-program storage/
    // bigintTyped/results sets, which need no localNames at all.
    if (op === '=>') { visitCallSites(node[2], null, EMPTY_SEEN); return }
    if (op === '()') {
      // Shape #8: same widening as scan's call-arg block above — a `.`-member
      // call the index resolves is a real, enumerable call site for the
      // resolved function's paramBigintOnly/paramNeverBool census too.
      const callee = typeof node[1] === 'string' ? ctx.funcs.map.get(node[1]) : resolveMemberCallee(node[1])
      if (callee && callee.sig && callee.sig.params) {
        const args = commaList(node[2])
        for (let k = 0; k < callee.sig.params.length; k++) {
          const rep = k < args.length ? exprRep(args[k], func, localNames) : NO_BIGINT
          const closedBigint = bigintRepIsClosed(rep) &&
            bigintRepBits(rep) !== BIGINT_REP_NONE && bigintRepBits(rep) !== BIGINT_REP_TOP
          markCallArg(callee.name, k, closedBigint)
          markNeverBoolArg(callee.name, k, k < args.length && argStructurallyNeverBool(args[k], func))
        }
      }
    }
    for (let i = 1; i < node.length; i++) visitCallSites(node[i], func, localNames)
  }
  for (const func of ctx.funcs.list) if (!func.raw && func.body) visitCallSites(func.body, func, namesFor(func))
  visitCallSites(ast, null, globals)
  if (ctx.module.moduleInits) for (const init of ctx.module.moduleInits) visitCallSites(init, null, globals)

  return { namesByFunc, paramsByFunc, results, resultReps, storage, bigintTyped, globals, globalReps, indirectResult, exprMay, paramBigintOnly, paramNeverBool, resolveMemberCallee }
}

export function deriveLocalProvenance(sig, body, localReps, program) {
  const names = new Set(), params = new Set(), storage = new Set()
  const scanStorage = node => walkAst(node, { enter: (n, parent) => {
    if (parent !== null && n[0] === '=>') return false
    const cm = callMember(n)
    if (cm && typeof cm[1] === 'string' &&
        (STORAGE_READ_METHODS.has(cm[2]) || STORAGE_WRITE_METHODS.has(cm[2]))) storage.add(cm[1])
    if (ASSIGN_OPS.has(n[0]) && Array.isArray(n[1]) && n[1][0] === '[]' && typeof n[1][1] === 'string')
      storage.add(n[1][1])
  } })
  scanStorage(body)
  const localExprMay = expr => {
    const recv = memberReceiver(expr), cm = callMember(expr)
    if (recv != null && storage.has(recv)) return true
    if (cm && STORAGE_READ_METHODS.has(cm[2]) && storage.has(cm[1])) return true
    return program.exprMay(expr, null, names)
  }
  const observedParams = program?.closureParams.get(sig?.name)
  for (let k = 0; k < (sig?.params?.length || 0); k++) {
    const name = sig.params[k].name, rep = localReps?.get(name)
    if (rep?.val === VAL.BIGINT || rep?.presentVal === VAL.BIGINT || observedParams?.has(k)) {
      params.add(k)
      names.add(name)
    }
  }
  if (localReps) for (const [name, rep] of localReps)
    if (rep?.val === VAL.BIGINT || rep?.presentVal === VAL.BIGINT) names.add(name)
  const defs = collectDefs(body)
  let changed = true
  while (changed) {
    changed = false
    for (const [name, entries] of defs)
      if (!names.has(name) && entries.some(entry => entry[DEF_RHS] != null && localExprMay(entry[DEF_RHS]))) {
        names.add(name)
        changed = true
      }
  }
  const tails = Array.isArray(body) && body[0] === '{}' ? returnExprs(body) : [body]
  return { names, params, storage, result: tails.some(localExprMay) }
}
