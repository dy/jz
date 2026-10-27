// A sum with a side the summary holds to a number or a missing value is
// numeric: no string can reach it, so the missing value converts (null is 0,
// undefined NaN) and the run tests nothing else (emit/arithmetic.js).
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, wat } from './util.js'
import parseWat from 'watr/parse'

// Every value that reaches a sum is a number or missing: the arguments are
// arithmetic, the field is declared undefined and stored a number.
const src = `class Box {
  constructor(v) { this.keep(); if (v !== undefined) this.v = v }
  keep() { this.seen = 1 }
  plus(n) { return this.v + n }
  twice() { return this.v + this.v }
}
const slot = (k) => { const o = { p: undefined, q: 2 }; if (k > 3) o.p = k; return o }
export let field = (n) => new Box(n * 2).plus(1)
export let missing = (n) => new Box().plus(n * 1)
export let both = (n) => new Box().twice()
export let twice = (n) => new Box(n * 2).twice()
export let literal = (n) => { const o = slot(n * 1); return o.p + o.q }
export let nul = (n) => { const o = { p: null, q: 2 }; if (n > 3) o.p = n * 1; return o.p + o.q }
export let element = (n) => { const a = [1, 2, 3]; return a[n | 0] + 1 }`

test('number or missing: the sum agrees with the host', () => {
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const mod = jz(src, { optimize }).exports
    for (const name of Object.keys(host)) for (const n of [2, 5]) {
      const want = host[name](n), got = mod[name](n)
      ok(Object.is(want, got), `${name}(${n}) at ${optimize}: ${String(got)} for ${String(want)}`)
    }
  }
})

test('number or missing: no string test and no generic sum', () => {
  if (belowOpt(2)) return
  // The helpers hold both for the programs that need them; the program's own functions hold neither.
  const text = wat(src, { optimize: 2 })
  const starts = [...text.matchAll(/\(func\s+(\$[^\s)]+)/g)]
  for (let i = 0; i < starts.length; i++) {
    const name = starts[i][1]
    if (name.startsWith('$__')) continue
    const body = text.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : text.length)
    ok(!/call \$__is_str_key/.test(body), `no string test in ${name}`)
    ok(!/call \$__add_slow/.test(body), `no generic sum in ${name}`)
  }
})

// A number or a missing value that only a 32-bit word conversion reads (`| 0`,
// `>>>`, `~`, `<<`, Math.imul) converts as it lies in its cell: ToInt32 takes
// every NaN to 0, the hole, a miss's undefined and a stored null among them,
// as it takes undefined and null, so no test maps it to the canonical NaN first.
test('number or missing: a word conversion reads the cell as it lies', () => {
  const words = `const fill = (a, n) => { for (let k = 0; k < n; k++) a[k] = k * 3 - 7 }
export function f(n, m) {
  const a = []
  fill(a, n)
  if (m > n) a.length = m
  let h = 0
  for (let i = 0; i < m + 2; i++) h = (h * 31 + (a[i] | 0) + (a[i] >>> 1) + ~a[i] + (a[i] << 2) + Math.imul(a[i], 3)) | 0
  return h
}
export function g(n) {
  const a = [1.5, -2.5, 2 ** 40 + 3, NaN, -0]
  if (n > 2) a[1] = null
  if (n > 3) a[2] = undefined
  let h = 0
  for (let i = 0; i < n + 3; i++) h = (h * 7 + (a[i] | 0) + (a[i] >>> 0)) | 0
  return h
}`
  const host = oracle(words)
  for (const optimize of levels(0, 2, 'speed')) {
    const mod = jz(words, { optimize }).exports
    for (const [n, m] of [[0, 0], [3, 3], [5, 9], [9, 5], [4, 12]]) ok(Object.is(mod.f(n, m), host.f(n, m)), `f(${n}, ${m}) at ${optimize}`)
    for (const n of [0, 2, 3, 4, 6]) ok(Object.is(mod.g(n), host.g(n)), `g(${n}) at ${optimize}`)
  }
  if (belowOpt(2)) return
  const fn = parseWat(wat(words, { optimize: 'speed' })).find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$f$exp')
  let canon = 0
  const walk = n => {
    if (!Array.isArray(n)) return
    if (n[0] === 'select' && Array.isArray(n[3]) && (n[3][0] === 'f64.eq' && JSON.stringify(n[3][1]) === JSON.stringify(n[3][2]) ||
      n[3][0] === 'i64.eq' && /7FF8000200000000/i.test(JSON.stringify(n[3])))) canon++
    n.forEach(walk)
  }
  walk(fn)
  ok(fn && canon === 0, `f takes no element to the canonical NaN (${canon})`)
})
