/**
 * Call-graph reshaping — three related transforms that fold dynamic dispatch
 * into static control flow:
 *
 *   - `inlineHotInternalCalls`   — non-exported call sites whose callee is a
 *                                  small, simple-arg function get the body
 *                                  spliced in. Threshold-gated by callsite
 *                                  count and loop depth (`programFacts`).
 *   - `inlineLocalLambdas`       — `const f = (a) => …; … f(x) …` inside one
 *                                  function body, where `f` is non-escaping,
 *                                  splices the lambda body at each call.
 *   - `specializeFixedRestCalls` — `f(...args)` with statically-known argc
 *                                  produces a clone of `f` whose rest param
 *                                  is destructured at fixed indices; the
 *                                  spread call collapses to a fixed-arity one.
 *
 * Each transform mutates `ctx.func.list` / `func.body` and returns `boolean`
 * indicating whether anything changed (so `plan()` knows to invalidate the
 * program-facts cache).
 *
 * @module compile/plan/inline
 */

import { ctx } from '../../ctx.js'
import {
  callArgs, setCallArgs, some, blockStmts, T, refsName, refsAny, REFS_IN_EXPR,
  extractParams,
} from '../../ast.js'
import { cloneWithSubst } from '../../type.js'
import { constIntExpr } from '../../static.js'
import { analyzeBody } from '../analyze.js'
import {
  LOOP_OPS, isSimpleArg, mutatesAny, loopDepth, nodeSize, clonePlain, collectBindings,
  fixedTypedArraysInBody, forLoopBodyIndex, withForLoopBody,
} from './common.js'

// Returns { prefix, value } where prefix is the substituted body statements
// (excluding any trailing `return X`), and value is the substituted return
// expression — null if void or no trailing return value.
const inlinedBody = (func, args) => {
  const params = func.sig.params
  if (args.length !== params.length || !args.every(isSimpleArg)) return null
  const paramNames = new Set(params.map(p => p.name))
  if (mutatesAny(func.body, paramNames)) return null

  const subst = new Map()
  for (let i = 0; i < params.length; i++) subst.set(params[i].name, args[i])

  const locals = new Set()
  collectBindings(func.body, locals)
  for (const p of params) locals.delete(p.name)

  const rename = new Map()
  for (const name of locals) rename.set(name, `${T}inl${ctx.func.uniq++}_${name}`)

  const stmts = blockStmts(func.body)
  // Expression-bodied arrow `(c) => expr`: no statement block; the whole body
  // *is* the return value. Treat as zero-prefix + value.
  if (!stmts) return { prefix: [], value: cloneWithSubst(func.body, subst, rename) }
  const last = stmts.length ? stmts[stmts.length - 1] : null
  const isTrailingReturn = Array.isArray(last) && last[0] === 'return'
  const prefixSrc = isTrailingReturn ? stmts.slice(0, -1) : stmts
  const prefix = prefixSrc.map(stmt => cloneWithSubst(stmt, subst, rename))
  const value = isTrailingReturn && last.length > 1 ? cloneWithSubst(last[1], subst, rename) : null
  return { prefix, value }
}

const stmtDeclName = (stmt) => {
  if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) return null
  const decl = stmt[1]
  return Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' ? decl[1] : null
}

const whileInductionVar = (cond) => {
  if (typeof cond === 'string') return cond
  if (!Array.isArray(cond)) return null
  const op = cond[0]
  if ((op === '<' || op === '<=' || op === '>' || op === '>=') && typeof cond[1] === 'string') return cond[1]
  return null
}

// When splicing an inlined kernel into a loop, hoist leading decls that do not
// reference the loop induction var (e.g. floatbeat chord tables).
const partitionInvariantPrefix = (prefix, variantNames) => {
  if (!prefix.length || !variantNames?.size) return { hoisted: [], rest: prefix }
  const hoisted = []
  let i = 0
  for (; i < prefix.length; i++) {
    const s = prefix[i]
    if (!stmtDeclName(s) || refsAny(s, variantNames, REFS_IN_EXPR)) break
    hoisted.push(s)
  }
  return { hoisted, rest: prefix.slice(i) }
}

const spliceInlinedShape = (prefix, valueStmt, loopVariantNames) => {
  const { hoisted, rest } = partitionInvariantPrefix(prefix, loopVariantNames)
  const splice = [...rest, valueStmt]
  return { node: ['{}', [';', ...splice]], splice, hoisted, changed: true }
}

const isCandidateCall = (node, candidates) =>
  Array.isArray(node) && node[0] === '()' && typeof node[1] === 'string' && candidates.has(node[1])

// Recursively substitute calls to expr-bodied candidates anywhere in `node`.
// Used for tiny pure-expression helpers (`isAlpha(c) => …`) that get called
// from expression contexts (if-conditions, ternary tests). For these the
// inlined body is value-only (zero prefix), so a pure substitution is safe.
const inlineInExpr = (node, candidates) => {
  if (!Array.isArray(node)) return { node, changed: false }
  if (node[0] === '=>') return { node, changed: false }
  let changed = false
  const next = [node[0]]
  for (let i = 1; i < node.length; i++) {
    const r = inlineInExpr(node[i], candidates)
    if (r.changed) changed = true
    next.push(r.node)
  }
  if (isCandidateCall(next, candidates)) {
    const args = callArgs(next)
    const shape = args && inlinedBody(candidates.get(next[1]), args)
    if (shape && shape.value !== null && shape.prefix.length === 0) {
      return { node: shape.value, changed: true }
    }
  }
  return { node: changed ? next : node, changed }
}

const inlineInStmt = (stmt, candidates, loopVariantNames = null) => {
  if (!Array.isArray(stmt)) return { node: stmt, changed: false }
  // Statement-position call: discard return value, splice prefix in place.
  if (isCandidateCall(stmt, candidates)) {
    const args = callArgs(stmt)
    const shape = args && inlinedBody(candidates.get(stmt[1]), args)
    if (shape) {
      const { hoisted, rest } = partitionInvariantPrefix(shape.prefix, loopVariantNames)
      return { node: ['{}', [';', ...rest]], changed: true, splice: rest, hoisted }
    }
  }
  // `let/const X = call(...)` with single decl: inline as prefix + decl(value).
  if ((stmt[0] === 'let' || stmt[0] === 'const') && stmt.length === 2) {
    const decl = stmt[1]
    if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && isCandidateCall(decl[2], candidates)) {
      const args = callArgs(decl[2])
      const shape = args && inlinedBody(candidates.get(decl[2][1]), args)
      if (shape && shape.value !== null) {
        const { hoisted, rest } = partitionInvariantPrefix(shape.prefix, loopVariantNames)
        const splice = [...rest, [stmt[0], ['=', decl[1], shape.value]]]
        return { node: ['{}', [';', ...splice]], changed: true, splice, hoisted }
      }
    }
  }
  // `X = call(...)` at statement position: inline as prefix + assign(value).
  // LHS may be a name or an indexed lvalue (`out[i] = beat(...)` in fill loops).
  if (stmt[0] === '=' && isCandidateCall(stmt[2], candidates)) {
    const args = callArgs(stmt[2])
    const shape = args && inlinedBody(candidates.get(stmt[2][1]), args)
    if (shape && shape.value !== null) {
      return spliceInlinedShape(shape.prefix, ['=', stmt[1], shape.value], loopVariantNames)
    }
  }
  const op = stmt[0]
  if (op === ';') {
    let changed = false
    const next = [';']
    for (let i = 1; i < stmt.length; i++) {
      const r = inlineInStmt(stmt[i], candidates, loopVariantNames)
      changed ||= r.changed
      if (r.hoisted?.length) {
        next.push(...r.hoisted)
        changed = true
      }
      if (r.splice) next.push(...r.splice)
      else next.push(r.node)
    }
    return changed ? { node: next, changed: true } : { node: stmt, changed: false }
  }
  if (op === '{}') {
    const r = inlineInStmt(stmt[1], candidates, loopVariantNames)
    if (!r.changed) return { node: stmt, changed: false }
    // If the child was itself a candidate call (or a let/assign-of-call), it
    // already returned a `['{}', [';', ...prefix]]` shape. Re-wrapping here
    // would yield `['{}', ['{}', …]]`, which codegen rejects ("Unknown op: {}").
    if (Array.isArray(r.node) && r.node[0] === '{}') return { node: r.node, changed: true, hoisted: r.hoisted }
    return { node: ['{}', r.node], changed: true, hoisted: r.hoisted }
  }
  if (op === 'for') {
    const idx = forLoopBodyIndex(stmt)
    const vars = loopVariantNames ? new Set(loopVariantNames) : new Set()
    const r = inlineInStmt(stmt[idx], candidates, vars.size ? vars : null)
    if (!r.changed) return { node: stmt, changed: false }
    return { node: withForLoopBody(stmt, r.node), changed: true, hoisted: r.hoisted }
  }
  if (op === 'while') {
    const vars = loopVariantNames ? new Set(loopVariantNames) : new Set()
    const ind = whileInductionVar(stmt[1])
    if (ind) vars.add(ind)
    const r = inlineInStmt(stmt[2], candidates, vars.size ? vars : null)
    if (!r.changed) return { node: stmt, changed: false }
    return { node: ['while', stmt[1], r.node], changed: true, hoisted: r.hoisted }
  }
  if (op === 'if') {
    const thenR = inlineInStmt(stmt[2], candidates, loopVariantNames)
    const elseR = stmt.length > 3 ? inlineInStmt(stmt[3], candidates, loopVariantNames) : null
    if (thenR.changed || elseR?.changed) return {
      node: stmt.length > 3 ? ['if', stmt[1], thenR.node, elseR.node] : ['if', stmt[1], thenR.node],
      changed: true,
      hoisted: [...(thenR.hoisted || []), ...(elseR?.hoisted || [])],
    }
  }
  if (op === 'try' || op === 'catch' || op === 'finally') {
    let changed = false
    const next = [op]
    let hoisted = []
    for (let i = 1; i < stmt.length; i++) {
      const part = stmt[i]
      const r = Array.isArray(part) ? inlineInStmt(part, candidates, loopVariantNames) : { node: part, changed: false }
      changed ||= r.changed
      if (r.hoisted?.length) hoisted = hoisted.concat(r.hoisted)
      next.push(r.node)
    }
    return changed ? { node: next, changed: true, hoisted } : { node: stmt, changed: false }
  }
  return { node: stmt, changed: false }
}

export const inlineHotInternalCalls = (programFacts, ast) => {
  const cfg = ctx.transform.optimize
  if (cfg && cfg.sourceInline === false) return false

  const fixedByFunc = new Map(ctx.func.list.map(func => [func, fixedTypedArraysInBody(func.body)]))
  const typedByFunc = new Map(ctx.func.list.map(func => [func, analyzeBody(func.body).typedElems]))
  const sitesByCallee = new Map()
  for (const cs of programFacts.callSites) {
    const list = sitesByCallee.get(cs.callee)
    if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
  }

  const containsNode = (root, needle, inLoop = false) => {
    if (root === needle) return inLoop
    if (!Array.isArray(root) || root[0] === '=>') return false
    const nextInLoop = inLoop || LOOP_OPS.has(root[0])
    for (let i = 1; i < root.length; i++) if (containsNode(root[i], needle, nextInLoop)) return true
    return false
  }

  const hasFixedTypedArraySites = (func, sites) => {
    const params = func.sig?.params || []
    if (!sites?.length) return false
    return sites.every(site => params.some((p, i) => {
      const arg = site.argList[i]
      return typeof arg === 'string' && fixedByFunc.get(site.callerFunc)?.has(arg)
    }))
  }
  const hasFullyFixedTypedArraySites = (func, sites) => {
    const params = func.sig?.params || []
    if (!sites?.length) return false
    let sawTypedArg = false
    for (const site of sites) {
      const typed = typedByFunc.get(site.callerFunc)
      const fixed = fixedByFunc.get(site.callerFunc)
      for (let i = 0; i < params.length; i++) {
        const arg = site.argList[i]
        if (typeof arg !== 'string' || !typed?.has(arg)) continue
        sawTypedArg = true
        if (!fixed?.has(arg)) return false
      }
    }
    return sawTypedArg
  }

  const candidates = new Map()
  // Forwarders — a candidate whose body calls one of its own parameters.
  // Inlining one replaces that parameter with the call-site argument; when the
  // argument is a known function name the resulting indirect call collapses to
  // a direct `call` (devirtualization).
  const forwarders = new Set()
  // Loop-free leaves — safe to splice into EXPORTED callers too: the tier-up
  // rationale for skipping exports concerns relocating loop KERNELS into cold
  // entry points, not pulling a leaf INTO an export's hot loop (game-of-life's
  // step calls rot per cell; pre-Turboshaft wasm tiers never inline calls).
  const leaves = new Set()
  for (const func of ctx.func.list) {
    const sites = sitesByCallee.get(func.name)
    // Exported leaf/kernel with exactly one internal caller (e.g. fill→beat in
    // floatbeat): inline into the caller's loop but keep the export for external
    // one-off calls (bench beat()). Multi-caller exports stay outlined so V8 can
    // tier-up shared kernels.
    const soleCallerExport = func.exported && sites?.length === 1
    if (func.raw || !func.body || func.rest) continue
    if (func.exported && !soleCallerExport) continue
    if (programFacts.valueUsed.has(func.name) && !soleCallerExport) continue
    if (func.defaults && Object.keys(func.defaults).length) continue
    const paramNames = new Set((func.sig?.params || []).map(p => p.name))
    if (paramNames.size && some(func.body, n => {
      if (n[0] !== '()' || !Array.isArray(n[1]) || n[1][0] !== '.') return false
      const [, obj, prop] = n[1]
      return prop === 'push' && typeof obj === 'string' && paramNames.has(obj)
    })) continue
    const fixedTypedArraySite = hasFixedTypedArraySites(func, sites)
    const fullyFixedTypedArraySite = hasFullyFixedTypedArraySites(func, sites)
    const hasLoop = some(func.body, n => LOOP_OPS.has(n[0]))
    const isTinyLeaf = !hasLoop && nodeSize(func.body) <= 15
    if (!sites || sites.length < 1 || (!isTinyLeaf && !fixedTypedArraySite && sites.length > 2) || sites.length > 8) continue
    const stmts = blockStmts(func.body)
    // Expression-bodied arrow funcs (`(c) => expr`) have no block — body IS the
    // return value. Treat as a "tiny leaf" branch handled below; force hasLoop=false.
    if (some(func.body, n => n[0] === '=>')) continue
    // throw/break/continue are unsupported; return is OK if it's a single
    // trailing return (rewritten to a value at inlining time).
    if (some(func.body, n => n[0] === 'throw' || n[0] === 'break' || n[0] === 'continue')) continue
    let returnCount = 0
    some(func.body, n => { if (n[0] === 'return') returnCount++; return false })
    if (returnCount > 1) continue
    if (returnCount === 1 && stmts) {
      const last = stmts[stmts.length - 1]
      if (!Array.isArray(last) || last[0] !== 'return') continue
    }
    // Either a kernel (has a loop) or a tiny leaf (no loop, no calls, small body).
    // The leaf branch catches helpers like `isAlpha(c) => (c>=65 && c<=90) || …`
    // that get hammered from a hot caller's loop — replacing the call with its
    // body saves the per-iteration call+reinterpret overhead (tokenizer hot path).
    if (!hasLoop) {
      if (some(func.body, n => n[0] === '()' && typeof n[1] === 'string' && ctx.func.names.has(n[1]))) continue
      // Per-iteration call overhead dwarfs body-size bloat when EVERY site sits
      // inside a caller's loop (game-of-life's rot: ~40 nodes × 2 sites, fired
      // for most of 260k cells/frame). V8's pre-Turboshaft wasm tiers never
      // inline cross-function, so an out-of-line leaf in a hot loop is a hard
      // per-cell tax on Node ≤ 22 — and still saves call setup on newer tiers.
      const allSitesInLoop = sites.every(site =>
        site.callerFunc?.body && containsNode(site.callerFunc.body, site.node, false))
      if (nodeSize(func.body) > (allSitesInLoop ? 80 : 30)) continue
    }
    if (some(func.body, n => n[0] === '()' && n[1] === func.name)) continue
    // Kernels with nested loops (depth ≥ 2) are typically large and the inner
    // loop carries most of the cost. Inlining them into a host that V8 can't
    // tier up (e.g. a once-called wrapper) freezes the kernel in baseline.
    // Keep them as standalone functions so V8 wasm tier-up can warm them.
    if (loopDepth(func.body, 0) >= 2 && !fullyFixedTypedArraySite) continue
    // Factory functions that allocate pointers (`new TypedArray`, `new Array`,
    // object/array literals returned) break downstream pointer-ABI specialization
    // when inlined: narrow.js can't trace the post-inline alias chain back to a
    // single ctor, so the typed-array param of a callee like processCascade(x, …)
    // stays at generic f64 ABI with __typed_idx dispatch instead of i32 + f64.load.
    // Keeping the factory as a callable function preserves the call-site type fact.
    if (some(func.body, n => n[0] === '()' && typeof n[1] === 'string' && n[1].startsWith('new.'))) continue
    if (paramNames.size && some(func.body, n => n[0] === '()' && typeof n[1] === 'string' && paramNames.has(n[1])))
      forwarders.add(func.name)
    if (!hasLoop) leaves.add(func.name)
    candidates.set(func.name, func)
  }
  if (!candidates.size) return false

  // Trivial expr-bodied candidates can be substituted at any expression position
  // (if-condition, ternary, etc.). Stmt-bodied ones go through inlineInStmt's
  // statement-level path which preserves prefix ordering.
  const exprOnlyCandidates = new Map()
  for (const [name, func] of candidates) {
    if (!Array.isArray(func.body) || func.body[0] !== '{}') exprOnlyCandidates.set(name, func)
  }

  let changed = false
  const exportedCandidates = new Map()
  for (const [name, func] of candidates) {
    const sites = sitesByCallee.get(name)
    const fixedSiteExported = hasFixedTypedArraySites(func, sites) &&
      !sites.some(site => site.callerFunc?.exported && site.callerFunc.body && containsNode(site.callerFunc.body, site.node))
    // Forwarders cross into an exported caller too: the tier-up rationale that
    // keeps candidates out of exports concerns relocated loop kernels, not
    // these tiny leaves — and inlining one devirtualizes a closure dispatch.
    if (fixedSiteExported || forwarders.has(name) || leaves.has(name) || sites?.length === 1) exportedCandidates.set(name, func)
  }
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    // Skip exports: they're entry points usually invoked once. Inlining a
    // hot kernel here would put the loop into a function V8's wasm tier-up
    // never warms (kernel stays in baseline). Keeping the kernel as its own
    // callable function lets V8 promote it to TurboFan after a few calls.
    // Exception: fixed-size typed-array callees should inline into the exported
    // caller so scalar replacement can cross the call boundary and remove the
    // caller's heap arrays.
    const activeCandidates = func.exported ? exportedCandidates : candidates
    if (func.exported && !activeCandidates.size) continue
    // Expression-bodied arrows (`() => expr`) have func.body as the return
    // value itself — never a `{}` block. inlineInStmt treats its argument as a
    // statement (discards the return value of any top-level candidate call),
    // which would turn `() => x()` into an empty block and lose the result.
    // Route those through inlineInExpr so the call is replaced by the inlined
    // value expression instead.
    const isExprBody = !Array.isArray(func.body) || func.body[0] !== '{}'
    const r = isExprBody
      ? inlineInExpr(func.body, activeCandidates)
      : inlineInStmt(func.body, activeCandidates)
    let body = r.changed ? r.node : func.body
    let bodyChanged = r.changed
    if (!func.exported && exprOnlyCandidates.size) {
      const e = inlineInExpr(body, exprOnlyCandidates)
      if (e.changed) { body = e.node; bodyChanged = true }
    }
    if (bodyChanged) { func.body = body; changed = true }
  }
  if (ast) {
    const r = inlineInStmt(ast, candidates)
    if (r.changed) changed = true
  }
  return changed
}

// === Inline non-escaping local lambdas ===
// `const f = (a) => …; … f(x) …` → the lambda body substituted at each call
// site. A non-escaping lambda's captured free vars are still in lexical scope at
// the call site, so splicing the body in place preserves capture-by-reference
// semantics while eliminating the closure object (no env pointer, no NaN-box, no
// call_indirect). Mirrors inlineHotInternalCalls, scoped to one function body.

// True iff every textual reference to `name` in `node` is the callee of a
// `name(...)` call (i.e. the binding never escapes — never read as a value,
// reassigned, captured by a nested lambda, or shadowed).
const onlyCalledNotReferenced = (node, name) => {
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (op === 'str') return true
  // A nested lambda touching `name` at all (capture or shadowing param) → bail.
  if (op === '=>') return !refsName(node[1], name, REFS_IN_EXPR) && !refsName(node[2], name, REFS_IN_EXPR)
  if (op === '()' && node[1] === name) {
    for (let i = 2; i < node.length; i++) if (!onlyCalledNotReferenced(node[i], name)) return false
    return true
  }
  if (op === '.' || op === '?.') return onlyCalledNotReferenced(node[1], name)
  if (op === ':') return onlyCalledNotReferenced(node[2], name)
  for (let i = 1; i < node.length; i++) if (!onlyCalledNotReferenced(node[i], name)) return false
  return true
}

const bodyStmtList = body =>
  Array.isArray(body) && body[0] === '{}' ? blockStmts(body)
  : Array.isArray(body) && body[0] === ';' ? body.slice(1)
  : body == null ? [] : [body]

const removeStmts = (body, set) => {
  if (!Array.isArray(body)) return set.has(body) ? null : body
  if (body[0] === '{}') return ['{}', removeStmts(body[1], set) ?? [';']]
  if (body[0] === ';') {
    const kept = body.slice(1).filter(s => !set.has(s))
    return kept.length === 0 ? null : kept.length === 1 ? kept[0] : [';', ...kept]
  }
  return set.has(body) ? null : body
}

// Lambda body must be a guaranteed-return shape inlinedBody can splice: ≤1
// `return` (trailing, if a block), no throw/break/continue, no param mutation,
// no nested lambda.
const inlinableLambdaBody = (abody, params) => {
  if (some(abody, n => n[0] === '=>')) return false
  if (some(abody, n => n[0] === 'throw' || n[0] === 'break' || n[0] === 'continue')) return false
  let returns = 0
  some(abody, n => { if (n[0] === 'return') returns++; return false })
  if (returns > 1) return false
  if (returns === 1) {
    const stmts = blockStmts(abody)
    if (!stmts || !stmts.length) return false
    const last = stmts[stmts.length - 1]
    if (!Array.isArray(last) || last[0] !== 'return') return false
  }
  return !mutatesAny(abody, new Set(params))
}

const inlineLocalLambdasInBody = (getBody, setBody) => {
  const body = getBody()
  const stmts = bodyStmtList(body)
  if (stmts.length < 2) return false

  // Collect `const f = ARROW` (single-decl), all-plain params, inlinable body.
  const decls = new Map()
  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || stmt[0] !== 'const' || stmt.length !== 2) continue
    const d = stmt[1]
    if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
    const arrow = d[2]
    if (!Array.isArray(arrow) || arrow[0] !== '=>') continue
    const params = extractParams(arrow[1])
    if (!params.every(p => typeof p === 'string')) continue
    if (!inlinableLambdaBody(arrow[2], params)) continue
    decls.set(d[1], { stmt, arrow, params })
  }
  if (!decls.size) return false

  // Drop any candidate whose body references another (or its own) candidate —
  // single-level inlining can't resolve such chains, and a still-referenced
  // candidate's decl can't be removed.
  for (let changed = true; changed;) {
    changed = false
    for (const [name, info] of decls) {
      if ([...decls.keys()].some(c => refsName(info.arrow[2], c, REFS_IN_EXPR))) { decls.delete(name); changed = true }
    }
  }
  // Every other reference to the name must be a `name(...)` call.
  for (const [name, info] of [...decls]) {
    if (!stmts.every(s => s === info.stmt || onlyCalledNotReferenced(s, name))) decls.delete(name)
  }
  if (!decls.size) return false

  const asFunc = info => ({ sig: { params: info.params.map(name => ({ name })) }, body: info.arrow[2] })
  const stmtCands = new Map(), exprCands = new Map()
  for (const [name, info] of decls)
    (Array.isArray(info.arrow[2]) && info.arrow[2][0] === '{}' ? stmtCands : exprCands).set(name, asFunc(info))

  let out = body, didChange = false
  if (stmtCands.size) { const r = inlineInStmt(out, stmtCands); if (r.changed) { out = r.node; didChange = true } }
  if (exprCands.size) { const r = inlineInExpr(out, exprCands); if (r.changed) { out = r.node; didChange = true } }
  if (!didChange) return false

  // Remove decls of candidates that are now fully consumed.
  const newStmts = bodyStmtList(out)
  const dead = new Set()
  for (const [name, info] of decls) {
    if (!newStmts.some(s => s !== info.stmt && refsName(s, name, REFS_IN_EXPR))) dead.add(info.stmt)
  }
  if (dead.size) out = removeStmts(out, dead) ?? [';']

  setBody(out)
  return true
}

export const inlineLocalLambdas = () => {
  let changed = false
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    if (inlineLocalLambdasInBody(() => func.body, b => { func.body = b })) changed = true
  }
  return changed
}

const restIndexExpr = (idx, restParams) => {
  const k = constIntExpr(idx)
  if (k != null) return k >= 0 && k < restParams.length ? restParams[k] : [, undefined]

  let out = [, undefined]
  for (let i = restParams.length - 1; i >= 0; i--) {
    out = ['?:', ['==', clonePlain(idx), [, i]], restParams[i], out]
  }
  return out
}

const rewriteRestBody = (node, restName, restParams) => {
  if (typeof node === 'string') return node === restName ? { ok: false } : { ok: true, node }
  if (!Array.isArray(node)) return { ok: true, node }
  if (node[0] === 'str') return { ok: true, node: node.slice() }

  if ((node[0] === '.' || node[0] === '?.') && node[1] === restName) {
    return node[2] === 'length' ? { ok: true, node: [, restParams.length] } : { ok: false }
  }

  if (node[0] === '[]' && node[1] === restName) {
    if (!isSimpleArg(node[2])) return { ok: false }
    return { ok: true, node: restIndexExpr(node[2], restParams) }
  }

  const out = [node[0]]
  for (let i = 1; i < node.length; i++) {
    const r = rewriteRestBody(node[i], restName, restParams)
    if (!r.ok) return r
    out.push(r.node)
  }
  return { ok: true, node: out }
}

export const specializeFixedRestCalls = (programFacts) => {
  const sitesByKey = new Map()
  for (const site of programFacts.callSites) {
    const func = ctx.func.map.get(site.callee)
    if (!func?.rest || func.exported || func.raw || !func.body) continue
    if (programFacts.valueUsed.has(func.name)) continue
    if (func.defaults && Object.keys(func.defaults).length) continue
    if (site.argList.some(a => Array.isArray(a) && a[0] === '...')) continue

    const fixedN = func.sig.params.length - 1
    const restN = Math.max(0, site.argList.length - fixedN)
    const key = `${func.name}/${restN}`
    const list = sitesByKey.get(key)
    if (list) list.push(site); else sitesByKey.set(key, [site])
  }

  let changed = false
  for (const [key, sites] of sitesByKey) {
    const [name, restNText] = key.split('/')
    const func = ctx.func.map.get(name)
    const restN = Number(restNText)
    const fixedParams = func.sig.params.slice(0, -1).map(p => ({ ...p }))
    const restName = func.rest
    const restParams = Array.from({ length: restN }, (_, i) => `${restName}${T}r${restN}_${i}`)
    const rewritten = rewriteRestBody(func.body, restName, restParams)
    if (!rewritten.ok) continue

    const cloneName = `${name}${T}rest${restN}`
    if (!ctx.func.map.has(cloneName)) {
      const restSigParams = restParams.map(name => ({ name, type: 'f64' }))
      const clone = {
        ...func,
        name: cloneName,
        exported: false,
        rest: null,
        // Build the specialized sig fresh. `params`/`results` are sig's only
        // fields and both are replaced here, so a `{ ...func.sig, … }` spread
        // would be pure redundancy — and a full-override spread of a live sig
        // object also trips the self-host codegen, so the explicit form is both
        // simpler and the one that round-trips through jz.wasm.
        sig: {
          params: [...fixedParams, ...restSigParams],
          results: [...func.sig.results],
        },
        body: rewritten.node,
      }
      ctx.func.list.push(clone)
      ctx.func.names.add(cloneName)
      ctx.func.map.set(cloneName, clone)
    }

    const fixedN = func.sig.params.length - 1
    for (const site of sites) {
      site.node[1] = cloneName
      setCallArgs(site.node, site.argList.slice(0, fixedN + restN))
      changed = true
    }
  }
  return changed
}
