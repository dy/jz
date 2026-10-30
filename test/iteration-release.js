// A loop whose escapes the frame flags gives back each iteration's memory at
// the next one's start (emit/control-flow.js iterationRelease, module/core/
// reach.js `__iter_release`): where the flag says no escape reached older
// storage the heap goes back to the iteration's mark, else the walk from the
// log keeps what the escapes reached. A loop storing what an iteration made
// into a binding declared outside it, or into what such a binding holds,
// keeps all (no flag names those stores); every program answers what the
// host answers, the memory read after the loop overwritten first.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile, instantiate } from '../index.js'
import { levels } from './_matrix.js'
import { oracle, run } from './util.js'

const agree = (src, ns = [1, 7, 200]) => {
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) {
    const m = run(src, { optimize }), host = oracle(src)
    for (const n of ns) is(m.f(n), host.f(n), `${optimize}: f(${n})`)
  }
}
const releases = (src) => (compile(src, { optimize: 'speed', wat: true }).match(/call \$__iter_release/g) || []).length
// what the loop kept is read after this overwrites what it gave back
const CHURN = `const junk = []; for (let k = 0; k < 3000; k++) junk.push([k, k + 1, k + 2])`
// more than a release takes back at once (control-flow.js RELEASE_BYTES)
const BIG = `const big = []; for (let k = 0; k < 12000; k++) big.push(k)`
// a parser's state: the source in a module binding, a flag on the function
// (a global of its own, written with a boolean: no escape)
const PARSE = `let cur = '', idx = 0
  const parse = (s) => { cur = s; idx = 0; parse.semi = false; const out = []; while (idx < cur.length) { out.push([cur.charCodeAt(idx), idx]); if (cur.charCodeAt(idx) === 59) parse.semi = true; idx++ } return out }
  parse.semi = false
  const hash = (a) => { let h = 0; for (let i = 0; i < a.length; i++) h = (h * 31 + a[i][0] + a[i][1]) | 0; return h }\n`

test('iteration release: a parser loop runs in the memory of one parse', () => {
  const src = PARSE + `export let make = () => { let s = ''; for (let i = 0; i < 2000; i++) s += String.fromCharCode(97 + i % 26); return s }
    export let f = (n, s = make()) => { let cs = 0; for (let r = 0; r < n; r++) { const ast = parse(s); cs = (cs + hash(ast)) | 0 } return cs + cur.length }`
  agree(src, [0, 1, 7, 40])
  ok(releases(src) > 0, 'the loop releases its iterations')
  const grown = (n) => { const inst = jz(src, { optimize: 'speed' }), s = inst.exports.make(), at = inst.memory.buffer.byteLength; inst.exports.f(n, s); return inst.memory.buffer.byteLength - at }
  is(grown(1000), grown(1), 'a thousand parses grow what one does')
})

// The memory a call of `f` grows, on a fresh instance; `host` the functions a declared import takes.
const grownBy = (src, opts = {}, host = undefined) => (...args) => {
  const { exports } = instantiate(new WebAssembly.Module(compile(src, { optimize: 'speed', ...opts })), host && { imports: host })
  const at = exports.memory.buffer.byteLength
  exports.f(...args)
  return exports.memory.buffer.byteLength - at
}

test('iteration release: a store through a receiver the site keeps names the receiver, re-read through its owner', () => {
  // `self.buf.chans` may run an accessor (Port's `get chans`), so the site keeps
  // the receiver as it is evaluated; the allocating value stages it through a
  // temp of its owner (emit/assignment.js stagedReference), which must keep it
  // too, or the flag goes to zero and every iteration stays
  const src = `class Buf { constructor(n) { this.chans = [new Float64Array(n)] } }
    class Port { constructor(n) { this.buf = new Buf(n) } get chans() { return 0 } }
    const tick = (self, n) => { for (let c = 0; c < 2; c++) self.buf.chans[c] = new Float64Array(n) }
    export let f = (n) => { let cs = 0
      for (let r = 0; r < n; r++) { const p = new Port(8); const q = r > 1e9 ? { buf: null } : p; tick(q, 4096); cs += q.buf.chans[1].length }
      return cs }`
  agree(src, [1, 7, 30])
  const wat = compile(src, { optimize: 'speed', wat: true })
  const f = wat.slice(wat.indexOf('(func $f'), wat.indexOf('\n  (func ', wat.indexOf('(func $f') + 10))
  ok(/call \$__esc_(val|elem)/.test(f) && !/global\.set \$__esc\s*\(i32\.const 0\)/.test(f), 'the store lowers the flag to its receiver, not to zero')
  const grown = grownBy(src)
  is(grown(300), grown(1), 'three hundred iterations grow what one does')
})

test('iteration release: a module binding keeps what it was given, the rest goes', () => {
  const src = `let g = null
    export let f = (n) => { let cs = 0; for (let i = 0; i < n; i++) { const t = []; for (let k = 0; k < 40; k++) t.push(k); g = [i, t.length]; cs += t[3] } ${CHURN}; return g[0] + g[1] + cs + junk.length }`
  agree(src)
  ok(releases(src) > 0)
  const put = `let held = null
    const put = (v) => { held = v }
    export let f = (n) => { for (let i = 0; i < n; i++) put([i, 4]); ${CHURN}; return held[0] + held[1] }`
  agree(put)
  ok(releases(put) > 0, 'a callee storing into a module binding is flagged where it runs')
})

test('iteration release: a store into a binding outside the loop, or into what one holds, keeps all', () => {
  // every iteration makes more than a release takes at once (BIG); what the
  // first one keeps must outlive the releases after it
  const cases = [
    `export let f = (n) => { let first = null; for (let i = 0; i < n; i++) { ${BIG}; if (i === 0) first = [i + 3, big.length] } ${CHURN}; return first[0] + first[1] + junk.length }`,
    `export let f = (n) => { let a = null, b = 0; for (let i = 0; i < n; i++) { ${BIG}; if (i === 0) [a, b] = [[i, 7], big.length] } ${CHURN}; return a[0] + a[1] + b + junk.length }`,
    `export let f = (n) => { const out = []; for (let i = 0; i < n; i++) { ${BIG}; out.push([i, big[1]]) } ${CHURN}; let s = 0; for (const p of out) s += p[0] + p[1]; return s }`,
    `export let f = (n) => { const fs = []; for (let i = 0; i < n; i++) { ${BIG}; const v = [i]; fs.push(() => v[0] + big.length) } ${CHURN}; return fs[0]() + fs[n >> 1]() + fs.length }`,
    `export let f = (n) => { const o = { x: null }; for (let i = 0; i < n; i++) { ${BIG}; if (i === 0) o.x = [i, 5] } ${CHURN}; return o.x[0] + o.x[1] }`,
    `export let f = (n) => { const m = new Map(); for (let i = 0; i < n; i++) { ${BIG}; m.set(i, [i * 3]) } ${CHURN}; return m.get(0)[0] + m.get(n - 1)[0] + m.size }`,
    `export let f = (n) => { let s = ''; for (let i = 0; i < n; i++) { ${BIG}; s += 'x' + i } ${CHURN}; return s.length + s.charCodeAt(1) }`,
    `const keep = (o, v) => { if (!o.v) o.v = v }
      export let f = (n) => { const o = { v: null }; for (let i = 0; i < n; i++) { ${BIG}; keep(o, [i, 9]) } ${CHURN}; return o.v[0] + o.v[1] }`,
    `export let f = (n) => { let head = null; for (let i = 0; i < n; i++) { ${BIG}; head = { v: i, next: head } } ${CHURN}; let s = 0; for (let p = head; p; p = p.next) s += p.v; return s }`,
    `let g = null
      export let f = (n) => { for (let i = 0; i < n; i++) { ${BIG}; if (i === 0) g = [i + 1, 3] } ${CHURN}; return g[0] + g[1] }`,
  ]
  for (const src of cases) agree(src, [1, 3, 9])
  // the parser's loop, which the walk releases, keeping a tree in each way
  const S = `let s = ''; for (let i = 0; i < 4000; i++) s += String.fromCharCode(97 + i % 26)`
  const kept = [
    `let first = null; for (let r = 0; r < n; r++) { const ast = parse(s); if (r === 0) first = ast; cs = (cs + hash(ast)) | 0 } ${CHURN}; return cs + hash(first)`,
    `const trees = []; for (let r = 0; r < n; r++) { const ast = parse(s); if (r % 2 === 0) trees.push(ast); cs = (cs + hash(ast)) | 0 } ${CHURN}; return cs + hash(trees[0]) + trees.length`,
    `const box = { t: null }; for (let r = 0; r < n; r++) { const ast = parse(s); if (r === 0) box.t = ast; cs = (cs + hash(ast)) | 0 } ${CHURN}; return cs + hash(box.t)`,
    `let get = null; for (let r = 0; r < n; r++) { const ast = parse(s); if (r === 0) get = () => ast; cs = (cs + hash(ast)) | 0 } ${CHURN}; return cs + hash(get())`,
  ]
  for (const body of kept) agree(PARSE + `export let f = (n) => { ${S}; let cs = 0; ${body} }`, [1, 3, 9])
})

test('iteration release: a receiver made before the loop, and after the outermost frame began, is logged while the loop runs', () => {
  // `o` is the caller's, younger than the frame that reads the flag: a store
  // into it is logged only as one older than the loop's mark
  const src = PARSE + `const fill = (o, s, n) => { let cs = 0; for (let r = 0; r < n; r++) { const ast = parse(s); if (r === 0) o.t = ast; cs = (cs + hash(ast)) | 0 } return cs }
    export let f = (n) => { let s = ''; for (let i = 0; i < 4000; i++) s += String.fromCharCode(97 + i % 26)
      const a = { t: null }, b = { t: null }
      const cs = fill(a, s, n) + fill(b, s.slice(1), n)
      ${CHURN}; return cs + hash(a.t) + hash(b.t) + junk.length }`
  agree(src, [1, 3, 9])
  ok(releases(src) > 0, 'the callee\'s loop releases its iterations')
})

test('iteration release: a compaction inside the loop starts the next release afresh', () => {
  // the walk keeps the growing array at the top, so the memory below it
  // piles up until the loop compacts it, which moves what the mark names
  const src = `let g = []
    export let f = (n) => { g = []; let cs = 0; for (let i = 0; i < n; i++) { const t = []; for (let k = 0; k < 64; k++) t.push(k + i); g = g.concat([t[i & 63]]); cs = (cs + t[5]) | 0 } ${CHURN}; let s = 0; for (const x of g) s = (s + x) | 0; return s + cs + g.length }`
  agree(src, [10, 3000])
  ok(releases(src) > 0)
  // a callee's loop compacts while the iteration runs: it moves what a module
  // binding took before the move emptied the log, so the release after it keeps all
  const nested = `let early = null
    const grow = (r) => { let acc = []; for (let i = 0; i < 3000; i++) { const t = []; for (let k = 0; k < 64; k++) t.push(k + i); if (r === 0 && i === 10) early = [i, 42, t[3]]; acc = acc.concat([t[(i + r) & 63]]) } return acc.length }
    export let f = (n) => { let cs = 0; for (let r = 0; r < n; r++) { const big = []; for (let k = 0; k < 20000; k++) big.push(k + r); cs = (cs + grow(r) + big[7]) | 0 } ${CHURN}; return cs + early[0] + early[1] + early[2] }`
  agree(nested, [1, 2, 3])
  ok(releases(nested) > 0)
})

test('iteration release: a return, a throw or a branch out of a released loop leaves what it holds', () => {
  agree(PARSE + `export let f = (n) => { let s = ''; for (let i = 0; i < 50; i++) s += 'ab'; for (let r = 0; r < n; r++) { const ast = parse(s); if (r === (n >> 1)) return hash(ast) + ast.length } return -1 }`)
  agree(PARSE + `export let f = (n) => { let s = 'abcdef'; try { for (let r = 0; r < n; r++) { const ast = parse(s); if (r === n - 1) throw ast } } catch (x) { ${CHURN}; return hash(x) + junk.length } return 0 }`)
  agree(PARSE + `export let f = (n) => { let s = 'abcdef', cs = 0; outer: for (let q = 0; q < 3; q++) { for (let r = 0; r < n; r++) { const ast = parse(s); cs = (cs + hash(ast)) | 0; if (r === 5) continue outer } } return cs }`)
  // a function returning from a released loop leaves the log's floor where it found it
  const src = PARSE + `const find = (s, c) => { for (let r = 0; r < 3; r++) { const ast = parse(s); for (let i = 0; i < ast.length; i++) if (ast[i][0] === c) return i } return -1 }
    export let f = (n) => { let cs = 0; for (let k = 0; k < n; k++) cs += find('hello world', 111) + find('abc', 99); return cs }`
  agree(src)
})
