import { ctx } from '../../ctx.js'
import { nodeEqual as exprEq, walkAst } from '../../ast.js'
import { collectWrites } from './addr-model.js'
import { f64Zero, forEachLocalDef, isArr, localGetName } from './node-utils.js'

const matchF64MulLocals = n => {
  if (!isArr(n) || n[0] !== 'f64.mul') return null
  const a = localGetName(n[1])
  const b = localGetName(n[2])
  return a && b ? [a, b] : null
}

const matchAccumStep = (n, acc) => {
  if (!isArr(n) || n[0] !== 'local.set' || n[1] !== acc) return null
  const e = n[2]
  if (!isArr(e) || e[0] !== 'f64.add') return null
  if (localGetName(e[1]) === acc) return matchF64MulLocals(e[2])
  if (localGetName(e[2]) === acc) return matchF64MulLocals(e[1])
  return null
}

const matchDotStore = (n, acc) => {
  if (!isArr(n) || n[0] !== 'local.set' || typeof n[1] !== 'string') return null
  const e = n[2]
  if (localGetName(e) === acc) return { out: n[1], addend: null }
  if (!isArr(e) || e[0] !== 'f64.add') return null
  if (localGetName(e[1]) === acc) return { out: n[1], addend: e[2] }
  if (localGetName(e[2]) === acc) return { out: n[1], addend: e[1] }
  return null
}

// Unroll width this dot-product recognizer expects: a `acc=0` reset, exactly this
// many `acc += L[k]*R[k]` steps, then the store. Tied to the emitter's 4-wide dot
// unroll — matchDotStore / f64x2Pair / dotPairExpr below are hardwired to it.
const DOT_UNROLL = 4

const matchF64DotSeq = (stmts, i) => {
  const reset = stmts[i]
  if (!isArr(reset) || reset[0] !== 'local.set' || typeof reset[1] !== 'string' || !f64Zero(reset[2])) return null
  const acc = reset[1]
  const left = [], right = []
  for (let k = 0; k < DOT_UNROLL; k++) {
    const pair = matchAccumStep(stmts[i + 1 + k], acc)
    if (!pair) return null
    left.push(pair[0])
    right.push(pair[1])
  }
  const store = matchDotStore(stmts[i + 1 + DOT_UNROLL], acc)
  return store ? { end: i + 2 + DOT_UNROLL, acc, left, right, ...store } : null
}

const f64x2Pair = (lo, hi) => ['f64x2.replace_lane', 1, ['f64x2.splat', ['local.get', lo]], ['local.get', hi]]

// Build the 2-lane dot expression `a0*p0 + a1*p1 + a2*p2 + a3*p3`.
// Default: explicit mul/add pairs (one rounding per op) — bit-identical to the
// scalar `a*b+c` a JS engine emits. With `useRelaxedFma`, each accumulate folds
// to `f64x2.relaxed_madd(splat(a[i]), p[i], acc)` — one VFMADD instruction with
// a single rounding. Faster and more accurate, but the fused rounding diverges
// from the non-fused reference (the bench `fma` parity class). Opt-in only.
const dotPairExpr = (a, pairs, useRelaxedFma = false) => {
  let expr = ['f64x2.mul', ['f64x2.splat', ['local.get', a[0]]], pairs[0]]
  for (let i = 1; i < 4; i++) {
    expr = useRelaxedFma
      ? ['f64x2.relaxed_madd', ['f64x2.splat', ['local.get', a[i]]], pairs[i], expr]
      : ['f64x2.add', expr, ['f64x2.mul', ['f64x2.splat', ['local.get', a[i]]], pairs[i]]]
  }
  return expr
}

// SLP unification (.work/archive/vectorizer-generality-design.md §2 "SLP (#15-17) → 2"): this is
// the DOT-SEQUENCE seed tier of the unified SLP packer (`slpPairsIn`, defined after
// `slpStorePairsIn` below) — seeds on 2 adjacent `matchF64DotSeq` instances (a 4-wide
// unrolled dot reduction ending in a store) instead of `slpStorePairsIn`'s adjacent
// element-store seed. Operates on SCALAR register operands only (matchF64DotSeq's
// `left`/`right` are `local.get` names off an already scalar-replaced unrolled dot, e.g.
// mat4's cells) — no memory access at all, so unlike the store-pair tier it needs no
// aliasing/typed-view gate; always tried. Kept as its own matcher rather than rewritten
// into `slpPackF64x2`'s general recursive walker: its 0/130 corpus reach (census §9 row
// 18, "unknown(precondition)") means there is no specimen to validate a widened match
// surface against, and the byte-identical gate would have no way to distinguish a sound
// generalization from an unintended new-vectorization case — folded in AS-IS (design's own
// instruction: "do not debug or delete it standalone").
const vectorizeStraightLineF64DotPairsIn = (node, fnLocals, freshIdRef, newLocalDecls, useRelaxedFma = false) => {
  if (!isArr(node)) return
  for (let i = 0; i < node.length; i++) {
    const child = node[i]
    if (isArr(child)) vectorizeStraightLineF64DotPairsIn(child, fnLocals, freshIdRef, newLocalDecls, useRelaxedFma)
  }
  // Allocate dedup tables only after this statement list proves it contains a
  // packable pair. Most compiler IR nodes never contain a dot seed; eagerly
  // allocating two Maps at every recursive node dominated self-hosted SLP.
  let addendTemps = null
  let pairTemps = null
  for (let i = 0; i < node.length;) {
    const a = matchF64DotSeq(node, i)
    if (!a) { i++; continue }
    const b = matchF64DotSeq(node, a.end)
    if (!b || a.acc !== b.acc || !exprEq(a.left, b.left) || !exprEq(a.addend, b.addend) ||
        fnLocals.get(a.out) !== 'f64' || fnLocals.get(b.out) !== 'f64') {
      i++
      continue
    }
    addendTemps ||= new Map()
    pairTemps ||= new Map()
    const v = `$__dot2_${freshIdRef.next++}`
    newLocalDecls.push(['local', v, 'v128'])
    fnLocals.set(v, 'v128')
    let prefix = []
    let addend = a.addend
    if (addend) {
      const key = JSON.stringify(addend)
      let tmp = addendTemps.get(key)
      if (!tmp) {
        tmp = `$__dotadd_${freshIdRef.next++}`
        addendTemps.set(key, tmp)
        newLocalDecls.push(['local', tmp, 'f64'])
        fnLocals.set(tmp, 'f64')
        prefix = [['local.set', tmp, addend]]
      }
      addend = ['local.get', tmp]
    }
    const pairs = []
    for (let k = 0; k < DOT_UNROLL; k++) {
      const key = `${a.right[k]}\0${b.right[k]}`
      let tmp = pairTemps.get(key)
      if (!tmp) {
        tmp = `$__dotpair_${freshIdRef.next++}`
        pairTemps.set(key, tmp)
        newLocalDecls.push(['local', tmp, 'v128'])
        fnLocals.set(tmp, 'v128')
        prefix.push(['local.set', tmp, f64x2Pair(a.right[k], b.right[k])])
      }
      pairs.push(['local.get', tmp])
    }
    const dot = dotPairExpr(a.left, pairs, useRelaxedFma)
    const expr = addend ? ['f64x2.add', dot, ['f64x2.splat', addend]] : dot
    node.splice(i, b.end - i,
      ...prefix,
      ['local.set', v, expr],
      ['local.set', a.out, ['f64x2.extract_lane', 0, ['local.get', v]]],
      ['local.set', b.out, ['f64x2.extract_lane', 1, ['local.get', v]]],
    )
    i += prefix.length + 3
  }
}

// =============================================================================
// Loop-invariant partial-product hoist for unrolled f64 dot reductions.
//
// A fully-unrolled inner reduction over scalar-replaced array cells (mat4's
// `out[r][c] = Σ a[r][k]·b[k][c]`) lives in the body of an OUTER loop that
// mutates only a few of those cells (mat4: a[0],a[5],b[0],b[5]). Every product
// whose two operands are both outer-loop-invariant is therefore the SAME every
// iteration — yet the body recomputes all of them. rust/LLVM precomputes those
// invariant partials in a loop prologue (mat4.rs → ~294 lines before its loop);
// V8/wasmtime/JSC cannot, because at the wasm level they can't prove the cells
// are loop-invariant (no aliasing model). So jz must hoist them itself.
//
// Splitting `s = t0+t1+t2+t3` into `INV = Σ(invariant tk)` (hoisted) + `Σ(variant
// tk)` (kept) REASSOCIATES the float sum — invariant terms are summed first,
// regardless of original position — so results differ by ULPs from the strict
// left-to-right order. That is the SAME class of reorder jz already ships for
// horizontal/multi-accumulator reductions (policy at lines ~620 and ~1584), and
// rust itself does it at -O3 without fast-math. Gated to the relaxedFma/speed
// tier exactly like those, so strict opts keep bit-exact order.
//
// Surgical by construction: fires only on a dot that MIXES invariant and variant
// terms inside a loop. A pure-variant dot (a real matmul kernel, every operand
// streaming) has no invariant term → untouched. Runs BEFORE the dot-pair
// vectorizer; a hoisted dot has < DOT_UNROLL accumulate steps so matchF64DotSeq
// no longer matches it — it stays the (faster here) scalar form, like rust.
const hoistDotInvariant = (loop, parent, idx, fnLocals, freshIdRef, newLocalDecls) => {
  const writeSet = new Set()
  collectWrites(loop, writeSet)
  const isInv = name => typeof name === 'string' && !writeSet.has(name) && fnLocals.get(name) === 'f64'
  const invInits = []
  const processList = (list) => {
    for (let i = 0; i < list.length;) {
      const seq = matchF64DotSeq(list, i)
      if (!seq) { i++; continue }
      const invKs = [], varKs = []
      for (let k = 0; k < DOT_UNROLL; k++) (isInv(seq.left[k]) && isInv(seq.right[k]) ? invKs : varKs).push(k)
      if (invKs.length === 0) { i = seq.end; continue }  // nothing loop-invariant — leave for the vectorizer
      // INV = Σ invariant products, in original k-order, computed once before the loop.
      let inv = ['f64.const', '0']
      for (const k of invKs) inv = ['f64.add', inv, ['f64.mul', ['local.get', seq.left[k]], ['local.get', seq.right[k]]]]
      const invName = `$__rinv_${freshIdRef.next++}`
      newLocalDecls.push(['local', invName, 'f64']); fnLocals.set(invName, 'f64')
      invInits.push(['local.set', invName, inv])
      // In-loop: seed acc with INV, add only the variant products, then the unchanged store.
      const repl = [['local.set', seq.acc, ['local.get', invName]]]
      for (const k of varKs) repl.push(['local.set', seq.acc, ['f64.add', ['local.get', seq.acc], ['f64.mul', ['local.get', seq.left[k]], ['local.get', seq.right[k]]]]])
      repl.push(['local.set', seq.out, seq.addend ? ['f64.add', ['local.get', seq.acc], seq.addend] : ['local.get', seq.acc]])
      list.splice(i, seq.end - i, ...repl)
      i += repl.length
    }
  }
  walkAst(loop, { enter: n => { if (isArr(n)) processList(n) } })
  if (invInits.length) parent.splice(idx, 0, ...invInits)
}

// Walk a function, hoisting invariant reduction partials out of each loop. Inner
// loops first (post-order) so a dot is hoisted relative to its tightest enclosing
// loop, and an already-rewritten dot can't re-match in an outer pass.
export const hoistReductionInvariantsIn = (fn, fnLocals, freshIdRef, newLocalDecls) => {
  walkAst(fn, { exit: (node, parent, idx) => {
    if (node[0] === 'loop' && isArr(parent)) hoistDotInvariant(node, parent, idx, fnLocals, freshIdRef, newLocalDecls)
  } })
}

// =============================================================================
// SLP (superword-level parallelism): pack two ADJACENT isomorphic f64 element
// stores into one f64x2 store — the WITHIN-iteration 2-lane class the loop
// vectorizer (which packs ACROSS iterations) structurally cannot reach.
//
// Soundness has TWO obligations, because the pack reorders memory: it materializes
// BOTH lane values BEFORE either store, turning [read0, write0, read1, write1] into
// [read0, read1, write0, write1].
//   1. CROSS-base aliasing — guarded by one module fact: no typed-array VIEW exists
//      (`ctx.linkDemand.typedView` false, checked at the dispatch). A view (subarray /
//      buffer-backed ctor) is the only way two DISTINCT typed bases can overlap;
//      without one, distinct bases own disjoint allocations and can't alias.
//   2. Read-after-write — the high value (read1) must not load the slot the low store
//      writes (write0), or the pack reads write0's PRE-store value. Through the same
//      base (`o[k+1]=o[k]; o[k+2]=o[k+1]`, a forward shift) and through any other: two
//      names can be one array (`multiply(m, m, x)`), so a load at the low store's slot
//      offset is a hazard whatever its base (slpReadsSlot). The own-index map reads its
//      OWN slot, one above, so it survives; so does the field-first idiom, whose values
//      read locals loaded before every store.
// The pack is admitted ONLY when overhead-free (adjacent loads → v128.load, a pair of
// field locals → their v128 (below), identical pure scalar → splat, matching op →
// recurse); anything that would need a per-lane `replace_lane` build bails, which makes
// the rewrite both PROFITABLE and unable to grow code. Every f64x2 lane op is
// bit-identical to its scalar f64 op (IEEE element-wise), so the result is byte-equal
// to the scalar form.
// =============================================================================
const F64X2_BIN = { 'f64.add': 'f64x2.add', 'f64.sub': 'f64x2.sub', 'f64.mul': 'f64x2.mul', 'f64.div': 'f64x2.div', 'f64.min': 'f64x2.min', 'f64.max': 'f64x2.max' }
const F64X2_UN = { 'f64.neg': 'f64x2.neg', 'f64.abs': 'f64x2.abs', 'f64.sqrt': 'f64x2.sqrt' }
// How many statements apart a store and the staging of its value may sit.
const SLP_WINDOW = 8

// The subtree's value is the SAME evaluated once (splat) or twice (the two source
// statements, which are adjacent — no store/reassign between): a pure, side-effect-free,
// DETERMINISTIC expression. Rejects calls (a `new TypedArray()` alloc returns a fresh
// pointer per call — splatting it would make the two lanes ALIAS, the array-literal
// scatter miscompile), loads, and any store/set/memory op.
const slpSplatSafe = (n) => {
  let unsafe = false
  walkAst(n, { enter: x => {
    if (unsafe) return false
    const op = x[0]
    if (typeof op !== 'string') { unsafe = true; return false }
    if (op.startsWith('call') || op.includes('.load') || op.includes('.store')
        || op === 'local.set' || op === 'local.tee' || op === 'global.set'
        || op.startsWith('memory.') || op.includes('.atomic.')) { unsafe = true; return false }
  } })
  return !unsafe
}

// ---- Address model -----------------------------------------------------------
// Decompose a load/store node, normalizing the optional `offset=K` attribute jz
// folds adjacent accesses into: `(op addr …)` → off 0, `(op offset=K addr …)` → K.
const slpMem = (n) => {
  if (typeof n[1] === 'string' && n[1].startsWith('offset=')) return { off: +n[1].slice(7), addr: n[2], val: n[3] }
  return { off: 0, addr: n[1], val: n[2] }
}
// A constant i32 subtree's value, folding the arithmetic jz leaves in a constant index
// (`(i32.shl (i32.const 3) (i32.const 3))`); NaN when it is not constant.
const slpConst = (n) => {
  if (!isArr(n)) return NaN
  if (n[0] === 'i32.const') return Number(n[1])
  if (n.length !== 3) return NaN
  const a = slpConst(n[1]), b = slpConst(n[2])
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN
  switch (n[0]) {
    case 'i32.add': return (a + b) | 0
    case 'i32.sub': return (a - b) | 0
    case 'i32.mul': return Math.imul(a, b)
    case 'i32.shl': return a << (b & 31)
  }
  return NaN
}
// An access as `base ⊕ off`: the memarg plus every constant the address adds. `base`
// is the remaining address subtree, kept as emitted (its tee included) for reuse.
const slpAddr = (n) => {
  const m = slpMem(n)
  let base = m.addr, off = m.off
  while (isArr(base) && base[0] === 'i32.add' && base.length === 3) {
    const k = slpConst(base[2]), j = slpConst(base[1])
    if (!Number.isNaN(k)) { off += k; base = base[1] }
    else if (!Number.isNaN(j)) { off += j; base = base[2] }
    else break
  }
  return { base, off, addr: m.addr, val: m.val }
}
const slpMemarg = (op, off, base, ...rest) => off ? [op, `offset=${off}`, base, ...rest] : [op, base, ...rest]
const clone = n => isArr(n) ? n.map(clone) : n

const hasOp = (n, ops) => { let hit = false; walkAst(n, { enter: x => { if (hit) return false; if (ops.has(x[0])) hit = true } }); return hit }
const BRANCH_OPS = new Set(['br', 'br_if', 'br_table', 'return', 'return_call', 'unreachable', 'throw', 'try_table', 'loop', 'block', 'call_indirect'])
const CONTROL_OPS = new Set([...BRANCH_OPS, 'if'])
const TEE = new Set(['local.tee'])

// The locals a window of statements defines, by statement index: a top-level
// `local.set`, or a `local.tee` inside a statement with no control op (it runs whenever
// the statement does). A name defined twice resolves to nothing; `writes` has every
// name the window writes, defined or not. The window opens a few statements before the
// accesses compared, where jz stages their receivers.
const slpWindow = (stmts, from, to) => {
  const defs = new Map(), writes = new Set()
  for (let at = from; at <= to; at++) {
    const s = stmts[at]
    if (!isArr(s)) continue
    const whole = !hasOp(s, CONTROL_OPS)
    walkAst(s, { enter: n => {
      if ((n[0] !== 'local.set' && n[0] !== 'local.tee') || typeof n[1] !== 'string') return
      writes.add(n[1])
      if (n === s || n[0] === 'local.tee' && whole) defs.set(n[1], defs.has(n[1]) ? null : { e: n[2], at })
    } })
  }
  return { defs, writes }
}
// Pure register arithmetic an address is made of. No load: memory may change between
// the two accesses compared.
const ADDR_OPS = new Set(['i32.add', 'i32.sub', 'i32.mul', 'i32.shl', 'i32.shr_u', 'i32.shr_s', 'i32.and', 'i32.or', 'i32.xor', 'i32.wrap_i64', 'i32.const',
  'i64.and', 'i64.or', 'i64.shl', 'i64.shr_u', 'i64.const', 'i64.reinterpret_f64', 'i64.extend_i32_u', 'f64.const'])
// What an address subtree computes at statement `at` of the window, over locals the
// window never writes: a tee dissolves into its body, a local the window defined
// EARLIER into its definition, and a definition that is no register arithmetic (an
// allocation call) stands as the local it defines — its one value in the window. null
// when a load, a call or a local written in the window stands in the way — the value
// could differ between the two accesses.
const slpResolve = (n, w, at, depth = 0) => {
  if (!isArr(n) || depth > 16) return null
  const op = n[0]
  if (op === 'local.tee' || op === 'local.get') {
    if (typeof n[1] !== 'string') return null
    const d = w.defs.get(n[1])
    if (op === 'local.get' && d === undefined) return w.writes.has(n[1]) ? null : n
    if (!d || op === 'local.get' && d.at >= at || op === 'local.tee' && d.e !== n[2]) return null
    return slpResolve(d.e, w, d.at, depth + 1) ?? ['local.get', n[1]]
  }
  if (!ADDR_OPS.has(op)) return null
  const out = [op]
  for (let i = 1; i < n.length; i++) {
    if (!isArr(n[i])) { out.push(n[i]); continue }
    const r = slpResolve(n[i], w, at, depth)
    if (!r) return null
    out.push(r)
  }
  return out
}
// The two accesses, at statements `atX` and `atY` of the window, address the same base.
const slpSameBase = (x, atX, y, atY, w) => {
  const a = slpResolve(x, w, atX), b = a && slpResolve(y, w, atY)
  return !!b && exprEq(a, b)
}
// The locals a value reads.
const slpReads = (n) => {
  const r = new Set()
  walkAst(n, { enter: x => { if (x[0] === 'local.get' && typeof x[1] === 'string') r.add(x[1]) } })
  return r
}
// A statement a value (or a load) may be evaluated across: it writes none of the value's
// locals or any global, stores nothing, branches nowhere, and calls only the durable-array
// snapshot (which records an array and writes none) or a throw guard (which either does
// nothing or ends the activation, whose locals then no one reads). A store crossing it
// (`strict`) needs more: no load could see the store's slot, no call could, and a guard
// that throws would leave the store made.
const INERT_CALLS = new Set(['$__durable_arr_snap'])
const slpInert = (stmt, reads, strict = false) => {
  if (!isArr(stmt)) return typeof stmt === 'string'
  let ok = true
  walkAst(stmt, { enter: n => {
    if (!ok) return false
    const op = n[0]
    if (typeof op !== 'string') { ok = false; return false }
    if (op === 'local.set' || op === 'local.tee') { if (reads.has(n[1])) ok = false; return }
    if (op === 'call') { if (strict || !INERT_CALLS.has(n[1]) && !n[1].startsWith('$__throw_')) ok = false; return }
    if (op === 'unreachable') { if (strict) ok = false; return }
    if (op === 'global.set' || op.includes('.store') || op.startsWith('memory.') || op.includes('.atomic.') || op.startsWith('call') || BRANCH_OPS.has(op)
        || strict && op.includes('.load')) ok = false
  } })
  return ok
}
// Every tee in `n` defines a local nothing reads: the subtree can dissolve (jz stages
// each access's base in a fresh temp) without leaving a read of an unset local.
const slpDeadTees = (n, counts) => {
  let ok = true
  walkAst(n, { enter: x => { if (x[0] === 'local.tee' && counts.has(x[1])) ok = false } })
  return ok
}
// Does `value` load the slot at offset `off` — through any base (obligation 2)?
const slpReadsSlot = (value, off) => {
  let hit = false
  walkAst(value, { enter: n => {
    if (hit || !isArr(n)) return false
    if (n[0] === 'f64.load' && slpAddr(n).off === off) hit = true
  } })
  return hit
}

// ---- Field pairs ---------------------------------------------------------------
// A kernel that loads its operands' fields into locals first (`ax = a[0], ay = a[1]`,
// the alias-safe idiom every vector and matrix library writes) leaves the packer no
// adjacent loads: each lane leaf is a different local. Two locals defined once each,
// by loads of consecutive slots with only staging or other loads between (no store, no
// call but a guard), are one v128 loaded beside them: a lane pair of those two locals
// reads it. The v128 is loaded only where a pack uses it, right after the second scalar
// — same memory, no write between, one definition each — so it equals [X, Y] wherever
// the scalars are read.
const slpFieldPairs = (fn) => {
  const sets = new Map()
  forEachLocalDef([fn], name => sets.set(name, (sets.get(name) || 0) + 1))
  const loadDef = s => isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && sets.get(s[1]) === 1
    && isArr(s[2]) && s[2][0] === 'f64.load' ? { name: s[1], ...slpAddr(s[2]) } : null
  const none = new Set()
  const pairs = new Map()
  walkAst(fn, { enter: list => {
    for (let j = 1; j + 1 < list.length; j++) {
      const x = loadDef(list[j])
      if (!x || x.off < 0) continue
      for (let k = j + 1; k < list.length && k - j <= SLP_WINDOW; k++) {
        const y = loadDef(list[k])
        if (y && y.off - x.off === 8 && slpSameBase(x.base, j, y.base, k, slpWindow(list, Math.max(1, j - SLP_WINDOW), k))) {
          // The v128 reads through the second scalar's base: its tee, or a copy of a tee-free expression.
          const base = y.base[0] === 'local.tee' ? ['local.get', y.base[1]] : hasOp(y.base, TEE) ? null : clone(y.base)
          if (base) pairs.set(x.name + '\0' + y.name, { off: x.off, base, x: list[j], y: list[k], list })
          break
        }
        if (!slpInert(list[k], none)) break
      }
    }
  } })
  return pairs
}
// Load every pair a pack took, after its second scalar; drop a scalar nothing reads any
// more, whose address tees nothing read either (the v128 load covers its bytes, so it
// traps exactly where the scalar would).
const slpPlaceFieldPairs = (fn, sp) => {
  const used = [...sp.pairs.values()].filter(p => p.name)
  if (!used.length) return
  for (const p of used) {
    const k = p.list.indexOf(p.y)
    if (k < 0) throw new Error('slp: a field pair lost its definition')
    p.list.splice(k + 1, 0, ['local.set', p.name, slpMemarg('v128.load', p.off, p.base)])
  }
  const counts = slpGetCounts(fn)
  const dead = s => !counts.has(s[1]) && slpDeadTees(s[2], counts)
  for (const p of used) for (const s of [p.x, p.y]) {
    if (!dead(s)) continue
    const k = p.list.indexOf(s)
    if (k >= 0) p.list.splice(k, 1)
  }
}

// Pack two isomorphic f64 trees [lo, hi] into an f64x2 value, or null if it isn't
// overhead-free (adjacent loads → v128.load, a field pair → its v128, identical pure
// scalar → splat, matching op → recurse). The overhead-free restriction is what makes it
// both profitable and unable to grow code; every f64x2 lane op is bit-identical to its
// scalar f64 op.
const slpPackF64x2 = (lo, hi, sp) => {
  if (!isArr(lo) || !isArr(hi)) return null
  if (lo[0] === 'f64.load' && hi[0] === 'f64.load') {
    const a = slpAddr(lo), b = slpAddr(hi)
    // The high address dissolves into the pack: a tee there must define a local nothing reads.
    if (a.off < 0 || b.off - a.off !== 8 || !slpDeadTees(b.addr, sp.getCounts) || !slpSameBase(a.base, 0, b.base, 1, slpWindow([lo, hi], 0, 1))) return null
    return slpMemarg('v128.load', a.off, a.base)
  }
  const x = localGetName(lo), y = localGetName(hi)
  if (x && y && x !== y) {
    const p = sp.pairs.get(x + '\0' + y)
    if (!p) return null
    if (!p.name) { p.name = `$__slpp${sp.freshIdRef.next++}`; sp.touched.push(p) }
    return ['local.get', p.name]
  }
  if (exprEq(lo, hi) && slpSplatSafe(lo)) return ['f64x2.splat', lo]
  if (lo[0] === hi[0]) {
    const bin = F64X2_BIN[lo[0]]
    if (bin && lo.length === 3 && hi.length === 3) {
      const a = slpPackF64x2(lo[1], hi[1], sp); if (!a) return null
      const b = slpPackF64x2(lo[2], hi[2], sp); return b ? [bin, a, b] : null
    }
    const un = F64X2_UN[lo[0]]
    if (un && lo.length === 2 && hi.length === 2) {
      const a = slpPackF64x2(lo[1], hi[1], sp); return a ? [un, a] : null
    }
  }
  return null
}

// The element store at `stmts[i]`: its slot, its value and the statement that stages the
// value. jz stages a store's value and base in temps — `(local.set $v V) (local.set $b B)
// … (f64.store (local.get $b) (local.get $v))` — so a single-use value temp resolves to V
// when every statement between its definition and the store is inert for V: the pack
// evaluates V at the store.
const slpUnitAt = (stmts, i, getCounts) => {
  const s = stmts[i]
  if (!isArr(s) || s[0] !== 'f64.store') return null
  const a = slpAddr(s)
  const u = { at: i, off: a.off, base: a.base, addr: a.addr, value: a.val, def: -1 }
  const t = localGetName(a.val)
  if (t && getCounts.get(t) === 1) for (let j = i - 1; j >= 1 && i - j <= SLP_WINDOW; j--) {
    const d = stmts[j]
    if (!isArr(d) || d[0] !== 'local.set' || d[1] !== t) continue
    const reads = slpReads(d[2])
    let inert = true
    for (let k = j + 1; k < i && inert; k++) inert = slpInert(stmts[k], reads)
    if (inert) { u.value = d[2]; u.def = j }
    break
  }
  return u
}

// Count `(local.get NAME)` occurrences across the function, so a store value's temp is
// confirmed single-use before its definition is folded into the pack.
const slpGetCounts = (fn) => {
  const counts = new Map()
  walkAst(fn, { enter: n => {
    if (isArr(n) && n[0] === 'local.get' && typeof n[1] === 'string') counts.set(n[1], (counts.get(n[1]) || 0) + 1)
  } })
  return counts
}

// Rewrite two element stores one f64 apart with isomorphic values into a single v128
// store at the low store's place. The packed value is computed into a fresh v128 local
// FIRST, then stored — preserving jz's value-before-address evaluation order (the store
// address can read a `local.tee` the value defines, e.g. the shared `i<<3` offset). The
// low store's address stays (its tee that defines the shared pointer is kept); the high
// store, its value and the staging of its base dissolve into the high lane. Sound only
// under the no-view gate at dispatch.
const slpStorePairsIn = (node, sp) => {
  if (!isArr(node)) return
  for (let i = 1; i < node.length; i++) if (isArr(node[i])) slpStorePairsIn(node[i], sp)
  for (let i = 1; i < node.length; i++) {
    const u0 = slpUnitAt(node, i, sp.getCounts)
    if (!u0 || u0.off < 0) continue
    let k = i + 1
    while (k < node.length && k - i <= SLP_WINDOW && !(isArr(node[k]) && node[k][0] === 'f64.store')) k++
    const u1 = k < node.length ? slpUnitAt(node, k, sp.getCounts) : null
    if (!u1 || u1.off - u0.off !== 8 || u1.def >= 0 && u1.def <= i || !slpDeadTees(u1.addr, sp.getCounts)) continue
    const lo = u0.def >= 0 ? u0.def : i
    if (!slpSameBase(u0.base, i, u1.base, k, slpWindow(node, Math.max(1, lo - SLP_WINDOW), k))) continue
    // Between the stores: the high value moves up, the high store moves up to the low one.
    const reads = new Set([...slpReads(u0.value), ...slpReads(u1.value)])
    let inert = true
    for (let j = i + 1; j < k && inert; j++) inert = j === u1.def || slpInert(node[j], reads, true)
    if (!inert || slpReadsSlot(u1.value, u0.off)) continue
    sp.touched = []
    const packed = slpPackF64x2(u0.value, u1.value, sp)
    // A pair the pack named stays a pair only with the pack: an abandoned pack unnames it.
    if (!packed) { for (const p of sp.touched) p.name = null; continue }
    for (const p of sp.touched) { sp.newLocalDecls.push(['local', p.name, 'v128']); sp.fnLocals.set(p.name, 'v128') }
    const t = `$__slp${sp.freshIdRef.next++}`
    sp.newLocalDecls.push(['local', t, 'v128']); sp.fnLocals.set(t, 'v128')
    const baseReads = slpReads(u1.addr)
    // High index first, so the lower indices stay valid.
    node.splice(k, 1)
    for (let j = k - 1; j > i; j--) {
      const d = node[j]
      if (j === u1.def || isArr(d) && d[0] === 'local.set' && baseReads.has(d[1]) && sp.getCounts.get(d[1]) === 1) node.splice(j, 1)
    }
    node.splice(i, 1, ['local.set', t, packed], slpMemarg('v128.store', u0.off, u0.base, ['local.get', t]))
    if (u0.def >= 0) { node.splice(u0.def, 1); i-- }
    i++
  }
}

// ---- Unified SLP recognizer (dispatch entry) --------------------------------
//
// Design §2 "SLP (#15-17) → 2 (1 general pack + 1 generalized LICM)": the two PACKERS
// (`vectorizeStraightLineF64DotPairsIn`'s dot-sequence seed, `slpStorePairsIn`'s
// element-store seed) are both instances of classic bottom-up SLP — seed on 2 adjacent
// isomorphic roots, pack when both operand trees match (`slpPackF64x2` does the shared
// recursive walk for both). Folded into ONE entry point here: same call order as before
// the merge (dot-sequence tier — unconditional, no memory aliasing — then the
// element-store tier, gated by `slp` + no-typed-view for aliasing safety), so this is a
// pure entry-point consolidation — behavior is unchanged by construction.
// `hoistReductionInvariantsIn` is NOT folded in here — it is a different transform
// category (LICM: reassociating hoist of loop-invariant partial products, not a packer;
// design §2 keeps it distinct) and is called separately, before this, at the dispatch.
export function slpPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFma, slp) {
  let hasF64Mul = false
  let f64Stores = 0
  walkAst(fn, { enter: node => {
    if (node[0] === 'f64.mul') hasF64Mul = true
    else if (node[0] === 'f64.store') f64Stores++
  } })
  // Necessary-op gates keep scalar/compiler functions out of both recursive
  // SLP walkers. They only reject functions that cannot contain either seed.
  if (hasF64Mul) vectorizeStraightLineF64DotPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFma)
  if (f64Stores >= 2 && slp && !ctx.linkDemand.typedView) {
    const sp = { fnLocals, freshIdRef, newLocalDecls: newLocalDeclsAll, getCounts: slpGetCounts(fn), pairs: slpFieldPairs(fn), touched: [] }
    slpStorePairsIn(fn, sp)
    slpPlaceFieldPairs(fn, sp)
  }
}

// ---- Lane type tables ------------------------------------------------------

