// A population of loops that read and write two views of one buffer, each answering what
// Node answers at every level: every pair of views of different element types (of one width
// and of two), two loads and two stores at one index in each order a body can run them, at
// distances -1, 0 and 1 between the views' indexes. The answer is every word of the buffer
// by its place (a sum under 2^53), so a store that lands before a load it should follow, or
// after one it should precede, shows wherever its bytes are read.
//
// Guards the class "a definition moved to its use commutes with what runs between": two views
// of one buffer at one index are the same bytes in the same iteration, which the dependence
// test admits (vectorize/alias.js `apart`, a distance of 0) only as long as the lift keeps
// each element's statements in order.
import test from 'tst'
import { is } from 'tst/assert.js'
import { jz, oracle } from './util.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']
const N = 36
const PAIRS = [
  ['Float32Array', 'Int32Array'], ['Float32Array', 'Uint32Array'], ['Int32Array', 'Uint32Array'],
  ['Int16Array', 'Uint16Array'], ['Int8Array', 'Uint8Array'], ['Uint8ClampedArray', 'Int8Array'],
  ['Float64Array', 'Float32Array'], ['Float64Array', 'Int32Array'], ['Uint16Array', 'Uint8Array'],
]
const DISTANCES = [-1, 0, 1]
// Two loads and two stores, the swap's: `p` and `q` load A[i] and B[j] (j is i and a distance),
// A[i] takes `q` and B[j] takes `p`.
const ORDERS = (() => {
  const perms = [[]]
  for (let k = 0; k < 4; k++) perms.splice(0, perms.length, ...perms.flatMap(p => [0, 1, 2, 3].filter(x => !p.includes(x)).map(x => [...p, x])))
  const bodies = new Set()
  for (const p of perms) {
    const at = (x) => p.indexOf(x)
    const sa = at(1) < at(2), sb = at(0) < at(3)
    const ops = [sb && 'const p = A[i]', sa && 'const q = B[j]', `A[i] = ${sa ? 'q' : 'B[j]'}`, `B[j] = ${sb ? 'p' : 'A[i]'}`]
    bodies.add(p.map(x => ops[x]).filter(Boolean).join('; '))
  }
  return [...bodies]
})()
// The distance is written into B's index (`B[i + 1]`): an index of a local of its own (`const
// j = i + 0`) is a site the map does not take, and the swap ran as written.
const atDistance = (k, order) => order.replaceAll('B[j]', `B[${k ? `i ${k < 0 ? '-' : '+'} ${Math.abs(k)}` : 'i'}]`)
const program = ([TA, TB], body) => `const buf = new ArrayBuffer(512)
export let main = (n) => {
  const w = new Uint32Array(buf)
  for (let i = 0; i < 128; i++) w[i] = 0x3f000000 + i * 977
  const A = new ${TA}(buf, 64, 40), B = new ${TB}(buf, 64, 40)
  for (let i = 4; i < n; i++) { ${body} }
  let s = 0; for (let i = 0; i < 128; i++) s += w[i] * (i + 1)
  return s
}`

// Every level of each program, its differences gathered: one assertion a pair, naming each
// program and level that differs (an assertion stops its test at the first).
for (const pair of PAIRS) test(`view order population: ${pair.join(' and ')}, ${ORDERS.length} orders, ${DISTANCES.length} distances, ${CONFIGS.length} configurations`, () => {
  const diffs = []
  for (const k of DISTANCES) for (const order of ORDERS) {
    const body = atDistance(k, order), src = program(pair, body), want = String(oracle(src).main(N))
    for (const optimize of CONFIGS) {
      let got
      try { got = String(jz(src, { optimize }).exports.main(N)) } catch (e) { got = `throws: ${String(e.message).split('\n')[0]}` }
      if (got !== want) diffs.push(`${body}, at ${JSON.stringify(optimize)}: ${got}, where Node answers ${want}`)
    }
  }
  is(diffs, [], `${pair.join(', ')}: ${ORDERS.length * DISTANCES.length} programs`)
})
