/**
 * A signed division or remainder of a value no less than zero by one greater
 * than zero is the unsigned one: both truncate the same quotient, and the
 * remainder takes the dividend's sign, which is none. An engine divides an
 * unsigned word by a constant with a multiply-high and a shift; the signed
 * division adds the correction a negative quotient needs (V8: one instruction
 * more on arm64 and on x64, per division), and by a power of two it is a shift
 * or a mask alone where the signed one fixes the rounding first. A box blur's
 * channel sums, read out of their lanes (`i16x8.extract_lane_u`) and divided by
 * the window, are such dividends; so is a counter's remainder (`i % 9` with
 * `i >= 0`), a byte (`load8_u`), a masked or right-shifted word.
 *
 * The intervals are the function's own (optimize/int-range.js), read once a
 * function holds a signed division whose divisor may be positive; a dividend or
 * divisor they do not bound stays signed. It runs after watr, on every division
 * the passes before it emitted, the vectorizer's epilogues among them.
 *
 * @module optimize/unsigned-div
 */
import { intRanges } from './int-range.js'

const isArr = Array.isArray
const UNSIGNED = { 'i32.div_s': 'i32.div_u', 'i32.rem_s': 'i32.rem_u', 'i64.div_s': 'i64.div_u', 'i64.rem_s': 'i64.rem_u' }
const HEAD = new Set(['export', 'type', 'param', 'result', 'local'])
// (a negative or zero literal divisor never qualifies: no interval needed for it)
const notPositive = (d) => isArr(d) && (d[0] === 'i32.const' || d[0] === 'i64.const') && !(Number(d[1]) > 0)

/** Make each signed division or remainder of `module`'s functions whose operands the intervals
 *  prove non-negative and positive the unsigned one. */
export function unsignedDivision(module) {
  if (!isArr(module)) return module
  for (const fn of module) {
    if (!isArr(fn) || fn[0] !== 'func') continue
    const sites = []
    const find = (n) => {
      for (let i = 1; i < n.length; i++) if (isArr(n[i])) find(n[i])
      if (UNSIGNED[n[0]] && n.length === 3 && isArr(n[1]) && !notPositive(n[2])) sites.push(n)
    }
    find(fn)
    if (!sites.length) continue
    let k = 2
    while (isArr(fn[k]) && HEAD.has(fn[k][0])) k++
    const facts = intRanges(fn, k)
    if (!facts) continue
    for (const n of sites) {
      const x = facts.av.get(n[1]), y = facts.av.get(n[2])
      if (x && y && !x.of && !y.of && !x.nan && !y.nan && x.lo >= 0 && y.lo > 0) n[0] = UNSIGNED[n[0]]
    }
  }
  return module
}
