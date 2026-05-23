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

/** Generate jz source from AST. Enforces semicolons. */
export function codegen(node, depth = 0) {
  if (node == null) return ''
  if (typeof node === 'number') return String(node)
  if (typeof node === 'bigint') return node + 'n'
  if (typeof node === 'string') return node
  if (!Array.isArray(node)) return String(node)

  const [op, ...a] = node
  const ind = INDENT.repeat(depth), ind1 = INDENT.repeat(depth + 1)

  // Literal: [, value]
  if (op == null) return typeof a[0] === 'string' ? JSON.stringify(a[0]) : a[0] == null ? 'null' : String(a[0]) + (typeof a[0] === 'bigint' ? 'n' : '')

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
    return codegen(a[0]) + '(' + a.slice(1).map(x => codegen(x)).join(', ') + ')'
  }

  // Property access
  if (op === '.') return codegen(a[0]) + '.' + a[1]
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
  if (op === ':') return codegen(a[0]) + ': ' + codegen(a[1])
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
    if (op === 'typeof') return 'typeof ' + codegen(a[0])
    if (op === 'u-') return '-' + codegen(a[0])
    if (op === 'u+') return '+' + codegen(a[0])
    return op + codegen(a[0])
  }

  // Postfix
  if (a.length === 2 && a[1] === null) return codegen(a[0]) + op

  // Binary
  if (a.length === 2 && prec[op]) return codegen(a[0]) + ' ' + op + ' ' + codegen(a[1])

  // Ternary
  if (op === '?' || op === '?:') return codegen(a[0]) + ' ? ' + codegen(a[1]) + ' : ' + codegen(a[2])

  // Fallback
  return op + '(' + a.map(x => codegen(x)).join(', ') + ')'
}
