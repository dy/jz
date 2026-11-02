// Partial unroll (×2) + scalar replacement of a unit-stride ARRAY RECURRENCE.
//
// A DP/scan loop that reads `arr[j-1]` and writes `arr[j]` (unit stride) carries the
// just-written value to the next iteration THROUGH MEMORY: it stores `arr[j]`, then the next
// iteration loads `arr[j-1]` — the very cell it just wrote. V8/TurboFan forwards that store→load
// and unrolls the loop internally; Cranelift/wasmtime and the baseline tiers do neither, so the
// loop pays a store→load round trip plus full per-iteration overhead on every cell. clang/gcc
// fix exactly this with this transform — measured 2.15× on wasmtime for the Levenshtein DP
// (V8-neutral, bit-exact).
//
// Recognized (post-prepare AST): a unit-stride `for (let j = LO; j </<= HI; j++)` whose body, for
// ONE array `arr`, has a single store `arr[j] = <var>` and ≥1 read `arr[j-1]`, accesses `arr` at
// no other index, never aliases `arr` elsewhere, and contains no call / nested loop /
// continue / return / closure (a `break` leaves the pair loop as it leaves the loop: no cell
// after it runs either way). The `arr[j-1]` read becomes a scalar `left` seeded from `arr[LO-1]`
// and refreshed after each store; the body is then unrolled ×2 (with a 1-cell tail) so the carry
// between the paired cells lives in a register and the loop overhead is halved. A `LO <= HI` guard
// keeps the seed load in step with the original (which reads `arr[LO-1]` only when it iterates),
// and falls back to the untouched loop on the empty range — sound for any trip count.
//
// The pairs stay one counted `for` over its own counter, stepped by 2, the second cell under
// the loop's test one cell on (`for (let j = LO; j <= HI; j += 2) { cell(j); if (j + 1 <= HI)
// cell(j + 1) }`): the loop's test bounds every read, and no tail reads at a counter past
// the loop. A plan sweep (`unrollRecurrences`, ahead of the counted-loop passes) rewrites
// every function, after the loop versioning (plan/integral-loops.js): the pairs are of the
// versions' copies, so a copy's test of a sum's wide side goes with the cell it precedes, and
// the summary sees the carry as it sees any source loop — a carry the summary never kinded
// was typed by the emitter's defaults alone, a Number through a truncation where its array
// holds int32s.

import { ctx } from '../ctx.js'
import { loopLitVal, litN, unitIncVar, normalizeLoop, freshLoopId, loopHazards, rewriteBlocks, closureMutatedVars } from './loop-model.js'
import { setFuncBody } from './analyze.js'
import { frameNode } from '../function.js'
import { cloneIR } from '../ir.js'
import { walkAst, some, isBlockBody, MUTATE_OPS, T } from '../ast.js'
import { K, core, tagOf } from '../summary/kind.js'
import { SOURCE_FULL, nodeSize } from '../growth.js'
import { counterInit } from '../static.js'

const isArr = (n) => Array.isArray(n)   // wrap (not alias): the self-compile kernel rejects a builtin used as a first-class value
const isIvMinus1 = (n, iv) => isArr(n) && n[0] === '-' && n[1] === iv && litN(n[2], 1)   // (iv - 1)

// Ops whose presence makes duplicating the body in place unsound (control that escapes the cell,
// or a call that could alias/mutate `arr` or reorder side effects).
// (a `break` leaves the pair loop as it leaves the loop: no cell after it runs either way)
const REJECT = new Set(['for', 'while', 'continue', 'return',
  'throw', 'catch', 'finally', '=>', 'label'])
const hasUnsafe = (n) => some(n, node => REJECT.has(node[0]) || (node[0] === '()' && typeof node[1] === 'string'))   // function call `f(args)`
// The recurrence's cells: a `Math` function (prepare names it `math.<name>`) reaches no array.
const hasUnsafeCell = (n) => some(n, node => REJECT.has(node[0]) || (node[0] === '()' && typeof node[1] === 'string' && !node[1].startsWith('math.')))

// What a read of the element just stored returns, by the array's constructor: the store's
// conversion to the element type. A plain array keeps the value as stored; an element type
// whose conversion has no source form here (clamped, half-float, BigInt) keeps the loop.
const lit = (v) => [null, v]
const READBACK = {
  Float64Array: e => e,
  Float32Array: e => ['()', 'math.fround', e],
  Int32Array: e => ['|', e, lit(0)],
  Uint32Array: e => ['>>>', e, lit(0)],
  Int16Array: e => ['>>', ['<<', e, lit(16)], lit(16)],
  Uint16Array: e => ['&', e, lit(65535)],
  Int8Array: e => ['>>', ['<<', e, lit(24)], lit(24)],
  Uint8Array: e => ['&', e, lit(255)],
}
const readbackOf = (view, arr) => {
  const k = view?.kindOfExpr(arr)
  if (k == null) return null
  if (tagOf(core(k)) === K.ARRAY) return e => e
  const ctor = view.typedPayloadCtorOfExpr(arr)
  return ctor ? READBACK[ctor.replace(/^new\./, '').replace(/\.(?:any)?view$/, '')] ?? null : null
}

// Substitute every value-reference of `iv` with `to`; leave the op slot and property keys.
const subIv = (n, iv, to) => {
  if (n === iv) return cloneIR(to)
  if (!isArr(n)) return n
  if (n[0] === '.' && n.length === 3) return ['.', subIv(n[1], iv, to), n[2]]
  return [n[0], ...n.slice(1).map(c => subIv(c, iv, to))]
}

// Rename every let/const-DECLARED var in `stmts` with a suffix, throughout — so the 2nd unrolled
// cell's locals don't collide with the 1st. Loop-carried outer vars (assigned, not declared here)
// are untouched, so the recurrence still threads through them.
function renameDecls(stmts, suf) {
  const declared = new Set()
  for (const s of stmts) walkAst(s, { enter: n => {
    if (n[0] === 'let' || n[0] === 'const')
      for (let k = 1; k < n.length; k++) if (isArr(n[k]) && n[k][0] === '=' && typeof n[k][1] === 'string') declared.add(n[k][1])
  } })
  if (!declared.size) return stmts
  const ren = (n) => {
    if (typeof n === 'string') return declared.has(n) ? n + suf : n
    if (!isArr(n)) return n
    if (n[0] === '.' && n.length === 3) return ['.', ren(n[1]), n[2]]
    return [n[0], ...n.slice(1).map(ren)]
  }
  return stmts.map(ren)
}

// Replace `arr[iv-1]` reads with `left`; keep the store; emit `left = <the stored element>` after each store.
function scalarReplace(stmts, arr, iv, left, carried) {
  const repl = (n) => {
    if (!isArr(n)) return n
    if (n[0] === '[]' && n[1] === arr && isIvMinus1(n[2], iv)) return left
    if (n[0] === '.' && n.length === 3) return ['.', repl(n[1]), n[2]]
    return [n[0], ...n.slice(1).map(repl)]
  }
  const out = []
  for (const s of stmts) {
    out.push(repl(s))
    if (isArr(s) && s[0] === '=' && isArr(s[1]) && s[1][0] === '[]' && s[1][1] === arr && s[1][2] === iv)
      out.push(['=', left, carried])
  }
  return out
}

function tryUnroll(stmt, cm, view) {
  // (an empty statement is no loop; a loop a version left as written runs cold: no pair of it)
  if (!isArr(stmt) || stmt.cold) return null
  const L = normalizeLoop(stmt)
  if (!L || L.kind !== 'for') return null
  const body = L.body
  if (!isArr(body) || body[0] !== ';') return null
  const iv = unitIncVar(L.step)
  if (!iv) return null

  // init `let iv = LO` alone, LO a literal ≥ 1 (so arr[LO-1] is a valid in-bounds index):
  // both arms restate the head as that declaration, which another one could move
  // (`let j = 1, c = (j = 2)` starts at 2) or the body could read
  if (!(isArr(L.init) && L.init[0] === 'let' && L.init.length === 2 && isArr(L.init[1]) && L.init[1][0] === '=' && L.init[1][1] === iv)) return null
  const LO = L.init[1][2], loVal = loopLitVal(LO)
  if (loVal == null || loVal < 1) return null

  // cond `iv <= HI` / `iv < HI`, HI loop-invariant
  if (!(isArr(L.cond) && (L.cond[0] === '<=' || L.cond[0] === '<') && L.cond[1] === iv)) return null
  const cmpOp = L.cond[0], HI = L.cond[2]
  if (!(typeof HI === 'string' || loopLitVal(HI) != null)) return null

  if (hasUnsafeCell(body)) return null
  const stmts = body.slice(1)

  // exactly one store `arr[iv] = <value>` — the recurrence array + carried value
  // (a value other than a name, `a[i] = a[i - 1] + x[i]`, is named before the store)
  let arr = null, storeVal = null, nStore = 0
  for (const s of stmts)
    if (isArr(s) && s[0] === '=' && isArr(s[1]) && s[1][0] === '[]' && s[1][2] === iv) {
      arr = s[1][1]; storeVal = s[2]; nStore++
    }
  if (nStore !== 1 || typeof arr !== 'string') return null
  if (storeVal === iv || storeVal === arr) return null
  // the carry holds what a read of the stored element returns
  const readback = readbackOf(view, arr)
  if (!readback) return null

  // every `arr[...]` is `arr[iv]` or `arr[iv-1]`, the only write is the store, ≥1 recurrence read,
  // and `arr` never appears bare (passed/aliased)
  let hasRec = false, bad = false
  walkAst(body, { enter: n => {
    if (n[0] === '[]' && n[1] === arr) {
      if (n[2] === iv) {} else if (isIvMinus1(n[2], iv)) hasRec = true; else bad = true
    }
    if (n[0] === '=' && isArr(n[1]) && n[1][0] === '[]' && n[1][1] === arr && n[1][2] !== iv) bad = true
    if (!(n[0] === '[]' || n[0] === '.')) for (let k = 1; k < n.length; k++) if (n[k] === arr) bad = true
  } })
  if (bad || !hasRec) return null

  // The carry `left = storeVal` is emitted right after the store, so a recurrence read AFTER the
  // store would see this cell's value, not arr[iv-1]. Require every arr[iv-1] read to precede it.
  const storeIdx = stmts.findIndex(s => isArr(s) && s[0] === '=' && isArr(s[1]) && s[1][0] === '[]' && s[1][1] === arr && s[1][2] === iv)
  const readsRec = (n) => some(n, m => m[0] === '[]' && m[1] === arr && isIvMinus1(m[2], iv), { skipArrow: false })
  for (let k = storeIdx + 1; k < stmts.length; k++) if (readsRec(stmts[k])) return null

  // iv assigned only by the step; iv/arr/HI loop-invariant (not mutated, incl. via a closure call)
  const hz = loopHazards(cm, body)
  if (hz.mutated(iv) || cm.has(arr)) return null
  if (typeof HI === 'string' && hz.mutated(HI)) return null

  // --- transform ---
  const id = freshLoopId()
  const left = `${arr}${T}rec${id}`   // the array's carried cell (a declared name, not a temp: the narrowing passes type it)
  let named = stmts
  if (typeof storeVal !== 'string') {
    const v = `${arr}${T}rv${id}`
    named = stmts.flatMap((s, k) => k !== storeIdx ? [s] : [['const', ['=', v, storeVal]], ['=', s[1], v]])
    storeVal = v
  }
  const bodyS = scalarReplace(named, arr, iv, left, readback(storeVal))
  // Each copy declares its own names, the counter included (the else arm keeps
  // the loop as written): a name declared once per function is what every
  // later pass assumes.
  const j = `${iv}${T}j${id}`
  const cellJ = (tag) => renameDecls(bodyS.map(s => subIv(s, iv, j)), `${T}${tag}${id}`)
  const cellJ1 = renameDecls(bodyS.map(s => subIv(s, iv, ['+', j, [null, 1]])), `${T}r${id}`)

  const seed = ['let', ['=', left, ['[]', arr, [null, loVal - 1]]]]   // left = arr[LO-1]
  // The loop's own test keeps the first cell in range; the second runs under
  // the same test one cell on (`j + 1 <= HI`), so the last odd cell needs no
  // tail after the loop (a tail reads at a counter no loop test bounds).
  const main = ['for', ['let', ['=', j, cloneIR(LO)]], [cmpOp, j, cloneIR(HI)], ['+=', j, [null, 2]],
    [';', ...cellJ('p'), ['if', [cmpOp, ['+', j, [null, 1]], cloneIR(HI)], [';', ...cellJ1]]]]
  // a statement list, as prepare leaves an `if`'s arms (a block of its own is a scope)
  const block = [';', seed, main]
  // Run the unrolled form only on a non-empty range (so the seed's arr[LO-1] load matches the
  // original, which reads it only when it iterates); otherwise the untouched loop.
  return [['if', [cmpOp, cloneIR(LO), cloneIR(HI)], block, stmt]]
}

export function unrollRecurrence(body, cm, view) {
  return rewriteBlocks(body, stmt => tryUnroll(stmt, cm, view))
}

/** Plan sweep: the recurrence loops of every function, its closures' included
 *  (a closure's writes are in the function's census). */
export const unrollRecurrences = () => {
  const o = ctx.transform.optimize
  if (!o || o.unrollRecurrence === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !isBlockBody(func.body)) continue
    // (a function past its growth budget keeps its loops as written, src/growth.js)
    if (nodeSize(func.body) > SOURCE_FULL) continue
    const body = unrollRecurrence(func.body, closureMutatedVars(frameNode(func)), ctx.summary?.at(func.sig))
    if (body === func.body) continue
    setFuncBody(func, body)
    changed = true
  }
  return changed
}

// ── Serial-chain ×2 unroll (speed tier) ──────────────────────────────────────
//
// The crc/hash class: a countable unit-stride loop whose body carries a SCALAR
// through an element-read whose ADDRESS depends on that scalar
// (`crc = table[(crc ^ buf[i]) & 255] ^ (crc >>> 8)`). The address-carried
// dependency makes the loop provably non-vectorizable (no SIMD recognizer can
// ever take it — the next address needs this iteration's value), so unrolling
// ×2 costs nothing downstream and halves the loop overhead (IV update + bound
// compare + branch per TWO elements — LLVM does exactly this; measured ~13 vs
// ~8.5 ops/byte against clang's wasm on the crc32 kernel).
//
// Recognized: `for (let i = LO; i </<= HI; i++)` (LO literal ≥ 0, HI invariant
// name/literal), body a plain statement list with NO element stores, no calls /
// control / closures / nested loops (hasUnsafe), iv written only by the step,
// and ≥1 element read whose index mentions a body-ASSIGNED outer scalar (the
// carried chain). The transform emits pair + tail, the loop's head kept whole:
//   let i = LO, …; while (i < HI-1) { body; body[i+1]; i += 2 } ; if (i </<= HI) body
// Each copy is a verbatim iteration (checked reads and all), so values are
// exact for every input incl. OOB — only the iteration grouping changes.
// (the chain's tail copy of the body stands after the loop: a `break` there has no loop to leave)
const hasBreak = (n) => some(n, node => node[0] === 'break')
function tryUnrollScalarChain(stmt, cm) {
  const DBG = typeof process !== 'undefined' && process.env?.JZ_DBG_USC
  const L = normalizeLoop(stmt)
  if (!L || L.kind !== 'for') { if (DBG && isArr(stmt) && (stmt[0] === 'for' || stmt[0] === 'while')) console.error('[usc] not-for', stmt[0]); return null }
  // a single-statement body arrives bare (`for (…) c = …`) — normalize to a list
  const body = isArr(L.body) && L.body[0] === ';' ? L.body
    : isArr(L.body) ? [';', L.body] : null
  if (!body) { if (DBG) console.error('[usc] body-shape'); return null }
  const iv = unitIncVar(L.step)
  if (!iv) { if (DBG) console.error('[usc] no-unit-iv'); return null }
  // the head declares the counter, which starts at what the head gives it (counterInit:
  // no other declaration of the head writes it); the pair keeps the head whole
  if (!(isArr(L.init) && L.init[0] === 'let')) { if (DBG) console.error('[usc] init-shape'); return null }
  const LO = counterInit(L.init, iv), loVal = LO == null ? null : loopLitVal(LO)
  if (loVal == null || loVal < 0) { if (DBG) console.error('[usc] lo', JSON.stringify(LO)); return null }
  if (!(isArr(L.cond) && (L.cond[0] === '<=' || L.cond[0] === '<') && L.cond[1] === iv)) { if (DBG) console.error('[usc] cond-shape'); return null }
  const cmpOp = L.cond[0], HI = L.cond[2]
  if (!(typeof HI === 'string' || loopLitVal(HI) != null)) { if (DBG) console.error('[usc] hi', JSON.stringify(HI)); return null }
  if (hasUnsafe(body) || hasBreak(body)) { if (DBG) console.error('[usc] unsafe'); return null }
  const stmts = body.slice(1)

  // no element/property stores anywhere — the class is a pure scan
  const hasStore = some(body, (n) => (n[0] === '=' || (typeof n[0] === 'string' && n[0].endsWith('=') && n[0] !== '==' && n[0] !== '<=' && n[0] !== '>=' && n[0] !== '!=' && n[0] !== '===' && n[0] !== '!=='))
      && isArr(n[1]) && (n[1][0] === '[]' || n[1][0] === '.'), { skipArrow: false })
  if (hasStore) return null

  // carried scalars: outer names assigned at body top level (not declared here)
  const declared = new Set()
  for (const s of stmts) if (isArr(s) && (s[0] === 'let' || s[0] === 'const'))
    for (let k = 1; k < s.length; k++) if (isArr(s[k]) && s[k][0] === '=' && typeof s[k][1] === 'string') declared.add(s[k][1])
  const carried = new Set()
  walkAst(body, { enter: n => {
    if (typeof n[1] === 'string' && n[1] !== iv && !declared.has(n[1])
        && (n[0] === '=' || n[0] === '+=' || n[0] === '-=' || n[0] === '^=' || n[0] === '|=' || n[0] === '&=' || n[0] === '*=' || n[0] === '>>=' || n[0] === '>>>=' || n[0] === '<<='))
      carried.add(n[1])
  } })
  if (!carried.size) return null

  // A scalar the body only steps by a constant (`ix += 1`, the strided kernels'
  // cursor) is a counter beside the loop's own, an affine address the lane
  // vectorizer rewrites over the counter (optimize/vectorize/counter-run.js):
  // no chain runs through it.
  const stepOf = (n, name) => n[1] === name && ((n[0] === '+=' || n[0] === '-=') ? loopLitVal(n[2]) != null
    : n[0] === '=' ? isArr(n[2]) && (n[2][0] === '+' || n[2][0] === '-') && n[2][1] === name && loopLitVal(n[2][2]) != null : false)
  const stepped = new Set()
  for (const s of carried) {
    let steps = 0, writes = 0
    walkAst(body, { enter: n => { if (n[1] === s && (n[0] === '=' || (typeof n[0] === 'string' && n[0].endsWith('=') && n[0].length > 1 && !['==', '!=', '<=', '>=', '===', '!=='].includes(n[0])) || n[0] === '++' || n[0] === '--')) { writes++; if (stepOf(n, s)) steps++ } } })
    if (writes && writes === steps) stepped.add(s)
  }

  // the chain proof: some element read's INDEX mentions a carried scalar
  const mentions = (n, name) => n === name || (isArr(n) && n.some(c => mentions(c, name)))
  const chained = some(body, (n) => {
    if (n[0] !== '[]' || n.length !== 3) return false
    for (const s of carried) if (!stepped.has(s) && mentions(n[2], s)) return true
    return false
  }, { skipArrow: false })
  if (!chained) { if (DBG) console.error('[usc] no-chain, carried:', [...carried]); return null }

  // stability: iv written only by the step; carried names + HI not closure-mutated
  const hz = loopHazards(cm, body)
  if (hz.mutated(iv)) return null
  for (const s of carried) if (cm.has(s)) return null
  if (typeof HI === 'string' && hz.mutated(HI)) return null

  // --- transform: pair + tail ---
  const id = freshLoopId()
  const cell = () => stmts.map(cloneIR)
  const cell1 = renameDecls(stmts.map(s => subIv(cloneIR(s), iv, ['+', iv, [null, 1]])), `$c${id}`)
  const letIv = cloneIR(L.init)
  const twoFit = cmpOp === '<=' ? ['<', iv, cloneIR(HI)] : ['<', iv, ['-', cloneIR(HI), 1]]
  const main = ['while', twoFit,
    [';', ['{}', [';', ...cell()]], ['{}', [';', ...cell1]], ['=', iv, ['+', iv, 2]]]]
  const tail = ['if', [cmpOp, iv, cloneIR(HI)],
    ['{}', [';', ...cell(), ['=', iv, ['+', iv, 1]]]]]
  return [['{}', [';', letIv, main, tail]]]
}

/** Speed-tier pass: ×2-unroll every serial-chain scan loop in `body`. */
export function unrollScalarChains(body, cm) {
  return rewriteBlocks(body, stmt => tryUnrollScalarChain(stmt, cm))
}

// ── Keyed recurrence: the next key mixes off the chain (speed tier) ─────────
//
// A counted loop whose scalar reads a table at a key of itself and the
// iteration's input, and keeps the rest of itself by xor:
//   for (let i = LO; i < HI; i++) v = Q(T[M(P(v) ^ X(i))] ^ S(v))
// a byte-wise CRC of any width, reflected (`c = table[(c ^ buf[i]) & 0xff] ^
// (c >>> 8)`) or not (`c = table[((c >>> 24) ^ buf[i]) & 0xff] ^ (c << 8)`),
// where P and Q are shifts by constants, masks and truncations: maps that keep
// xor. An iteration's chain runs from the read through the xor of S(v), P, the
// xor of the next input and M to the next read, though the input waits on
// nothing. Xor is associative and P and Q distribute over it, so the next key
// is P(Q(t)) ^ (P(Q(S(v))) ^ X(i + 1)): the input mixes into what the scalar
// keeps while the read is in flight, and the loop carries the key beside the
// scalar (back-substitution: Schlansker and Kathail, "Critical path reduction
// for scalar programs", MICRO 1995). One xor leaves every iteration's chain:
// crc32 runs 0.88x its time on an EPYC 7763, where it had tied V8's code for
// the JS, and 0.81x on an Apple M4.
//
// The first key is taken before the loop, under its test, and the loop runs
// from the second iteration on; the last runs as written, after it. X(i), any
// reads that write and call nothing, is read and converted where it was,
// between the tests of i and i + 1, in the order of its leaves (the next key is
// the key's own xor with P(Q(s)) where P(v) stood): every element of the input
// is read once, in its order, none past the range, and the bound, of the same
// kind, is evaluated as often, where it was. What moves past a test is the
// table's read, of a typed array of Numbers, M, arithmetic of literals and of
// names the loop does not write, and S, arithmetic of the scalar, which holds a
// Number or undefined on entry (no parameter: its every other write a Number
// while it holds one). Temporaries the body declares for the update and other
// declarations of the loop's head (reading no counter) are read in place.

// operators that take Numbers to a Number and run nothing else
const NUMERIC = new Set(['^', '|', '&', '<<', '>>', '>>>', '+', '-', '*', '/', '%', '~', 'u-', 'u+'])

/** The operand of `n` a map that keeps xor carries (a shift by a constant, a
 *  mask, a truncation), as its index, else 0. */
const xorLinearArg = (n) => {
  if (!isArr(n) || n.length !== 3) return 0
  const op = n[0]
  if (op === '>>>' || op === '>>' || op === '<<') return loopLitVal(n[2]) != null ? 1 : 0
  if (op === '&') return loopLitVal(n[2]) != null ? 1 : loopLitVal(n[1]) != null ? 2 : 0
  if (op === '|') return litN(n[2], 0) ? 1 : litN(n[1], 0) ? 2 : 0
  return 0
}
/** The leaves of the xor tree at `n`, in evaluation order. */
const xorLeaves = (n, out) => {
  if (isArr(n) && n[0] === '^' && n.length === 3) { xorLeaves(n[1], out); xorLeaves(n[2], out) } else out.push(n)
  return out
}
const xorOf = (leaves) => {
  let e = cloneIR(leaves[0])
  for (let k = 1; k < leaves.length; k++) e = ['^', e, cloneIR(leaves[k])]
  return e
}
/** `e` under the maps of `chain` ([node, operand index], outermost first). */
const rewrap = (chain, e) => {
  for (let k = chain.length - 1; k >= 0; k--) {
    const c = cloneIR(chain[k][0])
    c[chain[k][1]] = e
    e = c
  }
  return e
}
// the end of the operands of `n` that name values: a literal's value and a member read's key name none
const ends = (n) => n[0] == null || n[0] === 'str' ? 1 : n[0] === '.' || n[0] === '?.' ? 2 : n.length
/** The [node, operand index] links from `n` down to the name `v`, or null. */
const pathTo = (n, v) => {
  if (n === v) return []
  if (!isArr(n)) return null
  for (let k = 1; k < ends(n); k++) {
    const p = pathTo(n[k], v)
    if (p) return [[n, k], ...p]
  }
  return null
}
const countOf = (n, v) => {
  if (n === v) return 1
  if (!isArr(n)) return 0
  let c = 0
  for (let k = 1; k < ends(n); k++) c += countOf(n[k], v)
  return c
}
/** `tree` with the node or name `at` replaced by `by`, copied above it. */
const replaced = (tree, at, by) => {
  if (tree === at) return by
  if (!isArr(tree)) return tree
  let out = null
  for (let k = 1; k < ends(tree); k++) {
    const c = replaced(tree[k], at, by)
    if (c !== tree[k]) { out ??= tree.slice(); out[k] = c }
  }
  return out ?? tree
}
/** `e` is a Number of literals, the names `ok` takes and elements of typed arrays of Numbers. */
const numeric = (e, ok, typed) => typeof e === 'string' ? ok(e)
  : isArr(e) && (loopLitVal(e) != null
    || e[0] === '[]' && e.length === 3 && typeof e[1] === 'string' && typed(e[1]) && numeric(e[2], ok, typed)
    || NUMERIC.has(e[0]) && (e.length === 2 || e.length === 3) && numeric(e[1], ok, typed) && (e.length === 2 || numeric(e[2], ok, typed)))
/** `e` reads and computes, writing and calling nothing: names, literals,
 *  NUMERIC operators, element reads and member reads. */
const pure = (e) => typeof e === 'string' || isArr(e) && (loopLitVal(e) != null
  || e[0] === '.' && e.length === 3 && typeof e[2] === 'string' && pure(e[1])
  || (e[0] === '[]' || NUMERIC.has(e[0])) && (e.length === 2 || e.length === 3) && pure(e[1]) && (e.length === 2 || pure(e[2])))
/** `e` evaluates to a Number or undefined, or throws, where `v` holds one:
 *  a literal, `v`, an element of a typed array of Numbers, or an operator of
 *  NUMERIC over one (both operands of `+`, which joins a string). */
const numberResult = (e, v, typed) => {
  if (e === v) return true
  if (!isArr(e)) return false
  if (loopLitVal(e) != null) return true
  if (e[0] === '[]') return e.length === 3 && typeof e[1] === 'string' && typed(e[1])
  if (!NUMERIC.has(e[0]) || e.length < 2 || e.length > 3) return false
  if (e.length === 2) return numberResult(e[1], v, typed)
  return e[0] === '+' ? numberResult(e[1], v, typed) && numberResult(e[2], v, typed)
    : numberResult(e[1], v, typed) || numberResult(e[2], v, typed)
}
/** The scalar `v` holds a Number or undefined where the update `upd` reads it:
 *  declared once, as a statement of `body`, its value and every write's but
 *  `upd`'s a Number while it holds one. */
const numericScalar = (body, v, upd, typed) => {
  let decls = 0, ok = true
  walkAst(body, { enter: (n, parent) => {
    if (!ok || n === upd) return false
    if (n[0] === 'let' || n[0] === 'const' || n[0] === 'var') {
      let here = 0
      for (let k = 1; k < n.length; k++) {
        const d = n[k]
        if (d === v) here++
        else if (isArr(d) && d[0] === '=' && d[1] === v) { here++; if (!numberResult(d[2], v, typed)) ok = false }
        else if (isArr(d) && d[0] === '=' && countOf(d[1], v)) ok = false
      }
      if (here && !(isArr(parent) && parent[0] === ';')) ok = false
      decls += here
      return
    }
    if (n[1] !== v || !MUTATE_OPS.has(n[0])) return
    const op = n[0]
    if (op === '++' || op === '--') return
    const base = op.slice(0, -1)
    if (!(op === '=' ? numberResult(n[2], v, typed) : NUMERIC.has(base) && (base !== '+' || numberResult(n[2], v, typed)))) ok = false
  } })
  return ok && decls === 1
}

/** The statements of a loop body, unwrapped from its blocks. */
const bodyStmts = (n) => {
  while (isArr(n) && n[0] === '{}' && n.length === 2) n = n[1]
  return isArr(n) && n[0] === ';' ? n.slice(1) : [n]
}
/** The update `stmts` end in, its temporaries read in place: the declarations
 *  before it, each of a name the update reads once and nothing else names, of a
 *  value that writes and calls nothing. Returns the update with them in place, or null. */
const inlineTemps = (stmts, loopBody) => {
  let upd = stmts[stmts.length - 1]
  for (let k = stmts.length - 2; k >= 0; k--) {
    const d = stmts[k]
    if (!isArr(d) || (d[0] !== 'const' && d[0] !== 'let') || d.length !== 2 || !isArr(d[1]) || d[1][0] !== '=' || typeof d[1][1] !== 'string') return null
    const name = d[1][1], init = d[1][2]
    if (!pure(init) || countOf(upd, name) !== 1 || countOf(loopBody, name) !== 2) return null
    upd = replaced(upd, name, init)
  }
  return upd
}

function tryCarryKey(stmt, cm, typed, body, params) {
  const L = normalizeLoop(stmt)
  if (!L || L.kind !== 'for') return null
  const iv = unitIncVar(L.step)
  if (!iv || !isArr(L.init) || L.init[0] !== 'let') return null
  // the head declares the counter at a literal; its other declarations read no counter
  const head = L.init.slice(1), at = head.findIndex(d => isArr(d) && d[0] === '=' && d[1] === iv)
  const loVal = at < 0 ? null : loopLitVal(head[at][2])
  if (loVal == null || !head.every((d, k) => k === at || (typeof d === 'string' ? d !== iv : isArr(d) && d[0] === '=' && typeof d[1] === 'string' && !countOf(d[2], iv)))) return null
  if (!(isArr(L.cond) && (L.cond[0] === '<' || L.cond[0] === '<=') && L.cond.length === 3 && L.cond[1] === iv)) return null
  // the bound reads and computes, as often and where it did
  const HI = L.cond[2]
  if (!pure(HI) || countOf(HI, iv)) return null
  // the body is one update of the scalar, its temporaries read in place
  const stmts = bodyStmts(L.body), node = stmts[stmts.length - 1]
  const upd = inlineTemps(stmts, L.body)
  if (!isArr(upd) || (upd[0] !== '=' && upd[0] !== '^=') || upd.length !== 3) return null
  const v = upd[1]
  if (typeof v !== 'string' || v === iv || countOf(HI, v) || cm.has(v) || params.has(v)) return null
  const rhs = upd[0] === '^=' ? ['^', v, upd[2]] : upd[2]
  // Q: the maps over the update's xor
  const Q = []
  let x = rhs
  for (let k = xorLinearArg(x); k; k = xorLinearArg(x)) { Q.push([x, k]); x = x[k] }
  if (!isArr(x) || x[0] !== '^') return null
  // one leaf reads the table at a key of the scalar; the others, S, are Numbers of the scalar
  let read = null
  const S = []
  for (const l of xorLeaves(x, [])) {
    if (!(isArr(l) && l[0] === '[]' && countOf(l, v))) { S.push(l); continue }
    if (read) return null
    read = l
  }
  if (!read || !S.length || read.length !== 3 || typeof read[1] !== 'string' || !typed(read[1]) || countOf(read, v) !== 1) return null
  if (!S.every(e => numeric(e, n => n === v, typed))) return null
  // the key: the scalar under the maps P, a leaf of the xor of the inputs X, under M
  const path = pathTo(read, v)
  let j = path.length
  while (j > 1 && xorLinearArg(path[j - 1][0]) === path[j - 1][1]) j--
  if (j < 2 || path[j - 1][0][0] !== '^' || path[j - 1][0].length !== 3) return null
  let top = j - 1
  while (top > 1 && path[top - 1][0][0] === '^' && path[top - 1][0].length === 3) top--
  const xorTop = path[top][0], P = path.slice(j), pv = j < path.length ? path[j][0] : v
  const keyLeaves = xorLeaves(xorTop, []), X = keyLeaves.filter(l => l !== pv)
  if (!X.length || X.length !== keyLeaves.length - 1 || !X.every(pure)) return null
  // M is arithmetic of literals, names the loop does not write and typed reads
  if (!numeric(replaced(read[2], xorTop, [null, 0]), n => n !== v && n !== iv, typed)) return null
  if (!numericScalar(body, v, node, typed)) return null

  // --- transform ---
  const id = freshLoopId()
  const w = `${v}${T}key${id}`, t = `${v}${T}t${id}`, s = `${v}${T}s${id}`
  const keyed = () => cloneIR(replaced(read, xorTop, w))   // the read at the carried key
  const PQ = (e) => rewrap(P, rewrap(Q, e))
  const lo = [null, loVal]
  // iteration i + 1 as written: the read, the scalar, and the key of the next,
  // the key's own xor with P(Q(s)) where P(v) stood
  const step = [';',
    ['const', ['=', t, ['|', keyed(), [null, 0]]]],
    ['const', ['=', s, ['|', xorOf(S), [null, 0]]]],
    ['=', v, rewrap(Q, ['^', t, s])],
    ['=', w, ['^', PQ(t), cloneIR(replaced(xorTop, pv, PQ(s)))]]]
  const loop = ['for', ['let', ['=', iv, [null, loVal + 1]]], [L.cond[0], iv, cloneIR(HI)], ['++', iv], step]
  const last = ['=', v, cloneIR(replaced(rhs, read, keyed()))]
  const run = ['if', [L.cond[0], lo, cloneIR(HI)], [';', ['let', ['=', w, subIv(cloneIR(xorTop), iv, lo)]], loop, last]]
  const others = head.filter((d, k) => k !== at)
  return others.length ? [['{}', [';', ['let', ...others.map(cloneIR)], run]]] : [run]
}

/** Speed-tier pass: every keyed-recurrence loop of `body` (a function's, its
 *  parameters `params`) carries its next key; `typed(name)`: the name holds a
 *  typed array of Numbers wherever the function reads it. */
export function carryKeys(body, cm, typed, params) {
  return rewriteBlocks(body, stmt => tryCarryKey(stmt, cm, typed, body, params))
}

// ── Disjoint-arm update chain → select accumulation ─────────────────────────
// A dense-int if/else-if chain whose arms each bump a DIFFERENT scalar by a
// constant — square-tracing's direction step:
//   if (dir === 0) x++; else if (dir === 1) y++; else if (dir === 2) x--; else y--
// With dir data-dependent (bitmap-driven) the branches are unpredictable — the
// dominant residual vs LLVM's layout on the trace bench. Rewrite each updated
// scalar to one unconditional add of a const ternary chain (branchless select):
//   x += (dir === 0 ? 1 : dir === 2 ? -1 : 0); y += (dir === 1 ? 1 : dir === 3 ? -1 : 0)
// SOUNDNESS: `v += 0` maps -0 → +0, so a scalar stepped by ++/--/+= K/-= K
// must never carry its ±0 distinction to a sink that sees it (minusZeroSafe).
// An int32 word stepped as the integral copy writes it, `v = (v ± K) | 0`
// (plan/integral-loops.js), takes `v = (v + (…)) | 0` instead: every value it
// holds is an int32 (int32Only), so `(v + 0) | 0` is v and no -0 arises.
// The discriminant must be a plain local, not updated by the arms.

const armUpdate = (s) => {
  if (!isArr(s)) return null
  if (s[0] === '{}' && isArr(s[1]) && s[1][0] === ';' && s[1].length === 2) return armUpdate(s[1][1])
  if (s[0] === ';' && s.length === 2) return armUpdate(s[1])
  if ((s[0] === '++' || s[0] === '--') && typeof s[1] === 'string') return { v: s[1], d: s[0] === '++' ? 1 : -1 }
  if ((s[0] === '+=' || s[0] === '-=') && typeof s[1] === 'string') {
    const c = loopLitVal(s[2])
    if (c != null && Number.isInteger(c)) return { v: s[1], d: s[0] === '+=' ? c : -c }
  }
  const e = s[0] === '=' && typeof s[1] === 'string' && isArr(s[2]) && s[2][0] === '|' && s[2].length === 3 && litN(s[2][2], 0) ? s[2][1] : null
  if (isArr(e) && (e[0] === '+' || e[0] === '-') && e.length === 3 && e[1] === s[1]) {
    const c = loopLitVal(e[2])
    if (c != null && Number.isInteger(c)) return { v: s[1], d: e[0] === '+' ? c : -c, word: true }
  }
  return null
}

// Every value `v` holds is an int32: it is declared with one, and each write
// assigns a ToInt32 result or an int32 literal.
const INT32_OPS = new Set(['|', '&', '^', '<<', '>>', '~'])
function int32Only(body, v) {
  let ok = true, declared = false
  walkAst(body, { enter: (n, parent) => {
    if (!ok) return false
    if ((n[0] === 'let' || n[0] === 'const') && n.includes(v)) ok = false
    if (!MUTATE_OPS.has(n[0]) || n[1] !== v) return
    if (parent?.[0] === 'let' || parent?.[0] === 'const') declared = true
    const c = loopLitVal(n[2])
    ok = n[0] === '=' && (isArr(n[2]) && INT32_OPS.has(n[2][0]) || c != null && (c | 0) === c && !Object.is(c, -0))
  } })
  return ok && declared
}

function trySelectArmUpdates(stmt, zeroSafe, wordSafe) {
  if (!isArr(stmt) || stmt[0] !== 'if') return null
  // walk the else-if spine collecting (const, {v, d}) arms
  const arms = []
  let d = null, node = stmt, elseArm = null
  while (isArr(node) && node[0] === 'if') {
    const [, cond, then, els] = node
    if (!(isArr(cond) && (cond[0] === '===' || cond[0] === '==') && typeof cond[1] === 'string')) return null
    if (d == null) d = cond[1]
    else if (cond[1] !== d) return null
    const k = loopLitVal(cond[2])
    if (k == null || !Number.isInteger(k)) return null
    const u = armUpdate(then)
    if (!u) return null
    arms.push({ k, u })
    node = els
  }
  if (node != null) {
    elseArm = armUpdate(node)
    if (!elseArm) return null
  }
  if (arms.length + (elseArm ? 1 : 0) < 3) return null
  if (new Set(arms.map(a => a.k)).size !== arms.length) return null
  const ups = [...arms.map(a => a.u), ...(elseArm ? [elseArm] : [])]
  const vars = new Set(ups.map(u => u.v))
  if (vars.has(d)) return null
  // (a scalar is stepped as a word in every arm or in none)
  const words = new Set(ups.filter(u => u.word).map(u => u.v))
  if (ups.some(u => !u.word && words.has(u.v))) return null
  const plain = new Set([...vars].filter(v => !words.has(v)))
  if (plain.size && !zeroSafe(plain)) return null
  if (words.size && !wordSafe(words)) return null
  // per-var delta chain over the FULL arm list (an arm not touching v
  // contributes 0 — the else delta applies only when NO chain const matches):
  //   v += (d === k0 ? δ0 : d === k1 ? δ1 : … : elseδ)
  const out = [';']
  for (const v of vars) {
    let expr = [, elseArm && elseArm.v === v ? elseArm.d : 0]
    for (let i = arms.length - 1; i >= 0; i--)
      expr = ['?:', ['===', d, [, arms[i].k]], [, arms[i].u.v === v ? arms[i].u.d : 0], expr]
    out.push(words.has(v) ? ['=', v, ['|', ['+', v, expr], [null, 0]]] : ['+=', v, expr])
  }
  return [out]
}

/** The rewrite's ONLY semantic delta is `v += 0` turning -0 into +0 — so the
 *  soundness condition is that v's ±0 distinction can never reach a sensitive
 *  sink. Comparisons (=== < <= > >=), ToInt32 ops (| & ^ << >> >>>), and index
 *  positions are ±0-blind; +/-/* chains stay safe only while their RESULT
 *  also feeds a blind sink (walked top-down with a sink flag). Any other
 *  escape of the bare name — return, call arg, store, property value, /, %,
 *  unknown op — is conservatively unsafe. Writes to v itself are fine (they
 *  replace the value). */
const ZERO_BLIND = new Set(['==', '===', '!=', '!==', '<', '<=', '>', '>=', '|', '&', '^', '<<', '>>', '>>>', '!', '&&', '||'])
const ARITH_PASS = new Set(['+', '-', '*'])
function minusZeroSafe(body, vars) {
  let safe = true
  const walk = (n, blind) => {
    if (!safe) return
    if (typeof n === 'string') { if (vars.has(n) && !blind) safe = false; return }
    if (!isArr(n)) return
    const op = n[0]
    if (op === 'str' || op == null) return
    // writes to a tracked var replace its value — target slot is fine, RHS walks
    if ((op === '=' || op === '+=' || op === '-=' || op === '++' || op === '--') && typeof n[1] === 'string') {
      for (let i = 2; i < n.length; i++) walk(n[i], false)
      return
    }
    if (op === '[]' && n.length === 3) { walk(n[1], false); walk(n[2], true); return }   // index is ToInt32
    const childBlind = ZERO_BLIND.has(op) ? true : ARITH_PASS.has(op) ? blind : false
    for (let i = 1; i < n.length; i++) walk(n[i], childBlind)
  }
  // statement level: expression results are dropped → blind at the top of each
  // statement; control-flow conditions are blind (boolean context)
  const stmts = (n) => {
    if (!safe || !isArr(n)) return
    const op = n[0]
    if (op === ';' || op === '{}') { for (let i = 1; i < n.length; i++) stmts(n[i]); return }
    if (op === 'if' || op === 'while') { walk(n[1], true); for (let i = 2; i < n.length; i++) stmts(n[i]); return }
    if (op === 'for') { for (let i = 1; i < n.length - 1; i++) stmts(n[i]); stmts(n[n.length - 1]); return }
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) if (isArr(n[i]) && n[i][0] === '=') walk(n[i][2], false)
      return
    }
    walk(n, true)
  }
  stmts(body)
  return safe
}

/** Speed-tier pass: branchless select accumulation for disjoint-arm update
 *  chains inside loops (the square-tracing direction-step class). */
export function selectArmUpdatesIn(body, cm) {
  const memo = new Map()
  const zeroSafe = (vars) => {
    for (const v of vars) if (cm.has(v)) return false
    const key = [...vars].sort().join(',')
    let r = memo.get(key)
    if (r == null) memo.set(key, r = minusZeroSafe(body, vars))
    return r
  }
  const wordSafe = (vars) => [...vars].every(v => !cm.has(v) && int32Only(body, v))
  // only rewrite chains INSIDE loops — straight-line chains predict fine
  const rewriteIn = (n) => {
    if (!isArr(n)) return n
    if (n[0] === 'for' || n[0] === 'while') {
      const walkStmts = (m) => {
        if (!isArr(m)) return m
        if (m[0] === ';' || m[0] === '{}') {
          for (let i = 1; i < m.length; i++) {
            const r = isArr(m[i]) && m[i][0] === 'if' ? trySelectArmUpdates(m[i], zeroSafe, wordSafe) : null
            m[i] = r ? r[0] : walkStmts(m[i])
          }
          return m
        }
        if (m[0] === 'if') {
          const r = trySelectArmUpdates(m, zeroSafe, wordSafe)
          if (r) return r[0]
        }
        for (let i = 1; i < m.length; i++) m[i] = walkStmts(m[i])
        return m
      }
      for (let i = 1; i < n.length; i++) n[i] = walkStmts(n[i])
      return n
    }
    for (let i = 1; i < n.length; i++) n[i] = rewriteIn(n[i])
    return n
  }
  return rewriteIn(body)
}
