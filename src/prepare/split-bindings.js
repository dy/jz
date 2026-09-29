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

const isAssign = (s) => Array.isArray(s) && s.length === 3 && typeof s[1] === 'string' && (s[0] === '=' || COMPOUND.has(s[0]))
// the names a statement of a list declares
const declares = (s, out) => {
  if (!Array.isArray(s) || (s[0] !== 'let' && s[0] !== 'const')) return
  for (let i = 1; i < s.length; i++) { const d = s[i]; if (typeof d === 'string') out.add(d); else if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') out.add(d[1]) }
}
// the mentions of `name` in `n`: a property name and a key mention no binding
const mentions = (n, name) => {
  if (n === name) return 1
  if (!Array.isArray(n) || n[0] === 'str') return 0
  if (n[0] === '.' || n[0] === '?.') return mentions(n[1], name)
  if (n[0] === ':') return mentions(n[2], name)
  let c = 0
  for (let i = 1; i < n.length; i++) c += mentions(n[i], name)
  return c
}

/**
 * The body of `fn` with each assignment of its own list a declaration; the body
 * itself where there is none. `nested` splits the lists inside it too (a loop's
 * body, an arm: where a spliced call left its statements), each over the
 * bindings it declares and nothing outside it mentions: the list runs top to
 * bottom each time it runs, and such a binding is new each time. So is one
 * declared bare outside the list that only the list mentions, from an
 * assignment nothing in the list precedes (`var opts` of a spliced body whose
 * statements the lowered returns put in an arm): each run of the list assigns
 * it before it reads it.
 */
export function splitReassigned(fn, nested = false) {
  const body = fn.body
  if (!Array.isArray(body) || body[0] !== '{}' || body.length !== 2 || !Array.isArray(body[1])) return body
  // a body of one statement (a loop alone) is a list of it: the lists inside it split
  const top = body[1][0] === ';' ? body[1] : nested ? [';', body[1]] : null
  if (top === null) return body
  let any = false
  const has = (n) => {
    if (any || !Array.isArray(n) || n[0] === '=>' || n[0] === 'str') return
    if (n[0] === ';') for (let k = 1; k < n.length; k++) if (isAssign(n[k])) any = true
    if (nested) for (let k = 1; k < n.length; k++) has(n[k])
  }
  has(top)
  if (!any) return body
  const own = new Set(), captured = new Set()
  for (const p of fn.sig.params) if (p.name !== fn.rest) own.add(p.name)
  census(body, own, captured, false)
  if (fn.defaults) for (const d of Object.values(fn.defaults)) census(d, new Set(), captured, false)
  // the names an earlier pass over this body made keep theirs
  let serial = 0
  const made = new RegExp(`${T}s(\\d+)$`)
  for (const name of own) { const m = made.exec(name); if (m) serial = Math.max(serial, +m[1] + 1) }
  const roots = new Map()   // a binding this pass declared → the source binding it continues

  // `list` split over the bindings `mine(name)` admits
  const split = (list, mine) => {
    let out = null
    const declared = new Set()
    for (let k = 1; k < list.length; k++) {
      const s = (out ?? list)[k]
      declares(s, declared)
      if (isAssign(s) && !captured.has(s[1]) && mine(s[1], declared, out ?? list, k)) {
        const name = s[1], root = roots.get(name) ?? name, next = `${root}${T}s${serial++}`
        if (!out) out = list.slice()
        out[k] = ['let', ['=', next, s[0] === '=' ? s[2] : [COMPOUND.get(s[0]), name, s[2]]]]
        for (let j = k + 1; j < out.length; j++) out[j] = rename(out[j], name, next)
        declared.add(next); own.add(next); roots.set(next, root)
        continue
      }
      if (!nested) continue
      const c = inner(s)
      if (c !== s) { if (!out) out = list.slice(); out[k] = c }
    }
    return out ?? list
  }
  // the names the body declares with no value
  const bare = new Set()
  const bares = (n) => {
    if (!Array.isArray(n) || n[0] === '=>' || n[0] === 'str') return
    if (n[0] === 'let') for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string') bare.add(n[i])
    for (let i = 1; i < n.length; i++) bares(n[i])
  }
  if (nested) bares(body)
  // a list inside: over what it declared ahead of the assignment and nothing outside it mentions,
  // and over what is declared bare outside it, mentioned there alone and first by this assignment
  const within = (name, declared, list, k) => {
    // a binding this pass declared in the list is mentioned after it, in the list, alone
    if (roots.has(name)) return declared.has(name)
    const outside = mentions(body, name) - mentions(list, name)
    if (declared.has(name)) return outside === 0
    if (outside !== 1 || !bare.has(name) || list[k][0] !== '=' || mentions(list[k][2], name) !== 0) return false
    for (let j = 1; j < k; j++) if (mentions(list[j], name) !== 0) return false
    return true
  }
  const inner = (n) => {
    if (!Array.isArray(n) || n[0] === '=>' || n[0] === 'str') return n
    if (n[0] === ';') return split(n, within)
    let out = n
    for (let i = 1; i < n.length; i++) { const c = inner(n[i]); if (c !== n[i]) { if (out === n) out = n.slice(); out[i] = c } }
    return out
  }
  const list = split(top, (name) => own.has(name))
  return list === top ? body : ['{}', list]
}
