// TypedArray.prototype.fill: the first element goes through the element
// writer, the rest are its bytes (module/typedarray.js __typed_fill), so every
// element kind fills alike, and the value converts once before the fill.
import test from 'tst'
import { levels } from './_matrix.js'
import { agree } from './util.js'

const sum = 'const sum = (a) => { let h = 0; for (let i = 0; i < a.length; i++) h = h * 31 + a[i]; return h }\n'
const pool = `const pick = (k, n) => [new Float32Array(n), new Float64Array(n), new Float32Array(2 * n).subarray(n, 2 * n), new Float64Array(3 * n).subarray(n, 2 * n),
  new Int16Array(n), new Uint8Array(n), new Uint8ClampedArray(n), new Int32Array(n), new Uint32Array(n), new Int8Array(n), new Uint16Array(n)][k % 11]
`
const src = `${sum}${pool}
export let all = (k) => { const a = pick(k, 37); a.fill(3.75); return sum(a) }
export let range = (k) => { const a = pick(k, 37); a.fill(-2.5, 5, 30); return sum(a) }
export let fromEnd = (k) => { const a = pick(k, 37); a.fill(300.5, -9, -2); return sum(a) }
export let empty = (k) => { const a = pick(k, 37); a.fill(9, 30, 5); return sum(a) }
export let last = (k) => { const a = pick(k, 37); a.fill(7, 36); return sum(a) }
export let missing = (k) => { const a = pick(k, 9); a.fill(undefined); return sum(a) }
export let text = (k) => { const a = pick(k, 9); a.fill('12'); return sum(a) }
export let flag = (k) => { const a = pick(k, 9); a.fill(true, 2); return sum(a) }
export let returned = (k) => { const a = pick(k, 5); const b = a.fill(2); b[0] = 9; return sum(a) }
export let known = (k) => { const a = new Float64Array(k + 20); a.fill(1.25, 3); const b = new Uint8Array(k + 20); b.fill(257); const c = new Float32Array(33); c.fill(0.1); return sum(a) + sum(b) + sum(c) }`
const names = ['all', 'range', 'fromEnd', 'empty', 'last', 'missing', 'text', 'flag', 'returned', 'known']

for (const optimize of levels(0, 2, 3, 'size'))
  test(`typed fill: every element kind at ${optimize}`, () => {
    for (const name of names) for (let k = 0; k < 11; k++) agree(src, name, [k], { optimize }, `${name}(${k})`)
  })

test('typed fill: a BigInt array keeps its BigInt', () => {
  const big = `export let f = (k) => { const a = new BigInt64Array(9); a.fill(5n, 1, 8); let h = 0n; for (let i = 0; i < 9; i++) h = h * 3n + a[i]; return Number(h) + k }`
  for (const optimize of levels(0, 2, 3, 'size')) agree(big, 'f', [3], { optimize }, `at ${optimize}`)
})
