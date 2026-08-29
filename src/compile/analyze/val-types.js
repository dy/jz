/**
 * Local value-type inference — analyzeValTypes and its dict/map-shaped
 * per-name helpers, plus the nullability predicates it shares with
 * narrow.js. Split out of analyze.js along the "value types" seam
 * (pipeline-minimality slice); see analyze.js's module header for the full
 * split rationale and `.work/archive/analyze-traversals.md` for the traversal
 * inventory.
 *
 * @module compile/analyze/val-types
 */
import { OPTF, DBG_INVARIANTS, ctx } from '../../ctx.js'
import { commaList, ASSIGN_OPS, MUTATE_OPS, isLiteralStr, collectAllBoundNames, walkAst } from '../../ast.js'
import { VAL, repOf, updateRep, KIND_UNIVERSE } from '../../reps.js'
import { valTypeOf, shapeOf, censusMaybeUndefinedKind } from '../../kind.js'
import { intExprRange, objLiteralSchemaId } from '../../static.js'
import { isCondExpr, intCertainMap } from '../../type.js'
import { makeValTracker, makeTypedTracker } from './trackers.js'
import { analyzeBody } from './body-facts.js'

// Can this RHS expression produce null/undefined? FAIL-CLOSED: anything not
// STRUCTURALLY provable non-nullish counts nullable. The flag's only effect
// is suppressing emit.js's strictSentinel constant fold (the comparison pays
// a cheap runtime nullish check instead) plus capture propagation — while a
// wrong non-nullable verdict FOLDS AWAY a real miss guard. The old shape
// list (nullish literals + ternary arms only) was sound while opaque sources
// carried no value kind (no kind ⇒ no fold); the Map/element value-kind
// inference broke that assumption: the self-compile kernel's own
// `autoCache.get(name) !== undefined` cache probe folded to TRUE (the get's
// rep carried the map's value kind, non-nullable) and every autoDepsOf call
// returned the miss sentinel unconditionally — the byte-parity root.
const NEVER_NULLISH_OPS = new Set([
  'str', 'bigint', '//', '{}', '[', '=>', 'new', 'bool',
  '+', '-', '*', '/', '%', '**', '|', '&', '^', '~', '<<', '>>', '>>>',
  '==', '!=', '===', '!==', '<', '>', '<=', '>=', '!', 'u-', 'u+',
  'typeof', 'in', 'instanceof', '++', '--',
])
// `nameNullable` resolves a bare-name read; the default reads the CURRENT
// function's rep (emit-time callers). narrow.js passes its own resolver — at
// plan time no caller's ctx.func is installed, so it re-derives nullability
// from the caller body's writes instead. Exported for exactly that consumer.
export function mayBeNullish(n, nameNullable = (name) => !!repOf(name)?.nullable) {
  if (typeof n === 'number' || typeof n === 'boolean') return false
  // name read: inherit the source binding's settled flag (best-effort — an
  // unsettled rep reads false, matching the old behavior for plain aliases)
  if (typeof n === 'string') return nameNullable(n)
  if (!Array.isArray(n)) return true
  const op = n[0]
  if (op == null) return n[1] == null                    // [null, v] literal value
  if (op === '?' || op === '?:') return mayBeNullish(n[2], nameNullable) || mayBeNullish(n[3], nameNullable)
  // `a && b` yields a (when falsy — possibly nullish) or b; `a || b` / `a ?? b`
  // yield a only when truthy/non-nullish, so only b's nullability matters.
  if (op === '&&') return mayBeNullish(n[1], nameNullable) || mayBeNullish(n[2], nameNullable)
  if (op === '||' || op === '??') return mayBeNullish(n[2], nameNullable)
  if (op === '=') return mayBeNullish(n[2], nameNullable) // assignment expression yields its rhs
  if (op === ',') return mayBeNullish(n[n.length - 1], nameNullable)
  if (typeof op === 'string' && (NEVER_NULLISH_OPS.has(op) || op.startsWith('new.'))) return false
  // calls (incl. `.get()` misses), member/element reads, optional chains,
  // and anything unrecognized: missable — fail closed.
  return true
}

// Decl-time producer for the `mayBeUndefined` REP field
// (.work/archive/todo.md §deletion-sweep §2/§3 Slice 1) — the
// container-read sibling of `mayBeNullish` above, deliberately NOT folded
// into it: `mayBeNullish` answers "could this expression itself be a nullish
// LITERAL/merge", or with a Map/dict a `.get()`/`[]` call already fails
// closed (returns true) whether or not the census can name an exact
// non-nullish kind for it — `mayBeUndefined` answers the NARROWER question
// this design needs, "does the census's SPECIFIC exact-kind claim for this
// RHS need the mayBeUndefined carve-out", which only a direct
// censusMaybeUndefinedKind-recognized node or an already-flagged bare-name
// copy can answer. Two arms, no recursion through ternary/&&/||/`,` (unlike
// mayBeNullish's full walk) — deliberately narrow, matching Slice 1's scope
// per the design's own "smaller surface" instruction; a composed RHS
// (`cond ? m.get(k) : 0`) is out of scope until a later slice extends this.
const mayBeUndefinedRhs = (rhs) =>
  censusMaybeUndefinedKind(rhs) != null || (typeof rhs === 'string' && !!repOf(rhs)?.mayBeUndefined)

/** True iff `name` appears in `body` ONLY as the receiver of an indexed read
 *  `name[k]` (the lean-dict idiom) — a bare reference, a `.`-target, or any
 *  other position disqualifies. ITERATIVE (explicit worklist) by necessity:
 *  the original nested self-recursive closure (`verify` capturing `name` +
 *  `body`) MISCOMPILED under the self-compiled kernel into non-termination —
 *  the `h[dk]=v` dict idiom sent the dist kernel leg red (bisected to
 *  83d6add5's analyze.js additions; a depth cap and a `seen` identity-guard
 *  both failed, so the divergence is in the kernel's closure-call ABI, below
 *  JS control flow — a worklist sidesteps the fragile construct entirely).
 *  The kernel two-level-capture-recursion miscompile is ledgered for its own
 *  dissection. Module-scope so no capture, no recursion. */
function dictWalkLean(body, name) {
  const stack = [body]
  let plainRead = false
  while (stack.length) {
    const n = stack.pop()
    if (typeof n === 'string') { if (n === name) return false; continue }
    if (!Array.isArray(n)) continue
    const op = n[0]
    if (op === '=>' || op === 'str') continue
    // WRITE/RMW target `name[k] (op)= v`: the ephemeral-slot upsert serves it.
    // Inside the RHS, the RMW's OWN read (structurally equal to the target —
    // emit-assign's _rmwStructEq fuses exactly that) is part of the same slot
    // op; any OTHER same-name `[]` in the RHS is a plain read → reject below.
    if (ASSIGN_OPS.has(op) && Array.isArray(n[1]) && n[1][0] === '[]' && n[1][1] === name) {
      const tgt = JSON.stringify(n[1])
      if (n[1][2] != null) stack.push(n[1][2])
      const pushSkippingFused = (m) => {
        if (!Array.isArray(m)) { stack.push(m); return }
        if (m[0] === '[]' && m[1] === name && JSON.stringify(m) === tgt) { if (m[2] != null) stack.push(m[2]); return }
        if (m[0] === '[]' && m[1] === name) { stack.push(m); return }   // plain read — rejected by the arm below
        for (let i = 1; i < m.length; i++) pushSkippingFused(m[i])
      }
      for (let i = 2; i < n.length; i++) pushSkippingFused(n[i])
      continue
    }
    // PLAIN READ of the dict: the lean/ephemeral write layout is only sound to
    // read back when the read tolerates a fresh/zero slot — i.e. when EVERY
    // read is immediately bitwise-coerced (the i32-dict rule: missing → 0 is
    // the documented ToInt32 semantics). An uncoerced read (`d[k] === undefined`,
    // `d[k] <= 5`) against eph-written memory got garbage in-bounds or walked
    // OOB (the loop-built-dict trap class). Flag it; the final verdict defers
    // to dictWalkI32, which validates the every-read-coerced property.
    if (op === '[]' && n[1] === name) { plainRead = true; if (n[2] != null) stack.push(n[2]); continue }
    if ((op === ':' || op === '.' || op === '?.') && n.length >= 3) { stack.push(n[op === ':' ? 2 : 1]); continue }
    // let/const: the decl values; every other op: all children.
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (op === 'let' || op === 'const') {
        if (Array.isArray(c) && c[0] === '=') { if (c[2] != null) stack.push(c[2]) }
        else stack.push(c)
      } else stack.push(c)
    }
  }
  return !plainRead || dictWalkI32(body, name)
}

const I32_DICT_BITWISE = new Set(['&', '|', '^', '<<', '>>', '>>>'])
/** Count/histogram dict test: `name` used only as `name[k]`, every READ
 *  immediately bitwise-coerced and every WRITE a discarded statement (so the
 *  slot may keep only ToInt32 bits). ITERATIVE for the same reason as
 *  dictWalkLean — the original nested self-recursive `walk` (four captured
 *  params + mutated outer state) is the exact shape the self-compiled kernel
 *  miscompiled into non-termination (bisected culprit of the 83d6add5
 *  kernel-leg red). Module-scope, worklist of (node,parent,pos,grand). */
function dictWalkI32(body, name) {
  let reads = 0, writes = 0
  const stack = [[body, null, -1, null]]
  while (stack.length) {
    const [n, parent, pos, grand] = stack.pop()
    if (!Array.isArray(n) || n[0] === '=>') continue
    if (n[0] === '[]' && n[1] === name) {
      if (parent && ASSIGN_OPS.has(parent[0]) && pos === 1) {
        writes++
        // Only an expression statement discards the value; in a
        // condition/update replacing the boxed result with ToInt32 is observable.
        if (!(grand && (grand[0] === ';' || grand[0] === '{}'))) return false
      } else {
        reads++
        if (!(parent && I32_DICT_BITWISE.has(parent[0]))) return false
      }
      if (n[2] != null) stack.push([n[2], n, 2, parent])
      continue
    }
    for (let i = 1; i < n.length; i++) stack.push([n[i], n, i, parent])
  }
  return reads > 0 && writes > 0
}

/** Preallocation-hint domain for a computed-key dict `name`: the single array
 *  `dom` such that every `name[k] = …` uses a key `k = dom[i]` (a missed/wrong
 *  alias only costs a resize, never semantics). ITERATIVE for the same reason
 *  as dictWalkLean/dictWalkI32 — the original TWO nested self-recursive
 *  closures (`collect`, `scan`, both capturing outer state) are the kernel-
 *  fragile shape (83d6add5 leg red). Module-scope, two worklist passes. */
function dictDomainOf(body, name) {
  // Pass 1: single-def `let/const x = value` map (clashing names dropped).
  const defs = new Map(), clashes = new Set()
  let stack = [body]
  while (stack.length) {
    const n = stack.pop()
    if (!Array.isArray(n) || n[0] === '=>') continue
    if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
      const d = n[i]
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
        if (defs.has(d[1])) clashes.add(d[1]); else defs.set(d[1], d[2])
      }
    }
    for (let i = 1; i < n.length; i++) stack.push(n[i])
  }
  for (const n of clashes) defs.delete(n)
  const sourceOf = (idx) => {
    const e = typeof idx === 'string' ? defs.get(idx) : idx
    return Array.isArray(e) && e[0] === '[]' && typeof e[1] === 'string' ? e[1] : null
  }
  // Pass 2: every `name[k] = …` must draw k from one shared domain array.
  let domain = null, bad = false, writes = 0
  stack = [body]
  while (stack.length) {
    const n = stack.pop()
    if (!Array.isArray(n) || n[0] === '=>') continue
    if (ASSIGN_OPS.has(n[0]) && Array.isArray(n[1]) && n[1][0] === '[]' && n[1][1] === name) {
      writes++
      const dom = sourceOf(n[1][2])
      if (!dom || (domain && domain !== dom)) bad = true
      else domain = dom
    }
    for (let i = 1; i < n.length; i++) stack.push(n[i])
  }
  return writes && !bad ? domain : null
}

/**
 * Analyze all local value types from declarations and assignments.
 * Writes the per-name `val` field of `ctx.func.localReps` for method dispatch
 * and schema resolution.
 */
// Strict write-kind resolver for the dict-value-type census (local half,
// design .work/archive/todo.md §deletion-sweep §1a) — a local mirror of
// program-facts.js's writeVT/effectiveWriteValue. Not imported: program-facts.js
// already imports analyzeBody from this module, so importing back would cycle.
// Kept in exact lockstep with the program-facts.js pair — any resolver change
// there belongs here too.
function dictWriteVT(n) {
  if (Array.isArray(n)) {
    const op = n[0]
    if (op === '.' || op === '?.') return null
    if (op === '+' || op === '+=') {
      const ta = dictWriteVT(n[1]), tb = dictWriteVT(n[2])
      if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
      if (ta == null || tb == null) return null
      if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
      return VAL.NUMBER
    }
    if (op === '?:') { const a = dictWriteVT(n[2]), b = dictWriteVT(n[3]); return a === b ? a : null }
    if (op === '&&' || op === '||' || op === '??') { const a = dictWriteVT(n[1]), b = dictWriteVT(n[2]); return a === b ? a : null }
  }
  return valTypeOf(n)
}
function dictEffectiveWriteValue(op, lhs, rhs) {
  if (op === '=') return rhs
  if (op === '++' || op === '--') return [op === '++' ? '+' : '-', lhs, [null, 1]]
  if (op === '&&=' || op === '||=' || op === '??=') return ['?:', lhs, lhs, rhs]
  return [op.slice(0, -1), lhs, rhs]
}
// Same-body scan for every `name[key] = rhs` (any MUTATE_OP, any key —
// dict-mode receivers have no literal-key fast path) rooted at `name` through
// nested `[]` chains. First-wins-then-clash, poisons to null on any
// unresolved write — identical lattice to observeProgramSlots' global-half
// dictValueTypes census.
//
// Observes THROUGH nested `=>` bodies: a write captured in a
// callback — `[0].forEach(() => m.set('y', 'oops'))` — is a write to the SAME
// lexical `name` binding as any top-level write, so leaving it unobserved
// (the old blanket `if (op === '=>') return`) let a stale census kind survive
// past a mutation that actually happened, miscompiling `m.get('y') + 1` to a
// bare NUMBER add. Sound direction: MORE observations only ever tightens or
// poisons the join, never loosens it. The one exception is a SHADOW — an
// arrow whose own param or nested let/const/var re-declares `name` binds a
// DIFFERENT variable for its whole body, so `collectAllBoundNames` (ast.js;
// position-insensitive, scans the whole arrow subtree including further
// nesting) gates entry per arrow: shadowed → skip the subtree entirely (same
// "over-bail is sound, never unsound" precedent as scanBindingUses' CAPTURE
// rule, this file's doc comment ~line 65). dictWalkLean/dictWalkI32 keep their
// own `=>`-stopping cut — this census only feeds the maybeUndefined-joined
// consumer path (kind.js dictValueKindOf), not those leaner direct-index ones.
//
// PRODUCT-LATTICE Slice 7: union-join instead of first-wins-then-clash
// poison-to-null (.work/archive/lattice-design.md §thesis — this is an EXISTENTIAL
// fact, "which kinds has this dict been written with," and existential facts
// compose by union, not meet). Returns the raw Set (possibly empty = BOTTOM/
// unobserved): a disagreeing write ADDS to the set instead of nulling it; an
// unresolved write union-joins the full KIND_UNIVERSE (TOP) instead of a
// null sentinel — dictValueKindOf's exact-or-null projection (size===1 → the
// kind, else null) reproduces today's observable answer byte-for-byte from
// this Set, while censusKindsOf (opt-in) can now see the real union.
function dictValueTypeOf(body, name) {
  const kinds = new Set()
  walkAst(body, { enter: node => {
    if (kinds.size === KIND_UNIVERSE.length) return false
    const op = node[0]
    if (op === '=>' && collectAllBoundNames(node, new Set()).has(name)) return false
    if (MUTATE_OPS.has(op) && Array.isArray(node[1]) && node[1][0] === '[]') {
      const [, wobj, widx] = node[1]
      if (!isLiteralStr(widx)) {
        let root = wobj
        while (Array.isArray(root) && root[0] === '[]') root = root[1]
        if (root === name) {
          const wvt = dictWriteVT(dictEffectiveWriteValue(op, node[1], node[2]))
          if (!wvt) { for (const k of KIND_UNIVERSE) kinds.add(k); return false }
          kinds.add(wvt)
        }
      }
    }
  } })
  return kinds
}

// Map-value-type census, local half (design .work/archive/todo.md §deletion-sweep
// §1) — mirrors dictValueTypeOf above but matches `recv.set(k, v)` CALL nodes
// instead of `[]=` writes (Map has no bracket-write form). No self-read/
// paramVts handling here, same as dictValueTypeOf's own local half (those are
// the late whole-program {fresh:true} pass's concerns, program-facts.js).
// Caller gates on decl vt === VAL.MAP (receiver already proven), so `name`
// need not be re-checked here. Observes THROUGH nested `=>` bodies with the
// SAME shadow-bail as dictValueTypeOf above — see that
// function's doc comment for the soundness argument. Same product-lattice
// Slice 7 union-join swap as dictValueTypeOf above — see its doc comment.
function mapValueTypeOf(body, name) {
  const kinds = new Set()
  walkAst(body, { enter: node => {
    if (kinds.size === KIND_UNIVERSE.length) return false
    const op = node[0]
    if (op === '=>' && collectAllBoundNames(node, new Set()).has(name)) return false
    if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' &&
        node[1][1] === name && node[1][2] === 'set') {
      const cargs = commaList(node[2])
      if (cargs.length === 2) {
        const wvt = dictWriteVT(cargs[1])
        if (!wvt) { for (const k of KIND_UNIVERSE) kinds.add(k); return false }
        kinds.add(wvt)
      }
    }
  } })
  return kinds
}

export function analyzeValTypes(body) {
  // localReps slice: store reads/writes the rep's `val` field (updateRep clears it
  // when set to undefined, matching the old explicit delete).
  const setVal = makeValTracker(
    (n) => ctx.func.localReps?.get(n)?.val,
    (n, vt) => updateRep(n, { val: vt }),
    (n) => updateRep(n, { val: undefined }),
  )
  const getVal = name => ctx.func.localReps?.get(name)?.val
  // presentVal slice: decl-time producer (.work/archive/todo.md §deletion-sweep
  // §14 Slice 6, reps.js `presentVal` doc comment). Own
  // makeValTracker instance — a SEPARATE poison set from `setVal`'s (this
  // function is called fresh per analyzeValTypes invocation, exactly like
  // setVal above, so poison state never leaks across functions/compiles).
  // Fed `censusMaybeUndefinedKind(rhs)` directly at both write sites below:
  // that one predicate already composes direct census-shaped RHS, one-hop
  // bare-name copy-through (reading this SAME field on an earlier-processed
  // name in the same forward walk), and call-results — no separate helper
  // needed (kind.js's own "one predicate function" discipline, §4).
  const setPresentVal = makeValTracker(
    (n) => ctx.func.localReps?.get(n)?.presentVal,
    (n, vt) => updateRep(n, { presentVal: vt }),
    (n) => updateRep(n, { presentVal: undefined }),
  )
  // Names declared in THIS body. A reassignment to any other name (parameter /
  // captured outer binding) merges with an entry value of unknown kind, so a
  // POINTER-kind RHS must POISON the val slice, not settle it — else a branch
  // like `if (Array.isArray(x)) …; else x = ['str', v]` on a param stamps x
  // ARRAY flow-insensitively and const-folds the very guard proving it isn't
  // (the kernel JSON.parse-emitter head-coercion: array reads on a string →
  // OOB). Scalar kinds (NUMBER/BOOL/BIGINT) and coupled-tracker kinds (TYPED/BUFFER, whose trackTyped slice owns coherence) keep the settled-kind behavior —
  // see analyzeBody's poisonUndeclared for why.
  const declared = new Set()
  const poisonUndeclared = (name, vt) =>
    !declared.has(name) && vt != null && vt !== VAL.NUMBER && vt !== VAL.BOOL && vt !== VAL.BIGINT && vt !== VAL.TYPED && vt !== VAL.BUFFER ? null : vt
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
  // Array-of-typed-arrays element ctor → rep, so `arr[i]` resolves as a typed array
  // and `arr[i][j]` / `let o = arr[i]; o[j]` inline (codec channelData scatter).
  for (const [name, ctor] of facts.arrElemTypedCtors) {
    if (ctor != null) updateRep(name, { arrayElemTypedCtor: ctor })
  }
  // Construct-then-fill numeric arrays (`let a = Array(n); a[i] = expr`) carry no
  // element evidence at their decl, so the walk above leaves them untyped. scanNumericFill
  // proved every write Numeric and every other use a pure read — record NUMBER so `arr[i]`
  // reads skip __to_num, unless an observation already poisoned the slot to a conflict.
  for (const name of facts.numericFill || []) {
    if (facts.arrElemValTypes.get(name) !== null) updateRep(name, { arrayElemValType: VAL.NUMBER })
  }
  // Propagate body-observed array-elem schemas to localReps so unboxablePtrs's
  // `let p = arr[i]` rule (which only consults rep) sees the schema and can unbox `p`
  // to an i32 offset. Without this, `arr.push({x,y,z})` followed by `arr[i].x` reads
  // pay an i64.reinterpret/i32.wrap on every slot access (no aliasing → CSE can't fold).
  for (const [name, sid] of arrElems) {
    if (sid != null) updateRep(name, { arrayElemSchema: sid })
  }
  // Closed heterogeneous unions (≥2 sids, no unknown source) ride to reps the
  // same way — size-1 sets are exactly the singular fact and stay off the rep.
  for (const [name, set] of facts.arrElemSchemaSets || []) {
    if (set != null && set.size >= 2) updateRep(name, { arrayElemSchemaSet: [...set].sort((a, b) => a - b) })
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
  // Set sibling of arrElemSchemaOf — rep channel first (param-carried unions).
  const arrElemSchemaSetOf = (name) => {
    if (typeof name !== 'string') return null
    const repSet = ctx.func.localReps?.get(name)?.arrayElemSchemaSet
    if (repSet != null) return repSet
    const s = facts.arrElemSchemaSets?.get(name)
    return s != null && s.size >= 2 ? [...s].sort((a, b) => a - b) : null
  }
  function trackRegex(name, rhs) {
    if (ctx.runtime.regex && Array.isArray(rhs) && rhs[0] === '//') ctx.runtime.regex.vars.set(name, rhs)
  }
  // ctx.func.typedElem slice (lazily created on first write, as before — readers
  // tolerate null). Disagreeing decls poison the name (jz hoists `let` to function
  // scope, so sibling-scope decls share a name and must not lock in a wrong width).
  const trackTyped = makeTypedTracker(
    (n) => ctx.func.typedElem?.get(n),
    (n, c) => (ctx.func.typedElem ??= new Map()).set(n, c),
    (n) => ctx.func.typedElem?.delete(n),
    (n) => ctx.func.typedLen?.get(n),
    (n, l) => (ctx.func.typedLen ??= new Map()).set(n, l),
    (n) => ctx.func.typedLen?.delete(n),
  )
  // Total write count for `name` across the whole body, recursing into nested
  // closures so a closure that reassigns the var is also counted. Capped at 2 —
  // callers only need the "exactly one write" verdict.
  function writeCount(node, name, n) {
    if (n > 1 || !Array.isArray(node)) return n
    const o = node[0]
    if (MUTATE_OPS.has(o) && node[1] === name) n++
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
  // Non-escaping computed-key dictionary: every use of `name` is exactly the
  // receiver of `name[key]` (read or write), apart from its declaration. Such
  // a fresh HASH never deletes/enumerates/escapes, so its upsert may use the
  // lean no-tombstone/no-order/no-durable-log probe.
  const leanDictUse = (name) => dictWalkLean(body, name)
  // Count/histogram dictionaries: if every read is immediately bitwise-
  // coerced and every write is a statement, the slot may retain only the
  // observable ToInt32 bits. Missing `undefined|0` and a zero slot are equal.
  const i32DictUse = (name) => dictWalkI32(body, name)
  // Upper bound on distinct keys: `const k = domain[index]; dict[k] = …`
  // cannot insert more unique keys than domain.length. Capacity planning uses
  // this only as a preallocation hint (the table still grows), so a missed
  // alias costs speed while an over/underestimate cannot affect semantics.
  const dictDomain = (name) => dictDomainOf(body, name)
  function walk(node, cond) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return  // don't leak inner-closure val types
    // Collect Object.assign(name, …) sites for the post-walk boxed-schema
    // predictor (slice-4 P3) — decided AFTER the walk so the target's FINAL
    // val kind matches what emit reads.
    if (op === '()' && args[0] === 'Object.assign') {
      let aa = args.slice(1)
      if (aa.length === 1 && Array.isArray(aa[0]) && aa[0][0] === ',') aa = aa[0].slice(1)
      if (typeof aa[0] === 'string' && aa.length > 1)
        objAssignSites.push({ target: aa[0], sources: aa.slice(1) })
    }
    if (op === 'let' || op === 'const') {
      for (const a of args) {
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') continue
        declared.add(a[1])
        // Empty object used exclusively as a computed-key sink is represented
        // as HASH by object.js. Stamp the same kind during analysis (before
        // emission), so every subsequent read/write takes the strict one-table
        // path and hash-RMW fusion needs no speculative runtime-type fallback.
        const merged = ctx.schema.resolve?.(a[1])
        const emptyLit = Array.isArray(a[2]) && a[2][0] === '{}' && a[2].length === 1
        const dict = emptyLit && ctx.types.dynWriteVars?.has(a[1]) && !merged?.length
        // INVARIANT: a truly EMPTY `{}` still binds a real (0-prop) schema
        // decl — prepare/index.js's own decl-schema tracking (the props.length
        // guard right next to the non-empty-literal case this mirrors) only
        // ever bound a NON-empty literal's schema; module/core.js's
        // isClosedObjNoStringMethod (`new Error(o).message` for a bound
        // object) needs a resolvable schema to prove a truly-empty `o`
        // closed, same as it already can for `{x:1}`. Bound HERE, not in
        // prepare, and ONLY for the non-dict arm: `dict` (computed above,
        // WHOLE-PROGRAM `ctx.types.dynWriteVars` context prepare's earlier,
        // single-pass walk never has) is the one fact that must gate whether
        // this schema is minted AT ALL — not just whether it's bound to this
        // name. Minting an unused schema for a dict-mode binding (one that
        // NEVER reads it — HASH mode bypasses schema dispatch entirely, and
        // errorMessageIR's own separate VAL.HASH arm covers ITS Error-message
        // case) still changes `ctx.schema.list`'s size, which is enough to
        // flip a shared codegen branch in module/collection.js's
        // $__dyn_get_t_h — reopening the exact PRE-EXISTING, host-dependent
        // watr-fold divergence test/kernel-parity.js's "dict|2 + dict|3" note
        // already documents (confirmed live: binding unconditionally, even
        // via prepare, reproduced it; skipping the dict arm here does not).
        // `merged == null` (not just "no schema yet"): if prepare's own
        // assignment-schema tracking already bound (or poisoned) this name
        // from a LATER reassignment (`o = {x:1}`), that fact was decided with
        // MORE information than a bare `{}` decl carries — never overwrite it.
        if (!dict && emptyLit && merged == null && ctx.schema.register && !ctx.schema.poisoned?.has(a[1]))
          ctx.schema.vars.set(a[1], ctx.schema.register([]))
        const vt = dict ? VAL.HASH : valTypeOf(a[2])
        // Dict-value-type census, local half (design §1a): every value ever
        // written through `a[1][key] = rhs` in this body, additive alongside
        // the HASH receiver stamp above — never a substitute for `val`.
        if (dict) {
          const dvt = dictValueTypeOf(body, a[1])
          if (dvt.size) updateRep(a[1], { dictValueValType: dvt })
        }
        // Map-value-type census, local half (design .work/archive/todo.md
        // §deletion-sweep §1) — sibling of the dict census above, gated on decl
        // vt === VAL.MAP instead of the HASH-literal `dict` shape check
        // (new Map() is a hard classification, valTypeOf(a[2]) already
        // resolves it via CALLEE_VAL — no structural re-derivation needed).
        if (vt === VAL.MAP) {
          const mvt = mapValueTypeOf(body, a[1])
          if (mvt.size) updateRep(a[1], { mapValueValType: mvt })
        }
        const leanDict = dict && (ctx.transform.optFlags & OPTF.hashRmwFusion) && leanDictUse(a[1])
        if (leanDict) {
          (ctx.func.leanHashLocals ??= new Set()).add(a[1])
          if (i32DictUse(a[1])) (ctx.func.i32HashLocals ??= new Set()).add(a[1])
          const domain = dictDomain(a[1])
          if (domain) (ctx.func.leanHashDomains ??= new Map()).set(a[1], domain)
        }
        setVal(a[1], vt)
        const declMayBeNullish = mayBeNullish(a[2])
        if (declMayBeNullish) updateRep(a[1], { nullable: true })
        // presence (re-audit item 9(b)): 'maybe-undef' mirrors mayBeUndefined's
        // own boolean exactly (same condition, same site). 'present' is a
        // SEPARATE, narrower positive proof — non-nullish init (declMayBeNullish
        // already computed above for `nullable`) AND never reassigned anywhere
        // in the body (writeCount, the SAME never-reassigned check the range
        // stamp below reuses) — mutually exclusive with 'maybe-undef' by
        // construction (if/else if): a census-shaped RHS is already
        // mayBeNullish-true (mayBeNullish fails closed on any call/bracket
        // read), so the two arms never both fire for the same write.
        if (mayBeUndefinedRhs(a[2])) updateRep(a[1], { mayBeUndefined: true, presence: 'maybe-undef' })
        else if (!declMayBeNullish && writeCount(body, a[1], 0) === 0) updateRep(a[1], { presence: 'present' })
        setPresentVal(a[1], censusMaybeUndefinedKind(a[2]))
        // Closed integer hull for never-reassigned decls whose init the range
        // evaluator can bound (masks, ternary hulls, bounded products) — chains
        // through earlier ranged decls via intExprRange's repOf hook. Feeds the
        // i32-provability of products and div-by-2^k strength reduction (the
        // delayline q16 chain: raw = lfo & 0x1ffff → tri → dq stays i32).
        //
        // This is the SAME predicate analyzeBody's own processDecl stamps
        // EARLY, during its (possibly cache-skipped) body walk. DBG_INVARIANTS asserts the redundancy claim that justifies
        // leaving that early stamp as-is rather than threading ranges through
        // an explicit BodyFacts slice: whenever processDecl already stamped a
        // range for this name (cache miss ran it, ctx.func.localReps wasn't
        // reset since), THIS unconditional re-derivation must land the exact
        // same bound — same rhs, same walk order, same repOf-chained bounds
        // for earlier decls (ctx.func.localReps is never touched between the
        // two stamps within one function's own compile turn). See session.js's
        // DEPS table / analyzeBody's cache doc for why a genuine STALE hit
        // (skipping the early stamp) is harmless: this line still fires
        // unconditionally and fills the gap.
        const declRange = intExprRange(a[2])
        if (declRange && Number.isFinite(declRange[0]) && Number.isFinite(declRange[1]) && writeCount(body, a[1], 0) === 0) {
          if (DBG_INVARIANTS) {
            const prior = repOf(a[1])?.range
            if (prior && (prior[0] !== declRange[0] || prior[1] !== declRange[1]))
              throw new Error(`analyzeValTypes: declRange restamp for '${a[1]}' diverges from analyzeBody's early stamp — prior=[${prior}] new=[${declRange}] (idempotence probe)`)
          }
          updateRep(a[1], { range: declRange })
        }
        if (vt === VAL.REGEX) trackRegex(a[1], a[2])
        // VAL gate covers definite-typed RHS; `?:`/`&&`/`||` slip through valTypeOf
        // returning null but may still need ctor unification (or poisoning when
        // branches disagree, since jz hoists `let` to function scope).
        if (vt === VAL.TYPED || vt === VAL.BUFFER || isCondExpr(a[2])) trackTyped(a[1], a[2])
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
          const f = ctx.funcs.map?.get(a[2][1])
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
          } else {
            // Closed heterogeneous union: `const o = rows[i]` over a
            // set-carrying array — o is provably ONE of the union's schemas.
            // Discriminant refinement (flow-types) narrows per-branch; the
            // union-agreeing slot path (schema.slotOf) serves unbranched reads
            // like the tag itself.
            // Decl-only binding (no reassignment anywhere, incl. closures) — a
            // second write could carry a foreign schema the set doesn't cover.
            const elemSet = arrElemSchemaSetOf(a[2][1])
            if (elemSet != null && writeCount(body, a[1], 0) === 0) {
              updateRep(a[1], { schemaIdSet: elemSet })
              setVal(a[1], VAL.OBJECT)
            }
          }
        }
      }
    }
    if (op === '=' && typeof args[0] === 'string') {
      walk(args[1], cond)
      const merged = ctx.schema.resolve?.(args[0])
      const dict = Array.isArray(args[1]) && args[1][0] === '{}' && args[1].length === 1 &&
        ctx.types.dynWriteVars?.has(args[0]) && !merged?.length
      const vt = dict ? VAL.HASH : valTypeOf(args[1])
      // Dict-value-type census, local half (design §1a) — reassignment site
      // sibling of the decl-site stamp above.
      if (dict) {
        const dvt = dictValueTypeOf(body, args[0])
        if (dvt.size) updateRep(args[0], { dictValueValType: dvt })
      }
      // Map-value-type census, local half — reassignment site sibling of the
      // decl-site stamp above.
      if (vt === VAL.MAP) {
        const mvt = mapValueTypeOf(body, args[0])
        if (mvt.size) updateRep(args[0], { mapValueValType: mvt })
      }
      if (dict && (ctx.transform.optFlags & OPTF.hashRmwFusion) && leanDictUse(args[0])) {
        (ctx.func.leanHashLocals ??= new Set()).add(args[0])
        if (i32DictUse(args[0])) (ctx.func.i32HashLocals ??= new Set()).add(args[0])
        const domain = dictDomain(args[0])
        if (domain) (ctx.func.leanHashDomains ??= new Map()).set(args[0], domain)
      }
      // A CONDITIONALLY-positioned BIGINT write to a PARAM poisons, never
      // settles: the entry kind is call-site truth this body walk can't see,
      // and this tracker writes DURABLE localReps, so `if (r) v = 4n` would
      // otherwise stamp v BIGINT for Number entries with no competing
      // observation to poison it (params have no decl node), folding
      // `typeof v` wrong. An UNCONDITIONAL write (`n = BigInt(n)` at body
      // top level — watr's normalization idiom) dominates every later use
      // and still adopts. Scoped to VAL.BIGINT: the hazard is the bit-level
      // carrier (raw i64 misread as a subnormal Number and vice versa) — the
      // plan's tagged materialization handles the runtime, this only stops
      // the false STATIC claim. Non-BigInt conditional adopts stay: numeric
      // loop-write adoption is load-bearing for the typing pipeline
      // (unswitch-typed-param's i32 guard locals validate against it).
      const bigintParamWrite = vt === VAL.BIGINT && (ctx.func.current?.params?.some(p => p.name === args[0]) ||
        ctx.func.current?.sig?.params?.some(p => p.name === args[0]))
      setVal(args[0], bigintParamWrite && cond ? null : poisonUndeclared(args[0], vt))
      if (mayBeNullish(args[1])) updateRep(args[0], { nullable: true })
      // presence (re-audit item 9(b)): 'maybe-undef' mirrors mayBeUndefined's
      // boolean here too. No 'present' arm at a REASSIGN site — this write
      // itself makes writeCount(body, args[0], 0) ≥ 1 for the whole body, so
      // the decl site's never-reassigned precondition for 'present' is
      // already false whenever this site can even fire (decl-site 'present'
      // never gets set for a name that reaches a reassignment anywhere).
      if (mayBeUndefinedRhs(args[1])) updateRep(args[0], { mayBeUndefined: true, presence: 'maybe-undef' })
      setPresentVal(args[0], censusMaybeUndefinedKind(args[1]))
      if (vt === VAL.REGEX) trackRegex(args[0], args[1])
      if (vt === VAL.TYPED || vt === VAL.BUFFER || isCondExpr(args[1])) trackTyped(args[0], args[1])
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
    // Conditional-position threading (the param-write rule above): arms whose
    // execution depends on a runtime test descend with cond=true — 'if'/'?:'
    // arms (their tests stay at the current position), '&&'/'||'/'??' right
    // sides, and every part of a loop (a body that may run zero times).
    // Everything else inherits the caller's position.
    if (op === 'if' || op === '?:') { walk(args[0], cond); for (let i = 1; i < args.length; i++) walk(args[i], true); return }
    if (op === '&&' || op === '||' || op === '??') { walk(args[0], cond); walk(args[1], true); return }
    // Loops and try: every part may run zero times (loop body / catch arm) or
    // stop mid-way (a throw skips the try body's tail) — all conditional.
    if (op === 'while' || op === 'do' || op === 'for' || op === 'for-in' || op === 'for-of' || op === 'try') { for (const a of args) walk(a, true); return }
    for (const a of args) walk(a, cond)
  }
  const objAssignSites = []
  walk(body, false)

  // Slice-4 P3 predictor: `Object.assign(x, …)` onto a non-OBJECT binding
  // (boxed primitive / array carrier) allocates an `__inner__` record at emit;
  // the schema BINDING is plan state — register + bind here, mirroring
  // module/object.js's emit site (which now asserts instead of writing).
  // Post-walk so the target's FINAL val kind matches what emit reads; the
  // shared ctx.schema.resolveExpr keeps source resolution identical to emit's.
  for (const { target, sources } of objAssignSites) {
    const vt = repOf(target)?.val
    if (!vt || vt === VAL.OBJECT || !ctx.schema.resolveExpr) continue
    const allProps = []
    let known = true
    for (const src of sources) {
      const s = ctx.schema.resolveExpr(src)
      if (!s) { known = false; break }
      for (const p of s) if (!allProps.includes(p)) allProps.push(p)
    }
    if (!known) continue   // emit errs on unknown-source schemas — nothing to bind
    const sid = ctx.schema.register(['__inner__', ...allProps])
    // Extern-write belt: source slot values copied in at emit, unseen by censuses.
    ctx.schema.externSlotSids?.add(sid)
    ctx.schema.vars.set(target, sid)
    updateRep(target, { schemaId: sid })
  }

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

/** Forward-propagate `intCertain` on local bindings. Fixpoint lives in type.js.
 *  Threads the settled slot census as the `.prop`-read resolver — without it a
 *  binding built from an int-certain slot (`const x = hitX ? p.x : nx`) stayed
 *  uncertain and every consumer re-paid the ToNumber guard. */
export function analyzeIntCertain(body) {
  const slotIntOf = ctx.schema?.slotIntCertainAt
    ? (obj, prop) => {
      const id = ctx.schema.idOf?.(obj)
      if (id == null) return null
      const idx = ctx.schema.list[id]?.indexOf(prop)
      if (idx == null || idx < 0) return null
      return ctx.schema.slotIntCertainAt(obj, prop)
    }
    : undefined
  for (const [name, intC] of intCertainMap(body, undefined, slotIntOf)) {
    if (intC) updateRep(name, { intCertain: true })
  }
}
