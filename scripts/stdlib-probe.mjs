// Compile stdlib (https://github.com/stdlib-js/stdlib) with jz: coverage, agreement with
// Node, and speed against V8 and against stdlib's own shipped C→wasm binaries.
//
//   STDLIB_ROOT=<dir holding node_modules/@stdlib> node scripts/stdlib-probe.mjs <command>
//
//   dump <spec> <out.json>     the lowered { code, modules } graph, a plain compile() input
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
import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SELF = fileURLToPath(import.meta.url)
const JZ = process.env.JZ || join(dirname(SELF), '..')
const ROOT = process.env.STDLIB_ROOT
if (!ROOT || !existsSync(join(ROOT, 'node_modules/@stdlib'))) {
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
}
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
    if (DEFPROP.has(spec)) { defprops.push(name); return '' }
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
  const resolve = (spec, from) => alias[spec] ? 'alias:' + spec : createRequire(from).resolve(spec)
  const visit = (key) => {
    if (key in modules) return
    if (key.startsWith('alias:')) { modules[key] = alias[key.slice(6)]; return }
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
const EXTRA = [[], [2.5], [2.5, 1.5], [3, 2], [0.5, 0.25], [3], [0.5]]
const SPECIALS = [0, -0, 1, -1, NaN, Infinity, -Infinity, 1e-300, 1e300, 0.5, 2, 1e-10, 12345.678]

// a domain where Node returns finite numbers, so the timing exercises the main path
function domain(fn, arity) {
  for (const [lo, hi] of RANGES) for (const c of EXTRA) {
    if (c.length !== arity - 1) continue
    let finite = 0, numeric = true
    for (let i = 0; i < 40 && numeric; i++) {
      let v; try { v = fn(lo + (hi - lo) * i / 40, ...c) } catch { numeric = false }
      if (typeof v !== 'number') numeric = false; else if (Number.isFinite(v)) finite++
    }
    if (numeric && finite >= 36) return { lo, hi, c }
  }
}

function one(spec) {
  const out = { spec, diag: DIAGS.join(',') }
  let fn
  try { fn = nodeRequire(spec) } catch (e) { return { ...out, status: 'node-load-fail', err: String(e.message).split('\n')[0] } }
  if (typeof fn !== 'function') return { ...out, status: 'not-function' }
  const arity = out.arity = fn.length
  if (arity < 1 || arity > 3) return { ...out, status: 'arity-skip' }
  const dom = out.domain = domain(fn, arity)
  if (!dom) return { ...out, status: 'no-numeric-domain' }
  const { lo, hi, c } = dom
  const ps = ['x', 'a', 'b'].slice(0, arity).join(', '), rest = ['', ', a', ', a, b'][arity - 1]
  let b
  try {
    b = build(`import fn from '${spec}'
export let f = (${ps}) => fn(${ps})
export let loop = (n, lo, hi${rest}) => { let s = 0, d = (hi - lo) / n; for (let i = 0; i < n; i++) s += fn(lo + i * d${rest}); return s }`)
  } catch (e) { return { ...out, status: 'compile-fail', err: String(e.message).split('\n')[0].slice(0, 200) } }
  Object.assign(out, { bytes: b.wasm.byteLength, compileMs: Math.round(b.ms), mods: b.mods })
  const mod = new WebAssembly.Module(b.wasm)
  let inst
  try { inst = instantiate(b.wasm) } catch (e) { return { ...out, status: 'instantiate-fail', err: String(e.message).split('\n')[0].slice(0, 200) } }

  // agreement with Node, bit for bit
  const pts = [...SPECIALS]
  for (let i = 0; i < 200; i++) pts.push(lo + (hi - lo) * (i + 0.37) / 200)
  out.points = pts.length; out.mismatch = 0; out.thrown = 0
  for (const x of pts) {
    let want, got
    try { want = fn(x, ...c) } catch { continue }
    try { got = inst.exports.f(x, ...c) } catch (e) { out.thrown++; out.firstBad ??= { x, err: String(e.message).slice(0, 80) }; continue }
    if (!Object.is(got, want)) { out.mismatch++; out.firstBad ??= { x, got: String(got), want: String(want) } }
  }

  // the raw export takes plain numbers only when its ABI is f64
  let raw = null
  try { const e = new WebAssembly.Instance(mod, {}).exports; if (typeof e.f(lo, ...c) === 'number') raw = e.f } catch {}
  out.abi = raw ? 'f64' : 'boxed'
  const drive = (f) => (n) => { let s = 0, d = (hi - lo) / n; for (let i = 0; i < n; i++) s += f(lo + i * d, ...c); return s }
  const N = 200000, contenders = [drive(fn), (n) => inst.exports.loop(n, lo, hi, ...c), drive(inst.exports.f)]
  if (raw) contenders.push(drive(raw))
  try {
    const [js, loop, call, rawT] = race(contenders.map(f => () => f(N)), 9, 2)
    const ns = (t) => +(t / N * 1e6).toFixed(2), x = (t) => +(t / js).toFixed(3)
    Object.assign(out, { jsNs: ns(js), loopNs: ns(loop), callNs: ns(call), loopRatio: x(loop), callRatio: x(call) })
    if (raw) Object.assign(out, { rawNs: ns(rawT), rawRatio: x(rawT) })
    out.status = 'ok'
  } catch (e) { out.status = 'run-fail'; out.err = String(e.message).split('\n')[0].slice(0, 200) }
  return out
}

// ── sweep ───────────────────────────────────────────────────────────────────

function sweep(ns, outFile, conc = 4) {
  const dir = join(ROOT, 'node_modules/@stdlib', ns)
  const pkgs = readdirSync(dir).filter(d => existsSync(join(dir, d, 'package.json')) && d !== 'wasm').map(d => `@stdlib/${ns}/${d}`)
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

function report(file, list) {
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const gm = (a) => a.length ? Math.exp(a.reduce((s, x) => s + Math.log(x), 0) / a.length) : NaN
  const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1]
  const tally = {}; for (const r of rows) tally[r.status] = (tally[r.status] || 0) + 1
  const ok = rows.filter(r => r.status === 'ok'), exact = ok.filter(r => !r.mismatch && !r.thrown)
  const clean = exact.filter(r => r.abi === 'f64' && r.bytes < 2048)
  const lr = ok.map(r => r.loopRatio), rr = ok.filter(r => r.rawRatio != null).map(r => r.rawRatio)
  console.log('packages', rows.length, tally)
  console.log(`ran ${ok.length}: agree with Node on every point ${exact.length}, disagree ${ok.length - exact.length}`)
  console.log(`export ABI: f64 ${ok.filter(r => r.abi === 'f64').length}, boxed ${ok.filter(r => r.abi === 'boxed').length}`)
  console.log(`loop in wasm, jz/js: geomean ${gm(lr).toFixed(2)}× median ${med(lr).toFixed(2)}× | faster ${lr.filter(x => x < 0.95).length}, par ${lr.filter(x => x >= 0.95 && x <= 1.05).length}, slower ${lr.filter(x => x > 1.05).length}`)
  console.log(`call per element, raw f64 export (n=${rr.length}): geomean ${gm(rr).toFixed(2)}×`)
  console.log(`call per element, interop wrapper: geomean ${gm(ok.map(r => r.callRatio)).toFixed(2)}×`)
  console.log(`clean subset (agrees, f64 ABI, under 2 KB; n=${clean.length}): loop ${gm(clean.map(r => r.loopRatio)).toFixed(2)}×, raw call ${gm(clean.map(r => r.rawRatio)).toFixed(2)}×`)
  console.log(`size: median ${med(ok.map(r => r.bytes))} B | compile: median ${med(ok.map(r => r.compileMs))} ms`)
  const errs = {}
  for (const r of rows) if (r.err) (errs[r.status + ': ' + r.err.replace(/'[^']*'/g, "'…'").slice(0, 100)] ||= []).push(r.spec.split('/').pop())
  for (const [k, v] of Object.entries(errs).sort((a, b) => b[1].length - a[1].length)) console.log(String(v.length).padStart(4), k, ' e.g.', v.slice(0, 3).join(', '))
  if (!list) return
  for (const r of [...ok].sort((a, b) => a.loopRatio - b.loopRatio))
    console.log(r.spec.split('/').pop().padEnd(30), `loop ${r.loopRatio}×`.padEnd(14), `${r.bytes} B`.padEnd(9), r.abi.padEnd(6), r.mismatch ? `DISAGREES ×${r.mismatch} ${JSON.stringify(r.firstBad)}` : '')
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
  const fn = nodeRequire(spec), arity = Math.min(Math.max(fn.length, 1), 3)
  const ps = ['x', 'a', 'b'].slice(0, arity).join(', ')
  const g = graph(`import fn from '${spec}'\nexport let f = (${ps}) => fn(${ps})`)
  writeFileSync(file, JSON.stringify(g))
  console.log(`${Object.keys(g.modules).length} modules → ${file}`)
}

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'one') { const r = one(args[0]); console.log(args.includes('--json') ? '@@' + JSON.stringify(r) : r); process.exit(0) }
else if (cmd === 'dump') dump(args[0], args[1])
else if (cmd === 'sweep') sweep(args[0], args[1], +(args[2] || 4))
else if (cmd === 'report') report(args[0], args[1] === 'list')
else if (cmd === 'blas') blas(args)
else console.log('usage: stdlib-probe.mjs one <spec> | sweep <namespace> <out.jsonl> [concurrency] | report <out.jsonl> [list] | blas [names…]')
