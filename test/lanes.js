// Record parameters as lanes (src/compile/plan/lanes.js): a callee that reads
// its parameter only field by field takes the fields as scalars, and a call
// site that spelled the record as a literal never allocates it.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels, onWasi } from './_matrix.js'

const NO_INLINE = { optimize: { sourceInline: false } }   // keep the callee a call, so the ABI shows
const bodyOf = (wat, name) => { const i = wat.indexOf(`(func $${name}`); if (i < 0) return ''; const j = wat.indexOf('\n  (func ', i + 10); return wat.slice(i, j < 0 ? undefined : j) }
const wat = (src) => compile(src, { wat: true, ...NO_INLINE })

test('lanes: a literal record passed to a field-reading callee becomes scalar parameters', () => {
  const src = `function len(v) { return Math.sqrt(v.x * v.x + v.y * v.y) }
    export function dist(ax, ay, bx, by) { return len({ x: bx - ax, y: by - ay }) }`
  const w = wat(src)
  ok(/\(func \$len\$lanes/.test(w), 'the lane sibling exists')
  ok(/\(param \$v\$x f64\)\s+\(param \$v\$y f64\)/.test(w), 'one f64 parameter per field read')
  ok(!/alloc/.test(bodyOf(w, 'dist')), 'the caller allocates nothing')
  ok(!/\(func \$len\b[^$]/.test(w), 'the record form is dead and shaken')
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.dist(0, 0, 3, 4), 5, `O${optimize}`)
})

test('lanes: a literal held in a binding is read only through the lanes and dissolves', () => {
  const src = `function len(v) { return Math.sqrt(v.x * v.x + v.y * v.y) }
    export function f(ax, ay) { const v = { x: ax, y: ay }; return len(v) + len(v) }`
  const w = wat(src)
  ok(/\(func \$len\$lanes/.test(w), 'the lane sibling exists')
  ok(!/alloc/.test(bodyOf(w, 'f')), 'the binding scalarizes')
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(3, 4), 10, `O${optimize}`)
})

test('lanes: a record of known shape has its fields loaded at the call', () => {
  const src = `function len(v) { return Math.sqrt(v.x * v.x + v.y * v.y) }
    const pts = [{ x: 3, y: 4 }, { x: 6, y: 8 }]
    export function f() { let s = 0; for (const p of pts) s += len(p); return s }`
  const w = wat(src)
  ok(!/\(func \$len\b[^$]/.test(w), 'the record form is gone: the lanes are read at the call, and the sibling inlines as a leaf')
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(), 15, `O${optimize}`)
})

test('lanes: the lanes keep the literal\'s evaluation order or its effect-free values', () => {
  // Effectful values spelled against the callee's read order stay a record.
  const reordered = `let n = 0
    const tick = () => ++n
    function sub(v) { return v.x - v.y }
    export function f() { return sub({ y: tick(), x: tick() }) }`
  ok(!/\$sub\$lanes/.test(wat(reordered)), 'effectful values out of lane order decline')
  for (const optimize of levels(0, 2, 3)) is(jz(reordered, { optimize }).exports.f(), 1, `O${optimize}: x = 2, y = 1`)
  // Effect-free values in any order take the lanes.
  const free = `function sub(v) { return v.x - v.y }
    export function f(a, b) { return sub({ y: b, x: a }) }`
  ok(/\$sub\$lanes/.test(wat(free)), 'effect-free values reorder freely')
  for (const optimize of levels(0, 2, 3)) is(jz(free, { optimize }).exports.f(5, 2), 3, `O${optimize}`)
})

test('lanes: a callee that writes a field, passes the record on, or is exported keeps it', () => {
  const cases = {
    writes: `function bump(v) { v.x += 1; return v.x }
      export function f() { return bump({ x: 1 }) }`,
    passes: `function id(o) { return o }
      function len(v) { return id(v).x }
      export function f() { return len({ x: 2 }) }`,
    exported: `export function len(v) { return v.x + v.y }
      export function f() { return len({ x: 1, y: 1 }) }`,
    computed: `function get(v, k) { return v[k] }
      export function f() { return get({ x: 2 }, 'x') }`,
    closure: `export function run(h) { return h() }
      function len(v) { const g = () => v.x; return run(g) }
      export function f() { return len({ x: 2 }) }`,
  }
  for (const [name, src] of Object.entries(cases)) {
    ok(!/\$lanes/.test(wat(src)), `${name}: no lane sibling`)
    for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(), 2, `${name} O${optimize}`)
  }
})

test('lanes: a site passing an unknown value keeps the record form everywhere', () => {
  const src = `function len(v) { return v.x + v.y }
    export function g(o) { return len(o) }
    export function f() { return len({ x: 1, y: 1 }) }`
  ok(!/\$lanes/.test(wat(src)), 'one opaque site declines the callee')
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize })
    is(m.exports.f(), 2, `O${optimize}: literal site`)
    if (!onWasi()) is(m.exports.g({ x: 2, y: 3 }), 5, `O${optimize}: boundary site`)   // wasi: no host objects cross
  }
})

test('lanes: a key the callee never reads is evaluated only when effect-free', () => {
  const src = `function len(v) { return v.x }
    export function f(a, b) { return len({ x: a, y: b }) }`
  ok(/\$len\$lanes/.test(wat(src)), 'an unread effect-free key drops')
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(4, 9), 4, `O${optimize}`)
  const effect = `let n = 0
    const tick = () => ++n
    function len(v) { return v.x }
    export function f(a) { return len({ x: a, y: tick() }) + n }`
  ok(!/\$len\$lanes/.test(wat(effect)), 'an unread effectful key keeps the record')
  for (const optimize of levels(0, 2, 3)) is(jz(effect, { optimize }).exports.f(4), 5, `O${optimize}: the effect ran`)
})
