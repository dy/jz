/**
 * A function whose parameter is only called runs, for a call that passes a
 * named function there, as a copy that calls that function by name.
 *
 * `around(t, dt, 0, step)` with `s += f(x)` in its loops: the argument is a
 * value, so every call of `f` is indirect (a table entry, a trampoline, its
 * arguments boxed) and `step` cannot inline into the loop. The copy
 * `around·step`, `f(x)` spelled `step(x)`, calls it directly, typed and
 * inlinable like any other call; `around(t, dt, 0.5, ramp)` gets its own.
 *
 * The parameter is read nowhere but as a callee and written nowhere (no
 * closure mentions it, no default fills it); the argument names a function
 * declaration nothing assigns and nothing in the function shadows, so the
 * name reads the same function in the copy as the value did. The copy's
 * sites pass `undefined` in its place: reading a function's name does
 * nothing, the signature stays, and a function no site passes as a value
 * any more is no value (it keeps no table entry, and splices like any
 * other callee).
 *
 * A string the function tests its parameter against (`type === 'square'`,
 * a mode chosen per call site) gets the same treatment: for a call passing a
 * string literal, a copy reads the literal where it read the parameter, so its
 * tests decide at compile time and the arms they rule out go. The parameter
 * is never written and no closure sees it, so every read of it is the
 * literal; a function called with more than a few strings keeps its one body.
 *
 * @module compile/plan/called-args
 */
import { ctx } from '../../ctx.js'
import { T, ASSIGN_OPS, callArgs, setCallArgs, some, walkAst } from '../../ast.js'
import { frameRoots } from '../../function.js'
import { materializeVariant } from '../variant.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'
import { clonePlain, collectBindings, nodeSize } from './common.js'

/** Whether every mention of `name` in `node` is a call's callee, the calls collected. */
const onlyCalled = (node, name, calls) => {
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node) || node[0] === 'str' || node[0] == null) return true
  if (node[0] === '=>') return !some(node, n => n.includes(name))
  if (node[0] === '.' || node[0] === '?.') return onlyCalled(node[1], name, calls)
  let i = 1
  if (node[0] === '()' && node[1] === name) { calls.push(node); i = 2 }
  for (; i < node.length; i++) if (!onlyCalled(node[i], name, calls)) return false
  return true
}

/** Names the program assigns anywhere: module code, every function body and default. */
const assignedNames = (ast) => {
  const out = new Set()
  const scan = (root) => walkAst(root, { enter: (n) => {
    if ((ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') && typeof n[1] === 'string') out.add(n[1])
  } })
  scan(ast)
  for (const mi of ctx.module.moduleInits || []) scan(mi)
  for (const f of ctx.funcs.list) if (f.body && !f.raw) for (const r of frameRoots(f)) scan(r)
  return out
}

const MAX_STRINGS = 6, MAX_BODY = 3000
const EQ_OPS = new Set(['===', '!==', '==', '!='])
const strOf = (n) => Array.isArray(n) && (n[0] === 'str' || n[0] == null) && n.length === 2 && typeof n[1] === 'string' ? n[1] : null

/** Whether `name` is never written in `node`, no closure mentions it, and some
 *  test compares it with a string literal. */
const testedString = (node, name) => {
  let tested = false, ok = true
  walkAst(node, { enter: (n) => {
    if (!ok) return false
    if (n[0] === '=>') { if (some(n, m => m.includes(name))) ok = false; return false }
    if ((ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') && n[1] === name) ok = false
    if (EQ_OPS.has(n[0]) && ((n[1] === name && strOf(n[2]) != null) || (n[2] === name && strOf(n[1]) != null))) tested = true
  } })
  return ok && tested
}

/** A copy of `node` with each read of `name` replaced by a copy of `value` (member and key names kept). */
const substituted = (node, name, value) => {
  if (node === name) return clonePlain(value)
  if (!Array.isArray(node)) return node
  if (node[0] === 'str' || node[0] == null) return node.slice()
  return node.map((c, i) => i === 0 || ((node[0] === '.' || node[0] === '?.') && i === 2) || (node[0] === ':' && i === 1) ? c : substituted(c, name, value))
}

/** The value of a test made of boolean literals, comparisons of two string
 *  literals, `!`, `&&` and `||`; null when any part is not one. */
const decided = (n) => {
  if (!Array.isArray(n)) return null
  if (n[0] == null && typeof n[1] === 'boolean') return n[1]
  if (EQ_OPS.has(n[0])) {
    const a = strOf(n[1]), b = strOf(n[2])
    return a == null || b == null ? null : (a === b) === (n[0] === '===' || n[0] === '==')
  }
  if (n[0] === '!') { const d = decided(n[1]); return d == null ? null : !d }
  if (n[0] === '&&' || n[0] === '||') {
    const a = decided(n[1]), b = decided(n[2])
    return n[0] === '&&' ? (a === false ? false : a === true ? b : null) : (a === true ? true : a === false ? b : null)
  }
  return null
}

/** Decide in place each `if` and `?:` whose test the literals settle, the arm taken
 *  (or nothing) in its place; a comparison of two string literals elsewhere is its boolean. */
const settle = (n) => {
  if (!Array.isArray(n)) return
  for (let j = 1; j < n.length; j++) {
    const c = n[j]
    if (!Array.isArray(c)) continue
    if (c[0] === 'if' || c[0] === '?:') {
      const t = decided(c[1])
      if (t != null) {
        const arm = (t ? c[2] : c[3]) ?? null
        if (arm == null && n[0] === ';' && n.length > 2) n.splice(j, 1)
        else n[j] = arm
        j--
        continue
      }
    }
    if (EQ_OPS.has(c[0]) && decided(c) != null) { n[j] = [null, decided(c)]; continue }
    settle(c)
  }
}

/** The body with each call of the parameter spelled as a call of `fn`. */
const spelled = (body, param, fn) => {
  const out = clonePlain(body)
  walkAst(out, { enter: (n) => { if (n[0] === '()' && n[1] === param) n[1] = fn } })
  return out
}

export const specializeCalledArgs = (programFacts, ast) => {
  if (ctx.transform.optimize?.specializeCalledArgs === false || !ctx.funcs.names?.size) return false
  // the parameters of each function that are only called: index → name
  const calledParams = new Map()
  const calledOf = (func) => {
    if (calledParams.has(func)) return calledParams.get(func)
    let out = null
    if (func.body && !func.raw && func.sig?.params) {
      const locals = new Set()
      collectBindings(func.body, locals)
      const small = nodeSize(func.body) <= MAX_BODY
      func.sig.params.forEach((p, k) => {
        if (p.name === func.rest || func.defaults?.[p.name] != null || locals.has(p.name)) return
        const calls = []
        if (onlyCalled(func.body, p.name, calls) && calls.length) (out ??= new Map()).set(k, { param: p.name, fn: true })
        else if (small && testedString(func.body, p.name)) (out ??= new Map()).set(k, { param: p.name, fn: false })
      })
      if (out) out.locals = locals
    }
    calledParams.set(func, out)
    return out
  }
  let assigned = null
  const groups = new Map()   // func → param → function name → sites
  for (const site of programFacts.callSites) {
    if (site.synthetic || site.argList.some(a => Array.isArray(a) && a[0] === '...')) continue
    const func = ctx.funcs.map.get(site.callee)
    const called = func && calledOf(func)
    if (!called) continue
    for (const [k, { param, fn: isFn }] of called) {
      const arg = site.argList[k]
      let fn
      if (isFn) {
        fn = arg
        if (typeof fn !== 'string' || fn === func.name || !ctx.funcs.names.has(fn) || called.locals.has(fn) ||
            func.sig.params.some(p => p.name === fn)) continue
        assigned ??= assignedNames(ast)
        if (assigned.has(fn)) continue
      } else if ((fn = strOf(arg)) == null) continue
      else fn = '"' + fn
      let byParam = groups.get(func)
      if (!byParam) groups.set(func, byParam = new Map())
      let byFn = byParam.get(param)
      if (!byFn) byParam.set(param, byFn = new Map())
      const list = byFn.get(fn)
      if (list) list.push(site); else byFn.set(fn, [site])
      break   // one parameter a copy: the copy's own sites take the next
    }
  }
  if (!groups.size) return false
  const called = (func, param) => func.sig.params.findIndex(p => p.name === param)
  const settled = (body) => { settle(body); return body }
  const touched = new Set()
  for (const [func, byParam] of groups) for (const [param, byFn] of byParam) {
    // a string copy each for a few strings only: past them, the one body
    const strings = [...byFn.keys()].filter(fn => fn[0] === '"')
    let n = 0
    for (const [fn, sites] of byFn) {
      const str = fn[0] === '"'
      if (str && strings.length > MAX_STRINGS) continue
      const name = str ? `${func.name}${T}s${param}${n++}` : `${func.name}${T}c${fn}`
      materializeVariant({
        origin: func, key: name, name, kind: str ? 'string-arg' : 'called-arg',
        body: str ? settled(substituted(func.body, param, sites[0].argList[called(func, param)])) : spelled(func.body, param, fn), eligibleSites: sites, fallback: func,
      })
      for (const site of sites) {
        if (!str) {
          const args = callArgs(site.node), k = called(func, param)
          args[k] = [null, undefined]; setCallArgs(site.node, args); site.argList[k] = args[k]
        }
        touched.add(site.callerFunc?.body ?? ast)
      }
    }
  }
  for (const body of touched) invalidateProgramFactsCache(body)
  invalidateBodies([...touched])
  return touched.size > 0
}
