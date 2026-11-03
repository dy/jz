// A value that is a Boolean or null keeps its null wherever paths join: a
// ternary with a null arm, `p && f(n)`, `||`, `??`, an if/else assignment, a
// loop-carried variable, a return, a closure's write, an element, a field, a
// Map value, and String, a template, JSON and typeof of it. A function result
// of that kind rides in its boxed carrier (the atoms and the nullish
// sentinels); a caller reading it as a bare Boolean boxed null as false
// (summary/contract.js contractVal). The neighbours ride along: undefined in
// place of null, and a Number, String, BigInt, Object or Array beside null.
// References: ECMA-262 13.13 (`&&`, `||`, `??` yield an operand unconverted),
// 13.14 (the conditional operator), 13.5.3 typeof, 7.1.17 ToString (null is
// "null", an object "[object Object]"), 25.5.2.2 SerializeJSONProperty. The
// expected values are Node's (util.js oracle).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { run, oracle, wat } from './util.js'

// `f(n)` for n = 0, 1, 2, 3: false, false, true, then the missing value.
const F = {
  boolNull: `const f = (n) => { if (n > 2) return null; if (n > 1) return true; return false }`,
  boolNullArrow: `const f = (n) => n > 2 ? null : n > 1 ? true : false`,
  boolUndefined: `const f = (n) => { if (n > 2) return undefined; if (n > 1) return true; return false }`,
  numberNull: `const f = (n) => { if (n > 2) return null; return n * 3 }`,
  stringNull: `const f = (n) => { if (n > 2) return null; return 's' + n }`,
  objectNull: `const f = (n) => { if (n > 2) return null; return { v: n } }`,
  objectUndefined: `const f = (n) => { if (n > 2) return undefined; return { v: n } }`,
  arrayNull: `const f = (n) => { if (n > 2) return null; return [n] }`,
  bigintNull: `const f = (n) => { if (n > 2) return null; return BigInt(n) }`,
}
// What an export shows of `v`: null, undefined and an object each print apart.
const S = v => `(${v} === null ? 'null' : ${v} === undefined ? 'undef' : typeof ${v} === 'object' ? 'obj' : String(${v}))`
// Each join of `f(n)`; `i` names an export's own helpers.
const JOIN = {
  tern: () => `(n) => { const e = n > 0 ? f(n) : null; return ${S('e')} }`,
  ternFalse: () => `(n) => { const e = n > 0 ? f(n) : false; return ${S('e')} }`,
  ternUndefined: () => `(n) => { const e = n > 0 ? f(n) : undefined; return ${S('e')} }`,
  ternNumber: () => `(n) => { const e = n > 0 ? f(n) : 5; return ${S('e')} }`,
  and: () => `(n) => { const p = n > 0 ? { k: n } : null; const e = p && f(n); return ${S('e')} }`,
  andLiteral: () => `(n) => { const e = f(n) && 7; return ${S('e')} }`,
  or: () => `(n) => { const e = f(n) || null; return ${S('e')} }`,
  orLiteral: () => `(n) => { const e = f(n) || 'd'; return ${S('e')} }`,
  nullish: () => `(n) => { const e = (n > 0 ? f(n) : null) ?? 'd'; return ${S('e')} }`,
  nullishDirect: () => `(n) => { const e = f(n) ?? 'd'; return ${S('e')} }`,
  ifElse: () => `(n) => { let e; if (n > 0) e = f(n); else e = null; return ${S('e')} }`,
  loop: () => `(n) => { let e = null; for (let i = 0; i < n; i++) e = f(i + 1); return ${S('e')} }`,
  closure: () => `(n) => { let e = null; const set = () => { e = f(n) }; if (n > 0) set(); return ${S('e')} }`,
  ret: i => [`const g${i} = (n) => n > 0 ? f(n) : null`, `(n) => { const e = g${i}(n); return ${S('e')} }`],
  retIf: i => [`const h${i} = (n) => { if (n > 0) return f(n); return null }`, `(n) => { const e = h${i}(n); return ${S('e')} }`],
  element: () => `(n) => { const a = [f(n)]; const e = a[0]; return ${S('e')} }`,
  field: () => `(n) => { const o = { v: f(n) }; const e = o.v; return ${S('e')} }`,
  mapValue: () => `(n) => { const m = new Map(); m.set(1, f(n)); const e = m.get(1); return ${S('e')} }`,
  str: () => `(n) => String(f(n))`,
  tpl: () => '(n) => `<${f(n)}>`',
  json: () => `(n) => JSON.stringify([f(n)])`,
  type: () => `(n) => typeof f(n)`,
}
// JSON.stringify throws on a BigInt (25.5.2.2 step 10).
const SKIP = { bigintNull: ['json'] }
// One module per kind of `f`: an export per join.
const program = (fn) => [F[fn], ...Object.entries(JOIN).map(([name, join], i) => {
  const out = join(i), [pre, body] = Array.isArray(out) ? out : [null, out]
  return `${pre ? pre + '\n' : ''}export let ${name} = ${body}`
})].join('\n')

for (const optimize of levels(0, 1, 2, 3, 'size'))
  for (const fn of Object.keys(F))
    test(`bool or null: ${fn} keeps its missing value through every join at ${optimize}`, () => {
      const src = program(fn), want = oracle(src), got = run(src, { optimize })
      for (const name of Object.keys(JOIN)) for (const n of [0, 1, 2, 3])
        if (!SKIP[fn]?.includes(name))
          is(got[name](n), want[name](n), `${fn} ${name}(${n}) at ${optimize}`)
    })

// The value from places other than a result: an element, a field, a Map
// value, a parameter, a literal merge.
const PLACES = `const a = [true, false, true]
const m = new Map([[1, true], [2, false]])
const show = (e) => ${S('e')}
const p1 = (b, n) => show(n > 0 ? b : null) + typeof b
const p2 = (b) => show(b && 1) + String(b)
export let elementTern = (n) => show(n > 0 ? a[n] : null)
export let elementRead = (n) => typeof a[n] + String(a[n]) + JSON.stringify([a[n]]) + show(a[n] && 7) + show(a[n] ?? 'd')
export let fieldTern = (n) => { const o = n > 2 ? { v: null } : { v: n > 1 }; return show(n > 0 ? o.v : 5) + typeof o.v + String(o.v) }
export let mapTern = (n) => show(n > 0 ? m.get(n) : null) + typeof m.get(n) + String(m.get(n))
export let param = (n) => p1(n > 2 ? null : n > 1, n) + p1(true, 1)
export let paramUndefined = (n) => p2(n > 2 ? undefined : n > 1)
export let literalTern = (n) => { const e = n > 2 ? null : n > 1; return show(e) + typeof e }
export let literalAnd = (n) => { const p = n > 0 ? {} : null; const e = p && n > 1; return show(e) }`
for (const optimize of levels(0, 1, 2, 3, 'size'))
  test(`bool or null: an element, field, Map value, parameter and literal keep their null at ${optimize}`, () => {
    const want = oracle(PLACES), got = run(PLACES, { optimize })
    for (const name of Object.keys(want)) for (const n of [0, 1, 2, 3])
      is(got[name](n), want[name](n), `${name}(${n}) at ${optimize}`)
  })

// An object the summary holds present prints through ToPrimitive alone, with
// no test for null or undefined (ir/coerce.js objectNullable); one that may be
// null keeps the test.
test('bool or null: an object literal prints without a nullish test', () => {
  ok(!/\Wots\d/.test(wat('export let s = (n) => String({ v: n })', { optimize: false })), 'a literal: no test')
  ok(/\Wots\d/.test(wat('const o = (n) => { if (n > 2) return null; return { v: n } }\nexport let s = (n) => String(o(n))', { optimize: false })), 'an object or null: the test')
})
