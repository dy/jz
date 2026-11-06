// A choice between two quotients by one divisor is one quotient of a choice
// (src/optimize/share-quotients.js): the vectorizer converts color-space's hue
// sector, three arms over one `delta`, into lane selects that divide once per arm.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import { oracle, jz, compile } from './util.js'
import { shareQuotients } from '../src/optimize/share-quotients.js'

const g = (n) => ['local.get', n]
const div = (a, b) => ['f64x2.div', a, b]
const sel = (a, b, m) => ['v128.bitselect', a, b, m]
const locals = ['$a', '$b', '$c', '$d', '$k', '$m', '$n', '$x'].map(n => ['local', n, 'v128'])
const fn = (...body) => ['func', '$f', ...locals, ['local', '$s', 'f64'], ['local', '$t', 'f64'], ['local', '$i', 'i32'], ...body]
const out = (...body) => shareQuotients(['module', fn(...body)])[1]
const copy = (n) => JSON.parse(JSON.stringify(n))
const qt = (k, t = 'v128') => ['local', `$__qt${k}`, t]

test('shareQuotients: two arms over one divisor divide a choice of their dividends', () => {
  is(out(['local.set', '$x', sel(div(g('$a'), g('$d')), ['f64x2.add', g('$k'), div(g('$b'), g('$d'))], g('$m'))]),
    ['func', '$f', ...locals, ['local', '$s', 'f64'], ['local', '$t', 'f64'], ['local', '$i', 'i32'], qt(0),
      ['local.set', '$__qt0', div(sel(g('$a'), g('$b'), g('$m')), g('$d'))],
      ['local.set', '$x', sel(g('$__qt0'), ['f64x2.add', g('$k'), g('$__qt0')], g('$m'))]],
    'one division, each arm reading it')
  // a shared dividend: one division by a choice of the divisors
  const s = out(['local.set', '$x', sel(div(g('$d'), g('$a')), div(g('$d'), g('$b')), g('$m'))])
  is(s.slice(-2), [['local.set', '$__qt0', div(g('$d'), sel(g('$a'), g('$b'), g('$m')))], ['local.set', '$x', sel(g('$__qt0'), g('$__qt0'), g('$m'))]],
    'one division of the dividend by the chosen divisor')
  // three arms nested: one division of a choice of choices; the mask a set of its own
  const m2 = ['f64x2.eq', g('$c'), g('$k')]
  const nested = out(['local.set', '$x', sel(div(g('$a'), g('$d')), sel(['f64x2.add', g('$k'), div(g('$b'), g('$d'))], div(g('$c'), g('$d')), m2), g('$m'))])
  is(nested.filter(n => Array.isArray(n) && n[0] === 'local.set').length, 3, 'the inner mask, one quotient, the statement')
  is(JSON.stringify(nested).match(/f64x2\.div/g).length, 1, 'one division for three arms')
  // scalar select of quotients
  const scalar = out(['local.set', '$s', ['select', ['f64.div', g('$s'), g('$t')], ['f64.div', ['f64.const', 1], g('$t')], g('$i')]])
  is(scalar.slice(-2), [['local.set', '$__qt0', ['f64.div', ['select', g('$s'), ['f64.const', 1], g('$i')], g('$t')]], ['local.set', '$s', ['select', g('$__qt0'), g('$__qt0'), g('$i')]]],
    'a select of scalar quotients')
})

test('shareQuotients: the statement runs its tees first, and a read before a tee keeps it', () => {
  // the divisor tee'd in the first arm: its set comes first, the quotient reads the local
  const s = out(['local.set', '$x', sel(div(g('$a'), ['local.tee', '$d', ['f64x2.sub', g('$b'), g('$c')]]), div(g('$b'), g('$d')), g('$m'))])
  is(s.slice(-3), [['local.set', '$d', ['f64x2.sub', g('$b'), g('$c')]], ['local.set', '$__qt0', div(sel(g('$a'), g('$b'), g('$m')), g('$d'))], ['local.set', '$x', sel(g('$__qt0'), g('$__qt0'), g('$m'))]],
    'the tee becomes a set before the quotient')
  const kept = (stmt, why) => is(out(copy(stmt)), fn(stmt), why)
  kept(['local.set', '$x', sel(div(g('$d'), g('$a')), div(['local.tee', '$d', g('$b')], g('$a')), g('$m'))], 'a read of $d before the tee that writes it')
  kept(['local.set', '$x', sel(div(g('$a'), g('$d')), div(g('$b'), g('$k')), g('$m'))], 'two divisors')
  kept(['local.set', '$x', sel(div(div(g('$a'), g('$d')), g('$d')), div(g('$b'), g('$d')), g('$m'))], 'an arm of two divisions')
  kept(['local.set', '$x', sel(div(['call', '$h'], g('$d')), div(g('$b'), g('$d')), g('$m'))], 'a call within')
  kept(['local.set', '$x', sel(div(g('$a'), ['f64x2.add', g('$d'), g('$k')]), div(g('$b'), ['f64x2.add', g('$d'), g('$k')]), g('$m'))], 'a divisor computed twice is no one value')
})

// rgb → hsl, color-space's kernel: the hue sector's three quotients by `delta`, the
// saturation's two of it, at NaN, signed zeros, equal channels and infinities.
const HSL = `
const hue = (r, g, b, min, max, delta) => {
  let h = 0
  if (max === min) h = 0
  else if (r === max) h = (g - b) / delta
  else if (g === max) h = 2 + (b - r) / delta
  else if (b === max) h = 4 + (r - g) / delta
  h = Math.min(h / 6, 1)
  return h < 0 ? h + 1 : h
}
const hsl = (r0, g0, b0) => {
  const r = r0 / 255, g = g0 / 255, b = b0 / 255
  const min = Math.min(r, g, b), max = Math.max(r, g, b), delta = max - min
  const h = hue(r, g, b, min, max, delta), l = (min + max) / 2
  const s = max === min ? 0 : l <= 0.5 ? delta / (max + min) : delta / (2 - max - min)
  return [h * 360, s * 100, l * 100]
}
export let run = (xs) => {
  const p = (xs.length / 3) | 0, buf = new Float64Array(p * 3)
  for (let i = 0; i < p * 3; i++) buf[i] = xs[i]
  for (let i = 0; i < p; i++) { const j = 3 * i; const [a, b, c] = hsl(buf[j], buf[j + 1], buf[j + 2]); buf[j] = a; buf[j + 1] = b; buf[j + 2] = c }
  return buf
}`
const SPECIAL = [NaN, -0, 0, 255, 128, 1, 254.5, Infinity, -Infinity, -3, 1e-320, 300]

test('shareQuotients: the hue sector agrees with the host lane for lane, and divides once a choice', () => {
  const native = oracle(HSL).run
  const xs = []
  for (const a of SPECIAL) for (const b of SPECIAL) xs.push(a, b, SPECIAL[(xs.length >> 1) % SPECIAL.length])
  for (let i = 0; i < 300; i++) xs.push((i * 37) % 256, (i * 101) % 256, (i * 53) % 256)
  const want = native(xs)
  for (const optimize of [...levels(0, 2, 3, 'size'), { level: 'speed', shareQuotients: false }]) {
    const got = jz(HSL, { optimize }).exports.run(xs)
    is(got.length, want.length, JSON.stringify(optimize))
    ok(want.every((v, i) => Object.is(v, got[i])), `${JSON.stringify(optimize)}: every channel as the host computes it`)
  }
  if (onKernel()) return
  const divisions = (optimize) => (compile(HSL, { optimize, wat: true }).match(/\(f64x2\.div/g) || []).length
  const off = divisions({ level: 'speed', shareQuotients: false }), on = divisions('speed')
  ok(off > 0 && on <= off - 3 * Math.floor(off / 9), `the hue's three quotients and the saturation's two share (${off} → ${on})`)
})
