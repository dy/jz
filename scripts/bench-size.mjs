#!/usr/bin/env node
// bench-size — wasm size comparison: jz (size-tuned) vs AssemblyScript (-Oz) vs
// Porffor, plus a `wasm-opt -Oz` self-check that measures how much headroom is
// left in jz's own codegen. This is the *size* track; bench.mjs is the *speed*
// track. Both feed the regression gate in test/bench-pin.js.
//
//   node scripts/bench-size.mjs               # all cases, table
//   node scripts/bench-size.mjs mat4 biquad   # subset
//   node scripts/bench-size.mjs --json        # machine-readable lines for the gate
//
// Each case is compiled the same way on every side: the whole program as a
// standalone wasm module (host services as small env imports, allocator off).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BENCH = join(ROOT, 'bench')
const LIB = join(BENCH, '_lib')
const TMP = mkdtempSync(join(tmpdir(), 'jz-size-'))
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }) } catch {} })

const has = cmd => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0
const HAS_ASC = has('asc')
const HAS_PORF = has('porf')
const HAS_WASMOPT = has('wasm-opt')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const requested = args.filter(a => !a.startsWith('-'))

const benchlibHostSource = () => {
  const src = readFileSync(join(LIB, 'benchlib.js'), 'utf8')
  const out = src.replace(`export let printResult = (medianUs, checksum, samples, stages, runs) => {
  console.log(\`median_us=\${medianUs} checksum=\${checksum} samples=\${samples} stages=\${stages} runs=\${runs}\`)
}`, `export let printResult = (medianUs, checksum, samples, stages, runs) => {
  env.logResult(medianUs, checksum, samples, stages, runs)
}`)
  if (out === src) throw Error('failed to patch benchlib printResult')
  return out
}

const watrModuleSources = () => ({
  './watr-compile.js': `import compileWatr from '../../node_modules/watr/src/compile.js'\nexport const compile = (src) => compileWatr(src)\n`,
  '../../node_modules/watr/src/compile.js': readFileSync(join(ROOT, 'node_modules/watr/src/compile.js'), 'utf8'),
  './encode.js': readFileSync(join(ROOT, 'node_modules/watr/src/encode.js'), 'utf8'),
  './const.js': readFileSync(join(ROOT, 'node_modules/watr/src/const.js'), 'utf8'),
  './parse.js': readFileSync(join(ROOT, 'node_modules/watr/src/parse.js'), 'utf8'),
  './util.js': readFileSync(join(ROOT, 'node_modules/watr/src/util.js'), 'utf8'),
})

// jz: compile the bench source as a standalone, size-tuned wasm module.
const jzCompileSize = id => {
  const isWatr = id === 'watr'
  const code = readFileSync(join(BENCH, id, `${id}.js`), 'utf8')
  return compile(code, {
    jzify: isWatr,
    modules: { '../_lib/benchlib.js': benchlibHostSource(), ...(isWatr ? watrModuleSources() : {}) },
    imports: {
      env: { logResult: { params: 5 } },
      performance: { now: { params: 0, returns: 'number' } },
    },
    optimize: 'size',
    alloc: false,
  })
}

// AS: smallest the toolchain can do — -Oz, iterate binaryen to fixpoint.
const asCompileSize = id => {
  const src = join(BENCH, id, `${id}.as.ts`)
  if (!existsSync(src) || !HAS_ASC) return null
  const out = join(TMP, `${id}.as.wasm`)
  try {
    execFileSync('asc', [src, '-Oz', '--converge', '--runtime', 'stub', '--noAssert', '-o', out], { stdio: 'pipe' })
    return statSync(out).size
  } catch { return null }
}

// porf: bundles a JS runtime, so this is the "ship plain JS as wasm" baseline.
const flattenForPorf = id => {
  let src = readFileSync(join(BENCH, id, `${id}.js`), 'utf8')
  let out = `const performance = globalThis.performance || { now: () => Date.now() }\n`
  if (src.includes('../_lib/benchlib.js')) {
    out += readFileSync(join(LIB, 'benchlib.js'), 'utf8').replace(/\bexport let\b/g, 'const') + '\n'
    src = src.replace(/import\s+\{[^}]+\}\s+from\s+['"]\.\.\/_lib\/benchlib\.js['"]\s*\n?/g, '')
  }
  out += src.replace(/\bexport let main\b/, 'const main') + '\nmain()\n'
  return out
}
const porfCompileSize = id => {
  if (!HAS_PORF || id === 'watr') return null  // watr pulls deep ES modules porf won't bundle here
  const flat = join(TMP, `${id}.flat.js`)
  const out = join(TMP, `${id}.porf.wasm`)
  try {
    writeFileSync(flat, flattenForPorf(id))
    execFileSync('porf', ['wasm', '-O2', flat, out], { stdio: 'pipe' })
    return statSync(out).size
  } catch { return null }
}

// wasm-opt -Oz on jz's own output: how much byte-level slack jz left behind.
const wasmOptSize = bytes => {
  if (!HAS_WASMOPT) return null
  const inp = join(TMP, 'in.wasm'), out = join(TMP, 'out.wasm')
  try {
    writeFileSync(inp, bytes)
    execFileSync('wasm-opt', ['-Oz', '--all-features', inp, '-o', out], { stdio: 'pipe' })
    return statSync(out).size
  } catch { return null }
}

const discoverCases = () => readdirSync(BENCH, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(BENCH, d.name, `${d.name}.js`)))
  .map(d => d.name)
  .sort()

const allCases = discoverCases()
const cases = requested.length ? requested : allCases
for (const id of cases) if (!allCases.includes(id)) { console.error(`unknown case: ${id}`); process.exit(2) }

const fmtB = b => b == null ? '—' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} kB` : `${(b / 1048576).toFixed(2)} MB`
const pct = (a, b) => a == null || b == null ? '—' : `${((1 - a / b) * 100).toFixed(1)}%`

const rows = []
for (const id of cases) {
  let jz = null, jzOpt = null
  try { const w = jzCompileSize(id); jz = w.byteLength ?? Buffer.byteLength(w); jzOpt = wasmOptSize(w) } catch (e) { jz = null }
  const as = asCompileSize(id)
  const porf = porfCompileSize(id)
  rows.push({ id, jz, jzOpt, as, porf })
}

if (asJson) {
  for (const r of rows) console.log(`SIZE ${r.id} jz=${r.jz ?? ''} jz_wasmopt=${r.jzOpt ?? ''} as=${r.as ?? ''} porf=${r.porf ?? ''}`)
} else {
  console.log(`wasm size (smaller is better) — jz uses optimize:'size'`)
  if (!HAS_ASC) console.log('  note: asc not found — AssemblyScript column blank')
  if (!HAS_PORF) console.log('  note: porf not found — Porffor column blank')
  if (!HAS_WASMOPT) console.log('  note: wasm-opt not found — headroom column blank')
  console.log()
  console.log(`  ${'case'.padEnd(14)}  ${'jz'.padStart(10)}  ${'jz+wasmopt'.padStart(11)}  ${'slack'.padStart(7)}  ${'AS -Oz'.padStart(10)}  ${'vs AS'.padStart(7)}  ${'porf'.padStart(10)}  ${'vs porf'.padStart(8)}`)
  console.log(`  ${'-'.repeat(14)}  ${'-'.repeat(10)}  ${'-'.repeat(11)}  ${'-'.repeat(7)}  ${'-'.repeat(10)}  ${'-'.repeat(7)}  ${'-'.repeat(10)}  ${'-'.repeat(8)}`)
  for (const r of rows) {
    const vsAs = r.jz && r.as ? `${(r.jz / r.as).toFixed(2)}×` : '—'
    const vsPorf = r.jz && r.porf ? `${(r.jz / r.porf).toFixed(2)}×` : '—'
    console.log(`  ${r.id.padEnd(14)}  ${fmtB(r.jz).padStart(10)}  ${fmtB(r.jzOpt).padStart(11)}  ${pct(r.jzOpt, r.jz).padStart(7)}  ${fmtB(r.as).padStart(10)}  ${vsAs.padStart(7)}  ${fmtB(r.porf).padStart(10)}  ${vsPorf.padStart(8)}`)
  }
  const geo = (sel) => {
    const xs = rows.map(sel).filter(x => x != null && isFinite(x) && x > 0)
    return xs.length ? Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length) : null
  }
  const gAs = geo(r => r.jz && r.as ? r.jz / r.as : null)
  const gPorf = geo(r => r.jz && r.porf ? r.jz / r.porf : null)
  const gSlack = geo(r => r.jz && r.jzOpt ? r.jzOpt / r.jz : null)
  console.log()
  console.log(`  geomean: jz/AS = ${gAs ? gAs.toFixed(3) + '×' : '—'}   jz/porf = ${gPorf ? gPorf.toFixed(3) + '×' : '—'}   jz/(jz+wasmopt) = ${gSlack ? gSlack.toFixed(3) + '×' : '—'}`)
}
