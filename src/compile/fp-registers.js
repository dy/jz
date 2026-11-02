/**
 * How many floating-point values a loop may keep in registers.
 *
 * A Number a loop carries (a filter's state) or holds unchanged (a coefficient
 * read before it) is live from the loop's head to its end. Where more are live
 * than the engine has registers, V8 spills to fit, and its allocator spills the
 * values the loop carries as readily as the ones it only reads: each spilled
 * carried value is a store and a reload on the chain every iteration waits on
 * (sosfilter's eight sections held 40 coefficients beside 16 carried values: 64
 * spill moves an iteration on arm64, where the loop then ran 1.16× the one that
 * read the coefficients where it used them). A value the loop only reads costs
 * a load where it is used, off every chain. So a pass that would hold such
 * values for a loop holds them while all fit, and otherwise the ones read most,
 * as many as leave room; the rest are read where the loop reads them.
 *
 * The registers are the engine's with the fewest: V8 allocates xmm0-xmm14 on
 * x64 (xmm15 is its scratch; src/codegen/x64/register-x64.h, V8 14.1) and
 * d0-d14, d16-d28 on arm64. One module runs on both, so the x64 count binds.
 * Two of them stay for the iteration's own values (a cascade's input and a
 * stage's output).
 *
 * @module compile/fp-registers
 */

export const FP_REGISTERS = 15
export const FP_RESERVE = 2

/** Of the `optional` values a loop could hold beside `carried` others live through it, the ones it
 *  holds: all where they fit, else the most used (`uses(v)`, first seen first among equals), as
 *  many as leave the reserve free. */
export function fitting(optional, carried, uses) {
  if (carried + optional.length <= FP_REGISTERS) return new Set(optional)
  const room = Math.max(0, FP_REGISTERS - FP_RESERVE - carried)
  return new Set(optional.map((v, i) => [v, uses(v), i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).slice(0, room).map(([v]) => v))
}
