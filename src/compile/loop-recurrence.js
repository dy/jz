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

const isArr = (n) => Array.isArray(n)   // wrap (not alias): the self-host kernel rejects a builtin used as a first-class value
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
// carried chain). The transform emits pair + tail:
//   let i = LO; while (i < HI-1) { body; body[i+1]; i += 2 } ; if (i </<= HI) body
// Each copy is a verbatim iteration (checked reads and all), so values are
// exact for every input incl. OOB — only the iteration grouping changes.
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
  if (!(isArr(L.init) && L.init[0] === 'let' && isArr(L.init[1]) && L.init[1][0] === '=' && L.init[1][1] === iv)) { if (DBG) console.error('[usc] init-shape'); return null }
  const LO = L.init[1][2], loVal = litVal(LO)
  if (loVal == null || loVal < 0) { if (DBG) console.error('[usc] lo', JSON.stringify(LO)); return null }
  if (!(isArr(L.cond) && (L.cond[0] === '<=' || L.cond[0] === '<') && L.cond[1] === iv)) { if (DBG) console.error('[usc] cond-shape'); return null }
  const cmpOp = L.cond[0], HI = L.cond[2]
  if (!(typeof HI === 'string' || litVal(HI) != null)) { if (DBG) console.error('[usc] hi', JSON.stringify(HI)); return null }
  if (hasUnsafe(body)) { if (DBG) console.error('[usc] unsafe'); return null }
  const stmts = body.slice(1)

  // no element/property stores anywhere — the class is a pure scan
  let hasStore = false
  const scanStore = (n) => {
    if (!isArr(n) || hasStore) return
    if ((n[0] === '=' || (typeof n[0] === 'string' && n[0].endsWith('=') && n[0] !== '==' && n[0] !== '<=' && n[0] !== '>=' && n[0] !== '!=' && n[0] !== '===' && n[0] !== '!=='))
        && isArr(n[1]) && (n[1][0] === '[]' || n[1][0] === '.')) { hasStore = true; return }
    n.forEach(scanStore)
  }
  scanStore(body)
  if (hasStore) return null

  // carried scalars: outer names assigned at body top level (not declared here)
  const declared = new Set()
  for (const s of stmts) if (isArr(s) && (s[0] === 'let' || s[0] === 'const'))
    for (let k = 1; k < s.length; k++) if (isArr(s[k]) && s[k][0] === '=' && typeof s[k][1] === 'string') declared.add(s[k][1])
  const carried = new Set()
  const scanAssign = (n) => {
    if (!isArr(n)) return
    if (typeof n[1] === 'string' && n[1] !== iv && !declared.has(n[1])
        && (n[0] === '=' || n[0] === '+=' || n[0] === '-=' || n[0] === '^=' || n[0] === '|=' || n[0] === '&=' || n[0] === '*=' || n[0] === '>>=' || n[0] === '>>>=' || n[0] === '<<='))
      carried.add(n[1])
    n.forEach(scanAssign)
  }
  scanAssign(body)
  if (!carried.size) return null

  // the chain proof: some element read's INDEX mentions a carried scalar
  const mentions = (n, name) => n === name || (isArr(n) && n.some(c => mentions(c, name)))
  let chained = false
  const scanChain = (n) => {
    if (!isArr(n) || chained) return
    if (n[0] === '[]' && n.length === 3) for (const s of carried) if (mentions(n[2], s)) { chained = true; return }
    n.forEach(scanChain)
  }
  scanChain(body)
  if (!chained) { if (DBG) console.error('[usc] no-chain, carried:', [...carried]); return null }

  // stability: iv written only by the step; carried names + HI not closure-mutated
  const ivMut = new Set(); findMutations(body, new Set([iv]), ivMut)
  if (ivMut.has(iv) || cm.has(iv)) return null
  for (const s of carried) if (cm.has(s)) return null
  if (typeof HI === 'string') { const hiMut = new Set(); findMutations(body, new Set([HI]), hiMut); if (hiMut.has(HI) || cm.has(HI)) return null }

  // --- transform: pair + tail ---
  const id = freshLoopId()
  const cell = () => stmts.map(clone)
  const cell1 = renameDecls(stmts.map(s => subPlus1(clone(s), iv)), `$c${id}`)
  const letIv = ['let', ['=', iv, clone(LO)]]
  const twoFit = cmpOp === '<=' ? ['<', iv, clone(HI)] : ['<', iv, ['-', clone(HI), 1]]
  const main = ['while', twoFit,
    [';', ['{}', [';', ...cell()]], ['{}', [';', ...cell1]], ['=', iv, ['+', iv, 2]]]]
  const tail = ['if', [cmpOp, iv, clone(HI)],
    ['{}', [';', ...cell(), ['=', iv, ['+', iv, 1]]]]]
  return [['{}', [';', letIv, main, tail]]]
}

/** Speed-tier pass: ×2-unroll every serial-chain scan loop in `body`. */
export function unrollScalarChains(body) {
  const cm = closureMutatedVars(body)
  return rewriteBlocks(body, stmt => tryUnrollScalarChain(stmt, cm))
}

// ── Disjoint-arm update chain → select accumulation ─────────────────────────
// A dense-int if/else-if chain whose arms each bump a DIFFERENT scalar by a
// constant — square-tracing's direction step:
//   if (dir === 0) x++; else if (dir === 1) y++; else if (dir === 2) x--; else y--
// With dir data-dependent (bitmap-driven) the branches are unpredictable — the
// dominant residual vs LLVM's layout on the trace bench. Rewrite each updated
// scalar to one unconditional add of a const ternary chain (branchless select):
//   x += (dir === 0 ? 1 : dir === 2 ? -1 : 0); y += (dir === 1 ? 1 : dir === 3 ? -1 : 0)
// SOUNDNESS: `v += 0` maps -0 → +0, so every updated scalar must be PROVEN
// integer-valued: declared in this function with an int-literal init and only
// ever written by ++/--/+= int-literal/-= int-literal (scanned function-wide).
// The discriminant must be a plain local, not updated by the arms.

const armUpdate = (s) => {
  if (!isArr(s)) return null
  if (s[0] === '{}' && isArr(s[1]) && s[1][0] === ';' && s[1].length === 2) return armUpdate(s[1][1])
  if (s[0] === ';' && s.length === 2) return armUpdate(s[1])
  if ((s[0] === '++' || s[0] === '--') && typeof s[1] === 'string') return { v: s[1], d: s[0] === '++' ? 1 : -1 }
  if ((s[0] === '+=' || s[0] === '-=') && typeof s[1] === 'string') {
    const c = litVal(s[2])
    if (c != null && Number.isInteger(c)) return { v: s[1], d: s[0] === '+=' ? c : -c }
  }
  return null
}

function trySelectArmUpdates(stmt, zeroSafe) {
  if (!isArr(stmt) || stmt[0] !== 'if') return null
  // walk the else-if spine collecting (const, {v, d}) arms
  const arms = []
  let d = null, node = stmt, elseArm = null
  while (isArr(node) && node[0] === 'if') {
    const [, cond, then, els] = node
    if (!(isArr(cond) && (cond[0] === '===' || cond[0] === '==') && typeof cond[1] === 'string')) return null
    if (d == null) d = cond[1]
    else if (cond[1] !== d) return null
    const k = litVal(cond[2])
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
  const vars = new Set([...arms.map(a => a.u.v), ...(elseArm ? [elseArm.v] : [])])
  if (vars.has(d)) return null
  if (!zeroSafe(vars)) return null
  // per-var delta chain over the FULL arm list (an arm not touching v
  // contributes 0 — the else delta applies only when NO chain const matches):
  //   v += (d === k0 ? δ0 : d === k1 ? δ1 : … : elseδ)
  const out = [';']
  for (const v of vars) {
    let expr = [, elseArm && elseArm.v === v ? elseArm.d : 0]
    for (let i = arms.length - 1; i >= 0; i--)
      expr = ['?:', ['===', d, [, arms[i].k]], [, arms[i].u.v === v ? arms[i].u.d : 0], expr]
    out.push(['+=', v, expr])
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
    if (op === ';' || op === '{}' || op === '{') { for (let i = 1; i < n.length; i++) stmts(n[i]); return }
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
export function selectArmUpdatesIn(body) {
  const cm = closureMutatedVars(body)
  const memo = new Map()
  const zeroSafe = (vars) => {
    for (const v of vars) if (cm.has(v)) return false
    const key = [...vars].sort().join(',')
    let r = memo.get(key)
    if (r == null) memo.set(key, r = minusZeroSafe(body, vars))
    return r
  }
  // only rewrite chains INSIDE loops — straight-line chains predict fine
  const rewriteIn = (n) => {
    if (!isArr(n)) return n
    if (n[0] === 'for' || n[0] === 'while') {
      const walkStmts = (m) => {
        if (!isArr(m)) return m
        if (m[0] === ';' || m[0] === '{}' || m[0] === '{') {
          for (let i = 1; i < m.length; i++) {
            const r = isArr(m[i]) && m[i][0] === 'if' ? trySelectArmUpdates(m[i], zeroSafe) : null
            m[i] = r ? r[0] : walkStmts(m[i])
          }
          return m
        }
        if (m[0] === 'if') {
          const r = trySelectArmUpdates(m, zeroSafe)
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
