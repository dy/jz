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
import { tagsOf, paramOf, UNKNOWN, NUMBER as NUMBER_KIND, K, kind as kindOfTag, isNullable as isNullableKind } from '../summary/kind.js'
import { nodeSize } from '../compile/plan/common.js'
const ARRAY_KIND = kindOfTag(K.ARRAY)
const MAX_VERSION_SIZE = 2400   // nodes a version copies at most (three of plan/integral-loops.js's loop budget)

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
    if (nested && isAssign(n)) any = true   // an arm of its own (`if (!up) up = 1`)
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
  const joinKinds = new Map()   // a join this pass declared → the kind the conditional leaves it (the summary knows the source alone)
  // A statement this pass renamed or copied (a later list's, an arm's) is the source statement the
  // summary read, over the source bindings: what the conditional leaves its copy's bindings, its
  // values being among the source's (an arm's under the guard narrower still), the source leaves its.
  const origin = new WeakMap()
  const renamed = (n, names) => { const r = rename(n, names); if (r !== n) origin.set(r, n); return r }
  const sourceOf = (n) => { while (origin.has(n)) n = origin.get(n); return n }
  const rootOf = (n) => { while (roots.has(n)) n = roots.get(n); return n }
  const exitKind = (s, name) => view.exitKindAt(sourceOf(s), rootOf(name)) ?? view.exitKindAt(s, name)

  // Later statements read `next` where they read the source binding or any name it went by:
  // an arm's statements read the arm's binding (`sum$s4`), not the source it continues.
  const rebind = (names, name, root, next) => {
    for (const [k, v] of names) if (v === name) names.set(k, next)
    names.set(root, next); names.set(name, next)
  }
  // `list` split over the bindings `mine(name)` admits
  const split = (list, mine) => {
    let out = null
    const declared = new Set(), names = new Map()
    for (let k = 1; k < list.length; k++) {
      const s = names.size ? renamed(list[k], names) : list[k]
      if (s !== list[k]) { if (!out) out = copyNode(list); out[k] = s }
      declares(s, declared)
      if (isAssign(s) && !captured.has(s[1]) && mine(s[1], declared, out ?? list, k)) {
        const name = s[1], root = roots.get(name) ?? name, next = `${root}${T}s${serial++}`
        if (!out) out = copyNode(list)
        const value = s[0] === '=' ? s[2] : [COMPOUND.get(s[0]), name, s[2]]
        out[k] = noted(s, ['let', noted(s, ['=', next, value])])
        if (view) joinKinds.set(next, view.kindOfExpr(value))
        // The RHS above still reads the previous name. Later statements read
        // the new one when reached, so each is renamed once instead of once
        // for every earlier assignment in its list.
        rebind(names, name, root, next)
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
        const v = versionRest(out ?? list, k, names, null, name => mine(name, declared, out ?? list, k))
        if (v) { out = v; break }
      }
      if (s[0] !== 'if' || !view) continue
      // the join is declared apart only where it is narrower than the binding's own kind
      const assigned = assignedIn(s), joined = []
      for (const name of assigned) if (!captured.has(name) && mine(name, declared, out ?? list, k) && !joined.includes(name) && narrower(exitKind(s, name), view.kindOf(rootOf(name)))) joined.push(name)
      // the mix the statements after read may be one the conditional made (above)
      if (!joined.length) { const v = versionRest(out ?? list, k, names, assigned, name => mine(name, declared, out ?? list, k)); if (v) { out = v; break } continue }
      if (!out) out = copyNode(list)
      const decls = []
      for (const name of joined) {
        const root = roots.get(name) ?? name, next = `${root}${T}s${serial++}`
        decls.push(noted(s, ['=', next, name]))
        rebind(names, name, root, next); declared.add(next); own.add(next); roots.set(next, root); joinKinds.set(next, exitKind(s, name))
      }
      out.splice(k + 1, 0, noted(s, ['let', ...decls]))
      list = out
      k++
      // the join declared here, or a name the conditional assigned and did not
      // join, may be the mix the statements after read (above)
      for (const name of declaredBy(out[k])) assigned.add(name)
      { const v = versionRest(out, k, names, assigned, name => mine(name, declared, out, k)); if (v) { out = v; break } }
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
  // The number bindings the loops of `rest` read as an element index, or as
  // an operand of a division or remainder, directly or through the
  // declarations the index is made of (`srcIdx = upIdx - k`, `upIdx = n * down`):
  // each with the uses it has, index or divisor.
  const cursorUses = (rest) => {
    const inits = new Map(), index = new Set(), divisor = new Set(), straight = new Set()
    const mention = (n, out) => { if (typeof n === 'string') out.add(n); else if (Array.isArray(n) && n[0] !== '=>' && n[0] !== 'str') for (let i = 1; i < n.length; i++) mention(n[i], out) }
    const walk = (n, inLoop) => {
      if (!Array.isArray(n) || n[0] === '=>' || n[0] === 'str') return
      if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') { inits.set(d[1], d[2]); if (!inLoop) straight.add(d[1]) } }
      const loop = inLoop || n[0] === 'for' || n[0] === 'while'
      if (loop && n[0] === '[]' && n.length === 3) mention(n[2], index)
      if (loop && (n[0] === '%' || n[0] === '/') && n.length === 3) { mention(n[1], index); mention(n[2], divisor) }
      for (let i = 1; i < n.length; i++) walk(n[i], loop)
    }
    for (const s of rest) walk(s, false)
    // through the rest's own declarations, to the names they are made of; a
    // straight-line declaration that is not integral by its syntax is a
    // cursor of its own (`p = p / g`), versioned where it is declared
    for (const set of [index, divisor]) for (let grown = true; grown;) { grown = false; for (const name of set) { const init = inits.get(name); if (init == null || straight.has(name) && typeof init !== 'string' && !integral(init, inits)) continue; const before = set.size; mention(init, set); if (set.size !== before) grown = true } }
    return { index, divisor }
  }
  // a name the summary proves an array that is present
  const isArrayName = (name) => { const k = view.kindOf(name); return k != null && tagsOf(k) === tagsOf(ARRAY_KIND) && !isNullableKind(k) }
  // a value integral by its syntax needs no guard: a literal, a bit operation, a length, a rounding
  const INT_MATH = new Set(['Math.floor', 'Math.ceil', 'Math.round', 'Math.trunc', 'Math.imul', 'Math.clz32'])
  const integral = (init, inits, depth = 0, param = null) => {
    if (typeof init === 'number') return Number.isInteger(init)
    if (typeof init === 'string') return depth < 4 && (inits.has(init) ? integral(inits.get(init), inits, depth + 1, param) : counters.has(init) || !!param?.(init))
    if (!Array.isArray(init)) return false
    const op = init[0]
    if (op == null) return typeof init[1] === 'number' && Number.isInteger(init[1])
    if (op === '|' || op === '&' || op === '^' || op === '<<' || op === '>>' || op === '>>>' || op === '~') return true
    if (op === '.' && init[2] === 'length') return true
    if (op === '()' && typeof init[1] === 'string' && INT_MATH.has(init[1])) return true
    // sums, differences and products of integers (`win = 2 * r + 1`)
    if ((op === '+' || op === '-' || op === '*') && init.length === 3) return integral(init[1], inits, depth + 1, param) && integral(init[2], inits, depth + 1, param)
    if (op === 'u-' && init.length === 2) return integral(init[1], inits, depth + 1, param)
    return false
  }
  // An arm a version made is split as a list of its own, not versioned again:
  // the cursors it declares were the guard's, and a copy of a copy doubles the code.
  let armDepth = 0
  const versionRest = (list, k, names, candidates = null, mine = null) => {
    if (!view || armDepth || k + 1 >= list.length) return null
    const rest = list.slice(k + 1).map(s => names.size ? renamed(s, names) : s)   // the later statements read the names declared so far
    if (!rest.some(hasLoop)) return null
    const restNode = [';', ...rest], assigned = assignedIn(restNode)
    const picked = [], cursors = []
    for (const name of candidates ?? declaredBy(list[k])) if (!assigned.has(name) && view.isMixed(roots.get(name) ?? name) && elementReceivers(restNode).includes(name)) picked.push(name)
    // A number the loops index or divide by, declared before this point and
    // not integral by its syntax (a bag's write index, a ratio a division
    // made): the arm runs it as an int32 the guard proves, non-negative as an
    // index, positive as a divisor. One a later statement outside a loop
    // still assigns (`if (!down) down = 1`) waits for that statement's own
    // versioning, so the loops are copied once for all of them.
    const uses = cursorUses(rest), inits = new Map(), declaredInRest = new Set()
    const initsOf = (st) => { if (Array.isArray(st) && (st[0] === 'let' || st[0] === 'const')) for (let j = 1; j < st.length; j++) { const d = st[j]; if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') inits.set(d[1], d[2]) } }
    for (let i = 1; i <= k; i++) initsOf(list[i])
    for (const s of rest) declaresIn(s, declaredInRest)
    // the straight-line statements ahead of the first loop: a cursor one of
    // them assigns or declares is versioned there, with the ones before it
    const prefix = []; for (const st of rest) { if (hasLoop(st)) break; prefix.push(st); initsOf(st) }
    const later = new Set(); for (const st of prefix) { assignedIn(st, later); for (const name of declaredBy(st)) later.add(name) }
    // (a parameter every call passes one integer, `hblur(img, out, W, H, R)` under `const W = 64`, is an integer already)
    const paramHulls = view.paramRangesOf?.(fn.name) ?? null
    const integerParam = (name) => { const at = fn.sig.params.findIndex(p => p.name === name); const r = at < 0 ? null : paramHulls?.[at]; return !!r && r[0] === r[1] && Number.isInteger(r[0]) }
    const cursor = (name) => {
      if (captured.has(name) || (mine && !mine(name)) || integral(inits.get(name) ?? null, inits, 0, integerParam) || integerParam(name)) return false
      const kind = joinKinds.get(name) ?? view.kindOf(name)
      return kind != null && tagsOf(kind) === tagsOf(NUMBER_KIND) && !isNullableKind(kind)
    }
    // (a loop over numbers alone is the integral-loop plan's, plan/integral-loops.js:
    // the cursors here ride with an array the guard picks, the state-bag's index with its history)
    if (picked.length) for (const name of new Set([...uses.index, ...uses.divisor])) {
      if (!cursor(name)) continue
      if (later.has(name)) continue
      if (!declaredInRest.has(name)) cursors.push(name)
    }
    if (!picked.length) return null
    // The arms cover the statements through the last loop reading a cursor or
    // an array, then any later statement reading a name declared among them;
    // a cursor assigned in the arms is written back to its binding after.
    const watched = new Set([...picked, ...cursors]), mentionsAny = (n, set) => { if (typeof n === 'string') return set.has(n); if (!Array.isArray(n) || n[0] === 'str') return false; for (let i = 1; i < n.length; i++) if (mentionsAny(n[i], set)) return true; return false }
    // a loop reads a cursor through the declarations made of it (`up = p`)
    const restInits = new Map(); for (const st of rest) { if (Array.isArray(st) && (st[0] === 'let' || st[0] === 'const')) for (let j = 1; j < st.length; j++) { const d = st[j]; if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') restInits.set(d[1], d[2]) } }
    for (let grown = true; grown;) { grown = false; for (const [name, init] of restInits) if (!watched.has(name) && mentionsAny(init, watched)) { watched.add(name); grown = true } }
    let end = -1
    for (let i = 0; i < rest.length; i++) if (hasLoop(rest[i]) && mentionsAny(rest[i], watched)) end = i
    if (end < 0) return null
    for (let grown = true; grown;) {
      grown = false
      const declaredIn = new Set(); for (let i = 0; i <= end; i++) declaresIn(rest[i], declaredIn)
      for (let i = end + 1; i < rest.length; i++) if (mentionsAny(rest[i], declaredIn)) { end = i; grown = true; break }
    }
    const after = rest.slice(end + 1); rest.length = end + 1
    // the arms double the statements they cover: a tail too large to copy stays as written
    if (rest.reduce((n, s) => n + nodeSize(s), 0) > MAX_VERSION_SIZE) return null
    declaredInRest.clear(); for (const s of rest) declaresIn(s, declaredInRest)
    const written = assignedIn([';', ...rest]), writeBack = cursors.filter(name => written.has(name))
    const to = new Map(), decls = []
    for (const name of picked) {
      const next = `${name}${T}s${serial++}`
      to.set(name, next); own.add(next); roots.set(next, name)
      const decl = noted(list[k], ['=', next, name]); decl.guarded = true   // read under the guard: not an alias (plan/alias.js)
      decls.push(decl)
    }
    let test = null
    const and = (t) => { test = test ? ['&&', test, t] : t }
    for (const name of picked) and(['()', 'Array.isArray', name])
    const cursorDecls = new Map()
    for (const name of cursors) {
      const next = `${name}${T}s${serial++}`, lo = uses.divisor.has(name) ? 1 : 0
      to.set(name, next); own.add(next); roots.set(next, name)
      const decl = noted(list[k], ['=', next, ['|', name, [null, 0]]]); decl.lo = lo   // the summary's hull (index.js noteHull)
      decls.push(decl); cursorDecls.set(name, decl)
      // an int32 that is not -0 (the word would read it as 0): equal to its own word, and positive where zero
      and(['===', name, ['|', name, [null, 0]]])
      and(lo ? ['>', name, [null, 0]] : ['&&', ['>=', name, [null, 0]], ['||', ['!==', name, [null, 0]], ['>', ['/', [null, 1], name], [null, 0]]]])
    }
    // An index below the length of the array it indexes: the guard tests it,
    // the arm's binding is bounded by that array (its hull by the element
    // count any array can hold), kept while each assignment stays below.
    const ARRAY_TOP = 0x1ffffffe
    for (const name of cursors) {
      const arrays = new Set()
      const scan = (n) => { if (!Array.isArray(n) || n[0] === '=>' || n[0] === 'str') return; if (n[0] === '[]' && n[2] === name && typeof n[1] === 'string' && (picked.includes(n[1]) || isArrayName(n[1]))) arrays.add(n[1]); for (let i = 1; i < n.length; i++) scan(n[i]) }
      for (const st of rest) scan(st)
      const decl = cursorDecls.get(name)
      for (const a of arrays) { and(['<', name, ['.', a, 'length']]); decl.hi = ARRAY_TOP; if (decl.bound == null) decl.bound = a }
    }
    // a divisor declared as a picked array's length is positive under the guard
    const positiveLengths = []
    for (const st of rest) if (Array.isArray(st) && st[0] === 'const') for (let j = 1; j < st.length; j++) {
      const d = st[j]
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && uses.divisor.has(d[1]) && Array.isArray(d[2]) && d[2][0] === '.' && d[2][2] === 'length' && picked.includes(d[2][1])) { positiveLengths.push(d[1]); and(['>', ['.', d[2][1], 'length'], [null, 0]]) }
    }
    // the copy's own declarations are bindings of their own: each arm's kinds stay apart
    for (const name of declaredInRest) if (!captured.has(name)) { const next = `${name}${T}s${serial++}`; to.set(name, next); own.add(next); roots.set(next, roots.get(name) ?? name) }
    const at = list[k]
    for (const decl of cursorDecls.values()) if (decl.bound != null) decl.bound = to.get(decl.bound) ?? decl.bound
    const copy = rest.map(s => renamed(s, to))
    for (const name of positiveLengths) { const next = to.get(name); for (const st of copy) if (Array.isArray(st) && st[0] === 'const') for (let j = 1; j < st.length; j++) if (Array.isArray(st[j]) && st[j][1] === next) st[j].lo = 1 }
    // each arm is a list of its own: a cursor declared inside it versions its loops in turn
    armDepth++
    const fast = noted(at, ['{}', inner(noted(at, [';', noted(at, ['let', ...decls]), ...copy, ...writeBack.map(name => noted(at, ['=', name, to.get(name)]))]))])
    const slow = noted(at, ['{}', inner(noted(at, [';', ...rest]))])
    armDepth--
    // the arm as written runs where the guard fails: its loops are cold to the
    // passes that copy loops (plan/integral-loops.js, the vectorizers, twin-locals.js)
    const chill = (n) => { if (!Array.isArray(n) || n[0] === '=>') return; if (n[0] === 'for' || n[0] === 'while' || n[0] === 'do') n.cold = true; for (let i = 1; i < n.length; i++) chill(n[i]) }
    chill(slow)
    const out = copyNode(list)
    out.length = k + 1
    out.push(noted(at, ['if', test, fast, slow]), ...after)
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
  // the counters of the loops around a list: integers by their literal start and unit step
  const counters = new Set()
  const counterOf = (n) => n[0] === 'for' && n.length === 5 && Array.isArray(n[1]) && n[1][0] === 'let' && Array.isArray(n[1][1]) && n[1][1][0] === '=' &&
    typeof n[1][1][1] === 'string' && Array.isArray(n[1][1][2]) && n[1][1][2][0] == null && Number.isInteger(n[1][1][2][1]) &&
    Array.isArray(n[3]) && (n[3][0] === '++' || n[3][0] === '--') && n[3][1] === n[1][1][1] ? n[1][1][1] : null
  const inner = (n) => {
    if (!Array.isArray(n) || n[0] === '=>' || n[0] === 'str') return n
    if (n[0] === ';') return split(n, within)
    const counter = counterOf(n)
    if (counter) counters.add(counter)
    let out = n
    for (let i = 1; i < n.length; i++) { const c = inner(n[i]); if (c !== n[i]) { if (out === n) out = copyNode(n); out[i] = c } }
    if (counter) counters.delete(counter)
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
