// Shared seeded program corpus for the perf harnesses: the timing perf-fuzz
// (scripts/fuzz-bench.mjs) and the machine-independent codegen ratchet
// (test/perf-ratchet.js) generate the SAME programs from the same seeds, so a
// ratchet baseline corresponds exactly to a perf-fuzz category.
//
// Each program is a hot accumulation loop `(n,p0,p1,p2) => { let acc=…; for
// (i<n) acc = f(acc,i,p…); return acc }` across int / float / mixed categories.

// ── seeded PRNG (LCG) ────────────────────────────────────────────────────────
export const mkRng = (s) => {
  let x = s >>> 0
  const r = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296
  r.int = n => (r() * n) | 0
  r.pick = a => a[r.int(a.length)]
  return r
}

const VARS = ['i', 'p0', 'p1', 'p2', 'acc']
const LITS = [1, 2, 3, 5, 7, 0.5, 1.5, 31, 255]
const pick = (g, a) => a[g.int(a.length)]

// INT: ToInt32-disciplined — every binop result wrapped, so it's the asm.js-style
// i32 path AND exactly what JS computes (no contract gap). Pure integer work.
const genInt = (g, d) => {
  if (d <= 0 || g() < 0.35) return g() < 0.5 ? pick(g, VARS) : String(pick(g, [1, 2, 3, 5, 7, 31, 255, 1103515245]))
  const o = pick(g, ['+', '-', '*', '^', '|', '&', '<<', '>>', '>>>'])
  if (o === '*') return `Math.imul(${genInt(g, d - 1)}, ${genInt(g, d - 1)})`
  return `((${genInt(g, d - 1)} ${o} ${genInt(g, d - 1)}) | 0)`
}
// FLOAT: f64 arithmetic — no bitwise, no |0. Math.sqrt/abs/min/max + * / +.
const genFloat = (g, d) => {
  if (d <= 0 || g() < 0.35) return g() < 0.5 ? pick(g, VARS) : String(pick(g, LITS))
  const k = g.int(6)
  if (k === 0) return `Math.sqrt(Math.abs(${genFloat(g, d - 1)}))`
  if (k === 1) return `Math.min(${genFloat(g, d - 1)}, ${genFloat(g, d - 1)})`
  const o = pick(g, ['+', '-', '*', '/'])
  return `(${genFloat(g, d - 1)} ${o} (${genFloat(g, d - 1)} + 1.5))`  // +1.5 keeps /-divisor away from 0
}
const genMixed = (g, d) => g() < 0.5 ? genInt(g, d) : genFloat(g, d)

// ── adversarial shapes (whitelist-defeating) ─────────────────────────────────
// The three above are flat single-loop accumulations — the shape the optimizer's
// whitelists were built for. These deliberately defeat those whitelists, so a
// lost narrowing / un-hoisted decode shows up as extra loop-body ops the ratchet
// catches. They are `callable: false`: the timing perf-fuzz (fuzz-bench.mjs)
// only runs the scalar `f(n,p0,p1,p2)→number` categories; these are gated by the
// machine-independent codegen ratchet (test/perf-ratchet.js), which compiles and
// counts loop-body ops without calling the function — the right gate for "did
// codegen get wasteful", independent of any V8 hardware tier-gap.

// COND: nested integer conditional (`?:` ≥2 deep) — stresses i32 narrowing THROUGH
// a conditional result. A known gap: under the vectorizer this bails to an
// `(if (result f64))` with per-branch f64.convert (see test/wat-invariants.js).
const genCond = (g, d) => {
  if (d <= 0 || g() < 0.3) return genInt(g, 1)
  return `((${genInt(g, 1)} ${pick(g, ['<', '>', '<=', '>=', '===', '!=='])} ${genInt(g, 1)}) ? ${genCond(g, d - 1)} : ${genCond(g, d - 1)})`
}

// BUF: typed array passed as a PARAM, mutated in place — JZ's flagship DSP shape
// `(buf,n)=>{ for(i<n) buf[i]=f(buf[i],i) }`. The base offset is loop-invariant
// but currently re-decoded every iteration (a per-element `__ptr_offset` the
// ratchet's op count exposes), unlike a module-global array which hoists cleanly.
const BUF_LEAF = ['buf[i]', 'i + 0.0', '1.0', '0.5', '2.0', '-1.5', '3.0']
const genBufExpr = (g, d) => (d <= 0 || g() < 0.4)
  ? pick(g, BUF_LEAF)
  : `(${genBufExpr(g, d - 1)} ${pick(g, ['+', '-', '*'])} ${genBufExpr(g, d - 1)})`
const progBuf = (g) => `export let f = (buf, n) => { for (let i = 0; i < n; i = i + 1) { buf[i] = ${genBufExpr(g, 3)} } }`

// NEST: nested loop where the inner body mixes an i-invariant read (`a[i]`,
// hoistable out of the j-loop) with a j-varying read (`a[j]`) — the LICM stressor
// V8 under-hoists in nested loops and JZ claims to lift.
const NEST_LEAF = ['a[i]', 'a[j]', 'i', 'j', '1', '3', '7']
const genNestExpr = (g, d) => (d <= 0 || g() < 0.4)
  ? pick(g, NEST_LEAF)
  : `((${genNestExpr(g, d - 1)} ${pick(g, ['+', '-', '*', '^', '|', '&'])} ${genNestExpr(g, d - 1)}) | 0)`
const progNest = (g) => `export let f = (a, n) => { let acc = 0 | 0; for (let i = 0; i < n; i = i + 1) { for (let j = 0; j < n; j = j + 1) { acc = (acc + (${genNestExpr(g, 3)})) | 0 } } return acc | 0 }`

export const CATEGORIES = {
  int: { gen: genInt, init: '0|0', step: (e) => `acc = (acc + (${e})) | 0`, ret: 'acc | 0', callable: true },
  float: { gen: genFloat, init: '0', step: (e) => `acc = acc + (${e})`, ret: 'acc', callable: true },
  mixed: { gen: genMixed, init: '0', step: (e) => `acc = acc + (${e})`, ret: 'acc', callable: true },
  // adversarial / structural — ratchet-only (op count), not timed
  cond: { gen: genCond, init: '0|0', step: (e) => `acc = (acc + (${e})) | 0`, ret: 'acc | 0', callable: false },
  buf: { program: progBuf, callable: false },
  nest: { program: progNest, callable: false },
}

export const genProgram = (cat, seed) => {
  const g = mkRng(seed)
  const c = CATEGORIES[cat]
  if (c.program) return c.program(g, seed)   // structural categories build their own source
  const expr = c.gen(g, 4)
  return `export let f = (n, p0, p1, p2) => { let acc = ${c.init}; for (let i = 0; i < n; i = i + 1) { ${c.step(expr)} } return ${c.ret} }`
}
