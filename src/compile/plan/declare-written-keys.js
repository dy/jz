/**
 * Declare literal-key writes in the literal they extend.
 *
 * A binding whose every value is a static object literal (`let o = { a: 1 }`,
 * a function property the plan flattened to a module global) is a record of
 * that literal's layout. A literal-key write outside the layout (`o.b = 2`,
 * `o['#!'] = v`, from any function, bundled module initializer or default
 * value) would otherwise land beside the record in the dynamic sidecar: every
 * read and write of the key probes at runtime, and each enumeration merges the
 * sidecar back in. Declaring the key in the literal (`{ a: 1, b: undefined }`)
 * gives it a slot, so the whole program — summary, layout censuses, emitters —
 * sees one closed layout. jz reads a declared slot as an own property before
 * its first store (the auto-boxed `let` merge, scope.js
 * materializeAutoBoxSchemas, has done so for dot writes on declared globals);
 * this pass applies that model to every literal-bound name, bracket-string
 * keys and module initializers included.
 *
 * Left alone, by design: an empty literal (`{}` is the dictionary idiom,
 * module/object.js), a literal with a spread, computed key or class brand,
 * array-index keys (`o['0']`: canonical slot order), `length` and `__proto__`
 * (structural names, never fields), a name that takes a computed-key write or
 * an Object.assign (a dictionary: its keys and their order are runtime facts,
 * and a declared slot would enumerate before the keys written before it), and
 * any name that also takes a non-literal value (a parameter, a call result, a
 * destructuring target, an alias): a write through such a name may reach an
 * object of another layout.
 *
 * @module compile/plan/declare-written-keys
 */

import { ctx } from '../../ctx.js'
import { MUTATE_OPS, isBrand, isLiteralStr, isArrayIndexKey, walkAst, some, extractParams, collectParamNames, refsName, REFS_IN_EXPR } from '../../ast.js'
import { invalidateProgramFactsCache } from '../program-facts.js'
import { transitiveFrameEffects } from '../analyze/frame-effects.js'

const STRUCTURAL = new Set(['length', '__proto__'])

/** The keys of a static, non-empty object literal, or null. */
const literalKeys = (n) => {
  if (!Array.isArray(n) || n[0] !== '{}' || n.length < 2) return null
  const keys = []
  for (let i = 1; i < n.length; i++) {
    const p = n[i]
    const key = typeof p === 'string' ? p : Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string' ? p[1] : null
    if (key === null || isBrand(key)) return null
    keys.push(key)
  }
  return keys
}

export const declareWrittenKeys = (ast) => {
  if (!ctx.schema.register) return false
  const defs = new Map()     // name → { lits: [[node, keys]], other }
  const writes = new Map()   // name → Set<key>, in program order
  const dict = new Set()     // names with a computed-key write or an Object.assign
  const other = (name) => {
    if (typeof name !== 'string') return
    const d = defs.get(name)
    if (d) d.other = true; else defs.set(name, { lits: [], other: true })
  }
  const def = (name, rhs) => {
    const keys = literalKeys(rhs)
    if (!keys) return other(name)
    let d = defs.get(name)
    if (!d) defs.set(name, d = { lits: [], other: false })
    d.lits.push([rhs, keys])
  }
  const write = (name, key) => {
    if (STRUCTURAL.has(key) || isArrayIndexKey(key)) return
    let s = writes.get(name)
    if (!s) writes.set(name, s = new Set())
    s.add(key)
  }
  // Every name a pattern binds (its property keys too: a harmless surplus).
  const patternNames = (t) => {
    if (typeof t === 'string') return other(t)
    walkAst(t, { enter: n => { for (let i = 1; i < n.length; i++) other(n[i]) } })
  }
  const census = (root) => walkAst(root, { enter: (n) => {
    const op = n[0]
    if (MUTATE_OPS.has(op)) {
      const t = n[1]
      if (typeof t === 'string') { if (op === '=' || op === '??=') def(t, n[2]); else other(t) }
      else if (Array.isArray(t)) {
        if (t[0] === '.' && typeof t[1] === 'string' && typeof t[2] === 'string') write(t[1], t[2])
        else if (t[0] === '[]' && t.length === 3 && typeof t[1] === 'string') { if (isLiteralStr(t[2])) write(t[1], t[2][1]); else dict.add(t[1]) }
        else if (t[0] === '{}' || (t[0] === '[]' && t.length !== 3)) patternNames(t)
      }
    }
    else if (op === '()' && n[1] === 'Object.assign') { const t = Array.isArray(n[2]) && n[2][0] === ',' ? n[2][1] : n[2]; if (typeof t === 'string') dict.add(t) }
    else if (op === '=>') for (const p of collectParamNames(extractParams(n[1]))) other(p)
    else if (op === 'catch') { other(n[1]); other(n[2]) }
    else if (op === 'for-of' || op === 'for-in' || op === 'for-await')
      patternNames(Array.isArray(n[1]) && (n[1][0] === 'let' || n[1][0] === 'const' || n[1][0] === 'var') ? n[1][1] : n[1])
  } })
  census(ast)
  for (const init of ctx.module.moduleInits ?? []) census(init)
  for (const fn of ctx.funcs.list) {
    for (const p of fn.sig?.params ?? []) other(p.name)
    if (fn.rest) other(fn.rest)
    if (fn.body && !fn.raw) census(fn.body)
    if (fn.defaults) for (const v of Object.values(fn.defaults)) census(v)
  }

  // A key may only be declared in the literal when its store is DEFINITE: it
  // runs before anything can observe the object. Declared, a key is an own
  // property from the literal on — `in`, hasOwnProperty, Object.keys, for-in
  // and JSON all say so — and a store that may not have run yet made them
  // say so falsely. Definite: a statement-level `name.k = v` / `name['k'] = v`
  // in the same statement list as the binding, with nothing between them that
  // could run other code — no call, no loop, no branch, no try — since without
  // a call no closure runs and no enumeration happens. A store anywhere else
  // is conditional, keeps its key out of the literal, and lands in the dyn
  // sidecar as before, which every observer already reads at runtime.
  const definite = new Map()   // literal node → Set<key>
  // Anything that can run other code or ask an object about its keys: a call
  // (`Object.keys`, `hasOwnProperty`, JSON, a closure), `in`, a spread, a
  // deletion, or control flow that makes what follows conditional. A plain
  // definition or assignment of a value that holds none of these runs nothing.
  // `some` stops at an arrow: a function is not run by being defined.
  const OBSERVES = new Set(['()', 'new', 'in', '...', 'delete', 'if', '?:', 'try', 'switch', 'for', 'for-of', 'for-in', 'for-await',
    'while', 'do', '&&', '||', '??', 'await', 'yield', 'return', 'throw', 'break', 'continue'])
  // (a direct call is the one observer `blind` below can see through)
  const funcs = ctx.funcs?.map
  const observes = (n) => Array.isArray(n) && OBSERVES.has(n[0])
  const storeOf = (st) => {
    if (!Array.isArray(st) || st[0] !== '=' || !Array.isArray(st[1])) return null
    const t = st[1]
    if (t[0] === '.' && typeof t[1] === 'string' && typeof t[2] === 'string') return [t[1], t[2]]
    if (t[0] === '[]' && t.length === 3 && typeof t[1] === 'string' && isLiteralStr(t[2])) return [t[1], t[2][1]]
    return null
  }
  const bindingOf = (st) => {
    if (!Array.isArray(st)) return null
    if ((st[0] === '=' || st[0] === '??=') && typeof st[1] === 'string' && literalKeys(st[2])) return [st[1], st[2]]
    if ((st[0] === 'let' || st[0] === 'const' || st[0] === 'var') && st.length === 2 && Array.isArray(st[1]) && st[1][0] === '=' && typeof st[1][1] === 'string' && literalKeys(st[1][2])) return [st[1][1], st[1][2]]
    return null
  }
  // A statement between a literal and its store observes nothing when its only
  // observers are direct calls that cannot reach the literal: the operator
  // registrations between a bundled parser's `parse.comment ??= {…}` and a
  // later module's `parse.comment['#!'] = …`. The frame census
  // (analyze/frame-effects.js) says what a call reaches: every known function
  // it runs, and whether it runs any it cannot name. A fresh literal is
  // reachable through its name alone, so a call reaches it only when a
  // reached function mentions the name (its body, or a parameter default).
  // A closure defined in the statement is not run by being defined; a callee
  // that runs it is one the census cannot name.
  let frames = null
  const mentions = (fname, names) => {
    const fn = funcs?.get(fname)
    return !fn?.body || names.some(n => refsName(fn.body, n, REFS_IN_EXPR) || Object.values(fn.defaults ?? {}).some(d => refsName(d, n, REFS_IN_EXPR)))
  }
  const reaches = (callee, names) => {
    const f = (frames ??= transitiveFrameEffects(ctx.funcs.list)).get(callee)
    return !f || f.callsUnknown || mentions(callee, names) || [...f.callees].some(c => mentions(c, names))
  }
  const blind = (st, names) => {
    let ok = true
    const visit = (n) => {
      if (!ok || !Array.isArray(n)) return
      const op = n[0]
      if (op === '=>' || op === 'str') return
      if (op === '()') {
        if (typeof n[1] !== 'string' || reaches(n[1], names)) { ok = false; return }
        for (let i = 2; i < n.length; i++) visit(n[i])
        return
      }
      if (OBSERVES.has(op)) { ok = false; return }
      for (let i = 1; i < n.length; i++) visit(n[i])
    }
    visit(st)
    return ok
  }
  const stmtList = (list) => {
    const pending = new Map()   // name → literal node, bound in this list and unobserved since
    for (const st of list) {
      const store = storeOf(st), bound = store ? null : bindingOf(st)
      // Any other mention of a pending name – an alias, an argument, a computed
      // store, a value of another literal – carries its literal where this
      // cannot follow; a key declared after a computed store would also sit
      // ahead of it in the layout (for-in enumerates a layout's keys before
      // the keys added at run time, emit/control-flow.js).
      for (const name of [...pending.keys()]) if (name !== store?.[0] && name !== bound?.[0] && refsName(st, name, REFS_IN_EXPR)) pending.delete(name)
      if (store && pending.has(store[0])) {
        // the value is evaluated before the store: if it observes, the store is not first
        if (some(st[2], observes)) { pending.clear(); continue }
        const [name, key] = store
        if (!STRUCTURAL.has(key) && !isArrayIndexKey(key)) { const lit = pending.get(name); let set = definite.get(lit); if (!set) definite.set(lit, set = new Set()); set.add(key) }
        continue
      }
      if (bound) { if (some(bound[1], observes)) pending.clear(); else pending.set(bound[0], bound[1]); continue }
      // A definition, or an assignment of a value that runs nothing, keeps the
      // literals pending; so does a statement whose only observers are calls
      // that cannot reach them.
      if (!some(st, observes)) continue
      if (pending.size && blind(st, [...pending.keys()])) continue
      pending.clear()
      walkLists(st)
    }
  }
  const walkLists = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === ';') return stmtList(n.slice(1))
    if (n[0] === '{}' && n.length === 2) return walkLists(n[1])
    for (let i = 1; i < n.length; i++) walkLists(n[i])
  }
  // Module initializers run in order, then the entry module (start-fn.js emits
  // exactly that sequence), before any export can be called: one statement
  // list. A bundled `parse.comment['#!'] = …` in a later module's initializer
  // is as definite as the same store on the next line.
  const stmtsOf = (n) => Array.isArray(n) && n[0] === ';' ? n.slice(1) : Array.isArray(n) && n[0] === '{}' && n.length === 2 ? stmtsOf(n[1]) : [n]
  stmtList([...(ctx.module.moduleInits ?? []).flatMap(stmtsOf), ...stmtsOf(ast)])
  for (const fn of ctx.funcs.list) if (fn.body && !fn.raw) walkLists(fn.body)

  let changed = false
  for (const [name, d] of defs) {
    if (d.other || !d.lits.length || dict.has(name)) continue
    if (ctx.schema.poisoned?.has(name) || ctx.schema.unknownInit?.has(name)) continue
    const keys = writes.get(name)
    if (!keys) continue
    for (const [lit, own] of d.lits) {
      const sure = definite.get(lit)
      const missing = [...keys].filter(k => !own.includes(k) && sure?.has(k))
      if (!missing.length) continue
      for (const k of missing) lit.push([':', k, [, undefined]])
      own.push(...missing)
      changed = true
    }
    // One layout for every value of the name: the bound schema the per-name
    // slot paths read (ctx.schema.idOf), as prepare binds a declared literal
    // (a binding prepare made keeps its order and gains the declared keys). A
    // flattened function property was never a bare name to prepare; unbound,
    // materializeAutoBoxSchemas would box it like a function namespace and its
    // dot writes would land in the box's slots over the object's own.
    const layouts = new Set(d.lits.map(([, own]) => ctx.schema.register(own)))
    if (layouts.size !== 1) continue
    const bound = ctx.schema.vars.has(name) ? ctx.schema.list[ctx.schema.vars.get(name)] : null
    const own = d.lits[0][1]
    ctx.schema.vars.set(name, bound ? ctx.schema.register([...bound, ...own.filter(k => !bound.includes(k))]) : [...layouts][0])
  }
  if (changed) invalidateProgramFactsCache(ast)
  return changed
}
