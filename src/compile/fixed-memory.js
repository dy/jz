/** Fixed-memory exports: inferred scratch lifetimes and a final-code proof.
 * Scratch never escapes its binding. Owned module storage is reusable because
 * every selected call graph is closed, non-recursive and free of host calls.
 * This is a memory contract, not a wall-clock or host-marshalling guarantee.
 */
import { ctx, err } from '../ctx.js'
import { callArgs, walkAst, stmtList, refsName, isFunctionNode } from '../ast.js'
import { frameRoots } from '../function.js'
import { K, core, tagOf, tagsOf, bitOf } from '../summary/kind.js'
import { constIntExpr } from '../static.js'
import { typedElemCtor } from '../type.js'
import { valTypeOf } from '../kind.js'
import { VAL } from '../reps.js'
import { TYPED_ELEM_CODE } from '../../layout.js'
import { exportNamesOf, isExported } from './func-exports.js'
import { runtimeGraph } from './func-inspect.js'
import {
  scanBindingUses, USE, BINDING_USE_DECLS, BINDING_USE_INIT, BINDING_USE_USES,
  BINDING_USE_KIND, BINDING_USE_KEY, BINDING_USE_OP, BINDING_USE_CALLEE, BINDING_USE_ARG_INDEX,
} from './analyze-scans.js'

export function configureFixedMemory(names) {
  if (names == null) return
  if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !n.length))
    err('memory.fixed must be a non-empty array of export names')
  if (ctx.memory.shared) err('memory.fixed requires module-owned, unshared memory')
  ctx.memory.fixed = new Set(names)
  // A certification must not depend on a runtime reachability walk. Keep the
  // ordinary frame/loop rewinds for general exports in the same module.
  ctx.transform.optimize.arenaReach = false
  // Guarded-view specialization creates a descriptor. Keep the checked
  // receiver access so this optimization cannot introduce an allocation.
  ctx.transform.optimize.guardViews = false
}

const selected = func => {
  if (!ctx.memory.fixedFuncs) {
    const selected = ctx.memory.fixedFuncs = new Set(), pending = []
    for (const f of ctx.funcs.list) if (exportNamesOf(f.name).some(n => ctx.memory.fixed.has(n))) {
      pending.push(f)
      for (const v of f.boundaryVariants || []) pending.push(v.func)
    }
    while (pending.length) {
      const f = pending.pop()
      if (!f || selected.has(f.name)) continue
      selected.add(f.name)
      for (const name of f.frame?.callees || []) pending.push(ctx.funcs.map.get(name))
    }
  }
  return ctx.memory.fixedFuncs.has(func.name)
}

/** Run against the installed function facts, after all source rewrites. */
export function planFixedScratch(func) {
  if (!ctx.memory.fixed || !selected(func)) return
  const candidates = new Map()
  for (const [name, binding] of scanBindingUses(func.body)) {
    const init = binding[BINDING_USE_INIT], args = callArgs(init)
    const ctor = typedElemCtor(init)
    if (binding[BINDING_USE_DECLS] !== 1 || ctor == null || TYPED_ELEM_CODE[ctor.slice(4)] == null || args?.length !== 1) continue
    const len = constIntExpr(args[0])
    if (len == null || len < 0) continue
    // Buffer views, identity observations, aliases, captures, method calls and
    // reassignment all retain their normal allocation and fail certification.
    if (!binding[BINDING_USE_USES].every(u =>
      u[BINDING_USE_KIND] === USE.MEMBER_R && u[BINDING_USE_KEY] === 'length' ||
      (u[BINDING_USE_KIND] === USE.MEMBER_R || u[BINDING_USE_KIND] === USE.MEMBER_W) && u[BINDING_USE_OP] === '[]')) continue
    candidates.set(name, { init, len, key: `${ctor}:${len}` })
  }
  // An unknown computed key could be "buffer", exposing storage identity.
  walkAst(func.body, { enter: n => {
    if (n[0] === '=>') return false
    if (n[0] === '[]' && candidates.has(n[1]) && valTypeOf(n[2]) !== VAL.NUMBER)
      candidates.delete(n[1])
  } })
  // Whole top-level statements are the lifetime units: a loop or branch owns
  // its full span, so a back edge cannot reuse storage still read next round.
  // Equal layouts with disjoint spans share a slot, just like stack locals.
  const statements = stmtList(func.body), slots = [], placements = new Map()
  const spans = []
  for (const [name, candidate] of candidates) {
    let first = -1, last = -1
    for (let i = 0; i < statements.length; i++) if (refsName(statements[i], name)) {
      if (first < 0) first = i
      last = i
    }
    if (first >= 0) spans.push({ ...candidate, first, last })
  }
  spans.sort((a, b) => a.first - b.first)
  for (const span of spans) {
    let slot = slots.find(s => s.key === span.key && s.last < span.first)
    if (!slot) { slot = { key: span.key, len: span.len, last: span.last, owner: `$${func.name}` }; slots.push(slot) }
    slot.last = span.last
    placements.set(span.init, slot)
  }
  ctx.memory.scratch.set(func.sig, placements)
}

const prover = (records, allocation) => {
  const safe = new Set(), active = new Set()
  const visit = (name, path) => {
    if (active.has(name)) return `${path.join(' → ')}: recursive call`
    if (safe.has(name)) return null
    const rec = records.get(name)
    if (!rec || rec.unknown) return `${path.join(' → ')}: host or unresolved call`
    if (allocation && rec.allocation) return `${path.join(' → ')}: heap allocation or memory growth`
    if (name === '$__survive' || name.startsWith('$__reach')) return `${path.join(' → ')}: runtime reachability walk`
    active.add(name)
    for (const callee of rec.calls) {
      const reason = visit(callee, [...path, callee])
      if (reason) return reason
    }
    active.delete(name)
    safe.add(name)
    return null
  }
  return visit
}

/** The emitted owners and selected exports are all the final proof retains. */
export function fixedMemoryFacts() {
  if (!ctx.memory.fixed) return null
  const names = new Set(ctx.memory.fixed), owners = new Set()
  for (const f of ctx.funcs.list) if (exportNamesOf(f.name).some(n => names.has(n)))
    for (const v of f.boundaryVariants || []) names.add(v.exportName)
  for (const placements of ctx.memory.scratch.values()) for (const slot of placements.values())
    if (slot.offset != null) owners.add(slot.owner)
  return { names: [...names], owners: [...owners] }
}

/** Before Wasm inlining can erase a scratch owner's identity, prove its storage
 * safe in EVERY call context, including callers outside the selected exports. */
export function verifyFixedScratch(module, facts) {
  if (!facts) return
  const { records } = runtimeGraph(module, false), visit = prover(records, false)
  for (const owner of facts.owners) {
    if (!records.has(owner)) continue // no emitted body
    const reason = visit(owner, [owner])
    if (reason) throw new Error(`memory.fixed cannot certify ${reason}`)
  }
}

/** Validate final emitted code, including all helpers and boundary variants. */
export function verifyFixedMemory(module, facts) {
  if (!facts) return
  const memory = module.find(n => Array.isArray(n) && n[0] === 'memory')
  const limits = memory?.filter(n => typeof n === 'number')
  if (limits?.length > 1 && limits[0] > limits[1])
    throw new Error(`memory.fixed needs ${limits[0]} initial pages, exceeding memory.maximum (${limits[1]})`)
  const { exports, records } = runtimeGraph(module, false)
  const targets = new Map(exports), visit = prover(records, true)
  for (const name of facts.names) {
    const target = targets.get(name)
    if (!target) throw new Error(`memory.fixed: '${name}' is not a function export`)
    const reason = visit(target, [name])
    if (reason) throw new Error(`memory.fixed cannot certify ${reason}`)
  }
}

// === Static locals in ordinary code (optimize.staticLocals) ===
//
// A typed array a function makes at a literal length and keeps to itself
// (`const table = new Int32Array(256)` in `main`, read and written there and
// in the functions it is handed to) needs no heap block per call: one static
// block, zeroed where the declaration runs, serves every call, and its address
// is a constant every access folds into its offset. Sound where the array
// goes nowhere but element reads and writes, its length, and parameters that
// do the same (no alias, no capture, no return, no store), and where no
// second activation of the function can reach the block while the first
// holds it: from the declaration to the array's last use, every call reaches
// only the program's own functions (none of them the owner) and the
// compiler's builtins, never a host import or a closure value that could call
// back in. A parameter every call passes one such array reads the array's
// constant address in turn (its value is that address on every call).

const STATIC_MAX = 65536   // module/typedarray.js STATIC_TYPED_MAX_BYTES: what the static writer places
const WIDTH = [1, 1, 2, 2, 4, 4, 4, 8]
// builtin methods that take no closure and run no code of the program's
const QUIET_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'fill', 'set', 'slice', 'subarray', 'indexOf', 'lastIndexOf',
  'includes', 'at', 'join', 'concat', 'reverse', 'copyWithin', 'charCodeAt', 'codePointAt', 'charAt', 'substring',
  'startsWith', 'endsWith', 'trim', 'padStart', 'padEnd', 'repeat', 'toFixed', 'keys', 'values', 'entries', 'has', 'get', 'add', 'delete', 'clear'])
const BUILTIN_RECEIVERS = new Set([K.TYPED, K.ARRAY, K.STRING, K.NUMBER, K.MAP, K.SET])
// builtins that call none of their arguments: they read numbers and strings,
// or print (an implicit conversion aside, which planStaticLocals declines)
const QUIET_CALLEES = /^([Mm]ath\.\w+|Number(\.\w+)?|String(\.fromCharCode|\.fromCodePoint)?|Boolean|isNaN|isFinite|parseInt|parseFloat|Date\.now|performance\.now|console\.\w+|Atomics\.\w+|Array\.isArray|ArrayBuffer\.isView|Object\.(is|hasOwn))$/
// constructors that make storage of plain arguments and run nothing else
const QUIET_CTORS = /^(Array|Map|Set|Date|Error|TypeError|RangeError|ArrayBuffer|DataView|(Int|Uint|Float|BigInt|BigUint)(8|16|32|64)(Clamped)?Array|Float16Array)$/
// what an iterable argument can be without a program's iterator to call
const PLAIN = [K.NUMBER, K.STRING, K.BOOL, K.BIGINT, K.NULLISH, K.ABSENT, K.TYPED, K.ARRAY, K.BUFFER].reduce((m, t) => m | bitOf(t), 0)
const bound = (name) => ctx.funcs.map.has(name) || ctx.scope.globals?.has(name)
const isArr = Array.isArray

/** A constant-length typed array of elements: `{ ctor, len, bytes }`, or null. */
const fixedTyped = (init) => {
  const ctor = typedElemCtor(init), args = callArgs(init)
  if (ctor == null || args?.length !== 1) return null
  const name = ctor.slice(4), code = TYPED_ELEM_CODE[name]
  if (code == null) return null
  const len = constIntExpr(args[0])
  if (len == null || len < 0) return null
  const bytes = len * WIDTH[code]
  return bytes <= STATIC_MAX ? { ctor: name, len, bytes } : null
}

/** Plan static locals for every function before any is emitted: the
 *  declarations each owner places (`ctx.memory.scratch`) and the parameters
 *  whose every call passes one placed array (`ctx.memory.staticParams`). */
export function planStaticLocals() {
  ctx.memory.staticParams = new Map()
  const opt = ctx.transform.optimize
  if (ctx.memory.fixed || ctx.memory.shared || !opt || opt.staticLocals === false) return
  // an implicit conversion or accessor runs code of the program's no call names
  if (ctx.transform.userConversions !== false || ctx.transform.accessorNames?.size) return
  const fn = name => { const f = typeof name === 'string' ? ctx.funcs.map.get(name) : null; return f && !f.raw && f.body ? f : null }
  // The program's direct calls, read off the bodies as they stand, and the
  // functions named anywhere but as a callee (a value: any call may reach them).
  const sitesOf = new Map(), valued = new Set()
  const scan = (root, caller) => walkAst(root, { enter: (n, parent, at) => {
    if (n[0] === '()' && typeof n[1] === 'string' && fn(n[1])) {
      let l = sitesOf.get(n[1]); if (!l) sitesOf.set(n[1], l = [])
      l.push({ caller, args: callArgs(n) ?? [] })
    }
    for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string' && !(n[0] === '()' && i === 1) && fn(n[i])) valued.add(n[i])
  } })
  for (const root of ctx.module.moduleInits ?? []) scan(root, null)
  for (const f of ctx.funcs.list) if (!f.raw && f.body) for (const r of frameRoots(f)) scan(r, f)

  const kindIn = (f, e) => { try { return ctx.summary?.at(f.sig ?? f.body)?.kindOfExpr(e) ?? null } catch { return null } }
  // every computed key of `name` in `f` a number: a string could name `buffer`
  const numericKeys = (f, name) => {
    let ok = true
    for (const r of frameRoots(f)) walkAst(r, { enter: n => {
      if (!ok || n[0] === '=>') return false
      if (n[0] === '[]' && n[1] === name && n.length === 3 && !(isArr(n[2]) && n[2][0] == null && typeof n[2][1] === 'number')) {
        const k = kindIn(f, n[2])
        if (k == null || tagOf(core(k)) !== K.NUMBER) ok = false
      }
    } })
    return ok
  }
  // `name` in `f` is storage alone: element reads and writes, its length, and parameters that are too
  const storage = new Map()
  const storageUses = (f, name, seen) => {
    const b = scanBindingUses(f.body).get(name)
    if (b && !b[BINDING_USE_USES].every(u => {
      const kind = u[BINDING_USE_KIND]
      if (kind === USE.MEMBER_R && u[BINDING_USE_KEY] === 'length') return true
      if ((kind === USE.MEMBER_R || kind === USE.MEMBER_W) && u[BINDING_USE_OP] === '[]') return true
      return kind === USE.CALL_ARG && storageParam(u[BINDING_USE_CALLEE], u[BINDING_USE_ARG_INDEX], seen)
    })) return false
    return numericKeys(f, name)
  }
  const storageParam = (name, k, seen) => {
    const key = name + ':' + k
    if (storage.has(key)) return storage.get(key)
    if (seen.has(key)) return true   // a cycle of hand-offs adds no use
    seen.add(key)
    const f = fn(name), p = f?.sig?.params?.[k]?.name
    const ok = !!f && typeof p === 'string' && !isExported(f) && !valued.has(name) && f.rest !== p &&
      !Object.values(f.defaults ?? {}).some(d => refsName(d, p)) && storageUses(f, p, seen)
    storage.set(key, ok)
    return ok
  }

  // What a call reaches: the program's functions (`callees`), or code that
  // could call any function back (`loud`: a host import, a closure value, a
  // builtin handed a closure, a method no builtin receiver answers, a suspension).
  const callees = new Map(), loud = new Set()
  const plain = (f, e) => { const k = kindIn(f, e); return k != null && (tagsOf(k) & ~PLAIN) === 0 }
  const loudCall = (f, n) => {
    const callee = n[1], args = callArgs(n) ?? []
    if (args.some(a => isFunctionNode(a) || fn(a))) return true   // a closure handed on runs somewhere
    if (typeof callee === 'string') {
      if (fn(callee)) return false
      if (ctx.scope.globals?.has(callee)) return true   // a binding that may hold a closure
      // a host import may call back, but one declared under a standard
      // global's name (`imports: { performance: { now } }`, spelled
      // `performance$now`) is that global
      if (ctx.funcs.map.has(callee)) return !(callee.includes('$') && QUIET_CALLEES.test(callee.replace('$', '.')))
      if (callee.startsWith('new.')) return !QUIET_CTORS.test(callee.slice(4)) || !args.every(a => plain(f, a))
      return !QUIET_CALLEES.test(callee)
    }
    if (isArr(callee) && (callee[0] === '.' || callee[0] === '?.') && typeof callee[2] === 'string') {
      const recv = callee[1]
      if (typeof recv === 'string' && !bound(recv) && QUIET_CALLEES.test(recv + '.' + callee[2])) return false
      if (!QUIET_METHODS.has(callee[2])) return true
      const k = kindIn(f, recv)
      return !(k != null && BUILTIN_RECEIVERS.has(tagOf(core(k))))
    }
    return true
  }
  const calls = (f, node, into) => {
    let quiet = true
    walkAst(node, { enter: n => {
      if (isFunctionNode(n)) return false
      if (n[0] === 'yield' || n[0] === 'await') quiet = false
      if (n[0] !== '()' && n[0] !== '?.()') return
      if (typeof n[1] === 'string' && fn(n[1])) into.add(n[1])
      else if (loudCall(f, n)) quiet = false
    } })
    return quiet
  }
  for (const f of ctx.funcs.list) {
    if (f.raw || !f.body) continue
    const into = new Set()
    if (!frameRoots(f).every(r => calls(f, r, into))) loud.add(f.name)
    callees.set(f.name, into)
  }
  // a function calling a loud one is loud
  for (let grew = true; grew;) {
    grew = false
    for (const [name, into] of callees) if (!loud.has(name) && [...into].some(c => loud.has(c))) { loud.add(name); grew = true }
  }
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true
    if (seen.has(from)) return false
    seen.add(from)
    for (const c of callees.get(from) ?? []) if (reaches(c, target, seen)) return true
    return false
  }
  // `node` of `owner` calls nothing that could call `owner` back
  const quietIn = (owner, node) => {
    const into = new Set()
    return calls(owner, node, into) && [...into].every(c => !loud.has(c) && !reaches(c, owner.name))
  }

  // The owners' placements.
  const placed = new Map()   // function → binding or parameter → slot
  for (const F of ctx.funcs.list) {
    if (F.raw || !F.body) continue
    const candidates = []
    for (const [name, b] of scanBindingUses(F.body)) {
      const init = b[BINDING_USE_INIT], t = b[BINDING_USE_DECLS] === 1 ? fixedTyped(init) : null
      if (t && storageUses(F, name, new Set())) candidates.push({ name, init, ...t, key: `${t.ctor}:${t.len}` })
    }
    if (!candidates.length) continue
    const statements = stmtList(F.body), spans = []
    for (const c of candidates) {
      let first = -1, last = -1
      for (let i = 0; i < statements.length; i++) if (refsName(statements[i], c.name)) { if (first < 0) first = i; last = i }
      if (first >= 0 && statements.slice(first, last + 1).every(st => quietIn(F, st))) spans.push({ ...c, first, last })
    }
    if (!spans.length) continue
    // Whole statements are the lifetime units: equal layouts with disjoint spans share a slot.
    spans.sort((a, b) => a.first - b.first)
    const slots = [], placements = new Map(), names = new Map()
    for (const span of spans) {
      let slot = slots.find(s => s.key === span.key && s.last < span.first)
      if (!slot) { slot = { key: span.key, ctor: span.ctor, len: span.len, bytes: span.bytes, last: span.last, owner: `$${F.name}` }; slots.push(slot) }
      slot.last = span.last
      placements.set(span.init, slot)
      names.set(span.name, slot)
    }
    ctx.memory.scratch.set(F.sig, placements)
    placed.set(F, names)
  }
  if (!placed.size) return

  // A parameter every call passes one placed array (or such a parameter) holds its address.
  for (let changed = true; changed;) {
    changed = false
    for (const [name, list] of sitesOf) {
      const G = fn(name)
      if (!G || isExported(G) || valued.has(name) || !G.sig?.params) continue
      for (let k = 0; k < G.sig.params.length; k++) {
        const p = G.sig.params[k]?.name
        if (typeof p !== 'string' || placed.get(G)?.has(p) || !storageParam(name, k, new Set())) continue
        let slot = null
        for (const site of list) {
          const a = site.args[k], s = site.caller && typeof a === 'string' ? placed.get(site.caller)?.get(a) : null
          if (!s || (slot && s !== slot)) { slot = null; break }
          slot = s
        }
        if (!slot) continue
        let mine = placed.get(G); if (!mine) placed.set(G, mine = new Map())
        mine.set(p, slot)
        let sp = ctx.memory.staticParams.get(G.sig); if (!sp) ctx.memory.staticParams.set(G.sig, sp = new Map())
        sp.set(p, slot)
        changed = true
      }
    }
  }
}
