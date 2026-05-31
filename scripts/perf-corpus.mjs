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

export const CATEGORIES = {
  int: { gen: genInt, init: '0|0', step: (e) => `acc = (acc + (${e})) | 0`, ret: 'acc | 0' },
  float: { gen: genFloat, init: '0', step: (e) => `acc = acc + (${e})`, ret: 'acc' },
  mixed: { gen: genMixed, init: '0', step: (e) => `acc = acc + (${e})`, ret: 'acc' },
}

export const genProgram = (cat, seed) => {
  const g = mkRng(seed)
  const c = CATEGORIES[cat]
  const expr = c.gen(g, 4)
  return `export let f = (n, p0, p1, p2) => { let acc = ${c.init}; for (let i = 0; i < n; i = i + 1) { ${c.step(expr)} } return ${c.ret} }`
}
