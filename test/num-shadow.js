// A local that may hold undefined or null and is read numerically in a loop
// carries its ToNumber in a shadow local (compile/num-shadow.js): the loop
// reads the shadow, a read of the local itself still sees undefined or null.
// A recursion seeded from a checked read (`let z = s[0]`, the state on a
// parameter object in audiojs's filters) converted its seed on every iteration.
import test from 'tst'
import { levels } from './_matrix.js'
import { agree } from './util.js'

const src = `let proc = (x, s) => { let z = s[0], a = 0.5; for (let i = 0; i < x.length; i++) z = z * 0.5 + x[i] * a; return z }
let fill = (n, v) => new Float32Array(n).fill(v)
export let seeded = () => [proc(fill(4, 1), new Float64Array(0)), proc(fill(0, 1), new Float64Array(0)), proc(fill(3, 2), new Float64Array(1).fill(4)), proc(fill(0, 1), new Float64Array(1).fill(4))].map(String).join()
let steps = (n, init) => { let v = init; for (let i = 0; i < n; i++) { v = v - 1; if (v < -2) v++ } return v }
export let fromNull = () => [steps(0, null), steps(3, null), steps(0, undefined), steps(2, undefined), steps(4, 1)].map(String).join()
let counted = (n, arr) => { let c = arr[0]; for (let i = 0; i < n; i++) c++; return c }
export let updates = () => [counted(0, []), counted(2, []), counted(2, [5]), counted(0, [null])].map(String).join()
let late = (x) => { let m; for (let i = 0; i < x.length; i++) m = m > x[i] ? m : x[i]; return m }
export let uninit = () => [late([]), late([3, 1, 4]), late([NaN])].map(String).join()`
const calls = [['seeded', []], ['fromNull', []], ['updates', []], ['uninit', []]]

for (const optimize of levels(0, 2, 3, 'size'))
  test(`num shadow: a maybe-missing number read in a loop keeps its identity at ${optimize}`, () => {
    for (const [name, args] of calls) agree(src, name, args, { optimize }, `${name}() at ${optimize}`)
  })
