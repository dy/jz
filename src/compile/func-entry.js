import { ctx } from '../ctx.js'
import { enterActiveFunction } from './active-function.js'
import { nullExpr } from '../ir.js'
import { VAL, updateRep } from '../reps.js'

// A binding the summary names one exact shape for takes it: the slot reads
// and stores need the layout. A parameter the call lattice already typed
// OBJECT (a narrowed pointer) and a declared local whose initializer is not
// a literal (a recycled record, a conditional) are the same case.
export function seedSummaryShape(name, summary) {
  const sid = summary?.sidOf(name)
  if (sid == null) return false
  const rep = ctx.func.localReps?.get(name)
  if (rep?.schemaId == null && (rep?.val == null || rep.val === VAL.OBJECT)) updateRep(name, { schemaId: sid, val: VAL.OBJECT })
  return true
}

export function seedSummaryLocals(summary) {
  for (const name of ctx.func.locals.keys()) seedSummaryShape(name, summary)
}

// Direct and closure bodies consume the same settled call-site facts. Keep
// their boxed ABI; this publishes value/layout knowledge, not a new carrier.
export function seedSummaryParam(name, summary) {
  if (!summary) return
  if (seedSummaryShape(name, summary)) return
  const rep = ctx.func.localReps?.get(name)
  const ctor = summary.typedCtorOf(name)
  if (rep?.val) return
  const val = summary.valOf(name)
  if (ctor) {
    (ctx.func.typedElem ||= new Map()).set(name, ctor)
    updateRep(name, { val: VAL.TYPED })
  }
  else if (val === VAL.NUMBER || val === VAL.ARRAY || val === VAL.STRING) updateRep(name, { val })
}

// Replace the complete active-function authority at a real function boundary.
// Top-level funcs start `uniq` at 0; closures pass a higher base so their
// synthetic labels cannot collide with the displaced parent frame.
export function enterFunc(sig, body, options = {}) {
  return enterActiveFunction(ctx, { sig, body, ...options })
}

// Allocate + null-init a heap cell for every boxed local that isn't seeded
// from an incoming param/capture value. Registers the cell as an i32 local
// and marks the name preboxed; `isSeeded(name)` skips the already-seeded.
export function emitPreboxedLocalInits(isSeeded) {
  const inits = [], names = []
  for (const [name, cell] of ctx.func.boxed) {
    if (isSeeded(name)) continue
    ctx.func.locals.set(cell, 'i32')
    ;(ctx.func.preboxed ??= new Set()).add(name)
    names.push(name)
    inits.push(
      ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
      ['f64.store', ['local.get', `$${cell}`], nullExpr()])
  }
  inits.names = names
  return inits
}

const mentions = (n, name) => {
  if (typeof n === 'string') return n === name
  if (!Array.isArray(n)) return false
  for (let i = 1; i < n.length; i++) if (mentions(n[i], name)) return true
  return false
}

// Descend only through blocks and a single conditional arm containing EVERY
// reference. Never move the prologue allocation through a loop; its existing
// per-iteration capture handling owns backedges. Multiple statements/arms keep
// their common dominating allocation.
const preboxPoint = (body, name) => {
  if (!Array.isArray(body) || body[0] !== '{}' && body[0] !== ';') return null
  const inner = body[0] === ';' ? body : body[1], list = Array.isArray(inner) && inner[0] === ';'
  let at = null, single = true
  for (let i = list ? 1 : 0; i < (list ? inner.length : 1); i++) {
    const stmt = list ? inner[i] : inner
    if (!mentions(stmt, name)) continue
    if (at !== null) { single = false; break }
    at = stmt
  }
  if (single && Array.isArray(at)) {
    if (at[0] === '{}' || at[0] === ';') return preboxPoint(at, name) || at
    if (at[0] === 'if' && !mentions(at[1], name)) {
      const yes = mentions(at[2], name), no = mentions(at[3], name)
      if (yes !== no) return preboxPoint(at[yes ? 2 : 3], name) || at
    }
  }
  return at
}

/** Place each cell before its first dominating use, including a conditional
 * block when no other path references it. Expression bodies retain the entry
 * allocation. emitBlockBody consumes the per-statement initialization map. */
export function placePreboxedLocalInits(inits, body) {
  if (!inits.length) return inits
  const entry = []
  for (let i = 0; i < inits.names.length; i++) {
    const at = preboxPoint(body, inits.names[i])
    let dest = entry
    if (at !== null) {
      const points = ctx.func.preboxInits ??= new Map()
      dest = points.get(at)
      if (!dest) points.set(at, dest = [])
    }
    dest.push(inits[i * 2], inits[i * 2 + 1])
  }
  return entry
}
