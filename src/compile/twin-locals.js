/**
 * Twin locals: a counted loop versioned in the source, so that its checked
 * twin writes locals of its own.
 *
 * Loop-entry versioning (type/loop-versioning.js) emits a counted loop twice
 * from one AST: a fast copy under one extent test of its typed reads, and a
 * checked twin. The copies share their locals, and a local takes the join of
 * both copies' types. A checked integer read can miss, so the twin's
 * `undefined` keeps every value it reaches in an f64 carrier, in the fast
 * copy too: glyph parsing's `x = x + stream[r++]` accumulated in f64 while its
 * fast copy read only bytes.
 *
 * Versioned before local typing, the copies are separate code:
 *     L   →   if (G) L else { let x′ = x; L′ }
 * G is L's extent test in source form; L keeps its names, and G proves its
 * candidate reads (the fact store's `guardProven`). The twin L′ declares its
 * counter and its own names afresh and writes a fresh copy of each outer local
 * that is dead after the loop, entered from the outer value. Each copy's
 * locals then take their own types. Neither copy is versioned again, and an
 * enclosing loop's scan leaves both copies' accesses to them (the fact store's
 * `sourceVersioned`). A split whose renamed locals all keep their twins'
 * types is undone.
 *
 * Applies to an innermost `for (let i = C; i < B; i++)` (or `i <= B`) with C
 * an integer literal and B an integer-typed bound, with no closure and no
 * label, that reads an integer typed array at one of its candidates, whose
 * candidates are all affine in `i` with integer-typed terms or monotone
 * cursors held in integer-typed locals, on receivers that are present. G runs
 * before the loop and reads only names the loop's header does not write. Runs
 * with loop-entry versioning (speed tiers).
 *
 * @module compile/twin-locals
 */
import { ctx, getFactStore } from '../ctx.js'
import { walkAst, some, cloneNode, collectAllBoundNames, collectAssignedNames, refsName, REFS_THROUGH_ARROWS, MUTATE_OPS, T } from '../ast.js'
import { freshId } from '../ir.js'
import { typedElemAux } from '../../layout.js'
import { typedStorageNameCtor } from '../typed-context.js'
import { cloneWithSubst } from '../type/clone.js'
import { idxKey } from '../type/canonical-bounds.js'
import { exprType } from '../type/expr-type.js'
import { versionableTypedFor, receiverMayBeAbsent } from '../type/loop-versioning.js'
import { invalidateIntervalProof } from '../type/interval-proof.js'
import { invalidateRewrittenBody } from './analyze/body-facts.js'
import { withBodyTypedFacts } from './flow-state.js'

const isArr = Array.isArray
const LOOPS = new Set(['for', 'while', 'do', 'for-of', 'for-in'])
const num = (v) => [null, v]
const plus = (e, k) => k === 0 ? e : ['+', e, num(k)]
const times = (k, e) => k === 1 ? e : ['*', num(k), e]

/**
 * L's extent test in source form: the conjuncts loop-entry versioning emits
 * for `spec`'s candidates, or null when a candidate is outside the forms it
 * states. For a loop that runs, T = B − C (+1 for `<=`) trips reach the
 * counter's last value; an affine index is extreme at the first and last
 * counter values, and a cursor advancing at most K per trip stays within
 * [c, c + K·T] offset by its reads' constants. The test owns copies of the
 * loop's expressions, so the body stays a tree.
 */
function extentTest(spec, locals) {
  const { startC: C, bound, incl, cands } = spec
  const i32 = (e) => exprType(e, locals) === 'i32'
  if (C == null || spec.bump || spec.stepBy || spec.bKind !== 'i32' || !i32(bound)) return null
  const B = () => cloneNode(bound)
  const trips = () => plus(B(), (incl ? 1 : 0) - C)
  const last = () => incl ? B() : plus(B(), -1)
  const tests = [], seen = new Set()
  const push = (t) => { const k = JSON.stringify(t); if (!seen.has(k)) { seen.add(k); tests.push(t) } }
  const cursors = new Map()
  for (const c of cands) {
    if (c.presence || c.range || c.ind != null || c.post || receiverMayBeAbsent(c.recv, c.idx)) return null
    const len = ['.', c.recv, 'length']
    if (c.cursor != null) {
      if (!i32(c.cursor)) return null
      const key = c.recv + '\0' + c.cursor, e = cursors.get(key)
      if (!e) cursors.set(key, { len, c: c.cursor, K: c.K, lo: c.cConst, hi: c.cConst })
      else { e.lo = Math.min(e.lo, c.cConst); e.hi = Math.max(e.hi, c.cConst) }
      continue
    }
    if (c.slots.some(t => t.wrap || !i32(t.e))) return null
    const b = () => c.slots.reduce((acc, t) => acc ? ['+', acc, times(t.k, cloneNode(t.e))] : times(t.k, cloneNode(t.e)), null)
    const at = (v) => {
      const av = c.a === 0 ? null : times(c.a, v), bv = b()
      const s = av && bv ? ['+', av, bv] : av ?? bv
      return s ? plus(s, c.bConst) : num(c.bConst)
    }
    const [lo, hi] = c.a >= 0 ? [() => num(C), last] : [last, () => num(C)]
    push(['>=', at(lo()), num(0)])
    push(['<', at(hi()), len])
  }
  for (const { len, c, K, lo, hi } of cursors.values()) {
    push(['>=', plus(c, lo), num(0)])
    push(['<', plus(['+', c, times(K, trips())], hi), len])
  }
  return tests.length ? tests.reduce((a, t) => ['&&', a, t]) : null
}

/** Whether `L` reads an integer typed array (at one of `keys`, when given): a value its checked twin can miss. */
const readsIntegerArray = (L, keys = null) => {
  let hit = false
  walkAst(L, { enter: (n, parent) => {
    if (hit || n[0] === '=>') return false
    if (n[0] !== '[]' || n.length !== 3 || typeof n[1] !== 'string' || keys && !keys.has(idxKey(n[1], n[2]))) return
    if (parent && MUTATE_OPS.has(parent[0]) && parent[1] === n) return
    const aux = typedElemAux(typedStorageNameCtor(ctx, n[1]))
    if (aux != null && (aux & 7) <= 4 && !(aux & 32)) hit = true
  } })
  return hit
}

/**
 * The twin's renames: every name `L` declares, and each outer local `L`
 * writes that is dead after it: declared earlier in the statement list
 * `stmts`, referenced by no later statement and by no closure of `fnBody`.
 * Returns the rename map and the outer locals, whose copies enter from them.
 */
function twinRenames(L, stmts, p, fnBody) {
  const ren = new Map(), outer = []
  const fresh = (name) => ren.set(name, `${T}tw${freshId(ctx)}_${name}`)
  walkAst(L, { enter: (x) => {
    if (x[0] !== 'let' && x[0] !== 'const') return
    for (const name of collectAllBoundNames(x)) if (!ren.has(name)) fresh(name)
  } })
  if (!stmts) return { ren, outer }
  for (const x of collectAssignedNames(L, new Set())) {
    if (ren.has(x) || ctx.func.boxed?.has(x)) continue
    const declared = stmts.slice(1, p).some(s => isArr(s) && (s[0] === 'let' || s[0] === 'const') && collectAllBoundNames(s).has(x))
    if (!declared || stmts.slice(p + 1).some(s => refsName(s, x, REFS_THROUGH_ARROWS))) continue
    if (some(fnBody, n => n[0] === '=>' && refsName(n, x, REFS_THROUGH_ARROWS))) continue
    fresh(x)
    outer.push(x)
  }
  return { ren, outer }
}

/**
 * Version the counted loops of `body` whose checked twins would widen their
 * fast copies' locals. `facts` is the body analysis; `reanalyze()` analyzes
 * the body afresh and returns its facts. Returns the final facts, or null
 * when the body is unchanged.
 */
export function splitTwins(body, facts, reanalyze) {
  if (!isArr(body)) return null
  const locals = ctx.func.locals, store = getFactStore()
  const splits = []
  let queried = false
  withBodyTypedFacts(facts, () => walkAst(body, { enter: (n, parent, index) => {
    if (n[0] === '=>') return false
    if (n[0] !== 'for' || n.length !== 5 || !parent || (parent[0] !== ';' && parent[0] !== '{}')) return
    const [, init, cond, step, lbody] = n
    if (some(lbody, x => LOOPS.has(x[0]) || x[0] === '=>')) return
    // the test runs before the loop: the header declares the counter alone
    if (!isArr(init) || init[0] !== 'let' || init.length !== 2 || !isArr(init[1]) || init[1][0] !== '=') return false
    if (!readsIntegerArray(n)) return false
    queried = true
    const spec = versionableTypedFor(init, cond, step, lbody, locals)
    if (!spec || init[1][1] !== spec.iv) return false
    const keys = new Set(spec.cands.map(c => idxKey(c.recv, c.idx)))
    if (!readsIntegerArray(n, keys)) return false
    const G = extentTest(spec, locals)
    if (G) splits.push({ L: n, parent, p: index, keys, G })
    return false
  } }))
  // The queries cached proofs of the body as it stands, under this analysis's
  // facts: the twins copy them while they are current, and none outlives this pass.
  if (!splits.length) { if (queried) invalidateIntervalProof(body); return null }
  for (const s of splits) {
    const { ren, outer } = twinRenames(s.L, s.parent[0] === ';' ? s.parent : null, s.p, body)
    s.ren = ren
    s.twin = cloneWithSubst(s.L, new Map(), ren)
    s.entry = outer.map(x => ['let', ['=', ren.get(x), x]])
  }
  // A twin name holds what its original held in that loop: it reads the
  // original's program-summary kind.
  const view = ctx.summary?.at(ctx.func.current)
  for (const s of splits) for (const [a, b] of s.ren) view?.alias(b, a, false)
  for (const s of splits) {
    s.parent[s.p] = ['if', s.G, s.L, ['{}', [';', ...s.entry, s.twin]]]
    s.stamped = []
    walkAst(s.L, { enter: (x) => {
      if (x[0] === '=>') return false
      if (x[0] === '[]' && x.length === 3 && typeof x[1] === 'string' && s.keys.has(idxKey(x[1], x[2]))) {
        store.guardProven.add(x)
        s.stamped.push(x)
      }
    } })
    store.sourceVersioned.add(s.L[4])
    store.sourceVersioned.add(s.twin[4])
  }
  invalidateRewrittenBody(body)
  const out = reanalyze()
  const undo = splits.filter(s => [...s.ren].every(([a, b]) => out.locals.get(a) === out.locals.get(b)))
  if (!undo.length) return out
  for (const s of undo) {
    s.parent[s.p] = s.L
    for (const b of s.ren.values()) view?.unalias(b)
    for (const x of s.stamped) store.guardProven.delete(x)
    store.sourceVersioned.delete(s.L[4])
    store.sourceVersioned.delete(s.twin[4])
  }
  invalidateRewrittenBody(body)
  return reanalyze()
}
