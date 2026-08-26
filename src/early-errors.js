import { ASSIGN_OPS } from './ast.js'
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

const P_CONTROL = 0, P_SEMIS = 1, P_REST = 2, P_REST_COMMA = 3, P_REST_DEPTH = 4, P_BASE_DEPTH = 5

const sourceHasLexicalRisk = (src, strict) => typeof src === 'string' && (
  src.includes('\\') || src.includes('#!') || src.includes('\u180e') || src.includes('\u2e2f') ||
  src.includes('\u2028') || src.includes('\u2029') ||
  src.includes('?.') && src.includes('`') ||
  src.includes('_') && /(^|[^A-Za-z0-9_$])(?:[0-9][0-9]*_|0[xXoObB]_)/m.test(src) ||
  /(^|[^A-Za-z0-9_$])0[xXoObB]/m.test(src) ||
  /(^|[^A-Za-z0-9_$])[0-9][0-9_.]*n\b/m.test(src) ||
  /(^|[^A-Za-z0-9_$])[0-9](?![0-9.eEnN])[A-Za-z_$]/m.test(src) ||
  strict && /(^|[^A-Za-z0-9_$])0[0-9]/m.test(src)
)

/** Lightweight lexical validation for spellings jessie's value AST erases. */
const validateLexicalSource = (src, strict) => {
  if (typeof src !== 'string') return
  let i = 0, canRegex = true, pendingControl = null, expectStatement = false, lastPunct = '', optionalDepth = -1, nesting = 0
  const parens = []
  while (i < src.length) {
    const c = src.charCodeAt(i), ch = src[i]
    if (isWhitespaceCode(c)) { i++; continue }
    if (ch === '/' && src[i + 1] === '/') {
      i += 2; while (i < src.length && src[i] !== '\n' && src[i] !== '\r' &&
        src.charCodeAt(i) !== 0x2028 && src.charCodeAt(i) !== 0x2029) i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) fail('unterminated block comment')
      i = end + 2; continue
    }
    if (ch === '#' && src[i + 1] === '!') {
      if (i !== 0) fail('hashbang is only valid at the start of source')
      i += 2; while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++; continue
    }
    if (ch === '"' || ch === "'") { i = lexicalQuoted(src, i, ch, strict); canRegex = false; continue }
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
    if (src.slice(i, i + 3) === '...') {
      const group = parens[parens.length - 1]
      if (group) { group[P_REST] = true; group[P_REST_DEPTH] = nesting }
      canRegex = true; lastPunct = '...'; i += 3; continue
    }
    if (ch === '(') { parens.push([pendingControl, 0, false, false, -1, nesting]); pendingControl = null }
    else if (ch === ')') {
      const group = parens.pop()
      if (group && group[P_CONTROL] === 'for' && group[P_SEMIS] !== 0 && group[P_SEMIS] !== 2)
        fail('for header has the wrong number of semicolons')
      if (group && group[P_REST_COMMA] && !group[P_CONTROL]) {
        let k = i + 1
        while (isWhitespaceCode(src.charCodeAt(k))) k++
        if (src.slice(k, k + 2) === '=>' || src[k] === '{') fail('rest parameter cannot have a trailing comma')
      }
      if (group && group[P_CONTROL]) expectStatement = true
      if (optionalDepth > parens.length) optionalDepth = -1
    } else if (ch === '{') { nesting++; expectStatement = false; pendingControl = null }
    else if (ch === '[') nesting++
    else if (ch === '}' || ch === ']') {
      nesting--
      const group = parens[parens.length - 1]
      if (group && group[P_REST] && nesting < group[P_REST_DEPTH]) group[P_REST] = false
    }
    else if (ch === ';' || ch === ',') {
      const group = parens[parens.length - 1]
      if (ch === ';' && group && group[P_CONTROL] === 'for' && group[P_BASE_DEPTH] === nesting) group[P_SEMIS]++
      if (ch === ',' && group && group[P_REST] && group[P_REST_DEPTH] === nesting) group[P_REST_COMMA] = true
      optionalDepth = -1
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

const patternItems = pattern => {
  if (!isNode(pattern)) return [pattern]
  if (pattern[0] === '()' && pattern.length === 2) return patternItems(pattern[1])
  if ((pattern[0] === '[]' || pattern[0] === '{}') && pattern.length > 1)
    return patternItems(pattern[1])
  if (pattern[0] === ',') return pattern.slice(1)
  return [pattern]
}

const boundNames = (pattern, out = []) => {
  if (typeof pattern === 'string') { out.push(pattern); return out }
  if (!isNode(pattern)) return out
  const op = pattern[0]
  if (op === '=' || op === '...') return boundNames(pattern[1], out)
  if (op === '()' && pattern.length === 2) return boundNames(pattern[1], out)
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

const visitPatternInitializers = (pattern, cx, visit) => {
  if (!isNode(pattern)) return
  const op = pattern[0]
  if (op === '=') {
    visit(pattern[2], cx)
    visitPatternInitializers(pattern[1], cx, visit)
    return
  }
  if (op === '...') return visitPatternInitializers(pattern[1], cx, visit)
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
  for (const stmt of list) {
    const d = declaration(stmt)
    if (!d) continue
    if (d[D_TYPE] === 'let' || d[D_TYPE] === 'const' || d[D_TYPE] === 'class' ||
        (d[D_TYPE] === 'function' && scopeKind !== 'global' && scopeKind !== 'function'))
      lexical.push(...d[D_NAMES])
    else if (d[D_TYPE] === 'var' || d[D_TYPE] === 'function') directVar.push(...d[D_NAMES])
  }
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
  return { member, isStatic, kind, key, value }
}

const containsDirectName = (node, name) => {
  if (node === name) return true
  if (!isNode(node)) return false
  if (node[0] === 'function' || node[0] === 'function*' ||
      node[0] === 'async' && isNode(node[1]) && (node[1][0] === 'function' || node[1][0] === 'function*')) return false
  for (let i = 1; i < node.length; i++) if (containsDirectName(node[i], name)) return true
  return false
}

const validateClass = (node, cx, walk) => {
  const name = node[1]
  if (typeof name === 'string') checkBindingName(name, { ...cx, strict: true, lexical: true })
  const members = statements(node[3])
  let constructors = 0
  const privateNames = new Map()
  const parsed = members.map(classMember)

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
    if (m.isStatic && m.key === 'prototype') fail("static class element cannot be named 'prototype'")
    if (m.kind === 'field' && m.key === 'constructor') fail("class field cannot be named 'constructor'")
    if (!m.isStatic && m.key === 'constructor' && m.kind !== 'field') {
      if (m.kind !== 'method' || isNode(m.value) && (m.value[0] === 'async' || m.value[0] === 'function*'))
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
    if (m.value) walk(m.value, { ...cx, strict: true, classBody: true, privateNames: privateSet })
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
  const rootModule = (() => {
    let found = false
    const scan = n => {
      if (!isNode(n) || found) return
      if (n[0] === 'import' || n[0] === 'export') { found = true; return }
      for (let i = 1; i < n.length; i++) scan(n[i])
    }
    scan(ast)
    return found
  })()

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

  const walk = (node, cx, statementPosition = false) => {
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

    if (op === ';') {
      for (let i = 1; i < node.length; i++) if (node[i] != null) walk(node[i], cx, true)
      return
    }
    if (op === 'case') {
      if (node[1] == null) fail('case clause requires an expression')
      walk(node[1], cx); walk(node[2], cx, true); return
    }
    if (op === 'default') { walk(node[1], cx, true); return }

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
      walk(node[2], { ...cx, labels }, true)
      return
    }

    if (op === 'function' || op === 'function*') {
      const generator = op === 'function*'
      const body = node[3]
      const strict = cx.strict || isUseStrict(body)
      if (typeof node[1] === 'string' && node[1]) checkBindingName(node[1], { ...cx, strict, generator: false })
      const params = paramsOf(node[2])
      if (params.some(hasRest)) needsLexical = true
      const simple = isSimpleParams(params)
      if (strict && !simple && isUseStrict(body)) fail("'use strict' is forbidden with non-simple parameters")
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
      const params = paramsOf(arrow[1]), body = arrow[2]
      if (params.some(hasRest)) needsLexical = true
      const fnBody = isNode(body) && body[0] === '{}' ? body[1] : body
      const ownStrict = isUseStrict(fnBody)
      const strict = cx.strict || ownStrict
      if (ownStrict && !isSimpleParams(params)) fail("'use strict' is forbidden with non-simple parameters")
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
      needsLexical = true
      validateClass(node, cx, walk)
      if (node[2]) walk(node[2], cx)
      return
    }

    if (op === 'let' || op === 'const' || op === 'var') {
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

    if (op === '{}') {
      if (statementPosition) {
        validateScopeNames(node[1], cx, 'block')
        walk(node[1], cx, true)
      } else {
        let proto = 0
        for (const item of patternItems(node)) {
          if (isNode(item) && item[0] === ':' && (item[1] === '__proto__' ||
              isNode(item[1]) && item[1][0] == null && item[1][1] === '__proto__')) proto++
          if (proto > 1) fail("duplicate '__proto__' data property")
          if (isNode(item) && (item[0] === '=' || item[0] == null || item[0] === '[]' && item.length === 2))
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
      const next = { ...cx, loop: cx.loop + 1 }
      if (isNode(head) && (head[0] === 'in' || head[0] === 'of')) {
        const lhs = head[1]
        if (isNode(lhs) && (lhs[0] === 'let' || lhs[0] === 'const' || lhs[0] === 'var')) {
          if (lhs.length !== 2 || isNode(lhs[1]) && lhs[1][0] === '=')
            fail('for-in/of declaration must have one uninitialized binding')
          if (lhs[0] !== 'var' && boundNames(lhs[1]).some(name => decodeIdentifier(name) === 'let'))
            fail("for-in/of lexical declaration cannot bind 'let'")
          walk(lhs, { ...cx, forBinding: true })
        } else if (isNode(lhs) && lhs.length === 2 && (lhs[0] === '[]' || lhs[0] === '{}'))
          checkPattern(lhs, { ...cx, unique: false }, false)
        else if (!isAssignmentTarget(lhs, true)) fail('invalid for-in/of assignment target')
        if (head[2] == null) fail('for-in/of requires a right-hand expression')
        walk(head[2], cx)
      } else walk(head, cx)
      if (declaration(node[2])) needsLexical = true
      walk(node[2], next, true)
      return
    }
    if (op === 'while') {
      if (declaration(node[2])) needsLexical = true
      if (node[1] == null) fail('while requires an expression')
      walk(node[1], cx)
      walk(node[2], { ...cx, loop: cx.loop + 1 }, true)
      return
    }
    if (op === 'do') {
      if (declaration(node[1])) needsLexical = true
      walk(node[1], { ...cx, loop: cx.loop + 1 }, true)
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
      walk(node[2], cx, true)
      if (node[3]) walk(node[3], cx, true)
      return
    }

    // A declaration in a single-statement position is outside the JZ subset
    // (and outside standard grammar except Annex B function declarations).
    if (statementPosition && (op === 'let' || op === 'const' || op === 'class'))
      fail('lexical declaration requires a block in statement position')

    for (let i = 1; i < node.length; i++) walk(node[i], cx, false)
  }

  if (typeof ast === 'string') {
    const name = decodeIdentifier(ast)
    if (ALWAYS_RESERVED.has(name)) fail(`escaped reserved word '${name}' cannot be an identifier reference`)
  }
  validateScopeNames(ast, root, 'global')
  for (const stmt of statements(ast)) walk(stmt, root, true)
  if (needsLexical) validateLexicalSource(source, root.strict)
  return ast
}
