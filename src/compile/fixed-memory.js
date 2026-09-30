/** Fixed-memory exports: inferred scratch lifetimes and a final-code proof.
 * Scratch never escapes its binding. Owned module storage is reusable because
 * every selected call graph is closed, non-recursive and free of host calls.
 * This is a memory contract, not a wall-clock or host-marshalling guarantee.
 */
import { ctx, err } from '../ctx.js'
import { callArgs, walkAst, stmtList, refsName } from '../ast.js'
import { constIntExpr } from '../static.js'
import { typedElemCtor } from '../type.js'
import { valTypeOf } from '../kind.js'
import { VAL } from '../reps.js'
import { TYPED_ELEM_CODE } from '../../layout.js'
import { exportNamesOf } from './func-exports.js'
import { runtimeGraph } from './func-inspect.js'
import {
  scanBindingUses, USE, BINDING_USE_DECLS, BINDING_USE_INIT, BINDING_USE_USES,
  BINDING_USE_KIND, BINDING_USE_KEY, BINDING_USE_OP,
} from './analyze-scans.js'

export function configureFixedMemory(names) {
  if (names == null) return
  if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !n.length))
    err('memory.fixed must be a non-empty array of export names')
  if (ctx.memory.shared) err('memory.fixed requires module-owned, unshared memory')
  ctx.memory.fixed = new Set(names)
  // A certification must not depend on a runtime reachability walk. Keep the
  // ordinary frame/loop rewinds for general exports in the same module.
  ctx.transform.optimize.arenaReach = false
}

const selected = func => {
  if (!ctx.memory.fixedFuncs) {
    const selected = ctx.memory.fixedFuncs = new Set(), pending = []
    for (const f of ctx.funcs.list) if (exportNamesOf(f.name).some(n => ctx.memory.fixed.has(n))) {
      pending.push(f)
      for (const v of f.boundaryVariants || []) pending.push(v.func)
    }
    while (pending.length) {
      const f = pending.pop()
      if (!f || selected.has(f.name)) continue
      selected.add(f.name)
      for (const name of f.frame?.callees || []) pending.push(ctx.funcs.map.get(name))
    }
  }
  return ctx.memory.fixedFuncs.has(func.name)
}

/** Run against the installed function facts, after all source rewrites. */
export function planFixedScratch(func) {
  if (!ctx.memory.fixed || !selected(func)) return
  const candidates = new Map()
  for (const [name, binding] of scanBindingUses(func.body)) {
    const init = binding[BINDING_USE_INIT], args = callArgs(init)
    const ctor = typedElemCtor(init)
    if (binding[BINDING_USE_DECLS] !== 1 || ctor == null || TYPED_ELEM_CODE[ctor.slice(4)] == null || args?.length !== 1) continue
    const len = constIntExpr(args[0])
    if (len == null || len < 0) continue
    // Buffer views, identity observations, aliases, captures, method calls and
    // reassignment all retain their normal allocation and fail certification.
    if (!binding[BINDING_USE_USES].every(u =>
      u[BINDING_USE_KIND] === USE.MEMBER_R && u[BINDING_USE_KEY] === 'length' ||
      (u[BINDING_USE_KIND] === USE.MEMBER_R || u[BINDING_USE_KIND] === USE.MEMBER_W) && u[BINDING_USE_OP] === '[]')) continue
    candidates.set(name, { init, len, key: `${ctor}:${len}` })
  }
  // An unknown computed key could be "buffer", exposing storage identity.
  walkAst(func.body, { enter: n => {
    if (n[0] === '=>') return false
    if (n[0] === '[]' && candidates.has(n[1]) && valTypeOf(n[2]) !== VAL.NUMBER)
      candidates.delete(n[1])
  } })
  // Whole top-level statements are the lifetime units: a loop or branch owns
  // its full span, so a back edge cannot reuse storage still read next round.
  // Equal layouts with disjoint spans share a slot, just like stack locals.
  const statements = stmtList(func.body), slots = [], placements = new Map()
  const spans = []
  for (const [name, candidate] of candidates) {
    let first = -1, last = -1
    for (let i = 0; i < statements.length; i++) if (refsName(statements[i], name)) {
      if (first < 0) first = i
      last = i
    }
    if (first >= 0) spans.push({ ...candidate, first, last })
  }
  spans.sort((a, b) => a.first - b.first)
  for (const span of spans) {
    let slot = slots.find(s => s.key === span.key && s.last < span.first)
    if (!slot) { slot = { key: span.key, len: span.len, last: span.last, owner: `$${func.name}` }; slots.push(slot) }
    slot.last = span.last
    placements.set(span.init, slot)
  }
  ctx.memory.scratch.set(func.sig, placements)
}

const prover = (records, allocation) => {
  const safe = new Set(), active = new Set()
  const visit = (name, path) => {
    if (active.has(name)) return `${path.join(' → ')}: recursive call`
    if (safe.has(name)) return null
    const rec = records.get(name)
    if (!rec || rec.unknown) return `${path.join(' → ')}: host or unresolved call`
    if (allocation && rec.allocation) return `${path.join(' → ')}: heap allocation or memory growth`
    if (name === '$__survive' || name.startsWith('$__reach')) return `${path.join(' → ')}: runtime reachability walk`
    active.add(name)
    for (const callee of rec.calls) {
      const reason = visit(callee, [...path, callee])
      if (reason) return reason
    }
    active.delete(name)
    safe.add(name)
    return null
  }
  return visit
}

/** Before Wasm inlining can erase a scratch owner's identity, prove its storage
 * safe in EVERY call context, including callers outside the selected exports. */
export function verifyFixedScratch(module) {
  if (!ctx.memory.fixed) return
  const { records } = runtimeGraph(module, false), visit = prover(records, false)
  for (const placements of ctx.memory.scratch.values()) for (const slot of placements.values()) {
    if (slot.offset == null || !records.has(slot.owner)) continue // no emitted storage/body
    const reason = visit(slot.owner, [slot.owner])
    if (reason) err(`memory.fixed cannot certify ${reason}`)
  }
}

/** Validate final emitted code, including all helpers and boundary variants. */
export function verifyFixedMemory(module) {
  if (!ctx.memory.fixed) return
  const memory = module.find(n => Array.isArray(n) && n[0] === 'memory')
  const limits = memory?.filter(n => typeof n === 'number')
  if (limits?.length > 1 && limits[0] > limits[1])
    err(`memory.fixed needs ${limits[0]} initial pages, exceeding memory.maximum (${limits[1]})`)
  const { exports, records } = runtimeGraph(module, false)
  const targets = new Map(exports), visit = prover(records, true)
  const names = new Set(ctx.memory.fixed)
  for (const f of ctx.funcs.list) if (exportNamesOf(f.name).some(n => names.has(n)))
    for (const v of f.boundaryVariants || []) names.add(v.exportName)
  for (const name of names) {
    const target = targets.get(name)
    if (!target) err(`memory.fixed: '${name}' is not a function export`)
    const reason = visit(target, [name])
    if (reason) err(`memory.fixed cannot certify ${reason}`)
  }
}
