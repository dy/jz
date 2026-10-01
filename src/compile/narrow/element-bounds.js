/**
 * Closed index buffers: every present element is an index into its own array.
 * Zero initialization, stores of an element's own index, and same-array copies
 * preserve that invariant. Direct helper parameters share the complete writer
 * census; any other writer or escape rejects the entire alias component.
 *
 * Equal runtime allocation sizes then let a present index-buffer read address
 * another array. This is a relation, not a numeric interval or a fixed length.
 * Only exact access occurrences are published to the existing bounds-proof sink.
 */
import { ctx, getFactStore } from '../../ctx.js'
import { walkAst, callArgs, MUTATE_OPS } from '../../ast.js'
import { frameNode } from '../../function.js'
import { NUMBER, isNullable } from '../../summary/kind.js'
import { typedCtorBase, typedElementKey } from '../../typed-provenance.js'
import { scanBoundedArrIdx } from '../../type/canonical-bounds.js'
import { isExported } from '../func-exports.js'
import {
  scanBindingUses, USE, BINDING_USE_DECLS, BINDING_USE_INIT, BINDING_USE_USES,
  BINDING_USE_KIND, BINDING_USE_KEY, BINDING_USE_OP, BINDING_USE_CALLEE, BINDING_USE_ARG_INDEX,
} from '../analyze-scans.js'

const CTORS = new Set(['new.Int8Array', 'new.Uint8Array', 'new.Uint8ClampedArray',
  'new.Int16Array', 'new.Uint16Array', 'new.Int32Array', 'new.Uint32Array',
  'new.Float32Array', 'new.Float64Array'])
// Int32's element count is at most 2^30 in memory32. Its valid indices fit
// signed i32 and therefore never wrap when stored back to an Int32Array.
// Unsigned/clamped stores of a nonnegative integer can only lower its value.
const INDEX_CTORS = new Set(['new.Int32Array', 'new.Uint8Array', 'new.Uint8ClampedArray', 'new.Uint16Array', 'new.Uint32Array'])
const PURE = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>', 'u+', 'u-'])
const literal = n => typeof n === 'number' ? n
  : Array.isArray(n) && n[0] == null && typeof n[1] === 'number' ? n[1] : null
const unwrap = n => Array.isArray(n) && n.length === 2 && n[0] === 'u+' ? unwrap(n[1]) : n

/** Add relational occurrence proofs after signature narrowing has settled. */
export function proveElementBounds(programFacts) {
  const { callSites, paramReps, programIndex } = programFacts
  const bodies = new Map(), rows = [], incoming = new Map()
  for (const site of callSites) {
    let sites = incoming.get(site.callee)
    if (!sites) incoming.set(site.callee, sites = [])
    sites.push(site)
  }
  for (const f of ctx.funcs.list) {
    if (!f.body || f.raw) continue
    const params = f.sig.params, uses = scanBindingUses(frameNode(f), new Set(params.map(p => p.name)))
    const view = ctx.summary.at(f.sig), arrays = new Map()
    const stable = name => {
      const s = uses.get(name)
      return !!s && !s[BINDING_USE_USES].some(u => u[BINDING_USE_KIND] === USE.REASSIGN || u[BINDING_USE_KIND] === USE.CAPTURE)
        && (s[BINDING_USE_DECLS] === 1 || params.some(p => p.name === name))
    }
    const add = (name, ctor, size, param = -1) => {
      if (!CTORS.has(ctor) || !stable(name) || isNullable(view.kindOfExpr(name))) return
      const r = { f, name, ctor, size, param, links: [], good: INDEX_CTORS.has(ctor), fresh: param < 0 }
      arrays.set(name, r); rows.push(r)
    }
    for (let k = 0; k < params.length; k++) {
      const p = params[k], r = paramReps.get(f.name)?.get(k)
      if (f.defaults || f.rest || p.rest || isExported(f) || programIndex.addressTaken.has(f.name)) continue
      add(p.name, typedCtorBase(r?.typedCtor), null, k)
    }
    for (const [name, s] of uses) {
      const init = s[BINDING_USE_INIT]
      if (s[BINDING_USE_DECLS] !== 1 || !Array.isArray(init) || init[0] !== '()' || !CTORS.has(init[1])) continue
      const args = callArgs(init)
      if (args.length === 1 && view.kindOfExpr(args[0]) === NUMBER) add(name, init[1], args[0])
    }
    bodies.set(f, { arrays, uses, view, stable })
  }
  if (!rows.some(r => r.fresh && r.good)) return 0
  const rowAt = (f, name) => typeof name === 'string' ? bodies.get(f)?.arrays.get(name) : null
  const link = (a, b) => { a.links.push(b); b.links.push(a) }
  // Every incoming argument must be one of the enumerated allocations/params.
  // Edges are aliases, so a writer or escape in either frame rejects both.
  for (const r of rows) if (!r.fresh) {
    const sites = incoming.get(r.f.name)
    if (!sites?.length) r.good = false
    for (const site of sites ?? []) {
      const a = !site.synthetic && rowAt(site.callerFunc, site.argList[r.param])
      if (!a) r.good = false
      else link(r, a)
    }
  }
  for (const [f, b] of bodies) {
    const elementKey = e => typedElementKey(e, b.view.kindOfExpr(e) === NUMBER)
    for (const r of b.arrays.values()) for (const u of b.uses.get(r.name)[BINDING_USE_USES]) {
      const kind = u[BINDING_USE_KIND]
      if (kind === USE.MEMBER_R && (u[BINDING_USE_OP] === '[]' || u[BINDING_USE_KEY] === 'length')) continue
      if (kind === USE.MEMBER_W && u[BINDING_USE_OP] === '[]') continue
      if (kind === USE.CALL_ARG) {
        const target = ctx.funcs.map.get(u[BINDING_USE_CALLEE])
        const param = rowAt(target, target?.sig.params[u[BINDING_USE_ARG_INDEX]]?.name)
        if (param && r.links.includes(param)) continue
      }
      r.good = false
    }
    walkAst(frameNode(f), { enter: n => {
      if (n[0] === '=>') return false
      // An unknown computed property could expose .buffer, not an element.
      if (n[0] === '[]') {
        const r = b.arrays.get(n[1])
        if (r && !elementKey(n[2])) r.good = false
      }
      if (!MUTATE_OPS.has(n[0]) || !Array.isArray(n[1]) || n[1][0] !== '[]') return
      const [, a, i] = n[1], r = b.arrays.get(a)
      if (!r) return
      const value = unwrap(n[2])
      const ownIndex = typeof i === 'string' && value === i && b.view.kindOfExpr(i) === NUMBER
      const selfCopy = Array.isArray(value) && value[0] === '[]' && value[1] === a && elementKey(value[2])
      if (n[0] !== '=' || !(literal(value) === 0 || ownIndex || selfCopy)) r.good = false
    } })
  }
  const visited = new Set()
  for (const root of rows) {
    if (visited.has(root)) continue
    const component = [root]
    visited.add(root)
    let good = true, fresh = false
    for (let i = 0; i < component.length; i++) {
      const r = component[i]
      good &&= r.good; fresh ||= r.fresh
      for (const next of r.links) if (!visited.has(next)) { visited.add(next); component.push(next) }
    }
    for (const r of component) r.good = good && fresh
  }
  // Structural equality is enough for allocation counts: both constructors
  // apply ToIndex to the same stable Number expression. It is not enough for
  // objects, whose conversion may have effects, hence the Number-only leaves.
  const sizeKey = (f, expr) => {
    const b = bodies.get(f), n = literal(expr)
    if (n != null) return `#${n}`
    if (typeof expr === 'string') return b.stable(expr) && b.view.kindOfExpr(expr) === NUMBER ? expr : null
    if (!Array.isArray(expr)) return null
    if (expr[0] === '.' && expr[2] === 'length' && rowAt(f, expr[1])?.good) return `${expr[1]}.length`
    if (!PURE.has(expr[0])) return null
    const parts = expr.slice(1).map(e => sizeKey(f, e))
    return parts.every(p => p != null) ? `${expr[0]}(${parts.join(',')})` : null
  }
  const equalMemo = new Map()
  const sameLength = (a, b) => {
    if (!a || !b || a.f !== b.f) return false
    if (a === b) return true
    let memo = equalMemo.get(a)
    if (!memo) equalMemo.set(a, memo = new Map())
    if (memo.has(b)) return memo.get(b)
    memo.set(b, false) // Recursive cycles supply no independent length proof.
    let same = false
    if (a.fresh && b.fresh) {
      const ka = sizeKey(a.f, a.size), kb = sizeKey(b.f, b.size)
      same = ka != null && ka === kb
    } else if (!a.fresh && !b.fresh) {
      const sites = incoming.get(a.f.name)
      same = !!sites?.length && sites.every(site => !site.synthetic && sameLength(
        rowAt(site.callerFunc, site.argList[a.param]), rowAt(site.callerFunc, site.argList[b.param])))
    }
    memo.set(b, same)
    return same
  }
  let count = 0
  for (const [f, b] of bodies) {
    if (![...b.arrays.values()].some(r => r.good)) continue
    const present = new Set()
    scanBoundedArrIdx(f.body, null, null, present)
    const readOf = e => {
      e = unwrap(e)
      // An initializer's presence proof says nothing about whether it ran.
      // Local aliases need a separate dominance proof (zero-trip loops and
      // conditional var declarations can leave their value undefined).
      return Array.isArray(e) && e[0] === '[]' && present.has(e) ? e : null
    }
    walkAst(f.body, { enter: n => {
      if (n[0] === '=>') return false
      if (n[0] !== '[]') return
      const source = readOf(n[2]), from = source && rowAt(f, source[1]), to = rowAt(f, n[1])
      if (from?.good && sameLength(from, to)) {
        getFactStore().guardProven.add(n)
        count++
      }
    } })
  }
  return count
}
