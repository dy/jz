// A bare declaration (`let t`) that its function assigns before every read
// never shows the undefined it was declared with (src/summary/definite.js):
// the summary declares it empty, and what it holds is what was assigned. A
// declaration some read can find unassigned stays absent.
import test from 'tst'
import { is } from 'tst/assert.js'
import { compile } from '../index.js'
import { ctx } from '../src/ctx.js'
import { definitelyAssigned } from '../src/summary/definite.js'
import { K, hasTag } from '../src/summary/kind.js'
import { levels } from './_matrix.js'
import { agree } from './util.js'

// [name, source, args, the bare declarations assigned before every read]
const programs = [
  ['assigned in one arm and read there', `const o = [0, 0], q = [3, 4]
    const t = (out, a) => { let a0, a1; if (a === out) { out[1] = a[0] } else { a0 = a[0]; a1 = a[1]; out[0] = a0; out[1] = a1 } return out }
    export const f = () => { t(o, q); return o[0] + o[1] }`, [], ['a0', 'a1']],
  ['assigned in both arms, read after', `export const f = (c) => { let t; if (c > 0) { t = 1 } else { t = 2 } return t * 10 }`, [1], ['t']],
  ['assigned in one arm, read after', `export const f = (c) => { let t; if (c > 0) { t = 1 } return t === undefined ? -1 : t }`, [0], []],
  ['read before the assignment', `export const f = (c) => { let t; const r = t === undefined ? 7 : 0; t = c; return r + t }`, [1], []],
  ['a loop body that may not run', `export const f = (n) => { let t; for (let i = 0; i < n; i++) { t = i } return t === undefined ? -1 : t }`, [0], []],
  ['assigned then read inside a loop', `export const f = (n) => { let t, s = 0; for (let i = 0; i < n; i++) { t = i * 2; s += t } return s }`, [4], ['t']],
  ['a closure made before the assignment', `export const f = (n) => { let t; const g = () => t === undefined ? -1 : t; const r = g(); t = n; return r + g() }`, [5], []],
  ['a closure made after the assignment', `export const f = (n) => { let t; t = n; const g = () => t + 1; return g() }`, [5], ['t']],
  ['an arm that returns', `export const f = (c) => { let t; if (c > 0) return 0; else t = 5; return t }`, [0], ['t']],
  ['a conditional assigning in both arms', `export const f = (c) => { let t; c > 0 ? (t = 1) : (t = 2); return t }`, [0], ['t']],
  ['a right side that may not run', `export const f = (c) => { let t; c > 0 && (t = 1); return t === undefined ? -1 : t }`, [0], []],
  ['a compound assignment reads first', `export const f = (c) => { let t; t += c; return t !== t ? 1 : 0 }`, [2], []],
  ['a try body that may leave early', `const bad = (c) => { if (c > 0) throw new Error('x'); return 1 }
    export const f = (c) => { let t; try { bad(c); t = 1 } catch (e) { } return t === undefined ? -1 : t }`, [1], []],
  ['a pattern assignment', `export const f = (c) => { let a, b; [a, b] = [c, c * 2]; return a + b }`, [3], ['a', 'b']],
  ['a switch that may skip', `export const f = (c) => { let t; switch (c) { case 1: t = 5; break } return t === undefined ? -1 : t }`, [2], []],
  ['a loop test that assigns', `let k = 0
    const next = () => { k = k + 1; return k <= 3 ? k : -1 }
    export const f = () => { let v, s = 0; while ((v = next()) > 0) s += v; return s + v }`, [], ['v']],
]

const source = name => name.replace(/[^A-Za-z0-9_$].*$/, '')

test('definite assignment: the declarations assigned before every read', () => {
  for (const [name, src, , want] of programs) {
    compile(src, { optimize: 0 })
    const found = new Set()
    for (const fn of ctx.funcs.list) if (fn.body) for (const n of definitelyAssigned(fn.body)) found.add(source(n))
    is([...found].sort().join(), [...want].sort().join(), name)
  }
})

test('definite assignment: every program matches the host', () => {
  for (const [name, src, args] of programs)
    for (const optimize of levels(0, 1, 2, 3)) agree(src, 'f', args, { optimize }, `${name} at ${optimize}`)
})

test('definite assignment: such a binding holds what was assigned, never absence', () => {
  compile(`const o = [0, 0], q = [3, 4]
    const t = (out, a) => { let a0, late; if (a === out) { out[1] = a[0] } else { a0 = a[0]; out[0] = a0 } late = late === undefined ? 1 : 2; return out }
    export const f = () => { t(o, q); return o[0] + o[1] }`, { optimize: 0 })
  const fn = ctx.funcs.map.get('t'), view = ctx.summary.at(fn.body)
  const spelled = name => JSON.parse(JSON.stringify(fn.body).match(new RegExp('"' + name + '[^"A-Za-z0-9_$][^"]*"'))[0])
  is(hasTag(view.kindOf(spelled('a0')), K.ABSENT), false, 'assigned before its reads')
  is(hasTag(view.kindOf(spelled('late')), K.ABSENT), true, 'read before its assignment')
  is(view.fixedLenOf('o'), 2, 'the array it is stored into keeps its elements present and its count')
})
