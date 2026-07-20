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
  // The immutable-update kernel's slots are strict (bitwise/int32-literal
  // writes through the optimistic fixpoint): the structInline carrier then
  // packs the elements into raw i32 cells (inlineCellI32) — field reads are
  // bare `i32.load`, zero trunc_sat/convert in the inner loop, and the
  // ternary locals declare i32.
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
  const loop = stepBody.slice(stepBody.indexOf('(loop'))
  ok(/i32\.load/.test(loop), 'packed cells: slot reads are bare i32.load')
  ok(!/trunc_sat/.test(loop), 'no f64→i32 conversion left in the kernel loop')
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

// Structural slotOf closed-world hole: the old form checked slot-consistency
// only among schemas CONTAINING the prop — an OBJECT receiver of a schema
// LACKING it read (and WROTE) the foreign slot. `p.x` on a {z,w,q} record
// returned z; `p.x = v` corrupted z in place. Sound form: the prop must live
// at the same slot in EVERY registered schema; unique-prop receivers keep the
// runtime-guarded devirt (guardedSlotOf), everything else goes dynamic.
test('slot-hazards: structural slotOf refuses schemas lacking the prop (read + write)', () => {
  const src = `
const mk = () => { const a = []; a.push({ x: 41, y: 2 }); return a }
const other = () => { const b = []; b.push({ z: 3, w: 4, q: 5 }); return b }
const rd = (ps) => { const p = ps[0]; return p.x }
const wr = (ps) => { const p = ps[0]; p.x = 99 }
export let main = () => {
  const missing = rd(other()) === undefined ? 1 : 0   // JS: undefined, not z
  const hit = rd(mk())                                 // 41
  const o = other()
  wr(mk())
  wr(o)                                                // JS: expando x, z untouched
  const t = o[0]
  return (hit * 1000 + missing * 100 + t.z * 10 + (t.x === 99 ? 1 : 0)) | 0   // 41131
}`
  for (const optimize of LEVELS) {
    const exportsJs = {}
    new Function('exports', src.replace(/export let (\w+) =/g, 'exports.$1 ='))(exportsJs)
    is(run(src, { optimize }).main(), exportsJs.main(), `O${optimize}: cross-schema prop read/write JS-exact`)
  }
})

test('slot-hazards: all-schemas-share-the-slot keeps the structural fast path', () => {
  // Both registered schemas carry `tag` at slot 0 — the closed-world condition
  // holds, so the unresolved receiver reads the slot directly (values exact
  // for both shapes through one binding).
  const src = `
const mk = () => { const a = []; a.push({ tag: 7, u: 1 }); return a }
const other = () => { const b = []; b.push({ tag: 9, v: 2 }); return b }
const use = (ps) => ps[0].tag
export let main = () => (use(mk()) * 10 + use(other())) | 0`
  for (const optimize of LEVELS)
    is(run(src, { optimize }).main(), 79, `O${optimize}: shared-slot structural read exact`)
})

// Cross-function bare-name binding collision (the kernel-fragility episodes'
// TRUE root, three times manifested): ctx.schema.vars is module-global and
// keyed by BARE NAME, so one function's `const site = {…}` literal used to
// resolve ANOTHER function's same-named binding — a for-of binding, a param, a
// non-literal decl — through the literal's layout: a RAW fixed-slot load at a
// foreign offset, no guard, no dyn fallback, at EVERY optimize level (the
// self-host kernel's rest-spec read `site.callee` off the wrong slot when an
// unrelated pass added a differently-ordered literal). prepare's binding
// census now bars such names from the vars channel (per-function ValueReps
// keep devirtualizing); reads fall to the guarded/dyn path.
test('slot-hazards: literal decl in one function must not type another function\'s for-of binding', () => {
  const src = `
const use = (arr) => { let s = 0; for (const site of arr) s += site.callee; return s }
const mk = () => { const a = []; a.push({ callee: 5, argList: 1, callerFunc: 2, node: 3 }); return a }
const other = () => { const site = { argList: 9, callerFunc: 8, node: 7, callee: 6 }; return site.node }
export let main = () => use(mk()) + other()`
  for (const optimize of LEVELS)
    is(run(src, { optimize }).main(), 12, `O${optimize}: for-of binding reads its own layout`)
})

test('slot-hazards: literal decl in one function must not type another function\'s param', () => {
  const src = `
const use = (site) => site.callee
const mk = () => ({ callee: 5, argList: 1, callerFunc: 2, node: 3 })
const other = () => { const site = { argList: 9, callerFunc: 8, node: 7, callee: 6 }; return site.node }
export let main = () => use(mk()) + other()`
  for (const optimize of LEVELS)
    is(run(src, { optimize }).main(), 12, `O${optimize}: param reads its own layout`)
})

test('slot-hazards: binding-order independence + own-function devirt survives the bar', () => {
  // Literal decl FIRST (binds vars before the collision arrives) — the census
  // must bar retroactively; and `other`'s own read stays value-exact through
  // its per-function rep (barring gates only the module-global name channel).
  const src = `
const other = () => { const site = { argList: 9, callerFunc: 8, node: 7, callee: 6 }; return site.node * 10 + site.callee }
const use = (arr) => { let s = 0; for (const site of arr) s += site.callee; return s }
const mk = () => { const a = []; a.push({ callee: 5, argList: 1, callerFunc: 2, node: 3 }); return a }
export let main = () => other() * 100 + use(mk())`
  for (const optimize of LEVELS)
    is(run(src, { optimize }).main(), 7605, `O${optimize}: 76*100 + 5`)
})

test('slot-hazards: unique-bound literal name keeps the vars-channel devirt', () => {
  // No collision — a single-function literal binding still compiles `cfg.mode`
  // through the schema slot (structural pin: no dyn dispatcher for the read).
  const src = `
export let main = () => { const cfg = { mode: 3, bias: 4 }; return cfg.mode + cfg.bias }`
  const wat = jz.compile(src, { wat: true, optimize: 2 })
  const m = wat.split('(func ').find(c => /^\$main\b/.test(c)) || ''
  ok(!/__dyn_get/.test(m), 'unique literal binding stays slot-resolved')
  is(run(src, { optimize: 2 }).main(), 7, 'value exact')
})

test('slot-hazards: plain catch binding must not resolve through a foreign literal', () => {
  // Plain `catch (site)` never passes through prepDecl — it censuses directly;
  // pre-fix it read the colliding literal's slot 3 (37) instead of slot 0.
  const src = `
const use = () => {
  try { throw { callee: 5, argList: 1, callerFunc: 2, node: 3 } }
  catch (site) { return site.callee }
}
const other = () => { const site = { argList: 9, callerFunc: 8, node: 7, callee: 6 }; return site.node }
export let main = () => use() * 10 + other()`
  for (const optimize of LEVELS)
    is(run(src, { optimize }).main(), 57, `O${optimize}: catch binding reads the thrown object's layout`)
})

test('slot-hazards: non-literal decl init + shaped reassignment reads the init value first', () => {
  // The decl initializer is a shape source the `=`-consensus never saw — a
  // later literal assignment must poison, not bind (pre-fix: before read the
  // reassignment literal's slot → 59).
  const src = `
const mk = () => ({ x: 5, y: 2 })
export let main = () => {
  let o = mk()
  const before = o.x
  o = { y: 9, x: 6 }
  return before * 10 + o.x
}`
  for (const optimize of LEVELS)
    is(run(src, { optimize }).main(), 56, `O${optimize}: read before reassignment sees mk()'s layout`)
})

test('slot-hazards: param + shaped reassignment reads the caller value first', () => {
  // Same class through a param binding: the caller's arg is the unseen source.
  const src = `
const use = (o) => { const before = o.x; o = { y: 9, x: 6 }; return before * 10 + o.x }
export let main = () => use({ x: 5, y: 2 })`
  for (const optimize of LEVELS)
    is(run(src, { optimize }).main(), 56, `O${optimize}: param read before reassignment exact`)
})

test('slot-hazards: unrelated same-named param must not deopt another function\'s binding (rename invariance)', () => {
  // Owner-scoped census: `use`'s param `o` and `other`'s assignment-bound `o`
  // are different bindings — the bare-name poison here was a measured 1.57×
  // SIZE cliff (rename-dependent codegen). Same-length rename must be
  // byte-count-identical, and the shared name must compile to the LEAN form.
  const jzc = jz.compile
  const A = `
const use = (o) => o.x
const other = () => { let o; o = { x: 1 }; return o.x + use({ x: 2 }) }
export let main = () => other()`
  const B = A.replace('(o) => o.x', '(p) => p.x')
  const sa = jzc(A, { optimize: 2 }).length, sb = jzc(B, { optimize: 2 }).length
  is(sa, sb, 'same-length param rename does not change output size')
  for (const optimize of LEVELS) is(run(A, { optimize }).main(), 3, `O${optimize}: values exact`)
})

test('slot-hazards: object-literal param default must not type supplied arguments', () => {
  // The default shape holds only on the omitted-arm; a caller's differently-
  // ordered object stores x elsewhere — the unconditional default-schema
  // install read the default's slot (6 → 9 at every tier). The param is
  // supplied-shape ∪ default-shape: only call-evidence channels may devirt.
  const src = `
const f = (o = { x: 1, y: 2 }) => o.x
export let omitted = () => f()
export let supplied = () => f({ y: 9, x: 6 })`
  for (const optimize of LEVELS) {
    const e = run(src, { optimize })
    is(e.omitted(), 1, `O${optimize}: omitted arg takes the default's layout`)
    is(e.supplied(), 6, `O${optimize}: supplied arg reads its OWN layout`)
  }
})
