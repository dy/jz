/**
 * A store into a receiver the census cannot read again is a store the flag
 * cannot name: `map.get(k).push(v)`, `(seen ??= new Set()).add(k)`,
 * `list.slice().sort(cmp)`. The frame census (compile/analyze/frame-effects.js)
 * flags such a site with no address, zero, and every frame around it keeps
 * its memory: the arena rewind and the kernel's phase checkpoint read the
 * flag against their marks. Where the receiver is the first thing the
 * statement evaluates, it is read once into a local of its own, before the
 * statement, and the site writes into a binding: a named receiver the census
 * reads, and the emitter lowers the flag to its address. The statement's
 * order is kept: the receiver was evaluated first already.
 *
 * @module compile/plan/site-receivers
 */
import { ctx } from '../../ctx.js'
import { T, ASSIGN_OPS, isBlockBody } from '../../ast.js'
import { freshId } from '../../ir.js'

// The receiver methods the census counts as stores (frame-effects.js
// GROW_METHODS and WRITE_METHODS, the array and collection ones).
const STORE_METHODS = new Set(['push', 'unshift', 'splice', 'pop', 'shift', 'add', 'delete', 'clear', 'set', 'fill', 'copyWithin', 'reverse', 'sort'])
const isName = (e) => typeof e === 'string'
/** A receiver the census reads again for the flag: a name, or a path of names and literal indexes (frame-effects.js `readable`). */
const readable = (e) => isName(e) || (Array.isArray(e) && (
  (e[0] === '.' && readable(e[1]) && isName(e[2])) ||
  (e[0] === '[]' && e.length === 3 && readable(e[1]) && (isName(e[2]) || (Array.isArray(e[2]) && e[2][0] == null)))))
/** Whether an optional link stands in a receiver's chain: `a?.b.push(x)` runs nothing where `a` is nullish, and
 *  `b` read into a local of its own would be read of nothing. Such a receiver stays as it is. */
const optional = (e) => Array.isArray(e) && (e[0] === '?.' || ((e[0] === '.' || e[0] === '[]' || e[0] === '()') && optional(e[1])))
/** A typed array's view, sorted or filled through and never read: the emitter writes the range in place with no
 *  view made (compile/array-view.js, test/typed-sort.js), a shape a local holding the view would hide. */
const isView = (e) => Array.isArray(e) && e[0] === '()' && Array.isArray(e[1]) && e[1][0] === '.' && e[1][2] === 'subarray'
/** The member node (`.`) of a method store `expr` runs through, where the receiver is evaluated first. An
 *  assignment through a member reference (`a().b[k()] = v`) stays whole: the emitter stages the reference
 *  itself, a host's included (emit/assignment.js stagedReference). */
const storeMember = (expr) => {
  if (!Array.isArray(expr)) return null
  if (expr[0] === '()' && Array.isArray(expr[1]) && expr[1][0] === '.' && STORE_METHODS.has(expr[1][2]) && !isView(expr[1][1])) return expr[1]
  return null
}
// Operators that evaluate their first operand first, before anything else of
// theirs runs (ast.js IN_ORDER, the literals, the calls, the tests, the sequences).
const IN_ORDER = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', '<', '<=', '>', '>=',
  '==', '!=', '===', '!==', 'u-', 'u+', '!', '~', 'typeof', 'void', '.', '[]', '?.', '[', '{}', ',', '?:', '&&', '||', '??', '()', '...', ':'])
/** The store a statement runs first, with nothing of its own evaluated
 *  before the store's receiver: the statement itself, or the leftmost
 *  operand the statement's operators and literals reach down to. */
const firstStore = (e) => {
  if (!Array.isArray(e) || e[0] == null || e[0] === 'str' || e[0] === 'bool') return null
  const op = e[0]
  if (op === 'return') return e[1] == null ? null : firstStore(e[1])
  if (op === 'const' || op === 'let') return e.length === 2 && Array.isArray(e[1]) && e[1][0] === '=' && isName(e[1][1]) ? firstStore(e[1][2]) : null
  if (ASSIGN_OPS.has(op) && isName(e[1])) return firstStore(e[2])
  const member = storeMember(e)
  if (member !== null) return member
  if (!IN_ORDER.has(op)) return null
  if (op === '()' && Array.isArray(e[1]) && (e[1][0] === '.' || e[1][0] === '?.' || e[1][0] === '[]')) return firstStore(e[1][1])   // a method's receiver runs first
  if (op === '()') return isName(e[1]) ? firstStore(e[2]) : firstStore(e[1])
  if (op === '{}') return e.length > 1 && Array.isArray(e[1]) && e[1][0] === ':' ? firstStore(e[1][2]) : null
  if (op === ':') return firstStore(e[2])
  return e.length > 1 ? firstStore(e[1]) : null
}

/** The member of the store a statement runs first whose receiver is read into a local, or null. */
const hoistable = (st) => {
  const member = firstStore(st)
  return member !== null && Array.isArray(member[1]) && !readable(member[1]) && !optional(member[1]) ? member : null
}
/** Read every unreadable receiver of a store at a statement's head into a local before it; whether any was. */
export function hoistSiteReceivers(ast) {
  let changed = false
  const lists = (node) => {
    if (!Array.isArray(node) || node[0] === 'str' || node[0] == null) return
    if (node[0] === ';') {
      for (let i = 1; i < node.length; i++) {
        const member = hoistable(node[i])
        if (member === null) continue
        const local = `${T}site${freshId(ctx)}`
        node.splice(i, 0, ['const', ['=', local, member[1]]])
        member[1] = local
        i++
        changed = true
      }
    }
    // an arrow's expression body is its one statement: it takes a block
    if (node[0] === '=>' && !isBlockBody(node[2])) {
      const member = hoistable(node[2])
      if (member !== null) {
        const local = `${T}site${freshId(ctx)}`
        node[2] = ['{}', [';', ['const', ['=', local, member[1]]], ['return', node[2]]]]
        member[1] = local
        changed = true
      }
    }
    for (let i = 1; i < node.length; i++) lists(node[i])
  }
  lists(ast)
  for (const f of ctx.funcs.list) if (!f.raw && f.body != null) { lists(f.body); if (f.defaults) for (const d of Object.values(f.defaults)) lists(d) }
  return changed
}
