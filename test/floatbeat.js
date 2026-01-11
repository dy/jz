import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile, evaluate, instantiate } from '../index.js'

// Floatbeat/Bytebeat Test Suite

test('floatbeat - t variable', async () => {
  is(await evaluate('t', 0), 0)
  is(await evaluate('t', 100), 100)
  is(await evaluate('t + 1', 5), 6)
  is(await evaluate('t * 2', 10), 20)
  is(await evaluate('t / 4', 100), 25)
})

test('floatbeat - constants', async () => {
  const pi = await evaluate('PI')
  ok(Math.abs(pi - Math.PI) < 0.0001, 'PI should match')

  const e = await evaluate('E')
  ok(Math.abs(e - Math.E) < 0.0001, 'E should match')
})

test('floatbeat - native WASM math', async () => {
  is(await evaluate('sqrt(4)'), 2)
  is(await evaluate('sqrt(9)'), 3)
  is(await evaluate('abs(-5)'), 5)
  is(await evaluate('abs(3)'), 3)
  is(await evaluate('floor(3.7)'), 3)
  is(await evaluate('floor(-1.1)'), -2)
  is(await evaluate('ceil(3.2)'), 4)
  is(await evaluate('ceil(-1.9)'), -1)
  is(await evaluate('trunc(3.9)'), 3)
  is(await evaluate('trunc(-3.9)'), -3)
  is(await evaluate('int(3.9)'), 3) // alias for trunc
  is(await evaluate('min(1, 2)'), 1)
  is(await evaluate('max(1, 2)'), 2)
  is(await evaluate('min(5, 3, 8)'), 3)
})

test('floatbeat - imported trig', async () => {
  const s0 = await evaluate('sin(0)')
  ok(Math.abs(s0) < 0.0001, 'sin(0) = 0')

  const s90 = await evaluate('sin(PI/2)')
  ok(Math.abs(s90 - 1) < 0.0001, 'sin(π/2) = 1')

  const c0 = await evaluate('cos(0)')
  ok(Math.abs(c0 - 1) < 0.0001, 'cos(0) = 1')

  const cpi = await evaluate('cos(PI)')
  ok(Math.abs(cpi + 1) < 0.0001, 'cos(π) = -1')

  const t0 = await evaluate('tan(0)')
  ok(Math.abs(t0) < 0.0001, 'tan(0) = 0')
})

test('floatbeat - inverse trig', async () => {
  const as = await evaluate('asin(1)')
  ok(Math.abs(as - Math.PI/2) < 0.0001, 'asin(1) = π/2')

  const ac = await evaluate('acos(0)')
  ok(Math.abs(ac - Math.PI/2) < 0.0001, 'acos(0) = π/2')

  const at = await evaluate('atan(1)')
  ok(Math.abs(at - Math.PI/4) < 0.0001, 'atan(1) = π/4')
})

test('floatbeat - hyperbolic', async () => {
  const sh = await evaluate('sinh(0)')
  ok(Math.abs(sh) < 0.0001, 'sinh(0) = 0')

  const ch = await evaluate('cosh(0)')
  ok(Math.abs(ch - 1) < 0.0001, 'cosh(0) = 1')

  const th = await evaluate('tanh(0)')
  ok(Math.abs(th) < 0.0001, 'tanh(0) = 0')
})

test('floatbeat - exp/log', async () => {
  const e1 = await evaluate('exp(1)')
  ok(Math.abs(e1 - Math.E) < 0.0001, 'exp(1) = e')

  const l1 = await evaluate('log(E)')
  ok(Math.abs(l1 - 1) < 0.0001, 'log(e) = 1')

  const l2 = await evaluate('log2(8)')
  ok(Math.abs(l2 - 3) < 0.0001, 'log2(8) = 3')

  const l10 = await evaluate('log10(100)')
  ok(Math.abs(l10 - 2) < 0.0001, 'log10(100) = 2')
})

test('floatbeat - pow', async () => {
  is(await evaluate('pow(2, 3)'), 8)
  is(await evaluate('2 ** 3'), 8)
  is(await evaluate('pow(3, 2)'), 9)

  const p = await evaluate('pow(2, 0.5)')
  ok(Math.abs(p - Math.SQRT2) < 0.0001, 'pow(2, 0.5) = √2')
})

test('floatbeat - other math', async () => {
  const cb = await evaluate('cbrt(27)')
  ok(Math.abs(cb - 3) < 0.0001, 'cbrt(27) = 3')

  is(await evaluate('sign(5)'), 1)
  is(await evaluate('sign(-5)'), -1)
  is(await evaluate('sign(0)'), 0)

  is(await evaluate('round(3.4)'), 3)
  is(await evaluate('round(3.6)'), 4)
})

test('floatbeat - variable bindings (comma expressions)', async () => {
  is(await evaluate('(a = 5, a)'), 5)
  is(await evaluate('(a = 3, b = 4, a + b)'), 7)
  is(await evaluate('(x = 2, y = 3, x * y)'), 6)
  is(await evaluate('(tune = 1.5, t * tune)', 100), 150)
})

test('floatbeat - arrays with WASM GC', async () => {
  is(await evaluate('[10, 20, 30][0]'), 10)
  is(await evaluate('[10, 20, 30][1]'), 20)
  is(await evaluate('[10, 20, 30][2]'), 30)
  is(await evaluate('[5, 10, 15][t]', 1), 10)
  is(await evaluate('[1, 2, 3, 4][t & 3]', 5), 2)
  is(await evaluate('[1, 2, 3, 4][t >> 1 & 3]', 6), 4)
})

test('floatbeat - classic sierpinski', async () => {
  is(await evaluate('t & (t >> 8)', 257), 1)
  is(await evaluate('t & (t >> 8)', 515), 2)
  is(await evaluate('t & (t >> 8)', 775), 3)
})

test('floatbeat - simple sine wave', async () => {
  const v64 = await evaluate('sin(t * PI / 128)', 64)
  ok(Math.abs(v64 - 1) < 0.0001)

  const v128 = await evaluate('sin(t * PI / 128)', 128)
  ok(Math.abs(v128) < 0.0001)
})

test('floatbeat - FM synthesis pattern', async () => {
  const fm = await evaluate('sin(t * PI / 128 + sin(t * PI / 256) * 2)', 64)
  ok(typeof fm === 'number' && !isNaN(fm))
})

test('floatbeat - pitch formula', async () => {
  const a440 = await evaluate('pow(2, 0 / 12) * 440')
  ok(Math.abs(a440 - 440) < 0.0001)

  const a880 = await evaluate('pow(2, 12 / 12) * 440')
  ok(Math.abs(a880 - 880) < 0.0001)
})

test('floatbeat - sequencer pattern', async () => {
  is(await evaluate('[0, 2, 4, 7][t >> 13 & 3]', 0), 0)
  is(await evaluate('[0, 2, 4, 7][t >> 13 & 3]', 8192), 2)
  is(await evaluate('[0, 2, 4, 7][t >> 13 & 3]', 16384), 4)
  is(await evaluate('[0, 2, 4, 7][t >> 13 & 3]', 24576), 7)
})

test('floatbeat - combined sequencer + pitch', async () => {
  const result = await evaluate(
    '(note = [0, 4, 7, 12][t >> 13 & 3], sin(t * pow(2, note / 12) * PI / 256))',
    8192
  )
  ok(typeof result === 'number' && !isNaN(result))
})

test('floatbeat - envelope pattern', async () => {
  const env0 = await evaluate('1 - (t % 8192) / 8192', 0)
  ok(Math.abs(env0 - 1) < 0.0001)

  const env4096 = await evaluate('1 - (t % 8192) / 8192', 4096)
  ok(Math.abs(env4096 - 0.5) < 0.0001)
})

test('floatbeat - real formula: simple chiptune', async () => {
  const result = await evaluate('t * ((t >> 12 | t >> 8) & 63 & t >> 4)', 8000)
  ok(typeof result === 'number' && !isNaN(result))
})

test('floatbeat - sustained instance for audio', async () => {
  const wasm = compile('sin(t * PI / 128)')
  const instance = await instantiate(wasm)

  const samples = []
  for (let i = 0; i < 256; i++) {
    samples.push(instance.run(i))
  }

  ok(Math.abs(samples[0]) < 0.01, 'starts near 0')
  ok(Math.abs(samples[64] - 1) < 0.01, 'peaks at 64')
  ok(Math.abs(samples[128]) < 0.01, 'crosses 0 at 128')
  ok(Math.abs(samples[192] + 1) < 0.01, 'troughs at 192')
})

test('floatbeat - random (imported)', async () => {
  const r1 = await evaluate('random()')
  ok(r1 >= 0 && r1 < 1, 'random in [0,1)')
})

test('floatbeat - fract function', async () => {
  const f1 = await evaluate('fract(3.7)')
  ok(Math.abs(f1 - 0.7) < 0.0001)

  const f2 = await evaluate('fract(5.25)')
  ok(Math.abs(f2 - 0.25) < 0.0001)
})

test('floatbeat - null and undefined (WASM GC ref.null)', async () => {
  is(await evaluate('null'), 0)
  is(await evaluate('undefined'), 0)
  is(await evaluate('null + 5'), 5)
  is(await evaluate('undefined + 5'), 5)
  is(await evaluate('null ?? 42'), 42)
  is(await evaluate('undefined ?? 42'), 42)
  is(await evaluate('5 ?? 42'), 5)
  is(await evaluate('0 ?? 42'), 0)
  is(await evaluate('!null'), 1)
  is(await evaluate('!undefined'), 1)
  is(await evaluate('null ? 1 : 2'), 2)
  is(await evaluate('undefined ? 1 : 2'), 2)
})

// ========== ARROW FUNCTIONS ==========

test('arrow functions - basic', async () => {
  const code = 'add = (a, b) => a + b'
  const wasm = compile(code)
  const { add } = await instantiate(wasm)
  is(add(2, 3), 5)
  is(add(-1, 1), 0)
  is(add(10.5, 0.5), 11)
})

test('arrow functions - single param', async () => {
  const code = 'double = x => x * 2'
  const wasm = compile(code)
  const { double } = await instantiate(wasm)
  is(double(5), 10)
  is(double(-3), -6)
})

test('arrow functions - multiple exports', async () => {
  const code = 'add = (a, b) => a + b, mul = (x, y) => x * y, neg = n => -n'
  const wasm = compile(code)
  const { add, mul, neg } = await instantiate(wasm)
  is(add(2, 3), 5)
  is(mul(4, 5), 20)
  is(neg(7), -7)
})

test('arrow functions - with Math', async () => {
  const code = 'dist = (x, y) => Math.sqrt(x*x + y*y)'
  const wasm = compile(code)
  const { dist } = await instantiate(wasm)
  is(dist(3, 4), 5)
  is(dist(0, 1), 1)
})

test('arrow functions - complex expression', async () => {
  const code = 'lerp = (a, b, t) => a + (b - a) * t'
  const wasm = compile(code)
  const { lerp } = await instantiate(wasm)
  is(lerp(0, 10, 0), 0)
  is(lerp(0, 10, 1), 10)
  is(lerp(0, 10, 0.5), 5)
  is(lerp(100, 200, 0.25), 125)
})

test('arrow functions - no params', async () => {
  const code = 'pi = () => PI'
  const wasm = compile(code)
  const { pi } = await instantiate(wasm)
  ok(Math.abs(pi() - Math.PI) < 0.0001)
})

test('arrow functions - trig', async () => {
  const code = 'wave = (t, freq) => sin(t * freq * PI * 2)'
  const wasm = compile(code)
  const { wave } = await instantiate(wasm)
  ok(Math.abs(wave(0, 1)) < 0.0001)  // sin(0) = 0
  ok(Math.abs(wave(0.25, 1) - 1) < 0.0001)  // sin(π/2) = 1
})

test('arrow functions - inter-function calls', async () => {
  const code = `
    double = x => x * 2,
    triple = x => x * 3,
    sixfold = x => double(triple(x))
  `
  const wasm = compile(code)
  const { double, triple, sixfold } = await instantiate(wasm)
  is(double(5), 10)
  is(triple(5), 15)
  is(sixfold(5), 30)
})

test('arrow functions - synth example', async () => {
  const code = `
    osc = (t, freq) => sin(t * freq * PI * 2),
    env = (t, attack, decay) => t < attack ? t / attack : exp(-(t - attack) / decay),
    synth = (t, freq, attack, decay) => osc(t, freq) * env(t, attack, decay)
  `
  const wasm = compile(code)
  const { synth, osc, env } = await instantiate(wasm)
  ok(Math.abs(osc(0.25, 1) - 1) < 0.0001)  // sin(π/2) = 1
  ok(Math.abs(env(0.005, 0.01, 0.5) - 0.5) < 0.0001)  // half attack
  is(typeof synth(0.1, 440, 0.01, 0.5), 'number')
})

test('arrow functions - module-level constants', async () => {
  const code = 'scale = 2, offset = 100, linear = x => x * scale + offset'
  const wasm = compile(code)
  const { linear } = await instantiate(wasm)
  is(linear(0), 100)
  is(linear(5), 110)
  is(linear(10), 120)
})

test('arrow functions - PI constant in function', async () => {
  const code = 'tau = PI, circle = r => tau * 2 * r'
  const wasm = compile(code)
  const { circle } = await instantiate(wasm)
  ok(Math.abs(circle(1) - Math.PI * 2) < 0.0001)
})
