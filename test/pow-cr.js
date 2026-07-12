/**
 * Correctly-rounded pow — differential gate against authoritative vectors.
 *
 * test/vectors/pow-cr.txt: 5152 lines of `xbits ybits resultbits` (big-endian
 * f64 hex), generated with mpmath 1.4.1 at 200-bit precision (round-to-nearest
 * on the final float conversion), inputs STRICTLY coerced to doubles before
 * evaluation. Classes: colorpq's real exponents (PQ nv=2610/16384,
 * p=1.7·2523/32, their inverses, sRGB 2.4/±) over its value range; general
 * log-spaced grids across ±extremes; 3k random (x,y) pairs; 400 MINED hard
 * cases (exact result nearest to a rounding boundary out of 30k candidates).
 * Regeneration recipe lives in .work/todo.md (CR-pow session).
 *
 * Baselines at bake time: V8 Math.pow misses 3/5152 (0.058%, all in the mined
 * tail); jz runtime $math.pow missed 424 (8.2%); jz const-exponent fold missed
 * 194/827 (23.5%). The gate demands ZERO on both jz paths — correctly rounded
 * is unique, so this also pins fold==runtime path consistency (self-host
 * byte-parity depends on it).
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import jz from '../index.js'

const DIR = dirname(fileURLToPath(import.meta.url))
const NV = 2610 / 16384, P = 1.7 * 2523 / 32

test('pow: correctly rounded on the authoritative vector set (runtime + fold paths)', () => {
  // crPow:true — the CORE-MATH-class kernel is opt-in (default build keeps the old fdlibm
  // fold/kernel bit-for-bit for speed; see the crPow/approxPow comment above emitPow in
  // module/math.js). This gate exists to hold the correctly-rounded path to zero misroundings,
  // so it must compile its probes with the flag on — approxPow stays off (its default), so
  // f24's k/5 exponent still routes through the correctly-rounded $math.pow_fold, not fifthroot.
  const m = jz(`
    export let rt = (x, y) => x ** y
    export let fnv = (x) => x ** ${NV}
    export let fp = (x) => x ** ${P}
    export let f24 = (x) => x ** 2.4
    export let fi24 = (x) => x ** ${1 / 2.4}
  `, { optimize: { crPow: true } })
  const { rt, fnv, fp, f24, fi24 } = m.exports
  const buf = new Float64Array(1), u64 = new BigUint64Array(buf.buffer)
  const fromBits = (h) => { u64[0] = BigInt('0x' + h); return buf[0] }
  const toBits = (x) => { buf[0] = x; return u64[0].toString(16).padStart(16, '0') }
  const foldFns = { [toBits(NV)]: fnv, [toBits(P)]: fp, [toBits(2.4)]: f24, [toBits(1 / 2.4)]: fi24 }
  let rtMis = 0, foldMis = 0, foldTotal = 0, total = 0, firstRt = null, firstFold = null
  for (const line of readFileSync(join(DIR, 'vectors/pow-cr.txt'), 'utf8').trim().split('\n')) {
    const [xh, yh, rh] = line.split(' ')
    const x = fromBits(xh), y = fromBits(yh)
    total++
    if (toBits(rt(x, y)) !== rh) { rtMis++; firstRt ??= `x=${xh} y=${yh} want=${rh} got=${toBits(rt(x, y))}` }
    const ff = foldFns[yh]
    if (ff) { foldTotal++; if (toBits(ff(x)) !== rh) { foldMis++; firstFold ??= `x=${xh} y=${yh} want=${rh} got=${toBits(ff(x))}` } }
  }
  is(total, 5152, 'vector count')
  is(rtMis, 0, `runtime $math.pow misrounds (first: ${firstRt})`)
  is(foldMis, 0, `const-exponent fold misrounds of ${foldTotal} (first: ${firstFold})`)
})
