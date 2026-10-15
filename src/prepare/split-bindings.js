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
import { T, noted, copyNode } from '../ast.js'
import { ctx } from '../ctx.js'
import { tagsOf, paramOf, UNKNOWN } from '../summary/kind.js'

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

// Apply the latest binding names to one statement. Property names and literal
// keys are not bindings; unchanged nodes retain their identity and metadata.
const rename = (n, names) => {
  if (typeof n === 'string') return names.get(n) ?? n
  if (!Array.isArray(n) || n[0] === 'str') return n
  let out = n
  const start = n[0] === ':' ? 2 : 1, end = n[0] === '.' || n[0] === '?.' ? 2 : n[0] === ':' ? 3 : n.length
  for (let i = start; i < end; i++) {
    const c = rename(n[i], names)
    if (c !== n[i]) { if (out === n) out = copyNode(n); out[i] = c }
  }
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
  const body = sequenceBody(fn.body)
  if (!Array.isArray(body) || body[0] !== '{}' || body.length !== 2 || !Array.isArray(body[1])) return fn.body
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
    const declared = new Set(), names = new Map()
    for (let k = 1; k < list.length; k++) {
      const s = names.size ? rename(list[k], names) : list[k]
      if (s !== list[k]) { if (!out) out = copyNode(list); out[k] = s }
      declares(s, declared)
      if (isAssign(s) && !captured.has(s[1]) && mine(s[1], declared, out ?? list, k)) {
        const name = s[1], root = roots.get(name) ?? name, next = `${root}${T}s${serial++}`
        if (!out) out = copyNode(list)
        out[k] = noted(s, ['let', noted(s, ['=', next, s[0] === '=' ? s[2] : [COMPOUND.get(s[0]), name, s[2]]])])
        // The RHS above still reads the previous name. Later statements read
        // the new one when reached, so each is renamed once instead of once
        // for every earlier assignment in its list.
        names.set(root, next)
        declared.add(next); own.add(next); roots.set(next, root)
        continue
      }
      // A conditional that assigns a binding on some path leaves the join of
      // its arms: the statements after it read that as a binding of its own
      // (`if (ptr == null) ptr = 0`: a number from here on), which the
      // summary's exit join of the conditional types.
      if (nested) {
        const c = inner(s)
        if (c !== s) { if (!out) out = copyNode(list); out[k] = c }
        // The statements after a declaration of a binding that mixes a
        // primitive with an array (the summary's lazy join: `mem` a number
        // before the history replaces it), when a loop among them reads the
        // array, run twice: under `Array.isArray` with the array as a binding
        // of its own, whose reads the summary types, and as written otherwise.
        const v = versionRest(out ?? list, k, names)
        if (v) { out = v; break }
      }
      if (s[0] !== 'if' || !view) continue
      // the join is declared apart only where it is narrower than the binding's own kind
      const assigned = assignedIn(s), joined = []
      for (const name of assigned) if (!captured.has(name) && mine(name, declared, out ?? list, k) && !joined.includes(name) && narrower(view.exitKindAt(s, name), view.kindOf(name))) joined.push(name)
      // the mix the statements after read may be one the conditional made (above)
      if (!joined.length) { const v = versionRest(out ?? list, k, names, assigned); if (v) { out = v; break } continue }
      if (!out) out = copyNode(list)
      const decls = []
      for (const name of joined) {
        const root = roots.get(name) ?? name, next = `${root}${T}s${serial++}`
        decls.push(noted(s, ['=', next, name]))
        names.set(root, next); declared.add(next); own.add(next); roots.set(next, root)
      }
      out.splice(k + 1, 0, noted(s, ['let', ...decls]))
      list = out
      k++
      // the join declared here, or a name the conditional assigned and did not
      // join, may be the mix the statements after read (above)
      for (const name of declaredBy(out[k])) assigned.add(name)
      { const v = versionRest(out, k, names, assigned); if (v) { out = v; break } }
    }
    return out ?? list
  }
  const view = nested ? ctx.summary?.at(fn.name) : null
  // the names a loop reads as an element receiver (`x[i]`, `x.length`) and never assigns
  const elementReceivers = (loop) => {
    const reads = new Set(), writes = assignedIn(loop)
    const walk = (n) => {
      if (!Array.isArray(n) || n[0] === '=>' || n[0] === 'str') return
      if ((n[0] === '[]' || n[0] === '.' && n[2] === 'length') && typeof n[1] === 'string') reads.add(n[1])
      for (let i = 1; i < n.length; i++) walk(n[i])
    }
    walk(loop)
    const out = []
    // a binding this pass declared continues one the summary knows
    for (const name of reads) if (!writes.has(name) && !captured.has(name) && own.has(name) && view?.isMixed(roots.get(name) ?? name)) out.push(name)
    return out
  }
  // the names declared anywhere in a statement, closures aside
  const declaresIn = (n, out) => {
    if (!Array.isArray(n) || n[0] === '=>' || n[0] === 'str') return
    if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) { const d = n[i]; if (typeof d === 'string') out.add(d); else if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') out.add(d[1]) }
    for (let i = 1; i < n.length; i++) declaresIn(n[i], out)
  }
  // the names a declaration statement declares
  const declaredBy = (s) => { const out = []; if (Array.isArray(s) && (s[0] === 'let' || s[0] === 'const')) for (let i = 1; i < s.length; i++) { const d = s[i]; if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') out.push(d[1]) } return out }
  const hasLoop = (n) => Array.isArray(n) && n[0] !== '=>' && (n[0] === 'for' || n[0] === 'while' || n.some((c, i) => i > 0 && hasLoop(c)))
  // a kind with fewer tags, or the same tags and a parameter the other lacks
  const narrower = (a, b) => a != null && b != null && a !== b && (tagsOf(a) !== tagsOf(b) ? (tagsOf(a) & ~tagsOf(b)) === 0 : paramOf(a) !== UNKNOWN && paramOf(b) === UNKNOWN)
  const versionRest = (list, k, names, candidates = null) => {
    if (!view || k + 1 >= list.length) return null
    const rest = list.slice(k + 1).map(s => names.size ? rename(s, names) : s)   // the later statements read the names declared so far
    if (!rest.some(hasLoop)) return null
    const restNode = [';', ...rest], assigned = assignedIn(restNode)
    const picked = []
    for (const name of candidates ?? declaredBy(list[k])) if (!assigned.has(name) && view.isMixed(roots.get(name) ?? name) && elementReceivers(restNode).includes(name)) picked.push(name)
    if (!picked.length) return null
    const to = new Map(), decls = []
    for (const name of picked) {
      const next = `${name}${T}s${serial++}`
      to.set(name, next); own.add(next); roots.set(next, name)
      const decl = noted(list[k], ['=', next, name]); decl.guarded = true   // read under the guard: not an alias (plan/alias.js)
      decls.push(decl)
    }
    // the copy's own declarations are bindings of their own: each arm's kinds stay apart
    const inner = new Set(); for (const s of rest) declaresIn(s, inner)
    for (const name of inner) if (!captured.has(name)) { const next = `${name}${T}s${serial++}`; to.set(name, next); own.add(next); roots.set(next, roots.get(name) ?? name) }
    let test = null
    for (const name of picked) { const t = ['()', 'Array.isArray', name]; test = test ? ['&&', test, t] : t }
    const at = list[k]
    const fast = noted(at, ['{}', noted(at, [';', noted(at, ['let', ...decls]), ...rest.map(s => rename(s, to))])])
    const slow = noted(at, ['{}', noted(at, [';', ...rest])])
    const out = copyNode(list)
    out.length = k + 1
    out.push(noted(at, ['if', test, fast, slow]))
    return out
  }
  // the names a statement's arms assign (closures aside: their assignments are the cell's)
  const assignedIn = (n, out = new Set()) => {
    if (!Array.isArray(n) || n[0] === '=>' || n[0] === 'str') return out
    // a declaration names a binding of its own block, not one of the list's
    if (n[0] === 'let' || n[0] === 'const') {
      for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=' && d[2] != null) assignedIn(d[2], out) }
      return out
    }
    if (isAssign(n)) out.add(n[1])
    if (n[0] === '++' || n[0] === '--') { if (typeof n[1] === 'string') out.add(n[1]) }
    for (let i = 1; i < n.length; i++) assignedIn(n[i], out)
    return out
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
    for (let i = 1; i < n.length; i++) { const c = inner(n[i]); if (c !== n[i]) { if (out === n) out = copyNode(n); out[i] = c } }
    return out
  }
  const list = split(top, (name) => own.has(name))
  return list === top ? fn.body : ['{}', list]
}

/**
 * An expression body that is a sequence with an assignment among its steps
 * (`s => (cur = s, s = expr(), s || '')`) is the list of those steps and a
 * return of its value: the sequence runs once, top to bottom, as a list does,
 * so each assignment can declare its value. Any other body stays as written.
 */
const sequenceBody = (body) => {
  if (!Array.isArray(body) || body[0] !== ',' || body.length < 3) return body
  let assigns = false
  for (let i = 1; i < body.length - 1; i++) if (isAssign(body[i])) assigns = true
  if (!assigns) return body
  const last = body[body.length - 1]
  return noted(body, ['{}', noted(body, [';', ...body.slice(1, -1), noted(last, ['return', last])])])
}
