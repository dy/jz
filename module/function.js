/**
 * Function module — closures, first-class functions, call_indirect.
 *
 * Closures are NaN-boxed pointers: type=10 (PTR.CLOSURE), aux=funcIdx, offset=envPtr.
 * Closure body: (env: f64, ...params: f64) → f64 — env is pointer to captured values.
 * Captured variables stored as f64 in memory at envPtr.
 *
 * Auto-included when inner functions reference outer variables.
 *
 * @module fn
 */

import { typed, asF64, asI64, mkPtrIR, temp, tempI32, MAX_CLOSURE_ARITY, UNDEF_NAN, ptrTypeEq, throwTypeErrorIR } from '../src/ir.js'
import { emit, storedValue, storedValuePlanned, deps } from '../src/bridge.js'
import { constNumExpr } from '../src/static.js'
import { isReassigned } from '../src/ast.js'
import { findFreeVars } from '../src/compile/analyze.js'
import { BIGINT_REP_CLOSED, BIGINT_REP_BOXED, BIGINT_REP_RAW, REP_EDGE_REJECT, representationActiveMaterializedRep, representationClosureArgAction } from '../src/compile/representation-plan.js'
import { T } from '../src/ast.js'
import { VAL, lookupValType, repOf } from '../src/reps.js'
import { PTR, LAYOUT, inc, err, declGlobal, setLinkDemand, registerGetter } from '../src/ctx.js'
import { reachOn } from './core/reach.js'
import { compactOn } from './core/compact.js'
import { functionLength } from '../src/function.js'

const topLevelIntConsts = (body, captures) => {
  if (!captures.length) return null
  const inner = Array.isArray(body) && body[0] === '{}' ? body[1] : body
  if (!Array.isArray(inner) || inner[0] !== ';') return null
  let out = null
  for (let s = 1; s < inner.length; s++) {
    const stmt = inner[s]
    if (!Array.isArray(stmt) || (stmt[0] !== 'const' && stmt[0] !== 'let')) continue
    for (let i = 1; i < stmt.length; i++) {
      const decl = stmt[i]
      if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
      if (!captures.includes(decl[1])) continue
      if (stmt[0] === 'let' && isReassigned(body, decl[1])) continue
      const v = constNumExpr(decl[2])
      if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) (out ||= new Map()).set(decl[1], v)
    }
  }
  return out
}


export default (ctx) => {
  inc('__mkptr', '__alloc', '__len', '__ptr_offset', '__ptr_type')

  // Uniform closure convention: (env f64, argc i32, a0..a{MAX-1} f64) → f64
  if (!ctx.closure.types) ctx.closure.types = new Set()
  if (!ctx.closure.table) ctx.closure.table = []
  if (!ctx.closure.lengths) ctx.closure.lengths = []
  if (!ctx.closure.bodies) ctx.closure.bodies = []
  ctx.closure.types.add(1) // presence triggers $ftN type emission

  ctx.closure.mint = (name, length) => {
    let idx = ctx.closure.table.indexOf(name)
    if (idx === -1) {
      idx = ctx.closure.table.length
      ctx.closure.table.push(name)
      ctx.closure.lengths.push(length)
    }
    return idx
  }

  // A slot's source arity, one byte per table slot: a lazy table
  // (wat/assemble/stdlib-pull.js injectTable) laid out once the table is
  // whole, its base global re-pointed wherever a later strip moves data.
  // A bound function's is its target's less the arguments it binds, at least
  // zero (ES 20.2.3.2 step 5), through every bind between them.
  const slotOf = fn => `(i32.wrap_i64 (i64.and (i64.shr_u ${fn} (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK})))`
  ctx.core.stdlib.__closure_length = () => {
    if (!ctx.scope.globals.has('__closure_len_tbl')) declGlobal('__closure_len_tbl', 'i32')
    const bound = ctx.closure.table.indexOf(BOUND)
    const len = `(i32.load8_u (i32.add (global.get $__closure_len_tbl) ${slotOf('(local.get $fn)')}))`
    if (bound < 0) return `(func $__closure_length (param $fn i64) (result i32) ${len})`
    return `(func $__closure_length (param $fn i64) (result i32) (local $k i32) (local $n i32)
      (block $target (loop $unbind
        (br_if $target (i32.ne ${slotOf('(local.get $fn)')} (i32.const ${bound})))
        (local.set $k (i32.add (local.get $k) (i32.trunc_f64_u (f64.load offset=16 (i32.wrap_i64 (local.get $fn))))))
        (local.set $fn (i64.load (i32.wrap_i64 (local.get $fn))))
        (br $unbind)))
      (local.set $n ${len})
      (select (i32.sub (local.get $n) (local.get $k)) (i32.const 0) (i32.gt_u (local.get $n) (local.get $k))))`
  }

  // Function.prototype.bind (ES 20.2.3.2): a bound function is a closure of
  // the one trampoline `__bound`, over an environment of its target, its
  // receiver, the count of arguments it binds and those arguments:
  // [target, this, k, arg0 … arg{k-1}]. A call places the bound arguments in
  // the leading slots and its own after them, the count the sum; past the
  // slots they go in a fresh array published as the spill, as a spread
  // call's (closure-emit.js reads a rest parameter's tail there). No call
  // allocates while they fit. The target was a closure when it was bound.
  const BOUND = '__bound'
  const boundEnvOf = '(i32.wrap_i64 (i64.and (i64.reinterpret_f64 (local.get $env)) (i64.const 4294967295)))'
  ctx.core.stdlib[BOUND] = () => {
    const W = ctx.closure.width ?? MAX_CLOSURE_ARITY, lanes = Array.from({ length: W }, (_, i) => i)
    const self = ctx.closure.receiver ? '(f64.load offset=8 (local.get $e))' : ''
    const call = (slots) => `(call_indirect (type $ftN) (local.get $fn) (local.get $n) ${slots.join(' ')} ${self}
      ${slotOf('(i64.reinterpret_f64 (local.get $fn))')})`
    // k bound ahead: slot j holds bound argument j below k, the call's argument j - k from there
    const ahead = k => call(lanes.map(j => j < k ? `(f64.load offset=${24 + 8 * j} (local.get $e))` : `(local.get $a${j - k})`))
    let cases = `(br_table ${[...lanes, W].map(k => `$k${k}`).join(' ')} (local.get $k))`
    for (let k = 0; k < W; k++) cases = `(block $k${k} ${cases}) (br $done ${ahead(k)})`
    return `(func $${BOUND} (param $env f64) (param $argc i32)${lanes.map(i => ` (param $a${i} f64)`).join('')}${ctx.closure.receiver ? ' (param $this f64)' : ''} (result f64)
      (local $e i32) (local $k i32) (local $n i32) (local $fn f64) (local $s i32) (local $p i32)
      (local.set $e ${boundEnvOf})
      (local.set $fn (f64.load (local.get $e)))
      (local.set $k (i32.trunc_f64_u (f64.load offset=16 (local.get $e))))
      (local.set $n (i32.add (local.get $k) (local.get $argc)))
      (if (result f64) (i32.le_u (local.get $n) (i32.const ${W}))
        (then (block $done (result f64) (block $k${W} ${cases}) ${ahead(W)}))
        (else
          (local.set $s (call $__alloc_hdr (local.get $n) (local.get $n)))
          (memory.copy (local.get $s) (i32.add (local.get $e) (i32.const 24)) (i32.shl (local.get $k) (i32.const 3)))
          (local.set $p (i32.add (local.get $s) (i32.shl (local.get $k) (i32.const 3))))
          ${lanes.map(i => `(if (i32.gt_u (local.get $argc) (i32.const ${i})) (then (f64.store offset=${8 * i} (local.get $p) (local.get $a${i}))))`).join('\n          ')}
          (if (i32.gt_u (local.get $argc) (i32.const ${W}))
            (then (memory.copy (i32.add (local.get $p) (i32.const ${8 * W})) (i32.add (global.get $__closure_spill) (i32.const ${8 * W}))
              (i32.shl (i32.sub (local.get $argc) (i32.const ${W})) (i32.const 3)))))
          (global.set $__closure_spill (local.get $s))
          ${call(lanes.map(j => `(f64.load offset=${8 * j} (local.get $s))`))})))`
  }
  // A bound function's environment: k + 3 slots, counted in a header where a
  // walk reads what a closure holds (as closure.make allocates one).
  const walkedEnv = () => (!!ctx.plans.hasSites && reachOn()) || compactOn()
  const boundEnv = (n) => walkedEnv()
    ? (inc('__alloc_hdr'), ['call', '$__alloc_hdr', n, n])
    : ['call', '$__alloc', ['i32.shl', n, ['i32.const', 3]]]
  // `fn.bind(...args)`, its arguments one array (a spread among them): this its first, the bound the rest.
  ctx.core.stdlib.__bind_array = () => `(func $__bind_array (param $fn f64) (param $args f64) (result f64)
    (local $a i32) (local $n i32) (local $k i32) (local $e i32)
    (local.set $a (call $__ptr_offset (i64.reinterpret_f64 (local.get $args))))
    (local.set $n (call $__len (i64.reinterpret_f64 (local.get $args))))
    (local.set $k (select (i32.sub (local.get $n) (i32.const 1)) (i32.const 0) (i32.gt_s (local.get $n) (i32.const 0))))
    (local.set $e ${walkedEnv() ? '(call $__alloc_hdr (i32.add (local.get $k) (i32.const 3)) (i32.add (local.get $k) (i32.const 3)))'
      : '(call $__alloc (i32.shl (i32.add (local.get $k) (i32.const 3)) (i32.const 3)))'})
    (f64.store (local.get $e) (local.get $fn))
    (f64.store offset=8 (local.get $e) (if (result f64) (local.get $n) (then (f64.load (local.get $a))) (else (f64.const nan:${UNDEF_NAN}))))
    (f64.store offset=16 (local.get $e) (f64.convert_i32_u (local.get $k)))
    (memory.copy (i32.add (local.get $e) (i32.const 24)) (i32.add (local.get $a) (i32.const 8)) (i32.shl (local.get $k) (i32.const 3)))
    (call $__mkptr (i32.const ${PTR.CLOSURE}) (i32.const ${ctx.closure.table.indexOf(BOUND)}) (local.get $e)))`
  /** `fn.bind(thisArg, ...args)` of the closure `target` (emitted IR): the
   *  bound function. `args` are the call's, AST nodes or emitted IR; with
   *  `spread`, one array holding them all. JS order: the target, then the
   *  arguments, then the allocation. */
  // Function.prototype's call, apply and bind read as values (`typeof f.bind`,
  // `const c = f.call`): a closure each, its target the receiver of a call of
  // it, which the closure ABI passes where the program reads `this`
  // (ctx.closure.receiver). Where it does not, no call can name the target,
  // and a call throws, as one with no function receiver does.
  const PROTO = { call: '__fn_call', apply: '__fn_apply', bind: '__fn_bind' }
  const PROTO_LENGTH = { call: 1, apply: 2, bind: 1 }
  // argument i of a stub's call: a slot, past the slots the spill
  const argAt = (W, i) => i < W ? `(local.get $a${i})`
    : `(if (result f64) (i32.gt_u (local.get $argc) (i32.const ${i})) (then (f64.load offset=${8 * i} (global.get $__closure_spill))) (else (f64.const nan:${UNDEF_NAN})))`
  const protoStub = (name, body) => () => {
    const W = ctx.closure.width ?? MAX_CLOSURE_ARITY, lanes = Array.from({ length: W }, (_, i) => i)
    const head = `(func $${PROTO[name]} (param $env f64) (param $argc i32)${lanes.map(i => ` (param $a${i} f64)`).join('')}${ctx.closure.receiver ? ' (param $this f64)' : ''} (result f64)`
    if (!ctx.closure.receiver) return `${head} (call $__throw_not_callable) (unreachable))`
    // (the receiver it gives the target, its first argument, is read before the spill moves)
    return `${head} (local $n i32) (local $p i32) (local $e i32) (local $last f64) (local $t f64)
      (if (i32.ne ${ptrTypeOf('(local.get $this)')} (i32.const ${PTR.CLOSURE})) (then (call $__throw_not_callable) (unreachable)))
      (local.set $t ${argAt(W, 0)})
      ${body(W, lanes)})`
  }
  const ptrTypeOf = v => `(i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 ${v}) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))`
  const targetCall = (W, argc, slots, self) => `(call_indirect (type $ftN) (local.get $this) ${argc} ${slots.join(' ')} ${self}
    ${slotOf('(i64.reinterpret_f64 (local.get $this))')})`
  // f.call(t, ...args): the arguments one place down, the spill with them
  ctx.core.stdlib.__fn_call = protoStub('call', (W, lanes) => `
    (local.set $n (select (i32.sub (local.get $argc) (i32.const 1)) (i32.const 0) (i32.gt_s (local.get $argc) (i32.const 0))))
    (local.set $last ${argAt(W, W)})
    (if (i32.gt_u (local.get $argc) (i32.const ${W + 1})) (then (global.set $__closure_spill (i32.add (global.get $__closure_spill) (i32.const 8)))))
    ${targetCall(W, '(local.get $n)', lanes.map(j => j + 1 < W ? `(local.get $a${j + 1})` : '(local.get $last)'), '(local.get $t)')}`)
  // f.apply(t, args): the arguments of the array, published as a spread call's are
  ctx.core.stdlib.__fn_apply = protoStub('apply', (W, lanes) => `
    (local.set $last ${argAt(W, 1)})
    (if (i32.eqz (call $__is_nullish (i64.reinterpret_f64 (local.get $last))))
      (then
        (local.set $p (call $__ptr_offset (i64.reinterpret_f64 (local.get $last))))
        (local.set $n (call $__len (i64.reinterpret_f64 (local.get $last))))
        (global.set $__closure_spill (local.get $p))))
    ${targetCall(W, '(local.get $n)', lanes.map(j => `(if (result f64) (i32.gt_u (local.get $n) (i32.const ${j})) (then (f64.load offset=${8 * j} (local.get $p))) (else (f64.const nan:${UNDEF_NAN})))`), '(local.get $t)')}`)
  // f.bind(t, ...args): the bound function, its arguments after the first bound
  ctx.core.stdlib.__fn_bind = protoStub('bind', (W, lanes) => `
    (local.set $n (select (i32.sub (local.get $argc) (i32.const 1)) (i32.const 0) (i32.gt_s (local.get $argc) (i32.const 0))))
    (local.set $e ${walkedEnv() ? '(call $__alloc_hdr (i32.add (local.get $n) (i32.const 3)) (i32.add (local.get $n) (i32.const 3)))'
      : '(call $__alloc (i32.shl (i32.add (local.get $n) (i32.const 3)) (i32.const 3)))'})
    (f64.store (local.get $e) (local.get $this))
    (f64.store offset=8 (local.get $e) (local.get $t))
    (f64.store offset=16 (local.get $e) (f64.convert_i32_u (local.get $n)))
    ${lanes.slice(1).map(i => `(if (i32.gt_u (local.get $argc) (i32.const ${i})) (then (f64.store offset=${16 + 8 * i} (local.get $e) (local.get $a${i}))))`).join('\n    ')}
    (if (i32.gt_u (local.get $argc) (i32.const ${Math.max(W, 1)}))
      (then (memory.copy (i32.add (local.get $e) (i32.const ${16 + 8 * Math.max(W, 1)})) (i32.add (global.get $__closure_spill) (i32.const ${8 * Math.max(W, 1)}))
        (i32.shl (i32.sub (local.get $argc) (i32.const ${Math.max(W, 1)})) (i32.const 3)))))
    (call $__mkptr (i32.const ${PTR.CLOSURE}) (i32.const ${ctx.closure.table.indexOf(BOUND)}) (local.get $e))`)
  /** The value of Function.prototype's `name` member (call, apply or bind): a closure of its stub. */
  ctx.closure.protoMember = (name) => {
    const slot = ctx.closure.mint(PROTO[name], PROTO_LENGTH[name])
    ;(ctx.closure.noProto ??= new Set()).add(slot)
    if (name === 'bind') { ctx.closure.mint(BOUND, 0); inc(BOUND) }
    inc(PROTO[name])
    setLinkDemand('closure')
    declGlobal('__closure_spill', 'i32')
    return mkPtrIR(PTR.CLOSURE, slot, 0)
  }
  deps({
    __fn_call: ['__throw_not_callable'],
    __fn_apply: ['__throw_not_callable', '__is_nullish', '__ptr_offset', '__len'],
    __fn_bind: () => ['__throw_not_callable', '__mkptr', BOUND, walkedEnv() ? '__alloc_hdr' : '__alloc'],
    [BOUND]: ['__alloc_hdr'],
    __bind_array: () => ['__ptr_offset', '__len', '__mkptr', walkedEnv() ? '__alloc_hdr' : '__alloc'],
  })
  ctx.closure.bound = (target, args, spread = false) => {
    const slot = ctx.closure.mint(BOUND, 0)
    inc(BOUND)
    setLinkDemand('closure')
    // (the trampoline publishes a long call's arguments there; a host call of it sets it first)
    declGlobal('__closure_spill', 'i32')
    const fn = temp('bfn'), setup = [['local.set', `$${fn}`, asF64(target)]]
    if (spread) {
      inc('__bind_array')
      return typed(['block', ['result', 'f64'], ...setup, ['call', '$__bind_array', ['local.get', `$${fn}`], asF64(args[0])]], 'f64')
    }
    const vals = args.map(a => { const t = temp('barg'); setup.push(['local.set', `$${t}`, ctx.closure.argIR(a)]); return t })
    const k = Math.max(0, vals.length - 1), e = tempI32('benv'), at = i => ['i32.add', ['local.get', `$${e}`], ['i32.const', i * 8]]
    setup.push(['local.set', `$${e}`, boundEnv(['i32.const', k + 3])],
      ['f64.store', at(0), ['local.get', `$${fn}`]],
      ['f64.store', at(1), vals.length ? ['local.get', `$${vals[0]}`] : UNDEF_LIT()],
      ['f64.store', at(2), ['f64.const', k]])
    for (let i = 1; i < vals.length; i++) setup.push(['f64.store', at(2 + i), ['local.get', `$${vals[i]}`]])
    return typed(['block', ['result', 'f64'], ...setup, mkPtrIR(PTR.CLOSURE, slot, ['local.get', `$${e}`])], 'f64')
  }
  // The host's call of a closure it holds (interop.js reads one as a JS
  // function). Values cross as i64 bits, as every boxed boundary value does.
  // `argc` counts the host's arguments; past the inline lanes a rest
  // parameter reads them from `spill`, the host's array of all of them (a
  // spread call's $__closure_spill).
  ctx.core.stdlib.__call_closure = () => {
    const lanes = Array.from({ length: ctx.closure.width ?? MAX_CLOSURE_ARITY }, (_, i) => i)
    return `(func $__call_closure (export "__jz_call_closure") (param $clos i64) (param $argc i32) (param $spill i32) (param $this i64)${lanes.map(i => ` (param $a${i} i64)`).join('')} (result i64)
      ${ctx.scope.globals.has('__closure_spill') ? '(global.set $__closure_spill (local.get $spill))' : ''}
      (i64.reinterpret_f64 (call_indirect (type $ftN)
        (f64.reinterpret_i64 (local.get $clos))
        (local.get $argc)
        ${lanes.map(i => `(f64.reinterpret_i64 (local.get $a${i}))`).join(' ')}
        ${ctx.closure.receiver ? '(f64.reinterpret_i64 (local.get $this))' : ''}
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $clos) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))))`
  }

  registerGetter('.closure:length', fn => {
    inc('__closure_length')
    return typed(['call', '$__closure_length', asI64(emit(fn))], 'i32')
  })

  // A call the call-site rows never see (emit/call.js tryDirectClosureCall)
  // opens them: one in a closure's body emits past every closure's plan, and a
  // closure its binding hands on as a value is called where no row looks
  // (emit/dispatch.js rowsSeeEveryCall). Such a closure holds what the summary
  // proves of its parameters, not what the rows saw.
  const openCallRows = ctx.closure.openRows = (bodyName) => {
    const width = ctx.closure.width ?? MAX_CLOSURE_ARITY, no = [], none = []
    for (let i = 0; i < width; i++) { no.push(false); none.push(null) }
    ;(ctx.closure.paramTypes ||= new Map()).set(bodyName, no)
    ;(ctx.closure.paramTypedCtors ||= new Map()).set(bodyName, none)
    ;(ctx.closure.minArgc ||= new Map()).set(bodyName, 0)
  }

  /**
   * Create a closure: compile inner function as closure body, capture outer vars.
   * @param {{ params: string[], body, captures: string[], restParam: string|null }} info
   * @returns {WasmNode} NaN-boxed closure pointer
   */
  ctx.closure.make = ({ params, body, captures, restParam, defaults, scope, noProto, self }) => {
    const fixedN = params.length - (restParam ? 1 : 0)
    if (fixedN > MAX_CLOSURE_ARITY) err(`Closure with ${fixedN} fixed params exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY}`)
    if (restParam && fixedN >= MAX_CLOSURE_ARITY) err(`Closure with rest param needs at least one free slot — ${fixedN} fixed params leaves none (MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY})`)
    // Generate closure body function name
    const fnName = `${T}closure${ctx.closure.table.length}`
    const owner = ctx.func.current?.name ?? ctx.closure.emitting
    if (owner) (ctx.closure.owner ??= new Map()).set(fnName, owner)
    // The summary's closure this body is (undefined for a body it never saw:
    // one cloned after it ran): link reads a resolved call's targets by it.
    ;(ctx.closure.summaryId ??= new Map()).set(fnName, ctx.summary?.closureIdOfBody?.(body))

    const localIntConsts = ctx.func.body ? topLevelIntConsts(ctx.func.body, captures) : null
    const captureIntConsts = new Map()
    for (const name of captures) {
      // Third fallback: a depth≥2 capture chain whose constant was
      // declared in an ANCESTOR closure, not the current one, is invisible
      // to topLevelIntConsts(ctx.func.body) (current-frame-only) and
      // ctx.scope.constInts (module-only) alike — repOf(name)?.intConst
      // carries it forward regardless, since the ancestor's own
      // seedClosureFrame already republished its fold into this frame's
      // localReps before this arrow's capture set is derived.
      const v = ctx.scope.constInts?.get(name) ?? localIntConsts?.get(name) ?? repOf(name)?.intConst
      if (v != null && !ctx.func.boxed?.has(name)) captureIntConsts.set(name, v)
    }
    const envCaptures = captures.filter(name => !captureIntConsts.has(name) && name !== self)
    const boxedCaptures = envCaptures.filter(c => ctx.func.boxed?.has(c))

    const captureValTypes = new Map()
    const captureSchemaVars = new Map()
    const captureTypedElems = new Map()
    // Propagate parent's intCertain rep across captures: the parent's narrower
    // already guarantees every defining RHS (including assignments inside
    // nested arrows) is integer-valued, so the f64 round-trip through the env
    // slot preserves integer semantics. Consumers inside the inner body —
    // `toNumF64` elision (src/ir.js), math fast paths (module/math.js),
    // bitwise-key indexing (src/emit.js) — fire on captures just as they
    // would on directly-declared locals.
    const captureIntCertain = new Set()
    // Propagate parent's directClosures across captures: a const-bound closure captured
    // by an inner arrow can still be direct-dispatched in the inner body (skip
    // call_indirect on the captured pointer). Gated on isReassigned over the inner body
    // so a local rewrite of the captured name disables propagation.
    const captureDirectClosures = new Map()
    // Propagate the parent's `nullable` mark: a capture whose parent binding can
    // hold null/undefined (e.g. `let x = null` later assigned a number) must keep
    // that fact inside the body, or the body's own write facts (val = NUMBER)
    // would let `x == null` fold to a constant false and skip the guard.
    const captureNullables = new Set()
    // Propagate the parent's `mayBeUndefined` mark (Slice 2,
    // .work/archive/represented-maybe-undefined-design.md §3 "Closure captures") — the container-read
    // sibling of captureNullables just above, same reasoning: a capture whose
    // parent binding can be real JS `undefined` despite a definite `val` claim
    // must keep that fact inside the body, or the body's own write facts
    // would let it evaporate at the capture boundary.
    const captureMayBeUndefineds = new Set()
    const captureBigintReps = new Map()
    for (const name of envCaptures) {
      const carrier = representationActiveMaterializedRep(ctx, name)
      if (carrier === (BIGINT_REP_RAW | BIGINT_REP_CLOSED) || carrier === (BIGINT_REP_BOXED | BIGINT_REP_CLOSED)) captureBigintReps.set(name, carrier)
      const vt = lookupValType(name)
      if (vt != null) captureValTypes.set(name, vt)
      const schemaId = ctx.schema.idOf(name)
      if (schemaId != null) captureSchemaVars.set(name, schemaId)
      const elemType = ctx.func.typedElem?.get(name)
      if (elemType != null) captureTypedElems.set(name, elemType)
      const bodyName = ctx.func.directClosures?.get(name)
      if (bodyName && !isReassigned(body, name)) { captureDirectClosures.set(name, bodyName); openCallRows(bodyName) }
      if (repOf(name)?.intCertain === true) captureIntCertain.add(name)
      if (repOf(name)?.nullable) captureNullables.add(name)
      if (repOf(name)?.mayBeUndefined) captureMayBeUndefineds.add(name)
    }

    if (self != null) { captureValTypes.set(self, VAL.CLOSURE); captureDirectClosures.set(self, fnName); openCallRows(fnName) }

    // findFreeVars's `scope` param needs BOTH `.has(name)` (membership test)
    // AND `.add(name)` (analyze-scans.js's own `let`/`const`/`for(let…)`
    // branches call `collectParamNames(decls, scope)`, which does `scope.add`,
    // to record body-local shadow declarations so a same-named inner `let`
    // doesn't get misread as a free reference to the outer schema var) — a
    // real mutable Set interface, not a plain read-only lookup. The old
    // `new Set(ctx.schema.vars.keys())` materialized a FULL COPY of the
    // program-wide schema table to get that interface, at O(program schema-
    // table size) PER CLOSURE LITERAL (fires for every arrow/function
    // expression seen while ANY body emits, not just ones that end up
    // capturing anything — .work/evidence.md's MapOverlay fix targets the
    // same shape-class one level down, at closure-body-EMISSION time; this
    // site is the more frequent, likely-dominant sibling, at closure-CREATION
    // time). `scopeOwn` below is the SAME two-layer split MapOverlay uses —
    // `.add` writes ONLY into a fresh per-closure Set (bounded by this one
    // closure's own local declarations), `.has` falls through to the real
    // ctx.schema.vars table on miss — so shadow-tracking writes never leak
    // into the shared program-wide map, and constructing the view is O(1).
    if (ctx.schema.vars) {
      const scopeOwn = new Set()
      const schemaVars = ctx.schema.vars
      const scope = { has: (name) => scopeOwn.has(name) || schemaVars.has(name), add: (name) => scopeOwn.add(name) }
      const refs = []
      findFreeVars(body, new Set(params), refs, scope)
      for (const def of Object.values(defaults || {})) findFreeVars(def, new Set(params), refs, scope)
      for (const name of refs) {
        if (captureSchemaVars.has(name)) continue
        const schemaId = ctx.schema.idOf(name)
        if (schemaId != null) captureSchemaVars.set(name, schemaId)
      }
    }

    // i32-narrowed cells travel with the capture: the closure body must access
    // the shared cell at the same width the owner does (see funcFacts.cellTypes).
    const cellI32Captures = boxedCaptures.filter(c => ctx.func.cellTypes?.has(c))
    // Fixed-shape closure-plan record. Conditional spreads used to create a
    // family of HASH-shaped records; region compaction could relocate the
    // outer bodies array while losing one optional-shape member (`params`
    // became null at full jz×jz scale). Null sentinels preserve every existing
    // truthy/optional consumer and give the relocator one stable slot layout.
    const bodyFn = {
      name: fnName, params, body, captures: envCaptures, arity: 1,
      scope: scope ?? null,
      rest: restParam || null,
      defaults: defaults || null,
      boxed: boxedCaptures.length ? new Set(boxedCaptures) : null,
      cellI32: cellI32Captures.length ? new Set(cellI32Captures) : null,
      intConsts: captureIntConsts.size ? captureIntConsts : null,
      intCertain: captureIntCertain.size ? captureIntCertain : null,
      nullables: captureNullables.size ? captureNullables : null,
      mayBeUndefineds: captureMayBeUndefineds.size ? captureMayBeUndefineds : null,
      bigintReps: captureBigintReps.size ? captureBigintReps : null,
      valTypes: captureValTypes.size ? captureValTypes : null,
      schemaVars: captureSchemaVars.size ? captureSchemaVars : null,
      typedElems: captureTypedElems.size ? captureTypedElems : null,
      directClosures: captureDirectClosures.size ? captureDirectClosures : null,
      self: self ?? null,
    }
    ctx.closure.bodies.push(bodyFn)

    const tableIdx = ctx.closure.mint(fnName, functionLength(params, defaults, restParam))
    if (noProto) (ctx.closure.noProto ??= new Set()).add(tableIdx)

    // At call site: allocate env, store captured values, return NaN-boxed pointer.
    // Tag IR with .closureBodyName so emitDecl can register the binding for direct dispatch
    // (skip call_indirect on a const-bound, non-escaping closure local). See emit.js '()' handler.
    setLinkDemand('closure')
    if (envCaptures.length === 0) {
      // No captures — just a function reference
      const ir = mkPtrIR(PTR.CLOSURE, tableIdx, 0)
      ir.closureBodyName = fnName
      ir.closureFuncIdx = tableIdx
      return ir
    }

    const t = tempI32('env')

    // Where a frame may keep what its escapes reach (module/core/reach.js), the
    // environment carries its count in a header, as an array does: the walk
    // reads there how many slots a closure it met holds, and a cell's address
    // fills its slot whole, the high word zero, so what the memory held
    // before reads as no value.
    const walked = (!!ctx.plans.hasSites && reachOn()) || compactOn()
    const env = walked
      ? (inc('__alloc_hdr'), ['call', '$__alloc_hdr', ['i32.const', envCaptures.length], ['i32.const', envCaptures.length]])
      : ['call', '$__alloc', ['i32.const', envCaptures.length * 8]]
    const block = [['local.set', `$${t}`, env]]
    // Store captured values in env: boxed cells as raw i32 in low 4 bytes, others as f64.
    // Avoids i32↔f64 roundtrip; body loads via i32.load/f64.load using the same branch.
    for (let i = 0; i < envCaptures.length; i++) {
      const addr = ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]]
      if (ctx.func.boxed?.has(envCaptures[i])) {
        const cell = ['local.get', `$${ctx.func.boxed.get(envCaptures[i])}`]
        block.push(walked ? ['i64.store', addr, ['i64.extend_i32_u', cell]] : ['i32.store', addr, cell])
      }
      // A Boolean-or-Number binding the closure observes holds its atoms
      // itself (kind.js boolTagged): the capture copies the value.
      else block.push(['f64.store', addr, asF64(emit(envCaptures[i]))])
    }
    block.push(mkPtrIR(PTR.CLOSURE, tableIdx, ['local.get', `$${t}`]))

    const ir = typed(['block', ['result', 'f64'], ...block], 'f64')
    ir.closureBodyName = fnName
    ir.closureFuncIdx = tableIdx
    return ir
  }

  const UNDEF_LIT = () => ['f64.const', `nan:${UNDEF_NAN}`]

  /**
   * Call a closure value: pass args inline as a0..a{MAX-1} + argc, call_indirect.
   * @param {WasmNode} closureExpr - Already-emitted closure pointer expression
   * @param {any[]} args - AST nodes (will be emitted) OR pre-emitted nodes (if .type is set)
   * @param {boolean} prebuiltArray - args[0] is a pre-built args array (spread path)
   */
  /** One argument in the closure ABI's slot form: an AST node by its representation action, pre-emitted IR (has .type) as is. */
  ctx.closure.argIR = (a) => {
    if (a?.type) return asF64(a)
    const action = representationClosureArgAction(ctx, a)
    return action === REP_EDGE_REJECT ? storedValue(a) : storedValuePlanned(a, action)
  }
  ctx.closure.call = (closureExpr, args, prebuiltArray, check = false, thisArg = null) => {
    const t = temp('clos'), recv = typed(['local.get', `$${t}`], 'f64')
    // Every caller captures the callee before evaluating inline or spread args.
    const setup = [['local.set', `$${t}`, asF64(closureExpr)]]
    const receiver = thisArg ? temp('recv') : null
    if (receiver) setup.push(['local.set', `$${receiver}`, asF64(thisArg)])
    const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
    const slots = []
    let argc
    if (prebuiltArray) {
      // Publish the full argument array for rest parameters beyond inline width W.
      declGlobal('__closure_spill', 'i32')
      const arrT = tempI32('sa'), lenL = tempI32('sl'), arrPtrF64 = temp('sp')
      setup.push(['local.set', `$${arrPtrF64}`, asF64(args[0])])
      setup.push(['local.set', `$${arrT}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${arrPtrF64}`]]]])
      setup.push(['local.set', `$${lenL}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${arrPtrF64}`]]]])
      setup.push(['global.set', '$__closure_spill', ['local.get', `$${arrT}`]])
      argc = ['local.get', `$${lenL}`]
      for (let i = 0; i < W; i++) slots.push(['if', ['result', 'f64'],
        ['i32.gt_s', argc, ['i32.const', i]],
        ['then', ['f64.load', ['i32.add', ['local.get', `$${arrT}`], ['i32.const', i * 8]]]],
        ['else', UNDEF_LIT()]])
    } else {
      if (args.length > MAX_CLOSURE_ARITY) err(`Closure call with ${args.length} args exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY}`)
      // The uniform type carries W slots, and W covers every declared parameter
      // list, so an argument past it is one no callee could name.
      const n = Math.min(args.length, W)
      argc = ['i32.const', n]
      for (let i = 0; i < n; i++) {
        const arg = ctx.closure.argIR(args[i])
        if (!check) slots.push(arg)
        else {
          const a = temp('carg')
          setup.push(['local.set', `$${a}`, arg])
          slots.push(['local.get', `$${a}`])
        }
      }
      for (let i = n; i < W; i++) slots.push(UNDEF_LIT())
    }
    const call = ['call_indirect', ['type', '$ftN'], recv, argc, ...slots,
      ...(ctx.closure.receiver ? [receiver ? ['local.get', `$${receiver}`] : UNDEF_LIT()] : []),
      ['i32.wrap_i64', ['i64.and',
        ['i64.shr_u', ['i64.reinterpret_f64', recv], ['i64.const', LAYOUT.AUX_SHIFT]],
        ['i64.const', LAYOUT.AUX_MASK]]]]
    // Unproven member slots need a check after argument effects. Other callers
    // already established callability through analysis or runtime dispatch.
    return typed(['block', ['result', 'f64'], ...setup, check
      ? ['if', ['result', 'f64'], ptrTypeEq(recv, PTR.CLOSURE),
        ['then', call], ['else', throwTypeErrorIR('call')]]
      : call], 'f64')
  }
}
