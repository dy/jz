import { LANE_INFO } from './lane-tables.js'
import { isArr } from './node-utils.js'

// ---- Lifter ----------------------------------------------------------------

// Returns the v128 lane-local NAME (a string) for `name`, allocating once. We store the bare
// string — NOT a `{laneName}` object — because a schema-object read back through the Map in a
// DIFFERENT function returns undefined under self-compile. Takes `newLanedLocals` directly
// (not ctx) so callers don't need to pass the full ctx object to a helper at call-depth 2.
export function getOrAllocLanedLocal(name, newLanedLocals) {
  let laneName = newLanedLocals.get(name)
  if (!laneName) {
    laneName = `${name}__v`
    newLanedLocals.set(name, laneName)
  }
  return laneName
}

// AoS de-interleave gather/scatter (ctx.aosPixelStride P > 1). The SIMD block steps the IV
// by `lanes`, so a scalar address `A` points at pixel i, channel c; pixel i+1's same channel
// is P elements = P*elemSize bytes further — reachable as a static load/store `offset`.
// aosAddrPair yields two address forms that evaluate `A` exactly ONCE (teeing when needed).
export function aosAddrPair(addr, ctx) {
  if (isArr(addr) && addr[0] === 'local.get') return { a0: addr, a1: addr }               // live local — read twice, free
  if (isArr(addr) && addr[0] === 'local.tee' && addr.length === 3) return { a0: addr, a1: ['local.get', addr[1]] }
  const g = `$__aosa${ctx.freshIdRef.next++}`                                              // bare expr — tee into a scratch
  ctx.extraLocals.push(['local', g, 'i32'])
  return { a0: ['local.tee', g, addr], a1: ['local.get', g] }
}
const aosLoad = (off, addr) => off ? ['f64.load', `offset=${off}`, addr] : ['f64.load', addr]
export const aosStore = (off, addr, val) => off ? ['f64.store', `offset=${off}`, addr, val] : ['f64.store', addr, val]

// A scalar `(f64.load [offset=X] A)` → the f64x2 [pixel i chan, pixel i+1 chan]. Bit-exact:
// the two lanes are the exact bytes the two scalar iterations read.
export function aosGather(expr, ctx) {
  const delta = ctx.aosPixelStride * LANE_INFO.f64.stride
  let baseOff = 0, addr
  if (typeof expr[1] === 'string' && expr[1].startsWith('offset=')) { baseOff = parseInt(expr[1].slice(7)) || 0; addr = expr[2] }
  else addr = expr[1]
  const { a0, a1 } = aosAddrPair(addr, ctx)
  return ['f64x2.replace_lane', 1, ['f64x2.splat', aosLoad(baseOff, a0)], aosLoad(baseOff + delta, a1)]
}
