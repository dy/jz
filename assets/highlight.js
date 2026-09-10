// One syntax highlighter for the site: the REPL editor, its WAT pane and the guide's
// code blocks. One regex per language, monochrome classes — k keyword, t Type, n number,
// s string, c comment — and each surface sets the class colors on its own palette.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')

// JS: comment / jz`…` / string / number / keyword / Type. A jz-tagged template body is
// JZ source, so it is highlighted as code rather than as a string (the group sits ahead
// of the string group; alternation is ordered).
const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(\bjz`(?:\\.|[^`\\])*`)|('(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?|`(?:\\.|[^`\\])*`?)|\b(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(let|const|var|function|class|new|return|if|else|for|while|do|break|continue|export|import|from|default|try|catch|finally|throw|typeof|instanceof|in|of|switch|case|this|extends|super|static|null|undefined|true|false)\b|\b([A-Z][A-Za-z0-9_]*)\b/g
const TOKEN_CLS = ['c', 'jz', 's', 'n', 'k', 't']
// WAT: comment(;;) / string / $name / keyword / type / number
const WTOKEN = /(;;[^\n]*)|("(?:\\.|[^"\\\n])*")|(\$[^\s()";]+)|\b(module|func|param|result|local|global|memory|data|table|elem|type|import|export|start|mut|offset|align|shared|block|loop|if|then|else|end|br|br_if|call|call_indirect|return)\b|\b(i32|i64|f32|f64|v128|funcref|externref)\b|(-?(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|nan|inf))/g
const WCLS = ['c', 's', 't', 'k', 't', 'n']

const tokenize = (src, re, cls) => {
  let html = '', last = 0, m; re.lastIndex = 0
  while ((m = re.exec(src))) {
    html += esc(src.slice(last, m.index))
    const i = m.slice(1).findIndex(g => g !== undefined)
    if (cls[i] === 'jz') {
      // recurse into the template body; the shared regex's cursor is restored after
      const end = re.lastIndex
      html += 'jz`' + tokenize(m[0].slice(3, -1), re, cls) + '`'
      re.lastIndex = last = end
      continue
    }
    html += `<span class="${cls[i]}">${esc(m[0])}</span>`
    last = re.lastIndex
  }
  return html + esc(src.slice(last))
}
export const highlight = src => tokenize(src, TOKEN, TOKEN_CLS)
export const highlightWat = line => tokenize(line, WTOKEN, WCLS)
