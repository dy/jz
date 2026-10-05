// Where the speed tier splices a call (src/compile/plan/inline.js). A loop's
// time is the loop's and its callees': a budget that counts a callee's sites
// across the program makes it depend on how many other loops call the same
// function. At the speed tier
//   - a tiny leaf splices at every site, whatever their count: its body is the
//     size of the call, and the call is what joins the kinds of every site's
//     argument into one parameter;
//   - a straight-line body splices at a site in a loop while the caller has room;
//   - a body takes the calls it keeps along (a function of loops stays one);
//   - a function a value names is still the body of its direct calls;
//   - a call in an arm of a conditional splices in that arm.
// Every form answers what the host answers; the reference is the host itself.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const DRIVER = 'const X = new Float64Array(64), OUT = new Float64Array(64)\nexport let xs = () => X\nexport let outs = () => OUT\n'
const INPUTS = Float64Array.from({ length: 64 }, (_, i) => i === 0 ? 0 : i === 1 ? -0 : i === 2 ? NaN : i === 3 ? Infinity : i === 4 ? -Infinity : i === 5 ? 3e-310 : (i - 32) / 5)
const each = (call) => `export let each = () => { for (let i = 0; i < 64; i++) OUT[i] = ${call} }\n`

const LEAF = 'function isnan(x) { return (x !== x) }\nfunction isinf(x) { return x === Infinity || x === -Infinity }\n'
const MAX = 'function max(x, y) { if (isnan(x) || isnan(y)) return NaN; if (x === Infinity || y === Infinity) return Infinity; if (x === y && x === 0) { if (1 / x === Infinity) return x; return y } if (x > y) return x; return y }\n'
// a library's helper called from more functions than any budget of sites counts
const users = (n) => Array.from({ length: n }, (_, k) => `function u${k}(x) { if (isnan(x)) return ${k}; if (isinf(x)) return -${k}; return x * ${k + 1} }`).join('\n') + '\n' +
  `function all(x) { return ${Array.from({ length: n }, (_, k) => `u${k}(x)`).join(' + ')} }\n`
const POLY = 'function poly(x) { if (x === 0) return 0.5; return 0.5 + x * (0.25 + x * (0.125 + x * (0.0625 + x * 0.03125))) }\n'
const BODY = 'function body(x, y) { var a, b, c, d; a = x * y + 1; b = a * a - x; c = b > 0 ? b * 0.5 : -b * 0.25; d = c + a * poly(b * 0.01); if (d !== d) return 0; a = d * 0.5 + c; b = a * x - y; c = b * b + a * 0.125; d = c > 100 ? c - 100 : c + y; return d + a * 0.5 + b * 0.25 + c * 0.125 }\n'
const loops = (n, call) => Array.from({ length: n }, (_, k) => `export let l${k} = () => { for (let i = 0; i < 64; i++) OUT[i] = ${call(k)} }`).join('\n') + '\n'
const GCD = 'function gcd(a, b) { var t; if (isnan(a) || isnan(b)) return NaN; if (Math.floor(a) !== a || Math.floor(b) !== b) return NaN; if (a < 0) a = -a; if (b < 0) b = -b; while (b) { while (b % 2 === 0 && b > 2) b = b / 2; t = b; b = a % b; a = t } return a }\n' +
  'function lcm(a, b) { var d; if (a === 0 || b === 0) return 0; if (a < 0) a = -a; if (b < 0) b = -b; d = gcd(a, b); if (isnan(d)) return d; return a / d * b }\n'
// a second entry stored on the first, as a library's bundle writes it
const PAIR = 'function assign(x, out, stride, offset) { if (x !== x) { out[offset] = NaN; out[offset + stride] = NaN; return out } if (x < 0) { out[offset] = -Math.floor(-x); out[offset + stride] = x + Math.floor(-x); return out } out[offset] = Math.floor(x); out[offset + stride] = x - Math.floor(x); return out }\n' +
  'var assign_default = assign\nfunction modf(x) { return assign_default(x, [0, 0], 1, 0) }\nvar main_default = modf\nmain_default.assign = assign_default\nvar lib_default = main_default\n'
// functions of loops that stay functions, each with a site of the leaf outside its loops
const nests = (n) => Array.from({ length: n }, (_, k) => `function w${k}(x) { if (isnan(x)) return ${k}; let s = 0; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += x * (i + j + ${k}); return s }`).join('\n') + '\n'
const EVEN = 'function even(n) { if (n === 0) return 1; return odd(n - 1) }\nfunction odd(n) { if (n === 0) return 0; return even(n - 1) }\n'

const kernels = {
  'a tiny leaf at more sites than a budget counts': DRIVER + LEAF + users(90) + each('all(X[i])'),
  'a tiny leaf one site passes a value of no known kind': DRIVER + LEAF + nests(70) + 'const BAG = [1, "a", undefined, null]\nexport let odd = (k) => isnan(BAG[k]) ? 1 : 0\n' +
    each(Array.from({ length: 70 }, (_, k) => `w${k}(X[i])`).join(' + ')),
  'a straight-line body called from eight loops': DRIVER + POLY + BODY + loops(8, k => `body(X[i], ${k + 1})`) + each('body(X[i], 0.5)'),
  'a body that keeps the calls of a function of loops': DRIVER + LEAF + GCD + each('lcm(Math.floor(X[i] * 9), 6)') +
    'export let other = () => { let s = 0; for (let i = 0; i < 64; i++) s += gcd(Math.floor(X[i] * 9), 4) + gcd(8, Math.floor(X[i])); return s }\n',
  'a function a value names': DRIVER + PAIR + 'export let each = () => { for (let i = 0; i < 64; i++) { const r = lib_default(X[i]); OUT[i] = r[0] * 8 + r[1] } }\n' +
    'export let entry = () => lib_default\nexport let other = (x) => lib_default.assign(x, [0, 0, 0], 2, 0)[2]\n',
  'a call in an arm of a conditional': DRIVER + LEAF + MAX + 'function nanmax(x, y) { if (isnan(x)) { return isnan(y) ? NaN : y } return isnan(y) ? x : max(x, y) }\n' + each('nanmax(X[i], 0.75) + (X[i] > 1 && max(X[i], 2)) + (X[i] < 0 || max(X[i], -1))'),
  'a conditional past an effect': DRIVER + LEAF + MAX + 'let n = 0\nconst bump = (v) => { n += 1; return v + n }\n' +
    'export let each = () => { n = 0; let m = 0; for (let i = 0; i < 64; i++) OUT[i] = bump(X[i]) + (m = m + 1) + (X[i] > 0 ? max(X[i], m) : m) + (OUT[i & 3] = i) + (X[i] > 1 && max(OUT[i & 3], 2)) }\n',
  'functions that call each other': DRIVER + EVEN + each('even(i & 7) * 10 + odd(i & 3)'),
}

const agree = (src, opts, label) => {
  const host = oracle(src)
  host.xs().set(INPUTS); host.each()
  const want = host.outs().slice()
  for (const optimize of levels(0, 2, 3)) {
    const m = run(src, { jzify: true, optimize: opts ? { level: optimize, ...opts } : optimize })
    m.xs().set(INPUTS); m.each()
    const got = m.outs()
    for (let i = 0; i < 64; i++) is(got[i], want[i], `${label} at ${optimize}: element ${i} (${INPUTS[i]})`)
  }
}

test('splice: a kernel answers what the host answers', () => {
  for (const [name, src] of Object.entries(kernels)) agree(src, null, name)
})

test('splice: a function a value names answers through the value too', () => {
  const src = kernels['a function a value names'], host = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = run(src, { jzify: true, optimize })
    for (const x of [2.75, -2.75, 0, NaN]) is(m.other(x), host.other(x), `at ${optimize}: other(${x})`)
  }
})

test('splice: a function of loops answers at its other sites', () => {
  const src = kernels['a body that keeps the calls of a function of loops'], host = oracle(src)
  host.xs().set(INPUTS)
  for (const optimize of levels(0, 2, 3)) {
    const m = run(src, { jzify: true, optimize })
    m.xs().set(INPUTS)
    is(m.other(), host.other(), `at ${optimize}`)
  }
})

const calls = (body) => [...new Set([...body.matchAll(/\((?:return_)?call \$([^\s()]+)/g)].map(m => m[1]).filter(n => !n.startsWith('__')))]
const text = (name) => wat(kernels[name], { jzify: true, optimize: 3 })

test('splice: a tiny leaf of ninety sites is no function', () => {
  if (belowOpt(3)) return
  const many = text('a tiny leaf at more sites than a budget counts')
  ok(!/\(func \$isnan[\s)]/.test(many) && !/\(func \$isinf[\s)]/.test(many), 'no function is left of it')
  ok(!/call \$isnan|call \$isinf/.test(many), 'and no call')
  // seventy sites outside loops, in functions that stay, and one that passes a value of no known kind
  const mixed = text('a tiny leaf one site passes a value of no known kind')
  ok(!/\(func \$isnan[\s)]/.test(mixed) && !/call \$isnan/.test(mixed), 'a site outside a loop takes the body too')
  ok(!/0x7FF8000100000000|0x7FF8000200000000/.test(funcWat(mixed, 'each').replace(/\(f64\.const nan:0x7FF8000200000000\)\s*\)\s*$/, '')), 'the sites that pass numbers test a number')
})

test('splice: a straight-line body is spliced in each loop that calls it', () => {
  if (belowOpt(3)) return
  const eight = text('a straight-line body called from eight loops')
  for (const fn of ['l0', 'l7', 'each']) is(calls(funcWat(eight, fn)).join(' '), '', `${fn} calls nothing`)
})

test('splice: a body takes the calls it keeps along', () => {
  if (belowOpt(3)) return
  const body = funcWat(text('a body that keeps the calls of a function of loops'), 'each')
  ok(body.length > 0 && calls(body).every(n => n === 'gcd'), 'the loop calls the function of loops alone')
  ok(!/local\.(set|tee) \$\S+\s*\((i32|f64)\.const 6\)/.test(body), 'the literal the site passed is no local of the loop')
})

test('splice: a function a value names is spliced where it is called', () => {
  if (belowOpt(3)) return
  const body = funcWat(text('a function a value names'), 'each')
  is(calls(body).join(' '), '', 'the loop calls neither entry')
  ok(!/call \$__alloc|call \$__dyn|call \$__ptr_offset/.test(body), 'and makes no array for the two results')
})

test('splice: a call in an arm of a conditional is spliced in the arm', () => {
  if (belowOpt(3)) return
  is(calls(funcWat(text('a call in an arm of a conditional'), 'each')).join(' '), '', 'the loop calls nothing')
})

test('splice: a cycle of calls keeps a call', () => {
  if (belowOpt(3)) return
  const body = funcWat(text('functions that call each other'), 'each')
  ok(/call \$(even|odd)/.test(body), 'the loop calls into the cycle')
  ok(!/f64\.eq|i32\.eqz|br_if \$(?!brk|loop)/.test(body.replace(/br_if \$\S*(brk|loop)\d*/g, '')), 'and holds none of its tests')
})

test('splice: below the speed tier the budgets hold', () => {
  if (belowOpt(2)) return
  const two = wat(kernels['a straight-line body called from eight loops'], { jzify: true, optimize: 2 })
  ok(/\(func \$body[\s)]/.test(two), 'a body of nine sites is one function')
})

test('splice: a caller with no room keeps the call', () => {
  if (belowOpt(3)) return
  // forty loops in one function, each calling the body: past the caller's bound the calls stay
  const src = DRIVER + POLY + BODY + `export let each = () => {\n${Array.from({ length: 40 }, (_, k) => `  for (let i = 0; i < 64; i++) OUT[i] += body(X[i], ${k + 1})`).join('\n')}\n}\n`
  const body = funcWat(wat(src, { jzify: true, optimize: 3 }), 'each')
  const kept = (body.match(/call \$body/g) || []).length
  ok(kept > 0 && kept < 40, `${40 - kept} of 40 sites took the body, the rest call it`)
  const host = oracle(src), m = run(src, { jzify: true, optimize: 3 })
  host.xs().set(INPUTS); m.xs().set(INPUTS); host.each(); m.each()
  for (let i = 0; i < 64; i++) is(m.outs()[i], host.outs()[i], `element ${i}`)
})

// A function nothing reaches is not lowered, so its stores run nowhere (compile/
// program-facts/slot-write-hazards.js): a helper every site took the body of, or one
// the program never calls, stores through a parameter no call types.
test('splice: a helper nothing calls changes no byte', () => {
  if (belowOpt(2)) return
  const records = `const initRows = () => {
    const rows = []
    let s = 0x1234abcd | 0
    for (let i = 0; i < 64; i++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      const k = s & 1
      const a = (s >>> 3) & 1023, b = (s >>> 13) & 1023
      if (k === 0) rows.push({ k: k, x: a, y: b })
      else rows.push({ k: k, r: a })
    }
    return rows
  }
  const measure = (o) => { const k = o.k; if (k === 0) return (o.x + o.y) | 0; return Math.imul(o.r, 3) }
  const runKernel = (rows) => { let sum = 0; for (let i = 0; i < rows.length; i++) sum = (sum + measure(rows[i])) | 0; return sum }
  `
  const helper = 'const shift = (samples) => { for (let j = 0; j + 1 < samples.length; j++) samples[j + 1] = samples[j] }\n'
  const main = 'export let main = () => runKernel(initRows())'
  const want = oracle(records + main).main()
  for (const optimize of levels(2, 3)) {
    const bare = wat(records + main, { optimize }), held = wat(records + helper + main, { optimize })
    is(held.length, bare.length, `at ${optimize}: the module with the helper is the module without`)
    ok(!/\$__to_num|\$__dyn_get/.test(held), `at ${optimize}: a field of a record is read as the number it is`)
    is(run(records + helper + main, { optimize }).main(), want, `at ${optimize}: the answer`)
  }
})

// A store target of a name and a key (`out[c] = samp(…)`) names its element
// before the call and after the splice alike: the callee's body under its own
// view decides whether the splice runs user code before the store, where its
// renamed prefix under the caller's view knows no kind of its parameters (a
// clamp of a Number parameter runs no conversion). watercolor's bilinear
// sample, called per pixel from the ink step, took the body only at a `let`.
test('splice: a store into an element takes a straight-line body whose prefix clamps its parameters', () => {
  if (belowOpt(3)) return
  const src = DRIVER + `const F = new Float64Array(16)
    function samp(f, x, w) { if (x < 0.5) x = 0.5; else if (x > w - 1.5) x = w - 1.5; let i0 = x | 0, s = x - i0; return f[i0] * (1 - s) + f[i0 + 1] * s }
    export let fill = (w) => { for (let i = 0; i < 64; i++) OUT[i] = samp(F, X[i] * 0.3 + 2, w) }\n`
  const fill = funcWat(wat(src, { jzify: true, optimize: 3 }), 'fill')
  ok(!/call \$samp/.test(fill), 'the sample splices into the element store')
  const host = oracle(src), m = run(src, { jzify: true, optimize: 3 })
  host.xs().set(INPUTS); m.xs().set(INPUTS); host.fill(16); m.fill(16)
  for (let i = 0; i < 64; i++) is(m.outs()[i], host.outs()[i], `element ${i}`)
})
