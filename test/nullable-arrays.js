// An array that meets undefined or null alone keeps its cell and its elements' kinds, as a
// nullable array (summary/index.js mixedJoinIn: a mix of an array with a primitive starts beside
// a number, a string, a Boolean or a BigInt, never beside nullish alone): a field raised
// undefined before the array arrives, `let x = null` filled later. The decoders' shape first: a
// result layout an empty constant shares, whose channel list was escaped by the mix and its
// Float32Array elements read as any value, every sample's store a runtime dispatch. Then what the
// kept cell licenses, through a holder that may be nullish: a read or a store while it is null
// throws as in Node, the optional forms and tests answer as in Node, the holder reset or given
// an array of another kind joins the kinds, the element numbers and counts follow every store,
// and a closure made before the fill sees it. Each program answers what Node answers at every level.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, oracle, wat } from './util.js'

const LEVELS = [false, true, 'size', { level: 'speed', relaxedFloat: false }, 'speed']
const name = (o) => JSON.stringify(o)
const asNode = (label, src) => {
  const want = oracle(src).main()
  for (const optimize of LEVELS) is(run(src, { optimize }).main(), want, `${label}, ${name(optimize)}: as Node`)
}
// (the stores of the program's own functions: an inline element store, or the runtime's dispatch)
const own = (src, optimize) => wat(src, { optimize }).split(/\n(?=\s*\(func )/).filter(f => /^\s*\(func \$/.test(f) && !/^\s*\(func \$__/.test(f)).join('\n')
const count = (s, re) => (s.match(re) || []).length
const GENERIC = /call \$__(arr_typed_obj_set_idx|arr_typed_set_idx|typed_set_idx_tagged|dyn_set)\b/g

test('nullable arrays: a channel list a result layout shares with an empty constant keeps its Float32Array elements', () => {
  const src = `const EMPTY = Object.freeze({ data: [], rate: 0 })
const frame = (k, n) => {
  const data = Array.from({ length: k }, () => new Float32Array(n))
  for (let c = 0; c < k; c++) { const out = data[c]; for (let i = 0; i < n; i++) out[i] = i * 0.5 + c }
  return { data, rate: n, samples: n }
}
const decode = (z) => {
  if (z) return EMPTY
  let parts = []
  for (let r = 0; r < 2; r++) { const f = frame(2, 37); parts.push(f.data) }
  return { data: parts.length === 1 ? parts[0] : parts[1], rate: 37 }
}
export let main = () => {
  const r = decode(0)
  let s = 0
  for (let c = 0; c < r.data.length; c++) { const a = r.data[c]; for (let i = 0; i < a.length; i++) s += a[i] }
  return s + decode(1).data.length * 1000 + r.data[1].length
}`
  asNode('channel list', src)
  for (const optimize of [true, 'speed']) {
    const w = own(src, optimize)
    ok(count(w, /f32\.store/g) > 0 && count(w, GENERIC) === 0, `${name(optimize)}: an f32.store a sample, no runtime dispatch`)
  }
})

test('nullable arrays: a read, a length and a store through a holder still null throw as in Node', () => {
  asNode('holder null', `let holder = null
const tries = (f) => { try { return f() } catch (e) { return e instanceof TypeError ? 'TypeError' : 'other' } }
export let main = () => {
  const out = [tries(() => holder[0][1]), tries(() => holder.length), tries(() => { holder[0][1] = 2.5; return 0 })]
  holder = Array.from({ length: 2 }, () => new Float32Array(4))
  holder[1][2] = 1.25
  out.push(holder[1][2], holder.length, holder[0][3])
  holder = null
  out.push(tries(() => holder[1][2]), tries(() => holder.length))
  return out.join(',')
}`)
})

test('nullable arrays: the optional forms and the tests of a nullable holder answer as in Node', () => {
  asNode('optional forms', `export let main = () => {
  let x = null
  const out = [x?.[1], x?.length, (x ?? [7])[0], x === null, typeof x]
  if (x) x[1] = 3
  x = new Float32Array(3)
  if (x) x[1] = 3.5
  out.push(x?.[1], x?.length, (x ?? [7])[0], x === null, typeof x, x[1])
  return out.join(',')
}`)
})

test('nullable arrays: a holder set back to null, and given an array of another element kind, joins the kinds', () => {
  asNode('reset and another kind', `let h = null
const put = (i, v) => { h[i] = v }
export let main = () => {
  const out = []
  h = new Float32Array(4); put(1, 1.1); out.push(h[1])
  h = null
  try { out.push(h[1]) } catch (e) { out.push(e instanceof TypeError) }
  h = new Float64Array(4); put(1, 1.1); out.push(h[1])
  h = [0, 0, 0]; put(1, 'a'); out.push(h[1])
  return out.join(',')
}`)
})

test('nullable arrays: the element numbers and the count follow every store through the holder', () => {
  asNode('numbers and count', `let h = null
export let main = () => {
  h = [1, 2, 3]
  let s = 0
  for (let i = 0; i < h.length; i++) s += h[i]
  h[1] = 0.5
  for (let i = 0; i < h.length; i++) s += h[i] * 10
  const fixed = [0, 0, 0]
  let g = null
  g = fixed
  g = [1, 2, 3, 4, 5]
  for (let i = 0; i < g.length; i++) s += g[i] * 100
  return s + g.length + g[4]
}`)
})

test('nullable arrays: a closure made before the holder is filled reads what the fill put', () => {
  asNode('closure', `export let main = () => {
  let buf = null
  const get = (i) => buf[i], set = (i, v) => { buf[i] = v }
  buf = new Float32Array(4)
  set(2, 1.5)
  let s = get(2)
  buf = Array.from({ length: 3 }, (_, i) => i * 2)
  return s + get(2) + buf.length
}`)
})

// The mix itself, where a real primitive meets the array: the array escapes as before.
test('nullable arrays: a primitive beside an array still mixes, and answers as in Node', () => {
  asNode('slot undefined, array, number', `const make = (k) => k === 0 ? { v: undefined } : k === 1 ? { v: [new Float32Array(2), new Float32Array(2)] } : { v: 7 }
export let main = () => {
  let s = 0
  for (let k = 0; k < 3; k++) { const o = make(k); if (Array.isArray(o.v)) { o.v[1][0] = 2.5; s += o.v[1][0] } else s += o.v === undefined ? 100 : o.v }
  return s
}`)
  asNode('binding null, array, string', `export let main = (z) => {
  let x = null
  const out = [x === null]
  x = [new Float32Array(2)]
  x[0][1] = 3.25
  out.push(x[0][1])
  x = 'str'
  out.push(x[1], x.length)
  return out.join(',')
}`)
  asNode('a field through two layouts, one undefined', `const A = { data: undefined, n: 0 }
const make = (n) => ({ data: [new Float32Array(n)], n })
export let main = () => {
  let s = 0
  for (let r = 0; r < 3; r++) { const o = r === 1 ? A : make(4); if (o.data) { o.data[0][1] = r + 0.5; s += o.data[0][1] } else s += 10 }
  return s
}`)
})

// The array's own kinds, as before: an element of another kind, null, a plain array pushed, an
// alias, a parameter, a callback of two kinds.
test('nullable arrays: an array of typed arrays whose elements differ answers as in Node', () => {
  const rows = {
    'an element a plain array': 'const a = Array.from({ length: 2 }, () => new Float32Array(3)); a[1] = [0, 0, 0]',
    'an element null': 'const a = Array.from({ length: 2 }, () => new Float32Array(3)); a[1] = null',
    'an element a Float64Array': 'const a = Array.from({ length: 2 }, () => new Float32Array(3)); a[1] = new Float64Array(3)',
    'a plain array pushed': 'const a = Array.from({ length: 1 }, () => new Float32Array(3)); a.push([0, 0, 0])',
    'an alias': 'const a = Array.from({ length: 2 }, () => new Float32Array(3)); const b = a; b[1] = new Float64Array(3)',
    'a callback of two kinds': 'const a = Array.from({ length: 2 }, (_, i) => i ? new Float64Array(3) : new Float32Array(3))',
  }
  for (const [label, make] of Object.entries(rows)) asNode(label, `const fill = (a, c) => { const out = a[c]; if (out) for (let i = 0; i < 3; i++) out[i] = i * 0.1 + c }
export let main = () => {
  ${make}
  for (let c = 0; c < a.length; c++) fill(a, c)
  let s = ''
  for (let c = 0; c < a.length; c++) s += a[c] ? a[c][1] + ';' : 'null;'
  return s
}`)
})
