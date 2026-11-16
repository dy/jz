// A population of loops over a typed array where a uint32 (`b >>> 0`, a length) stands where the
// versioning on typed extents reads a word, each answering what Node answers at levels 0 to 3,
// size and speed: the loop's bound (inline, less and plus one, halved, a mirrored index, a
// `while`, an outer and an inner bound of a nest), a bound counted down to and from, the
// counter's start, a stride, six offsets of the index, a cursor started or stepped by it; read,
// tested for presence, stored, read and stored; four array types. Every loop is capped by its
// own count, so any argument ends; each store past the end is no store in Node and each read
// there undefined.
import test from 'tst'
import { population } from './_population.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']
const CAP = 44
const P = []
const RECV = { f64: ['new Float64Array(8)', 8], u8: ['new Uint8Array(8)', 8], i32: ['new Int32Array(8)', 8], f32: ['new Float32Array(12)', 12] }
const sumOf = n => Array.from({ length: n }, (_, k) => `${k + 1} * x[${k}]`).join(' + ')
const fill = n => Array.from({ length: n }, (_, k) => `x[${k}] = ${k + 1}`).join('; ')
const U = { b: 'b >>> 0', s: 's >>> 0', t: 't >>> 0' }
// what a trip does with the index expression
const BODY = {
  read: ix => `sum += x[${ix}]`,
  test: ix => `if (x[${ix}] === undefined) u++; else sum += x[${ix}]`,
  store: ix => `x[${ix}] = c + 10`,
  both: ix => `x[${ix}] = x[${ix}] + c`,
}
const big = [2147483647, 2147483648, 2147483653, 4294967295, 4294967293, 4294967290, -1, -3, 4294967296]
const few = [0, 1, 3, 7, 8, 9, 12, 20]
const ARGS = []
for (const b of [...few, ...big]) for (const s of [0, 2, 5, 8, ...big.slice(0, 7)]) for (const t of [1, 2, 3, 2147483648, 4294967295]) ARGS.push([b, s, t])
const prog = (name, recv, lines) => {
  const [ctor, n] = RECV[recv]
  P.push({ name: `${name} [${recv}]`, src: `export let f = (b, s, t) => {\n  const x = ${ctor}; ${fill(n)}\n  let c = 0, u = 0, sum = 0\n  ${lines}\n  return [c, sum, u, ${sumOf(n)}]\n}`, args: ARGS })
}

// (each shape over the receivers and bodies in turn, four rounds)
let k = 0
const recvs = Object.keys(RECV), bodies = Object.keys(BODY)
const next = () => [recvs[k % recvs.length], bodies[(k++ >> 1) % bodies.length]]
const cap = `if (++c > ${CAP}) break; `
for (let round = 0; round < 4; round++) {
  // the bound
  for (const op of ['<', '<=']) for (const step of ['i++', 'i += 2']) {
    const [r, bd] = next()
    prog(`bound uint ${op} ${step} ${bd}`, r, `const B = ${U.b}\n  for (let i = 0; i ${op} B; ${step}) { ${cap}${BODY[bd]('i')} }`)
  }
  { const [r, bd] = next(); prog(`bound uint inline ${bd}`, r, `for (let i = 0; i < (${U.b}); i++) { ${cap}${BODY[bd]('i')} }`) }
  { const [r, bd] = next(); prog(`bound uint less one ${bd}`, r, `const B = ${U.b}\n  for (let i = 0; i < B - 1; i++) { ${cap}${BODY[bd]('i')} }`) }
  { const [r, bd] = next(); prog(`bound uint plus one ${bd}`, r, `const B = ${U.b}\n  for (let i = 0; i < B + 1; i++) { ${cap}${BODY[bd]('i')} }`) }
  { const [r, bd] = next(); prog(`bound uint halved ${bd}`, r, `const B = ${U.b}\n  for (let i = 0; i < (B >>> 1); i++) { ${cap}${BODY[bd]('i')} }`) }
  { const [r, bd] = next(); prog(`bound uint, index i + 1 and i - 1 ${bd}`, r, `const B = ${U.b}\n  for (let i = 1; i < B; i++) { ${cap}${BODY[bd]('i + 1')}; ${BODY[bd]('i - 1')} }`) }
  { const [r, bd] = next(); prog(`bound uint, mirror index ${bd}`, r, `const B = ${U.b}\n  for (let i = 0; i < B; i++) { ${cap}${BODY[bd]('B - 1 - i')} }`) }
  { const [r, bd] = next(); prog(`bound uint, while ${bd}`, r, `const B = ${U.b}\n  let i = 0\n  while (i < B) { ${cap}${BODY[bd]('i')}; i++ }`) }
  // counting down to it, and from it
  { const [r, bd] = next(); prog(`down to a uint ${bd}`, r, `const B = ${U.b}\n  for (let i = s; i > B; i--) { ${cap}${BODY[bd]('i')} }`) }
  { const [r, bd] = next(); prog(`down from a uint ${bd}`, r, `const S = ${U.s}\n  for (let i = S; i >= 0; i--) { ${cap}${BODY[bd]('i')} }`) }
  { const [r, bd] = next(); prog(`down from a uint less one ${bd}`, r, `const S = ${U.s}\n  for (let i = S - 1; i >= 0; i--) { ${cap}${BODY[bd]('i')} }`) }
  // the start
  { const [r, bd] = next(); prog(`start uint, bound a word ${bd}`, r, `const S = ${U.s}, B = b | 0\n  for (let i = S; i < B; i++) { ${cap}${BODY[bd]('i')} }`) }
  { const [r, bd] = next(); prog(`start uint, bound uint ${bd}`, r, `const S = ${U.s}, B = ${U.b}\n  for (let i = S; i < B; i++) { ${cap}${BODY[bd]('i')} }`) }
  { const [r, bd] = next(); prog(`start uint, bound a Number ${bd}`, r, `const S = ${U.s}\n  for (let i = S; i < b; i++) { ${cap}${BODY[bd]('i')} }`) }
  // an offset of the index
  for (const ix of ['i + off', 'i - off', 'off - i', 'off + i * 2', 'i + off - 2147483648', 'off']) {
    const [r, bd] = next()
    prog(`offset uint, x[${ix}] ${bd}`, r, `const off = ${U.s}, B = b & 15\n  for (let i = 0; i < B; i++) { ${cap}${BODY[bd](ix)} }`)
  }
  { const [r, bd] = next(); prog(`offset uint of a Number bound ${bd}`, r, `const off = ${U.s}\n  for (let i = 0; i < b; i++) { ${cap}${BODY[bd]('i - off')} }`) }
  // a stride
  { const [r, bd] = next(); prog(`stride uint ${bd}`, r, `const st = ${U.t}, B = b | 0\n  for (let i = 0; i < B; i += st) { ${cap}${BODY[bd]('i')} }`) }
  { const [r, bd] = next(); prog(`stride uint, bound uint ${bd}`, r, `const st = ${U.t}, B = ${U.b}\n  for (let i = 0; i < B; i += st) { ${cap}${BODY[bd]('i')} }`) }
  // a cursor beside the counter
  { const [r, bd] = next(); prog(`cursor from a uint ${bd}`, r, `let p = ${U.s}\n  const B = b & 15\n  for (let i = 0; i < B; i++) { ${cap}${BODY[bd]('p')}; p++ }`) }
  { const [r, bd] = next(); prog(`cursor stepped by a uint ${bd}`, r, `let p = 0\n  const st = ${U.t}, B = b & 15\n  for (let i = 0; i < B; i++) { ${cap}${BODY[bd]('p')}; p += st }`) }
  // a nest
  { const [r, bd] = next(); prog(`nest, inner bound uint ${bd}`, r, `const B = ${U.b}\n  for (let j = 0; j < 3; j++) for (let i = 0; i < B; i++) { ${cap}${BODY[bd]('i + j')} }`) }
  { const [r, bd] = next(); prog(`nest, outer bound uint ${bd}`, r, `const B = ${U.b}\n  for (let j = 0; j < B; j++) { if (c > ${CAP}) break; for (let i = 0; i < 3; i++) { c++; ${BODY[bd]('i + j')} } }`) }
  // the bound a length of another array, a uint by its nature
  { const [r, bd] = next(); prog(`bound another's length ${bd}`, r, `const y = new Uint8Array(b & 63)\n  for (let i = 0; i < y.length; i++) { ${cap}${BODY[bd]('i')} }`) }
}

test(`uint loops population: ${P.length} loops with a uint32 bound, start, stride or offset, ${ARGS.length} argument triples, ${CONFIGS.length} configurations`, () =>
  population('uint loops', P, { configs: CONFIGS }))
