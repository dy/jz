// Bounded-square narrowing: carry `i*i` as i32 inside a loop guarded by `i*i < CONST`.
//
// A PRODUCT `i*i` is f64 in unhinted JS — the integer-overflow contract: a product can
// exceed 2³¹, where JS keeps a Number, so jz can't blindly use i32.mul (it would wrap).
// In a Sieve-of-Eratosthenes `for(i=2; i*i<LIMIT; i++) for(j=i*i; j<LIMIT; j+=i) …`, that
// makes the outer bound, the inner counter `j`'s init, and the whole index chain f64 —
// each typed-array access then pays an f64→i32 convert.
//
// But when the loop GUARD is `i*i < CONST` with CONST a compile-time constant ≤ 2³⁰, the
// counter is i ≤ ⌈√CONST⌉ ≤ 2¹⁵ throughout the body (the loop is still running, and i is
// only incremented by +1), so EVERY `i*i` there is < 2³⁰ < 2³¹ and `Math.imul(i,i) == i*i`
// exactly. The exit overshoot (the first i with i*i ≥ CONST, evaluated in the condition)
// is ≤ CONST + 2√CONST+1 < 2³¹ for CONST ≤ 2³⁰, so the condition narrows soundly too. The
// hard cap is 2³⁰ — well under the 2³¹ overflow point, with margin for the overshoot.
//
// So we rewrite those `i*i` to `Math.imul(i,i)` (jz's i32 multiply): semantically identical
// in the proven range, and it lets the EXISTING i32 machinery carry the index chain as i32
// — the inner `j` (init now i32, step `j+i` i32, bound `j<CONST` i32) cascades on its own.
//
// Sound iff: the loop condition is `(i*i) </≤ CONST` (CONST ≤ 2³⁰), and the IV `i` is
// incremented by +1 and NOT otherwise mutated (so within a body iteration i ∈ {entry, +1},
// both squares < 2³¹). Mirrors strength-reduce-divmod's structure (post-prepare `while`).

import { findMutations } from './analyze-scans.js'
import { includeMods } from '../autoload.js'
import { ctx } from '../ctx.js'

const SQUARE_BOUND_MAX = 2 ** 30
// Number literals are sparse-array holes `[<hole>, v]` (length 2, index 0 == null).
const litVal = (n) => Array.isArray(n) && n.length === 2 && n[0] == null && typeof n[1] === 'number' ? n[1] : null
const litN = (n, k) => litVal(n) === k
// The constant numeric value of a bound: a literal, OR a module const folded to an int
// (`const LIMIT = 1<<20` → ctx.scope.constInts.get('LIMIT') = 1048576 — the bench form).
const boundVal = (n) => {
  const lit = litVal(n)
  if (lit != null) return lit
  if (typeof n === 'string') { const v = ctx.scope.constInts?.get(n); return typeof v === 'number' ? v : null }
  return null
}
// `i * i` — the IV squared.
const isSquare = (n, iv) => Array.isArray(n) && n[0] === '*' && n[1] === iv && n[2] === iv && typeof iv === 'string'
// Math.imul(i, i) in CANONICAL post-prepare form: prepare resolves `Math.imul` → the string
// ref `'math.imul'`, so the call is `['()', 'math.imul', [',', i, i]]`. math.imul emits a
// primitive `i32.mul` (no stdlib helper / module include needed).
const imulOf = (iv) => ['()', 'math.imul', [',', iv, iv]]

// IV a statement increments by exactly +1, or null. Covers `i++`, `++i`, `i += 1`, `i = i + 1`.
// (Same recognizer as loop-divmod's incVarOf — post-inc `i++` desugars to `(++i) - 1`.)
function incVarOf(stmt) {
  if (!Array.isArray(stmt)) return null
  let inc = stmt
  if (stmt[0] === '-' && litN(stmt[2], 1) && Array.isArray(stmt[1]) && stmt[1][0] === '++') inc = stmt[1]
  if (inc[0] === '++' && typeof inc[1] === 'string') return inc[1]
  if (stmt[0] === '+=' && typeof stmt[1] === 'string' && litN(stmt[2], 1)) return stmt[1]
  if (stmt[0] === '=' && typeof stmt[1] === 'string' && Array.isArray(stmt[2]) && stmt[2][0] === '+') {
    const [, a, b] = stmt[2]
    if (a === stmt[1] && litN(b, 1)) return stmt[1]
    if (b === stmt[1] && litN(a, 1)) return stmt[1]
  }
  return null
}

// The IV of a `(i*i) </≤ CONST` (or mirrored `CONST >/≥ (i*i)`) guard, CONST ≤ 2³⁰, else null.
function boundedSquareIV(cond) {
  if (!Array.isArray(cond)) return null
  let prod, bound
  if (cond[0] === '<' || cond[0] === '<=') { prod = cond[1]; bound = cond[2] }
  else if (cond[0] === '>' || cond[0] === '>=') { prod = cond[2]; bound = cond[1] }
  else return null
  if (!isSquare(prod, prod && prod[1])) return null
  const b = boundVal(bound)
  if (b == null || b < 0 || b > SQUARE_BOUND_MAX) return null
  return prod[1]
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '&&=', '||=', '??='])
const collectAssigns = (n, out) => {
  if (!Array.isArray(n)) return
  if (typeof n[1] === 'string' && (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--')) out.add(n[1])
  n.forEach(c => collectAssigns(c, out))
}
const closureMutated = (n, out) => {
  if (!Array.isArray(n)) return out
  if (n[0] === '=>') collectAssigns(n, out)
  n.forEach(c => closureMutated(c, out))
  return out
}

let _cm = new Set()

// Narrow a `for`/`while` whose guard is `(i*i) </≤ CONST` (CONST ≤ 2³⁰) and whose IV `i` is
// incremented by +1 and not otherwise mutated — then within any body iteration i ∈ {entry,
// entry+1}, entry ≤ ⌈√CONST⌉ ≤ 2¹⁵, so every `i*i` (and the exit overshoot) is < 2³¹ and
// Math.imul(i,i) == i*i. Rewrites those products; the dependent counter chain cascades to i32.
function tryNarrow(stmt) {
  if (!Array.isArray(stmt)) return null
  let cond, body, isFor = false
  if (stmt[0] === 'for') {
    // post-prepare flat form: ['for', init, cond, update, body]
    if (stmt.length < 5) return null
    cond = stmt[2]; body = stmt[4]; isFor = true
  } else if (stmt[0] === 'while') {
    cond = stmt[1]; body = stmt[2]
  } else return null

  const iv = boundedSquareIV(cond)
  if (!iv) return null
  if (_cm.has(iv)) return null   // mutable via a closure call — entry value unprovable

  if (isFor) {
    // The `for` update is the IV's sole, +1 mutation; the body must not reassign i.
    if (incVarOf(stmt[3]) !== iv) return null
    const ivMut = new Set(); findMutations(body, new Set([iv]), ivMut)
    if (ivMut.has(iv)) return null
  } else {
    // `while`: the increment lives in the body (exactly one +1; nothing else mutates i).
    if (!Array.isArray(body) || body[0] !== ';') return null
    let ivIdx = -1
    for (let k = 1; k < body.length; k++) if (incVarOf(body[k]) === iv) { if (ivIdx >= 0) return null; ivIdx = k }
    if (ivIdx < 0) return null
    const ivMut = new Set()
    findMutations([';', ...body.slice(1).filter((_, k) => k !== ivIdx - 1)], new Set([iv]), ivMut)
    if (ivMut.has(iv)) return null
  }

  // We're injecting `math.imul` after prepare's auto-import step, so ensure the math module
  // (which registers the `math.imul` → i32.mul primitive emitter) is included.
  includeMods('math')
  // Rewrite every `i*i` in the condition + body to Math.imul(i,i) (NOT init/update — they're
  // `i=2` / `i++`). The inner counter whose init this feeds cascades to i32 on its own.
  const rw = (n) => !Array.isArray(n) ? n : isSquare(n, iv) ? imulOf(iv) : n.map(rw)
  return isFor
    ? ['for', stmt[1], rw(cond), stmt[3], rw(body)]
    : ['while', rw(cond), rw(body)]
}

function walk(node) {
  if (!Array.isArray(node)) return node
  const n = node.map(walk)
  if (n[0] !== ';') return n
  const out = [';']
  for (let k = 1; k < n.length; k++) out.push(tryNarrow(n[k]) || n[k])
  return out
}

export function narrowBoundedSquare(body) {
  _cm = closureMutated(body, new Set())
  return walk(body)
}
