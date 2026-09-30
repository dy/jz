// A count dictionary the census proves i32-lean (analyze/val-types.js dictWalkI32:
// every read bitwise-coerced, every write a statement) keeps raw i32 bits in its
// slots and reads them with a bare wrap. Every store path must encode the value
// the same way (emit-assign.js dynSetValueI64). The shapes here reached the
// runtime key-kind dispatch, whose string arm stored the boxed number: a read of
// `7.0` answered its low word, 0. Values are differentials against the host.
import test from 'tst'
import { is } from 'tst/assert.js'
import { run, oracle } from './util.js'

const MIX = `h = (((h ^ counts[w]) * 16777619) | 0)`
const KERNEL = (key, line = MIX) => `export let kernel = (words, toks) => {
  let h = 0x811c9dc5 | 0
  const counts = {}
  for (let i = 0; i < toks.length; i++) {
    const w = ${key}
    counts[w] = (counts[w] | 0) + 1
    ${line}
  }
  return h >>> 0
}
export let f = (n) => {
  const words = []
  for (let i = 0; i < 16; i++) words.push('w' + i)
  const toks = new Int32Array(n)
  for (let i = 0; i < n; i++) toks[i] = (i * 7) & 15
  return kernel(words, toks)
}`
const same = (src, name, ...args) => is(run(src).f(...args), oracle(src).f(...args), `${name}(${args.join(',')})`)

test('lean dict: an exported kernel called internally with its key from the caller\'s array', () => {
  // f's call gives the kernel a specialized variant; the variant's store and read
  // must agree on the slot encoding as the generic kernel's do
  for (const key of ['words[toks[i]]', 'words[i & 15]', "'w' + toks[i]", "'w' + (i & 15)"])
    for (const n of [0, 1, 2, 17, 64]) same(KERNEL(key), key, n)
})

test('lean dict: a plain store then a bitwise read, host and internal calls', () => {
  const src = KERNEL('words[i & 15]', 'counts[w] = 7; h = h ^ counts[w]')
  for (const n of [1, 2, 3]) same(src, 'store 7', n)
  const words = Array.from({ length: 16 }, (_, i) => 'w' + i)
  const { kernel } = run(src)
  is(kernel(words, new Int32Array(3)), oracle(src).kernel(words, new Int32Array(3)), 'the host-called kernel')
})

test('lean dict: the count read back through the dictionary', () => {
  const src = `export let kernel = (words, toks) => {
  const counts = {}
  for (let i = 0; i < toks.length; i++) { const w = words[i & 15]; counts[w] = (counts[w] | 0) + 1 }
  let s = 0
  for (let i = 0; i < 16; i++) s = (s * 31 + (counts[words[i]] | 0)) | 0
  return s
}
export let f = (n) => {
  const words = []
  for (let i = 0; i < 16; i++) words.push('w' + i)
  return kernel(words, new Int32Array(n))
}`
  for (const n of [0, 1, 16, 50]) same(src, 'counts', n)
})

test('lean dict: a numeric key beside a string key', () => {
  const src = `export let kernel = (words, n) => {
  const d = {}
  let h = 0
  for (let i = 0; i < n; i++) { const k = i & 1 ? words[i & 3] : i & 3; d[k] = (d[k] | 0) + 1; h = (h * 31 + (d[k] | 0)) | 0 }
  return h
}
export let f = (n) => kernel(['a', 'b', 'c', 'd'], n)`
  for (const n of [0, 1, 8, 40]) same(src, 'mixed keys', n)
})
