/**
 * Regex module — parser, WAT codegen, and integration.
 *
 * Parses regex patterns into lispy AST, compiles to WASM matching functions.
 * Regex literals become compile-time WASM functions, methods dispatch statically.
 *
 * @module regex
 */

import { typed, asF64, asI64, UNDEF_NAN, mkPtrIR, temp, tempI32 } from '../src/ir.js'
import { emit } from '../src/emit.js'
import { err, inc, PTR, LAYOUT } from '../src/ctx.js'

// Build IR that constructs a match array: [full, cap1, cap2, ...]
// strLocal, msLocal, meLocal are local names (i32 for ms/me, f64 for str).
// Captures read from globals $__re_g${i}_start / _end. -1 → undefined.
const buildMatchArr = (strLocal, msLocal, meLocal, nGroups) => {
  const N = nGroups + 1
  inc('__alloc', '__mkptr', '__str_slice')
  const arr = tempI32('mka')
  const stmts = [
    ['local.set', `$${arr}`, ['call', '$__alloc', ['i32.const', 8 + N * 8]]],
    ['i32.store', ['local.get', `$${arr}`], ['i32.const', N]],
    ['i32.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', 4]], ['i32.const', N]],
    ['f64.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', 8]],
      ['call', '$__str_slice', ['i64.reinterpret_f64', ['local.get', `$${strLocal}`]],
        ['local.get', `$${msLocal}`], ['local.get', `$${meLocal}`]]],
  ]
  for (let i = 1; i <= nGroups; i++) {
    stmts.push(['f64.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', 8 + i * 8]],
      ['if', ['result', 'f64'],
        ['i32.lt_s', ['global.get', `$__re_g${i}_start`], ['i32.const', 0]],
        ['then', ['f64.const', `nan:${UNDEF_NAN}`]],
        ['else', ['call', '$__str_slice', ['i64.reinterpret_f64', ['local.get', `$${strLocal}`]],
          ['global.get', `$__re_g${i}_start`], ['global.get', `$__re_g${i}_end`]]]]])
  }
  stmts.push(mkPtrIR(PTR.ARRAY, 0, ['i32.add', ['local.get', `$${arr}`], ['i32.const', 8]]))
  return ['block', ['result', 'f64'], ...stmts]
}

// === Parser ===

const PIPE = 124, STAR = 42, PLUS = 43, QUEST = 63, DOT = 46,
  LBRACK = 91, RBRACK = 93, LPAREN = 40, RPAREN = 41,
  LBRACE = 123, RBRACE = 125, CARET = 94, DOLLAR = 36,
  BSLASH = 92, DASH = 45, COLON = 58, EQUAL = 61, EXCL = 33, LT = 60

let src, idx, groupNum

const cur = () => src.charCodeAt(idx),
  peek = () => src[idx],
  skip = (n = 1) => (idx += n, src[idx - n]),
  eof = () => idx >= src.length,
  perr = msg => { throw SyntaxError(`Regex: ${msg} at ${idx}`) }

/** Parse regex pattern → AST */
export const parseRegex = (pattern, flags = '') => {
  src = pattern; idx = 0; groupNum = 0
  let ast = parseAlt()
  if (!eof()) perr('Unexpected ' + peek())
  if (typeof ast === 'string') ast = ['seq', ast]
  if (flags) ast.flags = flags
  ast.groups = groupNum
  return ast
}

const parseAlt = () => {
  const alts = [parseSeq()]
  while (cur() === PIPE) { skip(); alts.push(parseSeq()) }
  return alts.length === 1 ? alts[0] : ['|', ...alts]
}

const parseSeq = () => {
  const items = []
  while (!eof() && cur() !== PIPE && cur() !== RPAREN) items.push(parseQuantified())
  if (items.length === 0) return ['seq']
  if (items.length === 1) return items[0]
  return ['seq', ...items]
}

const parseQuantified = () => {
  let node = parseAtom()
  while (true) {
    const c = cur()
    if (c === STAR) { skip(); node = ['*', node] }
    else if (c === PLUS) { skip(); node = ['+', node] }
    else if (c === QUEST) { skip(); node = ['?', node] }
    else if (c === LBRACE) { node = parseRepeat(node) }
    else break
    if (cur() === QUEST) { skip(); node[0] += '?' }
  }
  return node
}

const parseRepeat = node => {
  skip() // {
  let min = parseNum(), max = min
  if (cur() === 44) { skip(); max = cur() === RBRACE ? Infinity : parseNum() }
  cur() === RBRACE || perr('Expected }'); skip()
  return ['{}', node, min, max]
}

const parseNum = () => {
  let n = 0
  while (cur() >= 48 && cur() <= 57) { n = n * 10 + (cur() - 48); skip() }
  return n
}

const parseAtom = () => {
  const c = cur()
  if (c === CARET) { skip(); return ['^'] }
  if (c === DOLLAR) { skip(); return ['$'] }
  if (c === DOT) { skip(); return ['.'] }
  if (c === LBRACK) return parseClass()
  if (c === LPAREN) return parseGroup()
  if (c === BSLASH) return parseEscape()
  return skip()
}

const parseClass = () => {
  skip() // [
  const negated = cur() === CARET; if (negated) skip()
  const items = []
  while (cur() !== RBRACK && !eof()) {
    const c = parseClassChar()
    if (cur() === DASH && src.charCodeAt(idx + 1) !== RBRACK) { skip(); items.push(['-', c, parseClassChar()]) }
    else items.push(c)
  }
  cur() === RBRACK || perr('Unclosed ['); skip()
  return [negated ? '[^]' : '[]', ...items]
}

const parseClassChar = () => {
  if (cur() === BSLASH) {
    skip(); const c = peek()
    if ('dDwWsS'.includes(c)) { skip(); return ['\\' + c] }
    return parseEscapeChar()
  }
  return skip()
}

const parseEscape = () => {
  skip()
  const c = peek()
  if (c >= '1' && c <= '9') { skip(); return ['\\' + c] }
  if ('dDwWsS'.includes(c)) { skip(); return ['\\' + c] }
  if (c === 'b' || c === 'B') { skip(); return ['\\' + c] }
  return parseEscapeChar()
}

const parseEscapeChar = () => {
  const c = skip()
  if (c === 'n') return '\n'
  if (c === 'r') return '\r'
  if (c === 't') return '\t'
  if (c === '0') return '\0'
  if (c === 'x') { const h = src.slice(idx, idx + 2); idx += 2; return String.fromCharCode(parseInt(h, 16)) }
  if (c === 'u') { const h = src.slice(idx, idx + 4); idx += 4; return String.fromCharCode(parseInt(h, 16)) }
  return c
}

const parseGroup = () => {
  skip()
  let type = '()', groupId = null
  if (cur() === QUEST) {
    skip(); const c = cur()
    if (c === COLON) { skip(); type = '(?:)' }
    else if (c === EQUAL) { skip(); type = '(?=)' }
    else if (c === EXCL) { skip(); type = '(?!)' }
    else if (c === LT) {
      skip(); const c2 = cur()
      if (c2 === EQUAL) { skip(); type = '(?<=)' }
      else if (c2 === EXCL) { skip(); type = '(?<!)' }
      else perr('Invalid group syntax')
    } else perr('Invalid group syntax')
  } else groupId = ++groupNum
  const inner = parseAlt()
  cur() === RPAREN || perr('Unclosed ('); skip()
  return groupId ? [type, inner, groupId] : [type, inner]
}


// === WAT Codegen ===

const CHAR_CLASS_WAT = {
  d: '(i32.and (i32.ge_u (local.get $char) (i32.const 48)) (i32.le_u (local.get $char) (i32.const 57)))',
  w: '(i32.or (i32.or (i32.and (i32.ge_u (local.get $char) (i32.const 97)) (i32.le_u (local.get $char) (i32.const 122))) (i32.and (i32.ge_u (local.get $char) (i32.const 65)) (i32.le_u (local.get $char) (i32.const 90)))) (i32.or (i32.and (i32.ge_u (local.get $char) (i32.const 48)) (i32.le_u (local.get $char) (i32.const 57))) (i32.eq (local.get $char) (i32.const 95))))',
  s: '(i32.or (i32.or (i32.eq (local.get $char) (i32.const 32)) (i32.eq (local.get $char) (i32.const 9))) (i32.or (i32.eq (local.get $char) (i32.const 10)) (i32.eq (local.get $char) (i32.const 13))))'
}

// 8-bit char load at $str + $pos
const LOAD_CHAR = '(local.set $char (i32.load8_u (i32.add (local.get $str) (local.get $pos))))'

/**
 * Compile regex AST → WAT matching function.
 * Generated: (func $name (param $str i32) (param $len i32) (param $start i32) (result i32))
 * Returns end position of match, or -1 on failure.
 */
export const compileRegex = (ast, name = 'regex_match') => {
  const groups = ast.groups || 0
  const flags = ast.flags || ''
  const ignoreCase = flags.includes('i'), dotAll = flags.includes('s')

  const locals = ['$pos i32', '$save i32', '$char i32', '$match i32']
  for (let i = 1; i <= groups; i++) locals.push(`$g${i}_start i32`, `$g${i}_end i32`)

  const rctx = { ignoreCase, dotAll, groups, labelId: 0, code: [], failLabel: null }
  rctx.code.push('(local.set $pos (local.get $start))')
  // Init capture locals to -1 (unmatched / undefined)
  for (let i = 1; i <= groups; i++) {
    rctx.code.push(`(local.set $g${i}_start (i32.const -1))`)
    rctx.code.push(`(local.set $g${i}_end (i32.const -1))`)
  }
  compileNode(ast, rctx)
  // On success, publish captures to module globals (read by .string:match / .regex:exec)
  for (let i = 1; i <= groups; i++) {
    rctx.code.push(`(global.set $__re_g${i}_start (local.get $g${i}_start))`)
    rctx.code.push(`(global.set $__re_g${i}_end (local.get $g${i}_end))`)
  }
  rctx.code.push('(local.get $pos)')

  return `(func $${name} (param $str i32) (param $len i32) (param $start i32) (result i32)
    (local ${locals.join(') (local ')})
    ${rctx.code.join('\n    ')}
  )`
}

const GREEDY_OPS = new Set(['*', '+', '?', '{}'])
const LAZY_OPS = new Set(['*?', '+?', '??', '{}?'])

const compileSeq = (items, c) => {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!Array.isArray(item) || i >= items.length - 1) { compileNode(item, c); continue }
    // Greedy quantifier followed by more items → needs backtracking
    if (GREEDY_OPS.has(item[0])) {
      compileGreedyBacktrack(item, items.slice(i + 1), c)
      return
    }
    // Lazy quantifier followed by more items → expand-on-fail
    if (LAZY_OPS.has(item[0])) {
      compileLazyBacktrack(item, items.slice(i + 1), c)
      return
    }
    compileNode(item, c)
  }
}

/** Compile greedy quantifier + rest of sequence with proper backtracking. */
const compileGreedyBacktrack = (quant, rest, c) => {
  const [op, node, ...qargs] = quant
  const min = op === '+' ? 1 : op === '{}' ? qargs[0] : 0
  const max = op === '?' ? 1 : op === '{}' ? qargs[1] : Infinity

  // Save position before greedy matching
  const saveL = `$gbt_${c.labelId++}`
  const okL = `$gbt_ok_${c.labelId++}`
  c.code.unshift(`(local ${saveL} i32)`)
  c.code.unshift(`(local ${okL} i32)`)
  c.code.push(`(local.set ${saveL} (local.get $pos))`)

  // Greedy loop: match as many as possible
  compileRepeatN(node, min, max, true, c)

  // pos is now at max greedy match end
  // Backtrack loop: try rest, on fail give back one char and retry
  const btLoop = `$bt_${c.labelId++}`
  const btEnd = `$bt_end_${c.labelId++}`
  const btFail = `$bt_fail_${c.labelId++}`
  const btSave = `$bt_sv_${c.labelId++}`
  c.code.unshift(`(local ${btSave} i32)`)

  c.code.push(`(local.set ${okL} (i32.const 0))`)
  c.code.push(`(block ${btEnd}`)
  c.code.push(`(loop ${btLoop}`)
  // Check min constraint: pos - greedyStart >= min
  if (min > 0) {
    c.code.push(`(br_if ${btEnd} (i32.lt_s (i32.sub (local.get $pos) (local.get ${saveL})) (i32.const ${min})))`)
  } else {
    c.code.push(`(br_if ${btEnd} (i32.lt_s (local.get $pos) (local.get ${saveL})))`)
  }
  // Save pos for restore on failure
  c.code.push(`(local.set ${btSave} (local.get $pos))`)
  // Try rest of sequence
  c.code.push(`(block ${btFail}`)
  const saved = c.failLabel; c.failLabel = btFail
  compileSeq(rest, c)
  c.failLabel = saved
  // Rest succeeded
  c.code.push(`(local.set ${okL} (i32.const 1))`)
  c.code.push(`(br ${btEnd})`)
  c.code.push(')') // end btFail block
  // Rest failed — restore pos and give back one match (backtrack by pattern width)
  c.code.push(`(local.set $pos (i32.sub (local.get ${btSave}) (i32.const ${patternMinLen(node)})))`)
  c.code.push(`(br ${btLoop})`)
  c.code.push(')') // end loop
  c.code.push(')') // end block

  // Check if backtracking succeeded
  c.code.push(`(if (i32.eqz (local.get ${okL}))`)
  emitFail(c)
  c.code.push(')')
}

/** Compile lazy quantifier + rest with expand-on-fail backtracking. */
const compileLazyBacktrack = (quant, rest, c) => {
  const [op, node, ...qargs] = quant
  const min = op === '+?' ? 1 : op === '{}?' ? qargs[0] : 0
  const max = op === '??' ? 1 : op === '{}?' ? qargs[1] : Infinity

  // Match minimum required
  for (let i = 0; i < min; i++) compileNode(node, c)

  // Lazy expand loop: try rest first, on fail match one more and retry
  const okL = `$lz_ok_${c.labelId++}`
  const ltLoop = `$lz_${c.labelId++}`
  const ltEnd = `$lz_end_${c.labelId++}`
  const ltFail = `$lz_fail_${c.labelId++}`
  const ltSave = `$lz_sv_${c.labelId++}`
  const countL = `$lz_n_${c.labelId++}`
  c.code.unshift(`(local ${okL} i32)`)
  c.code.unshift(`(local ${ltSave} i32)`)
  c.code.unshift(`(local ${countL} i32)`)

  c.code.push(`(local.set ${okL} (i32.const 0))`)
  c.code.push(`(local.set ${countL} (i32.const 0))`)
  c.code.push(`(block ${ltEnd}`)
  c.code.push(`(loop ${ltLoop}`)
  // Check max constraint
  if (max !== Infinity) {
    c.code.push(`(br_if ${ltEnd} (i32.ge_u (local.get ${countL}) (i32.const ${max - min})))`)
  }
  // Save pos before trying rest
  c.code.push(`(local.set ${ltSave} (local.get $pos))`)
  // Try rest of sequence
  c.code.push(`(block ${ltFail}`)
  const saved = c.failLabel; c.failLabel = ltFail
  compileSeq(rest, c)
  c.failLabel = saved
  // Rest succeeded
  c.code.push(`(local.set ${okL} (i32.const 1))`)
  c.code.push(`(br ${ltEnd})`)
  c.code.push(')') // end ltFail block
  // Rest failed — restore pos, try matching one more
  c.code.push(`(local.set $pos (local.get ${ltSave}))`)
  // Try to match one more instance of the quantified node
  const tryMore = `$lz_try_${c.labelId++}`
  c.code.push(`(block ${tryMore}`)
  const saved2 = c.failLabel; c.failLabel = tryMore
  compileNode(node, c)
  c.failLabel = saved2
  c.code.push(`(local.set ${countL} (i32.add (local.get ${countL}) (i32.const 1)))`)
  c.code.push(`(br ${ltLoop})`)
  c.code.push(')') // end tryMore block
  // Can't match more — fail entirely
  c.code.push(')') // end loop
  c.code.push(')') // end block

  c.code.push(`(if (i32.eqz (local.get ${okL}))`)
  emitFail(c)
  c.code.push(')')
}

const compileNode = (node, c) => {
  if (typeof node === 'string') { compileLiteral(node, c); return }
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  switch (op) {
    case 'seq': compileSeq(args, c); break
    case '|': compileAlt(args, c); break
    case '*': compileRepeatN(args[0], 0, Infinity, true, c); break
    case '+': compileRepeatN(args[0], 1, Infinity, true, c); break
    case '?': compileRepeatN(args[0], 0, 1, true, c); break
    case '*?': compileRepeatN(args[0], 0, Infinity, false, c); break
    case '+?': compileRepeatN(args[0], 1, Infinity, false, c); break
    case '??': compileRepeatN(args[0], 0, 1, false, c); break
    case '{}': compileRepeatN(args[0], args[1], args[2], true, c); break
    case '{}?': compileRepeatN(args[0], args[1], args[2], false, c); break
    case '[]': compileClassN(args, false, c); break
    case '[^]': compileClassN(args, true, c); break
    case '.': compileDot(c); break
    case '^': compileAnchorStart(c); break
    case '$': compileAnchorEnd(c); break
    case '()': compileCapture(args[0], args[1], c); break
    case '(?:)': compileNode(args[0], c); break
    case '(?=)': compileLookahead(args[0], true, c); break
    case '(?!)': compileLookahead(args[0], false, c); break
    case '(?<=)': compileLookbehind(args[0], true, c); break
    case '(?<!)': compileLookbehind(args[0], false, c); break
    case '\\d': compileCharClassN('d', false, c); break
    case '\\D': compileCharClassN('d', true, c); break
    case '\\w': compileCharClassN('w', false, c); break
    case '\\W': compileCharClassN('w', true, c); break
    case '\\s': compileCharClassN('s', false, c); break
    case '\\S': compileCharClassN('s', true, c); break
    case '\\b': compileWordBoundary(false, c); break
    case '\\B': compileWordBoundary(true, c); break
    case '\\1': case '\\2': case '\\3': case '\\4': case '\\5':
    case '\\6': case '\\7': case '\\8': case '\\9':
      compileBackref(parseInt(op[1]), c); break
  }
}

const emitFail = c => {
  if (c.failLabel) c.code.push(`(then (br ${c.failLabel}))`)
  else c.code.push('(then (return (i32.const -1)))')
}

const compileLiteral = (ch, c) => {
  const code = ch.charCodeAt(0)
  c.code.push('(if (i32.ge_u (local.get $pos) (local.get $len))'); emitFail(c); c.code.push(')')
  c.code.push(LOAD_CHAR)
  if (c.ignoreCase && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) {
    const lo = code | 32, hi = lo - 32
    c.code.push(`(if (i32.and (i32.ne (local.get $char) (i32.const ${lo})) (i32.ne (local.get $char) (i32.const ${hi})))`)
  } else {
    c.code.push(`(if (i32.ne (local.get $char) (i32.const ${code}))`)
  }
  emitFail(c); c.code.push(')')
  c.code.push('(local.set $pos (i32.add (local.get $pos) (i32.const 1)))')
}

const compileAlt = (branches, c) => {
  const endLabel = `$alt_end_${c.labelId++}`
  c.code.push(`(block ${endLabel}`)
  for (let i = 0; i < branches.length; i++) {
    const isLast = i === branches.length - 1
    const tryLabel = `$alt_try_${c.labelId++}`
    if (!isLast) { c.code.push(`(block ${tryLabel}`); c.code.push('(local.set $save (local.get $pos))') }
    const saved = c.failLabel
    if (!isLast) c.failLabel = tryLabel
    compileNode(branches[i], c)
    c.failLabel = saved
    if (!isLast) {
      c.code.push(`(br ${endLabel})`); c.code.push(')') // end try block
      c.code.push('(local.set $pos (local.get $save))')
    }
  }
  c.code.push(')')
}

const compileRepeatN = (node, min, max, greedy, c) => {
  const loopLabel = `$rep_loop_${c.labelId++}`, endLabel = `$rep_end_${c.labelId++}`
  const countLocal = `$count_${c.labelId++}`
  c.code.unshift(`(local ${countLocal} i32)`)
  c.code.push(`(local.set ${countLocal} (i32.const 0))`)

  if (greedy) {
    c.code.push(`(block ${endLabel}`); c.code.push(`(loop ${loopLabel}`)
    if (max !== Infinity) c.code.push(`(br_if ${endLabel} (i32.ge_u (local.get ${countLocal}) (i32.const ${max})))`)
    c.code.push('(local.set $save (local.get $pos))')
    const tryLabel = `$rep_try_${c.labelId++}`
    c.code.push(`(block ${tryLabel}`)
    const saved = c.failLabel; c.failLabel = tryLabel
    compileNode(node, c); c.failLabel = saved
    c.code.push(`(local.set ${countLocal} (i32.add (local.get ${countLocal}) (i32.const 1)))`)
    c.code.push(`(br ${loopLabel})`); c.code.push(')') // end try
    c.code.push('(local.set $pos (local.get $save))')
    c.code.push(')'); c.code.push(')') // end loop, block
  } else {
    for (let i = 0; i < min; i++) compileNode(node, c)
    if (max > min) {
      c.code.push(`(block ${endLabel}`); c.code.push(`(loop ${loopLabel}`)
      if (max !== Infinity) c.code.push(`(br_if ${endLabel} (i32.ge_u (local.get ${countLocal}) (i32.const ${max - min})))`)
      c.code.push('(local.set $save (local.get $pos))')
      const tryLabel = `$rep_try_${c.labelId++}`
      c.code.push(`(block ${tryLabel}`)
      const saved = c.failLabel; c.failLabel = tryLabel
      compileNode(node, c); c.failLabel = saved
      c.code.push(`(local.set ${countLocal} (i32.add (local.get ${countLocal}) (i32.const 1)))`)
      c.code.push(`(br ${loopLabel})`); c.code.push(')')
      c.code.push('(local.set $pos (local.get $save))')
      c.code.push(')'); c.code.push(')')
    }
  }

  if (min > 0 && greedy) {
    c.code.push(`(if (i32.lt_u (local.get ${countLocal}) (i32.const ${min}))`)
    emitFail(c); c.code.push(')')
  }
}

const compileClassItem = (item, c) => {
  if (typeof item === 'string') {
    const code = item.charCodeAt(0)
    if (c.ignoreCase && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) {
      const lo = code | 32, hi = lo - 32
      return `(i32.or (i32.eq (local.get $char) (i32.const ${lo})) (i32.eq (local.get $char) (i32.const ${hi})))`
    }
    return `(i32.eq (local.get $char) (i32.const ${code}))`
  }
  if (Array.isArray(item)) {
    if (item[0] === '-') {
      const lo = item[1].charCodeAt(0), hi = item[2].charCodeAt(0)
      if (c.ignoreCase && lo >= 65 && hi <= 122) {
        const loL = lo | 32, loU = lo & ~32, hiL = hi | 32, hiU = hi & ~32
        return `(i32.or (i32.and (i32.ge_u (local.get $char) (i32.const ${loL})) (i32.le_u (local.get $char) (i32.const ${hiL}))) (i32.and (i32.ge_u (local.get $char) (i32.const ${loU})) (i32.le_u (local.get $char) (i32.const ${hiU}))))`
      }
      return `(i32.and (i32.ge_u (local.get $char) (i32.const ${lo})) (i32.le_u (local.get $char) (i32.const ${hi})))`
    }
    if (item[0] === '\\d') return CHAR_CLASS_WAT.d
    if (item[0] === '\\w') return CHAR_CLASS_WAT.w
    if (item[0] === '\\s') return CHAR_CLASS_WAT.s
  }
  return null
}

const compileClassN = (items, negated, c) => {
  c.code.push('(if (i32.ge_u (local.get $pos) (local.get $len))'); emitFail(c); c.code.push(')')
  c.code.push(LOAD_CHAR)
  const tests = items.map(i => compileClassItem(i, c)).filter(Boolean)
  const condition = tests.length === 1 ? tests[0] : tests.reduce((a, b) => `(i32.or ${a} ${b})`)
  const check = negated ? `(i32.eqz ${condition})` : condition
  c.code.push(`(if (i32.eqz ${check})`); emitFail(c); c.code.push(')')
  c.code.push('(local.set $pos (i32.add (local.get $pos) (i32.const 1)))')
}

const compileCharClassN = (cls, negated, c) => {
  c.code.push('(if (i32.ge_u (local.get $pos) (local.get $len))'); emitFail(c); c.code.push(')')
  c.code.push(LOAD_CHAR)
  const condition = CHAR_CLASS_WAT[cls]
  const check = negated ? condition : `(i32.eqz ${condition})`
  c.code.push(`(if ${check}`); emitFail(c); c.code.push(')')
  c.code.push('(local.set $pos (i32.add (local.get $pos) (i32.const 1)))')
}

const compileDot = c => {
  c.code.push('(if (i32.ge_u (local.get $pos) (local.get $len))'); emitFail(c); c.code.push(')')
  if (!c.dotAll) {
    c.code.push(LOAD_CHAR)
    c.code.push('(if (i32.eq (local.get $char) (i32.const 10))'); emitFail(c); c.code.push(')')
  }
  c.code.push('(local.set $pos (i32.add (local.get $pos) (i32.const 1)))')
}

const compileAnchorStart = c => {
  c.code.push('(if (i32.ne (local.get $pos) (i32.const 0))'); emitFail(c); c.code.push(')')
}

const compileAnchorEnd = c => {
  c.code.push('(if (i32.ne (local.get $pos) (local.get $len))'); emitFail(c); c.code.push(')')
}

const compileCapture = (inner, groupId, c) => {
  c.code.push(`(local.set $g${groupId}_start (local.get $pos))`)
  compileNode(inner, c)
  c.code.push(`(local.set $g${groupId}_end (local.get $pos))`)
}

const compileLookahead = (inner, positive, c) => {
  c.code.push('(local.set $save (local.get $pos))')
  const label = `$look_${c.labelId++}`
  c.code.push(`(block ${label}`)
  const saved = c.failLabel; c.failLabel = label
  compileNode(inner, c); c.failLabel = saved
  c.code.push('(local.set $match (i32.const 1))')
  c.code.push(`(br ${label})`); c.code.push(')')
  c.code.push('(local.set $pos (local.get $save))')
  if (positive) { c.code.push('(if (i32.eqz (local.get $match))'); emitFail(c); c.code.push(')') }
  else { c.code.push('(if (local.get $match)'); emitFail(c); c.code.push(')') }
  c.code.push('(local.set $match (i32.const 0))')
}

const compileLookbehind = (inner, positive, c) => {
  c.code.push('(local.set $save (local.get $pos))')
  const len = patternMinLen(inner)
  if (len > 0) {
    c.code.push(`(if (i32.lt_u (local.get $pos) (i32.const ${len}))`)
    if (positive) { emitFail(c); c.code.push(')') }
    else c.code.push('(then (nop)))')
    c.code.push(`(local.set $pos (i32.sub (local.get $pos) (i32.const ${len})))`)
    const label = `$lookb_${c.labelId++}`
    c.code.push(`(block ${label}`)
    const saved = c.failLabel; c.failLabel = label
    compileNode(inner, c); c.failLabel = saved
    c.code.push('(local.set $match (i32.const 1))')
    c.code.push(`(br ${label})`); c.code.push(')')
    c.code.push('(local.set $pos (local.get $save))')
    if (positive) { c.code.push('(if (i32.eqz (local.get $match))'); emitFail(c); c.code.push(')') }
    else { c.code.push('(if (local.get $match)'); emitFail(c); c.code.push(')') }
    c.code.push('(local.set $match (i32.const 0))')
  }
}

const compileWordBoundary = (negated, c) => {
  const isWord = CHAR_CLASS_WAT.w
  c.code.push('(local.set $match (i32.const 0))')
  c.code.push('(if (i32.gt_u (local.get $pos) (i32.const 0))')
  c.code.push('(then')
  c.code.push('(local.set $char (i32.load8_u (i32.add (local.get $str) (i32.sub (local.get $pos) (i32.const 1)))))')
  c.code.push(`(local.set $match ${isWord})`)
  c.code.push('))')
  c.code.push('(local.set $save (local.get $match))')
  c.code.push('(local.set $match (i32.const 0))')
  c.code.push('(if (i32.lt_u (local.get $pos) (local.get $len))')
  c.code.push('(then')
  c.code.push(LOAD_CHAR)
  c.code.push(`(local.set $match ${isWord})`)
  c.code.push('))')
  c.code.push('(local.set $match (i32.xor (local.get $save) (local.get $match)))')
  if (negated) c.code.push('(if (local.get $match)')
  else c.code.push('(if (i32.eqz (local.get $match))')
  emitFail(c); c.code.push(')')
}

const compileBackref = (n, c) => {
  const sL = `$g${n}_start`, eL = `$g${n}_end`
  const loopL = `$backref_${c.labelId++}`, endL = `$backref_end_${c.labelId++}`
  const iL = `$br_i_${c.labelId++}`
  c.code.unshift(`(local ${iL} i32)`)
  c.code.push(`(local.set ${iL} (local.get ${sL}))`)
  c.code.push(`(block ${endL}`); c.code.push(`(loop ${loopL}`)
  c.code.push(`(br_if ${endL} (i32.ge_u (local.get ${iL}) (local.get ${eL})))`)
  c.code.push('(if (i32.ge_u (local.get $pos) (local.get $len))'); emitFail(c); c.code.push(')')
  c.code.push(`(local.set $char (i32.load8_u (i32.add (local.get $str) (local.get ${iL}))))`)
  c.code.push(`(local.set $save (i32.load8_u (i32.add (local.get $str) (local.get $pos))))`)
  if (c.ignoreCase) {
    c.code.push('(if (i32.and (i32.ne (i32.or (local.get $char) (i32.const 32)) (i32.or (local.get $save) (i32.const 32))) (i32.or (i32.lt_u (local.get $char) (i32.const 65)) (i32.gt_u (local.get $char) (i32.const 122))))')
  } else {
    c.code.push('(if (i32.ne (local.get $char) (local.get $save))')
  }
  emitFail(c); c.code.push(')')
  c.code.push(`(local.set ${iL} (i32.add (local.get ${iL}) (i32.const 1)))`)
  c.code.push('(local.set $pos (i32.add (local.get $pos) (i32.const 1)))')
  c.code.push(`(br ${loopL})`); c.code.push(')'); c.code.push(')')
}

const patternMinLen = node => {
  if (typeof node === 'string') return 1
  if (!Array.isArray(node)) return 0
  const [op, ...args] = node
  switch (op) {
    case 'seq': return args.reduce((s, a) => s + patternMinLen(a), 0)
    case '|': return Math.min(...args.map(patternMinLen))
    case '*': case '*?': case '?': case '??': return 0
    case '+': case '+?': return patternMinLen(args[0])
    case '{}': case '{}?': return args[1] * patternMinLen(args[0])
    case '[]': case '[^]': case '.': return 1
    case '\\d': case '\\D': case '\\w': case '\\W': case '\\s': case '\\S': return 1
    case '()': case '(?:)': return patternMinLen(args[0])
    case '(?=)': case '(?!)': case '(?<=)': case '(?<!)': return 0
    case '^': case '$': case '\\b': case '\\B': return 0
    default: return 0
  }
}


// === Module init ===

export default (ctx) => {
  Object.assign(ctx.core.stdlibDeps, {
    __str_to_buf: ['__str_byteLen', '__char_at'],
  })

  ctx.runtime.regex = { count: 0, vars: new Map(), compiled: new Map(), groups: new Map() }

  // SSO → heap normalizer: returns data offset (i32) for direct byte access.
  // Heap STRING: aux bit SSO_BIT is 0 → offset already points at bytes.
  // SSO STRING:  aux bit SSO_BIT is 1 → bytes are packed in offset; spill to heap.
  ctx.core.stdlib['__str_to_buf'] = `(func $__str_to_buf (param $ptr i64) (result i32)
    (local $aux i32) (local $off i32) (local $len i32) (local $buf i32) (local $i i32)
    (local.set $aux (call $__ptr_aux (local.get $ptr)))
    (if (i32.eqz (i32.and (local.get $aux) (i32.const ${LAYOUT.SSO_BIT})))
      (then (return (call $__ptr_offset (local.get $ptr)))))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (local.set $len (i32.and (local.get $aux) (i32.const 7)))
    (local.set $buf (call $__alloc (local.get $len)))
    (local.set $i (i32.const 0))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (local.get $buf) (local.get $i))
        (i32.and (i32.shr_u (local.get $off) (i32.mul (local.get $i) (i32.const 8))) (i32.const 0xFF)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (local.get $buf))`

  /** Compile regex pattern to WASM function, return regex ID */
  const compileRegexToStdlib = (pattern, flags) => {
    const key = pattern + ':' + (flags || '')
    if (ctx.runtime.regex.compiled.has(key)) return ctx.runtime.regex.compiled.get(key)
    const id = ctx.runtime.regex.count++
    const ast = parseRegex(pattern, flags)
    const funcName = `__regex_${id}`
    // Reserve mutable globals for capture group start/end (shared across regexes by index)
    for (let i = 1; i <= (ast.groups || 0); i++) {
      if (!ctx.scope.globals.has(`__re_g${i}_start`)) {
        ctx.scope.globals.set(`__re_g${i}_start`, `(global $__re_g${i}_start (mut i32) (i32.const -1))`)
        ctx.scope.globals.set(`__re_g${i}_end`, `(global $__re_g${i}_end (mut i32) (i32.const -1))`)
      }
    }
    ctx.runtime.regex.groups.set(id, ast.groups || 0)
    ctx.core.stdlib[funcName] = compileRegex(ast, funcName)

    // Search wrapper: tries match at each position, returns (match_start, match_end) via locals
    const searchName = `__regex_search_${id}`
    ctx.core.stdlib[searchName] = `(func $${searchName} (param $str i64) (result i32 i32)
      (local $off i32) (local $len i32) (local $pos i32) (local $result i32)
      (local.set $off (call $__str_to_buf (local.get $str)))
      (local.set $len (call $__str_byteLen (local.get $str)))
      (local.set $pos (i32.const 0))
      (block $done (loop $next
        (br_if $done (i32.gt_s (local.get $pos) (local.get $len)))
        (local.set $result (call $${funcName} (local.get $off) (local.get $len) (local.get $pos)))
        (if (i32.ge_s (local.get $result) (i32.const 0))
          (then (return (local.get $pos) (local.get $result))))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (br $next)))
      (i32.const -1) (i32.const -1))`

    inc(funcName, searchName, '__str_to_buf')
    ctx.runtime.regex.compiled.set(key, id)
    return id
  }

  /** Resolve regex ID from AST node (inline regex or variable) */
  const resolveRegex = (obj) => {
    if (Array.isArray(obj) && obj[0] === '//') return compileRegexToStdlib(obj[1], obj[2])
    if (typeof obj === 'string' && ctx.runtime.regex.vars.has(obj)) {
      const ast = ctx.runtime.regex.vars.get(obj)
      return compileRegexToStdlib(ast[1], ast[2])
    }
    return null
  }

  // Regex literal: ['//','pattern','flags?'] → compile + store
  ctx.core.emit['//'] = (pattern, flags) => {
    const id = compileRegexToStdlib(pattern, flags)
    ctx.runtime.regex._lastId = id // for variable tracking
    return typed(['i32.const', id], 'i32')
  }

  // regex.test(str) → search, return 1/0
  ctx.core.emit['.regex:test'] = (obj, str) => {
    const id = resolveRegex(obj)
    if (id == null) err('regex.test requires a known regex')
    const s = temp('rt'), mstart = tempI32('rms'), mend = tempI32('rme')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${mstart}`, ['local.set', `$${mend}`,
        ['call', `$__regex_search_${id}`, ['i64.reinterpret_f64', ['local.get', `$${s}`]]]]],
      // search returns (start, end) multi-value; capture both
      ['if', ['result', 'f64'], ['i32.ge_s', ['local.get', `$${mstart}`], ['i32.const', 0]],
        ['then', ['f64.const', 1]],
        ['else', ['f64.const', 0]]]], 'f64')
  }

  // regex.exec(str) → [match_text, cap1, ...] array or 0 (null)
  ctx.core.emit['.regex:exec'] = (obj, str) => {
    const id = resolveRegex(obj)
    if (id == null) err('regex.exec requires a known regex')
    const nGroups = ctx.runtime.regex.groups.get(id) || 0
    const s = temp('re'), ms = tempI32('rems'), me = tempI32('reme')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${ms}`, ['local.set', `$${me}`,
        ['call', `$__regex_search_${id}`, ['i64.reinterpret_f64', ['local.get', `$${s}`]]]]],
      ['if', ['result', 'f64'], ['i32.lt_s', ['local.get', `$${ms}`], ['i32.const', 0]],
        ['then', ['f64.const', 0]],
        ['else', buildMatchArr(s, ms, me, nGroups)]]], 'f64')
  }

  // str.search(/re/) → first match position or -1
  ctx.core.emit['.string:search'] = (str, search) => {
    const id = resolveRegex(search)
    if (id == null) {
      // Fall back to string search (indexOf)
      inc('__str_indexof')
      return typed(['f64.convert_i32_s', ['call', '$__str_indexof', asI64(emit(str)), asI64(emit(search)), ['i32.const', 0]]], 'f64')
    }
    const s = temp('ss'), ms = tempI32('ssms'), me = tempI32('ssme')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${ms}`, ['local.set', `$${me}`,
        ['call', `$__regex_search_${id}`, ['i64.reinterpret_f64', ['local.get', `$${s}`]]]]],
      ['f64.convert_i32_s', ['local.get', `$${ms}`]]], 'f64')
  }

  // str.match(/re/) → [match_text] or 0
  ctx.core.emit['.string:match'] = (str, search) => {
    const id = resolveRegex(search)
    if (id == null) {
      // Fall back to string match
      inc('__str_indexof', '__str_slice', '__wrap1', '__str_byteLen')
      const s = temp('ms'), q = temp('mq'), idx = tempI32('mi')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${s}`, asF64(emit(str))],
        ['local.set', `$${q}`, asF64(emit(search))],
        ['local.set', `$${idx}`, ['call', '$__str_indexof', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['i64.reinterpret_f64', ['local.get', `$${q}`]], ['i32.const', 0]]],
        ['if', ['result', 'f64'], ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]],
          ['then', ['f64.const', 0]],
          ['else',
            ['call', '$__wrap1',
              ['i64.reinterpret_f64',
                ['call', '$__str_slice', ['i64.reinterpret_f64', ['local.get', `$${s}`]],
                  ['local.get', `$${idx}`],
                  ['i32.add', ['local.get', `$${idx}`], ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${q}`]]]]]]]]]], 'f64')
    }
    const nGroups = ctx.runtime.regex.groups.get(id) || 0
    const s = temp('sm'), ms = tempI32('smms'), me = tempI32('smme')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${ms}`, ['local.set', `$${me}`,
        ['call', `$__regex_search_${id}`, ['i64.reinterpret_f64', ['local.get', `$${s}`]]]]],
      ['if', ['result', 'f64'], ['i32.lt_s', ['local.get', `$${ms}`], ['i32.const', 0]],
        ['then', ['f64.const', 0]],
        ['else', buildMatchArr(s, ms, me, nGroups)]]], 'f64')
  }

  // str.replace(/re/, repl) → replaced string
  ctx.core.emit['.string:replace'] = (str, search, repl) => {
    const id = resolveRegex(search)
    if (id == null) {
      // Fall back to string replace
      inc('__str_replace')
      return typed(['call', '$__str_replace', asI64(emit(str)), asI64(emit(search)), asI64(emit(repl))], 'f64')
    }
    inc('__str_slice', '__str_concat', '__str_byteLen')
    const s = temp('sr'), r = temp('srr'), ms = tempI32('srms'), me = tempI32('srme')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${r}`, asF64(emit(repl))],
      ['local.set', `$${ms}`, ['local.set', `$${me}`,
        ['call', `$__regex_search_${id}`, ['i64.reinterpret_f64', ['local.get', `$${s}`]]]]],
      ['if', ['result', 'f64'], ['i32.lt_s', ['local.get', `$${ms}`], ['i32.const', 0]],
        ['then', ['local.get', `$${s}`]],
        ['else',
          ['call', '$__str_concat',
            ['i64.reinterpret_f64', ['call', '$__str_concat',
              ['i64.reinterpret_f64', ['call', '$__str_slice', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['i32.const', 0], ['local.get', `$${ms}`]]],
              ['i64.reinterpret_f64', ['local.get', `$${r}`]]]],
            ['i64.reinterpret_f64', ['call', '$__str_slice', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['local.get', `$${me}`],
              ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]]]]]]], 'f64')
  }

  // str.split(/re/) → array of substrings
  ctx.core.emit['.string:split'] = (str, sep) => {
    const id = resolveRegex(sep)
    if (id == null) {
      // Fall back to string split
      inc('__str_split')
      return typed(['call', '$__str_split', asI64(emit(str)), asI64(emit(sep))], 'f64')
    }

    // Generate a split-by-regex WAT function for this regex
    const splitName = `__regex_split_${id}`
    if (!ctx.core.stdlib[splitName]) {
      inc('__str_to_buf', '__str_slice', '__alloc')
      ctx.core.stdlib[splitName] = `(func $${splitName} (param $str i64) (result f64)
        (local $off i32) (local $len i32) (local $pos i32) (local $result i32)
        (local $mstart i32) (local $mend i32) (local $prevEnd i32)
        (local $arrOff i32) (local $count i32) (local $cap i32)
        (local $newArr i32) (local $j i32)
        (local.set $off (call $__str_to_buf (local.get $str)))
        (local.set $len (call $__str_byteLen (local.get $str)))
        ;; Alloc result array (cap=8 initially)
        (local.set $cap (i32.const 8))
        (local.set $arrOff (call $__alloc (i32.add (i32.const 8) (i32.mul (local.get $cap) (i32.const 8)))))
        (local.set $prevEnd (i32.const 0))
        (local.set $count (i32.const 0))
        (local.set $pos (i32.const 0))
        (block $done (loop $next
          (br_if $done (i32.gt_s (local.get $pos) (local.get $len)))
          (local.set $result (call $__regex_${id} (local.get $off) (local.get $len) (local.get $pos)))
          (if (i32.lt_s (local.get $result) (i32.const 0))
            (then
              ;; No match at this position — advance and try next
              (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
              (br $next)))
          ;; Found match at $pos..$result — slice prevEnd..pos into array
          (local.set $mstart (local.get $pos))
          (local.set $mend (local.get $result))
          ;; Grow array if at capacity
          (if (i32.ge_u (local.get $count) (local.get $cap))
            (then
              (local.set $cap (i32.shl (local.get $cap) (i32.const 1)))
              (local.set $newArr (call $__alloc (i32.add (i32.const 8) (i32.mul (local.get $cap) (i32.const 8)))))
              (local.set $j (i32.const 0))
              (block $cd (loop $cl
                (br_if $cd (i32.ge_s (local.get $j) (local.get $count)))
                (f64.store (i32.add (i32.add (local.get $newArr) (i32.const 8)) (i32.shl (local.get $j) (i32.const 3)))
                  (f64.load (i32.add (i32.add (local.get $arrOff) (i32.const 8)) (i32.shl (local.get $j) (i32.const 3)))))
                (local.set $j (i32.add (local.get $j) (i32.const 1)))
                (br $cl)))
              (local.set $arrOff (local.get $newArr))))
          (f64.store (i32.add (i32.add (local.get $arrOff) (i32.const 8)) (i32.mul (local.get $count) (i32.const 8)))
            (call $__str_slice (local.get $str) (local.get $prevEnd) (local.get $mstart)))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))
          (local.set $prevEnd (local.get $mend))
          ;; Advance past match (at least 1 to avoid infinite loop on zero-length match)
          (local.set $pos (select (i32.add (local.get $mend) (i32.const 1)) (local.get $mend) (i32.eq (local.get $mstart) (local.get $mend))))
          (br $next)))
        ;; Final segment: prevEnd..len — grow if needed
        (if (i32.ge_u (local.get $count) (local.get $cap))
          (then
            (local.set $cap (i32.shl (local.get $cap) (i32.const 1)))
            (local.set $newArr (call $__alloc (i32.add (i32.const 8) (i32.mul (local.get $cap) (i32.const 8)))))
            (local.set $j (i32.const 0))
            (block $cd2 (loop $cl2
              (br_if $cd2 (i32.ge_s (local.get $j) (local.get $count)))
              (f64.store (i32.add (i32.add (local.get $newArr) (i32.const 8)) (i32.shl (local.get $j) (i32.const 3)))
                (f64.load (i32.add (i32.add (local.get $arrOff) (i32.const 8)) (i32.shl (local.get $j) (i32.const 3)))))
              (local.set $j (i32.add (local.get $j) (i32.const 1)))
              (br $cl2)))
            (local.set $arrOff (local.get $newArr))))
        (f64.store (i32.add (i32.add (local.get $arrOff) (i32.const 8)) (i32.mul (local.get $count) (i32.const 8)))
          (call $__str_slice (local.get $str) (local.get $prevEnd) (local.get $len)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; Write array header (len + cap at arrOff)
        (i32.store (local.get $arrOff) (local.get $count))
        (i32.store (i32.add (local.get $arrOff) (i32.const 4)) (local.get $cap))
        (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (i32.add (local.get $arrOff) (i32.const 8))))`
      inc(splitName)
    }

    return typed(['call', `$${splitName}`, asI64(emit(str))], 'f64')
  }
}
