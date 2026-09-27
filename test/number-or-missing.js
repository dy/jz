// A sum with a side the summary holds to a number or a missing value is
// numeric: no string can reach it, so the missing value converts (null is 0,
// undefined NaN) and the run tests nothing else (emit/arithmetic.js).
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, wat } from './util.js'

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
