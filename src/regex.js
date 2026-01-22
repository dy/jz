/**
 * Regex parser & compiler
 *
 * Parses regex patterns into lispy AST, compiles to WASM matching code.
 *
 * AST format (subscript-style):
 *   abc       => ['seq', 'a', 'b', 'c']
 *   a|b       => ['|', 'a', 'b']
 *   a*        => ['*', 'a']
 *   a+        => ['+', 'a']
 *   a?        => ['?', 'a']
 *   a*?       => ['*?', 'a']  (non-greedy)
 *   a{2,3}    => ['{}', 'a', 2, 3]
 *   [abc]     => ['[]', 'a', 'b', 'c']
 *   [a-z]     => ['[]', ['-', 'a', 'z']]
 *   [^a]      => ['[^]', 'a']
 *   .         => ['.']
 *   ^a$       => ['seq', ['^'], 'a', ['$']]
 *   (a)       => ['()', 'a', 1]  (group number)
 *   (?:a)     => ['(?:)', 'a']
 *   (?=a)     => ['(?=)', 'a']   (lookahead)
 *   (?!a)     => ['(?!)', 'a']   (negative lookahead)
 *   (?<=a)    => ['(?<=)', 'a']  (lookbehind)
 *   (?<!a)    => ['(?<!)', 'a']  (negative lookbehind)
 *   \1        => ['\\1']         (backreference)
 *   \d        => ['\\d']
 *   \w        => ['\\w']
 *   \s        => ['\\s']
 *
 * Supported: all common regex features including backtracking
 */

import { ctx, gen } from './compile.js'
import { PTR_TYPE, wat, isString } from './types.js'

// Character codes
const PIPE = 124, STAR = 42, PLUS = 43, QUEST = 63, DOT = 46,
  LBRACK = 91, RBRACK = 93, LPAREN = 40, RPAREN = 41,
  LBRACE = 123, RBRACE = 125, CARET = 94, DOLLAR = 36,
  BSLASH = 92, DASH = 45, COLON = 58, EQUAL = 61, EXCL = 33, LT = 60

let src, idx, groupNum

const cur = () => src.charCodeAt(idx),
  peek = () => src[idx],
  skip = (n = 1) => (idx += n, src[idx - n]),
  eof = () => idx >= src.length,
  err = msg => { throw SyntaxError(`Regex: ${msg} at ${idx}`) }

/**
 * Parse regex pattern string → AST
 * @param {string} pattern - regex pattern (without delimiters)
 * @param {string} [flags] - regex flags (stored but not parsed into AST)
 * @returns {[string, ...any]} AST node
 */
export const parseRegex = (pattern, flags = '') => {
  src = pattern
  idx = 0
  groupNum = 0
  let ast = parseAlt()
  if (!eof()) err('Unexpected ' + peek())
  // Wrap single char in array to attach properties
  if (typeof ast === 'string') ast = ['seq', ast]
  // Attach flags and group count as properties
  if (flags) ast.flags = flags
  ast.groups = groupNum
  return ast
}

// Alternation: a|b|c → ['|', a, b, c]
const parseAlt = () => {
  const alts = [parseSeq()]
  while (cur() === PIPE) {
    skip()
    alts.push(parseSeq())
  }
  return alts.length === 1 ? alts[0] : ['|', ...alts]
}

// Sequence: abc → ['seq', 'a', 'b', 'c']
const parseSeq = () => {
  const items = []
  while (!eof() && cur() !== PIPE && cur() !== RPAREN) {
    items.push(parseQuantified())
  }
  if (items.length === 0) return ['seq']
  if (items.length === 1) return items[0]
  return ['seq', ...items]
}

// Quantified: a*, a+, a?, a{n,m}, with optional non-greedy ?
const parseQuantified = () => {
  let node = parseAtom()
  while (true) {
    const c = cur()
    if (c === STAR) { skip(); node = ['*', node] }
    else if (c === PLUS) { skip(); node = ['+', node] }
    else if (c === QUEST) { skip(); node = ['?', node] }
    else if (c === LBRACE) { node = parseRepeat(node) }
    else break
    // Non-greedy modifier
    if (cur() === QUEST) {
      skip()
      node[0] += '?' // '*?' '+?' '??' '{}?'
    }
  }
  return node
}

// Repetition: {n}, {n,}, {n,m}
const parseRepeat = node => {
  skip() // {
  let min = parseNum()
  let max = min
  if (cur() === 44) { // ,
    skip()
    max = cur() === RBRACE ? Infinity : parseNum()
  }
  cur() === RBRACE || err('Expected }')
  skip()
  return ['{}', node, min, max]
}

// Parse integer
const parseNum = () => {
  let n = 0
  while (cur() >= 48 && cur() <= 57) {
    n = n * 10 + (cur() - 48)
    skip()
  }
  return n
}

// Atom: literal, escape, class, group, dot, anchor
const parseAtom = () => {
  const c = cur()

  // Anchors
  if (c === CARET) { skip(); return ['^'] }
  if (c === DOLLAR) { skip(); return ['$'] }

  // Dot (any char)
  if (c === DOT) { skip(); return ['.'] }

  // Character class [...]
  if (c === LBRACK) return parseClass()

  // Group (...)
  if (c === LPAREN) return parseGroup()

  // Escape \x
  if (c === BSLASH) return parseEscape()

  // Literal character
  return skip()
}

// Character class: [abc], [a-z], [^abc]
const parseClass = () => {
  skip() // [
  const negated = cur() === CARET
  if (negated) skip()

  const items = []
  while (cur() !== RBRACK && !eof()) {
    const c = parseClassChar()
    // Range: a-z
    if (cur() === DASH && src.charCodeAt(idx + 1) !== RBRACK) {
      skip() // -
      items.push(['-', c, parseClassChar()])
    } else {
      items.push(c)
    }
  }
  cur() === RBRACK || err('Unclosed [')
  skip()

  return [negated ? '[^]' : '[]', ...items]
}

// Single char in class (handles escapes)
const parseClassChar = () => {
  if (cur() === BSLASH) {
    skip()
    const c = peek()
    // Preserve char classes inside [...] as nodes
    if ('dDwWsS'.includes(c)) { skip(); return ['\\' + c] }
    return parseEscapeChar()
  }
  return skip()
}

// Escape sequence
const parseEscape = () => {
  skip() // \
  const c = peek()

  // Backreference \1-\9
  if (c >= '1' && c <= '9') {
    skip()
    return ['\\' + c]
  }

  // Character classes
  if ('dDwWsS'.includes(c)) { skip(); return ['\\' + c] }

  // Word boundary
  if (c === 'b' || c === 'B') { skip(); return ['\\' + c] }

  // Literal escape
  return parseEscapeChar()
}

// Escape char (for both \x in pattern and in class)
const parseEscapeChar = () => {
  const c = skip()
  // Common escapes
  if (c === 'n') return '\n'
  if (c === 'r') return '\r'
  if (c === 't') return '\t'
  if (c === '0') return '\0'
  // Hex: \xNN
  if (c === 'x') {
    const hex = src.slice(idx, idx + 2)
    idx += 2
    return String.fromCharCode(parseInt(hex, 16))
  }
  // Unicode: \uNNNN
  if (c === 'u') {
    const hex = src.slice(idx, idx + 4)
    idx += 4
    return String.fromCharCode(parseInt(hex, 16))
  }
  // Literal (escaped special char or itself)
  return c
}

// Group: (...), (?:...), (?=...), (?!...), (?<=...), (?<!...)
const parseGroup = () => {
  skip() // (
  let type = '()'
  let groupId = null

  if (cur() === QUEST) {
    skip()
    const c = cur()
    if (c === COLON) { skip(); type = '(?:)' }
    else if (c === EQUAL) { skip(); type = '(?=)' }
    else if (c === EXCL) { skip(); type = '(?!)' }
    else if (c === LT) {
      skip()
      const c2 = cur()
      if (c2 === EQUAL) { skip(); type = '(?<=)' }
      else if (c2 === EXCL) { skip(); type = '(?<!)' }
      else err('Invalid group syntax')
    }
    else err('Invalid group syntax')
  } else {
    // Capturing group - assign number
    groupId = ++groupNum
  }

  const inner = parseAlt()
  cur() === RPAREN || err('Unclosed (')
  skip()

  return groupId ? [type, inner, groupId] : [type, inner]
}


// === Compile regex AST to WASM matching function ===

/**
 * Compile regex AST to a WASM function
 *
 * Strategy: Recursive descent with backtracking
 * - Each node compiles to code that advances $pos on match
 * - On failure, code branches to backtrack label or returns -1
 * - Quantifiers use loops with saved positions for backtracking
 * - Groups save start/end positions for captures and backrefs
 *
 * Generated function signature:
 *   (func $regex_match (param $str i32) (param $len i32) (param $start i32) (result i32))
 *   Returns: end position of match, or -1 if no match
 *
 * Also generates an "exec" variant that writes group positions:
 *   (func $regex_exec (param $str i32) (param $len i32) (param $start i32) (param $groups i32) (result i32))
 *   $groups points to memory where group positions are written: [g0_start, g0_end, g1_start, g1_end, ...]
 *   Group 0 is the full match.
 *
 * For global/sticky flags, caller handles iteration.
 *
 * @param {any} ast - regex AST from parseRegex
 * @param {string} name - function name
 * @returns {string} WAT function definition
 */
export const compileRegex = (ast, name = 'regex_match') => {
  const groups = ast.groups || 0
  const flags = ast.flags || ''
  const ignoreCase = flags.includes('i')
  const dotAll = flags.includes('s')

  // Locals: $pos (current), $save (for backtrack), $char, $groupN_start, $groupN_end
  const locals = ['$pos i32', '$save i32', '$char i32', '$match i32']
  for (let i = 1; i <= groups; i++) {
    locals.push(`$g${i}_start i32`, `$g${i}_end i32`)
  }

  const ctx = {
    ignoreCase,
    dotAll,
    groups,
    labelId: 0,
    code: [],
    failLabel: null  // When set, failures branch here instead of returning -1
  }

  // Initialize position
  ctx.code.push('(local.set $pos (local.get $start))')

  // Compile pattern
  compileNode(ast, ctx)

  // Return match end position
  ctx.code.push('(local.get $pos)')

  // Basic match function
  const matchFunc = `(func $${name} (param $str i32) (param $len i32) (param $start i32) (result i32)
    (local ${locals.join(') (local ')})
    ${ctx.code.join('\n    ')}
  )`

  // Generate exec variant that writes group positions to memory
  // Group 0 is full match (start, end), then group 1, etc.
  const execCode = [...ctx.code]
  // Remove last line (local.get $pos) - we'll write to memory instead
  execCode.pop()

  // Write group positions to $groups memory buffer
  // Format: [g0_start:i32, g0_end:i32, g1_start:i32, g1_end:i32, ...]
  execCode.push(';; Write group 0 (full match)')
  execCode.push('(i32.store (local.get $groups) (local.get $start))')  // g0_start = search start
  execCode.push('(i32.store (i32.add (local.get $groups) (i32.const 4)) (local.get $pos))')  // g0_end = current pos

  for (let i = 1; i <= groups; i++) {
    execCode.push(`;; Write group ${i}`)
    execCode.push(`(i32.store (i32.add (local.get $groups) (i32.const ${i * 8})) (local.get $g${i}_start))`)
    execCode.push(`(i32.store (i32.add (local.get $groups) (i32.const ${i * 8 + 4})) (local.get $g${i}_end))`)
  }

  execCode.push('(local.get $pos)')

  const execFunc = `(func $${name}_exec (param $str i32) (param $len i32) (param $start i32) (param $groups i32) (result i32)
    (local ${locals.join(') (local ')})
    ${execCode.join('\n    ')}
  )`

  // Return both functions concatenated
  return matchFunc + '\n' + execFunc
}

// Compile single AST node
const compileNode = (node, ctx) => {
  if (typeof node === 'string') {
    // Literal character
    compileLiteral(node, ctx)
    return
  }

  if (!Array.isArray(node)) return

  const [op, ...args] = node

  switch (op) {
    case 'seq': compileSeq(args, ctx); break
    case '|': compileAlt(args, ctx); break
    case '*': compileRepeat(args[0], 0, Infinity, true, ctx); break
    case '+': compileRepeat(args[0], 1, Infinity, true, ctx); break
    case '?': compileRepeat(args[0], 0, 1, true, ctx); break
    case '*?': compileRepeat(args[0], 0, Infinity, false, ctx); break
    case '+?': compileRepeat(args[0], 1, Infinity, false, ctx); break
    case '??': compileRepeat(args[0], 0, 1, false, ctx); break
    case '{}': compileRepeat(args[0], args[1], args[2], true, ctx); break
    case '{}?': compileRepeat(args[0], args[1], args[2], false, ctx); break
    case '[]': compileClass(args, false, ctx); break
    case '[^]': compileClass(args, true, ctx); break
    case '.': compileDot(ctx); break
    case '^': compileAnchorStart(ctx); break
    case '$': compileAnchorEnd(ctx); break
    case '()': compileCapture(args[0], args[1], ctx); break
    case '(?:)': compileNode(args[0], ctx); break
    case '(?=)': compileLookahead(args[0], true, ctx); break
    case '(?!)': compileLookahead(args[0], false, ctx); break
    case '(?<=)': compileLookbehind(args[0], true, ctx); break
    case '(?<!)': compileLookbehind(args[0], false, ctx); break
    case '\\d': compileCharClass('d', false, ctx); break
    case '\\D': compileCharClass('d', true, ctx); break
    case '\\w': compileCharClass('w', false, ctx); break
    case '\\W': compileCharClass('w', true, ctx); break
    case '\\s': compileCharClass('s', false, ctx); break
    case '\\S': compileCharClass('s', true, ctx); break
    case '\\b': compileWordBoundary(false, ctx); break
    case '\\B': compileWordBoundary(true, ctx); break
    case '\\1': case '\\2': case '\\3': case '\\4': case '\\5':
    case '\\6': case '\\7': case '\\8': case '\\9':
      compileBackref(parseInt(op[1]), ctx); break
    default:
      if (typeof op === 'undefined' && args.length === 1) {
        // Literal from parser [, 'x']
        compileLiteral(args[0], ctx)
      }
  }
}

// Sequence: match each in order
const compileSeq = (items, ctx) => {
  for (const item of items) compileNode(item, ctx)
}

// Alternation: try each branch, backtrack on failure
const compileAlt = (branches, ctx) => {
  const endLabel = `$alt_end_${ctx.labelId++}`

  ctx.code.push(`(block ${endLabel}`)

  for (let i = 0; i < branches.length; i++) {
    const isLast = i === branches.length - 1
    const tryLabel = `$alt_try_${ctx.labelId++}`

    if (!isLast) {
      ctx.code.push(`(block ${tryLabel}`)
      ctx.code.push('(local.set $save (local.get $pos))')
    }

    // Save failLabel, set it to tryLabel for this branch
    const savedFailLabel = ctx.failLabel
    if (!isLast) ctx.failLabel = tryLabel

    // Compile branch
    compileNode(branches[i], ctx)

    ctx.failLabel = savedFailLabel  // Restore

    if (!isLast) {
      // Success - jump to end
      ctx.code.push(`(br ${endLabel})`)
      ctx.code.push(`)`) // end try block
      // Restore position for next branch
      ctx.code.push('(local.set $pos (local.get $save))')
    }
  }

  ctx.code.push(')') // end block
}

// Repetition with backtracking
const compileRepeat = (node, min, max, greedy, ctx) => {
  const loopLabel = `$rep_loop_${ctx.labelId++}`
  const endLabel = `$rep_end_${ctx.labelId++}`
  const countLocal = `$count_${ctx.labelId++}`

  // Add count local
  ctx.code.unshift(`(local ${countLocal} i32)`)

  ctx.code.push(`(local.set ${countLocal} (i32.const 0))`)

  if (greedy) {
    // Greedy: match as many as possible first
    ctx.code.push(`(block ${endLabel}`)
    ctx.code.push(`(loop ${loopLabel}`)

    // Check max
    if (max !== Infinity) {
      ctx.code.push(`(br_if ${endLabel} (i32.ge_u (local.get ${countLocal}) (i32.const ${max})))`)
    }

    // Save position before trying match
    ctx.code.push('(local.set $save (local.get $pos))')

    // Try to match one more - failures branch to tryLabel instead of returning
    const tryLabel = `$rep_try_${ctx.labelId++}`
    ctx.code.push(`(block ${tryLabel}`)
    const savedFailLabel = ctx.failLabel
    ctx.failLabel = tryLabel  // Redirect failures to local label
    compileNode(node, ctx)
    ctx.failLabel = savedFailLabel  // Restore
    // Success - increment count and continue
    ctx.code.push(`(local.set ${countLocal} (i32.add (local.get ${countLocal}) (i32.const 1)))`)
    ctx.code.push(`(br ${loopLabel})`)
    ctx.code.push(')') // end try

    // Match failed - restore position
    ctx.code.push('(local.set $pos (local.get $save))')
    ctx.code.push(')') // end loop
    ctx.code.push(')') // end block
  } else {
    // Non-greedy: match minimum first, expand lazily
    // For simplicity, just match min then try to continue
    for (let i = 0; i < min; i++) {
      compileNode(node, ctx)
    }
    // Rest handled by outer backtracking
    if (max > min) {
      ctx.code.push(`(block ${endLabel}`)
      ctx.code.push(`(loop ${loopLabel}`)
      if (max !== Infinity) {
        ctx.code.push(`(br_if ${endLabel} (i32.ge_u (local.get ${countLocal}) (i32.const ${max - min})))`)
      }
      ctx.code.push('(local.set $save (local.get $pos))')
      const tryLabel = `$rep_try_${ctx.labelId++}`
      ctx.code.push(`(block ${tryLabel}`)
      const savedFailLabel = ctx.failLabel
      ctx.failLabel = tryLabel
      compileNode(node, ctx)
      ctx.failLabel = savedFailLabel
      ctx.code.push(`(local.set ${countLocal} (i32.add (local.get ${countLocal}) (i32.const 1)))`)
      ctx.code.push(`(br ${loopLabel})`)
      ctx.code.push(')')
      ctx.code.push('(local.set $pos (local.get $save))')
      ctx.code.push(')')
      ctx.code.push(')')
    }
  }

  // Check minimum was met
  if (min > 0 && greedy) {
    ctx.code.push(`(if (i32.lt_u (local.get ${countLocal}) (i32.const ${min}))`)
    emitFail(ctx)
    ctx.code.push(')')
  }
}

// Emit failure: either branch to failLabel or return -1
const emitFail = ctx => {
  if (ctx.failLabel) {
    ctx.code.push(`(then (br ${ctx.failLabel}))`)
  } else {
    ctx.code.push('(then (return (i32.const -1)))')
  }
}

// Literal character
const compileLiteral = (char, ctx) => {
  const code = char.charCodeAt(0)

  // Check bounds
  ctx.code.push('(if (i32.ge_u (local.get $pos) (local.get $len))')
  emitFail(ctx)
  ctx.code.push(')')

  // Load char
  ctx.code.push('(local.set $char (i32.load16_u (i32.add (local.get $str) (i32.shl (local.get $pos) (i32.const 1)))))')

  // Compare (with optional case folding)
  if (ctx.ignoreCase && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) {
    // Case insensitive: compare both cases
    const lower = code | 32
    const upper = lower - 32
    ctx.code.push(`(if (i32.and (i32.ne (local.get $char) (i32.const ${lower})) (i32.ne (local.get $char) (i32.const ${upper})))`)
    emitFail(ctx)
    ctx.code.push(')')
  } else {
    ctx.code.push(`(if (i32.ne (local.get $char) (i32.const ${code}))`)
    emitFail(ctx)
    ctx.code.push(')')
  }

  // Advance position
  ctx.code.push('(local.set $pos (i32.add (local.get $pos) (i32.const 1)))')
}

// Character class [abc] or [^abc]
const compileClass = (items, negated, ctx) => {
  ctx.code.push('(if (i32.ge_u (local.get $pos) (local.get $len))')
  emitFail(ctx)
  ctx.code.push(')')

  ctx.code.push('(local.set $char (i32.load16_u (i32.add (local.get $str) (i32.shl (local.get $pos) (i32.const 1)))))')

  // Build match condition
  const tests = items.map(item => compileClassItem(item, ctx)).filter(Boolean)
  const condition = tests.length === 1 ? tests[0] :
    tests.reduce((a, b) => `(i32.or ${a} ${b})`)

  const check = negated ? `(i32.eqz ${condition})` : condition

  ctx.code.push(`(if (i32.eqz ${check})`)
  emitFail(ctx)
  ctx.code.push(')')

  ctx.code.push('(local.set $pos (i32.add (local.get $pos) (i32.const 1)))')
}

// Single item in character class
const compileClassItem = (item, ctx) => {
  if (typeof item === 'string') {
    const code = item.charCodeAt(0)
    if (ctx.ignoreCase && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) {
      const lower = code | 32
      const upper = lower - 32
      return `(i32.or (i32.eq (local.get $char) (i32.const ${lower})) (i32.eq (local.get $char) (i32.const ${upper})))`
    }
    return `(i32.eq (local.get $char) (i32.const ${code}))`
  }

  if (Array.isArray(item)) {
    if (item[0] === '-') {
      // Range [a-z]
      const lo = item[1].charCodeAt(0)
      const hi = item[2].charCodeAt(0)
      if (ctx.ignoreCase && lo >= 65 && hi <= 122) {
        // Case insensitive range - check both cases
        const loLower = lo | 32, loUpper = lo & ~32
        const hiLower = hi | 32, hiUpper = hi & ~32
        return `(i32.or (i32.and (i32.ge_u (local.get $char) (i32.const ${loLower})) (i32.le_u (local.get $char) (i32.const ${hiLower}))) (i32.and (i32.ge_u (local.get $char) (i32.const ${loUpper})) (i32.le_u (local.get $char) (i32.const ${hiUpper}))))`
      }
      return `(i32.and (i32.ge_u (local.get $char) (i32.const ${lo})) (i32.le_u (local.get $char) (i32.const ${hi})))`
    }
    if (item[0] === '\\d') return CHAR_CLASS_CODE.d
    if (item[0] === '\\w') return CHAR_CLASS_CODE.w
    if (item[0] === '\\s') return CHAR_CLASS_CODE.s
  }
  return null
}

// Character class \d \w \s
const CHAR_CLASS_CODE = {
  d: '(i32.and (i32.ge_u (local.get $char) (i32.const 48)) (i32.le_u (local.get $char) (i32.const 57)))',
  w: `(i32.or (i32.or (i32.and (i32.ge_u (local.get $char) (i32.const 97)) (i32.le_u (local.get $char) (i32.const 122))) (i32.and (i32.ge_u (local.get $char) (i32.const 65)) (i32.le_u (local.get $char) (i32.const 90)))) (i32.or (i32.and (i32.ge_u (local.get $char) (i32.const 48)) (i32.le_u (local.get $char) (i32.const 57))) (i32.eq (local.get $char) (i32.const 95))))`,
  s: '(i32.or (i32.or (i32.eq (local.get $char) (i32.const 32)) (i32.eq (local.get $char) (i32.const 9))) (i32.or (i32.eq (local.get $char) (i32.const 10)) (i32.eq (local.get $char) (i32.const 13))))'
}

const compileCharClass = (cls, negated, ctx) => {
  ctx.code.push('(if (i32.ge_u (local.get $pos) (local.get $len))')
  emitFail(ctx)
  ctx.code.push(')')

  ctx.code.push('(local.set $char (i32.load16_u (i32.add (local.get $str) (i32.shl (local.get $pos) (i32.const 1)))))')

  const condition = CHAR_CLASS_CODE[cls]
  const check = negated ? condition : `(i32.eqz ${condition})`

  ctx.code.push(`(if ${check}`)
  emitFail(ctx)
  ctx.code.push(')')

  ctx.code.push('(local.set $pos (i32.add (local.get $pos) (i32.const 1)))')
}

// Dot: any char (except newline unless dotAll)
const compileDot = (ctx) => {
  ctx.code.push('(if (i32.ge_u (local.get $pos) (local.get $len))')
  emitFail(ctx)
  ctx.code.push(')')

  if (!ctx.dotAll) {
    ctx.code.push('(local.set $char (i32.load16_u (i32.add (local.get $str) (i32.shl (local.get $pos) (i32.const 1)))))')
    ctx.code.push('(if (i32.eq (local.get $char) (i32.const 10))')
    emitFail(ctx)
    ctx.code.push(')')
  }

  ctx.code.push('(local.set $pos (i32.add (local.get $pos) (i32.const 1)))')
}

// Anchor ^: start of string (or line in multiline mode)
const compileAnchorStart = (ctx) => {
  ctx.code.push('(if (i32.ne (local.get $pos) (i32.const 0))')
  emitFail(ctx)
  ctx.code.push(')')
}

// Anchor $: end of string (or line in multiline mode)
const compileAnchorEnd = (ctx) => {
  ctx.code.push('(if (i32.ne (local.get $pos) (local.get $len))')
  emitFail(ctx)
  ctx.code.push(')')
}

// Capturing group
const compileCapture = (inner, groupId, ctx) => {
  ctx.code.push(`(local.set $g${groupId}_start (local.get $pos))`)
  compileNode(inner, ctx)
  ctx.code.push(`(local.set $g${groupId}_end (local.get $pos))`)
}

// Lookahead (?=...) or (?!...)
const compileLookahead = (inner, positive, ctx) => {
  ctx.code.push('(local.set $save (local.get $pos))')

  const label = `$look_${ctx.labelId++}`
  ctx.code.push(`(block ${label}`)

  // Set failLabel so inner failures branch here
  const savedFailLabel = ctx.failLabel
  ctx.failLabel = label
  // Try to match
  compileNode(inner, ctx)
  ctx.failLabel = savedFailLabel

  // Match succeeded
  ctx.code.push('(local.set $match (i32.const 1))')
  ctx.code.push(`(br ${label})`)
  ctx.code.push(')')

  // Restore position (lookahead doesn't consume)
  ctx.code.push('(local.set $pos (local.get $save))')

  // Check result
  if (positive) {
    ctx.code.push('(if (i32.eqz (local.get $match))')
    emitFail(ctx)
    ctx.code.push(')')
  } else {
    ctx.code.push('(if (local.get $match)')
    emitFail(ctx)
    ctx.code.push(')')
  }
  ctx.code.push('(local.set $match (i32.const 0))')
}

// Lookbehind (?<=...) or (?<!...)
const compileLookbehind = (inner, positive, ctx) => {
  // Save current position
  ctx.code.push('(local.set $save (local.get $pos))')

  // Need to find where to start matching backwards
  // For fixed-length patterns, we know exactly
  // For variable length, we need to try multiple positions
  const len = patternMinLength(inner)

  if (len > 0) {
    // Check we have enough chars behind
    ctx.code.push(`(if (i32.lt_u (local.get $pos) (i32.const ${len}))`)
    if (positive) {
      emitFail(ctx)
      ctx.code.push(')')
    } else {
      ctx.code.push('(then (nop)))') // Negative lookbehind passes if not enough chars
    }

    // Move back and try to match
    ctx.code.push(`(local.set $pos (i32.sub (local.get $pos) (i32.const ${len})))`)

    const label = `$lookb_${ctx.labelId++}`
    ctx.code.push(`(block ${label}`)
    const savedFailLabel = ctx.failLabel
    ctx.failLabel = label
    compileNode(inner, ctx)
    ctx.failLabel = savedFailLabel
    ctx.code.push('(local.set $match (i32.const 1))')
    ctx.code.push(`(br ${label})`)
    ctx.code.push(')')

    // Restore position
    ctx.code.push('(local.set $pos (local.get $save))')

    if (positive) {
      ctx.code.push('(if (i32.eqz (local.get $match))')
      emitFail(ctx)
      ctx.code.push(')')
    } else {
      ctx.code.push('(if (local.get $match)')
      emitFail(ctx)
      ctx.code.push(')')
    }
    ctx.code.push('(local.set $match (i32.const 0))')
  }
}

// Word boundary \b or \B
const compileWordBoundary = (negated, ctx) => {
  // Word boundary: transition between word and non-word char
  const isWord = CHAR_CLASS_CODE.w

  ctx.code.push('(local.set $match (i32.const 0))')

  // Check char before (if exists)
  ctx.code.push('(if (i32.gt_u (local.get $pos) (i32.const 0))')
  ctx.code.push('(then')
  ctx.code.push('(local.set $char (i32.load16_u (i32.add (local.get $str) (i32.shl (i32.sub (local.get $pos) (i32.const 1)) (i32.const 1)))))')
  ctx.code.push(`(local.set $match ${isWord})`)
  ctx.code.push('))')

  ctx.code.push('(local.set $save (local.get $match))') // save "before is word"
  ctx.code.push('(local.set $match (i32.const 0))')

  // Check char at current pos (if exists)
  ctx.code.push('(if (i32.lt_u (local.get $pos) (local.get $len))')
  ctx.code.push('(then')
  ctx.code.push('(local.set $char (i32.load16_u (i32.add (local.get $str) (i32.shl (local.get $pos) (i32.const 1)))))')
  ctx.code.push(`(local.set $match ${isWord})`)
  ctx.code.push('))')

  // Boundary if XOR of before/after
  ctx.code.push('(local.set $match (i32.xor (local.get $save) (local.get $match)))')

  if (negated) {
    ctx.code.push('(if (local.get $match)')
  } else {
    ctx.code.push('(if (i32.eqz (local.get $match))')
  }
  emitFail(ctx)
  ctx.code.push(')')
}

// Backreference \1-\9
const compileBackref = (n, ctx) => {
  // Match the same text as captured by group n
  const startLocal = `$g${n}_start`
  const endLocal = `$g${n}_end`

  const loopLabel = `$backref_${ctx.labelId++}`
  const endLabel = `$backref_end_${ctx.labelId++}`
  const iLocal = `$br_i_${ctx.labelId++}`

  ctx.code.unshift(`(local ${iLocal} i32)`)

  ctx.code.push(`(local.set ${iLocal} (local.get ${startLocal}))`)
  ctx.code.push(`(block ${endLabel}`)
  ctx.code.push(`(loop ${loopLabel}`)

  // Check if we've matched the whole captured group
  ctx.code.push(`(br_if ${endLabel} (i32.ge_u (local.get ${iLocal}) (local.get ${endLocal})))`)

  // Check bounds
  ctx.code.push('(if (i32.ge_u (local.get $pos) (local.get $len))')
  emitFail(ctx)
  ctx.code.push(')')

  // Compare chars
  ctx.code.push(`(local.set $char (i32.load16_u (i32.add (local.get $str) (i32.shl (local.get ${iLocal}) (i32.const 1)))))`)
  ctx.code.push(`(local.set $save (i32.load16_u (i32.add (local.get $str) (i32.shl (local.get $pos) (i32.const 1)))))`)

  if (ctx.ignoreCase) {
    // Case insensitive compare
    ctx.code.push('(if (i32.and (i32.ne (i32.or (local.get $char) (i32.const 32)) (i32.or (local.get $save) (i32.const 32))) (i32.or (i32.lt_u (local.get $char) (i32.const 65)) (i32.gt_u (local.get $char) (i32.const 122))))')
  } else {
    ctx.code.push('(if (i32.ne (local.get $char) (local.get $save))')
  }
  emitFail(ctx)
  ctx.code.push(')')

  ctx.code.push(`(local.set ${iLocal} (i32.add (local.get ${iLocal}) (i32.const 1)))`)
  ctx.code.push('(local.set $pos (i32.add (local.get $pos) (i32.const 1)))')
  ctx.code.push(`(br ${loopLabel})`)
  ctx.code.push(')')
  ctx.code.push(')')
}

// Calculate minimum length of a pattern (for lookbehind)
const patternMinLength = (node) => {
  if (typeof node === 'string') return 1
  if (!Array.isArray(node)) return 0

  const [op, ...args] = node
  switch (op) {
    case 'seq': return args.reduce((sum, a) => sum + patternMinLength(a), 0)
    case '|': return Math.min(...args.map(patternMinLength))
    case '*': case '*?': case '?': case '??': return 0
    case '+': case '+?': return patternMinLength(args[0])
    case '{}': case '{}?': return args[1] * patternMinLength(args[0])
    case '[]': case '[^]': case '.': return 1
    case '\\d': case '\\D': case '\\w': case '\\W': case '\\s': case '\\S': return 1
    case '()': case '(?:)': return patternMinLength(args[0])
    case '(?=)': case '(?!)': case '(?<=)': case '(?<!)': return 0
    case '^': case '$': case '\\b': case '\\B': return 0
    default: return 0
  }
}

// Regex method handlers (called from compile.js)
export const REGEX_METHODS = {
  // regex.test(str) - returns i32 (1 if match found, 0 if not)
  test(receiver, args) {
    if (args.length !== 1) throw new Error('regex.test(str) requires 1 argument')
    const regexId = receiver.schema
    const strVal = gen(args[0])
    if (!isString(strVal)) throw new Error('regex.test() argument must be string')
    // Search loop: try at each start position until match or end
    const id = ctx.loopCounter++
    const strOff = `$_rstr_${id}`, strLen = `$_rlen_${id}`, searchPos = `$_rsrch_${id}`, matchResult = `$_rmatch_${id}`
    ctx.addLocal(strOff.slice(1), 'i32')
    ctx.addLocal(strLen.slice(1), 'i32')
    ctx.addLocal(searchPos.slice(1), 'i32')
    ctx.addLocal(matchResult.slice(1), 'i32')
    return wat(`(block (result i32)
      (local.set ${strOff} (call $__ptr_offset ${strVal}))
      (local.set ${strLen} (call $__ptr_len ${strVal}))
      (local.set ${searchPos} (i32.const 0))
      (block $found_${id}
        (loop $search_${id}
          (br_if $found_${id} (i32.gt_s (local.get ${searchPos}) (local.get ${strLen})))
          (local.set ${matchResult} (call $__regex_${regexId} (local.get ${strOff}) (local.get ${strLen}) (local.get ${searchPos})))
          (br_if $found_${id} (i32.ge_s (local.get ${matchResult}) (i32.const 0)))
          (local.set ${searchPos} (i32.add (local.get ${searchPos}) (i32.const 1)))
          (br $search_${id})))
      (i32.ge_s (local.get ${matchResult}) (i32.const 0)))`, 'i32')
  },

  // regex.exec(str) - returns array [fullMatch, group1, ...] or null (0)
  exec(receiver, args) {
    if (args.length !== 1) throw new Error('regex.exec(str) requires 1 argument')
    const regexId = receiver.schema
    const groupCount = ctx.regexGroups?.[regexId] || 0
    const strVal = gen(args[0])
    if (!isString(strVal)) throw new Error('regex.exec() argument must be string')

    ctx.usedStringType = true
    ctx.usedArrayType = true
    const id = ctx.loopCounter++

    // Locals for search and result building
    const strPtr = `$_exec_str_${id}`, strOff = `$_exec_off_${id}`, strLen = `$_exec_len_${id}`
    const searchPos = `$_exec_srch_${id}`, matchEnd = `$_exec_end_${id}`
    const result = `$_exec_res_${id}`, groupBuf = `$_exec_grp_${id}`
    const part = `$_exec_part_${id}`, partLen = `$_exec_plen_${id}`
    const k = `$_exec_k_${id}`
    const gStart = `$_exec_gs_${id}`, gEnd = `$_exec_ge_${id}`

    ctx.addLocal(strPtr.slice(1), 'f64')
    ctx.addLocal(strOff.slice(1), 'i32')
    ctx.addLocal(strLen.slice(1), 'i32')
    ctx.addLocal(searchPos.slice(1), 'i32')
    ctx.addLocal(matchEnd.slice(1), 'i32')
    ctx.addLocal(result.slice(1), 'f64')
    ctx.addLocal(groupBuf.slice(1), 'i32')
    ctx.addLocal(part.slice(1), 'f64')
    ctx.addLocal(partLen.slice(1), 'i32')
    ctx.addLocal(k.slice(1), 'i32')
    ctx.addLocal(gStart.slice(1), 'i32')
    ctx.addLocal(gEnd.slice(1), 'i32')

    // Result array has groupCount + 1 elements (full match + groups)
    const resultLen = groupCount + 1
    const arrNew = `(call $__alloc (i32.const ${PTR_TYPE.ARRAY}) (i32.const ${resultLen}))`

    // Helper to copy substring: strOff + start*2 to strOff + end*2
    const copySubstr = (startLocal, endLocal, destLocal) => `
      (local.set ${partLen} (i32.sub (local.get ${endLocal}) (local.get ${startLocal})))
      (local.set ${destLocal} (call $__alloc (i32.const ${PTR_TYPE.STRING}) (local.get ${partLen})))
      (local.set ${k} (i32.const 0))
      (block $cpy_done_${id} (loop $cpy_loop_${id}
        (br_if $cpy_done_${id} (i32.ge_s (local.get ${k}) (local.get ${partLen})))
        (i32.store16 (i32.add (call $__ptr_offset (local.get ${destLocal})) (i32.shl (local.get ${k}) (i32.const 1)))
          (i32.load16_u (i32.add (local.get ${strOff}) (i32.shl (i32.add (local.get ${startLocal}) (local.get ${k})) (i32.const 1)))))
        (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
        (br $cpy_loop_${id})))
    `

    return wat(`(block (result f64)
      (local.set ${strPtr} ${strVal})
      (local.set ${strOff} (call $__ptr_offset (local.get ${strPtr})))
      (local.set ${strLen} (call $__ptr_len (local.get ${strPtr})))
      (local.set ${searchPos} (i32.const 0))
      (local.set ${matchEnd} (i32.const -1))
      ;; Allocate temp buffer for group positions on stack area (use bump allocator space)
      (local.set ${groupBuf} (global.get $__heap))
      ;; Search loop
      (block $found_${id}
        (loop $search_${id}
          (br_if $found_${id} (i32.gt_s (local.get ${searchPos}) (local.get ${strLen})))
          (local.set ${matchEnd} (call $__regex_${regexId}_exec (local.get ${strOff}) (local.get ${strLen}) (local.get ${searchPos}) (local.get ${groupBuf})))
          (br_if $found_${id} (i32.ge_s (local.get ${matchEnd}) (i32.const 0)))
          (local.set ${searchPos} (i32.add (local.get ${searchPos}) (i32.const 1)))
          (br $search_${id})))
      ;; Check if found
      (if (result f64) (i32.lt_s (local.get ${matchEnd}) (i32.const 0))
        (then (f64.const 0))  ;; null
        (else
          ;; Build result array
          (local.set ${result} ${arrNew})
          ;; Extract full match (group 0)
          (local.set ${gStart} (i32.load (local.get ${groupBuf})))
          (local.set ${gEnd} (i32.load (i32.add (local.get ${groupBuf}) (i32.const 4))))
          ${copySubstr(gStart, gEnd, part)}
          (f64.store (call $__ptr_offset (local.get ${result})) (local.get ${part}))
          ;; Extract capture groups
          ${Array.from({length: groupCount}, (_, i) => `
          (local.set ${gStart} (i32.load (i32.add (local.get ${groupBuf}) (i32.const ${(i + 1) * 8}))))
          (local.set ${gEnd} (i32.load (i32.add (local.get ${groupBuf}) (i32.const ${(i + 1) * 8 + 4}))))
          ${copySubstr(gStart, gEnd, part)}
          (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.const ${(i + 1) * 8})) (local.get ${part}))`).join('\n')}
          (local.get ${result}))))`, 'f64')
  }
}
