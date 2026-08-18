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
import { lookup, idx, cur } from 'subscript/parse'
import { fromRadixDigits, toDecimalString, truncateLimbs } from './bignum.js'

// Strip a leading `#!` shebang line before subscript sees it. subscript registers the
// shebang via `parse.comment['#!']='\n'` (feature/shebang.js) on a literal-seeded object,
// then enumerates it — a cross-module dynamic-extension of a fixed-schema object that the
// self-compile kernel doesn't surface (the added key is stored but unenumerated). An explicit
// strip is the conventional parser responsibility anyway (Node, V8 do the same), is
// host/kernel-identical, and is independent of object-model internals.
const parse = (src) => {
  if (typeof src === 'string' && src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) {
    const nl = src.indexOf('\n')
    src = nl < 0 ? '' : src.slice(nl)
  }
  return jessieParse(src)
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

// BigInt literals parse to `[, BigInt(str)]` (subscript/feature/number.js) — a
// REAL host BigInt payload, reliably distinguishable from a number literal via
// `typeof` — but only NATIVELY. Once this parser is itself self-compile-compiled
// (front.js's kernel graph) and runs INSIDE the kernel to parse a NEW source
// string, `BigInt(str)` returns jz's own i64-bits-as-f64 CARRIER value, which
// for small magnitudes is bit-identical to a genuine subnormal float — the
// very AST node built in-kernel has already lost the distinction the moment
// it's constructed, and no LATER `typeof` check (kind.js, prepare, pre-eval,
// emit) can recover it (kernel-compiled `() => 5e-324` would export `1n` if
// this relied on a runtime `typeof` check — see .work/todo.md). The only
// reliable signal is STRUCTURAL: did
// the SOURCE TEXT end in `n`? That's a character-code comparison, never a
// value-type inspection — sound natively AND in-kernel alike.
//
// Wrap the digit-lookup handlers (0-9) the same way number.js installed them
// and re-derive the literal as a TAGGED `['bigint', decimalStr]` node
// whenever the consumed span ends in `n` — same self-describing-marker shape
// as the `nan`/`bool` overrides above, same fix for the same collapse class.
// `decimalStr` is the UNSIGNED-64 decimal (`BigInt.asUintN(64,·)` semantics —
// the carrier's own width ceiling; every consumer already expects this exact
// form, see compile/emit.js `op === 'bigint'` / `bigintUnsignedBound`).
// Radix-prefixed literals (0x/0b/0o, enabled by justin.js's `parse.number`)
// are converted via bignum.js's limb arithmetic — plain number-array math, no
// BigInt anywhere in the conversion, so it self-compiles identically.
// Original digit-lookup handlers (number.js), captured ONCE into a flat array
// indexed by charCode-48 — NOT via a per-iteration closure over `lookup[c]`
// (a `for (let c=…)` loop whose body installs a closure capturing that
// iteration's own binding is exactly the shape self-compile closure-in-loop bugs
// hit; looking the original handler up by INDEX at call time, from ONE shared
// wrapper function installed at every slot, has no per-iteration binding to
// get wrong). digit '0'..'9' -> index 0..9.
const ORIG_NUM = []
for (let c = 48; c <= 57; c++) ORIG_NUM.push(lookup[c])
const N_CHAR = 110  // 'n'
const digitWrapper = (a, b) => {
  const origNum = ORIG_NUM[cur.charCodeAt(idx) - 48]
  if (a) return origNum(a, b)
  const start = idx
  const r = origNum(a, b)
  if (r === undefined || cur.charCodeAt(idx - 1) !== N_CHAR) return r
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
