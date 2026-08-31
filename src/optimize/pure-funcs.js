/**
 * Pure-function detection for the SIMD lane vectorizer's per-lane inliner
 * (buildPureFuncMap), and the dead string-dispatch fold it relies on to see a
 * clean scalar body (foldStrDispatchF64). `buildPureFuncMap` calls
 * `foldStrDispatchF64` directly on a private clone — the two are one unit.
 *
 * @module optimize/pure-funcs
 */
import { findBodyStart, cloneIR } from '../ir.js'
import { walkAst } from '../ast.js'

// Build the "pure for SIMD lane-inline" map consumed by tryPerPixelColor's Phase-2
// user-function inline (cfg._pureFuncMap). A user function qualifies when its body has
// no side effects: no global.set, no memory store, and no call except $math.* / $__to_num
// (a pure numeric coercion the lane lift strips). foldStrDispatchF64 runs first
// (idempotent) so the purity check sees the folded body — dead __is_str_key dispatch on a
// proven-f64 param would otherwise read as impure. Built in the emit phase (optimizeModule),
// BEFORE the per-function lane vectorizer runs, so callee bodies are still clean scalar.
//
// SOUNDNESS: folds a CLONE, never `fn` itself. `fn` is the real,
// shared function object also emitted verbatim for its own ordinary (non-inlined) call
// sites — under jz's NaN-boxing ABI EVERY dynamically-typed value (string, undefined,
// null, a boolean atom, a boxed object) is carried in an `f64`-typed local exactly like
// a genuine number; a bare `(param $x f64)` proves nothing about $x's runtime domain.
// foldStrDispatchF64's "proven rawF64" claim is sound only for the SUBSTITUTED argument
// at a `pureFuncMap`-driven inline site (gated to a proven-numeric f64 SIMD lane
// context elsewhere in the vectorizer) — never for the callee's own declaration. Folding
// `fn` in place used to strip the runtime string/atom dispatch from `fn`'s real,
// standalone body too, so an ordinary call passing e.g. a Map's absent-key `undefined`
// sentinel silently got treated as a plain float (`param-hop "+" miscompile`, dyn-keys.js).
export function buildPureFuncMap(funcs) {
  const pureFuncMap = new Map()
  const hasSideEffect = (node) => {
    let found = false
    walkAst(node, { enter: n => {
      if (found) return false
      const op = n[0]
      if (op === 'global.set' ||
          (typeof op === 'string' && (op.endsWith('.store') || op.startsWith('memory.'))) ||
          (op === 'call' && typeof n[1] === 'string' && !n[1].startsWith('$math.') && n[1] !== '$__to_num') ||
          op === 'call_indirect' || op === 'call_ref') { found = true; return false }
    } })
    return found
  }
  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func') continue
    const name = fn[1]
    if (typeof name !== 'string' || name.startsWith('$math.') || name.startsWith('$__')) continue
    // Fold transactionally on the source tree, classify, clone only a survivor,
    // then restore the source. This preserves the exact folded candidate while
    // avoiding a full clone of every impure function in the module.
    const changes = []
    foldStrDispatchF64(fn, changes)
    const bodyStart = findBodyStart(fn)
    let pure = bodyStart >= 0
    if (pure) for (let i = bodyStart; i < fn.length; i++) if (hasSideEffect(fn[i])) { pure = false; break }
    const clone = pure ? cloneIR(fn) : null
    for (let i = changes.length - 1; i >= 0; i--) changes[i][0][changes[i][1]] = changes[i][2]
    if (pure) pureFuncMap.set(name, clone)
  }
  return pureFuncMap
}

/**
 * Fold dead string-dispatch blocks when the tested operand is a proven-f64 local.
 *
 * jz's `+` emitter produces, for every binary addition whose right operand has an
 * unresolved valType, the pattern:
 *
 *   (block (result f64)
 *     (local.set $B EXPR_A)
 *     (if (result f64)
 *       (call $__is_str_key (i64.reinterpret_f64 (local.tee $C (local.get $P))))
 *       (then (call $__str_concat …))
 *       (else (f64.add (local.get $B) (local.get $C)))))
 *
 * When $P is a proven-f64 local (an f64 param, or an f64-typed local provably set
 * only from f64 arithmetic) it can never hold a string-key NaN-box, so the
 * `$__is_str_key` test is provably false and the `then` branch is dead.
 * Replace the whole block with `(f64.add EXPR_A (local.get $P))`.
 *
 * SOUND: f64 params can never hold a string-key NaN-box by construction (jz
 * only allows strings in f64 slots via explicit mkptr boxing, never a bare
 * param). This fold is additive/gated (only runs when vectorizeLaneLocal is on)
 * and only removes provably-dead string-dispatch overhead.
 *
 * Called in the 'post' phase of optimizeFunc, before vectorizeLaneLocal, so the
 * cleaned IR is what the vectorizer pattern-matches.
 */
// cloneIR (imported from ir.js) deep-clones an IR node (nested arrays of
// strings/numbers) — used above to give foldStrDispatchF64 a private copy to
// mutate, so its guard-stripping never leaks into the real, standalone-
// callable function it was copied from (see foldStrDispatchF64's own
// soundness note: the fold is sound ONLY for a call site whose argument is
// independently proven numeric by its OWN context — e.g. a per-lane value
// read straight off a typed array inside a proven f64 SIMD context — never
// for the callee's bare declared param type).
export function foldStrDispatchF64(fn, changes) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Collect all f64 params — provably never hold a string-key NaN-box.
  const rawF64 = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const d = fn[i]
    if (Array.isArray(d) && d[0] === 'param' && typeof d[1] === 'string' && d[2] === 'f64')
      rawF64.add(d[1])
  }
  if (!rawF64.size) return  // no f64 params → nothing to fold

  // Transitively extend rawF64: an f64 local set only via f64 arithmetic over rawF64
  // members is itself provably non-string. One forward pass suffices for DAG-shaped
  // straight-line code (the common case); a fixed-point loop covers rare mutual defs.
  // Collect local types first.
  const localTypeMap = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const d = fn[i]
    if (Array.isArray(d) && (d[0] === 'param' || d[0] === 'local') && typeof d[1] === 'string')
      localTypeMap.set(d[1], d[2])
  }
  // An expression is rawF64-valued if it only uses ops that stay in f64 and
  // reads only rawF64 locals (or f64.const). Stops early — we only need the
  // closed set for the pattern's $P operand.
  const isRawF64Expr = (n) => {
    if (!Array.isArray(n)) return false
    const op = n[0]
    if (op === 'f64.const') return true
    if (op === 'local.get' && typeof n[1] === 'string') return rawF64.has(n[1])
    if (op === 'local.tee' && typeof n[1] === 'string') return rawF64.has(n[1]) && isRawF64Expr(n[2])
    if (op === 'f64.add' || op === 'f64.sub' || op === 'f64.mul' || op === 'f64.div' ||
        op === 'f64.neg' || op === 'f64.abs' || op === 'f64.sqrt') {
      return n.slice(1).every(isRawF64Expr)
    }
    return false
  }

  // Single forward pass: a local.set $v EXPR where EXPR is rawF64-valued makes $v rawF64.
  // Repeat until stable (handles ordering edge cases in non-DAG code).
  let changed = true
  while (changed) {
    changed = false
    const markRaw = node => {
      if (Array.isArray(node) && (node[0] === 'local.set' || node[0] === 'local.tee') && typeof node[1] === 'string' &&
          localTypeMap.get(node[1]) === 'f64' && !rawF64.has(node[1]) && isRawF64Expr(node[2])) {
        rawF64.add(node[1]); changed = true
      }
    }
    for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: markRaw })
  }

  // Pattern-match and fold in-place (bottom-up recursive walk so nested blocks resolve).
  const foldNode = (node) => {
    if (!Array.isArray(node)) return node
    // Recurse children first (bottom-up).
    for (let i = 0; i < node.length; i++) {
      const c = node[i]
      if (!Array.isArray(c)) continue
      const next = foldNode(c)
      if (next !== c) {
        if (changes) changes.push([node, i, c])
        node[i] = next
      }
    }
    // Match:
    //   ['block', ['result','f64'],
    //     ['local.set', $B, EXPR_A],
    //     ['if', ['result','f64'],
    //       ['call','$__is_str_key', ['i64.reinterpret_f64', ['local.tee',$C,['local.get',$P]]]],
    //       ['then', ['call','$__str_concat',...]],
    //       ['else', ['f64.add', ['local.get',$B], ['local.get',$C]]]]]
    if (node[0] !== 'block') return node
    if (!Array.isArray(node[1]) || node[1][0] !== 'result' || node[1][1] !== 'f64') return node
    if (node.length !== 4) return node
    const setStmt = node[2], ifStmt = node[3]
    if (!Array.isArray(setStmt) || setStmt[0] !== 'local.set' || typeof setStmt[1] !== 'string') return node
    const B = setStmt[1], exprA = setStmt[2]
    if (!Array.isArray(ifStmt) || ifStmt[0] !== 'if') return node
    // if must have: (result f64), cond, then, else — total 5 elements
    if (ifStmt.length !== 5) return node
    if (!Array.isArray(ifStmt[1]) || ifStmt[1][0] !== 'result' || ifStmt[1][1] !== 'f64') return node
    const cond = ifStmt[2], thenB = ifStmt[3], elseB = ifStmt[4]
    // cond: ['call','$__is_str_key',['i64.reinterpret_f64',['local.tee',$C,['local.get',$P]]]]
    if (!Array.isArray(cond) || cond[0] !== 'call' || cond[1] !== '$__is_str_key' || cond.length !== 3) return node
    const reinterpArg = cond[2]
    if (!Array.isArray(reinterpArg) || reinterpArg[0] !== 'i64.reinterpret_f64' || reinterpArg.length !== 2) return node
    const teeNode = reinterpArg[1]
    if (!Array.isArray(teeNode) || teeNode[0] !== 'local.tee' || typeof teeNode[1] !== 'string' || teeNode.length !== 3) return node
    const C = teeNode[1]
    const getP = teeNode[2]
    if (!Array.isArray(getP) || getP[0] !== 'local.get' || typeof getP[1] !== 'string') return node
    const P = getP[1]
    // $P must be a proven f64 local (never a string-key NaN-box)
    if (!rawF64.has(P)) return node
    // then: ['then', ['call','$__str_concat',...]]
    if (!Array.isArray(thenB) || thenB[0] !== 'then') return node
    // else: ['else', ['f64.add', ['local.get',$B], ['local.get',$C]]]
    // Each operand may be wrapped in emit '+' numSide's atom-coercion guard —
    // `(if (f64.eq $X $X) (then $X) (else <atom select ladder>))` — which is dead
    // once the operand is proven rawF64; unwrap to the inner local.get.
    const unwrapGuard = (n) => {
      if (!Array.isArray(n) || n[0] !== 'if' || n.length !== 5) return n
      const [, res, cnd, thn] = n
      if (!Array.isArray(res) || res[0] !== 'result' || res[1] !== 'f64') return n
      if (!Array.isArray(cnd) || cnd[0] !== 'f64.eq') return n
      if (!Array.isArray(thn) || thn[0] !== 'then' || thn.length !== 2) return n
      const inner = thn[1]
      if (!Array.isArray(inner) || inner[0] !== 'local.get') return n
      if (!Array.isArray(cnd[1]) || cnd[1][0] !== 'local.get' || cnd[1][1] !== inner[1]) return n
      return inner
    }
    if (!Array.isArray(elseB) || elseB[0] !== 'else' || elseB.length !== 2) return node
    const addExpr = elseB[1]
    if (!Array.isArray(addExpr) || addExpr[0] !== 'f64.add' || addExpr.length !== 3) return node
    // The two operands of f64.add must be local.get $B and local.get $C (in either order)
    const [lhsAdd, rhsAdd] = [unwrapGuard(addExpr[1]), unwrapGuard(addExpr[2])]
    const lhsIsB = Array.isArray(lhsAdd) && lhsAdd[0] === 'local.get' && lhsAdd[1] === B
    const rhsIsC = Array.isArray(rhsAdd) && rhsAdd[0] === 'local.get' && rhsAdd[1] === C
    const lhsIsC = Array.isArray(lhsAdd) && lhsAdd[0] === 'local.get' && lhsAdd[1] === C
    const rhsIsB = Array.isArray(rhsAdd) && rhsAdd[0] === 'local.get' && rhsAdd[1] === B
    if (!((lhsIsB && rhsIsC) || (lhsIsC && rhsIsB))) return node
    // Match confirmed. Fold to: (f64.add EXPR_A (local.get $P))
    return ['f64.add', exprA, ['local.get', P]]
  }

  for (let i = bodyStart; i < fn.length; i++) {
    const before = fn[i]
    const next = foldNode(before)
    if (next !== before) {
      if (changes) changes.push([fn, i, before])
      fn[i] = next
    }
  }
}
