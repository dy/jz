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
