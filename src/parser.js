// Parser - extends subscript/justin with proper number handling
// Following piezo pattern: https://github.com/dy/piezo/blob/main/src/parse.js

// CRITICAL: Import justin FIRST - it must initialize lookup[PERIOD] before we read it
import { parse } from 'subscript/justin'

// Import loop keywords extension
import './feature/loop.js'

// Now get the low-level parse utilities (shared lookup object)
import { lookup, skip, next, cur, idx, err } from 'subscript/parse'

// Node type markers
export const INT = 'int', FLOAT = 'flt'

// Char codes
const PERIOD = 46, _0 = 48, _1 = 49, _8 = 56, _9 = 57
const _A = 65, _B = 66, _F = 70, _O = 79, _X = 88
const _a = 97, _b = 98, _f = 102, _o = 111, _x = 120
const _E = 69, _e = 101

// Number detection
const isNum = c => c >= _0 && c <= _9
const isHex = c => isNum(c) || (c >= _a && c <= _f) || (c >= _A && c <= _F)

// Number parser - handles 0x, 0o, 0b, floats, exponents
function num(a) {
  if (a) err('Unexpected number')

  let n, t = INT

  // Parse prefix (0x, 0o, 0b or regular) - case insensitive
  n = next(c => c === _0 || c === _x || c === _X || c === _o || c === _O || c === _b || c === _B)

  if (n === '0x' || n === '0X') {
    // Hex: 0xFF or 0XFF
    n = parseInt(next(isHex), 16)
  } else if (n === '0o' || n === '0O') {
    // Octal: 0o77 or 0O77
    n = parseInt(next(c => c >= _0 && c <= _8), 8)
  } else if (n === '0b' || n === '0B') {
    // Binary: 0b1010 or 0B1010
    n = parseInt(next(c => c === _0 || c === _1), 2)
  } else {
    // Decimal: 123, 1.5, 1e3, 1.5e-3
    n += next(isNum)
    // Decimal point: 1.5
    if (cur.charCodeAt(idx) === PERIOD && isNum(cur.charCodeAt(idx + 1))) {
      n += skip() + next(isNum)
      t = FLOAT
    }
    // Exponent: 1e3, 1.5e-3
    if (cur.charCodeAt(idx) === _E || cur.charCodeAt(idx) === _e) {
      n += skip(2) + next(isNum)
    }
    n = +n
    if (n !== n) err(`Bad number ${n}`)
  }

  return [t, n]
}

// Save justin's PERIOD handler for property access (a.b)
// NOTE: justin must be fully imported first for this to work
const justinPeriod = lookup[PERIOD]

// Register .1 as number (leading decimal) - chain to justin if there's a left node
// Must pass all 4 args: (a, prec, curOp, from) - this is how subscript's token handlers work
lookup[PERIOD] = (a, prec, curOp, from) => {
  // If there's a left node (like 'Math'), use justin's handler for property access
  if (a) return justinPeriod(a, prec, curOp, from)
  // Otherwise check if next char is a digit for .1 style numbers
  if (isNum(cur.charCodeAt(idx + 1))) return num()
  // Fall back to justin
  return justinPeriod(a, prec, curOp, from)
}

// Register 0-9 as numbers
for (let i = _0; i <= _9; i++) lookup[i] = num

export { parse }
export default parse
