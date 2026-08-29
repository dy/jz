/**
 * Whole-program SRoA eligibility for single-schema `Array<S>` bindings (the
 * structInline carrier). Split out of analyze.js along the "struct-inline"
 * seam (pipeline-minimality slice); see analyze.js's module header for the
 * full split rationale and `.work/analyze-traversals.md` for the traversal
 * inventory.
 *
 * @module compile/analyze/struct-inline
 */
import { ASSIGN_OPS, walkAst } from '../../ast.js'
import { ctx } from '../../ctx.js'
import { forEachFunctionPlanRep, functionPlanRepField } from '../function-plan.js'
import { staticArrayElems, objLiteralSchemaId, inplaceKey } from '../../static.js'

/**
 * Whole-program SRoA eligibility — decides which object schemas may back an
 * `Array<S>` with the `structInline` carrier (the K f64 schema fields inlined
 * per element, no per-row heap object). Writes `ctx.schema.inlineArray:
 * Set<sid>`, read by the array push / index / length codegen.
 *
 * Default-disqualify: a schema is inlinable only when *every* observed use of
 * every `Array<S>` binding — across all user functions and module inits — is
 * one the structInline codegen handles. A missed or unrecognized use poisons
 * the schema, so the worst outcome is a lost optimization, never a stride
 * mismatch (miscompile).
 *
 * Handled uses of an `Array<S>` binding `a`:
 *   - decl/reassign from `[]` (empty), a call returning `Array<S>`, or an alias
 *   - `a.push({S-literal})`        — struct push (K-cell store)
 *   - `a.length`                  — physical len / K
 *   - `a[i]` consumed as `const p = a[i]` cursor, or directly `a[i].field`
 *   - `a` passed where the callee param is `Array<S>` (paramReps agreement)
 *   - `return a` when the enclosing function returns `Array<S>`
 * A cursor `p` (`const p = a[i]`) may only be read/written as `p.field`.
 * Anything else — bare ref, value escape, other array method, `a[i] = …`
 * element-replace — poisons S.
 *
 * Reads codegen truth: a binding is `Array<S>` iff its settled rep
 * (the opaque FunctionPlan's local-rep projection) carries
 * `arrayElemSchema = S` — the exact facts the emitter installs — so analysis
 * and emission never disagree on
 * which bindings are inline-carried.
 *
 * Conservative corners (sound, give up the optimization): closures and module
 * inits are not walked in detail — any schema reachable as a `.push({S})`
 * argument, an `Array<S>`-returning call, an `[{S}, …]` literal, or a captured
 * tracked array inside one is poisoned.
 */
export function analyzeStructInline(programFacts) {
  const inlineArray = ctx.schema?.inlineArray
  if (!inlineArray || !ctx.schema?.list) return
  const { paramReps } = programFacts
  const cand = new Set()      // sids observed as an `Array<S>` element schema
  // env-gated debug — dist/jz.js runs in browsers where `process` doesn't
  // exist, and WASI hosts strip `process.env`
  const DBG = typeof process !== 'undefined' && process.env?.JZ_DBG_INLARR
  const black = new Set()     // sids disqualified by some use

  const propsOf = (sid) => ctx.schema.list[sid] || []
  const inSchema = (sid, p) => typeof p === 'string' && propsOf(sid).includes(p)
  const isStrLit = (k) => Array.isArray(k) && k[0] === 'str' && typeof k[1] === 'string'

  // Argument list of a `['()', callee, argNode]` call node.
  const argsOf = (node) => {
    const a = node[2]
    return a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
  }

  // `name` referenced anywhere as a value (skips `:`/`.` property-name slots).
  const mentions = (node, name) => {
    if (typeof node === 'string') return node === name
    if (!Array.isArray(node)) return false
    const op = node[0]
    if (op === 'str') return false
    if (op === ':') return mentions(node[2], name)
    if (op === '.' || op === '?.') return mentions(node[1], name)
    for (let i = 1; i < node.length; i++) if (mentions(node[i], name)) return true
    return false
  }

  // Poison every schema whose `Array<S>` could materialize inside an un-walked
  // subtree (closure body / module init): `.push({S})` args, `Array<S>`-returning
  // calls, `[{S}, …]` array literals. Standalone `{S}` objects are independent
  // of array layout and intentionally left alone.
  const poisonAll = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '()') {
      const callee = node[1]
      if (typeof callee === 'string') {
        const sid = ctx.funcs.map?.get(callee)?.arrayElemSchema
        if (sid != null) black.add(sid)
      } else if (Array.isArray(callee) && callee[0] === '.' && callee[2] === 'push') {
        for (const a of argsOf(node)) {
          const sid = objLiteralSchemaId(a)
          if (sid != null) black.add(sid)
        }
      }
    } else if (op === '[' || op === '[]') {
      for (const el of staticArrayElems(node) || []) {
        const sid = objLiteralSchemaId(el)
        if (sid != null) black.add(sid)
      }
    }
    for (let i = 1; i < node.length; i++) poisonAll(node[i])
  }

  const cursorsByFunc = new Map()   // sig → Map<name, sid> — feeds inlineCellCursors
  const bracketKeyed = new Set()    // sids with `p['x']` cursor reads — those route
                                    // through the boxed dyn path (f64 slots), so
                                    // they stay on f64 cells (no i32 packing)
  // A no-array frame needs the call-composition walk ONLY when some function
  // program-wide returns an `Array<S>` (its result could flow into an
  // un-sanctioned call position here), OR some function's PARAM carries an
  // arrayElemSchema fact (a fresh array-literal argument built right at a
  // call site — `pick([{gain: 2}])` — is a live structInline hazard even
  // when the CALLER tracks no arrays of its own and nothing returns one:
  // inferArrElemSchema's cross-call fixpoint seeds a param's arrayElemSchema
  // from the literal argument's own element shapes, not only by forwarding
  // an Array<S> return). With neither condition, no call anywhere can carry
  // or receive an inline array, so the walk is a guaranteed no-op — skip it
  // (compile-time: the self-compile compiler has hundreds of array-free
  // frames whose full-body walk was pure waste).
  const anyArrRetFn = ctx.funcs.list.some(f => f?.arrayElemSchema != null && !f.raw)
  const anyParamArrFn = paramReps != null &&
    [...paramReps.values()].some(m => m && [...m.values()].some(r => r?.arrayElemSchema != null))
  for (const func of ctx.funcs.list) {
    const functionPlan = ctx.plans.functions.get(func)
    const body = func?.body
    if (func?.raw || body == null || typeof body !== 'object') continue

    // `Array<S>` bindings of this function (codegen truth) and their schemas.
    // FunctionPlan stays opaque: iterate names and read detached scalar fields.
    const arrName = new Map()       // name → sid
    forEachFunctionPlanRep(ctx, functionPlan, name => {
      const sid = functionPlanRepField(ctx, functionPlan, name, 'arrayElemSchema')
      if (sid == null || (propsOf(sid).length || 0) < 1) return // K=0 — not inlinable
      cand.add(sid)
      arrName.set(name, sid)
    })
    // A frame with no tracked arrays of its own still gets the walk when the
    // program has Array<S>-returning functions: it can FORWARD inline-carried
    // returns through call compositions (`use(mk())` in a helper-free main,
    // `mk().length`) — the verify walk's call rules must see those sites (this
    // closed a live wrong-value: `mk().length` read the PHYSICAL cell count
    // K·n). It also still needs the walk when some function's PARAM carries
    // an arrayElemSchema fact: this frame could be the one CALLING it with a
    // fresh array-literal argument (`pick([{gain: 2}])`), and verifyCall's
    // default-disqualify poisoning is the only thing that ever sees that
    // call site. When NEITHER holds, the walk is provably a no-op.
    if (!arrName.size && !anyArrRetFn && !anyParamArrFn) continue

    // A structInline `Array<S>` value is only ever born from an empty `[]`
    // grown by structInline `.push`. `expr` is such a producer of `Array<sid>`
    // iff it is: a tracked `Array<sid>` alias, an empty `[]` literal, or a call
    // to a user function whose settled return fact IS `Array<sid>` (narrow's
    // fact — the exact agreement the receiving binding's own rep derives from;
    // a fact-less callee could return an inline-carried array into a binding
    // read as plain, `mk().length`-class). Every other source — a non-empty
    // `[{S},…]` literal, a builtin call (`JSON.parse`, `Object.values`, `.map`,
    // `.slice`, a member access onto a parsed object) — yields a taggedLinear
    // array and must poison sid.
    const safeArrSource = (expr, sid) => {
      if (typeof expr === 'string') return arrName.get(expr) === sid
      if (!Array.isArray(expr)) return false
      const elems = staticArrayElems(expr)
      if (elems) return elems.length === 0
      return expr[0] === '()' && typeof expr[1] === 'string' &&
        ctx.funcs.map?.get(expr[1])?.arrayElemSchema === sid
    }
    const isUserCall = (e) => Array.isArray(e) && e[0] === '()' && typeof e[1] === 'string'

    // Pass 1 — collect `const p = a[i]` cursors; drop on name clash / re-decl.
    const cursor = new Map()        // name → sid
    const declSeen = new Set()
    walkAst(body, { enter: node => {
      if (node[0] === '=>') return false
      if (node[0] === 'let' || node[0] === 'const') {
        for (let i = 1; i < node.length; i++) {
          const d = node[i]
          if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
          const name = d[1], rhs = d[2]
          if (declSeen.has(name)) { const s = cursor.get(name); if (s != null) black.add(s) }
          declSeen.add(name)
          if (Array.isArray(rhs) && rhs[0] === '[]' && rhs.length === 3 &&
              typeof rhs[1] === 'string' && arrName.has(rhs[1]) && !isStrLit(rhs[2])) {
            const sid = arrName.get(rhs[1])
            if (cursor.has(name) || arrName.has(name)) black.add(sid)
            else cursor.set(name, sid)
          }
        }
      }
    } })
    if (cursor.size) cursorsByFunc.set(func.sig, cursor)

    // A `['[]', arrName, idx]` element read of a tracked array → its sid.
    const elemArrSid = (n) =>
      Array.isArray(n) && n[0] === '[]' && n.length === 3 &&
      typeof n[1] === 'string' && arrName.has(n[1]) && !isStrLit(n[2])
        ? arrName.get(n[1]) : null

    // Pass 2 — verify every occurrence is a structInline-handled use.
    const flag = (c) => {
      if (typeof c !== 'string') return false
      if (arrName.has(c)) { black.add(arrName.get(c)); return true }
      if (cursor.has(c)) { black.add(cursor.get(c)); return true }
      return false
    }
    const visitChild = (c) => { if (!flag(c)) verify(c) }

    // Argument walk of a direct user call — the one sanctioned way to verify
    // a call node. `Array<S>` values may cross a call boundary only when the
    // callee's param carries the same settled elem fact (a structInline-
    // carried array read as plain on the other side misinterprets cells —
    // both name args and `g(mk())` call-expr args need the agreement).
    function verifyCall(node) {
      const callee = node[1]
      const args = argsOf(node)
      const known = typeof callee === 'string' && ctx.funcs.map?.has(callee)
      const cParams = known ? paramReps?.get(callee) : null
      for (let k = 0; k < args.length; k++) {
        const arg = args[k]
        if (typeof arg === 'string' && arrName.has(arg)) {
          const sid = arrName.get(arg)
          if (!(known && cParams?.get(k)?.arrayElemSchema === sid)) black.add(sid)
        } else if (isUserCall(arg) && ctx.funcs.map?.get(arg[1])?.arrayElemSchema != null) {
          const rsid = ctx.funcs.map.get(arg[1]).arrayElemSchema
          if (!(known && cParams?.get(k)?.arrayElemSchema === rsid)) black.add(rsid)
          verifyCall(arg)
        } else {
          // Any other argument shape — array literal (`f([{S}, …])`,
          // `f([d])`), ternary, member/index expression, a call whose OWN
          // return fact doesn't match, … — is not a proven structInline
          // producer. The two branches above are the ONLY sanctioned proofs
          // (a tracked alias in exact fact agreement, or a nested call whose
          // return fact agrees) — this module's own default-disqualify rule
          // ("a missed or unrecognized use poisons the schema", doc above)
          // must poison the callee's k-th param elem-schema here too, or
          // `inlineArraySid` (static.js) keeps trusting a param fact that
          // this call site never backed with an inline-packed layout.
          // Concretely, an array literal ALWAYS builds a taggedLinear
          // (boxed-pointer) array — same as any other producer this function
          // doesn't recognize — regardless of whether its elements happen to
          // share the callee's expected schema (`inferArrElemSchema`'s
          // cross-call fact only ever claims "elements share a schema",
          // never "physically inline"). Missing this arm let
          // `pick([{gain: 2}])` reach module/array.js's `[]` read believing
          // `inputs` was inline-packed: it read the NaN-boxed element
          // pointer's raw bits as the `gain` field itself (test/objects.js's
          // `inputs[0].gain` silently returned 0, not 2).
          const psid = cParams?.get(k)?.arrayElemSchema
          if (psid != null) black.add(psid)
          if (!flag(arg)) verify(arg)
        }
      }
    }

    function verify(node) {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'str') return
      if (op === '=>') {                       // closure — un-walked, poison
        for (const n of arrName.keys()) if (mentions(node, n)) black.add(arrName.get(n))
        for (const [n, s] of cursor) if (mentions(node, n)) black.add(s)
        poisonAll(node)
        return
      }
      if (op === ':') { visitChild(node[2]); return }

      if (op === '.' || op === '?.') {
        const o = node[1], p = node[2]
        if (typeof o === 'string') {
          if (arrName.has(o)) { if (!(op === '.' && p === 'length')) black.add(arrName.get(o)) }
          else if (cursor.has(o)) { if (!(op === '.' && inSchema(cursor.get(o), p))) black.add(cursor.get(o)) }
          return
        }
        const esid = elemArrSid(o)
        if (esid != null) {
          if (!(op === '.' && inSchema(esid, p))) black.add(esid)
          visitChild(o[2])
          return
        }
        visitChild(o)
        return
      }

      if (op === '[]') {
        const o = node[1], k = node[2]
        if (typeof o === 'string') {
          if (arrName.has(o)) black.add(arrName.get(o))   // element value escape
          else if (cursor.has(o)) {
            if (!(isStrLit(k) && inSchema(cursor.get(o), k[1]))) black.add(cursor.get(o))
            else bracketKeyed.add(cursor.get(o))   // legal, but f64-cells-only
          }
          if (k != null) visitChild(k)
          return
        }
        const esid = elemArrSid(o)
        if (esid != null) {
          if (!(isStrLit(k) && inSchema(esid, k[1]))) black.add(esid)
          else bracketKeyed.add(esid)
          visitChild(o[2])
        } else if (o != null) visitChild(o)
        if (k != null) visitChild(k)
        return
      }

      // Property WRITES on a tracked array (`a.length = n`, `a.length++`) —
      // the `.` receiver rule below allows `.length` READS only; a resize in
      // LOGICAL units through the physical-cell header would corrupt the
      // carrier's length semantics. Any dot-target write/update poisons.
      if ((op === '++' || op === '--' || ASSIGN_OPS.has(op)) &&
          Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.') &&
          typeof node[1][1] === 'string' && arrName.has(node[1][1])) {
        black.add(arrName.get(node[1][1]))
        for (let i = 2; i < node.length; i++) visitChild(node[i])
        return
      }

      // Wholesale element replace `a[i] = {S-literal}` — the immutable-update
      // idiom. Handled iff the whole-program alias sweep (scanInplaceStores)
      // proved every same-content store safe (content-keyed — node identity
      // does not survive analyzeFuncForEmit's loop rewrites) WITH target-
      // binding reuse: a same-index tracked cursor precedes the store, so the
      // replace idiom is separated from append-builders (`out[len] = {…}`),
      // which stay on the plain layout where extend keeps JS semantics. A
      // value-position `x = (a[i] = {…})` poisons the sid inside the sweep
      // itself (its `[]` target walks as a value read), so a surviving verdict
      // implies statement position. Index must be an int-certain name — a
      // fractional/negative index is a sidecar PROPERTY write in JS, which the
      // inline arm cannot express (it drops OOB writes like the checked typed
      // store). Emit lowers via emit-assign's tryStructInlineReplaceStore.
      if (op === '=' && Array.isArray(node[1]) && node[1][0] === '[]' && node[1].length === 3 &&
          typeof node[1][1] === 'string' && arrName.has(node[1][1])) {
        const sid = arrName.get(node[1][1])
        const rhs = node[2], idx = node[1][2]
        const entry = Array.isArray(rhs) && rhs[0] === '{}'
          ? ctx.schema.inplaceStores?.get(inplaceKey(node[1][1], rhs)) : null
        const idxIntCertain = typeof idx === 'string' &&
          functionPlanRepField(ctx, functionPlan, idx, 'intCertain') === true
        const ok = idxIntCertain && entry != null && entry.alias != null && entry.idx === idx &&
          objLiteralSchemaId(rhs) === sid
        if (!ok) {
          if (DBG) console.error('[inlarr-store-reject]', func.name, node[1][1], 'sid', sid,
            'idxIntCertain', idxIntCertain,
            'entry', entry, 'litSid', Array.isArray(rhs) ? objLiteralSchemaId(rhs) : null)
          black.add(sid)
          if (idx != null) visitChild(idx)
          if (rhs != null) visitChild(rhs)
          return
        }
        if (idx != null) visitChild(idx)
        // literal is a fresh value consumed by the store — verify slot values only
        const props = rhs.length === 2 && Array.isArray(rhs[1]) && rhs[1][0] === ',' ? rhs[1].slice(1) : rhs.slice(1)
        for (const pr of props) visitChild(Array.isArray(pr) && pr[0] === ':' ? pr[2] : pr)
        return
      }

      // Reassignment of the array binding — the rhs must be a structInline
      // `Array<S>` producer; an alias is left un-walked (flagging it would
      // self-poison), other producers are walked to verify their subtree.
      if (op === '=' && typeof node[1] === 'string' && arrName.has(node[1])) {
        const sid = arrName.get(node[1])
        if (!safeArrSource(node[2], sid)) black.add(sid)
        else if (isUserCall(node[2])) verifyCall(node[2])
        else if (typeof node[2] !== 'string') visitChild(node[2])
        return
      }

      if (op === '()') {
        const callee = node[1]
        if (Array.isArray(callee) && callee[0] === '.') {
          const recv = callee[1], method = callee[2]
          if (typeof recv === 'string' && arrName.has(recv)) {
            const sid = arrName.get(recv)
            const args = argsOf(node)
            if (method !== 'push' || !args.length) black.add(sid)
            else for (const arg of args) {
              if (Array.isArray(arg) && arg[0] === '{}' && objLiteralSchemaId(arg) === sid) {
                for (let i = 1; i < arg.length; i++) {
                  const pr = arg[i]
                  visitChild(Array.isArray(pr) && pr[0] === ':' ? pr[2] : pr)
                }
              } else black.add(sid)
            }
            return
          }
          if (typeof recv === 'string' && cursor.has(recv)) { black.add(cursor.get(recv)); return }
          const esid = elemArrSid(recv)
          if (esid != null) { black.add(esid); visitChild(recv[2]) }
          else visitChild(recv)
          for (const a of argsOf(node)) visitChild(a)
          return
        }
        if (typeof callee === 'string') {
          // A call reached through GENERIC descent is an un-sanctioned
          // position for an `Array<S>`-returning callee — a receiver
          // (`mk().length` reads the PHYSICAL cell count), an operand, a
          // spread, a bare statement. Sanctioned positions (decl init /
          // return with fact agreement, agreement-checked call args) route
          // through verifyCall directly and never reach this poison. An
          // expression-bodied arrow's whole body is its return position —
          // sanction it under the same fact agreement.
          const retSid = ctx.funcs.map?.get(callee)?.arrayElemSchema
          if (retSid != null && !(node === body && func.arrayElemSchema === retSid)) black.add(retSid)
          verifyCall(node)
          return
        }
        visitChild(callee)
        for (const a of argsOf(node)) visitChild(a)
        return
      }

      if (op === 'return') {
        const e = node[1]
        if (typeof e === 'string') {
          if (arrName.has(e)) { if (func.arrayElemSchema !== arrName.get(e)) black.add(arrName.get(e)) }
          else flag(e)
          return
        }
        // A function typed `Array<S>` must return a structInline producer —
        // a non-empty literal / builtin call here yields a taggedLinear array.
        if (func.arrayElemSchema != null && !safeArrSource(e, func.arrayElemSchema))
          black.add(func.arrayElemSchema)
        const esid = elemArrSid(e)
        if (esid != null) { black.add(esid); visitChild(e[2]); return }
        if (isUserCall(e)) {
          // `return g()` in a function with NO matching elem fact lets an
          // inline-carried array escape into fact-less land — poison unless
          // the facts agree (the agreeing case is the sanctioned position).
          const rsid = ctx.funcs.map?.get(e[1])?.arrayElemSchema
          if (rsid != null && func.arrayElemSchema !== rsid) black.add(rsid)
          verifyCall(e)
          return
        }
        if (e != null) visitChild(e)
        return
      }

      if (op === 'let' || op === 'const') {
        for (let i = 1; i < node.length; i++) {
          const d = node[i]
          if (!Array.isArray(d) || d[0] !== '=') { if (Array.isArray(d)) visitChild(d); continue }
          const name = d[1], rhs = d[2]
          if (typeof name === 'string' && cursor.has(name) &&
              Array.isArray(rhs) && rhs[0] === '[]') {
            if (rhs[2] != null) visitChild(rhs[2])   // cursor decl — verify index only
            continue
          }
          if (typeof name === 'string' && arrName.has(name)) {
            const sid = arrName.get(name)
            if (!safeArrSource(rhs, sid)) black.add(sid)               // non-structInline producer
            // [] / fact-agreeing user call — sanctioned; verify args/subtree
            else if (isUserCall(rhs)) verifyCall(rhs)
            else if (typeof rhs !== 'string') visitChild(rhs)
            continue
          }
          if (typeof name !== 'string') visitChild(name)
          visitChild(rhs)
        }
        return
      }

      for (let i = 1; i < node.length; i++) visitChild(node[i])
    }
    verify(body)
  }

  // Module inits are not walked in detail — poison any schema whose array form
  // could appear there (struct-array consumed/built at module scope).
  if (ctx.module?.moduleInits) for (const mi of ctx.module.moduleInits) poisonAll(mi)

  for (const sid of cand) if (!black.has(sid)) inlineArray.add(sid)

  // Packed i32 cells (inlineCellI32): all slots strict-int32 (slotI32Certain —
  // every censused write exactly-int32, never -0, hazard-belted), K ≥ 2 (a
  // 1-field element still occupies one 8-byte cell — packing buys nothing),
  // and no bracket-keyed cursor reads (those route through the boxed dyn
  // path, which assumes f64 slots). Elements then pack K raw i32 fields into
  // ⌈K/2⌉ physical cells — C's record layout; loads/stores drop the
  // trunc_sat/convert layer. The packed decision is consumed through cursor
  // nodes (inlineCellCursors → readVar's `.cellI32` tag), never the bare sid:
  // a standalone `{S}` object of the same sid keeps tagged f64 slots.
  for (const sid of inlineArray) {
    const props = propsOf(sid)
    if (props.length >= 2 && !bracketKeyed.has(sid) &&
        props.every(p => ctx.schema.slotI32CertainBySid?.(sid, p)))
      ctx.schema.inlineCellI32.add(sid)
  }
  for (const [sig, cur] of cursorsByFunc) {
    let set = null
    for (const [name, sid] of cur) if (ctx.schema.inlineCellI32.has(sid)) (set ??= new Set()).add(name)
    if (set) ctx.schema.inlineCellCursors.set(sig, set)
  }
  if (DBG) console.error('[inlarr]', 'eligible:', [...inlineArray], 'packedI32:', [...ctx.schema.inlineCellI32])
}
