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
// no other index, never aliases `arr` elsewhere, and contains no call / nested loop / break /
// continue / return / closure. The `arr[j-1]` read becomes a scalar `left` seeded from `arr[LO-1]`
// and refreshed after each store; the body is then unrolled ×2 (with a 1-cell tail) so the carry
// between the paired cells lives in a register and the loop overhead is halved. A `LO <= HI` guard
// keeps the seed load in step with the original (which reads `arr[LO-1]` only when it iterates),
// and falls back to the untouched loop on the empty range — sound for any trip count.

import { findMutations } from './analyze-scans.js'
import { litVal, litN, unitIncVar, normalizeLoop, freshLoopId } from './loop-model.js'
import { rewriteBlocks, closureMutatedVars } from './loop-model.js'

const isArr = Array.isArray
const clone = (n) => isArr(n) ? n.map(clone) : n
const isIvMinus1 = (n, iv) => isArr(n) && n[0] === '-' && n[1] === iv && litN(n[2], 1)   // (iv - 1)

// Ops whose presence makes duplicating the body in place unsound (control that escapes the cell,
// or a call that could alias/mutate `arr` or reorder side effects).
const REJECT = new Set(['for', 'while', 'do', 'for-in', 'for-of', 'break', 'continue', 'return',
  'throw', 'switch', 'try', 'catch', 'finally', '=>', 'label'])
const hasUnsafe = (n) => {
  if (!isArr(n)) return false
  if (REJECT.has(n[0])) return true
  if (n[0] === '()' && typeof n[1] === 'string') return true   // function call `f(args)`
  return n.some(hasUnsafe)
}

// Substitute every value-reference of `iv` with (iv + 1); leave the op slot and property keys.
const subPlus1 = (n, iv) => {
  if (n === iv) return ['+', iv, 1]
  if (!isArr(n)) return n
  if (n[0] === '.' && n.length === 3) return ['.', subPlus1(n[1], iv), n[2]]
  return [n[0], ...n.slice(1).map(c => subPlus1(c, iv))]
}

// Rename every let/const-DECLARED var in `stmts` with a suffix, throughout — so the 2nd unrolled
// cell's locals don't collide with the 1st. Loop-carried outer vars (assigned, not declared here)
// are untouched, so the recurrence still threads through them.
function renameDecls(stmts, suf) {
  const declared = new Set()
  const collect = (n) => {
    if (!isArr(n)) return
    if (n[0] === 'let' || n[0] === 'const')
      for (let k = 1; k < n.length; k++) if (isArr(n[k]) && n[k][0] === '=' && typeof n[k][1] === 'string') declared.add(n[k][1])
    n.forEach(collect)
  }
  stmts.forEach(collect)
  if (!declared.size) return stmts
  const ren = (n) => {
    if (typeof n === 'string') return declared.has(n) ? n + suf : n
    if (!isArr(n)) return n
    if (n[0] === '.' && n.length === 3) return ['.', ren(n[1]), n[2]]
    return [n[0], ...n.slice(1).map(ren)]
  }
  return stmts.map(ren)
}

// Replace `arr[iv-1]` reads with `left`; keep the store; emit `left = storeVal` after each store.
function scalarReplace(stmts, arr, iv, left, storeVal) {
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
      out.push(['=', left, storeVal])
  }
  return out
}

function tryUnroll(stmt, cm) {
  const L = normalizeLoop(stmt)
  if (!L || L.kind !== 'for') return null
  const body = L.body
  if (!isArr(body) || body[0] !== ';') return null
  const iv = unitIncVar(L.step)
  if (!iv) return null

  // init `let iv = LO`, LO a literal ≥ 1 (so arr[LO-1] is a valid in-bounds index)
  if (!(isArr(L.init) && L.init[0] === 'let' && isArr(L.init[1]) && L.init[1][0] === '=' && L.init[1][1] === iv)) return null
  const LO = L.init[1][2], loVal = litVal(LO)
  if (loVal == null || loVal < 1) return null

  // cond `iv <= HI` / `iv < HI`, HI loop-invariant
  if (!(isArr(L.cond) && (L.cond[0] === '<=' || L.cond[0] === '<') && L.cond[1] === iv)) return null
  const cmpOp = L.cond[0], HI = L.cond[2]
  if (!(typeof HI === 'string' || litVal(HI) != null)) return null

  if (hasUnsafe(body)) return null
  const stmts = body.slice(1)

  // exactly one store `arr[iv] = <var>` — the recurrence array + carried value
  let arr = null, storeVal = null, nStore = 0
  for (const s of stmts)
    if (isArr(s) && s[0] === '=' && isArr(s[1]) && s[1][0] === '[]' && s[1][2] === iv) {
      if (typeof s[2] !== 'string') return null
      arr = s[1][1]; storeVal = s[2]; nStore++
    }
  if (nStore !== 1 || typeof arr !== 'string') return null
  if (storeVal === iv || storeVal === arr) return null

  // every `arr[...]` is `arr[iv]` or `arr[iv-1]`, the only write is the store, ≥1 recurrence read,
  // and `arr` never appears bare (passed/aliased)
  let hasRec = false, bad = false
  const scan = (n) => {
    if (!isArr(n)) return
    if (n[0] === '[]' && n[1] === arr) {
      if (n[2] === iv) {} else if (isIvMinus1(n[2], iv)) hasRec = true; else bad = true
    }
    if (n[0] === '=' && isArr(n[1]) && n[1][0] === '[]' && n[1][1] === arr && n[1][2] !== iv) bad = true
    if (!(n[0] === '[]' || n[0] === '.')) for (let k = 1; k < n.length; k++) if (n[k] === arr) bad = true
    n.forEach(scan)
  }
  scan(body)
  if (bad || !hasRec) return null

  // The carry `left = storeVal` is emitted right after the store, so a recurrence read AFTER the
  // store would see this cell's value, not arr[iv-1]. Require every arr[iv-1] read to precede it.
  const storeIdx = stmts.findIndex(s => isArr(s) && s[0] === '=' && isArr(s[1]) && s[1][0] === '[]' && s[1][1] === arr && s[1][2] === iv)
  const readsRec = (n) => isArr(n) && ((n[0] === '[]' && n[1] === arr && isIvMinus1(n[2], iv)) || n.some(readsRec))
  for (let k = storeIdx + 1; k < stmts.length; k++) if (readsRec(stmts[k])) return null

  // iv assigned only by the step; iv/arr/HI loop-invariant (not mutated, incl. via a closure call)
  const ivMut = new Set(); findMutations(body, new Set([iv]), ivMut)
  if (ivMut.has(iv)) return null
  if (cm.has(iv) || cm.has(arr)) return null
  if (typeof HI === 'string') { const hiMut = new Set(); findMutations(body, new Set([HI]), hiMut); if (hiMut.has(HI) || cm.has(HI)) return null }

  // --- transform ---
  const id = freshLoopId()
  const left = `__rec${id}`
  const bodyS = scalarReplace(stmts, arr, iv, left, storeVal)
  const cellJ = () => bodyS.map(clone)
  const cellJ1 = renameDecls(bodyS.map(s => subPlus1(clone(s), iv)), `$r${id}`)

  const seed = ['let', ['=', left, ['[]', arr, loVal - 1]]]          // left = arr[LO-1]
  const letIv = ['let', ['=', iv, clone(LO)]]                        // let iv = LO
  const twoFit = cmpOp === '<=' ? ['<', iv, clone(HI)] : ['<', iv, ['-', clone(HI), 1]]
  const main = ['while', twoFit,
    [';', ['{}', [';', ...cellJ()]], ['{}', [';', ...cellJ1]], ['=', iv, ['+', iv, 2]]]]
  const tail = ['if', [cmpOp, iv, clone(HI)],
    ['{}', [';', ...cellJ(), ['=', iv, ['+', iv, 1]]]]]
  const block = ['{}', [';', letIv, seed, main, tail]]
  // Run the unrolled form only on a non-empty range (so the seed's arr[LO-1] load matches the
  // original, which reads it only when it iterates); otherwise the untouched loop.
  return [['if', [cmpOp, clone(LO), clone(HI)], block, stmt]]
}

export function unrollRecurrence(body) {
  const cm = closureMutatedVars(body)
  return rewriteBlocks(body, stmt => tryUnroll(stmt, cm))
}
