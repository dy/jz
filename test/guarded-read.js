// A checked element read that decides a branch loads under its guard
// (ir/numeric.js mapCheckedRead): the address clamp of the branch-free form is
// gone there, and a length the binding fixes is the bound's constant
// (module/typedarray.js). A miss still compares as undefined.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, wat } from './util.js'

// A register machine: `a` comes from the program, so no index is proven. The
// program's first and second operands are the caller's: in range, negative,
// the length itself and past it.
const machine = (ctor, test) => `const run = (code, reg, n) => {
  let pc = 0, steps = 0
  while (pc < 4 && steps < n) {
    const a = code[pc * 2], b = code[pc * 2 + 1]
    if (${test}) { reg[a] = (reg[a] - 1) | 0; pc = b } else pc = pc + 1
    steps++
  }
  return steps
}
export let f = (n, a0, a1) => {
  const code = new Int32Array(8), reg = new ${ctor}(4)
  code[0] = a0; code[1] = 0; code[2] = a1; code[3] = 3; code[6] = 2; code[7] = 0
  reg[1] = n; reg[2] = 3
  return run(code, reg, n * 3 + 4) * 1000 + reg[1] * 10 + reg[2]
}`
const args = [[5, 1, 9], [5, 9, 1], [3, -1, 2], [0, 1, 2], [4, 3, 0], [2, 4, 1], [6, 2, 2], [1, 0, -7]]
const tests = ['reg[a] !== 0', 'reg[a] === 0', 'reg[a] != 0', 'reg[a] < 2', 'reg[a] >= 1', '0 !== reg[a]', 'reg[a] > b']

for (const ctor of ['Int32Array', 'Uint8Array', 'Int16Array', 'Uint32Array'])
  test(`guarded read: a ${ctor} element decides a branch`, () => {
    for (const t of tests) {
      const src = machine(ctor, t), host = oracle(src).f
      for (const optimize of levels(0, 2, 3, 'size')) {
        const f = jz(src, { optimize }).exports.f
        for (const a of args) ok(Object.is(f(...a), host(...a)), `${t}, f(${a}) at ${optimize}: ${f(...a)} for ${host(...a)}`)
      }
    }
  })

test('guarded read: the load runs under the guard, the bound a constant', () => {
  if (belowOpt(3)) return
  const text = wat(machine('Int32Array', 'reg[a] !== 0'), { optimize: 3 })
  const body = (funcWat(text, 'f$exp') || funcWat(text, 'f')).replace(/\s+/g, ' ')
  ok(body.includes('i32.lt_u'), 'the guard is there')
  ok(!/\(select \(local\.get [^)]+\) \(i32\.const 0\) \(local\.get [^)]+\)\)/.test(body), 'no address clamp')
  ok(!/i32\.shr_u \(i32\.load \(i32\.sub/.test(body), 'no length read from the header')
})
