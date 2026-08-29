#!/usr/bin/env node
/**
 * refactor-oracle.mjs — byte-identity oracle for the "pipeline minimality"
 * campaign (retiring hand-rolled walkers, consolidating analyzeBody
 * traversals, splitting outlier files/functions). It proves a refactor
 * changed NO compiled output: same source in, byte-identical wasm out.
 *
 * # What it compiles (the corpus)
 *   - bench/<id>/<id>.js          — every bench case (see bench/bench.mjs
 *     discoverCases); non-graph cases get the same '../_lib/benchlib.js' →
 *     env.logResult host patch bench.mjs's compileJzAt uses (so console.log
 *     in the shared bench helper compiles under the default js host); the
 *     'watr' case gets the same watr-src virtual module map; 'jessie' and
 *     'jz' resolve their whole import graph (src/resolve.js), exactly like
 *     compileJzAt does. The 'jz' case (bench/jz/jz.js → scripts/self.js →
 *     the WHOLE compiler) is EXCLUDED BY DEFAULT: a single compile of that
 *     graph measured 68s at O0 and 246s at O3 — four levels of just that
 *     one specimen would burn 10+ minutes, wrecking the "few minutes for
 *     the full corpus" budget for everything else. Pass --full to include it.
 *   - examples/<name>/<name>.js   — every gallery example (examples/examples.js),
 *     plus each entry's extra `kernels` (e.g. raymarcher.simd), plus the two
 *     standalone demos (rfft, zzfx) — mirrors examples/build.mjs's buildAll,
 *     minus jukebox (a bespoke multi-file build, out of scope here).
 *   - test/kernel-parity.js's CORPUS — imported directly (not replicated).
 *   - watr's own entry (/Users/div/projects/watr/watr.js, override via
 *     JZ_ORACLE_WATR) — resolved as a module graph and compiled with
 *     `memory: 4096`, matching watr's own `npm run build:wasm`
 *     (`npx jz watr.js -O3 --memory 4096`, see .github/workflows/watr.yml
 *     and watr's package.json). Skipped with a warning if the path is absent.
 *
 * Every specimen is compiled at optimize levels 0, 2, 3, and 'size' (all
 * measured cheap — the size profile shares jz's normal passes, just tuned
 * caps). A specimen that fails to compile at a level is a RECORDED OUTCOME
 * (the error class + message, hashed) — not a crash of the oracle. The
 * corpus-building itself (missing files, bad module graphs) still throws;
 * only the per-(spec,level) `compile()` call is guarded.
 *
 * Every command additionally takes `--only <substring>`, filtering specs to
 * those whose name (e.g. "bench:mandelbrot", "example:julia",
 * "kernel-parity:sum", "watr:watr.js") contains it — a fast, targeted rerun
 * instead of the full corpus (useful while iterating, or to isolate one
 * suspicious specimen after a `check` reports it).
 *
 * # Commands
 *   snapshot <out.json> [--full]
 *     Compiles the whole corpus and writes `{meta, entries}` to <out.json>,
 *     where entries["<spec>|<level>"] is `{ok:true, sha256, bytes}` or
 *     `{ok:false, errorClass, errorMessage, errorHash}`. Deterministic: key
 *     order is sorted, hashing is sha256 over the raw wasm bytes.
 *
 *   check [<baseline.json>] [--ref <gitref>] [--full]
 *     Recomputes a snapshot of the CURRENT tree and compares it against
 *     either a saved <baseline.json> or a freshly-built snapshot of
 *     <gitref> (via a temporary `git worktree add --detach`, node_modules
 *     symlinked from this checkout, removed when done). Prints every
 *     difference (spec, level, bytes before/after or error before/after)
 *     and exits 1 if any exist, 0 if clean. This is the one-liner a
 *     refactor branch runs: `node scripts/refactor-oracle.mjs check --ref main`.
 *
 *   diff <baseline.json> <spec> <level>
 *     Re-checks-out <baseline.json>'s recorded commit (meta.commit) into a
 *     temporary detached worktree, compiles just <spec> at <level> (e.g.
 *     `O2`, `O3`, `size`) to WAT text (`compile(src, {wat:true})`) on BOTH
 *     sides, writes both files under a scratch dir, and prints a unified
 *     diff head — so a `check` divergence is inspectable in one command.
 *
 * # Determinism
 * Two consecutive `snapshot` runs on an unchanged tree MUST be byte-identical
 * — any nondeterminism (Map/Set iteration over unordered construction, Date,
 * Math.random, host-dependent float folding) is a compiler bug, not
 * something this tool works around. test/refactor-oracle.js pins this on a
 * 3-specimen mini corpus. That test is NOT registered in test/index.js —
 * that file is held by another in-flight session; run it standalone
 * (`node test/refactor-oracle.js`) until it's wired in.
 *
 * # What this does NOT prove
 * Byte-identity of compiled output says nothing about the runtime behavior
 * of host-nondeterministic paths (Math.random without a fixed seed, host
 * timers, WASI clock/env imports) — those can be byte-identical AND still
 * observably differ at run time. This oracle is a static compile-output
 * proof only.
 *
 * # The rule
 * A pipeline-minimality slice merges only with `check --ref main` clean, OR
 * with every difference it reports listed and justified in the PR/commit
 * message (e.g. "narrowing X's dead branch — case Y's O3 output shrank by
 * Z bytes, semantics unchanged, see diff").
 *
 * # Usage examples
 *   node scripts/refactor-oracle.mjs snapshot .work/oracle-baseline.json
 *   node scripts/refactor-oracle.mjs check .work/oracle-baseline.json
 *   node scripts/refactor-oracle.mjs check --ref main
 *   node scripts/refactor-oracle.mjs check --ref main --full
 *   node scripts/refactor-oracle.mjs diff .work/oracle-baseline.json bench:mandelbrot O3
 */

import { createHash } from 'node:crypto'
import {
  readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync,
  realpathSync, symlinkSync, mkdirSync,
} from 'node:fs'
import { join, dirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LEVELS = [0, 2, 3, 'size']
const levelKey = (l) => typeof l === 'number' ? `O${l}` : String(l)
const parseLevel = (k) => /^O\d+$/.test(k) ? +k.slice(1) : k

// The one specimen that blows the "few minutes" speed budget on its own
// (compiling the WHOLE compiler through itself — see header). Opt in with --full.
const SELFHOST_CASES = new Set(['jz'])
const GRAPH_CASES = new Set(['jessie', 'jz'])

const hashBuffer = (buf) => createHash('sha256').update(buf).digest('hex')

// Replicated verbatim from test/kernel-parity.js's exported CORPUS (source of
// truth — diff against it if this ever needs to catch up). Deliberately NOT
// imported: `import '../test/kernel-parity.js'` runs that file's own
// top-level `test(...)` registrations as a side effect, and those pull in
// `kernel-target.js`, which lazily runs `npm run build` to produce
// dist/jz.wasm (a full self-host compile) the first time it's missing —
// exactly the expensive self-host cost this tool excludes by default (see
// SELFHOST_CASES above). A plain `import` for one constant should not risk
// minutes of unrelated build work, especially inside a --ref temp worktree
// that gets deleted right after (the build would be paid, then thrown away,
// on every single check --ref run).
const KERNEL_PARITY_CORPUS = {
  sum: `export let sum = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s }`,
  math: `export let f = (x) => Math.sqrt(x * x + 1) + Math.abs(x)`,
  dict: `export let count = (s) => { let d = {}; for (let i = 0; i < s.length; i++) { let c = s[i]; d[c] = (d[c] || 0) + 1 } return d['a'] || 0 }`,
  arr: `export let rev = (n) => { let a = []; for (let i = 0; i < n; i++) a.push(i * 2); let s = 0; for (let i = a.length - 1; i >= 0; i--) s += a[i]; return s }`,
  fold: `export let f = () => 0.1 + 0.2 - 0.3`,
  mfold: `export let g = () => Math.sqrt(9) + Math.abs(-2)`,
  eqzero: `
const dispatch = (op, x, out) => {
  if (op === 0) out[0] = x + 11
  else if (op === 1) out[0] = x - 7
  else if (op === 2) out[0] = Math.imul(x, 3)
  else if (op === 3) out[0] = x ^ 85
  else if (op === 4) out[0] = x | 256
  else out[0] = -1
  return out[0]
}
export let chain = (n, x) => {
  let out = new Int32Array(1), sum = 0
  for (let i = 0; i < n; i++) sum += dispatch(i % 6, x + i, out)
  return sum
}
export let masked = (x) => (x & 7) === 0 ? 101 : 202
export let reversed = (x) => 0 === Math.imul(x, 3) ? 303 : 404
export let main = () => masked(8) + reversed(0)
`,
  boolconst: `const g = (n) => { if (typeof n === 'number') return n; return false }
export let f = (s) => g(s) === false`,
  nestedtyped: `export let f = (x) => new Int32Array(new Float64Array([x]))[0]`,
  subviewtyped: `export let f = (buf) => new Int32Array(buf, 0, new Float64Array(4).length)`,
  dvnested: `export let f = (dv) => dv.setFloat64(dv.getInt32(0), dv.getFloat64(8))`,
  fromnested: `export let f = () => Int32Array.from([Float64Array.from([5])[0], 2])`,
}

// ─────────────────────────────────────────────────────────────────────────
// Corpus construction — parameterized by `root` so the SAME logic can build
// a corpus against another checkout entirely (a temp detached worktree for
// --ref), via dynamic import of that root's own compile()/resolveModuleGraph.
// No subprocess, no re-invoking this script at the other ref — just load
// its modules under a different file:// base. Each loaded root gets its own
// independent module graph (jz's ctx.js singleton is per-loaded-copy), so
// two roots coexist safely in one process.
// ─────────────────────────────────────────────────────────────────────────

async function loadRoot(root) {
  const imp = (rel) => import(pathToFileURL(join(root, rel)).href)
  const { compile } = await imp('index.js')
  const { resolveModuleGraph } = await imp('src/resolve.js')
  return { root, compile, resolveModuleGraph }
}

function benchlibHostSource(root) {
  const src = readFileSync(join(root, 'bench/_lib/benchlib.js'), 'utf8')
  const marker = 'export let printResult = (medianUs, checksum, samples, stages, runs) => {\n  console.log(`median_us=${medianUs} checksum=${checksum} samples=${samples} stages=${stages} runs=${runs}`)\n}'
  const patched = 'export let printResult = (medianUs, checksum, samples, stages, runs) => {\n  env.logResult(medianUs, checksum, samples, stages, runs)\n}'
  const out = src.replace(marker, patched)
  if (out === src) throw new Error('benchlib patch failed to match — bench/_lib/benchlib.js changed shape (see bench.mjs benchlibHostSource)')
  return out
}

function watrBenchModuleSources(root) {
  const src = (p) => readFileSync(join(root, 'node_modules/watr/src', p), 'utf8')
  return {
    './watr-compile.js': `import compileWatr from '../../node_modules/watr/src/compile.js'\nexport const compile = (src) => compileWatr(src)\n`,
    '../../node_modules/watr/src/compile.js': src('compile.js'),
    './encode.js': src('encode.js'),
    './const.js': src('const.js'),
    './parse.js': src('parse.js'),
    './util.js': src('util.js'),
  }
}

function discoverBenchCaseIds(root) {
  const dir = join(root, 'bench')
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(dir, d.name, `${d.name}.js`)))
    .map(d => d.name)
    .sort()
}

function makeBenchSpec(root, resolveModuleGraph, id) {
  const dir = join(root, 'bench', id)
  const js = join(dir, `${id}.js`)
  const isWatr = id === 'watr'
  const isGraph = GRAPH_CASES.has(id)
  // Resolve the graph / read the source ONCE per spec (level-independent);
  // only opts.optimize varies per compile call.
  let code, modules
  if (isGraph) {
    const g = resolveModuleGraph(js, { resolveNode: id === 'jz' })
    code = g.code
    modules = { ...g.modules, [pathResolve(root, 'bench/_lib/benchlib.js')]: benchlibHostSource(root) }
  } else {
    code = readFileSync(js, 'utf8')
    modules = { '../_lib/benchlib.js': benchlibHostSource(root), ...(isWatr ? watrBenchModuleSources(root) : {}) }
  }
  return {
    name: `bench:${id}`,
    code,
    opts: {
      jzify: isWatr || isGraph,
      modules,
      imports: { env: { logResult: { params: 5 } }, performance: { now: { params: 0, returns: 'number' } } },
      alloc: false,
    },
  }
}

function makeExampleSpec(root, dirName, fileBase) {
  const code = readFileSync(join(root, 'examples', dirName, `${fileBase}.js`), 'utf8')
  return { name: `example:${fileBase}`, code, opts: {} }
}

async function buildCorpus(root, { full = false } = {}) {
  const specs = []

  for (const id of discoverBenchCaseIds(root)) {
    if (SELFHOST_CASES.has(id) && !full) continue
    specs.push(id)
  }
  // resolveModuleGraph is needed to build bench specs — load it here so
  // buildCorpus stays a single entry point per root.
  const { resolveModuleGraph } = await loadRoot(root)
  const benchSpecs = specs.map(id => makeBenchSpec(root, resolveModuleGraph, id))

  const exampleSpecs = []
  const { examples } = await import(pathToFileURL(join(root, 'examples/examples.js')).href)
  for (const e of examples) {
    exampleSpecs.push(makeExampleSpec(root, e.name, e.name))
    for (const k of e.kernels || []) exampleSpecs.push(makeExampleSpec(root, e.name, k))
  }
  exampleSpecs.push(makeExampleSpec(root, 'rfft', 'rfft'))
  exampleSpecs.push(makeExampleSpec(root, 'zzfx', 'zzfx'))

  const kernelParitySpecs = []
  for (const [name, src] of Object.entries(KERNEL_PARITY_CORPUS)) kernelParitySpecs.push({ name: `kernel-parity:${name}`, code: src, opts: {} })

  const watrSpecs = []
  const watrJs = process.env.JZ_ORACLE_WATR || '/Users/div/projects/watr/watr.js'
  if (existsSync(watrJs)) {
    const g = resolveModuleGraph(watrJs, { resolveNode: false })
    watrSpecs.push({ name: 'watr:watr.js', code: g.code, opts: { modules: g.modules, memory: 4096 } })
  } else {
    console.error(`[refactor-oracle] warn: watr.js not found at ${watrJs} (set JZ_ORACLE_WATR) — skipping the watr specimen`)
  }

  return [...benchSpecs, ...exampleSpecs, ...kernelParitySpecs, ...watrSpecs]
}

// ─────────────────────────────────────────────────────────────────────────
// Running specs → outcomes
// ─────────────────────────────────────────────────────────────────────────

function runSpec(compile, spec, level, { wat = false } = {}) {
  try {
    const out = compile(spec.code, { ...spec.opts, optimize: level, ...(wat ? { wat: true } : {}) })
    if (wat) return { ok: true, wat: String(out) }
    const bytes = out
    return { ok: true, sha256: hashBuffer(bytes), bytes: bytes.length }
  } catch (e) {
    const errorClass = e?.name || 'Error'
    const errorMessage = String(e?.message || e)
    if (wat) return { ok: false, errorClass, errorMessage }
    return { ok: false, errorClass, errorMessage, errorHash: hashBuffer(`${errorClass}:${errorMessage}`).slice(0, 16) }
  }
}

async function snapshotRoot(root, { full = false, log = false, only = null } = {}) {
  const { compile } = await loadRoot(root)
  let specs = await buildCorpus(root, { full })
  if (only) specs = specs.filter(s => s.name.includes(only))
  const entries = {}
  let i = 0
  for (const spec of specs) {
    for (const level of LEVELS) {
      entries[`${spec.name}|${levelKey(level)}`] = runSpec(compile, spec, level)
    }
    i++
    if (log && (i % 20 === 0 || i === specs.length)) console.error(`[refactor-oracle] ${i}/${specs.length} specs compiled (${root})`)
  }
  const sorted = Object.fromEntries(Object.keys(entries).sort().map(k => [k, entries[k]]))
  const commit = (() => {
    try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
    catch { return null }
  })()
  return {
    meta: {
      commit, full: !!full, node: process.version, date: new Date().toISOString(),
      specCount: specs.length, levelCount: LEVELS.length,
    },
    entries: sorted,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Temporary detached worktrees (for --ref and for `diff`)
// ─────────────────────────────────────────────────────────────────────────

function makeDetachedWorktree(gitref) {
  const base = mkdtempSync(join(tmpdir(), 'jz-oracle-'))
  const dir = join(base, 'wt')
  execFileSync('git', ['-C', ROOT, 'worktree', 'add', '--detach', dir, gitref], { stdio: 'pipe' })
  const realNodeModules = realpathSync(join(ROOT, 'node_modules'))
  symlinkSync(realNodeModules, join(dir, 'node_modules'))
  return dir
}

function removeDetachedWorktree(dir) {
  try { execFileSync('git', ['-C', ROOT, 'worktree', 'remove', dir, '--force'], { stdio: 'pipe' }) }
  catch { rmSync(dir, { recursive: true, force: true }) }
}

// ─────────────────────────────────────────────────────────────────────────
// Comparison
// ─────────────────────────────────────────────────────────────────────────

function describeEntry(e) {
  if (!e) return '(missing)'
  if (e.ok) return `ok bytes=${e.bytes} sha256=${e.sha256.slice(0, 12)}`
  return `ERROR ${e.errorClass}: ${e.errorMessage.slice(0, 80)}`
}

function compareSnapshots(before, after) {
  const keys = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])
  const diffs = []
  for (const k of [...keys].sort()) {
    const b = before.entries[k], a = after.entries[k]
    const same = b && a && b.ok && a.ok ? b.sha256 === a.sha256
      : b && a && !b.ok && !a.ok ? b.errorHash === a.errorHash
      : b && a && b.ok === a.ok
    if (!same) diffs.push({ key: k, before: b, after: a })
  }
  return diffs
}

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────

function parseFlags(args) {
  const rest = [], flags = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--full') flags.full = true
    else if (a === '--ref') flags.ref = args[++i]
    else if (a === '--only') flags.only = args[++i]
    else rest.push(a)
  }
  return { rest, flags }
}

async function cmdSnapshot(args) {
  const { rest, flags } = parseFlags(args)
  const out = rest[0]
  if (!out) { console.error('usage: refactor-oracle.mjs snapshot <out.json> [--full] [--only <substring>]'); process.exit(1) }
  const snap = await snapshotRoot(ROOT, { full: flags.full, log: true, only: flags.only })
  writeFileSync(out, JSON.stringify(snap, null, 2) + '\n')
  console.error(`[refactor-oracle] wrote ${out} — ${Object.keys(snap.entries).length} entries (${snap.meta.specCount} specs × ${snap.meta.levelCount} levels), commit ${snap.meta.commit}`)
}

async function cmdCheck(args) {
  const { rest, flags } = parseFlags(args)
  let before
  let tmpWt = null
  if (flags.ref) {
    tmpWt = makeDetachedWorktree(flags.ref)
    try { before = await snapshotRoot(tmpWt, { full: flags.full, log: true, only: flags.only }) }
    finally { removeDetachedWorktree(tmpWt) }
  } else if (rest[0]) {
    before = JSON.parse(readFileSync(rest[0], 'utf8'))
  } else {
    console.error('usage: refactor-oracle.mjs check <baseline.json> [--full] [--only <substring>]  OR  check --ref <gitref> [--full] [--only <substring>]')
    process.exit(1)
  }
  const after = await snapshotRoot(ROOT, { full: flags.full, log: true, only: flags.only })
  const diffs = compareSnapshots(before, after)
  if (!diffs.length) {
    console.log(`[refactor-oracle] CLEAN — ${Object.keys(after.entries).length} entries identical (baseline commit ${before.meta.commit}, current ${after.meta.commit})`)
    process.exit(0)
  }
  console.log(`[refactor-oracle] ${diffs.length} difference(s) (baseline commit ${before.meta.commit}, current ${after.meta.commit}):`)
  for (const d of diffs) console.log(`  ${d.key}\n    before: ${describeEntry(d.before)}\n    after:  ${describeEntry(d.after)}`)
  process.exit(1)
}

async function cmdDiff(args) {
  const [baselinePath, specName, levelStr] = args
  if (!baselinePath || !specName || !levelStr) {
    console.error('usage: refactor-oracle.mjs diff <baseline.json> <spec> <level>   (level: O0, O2, O3, size)')
    process.exit(1)
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  if (!baseline.meta?.commit) { console.error('baseline.json has no meta.commit — cannot reconstruct the "before" side'); process.exit(1) }
  const level = parseLevel(levelStr)

  const findSpec = async (root) => {
    const specs = await buildCorpus(root, { full: true })
    const spec = specs.find(s => s.name === specName)
    if (!spec) throw new Error(`spec '${specName}' not found at ${root}. Known: ${specs.map(s => s.name).join(', ')}`)
    return spec
  }

  const wt = makeDetachedWorktree(baseline.meta.commit)
  let beforeWat, afterWat
  try {
    const { compile: beforeCompile } = await loadRoot(wt)
    const beforeSpec = await findSpec(wt)
    beforeWat = runSpec(beforeCompile, beforeSpec, level, { wat: true })
  } finally {
    removeDetachedWorktree(wt)
  }
  const { compile: afterCompile } = await loadRoot(ROOT)
  const afterSpec = await findSpec(ROOT)
  afterWat = runSpec(afterCompile, afterSpec, level, { wat: true })

  const scratch = mkdtempSync(join(tmpdir(), 'jz-oracle-diff-'))
  const beforeFile = join(scratch, 'before.wat')
  const afterFile = join(scratch, 'after.wat')
  writeFileSync(beforeFile, beforeWat.ok ? beforeWat.wat : `COMPILE ERROR: ${beforeWat.errorClass}: ${beforeWat.errorMessage}\n`)
  writeFileSync(afterFile, afterWat.ok ? afterWat.wat : `COMPILE ERROR: ${afterWat.errorClass}: ${afterWat.errorMessage}\n`)
  console.log(`[refactor-oracle] wrote ${beforeFile} and ${afterFile}`)
  const r = spawnSync('diff', ['-u', beforeFile, afterFile], { encoding: 'utf8' })
  const lines = (r.stdout || '(no textual diff — identical WAT)').split('\n')
  console.log(lines.slice(0, 80).join('\n'))
  if (lines.length > 80) console.log(`… (${lines.length - 80} more lines — see ${scratch})`)
}

async function main() {
  const [, , cmd, ...args] = process.argv
  if (cmd === 'snapshot') await cmdSnapshot(args)
  else if (cmd === 'check') await cmdCheck(args)
  else if (cmd === 'diff') await cmdDiff(args)
  else {
    console.error(`usage:
  node scripts/refactor-oracle.mjs snapshot <out.json> [--full]
  node scripts/refactor-oracle.mjs check <baseline.json> [--full]
  node scripts/refactor-oracle.mjs check --ref <gitref> [--full]
  node scripts/refactor-oracle.mjs diff <baseline.json> <spec> <level>`)
    process.exit(1)
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) main().catch(e => { console.error(e); process.exit(1) })

export { LEVELS, levelKey, parseLevel, hashBuffer, runSpec, snapshotRoot, compareSnapshots, buildCorpus, loadRoot }
