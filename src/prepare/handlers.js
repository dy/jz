/**
 * The per-node handler dispatch table (`handlers`) and `prep` (the universal recursion
 * entry every handler's rewrite half calls on its children) — plus the ~21 helper
 * functions handlers' body calls out to (prepDecl, prepareModule, resolveCallee,
 * defFunc, the typeof/strict-eq family, destructuring expansion, builtin-alias
 * registration, constructor/call folding, ...), each of which itself calls back into
 * `prep` to recurse. This is a classic recursive-descent interpreter shape: one
 * dispatch table, mutually recursive with its own helpers by construction, not an
 * artifact of the split. A verified Tarjan SCC over the full dependency graph confirms
 * these ~25 declarations form a single strongly-connected component with no acyclic
 * 2-way split; jz's own resolveModuleGraph (unlike Node) rejects import cycles, so
 * (deviating from .work/prepare-split.md's primary "accept one circular import between
 * handlers.js and handler-helpers.js" plan) this file carries the whole cluster — the
 * doc's own stated fallback for exactly this case.
 *
 * @module prepare/handlers
 */

import { ctx, declGlobal, derive, emitArity, err, setFeature } from '../ctx.js'
import { JZ_UNDEF, MUTATE_OPS, PARAM_DEFAULT, PARAM_KIND, PARAM_NAME, PARAM_PATTERN, STMT_OPS, T, TYPEOF, classifyParam, cloneNode, collectParamNames, extractParams, handlerArgs, walkAst } from '../ast.js'
import { COLLECTION_CTORS, CTORS, hasModule, includeForArrayAccess, includeForArrayLiteral, includeForArrayPattern, includeForCallableValue, includeForGenericMethod, includeForNamedCall, includeForNumericCoercion, includeForObjectLiteral, includeForObjectPattern, includeForOp, includeForProperty, includeForRuntimeCtor, includeForStringOnly, includeForStringValue, includeMods, includeModule } from '../autoload.js'
import { censusShapedNode } from '../kind.js'
import { REJECT_IDENTS, rejectHandlers } from '../op-policy.js'
import { recordGlobalRep } from '../compile/infer.js'
import { NO_VALUE, staticObjectProps, staticPropertyKey, staticValue } from '../static.js'
import { TYPED_ELEM_NAMES } from '../../layout.js'
import { ERR_CLASS_NAMES } from '../../err-codes.js'
import { hasFunc, isFuncValueLocal, isUnresolvableBareIdent, renameFunc, shadowsBuiltin } from './closure-lift.js'
import { MUTATING_ARRAY_METHODS, alwaysFalsy, alwaysTruthy, dropDeadPostfix, foldConstIf, stringValue, stripBoolNot, truncateUnreachable } from './const-fold.js'
import { arrayLiteralItems, isDestructPattern, patternItems, simpleArrayPatternItems, substPattern } from './destructure.js'
import { boundSafeCalls, mintLocal, scanReassignedTopLevel, writesReceiver } from './ident-purity.js'
import { bindStaticConst, bindStaticGlobal, deleteStaticGlobal, hoistIndexedConstLiterals, invalidateMutatedArray, staticString, staticStringArrayValues, staticStringExpr, stringArrayValues } from './literals.js'
import { INTRINSIC_CALLEES, addHostImport, builtinAliasKeyOf, foldImportMetaResolve, foldNamespaceIntrospection, importMetaUrl, isBundledModule, isImportMeta, isImportMetaProp, moduleAstFor, namespaceMemberAliases, namespaceMemberAssigns, namespaceModOf, recordModuleInitFacts, resolveImportMeta } from './module-resolve.js'
import { bindAssignSchema, bindDeclSchema, censusUnknownInitDecl, conditionalSpreadGroupPrepare, inferAssignSchema, objLiteralSid } from './schema.js'
import { bindingNames, bodyCapturesName, collectLoopDeclNames, declareGlobal, inlineArrayLen, isDeclared, markLoopLocal, mintForScope, popScope, prescanBlockDecls, pushScope, resolveScope, substIdents, withLoopLocalNames } from './scope.js'
import { CONSTANTS, ERR_CLASS_SET, F64_CONSTANTS, GLOBALS, INSTANCEOF_ALLOW, NS_CTORS, SIMD_NS, STATIC_ARRAYS, STATIC_CONSTS, STATIC_STRINGS, assignedStaticGlobals, builtinMemberKey, freshPrepareId, funcLocalNames, funcValueNames, loopLocalNames, mutatedArrayNames, ownerStack, prepState, promiseRecvNames, renameSerial, scopes, staticConstScopes, withResolversRecvNames } from './state.js'


// Avoid materializing `node.slice(1)` at every recursive dispatch. Nearly all
// AST operators have at most four operands; only declaration/list outliers use
// the allocating fallback.
const callHandler = (handler, node) => {
  switch (node.length) {
    case 1: return handler()
    case 2: return handler(node[1])
    case 3: return handler(node[1], node[2])
    case 4: return handler(node[1], node[2], node[3])
    case 5: return handler(node[1], node[2], node[3], node[4])
    default: return handler(...node.slice(1))
  }
}

export function prep(node) {
  if (Array.isArray(node)) includeForOp(node[0])
  // Whole-program "does a BigInt value ever get constructed" flag — the ONLY two
  // ways a bigint value is synthesized are a bigint literal (parse.js tags it
  // `['bigint', decimalStr]`) or an explicit `BigInt(x)` call; catching
  // both here, in prep()'s universal per-node entry (this single early pass runs
  // before ANY function emission), makes the flag order-independent for every
  // later emit-time reader. Consumed by ir.js's toNumF64 (inlineToNum fast path) to
  // scope the runtime "is this a boxed BigInt carrier" magnitude check to programs
  // that can actually produce one — everywhere else stays the original cheap
  // NaN-only check (see .work/archive/todo.md).
  if (Array.isArray(node) && (node[0] === 'bigint' || (node[0] === '()' && node[1] === 'BigInt')))
    setFeature('bigint', true)
  // Whole-program "does a jz Error object ever get constructed" flag — mirrors the
  // bigint flag immediately above (order-independence for the same reason: a
  // template literal stringifying a caught Error, ir.js's toStrI64 Error-schema
  // arm, can textually precede the `new Error(...)`/`Error(...)` call site that
  // proves the schema exists at all). Catches BOTH the `new X(...)` raw shape
  // (before the 'new' handler rewrites it) and the bare-call `X(...)` shape — one
  // of the 7 built-in classes (.work/archive/todo.md §deletion-sweep §2: `Error(x)` without `new`
  // also constructs a fresh Error, same as `new Error(x)`). A shadowed `Error`
  // identifier (`function Error(x){…}`) can false-positive this flag — harmless:
  // ir.js's guard is a runtime tag+schema compare that simply never fires for a
  // program that never actually calls the real ctx.core.emit['Error'].
  //
  // `new X(args)` with any args (the common shape) parses as `['new', ['()', X,
  // args]]` — the class name sits one level DEEPER than a bare `node[1]` string
  // check would reach, so `ctorCallee` must unwrap this nested shape (same
  // unwrap the 'new' handler below already does, for the identical reason).
  // jzify's default-mode transform flattens `new X(args)` to a bare `['()', X,
  // args]` call before prepare ever runs (module/core.js's Error emitters work
  // identically with or without `new`), so a scan that only checked the bare
  // shape would still be correct in default mode — but STRICT mode skips jzify
  // and the raw nested parser shape survives to prepare, where it needs this
  // explicit unwrap (.work/archive/todo.md §deletion-sweep).
  const ctorCallee = Array.isArray(node) && node[0] === 'new' && Array.isArray(node[1]) && node[1][0] === '()' ? node[1][1]
    : Array.isArray(node) && (node[0] === 'new' || node[0] === '()') ? node[1] : null
  if (typeof ctorCallee === 'string' && ERR_CLASS_SET.has(ctorCallee)) {
    setFeature('error', true)
    // errorClasses mutates the SAME Set object in place (no key-level write for
    // setFeature's tripwire to see) — both call sites run mid-prepare like `error`
    // above, so it never needs the guard.
    ;(ctx.features.errorClasses ??= new Set()).add(ctorCallee)
  }
  // Whole-program "will a nullish-receiver check ever construct a TypeError"
  // flag (member access / calls on a genuinely undefined-or-null receiver —
  // src/ir.js throwTypeErrorIR, called from
  // module/core.js emitLengthAccess and src/compile/emit.js's dynamic
  // method-call/closure-call strategies). Those emit sites construct a REAL
  // TypeError object with no `new TypeError(...)` anywhere in the user's own
  // source, so the errorClasses scan above never sees them —
  // `emitErrorInstanceof`/`toStrI64` (ir.js) still need `used.has('TypeError')`
  // true BEFORE any function emits, or an in-source `catch (e) { e instanceof
  // TypeError }` compiled ahead of the throw site (order-independent, same
  // reasoning as the bigint/error flags above) folds to `false` at compile
  // time even though the caught pointer is bit-for-bit a real TypeError at
  // runtime. (throwTypeErrorIR builds the object INLINE, not via
  // `ctx.core.emit['TypeError']` — no module/string.js dependency, so unlike
  // an earlier draft of this hook, there is no matching module-autoload
  // half to this fix; see throwTypeErrorIR's own comment for the two
  // PRE-EXISTING, unrelated bugs that draft re-exposed.) `censusShapedNode`
  // (kind.js) is a pure AST-shape test — no ctx lookup needed at prepare
  // time — recognizing exactly the two receiver/callee shapes (`X[k]` /
  // `X.k` / `X.get(k)`) these checks can ever fire on: a member access or
  // call whose base is one of those shapes MAY reach the vt-unknown dynamic-
  // dispatch arm that throws. A sound OVER-approximation (same "absence of
  // proof of presence" direction censusShapedNode's own callers already use
  // for mayBeUndefined) — it can cost an un-folded (but still runtime-
  // correct) instanceof/toString check when the flagged site turns out not
  // to be nullish at runtime, never a missed flag.
  if (Array.isArray(node) && (node[0] === '.' || node[0] === '()') && censusShapedNode(node[1])) {
    setFeature('error', true)
    ;(ctx.features.errorClasses ??= new Set()).add('TypeError')
  }
  // Promise executor resolve/reject closures (jzify/async.js's __p_exec(fn)
  // calls fn((v)=>…, (e)=>…) — see async.js's ASYNC_RUNTIME) have no static
  // binding site of their OWN: they're injected AT THE __p_exec CALL SITE,
  // invisible to isFuncValueRecv's existing hasFunc/isFuncValueLocal proof
  // below (both keyed off a name whose OWN declaration RHS is a literal
  // `=>`). A name copied straight from one of these params (`resolve = a`,
  // test262 Promise/exec-args.js's exact shape) has no such literal RHS
  // either, so `.length`/`.name` on it fell through to a silent wrong value
  // at the generic dynamic-property layer (module/core.js emitPropAccess/
  // buildLengthHelper) — with no SOUND way to catch it there: that
  // dispatcher runs for the COMPILER'S OWN self-hosted code too, and
  // module/core.js's emitArity (`h?.argc ?? h?.length`, src/ctx.js) reads
  // `.length` off exactly this shape (an unresolved-kind closure PARAMETER)
  // as a normal, tolerated pattern throughout the compiler's own emit-table
  // arity probes — a receiver-kind RUNTIME guard there broke self-hosting
  // (confirmed live: crashed the kernel on every single compile via
  // emitArity, kernel-oracle 3/14 — reverted). Reject HERE instead, only at
  // compile time and only for this one named construct: jz's own compiler
  // source never writes `new Promise`/`__p_exec` (verified — zero hits), so
  // this scan can never fire while compiling the compiler itself. Scans the
  // executor's OWN literal body for a bare `outer = firstOrSecondParam`
  // copy-through and adds `outer`'s post-rename spelling to funcValueNames —
  // the SAME set isFuncValueRecv already consults for a directly-literal-
  // bound name, just reached one hop later (through the param, not a `=>`
  // RHS).
  if (Array.isArray(node) && node[0] === '()' && node[1] === '__p_exec' && Array.isArray(node[2])) {
    const executor = node[2]
    const eop = executor[0]
    const rawParams = eop === '=>' ? executor[1] : eop === 'function' ? executor[2] : null
    const execBody = eop === '=>' ? executor[2] : eop === 'function' ? executor[3] : null
    let params = rawParams == null ? [] : extractParams(rawParams).slice(0, 2).filter(p => typeof p === 'string')
    // An executor whose body reads `arguments` was already rewritten by
    // jzify's lowerArguments BEFORE prepare ever sees it: the real params
    // (a, b) vanish behind a single rest param, recovered inside the body's
    // own destructure `let a = arg0[0], b = arg0[1]` (test262 exec-args.js's
    // own real shape: its executor's THIRD statement is `argCount =
    // arguments.length`, confirmed live to trigger exactly this rewrite).
    // classifyParam (src/ast.js) is the SAME rest-param recognizer prepare's
    // own param-processing already trusts elsewhere.
    if (!params.length && rawParams != null) {
      const rp = extractParams(rawParams)
      if (rp.length === 1 && classifyParam(rp[0])[PARAM_KIND] === 'rest') {
        const restName = classifyParam(rp[0])[PARAM_NAME]
        const stmts = Array.isArray(execBody) && execBody[0] === '{}' && Array.isArray(execBody[1]) && execBody[1][0] === ';'
          ? execBody[1].slice(1) : []
        const recovered = []
        for (const s of stmts) {
          if (!Array.isArray(s) || (s[0] !== 'let' && s[0] !== 'const')) continue
          for (let i = 1; i < s.length; i++) {
            const d = s[i]
            if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' &&
                Array.isArray(d[2]) && d[2][0] === '[]' && d[2][1] === restName &&
                Array.isArray(d[2][2]) && d[2][2][0] == null && typeof d[2][2][1] === 'number')
              recovered[d[2][2][1]] = d[1]
          }
        }
        params = recovered.slice(0, 2).filter(p => typeof p === 'string')
      }
    }
    if (params.length) {
      const paramSet = new Set(params)
      walkAst(execBody, { enter: n => {
        const nop = n[0]
        if (nop === '=' && typeof n[1] === 'string' && typeof n[2] === 'string' && paramSet.has(n[2])) {
          const outer = scopes.length && isDeclared(n[1]) ? resolveScope(n[1]) : n[1]
          funcValueNames[funcValueNames.length - 1]?.add(outer)
        }
        if (nop === '=>') return false  // the executor's own nested closures are a separate scope
      } })
    }
  }
  if (Array.isArray(node) && node.loc != null) ctx.error.loc = node.loc
  if (node == null) return [, 0] // null/undefined → 0 literal
  // Keep boolean identity (was folded to 1/0). The working representation is
  // still i32/f64 0/1 — emit lowers the raw boolean — but valTypeOf now reads
  // VAL.BOOL off the literal, so typeof/String/JSON/host boundary stay faithful.
  if (node === true) return [, true]
  if (node === false) return [, false]
  if (!Array.isArray(node)) {
    if (typeof node === 'string') {
      if (node in CONSTANTS) return [, CONSTANTS[node]]
      if (node in F64_CONSTANTS) return [, F64_CONSTANTS[node]]
      if (REJECT_IDENTS[node]) err(REJECT_IDENTS[node])
      // A bare #name ident outside its class body: the `#field in obj` brand check
      // (or a leaked private name). Reject with intent, not "not in scope".
      if (node[0] === '#') err(`private name '${node}' not supported — jz has no class-based private fields (no #field declarations, no #field in obj brand checks); use a plain property with a naming convention instead, e.g. this._${node.slice(1)}`)
      // Boolean/Number as value → identity arrow (for .filter(Boolean), .map(Number) etc.)
      if (node === 'Boolean' || node === 'Number') { includeForCallableValue(); return ['=>', 'x', 'x'] }
      // Block locals shadow module imports/globals, even when the local keeps the same name.
      if (scopes.length && isDeclared(node)) return resolveScope(node)
      // A user top-level binding (`let Math = …`) shadows a same-named builtin
      // namespace seeded into the scope chain (`Math → math`). Resolve to the
      // user global, not the builtin. (Mangled globals drop their original name
      // from userGlobals, so this fires only for un-renamed user bindings.)
      if (ctx.scope.userGlobals?.has?.(node)) return node
      // Host numeric constant (`Math.PI` etc.) → fold to its f64 literal. Placed after the
      // local/user-global checks above so a same-named binding still shadows it.
      if (ctx.scope.hostConsts && node in ctx.scope.hostConsts) return [, ctx.scope.hostConsts[node]]
      const resolved = ctx.scope.chain[node]
      if (resolved?.includes('.')) return resolved
      // Cross-module import: mangled name (e.g. __util_js$clone)
      if (resolved && resolved !== node) return resolved
      // Block scope: resolve renames
      if (scopes.length) return resolveScope(node)
    }
    return node
  }

  const op = node[0]
  if (op === 'void' && ctx.transform.strict) err('strict mode: `void` is prohibited — write `undefined`.')
  // jz's `==`/`!=` follow JS loose equality (statically-known mixed types coerce:
  // `1 == "1"` is true), so default mode accepts them for JS parity. strict enforces
  // the canonical subset, where `===`/`!==` are the one spelling — reject the loose form.
  if ((op === '==' || op === '!=') && ctx.transform.strict)
    err(`strict mode: \`${op}\` is prohibited — use \`${op}=\` (\`jz --jzify\` converts). jz's \`${op}\` follows JS loose equality; the canonical subset spells equality \`===\`/\`!==\` only.`)
  // A builtin-namespace member alias (`let sin = Math.sin`, `let {sin} = Math`)
  // carries no storage — writing through it would silently target nothing.
  // Catch every write form (`=`, compound `+=`-family, `++`/`--`) here, ahead
  // of per-op handlers, so none of them need their own copy of this check.
  if (MUTATE_OPS.has(op) && typeof node[1] === 'string') {
    const name = node[1]
    const aliasKey = builtinAliasKeyOf(name)
    if (aliasKey) err(`Cannot reassign '${name}' — bound to builtin '${aliasKey}' via alias/destructuring; builtin-namespace bindings are compile-time only, not writable storage. Declare a fresh local instead, or reference '${aliasKey}' directly`)
    // Assignment to a const binding is a compile error (ES: runtime TypeError).
    // Resolve through the live block scopes so a shadowing `let` of the same
    // name stays writable; module-level consts are guarded by emit's isConst.
    const target = scopes.length && isDeclared(name) ? resolveScope(name) : name
    if (typeof target === 'string' && staticConstScopes.some(f => f[STATIC_CONSTS]?.has(target)))
      err(`Assignment to constant '${name}' (TypeError in JS)`)
  }
  if (op == null) {
    if (typeof node[1] === 'string') {
      includeForStringValue()
      return ['str', node[1]]  // string literal
    }
    return [, node[1]]  // number literal
  }
  const handler = handlers[op]
  if (handler) return callHandler(handler, node)
  const out = [op]
  for (let i = 1; i < node.length; i++) out.push(prep(node[i]))
  return out
}

// A lone parenthesized comma-expression argument — `f((a, b, c))` — is ONE
// argument whose value is the last comma operand. The parser keeps it wrapped
// (`['()', [',', …]]`); prep would strip the grouping, leaving a bare comma
// that emit can no longer tell apart from an arg list and splats into N args.
// With ≥2 args an outer arg-list comma already nests it — only the sole-arg
// case loses the distinction. Re-nest it under a 1-element arg-list comma.
function renestSoleCommaArg(args) {
  if (args.length === 1 && Array.isArray(args[0]) && args[0][0] === '()' && args[0].length === 2) {
    const ungroup = n => Array.isArray(n) && n[0] === '()' && n.length === 2 ? ungroup(n[1]) : n
    const core = ungroup(args[0])
    if (Array.isArray(core) && core[0] === ',') return [[',', args[0]]]
  }
  return args
}

const handlers = {
  ...rejectHandlers(err),
  // Spread operator: [...expr] in arrays, f(...args) in calls, {...obj} in objects
  '...'(expr) {
    includeForArrayLiteral()
    return ['...', prep(expr)]
  },

  'debugger': () => null,
  // Static-key delete (.x, ["x"], [literal]) would change the fixed schema → reject.
  // Computed-key delete (obj[expr]) — including jessie's `delete ctx[k]` — lowers
  // to runtime __dyn_del against the per-object shadow property store.
  'delete'(target) {
    const t = prep(target)
    if (Array.isArray(t) && t[0] === '[]' && t.length === 3) {
      const key = t[2]
      const isLiteralKey = Array.isArray(key) && key[0] == null && key.length === 2
      if (!isLiteralKey) return ['delete', t[1], key]
    }
    err('delete not supported on a static key: object shape is fixed — use a computed key with a variable (`delete obj[k]`) if the key must vary at runtime')
  },
  'in'(key, obj) { return ['in', prep(key), prep(obj)] },
  'label'(name, body) { return ['label', name, prep(body)] },

  // Destructuring assignment: [a, ...b] = expr or {x, y} = expr
  '='(lhs, rhs) {
    // Destructuring assignment: [a, ...r] = expr or ({x: a} = expr)
    // Distinguishing from index assignment: destructuring patterns have exactly one payload node.
    if (isDestructPattern(lhs) && lhs.length === 2) {
      // `({sqrt, abs} = Math)` — see namespaceMemberAssigns. Checked ahead of the
      // generic runtime-destructure path below, which has no way to read a
      // property off a namespace that isn't a real heap object.
      if (lhs[0] === '{}' && typeof rhs === 'string' && !shadowsBuiltin(rhs)) {
        const mod = ctx.scope.chain[rhs]
        // `mod !== rhs` excludes an identity self-map (an ordinary host-import
        // alias or un-renamed binding resolves to its OWN name) — see the same
        // guard's rationale in the '.' handler and prepDecl's namespace-value alias.
        if (mod && mod !== rhs && !mod.includes('.') && hasModule(mod)) {
          const assigns = namespaceMemberAssigns(lhs, rhs)
          if (assigns) return prep([';', ...assigns])
        }
      }

      const scalar = scalarArrayDestruct(lhs, rhs)
      if (scalar) return scalar

      const normed = prep(rhs)
      const tmp = `${T}d${freshPrepareId()}`
      const decls = [['=', tmp, normed]]
      // Propagate schema to temp so rest destructuring can resolve it
      if (typeof normed === 'string' && ctx.schema.vars.has(normed))
        ctx.schema.vars.set(tmp, ctx.schema.vars.get(normed))
      const stmts = []
      expandDestruct(lhs, tmp, stmts, decls)
      return prep([';', ['let', ...decls], ...stmts])
    }
    // Function property assignment: fn.prop = arrow → extract as top-level function fn$prop.
    // A property can be reassigned — esbuild/jessie wrapper-composition does
    // `p.s = ...; var old = p.s; p.s = () => old()...`. Each assignment extracts
    // its own top-level function; the property holds whichever was assigned last,
    // and an earlier snapshot keeps pointing at the prior one. Collide → fresh name.
    // The base resolves through the scope chain first so an *imported* function
    // (mangled to `_mod$fn`) is recognised the same as a local one — the
    // subscript parser's plugin model mutates `parse.step` etc. across modules,
    // and a reassignment in module B must mark module A's call sites mutable.
    if (prepState.depth === 0 && Array.isArray(lhs) && lhs[0] === '.' && typeof lhs[1] === 'string'
      && Array.isArray(rhs) && rhs[0] === '=>') {
      const fnBase = ctx.scope.chain[lhs[1]] || lhs[1]
      if (hasFunc(fnBase)) {
        let name = `${fnBase}$${lhs[2]}`
        // Reassignment → the property is mutable; record it so `fn.prop()` calls
        // emit a dynamic property read + indirect call instead of a direct call.
        if (ctx.funcs.names.has(name)) {
          const key = `${fnBase}.${lhs[2]}`
          let lifts = ctx.funcs.multiProp.get(key)
          if (!lifts) ctx.funcs.multiProp.set(key, lifts = new Set([name]))
          do { name = `${fnBase}$${lhs[2]}$${freshPrepareId()}` } while (ctx.funcs.names.has(name))
          lifts.add(name)
        }
        // Build the target `.` node directly from the resolved base — re-`prep`ing
        // the lhs would resolve a multiProp `fn.prop` to an rvalue (closure
        // materialization block), which is not a valid assignment target.
        // Cross-module lift: the lifted func belongs to the BASE function's
        // OWNING module (fnBase's mangled prefix), not the module that textually
        // contains the write. Untagged, the writing module's end-of-prep rename
        // sweep double-prefixes it (`__B$__A$lex$next`) and the owner's call
        // sites never direct-resolve — every read stays on the dyn path forever
        // (the hot tokenizer probes test/closures.js's cross-module pin catches).
        if (defFunc(name, prep(rhs))) {
          const ownerEnd = fnBase.lastIndexOf('$')
          if (ownerEnd > 0) {
            const fn = ctx.funcs.list.find(f => f.name === name)
            // _ownerPrefix exempts the lift from the writing module's NAME
            // mangling only — its BODY is this module's text and must still get
            // this module's reference-renaming walk (unlike _modulePrefix, which
            // marks sub-module funcs already walked with their own rename map).
            if (fn && !fn._ownerPrefix) fn._ownerPrefix = fnBase.slice(0, ownerEnd)
          }
          return ['=', ['.', fnBase, lhs[2]], name]
        }
      }
    }
    const staticStr = staticStringExpr(rhs)
    const staticArr = staticStringArrayValues(rhs)
    const plhs = prep(lhs)
    const prhs = prep(rhs)
    // Element/length writes mutate the array behind a static-array fact.
    if (Array.isArray(plhs) && (plhs[0] === '[]' || (plhs[0] === '.' && plhs[2] === 'length')))
      invalidateMutatedArray(plhs[1])
    if (prepState.depth === 0 && typeof plhs === 'string' && ctx.scope.globals.has(plhs)) {
      // First assignment fixes the global's representation + object schema.
      if (!ctx.scope.globalReps?.has(plhs)) {
        recordGlobalRep(plhs, prhs)
        if (Array.isArray(prhs) && prhs[0] === '{}') {
          const props = staticObjectProps(prhs.slice(1))
          if (props) bindAssignSchema(plhs, ctx.schema.register(props.names))
        } else bindAssignSchema(plhs, null)
      } else bindAssignSchema(plhs, objLiteralSid(prhs))
      // Static string/array facts hold only while every assignment is constant.
      // Array facts additionally require the census-clean name (no indexed/
      // method mutation anywhere — see the const-decl gate).
      const arrOk = staticArr && !(typeof lhs === 'string' && mutatedArrayNames.has(lhs)) ? staticArr : null
      if (!assignedStaticGlobals.has(plhs) && (staticStr != null || arrOk)) bindStaticGlobal(plhs, staticStr, arrOk)
      else deleteStaticGlobal(plhs)
      assignedStaticGlobals.add(plhs)
    }
    // Object-literal assignment to a variable — e.g. a `var` that jzify hoisted
    // into `let x; x = {…}`. Recording the schema lets the binding behave like
    // `let x = {…}`: fixed-slot field access and for-in unroll. SOUNDNESS: the
    // shape holds only while EVERY assignment to the name agrees — one literal
    // shape, no other sources. Any disagreeing assignment (non-literal RHS such
    // as a table/Map lookup, or a different-shape literal) unbinds and poisons
    // the name; fixed-slot reads against one literal's layout would misread the
    // other sources' objects (e.g. `.x` returning another shape's slot-0 value).
    // Compile reads the END state, so the conflict check is order-insensitive.
    else if (typeof plhs === 'string') {
      // depth > 0: consensus/poison only — a function local never publishes
      // into the module-global vars map (see bindAssignSchema).
      bindAssignSchema(plhs, objLiteralSid(prhs), false)
    }
    // promiseRecvNames/withResolversRecvNames (see their own declaration,
    // near funcValueNames) — the REASSIGNMENT sibling of the decl-time check
    // above (`typeof declName === 'string' && normed[0] === '()' …`): a
    // `var p = new Promise(fn)` is exactly this shape by the time prepare
    // sees it (jzify/hoist-vars.js already split it into a bare `let p` decl
    // elsewhere plus this plain assignment) — the decl-time check alone
    // never fires for it, so `p.then.length` (test262 Promise/prototype/
    // then/S25.4.5.3_A1.1_T2.js) needs this hop too.
    if (typeof plhs === 'string' && Array.isArray(prhs) && prhs[0] === '()') {
      if (prhs[1] === '__p_exec') promiseRecvNames.add(plhs)
      else if (prhs[1] === '__p_withResolvers') withResolversRecvNames.add(plhs)
    }
    return ['=', plhs, prhs]
  },

  // try/catch/throw
  // Parser produces ['try', body, ['catch', param, handler]?, ['finally', cleanup]?]
  'try'(body, ...clauses) {
    const catchClause = clauses.find(c => Array.isArray(c) && c[0] === 'catch')
    const finallyClause = clauses.find(c => Array.isArray(c) && c[0] === 'finally')
    const tryBody = prep(body)
    // A pattern catch param (`catch ({ x })`) binds via a minted temp + a
    // destructuring decl prepended to the handler (mirrors defFunc's param
    // patterns) — the raw pattern node is not a bindable catch local.
    let cParam = catchClause?.[1], cHandler = catchClause?.[2]
    if (catchClause && isDestructPattern(cParam)) {
      const tmp = `${T}cp${freshPrepareId()}`
      const declStmt = ['let', ['=', cParam, tmp]]
      cHandler = Array.isArray(cHandler) && cHandler[0] === '{}'
        ? (Array.isArray(cHandler[1]) && cHandler[1][0] === ';'
          ? ['{}', [';', declStmt, ...cHandler[1].slice(1)]]
          : ['{}', [';', declStmt, ...(cHandler[1] == null ? [] : [cHandler[1]])]])
        : ['{}', [';', declStmt, cHandler]]
      cParam = tmp
    }
    // A plain catch param is a binding site of unknown shape (it holds whatever
    // was thrown) that never passes through prepDecl — census it directly, or a
    // same-named literal decl elsewhere would type it through the vars channel
    // (pattern params census via their lowered destructuring decl).
    if (typeof cParam === 'string') censusUnknownInitDecl(cParam)
    // prep(handler) ONCE — it has side effects (uniq++, scope pushes, includes), so
    // the no-finally catch branch must reuse `caught`, not re-prep (FE-3 fix).
    // The catch param is its OWN binding: without a scope frame + shadow rename,
    // handler reads resolve to an outer same-named binding (`{ let e; try {…}
    // catch (e) { e } }` read the outer e, not the caught value — and the
    // catch local aliased the outer binding's WASM slot).
    let caught = tryBody
    if (catchClause) {
      const scope = new Map()
      if (typeof cParam === 'string') {
        const fnNames = funcLocalNames[funcLocalNames.length - 1]
        if (prepState.depth !== 0) {
          const renamed = mintLocal(cParam)
          scope.set(cParam, renamed)
          cParam = renamed
        } else if (isDeclared(cParam) || fnNames?.has(cParam)) {
          const renamed = `${cParam}${T}${freshPrepareId()}`
          scope.set(cParam, renamed)
          cParam = renamed
        } else scope.set(cParam, cParam)
        fnNames?.add(cParam)
      }
      pushScope(scope)
      prescanBlockDecls(cHandler)
      caught = ['catch', tryBody, cParam, prep(cHandler)]
      popScope()
    }
    return finallyClause ? ['finally', caught, prep(finallyClause[1])] : caught
  },
  'throw'(expr) { return ['throw', prep(expr)] },

  // Template literal: [``, part, ...] → fused single-allocation string concat.
  '`'(...parts) {
    // Fully-static template (`a${123}b`, `hello ${1+2} world`) folds to a single string
    // literal — a static data segment / SSO box, no runtime concat and no heap machinery.
    const folded = staticStringExpr(['`', ...parts])
    if (folded != null) return staticString(folded)
    includeForStringValue()
    const nodes = parts.map(p =>
      Array.isArray(p) && p[0] == null && typeof p[1] === 'string' ? ['str', p[1]] : prep(p))
    return ['strcat', ...nodes]
  },

  // Tagged template: tag`a${x}b` → tag(['a','b'], x)
  '``'(tag, ...parts) {
    // String.raw needs the RAW source slices, but subscript's template node
    // carries only cooked strings (escapes already applied) — raw text is
    // unrecoverable post-parse, and folding cooked-as-raw is silently wrong
    // for any template containing an escape. Reject until the parser keeps
    // raw slices (upstream subscript; same for `.raw` inside custom tags).
    if (Array.isArray(tag) && tag[0] === '.' && tag[1] === 'String' && tag[2] === 'raw')
      err('String.raw not supported: the parser keeps only cooked template strings — write the raw characters out manually (double the backslashes) instead of using String.raw')
    const raw = staticStringExpr(['``', tag, ...parts])
    if (raw != null) return staticString(raw)
    const strs = [], exprs = []
    for (const p of parts) {
      if (Array.isArray(p) && p[0] == null && typeof p[1] === 'string') strs.push(p)
      else exprs.push(p)
    }
    const arr = strs.length === 1 ? ['[]', strs[0]] : ['[]', [',', ...strs]]
    const callArgs = exprs.length === 0 ? arr : [',', arr, ...exprs]
    return prep(['()', tag, callArgs])
  },

  // Import
  'import'(fromNode) {
    // Bare side-effect: `import './sub.js'` → AST is ['import', [null, 'path']]
    if (Array.isArray(fromNode) && fromNode[0] == null && typeof fromNode[1] === 'string')
      return handlers['from'](null, fromNode)
    if (!Array.isArray(fromNode) || fromNode[0] !== 'from')
      return err('Dynamic import() not supported: jz resolves the module graph at compile time — use a static top-level import statement instead')
    return handlers['from'](fromNode[1], fromNode[2])
  },

  // Mixed default+named import `import d, { n } from 'm'` — jessie emits it as a
  // statement-level comma `[',', ['import', d], ['from', spec, src]]` (the default
  // fragment lost its source). Reunite: bind the default, then the named specifiers,
  // both against the shared source. (prepareModule caches by specifier, so preparing
  // the source twice is a no-op — same as two separate `import` statements.)
  // Any other comma is a sequence expression: fall through to generic prep.
  ','(...items) {
    if (items.length === 2
      && Array.isArray(items[0]) && items[0][0] === 'import' && typeof items[0][1] === 'string'
      && Array.isArray(items[1]) && items[1][0] === 'from') {
      const source = items[1][2]
      handlers['from'](items[0][1], source)
      handlers['from'](items[1][1], source)
      return null
    }
    return [',', ...items.map(prep)]
  },

  'from'(specifiers, source) {
    const mod = source?.[1]
    if (!mod || typeof mod !== 'string') return err(`Invalid import source ${JSON.stringify(source)} — the module specifier after \`from\` must be a string literal`)

    // Host imports override built-ins for named imports
    const hostMod = ctx.module.hostImports?.[mod]
    let remaining = specifiers
    if (hostMod && Array.isArray(specifiers) && specifiers[0] === '{}') {
      const inner = specifiers[1]
      if (inner != null) {
        const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
        const builtinItems = []
        for (const item of items) {
          const name = typeof item === 'string' ? item : item[1]
          const alias = typeof item === 'string' ? item : item[2]
          const spec = hostMod[name]
          if (spec) {
            addHostImport(mod, name, alias, spec)
          } else {
            builtinItems.push(item)
          }
        }
        if (builtinItems.length === 0) return null
        if (!hasModule(mod)) {
          const name = typeof builtinItems[0] === 'string' ? builtinItems[0] : builtinItems[0][1]
          err(`'${name}' not declared in host module '${mod}' — add it to { imports: { '${mod}': {...} } }`)
        }
        remaining = ['{}', builtinItems.length === 1 ? builtinItems[0] : [',', ...builtinItems]]
      } else {
        return null
      }
    }

    // Tier 1: Built-in module
    if (hasModule(mod)) {
      includeModule(mod)
      const bind = (name, alias) => {
        const key = mod + '.' + name
        if (!ctx.core.emit[key]) err(`'${name}' is not exported from built-in module '${mod}' — check the spelling, or see the module's documented exports`)
        ctx.scope.chain[alias || name] = key
      }

      if (typeof remaining === 'string') { ctx.scope.chain[remaining] = mod; return null }
      if (Array.isArray(remaining) && remaining[0] === 'as' && remaining[1] === '*') { ctx.scope.chain[remaining[2]] = mod; return null }

      if (Array.isArray(remaining) && remaining[0] === '{}') {
        const inner = remaining[1]
        if (inner == null) return null
        const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
        for (const item of items)
          if (typeof item === 'string') bind(item)
          else if (Array.isArray(item) && item[0] === 'as') bind(item[1], item[2])
          else err(`Invalid import specifier: ${JSON.stringify(item)} — each named import must be a plain identifier or an \`x as y\` rename`)
      }
      return null
    }

    // Tier 2: Source module (bundling)
    if (isBundledModule(mod)) {
      const resolved = prepareModule(mod, ctx.module.importSources?.[mod])
      // Default import: import name from 'mod' → bind to default export
      if (typeof specifiers === 'string') {
        const mangled = resolved.exports.get('default')
        if (!mangled) err(`'${mod}' has no default export — use a named import instead: import { name } from '${mod}'`)
        ctx.scope.chain[specifiers] = mangled
        return null
      }
      // Namespace import: import * as X from 'mod' → bind X.prop to mangled names
      if (Array.isArray(specifiers) && specifiers[0] === 'as' && specifiers[1] === '*') {
        const alias = specifiers[2]
        // Store namespace mapping so '.' handler can resolve X.prop → mangled name
        if (!ctx.module.namespaces) ctx.module.namespaces = Object.create(null)  // name-keyed: prototype-less (see derive)
        ctx.module.namespaces[alias] = resolved.exports
        return null
      }
      // Named imports: import { a, b } from 'mod'
      if (Array.isArray(specifiers) && specifiers[0] === '{}') {
        const inner = specifiers[1]
        if (inner == null) return null
        const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
        for (const item of items) {
          const name = typeof item === 'string' ? item : item[1]
          const alias = typeof item === 'string' ? item : item[2]
          const mangled = resolved.exports.get(name)
          if (!mangled) err(`'${name}' is not exported from '${mod}' — check the module's export list`)
          if (mangled instanceof Map) {
            // A namespace re-export (`export * as name from`): bind as `import * as`.
            if (!ctx.module.namespaces) ctx.module.namespaces = Object.create(null)
            ctx.module.namespaces[alias] = mangled
            continue
          }
          ctx.scope.chain[alias] = mangled
        }
      }
      return null
    }

    // Tier 3: Host imports (non-built-in modules)
    if (hostMod) {
      if (typeof specifiers === 'string') {
        const spec = hostMod.default
        if (!spec) err(`'default' not declared in host module '${mod}'; add it to { imports: { '${mod}': { default: ... } } }`)
        addHostImport(mod, 'default', specifiers, spec)
        return null
      }
      if (Array.isArray(specifiers) && specifiers[0] === '{}') {
        const inner = specifiers[1]
        if (inner == null) return null
        const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
        for (const item of items) {
          const name = typeof item === 'string' ? item : item[1]
          const alias = typeof item === 'string' ? item : item[2]
          const spec = hostMod[name]
          if (!spec) err(`'${name}' not declared in host module '${mod}' — add it to { imports: { '${mod}': {...} } }`)
          addHostImport(mod, name, alias, spec)
        }
      }
      return null
    }

    err(`Unknown module '${mod}': not a built-in and not registered — provide it via { modules: { '${mod}': source } } or { imports: { '${mod}': {...} } }`)
  },

  // `===`/`!==` keep strict semantics (no coercion); emit folds a statically-known
  // type mismatch to false and otherwise shares the loose `==`/`!=` same-type path.
  // resolveTypeof still collapses `typeof x === 'type'` to a compile-time check.
  // Prep operands directly (not via `prep` on the node) so the strict op survives
  // to emit instead of re-dispatching this handler forever.
  '==='(a, b) { return prepStrictEq('===', a, b) },
  '!=='(a, b) { return prepStrictEq('!==', a, b) },

  // Short-circuit dead-arm elimination, value-exact: `A || B` with A never-falsy
  // IS A — B is unreachable; dual for `&&`. Both operands are prepped first so
  // policy checks still fire (same discipline as emit's literal-LHS fold, which
  // preps-then-skips); only the dead subtree is dropped from the program.
  '||'(a, b) { const pa = prep(a), pb = prep(b); return alwaysTruthy(pa) ? pa : ['||', pa, pb] },
  '&&'(a, b) { const pa = prep(a), pb = prep(b); return alwaysFalsy(pa) ? pa : ['&&', pa, pb] },

  // Statements
  ';': (...stmts) => {
    preRegisterBuiltinAliases(stmts)
    return [';', ...truncateUnreachable(stmts.map(prep).filter(x => x != null).map(dropDeadPostfix).map(foldConstIf).filter(x => x != null))]
  },
  'let': (...inits) => prepDecl('let', ...inits),
  'const': (...inits) => prepDecl('const', ...inits),

  // Block-scoped control flow: push scope for bodies so inner let/const shadows
  // correctly. Prescan accompanies EVERY push — a body can arrive as a bare
  // [';' …] list (post-jzify) that never routes through the '{}' handler, and
  // its decls must pre-register before traversal (forward closure refs; see
  // prescanBlockDecls). A '{}' body double-prescans harmlessly (its own frame
  // re-registers on top).
  'if': (cond, then, els) => {
    const c = prep(stripBoolNot(cond))
    pushScope(); prescanBlockDecls(then); const t = dropDeadPostfix(prep(then)); popScope()
    if (els != null) { pushScope(); prescanBlockDecls(els); const e = dropDeadPostfix(prep(els)); popScope(); return ['if', c, t, e] }
    return ['if', c, t]
  },
  'while': (cond, body) => {
    const c = prep(stripBoolNot(cond))
    pushScope()
    // See loopLocalNames' declaration — a module-scope while body's own
    // captured let/const needs the same per-iteration (not global) treatment
    // a for-loop's body gets above.
    const b = withLoopLocalNames(body, () => { prescanBlockDecls(body); return dropDeadPostfix(prep(body)) })
    popScope()
    return ['while', c, b]
  },
  // do { body } while (cond) → flag-guarded while: `flag=true; while (flag||cond) { flag=false; body }`.
  // jzify lowers this in default mode (jzify/transform.js), but strict mode skips jzify — without
  // this prepare-stage twin, strict `do-while` reaches emit as a raw 'do' and dies ("Unknown op: do"),
  // contradicting the README's strict-subset list. Re-prep the synthetic tree so scope/normalize apply.
  'do': (body, cond) => {
    const flag = `${T}do${freshPrepareId()}`
    return prep([';',
      ['let', ['=', flag, [null, true]]],
      ['while', ['||', flag, cond],
        ['{}', [';', ['=', flag, [null, false]], body]]]])
  },

  'export': decl => {
    if (Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const'))
      for (const i of decl.slice(1))
        if (Array.isArray(i) && i[0] === '=') {
          if (typeof i[1] === 'string') ctx.funcs.exports[i[1]] = true
          // `export let { a, b: c } = …` / `export let [x, y] = …` — every
          // BoundName of the declaration is an export (ES §16.2.3.2). Surfaced
          // by window-function's `export let { cos, sin, abs } = Math`.
          else if (isDestructPattern(i[1])) for (const n of bindingNames(i[1])) ctx.funcs.exports[n] = true
        }
    // export name → bare-identifier re-export (shorthand for `export { name }`).
    // Register the binding and emit nothing; without this the name falls through
    // to `prep(decl)` below and compiles as a dead `global.get; drop` statement
    // while the export itself is silently lost.
    if (typeof decl === 'string') {
      const resolved = ctx.scope.chain[decl]
      ctx.funcs.exports[decl] = (resolved && resolved !== decl) ? resolved : decl
      return null
    }
    // export { name, name as alias } from './mod' or export * from './mod'
    if (Array.isArray(decl) && decl[0] === 'from') {
      const mod = decl[2]?.[1]
      if (!mod || typeof mod !== 'string') return null
      // Source module re-export
      if (isBundledModule(mod)) {
        const resolved = prepareModule(mod, ctx.module.importSources?.[mod])
        if (decl[1] === '*') {
          // export * from './mod' → register all exports. A local export of the
          // same name shadows the star's (ES: star exports never override local
          // ones), whichever is declared first.
          for (const [name, mangled] of resolved.exports) {
            if (name !== 'default' && !(name in ctx.funcs.exports)) ctx.funcs.exports[name] = mangled
          }
        } else if (Array.isArray(decl[1]) && decl[1][0] === 'as' && decl[1][1] === '*' && typeof decl[1][2] === 'string') {
          // export * as ns from './mod' → the name is a namespace: an importer
          // binds it like `import * as ns` and resolves `ns.member` statically.
          ctx.funcs.exports[decl[1][2]] = resolved.exports
        } else if (Array.isArray(decl[1]) && decl[1][0] === '{}') {
          // export { a, b as c } from './mod'
          const inner = decl[1][1]
          if (inner == null) return null
          const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
          for (const item of items) {
            const name = typeof item === 'string' ? item : item[1]
            const alias = typeof item === 'string' ? item : item[2]
            const mangled = resolved.exports.get(name)
            if (!mangled) err(`'${name}' is not exported from '${mod}' — check the module's export list`)
            ctx.funcs.exports[alias] = mangled
          }
        }
      }
      return null
    }
    // export { name1, name2 as alias } → register named exports
    if (Array.isArray(decl) && decl[0] === '{}') {
      const inner = decl[1]
      if (inner == null) return null
      const items = Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]
      for (const item of items) {
        if (typeof item === 'string') {
          const resolved = ctx.scope.chain[item]
          ctx.funcs.exports[item] = (resolved && resolved !== item) ? resolved : item
        } else if (Array.isArray(item) && item[0] === 'as') {
          const [, source, alias] = item
          const resolved = ctx.scope.chain[source]
          ctx.funcs.exports[alias] = (resolved && resolved !== source) ? resolved : source
        }
      }
      return null
    }
    // export default expr → mark 'default' export, rewrite to assignment
    if (Array.isArray(decl) && decl[0] === 'default') {
      const val = decl[1]
      // export default name → export existing name as 'default'
      if (typeof val === 'string' && (hasFunc(val) || ctx.scope.globals.has(val))) {
        ctx.funcs.exports['default'] = val  // alias
        return null
      }
      // export default arrow → create function named 'default'
      ctx.funcs.exports['default'] = true
      if (Array.isArray(val) && val[0] === '=>') {
        if (defFunc('default', prep(val))) return null
      }
      // export default expr → create global 'default'
      declGlobal('default', 'f64')
      ctx.scope.userGlobals.add('default')
      return ['=', 'default', prep(val)]
    }
    return prep(decl)
  },

  // Arrow: don't prep params. Track depth for nested function detection.
  '=>': (params, body) => {
    if (prepState.depth > 0) { includeForCallableValue() }
    const raw = extractParams(params)
    // Owner id + serial counter FIRST: param mints (totality) belong to THIS
    // arrow's BindingId space, and the fnScope mapping must exist before any
    // default-value prep (a default may reference an earlier param).
    ownerStack.push(++prepState.ownerUniq)   // binding-owner id for this arrow (census scoping)
    renameSerial.push(0)
    const fnScope = new Map()
    for (const n of collectParamNames(raw)) fnScope.set(n, mintLocal(n))
    const pName = (n) => fnScope.get(n) ?? n

    prepState.depth++
    pushScope(fnScope)
    funcLocalNames.push(new Set(fnScope.values()))
    funcValueNames.push(new Set())

    const nextParams = []
    const bodyPrefix = []
    for (const r of raw) {
      const c = classifyParam(r)
      if (c[PARAM_KIND] === 'rest') {
        // A rest param is an array: the binding holds one, and every call site
        // builds the rest array via `['[', …]`. Pull in the array emitter even
        // when the body never names an array literal (e.g. `(...xs) => 0`),
        // otherwise the call-site rest construction hits "Unknown op: [".
        includeForArrayLiteral()
        if (typeof c[PARAM_NAME] === 'string' && !fnScope.has(c[PARAM_NAME])) fnScope.set(c[PARAM_NAME], mintLocal(c[PARAM_NAME]))
        censusUnknownInitDecl(pName(c[PARAM_NAME]))   // closure params: unknown-shape binding sites (see censusUnknownInitDecl)
        nextParams.push(typeof c[PARAM_NAME] === 'string' ? ['...', pName(c[PARAM_NAME])] : r)
      } else if (c[PARAM_KIND] === 'plain') {
        censusUnknownInitDecl(pName(c[PARAM_NAME]))
        nextParams.push(pName(c[PARAM_NAME]))
      } else if (c[PARAM_KIND] === 'default') {
        censusUnknownInitDecl(pName(c[PARAM_NAME]))
        nextParams.push(['=', pName(c[PARAM_NAME]), prep(c[PARAM_DEFAULT])])
      } else {
        const tmp = `${T}p${freshPrepareId()}`
        fnScope.set(tmp, tmp)
        nextParams.push(c[PARAM_KIND] === 'destruct-default' ? ['=', tmp, prep(c[PARAM_DEFAULT])] : tmp)
        bodyPrefix.push(prep(['let', ['=', c[PARAM_PATTERN], tmp]]))
      }
    }
    let preparedBody = prep(body)
    // An expression-bodied arrow returning an empty object literal — `() => ({})`
    // — preps to a bare `['{}']`, structurally identical to an empty block body.
    // The grouping `()` that marked it an expression is unwrapped by then, so
    // wrap it in an explicit `return` — otherwise downstream block/expression
    // classification (compile.js `isBlockBody`) misreads it as an empty block.
    if (!(Array.isArray(body) && body[0] === '{}')
        && Array.isArray(preparedBody) && preparedBody[0] === '{}' && preparedBody.length === 1)
      preparedBody = ['{}', [';', ['return', ['{}']]]]
    if (bodyPrefix.length) {
      const prefix = bodyPrefix.filter(x => x != null)
      if (Array.isArray(preparedBody) && preparedBody[0] === '{}' && Array.isArray(preparedBody[1]) && preparedBody[1][0] === ';')
        preparedBody = ['{}', [';', ...prefix, ...preparedBody[1].slice(1)]]
      else if (Array.isArray(preparedBody) && preparedBody[0] === '{}')
        preparedBody = ['{}', [';', ...prefix, preparedBody[1]]]
      else
        preparedBody = ['{}', [';', ...prefix, ['return', preparedBody]]]
    }
    const inner = nextParams.length === 0 ? null : nextParams.length === 1 ? nextParams[0] : [',', ...nextParams]
    const result = ['=>', Array.isArray(params) && params[0] === '()' ? ['()', inner] : inner, preparedBody]
    popScope()
    ownerStack.pop()
    renameSerial.pop()
    funcLocalNames.pop()
    funcValueNames.pop()
    prepState.depth--
    return result
  },

  // Switch reaches prepare only when jzify was skipped (strict / .jz): default
  // mode lowers every switch to the entry-index if-chain (jzify/switch.js). The
  // language table keeps `switch` in the jzify ring, not the strict canonical
  // subset — and the old native twin here mis-compiled `break` (no loop frame).
  'switch'() {
    return err('strict mode: `switch` is not in the canonical subset — use if/else chains (default mode lowers switch)')
  },

  // Optional chaining / typeof — need ptr module. Optional member access pulls
  // the same modules as plain `.`/`[]` (a method like `includes` needs string +
  // array for emit's runtime dispatch); the only difference is the nullish guard,
  // which is emit's concern. Without this, `obj?.m(…)` reaches emit missing the
  // `.m` emitter and falls to the dynamic path that needs an unincluded module.
  '?.'(obj, prop) { includeForProperty(prop); return ['?.', prep(obj), prop] },
  '?.[]'(obj, idx) { includeForArrayAccess(); return ['?.[]', prep(obj), prep(idx)] },
  '?.()'(callee, callArgs) {
    // Parser wraps multi-args in a comma list, like '()'. Unwrap so emit gets flat positional args.
    const items = callArgs == null ? []
      : Array.isArray(callArgs) && callArgs[0] === ',' ? callArgs.slice(1)
      : [callArgs]
    return ['?.()', prep(callee), ...items.map(prep)]
  },
  // Boolean literals NaN-box as f64 — typeof at runtime returns 'number'. Fold here so the JS-spec value survives.
  // Unresolvable bare refs fold to 'undefined' via staticTypeofString (spec §13.5.3) —
  // the only place a stray identifier doesn't ReferenceError.
  'typeof'(a) {
    if (Array.isArray(a) && a[0] == null && typeof a[1] === 'boolean') { includeForStringOnly(); return ['str', 'boolean'] }
    const known = staticTypeofString(a)
    if (known != null) { includeForStringOnly(); return ['str', known] }
    return ['typeof', prep(a)]
  },

  // Unary +/- disambiguation
  '+'(a, b) {
    if (b === undefined) {
      const na = prep(a)
      // `isLit` (op===null) already excludes a bigint literal — it's the
      // distinct `['bigint', decimalStr]` node (parse.js), never
      // this shape — so no subnormal-magnitude guard is needed here anymore:
      // a literal reaching this branch is unambiguously a genuine NUMBER.
      // The surviving `u+` (bigint operand) lets emit raise the BigInt
      // TypeError (native) or coerce at runtime (kernel).
      if (isLit(na) && typeof na[1] === 'number') return na
      includeForNumericCoercion()
      return ['u+', na]
    }
    const pa = prep(a), pb = prep(b)
    // Compile-time fold of literal string concat. The combined bytes flow
    // through the `str` emitter as a single literal — SSO if ≤4 ASCII (zero
    // heap), otherwise one dataDedup entry (still cheaper than runtime
    // __str_concat_raw + heap alloc). Bottom-up, so `'a' + 'b' + 'c'` folds
    // left-associatively into one literal.
    if (Array.isArray(pa) && pa[0] === 'str' && typeof pa[1] === 'string' &&
        Array.isArray(pb) && pb[0] === 'str' && typeof pb[1] === 'string') {
      return ['str', pa[1] + pb[1]]
    }
    return ['+', pa, pb]
  },
  '-'(a, b) {
    // Fold `-<numeric literal>` to a literal. A bigint literal is a distinct
    // `['bigint', decimalStr]` node (parse.js) — `isLit` (op===null)
    // already excludes it structurally, so no bigint-vs-number ambiguity
    // reaches here at all (native or self-compiled alike); bigint negation flows
    // through the `u-` runtime path below to emit's i64.sub(0,·).
    // `-0` is NOT folded: the self-compile kernel evaluates the constant `-na[1]` with
    // i32 negation (i32 has no signed zero), collapsing -0→+0 — observable via sort's
    // -0<+0 tiebreak, Object.is, and 1/x. Leaving it as a runtime `u-` emits f64.neg,
    // which preserves the sign in both engines; V8 re-folds it, so no native cost.
    if (b === undefined) {
      const na = prep(a)
      return isLit(na) && typeof na[1] === 'number' && na[1] !== 0 ? [, -na[1]] : ['u-', na]
    }
    return ['-', prep(a), prep(b)]
  },

  // Ternary: parser emits '?' not '?:'
  '?'(cond, then, els) { return ['?:', prep(stripBoolNot(cond)), prep(then), prep(els)] },

  // ++/-- prefix vs postfix: parser sends trailing null for postfix
  // Postfix i++ = (++i) - 1: increment happens, arithmetic recovers old value.
  // Property obj.prop++ has no dedicated ++ node (the ++ emitter is name-based),
  // so it lowers to `obj.prop = <'+1'|'-1'> obj.prop` — a DEDICATED unary op
  // (not the spelled-out `obj.prop + 1`) meaning exactly "the operand,
  // incremented/decremented by one, in whatever kind it already is" (kind-
  // preserving, see kind.js VT['+1']/VT['-1'] — the member sibling of the
  // '++'/'--' unary rule already used for bare names). Deliberately NOT the
  // binary `['+', n, [,1]]` shape a genuine `obj.p += 1` ALSO desugars to (at
  // emit time) — that shape is structurally ambiguous (bigintMixReject can't
  // tell "prepare's own correction constant" apart from "user wrote += 1",
  // and only one of them may bypass the BigInt/Number mix check), whereas
  // `'+1'`/`'-1'` is an op no parser or other pass ever produces, so it is
  // unambiguously ours. The outer ∓1 postfix-recovery wrapper keeps the plain
  // literal shape (`['-', inc, [,1]]`) — same permissive-by-construction
  // bypass the bare-name postfix recovery already uses just below in emit.js
  // (isPostfix), since only prepare's OWN transform can nest an assignment
  // there.
  '++'(a, _post) {
    const n = prep(a)
    const inc = Array.isArray(n) && (n[0] === '.' || n[0] === '[]') ? ['=', n, ['+1', n]] : ['++', n]
    return _post !== undefined ? ['-', inc, [, 1]] : inc
  },
  '--'(a, _post) {
    const n = prep(a)
    const dec = Array.isArray(n) && (n[0] === '.' || n[0] === '[]') ? ['=', n, ['-1', n]] : ['--', n]
    return _post !== undefined ? ['+', dec, [, 1]] : dec
  },

  // Regex literal: ['//','pattern','flags?'] → include regex module, pass through
  '//'(pattern, flags) {
    return ['//', pattern, flags]
  },

  '**'(a, b) {
    // ES2016 §13.6: an unparenthesized unary expression cannot be the base of `**`
    // — `-x**2`, `~x**2`, `!x**2`, `+x**2`, `typeof x**2`, `void x**2`, `delete o[k]**2`
    // are all SyntaxErrors (the precedence is ambiguous). The parser leaves a grouping
    // as `['()', …]`, so a parenthesized base `(-x)**2` (and `-(x**2)`, where the unary
    // sits outside the `**`) arrives with a non-unary root op and is allowed.
    if (Array.isArray(a) && a.length === 2 && (a[0] === '-' || a[0] === '+' || a[0] === '!' || a[0] === '~' || a[0] === 'typeof' || a[0] === 'void' || a[0] === 'delete'))
      err(`Unary '${a[0]}' before '**' is a SyntaxError (ES2016 §13.6) — parenthesize: (${a[0]} x) ** 2 or ${a[0]} (x ** 2)`)
    return ['**', prep(a), prep(b)]
  },

  // Function call or grouping parens
'()'(callee, ...args) {
    // Grouping: (expr) → ['()', expr] with no args. Call: f() → ['()', 'f', null] with null arg.
    if (args.length === 0) return prep(callee)
    if (typeof callee === 'string' && REJECT_IDENTS[callee]) err(REJECT_IDENTS[callee])

    // Compile-time folds: the callee names something resolvable now. Each fold
    // is gated by callee shape, so at most one of the three fires.
    const folded = foldImportMetaResolve(callee, args)
      ?? dispatchConstructorCall(callee, args)
      ?? foldNamespaceIntrospection(callee, args)
      ?? foldFnCallApplyBind(callee, args)
      ?? foldPrototypeBorrow(callee, args)
      ?? foldJsonReviver(callee, args)
    if (folded !== undefined) return folded

    callee = resolveCallee(callee, args)
    args = renestSoleCommaArg(args)

    const preppedArgs = args.filter(a => a != null).map(prep)
    for (const a of preppedArgs) {
      if (typeof a === 'string' && hasFunc(a)) {
        includeForCallableValue(); break
      }
    }
    // A zero-arg call keeps its explicit `null` args slot: `['()', callee, null]`,
    // not the slot-less `['()', callee]`. The latter is indistinguishable from a
    // grouping `(expr)`, so a second `prep` pass (the destructuring-assignment
    // lowering re-`prep`s its result) would re-read `x.pop()` as the grouping
    // `(x.pop)` and drop the call. Keeping the slot makes `prep` idempotent for
    // calls and matches `setCallArgs`'s canonical shape; `commaList(node[2])`
    // reads it back as zero args everywhere downstream.
    // Object.freeze is identity in jz (frozenness is not modeled — the emitter
    // returns its operand unchanged, module/object.js). Fold the CALL away so
    // the operand's static knowledge survives the wrapper: a frozen literal
    // binding keeps its schema (slot dispatch), and `TABLE[2]` on a frozen
    // preset table resolves statically instead of falling to the untyped
    // element dispatch. `Object.freeze` as a value (`arr.map(Object.freeze)`)
    // is not a call form and keeps the runtime emitter.
    if (callee === 'Object.freeze' && preppedArgs.length === 1 && preppedArgs[0] != null) {
      // Record the (prepared, post-rename) binding so Object.isFrozen answers
      // true for it — consistency, not enforcement (writes are not trapped).
      if (typeof preppedArgs[0] === 'string') (ctx.runtime.frozenVars ??= new Set()).add(preppedArgs[0])
      return preppedArgs[0]
    }

    const result = preppedArgs.length ? ['()', callee, ...preppedArgs] : ['()', callee, null]

    if (callee === 'Object.assign' && ctx.schema.register) inferAssignSchema(result)

    // `S.push(…)` / `S.sort()` / … mutate the receiver — end its static-array
    // fact before any later fold consumes the pre-mutation values.
    if (Array.isArray(callee) && callee[0] === '.' && MUTATING_ARRAY_METHODS.has(callee[2]))
      invalidateMutatedArray(callee[1])

    return result
  },

  // Array literal/indexing — auto-include ptr + array modules
  '[]'(...args) {
    if (args.length === 1) {
      const inner = args[0]
      includeForArrayLiteral()
      if (inner == null) return ['[']
      // jessie consumes the trailing comma itself; every remaining `null` in the
      // element list is a genuine elision (`[,]` → length 1, `[1,,]` → length 2).
      if (Array.isArray(inner) && inner[0] === ',') { const items = inner.slice(1); return ['[', ...items.map(item => item == null ? [, undefined] : prep(item))] }
      return ['[', prep(inner)]
    }
    if (typeof args[0] === 'string' && ctx.module.namespaces?.[args[0]]) {
      includeForStringOnly()
      const key = prep(args[1])
      const exports = [...ctx.module.namespaces[args[0]].entries()]
      let fallback = [, undefined]
      for (let i = exports.length - 1; i >= 0; i--) {
        const [name, resolved] = exports[i]
        fallback = ['?:', ['==', key, ['str', name]], resolved, fallback]
      }
      return fallback
    }
    includeForArrayAccess()
    return ['[]', prep(args[0]), prep(args[1])]
  },

  // Bare block statement: push scope for let/const shadowing
  '{'(inner) {
    pushScope()
    prescanBlockDecls(inner)
    const result = ['{', prep(inner)]
    popScope()
    return result
  },

  // Object literal - flatten comma, expand shorthand
  '{}'(...args) {
    const inner = args[0]
    // Block body: a single statement-op child (object props always start with
    // ':' or '...', never a statement op, so this never misfires on a literal).
    if (args.length === 1 && Array.isArray(inner) && STMT_OPS.has(inner[0])) {
      // Block body: push block scope for let/const shadowing
      pushScope()
      prescanBlockDecls(inner)
      const result = ['{}', prep(inner)]
      popScope()
      return result
    }

    includeForObjectLiteral()
    if (args.length === 0 || inner == null) return ['{}']
    // The parser emits one comma-grouped child `['{}', [',', p1, p2]]`, but prep's
    // own output is spread `['{}', p1, p2]` (see `result` below). Accept both so
    // prep stays idempotent: the destructuring-assignment lowering ('=' handler)
    // re-preps a wrapper that already holds a normalized literal, and reading only
    // the first child here would drop every property but the first — mis-sizing the
    // schema to cap-1 and losing the rest.
    const items = args.length === 1
      ? (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner])
      : args

    // Duplicate data keys must still evaluate EVERY overwritten initializer in
    // source order. Collapsing directly to the last value loses effects; folding
    // old values into the winning property's expression reorders them across
    // intervening properties. Lower the simple data-property case to an arrow
    // whose ONE object argument stages all values left-to-right, then build the
    // final first-position/last-value object from unique temporary fields. One
    // aggregate argument avoids tying legal object size to MAX_CLOSURE_ARITY.
    // Spreads/computed keys need ordered property-definition IR and follow below.
    const rawKey = p => typeof p === 'string' ? p
      : Array.isArray(p) && p[0] === ':'
        ? (typeof p[1] === 'string' ? p[1] : staticPropertyKey(p[1]))
        : null
    const keyCounts = new Map()
    for (const p of items) {
      const key = rawKey(p)
      if (key != null) keyCounts.set(key, (keyCounts.get(key) || 0) + 1)
    }
    if ([...keyCounts.values()].some(n => n > 1)) {
      if (items.some(p => rawKey(p) == null))
        err('duplicate object keys mixed with spread/computed properties are unsupported — jz can\'t reorder the duplicate\'s side effects around a spread/computed key; keep one static occurrence per key, or move the repeated writes to explicit assignments after the literal')
      const staged = `${T}od${freshPrepareId()}`
      const last = new Map(), order = []
      for (let i = 0; i < items.length; i++) {
        const key = rawKey(items[i])
        if (!last.has(key)) order.push(key)
        last.set(key, i)
      }
      const valueNames = items.map((_, i) => `${T}odv${i}`)
      const props = order.map(key => [':', key, ['.', staged, valueNames[last.get(key)]]])
      const values = items.map((p, i) => [':', valueNames[i], typeof p === 'string' ? p : p[2]])
      const valuesNode = ['{}', [',', ...values]]
      return prep(['()', ['=>', ['()', staged], ['{}', [',', ...props]]], valuesNode])
    }

    // Computed keys: fixed schemas cannot name them, so build one empty object
    // and perform EVERY property definition in original source order. The old
    // lowering constructed all static properties first and appended computed
    // assignments afterwards, reordering both effects and key insertion:
    // `{[key()]: value(), a: later()}` ran later() before key()/value().
    // Spread positions use Object.assign on that same accumulator, preserving
    // CopyDataProperties' ordering relative to adjacent computed/static writes.
    const isComputed = p => Array.isArray(p) && p[0] === ':'
      && typeof p[1] !== 'string' && staticPropertyKey(p[1]) == null
    if (items.some(isComputed)) {
      const tmp = `${T}o${freshPrepareId()}`
      const assigns = items.map(p => {
        if (Array.isArray(p) && p[0] === '...')
          return ['()', ['.', 'Object', 'assign'], [',', tmp, p[1]]]
        if (typeof p === 'string') return ['=', ['[]', tmp, ['str', p]], p]
        if (Array.isArray(p) && p[0] === ':') {
          const staticKey = typeof p[1] === 'string' ? p[1] : staticPropertyKey(p[1])
          if (staticKey != null) return ['=', ['[]', tmp, ['str', staticKey]], p[2]]
          const keyExpr = Array.isArray(p[1]) && p[1][0] === '[]' ? p[1][1] : p[1]
          return ['=', ['[]', tmp, keyExpr], p[2]]
        }
        if (Array.isArray(p) && (p[0] === 'get' || p[0] === 'set'))
          err('object getter/setter not supported — jz objects have no accessors; use a method or a plain property + function')
        err(`unsupported property in computed-key object literal: ${JSON.stringify(p)} — use a \`key: value\` pair, a spread, or a getter/setter only`)
      })
      return prep(['()', ['=>', ['()', tmp], [',', ...assigns, tmp]], ['{}']])
    }

    // Process properties: shorthand 'x' → [':', 'x', 'x'], or [':', key, val] → prep val only
    const prop = p => {
      if (typeof p === 'string') return [':', p, prep(p)]
      if (Array.isArray(p) && p[0] === ':') {
        const key = typeof p[1] === 'string' ? p[1] : staticPropertyKey(p[1])
        if (key == null) err('computed property name not supported for fixed-shape object: use a compile-time string/number key')
        return [':', key, prep(p[2])]
      }
      // Accessors (`{ get x() {…} }` / `{ set x(v) {…} }`) parse to ['get'|'set', …].
      // jz objects are fixed-shape slot records with no accessor protocol, so they'd
      // otherwise fall through and compile to dead code (0 schema slots → `o.x` reads
      // undefined). Reject loudly — silent miscompile breaks "valid jz = valid JS".
      if (Array.isArray(p) && (p[0] === 'get' || p[0] === 'set'))
        err('object getter/setter not supported — jz objects have no accessors; use a method or a plain property + function')
      return prep(p)
    }
    let prepped = items.map(prop)
    const result = ['{}', ...prepped]
    // Register schema so property access works for function params (duck typing)
    const props = result.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
    if (props.length && ctx.schema.register) ctx.schema.register(props)
    return result
  },

  // For loop
  'for'(head, body) {
    // ES §14.7.4.7 CreatePerIterationEnvironment: a `let` declared in a classic
    // for-HEAD gets a FRESH binding each iteration when closures capture it —
    // `for (let i…) fns.push(() => i)` must capture 0,1,2, not the final value.
    // Lower to the copy-in/copy-out shape (only when a body arrow actually
    // references the head var — pay-per-capture):
    //   for (let __i = 0; __i < n; __i++) { let i = __i; …body…; __i = i }
    // The body-`let` then rides the existing per-iteration fresh-cell machinery
    // (emitLoopFreshBoxed). Known edge, accepted: a closure inside the COND or
    // STEP itself captures the carrier, not the per-iteration binding.
    if (Array.isArray(head) && head[0] === ';' && Array.isArray(head[1]) && head[1][0] === 'let') {
      const captured = []
      for (let i = 1; i < head[1].length; i++) {
        const d = head[1][i]
        const nm = typeof d === 'string' ? d : (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' ? d[1] : null)
        if (nm && bodyCapturesName(body, nm)) captured.push(nm)
      }
      if (captured.length) {
        const carrier = new Map(captured.map(n => [n, `${n}${T}pi${freshPrepareId()}`]))
        const renamed = (n) => substIdents(n, carrier)
        const decl = ['let', ...head[1].slice(1).map(d => {
          if (typeof d === 'string') return carrier.get(d) ?? d
          if (Array.isArray(d) && d[0] === '=' && carrier.has(d[1])) return ['=', carrier.get(d[1]), d[2]]
          return d
        })]
        const newHead = [';', decl, renamed(head[2]), renamed(head[3]), ...head.slice(4).map(renamed)]
        const copyIn = ['let', ...captured.map(n => ['=', n, carrier.get(n)])]
        const copyOut = captured.map(n => ['=', carrier.get(n), n])
        const newBody = ['{}', [';', copyIn, body, ...copyOut]]
        return handlers['for'](newHead, newBody)
      }
    }
    pushScope()
    // NOTE: no prescan here for for-of/for-in heads — they LOWER and re-enter
    // this handler as a classic for, whose branch below prescans the lowered
    // inner list in ITS frame (prescanning the raw body here would mint into
    // this frame while the decls re-mint in the re-entered one — dangling refs).
    // A comma/sequence Expression in a for-IN head RHS — `for (x in a, b)` — is valid (the RHS is
    // an Expression): evaluate left-to-right for side effects, value as the last element. (for-OF's
    // RHS is an AssignmentExpression — no comma — so it is left alone.) subscript ≥10.5.1 parses
    // the head re-associated, landing a bare `,` node in the source slot. Don't wrap it in `()`:
    // Object.keys((a, obj))
    // hides `obj` behind the sequence and loses its static schema (a non-escaping literal
    // scalarizes → 0 keys). Instead take the LAST element as the (direct) iteration source and run
    // the earlier elements once first.
    let forInSeqPre = null
    if (Array.isArray(head) && head[0] === 'in' && Array.isArray(head[2]) && head[2][0] === ',') {
      const parts = head[2].slice(1)
      head = [head[0], head[1], parts[parts.length - 1]]
      if (parts.length > 2) forInSeqPre = [',', ...parts.slice(0, -1)]
      else if (parts.length === 2) forInSeqPre = parts[0]
    }
    let r
    if (Array.isArray(head) && head[0] === ';') {
      // ES §14.7.4.7 module-scope per-iteration bindings: a depth-0 loop's OWN
      // body-declared let/const (the for-of/for-in desugared bind landed in
      // `body` by the branches below, or the for-head captured-let copy-in
      // above, or an ordinary body-scoped `let`) that a nested closure
      // captures must NOT take declareGlobal's single-instance global path —
      // see loopLocalNames' declaration for the full rationale. Detected and
      // marked BEFORE prescanBlockDecls (which consults the set to decide
      // mint-vs-identity), pay-per-capture like the for-head sibling above:
      // an uncaptured loop var keeps the cheaper global.
      let addedLoopLocals = null
      if (prepState.depth === 0) {
        for (const nm of collectLoopDeclNames(body)) {
          if (!loopLocalNames.has(nm) && bodyCapturesName(body, nm)) {
            (addedLoopLocals ||= []).push(nm)
            markLoopLocal(nm)
          }
        }
      }
      prescanBlockDecls(body)
      let [, init, cond, step] = head
      cond = stripBoolNot(cond)
      // Keep a `.length` / `.size` / `.byteLength` for-bound i32 without snapshotting it:
      //   `i < arr.length` → `i < (arr.length | 0)`   (re-read every iteration)
      // The `| 0` forces i32 even for unknown-typed receivers (where __length returns
      // f64), so the counter `i` stays i32 through the comparison and `i++` — no
      // per-iteration f64.convert_i32_s + f64.lt + f64.add + i32.trunc_sat round-trip.
      // It must stay INLINE, not hoisted into a pre-loop local: JS re-reads the bound
      // each step, and a loop body can grow/shrink the array mid-iteration — including
      // through an alias the compiler can't see locally (e.g. `arr` shares identity with
      // a field a called helper pushes to, as compilePendingClosures does over
      // ctx.closure.bodies). A snapshot diverges from JS and silently truncates such loops.
      if (cond && Array.isArray(cond) && (cond[0] === '<' || cond[0] === '<=' || cond[0] === '>' || cond[0] === '>=')) {
        const lenExpr = cond[0] === '<' || cond[0] === '<=' ? cond[2] : cond[1]
        if (Array.isArray(lenExpr) && lenExpr[0] === '.' &&
            (lenExpr[2] === 'length' || lenExpr[2] === 'size' || lenExpr[2] === 'byteLength')) {
          const recv = lenExpr[1]
          const bound = ['|', lenExpr, [, 0]]
          const lengthStable = typeof recv === 'string' &&
            boundSafeCalls(body) && boundSafeCalls(step) && !writesReceiver(body, recv) && !writesReceiver(step, recv)
          if (lengthStable) {
            // Body can't change the bound → snapshot it once into an i32 local. Keeps
            // the counter `i` i32 through compare + `i++` (no per-iteration f64 round
            // trip) and gives the vectorizer the hoisted trip count it matches on.
            const lenVar = `${T}len${freshPrepareId()}`
            const lenDecl = ['let', ['=', lenVar, bound]]
            init = init ? [';', init, lenDecl] : lenDecl
            if (cond[0] === '<' || cond[0] === '<=') cond = [cond[0], cond[1], lenVar]
            else cond = [cond[0], lenVar, cond[2]]
          } else {
            // Body may grow/shrink the array (push/pop, or alias mutation through a
            // call) → re-read every iteration, as JS does. Still `| 0` for an i32 bound.
            if (cond[0] === '<' || cond[0] === '<=') cond = [cond[0], cond[1], bound]
            else cond = [cond[0], bound, cond[2]]
          }
        }
      }
      r = ['for', init ? prep(init) : null, cond ? prep(cond) : null, step ? dropDeadPostfix(prep(step)) : null, dropDeadPostfix(prep(body))]
      if (addedLoopLocals) for (const nm of addedLoopLocals) loopLocalNames.delete(nm)
    } else if (Array.isArray(head) && head[0] === 'of') {
      // for (let x of arr) → hoist arr (if non-trivial) and arr.length once, iterate by index.
      // Divergence from JS: mutating arr during iteration won't extend/shorten the loop.
      // jz philosophy: explicit > implicit; mutation during iteration is a code smell.
      const [, decl, src] = head
      const isDeclHead = Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const')
      // `for ((x) of …)` — unwrap a cover-parenthesized target (mirrors for-in).
      let ofLhs = decl; while (Array.isArray(ofLhs) && ofLhs[0] === '()' && ofLhs.length === 2) ofLhs = ofLhs[1]
      const varName = isDeclHead ? decl[1] : ofLhs
      const idx = `${T}i${freshPrepareId()}`
      const lenVar = `${T}len${freshPrepareId()}`
      const arrVar = `${T}arr${freshPrepareId()}`
      // Normalize the source to an index-iterable once: a Set→keys / Map→[k,v]
      // array, while an Array/String/TypedArray passes through untouched (no
      // copy). Without this, `coll[i]` on a Set/Map reads raw open-addressing
      // slot words instead of live entries.
      // Wrap .length in `| 0` so the hoisted bound is i32 even for unknown
      // receivers (same rationale as the for-cond hoist above).
      const lenE = ['|', ['.', arrVar, 'length'], [, 0]]
      const decls = ['let', ['=', arrVar, ['()', '__iter_arr', src]], ['=', idx, [, 0]], ['=', lenVar, lenE]]
      const cond = ['<', idx, lenVar]
      const step = ['++', idx]
      // Decl head (`for (let x of …)`) takes a fresh per-iteration binding;
      // ASSIGNMENT head (`for (x of …)`, `for ([a] of …)`, `for (o.x of …)`,
      // var-hoisted heads) must assign the EXISTING target — a `let` wrap
      // shadowed it, so after-loop reads saw the stale outer value.
      const bindStmt = isDeclHead
        ? ['let', ['=', varName, ['[]', arrVar, idx]]]
        : ['=', varName, ['[]', arrVar, idx]]
      const inner = [';', bindStmt, body]
      r = prep(['for', [';', decls, cond, step], inner])
    } else if (Array.isArray(head) && head[0] === 'in') {
      // `for…in` relies on runtime key enumeration — outside the pure canonical subset. strict
      // rejects it (consistent with `obj[k]` / unknown-receiver methods); use `Object.keys(obj)`.
      if (ctx.transform.strict) err('strict mode: `for…in` is not in the canonical subset — it relies on runtime key enumeration. Iterate `Object.keys(obj)` explicitly instead.')
      // for (let k in src) → enumerate src's own keys via Object.keys (schema ∪ any keys added
      // later for objects; "0".."n-1" for arrays/strings; [] for Set/Map) and iterate the resulting
      // array by index. One uniform path keeps for-in consistent with Object.keys (so dynamically
      // added keys appear in both), and break/continue work as in any for-loop. Object.keys'
      // enumeration stdlib is pulled only when for-in is actually used.
      const [, decl, src] = head
      const isDecl = Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const')
      // `for ((x) in …)` — the LHS may be a cover-parenthesized identifier; unwrap to the target.
      let lhs = decl; while (Array.isArray(lhs) && lhs[0] === '()') lhs = lhs[1]
      const target = isDecl ? decl[1] : lhs
      // A member/computed LHS (`for (x.y in …)`, `for (obj[k] in …)`) assigns each key into the
      // existing place; let/const and a bare name take a fresh per-iteration `let` binding.
      const isMemberTarget = Array.isArray(target) && (target[0] === '.' || target[0] === '[]')
      // for-in over null/undefined is a no-op — ES ForIn/OfHeadEvaluation returns a break
      // completion before enumerating — but Object.keys(null|undefined) throws. So a nullish
      // source must enumerate the empty set. A static null (`[null,null]`) / undefined (`[]`)
      // skips Object.keys entirely; a bare identifier is guarded by a runtime `== null` test
      // (evaluated twice — side-effect-free — keeping Object.keys' *direct* receiver so its
      // static key schema still resolves); object/array literals and other expressions, which
      // are never nullish or carry no static schema to lose, stay direct.
      // A nullish literal node is `[<nullish-op>, value]` with both slots nullish: `null` is
      // `[null, null]`, `undefined` is `[null]` (empty value slot). A numeric/string literal
      // `[null, v]` has a non-nullish value slot, so `src[1] == null` discriminates them.
      const nullish = Array.isArray(src) && src[0] == null && src[1] == null
      // `__keys_ro` is for-in's read-only key list: identical to Object.keys, but
      // when the receiver has a complete static schema the keys are a compile-time
      // constant, so it pools ONE static-data array instead of allocating a fresh
      // one each evaluation — the per-iteration heap-growth cliff (jz#deopt-forin).
      // Sound only because for-in reads ks[i]/ks.length and never mutates (unlike
      // user Object.keys, which permits in-place `.sort()`/`.reverse()`).
      includeMods('core', 'object', 'string')
      const keysExpr = nullish ? ['[]', null]
        : typeof src === 'string'
          ? ['?', ['==', src, [null, null]], ['[]', null], ['()', '__keys_ro', src]]
          : ['()', '__keys_ro', src]
      const ks = `${T}fik${freshPrepareId()}`, ix = `${T}fii${freshPrepareId()}`, lenV = `${T}fil${freshPrepareId()}`
      const decls = ['let',
        ['=', ks, keysExpr],
        ['=', ix, [, 0]],
        ['=', lenV, ['|', ['.', ks, 'length'], [, 0]]]]
      // Assignment-form bare name that resolves NOWHERE (`for (k in o)` /
      // `for (let in {})` with k undeclared — sloppy JS mints an implicit
      // global): declare it in the loop's own decls so the binding exists at
      // every opt level (emit otherwise leaks watr's "Unknown local $k"; O2
      // only masked it by constant-propagating the name away). Loop-scoped
      // rather than JS's implicit global (documented subset divergence). Only
      // this structural write-only binder mints — a general write-legalization
      // in emit let undeclared READS resolve (test262 ReferenceError pins).
      if (!isMemberTarget && !isDecl && typeof target === 'string'
          && !isDeclared(target) && !hasFunc(target) && !ctx.scope.userGlobals?.has?.(target))
        decls.push(['=', target, [null]])
      // Member targets AND assignment-form bare names (`for (k in o)`) assign
      // the existing binding — a `let` wrap shadowed the outer k, so after-loop
      // reads saw the stale value. Only decl heads take a fresh binding.
      const bindEach = isMemberTarget || !isDecl
        ? ['=', target, ['[]', ks, ix]]              // x.y = key / k = key (existing binding)
        : ['let', ['=', target, ['[]', ks, ix]]]     // let k = key  (fresh per-iteration binding)
      const forNode = ['for', [';', decls, ['<', ix, lenV], ['++', ix]],
        [';', bindEach, body]]
      // Run the dropped sequence prefix (earlier comma elements) once for side effects, before
      // the loop. Built raw and prepped as a unit so prep inserts the value-drop on the prefix.
      r = prep(forInSeqPre ? [';', forInSeqPre, forNode] : forNode)
    } else {
      // Some parser/jzify shapes for `for (;;)` and `for (; cond; )` arrive
      // as a null or bare-condition head instead of the canonical
      // `[';', init, cond, step]` tuple. Normalize them before emit so they
      // remain ordinary for-loops, not malformed two-slot nodes.
      r = ['for', null, head == null ? null : prep(head), null, prep(body)]
    }
    popScope()
    return r
  },

  // Property access - resolve namespaces or object/array properties
  '.'(obj, prop) {
    prop = typeof prop === 'string' ? prop : staticPropertyKey(prop)
    // `.caller`/`.callee` on a function value (or `arguments`) are deprecated
    // stack introspection — prohibited as bad practice. On a plain data object
    // they are ordinary field names (e.g. an ESTree call node's `.callee`), so
    // the ban keys off a known-function receiver, not the bare property name.
    // funcValueNames holds POST-RENAME binding keys (totality) — resolve the
    // receiver spelling through scopes before the membership check.
    const objKey = typeof obj === 'string' && scopes.length && isDeclared(obj) ? resolveScope(obj) : obj
    // A receiver that's ITSELF a `.` read of 'then'/'catch'/'finally' off a
    // KNOWN Promise instance, or 'resolve'/'reject' off a KNOWN
    // Promise.withResolvers() result (promiseRecvNames/withResolversRecvNames
    // — their own declaration above has the full mechanism) is ALSO provably
    // function-valued: `p.then.length` / `instance.resolve.name` fell through
    // the same silent-wrong-value gap a directly bound closure name's OWN
    // `.length` used to, before hasFunc/isFuncValueLocal below closed THAT
    // case. Resolves obj[1] the same way objKey does, just one level deeper.
    const isPromiseHelperPropRecv = Array.isArray(obj) && (obj[0] === '.' || obj[0] === '?.') && typeof obj[1] === 'string' && (() => {
      const recv = scopes.length && isDeclared(obj[1]) ? resolveScope(obj[1]) : obj[1]
      return (promiseRecvNames.has(recv) && (obj[2] === 'then' || obj[2] === 'catch' || obj[2] === 'finally')) ||
        (withResolversRecvNames.has(recv) && (obj[2] === 'resolve' || obj[2] === 'reject'))
    })()
    const isFuncValueRecv = obj === 'arguments' || hasFunc(objKey) || isFuncValueLocal(objKey) || isPromiseHelperPropRecv
    if (isFuncValueRecv && (prop === 'caller' || prop === 'callee'))
      err('`.caller`/`.callee` are prohibited: deprecated function stack introspection — jz has no equivalent; pass what you need as an explicit argument instead')
    // `.length`/`.name` on a function VALUE is real ECMAScript function-object
    // reflection (own data properties every Function instance carries) — jz
    // compiles a closure/named function straight to a WASM func with no
    // metadata object behind it, so there is nothing to read. Confirmed live
    // as a silent wrong value, not a reject: `((a,b)=>a+b).length` and a
    // named `function f(a,b){}`'s `f.length` both read plain `undefined`
    // instead of `2`. Same class, same remedy as `.caller`/`.callee` just
    // above — reject rather than guess.
    if (isFuncValueRecv && (prop === 'length' || prop === 'name'))
      err(`.${prop} is not supported on a function value — jz compiles closures/named functions straight to WASM funcs with no reflectable metadata object; jz has no general function-object reflection`)
    if (prop === 'url' && isImportMeta(obj)) return staticString(importMetaUrl())
    // A user binding named like a builtin namespace (`let Math = {…}`) shadows it
    // — read the property off the local value, not the builtin namespace table.
    if (shadowsBuiltin(obj)) { includeForProperty(prop); return ['.', prep(obj), prop] }
    // Function-scoped namespace aliases resolve here too (namespaceModOf) — the
    // module-level chain alone missed `const M = Math; M.sqrt` inside a body.
    const mod = namespaceModOf(obj)
    // Only treat as module namespace if it's a known built-in module (not a mangled import name)
    if (mod) {
      includeModule(mod)
      const key = mod + '.' + prop
      if (emitArity(ctx.core.emit[key]) > 0) includeForCallableValue()
      return key
    }
    // `Namespace.method.length`/`.name` — the OUTER `.` here has a receiver
    // that's ITSELF a `.` node resolving to a builtin function (`Array.isArray`,
    // `Math.sqrt`, …); same function-object-reflection gap as the bound-name
    // case above, just reached through a namespace member instead of a local.
    // Confirmed live: `Array.isArray.length` reads `undefined`, not `1`.
    // NS_CTORS name check (static, module-load-order-independent) rather than
    // an `emitArity(ctx.core.emit[...])` probe: a builtin static method
    // reached ONLY through property reflection (never actually CALLED, as
    // here) hasn't necessarily triggered that method's owning module include
    // yet, so its emit-table entry may not exist AT THIS POINT even though
    // the call would resolve fine once reached — the arity probe would
    // silently miss exactly the shape being guarded against.
    if ((prop === 'length' || prop === 'name') && Array.isArray(obj) && obj[0] === '.' &&
        typeof obj[1] === 'string' && typeof obj[2] === 'string' && NS_CTORS.has(obj[1]) &&
        !shadowsBuiltin(obj[1]) && !(scopes.length && isDeclared(obj[1])))
      err(`.${prop} is not supported on a function value — jz compiles builtins straight to WASM funcs with no reflectable metadata object; jz has no general function-object reflection`)
    // Source module namespace: import * as X → X.prop resolved to mangled name
    if (typeof obj === 'string' && ctx.module.namespaces?.[obj]) {
      const mangled = ctx.module.namespaces[obj].get(prop)
      if (mangled) return mangled
    }
    includeForProperty(prop)
    return ['.', prep(obj), prop]
  },

  // new - auto-import modules, resolve constructors
  'new'(ctor, ...args) {
    let name = ctor, ctorArgs = args
    if (Array.isArray(ctor) && ctor[0] === '()') { name = ctor[1]; ctorArgs = ctor.slice(2) }
    while (Array.isArray(name) && name[0] === '()' && name.length === 2) name = name[1]
    const builtinCtor = typeof name === 'string' && !shadowsBuiltin(name)
    // No GC makes weakness unobservable. Default mode treats the unshadowed
    // builtins as Set/Map; strict mode rejects the documented deviation. This
    // belongs here, where scope facts are available, so a user-defined WeakMap
    // constructor is not rewritten by the earlier syntax-only jzify walk.
    if (builtinCtor && (name === 'WeakSet' || name === 'WeakMap')) {
      const concrete = name === 'WeakSet' ? 'Set' : 'Map'
      if (ctx.transform.strict)
        err(`strict mode: ${name} is not in the canonical subset; use ${concrete} (jz has no GC, so weak references are unobservable).`)
      name = concrete
    }
    // Sharedness belongs to the linked memory, not an individual buffer.
    // Canonicalize only the genuine builtin; a same-name user binding is an
    // ordinary constructor call. Growth options reject below, so this models
    // the fixed-length SharedArrayBuffer subset only.
    if (builtinCtor && name === 'SharedArrayBuffer') name = 'ArrayBuffer'
    // A lone `null` ctorArg is the parser's no-args sentinel (`new Map()`), and
    // `new Map(null)`/`new Map(undefined)` are spec-equivalent to it (null/undefined
    // → empty collection). Drop it so the emit hits the empty-collection fast path
    // rather than lowering `prep(null)` → `[, 0]` and routing through `__map_from`.
    // Typed arrays keep the sentinel: there `[, 0]` is a legitimate zero length.
    if (ctorArgs.length === 1 && ctorArgs[0] == null &&
        (name === 'Array' || name === 'Date' || COLLECTION_CTORS.includes(name))) ctorArgs = []
    // Flatten comma-grouped args: [',', a, b, c] → [a, b, c]
    if (ctorArgs.length === 1 && Array.isArray(ctorArgs[0]) && ctorArgs[0][0] === ',')
      ctorArgs = ctorArgs[0].slice(1)

    if (builtinCtor && name === 'ArrayBuffer' && ctorArgs.length > 1)
      err('ArrayBuffer options are not supported; resizable/maxByteLength buffers are outside the JZ memory model')

    if (builtinCtor && name === 'Array') {
      const literal = prepareArrayConstructor(ctorArgs)
      if (literal !== undefined) return literal
    }

    if (builtinCtor && name === 'URL') {
      const literalArgs = ctorArgs.filter(a => a != null)
      if (literalArgs.length === 2 && isImportMetaProp(literalArgs[1], 'url')) {
        const spec = stringValue(literalArgs[0])
        if (spec == null) err('`new URL(relative, import.meta.url)` supports only string literal relatives — jz resolves the URL at compile time, so the relative part must be statically known')
        return staticString(resolveImportMeta(spec))
      }
    }

    // `new RegExp("pattern", "flags?")` with string-literal pattern → compile
    // like a regex literal `/pattern/flags`. Dynamic pattern is not supported
    // (would require a runtime regex interpreter). Reported as build blocker #6.
    if (builtinCtor && name === 'RegExp') {
      const literalArgs = ctorArgs.filter(a => a != null)
      const pattern = staticStringExpr(literalArgs[0])
      if (pattern == null)
        err('new RegExp() requires a string-literal pattern; dynamic regex construction is not supported — jz compiles regexes at compile time and has no runtime regex interpreter to fall back on')
      const flags = literalArgs.length > 1 ? staticStringExpr(literalArgs[1]) : ''
      if (flags == null)
        err('new RegExp() flags must be a string literal — same compile-time-only rule as the pattern argument')
      return prep(['//', pattern, flags || undefined])
    }

    // Wrap multi-arg ctor arg lists back into a single comma-group — the '()' op
    // expects callArgs as a single element (possibly comma-grouped).
    const wrapArgs = (args) => args.length === 0 ? [null]
      : args.length === 1 ? [prep(args[0])]
      : [[',', ...args.map(prep)]]
    if (builtinCtor && includeForRuntimeCtor(name)) {
      return ['()', `new.${name}`, ...wrapArgs(ctorArgs)]
    }

    const mod = ctx.scope.chain[name]
    if (typeof name === 'string' && mod && mod !== name && !mod.includes('.')) includeModule(mod)
    // Unknown or shadowed constructor: route through normal call preparation so
    // host-import ABI boxing and local resolution are preserved. jzify already
    // strips `new` from known safe constructors.
    if (typeof name === 'string') {
      const callArgs = ctorArgs.length === 0 ? null : ctorArgs.length === 1 ? ctorArgs[0] : [',', ...ctorArgs]
      return handlers['()'](name, callArgs)
    }
    return ['new', prep(ctor), ...args.map(prep)]
  },

  // instanceof (.work/archive/todo.md §deletion-sweep §4) — jz has no prototype chain, so RHS support
  // is a closed allowlist (INSTANCEOF_ALLOW above), not general reflection. Strict-mode
  // source (which skips jzify) reaches this handler directly on every raw `instanceof`
  // node. Default-mode source reaches it too, for every RHS this file's INSTANCEOF_ALLOW
  // supports: jzify/transform.js's own 'instanceof' handler passes those through as
  // `['instanceof', val, name]` instead of answering them itself — a broad shape probe
  // in jzify cannot distinguish sibling classes (e.g. it would answer
  // `new TypeError(x) instanceof RangeError` wrongly), so this sound handler must be
  // the one to decide any RHS in INSTANCEOF_ALLOW. jzify keeps its OWN
  // Promise/Iterator shape-probes (this file rejects both
  // RHS names — jz-level semantics, not core ones) and its permissive `typeof===object`
  // fallback for every RHS outside INSTANCEOF_ALLOW (Object/RegExp/user-class names —
  // default mode stays permissive there, unlike strict's loud reject below).
  // RHS may arrive as a bare name ('Array') or, if parenthesized (`x instanceof (Array)`),
  // as a length-2 grouping call node (['()', 'Array']) — same shape 'new' unwraps above.
  'instanceof'(lhs, rhs) {
    const rawName = typeof rhs === 'string' ? rhs
      : (Array.isArray(rhs) && rhs[0] === '()' && rhs.length === 2 && typeof rhs[1] === 'string') ? rhs[1]
      : null
    const shadowed = rawName != null && shadowsBuiltin(rawName)
    const name = rawName === 'SharedArrayBuffer' && !shadowed ? 'ArrayBuffer' : rawName
    if (name == null || shadowed || !INSTANCEOF_ALLOW.has(name))
      err(`instanceof: unsupported right-hand side (got ${JSON.stringify(rawName ?? rhs)}); ` +
          `jz has no prototype chain; instanceof works only for Array, Map, Set, ` +
          `the TypedArray (${TYPED_ELEM_NAMES.join('/')}) and ArrayBuffer/SharedArrayBuffer constructors, and ` +
          `Error/${ERR_CLASS_NAMES.slice(1).join('/')}`)
    return ['instanceof', prep(lhs), name]
  }
}
// Constant fold typeof for known builtin namespaces (e.g. Math.exp). prep(x) resolves Math.exp → 'math.exp'.
function staticTypeofString(x) {
  // Spec §13.5.3: unresolvable bare ref → 'undefined'.
  if (isUnresolvableBareIdent(x)) return 'undefined'
  // Bare callable global: parseInt, parseFloat, isNaN, isFinite, Error, BigInt, etc.
  if (typeof x === 'string' && !ctx.func?.locals?.has(x) && GLOBALS[x] && emitArity(ctx.core.emit?.[x]) > 0) return 'function'
  const px = prep(x)
  if (typeof px === 'string' && px.includes('.') && emitArity(ctx.core.emit?.[px]) > 0) return 'function'
  return null
}
function resolveTypeof(node) {
  const [op, a, b] = node
  // `typeof` always yields a string, so `==`/`===` (and `!=`/`!==`) are
  // equivalent here — both collapse to the same type check.
  const eqLike = op === '==' || op === '==='
  // typeof x == 'string' → type check
  if (Array.isArray(a) && a[0] === 'typeof' && Array.isArray(b) && b[0] == null && typeof b[1] === 'string') {
    const known = staticTypeofString(a[1])
    if (known != null) return [, eqLike ? known === b[1] : known !== b[1]]
    const code = TYPEOF[b[1]]
    if (code != null) return [op, ['typeof', a[1]], [, code]]
  }
  // 'string' == typeof x
  if (Array.isArray(b) && b[0] === 'typeof' && Array.isArray(a) && a[0] == null && typeof a[1] === 'string') {
    const known = staticTypeofString(b[1])
    if (known != null) return [, eqLike ? known === a[1] : known !== a[1]]
    const code = TYPEOF[a[1]]
    if (code != null) return [op, ['typeof', b[1]], [, code]]
  }
  return node
}

// Prepare a strict `===`/`!==`. resolveTypeof may fold `typeof x === 'type'` to a
// literal or rewrite it to a numeric-code compare; either way we prep the result's
// operands directly. The strict op stays intact (no collapse to loose `==`) so
// emit can apply the no-coercion type-mismatch fold.
function prepStrictEq(op, a, b) {
  const r = resolveTypeof([op, a, b])
  if (r[0] !== op) return prep(r)            // folded to a literal — re-prep is safe
  return [op, prep(r[1]), prep(r[2])]        // keep strict op; prep operands only
}

function scalarArrayDestruct(pattern, rhs) {
  const targets = simpleArrayPatternItems(pattern)
  const values = arrayLiteralItems(rhs)
  if (!targets || !values || targets.length !== values.length) return null

  const decls = []
  const assigns = []
  for (let i = 0; i < targets.length; i++) {
    const tmp = `${T}d${freshPrepareId()}`
    decls.push(['=', tmp, prep(values[i])])
    assigns.push(['=', targets[i], tmp])
  }
  return prep([';', ['let', ...decls], ...assigns])
}
/** Resolve computed property keys inside a decl pattern: `{[k]: x}`'s key is
 *  an ordinary EXPRESSION read from outer scope, not a binding position — it
 *  must resolve through prep like any read (a renamed outer binding included).
 *  Assignment-form destructures prep the whole node and never needed this;
 *  the decl path skips whole-node prep, so keys were passed raw and only
 *  matched while outer names kept their source spelling. */
function prepPatternKeys(p) {
  if (!Array.isArray(p)) return p
  if (p[0] === ':') {
    // computed-key marker `['[]', expr]` (len 2): prep the INNER expr only —
    // string / numeric-literal keys stay raw (they are names, not reads)
    const k = p[1]
    const key = Array.isArray(k) && k[0] === '[]' && k.length === 2 ? ['[]', prep(k[1])] : k
    return [':', key, prepPatternKeys(p[2])]
  }
  if (p[0] === '{}' || p[0] === '[]' || p[0] === ',') return [p[0], ...p.slice(1).map(prepPatternKeys)]
  if (p[0] === '=') return ['=', prepPatternKeys(p[1]), p[2]]
  if (p[0] === '...') return ['...', prepPatternKeys(p[1])]
  return p
}

function pushPatternAssign(target, valueExpr, out, decls = null) {
  if (Array.isArray(target) && target[0] === '=') {
    // Destructuring default fires ONLY on undefined (ES §13.15.5.3) — `??` would
    // also fire on null (`[a = 1] = [null]` must leave a null). Spill the read
    // once, test against undefined, keep the default lazily evaluated.
    const tmp = `${T}d${freshPrepareId()}`
    if (decls) decls.push(['=', tmp, valueExpr])
    else out.push(['=', tmp, valueExpr])
    pushPatternAssign(target[1], ['?:', ['===', tmp, [, JZ_UNDEF]], prep(target[2]), tmp], out, decls)
    return
  }

  if (isDestructPattern(target)) {
    const tmp = `${T}d${freshPrepareId()}`
    if (decls) decls.push(['=', tmp, valueExpr])
    else out.push(['=', tmp, valueExpr])
    expandDestruct(target, tmp, out, decls)
    return
  }

  out.push(['=', target, valueExpr])
}

function expandDestruct(pattern, source, out, decls = null, srcLen = null) {
  if (!isDestructPattern(pattern)) return

  if (pattern[0] === '[]') {
    includeForArrayPattern()
    const items = patternItems(pattern[1])
    for (let j = 0; j < items.length; j++) {
      const item = items[j]
      if (item == null) continue

      if (Array.isArray(item) && item[0] === '...') {
        pushPatternAssign(item[1], ['()', ['.', source, 'slice'], [, j]], out, decls)
        continue
      }

      // Source is a known-length inline literal and this index is past its end →
      // the element is statically `undefined` (so any `= default` applies). Folding
      // it here skips a provably out-of-range read — which both avoids the runtime
      // access and dodges an optimizer miscompile of the destructuring-temp shape.
      if (srcLen != null && j >= srcLen) {
        pushPatternAssign(item, [, JZ_UNDEF], out, decls)
        continue
      }

      pushPatternAssign(item, ['[]', source, [, j]], out, decls)
    }
    return
  }

  includeForObjectPattern()
  const items = patternItems(pattern[1])

  // Collect explicit keys and detect rest pattern
  let restTarget = null
  const explicitKeys = []
  for (const item of items) {
    if (item == null) continue
    if (Array.isArray(item) && item[0] === '...') { restTarget = item[1]; continue }
    if (typeof item === 'string') explicitKeys.push(item)
    else if (Array.isArray(item) && item[0] === '=') { if (typeof item[1] === 'string') explicitKeys.push(item[1]) }
    else if (Array.isArray(item) && item[0] === ':') explicitKeys.push(item[1])
  }

  for (const item of items) {
    if (item == null) continue
    if (Array.isArray(item) && item[0] === '...') continue  // handled below

    if (typeof item === 'string') {
      pushPatternAssign(item, ['.', source, item], out, decls)
      continue
    }

    if (Array.isArray(item) && item[0] === '=') {
      // Route through pushPatternAssign's `=` case: undefined-only default.
      if (typeof item[1] === 'string')
        pushPatternAssign(item, ['.', source, item[1]], out, decls)
      continue
    }

    if (Array.isArray(item) && item[0] === ':') {
      const key = item[1]
      const computedKey = Array.isArray(key) && key[0] === '[]' && key.length === 2 ? key[1] : null
      if (computedKey) includeForArrayAccess()
      // Numeric key (`{ 0: v, length: z } = arr`) — an index read, not a dot-key:
      // the static-key path hashes STRING keys only (and arrays index natively).
      // The parser yields the key as a literal node `[null, 0]` (raw number in
      // synthesized shapes).
      const numKey = typeof key === 'number' ? key
        : Array.isArray(key) && key.length === 2 && key[0] == null && typeof key[1] === 'number' ? key[1]
        : null
      const read = computedKey ? ['[]', source, computedKey]
        : numKey != null ? (includeForArrayAccess(), ['[]', source, [, numKey]])
        : ['.', source, key]
      pushPatternAssign(item[2], read, out, decls)
      continue
    }
  }

  // Object rest: {x, ...rest} = obj → rest = {remaining props from source schema}
  if (restTarget) {
    const srcSchema = typeof source === 'string' && ctx.schema.resolve(source)
    if (srcSchema) {
      const remaining = srcSchema.filter(k => !explicitKeys.includes(k))
      if (remaining.length) {
        const restProps = remaining.map(k => [':', k, ['.', source, k]])
        const restObj = ['{}', remaining.length === 1 ? restProps[0] : [',', ...restProps]]
        // Register schema for the rest variable so property access works
        // (poisoned names stay out of the shared channel).
        if (typeof restTarget === 'string' && !ctx.schema.poisoned?.has(restTarget))
          ctx.schema.vars.set(restTarget, ctx.schema.register(remaining))
        pushPatternAssign(restTarget, restObj, out, decls)
      } else {
        pushPatternAssign(restTarget, ['{}'], out, decls)
      }
    } else {
      err('Object rest (...) requires source with known schema — destructure the object before passing to function, or use explicit property access')
    }
  }
}

/** Bind `name` to builtin emit key `key` at the current scope (module
 *  `scope.chain` at depth 0, block scope otherwise) instead of declaring a
 *  real global/local — mirrors the `const alias = fn` function-alias fast
 *  path in `prepDecl`. `includeForCallableValue` is pre-armed exactly when the
 *  '.' handler would arm it (arity > 0), so an incidental first-class use
 *  (`let g = sin` elsewhere) still finds closure support wired up. */
function registerBuiltinAlias(name, key) {
  if (ctx.funcs.exports[name]) {
    // A CONSTANT member (Math.PI — an arity-0 value emitter) exported by name
    // needs real storage, not a wrapper function: `Math.max(1, …)` used to
    // synthesize `(a) => math.PI(a)` here, so importers doing arithmetic on PI
    // got a closure — NaN (the window-function taylor memo died on A = …/PI).
    // Return false: the caller falls through to an ordinary global declaration
    // whose init emits the constant.
    if ((emitArity(ctx.core.emit[key]) || 0) === 0) return false
    // An alias carries no runtime storage, but an EXPORT needs some — synthesize
    // the wrapping function the old error told users to write by hand
    // (`export let { sin, cos } = Math` — window-function's util.js — must just
    // work). Arity from the emitter; in-module calls direct-call the wrapper,
    // which inlines back to the builtin under watr.
    const arity = Math.max(1, emitArity(ctx.core.emit[key]) || 1)
    const params = Array.from({ length: arity }, (_, i) => `${T}ba${i}`)
    const paramsNode = params.length === 1 ? params[0] : [',', ...params]
    const wrapped = prep(['=>', paramsNode, ['()', key, params.length === 1 ? params[0] : [',', ...params]]])
    if (defFunc(name, wrapped)) return true
    err(`'${name}' aliases builtin '${key}' and cannot be exported directly — export a wrapping function instead`)
  }
  if (emitArity(ctx.core.emit[key]) > 0) includeForCallableValue()
  if (prepState.depth === 0) {
    ctx.scope.chain[name] = key
  } else {
    const fnNames = funcLocalNames[funcLocalNames.length - 1]
    if (fnNames) fnNames.add(name)
    if (scopes.length > 0) scopes[scopes.length - 1].set(name, key)
  }
  return true
}

// jzify hoists top-level `function` declarations to the front of their
// enclosing `;` block (mirroring JS function-hoisting — see jzify/transform.js
// `transformScope`), so a hoisted function's body can be PREPPED — and any
// builtin-namespace alias it references resolved — before a SIBLING
// `let {sin} = Math` / `let sin = Math.sin` the function calls appears in the
// statement list. Real JS gets away with this because the function isn't
// CALLED until the whole block has finished initializing; jz's prepare pass
// resolves each reference eagerly in one linear walk, so without this the
// alias isn't registered yet and the reference falls through unresolved (a
// dangling local at watr assembly, not a caught compile error). Scanning every
// sibling `let`/`const` up front and registering any alias-shaped one makes
// alias resolution order-independent within the block — matching how a REAL
// global (declareGlobal) already resolves order-independently, since compile
// (not prepare) looks those up by name after the whole module has been prepped.
function preRegisterBuiltinAliases(stmts) {
  // A sibling `let Math = {…}` in this SAME block shadows the builtin even
  // though — being an unordered pre-scan — it hasn't been individually
  // prepped yet (so `shadowsBuiltin`/`userGlobals` don't know about it yet
  // either). Collect every name this block itself declares up front so the
  // scan below can treat it exactly like an outer-scope shadow.
  const blockDeclared = new Set()
  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const')) continue
    for (const i of stmt.slice(1)) {
      const target = Array.isArray(i) && i[0] === '=' ? i[1] : i
      bindingNames(target, blockDeclared)
    }
  }
  // Bare identifier `name` names an as-yet-unshadowed builtin module — null
  // when `name` is shadowed (by this block, an outer scope, a function, or a
  // user global) or simply isn't a known module name.
  const builtinModOf = (name) => {
    if (typeof name !== 'string' || blockDeclared.has(name) || shadowsBuiltin(name)) return null
    const mod = ctx.scope.chain[name]
    return mod && !mod.includes('.') && hasModule(mod) ? mod : null
  }
  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const')) continue
    for (const i of stmt.slice(1)) {
      if (!Array.isArray(i) || i[0] !== '=') continue
      const [, name, init] = i
      if (isDestructPattern(name) && typeof init === 'string') {
        const mod = builtinModOf(init)
        if (mod) {
          const aliases = namespaceMemberAliases(name, mod)
          if (aliases) for (const [target, key] of aliases) registerBuiltinAlias(target, key)
        }
      } else if (!isDestructPattern(name) && typeof name === 'string' && Array.isArray(init) &&
                 init[0] === '.' && typeof init[1] === 'string' && typeof init[2] === 'string') {
        const mod = builtinModOf(init[1])
        if (mod) {
          includeModule(mod)
          const key = `${mod}.${init[2]}`
          if (ctx.core.emit[key] != null) registerBuiltinAlias(name, key)
        }
      }
    }
  }
}

/** Prepare let/const declaration. */
function prepDecl(op, ...inits) {
  const rest = []
  for (const i of inits) {
    if (Array.isArray(i) && i[0] === '()' && typeof i[1] === 'string' && Array.isArray(i[2]) && i[2][0] === '=' && isDestructPattern(i[2][1])) {
      if (rest.length === 0 && inits.length === 1) return [';', [op, i[1]], prep(i[2])]
      err('destructuring assignment after declaration must be a separate statement — e.g. write `let x = f(); ({a, b} = x)` as two statements, not one declarator')
    }

    if (!Array.isArray(i) || i[0] !== '=') {
      let declName = i
      if (prepState.depth === 0 && typeof declName === 'string' && !loopLocalNames.has(declName)) {
        if (ctx.module.currentPrefix) {
          declName = `${ctx.module.currentPrefix}$${declName}`
          ctx.scope.chain[i] = declName
        }
        if (ctx.scope.globals.has(declName)) err(`'${declName}' conflicts with a compiler internal — choose a different name`)
        declGlobal(declName, 'f64')
        ctx.scope.userGlobals.add(declName)
      } else if (typeof declName === 'string') {
        // Bare hoisted decl inside a function (var X jzified to `let X` at top
        // of arrow + a later `X = …` assignment). Without registering here, the
        // name is invisible to scope predicates like `isUnresolvableBareIdent`
        // until the assignment runs — which is after any reference to it.
        // Prescan may have pre-registered (and renamed) it — consume that.
        const fnNames = funcLocalNames[funcLocalNames.length - 1]
        if (scopes.length > 0) {
          const top = scopes[scopes.length - 1]
          if (top.has(declName)) declName = top.get(declName)
          else if ((prepState.depth !== 0 || loopLocalNames.has(declName)) && !declName.includes(T)) {
            const m = mintForScope(declName, loopLocalNames.has(declName))
            top.set(declName, m)
            declName = m
          } else top.set(declName, declName)
        }
        if (fnNames) fnNames.add(declName)
      }
      rest.push(declName)
      continue
    }
    let [, name, init] = i
    // `const alias = fn` whose RHS is a bare identifier naming a known function
    // is a compile-time function alias — the ES `export { fn as alias }` written
    // in declaration form (a recurring kernel idiom: paramList = extractParams,
    // toBoolFromEmitted = truthyIR …). Resolve `alias` straight to the function
    // so calls compile to a direct call and the export table re-exports the same
    // mangled func. Otherwise it would box a closure into a module global that a
    // cross-module callee resolves to the bare, unmangled name → "not in scope".
    // Module scope + `const` only: depth>0 aliases already work as closure values,
    // and a reassignable `let` is a genuine value binding, not an alias.
    if (op === 'const' && prepState.depth === 0 && typeof name === 'string' && typeof init === 'string') {
      const fn = hasFunc(init) ? init : (hasFunc(ctx.scope.chain[init]) ? ctx.scope.chain[init] : null)
      if (fn) {
        ctx.scope.chain[name] = fn
        if (name in ctx.funcs.exports) ctx.funcs.exports[name] = fn
        continue
      }
    }
    const staticStr = op === 'const' ? staticStringExpr(init) : null
    const staticArr = op === 'const' ? staticStringArrayValues(init) : null
    const normed = prep(init)

    // `let/const name = NS.member` (`let sin = Math.sin`) — prep's `.` handler
    // already resolved this to the flat dotted emit key; alias `name` to it
    // (see registerBuiltinAlias) instead of declaring a real global/local that
    // would box the builtin as a first-class value on every reference.
    if (!isDestructPattern(name) && typeof name === 'string') {
      const memberKey = builtinMemberKey(normed)
      if (memberKey && registerBuiltinAlias(name, memberKey)) continue
      // `const M = Math` at module top level — a bare reference to a whole
      // builtin namespace (no member, no dot). Same reasoning as above: there's
      // no runtime namespace object to box, so alias `name` straight to the
      // module name in `scope.chain` instead of declaring a real global — the
      // existing `mod = ctx.scope.chain[obj]` check in the '.' handler (the
      // SAME table `Math` itself resolves through) then resolves `M.sqrt`
      // exactly like a direct `Math.sqrt` reference would, with no further
      // changes needed there.
      // Any depth: registerBuiltinAlias scope-routes (chain at module level, the
      // block-scoped `scopes` stack inside functions), and the consumers — the
      // '.' handler and resolveCallee's `.`-callee branch — resolve the receiver
      // through the function scope FIRST (namespaceModOf below). The genuine-
      // alias-vs-ordinary-local ambiguity is settled by the discriminator here,
      // not at the read site: only an RHS that RESOLVED to a module name
      // registers (an ordinary local named 'json'/'fn' never does — its RHS is
      // a value expression, and a user shadow of the namespace makes prep
      // resolve the RHS through the shadow instead). `normed !== name` guards
      // the identity-self-map false positive (e.g. a cross-module host-import
      // alias that happens to be named after a module).
      // `!shadowsBuiltin(init)`: the RHS must be the NAMESPACE ITSELF, not a
      // declared VALUE binding that merely resolves to a module-shaped name —
      // `let object = {…}; let alias = object` chains normed==='object'
      // (identity self-map through the shadow path) and must stay a value copy.
      if (typeof normed === 'string' && normed !== name && hasModule(normed)
          && typeof init === 'string' && !shadowsBuiltin(init)) {
        registerBuiltinAlias(name, normed); continue
      }
    }

    if (isDestructPattern(name)) {
      // `let/const {a, b: c} = NS` where NS resolved (above) to a known builtin
      // module — alias each key directly (see namespaceMemberAliases) instead
      // of running the generic runtime object-destructure below, which has no
      // way to read a property off a namespace that isn't a real heap object.
      if (typeof normed === 'string' && hasModule(normed)) {
        const aliases = namespaceMemberAliases(name, normed)
        if (aliases) {
          for (const [target, key] of aliases) {
            if (registerBuiltinAlias(target, key)) continue
            // Exported CONSTANT member (export let { PI } = Math): real storage,
            // mirroring the normal decl path's depth-0 prefix/chain wiring; the
            // init assignment rides `rest` into module init like any destructure.
            declareGlobal(target)
            let declName = target
            if (prepState.depth === 0 && ctx.module.currentPrefix) {
              declName = `${ctx.module.currentPrefix}$${target}`
              ctx.scope.chain[target] = declName
            }
            rest.push(['=', declName, key])
            recordGlobalRep(declName, key)
          }
          continue
        }
      }
      // Register each binding both as a module global (depth 0) and in the
      // current arrow's local scope (depth ≠ 0). Without the local registration
      // the name is invisible to `isUnresolvableBareIdent`, so a later
      // `typeof x` would mis-fold to 'undefined' (spec §13.5.3) before emit ever
      // sees the binding — see the bare-hoisted-decl branch above for the same fix.
      const fnNames = funcLocalNames[funcLocalNames.length - 1]
      // Shadow rename for destructure targets (depth ≠ 0): consume the prescan
      // mapping (or decide traversal-time for synthetic patterns), then rewrite
      // the pattern's VALUE-side idents so expandDestruct binds the renamed
      // locals (`{ let x; { let {x} = o; … } }` bound the OUTER x before).
      const patRenames = new Map()
      for (const n of bindingNames(name)) {
        let declName = n
        // loopLocalNames: see its declaration — a depth-0 destructured loop
        // target a nested closure captures mints like any depth!==0 local
        // instead of taking the single-instance global path below.
        const isLoopLocal = typeof n === 'string' && loopLocalNames.has(n)
        if ((prepState.depth !== 0 || isLoopLocal) && typeof n === 'string' && scopes.length > 0) {
          const top = scopes[scopes.length - 1]
          if (top.has(n)) declName = top.get(n)
          else if (!n.includes(T)) {
            declName = mintForScope(n, isLoopLocal)
            top.set(n, declName)
          } else if (isDeclared(n) || fnNames?.has(n)) {
            declName = `${n}${T}${freshPrepareId()}`
            top.set(n, declName)
          } else top.set(n, n)
          if (declName !== n) patRenames.set(n, declName)
        }
        // A depth-0 target in a bundled module takes the module prefix like a
        // plain declaration, so two modules destructuring the same name keep
        // distinct globals.
        if (prepState.depth === 0 && !isLoopLocal && ctx.module.currentPrefix && typeof n === 'string') {
          declName = `${ctx.module.currentPrefix}$${n}`
          ctx.scope.chain[n] = declName
          patRenames.set(n, declName)
        }
        if (!isLoopLocal) declareGlobal(declName)
        // Destructure targets hold source-prop values of unknown shape — census
        // as non-literal binding sites (raw + module-prefixed key for depth-0
        // globals; whichever spelling later consumers resolve through is barred).
        censusUnknownInitDecl(declName)
        if (prepState.depth === 0 && !isLoopLocal && ctx.module.currentPrefix && typeof n === 'string') censusUnknownInitDecl(n)
        if ((prepState.depth !== 0 || isLoopLocal) && typeof declName === 'string' && fnNames) fnNames.add(declName)
      }
      if (patRenames.size) name = substPattern(name, patRenames)
      name = prepPatternKeys(name)
      // A bare-identifier source needs no temp: reads are idempotent and
      // side-effect-free, so we destructure straight off it. This keeps each
      // element's static type tag (e.g. `let [, x] = strs` resolves `x` to the
      // same STRING that `strs[1]` would) — a copy temp drops the array's
      // element-type shape and `typeof x` would degrade to 'undefined'.
      if (typeof normed === 'string') {
        expandDestruct(name, normed, rest)
        continue
      }
      const tmp = `${T}d${freshPrepareId()}`
      declareGlobal(tmp, false)
      rest.push(['=', tmp, normed])
      // Propagate schema to temp so rest destructuring can resolve it
      if (Array.isArray(normed) && normed[0] === '{}') {
        const p = normed.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
        if (p.length) ctx.schema.vars.set(tmp, ctx.schema.register(p))
      }
      // Array sibling of the schema propagation above: `tmp`'s per-index VAL
      // kind is exactly this literal's own element expressions' kinds — read
      // by kind.js valTypeOf (VT['[]']) off ctx.schema.arrayVars so
      // `let [a, b] = [1, BigInt(v)]` keeps `b`'s BIGINT kind exactly like the
      // object form keeps it (via ctx.schema.vars/slotVT + flatObjects) instead
      // of degrading to an untyped index read. Not routed through ctx.schema's
      // shared registry: arrays have no name-partitioned structural identity —
      // every same-length array literal in the whole program would collide onto
      // one shared id (unlike objects, naturally partitioned by property name),
      // poisoning the fact almost everywhere. Sound with no write-hazard census
      // because `tmp` is a compiler-synthesized, single-write, non-escaping
      // carrier that only this destructure's own generated reads ever touch.
      if (Array.isArray(normed) && normed[0] === '[') ctx.schema.arrayVars.set(tmp, normed.slice(1))
      expandDestruct(name, tmp, rest, null, inlineArrayLen(normed))
      continue
    }

    if (!defFunc(name, normed)) {
      let declName = name
      // loopLocalNames: see its declaration — a depth-0 loop-body let/const a
      // nested closure captures takes the local (mintLocal) path below instead
      // of the single-instance global path further down. Read from `name`
      // (pre-rename) since loopLocalNames holds source spellings.
      const isLoopLocal = typeof name === 'string' && loopLocalNames.has(name)
      // Block scope: the block's own decls are pre-registered (with their
      // rename decision) by prescanBlockDecls at scope entry — consume that
      // mapping. Synthetic decls minted mid-prep (do-flags, loop temps) miss
      // the prescan and keep the traversal-time rule: rename if shadowing an
      // outer declaration OR if a sibling block already declared this name
      // (sibling blocks both lower to the same WASM local; see funcLocalNames).
      const fnNames = funcLocalNames[funcLocalNames.length - 1]
      if (typeof name === 'string' && scopes.length > 0) {
        const top = scopes[scopes.length - 1]
        if (top.has(name)) declName = top.get(name)
        else if ((prepState.depth !== 0 || isLoopLocal) && !name.includes(T)) {
          declName = mintForScope(name, isLoopLocal)
          top.set(name, declName)
        } else if (isDeclared(name) || fnNames?.has(name)) {
          declName = `${name}${T}${freshPrepareId()}`
          top.set(name, declName)
        } else top.set(name, name)
      }
      if (typeof declName === 'string' && fnNames) fnNames.add(declName)
      // A nested arrow stays a closure value (defFunc only lifts depth-0). Record
      // the binding so `.caller`/`.callee` on it reads as prohibited introspection.
      if (typeof declName === 'string' && Array.isArray(normed) && normed[0] === '=>')
        funcValueNames[funcValueNames.length - 1]?.add(declName)
      // promiseRecvNames/withResolversRecvNames (see their own declaration,
      // above) — a name bound DIRECTLY to jz's own Promise-runtime helper
      // calls. Checked structurally on the ALREADY-jzify-canonicalized RHS
      // (`new Promise(fn)` → __p_exec(fn), `Promise.withResolvers()` →
      // __p_withResolvers()), not the pre-transform source spelling.
      if (typeof declName === 'string' && Array.isArray(normed) && normed[0] === '()') {
        if (normed[1] === '__p_exec') promiseRecvNames.add(declName)
        else if (normed[1] === '__p_withResolvers') withResolversRecvNames.add(declName)
      }
      // The mutation census (indexed/.length/mutating-method anywhere, raw
      // names) gates every ARRAY-fact bind: execution can reach the mutation
      // before a later fold site regardless of textual order (hoisted function
      // bodies, call-before-decl), so eligibility is program-wide, not
      // positional. String facts stay — no such op mutates a string.
      const arrEligible = staticArr && !mutatedArrayNames.has(name) ? staticArr : null
      if (op === 'const') bindStaticConst(declName, staticStr, arrEligible)
      // Local const: record the (post-rename) name for the assignment guard —
      // isConst covers only module scope, so `const c = 2; c = 3` inside a
      // function used to compile and mutate silently.
      if (op === 'const' && typeof declName === 'string' && scopes.length)
        (staticConstScopes[staticConstScopes.length - 1][STATIC_CONSTS] ||= new Set()).add(declName)
      // Track const for reassignment checks — only module-scope consts (depth 0)
      if (typeof declName === 'string' && prepState.depth === 0 && !isLoopLocal) {
        if (ctx.module.currentPrefix) {
          declName = `${ctx.module.currentPrefix}$${declName}`
          ctx.scope.chain[name] = declName
        }
        if (op === 'const') bindStaticGlobal(declName, staticStr, arrEligible)
        if (op === 'const') {
          if (!ctx.scope.consts) ctx.scope.consts = new Set()
          ctx.scope.consts.add(declName)
          if (staticStr != null) (ctx.scope.constStrs ||= new Map()).set(declName, staticStr)
          const strs = arrEligible || (!mutatedArrayNames.has(name) && stringArrayValues(normed))
          if (strs) (ctx.scope.shapeStrArrays ||= new Map()).set(declName, strs)
          // Module-const object literal: register each STATIC-KEY scalar
          // field's folded VALUE so `TABLE.KEY` participates in staticValue's
          // const-fold — the missing member-read arm that left
          // `{[KIND.BARE]: …}` computed keys "truly dynamic" and forced the
          // whole literal onto the dict path. Same const-table idiom (and
          // envelope) as constStrs/constInts one line up, one level deeper.
          if (Array.isArray(normed) && normed[0] === '{}') {
            const raw = normed.length === 2 && Array.isArray(normed[1]) && normed[1][0] === ',' ? normed[1].slice(1) : normed.slice(1)
            let fields = null
            for (const p of raw) {
              if (!Array.isArray(p) || p[0] !== ':' || typeof p[1] !== 'string') continue
              const v = staticValue(p[2])
              if (v === NO_VALUE || (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean')) continue
              ;(fields ||= new Map()).set(p[1], v)
            }
            if (fields) (ctx.scope.constObjFields ||= new Map()).set(declName, fields)
          }
        } else if (op === 'let' && ctx.scope.consts?.has(declName)) {
          ctx.scope.consts.delete(declName)
          ctx.scope.constStrs?.delete(declName)
          ctx.scope.shapeStrArrays?.delete(declName)
        }
        // Effectively-const string literals: shape inference for `let SRC = '{...}'`
        // patterns (bench convention to defeat compile-time JSON.parse fold without
        // losing schema knowledge). Recorded on init; post-prep scan removes any
        // entry whose name is later assigned to.
        if (Array.isArray(normed) && normed[0] === 'str' && typeof normed[1] === 'string')
          (ctx.scope.shapeStrs ||= new Map()).set(declName, normed[1])
        recordGlobalRep(declName, normed)
      }
      // Track object schemas (after prefix so schema is keyed to final name)
      if (typeof declName === 'string' && Array.isArray(normed) && normed[0] === '{}' && normed.length > 1) {
        const props = []
        const seen = new Set()
        let allKnown = true
        // Dedupe every key (explicit AND spread-sourced) so a `k: v` that overrides
        // a spread-provided key doesn't push a duplicate — that would shift the
        // indices of later keys past emitObjectSpread's deduped slot assignment
        // (its `addName` dedupes both), making `decl.laterKey` read the wrong slot.
        // A conditional-spread group's key colliding with anything else (see
        // conditionalSpreadGroupPrepare below) bails `allKnown` instead of
        // deduping — mirrors module/object.js mergeSpreadNames' identical bail.
        const addProp = (n) => {
          if (seen.has(n)) return
          seen.add(n); props.push(n)
        }
        for (const p of normed.slice(1)) {
          if (Array.isArray(p) && p[0] === ':') addProp(p[1])
          else if (Array.isArray(p) && p[0] === '...') {
            // Conditional presence needs HASH insertion; do not bind a fixed
            // schema that would conflate absent with present-undefined.
            if (conditionalSpreadGroupPrepare(p[1])) { allKnown = false; continue }
            const srcSchema = typeof p[1] === 'string' && ctx.schema.resolve(p[1])
            if (srcSchema) for (const n of srcSchema) addProp(n)
            else allKnown = false
          }
        }
        // An unknown spread source makes the value a runtime HASH (see
        // emitObjectSpread). Binding a static schema would compile `decl.prop`
        // to a fixed slot load that misreads the hash, so leave reads dynamic.
        if (allKnown && props.length && ctx.schema.register) {
          const sid = ctx.schema.register(props)
          bindDeclSchema(declName, sid)
        }
        else censusUnknownInitDecl(declName)
      } else if (typeof declName === 'string' && Array.isArray(normed) && normed[0] === '()' &&
                 typeof normed[1] === 'string' && ERR_CLASS_SET.has(normed[1]) && ctx.schema.errorSid) {
        // `let e = new X(...)`/`X(...)` (one of the 7 built-in Error classes) —
        // bind e's schemaId to that class's minted sid the same way an object
        // LITERAL declaration binds one above. Without this, a bound Error
        // variable's schema is invisible to every consumer that resolves a
        // NAME's schema rather than re-inspecting its init expression —
        // instanceof's tier-2 fold and module/object.js's spread/Object.assign
        // source-schema check both only ever see the literal-call-shaped case.
        bindDeclSchema(declName, ctx.schema.errorSid(normed[1]))
      } else censusUnknownInitDecl(declName)
      // Module-scope variable → WASM global (mark as user-declared). Skipped
      // for a captured loop-local (isLoopLocal): it already minted a fresh
      // local above and must stay one — see loopLocalNames' declaration.
      if (prepState.depth === 0 && !isLoopLocal && typeof declName === 'string') {
        if (ctx.scope.globals.has(declName)) err(`'${declName}' conflicts with a compiler internal — choose a different name`)
        declGlobal(declName, 'f64')
        ctx.scope.userGlobals.add(declName)
      }
      rest.push(['=', declName, normed])
    }
  }
  return rest.length ? [op, ...rest] : null
}

// String-callee constructor / named-builtin folds: `Array(n)` and the `CTORS`
// set redirect to the `new` handler; `BigInt64Array`/`BigUint64Array` build a
// direct module call. `includeForNamedCall` is probed for every string callee
// — that probe is also how a module-backed builtin gets its modules included.
// Returns the replacement IR, or `undefined` for an ordinary call.
function dispatchConstructorCall(callee, args) {
  if (typeof callee !== 'string') return undefined
  // A user binding named like a constructor (`let Map = …`, `let Array = …`)
  // shadows the builtin — don't lower `Map(x)` to `new.Map`.
  if (shadowsBuiltin(callee)) return undefined
  if (callee === 'Array') {
    const callArgs = handlerArgs(args)
    const literal = prepareArrayConstructor(callArgs)
    if (literal !== undefined) return literal
    return handlers['new'](['()', callee, callArgs[0]])
  }
  if (CTORS.includes(callee)) return handlers['new'](['()', callee, ...args])
  if (includeForNamedCall(callee) && (callee === 'BigInt64Array' || callee === 'BigUint64Array'))
    return ['()', callee, ...args.filter(a => a != null).map(prep)]
  return undefined
}

// `f.call/apply/bind` on a PROVEN function binding lowers statically: jz
// functions cannot observe `this` (rejected outside the class lowering), so
// the thisArg is dead weight — kept only for its side effects via a comma
// sequence. Anything not provably a function keeps the runtime path (a user
// object may legitimately carry its own `call` property). Previously these
// silently returned undefined (.call/.apply) or trapped (table OOB, .bind).
// `Ctor.prototype.m.call(recv, …)` (the array-like borrow idiom) is a static
// method call on the receiver: a typed constructor's method on its own kind,
// or an Array method applied to a copy (`Array.prototype.slice.call(typed)`
// returns a plain array, so the receiver copies through Array.from first).
// Mutating Array methods on a copy would lose the write; they keep the reject.
const BORROW_CTORS = new Set(['Array', ...TYPED_ELEM_NAMES])
const ARRAY_COPY_SAFE = new Set(['slice', 'map', 'filter', 'join', 'indexOf', 'lastIndexOf', 'includes',
  'reduce', 'reduceRight', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'concat', 'at', 'flat', 'flatMap', 'entries', 'keys', 'values', 'toString'])
function foldPrototypeBorrow(callee, args) {
  if (!Array.isArray(callee) || callee[0] !== '.' || callee[2] !== 'call') return undefined
  const method = callee[1]
  if (!Array.isArray(method) || method[0] !== '.' || typeof method[2] !== 'string') return undefined
  const proto = method[1]
  if (!Array.isArray(proto) || proto[0] !== '.' || proto[2] !== 'prototype' || typeof proto[1] !== 'string') return undefined
  const ctor = proto[1]
  if (!BORROW_CTORS.has(ctor) || shadowsBuiltin(ctor) || (scopes.length && isDeclared(ctor))) return undefined
  const [recv, ...rest] = handlerArgs(args)
  if (recv == null) return undefined
  if (ctor === 'Array' && !ARRAY_COPY_SAFE.has(method[2])) return undefined
  const base = ctor === 'Array' ? ['()', ['.', 'Array', 'from'], recv] : recv
  return prep(['()', ['.', base, method[2]], rest.length === 0 ? null : rest.length === 1 ? rest[0] : [',', ...rest]])
}
function foldFnCallApplyBind(callee, args) {
  if (!Array.isArray(callee) || callee[0] !== '.') return undefined
  let [, name, meth] = callee
  if (typeof name !== 'string' || (meth !== 'call' && meth !== 'apply' && meth !== 'bind')) return undefined
  // funcValueNames holds POST-RENAME keys — resolve the receiver spelling first
  const key = scopes.length && isDeclared(name) ? resolveScope(name) : name
  if (!hasFunc(key) && !isFuncValueLocal(key)) return undefined
  const [thisArg, ...rest] = handlerArgs(args)
  const trivialThis = thisArg == null || typeof thisArg === 'string' ||
    (Array.isArray(thisArg) && thisArg[0] == null)
  const seq = (node) => trivialThis ? prep(node) : prep([',', thisArg, node])
  const argsSlot = (list) => list.length === 0 ? null : list.length === 1 ? list[0] : [',', ...list]
  if (meth === 'call') return seq(['()', name, argsSlot(rest)])
  if (meth === 'apply') {
    if (rest.length > 1) err('`.apply` takes (thisArg, argsArray)')
    // A literal args array expands statically — fixed-arity callees accept it
    // where a runtime spread could not.
    const arr = rest[0]
    if (Array.isArray(arr) && arr[0] === '[]' && arr.length <= 2) {
      const elems = arr.length === 1 ? [] : (Array.isArray(arr[1]) && arr[1][0] === ',') ? arr[1].slice(1) : [arr[1]]
      if (!elems.some(e => Array.isArray(e) && e[0] === '...')) return seq(['()', name, argsSlot(elems)])
    }
    return seq(['()', name, rest.length ? ['...', rest[0]] : null])
  }
  // bind(thisArg, ...pre) → an arrow closing over the pre-bound args. When the
  // callee's arity is known (a lifted top-level fn), mint EXPLICIT remaining
  // params — a rest+spread arrow would hit the non-variadic spread-call limit.
  const f = ctx.funcs.list.find(fn => fn.name === name)
  if (f && !f.rest) {
    const remaining = Math.max(0, f.sig.params.length - rest.length)
    const ps = Array.from({ length: remaining }, () => `${T}b${freshPrepareId()}`)
    return seq(['=>', ps.length ? ['()', argsSlot(ps)] : ['()', null],
      ['()', name, argsSlot([...rest, ...ps])]])
  }
  const r = `${T}b${freshPrepareId()}`
  return seq(['=>', ['()', ['...', r]], ['()', name, argsSlot([...rest, ['...', r]])]])
}
function foldJsonReviver(callee, args) {
  const isParse = callee === 'JSON.parse' ||
    (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'JSON' && callee[2] === 'parse')
  if (!isParse) return undefined
  const list = handlerArgs(args)
  if (list.length < 2 || list[1] == null) return undefined
  // A literal null/undefined reviver is spec-ignored — keep the plain parse
  // (the walk would otherwise closure-call a nullish value at runtime).
  if (Array.isArray(list[1]) && list[1][0] == null && list[1][1] == null) return undefined
  if (!ctx.transform.parse) err('JSON.parse with a reviver needs the jz pipeline (ctx.transform.parse)')
  jsonReviveTemplate ??= ctx.transform.parse(`((s, r) => {
    let walk
    walk = (val) => {
      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) val[i] = r(String(i), walk(val[i]))
      } else if (val !== null && typeof val === 'object') {
        let ks = Object.keys(val)
        for (let i = 0; i < ks.length; i++) { let k = ks[i]; val[k] = r(k, walk(val[k])) }
      }
      return val
    }
    return r("", walk(JSON.parse(s)))
  })`)
  // Fresh structural copy per site — prep mutates/renames in place.
  // (cloneNode, not structuredClone: the self-compile kernel compiles this file
  // and structuredClone is not a jz builtin.)
  const iife = cloneNode(jsonReviveTemplate)
  const arrow = Array.isArray(iife) && iife[0] === '()' && iife.length === 2 ? iife[1] : iife
  return prep(['()', arrow, [',', list[0], list[1]]])
}

// `JSON.parse(src, reviver)` — the reviver argument was silently DROPPED
// (module/json.js parses single-arg). Lower the two-arg form to an inline
// IIFE that parses, then walks the result bottom-up applying the reviver
// (ES §25.5.1 InternalizeJSONProperty). One divergence, documented: a
// reviver returning undefined ASSIGNS undefined instead of deleting the
// property (jz fixed-shape objects delete only dictionary keys).
let jsonReviveTemplate = null

function resolveCallee(callee, args) {
  if (typeof callee === 'string') {
    const local = scopes.length && isDeclared(callee)
    const resolved = local ? null : ctx.scope.chain[callee]
    if (local) return resolveScope(callee)
    if (resolved?.includes('.')) return resolved
    if (resolved && hasFunc(resolved)) return resolved
    // Chain-resolved VALUE GLOBAL — a default-imported factory product
    // (`export default make(...)` → module global `__dep$default`;
    // `import thing …; thing(x)` must closure-call that global, not fall
    // through to the bare unresolvable name).
    if (resolved && (ctx.scope.globals.has(resolved) || ctx.scope.userGlobals?.has?.(resolved))) {
      includeForCallableValue()
      return resolved
    }
    if (resolved && !resolved.includes('.')) {
      if (hasModule(resolved) && !ctx.module.imports.some(i => i[3]?.[1] === `$${resolved}`)) includeModule(resolved)
      return callee
    }
    if (prepState.depth > 0 && !resolved && !INTRINSIC_CALLEES.has(callee) && !ctx.funcs.exports[callee] && !ctx.module.imports.some(i => i[3]?.[1] === `$${callee}`))
      includeForCallableValue()
    return callee
  }
  if (Array.isArray(callee) && callee[0] === '.') {
    const [, obj, prop] = callee
    // A user binding named like a builtin namespace (`let Math = {…}`) shadows
    // it — resolve `Math.max(…)` as a method call on the local value, not the
    // builtin named-call. (Property reads route through the `.` handler's own
    // shadow check.)
    if (shadowsBuiltin(obj)) return prep(callee)
    // SIMD intrinsic namespaces resolve members directly to their emit key, ahead of
    // generic-method dispatch — they're pure namespaces (never runtime values), and
    // names like `f32x4.add` must not be mistaken for the generic `.add` (Set/Map).
    if (typeof obj === 'string' && typeof prop === 'string' && SIMD_NS.has(obj) && !(scopes.length && isDeclared(obj)) && !ctx.scope.userGlobals?.has?.(obj)) {
      includeModule(obj); return `${obj}.${prop}`
    }
    const key = typeof obj === 'string' && typeof prop === 'string' ? `${obj}.${prop}` : null
    if (key && ctx.module.hostImports?.[obj]?.[prop]) {
      const spec = ctx.module.hostImports[obj][prop]
      const alias = `${obj}$${prop}`
      addHostImport(obj, prop, alias, spec)
      return alias
    }
    if (key && includeForNamedCall(key)) return key
    if (includeForGenericMethod(prop)) return prep(callee)
    const mod = namespaceModOf(obj)
    if (mod)
      return (includeModule(mod), mod + '.' + prop)
    return prep(callee)
  }
  includeForCallableValue()
  return prep(callee)
}

function defFunc(name, node) {
  if (!Array.isArray(node) || node[0] !== '=>') return false
  // Only extract top-level functions, not nested (closures stay as values)
  if (prepState.depth > 0) return false
  // A reassigned binding must stay a mutable closure-valued global — lifting it
  // into a fixed named function froze callers onto the first value (see
  // reassignedTopLevel). 'default' can't be reassigned (export default).
  if (name !== 'default' && prepState.reassignedTopLevel?.has(name)) return false
  let [, rawParams, body] = node
  const raw = extractParams(rawParams)

  // Extract param names and defaults via shared classifier.
  // Destructured params desugar to fresh tmp + let-binding prefix in body.
  const params = [], defaults = {}, hasRest = [], bodyPrefix = []
  // Param binding census happens in the '=>' handler (defFunc's node arrives
  // PREPPED — these same params were already censused under their arrow's
  // owner id; censusing again here would double-count every param into a bar).
  for (const r of raw) {
    const c = classifyParam(r)
    if (c[PARAM_KIND] === 'rest') { hasRest.push(c[PARAM_NAME]); params.push({ name: c[PARAM_NAME], type: 'f64', rest: true }) }
    else if (c[PARAM_KIND] === 'plain') params.push({ name: c[PARAM_NAME], type: 'f64' })
    else if (c[PARAM_KIND] === 'default') {
      params.push({ name: c[PARAM_NAME], type: 'f64' })
      // defFunc's node arrives PREPPED (every caller passes prep(rhs); the body is
      // consumed as-is below) — so the default value is prepped too. Re-prepping it
      // here double-lowered an arrow default's body: its prepared 5-ary 'for' nodes
      // re-entered the 2-ary 'for' handler, shifting init/cond/step into the wrong
      // slots (surfaced by subscript 10.5.0's dispatch(ops, tail, fn = (…) => {for…}) ).
      const defVal = c[PARAM_DEFAULT]
      defaults[c[PARAM_NAME]] = defVal
      // A default OBJECT LITERAL must NOT bind the param's schema: the default
      // shape holds only on the OMITTED-argument arm — a caller supplying a
      // differently-ordered object made `o.x` read the default's slot (6→9
      // miscompile, every tier). The param's value is supplied-shape ∪
      // default-shape; fixed-slot resolution needs call-evidence channels
      // (paramReps / speculation), never this unconditional install. The
      // param stays censused unknown by the '=>' handler.
    } else {
      const tmp = `${T}p${freshPrepareId()}`
      params.push({ name: tmp, type: 'f64' })
      if (c[PARAM_KIND] === 'destruct-default') defaults[tmp] = c[PARAM_DEFAULT]   // prepped (see 'default' above)
      bodyPrefix.push(['let', ['=', c[PARAM_PATTERN], tmp]])
    }
  }

  // Prepend destructuring to body (body is already prepped, so prefix needs prep too)
  if (bodyPrefix.length) {
    const preppedPrefix = bodyPrefix.map(prep).filter(x => x != null)
    if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';')
      body = ['{}', [';', ...preppedPrefix, ...body[1].slice(1)]]
    else if (Array.isArray(body) && body[0] === '{}')
      body = ['{}', [';', ...preppedPrefix, body[1]]]
    else
      body = ['{}', [';', ...preppedPrefix, ['return', body]]]
  }

  const sig = { params, results: detectResults(body) }
  const hasDefaults = Object.keys(defaults).length > 0
  // Only main-module top-level exports become wasm-boundary exports.
  // Sub-module `export let X` is just a re-importable symbol — staying internal
  // unlocks treeshake + type specialization once main stops referencing it.
  const exported = !!ctx.funcs.exports[name] && ctx.module.moduleStack.length === 0
  const funcInfo = { name, body, exported, sig, ...(hasDefaults && { defaults }) }
  if (hasRest.length) funcInfo.rest = hasRest[0]  // track rest param name
  ctx.funcs.list.push(funcInfo)
  ctx.funcs.names.add(name)
  return true
}

// Multi-value threshold: ≤8 elements = tuple (multi-value return), >8 = memory array
const MAX_MULTI = 8

/** Collect return value arities from block AST. */
function collectReturns(node, out) {
  if (!Array.isArray(node)) return
  if (node[0] === 'return') {
    const val = node[1]
    // Array return: count elements, but only if no spreads (spreads → runtime array, not multi-value)
    if (Array.isArray(val) && val[0] === '[' && val.length > 2 && !val.some(e => Array.isArray(e) && e[0] === '...'))
      out.push(val.length - 1)
    else out.push(1)
    return
  }
  for (let i = 1; i < node.length; i++) collectReturns(node[i], out)
}

/** Detect return arity from function body. */
function detectResults(body) {
  // Expression body: [e1, e2, ...] → multi-return if ≤ threshold and no spreads
  if (Array.isArray(body) && body[0] === '[' && body.length > 2 && !body.some(e => Array.isArray(e) && e[0] === '...')) {
    const n = body.length - 1
    if (n <= MAX_MULTI) return Array(n).fill('f64')
  }
  // Block body: scan return statements
  if (Array.isArray(body) && body[0] === '{}') {
    const rets = []
    collectReturns(body, rets)
    if (rets.length) {
      const n = rets[0]
      if (n > 1 && n <= MAX_MULTI && rets.every(r => r === n)) return Array(n).fill('f64')
    }
  }
  return ['f64']
}

/** Compile-time bundling: parse + prepare an imported module, collect exports. */
function prepareModule(specifier, source) {
  includeModule('core')
  // Cycle detection
  if (ctx.module.moduleStack.includes(specifier))
    err(`Circular import: ${ctx.module.moduleStack.join(' -> ')} -> ${specifier} — break the cycle by moving the shared code into a third module both sides import`)
  // Already resolved
  if (ctx.module.resolvedModules.has(specifier)) return ctx.module.resolvedModules.get(specifier)

  ctx.module.moduleStack.push(specifier)

  // Name mangling prefix. Long specifiers (the bundler keys modules by
  // ABSOLUTE path — 40-60 byte '_Users_…' / '_home_runner_…' prefixes on every
  // symbol) compact to 'm<N>_<basename>': symbol strings shrink ~4×, which is
  // a direct hot-path win in the SELF-COMPILE — watr resolves every `call $name`
  // and `local.get $name` through name-keyed maps, paying hash+compare per
  // byte, and shared 35-byte path prefixes defeated the hash-probe early-outs.
  // Deterministic per compile (registration order); short relative specifiers
  // keep the readable form.
  const sanitized = specifier.replace(/[^a-zA-Z0-9]/g, '_')
  let prefix
  if (sanitized.length <= 24) prefix = sanitized
  else {
    if (!ctx.module.prefixIds) ctx.module.prefixIds = new Map()
    let id = ctx.module.prefixIds.get(specifier)
    if (id == null) { id = ctx.module.prefixIds.size; ctx.module.prefixIds.set(specifier, id) }
    const base = sanitized.replace(/_(js|mjs|jz)$/, '').match(/[a-zA-Z0-9]+$/)?.[0] ?? ''
    prefix = `m${id}_${base.slice(-16)}`
  }

  // Save caller state
  const savedScope = ctx.scope.chain, savedExports = ctx.funcs.exports
  const savedFuncCount = ctx.funcs.list.length  // track new funcs from this module
  const savedModulePrefix = ctx.module.currentPrefix
  ctx.scope.chain = derive(savedScope)  // inherit parent scope
  ctx.funcs.exports = Object.create(null)  // name-keyed: prototype-less (see derive)
  ctx.module.currentPrefix = prefix

  try {
  // Parse + prepare imported source (may trigger recursive imports). The parser
  // is injected via ctx.transform.parse (the host pipeline sets it) rather than
  // imported, so prepare carries no hard dependency on a concrete parser — the
  // same inversion as ctx.transform.jzify. The self-compile kernel can't parse, so it
  // pre-parses the whole graph on the host and passes the ASTs via importAsts;
  // we consult those first and only parse `source` when no AST was supplied.
  let ast = moduleAstFor(specifier)
  if (ast === undefined) {
    if (!ctx.transform.parse) err('compile-time module bundling requires ctx.transform.parse (injected by the jz pipeline)')
    ast = ctx.transform.parse(source)
  }
  if (ctx.transform.jzify) ast = ctx.transform.jzify(ast)
  ast = hoistIndexedConstLiterals(ast)
  const savedDepth = prepState.depth; prepState.depth = 0
  const savedReassigned = prepState.reassignedTopLevel
  prepState.reassignedTopLevel = scanReassignedTopLevel(ast)
  const moduleInit = prep(ast)
  prepState.reassignedTopLevel = savedReassigned
  prepState.depth = savedDepth

  // Collect exports: rename exported funcs with prefix
  const moduleExports = new Map()
  const exportLocal = (exportName, localName) => {
    const mangled = `${prefix}$${localName}`
    moduleExports.set(exportName, mangled)
    // Aliased export (`export { helper as poles }`, `export default helper`):
    // exportName ('poles'/'default') is what IMPORTERS see, but in-module call
    // sites still reference the ORIGINAL local name ('helper') verbatim — the
    // walk below rewrites references by exact string match against this same
    // map, so without a second entry keyed on localName it never finds them and
    // they dangle as a call to a function that no longer exists post-rename
    // ("'helper' is not in scope"). Un-aliased exports (`export {helper}`,
    // `exportLocal(name, name)`) already have exportName === localName, so this
    // is a no-op there.
    if (localName !== exportName) moduleExports.set(localName, mangled)
    const func = ctx.funcs.list.find(f => f.name === localName)
    if (func) { renameFunc(func, mangled); func._modulePrefix = prefix }
    if (ctx.scope.globals.has(localName)) {
      // Records carry no name — a rename is a pure Map re-key.
      ctx.scope.globals.set(mangled, ctx.scope.globals.get(localName))
      ctx.scope.globals.delete(localName)
      if (ctx.scope.userGlobals.has(localName)) { ctx.scope.userGlobals.delete(localName); ctx.scope.userGlobals.add(mangled) }
      if (ctx.scope.globalTypes.has(localName)) { ctx.scope.globalTypes.set(mangled, ctx.scope.globalTypes.get(localName)); ctx.scope.globalTypes.delete(localName) }
    }
  }
  for (const name of Object.keys(ctx.funcs.exports)) {
    const val = ctx.funcs.exports[name]
    // Default export alias: export default existingName → map 'default' to that name's mangled form
    if (name === 'default' && typeof val === 'string') {
      // Will resolve after all named exports are mangled
      continue
    }
    // Namespace re-export (`export * as ns from`): the map passes through as is.
    if (val instanceof Map) { moduleExports.set(name, val); continue }
    // Re-export alias: export { x } from './mod' → pass through inner module's mangled name
    if (typeof val === 'string') {
      if (val.startsWith(prefix + '$')) {
        moduleExports.set(name, val)
        continue
      }
      // Re-export of a binding imported from another module: val already carries
      // that other module's prefix (e.g. `__c$x`). Renaming it under our own
      // prefix would break in-module call sites that still reference the
      // original mangled name. Pass through verbatim.
      if (val.includes('$') &&
          (ctx.funcs.list.some(f => f.name === val) || ctx.scope.globals.has(val))) {
        moduleExports.set(name, val)
        continue
      }
      if (ctx.funcs.list.some(f => f.name === val || f.name === `${prefix}$${val}`) || ctx.scope.globals.has(val) || ctx.scope.globals.has(`${prefix}$${val}`)) {
        exportLocal(name, val)
        continue
      }
      moduleExports.set(name, val)
      continue
    }
    exportLocal(name, name)
  }
  // Resolve default export alias after named exports are mangled
  if (typeof ctx.funcs.exports['default'] === 'string') {
    const alias = ctx.funcs.exports['default']
    if (moduleExports.has(alias)) {
      // Already renamed as a named export
      moduleExports.set('default', moduleExports.get(alias))
    } else {
      // Not a named export — rename the function/global. `export default helper`
      // is itself an aliased export (exportName 'default' vs localName `alias`),
      // the same shape `exportLocal` already handles (incl. registering `alias`
      // as its own walk-lookup key) — delegate instead of re-deriving the same
      // logic with a narrower (and previously buggy — see exportLocal) copy.
      exportLocal('default', alias)
    }
  }

  // Rename ALL non-exported functions created during this module's prep
  // (fn property assignments like f32.parse, internal helpers like cleanInt).
  // Funcs added by nested prepareModule calls are tagged with `_modulePrefix`
  // by their own pass; skip those so prefixes don't stack (`a$b$name`).
  for (let i = savedFuncCount; i < ctx.funcs.list.length; i++) {
    const func = ctx.funcs.list[i]
    if (func.raw || func.name.startsWith(prefix + '$')) continue
    if (func._modulePrefix && func._modulePrefix !== prefix) continue
    // Cross-module func-prop lifts carry the OWNING module's prefix in their
    // name already (`__A$lex$next` written from module B) — mangling again
    // would double-prefix and break the owner's direct-call resolution. Their
    // bodies still take THIS module's reference walk below.
    if (func._ownerPrefix && func._ownerPrefix !== prefix) continue
    const mangled = `${prefix}$${func.name}`
    moduleExports.set(func.name, mangled)
    renameFunc(func, mangled)
    func._modulePrefix = prefix
  }

  // Add mangled non-exported globals to moduleExports for walk renaming
  // (e.g., module-level const/let used by functions declared before the global)
  for (const [mangled, wat] of ctx.scope.globals) {
    if (mangled.startsWith(prefix + '$')) {
      const original = mangled.slice(prefix.length + 1)
      if (!moduleExports.has(original)) moduleExports.set(original, mangled)
    }
  }

  // Rename references in function bodies — walk ALL functions created during this module's prep
  if (moduleExports.size) {
    const walk = (node, skip) => {
      if (!Array.isArray(node)) return typeof node === 'string' && !skip?.has(node) && moduleExports.has(node) ? moduleExports.get(node) : node
      if (node[0] === 'str' || node[0] == null || node[0] === '`' || node[0] === '//') return node
      if (node[0] === ':') { node[2] = walk(node[2], skip); return node }
      // Static member access: `obj.prop` — only the receiver is a reference; the
      // property name is a literal key and must not be renamed even if it collides
      // with a module-scoped binding (e.g. `IMM.reftype` where `const reftype` exists).
      if (node[0] === '.' || node[0] === '?.') { node[1] = walk(node[1], skip); return node }
      if (node[0] === '=>') {
        node[2] = walk(node[2], collectParamNames(extractParams(node[1]), new Set(skip)))
        return node
      }
      for (let j = 0; j < node.length; j++) node[j] = walk(node[j], skip)
      return node
    }
    for (let i = savedFuncCount; i < ctx.funcs.list.length; i++) {
      const func = ctx.funcs.list[i]
      if (!func.body) continue
      // Sub-module funcs already had their own walk; parent's rename map doesn't apply.
      if (func._modulePrefix && func._modulePrefix !== prefix) continue
      const funcParams = new Set(func.sig?.params?.map(p => p.name) || [])
      walk(func.body, funcParams)
      if (func.defaults) for (const [k, v] of Object.entries(func.defaults)) func.defaults[k] = walk(v, funcParams)
    }
    // Also rename init code AST
    if (moduleInit) walk(moduleInit)
  }

  // Collect sub-module init code (variable initializations) for __start
  if (moduleInit) {
    if (!ctx.module.moduleInits) ctx.module.moduleInits = []
    ctx.module.moduleInits.push(moduleInit)
    recordModuleInitFacts(moduleInit)
  }

  const result = { exports: moduleExports }
  ctx.module.resolvedModules.set(specifier, result)
  return result
  } finally {
    // ALWAYS restore caller state (FE-6): if `prep(ast)` or a recursive import threw
    // mid-prep, skipping this would leave ctx.scope/exports/prefix/moduleStack
    // corrupted for the rest of the pipeline.
    ctx.scope.chain = savedScope
    ctx.funcs.exports = savedExports
    ctx.module.currentPrefix = savedModulePrefix
    ctx.module.moduleStack.pop()
  }
}

// Scope-aware Array()/new Array() literal fold. A single argument keeps the
// length-constructor path; zero or multiple arguments have literal semantics.
const prepareArrayConstructor = args => args.length === 0 ? handlers['[]'](null)
  : args.length > 1 ? handlers['[]']([',', ...args]) : undefined

const isLit = n => Array.isArray(n) && n[0] == null