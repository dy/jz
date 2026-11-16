// Statements that ask a Map or a Set about a key and then store it, each program answering what
// Node answers at levels 0 to 3, size and speed. A statement whose two halves read and write one
// table probes it once (compile/emit/fuse-probes.js `__slot_open`, the find by the key's form,
// collection/forms.js keyForm), its slot held from the find to the store, so the population puts
// between the halves what may move that slot or empty it: a delete of another key, a growth past
// the table's buckets, a clear, a call that does one of them to the table it is handed; and keys
// of each kind (integers, strings, objects, atoms, a mix with -0 and NaN). A program folds its
// tables in their order: a slot reused across a mutation, a key hashed by the wrong form or a
// table laid out at the wrong load answers otherwise.
import test from 'tst'
import { population } from './_population.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']

// the keys of a kind, `K`, an array of 24 (objects made as the module starts: identity keys)
const KINDS = {
  int: 'const K = new Int32Array(24); for (let i = 0; i < 24; i++) K[i] = (i * 2654435761 | 0) % 100000',
  string: "const K = []; for (let i = 0; i < 24; i++) K.push(i % 5 === 0 ? 'k' + i : 'key-' + (i * 7) % 24 + (i > 12 ? '-long, past an inline string' : ''))",
  object: 'const K = []; for (let i = 0; i < 24; i++) K.push({ id: i })',
  atom: 'const K = []; for (let i = 0; i < 24; i++) K.push(i % 4 === 0 ? undefined : i % 4 === 1 ? null : i % 4 === 2)',
  mixed: "const O = { id: 99 }, K = [0, -0, NaN, 1.5, -1, 'a', 'a' + 'b', O, undefined, null, true, false, 2 ** 31, 2 ** 53, 'NaN', '0']; for (let i = 0; i < 8; i++) K.push(i % 2 ? { id: i } : 'm' + i)",
}

// What runs between a statement's halves, on the table `t` the statement asks (M or S, `add` its
// store), as a statement (`s`) and inside an expression (`e`, a comma's first operand).
const BETWEEN = {
  none: () => ({ s: '', e: '' }),
  delete: (t) => ({ s: `${t}.delete(K[(j * 5 + 3) % K.length]);`, e: `${t}.delete(K[(j * 5 + 3) % K.length]), ` }),
  grow: (t, add) => ({ s: `if (j % 7 === 3) for (let q = 0; q < 40; q++) ${t}.${add}(1e6 + q + j * 64${add === 'set' ? ', q' : ''});`, e: `(j % 7 === 3 && grow(${t}, j)), ` }),
  clear: (t) => ({ s: `if (j % 11 === 5) ${t}.clear();`, e: `(j % 11 === 5 && ${t}.clear()), ` }),
  call: (t) => ({ s: `touch(${t}, j);`, e: `touch(${t}, j), ` }),
}
const HELPERS = `const grow = (t, j) => { for (let q = 0; q < 40; q++) t instanceof Map ? t.set(1e6 + q + j * 64, q) : t.add(1e6 + q + j * 64) }
const touch = (t, j) => {
  if (j % 3 === 0) t.delete(K[(j * 7 + 1) % K.length])
  else if (j % 3 === 1) for (let q = 0; q < 30; q++) t instanceof Map ? t.set(2e6 + q + j * 64, q) : t.add(2e6 + q + j * 64)
  else if (j % 13 === 2) t.clear()
}
const fold = (t) => { let h = t.size; for (const e of t) { const key = Array.isArray(e) ? e[0] : e, v = Array.isArray(e) ? e[1] : 1; h = (h * 31 + (typeof key === 'object' && key ? key.id : typeof key === 'string' ? key.length * 3 + key.charCodeAt(0) : typeof key === 'number' ? (key === key ? (Object.is(key, -0) ? 5 : key % 1000) : 7) : String(key).length) + (typeof v === 'number' ? v : 0)) % 1000003 } return h }`

// The statements: `k` the key, `s` what runs between as a statement, `e` inside an expression.
const SHAPES = {
  'has, then set': ({ s }) => `if (!M.has(k)) { ${s} M.set(k, j) }`,
  'has or a read, then set': ({ e }) => `if (!M.has(k) || (${e}M.get(k) < j)) M.set(k, j)`,
  'get, then set on a miss': ({ s }) => `let x = M.get(k); if (x === undefined) { ${s} x = j; M.set(k, x) }`,
  'get, then set of an update': ({ e }) => `M.set(k, (M.get(k) || 0) + (${e}1))`,
  'a read, then a store': ({ s }) => `const l = (M.get(k) || 0) - 1; ${s} M.set(k, l)`,
  'a Set\'s first sight': ({ s }) => `if (S.has(k)) { ${s} continue } S.add(k)`,
  'a Set, has then add': ({ s }) => `if (!S.has(k)) { ${s} S.add(k); c++ }`,
}

const P = []
for (const [kind, keys] of Object.entries(KINDS)) for (const [shape, stmt] of Object.entries(SHAPES)) for (const [what, between] of Object.entries(BETWEEN)) {
  const set = shape.includes('Set') ? ['S', 'add'] : ['M', 'set']
  P.push({ name: `${kind} keys, ${shape}, ${what} between`, args: [[3], [40], [300]], src: `${keys}
${HELPERS}
export let f = (n) => {
  const M = new Map(), S = new Set()
  let c = 0
  for (let j = 0; j < n; j++) {
    const k = K[(j * 7 + (j >> 3)) % K.length]
    ${stmt(between(...set))}
  }
  return [fold(M), fold(S), M.size, S.size, c]
}` })
}

test(`map population: ${P.length} statements over a Map or a Set, by key kind and what runs between their halves, ${CONFIGS.length} configurations`, () =>
  population('map statements', P, { configs: CONFIGS, own: ['K', 'O', 'grow', 'touch', 'fold'], chunk: 35 }))
