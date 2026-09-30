/**
 * Unicode classes of ECMAScript source text: the characters of an
 * IdentifierName (§12.7) and WhiteSpace / LineTerminator (§12.2, §12.3).
 * No `\p{…}`: jz compiles its own compiler, whose regular expressions carry no
 * property tables; the name tables are generated (unicode-id.generated.js).
 *
 * @module unicode
 */
import { ID_START, ID_PART } from './unicode-id.generated.js'

// Range boundaries, absolute: a code point is in a set when an odd number of
// its boundaries lie at or below it.
const bounds = (d) => {
  const b = new Int32Array(d.length)
  for (let i = 0, v = 0; i < d.length; i++) b[i] = v += d[i]
  return b
}
const START = bounds(ID_START), PART = bounds(ID_PART)
const within = (b, c) => {
  let lo = 0, hi = b.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (b[m] <= c) lo = m + 1; else hi = m }
  return (lo & 1) === 1
}

/** An ASCII letter, digit, `$` or `_`. */
export const asciiPart = c => c >= 97 ? c <= 122 : c >= 65 ? c <= 90 || c === 95 : c >= 48 ? c <= 57 : c === 36
/** A name's first character: ID_Start, `$` or `_`. */
export const idStart = cp => cp < 128 ? asciiPart(cp) && (cp < 48 || cp > 57) : within(START, cp)
/** A later one: ID_Continue, `$`, `_`, ZWNJ or ZWJ. */
export const idPart = cp => cp < 128 ? asciiPart(cp) : within(START, cp) || within(PART, cp)
/** LF, CR, LS or PS. */
export const lineEnd = c => c === 10 || c === 13 || c === 0x2028 || c === 0x2029
/** WhiteSpace or LineTerminator, what `/\s/` matches: TAB, LF, VT, FF, CR, space, NBSP, ZWNBSP, LS, PS, the other space separators. */
export const isSpace = c => c < 128 ? c === 32 || c >= 9 && c <= 13
  : c === 0xa0 || c === 0xfeff || c === 0x1680 || c >= 0x2000 && c <= 0x200a ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
