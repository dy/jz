/**
 * Temp-local factories (mutate ctx.func.locals) + the block scaffolds built
 * directly around them (withTemp wraps temp()). Originally two adjacent
 * `=== section ===` blocks in ir.js; merged here since withTemp's only
 * dependency IS temp().
 *
 * @module ir/locals
 */

import { ctx } from '../ctx.js'
import { declareLocal, freshEmitId } from '../compile/active-function.js'
import { T } from '../ast.js'
import { typed } from './tag.js'

/** Backward-compatible name for the EmitFrame id authority. */
export function freshId(ctx) { return freshEmitId(ctx) }

/** Allocate a fresh local name with the given tag, registered as `type`. The
 *  selfhost compiler doesn't yet handle exported-const arrow factories returning
 *  closures, so the three temp() helpers stay as `function` declarations and
 *  delegate to this shared core. */
function freshLocal(type, tag) {
  let name
  do { name = `${T}${tag}${freshId(ctx)}` } while (ctx.func.locals.has(name))
  return declareLocal(ctx, name, type)
}

export function temp    (tag = '') { return freshLocal('f64', tag) }

export function tempI32 (tag = '') { return freshLocal('i32', tag) }

export function tempI64 (tag = '') { return freshLocal('i64', tag) }

// === IR scaffolds ===

/** Wrap a sequence of statements as a typed `(block (result <type>) …)`.
 *  Default result is `f64` (the value-type for most jz emissions).
 *  Shorthand for the `typed(['block', ['result', T], …stmts], T)` pattern that
 *  appears in nearly every emitter — keeps call sites focused on the body. */
export const block64 = (...stmts) => typed(['block', ['result', 'f64'], ...stmts], 'f64')

export const blockTyped = (type, ...stmts) => typed(['block', ['result', type], ...stmts], type)

/** Allocate an f64 temp, set it to `val`, run `body(name)` and yield its result.
 *  `body` may return either a single IR node (used as the block result) or an
 *  array of nodes whose last expression becomes the result. Eliminates the
 *  repetitive `const t = temp(); …['local.set', $t, val]; …['local.get', $t]`
 *  scaffold around tee-and-use patterns. */
export function withTemp(val, body, tag = '') {
  const t = temp(tag)
  const out = body(t)
  const tail = Array.isArray(out) && out.every(n => Array.isArray(n)) ? out : [out]
  return block64(['local.set', `$${t}`, val], ...tail)
}
