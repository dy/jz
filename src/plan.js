/** Pre-emit compile planning: collect facts, resolve ABIs, and run narrowing. */

import { ctx } from './ctx.js'
import { T } from './analyze.js'
import { VAL, valTypeOf, typedElemCtor, typedElemAux, updateGlobalRep, collectProgramFacts } from './analyze.js'
import { MAX_CLOSURE_ARITY } from './ir.js'
import narrowSignatures, { specializeBimorphicTyped, refineDynKeys } from './narrow.js'

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??='])
const CONTROL_TRANSFER = new Set(['return', 'throw', 'break', 'continue'])
const LOOP_OPS = new Set(['for', 'while', 'do', 'do-while'])

const isSeq = node => Array.isArray(node) && node[0] === ';'
const blockStmts = body => {
  if (!Array.isArray(body) || body[0] !== '{}') return null
  const inner = body[1]
  if (!Array.isArray(inner)) return inner == null ? [] : [inner]
  return inner[0] === ';' ? inner.slice(1) : [inner]
}

const callArgs = node => {
  if (!Array.isArray(node) || node[0] !== '()') return null
  const raw = node[2]
  return raw == null ? [] : (Array.isArray(raw) && raw[0] === ',') ? raw.slice(1) : [raw]
}

const isSimpleArg = node => {
  if (typeof node === 'string' || typeof node === 'number') return true
  if (!Array.isArray(node)) return false
  if (node[0] == null) return typeof node[1] === 'number'
  if (node[0] === 'str') return typeof node[1] === 'string'
  if (node[0] === 'u-' || (node[0] === '-' && node.length === 2)) return isSimpleArg(node[1])
  if (['+', '-', '*', '%', '&', '|', '^', '<<', '>>', '>>>'].includes(node[0]))
    return isSimpleArg(node[1]) && isSimpleArg(node[2])
  return false
}

const scanBody = (node, fn) => {
  if (!Array.isArray(node)) return false
  if (fn(node)) return true
  if (node[0] === '=>') return false
  for (let i = 1; i < node.length; i++) if (scanBody(node[i], fn)) return true
  return false
}

const loopDepth = (node, depth) => {
  if (!Array.isArray(node)) return depth
  if (node[0] === '=>') return depth
  const here = LOOP_OPS.has(node[0]) ? depth + 1 : depth
  let max = here
  for (let i = 1; i < node.length; i++) {
    const d = loopDepth(node[i], here)
    if (d > max) max = d
  }
  return max
}

const nodeSize = (node) => {
  if (!Array.isArray(node)) return 1
  let n = 1
  for (let i = 1; i < node.length; i++) n += nodeSize(node[i])
  return n
}

const collectBindings = (node, out) => {
  if (!Array.isArray(node)) return
  const op = node[0]
  if (op === '=>') return
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) collectBindingTarget(node[i], out)
  }
  for (let i = 1; i < node.length; i++) collectBindings(node[i], out)
}

const collectBindingTarget = (node, out) => {
  if (typeof node === 'string') { out.add(node); return }
  if (!Array.isArray(node)) return
  if (node[0] === '=') collectBindingTarget(node[1], out)
  else if (node[0] === '...' && typeof node[1] === 'string') out.add(node[1])
  else if (node[0] === ',' || node[0] === '[]' || node[0] === '{}')
    for (let i = 1; i < node.length; i++) collectBindingTarget(node[i], out)
}

const mutatesAny = (node, names) => scanBody(node, n => {
  const op = n[0]
  if ((op === '++' || op === '--') && typeof n[1] === 'string') return names.has(n[1])
  return ASSIGN_OPS.has(op) && typeof n[1] === 'string' && names.has(n[1])
})

const clonePlain = node => Array.isArray(node) ? node.map(clonePlain) : node

const cloneWithSubst = (node, subst, rename) => {
  if (typeof node === 'string') {
    if (subst.has(node)) return clonePlain(subst.get(node))
    return rename.get(node) || node
  }
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === 'str') return node.slice()
  if (op === '.' || op === '?.') return [op, cloneWithSubst(node[1], subst, rename), node[2]]
  if (op === ':') return [op, node[1], cloneWithSubst(node[2], subst, rename)]
  return node.map((part, i) => i === 0 ? part : cloneWithSubst(part, subst, rename))
}

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

const inlineInStmt = (stmt, candidates) => {
  if (!Array.isArray(stmt)) return { node: stmt, changed: false }
  // Statement-position call: discard return value, splice prefix in place.
  if (isCandidateCall(stmt, candidates)) {
    const args = callArgs(stmt)
    const shape = args && inlinedBody(candidates.get(stmt[1]), args)
    if (shape) return { node: ['{}', [';', ...shape.prefix]], changed: true, splice: shape.prefix }
  }
  // `let/const X = call(...)` with single decl: inline as prefix + decl(value).
  if ((stmt[0] === 'let' || stmt[0] === 'const') && stmt.length === 2) {
    const decl = stmt[1]
    if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && isCandidateCall(decl[2], candidates)) {
      const args = callArgs(decl[2])
      const shape = args && inlinedBody(candidates.get(decl[2][1]), args)
      if (shape && shape.value !== null) {
        const splice = [...shape.prefix, [stmt[0], ['=', decl[1], shape.value]]]
        return { node: ['{}', [';', ...splice]], changed: true, splice }
      }
    }
  }
  // `X = call(...)` at statement position: inline as prefix + assign(value).
  if (stmt[0] === '=' && typeof stmt[1] === 'string' && isCandidateCall(stmt[2], candidates)) {
    const args = callArgs(stmt[2])
    const shape = args && inlinedBody(candidates.get(stmt[2][1]), args)
    if (shape && shape.value !== null) {
      const splice = [...shape.prefix, ['=', stmt[1], shape.value]]
      return { node: ['{}', [';', ...splice]], changed: true, splice }
    }
  }
  const op = stmt[0]
  if (op === ';') {
    let changed = false
    const next = [';']
    for (let i = 1; i < stmt.length; i++) {
      const r = inlineInStmt(stmt[i], candidates)
      changed ||= r.changed
      if (r.splice) next.push(...r.splice)
      else next.push(r.node)
    }
    return changed ? { node: next, changed } : { node: stmt, changed: false }
  }
  if (op === '{}') {
    const r = inlineInStmt(stmt[1], candidates)
    return r.changed ? { node: ['{}', r.node], changed: true } : { node: stmt, changed: false }
  }
  if (op === 'for') {
    const r = inlineInStmt(stmt[4], candidates)
    return r.changed ? { node: ['for', stmt[1], stmt[2], stmt[3], r.node], changed: true } : { node: stmt, changed: false }
  }
  if (op === 'while') {
    const r = inlineInStmt(stmt[2], candidates)
    return r.changed ? { node: ['while', stmt[1], r.node], changed: true } : { node: stmt, changed: false }
  }
  if (op === 'if') {
    const thenR = inlineInStmt(stmt[2], candidates)
    const elseR = stmt.length > 3 ? inlineInStmt(stmt[3], candidates) : null
    if (thenR.changed || elseR?.changed) return {
      node: stmt.length > 3 ? ['if', stmt[1], thenR.node, elseR.node] : ['if', stmt[1], thenR.node],
      changed: true,
    }
  }
  if (op === 'try' || op === 'catch' || op === 'finally') {
    let changed = false
    const next = [op]
    for (let i = 1; i < stmt.length; i++) {
      const part = stmt[i]
      const r = Array.isArray(part) ? inlineInStmt(part, candidates) : { node: part, changed: false }
      changed ||= r.changed
      next.push(r.node)
    }
    return changed ? { node: next, changed: true } : { node: stmt, changed: false }
  }
  return { node: stmt, changed: false }
}

const inlineHotInternalCalls = (programFacts, ast) => {
  const cfg = ctx.transform.optimize
  if (cfg && cfg.sourceInline === false) return false

  const sitesByCallee = new Map()
  for (const cs of programFacts.callSites) {
    const list = sitesByCallee.get(cs.callee)
    if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
  }

  const candidates = new Map()
  for (const func of ctx.func.list) {
    if (func.exported || func.raw || !func.body || func.rest || programFacts.valueUsed.has(func.name)) continue
    if (func.defaults && Object.keys(func.defaults).length) continue
    const sites = sitesByCallee.get(func.name)
    if (!sites || sites.length < 1 || sites.length > 2) continue
    const stmts = blockStmts(func.body)
    // Expression-bodied arrow funcs (`(c) => expr`) have no block — body IS the
    // return value. Treat as a "tiny leaf" branch handled below; force hasLoop=false.
    if (scanBody(func.body, n => n[0] === '=>')) continue
    // throw/break/continue are unsupported; return is OK if it's a single
    // trailing return (rewritten to a value at inlining time).
    if (scanBody(func.body, n => n[0] === 'throw' || n[0] === 'break' || n[0] === 'continue')) continue
    let returnCount = 0
    scanBody(func.body, n => { if (n[0] === 'return') returnCount++; return false })
    if (returnCount > 1) continue
    if (returnCount === 1 && stmts) {
      const last = stmts[stmts.length - 1]
      if (!Array.isArray(last) || last[0] !== 'return') continue
    }
    // Either a kernel (has a loop) or a tiny leaf (no loop, no calls, small body).
    // The leaf branch catches helpers like `isAlpha(c) => (c>=65 && c<=90) || …`
    // that get hammered from a hot caller's loop — replacing the call with its
    // body saves the per-iteration call+reinterpret overhead (tokenizer hot path).
    const hasLoop = scanBody(func.body, n => LOOP_OPS.has(n[0]))
    if (!hasLoop) {
      if (scanBody(func.body, n => n[0] === '()')) continue
      if (nodeSize(func.body) > 30) continue
    }
    if (scanBody(func.body, n => n[0] === '()' && n[1] === func.name)) continue
    // Kernels with nested loops (depth ≥ 2) are typically large and the inner
    // loop carries most of the cost. Inlining them into a host that V8 can't
    // tier up (e.g. a once-called wrapper) freezes the kernel in baseline.
    // Keep them as standalone functions so V8 wasm tier-up can warm them.
    if (loopDepth(func.body, 0) >= 2) continue
    // Factory functions that allocate pointers (`new TypedArray`, `new Array`,
    // object/array literals returned) break downstream pointer-ABI specialization
    // when inlined: narrow.js can't trace the post-inline alias chain back to a
    // single ctor, so the typed-array param of a callee like processCascade(x, …)
    // stays at generic f64 ABI with __typed_idx dispatch instead of i32 + f64.load.
    // Keeping the factory as a callable function preserves the call-site type fact.
    if (scanBody(func.body, n => n[0] === '()' && typeof n[1] === 'string' && n[1].startsWith('new.'))) continue
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
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    // Skip exports: they're entry points usually invoked once. Inlining a
    // hot kernel here would put the loop into a function V8's wasm tier-up
    // never warms (kernel stays in baseline). Keeping the kernel as its own
    // callable function lets V8 promote it to TurboFan after a few calls.
    if (func.exported) continue
    const r = inlineInStmt(func.body, candidates)
    let body = r.changed ? r.node : func.body
    let bodyChanged = r.changed
    if (exprOnlyCandidates.size) {
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

const scanGlobalValueFacts = (root) => {
  if (!root) return
  const stmts = Array.isArray(root) && root[0] === ';' ? root.slice(1) : [root]
  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'const' && stmt[0] !== 'let')) continue
    for (const decl of stmt.slice(1)) {
      if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
      const vt = valTypeOf(decl[2])
      if (vt) {
        if (!ctx.scope.globalValTypes) ctx.scope.globalValTypes = new Map()
        ctx.scope.globalValTypes.set(decl[1], vt)
        if (vt === VAL.REGEX && ctx.runtime.regex) ctx.runtime.regex.vars.set(decl[1], decl[2])
      }
      const ctor = typedElemCtor(decl[2])
      if (ctor) {
        if (!ctx.scope.globalTypedElem) ctx.scope.globalTypedElem = new Map()
        ctx.scope.globalTypedElem.set(decl[1], ctor)
      }
    }
  }
}

const unboxConstTypedGlobals = () => {
  if (!ctx.scope.globalTypedElem || !ctx.scope.consts) return
  for (const [name, ctor] of ctx.scope.globalTypedElem) {
    if (!ctx.scope.consts.has(name)) continue
    if (ctx.scope.globalValTypes?.get(name) !== VAL.TYPED) continue
    const aux = typedElemAux(ctor)
    if (aux == null) continue
    const decl = ctx.scope.globals.get(name)
    if (typeof decl !== 'string' || !decl.includes('mut f64')) continue
    ctx.scope.globals.set(name, `(global $${name} (mut i32) (i32.const 0))`)
    ctx.scope.globalTypes.set(name, 'i32')
    updateGlobalRep(name, { ptrKind: VAL.TYPED, ptrAux: aux })
  }
}

const materializeAutoBoxSchemas = (programFacts) => {
  if (!ctx.schema.register) return
  for (const [name, props] of programFacts.propMap) {
    if (ctx.schema.vars.has(name)) {
      const existing = ctx.schema.resolve(name)
      const newProps = [...props].filter(prop => !existing.includes(prop))
      if (newProps.length) {
        const merged = [...existing, ...newProps]
        const mergedId = ctx.schema.register(merged)
        ctx.schema.vars.set(name, mergedId)
      }
      continue
    }
    const valueProps = [...props].filter(prop => !ctx.func.names.has(`${name}$${prop}`))
    if (!valueProps.length) continue
    const allProps = [...props]
    const schema = ['__inner__', ...allProps]
    const schemaId = ctx.schema.register(schema)
    ctx.schema.vars.set(name, schemaId)
    if (ctx.func.names.has(name) && !ctx.scope.globals.has(name))
      ctx.scope.globals.set(name, `(global $${name} (mut f64) (f64.const 0))`)
    if (!ctx.schema.autoBox) ctx.schema.autoBox = new Map()
    ctx.schema.autoBox.set(name, { schemaId, schema })
  }
}

const resolveClosureWidth = (programFacts) => {
  if (!ctx.closure.make) return
  const { hasSpread, hasRest, maxCall, maxDef } = programFacts
  const floor = ctx.closure.floor ?? 0
  ctx.closure.width = (hasSpread && hasRest)
    ? MAX_CLOSURE_ARITY
    : Math.min(MAX_CLOSURE_ARITY, Math.max(maxCall, maxDef + (hasRest ? 1 : 0), floor))
}

const canSkipWholeProgramNarrowing = (programFacts) =>
  programFacts.callSites.length === 0 &&
  programFacts.valueUsed.size === 0 &&
  !programFacts.anyDyn &&
  programFacts.propMap.size === 0 &&
  !programFacts.hasSchemaLiterals &&
  !ctx.closure.make

export default function plan(ast) {
  scanGlobalValueFacts(ast)
  unboxConstTypedGlobals()

  let programFacts = collectProgramFacts(ast)
  if (inlineHotInternalCalls(programFacts, ast)) programFacts = collectProgramFacts(ast)
  ctx.types.dynKeyVars = programFacts.dynVars
  ctx.types.anyDynKey = programFacts.anyDyn

  materializeAutoBoxSchemas(programFacts)
  resolveClosureWidth(programFacts)
  if (canSkipWholeProgramNarrowing(programFacts)) return programFacts

  narrowSignatures(programFacts, ast)
  specializeBimorphicTyped(programFacts)
  refineDynKeys(programFacts)

  return programFacts
}