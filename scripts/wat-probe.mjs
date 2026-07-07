// Pure WAT structural-probe lib — no test registration, no side effects, so both
// the invariant test (test/wat-invariants.js) and the one-shot audits
// (scripts/audit-*.mjs) can share it. "Can't prove fast; prove no waste": every
// helper here asks whether a known overhead pattern survives into optimized output.
import { compile } from '../index.js'
import parseWat from 'watr/parse'

// jz source → optimized WAT S-expr tree (arrays whose [0] is the op string).
export const parse = (src, optimize) => parseWat(compile(src, { optimize, wat: true }))

// Visit every node; `inLoop` becomes true once lexically inside any `(loop …)`.
export const walk = (node, visit, inLoop = false) => {
  if (!Array.isArray(node)) return
  const here = inLoop || node[0] === 'loop'
  visit(node, here)
  for (let i = 1; i < node.length; i++) walk(node[i], visit, here)
}
// Count every instruction node (each S-expr whose head is a string op) — a
// machine-independent codegen-size proxy used by the fixpoint audit.
export const countOps = (tree) => { let c = 0; walk(tree, (n) => { if (typeof n[0] === 'string') c++ }); return c }
export const has = (tree, pred) => { let f = false; walk(tree, (n) => { if (pred(n)) f = true }); return f }
export const loopHas = (tree, pred) => { let f = false; walk(tree, (n, inL) => { if (inL && pred(n)) f = true }); return f }
export const count = (tree, pred) => { let c = 0; walk(tree, (n) => { if (pred(n)) c++ }); return c }
export const loopCount = (tree, pred) => { let c = 0; walk(tree, (n, inL) => { if (inL && pred(n)) c++ }); return c }

// ── predicates ────────────────────────────────────────────────────────────────
export const head = (re) => (n) => typeof n[0] === 'string' && re.test(n[0])
// Count `call $name` nodes (name ∈ `names`) across module funcs, skipping funcs
// whose $name matches `skip`. The standing use: `new TypedArray(x)` with a
// boundary-unknown x (an exported init's param) MUST carry a TYPED-source copy
// arm — a __typed_idx dispatch loop that is cold, semantically required, and
// irrelevant to hot-loop no-dispatch pins. Callers assert over PRE-watr trees
// (watr's inliner erases helper names, making post-watr counts vacuous).
export const callsOutside = (tree, names, skip) => {
  const set = names instanceof Set ? names : new Set(names)
  let c = 0
  const countCalls = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'call' && set.has(n[1])) c++
    for (let i = 1; i < n.length; i++) countCalls(n[i])
  }
  for (const n of tree) {
    if (!Array.isArray(n) || n[0] !== 'func') continue
    if (skip && skip.test(String(n[1]))) continue
    countCalls(n)
  }
  return c
}
export const call = (re) => (n) => n[0] === 'call' && typeof n[1] === 'string' && re.test(n[1])
// f64 arithmetic OR an int↔f64 round-trip. SOUND only over ToInt32-disciplined
// code (every product via Math.imul, every result `|0`): there, any loop-body f64
// is a lost narrowing. NOT sound for arbitrary integer code — a bare `a * b` on
// integer-valued f64 operands is correctly f64 (the product can exceed 2³¹ where
// JS keeps a Number; i32.mul would wrap). Use COUNTER_CMP_F64 for general code.
export const F64_OR_ROUNDTRIP = head(/^f64\.|^i32\.trunc_sat_f64/)
// a loop-invariant pointer/length helper that must be hoisted, never per-iteration.
export const PTR_HELPER = call(/__ptr_offset|__ptr_type|__len\b|__length|__typed_idx/)
// an integer counter compared in f64 — the EXACT narrowLoopBound gap (a counted
// loop whose bound wasn't snapped to i32). Sound on any code: a converted i32
// counter in a float compare is always narrowable, regardless of body arithmetic.
const isConv = (x) => Array.isArray(x) && x[0] === 'f64.convert_i32_s'
export const COUNTER_CMP_F64 = (n) =>
  typeof n[0] === 'string' && /^f64\.(lt|le|gt|ge)$/.test(n[0]) && (isConv(n[1]) || isConv(n[2]))
