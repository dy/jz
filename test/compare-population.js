// A population of relational comparisons of operands of no known kind, against Node at
// optimize false, true, size and speed. The four operators and their negations, in a
// condition, a ternary and a loop test, over every pair of a pool: numbers (NaN, -0, the
// infinities), numeric and other strings (the empty string, a prefix of another, a code unit
// past an astral pair's, and beside a BigInt the strings StringToBigInt refuses though
// StringToNumber reads them: '1e1', 'Infinity', '1.0'), objects that count their calls through valueOf, toString or both (a
// valueOf that gives an object falls to toString), null, undefined, the booleans and BigInts;
// read from an array of unknown kind and from object fields. The spec's IsLessThan (ECMA-262
// §7.2.13): ToPrimitive with hint number on each side, left first; two strings compare by code
// units; otherwise each goes to a number or a BigInt, and NaN makes every comparison false.
// A sort comparator over the pools a relation orders totally (the strings; the numbers but NaN;
// BigInts beside numbers). Exported parameters keep the boundary's contract (README, numeric
// export parameters): a parameter only compared arrives as the host's ToNumber of its value,
// once, so their rows expect Node's answer for that number. Objects with Symbol.toPrimitive are
// left out: jz runs no toPrimitive method for any operator yet, a separate item.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { run, oracle } from './util.js'

const POOL = `[0, -0, 1, -1, 2.5, 10, 9, NaN, Infinity, -Infinity,
  '', 'a', 'ab', 'b', '10', '9', '1e1', ' 2 ', '0x10', 'Infinity', '1.0', '\\u{1F600}', '\\uFFFF', 'abc',
  { valueOf() { calls.n += 1; return 3 } }, { toString() { calls.n += 10; return '4' } },
  { valueOf() { calls.n += 100; return {} }, toString() { calls.n += 1000; return 'ab' } }, { valueOf() { calls.n += 10000; return '9' } },
  null, undefined, true, false, 10n, -1n, 2n]`
const OPS = ['<', '<=', '>', '>=']
const FORMS = OPS.flatMap(op => [[`a ${op} b`, op], [`!(a ${op} b)`, `!${op}`]])
// one program a form and a context: every pair of the pool through one array of unknown kind,
// and through the fields of records of one shape
const program = (expr, ctx, from) => {
  const test = (a, b) => expr.replace(/\ba\b/g, a).replace(/\bb\b/g, b)
  const body = ctx === 'cond' ? (a, b) => `if (${test(a, b)}) r = 1; else r = 0`
    : ctx === 'tern' ? (a, b) => `r = ${test(a, b)} ? 1 : 0`
    : (a, b) => `r = 0; while (${test(a, b)} && r < 2) r++`
  const [a, b] = from === 'array' ? ['V[i]', 'V[j]'] : ['R[i].x', 'R[j].x']
  return `const calls = { n: 0 }
const V = ${POOL}
const R = V.map(x => ({ x, y: 0 }))
export let f = () => { const out = []
  for (let i = 0; i < V.length; i++) for (let j = 0; j < V.length; j++) {
    calls.n = 0
    let r
    try { ${body(a, b)} } catch (e) { r = 'T' }
    out.push(r + ':' + calls.n)
  }
  return out.join(',') }`
}
const LEVELS = [['false', false], ['true', true], ['size', 'size'], ['speed', 'speed']]

test('compare population: operands of no known kind compare as Node', () => {
  for (const [expr, label] of FORMS) for (const ctx of ['cond', 'tern', 'loop']) for (const from of ['array', 'field']) {
    const src = program(expr, ctx, from), want = oracle(src).f().split(',')
    for (const [name, optimize] of LEVELS) {
      const got = run(src, { optimize }).f().split(',')
      const k = want.findIndex((w, i) => w !== got[i])
      ok(k < 0, `${label} ${ctx} ${from} at ${name}` + (k < 0 ? '' : `: pair ${k} node ${want[k]} jz ${got[k]}`))
    }
  }
})

// a sort comparator over a pool the relation orders totally, read through an array of unknown kind
const SORTS = {
  strings: `['b', '', 'ab', 'a', '10', '9', '\\uFFFF', '\\u{1F600}', 'abc', ' 2 ']`,
  numbers: `[2.5, -0, 10, -Infinity, 9, 0, -1, Infinity, 1]`,
  bigints: `[10n, 2.5, -1n, 3, 2n, -2, 0n, 1]`,
}
test('compare population: a sort comparator over unknown kinds as Node', () => {
  for (const [pool, values] of Object.entries(SORTS)) for (const op of OPS) {
    const cmp = op === '<' || op === '<=' ? `(p, q) => p ${op} q ? -1 : q ${op} p ? 1 : 0` : `(p, q) => p ${op} q ? 1 : q ${op} p ? -1 : 0`
    const src = `const V = ${values}
const W = [...V, 'x', null]
export let f = () => W.slice(0, V.length).sort(${cmp}).map(String).join('|')`
    const want = oracle(src).f()
    for (const [name, optimize] of LEVELS) ok(run(src, { optimize }).f() === want, `sort ${pool} ${op} at ${name}`)
  }
})

// a BigInt the compiler knows beside a string, a boolean or a number it knows: no shared
// representation, so a string goes through StringToBigInt and a number compares exactly
const KNOWN = `export let strs = () => { const b = 10n, s = '1e1', t = '20', u = 'x', e = ''; return [b < s, b < t, b > t, b < u, s < b, t > b, b > e, e <= b] }
export let bools = () => { const b = 1n, t = true, f = false; return [b < t, b <= t, b > f, t < b, f >= b] }
export let nums = () => { const b = 10n, x = 2.5 + Math.floor(Math.random() * 0), y = 10 + Math.floor(Math.random() * 0), z = 0 / 0 + Math.floor(Math.random() * 0)
  return [b < x, b > x, x < b, b <= y, b < y, y >= b, b < z, z >= b, -b < -x, b > 1e300 * Math.floor(1 + Math.random() * 0)] }`
test('compare population: a BigInt beside a string, a boolean or a number the compiler knows as Node', () => {
  const host = oracle(KNOWN)
  for (const [name, optimize] of LEVELS) {
    const m = run(KNOWN, { optimize })
    for (const fn of ['strs', 'bools', 'nums']) ok(JSON.stringify(m[fn]()) === JSON.stringify(host[fn]()), `${fn} at ${name}`)
  }
})

// exported parameters, compared alone: the host's ToNumber of each, once, at the boundary
const EXPORTS = `export let lt = (a, b) => a < b ? 1 : 0
export let le = (a, b) => !(a <= b) ? 0 : 1
export let gt = (a, b) => { let r = 0; while (a > b && r < 2) r++; return r }
export let ge = (a, b) => { if (a >= b) return 1; return 0 }`
const HOST = [0, -0, 1, 2.5, 10, 9, NaN, Infinity, -Infinity, '', 'a', '10', '9', '1e1', ' 2 ', null, undefined, true, false]
test('compare population: exported parameters keep the boundary contract', () => {
  const host = oracle(EXPORTS)
  for (const [name, optimize] of LEVELS) {
    const m = run(EXPORTS, { optimize })
    let bad = null
    for (const fn of ['lt', 'le', 'gt', 'ge']) for (const a of HOST) for (const b of HOST) {
      let calls = 0
      const box = (v) => ({ valueOf() { calls++; return v } })
      // an object converts once at the boundary: its valueOf runs once, whatever the body compares
      const want = host[fn](Number(a), Number(b)), got = m[fn](a, b)
      if (want !== got) { bad = `${fn}(${JSON.stringify(a)}, ${JSON.stringify(b)}) node ${want} jz ${got}`; break }
      calls = 0
      const gotBox = m[fn](box(a), b)
      if (gotBox !== host[fn](Number(a), Number(b)) || calls !== 1) { bad = `${fn}(object of ${JSON.stringify(a)}, ${JSON.stringify(b)}) jz ${gotBox} with ${calls} valueOf calls`; break }
    }
    ok(bad === null, `exports at ${name}` + (bad ? `: ${bad}` : ''))
  }
})
