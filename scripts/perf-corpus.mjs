// Shared seeded program corpus for the perf harnesses: the timing perf-fuzz
// (scripts/fuzz-bench.mjs) and the machine-independent codegen ratchet
// (test/perf-ratchet.js) generate the SAME programs from the same seeds, so a
// ratchet baseline corresponds exactly to a perf-fuzz category.
//
// Each program is a hot accumulation loop `(n,p0,p1,p2) => { let acc=…; for
// (i<n) acc = f(acc,i,p…); return acc }` across int / float / mixed categories.

// ── seeded PRNG (LCG) ────────────────────────────────────────────────────────
const mkRng =(s) => {
  let x = s >>> 0
  const r = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296
  r.int = n => (r() * n) | 0
  r.pick = a => a[r.int(a.length)]
  return r
}

// ── loop spellings ───────────────────────────────────────────────────────────
// Every generator prints its counted loops through one printer: `v` from `from`
// while below `to`, step 1, a body with no continue, no break and no closure over
// `v`. Each style is that loop, its work in the same order; `default` is the
// spelling the baselines were measured on (test/spellings.js holds the others to
// its cost). `v !== to` is not one: every bound here is a runtime parameter and the
// ratchet's inputs pass a fractional one (3.5), where `!==` never exits.
// `v >= to` exits where `v < to` would not run only for a NaN bound, which no
// input passes.
const seq = (a, b) => /[;}]$/.test(a) ? `${a} ${b}` : `${a}; ${b}`
const forLoop = (test, step) => (v, from, to, body) => `for (let ${v} = ${from}; ${test(v, to)}; ${step(v)}) { ${body} }`
const lt = (v, to) => `${v} < ${to}`
export const STYLES = {
  default: forLoop(lt, v => `${v} = ${v} + 1`),
  post: forLoop(lt, v => `${v}++`),
  pre: forLoop(lt, v => `++${v}`),
  addAssign: forLoop(lt, v => `${v} += 1`),
  onePlus: forLoop(lt, v => `${v} = 1 + ${v}`),
  subNeg: forLoop(lt, v => `${v} -= -1`),
  flipped: forLoop((v, to) => `${to} > ${v}`, v => `${v} = ${v} + 1`),
  while: (v, from, to, body) => `let ${v} = ${from}; while (${v} < ${to}) { ${seq(body, `${v}++`)} }`,
  doWhile: (v, from, to, body) => `let ${v} = ${from}; if (${v} < ${to}) do { ${seq(body, `${v}++`)} } while (${v} < ${to});`,
  whileTrue: (v, from, to, body) => `let ${v} = ${from}; while (true) { if (${v} >= ${to}) break; ${seq(body, `${v}++`)} }`,
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
// machine-independent codegen ratchet (test/perf-ratchet.js).
//
// NB on the metric: the ratchet compiles at optimize:2 and counts loop-body ops —
// the right gate for SCALAR codegen ("did a narrowing/hoist stop firing"). It is
// deliberately NOT run at the 'speed' tier: vectorization there legitimately
// RAISES the static op count (SIMD setup + scalar tail + unswitch's duplicated
// body), so an op-count gate would flag a win as a regression. The speed-tier
// vectorization wins are pinned by the right tool instead — v128-presence +
// bit-exactness assertions in test/{cond-vectorize,unswitch-typed-param,slp}.js.

// COND: nested integer conditional (`?:` ≥2 deep) — stresses i32 narrowing THROUGH
// a conditional result (the scalar accumulation path; the typed-array conditional
// MAP that vectorizes to i32x4 is pinned by test/cond-vectorize.js).
const genCond = (g, d) => {
  if (d <= 0 || g() < 0.3) return genInt(g, 1)
  return `((${genInt(g, 1)} ${pick(g, ['<', '>', '<=', '>=', '===', '!=='])} ${genInt(g, 1)}) ? ${genCond(g, d - 1)} : ${genCond(g, d - 1)})`
}

// BUF: typed array passed as a PARAM, mutated in place — JZ's flagship DSP shape
// `(buf,n)=>{ for(i<n) buf[i]=f(buf[i],i) }`. At optimize:2 (where the ratchet
// measures) this is the fully-dynamic param path — base re-decoded per element —
// and the op count guards that scalar shape. At 'speed', unswitchTypedParamLoop now
// guards `is buf Float64Array?` once and lifts a base-hoisted f64x2 fast path
// (pinned by test/unswitch-typed-param.js); that win is NOT visible to this op
// count (it duplicates the body), by design.
const BUF_LEAF = ['buf[i]', 'i + 0.0', '1.0', '0.5', '2.0', '-1.5', '3.0']
const genBufExpr = (g, d) => (d <= 0 || g() < 0.4)
  ? pick(g, BUF_LEAF)
  : `(${genBufExpr(g, d - 1)} ${pick(g, ['+', '-', '*'])} ${genBufExpr(g, d - 1)})`
const progBuf = (g, loop) => `export let f = (buf, n) => { ${loop('i', 0, 'n', `buf[i] = ${genBufExpr(g, 3)}`)} }`

// NEST: nested loop where the inner body mixes an i-invariant read (`a[i]`,
// hoistable out of the j-loop) with a j-varying read (`a[j]`) — the LICM stressor
// V8 under-hoists in nested loops and JZ claims to lift.
const NEST_LEAF = ['a[i]', 'a[j]', 'i', 'j', '1', '3', '7']
const genNestExpr = (g, d) => (d <= 0 || g() < 0.4)
  ? pick(g, NEST_LEAF)
  : `((${genNestExpr(g, d - 1)} ${pick(g, ['+', '-', '*', '^', '|', '&'])} ${genNestExpr(g, d - 1)}) | 0)`
const progNest = (g, loop) => `export let f = (a, n) => { let acc = 0 | 0; ${loop('i', 0, 'n', loop('j', 0, 'n', `acc = (acc + (${genNestExpr(g, 3)})) | 0`))} return acc | 0 }`


// SLICE: block processing over RUNTIME SUB-VIEWS of one buffer — `a[o + i]` with `o`
// loaded per block from a schedule. The class the Flow-Lenia kernel fell off (channel
// bases at runtime → generic dispatch, ~100×) and the audio/font-table access pattern
// bench/slices pins as a case. The ratchet guards that the base decodes ONCE per block,
// not per element.
const SLICE_LEAF = ['a[o + i]', 'i + 0.0', '0.5', '2.0', '-1.0']
const genSliceExpr = (g, d) => (d <= 0 || g() < 0.4)
  ? pick(g, SLICE_LEAF)
  : `(${genSliceExpr(g, d - 1)} ${pick(g, ['+', '-', '*'])} ${genSliceExpr(g, d - 1)})`
const progSlice = (g, loop) => `export let f = (a, offs, m, n) => { ${loop('b', 0, 'm', `const o = offs[b]; ${loop('i', 0, 'n', `a[o + i] = ${genSliceExpr(g, 3)}`)}`)} }`

// RING: wrap-masked delay-line indexing — `buf[(h − K) & MASK]` taps + `buf[h & MASK]`
// write + head increment, the pattern under every delay/reverb (bench/delayline pins the
// full case). Guards strength-reduction of the mask chain and the loop-carried head.
const progRing = (g, loop) => {
  const k1 = 1 + Math.floor(g() * 200), k2 = 1 + Math.floor(g() * 900)
  const fb = (0.3 + g() * 0.5).toFixed(2)
  return `export let f = (buf, x, n) => { let h = 0 | 0; ${loop('i', 0, 'n', `const t = buf[(h - ${k1}) & 8191] + buf[(h - ${k2}) & 8191] * ${fb}; const y = x[i] + t * ${fb}; buf[h & 8191] = y; h = (h + 1) | 0`)} }`
}

// CONDREF: conditional ARRAY-REF selection before a hot loop — `const t = k ? a : b` —
// the other half of the Flow-Lenia pathology: the selected ref must keep the typed
// fast path through the ternary (single-assignment select is the idiomatic form).
const CONDREF_LEAF = ['t[i]', 'u[i]', 'i + 0.0', '1.5']
const genCondRefExpr = (g, d) => (d <= 0 || g() < 0.4)
  ? pick(g, CONDREF_LEAF)
  : `(${genCondRefExpr(g, d - 1)} ${pick(g, ['+', '-', '*'])} ${genCondRefExpr(g, d - 1)})`
const progCondRef = (g, loop) => `export let f = (a, b, k, n) => { const t = k === 1 ? a : b; const u = k === 1 ? b : a; ${loop('i', 0, 'n', `t[i] = ${genCondRefExpr(g, 3)}`)} }`

// FGATHER: float-computed gather — a phase accumulator truncated to an index each
// iteration (`ph | 0`), the resampler pattern (bench/resample pins the case; jz
// currently trails V8 ~1.05× there). Guards that float→index truncation stays on the
// typed-load fast path.
const progFGather = (g, loop) => {
  const step = (0.5 + g() * 0.9).toFixed(6)
  return `export let f = (a, out, n) => { let ph = 1.0; ${loop('k', 0, 'n', `const idx = ph | 0; const fr = ph - idx; out[k] = a[idx] + (a[idx + 1] - a[idx]) * fr; ph = ph + ${step}`)} }`
}

export const CATEGORIES = {
  int: { gen: genInt, init: '0|0', step: (e) => `acc = (acc + (${e})) | 0`, ret: 'acc | 0', callable: true },
  float: { gen: genFloat, init: '0', step: (e) => `acc = acc + (${e})`, ret: 'acc', callable: true },
  mixed: { gen: genMixed, init: '0', step: (e) => `acc = acc + (${e})`, ret: 'acc', callable: true },
  // adversarial / structural — ratchet-only (op count), not timed
  cond: { gen: genCond, init: '0|0', step: (e) => `acc = (acc + (${e})) | 0`, ret: 'acc | 0', callable: false },
  buf: { program: progBuf, callable: false },
  nest: { program: progNest, callable: false },
  slice: { program: progSlice, callable: false },
  ring: { program: progRing, callable: false },
  condref: { program: progCondRef, callable: false },
  fgather: { program: progFGather, callable: false },
}

export const genProgram = (cat, seed, style = 'default') => {
  const g = mkRng(seed)
  const c = CATEGORIES[cat], loop = STYLES[style]
  if (!loop) throw new Error(`unknown loop style '${style}'`)
  if (c.program) return c.program(g, loop)   // structural categories build their own source
  const expr = c.gen(g, 4)
  return `export let f = (n, p0, p1, p2) => { let acc = ${c.init}; ${loop('i', 0, 'n', c.step(expr))} return ${c.ret} }`
}
