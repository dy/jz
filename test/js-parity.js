/**
 * Differential parity with the host on semantics the dialect contract keeps
 * (README "What differs from JS?" lists every deliberate exception). Every
 * expectation here is what Node computes for the same source, never a
 * hand-picked value: `parity` batches single-arrow programs into one compile
 * and `agree` compiles whole programs, both against test/util.js's oracle.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { agree, cases, oracle } from './util.js'
import { levels } from './_matrix.js'

// One compile for a table of arrow programs; the wanted value is the host's.
const parity = (rows, opts) => cases(rows.map(([label, src, ...args]) => [label, src, new Function(`return (${src})`)()(...args), ...args]), opts)

test('parity: tagged indexed reads preserve numeric and BigInt view boundaries', () => {
  const src = `function read(a,i){return a[i]}
    export function f(k,i){
      const a = k===0 ? [3,4] : k===1 ? new Float64Array([NaN,-0])
        : k===2 ? new BigInt64Array([0n,-1n]) : new BigInt64Array(0)
      return read(a,i)
    }
    export function view(i){const a=new BigInt64Array([7n,9n]);return read(a.subarray(1),i)}`
  const want = oracle(src)
  for (const optimize of levels(0, 1, 2, 3)) {
    const got = jz(src, { optimize }).exports
    for (const k of [0, 1, 2, 2, 3, 0]) for (const i of [-1, 0, 1, 2])
      ok(Object.is(got.f(k,i), want.f(k,i)), `O${optimize}, kind ${k}, index ${i}`)
    for (const i of [-1, 0, 1]) is(got.view(i), want.view(i), `O${optimize}, offset view ${i}`)
  }
})

test('parity: numeric computed stores invalidate negative, fractional and special-number fields', () => {
  const keys = [0, -0, -1, 1.5, NaN, Infinity, -Infinity, 1e21, 1e-6, 1e-7]
  const src = `export function f(n) {
    const a = {'0':true, '-1':true, '1.5':true, NaN:true, Infinity:true, '-Infinity':true,
      '1e+21':true, '0.000001':true, '1e-7':true, '-0':true, '01':true, '1.0':true}
    a[+n] = 5
    return [a['0']||2, a['-1']||2, a['1.5']||2, a.NaN||2, a.Infinity||2,
      a['-Infinity']||2, a['1e+21']||2, a['0.000001']||2, a['1e-7']||2,
      a['-0']||2, a['01']||2, a['1.0']||2].join(',')
  }`
  const want = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, {optimize}).exports.f
    for (const key of [...keys, -1, -1, 0]) is(got(key), want(key), `O${optimize}, ${key}`)
  }
})

test('parity: array numeric and string keys share stores in both directions', () => {
  const src = `export function f(n, stringKey, empty) {
    const a = empty ? [] : [true]
    a['-1']=true; a['1.5']=true; a.NaN=true; a.Infinity=true; a['01']=true; a.label=true
    if (stringKey) a[''+n]=5
    else a[+n]=5
    return [a[+n]||2,a['0']||2,a['-1']||2,a['1.5']||2,a.NaN||2,a.Infinity||2,a['01']||2,a.label||2].join(',')
  }`
  const want = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, {optimize}).exports.f
    for (const key of [0,-0,1,3,3,0]) for (const mode of [0,1]) for (const empty of [0,1])
      is(got(key,mode,empty), want(key,mode,empty), `O${optimize}, ${key}, string=${mode}, empty=${empty}`)
  }
})

test('parity: computed object literals keep static names literal through lowering', () => {
  const src = `export function f(k) {
    const value = 11
    const a = {Infinity:1, undefined:2, Number:3, Boolean:4, value, [k]:9}
    return Object.keys(a).join(',') + '|' + Object.values(a).join(',')
  }`
  const want = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, {optimize}).exports.f
    for (const key of ['', '0', 'Infinity', 'undefined', 'Number', 'Boolean', 'value', 'value', ''])
      is(got(key), want(key), `O${optimize}, ${JSON.stringify(key)}`)
  }
})

test('parity: ToPrimitive on + with heap operands', () => {
  parity([
    ['[] + []', '() => typeof ([] + []) + ([] + [])'],
    ['[1] + [2]', '() => [1] + [2]'],
    ['[] + 1', '() => [] + 1'],
    ['1 + [2, 3]', '() => 1 + [2, 3]'],
    ['{} + []', '() => ({}) + []'],
    ['{a:1} + ""', '() => ({ a: 1 }) + ""'],
    ['typed + ""', '() => new Uint8Array([1, 2]) + ""'],
    ['map + ""', '() => new Map() + "" + new Set()'],
    ['valueOf literal + 1', '() => ({ valueOf() { return 7 } }) + 1'],
    ['toString literal + ""', '() => "" + { toString() { return "x" } }'],
    ['valueOf wins over toString', '() => ({ valueOf() { return 2 }, toString() { return "s" } }) + 1'],
    ['string + true', '() => "a" + true'],
    ['null + 1', '() => null + 1'],
  ])
  const fn = 'const g = (a, b) => a + b; export let f = (k) => k === 0 ? g([1], [2]) : k === 1 ? g([1], 1) : k === 2 ? g({ a: 1 }, "") : k === 3 ? g("a", true) : k === 4 ? g(true, 2) : g(null, 1)'
  for (const k of [0, 1, 2, 3, 4, 5]) agree(fn, 'f', [k])
  agree('class V { constructor(x) { this.x = x } valueOf() { return this.x * 2 } } export let f = () => new V(3) + 1', 'f')
  agree('class V { constructor(x) { this.x = x } valueOf() { return this.x * 2 } } const g = (o) => o + 1; export let f = () => g(new V(3)) + g(2)', 'f')
})

test('parity: String(), templates and .toString() on every kind', () => {
  agree('class V { constructor(x) { this.x = x } toString() { return "V" + this.x } } export let f = () => String(new V(3)) + "|" + ("" + new V(4)) + "|" + `${new V(5)}` + "|" + new V(6).toString()', 'f')
  agree('class V { constructor(x) { this.x = x } toString() { return "V" + this.x } } const g = (o) => String(o); export let f = () => g(new V(3)) + "|" + g({ toString() { return "x" } }) + "|" + g([1, 2]) + "|" + g({ a: 1 }) + "|" + g(5) + "|" + g(new Map()) + "|" + g(new Set())', 'f')
  agree('const g = (o) => o.toString(); export let f = () => [g({ a: 1 }), g([1, 2]), g({ toString() { return "x" } }), g(5), g("s")].join("|")', 'f')
  // jz dates are UTC (README): the Date string is the UTC rendering of the host's own parts
  const d = new Date(86400000 * 45 + 3723000)
  const utc = `${d.toUTCString().slice(0, 3)} ${d.toUTCString().slice(8, 11)} ${String(d.getUTCDate()).padStart(2, '0')} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} GMT+0000 (Coordinated Universal Time)`
  const { f: dateStr } = jz(`export let f = (t) => String(new Date(t)) + "|" + new Date(t).toString() + "|" + (new Date(t) + "")`).exports
  is(dateStr(d.getTime()), `${utc}|${utc}|${utc}`)
  agree('export let f = () => new Date(1000).valueOf() + (new Date(2000) - 0)', 'f')
  agree('export let f = () => String(/a+b/gi) + "|" + (/x/ + "")', 'f')
  agree('export let f = () => typeof String(() => 1)', 'f')
  // a user toString that returns an object falls through to valueOf, then TypeError
  agree('export let f = () => String({ toString() { return {} }, valueOf() { return 9 } })', 'f')
  agree('export let f = () => { try { return String({ toString() { return {} } }) } catch (e) { return e instanceof TypeError } }', 'f')
})

test('parity: a boolean field beside a number in a logical operator', () => {
  // The value type of `bool || number` is NUMBER (the boolean's ToNumber
  // image); a boolean read from an object field is a boxed atom and must
  // convert, or the numeric truthiness test reads the atom as NaN.
  const flag = 'const S = { w: k > 0, n: 1 }; const set = () => { S.w = k > 1 }; set(); const g = new Set(); let z = null; if (k > 5) z = 3;'
  parity([
    ['field || size', `(k) => { ${flag} return (S.w || g.size) ? 1 : 0 }`, 1],
    ['field || size falsy', `(k) => { ${flag} return (S.w || g.size) ? 1 : 0 }`, 0],
    ['size || field', `(k) => { ${flag} return (g.size || S.w) ? 1 : 0 }`, 2],
    ['literal 0 || field', `(k) => { ${flag} const c = 0; return (c || S.w) ? 1 : 0 }`, 2],
    ['literal 5 && field', `(k) => { ${flag} const c = 5; return (c && S.w) ? 1 : 0 }`, 2],
    ['literal 5 && field falsy', `(k) => { ${flag} const c = 5; return (c && S.w) ? 1 : 0 }`, 1],
    ['field && size', `(k) => { ${flag} return (S.w && g.size) ? 1 : 0 }`, 2],
    ['field ?? number', `(k) => { ${flag} const c = 0; return (S.w ?? c) ? 1 : 0 }`, 2],
    ['nullable number ?? field', `(k) => { ${flag} return (z ?? S.w) ? 1 : 0 }`, 2],
    ['cond ? field : number', `(k) => { ${flag} const c = 0; return (k > 0 ? S.w : c) ? 1 : 0 }`, 2],
    ['cond ? number : field', `(k) => { ${flag} const c = 0; return (k < 0 ? c : S.w) ? 1 : 0 }`, 2],
    ['arithmetic on the join', `(k) => { ${flag} const c = 2; return (S.w || c) + (c && S.w) * 3 }`, 2],
    ['chain from a sink pass', `(k) => { ${flag} const vMem = k > 0, vPure = true, vFx = null, vTrap = false; const bad = (!vPure && !vFx) || ((vMem || vTrap) && S.w) || S.n === 2 || (S.w && (vMem || vTrap || g.size)) || (vTrap && S.w); return bad ? 1 : 0 }`, 2],
  ])
})

test('parity: loose equality converts objects and strings', () => {
  parity([
    ['[] == false', '() => [] == false'],
    ['[1] == 1', '() => [1] == 1'],
    ['["a"] == "a"', '() => ["a"] == "a"'],
    ['[1,2] == "1,2"', '() => [1, 2] == "1,2"'],
    ['{} == "[object Object]"', '() => ({}) == "[object Object]"'],
    ['[] == null', '() => [] == null'],
    ['toString literal == "x"', '() => ({ toString() { return "x" } }) == "x"'],
    ['valueOf literal == 7', '() => ({ valueOf() { return 7 } }) == 7'],
    ['[1] === 1', '() => [1] === 1'],
  ])
  const src = 'const eq = (a, b) => a == b; export let f = (k) => k === 0 ? eq([1], 1) : k === 1 ? eq("1", 1) : k === 2 ? eq(1, "1") : k === 3 ? eq(true, "1") : k === 4 ? eq([1, 2], "1,2") : k === 5 ? eq(null, undefined) : eq([], 0)'
  for (const k of [0, 1, 2, 3, 4, 5, 6]) agree(src, 'f', [k])
})

test('parity: callbacks receive the array argument', () => {
  parity([
    ['map 3rd', '() => [1, 2, 3].map((x, i, a) => a.length * 10 + a[i]).join()'],
    ['forEach 3rd', '() => { let n = 0; [1, 2].forEach((x, i, a) => { n += a.length }); return n }'],
    ['filter 3rd', '() => [1, 2, 3].filter((x, i, a) => x > a[0]).join()'],
    ['some 3rd', '() => [1, 2, 3].some((x, i, a) => x === a.length)'],
    ['every 3rd', '() => [1, 2, 3].every((x, i, a) => x <= a.length)'],
    ['find 3rd', '() => [1, 2, 3].find((x, i, a) => x === a[a.length - 1])'],
    ['findIndex 3rd', '() => [1, 2, 3].findIndex((x, i, a) => x === a[1])'],
    ['findLast 3rd', '() => [1, 2, 3].findLast((x, i, a) => x < a[2])'],
    ['reduce 4th', '() => [1, 2, 3].reduce((acc, x, i, a) => acc + a.length, 0)'],
    ['reduceRight 4th', '() => [1, 2, 3].reduceRight((acc, x, i, a) => acc + a[i], 0)'],
    ['typed map 3rd', '() => new Int32Array([1, 2]).map((x, i, a) => a.length + x).join()'],
    ['typed forEach 3rd', '() => { let n = 0; new Float64Array([1, 2]).forEach((x, i, a) => { n += a[i] }); return n }'],
    ['typed filter 3rd', '() => new Uint8Array([1, 2, 3]).filter((x, i, a) => x > a[0]).join()'],
    ['typed some 3rd', '() => new Int16Array([1, 2]).some((x, i, a) => a.length === 2)'],
    ['typed find 3rd', '() => new Int32Array([5, 6]).find((x, i, a) => x === a[1])'],
    // a fused pipeline must hand the downstream callback the intermediate array
    ['map then filter 3rd', '() => [1, 2, 3].map(x => x * 2).filter((x, i, a) => x === a[1]).join()'],
    ['filter then map 3rd', '() => [1, 2, 3].filter(x => x > 1).map((x, i, a) => a.length).join()'],
    ['map then reduce 4th', '() => [1, 2, 3].map(x => x * 2).reduce((s, x, i, a) => s + a.length, 0)'],
    ['filter then reduce 4th', '() => [1, 2, 3].filter(x => x > 1).reduce((s, x, i, a) => s + a.length, 0)'],
    ['map then forEach 3rd', '() => { let n = 0; [1, 2, 3].map(x => x * 2).forEach((x, i, a) => { n += a[i] }); return n }'],
    ['filter then forEach 3rd', '() => { let n = 0; [1, 2, 3].filter(x => x > 1).forEach((x, i, a) => { n += a.length }); return n }'],
  ])
  agree('const cb = (x, i, a) => a.length; export let f = () => [1, 2, 3].map(cb).join() + [4, 5].filter(cb).length', 'f')
})

test('parity: join, includes and indexOf edge values', () => {
  parity([
    ['join nullish', '() => [1, undefined, null, 2].join("-")'],
    ['String([null])', '() => String([null]) + "|" + String([undefined, 1]) + "|" + [null, null].toString()'],
    ['nested join', '() => [1, [2, [null, 3]]].join()'],
    ['includes NaN', '() => [NaN].includes(NaN)'],
    ['includes NaN mixed', '() => ["a", NaN, 1].includes(NaN)'],
    ['indexOf NaN', '() => [NaN].indexOf(NaN)'],
    ['includes -0', '() => [0].includes(-0) && [-0].includes(0)'],
    ['includes string', '() => ["ab", "cd"].includes("c" + "d")'],
    ['includes missing', '() => [1, 2].includes(3)'],
    ['typed includes NaN', '() => new Float64Array([NaN]).includes(NaN)'],
  ])
})

test('parity: regex state, match results and replacement patterns', () => {
  parity([
    ['test /g advances', '() => { const r = /a/g; return [r.test("aa"), r.test("aa"), r.test("aa"), r.lastIndex].join() }'],
    ['exec /g twice', '() => { const r = /a/g; const s = "aXa"; const m1 = r.exec(s); const m2 = r.exec(s); return m1.index * 10 + m2.index + "|" + r.exec(s) }'],
    ['exec index input', '() => { const m = /b/.exec("abc"); return m.index + "|" + m.input }'],
    ['match index', '() => "xyz".match(/y/).index'],
    ['match /g all', '() => "a1b22c".match(/\\d+/g).join()'],
    ['match /g none', '() => "abc".match(/\\d/g)'],
    ['match none', '() => "abc".match(/\\d/)'],
    ['lastIndex write', '() => { const r = /a/g; r.lastIndex = 1; return r.exec("aXa").index }'],
    ['lastIndex write negative', '() => { const r = /a/g; r.lastIndex = -3; return r.lastIndex }'],
    ['sticky', '() => { const r = /a/y; const s = "ba"; const a = r.test(s); r.lastIndex = 1; return [a, r.test(s), r.lastIndex, r.test(s)].join() }'],
    ['while exec', '() => { const r = /\\d/g; let n = 0, m; while ((m = r.exec("1a2b3")) !== null) n = n * 10 + +m[0]; return n }'],
    ['$&', '() => "abc".replace("b", "[$&]")'],
    ['$$ $` $\'', '() => "abc".replace("b", "$$|$`|$\'")'],
    ['replaceAll $&', '() => "a.b.c".replaceAll(".", "<$&>")'],
    ['replaceAll empty search', '() => "abc".replaceAll("", "-")'],
    ['replaceAll plain empty', '() => "abc".replaceAll("", "")'],
    ['regex $1', '() => "abc".replace(/(b)/, "[$1]")'],
    ['regex $2 out of range', '() => "abc".replace(/(b)/, "[$2]")'],
    ['regex $nn', '() => "abcdefghijkl".replace(/(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)/, "$11|$10|$1|$01")'],
    ['regex $<name>', '() => "ab".replace(/(?<first>a)/, "[$<first>]")'],
    ['regex $<unknown>', '() => "ab".replace(/(?<first>a)/, "[$<nope>]")'],
    ['regex $< without groups', '() => "ab".replace(/(a)/, "[$<first>]")'],
    ['regex $< unterminated', '() => "ab".replace(/(?<first>a)/, "[$<first]")'],
    ['regex /g $&', '() => "a1b2".replace(/\\d/g, "<$&>")'],
    ['regex /g optional group', '() => "ab".replace(/(x)?(a)/g, "[$1|$2]")'],
    ['regex $ literal', '() => "a".replace(/a/, "$") + "ab".replace(/b/, "$x")'],
    ['string search $1 literal', '() => "abc".replace("b", "$1")'],
  ])
  agree('export let f = (r) => "ab".replace(/(?<first>a)(?<second>b)/, r)', 'f', ['[$<second>$<first>]'])
  agree('export let f = (r) => "aXb".replace("X", r)', 'f', ['$`$\''])
  agree('export let f = (r) => "a1b2".replace(/(\\d)/g, r)', 'f', ['<$1>'])
})

test('parity: exact decimal formatting', () => {
  parity([
    ['toFixed ties', '() => [0.5, 1.5, 2.5, -2.5, 1.45, 8.345, 1.005].map(x => x.toFixed(0) + "/" + x.toFixed(2)).join()'],
    ['toFixed large', '() => (1e21).toFixed(2) + "|" + (1e20).toFixed(1) + "|" + (123456789012345680000).toFixed(0)'],
    ['toFixed many digits', '() => (1.5).toFixed(30) + "|" + (0.1).toFixed(20) + "|" + (5e-324).toFixed(20)'],
    ['toFixed signs', '() => (-0.0001).toFixed(2) + "|" + (-0).toFixed(1) + "|" + (0).toFixed(3)'],
    ['toFixed non-finite', '() => (NaN).toFixed(2) + "|" + (Infinity).toFixed(1) + "|" + (-Infinity).toFixed(0)'],
    ['toFixed digits coerce', '() => (1.5).toFixed(1.9) + "|" + (1.5).toFixed() + "|" + (1.5).toFixed("1")'],
    ['toExponential', '() => [0, 1, 12345, 9.99, 0.00012, 123456, -1.5e-7, 9.5, 5e-324].map(x => x.toExponential(2)).join()'],
    ['toExponential 0 digits', '() => (9.99).toExponential(0) + "|" + (12345).toExponential(0)'],
    ['toExponential shortest', '() => [12345, 0.00012, 1, 0, -1.5e-7, 123.456, 1e21, 5e-324, 0.1, 1 / 3, 2 ** 53, 9154367474445.312].map(x => x.toExponential()).join()'],
    ['toPrecision', '() => [[12345.678, 4], [0.000001234, 2], [123456, 2], [0, 3], [1, 1], [9.99, 2], [1e21, 3], [0.5, 1], [-0.000012345, 3], [99.9, 2], [0.1, 21]].map(([x, p]) => x.toPrecision(p)).join()'],
    ['toPrecision none', '() => (12345.678).toPrecision() + "|" + (0.1).toPrecision() + "|" + (1e21).toPrecision()'],
    ['toString radix unchanged', '() => (255).toString(16) + "|" + (0.5).toString(2) + "|" + (-255).toString(36)'],
    ['String(number) unchanged', '() => String(1e21) + "|" + (1e-7).toString() + "|" + (0.000001).toString() + "|" + (0.1 + 0.2)'],
  ])
  agree('export let f = (d) => { try { return (1).toFixed(d) } catch (e) { return e instanceof RangeError ? "RangeError" : "other" } }', 'f', [101])
  agree('export let f = (d) => { try { return (1).toFixed(d) } catch (e) { return e instanceof RangeError ? "RangeError" : "other" } }', 'f', [-1])
  agree('export let f = (d) => { try { return (NaN).toFixed(d) } catch (e) { return e instanceof RangeError ? "RangeError" : "other" } }', 'f', [101])
  agree('export let f = (d) => { try { return (1).toExponential(d) } catch (e) { return e instanceof RangeError ? "RangeError" : "other" } }', 'f', [101])
  agree('export let f = (d) => { try { return (NaN).toExponential(d) } catch (e) { return e instanceof RangeError ? "RangeError" : "other" } }', 'f', [101])
  agree('export let f = (d) => { try { return (1).toPrecision(d) } catch (e) { return e instanceof RangeError ? "RangeError" : "other" } }', 'f', [0])
  agree('export let f = (d) => { try { return (Infinity).toPrecision(d) } catch (e) { return e instanceof RangeError ? "RangeError" : "other" } }', 'f', [0])
  // a sweep of shapes across the whole exponent range, exact against the host
  const { fx, ex, pr } = jz('export let fx = (x, f) => (+x).toFixed(f); export let ex = (x, f) => (+x).toExponential(f); export let pr = (x, p) => (+x).toPrecision(p)').exports
  let r = 7, bad = 0
  const rnd = () => (r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let i = 0; i < 400; i++) {
    const x = (rnd() - 0.5) * 10 ** Math.floor(rnd() * 44 - 22), f = Math.floor(rnd() * 21), p = 1 + Math.floor(rnd() * 21)
    if (fx(x, f) !== x.toFixed(f) || ex(x, f) !== x.toExponential(f) || pr(x, p) !== x.toPrecision(p)) bad++
  }
  is(bad, 0, 'random toFixed/toExponential/toPrecision agree with the host')
})

test('parity: Math.cbrt is exact on cubes and within an ulp elsewhere', () => {
  parity([
    ['cubes', '() => [8, 27, 1000, -8, 64, 1e300, 1e-300].map(Math.cbrt).join()'],
    ['specials', '() => [0, -0, NaN, Infinity, -Infinity, 5e-324, 1e-310].map(x => 1 / Math.cbrt(x)).join()'],
  ])
  const { cb } = jz('export let cb = (x) => Math.cbrt(+x)').exports
  let worst = 0
  for (let i = 1; i < 500; i++) { const x = i * 1.37 * 10 ** ((i % 40) - 20); const got = cb(x), want = Math.cbrt(x); worst = Math.max(worst, Math.abs(got - want) / Math.abs(want) / Number.EPSILON) }
  ok(worst <= 1, `cbrt within one ulp of the host (worst ${worst})`)
})

test('parity: property enumeration order', () => {
  const rows = [
    ['keys literal', '() => Object.keys({ b: 1, a: 2, 1: 3, 0: 4 }).join()'],
    ['values literal', '() => Object.values({ b: 1, a: 2, 1: 3, 0: 4 }).join()'],
    ['entries literal', '() => Object.entries({ b: 1, a: 2, 10: 3, 2: 4 }).flat().join()'],
    ['for-in literal', '() => { let s = ""; for (const k in { b: 1, a: 2, 1: 3, 0: 4 }) s += k; return s }'],
    ['JSON literal', '() => JSON.stringify({ b: 1, 1: 2, a: { 2: 1, 0: [{ 1: 0, 0: 1 }] } })'],
    ['reads follow the literal', '() => { const o = { 1: "one", 0: "zero", x: 5 }; return o[1] + o[0] + o.x + Object.keys(o).join() }'],
    ['dict keys', '() => { const o = {}; o["b"] = 1; o["10"] = 2; o["2"] = 3; o["a"] = 4; return Object.keys(o).join() + "|" + Object.values(o).join() + "|" + Object.entries(o).flat().join() }'],
    ['dict JSON', '() => { const o = {}; o["b"] = 1; o["10"] = 2; o["2"] = 3; return JSON.stringify(o) }'],
    ['dict for-in', '() => { const o = {}; o["b"] = 1; o["10"] = 2; o["2"] = 3; let s = ""; for (const k in o) s += k + ";"; return s }'],
    ['numeric keys added descending', '() => { const h = {}; for (let i = 5; i > 0; i--) h[i * 3] = i; return Object.keys(h).join() + "|" + Object.values(h).join() }'],
    ['literal plus dynamic index', '() => { const o = { b: 1 }; o[2] = 1; o.a = 1; return Object.keys(o).join() + "|" + Object.entries(o).flat().join() + "|" + JSON.stringify(o) }'],
    ['not an index', '() => { const o = {}; o["01"] = 1; o["1"] = 2; o["-1"] = 3; o["4294967295"] = 4; o["4294967294"] = 5; return Object.keys(o).join() }'],
    ['Map keeps insertion order', '() => [...new Map([["2", 1], ["1", 2], ["b", 3]]).keys()].join()'],
    ['Set keeps insertion order', '() => [...new Set(["2", "1", "10"])].join()'],
  ]
  for (const optimize of levels(false, 2)) parity(rows, { optimize })
  agree('class P { constructor() { this.y = 1; this[0] = 2; this.x = 3 } } export let f = () => Object.keys(new P()).join()', 'f')
})
