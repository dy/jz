// Compile stdlib (https://github.com/stdlib-js/stdlib) with jz: coverage, agreement with
// Node, and speed against V8 and against stdlib's own shipped C→wasm binaries.
//
//   STDLIB_ROOT=<dir holding node_modules/@stdlib> node scripts/stdlib-probe.mjs <command>
//
//   dump <spec> <out.json>     the lowered { code, modules } graph, a plain compile() input
//   bench <spec> <case> <kind> <lo> <hi> [lo2 hi2]   a bench/<case> from the package (see benchCase)
//   bench-all <namespace> <case>   a bench/<case> of every numeric function of a namespace (see benchAll)
//   kernels <case> [list]      each function of such a case by itself, in the one module: V8 against jz,
//                              the heap it keeps, the calls left in its loop (needs no STDLIB_ROOT)
//   one <spec>                 one scalar function: compile, diff against Node, time
//   sweep <namespace> <out>    every package of a namespace, one process each → JSON lines
//   report <out> [list]        summarize a sweep
//   blas [names…]              level-1 kernels: V8 vs stdlib's wasm vs jz, buffers in place
//
//   JZ=<checkout>              compiler to measure (default: this repo)
//   DIAG=a,b                   diagnostic rewrites, see DIAG below
//
// stdlib is CommonJS with load-time environment detection; `graph` lowers it to the ESM
// module map compile() takes. Install: npm i --ignore-scripts @stdlib/stdlib (2.2 GB).
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SELF = fileURLToPath(import.meta.url)
const JZ = process.env.JZ || join(dirname(SELF), '..')
// `kernels` reads a committed case and needs no install; every other command reads the library
const ROOT = process.env.STDLIB_ROOT ?? (process.argv[2] === 'kernels' ? dirname(SELF) : null)
if (process.argv[2] !== 'kernels' && (!ROOT || !existsSync(join(ROOT, 'node_modules/@stdlib')))) {
  console.error('STDLIB_ROOT must name a directory holding node_modules/@stdlib'); process.exit(1)
}
const { compile } = await import(join(JZ, 'index.js'))
const { instantiate } = await import(join(JZ, 'interop.js'))
const nodeRequire = createRequire(join(ROOT, 'package.json'))
const DIAGS = (process.env.DIAG || '').split(',').filter(Boolean)

// ── CommonJS → ESM ──────────────────────────────────────────────────────────

// Packages that choose builtin-or-polyfill at load time. The target answers
// statically, so each collapses to the builtin or a constant.
const BUILTIN = { '@stdlib/array/buffer': 'ArrayBuffer', '@stdlib/array/dataview': 'DataView', '@stdlib/number/ctor': 'Number' }
for (const [k, v] of Object.entries({ float64: 'Float64Array', float32: 'Float32Array', uint32: 'Uint32Array', int32: 'Int32Array', uint16: 'Uint16Array', int16: 'Int16Array', uint8: 'Uint8Array', int8: 'Int8Array', uint8c: 'Uint8ClampedArray' }))
  BUILTIN['@stdlib/array/' + k] = v
const ALIAS = {
  '@stdlib/assert/is-little-endian': 'export default true',
  '@stdlib/assert/is-big-endian': 'export default false',
  // the logger a few iterations report to: disabled unless DEBUG names it, so a no-op
  'debug': 'export default (name) => (a, b, c, d, e) => {}',
}
// `has-*-support` asks the environment once, at load (generators through `eval`):
// the answer Node gives is the target's.
const DETECT = /^@stdlib\/assert\/has-[\w-]+-support$/
const detected = (spec) => DETECT.test(spec) ? `export default () => ${nodeRequire(spec)() === true}` : null
// `setReadOnly( f, 'k', v )` on a function object is `f.k = v`
const DEFPROP = new Set(['@stdlib/utils/define-nonenumerable-read-only-property', '@stdlib/utils/define-read-only-property'])

const written = (name) => new RegExp('(^|[^.\\w])' + name + '\\s*(=(?!=)|[-+*/%&|^]=|<<=|>>=|>>>=|\\+\\+|--)|(\\+\\+|--)\\s*' + name + '\\b', 'm')
const once = (src, name, at, len) => !written(name).test(src.slice(0, at) + src.slice(at + len))

// Diagnostic rewrites. Each stands in for ONE compiler inference, to price that
// inference on real code. Measuring instruments, never the fix: the input stays as is.
const NUMERIC_DOC = /^(number|integer|NonNegativeInteger|PositiveInteger|NonNegativeNumber|PositiveNumber|Probability)$/
const DIAG = {
  // module `var` written only by its initializer → const
  constify: (src) => src.replace(/^var(\s+)(\w+)(\s*=)(?!\s*require\()/gm, (m, a, name, b, at) => once(src, name, at, m.length) ? 'const' + a + name + b : m),
  // function-top `var x;` → `let x = 0.0;` (numeric locals): presence of a loop-carried local
  letinit: (src) => src.replace(/^(\t+)var(\s+\w+);/gm, '$1let$2 = 0.0;'),
  // module array literal of numbers → Float64Array
  f64lit: (src) => src.replace(/^(var|const)(\s+\w+\s*=\s*)(\[\s*-?[\d.][\d.eE+\-]*(?:\s*,\s*-?[\d.][\d.eE+\-]*)*\s*\]);/gm, '$1$2new Float64Array($3);'),
}
const DIAG_ALIAS = { f64lit: { '@stdlib/array/base/zeros': 'export default (n) => new Float64Array(n)' } }
// JSDoc `@param {number} x` → `x = +x` at entry: complete numeric-parameter inference
const numparams = (src) => src.replace(/\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*function\s+(\w+)\s*\(([^)]*)\)\s*\{/g, (m, doc, name, params) => {
  const ps = params.split(',').map(p => p.trim()).filter(Boolean)
  const num = [...doc.matchAll(/@param\s+\{([^}]+)\}\s+(\w+)/g)].filter(d => NUMERIC_DOC.test(d[1]) && ps.includes(d[2])).map(d => d[2])
  return m + num.map(n => `\n\t${n} = +${n};`).join('')
})

const REQUIRE = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g
const DECL = /^var\s+(\w+)\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\);?\s*$/gm

//   var X = require('spec')  →  import X from 'abs'
//   … require('spec') …      →  hoisted import
//   module.exports = X       →  export default X
function toESM(src, file, resolve, diag) {
  if (diag.includes('numparams')) src = numparams(src)
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*(['"])use strict\1;?/m, '')
  const imports = [], deps = new Set(), hoisted = new Map(), renames = [], defprops = []
  src = src.replace(DECL, (m, name, q, spec, at) => {
    if (BUILTIN[spec]) { if (name !== BUILTIN[spec]) renames.push([name, BUILTIN[spec]]); return '' }
    // a sibling package required by a relative path (`./../../define-nonenumerable-read-only-property`) is the package
    if (DEFPROP.has(spec) || (spec.startsWith('.') && DEFPROP.has(/node_modules\/(@stdlib\/.+?)\/lib\/index\.js$/.exec(resolve(spec, file))?.[1] ?? ''))) { defprops.push(name); return '' }
    if (!once(src, name, at, m.length)) return m
    const key = resolve(spec, file)
    deps.add(key); imports.push(`import ${name} from '${key}'`)
    return ''
  })
  for (const [from, to] of renames) src = src.replace(new RegExp('\\b' + from + '\\b', 'g'), to)
  for (const name of defprops)
    src = src.replace(new RegExp('\\b' + name + '\\(\\s*([\\w.]+)\\s*,\\s*([\'"])(\\w+)\\2\\s*,\\s*', 'g'), '$1.$3 = (')
  for (const d of diag) if (DIAG[d]) src = DIAG[d](src)
  src = src.replace(REQUIRE, (m, q, spec) => {
    const key = resolve(spec, file)
    if (!hoisted.has(key)) { hoisted.set(key, `__r${hoisted.size}`); imports.push(`import ${hoisted.get(key)} from '${key}'`); deps.add(key) }
    return hoisted.get(key)
  })
  return { code: imports.join('\n') + '\n' + src.replace(/^module\.exports\s*=\s*/gm, 'export default '), deps: [...deps] }
}

// The { code, modules } pair compile() takes, walked from an ESM driver.
function graph(driver, diag = DIAGS) {
  const alias = Object.assign({}, ALIAS, ...diag.map(d => DIAG_ALIAS[d]))
  const modules = {}
  // by the package a path names too: stdlib requires a sibling package by a relative path
  const aliased = (name) => name != null && (alias[name] ?? detected(name)) != null
  const resolve = (spec, from) => {
    if (aliased(spec)) return 'alias:' + spec
    const file = createRequire(from).resolve(spec), pkg = /node_modules\/(@stdlib\/.+?)\/lib\/index\.js$/.exec(file)?.[1]
    return aliased(pkg) ? 'alias:' + pkg : file
  }
  const visit = (key) => {
    if (key in modules) return
    if (key.startsWith('alias:')) { modules[key] = alias[key.slice(6)] ?? detected(key.slice(6)); return }
    // `require( './table.json' )` is the parsed value
    if (key.endsWith('.json')) { modules[key] = 'export default ' + readFileSync(key, 'utf8').trim(); return }
    modules[key] = ''  // cycle guard
    const { code, deps } = toESM(readFileSync(key, 'utf8'), key, resolve, diag)
    modules[key] = code
    deps.forEach(visit)
  }
  const from = join(ROOT, 'driver.js')
  const code = driver.replace(/from\s+(['"])([^'"]+)\1/g, (m, q, spec) => { const key = resolve(spec, from); visit(key); return `from '${key}'` })
  return { code, modules }
}

const build = (driver, opts = {}) => {
  const g = graph(driver), t = performance.now()
  const wasm = compile(g.code, { modules: g.modules, optimize: 'speed', ...opts })
  return { wasm, ms: performance.now() - t, mods: Object.keys(g.modules).length }
}

// Interleaved minimum: each round times every contender once, so background load
// falls on all alike; the minimum is each contender's least disturbed sample.
const race = (fns, rounds = 15, warm = 3) => {
  for (let i = 0; i < warm; i++) for (const f of fns) f()
  const best = fns.map(() => Infinity)
  for (let r = 0; r < rounds; r++) fns.forEach((f, i) => { const t = performance.now(); f(); best[i] = Math.min(best[i], performance.now() - t) })
  return best
}

// ── one scalar function ─────────────────────────────────────────────────────

const RANGES = [[0.05, 0.95], [1.5, 20], [-3, 3], [1, 100], [-0.9, 0.9]]
// the arguments after the first, constant over a sweep: shape and scale parameters, counts
const EXTRA = [[], [2.5], [2.5, 1.5], [3, 2], [0.5, 0.25], [-1.5, 2.5], [3], [0.5],
  [2.5, 1.5, 0.5], [20, 10, 5], [0.5, 0.25, 2], [3, 2, 1], [2.5, 1.5, 0.5, 2], [20, 10, 5, 2]]
const PARAMS = ['x', 'a', 'b', 'c', 'e']
const SPECIALS = [0, -0, 1, -1, NaN, Infinity, -Infinity, 1e-300, 1e300, 0.5, 2, 1e-10, 12345.678]

// the integers a function of counts takes (`fibonacci( n )`, `gcd( a, b )`, `binomcoef( n, k )`)
const INT_RANGES = [[0, 40], [1, 24], [-24, 24], [-40, 0], [0, 8]]
// the i-th of n inputs of a domain: evenly spread, whole where the domain is of integers
const input = (dom, i, n) => dom.int ? Math.floor(dom.lo + (dom.hi - dom.lo + 1) * i / n) : dom.lo + (dom.hi - dom.lo) * i / n

// the count of numbers a result lists (`frexp( x )` is [ frac, exp ]); 0 for any other value
const listOf = (v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length >= 1 && v.length <= 4 && Array.prototype.every.call(v, e => typeof e === 'number') ? v.length : 0

// a domain where Node returns finite numbers, so the timing exercises the main path:
// of reals where one is, else of integers
function domain(fn, arity) {
  for (const int of [false, true]) for (const [lo, hi] of int ? INT_RANGES : RANGES) for (const c of EXTRA) {
    if (c.length !== arity - 1 || (int && !c.every(Number.isInteger))) continue
    const dom = { lo, hi, c, ...(int ? { int } : {}) }
    let finite = 0, numeric = true, len = 0
    for (let i = 0; i < 40 && numeric; i++) {
      let v; try { v = fn(input(dom, i, 40), ...c) } catch { numeric = false }
      const l = listOf(v)
      if (i === 0) len = l
      if (l !== len || (l === 0 && typeof v !== 'number')) numeric = false
      else if (l ? Array.prototype.every.call(v, Number.isFinite) : Number.isFinite(v)) finite++
    }
    if (numeric && finite >= 36) return len ? { ...dom, len } : dom
  }
}

// The function as an export the host calls per element: its ABI (plain f64
// parameters, or boxed values) and the time of a call through the interop wrapper
// and through the raw export. BOUNDARY=1 adds it to a probe.
function boundary(spec, fn, arity, xj, c, jsNs) {
  const ps = PARAMS.slice(0, arity).join(', '), N = 20000, out = {}
  try {
    const b = build(`import fn from '${spec}'\nexport let f = (${ps}) => fn(${ps})`)
    const inst = instantiate(b.wasm)
    let raw = null
    try { const e = new WebAssembly.Instance(new WebAssembly.Module(b.wasm), {}).exports; if (typeof e.f(xj[0], ...c) === 'number') raw = e.f } catch {}
    out.abi = raw ? 'f64' : 'boxed'
    const drive = (f) => () => { let s = 0; for (let i = 0; i < N; i++) s += f(xj[i], ...c); return s }
    const [js, call, rawT] = race([drive(fn), drive(inst.exports.f), ...(raw ? [drive(raw)] : [])], 9, 2)
    out.callRatio = +(call / js).toFixed(3)
    if (raw) out.rawRatio = +(rawT / js).toFixed(3)
  } catch (e) { out.abi = 'fails'; out.boundaryErr = String(e.message).split('\n')[0].slice(0, 120) }
  return out
}

function one(spec) {
  const out = { spec, diag: DIAGS.join(',') }
  let fn
  try { fn = nodeRequire(spec) } catch (e) { return { ...out, status: 'node-load-fail', err: String(e.message).split('\n')[0] } }
  if (typeof fn !== 'function') return { ...out, status: 'not-function' }
  const arity = out.arity = fn.length
  if (arity < 1 || arity > PARAMS.length) return { ...out, status: 'arity-skip' }
  const dom = out.domain = domain(fn, arity)
  if (!dom) return { ...out, status: 'no-numeric-domain' }
  const { lo, hi, c } = dom
  // The kernel reads its arguments from buffers the driver owns and writes its
  // results to one, as a bench case does: what the function takes is numbers,
  // not values of the boundary's kind. The function as an export of its own
  // (`f`, the boundary a host calls per element) is a second module.
  // A result that lists L numbers is L results: each is stored, and the sum takes them all.
  const L = dom.len || 1, N = dom.len ? 50000 : 200000, pages = dom.len ? 512 : 128
  const rest = c.map((_, i) => `, C[${i}]`).join('')
  const slots = Array.from({ length: L }, (_, j) => j)
  const store = dom.len ? `const r = fn(X[i]${rest}); ${slots.map(j => `OUT[i * ${L} + ${j}] = r[${j}]`).join('; ')}` : `OUT[i] = fn(X[i]${rest})`
  const sum = dom.len ? `const r = fn(X[i]${rest}); s += ${slots.map(j => `r[${j}]`).join(' + ')}` : `s += fn(X[i]${rest})`
  let b
  try {
    b = build(`import fn from '${spec}'
const X = new Float64Array(${N})
const OUT = new Float64Array(${N * L})
const C = new Float64Array(${Math.max(c.length, 1)})
export let xs = () => X
export let outs = () => OUT
export let cs = () => C
export let each = (n) => { for (let i = 0; i < n; i++) { ${store} } }
export let loop = (n) => { let s = 0; for (let i = 0; i < n; i++) { ${sum} } return s }`, { memory: pages })
  } catch (e) { return { ...out, status: 'compile-fail', err: String(e.message).split('\n')[0].slice(0, 200) } }
  Object.assign(out, { bytes: b.wasm.byteLength, compileMs: Math.round(b.ms), mods: b.mods })
  let inst
  try { inst = instantiate(b.wasm, { memory: pages }) } catch (e) { return { ...out, status: 'instantiate-fail', err: String(e.message).split('\n')[0].slice(0, 200) } }
  if (c.length) inst.exports.cs().set(c)

  // Agreement with Node, bit for bit, at every point where Node answers: a point
  // where it throws (`binomcoef( 1e300, 3 )` recurses without end) would end the
  // kernel's one pass over them all.
  const all = [...SPECIALS]
  for (let i = 0; i < 200; i++) all.push(dom.int ? input(dom, i, 200) : lo + (hi - lo) * (i + 0.37) / 200)
  const pts = [], wants = []
  for (const x of all) { try { wants.push(fn(x, ...c)); pts.push(x) } catch { out.nodeThrows = (out.nodeThrows || 0) + 1 } }
  out.points = pts.length; out.mismatch = 0; out.thrown = 0
  try {
    inst.exports.xs().set(pts)
    inst.exports.each(pts.length)
    const got = inst.exports.outs()
    pts.forEach((x, i) => {
      for (let j = 0; j < L; j++) {
        const g = got[i * L + j], w = dom.len ? wants[i]?.[j] : wants[i]
        if (!Object.is(g, w)) { out.mismatch++; out.firstBad ??= { x, got: String(g), want: String(w) } }
      }
    })
  } catch (e) { out.thrown++; out.firstBad ??= { err: String(e.message).slice(0, 80) } }

  const xj = new Float64Array(N)
  for (let i = 0; i < N; i++) xj[i] = input(dom, i, N)
  const drive = dom.len
    ? (f) => (n) => { let s = 0; for (let i = 0; i < n; i++) { const r = f(xj[i], ...c); for (let j = 0; j < L; j++) s += r[j] } return s }
    : (f) => (n) => { let s = 0; for (let i = 0; i < n; i++) s += f(xj[i], ...c); return s }
  const contenders = [drive(fn), (n) => inst.exports.loop(n)]
  try {
    inst.exports.xs().set(xj)
    // The two loops sum the same terms. A loop jz runs in lanes adds them in another
    // order (README, "Float sums in lanes"): the sums then agree to rounding, and
    // `each` above has compared every term bit for bit.
    const want = contenders[0](N), got = contenders[1](N)
    if (!Object.is(got, want)) {
      if (Math.abs(got - want) <= 1e-11 * Math.abs(want)) out.laneSum = true
      else { out.sumDiffers = true; out.firstBad ??= { loop: String(got), want: String(want) } }
    }
    const [js, loop] = race(contenders.map(f => () => f(N)), 9, 2)
    const ns = (t) => +(t / N * 1e6).toFixed(2), x = (t) => +(t / js).toFixed(3)
    Object.assign(out, { jsNs: ns(js), loopNs: ns(loop), loopRatio: x(loop) })
    out.status = 'ok'
  } catch (e) { out.status = 'run-fail'; out.err = String(e.message).split('\n')[0].slice(0, 200) }
  if (out.status === 'ok' && process.env.BOUNDARY) Object.assign(out, boundary(spec, fn, arity, xj, c, out.jsNs))
  return out
}

// ── sweep ───────────────────────────────────────────────────────────────────

// The packages of a namespace, at any depth: a distribution's functions sit a level
// below it (`stats/base/dists/normal/cdf`). A package's own folders are no packages.
const OWN = new Set(['lib', 'docs', 'test', 'benchmark', 'examples', 'src', 'include', 'scripts', 'bin', 'etc', 'data', 'wasm', 'node_modules'])
function packages(ns) {
  const out = []
  const walk = (rel) => {
    for (const d of readdirSync(join(ROOT, 'node_modules/@stdlib', rel), { withFileTypes: true })) {
      if (!d.isDirectory() || OWN.has(d.name)) continue
      const sub = `${rel}/${d.name}`
      if (existsSync(join(ROOT, 'node_modules/@stdlib', sub, 'package.json'))) out.push(`@stdlib/${sub}`)
      walk(sub)
    }
  }
  walk(ns)
  return out
}

function sweep(ns, outFile, conc = 4) {
  const pkgs = packages(ns)
  const seen = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).spec) : [])
  if (!existsSync(outFile)) writeFileSync(outFile, '')
  const queue = pkgs.filter(p => !seen.has(p))
  console.log(`${ns}: ${pkgs.length} packages, ${queue.length} to run`)
  let active = 0, n = 0
  const next = () => {
    while (active < conc && queue.length) {
      const spec = queue.shift(); active++
      const ch = spawn(process.execPath, [SELF, 'one', spec, '--json'])
      let buf = '', err = ''
      const kill = setTimeout(() => ch.kill('SIGKILL'), 180000)
      ch.stdout.on('data', d => buf += d); ch.stderr.on('data', d => err += d)
      ch.on('close', (code, sig) => {
        clearTimeout(kill); active--
        const m = /@@(.*)/.exec(buf)
        appendFileSync(outFile, JSON.stringify(m ? JSON.parse(m[1]) : { spec, status: sig ? 'timeout' : 'crash', err: (err.split('\n').find(l => /Error/.test(l)) || err).slice(0, 200) }) + '\n')
        if (++n % 20 === 0) console.log(n, 'done')
        next()
      })
    }
    if (!active && !queue.length) console.log('sweep complete', n)
  }
  next()
}

// a package's name in a report: what follows `base/` (`special/exp`, `dists/normal/cdf`)
const short = (spec) => spec.replace(/^@stdlib\/(?:\w+\/)*?base\//, '')
function report(file, list) {
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const gm = (a) => a.length ? Math.exp(a.reduce((s, x) => s + Math.log(x), 0) / a.length) : NaN
  const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1]
  const tally = {}; for (const r of rows) tally[r.status] = (tally[r.status] || 0) + 1
  const ok = rows.filter(r => r.status === 'ok'), exact = ok.filter(r => !r.mismatch && !r.thrown && !r.sumDiffers)
  const lr = ok.map(r => r.loopRatio), rr = ok.filter(r => r.rawRatio != null).map(r => r.rawRatio)
  console.log('packages', rows.length, tally)
  console.log(`ran ${ok.length}: agree with Node on every point ${exact.length}, disagree ${ok.length - exact.length}; summed in lanes ${ok.filter(r => r.laneSum).length}`)
  const bd = ok.filter(r => r.abi)
  if (bd.length) {
    console.log(`export ABI (n=${bd.length}): f64 ${bd.filter(r => r.abi === 'f64').length}, boxed ${bd.filter(r => r.abi === 'boxed').length}`)
    console.log(`call per element, raw f64 export (n=${rr.length}): geomean ${gm(rr).toFixed(2)}×; interop wrapper: geomean ${gm(bd.filter(r => r.callRatio).map(r => r.callRatio)).toFixed(2)}×`)
  }
  console.log(`loop in wasm, jz/js: geomean ${gm(lr).toFixed(2)}× median ${med(lr).toFixed(2)}× | faster ${lr.filter(x => x < 0.95).length}, par ${lr.filter(x => x >= 0.95 && x <= 1.05).length}, slower ${lr.filter(x => x > 1.05).length}`)
  console.log(`size: median ${med(ok.map(r => r.bytes))} B | compile: median ${med(ok.map(r => r.compileMs))} ms`)
  const errs = {}
  for (const r of rows) if (r.err) (errs[r.status + ': ' + r.err.replace(/'[^']*'/g, "'…'").slice(0, 100)] ||= []).push(short(r.spec))
  for (const [k, v] of Object.entries(errs).sort((a, b) => b[1].length - a[1].length)) console.log(String(v.length).padStart(4), k, ' e.g.', v.slice(0, 3).join(', '))
  if (!list) return
  for (const r of [...ok].sort((a, b) => a.loopRatio - b.loopRatio))
    console.log(short(r.spec).padEnd(34), `loop ${r.loopRatio}×`.padEnd(14), `${r.bytes} B`.padEnd(9), r.mismatch || r.sumDiffers ? `DISAGREES ×${r.mismatch} ${JSON.stringify(r.firstBad)}` : '')
}

// ── BLAS level 1 ────────────────────────────────────────────────────────────

// The DRIVER owns the buffers, so jz knows the receivers are Float64Array; the stdlib
// kernel source is compiled as published. stdlib's binary runs on its own memory.
const KERNELS = {
  daxpy: { call: 'fn(N, a, X, 1, 0, Y, 1, 0); return 0', js: (f, x, y) => (n) => f(n, 1.0000001, x, 1, 0, y, 1, 0), out: 'y' },
  ddot: { call: 'return fn(N, X, 1, 0, Y, 1, 0)', js: (f, x, y) => (n) => f(n, x, 1, 0, y, 1, 0), out: 'ret' },
  dasum: { call: 'return fn(N, X, 1, 0)', js: (f, x) => (n) => f(n, x, 1, 0), out: 'ret' },
  dnrm2: { call: 'return fn(N, X, 1, 0)', js: (f, x) => (n) => f(n, x, 1, 0), out: 'ret' },
  dscal: { call: 'fn(N, a, X, 1, 0); return 0', js: (f, x) => (n) => f(n, 1.0000001, x, 1, 0), out: 'x' },
  dswap: { call: 'fn(N, X, 1, 0, Y, 1, 0); return 0', js: (f, x, y) => (n) => f(n, x, 1, 0, y, 1, 0), out: 'y' },
  idamax: { call: 'return fn(N, X, 1, 0)', js: (f, x) => (n) => f(n, x, 1, 0), out: 'ret' },
}
function blas(names) {
  const N = +(process.env.N || 1000), CAP = 131072
  const fill = (a, seed) => { let s = seed; for (let i = 0; i < a.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = s / 4294967296 - 0.5 } }
  const sum = (a) => { let s = 0; for (let i = 0; i < N; i++) s += a[i]; return s }
  for (const name of Object.keys(KERNELS)) {
    if (names.length && !names.includes(name)) continue
    const k = KERNELS[name]
    const js = nodeRequire(`@stdlib/blas/base/${name}`).ndarray
    const bin = readFileSync(join(ROOT, `node_modules/@stdlib/blas/base/wasm/${name}/src/main.wasm`))
    const cmem = new WebAssembly.Memory({ initial: 64 })
    const cfn = new WebAssembly.Instance(new WebAssembly.Module(bin), { env: { memory: cmem } }).exports[`c_${name}_ndarray`]
    const driver = `import fn from '@stdlib/blas/base/${name}/lib/ndarray.js'
const X = new Float64Array(${CAP})
const Y = new Float64Array(${CAP})
export let xbuf = () => X
export let ybuf = () => Y
export let k = (N, a) => { ${k.call} }`
    let b, inst, text
    try { b = build(driver, { memory: 64 }); inst = instantiate(b.wasm, { memory: 64 }); text = build(driver, { memory: 64, wat: true }).wasm }
    catch (e) { console.log(name.padEnd(7), 'jz FAIL', String(e.message).split('\n')[0].slice(0, 140)); continue }
    const jx = new Float64Array(N), jy = new Float64Array(N); fill(jx, 1); fill(jy, 2)
    const cx = new Float64Array(cmem.buffer, 1024, N), cy = new Float64Array(cmem.buffer, 1024 + CAP * 8, N); cx.set(jx); cy.set(jy)
    inst.exports.xbuf().set(jx); inst.exports.ybuf().set(jy)
    const fj = k.js(js, jx, jy), fc = k.js(cfn, cx.byteOffset, cy.byteOffset), fz = (n) => inst.exports.k(n, 1.0000001)
    const res = (r, x, y) => k.out === 'ret' ? r : sum(k.out === 'y' ? y : x)
    const vj = res(fj(N), jx, jy), vz = res(fz(N), inst.exports.xbuf(), inst.exports.ybuf())
    const reps = Math.max(1, Math.round(2e6 / N)), rep = (f) => () => { for (let r = 0; r < reps; r++) f(N) }
    const [tj, tc, tz] = race([rep(fj), rep(fc), rep(fz)]), per = (t) => (t / reps / N * 1e6).toFixed(3)
    console.log(name.padEnd(7), `N=${N}  js ${per(tj)} ns/el | stdlib wasm ${per(tc)} (${(tc / tj).toFixed(2)}× js) | jz ${per(tz)} (${(tz / tj).toFixed(2)}× js, ${(tz / tc).toFixed(2)}× stdlib wasm)`,
      `| ${b.wasm.byteLength} B vs ${bin.length} B, v128=${(text.match(/v128/g) || []).length}`,
      Object.is(vz, vj) ? '' : Math.abs(vz - vj) <= 4 * Number.EPSILON * Math.abs(vj) ? `| ulp: ${vz} vs ${vj} (a lane reduction adds in another order)` : `| jz DISAGREES: ${vz} vs ${vj}`)
  }
}

// ── cli ─────────────────────────────────────────────────────────────────────

// The lowered graph of a package's driver as { code, modules } JSON: a failing
// package is then a plain compile() input, bisected without the harness.
function dump(spec, file) {
  const fn = nodeRequire(spec), arity = Math.min(Math.max(fn.length, 1), PARAMS.length)
  const ps = PARAMS.slice(0, arity).join(', ')
  const g = graph(`import fn from '${spec}'\nexport let f = (${ps}) => fn(${ps})`)
  writeFileSync(file, JSON.stringify(g))
  console.log(`${Object.keys(g.modules).length} modules → ${file}`)
}

// A bench case (bench/<case>/<case>.js) from a package: its lowered graph bundled
// into one file by esbuild (scope-hoisted, unminified: the package's own code,
// only the module seams gone), then the sweep. `kind` names the call shape and
// the inputs follow the package's own benchmark/benchmark.js:
//   unary  lo hi              y = fn( x )
//   binary lo hi lo2 hi2      z = fn( x, y )
//   blas1  lo hi              d = fn( N, x, 1, y, 1 ) over two N-vectors, integer-valued
//                             so a reduction sums exactly in any lane order (the
//                             checksum is bit for bit), N varied so no compiler hoists
//                             the pure call out of the sweep
// The case is a library workload: bench.mjs lowers it with jzify (LOWERED_CASES).
async function benchCase(spec, id, kind, ...ranges) {
  const arity = { unary: 2, binary: 4, blas1: 2 }[kind]
  if (!arity || ranges.length < arity || ranges.slice(0, arity).some(r => !Number.isFinite(+r)))
    throw new Error(`bench <spec> <case> unary|binary|blas1 <lo> <hi> [lo2 hi2]: got ${[kind, ...ranges].join(' ')}`)
  const { build } = await import('esbuild')
  const g = graph(`import fn from '${spec}'\nexport default fn`)
  const r = await build({
    stdin: { contents: g.code, resolveDir: '/', loader: 'js', sourcefile: 'driver.js' },
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2020', write: false, minify: false, legalComments: 'none',
    plugins: [{ name: 'lowered', setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => a.path in g.modules ? { path: a.path, namespace: 'lowered' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'lowered' }, (a) => ({ contents: g.modules[a.path], loader: 'js', resolveDir: '/' }))
    } }],
  })
  let js = r.outputFiles[0].text
  const tail = js.match(/\nexport \{\s*(\w+) as default\s*\};?\s*$/)
  if (!tail) throw new Error('no default export in the bundle')
  js = js.slice(0, tail.index).replace(/^\/\/ lowered:.*\n/gm, '')
  const [lo, hi, lo2, hi2] = ranges.map(Number)
  const version = JSON.parse(readFileSync(join(ROOT, 'node_modules/@stdlib/stdlib/package.json'), 'utf8')).version
  const sweep = kind === 'unary' ? `for (let i = 0; i < N_EVAL; i++) out[i] = fn(x[i & (N_IN - 1)])`
    : kind === 'binary' ? `for (let i = 0; i < N_EVAL; i++) out[i] = fn(x[i & (N_IN - 1)], y[i & (N_IN - 1)])`
    : `for (let i = 0; i < N_EVAL; i++) out[i] = fn(N_IN - (i & 7), x, 1, y, 1)`
  const inputs = kind === 'unary' ? `const x = uniform(N_IN, ${lo}, ${hi}, 0x1234abcd)`
    : kind === 'binary' ? `const x = uniform(N_IN, ${lo}, ${hi}, 0x1234abcd), y = uniform(N_IN, ${lo2 ?? lo}, ${hi2 ?? hi}, 0x9e3779b9)`
    : `const x = uniform(N_IN, ${lo}, ${hi}, 0x1234abcd), y = uniform(N_IN, ${lo}, ${hi}, 0x9e3779b9)
  for (let i = 0; i < N_IN; i++) { x[i] = Math.floor(x[i]); y[i] = Math.floor(y[i]) }   // exact products and sums, whatever the lane order`
  const evals = kind === 'blas1' ? '1 << 12' : '1 << 20'
  const source = `// ${id}.js — ${spec} from stdlib ${version} (Apache-2.0), bundled from its CommonJS
// sources by scripts/stdlib-probe.mjs (\`bench ${spec} ${id} ${kind} ${ranges.join(' ')}\`):
// the package's own code with the module seams gone, nothing rewritten. The
// sweep follows its benchmark/benchmark.js: inputs uniform in [${lo}, ${hi}]${kind === 'binary' ? ` and [${lo2 ?? lo}, ${hi2 ?? hi}]` : kind === 'blas1' ? ', integer-valued (exact in any order), N varied per call' : ''}.
// Copyright (c) The Stdlib Authors. Licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0); the notices of the bundled files
// are retained by reference to the package.
import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

${js.trim()}

const fn = ${tail[1]}
const N_IN = ${kind === 'blas1' ? 1024 : 4096}
const N_EVAL = ${evals}
const N_RUNS = 21
const N_WARMUP = 5

// XorShift32, uniform in [lo, hi): deterministic per target.
const uniform = (n, lo, hi, seed) => {
  const out = new Float64Array(n)
  let s = seed | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = lo + ((s >>> 0) / 4294967296) * (hi - lo)
  }
  return out
}

const run = () => {
  ${inputs}
  const out = new Float64Array(N_EVAL)
  const sweep = () => { ${sweep} }
  for (let i = 0; i < N_WARMUP; i++) sweep()
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    sweep()
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(out), N_EVAL, 1, N_RUNS)
}

export let main = () => {
  run()
}
`
  const dir = join(dirname(SELF), '..', 'bench', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.js`), source)
  console.log(`${dir}/${id}.js: ${source.length} B, ${Object.keys(g.modules).length} modules`)
}

// The packages of a namespace the corpus case leaves out, each with the reason: a
// function jz does not compile yet. Listed in the case's header; an entry goes the
// commit its package compiles.
const SYMBOL = 'a read of `Symbol` as a value, through `@stdlib/symbol/ctor`'
const STRING = 'methods of `String.prototype` and `String.fromCharCode` held by names (`@stdlib/string/base/format-interpolate`)'
const PENDING = {
  '@stdlib/math/base/special/hyp2f1': SYMBOL,
  '@stdlib/stats/base/dists/studentized-range/cdf': SYMBOL,
  '@stdlib/stats/base/dists/studentized-range/quantile': SYMBOL,
  '@stdlib/stats/base/dists/signrank/cdf': STRING,
  '@stdlib/stats/base/dists/signrank/pdf': STRING,
  '@stdlib/stats/base/dists/signrank/quantile': STRING,
}

// A bench case (bench/<case>/<case>.js) of a whole namespace: every package whose
// function Node evaluates to finite numbers over one of the probe's domains
// (`domain`), bundled into one file as `benchCase` bundles one. Each function is
// swept over its domain by a loop of its own, the arguments after the first as the
// probe chose them; the checksum folds every word of every result.
async function benchAll(ns, id) {
  const { build } = await import('esbuild')
  const fns = []
  for (const spec of packages(ns)) {
    let fn
    try { fn = nodeRequire(spec) } catch { continue }
    if (typeof fn !== 'function' || fn.length < 1 || fn.length > PARAMS.length || spec in PENDING) continue
    const dom = domain(fn, fn.length)
    if (dom) fns.push({ spec, ...dom })
  }
  const g = graph(fns.map((f, k) => `import f${k} from '${f.spec}'`).join('\n') + `\nexport { ${fns.map((f, k) => `f${k}`).join(', ')} }`)
  const r = await build({
    stdin: { contents: g.code, resolveDir: '/', loader: 'js', sourcefile: 'driver.js' },
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2020', write: false, minify: false, legalComments: 'none',
    plugins: [{ name: 'lowered', setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => a.path in g.modules ? { path: a.path, namespace: 'lowered' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'lowered' }, (a) => ({ contents: g.modules[a.path], loader: 'js', resolveDir: '/' }))
    } }],
  })
  let js = r.outputFiles[0].text
  const tail = js.match(/\nexport \{([^}]*)\};?\s*$/)
  if (!tail) throw new Error('no exports in the bundle')
  const local = new Map(tail[1].split(',').map(e => e.trim()).filter(Boolean).map(e => { const [from, to] = e.split(/\s+as\s+/); return [to ?? from, from] }))
  js = js.slice(0, tail.index).replace(/^\/\/ lowered:.*\n/gm, '')
  const version = JSON.parse(readFileSync(join(ROOT, 'node_modules/@stdlib/stdlib/package.json'), 'utf8')).version
  const num = (v) => Object.is(v, -0) ? '-0' : String(v)
  const kernels = fns.map((f, k) => {
    const name = local.get(`f${k}`)
    if (!name) throw new Error(`no export for ${f.spec}`)
    const x = f.int ? `Math.floor(${num(f.lo)} + u[i] * (${num(f.hi)} - ${num(f.lo)} + 1))` : `${num(f.lo)} + u[i] * (${num(f.hi)} - ${num(f.lo)})`
    const call = `${name}(${[x, ...f.c.map(num)].join(', ')})`
    // a result that lists numbers is stored as their sum
    const store = f.len ? `{ const r = ${call}; out[at + i] = ${Array.from({ length: f.len }, (_, j) => `r[${j}]`).join(' + ')} }` : `out[at + i] = ${call}`
    return `// ${short(f.spec)}\nconst k${k} = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) ${store} }`
  })
  const pending = Object.entries(PENDING).filter(([spec]) => spec.startsWith(`@stdlib/${ns}/`))
  const source = `// ${id}.js — every function of @stdlib/${ns} (stdlib ${version}, Apache-2.0) that takes
// numbers and returns one, or a list of them: ${fns.length} packages, bundled from their CommonJS sources by
// scripts/stdlib-probe.mjs (\`bench-all ${ns} ${id}\`): the packages' own code with the
// module seams gone, nothing rewritten. Each function is swept over a domain where
// it is finite (the probe's \`domain\`: of reals, or of integers for a function of
// counts), the arguments after the first held; a list is stored as its sum.
${pending.length ? `// Left out until jz compiles them:\n${pending.map(([spec, why]) => `//   ${short(spec)}: ${why}`).join('\n')}\n` : ''}// Copyright (c) The Stdlib Authors. Licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0); the notices of the bundled files
// are retained by reference to the package.
import { mix, medianUs, printResult } from '../_lib/benchlib.js'

${js.trim()}

const N_FN = ${fns.length}
const N_EVAL = 1 << 12
const N_RUNS = 21
const N_WARMUP = 5

${kernels.join('\n')}

const sweep = (u, out) => {
${fns.map((f, k) => `  k${k}(u, out, ${k} * N_EVAL)`).join('\n')}
}

// XorShift32, uniform in [0, 1): deterministic per target.
const uniform = (n, seed) => {
  const out = new Float64Array(n)
  let s = seed | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = (s >>> 0) / 4294967296
  }
  return out
}

// every word of every result
const checksum = (out) => {
  const w = new Uint32Array(out.buffer, out.byteOffset, out.length * 2)
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < w.length; i++) h = mix(h, w[i])
  return h >>> 0
}

const run = () => {
  const u = uniform(N_EVAL, 0x1234abcd)
  const out = new Float64Array(N_FN * N_EVAL)
  for (let i = 0; i < N_WARMUP; i++) sweep(u, out)
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    sweep(u, out)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksum(out), N_FN * N_EVAL, 1, N_RUNS)
}

export let main = () => {
  run()
}
`
  const dir = join(dirname(SELF), '..', 'bench', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.js`), source)
  console.log(`${dir}/${id}.js: ${fns.length} functions, ${source.length} B, ${Object.keys(g.modules).length} modules`)
}

// Each function of a namespace case (bench/<case>/<case>.js, see benchAll) measured by
// itself inside the one module a program that uses the library links: a helper a
// hundred functions share is compiled once for them all there, which a module per
// function never shows. The case's own kernels are kept and its sweep replaced by
// `run( k )`. Samples are as many sweeps as take a quarter of a millisecond, the two
// engines alternate, and the least is kept of eight in each of PASSES passes over the
// functions: a short sample is the one a loaded machine leaves whole, a pass apart
// outlasts a burst of load, and the late ones run what both engines tiered up. A
// sample is the process's CPU time (CLOCK=wall for the wall clock): the time another
// process held the core is none of the function's.
const PASSES = +(process.env.PASSES ?? 4)
async function kernels(id, list) {
  const file = join(dirname(SELF), '..', 'bench', id, `${id}.js`)
  let src = readFileSync(file, 'utf8')
  const names = [...src.matchAll(/^\/\/ (\S+)\nconst k(\d+) = /gm)].map(m => [+m[2], m[1]])
  if (!names.length) throw new Error(`${file} holds no kernels: a case of bench-all is expected`)
  src = src.replace(/^import [^\n]*benchlib[^\n]*\n/m, '')
  src = src.slice(0, src.indexOf('const sweep = (u, out) =>')) + `
const U = new Float64Array(N_EVAL), OUT = new Float64Array(N_EVAL)
export let us = () => U
export let run = (k) => {
${names.map(([k]) => `  if (k === ${k}) { k${k}(U, OUT, 0); return 1 }`).join('\n')}
  return 0
}
`
  const t0 = performance.now()
  const wasm = compile(src, { jzify: true, optimize: 'speed', memory: 4096 })
  const text = compile(src, { jzify: true, optimize: 'speed', memory: 4096, wat: true })
  console.log(`${names.length} functions, ${wasm.byteLength} B, compiled in ${Math.round((performance.now() - t0) / 2)} ms`)
  const inst = instantiate(wasm, { memory: 4096 })
  const host = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
  const fill = (u) => { let s = 0x1234abcd | 0; for (let i = 0; i < u.length; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; u[i] = (s >>> 0) / 4294967296 } }
  fill(inst.exports.us()); fill(host.us())
  const bodies = new Map()
  for (const m of text.matchAll(/\n  \(func \$([^\s()]+)/g)) { const at = m.index + 1, nx = text.indexOf('\n  (func ', at + 10); bodies.set(m[1], text.slice(at, nx > 0 ? nx : undefined)) }
  const rows = names.map(([k, name]) => {
    for (let w = 0; w < 3; w++) { host.run(k); inst.exports.run(k) }
    const heap = inst.exports.__heap?.value ?? 0
    const t = performance.now(); host.run(k); const one = Math.max(performance.now() - t, 1e-3)
    inst.exports.run(k)
    const kept = (inst.exports.__heap?.value ?? 0) - heap
    const calls = [...new Set([...(bodies.get(`k${k}`) ?? '').matchAll(/\((?:return_)?call(_indirect)? ?\$?([^\s()]*)/g)].map(m => m[1] ? 'indirect' : m[2]))]
    return { k, name: short('@stdlib/math/base/' + name), js: Infinity, jz: Infinity, reps: Math.max(1, Math.min(400, Math.ceil(0.25 / one))), kept, calls, own: bodies.has(`k${k}`) }
  })
  const wall = process.env.CLOCK === 'wall'
  const sample = (f, k, reps) => {
    if (wall) { const t = performance.now(); for (let r = 0; r < reps; r++) f(k); return (performance.now() - t) / reps }
    const t = process.cpuUsage()
    for (let r = 0; r < reps; r++) f(k)
    const d = process.cpuUsage(t)
    return (d.user + d.system) / 1000 / reps
  }
  for (let pass = 0; pass < PASSES; pass++) for (const row of rows) for (let r = 0; r < 8; r++) {
    row.js = Math.min(row.js, sample(host.run, row.k, row.reps))
    row.jz = Math.min(row.jz, sample(inst.exports.run, row.k, row.reps))
  }
  const gm = (a) => Math.exp(a.reduce((s, x) => s + Math.log(x), 0) / a.length)
  const ratio = (r) => r.jz / r.js, sum = (f) => rows.reduce((a, r) => a + f(r), 0)
  console.log(`jz/V8 per function: geomean ${gm(rows.map(ratio)).toFixed(3)}× | faster ${rows.filter(r => ratio(r) < 0.95).length}, par ${rows.filter(r => ratio(r) >= 0.95 && ratio(r) <= 1.05).length}, slower ${rows.filter(r => ratio(r) > 1.05).length}`)
  console.log(`one sweep of all: V8 ${sum(r => r.js).toFixed(1)} ms, jz ${sum(r => r.jz).toFixed(1)} ms, ${(sum(r => r.jz) / sum(r => r.js)).toFixed(3)}×`)
  console.log(`heap kept per sweep: ${sum(r => r.kept)} B in ${rows.filter(r => r.kept > 0).length} functions | loops that call nothing: ${rows.filter(r => r.own && !r.calls.length).length}`)
  const slow = rows.filter(r => ratio(r) > 1.05).sort((a, b) => ratio(b) - ratio(a))
  if (slow.length) console.log('slower than V8: ' + slow.map(r => `${r.name} ${ratio(r).toFixed(2)}`).join(', '))
  if (!list) return
  for (const r of [...rows].sort((a, b) => ratio(a) - ratio(b)))
    console.log(r.name.padEnd(34), `${ratio(r).toFixed(3)}×`.padEnd(10), `V8 ${(r.js * 1e6 / 4096).toFixed(1)} ns`.padEnd(14), r.kept ? `keeps ${r.kept} B` : '', r.calls.filter(c => !c.startsWith('__')).join(' '))
}

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'one') { const r = one(args[0]); console.log(args.includes('--json') ? '@@' + JSON.stringify(r) : r); process.exit(0) }
else if (cmd === 'dump') dump(args[0], args[1])
else if (cmd === 'bench') await benchCase(args[0], args[1], args[2], ...args.slice(3))
else if (cmd === 'bench-all') await benchAll(args[0], args[1])
else if (cmd === 'kernels') await kernels(args[0], args[1] === 'list')
else if (cmd === 'sweep') sweep(args[0], args[1], +(args[2] || 4))
else if (cmd === 'report') report(args[0], args[1] === 'list')
else if (cmd === 'blas') blas(args)
else console.log('usage: stdlib-probe.mjs one <spec> | sweep <namespace> <out.jsonl> [concurrency] | report <out.jsonl> [list] | blas [names…] | bench <spec> <case> <kind> <lo> <hi> [lo2 hi2] | bench-all <namespace> <case> | kernels <case> [list] | dump <spec> <out.json>')
