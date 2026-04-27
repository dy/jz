/**
 * Compile prepared AST to WASM module (S-expression arrays for watr).
 *
 * # Stage contract
 *   IN:  prepared AST (from prepare) + `ctx.func.list` with raw bodies.
 *   OUT: WAT IR `['module', ...sections]` ready for watrCompile/watrPrint.
 *   FLOW: orchestrator only. Calls analyze passes per function, then emit(body) via
 *         src/emit.js's dispatch, then optimizeFunc (src/optimize.js) per function,
 *         finally assembles module sections in canonical order.
 *
 * # Core abstraction
 * Emitter table (ctx.core.emit) maps AST ops → WASM IR generators. Base operators defined
 * in `emitter` export (src/emit.js); on reset, ctx.core.emit starts as a flat copy of emitter
 * and modules add/override entries directly. No prototype chain.
 * emit(node) dispatches: numbers → i32/f64.const, strings → local.get, arrays → ctx.core.emit[op].
 *
 * # Type system
 * Every emitted node carries .type ('i32' | 'f64').
 * Operators preserve i32 when both operands are i32.
 * Division/power always produce f64. Bitwise/comparisons always produce i32.
 * Variables are typed by pre-analysis: if any assignment is f64, local is f64.
 *
 * Per-function state on ctx: locals (Map name→type), stack (loop labels), uniq (counter), sig.
 *
 * @module compile
 */

import { parse as parseWat } from 'watr'
import { ctx, err, inc, resolveIncludes, PTR } from './ctx.js'
import {
  T, VAL, valTypeOf, lookupValType, analyzeValTypes, collectValTypes, analyzeLocals, analyzePtrUnboxable, typedElemAux, exprType,
  extractParams, classifyParam, collectParamNames,
  findFreeVars, analyzeBoxedCaptures, analyzeDynKeys, typedElemCtor,
} from './analyze.js'
import { optimizeFunc, hoistConstantPool, specializeMkptr, specializePtrBase, sortStrPoolByFreq, treeshake } from './optimize.js'
import { emit, emitter, emitFlat, emitBody } from './emit.js'
import {
  typed, asF64, asI32, asPtrOffset, asParamType, toI32, asI64, fromI64,
  NULL_NAN, UNDEF_NAN, NULL_WAT, UNDEF_WAT, NULL_IR, UNDEF_IR, nullExpr, undefExpr,
  MAX_CLOSURE_ARITY, MEM_OPS, WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS,
  mkPtrIR, ptrOffsetIR, ptrTypeIR, extractF64Bits, appendStaticSlots,
  isLit, litVal, isNullishLit, isPureIR, isPostfix, emitNum,
  temp, tempI32, tempI64, f64rem, toNumF64, truthyIR, toBoolFromEmitted,
  keyValType, usesDynProps, needsDynShadow,
  isGlobal, isConst, boxedAddr, readVar, writeVar, isNullish,
  slotAddr, elemLoad, elemStore, arrayLoop, allocPtr,
  multiCount, loopTop, flat, reconstructArgsWithSpreads,
} from './ir.js'

// Re-export for backward compatibility (modules import from compile.js)
export { T, VAL, valTypeOf, lookupValType, extractParams, classifyParam, collectParamNames }
export { emit, emitter, emitFlat }
// IR helpers — re-export from ir.js so module/*.js keep their existing import paths.
export {
  typed, asF64, asI32, asParamType, toI32, asI64, fromI64,
  NULL_NAN, UNDEF_NAN, NULL_WAT, UNDEF_WAT, NULL_IR, UNDEF_IR, nullExpr, undefExpr,
  MAX_CLOSURE_ARITY, MEM_OPS, WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS,
  mkPtrIR, ptrOffsetIR, ptrTypeIR, extractF64Bits, appendStaticSlots,
  isLit, litVal, isNullishLit, isPureIR, isPostfix, emitNum,
  temp, tempI32, tempI64, f64rem, toNumF64, truthyIR, toBoolFromEmitted,
  keyValType, usesDynProps, needsDynShadow,
  isGlobal, isConst, boxedAddr, readVar, writeVar, isNullish,
  slotAddr, elemLoad, elemStore, arrayLoop, allocPtr,
  multiCount, loopTop, flat, reconstructArgsWithSpreads,
}
// Emit-dependent helpers (emitTypeofCmp, toBool, materializeMulti, emitDecl,
// buildArrayWithSpreads) live in emit.js and are re-exported there for modules.
export { emitTypeofCmp, toBool, materializeMulti, emitDecl, buildArrayWithSpreads } from './emit.js'

// Per-compile func name set + map live on ctx.func.names / ctx.func.map,
// populated at compile() entry. Both reset by ctx.js reset() and re-filled here.

// NaN-box high-bits mask: used by the static-prefix-strip pass below to
// identify pointer slots in the data segment. Kept local (ir.js owns the
// runtime packing via mkPtrIR).
const NAN_PREFIX_BITS = 0x7FF8n

// Low-level IR helpers previously lived here. Pure ones moved to src/ir.js;
// emit-calling ones (toBool, emitTypeofCmp, emitDecl, materializeMulti,
// buildArrayWithSpreads) moved to src/emit.js.


// === Module compilation ===

/**
 * Compile prepared AST to WASM module IR.
 * @param {import('./prepare.js').ASTNode} ast - Prepared AST
 * @returns {Array} Complete WASM module as S-expression
 */
export default function compile(ast) {
  // Populate known function names + lookup map on ctx.func for direct call detection
  ctx.func.names.clear()
  ctx.func.map.clear()
  for (const f of ctx.func.list) { ctx.func.names.add(f.name); ctx.func.map.set(f.name, f) }
  // Include imported functions for call resolution (e.g. template interpolations)
  for (const imp of ctx.module.imports)
    if (imp[3]?.[0] === 'func') ctx.func.names.add(imp[3][1].replace(/^\$/, ''))

  // Check user globals don't conflict with runtime globals (modules loaded after user decls)
  for (const name of ctx.scope.userGlobals)
    if (!ctx.scope.globals.get(name)?.includes('mut f64'))
      err(`'${name}' conflicts with a compiler internal — choose a different name`)

  // Pre-fold const globals: evaluate constant initializers before function compilation
  // so functions see the correct global types (i32 vs f64).
  if (ast) {
    const evalConst = n => {
      if (typeof n === 'number') return n
      if (Array.isArray(n) && n[0] == null && typeof n[1] === 'number') return n[1]
      if (!Array.isArray(n)) return null
      const [op, a, b] = n
      const va = evalConst(a), vb = b !== undefined ? evalConst(b) : null
      if (va == null) return null
      if (op === 'u-' || (op === '-' && b === undefined)) return -va
      if (vb == null) return null
      if (op === '+') return va + vb; if (op === '-') return va - vb
      if (op === '*') return va * vb; if (op === '%' && vb) return va % vb
      if (op === '/' && vb) return va / vb; if (op === '**') return va ** vb
      if (op === '&') return va & vb; if (op === '|') return va | vb
      if (op === '^') return va ^ vb; if (op === '<<') return va << vb
      if (op === '>>') return va >> vb; if (op === '>>>') return va >>> vb
      return null
    }
    const stmts = Array.isArray(ast) && ast[0] === ';' ? ast.slice(1)
      : Array.isArray(ast) && ast[0] === 'const' ? [ast] : []
    for (const s of stmts) {
      if (!Array.isArray(s) || s[0] !== 'const') continue
      for (const decl of s.slice(1)) {
        if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
        const [, name, init] = decl
        if (!ctx.scope.globals.has(name) || !ctx.scope.consts?.has(name)) continue
        const v = evalConst(init)
        if (v == null || !isFinite(v)) continue
        const isInt = Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
        ctx.scope.globals.set(name, isInt
          ? `(global $${name} i32 (i32.const ${v}))`
          : `(global $${name} f64 (f64.const ${v}))`)
        ctx.scope.globalTypes.set(name, isInt ? 'i32' : 'f64')
      }
    }
  }

  // Pre-scan module-scope value types so functions can dispatch methods on globals.
  // Also scan moduleInits so cross-module imports (e.g. regex literals from util.js)
  // resolve to the correct static dispatch path.
  const scanStmts = (root) => {
    if (!root) return
    const stmts = Array.isArray(root) && root[0] === ';' ? root.slice(1) : [root]
    for (const s of stmts) {
      if (!Array.isArray(s) || (s[0] !== 'const' && s[0] !== 'let')) continue
      for (const decl of s.slice(1)) {
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
  scanStmts(ast)
  if (ctx.module.moduleInits) for (const init of ctx.module.moduleInits) scanStmts(init)

  // Unified whole-program walk: collects three outputs in one pass.
  //   1. dynVars/anyDyn — vars accessed via runtime key (analyzeDynKeys)
  //   2. propMap — property assignments for auto-boxing
  //   3. valueUsed — ctx.func.names passed as first-class values (not specializable)
  const paramValTypes = new Map() // funcName → Map<paramIdx, valType | null>
  const valueUsed = new Set()
  const dynVars = new Set()
  let anyDyn = false
  const propMap = new Map()
  const doSchema = ast && ctx.schema.register
  const isLiteralStr = idx => Array.isArray(idx) && idx[0] === 'str' && typeof idx[1] === 'string'
  const unifiedWalk = (node) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    // dyn-key detection
    if (op === '[]') {
      const [obj, idx] = args
      if (!isLiteralStr(idx)) { anyDyn = true; if (typeof obj === 'string') dynVars.add(obj) }
    } else if (op === 'for-in') {
      anyDyn = true
      if (typeof args[1] === 'string') dynVars.add(args[1])
    }
    // property-assignment scan for auto-box
    if (doSchema && op === '=' && Array.isArray(args[0]) && args[0][0] === '.') {
      const [, obj, prop] = args[0]
      if (typeof obj === 'string' && (ctx.scope.globals.has(obj) || ctx.func.names.has(obj))) {
        if (!propMap.has(obj)) propMap.set(obj, new Set())
        propMap.get(obj).add(prop)
      }
    }
    // first-class function-value scan
    if (op === '()' && typeof args[0] === 'string' && ctx.func.names.has(args[0])) {
      // callee-position: not a value use. But args[1..] may still pass ctx.func.names as values.
      for (let i = 1; i < args.length; i++) {
        const a = args[i]
        if (typeof a === 'string' && ctx.func.names.has(a)) valueUsed.add(a)
        else unifiedWalk(a)
      }
      return
    }
    if ((op === '.' || op === '?.') && typeof args[0] === 'string' && ctx.func.names.has(args[0])) return
    for (const a of args) {
      if (typeof a === 'string' && ctx.func.names.has(a)) valueUsed.add(a)
      else unifiedWalk(a)
    }
  }
  unifiedWalk(ast)
  for (const func of ctx.func.list) if (func.body && !func.raw) unifiedWalk(func.body)
  // moduleInits: dyn-key detection only (they don't own user props/funcs)
  if (ctx.module.moduleInits) {
    const dynOnlyWalk = (node) => {
      if (!Array.isArray(node)) return
      const [op, ...args] = node
      if (op === '[]') {
        const [obj, idx] = args
        if (!isLiteralStr(idx)) { anyDyn = true; if (typeof obj === 'string') dynVars.add(obj) }
      } else if (op === 'for-in') {
        anyDyn = true
        if (typeof args[1] === 'string') dynVars.add(args[1])
      }
      for (const a of args) dynOnlyWalk(a)
    }
    for (const mi of ctx.module.moduleInits) dynOnlyWalk(mi)
  }
  ctx.types.dynKeyVars = dynVars
  ctx.types.anyDynKey = anyDyn

  // Materialize auto-box schemas from collected propMap
  if (doSchema) {
    for (const [name, props] of propMap) {
      if (ctx.schema.vars.has(name)) {
        const existing = ctx.schema.resolve(name)
        const newProps = [...props].filter(p => !existing.includes(p))
        if (newProps.length) {
          const merged = [...existing, ...newProps]
          const mergedId = ctx.schema.register(merged)
          ctx.schema.vars.set(name, mergedId)
        }
        continue
      }
      const valueProps = [...props].filter(p => !ctx.func.names.has(`${name}$${p}`))
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

  // Dynamic closure ABI width: scan AST for max param count (`=>` defs) and max
  // call arity. $ftN type, call-site padding, and body slot decls use this instead
  // of the static MAX_CLOSURE_ARITY cap. hasRest adds +1 for rest overflow.
  // hasSpread forces MAX (spread expands unknown element count at runtime).
  if (ctx.closure.make) {
    let maxDef = 0, maxCall = 0, hasRest = false, hasSpread = false
    const scanArity = (n) => {
      if (!Array.isArray(n)) return
      if (n[0] === '=>') {
        let fixedN = 0
        for (const r of extractParams(n[1])) {
          if (classifyParam(r).kind === 'rest') hasRest = true
          else fixedN++
        }
        if (fixedN > maxDef) maxDef = fixedN
      } else if (n[0] === '()') {
        const a = n[2]
        const args = a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
        if (args.some(x => Array.isArray(x) && x[0] === '...')) hasSpread = true
        if (args.length > maxCall) maxCall = args.length
      }
      for (const c of n) scanArity(c)
    }
    scanArity(ast)
    for (const fn of ctx.func.list) if (fn.body) scanArity(fn.body)
    for (const mi of ctx.module.moduleInits || []) scanArity(mi)
    const floor = ctx.closure.floor ?? 0
    // Spread + rest together force MAX: call_indirect targets are runtime values, so
    // if ANY rest closure exists AND any spread site exists, the spread may feed the
    // rest target and every element must reach it. Spread without rest anywhere can
    // narrow — extras past W are safely dropped (no rest receiver to miss them).
    ctx.closure.width = (hasSpread && hasRest)
      ? MAX_CLOSURE_ARITY
      : Math.min(MAX_CLOSURE_ARITY, Math.max(maxCall, maxDef + (hasRest ? 1 : 0), floor))
  }

  // D: Call-site type propagation — infer param types from how functions are called.
  // For non-exported internal functions, if all call sites agree on a param's type,
  // propagate that type to ctx.func.valTypes during per-function compilation.
  // Also infer i32/f64 WASM type — when all call sites pass i32 for a param, specialize
  // sig.params[k].type to i32 (no default, no rest, not exported, not value-used).
  // Also propagate schema ID — when all call sites pass objects with the same schema,
  // bind the callee's param to that schema so `p.x` becomes a direct slot load.
  const paramWasmTypes = new Map() // funcName → Map<paramIdx, 'i32' | 'f64' | null>
  const paramSchemas = new Map()   // funcName → Map<paramIdx, schemaId | null>
  {
    // Infer schemaId for an argument expression. Returns null if not inferrable.
    // Safe sources: object literal with all string keys and no spreads, or a variable
    // whose schema is already bound in ctx.schema.vars (module-level) or callerSchemas.
    const inferArgSchema = (expr, callerSchemas) => {
      if (typeof expr === 'string') {
        if (callerSchemas && callerSchemas.has(expr)) return callerSchemas.get(expr)
        const id = ctx.schema.vars.get(expr)
        return id != null ? id : null
      }
      if (Array.isArray(expr) && expr[0] === '{}') {
        const rawProps = expr.slice(1)
        const props = rawProps.length === 1 && Array.isArray(rawProps[0]) && rawProps[0][0] === ','
          ? rawProps[0].slice(1) : rawProps
        const names = []
        for (const p of props) {
          if (!Array.isArray(p) || p[0] !== ':' || typeof p[1] !== 'string') return null
          names.push(p[1])
        }
        if (!names.length) return null
        return ctx.schema.register(names)
      }
      return null
    }
    const scanCalls = (node, callerValTypes, callerLocals, callerSchemas) => {
      if (!Array.isArray(node)) return
      const [op, ...args] = node
      if (op === '=>') return  // don't cross closure boundary
      if (op === '()' && typeof args[0] === 'string' && ctx.func.names.has(args[0])) {
        const callee = args[0]
        const func = ctx.func.map.get(callee)
        if (func && !func.exported && !valueUsed.has(callee)) {
          // Extract args (may be comma-grouped)
          const rawArgs = args.slice(1)
          const argList = rawArgs.length === 1 && Array.isArray(rawArgs[0]) && rawArgs[0][0] === ','
            ? rawArgs[0].slice(1) : rawArgs
          if (!paramValTypes.has(callee)) paramValTypes.set(callee, new Map())
          if (!paramWasmTypes.has(callee)) paramWasmTypes.set(callee, new Map())
          if (!paramSchemas.has(callee)) paramSchemas.set(callee, new Map())
          const ptypes = paramValTypes.get(callee)
          const wtypes = paramWasmTypes.get(callee)
          const stypes = paramSchemas.get(callee)
          for (let k = 0; k < func.sig.params.length; k++) {
            if (k < argList.length) {
              // VAL type
              if (ptypes.get(k) !== null) {
                const argType = inferArgType(argList[k], callerValTypes)
                if (!argType) ptypes.set(k, null)
                else {
                  const prev = ptypes.get(k)
                  if (prev === undefined) ptypes.set(k, argType)
                  else if (prev !== argType) ptypes.set(k, null)
                }
              }
              // WASM type
              if (wtypes.get(k) !== null) {
                const wt = exprType(argList[k], callerLocals)
                const prev = wtypes.get(k)
                if (prev === undefined) wtypes.set(k, wt)
                else if (prev !== wt) wtypes.set(k, null)
              }
              // Schema
              if (stypes.get(k) !== null) {
                const s = inferArgSchema(argList[k], callerSchemas)
                if (s == null) stypes.set(k, null)
                else {
                  const prev = stypes.get(k)
                  if (prev === undefined) stypes.set(k, s)
                  else if (prev !== s) stypes.set(k, null)
                }
              }
            } else {
              // Missing arg — call pads with nullExpr (f64). Prevents i32 specialization.
              ptypes.set(k, null)
              wtypes.set(k, null)
              stypes.set(k, null)
            }
          }
        }
      }
      for (const a of args) scanCalls(a, callerValTypes, callerLocals, callerSchemas)
    }
    // Infer arg type using global valTypes + caller-local valTypes
    const inferArgType = (expr, callerValTypes) => {
      if (typeof expr === 'string') return callerValTypes?.get(expr) || ctx.scope.globalValTypes?.get(expr) || null
      return valTypeOf(expr)
    }
    // Two-pass fixpoint: first pass learns from literals + module vars; second pass
    // lets callers forward propagated schemas (for chained helpers: f→addXY→{getX,getY}).
    const runAllScans = () => {
      scanCalls(ast, ctx.scope.globalValTypes, ctx.scope.globalTypes, null)
      for (const func of ctx.func.list) {
        if (!func.body || func.raw) continue
        const callerLocals = analyzeLocals(func.body)
        for (const p of func.sig.params) if (!callerLocals.has(p.name)) callerLocals.set(p.name, p.type)
        // Caller's schema bindings: params inferred so far (for transitive propagation).
        const cs = paramSchemas.get(func.name)
        const callerSchemas = cs ? new Map(
          [...cs].filter(([, v]) => v != null).map(([k, v]) => [func.sig.params[k].name, v])
        ) : null
        scanCalls(func.body, collectValTypes(func.body), callerLocals, callerSchemas)
      }
    }
    runAllScans()
    runAllScans()
  }

  // Apply i32 specialization: for non-exported/non-value-used funcs with consistent
  // i32 call sites and no defaults/rest at that position, narrow sig.params[k].type.
  for (const func of ctx.func.list) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    const wtypes = paramWasmTypes.get(func.name)
    if (!wtypes) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (const [k, wt] of wtypes) {
      if (wt !== 'i32' || k === restIdx) continue
      const pname = func.sig.params[k].name
      if (func.defaults?.[pname] != null) continue  // defaults need nullish-sentinel f64
      func.sig.params[k].type = 'i32'
    }
  }

  // Pointer-ABI specialization: for non-forwarding pointer params consistent across
  // call sites, narrow from NaN-boxed f64 to i32 offset. Eliminates per-call __ptr_offset
  // extraction + f64→i64→i32 reinterpret chains that dominate watr-style compilers.
  // Safety:
  //   - exclude ARRAY (forwards on realloc — f64 NaN-box is a stable identity) and
  //     STRING (SSO vs heap dual encoding depends on ptr-type bits we'd drop).
  //   - exclude CLOSURE/TYPED (aux bits carry schema/element-type, lost with offset).
  //   - exclude params with defaults (nullish sentinel needs the f64 NaN space).
  //   - exclude rest position (array pack/unpack stays f64).
  const PTR_ABI_KINDS = new Set([VAL.OBJECT, VAL.SET, VAL.MAP, VAL.BUFFER])
  for (const func of ctx.func.list) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    const ptypes = paramValTypes.get(func.name)
    if (!ptypes) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (const [k, vt] of ptypes) {
      if (!PTR_ABI_KINDS.has(vt)) continue
      if (k === restIdx) continue
      if (k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (p.type === 'i32') continue  // already narrowed by numeric pass
      if (func.defaults?.[p.name] != null) continue
      p.type = 'i32'
      p.ptrKind = vt
    }
  }

  // E: Result-type monomorphization — narrow sig.results[0] to 'i32' when body only
  // produces i32 values. Fixpoint: a call to another narrowed func now contributes i32;
  // iterate until stable so chains of i32-only helpers all narrow together.
  // Safety: skip exported (JS boundary preserves number semantics), value-used (closure
  // trampolines assume f64 result), raw WAT, multi-value. `undefined` return = skip.
  const collectReturnExprs = (node, out) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'return') { if (args[0] != null) out.push(args[0]); return }
    for (const a of args) collectReturnExprs(a, out)
  }
  const exprTypeWithCalls = (expr, locals) => {
    // Shim: recognize calls to already-narrowed funcs as i32, everything else via exprType.
    if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
      const f = ctx.func.map.get(expr[1])
      if (f?.sig.results.length === 1 && f.sig.results[0] === 'i32') return 'i32'
      return 'f64'
    }
    // Ternary / logical / arith: recurse with our shim so nested calls contribute.
    if (Array.isArray(expr) && expr.length > 1) {
      const [op, ...args] = expr
      if (op === '?:') {
        const a = exprTypeWithCalls(args[1], locals), b = exprTypeWithCalls(args[2], locals)
        return a === 'i32' && b === 'i32' ? 'i32' : 'f64'
      }
      if (op === '&&' || op === '||') {
        const a = exprTypeWithCalls(args[0], locals), b = exprTypeWithCalls(args[1], locals)
        return a === 'i32' && b === 'i32' ? 'i32' : 'f64'
      }
      if (['+', '-', '*', '%'].includes(op)) {
        const a = exprTypeWithCalls(args[0], locals), b = args[1] != null ? exprTypeWithCalls(args[1], locals) : a
        return a === 'i32' && b === 'i32' ? 'i32' : 'f64'
      }
      if (op === 'u-' || op === 'u+') return exprTypeWithCalls(args[0], locals)
    }
    return exprType(expr, locals)
  }
  const narrowableFuncs = ctx.func.list.filter(f =>
    !f.raw && !f.exported && !valueUsed.has(f.name) && f.sig.results.length === 1
  )
  let changed = true
  while (changed) {
    changed = false
    for (const func of narrowableFuncs) {
      if (func.sig.results[0] === 'i32') continue
      const body = func.body
      const exprs = []
      let hasFallthrough = false
      if (Array.isArray(body) && body[0] === '{}') {
        collectReturnExprs(body, exprs)
        // Conservative: if body could fall through without return, trailing fallback is
        // of result type — matches narrowed i32 fine. But bare-return (`return;`) → undef (f64).
        // Detect bare returns by walking for `['return']` with no expr → exprs.push(null).
        const hasBareReturn = (n) => {
          if (!Array.isArray(n)) return false
          if (n[0] === '=>') return false
          if (n[0] === 'return' && n[1] == null) return true
          return n.some(hasBareReturn)
        }
        if (hasBareReturn(body)) continue  // undef is f64 — can't narrow
      } else {
        exprs.push(body)
      }
      if (!exprs.length) continue
      const savedCurrent = ctx.func.current
      ctx.func.current = func.sig
      const locals = (Array.isArray(body) && body[0] === '{}') ? analyzeLocals(body) : new Map()
      for (const p of func.sig.params) if (!locals.has(p.name)) locals.set(p.name, p.type)
      const allI32 = exprs.every(e => exprTypeWithCalls(e, locals) === 'i32')
      ctx.func.current = savedCurrent
      if (allI32) { func.sig.results = ['i32']; changed = true }
    }
  }

  // E2: VAL-type result inference — if a function always returns the same VAL kind,
  // record it so callers inherit that type (enables static dispatch on .length, .[],
  // .prop through a call chain). Fixpoint propagates through helper chains.
  // Safety: skip exported (host sees raw f64), value-used (indirect call signature).
  // Shim so calls to already-typed funcs contribute their result type.
  const valTypeOfWithCalls = (expr, localValTypes) => {
    if (expr == null) return null
    if (typeof expr === 'string') return localValTypes?.get(expr) || ctx.scope.globalValTypes?.get(expr) || null
    if (!Array.isArray(expr)) return valTypeOf(expr)
    const [op, ...args] = expr
    if (op === '()' && typeof args[0] === 'string') {
      const f = ctx.func.map.get(args[0])
      if (f?.valResult) return f.valResult
    }
    if (op === '?:') {
      const a = valTypeOfWithCalls(args[1], localValTypes), b = valTypeOfWithCalls(args[2], localValTypes)
      return a && a === b ? a : null
    }
    if (op === '&&' || op === '||') {
      const a = valTypeOfWithCalls(args[0], localValTypes), b = valTypeOfWithCalls(args[1], localValTypes)
      return a && a === b ? a : null
    }
    return valTypeOf(expr)
  }
  const valTypeNarrowable = ctx.func.list.filter(f =>
    !f.raw && !f.exported && !valueUsed.has(f.name) && f.sig.results.length === 1
  )
  changed = true
  while (changed) {
    changed = false
    for (const func of valTypeNarrowable) {
      if (func.valResult) continue
      const body = func.body
      const exprs = []
      if (Array.isArray(body) && body[0] === '{}') {
        collectReturnExprs(body, exprs)
        const hasBareReturn = (n) => {
          if (!Array.isArray(n)) return false
          if (n[0] === '=>') return false
          if (n[0] === 'return' && n[1] == null) return true
          return n.some(hasBareReturn)
        }
        if (hasBareReturn(body)) continue
      } else {
        exprs.push(body)
      }
      if (!exprs.length) continue
      const localValTypes = (Array.isArray(body) && body[0] === '{}') ? collectValTypes(body) : new Map()
      // Params of this function contribute no known VAL type yet (paramValTypes may help later).
      const vt0 = valTypeOfWithCalls(exprs[0], localValTypes)
      if (!vt0) continue
      const allSame = exprs.every(e => valTypeOfWithCalls(e, localValTypes) === vt0)
      if (allSame) { func.valResult = vt0; changed = true }
    }
  }

  // E3: Result-type pointer narrowing — when valResult is a non-ambiguous pointer kind
  // with constant aux (SET/MAP/BUFFER, all aux=0), narrow sig.results[0] from f64 to i32
  // and tag sig.ptrKind. Eliminates the f64.reinterpret_i64+i64.or rebox at every return
  // and the i32.wrap_i64+i64.reinterpret_f64 unbox at every callsite that uses the value
  // as a pointer (load .[], .length, method dispatch).
  // Safety: ARRAY forwards on realloc; STRING dual-encoded SSO/heap; CLOSURE/TYPED carry
  // table-idx/element-type in aux; OBJECT carries schema-id in aux (per-callsite preservation
  // not yet wired). Body must be a guaranteed-return form — fallthrough fallback i32.const 0
  // would be a valid offset 0 of the narrowed kind, not undefined.
  const PTR_RESULT_KINDS = new Set([VAL.SET, VAL.MAP, VAL.BUFFER])
  const alwaysReturns = (n) => {
    if (!Array.isArray(n)) return false
    const op = n[0]
    if (op === '=>') return false
    if (op === 'return' || op === 'throw') return true
    if (op === '{}' || op === ';') return alwaysReturns(n[n.length - 1])
    if (op === 'if') return n.length >= 4 && alwaysReturns(n[2]) && alwaysReturns(n[3])
    return false
  }
  for (const func of valTypeNarrowable) {
    if (!func.valResult || !PTR_RESULT_KINDS.has(func.valResult)) continue
    if (func.sig.results[0] !== 'f64') continue
    if (!alwaysReturns(func.body)) continue
    func.sig.results = ['i32']
    func.sig.ptrKind = func.valResult
  }

  const funcs = ctx.func.list.map(func => {
    // Raw WAT functions (e.g., _alloc, _reset from memory module)
    if (func.raw) return parseWat(func.raw)

    const { name, body, exported, sig } = func

    const multi = sig.results.length > 1

    // Reset per-function state
    ctx.func.stack = []
    ctx.func.uniq = 0
    ctx.func.current = sig

    // Pre-analyze local types from body
    // Block body vs object literal: object has ':' property nodes
    const block = Array.isArray(body) && body[0] === '{}' && body[1]?.[0] !== ':'
    ctx.func.locals = block ? analyzeLocals(body) : new Map()
    ctx.func.valTypes = new Map()
    ctx.func.boxed = new Map()  // variable name → cell local name (i32) for mutable capture
    ctx.func.localProps = null  // reset per function
    ctx.func.ptrKinds = null    // populated after boxed analysis; reset per function
    ctx.func.ptrAuxes = null    // per-local aux bits for unboxed PTR.* (TYPED elemType, OBJECT schemaId, …)
    ctx.types.typedElem = ctx.scope.globalTypedElem ? new Map(ctx.scope.globalTypedElem) : null
    if (block) {
      analyzeValTypes(body)
      analyzeBoxedCaptures(body)
      // Lower provably-monomorphic pointer locals to i32 offset storage.
      const unbox = analyzePtrUnboxable(body, ctx.func.valTypes, ctx.func.locals, ctx.func.boxed)
      if (unbox.size > 0) {
        ctx.func.ptrKinds = unbox
        for (const [name, kind] of unbox) {
          ctx.func.locals.set(name, 'i32')
          if (kind === VAL.TYPED) {
            const aux = typedElemAux(ctx.types.typedElem?.get(name))
            if (aux != null) (ctx.func.ptrAuxes ||= new Map()).set(name, aux)
          }
        }
      }
    }
    // Pointer-ABI params (from narrowing loop above): params already have type='i32' and
    // ptrKind set. Register them in ctx.func.ptrKinds so readVar tags local.gets correctly.
    // Boxed capture still works: the boxed-init path (below) uses a ptrKind-tagged local.get
    // so asF64 reboxes to NaN-form before f64.store to the cell.
    for (const p of sig.params) {
      if (p.ptrKind == null) continue
      if (!ctx.func.ptrKinds) ctx.func.ptrKinds = new Map()
      ctx.func.ptrKinds.set(p.name, p.ptrKind)
    }
    // D: Apply call-site param types (only if body analysis didn't already set them)
    const ptypes = paramValTypes.get(name)
    if (ptypes) {
      for (const [k, vt] of ptypes) {
        if (vt && k < sig.params.length && !ctx.func.valTypes.has(sig.params[k].name))
          ctx.func.valTypes.set(sig.params[k].name, vt)
      }
    }
    // D: Apply call-site schema bindings for non-exported params. Saved schema.vars
    // are restored after this function's emit so bindings don't leak across functions
    // that reuse param names (e.g. `o`). Requires all call sites to agree on schemaId.
    const stypes = paramSchemas.get(name)
    const schemaVarsPrev = new Map(ctx.schema.vars)
    if (stypes && !exported) {
      for (const [k, sid] of stypes) {
        if (sid == null || k >= sig.params.length) continue
        const pname = sig.params[k].name
        if (!ctx.schema.vars.has(pname)) ctx.schema.vars.set(pname, sid)
      }
    }

    const fn = ['func', `$${name}`]
    if (exported) fn.push(['export', `"${name}"`])
    fn.push(...sig.params.map(p => ['param', `$${p.name}`, p.type]))
    fn.push(...sig.results.map(t => ['result', t]))

    // Default params: missing JS args become canonical NaN (0x7FF8000000000000) in WASM f64 params.
    // Check for canonical NaN specifically — NaN-boxed pointers are also NaN but have non-zero payload.
    const defaults = func.defaults || {}
    const defaultInits = []
    for (const [pname, defVal] of Object.entries(defaults)) {
      const p = sig.params.find(p => p.name === pname)
      const t = p?.type || 'f64'
      defaultInits.push(
        ['if', isNullish(typed(['local.get', `$${pname}`], 'f64')),
          ['then', ['local.set', `$${pname}`, t === 'f64' ? asF64(emit(defVal)) : asI32(emit(defVal))]]])
    }

    // Box params that are mutably captured: allocate cell, copy param value
    const boxedParamInits = []
    for (const p of sig.params) {
      if (ctx.func.boxed.has(p.name)) {
        const cell = ctx.func.boxed.get(p.name)
        ctx.func.locals.set(cell, 'i32')
        const lget = typed(['local.get', `$${p.name}`], p.type)
        if (p.ptrKind != null) lget.ptrKind = p.ptrKind
        boxedParamInits.push(
          ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
          ['f64.store', ['local.get', `$${cell}`], asF64(lget)])
      }
    }

    if (block) {
      const stmts = emitBody(body)
      for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])
      // I: Skip trailing fallback when last statement is return (unreachable code)
      const lastStmt = stmts.at(-1)
      const endsWithReturn = lastStmt && (lastStmt[0] === 'return' || lastStmt[0] === 'return_call')
      fn.push(...defaultInits, ...boxedParamInits, ...stmts, ...(endsWithReturn ? [] : sig.results.map(t => [`${t}.const`, 0])))
    } else if (multi && body[0] === '[') {
      const values = body.slice(1).map(e => asF64(emit(e)))
      for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])
      fn.push(...boxedParamInits, ...values)
    } else {
      const ir = emit(body)
      for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])
      const finalIR = sig.ptrKind != null ? asPtrOffset(ir, sig.ptrKind) : asParamType(ir, sig.results[0])
      fn.push(...defaultInits, ...boxedParamInits, finalIR)
    }

    // Restore schema.vars so param bindings don't leak to next function.
    ctx.schema.vars = schemaVarsPrev
    return fn
  })

  const closureFuncs = []
  let compiledBodyCount = 0
  const compilePendingClosures = () => {
    const bodies = ctx.closure.bodies || []
    for (let bodyIndex = compiledBodyCount; bodyIndex < bodies.length; bodyIndex++) {
      const cb = bodies[bodyIndex]
      const prevSchemaVars = ctx.schema.vars
      const prevTypedElems = ctx.types.typedElem
      // Reset per-function state for closure body
      ctx.func.locals = new Map()
      ctx.func.valTypes = new Map()
      if (cb.valTypes) for (const [name, vt] of cb.valTypes) ctx.func.valTypes.set(name, vt)
      if (cb.schemaVars) ctx.schema.vars = new Map([...prevSchemaVars, ...cb.schemaVars])
      const globalTE = ctx.scope.globalTypedElem
      if (cb.typedElems) {
        ctx.types.typedElem = globalTE ? new Map([...globalTE, ...cb.typedElems]) : new Map(cb.typedElems)
      } else if (globalTE) {
        ctx.types.typedElem = new Map(globalTE)
      } else {
        ctx.types.typedElem = prevTypedElems
      }
      // In closure bodies, boxed captures use the original name as both var and cell local
      ctx.func.boxed = cb.boxed ? new Map([...cb.boxed].map(v => [v, v])) : new Map()
      ctx.func.stack = []
      ctx.func.uniq = Math.max(ctx.func.uniq, 100) // avoid label collisions
      // Uniform convention: (env f64, argc i32, a0..a{width-1} f64) → f64
      const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
      const paramDecls = [{ name: '__env', type: 'f64' }, { name: '__argc', type: 'i32' }]
      for (let i = 0; i < W; i++) paramDecls.push({ name: `__a${i}`, type: 'f64' })
      ctx.func.current = { params: paramDecls, results: ['f64'] }

      const fn = ['func', `$${cb.name}`]
      fn.push(['param', '$__env', 'f64'])
      fn.push(['param', '$__argc', 'i32'])
      for (let i = 0; i < W; i++) fn.push(['param', `$__a${i}`, 'f64'])
      fn.push(['result', 'f64'])

      // Params are locals, assigned directly from inline slots
      for (const p of cb.params) ctx.func.locals.set(p, 'f64')

      // Register captured variable locals: boxed = i32 cell pointer, otherwise f64 value
      for (let i = 0; i < cb.captures.length; i++) {
        const name = cb.captures[i]
        ctx.func.locals.set(name, ctx.func.boxed.has(name) ? 'i32' : 'f64')
      }

      // Emit body
      const block = Array.isArray(cb.body) && cb.body[0] === '{}' && cb.body[1]?.[0] !== ':'
      let bodyIR
      if (block) {
        for (const [k, v] of analyzeLocals(cb.body)) if (!ctx.func.locals.has(k)) ctx.func.locals.set(k, v)
        // Detect captures from deeper nested arrows that mutate this body's locals/params/captures
        analyzeBoxedCaptures(cb.body)
        for (const name of ctx.func.boxed.keys()) {
          if (ctx.func.locals.get(name) === 'f64') ctx.func.locals.set(name, 'i32')
        }
        bodyIR = emitBody(cb.body)
      } else {
        bodyIR = [asF64(emit(cb.body))]
      }

      // Pre-allocate cache locals for env unpacking
      const envBase = cb.captures.length > 0 ? `${T}envBase${ctx.func.uniq++}` : null
      if (envBase) { ctx.func.locals.set(envBase, 'i32'); inc('__ptr_offset') }
      // Rest param: allocate helper locals (len + offset) before emitting decls
      let restOff, restLen
      if (cb.rest) {
        restOff = `${T}restOff${ctx.func.uniq++}`
        restLen = `${T}restLen${ctx.func.uniq++}`
        ctx.func.locals.set(restOff, 'i32')
        ctx.func.locals.set(restLen, 'i32')
        inc('__alloc_hdr', '__mkptr')
      }

      // Insert locals (captures + params + declared)
      for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])

      // Load captures from env: boxed → i32.load (raw cell pointer), immutable → f64.load value
      if (envBase) {
        fn.push(['local.set', `$${envBase}`, ['call', '$__ptr_offset', ['local.get', '$__env']]])
        for (let i = 0; i < cb.captures.length; i++) {
          const name = cb.captures[i]
          const addr = ['i32.add', ['local.get', `$${envBase}`], ['i32.const', i * 8]]
          fn.push(['local.set', `$${name}`,
            ctx.func.boxed.has(name) ? ['i32.load', addr] : ['f64.load', addr]])
        }
      }

      // Unpack fixed params directly from inline slots (caller padded missing with UNDEF_NAN).
      // Rest name (if present) is last in cb.params — handled separately below.
      const fixedParamN = cb.params.length - (cb.rest ? 1 : 0)
      for (let i = 0; i < fixedParamN && i < W; i++) {
        fn.push(['local.set', `$${cb.params[i]}`, ['local.get', `$__a${i}`]])
      }

      // Rest param: pack slots a[fixedParams..argc-1] into fresh array.
      // len = clamp(argc - fixedParams, 0, restSlots). Rest-param closures receive
      // at most (width - fixedParams) rest args — spread callers with
      // more dynamic elements lose the overflow (documented limitation).
      if (cb.rest) {
        const fixedN = fixedParamN
        const restSlots = W - fixedN
        fn.push(['local.set', `$${restLen}`,
          ['select',
            ['i32.sub', ['local.get', '$__argc'], ['i32.const', fixedN]],
            ['i32.const', 0],
            ['i32.gt_s', ['local.get', '$__argc'], ['i32.const', fixedN]]]])
        fn.push(['if', ['i32.gt_s', ['local.get', `$${restLen}`], ['i32.const', restSlots]],
          ['then', ['local.set', `$${restLen}`, ['i32.const', restSlots]]]])
        fn.push(['local.set', `$${restOff}`,
          ['call', '$__alloc_hdr',
            ['local.get', `$${restLen}`], ['local.get', `$${restLen}`], ['i32.const', 8]]])
        for (let i = 0; i < restSlots; i++) {
          fn.push(['if', ['i32.gt_s', ['local.get', `$${restLen}`], ['i32.const', i]],
            ['then', ['f64.store',
              ['i32.add', ['local.get', `$${restOff}`], ['i32.const', i * 8]],
              ['local.get', `$__a${fixedN + i}`]]]])
        }
        fn.push(['local.set', `$${cb.rest}`,
          ['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${restOff}`]]])
      }

      // Default params for closures (check sentinel after unpack)
      if (cb.defaults) {
        for (const [pname, defVal] of Object.entries(cb.defaults)) {
          fn.push(['if', isNullish(['local.get', `$${pname}`]),
            ['then', ['local.set', `$${pname}`, asF64(emit(defVal))]]])
        }
      }
      fn.push(...bodyIR)
      // I: Skip trailing fallback when last statement is return
      if (block && !(bodyIR.at(-1)?.[0] === 'return' || bodyIR.at(-1)?.[0] === 'return_call')) fn.push(['f64.const', 0])
      closureFuncs.push(fn)
      ctx.schema.vars = prevSchemaVars
      ctx.types.typedElem = prevTypedElems
    }
    compiledBodyCount = bodies.length
  }
  compilePendingClosures()

  // Build module sections — named slots, assembled at the end (no index bookkeeping)
  const sec = {
    extStdlib: [],  // external stdlib (imports that must precede all other imports)
    imports: [...ctx.module.imports],
    types: [],      // function types for call_indirect
    memory: [],     // memory declaration
    data: [],       // data segment (filled after emit)
    tags: [],       // error tags + related exports
    table: [],      // function table (at most one)
    globals: [],    // globals (filled after __start)
    funcs: [],      // closure funcs + regular funcs
    elem: [],       // element section (table init)
    start: [],      // __start func + start directive
    stdlib: [],     // stdlib functions
    customs: [],    // custom sections + exports
  }

  // Uniform closure convention: (env f64, argc i32, a0..a{MAX-1} f64) → f64.
  // argc = actual arg count passed; missing slots padded with UNDEF_NAN at caller.
  // Rest-param bodies pack slots a[fixedParams..argc-1] into their rest array.
  // MAX_CLOSURE_ARITY is the fixed inline-slot count; calls with more args error.
  if (ctx.closure.types) {
    const params = [['param', 'f64'], ['param', 'i32']] // env + argc
    for (let i = 0; i < (ctx.closure.width ?? MAX_CLOSURE_ARITY); i++) params.push(['param', 'f64'])
    sec.types.push(['type', `$ftN`, ['func', ...params, ['result', 'f64']]])
  }

  // Memory section deferred — emitted after resolveIncludes() when __alloc is needed

  if (ctx.runtime.throws) {
    ctx.scope.globals.set('__jz_last_err_bits', '(global $__jz_last_err_bits (mut i64) (i64.const 0))')
    sec.tags.push(['tag', '$__jz_err', ['param', 'f64']])
    sec.tags.push(['export', '"__jz_last_err_bits"', ['global', '$__jz_last_err_bits']])
  }

  if (ctx.closure.table?.length)
    sec.table.push(['table', ctx.closure.table.length, 'funcref'])

  sec.funcs.push(...closureFuncs, ...funcs)

  if (ctx.closure.table?.length)
    sec.elem.push(['elem', ['i32.const', 0], 'func', ...ctx.closure.table.map(n => `$${n}`)])

  // Module-scope init code (__start): reset per-function state, emit, collect locals
  ctx.func.locals = new Map()
  ctx.func.valTypes = new Map()
  ctx.func.boxed = new Map()
  ctx.func.stack = []
  ctx.func.current = { params: [], results: [] }
  analyzeValTypes(ast)
  const normalizeIR = ir => !ir?.length ? [] : Array.isArray(ir[0]) ? ir : [ir]
  // Emit sub-module init code first (imports must be initialized before main module)
  const moduleInits = []
  if (ctx.module.moduleInits) {
    for (const mi of ctx.module.moduleInits) {
      analyzeValTypes(mi)
      moduleInits.push(...normalizeIR(emit(mi)))
    }
  }
  const init = emit(ast)

  // Auto-boxing: emit boxing code for variables with property assignments
  const boxInit = []
  if (ctx.schema.autoBox) {
    const bt = `${T}box`
    ctx.func.locals.set(bt, 'i32')
    for (const [name, { schemaId, schema }] of ctx.schema.autoBox) {
      inc('__alloc', '__mkptr')
      boxInit.push(
        ['local.set', `$${bt}`, ['call', '$__alloc', ['i32.const', schema.length * 8]]],
        // Store inner value (slot 0) — 0 for functions (calls go direct), current val for others
        ['f64.store', ['local.get', `$${bt}`],
          ctx.func.names.has(name) ? ['f64.const', 0] : ['global.get', `$${name}`]],
        // Initialize property slots to 0
        ...schema.slice(1).map((_, i) =>
          ['f64.store', ['i32.add', ['local.get', `$${bt}`], ['i32.const', (i + 1) * 8]], ['f64.const', 0]]),
        // Create boxed OBJECT pointer and store back
        ['global.set', `$${name}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${bt}`])])
    }
  }

  // Schema name table: if JSON.stringify is used, build runtime table mapping schemaId → key arrays
  const schemaInit = []
  if (ctx.core.includes.has('__stringify') && ctx.schema.list.length) {
    const nSchemas = ctx.schema.list.length
    const stbl = `${T}stbl`
    const sarr = `${T}sarr`
    ctx.func.locals.set(stbl, 'i32')
    ctx.func.locals.set(sarr, 'i32')
    inc('__alloc', '__alloc_hdr', '__mkptr')
    schemaInit.push(
      ['local.set', `$${stbl}`, ['call', '$__alloc', ['i32.const', nSchemas * 8]]],
      ['global.set', '$__schema_tbl', ['local.get', `$${stbl}`]])
    for (let s = 0; s < nSchemas; s++) {
      const keys = ctx.schema.list[s]
      const n = keys.length
      schemaInit.push(
        ['local.set', `$${sarr}`, ['call', '$__alloc_hdr', ['i32.const', n], ['i32.const', n], ['i32.const', 8]]])
      for (let k = 0; k < n; k++)
        schemaInit.push(
          ['f64.store', ['i32.add', ['local.get', `$${sarr}`], ['i32.const', k * 8]],
            emit(['str', String(keys[k])])])
      schemaInit.push(
        ['f64.store', ['i32.add', ['local.get', `$${stbl}`], ['i32.const', s * 8]],
          mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${sarr}`])])
    }
  }

  // Allocate shared-memory string pool and copy bytes from passive segment — MUST run
  // before anything else, since all heap-string emissions resolve via $__strBase.
  const strPoolInit = []
  if (ctx.runtime.strPool) {
    const total = ctx.runtime.strPool.length
    strPoolInit.push(
      ['global.set', '$__strBase', ['call', '$__alloc', ['i32.const', total]]],
      ['memory.init', '$__strPool', ['global.get', '$__strBase'], ['i32.const', 0], ['i32.const', total]],
      ['data.drop', '$__strPool'],  // free segment bytes once copied
    )
  }
  // Preallocate typeof result strings into globals (emit['str'] needs __start's fresh locals map).
  const typeofInit = []
  if (ctx.runtime.typeofStrs) {
    for (const s of ctx.runtime.typeofStrs)
      typeofInit.push(['global.set', `$__tof_${s}`, emit(['str', s])])
  }
  if (moduleInits.length || init?.length || boxInit.length || schemaInit.length || typeofInit.length || strPoolInit.length) {
    const initIR = normalizeIR(init)
    const startFn = ['func', '$__start']
    for (const [l, t] of ctx.func.locals) startFn.push(['local', `$${l}`, t])
    startFn.push(...strPoolInit, ...typeofInit, ...boxInit, ...schemaInit, ...moduleInits, ...initIR)
    sec.start.push(startFn, ['start', '$__start'])
  }

  // Late closures (compiled during __start emit) — prepend before earlier closures
  const beforeLen = closureFuncs.length
  compilePendingClosures()
  if (closureFuncs.length > beforeLen)
    sec.funcs.unshift(...closureFuncs.slice(beforeLen))

  // Function-body dedup: alpha-rename locals/params, hash, redirect dupes through elem section.
  // Runs AFTER all closures (including late ones compiled during __start) are collected so that
  // structural duplicates across batches collapse into a single emitted body.
  if (closureFuncs.length > 1) {
    const canonicalize = (fn) => {
      const localNames = new Set()
      const collect = (node) => {
        if (!Array.isArray(node)) return
        if ((node[0] === 'local' || node[0] === 'param') && typeof node[1] === 'string' && node[1][0] === '$')
          localNames.add(node[1])
        for (const c of node) collect(c)
      }
      collect(fn)
      let counter = 0
      const renameMap = new Map()
      const walk = node => {
        if (typeof node === 'string') {
          if (!localNames.has(node)) return node
          let r = renameMap.get(node)
          if (!r) { r = `$_c${counter++}`; renameMap.set(node, r) }
          return r
        }
        if (!Array.isArray(node)) return node
        return node.map(walk)
      }
      return JSON.stringify(['func', ...fn.slice(2).map(walk)])
    }
    const hashToName = new Map()
    const redirect = new Map()
    const keepSet = new Set()
    for (const fn of closureFuncs) {
      const key = canonicalize(fn)
      const name = fn[1].slice(1)
      const canonical = hashToName.get(key)
      if (canonical) redirect.set(name, canonical)
      else { hashToName.set(key, name); keepSet.add(name) }
    }
    if (redirect.size) {
      // Rewrite closure table to point all dupes at canonical names
      ctx.closure.table = ctx.closure.table.map(n => redirect.get(n) || n)
      // Filter sec.funcs in place: keep non-closures + canonical closures
      const kept = sec.funcs.filter(fn => {
        if (!Array.isArray(fn) || fn[0] !== 'func') return true
        const name = typeof fn[1] === 'string' && fn[1][0] === '$' ? fn[1].slice(1) : null
        return !name || !redirect.has(name)
      })
      sec.funcs.length = 0
      sec.funcs.push(...kept)
    }
  }

  // Finalize function table + element section (table may grow during __start emit)
  if (ctx.closure.table?.length) {
    sec.table = [['table', ctx.closure.table.length, 'funcref']]
    sec.elem = [['elem', ['i32.const', 0], 'func', ...ctx.closure.table.map(n => `$${n}`)]]
  }

  // Resolve stdlib AFTER __start emit — inc() calls during __start must be captured
  resolveIncludes()

  // Emit memory section when any included stdlib uses memory instructions.
  const needsMemory = [...ctx.core.includes].some(n => ctx.core.stdlib[n] && MEM_OPS.test(ctx.core.stdlib[n]))
  // G: Elide __heap global when no memory needed — saves 9 bytes for pure scalar functions
  if (!needsMemory) ctx.scope.globals.delete('__heap')
  if (needsMemory && ctx.module.modules.core) {
    // Include allocator when memory is needed — stdlib funcs may call $__alloc
    for (const fn of ['__alloc', '__alloc_hdr', '__reset']) if (!ctx.core.includes.has(fn)) ctx.core.includes.add(fn)
    const pages = ctx.memory.pages || 1
    if (ctx.memory.shared) sec.imports.push(['import', '"env"', '"memory"', ['memory', pages]])
    else sec.memory.push(['memory', ['export', '"memory"'], pages])
    if (ctx.core._allocRawFuncs) sec.funcs.push(...ctx.core._allocRawFuncs.map(s => parseWat(s)))
  }

  // Resolve factory stdlibs (ctx.features-aware lazy generation).
  const stdlibStr = (name) => {
    const v = ctx.core.stdlib[name]
    return typeof v === 'function' ? v() : v
  }
  for (const name of Object.keys(ctx.core.stdlib)) {
    if (name.startsWith('__ext_') && ctx.core.includes.has(name)) {
      const parsed = parseWat(stdlibStr(name))
      sec.extStdlib.push(parsed[0] === "module" ? parsed[1] : parsed)
      ctx.core.includes.delete(name)
    }
  }
  for (const n of ctx.core.includes) if (!ctx.core.stdlib[n]) console.error("MISSING stdlib:", n)
  sec.stdlib.push(...[...ctx.core.includes].map(n => parseWat(stdlibStr(n))))

  // R: Strip static string table if __static_str not used (saves 57 bytes)
  if (ctx.runtime.staticDataLen && !ctx.core.includes.has('__static_str')) {
    const prefix = ctx.runtime.staticDataLen
    // User strings/objects/arrays computed offsets with static prefix present — shift down.
    // Patches both the runtime-call form `__mkptr(...)` and the constant-folded form
    // `f64.reinterpret_i64 (i64.const ...)`. Ptr types pointing at heap (offset >= prefix)
    // are addresses into ctx.runtime.data — shift them. ATOM/SSO have no offset to shift.
    const SHIFTABLE = new Set([PTR.STRING, PTR.OBJECT, PTR.ARRAY, PTR.HASH, PTR.SET, PTR.MAP, PTR.BUFFER, PTR.TYPED, PTR.CLOSURE])
    // Patch embedded pointer slots inside static data (STRING refs in static arrays/objects).
    // Slot offsets are absolute pre-strip; rewrite each i64, then slice off the prefix.
    const data = ctx.runtime.data || ''
    const buf = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i)
    const dv = new DataView(buf.buffer)
    if (ctx.runtime.staticPtrSlots) {
      for (const slotOff of ctx.runtime.staticPtrSlots) {
        if (slotOff < prefix) continue  // slot itself stripped
        const bits = dv.getBigUint64(slotOff, true)
        if (((bits >> 48n) & 0xFFF8n) !== NAN_PREFIX_BITS) continue
        const ty = Number((bits >> 47n) & 0xFn)
        if (!SHIFTABLE.has(ty)) continue
        const off = Number(bits & 0xFFFFFFFFn)
        if (off < prefix) continue
        const hi = bits & ~0xFFFFFFFFn
        dv.setBigUint64(slotOff, hi | BigInt(off - prefix), true)
      }
    }
    let s = ''
    for (let i = prefix; i < buf.length; i++) s += String.fromCharCode(buf[i])
    ctx.runtime.data = s
    if (ctx.runtime.staticPtrSlots) ctx.runtime.staticPtrSlots = ctx.runtime.staticPtrSlots
      .filter(o => o >= prefix).map(o => o - prefix)
    const shift = (node) => {
      if (!Array.isArray(node)) return
      for (let i = 0; i < node.length; i++) {
        const child = node[i]
        if (!Array.isArray(child)) continue
        if (child[0] === 'call' && child[1] === '$__mkptr' &&
          Array.isArray(child[2]) && SHIFTABLE.has(child[2][1]) &&
          Array.isArray(child[4]) && child[4][0] === 'i32.const' &&
          typeof child[4][1] === 'number' && child[4][1] >= prefix) {
          child[4][1] -= prefix
        } else if (child[0] === 'f64.const' &&
          typeof child[1] === 'string' && child[1].startsWith('nan:0x')) {
          const bits = BigInt(child[1].slice(4)) | 0x7FF0000000000000n
          if (((bits >> 48n) & 0xFFF8n) === NAN_PREFIX_BITS) {
            const ty = Number((bits >> 47n) & 0xFn)
            if (SHIFTABLE.has(ty)) {
              const off = Number(bits & 0xFFFFFFFFn)
              if (off >= prefix) {
                const hi = bits & ~0xFFFFFFFFn
                const newBits = hi | BigInt(off - prefix)
                child[1] = 'nan:0x' + newBits.toString(16).toUpperCase().padStart(16, '0')
              }
            }
          }
        }
        shift(child)
      }
    }
    for (const s of [...sec.funcs, ...sec.stdlib, ...sec.start]) shift(s)
  }

  // Whole-module: specialize __mkptr(T, A, off) per (T, A) combo — saves ~4 B/site (see optimize.js).
  // Run BEFORE per-function passes so new specialized helpers are included.
  specializeMkptr([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat)), parseWat)

  // Whole-module: specialize `call F (add (global G) (const N))` — saves ~3 B/site.
  // Runs AFTER specializeMkptr so mkptr variants (e.g. $__mkptr_4_0_d) are present.
  specializePtrBase([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat)), parseWat)

  // Whole-module: reorder strings in strPool by reference frequency — hot strings get low offsets,
  // shrinking their `i32.const N` LEB128 encoding. Shared-memory mode only (passive strPool segment).
  if (ctx.runtime.strPool) {
    const poolRef = { pool: ctx.runtime.strPool }
    sortStrPoolByFreq([...sec.funcs, ...sec.stdlib, ...sec.start], poolRef, ctx.runtime.strPoolDedup)
    ctx.runtime.strPool = poolRef.pool
  }

  // Per-function IR optimizations: ptr-type hoist, memarg-offset fold (see optimize.js).
  for (const s of [...sec.funcs, ...sec.stdlib, ...sec.start]) optimizeFunc(s)

  // Whole-module: hoist repeated f64 constants into mutable globals (see optimize.js).
  hoistConstantPool([...sec.funcs, ...sec.stdlib, ...sec.start], (name, wat) => ctx.scope.globals.set(name, wat))

  // Adjust heap base past data section (data at offset 0 may exceed 1024 bytes)
  const dataLen = ctx.runtime.data?.length || 0
  if (dataLen > 1024 && !ctx.memory.shared) {
    const heapBase = (dataLen + 7) & ~7 // align to 8
    ctx.scope.globals.set('__heap', `(global $__heap (mut i32) (i32.const ${heapBase}))`)
    // Patch __reset in stdlib to use correct heap base
    for (const s of sec.stdlib)
      if (s[0] === 'func' && s[1] === '$__reset')
        for (let i = 2; i < s.length; i++)
          if (Array.isArray(s[i]) && s[i][0] === 'global.set' && Array.isArray(s[i][2]) && s[i][2][0] === 'i32.const')
            s[i][2][1] = `${heapBase}`
  }

  // Populate globals (after __start — const folding may update declarations)
  sec.globals.push(...[...ctx.scope.globals.values()].filter(g => g).map(g => parseWat(g)))

  // Data segments (after emit — string literals append to ctx.runtime.data / strPool during emit)
  // Active segment at address 0 — skipped for shared memory (would collide across modules)
  const escBytes = (s) => {
    let esc = ''
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c >= 32 && c < 127 && c !== 34 && c !== 92) esc += s[i]
      else esc += '\\' + c.toString(16).padStart(2, '0')
    }
    return esc
  }
  if (ctx.runtime.data && !ctx.memory.shared)
    sec.data.push(['data', ['i32.const', 0], '"' + escBytes(ctx.runtime.data) + '"'])
  // Passive segment for shared-memory string literals (copied via memory.init at runtime)
  if (ctx.runtime.strPool)
    sec.data.push(['data', '$__strPool', '"' + escBytes(ctx.runtime.strPool) + '"'])

  // Custom section: embed object schemas for JS-side interop.
  // Compact binary format: varint(nSchemas); per schema: varint(nProps); per prop:
  //   0x00=null, 0x01=[null, <prop>], 0x02=<varint len><utf8 bytes>. Runtime decodes.
  if (ctx.schema.list.length) {
    const bytes = []
    const utf8 = new TextEncoder()
    const varint = (n) => { while (n >= 0x80) { bytes.push((n & 0x7F) | 0x80); n >>>= 7 } bytes.push(n) }
    const enc = (p) => {
      if (p === null) bytes.push(0)
      else if (Array.isArray(p)) { bytes.push(1); enc(p[1]) }
      else { bytes.push(2); const b = utf8.encode(p); varint(b.length); for (const x of b) bytes.push(x) }
    }
    varint(ctx.schema.list.length)
    for (const s of ctx.schema.list) { varint(s.length); for (const p of s) enc(p) }
    sec.customs.push(['@custom', '"jz:schema"', bytes])
  }

  // Custom section: rest params for exported functions (JS-side wrapping)
  const restParamFuncs = ctx.func.list.filter(f => f.exported && f.rest)
    .map(f => ({ name: f.name, fixed: f.sig.params.length - 1 }))
  if (restParamFuncs.length)
    sec.customs.push(['@custom', '"jz:rest"', `"${JSON.stringify(restParamFuncs).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // Named export aliases: export { name } or export { source as alias }
  for (const [name, val] of Object.entries(ctx.func.exports)) {
    if (val === true) {
      if (ctx.scope.userGlobals?.has(name)) sec.customs.push(['export', `"${name}"`, ['global', `$${name}`]])
      continue
    }
    if (typeof val !== 'string') continue
    const func = ctx.func.list.find(f => f.name === val)
    if (func) sec.customs.push(['export', `"${name}"`, ['func', `$${val}`]])
    else if (ctx.scope.globals.has(val)) sec.customs.push(['export', `"${name}"`, ['global', `$${val}`]])
  }

  // Whole-module: prune funcs unreachable from entry points (start, exports, elem refs).
  // Removes orphan top-level consts that never get called (e.g. watr's unused `hoist` = 26 KB).
  treeshake(
    [{ arr: sec.stdlib }, { arr: sec.funcs }, { arr: sec.start }],
    [...sec.start, ...sec.elem, ...sec.customs, ...sec.extStdlib, ...sec.imports]
  )

  // Reorder non-import funcs by call count: hot callees get low LEB128 indices.
  // `call $f` encodes funcidx as ULEB128 (1 B for idx < 128, 2 B for idx < 16384).
  // On watr self-host this saves ~6 KB (hot specialized helpers migrate to idx < 128).
  const callCount = new Map()
  const countWalk = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'call' && typeof n[1] === 'string')
      callCount.set(n[1], (callCount.get(n[1]) || 0) + 1)
    for (const c of n) countWalk(c)
  }
  for (const s of [...sec.stdlib, ...sec.funcs, ...sec.start]) countWalk(s)
  const byCalls = (a, b) => (callCount.get(b[1]) || 0) - (callCount.get(a[1]) || 0)
  const startFn = sec.start.find(n => n[0] === 'func')
  const startDir = sec.start.find(n => n[0] === 'start')
  const sortedFuncs = [
    ...sec.stdlib, ...sec.funcs, ...(startFn ? [startFn] : []),
  ].sort(byCalls)

  // Assemble: named slots → flat section list.
  const sections = [
    ...sec.extStdlib, ...sec.imports, ...sec.types, ...sec.memory, ...sec.data,
    ...sec.tags, ...sec.table, ...sec.globals, ...sortedFuncs,
    ...sec.elem, ...(startDir ? [startDir] : []), ...sec.customs,
  ]
  return ['module', ...sections]
}


