/**
 * Regex module — parser, WAT codegen, and integration.
 *
 * Parses regex patterns into lispy AST, compiles to WASM matching functions.
 * Regex literals become compile-time WASM functions, methods dispatch statically.
 *
 * @module regex
 */

import { typed, asF64, asI64, UNDEF_NAN, NULL_NAN, mkPtrIR, temp, tempI32, toStrI64 } from '../src/ir.js'
import { emit, deps } from '../src/bridge.js'
import { ctx, err, inc, PTR, LAYOUT, registerGetter, declGlobal } from '../src/ctx.js'
import { valTypeOf } from '../src/kind.js'
import { VAL } from '../src/reps.js'

// Build IR that constructs a match array: [full, cap1, cap2, ...]
// strLocal, msLocal, meLocal are local names (i32 for ms/me, f64 for str).
// Captures read from globals $__re_g${i}_start / _end. -1 → undefined.
const buildMatchArr = (strLocal, msLocal, meLocal, nGroups, groupNames = []) => {
  const N = nGroups + 1
  inc('__alloc', '__mkptr', '__str_slice')
  const arr = tempI32('mka')
  const arrPtr = temp('mkap')
  const captures = []
  const named = []
  for (let i = 1; i <= nGroups; i++) {
    captures[i] = [tempI32('mkgs'), tempI32('mkge')]
    if (groupNames[i]) named.push([i, groupNames[i]])
  }
  if (named.length) {
    ctx.module.include('collection')
    inc('__hash_new_small', '__hash_set', '__dyn_set')
  }
  const captureValue = i => ['if', ['result', 'f64'],
    ['i32.lt_s', ['local.get', `$${captures[i][0]}`], ['i32.const', 0]],
    ['then', ['f64.const', `nan:${UNDEF_NAN}`]],
    ['else', ['call', '$__str_slice', ['i64.reinterpret_f64', ['local.get', `$${strLocal}`]],
      ['local.get', `$${captures[i][0]}`], ['local.get', `$${captures[i][1]}`]]]]
  const stmts = [
    ['local.set', `$${arr}`, ['call', '$__alloc', ['i32.const', 8 + N * 8]]],
    ['i32.store', ['local.get', `$${arr}`], ['i32.const', N]],
    ['i32.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', 4]], ['i32.const', N]],
    ['f64.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', 8]],
      ['call', '$__str_slice', ['i64.reinterpret_f64', ['local.get', `$${strLocal}`]],
        ['local.get', `$${msLocal}`], ['local.get', `$${meLocal}`]]],
  ]
  for (let i = 1; i <= nGroups; i++) {
    stmts.push(['local.set', `$${captures[i][0]}`, ['global.get', `$__re_g${i}_start`]])
    stmts.push(['local.set', `$${captures[i][1]}`, ['global.get', `$__re_g${i}_end`]])
  }
  for (let i = 1; i <= nGroups; i++) {
    stmts.push(['f64.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', 8 + i * 8]],
      captureValue(i)])
  }
  stmts.push(['local.set', `$${arrPtr}`, mkPtrIR(PTR.ARRAY, 0, ['i32.add', ['local.get', `$${arr}`], ['i32.const', 8]])])
  if (named.length) {
    const groups = temp('mkg')
    stmts.push(['local.set', `$${groups}`, ['call', '$__hash_new_small']])
    for (const [i, name] of named) {
      stmts.push(['local.set', `$${groups}`,
        ['f64.reinterpret_i64', ['call', '$__hash_set',
          ['i64.reinterpret_f64', ['local.get', `$${groups}`]],
          asI64(emit(['str', name])),
          ['i64.reinterpret_f64', captureValue(i)]]]])
    }
    stmts.push(['drop', ['call', '$__dyn_set',
      ['i64.reinterpret_f64', ['local.get', `$${arrPtr}`]],
      asI64(emit(['str', 'groups'])),
      ['i64.reinterpret_f64', ['local.get', `$${groups}`]]]])
  }
  stmts.push(['local.get', `$${arrPtr}`])
  return ['block', ['result', 'f64'], ...stmts]
}

// === Parser ===

const PIPE = 124, STAR = 42, PLUS = 43, QUEST = 63, DOT = 46,
  LBRACK = 91, RBRACK = 93, LPAREN = 40, RPAREN = 41,
  LBRACE = 123, RBRACE = 125, CARET = 94, DOLLAR = 36,
  BSLASH = 92, DASH = 45, COLON = 58, EQUAL = 61, EXCL = 33, LT = 60, GT = 62

let src, idx, groupNum, groupNames

const cur = () => src.charCodeAt(idx),
  peek = () => src[idx],
  skip = (n = 1) => (idx += n, src[idx - n]),
  eof = () => idx >= src.length,
  perr = msg => { throw SyntaxError(`Regex: ${msg} at ${idx}`) }

/** Parse regex pattern → AST */
export const parseRegex = (pattern, flags = '') => {
  src = pattern; idx = 0; groupNum = 0; groupNames = []
  let ast = parseAlt()
  if (!eof()) perr('Unexpected ' + peek())
  if (typeof ast === 'string') ast = ['seq', ast]
  if (flags) ast.flags = flags
  ast.groups = groupNum
  if (groupNames.length) ast.groupNames = groupNames
  resolveNamedBackrefs(ast, groupNames)
  return ast
}

// Rewrite ['\k', name] placeholders → the SAME ['\N'] node numbered backrefs
// produce (in place, post-parse so forward references resolve). The match VM
// supports \1–\9 — a named group past index 9 can't be referenced by name.
const resolveNamedBackrefs = (node, names) => {
  if (!Array.isArray(node)) return
  if (node[0] === '\\k') {
    const i = names.indexOf(node[1])
    if (i < 0) perr(`Named backreference to undefined group '${node[1]}'`)
    if (i > 9) perr('Named backreference to a group past index 9 unsupported')
    node.length = 1
    node[0] = '\\' + i
    return
  }
  for (let j = 1; j < node.length; j++) resolveNamedBackrefs(node[j], names)
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
    else if (c === LBRACE && isRepeatStart()) { node = parseRepeat(node) }
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

const isRepeatStart = () => {
  let i = idx + 1
  if (src.charCodeAt(i) < 48 || src.charCodeAt(i) > 57) return false
  while (src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57) i++
  if (src.charCodeAt(i) === RBRACE) return true
  if (src.charCodeAt(i) !== 44) return false
  i++
  while (src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57) i++
  return src.charCodeAt(i) === RBRACE
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
    if (c === 'p' || c === 'P') perr('Unicode property escape \\p{…} unsupported')
    return parseEscapeChar()
  }
  return skip()
}

const parseEscape = () => {
  skip()
  const c = peek()
  if (c >= '1' && c <= '9') { skip(); return ['\\' + c] }
  // \k<name> — parse to a placeholder; parseRegex resolves it to the group's
  // NUMBERED backref node once all groups are known (forward refs included),
  // so the compile/match VM needs no new cases.
  if (c === 'k' && src.charCodeAt(idx + 1) === LT) { skip(); skip(); return ['\\k', parseGroupName()] }
  // \p{…}/\P{…} need the Unicode property tables (multi-KB) — out of scope.
  // Falling through would match the LITERAL text "p{…}" — silently wrong.
  if (c === 'p' || c === 'P') perr('Unicode property escape \\p{…} unsupported')
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
  let type = '()', groupId = null, groupName = null
  if (cur() === QUEST) {
    skip(); const c = cur()
    if (c === COLON) { skip(); type = '(?:)' }
    else if (c === EQUAL) { skip(); type = '(?=)' }
    else if (c === EXCL) { skip(); type = '(?!)' }
    else if (c === LT) {
      skip(); const c2 = cur()
      if (c2 === EQUAL) { skip(); type = '(?<=)' }
      else if (c2 === EXCL) { skip(); type = '(?<!)' }
      else { groupName = parseGroupName(); groupId = ++groupNum }
    } else perr('Invalid group syntax')
  } else groupId = ++groupNum
  const inner = parseAlt()
  cur() === RPAREN || perr('Unclosed ('); skip()
  if (groupName) groupNames[groupId] = groupName
  // Carry the capture name IN the group node (4th element) as well as the module-level
  // groupNames array. The AST structure survives the parse→compile handoff intact (it
  // drives codegen), whereas the self-host kernel drops mutations to the module-level
  // groupNames array — so `.groups` was never built. compileRegexToStdlib reads names
  // back via collectGroupNames(ast), which works in both legs.
  return groupId ? (groupName ? [type, inner, groupId, groupName] : [type, inner, groupId]) : [type, inner]
}

// Walk a parsed regex AST and return a `groupId → name` array for named captures,
// sourced from the group nodes' 4th element (set by parseGroup). Kernel-safe: relies
// only on the surviving AST structure, not module-level parse state.
const collectGroupNames = (node, out = []) => {
  if (!Array.isArray(node)) return out
  if (node[0] === '()' && typeof node[2] === 'number' && typeof node[3] === 'string') out[node[2]] = node[3]
  for (let i = 1; i < node.length; i++) collectGroupNames(node[i], out)
  return out
}

const isGroupNameStart = c =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95

const isGroupNameContinue = c => isGroupNameStart(c) || (c >= 48 && c <= 57)

const parseGroupName = () => {
  const start = idx
  isGroupNameStart(cur()) || perr('Invalid group name')
  skip()
  while (!eof() && cur() !== GT) {
    isGroupNameContinue(cur()) || perr('Invalid group name')
    skip()
  }
  cur() === GT || perr('Unclosed group name')
  const name = src.slice(start, idx)
  skip()
  return name
}


// === WAT Codegen ===

const CHAR_CLASS_WAT = {
  d: '(i32.and (i32.ge_u (local.get $char) (i32.const 48)) (i32.le_u (local.get $char) (i32.const 57)))',
  w: '(i32.or (i32.or (i32.and (i32.ge_u (local.get $char) (i32.const 97)) (i32.le_u (local.get $char) (i32.const 122))) (i32.and (i32.ge_u (local.get $char) (i32.const 65)) (i32.le_u (local.get $char) (i32.const 90)))) (i32.or (i32.and (i32.ge_u (local.get $char) (i32.const 48)) (i32.le_u (local.get $char) (i32.const 57))) (i32.eq (local.get $char) (i32.const 95))))',
  // SP(32) TAB(9) LF(10) CR(13) VT(11) FF(12); NBSP/Unicode-Zs are multibyte under UTF-8 — out of scope
  s: '(i32.or (i32.or (i32.or (i32.eq (local.get $char) (i32.const 32)) (i32.eq (local.get $char) (i32.const 9))) (i32.or (i32.eq (local.get $char) (i32.const 10)) (i32.eq (local.get $char) (i32.const 13)))) (i32.or (i32.eq (local.get $char) (i32.const 11)) (i32.eq (local.get $char) (i32.const 12))))'
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
  deps({
    __str_to_buf: ['__str_byteLen', '__char_at'],
    __regexp_escape: ['__to_str', '__str_byteLen', '__char_at', '__alloc', '__mkptr', '__sso_norm'],
  })

  // RegExp.escape (ES2025) — escape a string for literal use inside a pattern.
  // Spec sets, as jz UTF-8 byte tests (non-ASCII bytes are never regex-special
  // and pass through; the spec's astral/whitespace \u-escapes don't arise in a
  // byte-wise engine): SyntaxCharacter+`/` get a backslash; t/n/v/f/r their
  // control escape; other punctuators + space `\xHH` (lowercase); an ASCII
  // alnum FIRST char `\xHH` (so concatenating into a pattern can't fuse with a
  // preceding token). Worst case 4 bytes per input byte.
  const or = (tests) => tests.length === 1 ? tests[0] : `(i32.or ${tests[0]} ${or(tests.slice(1))})`
  const eqAny = (codes) => or(codes.map(n => `(i32.eq (local.get $c) (i32.const ${n}))`))
  const SYNTAX = [94, 36, 92, 46, 42, 43, 63, 40, 41, 91, 93, 123, 125, 124, 47]  // ^$\.*+?()[]{}| /
  const CTRL = [[9, 116], [10, 110], [11, 118], [12, 102], [13, 114]]              // \t \n \v \f \r
  const HEXED = [44, 45, 61, 60, 62, 35, 38, 33, 37, 58, 59, 64, 126, 39, 96, 34, 32]  // ,-=<>#&!%:;@~'`" SP
  const alnum = `(i32.or (i32.or
      (i32.and (i32.ge_u (local.get $c) (i32.const 65)) (i32.le_u (local.get $c) (i32.const 90)))
      (i32.and (i32.ge_u (local.get $c) (i32.const 97)) (i32.le_u (local.get $c) (i32.const 122))))
      (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57))))`
  // \xHH writer (lowercase hex): "\\x" + hi + lo
  const hexOut = `
        (i32.store8 (i32.add (local.get $out) (local.get $j)) (i32.const 92))
        (i32.store8 (i32.add (local.get $out) (i32.add (local.get $j) (i32.const 1))) (i32.const 120))
        (local.set $hi (i32.shr_u (local.get $c) (i32.const 4)))
        (local.set $lo (i32.and (local.get $c) (i32.const 15)))
        (i32.store8 (i32.add (local.get $out) (i32.add (local.get $j) (i32.const 2)))
          (i32.add (local.get $hi) (select (i32.const 87) (i32.const 48) (i32.gt_u (local.get $hi) (i32.const 9)))))
        (i32.store8 (i32.add (local.get $out) (i32.add (local.get $j) (i32.const 3)))
          (i32.add (local.get $lo) (select (i32.const 87) (i32.const 48) (i32.gt_u (local.get $lo) (i32.const 9)))))
        (local.set $j (i32.add (local.get $j) (i32.const 4)))`
  const ctrlArms = CTRL.map(([code, esc]) => `
    (if (i32.eq (local.get $c) (i32.const ${code})) (then
        (i32.store8 (i32.add (local.get $out) (local.get $j)) (i32.const 92))
        (i32.store8 (i32.add (local.get $out) (i32.add (local.get $j) (i32.const 1))) (i32.const ${esc}))
        (local.set $j (i32.add (local.get $j) (i32.const 2)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))`).join('')
  ctx.core.stdlib['__regexp_escape'] = `(func $__regexp_escape (param $val i64) (result f64)
  (local $str i64) (local $slen i32) (local $base i32) (local $out i32)
  (local $i i32) (local $j i32) (local $c i32) (local $hi i32) (local $lo i32)
  (local.set $str (call $__to_str (local.get $val)))
  (local.set $slen (call $__str_byteLen (local.get $str)))
  (if (i32.eqz (local.get $slen))
    (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
  (local.set $base (call $__alloc (i32.add (i32.const 4) (i32.mul (local.get $slen) (i32.const 4)))))
  (local.set $out (i32.add (local.get $base) (i32.const 4)))
  (block $done (loop $loop
    (br_if $done (i32.ge_u (local.get $i) (local.get $slen)))
    (local.set $c (call $__char_at (local.get $str) (local.get $i)))
    ;; first char alnum → \\xHH
    (if (i32.and (i32.eqz (local.get $i)) ${alnum}) (then
        ${hexOut}
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    ;; syntax chars + '/' → backslash-prefixed
    (if ${eqAny(SYNTAX)} (then
        (i32.store8 (i32.add (local.get $out) (local.get $j)) (i32.const 92))
        (i32.store8 (i32.add (local.get $out) (i32.add (local.get $j) (i32.const 1))) (local.get $c))
        (local.set $j (i32.add (local.get $j) (i32.const 2)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    ;; control escapes${ctrlArms}
    ;; other punctuators + space → \\xHH
    (if ${eqAny(HEXED)} (then
        ${hexOut}
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    ;; passthrough
    (i32.store8 (i32.add (local.get $out) (local.get $j)) (local.get $c))
    (local.set $j (i32.add (local.get $j) (i32.const 1)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $loop)))
  (i32.store (local.get $base) (local.get $j))
  (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $out))))`
  ctx.core.emit['RegExp.escape'] = (value) => {
    inc('__regexp_escape')
    return typed(['call', '$__regexp_escape',
      value === undefined ? ['i64.const', UNDEF_NAN] : asI64(emit(value))], 'f64')
  }

  ctx.runtime.regex = { count: 0, vars: new Map(), compiled: new Map(), groups: new Map(), groupNames: new Map() }

  // SSO → heap normalizer: returns data offset (i32) for direct byte access.
  // Heap STRING: aux bit SSO_BIT is 0 → offset already points at bytes.
  // SSO STRING:  aux bit SSO_BIT is 1 → bytes are packed in offset; spill to heap.
  ctx.core.stdlib['__str_to_buf'] = `(func $__str_to_buf (param $ptr i64) (result i32)
    (local $aux i32) (local $off i32) (local $len i32) (local $buf i32) (local $i i32)
    (local.set $aux (call $__ptr_aux (local.get $ptr)))
    (if (i32.eqz (i32.and (local.get $aux) (i32.const ${LAYOUT.SSO_BIT})))
      (then (return (call $__ptr_offset (local.get $ptr)))))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (local.set $len (i32.and (i32.shr_u (local.get $aux) (i32.const 10)) (i32.const 7)))
    (local.set $buf (call $__alloc (local.get $len)))
    (local.set $i (i32.const 0))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      ;; 7-bit ASCII SSO: char i at payload bit i*7 (read from the full i64 ptr; chars 4-5 span aux).
      (i32.store8 (i32.add (local.get $buf) (local.get $i))
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.mul (i64.extend_i32_u (local.get $i)) (i64.const 7))) (i64.const 0x7f))))
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
        declGlobal(`__re_g${i}_start`, 'i32', -1)
        declGlobal(`__re_g${i}_end`, 'i32', -1)
      }
    }
    ctx.runtime.regex.groups.set(id, ast.groups || 0)
    ctx.runtime.regex.groupNames.set(id, collectGroupNames(ast))
    ctx.core.stdlib[funcName] = compileRegex(ast, funcName)

    // Search wrapper: tries match at each position, returns (match_start, match_end) via locals.
    // A STICKY regex (/y) anchors: exactly one attempt at the start position — a
    // forward scan is /g semantics, not /y (was silently identical before).
    const sticky = (flags || '').includes('y')
    const searchName = `__regex_search_${id}`
    ctx.core.stdlib[searchName] = sticky
      ? `(func $${searchName} (param $str i64) (result i32 i32)
      (local $off i32) (local $len i32) (local $result i32)
      (local.set $off (call $__str_to_buf (local.get $str)))
      (local.set $len (call $__str_byteLen (local.get $str)))
      (local.set $result (call $${funcName} (local.get $off) (local.get $len) (i32.const 0)))
      (if (i32.ge_s (local.get $result) (i32.const 0))
        (then (return (i32.const 0) (local.get $result))))
      (i32.const -1) (i32.const -1))`
      : `(func $${searchName} (param $str i64) (result i32 i32)
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

    // search_from: like search but starts at $fromPos (used by stateful exec).
    // Sticky: one attempt exactly at $fromPos (out-of-range → no match).
    const searchFromName = `__regex_search_from_${id}`
    ctx.core.stdlib[searchFromName] = sticky
      ? `(func $${searchFromName} (param $str i64) (param $fromPos i32) (result i32 i32)
      (local $off i32) (local $len i32) (local $result i32)
      (local.set $off (call $__str_to_buf (local.get $str)))
      (local.set $len (call $__str_byteLen (local.get $str)))
      (if (i32.gt_s (local.get $fromPos) (local.get $len))
        (then (return (i32.const -1) (i32.const -1))))
      (local.set $result (call $${funcName} (local.get $off) (local.get $len) (local.get $fromPos)))
      (if (i32.ge_s (local.get $result) (i32.const 0))
        (then (return (local.get $fromPos) (local.get $result))))
      (i32.const -1) (i32.const -1))`
      : `(func $${searchFromName} (param $str i64) (param $fromPos i32) (result i32 i32)
      (local $off i32) (local $len i32) (local $pos i32) (local $result i32)
      (local.set $off (call $__str_to_buf (local.get $str)))
      (local.set $len (call $__str_byteLen (local.get $str)))
      (local.set $pos (local.get $fromPos))
      (block $done (loop $next
        (br_if $done (i32.gt_s (local.get $pos) (local.get $len)))
        (local.set $result (call $${funcName} (local.get $off) (local.get $len) (local.get $pos)))
        (if (i32.ge_s (local.get $result) (i32.const 0))
          (then (return (local.get $pos) (local.get $result))))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (br $next)))
      (i32.const -1) (i32.const -1))`

    // lastIndex mutable global for /g or /y regexes — tracks position across exec() calls
    if ((flags || '').includes('g') || (flags || '').includes('y')) {
      const liGlobal = `__re_lastIndex_${id}`
      if (!ctx.scope.globals.has(liGlobal))
        declGlobal(liGlobal, 'i32')
    }

    inc(funcName, searchName, searchFromName, '__str_to_buf')
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

  // regex.exec(str) → [match_text, cap1, ...] array or null.
  // Mirrors JS: returns null (NULL_NAN) on no-match so `!== null` and while-loop idioms work.
  // For /g (and /y) regexes: stateful — reads lastIndex, advances on match, resets on miss.
  ctx.core.emit['.regex:exec'] = (obj, str) => {
    const id = resolveRegex(obj)
    if (id == null) err('regex.exec requires a known regex')
    const nGroups = ctx.runtime.regex.groups.get(id) || 0
    const groupNames = ctx.runtime.regex.groupNames.get(id) || []
    const flags = flagsOf(obj)
    const isGlobal = flags.includes('g') || flags.includes('y')
    const s = temp('re'), ms = tempI32('rems'), me = tempI32('reme')
    const nullIR = ['f64.const', `nan:${NULL_NAN}`]
    if (isGlobal) {
      // Stateful path: read lastIndex, search from there, update/reset lastIndex.
      const liGlobal = `$__re_lastIndex_${id}`
      inc(`__regex_search_from_${id}`)
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${s}`, asF64(emit(str))],
        ['local.set', `$${ms}`, ['local.set', `$${me}`,
          ['call', `$__regex_search_from_${id}`,
            ['i64.reinterpret_f64', ['local.get', `$${s}`]],
            ['global.get', liGlobal]]]],
        ['if', ['result', 'f64'], ['i32.lt_s', ['local.get', `$${ms}`], ['i32.const', 0]],
          // no match — reset lastIndex, return null
          ['then', ['global.set', liGlobal, ['i32.const', 0]], nullIR],
          // match — advance lastIndex past match end (bump by 1 for zero-length)
          ['else',
            ['global.set', liGlobal,
              ['select',
                ['i32.add', ['local.get', `$${me}`], ['i32.const', 1]],
                ['local.get', `$${me}`],
                ['i32.eq', ['local.get', `$${ms}`], ['local.get', `$${me}`]]]],
            buildMatchArr(s, ms, me, nGroups, groupNames)]]], 'f64')
    }
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${ms}`, ['local.set', `$${me}`,
        ['call', `$__regex_search_${id}`, ['i64.reinterpret_f64', ['local.get', `$${s}`]]]]],
      ['if', ['result', 'f64'], ['i32.lt_s', ['local.get', `$${ms}`], ['i32.const', 0]],
        ['then', nullIR],
        ['else', buildMatchArr(s, ms, me, nGroups, groupNames)]]], 'f64')
  }

  // === Regex instance properties ===
  // A regex value is a compile-time id; pattern + flags live in the literal AST
  // (`['//', pattern, flags]`) or in the regex-var table. Every property below
  // resolves entirely at compile time. Routed by the `.regex:<prop>` dispatch
  // added to core's `.` handler — registered with arity ≤ 1 (receiver only).

  /** Resolve a regex-typed operand to its `['//', pattern, flags]` literal AST. */
  const regexAstOf = (obj) => {
    if (Array.isArray(obj) && obj[0] === '//') return obj
    if (typeof obj === 'string' && ctx.runtime.regex.vars.has(obj)) return ctx.runtime.regex.vars.get(obj)
    return null
  }
  const flagsOf = (obj) => { const a = regexAstOf(obj); return (a && a[2]) || '' }

  // RegExp.prototype.source — the pattern text. A literal stores it verbatim
  // (already grammar-escaped), so `/A/.source` is the 6-char "A".
  // An empty pattern serializes to "(?:)" so the result re-parses to a regex.
  registerGetter('.regex:source', (obj) => {
    const a = regexAstOf(obj)
    return emit(['str', (a && a[1]) || '(?:)'])
  })

  // RegExp.prototype.flags — flag characters in canonical order (sec-get-regexp.prototype.flags).
  const FLAG_ORDER = 'dgimsvy'
  registerGetter('.regex:flags', (obj) => {
    const f = flagsOf(obj)
    return emit(['str', [...FLAG_ORDER].filter(c => f.includes(c)).join('')])
  })

  // Individual flag accessors → 1/0 (jz carries booleans as f64).
  for (const [prop, ch] of [
    ['global', 'g'], ['ignoreCase', 'i'], ['multiline', 'm'], ['dotAll', 's'],
    ['unicode', 'u'], ['sticky', 'y'], ['hasIndices', 'd'], ['unicodeSets', 'v'],
  ]) registerGetter(`.regex:${prop}`, (obj) => typed(['f64.const', flagsOf(obj).includes(ch) ? 1 : 0], 'f64'))

  // lastIndex — for /g and /y regexes, reads the mutable global; others always 0.
  registerGetter('.regex:lastIndex', (obj) => {
    const id = resolveRegex(obj)
    if (id != null) {
      const flags = flagsOf(obj)
      if (flags.includes('g') || flags.includes('y'))
        return typed(['f64.convert_i32_u', ['global.get', `$__re_lastIndex_${id}`]], 'f64')
    }
    return typed(['f64.const', 0], 'f64')
  })

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
    const groupNames = ctx.runtime.regex.groupNames.get(id) || []
    const s = temp('sm'), ms = tempI32('smms'), me = tempI32('smme')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${ms}`, ['local.set', `$${me}`,
        ['call', `$__regex_search_${id}`, ['i64.reinterpret_f64', ['local.get', `$${s}`]]]]],
      ['if', ['result', 'f64'], ['i32.lt_s', ['local.get', `$${ms}`], ['i32.const', 0]],
        ['then', ['f64.const', 0]],
        ['else', buildMatchArr(s, ms, me, nGroups, groupNames)]]], 'f64')
  }

  // str.replace(/re/, repl) → replaced string. With the `g` flag every match is
  // replaced (a per-regex loop, mirroring split); otherwise only the first.
  ctx.core.emit['.string:replace'] = (str, search, repl) => {
    const id = resolveRegex(search)
    const isFn = valTypeOf(repl) === VAL.CLOSURE && ctx.closure?.call
    // ToString(fn(matchStr)) → i64 string. The closure value is hoisted into
    // `fnL` once by the caller; each match passes its substring as the lone arg.
    const callbackRepl = (fnL, matchStrIR) =>
      ['call', '$__to_str', asI64(ctx.closure.call(typed(['local.get', `$${fnL}`], 'f64'), [matchStrIR]))]
    if (id == null) {
      if (isFn) {
        // String search + callback: replace the FIRST occurrence (spec: a string
        // search matches once). Mirror string.js `.replace`'s callback path.
        inc('__str_indexof', '__str_slice', '__str_concat', '__str_byteLen', '__to_str')
        const s = temp('rps'), q = temp('rpq'), fnL = temp('rpf'), idx = tempI32('rpi'), mlen = tempI32('rpm')
        const sI64 = () => ['i64.reinterpret_f64', ['local.get', `$${s}`]]
        const match = typed(['call', '$__str_slice', sI64(), ['local.get', `$${idx}`],
          ['i32.add', ['local.get', `$${idx}`], ['local.get', `$${mlen}`]]], 'f64')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${s}`, asF64(emit(str))],
          ['local.set', `$${q}`, asF64(emit(search))],
          ['local.set', `$${fnL}`, asF64(emit(repl))],
          ['local.set', `$${mlen}`, ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${q}`]]]],
          ['local.set', `$${idx}`, ['call', '$__str_indexof', sI64(), ['i64.reinterpret_f64', ['local.get', `$${q}`]], ['i32.const', 0]]],
          ['if', ['result', 'f64'], ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]],
            ['then', ['local.get', `$${s}`]],
            ['else', typed(['call', '$__str_concat',
              asI64(typed(['call', '$__str_concat',
                asI64(typed(['call', '$__str_slice', sI64(), ['i32.const', 0], ['local.get', `$${idx}`]], 'f64')),
                callbackRepl(fnL, match)], 'f64')),
              asI64(typed(['call', '$__str_slice', sI64(),
                ['i32.add', ['local.get', `$${idx}`], ['local.get', `$${mlen}`]],
                ['call', '$__str_byteLen', sI64()]], 'f64'))], 'f64')]]], 'f64')
      }
      // Fall back to string replace
      inc('__str_replace')
      return typed(['call', '$__str_replace', asI64(emit(str)), asI64(emit(search)), asI64(emit(repl))], 'f64')
    }
    inc('__str_slice', '__str_concat', '__str_byteLen')
    // Regex + callback: walk matches in IR (a WAT helper can't call a closure).
    // One unified loop covers /g (all matches) and non-/g (break after the first).
    if (isFn) {
      const global = flagsOf(search).includes('g')
      inc('__str_to_buf', '__to_str', `__regex_${id}`)
      const s = temp('rcs'), fnL = temp('rcf'), acc = temp('rca')
      const off = tempI32('rco'), len = tempI32('rcl'), pos = tempI32('rcp')
      const res = tempI32('rcr'), ms = tempI32('rcms'), me = tempI32('rcme'), pe = tempI32('rcpe')
      const sI64 = () => ['i64.reinterpret_f64', ['local.get', `$${s}`]]
      const accI64 = () => ['i64.reinterpret_f64', ['local.get', `$${acc}`]]
      const slice = (a, b) => typed(['call', '$__str_slice', sI64(), a, b], 'f64')
      const matchStr = slice(['local.get', `$${ms}`], ['local.get', `$${me}`])
      const step = [
        ['local.set', `$${res}`, ['call', `$__regex_${id}`, ['local.get', `$${off}`], ['local.get', `$${len}`], ['local.get', `$${pos}`]]],
        ['if', ['i32.lt_s', ['local.get', `$${res}`], ['i32.const', 0]],
          ['then', ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]], ['br', '$next']]],
        ['local.set', `$${ms}`, ['local.get', `$${pos}`]],
        ['local.set', `$${me}`, ['local.get', `$${res}`]],
        ['local.set', `$${acc}`, ['call', '$__str_concat', accI64(), asI64(slice(['local.get', `$${pe}`], ['local.get', `$${ms}`]))]],
        ['local.set', `$${acc}`, ['call', '$__str_concat', accI64(), callbackRepl(fnL, matchStr)]],
        ['local.set', `$${pe}`, ['local.get', `$${me}`]],
        ...(global ? [] : [['br', '$done']]),
        ['local.set', `$${pos}`, ['select', ['i32.add', ['local.get', `$${me}`], ['i32.const', 1]], ['local.get', `$${me}`], ['i32.eq', ['local.get', `$${ms}`], ['local.get', `$${me}`]]]],
        ['br', '$next'],
      ]
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${s}`, asF64(emit(str))],
        ['local.set', `$${fnL}`, asF64(emit(repl))],
        ['local.set', `$${off}`, ['call', '$__str_to_buf', sI64()]],
        ['local.set', `$${len}`, ['call', '$__str_byteLen', sI64()]],
        ['local.set', `$${pe}`, ['i32.const', 0]],
        ['local.set', `$${pos}`, ['i32.const', 0]],
        ['local.set', `$${acc}`, slice(['i32.const', 0], ['i32.const', 0])],
        ['block', '$done', ['loop', '$next',
          ['br_if', '$done', ['i32.gt_s', ['local.get', `$${pos}`], ['local.get', `$${len}`]]],
          ...step]],
        ['call', '$__str_concat', accI64(), asI64(slice(['local.get', `$${pe}`], ['local.get', `$${len}`]))]], 'f64')
    }
    // Global replace: walk every match, accumulating slice(prevEnd,matchStart)+repl.
    // Empty seed via slice(str,0,0); zero-length matches advance by 1 (per split).
    if (flagsOf(search).includes('g')) {
      const replName = `__regex_replace_${id}`
      if (!ctx.core.stdlib[replName]) {
        inc('__str_to_buf')
        ctx.core.stdlib[replName] = `(func $${replName} (param $str i64) (param $repl i64) (result f64)
          (local $off i32) (local $len i32) (local $pos i32) (local $result i32)
          (local $mstart i32) (local $mend i32) (local $prevEnd i32) (local $acc f64)
          (local.set $off (call $__str_to_buf (local.get $str)))
          (local.set $len (call $__str_byteLen (local.get $str)))
          (local.set $prevEnd (i32.const 0))
          (local.set $pos (i32.const 0))
          (local.set $acc (call $__str_slice (local.get $str) (i32.const 0) (i32.const 0)))
          (block $done (loop $next
            (br_if $done (i32.gt_s (local.get $pos) (local.get $len)))
            (local.set $result (call $__regex_${id} (local.get $off) (local.get $len) (local.get $pos)))
            (if (i32.lt_s (local.get $result) (i32.const 0))
              (then (local.set $pos (i32.add (local.get $pos) (i32.const 1))) (br $next)))
            (local.set $mstart (local.get $pos))
            (local.set $mend (local.get $result))
            (local.set $acc (call $__str_concat (i64.reinterpret_f64 (local.get $acc))
              (i64.reinterpret_f64 (call $__str_slice (local.get $str) (local.get $prevEnd) (local.get $mstart)))))
            (local.set $acc (call $__str_concat (i64.reinterpret_f64 (local.get $acc)) (local.get $repl)))
            (local.set $prevEnd (local.get $mend))
            (local.set $pos (select (i32.add (local.get $mend) (i32.const 1)) (local.get $mend) (i32.eq (local.get $mstart) (local.get $mend))))
            (br $next)))
          (call $__str_concat (i64.reinterpret_f64 (local.get $acc))
            (i64.reinterpret_f64 (call $__str_slice (local.get $str) (local.get $prevEnd) (local.get $len)))))`
        inc(replName)
      }
      return typed(['call', `$${replName}`, asI64(emit(str)), asI64(emit(repl))], 'f64')
    }
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

  // str.matchAll(/re/g) → array of match arrays (each like exec's result: full
  // match at [0], capture groups after, named groups under `.groups`). JS yields
  // a lazy iterator, but an array satisfies both `[...m]` and `for (const x of m)`.
  // Two-pass over the same anchored matcher: count, then fill a sized array.
  ctx.core.emit['.string:matchAll'] = (str, search) => {
    const id = resolveRegex(search)
    if (id == null) err('matchAll requires a regex argument')
    // ES 22.1.3.14: matchAll throws TypeError without /g — flags are static here,
    // so fail at compile instead of scanning once like /g anyway (silent-wrong).
    if (!flagsOf(search).includes('g')) err('matchAll requires the /g flag (TypeError in JS)')
    const nGroups = ctx.runtime.regex.groups.get(id) || 0
    const groupNames = ctx.runtime.regex.groupNames.get(id) || []
    inc('__str_to_buf', '__str_byteLen', '__alloc', '__mkptr', `__regex_${id}`)
    const s = temp('mas'), outArr = tempI32('mao')
    return matchAllImpl(asF64(emit(str)), id, nGroups, groupNames, s, outArr)
  }
  // Generic twin (unknown receiver): ES String.prototype.matchAll ToString-
  // coerces its receiver, so route through the coercion into the same scan.
  // Its presence also arms emit's runtime string-fork — with ONLY the
  // `.string:` key, an untyped receiver (`let src = tbl[k]` narrowed by a
  // typeof-continue guard the static types can't follow) fell through to the
  // dyn-prop probe, yielded `undefined`, and for-of swallowed it SILENTLY —
  // the self-host global-snapshot sweep scanned nothing (byte-parity root #2,
  // pinned in test/regex.js).
  ctx.core.emit['.matchAll'] = (str, search) => {
    const id = resolveRegex(search)
    if (id == null) err('matchAll requires a regex argument')
    if (!flagsOf(search).includes('g')) err('matchAll requires the /g flag (TypeError in JS)')
    const nGroups = ctx.runtime.regex.groups.get(id) || 0
    const groupNames = ctx.runtime.regex.groupNames.get(id) || []
    inc('__str_to_buf', '__str_byteLen', '__alloc', '__mkptr', `__regex_${id}`)
    const s = temp('mas'), outArr = tempI32('mao')
    return matchAllImpl(typed(['f64.reinterpret_i64', toStrI64(null, asF64(emit(str)))], 'f64'), id, nGroups, groupNames, s, outArr)
  }
  function matchAllImpl(recvIR, id, nGroups, groupNames, s, outArr) {
    const off = tempI32('maof'), len = tempI32('maln'), pos = tempI32('maps')
    const res = tempI32('mars'), cnt = tempI32('macn'), wi = tempI32('mawi')
    const ms = tempI32('mams'), me = tempI32('mame')
    const sI64 = () => ['i64.reinterpret_f64', ['local.get', `$${s}`]]
    // Anchored-matcher scan: __regex_${id}(off,len,pos) returns match-end (>=0) or
    // -1; `body` runs per match with ms=pos, me=res; pos advances (+1 on a
    // zero-length match to make progress). `posInit` resets the cursor per pass.
    const scan = (body) => ['block', '$d', ['loop', '$n',
      ['br_if', '$d', ['i32.gt_s', ['local.get', `$${pos}`], ['local.get', `$${len}`]]],
      ['local.set', `$${res}`, ['call', `$__regex_${id}`, ['local.get', `$${off}`], ['local.get', `$${len}`], ['local.get', `$${pos}`]]],
      ['if', ['i32.lt_s', ['local.get', `$${res}`], ['i32.const', 0]],
        ['then', ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]], ['br', '$n']]],
      ['local.set', `$${ms}`, ['local.get', `$${pos}`]],
      ['local.set', `$${me}`, ['local.get', `$${res}`]],
      ...body,
      ['local.set', `$${pos}`, ['select', ['i32.add', ['local.get', `$${me}`], ['i32.const', 1]], ['local.get', `$${me}`], ['i32.eq', ['local.get', `$${ms}`], ['local.get', `$${me}`]]]],
      ['br', '$n']]]
    // Re-running the matcher in the fill pass repopulates the $__re_g* capture
    // globals just before buildMatchArr reads them — correct per-match captures.
    const matchArr = buildMatchArr(s, ms, me, nGroups, groupNames)
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, recvIR],
      ['local.set', `$${off}`, ['call', '$__str_to_buf', sI64()]],
      ['local.set', `$${len}`, ['call', '$__str_byteLen', sI64()]],
      ['local.set', `$${cnt}`, ['i32.const', 0]],
      ['local.set', `$${pos}`, ['i32.const', 0]],
      scan([['local.set', `$${cnt}`, ['i32.add', ['local.get', `$${cnt}`], ['i32.const', 1]]]]),
      ['local.set', `$${outArr}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.shl', ['local.get', `$${cnt}`], ['i32.const', 3]]]]],
      ['i32.store', ['local.get', `$${outArr}`], ['local.get', `$${cnt}`]],
      ['i32.store', ['i32.add', ['local.get', `$${outArr}`], ['i32.const', 4]], ['local.get', `$${cnt}`]],
      ['local.set', `$${outArr}`, ['i32.add', ['local.get', `$${outArr}`], ['i32.const', 8]]],
      ['local.set', `$${wi}`, ['i32.const', 0]],
      ['local.set', `$${pos}`, ['i32.const', 0]],
      scan([
        ['f64.store', ['i32.add', ['local.get', `$${outArr}`], ['i32.shl', ['local.get', `$${wi}`], ['i32.const', 3]]], matchArr],
        ['local.set', `$${wi}`, ['i32.add', ['local.get', `$${wi}`], ['i32.const', 1]]],
      ]),
      mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${outArr}`])], 'f64')
  }

  // str.split(/re/) → array of substrings
  ctx.core.emit['.string:split'] = (str, sep, limit) => {
    const id = resolveRegex(sep)
    if (id == null) {
      // Fall back to string split, forwarding the optional limit (0x7fffffff = no limit).
      // __str_split is 3-param (str, sep, limit); a 2-arg call here trips a wasm arity
      // error in any program with a known-string `.split` (e.g. the watr self-host).
      inc('__str_split')
      const limitIR = limit == null ? ['i32.const', 0x7fffffff] : ['i32.trunc_sat_f64_u', asF64(emit(limit))]
      return typed(['call', '$__str_split', asI64(emit(str)), asI64(emit(sep)), limitIR], 'f64')
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
