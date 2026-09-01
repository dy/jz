/**
 * Whole-program SRoA eligibility for closed heterogeneous union `Array<S>`
 * bindings (the structInline union carrier, max-K-stride packed i32
 * cells). Split out of analyze.js along the "union-inline" seam (pipeline-
 * minimality slice); see analyze.js's module header for the full split
 * rationale and `.work/archive/analyze-traversals.md` for the traversal inventory.
 *
 * @module compile/analyze/union-inline
 */
import { ASSIGN_OPS, MUTATE_OPS } from '../../ast.js'
import { ctx } from '../../ctx.js'
import { forEachFunctionPlanRep, functionPlanRepField } from '../function-plan.js'
import { staticArrayElems, objLiteralSchemaId } from '../../static.js'
import { scanBoundedArrIdx, isTerminator } from '../../type.js'

/** Closed heterogeneous unions as max-K-stride packed i32 cell arrays — the
 *  tagged-record stream layout (shapes class): `rows.push({k, …variant})` over
 *  a CLOSED schema set stores each record as `stride` raw i32 cells (stride =
 *  max member K; every member's slot i is cell i), contiguous — no per-record
 *  heap object, no element pointer. Reads devirt through the landed
 *  closed-union chain: the tag (union-agreeing slot) directly; variant fields
 *  under the user's own `tag === C` branches (discriminant refinement).
 *
 *  FAIL-CLOSED like structInlinePass: a union inlines only when EVERY use
 *  of every union-array binding and cursor — across all functions — is a
 *  handled shape, and every cursor field read RESOLVES statically (agreeing
 *  slot, or discriminant-narrowed members that agree). Anything else
 *  blacklists the union. v1 scope: packed-only (every member all-slots
 *  strict-int32), same-function cursors (`measure(rows[i])` param cursors are
 *  stage 3 — the pointer-ABI seam), reads only (element replace poisons).
 */
export function unionInlinePass(programFacts) {
  const registry = ctx.schema?.inlineUnion
  if (!registry || !ctx.schema?.list) return null
  const DBG = typeof process !== 'undefined' && process.env?.JZ_DBG_INLARR
  const propsOf = (sid) => ctx.schema.list[sid] || []
  const keyOf = (sids) => sids.join(',')
  const black = new Set()                    // union keys disqualified
  const cand = new Map()                     // key → sids
  const uArraysByFunc = new Map(), uCursorsByFunc = new Map()

  const intLit = (n) => typeof n === 'number' && Number.isInteger(n) ? n
    : Array.isArray(n) && n[0] == null && Number.isInteger(n[1]) ? n[1] : null
  const litOfConst = (n) => intLit(n) ?? (typeof n === 'string' ? ctx.scope.constInts?.get(n) ?? null : null)

  // Union-agreeing slot for prop across MEMBERS (all contain it at one slot).
  const agreeSlot = (sids, prop) => {
    let slot = null
    for (const sid of sids) {
      const idx = propsOf(sid).indexOf(prop)
      if (idx < 0 || (slot != null && slot !== idx)) return -1
      slot = idx
    }
    return slot ?? -1
  }

  // Per-function summary collection inside the analyzeFuncs loop; every fact
  // read here settles before that loop starts (same contract as
  // structInlinePass.collect).
  const collect = (func) => {
    const functionPlan = ctx.plans.functions.get(func)
    const body = func?.body
    if (func?.raw || body == null || typeof body !== 'object') return

    // Union-array bindings of this frame (rep channel — the landed census).
    const uArr = new Map()                   // name → key
    forEachFunctionPlanRep(ctx, functionPlan, name => {
      const set = functionPlanRepField(ctx, functionPlan, name, 'arrayElemSchemaSet')
      if (!set || set.length < 2) return
      const key = keyOf(set)
      if (!cand.has(key)) cand.set(key, set)
      uArr.set(name, key)
    })
    // Candidate cursor-PARAMS (stage 3): a param whose settled schemaIdSet
    // keys a union. Schema membership alone is NOT carrier provenance — the
    // body must survive the same cursor grammar as a local cursor (direct
    // narrowed dot reads only; any alias, bracket read, write, escape,
    // forward, or closure capture reinterprets the packed cell as a generic
    // object → miscompile). Seeding them into `cursor` runs the full verify
    // walk over this body and BLACKS the key on any violation — which also
    // keeps the CALLER from packing (one shared verdict, fail-closed).
    const cursorParams = new Map()
    const preps = programFacts.paramReps?.get(func.name)
    if (preps && func.sig?.params) for (let k = 0; k < func.sig.params.length; k++) {
      const set = preps.get(k)?.schemaIdSet
      const key = typeof set === 'string' ? set : Array.isArray(set) ? keyOf(set) : null
      if (!key || !key.includes(',')) continue
      cursorParams.set(func.sig.params[k].name, key)
      if (!cand.has(key)) cand.set(key, key.split(',').map(Number))
    }
    if (!uArr.size && !cursorParams.size) return
    if (uArr.size) uArraysByFunc.set(func.sig, uArr)

    // `const t = o.PROP` aliases (discriminant reads) + `const o = a[i]`
    // cursors — pre-seeded with this function's candidate cursor-params so
    // the one grammar verifies (and later registers) both.
    const cursor = new Map(cursorParams)     // name → key
    const inbCursorPairs = new Set()
    scanBoundedArrIdx(body, inbCursorPairs, new Map())
    const tagAlias = new Map()               // tagLocal → { obj, prop }
    const declSeen = new Set()
    const shadowed = new Set()               // param names shadow-declared in the body
    const maskMax = new Map()                // name → max for `x = Y & LIT`
    const assigned = new Set()               // names written outside their decl
    ;(function collect(n) {
      if (!Array.isArray(n)) return
      if (n[0] === '=>') {
        // closure writes count too — a captured tag/mask local can change
        ;(function cw(m) {
          if (!Array.isArray(m)) return
          if (MUTATE_OPS.has(m[0]) && typeof m[1] === 'string') assigned.add(m[1])
          for (let i = 1; i < m.length; i++) cw(m[i])
        })(n)
        return
      }
      if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string') assigned.add(n[1])
      if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        const name = d[1], rhs = d[2]
        // First decl over a PRE-SEEDED cursor param = a block-scoped shadow:
        // the flow-insensitive maps cannot hold two meanings for one name, so
        // poison the param's key and bar the name from cursor re-admission
        // (a subsequent `[]`-cursor decl of the same name blacks that union
        // too — reads elsewhere in the body are ambiguous).
        if (cursor.has(name) && !declSeen.has(name)) {
          black.add(cursor.get(name)); cursor.delete(name); tagAlias.delete(name); shadowed.add(name)
        }
        if (declSeen.has(name)) { const k = cursor.get(name); if (k != null) black.add(k); cursor.delete(name); tagAlias.delete(name) }
        declSeen.add(name)
        if (Array.isArray(rhs) && rhs[0] === '[]' && rhs.length === 3 &&
            typeof rhs[1] === 'string' && uArr.has(rhs[1])) {
          // Index must be the canonical bounded pair (`for (i < a.length)` —
          // scanBoundedArrIdx): an unproven index mints a raw cell address
          // with no miss path. Fail closed otherwise.
          if (!shadowed.has(name) && typeof rhs[2] === 'string' && inbCursorPairs.has(rhs[1] + '\x00' + rhs[2]))
            cursor.set(name, uArr.get(rhs[1]))
          else black.add(uArr.get(rhs[1]))
        }
        else if (Array.isArray(rhs) && rhs[0] === '.' && typeof rhs[1] === 'string' && typeof rhs[2] === 'string')
          tagAlias.set(name, { obj: rhs[1], prop: rhs[2] })
        if (Array.isArray(rhs) && rhs[0] === '&') {
          const l = litOfConst(rhs[1]), r2 = litOfConst(rhs[2])
          const m = l != null && l >= 0 ? l : r2 != null && r2 >= 0 ? r2 : null
          if (m != null && m <= 0xFFFF) maskMax.set(name, m)
        }
      }
      if (n[0] === 'let' || n[0] === 'const') {
        // own the descent: the generic loop would re-visit each decl's inner
        // `=` node and count the INITIALIZER as an assignment, purging every
        // alias/mask the arm just recorded. Descend into the RHS values only.
        for (let i = 1; i < n.length; i++) {
          const d = n[i]
          if (Array.isArray(d) && d[0] === '=' && d[2] != null) collect(d[2])
          else collect(d)
        }
        return
      }
      for (let i = 1; i < n.length; i++) collect(n[i])
    })(body)
    // A tag alias or mask fact is single-def only: any assignment (incl. from
    // a closure) makes the refinement stale — unsound to narrow by. Drop.
    for (const name of assigned) { tagAlias.delete(name); maskMax.delete(name) }
    if (cursor.size) uCursorsByFunc.set(func.sig, cursor)

    // Discriminant narrowing of a member set under refs (Map tagLocal → int
    // exact | Set excluded). A member whose censused const for the tag slot
    // contradicts the refinement is excluded; unknown-const members stay.
    const narrow = (sids, oName, refs) => {
      if (!refs) return sids
      let out = sids
      for (const [t, v] of refs) {
        const al = tagAlias.get(t)
        if (!al || al.obj !== oName) continue
        out = out.filter(sid => {
          const slot = propsOf(sid).indexOf(al.prop)
          if (slot < 0) return typeof v !== 'number'   // missing prop reads undefined ≠ any int
          const cv = ctx.schema.slotConstInts?.get(sid)?.[slot]
          if (cv == null) return true                  // unknown const — keep (superset-sound)
          return typeof v === 'number' ? cv === v : !v.has(cv)
        })
      }
      return out
    }

    const condNV = (cond) => {
      if (!Array.isArray(cond) || cond[0] !== '===') return null
      const a = cond[1], b = cond[2], av = intLit(a), bv = intLit(b)
      if (typeof a === 'string' && bv != null) return [a, bv]
      if (typeof b === 'string' && av != null) return [b, av]
      return null
    }
    const thenRefs = (cond, refs) => {
      const nv = condNV(cond); if (!nv) return refs
      const out = new Map(refs || []); out.set(nv[0], nv[1]); return out
    }
    const elseRefs = (cond, refs) => {
      const nv = condNV(cond); if (!nv) return refs
      const [name, v] = nv
      const out = new Map(refs || [])
      const prev = out.get(name)
      if (typeof prev === 'number') return out
      const excl = new Set(prev instanceof Set ? prev : []); excl.add(v)
      const max = maskMax.get(name)
      if (max != null && excl.size === max) {
        for (let c = 0; c <= max; c++) if (!excl.has(c)) { out.set(name, c); return out }
      }
      out.set(name, excl)
      return out
    }

    // A cursor field read resolves iff the refs-narrowed members that could
    // reach it all CONTAIN prop at one slot, and no reachable member lacks it
    // (a lacking member's read is `undefined` — inexpressible in raw cells).
    const readResolves = (key, oName, prop, refs) => {
      const sids = cand.get(key)
      const reach = narrow(sids, oName, refs)
      if (!reach.length) return true                   // branch unreachable for the union
      if (reach.some(sid => propsOf(sid).indexOf(prop) < 0)) return false
      return agreeSlot(reach, prop) >= 0
    }

    const flag = (c) => {
      if (typeof c !== 'string') return false
      if (uArr.has(c)) { black.add(uArr.get(c)); return true }
      if (cursor.has(c)) { black.add(cursor.get(c)); return true }
      return false
    }

    ;(function verify(node, refs) {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'str') return
      const visit = (c) => { if (!flag(c)) verify(c, refs) }
      // Statement sequence: statements AFTER a terminator else-if ladder see
      // the stacked exclusion refinements — control past `if (c0) return …
      // else if (c1) return …` implies ¬cN for every level whose then-arm
      // terminates, up to the first non-terminator arm (mirrors
      // emitBlockBody's narrowing; without this the canonical trailing-
      // fallback read fails closed on props the excluded members lack).
      if (op === ';') {
        let cur = refs
        for (let i = 1; i < node.length; i++) {
          const s = node[i]
          verify(s, cur)
          if (Array.isArray(s) && s[0] === 'if' && isTerminator(s[2])) {
            let t = s
            while (Array.isArray(t) && t[0] === 'if' && isTerminator(t[2])) {
              cur = elseRefs(t[1], cur)
              t = t[3]
            }
          }
        }
        return
      }
      if (op === '=>') {                     // closures un-walked — poison mentions
        const touches = (n, name) => typeof n === 'string' ? n === name
          : Array.isArray(n) ? n.slice(1).some(c => touches(c, name)) : false
        for (const [n, k] of uArr) if (touches(node, n)) black.add(k)
        for (const [n, k] of cursor) if (touches(node, n)) black.add(k)
        return
      }
      if (op === 'if' || op === '?:') {
        verify(node[1], refs)
        const isTern = op === '?:'
        verify(node[2], thenRefs(node[1], refs))
        const elseArm = isTern ? node[3] : node[3]
        if (elseArm != null) verify(elseArm, elseRefs(node[1], refs))
        if (isTern && node.length > 4) for (let i = 4; i < node.length; i++) verify(node[i], refs)
        return
      }
      if (op === '.' || op === '?.') {
        const o = node[1], p = node[2]
        if (typeof o === 'string') {
          if (uArr.has(o)) { if (!(op === '.' && p === 'length')) black.add(uArr.get(o)) }
          else if (cursor.has(o)) { if (!(op === '.' && readResolves(cursor.get(o), o, p, refs))) black.add(cursor.get(o)) }
          return
        }
        // direct `a[i].p` — treated as an anonymous cursor of a[i]'s union
        if (Array.isArray(o) && o[0] === '[]' && typeof o[1] === 'string' && uArr.has(o[1])) {
          const key = uArr.get(o[1])
          // no alias name → only union-agreeing props resolve
          if (!(op === '.' && agreeSlot(cand.get(key), p) >= 0)) black.add(key)
          verify(o[2], refs)
          return
        }
        visit(o)
        return
      }
      if (op === '[]') {
        const o = node[1], k = node[2]
        if (typeof o === 'string' && uArr.has(o)) {
          // bare a[i] in value position outside a cursor decl → escape; the
          // cursor decls were collected up front and are re-matched here so
          // the generic descent doesn't double-reject them (decl handling).
          black.add(uArr.get(o))
          if (k != null) verify(k, refs)
          return
        }
        if (typeof o === 'string' && cursor.has(o)) { black.add(cursor.get(o)); if (k != null) verify(k, refs); return }
        if (o != null) visit(o)
        if (k != null) verify(k, refs)
        return
      }
      if (op === 'let' || op === 'const') {
        for (let i = 1; i < node.length; i++) {
          const d = node[i]
          if (!Array.isArray(d) || d[0] !== '=') { verify(d, refs); continue }
          const name = d[1], rhs = d[2]
          if (typeof name === 'string' && cursor.has(name) && Array.isArray(rhs) && rhs[0] === '[]') {
            if (rhs[2] != null) verify(rhs[2], refs)   // sanctioned cursor decl — index only
            continue
          }
          if (typeof name === 'string' && uArr.has(name)) {
            const key = uArr.get(name)
            // A union array is born from an empty `[]` (built by member pushes)
            // OR from a user call whose settled return union IS this key
            // (`const rows = initRows()`), OR aliased from another union-key
            // binding. Any other producer poisons.
            const elems = staticArrayElems(rhs)
            const bornEmpty = elems && elems.length === 0
            const bornCall = Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string' &&
              ctx.funcs.map?.get(rhs[1])?.arrayElemSchemaSet === key
            const bornAlias = typeof rhs === 'string' && uArr.get(rhs) === key
            if (!(bornEmpty || bornCall || bornAlias)) black.add(key)
            continue
          }
          // Shadow decl of a cursor name (a block-scoped `const o = other`
          // over a cursor PARAM, or a non-sanctioned cursor redecl): later
          // reads of the name would keep the packed-cell tag while holding
          // an arbitrary value. Fail closed.
          if (typeof name === 'string' && cursor.has(name)) {
            black.add(cursor.get(name))
            if (rhs != null) visit(rhs)
            continue
          }
          if (typeof name !== 'string') verify(name, refs)
          if (rhs != null) visit(rhs)
        }
        return
      }
      if ((op === '++' || op === '--' || ASSIGN_OPS.has(op))) {
        const lhs = node[1]
        if (Array.isArray(lhs) && (lhs[0] === '.' || lhs[0] === '?.' || lhs[0] === '[]') && typeof lhs[1] === 'string') {
          if (uArr.has(lhs[1])) { black.add(uArr.get(lhs[1])); return }   // element replace / length write — v1 reads-only
          if (cursor.has(lhs[1])) { black.add(cursor.get(lhs[1])); return }
        }
        if (typeof lhs === 'string' && (uArr.has(lhs) || cursor.has(lhs))) { flag(lhs); return }
        for (let i = 1; i < node.length; i++) visit(node[i])
        return
      }
      if (op === '()') {
        const callee = node[1]
        const args = node[2] == null ? [] : (Array.isArray(node[2]) && node[2][0] === ',') ? node[2].slice(1) : [node[2]]
        if (Array.isArray(callee) && callee[0] === '.' && typeof callee[1] === 'string' && uArr.has(callee[1])) {
          const key = uArr.get(callee[1])
          if (callee[2] !== 'push' || !args.length) { black.add(key); return }
          for (const arg of args) {
            const sid = Array.isArray(arg) && arg[0] === '{}' ? objLiteralSchemaId(arg) : null
            if (sid == null || !cand.get(key).includes(sid)) { black.add(key); continue }
            const props = arg.length === 2 && Array.isArray(arg[1]) && arg[1][0] === ',' ? arg[1].slice(1) : arg.slice(1)
            for (const pr of props) visit(Array.isArray(pr) && pr[0] === ':' ? pr[2] : pr)
          }
          return
        }
        // Two sanctioned cross-call flows to a direct user callee:
        //   1. a union ARRAY arg — callee param carries the same settled
        //      arrayElemSchemaSet (canonical key).
        //   2. a CURSOR arg `arr[i]` (an element of a union array) — callee
        //      param carries the same settled schemaIdSet, i.e. it reads `o`
        //      through the packed-cell union carrier (`measure(rows[i])`).
        //      The cell address is stable across the call only if the callee
        //      grows NO union array reachable from its args; here the union
        //      arrays are function-local (never params), so a callee cannot
        //      reach one — trivially safe. (Passing a union array itself as a
        //      grow-capable arg is covered by case 1's array-agreement gate.)
        if (typeof callee === 'string') {
          const cParams = programFacts.paramReps?.get(callee)
          for (let k = 0; k < args.length; k++) {
            const a = args[k]
            if (typeof a === 'string' && uArr.has(a)) {
              if (cParams?.get(k)?.arrayElemSchemaSet !== uArr.get(a)) black.add(uArr.get(a))
            } else if (Array.isArray(a) && a[0] === '[]' && typeof a[1] === 'string' && uArr.has(a[1]) &&
                       inbCursorPairs.has(a[1] + '\x00' + a[2])) {
              // element cursor crossing — needs param schemaIdSet agreement.
              if (cParams?.get(k)?.schemaIdSet !== uArr.get(a[1])) black.add(uArr.get(a[1]))
            } else visit(a)
          }
          return
        }
        if (callee != null && typeof callee !== 'string') visit(callee)
        for (const a of args) visit(a)                  // union array/cursor as arg → flag → poison (stage 3 lifts)
        return
      }
      // `return rows` — sanctioned when this function's OWN settled return
      // fact is the same union (narrowReturnArrayElems' canonical key).
      if (op === 'return') {
        const v = node[1]
        if (typeof v === 'string' && uArr.has(v)) {
          if (func.arrayElemSchemaSet !== uArr.get(v)) black.add(uArr.get(v))
          return
        }
        if (v != null) visit(v)
        return
      }
      for (let i = 1; i < node.length; i++) visit(node[i])
    })(body, null)
  }

  // Program decision over collected summaries and schema censuses only; no
  // FunctionPlan or function body is read after the analyze loop.
  const finish = () => {
  // v1: packed-only — every member all-slots strict-int32 and stride ≥ 2.
  for (const [key, sids] of cand) {
    if (black.has(key)) continue
    const stride = Math.max(...sids.map(sid => propsOf(sid).length))
    const packed = stride >= 2 && sids.every(sid => propsOf(sid).every(p => ctx.schema.slotI32CertainBySid?.(sid, p)))
    if (!packed) continue
    registry.set(key, { sids, stride })
  }
  for (const [sig, m] of uArraysByFunc) {
    let keep = null
    for (const [name, key] of m) if (registry.has(key)) (keep ??= new Map()).set(name, key)
    if (keep) ctx.schema.inlineUnionArrays.set(sig, keep)
  }
  // Registers LOCAL cursors and cursor-PARAMS alike — both entered `cursor`
  // in the per-function walk, so registration here is registration of a
  // VERIFIED name only (a param whose body violated the cursor grammar
  // blacked its key above, dropping it from the registry). The param stays
  // f64 in the sig (the cell address rides the OBJECT NaN-box across the
  // call, unboxed at first read) — no sig-type narrowing, no cross-phase
  // ordering hazard.
  for (const [sig, m] of uCursorsByFunc) {
    let keep = null
    for (const [name, key] of m) if (registry.has(key)) (keep ??= new Map()).set(name, key)
    if (keep) ctx.schema.inlineUnionCursors.set(sig, keep)
  }
  if (DBG) console.error('[inlarr-union]', 'eligible:', [...registry.keys()], 'black:', [...black])
  }
  return { collect, finish }
}
