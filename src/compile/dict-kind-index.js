import { MUTATE_OPS, isLiteralStr, isFuncRef, callArgs, extractParams, classifyParam, PARAM_NAME } from '../ast.js'
import { staticObjectProps, staticArrayElems } from '../static.js'
import { valTypeOf } from '../kind.js'

// DictKindIndex — proves per-KEY kinds for a receiver that is declared as a
// plain array literal (`let/const T = []`, never schema-registered — that
// mechanism only ever fires on an `op==='{}'` AST node, kind.js/inferSchemaId)
// but is used as a STRING-keyed dictionary via exactly one shape:
//
//   for (let/const K in OBJ) T[K] = VALUE            // and/or
//   for (let/const K in OBJ) T[OBJ[K]] = T[K] = VALUE
//
// where OBJ is a same-or-cross-module CONSTANT object literal (every key
// statically named — staticObjectProps) and VALUE's kind is loop-invariant
// (the SAME static AST shape every iteration — never depends on K). This is
// .work/archive/string-method-guess-notes.md's own "seventh session" FOURTH
// limitation, closed generally: watr's real
// `for (let kind in SECTION) (ctx[SECTION[kind]] = ctx[kind] = []).name = kind`
// (src/compile.js ~91) is the ONE concrete instance, but nothing here is
// watr-specific — any program with this exact shape benefits, and any
// deviation (dynamic key, non-constant OBJ, an escaping T) declines cleanly.
//
// Altitude: option (b) from the task brief — a pure FACT, never an AST
// rewrite. T's own codegen (array representation, push/length/etc.) is
// completely unchanged; only a NEW per-key kind census feeds narrow.js's
// inferValAtSite `.`-read case (session seven's own landed mechanism) as an
// additional source alongside ctx.schema.slotVTBySid. kind.js's own
// INVARIANT comment on dictValueTypes/dictValueKindOf (three prior reverts
// for unsoundness) is the reason this is its OWN, narrower mechanism instead
// of widening that one: every fact here is presence-and-kind PROVEN from a
// closed, enumerated set of WRITES this file itself walks and classifies —
// never inferred from a read, never a "most sites agree" heuristic.
//
// Soundness rests on ONE whole-pipeline invariant, already relied on by this
// branch's own sixth session (program-facts.js's synthesizeComputedDispatch-
// CallSites, "BindingId totality"): prepare/index.js's mintLocal renames
// EVERY function-local binding (param or let/const/var, any nesting depth)
// to a module-wide-unique `name<T>f<fnId>_<serial>` BEFORE this pass ever
// runs (plan/index.js calls buildDictKindIndex after prepare has fully run,
// same stage as buildCallTargetIndex) — bare names survive only at true
// module scope. So a function-local target's exact spelling can never
// collide with any other binding anywhere in the program: walking the WHOLE
// program for every bare-string occurrence of that one spelling is exhaustive
// and unambiguous, no separate shadow-scan needed (module-level targets —
// rarer, but part of the task's own "local/module target" framing — reuse
// call-target-index.js's collectShadowedNames for the identical protection
// that file already gives its own module-top-level receivers).
//
// A target's value can be THREADED through the program as an ordinary
// argument (watr's real ctx is — `instr(nodes, ctx)`, `HANDLER[imm](nodes,
// ctx, op, out)`) without that alone invalidating the census: a write
// reaching T through an ALIASED parameter (a genuinely different, callee-
// owned binding referring to the SAME runtime array — confirmed real for
// watr: `build[SECTION.code]`'s own arrow writes `ctx.local`/`ctx.block`/
// `ctx.meta` through its OWN 2nd parameter) is exactly as much a hazard as a
// direct write, so this file follows the alias through the TWO closed,
// already-audited forwarding channels this codebase provides — a same-
// module NAMED function's own parameter at the same position
// (ctx.funcs.map/names), or a call-target-index.js resolveComputed member's
// own parameter at the same position (named-function member or inline-arrow
// member, the identical substitution channel synthesizeComputedDispatch-
// CallSites already trusts) — and recurses (bounded, memoized) into the
// alias's OWN occurrences the SAME way. Any OTHER value-position use
// (assigned to a second binding, returned, spread, compared, an unresolvable
// callee) declines the WHOLE target: no way to rule out an invisible write
// through it, so no per-key fact can be trusted at all.

const POISON = Symbol('dict-kind-index poison')
const ALIAS_BOUND = 128 // generous; a real program's forwarding graph is orders of magnitude smaller

/** Every top-level statement of a `[';', ...]`/single-statement body, flattened one level — used
 *  only for the for-in loop's own synthesized `[';', bindEach, innerBody]` wrapper. */
const seqStmts = node => Array.isArray(node) && node[0] === ';' ? node.slice(1) : [node]

/** Match `for (let/const K in OBJ) BODY`'s prepare-lowered shape (src/prepare/index.js's own
 *  for-in desugar, confirmed empirically against the actual post-prepare AST — NOT theorized):
 *    ['for', ['let', ['=',ks,keysExpr], ['=',ix,zero], ['=',lenV,lenExpr]],
 *            ['<',ix,lenV], ['++',ix], [';', ['let',['=',K,['[]',ks,ix]]], innerBody]]
 *  keysExpr is either `['()','__keys_ro',OBJ]` (a non-nullable direct receiver) or the
 *  nullish-guarded `['?:',['==',OBJ,[null,null]],['['],['()','__keys_ro',OBJ]]` (a bare-name
 *  receiver, watr's real SECTION case — a cross-module import is exactly a bare name here).
 *  Returns `{ objName, K, innerBody }` or null on ANY shape mismatch — never a partial match;
 *  a `for (x.y in …)`/assignment-form/for-of loop (different lowering entirely) never matches. */
function matchForInShape(node) {
  if (!Array.isArray(node) || node[0] !== 'for' || node.length !== 5) return null
  const [, decls, cond, step, bodyStmt] = node
  if (!Array.isArray(decls) || decls[0] !== 'let' || decls.length !== 4) return null
  const [, ksA, ixA, lenA] = decls
  if (!Array.isArray(ksA) || ksA[0] !== '=' || typeof ksA[1] !== 'string') return null
  if (!Array.isArray(ixA) || ixA[0] !== '=' || typeof ixA[1] !== 'string') return null
  if (!Array.isArray(lenA) || lenA[0] !== '=' || typeof lenA[1] !== 'string') return null
  const ks = ksA[1], ix = ixA[1], lenV = lenA[1]
  if (!Array.isArray(cond) || cond[0] !== '<' || cond[1] !== ix || cond[2] !== lenV) return null
  if (!Array.isArray(step) || step[0] !== '++' || step[1] !== ix) return null
  const keysExpr = ksA[2]
  let objName = null
  if (Array.isArray(keysExpr) && keysExpr[0] === '()' && keysExpr[1] === '__keys_ro' && typeof keysExpr[2] === 'string')
    objName = keysExpr[2]
  else if (Array.isArray(keysExpr) && keysExpr[0] === '?:' &&
           Array.isArray(keysExpr[1]) && keysExpr[1][0] === '==' && typeof keysExpr[1][1] === 'string' &&
           Array.isArray(keysExpr[2]) && keysExpr[2][0] === '[' &&
           Array.isArray(keysExpr[3]) && keysExpr[3][0] === '()' && keysExpr[3][1] === '__keys_ro' && keysExpr[3][2] === keysExpr[1][1])
    objName = keysExpr[1][1]
  if (!objName) return null
  if (!Array.isArray(bodyStmt) || bodyStmt[0] !== ';' || bodyStmt.length !== 3) return null
  const [, bindEach, innerBody] = bodyStmt
  if (!Array.isArray(bindEach) || bindEach[0] !== 'let' || bindEach.length !== 2) return null
  const kAssign = bindEach[1]
  if (!Array.isArray(kAssign) || kAssign[0] !== '=' || typeof kAssign[1] !== 'string') return null
  const kExpr = kAssign[2]
  if (!Array.isArray(kExpr) || kExpr[0] !== '[]' || kExpr[1] !== ks || kExpr[2] !== ix) return null
  return { objName, K: kAssign[1], innerBody }
}

/**
 * Build the frozen dict-kind index. Called once from plan/index.js, right after
 * buildCallTargetIndex/synthesizeComputedDispatchCallSites settle (the alias walk's
 * computed-dispatch-forwarding channel resolves through callTargets.resolveComputed).
 *
 * @returns {{resolveDictKind: (name: string, key: string) => number|null}}
 *   `resolveDictKind` returns a VAL.* kind or null — callers MUST treat null exactly
 *   like any other unproven receiver, never guess.
 */
export function buildDictKindIndex(ctx, programFacts, ast, callTargets) {
  const moduleInits = ctx.module.moduleInits || []
  const roots = [ast, ...moduleInits]

  // ---- Pass 1: every bare-name occurrence, program-wide, `=>`-transparent ----
  // (a) `decl` — candidate root: `let/const NAME = [...]` (array-literal init).
  // (b) `safe` — receiver of `.`/`?.`/`[]` in READ position: doesn't expose the name.
  // (c) `literalWrite` — a plain `.prop=`/`['str']=` write: {key, valueNode}.
  // (d) `loopKeyWrite` — `NAME[K]=VALUE` inside a recognized for-in-unroll for THIS K: {objName, valueNode}.
  // (e) `loopNumericWrite` — `NAME[OBJ[K]]=…` for the same loop: recognized, unmodeled.
  // (f) `fwdNamed`/`fwdComputed` — argument i to a resolvable same-module call: a new alias edge.
  // (g) `poison` — anything else: whole-name reassignment, a dynamic/unrecognized computed-key
  //     write, an unresolvable call argument, or any other ordinary value position.
  const occurrencesByName = new Map()
  const candidateRoots = new Set()
  const record = (name, occ) => {
    let arr = occurrencesByName.get(name)
    if (!arr) { arr = []; occurrencesByName.set(name, arr) }
    arr.push(occ)
  }

  const walkComputedWriteKey = (target, key, valueNode, activeLoops) => {
    for (let i = activeLoops.length - 1; i >= 0; i--) {
      const loop = activeLoops[i]
      if (key === loop.K) { record(target, { t: 'loopKeyWrite', objName: loop.objName, K: loop.K, valueNode }); return true }
      if (Array.isArray(key) && key[0] === '[]' && key[1] === loop.objName && key[2] === loop.K) {
        record(target, { t: 'loopNumericWrite' }); return true
      }
    }
    return false
  }

  const walk = (node, activeLoops) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'import' || op === 'export') return

    if (op === 'for' && node.length === 5) {
      const loop = matchForInShape(node)
      if (loop) { walk(loop.innerBody, [...activeLoops, loop]); return }
      // unrecognized for-loop shape: fall through to generic handling of every child below
    }

    if (MUTATE_OPS.has(op)) {
      const lhs = node[1], rhs = node.length > 2 ? node[2] : undefined
      // A logical assignment (`??=`/`||=`/`&&=`) either leaves the slot exactly as it
      // already was (its short-circuit branch) or sets it to RHS (same as plain `=`) —
      // never a THIRD, newly-derived kind the way arithmetic/bitwise compound ops
      // (`+=`, `|=`, …) can. "Left unchanged" contributes no new fact beyond what
      // every OTHER write to the same key already establishes, and this census's own
      // meet-on-disagreement fold (foldKey) already catches a real conflict between
      // this write's RHS and any other — so folding RHS's kind here is exactly as
      // sound as for `=`, not a widening. Watr's real `(ctx.metadata ??= {})[type]
      // ??= []` is exactly this shape (module/object metadata + a dict-of-arrays
      // idiom) — treating it as poison-on-sight was needlessly conservative.
      const plainOrLogical = op === '=' || op === '??=' || op === '||=' || op === '&&='
      if (typeof lhs === 'string') { record(lhs, { t: 'poison' }); if (rhs !== undefined) walk(rhs, activeLoops); return }
      if (Array.isArray(lhs) && lhs[0] === '.' && typeof lhs[1] === 'string' && typeof lhs[2] === 'string') {
        if (plainOrLogical) record(lhs[1], { t: 'literalWrite', key: lhs[2], valueNode: rhs })
        else record(lhs[1], { t: 'poison' }) // compound mutation (+=, ++, …) through a literal prop
        if (rhs !== undefined) walk(rhs, activeLoops)
        return
      }
      if (Array.isArray(lhs) && lhs[0] === '[]' && typeof lhs[1] === 'string') {
        const target = lhs[1], key = lhs[2]
        if (plainOrLogical) {
          if (isLiteralStr(key)) record(target, { t: 'literalWrite', key: key[1], valueNode: rhs })
          else if (!walkComputedWriteKey(target, key, rhs, activeLoops)) record(target, { t: 'poison' })
        } else record(target, { t: 'poison' }) // compound mutation through a computed key
        walk(key, activeLoops)
        if (rhs !== undefined) walk(rhs, activeLoops)
        return
      }
      // some other mutation LHS shape (destructuring, etc.) — walk generically below
    }

    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
          if (Array.isArray(d[2]) && d[2][0] === '[') { record(d[1], { t: 'decl' }); candidateRoots.add(d[1]) }
          walk(d[2], activeLoops)
        } else walk(d, activeLoops)
      }
      return
    }

    if (op === '.' || op === '?.') {
      if (typeof node[1] === 'string') record(node[1], { t: 'safe' })
      else walk(node[1], activeLoops)
      return // the property NAME (node[2]) is never itself a bound name
    }

    if (op === '[]') {
      if (typeof node[1] === 'string') record(node[1], { t: 'safe' })
      else walk(node[1], activeLoops)
      if (node.length > 2) walk(node[2], activeLoops)
      return
    }

    if (op === '=>') { walk(node[2], activeLoops); return } // params: see file header — default-expr writes not scanned (out of scope, see notes)

    if (op === '()') {
      const callee = node[1]
      if (typeof callee === 'string') record(callee, { t: 'safe' })
      else walk(callee, activeLoops)
      const namedFn = typeof callee === 'string' && ctx.funcs.names.has(callee)
      const computedObj = Array.isArray(callee) && callee[0] === '[]' && typeof callee[1] === 'string' ? callee[1] : null
      const args = callArgs(node) || []
      for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (typeof a === 'string') {
          if (namedFn) record(a, { t: 'fwdNamed', callee, pos: i })
          else if (computedObj) record(a, { t: 'fwdComputed', objName: computedObj, pos: i })
          else record(a, { t: 'poison' })
        } else walk(a, activeLoops)
      }
      return
    }

    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (typeof c === 'string') record(c, { t: 'poison' })
      else walk(c, activeLoops)
    }
  }

  for (const root of roots) walk(root, [])
  for (const func of ctx.funcs.list) if (func.body) walk(func.body, [])

  // ---- shared "find NAME's own never-reassigned let/const initializer" lookup ----
  // Used by both constObjKeys (the for-in loop's own OBJ — a `{}`-literal) and
  // constArrayElems (a second, closely-related dispatch-table shape watr's real
  // program ALSO uses — build[SECTION.code](item, ctx): a POSITIONAL array-of-
  // arrows table, `const build = [ (args)=>{…}, … ]`, indexed by SECTION's own
  // numeric VALUES rather than resolveComputed's string-keyed object literals).
  // Same roots, same discipline every producer in this file family already uses:
  // never reassigned as a whole anywhere in the program (a whole-binding
  // reassignment could make a reader see an entirely different value at runtime
  // than this declaration-site snapshot — misreporting PRESENCE, not just kind/
  // membership). Memoized per name.
  const declCache = new Map()
  const findConstInit = (name) => {
    if (declCache.has(name)) return declCache.get(name)
    let result = null
    const findDecl = (node) => {
      if (result !== null || !Array.isArray(node)) return
      if (node[0] === 'let' || node[0] === 'const') {
        for (let i = 1; i < node.length; i++) {
          const d = node[i]
          if (Array.isArray(d) && d[0] === '=' && d[1] === name) { result = d[2]; return }
        }
      }
      for (let i = 1; i < node.length; i++) findDecl(node[i])
    }
    for (const root of roots) { findDecl(root); if (result !== null) break }
    if (result === null) for (const func of ctx.funcs.list) { if (result !== null) break; if (func.body) findDecl(func.body) }
    if (result !== null) {
      // A decl's OWN `['=', NAME, init]` child is the BINDING itself, not a reassignment —
      // handled explicitly here (walk the initializer only) so it is never ALSO read as a
      // MUTATE_OPS hit below — the exact false-positive call-target-index.js's own
      // collectMemberWrites already documents avoiding for this identical shape.
      let reassigned = false
      const reassignScan = (node) => {
        if (reassigned || !Array.isArray(node)) return
        if (node[0] === 'let' || node[0] === 'const') {
          for (let i = 1; i < node.length; i++) {
            const d = node[i]
            if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') reassignScan(d[2])
            else reassignScan(d)
          }
          return
        }
        if (MUTATE_OPS.has(node[0]) && node[1] === name) { reassigned = true; return }
        for (let i = 1; i < node.length; i++) reassignScan(node[i])
      }
      for (const root of roots) reassignScan(root)
      if (!reassigned) for (const func of ctx.funcs.list) if (func.body) reassignScan(func.body)
      if (reassigned) result = null
    }
    declCache.set(name, result)
    return result
  }

  // `{}`-literal with every key statically named (staticObjectProps — no
  // shorthand/spread/computed key). Memoized: the SAME table (SECTION) is
  // looked up by every loop that enumerates it.
  const constKeysCache = new Map()
  const constObjKeys = (name) => {
    if (constKeysCache.has(name)) return constKeysCache.get(name)
    const init = findConstInit(name)
    const parsed = Array.isArray(init) && init[0] === '{}' ? staticObjectProps(init.slice(1)) : null
    const result = parsed ? parsed.names : null
    constKeysCache.set(name, result)
    return result
  }

  // Array-of-members dispatch table sibling of resolveComputed (call-target-
  // index.js's own object-literal mechanism never covers this shape — its
  // header is explicit that it resolves `{}`-literal property writes only).
  // Each element is EITHER a same-module named-function reference or an
  // inline arrow — resolveComputed's identical "mixed funcInfo/arrow-node"
  // contract, reused verbatim by resolveRoot below so both table shapes feed
  // the SAME downstream member-forwarding code. A sparse hole (`, ,` / an
  // explicit `undefined`/`null` element) contributes no member at that
  // position — never reached without a runtime TypeError, so it can never
  // itself be a write hazard — and does not block resolution of the OTHER,
  // real positions. Any element that is neither a function reference, an
  // arrow, nor a hole makes the WHOLE table unresolvable (resolveComputed's
  // own all-or-nothing discipline).
  const arrayMembersCache = new Map()
  const constArrayMembers = (name) => {
    if (arrayMembersCache.has(name)) return arrayMembersCache.get(name)
    const init = findConstInit(name)
    const elems = Array.isArray(init) && (init[0] === '[' || init[0] === '[]') ? staticArrayElems(init) : null
    let result = null
    if (elems) {
      result = []
      for (const el of elems) {
        if (el == null || (Array.isArray(el) && el[0] == null && el.length === 0)) continue // sparse hole
        if (typeof el === 'string' && isFuncRef(el, ctx.funcs.names)) result.push(ctx.funcs.map.get(el))
        else if (Array.isArray(el) && el[0] === '=>') result.push(el)
        else { result = null; break }
      }
    }
    arrayMembersCache.set(name, result)
    return result
  }

  // A member of a POSITIONAL array-of-arrows table (constArrayMembers) that is
  // itself reached ONLY through a runtime-computed index needs one uniform WASM
  // call_indirect signature — every member sharing a numeric table slot must
  // agree on param/result types regardless of its own original arity, since the
  // index is only known at runtime (watr's real `build[SECTION.code](item,
  // ctx)`). An earlier plan pass (this codebase's own closure-ABI normalization
  // for exactly this shape) rewrites such a member's own params down to a
  // single rest parameter and inserts a mechanical PROLOGUE recovering each
  // original positional argument — confirmed empirically against the actual
  // rewritten AST, not assumed: `(...REST) => { let name = REST[0], ctx =
  // REST[1], ... ; <original body> }`. A member's params never see this
  // rewrite at all when it's dispatched by a runtime STRING key instead (an
  // object-literal table, resolveComputed's own domain) — WASM has no
  // string-keyed call primitive, so that shape is emitted as a plain runtime
  // comparison chain calling each ORIGINAL-signature function directly, never
  // needing one shared type. Recovers the name ONLY from the exact mechanical
  // shape the rewrite produces — a literal-number-indexed read of the rest
  // param, assigned to a fresh local, at the arrow's own top level (never
  // inside a nested if/loop, so a conditionally-executed read can never be
  // mistaken for the unconditional prologue).
  //
  // THREE outcomes, deliberately distinct (the caller must not conflate the
  // last two): a resolved NAME; `undefined` for a position an ORDINARY
  // (non-rewritten) arrow simply never declared — real JS arrow functions have
  // no `arguments` object of their own, so an extra call argument beyond a
  // plain arrow's own declared arity is PROVABLY unreachable inside it, no
  // different from it not being passed at all — safe to treat as "no alias,
  // no hazard, skip" rather than an unresolved position (confirmed real:
  // watr's own `HANDLER` mixes members of genuinely different arities, e.g. a
  // 1-param member that never touches `ctx` at all); or `null` for anything
  // genuinely ambiguous (a rest-param-normalized arrow whose prologue doesn't
  // account for `pos`, or a non-rest param shape this function doesn't
  // classify) — the position COULD be live there, so the caller must decline
  // rather than guess.
  const arrowParamNameAt = (arrowNode, pos) => {
    const ps = extractParams(arrowNode[1])
    const isRestNormalized = ps.length === 1 && Array.isArray(ps[0]) && ps[0][0] === '...' && typeof ps[0][1] === 'string'
    if (!isRestNormalized && pos >= ps.length) return undefined // ordinary arrow, too few params: provably unreachable
    const p = ps[pos]
    if (typeof p === 'string') return p
    if (p) { const c = classifyParam(p); if (typeof c[PARAM_NAME] === 'string') return c[PARAM_NAME] }
    if (!isRestNormalized) return null
    const rest = ps[0][1]
    let found = null
    const scan = (stmt) => {
      if (found !== null || !Array.isArray(stmt)) return
      if (stmt[0] === ';') { for (let i = 1; i < stmt.length && found === null; i++) scan(stmt[i]); return }
      if (stmt[0] === '{}') { scan(stmt[1]); return }
      if (stmt[0] !== 'let' && stmt[0] !== 'const') return
      for (const d of stmt.slice(1)) {
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' &&
            Array.isArray(d[2]) && d[2][0] === '[]' && d[2][1] === rest &&
            Array.isArray(d[2][2]) && d[2][2][0] == null && d[2][2][1] === pos) { found = d[1]; return }
      }
    }
    scan(arrowNode[2])
    return found
  }

  // ---- fold one write's VALUE into a shared per-key census ----
  const foldKey = (census, key, kind) => {
    const prior = census.get(key)
    if (prior === POISON) return
    if (prior === undefined) census.set(key, kind)
    else if (prior !== kind) census.set(key, POISON)
  }

  // A loop write's value expression must be loop-invariant to contribute a fact: it must
  // not mention the loop's OWN bound name (K) anywhere in its subtree — ruled out
  // structurally, not merely "valTypeOf happens to return non-null" (valTypeOf never
  // resolves a bare identifier's kind through a lexical binding on its own, but this is a
  // belt-and-braces proof, cheap, and removes any doubt that the SAME kind genuinely
  // applies to every one of OBJ's keys, not just the one K happened to be at some site).
  const mentionsName = (node, name) => {
    if (typeof node === 'string') return node === name
    if (!Array.isArray(node)) return false
    for (let i = 1; i < node.length; i++) if (mentionsName(node[i], name)) return true
    return false
  }

  // ---- alias-closure worklist: resolve one candidate root's shared census ----
  // Two poison granularities, deliberately different:
  //   - An ACCOUNTING gap (an occurrence this file cannot classify as a safe read, a
  //     recognized write, or a verified-closed forward — 'poison'; a forward whose callee/
  //     member/keyset itself doesn't resolve; ALIAS_BOUND exceeded) means writes to this
  //     receiver are no longer exhaustively enumerable AT ALL — poisons the WHOLE target,
  //     every key, since any unaccounted write could touch any of them.
  //   - A VALUE gap (a fully-recognized write whose OWN value kind can't be proven, or that
  //     fails the loop-invariance check above) is narrower: the write's KEY(S) are still
  //     exhaustively known, only the KIND is unproven — poisons only those specific key(s),
  //     via the same foldKey meet-on-disagreement path a real kind conflict already uses,
  //     leaving every OTHER already-proven key (a different loop, a different literal write)
  //     untouched.
  const nameToCensus = new Map() // name -> Map<key,kind>|null (frozen result, shared across every alias of one root)
  const resolveRoot = (rootName) => {
    if (nameToCensus.has(rootName)) return
    const census = new Map()
    const visited = new Set()
    const queue = [rootName]
    let poisoned = false
    while (queue.length) {
      const name = queue.shift()
      if (visited.has(name)) continue
      visited.add(name)
      if (visited.size > ALIAS_BOUND) { poisoned = true; break }
      const occs = occurrencesByName.get(name)
      if (!occs) continue
      for (const o of occs) {
        if (o.t === 'decl' || o.t === 'safe' || o.t === 'loopNumericWrite') continue
        if (o.t === 'literalWrite') {
          const kind = valTypeOf(o.valueNode)
          foldKey(census, o.key, kind == null ? POISON : kind)
          continue
        }
        if (o.t === 'loopKeyWrite') {
          const keys = constObjKeys(o.objName)
          if (!keys) { poisoned = true; break } // can't enumerate WHICH keys this loop touches — an accounting gap, not a value gap
          const kind = valTypeOf(o.valueNode)
          const settled = (kind == null || mentionsName(o.valueNode, o.K)) ? POISON : kind
          for (const k of keys) foldKey(census, k, settled)
          continue
        }
        if (o.t === 'fwdNamed') {
          // Same "extra argument beyond declared arity is provably unreachable"
          // reasoning as arrowParamNameAt below — a plain function/arrow body
          // has no way to observe a positional argument it never declared a
          // parameter for (no `arguments` object in this subset's own closure
          // ABI; every consumer of func.sig.params elsewhere in this codebase
          // already treats it as the complete parameter truth) — skip rather
          // than decline the whole target over an argument that simply can't
          // be read OR written inside this specific callee.
          const fn = ctx.funcs.map.get(o.callee)
          if (!fn) { poisoned = true; break } // an unresolvable callee genuinely could do anything
          if (o.pos >= (fn.sig?.params?.length ?? 0)) continue
          const pname = fn.sig.params[o.pos]?.name
          if (typeof pname !== 'string') { poisoned = true; break }
          if (!visited.has(pname)) queue.push(pname)
          continue
        }
        if (o.t === 'fwdComputed') {
          // Two closed-table shapes, tried in turn: an object-literal table
          // (call-target-index.js's own resolveComputed, watr's real HANDLER)
          // or a positional array-of-members table (constArrayMembers above,
          // watr's real build[] — resolveComputed's own header is explicit
          // that object literals are its whole scope, so this table shape
          // needs its own, narrower resolver, not a wider resolveComputed).
          const members = callTargets?.resolveComputed?.(o.objName) ?? constArrayMembers(o.objName)
          if (!members) { poisoned = true; break }
          let bad = false
          for (const m of members) {
            if (!Array.isArray(m)) {
              if (o.pos >= (m.sig?.params?.length ?? 0)) continue // named-function member: same arity-skip as fwdNamed
              const pname = m.sig.params[o.pos]?.name
              if (typeof pname !== 'string') { bad = true; break }
              if (!visited.has(pname)) queue.push(pname)
              continue
            }
            const pname = arrowParamNameAt(m, o.pos)
            if (pname === undefined) continue // provably unreachable inside this specific member — no hazard, no alias
            if (typeof pname !== 'string') { bad = true; break } // null: ambiguous — could be live, can't identify it
            if (!visited.has(pname)) queue.push(pname)
          }
          if (bad) { poisoned = true; break }
          continue
        }
        // 'poison'
        poisoned = true; break
      }
      if (poisoned) break
    }
    const result = poisoned ? null : census
    for (const alias of visited) nameToCensus.set(alias, result) // rootName is always in `visited` — added on its own first dequeue, before any break
  }

  for (const name of candidateRoots) resolveRoot(name)

  const resolveDictKind = (name, key) => {
    const census = nameToCensus.get(name)
    if (!census) return null
    const kind = census.get(key)
    return kind === POISON || kind === undefined ? null : kind
  }

  return Object.freeze({ resolveDictKind })
}
