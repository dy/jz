/**
 * The member names the program uses, by position: called (`o.m(…)`), read
 * (`o.m`, `o["m"]`), stored (`o.m = v`), defined (literal/class fields and
 * methods). A census of the source as it stands; `memberUses` keeps one per
 * compile for emission, which synthesizes no new source member access. The plan
 * takes a fresh one before it rewrites bodies: whether the program defines a
 * conversion (`definesToPrimitive`) decides, before emission, whether an
 * arithmetic operator over a value of unknown kind may run user code.
 */
import { ctx } from './ctx.js'
import { frameRoots } from './function.js'
import { ACCESSOR_GET, ACCESSOR_SET, MUTATE_OPS } from './ast.js'

const isAccessorSlot = (name) => name.endsWith(ACCESSOR_GET) || name.endsWith(ACCESSOR_SET)

/** The census of the program as it stands: { called, read, written, defined }. */
export function collectMemberUses() {
  const called = new Set(), read = new Set(), written = new Set(), defined = new Set()
  const define = name => {
    defined.add(name)
    if (typeof name === 'string' && isAccessorSlot(name))
      defined.add(name.slice(0, -ACCESSOR_GET.length))
  }
  // `o.m` and `o["m"]` name the member alike
  const memberOf = (n) => !Array.isArray(n) ? null
    : (n[0] === '.' || n[0] === '?.') && typeof n[2] === 'string' ? n[2]
    : n[0] === '[]' && Array.isArray(n[2]) && (n[2][0] === 'str' || n[2][0] == null) && typeof n[2][1] === 'string' ? n[2][1] : null
  const walk = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0], m = n.length > 1 ? memberOf(n[1]) : null
    if (op === ':' && typeof n[1] === 'string') define(n[1])
    // a call through a computed key, or an optional call, reads the member as a value first
    if ((op === '()' || op === '?.()') && m != null) { (n[1][0] === '[]' || op === '?.()' ? read : called).add(m); walk(n[1][1]); for (let i = 2; i < n.length; i++) walk(n[i]); return }
    if (MUTATE_OPS.has(op) && m != null) { written.add(m); if (op !== '=') read.add(m); walk(n[1][1]); for (let i = 2; i < n.length; i++) walk(n[i]); return }
    const own = memberOf(n)
    if (own != null) { read.add(own); walk(n[1]); return }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  for (const f of ctx.funcs.list) for (const r of frameRoots(f)) walk(r)
  walk(ctx.module.entryInit)
  for (const init of ctx.module.moduleInits ?? []) walk(init)
  for (const props of ctx.schema.list) for (const prop of props) define(prop)
  for (const entry of ctx.transform.classes?.values() ?? []) for (const name of entry.methods.keys()) define(name)
  return { called, read, written, defined }
}

/** One census per compile, also used to activate coercion helpers. */
export function memberUses() {
  if (ctx.transform.memberUses) return ctx.transform.memberUses
  return ctx.transform.memberUses = collectMemberUses()
}

/** Whether the program defines or stores a `toString`/`valueOf` anywhere: the
 *  user conversions OrdinaryToPrimitive would run (compile/emit/to-primitive.js). */
export const definesToPrimitive = ({ defined, written }) => ['toString', 'valueOf'].some(name => defined.has(name) || written.has(name))
