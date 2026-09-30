#!/usr/bin/env node
// bench-size — wasm size comparison: jz (size-tuned) vs AssemblyScript (-Oz) vs
// Porffor, plus a `wasm-opt -Oz` self-check that measures how much headroom is
// left in jz's own codegen. This is the *size* track; bench.mjs is the *speed*
// track. Both feed the regression gate in test/bench.js.
//
//   node scripts/bench-size.mjs               # all cases, table
//   node scripts/bench-size.mjs mat4 biquad   # subset
//   node scripts/bench-size.mjs --json        # machine-readable lines for the gate
//
// Each case is compiled the same way on every side: the whole program as a
// standalone wasm module (host services as small env imports, allocator off).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileJzAt, compileJzSelf } from '../bench/_lib/compile.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BENCH = join(ROOT, 'bench')
const TMP = mkdtempSync(join(tmpdir(), 'jz-size-'))
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }) } catch {} })

const has = cmd => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0
const HAS_ASC = has('asc')
const HAS_WASMOPT = has('wasm-opt')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const requested = args.filter(a => !a.startsWith('-'))

const jzCompileSize = id => {
  if (id !== 'jz') return compileJzAt({ id, js: join(BENCH, id, `${id}.js`) }, { level: 'size' })
  const out = join(TMP, 'jz.wasm')
  compileJzSelf(null, out)
  return readFileSync(out)
}

// AS: smallest the toolchain can do — -Oz, iterate binaryen to fixpoint.
const asCompileSize = id => {
  const src = join(BENCH, id, `${id}.as.ts`)
  if (!existsSync(src) || !HAS_ASC) return null
  const out = join(TMP, `${id}.as.wasm`)
  try {
    execFileSync('asc', [src, '-Oz', '--converge', '--runtime', 'stub', '--noAssert', '-o', out], { stdio: 'pipe' })
    return statSync(out).size
  } catch (e) {
    console.error(`${id}: AssemblyScript compilation failed: ${e.message}`)
    process.exitCode = 1
    return null
  }
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

const printRow = r => console.log(`SIZE ${r.id} jz=${r.jz ?? ''} jz_wasmopt=${r.jzOpt ?? ''} as=${r.as ?? ''}`)
const rows = []
for (const id of cases) {
  let jz = null, jzOpt = null
  try { const w = jzCompileSize(id); jz = w.byteLength ?? Buffer.byteLength(w); jzOpt = wasmOptSize(w) } catch (e) { console.error(`${id}: jz compilation failed: ${e.message}`); process.exitCode = 1 }
  const as = asCompileSize(id)
  const row = { id, jz, jzOpt, as }
  rows.push(row)
  if (asJson) printRow(row)
}

if (!asJson) {
  console.log(`wasm size (smaller is better) — jz uses optimize:'size'`)
  if (!HAS_ASC) console.log('  note: asc not found — AssemblyScript column blank')
  if (!HAS_WASMOPT) console.log('  note: wasm-opt not found — headroom column blank')
  console.log()
  console.log(`  ${'case'.padEnd(14)}  ${'jz'.padStart(10)}  ${'jz+wasmopt'.padStart(11)}  ${'slack'.padStart(7)}  ${'AS -Oz'.padStart(10)}  ${'vs AS'.padStart(7)}`)
  console.log(`  ${'-'.repeat(14)}  ${'-'.repeat(10)}  ${'-'.repeat(11)}  ${'-'.repeat(7)}  ${'-'.repeat(10)}  ${'-'.repeat(7)}`)
  for (const r of rows) {
    const vsAs = r.jz && r.as ? `${(r.jz / r.as).toFixed(2)}×` : '—'
    console.log(`  ${r.id.padEnd(14)}  ${fmtB(r.jz).padStart(10)}  ${fmtB(r.jzOpt).padStart(11)}  ${pct(r.jzOpt, r.jz).padStart(7)}  ${fmtB(r.as).padStart(10)}  ${vsAs.padStart(7)}`)
  }
  const geo = (sel) => {
    const xs = rows.map(sel).filter(x => x != null && isFinite(x) && x > 0)
    return xs.length ? Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length) : null
  }
  const gAs = geo(r => r.jz && r.as ? r.jz / r.as : null)
  const gSlack = geo(r => r.jz && r.jzOpt ? r.jzOpt / r.jz : null)
  console.log()
  console.log(`  geomean: jz/AS = ${gAs ? gAs.toFixed(3) + '×' : '—'}   jz/(jz+wasmopt) = ${gSlack ? gSlack.toFixed(3) + '×' : '—'}`)
}
