/**
 * AST → WASM IR emission.
 *
 * # Stage contract
 *   IN:  prepared AST node + ctx state (func.locals, func.repByLocal, types.typedElem, etc.)
 *   OUT: IR node (array) with `.type` ('i32' | 'f64' | 'void'). For statements, a flat
 *        list of WASM instructions (no type tag).
 *   NO-MUTATE: emit does not rewrite the AST. Side effects go to ctx.runtime.*,
 *        ctx.core.includes (via inc()), ctx.func.uniq (local naming), and ctx.features.*.
 *
 * # Dispatch
 *   `emit(node, expect?)` handles literals inline and routes arrays to ctx.core.emit[op].
 *   `emitFlat(node)` emits + drops any value (statement context; routes block bodies to emitBody).
 *   `emitBody(node)` unwraps a `{}` block and concatenates flat statement IR.
 *
 * The emitter table (`emitter` export) is copied into ctx.core.emit by reset();
 * language modules add/override entries to extend dispatch.
 *
 * Low-level IR construction helpers (typed/asF64/allocPtr/readVar/…) live in compile.js
 * and are imported below.
 *
 * @module emit
 */

import { ctx, err, inc, PTR } from './ctx.js'
import { T, VAL, valTypeOf, lookupValType, extractParams, classifyParam, findFreeVars, STMT_OPS, repOf, updateRep, repOfGlobal } from './analyze.js'
import {
  typed, asF64, asI32, asI64, asPtrOffset, asParamType, toI32, fromI64,
  NULL_IR, nullExpr, undefExpr, MAX_CLOSURE_ARITY,
  WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS,
  mkPtrIR, ptrOffsetIR, ptrTypeIR,
  isLit, litVal, isNullishLit, isPureIR, emitNum, f64rem, toNumF64,
  truthyIR, toBoolFromEmitted, isPostfix,
  isGlobal, isConst, keyValType, usesDynProps, needsDynShadow,
  temp, tempI32, allocPtr,
  boxedAddr, readVar, writeVar, isNullish,
  multiCount, loopTop, flat,
  reconstructArgsWithSpreads,
} from './ir.js'

// Current emission "expect" mode ('void' or null); set by emit(), read by compound-assignment emitters
// to decide whether to emit a value-returning or side-effect-only form.
let _expect = null

/** Emit typeof comparison: typeof x == typeCode → type-aware check. */
export function emitTypeofCmp(a, b, cmpOp) {
  let typeofExpr, code
  if (Array.isArray(a) && a[0] === 'typeof' && typeof b === 'number') { typeofExpr = a[1]; code = b }
  else if (Array.isArray(a) && a[0] === 'typeof' && Array.isArray(b) && b[0] == null) { typeofExpr = a[1]; code = b[1] }
  else return null
  if (typeof code !== 'number') return null

  const t = temp()
  const va = asF64(emit(typeofExpr))
  const eq = cmpOp === 'eq'

  if (code === -1) {
    return typed(eq
      ? ['f64.eq', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
      : ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]], 'i32')
  }
  if (code === -2) {
    inc('__ptr_type')
    const isPtr = ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
    const tt = `${T}${ctx.func.uniq++}`; ctx.func.locals.set(tt, 'i32')
    const isStr = ['i32.or',
      ['i32.eq', ['local.tee', `$${tt}`, ['call', '$__ptr_type', ['local.get', `$${t}`]]], ['i32.const', PTR.STRING]],
      ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.SSO]]]
    return typed(eq ? ['i32.and', isPtr, isStr]
      : ['i32.or', ['i32.eqz', isPtr], ['i32.eqz', isStr]], 'i32')
  }
  if (code === -3) {
    const check = isNullish(va)
    return typed(eq ? check : ['i32.eqz', check], 'i32')
  }
  if (code === -4) {
    return typed(['i32.const', eq ? 0 : 1], 'i32')
  }
  if (code === -5) {
    inc('__ptr_type')
    const isPtr = ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
    const tt = `${T}${ctx.func.uniq++}`; ctx.func.locals.set(tt, 'i32')
    const notStrFn = ['i32.and',
      ['i32.and',
        ['i32.ne', ['local.tee', `$${tt}`, ['call', '$__ptr_type', ['local.get', `$${t}`]]], ['i32.const', PTR.STRING]],
        ['i32.ne', ['local.get', `$${tt}`], ['i32.const', PTR.SSO]]],
      ['i32.ne', ['local.get', `$${tt}`], ['i32.const', PTR.CLOSURE]]]
    const notNullish = ['i32.eqz', isNullish(['local.get', `$${t}`])]
    const check = ['i32.and', ['i32.and', isPtr, notStrFn], notNullish]
    return typed(eq ? check : ['i32.eqz', check], 'i32')
  }
  if (code === -6) {
    inc('__ptr_type')
    const isPtr = ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
    const isFn = ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${t}`]], ['i32.const', PTR.CLOSURE]]
    return typed(eq ? ['i32.and', isPtr, isFn] : ['i32.or', ['i32.eqz', isPtr], ['i32.eqz', isFn]], 'i32')
  }
  if (code >= 0) {
    inc('__ptr_type')
    const isPtr = ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
    const check = ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${t}`]], ['i32.const', code]]
    return typed(eq ? ['i32.and', isPtr, check] : ['i32.or', ['i32.eqz', isPtr], ['i32.eqz', check]], 'i32')
  }
  return null
}

const CMP_SET = new Set(['>', '<', '>=', '<=', '==', '!=', '!'])
const isCmp = n => Array.isArray(n) && CMP_SET.has(n[0])

// Pointer kinds for which JS `==` / `!=` is pure reference equality — i.e. i64 bit
// compare of the NaN-box is equivalent to __eq. Excludes STRING (content compare for
// heap strings) and BIGINT (content compare).
const REF_EQ_KINDS = new Set([
  VAL.ARRAY, VAL.OBJECT, VAL.SET, VAL.MAP,
  VAL.BUFFER, VAL.TYPED, VAL.CLOSURE, VAL.REGEX,
])

// === Flow-sensitive type refinement ===
// Map typeof code (from resolveTypeof in prepare.js) → VAL kind. Undef/boolean/object have no
// single VAL refinement, so they're excluded. String/number/function do.
const TYPEOF_CODE_TO_VAL = { [-1]: VAL.NUMBER, [-2]: VAL.STRING, [-6]: VAL.CLOSURE }

/** Extract refinements from a boolean condition AST.
 *  `sense`: true = refine for then-branch, false = refine for else-branch (i.e. cond inverted).
 *  Returns a Map<name, VAL>. Walks && / || / ! accordingly. */
function extractRefinements(cond, out, sense = true) {
  if (!Array.isArray(cond)) return out
  const op = cond[0]
  // ! flips sense
  if (op === '!') return extractRefinements(cond[1], out, !sense)
  // && under positive sense refines with union of both branches.
  // || under negative sense (De Morgan) similarly refines the else-branch.
  if (op === '&&' && sense)  { extractRefinements(cond[1], out, true);  extractRefinements(cond[2], out, true);  return out }
  if (op === '||' && !sense) { extractRefinements(cond[1], out, false); extractRefinements(cond[2], out, false); return out }
  // typeof x == 'number' | 'string' | 'function' — sense must be positive for "==", negative for "!="
  if ((op === '==' || op === '===' || op === '!=' || op === '!==')) {
    const eq = (op === '==' || op === '===')
    const wantPositive = eq ? sense : !sense
    if (!wantPositive) return out
    const a = cond[1], b = cond[2]
    const pair = Array.isArray(a) && a[0] === 'typeof' ? [a[1], b]
      : Array.isArray(b) && b[0] === 'typeof' ? [b[1], a] : null
    if (pair && typeof pair[0] === 'string' && Array.isArray(pair[1]) && pair[1][0] == null) {
      const val = TYPEOF_CODE_TO_VAL[pair[1][1]]
      if (val) out.set(pair[0], val)
    }
    return out
  }
  // Array.isArray(x) — only refines under positive sense.
  // Callee may be the flattened string 'Array.isArray' or the raw ['.', 'Array', 'isArray'] pair.
  if (op === '()' && sense && typeof cond[2] === 'string') {
    const callee = cond[1]
    const isArr = callee === 'Array.isArray'
      || (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Array' && callee[2] === 'isArray')
    if (isArr) { out.set(cond[2], VAL.ARRAY); return out }
  }
  return out
}

/** Detect whether `name` is written to (=, +=, ++, --, etc.) anywhere within `body`.
 *  Conservative over-reject: if unsure, treat as written.
 *  `let`/`const` declarations are NOT reassignments — only the initializer expressions
 *  inside them are scanned. (Treating `let g = ...` as a write of `g` would defeat A3.) */
export function isReassigned(body, name) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === '=' || op === '+=' || op === '-=' || op === '*=' || op === '/=' || op === '%='
      || op === '&=' || op === '|=' || op === '^=' || op === '<<=' || op === '>>=' || op === '>>>='
      || op === '||=' || op === '&&=' || op === '??=') {
    if (body[1] === name) return true
  }
  if ((op === '++' || op === '--') && body[1] === name) return true
  if (op === 'let' || op === 'const') {
    // Each decl item is either a bare name (string) or `['=', pattern, init]`.
    // Only the init expression can contain real reassignments — recurse into it only.
    for (let i = 1; i < body.length; i++) {
      const d = body[i]
      if (Array.isArray(d) && d[0] === '=' && d[2] != null && isReassigned(d[2], name)) return true
    }
    return false
  }
  for (let i = 1; i < body.length; i++) if (isReassigned(body[i], name)) return true
  return false
}

/** Does `body` always exit the enclosing scope (return / throw / break / continue)?
 *  Used for early-return refinement: after `if (!guard) return`, `guard` holds for the rest. */
function isTerminator(body) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'return' || op === 'throw' || op === 'break' || op === 'continue') return true
  // Block body: {} or ; — terminator if it ends with a terminator statement.
  if (op === '{}' || op === ';') {
    for (let i = body.length - 1; i >= 1; i--) {
      const s = body[i]
      if (s == null) continue
      return isTerminator(s)
    }
    return false
  }
  return false
}

/** Apply refinements for the duration of `fn()`. Restores prior state on return/throw. */
function withRefinements(refs, body, fn) {
  if (!refs || refs.size === 0) return fn()
  const cur = ctx.func.refinements
  // Drop names that are reassigned in the body — refinement would be unsound.
  const saved = []
  for (const [name, val] of refs) {
    if (isReassigned(body, name)) continue
    saved.push([name, cur.get(name)])
    cur.set(name, val)
  }
  try { return fn() }
  finally {
    for (const [name, prev] of saved) {
      if (prev === undefined) cur.delete(name); else cur.set(name, prev)
    }
  }
}

/** Coerce an AST node to an i32 boolean, folding && / || at the boolean boundary. */
export function toBool(node) {
  const op = Array.isArray(node) ? node[0] : null
  if (CMP_SET.has(op)) return emit(node)
  if (op === '&&') {
    const la = toBool(node[1]), lb = toBool(node[2])
    if (isCmp(node[1]) && isCmp(node[2])) return typed(['i32.and', la, lb], 'i32')
    return typed(['if', ['result', 'i32'], la, ['then', lb], ['else', ['i32.const', 0]]], 'i32')
  }
  if (op === '||') {
    const la = toBool(node[1]), lb = toBool(node[2])
    if (isCmp(node[1]) && isCmp(node[2])) return typed(['i32.or', la, lb], 'i32')
    return typed(['if', ['result', 'i32'], la, ['then', ['i32.const', 1]], ['else', lb]], 'i32')
  }
  return toBoolFromEmitted(emit(node))
}

/** Coerce an emitted arg IR to match a callee param. Param may carry ptrKind (pointer-ABI
 *  i32 offset), else falls back to numeric WASM type coercion. */
function emitArgForParam(ir, param) {
  if (param?.ptrKind != null) return ptrOffsetIR(ir, param.ptrKind)
  return asParamType(ir, param?.type)
}

/**
 * Materialize a multi-value function call as a heap array.
 * Call → store each result in temp → copy to allocated array → return pointer.
 */
export function materializeMulti(callNode) {
  const name = callNode[1]
  const func = ctx.func.map.get(name)
  const n = func.sig.results.length
  const rawArgs = callNode.slice(2)
  const argList = rawArgs.length === 1 && Array.isArray(rawArgs[0]) && rawArgs[0][0] === ','
    ? rawArgs[0].slice(1) : rawArgs
  const emittedArgs = argList.map((a, k) => emitArgForParam(emit(a), func.sig.params[k]))
  while (emittedArgs.length < func.sig.params.length)
    emittedArgs.push(func.sig.params[emittedArgs.length].type === 'i32' ? typed(['i32.const', 0], 'i32') : nullExpr())
  const temps = Array.from({ length: n }, () => temp())
  const out = allocPtr({ type: 1, len: n, tag: 'marr' })
  const ir = [out.init, ['call', `$${name}`, ...emittedArgs]]
  for (let k = n - 1; k >= 0; k--) ir.push(['local.set', `$${temps[k]}`])
  for (let k = 0; k < n; k++)
    ir.push(['f64.store', ['i32.add', ['local.get', `$${out.local}`], ['i32.const', k * 8]], ['local.get', `$${temps[k]}`]])
  ir.push(out.ptr)
  return typed(['block', ['result', 'f64'], ...ir], 'f64')
}

/** Emit let/const initializations as typed local.set instructions. */
export function emitDecl(...inits) {
  const result = []
  for (let ii = 0; ii < inits.length; ii++) {
    const i = inits[ii]
    if (typeof i === 'string') {
      const undef = nullExpr()
      if (ctx.func.boxed.has(i)) {
        const cell = ctx.func.boxed.get(i)
        ctx.func.locals.set(cell, 'i32')
        result.push(
          ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
          ['f64.store', ['local.get', `$${cell}`], undef])
        continue
      }
      if (isGlobal(i)) {
        if (!ctx.scope.globalTypes.has(i)) result.push(['global.set', `$${i}`, undef])
        continue
      }
      result.push(['local.set', `$${i}`, undef])
      continue
    }
    if (!Array.isArray(i) || i[0] !== '=') continue
    const [, name, init] = i
    if (typeof name !== 'string' || init == null) continue

    // Multi-value ephemeral destructuring — skip heap alloc when temp is
    // assigned from a multi-value call then immediately destructured element-by-element.
    if (name.startsWith(T) && Array.isArray(init) && init[0] === '()' && typeof init[1] === 'string'
      && ctx.func.names?.has(init[1])) {
      const func = ctx.func.map.get(init[1])
      const n = func?.sig.results.length
      if (n > 1) {
        const targets = []
        let match = true
        for (let k = 0; k < n && match; k++) {
          const next = inits[ii + 1 + k]
          if (!Array.isArray(next) || next[0] !== '=' || typeof next[1] !== 'string') { match = false; break }
          const rhs = next[2]
          if (!Array.isArray(rhs) || rhs[0] !== '[]' || rhs[1] !== name) { match = false; break }
          const idx = rhs[2]
          if (!Array.isArray(idx) || idx[0] != null || idx[1] !== k) { match = false; break }
          if (ctx.func.boxed.has(next[1]) || isGlobal(next[1])) { match = false; break }
          targets.push(next[1])
        }
        if (match && targets.length === n) {
          const rawArgs = init.slice(2)
          const argList = rawArgs.length === 1 && Array.isArray(rawArgs[0]) && rawArgs[0][0] === ','
            ? rawArgs[0].slice(1) : rawArgs
          const emittedArgs = argList.map((a, k) => emitArgForParam(emit(a), func.sig.params[k]))
          while (emittedArgs.length < func.sig.params.length)
            emittedArgs.push(func.sig.params[emittedArgs.length].type === 'i32' ? typed(['i32.const', 0], 'i32') : nullExpr())
          result.push(['call', `$${init[1]}`, ...emittedArgs])
          for (let k = n - 1; k >= 0; k--)
            result.push(['local.set', `$${targets[k]}`])
          ii += n
          continue
        }
      }
    }
    const isObjLit = Array.isArray(init) && init[0] === '{}'
    if (isObjLit) ctx.schema.targetStack.push(name)
    const val = emit(init)
    if (isObjLit) ctx.schema.targetStack.pop()
    // Direct-call dispatch for const-bound, non-escaping local closures: skip call_indirect.
    // Gate: not boxed (no mutable cross-fn capture), not global, not reassigned in this body.
    // isReassigned is conservative across nested arrow shadows — we miss the optimization
    // rather than emit a wrong direct call.
    if (val?.closureBodyName && !ctx.func.boxed.has(name) && !isGlobal(name)
        && ctx.func.body && !isReassigned(ctx.func.body, name)) {
      if (!ctx.func.directClosures) ctx.func.directClosures = new Map()
      ctx.func.directClosures.set(name, val.closureBodyName)
    }
    if (ctx.func.boxed.has(name)) {
      const cell = ctx.func.boxed.get(name)
      ctx.func.locals.set(cell, 'i32')
      result.push(
        ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
        ['f64.store', ['local.get', `$${cell}`], asF64(val)])
      continue
    }
    if (isGlobal(name)) {
      // Unboxed pointer const globals carry the raw i32 offset; init coerces via asPtrOffset.
      const grep = repOfGlobal(name)
      if (grep?.ptrKind != null) {
        result.push(['global.set', `$${name}`, asPtrOffset(val, grep.ptrKind)])
        continue
      }
      // Pre-folded numeric const globals have their init baked into the decl — skip.
      if (ctx.scope.globalTypes.has(name)) continue
      result.push(['global.set', `$${name}`, asF64(val)])
      continue
    }
    const localType = ctx.func.locals.get(name) || 'f64'
    let ptrKind = repOf(name)?.ptrKind
    // Inherit ptrKind from a pointer-ABI RHS: destructure temps (`__d0 = v`) and other
    // fresh let-bindings whose init is already an unboxed pointer. Without this, readVar
    // returns an untyped i32 local.get and later `asF64` emits a numeric convert instead
    // of a ptr-rebox. Safe because emitDecl runs once per let/const binding.
    if (ptrKind == null && val.ptrKind != null && localType === 'i32' && !ctx.func.boxed?.has(name)) {
      updateRep(name, { ptrKind: val.ptrKind })
      ptrKind = val.ptrKind
      if (val.ptrAux != null) {
        updateRep(name, { ptrAux: val.ptrAux })
        // OBJECT-only: aux *is* the schemaId; mirror to ctx.schema.vars + rep.schemaId so
        // .prop slot resolution sees a precise binding. TYPED/CLOSURE aux carries other
        // semantics (elem code / funcIdx) and must not leak into schema lookups.
        if (val.ptrKind === VAL.OBJECT && !ctx.schema.vars?.has(name)) {
          ctx.schema.vars.set(name, val.ptrAux)
          updateRep(name, { schemaId: val.ptrAux })
        }
      }
    }
    let coerced
    if (ptrKind != null) {
      // Unboxed pointer local — extract i32 offset from NaN-boxed f64 via reinterpret, not numeric trunc.
      // CLOSURE init carries funcIdx in val.closureFuncIdx; persist it on the rep so a later
      // asF64 (escape: store, return, indirect-call rebox) reconstructs the correct table slot.
      if (ptrKind === VAL.CLOSURE && val.closureFuncIdx != null && repOf(name)?.ptrAux == null)
        updateRep(name, { ptrAux: val.closureFuncIdx })
      coerced = val.ptrKind === ptrKind ? val
        : typed(['i32.wrap_i64', ['i64.reinterpret_f64', asF64(val)]], 'i32')
    } else {
      coerced = localType === 'f64' ? asF64(val) : asI32(val)
    }
    if (!(isLit(coerced) && coerced[1] === 0 && !ctx.func.stack.length))
      result.push(['local.set', `$${name}`, coerced])

    const schemaId = ctx.schema.idOf?.(name)
    if (ctx.func.localProps?.has(name) && schemaId != null) {
      const schema = ctx.schema.resolve(name)
      if (schema?.[0] === '__inner__') {
        inc('__alloc', '__mkptr')
        const bt = `${T}bx${ctx.func.uniq++}`
        ctx.func.locals.set(bt, 'i32')
        const innerName = `${name}${T}inner`
        ctx.func.locals.set(innerName, 'f64')
        result.push(
          ['local.set', `$${innerName}`, ['local.get', `$${name}`]],
          ['local.set', `$${bt}`, ['call', '$__alloc', ['i32.const', schema.length * 8]]],
          ['f64.store', ['local.get', `$${bt}`], ['local.get', `$${name}`]],
          ...schema.slice(1).map((_, j) =>
            ['f64.store', ['i32.add', ['local.get', `$${bt}`], ['i32.const', (j + 1) * 8]], ['f64.const', 0]]),
          ['local.set', `$${name}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${bt}`])])
      }
    }
  }
  return result.length === 0 ? null : result.length === 1 ? result[0] : result
}

/**
 * Build an array from items, handling ['__spread', expr] markers.
 * Split into sections (normal arrays and spreads), then copy all into result.
 */
export function buildArrayWithSpreads(items) {
  const spreads = []
  for (let i = 0; i < items.length; i++) {
    if (Array.isArray(items[i]) && items[i][0] === '__spread') {
      spreads.push({ pos: i, expr: items[i][1] })
    }
  }

  if (spreads.length === 0) {
    return emit(['[', ...items])
  }

  const sections = []
  let currentArray = []

  for (let i = 0; i < items.length; i++) {
    if (Array.isArray(items[i]) && items[i][0] === '__spread') {
      if (currentArray.length > 0) {
        sections.push({ type: 'array', items: currentArray })
        currentArray = []
      }
      sections.push({ type: 'spread', expr: items[i][1] })
    } else {
      currentArray.push(items[i])
    }
  }
  if (currentArray.length > 0) {
    sections.push({ type: 'array', items: currentArray })
  }

  if (sections.length === 1) {
    const sec = sections[0]
    return emit(sec.type === 'array' ? ['[', ...sec.items] : sec.expr)
  }

  const len = tempI32('len')
  const pos = tempI32('pos')
  const out = allocPtr({ type: 1, len: ['local.get', `$${len}`], tag: 'arr' })
  const result = out.local

  const ir = [
    ['local.set', `$${len}`, ['i32.const', 0]],
  ]

  inc('__len', '__ptr_offset')
  for (const sec of sections) {
    if (sec.type === 'spread') {
      sec.local = `${T}sp${ctx.func.uniq++}`
      ctx.func.locals.set(sec.local, 'f64')
      sec.lenLocal = `${T}spl${ctx.func.uniq++}`
      ctx.func.locals.set(sec.lenLocal, 'i32')
      sec.vt = valTypeOf(sec.expr)
      // ARRAY-known source: hoist data base and inline len/load (skip per-iter dispatch).
      if (sec.vt === VAL.ARRAY && !multiCount(sec.expr)) {
        sec.baseLocal = `${T}spb${ctx.func.uniq++}`
        ctx.func.locals.set(sec.baseLocal, 'i32')
      }
      const n = multiCount(sec.expr)
      ir.push(['local.set', `$${sec.local}`, n ? materializeMulti(sec.expr) : asF64(emit(sec.expr))])
      if (sec.baseLocal) {
        ir.push(['local.set', `$${sec.baseLocal}`, ['call', '$__ptr_offset', ['local.get', `$${sec.local}`]]])
        ir.push(['local.set', `$${sec.lenLocal}`, ['i32.load', ['i32.sub', ['local.get', `$${sec.baseLocal}`], ['i32.const', 8]]]])
      } else {
        // Cache __len once per spread; reused below for total-len sum and inner copy bound.
        ir.push(['local.set', `$${sec.lenLocal}`, ['call', '$__len', ['local.get', `$${sec.local}`]]])
      }
    }
  }

  for (const sec of sections) {
    if (sec.type === 'array') {
      ir.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['i32.const', sec.items.length]]])
    } else {
      ir.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['local.get', `$${sec.lenLocal}`]]])
    }
  }

  ir.push(out.init, ['local.set', `$${pos}`, ['i32.const', 0]])

  for (const sec of sections) {
    if (sec.type === 'array') {
      for (let i = 0; i < sec.items.length; i++) {
        ir.push(
          ['f64.store',
            ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]],
            asF64(emit(sec.items[i]))],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]]
        )
      }
    } else {
      const slen = sec.lenLocal, sidx = `${T}sidx${ctx.func.uniq++}`
      ctx.func.locals.set(sidx, 'i32')
      const loopId = ctx.func.uniq++
      const elemLoad = sec.baseLocal
        ? ['f64.load', ['i32.add', ['local.get', `$${sec.baseLocal}`], ['i32.shl', ['local.get', `$${sidx}`], ['i32.const', 3]]]]
        : ctx.module.modules['string']
          ? ['if', ['result', 'f64'],
            ['i32.or',
              ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${sec.local}`]], ['i32.const', PTR.STRING]],
              ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${sec.local}`]], ['i32.const', PTR.SSO]]],
            ['then', (inc('__str_idx'), ['call', '$__str_idx', ['local.get', `$${sec.local}`], ['local.get', `$${sidx}`]])],
            ['else', (inc('__typed_idx'), ['call', '$__typed_idx', ['local.get', `$${sec.local}`], ['local.get', `$${sidx}`]])]]
          : (inc('__typed_idx'), ['call', '$__typed_idx', ['local.get', `$${sec.local}`], ['local.get', `$${sidx}`]])
      ir.push(
        ['local.set', `$${sidx}`, ['i32.const', 0]],
        ['block', `$break${loopId}`, ['loop', `$loop${loopId}`,
          ['br_if', `$break${loopId}`, ['i32.ge_s', ['local.get', `$${sidx}`], ['local.get', `$${slen}`]]],
          ['f64.store',
            ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]],
            elemLoad],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]],
          ['local.set', `$${sidx}`, ['i32.add', ['local.get', `$${sidx}`], ['i32.const', 1]]],
          ['br', `$loop${loopId}`]]]
      )
    }
  }

  ir.push(out.ptr)
  return typed(['block', ['result', 'f64'], ...ir], 'f64')
}

/** Check if node is a block body (statement list, not object literal/expression) */
const isBlockBody = n => Array.isArray(n) && n[0] === '{}' && n.length === 2 && Array.isArray(n[1]) && STMT_OPS.has(n[1]?.[0])

/** Emit node in void context: emit + drop any value. Block bodies route through emitBody. */
export function emitFlat(node) {
  if (isBlockBody(node)) return emitBody(node)
  const ir = emit(node, 'void')
  const items = flat(ir)
  if (ir?.type && ir.type !== 'void') items.push('drop')
  return items
}

/** Emit block body as flat list of WASM instructions. Unwraps {} and delegates to emitFlat per statement.
 *  Also drives early-return refinement: `if (!guard) return/throw` narrows `guard` for the
 *  rest of the enclosing block. Refinements added here are rolled back on block exit. */
export function emitBody(node) {
  const inner = node[1]
  const stmts = Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : [inner]
  const out = []
  const accumulated = []
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]
    if (s == null || typeof s === 'number') continue
    out.push(...emitFlat(s))
    // After an `if (cond) terminator` (no else), narrow types from !cond for subsequent statements.
    // Skip names that are reassigned later — refinement would be unsound past the assignment.
    if (Array.isArray(s) && s[0] === 'if' && s[3] == null && isTerminator(s[2])) {
      const refs = extractRefinements(s[1], new Map(), false)
      for (const [name, val] of refs) {
        let reassigned = false
        for (let j = i + 1; j < stmts.length; j++)
          if (isReassigned(stmts[j], name)) { reassigned = true; break }
        if (reassigned) continue
        accumulated.push([name, ctx.func.refinements.get(name)])
        ctx.func.refinements.set(name, val)
      }
    }
  }
  // Restore prior refinements on block exit.
  for (let i = accumulated.length - 1; i >= 0; i--) {
    const [name, prev] = accumulated[i]
    if (prev === undefined) ctx.func.refinements.delete(name); else ctx.func.refinements.set(name, prev)
  }
  return out
}

/** Comparison op factory with constant folding. */
const cmpOp = (i32op, f64op, fn) => (a, b) => {
  const va = emit(a), vb = emit(b)
  if (isLit(va) && isLit(vb)) return emitNum(fn(litVal(va), litVal(vb)) ? 1 : 0)
  return va.type === 'i32' && vb.type === 'i32'
    ? typed([`i32.${i32op}`, va, vb], 'i32') : typed([`f64.${f64op}`, asF64(va), asF64(vb)], 'i32')
}

/** Compound assignment: read → op → write back (via readVar/writeVar). */
function compoundAssign(name, val, f64op, i32op) {
  if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
  const void_ = _expect === 'void'
  const va = readVar(name), vb = emit(val)
  if (i32op && va.type === 'i32' && vb.type === 'i32')
    return writeVar(name, i32op(va, vb), void_)
  return writeVar(name, f64op(asF64(va), asF64(vb)), void_)
}

/**
 * Core emitter table. Maps AST ops to WASM IR generators.
 * ctx.core.emit is seeded with a flat copy of this object on reset;
 * modules add or override ops on ctx.core.emit directly.
 * @type {Record<string, (...args: any[]) => Array>}
 */
export const emitter = {
  // === Spread operator ===
  // Note: spread is handled specially in call contexts; this catches stray uses
  '...': () => err('Spread (...) can only be used in function/method calls or array literals'),

  // === Statements ===

  ';': (...args) => {
    const out = []
    for (const a of args) {
      const r = emit(a, 'void')
      if (r == null) continue
      out.push(...flat(r))
      if (r?.type && r.type !== 'void') out.push('drop')
    }
    return out
  },
  '{': (...args) => args.map(emit).filter(x => x != null),
  ',': (...args) => {
    const results = args.map(emit).filter(x => x != null)
    if (results.length === 0) return null
    if (results.length === 1) return results[0]
    const last = results[results.length - 1]
    // Flatten: multi-instruction arrays (from ';') need spreading, typed nodes need drop
    const spread = r => Array.isArray(r) && Array.isArray(r[0]) ? r : [r]
    const dropSpread = r => r.type ? [['drop', r]] : spread(r)
    // If last expression is void (store, etc.), add explicit return value
    if (!last.type) {
      return typed(['block', ['result', 'f64'],
        ...results.flatMap(dropSpread),
        ['f64.const', 0]], 'f64')
    }
    return typed(['block', ['result', last.type],
      ...results.slice(0, -1).flatMap(dropSpread), last], last.type)
  },
  'let': emitDecl,
  'const': emitDecl,
  'export': () => null,
  // 'block' can appear from jzify transforming labeled blocks or as WASM block IR
  'block': (...args) => {
    // WASM block IR: first arg is ['result', type] → pass through, preserve type
    if (Array.isArray(args[0]) && args[0][0] === 'result')
      return typed(['block', ...args], args[0][1])
    const inner = args.length === 1 ? args[0] : [';', ...args]
    return emitFlat(['{}', inner])
  },

  'throw': expr => {
    ctx.runtime.throws = true
    const thrown = temp()
    return typed(['block',
      ['local.set', `$${thrown}`, asF64(emit(expr))],
      ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['local.get', `$${thrown}`]]],
      ['throw', '$__jz_err', ['local.get', `$${thrown}`]]], 'void')
  },

  'catch': (body, errName, handler) => {
    ctx.runtime.throws = true
    const id = ctx.func.uniq++
    ctx.func.locals.set(errName, 'f64')
    const prev = ctx.func.inTry; ctx.func.inTry = true
    let bodyIR; try { bodyIR = emitFlat(body) } finally { ctx.func.inTry = prev }
    const handlerIR = emitFlat(handler)
    return typed(['block', `$outer${id}`, ['result', 'f64'],
      ['block', `$catch${id}`, ['result', 'f64'],
        ['try_table', ['catch', '$__jz_err', `$catch${id}`],
          ...bodyIR],
        ['f64.const', 0],
        ['br', `$outer${id}`]],
      ['local.set', `$${errName}`],
      ...handlerIR,
      ['f64.const', 0]], 'f64')
  },

  'return': expr => {
    if (ctx.func.current?.results.length > 1 && Array.isArray(expr) && expr[0] === '[')
      return typed(['return', ...expr.slice(1).map(e => asF64(emit(e)))], 'void')
    if (expr == null) return typed(['return', NULL_IR], 'void')
    const rt = ctx.func.current?.results[0] || 'f64'
    const pk = ctx.func.current?.ptrKind
    const ir = pk != null ? asPtrOffset(emit(expr), pk) : asParamType(emit(expr), rt)
    if (!ctx.func.inTry && !ctx.transform.noTailCall &&
        Array.isArray(ir) && ir[0] === 'call' && typeof ir[1] === 'string')
      return typed(['return_call', ...ir.slice(1)], 'void')
    return typed(['return', ir], 'void')
  },

  // === Assignment ===

  '=': (name, val) => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
    // Array index assignment: arr[i] = x
    if (Array.isArray(name) && name[0] === '[]') {
      const [, arr, idx] = name
      const keyType = keyValType(idx)
      const useRuntimeKeyDispatch = keyType == null || (typeof idx === 'string' && keyType !== VAL.STRING)
      const keyExpr = asF64(emit(idx))
      const valueExpr = asF64(emit(val))
      const storeArrayValue = (arrExpr, idxNode, persist) => {
        const arrTmp = `${T}asi${ctx.func.uniq++}`
        const idxTmp = `${T}asj${ctx.func.uniq++}`
        const valTmp = `${T}asv${ctx.func.uniq++}`
        ctx.func.locals.set(arrTmp, 'f64')
        ctx.func.locals.set(idxTmp, 'i32')
        ctx.func.locals.set(valTmp, 'f64')
        inc('__arr_set_idx_ptr')
        const body = [
          ['local.set', `$${arrTmp}`, arrExpr],
          ['local.set', `$${idxTmp}`, asI32(typed(idxNode, 'f64'))],
          ['local.set', `$${valTmp}`, valueExpr],
          ['local.set', `$${arrTmp}`, ['call', '$__arr_set_idx_ptr', ['local.get', `$${arrTmp}`], ['local.get', `$${idxTmp}`], ['local.get', `$${valTmp}`]]],
        ]
        if (persist) body.push(persist(['local.get', `$${arrTmp}`]))
        body.push(['local.get', `$${valTmp}`])
        return typed(['block', ['result', 'f64'], ...body], 'f64')
      }
      const setDyn = () => {
        inc('__dyn_set')
        return typed(['call', '$__dyn_set', asF64(emit(arr)), keyExpr, valueExpr], 'f64')
      }
      const dispatchKey = (numericIR) => {
        const keyTmp = temp()
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${keyTmp}`, keyExpr],
          ['if', ['result', 'f64'], ['call', '$__is_str_key', ['local.get', `$${keyTmp}`]],
            ['then', ['call', '$__dyn_set', asF64(emit(arr)), ['local.get', `$${keyTmp}`], valueExpr]],
            ['else', numericIR(['local.get', `$${keyTmp}`])]]], 'f64')
      }
      // Literal string key on schema-known object → direct payload slot write (skip __dyn_set)
      const litKey = Array.isArray(idx) && idx[0] === 'str' && typeof idx[1] === 'string' ? idx[1] : null
      if (litKey != null && typeof arr === 'string' && ctx.schema.find) {
        const slot = ctx.schema.find(arr, litKey, true)
        if (slot >= 0) {
          const t = temp()
          return typed(['block', ['result', 'f64'],
            ['local.set', `$${t}`, valueExpr],
            ['f64.store',
              ['i32.add', ptrOffsetIR(asF64(emit(arr)), lookupValType(arr) || VAL.OBJECT), ['i32.const', slot * 8]],
              ['local.get', `$${t}`]],
            ['local.get', `$${t}`]], 'f64')
        }
      }
      if (keyType === VAL.STRING) return setDyn()
      if (typeof arr === 'string' && ctx.core.emit['.typed:[]='] &&
          lookupValType(arr) === 'typed') {
        const r = ctx.core.emit['.typed:[]=']?.(arr, idx, val)
        if (r) return r
      }
      if (typeof arr === 'string' && ctx.schema.isBoxed?.(arr)) {
        const inner = ctx.schema.emitInner(arr)
        const arrVT = lookupValType(arr) || VAL.OBJECT
        const storeNumeric = keyNode => storeArrayValue(inner, keyNode, ptr =>
          ['f64.store', ptrOffsetIR(asF64(emit(arr)), arrVT), ptr])
        if (useRuntimeKeyDispatch) {
          inc('__dyn_set', '__is_str_key')
          return dispatchKey(storeNumeric)
        }
        return typed(storeNumeric(keyExpr), 'f64')
      }
      const va = emit(arr), vi = asI32(emit(idx)), vv = valueExpr, t = temp()
      if (typeof arr === 'string' && keyValType(arr) === VAL.ARRAY) {
        const persist = ptr => {
          if (ctx.func.boxed?.has(arr)) return ['f64.store', boxedAddr(arr), ptr]
          if (isGlobal(arr)) return ['global.set', `$${arr}`, ptr]
          return ['local.set', `$${arr}`, ptr]
        }
        if (useRuntimeKeyDispatch) {
          inc('__dyn_set', '__is_str_key')
          return dispatchKey(keyNode => storeArrayValue(asF64(va), keyNode, persist))
        }
        return storeArrayValue(asF64(va), keyExpr, persist)
      }
      // arr is non-ARRAY here (VAL.ARRAY branch was taken above); safe to skip forwarding.
      const arrVT = (typeof arr === 'string' ? lookupValType(arr) : null) || VAL.OBJECT
      if (useRuntimeKeyDispatch) {
        inc('__dyn_set', '__is_str_key')
        return dispatchKey(keyNode => {
          const keyI32 = asI32(typed(keyNode, 'f64'))
          return ['block', ['result', 'f64'],
            ['local.set', `$${t}`, vv],
            ['f64.store', ['i32.add', ptrOffsetIR(asF64(va), arrVT), ['i32.shl', keyI32, ['i32.const', 3]]], ['local.get', `$${t}`]],
            ['local.get', `$${t}`]]
        })
      }
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, vv],
        ['f64.store', ['i32.add', ptrOffsetIR(asF64(va), arrVT), ['i32.shl', vi, ['i32.const', 3]]], ['local.get', `$${t}`]],
        ['local.get', `$${t}`]], 'f64')
    }
    // Object property assignment: obj.prop = x
    if (Array.isArray(name) && name[0] === '.') {
      const [, obj, prop] = name
      // Schema-based object → f64.store at fixed offset.
      // safe=true: skip structural subtyping when variable's type is unknown,
      // otherwise a slot write could clobber an array/string's payload.
      if (typeof obj === 'string' && ctx.schema.find) {
        const idx = ctx.schema.find(obj, prop, true)
        if (idx >= 0) {
          const va = emit(obj), vv = asF64(emit(val)), t = temp()
          const shadow = needsDynShadow(obj)
          if (shadow) inc('__dyn_set')
          const stmts = [
            ['local.set', `$${t}`, vv],
            ['f64.store', ['i32.add', ptrOffsetIR(asF64(va), lookupValType(obj) || VAL.OBJECT), ['i32.const', idx * 8]], ['local.get', `$${t}`]],
          ]
          if (shadow)
            stmts.push(['drop', ['call', '$__dyn_set', asF64(va), asF64(emit(['str', prop])), ['local.get', `$${t}`]]])
          stmts.push(['local.get', `$${t}`])
          return typed(['block', ['result', 'f64'], ...stmts], 'f64')
        }
      }
      if (typeof obj === 'string') {
        const objType = keyValType(obj)
        if (usesDynProps(objType)) {
          inc('__dyn_set')
          return typed(['call', '$__dyn_set', asF64(emit(obj)), asF64(emit(['str', prop])), asF64(emit(val))], 'f64')
        }
        if (objType == null) ctx.features.external = true
        inc('__hash_set')
        const setCall = typed(['call', '$__hash_set', asF64(emit(obj)), asF64(emit(['str', prop])), asF64(emit(val))], 'f64')
        if (isGlobal(obj)) return typed(['block', ['result', 'f64'],
          ['global.set', `$${obj}`, setCall], ['global.get', `$${obj}`]], 'f64')
        return typed(['local.tee', `$${obj}`, setCall], 'f64')
      }
      ctx.features.external = true
      inc('__dyn_set')
      return typed(['call', '$__dyn_set', asF64(emit(obj)), asF64(emit(['str', prop])), asF64(emit(val))], 'f64')
    }
    if (typeof name !== 'string') err(`Assignment to non-variable: ${JSON.stringify(name)}`)
    const void_ = _expect === 'void'
    return writeVar(name, emit(val), void_)
  },

  // Compound assignments: read-modify-write with type coercion
  '+=': (name, val) => {
    // String concatenation: desugar to name = name + val (+ handler knows about strings)
    const vt = typeof name === 'string' ? keyValType(name) : null
    const vtB = keyValType(val)
    if (vt === VAL.STRING || vtB === VAL.STRING) return emit(['=', name, ['+', name, val]])
    return compoundAssign(name, val, (a, b) => typed(['f64.add', a, b], 'f64'), (a, b) => typed(['i32.add', a, b], 'i32'))
  },
  ...Object.fromEntries([
    ['-=', 'sub'], ['*=', 'mul'], ['/=', 'div'],
  ].map(([op, fn]) => [op, (name, val) => compoundAssign(name, val,
    (a, b) => typed([`f64.${fn}`, a, b], 'f64'),
    fn === 'div' ? null : (a, b) => typed([`i32.${fn}`, a, b], 'i32')
  )])),
  '%=': (name, val) => compoundAssign(name, val, f64rem, (a, b) => typed(['i32.rem_s', a, b], 'i32')),

  // Bitwise compound assignments: i32 normally, i64 when either operand is BigInt
  ...Object.fromEntries([
    ['&=', 'and'], ['|=', 'or'], ['^=', 'xor'],
    ['>>=', 'shr_s'], ['<<=', 'shl'], ['>>>=', 'shr_u'],
  ].map(([op, fn]) => [op, (name, val) => {
    if (valTypeOf(name) === VAL.BIGINT || valTypeOf(val) === VAL.BIGINT) {
      const void_ = _expect === 'void'
      const result = fromI64([`i64.${fn}`, asI64(readVar(name)), asI64(emit(val))])
      return writeVar(name, result, void_)
    }
    return compoundAssign(name, val,
      (a, b) => asF64(typed([`i32.${fn}`, toI32(a), toI32(b)], 'i32')),
      (a, b) => typed([`i32.${fn}`, a, b], 'i32')
    )
  }])),

  // Logical compound assignments: a ||= b → a = a || b, a &&= b → a = a && b
  // Logical/nullish compound assignments: read → check → conditionally write
  // For complex LHS (obj.prop, arr[i]): emit as check(read(lhs)) ? write(lhs, val) : read(lhs)
  ...Object.fromEntries(['||=', '&&=', '??='].map(op => [op, (name, val) => {
    // Complex LHS → desugar (side-effect-safe since obj/arr/idx are locals)
    if (typeof name !== 'string') {
      const baseOp = op.slice(0, -1) // '||', '&&', '??'
      return emit([baseOp, name, ['=', name, val]])
    }
    if (isConst(name)) err(`Assignment to const '${name}'`)
    const void_ = _expect === 'void'
    const t = temp()
    const va = readVar(name)
    // Condition: ||= → truthy check, &&= → truthy check, ??= → nullish check
    const cond = op === '??='
      ? isNullish(['local.tee', `$${t}`, asF64(va)])
      : ['i32.and',
          ['f64.eq', ['local.tee', `$${t}`, asF64(va)], ['local.get', `$${t}`]],
          ['f64.ne', ['local.get', `$${t}`], ['f64.const', 0]]]
    // &&= and ??= assign when cond is true (truthy / nullish); ||= assigns when cond is false
    const [thenExpr, elseExpr] = op === '||='
      ? [['local.get', `$${t}`], asF64(emit(val))]
      : [asF64(emit(val)), ['local.get', `$${t}`]]
    const result = typed(['if', ['result', 'f64'], cond, ['then', thenExpr], ['else', elseExpr]], 'f64')
    // Write back (handles boxed/global/local)
    if (ctx.func.boxed?.has(name)) {
      const bt = temp()
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${bt}`, result],
        ['f64.store', boxedAddr(name), ['local.get', `$${bt}`]],
        ['local.get', `$${bt}`]], 'f64')
    }
    return writeVar(name, result, void_)
  }])),

  // === Increment/Decrement ===
  // Postfix resolved in prepare: i++ → (++i) - 1

  ...Object.fromEntries([['++', 'add'], ['--', 'sub']].map(([op, fn]) => [op, name => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
    const void_ = _expect === 'void'
    const v = readVar(name)
    const one = v.type === 'i32' ? ['i32.const', 1] : ['f64.const', 1]
    return writeVar(name, typed([`${v.type}.${fn}`, v, one], v.type), void_)
  }])),

  // === Arithmetic (type-preserving) ===

  // Postfix in void: (++i)-1 / (--i)+1 → just ++i / --i
  '+': (a, b) => {
    if (_expect === 'void' && isPostfix(a, '--', b)) return emit(a, 'void')
    // String concatenation: if either operand is known string, use __str_concat
    const vtA = keyValType(a)
    const vtB = keyValType(b)
    if (vtA === VAL.STRING || vtB === VAL.STRING) {
      inc('__str_concat')
      return typed(['call', '$__str_concat', asF64(emit(a)), asF64(emit(b))], 'f64')
    }
    if (vtA === VAL.BIGINT || vtB === VAL.BIGINT)
      return fromI64(['i64.add', asI64(emit(a)), asI64(emit(b))])
    // Runtime string dispatch: if either operand type is unknown and string module loaded, check at runtime
    if ((vtA == null || vtB == null) && ctx.core.stdlib['__str_concat']) {
      const tA = temp('add'), tB = temp('add')
      inc('__str_concat', '__is_str_key')
      return typed(['if', ['result', 'f64'],
        ['i32.or',
          ['call', '$__is_str_key', ['local.tee', `$${tA}`, asF64(emit(a))]],
          ['call', '$__is_str_key', ['local.tee', `$${tB}`, asF64(emit(b))]]],
        ['then', ['call', '$__str_concat', ['local.get', `$${tA}`], ['local.get', `$${tB}`]]],
        ['else', ['f64.add', ['local.get', `$${tA}`], ['local.get', `$${tB}`]]]
      ], 'f64')
    }
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) return emitNum(litVal(va) + litVal(vb))
    if (isLit(vb) && litVal(vb) === 0) return va
    if (isLit(va) && litVal(va) === 0) return vb
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.add', va, vb], 'i32')
    return typed(['f64.add', asF64(va), asF64(vb)], 'f64')
  },
  '-': (a, b) => {
    if (_expect === 'void' && isPostfix(a, '++', b)) return emit(a, 'void')
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return b === undefined
        ? fromI64(['i64.sub', ['i64.const', 0], asI64(emit(a))])
        : fromI64(['i64.sub', asI64(emit(a)), asI64(emit(b))])
    if (b === undefined) { const v = emit(a); return isLit(v) ? emitNum(-litVal(v)) : v.type === 'i32' ? typed(['i32.sub', typed(['i32.const', 0], 'i32'), v], 'i32') : typed(['f64.neg', toNumF64(a, v)], 'f64') }
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) return emitNum(litVal(va) - litVal(vb))
    if (isLit(vb) && litVal(vb) === 0) return toNumF64(a, va)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.sub', va, vb], 'i32')
    return typed(['f64.sub', toNumF64(a, va), toNumF64(b, vb)], 'f64')
  },
  'u+': a => {
    if (valTypeOf(a) === VAL.BIGINT)
      return typed(['f64.convert_i64_s', asI64(emit(a))], 'f64')
    inc('__to_num')
    return typed(['call', '$__to_num', asF64(emit(a))], 'f64')
  },
  'u-': a => {
    if (valTypeOf(a) === VAL.BIGINT) return fromI64(['i64.sub', ['i64.const', 0], asI64(emit(a))])
    const v = emit(a); return isLit(v) ? emitNum(-litVal(v)) : v.type === 'i32' ? typed(['i32.sub', typed(['i32.const', 0], 'i32'), v], 'i32') : typed(['f64.neg', toNumF64(a, v)], 'f64')
  },
  '*': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return fromI64(['i64.mul', asI64(emit(a)), asI64(emit(b))])
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) return emitNum(litVal(va) * litVal(vb))
    if (isLit(vb) && litVal(vb) === 1) return toNumF64(a, va)
    if (isLit(va) && litVal(va) === 1) return toNumF64(b, vb)
    if (isLit(vb) && litVal(vb) === 0) return isLit(va) ? vb : typed(['block', ['result', vb.type], va, 'drop', vb], vb.type)
    if (isLit(va) && litVal(va) === 0) return isLit(vb) ? va : typed(['block', ['result', va.type], vb, 'drop', va], va.type)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.mul', va, vb], 'i32')
    return typed(['f64.mul', toNumF64(a, va), toNumF64(b, vb)], 'f64')
  },
  '/': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return fromI64(['i64.div_s', asI64(emit(a)), asI64(emit(b))])
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb) && litVal(vb) !== 0) return emitNum(litVal(va) / litVal(vb))
    if (isLit(vb) && litVal(vb) === 1) return toNumF64(a, va)
    return typed(['f64.div', toNumF64(a, va), toNumF64(b, vb)], 'f64')
  },
  '%': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return fromI64(['i64.rem_s', asI64(emit(a)), asI64(emit(b))])
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb) && litVal(vb) !== 0) return emitNum(litVal(va) % litVal(vb))
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.rem_s', va, vb], 'i32')
    return f64rem(toNumF64(a, va), toNumF64(b, vb))
  },

  // === Comparisons (always i32 result) ===

  '==': (a, b) => {
    // JS loose nullish equality: x == null / x == undefined.
    // If the non-literal side has a known non-null VAL type, fold to 0.
    if (isNullishLit(a)) {
      if (valTypeOf(b)) return emitNum(0)
      return isNullish(asF64(emit(b)))
    }
    if (isNullishLit(b)) {
      if (valTypeOf(a)) return emitNum(0)
      return isNullish(asF64(emit(a)))
    }
    // typeof x == 'string' → compile-time type check (prepare rewrites string to type code)
    const tc = emitTypeofCmp(a, b, 'eq'); if (tc) return tc
    const va = emit(a), vb = emit(b)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.eq', va, vb], 'i32')
    // Both sides known-pure NUMBER → f64.eq (skip __eq's pointer-identity/string path).
    // valTypeOf handles literals/arithmetic exprs; lookupValType covers typed locals/params.
    const vta = valTypeOf(a) ?? (typeof a === 'string' ? lookupValType(a) : null)
    const vtb = valTypeOf(b) ?? (typeof b === 'string' ? lookupValType(b) : null)
    if (vta === VAL.NUMBER && vtb === VAL.NUMBER) return typed(['f64.eq', asF64(va), asF64(vb)], 'i32')
    // Reference-equal pointer kinds (same kind, non-STRING, non-BIGINT): i64 bit equality.
    // JS `==` on objects/arrays/sets/maps/etc. is pure reference equality — no content path.
    // STRING needs __eq (heap strings can be equal by content but different pointers).
    // BIGINT needs __eq (heap-allocated, content compare).
    if (vta && vta === vtb && REF_EQ_KINDS.has(vta)) {
      return typed(['i64.eq', ['i64.reinterpret_f64', asF64(va)], ['i64.reinterpret_f64', asF64(vb)]], 'i32')
    }
    inc('__eq')
    return typed(['call', '$__eq', asF64(va), asF64(vb)], 'i32')
  },
  '!=': (a, b) => {
    if (isNullishLit(a)) {
      if (valTypeOf(b)) return emitNum(1)
      return typed(['i32.eqz', isNullish(asF64(emit(b)))], 'i32')
    }
    if (isNullishLit(b)) {
      if (valTypeOf(a)) return emitNum(1)
      return typed(['i32.eqz', isNullish(asF64(emit(a)))], 'i32')
    }
    const tc = emitTypeofCmp(a, b, 'ne'); if (tc) return tc
    const va = emit(a), vb = emit(b)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.ne', va, vb], 'i32')
    const vta = valTypeOf(a) ?? (typeof a === 'string' ? lookupValType(a) : null)
    const vtb = valTypeOf(b) ?? (typeof b === 'string' ? lookupValType(b) : null)
    if (vta === VAL.NUMBER && vtb === VAL.NUMBER) return typed(['f64.ne', asF64(va), asF64(vb)], 'i32')
    if (vta && vta === vtb && REF_EQ_KINDS.has(vta)) {
      return typed(['i64.ne', ['i64.reinterpret_f64', asF64(va)], ['i64.reinterpret_f64', asF64(vb)]], 'i32')
    }
    inc('__eq')
    return typed(['i32.eqz', ['call', '$__eq', asF64(va), asF64(vb)]], 'i32')
  },
  '<':  cmpOp('lt_s', 'lt', (a, b) => a < b),
  '>':  cmpOp('gt_s', 'gt', (a, b) => a > b),
  '<=': cmpOp('le_s', 'le', (a, b) => a <= b),
  '>=': cmpOp('ge_s', 'ge', (a, b) => a >= b),

  // === Logical ===

  '!': a => {
    const v = emit(a)
    if (v.type === 'i32') return typed(['i32.eqz', v], 'i32')
    // Unboxed pointer offsets: falsy iff zero offset.
    if (v.ptrKind != null) return typed(['i32.eqz', v], 'i32')
    // Known pointer-kinded operand: `!x` is just `x is nullish` (null/undefined).
    // Pointers are never 0 / NaN / false / empty-string in the boxed form.
    const vt = valTypeOf(a) ?? (typeof a === 'string' ? lookupValType(a) : null)
    if (vt && vt !== VAL.NUMBER && vt !== VAL.BIGINT) {
      return isNullish(asF64(v))
    }
    inc('__is_truthy')
    return typed(['i32.eqz', ['call', '$__is_truthy', asF64(v)]], 'i32')
  },

  '?:': (a, b, c) => {
    // Constant condition → emit only the live branch
    const ca = emit(a)
    if (isLit(ca)) { const v = litVal(ca); return (v !== 0 && v === v) ? emit(b) : emit(c) }
    const cond = toBoolFromEmitted(ca)
    // Flow-sensitive refinement: each arm sees narrowing consistent with `a` being truthy / falsy.
    const thenRefs = extractRefinements(a, new Map(), true)
    const elseRefs = extractRefinements(a, new Map(), false)
    const vb = withRefinements(thenRefs, b, () => emit(b))
    const vc = withRefinements(elseRefs, c, () => emit(c))
    // L: Use WASM select for pure ternaries — branchless, smaller bytecode
    if (vb.type === 'i32' && vc.type === 'i32') {
      // Propagate matching ptrKind/ptrAux so a downstream asF64 takes the NaN-rebox
      // path instead of `f64.convert_i32_s`. Mismatched kinds drop both — caller's
      // asF64 will treat the i32 as numeric, which is correct for non-pointer i32s.
      // ptrKind matches but ptrAux differs (e.g. polymorphic OBJECT with two
      // distinct schemaIds, or TYPED with two element types) — fall through to
      // the f64 path. There each arm reboxes independently, preserving its own
      // aux in the NaN-box. The single-i32 path can only carry one aux on the
      // result, so `boxPtrIR` would default to 0 and lose the runtime schema /
      // elemType bits needed by downstream lookups (e.g. __dyn_get's OBJECT-
      // schema fallback uses receiver aux to resolve `.prop`).
      const auxMismatch = vb.ptrKind != null && vb.ptrKind === vc.ptrKind
        && (vb.ptrAux ?? null) !== (vc.ptrAux ?? null)
      if (!auxMismatch) {
        const tagPtr = (n) => {
          if (vb.ptrKind != null && vb.ptrKind === vc.ptrKind) {
            n.ptrKind = vb.ptrKind
            if (vb.ptrAux != null && vb.ptrAux === vc.ptrAux) n.ptrAux = vb.ptrAux
          }
          return n
        }
        if (isPureIR(vb) && isPureIR(vc))
          return tagPtr(typed(['select', vb, vc, cond], 'i32'))
        return tagPtr(typed(['if', ['result', 'i32'], cond, ['then', vb], ['else', vc]], 'i32'))
      }
    }
    const fb = asF64(vb), fc = asF64(vc)
    if (isPureIR(fb) && isPureIR(fc))
      return typed(['select', fb, fc, cond], 'f64')
    return typed(['if', ['result', 'f64'], cond, ['then', fb], ['else', fc]], 'f64')
  },

  '&&': (a, b) => {
    const va = emit(a)
    if (isLit(va)) { const v = litVal(va); return (v !== 0 && v === v) ? emit(b) : va }
    // i32 fast path: use i32 tee as cond directly (nonzero=truthy in wasm `if`),
    // skip f64 round-trip and __is_truthy call entirely.
    if (va.type === 'i32') {
      const vb = emit(b)
      const t = tempI32()
      if (vb.type === 'i32') {
        return typed(['if', ['result', 'i32'],
          ['local.tee', `$${t}`, va],
          ['then', vb],
          ['else', ['local.get', `$${t}`]]], 'i32')
      }
      return typed(['if', ['result', 'f64'],
        ['local.tee', `$${t}`, va],
        ['then', asF64(vb)],
        ['else', typed(['f64.convert_i32_s', ['local.get', `$${t}`]], 'f64')]], 'f64')
    }
    const t = temp()
    const teed = typed(['local.tee', `$${t}`, asF64(va)], 'f64')
    return typed(['if', ['result', 'f64'],
      toBoolFromEmitted(teed),
      ['then', asF64(emit(b))],
      ['else', ['local.get', `$${t}`]]], 'f64')
  },

  '||': (a, b) => {
    const va = emit(a)
    if (isLit(va)) { const v = litVal(va); return (v !== 0 && v === v) ? va : emit(b) }
    if (va.type === 'i32') {
      const vb = emit(b)
      const t = tempI32()
      if (vb.type === 'i32') {
        return typed(['if', ['result', 'i32'],
          ['local.tee', `$${t}`, va],
          ['then', ['local.get', `$${t}`]],
          ['else', vb]], 'i32')
      }
      return typed(['if', ['result', 'f64'],
        ['local.tee', `$${t}`, va],
        ['then', typed(['f64.convert_i32_s', ['local.get', `$${t}`]], 'f64')],
        ['else', asF64(vb)]], 'f64')
    }
    const t = temp()
    const teed = typed(['local.tee', `$${t}`, asF64(va)], 'f64')
    return typed(['if', ['result', 'f64'],
      toBoolFromEmitted(teed),
      ['then', ['local.get', `$${t}`]],
      ['else', asF64(emit(b))]], 'f64')
  },

  // a ?? b: returns b only if a is nullish
  '??': (a, b) => {
    const va = emit(a)
    const t = temp()
    return typed(['if', ['result', 'f64'],
      // Check: is a NOT nullish?
      ['i32.eqz', isNullish(['local.tee', `$${t}`, asF64(va)])],
      ['then', ['local.get', `$${t}`]],
      ['else', asF64(emit(b))]], 'f64')
  },

  'void': a => {
    const v = emit(a)
    if (v == null) return typed(['f64.const', 0], 'f64')
    // Detect WASM-void instructions (local.set, *.store) that don't leave a value on stack
    const op = Array.isArray(v) ? v[0] : null
    const wasmVoid = op === 'local.set' || (typeof op === 'string' && op.endsWith('.store'))
      || op === 'memory.copy' || op === 'global.set'
    if (wasmVoid)
      return typed(['block', ['result', 'f64'], v, ['f64.const', 0]], 'f64')
    // Value-producing instructions: include, drop result, return 0
    if (v.type && v.type !== 'void')
      return typed(['block', ['result', 'f64'], v, 'drop', ['f64.const', 0]], 'f64')
    return typed(['block', ['result', 'f64'], ...flat(v), ['f64.const', 0]], 'f64')
  },

  '(': a => emit(a),

  // === Bitwise (i32 for numbers, i64 for BigInt) ===

  '~':   a => { const v = emit(a); return isLit(v) ? emitNum(~litVal(v)) : typed(['i32.xor', toI32(v), typed(['i32.const', -1], 'i32')], 'i32') },
  ...Object.fromEntries([
    ['&', 'and'], ['|', 'or'], ['^', 'xor'], ['<<', 'shl'], ['>>', 'shr_s'],
  ].map(([op, fn]) => [op, (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return fromI64([`i64.${fn}`, asI64(emit(a)), asI64(emit(b))])
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) {
      const la = litVal(va), lb = litVal(vb)
      if (op === '&') return emitNum(la & lb); if (op === '|') return emitNum(la | lb)
      if (op === '^') return emitNum(la ^ lb); if (op === '<<') return emitNum(la << lb)
      if (op === '>>') return emitNum(la >> lb)
    }
    return typed([`i32.${fn}`, toI32(va), toI32(vb)], 'i32')
  }])),
  '>>>': (a, b) => {
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) return emitNum(litVal(va) >>> litVal(vb))
    // F: Mark unsigned so `asF64` lifts via `f64.convert_i32_u` (preserving the
    // [0, 2^32) value range). Without this, `(s >>> 0) / 4294967296` would convert
    // signed for negative-high-bit s values, flipping sign and breaking the
    // canonical "uint32 → f64" idiom used in PRNGs and bit-manipulation code.
    const node = typed(['i32.shr_u', toI32(va), toI32(vb)], 'i32')
    node.unsigned = true
    return node
  },

  // === Control flow ===

  'if': (cond, then, els) => {
    // Dead branch elimination: constant condition → emit only the live branch
    const ce = emit(cond)
    if (isLit(ce)) {
      const v = litVal(ce), truthy = v !== 0 && v === v
      if (truthy) return emitFlat(then)
      if (els != null) return emitFlat(els)
      return null
    }
    const c = ce.type === 'i32' ? ce : toBoolFromEmitted(ce)
    // Flow-sensitive type refinement: narrow types within each branch based on the guard.
    const thenRefs = extractRefinements(cond, new Map(), true)
    const elseRefs = extractRefinements(cond, new Map(), false)
    const thenBody = withRefinements(thenRefs, then, () => emitFlat(then))
    if (els != null) {
      const elseBody = withRefinements(elseRefs, els, () => emitFlat(els))
      return ['if', c, ['then', ...thenBody], ['else', ...elseBody]]
    }
    return ['if', c, ['then', ...thenBody]]
  },

  'for': (init, cond, step, body) => {
    if (body === undefined) return err('for-in/for-of not supported')
    const id = ctx.func.uniq++
    const brk = `$brk${id}`, loop = `$loop${id}`
    ctx.func.stack.push({ brk, loop })
    const result = []
    if (init != null) result.push(...emitFlat(init))
    // J: Single-test loop — condition evaluated once per iteration at the top.
    // (block $brk (loop $loop (br_if $brk (eqz cond)) body step (br $loop)))
    const loopBody = []
    if (cond) loopBody.push(['br_if', brk, ['i32.eqz', toBool(cond)]])
    loopBody.push(...emitFlat(body))
    if (step) loopBody.push(...emitFlat(step))
    loopBody.push(['br', loop])
    result.push(['block', brk, ['loop', loop, ...loopBody]])
    ctx.func.stack.pop()
    return result.length === 1 ? result[0] : result
  },

  'switch': (discriminant, ...cases) => {
    const disc = `${T}disc${ctx.func.uniq++}`
    ctx.func.locals.set(disc, 'f64')

    const result = [['local.set', `$${disc}`, asF64(emit(discriminant))]]

    for (const c of cases) {
      if (c[0] === 'case') {
        const [, test, body] = c
        const skip = `$skip${ctx.func.uniq++}`
        // Block: skip if discriminant != test, otherwise execute body
        result.push(['block', skip,
          ['br_if', skip, typed(['f64.ne', typed(['local.get', `$${disc}`], 'f64'), asF64(emit(test))], 'i32')],
          ...emitFlat(body)])
      } else if (c[0] === 'default') {
        result.push(...emitFlat(c[1]))
      }
    }

    return result
  },

  'while': (cond, body) => emitter['for'](null, cond, null, body),
  'break': () => ['br', loopTop().brk],
  'continue': () => ['br', loopTop().loop],

  // === Call ===

  // Arrow as value → closure
  '=>': (rawParams, body) => {
    if (!ctx.closure.make) err('Closures require fn module (auto-included)')

    const raw = extractParams(rawParams)
    const params = [], defaults = {}
    let restParam = null, bodyPrefix = []
    for (const r of raw) {
      const c = classifyParam(r)
      if (c.kind === 'rest') { restParam = c.name; params.push(c.name) }
      else if (c.kind === 'plain') params.push(c.name)
      else if (c.kind === 'default') { params.push(c.name); defaults[c.name] = c.defValue }
      else {
        const tmp = `${T}p${ctx.func.uniq++}`
        params.push(tmp)
        if (c.kind === 'destruct-default') defaults[tmp] = c.defValue
        bodyPrefix.push(['let', ['=', c.pattern, tmp]])
      }
    }

    // Prepend destructuring to body (if any destructured params)
    if (bodyPrefix.length) {
      if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';')
        body = ['{}', [';', ...bodyPrefix, ...body[1].slice(1)]]
      else if (Array.isArray(body) && body[0] === '{}')
        body = ['{}', [';', ...bodyPrefix, body[1]]]
      else body = ['{}', [';', ...bodyPrefix, ['return', body]]]
    }

    // Find free variables in body that aren't params → captures
    const paramSet = new Set(params)
    const captures = []
    findFreeVars(body, paramSet, captures)
    for (const def of Object.values(defaults)) findFreeVars(def, paramSet, captures)

    // Pass closure info including rest param and defaults
    const closureInfo = { params, body, captures, restParam }
    if (Object.keys(defaults).length) closureInfo.defaults = defaults
    return ctx.closure.make(closureInfo)
  },

  '()': (callee, callArgs) => {
    let argList = Array.isArray(callArgs)
      ? (callArgs[0] === ',' ? callArgs.slice(1) : [callArgs])
      : callArgs ? [callArgs] : []

    // Helper: expand spread arguments into flat list of normal arguments + spread markers
    // Returns { normal: [...], spreads: [(pos, expr), ...] }
    const parseArgs = (args) => {
      const normal = []
      const spreads = []
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (Array.isArray(arg) && arg[0] === '...') {
          spreads.push({ pos: normal.length, expr: arg[1] })
        } else {
          normal.push(arg)
        }
      }
      return { normal, spreads, hasSpread: spreads.length > 0 }
    }

    const parsed = parseArgs(argList)

    // Method call: obj.method(args) → type-aware dispatch
    if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, method] = callee

      // Function property call: fn.prop(args) → direct call to fn$prop
      if (typeof obj === 'string' && ctx.func.names.has(obj)) {
        const fname = `${obj}$${method}`
        if (ctx.func.names.has(fname)) {
          const func = ctx.func.map.get(fname)
          const emittedArgs = parsed.normal.map((a, k) => emitArgForParam(emit(a), func.sig.params[k]))
          while (emittedArgs.length < func.sig.params.length)
            emittedArgs.push(func.sig.params[emittedArgs.length].type === 'i32' ? typed(['i32.const', 0], 'i32') : nullExpr())
          const callIR = typed(['call', `$${fname}`, ...emittedArgs], func.sig.results[0])
          if (func.sig.ptrKind != null) callIR.ptrKind = func.sig.ptrKind
          if (func.sig.ptrAux != null) callIR.ptrAux = func.sig.ptrAux
          return callIR
        }
      }

      const vt = keyValType(obj)

      // Helper to call method with arguments (handles spread expansion)
      const callMethod = (objArg, methodEmitter) => {
        if (!parsed.hasSpread) {
          return methodEmitter(objArg, ...parsed.normal)
        }

        // Bulk push fast path: `obj.push(...src)` — single spread, no normal args, named obj.
        // The generic single-spread loop below calls methodEmitter per iteration, which expands
        // to a full .push (grow check + ptr_offset + store + set_len) every step. Amortising the
        // grow + set_len across the whole spread eliminates ~3 stdlib calls per byte in watr's
        // hot `out.push(...HANDLER[op](...))` path (~24M bytes/iter on raycast).
        if (method === 'push' && parsed.normal.length === 0 &&
            parsed.spreads.length === 1 && typeof objArg === 'string') {
          const spreadExpr = parsed.spreads[0].expr
          inc('__len'); inc('__arr_grow'); inc('__set_len'); inc('__ptr_offset')
          const o = `${T}po${ctx.func.uniq++}`,
                sa = `${T}psa${ctx.func.uniq++}`,
                sl = `${T}psl${ctx.func.uniq++}`,
                ol = `${T}pol${ctx.func.uniq++}`,
                si = `${T}psi${ctx.func.uniq++}`,
                base = `${T}pb${ctx.func.uniq++}`
          ctx.func.locals.set(o, 'f64'); ctx.func.locals.set(sa, 'f64')
          ctx.func.locals.set(sl, 'i32'); ctx.func.locals.set(ol, 'i32')
          ctx.func.locals.set(si, 'i32'); ctx.func.locals.set(base, 'i32')

          const objIsArr = lookupValType(objArg) === VAL.ARRAY
          // Spread source: if statically known ARRAY, inline len/load via hoisted srcBase
          // (skip per-iteration __arr_idx call + dispatch).
          const srcVT = valTypeOf(spreadExpr)
          const srcIsArr = !multiCount(spreadExpr) && srcVT === VAL.ARRAY
          const srcBase = srcIsArr ? `${T}psb${ctx.func.uniq++}` : null
          if (srcIsArr) ctx.func.locals.set(srcBase, 'i32')
          const n = multiCount(spreadExpr)
          const ir = []
          ir.push(['local.set', `$${o}`, asF64(emit(objArg))])
          ir.push(['local.set', `$${sa}`, n ? materializeMulti(spreadExpr) : asF64(emit(spreadExpr))])
          if (srcIsArr) {
            ir.push(['local.set', `$${srcBase}`, ['call', '$__ptr_offset', ['local.get', `$${sa}`]]])
            ir.push(['local.set', `$${sl}`, ['i32.load', ['i32.sub', ['local.get', `$${srcBase}`], ['i32.const', 8]]]])
          } else {
            ir.push(['local.set', `$${sl}`, ['call', '$__len', ['local.get', `$${sa}`]]])
          }
          // Old length: inline as `i32.load (off-8)` if obj is known ARRAY (matches .push handler).
          if (objIsArr) {
            ir.push(['local.set', `$${ol}`,
              ['i32.load', ['i32.sub', ['call', '$__ptr_offset', ['local.get', `$${o}`]], ['i32.const', 8]]]])
          } else {
            ir.push(['local.set', `$${ol}`, ['call', '$__len', ['local.get', `$${o}`]]])
          }
          // Single grow for the full spread (vs per-element grow check in the generic loop).
          ir.push(['local.set', `$${o}`, ['call', '$__arr_grow', ['local.get', `$${o}`],
            ['i32.add', ['local.get', `$${ol}`], ['local.get', `$${sl}`]]]])
          // base captured AFTER grow (grow may relocate the array).
          ir.push(['local.set', `$${base}`, ['call', '$__ptr_offset', ['local.get', `$${o}`]]])
          // Tight store loop.
          ir.push(['local.set', `$${si}`, ['i32.const', 0]])
          const loopId = ctx.func.uniq++
          const srcLoad = srcIsArr
            ? ['f64.load', ['i32.add', ['local.get', `$${srcBase}`], ['i32.shl', ['local.get', `$${si}`], ['i32.const', 3]]]]
            : asF64(emit(['[]', sa, si]))
          ir.push(['block', `$break${loopId}`, ['loop', `$continue${loopId}`,
            ['br_if', `$break${loopId}`, ['i32.ge_u', ['local.get', `$${si}`], ['local.get', `$${sl}`]]],
            ['f64.store',
              ['i32.add', ['local.get', `$${base}`],
                ['i32.shl', ['i32.add', ['local.get', `$${ol}`], ['local.get', `$${si}`]], ['i32.const', 3]]],
              srcLoad],
            ['local.set', `$${si}`, ['i32.add', ['local.get', `$${si}`], ['i32.const', 1]]],
            ['br', `$continue${loopId}`]]])
          // Single set_len for the full spread.
          ir.push(['call', '$__set_len', ['local.get', `$${o}`],
            ['i32.add', ['local.get', `$${ol}`], ['local.get', `$${sl}`]]])
          // Update source variable: grow may have moved the pointer.
          if (ctx.func.boxed?.has(objArg)) {
            ir.push(['f64.store', ['local.get', `$${ctx.func.boxed.get(objArg)}`], ['local.get', `$${o}`]])
          } else if (ctx.scope.globals.has(objArg) && !ctx.func.locals?.has(objArg)) {
            ir.push(['global.set', `$${objArg}`, ['local.get', `$${o}`]])
          } else {
            ir.push(['local.set', `$${objArg}`, ['local.get', `$${o}`]])
          }
          ir.push(['f64.convert_i32_s', ['i32.add', ['local.get', `$${ol}`], ['local.get', `$${sl}`]]])
          return typed(['block', ['result', 'f64'], ...ir], 'f64')
        }

        // Single spread at end: call method with normal args, then loop spread elements
        if (parsed.spreads.length === 1 && parsed.spreads[0].pos === parsed.normal.length) {
          const spreadExpr = parsed.spreads[0].expr
          const acc = `${T}acc${ctx.func.uniq++}`, arr = `${T}sp${ctx.func.uniq++}`, len = `${T}splen${ctx.func.uniq++}`, idx = `${T}spidx${ctx.func.uniq++}`
          ctx.func.locals.set(acc, 'f64'); ctx.func.locals.set(arr, 'f64')
          ctx.func.locals.set(len, 'i32'); ctx.func.locals.set(idx, 'i32')
          const spreadVT = valTypeOf(spreadExpr)
          if (spreadVT) updateRep(arr, { val: spreadVT })

          // In-place spread methods modify target; accumulating methods (concat) return new values
          const inPlace = SPREAD_MUTATORS.has(method)
          // unshift prepends each arg to the front — iterating forward reverses the
          // intended order, so walk the spread from end to start.
          const reverseIter = method === 'unshift'
          const ir = []
          ir.push(['local.set', `$${acc}`, asF64(emit(objArg))])
          if (parsed.normal.length > 0) {
            const r = asF64(methodEmitter(objArg, ...parsed.normal))
            ir.push(inPlace ? ['drop', r] : ['local.set', `$${acc}`, r])
          }

          inc('__len')
          const n = multiCount(spreadExpr)
          ir.push(['local.set', `$${arr}`, n ? materializeMulti(spreadExpr) : asF64(emit(spreadExpr))])
          ir.push(['local.set', `$${len}`, ['call', '$__len', ['local.get', `$${arr}`]]])
          ir.push(['local.set', `$${idx}`,
            reverseIter ? ['i32.sub', ['local.get', `$${len}`], ['i32.const', 1]] : ['i32.const', 0]])
          const loopId = ctx.func.uniq++
          const loopBody = asF64(methodEmitter(inPlace ? objArg : acc, ['[]', arr, idx]))
          ir.push(['block', `$break${loopId}`,
            ['loop', `$continue${loopId}`,
              ['br_if', `$break${loopId}`,
                reverseIter
                  ? ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]]
                  : ['i32.ge_u', ['local.get', `$${idx}`], ['local.get', `$${len}`]]],
              inPlace ? ['drop', loopBody] : ['local.set', `$${acc}`, loopBody],
              ['local.set', `$${idx}`, ['i32.add', ['local.get', `$${idx}`], ['i32.const', reverseIter ? -1 : 1]]],
              ['br', `$continue${loopId}`]]])

          ir.push(inPlace ? asF64(emit(objArg)) : ['local.get', `$${acc}`])
          return typed(['block', ['result', 'f64'], ...ir], 'f64')
        }

        // General spread case: iterate args in original order, batch contiguous normal
        // args into a single call, emit a per-element loop for each spread.
        //
        // inPlace methods (push/unshift/add/set): call methodEmitter(objArg, ...) each
        // time so the source variable's local gets updated (else heap grow/realloc
        // wouldn't be visible to subsequent uses of the variable). Final value is objArg.
        //
        // non-inPlace (concat, etc.): chain via temp acc since return value is the new
        // collection.
        const inPlaceG = SPREAD_MUTATORS.has(method)
        const combinedG = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
        inc('__len')

        if (inPlaceG) {
          const irG = []
          let batch = []
          const flushBatch = () => {
            if (!batch.length) return
            irG.push(['drop', asF64(methodEmitter(objArg, ...batch))])
            batch = []
          }
          for (const item of combinedG) {
            if (Array.isArray(item) && item[0] === '__spread') {
              flushBatch()
              const spreadExpr = item[1]
              const arrL = `${T}sp${ctx.func.uniq++}`, lenL = `${T}splen${ctx.func.uniq++}`, idxL = `${T}spidx${ctx.func.uniq++}`
              ctx.func.locals.set(arrL, 'f64'); ctx.func.locals.set(lenL, 'i32'); ctx.func.locals.set(idxL, 'i32')
              const spreadVT = valTypeOf(spreadExpr)
              if (spreadVT) updateRep(arrL, { val: spreadVT })
              const n = multiCount(spreadExpr)
              irG.push(
                ['local.set', `$${arrL}`, n ? materializeMulti(spreadExpr) : asF64(emit(spreadExpr))],
                ['local.set', `$${lenL}`, ['call', '$__len', ['local.get', `$${arrL}`]]],
                ['local.set', `$${idxL}`, ['i32.const', 0]])
              const loopId = ctx.func.uniq++
              const loopBody = asF64(methodEmitter(objArg, ['[]', arrL, idxL]))
              irG.push(['block', `$break${loopId}`,
                ['loop', `$continue${loopId}`,
                  ['br_if', `$break${loopId}`, ['i32.ge_u', ['local.get', `$${idxL}`], ['local.get', `$${lenL}`]]],
                  ['drop', loopBody],
                  ['local.set', `$${idxL}`, ['i32.add', ['local.get', `$${idxL}`], ['i32.const', 1]]],
                  ['br', `$continue${loopId}`]]])
            } else {
              batch.push(item)
            }
          }
          flushBatch()
          irG.push(asF64(emit(objArg)))
          return typed(['block', ['result', 'f64'], ...irG], 'f64')
        }

        const accG = `${T}acc${ctx.func.uniq++}`
        ctx.func.locals.set(accG, 'f64')
        const irG = [['local.set', `$${accG}`, asF64(emit(objArg))]]
        let batch = []
        const flushBatch = () => {
          if (!batch.length) return
          irG.push(['local.set', `$${accG}`, asF64(methodEmitter(accG, ...batch))])
          batch = []
        }
        for (const item of combinedG) {
          if (Array.isArray(item) && item[0] === '__spread') {
            flushBatch()
            const spreadExpr = item[1]
            const arrL = `${T}sp${ctx.func.uniq++}`, lenL = `${T}splen${ctx.func.uniq++}`, idxL = `${T}spidx${ctx.func.uniq++}`
            ctx.func.locals.set(arrL, 'f64'); ctx.func.locals.set(lenL, 'i32'); ctx.func.locals.set(idxL, 'i32')
            const spreadVT = valTypeOf(spreadExpr)
            if (spreadVT) updateRep(arrL, { val: spreadVT })
            const n = multiCount(spreadExpr)
            irG.push(
              ['local.set', `$${arrL}`, n ? materializeMulti(spreadExpr) : asF64(emit(spreadExpr))],
              ['local.set', `$${lenL}`, ['call', '$__len', ['local.get', `$${arrL}`]]],
              ['local.set', `$${idxL}`, ['i32.const', 0]])
            const loopId = ctx.func.uniq++
            const loopBody = asF64(methodEmitter(accG, ['[]', arrL, idxL]))
            irG.push(['block', `$break${loopId}`,
              ['loop', `$continue${loopId}`,
                ['br_if', `$break${loopId}`, ['i32.ge_u', ['local.get', `$${idxL}`], ['local.get', `$${lenL}`]]],
                ['local.set', `$${accG}`, loopBody],
                ['local.set', `$${idxL}`, ['i32.add', ['local.get', `$${idxL}`], ['i32.const', 1]]],
                ['br', `$continue${loopId}`]]])
          } else {
            batch.push(item)
          }
        }
        flushBatch()
        irG.push(['local.get', `$${accG}`])
        return typed(['block', ['result', 'f64'], ...irG], 'f64')
      }

      // Boxed object: delegate method to inner value (slot 0)
      if (typeof obj === 'string' && ctx.schema.isBoxed?.(obj)) {
        const innerVt = repOf(obj)?.val
        const emitter = ctx.core.emit[`.${innerVt}:${method}`] || ctx.core.emit[`.${method}`]
        if (emitter) {
          const innerName = `${obj}${T}inner`
          if (!ctx.func.locals.has(innerName)) ctx.func.locals.set(innerName, 'f64')
          const boxBase = tempI32('bb')
          // Load current inner value from boxed object's slot 0 (may have been updated by prior mutations)
          // Boxed handle is OBJECT-kind, never ARRAY — skip forwarding.
          const loadInner = [
            ['local.set', `$${boxBase}`, ptrOffsetIR(asF64(emit(obj)), lookupValType(obj) || VAL.OBJECT)],
            ['local.set', `$${innerName}`, ['f64.load', ['local.get', `$${boxBase}`]]]]
          const result = callMethod(innerName, emitter)
          // Mutating methods may reallocate; writeback inner value to boxed slot
          if (BOXED_MUTATORS.has(method)) {
            const wb = ['f64.store', ['local.get', `$${boxBase}`], ['local.get', `$${innerName}`]]
            return typed(['block', ['result', 'f64'], ...loadInner, asF64(result), wb], 'f64')
          }
          // Non-mutating: just load inner and call
          return typed(['block', ['result', 'f64'], ...loadInner, asF64(result)], 'f64')
        }
      }

      // Known type → static dispatch
      if (vt && ctx.core.emit[`.${vt}:${method}`]) {
        return callMethod(obj, ctx.core.emit[`.${vt}:${method}`])
      }

      // Unknown / guessed-array type, both string + generic exist → runtime dispatch by ptr type.
      // analyze.js defaults untyped `.slice()` results to VAL.ARRAY, which is a guess, not a proof;
      // runtime dispatch resolves whether the operand is actually a string or an array.
      // Concretely-typed non-string values (BUFFER, TYPED, MAP, …) fall through to the generic
      // emitter which already knows how to handle them.
      const strKey = `.string:${method}`, genKey = `.${method}`
      if ((!vt || vt === VAL.ARRAY) && ctx.core.emit[strKey] && ctx.core.emit[genKey]) {
        const t = `${T}rt${ctx.func.uniq++}`, tt = `${T}rtt${ctx.func.uniq++}`
        ctx.func.locals.set(t, 'f64'); ctx.func.locals.set(tt, 'i32')
        const strEmitter = ctx.core.emit[strKey]
        const genEmitter = ctx.core.emit[genKey]
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${t}`, asF64(emit(obj))],
          ['local.set', `$${tt}`, ['call', '$__ptr_type', ['local.get', `$${t}`]]],
          ['if', ['result', 'f64'],
            ['i32.or',
              ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.STRING]],
              ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.SSO]]],
            ['then', callMethod(t, strEmitter)],
            ['else', callMethod(t, genEmitter)]]], 'f64')
      }

      // Schema property function call: x.prop(args) where prop is a closure in boxed schema
      if (typeof obj === 'string' && ctx.schema.find && ctx.closure.call && ctx.schema.isBoxed?.(obj)) {
        const idx = ctx.schema.find(obj, method)
        if (idx >= 0) {
          const propRead = typed(['f64.load', ['i32.add', ptrOffsetIR(asF64(emit(obj)), lookupValType(obj) || VAL.OBJECT), ['i32.const', idx * 8]]], 'f64')
          return ctx.closure.call(propRead, parsed.normal)
        }
      }

      // Generic only
      if (ctx.core.emit[genKey]) {
        return callMethod(obj, ctx.core.emit[genKey])
      }

      // Dynamic property function call on non-external values.
      if (ctx.closure.call) {
        if (ctx.transform.strict)
          err(`strict mode: method call \`${typeof obj === 'string' ? obj : '<expr>'}.${method}(...)\` on a value of unknown type pulls dynamic dispatch stdlib. Annotate the receiver type or pass { strict: false }.`)
        const objTmp = `${T}mobj${ctx.func.uniq++}`
        ctx.func.locals.set(objTmp, 'f64')
        const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
        const arrayIR = buildArrayWithSpreads(combined)
        const propRead = typed(['call', '$__dyn_get_expr', ['local.get', `$${objTmp}`], asF64(emit(['str', method]))], 'f64')
        if (usesDynProps(vt)) {
          inc('__dyn_get_expr')
          return typed(['block', ['result', 'f64'],
            ['local.set', `$${objTmp}`, asF64(emit(obj))],
            ctx.closure.call(propRead, [arrayIR], true)], 'f64')
        }
        inc('__dyn_get_expr', '__ext_call')
        ctx.features.external = true
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${objTmp}`, asF64(emit(obj))],
          ['if', ['result', 'f64'],
            ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${objTmp}`]], ['i32.const', PTR.EXTERNAL]],
            ['then', ['call', '$__ext_call', ['local.get', `$${objTmp}`], asF64(emit(['str', method])), arrayIR]],
            ['else', ctx.closure.call(propRead, [arrayIR], true)]]], 'f64')
      }

      // Unknown callee - assume external method
      if (ctx.transform.strict)
        err(`strict mode: method call \`${typeof obj === 'string' ? obj : '<expr>'}.${method}(...)\` on a value of unknown type falls through to host \`__ext_call\`. Annotate the receiver type or pass { strict: false }.`)
      inc('__ext_call')
      ctx.features.external = true
      const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
      const arrayIR = buildArrayWithSpreads(combined)
      return typed(['call', '$__ext_call', asF64(emit(obj)), asF64(emit(['str', method])), arrayIR], 'f64');
    }

    if (ctx.core.emit[callee]) {
      // Pass spread args through to emitter (e.g. Math.max(...arr))
      if (parsed.hasSpread) {
        const allArgs = []
        let ni = 0
        for (const s of parsed.spreads) {
          while (ni < s.pos) allArgs.push(parsed.normal[ni++])
          allArgs.push(['...', s.expr])
        }
        while (ni < parsed.normal.length) allArgs.push(parsed.normal[ni++])
        return ctx.core.emit[callee](...allArgs)
      }
      return ctx.core.emit[callee](...parsed.normal)
    }

    // Direct call if callee is a known top-level function
    if (typeof callee === 'string' && ctx.func.names.has(callee)) {
      const func = ctx.func.map.get(callee)

      // Rest param case: collect all args (including expanded spreads) into array
      if (func?.rest) {
        const fixedParamCount = func.sig.params.length - 1
        const fixedArgs = parsed.normal.slice(0, fixedParamCount)
        // Pad missing fixed args with sentinel for defaults
        const emittedFixed = fixedArgs.map((a, k) => emitArgForParam(emit(a), func.sig.params[k]))
        while (emittedFixed.length < fixedParamCount)
          emittedFixed.push(func.sig.params[emittedFixed.length].type === 'i32' ? typed(['i32.const', 0], 'i32') : nullExpr())

        // Reconstruct with spreads, then take rest args
        const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
        const restArgsFinal = combined.slice(fixedParamCount)

        // Build array: emit code for normal args + code to expand spreads
        const arrayIR = buildArrayWithSpreads(restArgsFinal)
        const callIR = typed(['call', `$${callee}`,
          ...emittedFixed,
          arrayIR], func.sig.results[0])
        if (func.sig.ptrKind != null) callIR.ptrKind = func.sig.ptrKind
        if (func.sig.ptrAux != null) callIR.ptrAux = func.sig.ptrAux
        return callIR
      }

      // Regular function call without rest params
      if (parsed.hasSpread) err(`Spread not supported in calls to non-variadic function ${callee}`)
      // Pad missing args with canonical NaN (triggers default param init)
      const args = parsed.normal.map((a, k) => emitArgForParam(emit(a), func?.sig.params[k]))
      const expected = func?.sig.params.length || args.length
      while (args.length < expected) args.push(func?.sig.params[args.length]?.type === 'i32' ? typed(['i32.const', 0], 'i32') : nullExpr())
      // Multi-value return: materialize as heap array (caller expects single pointer)
      if (func?.sig.results.length > 1) return materializeMulti(['()', callee, ...parsed.normal])
      const callIR = typed(['call', `$${callee}`, ...args], func?.sig.results[0] || 'f64')
      if (func?.sig.ptrKind != null) callIR.ptrKind = func.sig.ptrKind
      if (func?.sig.ptrAux != null) callIR.ptrAux = func.sig.ptrAux
      return callIR
    }

    // A3: const-bound, non-escaping closure → direct call to body (skip call_indirect).
    // emitDecl registered name → bodyName when it saw the closure.make IR. Body signature
    // is uniform $ftN: (env f64, argc i32, a0..a{W-1} f64) → f64. We pass the closure
    // NaN-box itself as env (body extracts captures via __ptr_offset(__env)).
    if (typeof callee === 'string' && !parsed.hasSpread
        && ctx.func.directClosures?.has(callee)) {
      const bodyName = ctx.func.directClosures.get(callee)
      const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
      const n = parsed.normal.length
      if (n <= W) {
        const slots = parsed.normal.map(a => asF64(emit(a)))
        while (slots.length < W) slots.push(undefExpr())
        return typed(['call', `$${bodyName}`,
          asF64(emit(callee)),
          typed(['i32.const', n], 'i32'),
          ...slots], 'f64')
      }
    }

    // Closure call: callee is a variable holding a NaN-boxed closure pointer
    // Uniform convention: fn.call packs all args into an array
    if (ctx.closure.call) {
      if (parsed.hasSpread) {
        // Spread: build the args array directly (handles __spread markers)
        const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
        const arrayIR = buildArrayWithSpreads(combined)
        // Pass pre-built array as single already-emitted arg
        return ctx.closure.call(emit(callee), [arrayIR], true)
      }
      return ctx.closure.call(emit(callee), parsed.normal)
    }

    // Unknown callee — assume direct call
    return typed(['call', `$${callee}`, ...argList.map(a => asF64(emit(a)))], 'f64')
  },
}

// === Emit dispatch ===

/**
 * Emit single AST node to typed WASM IR.
 * Every returned node has .type = 'i32' | 'f64'.
 * @param {import('./prepare.js').ASTNode} node
 * @returns {Array} typed WASM S-expression
 */
export function emit(node, expect) {
  _expect = expect || null
  if (Array.isArray(node) && node.loc != null) ctx.error.loc = node.loc
  if (node == null) return null
  if (node === true) return typed(['i32.const', 1], 'i32')
  if (node === false) return typed(['i32.const', 0], 'i32')
  if (typeof node === 'symbol') // JZ_NULL sentinel → null NaN
    return nullExpr()
  if (typeof node === 'bigint') {
    // Wrap to unsigned i64 range — emit as positive hex so downstream BigInt() parsers
    // (e.g. watr's optimize.js getConst) don't choke on "-0x..." strings.
    const n = node & 0xFFFFFFFFFFFFFFFFn
    return typed(['f64.reinterpret_i64', ['i64.const', '0x' + n.toString(16)]], 'f64')
  }
  if (typeof node === 'number') {
    if (Number.isInteger(node) && node >= -2147483648 && node <= 2147483647)
      return typed(['i32.const', node], 'i32')
    return typed(['f64.const', node], 'f64')
  }
  if (typeof node === 'string') {
    // Variable read: boxed / local / param / global (check before emitter table to avoid name collisions)
    if (ctx.func.boxed?.has(node) || ctx.func.locals?.has(node) || ctx.func.current?.params?.some(p => p.name === node) || isGlobal(node))
      return readVar(node)
    // Top-level function used as value → wrap as closure pointer for call_indirect
    if (ctx.func.names.has(node) && !ctx.func.locals?.has(node) && !ctx.func.current?.params?.some(p => p.name === node) && ctx.closure.table) {
      // Trampoline signature: uniform closure ABI (env f64, argc i32, a0..a{MAX-1} f64) → f64.
      // Forwards the first N inline slots to $func where N = func's fixed param count.
      const func = ctx.func.map.get(node)
      const sigParams = func?.sig.params || []
      if (sigParams.length > MAX_CLOSURE_ARITY) err(`Function ${node} used as closure value has ${sigParams.length} params, exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY}`)
      const trampolineName = `${T}tramp_${node}`
      if (!ctx.core.stdlib[trampolineName]) {
        const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
        const paramDecls = ['(param $__env f64)', '(param $__argc i32)']
        for (let i = 0; i < W; i++) paramDecls.push(`(param $__a${i} f64)`)
        // Forward fixed slots; if func expects i32, convert via trunc_sat
        const fwd = sigParams.map((p, i) =>
          p.type === 'i32'
            ? `(i32.trunc_sat_f64_s (local.get $__a${i}))`
            : `(local.get $__a${i})`).join(' ')
        if ((func?.sig.results.length || 1) > 1) {
          const n = func.sig.results.length
          const arr = `${T}retarr`
          const temps = Array.from({ length: n }, (_, i) => `${T}ret${i}`)
          const tempLocals = temps.map(name => `(local $${name} f64)`).join(' ')
          const stores = temps.map((name, i) =>
            `(f64.store (i32.add (local.get $${arr}) (i32.const ${i * 8})) (local.get $${name}))`
          ).join(' ')
          const capture = temps.slice().reverse().map(name => `(local.set $${name})`).join(' ')
          ctx.core.stdlib[trampolineName] = `(func $${trampolineName} ${paramDecls.join(' ')} (result f64) (local $${arr} i32) ${tempLocals} (call $${node} ${fwd}) ${capture} (local.set $${arr} (call $__alloc (i32.const ${n * 8 + 8}))) (i32.store (local.get $${arr}) (i32.const ${n})) (i32.store (i32.add (local.get $${arr}) (i32.const 4)) (i32.const ${n})) (local.set $${arr} (i32.add (local.get $${arr}) (i32.const 8))) ${stores} (call $__mkptr (i32.const 1) (i32.const 0) (local.get $${arr})))`
          inc(trampolineName, '__alloc', '__mkptr')
        } else {
          ctx.core.stdlib[trampolineName] = `(func $${trampolineName} ${paramDecls.join(' ')} (result f64) (call $${node} ${fwd}))`
          inc(trampolineName)
        }
      }
      let idx = ctx.closure.table.indexOf(trampolineName)
      if (idx < 0) { idx = ctx.closure.table.length; ctx.closure.table.push(trampolineName) }
      return mkPtrIR(PTR.CLOSURE, idx, 0)
    }
    // Emitter table: only namespace-resolved names (contain '.', e.g. 'math.PI') — safe from user variable collision
    if (node.includes('.') && ctx.core.emit[node]) return ctx.core.emit[node]()
    // Auto-import known host globals (WebAssembly, globalThis, etc.)
    const HOST_GLOBALS = new Set(['WebAssembly', 'globalThis', 'self', 'window', 'global', 'process'])
    if (HOST_GLOBALS.has(node) && !ctx.func.locals?.has(node) && !ctx.func.current?.params?.some(p => p.name === node) && !isGlobal(node)) {
      ctx.features.external = true
      ctx.scope.globals.set(node, null)
      ctx.module.imports.push(['import', '"env"', `"${node}"`, ['global', `$${node}`, ['mut', 'f64']]])
      return typed(['global.get', `$${node}`], 'f64')
    }
    const t = ctx.func.locals?.get(node) || ctx.func.current?.params.find(p => p.name === node)?.type || 'f64'
    return typed(['local.get', `$${node}`], t)
  }
  if (!Array.isArray(node)) return typed(['f64.const', 0], 'f64')

  const [op, ...args] = node
  // WASM IR passthrough: internally-generated IR nodes (from statement flattening) pass through
  if (typeof op === 'string' && !ctx.core.emit[op] && (op.includes('.') || WASM_OPS.has(op))) return node

  // Literal node [, value] — handle null/undefined values
  if (op == null && args.length === 1) {
    const v = args[0]
    return v === undefined ? undefExpr() : v === null ? nullExpr() : emit(v)
  }

  const handler = ctx.core.emit[op]
  if (!handler) err(`Unknown op: ${op}`)
  return handler(...args)
}
