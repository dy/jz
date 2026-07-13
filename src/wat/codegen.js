/**
 * AST → jz source codegen.
 *
 * Pretty-prints a jzify-transformed AST back to jz source text. CLI-only
 * (`jz jzify file.js` → `file.jz`); the compile path consumes the AST directly
 * and never round-trips through source.
 *
 * @module codegen
 */

const INDENT = '  '
const prec = { '=': 1, '+=': 1, '-=': 1, '*=': 1, '/=': 1, '%=': 1, '&=': 1, '|=': 1, '^=': 1, '>>=': 1, '<<=': 1, '>>>=': 1, '||=': 1, '&&=': 1,
  '??': 2, '||': 3, '&&': 4, '|': 5, '^': 6, '&': 7, '===': 8, '!==': 8, '==': 8, '!=': 8,
  '<': 9, '>': 9, '<=': 9, '>=': 9, '<<': 10, '>>': 10, '>>>': 10,
  '+': 11, '-': 11, '*': 12, '/': 12, '%': 12, '**': 13 }

/** Wrap statement in { } if not already a block */
function wrapBlock(node, depth) {
  if (Array.isArray(node) && node[0] === '{}') return codegen(node, depth)
  return '{ ' + codegen(node, depth) + '; }'
}

// Effective precedence of a node in expression position: binaries from `prec`,
// ternary/arrow/comma below them, atoms/calls/members bind tightest.
const ASSOC = new Set(['&&', '||', '+', '*', '&', '|', '^'])
const cprec = (n) => !Array.isArray(n) || n[0] == null ? Infinity
  : prec[n[0]] != null ? prec[n[0]]
  : n[0] === '?' || n[0] === '?:' ? 1.5
  : n[0] === '=>' ? 0.7
  : n[0] === ',' ? 0.1
  : Infinity

/** Print child, parenthesized when it binds looser than the context. */
const paren = (n, ctx) => cprec(n) < ctx ? '(' + codegen(n) + ')' : codegen(n)

/** Generate jz source from AST. Enforces semicolons. */
export function codegen(node, depth = 0) {
  if (node == null) return ''
  if (typeof node === 'number') return String(node)
  if (typeof node === 'bigint') return node + 'n'
  if (typeof node === 'string') return node
  if (!Array.isArray(node)) return String(node)

  const [op, ...a] = node
  const ind = INDENT.repeat(depth), ind1 = INDENT.repeat(depth + 1)

  // Literal: [, value]. `[]` (no payload) is subscript's undefined encoding —
  // print it as `undefined`, not `null` (distinct values through a round-trip).
  if (op == null) return typeof a[0] === 'string' ? JSON.stringify(a[0]) : a[0] === null ? 'null' : a[0] === undefined ? 'undefined' : String(a[0]) + (typeof a[0] === 'bigint' ? 'n' : '')
  // ['nan'] — jz's parse encodes NaN as a self-describing marker (src/parse.js)
  if (op === 'nan') return 'NaN'
  // ['bool', 1|0] — true/false parse to a self-describing marker (src/parse.js)
  if (op === 'bool') return a[0] ? 'true' : 'false'

  // Statements
  if (op === ';') return a.map(s => codegen(s, depth)).filter(Boolean).join(';\n' + ind) + ';'
  if (op === '{}') {
    // Discriminate object literal / destructuring pattern from block.
    // Object: `:` key-value, `,` of object-pattern items (id / `:` / `...` / `= default`),
    //         lone string shorthand. Empty `{}` outputs the same string either way.
    const body = a[0]
    const isObjItem = (n) => typeof n === 'string' ||
      (Array.isArray(n) && (n[0] === ':' || n[0] === '...' || n[0] === 'as' ||
        (n[0] === '=' && typeof n[1] === 'string')))
    const isObj = body == null ? false
      : typeof body === 'string' ? true
      : Array.isArray(body) && (body[0] === ':' || body[0] === '...' || body[0] === 'as' ||
          (body[0] === ',' && body.slice(1).every(isObjItem)))
    if (isObj) {
      if (typeof body === 'string') return '{ ' + body + ' }'
      if (body[0] === ',') return '{ ' + body.slice(1).map(x => codegen(x)).join(', ') + ' }'
      return '{ ' + codegen(body) + ' }'
    }
    // Block: body is null, a single statement, or [';', ...stmts]
    const stmts = body == null ? [] : (Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body])
    const rendered = stmts.map(s => codegen(s, depth + 1)).filter(Boolean).join(';\n' + ind1)
    return '{\n' + ind1 + rendered + (rendered ? ';' : '') + '\n' + ind + '}'
  }

  // Declarations
  if (op === 'let' || op === 'const') return op + ' ' + a.map(d => codegen(d, depth)).join(', ')
  if (op === 'export') { const inner = codegen(a[0], depth); return inner ? 'export ' + inner : '' }
  if (op === 'default') return 'default ' + codegen(a[0], depth)

  // Control flow
  if (op === 'if') {
    const cond = codegen(a[0]), then = wrapBlock(a[1], depth)
    return a[2] != null
      ? 'if (' + cond + ') ' + then + ' else ' + wrapBlock(a[2], depth)
      : 'if (' + cond + ') ' + then
  }
  if (op === 'while') return 'while (' + codegen(a[0]) + ') ' + wrapBlock(a[1], depth)
  if (op === 'for') {
    if (a.length === 2) { // ['for', head, body] — subscript shape
      const [head, body] = a
      if (Array.isArray(head) && (head[0] === 'of' || head[0] === 'in'))
        return 'for (' + codegen(head[1]) + ' ' + head[0] + ' ' + codegen(head[2]) + ') ' + wrapBlock(body, depth)
      // ['let'/'const', ['in'/'of', name, obj]] — subscript wraps var→let around in/of
      if (Array.isArray(head) && (head[0] === 'let' || head[0] === 'const') && Array.isArray(head[1]) && (head[1][0] === 'in' || head[1][0] === 'of'))
        return 'for (' + head[0] + ' ' + codegen(head[1][1]) + ' ' + head[1][0] + ' ' + codegen(head[1][2]) + ') ' + wrapBlock(body, depth)
      // C-style head [';', init, cond, update] is positional — empty slots are valid,
      // must not flow through the generic `;` joiner (which adds newlines + a trailing `;`).
      if (Array.isArray(head) && head[0] === ';')
        return 'for (' + (head[1] == null ? '' : codegen(head[1])) + '; ' + (head[2] == null ? '' : codegen(head[2])) + '; ' + (head[3] == null ? '' : codegen(head[3])) + ') ' + wrapBlock(body, depth)
      return 'for (' + codegen(head) + ') ' + wrapBlock(body, depth)
    }
    return 'for (' + (codegen(a[0]) || '') + '; ' + (codegen(a[1]) || '') + '; ' + (codegen(a[2]) || '') + ') ' + wrapBlock(a[3], depth)
  }
  if (op === 'return') return 'return ' + codegen(a[0])
  if (op === 'throw') return 'throw ' + codegen(a[0])
  if (op === 'break') return 'break'
  if (op === 'continue') return 'continue'
  // catch with optional binding: ['catch', tryBlock, catchBody] or ['catch', tryBlock, paramName, catchBody]
  if (op === 'catch') {
    if (a.length === 3) return 'try ' + codegen(a[0], depth) + ' catch (' + a[1] + ') ' + codegen(a[2], depth)
    return 'try ' + codegen(a[0], depth) + ' catch ' + codegen(a[1], depth)
  }
  // Parser shape: ['try', body, ['catch', param|null, cbody]?, ['finally', fbody]?] —
  // bodies arrive unbraced (bare statement or `;`-list); JS requires the blocks back.
  if (op === 'try') {
    let s = 'try ' + wrapBlock(a[0], depth)
    for (const c of a.slice(1)) {
      if (!Array.isArray(c)) continue
      if (c[0] === 'catch') s += (c[1] != null ? ' catch (' + codegen(c[1]) + ') ' : ' catch ') + wrapBlock(c[2], depth)
      else if (c[0] === 'finally') s += ' finally ' + wrapBlock(c[1], depth)
    }
    return s
  }

  // Arrow
  if (op === '=>') {
    // Params: already wrapped in () by parser, or bare name
    const p = a[0]
    const params = Array.isArray(p) && p[0] === '()' ? codegen(p) : '(' + codegen(p) + ')'
    const body = a[1]
    const isBlock = Array.isArray(body) && (body[0] === '{}' || body[0] === ';' || body[0] === 'return')
    const bodyStr = Array.isArray(body) && body[0] !== '{}' && isBlock
      ? '{ ' + codegen(body, depth) + '; }'
      : codegen(body, depth)
    return params + ' => ' + bodyStr
  }

  // Grouping parens / function call
  if (op === '()') {
    if (a.length === 1) return '(' + (a[0] == null ? '' : codegen(a[0])) + ')'
    // An arrow/ternary/binary callee binds looser than the call — parenthesize
    // (IIFE: `(() => {…})()`), else `... => body()` re-parses into the body.
    const calleeNeedsParens = Array.isArray(a[0]) && (a[0][0] === '=>' || a[0][0] === '?' || prec[a[0][0]] != null)
    const callee = calleeNeedsParens ? '(' + codegen(a[0]) + ')' : codegen(a[0])
    return callee + '(' + a.slice(1).map(x => codegen(x)).join(', ') + ')'
  }

  // Property access. Canonicalized well-known-symbol props ('@@iterator' …)
  // are not valid dot syntax — print the computed [Symbol.X] source form,
  // which canonSymbols folds back to the same '@@X' on re-parse.
  if (op === '.') {
    if (typeof a[1] === 'string' && a[1].startsWith('@@'))
      return codegen(a[0]) + '[Symbol.' + a[1].slice(2) + ']'
    return codegen(a[0]) + '.' + a[1]
  }
  if (op === '?.') return codegen(a[0]) + '?.' + a[1]
  if (op === '?.[]') return codegen(a[0]) + '?.[' + codegen(a[1]) + ']'
  if (op === '?.()') return codegen(a[0]) + '?.(' + a.slice(1).map(x => codegen(x)).join(', ') + ')'
  if (op === '[]') {
    // Array literal: ['[]', body] (length 2 → a.length 1). body may be null (empty),
    // a single element, or a [',', ...items] sequence.
    if (a.length === 1) {
      if (a[0] == null) return '[]'
      const body = a[0]
      if (Array.isArray(body) && body[0] === ',') return '[' + body.slice(1).map(x => codegen(x)).join(', ') + ']'
      return '[' + codegen(body) + ']'
    }
    // Subscript: ['[]', obj, idx]
    return codegen(a[0]) + '[' + codegen(a[1]) + ']'
  }
  if (op === ':') {
    if (typeof a[0] === 'string' && a[0].startsWith('@@'))
      return '[Symbol.' + a[0].slice(2) + ']: ' + codegen(a[1])
    // a '@@X' key needs the quoted form ('@@iterator': v) only when written
    // literally; the computed form above is the canonical print.
    return codegen(a[0]) + ': ' + codegen(a[1])
  }
  if (op === 'str') return JSON.stringify(a[0])
  if (op === '//') return '/' + a[0] + '/' + (a[1] || '')

  // Comma
  if (op === ',') return a.map(x => codegen(x)).join(', ')
  // Template literal: alternating string/expr parts. String parts are [null, "str"], expr parts are AST nodes.
  if (op === '`') return '`' + a.map(p => {
    if (Array.isArray(p) && p[0] == null && typeof p[1] === 'string') return p[1].replace(/[`\\$]/g, c => '\\' + c)
    return '${' + codegen(p) + '}'
  }).join('') + '`'

  // Spread
  if (op === '...') return '...' + codegen(a[0])

  // Import / export rename
  if (op === 'import') return 'import ' + codegen(a[0])
  if (op === 'from') return codegen(a[0]) + ' from ' + codegen(a[1])
  if (op === 'as') return codegen(a[0]) + ' as ' + codegen(a[1])

  // Unary prefix
  if (a.length === 1) {
    if (op === '++' || op === '--') return a[0] == null ? op : op + codegen(a[0])
    if (op === 'typeof') return 'typeof ' + paren(a[0], 14)
    if (op === 'u-') return '-' + paren(a[0], 14)
    if (op === 'u+') return '+' + paren(a[0], 14)
    return op + paren(a[0], 14)
  }

  // Postfix
  if (a.length === 2 && a[1] === null) return codegen(a[0]) + op

  // Binary — parenthesize looser-binding children: parse preserves user parens as
  // '()' group nodes, but jzify/canon-synthesized trees are bare, so `&&` over a
  // synthesized `||` must print `a && (b || c)`, not re-associate on re-parse.
  if (a.length === 2 && prec[op]) {
    const P = prec[op]
    // `??` may not mix with bare `&&`/`||` at all (JS SyntaxError) — force parens.
    const force = (n) => op === '??' && Array.isArray(n) && (n[0] === '&&' || n[0] === '||')
    const left = force(a[0]) || cprec(a[0]) < P || (cprec(a[0]) === P && op === '**')  // ** is right-assoc
      ? '(' + codegen(a[0]) + ')' : codegen(a[0])
    // Assignment RHS takes any assignment-expression bare (arrows, ternaries,
    // chained `=`) — only a comma-sequence needs parens there.
    const rmin = P === 1 ? 0.5 : P
    const right = force(a[1]) || cprec(a[1]) < rmin || (cprec(a[1]) === rmin && !(ASSOC.has(op) && a[1][0] === op))
      ? '(' + codegen(a[1]) + ')' : codegen(a[1])
    return left + ' ' + op + ' ' + right
  }

  // Ternary — only the condition slot needs guarding (branches take any
  // assignment-expression; ?: is right-associative)
  if (op === '?' || op === '?:') return paren(a[0], 2) + ' ? ' + codegen(a[1]) + ' : ' + codegen(a[2])

  // Fallback
  return op + '(' + a.map(x => codegen(x)).join(', ') + ')'
}
