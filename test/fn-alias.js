// `const g = f`, `f` a function the module holds and `g` never written, reads
// as `f`: a call through it is a direct call, a value use of it is the function
// (src/prepare/handlers.js registerFnAlias). A written alias, and an exported
// one, keep their storage.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { agree, funcWat, run, wat } from './util.js'

const src = `function f(x, y) { let s = 0; for (let i = 0; i < 20; i++) s += (x * i + y) % 7; return s }
  function h(x, y) { return x - y }
  const g = f
  const k = g
  let w = f
  export const swap = () => { w = h; return 1 }
  export const viaAlias = (x) => g(x, 1) + k(x, 2)
  export const viaWritten = (x) => w(x, 3)
  export const asValue = (x) => [g, h].map(fn => fn(x, 4)).reduce((a, b) => a + b, 0)
  export const local = (x) => { const m = f; return m(x, 5) }
  export const exported = g`

test('function alias: every call answers what the host answers, before and after the written one swaps', () => {
  for (const optimize of levels(0, 2, 3)) {
    for (const name of ['viaAlias', 'viaWritten', 'asValue', 'local', 'exported']) agree(src, name, [3], { optimize }, `${name}(3) at ${optimize}`)
    agree(src, 'swap', [], { optimize })
  }
})

// A library re-exporting a neighbour's function (`export const normalize =
// vec4.normalize`): the importer's call is direct too, no closure pointer, no trampoline.
test('function alias: a member of an imported namespace re-exported by name', () => {
  const vec = `export function norm(out, v) { const l = 1 / Math.sqrt(v[0] * v[0] + v[1] * v[1]); out[0] = v[0] * l; out[1] = v[1] * l; return out }
    export function dot(a, b) { return a[0] * b[0] + a[1] * b[1] }`
  const quat = `import * as vec from './vec.js'
    export const normalize = vec.norm
    export const dot = vec.dot
    export const both = (out, v) => dot(normalize(out, v), v)`
  const main = `import * as quat from './quat.js'
    const o = [0, 0], v = [3, 4]
    export const f = () => { let s = 0; for (let i = 0; i < 4; i++) { quat.normalize(o, v); s += o[0] + quat.dot(o, v) + quat.both(o, v) } return s }`
  const modules = { './vec.js': vec, './quat.js': quat }
  const expected = (() => { let s = 0; const o = [0, 0], v = [3, 4]; for (let i = 0; i < 4; i++) { o[0] = 0.6; o[1] = 0.8; s += o[0] + (o[0] * v[0] + o[1] * v[1]) * 2 } return s })()
  for (const optimize of levels(0, 2, 3)) is(run(main, { modules, optimize }).f(), expected, `f() at ${optimize}`)
  const text = wat(main, { modules, optimize: 2 })
  ok(!/call_indirect|tramp_/.test(text), 'no indirect call, no trampoline in the module')
})

test('function alias: the call is direct, the written alias is not', () => {
  const text = wat(src, { optimize: 2 })
  const via = funcWat(text, 'viaAlias$exp') || funcWat(text, 'viaAlias')
  ok(!/call_indirect/.test(via) && !/global\.get \$g\b/.test(via), 'viaAlias calls f itself')
  ok(/call \$f\b/.test(via) || !/call/.test(via), 'directly, or inlined')
  const written = funcWat(text, 'viaWritten$exp') || funcWat(text, 'viaWritten')
  ok(/call_indirect|call_ref/.test(written), 'the written alias dispatches on its value')
  const loc = funcWat(text, 'local$exp') || funcWat(text, 'local')
  ok(!/call_indirect/.test(loc), 'a local alias calls directly too')
})
