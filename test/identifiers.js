// Names and whitespace outside ASCII (ECMAScript §12.2–12.4, §12.7). A name
// is ID_Start then ID_Continue, `$`, `_`, ZWNJ and ZWJ, written raw, as a
// surrogate pair, or escaped (`\uXXXX`, `\u{X…}`, meaning the name it spells).
// Between tokens stand the space separators, NBSP, ZWNBSP and the four line
// terminators; LS and PS end a line for ASI and for a `//` comment. Every
// accepted program answers what Node answers, through bindings, properties,
// literal keys, schemas the host reads, export names, modules and WAT names.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { oracle } from './util.js'
import { onKernel, onWasi } from './_matrix.js'
import { idStart, idPart, isSpace } from '../src/unicode.js'
import { UNICODE_VERSION } from '../src/unicode-id.generated.js'

const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029)
const NBSP = String.fromCharCode(0xa0), BOM = String.fromCharCode(0xfeff), IDEO = String.fromCharCode(0x3000)
const PRIVATE_USE = String.fromCharCode(0xe000)

// Node's own reading of every export, called with `args`, beside jz's.
const both = (src, calls, opts) => {
  const want = oracle(src), got = jz(src, opts).exports
  for (const [name, args = []] of calls) {
    const value = (e) => typeof e[name] === 'function' ? e[name](...args) : e[name]?.value ?? e[name]
    is(JSON.stringify(value(got)), JSON.stringify(value(want)), `${name}: ${src.replace(/\s+/g, ' ').slice(0, 70)}`)
  }
}

test('identifiers: the name tables are Unicode ID_Start and ID_Continue', () => {
  // Generated from this Node's Unicode: exact where the versions agree.
  if (process.versions.unicode !== UNICODE_VERSION) return
  const start = /[\p{ID_Start}$_]/u, part = /[\p{ID_Continue}$\u200c\u200d]/u
  let bad = 0
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const ch = String.fromCodePoint(cp)
    if (idStart(cp) !== start.test(ch) || idPart(cp) !== part.test(ch)) if (bad++ < 5) ok(false, `U+${cp.toString(16)}`)
  }
  is(bad, 0, 'every code point')
})

test('identifiers: whitespace is what /\\s/ matches', () => {
  let bad = 0
  for (let c = 0; c <= 0xffff; c++) if (isSpace(c) !== /\s/.test(String.fromCharCode(c))) if (bad++ < 5) ok(false, `U+${c.toString(16)}`)
  is(bad, 0, 'every code unit')
})

test('identifiers: names jz reads as Node does', () => {
  both(`
    let unit = {}
    unit.µs = 1e-3
    export let prop = () => unit.µs
    let µs = 2, ª = 3, º = 4, a· = 5, 中文 = 6, 𝐚 = 7, a\u200cb = 8, $ñ_ = 9
    export let bindings = () => [µs, ª, º, a·, 中文, 𝐚, a\u200cb, $ñ_]
    let \\u0061bc = 10, x\\u{1D41A} = 11
    export let escaped = () => [abc, x𝐚, unit.\\u{b5}s]
    export let literal = () => ({ µs: 1, ªb: 2, 中文: 3, 𝐚: 4 })
    export let keys = () => Object.keys({ µs: 1, ªb: 2, 中文: 3 }).join()
    export let json = () => JSON.stringify({ µs: 1, 𝐚: [2] })
    export let destructure = () => { let { µs, ªb = 3 } = { µs: 2 }; return µs + ªb }
    export let closure = (µ) => { let g = (ν) => µ + ν; return g(1) }
    class Ω { constructor(µ) { this.µ = µ } get δ() { return this.µ * 2 } }
    export let klass = () => new Ω(5).δ
    function λ(x) { return x + 1 }
    export let declared = () => λ(2)
    export let labeled = () => { let n = 0; ü: for (let i = 0; i < 3; i++) { for (;;) { n++; continue ü } } return n }
    export let template = () => { let ñ = 'x'; return \`\${ñ}ñ\` }
    export let µ = 7
  `, [['prop'], ['bindings'], ['escaped'], ['literal'], ['keys'], ['json'],
    ['destructure'], ['closure', [2]], ['klass'], ['declared'], ['labeled'], ['template'], ['µ']])
})

test('identifiers: whitespace and line terminators outside ASCII', () => {
  both(`export let nbsp${NBSP}=${NBSP}() => 1
${BOM}export let bom = () => 2
export let ideographic${IDEO}= () => 3
export let ls = () => { let x = 1 // a comment ends at LS${LS} x = 2
  return x }
export let ps = () => { let x = 1${PS}x++
  return x }
export let block = () => { let x = 1 /* ${LS} */ x = 3
  return x }`, [['nbsp'], ['bom'], ['ideographic'], ['ls'], ['ps'], ['block']])
  // the restricted productions: `return` LS `1` returns undefined
  both(`export let restricted = () => { return${LS}1 }`, [['restricted']])
})

test('identifiers: characters that are no name character, and misplaced ones', () => {
  const REJECT = [
    ['middle dot first', 'let ·a = 1'],
    ['combining mark first', 'let \\u0300a = 1'],
    ['escaped digit first', 'let \\u0031 = 1'],
    ['ZWNJ first', 'let \\u200ca = 1'],
    ['escaped surrogate pair', 'let \\uD835\\uDC1A = 1'],
    ['emoji', 'let a😀 = 1'],
    ['multiplication sign', 'let a×b = 1'],
    ['vertical tilde', 'let aⸯ = 1'],
    ['Mongolian vowel separator', 'let a = 1\u180e'],
    ['private use (the compiler\'s own prefix)', `let x${PRIVATE_USE} = 1`],
    ['escaped private use', 'let \\u{E000} = 1'],
    ['escape past U+10FFFF', 'let a\\u{110000} = 1'],
    ['empty escape', 'let a\\u{} = 1'],
    ['short escape', 'let a\\u00 = 1'],
    ['control character between tokens', 'let a = 1\u0001'],
    ['escaped keyword as a binding', 'let \\u0069f = 1'],
  ]
  for (const [label, src] of REJECT) {
    let error
    try { compile(src) } catch (e) { error = e }
    ok(error, `${label}: ${JSON.stringify(src)} is rejected`)
  }
})

test('identifiers: export names, modules, the host and WAT', () => {
  if (onKernel() || onWasi()) return   // modules, host objects and the name section are the JS host's
  const modules = { './m.js': 'export let µ = (x) => x + 1\nexport let ñ = 5\nexport class Ω { constructor(v) { this.v = v } dbl() { return this.v * 2 } }' }
  const e = jz('import { µ, ñ, Ω } from "./m.js"\nexport { µ as ö }\nexport let f = () => µ(ñ) + new Ω(3).dbl()', { modules }).exports
  is(e.f(), 12, 'a module\'s names')
  is(e.ö(1), 2, 'a re-export under a name outside ASCII')
  is(jz('import { µ } from "host"\nexport let f = (x) => µ(x) * 2', { imports: { host: { µ: (x) => x + 1 } } }).exports.f(3), 8, 'a host import')
  is(jz('export let f = (o) => o.µs * 2').exports.f({ µs: 21 }), 42, 'a host object\'s property')
  const src = 'let µs = 3\nexport let fµ = (ä) => { let ö = ä * µs; return ö }'
  ok(compile(src, { wat: true }).includes('$fµ'), 'WAT names the function as written')
  const names = WebAssembly.Module.customSections(new WebAssembly.Module(compile(src, { names: true })), 'name')[0]
  ok(new TextDecoder().decode(names).includes('fµ'), 'the name section holds its UTF-8')
})
