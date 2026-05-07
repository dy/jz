/**
 * Pre-parse text rewriter: works around three subscript/jessie parser gaps before
 * the AST stage ever runs. All three are tracked as `test.todo` in subscript's
 * test/jessie.js — drop the corresponding rewrite when the parser is fixed.
 *
 *   1. Shebang `#!...` at file start  → rewritten to `//...` (parser rejects `#!`).
 *   2. Optional catch binding `catch {` → `catch(_e){` (ES2019; parser requires `(`).
 *   3. `;\n(` ambiguity  → emits an extra `;` so a parenthesized expression
 *      starting on the next line begins a new statement instead of becoming a
 *      call on the previous statement's value.
 *
 * Comments and string literals are skipped so rewrites don't corrupt source text.
 *
 * @module source
 */
export function normalizeSource(code) {
  let source = code.startsWith('#!') ? `//${code.slice(2)}` : code
  source = source.replace(/\bcatch\s*\{/g, 'catch(_e){')
  let out = ''
  let parenDepth = 0
  let bracketDepth = 0
  let quote = ''
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    const next = source[i + 1]

    if (lineComment) {
      out += ch
      if (ch === '\n') lineComment = false
      continue
    }

    if (blockComment) {
      out += ch
      if (ch === '*' && next === '/') { out += next; i++; blockComment = false }
      continue
    }

    if (quote) {
      out += ch
      if (ch === '\\') { if (next != null) { out += next; i++ } }
      else if (ch === quote) quote = ''
      continue
    }

    if (ch === '/' && next === '/') { out += ch + next; i++; lineComment = true; continue }
    if (ch === '/' && next === '*') { out += ch + next; i++; blockComment = true; continue }
    if (ch === '"' || ch === "'" || ch === '`') { out += ch; quote = ch; continue }
    if (ch === '(') parenDepth++
    else if (ch === ')' && parenDepth > 0) parenDepth--
    else if (ch === '[') bracketDepth++
    else if (ch === ']' && bracketDepth > 0) bracketDepth--

    out += ch
    if (ch === ';' && parenDepth === 0 && bracketDepth === 0) {
      let j = i + 1
      let sawNewline = false
      while (j < source.length) {
        const c = source[j]
        const n = source[j + 1]
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
          if (c === '\n') sawNewline = true
          j++
          continue
        }
        if (c === '/' && n === '/') {
          j += 2
          while (j < source.length && source[j] !== '\n') j++
          continue
        }
        if (c === '/' && n === '*') {
          j += 2
          while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) {
            if (source[j] === '\n') sawNewline = true
            j++
          }
          if (j < source.length) j += 2
          continue
        }
        break
      }
      if (sawNewline && source[j] === '(') out += ';'
    }
  }

  return out
}