/**
 * jz's parser entry — subscript's jessie dialect with one jz-specific override.
 *
 * `NaN` parses to the self-describing `['nan']` marker rather than subscript's
 * default `[, NaN]` value-literal. A raw number-NaN (0x7FF8…) is ambiguous with
 * jz's NaN-boxed value space: as the literal flows through the self-compile kernel's
 * parse/marshalling path it decodes back as a boxed value (object), so `() => NaN`
 * would miscompile to `f64.const 0`. The string-tagged marker can't be mistaken
 * for a number, survives intact, and emit() lowers it to the canonical quiet NaN
 * (see compile/emit.js `op === 'nan'`). This mirrors subscript's own reason for
 * encoding `undefined` as `[]` instead of `[, undefined]` (feature/literal.js).
 * Infinity is 0x7FF0 — outside the NaN-box space — so it survives as a plain
 * literal and needs no override.
 */
import { parse as jessieParse, token } from 'subscript/feature/jessie'
import { lookup, idx, cur, skip, err } from 'subscript/parse'
import { fromRadixDigits, toDecimalString, truncateLimbs } from './bignum.js'
import { validateEarlyErrors } from './early-errors.js'

// Strip a leading `#!` shebang line before subscript sees it. subscript registers the
// shebang via `parse.comment['#!']='\n'` (feature/shebang.js) on a literal-seeded object,
// then enumerates it — a cross-module dynamic-extension of a fixed-schema object that the
// self-compile kernel doesn't surface (the added key is stored but unenumerated). An explicit
// strip is the conventional parser responsibility anyway (Node, V8 do the same), is
// host/kernel-identical, and is independent of object-model internals.
// subscript's ASI layer (feature/asi.js) tracks the "no LineTerminator here"
// restricted-production flag (`parse.newline`, consulted by break/continue/
// return/yield/postfix-++/--'s own keyword handlers) by rescanning each
// whitespace run parse.space() just skipped for LF (`\n`) only. ES2026's
// LineTerminator production (§12.4) is LF | CR | LS | PS: a lone CR (`\r`
// U+000D, not part of a CRLF pair) is skipped as ordinary whitespace WITHOUT
// setting parse.newline, so e.g. `break\rLABEL` parses as a labeled break
// instead of ASI-splitting into an unlabeled break followed by a new
// statement (confirmed live — test262 language/statements/break+continue
// line-terminators.js: LF/LS/PS already flip parse.newline correctly, only a
// bare CR is missed; LS/PS reach the right outcome by a different route —
// their codepoint sits above subscript's core whitespace ceiling, so the
// base skip loop halts there and the stalled identifier match falls through
// to the same unlabeled-break result by construction, not via the newline
// flag). Compose one more wrapper on top of asi.js's parse.space — same
// "layer another override onto subscript's shared mutable parser state"
// pattern as the NaN/true/false/BigInt token overrides below — to also flag
// CR. jessieParse (imported above) and subscript/parse.js's own `parse` are
// the same shared singleton object (feature/jessie re-exports it verbatim),
// so no separate import is needed; `idx`/`cur` (imported above) are live
// bindings that already reflect the position parse.space() just advanced to.
// No rest/spread here (`(...args) => … asiSpace(...args)`): jz's own
// self-compile kernel rejects a spread call into a function it proves
// non-variadic ("Spread not supported in calls to non-variadic function"),
// and asi.js's parse.space is exactly that (fixed 2-param `(cc, from)`,
// both immediately overwritten on entry — see its own body — so it is
// ALWAYS called with zero arguments in practice; every real call site in
// this codebase, subscript's own included, calls it as `parse.space()`).
// Zero-arg wrapper matches that actual calling convention exactly.
const asiSpace = jessieParse.space
jessieParse.space = () => {
  const from = idx
  const cc = asiSpace()
  for (let i = from; i < idx; i++) if (cur.charCodeAt(i) === 13) { jessieParse.newline = true; break }
  return cc
}

const parse = (src) => {
  if (typeof src === 'string' && src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) {
    const nl = src.indexOf('\n')
    src = nl < 0 ? '' : src.slice(nl)
  }
  const ast = jessieParse(src)
  validateEarlyErrors(ast, src)
  return ast
}

token('NaN', 200, a => !a && ['nan'])

// `true`/`false` parse to the self-describing `['bool', 1|0]` marker rather than
// subscript's `[, true]`/`[, false]` value-literal. The raw JS boolean degrades to
// the bare number 1/0 as the literal flows through the self-compile kernel's
// parse/marshalling path, so `valTypeOf` reads VAL.NUMBER and the value loses its
// VAL.BOOL kind — `typeof true` returns "number", `JSON.stringify(true)` yields "1".
// The marker (op `'bool'`) is type-tagged by op, not by its degradable payload, so
// valTypeOf returns VAL.BOOL unconditionally; emit lowers it to the same 0/1 carrier
// (no perf cost). Same rationale as the `NaN` → `['nan']` override above.
token('true', 200, a => !a && ['bool', 1])
token('false', 200, a => !a && ['bool', 0])

// BigInt literals re-tag as `['bigint', decimalStr]` — a self-describing marker,
// same shape/reason as the `nan`/`bool` overrides above. A raw `[, BigInt(str)]`
// value node is only distinguishable from a number via `typeof`, which collapses
// in-kernel: the self-compiled parser's `BigInt(str)` is an i64-bits-as-f64
// carrier, bit-identical to a subnormal float for small magnitudes. The only
// sound signal, natively AND in-kernel, is STRUCTURAL: did the source span end
// in `n`? `decimalStr` is the unsigned-64 decimal (`BigInt.asUintN(64,·)`
// semantics — see compile/emit.js `op === 'bigint'`), derived via bignum.js limb
// arithmetic — no BigInt anywhere, so it self-compiles identically.
// Original digit handlers are captured ONCE into a flat array indexed by
// charCode-48 and looked up at call time — a per-iteration closure over
// `lookup[c]` is exactly the closure-in-loop shape self-compile bugs hit.
const ORIG_NUM = []
for (let c = 48; c <= 57; c++) ORIG_NUM.push(lookup[c])
const N_CHAR = 110  // 'n'
const digitWrapper = (a, b) => {
  const origNum = ORIG_NUM[cur.charCodeAt(idx) - 48]
  if (a) return origNum(a, b)
  const start = idx
  const r = origNum(a, b)
  if (r === undefined) return r
  if (cur.charCodeAt(idx - 1) !== N_CHAR) {
    // Suffix not consumed by the handler: either not a bigint literal, or a
    // subscript where bigint parsing is the opt-in feature/bigint.js (jz doesn't
    // import it — this wrapper IS jz's bigint surface). Consume the `n` here.
    if (r[0] !== undefined || cur.charCodeAt(idx) !== N_CHAR) return r
    if ((cur.charCodeAt(start + 1) | 32) !== 120 && /[.eE]/.test(cur.slice(start, idx))) err('Invalid BigInt')
    skip()
  }
  const hasPrefix = cur.charCodeAt(start) === 48
  const prefixLetter = hasPrefix ? (cur.charCodeAt(start + 1) | 32) : 0
  const radix = prefixLetter === 120 ? 16 : prefixLetter === 111 ? 8 : prefixLetter === 98 ? 2 : 10
  const digitsStart = radix === 10 ? start : start + 2
  const digits = cur.slice(digitsStart, idx - 1).replace(/_/g, '')
  const magnitude = truncateLimbs(fromRadixDigits(digits, radix), 64)
  return ['bigint', toDecimalString(magnitude)]
}
for (let c = 48; c <= 57; c++) lookup[c] = digitWrapper

export { parse }
