import test from 'tst'
import { compile, evaluate, instantiate } from '../index.js'

// Floatbeat/Bytebeat Test Suite

test('floatbeat - t variable', async t => {
  t.equal(await evaluate('t', 0), 0)
  t.equal(await evaluate('t', 100), 100)
  t.equal(await evaluate('t + 1', 5), 6)
  t.equal(await evaluate('t * 2', 10), 20)
  t.equal(await evaluate('t / 4', 100), 25)
})

test('floatbeat - constants', async t => {
  const pi = await evaluate('PI')
  t.ok(Math.abs(pi - Math.PI) < 0.0001, 'PI should match')

  const e = await evaluate('E')
  t.ok(Math.abs(e - Math.E) < 0.0001, 'E should match')
})

test('floatbeat - native WASM math', async t => {
  t.equal(await evaluate('sqrt(4)'), 2)
  t.equal(await evaluate('sqrt(9)'), 3)
  t.equal(await evaluate('abs(-5)'), 5)
  t.equal(await evaluate('abs(3)'), 3)
  t.equal(await evaluate('floor(3.7)'), 3)
  t.equal(await evaluate('floor(-1.1)'), -2)
  t.equal(await evaluate('ceil(3.2)'), 4)
  t.equal(await evaluate('ceil(-1.9)'), -1)
  t.equal(await evaluate('trunc(3.9)'), 3)
  t.equal(await evaluate('trunc(-3.9)'), -3)
  t.equal(await evaluate('int(3.9)'), 3) // alias for trunc
  t.equal(await evaluate('min(1, 2)'), 1)
  t.equal(await evaluate('max(1, 2)'), 2)
  t.equal(await evaluate('min(5, 3, 8)'), 3) // Note: min/max are binary in WASM
})

test('floatbeat - imported trig', async t => {
  const s0 = await evaluate('sin(0)')
  t.ok(Math.abs(s0) < 0.0001, 'sin(0) = 0')

  const s90 = await evaluate('sin(PI/2)')
  t.ok(Math.abs(s90 - 1) < 0.0001, 'sin(π/2) = 1')

  const c0 = await evaluate('cos(0)')
  t.ok(Math.abs(c0 - 1) < 0.0001, 'cos(0) = 1')

  const cpi = await evaluate('cos(PI)')
  t.ok(Math.abs(cpi + 1) < 0.0001, 'cos(π) = -1')

  const t0 = await evaluate('tan(0)')
  t.ok(Math.abs(t0) < 0.0001, 'tan(0) = 0')
})

test('floatbeat - inverse trig', async t => {
  const as = await evaluate('asin(1)')
  t.ok(Math.abs(as - Math.PI/2) < 0.0001, 'asin(1) = π/2')

  const ac = await evaluate('acos(0)')
  t.ok(Math.abs(ac - Math.PI/2) < 0.0001, 'acos(0) = π/2')

  const at = await evaluate('atan(1)')
  t.ok(Math.abs(at - Math.PI/4) < 0.0001, 'atan(1) = π/4')
})

test('floatbeat - hyperbolic', async t => {
  const sh = await evaluate('sinh(0)')
  t.ok(Math.abs(sh) < 0.0001, 'sinh(0) = 0')

  const ch = await evaluate('cosh(0)')
  t.ok(Math.abs(ch - 1) < 0.0001, 'cosh(0) = 1')

  const th = await evaluate('tanh(0)')
  t.ok(Math.abs(th) < 0.0001, 'tanh(0) = 0')
})

test('floatbeat - exp/log', async t => {
  const e1 = await evaluate('exp(1)')
  t.ok(Math.abs(e1 - Math.E) < 0.0001, 'exp(1) = e')

  const l1 = await evaluate('log(E)')
  t.ok(Math.abs(l1 - 1) < 0.0001, 'log(e) = 1')

  const l2 = await evaluate('log2(8)')
  t.ok(Math.abs(l2 - 3) < 0.0001, 'log2(8) = 3')

  const l10 = await evaluate('log10(100)')
  t.ok(Math.abs(l10 - 2) < 0.0001, 'log10(100) = 2')
})

test('floatbeat - pow', async t => {
  t.equal(await evaluate('pow(2, 3)'), 8)
  t.equal(await evaluate('2 ** 3'), 8)
  t.equal(await evaluate('pow(3, 2)'), 9)

  const p = await evaluate('pow(2, 0.5)')
  t.ok(Math.abs(p - Math.SQRT2) < 0.0001, 'pow(2, 0.5) = √2')
})

test('floatbeat - other math', async t => {
  const cb = await evaluate('cbrt(27)')
  t.ok(Math.abs(cb - 3) < 0.0001, 'cbrt(27) = 3')

  t.equal(await evaluate('sign(5)'), 1)
  t.equal(await evaluate('sign(-5)'), -1)
  t.equal(await evaluate('sign(0)'), 0)

  t.equal(await evaluate('round(3.4)'), 3)
  t.equal(await evaluate('round(3.6)'), 4)
})

test('floatbeat - variable bindings (comma expressions)', async t => {
  t.equal(await evaluate('(a = 5, a)'), 5)
  t.equal(await evaluate('(a = 3, b = 4, a + b)'), 7)
  t.equal(await evaluate('(x = 2, y = 3, x * y)'), 6)
  t.equal(await evaluate('(tune = 1.5, t * tune)', 100), 150)
})

test('floatbeat - arrays with WASM GC', async t => {
  // Simple array access
  t.equal(await evaluate('[10, 20, 30][0]'), 10)
  t.equal(await evaluate('[10, 20, 30][1]'), 20)
  t.equal(await evaluate('[10, 20, 30][2]'), 30)

  // Dynamic index
  t.equal(await evaluate('[5, 10, 15][t]', 1), 10)

  // Computed index with bitwise
  t.equal(await evaluate('[1, 2, 3, 4][t & 3]', 5), 2) // 5 & 3 = 1
  t.equal(await evaluate('[1, 2, 3, 4][t >> 1 & 3]', 6), 4) // 6 >> 1 = 3
})

test('floatbeat - classic sierpinski', async t => {
  // t & (t >> 8) - classic bytebeat
  // 257 & (257 >> 8) = 257 & 1 = 1
  // 515 & (515 >> 8) = 515 & 2 = 2 (515 = 0b1000000011)
  // 775 & (775 >> 8) = 775 & 3 = 3 (775 = 0b1100000111)
  t.equal(await evaluate('t & (t >> 8)', 257), 1)
  t.equal(await evaluate('t & (t >> 8)', 515), 2)
  t.equal(await evaluate('t & (t >> 8)', 775), 3)
})

test('floatbeat - simple sine wave', async t => {
  // sin(t * PI / 128) - basic oscillator
  const v64 = await evaluate('sin(t * PI / 128)', 64)  // sin(π/2) = 1
  t.ok(Math.abs(v64 - 1) < 0.0001)

  const v128 = await evaluate('sin(t * PI / 128)', 128)  // sin(π) = 0
  t.ok(Math.abs(v128) < 0.0001)
})

test('floatbeat - FM synthesis pattern', async t => {
  // sin(t * PI / 128 + sin(t * PI / 256) * 2)
  const fm = await evaluate('sin(t * PI / 128 + sin(t * PI / 256) * 2)', 64)
  t.ok(typeof fm === 'number' && !isNaN(fm))
})

test('floatbeat - pitch formula', async t => {
  // pow(2, note / 12) * baseFreq
  const a440 = await evaluate('pow(2, 0 / 12) * 440')
  t.ok(Math.abs(a440 - 440) < 0.0001)

  const a880 = await evaluate('pow(2, 12 / 12) * 440')  // octave up
  t.ok(Math.abs(a880 - 880) < 0.0001)
})

test('floatbeat - sequencer pattern', async t => {
  // [0, 2, 4, 7][t >> 13 & 3] - note sequence
  t.equal(await evaluate('[0, 2, 4, 7][t >> 13 & 3]', 0), 0)
  t.equal(await evaluate('[0, 2, 4, 7][t >> 13 & 3]', 8192), 2)
  t.equal(await evaluate('[0, 2, 4, 7][t >> 13 & 3]', 16384), 4)
  t.equal(await evaluate('[0, 2, 4, 7][t >> 13 & 3]', 24576), 7)
})

test('floatbeat - combined sequencer + pitch', async t => {
  // (note = [0, 4, 7, 12][t >> 13 & 3], sin(t * pow(2, note / 12) * PI / 256))
  const result = await evaluate(
    '(note = [0, 4, 7, 12][t >> 13 & 3], sin(t * pow(2, note / 12) * PI / 256))',
    8192
  )
  t.ok(typeof result === 'number' && !isNaN(result))
})

test('floatbeat - envelope pattern', async t => {
  // Decay envelope: 1 - (t % 8192) / 8192
  const env0 = await evaluate('1 - (t % 8192) / 8192', 0)
  t.ok(Math.abs(env0 - 1) < 0.0001)

  const env4096 = await evaluate('1 - (t % 8192) / 8192', 4096)
  t.ok(Math.abs(env4096 - 0.5) < 0.0001)
})

test('floatbeat - real formula: simple chiptune', async t => {
  // t * ((t >> 12 | t >> 8) & 63 & t >> 4)
  const result = await evaluate('t * ((t >> 12 | t >> 8) & 63 & t >> 4)', 8000)
  t.ok(typeof result === 'number' && !isNaN(result))
})

test('floatbeat - sustained instance for audio', async t => {
  // Compile once, run many times with different t values
  const wasm = compile('sin(t * PI / 128)')
  const instance = await instantiate(wasm)

  // Simulate audio buffer generation
  const samples = []
  for (let i = 0; i < 256; i++) {
    samples.push(instance.run(i))
  }

  // Verify it's a sine wave
  t.ok(Math.abs(samples[0]) < 0.01, 'starts near 0')
  t.ok(Math.abs(samples[64] - 1) < 0.01, 'peaks at 64')
  t.ok(Math.abs(samples[128]) < 0.01, 'crosses 0 at 128')
  t.ok(Math.abs(samples[192] + 1) < 0.01, 'troughs at 192')
})

test('floatbeat - random (imported)', async t => {
  const r1 = await evaluate('random()')
  const r2 = await evaluate('random()')
  t.ok(r1 >= 0 && r1 < 1, 'random in [0,1)')
  // Note: r1 !== r2 is probabilistically true but not guaranteed
})

test('floatbeat - fract function', async t => {
  const f1 = await evaluate('fract(3.7)')
  t.ok(Math.abs(f1 - 0.7) < 0.0001)

  const f2 = await evaluate('fract(5.25)')
  t.ok(Math.abs(f2 - 0.25) < 0.0001)
})
