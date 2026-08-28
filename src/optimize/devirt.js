/**
 * Devirtualization family: three passes that exploit compile-time-known
 * dispatch tables/schemas — `devirtSchemaReads` (br_table over an OBJECT's
 * registered schema list for `o.x` megamorphic reads), `foldStaticConstArrayReads`
 * (const base/len for a STATIC array literal's element reads), and
 * `devirtConstFnArrayCalls` (br_table over a module-const array of capture-free
 * arrows for `constOps[idx](args)` dispatch). Distinct passes, no shared code,
 * but the same technique and cross-referenced facts (ctx.scope.staticArrs,
 * ctx.types.arrResized/nameEscapes — see devirtConstFnArrayCalls's `narrow`
 * gate, which reuses foldStaticConstArrayReads' exact never-resized/never-
 * aliased proof).
 *
 * @module optimize/devirt
 */
import { LAYOUT, ctx } from '../ctx.js'
import { nextLocalId, cloneIR, isPureIR } from '../ir.js'
import { walkAst } from '../ast.js'
import { PTR } from '../../layout.js'
import { inlinePureCallExpr } from './vectorize.js'

const DBG_DSR = typeof process !== 'undefined' && !!process.env?.JZ_DBG_DSR

/** `o.x` on a statically-unknown receiver — the megamorphic property read
 *  (shapes bench: 8 record variants at one site, every field load a ~50-op
 *  __dyn_get_any_t_h hash probe). The module's registered schema list is known
 *  and bounded once emission completes: switch on the box's aux schemaId via
 *  br_table into direct slot loads for every schema CARRYING the field — the
 *  static mirror of a polymorphic inline cache. Non-OBJECT tags, alien sids and
 *  schemas lacking the field all take the original call (default arm): a
 *  schema slot is authoritative for its own fields (dyn writes to schema keys
 *  mirror into the slot — buildObjectSchemaSetArm), so the direct load is
 *  bit-identical where it fires. Emit tagged the call (.dvProp) because
 *  schema.list is still growing while function bodies emit. */
export function devirtSchemaReads(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const schemas = ctx.schema?.list
  if (!schemas || !schemas.length || schemas.length > 24) return
  if (!ctx.core.includes.has('__ptr_type')) return
  let uid = null
  const newDecls = []
  // Receiver-stable sid cache: a devirt read whose receiver is a bare local that
  // is NEVER written in this function (param or single-init const — this pass
  // runs before watr inlining, so `measure(o)`-style helpers still have their
  // own frame) has a CONSTANT schemaId for the whole body: the sid lives in the
  // box's aux bits and a jz OBJECT's shape never changes (dyn writes go to the
  // sidecar, not the aux). Compute `sid | -1(non-OBJECT)` ONCE at body start;
  // every read on that receiver drops its per-read __ptr_type guard + aux
  // extract and br_tables on the cached local (-1 wraps u32-huge → default arm).
  const assigned = new Set()
  walkAst(fn, { enter: n => {
    if (Array.isArray(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') assigned.add(n[1])
  } })
  // receiver expr → { name, bits } for a bare never-written local (f64 local
  // wrapped in reinterpret, or an already-i64 local), else null (keep the
  // per-read spill+guard path)
  const stableRecv = (r) => {
    if (Array.isArray(r) && r[0] === 'i64.reinterpret_f64' &&
      Array.isArray(r[1]) && r[1][0] === 'local.get' && typeof r[1][1] === 'string' &&
      !assigned.has(r[1][1])) return { name: r[1][1], bits: r }
    if (Array.isArray(r) && r[0] === 'local.get' && typeof r[1] === 'string' &&
      !assigned.has(r[1])) return { name: r[1], bits: r }
    return null
  }
  const sidCache = new Map()  // receiver local name → sid i32 local
  const sidInit = []
  const recvReads = new Map()  // receiver local name → tagged-read count (pre-scan)
  const recvAllObject = new Map() // every tagged read already proves OBJECT by static VAL
  // select(aux, -1, tag==OBJECT) — both operands pure, no branch
  const sidExprFor = (bits, objectKnown = false) => objectKnown
    ? ['i32.wrap_i64', ['i64.and',
        ['i64.shr_u', cloneIR(bits), ['i64.const', LAYOUT.AUX_SHIFT]],
        ['i64.const', LAYOUT.AUX_MASK]]]
    : ['select',
        ['i32.wrap_i64', ['i64.and',
          ['i64.shr_u', cloneIR(bits), ['i64.const', LAYOUT.AUX_SHIFT]],
          ['i64.const', LAYOUT.AUX_MASK]]],
        ['i32.const', -1],
        ['i32.eq',
          ['i32.wrap_i64', ['i64.and',
            ['i64.shr_u', cloneIR(bits), ['i64.const', LAYOUT.TAG_SHIFT]],
            ['i64.const', LAYOUT.TAG_MASK]]],
          ['i32.const', PTR.OBJECT]]]
  // ≥2 reads on the receiver: amortize into an entry-hoisted local. A single
  // read inlines the select at its site instead — an eager entry compute would
  // tax every call of a function whose lone read sits on a cold path (the
  // self-compile kernel's shape; measured 0.9% compile-time regression).
  const sidRead = (stable) => {
    const objectKnown = recvAllObject.get(stable.name) === true
    if ((recvReads.get(stable.name) || 0) < 2) return sidExprFor(stable.bits, objectKnown)
    let sidT = sidCache.get(stable.name)
    if (!sidT) {
      sidT = `$__dsrs${uid++}`
      newDecls.push(['local', sidT, 'i32'])
      sidInit.push(['local.set', sidT, sidExprFor(stable.bits, objectKnown)])
      sidCache.set(stable.name, sidT)
    }
    return ['local.get', sidT]
  }
  // Evaluation-order safety class shared by the rewrite and the duplicate-read
  // memo: arms/reuse evaluate ONLY the receiver (or nothing); the original call
  // also evaluates key/tag/hash operands. All must be pure for the paths to be
  // observationally identical (they are in practice: local reads + constants —
  // the emitDynGetAnyTyped shape). `call $__ptr_type` is a pure bit extract.
  const PURE_I64 = new Set(['i64.const', 'i64.reinterpret_f64', 'f64.reinterpret_i64',
    'i64.and', 'i64.or', 'i64.xor', 'i64.shr_u', 'i64.shl', 'i64.eq', 'i64.ne', 'i64.eqz',
    'i64.extend_i32_u', 'i64.extend_i32_s',
    'i32.const', 'i32.wrap_i64', 'i32.and', 'i32.or', 'i32.xor', 'i32.shr_u', 'i32.shl',
    'i32.add', 'i32.sub', 'i32.eq', 'i32.ne', 'i32.eqz'])
  const pureOp = (n) => !Array.isArray(n) ? true
    : n[0] === 'call' && n[1] === '$__ptr_type' ? n.slice(2).every(pureOp)
    : PURE_I64.has(n[0]) ? n.slice(1).every(pureOp)
    : isPureIR(n)
  const rewrite = (parent, i) => {
    const node = parent[i]
    const prop = node.dvProp
    const withProp = []
    for (let sid = 0; sid < schemas.length; sid++) {
      const slot = schemas[sid].indexOf(prop)
      if (slot >= 0) withProp.push([sid, slot])
    }
    if (!withProp.length) return
    // `local.tee` operands (foldSetToTee folds shared tag/CSE
    // locals into the FIRST read's call, possibly nested) are hoisted to
    // standalone sets before the dispatch, innermost first — the original call
    // evaluated them unconditionally, so unconditional sets are observationally
    // identical, later readers of those locals still see them, and the arms
    // (which skip the default call) stay sound.
    const teeHoists = []
    const extractTees = (n) => {
      if (!Array.isArray(n)) return n
      if (n[0] === 'local.tee' && typeof n[1] === 'string') {
        teeHoists.push(['local.set', n[1], extractTees(n[2])])
        return ['local.get', n[1]]
      }
      return n.map((c, k) => k === 0 ? c : extractTees(c))
    }
    const operands = node.slice(2).map(extractTees)
    for (const op of operands) if (!pureOp(op)) { if (DBG_DSR) console.error('[dsr-bail]', prop, 'impure operand:', JSON.stringify(op).slice(0, 200)); return }
    for (const h of teeHoists) if (!pureOp(h[2])) { if (DBG_DSR) console.error('[dsr-bail]', prop, 'impure tee:', JSON.stringify(h).slice(0, 200)); return }
    // the dispatch's generic arm — the original call over the tee-free operands
    const genericCall = [node[0], node[1], ...operands]
    if (uid === null) uid = nextLocalId(fn, '$__dsr')
    const stable = stableRecv(genericCall[2])
    const id = uid++
    const rT = stable ? null : `$__dsr${id}r`
    if (rT) newDecls.push(['local', rT, 'i64'])
    // receiver bits for arms/default: the stable local read inline (fresh clone
    // per use — IR nodes must not alias), or the spill
    const recvBits = () => stable ? cloneIR(stable.bits) : ['local.get', rT]
    const out = `$__dsro${id}`, dflt = `$__dsrd${id}`
    const lo = withProp[0][0], hi = withProp[withProp.length - 1][0]
    const bySid = new Map(withProp)
    // Discriminant-field collapse: when EVERY compile-time schema has the prop
    // at the SAME slot (the canonical tag-field pattern — `.k`/`.type`/`.kind`
    // as first key of every variant literal), a known-schema OBJECT resolves to
    // that slot with no dispatch at all: `(u32)sid < count ? load : generic`.
    // The unsigned compare routes BOTH the -1 non-OBJECT sentinel and any
    // runtime-registered alien sid (__jp_obj / host-marshaled shapes mint sids
    // past the compile-time list) to the generic arm.
    if (stable && withProp.length === schemas.length &&
      withProp.every(([, slot]) => slot === withProp[0][1])) {
      const slot = withProp[0][1]
      const dispatch = ['if', ['result', 'i64'],
        ['i32.lt_u', sidRead(stable), ['i32.const', schemas.length]],
        ['then', ['i64.load',
          ['i32.add', ['i32.wrap_i64', recvBits()], ['i32.const', slot * 8]]]],
        ['else', genericCall]]
      parent[i] = teeHoists.length
        ? ['block', out, ['result', 'i64'], ...teeHoists, dispatch]
        : dispatch
      return
    }
    const labels = Array.from({ length: hi - lo + 1 }, (_, k) => bySid.has(lo + k) ? `$__dsr${id}_${lo + k}` : dflt)
    // arms in sid order: each closes its block, loads its slot, brs out; the
    // innermost block (first arm's label) carries the br_table — selecting on
    // the hoisted sid cache when the receiver is stable (its -1 non-OBJECT
    // sentinel wraps u32-huge → default arm, so no separate tag guard), else
    // on a per-read aux extract behind a per-read tag guard.
    const armSids = withProp.map(([sid]) => sid)
    let inner = ['br_table', ...labels, dflt,
      ['i32.sub',
        stable ? sidRead(stable)
          : ['i32.wrap_i64', ['i64.and',
            ['i64.shr_u', ['local.get', rT], ['i64.const', LAYOUT.AUX_SHIFT]],
            ['i64.const', LAYOUT.AUX_MASK]]],
        ['i32.const', lo]]]
    inner = ['block', `$__dsr${id}_${armSids[0]}`,
      ...(stable ? [] : [['br_if', dflt, ['i32.ne',
        ['call', '$__ptr_type', ['local.get', rT]],
        ['i32.const', PTR.OBJECT]]]]),
      inner]
    for (let k = 0; k < armSids.length; k++) {
      const sid = armSids[k], slot = bySid.get(sid)
      const arm = ['br', out, ['i64.load',
        ['i32.add', ['i32.wrap_i64', recvBits()], ['i32.const', slot * 8]]]]
      const nextLabel = k + 1 < armSids.length ? `$__dsr${id}_${armSids[k + 1]}` : dflt
      inner = ['block', nextLabel, inner, arm]
    }
    const dfltCall = [...genericCall]
    if (!stable) dfltCall[2] = ['local.get', rT]
    parent[i] = ['block', out, ['result', 'i64'],
      ...teeHoists,
      ...(stable ? [] : [['local.set', rT, genericCall[2]]]),
      inner,
      dfltCall]
  }
  let seen = 0
  // pre-scan: count tagged reads per stable receiver (sidRead's entry-hoist
  // choice) AND per (receiver, prop) key — only keys read ≥2× tee their result
  // for the duplicate-read memo below (a lone read must not pay a local write)
  const keyReads = new Map()
  const memoKey = (c) => {
    const st = stableRecv(c[2])
    return st && c.dvProp != null ? `${st.name} ${c.dvProp}` : null
  }
  const countScan = (n) => {
    if (n[0] === 'call' && n.dvProp) {
      const st = stableRecv(n[2])
      if (st) {
        recvReads.set(st.name, (recvReads.get(st.name) || 0) + 1)
        recvAllObject.set(st.name, (recvAllObject.get(st.name) ?? true) && n.dvObject === true)
        const k = `${st.name} ${n.dvProp}`
        keyReads.set(k, (keyReads.get(k) || 0) + 1)
      }
    }
  }
  walkAst(fn, { enter: countScan })
  // Duplicate-read elimination riding the rewrite walk: a SECOND tagged read
  // of the SAME (stable receiver, prop) in the same straight-line region
  // reuses the first read's tee'd i64 — the whole sid-dispatch + slot load
  // drops (measure()'s `imul(o.r, imul(o.r, 3))` pays one read). Soundness:
  // the receiver is a never-written local and a jz OBJECT's shape never
  // changes, so only an intervening WRITE could change the value — any
  // non-readonly call, store, global.set or memory.grow clears the memo.
  // Conditional regions (if arms, labeled blocks a br may skip) keep entries
  // born inside them local: snapshot on entry, restore on exit (outer entries
  // stay usable inside — the first read dominates). A LOOP whose body clobbers
  // clears up front: an entry born before iteration 1's clobber must not serve
  // iteration 2. Replacing a read drops its operand evaluation — legal for
  // exactly the pure class rewrite() enforces; tee'd operands refuse (their
  // set would vanish).
  const READONLY_CALL = /^\$(__dyn_get|__ptr_type$|math\.)/
  const isClobberNode = (x) => {
    const op = x[0]
    if (op === 'call' && !x.dvProp && typeof x[1] === 'string' && !READONLY_CALL.test(x[1])) return true
    return typeof op === 'string' && (op.includes('.store') || op === 'global.set' || op === 'memory.grow')
  }
  const hasClobber = (x) => {
    let found = false
    walkAst(x, { enter: n => {
      if (found) return false
      if (isClobberNode(n)) { found = true; return false }
    } })
    return found
  }
  const noTee = (x) => {
    let clean = true
    walkAst(x, { enter: n => {
      if (!clean) return false
      if (n[0] === 'local.tee') { clean = false; return false }
    } })
    return clean
  }
  const memo = new Map()
  let clobbers = 0
  const scoped = (walkBody) => {
    const snap = new Map(memo), pre = clobbers
    walkBody()
    memo.clear()
    if (clobbers === pre) for (const [k, v] of snap) memo.set(k, v)
  }
  const visitChild = (n, i) => {
    const c = n[i]
    if (!Array.isArray(c)) return
    walkDSR(c)
    if (c[0] === 'call' && c.dvProp) {
      seen++
      const key = memoKey(c)
      const hit = key && memo.get(key)
      if (hit && c.slice(2).every(o => pureOp(o) && noTee(o))) { n[i] = ['local.get', hit]; return }
      rewrite(n, i)
      if (key && (keyReads.get(key) || 0) >= 2 && Array.isArray(n[i])) {
        if (uid === null) uid = nextLocalId(fn, '$__dsr')
        const L = `$__dsrm${uid++}`
        newDecls.push(['local', L, 'i64'])
        n[i] = ['local.tee', L, n[i]]
        memo.set(key, L)
      }
      return
    }
    if (isClobberNode(c)) { memo.clear(); clobbers++ }
  }
  const walkDSR = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'if') {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!Array.isArray(c)) continue
        if (c[0] === 'then' || c[0] === 'else') scoped(() => walkDSR(c))
        else visitChild(n, i)
      }
      return
    }
    if (n[0] === 'loop') {
      if (hasClobber(n)) { memo.clear(); clobbers++ }
      scoped(() => { for (let i = 1; i < n.length; i++) visitChild(n, i) })
      return
    }
    if (n[0] === 'block' && typeof n[1] === 'string') {
      scoped(() => { for (let i = 1; i < n.length; i++) visitChild(n, i) })
      return
    }
    for (let i = 1; i < n.length; i++) visitChild(n, i)
  }
  walkDSR(fn)
  if (DBG_DSR && String(fn[1]).includes('measure')) console.error('[dsr]', fn[1], 'schemas:', schemas.length, 'tagged seen:', seen)
  if (newDecls.length) {
    let at = typeof fn[1] === 'string' ? 2 : 1
    while (at < fn.length && Array.isArray(fn[at]) &&
      (fn[at][0] === 'export' || fn[at][0] === 'type' || fn[at][0] === 'param' || fn[at][0] === 'result' || fn[at][0] === 'local')) at++
    // sid-cache computations go right after the decls, before the first body
    // statement — stable receivers are never-written names (params), so their
    // value at body start equals their value at every read
    fn.splice(at, 0, ...newDecls, ...sidInit)
  }
}

/** Fold the base/len ceremony of `constArr[i]` element reads whose receiver is a
 *  STATIC array literal bound to a const global (module/array.js tags `.saArr` /
 *  `.saBits` on the read IR; the decl registers ctx.scope.staticArrs). The
 *  data-segment offset and length are compile-time constants, so the per-read
 *  `__ptr_offset` call + header len load collapse to literals — decisive in
 *  loops containing calls, where a callee may write memory and watr's LICM must
 *  keep the loads in place (the devirt'd operator-table dispatch loop is the
 *  canonical victim). Facts gate: any indexed write, resizing method call, or
 *  bare value use of the name anywhere in the program (ctx.types.arrResized /
 *  nameEscapes, collectProgramFacts) keeps the generic form — an alias or a
 *  grow could relocate the payload (header forwarding) or change len, and a
 *  folded base would read stale memory. */
export function foldStaticConstArrayReads(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const sa = ctx.scope.staticArrs
  if (!sa || !sa.size) return
  // Facts must EXIST to fold — an absent fact set means the program was never
  // walked for resize/escape, not that the name is safe.
  const resized = ctx.types.arrResized, escapes = ctx.types.nameEscapes
  if (!resized || !escapes) return
  const rewrite = (node) => {
    const st = sa.get(node.saArr)
    if (!st) return
    // A bits-form tag (receiver folded to a const box at emit) must match the decl's
    // recorded bits; a name-form tag (receiver read `global.get $name` directly) IS
    // the identity — global names are unique.
    if (node.saBits != null && st.bits !== node.saBits) return
    if (resized.has(node.saArr) || escapes.has(node.saArr)) return
    // The base derives from the GLOBAL, not a baked constant: assemble's
    // static-prefix-strip rebases every static pointer AFTER this pass runs, so a
    // baked absolute offset goes stale (caught by the module-const table tests).
    // `global.get` is the strip-safe anchor — the global's init is rebased in
    // place, jz never folds immutable global reads, and watr (which runs after
    // the strip) propagates the rebased init into a final constant memarg. The
    // win stands regardless: the `__ptr_offset` CALL (whose forwarding follow the
    // never-resized proof makes dead) and the len header load both drop.
    const baseIR = () => ['i32.wrap_i64', ['i64.reinterpret_f64', ['global.get', `$${node.saArr}`]]]
    const isBaseIR = (n) => Array.isArray(n) && n[0] === 'i32.wrap_i64' &&
      Array.isArray(n[1]) && n[1][0] === 'i64.reinterpret_f64' &&
      Array.isArray(n[1][1]) && n[1][1][0] === 'global.get' && n[1][1][1] === `$${node.saArr}`
    // 1) base tee → global-derived base: (local.tee $b (call $__ptr_offset …)) → baseIR
    let baseLocal = null
    const subBase = (n, parent, idx) => {
      if (!parent) return
      if (n[0] === 'local.tee' && Array.isArray(n[2]) && n[2][0] === 'call' && n[2][1] === '$__ptr_offset') {
        baseLocal = n[1]
        parent[idx] = baseIR()
        return false
      }
    }
    walkAst(node, { enter: subBase })
    if (!baseLocal) return
    // 2) len header load over the folded base → literal len (position-independent);
    //    remaining base reads → box-derived base
    const subLen = (n, parent, idx) => {
      if (!parent) return
      if (n[0] === 'i32.load' && Array.isArray(n[1]) && n[1][0] === 'i32.sub' &&
          isBaseIR(n[1][1]) &&
          Array.isArray(n[1][2]) && n[1][2][0] === 'i32.const' && +n[1][2][1] === 8) {
        parent[idx] = ['i32.const', st.len]
        return false
      }
      if (n[0] === 'local.get' && n[1] === baseLocal) { parent[idx] = baseIR(); return false }
    }
    walkAst(node, { enter: subLen })
  }
  walkAst(fn, { enter: n => { if (Array.isArray(n) && n.saArr != null) rewrite(n) } })
}

/** `constOps[idx](args)` — data-driven dispatch through a module-const array of
 *  capture-free arrows (operator tables, strategy maps, bytecode handlers). The
 *  generic lowering pays call_indirect's bounds + signature checks per call and
 *  blocks V8 from inlining the tiny bodies. Emit tagged the call_indirect
 *  (`.dvArr` = receiver name); this pass switches on the closure box's OWN
 *  funcIdx (aux bits) via br_table into direct uniform-ABI calls — an AOT
 *  polymorphic inline cache. The untouched original call_indirect is the
 *  default arm, so any runtime divergence (an element overwritten through an
 *  alias, an out-of-range index yielding the UNDEF box) takes the generic path:
 *  semantics are bit-identical regardless of the candidate set. */
export function devirtConstFnArrayCalls(fn, cfg) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const cfa = ctx.scope.constFnArrays
  if (!cfa || !cfa.size) return
  const armInline = !cfg || cfg.inlineDevirtArms !== false
  let uid = null
  const newDecls = []
  // ONE inline-temp counter for the whole function: two dispatch SITES can share
  // a `uid` (a const-folded receiver spills nothing, leaving uid untouched), so a
  // per-site counter would mint the same `$__dvi{uid}_0` twice — duplicate local.
  const inlRef = { next: 0 }
  const rewrite = (parent, i) => {
    const node = parent[i]
    const cands = cfa.get(node.dvArr)
    if (!cands) return
    // shape (module/function.js closure.call inline path):
    // [call_indirect, [type,$ftN], envExpr, [i32.const,n], ...W slots, idxExtract]
    if (!Array.isArray(node[1]) || node[1][0] !== 'type') return
    const env = node[2], argc = node[3]
    if (!Array.isArray(argc) || argc[0] !== 'i32.const') return
    const idxExtract = node[node.length - 1]
    const slots = node.slice(4, node.length - 1)
    const lo = Math.min(...cands.map(c => c.idx)), hi = Math.max(...cands.map(c => c.idx))
    if (hi - lo > 32) return
    if (uid === null) uid = nextLocalId(fn, '$__dv')
    // Spill env + every non-constant slot once; both the arms and the default read the spills.
    // An arg that is itself `f64.convert_i32_s(E)` spills the i32 E and re-materializes the
    // convert at each use — the convert then sits SYNTACTICALLY at every consumer, so the
    // inlined arms' `trunc∘convert` round-trips and `ne(convert, impossible-const)` guards
    // fold away (watr identities). Behind an f64 spill local the value-flow is invisible.
    const spills = []
    const spill = (expr, tag) => {
      if (Array.isArray(expr) && (expr[0] === 'f64.const' || expr[0] === 'local.get')) return expr
      if (Array.isArray(expr) && expr[0] === 'f64.convert_i32_s' && Array.isArray(expr[1])) {
        const name = `$__dv${uid++}${tag}`
        newDecls.push(['local', name, 'i32'])
        spills.push(['local.set', name, expr[1]])
        return ['f64.convert_i32_s', ['local.get', name]]
      }
      const name = `$__dv${uid++}${tag}`
      newDecls.push(['local', name, 'f64'])
      spills.push(['local.set', name, expr])
      return ['local.get', name]
    }
    const envG = spill(env, 'e')
    const slotGs = slots.map((sl, k) => spill(sl, 'a' + k))
    const out = `$__dvo${uid}`, dflt = `$__dvd${uid}`
    const byOff = new Map(cands.map(c => [c.idx - lo, c]))
    const labels = Array.from({ length: hi - lo + 1 }, (_, k) => byOff.has(k) ? `$__dv${uid}_${k}` : dflt)
    // idxExtract reads the env box — after spilling, re-point its env reference:
    // the extraction shape is wrap(and(shr(reinterpret(ENV))...)); rebuild it on the spill.
    const extract = ['i32.sub',
      ['i32.wrap_i64', ['i64.and',
        ['i64.shr_u', ['i64.reinterpret_f64', envG], ['i64.const', LAYOUT.AUX_SHIFT]],
        ['i64.const', LAYOUT.AUX_MASK]]],
      ['i32.const', lo]]
    let inner = ['br_table', ...labels, dflt, extract]
    const armOffsets = [...byOff.keys()].sort((a, b) => a - b)
    inner = ['block', labels[armOffsets[0]], inner]
    // Tiny straight-line body → inline it straight into the arm: the uniform-ABI
    // call (env + argc + W padded f64 slots) vanishes and the arm becomes the
    // operator body itself — the AOT equivalent of the switch a JIT synthesizes
    // for a hot polymorphic table. The UNFILTERED candidate map: an arm executes
    // exactly when the original call did, so a straight-line body with a side
    // effect (closure0's cold string-concat branch inside a polymorphic `+`) is
    // safe to substitute verbatim — inlinePureCallExpr itself enforces the
    // straight-line shape and read-only params, and returns null for anything it
    // can't prove (the call stays). Purity mattered only for value-motion uses.
    const bodies = ctx.scope.dvArmFns
    const nodeCount = (n) => { let c = 0; walkAst(n, { enter: () => { c++ } }); return c }
    // i32 block-narrow: when the receiver is a facts-qualified STATIC table (the
    // same never-resized/never-aliased gate as foldStaticConstArrayReads — its
    // elements are exactly the original arrows, forever) and EVERY candidate body
    // exits through `f64.convert_i32_s` (a ToInt32'd result), the dispatch value
    // is int-valued on every path: arms br the raw i32 (their convert stripped),
    // call-formed arms and the generic call_indirect wrap in i32.trunc_sat_f64_s
    // (exact on int-valued f64), and ONE convert re-boxes the block. The
    // loop-carried receiver of `x = ops[i](x, k)` then has a syntactic-convert
    // def — watr's narrowLocals retypes it and the x-side ToInt32 guard dies the
    // same way the k-side did (watr intguard).
    const convertTopped = (fnNode) => {
      if (!Array.isArray(fnNode)) return false
      const exits = []
      let last = null
      const returns = { enter: n => {
        if (!Array.isArray(n)) return
        if (n[0] === 'return') { exits.push(n.length === 2 ? n[1] : null); return false }
      } }
      for (let k = 2; k < fnNode.length; k++) {
        const s = fnNode[k]
        if (!Array.isArray(s) || s[0] === 'param' || s[0] === 'result' || s[0] === 'local' || s[0] === 'export' || s[0] === 'type') continue
        last = s
        walkAst(s, returns)
      }
      if (last && last[0] !== 'return') exits.push(last)
      return exits.length > 0 && exits.every(e => Array.isArray(e) && e[0] === 'f64.convert_i32_s')
    }
    const sa = ctx.scope.staticArrs?.get(node.dvArr)
    const fns = ctx.scope.dvArmFns
    const narrow = !!(sa && fns && ctx.types.arrResized && ctx.types.nameEscapes &&
      !ctx.types.arrResized.has(node.dvArr) && !ctx.types.nameEscapes.has(node.dvArr) &&
      cands.every(c => convertTopped(fns.get(`$${c.name}`))))
    const intOf = (v) => {
      if (Array.isArray(v) && v[0] === 'f64.convert_i32_s') return v[1]
      if (Array.isArray(v) && v[0] === 'block' && Array.isArray(v[1]) && v[1][0] === 'result' && v[1][1] === 'f64') {
        const vl = v[v.length - 1]
        if (Array.isArray(vl) && vl[0] === 'f64.convert_i32_s')
          return ['block', ['result', 'i32'], ...v.slice(2, -1), vl[1]]
      }
      return ['i32.trunc_sat_f64_s', v]
    }
    for (let k = 0; k < armOffsets.length; k++) {
      const cand = byOff.get(armOffsets[k])
      const call = ['call', `$${cand.name}`, envG, argc, ...slotGs]
      let armVal = null
      const bodyFn = armInline ? bodies?.get(`$${cand.name}`) : null
      if (bodyFn && nodeCount(bodyFn) <= 96)
        armVal = inlinePureCallExpr(call, bodies, inlRef, newDecls, 'f64', '$__dvi')
      const armExpr = armVal ?? call
      const arm = ['br', out, narrow ? intOf(armExpr) : armExpr]
      const nextLabel = k + 1 < armOffsets.length ? labels[armOffsets[k + 1]] : dflt
      inner = ['block', nextLabel, inner, arm]
    }
    // default: the original call_indirect on the spilled operands
    const generic = ['call_indirect', node[1], envG, argc, ...slotGs, node[node.length - 1]]
    parent[i] = narrow
      ? ['f64.convert_i32_s', ['block', out, ['result', 'i32'], ...spills, inner, ['i32.trunc_sat_f64_s', generic]]]
      : ['block', out, ['result', 'f64'], ...spills, inner, generic]
  }
  const walkDV = (n) => {
    if (!Array.isArray(n)) return
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (!Array.isArray(c)) continue
      if (c[0] === 'call_indirect' && c.dvArr) { walkDV(c); rewrite(n, i); continue }
      walkDV(c)
    }
  }
  walkDV(fn)
  if (newDecls.length) {
    let at = typeof fn[1] === 'string' ? 2 : 1
    while (at < fn.length && Array.isArray(fn[at]) &&
      (fn[at][0] === 'export' || fn[at][0] === 'type' || fn[at][0] === 'param' || fn[at][0] === 'result' || fn[at][0] === 'local')) at++
    fn.splice(at, 0, ...newDecls)
  }
}
