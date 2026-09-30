/**
 * jz's parser entry — subscript's Jessie dialect with source-text and literal adapters.
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
import { lookup, idx, cur, skip, err, prec, seek, expr, word } from 'subscript/parse'
import { fromRadixDigits, toDecimalString, truncateLimbs } from './bignum.js'
import { validateEarlyErrors } from './early-errors.js'
import { here, where } from './ctx.js'
import { asciiPart, idStart, idPart, lineEnd, isSpace } from './unicode.js'

// IdentifierName (§12.7). subscript takes every code unit from U+00C0 but ×
// and ÷ for a name character: it missed ª µ º (ID_Start) and · (ID_Continue),
// and took whitespace, line terminators, symbols and punctuation for letters.
// parse.id answers the length of the name character at idx, 0 when there is
// none: an ASCII letter, digit, `$` or `_`; a `\uXXXX` or `\u{X…}` escape; a
// code point of ID_Start, or of ID_Continue where a name continues; an astral
// one as its surrogate pair. Asked about another position (the character
// after a keyword), it answers whether that code unit can continue a name.
const hex = c => c >= 48 && c <= 57 ? c - 48 : (c |= 32) >= 97 && c <= 102 ? c - 87 : -1
const high = c => c >= 0xd800 && c <= 0xdbff, low = c => c >= 0xdc00 && c <= 0xdfff
const pair = (h, l) => (h - 0xd800) * 1024 + l - 0xdc00 + 0x10000
// The escape at i: its length, its code point left in escCp; 0 when it is none.
let escCp = 0
const escapeAt = (i) => {
  if (cur.charCodeAt(i + 1) !== 117) return 0
  let n = i + 2, cp = 0, h
  if (cur.charCodeAt(n) === 123) {
    while ((h = hex(cur.charCodeAt(++n))) >= 0) if ((cp = cp * 16 + h) > 0x10ffff) return 0
    if (n === i + 3 || cur.charCodeAt(n) !== 125) return 0
    escCp = cp
    return n - i + 1
  }
  for (let k = 0; k < 4; k++) { if ((h = hex(cur.charCodeAt(n + k))) < 0) return 0; cp = cp * 16 + h }
  escCp = cp
  return 6
}
// Whether the code unit before i ends a name character: a name continues at i.
const continues = (i) => {
  const c = cur.charCodeAt(i - 1)
  if (c === 125) {   // `}` closing a `\u{X…}` escape
    let j = i - 2
    while (hex(cur.charCodeAt(j)) >= 0) j--
    return cur.charCodeAt(j) === 123 && cur.charCodeAt(j - 1) === 117 && cur.charCodeAt(j - 2) === 92
  }
  if (low(c)) return high(cur.charCodeAt(i - 2)) && idPart(pair(cur.charCodeAt(i - 2), c))
  return i > 0 && idPart(c)
}
// A character that cannot begin a name (a digit, a combining mark) stands only where one continues.
const nameChar = (cp, i, len) => idStart(cp) || idPart(cp) && continues(i) ? len : 0
const escapedChar = (i) => { const len = escapeAt(i); return len ? nameChar(escCp, i, len) : 0 }
jessieParse.id = c => {
  if (c < 128) return asciiPart(c) ? 1 : c !== 92 ? 0 : cur.charCodeAt(idx) === 92 ? escapedChar(idx) : 1
  if (c !== cur.charCodeAt(idx)) return high(c) || idPart(c) ? 1 : 0
  if (high(c)) return low(cur.charCodeAt(idx + 1)) ? nameChar(pair(c, cur.charCodeAt(idx + 1)), idx, 2) : 0
  return nameChar(c, idx, 1)
}

// WhiteSpace, LineTerminator and comments (§12.2–12.4). subscript's core skips
// every code unit up to U+0020 (controls too), comment.js ends a `//` comment
// at LF alone, and the ASI layer (feature/asi.js) flags a line break for LF
// alone. The layer on top owns the comments (comment.js keeps none), skips the
// space separators, NBSP, ZWNBSP, LS and PS, refuses a control character, and
// flags `parse.newline` for a CR, LS or PS, and for a line terminator inside a
// block comment, for the restricted productions (`break\rL` is two
// statements). It keeps the gap before the token it stops at: where the gap
// began (the end of the token before) and whether a line terminator is in it.
// A zero-argument wrapper: the kernel rejects a spread into asi.js's
// fixed-arity space.
jessieParse.comment = {}
let gapFrom = -1, gapEnd = -1, gapLine = false
const asiSpace = jessieParse.space
jessieParse.space = () => {
  const start = idx
  let line = false
  for (;;) {
    const from = idx
    const cc = asiSpace()
    for (let i = from; i < idx; i++) {
      const c = cur.charCodeAt(i)
      if (lineEnd(c)) { line = true; if (c === 13) jessieParse.newline = true }
      else if (c !== 59 && !isSpace(c)) err('Unexpected character', i)
    }
    if (cc === 47 && cur.charCodeAt(idx + 1) === 47) {
      let i = idx + 2
      while (i < cur.length && !lineEnd(cur.charCodeAt(i))) i++
      seek(i)
    } else if (cc === 47 && cur.charCodeAt(idx + 1) === 42) {
      // an unterminated one runs to the end; the early errors name it
      const close = cur.indexOf('*/', idx + 2), end = close < 0 ? cur.length : close
      for (let i = idx + 2; i < end; i++) if (lineEnd(cur.charCodeAt(i))) { jessieParse.newline = line = true; break }
      seek(close < 0 ? end : end + 2)
    } else if (cc >= 0xa0 && isSpace(cc)) {
      if (cc === 0x2028 || cc === 0x2029) jessieParse.newline = line = true
      skip()
    } else {
      if (idx > start) { gapFrom = start; gapEnd = idx; gapLine = line }
      return cc
    }
  }
}

// Statement separation (§12.10): a statement that ends in an expression or a
// declarator needs `;` before the next one, or a line terminator between. The
// ASI layer splits two statements wherever its line flag is up, and the flag
// stays up past the line that raised it and goes up at every `}`: `a = b c`
// after any line break, `x = () => {} y` and `debugger(x)` each read as two
// statements. A split stands when a line terminator precedes the next
// statement, or when the statement before ended itself: with the `}` of a
// block, a declaration, a try or switch, or a control statement's braced body,
// or with the `)` of a do-while. Bodies come unwrapped from their braces, so
// the enter/exit hooks keep where the brace group closed last opened: a body
// lying past it was braced.
const opens = [], groups = []
let closedOpen = -1, closedAt = -1, groupDepth = 0, declDepth = -1, arrowDepth = -1, classDepth = -1
const asiEnter = jessieParse.enter, asiExit = jessieParse.exit
jessieParse.enter = (p, end) => {
  asiEnter()
  if (end) { groups.push(end); groupDepth++ }
  else { groups.length = 0; groupDepth = 0; declDepth = arrowDepth = classDepth = -1 }
  if (end === 125) opens.push(idx - 1)
}
jessieParse.exit = (p, end) => {
  asiExit(p, end)
  if (end) { groups.pop(); groupDepth-- }
  if (end === 125) { closedOpen = opens.length ? opens.pop() : -1; closedAt = idx - 1 }
}
// switch.js consumes its body's braces itself and fires only the exit: a mark
// stands for the opening the exit takes.
const switchOp = lookup[115]?.ops?.find(d => d.op === 'switch')
if (switchOp) {
  const parseSwitch = switchOp.map
  switchOp.map = (a) => {
    opens.push(-1)
    const depth = opens.length, outer = groupDepth
    groups.push(125); groupDepth++
    try {
      const r = parseSwitch(a)
      if (opens.length === depth) opens.pop()
      return r
    } finally { groups.length = groupDepth = outer }
  }
}
// The least source position in a node, Infinity where none is kept.
const firstLoc = (n) => {
  if (!Array.isArray(n)) return Infinity
  let at = typeof n.loc === 'number' ? n.loc : Infinity
  for (let i = 1; i < n.length; i++) { const c = firstLoc(n[i]); if (c < at) at = c }
  return at
}
const CONTROL = new Set(['if', 'for', 'for await', 'while', 'with', ':'])
const bodyOf = st => st[0] === 'if' && st.length > 3 ? st[3] : st[2]
const isFn = n => Array.isArray(n) && (n[0] === 'function' || n[0] === 'function*' || n[0] === 'class' ||
  n[0] === 'async' && Array.isArray(n[1]) && (n[1][0] === 'function' || n[1][0] === 'function*'))
// Whether statement `st` ended with the `}` of the brace group opened at `open`.
// A class member splits like a statement: a method or accessor ends in its body.
const endsInBrace = (st, open) => {
  for (;;) {
    if (!Array.isArray(st)) return true   // no brace of its own: the braces were a body's around it
    const op = st[0]
    if (op === '{}' || op === 'try' || op === 'switch' || op === 'get' || op === 'set' || isFn(st)) return true
    if (op === 'static') { st = st[1]; continue }
    if (op === 'export') return isFn(st[1]) || Array.isArray(st[1]) && st[1][0] === 'default' && isFn(st[1][1])
    if (!CONTROL.has(op)) return false
    st = bodyOf(st)
    if (st == null || firstLoc(st) > open) return true   // an empty or braced body
  }
}
// Whether statement `st` ended with the `)` of a do-while (ASI inserts `;` after it on one line).
const endsInDo = (st) => {
  for (;;) {
    if (!Array.isArray(st)) return false
    if (st[0] === 'do') return true
    if (!CONTROL.has(st[0])) return false
    st = bodyOf(st)
  }
}
// Where the token before the one at `at` ends: -1 behind a line terminator,
// -2 where the gap was skipped before a backtrack and is not known here.
const endBefore = (at) => {
  if (gapEnd === at) return gapLine ? -1 : gapFrom - 1
  const c = cur.charCodeAt(at - 1)
  return isSpace(c) || c === 47 ? -2 : at - 1
}
// Whether statement `st`, whose last token ends at `end` (endBefore), stands
// apart from the next; `closed`/`open` are the brace group closed last then. A
// `}` the hooks did not see close (none is known) cannot be told apart: it stands.
const separated = (st, end, closed, open) => {
  if (end < 0) return true
  const prev = cur.charCodeAt(end)
  if (prev === 41) return endsInDo(st)
  return prev === 125 && (end !== closed || endsInBrace(st, open))
}
// A postfix `++`/`--` takes no line terminator before it (§15.13, a restricted
// production), and no statement ends in one. After either the `++` starts the
// next statement: `x`, a line break, `++y` is `x; ++y`, which the ASI layer
// read as `x++; y`.
const prefixOnly = (st, at, cc) => {
  if (cur.charCodeAt(at + 1) !== cc) return false
  const end = endBefore(at)
  return end === -1 || end >= 0 && end === closedAt && cur.charCodeAt(end) === 125 && endsInBrace(st, closedOpen)
}
// Statements meet in two places: where the ASI layer splits one off at the
// statement level, and where a statement body parsed at `body` precedence (a
// control statement's, a case's) ends and its caller reads on, a new case
// statement or the `while` of a do-while. The first place two meet unseparated
// is kept, and reported once the early errors had their say: theirs name the
// fault more precisely where they apply (`if (a) x = 1 else …`).
// A statement that begins at the statement-list level (`lvl`) owes nothing to
// the `;` before it: the ASI layer's `;`-then-line-break flag, left up by an
// empty statement, would end its operands (`;` LF `return 1` returned nothing).
// A template after a tag reads the layer's line flag, which stays up past the
// line that raised it: a tag on any later line lost its template (`f` then
// `` `x` `` read as two statements). There the flag answers for the gap before
// the template: a line terminator, or the `}` of the group closed last. Other
// splits the stale flag makes stay, for the early errors to name first.
let joinedAt = -1

// A label heads any statement (§14.13). subscript's handler takes the control
// keywords, and the property `:` reads the rest as an expression, where a
// statement keyword is a name: `L: var x = 1` read `L: var` then `x = 1`.
const LABELED = ['var', 'return', 'throw', 'break', 'continue', 'debugger', 'with']
token(':', 19, a => typeof a === 'string' && (jessieParse.space(), LABELED.some(w => word(w))) && [':', a, expr(lvl)])   // the property `:`'s precedence

// An escaped name means its decoded one (§12.7.1): `\u0061` and `a` are one
// binding, `o.\u{62}` reads `b`. Early errors read the raw spelling first (an
// escaped keyword is no keyword); every later stage sees the decoded name.
// Literal values `[, v]` and regular expressions keep their text.
const IDESC = /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g
const decodeIdent = s => s.includes('\\u')
  ? s.replace(IDESC, (_, b, p) => String.fromCodePoint(parseInt(b || p, 16)))
  : s
const decodeNames = node => {
  if (!Array.isArray(node) || node[0] == null || node[0] === '//') return
  for (let i = 1; i < node.length; i++) {
    const v = node[i]
    if (typeof v === 'string') node[i] = decodeIdent(v)
    else decodeNames(v)
  }
}

// A statement list is read by one call, a statement per pass. subscript's
// (feature/asi.js) reads the statements after a boundary by a call inside the
// call that read the statement before, so its depth is the count of statements,
// which it caps at 2000: a block met at that depth does not close (`Unclosed {`),
// and a library bundled into one file does not parse. Here the call reads each
// statement at a precedence of its own (`ONE`: between a block's and `;`, so it
// admits what subscript's `lvl - .5` admits), and the boundary after the
// statement, reached from that expr, only notes that another follows (`more`).
// The depth of a parse is then the nesting of its source. The step is
// subscript's, over this list; the trees are the same, node for node.
const LVL = prec.asi ?? prec[';'], ONE = LVL - .25, STMT = (prec[';'] ?? 5) + 1
const baseStep = jessieParse._baseStep
const isNode = a => Array.isArray(a) || typeof a === 'string'
const isMethod = n => Array.isArray(n) && (n[0] === ':' && isFn(n[2]) || n[0] === 'get' || n[0] === 'set' ||
  (n[0] === 'static' || n[0] === 'async') && isMethod(n[1]))
const isStmt = n => Array.isArray(n) && (prec[n[0]] <= STMT || (n[0] === '{}' && isStmt(n[1])) ||
  groupDepth === classDepth && isMethod(n))
// A class method ends at its body, even before a computed member on the same
// line. The identical property form in an object literal still needs a comma.
const readClass = lookup[99]
lookup[99] = (a, p, op) => {
  if (a || !word('class')) return readClass(a, p, op)
  const outer = classDepth
  classDepth = groupDepth + 1
  try { return readClass(a, p, op) } finally { classDepth = outer }
}
// A declaration with no initializer ends before a new-line expression:
// `let a\n(x)` is two statements. Initializers and ordinary expressions keep
// call/index continuations across any line terminator. Group depth prevents
// a comma inside an initializer's argument list from looking like a binding.
for (const name of ['let', 'const', 'var']) {
  const c = name.charCodeAt(0), read = lookup[c]
  lookup[c] = (a, p, op) => {
    if (a || !word(name)) return read(a, p, op)
    const outer = declDepth
    declDepth = groupDepth
    try { return read(a, p, op) } finally { declDepth = outer }
  }
}
const arrowRule = lookup[61].ops.find(d => d.op === '=>'), readArrow = arrowRule.map
arrowRule.map = a => {
  const outer = arrowDepth
  arrowDepth = jessieParse.space() === 123 ? groupDepth : -1
  try { return readArrow(a) } finally { arrowDepth = outer }
}
// A block-bodied arrow is complete before the next line's expression. Its
// braces are a body, whereas an object literal can still be called/indexed.
const endsInArrow = a => {
  if (!Array.isArray(a)) return false
  if (a[0] === 'async') return endsInArrow(a[1])
  if (a[0] === '=' || a[0] === ',') return endsInArrow(a[a.length - 1])
  return a[0] === '=>' && a[2]?.[0] === '{}' || a[0] === '{}' && arrowDepth === groupDepth
}
const bareDeclarator = (a, p) => declDepth === groupDepth && (p === prec[','] - 1 || p === prec[',']) &&
  typeof (Array.isArray(a) && a[0] === ',' ? a[a.length - 1] : a) === 'string'
let more = false
const asi = (a, p, expr) => {
  if (p >= LVL) return
  if (p === ONE) { more = true; return }
  let list = Array.isArray(a) && a[0] === ';' ? a : null
  const was = list ? list.length : 0
  do {
    more = jessieParse.semi = false
    // a handler that answers without consuming (switch's `case` inside its body) ends the list
    const from = idx
    const b = expr(ONE)
    if (!b || idx === from) break
    if (!list) list = [';', a]
    if (Array.isArray(b) && b[0] === ';') for (let i = 1; i < b.length; i++) list.push(b[i])
    else list.push(b)
  } while (more)
  if (list && list.length > was) return list
}
jessieParse.asi = asi
jessieParse.step = (a, p, cc, expr) => {
  if (jessieParse.semi && p >= LVL) return false
  if (a && !isNode(a)) return null
  if (isNode(a)) {
    const continuation = cc === 91 || cc === 40 || cc === 96
    if (continuation && endBefore(idx) === -1 && (bareDeclarator(a, p) || endsInArrow(a))) return asi(a, p, expr) ?? null
    if (jessieParse.semi || (cc === 91 || cc === 40) && isStmt(a))
      return asi(a, p, expr) ?? null
  }
  const nl = jessieParse.newline
  return baseStep(a, p, cc, expr) ?? (isNode(a) && nl ? asi(a, p, expr) ?? null : null)
}

const lvl = prec.asi ?? prec[';'], body = lvl + .5
const asiStep = jessieParse.step
jessieParse.step = (a, p, cc, expr) => {
  if (!Array.isArray(a) && typeof a !== 'string') { if (p < lvl) jessieParse.semi = false; return asiStep(a, p, cc, expr) }
  const list = a[0] === ';' && Array.isArray(a), n = list ? a.length : 0, last = list ? a[n - 1] : a, at = idx
  if ((cc === 43 || cc === 45) && prefixOnly(last, at, cc)) return jessieParse.asi(a, p, expr) ?? null
  // the gap before this token, read before a split parses on past it
  const end = endBefore(at), closed = closedAt, open = closedOpen
  if (cc === 96 && end !== -2) jessieParse.newline = isStmt(last) ||
    end === -1 && (bareDeclarator(last, p) || endsInArrow(last)) ||
    p < lvl && groups.at(-1) !== 41 && groups.at(-1) !== 93 && closed >= 0 &&
    (end === -1 ? gapFrom - 1 : end) === closed && cur.charCodeAt(closed) === 125 && endsInBrace(last, open)
  const semi = jessieParse.semi, wasMore = more
  const r = asiStep(a, p, cc, expr)
  // the list layer split `a` off (a new list headed by it, the list grown, or the
  // statement it reads ended with another to follow), or a body ended
  if (joinedAt < 0 && !semi && cc !== 59 && cc !== 125 &&
      (r ? list ? r === a && a.length > n : r !== a && Array.isArray(r) && r[0] === ';' && r[1] === a : (more && !wasMore) || p === body) &&
      !separated(last, end, closed, open)) joinedAt = at
  return r
}

// Positions (ctx.js): a bundled module's shift past the sources before it;
// a source the compiler writes (base null) keeps none.
const place = (node, base) => {
  if (!Array.isArray(node)) return
  if (typeof node.loc === 'number') node.loc = base == null ? undefined : node.loc + base
  for (let i = 1; i < node.length; i++) place(node[i], base)
}
// subscript reports where it stopped as `line:column` in its message.
const stoppedAt = (message, src) => {
  const m = / at ([0-9]+):([0-9]+)\n/.exec(message)
  if (!m) return { message, at: idx }
  let at = 0
  for (let line = +m[1]; line > 1; line--) at = src.indexOf('\n', at) + 1
  return { message: message.slice(0, m.index), at: at + +m[2] - 1 }
}

/** Source text to its AST. `base` places the source among the compile's
 *  (ctx.js addSource): 0 for the program, null for text the compiler wrote. */
const parse = (src, sourceType = 'jz', base = 0) => {
  // A leading `#!` line is a comment (Node, V8). Blanked, not cut, so every
  // offset still indexes the source as written. subscript's own shebang.js
  // registration went with parse.comment's entries.
  if (typeof src === 'string' && src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) {
    src = src.replace(/^#![^\n\r\u2028\u2029]*/, text => ' '.repeat(text.length))
  }
  // A lone CR ends a line as LF does; a template reads it as LF (§12.9.6).
  // Same length, so AST offsets stand. The original spelling still goes to
  // lexical validation below.
  const parseSource = typeof src === 'string' && src.includes('\r') ? src.replace(/\r(?!\n)/g, '\n') : src
  let ast
  joinedAt = gapFrom = gapEnd = closedOpen = closedAt = -1
  opens.length = 0
  try {
    ast = jessieParse(parseSource)
    validateEarlyErrors(ast, src, sourceType, base)
    if (joinedAt >= 0) err('Expected ; or a line break before this statement', joinedAt)
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    const stop = stoppedAt(e.message, parseSource), at = where(base == null ? here() : base + stop.at)
    throw SyntaxError(at ? stop.message + at : e.message)
  }
  decodeNames(ast)
  if (base !== 0) place(ast, base)
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

// The longest operator first, at every first character. subscript tries a
// character's operators newest-first and commits to the first whose text
// matches; a one-character operator matches any text it begins, so `>`,
// registered after `>>`, took the first character of a shift wherever its own
// precedence then ended the operand: `a < b >> c` read `(a < b) >> c`, and a
// loop bound `k < n >> 1` never held. Operators of one length keep their order
// (an override stays ahead of what it overrides); the pass over lengths needs
// no stable sort.
for (let c = 0; c < lookup.length; c++) {
  const ops = lookup[c]?.ops
  if (!ops || ops.length < 2) continue
  let longest = 0
  for (let i = 0; i < ops.length; i++) if (ops[i].l > longest) longest = ops[i].l
  const ordered = []
  for (let l = longest; l > 0; l--) for (let i = 0; i < ops.length; i++) if (ops[i].l === l) ordered.push(ops[i])
  for (let i = 0; i < ordered.length; i++) ops[i] = ordered[i]
}

export { parse }
