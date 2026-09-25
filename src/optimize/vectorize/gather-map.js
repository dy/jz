// Partial vectorization of a gather map: keep address generation, checked
// reads and scalar recurrences in iteration order; pack their results, then
// lift the pure arithmetic suffix. Distinct owned parameters prove that
// delaying the first output store cannot change the second iteration's reads.
import { cloneNode, walkAst } from '../../ast.js'
import { collectWrites, isI32Const, isLocalGet, laneAccess, matchLaneAddr } from './addr-model.js'
import { isProfitable } from './cost-model.js'
import { LANE_PURE, LOAD_OPS } from './lane-tables.js'
import { liftCtx, liftStmt } from './lift.js'
import { simdLoop } from './scaffold.js'

export function tryGatherMap(bl, fnLocals, freshIdRef, distinct) {
  if (!bl || !distinct?.size || bl.hasGlobalSet) return null
  const { body, incVar, bound, boundLocal, writes, outsideReads } = bl
  if (bl.exitInfo && bl.loopNode[2][2][1][0] !== 'i32.lt_s') return null
  if (!boundLocal && !isI32Const(bound) || boundLocal && writes.has(boundLocal)) return null
  const storeAt = body.findIndex(s => s[0] === 'f64.store' && s.length === 3)
  if (storeAt < 0) return null
  const store = body[storeAt], addr = matchLaneAddr(store[1], incVar)
  if (!addr || addr.strideLog2 !== 3 || addr.pixelStride > 1 || !isLocalGet(addr.base) ||
      !distinct.has(addr.base[1]) || writes.has(addr.base[1])) return null

  const floatExpr = n => Array.isArray(n) && (
    n[0] === 'f64.const' || n[0] === 'local.get' && fnLocals.get(n[1]) === 'f64' ||
    LANE_PURE.f64.has(n[0]) && n.slice(1).every(floatExpr))
  if (!floatExpr(store[2])) return null
  let start = storeAt
  while (start > 0) {
    const s = body[start - 1]
    if (s[0] !== 'local.set' || fnLocals.get(s[1]) !== 'f64' || !floatExpr(s[2])) break
    start--
  }
  const prefix = body.slice(0, start), suffix = body.slice(start, storeAt + 1), tail = body.slice(storeAt + 1)
  if (!prefix.length) return null
  const vectorWrites = new Set()
  for (const s of suffix) collectWrites(s, vectorWrites)
  for (const name of vectorWrites)
    if (laneAccess(suffix, name, outsideReads) !== 'write') return null

  // The scalar part may contain checked loads and local updates, but cannot
  // observe a delayed vector local or store, leave the iteration, call code,
  // trap in scalar arithmetic, or write the exit counter. Unknown effects
  // decline. Memory accesses must name a different proven-owned parameter.
  let safe = true, loads = 0
  const scalar = n => {
    const op = n[0]
    if (op === 'local.get' || op === 'local.set' || op === 'local.tee') {
      if (vectorWrites.has(n[1]) || op !== 'local.get' && (n[1] === incVar || distinct.has(n[1]))) safe = false
    } else if (LOAD_OPS[op]) {
      const a = n[n.length - 1]
      if (a?.[0] !== 'i32.add' || !isLocalGet(a[1]) ||
          !distinct.has(a[1][1]) || a[1][1] === addr.base[1] || writes.has(a[1][1])) safe = false
      loads++
    } else if (!['block', 'result', 'if', 'then', 'else', 'select', 'drop'].includes(op) &&
        !/^(?:i32|i64|f32|f64)\.(?:const|add|sub|mul|and|or|xor|shl|shr_s|shr_u|eqz|eq|ne|lt_s|lt_u|gt_s|gt_u|le_s|le_u|ge_s|ge_u|lt|gt|le|ge|neg|abs|sqrt|min|max|ceil|floor|trunc|nearest|copysign|convert_i32_s|convert_i32_u|promote_f32|demote_f64|trunc_sat_f64_s|trunc_sat_f64_u|wrap_i64|extend_i32_s|extend_i32_u|reinterpret_i64|reinterpret_f64)$/.test(op)) safe = false
  }
  for (const s of [...prefix, ...tail]) walkAst(s, { enter: scalar })
  if (!safe || !loads) return null

  const inputs = new Set(), localKind = new Map()
  for (const s of suffix) walkAst(s, { enter: n => {
    if (n[0] !== 'local.get' || n[1] === incVar || n[1] === addr.base[1]) return
    const name = n[1]
    if (vectorWrites.has(name)) localKind.set(name, 'lane')
    else if (writes.has(name)) { inputs.add(name); localKind.set(name, 'lane') }
    else localKind.set(name, 'invariant')
  } })
  for (const name of vectorWrites) localKind.set(name, 'lane')
  const laned = new Map(), extra = []
  for (const name of inputs) laned.set(name, `$__gather${freshIdRef.next++}`)
  const ctx = liftCtx('f64', incVar, localKind, freshIdRef, fnLocals, laned, extra)
  const lifted = suffix.map(s => liftStmt(s, ctx))
  if (ctx.fail || lifted.some(s => !s || s[0] === '__seq__')) return null

  const packed = []
  for (let lane = 0; lane < 2; lane++) {
    // Advance the exit counter only at the end of the pair, so the vector
    // store retains its first address. All other recurrences run unchanged,
    // including each separately rounded floating addition.
    const at = n => !Array.isArray(n) ? n : lane && isLocalGet(n, incVar)
      ? ['i32.add', cloneNode(n), ['i32.const', lane]] : n.map(at)
    packed.push(...prefix.map(at))
    for (const name of inputs) packed.push(['local.set', laned.get(name), lane
      ? ['f64x2.replace_lane', 1, ['local.get', laned.get(name)], ['local.get', name]]
      : ['f64x2.splat', ['local.get', name]]])
    packed.push(...tail.map(at))
  }
  packed.push(...lifted)
  if (!isProfitable(body, packed, 2)) return null
  const id = freshIdRef.next++, limit = `$__simd_bound${id}`
  const boundSetup = ['local.set', limit, ['i32.add', ['local.get', incVar],
    ['i32.and', ['i32.sub', cloneNode(bound), ['local.get', incVar]], ['i32.const', -2]]]]
  const strip = simdLoop(id, incVar, limit, [...packed,
    ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', 2]]]])
  return {
    wrapper: ['block', ...bl.preamble.map(cloneNode), boundSetup, strip, bl.blockNode],
    newLocalDecls: [['local', limit, 'i32'], ...[...laned.values()].map(n => ['local', n, 'v128']), ...extra],
  }
}
