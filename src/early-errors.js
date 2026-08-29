import { ASSIGN_OPS, some } from './ast.js'
import { err } from './ctx.js'

/**
 * ECMAScript early errors that a permissive subset parser cannot enforce while
 * recognizing one token at a time. Runs on the raw jessie AST, before jzify.
 * It validates only structural facts retained by that AST; lexical spelling
 * rules (numeric separators, escapes, regexp flags) live beside the scanner in
 * parse.js.
 */

const STRICT_RESERVED = new Set([
  'implements', 'interface', 'package', 'private', 'protected', 'public', 'static',
])
const ALWAYS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
])

const fail = message => err(`Early error: ${message}`)
const isNode = n => Array.isArray(n)
const isSeq = n => isNode(n) && n[0] === ';'
const statements = n => n == null ? [] : isSeq(n) ? n.slice(1).filter(x => x != null) : [n]

const isDigitCode = c => c >= 48 && c <= 57
const isHexCode = c => isDigitCode(c) || (c | 32) >= 97 && (c | 32) <= 102
const isIdentCode = c => isDigitCode(c) || c >= 65 && c <= 90 || c >= 97 && c <= 122 || c === 36 || c === 95 || c > 127
const isWhitespaceCode = c => c <= 32 || c === 0xa0 || c === 0x1680 ||
  c >= 0x2000 && c <= 0x200a || c === 0x2028 || c === 0x2029 || c === 0x202f ||
  c === 0x205f || c === 0x3000 || c === 0xfeff

const lexicalNumber = (src, start, strict) => {
  let i = start, c = src.charCodeAt(i)
  const prefixed = c === 48 && /[xXoObB]/.test(src[i + 1] || '')
  if (prefixed) {
    const p = (src[i + 1] || '').toLowerCase(), digit = p === 'x' ? isHexCode
      : p === 'o' ? x => x >= 48 && x <= 55 : x => x === 48 || x === 49
    i += 2
    const begin = i
    while (i < src.length && (isIdentCode(src.charCodeAt(i)) || src[i] === '_')) i++
    let end = i, bigint = false
    if (src[end - 1] === 'n') { bigint = true; end-- }
    if (end === begin) fail('prefixed numeric literal requires digits')
    for (let k = begin; k < end; k++) {
      const ch = src[k], code = src.charCodeAt(k)
      if (ch === '_') {
        if (k === begin || k === end - 1 || !digit(src.charCodeAt(k - 1)) || !digit(src.charCodeAt(k + 1)))
          fail('numeric separator must occur between digits')
      } else if (!digit(code)) fail(`invalid digit in 0${p} numeric literal`)
    }
    if (i < src.length && (isIdentCode(src.charCodeAt(i)) || src[i] === '\\')) fail('identifier cannot immediately follow a number')
    return i
  }

  const startedWithDot = src[i] === '.'
  let sawDot = false
  if (startedWithDot) { sawDot = true; i++ }
  const integerStart = i
  while (isDigitCode(src.charCodeAt(i)) || src[i] === '_') i++
  const integerEnd = i
  if (!sawDot && src[i] === '.') {
    sawDot = true
    i++
    while (isDigitCode(src.charCodeAt(i)) || src[i] === '_') i++
  }
  if (src[i] === 'e' || src[i] === 'E') {
    i++
    if (src[i] === '+' || src[i] === '-') i++
    const exp = i
    while (isDigitCode(src.charCodeAt(i)) || src[i] === '_') i++
    if (i === exp) fail('numeric exponent requires digits')
  }
  const bigint = src[i] === 'n'
  if (bigint) {
    if (sawDot || /[eE]/.test(src.slice(start, i))) fail('BigInt literal must be an integer')
    i++
  }
  const raw = src.slice(start, i)
  for (let k = 0; k < raw.length; k++) if (raw[k] === '_') {
    if (k === 0 || k === raw.length - 1 || !isDigitCode(raw.charCodeAt(k - 1)) || !isDigitCode(raw.charCodeAt(k + 1)))
      fail('numeric separator must occur between digits')
  }
  const integerRaw = src.slice(integerStart, integerEnd)
  const integer = integerRaw.replace(/_/g, '')
  if (!startedWithDot && integer.length > 1 && integer[0] === '0' && (strict || bigint || integerRaw.includes('_')))
    fail('numeric separator/BigInt cannot follow a leading zero')
  if (i < src.length && (isIdentCode(src.charCodeAt(i)) || src[i] === '\\')) fail('identifier cannot immediately follow a number')
  return i
}

const lexicalQuoted = (src, start, quote, strict) => {
  let i = start + 1
  while (i < src.length) {
    const c = src.charCodeAt(i)
    if (src[i] === quote) return i + 1
    if (c === 10 || c === 13) {
      if (quote === '`') { i++; continue }
      fail('line terminator in string literal')
    }
    if (src[i] !== '\\') { i++; continue }
    i++
    const e = src[i]
    if (e == null) fail('unterminated escape sequence')
    if (e === '\n' || e === '\r') { if (e === '\r' && src[i + 1] === '\n') i++; i++; continue }
    if (strict && quote !== '`' && (e === '8' || e === '9' || e >= '1' && e <= '7' ||
        e === '0' && isDigitCode(src.charCodeAt(i + 1)))) fail('legacy escape is forbidden in strict mode')
    if (e === 'x') {
      if (!isHexCode(src.charCodeAt(i + 1)) || !isHexCode(src.charCodeAt(i + 2))) fail('invalid hexadecimal escape')
      i += 3; continue
    }
    if (e === 'u') {
      if (src[i + 1] === '{') {
        let k = i + 2
        while (isHexCode(src.charCodeAt(k))) k++
        const digits = src.slice(i + 2, k)
        if (!digits || src[k] !== '}' || digits.length > 6 || parseInt(digits, 16) > 0x10ffff) fail('invalid Unicode escape')
        i = k + 1; continue
      }
      for (let k = 1; k <= 4; k++) if (!isHexCode(src.charCodeAt(i + k))) fail('invalid Unicode escape')
      i += 5; continue
    }
    i++
  }
  fail(quote === '`' ? 'unterminated template literal' : 'unterminated string literal')
}

let lexicalTemplateExpr
const lexicalTemplate = (src, start, strict, tagged = false) => {
  let i = start + 1
  while (i < src.length) {
    if (src[i] === '`') return i + 1
    if (src[i] === '\\') {
      const c = src.charCodeAt(i + 1), e = src[i + 1]
      if (c === 10 || c === 13) { i += 2; continue }
      if (!tagged && (e === '8' || e === '9' || e >= '1' && e <= '7' || e === '0' && isDigitCode(src.charCodeAt(i + 2))))
        fail('legacy escape is invalid in an untagged template')
      if (!tagged && e === 'x') {
        if (!isHexCode(src.charCodeAt(i + 2)) || !isHexCode(src.charCodeAt(i + 3))) fail('invalid hexadecimal template escape')
        i += 4; continue
      }
      if (!tagged && e === 'u') {
        if (src[i + 2] === '{') {
          let k = i + 3
          while (isHexCode(src.charCodeAt(k))) k++
          const digits = src.slice(i + 3, k)
          if (!digits || src[k] !== '}' || digits.length > 6 || parseInt(digits, 16) > 0x10ffff)
            fail('invalid Unicode template escape')
          i = k + 1; continue
        }
        for (let k = 2; k <= 5; k++) if (!isHexCode(src.charCodeAt(i + k))) fail('invalid Unicode template escape')
        i += 6; continue
      }
      i += 2; continue
    }
    if (src[i] === '$' && src[i + 1] === '{') { i = lexicalTemplateExpr(src, i + 2, strict); continue }
    i++
  }
  fail('unterminated template literal')
}
lexicalTemplateExpr = (src, start, strict) => {
  let i = start, depth = 1, canRegex = true
  while (i < src.length) {
    const ch = src[i]
    if (isWhitespaceCode(src.charCodeAt(i))) { i++; continue }
    if (ch === '"' || ch === "'") { i = lexicalQuoted(src, i, ch, strict); canRegex = false; continue }
    if (ch === '`') { i = lexicalTemplate(src, i, strict, !canRegex); canRegex = false; continue }
    if (ch === '/' && src[i + 1] === '/') {
      i += 2; while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++; continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) fail('unterminated block comment')
      i = end + 2; continue
    }
    if (ch === '/' && canRegex) {
      i++
      let cls = false
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '[') cls = true
        else if (src[i] === ']') cls = false
        else if (src[i] === '/' && !cls) { i++; break }
        else if (src[i] === '\n' || src[i] === '\r') fail('line terminator in regular expression')
        i++
      }
      while (/[A-Za-z]/.test(src[i] || '')) i++
      canRegex = false
      continue
    }
    if (isDigitCode(src.charCodeAt(i)) || ch === '.' && isDigitCode(src.charCodeAt(i + 1))) {
      i = lexicalNumber(src, i, strict); canRegex = false; continue
    }
    if (isIdentCode(src.charCodeAt(i))) {
      i++
      while (isIdentCode(src.charCodeAt(i))) i++
      canRegex = false
      continue
    }
    if (ch === '{') { depth++; canRegex = true }
    else if (ch === '}' && --depth === 0) return i + 1
    else canRegex = !(/[)\]}]/.test(ch))
    i++
  }
  fail('unterminated template expression')
}

const P_CONTROL = 0, P_SEMIS = 1, P_REST = 2, P_REST_COMMA = 3, P_REST_DEPTH = 4, P_BASE_DEPTH = 5, P_EXPR_DEPTH = 6
const P_FOR_INOF = 7, P_FOR_DECL = 8, P_FOR_COMMAS = 9, P_FOR_INIT = 10, P_FOR_TOKENS = 11, P_FOR_CONSEQUENT = 12
const REST_BINDING = 1, REST_EXPRESSION = 2

// Cheap, single-pass, deliberately approximate: tracks only quote/backslash
// state (no need to also recognize comments/regexes/templates \u2014 a false
// positive here just costs an extra, fully-correct validateLexicalSource
// pass; only a false NEGATIVE would be unsound). Used to catch a raw
// LineTerminator inside a single/double-quoted string
// (`"\nmulti\nline\n"`), which the risk regexes below never anchor on.
const hasNewlineInQuote = src => {
  let quote = 0
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i)
    if (quote) {
      if (c === 92) { i++; continue }
      if (c === quote) { quote = 0; continue }
      if (c === 10 || c === 13) return true
    } else if (c === 34 || c === 39) quote = c
  }
  return false
}

const previousSourceToken = (src, from) => {
  let i = from - 1, newline = false
  for (;;) {
    while (i >= 0 && isWhitespaceCode(src.charCodeAt(i))) {
      const c = src.charCodeAt(i)
      if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) newline = true
      i--
    }
    if (i > 0 && src[i] === '/' && src[i - 1] === '*') {
      const start = src.lastIndexOf('/*', i - 2)
      if (start < 0) return [i, newline]
      for (let k = start; k <= i; k++) {
        const c = src.charCodeAt(k)
        if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) { newline = true; break }
      }
      i = start - 1
      continue
    }
    // Once whitespace crossed a line boundary, any `//...` text at the end
    // of the preceding line is trivia too. This helper is only entered from a
    // known token boundary, so the last `//` on that line is unambiguous.
    if (newline && i >= 1) {
      const lineStart = Math.max(src.lastIndexOf('\n', i), src.lastIndexOf('\r', i),
        src.lastIndexOf('\u2028', i), src.lastIndexOf('\u2029', i)) + 1
      const slash = src.lastIndexOf('//', i)
      if (slash >= lineStart) { i = slash - 1; continue }
    }
    return [i, newline]
  }
}

const sourceTrivia = (src, from) => {
  let i = from, newline = false
  for (;;) {
    while (i < src.length && isWhitespaceCode(src.charCodeAt(i))) {
      const c = src.charCodeAt(i)
      if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) newline = true
      i++
    }
    if (src[i] === '/' && src[i + 1] === '/') {
      i += 2
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r' &&
          src.charCodeAt(i) !== 0x2028 && src.charCodeAt(i) !== 0x2029) i++
      continue
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) return [src.length, newline]
      for (let k = i; k < end; k++) {
        const c = src.charCodeAt(k)
        if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) { newline = true; break }
      }
      i = end + 2
      continue
    }
    return [i, newline]
  }
}

const nextSourceToken = (src, from) => {
  let i = from
  for (;;) {
    while (i < src.length && isWhitespaceCode(src.charCodeAt(i))) i++
    if (src[i] === '/' && src[i + 1] === '/') {
      i += 2
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r' &&
          src.charCodeAt(i) !== 0x2028 && src.charCodeAt(i) !== 0x2029) i++
      continue
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      return end < 0 ? src.length : nextSourceToken(src, end + 2)
    }
    return i
  }
}

const M_ASYNC = 1, M_STATIC = 2, M_ASYNC_NL = 4, M_BAD_BOUNDARY = 8
const sourceWordBefore = (src, from) => {
  const prev = previousSourceToken(src, from)
  if (prev[0] < 0 || !isIdentCode(src.charCodeAt(prev[0]))) return null
  let start = prev[0]
  while (start > 0 && isIdentCode(src.charCodeAt(start - 1))) start--
  return [src.slice(start, prev[0] + 1), start, prev[1]]
}

// Method nodes carry the opening-paren offset. Recover the contextual prefix
// and the boundary before it without pretending to parse computed names.
// This repairs jessie's `static async name()` split for validation only, and
// distinguishes it from the valid `static async\nname()` field+method pair.
const methodSourceInfo = (src, parenAt) => {
  if (typeof parenAt !== 'number' || src[parenAt] !== '(') return 0
  const nameEnd = previousSourceToken(src, parenAt)[0]
  if (nameEnd < 0 || !isIdentCode(src.charCodeAt(nameEnd))) return 0
  let cursor = nameEnd
  while (cursor > 0 && isIdentCode(src.charCodeAt(cursor - 1))) cursor--
  if (src[cursor - 1] === '#') cursor--

  let flags = 0
  let prev = previousSourceToken(src, cursor)
  // Generator marker belongs to this method prefix, including async generators.
  if (prev[0] >= 0 && src[prev[0]] === '*') { cursor = prev[0]; prev = previousSourceToken(src, cursor) }
  let word = sourceWordBefore(src, cursor)
  if (word && word[0] === 'async') {
    if (word[2]) flags |= M_ASYNC_NL
    else { flags |= M_ASYNC; cursor = word[1] }
  } else if (word && (word[0] === 'get' || word[0] === 'set') && !word[2]) {
    cursor = word[1]
  }
  if (!(flags & M_ASYNC_NL)) {
    word = sourceWordBefore(src, cursor)
    if (word && word[0] === 'static') { flags |= M_STATIC; cursor = word[1] }
  }

  const boundary = previousSourceToken(src, cursor)
  if (boundary[0] >= 0 && src[boundary[0]] !== '{' && src[boundary[0]] !== '}' &&
      src[boundary[0]] !== ';' && !boundary[1]) flags |= M_BAD_BOUNDARY
  return flags
}

const sourceHasLexicalRisk = (src, strict) => typeof src === 'string' && (
  src.includes('\\') || src.includes('#!') || src.includes('\u180e') || src.includes('\u2e2f') ||
  src.includes('\u2028') || src.includes('\u2029') || src.includes('=>') || /\b(for|do)\b/.test(src) ||
  src.includes('?.') && src.includes('`') ||
  src.includes('_') && /(^|[^A-Za-z0-9_$])(?:[0-9][0-9]*_|0[xXoObB]_)/m.test(src) ||
  /(^|[^A-Za-z0-9_$])0[xXoObB]/m.test(src) ||
  /(^|[^A-Za-z0-9_$])[0-9][0-9_.]*n\b/m.test(src) ||
  /(^|[^A-Za-z0-9_$])[0-9](?![0-9.eEnN])[A-Za-z_$]/m.test(src) ||
  strict && /(^|[^A-Za-z0-9_$])0[0-9]/m.test(src) ||
  // `10._1`/`10._`/`10._e1`: a numeric separator directly after the decimal
  // point \u2014 the digit-before-underscore risk pattern above only anchors on
  // `[0-9]_`, missing this one. Anchored on a digit before the dot too, so
  // it doesn't fire on ordinary `obj._private` member access.
  /[0-9]\._/.test(src) ||
  // An unterminated block comment, or a raw LineTerminator inside a quoted
  // string, both need the full token-aware scan below to catch correctly
  // (strings/regexes must be skipped as such, not textually).
  src.includes('/*') || src.includes("''") || src.includes('""') || hasNewlineInQuote(src)
)

/** Lightweight lexical validation for spellings jessie's value AST erases. */
const validateLexicalSource = (src, strict) => {
  if (typeof src !== 'string') return
  let i = 0, canRegex = true, pendingControl = null, expectStatement = false, lastPunct = '', optionalDepth = -1, nesting = 0
  let pendingDo = false, quotedToken = false
  // True while a genuine LineTerminator (directly, or inside a multi-line
  // comment) has been crossed since the last real token — consumed once,
  // right before a real token is processed below, by the arrow-token check.
  let sawNewline = false
  const parens = [], doBlocks = [], doBlockEnds = new Set()
  while (i < src.length) {
    const c = src.charCodeAt(i), ch = src[i]
    if (isWhitespaceCode(c)) {
      if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) sawNewline = true
      i++; continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      i += 2; while (i < src.length && src[i] !== '\n' && src[i] !== '\r' &&
        src.charCodeAt(i) !== 0x2028 && src.charCodeAt(i) !== 0x2029) i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) fail('unterminated block comment')
      for (let k = i; k < end; k++) {
        const kc = src.charCodeAt(k)
        if (kc === 10 || kc === 13 || kc === 0x2028 || kc === 0x2029) { sawNewline = true; break }
      }
      i = end + 2; continue
    }
    if (ch === '#' && src[i + 1] === '!') {
      if (i !== 0) fail('hashbang is only valid at the start of source')
      i += 2; while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++; continue
    }
    // From here down, `ch` starts a real token — consume the accumulated
    // newline state once, for the arrow-token check just below, then reset.
    const hadNewline = sawNewline
    sawNewline = false
    if (ch !== '{') pendingDo = false
    if ((ch === '"' || ch === "'") && quotedToken && !hadNewline)
      fail('adjacent string literals require an operator or statement terminator')
    if (ch !== '"' && ch !== "'") quotedToken = false
    // ArrowFunction's own grammar carries a "[no LineTerminator here]"
    // between ArrowParameters and `=>` — unlike a restricted-production
    // token (postfix ++/--, break/continue's label, return/yield's operand),
    // this one is a hard SyntaxError with no ASI fallback: nothing else can
    // follow ArrowParameters, so there is no alternative statement to split
    // into. jessie's grammar does not enforce it at all.
    if (ch === '=' && src[i + 1] === '>' && hadNewline)
      fail('line terminator between arrow function parameters and =>')
    // A sibling after `...x,` makes this a spread list, not a trailing rest
    // comma. Keep the marker only through closing delimiters.
    const restGroup = parens[parens.length - 1]
    if (restGroup && restGroup[P_REST_COMMA] && restGroup[P_REST_DEPTH] === nesting &&
        ch !== ',' && ch !== ')' && ch !== ']' && ch !== '}') {
      restGroup[P_REST] = false
      restGroup[P_REST_COMMA] = false
    }
    if (ch === '"' || ch === "'") {
      i = lexicalQuoted(src, i, ch, strict)
      quotedToken = true; canRegex = false; continue
    }
    if (ch === '`') {
      if (!canRegex && optionalDepth >= 0) fail('optional chain cannot be used as a tagged template')
      i = lexicalTemplate(src, i, strict, !canRegex)
      canRegex = false; optionalDepth = -1; continue
    }
    if (ch === '\\' && src[i + 1] === 'u') {
      const escapeStart = i
      i += 2
      let digits
      if (src[i] === '{') {
        i++
        const begin = i
        while (isHexCode(src.charCodeAt(i))) i++
        if (i === begin || src[i] !== '}') fail('invalid Unicode identifier escape')
        digits = src.slice(begin, i)
        i++
      } else {
        for (let k = 0; k < 4; k++) if (!isHexCode(src.charCodeAt(i + k))) fail('invalid Unicode identifier escape')
        digits = src.slice(i, i + 4)
        i += 4
      }
      const cp = parseInt(digits, 16)
      const prev = src.charCodeAt(escapeStart - 1)
      const continuation = isIdentCode(prev)
      const asciiStart = cp === 36 || cp === 95 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122
      const asciiPart = asciiStart || isDigitCode(cp)
      const valid = continuation ? asciiPart || cp > 127
        : asciiStart || cp > 127 && cp !== 0x200c && cp !== 0x200d
      if (cp === 35 || cp === 0x2e2f || isWhitespaceCode(cp) || !valid)
        fail('Unicode escape does not encode a valid identifier character')
      canRegex = false
      continue
    }
    if (isDigitCode(c) || ch === '.' && isDigitCode(src.charCodeAt(i + 1))) {
      i = lexicalNumber(src, i, strict); canRegex = false; continue
    }
    if (c === 0x2e2f || c === 0x180e) fail('character is not valid in an identifier or whitespace')
    if (isIdentCode(c)) {
      const start = i++
      while (isIdentCode(src.charCodeAt(i))) {
        const part = src.charCodeAt(i)
        if (part === 0x2e2f || part === 0x180e) fail('character is not valid in an identifier')
        i++
      }
      const word = src.slice(start, i)
      pendingDo = false
      if (word === 'while') {
        const prev = previousSourceToken(src, start)
        if (prev[0] >= 0 && src[prev[0]] === ';') {
          const beforeSemi = previousSourceToken(src, prev[0])
          if (doBlockEnds.has(beforeSemi[0]))
            fail('semicolon is not allowed between a do body and while')
        }
      }
      // A classic for head needs exactly two semicolons; a for-in/of head
      // needs a top-level `in`/`of` and none. Record only the outermost header
      // group, so `(key in obj)` remains a valid parenthesized classic-for
      // initializer. Lexical for-in/of declarations have exactly one
      // uninitialized binding; commas/defaults nested inside a pattern do not
      // count because `nesting` differs there.
      const forGroup = parens[parens.length - 1]
      if (forGroup && forGroup[P_CONTROL] === 'for' && forGroup[P_BASE_DEPTH] === nesting &&
          forGroup[P_SEMIS] === 0 && !forGroup[P_FOR_INOF] && lastPunct !== '.') {
        let decl = forGroup[P_FOR_DECL]
        // In sloppy code `let` alone is a valid IdentifierReference on the
        // left of for-in. Treat this one-token spelling as an expression LHS,
        // not an incomplete LexicalDeclaration; strict-context validation is
        // deliberately left to the AST walker (whose kernel caveat is noted
        // at the for handler below).
        const letReference = decl === 'let' && forGroup[P_FOR_TOKENS] === 1 && word === 'in'
        const lhsReady = letReference || (decl ? forGroup[P_FOR_TOKENS] >= 2 : forGroup[P_FOR_TOKENS] >= 1)
        if ((word === 'in' || word === 'of') && lhsReady && !forGroup[P_FOR_CONSEQUENT]) {
          forGroup[P_FOR_INOF] = word
          if (letReference && strict) fail("'let' cannot be a for-in assignment target in strict mode")
          if (letReference) decl = forGroup[P_FOR_DECL] = false
          if ((decl === 'let' || decl === 'const') &&
              (forGroup[P_FOR_COMMAS] || forGroup[P_FOR_INIT]))
            fail('for-in/of lexical declaration must have one uninitialized binding')
        } else {
          if (!forGroup[P_FOR_TOKENS] && (word === 'let' || word === 'const' || word === 'var'))
            forGroup[P_FOR_DECL] = word
          forGroup[P_FOR_TOKENS]++
        }
      }
      if (word === 'catch') {
        let k = i
        while (isWhitespaceCode(src.charCodeAt(k))) k++
        if (src[k] === '(') {
          k++
          while (isWhitespaceCode(src.charCodeAt(k))) k++
          if (src[k] === ')') fail('catch parentheses require a binding')
        }
      }
      if (expectStatement) {
        let declaration = word === 'let' || word === 'const' || word === 'class' || word === 'function'
        if (word === 'let') {
          let k = i
          while (src[k] === ' ' || src[k] === '\t') k++
          if (src[k] === '\n' || src[k] === '\r' || src[k] === '/' && src[k + 1] === '/') declaration = false
        }
        if (word === 'async') {
          let k = i
          while (isWhitespaceCode(src.charCodeAt(k))) k++
          declaration = src.slice(k, k + 8) === 'function' && !isIdentCode(src.charCodeAt(k + 8))
        }
        if (declaration) fail(`${word} declaration requires a block in statement position`)
        expectStatement = false
      }
      if (!(pendingControl === 'for' && word === 'await'))
        pendingControl = lastPunct !== '.' && /^(if|while|for|with)$/.test(word) ? word : null
      if (word === 'else' || word === 'do') expectStatement = true
      if (word === 'do' && lastPunct !== '.') pendingDo = true
      canRegex = /^(return|throw|case|delete|void|typeof|new|in|instanceof|yield|await|else|do)$/.test(word)
      lastPunct = ''
      continue
    }
    if (ch === '/' && canRegex) {
      i++
      let cls = false
      while (i < src.length) {
        if (src[i] === '\\') {
          const next = src.charCodeAt(i + 1)
          if (next === 10 || next === 13 || next === 0x2028 || next === 0x2029)
            fail('line terminator in regular expression')
          i += 2; continue
        }
        if (src[i] === '[') cls = true
        else if (src[i] === ']') cls = false
        else if (src[i] === '/' && !cls) { i++; break }
        else if (src[i] === '\n' || src[i] === '\r' || src.charCodeAt(i) === 0x2028 || src.charCodeAt(i) === 0x2029)
          fail('line terminator in regular expression')
        i++
      }
      const flagsStart = i
      while (/[A-Za-z]/.test(src[i] || '') || src[i] === '\\') i++
      validateRegExp('', src.slice(flagsStart, i))
      canRegex = false; continue
    }
    if (src.slice(i, i + 3) === '???') fail('invalid question-mark token sequence')
    if (expectStatement && ch !== '{') expectStatement = false
    if (ch === '?' && src[i + 1] === '.') optionalDepth = parens.length
    const forConditional = parens[parens.length - 1]
    if (forConditional && forConditional[P_CONTROL] === 'for' &&
        forConditional[P_BASE_DEPTH] === nesting && forConditional[P_SEMIS] === 0 &&
        !forConditional[P_FOR_INOF]) {
      if (ch === '?' && src[i + 1] !== '.' && src[i + 1] !== '?') forConditional[P_FOR_CONSEQUENT]++
      else if (ch === ':' && forConditional[P_FOR_CONSEQUENT]) forConditional[P_FOR_CONSEQUENT]--
    }
    if (src.slice(i, i + 3) === '...') {
      const group = parens[parens.length - 1]
      if (group) {
        group[P_REST] = group[P_EXPR_DEPTH] >= 0 ? REST_EXPRESSION : REST_BINDING
        group[P_REST_DEPTH] = nesting
      }
      canRegex = true; lastPunct = '...'; i += 3; continue
    }
    if (ch === '(') {
      const parent = parens[parens.length - 1]
      parens.push([pendingControl, 0, false, false, -1, nesting,
        parent && parent[P_EXPR_DEPTH] >= 0 ? nesting : -1, false, false, 0, false, 0, 0])
      pendingControl = null
    }
    else if (ch === ')') {
      const group = parens.pop()
      if (group && group[P_CONTROL] === 'for') {
        if ((group[P_SEMIS] === 0 && !group[P_FOR_INOF]) ||
            (group[P_SEMIS] !== 0 && group[P_SEMIS] !== 2))
          fail('for header has the wrong number of semicolons')
        if (group[P_SEMIS] === 2 && group[P_FOR_INOF])
          fail("'in'/'of' is not allowed in an unparenthesized classic for initializer")
      }
      const parent = parens[parens.length - 1]
      if (parent && parent[P_CONTROL] === 'for' && parent[P_BASE_DEPTH] === nesting &&
          parent[P_SEMIS] === 0 && !parent[P_FOR_INOF]) parent[P_FOR_TOKENS]++
      if (group && group[P_REST_COMMA] && !group[P_CONTROL]) {
        let k = i + 1
        while (isWhitespaceCode(src.charCodeAt(k))) k++
        if (src.slice(k, k + 2) === '=>' || src[k] === '{') fail('rest parameter cannot have a trailing comma')
        if (group[P_REST] !== REST_EXPRESSION) {
          const parent = parens[parens.length - 1]
          if (parent) parent[P_REST_COMMA] = true
        }
      }
      if (group && group[P_CONTROL]) expectStatement = true
      if (optionalDepth > parens.length) optionalDepth = -1
    } else if (ch === '{') {
      const group = parens[parens.length - 1]
      if (group && group[P_CONTROL] === 'for' && group[P_BASE_DEPTH] === nesting &&
          group[P_SEMIS] === 0 && !group[P_FOR_INOF]) group[P_FOR_TOKENS]++
      nesting++
      if (pendingDo) doBlocks.push(nesting)
      pendingDo = false; expectStatement = false; pendingControl = null
    }
    else if (ch === '[') {
      const group = parens[parens.length - 1]
      if (group && group[P_CONTROL] === 'for' && group[P_BASE_DEPTH] === nesting &&
          group[P_SEMIS] === 0 && !group[P_FOR_INOF]) group[P_FOR_TOKENS]++
      nesting++
    }
    else if (ch === '}' || ch === ']') {
      if (ch === '}' && doBlocks[doBlocks.length - 1] === nesting) {
        doBlocks.pop()
        doBlockEnds.add(i)
      }
      nesting--
      pendingDo = false
      const group = parens[parens.length - 1]
      if (group && group[P_REST] && nesting < group[P_REST_DEPTH]) {
        if (group[P_REST] === REST_EXPRESSION) group[P_REST_COMMA] = false
        group[P_REST] = false
      }
      if (group && group[P_EXPR_DEPTH] > nesting) group[P_EXPR_DEPTH] = -1
    }
    else if (ch === ';' || ch === ',') {
      const group = parens[parens.length - 1]
      if (ch === ';' && group && group[P_CONTROL] === 'for' && group[P_BASE_DEPTH] === nesting) group[P_SEMIS]++
      if (ch === ',' && group && group[P_CONTROL] === 'for' && group[P_BASE_DEPTH] === nesting &&
          group[P_SEMIS] === 0 && !group[P_FOR_INOF]) group[P_FOR_COMMAS]++
      if (ch === ',' && group && group[P_REST] && group[P_REST_DEPTH] === nesting) group[P_REST_COMMA] = true
      if (ch === ',' && group && group[P_EXPR_DEPTH] >= nesting) group[P_EXPR_DEPTH] = -1
      optionalDepth = -1
    } else if (ch === '=' && src[i + 1] !== '>' && src[i + 1] !== '=' &&
        !/[=!<>+\-*/%&|^?]/.test(src[i - 1] || '')) {
      const group = parens[parens.length - 1]
      if (group && group[P_EXPR_DEPTH] < 0) group[P_EXPR_DEPTH] = nesting
      if (group && group[P_CONTROL] === 'for' && group[P_BASE_DEPTH] === nesting &&
          group[P_SEMIS] === 0 && !group[P_FOR_INOF]) group[P_FOR_INIT] = true
    }
    canRegex = !(/[)\]}]/.test(ch))
    lastPunct = ch
    i++
  }
}

const isUseStrict = body => {
  for (const stmt of statements(body)) {
    if (isNode(stmt) && stmt[0] == null && typeof stmt[1] === 'string') {
      if (stmt[1] === 'use strict') return true
      continue
    }
    break
  }
  return false
}

const functionBodyOpen = (source, node) => {
  if (typeof node?.loc !== 'number') return -1
  let i = node.loc, paren = 0, sawParams = false
  while (i < source.length) {
    const trivia = sourceTrivia(source, i)
    i = trivia[0]
    const ch = source[i]
    if (ch === '"' || ch === "'") { i = lexicalQuoted(source, i, ch, false); continue }
    if (ch === '`') { i = lexicalTemplate(source, i, false); continue }
    if (ch === '(') { sawParams = true; paren++; i++; continue }
    if (ch === ')') { paren--; i++; continue }
    if (ch === '{' && sawParams && paren === 0) return i
    i++
  }
  return -1
}

// A later "use strict" directive applies to the complete Directive Prologue,
// including raw escape spellings in strings that precede it. The AST knows
// that this function has an own strict directive; rescan only that prologue so
// a same-looking string in an ordinary block or sloppy sibling stays legal.
const validateStrictDirectivePrologue = (source, bodyOpen) => {
  if (bodyOpen < 0) return
  let i = bodyOpen + 1
  for (;;) {
    const before = sourceTrivia(source, i)
    i = before[0]
    const quote = source[i]
    if (quote !== '"' && quote !== "'") return
    i = lexicalQuoted(source, i, quote, true)
    const after = sourceTrivia(source, i)
    i = after[0]
    if (source[i] === ';') { i++; continue }
    if (after[1]) continue
    return
  }
}

const patternItems = pattern => {
  if (!isNode(pattern)) return [pattern]
  if (pattern[0] === '()' && pattern.length === 2) return patternItems(pattern[1])
  // A `'[]'`-tagged node is ambiguous pre-prepare: length 2 is a genuine
  // single-element array pattern/literal (unwrap into its one item), but
  // length 3 is `receiver[key]` element access — a leaf, not a container.
  // Only the length-2 shape should recurse; `'{}'` has no such ambiguity.
  if (pattern[0] === '{}' && pattern.length > 1) return patternItems(pattern[1])
  if (pattern[0] === '[]' && pattern.length === 2) return patternItems(pattern[1])
  if (pattern[0] === ',') return pattern.slice(1)
  return [pattern]
}

// Object-literal (non-pattern) item list: only the top comma-list is
// flattened. Reusing patternItems here would be wrong — its `'[]'`/`'{}'`
// single-child unwrap exists for BINDING PATTERNS (`[x]` meaning "array
// pattern, one element x"), but an object literal's lone item may itself be
// `[]`-tagged for an unrelated reason (`{[x]}`'s computed-name-without-value
// attempt), and unwrapping it there erases the very shape that marks it
// invalid.
const objectLiteralItems = node => {
  const body = node.length > 1 ? node[1] : null
  if (body == null) return []
  return isNode(body) && body[0] === ',' ? body.slice(1) : [body]
}

const boundNames = (pattern, out = []) => {
  if (typeof pattern === 'string') { out.push(pattern); return out }
  if (!isNode(pattern)) return out
  const op = pattern[0]
  if (op === '=' || op === '...') return boundNames(pattern[1], out)
  if (op === '()' && pattern.length === 2) return boundNames(pattern[1], out)
  // `receiver[key]` element access (arity 3) binds no names — it's an
  // assignment-target leaf, not a nested pattern; patternItems' arity-2-only
  // unwrap otherwise returns this exact node back as its own "one item",
  // recursing into itself forever.
  if (op === '[]' && pattern.length === 3) return out
  if (op === '[]') {
    for (const item of patternItems(pattern)) boundNames(item, out)
    return out
  }
  if (op === '{}') {
    for (const item of patternItems(pattern)) {
      if (typeof item === 'string') boundNames(item, out)
      else if (isNode(item) && item[0] === ':') boundNames(item[2], out)
      else boundNames(item, out)
    }
  }
  return out
}

const decodeIdentifier = name => typeof name === 'string' ? name.replace(/\\u(?:\{([0-9A-Fa-f]+)\}|([0-9A-Fa-f]{4}))/g,
  (_m, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16))) : name

const duplicateName = names => {
  // Binding lists are tiny; a nested comparison avoids allocating a Set (and
  // its 8-slot table) for every declaration/parameter list.
  for (let i = 0; i < names.length; i++) {
    const name = decodeIdentifier(names[i])
    for (let k = 0; k < i; k++) if (decodeIdentifier(names[k]) === name) return name
  }
  return null
}

const checkBindingName = (name, cx) => {
  name = decodeIdentifier(name)
  if (name.startsWith('#')) fail(`private name '${name}' cannot be a binding`)
  if (ALWAYS_RESERVED.has(name)) fail(`reserved word '${name}' cannot be a binding`)
  if (name === 'let' && (cx.strict || cx.lexical)) fail(`'let' cannot be a lexical binding`)
  if (name === 'await' && (cx.async || cx.staticBlock || (cx.module && cx.functionDepth === 0))) fail(`'await' cannot be bound in this context`)
  if (name === 'yield' && (cx.strict || cx.generator)) fail(`'yield' cannot be bound in this context`)
  if (cx.strict && (STRICT_RESERVED.has(name) || name === 'eval' || name === 'arguments'))
    fail(`'${name}' cannot be bound in strict mode`)
}

// IdentifierReference legality for a bare-string node reached where walk()'s
// normal per-child loop cannot see it — a lone identifier used as a WHOLE
// statement (`f\u{61}lse;`) or as a for-in/of target (`for (let in o)`) is
// never a listed CHILD of a parent node the loop iterates; it IS the node.
// Scoped to exactly those two call sites (both unambiguous
// IdentifierReference positions) rather than folded into walk()'s dispatch,
// which also reaches property names, import/export specifier externals, and
// object-literal keys through the very same bare-string shape — contexts
// where this check must NOT run.
const checkIdentifierRef = (name, cx) => {
  if (name.startsWith('#') && !cx.privateNames?.has(name)) fail(`private name '${name}' is not declared in this class`)
  if (cx.async && name === 'await') fail("'await' cannot be an identifier reference in an async function")
  if (name.includes('\\u')) {
    const decoded = decodeIdentifier(name)
    if (ALWAYS_RESERVED.has(decoded) || cx.strict && (STRICT_RESERVED.has(decoded) || decoded === 'let' || decoded === 'yield') ||
        cx.async && decoded === 'await') fail(`escaped reserved word '${decoded}' cannot be an identifier reference`)
  } else if (cx.strict && (STRICT_RESERVED.has(name) || name === 'let' || name === 'yield')) {
    fail(`'${name}' cannot be used as an identifier reference in strict mode`)
  }
}

const validatePatternTree = (pattern, cx, binding, inRest = false) => {
  if (typeof pattern === 'string') {
    checkBindingName(pattern, cx)
    return
  }
  if (!isNode(pattern)) return
  const op = pattern[0]
  if (op === '()' && pattern.length === 2) return validatePatternTree(pattern[1], cx, binding, inRest)
  if (op === '=') {
    if (inRest) fail('rest element cannot have an initializer')
    return validatePatternTree(pattern[1], cx, binding, false)
  }
  if (op === 'yield' || op === 'await') {
    // A bare `yield`/`await` binding name tokenizes with a null operand
    // (`let yield;` → `['yield', null]`); a real trailing expression
    // (`let\nawait 0;` → `['await', [null, 0]]`) means the source actually
    // held a unary yield/await-expression, never a valid binding pattern.
    if (pattern[1] != null) fail('unexpected token in binding position')
    checkBindingName(op, cx)
    return
  }
  // Jessie tokenizes these writable global identifier spellings as their
  // value literals even in binding/assignment position.
  if (op === 'nan' || op == null && typeof pattern[1] === 'number' && !Number.isFinite(pattern[1]) ||
      op === undefined && pattern.length === 0) return
  if (op === ':') return validatePatternTree(pattern[2], cx, binding, inRest)
  if (op === '...') {
    const target = pattern[1]
    if (isNode(target) && target[0] === '=') fail('rest element cannot have an initializer')
    return validatePatternTree(target, cx, binding, true)
  }
  if (op === '[]' && pattern.length === 3) {
    // `receiver[key]` computed-member-access target, not a nested pattern —
    // jessie's raw AST shares the `'[]'` tag between the two, disambiguated
    // only by arity (2: pattern container: 3: element access). A member
    // expression is a leaf simple-assignment-target, never a binding; the
    // key sits in full Expression position, which pattern-walking otherwise
    // never visits — validate the one identifier-reference restriction
    // (bare yield/await) that a plain compile-time-erased AST walk can still
    // prove here without a general expression walker.
    if (binding || !isAssignmentTarget(pattern, false)) fail('invalid destructuring target')
    const key = pattern[2]
    if (isNode(key) && key[1] == null) {
      // Inside a real generator, bare `yield` is unconditionally the
      // yield-operator (evaluating to the resumed value) — never ambiguous
      // with an identifier reference, so cx.generator EXEMPTS rather than
      // triggers this check (unlike checkBindingName's yield rule, which
      // governs BindingIdentifier and is rightly stricter).
      if (key[0] === 'yield' && cx.strict && !cx.generator)
        fail("'yield' cannot be used as an identifier reference in this context")
      if (key[0] === 'await' && (cx.async || cx.staticBlock || (cx.module && cx.functionDepth === 0)))
        fail("'await' cannot be used as an identifier reference in this context")
    }
    return
  }
  if (op === '[]' || op === '{}') {
    const items = patternItems(pattern)
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (isNode(item) && item[0] === '...' && i !== items.length - 1) fail('rest element must be last')
      if (op === '{}' && isNode(item) && item[0] === ':') {
        if (typeof item[1] === 'string' && item[1].startsWith('#'))
          fail('private names are not valid object destructuring keys')
        validatePatternTree(item[2], cx, binding)
      }
      else validatePatternTree(item, cx, binding)
    }
    return
  }
  if (binding || !isAssignmentTarget(pattern, false)) fail('invalid destructuring target')
}

const checkPattern = (pattern, cx, binding = true) => {
  validatePatternTree(pattern, cx, binding)
  const names = boundNames(pattern)
  const dup = duplicateName(names)
  if (dup && cx.unique) fail(`duplicate binding '${dup}'`)
  return names
}

// Jessie drops a final comma from both `[...x,]` and `[...x]`. In a plain
// array/object literal the comma is valid; once the same cover node occupies
// an AssignmentPattern slot it is forbidden. The following operator's source
// offset gives an exact, local boundary without guessing from decoded values.
const patternHasTrailingRestComma = (pattern, source, boundary) => {
  if (!isNode(pattern) || (pattern[0] !== '[]' && pattern[0] !== '{}') ||
      typeof boundary !== 'number') return false
  const items = patternItems(pattern)
  const last = items[items.length - 1]
  if (!isNode(last) || last[0] !== '...') return false
  const close = previousSourceToken(source, boundary)[0]
  if (close < 0 || source[close] !== (pattern[0] === '[]' ? ']' : '}')) return false
  const comma = previousSourceToken(source, close)[0]
  return comma >= 0 && source[comma] === ','
}

const visitPatternInitializers = (pattern, cx, visit) => {
  if (!isNode(pattern)) return
  const op = pattern[0]
  if (op === '=') {
    visit(pattern[2], cx)
    visitPatternInitializers(pattern[1], cx, visit)
    return
  }
  if (op === '...') return visitPatternInitializers(pattern[1], cx, visit)
  // `receiver[key]` element access (arity 3): a leaf, same reasoning as
  // boundNames above — no initializer structure to descend into, and
  // recursing via patternItems would hand this exact node back to itself.
  if (op === '[]' && pattern.length === 3) return
  if (op === '[]' || op === '{}') {
    for (const item of patternItems(pattern)) {
      if (op === '{}' && isNode(item) && item[0] === ':') visitPatternInitializers(item[2], cx, visit)
      else visitPatternInitializers(item, cx, visit)
    }
  }
}

const paramsOf = raw => {
  if (raw == null) return []
  if (isNode(raw) && raw[0] === '()') raw = raw.length === 2 ? raw[1] : null
  if (raw == null) return []
  return isNode(raw) && raw[0] === ',' ? raw.slice(1) : [raw]
}

const isSimpleParams = params => params.every(p => typeof p === 'string')

const D_TYPE = 0, D_NAMES = 1
const declaration = node => {
  if (!isNode(node)) return null
  if (node[0] === 'async' && isNode(node[1]) && (node[1][0] === 'function' || node[1][0] === 'function*'))
    return declaration(node[1])
  if (node[0] === 'export') {
    for (let i = 1; i < node.length; i++) {
      const d = declaration(node[i])
      if (d) return d
    }
    return null
  }
  if (node[0] === 'default') return declaration(node[1])
  if (node[0] === 'let' || node[0] === 'const' || node[0] === 'var') {
    const names = []
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      boundNames(isNode(d) && d[0] === '=' ? d[1] : d, names)
    }
    return [node[0], names]
  }
  if (node[0] === 'class' && typeof node[1] === 'string') return ['class', [node[1]]]
  if ((node[0] === 'function' || node[0] === 'function*') && typeof node[1] === 'string')
    return ['function', [node[1]]]
  // `using`/`await using` bindings are lexically scoped, same as `let` — feed
  // their names into the same conflict/duplicate machinery (var-hoisting is
  // the only thing that distinguishes 'var' below; every other D_TYPE reader
  // treats non-'var' uniformly as lexical).
  if (node[0] === 'using' || (node[0] === 'await' && isNode(node[1]) && node[1][0] === 'using')) {
    const decl = node[0] === 'using' ? node : node[1]
    const names = []
    for (let i = 1; i < decl.length; i++) {
      const d = decl[i]
      if (isNode(d) && d[0] === '=' && typeof d[1] === 'string') names.push(d[1])
    }
    return ['let', names]
  }
  return null
}

const collectVarNames = (node, out, scopeKind, direct = true) => {
  if (!isNode(node)) return
  const op = node[0]
  if (op === '=>' || op === 'function' || op === 'function*' || op === 'class') return
  if (op === 'async' && isNode(node[1]) && (node[1][0] === 'function' || node[1][0] === 'function*')) return
  const d = declaration(node)
  if (d && d[D_TYPE] === 'var') for (const name of d[D_NAMES]) out.push(name)
  if (direct && (scopeKind === 'global' || scopeKind === 'function') && d && d[D_TYPE] === 'function')
    for (const name of d[D_NAMES]) out.push(name)
  for (let i = 1; i < node.length; i++) collectVarNames(node[i], out, scopeKind, false)
}

const validateScopeNames = (body, cx, scopeKind, paramNames = []) => {
  const list = statements(body)
  const lexical = []
  const directVar = []
  // Annex B's "a top-level FunctionDeclaration also counts as VarDeclaredNames"
  // leniency (which is why 'function' joins 'var' in directVar below, at
  // 'global'/'function' scopeKind, without conflict) is SLOPPY-SCRIPT-ONLY —
  // module top level never gets it, so `var f; function f(){}` there is a
  // genuine lexical/var clash. Track the two kinds separately, module-scope
  // only, to check that narrow case without disturbing the shared bucketing
  // every other scopeKind (and sloppy scripts) already relies on.
  const moduleTop = scopeKind === 'global' && cx.module
  const topVarNames = [], topFuncNames = []
  for (const stmt of list) {
    const d = declaration(stmt)
    if (!d) continue
    if (d[D_TYPE] === 'let' || d[D_TYPE] === 'const' || d[D_TYPE] === 'class' ||
        (d[D_TYPE] === 'function' && scopeKind !== 'global' && scopeKind !== 'function'))
      lexical.push(...d[D_NAMES])
    else if (d[D_TYPE] === 'var' || d[D_TYPE] === 'function') {
      directVar.push(...d[D_NAMES])
      if (moduleTop) (d[D_TYPE] === 'var' ? topVarNames : topFuncNames).push(...d[D_NAMES])
    }
  }
  if (moduleTop) for (const name of topFuncNames) if (topVarNames.includes(name))
    fail(`function declaration '${name}' conflicts with a var declaration at module top level`)
  const dup = duplicateName(lexical)
  if (dup) fail(`duplicate lexical declaration '${dup}'`)
  const vars = []
  for (const stmt of list) collectVarNames(stmt, vars, scopeKind, true)
  const varSet = new Set(vars.length ? vars : directVar)
  for (const name of lexical) {
    if (varSet.has(name)) fail(`lexical declaration '${name}' conflicts with var/function declaration`)
    if (paramNames.includes(name)) fail(`lexical declaration '${name}' conflicts with a parameter`)
  }
  for (const name of lexical) checkBindingName(name, { ...cx, lexical: true })
}

const isAssignmentTarget = (node, allowPattern) => {
  if (typeof node === 'string') return true
  if (!isNode(node)) return false
  const op = node[0]
  if (op === '()' && node.length === 2) return isAssignmentTarget(node[1], allowPattern)
  if (op === '.' || op === '[]') return true
  if (allowPattern && (op === '{}' || op === '[]')) return true
  return false
}

// Jessie can continue a leading `{}` through an infix/access operator even
// where ECMAScript has already committed that token to a BlockStatement (at
// statement start) or an arrow function body. Follow only operators whose
// source starts at their first operand; an explicit `(...)` is a hard stop.
const LEFT_EDGE_OPS = new Set([
  ...ASSIGN_OPS, ',', '?', '.', '[]', '()', '?.', '?.[]', '?.()', '``',
  '+', '-', '*', '/', '%', '**', '<', '>', '<=', '>=', '==', '!=', '===', '!==',
  '&', '|', '^', '<<', '>>', '>>>', '&&', '||', '??', 'in', 'of', 'instanceof',
])
const BLOCK_CANNOT_PREFIX = new Set([
  ...ASSIGN_OPS, '*', '%', '**', '<', '>', '<=', '>=', '==', '!=', '===', '!==',
  '&', '|', '^', '<<', '>>', '>>>', '&&', '||', '??', 'in', 'of', 'instanceof', '.', '?.',
])
const leftEdgeIsObject = node => {
  if (!isNode(node)) return false
  if (node[0] === '{}') return true
  if (node[0] === '()' && node.length === 2) return false
  if ((node[0] === '[]' || node[0] === '()') && node.length < 3) return false
  if ((node[0] === '++' || node[0] === '--') && node.length < 3) return false
  return LEFT_EDGE_OPS.has(node[0]) && leftEdgeIsObject(node[1])
}

const hasIncompleteNamedBackref = pattern => {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '\\') continue
    let end = i
    while (pattern[end] === '\\') end++
    if ((end - i) % 2 && pattern[end] === 'k' && pattern[end + 1] !== '<') return true
    i = end
  }
  return false
}

const validateRegExp = (pattern, flags = '') => {
  const seen = new Set()
  for (const flag of flags) {
    if (!'dgimsuvy'.includes(flag)) fail(`invalid regular expression flag '${flag}'`)
    if (seen.has(flag)) fail(`duplicate regular expression flag '${flag}'`)
    seen.add(flag)
  }
  if (seen.has('u') && seen.has('v')) fail("regular expression flags 'u' and 'v' are mutually exclusive")

  const groups = new Set()
  for (const m of pattern.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)) {
    if (groups.has(m[1])) fail(`duplicate regular expression group '${m[1]}'`)
    groups.add(m[1])
  }
  for (const m of pattern.matchAll(/\{([0-9]+),([0-9]+)\}/g))
    if (+m[1] > +m[2]) fail('regular expression quantifier range is reversed')
  if (/\(\?<([=!])[^)]*\)[?*+{]/.test(pattern)) fail('lookbehind assertion cannot be quantified')

  for (const m of pattern.matchAll(/\[([^\]]*)\]/g)) {
    const cls = m[1]
    for (let i = 1; i + 1 < cls.length; i++) {
      if (cls[i] !== '-' || cls[i - 1] === '\\' || cls[i + 1] === '\\') continue
      if (cls.charCodeAt(i - 1) > cls.charCodeAt(i + 1)) fail('regular expression character range is reversed')
    }
  }
  if (/^[*+?{]/.test(pattern)) fail('regular expression quantifier has no target')
  if (hasIncompleteNamedBackref(pattern)) fail('incomplete named regular expression backreference')
  if (seen.has('u') || seen.has('v')) {
    if (/\(\?[=!][^)]*\)[?*+{]/.test(pattern)) fail('assertion cannot be quantified in Unicode regular expression')
    if (/\\c(?![A-Za-z])/.test(pattern)) fail('invalid control escape in Unicode regular expression')
    for (const m of pattern.matchAll(/\\([A-Za-z])/g))
      if (!'bBcdDfnrsStvWwpxukP'.includes(m[1])) fail(`invalid identity escape \\${m[1]} in Unicode regular expression`)
    for (const m of pattern.matchAll(/\\u\{([0-9A-Fa-f]+)\}/g))
      if (parseInt(m[1], 16) > 0x10ffff) fail('regular expression Unicode escape is out of range')
    if (/\\u(?![0-9A-Fa-f]{4}|\{[0-9A-Fa-f]+\})/.test(pattern)) fail('invalid regular expression Unicode escape')
    if (/\\[1-9]/.test(pattern)) fail('legacy decimal escape is invalid in Unicode regular expression')
  }
}

const isIteration = node => isNode(node) && (
  node[0] === 'for' || node[0] === 'for await' || node[0] === 'while' || node[0] === 'do'
)

const classMember = raw => {
  const loc = raw?.loc
  let member = raw, isStatic = false
  if (isNode(member) && member[0] === 'static') { isStatic = true; member = member[1] }
  let kind = 'field', key = typeof member === 'string' ? member : null, value = null
  if (isNode(member) && member[0] == null) key = member[1]
  else if (isNode(member) && member[0] === '=') {
    let lhs = member[1]
    if (isNode(lhs) && lhs[0] === 'static') { isStatic = true; lhs = lhs[1] }
    key = typeof lhs === 'string' ? lhs : isNode(lhs) && lhs[0] == null ? lhs[1] : null
    value = member[2]
  } else if (isNode(member) && member[0] === ':') {
    key = member[1]; value = member[2]; kind = 'method'
  } else if (isNode(member) && (member[0] === 'get' || member[0] === 'set')) {
    kind = member[0]; key = member[1]; value = member
  } else if (isNode(member) && member[0] === '{}') kind = 'static-block'
  return { member, isStatic, kind, key, value, loc }
}

const classBodyOpen = (node, source) => {
  if (node[2] != null || typeof node.loc !== 'number') return -1
  let i = nextSourceToken(source, node.loc + 5)
  if (typeof node[1] === 'string') {
    if (!isIdentCode(source.charCodeAt(i))) return -1
    while (isIdentCode(source.charCodeAt(i))) i++
    i = nextSourceToken(source, i)
  }
  return source[i] === '{' ? i : -1
}

// Bare class fields have no node location. For the one ambiguity that needs
// one — two bare fields on the same line — scan only a simple no-heritage
// class body's top level and compare against adjacent bare-string AST members.
const hasUnseparatedBareClassFields = (node, members, source) => {
  const pairs = new Set()
  for (let i = 1; i < members.length; i++)
    if (typeof members[i - 1] === 'string' && members[i - 1] !== 'accessor' && typeof members[i] === 'string')
      pairs.add(`${members[i - 1]}\0${members[i]}`)
  if (!pairs.size) return false
  let i = classBodyOpen(node, source)
  if (i < 0) return false
  let depth = 1, paren = 0, bracket = 0, lastName = null, newline = false
  for (i++; i < source.length && depth; ) {
    const c = source.charCodeAt(i), ch = source[i]
    if (isWhitespaceCode(c)) {
      if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) newline = true
      i++; continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r' &&
          source.charCodeAt(i) !== 0x2028 && source.charCodeAt(i) !== 0x2029) i++
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) return false
      for (let k = i; k < end; k++) {
        const kc = source.charCodeAt(k)
        if (kc === 10 || kc === 13 || kc === 0x2028 || kc === 0x2029) { newline = true; break }
      }
      i = end + 2; continue
    }
    if (ch === '"' || ch === "'") { i = lexicalQuoted(source, i, ch, false); lastName = null; newline = false; continue }
    if (ch === '`') { i = lexicalTemplate(source, i, false); lastName = null; newline = false; continue }
    if (ch === '{') { depth++; lastName = null; newline = false; i++; continue }
    if (ch === '}') { depth--; lastName = null; newline = false; i++; continue }
    if (depth !== 1) { i++; continue }
    if (ch === '(') { paren++; lastName = null; newline = false; i++; continue }
    if (ch === ')') { paren--; lastName = null; newline = false; i++; continue }
    if (ch === '[') { bracket++; lastName = null; newline = false; i++; continue }
    if (ch === ']') { bracket--; lastName = null; newline = false; i++; continue }
    if (!paren && !bracket && (isIdentCode(c) && !isDigitCode(c) || ch === '#' && isIdentCode(source.charCodeAt(i + 1)))) {
      const start = i
      if (ch === '#') i++
      while (isIdentCode(source.charCodeAt(i))) i++
      const name = source.slice(start, i)
      if (lastName != null && !newline && pairs.has(`${lastName}\0${name}`)) return true
      lastName = name; newline = false
      continue
    }
    lastName = null; newline = false; i++
  }
  return false
}

const containsDirectName = (node, name) => {
  if (node === name) return true
  if (!isNode(node)) return false
  if (node[0] === 'function' || node[0] === 'function*' ||
      node[0] === 'async' && isNode(node[1]) && (node[1][0] === 'function' || node[1][0] === 'function*')) return false
  for (let i = 1; i < node.length; i++) if (containsDirectName(node[i], name)) return true
  return false
}

const validateClass = (node, cx, walk, source) => {
  const name = node[1]
  if (typeof name === 'string') checkBindingName(name, { ...cx, strict: true, lexical: true })
  const members = statements(node[3])
  // A bare `'*'` token as its own class-body statement-list item (optionally
  // `static`-prefixed) has no valid meaning under any circumstance — the
  // generator-method marker (`* name() {}`/`static * name() {}`) is only
  // ever valid attached to a following name in the SAME element. Its only
  // source is jessie's class-body parser splitting a generator-method/
  // constructor definition into two elements (losing the '*' marker's
  // attachment to the method that follows: `* constructor(){}` → a spurious
  // '*' element, then an unmarked `constructor(){}`; `static * prototype(){}`
  // likewise loses both 'static' and generator-ness) — always a symptom of
  // invalid input, never a legitimate field (no valid PropertyName spells as
  // a bare `*`).
  if (members.some(m => m === '*' || isNode(m) && m[0] === 'static' && m[1] === '*'))
    fail('unexpected token in class body')
  let constructors = 0
  const privateNames = new Map()
  const parsed = members.map(classMember)
  if (hasUnseparatedBareClassFields(node, members, source))
    fail('class fields on the same line require a semicolon or LineTerminator')

  // Private declarations are visible throughout the complete class body, so
  // collect the environment before validating any initializer/method use.
  for (const m of parsed) if (typeof m.key === 'string' && m.key.startsWith('#')) {
    if (m.key === '#constructor') fail("private name '#constructor' is forbidden")
    const prev = privateNames.get(m.key)
    const pair = (prev === 'get' && m.kind === 'set') || (prev === 'set' && m.kind === 'get')
    if (prev && !pair) fail(`duplicate private name '${m.key}'`)
    privateNames.set(m.key, pair ? 'pair' : m.kind)
  }
  const privateSet = new Set(cx.privateNames || [])
  for (const key of privateNames.keys()) privateSet.add(key)

  for (const m of parsed) {
    // An escaped IdentifierName is one source token even though a backward
    // ASCII scan sees only its trailing fragment. The modifier-like escaped
    // residuals have an ordinary method key and still take the source path;
    // a method whose OWN key is escaped must not be split at the escape.
    const escapedKey = typeof m.key === 'string' && m.key.includes('\\u')
    const sourceInfo = !escapedKey && (m.kind === 'method' || m.kind === 'get' || m.kind === 'set')
      ? methodSourceInfo(source, m.loc) : 0
    if (sourceInfo & M_BAD_BOUNDARY)
      fail('class elements on the same line require a semicolon or LineTerminator')
    const sourceStatic = m.isStatic || !!(sourceInfo & M_STATIC)
    const sourceAsync = !!(sourceInfo & M_ASYNC)
    if (sourceStatic && m.key === 'prototype') fail("static class element cannot be named 'prototype'")
    if (m.kind === 'field' && m.key === 'constructor') fail("class field cannot be named 'constructor'")
    if (!sourceStatic && m.key === 'constructor' && m.kind !== 'field') {
      if (m.kind !== 'method' || sourceAsync || isNode(m.value) && (m.value[0] === 'async' || m.value[0] === 'function*'))
        fail('class constructor cannot be an accessor, async function, or generator')
      constructors++
      if (constructors > 1) fail('class cannot declare more than one constructor')
    }
    if (m.kind === 'static-block') {
      const staticCx = { ...cx, strict: true, staticBlock: true, privateNames: privateSet,
        functionDepth: 0, loop: 0, switchDepth: 0, labels: new Map() }
      validateScopeNames(m.member[1], staticCx, 'block')
      walk(m.member[1], staticCx, true)
      continue
    }
    if (m.kind === 'field' && m.value && containsDirectName(m.value, 'arguments'))
      fail("class field initializer cannot contain 'arguments'")
    if (m.value) {
      const value = sourceAsync && isNode(m.value) && m.value[0] === '=>' ? ['async', m.value] : m.value
      walk(value, { ...cx, strict: true, classBody: true, privateNames: privateSet })
    }
  }
}

const exportEndsInDeclaration = node => {
  if (!isNode(node)) return false
  if (node[0] === 'export' || node[0] === 'default') return exportEndsInDeclaration(node[1])
  if (node[0] === 'async' && isNode(node[1])) return exportEndsInDeclaration(node[1])
  return node[0] === 'function' || node[0] === 'function*' || node[0] === 'class'
}

const validateModuleStatementBoundaries = (ast, source) => {
  const list = statements(ast)
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], next = list[i]
    if (!isNode(prev) || prev[0] !== 'export' || exportEndsInDeclaration(prev)) continue
    // Value literals retain their exact token offset. If one immediately
    // follows a semicolon-sensitive export form, the shared ASI layer may
    // split it into a sibling despite there being no legal insertion point.
    if (!isNode(next) || next[0] != null || typeof next.loc !== 'number') continue
    const boundary = previousSourceToken(source, next.loc)
    if (!boundary[1] && source[boundary[0]] !== ';')
      fail('export declaration and following literal require a semicolon or LineTerminator')
  }
}

const validateExports = ast => {
  const names = new Set(), locals = new Set(), localExports = new Set()
  const add = name => {
    if (name == null) return
    name = decodeIdentifier(name)
    if (names.has(name)) fail(`duplicate export '${name}'`)
    names.add(name)
  }
  const exported = (node, reexport = false) => {
    if (!isNode(node)) return
    const op = node[0]
    if (op === 'default') { add('default'); return }
    if (op === 'from') return exported(node[1], true)
    if (op === 'as') {
      add(node[2])
      if (!reexport && node[1] !== '*') localExports.add(decodeIdentifier(node[1]))
      return
    }
    if (op === '{}') {
      for (const item of patternItems(node)) {
        if (typeof item === 'string') { add(item); if (!reexport) localExports.add(decodeIdentifier(item)) }
        else if (isNode(item) && item[0] === 'as') {
          add(item[2]); if (!reexport && item[1] !== '*') localExports.add(decodeIdentifier(item[1]))
        }
      }
      return
    }
    const d = declaration(node)
    if (d) for (const name of d[D_NAMES]) add(name)
  }
  const scan = (node, depth = 0) => {
    if (!isNode(node)) return
    if (node[0] === ';') {
      for (let i = 1; i < node.length; i++) {
        if (i > 1 && isNode(node[i - 1]) && node[i - 1][0] === 'export' &&
            typeof node[i] === 'string' && node[i].includes('\\u') && decodeIdentifier(node[i]) === 'from')
          fail("contextual keyword 'from' cannot contain escapes")
        scan(node[i], depth)
      }
      return
    }
    if (node[0] === 'export') {
      if (depth) fail('export declaration must be at module top level')
      for (let i = 1; i < node.length; i++) {
        if (typeof node[i] === 'string' && node[i].includes('\\u') && decodeIdentifier(node[i]) === 'from')
          fail("contextual keyword 'from' cannot contain escapes")
        exported(node[i])
      }
      return
    }
    for (let i = 1; i < node.length; i++) scan(node[i], depth + 1)
  }
  const addImportSpec = spec => {
    if (isNode(spec) && spec[0] === 'from') return addImportSpec(spec[1])
    if (typeof spec === 'string') locals.add(decodeIdentifier(spec))
    else if (isNode(spec) && spec[0] === 'as') locals.add(decodeIdentifier(spec[2]))
    else if (isNode(spec) && spec[0] === '{}') for (const item of patternItems(spec))
      locals.add(decodeIdentifier(isNode(item) && item[0] === 'as' ? item[2] : item))
  }
  const collectImports = node => {
    if (!isNode(node)) return
    if (node[0] === 'import') { addImportSpec(node[1]); return }
    if (node[0] === 'from') { addImportSpec(node[1]); return }
    if (node[0] === ',') for (let i = 1; i < node.length; i++) collectImports(node[i])
  }
  for (const stmt of statements(ast)) {
    const d = declaration(stmt)
    if (d) for (const name of d[D_NAMES]) locals.add(decodeIdentifier(name))
    collectImports(stmt)
  }
  scan(ast)
  for (const name of localExports) if (!locals.has(name)) fail(`export '${name}' has no local binding`)
}

export function validateEarlyErrors(ast, source) {
  validateExports(ast)
  validateModuleStatementBoundaries(ast, source)
  // No `=>` boundary here (unlike `some`'s default): a nested arrow can still
  // contain top-level-only import/export syntax that hasn't been rejected yet.
  const rootModule = some(ast, n => n[0] === 'import' || n[0] === 'export', { skipArrow: false })

  const root = {
    // JZ's export declarations are an ABI surface over Script semantics; they
    // do not implicitly opt every nested function into Module strictness.
    strict: isUseStrict(ast), module: rootModule,
    functionDepth: 0, loop: 0, switchDepth: 0,
    labels: new Map(), async: false, generator: false, classBody: false,
  }
  let needsLexical = sourceHasLexicalRisk(source, root.strict)
  const hasRest = node => {
    if (!isNode(node)) return false
    if (node[0] === '...') return true
    for (let i = 1; i < node.length; i++) if (hasRest(node[i])) return true
    return false
  }

  // soleStmt: this call fills a single-Statement grammar slot (if/while/do/for
  // body, labeled-statement target) rather than a StatementList — Declaration
  // (let/const/class) is syntactically excluded from Statement, so it is
  // legal only when soleStmt is false (top-level, block contents, and for-
  // header init all reach walk() with soleStmt left at its default).
  const walk = (node, cx, statementPosition = false, soleStmt = false) => {
    if (!isNode(node)) return
    const op = node[0]
    if (op == null) return
    for (let i = 1; i < node.length; i++) {
      const value = node[i]
      if (op !== 'class' && typeof value === 'string' && value.startsWith('#') && !cx.privateNames?.has(value))
        fail(`private name '${value}' is not declared in this class`)
      // Escaped ReservedWords are still ReservedWords in IdentifierReference.
      // Property names use IdentifierName and are exempt.
      if (typeof value === 'string' && !(op === '.' && i === 2) && !(op === ':' && i === 1)) {
        if (cx.async && value === 'await') fail("'await' cannot be an identifier reference in an async function")
      }
      if (typeof value === 'string' && value.includes('\\u') && !(op === '.' && i === 2) && !(op === ':' && i === 1)) {
        const name = decodeIdentifier(value)
        if (ALWAYS_RESERVED.has(name) || cx.strict && (STRICT_RESERVED.has(name) || name === 'let' || name === 'yield') ||
            cx.async && name === 'await') fail(`escaped reserved word '${name}' cannot be an identifier reference`)
      }
    }

    // ExpressionStatement (and export-default's own AssignmentExpression
    // alternative — reached here too, since switch-default and export-
    // default's value share the 'default' tag/handler below, both walking
    // with statementPosition true) excludes a leading `function` token by
    // grammar lookahead — but ONLY anonymous `function(){}...` has no valid
    // fallback: a NAMED `function fn(){}...chain` still has a legal parse
    // (the FunctionDeclaration `function fn(){}` alone, with `...chain` as
    // a separate following statement) even though jessie itself does not
    // split it that way (confirmed live: `function fn(){}[];`, and even
    // `function f(){}\n\n(function(x){…})('outer')` across a blank line,
    // both merge into one expression in jessie's own AST) — rejecting the
    // named case would be unsound, a currently-PASSING construct that jz's
    // downstream pipeline already handles despite the odd parse. Only a
    // genuine access/call/tag CHAIN is suspect at all (length > 2 — a bare
    // `'()'` grouping is length 2 and always safe, `(function(){})()`'s
    // outer call unwraps to it and stops there, correctly staying accepted).
    if (statementPosition && isNode(node) && node.length > 2 &&
        (op === '.' || op === '[]' || op === '()' || op === '``' || op === '?.' || op === '?.[]' || op === '?.()')) {
      let start = node[1]
      while (isNode(start) && start.length > 2 &&
          (start[0] === '.' || start[0] === '[]' || start[0] === '()' || start[0] === '``' ||
           start[0] === '?.' || start[0] === '?.[]' || start[0] === '?.()'))
        start = start[1]
      if (isNode(start) && (start[0] === 'function' || start[0] === 'function*') && !start[1])
        fail('function expression cannot start a statement')
    }

    if (op === '.' && node[1] === 'super' && typeof node[2] === 'string' && node[2].startsWith('#'))
      fail('private field cannot be accessed through super')
    if (op === '.' && isNode(node[1]) && node[1][0] === 'new' && typeof node[2] === 'string' &&
        node[2].includes('\\u') && decodeIdentifier(node[2]) === 'target')
      fail("contextual keyword 'target' cannot contain escapes")

    if (op === '``') {
      let tag = node[1]
      while (isNode(tag) && (tag[0] === '.' || tag[0] === '[]' || tag[0] === '()')) tag = tag[1]
      if (isNode(tag) && (tag[0] === '?.' || tag[0] === '?.[]' || tag[0] === '?.()'))
        fail('optional chain cannot be used as a tagged template')
    }

    if (op === '//') {
      needsLexical = true
      validateRegExp(node[1] || '', node[2] || '')
      return
    }

    // Parentheses contain an Expression, never a statement list. Jessie uses
    // the same `';'` node for both and otherwise accepts `(a; b)`/`({};)`.
    if (op === '()' && node.length === 2 && isSeq(node[1]))
      fail('semicolon is not allowed in a parenthesized expression')

    // Arguments may have a trailing comma, but never an elision. Array
    // literals deliberately share the comma-list shape and remain exempt.
    if (op === '()' && node.length > 2 && isNode(node[2]) && node[2][0] === ',' &&
        node[2].slice(1).some(arg => arg == null))
      fail('call arguments cannot contain an elision')

    if (op === 'debugger') {
      if (!statementPosition) fail('debugger is only valid as a statement')
      return
    }

    // At statement start `{` is unconditionally a block. An operator with no
    // prefix-expression form cannot continue it (`{} * 1`, `{} = rhs`).
    // Operators such as `+`, `-`, `/`, `(` and `[` are intentionally absent:
    // each can begin a valid sibling statement immediately after a block.
    if (statementPosition && BLOCK_CANNOT_PREFIX.has(op) && leftEdgeIsObject(node))
      fail('block statement cannot be used as an expression operand')

    if (op === ';') {
      for (let i = 1; i < node.length; i++) {
        const stmt = node[i]
        if (stmt == null) continue
        if (typeof stmt === 'string') checkIdentifierRef(stmt, cx)
        else walk(stmt, cx, true)
      }
      return
    }
    if (op === 'case') {
      if (node[1] == null) fail('case clause requires an expression')
      walk(node[1], cx); walk(node[2], cx, true); return
    }
    if (op === 'default') { walk(node[1], cx, true); return }

    if (op === ':' && !statementPosition && isNode(node[2]) && node[2][0] === 'async' &&
        (methodSourceInfo(source, node.loc) & M_ASYNC_NL))
      fail("line terminator is not allowed between 'async' and an object method name")

    if (ASSIGN_OPS.has(op)) {
      const specialIdentifier = isNode(node[1]) && (
        (node[1][0] === 'yield' && !cx.strict && !cx.generator) ||
        node[1][0] === 'nan' ||
        (node[1][0] == null && typeof node[1][1] === 'number' && !Number.isFinite(node[1][1]))
      )
      if (!specialIdentifier && !isAssignmentTarget(node[1], op === '=')) fail(`invalid assignment target for '${op}'`)
      if (typeof node[1] === 'string' && ALWAYS_RESERVED.has(decodeIdentifier(node[1])))
        fail(`reserved word '${decodeIdentifier(node[1])}' cannot be assigned`)
      if (typeof node[1] === 'string' && cx.strict && (node[1] === 'eval' || node[1] === 'arguments'))
        fail(`cannot assign to '${node[1]}' in strict mode`)
      if (op === '=' && isNode(node[1]) && node[1].length === 2 &&
          (node[1][0] === '[]' || node[1][0] === '{}')) {
        if (patternHasTrailingRestComma(node[1], source, node.loc))
          fail('rest element in an assignment pattern cannot have a trailing comma')
        checkPattern(node[1], { ...cx, unique: false }, false)
        walk(node[2], cx)
        return
      }
    }
    if (op === '++' || op === '--') {
      const specialIdentifier = isNode(node[1]) && (node[1][0] === 'nan' ||
        (node[1][0] == null && typeof node[1][1] === 'number' && !Number.isFinite(node[1][1])))
      const asiStatement = isNode(node[1]) && (node[1][0] === 'switch' || node[1][0] === 'if')
      if (!specialIdentifier && !asiStatement && !isAssignmentTarget(node[1], false)) fail(`invalid update target for '${op}'`)
      // Postfix update has a hard no-LineTerminator restriction. Across a
      // newline it must instead be parsed as a new prefix update; if the
      // operator reaches a statement/final boundary, that fallback has no
      // operand and the program is invalid. Do not blanket-reject the newline:
      // `x\n++y` is valid (the AST currently cannot reconstruct its meaning).
      if (node.length > 2 && node[2] == null && typeof node.loc === 'number') {
        const prev = previousSourceToken(source, node.loc)
        if (prev[1]) {
          const next = nextSourceToken(source, node.loc + 2)
          if (next >= source.length || /[;})\],:]/.test(source[next]))
            fail(`line terminator before '${op}' leaves prefix update without an operand`)
        }
      }
    }

    if (op === 'await' && node[1] == null && (cx.async || cx.staticBlock))
      fail("'await' cannot be used as an identifier in this context")
    if (op === 'return' && cx.functionDepth === 0) fail('return outside a function')
    if (op === 'break') {
      const label = node[1]
      if (label != null ? !cx.labels.has(label) : !(cx.loop || cx.switchDepth))
        fail(label != null ? `unknown break label '${label}'` : 'break outside loop or switch')
    }
    if (op === 'continue') {
      const label = node[1]
      if (label != null ? cx.labels.get(label) !== 'loop' : !cx.loop)
        fail(label != null ? `continue label '${label}' does not name a loop` : 'continue outside a loop')
    }

    if (op === ':' && statementPosition && typeof node[1] === 'string') {
      if (cx.labels.has(node[1])) fail(`duplicate label '${node[1]}'`)
      const labels = new Map(cx.labels)
      labels.set(node[1], isIteration(node[2]) ? 'loop' : 'other')
      walk(node[2], { ...cx, labels }, true, true)
      return
    }

    if (op === 'function' || op === 'function*') {
      const generator = op === 'function*'
      const body = node[3]
      const ownStrict = isUseStrict(body)
      const strict = cx.strict || ownStrict
      // GeneratorExpression's own BindingIdentifier is parameterized [+Yield]
      // UNCONDITIONALLY (its own generator-ness) — `var g = function*
      // yield(){}` is forbidden even in sloppy, non-generator-enclosing
      // context. GeneratorDeclaration's BindingIdentifier instead INHERITS
      // the ENCLOSING scope's [Yield] (cx.generator, not this function's
      // own) — `function* yield(){}` as a plain top-level declaration is
      // fine outside a generator, forbidden nested inside one — confirmed
      // live against test262 (yield-as-generator-declaration-binding-
      // identifier.js requires the top-level-declaration case to pass).
      // statementPosition is jz's structural proxy for "declaration, not
      // expression" here — a `function`/`function*` node only reaches this
      // handler with it true from a StatementList slot.
      if (typeof node[1] === 'string' && node[1])
        checkBindingName(node[1], { ...cx, strict, generator: statementPosition ? cx.generator : generator })
      const params = paramsOf(node[2])
      if (params.some(hasRest)) needsLexical = true
      const simple = isSimpleParams(params)
      if (ownStrict && !simple) fail("'use strict' is forbidden with non-simple parameters")
      if (ownStrict) validateStrictDirectivePrologue(source, functionBodyOpen(source, node))
      const names = []
      for (let i = 0; i < params.length; i++) {
        const p = params[i]
        if (isNode(p) && p[0] === '...' && i !== params.length - 1) fail('rest parameter must be last')
        const paramCx = { ...cx, strict, generator, inGeneratorParams: generator }
        names.push(...checkPattern(p, { ...paramCx, unique: false }))
        visitPatternInitializers(p, paramCx, walk)
      }
      const dup = duplicateName(names)
      if (dup && (strict || !simple)) fail(`duplicate parameter '${dup}'`)
      const fnBody = body
      const fnCx = { ...cx, strict, generator, async: false, functionDepth: cx.functionDepth + 1,
        loop: 0, switchDepth: 0, labels: new Map() }
      validateScopeNames(fnBody, fnCx, 'function', names)
      walk(fnBody, fnCx, true)
      return
    }

    if (op === '=>' || (op === 'async' && isNode(node[1]) && node[1][0] === '=>')) {
      const arrow = op === 'async' ? node[1] : node
      const isAsync = op === 'async'
      if (isAsync && typeof node.loc === 'number') {
        const firstFormal = nextSourceToken(source, node.loc + 5)
        if (previousSourceToken(source, firstFormal)[1])
          fail("line terminator is not allowed between 'async' and arrow parameters")
      }
      if (!isAsync && isNode(arrow[1]) && arrow[1][0] === '()' && arrow[1].length > 2 &&
          typeof arrow[1][1] === 'string' && arrow[1][1].includes('\\u') &&
          decodeIdentifier(arrow[1][1]) === 'async')
        fail("escaped contextual keyword 'async' cannot introduce arrow parameters")
      const params = paramsOf(arrow[1]), body = arrow[2]
      // A leading `{` after `=>` is always the function body, never an object
      // literal concise body. Jessie can absorb a following operator into that
      // body (`() => {} = 1`); only explicit parens may choose the expression.
      if (isNode(body) && body[0] !== '{}' && leftEdgeIsObject(body))
        fail('arrow function block cannot continue as an expression')
      if (params.some(hasRest)) needsLexical = true
      const fnBody = isNode(body) && body[0] === '{}' ? body[1] : body
      const ownStrict = isUseStrict(fnBody)
      const strict = cx.strict || ownStrict
      if (ownStrict && !isSimpleParams(params)) fail("'use strict' is forbidden with non-simple parameters")
      if (ownStrict && isNode(body) && body[0] === '{}')
        validateStrictDirectivePrologue(source, body.loc)
      const names = []
      for (let i = 0; i < params.length; i++) {
        const p = params[i]
        if (isNode(p) && p[0] === '...' && i !== params.length - 1) fail('rest parameter must be last')
        const paramCx = { ...cx, strict, async: isAsync || cx.inAsyncParams, inAsyncParams: isAsync || cx.inAsyncParams }
        names.push(...checkPattern(p, { ...paramCx, unique: false }))
        visitPatternInitializers(p, paramCx, walk)
      }
      const dup = duplicateName(names)
      if (dup) fail(`duplicate arrow parameter '${dup}'`)
      const fnCx = { ...cx, strict, async: isAsync, generator: false, functionDepth: cx.functionDepth + 1,
        loop: 0, switchDepth: 0, labels: new Map() }
      validateScopeNames(fnBody, fnCx, 'function', names)
      walk(fnBody, fnCx, true)
      return
    }

    if (op === 'async' && isNode(node[1]) && (node[1][0] === 'function' || node[1][0] === 'function*')) {
      // Validate through the ordinary function arm with async restrictions on names.
      const fn = node[1]
      const body = fn[3], ownStrict = isUseStrict(body), strict = cx.strict || ownStrict, generator = fn[0] === 'function*'
      if (body === 'await') fail('await expression requires an operand')
      if (typeof fn[1] === 'string' && fn[1]) checkBindingName(fn[1], { ...cx, strict, async: true, generator })
      const params = paramsOf(fn[2]), names = []
      if (params.some(hasRest)) needsLexical = true
      for (let i = 0; i < params.length; i++) {
        const paramCx = { ...cx, strict, async: true, generator, inAsyncParams: true, inGeneratorParams: generator }
        names.push(...checkPattern(params[i], { ...paramCx, unique: false }))
        visitPatternInitializers(params[i], paramCx, walk)
      }
      const dup = duplicateName(names)
      if (ownStrict && !isSimpleParams(params)) fail("'use strict' is forbidden with non-simple parameters")
      if (ownStrict) validateStrictDirectivePrologue(source, functionBodyOpen(source, fn))
      if (dup && (strict || !isSimpleParams(params))) fail(`duplicate parameter '${dup}'`)
      const fnBody = body
      const fnCx = { ...cx, strict, async: true, generator, functionDepth: cx.functionDepth + 1,
        loop: 0, switchDepth: 0, labels: new Map() }
      validateScopeNames(fnBody, fnCx, 'function', names)
      walk(fnBody, fnCx, true)
      return
    }

    if (op === 'get' || op === 'set') {
      const params = paramsOf(node[2]), names = []
      for (const p of params) names.push(...checkPattern(p, { ...cx, unique: false }))
      if (op === 'get' && names.length) fail('getter must have no parameters')
      if (op === 'set' && names.length !== 1) fail('setter must have exactly one parameter')
      const body = node[3]
      validateScopeNames(body, cx, 'function', names)
      walk(body, { ...cx, functionDepth: cx.functionDepth + 1, loop: 0, switchDepth: 0, labels: new Map() }, true)
      return
    }

    if (op === 'using' || op === 'await' && isNode(node[1]) && node[1][0] === 'using') {
      const decl = op === 'using' ? node : node[1]
      if (cx.functionDepth === 0 && !cx.module) fail('using declaration is not allowed at Script top level')
      for (let i = 1; i < decl.length; i++) {
        const d = decl[i]
        if (!isNode(d) || d[0] !== '=' || typeof d[1] !== 'string')
          fail('using declaration requires an initialized identifier binding')
        checkBindingName(d[1], { ...cx, lexical: true })
        walk(d[2], cx)
      }
      return
    }

    if (op === 'class') {
      if (soleStmt) fail('class declaration requires a block in statement position')
      needsLexical = true
      validateClass(node, cx, walk, source)
      if (node[2]) walk(node[2], cx)
      return
    }

    if (op === 'let' || op === 'const' || op === 'var') {
      // Declaration is excluded from the single-Statement grammar slot
      // (if/while/do/for body, label target) — but 'let' is not unconditionally
      // fatal there the way 'const'/'class' are: unlike those two, "let" is a
      // valid plain IdentifierReference in sloppy code, so `let` alone,
      // followed by a genuine LineTerminator, can ASI-split into a bare
      // reference statement plus a separate (unrelated) following statement
      // — confirmed live (`if (false) let\nx = 1;`, `if (false) let\n{}` both
      // parse as attempted declarations here but ARE valid programs; jz's
      // parser does not model the ASI split, so early-errors must not
      // require it). The one shape with no such escape hatch is `let [`:
      // ExpressionStatement's own grammar excludes that exact two-token
      // sequence unconditionally (no "[no LineTerminator here]" on it), so
      // it has no valid parse in this position regardless of what follows.
      if (op === 'const' && soleStmt) fail('lexical declaration requires a block in statement position')
      if (op === 'let' && soleStmt) {
        const first = isNode(node[1]) && node[1][0] === '=' ? node[1][1] : node[1]
        if (isNode(first) && first[0] === '[]') fail('lexical declaration requires a block in statement position')
      }
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        const initialized = isNode(d) && d[0] === '='
        const pattern = initialized ? d[1] : d
        if (op === 'const' && !initialized && !cx.forBinding) fail('const declaration requires an initializer')
        checkPattern(pattern, { ...cx, lexical: op !== 'var', unique: op !== 'var' })
        visitPatternInitializers(pattern, cx, walk)
        if (initialized) walk(d[2], cx)
      }
      return
    }

    if (op === 'export' || op === 'import' || op === 'from') {
      // An import/export specifier list (`{ a, b as c }`) reuses the `'{}'`
      // tag but is a different grammar production (ImportsList/ExportsList)
      // from an object literal — `as`-renaming is never valid inside a real
      // object literal, so walking a specifier list through the
      // object-literal validator below would wrongly flag ordinary
      // `import {x as y} from '...'`. validateExports() (run once, up front)
      // already covers export-name structural soundness; import/export
      // specifier identifiers need no further walk. Every other child
      // (an `export` declaration, `export default`'s value, the module-path
      // string, a namespace `as` rename, a bare `*`) is unaffected and still
      // reaches its normal handler.
      for (let i = 1; i < node.length; i++) {
        const child = node[i]
        if (!(isNode(child) && child[0] === '{}')) walk(child, cx, false)
      }
      return
    }

    if (op === '{}') {
      if (statementPosition) {
        validateScopeNames(node[1], cx, 'block')
        walk(node[1], cx, true)
      } else {
        let proto = 0
        for (const item of objectLiteralItems(node)) {
          if (isNode(item) && item[0] === ':' && (item[1] === '__proto__' ||
              isNode(item[1]) && item[1][0] == null && item[1][1] === '__proto__')) proto++
          if (proto > 1) fail("duplicate '__proto__' data property")
          // Allowlist, not a blocklist: a bare object-literal item is only
          // ever a `key: value`/method pair, a spread, or (rejected later,
          // with its own message, by prepare/index.js) a getter/setter — any
          // other shape (`=`-initialized shorthand, a literal value marker
          // like a number/boolean/nan, a bracketed computed-name attempt
          // missing its `: value`, `;`-joined content) is invalid.
          if (isNode(item) && item[0] !== ':' && item[0] !== '...' && item[0] !== 'get' && item[0] !== 'set')
            fail('invalid object literal shorthand/initialized name')
          if (typeof item === 'string') checkBindingName(item, cx)
          walk(item, cx)
        }
      }
      return
    }

    if (op === 'switch') {
      if (node[1] == null) fail('switch requires an expression')
      const all = []
      let defaults = 0
      for (let i = 2; i < node.length; i++) {
        const c = node[i]
        if (!isNode(c)) continue
        if (c[0] === 'default') defaults++
        if (defaults > 1) fail('switch cannot contain multiple default clauses')
        const body = c[0] === 'case' ? c[2] : c[1]
        all.push(...statements(body))
      }
      validateScopeNames([';', ...all], cx, 'switch')
      for (let i = 2; i < node.length; i++) walk(node[i], { ...cx, switchDepth: cx.switchDepth + 1 }, true)
      walk(node[1], cx)
      return
    }

    if (op === 'for' || op === 'for await') {
      const head = node[1]
      if (head == null || isNode(head) && head[0] === ';' && head.length !== 4) needsLexical = true
      // NOTE: a head shape/length check was attempted here (reject anything
      // that isn't a 4-element `;`-sequence or an 'in'/'of' node) to catch
      // jessie's missing [~In] grammar restriction (`for (let x = 3 in {})`
      // parses `3 in {}` as one expression instead of stopping before `in`,
      // producing a bare, unwrapped 'let' head) — reverted: when every OTHER
      // clause is empty, jessie's own trailing-newline-sensitive clause
      // parsing collapses a VALID single-clause-with-content head (e.g.
      // `for(let x = 3\n;\n;\n)`, `for(false\n;\n;\n)`) to the exact same
      // bare, unwrapped shape as the invalid NoIn-misparse case — the AST
      // carries no source position to tell them apart. Confirmed by direct
      // A/B against dozens of newline placements, not a guess.
      const next = { ...cx, loop: cx.loop + 1 }
      if (isNode(head) && (head[0] === 'in' || head[0] === 'of')) {
        const lhs = head[1]
        // NOTE: a checkIdentifierRef(lhs, cx) call belongs here too (closing
        // test262's identifier-let-allowed-as-lefthandside-expression-
        // strict.js — strict-mode `for (let in o)`) and is sound natively
        // (verified), but reverted: the self-compiled kernel accepts it
        // regardless (confirmed via test/kernel-target.js direct calls, not
        // a guess) — a genuine native/kernel divergence, not a logic bug in
        // this file (checkIdentifierRef's other two call sites, statement-
        // position, are confirmed correct in-kernel; restructuring this one
        // out of its if/else-if chain into a standalone check first did not
        // change the outcome either). Left reverted rather than shipping a
        // mismatch against STABILITY.md's "natively and in jz.wasm" claim;
        // root-causing which val-fact the self-hosted compiler mistrusts
        // here is compiler-internals work outside this pass's scope.
        if (isNode(lhs) && (lhs[0] === 'let' || lhs[0] === 'const' || lhs[0] === 'var')) {
          if (lhs.length !== 2 || isNode(lhs[1]) && lhs[1][0] === '=')
            fail('for-in/of declaration must have one uninitialized binding')
          if (lhs[0] !== 'var' && boundNames(lhs[1]).some(name => decodeIdentifier(name) === 'let'))
            fail("for-in/of lexical declaration cannot bind 'let'")
          walk(lhs, { ...cx, forBinding: true })
        } else if (isNode(lhs) && lhs.length === 2 && (lhs[0] === '[]' || lhs[0] === '{}')) {
          if (patternHasTrailingRestComma(lhs, source, head.loc))
            fail('rest element in a for-in/of assignment pattern cannot have a trailing comma')
          checkPattern(lhs, { ...cx, unique: false }, false)
        } else if (!isAssignmentTarget(lhs, true)) fail('invalid for-in/of assignment target')
        if (head[2] == null) fail('for-in/of requires a right-hand expression')
        // for-of's source is an AssignmentExpression (no bare comma allowed —
        // `for (x of a, b)` needs parens); for-in's source is a full
        // Expression, where a top-level comma is legal.
        if (head[0] === 'of' && isNode(head[2]) && head[2][0] === ',')
          fail('for-of iteration expression cannot be an unparenthesized comma expression')
        walk(head[2], cx)
      } else if (isSeq(head)) {
        // A classic for header's three slots are expression/declaration
        // grammar, not a StatementList. Walking the shared `';'` node through
        // its ordinary handler marks every child statement-position and turns
        // an invalid block in init/test/update into an accepted block statement.
        for (let i = 1; i < head.length; i++) {
          if (typeof head[i] === 'string') checkIdentifierRef(head[i], cx)
          else walk(head[i], cx, false)
        }
      } else walk(head, cx)
      if (declaration(node[2])) needsLexical = true
      walk(node[2], next, true, true)
      return
    }
    if (op === 'while') {
      if (declaration(node[2])) needsLexical = true
      if (node[1] == null) fail('while requires an expression')
      walk(node[1], cx)
      walk(node[2], { ...cx, loop: cx.loop + 1 }, true, true)
      return
    }
    if (op === 'do') {
      if (declaration(node[1])) needsLexical = true
      walk(node[1], { ...cx, loop: cx.loop + 1 }, true, true)
      walk(node[2], cx)
      return
    }

    if (op === 'try') {
      needsLexical = true
      for (let i = 1; i < node.length; i++) {
        const part = node[i]
        if (isNode(part) && part[0] === 'catch') {
          const names = checkPattern(part[1], { ...cx, lexical: true, unique: true })
          validateScopeNames(part[2], cx, 'block', names)
          walk(part[2], cx, true)
        } else walk(part, cx, true)
      }
      return
    }

    if (statementPosition && (op === 'if')) {
      if (declaration(node[2]) || declaration(node[3])) needsLexical = true
      if (node[1] == null) fail('if requires an expression')
      walk(node[1], cx)
      walk(node[2], cx, true, true)
      if (node[3]) walk(node[3], cx, true, true)
      return
    }

    for (let i = 1; i < node.length; i++) walk(node[i], cx, false)
  }

  if (typeof ast === 'string') {
    const name = decodeIdentifier(ast)
    if (ALWAYS_RESERVED.has(name)) fail(`escaped reserved word '${name}' cannot be an identifier reference`)
  }
  validateScopeNames(ast, root, 'global')
  for (const stmt of statements(ast)) {
    if (typeof stmt === 'string') checkIdentifierRef(stmt, root)
    else walk(stmt, root, true)
  }
  if (needsLexical) validateLexicalSource(source, root.strict)
  return ast
}
