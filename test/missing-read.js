// A read that finds nothing answers undefined, whatever kind the receiver's
// elements have: an index past the end of an array, a typed array or a string,
// an empty array's `pop`, a `find` that matched nothing, a key a Map does not
// hold, an argument not passed. Its kind names what a read finds, so every
// consumer that takes a number must take the missing value to NaN first, a sum
// beside a string must concatenate "undefined", and an identity test must see
// it. Each receiver meets each binding form and each use, against the host.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels } from './_matrix.js'
import { oracle } from './util.js'

const pick = 'const pick = (k) => [new Float32Array(4), new Float64Array(4), new Float64Array(8).subarray(4)][k % 3]\n'
// [module prelude, the receiver's declaration, the read]
const receivers = {
  f64: ['', 'const a = new Float64Array(4); a[0] = 1.5; a[1] = 2.5', 'a[k]'],
  f32: ['', 'const a = new Float32Array(4); a[0] = 1.5; a[1] = 2.5', 'a[k]'],
  i16: ['', 'const a = new Int16Array(4); a[0] = 3; a[1] = -2', 'a[k]'],
  openTyped: [pick, 'const a = pick(k); a[0] = 1.5; a[1] = 2.5', 'a[k]'],
  numArray: ['', 'const a = [1.5, 2.5, 3.5]', 'a[k]'],
  strArray: ['', `const a = ['x', 'y']`, 'a[k]'],
  mixArray: ['', `const a = [1.5, 2.5, 'y', true, null]`, 'a[k]'],
  pushed: ['', 'const a = []; a.push(1.5); a.push(2.5)', 'a[k]'],
  holes: ['', 'const a = new Array(4); a[1] = 2.5', 'a[k]'],
  string: ['', `const a = 'xy'`, 'a[k]'],
  map: ['', 'const a = new Map([[0, 1.5], [1, 2.5]])', 'a.get(k)'],
  field: ['', 'const a = { p: undefined, q: 2.5 }; if (k === 1) a.p = 2.5', 'a.p'],
  call: ['const pickv = (k) => { if (k === 1) return 2.5 }\n', 'const a = 0', 'pickv(k)'],
  argument: ['const second = (x, y) => y\n', 'const a = 0', '(k === 1 ? second(1, 2.5) : second(1))'],
  optional: ['', 'const a = k === 1 ? { p: 2.5 } : null', 'a?.p'],
  find: ['', 'const a = [1.5, 2.5]', 'a.find(x => x > k)'],
  pop: ['', 'const a = k === 1 ? [2.5] : []', 'a.pop()'],
}
const reads = {
  direct: ['', x => x],
  constBinding: ['const v = X', () => 'v'],
  letBinding: ['let v = X', () => 'v'],
  reassigned: ['let v = 0; v = X', () => 'v'],
  ternary: ['const v = X', () => '(v === v ? v : -3)'],
  logicalOr: ['const v = X', () => '(v || v)'],
  nullish: ['const v = X', () => '(v ?? v)'],
  // a conditional answers by its arms: the read itself, a binding, a sum
  condRead: ['', x => `(k > 0 ? ${x} : -3)`],
  clamp: ['const v = X', () => '(v > 2 ? 2 : (v < 0 ? 0 : v))'],
  sumArm: ['const v = X', () => '(k > 5 ? v : v + 1)'],
}
const uses = {
  add: x => `s = s + ${x}`, addAssign: x => `s += ${x}`, addLeft: x => `s = ${x} + s`,
  sub: x => `s -= ${x}`, mul: x => `s *= ${x}`, div: x => `s = s / ${x}`, rem: x => `s = s % ${x}`,
  neg: x => `s = -${x}`, plus: x => `s = +${x}`, mix: x => `s = s * 2 + ${x} * 3 - 1`,
  store: x => `b[1] = ${x}; s = b[1]`, store32: x => `c[1] = ${x}; s = c[1]`, storeInt: x => `d[1] = ${x}; s = d[1]`,
  cmp: x => `s = ${x} < 1 ? 5 : 6`, math: x => `s = Math.abs(${x}) + Math.sqrt(${x})`, min: x => `s = Math.min(${x}, 3)`,
  or0: x => `s = (${x} | 0) + 7`, inc: x => `let q = ${x}; q++; s = q`, pow: x => `s = ${x} ** 2`,
  ret: x => `s = ${x}`, eq: x => `s = ${x} === undefined ? 1 : 0`, typeOf: x => `s = typeof ${x} === 'undefined' ? 1 : 0`,
}
const dest = 'b = new Float64Array(4), c = new Float32Array(4), d = new Int32Array(4)'
const shells = {
  straight: (recv, decl, use) => `(k) => { ${recv}; const ${dest}; let s = 1; ${decl}; ${use}; return s }`,
  loop: (recv, decl, use) => `(k) => { ${recv}; const ${dest}; let s = 1; for (let i = 0; i < 3; i++) { ${decl}; ${use} } return s }`,
}

// One module a receiver: every shell, binding form and use is an export of it.
const moduleOf = ([pre, recv, x]) => {
  const names = []
  let src = pre
  for (const [sn, wrap] of Object.entries(shells)) for (const [bn, [decl, ref]] of Object.entries(reads)) for (const [un, stmt] of Object.entries(uses)) {
    const name = `${sn}_${bn}_${un}`
    names.push(name)
    src += `export let ${name} = ${wrap(recv, decl.replace('X', x), stmt(ref(x)))}\n`
  }
  return { src, names }
}

for (const [receiver, row] of Object.entries(receivers))
  test(`missing read: ${receiver}`, () => {
    const { src, names } = moduleOf(row)
    const host = oracle(src)
    for (const optimize of levels(0, 2, 3, 'size')) {
      const mod = jz(src, { optimize }).exports
      for (const name of names) for (const k of [1, 9]) {
        const want = host[name](k), got = mod[name](k)
        ok(Object.is(want, got), `${name}(${k}) at ${optimize}: ${String(got)} for ${String(want)}`)
      }
    }
  })
