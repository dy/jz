// A binding of a spliced call read where it holds a literal is the literal
// (src/compile/plan/constants.js, pass `constants`): a spliced call binds each
// argument its body writes to a name of its own, and the body's tests of that
// parameter are tests of the literal the site passed. A test of literals is its
// answer, the arm it rules out is no code, and the binding holds its literal
// past the test. The bindings followed are the splices' own: each flow below
// runs as the body of a call (`spliced`), and as the function the source wrote. A
// binding assigned on every path to its reads holds no `undefined` to test for
// (summary/definite.js, read where the local is declared), and a labeled block
// ends with what held at each `break` to it. Every form answers what the host
// answers.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

// the flow as the body of a function its export calls: the splice makes its bindings the compiler's
const spliced = (src) => src.replace(/export let f = \(([^)]*)\) =>/, (_, ps) => `export let f = (${ps}) => { const r = body(${ps}); return r }\nconst body = (${ps}) =>`)
// [source, the calls]
const flows = {
  'a literal read past a test it decides': ['export let f = (x) => { let m = -1.5; if (m === 0) m = 0; if (m !== m) return -1; return x + m }', [[1], [0]]],
  'a literal an arm may replace': ['export let f = (x) => { let m = 2; if (x > 0) m = 3; return x * m }', [[1], [-1], [0]]],
  'both arms store the same literal': ['export let f = (x) => { let m; if (x > 0) m = 4; else m = 4; return x + m }', [[1], [-1]]],
  'the arms store two literals': ['export let f = (x) => { let m; if (x > 0) m = 4; else m = 5; return x + m }', [[1], [-1]]],
  'a literal a loop writes': ['export let f = (n) => { let m = 1; for (let i = 0; i < n; i++) { if (m > 4) break; m = m + 1 } return m }', [[0], [2], [9]]],
  'a literal read in a loop that writes it after': ['export let f = (n) => { let m = 1, s = 0; for (let i = 0; i < n; i++) { s += m; m = 7 } return s * 10 + m }', [[0], [1], [3]]],
  'a literal written in a loop test': ['export let f = (n) => { let m = 0, i = 0; while ((m = i * 2) < n) i++; return m + i }', [[0], [5]]],
  'a literal a labeled block leaves early with': ['export let f = (c) => { let m = 1; out: { if (c > 0) break out; m = 2 } return m }', [[1], [0]]],
  'a literal a labeled loop leaves early with': ['export let f = (c) => { let m = 1; out: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j === c) break out; m = 5 } m = 6 } return m }', [[0], [1], [7]]],
  'a literal a try may not reach': ['export let f = (c) => { let m = 1; try { if (c > 0) throw 1; m = 2 } catch (e) { m = m + 10 } return m }', [[1], [0]]],
  'a literal a finally reads': ['export let f = (c) => { let m = 1, r = 0; try { m = 2; if (c > 0) throw 1; m = 3 } catch (e) { r = m } finally { r += m * 10 } return r }', [[1], [0]]],
  'a literal a closure stores to': ['export let f = (x) => { let m = 1; const g = () => { m = x }; if (x > 0) g(); return m * 2 }', [[3], [-3]]],
  'a literal a closure reads': ['export let f = (x) => { let m = 1; const g = () => m + x; m = 2; return g() }', [[3]]],
  'a literal stored in an expression': ['export let f = (x) => { let m = 1; const r = (m = 5) + m + x; return r * 10 + m }', [[3]]],
  'a literal stored in an arm of a conditional': ['export let f = (x) => { let m = 1; const r = x > 0 ? (m = 5) : 0; return r * 10 + m }', [[3], [-3]]],
  'a literal stored behind a test': ['export let f = (x) => { let m = 1; x > 0 && (m = 5); x < -5 || (m = m + 1); return m }', [[3], [-3], [-9]]],
  'a literal stored behind a test, read as a value': ['export let f = (x) => { let m = 1, k = 2; const t = x > 0 && (m = 5); const u = x > 0 || (k = 7); const v = (x > 2 ? null : 3) ?? (k = 9); return m * 100 + k * 10 + (t ? 1 : 0) + (u === true ? 2 : 0) + v }', [[3], [1], [-3]]],
  'a compound store': ['export let f = (x) => { let m = 2; m += x; let k = 3; k++; return m * 10 + k }', [[3]]],
  'a literal that is a receiver': ['export let f = (x) => { let m = 5; const s = m.toFixed(1); let o = { a: 1 }; const k = "a"; return s.length + o[k] + x }', [[3]]],
  'a name of an object literal': ['export let f = (x) => { let a = 5; const o = { a, b: a + x }; return o.a + o.b }', [[3]]],
  'values of two types compared loosely': ['export let f = (x) => { let u = undefined, n = null, z = 0, t = true; return (u == n ? 1 : 0) + (z == n ? 10 : 0) + (z != t ? 100 : 0) + (u != z ? 1000 : 0) + x }', [[3]]],
  'a literal undefined or null left of a test as a value': ['export let f = (x) => { const u = undefined, n = null; const t = u || (x > 1); let k = 0; const r = n ?? (k += 1, x); return [u || x, n || x, u ?? x, n ?? x, u || "s", u || null, n ?? undefined, t === true ? 1 : t === false ? 2 : 3, r * 10 + k, u || (x > 1), n ?? (x > 1), t] }', [[3], [0]]],
  'a member a literal does not declare, with its default': ['export let f = (x) => { const o = { v: x }; return (o.t || 2) + (o.u ?? 3) * 10 + (o.v || 7) * 100 + (o.v ?? 9) * 1000 }', [[3], [0]]],
  'undefined and null': ['export let f = (x) => { let u = undefined, n = null; if (u === undefined && n === null && u !== n) return x + 1; return -1 }', [[3]]],
  'a truth value as a number': ['export let f = (x) => { let t = true; return t + x }', [[3]]],
  'a test as a value': ['export let f = (x) => { let a = 0, b = 2; const r = a || x; const q = b && x; return r * 10 + q }', [[3], [0]]],
  'an exact function of a literal': ['export let f = (x) => { let m = 3; if (Math.floor(m) === m && Math.abs(-m) === 3 && Math.sqrt(m + 1) === 2) return x + Math.max(m, 1); return -1 }', [[3]]],
  'a quotient that is no number': ['export let f = (x) => { let z = 0; const q = z / z; return q !== q ? x : -1 }', [[3]]],
  'a parameter stored a literal': ['export let f = (x, y) => { if (y === undefined) y = 2; x = 3; return x * y }', [[1], [1, 5]]],
}
// a callee that writes its parameters, called with literals
const calls = {
  'a wrapped value': ['function wrap(v, min, max) { var delta; if (v !== v || min !== min || max !== max || max <= min) return NaN; if (v === 0) v = 0; if (min === 0) min = 0; if (max === 0) max = 0; if (min <= v && v < max) return v; delta = max - min; if (v < min) v += delta * (Math.trunc((min - v) / delta) + 1); return min + (v - min) % delta }\n' +
    'export let f = (x) => wrap(x, -1.5, 2.5) + wrap(x, 0, 1) * 10 + wrap(x, 2, 2) * 0', [[0.5], [7.25], [-9], [NaN], [-0]]],
  'a least common multiple': ['function gcd(a, b) { var t; if (a !== a || b !== b) return NaN; if (Math.floor(a) !== a || Math.floor(b) !== b) return NaN; if (a < 0) a = -a; if (b < 0) b = -b; while (b) { t = b; b = a % b; a = t } return a }\n' +
    'function lcm(a, b) { var d; if (a === 0 || b === 0) return 0; if (a < 0) a = -a; if (b < 0) b = -b; d = gcd(a, b); if (d !== d) return d; return a / d * b }\n' +
    'export let f = (x) => lcm(x, 3) + lcm(6, x) * 100', [[4], [0], [-9], [2.5], [NaN]]],
}

test('constants: a binding read where it holds a literal answers what the host answers', () => {
  for (const [name, [src, args]] of Object.entries({ ...flows, ...calls })) {
    const want = args.map(a => oracle(src).f(...a))
    for (const [form, text] of [['spliced', spliced(src)], ['as written', src]]) for (const optimize of levels(0, 2, 3)) {
      const m = run(text, { optimize })
      args.forEach((a, i) => is(m.f(...a), want[i], `${name}, ${form} at ${optimize}: f(${a.join(', ')})`))
    }
  }
})

test('constants: with the pass off, the same', () => {
  for (const [name, [src, args]] of Object.entries({ ...flows, ...calls })) {
    const want = args.map(a => oracle(src).f(...a))
    for (const optimize of levels(2, 3)) {
      const m = run(spliced(src), { optimize: { level: optimize, constants: false } })
      args.forEach((a, i) => is(m.f(...a), want[i], `${name} at ${optimize}: f(${a.join(', ')})`))
    }
  }
})

test('constants: a test of a literal is no code', () => {
  if (belowOpt(2)) return
  const count = (s, re) => (s.match(re) || []).length
  const of = (src, opts) => funcWat(wat(spliced(src), { optimize: 2, ...opts }), 'f')
  const decided = of(flows['a literal read past a test it decides'][0])
  is(count(decided, /\bif\b|br_if|select/g), 0, 'the tests of the literal are decided')
  ok(/f64\.const -1\.5/.test(decided), 'the read is the literal')
  const kept = of(flows['a literal an arm may replace'][0])
  ok(count(kept, /\bif\b|br_if|select/g) > 0, 'a literal an arm may replace is read')
  const exact = of(flows['an exact function of a literal'][0])
  is(count(exact, /f64\.(floor|abs|sqrt|eq|ne)|\bif\b|br_if/g), 0, 'an exact function of a literal is its value')
  // (the integer pass decides a test its intervals answer too: off as well)
  const off = of(flows['a literal read past a test it decides'][0], { optimize: { level: 2, constants: false, intNarrow: false, watr: false } })
  ok(count(off, /f64\.(eq|ne)/g) > 0, 'the passes are what decide them')
})

// A binding assigned on every path to its reads is never tested for `undefined`.
const assigned = {
  'assigned in both arms': 'export let f = (x) => { let r; if (x === 0) { r = 0.5 } else { r = 0.5 + x * 0.25 } return 2 * r }',
  'a spliced body that returns from an arm': 'function poly(x) { if (x === 0) { return 0.5 } return 0.5 + x * (0.25 + x * 0.125) }\nexport let f = (x) => { const z = x * x; return z * poly(z) - x * 2.5 }',
  'assigned in one arm': 'export let f = (x) => { let r; if (x > 0) { r = x * 2 } return r + 1 }',
  'assigned in a loop': 'export let f = (x) => { let r; for (let i = 0; i < x; i++) { r = i } return r + 1 }',
  'assigned past a labeled block a break leaves': 'export let f = (x) => { let r; out: { if (x > 0) break out; r = 1 } return r + 1 }',
  'assigned in a labeled block before each break': 'export let f = (x) => { let r; out: { if (x > 0) { r = 5; break out } r = 1 } return r + 1 }',
  'a break out of a loop in a labeled block': 'export let f = (x) => { let r; out: { for (let i = 0; i < 3; i++) { if (i === x) break out; r = i } r = 9 } return r + 1 }',
  'assigned in a try': 'export let f = (x) => { let r; try { if (x > 0) throw 1; r = 2 } catch (e) { } return r + 1 }',
}

test('constants: a binding assigned before its reads answers what the host answers', () => {
  for (const [name, src] of Object.entries(assigned)) {
    const host = oracle(src)
    for (const optimize of levels(0, 2, 3)) {
      const m = run(src, { optimize })
      for (const x of [0, 1, -1, 2, 7, 0.5, NaN]) is(m.f(x), host.f(x), `${name} at ${optimize}: f(${x})`)
    }
  }
})

test('constants: a binding assigned on every path is read as it is', () => {
  if (belowOpt(2)) return
  const UNDEF = /0x7FF8000200000000/
  for (const name of ['assigned in both arms', 'a spliced body that returns from an arm', 'assigned in a labeled block before each break']) {
    const body = funcWat(wat(assigned[name], { optimize: 2 }), 'f')
    ok(body.length > 0 && !UNDEF.test(body), `${name}: no test for undefined`)
  }
})

test('constants: a remainder is a number', () => {
  if (belowOpt(2)) return
  const body = funcWat(wat('export let f = (a, b) => { a = +a; b = +b; return 1.5 + (a - b) % b }', { optimize: 2 }), 'f')
  ok(!/0x7FF8000200000000/.test(body), 'no test for undefined on what `%` answers')
})
