/**
 * The loop-unroll machinery (freshenUnrolledScalarBindings, unrollSmallConstFor, forInBodyCost, unrollForIn, extractHoistableLiterals, ...), emitLoopFreshBoxed (public) plus the if/for/while/label/break/continue emitter properties. 'for' alone is the single biggest AST-op handler in the file.
 *
 * @module compile/emit/control-flow
 */

import { encodePtrHi, i64Hex, TYPED_ELEM_VIEW_FLAG, TYPED_ELEM_ANY_VIEW_FLAG } from '../../../layout.js'
import { enumKeys } from '../../../module/schema.js'
import {
  T, MUTATE_OPS, constLiteralHoistable, hasLabeledContinueTo, hasOwnBreakOrContinue, hasOwnContinue, isConstLiteral, isReassigned, collectBareRefs, some, walkAst,
isArrayIndexKey, RELATIONAL_OPS } from '../../ast.js'
import { LAYOUT, PTR, ctx, err, inc, getFactStore } from '../../ctx.js'
import {
  asF64, asI32, freshId, isBoundName, isGlobal, isLit, isNullish, litVal, readVar, temp, tempI32, tempI64, truthyIR, typed, undefExpr,
} from '../../ir.js'
import { durableArrSnapNode, hasDurableReset } from '../../../module/collection/durable.js'
import { VAL, lookupValType, repOf, repOfGlobal } from '../../reps.js'
import { constIntExpr, constNumExpr, intExprRange, intLiteralValue, counterInit, mulRangesKeepZeroSign, nameShift } from '../../static.js'
import { loopFacts, counterRefinements, testRefinements } from '../loop-model.js'
import {
  MAX_NESTED_FOR_UNROLL, MAX_SMALL_FOR_UNROLL, SLOT_OPS, cloneWithSubst, containsDeclOf, containsKnownTypedArrayIndex, containsNestedClosure, containsNestedLoop, exprType, idxKey, nestedSmallLoopBudget, smallConstForTripCount, versionableTypedNest,
} from '../../type.js'
import { withControlFrame, withPendingLabel, withSchemaSpeculation } from '../flow-state.js'
import { extractRefinements, inferSchemaBranch, mergeRefinement, withRefinements } from '../flow-types.js'
import { plannedTypedStorageInfo } from '../typed-storage-plan.js'
import { emit, emitVoid, markDropped, provedPresent, toBool } from './dispatch.js'
import { loopGuardHi } from './i32-bounds.js'
import { emitFinalizers } from './statements.js'
import { isNullable } from '../../summary/kind.js'
import { runsAccessor, runsConversion } from '../../evaluation-effects.js'


// Flow-sensitive type refinement moved to ./flow-types.js (extractRefinements,
// predicateRefinement, mergeRefinement, withRefinements). emit.js imports them
// from there — see the import block at the top of this file.

// Preserve the per-iteration SSA shape of block-scoped scalar scratch when a
// small loop is expanded. Reusing one wasm local for every unrolled `const x`
// makes it multi-def; LICM must then conservatively leave expressions such as
// `x*x + y*y` in an enclosing hot loop. Native optimizers retain one SSA value
// per source iteration and hoist each expression. Since closures are rejected
// by unrollSmallConstFor, a loop-body let/const binding has no observable
// identity across iterations and each emitted copy may use a fresh wasm local.
//
// Rename the already-emitted IR rather than the AST: analysis and all typed/
// schema proofs still run under the original binding, while the final scalar
// IR exposes independent defs to LICM. Pointer-shaped locals are excluded —
// their name can key side metadata (flat slots/schema/typed ctor); this pass is
// specifically for numeric/boolean scratch.
function freshenUnrolledScalarBindings(body, ir) {
  if (ctx.transform.optimize?.splitScratch !== true) return ir
  const names = new Set()
  walkAst(body, {
    boundary: (n) => n[0] === '=>',
    enter: (n) => {
      if (n[0] === 'let' || n[0] === 'const') {
        for (let i = 1; i < n.length; i++) {
          const d = n[i]
          const name = Array.isArray(d) && d[0] === '=' ? d[1] : d
          if (typeof name === 'string') names.add(name)
        }
      }
    },
  })
  if (!names.size) return ir

  const rename = new Map()
  for (const name of names) {
    const type = ctx.func.locals.get(name)
    if (type !== 'i32' && type !== 'f64' && type !== 'i64' && type !== 'f32') continue
    if (ctx.func.boxed?.has(name) || ctx.func.flatObjects?.has(name) ||
        ctx.func.typedElem?.has(name)) continue
    const rep = ctx.func.localReps?.get(name)
    if (rep?.val != null && rep.val !== VAL.NUMBER && rep.val !== VAL.BOOL) continue
    const fresh = `${T}us${freshId(ctx)}_${name}`
    ctx.func.locals.set(fresh, type)
    rename.set(`$${name}`, `$${fresh}`)
  }
  if (!rename.size) return ir

  return renameScalarBindings(ir, rename)
}

function renameScalarBindings(ir, rename) {

  // Lowering link upkeep (src/ir/control.js; found via its own shadow-assert,
  // vectorize.js's assertLoopPlanAgrees): this rename mutates local names IN
  // PLACE on the ALREADY-linked block node the nested loop's own 'for' emission
  // linked. The block's IDENTITY survives (same array), so its link still resolves
  // it, but its `lowering.ivName`/`lowering.guardName` (captured pre-rename) would go STALE if a
  // renamed name was the loop's own induction/guard variable — exactly the small-const-unrolled-
  // outer-loop-with-nested-loop shape (`splitScratch`'s only use case). Keep the fact accurate
  // rather than evict it: a `block` descendant with a link gets its `lowering` name fields
  // carried through the SAME rename map — `plan` (the frozen HIR-side facts) is NEVER touched
  // (a rename is backend metadata, not a fact HIR proved). Metadata-only —
  // never touches `ir`'s own content, so this cannot affect emitted bytes.
  const rewrite = n => walkAst(n, {
    enter: (node) => {
      if ((node[0] === 'local.get' || node[0] === 'local.set' || node[0] === 'local.tee') && rename.has(node[1]))
        node[1] = rename.get(node[1])
      else if (node[0] === 'block') {
        const link = ctx.plans.loweringLinks.get(node)
        if (link) {
          const { lowering } = link
          const ivKey = lowering.ivName != null ? `$${lowering.ivName}` : null
          if (ivKey && rename.has(ivKey)) lowering.ivName = rename.get(ivKey).slice(1)
          const gKey = lowering.guardName != null ? `$${lowering.guardName}` : null
          if (gKey && rename.has(gKey)) lowering.guardName = rename.get(gKey).slice(1)
        }
      }
    },
  })
  for (const n of ir) rewrite(n)
  return ir
}

// A bounds guard can establish storage width for its fast arm without changing
// the checked arm's Number locals. Only private declarations and stable entry
// snapshots enter this map: no writeback or exceptional exit can expose a copy.
// (the Numbers an enclosing fast arm holds as words: an inner arm takes them to its own word anew)
const convertingWords = new Set()
function emitGuardedWords(words, emitArm) {
  if (!words?.size) return emitArm()
  const locals = ctx.func.locals, reps = ctx.func.localReps, saved = new Map(), rename = new Map(), entry = [], converted = []
  for (const [name, proof] of words) {
    saved.set(name, [locals.get(name), reps.get(name)])
    // (a word local already: the proof's range is all it takes)
    if (locals.get(name) !== 'i32' || convertingWords.has(name)) {
      const fresh = `${T}gw${freshId(ctx)}_${name}`
      rename.set(`$${name}`, `$${fresh}`)
      locals.set(name, 'i32')
      locals.set(fresh, 'i32')
      if (proof.entry) entry.push(['local.set', `$${fresh}`, ['i32.wrap_i64', proof.entry]])
      if (!convertingWords.has(name)) { convertingWords.add(name); converted.push(name) }
    }
    // (a definition the proof read: its every intermediate exact, its word arithmetic is its value)
    reps.set(name, { ...(reps.get(name) ?? repOfGlobal(name)), range: proof.range, provedWord: !proof.entry })
  }
  let ir
  try { ir = emitArm() }
  finally {
    for (const name of converted) convertingWords.delete(name)
    for (const [name, [type, rep]] of saved) {
      if (type == null) locals.delete(name); else locals.set(name, type)
      if (rep == null) reps.delete(name); else reps.set(name, rep)
    }
  }
  return [...entry, ...renameScalarBindings(Array.isArray(ir[0]) ? ir : [ir], rename)]
}

function proveGuardedWords(entries, proofs, defs, init, cond, step, body, slotRange = () => null) {
  const words = new Map(entries), visiting = new Set()
  let outsideNames = null
  const outside = n => {
    if (n === init || n === cond || n === step || n === body) return
    if (typeof n === 'string') { if (proofs.has(n)) outsideNames.add(n) }
    else if (Array.isArray(n)) for (let i = 1; i < n.length; i++) outside(n[i])
  }
  const isPrivate = name => {
    if (!outsideNames) { outsideNames = new Set(); outside(ctx.func.body) }
    return !outsideNames.has(name)
  }
  // Every intermediate must stay exact in Number arithmetic. A small final
  // address alone does not prove this: a product may round before cancellation.
  const exactRange = e => {
    // an invariant the guard snapshotted: its conjuncts bound the value the body computes
    const slot = slotRange(e)
    if (slot) return slot
    const literal = intLiteralValue(e)
    if (literal != null) return Number.isSafeInteger(literal) && !Object.is(literal, -0) ? [literal, literal] : null
    if (typeof e === 'string') {
      if (words.has(e)) return words.get(e).range
      if (proofs.has(e)) return prove(e)?.range ?? null
      return ctx.func.locals.get(e) === 'i32' && lookupValType(e) === VAL.NUMBER && !repOf(e)?.unsigned
        ? intExprRange(e) ?? [-2147483648, 2147483647] : null
    }
    if (!Array.isArray(e)) return null
    if (e[0] === '?:' && e.length === 4) {
      const a = exactRange(e[2]), b = exactRange(e[3])
      return a && b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : null
    }
    // The plan's words, `(e) | 0` and `Math.imul(a, b)`: a word of an exact
    // integer, the integer itself where that is one signed word. Word
    // arithmetic is exact modulo 2^32, so a key the guard bounds within the
    // word is exact through any wrapped intermediate.
    if (e[0] === '|' && e.length === 3 && intLiteralValue(e[2]) === 0) { const r = exactRange(e[1]); return r ? r[0] >= -2147483648 && r[1] <= 2147483647 ? r : [-2147483648, 2147483647] : null }
    if (e[0] === '()' && e.length === 3 && e[1] === 'math.imul' && Array.isArray(e[2]) && e[2][0] === ',' && e[2].length === 3) {
      const a = exactRange(e[2][1]), b = exactRange(e[2][2])
      if (!a || !b) return null
      const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]], r = [Math.min(...p), Math.max(...p)]
      return r[0] >= -2147483648 && r[1] <= 2147483647 ? r : [-2147483648, 2147483647]
    }
    if (e.length !== 3 || e[0] !== '+' && e[0] !== '-' && e[0] !== '*') return null
    const a = exactRange(e[1]), b = exactRange(e[2])
    if (!a || !b || e[0] === '*' && !mulRangesKeepZeroSign(a, b)) return null
    const products = e[0] === '*' ? [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]] : null
    const r = e[0] === '+' ? [a[0] + b[0], a[1] + b[1]] : e[0] === '-' ? [a[0] - b[1], a[1] - b[0]] : [Math.min(...products), Math.max(...products)]
    return r.every(Number.isSafeInteger) ? r : null
  }
  const prove = name => {
    if (words.has(name)) return words.get(name)
    const proof = proofs.get(name)
    if (!proof || visiting.has(name)) return null
    visiting.add(name)
    const exact = proof.entry || exactRange(defs.get(name))
    visiting.delete(name)
    if (!exact || !isPrivate(name)) return null
    words.set(name, proof)
    return proof
  }
  for (const name of proofs.keys()) prove(name)
  return words
}

function unrollSmallConstFor(init, cond, step, body) {
  // Keep the overwhelmingly-common `for(i=0;i<N;i++)` path allocation-free;
  // only strided/nonzero-start control loops pay for an explicit value list.
  const simpleEnd = smallConstForTripCount(init, cond, step)
  let name, values = null, tripCount
  if (simpleEnd != null) {
    name = init[1][1]
    tripCount = simpleEnd
  } else {
    if (!Array.isArray(init) || init[0] !== 'let' || init.length !== 2 ||
        !Array.isArray(init[1]) || init[1][0] !== '=' || typeof init[1][1] !== 'string') return null
    name = init[1][1]
    // A neighborhood walk (`for (g = -1; g <= 1; g++)`) is as countable as a
    // trip from zero: each copy reads its literal, negative or not.
    const start = constIntExpr(init[1][2])
    if (start == null || !Array.isArray(cond) || (cond[0] !== '<' && cond[0] !== '<=') || cond[1] !== name) return null
    const bound = constIntExpr(cond[2]), end = bound == null ? null : cond[0] === '<=' ? bound + 1 : bound
    let delta = null
    if (Array.isArray(step) && step[0] === '++' && step[1] === name) delta = 1
    else if (Array.isArray(step) && step[0] === '+=' && step[1] === name) delta = constIntExpr(step[2])
    if (end == null || delta == null || delta <= 0 || start >= end) return null
    values = []
    for (let v = start; v < end && values.length <= MAX_SMALL_FOR_UNROLL; v += delta) values.push(v)
    if (!values.length || values.length > MAX_SMALL_FOR_UNROLL) return null
    tripCount = values.length
  }
  if (containsNestedLoop(body)) {
    const nestedMode = ctx.transform.optimize?.nestedSmallConstForUnroll
    if (nestedMode !== true && (nestedMode !== 'auto' || !containsKnownTypedArrayIndex(body))) return null
    const budget = tripCount * nestedSmallLoopBudget(body)
    if (budget > MAX_NESTED_FOR_UNROLL) {
      // A tiny outer CONTROL loop can still profitably specialize a large
      // inner kernel when its induction value selects machine operations
      // (radix shifts, lane selectors). The inner loops remain loops; code
      // growth is bounded directly instead of multiplying their trip counts.
      const controlsOp = some(body, n => (n[0] === '>>>' || n[0] === '>>' || n[0] === '<<') && n[2] === name)
      if (!controlsOp || tripCount > 4 || tripCount * forInBodyCost(body) > 600) return null
    }
  }
  if (hasOwnBreakOrContinue(body) || containsNestedClosure(body) || containsDeclOf(body, name)) return null
  if (isReassigned(body, name)) return null
  // Copies of a large body cost more than the loop they save: noise's four
  // octaves of an inlined perlin (444 nodes each) ran 3.6% faster rolled. A
  // copy is measured with its counter substituted: the index arithmetic over
  // the counter folds to literals, so biquad's eight stages (153 nodes each,
  // a third of them `s * 5 + k` addressing) copy out as what they emit.
  if (tripCount * foldedBodyCost(body, name, values ? values[0] : 0) > MAX_SMALL_FOR_UNROLL_COST) return null

  const out = []
  const emitCopy = value => {
    const copy = cloneWithSubst(body, name, value)
    out.push(...freshenUnrolledScalarBindings(copy, emitVoid(copy)))
  }
  if (values) for (const value of values) emitCopy(value)
  else for (let i = 0; i < simpleEnd; i++) emitCopy(i)
  return out
}

// Total nodes a small-constant loop may copy out (trips × body).
const MAX_SMALL_FOR_UNROLL_COST = 1000
// Max distinct keys a for-in unrolls over (bounds code size; larger key sets keep
// the pooled-keys loop, which is already allocation-free via __keys_ro).
const FORIN_UNROLL_MAX = 16
// Total-expansion ceiling: unroll emits one body copy per key, so the size cost is
// keys × body, not keys alone. A large body over many keys (e.g. watr's 15-key
// schema loop) blows up code size for no deopt win — the pooled fallback is already
// allocation-free. Cap keys × nodeSize(body); past it, keep the loop. (Tuned above
// every unroll the corpus actually wants — the 16-key cap test lands at 80.)
const FORIN_UNROLL_BUDGET = 384
// Nodes of branch body a schema speculation may duplicate per field read it saves.
const SPEC_BUDGET_PER_READ = 16
const forInBodyCost = (node) => {
  if (!Array.isArray(node)) return 1
  let n = 1
  for (let i = 1; i < node.length; i++) n += forInBodyCost(node[i])
  return n
}
// The nodes one copy of a counted body emits once its counter is the literal
// `value`: a subtree that evaluates to a number, through the consts bound to
// such values along the way, is one node.
const foldedBodyCost = (body, name, value) => {
  const env = new Map([[name, value]])
  const resolve = id => env.has(id) ? env.get(id) : null
  const cost = node => {
    if (!Array.isArray(node)) return 1
    if (node[0] === 'const') {
      let n = 1
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        const v = Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' ? constNumExpr(d[2], resolve) : null
        if (v != null) { env.set(d[1], v); n += 1 }
        else n += cost(d)
      }
      return n
    }
    if (constNumExpr(node, resolve) != null) return 1
    let n = 1
    for (let i = 1; i < node.length; i++) n += cost(node[i])
    return n
  }
  return cost(body)
}

// Pull the for-in source out of prepare's keys expression: either a bare
// `__keys_ro(src)` call or the nullish-guarded `cond ? [] : __keys_ro(src)`.
function keysRoSrc(node) {
  if (!Array.isArray(node)) return null
  if (node[0] === '()' && node[1] === '__keys_ro') return node[2]
  if (node[0] === '?:') {
    const last = node[node.length - 1]
    if (Array.isArray(last) && last[0] === '()' && last[1] === '__keys_ro') return last[2]
  }
  return null
}

// The enumerated layout by the summary (module/object.js closedLayoutOf): one
// closed layout, a receiver that is never nullish. Read off the source
// expression, so `name = o` resolves to the assigned object's layout.
const closedKeysOf = (src) => {
  const sid = ctx.summary?.at(ctx.func.current).spreadSidOfExpr(src)
  return sid == null ? null : ctx.schema.list[sid] ?? null
}
// An open layout: the summary names the receiver's one layout, some site still
// adds keys to it, and the receiver is never nullish. Its declared keys come
// first – the object was made with them and nothing is deleted – and the keys
// added at run time follow through `__keys_dyn`, in insertion order. That is
// JS order only when every key, declared or added, is a string: an array
// index enumerates ahead of every string, so a layout holding one, or one a
// computed or number-keyed store reaches (the summary's `sideKeysOfExpr` names
// the added keys of the receiver's construction sites only when every store is
// a literal string key), keeps the pooled loop, which orders at run time.
const openKeysOf = (src) => {
  const view = ctx.summary?.at(ctx.func.current)
  const sid = view?.openSidOfExpr(src)
  if (sid == null || view.mayBeNullishExpr(src) !== false) return null
  const keys = ctx.schema.list[sid] ?? null, added = view.sideKeysOfExpr(src)
  return keys && added && !keys.some(isArrayIndexKey) && !added.some(isArrayIndexKey) ? keys : null
}
// The per-name censuses' proof of a complete schema: a bare OBJECT var with no
// computed-key write (same gate as __keys_ro pooling) and no literal-key write
// outside its schema (such a key lands in the dyn sidecar). No proof, no unroll:
// unrolling drops the dynamic path, so erring safe matters.
const censusKeysOf = (src) => {
  if (typeof src !== 'string') return null
  if (!ctx.types.dynWriteVars || ctx.types.dynWriteVars.has(src) || ctx.schema.mayGrow(src)) return null
  if (lookupValType(src) !== VAL.OBJECT) return null
  // the summary sees stores this census cannot (a bundled initializer, an alias)
  if (ctx.summary?.at(ctx.func.current).openSidOfExpr(src) != null) return null
  const keys = ctx.schema.resolve(src)
  if (!keys) return null
  const lw = ctx.types.literalWriteKeys?.get(src)
  if (lw) for (const k of lw) if (!keys.includes(k)) return null
  return keys
}

// Unroll `for (k in o)` over a closed layout. Prepare lowers for-in to a plain
// for-loop whose key array comes from the for-in-exclusive `__keys_ro` intrinsic,
// so a loop carrying it IS a for-in. When the source's objects have one closed
// layout (the summary's word, else the per-name census), replace the loop with
// one substituted copy of the body per key: the loop variable becomes a string
// literal, so `o[k]` folds to a slot read — no keys array, no per-element
// dynamic get. Falls back (returns null) to the pooled loop otherwise.
function unrollForIn(init, cond, step, body) {
  if (ctx.types.anyDelete) return null
  if (!Array.isArray(init) || init[0] !== 'let' || !Array.isArray(init[1]) || init[1][0] !== '=') return null
  const ksVar = init[1][1]
  const src = keysRoSrc(init[1][2])
  // `for (k in name = o)`: the assignment runs once, before enumeration, and
  // the body reads the alias.
  const assigned = Array.isArray(src) && src[0] === '=' && typeof src[1] === 'string' ? src : null
  const recv = assigned ? assigned[1] : src
  if (typeof recv !== 'string') return null
  if (!Array.isArray(cond) || cond[0] !== '<') return null
  const ixVar = cond[1]
  if (!Array.isArray(step) || step[0] !== '++' || step[1] !== ixVar) return null
  // body = [';', ['let', ['=', target, ['[]', ksVar, ixVar]]], ...realBody] — or,
  // for a target declared outside the loop (`for (s in o)` over a `var s`),
  // the bare assignment, whose last key stays readable after the loop.
  if (!Array.isArray(body) || body[0] !== ';') return null
  const bind = body[1]
  const decl = Array.isArray(bind) && bind[0] === 'let' ? bind[1] : bind
  if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') return null
  const target = decl[1]
  const acc = decl[2]
  if (!Array.isArray(acc) || acc[0] !== '[]' || acc[1] !== ksVar || acc[2] !== ixVar) return null
  const outerTarget = decl === bind

  const closed = closedKeysOf(src)
  const open = closed ? null : openKeysOf(src)
  // the layout's own keys: an accessor pair by its name (module/schema.js enumView)
  const layout = closed ?? open ?? censusKeysOf(src), keys = layout && enumKeys(layout)
  if (!keys || !keys.length || keys.length > FORIN_UNROLL_MAX) return null

  const rest = body.slice(2)
  const realBody = rest.length === 1 ? rest[0] : [';', ...rest]
  // Keep the pooled loop when unrolling would multiply a heavy body across many keys.
  if (keys.length * forInBodyCost(realBody) > FORIN_UNROLL_BUDGET) return null
  // Substitution safety, mirroring unrollSmallConstFor: no reassignment/redeclare
  // of the loop var and no nested closure capturing it (cloneWithSubst skips `=>`).
  // A break/continue in the body is served: a labeled one finds its statement's
  // frame by label (a `continue` to this loop's own label keeps the loop: the
  // caller's `labeledContinue`), an unlabeled one this loop's frame below.
  if (containsNestedClosure(realBody) || containsDeclOf(realBody, target)) return null
  if (isReassigned(realBody, target) || (assigned && isReassigned(realBody, recv))) return null

  const out = assigned ? emitVoid(assigned) : []
  // The summary proved the source never nullish, so the receiver's reads in
  // the body are reads of that layout's slots.
  const refs = closed || open ? new Map([[recv, { notNullish: true }]]) : new Map()
  const id = freshId(ctx), brk = `$fiu${id}`
  const copies = withControlFrame({ brk, loop: null, bodyNode: realBody }, frame => keys.map((key, i) => {
    // `continue` leaves this copy for the next; `break` leaves them all.
    frame.loop = `$fiuc${id}_${i}`
    const copy = outerTarget ? emitVoid(['=', target, ['str', key]]) : []
    copy.push(...withRefinements(refs, realBody, () => emitVoid(cloneWithSubst(realBody, new Map([[target, ['str', key]]])))))
    return ['block', frame.loop, ...copy]
  }))
  // An open layout's tail: the pooled loop over the keys added at run time,
  // inside the copies' break block so a `break` in a copy leaves it too.
  const tail = open
    ? emitVoid(['for', ['let', ['=', ksVar, ['()', '__keys_dyn', recv]], ...init.slice(2)], cond, step, body])
    : []
  if (hasOwnBreakOrContinue(realBody)) out.push(['block', brk, ...copies, ...tail])
  else { for (const copy of copies) out.push(...copy.slice(2)); out.push(...tail) }
  return out.length ? out : ['nop']
}

// Typed-array and string lengths are immutable when their local cannot change.
// Mutable array lengths belong to the IR optimizer's memory-effect proof:
// a source scan of one receiver misses mutations through aliases and calls.
const immutableLenBound = (node, body, step) => {
  // Unwrap the `| 0` i32 coercion jz wraps a loop bound in (`i < arr.length`
  // emits `i < (arr.length | 0)`).
  if (Array.isArray(node) && node[0] === '|' && Array.isArray(node[2]) && node[2][0] == null && node[2][1] === 0)
    node = node[1]
  if (!(Array.isArray(node) && node[0] === '.' && node[2] === 'length' && typeof node[1] === 'string')) return false
  const vt = lookupValType(node[1])
  return (vt === VAL.TYPED || vt === VAL.STRING) && isBoundName(node[1]) && !ctx.func.boxed?.has(node[1]) &&
    !isReassigned(body, node[1]) && !isReassigned(step, node[1])
}

// Pull `const x = <array/object literal>` decls out of a loop body when the literal is
// deeply constant and `x` is provably read-only + non-escaping in the loop (so a single
// shared allocation is sound) — otherwise the constant table is re-allocated every
// iteration. Returns { hoisted: [decl…], body: strippedBody } or null. Only top-level
// statements of the loop body are considered.
const extractHoistableLiterals = (body) => {
  let stmts, rebuild
  if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';') {
    stmts = body[1].slice(1); rebuild = kept => ['{}', [';', ...kept]]
  } else if (Array.isArray(body) && body[0] === ';') {
    stmts = body.slice(1); rebuild = kept => kept.length === 1 ? kept[0] : [';', ...kept]
  } else return null
  const hoisted = [], kept = []
  for (const s of stmts) {
    const lit = Array.isArray(s) && (s[0] === 'const' || s[0] === 'let') && s.length === 2
      && Array.isArray(s[1]) && s[1][0] === '=' && typeof s[1][1] === 'string' ? s[1][2] : null
    if (lit && Array.isArray(lit) && lit[0] === '[' && isConstLiteral(lit) && constLiteralHoistable(body, s[1][1]))
      hoisted.push(s)
    else kept.push(s)
  }
  return hoisted.length ? { hoisted, body: rebuild(kept) } : null
}

/**
 * Fresh per-iteration heap cells for boxed (closure-captured) locals declared
 * in a loop body. ECMAScript establishes the per-iteration environment at the
 * START of each iteration, so the cell must exist before ANY body statement —
 * including a closure declared *before* the binding (mutual recursion, or a
 * `function` decl jzify hoists above its captures). Allocating at the decl point
 * instead would let an earlier closure capture the previous iteration's (stale)
 * cell while the binding reads/writes the freshly-allocated one. `emitDecl` then
 * stores the initializer into this cell rather than re-allocating (see
 * `frame.loopFresh`). Returns the alloc IR to splice at loop-body entry.
 */
// Nested scopes whose declarations are their own: a closure or an inner loop.
const LOOP_FRESH_BOUNDARY_OPS = new Set(['=>', 'for', 'while'])
function emitLoopFreshBoxed(body, frame) {
  if (!ctx.func.boxed?.size) return []
  const names = new Set()
  walkAst(body, {
    boundary: (node) => LOOP_FRESH_BOUNDARY_OPS.has(node[0]),
    enter: (node) => {
      const op = node[0]
      if (op === 'let' || op === 'const') {
        for (let i = 1; i < node.length; i++) {
          const d = node[i]
          const nm = Array.isArray(d) && d[0] === '=' ? d[1] : d
          if (typeof nm === 'string' && ctx.func.boxed.has(nm)) names.add(nm)
        }
      }
    },
  })
  if (!names.size) return []
  frame.loopFresh = names
  const inits = []
  for (const name of names) {
    const cell = ctx.func.boxed.get(name)
    ctx.func.locals.set(cell, 'i32')
    inits.push(
      ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
      ['f64.store', ['local.get', `$${cell}`], undefExpr()])
  }
  return inits
}
// The names of fixed-length arrays a loop's body stores an element into and no
// part of the loop reassigns, boxes or lets be missing: a module `const` or a
// binding of the frame. Their snapshot for the reset moves before the loop.
function durableLoopArrays(init, cond, step, body) {
  const names = new Set()
  const walk = (n) => {
    if (!Array.isArray(n) || n[0] === '=>') return
    if (MUTATE_OPS.has(n[0]) && Array.isArray(n[1]) && n[1][0] === '[]' && n[1].length === 3 && typeof n[1][1] === 'string') names.add(n[1][1])
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(body)
  const view = ctx.summary?.at(ctx.func.current)
  const out = []
  for (const name of names) {
    // A binding the body or the head declares does not exist before the loop,
    // and one held as its elements' locals (ctx.func.flatObjects) has no array.
    if (ctx.func.boxed?.has(name) || ctx.func.flatObjects?.has(name) || containsDeclOf(body, name) || (init != null && containsDeclOf(init, name)) ||
        isReassigned(body, name) || (init != null && isReassigned(init, name)) ||
        (cond != null && isReassigned(cond, name)) || (step != null && isReassigned(step, name))) continue
    if (isGlobal(name) && !ctx.scope.consts?.has(name)) continue
    if (!view || view.fixedLenOf(name) == null || isNullable(view.kindOfExpr(name))) continue
    if (ctx.func.refinements?.get(name)?.saved) continue
    out.push(name)
  }
  return out
}

export const controlFlowOps = {
  // === Control flow ===

  'if': (cond, then, els) => {
    // Dead branch elimination: constant condition → emit only the live branch
    const ce = toBool(cond)
    if (isLit(ce)) {
      const v = litVal(ce), truthy = v !== 0 && v === v
      markDropped(truthy ? els : then)
      if (truthy) return emitVoid(then)
      if (els != null) return emitVoid(els)
      return null
    }
    const c = ce.type === 'i32' ? ce : truthyIR(ce)
    // Flow-sensitive type refinement: narrow types within each branch based on the guard.
    const thenRefs = extractRefinements(cond, new Map(), true)
    const elseRefs = extractRefinements(cond, new Map(), false)

    // Tagged-union branch versioning: several fields read from one unresolved
    // receiver can identify a single compile-time schema. Guard that schema ONCE
    // and emit fixed-slot accesses in the hot arm; every other value executes the
    // original dynamic body. This is the AOT analogue of a polymorphic inline
    // cache and removes one schema dispatch per field from record visitors.
    const emitBranch = (branch, refs) => {
      // An `else if` node is a dispatcher, not one variant body. Speculating
      // the whole remaining chain clones every suffix at every nesting level
      // (quadratic/exponential code growth and tiering pressure). Let its own
      // emitter recurse and speculate only the eventual leaf bodies.
      let spec = ctx.transform.optimize?.speculateSchemaBranches !== false &&
        !(Array.isArray(branch) && branch[0] === 'if')
        ? inferSchemaBranch(branch) : null
      // A sanctioned union CURSOR (unionInlinePass) already reads through
      // the packed carrier under discriminant-refinement PROOFS — the union's
      // closure is the guard. Speculating here clones the body into two
      // identical packed arms behind a redundant runtime tag check.
      if (spec && ctx.schema.inlineUnionCursors?.get(ctx.func.current)?.has(spec.name)) spec = null
      // The fast arm is a second copy of the body. A guard pays for itself over
      // the reads of a small body; over a large one the copy is the cost: watr's
      // fourteen sites (bodies of 24 to 378 nodes, two to four reads each) bought
      // nothing at steady state and 31 KB, and its first call, the tier V8 runs
      // before TurboFan replaces the module, took 60% longer. Speculate while the
      // body stays within a few nodes per read.
      if (spec && forInBodyCost(branch) > spec.accesses * SPEC_BUDGET_PER_READ) spec = null
      if (!spec) return withRefinements(refs, branch, () => emitVoid(branch))
      // A constant tag census predicts one schema, but cannot prove that host
      // or dynamically-constructed objects never carry the same tag. Narrow
      // the version guard to that sid while retaining the dynamic miss arm.
      const hint = refs.get(spec.name)?.schemaHint
      if (hint != null) {
        const schema = ctx.schema.list[hint]
        const slots = new Map()
        let valid = !!schema
        for (const prop of spec.schemaSlots.keys()) {
          const slot = schema?.indexOf(prop) ?? -1
          if (slot < 0) { valid = false; break }
          slots.set(prop, slot)
        }
        if (valid) spec = { ...spec, schemaIds: [hint], schemaId: hint, schemaSlots: slots }
      }

      const fastRefs = new Map(refs)
      mergeRefinement(fastRefs, spec.name, {
        val: VAL.OBJECT, schemaId: spec.schemaId,
        schemaIds: spec.schemaIds, schemaSlots: spec.schemaSlots,
      })
      const fast = withRefinements(fastRefs, branch, () => emitVoid(branch))

      // The fallback is already dominated by `sid !== spec.schemaId`; do not
      // rebuild per-read schema guards/devirt tables inside this cold arm.
      const slow = withSchemaSpeculation(true,
        () => withRefinements(refs, branch, () => emitVoid(branch)))

      const raw = readVar(spec.name)
      // An unresolved schema-bearing value uses the boxed f64 carrier. A raw
      // pointer would already carry ptrAux/schemaId and never reach this pass.
      if (raw.type !== 'f64') return slow
      let schemaGuard = null
      for (const sid of spec.schemaIds) {
        const eq = ['i64.eq',
          ['i64.and', ['i64.reinterpret_f64', readVar(spec.name)], ['i64.const', '0xFFFFFFFF00000000']],
          ['i64.const', i64Hex(BigInt(encodePtrHi(PTR.OBJECT, sid)) << 32n)]]
        schemaGuard = schemaGuard == null ? eq : ['i32.or', schemaGuard, eq]
      }
      return [['if', schemaGuard, ['then', ...fast], ['else', ...slow]]]
    }

    const thenBody = emitBranch(then, thenRefs)
    if (els != null) {
      const elseBody = emitBranch(els, elseRefs)
      return ['if', c, ['then', ...thenBody], ['else', ...elseBody]]
    }
    return ['if', c, ['then', ...thenBody]]
  },

  // `entered`: a versioned arm re-emits the loop whose `init` already ran before its guard.
  // The arm takes `init` only to prove its counter facts and emits the loop proper alone.
  'for': (init, cond, step, body, entered = false) => {
    if (body === undefined) return err('for-in/for-of not supported')
    // A receiver the initializer checked present (`l = data.length`) stays so
    // through the loop: the initializer runs before every test, body and step.
    const initPresent = (checkedFrom) => {
      const refs = new Map()
      for (const name of provedPresent(init, ctx.func.checkedRecv?.slice(checkedFrom)))
        refs.set(name, { ...ctx.func.refinements?.get(name), notNullish: true })
      return refs
    }
    // An enclosing labeled statement (`outer: for …`) hands its label down so `continue outer`
    // can target this loop's continue point. The immediately-enclosed loop consumes it.
    const myLabel = ctx.func.pendingLabel; ctx.func.pendingLabel = null
    const bodyNode0 = body   // identity for assumption owners — survives the hoist rebind below
    const labeledContinue = myLabel != null && hasLabeledContinueTo(body, myLabel)
    // A loop a source version left as written (plan/integral-loops.js marks its
    // body `cold`) runs for the values its guard rejects: it is emitted once,
    // checked, as the twin of the versioning below, and no pass that copies
    // loops reads it again.
    const cold = body?.cold === true
    // Don't unroll a loop that is the target of a `continue <label>` — unrolling would lose the
    // continue edge. (Plain loops with no labeled-continue still unroll.)
    if (!entered && !labeledContinue && !cold && (!ctx.transform.optimize || ctx.transform.optimize.smallConstForUnroll !== false)) {
      const unrolled = unrollSmallConstFor(init, cond, step, body)
      if (unrolled) return unrolled
    }
    // for-in over a static schema → unroll with key-literal substitution (folds
    // o[k] to schema slots). Recognized via the for-in-exclusive __keys_ro intrinsic.
    if (!entered && !labeledContinue && (!ctx.transform.optimize || ctx.transform.optimize.forInUnroll !== false)) {
      const fu = unrollForIn(init, cond, step, body)
      if (fu) return fu
    }
    // Typed-bounds loop VERSIONING (Root F): a countable loop whose body indexes typed
    // receivers with iv-affine indices no static class proves gets a ONCE-per-entry
    // runtime extent guard. The fast arm re-emits with those (recv, idx) pairs assumed
    // in-bounds — bare loads/stores, i.e. the vectorizer's shapes — while the else arm
    // keeps the checked forms verbatim (also the correct semantics for a failing guard:
    // OOB reads yield undefined, OOB writes are ignored). Guard arithmetic runs in i64:
    // a*(B-1)+b overflows i32 near the edge, and a wrapped guard that passes is heap
    // corruption. The frame's `versioned` set brakes the arms' re-entry into this
    // same intercept — per frame, so a REUSED AST (same source compiled twice, the
    // self-compile warm path) versions afresh in the next compile instead of silently
    // skipping, and the AST carries no frame reference.
    if (!entered && !labeledContinue && !cold && !ctx.func.versioned?.has(body) && !getFactStore().sourceVersioned.has(body)
        && (!ctx.transform.optimize || ctx.transform.optimize.versionTypedBounds !== false)) {
      // The scan reads the body's counter ranges (loopFacts), so an access they
      // already bound is no candidate for a runtime guard.
      const topFacts = loopFacts(init, cond, step, body)
      const levels = withRefinements(counterRefinements(topFacts), body, () => versionableTypedNest(init, cond, step, body, ctx.func.locals))
      if (levels) {
        const versioned = ctx.func.versioned ??= new Set()
        versioned.add(body)
        // every LIFTED level is proven by THIS guard — brake their own intercepts
        // (re-versioning per level compounds 2^depth checked twins)
        for (const vs of levels) if (vs.bodyNode && !vs.partial) versioned.add(vs.bodyNode)
        // The counters' ranges hold unconditionally in either arm (same init, cond and
        // step; only the body's access forms differ), unlike the bound-name magnitude
        // lever below, which holds only once the guard passed. They cover each arm whole,
        // so the counters' own step arithmetic (`j++, k += step`) stays integer too.
        const topCounterRefs = counterRefinements(topFacts)
        const result = []
        const checkedFrom = ctx.func.checkedRecv?.length ?? 0
        if (init != null) result.push(...emitVoid(init))
        const initRefs = init != null ? initPresent(checkedFrom) : new Map()
        if (levels.checkedOnly) {
          const checked = withRefinements(initRefs, body, () => withRefinements(topCounterRefs, body,
            () => controlFlowOps['for'](init, cond, step, body, true)))
          // Preserve the checked twin's existing no-respecialization contract
          // after deleting its impossible sibling and now-unneeded guard.
          const stmts = Array.isArray(checked[0]) ? checked : [checked]
          for (const stmt of stmts) {
            stmt.checkedTwin = true
            walkAst(stmt, { enter: n => { if (n[0] === 'loop') n.checkedTwin = true } })
          }
          return [...result, ...stmts]
        }
        const i64c = (n) => ['i64.const', n]
        const ext = (ir) => ['i64.extend_i32_s', ir]
        const conjs = []
        let implicitEffects
        const wordLocal = name => {
          if (typeof name !== 'string' || lookupValType(name) !== VAL.NUMBER || ctx.func.boxed?.has(name)) return false
          const global = isGlobal(name), rep = global ? repOfGlobal(name) : repOf(name)
          // (a local the plan already holds as a word takes the proof's range alone: its carrier stays)
          const type = global ? ctx.scope.globalTypes.get(name) : ctx.func.locals.get(name)
          if (!(type === 'f64' || !global && type === 'i32') || rep?.ptrKind != null || rep?.unsigned) return false
          // Slot admission already proves the binding stable across explicit
          // calls/writes. A module snapshot must also survive implicit user code.
          if (global) {
            const view = ctx.summary?.at(ctx.func.current)
            implicitEffects ??= [cond, step, body].some(root => some(root, n => runsAccessor(view, n) || runsConversion(view, n)))
            if (implicitEffects) return false
          }
          return true
        }
        // A nest takes only the words it holds as i32 locals already (a word of
        // the plan's copy): their proofs are ranges alone, with no carrier to
        // rename across the levels. A single loop converts Numbers to words too.
        const nested = levels.length !== 1 || containsNestedLoop(body)
        const wordLocalAt = name => wordLocal(name) && (!nested || ctx.func.locals.get(name) === 'i32')
        const wordLoop = !containsNestedClosure(body) &&
          levels.some(vs => vs.cands.some(c => wordLocalAt(c.idx) || !nested && c.slots?.some(t => wordLocal(t.e))))
        const wordEntries = wordLoop ? new Map() : null, wordProofs = wordLoop ? new Map() : null
        const wordDefs = wordLoop ? new Map() : null, seenWords = wordLoop ? new Set() : null
        const scanWordDefs = (list) => {
          if (!Array.isArray(list) || (list[0] !== ';' && list[0] !== '{}')) return
          for (let at = 1; at < list.length; at++) {
            const n = list[at]
            if (!Array.isArray(n)) continue
            if (n[0] !== 'let' && n[0] !== 'const') { collectBareRefs(n, seenWords); continue }
            for (let k = 1; k < n.length; k++) {
              const d = n[k]
              if (d?.[0] !== '=' || typeof d[1] !== 'string') continue
              collectBareRefs(d[2], seenWords)
              if (wordLocalAt(d[1])) wordDefs.set(d[1], wordDefs.has(d[1]) || isReassigned(body, d[1]) || seenWords.has(d[1]) ? null : d[2])
            }
          }
        }
        // (a nest's words are declared in its inner loops' bodies too: the lift reads their accesses)
        if (wordLoop) {
          // (the innermost first: an outer statement holding an inner loop reads the inner's words)
          const bodies = []
          if (nested) walkAst(body, { enter: n => { if (n[0] === '=>') return false; if (n[0] === 'while' || n[0] === 'for') { const b = n[n[0] === 'for' ? 4 : 2]; if (Array.isArray(b)) bodies.push(b[0] === '{}' ? b[1] : b) } } })
          for (const b of bodies.reverse()) scanWordDefs(b)
          scanWordDefs(body)
        }
        // one evaluation per symbolic-offset slot (a stable name or an invariant pure
        // expr like `y*w`); an 'f64' slot adds `v integral ∧ |v| ≤ 2^31` conjuncts —
        // the int model of `a*iv + v` is exact only for integral v (trunc does NOT
        // distribute over f64 sums)
        const slotKey = (s) => typeof s === 'string' ? s : JSON.stringify(s)
        const slots = new Map(), slotRanges = new Map()
        const slotI64 = (slot, kind) => {
          const key = slotKey(slot)
          let s = slots.get(key)
          if (s) return s
          if (kind === 'i32') {
            const nT = tempI64('tvm')
            result.push(['local.set', `$${nT}`, ext(asI32(emit(slot)))])
            s = ['local.get', `$${nT}`]
          } else {
            const nF = temp('tvn')
            const snap = ['local.set', `$${nF}`, asF64(emit(slot))]
            snap.boundsSnapshot = true
            result.push(snap)
            conjs.push(['f64.eq', ['local.get', `$${nF}`], ['f64.floor', ['local.get', `$${nF}`]]])
            conjs.push(['f64.le', ['f64.abs', ['local.get', `$${nF}`]], ['f64.const', 2147483648]])
            slotRanges.set(key, [-2147483648, 2147483648])
            const nT = tempI64('tvm')
            result.push(['local.set', `$${nT}`, ['i64.trunc_sat_f64_s', ['local.get', `$${nF}`]]])
            s = ['local.get', `$${nT}`]
            if (wordLoop && wordLocalAt(slot) && !isReassigned(body, slot) && !isReassigned(step, slot) && !wordDefs.has(slot))
              wordEntries.set(slot, { range: [-2147483648, 2147483647], entry: s, tests: [
                ['i64.le_s', s, i64c(2147483647)],
                ['i64.ne', ['i64.reinterpret_f64', ['local.get', `$${nF}`]], i64c(-9223372036854775808n)]
              ] })
          }
          slots.set(key, s)
          return s
        }
        // A lifted slot term that IS the top counter is bounded, not read: at the
        // nest entry the counter holds its entry value, which is its maximum going
        // down and its minimum going up, and the loop bound is the other end
        // (versionableTypedNest's topExtent — the counter is exempt from the
        // stability check only when this substitution is possible).
        let topEnds
        const topEndsOf = () => topEnds ??= (({ iv, ivKind, up, bound, boundKind, incl }) => {
          const entry = slotI64(iv, ivKind)
          const b = incl ? slotI64(bound, boundKind) : ['i64.add', slotI64(bound, boundKind), i64c(up ? -1 : 1)]
          return up ? { min: entry, max: b } : { min: b, max: entry }
        })(levels.topExtent)
        const slotSum = (base, list, lo = false) => {
          let r = base
          for (const t of list) {
            if (levels.topExtent && t.e === levels.topExtent.iv && !t.wrap) {
              const end = (lo !== (t.k < 0)) ? topEndsOf().min : topEndsOf().max
              r = ['i64.add', r, t.k === 1 ? end : ['i64.mul', i64c(t.k), end]]
              continue
            }
            // a WRAP atom (toroidal iv ternary ∈ [0, B-1]) is one-sided: B-1 into
            // the hi extent, nothing into the lo
            if (t.wrap) {
              if (!lo) r = ['i64.add', r,
                ['i64.mul', i64c(t.k), ['i64.sub', slotI64(t.e, t.kind), i64c(1)]]]
              continue
            }
            const s = slotI64(t.e, t.kind)
            r = ['i64.add', r, t.k === 1 ? s : ['i64.mul', i64c(t.k), s]]
          }
          return r
        }
        // len as ONE inline header load for a RESOLVED elem type (owned byteLen at
        // base-8, view at descriptor[0]; elemCount = byteLen >> shift) — a call in
        // the guard costs per LOOP ENTRY on re-entered inner nests (fft measured
        // 1.35x with calls, parity without); unresolved receivers keep $__len.
        const len64Of = (recv) => {
          const absent = isNullable(ctx.summary?.at(ctx.func.current).kindOfExpr(recv)) && repOf(recv)?.ptrKind == null
          // Speculation must not throw for a loop that executes no accesses.
          // A missing receiver has no valid extent; the checked arm will throw
          // only if an actual read/store is reached.
          const checked = len => absent ? ['if', ['result', 'i64'], isNullish(asF64(emit(recv))),
            ['then', ['i64.const', 0]], ['else', len]] : len
          const aux = plannedTypedStorageInfo(ctx, recv)?.aux
          // owned or a view, read off a named pointer below; any other form asks __len
          if (aux == null || aux & TYPED_ELEM_ANY_VIEW_FLAG && typeof recv !== 'string') {
            inc('__len')
            return checked(['i64.extend_i32_u', ['call', '$__len', ['i64.reinterpret_f64', asF64(emit(recv))]]])
          }
          const et = aux & 7, isView = (aux & 8) !== 0, anyView = (aux & TYPED_ELEM_ANY_VIEW_FLAG) !== 0
          const shift = (aux & 16) ? 3 : et <= 1 ? 0 : et <= 3 ? 1 : et <= 6 ? 2 : 3
          // A ptr-NARROWED receiver (typed param/local carried as a raw i32
          // offset) IS the base — asF64 on it would coerce the offset
          // NUMERICALLY (f64.convert_i32_s) and the box-decode below would
          // extract garbage bits from a plain number (module-global typed
          // array passed as param → versioning guard read a wild length →
          // OOB on a perfectly bounded loop).
          const recvIR = emit(recv)
          // Narrowed signal: an i32-typed emission of a TYPED binding IS the raw
          // data offset (reps carry val=TYPED; ptrKind rides sig narrowing).
          const rr = typeof recv === 'string' ? repOf(recv) : null
          const narrowed = recvIR.type === 'i32' && (rr?.ptrKind === VAL.TYPED || rr?.val === VAL.TYPED)
          const base = narrowed
            ? recvIR
            : ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', asF64(recvIR)], ['i64.const', LAYOUT.OFFSET_MASK]]]
          // Owned or a view (a name, never narrowed: layout.js): the view bit off
          // the pointer picks the descriptor's word or the one below the data.
          if (anyView && narrowed) { inc('__len'); return checked(['i64.extend_i32_u', ['call', '$__len', ['i64.reinterpret_f64', asF64(emit(recv))]]]) }
          const lenAt = anyView
            ? ['select', base, ['i32.sub', ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', asF64(emit(recv))], ['i64.const', LAYOUT.OFFSET_MASK]]], ['i32.const', 8]],
              ['i32.and', ['i32.wrap_i64', ['i64.shr_u', ['i64.reinterpret_f64', asF64(emit(recv))], ['i64.const', 32]]], ['i32.const', TYPED_ELEM_VIEW_FLAG]]]
            : isView ? base : ['i32.sub', base, ['i32.const', 8]]
          return checked(['i64.extend_i32_u', ['i32.shr_u', ['i32.load', lenAt], ['i32.const', shift]]])
        }
        // one guard covers the whole NEST — each level contributes its own max-iv
        // and extent conjuncts (nested recognizers need the BARE nest in the fast
        // arm, and one guard per nest beats one per row)
        const levelInfo = new Map()
        // A composed bound can fit even when its free name lacks the range
        // needed to emit the arithmetic as words. Refine those names only in
        // the guarded arm. Shifted names get precise thresholds below; the
        // existing magnitude limit leaves headroom for other expressions.
        const BOUND_NAME_MAG = 1 << 30
        const freeRefs = new Map()
        // Mirrors invariantIdxExpr's OWN grammar (type.js) exactly — the grammar
        // that already gated `bKind` onto this bound in the first place — rather
        // than a generic "every string leaf" walk: `vs.bound` is a SOURCE AST
        // node, and a naive walk would misread a property-key string (`.length`'s
        // `'length'`, a `typed receiver .length` bound already routes to bKind
        // 'i32' via a DIFFERENT branch and needs no help here) as a free
        // variable name — `emit('length')` then throws "not in scope" (FFT kernel
        // regression, caught by test/simd.js's dedupe-lane-locals case). Only a
        // SLOT_OPS binary/unary node recurses; a bare string is a name; literals
        // and anything else (member access, calls) contribute no names — safe by
        // construction, matching invariantIdxExpr's own accepted shapes 1:1.
        const boundFreeNames = (e, out) => {
          if (typeof e === 'string') { out.add(e); return out }
          if (Array.isArray(e) && SLOT_OPS.has(e[0]) && e.length <= 3)
            for (let i = 1; i < e.length; i++) boundFreeNames(e[i], out)
          return out
        }
        for (const vs of levels) {
          for (const c of vs.cands) {
            if (!isNullable(ctx.summary?.at(ctx.func.current).kindOfExpr(c.recv)) || freeRefs.get(c.recv)?.val) continue
            conjs.push(['i32.eqz', isNullish(asF64(emit(c.recv)))])
            // present in the fast arm: its reads take the kind without the missing part
            freeRefs.set(c.recv, { val: VAL.TYPED, notNullish: true })
          }
          // max iv as i64. An 'f64' bound (untyped param, unknown box) converts via
          // ceil (`<`: the max int iv under B) / floor (`<=`) + trunc_sat — never
          // traps — with a `|B| ≤ 2^31` conjunct making the conversion exact: NaN and
          // box bit patterns fail the abs-compare and fall to the checked arm;
          // saturated garbage past the limit is conjunct-dead. i64 extents then never
          // overflow (|terms| ≤ 2^31, a is an i32 literal → |hi| < 2^63).
          // a RANGE-ONLY level guards hull conjuncts alone — no iv, no max-iv
          if (vs.rangeOnly) {
            for (const c of vs.cands) {
              if (c.presence) continue
              if (c.range.hiName != null) {
                const cS = slotI64(c.range.hiName, exprType(c.range.hiName, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
                conjs.push(['i64.ge_s', cS, i64c(c.range.entryHi + 1)])
                conjs.push(['i64.lt_s', ['i64.add', cS, i64c(c.range.hiBias)], len64Of(c.recv)])
              } else conjs.push(['i64.lt_s', i64c(c.range[1]), len64Of(c.recv)])
            }
            continue
          }
          // maxIv = the TRUE max iv value at PRE-increment access sites:
          // bound−1 (strict) / bound (inclusive). A body-advanced iv (bump>0)
          // exceeds this only AFTER its write — those accesses carry cand.post
          // and their group widens by a·bump in the extent constants below.
          // (The old unconditional widening made `maxIv < len` fail exactly
          // when len == bound — every symmetric half-spectrum loop.)
          const maxIv = tempI64('tvq')
          if (vs.bKind === 'f64') {
            const bF = temp('tvf')
            result.push(['local.set', `$${bF}`, asF64(emit(vs.bound))])
            conjs.push(['f64.le', ['f64.abs', ['local.get', `$${bF}`]], ['f64.const', 2147483648]])
            result.push(['local.set', `$${maxIv}`,
              ['i64.trunc_sat_f64_s', [vs.incl ? 'f64.floor' : 'f64.ceil', ['local.get', `$${bF}`]]]])
            if (!vs.incl) result.push(['local.set', `$${maxIv}`,
              ['i64.add', ['local.get', `$${maxIv}`], i64c(-1)]])
          } else {
            const adj = vs.incl ? 0 : -1
            result.push(['local.set', `$${maxIv}`,
              adj ? ['i64.add', ext(asI32(emit(vs.bound))), i64c(adj)] : ext(asI32(emit(vs.bound)))])
          }
          // The fast bound's arithmetic also needs a closed hull for each
          // free name. An affine name±constant gets the exact signed-word
          // preimage; other expressions retain the existing magnitude guard.
          // A bare-name comparison performs no arithmetic and needs no guard.
          if (typeof vs.bound !== 'string') for (const nm of boundFreeNames(vs.bound, new Set())) {
            const range = intExprRange(nm), shift = nameShift(vs.bound, nm)
            const rlo = Number.isSafeInteger(shift) ? Math.max(-2147483648, -2147483648 - shift) : -BOUND_NAME_MAG
            const rhi = Number.isSafeInteger(shift) ? Math.min(2147483647, 2147483647 - shift) : BOUND_NAME_MAG
            const whole = exprType(nm, ctx.func.locals) === 'i32' && lookupValType(nm) === VAL.NUMBER
            if (freeRefs.has(nm) || whole && range && range[0] >= rlo && range[1] <= rhi) continue
            const nF = temp('tvw')
            result.push(['local.set', `$${nF}`, asF64(emit(nm))])
            conjs.push(['f64.eq', ['local.get', `$${nF}`], ['f64.floor', ['local.get', `$${nF}`]]])
            conjs.push(['f64.ge', ['local.get', `$${nF}`], ['f64.const', rlo]])
            conjs.push(['f64.le', ['local.get', `$${nF}`], ['f64.const', rhi]])
            freeRefs.set(nm, { rlo, rhi })
          }
          levelInfo.set(vs, { maxIv, entryIR: () => vs.startC != null ? i64c(vs.startC) : slotI64(vs.iv, vs.ivKind) })
          // non-unit monotone stride: positivity is the soundness condition
          if (vs.stepBy?.name != null)
            conjs.push(['i64.ge_s', slotI64(vs.stepBy.name, vs.stepBy.kind), i64c(1)])
          // A strided iv stops at the last value its stride reaches below the
          // bound, entry + ⌊(max − entry) / stride⌋·stride: taking the bound for
          // it put a butterfly's far access past the length (the split-radix
          // FFT's `i0 += id` loops), and the guard never held. A stride the
          // conjunct above rejects divides as 1 here, the guard failing anyway.
          if (vs.stepBy && vs.stepBy.lit !== 1) {
            const entry = levelInfo.get(vs).entryIR()
            const stride = vs.stepBy.lit != null ? i64c(vs.stepBy.lit)
              : ['select', slotI64(vs.stepBy.name, vs.stepBy.kind), i64c(1), ['i64.ge_s', slotI64(vs.stepBy.name, vs.stepBy.kind), i64c(1)]]
            result.push(['local.set', `$${maxIv}`, ['i64.add', entry,
              ['i64.mul', ['i64.div_s', ['i64.sub', ['local.get', `$${maxIv}`], entry], stride], stride]]])
          }
          // one extent conjunct pair per (recv, a, slots) group: hi = a*maxIv+Σkᵢ·slotᵢ
          // +maxC < len, plus lo = a*entry+Σkᵢ·slotᵢ+minC ≥ 0 — folded when the static
          // start proves it, read from the live iv local otherwise (top level only)
          const groups = new Map(), indGroups = new Map(), cursorGroups = new Map()
          for (const c of vs.cands) {
            if (c.presence) continue
            if (c.range != null) {
              // interval-hulled idx against a dynamic length (the affine fallback).
              // Numeric hull: one `hi < len` conjunct. Symbolic hull (wrap cursor vs
              // a MUTABLE bound C): cursor ∈ [0, C-1] relative to C's runtime value —
              // `C ≥ entryHi+1` (the entry fits) ∧ `C+bias < len` close it.
              if (c.range.hiName != null) {
                const cS = slotI64(c.range.hiName, exprType(c.range.hiName, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
                conjs.push(['i64.ge_s', cS, i64c(c.range.entryHi + 1)])
                conjs.push(['i64.lt_s', ['i64.add', cS, i64c(c.range.hiBias)], len64Of(c.recv)])
              } else conjs.push(['i64.lt_s', i64c(c.range[1]), len64Of(c.recv)])
              continue
            }
            if (c.ind != null) {
              const gk = c.recv + '\x00' + c.ind
              if (!indGroups.has(gk)) indGroups.set(gk, c)
              continue
            }
            if (c.cursor != null) {
              const key = c.recv + '\x00' + c.cursor + '\x00' + c.K
              const g = cursorGroups.get(key)
              if (!g) cursorGroups.set(key, { ...c, minC: c.cConst, maxC: c.cConst, anyPost: !!c.post })
              else { g.minC = Math.min(g.minC, c.cConst); g.maxC = Math.max(g.maxC, c.cConst); if (c.post) g.anyPost = true }
              continue
            }
            const gk = c.recv + '\x00' + c.a + '\x00' + c.slots.map(t => t.k + '*' + slotKey(t.e)).join('+')
            const g = groups.get(gk)
            if (!g) groups.set(gk, { recv: c.recv, a: c.a, slots: c.slots, maxC: c.bConst, minC: c.bConst, anyPost: !!c.post, names: wordLoop ? [c.idx] : null })
            else { g.maxC = Math.max(g.maxC, c.bConst); g.minC = Math.min(g.minC, c.bConst); if (c.post) g.anyPost = true }
            if (g && wordLoop) g.names.push(c.idx)
          }
          // A monotone cursor spans entry..entry+K*trips; read before the round's
          // advance, entry..entry+K*(trips-1): a compaction into an output sized for
          // every round takes the fast arm. Like affine groups, all offsets on one
          // receiver need only the lowest and highest check.
          for (const g of cursorGroups.values()) {
            // an f64 cursor takes the slot's integral and magnitude conjuncts: a
            // fractional entry advanced by whole steps names no element
            const entry = slotI64(g.cursor, exprType(g.cursor, ctx.func.locals) === 'i32' ? 'i32' : 'f64'), info = levelInfo.get(vs)
            const gone = ['i64.sub', ['local.get', `$${info.maxIv}`], info.entryIR()]
            const rounds = g.anyPost ? ['i64.add', gone, i64c(1)] : gone
            const lo = g.minC < 0 ? ['i64.add', entry, i64c(g.minC)] : entry
            let hi = ['i64.add', entry, ['i64.mul', i64c(g.K), rounds]]
            if (g.maxC) hi = ['i64.add', hi, i64c(g.maxC)]
            conjs.push(['i64.ge_s', lo, i64c(0)], ['i64.lt_s', hi, len64Of(g.recv)])
          }
          for (const g of groups.values()) {
            // extremes follow the SIGN of a: a·iv is maximal at maxIv for a ≥ 0
            // but at ENTRY for a < 0 (mirror index `N−k` of symmetric fills),
            // and minimal at the other end. post-increment groups see iv up to
            // maxIv+bump — widen through the extent CONSTANT (a·bump).
            const postW = g.anyPost ? g.a * vs.bump : 0
            const hiC = g.maxC + (g.a >= 0 ? postW : 0)
            const loC = g.minC + (g.a < 0 ? postW : 0)
            const entryIR = () => vs.startC != null ? i64c(vs.startC) : slotI64(vs.iv, vs.ivKind)
            let hi = slotSum(['i64.mul', i64c(g.a), g.a >= 0 ? ['local.get', `$${maxIv}`] : entryIR()], g.slots)
            if (hiC) hi = ['i64.add', hi, i64c(hiC)]
            conjs.push(['i64.lt_s', hi, len64Of(g.recv)])
            if (wordLoop) for (const name of g.names) if (wordLocalAt(name) && wordDefs.get(name))
              wordProofs.set(name, { range: [0, 2147483647], tests: [['i64.le_s', hi, i64c(2147483647)]] })
            // a ≥ 0 with a STATIC start: lo = a·startC+minC was validated
            // non-negative at candidate time (slotless), nothing to emit.
            if (g.a >= 0 && vs.startC != null && !g.slots.length) continue
            let lo = slotSum(g.a >= 0 && vs.startC != null ? i64c(g.a * vs.startC)
              : ['i64.mul', i64c(g.a), g.a >= 0 ? slotI64(vs.iv, vs.ivKind) : ['local.get', `$${maxIv}`]], g.slots, true)
            if (loC) lo = ['i64.add', lo, i64c(loC)]
            conjs.push(['i64.ge_s', lo, i64c(0)])
          }
          // induction cursors (`k += step` in a comma step): value at iteration t is
          // entry + slope*t, t ∈ [0, maxIv - ivEntry] — monotone either direction, so
          // BOTH endpoints guard in [0, len) and every intermediate value is covered
          for (const c of indGroups.values()) {
            const kE = c.entryC != null ? i64c(c.entryC)
              : slotI64(c.ind, exprType(c.ind, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
            const slopeLit = intLiteralValue(c.slope)
            const slope64 = slopeLit != null ? i64c(slopeLit)
              : slotI64(c.slope, exprType(c.slope, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
            const ivE = vs.startC != null ? i64c(vs.startC) : slotI64(vs.iv, vs.ivKind)
            const endT = tempI64('tvi')
            result.push(['local.set', `$${endT}`, ['i64.add', kE,
              ['i64.mul', slope64, ['i64.sub', ['local.get', `$${maxIv}`], ivE]]]])
            const len64 = len64Of(c.recv)
            conjs.push(['i64.ge_s', kE, i64c(0)])
            conjs.push(['i64.lt_s', kE, len64])
            conjs.push(['i64.ge_s', ['local.get', `$${endT}`], i64c(0)])
            conjs.push(['i64.lt_s', ['local.get', `$${endT}`], len64Of(c.recv)])
            const ownEntry = intLiteralValue(counterInit(init, c.ind))
            if (wordLoop && wordLocal(c.ind) && ownEntry != null && ownEntry === c.entryC && !Object.is(ownEntry, -0)) {
              const landing = ['i64.add', ['local.get', `$${endT}`], slope64]
              wordProofs.set(c.ind, { range: [-2147483648, 2147483647], entry: kE, tests: [
                ['i64.le_s', kE, i64c(2147483647)],
                ['i64.le_s', ['local.get', `$${endT}`], i64c(2147483647)],
                ['i64.ge_s', landing, i64c(-2147483648)], ['i64.le_s', landing, i64c(2147483647)]
              ] })
            }
          }
        }
        // FLAT-CURSOR endpoint guards: `j++` once per pixel across the nest —
        // value spans [j0, j0 + slope·(Π trips − (pre ? 1 : 0))]; the steps cap
        // keeps the slope product overflow-free, a negative trip (empty level)
        // fails its conjunct into the checked arm
        for (const cur of levels.cursors ?? []) {
          const j0 = slotI64(cur.name, cur.kind)
          let steps = null
          for (const L of cur.chain) {
            const info = levelInfo.get(L)
            if (!info) { steps = null; break }
            const trip = tempI64('tvt')
            result.push(['local.set', `$${trip}`,
              ['i64.add', ['i64.sub', ['local.get', `$${info.maxIv}`], info.entryIR()], i64c(1)]])
            conjs.push(['i64.ge_s', ['local.get', `$${trip}`], i64c(0)])
            steps = steps ? ['i64.mul', steps, ['local.get', `$${trip}`]] : ['local.get', `$${trip}`]
          }
          if (!steps) { cur.dead = true; continue }
          const stepsT = tempI64('tvs')
          result.push(['local.set', `$${stepsT}`, steps])
          conjs.push(['i64.le_s', ['local.get', `$${stepsT}`], i64c(2147483648)])
          const seen = new Set()
          for (const c of cur.cands) {
            const gk = c.recv + '\x00' + c.post
            if (seen.has(gk)) continue
            seen.add(gk)
            const endT = tempI64('tvz')
            result.push(['local.set', `$${endT}`, ['i64.add', j0,
              ['i64.mul', i64c(cur.slope), c.post ? ['local.get', `$${stepsT}`]
                : ['i64.sub', ['local.get', `$${stepsT}`], i64c(1)]]]])
            conjs.push(['i64.ge_s', j0, i64c(0)])
            conjs.push(['i64.lt_s', ['local.get', `$${endT}`], len64Of(c.recv)])
          }
        }
        const words = wordLoop ? proveGuardedWords(wordEntries, wordProofs, wordDefs, init, cond, step, body, e => slotRanges.get(slotKey(e)) ?? null) : null
        if (words) for (const proof of words.values()) conjs.push(...proof.tests)
        let guard = conjs[0]
        for (let k = 1; k < conjs.length; k++) guard = ['i32.and', guard, conjs[k]]
        // arm-scoped assumption MAP key → OWNING loop body: an assumption is honored
        // only while its loop's frame is on the emission stack (typedIdxProven checks
        // frame.bodyNode) — a textual twin of an inner access OUTSIDE that loop (the
        // cursor past its bound) must NOT inherit the proof. Snapshot/RESTORE (not
        // add/delete): unrolls inside the fast arm stamp clone keys that must not
        // survive into the checked arm, which runs exactly when the guard failed.
        const saved = ctx.types.assumedBounds
        const savedHull = ctx.types.assumedConstHull
        ctx.types.assumedBounds = new Map(saved ?? [])
        // Per-receiver guarded CONST hull (typedIdxProven class 4b): every a=0
        // pure-const candidate's extent is guard-checked against recv.length, so
        // the fast arm may assume ANY const index ≤ the receiver's max guarded
        // extent — value-keyed, immune to the clone/rename layers that break the
        // per-node assumption keys (plan unroll + per-arm emit unroll re-mint
        // ids every emission; the biquad cascade lost all 40 coefficient/state
        // assumptions that way and re-emitted the checked forms inside the
        // guarded arm).
        ctx.types.assumedConstHull = new Map(savedHull ?? [])
        for (const vs of levels)
          for (const c of vs.cands) {
            if (c.presence) continue
            if (c.range == null && c.ind == null && c.a === 0 && (!c.slots || !c.slots.length) && c.bConst >= 0) {
              const h = ctx.types.assumedConstHull.get(c.recv)
              if (!h || c.bConst > h.max) ctx.types.assumedConstHull.set(c.recv, { max: c.bConst, owner: body })
            }
            // TOP-owned, every kind: each kept level is LIFTED — its extents are
            // proven by the top guard reading the inner bound at top entry — so
            // the proof holds anywhere inside the top body. Level-owned scoping
            // (the old form for affine cands) broke exactly when the inner loop
            // UNROLLED in the fast arm: an unrolled loop pushes no frame, so its
            // level-owned assumptions could never validate and the guarded arm
            // re-emitted every checked form (biquad's 40 coefficient reads at
            // 5.6% vs zig-wasm; 1.7% after this fix). Index names are the
            // level's own body-lets/iv (unreachable outside it) or invariant
            // slots — a textual twin outside the level cannot exist with the
            // same key, so top-ownership loses no safety.
            ctx.types.assumedBounds.set(idxKey(c.recv, c.idx), body)
          }
        // cursor claims hold across the WHOLE nest (entry → end) — owned by the top
        for (const cur of levels.cursors ?? [])
          if (!cur.dead) for (const c of cur.cands) ctx.types.assumedBounds.set(idxKey(c.recv, c.idx), body)
        // Bound-name refinements apply ONLY to the fast arm's own re-emission — the
        // checked arm runs exactly when the guard's conjuncts (including the new
        // per-name integral+magnitude ones) DIDN'T all hold, so it must stay
        // unrefined. withRefinements (flow-types.js) itself re-checks isReassigned
        // against `body` as a second, independent safety net.
        const emitArm = () => controlFlowOps['for'](init, cond, step, body, true)
        // topCounterRefs (the counter's own [lo, hi], unconditional) wraps BOTH
        // arms; freeRefs (bound-name magnitude, sound only once the guard has
        // passed) wraps the fast arm alone — see comments above each.
        // (the body's own bindings take fresh locals in this arm: the checked arm's
        // missing reads then cannot keep a fast arm's element in its f64 carrier)
        const fast = freshenUnrolledScalarBindings(body, emitGuardedWords(words, () => withRefinements(initRefs, body, () => withRefinements(topCounterRefs, body,
          () => freeRefs.size ? withRefinements(freeRefs, body, emitArm) : emitArm()))))
        ctx.types.assumedBounds = saved
        ctx.types.assumedConstHull = savedHull
        const checked = withRefinements(initRefs, body, () => withRefinements(topCounterRefs, body, emitArm))
        const stmts = (r) => Array.isArray(r[0]) ? r : [r]
        // (the arm a failing guard runs, marked for the passes that copy loops:
        // a copy of it would run as rarely as it does, optimize/specialize.js)
        const twin = ['else', ...stmts(checked)]
        twin.checkedTwin = true
        walkAst(twin, { enter: n => { if (n[0] === 'loop') { n.checkedTwin = true; n.cold = true } } })
        result.push(['if', typed(guard, 'i32'), ['then', ...stmts(fast)], twin])
        return result
      }
    }
    // Lift constant array/object literals out of the loop (allocate once, not per
    // iteration) when they are read-only + non-escaping inside it. Strip them from the
    // body up front so freshBoxed / continue analysis see the reduced body.
    let preLoopLits = []
    if (!ctx.transform.optimize || ctx.transform.optimize.hoistConstLit !== false) {
      const ex = extractHoistableLiterals(body)
      if (ex) { preLoopLits = ex.hoisted; body = ex.body }
    }
    const id = freshId(ctx)
    const brk = `$brk${id}`, loop = `$loop${id}`
    // The cont wrapper is only needed if the body has a `continue` AND there is a step
    // expression — `continue` must jump to before the step. Without a step, `continue`
    // can target the loop label directly, saving a redundant `block`.
    const needsCont = step && (hasOwnContinue(body) || labeledContinue)
    const cont = needsCont ? `$cont${id}` : loop
    const control = { brk, loop: cont, bodyNode: bodyNode0 }
    return withControlFrame(control, frame => {
    if (myLabel != null) frame.contLabel = myLabel   // so `continue <myLabel>` targets this loop's step/test
    // Per-iteration fresh cells for boxed locals declared in the body — allocated
    // at body entry so a closure declared before its binding captures the right
    // cell (sets frame.loopFresh; emitDecl then stores rather than re-allocates).
    const freshBoxed = emitLoopFreshBoxed(body, frame)
    const result = []
    const checkedFrom = ctx.func.checkedRecv?.length ?? 0
    if (init != null && !entered) result.push(...emitVoid(init))
    const initRefs = init != null && !entered ? initPresent(checkedFrom) : new Map()
    for (const lit of preLoopLits) result.push(...emitVoid(lit))   // allocate hoisted literals once
    // A durable array the body stores into by a name the loop never reassigns
    // is saved for the reset before the loop (module/collection/durable.js):
    // its stores inside then skip the round's snapshot test, which only the
    // first of them could have needed.
    const savedArrays = hasDurableReset() ? durableLoopArrays(init, cond, step, body) : []
    const savedRefs = new Map()
    for (const name of savedArrays) {
      const b = tempI32('lsb')
      result.push(['local.set', `$${b}`, ['i32.wrap_i64', ['i64.reinterpret_f64', asF64(emit(name))]]], durableArrSnapNode(b))
      inc('__durable_arr_snap')
      ;(ctx.func.savedStores ??= []).push(name)
      savedRefs.set(name, { ...ctx.func.refinements?.get(name), saved: true })
    }
    // Hoist a loop-invariant immutable-length bound out of the condition. A typed
    // array's `.length` is fixed, so `i < arr.length` otherwise reloads the header
    // (`i32.load (base-8) >> 2`) every iteration for nothing (V8's JIT hoists it).
    // Compute it once into a temp when `arr` is a typed-array var not reassigned in
    // the body. Only the simple top-level comparison forms — anything fancier just
    // keeps the per-iteration eval (correct, only misses the speedup).
    let condForLoop = cond
    if (cond && Array.isArray(cond) && RELATIONAL_OPS.has(cond[0])) {
      const side = immutableLenBound(cond[2], body, step) ? 2 : immutableLenBound(cond[1], body, step) ? 1 : 0
      if (side) {
        const lt = tempI32('len')
        result.push(['local.set', `$${lt}`, asI32(emit(cond[side]))])
        condForLoop = cond.slice(); condForLoop[side] = lt
      }
    }
    // Loop-counter RANGE-PROOF lever: `for (let i = C; i < B; i++)` proves a real
    // [lo, hi] hull for `i` (forCounterRange's own doc), scoped to exactly this body
    // via withRefinements (flow-types.js), the machinery an `if (x >= 0 && x < W)`
    // guard already uses for its own int-range refinement, so intExprRange(i) (and
    // every addFitsI32/mulFitsI32 caller that routes through it) sees the fact for
    // the duration of this emit only.
    // Loop-guard hull channel (addLiteralFitsI32's doc, above near addRangeFitsI32):
    // `while(name < bound)` / `for(…; name < bound; …)` proves an upper bound for
    // `name`, sound without the counter's monotone-step induction (heapify's reassigned
    // `child` guard): an emission-position fact the first write to `name` ends
    // (writeVar, ir.js). The bound's own intExprRange needs both sides (the typed
    // `.length` fact supplies them for a typed receiver); only the upper half is installed.
    // The same facts ride this loop's lowering link to the optimizer (loopFacts' doc).
    const facts = loopFacts(init, cond, step, body)
    const { iv: counterName, guard: guardName, guardRange: guardBoundRange } = facts
    let guardHadPrev = false, guardPrev
    if (guardBoundRange) {
      const map = loopGuardHi()
      guardHadPrev = map.has(guardName)
      guardPrev = map.get(guardName)
      const hi = cond[0] === '<' ? guardBoundRange[1] - 1 : guardBoundRange[1]
      map.set(guardName, guardHadPrev ? Math.min(guardPrev, hi) : hi)
    }
    // The test guards the body: what it proves about a name (a truthy assignment, a
    // typeof, a bound) holds on every iteration's entry, merged into the counter's
    // own hull (a second map for the same name would replace its lower bound).
    const bodyRefs = counterRefinements(facts)
    if (condForLoop) extractRefinements(condForLoop, bodyRefs, true)
    for (const [name, fact] of initRefs) bodyRefs.set(name, bodyRefs.has(name) ? { ...bodyRefs.get(name), ...fact } : fact)
    const emitLoopBody = () => withRefinements(bodyRefs, body, () => withRefinements(savedRefs, body, () => emitVoid(body)))
    const loopBody = []
    if (condForLoop) loopBody.push(['br_if', brk, ['i32.eqz',
      withRefinements(initRefs, condForLoop, () => withRefinements(testRefinements(facts), condForLoop, () => toBool(condForLoop)))]])
    loopBody.push(...freshBoxed)
    if (needsCont) loopBody.push(['block', cont, ...emitLoopBody()])
    else loopBody.push(...emitLoopBody())
    if (guardBoundRange) {
      const map = loopGuardHi()
      if (guardHadPrev) map.set(guardName, guardPrev); else map.delete(guardName)
    }
    if (step) loopBody.push(...withRefinements(initRefs, step, () => emitVoid(step)))
    loopBody.push(['br', loop])
    const loopBlockNode = ['block', brk, ['loop', loop, ...loopBody]]
    // (`cold` on the IR too: the vectorizer leaves a cold loop; `checkedTwin` is specialize's mark)
    if (cold) { loopBlockNode.checkedTwin = true; walkAst(loopBlockNode, { enter: n => { if (n[0] === 'loop') { n.checkedTwin = true; n.cold = true } } }) }
    if (frame.boundsMotion) loopBlockNode[2].boundsOwner = frame.loop
    // Per-iteration arena rewind (compile/analyze/frame-effects.js): an iteration
    // that lets no allocation escape and builds a value restores the heap pointer
    // at its start, so its temporaries never accumulate. Recorded here on
    // the frame by the loop's label (labels count from zero in every
    // function, and a rewrite that copies the loop's node keeps its label),
    // published under the function's WAT name once its body is emitted
    // (active-function.js publishLoopRewinds), inserted after the vectorizer
    // has matched loop shapes (optimize/loop-rewind.js), and validated
    // against the body's callees at link (optimize/arena-rewind.js). The heap
    // pointer's home (the `$__heap` global of an owned memory, the reserved
    // word of a shared one) is declared with the allocator after emission;
    // the pass checks for it at link.
    if (ctx.plans.rewindLoops?.has(bodyNode0) && !ctx.memory.atomic
        && (!ctx.transform.optimize || ctx.transform.optimize.arenaRewind !== false))
      (ctx.func.loopRewinds ??= new Set()).add(loop)
    // The lowering link hands this loop's facts to the optimizer (src/ir/control.js):
    // `plan` the facts, `lowering` the WAT names of its counter and guard, which a rename
    // of this block's locals keeps current (freshenUnrolledScalarBindings).
    ctx.plans.loweringLinks.set(loopBlockNode, { plan: facts, lowering: { ivName: counterName, guardName } })
    result.push(loopBlockNode)
    return result.length === 1 ? result[0] : result
    })
  },

  'while': (cond, body) => controlFlowOps['for'](null, cond, null, body),
  'label': (name, body) => {
    const brk = `$label${freshId(ctx)}`
    return withControlFrame({ label: name, brk }, () =>
      // Hand the label to the immediately-enclosed loop. A loop consumes the
      // value; the field scope clears it on every exit when no loop does.
      withPendingLabel(name, () => ['block', brk, ...emitVoid(body)]))
  },
  'break': (label) => {
    const idx = label == null
      ? ctx.func.stack.findLastIndex(frame => frame.loop !== undefined)
      : ctx.func.stack.findLastIndex(frame => frame.label === label)
    if (label != null && idx < 0) err(`break label '${label}' is not in scope — check the spelling, or add a matching \`${label}:\` around an enclosing loop/block`)
    const target = idx >= 0 ? ctx.func.stack[idx].brk : null
    if (!target) err(`break label '${label}' is not in scope`)
    return [...emitFinalizers(idx + 1), ['br', target]]
  },
  'continue': (label) => {
    if (label == null) {
      const idx = ctx.func.stack.findLastIndex(frame => frame.loop != null)
      if (idx < 0) err('continue outside loop')
      return [...emitFinalizers(idx + 1), ['br', ctx.func.stack[idx].loop]]
    }
    // Labeled continue: target the continue point of the loop that adopted this label.
    const idx = ctx.func.stack.findLastIndex(f => f.contLabel === label)
    if (idx < 0) err(`continue label '${label}' is not in scope — check the spelling, or add a matching \`${label}:\` around an enclosing loop`)
    return [...emitFinalizers(idx + 1), ['br', ctx.func.stack[idx].loop]]
  },

}
