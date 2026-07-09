// Speculative typed-param specialization (narrow's speculateTypedParams +
// emitSpeculativeCall) — the GUARDED sibling of the bimorphic clones, for the
// fftplan/provenance shape-class: kernel params whose args flow through Map
// caches, nullable memo globals, returned-object fields, or local-arrow
// harnesses and can therefore never be statically PROVEN typed. The pass
// clones the kernel with those params typed and every static call site
// dispatches through one masked NaN-box compare per speculated arg:
//   tags-all-match? call $kernel$spec(raw offsets…) : call $kernel(boxes…)
// Soundness NEVER rests on the evidence — the runtime guard eats nullish,
// views, plain arrays, anything — so these pins prove three things: the clone
// exists where evidence lands, values are exact on the fast path, and a
// guard MISS still computes the exact JS result through the original.
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import jz from '../index.js'

const opts = { wat: true, optimize: { level: 'speed', watr: false } }

// fftplan in miniature: plan built once, cached in a Map + last-plan memo,
// tables reach the kernel as returned-object fields. No edge here is provable.
const PLAN_SRC = `
const cache = new Map()
let lastN = 0, lastPlan = null
const makePlan = (n) => {
  const tw = new Float64Array(n)
  for (let i = 0; i < n; i++) tw[i] = i * 0.5
  const perm = new Uint32Array(n)
  for (let i = 0; i < n; i++) perm[i] = (n - 1) - i
  return { perm, tw }
}
const getPlan = (n) => {
  if (n === lastN) return lastPlan
  let p = cache.get(n)
  if (p === undefined) { p = makePlan(n); cache.set(n, p) }
  lastN = n; lastPlan = p
  return p
}
const kernel = (out, perm, tw, n) => {
  let s = 0
  for (let i = 0; i < n; i++) { const v = tw[perm[i]]; out[i] = v; s += v }
  return s
}
export let go = (n) => {
  const out = new Float64Array(n)
  const plan = getPlan(n)
  return kernel(out, plan.perm, plan.tw, n)
}`

test('speculate: Map/memo plan fields produce a guarded typed clone', () => {
  const w = jz.compile(PLAN_SRC, opts)
  ok(w.includes('$kernel$spec'), 'spec clone emitted')
  // the dispatch: masked hi-word compare on the arg box (tag TYPED + elem aux)
  ok(/i64\.and[\s\S]{0,200}?i64\.eq/.test(w.slice(w.indexOf('func $go'))), 'guarded dispatch at the call site')
  // the clone's loop is fully typed — no dynamic element dispatch
  const i = w.indexOf('func $kernel$spec')
  const body = w.slice(i, w.indexOf('\n  (func', i + 5))
  ok(!/__typed_idx|__dyn_get|__arr_idx/.test(body), 'clone kernel reads/writes raw')
})

test('speculate: plan-field route is value-correct (fast path)', () => {
  const { exports } = jz(PLAN_SRC)
  // perm reverses; tw[i] = i*0.5 → s = Σ i·0.5 for i in [0,64) = 1008
  is(exports.go(64), 1008)
  is(exports.go(64), 1008)  // memo hit (lastPlan) — same route, same values
})

// guard MISS: same kernel, one call site feeds a plain Array — evidence stays
// (the other site's census), but at runtime the tag check fails and the
// ORIGINAL kernel must produce the exact generic-path result.
test('speculate: guard miss falls back to the original, value-exact', () => {
  const src = `
const mk = (n) => { const tw = new Float64Array(n); for (let i = 0; i < n; i++) tw[i] = i; return { tw } }
const P = mk(16)
const sum = (tw, n) => { let s = 0; for (let i = 0; i < n; i++) s += tw[i]; return s }
export let fast = (n) => sum(P.tw, n)
export let slow = (n) => { const a = [1, 2, 3, 4]; return sum(a, n) }`
  const w = jz.compile(src, opts)
  ok(w.includes('$sum$spec'), 'clone exists despite the mixed site (guard handles it)')
  const { exports } = jz(src)
  is(exports.fast(16), 120)   // Σ 0..15 — typed fast path
  is(exports.slow(4), 10)     // 1+2+3+4 — plain-array miss → original path
})

// the provenance harness shape: the kernel call sits inside a local arrow whose
// params carry the evidence through the arrow's OWN call sites (ret / field /
// Map / memo — one of each).
test('speculate: arrow-harness params meet evidence across arrow call sites', () => {
  const src = `
const mkRet = (n) => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 1; return w }
const mkPair = (n) => { const wre = new Float64Array(n); for (let i = 0; i < n; i++) wre[i] = 2; return { wre } }
const cache = new Map()
const getMap = (n) => { let p = cache.get(n); if (p === undefined) { p = mkPair(n); cache.set(n, p) } return p }
let last = null
const getMemo = (n) => { if (last === null) last = mkPair(n); return last }
const kernel = (tw, n) => { let s = 0; for (let i = 0; i < n; i++) s += tw[i]; return s }
export let go = (n) => {
  const a = mkRet(n)
  const b = mkPair(n).wre
  const c = getMap(n).wre
  const d = getMemo(n).wre
  const edge = (tw, h) => h + kernel(tw, n)
  let h = 0
  h = edge(a, h)
  h = edge(b, h)
  h = edge(c, h)
  h = edge(d, h)
  return h
}`
  const w = jz.compile(src, opts)
  ok(w.includes('$kernel$spec'), 'clone from arrow-param evidence')
  const { exports } = jz(src)
  // n=8: ret contributes 8·1, each pair edge 8·2 → 8 + 3·16 = 56
  is(exports.go(8), 56)
})

// the write gate: one assignment to the prop anywhere kills the census — no
// clone, everything stays on the (correct) dynamic path.
test('speculate: a written field prop disables census evidence', () => {
  const src = `
const mk = (n) => { const tw = new Float64Array(n); return { tw } }
const P = mk(16)
export let poke = (x) => { P.tw = x; return 1 }
const sum = (tw, n) => { let s = 0; for (let i = 0; i < n; i++) s += tw[i]; return s }
export let go = (n) => sum(P.tw, n)`
  const w = jz.compile(src, opts)
  ok(!w.includes('$sum$spec'), 'no clone for a rewritable field')
})

// nullish through the guard: a null table must not become a trap on the
// speculated route — the guard routes it to the original path, and the result
// must match the unoptimized compile bit-for-bit (differential, since jz's
// null[i] semantics predate this pass).
test('speculate: nullish table falls through the guard, no trap', () => {
  const src = `
const mk = (n) => { const tw = new Float64Array(n); for (let i = 0; i < n; i++) tw[i] = i; return { tw } }
const P = mk(8)
const sum = (tw, n) => { let s = 0; for (let i = 0; i < n; i++) s += tw[i]; return s }
export let fast = (n) => sum(P.tw, n)
export let nul = (n) => sum(null, n)`
  const { exports } = jz(src)
  is(exports.fast(8), 28)               // Σ 0..7 — typed fast path
  const control = jz(src, { optimize: 0 }).exports
  is(exports.nul(4), control.nul(4), 'null table: optimized == unoptimized, no trap')
})
