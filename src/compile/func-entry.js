import { ctx } from '../ctx.js'
import { enterActiveFunction } from './active-function.js'
import { nullExpr } from '../ir.js'

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

const mentionsAny = (n, names) => {
  if (typeof n === 'string') return names.includes(n)
  if (!Array.isArray(n)) return false
  for (let i = 1; i < n.length; i++) if (mentionsAny(n[i], names)) return true
  return false
}

/**
 * Place the preboxed cells' allocation before the first statement of a block
 * body that mentions one of them (a declaration, a closure capturing it, a
 * read), rather than at entry: a body that returns before its closures exist
 * (a cache hit) then allocates nothing. emitBlockBody emits them there
 * (`ctx.func.preboxAt`); the entry prologue keeps them when no statement
 * mentions one, or for an expression body.
 * @returns the inits the entry prologue still owns
 */
export function placePreboxedLocalInits(inits, body) {
  if (!inits.length || !(Array.isArray(body) && body[0] === '{}')) return inits
  const inner = body[1]
  const stmts = Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : [inner]
  const at = stmts.find(s => s != null && typeof s !== 'number' && mentionsAny(s, inits.names))
  if (at === undefined) return inits
  ctx.func.preboxAt = at
  ctx.func.preboxInits = inits
  return []
}
