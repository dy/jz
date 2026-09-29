/**
 * A statement of a function's own list that assigns one of its bindings
 * declares the value as a binding of its own, which the statements after it
 * read:
 *
 *   x -= n                     let x1 = x - n
 *   xx = x * x           →     xx = x1 * x1
 *   x = px / (q - px)          let x2 = px / (q - px)
 *   return ldexp(x, n)         return ldexp(x2, n)
 *
 * The list runs once, top to bottom: what precedes the assignment read the old
 * value and never runs again, what follows reads the new. Each binding then
 * holds one value and has that value's kind (a parameter of any kind,
 * reassigned from arithmetic, is a number from there on, and so is what it
 * passes to a callee), and a parameter only the list assigned is never
 * written. A later write nested in the list (a loop, an arm) assigns the
 * binding of its place. A binding a closure names is one cell its calls
 * share: it stays whole.
 *
 * Runs on prepared bodies: every local is named apart, so a name is its binding.
 *
 * @module prepare/split-bindings
 */
import { T } from '../ast.js'

const COMPOUND = new Map([['+=', '+'], ['-=', '-'], ['*=', '*'], ['/=', '/'], ['%=', '%'], ['**=', '**'],
  ['&=', '&'], ['|=', '|'], ['^=', '^'], ['<<=', '<<'], ['>>=', '>>'], ['>>>=', '>>>']])

// The names a node declares outside any closure, and every name a closure inside it mentions.
const census = (n, own, captured, inArrow) => {
  if (typeof n === 'string') { if (inArrow) captured.add(n); return }
  if (!Array.isArray(n) || n[0] === 'str') return
  const arrow = inArrow || n[0] === '=>'
  if (!arrow && (n[0] === 'let' || n[0] === 'const'))
    for (let i = 1; i < n.length; i++) { const d = n[i]; if (typeof d === 'string') own.add(d); else if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') own.add(d[1]) }
  for (let i = 1; i < n.length; i++) census(n[i], own, captured, arrow)
}

// `node` with the binding `from` named `to`: a property name and a key name no binding.
const rename = (n, from, to) => {
  if (n === from) return to
  if (!Array.isArray(n) || n[0] === 'str') return n
  let out = n
  const at = (i) => { const c = rename(n[i], from, to); if (c !== n[i]) { if (out === n) out = n.slice(); out[i] = c } }
  if (n[0] === '.' || n[0] === '?.') at(1)
  else if (n[0] === ':') at(2)
  else for (let i = 1; i < n.length; i++) at(i)
  return out
}

/** The body of `fn` with each assignment of its own list a declaration; the body itself where there is none. */
export function splitReassigned(fn) {
  const body = fn.body
  if (!Array.isArray(body) || body[0] !== '{}' || body.length !== 2 || !Array.isArray(body[1]) || body[1][0] !== ';') return body
  const list = body[1]
  let first = -1
  for (let k = 1; k < list.length && first < 0; k++) { const s = list[k]; if (Array.isArray(s) && s.length === 3 && typeof s[1] === 'string' && (s[0] === '=' || COMPOUND.has(s[0]))) first = k }
  if (first < 0) return body
  const own = new Set(), captured = new Set()
  for (const p of fn.sig.params) if (p.name !== fn.rest) own.add(p.name)
  census(body, own, captured, false)
  if (fn.defaults) for (const d of Object.values(fn.defaults)) census(d, new Set(), captured, false)
  let out = null, serial = 0
  const roots = new Map()   // a binding this pass declared → the source binding it continues
  for (let k = first; k < list.length; k++) {
    const s = (out ?? list)[k]
    if (!Array.isArray(s) || s.length !== 3 || typeof s[1] !== 'string' || (s[0] !== '=' && !COMPOUND.has(s[0]))) continue
    const name = s[1]
    if (!own.has(name) || captured.has(name)) continue
    const root = roots.get(name) ?? name, next = `${root}${T}s${serial++}`
    if (!out) out = list.slice()
    out[k] = ['let', ['=', next, s[0] === '=' ? s[2] : [COMPOUND.get(s[0]), name, s[2]]]]
    for (let j = k + 1; j < out.length; j++) out[j] = rename(out[j], name, next)
    own.add(next); roots.set(next, root)
  }
  return out ? ['{}', out] : body
}
