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
  const inits = []
  for (const [name, cell] of ctx.func.boxed) {
    if (isSeeded(name)) continue
    ctx.func.locals.set(cell, 'i32')
    ctx.func.preboxed.add(name)
    inits.push(
      ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
      ['f64.store', ['local.get', `$${cell}`], nullExpr()])
  }
  return inits
}
