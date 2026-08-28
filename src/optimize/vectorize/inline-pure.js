import { findBodyStart } from '../../ir.js'
import { walkAst } from '../../ast.js'
import { isArr } from './node-utils.js'
import { writesName } from './outer-scaffold.js'

// Inline a PURE user function call `(call $f ARG…)` into a single scalar value-BLOCK, feeding
// the result back through liftExprV so the callee's ternaries/compares/transcendentals lift via
// the SAME machinery (no separate restricted inliner). Bails (null) on any non-value statement
// (store/loop/impure) — only straight-line pure helpers (spow, a signed-power, …) inline.
//
// Every argument AND every callee local is bound ONCE to a fresh block-local; param/local reads
// substitute to `(local.get bind)`. This is critical for NESTED calls (spow whose ratio arg is
// used 3× and itself nests spow): naive expr substitution would duplicate each arg per use and
// blow up exponentially (there is no CSE pass after the 'post' vectorizer). Binding keeps the
// SIMD body the same size as the scalar call graph.
// Infer the wasm type of a value node — from its `.type` expando (jz stamps every instruction) or
// the op prefix (`f64.add`→f64, `i32.mul`→i32, v128 ops→v128). Used to declare inline temps.
function nodeWasmType(n) {
  if (isArr(n)) {
    if (typeof n.type === 'string') return n.type
    const op = n[0]
    if (typeof op === 'string') {
      if (op.startsWith('f64.') || op === 'f64x2.extract_lane') return 'f64'
      if (op.startsWith('f32.')) return 'f32'
      if (op.startsWith('i64.')) return 'i64'
      if (op.startsWith('i32.')) return 'i32'
      if (op.startsWith('f64x2.') || op.startsWith('f32x4.') || op.startsWith('i32x4.') || op.startsWith('i8x16.') || op.startsWith('i16x8.') || op.startsWith('i64x2.') || op.startsWith('v128.')) return 'v128'
    }
  }
  return null
}

// Inline a pure function call into an expression, returning a `(block (result T) …binds… value)`
// (or the bare value if no binding was needed) — or null if the callee isn't straight-line pure.
// `resultType` is the callee's result type ('f64' by default, the vectorizer's only use). When a
// `localSink` array is passed, the fresh `$__ia` binding temps are declared into it (`['local', n, T]`)
// so a general caller can hoist them into the enclosing function; the vectorizer omits it (its lane
// lift re-types the block). Params must be read-only (else the substitution model breaks).
export function inlinePureCallExpr(callNode, pureFuncMap, freshIdRef, localSink = null, resultType = 'f64', tempPrefix = '$__ia') {
  const callee = pureFuncMap && pureFuncMap.get(callNode[1])
  if (!callee) return null
  const bodyStart = findBodyStart(callee)
  if (bodyStart < 0) return null
  const params = [], paramType = new Map(), localType = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const d = callee[i]
    if (isArr(d) && d[0] === 'param' && typeof d[1] === 'string') { params.push(d[1]); paramType.set(d[1], d[2]) }
    else if (isArr(d) && d[0] === 'local' && typeof d[1] === 'string') localType.set(d[1], d[2])
  }
  const args = callNode.slice(2)
  if (args.length !== params.length) return null
  const body = callee.slice(bodyStart)
  for (const p of params) if (writesName(body, p)) return null   // params must be read-only
  const subst = new Map()
  // Callee-local RENAMING (general-inliner path, localSink passed): a callee local
  // reached via `local.tee` / control-flow `local.set` isn't captured by bindOnce,
  // so its NAME would collide with same-named caller locals (the canonical trap:
  // arrow `(x,k)=>…` inlined into a caller whose variable is also `x`). Rename at
  // substitution time — sub() returns substituted caller-arg nodes WHOLE without
  // descending, so a rename can never touch a caller node. A tee/set of a name
  // bindOnce already substituted means reads and writes diverged — bail (broken).
  let broken = false
  // Caller-origin subtrees injected by substitution, tracked by node IDENTITY: the
  // leak backstop must skip them — a caller local legitimately named like a callee
  // local (`x`/`k` args into an `(x,k)=>…` arrow) is not a leak.
  const injected = new Set()
  const renames = localSink ? new Map() : null
  const renameOf = (name) => {
    let r = renames.get(name)
    if (!r) {
      r = `${tempPrefix}${freshIdRef.next++}`
      renames.set(name, r)
      localSink.push(['local', r, localType.get(name) || 'f64'])
    }
    return r
  }
  const sub = (n) => {
    if (!isArr(n)) return n
    if (n[0] === 'local.get' && typeof n[1] === 'string') {
      if (subst.has(n[1])) { const v = subst.get(n[1]); injected.add(v); return v }
      if (renames && localType.has(n[1])) return ['local.get', renameOf(n[1])]
    }
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') {
      if (subst.has(n[1])) { broken = true; return n }
      if (renames && localType.has(n[1])) return [n[0], renameOf(n[1]), ...n.slice(2).map(sub)]
    }
    return n.map((c, i) => i === 0 ? c : sub(c))
  }
  // A constant / bare local read is free to duplicate — substitute it directly (no binding),
  // which also keeps a constant exponent literal at the `pow` node so it can lower to 2-wide exp∘log.
  // convert-of-local too: one op over a register read, and keeping the convert SYNTACTIC at
  // every use is what lets the trunc∘convert / guard-vs-impossible-const identities fire
  // (the devirt arm-inline spills i32 args in that exact shape).
  const isTrivial = (n) => isArr(n) && (n[0] === 'f64.const' || n[0] === 'i32.const' ||
    (n[0] === 'local.get' && typeof n[1] === 'string') || (n[0] === 'global.get' && typeof n[1] === 'string') ||
    (n[0] === 'f64.convert_i32_s' && isArr(n[1]) && n[1][0] === 'local.get'))
  const pre = []
  const bindOnce = (name, valueExpr, declType, alreadySubbed) => {
    const v = alreadySubbed ? valueExpr : sub(valueExpr)
    if (isTrivial(v)) { subst.set(name, v); return }   // cheap → substitute directly, no temp
    const bn = `${tempPrefix}${freshIdRef.next++}`
    const t = declType || nodeWasmType(v) || 'f64'
    if (localSink) localSink.push(['local', bn, t])
    pre.push(['local.set', bn, v])
    subst.set(name, ['local.get', bn])
  }
  params.forEach((p, i) => bindOnce(p, args[i], paramType.get(p), true))   // args live in the OUTER scope — do NOT sub
  // Leak guard: a callee local reached only via `local.tee` (a CSE'd subexpression) or set inside
  // control flow is NOT captured by the top-level bindOnce, so its name would survive into the caller
  // where it isn't declared ("$x not in scope"). For the general inliner (localSink passed): RENAME
  // any surviving TRUE-local name to a fresh caller-scope local declared into the sink — sound,
  // locals are function-scoped names (a tee'd NaN-guard local `(x,k)=>(x??0)|0` is the canonical
  // shape). Params are read-only and fully substituted by bindOnce, so a surviving PARAM name means
  // the model broke — bail (keep the call) as the backstop. The VECTORIZER path (localSink == null)
  // re-processes the returned expression in its lane context — a tee'd callee local becomes a lane
  // local there — so it must NOT bail or rename, or pure helpers with a CSE'd tee (spow's `av`)
  // stop vectorizing.
  const calleeLocals = new Set([...paramType.keys(), ...localType.keys()])
  // Backstop: with renaming inlined into sub(), the only way a callee name survives
  // into a sink-spliced result is a broken substitution model (e.g. a param name in
  // write position, or a bindOnce'd local later tee'd). Bail — keep the call. The
  // VECTORIZER path (localSink == null) neither renames nor bails: it re-processes
  // the expression in its lane context, where a tee'd callee local becomes a lane
  // local — bailing there would stop pure helpers with a CSE'd tee (spow's `av`)
  // from vectorizing.
  const leaks = (root) => {
    let found = false
    walkAst(root, { enter: n => {
      if (found || injected.has(n)) return false
      if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && calleeLocals.has(n[1])) { found = true; return false }
    } })
    return found
  }
  const wrap = (val) => {
    const r = pre.length ? ['block', ['result', resultType], ...pre, val] : val
    return (localSink && (broken || leaks(r))) ? null : r
  }
  for (let k = 0; k < body.length; k++) {
    const stmt = body[k]
    if (!isArr(stmt)) return null
    if (stmt[0] === 'local.set' && typeof stmt[1] === 'string' && stmt.length === 3) { bindOnce(stmt[1], stmt[2], localType.get(stmt[1]), false); continue }
    if (stmt[0] === 'return' && stmt.length === 2) return wrap(sub(stmt[1]))
    // Trailing value expression = implicit return (a bare `if`/`block`/… as the function's last
    // statement, `(v) => cond ? a : b`). Earlier non-set/non-return statements can't be values.
    if (k === body.length - 1) return wrap(sub(stmt))
    return null
  }
  return null
}

// Statement-position containers: a call that is a DIRECT child here may be a statement (void /
// block-fallthrough), where the value-producing `(block (result T) …)` inline form is ill-typed.
// The general inliner only rewrites calls in operand (value) position — the common `x = f(…)`,
// `a[i] = f(…)`, `f(…) * k` shapes — and recurses into these so nested-in-operand calls still inline.
const INLINE_STMT_CTX = new Set(['block', 'loop', 'func', 'then', 'else', 'if'])

// General pre-watr pure-function inlining — jz LOWERING (runs before the vectorizer). Replaces a
// `(call $g …)` in value position with $g's inlined body when $g is PURE (pureFuncMap) and
// straight-line. jz decides by PURITY + TYPES — knowledge watr's untyped, size-gated inliner lacks —
// exposing the callee's arithmetic to the vectorizer / narrower / const-folder. watr keeps only the
// mechanical residual. Bit-exact: params are read-only, args bind once (or substitute if trivial),
// the callee's straight-line body becomes a result-typed block. Fresh temps are declared into `fn`.
export function inlinePureFnsInFn(fn, pureFuncMap, freshIdRef, canInline) {
  if (!isArr(fn) || fn[0] !== 'func' || !pureFuncMap || !pureFuncMap.size || !canInline || !canInline.size) return
  const selfName = fn[1]
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const newLocals = []
  const resultTypeOf = (callee) => {
    for (let i = 2; i < callee.length; i++) {
      const d = callee[i]
      if (!isArr(d)) break
      if (d[0] === 'result') return d[1]
      if (d[0] !== 'param' && d[0] !== 'export' && d[0] !== 'local' && d[0] !== 'type') break
    }
    return 'f64'
  }
  const walk = (node) => {
    if (!isArr(node)) return node
    const parentIsStmt = INLINE_STMT_CTX.has(node[0])
    for (let i = 1; i < node.length; i++) {
      let child = node[i]
      if (!isArr(child)) continue
      child = walk(child)          // recurse first → inline nested calls (e.g. in this call's args)
      node[i] = child
      if (!parentIsStmt && child[0] === 'call' && typeof child[1] === 'string' &&
          child[1] !== selfName && canInline.has(child[1]) && pureFuncMap.has(child[1])) {
        const inlined = inlinePureCallExpr(child, pureFuncMap, freshIdRef, newLocals, resultTypeOf(pureFuncMap.get(child[1])), '$__gi')
        if (inlined != null) node[i] = inlined
      }
    }
    return node
  }
  for (let i = bodyStart; i < fn.length; i++) fn[i] = walk(fn[i])
  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}
