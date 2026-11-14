// The local rewrites of WAT: programs whose rewrite answered wrong, each against Node at the
// configurations it was wrong at (their classes' populations: test/rules-population.js).
import test from 'tst'
import { agree } from './util.js'

const CONFIGS = [false, 2, 'size', 'speed']

test('rules: two shifts left merge with each count taken mod 32', () => {
  // (x << -1) << 1 is (x << 31) << 1, 0 at x = 1; the counts summed raw were 0, a shift by nothing
  const src = 'export let f = (x) => { x = x | 0; return ((x << -1) << 1) | 0 }'
  for (const optimize of CONFIGS) for (const x of [1, -1, 3]) agree(src, 'f', [x], { optimize })
  const src2 = 'export let f = (x) => { x = x | 0; return ((x << 2) << -1) | 0 }'
  for (const optimize of CONFIGS) agree(src2, 'f', [5], { optimize })
})

test('rules: a Boolean added to -0 gives +0', () => {
  // -0 + (a < b) is +0 where the test fails; the speed tier's select kept the -0
  const src = 'export let f = (x, a, b) => { a = a | 0; b = b | 0; return x + (a < b) }'
  for (const optimize of CONFIGS) for (const args of [[-0, 1, 0], [-0, 0, 1], [0, 1, 0]]) agree(src, 'f', args, { optimize })
})
