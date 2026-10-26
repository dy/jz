// Two items of a loop over independent items run side by side (speed tier).
//
//   for (let b = 0; b < n; b++) {              // items
//     const io = inOff[b], bo = busOff[b], l = len[b]
//     let sm = 0
//     for (let i = 0; i < l; i++) {            // each item's recurrence: a chain of dependent steps
//       sm = sm * 0.995 + input[io + i] * 0.005
//       bus[bo + i] = bus[bo + i] + sm * gain
//     }
//   }
//
// Each step of an item waits on the one before; the next item's chain, independent of
// it, starts only when this one ends. Items b and b + 1 (A and B) declare what they
// declare, then one loop steps both while both have steps left, then the item with
// steps left finishes alone. Each item runs its own statements in its own order, so
// every value is the one the loop as written computes; what moves is A's work against
// B's, which nothing observes when the two touch no element one of them writes:
//   • the arrays the items read and write are distinct buffers (typed-array parameters
//     every call passes distinct fresh arrays, `distinctParams`, or the function's own
//     fresh allocations), indexed `base + i` in the inner loop, by expressions of the
//     item counter in the declarations, and the declarations read no array the inner
//     loop writes;
//   • a test before the pair: the index ranges of an array A writes and B reads or
//     writes, and the other way, are apart (`baseA + lA <= baseB || baseB + lB <= baseA`),
//     the trip counts are int32s, and every other name the arithmetic reads is a Number
//     (an object's valueOf would run in another order); a pair that fails it runs A,
//     then B, as written, and an odd last item runs alone;
//   • the inner loop writes only scalars its item declares and elements of its arrays,
//     calls nothing, branches nowhere, and computes with operators that cannot throw
//     on Numbers.
// A plan pass ahead of the integral copies: they read the pair's loops as written loops.

import { normalizeLoop, rewriteBlocks, freshLoopId, unitIncVar, loopLitVal, closureMutatedVars } from './loop-model.js'
import { T, numberGuard, walkAst, some } from '../ast.js'
import { ctx } from '../ctx.js'
import { frameNode } from '../function.js'
import { freshId } from '../ir.js'
import { cloneWithSubst } from '../type.js'
import { collectBindings, nodeSize, freshTypedArrayLocals, freshReturningFuncs } from './plan/common.js'
import { invalidateBodies } from './analyze.js'
import { invalidateProgramFactsCache } from './program-facts.js'
import { isExported } from './func-exports.js'

const MAX_SIZE = 600   // nodes of a loop the pair copies five times
const lit = (v) => [null, v]
const and = (tests) => tests.reduce((a, b) => ['&&', a, b])
const or = (a, b) => ['||', a, b]
const word = (n) => ['&&', numberGuard(n), ['===', n, ['|', n, lit(0)]]]
// operators on Numbers that compute from their operands and nothing else, and cannot throw
const OPS = new Set(['+', '-', '*', '<', '<=', '>', '>=', '===', '!==', '==', '!=', '&&', '||', '?:', '!'])
const isName = (n) => typeof n === 'string'

/** `arr[base + i]`, `arr[i + base]`, `arr[i]`: { arr, base } (base null for `arr[i]`), else null. */
const access = (n, i) => {
  if (!Array.isArray(n) || n[0] !== '[]' || n.length !== 3 || !isName(n[1])) return null
  const x = n[2]
  if (x === i) return { arr: n[1], base: null }
  if (Array.isArray(x) && x[0] === '+' && x.length === 3) {
    if (x[2] === i && isName(x[1]) && x[1] !== i) return { arr: n[1], base: x[1] }
    if (x[1] === i && isName(x[2]) && x[2] !== i) return { arr: n[1], base: x[2] }
  }
  return null
}

/** The loop's pairing plan, or null. */
function plan(stmt, cm, buffers) {
  const L = normalizeLoop(stmt)
  if (!L || L.kind !== 'for' || nodeSize(stmt) > MAX_SIZE) return null
  // the items: `for (let b = start; b < n; b++)`
  const init = L.init
  if (!Array.isArray(init) || init[0] !== 'let' || init.length !== 2 || !Array.isArray(init[1]) || init[1][0] !== '=') return null
  const b = init[1][1]
  if (!isName(b) || unitIncVar(L.step) !== b || cm.has(b) || !Number.isInteger(loopLitVal(init[1][2]))) return null
  const cond = L.cond
  if (!Array.isArray(cond) || cond[0] !== '<' || cond[1] !== b) return null
  const n = cond[2]
  if (!(loopLitVal(n) != null || isName(n) && n !== b)) return null
  const body = L.body
  if (!Array.isArray(body) || body[0] !== ';' || body.length < 3) return null
  if (some(body, x => x[0] === '=>' || x[0] === 'break' || x[0] === 'continue' || x[0] === 'return' || x[0] === '()' || x[0] === 'throw' || x[0] === 'yield' || x[0] === 'await')) return null
  // what an item declares, then its inner loop
  const decls = body.slice(1, -1), inner = normalizeLoop(body[body.length - 1])
  if (!inner || inner.kind !== 'for') return null
  const own = new Set(), lets = new Set()
  const arraysRead = new Set()
  // a declaration reads the counter, what the item declared before it, literals, and elements of buffers
  const declPure = (e) => {
    if (isName(e)) return e === b || own.has(e)
    if (loopLitVal(e) != null) return true
    if (!Array.isArray(e)) return false
    if (e[0] === '[]' && e.length === 3 && isName(e[1]) && buffers.has(e[1])) { arraysRead.add(e[1]); return declPure(e[2]) }
    return OPS.has(e[0]) && e.slice(1).every(declPure)
  }
  for (const s of decls) {
    if (!Array.isArray(s) || (s[0] !== 'const' && s[0] !== 'let') || s.length < 2) return null
    for (const d of s.slice(1)) {
      if (!Array.isArray(d) || d[0] !== '=' || !isName(d[1]) || !declPure(d[2])) return null
      own.add(d[1])
      if (s[0] === 'let') lets.add(d[1])
    }
  }
  // the inner loop: `for (let i = start; i < l; i++)`, l declared by the item or invariant
  const ii = inner.init
  if (!Array.isArray(ii) || ii[0] !== 'let' || ii.length !== 2 || !Array.isArray(ii[1]) || ii[1][0] !== '=' || !isName(ii[1][1])) return null
  const i = ii[1][1], i0 = ii[1][2]
  if (loopLitVal(i0) == null || !Number.isInteger(loopLitVal(i0)) || unitIncVar(inner.step) !== i) return null
  const ic = inner.cond
  if (!Array.isArray(ic) || ic[0] !== '<' || ic[1] !== i || !isName(ic[2]) || ic[2] === i) return null
  const l = ic[2]
  const ib = inner.body
  const stmts = Array.isArray(ib) && ib[0] === ';' ? ib.slice(1) : [ib]
  const stores = [], reads = [], numbers = new Set()
  // an inner expression: the counter, the item's names, literals, elements `arr[base + i]` of buffers, other names (tested to be Numbers)
  const innerPure = (e) => {
    if (isName(e)) { if (e !== i && e !== b && !own.has(e)) numbers.add(e); return true }
    if (loopLitVal(e) != null) return true
    if (!Array.isArray(e)) return false
    const a = access(e, i)
    if (a) { if (!buffers.has(a.arr) || a.base && a.base !== b && !own.has(a.base)) return false; reads.push(a); return true }
    return OPS.has(e[0]) && e.slice(1).every(innerPure)
  }
  for (const s of stmts) {
    if (!Array.isArray(s) || s[0] !== '=' || s.length !== 3) return null
    const [, t, v] = s
    if (isName(t)) { if (!lets.has(t)) return null }
    else { const a = access(t, i); if (!a || !buffers.has(a.arr) || a.base && a.base !== b && !own.has(a.base)) return null; stores.push(a) }
    if (!innerPure(v)) return null
  }
  if (!stores.length) return null
  // the bound and the bases are read before the pair's loops: nothing in them writes one
  const wrote = new Set(stmts.filter(s => isName(s[1])).map(s => s[1]))
  if (wrote.has(l) || [...stores, ...reads].some(a => a.base && wrote.has(a.base))) return null
  const written = new Set(stores.map(a => a.arr))
  // the declarations read no array the inner loop writes; the counter names nothing the loop writes
  for (const a of arraysRead) if (written.has(a)) return null
  if (!own.has(l) && !(isName(l) && !written.has(l))) return null
  if (own.has(i) || own.has(b)) return null
  // the names tested to be Numbers must not be written in the loop (the invariants)
  for (const x of numbers) if (cm.has(x) || some(body, s => (s[0] === '=' || s[0] === '+=' || s[0] === '-=' || s[0] === '++' || s[0] === '--') && s[1] === x)) return null
  if (numbers.has(i) || numbers.has(l)) return null
  // the pairs of accesses that must miss: per written array, A's write against B's every access and B's write against A's
  const conflicts = []
  for (const s of stores) for (const r of [...stores, ...reads]) if (r.arr === s.arr) conflicts.push([s.base, r.base])
  return { L, b, n, decls, own, i, i0: loopLitVal(i0), l, stmts, conflicts, numbers }
}

function tryJam(stmt, cm, buffers) {
  const P = plan(stmt, cm, buffers)
  if (!P) return null
  const id = freshLoopId()
  const { b, n, i, i0, l } = P
  const nm = (x, s) => `${x}${T}j${s}${id}`
  // item A: the item at b, its names renamed; item B: the item at b + 1
  const ren = (s) => new Map([...P.own].map(x => [x, nm(x, s)]))
  const renA = ren('a'), renB = ren('b')
  const bNext = `${T}jn${id}`
  const sub = (node, names, at) => cloneWithSubst(node, new Map(at ? [[b, at]] : []), names)
  const declsA = P.decls.map(d => sub(d, renA)), declsB = P.decls.map(d => sub(d, renB, bNext))
  // an index base in an item's names: the item's own, the counter (b + 1 for B), 0 for none
  const name = (x, names) => x == null ? lit(0) : x === b ? (names === renB ? bNext : b) : names.get(x) ?? x
  const bodyA = P.stmts.map(s => sub(s, renA)), bodyB = P.stmts.map(s => sub(s, renB, bNext))
  const lA = name(l, renA), lB = name(l, renB)
  // A's writes against B's accesses, B's writes against A's: [base, base + l) apart
  const apart = (x, y, lx, ly) => or(['<=', ['+', x, lx], y], ['<=', ['+', y, ly], x])
  const tests = [word(lA), word(lB)]
  for (const [w, r] of P.conflicts) {
    tests.push(apart(name(w, renA), name(r, renB), lA, lB), apart(name(w, renB), name(r, renA), lB, lA))
  }
  for (const x of P.numbers) tests.push(numberGuard(x))
  const loop = (from, to, body) => ['for', ['let', ['=', i, from]], ['<', i, to], ['++', i], [';', ...body]]
  const m = `${T}jm${id}`
  const both = [';',
    ['const', ['=', m, ['?:', ['<', lA, lB], lA, lB]]],
    loop(lit(i0), m, [...bodyA, ...bodyB]),
    loop(['?:', ['<', m, lit(i0)], lit(i0), m], lA, bodyA),
    loop(['?:', ['<', m, lit(i0)], lit(i0), m], lB, bodyB)]
  const apartNot = [';', loop(lit(i0), lA, bodyA), loop(lit(i0), lB, bodyB)]
  const pair = [';', ['const', ['=', bNext, ['+', b, lit(1)]]], ...declsA, ...declsB, ['if', and(tests), ['{}', both], ['{}', apartNot]]]
  // (an odd last item runs once: its loop cold)
  const alone = cloneWithSubst(P.L.body, new Map())
  walkAst(alone, { enter: (x) => { if (x[0] === 'for') { x.cold = true; if (Array.isArray(x[4])) x[4].cold = true } } })
  let out = ['for', P.L.init, P.L.cond, ['=', b, ['+', b, lit(2)]],
    [';', ['if', ['<', ['+', b, lit(1)], n], ['{}', pair], ['{}', alone]]]]
  // (a bound of no known kind is tested once: an object's valueOf would run another number of times)
  // (a module constant is a literal to the emitter)
  if (isName(n) && !ctx.scope.consts?.has(n)) out = ['if', numberGuard(n), ['{}', [';', out]], ['{}', [';', stmt]]]
  // the copy's declarations under names of its own
  const owned = new Set()
  collectBindings(out, owned)
  owned.delete(b)
  out = cloneWithSubst(out, new Map(), new Map([...owned].map(x => [x, `${x}${T}jd${freshId(ctx)}`])))
  return [out]
}

/**
 * The typed-array parameters of each function that hold buffers of their own: every call of
 * it (none from outside, none through a value) passes, for each, a fresh allocation of the
 * caller or a parameter of the caller that holds one, and no call passes one name twice.
 * (narrowSignatures has not typed the parameters yet: a fresh `new TypedArray` is the proof.)
 */
function bufferParams(programFacts, freshOf) {
  const sitesOf = new Map()
  for (const cs of programFacts.callSites) {
    if (!cs.callerFunc) continue
    const l = sitesOf.get(cs.callee); l ? l.push(cs) : sitesOf.set(cs.callee, [cs])
  }
  const memo = new Map()
  const of = (func, depth = 0) => {
    if (memo.has(func)) return memo.get(func)
    memo.set(func, new Set())
    const params = func.sig?.params, sites = sitesOf.get(func.name)
    if (!params || !sites?.length || depth > 8 || isExported(func) || programFacts.addressTakenNames?.has(func.name)) return memo.get(func)
    const held = (arg, caller) => typeof arg === 'string' && (freshOf(caller).has(arg) || of(caller, depth + 1).has(arg))
    const out = new Set()
    for (let k = 0; k < params.length; k++)
      if (sites.every(cs => k < (cs.argList?.length ?? 0) && held(cs.argList[k], cs.callerFunc))) out.add(params[k].name)
    // (a call passing one buffer twice: no parameter of it is a buffer of its own)
    for (const cs of sites) {
      const seen = new Set()
      for (let k = 0; k < params.length; k++) if (out.has(params[k].name)) {
        const a = cs.argList[k]
        if (seen.has(a)) { out.clear(); break }
        seen.add(a)
      }
    }
    memo.set(func, out)
    return out
  }
  return of
}

/** Pair the items of every function's item loops (a plan pass: the summary reads the pair's fresh names). */
export function jamLoopItems(programFacts) {
  if (ctx.transform.optimize?.jamItems !== true) return false
  const freshFns = freshReturningFuncs(ctx.funcs.list)
  const freshMemo = new Map()
  const freshOf = (func) => { let f = freshMemo.get(func); if (!f) freshMemo.set(func, f = func?.body ? freshTypedArrayLocals(func.body, null, freshFns) : new Set()); return f }
  const paramsOf = bufferParams(programFacts, freshOf)
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    const buffers = new Set([...paramsOf(func), ...freshOf(func)])
    if (buffers.size === 0) continue
    const cm = closureMutatedVars(frameNode(func))
    const body = rewriteBlocks(func.body, stmt => tryJam(stmt, cm, buffers))
    if (body === func.body) continue
    invalidateProgramFactsCache(func.body)
    invalidateBodies([func.body])
    func.body = body
    changed = true
  }
  return changed
}
