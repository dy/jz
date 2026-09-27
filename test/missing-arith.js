// A missing typed element is `undefined`; arithmetic takes its number, NaN.
// The undefined box is itself a NaN, so an operand added raw hands its payload
// to the sum and the result reads as undefined again. Every binding shape a
// missing element can arrive through meets every operator here.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { oracle } from './util.js'

const reads = {
  direct: ['', 'a[k]'],
  constBinding: ['const v = a[k]', 'v'],
  letBinding: ['let v = a[k]', 'v'],
  reassigned: ['let v = a[0]; v = a[k]', 'v'],
  ternary: ['const v = a[k]', '(v === v ? v : -3)'],
  ternaryPick: ['const v = a[k], w = a[1]', '(k > 2 ? v : w)'],
  logicalOr: ['const v = a[k]', '(v || v)'],
  nullish: ['const v = a[k]', '(v ?? v)'],
  comma: ['let v = a[0]', '(v = a[k], v)'],
}
const uses = {
  add: x => `s = s + ${x}`, addAssign: x => `s += ${x}`, addLeft: x => `s = ${x} + s`,
  addTwice: x => `s += ${x} * 2; s += ${x}`,
  sub: x => `s -= ${x}`, mul: x => `s *= ${x}`, div: x => `s = s / ${x}`, rem: x => `s = s % ${x}`,
  neg: x => `s = -${x}`, plus: x => `s = +${x}`, mix: x => `s = s * 2 + ${x} * 3 - 1`,
  store: x => `b[1] = ${x}; s = b[1]`, cmp: x => `s = ${x} < 1 ? 5 : 6`, math: x => `s = Math.abs(${x}) + Math.sqrt(${x})`,
  or0: x => `s = (${x} | 0) + 7`, inc: x => `let q = ${x}; q++; s = q`, dec: x => `let q = ${x}; --q; s = q`,
}
const shells = {
  straight: (decl, use) => `export let f = (k) => { const a = new Float64Array(4), b = new Float64Array(4); a[0] = 1.5; a[1] = 2.5; let s = 1; ${decl}; ${use}; return s }`,
  loop: (decl, use) => `export let f = (k) => { const a = new Float64Array(4), b = new Float64Array(4); a[0] = 1.5; a[1] = 2.5; let s = 1; for (let i = 0; i < 3; i++) { ${decl}; ${use} } return s }`,
}

for (const [shell, wrap] of Object.entries(shells)) for (const [read, [decl, x]] of Object.entries(reads))
  test(`missing element in arithmetic: ${shell}, ${read}`, () => {
    for (const [use, stmt] of Object.entries(uses)) {
      const src = wrap(decl, stmt(x))
      const host = oracle(src).f
      for (const optimize of [0, 2, 3]) {
        const f = jz(src, { optimize }).exports.f
        for (const k of [1, 9]) ok(Object.is(f(k), host(k)), `${use}, k=${k} at ${optimize}: ${f(k)} for ${host(k)}`)
      }
    }
  })
