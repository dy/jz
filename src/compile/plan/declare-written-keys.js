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
import { MUTATE_OPS, isBrand, isLiteralStr, isArrayIndexKey, walkAst, extractParams, collectParamNames } from '../../ast.js'
import { invalidateProgramFactsCache } from '../program-facts.js'

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

  let changed = false
  for (const [name, d] of defs) {
    if (d.other || !d.lits.length || dict.has(name)) continue
    if (ctx.schema.poisoned?.has(name) || ctx.schema.unknownInit?.has(name)) continue
    const keys = writes.get(name)
    if (!keys) continue
    for (const [lit, own] of d.lits) {
      const missing = [...keys].filter(k => !own.includes(k))
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
