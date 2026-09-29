/**
 * A module array the program only uses as scratch is locals.
 *
 * A numeric library returns two values through an array of the module it
 * passes down (`normalize( frac, FRAC, 1, 0 ); frac = FRAC[ 0 ]; exp +=
 * FRAC[ 1 ]`). Once the helper is spliced into its caller (plan/inline.js)
 * every use of the array is an element at a constant index, written before it
 * is read in the same call. Such an element is a value of the call, not of the
 * module: each function that names the array holds its elements in locals of
 * its own, and the array, its stores and the reset's snapshot of it are gone.
 *
 * The array is a module constant bound to a literal of numbers, not exported,
 * and in every function that runs
 *   - each mention is `A[k]`, k a constant inside the literal's count, outside
 *     any closure;
 *   - each read follows a store of that element on every path to it
 *     (summary/definite.js), so no call reads what another stored;
 *   - no call reaches a function that names the array, itself included, or a
 *     callee the program cannot name: between a store and its read nothing else
 *     writes the element.
 * A mention of any other form (an argument, a value, an index that is not
 * constant, a statement of the module) keeps the array.
 *
 * A local nothing reads goes first, with the stores of names and literals into
 * it: the result binding a spliced call leaves when its value is unused
 * (`inret = FRAC`) would be such a mention.
 *
 * @module compile/plan/scratch
 */
import { ctx } from '../../ctx.js'
import { T, MUTATE_OPS } from '../../ast.js'
import { freshId } from '../../ir.js'
import { constNumExpr } from '../../static.js'
import { definitelyAssigned } from '../../summary/definite.js'
import { setFuncBody } from '../analyze/body-facts.js'
import { isExported } from '../func-exports.js'

const isArr = Array.isArray
const numLit = (e) => isArr(e) && e[0] == null && typeof e[1] === 'number'
const inertValue = (e) => typeof e === 'string' || (isArr(e) && (e[0] == null || e[0] === 'str' || e[0] === 'bool'))

/** The functions that run: the host holds them, a value names them, a statement of the module calls them, or one that runs does. */
export const liveFunctions = (programFacts) => {
  const callees = new Map(), live = new Set()
  for (const cs of programFacts.callSites) {
    if (cs.callerFunc == null) live.add(cs.callee)
    else { let l = callees.get(cs.callerFunc.name); if (!l) callees.set(cs.callerFunc.name, l = []); l.push(cs.callee) }
  }
  for (const f of ctx.funcs.list) if (isExported(f) || programFacts.addressTakenNames.has(f.name) || f.raw) live.add(f.name)
  for (const work = [...live]; work.length;) for (const c of callees.get(work.pop()) ?? []) if (!live.has(c)) { live.add(c); work.push(c) }
  return { live, callees }
}

// `node` with `visit(child)` applied to every statement of every list in it, closures aside; a statement `visit` answers null for leaves its list.
const mapStatements = (n, visit) => {
  if (!isArr(n) || n[0] === '=>' || n[0] === 'str') return n
  let out = n
  const set = (i, c) => { if (c !== n[i]) { if (out === n) out = n.slice(); out[i] = c } }
  if (n[0] === ';') {
    const kept = [';']
    let changed = false
    for (let i = 1; i < n.length; i++) {
      const v = visit(n[i])
      if (v === null) { changed = true; continue }
      const c = mapStatements(v, visit)
      if (c !== n[i]) changed = true
      kept.push(c)
    }
    return changed ? kept : n
  }
  for (let i = 1; i < n.length; i++) set(i, mapStatements(n[i], visit))
  return out
}

/** `body` without the locals nothing reads, where all that is stored to them is names and literals. */
const dropUnreadLocals = (body) => {
  const declared = new Set(), read = new Set(), kept = new Set()
  const scan = (n, stmt) => {
    if (typeof n === 'string') { read.add(n); return }
    if (!isArr(n) || n[0] === 'str') return
    if (n[0] === 'let' || n[0] === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (typeof d === 'string') declared.add(d)
        else if (isArr(d) && d[0] === '=' && typeof d[1] === 'string') { declared.add(d[1]); if (!inertValue(d[2])) kept.add(d[1]); scan(d[2], false) }
        else scan(d, false)
      }
      return
    }
    // a store that is a statement of its own binds; any other mention reads
    if (n[0] === '=' && typeof n[1] === 'string' && stmt) { if (!inertValue(n[2])) kept.add(n[1]); scan(n[2], false); return }
    if (n[0] === '.' || n[0] === '?.') { scan(n[1], false); return }
    if (n[0] === ':') { scan(n[2], false); return }
    const list = n[0] === ';' || n[0] === '{}'
    for (let i = 1; i < n.length; i++) scan(n[i], list || ((n[0] === 'if' || n[0] === 'for' || n[0] === 'while' || n[0] === 'label') && i > 1))
  }
  scan(body, true)
  const dead = new Set([...declared].filter(name => !read.has(name) && !kept.has(name) && name.includes(T)))
  if (!dead.size) return body
  return mapStatements(body, (s) => {
    if (!isArr(s)) return s
    if (s[0] === '=' && dead.has(s[1])) return null
    if (s[0] !== 'let' && s[0] !== 'const') return s
    const rest = s.filter((d, i) => i === 0 || !(typeof d === 'string' ? dead.has(d) : isArr(d) && d[0] === '=' && dead.has(d[1])))
    return rest.length === s.length ? s : rest.length > 1 ? rest : null
  })
}

// Every mention of `name` in `n`: `on(node, place)` for an element access `A[k]` (place: 'read', 'store' or 'both'), `on(null)` for any other.
const mentions = (n, name, on, inArrow = false) => {
  if (n === name) { on(null); return }
  if (!isArr(n) || n[0] === 'str') return
  if (n[0] === '.' || n[0] === '?.') { mentions(n[1], name, on, inArrow); return }
  if (n[0] === ':') { mentions(n[2], name, on, inArrow); return }
  const arrow = inArrow || n[0] === '=>'
  const element = (e) => isArr(e) && e[0] === '[]' && e.length === 3 && e[1] === name
  if (MUTATE_OPS.has(n[0]) && element(n[1])) {
    if (arrow) on(null); else on(n[1], n[0] === '=' ? 'store' : 'both')
    mentions(n[1][2], name, on, arrow)
    for (let i = 2; i < n.length; i++) mentions(n[i], name, on, arrow)
    return
  }
  if (element(n)) { if (arrow) on(null); else on(n, 'read'); mentions(n[2], name, on, arrow); return }
  for (let i = 1; i < n.length; i++) mentions(n[i], name, on, arrow)
}

// A bitwise compound of a bare name is `x = x op v` once prepared; only a member keeps the compound form.
const BITWISE_ASSIGN = new Set(['&=', '|=', '^=', '<<=', '>>=', '>>>='])
// `n` with each `A[k]` the local `names[k]`: a read its name, a store a store to it.
const toLocals = (n, name, names) => {
  if (!isArr(n) || n[0] === 'str' || n[0] === '=>') return n
  if (n[0] === '[]' && n.length === 3 && n[1] === name) return names[constNumExpr(n[2])]
  let out = n
  for (let i = 1; i < n.length; i++) { const c = toLocals(n[i], name, names); if (c !== n[i]) { if (out === n) out = n.slice(); out[i] = c } }
  if (out !== n && BITWISE_ASSIGN.has(out[0]) && typeof out[1] === 'string') return ['=', out[1], [out[0].slice(0, -1), out[1], out[2]]]
  return out
}

export const scalarizeModuleScratch = (programFacts, ast) => {
  const consts = ctx.scope.consts, globals = ctx.scope.userGlobals
  if (!consts?.size || !globals?.size) return false
  const roots = [...(ctx.module.moduleInits || []), ast]
  const stmts = []
  const flatten = (n) => { if (isArr(n) && n[0] === ';') for (let i = 1; i < n.length; i++) flatten(n[i]); else if (n != null) stmts.push(n) }
  for (const r of roots) flatten(r)
  const hostRead = new Set(Object.entries(ctx.funcs.exports).map(([name, local]) => local === true ? name : local))

  // The candidates: `const A = [c0, c1, …]`, numbers all.
  const arrays = new Map()   // name → { count, decl }
  for (const s of stmts) {
    if (!isArr(s) || s[0] !== 'const' || s.length !== 2) continue
    const d = s[1]
    if (!isArr(d) || d[0] !== '=' || typeof d[1] !== 'string' || !isArr(d[2]) || d[2][0] !== '[') continue
    const elems = d[2].slice(1)
    if (!elems.length || elems.length > 16 || !elems.every(numLit)) continue
    if (consts.has(d[1]) && globals.has(d[1]) && !hostRead.has(d[1])) arrays.set(d[1], { count: elems.length, decl: s })
  }
  if (!arrays.size) return false
  // a statement of the module that names one, its declaration aside, holds it
  for (const s of stmts) for (const [name, a] of arrays) if (s !== a.decl) mentions(s, name, () => arrays.delete(name))
  if (!arrays.size) return false

  const { live, callees } = liveFunctions(programFacts)
  const funcs = ctx.funcs.list.filter(f => !f.raw && f.body && live.has(f.name))
  let changed = false
  // the result bindings the splices left
  const bodies = new Map()
  for (const f of funcs) {
    let named = false
    for (const name of arrays.keys()) mentions(f.body, name, () => { named = true })
    if (named) bodies.set(f, dropUnreadLocals(f.body))
  }
  const known = (callee) => typeof callee === 'string' && (ctx.funcs.map.has(callee) || ctx.core.emit[callee] != null)
  const opaque = (n) => isArr(n) && n[0] !== 'str' && ((n[0] === '()' && n.length > 2 && !known(n[1])) || n[0] === 'new' || n.some((c, i) => i > 0 && opaque(c)))

  for (const [name, a] of arrays) {
    const users = []
    let ok = true
    for (const f of funcs) {
      const body = bodies.get(f) ?? f.body
      let uses = 0
      mentions(body, name, (node) => {
        if (node === null) { ok = false; return }
        const k = constNumExpr(node[2])
        if (!Number.isInteger(k) || k < 0 || k >= a.count) ok = false
        uses++
      })
      if (f.defaults) for (const d of Object.values(f.defaults)) mentions(d, name, () => { ok = false })
      if (!ok) break
      if (uses) users.push(f)
    }
    if (!ok || !users.length) continue
    // no user reaches a user, and none calls what the program cannot name
    const userNames = new Set(users.map(f => f.name))
    const reaches = (from) => { const seen = new Set(), work = [...(callees.get(from) ?? [])]; while (work.length) { const c = work.pop(); if (userNames.has(c)) return true; if (seen.has(c)) continue; seen.add(c); work.push(...(callees.get(c) ?? [])) } return false }
    if (users.some(f => reaches(f.name) || opaque(bodies.get(f) ?? f.body))) continue
    const next = new Map()
    for (const f of users) {
      // named apart from the array: a name that begins with a module binding's reads as a member of it
      const id = freshId(ctx), names = Array.from({ length: a.count }, (_, k) => `${T}ms${id}e${k}`)
      const body = toLocals(bodies.get(f) ?? f.body, name, names)
      if (!isArr(body) || body[0] !== '{}' || body.length !== 2) { ok = false; break }
      const list = isArr(body[1]) && body[1][0] === ';' ? body[1].slice(1) : [body[1]]
      const local = ['{}', [';', ['let', ...names], ...list]]
      const assigned = definitelyAssigned(local)
      // an element the function never names is declared for nothing: only a named one must hold
      const used = new Set()
      const note = (n) => { if (typeof n === 'string') { if (names.includes(n)) used.add(n) } else if (isArr(n) && n[0] !== 'str') for (let i = 1; i < n.length; i++) note(n[i]) }
      note(['{}', [';', ...list]])
      if ([...used].some(n => !assigned.has(n))) { ok = false; break }
      next.set(f, ['{}', [';', ['let', ...names.filter(n => used.has(n))], ...list]])
    }
    if (!ok) continue
    for (const [f, body] of next) { bodies.set(f, body) }
    a.done = true
    changed = true
  }
  if (!changed) return false
  // Only the bodies of an array that went change; its declaration has no reader left (dropUnreadGlobals).
  const gone = [...arrays].filter(([, a]) => a.done).map(([name]) => name)
  for (const [f, body] of bodies) {
    let touched = false
    for (const name of gone) { let had = false; mentions(f.body, name, () => { had = true }); if (had) touched = true }
    if (touched && body !== f.body) setFuncBody(f, body)
  }
  return true
}
