/**
 * Slot-census write hazards (src/compile/program-facts.js:
 * collectSlotWriteHazards + census write observation, module/schema.js reader
 * belts, src/kind.js VT['.'] census deferral).
 *
 * The slot censuses (slotIntCertain / slotTypes / slotTypedCtors) once
 * observed only `{}` literals and resolvable `obj.prop =` writes — every
 * other write family silently left stale facts that consumers baked into
 * codegen. Each test here pins a probed-live miscompile:
 *   1. dyn keyed write `o[k] = v` vs Math.floor elision
 *   2. dyn keyed write of a string vs slotVT NUMBER (raw arithmetic on a box)
 *   3. `.prop=` through an unresolvable receiver vs floor elision
 *   4. compound assign `o.x += 0.5` vs floor elision
 *   5. plain resolvable write of a string vs slotVT NUMBER
 *   6. const-JSON float into a literal-shared sid vs floor elision
 * Plus the precision guards: compound INT writes keep certainty, and the
 * JSON shaped-parser sids keep their sample KINDS (slotTypes observes them —
 * shape divergence at runtime falls back to disjoint generic sids).
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { ctx } from '../src/ctx.js'
import { run } from './util.js'

const LEVELS = [0, 2]

test('slot-hazards: dyn keyed write poisons floor elision', () => {
  const src = `
let sink = 'x'
export let main = () => {
  const o = {x: 1}
  o[sink] = 1.5
  return Math.floor(o.x)
}`
  for (const optimize of LEVELS) is(run(src, { optimize }).main(), 1, `O${optimize}: floor NOT elided`)
})

test('slot-hazards: dyn keyed string write poisons slot NUMBER kind', () => {
  const src = `
let sink = 'x'
export let main = () => {
  const o = {x: 1}
  o[sink] = 'oops'
  return o.x + 1
}`
  for (const optimize of LEVELS) is(run(src, { optimize }).main(), 'oops1', `O${optimize}: concat dispatch kept`)
})

test('slot-hazards: unresolvable-receiver prop write poisons floor elision', () => {
  const src = `
const hit = (q) => { q.x = 1.5 }
export let main = () => {
  const o = {x: 1}
  hit(o)
  hit({y: 2, x: 3, z: 4})
  return Math.floor(o.x)
}`
  for (const optimize of LEVELS) is(run(src, { optimize }).main(), 1, `O${optimize}: floor NOT elided`)
})

test('slot-hazards: compound float assign poisons, compound int assign keeps certainty', () => {
  const float = `
export let main = () => {
  const o = {x: 1}
  o.x += 0.5
  return Math.floor(o.x)
}`
  for (const optimize of LEVELS) is(run(float, { optimize }).main(), 1, `O${optimize}: float += poisons`)
  // `o.n++` / `o.n += 2|0` keep int-certainty via the effective-value synth —
  // value-exact either way, this guards the OBSERVATION (not just the poison)
  const int = `
export let main = () => {
  const o = {n: 1}
  for (let i = 0; i < 3; i++) o.n++
  o.n += 2
  return Math.floor(o.n / 2)
}`
  for (const optimize of LEVELS) is(run(int, { optimize }).main(), 3, `O${optimize}: int compound exact`)
})

test('slot-hazards: plain string write clashes the literal NUMBER kind', () => {
  const src = `
let sink2 = ''
export let main = () => {
  const o = {x: 1}
  o.x = 'oops' + sink2
  return o.x + 1
}`
  for (const optimize of LEVELS) is(run(src, { optimize }).main(), 'oops1', `O${optimize}: concat dispatch kept`)
})

test('slot-hazards: const-JSON float into a literal-shared sid poisons floor elision', () => {
  const src = `
const mk = () => ({x: 1})
export let main = () => {
  const o = JSON.parse('{"x":1.5}')
  const p = mk()
  return Math.floor(o.x) + p.x
}`
  for (const optimize of LEVELS) is(run(src, { optimize }).main(), 2, `O${optimize}: floor(1.5) NOT elided`)
})

test('slot-hazards: strict-i32 lattice range edges stay f64 (level 1, not 2)', () => {
  // A slot fed by integral-but-not-int32 producers must NOT take the raw i32
  // load route: 3e9 exceeds int32 (i32.trunc_sat would saturate to 2^31-1),
  // `>>> 0` of a negative is a uint32 above 2^31. Value pins prove no
  // saturation; the census check pins the lattice verdicts themselves —
  // including `%` and unary minus, the -0-capable producers (their runtime -0
  // is already normalized upstream by jz's int arithmetic lowering, so only
  // the level verdict is observable here).
  // Records flow through an array so the literal survives scalarization and
  // the schema is a real runtime shape (a fully-SROA'd literal has no slots).
  const src = `
let five = 5
const rows = []
for (let i = 0; i < 4; i++)
  rows.push({ big: 3000000000 - i, u: (-5 | 0) >>> 0, m: (0 - five) % 5, n: -(five - 5), s: five & 7 })
export let main = () => {
  let out = ''
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i]
    if (i === 0) out = (o.big + 1) + ',' + o.u + ',' + o.s
  }
  return out
}`
  for (const optimize of LEVELS)
    is(run(src, { optimize }).main(), '3000000001,4294967291,5', `O${optimize}: no i32 saturation`)
  // Level verdicts via the compiler's schema state: only the bitwise slot is strict.
  jz.compile(src, { optimize: 2 })
  const arr = [...ctx.schema.slotI32Certain.values()].find(a => a.length === 5)
  ok(arr, 'census ran on the 5-slot schema')
  is(arr.join(','), 'false,false,false,false,true', 'only the & slot is strict-i32')
})

test('slot-hazards: strict-i32 slots load raw i32 on the immutable kernel', () => {
  // The immutable-update kernel's four slots are strict (bitwise/int32-literal
  // writes through the optimistic fixpoint): every field read lands as
  // `i32.trunc_sat_f64_s(load)` with NO ToInt32 NaN-guard select left in the
  // inner loop, and the ternary locals declare i32.
  const src = `
const step = (ps) => {
  let sum = 0
  for (let it = 0; it < 8; it++)
    for (let i = 0; i < 64; i++) {
      const p = ps[i]
      const nx = (p.x + p.vx) | 0
      const hitX = nx < 0 || nx > 1023
      const x = hitX ? p.x : nx, vx = hitX ? -p.vx | 0 : p.vx
      ps[i] = { x: x, vx: vx }
      sum = (sum + x) | 0
    }
  return sum
}
const init = () => {
  const ps = []
  let s = 0x1234abcd | 0
  for (let i = 0; i < 64; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    const vx = ((s >>> 4) & 15) - 8
    ps.push({ x: (s >>> 12) & 1023, vx: (vx === 0 ? 1 : vx) | 0 })
  }
  return ps
}
export let main = () => step(init())`
  const wat = jz.compile(src, { wat: true, optimize: 'speed' })
  const stepBody = wat.split('(func ').find(c => /^\$step\b/.test(c)) || ''
  ok(/\(local \$x i32\)/.test(stepBody), 'ternary local x declared i32')
  ok(/i32.trunc_sat_f64_s\s*\(f64.load/.test(stepBody.replace(/\n\s*/g, ' ')), 'slot reads land raw i32')
  const exportsJs = {}
  new Function('exports', src.replace(/export let (\w+) =/g, 'exports.$1 ='))(exportsJs)
  is(run(src, { optimize: 'speed' }).main(), exportsJs.main(), 'bit-matches plain JS')
})

test('slot-hazards: miss-capable reads keep their undefined guards (no sentinel fold)', () => {
  // emit's strictSentinel fold trusts kind + non-nullable; the value-kind
  // inference types `.get()` results / element reads from container kinds, so
  // mayBeNullish must flag them (fail-closed) or the guard folds away — the
  // self-host kernel's own `autoCache.get(name) !== undefined` cache probe
  // folded TRUE and every call returned the miss sentinel (the byte-parity
  // root). The dedupe-cache idiom pins it end to end.
  const src = `
const cache = new Map()
const compute = (k) => k * 2 + 1
let computes = 0
export let memo = (k) => {
  let v = cache.get(k)
  if (v !== undefined) return v
  computes = computes + 1
  v = compute(k)
  cache.set(k, v)
  return v
}
export let count = () => computes`
  for (const optimize of LEVELS) {
    const { memo, count } = run(src, { optimize })
    is(memo(3) + memo(3) + memo(4), 7 + 7 + 9, `O${optimize}: values exact`)
    is(count(), 2, `O${optimize}: second memo(3) HIT the cache (guard not folded)`)
  }
})

test('slot-hazards: shaped-parser sids keep sample kinds (json fast path intact)', () => {
  // The kind-safe refinement: a shaped JSON.parse must not fall back to
  // __to_num-per-field reads. Structural pin: the walk function's field
  // arithmetic on shaped records emits NO __to_num when kinds are observed.
  const src = `
const SHAPE = '{"id":1,"qty":2,"price":3.5}'
export let main = (n) => {
  let t = 0
  for (let i = 0; i < n; i++) {
    const r = JSON.parse(SHAPE)
    t += r.qty * r.price + r.id
  }
  return t
}`
  const wat = jz.compile(src, { wat: true, optimize: 2 })
  const m = wat.split('(func ').find(c => /^\$main\b/.test(c)) || ''
  ok(!/call \$__to_num/.test(m), 'shaped record field reads pay no __to_num')
  is(run(src, { optimize: 2 }).main(4), 4 * (2 * 3.5 + 1), 'value exact')
})
