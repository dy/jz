/**
 * Static WASM-op vocabulary (MEM_OPS/WASM_OPS/mutator sets) + literal and
 * purity classification of already-emitted IR nodes. Merges the original
 * file's adjacent '=== Constants ===' and '=== Literal / purity checks ==='
 * sections: MEM_OPS is a real shared dependency of hasLoadOp in this same
 * family, so splitting the two sections apart would have been artificial.
 * PURE_F64_OPS is exported (beyond the original private scope) only so
 * ir/coerce.js's toNumF64 can reach it -- not part of the barrel's public
 * re-export list, since it wasn't part of the original public API.
 *
 * @module ir/classify
 */

import { isI32, some, REFS_THROUGH_ARROWS } from '../ast.js'
import { typed } from './tag.js'
import { temp } from './locals.js'

/** Max arity of inline closure slots. Closures are compiled with signature
 *  (env f64, argc i32, a0..a{MAX-1} f64) → f64 — no per-call heap alloc.
 *  Direct (non-spread) calls with more args than MAX error. Spread calls are
 *  unbounded: the spread site publishes the full args-array offset in
 *  $__closure_spill, and a rest-param callee reads args[MAX..argc-1] from it
 *  (see module/function.js spread path + compile/index.js rest collection). */
export const MAX_CLOSURE_ARITY = 8

/** Matches WASM instructions that require a memory section. */

// Any instruction that touches linear memory ⇒ the module must declare memory.
// Matches every `memory.*` op (size/grow/copy/fill/init) and every typed load/store
// incl. width suffixes (load8_u, store16, i64.load32_s, v128.load, …). The old
// hand-enumerated list silently missed memory.copy/fill, v128.load/store and
// i64.store8/16/32 (all used in stdlib) — a body using only those would wrongly
// report no-memory. Broad-but-precise: only `memory.` and `<type>.load|store` match.
export const MEM_OPS = /\b(memory\.\w+|(?:i32|i64|f32|f64|v128)\.(?:load|store)\w*)\b/

export const WASM_OPS = new Set(['block','loop','if','then','else','br','br_if','call','call_indirect','return','return_call','throw','try_table','catch','nop','drop','unreachable','select','result','mut','param','func','module','memory','table','elem','data','type','import','export','local','global','ref'])

export const SPREAD_MUTATORS = new Set(['push', 'add', 'set', 'unshift'])

export const BOXED_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort'])

// === Pointer construction ===

/** Check if emitted node is a compile-time constant. */
export const isLit = n => (n[0] === 'i32.const' || n[0] === 'f64.const') && typeof n[1] === 'number'

// Unchecked — the caller must have proven isLit(n) first. Distinct contract from
// loop-model.js's loopLitVal / prepare/index.js's local numLitVal (post-prepare-AST,
// not emitted-IR, and both validate the literal shape before extracting).
export const litVal = n => n[1]

export const isNullLit = n => Array.isArray(n) && n.length === 2 && n[0] == null && n[1] == null

export const isUndefLit = n => Array.isArray(n) && n.length === 0

export const isNullishLit = n => isNullLit(n) || isUndefLit(n)

/** Side-effect-free (safe for WASM select). */
const PURE_OPS = new Set(['i32.const', 'f64.const', 'local.get', 'global.get',
  'f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.neg', 'f64.abs', 'f64.sqrt',
  'i32.add', 'i32.sub', 'i32.mul', 'i32.and', 'i32.or', 'i32.xor',
  'f64.convert_i32_s', 'f64.convert_i32_u', 'i32.trunc_sat_f64_s',
  'i32.wrap_i64', 'i64.trunc_sat_f64_s', 'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge',
  'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.gt_s', 'i32.le_s', 'i32.ge_s', 'i32.eqz',
  'select'])   // select of pure operands: both arms evaluate eagerly, no trap/effect — a nested

               // select chain (the branchless arm-update accumulator) stays select all the way
export const isPureIR = n => Array.isArray(n) && PURE_OPS.has(n[0]) && n.slice(1).every(c => !Array.isArray(c) || isPureIR(c))

// Ops PURE_OPS admits into `select` (no trap, no effect) but whose LATENCY is high
// enough that eagerly computing an arm that would otherwise be skipped can lose to a
// well-predicted branch: f64.div and f64.sqrt are non-pipelined/10-40+ cycles on most
// cores, unlike the single-cycle add/mul/compare/bitwise set PURE_OPS otherwise admits.
// (i32.div_s/u, i32.rem_s/u, and any `call` are already excluded from PURE_OPS itself —
// they trap or aren't provably effect-free — so they never reach a select gate at all;
// only these two f64 ops are "pure but expensive".) A select-gate site must veto BOTH
// arms with this predicate before choosing `select` over the lazy `if`/`else` — checked
// recursively so a cascaded N-way ternary (each level itself a pure select) doesn't hide
// an expensive op several levels down (a single div anywhere in the chain forces every
// level above it to eagerly pay for it every time `select` nests arms eagerly).
const EXPENSIVE_PURE_OPS = new Set(['f64.div', 'f64.sqrt'])

export const hasExpensiveOp = n => some(n, node => EXPENSIVE_PURE_OPS.has(node[0]), REFS_THROUGH_ARROWS)

// A select's CONDITION is a cost axis distinct from hasExpensiveOp's ARMS. `&&`/`||`
// lower short-circuit evaluation to a value-`if` whenever eager (i32.and/i32.or) isn't
// sound or isn't cheap — canonically `x < n && a[x] < a[x+1]` (a bounds guard ANDed with
// a load-bearing compare) becomes `if (result i32) (local.tee $t cond1) (then f64.lt
// (load)(load)) (else (local.get $t))` (emit.js '&&', the i32 fast path). Feeding THAT
// as a select's condition means every iteration pays the load's latency plus the tee/get
// shuffle unconditionally — even on the (common) iterations where cond1 alone would have
// short-circuited a lazy if/else past the load entirely. Measured on sort's "pick larger
// child" (`child+1<n && a[child]<a[child+1]) ? child+1 : child`): branch-form surgery on
// exactly this shape closed ~all of a 1.115x gap vs zig-wasm (checksum-stable).
// Scoped narrowly to the shape that regressed: a nested value-`if` (the short-circuit
// lowering, not a plain multi-compare chain — those either collapse to i32.and/i32.eqz
// upstream or never touch memory) whose subtree carries a memory load. A cheap
// comparison-only flag (`(h & 1) === 0`, noise's gradient sign-flip) never builds this
// shape at all and must keep `select`; vetoing on load-freedom alone would wrongly catch
// pointer-typed local.get reads too, so this checks for actual load OPS, not pointers.
const hasLoadOp = n => some(n, node => typeof node[0] === 'string' && MEM_OPS.test(node[0]), REFS_THROUGH_ARROWS)

export const dataDependentFlag = n => some(n, node => node[0] === 'if' && hasLoadOp(node), { boundary: node => node[0] === 'if' })

/** Ops whose f64 result is always a plain number (never a NaN-boxed pointer).
 *  Used by toNumF64 to skip the __to_num wrapper when the value is provably numeric.
 *  NOTE: f64.const is NOT included — it may encode a NaN-boxed pointer. */
export const PURE_F64_OPS = new Set([
  'f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.neg', 'f64.abs', 'f64.sqrt',
  'f64.min', 'f64.max', 'f64.ceil', 'f64.floor', 'f64.trunc', 'f64.nearest', 'f64.copysign',
  'f64.convert_i32_s', 'f64.convert_i32_u', 'f64.promote_f32',
])

/** True iff `r` provably yields a plain f64 NUMBER (never a NaN-boxed pointer or
 *  nullish sentinel). A `block`/`if` is numeric only when its value-producing tail
 *  is — so `o.a?.b` (a block whose result is a property value or undef sentinel)
 *  is correctly NOT numeric, while `cond ? n*2 : n*3` is. Conservative: any shape
 *  not provably numeric (property gets, user calls, local.get, f64.const nan:…)
 *  returns false, so the caller keeps the __to_num coercion. */
export const isNumericIR = (r) => {
  if (!Array.isArray(r)) return false
  const op = r[0]
  if (PURE_F64_OPS.has(op)) return true
  if (op === 'call' && typeof r[1] === 'string' && (r[1].startsWith('$math.') || r[1] === '$__time_ms')) return true
  if (op === 'f64.const') return typeof r[1] === 'number'   // 'nan:…' carrier ⇒ pointer/sentinel
  if (op === 'block') return isNumericIR(r[r.length - 1])   // block value = its tail expr
  if (op === 'if') {                                        // both arms must be numeric
    const thenArm = r.find(x => Array.isArray(x) && x[0] === 'then')
    const elseArm = r.find(x => Array.isArray(x) && x[0] === 'else')
    return !!thenArm && !!elseArm &&
      isNumericIR(thenArm[thenArm.length - 1]) && isNumericIR(elseArm[elseArm.length - 1])
  }
  return false
}

/** Resolve compile-time value type from AST node (literal → name → lookup). */
export const resolveValType = (node, valTypeOf, lookupValType) =>
  valTypeOf(node) ?? (typeof node === 'string' ? lookupValType(node) : null)

/** Check if (a, op, b) is a postfix pattern: [op, name] and [, 1] literal. */
export const isPostfix = (a, op, b) => Array.isArray(a) && a[0] === op && Array.isArray(b) && b[0] == null && b[1] === 1

/** Emit a numeric constant with correct i32/f64 typing.
 *  `-0` is f64-only (i32 has no signed zero) — preserve the sign by emitting f64. */
export const emitNum = v => isI32(v)
  ? typed(['i32.const', v], 'i32')
  // Emit NaN via the `nan` token, not the raw JS number: a numeric NaN literal in
  // the IR loses its quiet-mantissa bit (0x7FF8→0x7FF0, i.e. becomes Infinity) when
  // the self-host kernel marshals the IR back across the wasm→host boundary. The
  // `nan` token assembles to the canonical 0x7FF8 number-NaN unambiguously.
  // Number.isNaN, NOT `v !== v`: `v`'s static kind is ambiguous across emitNum's
  // whole call graph (any NaN-minting fold — pre-eval's constant division included —
  // can reach here), so in-kernel `!==` takes jz's own bit-equality `!==` dispatch,
  // where a sign-set qNaN (x86 wasm arithmetic's uncanonicalized 0/0, ∞−∞, 0·∞) reads
  // bit-equal to itself and the guard silently misses it — the raw negative-signed
  // NaN value then rides `node[1]` as an ambiguous-typed IR array element, which a
  // downstream self-hosted AST walk (watr's own `fold`) reads as a boxed pointer and
  // dereferences OOB (linux-x64-only self-compile CI failure). Number.isNaN unboxes
  // to f64 and uses f64.ne, which is sign-agnostic by IEEE754 — catches every
  // payload. Native no-op (v !== v and Number.isNaN(v) agree off-kernel). Mirrors the
  // identical fix watr's own optimize.js (getConst/makeConst) already carries for the
  // same root cause.
  : typed(['f64.const', Number.isNaN(v) ? 'nan' : v], 'f64')

// === Fresh ids / temp locals ===
