/**
 * In-place replace-store eligibility sweep — the immutable-update idiom
 * (`arr[i] = { x, y, … }` in a loop) allocates a fresh object per element per
 * step. When no alias can observe the difference, overwriting the OLD
 * element's payload slots is bit-identical and allocation-free.
 *
 * Identity change is the only observable: after `arr[i] = fresh`, reading
 * `arr[i].f` yields the new value either way; only a SAVED alias to the old
 * element — field-read after the store, identity-compared, or stored
 * elsewhere — distinguishes fresh-object from in-place. So a store site is
 * eligible iff the whole program provably creates no such alias for that
 * schema:
 *
 *  1. Schema-S values may appear in a VALUE position (call arg, return,
 *     container/slot store, comparison, bare use) ONLY as fresh `{}` literals
 *     — an OBJECT-typed NAME in value position aliases its object → poison S
 *     (unknown sid → poison all). `.field` receivers are safe (atomic read).
 *  2. Element reads of maybe-object arrays may only be (a) an immediate
 *     `.field` receiver, or (b) the whole init RHS of a single-decl binding
 *     (a tracked ALIAS). Anything else → poison the array's elem sid.
 *  3. `for…of` over a maybe-object array binds untracked element aliases →
 *     poison its elem sid.
 *  4. A candidate store `arr[i] = {lit}` (elem sid of arr == sid of lit, all
 *     lit slot values NUMBER — no ephemeral pointers stored into a possibly
 *     durable receiver) is valid iff its sid survives 1-3, every tracked
 *     alias of that sid lives in the SAME function, same statement block,
 *     declared before the store, and never mentioned in a later statement of
 *     that block (block-scoped per iteration, so next-iteration uses re-read).
 *     Mentions inside the store statement itself are fine — the emit spills
 *     the literal's values before overwriting.
 *
 * Result: `ctx.schema.inplaceStores = WeakSet<literalNode>` — consulted by
 * emitElementAssign, which emits the guarded in-place fast path (old box has
 * OBJECT tag + sid S → slot stores; anything else → the generic fresh-alloc
 * path, so runtime aliens stay bit-exact).
 */
import { ctx } from '../ctx.js'
import { analyzeBody } from './analyze.js'
import { staticObjectProps } from '../static.js'
import { VAL } from '../reps.js'

/** Canonical content key for a store site — the ','-wrapper around literal
 *  props is normalized away between plan and emit, so flatten before
 *  serializing. Shared by the sweep and emitElementAssign. */
export const inplaceKey = (arrName, lit) => {
  const props = lit.slice(1)
  const flat = props.length === 1 && Array.isArray(props[0]) && props[0][0] === ',' ? props[0].slice(1) : props
  return `${arrName}|${JSON.stringify(flat)}`
}

// env-gated debug — dist/jz.js runs in browsers where `process` doesn't exist
const DBG = typeof process !== 'undefined' && process.env.JZ_DBG_INPLACE

const CONTAINER_METHODS = new Set(['push', 'unshift', 'splice', 'fill', 'set', 'add'])

export function scanInplaceStores(programFacts) {
  const poisoned = new Set()   // sids with a possible surviving alias
  let poisonAll = false
  const aliases = []           // { fn, sid, name, block, declIdx }
  const candidates = []        // { fn, sid, lit, block, stmtIdx, arrName }

  const paramReps = programFacts.paramReps

  // Element facts for params narrow.js leaves untracked (exported functions):
  // meet over INTERNAL call sites. Zero internal call sites → only the host
  // can call, and host-marshaled containers are fresh deep copies (interop
  // wrapVal) that cannot alias any compile-internal object → non-aliasing.
  // Any unprovable internal arg → maybe-object with unknown sid.
  const _csCache = new Map()
  const callSiteElemInfo = (fnName, k) => {
    const key = fnName + ' ' + k
    if (_csCache.has(key)) return _csCache.get(key)
    let mayBeObject = false, sid = null, seen = 0
    for (const cs of programFacts.callSites || []) {
      if (cs.callee !== fnName) continue
      seen++
      const arg = cs.argList?.[k]
      const cf = cs.callerFunc
      const cfacts = cf?.body && !cf.raw ? analyzeBody(cf.body) : null
      let proven = false
      if (typeof arg === 'string' && cfacts) {
        if (cfacts.typedElems?.has(arg) || cfacts.locals?.get(arg) === 'typed') proven = true
        else {
          const ev = cfacts.arrElemValTypes?.get(arg)
          if (ev != null && ev !== VAL.OBJECT) proven = true
          const s = cfacts.arrElemSchemas?.get(arg)
          if (s != null) { mayBeObject = true; sid = sid == null || sid === s ? s : -1; proven = true }
        }
      }
      if (!proven) { mayBeObject = true; sid = -1 }
    }
    const r = { sid: sid === -1 ? null : sid, mayBeObject: seen === 0 ? false : mayBeObject }
    _csCache.set(key, r)
    return r
  }

  for (const fn of ctx.func.list) {
    if (!fn.body || fn.raw) continue
    const facts = analyzeBody(fn.body)
    const reps = paramReps?.get(fn.name)
    const paramIdx = new Map(fn.sig.params.map((p, k) => [p.name, k]))

    // Element info for an array-valued name: elem sid (if known) and whether
    // elements could be schema objects at all (typed/NUMBER/STRING elems can't).
    const elemInfo = (name) => {
      if (typeof name !== 'string') return { sid: null, mayBeObject: true }
      if (facts.typedElems?.has(name) || facts.locals?.get(name) === 'typed') return { sid: null, mayBeObject: false }
      let sid = facts.arrElemSchemas?.get(name)
      let ev = facts.arrElemValTypes?.get(name)
      const k = paramIdx.get(name)
      if (k != null) {
        const r = reps?.get(k)
        if (r) {
          if (r.typedElem != null || r.val === VAL.TYPED) return { sid: null, mayBeObject: false }
          if (sid == null) sid = r.arrayElemSchema
          if (ev == null) ev = r.arrayElemValType
        }
        if (sid == null && (ev == null || ev === VAL.OBJECT)) {
          // untracked param (exported fn) — derive from internal call sites
          const cs = callSiteElemInfo(fn.name, k)
          if (!cs.mayBeObject) return { sid: null, mayBeObject: false }
          if (sid == null) sid = cs.sid
        }
      }
      if (sid == null && ev != null && ev !== VAL.OBJECT) return { sid: null, mayBeObject: false }
      return { sid: sid ?? null, mayBeObject: true }
    }
    const poisonElem = (name) => {
      const { sid, mayBeObject } = elemInfo(name)
      if (!mayBeObject) return
      if (sid != null) poisoned.add(sid)
      else { poisonAll = true; if (DBG) console.error('[inplace-poisonAll] elem read of', name, 'in', fn.name) }
    }
    // A NAME in value position: aliases its object if OBJECT-typed. An S value
    // can only reach an unknown-typed name through a path poisoned elsewhere,
    // so unknown types are ignored (conservatism lives at the leak sites).
    const poisonName = (name) => {
      const vt = facts.valTypes?.get(name) ?? (paramIdx.has(name) ? reps?.get(paramIdx.get(name))?.val : null)
      if (vt !== VAL.OBJECT) return
      const sid = ctx.schema.vars?.get(name) ?? (paramIdx.has(name) ? reps?.get(paramIdx.get(name))?.schemaId : null)
      if (sid != null) poisoned.add(sid)
      else { poisonAll = true; if (DBG) console.error('[inplace-poisonAll] OBJECT name', name, 'in', fn.name) }
    }

    const litSid = (lit) => {
      const parsed = staticObjectProps(lit.slice(1))
      return parsed ? ctx.schema.register(parsed.names) : null
    }

    // value-position walk; `stmts`/`stmtIdx` track the innermost statement
    // block so alias decls and stores get comparable positions
    const walkVal = (n, stmts, stmtIdx) => {
      if (!Array.isArray(n)) { if (typeof n === 'string') poisonName(n); return }
      const op = n[0]
      if (typeof op !== 'string') return
      if (op === 'str') return
      if (op === '{}') { for (let i = 1; i < n.length; i++) walkSlotValues(n[i], stmts, stmtIdx); return }
      if (op === '.' || op === '?.') {
        // receiver is a safe atomic read — an element-read receiver is fine,
        // a NAME receiver doesn't alias
        const r = n[1]
        if (Array.isArray(r) && r[0] === '[]') { if (typeof r[1] === 'string') { /* arr[i].f — safe */ } else walkVal(r[1], stmts, stmtIdx); if (r[2] != null) walkVal(r[2], stmts, stmtIdx) }
        else if (Array.isArray(r)) walkVal(r, stmts, stmtIdx)
        return
      }
      if (op === '[]' && n.length === 3) {
        // element read in value position — a leak unless provably non-object
        if (typeof n[1] === 'string') poisonElem(n[1])
        else walkVal(n[1], stmts, stmtIdx)
        if (n[2] != null) walkVal(n[2], stmts, stmtIdx)
        return
      }
      for (let i = 1; i < n.length; i++) walkVal(n[i], stmts, stmtIdx)
    }
    // `{}` literal slot values: `[':' key value]` pairs (or `,`-joined) —
    // nested fresh literals are fine, everything else is a value position
    const walkSlotValues = (n, stmts, stmtIdx) => {
      if (!Array.isArray(n)) { if (typeof n === 'string') poisonName(n); return }
      if (n[0] === ',') { for (let i = 1; i < n.length; i++) walkSlotValues(n[i], stmts, stmtIdx); return }
      if (n[0] === ':') { walkVal(n[2], stmts, stmtIdx); return }
      walkVal(n, stmts, stmtIdx)
    }

    const walkStmt = (n, stmts, stmtIdx) => {
      if (!Array.isArray(n)) { if (typeof n === 'string') poisonName(n); return }
      const op = n[0]
      // statement-position '{}' is a BLOCK (post-prepare bodies are
      // ['{}', [';', ...stmts]]), not an object literal
      if (op === ';' || op === '{' || op === '{}') {
        const list = n.slice(1)
        for (let i = 0; i < list.length; i++) walkStmt(list[i], list, i)
        return
      }
      if (op === 'let' || op === 'const') {
        for (let i = 1; i < n.length; i++) {
          const d = n[i]
          if (!Array.isArray(d) || d[0] !== '=') { walkVal(d, stmts, stmtIdx); continue }
          const [, lhs, rhs] = d
          if (typeof lhs === 'string' && Array.isArray(rhs) && rhs[0] === '[]' && rhs.length === 3 && typeof rhs[1] === 'string') {
            // tracked alias: whole-RHS element read into a single binding
            const { sid, mayBeObject } = elemInfo(rhs[1])
            if (mayBeObject) {
              if (sid != null) aliases.push({ fn, sid, name: lhs, block: stmts, declIdx: stmtIdx })
              else { poisonAll = true; if (DBG) console.error('[inplace-poisonAll] alias unknown-sid', lhs, 'of', rhs[1], 'in', fn.name) }
            }
            if (rhs[2] != null) walkVal(rhs[2], stmts, stmtIdx)
            continue
          }
          walkVal(rhs, stmts, stmtIdx)
        }
        return
      }
      if (op === '=' && Array.isArray(n[1]) && n[1][0] === '[]' && n[1].length === 3 && typeof n[1][1] === 'string') {
        const [, lhs, rhs] = n
        if (lhs[2] != null) walkVal(lhs[2], stmts, stmtIdx)
        if (Array.isArray(rhs) && rhs[0] === '{}') {
          const { sid, mayBeObject } = elemInfo(lhs[1])
          const s = mayBeObject ? litSid(rhs) : null
          if (s != null && s === sid) candidates.push({ fn, sid: s, lit: rhs, block: stmts, stmtIdx, arrName: lhs[1] })
          // literal is a fresh value — walk only its slot values
          for (let i = 1; i < rhs.length; i++) walkSlotValues(rhs[i], stmts, stmtIdx)
        } else walkVal(rhs, stmts, stmtIdx)
        return
      }
      if (op === 'for-of') {
        // `for (const p of arr)` binds untracked element aliases
        const src = n[2]
        if (typeof src === 'string') poisonElem(src)
        else walkVal(src, stmts, stmtIdx)
        for (let i = 3; i < n.length; i++) walkStmt(n[i], stmts, stmtIdx)
        return
      }
      if (op === '=>') {
        // closure body: value-walk everything (captured aliases poison via names)
        for (let i = 1; i < n.length; i++) walkVal(n[i], stmts, stmtIdx)
        return
      }
      if (op === 'for' || op === 'while' || op === 'do' || op === 'if' || op === 'for-in') {
        // for is flat post-prepare: ['for', init, cond, step, body]
        for (let i = 1; i < n.length; i++) walkStmt(n[i], stmts, stmtIdx)
        return
      }
      // container-method calls: literal args are fresh single-home values
      if (op === '()' && Array.isArray(n[1]) && (n[1][0] === '.') && CONTAINER_METHODS.has(n[1][2])) {
        if (typeof n[1][1] !== 'string') walkVal(n[1][1], stmts, stmtIdx)
        const argNode = n[2]
        const args = argNode == null ? [] : (Array.isArray(argNode) && argNode[0] === ',') ? argNode.slice(1) : [argNode]
        for (const a of args) {
          if (Array.isArray(a) && a[0] === '{}') { for (let i = 1; i < a.length; i++) walkSlotValues(a[i], stmts, stmtIdx) }
          else walkVal(a, stmts, stmtIdx)
        }
        return
      }
      walkVal(n, stmts, stmtIdx)
    }

    walkStmt(fn.body, null, 0)
  }

  const containsName = (n, name) => {
    if (n === name) return true
    if (!Array.isArray(n)) return false
    for (let i = (n[0] === 'str' ? n.length : 1); i < n.length; i++) if (containsName(n[i], name)) return true
    return false
  }

  // Content-keyed result: per-function body transforms and emit-time inlining
  // between plan and emit rebuild the tree (and splice bodies across function
  // frames), so neither node identity nor the enclosing function name survives
  // to emitElementAssign. A `receiver|literal` content key is sound only if
  // EVERY same-content candidate program-wide validates — group and meet.
  // (An inliner that RENAMES the receiver makes the key miss → no transform —
  // safe in the conservative direction.)
  const verdict = new Map()  // key → all-instances-valid
  for (const c of candidates) {
    const key = inplaceKey(c.arrName, c.lit)
    let ok = !poisonAll && !poisoned.has(c.sid)
    for (const a of aliases) {
      if (!ok) break
      if (a.sid !== c.sid) continue
      // an alias in another function (or another block) could live across the
      // call/iteration into this store — reject
      if (a.fn !== c.fn || a.block !== c.block || a.declIdx >= c.stmtIdx) { ok = false; break }
      // any mention after the store in the same block observes the overwrite
      for (let i = c.stmtIdx + 1; i < c.block.length && ok; i++)
        if (containsName(c.block[i], a.name)) ok = false
    }
    verdict.set(key, (verdict.get(key) ?? true) && ok)
    if (ok && DBG) console.error('[inplace-ok]', c.fn.name, c.arrName, 'sid', c.sid)
  }
  const out = new Set()
  for (const [key, ok] of verdict) if (ok) out.add(key)
  ctx.schema.inplaceStores = out
  if (DBG) console.error('[inplace]', 'candidates:', candidates.length, 'aliases:', aliases.length, 'poisoned:', [...poisoned], 'poisonAll:', poisonAll, 'eligible:', candidates.filter(c => out.has(c.lit)).length)
  return out
}
