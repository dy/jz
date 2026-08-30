/**
 * Host-import ABI, import.meta, module-init-fact recording, builtin-alias resolution,
 * namespace-import destructuring, namespace introspection, and module-source lookup
 * (moduleAstFor/isBundledModule) for prepareModule's recursive bundling.
 *
 * @module prepare/module-resolve
 */

import { VAL } from '../reps.js'
import { ctx, err } from '../ctx.js'
import { isFuncRef } from '../ir.js'
import { TIMER_NAMES, hasModule, includeModule } from '../autoload.js'
import { observeNodeFacts } from '../compile/program-facts.js'
import { handlerArgs } from '../ast.js'
import { hasFunc } from './closure-lift.js'
import { stringValue } from './const-fold.js'
import { patternItems } from './destructure.js'
import { staticString } from './literals.js'
import { isDeclared, resolveScope } from './scope.js'
import { GLOBALS, NS_CTORS, builtinMemberKey, scopes } from './state.js'



const hostReturnValType = spec => {
  if (!spec || typeof spec === 'function') return null
  // Return type is the canonical string name ('number'/'string'/'bigint'/'f64').
  // (Earlier this also accepted the constructor identity `ret === String` etc.,
  // but that references host-only globals with no first-class value in jz — it
  // broke self-compiling and was never used. String names are the portable form.)
  const ret = spec.returns ?? spec.return ?? spec.result
  if (ret === 'number' || ret === 'f64') return VAL.NUMBER
  if (ret === 'string') return VAL.STRING
  if (ret === 'bigint') return VAL.BIGINT
  return null
}

export const addHostImport = (mod, name, alias, spec) => {
  // A numeric host constant (e.g. `Math.PI` via `{ imports: { math: Math } }`) has no callable
  // ABI — record it so references fold to an f64 literal (see prep's identifier resolution) instead
  // of emitting a 0-arg func import that can't be read as a value ("'PI' is not in scope").
  if (typeof spec === 'number') {
    if (!ctx.scope.hostConsts) ctx.scope.hostConsts = Object.create(null)  // name-keyed: prototype-less (see derive)
    ctx.scope.hostConsts[alias] = spec
    return
  }
  const nParams = typeof spec === 'function' ? spec.length : (spec?.params || 0)
  // User-supplied imports carry NaN-boxed values via i64 (not f64) so V8 cannot
  // canonicalize the NaN payload across the wasm↔JS function boundary —
  // same hazard as env.print / __ext_*. Call sites wrap args with asI64()
  // and unwrap the i64 return with f64.reinterpret_i64.
  const params = Array(nParams).fill(['param', 'i64'])
  if (!ctx.module.imports.some(i => i[3]?.[1] === `$${alias}`)) {
    ctx.module.imports.push(['import', `"${mod}"`, `"${name}"`, ['func', `$${alias}`, ...params, ['result', 'i64']]])
  }
  ctx.scope.chain[alias] = alias
  const vt = hostReturnValType(spec)
  if (vt) ctx.module.hostImportValTypes.set(alias, vt)
}

export const isImportMeta = node => Array.isArray(node) && node[0] === '.' && node[1] === 'import' && node[2] === 'meta'
export const isImportMetaProp = (node, prop) => Array.isArray(node) && node[0] === '.' && isImportMeta(node[1]) && node[2] === prop

export function importMetaUrl() {
  if (!ctx.transform.importMetaUrl) err('`import.meta.url` requires compile option `importMetaUrl` — jz resolves it to a fixed URL at compile time and has no runtime URL source without one')
  return ctx.transform.importMetaUrl
}

export function resolveImportMeta(spec) {
  const base = importMetaUrl()
  // URL resolution is a host capability (WHATWG URL parsing), injected via
  // ctx.transform.resolveUrl rather than referencing the `URL` global — the same
  // inversion as ctx.transform.parse. Keeps the self-compile kernel (which bundles
  // its module graph and never resolves import.meta at runtime) free of `URL`.
  if (!ctx.transform.resolveUrl) err('import.meta resolution requires ctx.transform.resolveUrl (injected by the jz pipeline)')
  try { return ctx.transform.resolveUrl(spec, base) }
  catch { err(`Cannot resolve import.meta specifier '${spec}' from '${base}' — pass a valid relative or absolute URL string`) }
}

export function recordModuleInitFacts(root) {
  const facts = ctx.module.initFacts ||= {
    dynVars: new Set(), dynWriteVars: new Set(), anyDyn: false, hasSchemaLiterals: false,
    hasMapSet: false, hasBigint: false,
    hasFuncValue: false, timerNames: new Set(),
    maxDef: 0, maxCall: 0, hasRest: false, hasSpread: false,
    writtenProps: new Set(), literalWriteKeys: new Map(),
    arrResized: new Set(), nameEscapes: new Set(),
    objectLiteralDefs: new Map(),
  }
  const visitFuncValue = (node) => {
    if (facts.hasFuncValue || !Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '()') {
      for (let i = 1; i < args.length; i++) {
        const a = args[i]
        if (isFuncRef(a, ctx.funcs.names)) { facts.hasFuncValue = true; return }
        visitFuncValue(a)
      }
      return
    }
    if (op === '.' || op === '?.') {
      if (isFuncRef(args[0], ctx.funcs.names)) { facts.hasFuncValue = true; return }
      visitFuncValue(args[0])
      return
    }
    if (op === '=>') { visitFuncValue(args[1]); return }
    for (const a of args) {
      if (isFuncRef(a, ctx.funcs.names)) { facts.hasFuncValue = true; return }
      visitFuncValue(a)
    }
  }
  const walk = (node) => {
    if (!Array.isArray(node)) {
      if (typeof node === 'string' && TIMER_NAMES.has(node)) facts.timerNames.add(node)
      return
    }
    observeNodeFacts(node, facts)
    for (const a of node.slice(1)) walk(a)
  }
  visitFuncValue(root)
  walk(root)
}

/**
 * @typedef {null|number|string|ASTNode[]} ASTNode
 */

/**
 * Prepare AST node for compilation.
 * @param {ASTNode} node - Raw AST from parser
 * @returns {ASTNode} Normalized AST
 */
// ES2020 §13.13: the nullish-coalescing `??` cannot be combined with `||` or `&&`
// without parentheses — V8 raises a SyntaxError. subscript/jessie doesn't enforce
// it, so jz would otherwise silently accept (and pick its own parse for) the mix.
// Run on the RAW input AST: a parenthesized operand parses as `['()', …]`, so a
// bare `??`/`||`/`&&` child is exactly the illegal unparenthesized form — and at
// this stage no compiler-synthesized `??` (e.g. destructuring defaults) exists yet,
// so `let [a = b || c] = arr` can't false-positive.
export function validateCoalesceMixing(n) {
  if (!Array.isArray(n)) return
  const op = n[0]
  if (op === '||' || op === '&&') {
    for (let i = 1; i < n.length; i++) if (Array.isArray(n[i]) && n[i][0] === '??')
      err(`'??' cannot be mixed with '${op}' without parentheses (ES2020) — wrap one side, e.g. (a ?? b) ${op} c`)
  } else if (op === '??') {
    for (let i = 1; i < n.length; i++) if (Array.isArray(n[i]) && (n[i][0] === '||' || n[i][0] === '&&'))
      err(`'??' cannot be mixed with '||' / '&&' without parentheses (ES2020) — wrap one side, e.g. a ?? (b || c)`)
  }
  for (let i = 1; i < n.length; i++) validateCoalesceMixing(n[i])
}
// `NS.hasOwnProperty("member")` is a compile-time question: jz models a
// builtin namespace as a set of emit keys, so a member is owned iff jz emits
// it — plus the universal constructor trio for constructor namespaces.
function namespaceHasOwn(mod, name, member) {
  if (ctx.core.emit[`${mod}.${member}`] != null) return true
  return NS_CTORS.has(name) && (member === 'prototype' || member === 'length' || member === 'name')
}

/** Pure syntactic extraction of `{ a, b: c }` → `[[target, member], …]` (handles
 *  rename). Returns null for any shape a plain namespace has no notion of: rest,
 *  defaults, computed keys, nested patterns. Shared by the declaration-form
 *  alias path (`namespaceMemberAliases`) and the assignment-form path
 *  (`namespaceMemberAssigns`) below — they differ only in what they do with
 *  each [target, member] pair. */
function namespaceObjectPatternPairs(pattern) {
  if (!Array.isArray(pattern) || pattern[0] !== '{}' || pattern.length !== 2) return null
  const items = patternItems(pattern[1])
  const pairs = []
  for (const item of items) {
    if (typeof item === 'string') pairs.push([item, item])
    else if (Array.isArray(item) && item[0] === ':' && typeof item[1] === 'string' && typeof item[2] === 'string')
      pairs.push([item[2], item[1]])
    else return null
  }
  return pairs
}

/** `let { a, b: c } = NS` where NS is a known builtin module — expand to one
 *  alias per key (handles rename). Returns null (falls through to the generic
 *  runtime-destructure path) for any shape `namespaceObjectPatternPairs` rejects,
 *  or an unknown member. */
export function namespaceMemberAliases(pattern, mod) {
  const pairs = namespaceObjectPatternPairs(pattern)
  if (!pairs) return null
  // Module init (registers the mod's ctx.core.emit['mod.member'] handlers) is
  // lazy — same as the '.' handler's own `includeModule(mod)` call — so it must
  // run BEFORE the emit-key lookups below, not after.
  includeModule(mod)
  const aliases = []
  for (const [target, member] of pairs) {
    const key = `${mod}.${member}`
    if (ctx.core.emit[key] == null) return null
    aliases.push([target, key])
  }
  return aliases
}

/** `({ a, b: c } = NS)` — assignment-form namespace destructure. Unlike the
 *  declaration form above, each target is a PRE-EXISTING binding (a real local/
 *  global, or itself another alias), not a fresh one — so it can't be resolved
 *  to a compile-time-only alias; it needs a real assignment. Lower to one plain
 *  `target = NS.member` per key, reusing the raw (unprepped) `NS` node so the
 *  ordinary `.` handler does the module-include/arity/shadow work, exactly as
 *  it would for a literal `target = NS.member` written by hand — proven to
 *  compile and run correctly (see the reassignment-into-a-real-binding case
 *  the `.` handler already supports). Returns null for the same unsupported
 *  shapes `namespaceObjectPatternPairs` rejects. */
export function namespaceMemberAssigns(pattern, rhsRaw) {
  const pairs = namespaceObjectPatternPairs(pattern)
  if (!pairs) return null
  return pairs.map(([target, member]) => ['=', target, ['.', rhsRaw, member]])
}

/** True (returning the key) iff bare identifier `name` currently resolves — via
 *  block scope or module `scope.chain` — to a builtin-member alias. Pure read,
 *  no side effects; mirrors the resolution order of the bare-identifier branch
 *  in `prep()` (block scope first, chain otherwise). Used by the reassignment
 *  guard: an alias carries no storage, so `name = …` must error, not miscompile. */
export function builtinAliasKeyOf(name) {
  if (typeof name !== 'string') return null
  const key = scopes.length && isDeclared(name) ? resolveScope(name) : ctx.scope.chain[name]
  return builtinMemberKey(key)
}

// --- `'()'` call-handler helpers --------------------------------------------
// The call handler is a thin dispatcher: it tries the compile-time folds
// below (each gated by callee shape, so at most one fires), then resolves the
// callee, then assembles the call. Each helper moves one concern out of line.

// `import.meta.resolve("spec")` → the resolved URL as a static string.
export function foldImportMetaResolve(callee, args) {
  if (!isImportMetaProp(callee, 'resolve')) return undefined
  const callArgs = handlerArgs(args)
  if (callArgs.length !== 1) err('`import.meta.resolve` requires one string literal argument — resolution happens at compile time against a literal specifier')
  const spec = stringValue(callArgs[0])
  if (spec == null) err('`import.meta.resolve` supports only string literal arguments — resolution happens at compile time against a literal specifier')
  return staticString(resolveImportMeta(spec))
}

// Compile-time namespace introspection on a `obj.prop(...)` callee:
// `Array.isArray(NS)` on a bare builtin global folds to `false` (a namespace
// value is never an array); `NS.hasOwnProperty("member")` on a builtin
// namespace folds to a literal — no runtime namespace object. Returns the
// folded literal IR, or `undefined` when nothing folds.
export function foldNamespaceIntrospection(callee, args) {
  if (!Array.isArray(callee) || callee[0] !== '.') return undefined
  const [, obj, prop] = callee
  if (obj === 'Array' && prop === 'isArray') {
    const cargs = handlerArgs(args)
    const a0 = cargs.length === 1 ? cargs[0] : null
    // Fold to boolean `false`, not number 0 — `Array.isArray(Math) === false`
    // must be true, and prepare keeps boolean identity (see the true/false
    // literal notes at prep()).
    if (typeof a0 === 'string' && GLOBALS[a0] && !(scopes.length && isDeclared(a0)) && !hasFunc(a0))
      return [, false]
  }
  if (prop === 'hasOwnProperty' && typeof obj === 'string' && !(scopes.length && isDeclared(obj))) {
    const mod = ctx.scope.chain[obj]
    if (mod && !mod.includes('.') && hasModule(mod)) {
      const cargs = handlerArgs(args)
      const member = cargs.length === 1 ? stringValue(cargs[0]) : null
      // Include the module so its emit keys (the namespace's member set) are
      // registered; unreferenced emitters/data dead-strip in compile.
      if (member != null) { includeModule(mod); return [, namespaceHasOwn(mod, obj, member) ? 1 : 0] }
    }
  }
  return undefined
}

// Resolve a callee to its lowered form, triggering module autoloads along the
// way: a bare identifier through the scope chain, an `obj.prop` member call
// through host imports / named-call / generic-method / namespace tables, and
// any other expression through `prep` (a callable runtime value).
// Compiler-internal synthetic callees: emit-handled intrinsics, never user
// function values — so a bare reference must not pull in the callable-value
// (function table / closure) machinery.
export const INTRINSIC_CALLEES = new Set(['__iter_arr', '__keys_ro'])

// Resolve a member-receiver to a builtin module name, honoring FUNCTION-SCOPED
// namespace aliases (`const M = Math` inside a body registers M → 'math' in the
// block scope; resolveScope surfaces it) ahead of the module-level chain.
export function namespaceModOf(obj) {
  if (typeof obj !== 'string') return null
  const key = scopes.length && isDeclared(obj) ? resolveScope(obj) : ctx.scope.chain[obj]
  return typeof key === 'string' && !key.includes('.') && hasModule(key) ? key : null
}

/** Self-compile: pre-parsed module AST for a specifier, or undefined. Linear scan over
 *  [specifier, ast] pairs — array indexing + string `===` are the ABI-safe primitives
 *  the kernel can read off a host-marshalled argument (dynamic-key object reads aren't). */
export function moduleAstFor(specifier) {
  const asts = ctx.module.importAsts
  if (!asts) return undefined
  for (let i = 0; i < asts.length; i++) if (asts[i][0] === specifier) return asts[i][1]
  return undefined
}

/** True when `mod` is bundled in-process — as source (host parses it) or as a
 *  pre-parsed AST (self-compile kernel). Either path routes through prepareModule. */
export const isBundledModule = mod => !!ctx.module.importSources?.[mod] || moduleAstFor(mod) !== undefined