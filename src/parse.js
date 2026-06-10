/**
 * jz's parser entry — subscript's jessie dialect with one jz-specific override.
 *
 * `NaN` parses to the self-describing `['nan']` marker rather than subscript's
 * default `[, NaN]` value-literal. A raw number-NaN (0x7FF8…) is ambiguous with
 * jz's NaN-boxed value space: as the literal flows through the self-host kernel's
 * parse/marshalling path it decodes back as a boxed value (object), so `() => NaN`
 * would miscompile to `f64.const 0`. The string-tagged marker can't be mistaken
 * for a number, survives intact, and emit() lowers it to the canonical quiet NaN
 * (see compile/emit.js `op === 'nan'`). This mirrors subscript's own reason for
 * encoding `undefined` as `[]` instead of `[, undefined]` (feature/literal.js).
 * Infinity is 0x7FF0 — outside the NaN-box space — so it survives as a plain
 * literal and needs no override.
 */
import { parse as jessieParse, token } from 'subscript/feature/jessie'

// Strip a leading `#!` shebang line before subscript sees it. subscript registers the
// shebang via `parse.comment['#!']='\n'` (feature/shebang.js) on a literal-seeded object,
// then enumerates it — a cross-module dynamic-extension of a fixed-schema object that the
// self-host kernel doesn't surface (the added key is stored but unenumerated). An explicit
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
// the bare number 1/0 as the literal flows through the self-host kernel's
// parse/marshalling path, so `valTypeOf` reads VAL.NUMBER and the value loses its
// VAL.BOOL kind — `typeof true` returns "number", `JSON.stringify(true)` yields "1".
// The marker (op `'bool'`) is type-tagged by op, not by its degradable payload, so
// valTypeOf returns VAL.BOOL unconditionally; emit lowers it to the same 0/1 carrier
// (no perf cost). Same rationale as the `NaN` → `['nan']` override above.
token('true', 200, a => !a && ['bool', 1])
token('false', 200, a => !a && ['bool', 0])

export { parse }
