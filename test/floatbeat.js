import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile, evaluate } from './util.js'

// Floatbeat/Bytebeat Test Suite
// NOTE: All code here is PURE JS - runnable in any JS interpreter
// Floatbeat wrapper would destructure Math globals for convenience

test('floatbeat - Math constants', async () => {
  const pi = await evaluate('Math.PI')
  ok(Math.abs(pi - Math.PI) < 0.0001, 'Math.PI should match')

  const e = await evaluate('Math.E')
  ok(Math.abs(e - Math.E) < 0.0001, 'Math.E should match')
})

test('floatbeat - native WASM math', async () => {
  is(await evaluate('Math.sqrt(4)'), 2)
  is(await evaluate('Math.sqrt(9)'), 3)
  is(await evaluate('Math.abs(-5)'), 5)
  is(await evaluate('Math.abs(3)'), 3)
  is(await evaluate('Math.floor(3.7)'), 3)
  is(await evaluate('Math.floor(-1.1)'), -2)
  is(await evaluate('Math.ceil(3.2)'), 4)
  is(await evaluate('Math.ceil(-1.9)'), -1)
  is(await evaluate('Math.trunc(3.9)'), 3)
  is(await evaluate('Math.trunc(-3.9)'), -3)
  is(await evaluate('Math.min(1, 2)'), 1)
  is(await evaluate('Math.max(1, 2)'), 2)
  is(await evaluate('Math.min(5, 3, 8)'), 3)
})

test('floatbeat - trig functions', async () => {
  const s0 = await evaluate('Math.sin(0)')
  ok(Math.abs(s0) < 0.0001, 'sin(0) = 0')

  const s90 = await evaluate('Math.sin(Math.PI/2)')
  ok(Math.abs(s90 - 1) < 0.0001, 'sin(π/2) = 1')

  const c0 = await evaluate('Math.cos(0)')
  ok(Math.abs(c0 - 1) < 0.0001, 'cos(0) = 1')

  const cpi = await evaluate('Math.cos(Math.PI)')
  ok(Math.abs(cpi + 1) < 0.0001, 'cos(π) = -1')

  const t0 = await evaluate('Math.tan(0)')
  ok(Math.abs(t0) < 0.0001, 'tan(0) = 0')
})

test('floatbeat - inverse trig', async () => {
  const as = await evaluate('Math.asin(1)')
  ok(Math.abs(as - Math.PI/2) < 0.0001, 'asin(1) = π/2')

  const ac = await evaluate('Math.acos(0)')
  ok(Math.abs(ac - Math.PI/2) < 0.0001, 'acos(0) = π/2')

  const at = await evaluate('Math.atan(1)')
  ok(Math.abs(at - Math.PI/4) < 0.0001, 'atan(1) = π/4')
})

test('floatbeat - hyperbolic', async () => {
  const sh = await evaluate('Math.sinh(0)')
  ok(Math.abs(sh) < 0.0001, 'sinh(0) = 0')

  const ch = await evaluate('Math.cosh(0)')
  ok(Math.abs(ch - 1) < 0.0001, 'cosh(0) = 1')

  const th = await evaluate('Math.tanh(0)')
  ok(Math.abs(th) < 0.0001, 'tanh(0) = 0')
})

test('floatbeat - exp/log', async () => {
  const e1 = await evaluate('Math.exp(1)')
  ok(Math.abs(e1 - Math.E) < 0.0001, 'exp(1) = e')

  const l1 = await evaluate('Math.log(Math.E)')
  ok(Math.abs(l1 - 1) < 0.0001, 'log(e) = 1')

  const l2 = await evaluate('Math.log2(8)')
  ok(Math.abs(l2 - 3) < 0.0001, 'log2(8) = 3')

  const l10 = await evaluate('Math.log10(100)')
  ok(Math.abs(l10 - 2) < 0.0001, 'log10(100) = 2')
})

test('floatbeat - pow', async () => {
  is(await evaluate('Math.pow(2, 3)'), 8)
  is(await evaluate('2 ** 3'), 8)
  is(await evaluate('Math.pow(3, 2)'), 9)

  const p = await evaluate('Math.pow(2, 0.5)')
  ok(Math.abs(p - Math.SQRT2) < 0.0001, 'pow(2, 0.5) = √2')
})

test('floatbeat - other math', async () => {
  const cb = await evaluate('Math.cbrt(27)')
  ok(Math.abs(cb - 3) < 0.0001, 'cbrt(27) = 3')

  is(await evaluate('Math.sign(5)'), 1)
  is(await evaluate('Math.sign(-5)'), -1)
  is(await evaluate('Math.sign(0)'), 0)

  is(await evaluate('Math.round(3.4)'), 3)
  is(await evaluate('Math.round(3.6)'), 4)
})

test('floatbeat - variable bindings (comma expressions)', async () => {
  is(await evaluate('(a = 5, a)'), 5)
  is(await evaluate('(a = 3, b = 4, a + b)'), 7)
  is(await evaluate('(x = 2, y = 3, x * y)'), 6)
  is(await evaluate('(t = 100, tune = 1.5, t * tune)'), 150)
})

test('floatbeat - arrays with WASM GC', async () => {
  is(await evaluate('[10, 20, 30][0]'), 10)
  is(await evaluate('[10, 20, 30][1]'), 20)
  is(await evaluate('[10, 20, 30][2]'), 30)
  is(await evaluate('(t = 1, [5, 10, 15][t])'), 10)
  is(await evaluate('(t = 5, [1, 2, 3, 4][t & 3])'), 2)
  is(await evaluate('(t = 6, [1, 2, 3, 4][t >> 1 & 3])'), 4)
})

test('floatbeat - classic sierpinski', async () => {
  is(await evaluate('(t = 257, t & (t >> 8))'), 1)
  is(await evaluate('(t = 515, t & (t >> 8))'), 2)
  is(await evaluate('(t = 775, t & (t >> 8))'), 3)
})

test('floatbeat - simple sine wave', async () => {
  const mod = await compile('export const wave = t => Math.sin(t * Math.PI / 128)')
  const { wave } = mod
  ok(Math.abs(wave(64) - 1) < 0.0001)
  ok(Math.abs(wave(128)) < 0.0001)
})

test('floatbeat - FM synthesis pattern', async () => {
  const mod = await compile('export const fm = t => Math.sin(t * Math.PI / 128 + Math.sin(t * Math.PI / 256) * 2)')
  const { fm } = mod
  ok(typeof fm(64) === 'number' && !isNaN(fm(64)))
})

test('floatbeat - pitch formula', async () => {
  const a440 = await evaluate('Math.pow(2, 0 / 12) * 440')
  ok(Math.abs(a440 - 440) < 0.0001)

  const a880 = await evaluate('Math.pow(2, 12 / 12) * 440')
  ok(Math.abs(a880 - 880) < 0.0001)
})

test('floatbeat - sequencer pattern', async () => {
  const { seq } = await compile('export const seq = t => [0, 2, 4, 7][t >> 13 & 3]')
  is(seq(0), 0)
  is(seq(8192), 2)
  is(seq(16384), 4)
  is(seq(24576), 7)
})

test('floatbeat - combined sequencer + pitch', async () => {
  const mod = await compile('export const synth = t => (note = [0, 4, 7, 12][t >> 13 & 3], Math.sin(t * Math.pow(2, note / 12) * Math.PI / 256))')
  const { synth } = mod
  ok(typeof synth(8192) === 'number' && !isNaN(synth(8192)))
})

test('floatbeat - envelope pattern', async () => {
  const mod = await compile('export const env = t => 1 - (t % 8192) / 8192')
  const { env } = mod
  ok(Math.abs(env(0) - 1) < 0.0001)
  ok(Math.abs(env(4096) - 0.5) < 0.0001)
})

test('floatbeat - real formula: simple chiptune', async () => {
  const mod = await compile('export const chip = t => t * ((t >> 12 | t >> 8) & 63 & t >> 4)')
  const { chip } = mod
  ok(typeof chip(8000) === 'number' && !isNaN(chip(8000)))
})

test('floatbeat - sustained instance for audio', async () => {
  const mod = await compile('export const wave = t => Math.sin(t * Math.PI / 128)')
  const { wave } = mod

  const samples = []
  for (let i = 0; i < 256; i++) {
    samples.push(wave(i))
  }

  ok(Math.abs(samples[0]) < 0.01, 'starts near 0')
  ok(Math.abs(samples[64] - 1) < 0.01, 'peaks at 64')
  ok(Math.abs(samples[128]) < 0.01, 'crosses 0 at 128')
  ok(Math.abs(samples[192] + 1) < 0.01, 'troughs at 192')
})

test('floatbeat - Math.random', async () => {
  const r1 = await evaluate('Math.random()')
  ok(r1 >= 0 && r1 < 1, 'random in [0,1)')
})

test('floatbeat - null and undefined', async () => {
  is(await evaluate('null'), 0)
  is(await evaluate('undefined'), 0)
  is(await evaluate('null + 5'), 5)
  is(await evaluate('undefined + 5'), 5)
  // NOTE: Memory mode can't distinguish 0 from null since both are f64(0)
  // So ?? operator treats 0 as non-nullish (returns the value, not fallback)
  is(await evaluate('null ?? 42'), 0)    // null is 0, so returns 0
  is(await evaluate('undefined ?? 42'), 0)  // undefined is 0, so returns 0
  is(await evaluate('0 ?? 42'), 0)
  is(await evaluate('5 ?? 42'), 5)
  is(await evaluate('!null'), 1)
  is(await evaluate('!undefined'), 1)
  is(await evaluate('null ? 1 : 2'), 2)
  is(await evaluate('undefined ? 1 : 2'), 2)
})

// ========== ARROW FUNCTIONS ==========

test('arrow functions - basic', async () => {
  const code = 'export const add = (a, b) => a + b'
  const { add } = await compile(code)
  is(add(2, 3), 5)
  is(add(-1, 1), 0)
  is(add(10.5, 0.5), 11)
})

test('arrow functions - single param', async () => {
  const code = 'export const double = x => x * 2'
  const { double } = await compile(code)
  is(double(5), 10)
  is(double(-3), -6)
})

test('arrow functions - multiple exports', async () => {
  const code = 'export const add = (a, b) => a + b; export const mul = (x, y) => x * y; export const neg = n => -n'
  const { add, mul, neg } = await compile(code)
  is(add(2, 3), 5)
  is(mul(4, 5), 20)
  is(neg(7), -7)
})

test('arrow functions - with Math', async () => {
  const code = 'export const dist = (x, y) => Math.sqrt(x*x + y*y)'
  const { dist } = await compile(code)
  is(dist(3, 4), 5)
  is(dist(0, 1), 1)
})

test('arrow functions - complex expression', async () => {
  const code = 'export const lerp = (a, b, t) => a + (b - a) * t'
  const { lerp } = await compile(code)
  is(lerp(0, 10, 0), 0)
  is(lerp(0, 10, 1), 10)
  is(lerp(0, 10, 0.5), 5)
  is(lerp(100, 200, 0.25), 125)
})

test('arrow functions - no params', async () => {
  const code = 'export const pi = () => Math.PI'
  const { pi } = await compile(code)
  ok(Math.abs(pi() - Math.PI) < 0.0001)
})

test('arrow functions - trig', async () => {
  const code = 'export const wave = (t, freq) => Math.sin(t * freq * Math.PI * 2)'
  const { wave } = await compile(code)
  ok(Math.abs(wave(0, 1)) < 0.0001)  // sin(0) = 0
  ok(Math.abs(wave(0.25, 1) - 1) < 0.0001)  // sin(π/2) = 1
})

test('arrow functions - inter-function calls', async () => {
  const code = `
    export const double = x => x * 2;
    export const triple = x => x * 3;
    export const sixfold = x => double(triple(x))
  `
  const { double, triple, sixfold } = await compile(code)
  is(double(5), 10)
  is(triple(5), 15)
  is(sixfold(5), 30)
})

test('arrow functions - synth example', async () => {
  const code = `
    export const osc = (t, freq) => Math.sin(t * freq * Math.PI * 2);
    export const env = (t, attack, decay) => t < attack ? t / attack : Math.exp(-(t - attack) / decay);
    export const synth = (t, freq, attack, decay) => osc(t, freq) * env(t, attack, decay)
  `
  const { synth, osc, env } = await compile(code)
  ok(Math.abs(osc(0.25, 1) - 1) < 0.0001)  // sin(π/2) = 1
  ok(Math.abs(env(0.005, 0.01, 0.5) - 0.5) < 0.0001)  // half attack
  is(typeof synth(0.1, 440, 0.01, 0.5), 'number')
})

test('arrow functions - module-level constants', async () => {
  const code = 'scale = 2; offset = 100; export const linear = x => x * scale + offset'
  const { linear } = await compile(code)
  is(linear(0), 100)
  is(linear(5), 110)
  is(linear(10), 120)
})

test('arrow functions - PI constant in function', async () => {
  const code = 'tau = Math.PI; export const circle = r => tau * 2 * r'
  const { circle } = await compile(code)
  ok(Math.abs(circle(1) - Math.PI * 2) < 0.0001)
})

// ========== parseInt ==========

test('parseInt - from char code', async () => {
  // parseInt with char code as number (common floatbeat pattern)
  is(await evaluate('parseInt(48, 10)'), 0)   // '0' = 48
  is(await evaluate('parseInt(57, 10)'), 9)   // '9' = 57
  is(await evaluate('parseInt(65, 16)'), 10)  // 'A' = 65
  is(await evaluate('parseInt(70, 16)'), 15)  // 'F' = 70
  is(await evaluate('parseInt(97, 36)'), 10)  // 'a' = 97
  is(await evaluate('parseInt(122, 36)'), 35) // 'z' = 122
})

test('parseInt - radix edge cases', async () => {
  // Invalid for radix 10
  ok(isNaN(await evaluate('parseInt(65, 10)')))  // 'A' not valid decimal
  // Invalid for radix 2
  ok(isNaN(await evaluate('parseInt(50, 2)')))   // '2' not valid binary
  // Valid for higher radix
  is(await evaluate('parseInt(50, 10)'), 2)      // '2' = 50 → 2 in base 10
})

test('parseInt - from string literal', async () => {
  if (false) return  // Requires gc:true string type
  // parseInt from string (first char)
  is(await evaluate('parseInt("0", 10)'), 0)
  is(await evaluate('parseInt("9", 10)'), 9)
  is(await evaluate('parseInt("a", 16)'), 10)
  is(await evaluate('parseInt("f", 16)'), 15)
  is(await evaluate('parseInt("z", 36)'), 35)
})

test('parseInt - default radix 10', async () => {
  is(await evaluate('parseInt(48)'), 0)   // '0' with default radix 10
  is(await evaluate('parseInt(53)'), 5)   // '5'
})

// ========== String.charCodeAt ==========

test('charCodeAt - basic', async () => {
  is(await evaluate('"A".charCodeAt(0)'), 65)
  is(await evaluate('"a".charCodeAt(0)'), 97)
  is(await evaluate('"0".charCodeAt(0)'), 48)
  is(await evaluate('"9".charCodeAt(0)'), 57)
})

test('charCodeAt - string indexing', async () => {
  is(await evaluate('"hello".charCodeAt(0)'), 104)  // 'h'
  is(await evaluate('"hello".charCodeAt(1)'), 101)  // 'e'
  is(await evaluate('"hello".charCodeAt(4)'), 111)  // 'o'
})

test('charCodeAt + parseInt pattern', async () => {
  // Common floatbeat pattern: text to number
  is(await evaluate('parseInt("a".charCodeAt(0), 36)'), 10)
  is(await evaluate('parseInt("z".charCodeAt(0), 36)'), 35)
  is(await evaluate('parseInt("0".charCodeAt(0), 10)'), 0)
  is(await evaluate('parseInt("9".charCodeAt(0), 10)'), 9)
})

// ========== Array constructor and fill ==========

test('Array constructor', async () => {
  is(await evaluate('Array(3).length'), 3)
  is(await evaluate('Array(5).length'), 5)
  is(await evaluate('Array(0).length'), 0)
})

test('Array.fill', async () => {
  is(await evaluate('Array(3).fill(7)[0]'), 7)
  is(await evaluate('Array(3).fill(7)[1]'), 7)
  is(await evaluate('Array(3).fill(7)[2]'), 7)
  is(await evaluate('Array(5).fill(42).length'), 5)
})

test('Array.fill - practical use', async () => {
  // Common floatbeat pattern: create waveform table
  const mod = await compile('wave = Array(8).fill(0.5), wave[0]')
  is(mod.run(0), 0.5)
})

// ========== Array.map ==========

test('Array.map - basic', async () => {
  is(await evaluate('[1, 2, 3].map(x => x * 2)[0]'), 2)
  is(await evaluate('[1, 2, 3].map(x => x * 2)[1]'), 4)
  is(await evaluate('[1, 2, 3].map(x => x * 2)[2]'), 6)
})

test('Array.map - preserves length', async () => {
  is(await evaluate('[1, 2, 3, 4, 5].map(x => x + 1).length'), 5)
})

test('Array.map - with Math', async () => {
  const v = await evaluate('[0, 0.5, 1].map(x => Math.sin(x * Math.PI))[1]')
  ok(Math.abs(v - 1) < 0.0001)  // sin(π/2) = 1
})

// ========== Array.reduce ==========

test('Array.reduce - sum', async () => {
  is(await evaluate('[1, 2, 3, 4].reduce((a, b) => a + b, 0)'), 10)
})

test('Array.reduce - product', async () => {
  is(await evaluate('[1, 2, 3, 4].reduce((a, b) => a * b, 1)'), 24)
})

test('Array.reduce - max', async () => {
  is(await evaluate('[3, 1, 4, 1, 5, 9].reduce((a, b) => a > b ? a : b, 0)'), 9)
})

test('Array.reduce - with initial value', async () => {
  is(await evaluate('[1, 2, 3].reduce((acc, x) => acc + x, 100)'), 106)
})

// ========== for loops ==========

test('for loop - basic', async () => {
  // Sum 0+1+2+3+4 = 10
  is(await evaluate('x = 0; for (i = 0; i < 5; i += 1) x += i; x'), 10)
})

test('for loop - simple body', async () => {
  // Returns last body value
  is(await evaluate('for (i = 0; i < 5; i += 1) i'), 4)
})

test('for loop - block body', async () => {
  is(await evaluate('x = 0; for (i = 0; i < 3; i += 1) { x += i }; x'), 3)  // 0+1+2
})

test('for loop - nested', async () => {
  // 3 x 3 = 9 iterations
  is(await evaluate('sum = 0; for (i = 0; i < 3; i += 1) for (j = 0; j < 3; j += 1) sum += 1; sum'), 9)
})

test('for loop - empty init', async () => {
  is(await evaluate('i = 0; for (; i < 3; i += 1) i'), 2)
})

test('for loop - empty step', async () => {
  is(await evaluate('for (i = 0; i < 3;) { i += 1 }'), 3)
})

// ========== while loops ==========

test('while loop - basic', async () => {
  is(await evaluate('x = 0; i = 0; while (i < 5) { x += i; i += 1 }; x'), 10)
})

test('while loop - countdown', async () => {
  is(await evaluate('x = 10; while (x > 0) x -= 1; x'), 0)
})

test('while loop - with condition', async () => {
  // Find first power of 2 >= 100
  is(await evaluate('x = 1; while (x < 100) x *= 2; x'), 128)
})
