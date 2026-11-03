// A slot that can hold a BigInt beside null, undefined or a Number keeps a
// tagged carrier (ADR-0001: the tagged carrier is the crossing for any
// BigInt∪other storage edge; raw i64 only where every value is a BigInt).
// A literal's field or element the compiler keeps in a local of its own
// (analyze-scans.js flatObjectCandidate) is such a slot: written from a
// literal, from both arms of an `if`, in a loop the integral copy versions,
// or read into a local, it answers typeof, String, ===, == and relational
// comparison as JavaScript does. A slot holding BigInts alone stays raw.
// References: ECMA-262 13.5.3 typeof, 7.1.17 ToString, 7.2.13 IsLessThan
// (null is 0, undefined NaN beside a BigInt). The expected values are Node's
// (util.js oracle).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { run, oracle, wat, funcWat } from './util.js'

const loopsOf = (text) => {
  const out = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    out.push(text.slice(at, end))
  }
  return out
}

// What an export shows of `v`.
const R = v => `typeof ${v} + ':' + String(${v}) + ':' + (${v} === null) + ':' + (${v} == null)`
// How the BigInt or nullish value is made, for n = 0..3 (3 the nullish one).
const V = {
  tern: '(n > 2 ? null : BigInt(n))',
  ternUndefined: '(n > 2 ? undefined : BigInt(n))',
  call: 'g(n)',
  literal: '(n > 2 ? null : 5n)',
}
const HOLD = {
  field: v => `{ const o = { v: ${v} }; return ${R('o.v')} }`,
  fieldLocal: v => `{ const o = { v: ${v} }; const e = o.v; return ${R('e')} }`,
  fieldStore: v => `{ const o = { v: 0n }; o.v = ${v}; return ${R('o.v')} }`,
  fieldArms: () => `{ const o = { v: 0n }; if (n > 2) o.v = null; else o.v = 5n; return ${R('o.v')} }`,
  fieldArmsLocal: () => `{ const o = { v: 0n }; if (n > 2) o.v = null; else o.v = 5n; const e = o.v; return ${R('e')} }`,
  fieldAdded: v => `{ const o = {}; o.v = ${v}; return ${R('o.v')} }`,
  fieldUndefined: () => `{ const o = { v: undefined }; if (n < 3) o.v = BigInt(n); return ${R('o.v')} }`,
  fieldNumber: () => `{ const o = { v: 0 }; if (n > 1) o.v = BigInt(n); return ${R('o.v')} }`,
  fieldString: () => `{ const o = { v: 's' }; if (n > 1) o.v = BigInt(n); return ${R('o.v')} }`,
  fieldWide: () => `{ const o = { v: 0n }; if (n > 2) o.v = null; else o.v = 0x7FFA000000000010n; return ${R('o.v')} }`,
  element: v => `{ const a = [${v}]; const e = a[0]; return ${R('e')} }`,
  elementArms: () => `{ const a = [0n, 1n]; if (n > 2) a[1] = null; else a[1] = BigInt(n); return ${R('a[1]')} }`,
  destructured: v => `{ const { v } = { v: ${v} }; return ${R('v')} }`,
  loop: () => `{ const o = { v: null }; for (let i = 0; i < n; i++) o.v = i > 1 ? null : BigInt(i); return ${R('o.v')} }`,
  loopElement: () => `{ const a = [null]; for (let i = 0; i < n; i++) a[0] = i > 1 ? null : BigInt(i); return ${R('a[0]')} }`,
  compare: v => `{ const o = { v: ${v} }; return String(o.v === 2n) + String(o.v > 0n) + String(o.v < 1n) + String(o.v >= 0n) }`,
  arithmetic: v => `{ const o = { v: ${v} }; return o.v == null ? 'none' : String(o.v * 2n + 1n) }`,
  mapValue: () => `{ const m = new Map([[1, 0n]]); if (n > 2) m.set(1, null); else m.set(1, 5n); return ${R('m.get(1)')} }`,
  closureCell: v => `{ let c = 0n; const set = () => { c = ${v} }; set(); return ${R('c')} }`,
}
const G = `const g = (n) => { if (n > 2) return null; return BigInt(n) }`
// One module per way of making the value: an export per holder.
const program = (vn) => [G, ...Object.entries(HOLD).map(([name, h]) => `export let ${name} = (n) => ${h(V[vn])}`)].join('\n')

for (const optimize of levels(0, 1, 2, 3, 'size'))
  for (const vn of Object.keys(V))
    test(`bigint slots: ${vn} held beside null reads as JavaScript at ${optimize}`, () => {
      const src = program(vn), want = oracle(src), got = run(src, { optimize })
      for (const name of Object.keys(HOLD)) for (const n of [0, 1, 2, 3])
        is(got[name](n), want[name](n), `${vn} ${name}(${n}) at ${optimize}`)
    })

// A relational comparison of a BigInt with null or undefined: ToNumeric of
// the nullish side, then the mixed comparison (7.2.13 step 3-4).
const COMPARE = `export let local = (n) => { const v = n > 2 ? null : BigInt(n); return String(v > 0n) + String(v < 1n) + String(v >= 0n) }
export let undef = (n) => { const v = n > 2 ? undefined : BigInt(n); return String(v > 0n) + String(v < 1n) + String(v >= 0n) }
export let param = (n) => { const h = (v) => String(v > 0n) + String(v <= 1n); return h(n > 2 ? null : BigInt(n)) }
export let literal = (n) => String(null > 0n) + String(null < 1n) + String(undefined > 0n) + String(n > 9 ? 1n : null >= 0n)`
for (const optimize of levels(0, 1, 2, 3, 'size'))
  test(`bigint slots: a BigInt compared with null or undefined at ${optimize}`, () => {
    const want = oracle(COMPARE), got = run(COMPARE, { optimize })
    for (const name of Object.keys(want)) for (const n of [0, 1, 2, 3])
      is(got[name](n), want[name](n), `${name}(${n}) at ${optimize}`)
  })

// A literal's fields and elements that hold BigInts alone keep the raw
// payload: no box is made for them, read or written (the values stay
// within jz's 64-bit BigInt, README FAQ).
test('bigint slots: a slot of BigInts alone stays raw', () => {
  const src = `export let fields = (n) => { const o = { v: BigInt(n), k: 0n }; for (let i = 0; i < n; i++) { o.v = o.v * 3n + 1n; o.k = o.k + o.v } return o.k }
export let elements = (n) => { const a = [1n, 2n]; for (let i = 0; i < n; i++) a[0] = a[0] + a[1]; return a[0] }`
  for (const optimize of levels(0, 2, 3)) {
    const want = oracle(src), got = run(src, { optimize })
    for (const n of [0, 5, 30]) for (const name of ['fields', 'elements']) is(got[name](n), want[name](n), `${name}(${n}) at ${optimize}`)
  }
  if (belowOpt(2)) return
  const w = wat(src, { optimize: 'speed' })
  for (const name of ['fields', 'elements'])
    ok(loopsOf(funcWat(w, name) || funcWat(w, name + '$exp')).every(l => !/call \$__(alloc|mkptr|ptr_type)\b/.test(l)), `${name}: no box in its loop`)
})

// A side a guard proves a BigInt (`typeof n === 'bigint' && n > …`, watr's
// i64 encoder) compares its payload as before: no shared helper, no box of
// the literal; a side that may be null takes the helper and its answer.
test('bigint slots: a side a guard proves a BigInt compares its payload', () => {
  const src = `const enc = (n) => { if (typeof n === 'string') n = BigInt(n); else if (typeof n === 'number') n = BigInt(n); return typeof n === 'bigint' && n > 0x7fffffffffffffffn ? 1 : 0 }
export let guarded = (k) => enc(k > 2 ? undefined : k > 1 ? '5' : k > 0 ? 7 : 3n)
const ge = (n) => n >= 1n
export let nullable = (k) => String(ge(k > 2 ? null : BigInt(k)))`
  for (const optimize of levels(0, 2, 3)) {
    const want = oracle(src), got = run(src, { optimize })
    for (const name of ['guarded', 'nullable']) for (const n of [0, 1, 2, 3]) is(got[name](n), want[name](n), `${name}(${n}) at ${optimize}`)
    const w = wat(src, { optimize })
    ok(!w.split('(func ').some(f => /^\$(enc|guarded)/.test(f) && /call \$__cmp\b/.test(f)), `guarded: no helper at ${optimize}`)
  }
})
