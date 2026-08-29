/**
 * Builtins-as-first-class-closure-values: FIRST_CLASS_UNARY_MATH, FIRST_CLASS_BUILTIN_BODY, FIRST_CLASS_BUILTIN_NAMES (external contract: src/prepare/index.js), builtinFunctionValue. Needed by emit() itself.
 *
 * @module compile/emit/first-class
 */

import { T } from '../../ast.js'
import { LAYOUT, PTR, ctx, err, inc } from '../../ctx.js'
import { MAX_CLOSURE_ARITY, mkPtrIR } from '../../ir.js'


export const FIRST_CLASS_UNARY_MATH = {
  'math.abs': 'f64.abs',
  'math.sqrt': 'f64.sqrt',
  'math.ceil': 'f64.ceil',
  'math.floor': 'f64.floor',
  'math.trunc': 'f64.trunc',
}

// Builtins with a hand-written uniform-ABI body (beyond the single-op math set).
// Array.isArray: NaN-boxed AND tag==ARRAY → 1/0 — the same f64.convert_i32 form
// an arrow returning a comparison produces, so callback semantics match
// `xs.filter(x => Array.isArray(x))` exactly (watr's optimizer passes the bare
// builtin to .filter; the self-compile kernel must compile it).
export const FIRST_CLASS_BUILTIN_BODY = {
  'Array.isArray': () =>
    `(if (result f64) (i32.and (f64.ne (local.get $__a0) (local.get $__a0)) ` +
    `(i32.eq (i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $__a0)) (i64.const ${LAYOUT.TAG_SHIFT}))) (i32.const ${LAYOUT.TAG_MASK})) (i32.const ${PTR.ARRAY}))) ` +
    `(then (f64.const 1)) (else (f64.const 0)))`,
}

// Every builtin name `builtinFunctionValue` can mint a closure-table entry for.
// prepare's pre-emit scans (post-prep `visit` below, and recordModuleInitFacts's
// visitFuncValue) must recognize a bare reference to one of these as "needs the
// closure table" exactly like a user function name — otherwise a program whose
// ONLY first-class-function usage is a bare builtin reference (no user closures
// anywhere to otherwise trigger `fn` module inclusion) reaches emit with
// ctx.closure.table unset and builtinFunctionValue's precondition check fails.
export const FIRST_CLASS_BUILTIN_NAMES = new Set([...Object.keys(FIRST_CLASS_UNARY_MATH), ...Object.keys(FIRST_CLASS_BUILTIN_BODY)])

export function builtinFunctionValue(name) {
  const op = FIRST_CLASS_UNARY_MATH[name]
  const bodyGen = FIRST_CLASS_BUILTIN_BODY[name]
  if (!op && !bodyGen) err(`Builtin function '${name}' cannot be used as a first-class value (no closure form registered for it) — call it directly, or wrap it: (...a) => ${name}(...a)`)
  if (!ctx.closure.table) err(`Builtin function '${name}' used as value requires closure support`)
  const fn = `${T}builtin_${name.replace(/\W/g, '_')}`
  if (!ctx.core.stdlib[fn]) {
    const width = ctx.closure.width ?? MAX_CLOSURE_ARITY
    const params = ['(param $__env f64)', '(param $__argc i32)']
    for (let i = 0; i < width; i++) params.push(`(param $__a${i} f64)`)
    ctx.core.stdlib[fn] = `(func $${fn} ${params.join(' ')} (result f64) ${op ? `(${op} (local.get $__a0))` : bodyGen()})`
    inc(fn)
  }
  // ctx.closure.mint (not a bare table.push) — keeps ctx.closure.envMeta
  // aligned with ctx.closure.table by funcIdx; see module/function.js's
  // ctx.closure.mint doc (.work/research.md §Region arena, funcIdx skew).
  // A builtin-as-value closure is always zero-capture, so the default
  // {len:0, cellMask:0} meta is correct here.
  const idx = ctx.closure.mint(fn)
  const ir = mkPtrIR(PTR.CLOSURE, idx, 0)
  ir.closureFuncIdx = idx
  return ir
}
