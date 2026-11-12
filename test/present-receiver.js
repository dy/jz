// A receiver that is itself an element read whose one missing value is absence
// (`pts[i][0]`, `bones[i].start`: the array holds arrays or objects, never
// null) throws from that read's own bounds test; the check the receiver would
// have had after it is gone. An array that may hold null keeps its check, and a
// receiver whose only missing value is absence tests for undefined alone
// (module/array.js `throwAbsent`, module/core.js). The index is a counter: a
// key the host may pass as anything takes the keyed read, checks and all.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'
import parseWat from 'watr/parse'
import { walk } from '../scripts/wat-probe.mjs'

const fnText = (text, name) => funcWat(text, name + '$exp') || funcWat(text, name)

const src = `const pts = [[1, 2], [3, 4]], objs = [{ v: [5, 6] }, { v: [7, 8] }], mixed = [[1], null, [3]]
  export const x = (n) => { let s = 0; for (let i = 0; i < n; i++) s += pts[i][0] + objs[i].v[1]; return s }
  export const y = (n) => { let s = 0; for (let i = 0; i < n; i++) s += mixed[i][0]; return s }`

test('present receiver: in-range reads answer, a read past the end throws, as the host does', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(src), jz = run(src, { optimize })
    for (const n of [0, 1, 2]) is(jz.x(n), host.x(n), `x(${n}) at ${optimize}`)
    throws(() => jz.x(3), 'x(3): the element past the end has no [0]')
    throws(() => host.x(3))
    is(jz.y(1), host.y(1), `y(1) at ${optimize}`)
    throws(() => jz.y(2), 'y(2): a null element has no [0]')
    throws(() => host.y(2))
  }
})

test('present receiver: the bounds test is the only test, a null-holding array keeps its check', () => {
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  const x = fnText(text, 'x'), y = fnText(text, 'y')
  let loops = 0
  walk(parseWat(x), n => {
    if(n[0]!=='loop')return
    loops++
    is((JSON.stringify(n).match(/i64\.eq/g) || []).length, 0, 'each x loop compares no sentinel: its receivers throw from their bounds tests')
  })
  ok(loops>0,'the guarded paths contain loops')
  ok(/call \$__throw_property_nullish/.test(x), 'the miss arm throws')
  ok(/i64\.eq/.test(y), 'y still tests the element it read: the array holds a null')
})

// A program's one missing-receiver check still calls the throw helper
// (compile/index.js programPins): spliced into its one caller, the
// error's allocation and stores would sit in the loop's cold arm.
const once = `const ps = [{ v: 1 }, undefined, { v: 3 }]
  export const g = (n) => { let s = 0; for (let i = 0; i < n; i++) s += ps[i % 3].v; return s }`

test('present receiver: a sole missing-receiver check throws as the host does', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(once), jz = run(once, { optimize })
    is(jz.g(1), host.g(1), `g(1) at ${optimize}`)
    throws(() => jz.g(2), 'g(2): the hole has no v')
    throws(() => host.g(2))
  }
})

test('present receiver: a sole missing-receiver check calls the throw helper, no allocation in the loop', () => {
  if (belowOpt(2)) return
  const g = fnText(wat(once, { optimize: 2 }), 'g')
  ok(/call \$__throw_property_nullish/.test(g), 'the miss arm calls the helper')
  ok(!/call \$__alloc/.test(g), 'the error is built in the helper, not in g')
})

// A row a const names is the element read: a missing one has no length and no
// element, and a row the program grows or replaces has the length it has then.
// The plan read `row.length` off the literal's row lengths (`rowlen[i]`) and
// unrolled a loop bounded by a table of lengths as if every bound were one of
// the literal's (plan/loops.js, removed): `d.length` past the end answered
// undefined, a pushed row its literal count, a bound past the end ran the
// shortest row's steps, a row index below zero no step. Node's message names
// the key; jz's is its prefix.
const rows = `export const len = (n) => { const a = [[1]]; const d = a[n]; return d.length }
  export const elem = (n) => { const a = [[1]]; const d = a[n]; return d[0] }
  export const pushed = (n) => { const rows = [[1, 2], [3]]; const row = rows[0]; row.push(n); return row.length }
  export const replaced = (n) => { const rows = [[1, 2], [3]]; rows[0] = [n]; const row = rows[0]; return row.length }
  export const padded = (n) => { const lens = [2, 3]; const out = [0, 0, 0]; for (let i = 0; i < lens[n]; i++) out[i] = 1; return out.join() }
  export const written = (n) => { const lens = [2, 3]; lens[1] = 1; const out = [0, 0, 0]; for (let i = 0; i < lens[n]; i++) out[i] = 1; return out.join() }
  export const chord = (t) => { const prog = [[0, 3, 7, 10, 14], [5, 8, 12, 15], [7, 11, 14, 17], [0, 3, 7, 10, 14]]; const ch = prog[(t * .5 | 0) % 4]; let pad = 0; for (let i = 0; i < ch.length; i++) pad += ch[i] * t; return pad }`

const thrown = (f) => { try { f() } catch (e) { return e } }

test('present receiver: a row a const names answers its own length, and a missing one throws as the host does', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(rows), jz = run(rows, { optimize })
    for (const [f, n, missing] of [['len', 0, 5], ['elem', 0, 5], ['chord', 3, -2]]) {
      is(jz[f](n), host[f](n), `${f}(${n}) at ${optimize}`)
      const got = thrown(() => jz[f](missing)), want = thrown(() => host[f](missing))
      ok(got instanceof TypeError && want.message.startsWith(got.message), `${f}(${missing}) at ${optimize}: ${got?.message}`)
    }
    for (const t of [0, 1.5, 4.25, 7]) is(jz.chord(t), host.chord(t), `chord(${t}) at ${optimize}`)
    for (const f of ['pushed', 'replaced', 'padded', 'written'])
      for (const n of [0, 1, 5]) is(jz[f](n), host[f](n), `${f}(${n}) at ${optimize}`)
  }
})
