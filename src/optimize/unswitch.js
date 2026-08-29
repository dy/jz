/**
 * Loop unswitching / peeling family: version a loop once on a runtime-proven
 * condition so the fast clone drops the polymorphic dispatch entirely.
 * `unswitchTypedParamLoop` specializes a typed-array PARAM loop on the
 * pointer's runtime kind (Float64Array fast path vs. bit-exact fallback);
 * `unswitchStringRepLoop` specializes a leaf byte-scan loop on the SSO/heap
 * string representation flag.
 *
 * @module optimize/unswitch
 */
import { LAYOUT } from '../ctx.js'
import { findBodyStart, nextLocalId, cloneIR } from '../ir.js'
import { walkAst } from '../ast.js'
import { PTR, TYPED_ELEM_CODE, TYPED_ELEM_VIEW_FLAG } from '../../layout.js'

// JZ_DBG_UNSWITCH=<substr>: dump matching fns entering unswitchTypedParamLoop.
const DBG_UNSWITCH = typeof process !== 'undefined' && (process.env?.JZ_DBG_UNSWITCH || null)

/**
 * Loop-unswitch a polymorphic typed-array PARAM loop on the pointer type so the
 * Float64Array case hoists its base and vectorizes.
 *
 * `export function f(buf,n){ for(let i=0;i<n;i++) buf[i]=g(buf[i],i) }` emits a
 * per-iteration POLYMORPHIC store `(drop (if tag(buf)==ARRAY (then __arr_set_idx_ptr;
 * local.set $buf) (else f64.store __ptr_offset(buf)+i<<3)))` and a read
 * `__to_num(reinterpret(__typed_idx(reinterpret(buf), i)))` — re-decoding the NaN-box
 * base every iteration. The `local.set $buf` realloc reassign marks the param unsafe,
 * so hoistInvariantPtrOffset bails and the loop never vectorizes.
 *
 * Insert a ONCE-before-loop test "is buf a (non-BigInt) Float64Array?": yes → a fast
 * loop with the base hoisted to an i32 local, the read collapsed to `f64.load`, and the
 * polymorphic store replaced by a direct `f64.store` (no calls) — which vectorizeLaneLocal
 * then lifts to f64x2. no → the original block verbatim (bit-exact fallback for ARRAY and
 * every other element width). Float64Array (owned aux=7 or view aux=15) is the ONLY gated
 * type: the else-branch f64.store is 8-byte, valid only for f64 elements; Int32Array /
 * Uint8Array / BigInt64Array (aux 4 / 1 / 23) all fall to the verbatim path. The global-
 * Float64Array path already lowers reads to f64.load, proving f64.load == the __to_num
 * read for f64 elements (bit-exact, incl. NaN). All helpers are nested function decls
 * (no ctx param) per the self-compile discipline.
 */
export function unswitchTypedParamLoop(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  // JZ_DBG_UNSWITCH=<substr>: dump matching fns entering this pass (DBG_DSR-style).
  if (DBG_UNSWITCH && String(fn[1]).includes(DBG_UNSWITCH)) console.error(JSON.stringify(fn))
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const f64Params = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (Array.isArray(c) && c[0] === 'param' && typeof c[1] === 'string' && c[2] === 'f64') f64Params.add(c[1])
  }
  if (!f64Params.size) return

  const F64 = TYPED_ELEM_CODE.Float64Array, F64V = F64 | TYPED_ELEM_VIEW_FLAG
  const newLocals = []
  let baseId = nextLocalId(fn, 'utb')

  const has = (n, pred) => {
    let found = false
    walkAst(n, { enter: x => {
      if (found) return false
      if (pred(x)) { found = true; return false }
    } })
    return found
  }
  const writes = (n, name) => has(n, (x) => (x[0] === 'local.set' || x[0] === 'local.tee') && x[1] === name)
  const reintParam = (n, p) => Array.isArray(n) && n[0] === 'i64.reinterpret_f64' && Array.isArray(n[1]) && n[1][0] === 'local.get' && n[1][1] === p
  const typedIdx = (n, p) => Array.isArray(n) && n[0] === 'call' && n[1] === '$__typed_idx' && n.length >= 4 && reintParam(n[2], p)

  // A receiver-pointer-kind guard on the SAME param `p` — module/array.js's
  // unknown-receiver, proven-NUMBER-key read fallback:
  // `ptrTypeEq(p,ARRAY) || ptrTypeEq(p,TYPED) ?
  // __typed_idx(p,i) : __dyn_get_expr(...)`, optionally wrapped by its own
  // STRING pointer-kind check. This clone already runs where the OUTER
  // __utb gate has proven `p` IS the target typed-array ctor (PTR.TYPED,
  // matching aux), so ANY further runtime tag test on the SAME `p` here is
  // dead — collapse straight to whichever arm resolves to a typedIdx(p)
  // read; the sibling dyn-props/string arm is unreachable in this
  // specialization.
  //
  // hoistPtrType (runs before this pass) CSEs a repeated `__ptr_type(p)`
  // call — INCLUDING the two calls this guard's own `ARRAY || TYPED` OR
  // makes — into one shared `local.tee $__ptN (...) ` / `local.get $__ptN`
  // pair. When TWO reads of `p` share the same guard shape (`buf[i]*buf[i]`,
  // `buf[i]=f(buf[i])`), only the FIRST occurrence's condition carries the
  // `local.tee` that DEFINES `$__ptN`; the second just reads it. A first cut
  // of this pass deleted the whole condition on collapse — sound for a
  // single occurrence, but for the second (reader) occurrence it deleted the
  // ONLY definition of `$__ptN`, leaving it to read the wasm-default 0 and
  // silently take the dead dyn-props arm on a genuine typed array (a
  // seed-2/4/5/13/14 NaN divergence caught by the Float64Array element-ops
  // fuzz gate). Fix: never delete a matched condition — hoist it, evaluated
  // for its `local.tee` side effect only, to a SINGLE dropped statement once
  // before the loop (paramName is proven not reassigned in this fast body,
  // so the condition is loop-invariant — same footing as `baseSnap`/`gate`
  // below, and keeping it out of the per-iteration body is also what lets
  // the fast read collapse to a bare f64.load the SIMD lane vectorizer still
  // recognizes; a `block`-wrapped drop+load inline broke that pattern match
  // and silently cost the vectorization this whole pass exists to unlock).
  // `drops` accumulates every condition traversed on the path to the
  // matched call (the STRING-wrapper case nests a second guard); the caller
  // dedupes across every read site by structural equality before hoisting.
  function receiverGuardedRead(n, p, drops = []) {
    if (!Array.isArray(n)) return null
    if (typedIdx(n, p)) return { drops, call: n }
    if (n[0] !== 'if' || n.length < 4) return null
    if (!Array.isArray(n[1]) || n[1][0] !== 'result' || n[1][1] !== 'f64') return null
    if (!has(n[2], (x) => reintParam(x, p))) return null
    for (let k = 3; k < n.length; k++) {
      const a = n[k]
      if (!Array.isArray(a) || (a[0] !== 'then' && a[0] !== 'else') || a.length !== 2) continue
      const found = receiverGuardedRead(a[1], p, [...drops, n[2]])
      if (found) return found
    }
    return null
  }

  // Clone, collapsing the typed-array read to a direct f64.load(base + IND<<3):
  //   __to_num(reinterpret(__typed_idx(reinterpret P, IND)))  — and the bare form too.
  // `hoisted` (Map keyed by structural JSON, shared across the whole body scan)
  // collects any receiver-guard conditions found — see receiverGuardedRead's
  // doc comment — for the caller to hoist above the loop, deduplicated.
  function cloneRead(n, p, base, hoisted) {
    if (!Array.isArray(n)) return n
    if (n[0] === 'call' && n[1] === '$__to_num' && n.length === 3
        && Array.isArray(n[2]) && n[2][0] === 'i64.reinterpret_f64' && typedIdx(n[2][1], p))
      return ['f64.load', ['i32.add', ['local.get', base], ['i32.shl', cloneIR(n[2][1][3]), ['i32.const', 3]]]]
    if (typedIdx(n, p))
      return ['f64.load', ['i32.add', ['local.get', base], ['i32.shl', cloneIR(n[3]), ['i32.const', 3]]]]
    const guarded = n[0] === 'if' ? receiverGuardedRead(n, p) : null
    if (guarded) {
      for (const d of guarded.drops) { const key = JSON.stringify(d); if (!hoisted.has(key)) hoisted.set(key, cloneIR(d)) }
      return ['f64.load', ['i32.add', ['local.get', base], ['i32.shl', cloneIR(guarded.call[3]), ['i32.const', 3]]]]
    }
    return n.map((c, i) => i === 0 ? c : cloneRead(c, p, base, hoisted))
  }

  function processBlock(blockNode, parent, idx) {
    if (!Array.isArray(blockNode) || blockNode[0] !== 'block') return
    let loopNode = null, blockLabel = null
    const preamble = []
    for (let i = 1; i < blockNode.length; i++) {
      const c = blockNode[i]
      if (i === 1 && typeof c === 'string' && c.startsWith('$')) { blockLabel = c; continue }
      if (Array.isArray(c) && c[0] === 'loop') { if (loopNode) return; loopNode = c }
      else if (Array.isArray(c) && c[0] === 'local.set' && !loopNode) preamble.push(c)
      else if (Array.isArray(c)) return
    }
    if (!loopNode || !blockLabel) return
    const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
    if (!loopLabel) return
    const endIdx = loopNode.length - 1
    if (!(Array.isArray(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return
    const incNode = loopNode[endIdx - 1]
    if (!Array.isArray(incNode) || incNode[0] !== 'local.set' || !Array.isArray(incNode[2]) || incNode[2][0] !== 'i32.add') return
    const incVar = incNode[1], inc = incNode[2]
    if (!(Array.isArray(inc[1]) && inc[1][0] === 'local.get' && inc[1][1] === incVar && Array.isArray(inc[2]) && inc[2][0] === 'i32.const' && inc[2][1] === 1)) return
    // Pre-watr, jz wraps every multi-statement expression-group in `(block (result T) …)`
    // — as a dropped expression-statement (drop follows) or as an if-arm's tail value.
    // watr's own vacuum/mergeBlocks used to flatten this post-hoc (when this pass ran
    // post-watr); now it runs pre-watr and must see through the wrapper itself. Unlabeled
    // ⇒ not a branch target (the normalizeTransparentBlocks convention, generalized here to
    // result-carrying blocks since these are unambiguous STATEMENT-LIST positions — never
    // operand slots), so a flattened VIEW is exactly equivalent. Non-mutating: the matched
    // `if` node is shared with the verbatim blockNode preserved as the bit-exact else-
    // fallback, so the scan must not restructure it in place.
    const flattenStmts = (arr, from) => {
      const out = []
      for (let i = from; i < arr.length; i++) {
        const c = arr[i]
        if (Array.isArray(c) && c[0] === 'block' && Array.isArray(c[1]) && c[1][0] === 'result') out.push(...flattenStmts(c, 2))
        else out.push(c)
      }
      return out
    }
    const body = flattenStmts(loopNode, 3).slice(0, -2)  // drop the trailing incNode/br (already validated above)
    if (body.length < 4) return

    // Find the polymorphic-store `if` by scanning (it's followed by a `drop` of its
    // f64 result; in the IR the two are separate statements, not (drop (if …))).
    let storeIdx = -1, storeEndIdx = -1, paramName = null, elseStore = null, helperStore = null
    for (let i = 0; i < body.length; i++) {
      const c = body[i]
      // Outlined ARRAY/TYPED store: the helper owns the runtime width fork and
      // returns the possibly-relocated pointer. Emission materializes that
      // pointer in a temp, then persists it to the receiver binding.
      if (Array.isArray(c) && c[0] === 'local.set' &&
          Array.isArray(c[2]) && c[2][0] === 'call' && c[2][1] === '$__arr_typed_set_idx') {
        const next = body[i + 1], ptrTmp = c[1], call = c[2]
        const p = Array.isArray(next) && next[0] === 'local.set' && f64Params.has(next[1]) &&
          Array.isArray(next[2]) && next[2][0] === 'local.get' && next[2][1] === ptrTmp ? next[1] : null
        const objGet = Array.isArray(call[2]) && call[2][0] === 'i64.reinterpret_f64' ? call[2][1] : null
        const objTmp = Array.isArray(objGet) && objGet[0] === 'local.get' ? objGet[1] : null
        const seeded = p && objTmp && body.slice(0, i).some(st => Array.isArray(st) && st[0] === 'local.set' &&
          st[1] === objTmp && Array.isArray(st[2]) && st[2][0] === 'local.get' && st[2][1] === p)
        if (seeded) {
          let end = i + 1
          const resultGet = body[i + 2], resultDrop = body[i + 3]
          if (Array.isArray(resultGet) && resultGet[0] === 'local.get' &&
              Array.isArray(call[4]) && call[4][0] === 'local.get' && resultGet[1] === call[4][1] &&
              (resultDrop === 'drop' || (Array.isArray(resultDrop) && resultDrop[0] === 'drop'))) end = i + 3
          storeIdx = i; storeEndIdx = end; paramName = p; helperStore = call; break
        }
      }
      if (!Array.isArray(c) || c[0] !== 'if' || !Array.isArray(c[1]) || c[1][0] !== 'result' || c[1][1] !== 'f64') continue
      let thenArm = null, elseArm = null
      for (let k = 2; k < c.length; k++) { const a = c[k]; if (Array.isArray(a)) { if (a[0] === 'then') thenArm = a; else if (a[0] === 'else') elseArm = a } }
      if (!thenArm || !elseArm) continue
      const thenStmts = flattenStmts(thenArm, 1)
      let p = null
      for (const a of thenStmts) {
        if (Array.isArray(a) && a[0] === 'local.set' && f64Params.has(a[1]) && Array.isArray(a[2]) &&
            (a[2][0] === 'local.get' || (a[2][0] === 'call' && a[2][1] === '$__arr_set_idx_ptr'))) p = a[1]
      }
      if (!p || !has(thenArm, (x) => x[0] === 'call' && x[1] === '$__arr_set_idx_ptr')) continue
      // The bare `f64.store(__ptr_offset(o)+i<<3)` is the non-ARRAY fallback. It may be
      // nested under an OBJECT/HASH → __dyn_set guard (emitPolymorphicElementStore's
      // dyn-prop safety fork) — descend to find it; the fast path replaces the whole
      // store with a direct f64.load/store anyway (a proven Float64Array is never an
      // OBJECT, so its dyn arm is dead there). A plain __typed_set_idx arm is also
      // dead-width-specialized by this outer Float64 gate and may be replaced; only
      // the tagged BigInt-capable writer remains ineligible.
      const findRawStore = (n) => {
        let result = null
        walkAst(n, { enter: x => {
          if (result) return false
          if (x[0] === 'f64.store' && Array.isArray(x[1]) && x[1][0] === 'i32.add' &&
              Array.isArray(x[1][2]) && x[1][2][0] === 'i32.shl' &&
              has(x[1], (y) => y[0] === 'call' && y[1] === '$__ptr_offset')) { result = x; return false }
        } })
        return result
      }
      if (has(elseArm, (x) => x[0] === 'call' && x[1] === '$__typed_set_idx_tagged')) continue
      const es = findRawStore(elseArm)
      if (!es) continue
      storeIdx = i; storeEndIdx = i; paramName = p; elseStore = es; break
    }
    if (storeIdx < 0) return
    const shiftIdx = helperStore ? helperStore[3]
      : elseStore[1][2][1]  // the index from the store's (i32.shl IDX 3)
    // The read uses the IV directly; the store uses a snapshot `$asi = $iv`. Emit the
    // store against the IV too so the vectorizer unifies the load/store lanes — bit-exact
    // ($asi == $iv). Bail if the store index isn't the IV or a snapshot of it.
    let storeIdxName = null
    if (Array.isArray(shiftIdx) && shiftIdx[0] === 'local.get') storeIdxName = shiftIdx[1]
    if (storeIdxName !== incVar &&
        !body.some((st) => Array.isArray(st) && st[0] === 'local.set' && st[1] === storeIdxName && Array.isArray(st[2]) && st[2][0] === 'local.get' && st[2][1] === incVar)) return
    // The store-if pushes f64; a following `drop` (bare string in stack-style IR, or a
    // `['drop', …]` node) pops it. The fast store pushes nothing, so the drop must go too.
    const isDrop = (s) => s === 'drop' || (Array.isArray(s) && s[0] === 'drop')
    const hasDrop = storeIdx + 1 < body.length && isDrop(body[storeIdx + 1])

    // Take the stored value from the matched store itself, not by guessing
    // which local reads buf. The outlined helper may carry the whole value
    // expression as its argument; cloneRead rewrites any nested buf reads.
    const storedValue = helperStore ? helperStore[4] : elseStore[2]
    if (!Array.isArray(storedValue)) return
    // GUARD: param reassigned ONLY inside the matched store-if (else the hoisted base goes stale).
    for (let i = 0; i < body.length; i++) { if (i >= storeIdx && i <= storeEndIdx) continue; if (writes(body[i], paramName)) return }
    for (const s of preamble) { if (writes(s, paramName)) return }

    const base = `$__utb${baseId++}`
    newLocals.push(['local', base, 'i32'])
    const reint = () => ['i64.reinterpret_f64', ['local.get', paramName]]
    const tag = ['i32.and', ['i32.wrap_i64', ['i64.shr_u', reint(), ['i64.const', LAYOUT.TAG_SHIFT]]], ['i32.const', LAYOUT.TAG_MASK]]
    const auxOf = () => ['i32.and', ['i32.wrap_i64', ['i64.shr_u', reint(), ['i64.const', LAYOUT.AUX_SHIFT]]], ['i32.const', LAYOUT.AUX_MASK]]
    const gate = ['i32.and', ['i32.eq', tag, ['i32.const', PTR.TYPED]],
      ['i32.or', ['i32.eq', auxOf(), ['i32.const', F64]], ['i32.eq', auxOf(), ['i32.const', F64V]]]]
    const baseSnap = ['local.set', base, ['call', '$__ptr_offset', reint()]]
    const fastStore = ['f64.store',
      ['i32.add', ['local.get', base], ['i32.shl', ['local.get', incVar], ['i32.const', 3]]],
      cloneRead(storedValue, paramName, base, new Map())]
    // Fast body: keep every statement except the store-if (→ fastStore) and its trailing
    // drop (the fast store pushes nothing), with the typed-array read collapsed to f64.load.
    const hoistedGuards = new Map()
    const fastStmts = []
    for (let i = 0; i < body.length; i++) {
      if (i === storeIdx) { fastStmts.push(fastStore); continue }
      if (i > storeIdx && i <= storeEndIdx) continue
      if (hasDrop && i === storeEndIdx + 1) continue
      fastStmts.push(cloneRead(body[i], paramName, base, hoistedGuards))
    }
    // Any receiver-guard conditions cloneRead found (see its doc comment) are
    // loop-invariant here — paramName is proven not reassigned in this fast
    // body — so they run ONCE, before the loop, deduplicated, alongside
    // baseSnap; the loop body then keeps the bare f64.load shape intact.
    const hoistedDrops = [...hoistedGuards.values()].map((d) => ['drop', d])
    const fastLoop = ['block', blockLabel, ...preamble.map(cloneIR),
      ['loop', loopLabel, cloneIR(loopNode[2]), ...fastStmts, cloneIR(incNode), cloneIR(loopNode[endIdx])]]
    parent[idx] = ['if', gate, ['then', baseSnap, ...hoistedDrops, fastLoop], ['else', blockNode]]
  }

  walkAst(fn, { enter: (node, parent, idx) => {
    if (!Array.isArray(node) || !parent || node[0] !== 'block') return
    const before = parent[idx]
    processBlock(node, parent, idx)
    if (parent[idx] !== before) return false
  } })
  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}

/** Hoist the SSO/heap choice out of a leaf byte-scan loop.
 *
 * `emitDecompCharRead` deliberately makes both select arms trap-free: SSO
 * routes the speculative heap load to memory[0+idx], while heap receivers may
 * harmlessly evaluate the packed-byte shift. A loop-invariant select is still
 * paid per byte, however. For a compact call-free loop, version the loop once
 * on `$param$ccsso` and fold every matching select in each clone. This is a
 * representation-level loop unswitch, not a source/benchmark special case.
 * Large or call-bearing parser loops fail closed to avoid I-cache growth. */
export function unswitchStringRepLoop(fn) {
  // Hand-rolled, not walkAst: walkAst's enter only sees array nodes (primitive
  // operands are deliberately unvisited, see src/ast.js), which would undercount
  // this I-cache guard against the original threshold's calibration below.
  const size = n => !Array.isArray(n) ? 1 : 1 + n.slice(1).reduce((s, x) => s + size(x), 0)
  const containsName = (n, name) => {
    let found = false
    walkAst(n, { enter: x => {
      if (found) return false
      if (x[0] === 'local.get' && x[1] === name) { found = true; return false }
    } })
    return found
  }
  const match = n => {
    if (!Array.isArray(n) || n[0] !== 'select' || n.length !== 4) return null
    const c = n[3]
    if (!Array.isArray(c) || c[0] !== 'local.get' || typeof c[1] !== 'string' || !c[1].endsWith('$ccsso')) return null
    const stem = c[1].slice(0, -6)
    if (!containsName(n[1], `${stem}$ccp64`) || !containsName(n[2], `${stem}$ccldb`)) return null
    return c[1]
  }
  const hasCallOrWrite = (n, flag) => {
    let found = false
    walkAst(n, { enter: x => {
      if (found) return false
      if (x[0] === 'call' || x[0] === 'call_indirect' || x[0] === 'return_call' ||
          ((x[0] === 'local.set' || x[0] === 'local.tee') && x[1] === flag)) { found = true; return false }
    } })
    return found
  }
  const collect = (n, out) => {
    walkAst(n, { enter: (c, parent) => {
      if (parent && c[0] === 'loop') return false
      const m = match(c)
      if (m) out.push(m)
    } })
  }
  const choose = (n, flag, arm) => {
    if (!Array.isArray(n)) return n
    if (match(n) === flag) return choose(n[arm], flag, arm)
    return n.map(x => choose(x, flag, arm))
  }
  walkAst(fn, { enter: (n, parent, idx) => {
    if (!Array.isArray(n) || n[0] !== 'loop' || !parent || size(n) > 250 ||
        n.some(x => Array.isArray(x) && (x[0] === 'result' || x[0] === 'param'))) return
    const flags = []
    collect(n, flags)
    const flag = flags[0]
    if (flag && flags.every(x => x === flag) && !hasCallOrWrite(n, flag)) {
      parent[idx] = ['if', ['local.get', flag],
        ['then', choose(cloneIR(n), flag, 1)],
        ['else', choose(cloneIR(n), flag, 2)]]
      return false
    }
  } })
}
