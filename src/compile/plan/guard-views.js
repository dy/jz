/**
 * A typed array a guard proves is read as that typed array. Past
 * `if (!(a instanceof Float32Array)) throw …` every path holds a Float32Array in
 * `a`, yet the binding itself is whatever reached it: an exported function's
 * parameter, a field, a call's result. Its kind was decided per read, at run
 * time, and a type test on a parameter withdrew the export's typed contract
 * (narrow/param-abi.js `paramNumericArrayLike`): the guard, the one statement
 * that names the type, cost the function its typing.
 *
 * Past the guard the pass binds a view of the proven constructor over the same
 * storage, and the statements that follow read the view:
 *
 *     if (!(a instanceof Float32Array)) throw new TypeError('…')
 *     const a' = new Float32Array(a.buffer, a.byteOffset, a.length)
 *     … a'[i] … a'.length … weld(a) …
 *
 * A declaration of known constructor is what every typed analysis already
 * follows (element width, bounds versioning, vectorization), so the guard
 * needs no analysis of its own.
 * The guard still runs on `a` and still leaves as written for any other value.
 * The view shares the storage: a write through it is a write to `a`.
 *
 * The view is another object than `a`. Only numeric element accesses and
 * storage properties use it; calls, methods, named keys and identity uses
 * retain `a`. A callee or callback can observe the receiver's identity even
 * when the caller only reads its result. Reassigned bindings, module bindings
 * and guards inside loops keep their original reads.
 *
 * @module compile/plan/guard-views
 */
import { ctx } from '../../ctx.js'
import { T, isReassigned, collectParamNames } from '../../ast.js'
import { collectBindings } from './common.js'
import { invalidateRewrittenBody, invalidateLocalsCache } from '../analyze/body-facts.js'
import { freshId } from '../../ir.js'
import { TYPED_ELEM_NAMES } from '../../../layout.js'
import { K, tagOf, typedAux, UNKNOWN } from '../../summary/kind.js'

const isArr = Array.isArray
const VIEW_PROPS = new Set(['length', 'buffer', 'byteOffset', 'byteLength', 'BYTES_PER_ELEMENT'])
const EXITS = new Set(['throw', 'return'])
const LOOPS = new Set(['for', 'for-in', 'for-of', 'while', 'do'])
// `.`/`?.` hold a property name and `:` a key or a label where an expression would be.
const NAMES_AT_2 = new Set(['.', '?.']), NAMES_AT_1 = new Set([':'])

/** Whether a statement always leaves the function. */
const leaves = (n) => isArr(n) && (EXITS.has(n[0]) || ((n[0] === '{}' || n[0] === ';') && n.length > 1 && leaves(n[n.length - 1])))

/** The typed arrays `cond` proves where it answers `sense`: name → constructor,
 *  null for a name two tests prove different constructors. */
const proven = (cond, sense, out) => {
  if (!isArr(cond)) return out
  const op = cond[0]
  if (op === '!') return proven(cond[1], !sense, out)
  if ((op === '&&' && sense) || (op === '||' && !sense)) { proven(cond[1], sense, out); return proven(cond[2], sense, out) }
  if (op === 'instanceof' && sense && typeof cond[1] === 'string' && typeof cond[2] === 'string' && TYPED_ELEM_NAMES.includes(cond[2]))
    out.set(cond[1], out.has(cond[1]) && out.get(cond[1]) !== cond[2] ? null : cond[2])
  return out
}

/** Redirect storage accesses alone; every use of the value keeps its identity.
 *  A nested closure has its own scope and is visited independently below. */
const storageUses = (n, from, to, view) => {
  if (!isArr(n) || n[0] === 'str' || n[0] === '=>') return 0
  const op = n[0]
  let count = 0
  if (n[1] === from && ((op === '.' && VIEW_PROPS.has(n[2])) ||
      (op === '[]' && tagOf(view.kindOfExpr(n[2])) === K.NUMBER))) {
    if (to != null) n[1] = to
    count++
  }
  for (let i = 1; i < n.length; i++) {
    if ((i === 2 && NAMES_AT_2.has(op)) || (i === 1 && NAMES_AT_1.has(op))) continue
    count += storageUses(n[i], from, to, view)
  }
  return count
}

/** The names a function declares: its parameters and the bindings of its body, closures' own excluded. */
const declared = (params, body) => { const out = collectParamNames(params); collectBindings(body, out); return out }

/** The summary already names the binding a typed array of one constructor. */
const knownTyped = (view, name) => {
  let k
  try { k = view.kindOfExpr(name) } catch { return false }
  return k != null && tagOf(k) === K.TYPED && typedAux(k) !== UNKNOWN
}

/** Bind the views the guard at `list[at]` proves; the number bound. */
const bindViews = (list, at, fn) => {
  const guard = list[at]
  if (!isArr(guard) || guard[0] !== 'if' || guard.length !== 3 || !leaves(guard[2])) return 0
  let bound = 0
  for (const [name, ctor] of proven(guard[1], false, new Map())) {
    if (ctor == null || !fn.names.has(name) || isReassigned(fn.body, name) || knownTyped(fn.view, name)) continue
    const from = at + 1 + bound
    if (from >= list.length) continue
    let uses = 0
    for (let s = from; s < list.length; s++) uses += storageUses(list[s], name, null, fn.view)
    if (!uses) continue
    const to = `${T}gv${freshId(ctx)}_${name}`
    for (let s = from; s < list.length; s++) storageUses(list[s], name, to, fn.view)
    list.splice(from, 0, ['const', ['=', to, ['()', `new.${ctor}`, [',', ['.', name, 'buffer'], ['.', name, 'byteOffset'], ['.', name, 'length']]]]])
    bound++
  }
  return bound
}

/** Every typed array a guard proves, in the program's functions, is read through a view of its constructor. */
export const viewGuardedTyped = () => {
  let changed = 0
  // A body rewritten in place drops its cached facts and its census (compile/analyze/body-facts.js).
  const rewrite = (body, fn) => {
    const before = changed
    walk(body, fn, false)
    if (changed !== before) { invalidateRewrittenBody(body); invalidateLocalsCache(body) }
  }
  const walk = (n, fn, inLoop) => {
    if (!isArr(n) || n[0] === 'str') return
    if (n[0] === '=>') { rewrite(n[2], { body: n[2], names: declared(n[1] == null ? [] : [n[1]], n[2]), view: ctx.summary.at(n[1]) }); return }
    if (n[0] === ';' && !inLoop) for (let s = 1; s < n.length; s++) { const k = bindViews(n, s, fn); if (k) { changed += k; s += k } }
    const loop = inLoop || LOOPS.has(n[0])
    for (let j = 1; j < n.length; j++) walk(n[j], fn, loop)
  }
  for (const f of ctx.funcs.list) if (f.body && !f.raw)
    rewrite(f.body, { body: f.body, names: declared(f.sig.params.map(p => p.name), f.body), view: ctx.summary.at(f.sig) })
  return changed > 0
}
