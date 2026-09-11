/** Exact integer tags in object literals, used to discriminate schema unions. */
import { MUTATE_OPS, walkAst } from '../../ast.js'
import { ctx, getFactStore } from '../../ctx.js'
import { staticObjectProps, constNumExpr } from '../../static.js'

export function collectSlotConstants(ast) {
  if (!ctx.schema?.register) return
  const pf = getFactStore().programFacts
  const slotConstInts = ctx.schema.slotConstInts
  slotConstInts.clear()
  const observeConstInt = (sid, idx, value) => {
    let arr = slotConstInts.get(sid)
    if (!arr) { arr = []; slotConstInts.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    if (arr[idx] === null) return
    if (value == null || !Number.isInteger(value)) arr[idx] = null
    else if (arr[idx] === undefined) arr[idx] = value
    else if (arr[idx] !== value) arr[idx] = null
  }
  const intLiteral = n => typeof n === 'number' && Number.isInteger(n) ? n
    : Array.isArray(n) && n[0] == null && Number.isInteger(n[1]) ? n[1]
    : null
  const condNameValue = (cond) => {
    if (!Array.isArray(cond) || cond[0] !== '===') return null
    const a = cond[1], b = cond[2], av = intLiteral(a), bv = intLiteral(b)
    if (typeof a === 'string' && bv != null) return [a, bv]
    if (typeof b === 'string' && av != null) return [b, av]
    return null
  }
  const thenIntRefs = (cond, refs) => {
    const out = new Map(refs || [])
    const nv = condNameValue(cond)
    if (nv) out.set(nv[0], nv[1])
    return out
  }
  // Else-arm refinement by EXCLUSION: a mask-picked tag (`const k = s & (N-1)`,
  // range [0, N-1]) whose if-chain compares every value but the last leaves the
  // trailing else with EXACTLY one possible value — the canonical tagged-union
  // builder shape (`else rows.push({k, …})` carries k = N-1 as surely as a
  // guarded arm). Refs values: number = exact; Set = excluded ints so far.
  const elseIntRefs = (cond, refs) => {
    const out = new Map(refs || [])
    const nv = condNameValue(cond)
    if (!nv) return out
    const [name, v] = nv
    const max = maskMax?.get(name)
    const prev = out.get(name)
    const excl = new Set(prev instanceof Set ? prev : [])
    excl.add(v)
    if (max != null && excl.size === max) {
      // all but one of [0, max] excluded → the remaining value is exact
      for (let cand = 0; cand <= max; cand++) if (!excl.has(cand)) { out.set(name, cand); return out }
    }
    if (typeof prev !== 'number') out.set(name, excl)
    return out
  }
  // Per-body mask ranges: name → max for single-write `name = X & LIT`
  // (either operand order; module consts resolve through constInts).
  let maskMax = null
  const collectMaskMax = (body) => {
    const out = new Map()
    // Const-expression folding: the canonical mask spells `s & (NSHAPES - 1)`
    // with NSHAPES a module const — fold int arithmetic over resolvable parts.
    const litOf = (n) => {
      const v = constNumExpr(n, name => ctx.scope.constInts?.get(name) ?? null)
      return Number.isInteger(v) ? v : null
    }

    const note = (name, rhs) => {
      if (typeof name !== 'string') return
      let max = null
      if (Array.isArray(rhs) && rhs[0] === '&') {
        const l = litOf(rhs[1]), r = litOf(rhs[2])
        const m = l != null && l >= 0 ? l : r != null && r >= 0 ? r : null
        if (m != null && m <= 0xFFFF) max = m
      }
      out.set(name, out.has(name) && out.get(name) !== max ? null : max)
    }
    const walk = (n) => walkAst(n, { enter: n => {
      if (n[0] === '=>') return false
      if ((n[0] === 'let' || n[0] === 'const')) {
        for (let i = 1; i < n.length; i++)
          if (Array.isArray(n[i]) && n[i][0] === '=') note(n[i][1], n[i][2])
      } else if (n[0] === '=' && typeof n[1] === 'string') note(n[1], n[2])
      else if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string') out.set(n[1], null)
    } })
    walk(body)
    return out
  }
  const visit = (node, intRefs = null) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return
    // Preserve exact branch-local constants while censusing literals such as
    // `if (kind === 3) rows.push({kind, ...})`. Else arms accumulate the
    // excluded values; with a known mask range the trailing else resolves to
    // the one remaining value (see elseIntRefs).
    if (op === 'if' || op === '?:') {
      visit(node[1], intRefs)
      visit(node[2], thenIntRefs(node[1], intRefs))
      if (node[3] != null) visit(node[3], elseIntRefs(node[1], intRefs))
      return
    }
    if (op === '{}') {
      const parsed = staticObjectProps(node.slice(1))
      if (parsed) {
        const sid = ctx.schema.register(parsed.names)
        for (let i = 0; i < parsed.values.length; i++) {
          const value = parsed.values[i]
          observeConstInt(sid, i, intLiteral(value) ?? (typeof value === 'string' && typeof intRefs?.get(value) === 'number' ? intRefs.get(value) : null))
        }
      }
    }
    for (let i = 1; i < node.length; i++) visit(node[i], intRefs)
  }
  if (ast) { maskMax = collectMaskMax(ast); visit(ast) }
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    maskMax = collectMaskMax(func.body)
    visit(func.body)
  }
  if ((ctx.module.initFacts?.hasSchemaLiterals) && ctx.module.moduleInits) {
    for (const mi of ctx.module.moduleInits) {
      const hit = pf.moduleInitSlot.get(mi)
      if (hit?.gen === pf.gen) {
        for (const [sid, idx, ci] of hit.obs) {
          observeConstInt(sid, idx, ci)
        }
        continue
      }
      const obs = []
      const record = (sid, idx, ci) => {
        obs.push([sid, idx, ci])
        observeConstInt(sid, idx, ci)
      }
      const visitInit = (node, intRefs = null) => {
        if (!Array.isArray(node)) return
        const op = node[0]
        if (op === '=>') return
        if (op === 'if' || op === '?:') {
          visitInit(node[1], intRefs)
          visitInit(node[2], thenIntRefs(node[1], intRefs))
          if (node[3] != null) visitInit(node[3], intRefs)
          return
        }
        if (op === '{}') {
          const parsed = staticObjectProps(node.slice(1))
          if (parsed) {
            const sid = ctx.schema.register(parsed.names)
            for (let i = 0; i < parsed.values.length; i++) {
              const value = parsed.values[i]
              record(sid, i,
                intLiteral(value) ?? (typeof value === 'string' ? intRefs?.get(value) : null))
            }
          }
        }
        for (let i = 1; i < node.length; i++) visitInit(node[i], intRefs)
      }
      visitInit(mi)
      if (mi != null && typeof mi === 'object') pf.moduleInitSlot.set(mi, { gen: pf.gen, obs })
    }
  }
}
