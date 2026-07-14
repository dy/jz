// Strip WAT comments + indentation from template literals at BUNDLE time.
//
// The stdlib (module/*.js) carries its WAT as template strings — readable,
// commented, indented. esbuild minifies the JS around them but string content
// survives verbatim, so `;;` comments and leading indentation ship in
// dist/jz.js (and in anything that embeds these sources). Stripping them at
// build keeps the SOURCE documented and the BUNDLE lean; WAT is
// whitespace-insensitive outside quoted strings, and WAT strings cannot span
// lines, so per-line leading-space collapse is always safe and `;;`-to-EOL is
// safe whenever the `;;` sits outside a quoted string (checked per line by
// unescaped-quote parity).
//
// Only templates that LOOK like WAT are touched (first meaningful char `(` or
// `;;`, or a wat keyword within) — multi-line error messages etc. pass through
// byte-identical. Interpolations (`${…}`) are never entered.
//
// The gate for any change here: corpus byte-compare — dist/jz.js and index.js
// must emit identical wasm for every bench case (scripts/build-dist.mjs runs
// a spot check; test/dist-parity gates the corpus).

const WAT_HINT = /^\s*(\(|;;)/
const WAT_TOKEN = /\((func|local|param|result|global|if|block|loop|memory|data|table|export|import)[\s)]|\b(i32|i64|f32|f64|v128)\./

// one literal chunk (between interpolations): strip per line. `hasMoreAfter`
// = an interpolation follows this chunk — its LAST line is not a complete
// line, so neither a trailing trim nor a `;;` cut is safe there (a comment
// spanning the interpolation would leave its continuation in the NEXT chunk
// as live tokens — `;; …≤${MAX_SSO}-ASCII…` shipped an "Unknown instruction
// 6-ASCII"; both caught by the build's parity spot-gate).
const stripChunk = (text, hasMoreAfter) => text.split('\n').map((line, i, all) => {
  const last = i === all.length - 1
  // `;;` outside a quoted string → cut to EOL (strings never span lines, so
  // quote parity of the prefix decides). Escaped \" inside strings honored.
  let inStr = false
  for (let j = 0; j < line.length; j++) {
    const c = line[j]
    if (inStr) {
      if (c === '\\') j++
      else if (c === '"') inStr = false
    }
    else if (c === '"') inStr = true
    else if (c === ';' && line[j + 1] === ';') {
      if (last && hasMoreAfter) break   // comment continues past the interpolation — leave whole
      line = line.slice(0, j)
      break
    }
  }
  // Boundary lines keep their boundary whitespace: line 0 continues the token
  // run after the previous `${…}` (leading space may separate tokens) and the
  // LAST line runs into the next `${…}` (`(i64.const ` + interpolation glued
  // into `i64.const0x…` when its trailing space was trimmed). Interior lines
  // trim both ends.
  if (i === 0) return last ? line : line.replace(/[ \t]+$/, '')
  return last && hasMoreAfter ? line.replace(/^[ \t]+/, ' ')
    : last ? line.replace(/^[ \t]+/, ' ').replace(/[ \t]+$/, '')
    : line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
}).filter((line, i, all) => line !== '' || i === 0 || i === all.length - 1).join('\n')

/** Transform JS source: minify WAT-looking template-literal content. */
export function stripWatTemplates(src) {
  let out = ''
  let i = 0
  const n = src.length
  // minimal JS lexer: code / 'str' / "str" / line + block comments / regex /
  // template with ${} nesting. Templates collect quasi chunks for stripping.
  let prevSignificant = ''   // last non-space code char — regex-vs-division heuristic
  const regexCanStart = () => !prevSignificant || '([{,;=:!&|?+-*%<>~^'.includes(prevSignificant) || /\b(return|typeof|instanceof|in|of|new|delete|void|do|else|case)$/.test(out.slice(-10))
  while (i < n) {
    const c = src[i]
    if (c === "'" || c === '"') {
      const q = c; out += c; i++
      while (i < n && src[i] !== q) { if (src[i] === '\\') { out += src[i++] } out += src[i++] }
      out += src[i] ?? ''; i++
      prevSignificant = q
      continue
    }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); out += src.slice(i, e < 0 ? n : e); i = e < 0 ? n : e; continue }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); out += src.slice(i, e < 0 ? n : e + 2); i = e < 0 ? n : e + 2; continue }
    if (c === '/' && regexCanStart()) {
      // regex literal: copy through, honoring escapes and character classes
      out += c; i++
      let inClass = false
      while (i < n && (src[i] !== '/' || inClass)) {
        if (src[i] === '\\') { out += src[i++] }
        else if (src[i] === '[') inClass = true
        else if (src[i] === ']') inClass = false
        out += src[i++]
      }
      out += src[i] ?? ''; i++
      while (i < n && /[a-z]/i.test(src[i])) out += src[i++]   // flags
      prevSignificant = '/'
      continue
    }
    if (c === '`') {
      // template literal: collect quasis + interpolations, strip qualifying quasis
      const quasis = []   // [{text, interp?}]
      i++
      let cur = ''
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { cur += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        if (src[i] === '$' && src[i + 1] === '{') {
          // interpolation: nested braces + nested templates copy verbatim (recursed)
          let depth = 1, j = i + 2, seg = ''
          while (j < n && depth) {
            if (src[j] === '{') depth++
            else if (src[j] === '}') { depth--; if (!depth) break }
            else if (src[j] === '`') {
              // nested template — find its end honoring escapes and ${}
              let d2 = 0, k = j + 1
              for (; k < n; k++) {
                if (src[k] === '\\') { k++; continue }
                if (src[k] === '$' && src[k + 1] === '{') { d2++; k++ }
                else if (src[k] === '}' && d2) d2--
                else if (src[k] === '`' && !d2) break
              }
              seg += src.slice(j, k + 1); j = k + 1; continue
            }
            seg += src[j]; j++
            continue
          }
          quasis.push({ text: cur }); cur = ''
          quasis.push({ interp: stripWatTemplates(seg) })
          i = j + 1
          continue
        }
        cur += src[i]; i++
      }
      quasis.push({ text: cur })
      i++   // closing backtick
      const whole = quasis.filter(q => q.text != null).map(q => q.text).join('')
      const isWat = (WAT_HINT.test(whole) && WAT_TOKEN.test(whole)) || (WAT_TOKEN.test(whole) && /;;/.test(whole))
      out += '`' + quasis.map((q, qi) => q.interp != null ? '${' + q.interp + '}'
        : (isWat ? stripChunk(q.text, qi + 1 < quasis.length) : q.text)).join('') + '`'
      prevSignificant = '`'
      continue
    }
    out += c
    if (!/\s/.test(c)) prevSignificant = c
    i++
  }
  return out
}
