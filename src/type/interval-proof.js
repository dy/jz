/**
 * The numbers a function's locals hold, flow by flow: an abstract interpreter
 * whose environment holds the table's values (summary/num-range.js `{lo, hi,
 * int, nz, nan}`), every operator its transfer rule, loops by a widening join
 * and narrowing. It proves index, call-argument and store hulls and each
 * binding's numbers over its lifetime. Emission reads memoized per-body index
 * proofs through intervalProvenIdx/intervalIdxRanges; parameter analysis
 * supplies entry ranges and collects argument/store hulls.
 *
 * @module type/interval-proof
 */
import {
  I32_MIN, I32_MAX, isI32, isReassigned, MUTATE_OPS, ASSIGN_OPS as WRITE_OPS,
  walkAst, some, someDeep, REFS_THROUGH_ARROWS, REFS_IN_EXPR, refsName, callArgs, alwaysLeaves, collectAssignedNames, effectiveWriteValue, nodeEqual,
} from '../ast.js'
import { ctx, getFactStore } from '../ctx.js'
import { intLiteralValue, typedCtorRawOf, intExprRange, staticObjectProps } from '../static.js'
import { typedElemAux, TYPED_ELEM_F16_FLAG, TYPED_ELEM_BIGINT_FLAG } from '../../layout.js'
import { nrBinary, nrUnary, nrMath, nrInts, nrPoint, nrValue, nrJoin, nrEqual, nrSpan, nrWord, NR_WHOLE } from '../summary/num-range.js'
import { exprType } from './expr-type.js'
import { idxKey, redeclaresName, collectDecls, isUnitDecrement, maxAdvanceBudget, minAdvanceBudget, maxMovementBudget, scanBoundedLoops } from './canonical-bounds.js'
import { K, NUMBER, bitOf, TAGS, NULL_BITS, core } from '../summary/kind.js'
import { VAL, lookupValType, repOfGlobal } from '../reps.js'
import { propValType } from '../kind-traits.js'
import { enterActiveFunction, restoreActiveFunction } from '../compile/active-function.js'
import { typedStorageNameCtor } from '../typed-context.js'

// === Static interval proof (typedIdxProven class 5) ===
// The conv2d/blur shape class: every dimension folds to a literal, every index is a
// chain of decls over ivs (`const irow = inCh+(oy+ky)*W+ox`), and the clamp idiom
// (`if(xi<0)xi=0; else if(xi>=w)xi=w-1`) bounds the tap. No runtime guard can help
// there (nest-level recognizers must see the BARE nest), and none is needed — the
// whole computation is static. Accesses whose idx interval fits a STATIC receiver
// length are recorded proven; everything else stays checked/versioned.

// The smallest 2^k − 1 covering a non-negative m: the top of m's bit field (integer
// arithmetic: a transcendental may differ in its last bit between the native and
// the self-hosted compiler, and a proof must not).
const fieldAbove = (m) => m <= 0 ? 0 : 2 ** (32 - Math.clz32(m)) - 1
const empty = (v) => v.lo > v.hi
// The edges where a value meets a pair: an index's span (a non-negative integer
// one word holds, never NaN; -0 reads element 0), and a hull that may authorize a
// signed word's storage (summary/num-range.js `nrWord`).
const indexSpan = (v) => v && !empty(v) && v.int && !v.nan && v.lo >= 0 && v.hi <= I32_MAX ? [v.lo, v.hi] : null
const wordSpan = (v) => nrWord(v) ? [v.lo, v.hi] : null
// Every fact both values state of one value: what a test leaves of a name, a theorem's cap.
const meet = (a, b) => nrValue(Math.max(a.lo, b.lo), Math.min(a.hi, b.hi), a.int || b.int, a.nz || b.nz, a.nan && b.nan, a.whole || b.whole)
// The facts `a` states hold of every value `b` may be.
const within = (b, a) => !!b && (empty(b) && !b.nan || (empty(b) || b.lo >= a.lo && b.hi <= a.hi) &&
  (!a.int || b.int) && (!a.whole || b.whole) && (!a.nz || b.nz) && (a.nan || !b.nan))
// The widening join: an end the back edge moves past the entry's goes to the
// word's end while the back edge is inside the word, else it opens (the verify
// pass proves the word's end or widens on).
// A constant K the loop's test tests a name's truth against gives the name
// thresholds K - 1, K, K + 1: the nearest one the back edge has not passed
// comes first, the verify pass deciding.
const widen = (a, b, K = null) => nrValue(
  b.lo < a.lo ? (K != null && b.lo >= K - 1 ? Math.min(b.lo, K + 1, Math.max(K - 1, Math.floor(b.lo))) : b.lo >= I32_MIN ? I32_MIN : -Infinity) : Math.min(a.lo, b.lo),
  b.hi > a.hi ? (K != null && b.hi <= K + 1 ? Math.max(b.hi, K - 1, Math.min(K + 1, Math.ceil(b.hi))) : b.hi <= I32_MAX ? I32_MAX : Infinity) : Math.max(a.hi, b.hi),
  a.int && b.int, a.nz && b.nz, a.nan || b.nan, a.whole && b.whole)
const opened = (v) => v.lo === -Infinity || v.lo === I32_MIN || v.hi === Infinity || v.hi === I32_MAX
// A theorem that caps a name from above alone: no fact of its values but the cap.
const capOnly = (hi) => nrValue(-Infinity, hi, false, false, true)
const WORD_VALUE = nrInts(I32_MIN, I32_MAX), UWORD_VALUE = nrInts(0, 2 ** 32 - 1)
export const WHOLE_VALUE = NR_WHOLE
// A carrier's word holds a number only where the summary holds the value to
// numbers: a test's word is a Boolean, which no arithmetic reads as its 0 or 1
// before converting it (`t[a < b]` reads the key "true").
const numeric = (e) => core(ctx.summary?.at(ctx.func.current)?.kindOfExpr(e) ?? K.NONE) === NUMBER
// What a call's carrier holds: a user function's word result (signed, or the
// unsigned word it is flagged to carry), a lane, and a code unit read in
// bounds (`inBounds`: the proof is of a string receiver's own method).
const I32_LANES = new Set(['i32x4.lane', 'v128.anyTrue', 'v128.allTrue'])
const callNumbers = (e, inBounds) => {
  const c = e[1]
  if (Array.isArray(c)) return c[0] === '.' && c[2] === 'charCodeAt' && inBounds(c) ? nrInts(0, 65535) : null
  if (typeof c !== 'string' || !numeric(e)) return null
  if (I32_LANES.has(c)) return WORD_VALUE
  const sig = ctx.funcs.map?.get(c)?.sig
  return sig?.results?.length === 1 && sig.results[0] === 'i32' && sig.ptrKind == null ? sig.unsignedResult ? UWORD_VALUE : WORD_VALUE : null
}
// What a member read's carrier holds: a sized property of a receiver its
// representation knows (`.length` of a string, `.size`, `.byteLength`: a
// count, read as the word `__len` gives), a field every store of which is a
// word, or integral wherever finite, where the summary holds it to numbers (a
// Boolean field's word is none): the slot census's (`slot`, while it decides).
const memberNumbers = (e, slot) => {
  if (propValType(e[2], lookupValType(e[1]), e[2] === 'length' ? typedStorageNameCtor(ctx, e[1]) : null) === VAL.NUMBER) return WORD_VALUE
  const v = slot ? slot(e) : ctx.schema?.slotI32CertainAt?.(e[1], e[2]) ? WORD_VALUE : ctx.schema?.slotIntCertainAt?.(e[1], e[2]) === true ? WHOLE_VALUE : null
  return v && numeric(e) ? v : null
}
// The one integer a value is, or null; whether a pair is inside one word.
const point = (v) => v && v.int && !v.nan && v.lo === v.hi ? v.lo : null
const inWord = (h) => h != null && h[0] >= I32_MIN && h[1] <= I32_MAX
// The test that holds where one failed, NaN aside.
const NEGATED = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '===': '!==', '!==': '===' }
// The most a `length` counts where the summary holds the name to only arrays,
// typed arrays and strings: a count below 2^32, and an array's below 2^29 (its
// 8-byte cells in a 32-bit memory, as static.js intExprRange reads it); null for
// any other name.
const MAX_COUNT = 2 ** 32 - 1, ARRAY_COUNT = 2 ** 29 - 1
const COUNTED = bitOf(K.ARRAY) | bitOf(K.TYPED) | bitOf(K.STRING)
const countOf = (x) => {
  const k = ctx.summary?.at(ctx.func.current)?.kindOfExpr(x)
  const t = k == null ? 0 : k & TAGS & ~NULL_BITS
  return t === 0 || (t & ~COUNTED) !== 0 ? null : t === bitOf(K.ARRAY) ? ARRAY_COUNT : MAX_COUNT
}
// Initializer roots whose true result can carry range facts through a named const.
const RANGE_GUARD_OPS = new Set(['&&', '<', '<=', '>', '>=', '===', '!=='])

// A quotient under a test of its remainder (`if (srcIdx % up === 0) { const xi =
// srcIdx / up }`) is exact: an integer of operands integral wherever finite.
// Each operand reads no call, no member and no element, and neither the test
// nor the arm writes or redeclares a name it reads, so the quotient divides
// what the test divided; the walk reads one only of names no call can write.
const exactDivs = new WeakSet()
export const isExactDivision = (n) => exactDivs.has(n)
/** Mark every quotient of a body under a test of its remainder (plan/integral-loops.js reads them ahead of the walk). */
export const markExactDivisions = (body) => walkAst(body, { enter: n => { if (n[0] === 'if' && n.length >= 3) noteExactDivs(n[1], n[2]) } })
const plainOperand = (e) => !some(e, n => n[0] === '()' || n[0] === 'new' || n[0] === '.' || n[0] === '?.' || n[0] === '[]' || MUTATE_OPS.has(n[0]), REFS_THROUGH_ARROWS)
const writesAny = (node, names) => some(node, n => {
  const decl = n[0] === 'let' || n[0] === 'const'
  if (!decl && !MUTATE_OPS.has(n[0])) return false
  const targets = decl ? n.slice(1).map(d => Array.isArray(d) && d[0] === '=' ? d[1] : d) : [n[1]]
  return targets.some(t => someDeep(t, x => typeof x === 'string' && names.has(x)))
}, REFS_THROUGH_ARROWS)
function noteExactDivs(test, arm) {
  const conjuncts = []
  const split = (t) => { if (Array.isArray(t) && t[0] === '&&' && t.length === 3) { split(t[1]); split(t[2]) } else conjuncts.push(t) }
  split(test)
  for (const t of conjuncts) {
    if (!Array.isArray(t) || (t[0] !== '===' && t[0] !== '==') || t.length !== 3) continue
    const rem = Array.isArray(t[1]) && t[1][0] === '%' ? t[1] : Array.isArray(t[2]) && t[2][0] === '%' ? t[2] : null
    const zero = rem === t[1] ? t[2] : t[1]
    if (!rem || rem.length !== 3 || !(Array.isArray(zero) && zero[0] == null && zero[1] === 0)) continue
    if (!plainOperand(rem[1]) || !plainOperand(rem[2])) continue
    const names = new Set()
    someDeep(rem, x => { if (typeof x === 'string') names.add(x); return false })
    if (writesAny(test, names) || writesAny(arm, names)) continue
    walkAst(arm, { enter: n => { if (n[0] === '=>') return false; if (n[0] === '/' && n.length === 3 && nodeEqual(n[1], rem[1]) && nodeEqual(n[2], rem[2])) exactDivs.add(n) } })
  }
}

/** Walk one function body; lens(name) returns a static element count or null.
 *  What the walk collects, each a map the caller passes:
 *  - `calls`: the values of each call's arguments, and `stores`: the scalar
 *    hulls of stored values (integer pairs, a word's, `wordSpan`), under the
 *    `entry` ranges of the parameters. Those maps preseed requested AST nodes
 *    with undefined; null means unknown. Repeated structural keys join
 *    conservatively.
 *  - `values`: the value of each requested node, as values: an expression's,
 *    or the number a member write stores (`o.k += 1` stores `o.k + 1`).
 *  - `out`: a key string proven at every occurrence and each access NODE proven
 *    at its own position; `ranges`, the hull of each key no length discharged.
 *  - `bindings`: the numbers of each named local over its lifetime, as values;
 *    a read before a known definition and any unknown write poison the result
 *    (null).
 *  - `misses`: each unproven access of known length as [lo, hi, L], its hull
 *    over the walk (null bounds where unknown), for a guard to test.
 *  - `written`: what each write of a name stores, by node (a declarator, an
 *    assignment, a step), as values.
 *  `present(node)` answers for element reads another prover holds in bounds;
 *  `assume(name)` gives the value of a name wherever the walk knows no more of
 *  it, a closure's writes or a call's notwithstanding: a hypothesis over every
 *  write of a binding other flows write too, which the caller verifies. `own`
 *  names the flow's own bindings besides its declarations (a closure's
 *  parameters); `slot(member)` answers a field read while the slot census
 *  decides. The emitter's branch refinements are no fact of the whole body:
 *  the walk reads none. */
export function scanIntervalIdx(body, lens, facts = {}) {
  const refinements = ctx.func.refinements
  ctx.func.refinements = null
  try { scanBody(body, lens, facts) } finally { ctx.func.refinements = refinements }
}
function scanBody(body, lens, { out = null, ranges = null, calls = null, entry = null, stores = null, misses = null, bindings = null, written = null, assume = null, present = null, own = null, values = null, slot = null }) {
  // Branches retain their completed map and resume the saved entry map.
  // Values are immutable, so unchanged ones can be shared at joins.
  // Missing map entries are unknown. Keep lexical/write ownership separately:
  // discarding an unknown interval must not reveal a same-named module constant.
  let env = new Map()   // name → the numbers it holds (num-range.js)
  // Each loop's fixpoint walks its body several times, and every walk reruns
  // the fixpoints of the loops inside it: a nest costs about 5^depth walks of
  // its innermost body. Past a budget of 512 visits per node of the body
  // (watr's compile peaks at 65, a five-deep nest of counted loops at 254), a
  // loop a discovery pass reaches takes the plain fixpoint: discovery, the
  // widening join and its verify, with a name that escapes it unknown. The
  // tightening trials only narrow a sound invariant, so leaving them out
  // loses no soundness, and a final pass keeps them: a nest then costs about
  // 3^depth.
  let steps = 0, budget = 50000
  walkAst(body, { enter: n => { budget += 512; if (n[0] === 'if' && n.length >= 3) noteExactDivs(n[1], n[2]) } })
  const declared = new Set()
  // (a closure's own parameter is none of the function's it shadows)
  const ownNames = own ? new Set(own) : null
  if (entry) for (const [name, value] of entry) {
    declared.add(name)
    if (value && !ownNames?.has(name)) env.set(name, nrInts(value[0], value[1]))
  }
  // Structural keys survive lowering clones, but each occurrence must prove
  // its own bounds. One unchecked twin permanently rejects the shared proof.
  // The access node itself carries its own occurrence's proof: a clone made
  // after this walk is a different node and keeps to the key's verdict, so a
  // provable read keeps its proof beside an unprovable twin.
  const rejected = out ? new Set() : null, rejectedNodes = out ? new Set() : null
  let guardProofContext = 0
  const underGuardProof = (guarded, fn) => {
    if (!guarded) return fn()
    guardProofContext++
    try { return fn() } finally { guardProofContext-- }
  }
  // While-body fixpoint passes walk EXPLORATORILY — env may be transiently too
  // narrow, so proof/hull recording is suppressed until the stable final pass.
  let recording = true
  // The step values of the writes an open loop bounds by its trips, joined over its passes.
  const stepLog = new Map(), stepSide = new Map()   // write → value; `x ± v` → [write, the side v is]
  const logStep = (write, v) => { if (!stepLog.has(write)) return; const p = stepLog.get(write); stepLog.set(write, p === undefined ? v ?? null : p && v ? nrJoin(p, v) : null) }
  const recordWrite = (n, value) => {
    if (!recording || !written) return
    const prev = written.get(n)
    written.set(n, prev === undefined ? value ?? null : prev && value ? nrJoin(prev, value) : null)
  }
  const joinValue = (prev, v) => prev === undefined ? v ?? null : prev && v ? nrJoin(prev, v) : null
  const recordValue = (n, v) => {
    if (!recording) return
    const prev = values.get(n)
    values.set(n, Array.isArray(v) ? v.map((x, k) => joinValue(prev === undefined ? undefined : prev?.[k] ?? null, x)) : joinValue(prev, v))
  }
  const recordBinding = (name, value) => {
    if (!recording || !bindings?.has(name)) return
    const prev = bindings.get(name)
    bindings.set(name, prev === undefined ? value ?? null : prev && value ? nrJoin(prev, value) : null)
  }
  const symEnv = new Map()   // name → { h: symbolic hull, incNode } — wrap cursors vs mutable bounds
  // Positive companion induction variables (`for (i += 3) { out[op] = …; op += 4 }`).
  // Unlike env's loop invariant, this hull is valid only BEFORE the companion's
  // direct increment in each iteration. Keeping that window explicit proves
  // codec/output cursors without pretending the post-increment value is in-bounds.
  const coupledEnv = new Map() // name → { h: value, incNode }
  // names written inside ANY closure in this body: a later call can change them at
  // any point — they never hold a trusted interval
  const closureWrites = new Set()
  // the names the body declares: none of them is the module binding it may shadow
  const owned = new Set(own)
  if (own) for (const name of own) declared.add(name)
  const needed = !out && !written && (calls || stores || bindings || values) ? new Set() : null
  const collectClosureWrites = (n, inClosure) => {
    if (typeof n === 'string') return bindings?.has(n) ?? false
    if (!Array.isArray(n)) return false
    const into = inClosure || n[0] === '=>'
    if (n[0] === 'let' || n[0] === 'const') for (let k = 1; k < n.length; k++) {
      const d = n[k]
      if (typeof d === 'string') { declared.add(d); owned.add(d) }
      else if (Array.isArray(d) && d[0] === '=') { collectNames(d[1], declared); collectNames(d[1], owned) }
    }
    if (MUTATE_OPS.has(n[0])) {
      if (typeof n[1] === 'string') declared.add(n[1])
      else if (Array.isArray(n[1]) && n[1][0] !== '[]' && n[1][0] !== '.' && n[1][0] !== '?.') collectNames(n[1], declared)
    }
    if (into && MUTATE_OPS.has(n[0])) {
      if (typeof n[1] === 'string') closureWrites.add(n[1])
      // member writes (`o[i]=…`, `o.p=…`) rebind no name; only PATTERN targets do
      else if (Array.isArray(n[1]) && n[1][0] !== '[]' && n[1][0] !== '.' && n[1][0] !== '?.')
        collectNames(n[1], closureWrites)
    }
    let used = calls?.has(n) || stores?.has(n) || values?.has(n)
    for (let k = 1; k < n.length; k++) if (collectClosureWrites(n[k], into)) used = true
    if (used && needed) needed.add(n)
    return used
  }
  const collectNames = (n, set) => someDeep(n, x => { if (typeof x === 'string') set.add(x); return false })
  collectClosureWrites(body, false)
  // Whether a loop writes a name it does not declare itself.
  const outerWrites = new Map()
  const writesOuter = (loop) => {
    let w = outerWrites.get(loop)
    if (w !== undefined) return w
    const own = new Set(), targets = []
    walkAst(loop, { enter: m => {
      if (m[0] === '=>') return false
      if (m[0] === 'let' || m[0] === 'const') for (let k = 1; k < m.length; k++) {
        const d = m[k]
        if (typeof d === 'string') own.add(d)
        else if (Array.isArray(d) && d[0] === '=') collectNames(d[1], own)
      }
      if (MUTATE_OPS.has(m[0]) && typeof m[1] === 'string') targets.push(m[1])
    } })
    w = targets.some(t => !own.has(t))
    outerWrites.set(loop, w)
    return w
  }
  const activeFacts = new Map()   // name → a theorem's value: a loop's cursor budget, a rewrite pass's stamp (peel)
  // What a name holds where the walk knows no more: the caller's hypothesis, or
  // what its carrier holds, as exprType reads it: a word parameter's or a word
  // module binding's word (a call can write the binding, never past its word),
  // and what the binding holds over every flow that writes it: a parameter
  // every call and every write gives an integral Number (compile/narrow/
  // int-params.js), a module binding every write of which is one (plan/scope.js).
  const params = ctx.func.current?.params
  const carried = (name) => {
    if (closureWrites.has(name) || owned.has(name)) return null
    const p = params?.find(q => q.name === name)
    if (p) return p.ptrKind != null || !numeric(name) ? null : p.type === 'i32' ? WORD_VALUE : p.intLevel ? WHOLE_VALUE : null
    if (ctx.scope?.globalValTypes?.get(name) !== VAL.NUMBER) return null
    return ctx.scope.globalTypes?.get?.(name) === 'i32' ? WORD_VALUE : repOfGlobal(name)?.intCertain === true ? WHOLE_VALUE : null
  }
  const valueOf = (name) => env.get(name) ?? assume?.(name) ?? carried(name)
  // A parameter's entry: the range its callers prove, else what it carries.
  if (entry) for (const [name, range] of entry) if (!range) { const c = carried(name); if (c) env.set(name, c) }
  // The code unit reads this body's loops hold in bounds, as the walk finds
  // them: inBoundsCharCodeAt's per-body memo is emission's, and an analysis
  // ahead of a caller-proven length bound must not fill it.
  let codeUnits = null
  const inBoundsCode = (c) => {
    if (!codeUnits) { codeUnits = new Set(); scanBoundedLoops(body, codeUnits) }
    return codeUnits.has(c)
  }
  // Preserve range facts through an immutable named guard:
  // `const inside = x >= 0 && x < W; if (inside) out[x] = 1`.
  // A definition is usable only while every referenced binding is unchanged;
  // writes and potentially-mutating calls retire it before a later branch.
  const boolDefs = new Map()
  const invalidateBool = (name) => { for (const [k, e] of boolDefs) if (e.free.has(name)) boolDefs.delete(k) }
  // Do not replay an effectful initializer as a theorem: a call/update can
  // change a compared name after an earlier conjunct observed it. Typed reads
  // and fixed typed lengths are effect-free even when receivers alias.
  const stableRangeExpr = (def) => !some(def, n => {
    const op = n[0]
    if ((op === '()' && n.length !== 2) || op === 'new' || MUTATE_OPS.has(op)) return true
    if (op === '[]') return typeof n[1] !== 'string' || !ctx.func.typedElem?.has(n[1])
    if (op === '.' || op === '?.')
      return n[2] !== 'length' || typeof n[1] !== 'string' || !ctx.func.typedElem?.has(n[1])
    return false
  }, REFS_THROUGH_ARROWS)
  const setEnv = (name, v) => {
    invalidateBool(name)
    const f = activeFacts.get(name)
    if (closureWrites.has(name)) v = null
    // (a theorem holds every value the name takes: `++k` past it is capped)
    else if (f) v = v ? meet(v, f) : f
    if (v) env.set(name, v)
    else env.delete(name)
    recordBinding(name, v)
  }
  // What each name is assigned while an open loop fixpoint walks its loop,
  // innermost last: a value written by `=` hulls in, a step (`++`, `+=`)
  // marks the name as riding on itself (loopFixpoint's assigned hulls).
  const assigned = []
  const noteAssigned = (name, plain) => {
    const v = env.get(name) ?? null
    for (const a of assigned) {
      if (!plain) { a.steps.add(name); continue }
      const p = a.values.get(name)
      a.values.set(name, p === undefined ? v : p && v ? nrJoin(p, v) : null)
    }
  }
  const constInt = (e) => {
    const n = intLiteralValue(e)
    if (n != null) return Object.is(n, -0) ? null : n
    if (typeof e === 'string' && !declared.has(e) && !env.has(e) && !closureWrites.has(e)) {
      const ci = ctx.scope?.constInts?.get?.(e)
      if (ci != null && isI32(ci)) return ci
    }
    return null
  }
  // A number the source writes, or a module constant no local shadows.
  const constNum = (e) => {
    const n = constInt(e)
    if (n != null) return nrPoint(n)
    if (Array.isArray(e) && e[0] == null && typeof e[1] === 'number') return nrPoint(e[1])
    if (typeof e === 'string' && !declared.has(e) && !env.has(e) && !closureWrites.has(e)) {
      const c = ctx.scope?.constNums?.get?.(e)
      if (typeof c === 'number') return nrPoint(c)
    }
    return null
  }
  const ARITH = new Set(['+', '-', '*', '/', '<<', '>>', '>>>', '&', '%', '|', '^'])
  const ev = (e) => {
    if (typeof e === 'string') recordBinding(e, closureWrites.has(e) ? null : env.get(e))
    const c = constNum(e)
    if (c) return c
    if (typeof e === 'string') return closureWrites.has(e) ? assume?.(e) ?? null : coupledEnv.get(e)?.h ?? valueOf(e)
    if (!Array.isArray(e)) return null
    const [op, x, y] = e
    // An element hull describes a present value only. Retaining it across
    // a missing read would prove the next gather index valid after undefined
    // had become zero (or NaN in arithmetic).
    if (op === '[]' && e.length === 3 && typeof x === 'string') {
      // (a read another prover holds in bounds: its element hull, a word's)
      if (!visit(e) && !present?.(e)) { const w = intExprRange(e); return w ? nrInts(w[0], w[1]) : null }
      // (a receiver no frame fact types: the summary's constructor, a plan's walk ahead of emission)
      const r = ctx.func.localReps?.get(x)?.arrayElemRange
      return r ? nrInts(r[0], r[1]) : elementNumbers(typedCtorRawOf(x) ?? ctx.summary?.at(ctx.func.current)?.typedCtorOf?.(x))
    }
    // `X.length` of a typed receiver with a known static length — the length-
    // identity atom: `const n = a.length` binds a singleton, `(a.length-1)>>1`
    // style index math evaluates exactly. Typed lengths are fixed for the
    // binding's lifetime (the tracker drops the entry on any rebinding).
    if ((op === '.' || op === '?.') && e.length === 3 && typeof x === 'string' && e[2] === 'length') {
      const L = lens(x)
      if (L != null) return nrPoint(L)
      // Any other array's, typed array's or string's length is a count of
      // its elements (a nullish receiver throws before it reads).
      const most = op === '.' ? countOf(x) : null
      if (most != null) return nrInts(0, most)
    }
    // `Math`'s functions are pure: the table's rule over the arguments' numbers.
    if (op === '()' && e.length === 3 && typeof x === 'string' && x.startsWith('math.')) return nrMath(x.slice(5), callArgs(e).map(a => ev(a)))
    // Grouping and numeric conversion keep the numbers.
    // Load-CSE uses unary plus when its temporary needs a Number carrier.
    if (e.length === 2 && op === '()') return ev(x)
    if (e.length === 2 && (op === 'u+' || op === 'u-' || op === '-' || op === '~')) return nrUnary(op === '-' ? 'u-' : op, ev(x))
    // prepare's member step (`++o.k` stores `+1 o.k`): the number one past, or before, it
    if (e.length === 2 && (op === '+1' || op === '-1')) return nrBinary(op[0], ev(x), nrPoint(1))
    // Save the old value before transferring a postfix update, exactly once.
    if (op === 'postfix' && Array.isArray(x) &&
        (x[0] === '++' || x[0] === '--') && typeof x[1] === 'string') {
      const before = ev(x[1])
      visit(x)
      const after = env.get(x[1])
      // A loop theorem can cap the updated cursor more tightly than its
      // incoming invariant. Exact integer transfer constrains the old value too.
      return before?.int && after?.int ? meet(before, nrBinary('-', after, nrPoint(x[0] === '++' ? 1 : -1))) : before
    }
    // Prefix updates yield the value after the mutation.
    if (e.length === 2 && (op === '++' || op === '--') && typeof x === 'string') {
      visit(e)
      return env.get(x) ?? null
    }
    // An assignment expression yields the value just written. Load-CSE puts
    // its first cached read here, including inside a dependent gather index.
    if (op === '=' && e.length === 3 && typeof x === 'string') {
      visit(e)
      return env.get(x) ?? null
    }
    if (op === '?:' && e.length === 4) {   // join of both arms, each under its refinement
      visit(x)
      const saved = new Map(env)
      // (every `&&` conjunct holds in the then arm, as in an `if`: `i >= 0 && i < a.length ? a[i] : d`;
      // a test that writes keeps its first comparison alone: a later conjunct may move what an earlier one bounded)
      const rE = refine(x, true)
      const writes = some(x, n => MUTATE_OPS.has(n[0]))
      for (const rT of writes ? [refine(x, false)].filter(Boolean) : refineAll(x)) if (!closureWrites.has(rT[0])) env.set(rT[0], rT[1])
      const a = ev(e[2])
      const afterThen = env
      env = saved
      if (rE) env.set(rE[0], rE[1])
      const b = ev(e[3])
      hullInto(afterThen)
      return a && b ? nrJoin(a, b) : null
    }
    // A short circuit is one of its operands, the right one where the left let
    // it run (its writes joined with the path that skipped it).
    if ((op === '&&' || op === '||' || op === '??') && e.length === 3) {
      const a = ev(x), save = new Map(env)
      if (op === '&&') { for (const r of refineAll(x)) if (!closureWrites.has(r[0])) env.set(r[0], r[1]) }
      else if (op === '||') { const r = refine(x, true); if (r && !closureWrites.has(r[0])) env.set(r[0], r[1]) }
      const b = ev(y)
      hullInto(save)
      return a && b ? nrJoin(a, b) : null
    }
    if (op === ',') { for (let k = 1; k < e.length - 1; k++) visit(e[k]); return ev(e[e.length - 1]) }
    // A call's and a member read's carrier (callNumbers, memberNumbers).
    if (op === '()' && e.length === 3) { visit(e); return callNumbers(e, inBoundsCode) }
    if (op === '.' && e.length === 3 && typeof x === 'string' && typeof e[2] === 'string') { visit(e); return memberNumbers(e, slot) }
    // any non-arithmetic node (assignment, indexing…) routes through visit so
    // its env effects and access proofs are processed, value unknown
    if (e.length !== 3 || !ARITH.has(op)) { visit(e); return null }
    // (a shift or a field reads each operand as its word, whatever it is: the table's rule)
    const A = ev(x), B = ev(y)
    const side = stepSide.get(e)
    if (side) logStep(side[0], side[1] === 2 ? B : A)
    // (an exact quotient of this flow's own names: a finite integer, the test having held)
    if (op === '/' && exactDivs.has(e) && A?.whole && B?.whole && ownOperand(x) && ownOperand(y)) {
      const q = nrBinary('/', A, B)
      return nrValue(q.lo, q.hi, true, q.nz, false)
    }
    return nrBinary(op, A, B)
  }
  // A quotient's operand only this flow writes: its own locals and parameters
  // (a closure walked alone holds its function's parameters as captures), no closure's.
  const ownOperand = (e) => !someDeep(e, x => typeof x === 'string' &&
    (closureWrites.has(x) || !!ctx.scope?.globals?.has?.(x) || !owned.has(x) && (own || !params?.some(p => p.name === x))))
  // condition refinement for if-arms: `name < K` / `name >= K` … over a known name.
  // The lhs also admits the AFFINE form `name ± c` (`inl_i + 3 <= N` — the strided
  // codec cursors): the comparison re-biases to `name OP K∓c`. The rhs admits any
  // ACCESS-FREE expression the evaluator folds to a singleton (`src.length | 0`).
  const pureExpr = (e) => !some(e,
    n => n[0] === '[]' || n[0] === '()' || n[0] === 'new' || n[0] === '?:' || n[0] === '=' || WRITE_OPS.has(n[0]),
    REFS_THROUGH_ARROWS)
  // A comparison can establish the first finite interval for an otherwise
  // unbounded machine-i32 name. Pointer locals also use i32 storage, so exclude
  // them: their numeric comparison semantics are not an integer-value proof.
  const fullI32Range = (name) => {
    if (exprType(name, ctx.func.locals) !== 'i32') return null
    if (ctx.func.localReps?.get(name)?.ptrKind != null) return null
    const p = ctx.func.current?.params?.find(q => q.name === name)
    return p?.ptrKind == null ? WORD_VALUE : null
  }
  // What a test leaves of the name it compares: `[name, value]`, the value empty
  // where the test cannot come out so. Each conjunct refines alone; refineAll
  // meets them (`x >= 0` and `x < W`).
  const refineRaw = (c, negate, seedUnknown = false) => {
    if (Array.isArray(c) && c[0] === '!' && c.length === 2) return refineRaw(c[1], !negate, seedUnknown)
    const t = truthOf(c)
    if (t) {
      // A name's truth: no zero nor NaN where it held, a zero or NaN where it
      // failed; a postfix step tested the old value, exact in an integer, the
      // name one step on from it.
      const [name, K] = t, v = valueOf(name)
      if (!v || K && !v.int) return null
      if (negate) return [name, meet(v, nrValue(K, K, true, K !== 0, true))]
      return [name, v.int ? nrValue(v.lo === K ? K + 1 : v.lo, v.hi === K ? K - 1 : v.hi, true, v.nz, false) : nrValue(v.lo, v.hi, false, v.nz, false, v.whole)]
    }
    if (!Array.isArray(c) || c.length !== 3) return null
    let [op, l, r] = c
    // rhs: a literal or module constant, a body-known value (`xi >= ww`, or a
    // RANGE-valued name — `child < end` inside the extract loop, where end is
    // the enclosing downward iv: the sound bound is the range's op-side
    // endpoint, hi for </<=, lo for >/>=), or a folded access-free expression
    let R = constNum(r) ?? (typeof r === 'string' ? env.get(r) ?? null : null)
    if (!R && Array.isArray(r) && pureExpr(r)) R = ev(r)
    // (a NaN side fails every comparison: where one held, neither side was NaN)
    if (!R || empty(R)) return null
    // Bit-field discriminator: `(tag & MASK) === VALUE` narrows a bounded
    // integer source to the matching hull. Enumerating at most 65K values is a
    // compile-time-only, fail-closed operation and handles byte/word opcode
    // classes exactly (QOI's `(b0 & 0xc0) === 0` ⇒ b0 ∈ [0,63]).
    if (!negate && (op === '===' || op === '==') && R.lo === R.hi && R.int &&
        Array.isArray(l) && l[0] === '&' && l.length === 3) {
      const mask = intLiteralValue(l[1]) ?? intLiteralValue(l[2])
      const name = typeof l[1] === 'string' ? l[1] : typeof l[2] === 'string' ? l[2] : null
      const v = name != null ? env.get(name) : null, s = nrSpan(v)
      if (mask != null && mask >= 0 && s && s[1] - s[0] <= 65536) {
        let lo = null, hi = null
        for (let x = s[0]; x <= s[1]; x++) if ((x & mask) === R.lo) { if (lo == null) lo = x; hi = x }
        if (lo != null) return [name, meet(v, nrInts(lo, hi))]
      }
    }
    let bias = 0
    if (Array.isArray(l) && l.length === 3 && (l[0] === '+' || l[0] === '-')) {
      const cR = intLiteralValue(l[2]), cL = intLiteralValue(l[1])
      if (typeof l[1] === 'string' && cR != null) { bias = l[0] === '+' ? cR : -cR; l = l[1] }
      else if (l[0] === '+' && typeof l[2] === 'string' && cL != null) { bias = cL; l = l[2] }
    }
    if (typeof l !== 'string') return null
    // A known integer of finite ends proves `name ± c` exact; a fresh full-i32
    // seed does not, so only bare-name comparisons seed.
    const known = valueOf(l)
    const v = known ?? (seedUnknown && !bias ? fullI32Range(l) : null)
    if (!v) return null
    if (bias) {
      if (!nrSpan(v) || Math.abs(v.lo) > 2 ** 52 || Math.abs(v.hi) > 2 ** 52) return null
      R = nrBinary('-', R, nrPoint(bias))
    }
    const relational = op === '<' || op === '<=' || op === '>' || op === '>='
    if (negate) {
      // (a NaN on the right fails the test whatever the name holds)
      if (relational && R.nan) return null
      op = NEGATED[op]
      if (!op) return null
    }
    // A test of `<` and the like failing leaves a NaN; `!==` holding does.
    const nan = v.nan && (negate && relational || op === '!==')
    // (an integer wherever finite past a finite bound is an integer on that side: an infinity is beyond it)
    const lo = op === '>' ? (v.whole ? Math.floor(R.lo) + 1 : R.lo) : op === '>=' || op === '===' ? (v.whole ? Math.ceil(R.lo) : R.lo) : -Infinity
    const hi = op === '<' ? (v.whole ? Math.ceil(R.hi) - 1 : R.hi) : op === '<=' || op === '===' ? (v.whole ? Math.floor(R.hi) : R.hi) : Infinity
    if (op === '<' || op === '<=' || op === '>' || op === '>=' || op === '===')
      return [l, nrValue(Math.max(v.lo, lo), Math.min(v.hi, hi), v.int, v.nz, nan, v.whole)]
    // ≠K tightens only at an ENDPOINT (interior point removal keeps the hull) —
    // exactly the toroidal-wrap ternary (`y === 0 ? h-1 : y-1`); a constant integer alone
    if (op === '!==' && v.whole && R.int && R.lo === R.hi) {
      const K = R.lo
      return [l, nrValue(v.lo === K ? K + 1 : v.lo, v.hi === K ? K - 1 : v.hi, v.int, v.nz, nan, true)]
    }
    return null
  }
  // The name a truth test reads and the value its truth turns on: a name and
  // a prefix step test the name's value against 0, a postfix step the old
  // value, the name then -1 (`x--`) or 1 (`x++`) where the old one was 0.
  const truthOf = (c) => {
    if (typeof c === 'string') return [c, 0]
    if (!Array.isArray(c)) return null
    if ((c[0] === '++' || c[0] === '--') && c.length === 2 && typeof c[1] === 'string') return [c[1], 0]
    if (c[0] === 'postfix' && Array.isArray(c[1]) && (c[1][0] === '++' || c[1][0] === '--') && typeof c[1][1] === 'string') return [c[1][1], c[1][0] === '--' ? -1 : 1]
    return null
  }
  // A refinement no execution reaches: no value, not even NaN.
  const unreachable = (v) => empty(v) && !v.nan
  const refine = (c, negate) => {
    const r = refineRaw(c, negate)
    return r && !unreachable(r[1]) ? r : null
  }
  // Whether the test cannot come out `!negate` from the current state: a
  // comparison whose refinement of its name's known interval is empty (`k > 0`
  // with k = 0), alone or as a conjunct that must hold (`&&` true, `||`
  // false). The code the test guards is unreachable from here, and walking it
  // would join states no execution has. The compared name must not be written
  // by the test itself.
  const impossible = (c, negate) => {
    if (!Array.isArray(c)) return false
    if (c[0] === (negate ? '||' : '&&') && c.length === 3) return impossible(c[1], negate) || impossible(c[2], negate)
    const r = refineRaw(c, negate)
    return !!r && unreachable(r[1]) && !isReassigned(c, r[0])
  }
  // A relational comparison with undefined is false (undefined converts to
  // NaN), and an element read of a receiver of known length L (a typed array,
  // an array) is undefined wherever its index is not an element index. So
  // where `E op a[x ± c]` HELD (op one of < <= > >=), the read hit:
  // x ± c ∈ [0, L − 1], an integer. The
  // sentinel-terminated scans rely on it, e.g. the lower envelope's
  // `while (s <= z[k]) k--`, whose body never runs with z[k] missed. The index
  // must be a name, alone or with a literal offset, that E does not write, and
  // a number the walk already tracks (a known value or an i32 local):
  // a hit proves the index an element index, not that the name is a number.
  const readHit = (c) => {
    if (!Array.isArray(c) || c.length !== 3 || !(c[0] === '<' || c[0] === '<=' || c[0] === '>' || c[0] === '>=')) return null
    for (const [read, other] of [[c[1], c[2]], [c[2], c[1]]]) {
      if (!Array.isArray(read) || read[0] !== '[]' || read.length !== 3 || typeof read[1] !== 'string') continue
      const L = lens(read[1])
      if (L == null || L < 1) continue
      let x = read[2], bias = 0
      if (Array.isArray(x) && x.length === 3 && (x[0] === '+' || x[0] === '-') && typeof x[1] === 'string' && intLiteralValue(x[2]) != null) {
        bias = x[0] === '+' ? intLiteralValue(x[2]) : -intLiteralValue(x[2]); x = x[1]
      }
      else if (Array.isArray(x) && x.length === 3 && x[0] === '+' && typeof x[2] === 'string' && intLiteralValue(x[1]) != null) {
        bias = intLiteralValue(x[1]); x = x[2]
      }
      if (typeof x !== 'string' || closureWrites.has(x) || isReassigned(other, x)) continue
      const known = valueOf(x) ?? fullI32Range(x)
      if (!known) continue
      const v = nrValue(Math.max(known.lo, -bias), Math.min(known.hi, L - 1 - bias), true, known.nz, false)
      if (!empty(v)) return [x, v]
    }
    return null
  }
  // Every conjunct holds on the positive path. Intersect repeated facts for
  // the same name: together `x >= 0 && x < W` prove a valid index domain.
  const refineAll = (c2, namedSeed = false) => {
    // The new full-i32 seed is deliberately limited to a positive `if (name)`
    // use of a stable const definition. Every older inline/refinement path keeps
    // its prior finite-env-only behavior.
    const seedUnknown = namedSeed && typeof c2 === 'string' && boolDefs.has(c2)
    if (!seedUnknown) {
      const out = []
      // (each conjunct refines from the same state: a name two of them bound takes both,
      // where the test writes nothing that could move it between them)
      const still = !some(c2, n => MUTATE_OPS.has(n[0]))
      const take = (h) => {
        const i = out.findIndex(o => o[0] === h[0])
        if (i < 0) { out.push(h); return }
        const m = meet(out[i][1], h[1])
        if (!unreachable(m)) out[i] = [h[0], m]
      }
      const parts = []
      const flat = (c3) => { if (Array.isArray(c3) && c3[0] === '&&') { flat(c3[1]); flat(c3[2]) } else parts.push(c3) }
      flat(c2)
      // A name a conjunct or a later one writes is where that write left it:
      // `i < n && s[i++]` holds `i` to n itself in the body, so a bound reaches
      // there only from a conjunct no write of the name follows. `after[i]` are
      // the names written from conjunct i on.
      let after = null
      if (!still) {
        after = new Array(parts.length)
        const seen = new Set()
        for (let i = parts.length - 1; i >= 0; i--) { collectAssignedNames(parts[i], seen); after[i] = new Set(seen) }
      }
      for (let i = 0; i < parts.length; i++) {
        const r = refineRaw(parts[i], false, false)
        // (a truth test's own step is the write its refinement already takes)
        const own = !!r && !(truthOf(parts[i]) ? after?.[i + 1] : after?.[i])?.has(r[0])
        if (own && !unreachable(r[1])) { if (still) take(r); else out.push(r) }
        // A read's hit refines its index name, intersected with that name's other conjuncts.
        const h = readHit(parts[i])
        if (h && !after?.[i].has(h[0])) take(h)
      }
      return out
    }
    const facts = new Map()
    const add = (r) => {
      if (!r || facts.get(r[0]) === null) return
      const prev = facts.get(r[0]), next = prev ? meet(prev, r[1]) : r[1]
      facts.set(r[0], unreachable(next) ? null : next)
    }
    const gather = (c3) => {
      if (typeof c3 === 'string') {
        const bd = boolDefs.get(c3)
        if (bd) gather(bd.def)
      } else if (Array.isArray(c3) && c3[0] === '&&') {
        gather(c3[1]); gather(c3[2])
      } else { add(refineRaw(c3, false, seedUnknown)); add(readHit(c3)) }
    }
    gather(c2)
    return [...facts].filter(([, v]) => v)
  }
  // descend into closures too — capture-writes stay dead
  const killAssigned = (n) => walkAst(n, { enter: n2 => {
    if (MUTATE_OPS.has(n2[0])) {
      if (typeof n2[1] === 'string') { invalidateBool(n2[1]); env.delete(n2[1]) }
      else if (Array.isArray(n2[1]) && n2[1][0] !== '[]' && n2[1][0] !== '.' && n2[1][0] !== '?.') {
        const s = new Set(); collectNames(n2[1], s); for (const x of s) { invalidateBool(x); env.delete(x) }
      }
    }
  } })
  // A canonical-iv range `iv ∈ [entry, B−1]` is a body-independent THEOREM only
  // while B is invariant: a body-written bound (`while (i < n) { …; n = 12 }`)
  // admits iv past the entry bound — the seed then "proved" raw OOB reads
  // (dist-reproduced on every canonical loop form). Every name the bound reads
  // must be unwritten AND undeclared in the body.
  // A callee, getter or coercion can write a module binding without a write
  // node in this body. Loop theorems require an uncaptured local lifetime.
  const loopMutable = name => closureWrites.has(name) || ctx.scope?.globalTypes?.has(name)
  const boundInvariant = (bexpr, body) => {
    if (bexpr == null) return false
    const s = new Set(); collectNames(bexpr, s)
    for (const bn of s) if (closureWrites.has(bn) || ctx.scope?.globalTypes?.has(bn) && !ctx.scope?.consts?.has(bn) ||
        isReassigned(body, bn) || redeclaresName(body, bn)) return false
    return true
  }
  // ABRUPT EDGES. A `break` reaches the loop's exit — and a `continue` its back
  // edge — carrying the flow state AT the statement, which the fall-through walk
  // never sees (`if (c) { x = BIG; break } x = 0` exits with x = BIG). Loop walks
  // push a frame; break/continue snapshot env into it; exits/joins hull the
  // snapshots in. Bare break binds to the innermost frame; bare continue to the
  // innermost LOOP frame; labeled forms can cross any number of frames, so they
  // conservatively feed every open one.
  const loopStack = []
  const hullInto = (snap) => {
    // A name known on just one edge is unknown at the join. Only the
    // intersection belongs in the map; unknown names remain in the census.
    for (const k2 of env.keys()) {
      const a = env.get(k2), b = snap.get(k2)
      if (!b) env.delete(k2)
      else if (a !== b) env.set(k2, nrJoin(a, b))
    }
  }
  // LOOP FIXPOINT over the loop HEAD, the state where the condition is
  // evaluated: entry ∪ back edges (2-round widening). Each pass restores a
  // head state, re-applies the body-independent theorems (`seedFn`: wrap
  // cursors, cursor budgets), and walks `walkFn(afterCond)`: the condition is
  // visited on the head state itself (its reads get no help from its own
  // truth, so `while (a[i] > 0 && i < n)` keeps `a[i]` checked), then
  // `afterCond` refines by `condNode`, descending `&&` (both conjuncts hold
  // when the body runs), and the body walks. Pass A yields the back-edge
  // state; the JOIN hulls entry with it (a name known on only one edge →
  // null); pass B re-walks from the join and any name whose back edge
  // escapes it widens to unknown; the FINAL pass walks the stable head with
  // proof recording ON. The exit is the head invariant where the condition
  // failed, ∪ the break states.
  const loopFixpoint = (seedFn, walkFn, condNode, exitBodyEnd = false, tighten = null) => {
    // Refines by the test and reports whether the body can run from here.
    const applyCond = () => {
      if (condNode == null) return true
      if (impossible(condNode, false)) return false
      for (const r of refineAll(condNode)) if (!closureWrites.has(r[0])) env.set(r[0], r[1])
      return true
    }
    const restore = (m) => { env.clear(); for (const [k2, v2] of m) env.set(k2, v2) }
    // every pass walks under a loop frame: continue edges are back-edges too,
    // so their snapshots hull into the pass-end state before any join/verify
    const walkPass = () => {
      const lc = { breaks: [], continues: [] }
      loopStack.push(lc); walkFn(applyCond); loopStack.pop()
      for (const s of lc.continues) hullInto(s)
      return lc
    }
    // A walk from a head state, recording off, leaves what it left the last
    // time it started there (the passes it walks are sound either way): the
    // last walk's start and end are kept, and a pass that would start where it
    // did reads its end instead.
    let last = null
    const walkFrom = (m) => {
      if (last && last.from.size === m.size && [...m].every(([k2, v2]) => nrEqual(last.from.get(k2), v2))) return restore(last.end)
      restore(m); seedFn(); walkPass()
      last = { from: new Map(m), end: new Map(env) }
    }
    // (the head's entry state is the seeded one: a seed is a theorem of every
    // head state, the first among them, so a seeded counter is no name the
    // join widens)
    seedFn()
    const entryEnv = new Map(env)
    const prevRec = recording
    const plain = !recording && steps > budget
    recording = false
    const writes = { values: new Map(), steps: new Set() }
    assigned.push(writes)
    walkPass()                                          // pass A: discovery
    const stepEnv = new Map(env)
    last = { from: entryEnv, end: stepEnv }
    // WIDENING JOIN: an escaping bound goes to the word's end (past it, opens)
    // instead of taking the one-step hull; the pass-B seed's cond refinement then clamps it to the
    // loop bound. This is what turns `for (; x + 3 <= N; x += 3)` into the
    // invariant x ∈ [0, N−3] (the strided-accumulator class) rather than
    // null: hull(entry, one step) can never contain step №2, so without the
    // widen every advancing cursor escapes to unknown.
    // (a truth test's constant, per name: `--i` against 0, `i--` against -1; a
    // comparison's own refinement clamps where a truth test removes one point)
    let thresholds = null
    const constants = (c) => {
      if (Array.isArray(c) && (c[0] === '&&' || c[0] === '||') && c.length === 3) { constants(c[1]); constants(c[2]); return }
      if (Array.isArray(c) && c[0] === '!' && c.length === 2) { constants(c[1]); return }
      const t = truthOf(c)
      if (t) { (thresholds ??= new Map()).set(t[0], t[1]); return }
    }
    if (condNode != null) constants(condNode)
    // (`carried`: the names the widening took past both edges' hull, the
    // only ones a narrowing pass can tighten)
    const joined = new Map(), carried = new Set()
    const widenTo = (k2, a, b, K) => {
      const j = widen(a, b, K), h = nrJoin(a, b)
      if (j.lo < h.lo || j.hi > h.hi) carried.add(k2)
      joined.set(k2, j)
    }
    for (const k2 of entryEnv.keys()) {
      const a = entryEnv.get(k2), b = env.get(k2)
      if (b) widenTo(k2, a, b, thresholds?.get(k2))
    }
    // FIELD BOUNDS: a widened name may hold a bit-pattern invariant the linear
    // hull cannot express — `bit >>= 1` never leaves [0, bit₀], `j ^= bit`
    // never leaves the field below bit₀'s width — and the sentinel itself is
    // too open for the bit rules to verify. For every widened name whose edges
    // are both non-negative words, the field candidate is lo 0 and hi the smallest
    // 2^k − 1 covering both edges; the candidates verify together in one pass
    // after the sentinel pass, and a name adopts its field only when it holds.
    const fields = new Map()
    for (const [k2, j] of joined) {
      if (!opened(j)) continue
      const a = wordSpan(entryEnv.get(k2)), b = wordSpan(stepEnv.get(k2))
      if (!a || !b || a[0] < 0 || b[0] < 0) continue
      const f = nrInts(j.lo <= I32_MIN ? 0 : j.lo, j.hi >= I32_MAX ? fieldAbove(Math.max(a[1], b[1])) : j.hi)
      if (f.lo > j.lo || f.hi < j.hi) fields.set(k2, f)
    }
    walkFrom(joined)                                    // pass B: verify
    // the back edge returns to the head, where the condition is evaluated
    // again: the walk-end state itself must lie in the head invariant
    const holds = (k2, j) => !!j && within(env.get(k2), j)
    const failed = new Set()
    for (const [k2, j] of joined) if (j && !holds(k2, j)) failed.add(k2)
    // A name the discovery pass left where it entered, which the verify pass
    // moves, follows a name the join widened (`best = j` under `j < n`): its
    // invariant takes in what the verify pass left, and the pass verifies once
    // more; a name that still escapes widens the way the join widens, and one
    // the join carried past an end goes on to the next end at once.
    for (let round = 0; round < 2 && failed.size && !plain; round++) {
      let moved = false
      for (const k2 of failed) {
        const j = joined.get(k2), b = env.get(k2)
        if (!b) continue
        if (round || carried.has(k2)) widenTo(k2, j, b)
        else joined.set(k2, nrJoin(j, b))
        moved = true
      }
      if (!moved) break
      walkFrom(joined)
      failed.clear()
      for (const [k2, j] of joined) if (j && !holds(k2, j)) failed.add(k2)
    }
    if (fields.size && !plain) {
      // The trial state is the sentinel join with the fields substituted, so a
      // name that failed above only because a field name sat at its sentinel
      // (`j ^= bit` with bit widened negative) verifies here against its own
      // bound. The trial is inductive only as a whole: every field and every
      // failed name must hold, or nothing from it is adopted.
      const trial = new Map(joined)
      for (const [k2, f] of fields) trial.set(k2, f)
      walkFrom(trial)
      if ([...fields].every(([k2, f]) => holds(k2, f)) && [...failed].every(k2 => holds(k2, joined.get(k2)))) {
        for (const [k2, f] of fields) joined.set(k2, f)
        failed.clear()
      }
    }
    for (const k2 of failed) joined.delete(k2)
    // ASSIGNED HULLS: a name the join widened (to a word's end, or to a bit
    // field), written only by `=` (`best = j` under a test), holds its entry
    // value or one it was assigned. The hull of those over the passes walked is
    // a candidate; the candidates verify together in one pass, and are adopted
    // where all hold.
    assigned.pop()
    const trial = new Map(joined)
    let candidates = false
    for (const [k2, j] of joined) {
      const a = entryEnv.get(k2), v = writes.values.get(k2)
      if (!j || !a || !v || writes.steps.has(k2) || (!opened(j) && !fields.has(k2))) continue
      const c = meet(j, nrJoin(a, v))
      if (c.lo > j.lo || c.hi < j.hi) { trial.set(k2, c); candidates = true }
    }
    if (candidates && !plain) {
      walkFrom(trial)
      if ([...trial].every(([k2, t]) => !t || holds(k2, t))) for (const [k2, t] of trial) joined.set(k2, t)
    }
    // NARROWING (≤2 decreasing passes): the widened invariant is sound but
    // loose — a name with no cond conjunct to re-clamp it sits at a word boundary even
    // when the loop's true range is finite (`i = child` copy chains: i only
    // ever receives root- or cond-clamped child-values, so hull(entry,
    // end-state) is the real invariant). Each pass recomputes the hull from
    // the stable state — every reachable back-edge state ⊆ F(joined), so
    // hull(entry, F(joined)) contains them all and only TIGHTENS
    // (meet with the previous invariant keeps the sequence decreasing).
    //
    // GATE (exact, not heuristic — a raw compile-time win jz.wasm pays for):
    // ONLY a name the widening carried past its edges' hull can narrow (a bit
    // field or an assigned hull it took since among them). The join gave every
    // other name its exact one-step hull (min/max of entry ∪ back-edge),
    // which is already the tightest interval containing both edges — a fresh
    // walk reproduces the same stable end-state, so the meet is a no-op there.
    // If NONE was carried, skip both extra body walks (the common case:
    // cond-clamped ivs never escape), and the first pass reads the last
    // verifying walk's end where no name moved since.
    for (let np = 0; np < 2 && !plain && carried.size; np++) {
      walkFrom(joined)
      let changed = false
      for (const [k2, j] of joined) {
        const a = entryEnv.get(k2), b = env.get(k2)
        if (!j || !a || !b) continue
        const c = meet(j, nrJoin(a, b))
        if (c.lo > j.lo || c.hi < j.hi) { joined.set(k2, c); changed = true }
      }
      if (!changed) break
    }
    tighten?.(joined)
    recording = prevRec
    restore(joined); seedFn()
    const lcF = walkPass()                              // FINAL: record on the stable env
    // exit state, where the condition failed:
    //  - default: the head invariant (joined) — sound for any trip count.
    //  - exitBodyEnd (caller proved ≥1 trip): the final walk's BODY-END state —
    //    the head state of the next test, tighter for defined-every-iteration
    //    names (an inlined preamble's `inl_i = 0` keeps [0,0] where the join
    //    would null it), and sound because the walk ran from the verified
    //    invariant, so its end state covers every real last-iteration state.
    //    Zero-trip loops must NOT use it: their real exit is the ENTRY state,
    //    which body-end doesn't cover.
    // Either way the failed condition refines it (`while (i < n)` exits i ≥ n).
    if (!exitBodyEnd) restore(joined)
    // (a test that writes leaves its writes on the exit edge: it runs there again)
    if (condNode != null && some(condNode, x => MUTATE_OPS.has(x[0]))) visit(condNode)
    const rX = condNode != null ? refine(condNode, true) : null
    if (rX && !closureWrites.has(rX[0])) env.set(rX[0], rX[1])
    // ∪ break-edge states (a break bypasses the loop condition and reaches the
    // exit mid-body; the caller's tighter iv/wrap exit forms stay sound — each
    // is an every-point invariant that covers break states)
    for (const s of lcF.breaks) hullInto(s)
  }
  // These helpers use the live scan environment, but their closures belong to
  // the scan, not each repeated visit of a for-loop during fixpoint iteration.
  // (a step written as its word, `x = (x + k) | 0`: the idiom, and the form a loop
  // version gives a cursor's steps)
  const unwrapped = (s) => s[0] === '=' && Array.isArray(s[2]) && s[2][0] === '|' && s[2].length === 3
    ? (constInt(s[2][2]) === 0 ? ['=', s[1], s[2][1]] : constInt(s[2][1]) === 0 ? ['=', s[1], s[2][2]] : s) : s
  const stepDelta = (s, name) => {
    if (!Array.isArray(s)) return null
    if (s[0] === 'postfix') s = s[1]
    s = unwrapped(s)
    if (s[0] === '++' && s[1] === name) return 1
    if (s[0] === '+=' && s[1] === name) return constInt(s[2])
    if (s[0] === '=' && s[1] === name && Array.isArray(s[2]) && s[2][0] === '+') {
      if (s[2][1] === name) return constInt(s[2][2])
      if (s[2][2] === name) return constInt(s[2][1])
    }
    return null
  }
  // Multi-branch monotone cursor budget. A codec cursor often advances a
  // different number of times in mutually-exclusive arms (`ip++` once for
  // INDEX, five times for RGBA). Compute the MAXIMUM positive constant
  // advance along any one body path; over a literal-trip loop this gives a
  // whole-body invariant `entry <= cursor <= entry + trips*maxAdvance`.
  // Unknown writes, nested control loops, abrupt edges, or closures reject.
  // (the budgets read integer hulls a word holds, as pairs)
  const evWord = (e) => { const v = ev(e); return v && v.int && !v.nan && v.lo >= I32_MIN && v.hi <= I32_MAX ? [v.lo, v.hi] : null }
  const advanceBudget = (root, name, upperOnly = false) => maxAdvanceBudget(root, name, { constInt, evRange: evWord, closureWrites, MUTATE_OPS, upperOnly })
  // Two-counter amortized budget. Track `cursor + credit` path-sensitively
  // through one loop body. This proves buffered/RLE emitters where a rare
  // path writes K+1 bytes only after `credit > 0` and resets the credit:
  // the extra byte spends accumulated credit, so the per-iteration
  // potential still rises by at most K. Only positive constant cursor
  // advances and affine/zero credit writes are accepted; complex control
  // or state explosion fails closed.
  const potentialAdvance = (root, cursor, credit) => {
    const LIM = 128, INF = I32_MAX
    const norm = (xs) => {
      const m = new Map()
      for (const s of xs) {
        if (s.lo > s.hi) continue
        const k = `${s.mode},${s.rv},${s.lo},${s.hi}`
        const p = m.get(k)
        if (!p || s.c > p.c) m.set(k, s)
      }
      const out = [...m.values()]
      return out.length <= LIM ? out : null
    }
    const addC = (xs, d) => d != null && d > 0 ? xs.map(s => ({ ...s, c: s.c + d })) : null
    const setCredit = (xs, mode, rv) => xs.map(s => ({ ...s, mode, rv }))
    const cmp = (a, op2, b) => op2 === '<' ? a < b : op2 === '<=' ? a <= b : op2 === '>' ? a > b
      : op2 === '>=' ? a >= b : op2 === '===' || op2 === '==' ? a === b : a !== b
    const split = (xs, cond2, truth) => {
      if (!Array.isArray(cond2) || cond2.length !== 3 ||
          !['<', '<=', '>', '>=', '===', '==', '!==', '!='].includes(cond2[0])) return xs.map(s => ({ ...s }))
      let op2 = cond2[0], k = constInt(cond2[2])
      if (cond2[1] !== credit || k == null) {
        if (cond2[2] === credit && (k = constInt(cond2[1])) != null)
          op2 = op2 === '<' ? '>' : op2 === '<=' ? '>=' : op2 === '>' ? '<' : op2 === '>=' ? '<=' : op2
        else return xs.map(s => ({ ...s }))
      }
      if (!truth) op2 = op2 === '<' ? '>=' : op2 === '<=' ? '>' : op2 === '>' ? '<=' : op2 === '>=' ? '<'
        : op2 === '===' || op2 === '==' ? '!==' : '==='
      const out = []
      for (const s of xs) {
        if (s.mode === 'const') { if (cmp(s.rv, op2, k)) out.push({ ...s }); continue }
        const q = k - s.rv
        let lo = s.lo, hi = s.hi
        if (op2 === '<') hi = Math.min(hi, q - 1)
        else if (op2 === '<=') hi = Math.min(hi, q)
        else if (op2 === '>') lo = Math.max(lo, q + 1)
        else if (op2 === '>=') lo = Math.max(lo, q)
        else if (op2 === '===' || op2 === '==') { lo = Math.max(lo, q); hi = Math.min(hi, q) }
        // `!=` removes an interior point which an interval cannot express;
        // retain the wider interval (safe, merely less precise).
        if (lo <= hi) out.push({ ...s, lo, hi })
      }
      return out
    }
    const directDelta = (n0, name) => {
      if (!Array.isArray(n0) || n0[1] !== name) return null
      const n = unwrapped(n0)
      if (n[0] === '++') return 1
      if (n[0] === '--') return -1
      if (n[0] === '+=' || n[0] === '-=') { const d = constInt(n[2]); return d == null ? null : n[0] === '+=' ? d : -d }
      if (n[0] === '=' && Array.isArray(n[2]) && (n[2][0] === '+' || n[2][0] === '-')) {
        if (n[2][1] !== name) return null
        const d = constInt(n[2][2]); return d == null ? null : n[2][0] === '+' ? d : -d
      }
      return null
    }
    const walk = (n, xs) => {
      if (!xs) return null
      if (!Array.isArray(n)) return xs
      const op2 = n[0]
      if (op2 === '=>') return isReassigned(n, cursor) || isReassigned(n, credit) ? null : xs
      if (MUTATE_OPS.has(op2) && (n[1] === cursor || n[1] === credit)) {
        // Evaluate embedded lhs/rhs effects first only when they are not the
        // direct recurrence itself; accepted recurrences contain no calls.
        if (n[1] === cursor) return addC(xs, directDelta(n, cursor))
        if (op2 === '=' && constInt(n[2]) != null) return setCredit(xs, 'const', constInt(n[2]))
        const d = directDelta(n, credit)
        if (d == null) return null
        return xs.map(s => ({ ...s, rv: s.rv + d }))
      }
      if (op2 === 'if') {
        let base = walk(n[1], xs)
        if (!base) return null
        const a = walk(n[2], split(base, n[1], true))
        const b = n.length > 3 ? walk(n[3], split(base, n[1], false)) : split(base, n[1], false)
        return a && b ? norm([...a, ...b]) : null
      }
      if (op2 === '?:') {
        let base = walk(n[1], xs)
        if (!base) return null
        const a = walk(n[2], split(base, n[1], true)), b = walk(n[3], split(base, n[1], false))
        return a && b ? norm([...a, ...b]) : null
      }
      if (op2 === '&&' || op2 === '||') {
        const left = walk(n[1], xs)
        if (!left) return null
        const right = walk(n[2], left)
        return right ? norm([...left, ...right]) : null // RHS may be skipped
      }
      if (op2 === 'break' || op2 === 'continue' || op2 === 'return' || op2 === 'throw') return null
      if (op2 === 'while' || op2 === 'for' ||
          op2 === 'catch' || op2 === 'finally')
        return isReassigned(n, cursor) || isReassigned(n, credit) ? null : xs
      let out = xs
      for (let j = 1; j < n.length; j++) { out = walk(n[j], out); if (!out) return null }
      return out
    }
    const end = walk(root, [{ c: 0, mode: 'rel', rv: 0, lo: 0, hi: INF }])
    if (!end?.length) return null
    let max = 0
    for (const s of end) {
      const creditLo = s.mode === 'rel' ? s.lo + s.rv : s.rv
      if (creditLo < 0 || s.c < 0) return null
      const d = s.mode === 'rel' ? s.c + s.rv : s.c + s.rv - s.lo
      if (!Number.isInteger(d)) return null
      max = Math.max(max, d)
    }
    return max
  }
  let forDecls = null
  const declarationsOf = init => {
    let decls = forDecls?.get(init)
    if (!decls) {
      decls = new Map()
      collectDecls(init, decls)
      ;(forDecls ??= new Map()).set(init, decls)
    }
    return decls
  }
  // Loop-only captured state is allocated only when a for-loop is visited.
  // The ordinary walker remains small even when nested fixpoints revisit it.
  const visitFor = n => {
    const [, init, cond, step, lbody] = n
    visit(init)
    // canonical literal-interval iv: `for (iv = A; iv </<= B; iv += STEP)` —
    // including affine tests (`iv + WIDTH <= B`) — or the DOWNWARD unit-step
    // twin (heapify roots, reverse scans). A/B fold through the full evaluator.
    let iv = null, range = null, ivStep = null, counter = null, trips = null
    const decls = declarationsOf(init)
    const down = Array.isArray(cond) && (cond[0] === '>' || cond[0] === '>=')
    if (Array.isArray(cond) && (cond[0] === '<' || cond[0] === '<=' || down)) {
      let name = cond[1], bias = 0
      if (!down && Array.isArray(name) && name.length === 3 && (name[0] === '+' || name[0] === '-')) {
        const r = constInt(name[2]), l = constInt(name[1])
        if (typeof name[1] === 'string' && r != null) { bias = name[0] === '+' ? r : -r; name = name[1] }
        else if (name[0] === '+' && typeof name[2] === 'string' && l != null) { bias = l; name = name[2] }
      }
      if (typeof name === 'string') {
        // the counter enters the loop with what the whole head left it, not its own
        // initializer: `let i = 0, c = (i = -1)` starts at -1, and `let i = k--`
        // ran its decrement once, in the head walk above
        const A = point(env.get(name))
        const Bv = cond[2] != null ? ev(cond[2]) : null, B = point(Bv)
        const delta = down ? null : stepDelta(step, name)
        const counts = A != null && !loopMutable(name) && !isReassigned(lbody, name) && !redeclaresName(lbody, name)
          && (cond[2] == null || boundInvariant(cond[2], lbody))
        if (counts && B != null && (down ? isUnitDecrement(step, name) : delta != null && delta > 0)) {
          iv = name
          ivStep = down ? -1 : delta
          range = down ? [cond[0] === '>' ? B + 1 : B, A]
            : [A, B - bias - (cond[0] === '<' ? 1 : 0)]
        }
        // (a counter stepped up toward a bound of a known most: the body runs at most this often)
        else if (counts && !down && delta > 0 && Bv && !Bv.nan && Number.isFinite(Bv.hi)) {
          const top = (cond[0] === '<' ? Math.ceil(Bv.hi) - 1 : Math.floor(Bv.hi)) - bias
          counter = name
          trips = top < A ? 0 : Math.floor((top - A) / delta) + 1
        }
      }
    }
    // Companion-IV theorem. If a positive cursor has one direct positive
    // increment in the loop body, its value BEFORE that increment is bounded
    // by the statically known trip count. This is deliberately a lexical
    // window: after the increment the theorem is removed, so `out[op+k]`
    // becomes raw while a post-increment access remains checked.
    const coupled = []
    const budgeted = []
    // Upper caps for cursors that also fall: every write inside the loop is
    // capped, no seed is set, and the loop fixpoint discovers the lower bound.
    const capped = []
    if (iv && range[0] <= range[1]) trips = Math.floor((range[1] - range[0]) / Math.abs(ivStep)) + 1
    if (iv && ivStep > 0 && range && range[0] <= range[1]) {
      const stmts = Array.isArray(lbody) && (lbody[0] === ';' || lbody[0] === '{}') ? lbody.slice(1) : [lbody]
      const writesTo = (root, name) => {
        let count = 0
        walkAst(root, { enter: x => {
          if (MUTATE_OPS.has(x[0])) {
            if (x[1] === name) count++
            else if (Array.isArray(x[1]) && x[1][0] !== '[]' && x[1][0] !== '.' && x[1][0] !== '?.') {
              const names = new Set(); collectNames(x[1], names)
              if (names.has(name)) count++
            }
          }
        } })
        return count
      }
      for (const incNode of stmts) {
        if (!Array.isArray(incNode)) continue
        const name = typeof incNode[1] === 'string' ? incNode[1] : null
        if (!name || name === iv || loopMutable(name) || redeclaresName(lbody, name)) continue
        let delta = null
        if (incNode[0] === '++') delta = 1
        else if (incNode[0] === '+=') delta = constInt(incNode[2])
        else if (incNode[0] === '=' && Array.isArray(incNode[2]) && incNode[2][0] === '+') {
          if (incNode[2][1] === name) delta = constInt(incNode[2][2])
          else if (incNode[2][2] === name) delta = constInt(incNode[2][1])
        }
        const entry = nrSpan(env.get(name))
        const h = entry && delta != null && delta > 0
          ? [entry[0], entry[1] + (trips - 1) * delta] : null
        if (inWord(h) && writesTo(lbody, name) === 1) coupled.push([name, nrInts(h[0], h[1]), incNode])
      }
      const changedNames = new Set()
      walkAst(lbody, { enter: x => {
        if (x[0] === '=>') return false
        if (MUTATE_OPS.has(x[0]) && typeof x[1] === 'string') changedNames.add(x[1])
      } })
      // Only build cursor budgets for names that actually feed a typed index
      // in this loop. The amortized path scanner is intentionally demand-
      // driven: running it for every pair of mutated scalar locals made the
      // compiler itself pay O(locals²) on unrelated arithmetic loops.
      const indexCaps = new Map()
      walkAst(lbody, { enter: x => {
        if (x[0] === '=>') return false
        if (x[0] === '[]' && typeof x[1] === 'string') {
          const L = lens(x[1])
          if (L != null) {
            const names = new Set(); collectNames(x[2], names)
            for (const name of names) if (changedNames.has(name)) {
              let a = indexCaps.get(name); if (!a) indexCaps.set(name, a = [])
              if (!a.includes(L)) a.push(L)
            }
          }
        }
      } })
      for (const name of changedNames) {
        const caps = indexCaps.get(name)
        if (!caps?.length) continue
        if (name === iv || loopMutable(name) || redeclaresName(lbody, name)) continue
        const entry = nrSpan(env.get(name)), maxAdvance = advanceBudget(lbody, name)
        let h = entry && entry[0] >= 0 && maxAdvance != null && maxAdvance > 0
          ? [entry[0], entry[1] + trips * maxAdvance] : null
        // Try every non-negative changed counter as an amortization credit;
        // keep only a strictly tighter, fully verified potential budget.
        if (h && caps.some(L => h[1] >= L)) for (const credit of changedNames) {
          if (credit === name || credit === iv || loopMutable(credit) || redeclaresName(lbody, credit)) continue
          const ce = nrSpan(env.get(credit))
          if (!ce || ce[0] < 0) continue
          const K = potentialAdvance(lbody, name, credit)
          const ph = K != null && K >= 0 ? [entry[0], entry[1] + ce[1] + trips * K] : null
          if (inWord(ph) && ph[1] < h[1]) h = ph
        }
        if (inWord(h)) budgeted.push([name, nrInts(h[0], h[1])])
        else if (entry) {
          // No decrement raises the cursor, so its rise stays budgeted when it also falls.
          const up = advanceBudget(lbody, name, true)
          const cap = up != null ? entry[1] + trips * up : null
          if (cap != null && cap <= I32_MAX) capped.push([name, capOnly(cap)])
        }
      }
    }
    // ACCUMULATORS: over a body that runs at most `trips` times, a name every
    // write of which steps it (`acc += a[i]`, `p = p + dx`) stays within its
    // entry and the trips times each way's most step; a Number stepped by
    // constants, on the binary grid their sums keep exact. Each step's numbers
    // are the passes' own, in flow (a read the walk holds in bounds there is
    // its element's); the bound meets the head invariant before the final pass.
    const accumulated = []
    if (trips > 0) for (const name of collectAssignedNames(lbody, new Set())) {
      const entry = env.get(name)
      if (name === iv || name === counter || loopMutable(name) || redeclaresName(lbody, name) || activeFacts.has(name) ||
          isReassigned(step, name) || isReassigned(cond, name) || !entry || entry.nan || !Number.isFinite(entry.lo) || !Number.isFinite(entry.hi)) continue
      walkAst(lbody, { enter: m => {
        if (m[0] === '=>') return false
        if (!MUTATE_OPS.has(m[0]) || m[1] !== name) return
        stepLog.set(m, undefined)
        // (`x = x ± v`, an arm of `x = c ? x + v : x - v`: v's numbers where the sum is taken)
        const arms = (r) => { if (!Array.isArray(r)) return; if (r[0] === '?:' && r.length === 4) { arms(r[2]); arms(r[3]) }
          else if (r.length === 3 && (r[0] === '+' || r[0] === '-') && (r[1] === name || r[0] === '+' && r[2] === name)) stepSide.set(r, [m, r[1] === name ? 2 : 1]) }
        if (m[0] === '=') arms(m[2])
      } })
      accumulated.push([name, entry])
    }
    // (a bound of every value in the loop: it caps the final pass's writes too)
    const bounded = new Map()
    const tighten = accumulated.length ? (joined) => {
      for (const [name, entry] of accumulated) {
        const h = accumulatedHull(lbody, name, entry, trips, (v, write) => stepLog.get(write) ?? null)
        if (!h) continue
        // (a theorem the loop already holds of the name, a cursor's budget, meets it)
        const prior = activeFacts.get(name)
        joined.set(name, joined.has(name) ? meet(joined.get(name), h) : h)
        bounded.set(name, prior); activeFacts.set(name, prior ? meet(prior, h) : h)
      }
    } : null
    // Body fixpoint (same engine as `while` below): the canonical-iv range is
    // a body-independent theorem re-seeded each pass; everything else
    // discovers its invariant. This is what proves heapsort's `child` chains,
    // medianUs's `samples[mid]`, and strided codec input/output cursors.
    // The condition sees the iv's HEAD range, one step past the body range
    // (the test that exits); the body sees the body range.
    const seeded = iv && inWord(range) && range[0] <= range[1] && !closureWrites.has(iv)
    const head = seeded ? (ivStep > 0 ? [range[0], range[1] + ivStep] : [range[0] - 1, range[1]]) : null
    const headRange = inWord(head) ? nrInts(head[0], head[1]) : null, bodyRange = seeded ? nrInts(range[0], range[1]) : null
    const priorCoupled = new Map(coupled.map(([name]) => [name, coupledEnv.get(name)]))
    const theorems = [...budgeted, ...capped]
    const priorFacts = new Map(theorems.map(([name]) => [name, activeFacts.get(name)]))
    for (const [name, h] of theorems) activeFacts.set(name, h)
    const seeds = () => {
      if (headRange) env.set(iv, headRange)
      else if (iv) env.delete(iv)
      for (const [name, h, incNode] of coupled) coupledEnv.set(name, { h, incNode })
      for (const [name, h] of budgeted) setEnv(name, h)
    }
    loopFixpoint(seeds,
      (afterCond) => {
        if (cond != null) visit(cond)
        if (seeded) env.set(iv, bodyRange)
        if (afterCond()) { visit(lbody); if (step != null) visit(step) }
      },
      cond, seeded, tighten)
    for (const [name, prior] of bounded) prior ? activeFacts.set(name, prior) : activeFacts.delete(name)
    if (accumulated.length) walkAst(lbody, { enter: m => { stepLog.delete(m); stepSide.delete(m) } })
    for (const [name] of theorems) {
      const prior = priorFacts.get(name)
      if (prior) activeFacts.set(name, prior)
      else activeFacts.delete(name)
    }
    // (the names the loop's own declaration makes are its own: none outlives it)
    if (Array.isArray(init) && init[0] === 'let') for (const name of decls.keys()) env.delete(name)
    else if (iv) env.delete(iv)
    for (const [name] of coupled) {
      const prior = priorCoupled.get(name)
      if (prior) coupledEnv.set(name, prior)
      else coupledEnv.delete(name)
    }
    return
  }
  const visitWhile = (n, wrapEntry) => {
    // `while (iv < B)` with a known iv at entry, monotone +1 advances, and a
    // bounded B: inside the body iv ∈ [entryLo, B_hi-1] (cond holds at body top);
    // at exit iv ∈ [min(entryLo, B_lo), max(entryHi, B_hi)] — the peel's split
    // loops chain through this. Anything else: kill and walk.
    const [, c, wbody] = n
    let iv = null, entry = null, brange = null
    if (Array.isArray(c) && c[0] === '<' && typeof c[1] === 'string' && wbody != null) {
      entry = nrSpan(env.get(c[1])); brange = c[2] != null ? nrSpan(ev(c[2])) : null
      if (entry && brange && !loopMutable(c[1]) && ivMonotoneInc(wbody, c[1]) && !redeclaresName(wbody, c[1])
          && boundInvariant(c[2], wbody)) iv = c[1]
    }
    // WRAPPING-CURSOR invariant (`si = si + K; if (si >= C) si = 0` — the ring
    // index of table-driven maps): the pair is self-closing on [0, C-1], so an
    // entry inside that range keeps the name there for the WHOLE loop. Seeded
    // before the kill; the pair must be the name's only writes in this loop.
    const wraps = [], symWraps = []
    if (wbody != null) {
      const stmts = Array.isArray(wbody) && (wbody[0] === ';' || wbody[0] === '{}') ? wbody : [';', wbody]
      // one-statement MASK cursor `nm = (nm + K) & M` (the ulam direction ring):
      // self-closing on [0, M] for any entry inside it — no reset pair needed
      for (let k = 1; k < stmts.length; k++) {
        const a2 = stmts[k]
        if (!(Array.isArray(a2) && a2[0] === '=' && typeof a2[1] === 'string')) continue
        let rhs = a2[2]
        if (!(Array.isArray(rhs) && rhs[0] === '&' && rhs.length === 3)) continue
        const M = intLiteralValue(rhs[1]) ?? intLiteralValue(rhs[2])
        const inner = intLiteralValue(rhs[1]) != null ? rhs[2] : rhs[1]
        if (M == null || M < 0) continue
        if (!(Array.isArray(inner) && inner[0] === '+' && (inner[1] === a2[1] || inner[2] === a2[1]))) continue
        const e0 = nrSpan(env.get(a2[1]))
        if (!e0 || e0[0] < 0 || e0[1] > M) continue
        let writes = 0
        walkAst(wbody, { enter: x => { if (MUTATE_OPS.has(x[0]) && x[1] === a2[1]) writes++ } })
        if (writes === 1 && !loopMutable(a2[1])) wraps.push([a2[1], nrInts(0, M)])
      }
      for (let k = 1; k < stmts.length - 1; k++) {
        const a2 = stmts[k], b2 = stmts[k + 1]
        let nm = null, K = null
        if (Array.isArray(a2) && a2[0] === '=' && typeof a2[1] === 'string'
            && Array.isArray(a2[2]) && a2[2][0] === '+' && a2[2][1] === a2[1]) { nm = a2[1]; K = intLiteralValue(a2[2][2]) }
        else if (Array.isArray(a2) && a2[0] === '+=' && typeof a2[1] === 'string') { nm = a2[1]; K = intLiteralValue(a2[2]) }
        else if (Array.isArray(a2) && a2[0] === '++' && typeof a2[1] === 'string') { nm = a2[1]; K = 1 }
        if (nm == null || K == null || K < 1) continue
        if (!(Array.isArray(b2) && b2[0] === 'if' && b2.length === 3
            && Array.isArray(b2[1]) && b2[1][0] === '>=' && b2[1][1] === nm
            && Array.isArray(b2[2]) && b2[2][0] === '=' && b2[2][1] === nm && intLiteralValue(b2[2][2]) === 0)) continue
        const C = constInt(b2[1][2])
        const Cname = C == null && typeof b2[1][2] === 'string' ? b2[1][2] : null
        if ((C == null || C < 1) && Cname == null) continue
        const e0 = nrSpan(env.get(nm))
        const prior = Cname && wrapEntry?.find(([name, h]) => name === nm && h.hiName === Cname)?.[1]
        if ((!e0 && !prior) || e0 && (e0[0] < 0 || (C != null && e0[1] > C - 1))) continue
        if (Cname && !boundInvariant(Cname, wbody)) continue
        // the pair must be the only writes (2 exact: the add and the reset)
        let writes = 0
        walkAst(wbody, { enter: x => { if (MUTATE_OPS.has(x[0]) && x[1] === nm) writes++ } })
        if (writes !== 2 || loopMutable(nm)) continue
        if (C != null) wraps.push([nm, nrInts(0, C - 1), nrInts(0, C - 1 + K)])
        // symbolic bound (`let SEQLEN = 5` — mutable): the invariant is
        // si ∈ [0, C-1] RELATIVE to C's runtime value — recorded as a symbolic
        // hull for reads BEFORE the increment (the versioning guard closes it
        // with `C ≥ entryHi+1 ∧ C ≤ len`); no numeric env seeding is possible
        else symWraps.push([nm, { lo: 0, hiName: Cname, hiBias: -1, entryHi: prior?.entryHi ?? e0[1] }, a2])
      }
    }
    // Every continuing body path advances the tested cursor. Its finite
    // trip budget also bounds signed additive recurrences, including the
    // increment's final landing. A possible zero advance proves no budget.
    const budgeted = []
    if (iv && constInt(c[2]) != null) {
      const changed = new Set()
      walkAst(wbody, { enter: x => {
        if (x[0] === '=>') return false
        if (MUTATE_OPS.has(x[0]) && typeof x[1] === 'string' && x[1] !== iv &&
            env.get(x[1]) && !loopMutable(x[1])) changed.add(x[1])
      } })
      const options = { constInt, evRange: evWord, closureWrites, MUTATE_OPS }
      const minimum = changed.size ? minAdvanceBudget(wbody, iv, options) : 0
      const trips = minimum > 0 ? Math.max(0, Math.ceil((brange[1] - entry[0]) / minimum)) : 0
      if (trips > 0) {
        let stepEnv
        const stepRange = e => {
          if (!stableRangeExpr(e)) return null
          if (!stepEnv) {
            stepEnv = new Map(env)
            for (const name of stepEnv.keys()) if (loopMutable(name) || isReassigned(wbody, name) || redeclaresName(wbody, name)) stepEnv.delete(name)
            for (const [name, h, whole = h] of wraps) stepEnv.set(name, whole)
            // A dependent write may follow this iteration’s increment. Its
            // operand needs the whole cursor lifetime, including that landing.
            const advance = maxAdvanceBudget(wbody, iv, options)
            const whole = advance > 0 ? [entry[0], Math.max(entry[1], brange[1] - 1 + advance)] : null
            if (inWord(whole)) stepEnv.set(iv, nrInts(whole[0], whole[1]))
          }
          const saved = env, wasRecording = recording
          env = stepEnv; recording = false
          try { return evWord(e) }
          finally { env = saved; recording = wasRecording }
        }
        for (const name of changed) {
          if (redeclaresName(wbody, name)) continue
          const start = nrSpan(env.get(name))
          if (!start) continue
          const advance = maxAdvanceBudget(wbody, name, options)
          let h = advance > 0 ? [start[0], start[1] + trips * advance] : null
          if (!inWord(h)) {
            const movement = maxMovementBudget(wbody, name, { ...options, evRange: stepRange })
            if (movement != null) h = [start[0] - trips * movement, start[1] + trips * movement]
          }
          if (inWord(h)) budgeted.push([name, nrInts(h[0], h[1])])
        }
      }
    }
    const priorFacts = new Map(budgeted.map(([name]) => [name, activeFacts.get(name)]))
    for (const [name, h] of budgeted) activeFacts.set(name, h)
    // Body fixpoint (loopFixpoint below): the wrap/symWrap seeds are theorems
    // independent of the body, re-applied each pass; the monotone iv's body
    // range (entry lo up to the bound, the test having held) applies after
    // the test; everything else discovers its invariant. Bounds heapsort's
    // `while (child < n)` chains, medianUs's downward insertion scan, and
    // interpreter `while (pc < N)` dispatch — shapes the single-kill walk
    // lost entirely.
    const seeds = () => {
      for (const [name, h] of budgeted) setEnv(name, h)
      for (const [nm, r] of wraps) if (!closureWrites.has(nm)) env.set(nm, r)
      for (const [nm, h, incNode] of symWraps) if (!closureWrites.has(nm)) symEnv.set(nm, { h, incNode })
    }
    loopFixpoint(seeds, (afterCond) => {
      visit(c)
      if (iv) env.set(iv, nrInts(entry[0], brange[1] - 1))
      if (afterCond()) for (let k = 2; k < n.length; k++) visit(n[k])
    }, c)
    for (const [name] of budgeted) {
      const prior = priorFacts.get(name)
      if (prior) activeFacts.set(name, prior)
      else activeFacts.delete(name)
    }
    // exit state: the head invariant where the test failed (already in env);
    // an iv stepping by more than one can pass its bound (`i += 2` exits at
    // B + 1), which the head invariant carries and a `[., B]` form did not.
    // Wraps publish their tighter exit forms.
    for (const [nm, r] of wraps) if (!closureWrites.has(nm)) env.set(nm, r)   // holds at exit too
    for (const [nm] of symWraps) symEnv.delete(nm)
    // The adjacent increment/reset pair also holds at exit. An unknown call
    // could change the bound; only call-free phases export that theorem.
    return symWraps.length && symWraps.every(([nm, h]) => !isReassigned(c, nm) && boundInvariant(h.hiName, c)) &&
      !some(c, x => x[0] === '()' && x.length > 2) && !some(wbody, x => x[0] === '()' && x.length > 2) ? symWraps : null
  }
  const visit = (n, wrapEntry = null) => {
    steps++
    if (typeof n === 'string') { recordBinding(n, closureWrites.has(n) ? null : env.get(n)); return }
    if (!Array.isArray(n) || n[0] === '=>') return
    if (n[0] == null || n[0] === 'str') return
    if (n[0] === '.' || n[0] === '?.') { visit(n[1]); return }
    if (n._rangeFacts) return visitWithFacts(n)
    const op = n[0]
    if (values?.has(n)) {
      // (an object literal's field values, in order; a member write's stored number)
      const parsed = op === '{}' ? staticObjectProps(n.slice(1)) : null
      if (parsed) { recordValue(n, parsed.values.map(v => ev(v))); return }
      if (MUTATE_OPS.has(op) && Array.isArray(n[1])) { visit(n[1]); recordValue(n, ev(effectiveWriteValue(op, n[1], n[2]))); return }
    }
    if (op === ';' || op === '{}') {
      let prior = null
      for (let i = 1; i < n.length; i++) {
        const st = n[i], next = visit(st, prior)
        if (next) prior = next
        // A wrap invariant survives independent, effect-free declarations
        // between consecutive loop phases. Branches and calls drop it.
        else if (prior && Array.isArray(st) && (st[0] === 'let' || st[0] === 'const') &&
            st.slice(1).every(d => typeof d === 'string' || Array.isArray(d) && d[0] === '=' && pureExpr(d[2])) &&
            prior.every(([name, h]) => !redeclaresName(st, name) && !redeclaresName(st, h.hiName))) continue
        else prior = null
      }
      return
    }
    // Scalar analysis has explicit consumers. An unrelated loop contributes
    // only unknown writes; do not allocate widening states that nobody reads.
    // A loop that writes a name declared outside it is no unrelated one: what
    // follows reads the value it leaves (the index a scan keeps, a cursor).
    if (needed && !needed.has(n) && (op === 'for' || op === 'while') && !writesOuter(n)) {
      killAssigned(n)
      for (const name of env.keys()) if (ctx.scope?.globalTypes?.has(name)) { invalidateBool(name); env.delete(name) }
      symEnv.clear(); coupledEnv.clear()
      return
    }
    if (op === '[]' && n.length === 3 && typeof n[1] === 'string') {
      visit(n[1])
      const idxV = ev(n[2]), idx = indexSpan(idxV)
      const L = lens(n[1])
      const proven = L != null && !!idx && idx[1] < L
      if (!recording) return proven   // exploratory fixpoint pass: env effects only
      const k = out || ranges ? idxKey(n[1], n[2]) : null
      if (!proven) {
        if (out) { rejected.add(k); out.delete(k); rejectedNodes.add(n); out.delete(n) }
        if (misses && L != null) {
          const s = nrSpan(idxV), w = inWord(s) ? s : null
          const prev = misses.get(n), lo = w ? w[0] : null, hi = w ? w[1] : null
          misses.set(n, prev ? [prev[0] == null || lo == null ? null : Math.min(prev[0], lo), prev[1] == null || hi == null ? null : Math.max(prev[1], hi), L] : [lo, hi, L])
        }
      }
      else if (out) {
        if (!rejected.has(k)) out.add(k)
        if (!rejectedNodes.has(n)) out.add(n)
      }
      // A bounded idx against an UNKNOWN length is half a proof — export the hull
      // (joined over every sighting of this key) for the versioning guard to close
      // with a runtime `hi < len` conjunct (the wrap-cursor + dynamic-table class).
      // Provisional guard-seeded hulls stay local; structural export would let
      // one guarded occurrence bless an unrelated same-key access.
      if (ranges) {
        const h = !guardProofContext ? idx
          ?? (idxV == null && typeof n[2] === 'string' ? symEnv.get(n[2])?.h : null) : null
        const prev = ranges.get(k)
        ranges.set(k, !ranges.has(k) ? h ?? null : !prev || !h ? null
          : Array.isArray(prev) && Array.isArray(h)
            ? [Math.min(prev[0], h[0]), Math.max(prev[1], h[1])]
            : prev.hiName && prev.hiName === h.hiName && prev.hiBias === h.hiBias
              ? { ...h, lo: Math.min(prev.lo, h.lo), entryHi: Math.max(prev.entryHi, h.entryHi) } : null)
      }
      return proven
    }
    if (op === 'let' || op === 'const') {
      for (let k = 1; k < n.length; k++) {
        const d = n[k]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
          const v = ev(d[2])
          setEnv(d[1], v)
          recordWrite(d, v)
          // Bare-name conditions resolve through stable, single-assignment guards.
          if (op === 'const' && Array.isArray(d[2]) && RANGE_GUARD_OPS.has(d[2][0]) && stableRangeExpr(d[2])) {
            const free = new Set(); collectNames(d[2], free)
            if (![...free].some(f => closureWrites.has(f))) boolDefs.set(d[1], { def: d[2], free })
          }
        }
        // (a bare declaration holds undefined: no number, unless the summary holds
        // the binding to numbers, assigned on every path before a read: a read
        // before the walk knows a write poisons it then)
        else if (typeof d === 'string') { invalidateBool(d); env.delete(d); if (ctx.summary?.at(ctx.func.current)?.bindingKindOf(d) !== NUMBER) recordBinding(d, null) }
        else if (Array.isArray(d)) { visit(d); const s = new Set(); collectNames(d[0] === '=' ? d[1] : d, s); for (const x of s) { invalidateBool(x); env.delete(x); recordBinding(x, null) } }
      }
      return
    }
    if (op === '=' && typeof n[1] === 'string') {
      if (symEnv.get(n[1])?.incNode === n) symEnv.delete(n[1])   // past the increment: window closed
      if (coupledEnv.get(n[1])?.incNode === n) coupledEnv.delete(n[1])
      const v = ev(n[2])
      setEnv(n[1], v)
      recordWrite(n, v)
      if (assigned.length) noteAssigned(n[1], true)
      return
    }
    if (stores?.has(n) && op === '=' && Array.isArray(n[1]) && n[1][0] === '[]') {
      visit(n[1])
      const value = wordSpan(ev(n[2]))
      if (recording) {
        const prev = stores.get(n)
        stores.set(n, prev === undefined ? value : prev && value
          ? [Math.min(prev[0], value[0]), Math.max(prev[1], value[1])] : null)
      }
      return
    }
    if (MUTATE_OPS.has(op)) {
      if (typeof n[1] === 'string' && symEnv.get(n[1])?.incNode === n) symEnv.delete(n[1])
      if (typeof n[1] === 'string' && coupledEnv.get(n[1])?.incNode === n) coupledEnv.delete(n[1])
      if (typeof n[1] === 'string') {
        // `x += K` / `x -= K` / `x++` / `x--` transfer exactly — a strided
        // accumulator keeps a computable back-edge for the loop fixpoint
        // (cond-clamped by the widening join); anything else is unknown
        const cur = valueOf(n[1])
        let nv = null
        if (op === '++' || op === '--') nv = cur && nrBinary(op === '++' ? '+' : '-', cur, nrPoint(1))
        else if (op === '+=' || op === '-=') { const a = ev(n[1]), v = ev(n[2]); logStep(n, v); nv = nrBinary(op[0], a, v) }
        else if (ARITH.has(op.slice(0, -1))) nv = ev([op.slice(0, -1), n[1], n[2]])
        else for (let k = 2; k < n.length; k++) visit(n[k])
        setEnv(n[1], nv)
        recordWrite(n, nv)
        if (assigned.length) noteAssigned(n[1], false)
      }
      else {
        visit(n[1])   // records the member-write access proof (`out[idx] = …`)
        for (let k = 2; k < n.length; k++) visit(n[k])
        if (Array.isArray(n[1]) && n[1][0] !== '[]' && n[1][0] !== '.' && n[1][0] !== '?.') {
          const s = new Set(); collectNames(n[1], s); for (const x of s) { invalidateBool(x); env.delete(x); recordBinding(x, null) }
        }
      }
      return
    }
    if (op === 'break' || op === 'continue') {
      if (typeof n[1] === 'string') {   // labeled: may cross frames — feed every open one
        for (const fr of loopStack) { fr.breaks.push(new Map(env)); fr.continues.push(new Map(env)) }
      }
      else if (op === 'break') {
        loopStack.at(-1)?.breaks.push(new Map(env))
      }
      else {
        loopStack.at(-1)?.continues.push(new Map(env))
      }
      return
    }
    if (op === 'for' && n.length === 5) return visitFor(n)
    if (op === 'while') return visitWhile(n, wrapEntry)
    if (op === 'label' || op === 'catch' || op === 'finally') {
      // ('try' is the parser shape; prepare lowers it to 'catch'/'finally' nodes,
      // which is what this walk actually receives)
      killAssigned(n)   // branch selection: no interval survives entry
      // Each child walks from the killed entry state and the construct EXITS at
      // it: an exception can leave a `try` child mid-statement — so neither a
      // sibling's nor the last child's flow state is the construct's. In-child
      // straight-line proofs (defined-before-use chains) still record.
      const killed = new Map(env)
      // label/try: transparent — abrupt edges bind to enclosing frames
      for (let k = 1; k < n.length; k++) {
        visit(n[k])
        env.clear(); for (const [k2, v2] of killed) env.set(k2, v2)
      }
      return
    }
    if (op === 'if') {
      const [, c, thenB, elseB] = n
      visit(c)
      const save = new Map(env)
      // every `&&` conjunct holds on the then path (`if (child+1 < n && a[child] <
      // a[child+1]) child++` — the ++ under BOTH bounds)
      const namedGuard = typeof c === 'string' && boolDefs.has(c)
      // An arm its test rules out from this state never runs: it is not walked
      // and the other arm's state is the exit.
      const thenDead = impossible(c, false), elseDead = !thenDead && impossible(c, true)
      const thenRefs = thenDead ? [] : refineAll(c, namedGuard)
      for (const rT of thenRefs) if (!closureWrites.has(rT[0])) env.set(rT[0], rT[1])
      if (!thenDead) underGuardProof(namedGuard && thenRefs.length, () => visit(thenB))
      const afterThen = env
      env = save
      // the fall-through state refines by ¬cond whether or not an else arm exists
      // (`if (xi >= 64) xi = 63` leaves xi < 64 on the other path)
      const rE = elseDead ? null : refine(c, true)
      if (rE && !closureWrites.has(rE[0])) env.set(rE[0], rE[1])
      if (elseB !== undefined && !elseDead) visit(elseB)
      // Only normally completing arms reach the following statement. A base
      // case's return/throw must not erase the recursive step's live guard, and
      // an arm that breaks or continues leaves its state where it jumps
      // (`if (k < 1) { …; break }` holds k >= 1 after it).
      if (thenDead || alwaysLeaves(thenB)) return
      if (elseDead || alwaysLeaves(elseB)) { env = afterThen; return }
      // join: both arms merge (min lo, max hi); known-in-one-arm-only joins unknown
      hullInto(afterThen)
      return
    }
    if (op === '?:') { ev(n); return }
    // Short-circuit operands evaluate under the left side's verdict: `&&`'s rhs
    // runs only where lhs HELD (`child + 1 < n && a[child] < a[child + 1]` — the
    // lookahead read is bounds-guarded by its sibling conjunct), `||`'s rhs only
    // where lhs FAILED. Reads inside the rhs prove under that refinement; writes
    // there ran conditionally, so the exit state joins both possibilities.
    if ((op === '&&' || op === '||' || op === '??') && n.length === 3) { ev(n); return }
    if (op === '()' || op === 'new') {   // a call may reassign module globals
      if (calls?.has(n) && op === '()') {
        visit(n[1])
        const args = []
        for (const arg of callArgs(n)) args.push(ev(arg))
        if (recording) {
          const prev = calls.get(n)
          calls.set(n, prev ? args.map((v, k) => v && prev[k] ? nrJoin(v, prev[k]) : null) : args)
        }
      } else for (let k = 1; k < n.length; k++) visit(n[k])
      for (const [name, bd] of boolDefs) {
        for (const free of bd.free) if (ctx.scope?.globalTypes?.has?.(free)) { boolDefs.delete(name); break }
      }
      for (const [k2] of env) if (!closureWrites.has(k2) && (ctx.scope?.globalTypes?.has?.(k2) || ctx.func?.typedElem?.has?.(k2))) {
        invalidateBool(k2); env.delete(k2)
      }
      return
    }
    for (let k = 1; k < n.length; k++) visit(n[k])
  }
  // the function root is itself an `=>` node — enter its body; only NESTED closures skip
  // A rewrite pass (peelClampedStencil) stamps `_rangeFacts` — theorems about names
  // inside the stamped subtree (`ci ∈ [0, bound-1]`, established by ITS soundness
  // argument). They intersect every env write of that name while the subtree walks.
  const visitWithFacts = (n) => {
    const popped = []
    for (const [name, boundName] of n._rangeFacts) {
      const B = boundName != null ? nrSpan(ev(boundName)) : null
      if (B && !activeFacts.has(name)) { activeFacts.set(name, nrInts(0, B[1] - 1)); popped.push(name) }
    }
    const facts = n._rangeFacts
    n._rangeFacts = null   // re-entry brake (the self-compile subset has no delete)
    visit(n)
    n._rangeFacts = facts
    for (const name of popped) activeFacts.delete(name)
  }
  visit(Array.isArray(body) && body[0] === '=>' ? body[body.length - 1] : body)
}

/** Per-iteration motion of `name` in a loop body: P/N bound all its positive and
 *  negative steps, intermediate values among them. Each direction is bounded
 *  alone (a continue or a short circuit can skip an opposing step). Nested
 *  loops writing it, resets and shadows reject. `rangeOf(value, write)` gives a
 *  step's [lo, hi] over the loop. */
export function collectStepRange(node, name, rangeOf, unit = 1) {
  if (!Array.isArray(node)) return { P: 0, N: 0 }
  const op = node[0]
  if (MUTATE_OPS.has(op) && node[1] === name) {
    if (op === '++') return { P: unit, N: 0 }
    if (op === '--') return { P: 0, N: unit }
    if (op === '+=' || op === '-=') {
      if (refsName(node[2], name, REFS_IN_EXPR)) return null
      const r = rangeOf(node[2], node)
      if (!r) return null
      const lo = op === '+=' ? r[0] : -r[1], hi = op === '+=' ? r[1] : -r[0]
      return { P: Math.max(0, hi), N: Math.max(0, -lo) }
    }
    if (op === '=') return assignedStepRange(node[2], name, rangeOf, node)
    return null
  }
  if (op === 'let' || op === 'const') {
    let P = 0, N = 0
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (d === name) return null                                     // bare uninitialized shadow decl
      if (Array.isArray(d) && d[1] === name) return null               // shadow: a fresh `name` rebinds here
      if (Array.isArray(d) && d[0] === '=') {
        const s = collectStepRange(d[2], name, rangeOf, unit)
        if (s == null) return null
        P += s.P; N += s.N
      }
    }
    return { P, N }
  }
  if (op === 'if' || op === '?:') {
    const c = collectStepRange(node[1], name, rangeOf, unit)
    if (c == null || c.P || c.N) return null   // a write to `name` inside the CONDITION itself: reject, too exotic
    const t = collectStepRange(node[2], name, rangeOf, unit)
    const e = node.length > 3 && node[3] !== undefined ? collectStepRange(node[3], name, rangeOf, unit) : { P: 0, N: 0 }
    if (t == null || e == null) return null
    return { P: Math.max(t.P, e.P), N: Math.max(t.N, e.N) }
  }
  if (op === 'for' || op === 'while' || op === '=>')
    return refsName(node, name, REFS_IN_EXPR) ? null : { P: 0, N: 0 }
  let P = 0, N = 0
  for (let i = 1; i < node.length; i++) {
    const s = collectStepRange(node[i], name, rangeOf, unit)
    if (s == null) return null
    P += s.P; N += s.N
  }
  return { P, N }
}

// Assignment spelling of an additive recurrence. Every chosen arm must retain
// the old value exactly once; no reassignment or extra self-read may hide in
// the condition or the increment.
function assignedStepRange(node, name, rangeOf, write) {
  if (node === name) return { P: 0, N: 0 }
  if (!Array.isArray(node)) return null
  if (node[0] === '?:') {
    if (isReassigned(node[1], name)) return null
    const a = assignedStepRange(node[2], name, rangeOf, write), b = assignedStepRange(node[3], name, rangeOf, write)
    return a && b ? { P: Math.max(a.P, b.P), N: Math.max(a.N, b.N) } : null
  }
  const op = node[0], left = node[1] === name
  if (node.length !== 3 || !(op === '+' && (left || node[2] === name) || op === '-' && left)) return null
  const value = node[left ? 2 : 1]
  if (refsName(value, name, REFS_IN_EXPR)) return null
  const r = rangeOf(value, write)
  if (!r) return null
  const lo = op === '+' ? r[0] : -r[1], hi = op === '+' ? r[1] : -r[0]
  return { P: Math.max(0, hi), N: Math.max(0, -lo) }
}

// The numbers `name` takes in a loop body run at most `trips` times from
// `entry`, each write a step (collectStepRange): integers by integer steps
// exactly; a Number by constant steps on a binary grid. Rounded additions are
// monotone, and integral grid ends with outward-rounded steps stay exact while
// their scaled magnitude fits the safe integers, so the grid bounds the
// recurrence without replacing it by its start plus trips times its step.
function accumulatedHull(body, name, entry, trips, stepNumbers) {
  if (!Number.isSafeInteger(trips)) return null
  if (entry.int) {
    const s = collectStepRange(body, name, (n, w) => { const v = stepNumbers(n, w); return v && v.int && !v.nan && Number.isFinite(v.lo) && Number.isFinite(v.hi) ? [v.lo, v.hi] : null })
    if (s) {
      const lo = entry.lo - trips * s.N, hi = entry.hi + trips * s.P
      return Number.isSafeInteger(lo) && Number.isSafeInteger(hi) ? nrValue(lo, hi, true, false, false) : null
    }
  }
  const constant = (n, w) => { const v = stepNumbers(n, w); return v && !v.nan && v.lo === v.hi && Number.isFinite(v.lo) ? v.lo : null }
  const enclose = scale => {
    const s = collectStepRange(body, name, (n, w) => { const v = constant(n, w); return v == null ? null : [Math.floor(v * scale), Math.ceil(v * scale)] }, scale)
    if (!s) return null
    const down = trips * s.N, up = trips * s.P, lo = Math.floor(entry.lo * scale) - down, hi = Math.ceil(entry.hi * scale) + up
    return [down, up, lo, hi].every(Number.isSafeInteger) ? [lo / scale, hi / scale] : null
  }
  const coarse = enclose(1)
  if (!coarse) return null
  let scale = 1
  const magnitude = Math.max(1, Math.abs(coarse[0]), Math.abs(coarse[1]))
  while (scale < 0x100000000 && magnitude * scale < 2 ** 50) scale *= 2
  const h = enclose(scale)
  return h && nrValue(h[0], h[1], false, false, false)
}

/** Every write to `iv` in `node` is a strictly-positive unit step (++iv / iv+=1 /
 *  iv=(iv+1)|0 / iv=iv+1) — the while-iv interval model requires monotone advance. */
function ivMonotoneInc(node, iv) {
  if (!Array.isArray(node)) return true
  if ((node[0] === '++' || node[0] === '--') && node[1] === iv) return node[0] === '++'
  if (WRITE_OPS.has(node[0]) && node[1] === iv) {
    if (node[0] === '+=' && intLiteralValue(node[2]) >= 1) return true
    if (node[0] === '=') {
      let rhs = node[2]
      if (Array.isArray(rhs) && rhs[0] === '|' && intLiteralValue(rhs[2]) === 0) rhs = rhs[1]
      if (Array.isArray(rhs) && rhs[0] === '+' && rhs.length === 3
          && ((rhs[1] === iv && intLiteralValue(rhs[2]) >= 1) || (rhs[2] === iv && intLiteralValue(rhs[1]) >= 1))) return true
    }
    return false
  }
  for (let k = 1; k < node.length; k++) if (!ivMonotoneInc(node[k], iv)) return false
  return true
}
// The numbers an integer element of a typed array holds: its width's, signed or not.
const elementNumbers = (ctor) => {
  const aux = typedElemAux(ctor)
  if (aux == null || (aux & 7) > 5 || aux & (TYPED_ELEM_F16_FLAG | TYPED_ELEM_BIGINT_FLAG)) return null
  const bits = 8 << ((aux & 7) >> 1)
  return aux & 1 ? nrInts(0, 2 ** bits - 1) : nrInts(-(2 ** (bits - 1)), 2 ** (bits - 1) - 1)
}

/** The element counts and the parameters' ranges of the current function: the
 *  lens and entry state of its walks. */
export const functionLens = (name) => ctx.func.typedLen?.get(name) ?? ctx.scope?.globalTypedLen?.get(name)
  ?? ctx.func.localReps?.get(name)?.arrayLen ?? null
export function paramEntry() {
  const entry = new Map()
  for (const p of ctx.func.current?.params || []) entry.set(p.name, ctx.func.localReps?.get(p.name)?.range ?? null)
  return entry
}

/** Memoized per-function set of interval-proven `recv[idx]` keys (AdHocMemo
 *  retirement — see inBoundsCharCodeAt's comment for the WeakMap idiom, here
 *  getFactStore().ipProven/ipRanges, always populated together). */
export function intervalProvenIdx(ctx) {
  const body = ctx.func?.body
  if (!Array.isArray(body)) return NO_INTERVAL_PROVEN
  const cache = getFactStore().ipProven
  const hit = cache.get(body)
  if (hit) return hit
  return collectIntervalProof(ctx, body, cache)
}

function collectIntervalProof(ctx, body, cache) {
  const out = new Set(), ranges = new Map()
  scanIntervalIdx(body, functionLens, { out, ranges, entry: paramEntry() })
  cache.set(body, out)
  getFactStore().ipRanges.set(body, ranges)
  return out
}

/** The unproven access nodes of a function body (the current one by default)
 *  with their index hulls (scanIntervalIdx `misses`), from a fresh walk. */
export function intervalMisses(ctx, body = ctx.func?.body) {
  const misses = new Map()
  if (Array.isArray(body)) scanIntervalIdx(body, functionLens, { entry: paramEntry(), misses })
  return misses
}

/** What each write in `body` stores, by node, where every name `assume(name)`
 *  answers holds that value wherever the walk knows no more of it (`own`: the
 *  flow's own parameters, a closure's). A write the walk does not reach is absent. */
export function writtenNumbers(body, assume, own = null) {
  const written = new Map()
  scanIntervalIdx(body, () => null, { entry: paramEntry(), written, assume, own })
  return written
}

/** The numbers each local and parameter of `func` holds over its lifetime,
 *  walked in a frame of its own: a plan's question, ahead of emission. */
export function bindingNumbers(func) {
  const bindings = new Map()
  walkAst(func.body, { enter: n => {
    if (n[0] === '=>') return false
    if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
      const d = n[i], name = typeof d === 'string' ? d : Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' ? d[1] : null
      if (name) bindings.set(name, undefined)
    }
  } })
  for (const p of func.sig.params) bindings.set(p.name, undefined)
  const prev = enterActiveFunction(ctx, { sig: func.sig, body: func.body })
  try { scanIntervalIdx(func.body, () => null, { entry: paramEntry(), bindings }) } finally { restoreActiveFunction(ctx, prev) }
  return bindings
}

/** The flows the bindings `names` are written in, from `roots` ([{ body, sig,
 *  current }]: `current` walks in the active function's frame, with its local
 *  facts): each root, and each closure inside one (a flow of its own, which
 *  runs whenever it is called, its parameters its own), with the names it
 *  writes. `unvalued`: a name a pattern or a loop head writes, which no walk
 *  values; `bare`: a name declared with no initializer (undefined until a
 *  write). A declaration of a name counts as a write of it (a shadow holds no less). */
export function bindingFlows(roots, names) {
  const flows = [], unvalued = new Set(), bare = new Set()
  const drop = (n) => someDeep(n, x => { if (typeof x === 'string' && names.has(x)) unvalued.add(x); return false })
  const gather = (root, sig, own, current) => {
    const writes = new Set()
    walkAst(root, { enter: n => {
      if (n[0] === '=>') {
        const params = []
        someDeep(n[1], x => { if (typeof x === 'string') params.push(x); return false })
        gather(n[2], sig, params, current)
        return false
      }
      if (MUTATE_OPS.has(n[0])) {
        if (typeof n[1] === 'string') { if (names.has(n[1])) writes.add(n[1]) }
        else if (Array.isArray(n[1]) && n[1][0] !== '[]' && n[1][0] !== '.' && n[1][0] !== '?.') drop(n[1])
      }
      else if (n[0] === 'for' && Array.isArray(n[1]) && (n[1][0] === 'of' || n[1][0] === 'in')) drop(n[1][1])
      else if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (Array.isArray(d) && d[0] === '=') { if (typeof d[1] === 'string') { if (names.has(d[1])) writes.add(d[1]) } else drop(d[1]) }
        else if (typeof d === 'string' && names.has(d)) bare.add(d)
      }
    } })
    if (writes.size) flows.push({ body: root, sig, own, current, writes })
  }
  for (const { body, sig, current = false } of roots) gather(body, sig, null, current)
  return { flows, unvalued, bare }
}

/** The numbers each binding of `start` holds over every flow that writes it
 *  (`flows`, bindingFlows'), as a rung: a word (WORD_VALUE), an integer
 *  wherever finite (WHOLE_VALUE), or none (absent from the result). `start`
 *  maps each name to the highest rung it may take. A greatest fixpoint down
 *  that chain: every flow is walked under the hypothesis that each name still
 *  standing holds its rung wherever the walk knows no more of it (a call's or
 *  a closure's writes notwithstanding), and a write the walk values below a
 *  rung lowers it; a write no walk values is the caller's to remove first, and
 *  one of `exempt` stores no wider than its binding holds (a step a loop test
 *  bounds: type/bounded-counters.js). */
export function flowNumbers(flows, start, exempt = null) {
  const held = new Map(start)
  const assume = name => held.get(name)
  for (let lowered = true; lowered && held.size;) {
    lowered = false
    for (const { body, sig, own, current, writes } of flows) {
      let live = false
      for (const name of writes) if (held.has(name)) { live = true; break }
      if (!live) continue
      const prev = current ? null : enterActiveFunction(ctx, { sig, body })
      let written
      try { written = writtenNumbers(body, assume, own) } finally { if (!current) restoreActiveFunction(ctx, prev) }
      for (const [node, v] of written) {
        const name = node[1], h = held.get(name)
        if (!h || exempt?.has(node) || (h === WORD_VALUE ? nrWord(v) : !!v?.whole)) continue
        if (h === WORD_VALUE && v?.whole) held.set(name, WHOLE_VALUE)
        else held.delete(name)
        lowered = true
      }
    }
  }
  return held
}
export { WORD_VALUE }

/** Drop the memoized proofs of a body rewritten in place. */
export function invalidateIntervalProof(body) {
  if (body && typeof body === 'object') { getFactStore().ipProven.delete(body); getFactStore().ipRanges.delete(body) }
}

/** Idx-interval hulls the walk computed but could not discharge (receiver length
 *  unknown) — the versioning guard closes them with a runtime `hi < len`. */
export function intervalIdxRanges(ctx) {
  intervalProvenIdx(ctx)
  const body = ctx.func?.body
  return getFactStore().ipRanges.get(body) || NO_INTERVAL_RANGES
}
const NO_INTERVAL_RANGES = new Map()
const NO_INTERVAL_PROVEN = new Set()
