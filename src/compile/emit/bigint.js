/**
 * BigInt joint-domain dispatch: static domain classification (bigIntDomain/isBigIntCarrierBits/bigIntDomainsCanMix/numLiteralNode/bigintMixReject), the runtime-forked binary dispatch (bigIntJointDispatch/computedBoxOf), and the i64 operand/shift/member-assign helpers (bigIntOperand/bigIntUnary/bigIntShiftIR/bigintMemberAssignTarget). Used by Assignment's compoundAssign, Arithmetic's +, -, *, / and %, Bitwise's ~/&/|/^/<</>>, and Comparisons' cmpOp.
 *
 * @module compile/emit/bigint
 */

import { ERR } from '../../../err-codes.js'
import { isReassigned } from '../../ast.js'
import { ctx, err } from '../../ctx.js'
import {
  asF64, asI64, boxBigInt, fromI64, isUndef, maybeUnboxBigInt, readI64, temp, tempI32, tempI64, typed,
} from '../../ir.js'
import { censusMaybeUndefined, censusMaybeUndefinedKind, valTypeOf } from '../../kind.js'
import { VAL } from '../../reps.js'
import {
  REP_EDGE_BOX, representationComputedExprAction, representationProgramHasBigint,
} from '../representation-plan.js'
import { emit } from './dispatch.js'


// Compound-assign arithmetic op → i64 op suffix. Mirrors the binary '+'/'-'/'*'/
// '/'/'%' BIGINT arms' own wasm ops exactly — no shared table exists for these
// elsewhere; the i64 suffixes differ from the f64/i32 ones only in '/' and '%'
// needing the signed variant (div_s/rem_s).
export const I64_ARITH_OP = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div_s', '%': 'rem_s' }

// Ring 0.3 (re-landed after the dispatch rework dropped the uncommitted original):
// JS makes BigInt⊕Number arithmetic a TypeError. Enforce it exactly where the mix
// is PROVABLE from source — one side proven BIGINT, the other a NUMERIC LITERAL —
// and stay permissive otherwise: kernel carriers read NUMBER as a kind-DEFAULT
// (not a proof), so rejecting proven-BIGINT × default-NUMBER breaks sound kernels.
// A ZERO literal is exempt from the proof: `0n`'s i64 carrier is bit-identical
// to the number 0.0, so under self-compile `[, 0n]` degrades to `[, 0]` and typeof
// cannot tell them apart — treating literal 0 as proven-number falsely rejects
// `0n | 5n` in-kernel. Cost: a literal-0 mix (`0 | 5n`) is accepted (permissive,
// per the policy above) instead of throwing.
export const numLiteralNode = (n) =>
  (typeof n === 'number' && n !== 0) ||
  (Array.isArray(n) && n[0] == null && typeof n[1] === 'number' && n[1] !== 0)
export function bigintMixReject(op, a, b) {
  if (b === undefined) return
  // mayBeUndefined join (Slice 3, .work/archive/todo.md §deletion-sweep
  // §4 — the "NEWLY added to that list" gap): a BIGINT claim whose only proof
  // is a maybeUndefined-flagged dict/Map census read (arm 1/2, censusMaybeUndefined's
  // direct node shapes) or a bare name that copies one through (arm 3, the REP
  // fallback) is NOT a provable BIGINT for THIS compile-time TypeError check —
  // the operand could be real `undefined` at runtime, and ToNumeric(undefined)
  // is the Number NaN, not a BigInt, so real JS does NOT throw when the other
  // side is a genuine number (only bigIntOperand's runtime UNDEF_NAN guard,
  // needs to actually decide the throw at the point the real
  // type resolves). Treating this operand as unproven here — same direction
  // as every other censusMaybeUndefined consumer in this file — falls through
  // to the permissive default instead of wrongly rejecting a mix that's sound
  // in real JS whenever the operand turns out to be undefined.
  const aBig = valTypeOf(a) === VAL.BIGINT && !censusMaybeUndefined(a)
  const bBig = valTypeOf(b) === VAL.BIGINT && !censusMaybeUndefined(b)
  if (aBig === bBig) return
  if (numLiteralNode(aBig ? b : a))
    err(`Cannot mix BigInt and other types in \`${op}\` (TypeError in JS) — convert explicitly with BigInt() or Number()`)
}

// §14 point 4 (audit #10, .work/archive/todo.md §deletion-sweep §14):
// JOINT runtime-domain dispatch for binary arithmetic/bitwise ops, superseding
// the old per-op OR-gate (`valTypeOf(a)===BIGINT||valTypeOf(b)===BIGINT`, live
// at every op below through 38dd0dca/f1c1256b) and Slice 7's `+`-only AND-gate
// (`bothBigIntOperands`, removed here). Both were OPERAND-LOCAL guards — each
// decided ONE operand's fate from a static claim alone, so neither could
// distinguish "both operands genuinely absent" (JS: NaN, no throw —
// ToNumeric(undefined) is a Number on both sides) from "one operand absent,
// the other a real BigInt" (JS: TypeError) from "a proven BigInt paired with
// a real, non-BigInt dynamic value" (JS: TypeError, f1c1256b's own pinned
// KNOWN-FAIL) — three DIFFERENT runtime outcomes that collapse to the
// identical static shape (bigintMixReject's own "operand-local guards are
// architecturally insufficient" citation). Fixed: evaluate each operand
// EXACTLY ONCE (ES2024 13.15.3 steps 1-4 — GetValue happens before
// ToNumeric), classify EACH operand's REAL runtime domain, then dispatch on
// the JOINT result: both Number → the plain numeric op; both BigInt → the
// existing i64 op; mixed → TypeError (13.15.3 step 6 / 13.2.* "Type(lnum) is
// not Type(rnum)").
//
// bigIntDomain(node) — the STATIC evidence available for one operand:
//   'bigint' — valTypeOf(node) === VAL.BIGINT: a PROVEN claim, never
//              maybeUndefined (censusMaybeUndefinedKind never feeds `val` —
//              the permanent invariant §14's Slice-4 revert restored).
//              Always a real BigInt at runtime — no runtime check needed.
//   'number' — a plain numeric LITERAL (bigintMixReject's own numLiteralNode)
//              ONLY — always a real Number, no runtime check needed.
//              Deliberately NOT `valTypeOf(node) === VAL.NUMBER` in general:
//              that claim can be a kind-DEFAULT, not a proof (bigintMixReject's
//              own doc comment — "kernel carriers read NUMBER as a kind-
//              DEFAULT" — the SAME reason it only ever rejects a LITERAL
//              mismatch, never a general NUMBER-claimed expression). Confirmed
//              live, not assumed: layout.js's `i64Hex` (part of the self-compile
//              graph) and a self-compiled-build-only inlined-local shape both
//              mix a `valTypeOf===NUMBER`-optimistic-default operand with a
//              real BigInt LITERAL/expression on purpose — treating that
//              NUMBER claim as throw-worthy broke the self-compiled kernel
//              build outright (caught by the gate, not assumed safe).
//   'census' — censusMaybeUndefinedKind(node) === VAL.BIGINT: the container
//              proves its value is BIGINT whenever present, but PRESENCE
//              itself is runtime-only — needs isUndef: present → BigInt,
//              absent → Number (ToNumeric(undefined) is the Number NaN,
//              never a BigInt — ES2024 13.5.6/7.1.3).
//   null     — no static evidence either way, but ELIGIBLE for the runtime
//              magnitude heuristic (below) — a NEVER-REASSIGNED parameter of
//              the CURRENT function, AND that function is itself a WASM
//              EXPORT — crossing the JS↔wasm boundary directly from the host
//              caller (f1c1256b's own named shape, `export let f = (v, w) =>
//              { let x = BigInt(v); return x - w }`).
//   'skip'   — no static evidence AND not safe to runtime-probe — every other
//              unresolved shape (a reassigned local, a non-param expression,
//              or a param of a NON-exported internal function). See the
//              heuristic's own scoping note below for why both restrictions
//              (never-reassigned AND exported-function-only) are required.
function bigIntDomain(node) {
  const vt = valTypeOf(node)
  if (vt === VAL.BIGINT) return 'bigint'
  if (numLiteralNode(node)) return 'number'
  if (censusMaybeUndefinedKind(node) === VAL.BIGINT) return 'census'
  // The runtime magnitude heuristic (`typeof x === 'bigint'`'s own subnormal-
  // abs check, reused as isBigIntCarrierBits below) is ONLY reliable for a
  // SMALL-magnitude value — a genuinely LARGE or negative BigInt's raw bits
  // do NOT read as subnormal, so applying it to an arbitrary internally-
  // computed value produces FALSE positives (a real large bigint misread as
  // "not bigint", wrongly throwing a TypeError on otherwise-correct code).
  // Confirmed live, not assumed — TWO separate self-compile regressions, both
  // caught by the gate, neither a hypothetical:
  //  (1) watr's own self-compiled i64 LEB128 encoder (node_modules/watr/src/
  //      encode.js `i64()` — `n` REASSIGNED across a conditional diamond via
  //      `BigInt(n)`/`i64.parse(n)`, later `n & 0x7Fn`, where `n` can
  //      genuinely be any 64-bit magnitude) — closed by the never-reassigned
  //      restriction below.
  //  (2) layout.js's `i64Hex` (`bits => ... (bits >> 32n) & 0xFFFFFFFFn ...`)
  //      — `bits` is a NEVER-reassigned param, but `i64Hex` is an ordinary,
  //      NON-EXPORTED internal helper: its argument is computed entirely
  //      WITHIN the compiled program (arbitrary magnitude, no host-boundary
  //      assurance at all) — unlike a genuine WASM EXPORT's own param, whose
  //      representation interop.js's marshalling actually constrains. Closed
  //      by requiring the CURRENT function itself be a WASM export.
  // Every other unresolved shape stays 'skip' — `bigIntDomainsCanMix` treats
  // it as NO evidence at all, falling through to whatever the PRE-EXISTING
  // (pre-§14-point-4) code path already did — unaffected.
  if (ctx.func.exported && typeof node === 'string' && ctx.func.current?.params?.some(p => p.name === node) &&
      !(ctx.func.body && isReassigned(ctx.func.body, node))) return null
  return 'skip'
}

// Runtime "is this f64 bit pattern a BigInt carrier" heuristic — mirrors
// TYPEOF.bigint's own arm verbatim (finite, nonzero, subnormal magnitude),
// the SAME documented, permanent divergence that arm already accepts (a
// genuinely tiny subnormal-magnitude real Number misclassifies as bigint) —
// not a new heuristic, reused at a second call site (not factored into a
// shared helper: TYPEOF.bigint's own local.tee shape is a live, pinned WAT
// structural site — duplicating these 3 lines carries zero regression risk
// there; sharing would). `get` must already be a side-effect-free
// `local.get` — the caller has already materialized the operand into a temp.
const isBigIntCarrierBits = (get) => ['i32.and',
  ['f64.eq', get, get],
  ['i32.and',
    ['f64.ne', get, ['f64.const', 0]],
    ['f64.lt', ['f64.abs', get], ['f64.const', 2.2250738585072014e-308]]]]

// Does this binary node need the joint runtime dispatch, or can it keep its
// existing fast path / stay on the fully generic numeric path untouched
// (both required structural pins — proven-single-domain sites, byte-
// identical)? `allowUnresolved` is false for `+`: a fully unresolved operand
// there could ALSO be a runtime STRING, which `+` must keep routing through
// its own STRING-coercion dispatch (above this check in the '+' table entry)
// — not this BigInt-only one. Every other op ToNumeric()s unconditionally
// (no STRING branch exists for them), so a `null` domain is a safe
// runtime-heuristic target.
//
// ADR-0001 consequence #2 (.work/adr-0001-bigint-representation.md): plan-driven
// gating — a program that can never produce a BigInt value anywhere makes EVERY
// `bigIntDomain(node)` call below resolve to 'number'/null/'skip' (never
// 'bigint'/'census', both of which require an actual VAL.BIGINT-kinded node or a
// dict/Map census proving one), so the two `!== 'bigint' && !== 'census'` checks
// two lines down would ALWAYS force `false` anyway — this is a pure compile-time-
// cost skip, not a behavior change (kernel-parity's byte-identity gate is the
// proof). `representationProgramHasBigint`, not `ctx.features.bigint`: the latter
// is prep()'s narrower "literal or bare `BigInt(x)` call" scan (ir.js's own
// inlineToNum-only carrier-heuristic gate) and misses `new BigInt64Array`/
// `BigUint64Array`, `DataView#getBigInt64`/`getBigUint64`, and `BigInt.asIntN`/
// `asUintN` — every one of which kind-traits.js's calleeValType/typedCtorElemValType
// resolves straight to VAL.BIGINT with no literal or bare `BigInt(` call in sight
// (test/session-reentrancy.js:326 `new BigInt64Array(1); return a[0]` is exactly
// this shape, live and tested). `representationProgramHasBigint` reads
// programFacts.hasBigint (program-facts.js's observeNodeFacts, folded into the
// existing universal per-node walk — "costs no second AST traversal" by its own
// doc comment), which DOES cover all of those origins — the same comprehensive
// flag RepresentationPlan itself already trusts for this exact class of gate
// (mintRepresentationPlan's own three call sites, representation-plan.js).
export function bigIntDomainsCanMix(a, b, allowUnresolved) {
  if (!representationProgramHasBigint(ctx)) return false
  const domA = bigIntDomain(a), domB = bigIntDomain(b)
  // 'skip' (bigIntDomain's own doc comment): never eligible for the runtime
  // heuristic — falls through to whatever the pre-existing code path already
  // did for this operand, unaffected by this whole mechanism.
  if (domA === 'skip' || domB === 'skip') return false
  if (!allowUnresolved && (domA == null || domB == null)) return false
  if (domA !== 'bigint' && domA !== 'census' && domB !== 'bigint' && domB !== 'census') return false
  return !(domA === 'bigint' && domB === 'bigint')   // both proven-same → existing fast path, byte-identical
}

// The joint dispatch itself. `i64Compute(i64A, i64B)` builds the untyped i64
// IR for the BigInt-domain result (mirrors each op's existing bigIntOperand-
// fed expression); `numCompute(f64A, f64B)` builds the f64-typed IR for the
// Number-domain result (mirrors each op's existing generic-numeric
// expression). Both receive the operand ALREADY evaluated into a temp local
// (`local.get`) — `emit(a)`/`emit(b)` run exactly once each, here.

// Plan query for census-shaped unary/joint results. REJECT preserves the raw
// carrier; BOX materializes only the runtime BigInt branch.
export const computedBoxOf = (self) => self != null && representationComputedExprAction(ctx, self) === REP_EDGE_BOX

// `box` (funded-deletion item 4, .work/archive/todo.md WALL 2026-08-22): true when
// RepresentationPlan proved the OUTER node's target BOXED_BIGINT — only ever
// passed true when `domA`/`domB` are BOTH 'census' (representation-plan.js's
// census admission mirrors kind.js censusBigintResultShape's joint shape
// exactly: both operands independently census-BIGINT), so `definite` below
// is always null whenever `box` is true — the runtime-forked `if` branch
// (never the `definite` shortcut) is the only place boxing can apply. Kept
// as an explicit `definite == null` guard anyway rather than trusted
// implicitly, so a future caller with a looser admission fails closed
// (falls back to the untouched raw carrier) instead of silently boxing a
// value some OTHER, unaudited domain combination produces.
export function bigIntJointDispatch(a, b, i64Compute, numCompute, box) {
  const domA = bigIntDomain(a), domB = bigIntDomain(b)
  const ta = temp('bigJ'), tb = temp('bigJ')
  const getA = ['local.get', `$${ta}`], getB = ['local.get', `$${tb}`]
  const flagIR = (dom, get) => dom === 'bigint' ? ['i32.const', 1]
    : dom === 'number' ? ['i32.const', 0]
    : dom === 'census' ? ['i32.eqz', isUndef(get)]
    : isBigIntCarrierBits(get)
  const needFlag = (dom) => dom !== 'bigint' && dom !== 'number'
  const fta = needFlag(domA) ? tempI32('bigJf') : null
  const ftb = needFlag(domB) ? tempI32('bigJf') : null
  const flagA = fta ? ['local.get', `$${fta}`] : flagIR(domA, getA)
  const flagB = ftb ? ['local.get', `$${ftb}`] : flagIR(domB, getB)
  ctx.runtime.throws = true
  const throwIR = typed(['block', ['result', 'f64'],
    ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['f64.const', ERR.BIGINT_UNDEF_MIX]]],
    ['throw', '$__jz_err', ['f64.const', ERR.BIGINT_UNDEF_MIX]]], 'f64')
  // Per-operand CARRIER_BOX unbox, scoped to EXACTLY the 'census' domain
  // (a dict/Map value census-classified BIGINT — the container's own live
  // carrier for a real BigInt is a boxed PTR.BIGINT pointer under
  // CARRIER_BOX, coerceArg's own §29 box-on-write guarantee). The 'bigint'
  // domain (a statically PROVEN BigInt expression) and the null-domain
  // magnitude heuristic (a raw exported-param carrier) are never container-
  // sourced — `asI64` stays correct, unchanged, for both. Reached only when
  // flagA===flagB picked the BigInt arm, so a 'census' operand here is
  // provably present (not the UNDEF_NAN sentinel) — safe to dereference.
  const i64Operand = (dom, get) => dom === 'census' ? maybeUnboxBigInt(get) : asI64(typed(get, 'f64'))
  const rawBigIR = i64Compute(i64Operand(domA, getA), i64Operand(domB, getB))
  // Number-domain operand normalization: a `census` operand only ever reaches
  // numCompute when its OWN flag proved it undef (the flagA===flagB join
  // above), so its TRUE ToNumeric value is the Number NaN (ES2024 13.5.6/
  // 7.1.3) — never its raw UNDEF_NAN carrier bits passed through unexamined.
  // WASM does NOT guarantee arithmetic ops canonicalize a NaN operand's
  // payload (confirmed live: `f64.add` of two identical UNDEF_NAN bit
  // patterns returned that SAME tagged payload verbatim, not a generic NaN —
  // decoding wrong downstream, since the tagged bits collide with the actual
  // UNDEF_NAN sentinel other consumers compare against). Explicit select
  // substitutes literal NaN before the op runs, matching `coerceNullishToNum`'s
  // own ES semantics (reused conceptually, not the function itself — this
  // already has the value in a temp and the undef flag computed, no second
  // node-level census re-check needed).
  const numOperand = (dom, get) => dom === 'census' ? typed(['select', ['f64.const', 'nan'], get, isUndef(get)], 'f64') : typed(get, 'f64')
  const numResult = numCompute(numOperand(domA, getA), numOperand(domB, getB))
  // A DEFINITE side (no runtime flag) needn't be re-checked once flagA===flagB
  // holds — the equal flag already tells us which domain BOTH sides share.
  const definite = domA === 'bigint' || domA === 'number' ? domA : domB === 'bigint' || domB === 'number' ? domB : null
  // Boxing is safe here even though `bothBranch`'s runtime-forked `if` is
  // control flow, not a `select` — unlike bigIntUnary's arm, boxBigInt's own
  // $__alloc call is gated by THIS if (only the taken branch's code runs), so
  // no wasted-allocation hazard exists at this level.
  const bigResult = box && definite == null ? boxBigInt(rawBigIR) : fromI64(rawBigIR)
  const bothBranch = definite ? (definite === 'bigint' ? bigResult : numResult)
    : typed(['if', ['result', 'f64'], flagA, ['then', bigResult], ['else', numResult]], 'f64')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${ta}`, asF64(emit(a))],
    ['local.set', `$${tb}`, asF64(emit(b))],
    ...(fta ? [['local.set', `$${fta}`, flagIR(domA, getA)]] : []),
    ...(ftb ? [['local.set', `$${ftb}`, flagIR(domB, getB)]] : []),
    typed(['if', ['result', 'f64'], ['i32.eq', flagA, flagB], ['then', bothBranch], ['else', throwIR]], 'f64')], 'f64')
}

// The runtime twin of bigintMixReject's compile-time literal proof.
// A BIGINT-census `node` whose exact kind comes SOLELY from censusMaybeUndefined's
// soundness carve-out (a dict/Map absent-key read, e.g. `m.get('missing')`) may hold
// the UNDEF_NAN sentinel at runtime, not a real bigint payload — plain `asI64(v)`
// reinterprets those bits as an i64 and fabricates a garbage bigint (`m.get('missing')
// + 1n` returned 9221120245631025153n instead of throwing). Real JS (ES2024 13.15.3
// ApplyStringOrNumericBinaryOperator): ToNumeric(undefined) is the NUMBER NaN, not a
// BigInt, so step 6 ("Type(lnum) is not Type(rnum)") throws whenever the OTHER
// genuinely-two-operand side is a real BigInt — the exact TypeError bigintMixReject's
// own literal check proves at compile time for a LITERAL operand; this is the runtime
// check for a maybeUndefined operand, whose type only resolves at runtime. Called for
// EVERY operand at a bigintMixReject call site (the "one decision" chokepoint, same
// altitude as toNumF64's Slice-1 join) — a non-maybeUndefined node degrades to a bare
// `asI64(v)`, byte-identical to before (present-key/local BIGINT structural pin).
// KNOWN NARROWER GAP (documented, not closed here): true ES semantics only throws when
// the two operands' RUNTIME types actually differ — two maybeUndefined BIGINT operands
// that are BOTH genuinely absent at once (`m.get('a') + m.get('b')`, both keys missing)
// are Number NaN + Number NaN = NaN, no throw. This independently guards each operand,
// so that double-absent case throws instead of yielding NaN — strictly better than the
// prior silent-garbage-bigint answer (moves an unsound VALUE to a sound-but-wider
// THROW, never a wrong number), and matches this fix's explicit brief ("the runtime
// semantics for the absent case must be the thrown TypeError"). Not applied to unary
// negation/'~': those single-operand ops ToNumeric their one value and never
// compare against a second operand's type, so an absent key there really does decay
// to NaN (no throw) — a different, narrower semantics, closed separately below by
// bigIntUnary. Postfix/prefix increment/decrement need no
// analogous fix: `n++`/`n--` on a member target lowers to the '+1'/'-1' op below,
// gated on `valTypeOf(a[1]) === VAL.BIGINT` — for the bracket-string-literal-key
// shape (`d['missing']++`) that's the SAME VT['[]'] null-return disambiguation
// bigIntOperand's own comment above documents, so it never takes the raw-i64
// member-op path at all (falls to the generic `n + 1`/`n - 1` spelled-out form,
// already sound); for a dynamic-key member (`d[k]++`) — verified live, not
// assumed — the same is true, confirmed byte-for-byte against the JS oracle.
export function bigIntOperand(node) {
  const v = emit(node)
  // censusMaybeUndefinedKind, not valTypeOf(node) === VAL.BIGINT: for a bracket
  // read with a non-canonical-numeric string-literal key (`d['missing']`),
  // VT['[]'] itself resolves to `null` (its own array-vs-property disambiguation,
  // kind.js ~443-448) before ever reaching the dict-value census fallback — so
  // valTypeOf(node) is NOT a reliable "is this dict/Map read's census kind
  // bigint" proxy the way it is for a plain local. censusMaybeUndefinedKind
  // queries the census directly (see its own doc comment in kind.js).
  if (censusMaybeUndefinedKind(node) !== VAL.BIGINT) return readI64(node, v)
  ctx.runtime.throws = true
  const t = temp('bigU')
  // Past the throw check, `$t` is provably PRESENT (the UNDEF_NAN branch
  // above always throws) — a real dict/Map census BigInt. Under CARRIER_BOX
  // the container's own live carrier for a BigInt value is a boxed
  // PTR.BIGINT pointer (coerceArg boxes every BigInt argument crossing into
  // `.set()`/`[]=` unconditionally, §29), so a naive `i64.reinterpret_f64`
  // exposes the box's own tag/offset bits instead of the payload.
  // `maybeUnboxBigInt` (CONSERVATIVE PAIRING, §16/§24/§29) dereferences a
  // genuine box and passes anything else through unchanged; off-flag this
  // is byte-identical to the prior plain reinterpret.
  const bits = maybeUnboxBigInt(['local.get', `$${t}`])
  return typed(['block', ['result', 'i64'],
    ['local.set', `$${t}`, asF64(v)],
    ['if', isUndef(['local.get', `$${t}`]),
      ['then',
        ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['f64.const', ERR.BIGINT_UNDEF_MIX]]],
        ['throw', '$__jz_err', ['f64.const', ERR.BIGINT_UNDEF_MIX]]]],
    bits], 'i64')
}

// Unary twin of bigIntOperand above — same runtime
// censusMaybeUndefinedKind + UNDEF_NAN guard on a maybeUndefined-BIGINT
// operand, but RESOLVES TO A VALUE instead of throwing. ES2024 13.5.6
// UnaryMinus / 13.5.9 BitwiseNOT: both ToNumeric a SINGLE operand — undefined's
// ToNumeric is the Number NaN (step: ToPrimitive(undefined)=undefined, not
// BigInt → ToNumber(undefined)=NaN) — with no second operand to type-mismatch
// against, so there is no step 6 "Type(lnum) is not Type(rnum)" comparison to
// throw on; the real value is just NaN (unary '-') or ToInt32(NaN)'s bitwise
// complement, -1 (unary '~') — a genuine NUMBER, never a BigInt. Both call
// sites (emitNeg, '~') already carry every emitted BIGINT value in an f64-
// typed carrier via `fromI64` (BigInt has no NaN-boxed self-description of
// its own — see fromI64/asI64 — so the caller's static VAL.BIGINT belief is
// what selects this whole branch to begin with), so substituting a genuine
// f64 NUMBER NaN/-1.0 bit pattern into that SAME f64 slot is representation-
// compatible with every existing consumer — no dual-type ABI problem, unlike
// a hypothetical fix at the bigintMixReject binary sites (that KNOWN NARROWER
// GAP stays out of scope, this is a different, simpler case). `mkI64` builds
// the genuine-BIGINT i64 IR from the operand's already-read bits (an IR
// array, not a full node — reused verbatim in both branches so the two paths
// can only ever differ in the runtime i32 select, never in what i64 op they
// compute); `undefF64` is the literal f64 IR substituted when the operand IS
// the sentinel. Non-maybeUndefined operand (present-key/local BIGINT, the
// overwhelming common case) takes `mkI64` directly through the untouched
// `fromI64` path — byte-identical to before (same structural pin as
// bigIntOperand's own non-maybeUndefined fast path).
// `box` (funded-deletion item 4, .work/archive/todo.md WALL 2026-08-22): true when
// RepresentationPlan proved the OUTER node's target BOXED_BIGINT (a real
// present-key BigInt result crossing a tagged consumer — an export return,
// chiefly). undefined/false is the untouched, byte-identical default: the
// "real bigint" branch stays the raw f64.reinterpret_i64 carrier, unboxed —
// correct for every INTERNAL (non-covered) consumer, which already knows
// how to read that carrier via readI64/asI64. When boxing, the `select` form
// is UNSOUND to keep: select eagerly evaluates BOTH operands (no lazy
// branching), so boxBigInt's own $__alloc call would run on every call —
// even the UNDEF_NAN (absent) case, allocating and immediately discarding a
// box on every miss (the exact "double-eval hazard"/wasted-alloc class the
// '?:' handler's own doc comment already flags for this identical select-
// vs-if tradeoff) — so boxing switches to the `if`/`else` control-flow form
// instead, matching that established discipline.
export function bigIntUnary(node, mkI64, undefF64, box) {
  if (censusMaybeUndefinedKind(node) !== VAL.BIGINT) return fromI64(mkI64(readI64(node, emit(node))))
  const t = temp('unaryBigU')
  // Same CARRIER_BOX gap as bigIntOperand's own throw-check branch above,
  // narrower consequence (a wrong VALUE, not a wrong-address dereference —
  // this arm is discarded via `select`/`if` whenever `$t` really is
  // UNDEF_NAN, so running `maybeUnboxBigInt` unconditionally here is sound:
  // UNDEF_NAN's own ATOM tag never matches PTR.BIGINT, so it falls to the
  // same plain reinterpret this arm always ran, and its result is discarded
  // regardless). Off-flag: byte-identical to the prior plain reinterpret.
  const bits = maybeUnboxBigInt(['local.get', `$${t}`])
  const setup = ['local.set', `$${t}`, asF64(emit(node))]
  const cond = isUndef(['local.get', `$${t}`])
  if (!box)
    return typed(['block', ['result', 'f64'], setup,
      ['select', undefF64, ['f64.reinterpret_i64', mkI64(bits)], cond]], 'f64')
  return typed(['block', ['result', 'f64'], setup,
    ['if', ['result', 'f64'], cond,
      ['then', undefF64],
      ['else', boxBigInt(mkI64(bits))]]], 'f64')
}

// BigInt `<<`/`>>` — ES2024 13.2.9/13.2.10 BigInt::leftShift/rightShift: a
// NEGATIVE shift amount flips DIRECTION (`x << -3n` === `x >> 3n`, exactly —
// not "shift by a huge wrapped count"). Found live sweeping the general
// valTypeOfWithLocals fix (38dd0dca follow-up): WASM's `i64.shl`/`i64.shr_s`
// both take the shift count mod 64 unconditionally (two's-complement -3 → 61),
// with no such sign awareness — `av << -3n` computed a 61-bit wrong-direction
// shift instead of `av >> 3n`. Pre-existing (the same raw `i64.${fn}` dispatch
// this fixes was already there before this session), just unreachable through
// any correctly-DECODED export until the general fix above made `<<`/`>>` on
// proven-BigInt locals/params cross the boundary as a real BigInt at all —
// confirmed via direct JS-oracle diff, not assumed. `bv` is captured into a
// temp FIRST (not inlined twice) — it may be `bigIntOperand`'s own maybeUndefined
// block form, which must evaluate exactly once. `av` is embedded once, same
// single-evaluation discipline every other binary BigInt op here already has.
export function bigIntShiftIR(op, av, bv) {
  const t = tempI64('bshiftN')
  const sameOp = op === '<<' ? 'shl' : 'shr_s'
  const flipOp = op === '<<' ? 'shr_s' : 'shl'
  return ['block', ['result', 'i64'],
    ['local.set', `$${t}`, bv],
    ['if', ['result', 'i64'], ['i64.lt_s', ['local.get', `$${t}`], ['i64.const', 0]],
      ['then', [`i64.${flipOp}`, av, ['i64.sub', ['i64.const', 0], ['local.get', `$${t}`]]]],
      ['else', [`i64.${sameOp}`, av, ['local.get', `$${t}`]]]]]
}

// Member `.`/`[]` increment/decrement's postfix OLD-value recovery. Prepare
// (index.js '++'/'--') has no dedicated increment NODE for a member target
// the way bare names do (the '++'/'--' table entries below are name-based,
// via readVar/writeVar) — the write itself is the DEDICATED '+1'/'-1' unary
// op handled by its own table entry further down (unambiguous: no parser or
// other pass ever produces that op, so it needs no mix-check bypass at all).
// Postfix wraps that write with the SAME plain-literal ∓1 recovery the
// bare-name path uses (`['-', ['=', n, ['+1', n]], [,1]]` etc.) — matched here
// exactly like the bare-name isPostfix bypass just above: only prepare's own
// transform nests an assignment in this exact position, so treating it as the
// compiler's own correction constant (not a user-facing mix) is sound by the
// same permissive-by-construction argument as the bare-name case.
export function bigintMemberAssignTarget(a) {
  return Array.isArray(a) && a[0] === '=' && Array.isArray(a[1]) &&
    (a[1][0] === '.' || a[1][0] === '[]') && valTypeOf(a[1]) === VAL.BIGINT ? a : null
}
