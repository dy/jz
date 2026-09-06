#!/usr/bin/env node
// The kernel gates, one runner, one manifest: the self-hosted compiler (a kernel)
// compiles a corpus and its own source, and every claim about it is recorded
// with what the kernel was made of (its attestation), what this runner is made
// of (the checkout it judges against), and on what machine.
//
//   node scripts/kernel-gate.mjs --build [--gate functional,sequences,recursive,memory,speed] [--corpus small|medium] [--levels 1,2] [--json out.json] [--keep-kernel out.wasm]
//   node scripts/kernel-gate.mjs --kernel k.wasm ...        bytes built elsewhere; attested by k.wasm.build.json when present
//   node scripts/kernel-gate.mjs --dist ...                 dist/jz.wasm by name (dist/jz.wasm.build.json attests it); never a fallback
//   ... --baseline earlier.json [--tolerance 0.10]          memory: judged against an earlier manifest's complete row set
//   ... --baseline-kernel other.wasm [--speed-tolerance 0.10] [--load-limit 2]   speed: against an attested other kernel
//
// Gates, each green, red or incomplete; a verdict is a certification only when the
// kernel's attestation matches this runner's checkout (graph, dependency, profile):
//   functional  the corpus (scripts/kernel-gate-corpus.js) at each level through a fresh
//               instance per case: valid output, the authored results, bytes identical to
//               the native compile of this checkout; the compiler subgraphs likewise
//   sequences   one instance: empty, A, A again, B at once, B on a fresh instance, a source
//               error, A after it; retained bytes execute after everything
//   recursive   the complete compiler graph through the kernel, the output instantiated
//               and made to compile a probe; wasm32 headroom is a completion condition,
//               not a memory budget
//   memory      per case: heap cursor, wasm memory size (address space, the reserved park
//               lane included after a checkpoint) and completion; per gate process: peak RSS.
//               Judged only against a baseline manifest whose complete row set this run
//               matches case by case, each compiled to completion on both sides
//   speed       compile times against --baseline-kernel: both kernels attested and built on
//               the same corpus contract, both outputs validated and executed before any
//               timing, balanced A/B/B/A sampling, medians, an explicit ratio threshold,
//               and the 1-minute load under --load-limit before and after every case
// Invalid or missing output, a diagnostics ABI the reader rejects, a trap, a timeout, a
// malformed or self-contradicting worker report each fail the gate they occur in. Each
// gate runs in its own process under a timeout. Exit 0: every gate green; 1: a red gate;
// 3: no red gate but an incomplete one; 2: a usage error.
//
// scripts/recursive-self-check.mjs is `--dist --gate recursive`.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveStatus, judgeMemory, judgeSpeed, validateReport } from './kernel-gate-judge.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GATES = ['functional', 'sequences', 'recursive', 'memory', 'speed']
const sha = (b) => createHash('sha256').update(b).digest('hex')
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i])
const usage = (msg) => { console.error(`kernel-gate: ${msg}`); process.exit(2) }

// ── arguments ────────────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(['--gate', '--corpus', '--levels', '--json', '--keep-kernel', '--kernel', '--baseline', '--tolerance', '--baseline-kernel', '--speed-tolerance', '--load-limit', '--timeout', '--worker'])
const BOOL_FLAGS = new Set(['--build', '--dist'])
const parseArgs = (argv) => {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (BOOL_FLAGS.has(a)) { out[a] = true; continue }
    if (!VALUE_FLAGS.has(a)) usage(`unknown argument ${a}`)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`)
    if (a in out) usage(`${a} given twice`)
    out[a] = v; i++
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const flag = (name) => args[name] ?? null
const number = (name, dflt, { min = 0, integer = false } = {}) => {
  if (flag(name) === null) return dflt
  const v = Number(flag(name))
  if (!Number.isFinite(v) || v < min || (integer && !Number.isInteger(v))) usage(`${name} must be a finite ${integer ? 'integer' : 'number'} ≥ ${min}, got ${flag(name)}`)
  return v
}
const gates = (flag('--gate') ?? 'functional,sequences,recursive,memory').split(',').map(s => s.trim()).filter(Boolean)
if (!gates.length) usage('--gate names no gate')
for (const g of gates) if (!GATES.includes(g)) usage(`unknown gate ${g}; gates: ${GATES.join(', ')}`)
if (new Set(gates).size !== gates.length) usage('a gate is named twice')
const size = flag('--corpus') ?? 'medium'
if (!['small', 'medium'].includes(size)) usage(`unknown corpus ${size}; small or medium`)
const levels = (flag('--levels') ?? '1,2').split(',').map(s => s.trim())
if (!levels.length || levels.some(l => !/^[0-3]$/.test(l))) usage(`--levels must list levels 0-3, got ${flag('--levels')}`)
if (new Set(levels).size !== levels.length) usage('a level is listed twice')
const tolerance = number('--tolerance', 0.10)
const speedTolerance = number('--speed-tolerance', 0.10)
const loadLimit = number('--load-limit', 2)
const timeoutMs = number('--timeout', 1_800_000, { min: 1, integer: true })

// ── worker: one gate in this process ─────────────────────────────────────────
if (flag('--worker')) {
  const gate = flag('--worker'), kernelPath = flag('--kernel')
  if (!kernelPath) usage('--worker needs --kernel')
  const { instantiate } = await import('../interop.js')
  const { readMarks } = await import('./kernel-marks.mjs')
  const { resolveSelfCompileBuild } = await import('./build-profile.mjs')
  const { resolveModuleGraph } = await import('../src/resolve.js')
  const { compile } = await import('../index.js')
  const { corpus } = await import('./kernel-gate-corpus.js')
  const kernel = readFileSync(kernelPath)
  const fresh = (bytes = kernel, pages = 8192) => {
    const k = instantiate(bytes, { memory: pages, externref: false })
    readMarks(k)   // a diagnostics ABI the reader rejects fails before any compile
    return k
  }
  const heap = (k) => k.instance.exports.__heap.value >>> 0
  const memBytes = (k) => k.instance.exports.memory.buffer.byteLength
  const optJSON = (k, optimize) => k.memory.String(JSON.stringify(typeof optimize === 'number' ? { level: optimize } : optimize))
  // One compile through a kernel: the bytes copied out at once, validated, with the
  // diagnostics after it (after a trap or a thrown error too) and the failure phase.
  const compileOn = (k, src, { optimize = 2, modules = null, build = null } = {}) => {
    const t0 = performance.now()
    let bytes = null, error = null
    try {
      const out = k.exports.default(k.memory.String(src), 0, optJSON(k, optimize),
        modules ? k.memory.String(JSON.stringify(modules)) : 0, 0, 0, build ? k.memory.String(JSON.stringify(build)) : 0)
      const bin = k.memory.read(out)
      bytes = new Uint8Array(bin instanceof Uint8Array ? bin : new Uint8Array(bin))
      if (!WebAssembly.validate(bytes)) { error = 'output is not valid wasm'; bytes = null }
    } catch (e) { error = e.message }
    const ms = +(performance.now() - t0).toFixed(1)
    const m = readMarks(k)
    const lastPhase = m.phases.length ? m.phases[m.phases.length - 1].name : null
    return {
      bytes, error, ms, completed: !error, heap: heap(k), memoryBytes: memBytes(k),
      phasesDone: m.phasesDone, lastPhase,
      stages: { front: m.heapFront, emit: m.heapEmit, optimize: m.heapOptimize, checkpoint: m.heapCheckpoint },
      // the stage the failure fell in: after the last completed stage mark, or after the last phase compileAst timed
      failurePhase: error ? (m.heapCheckpoint ? 'encode' : m.heapOptimize ? 'checkpoint' : m.heapEmit ? 'watr' : m.heapFront ? `compileAst after ${lastPhase ?? 'front'}` : 'front') : null,
    }
  }
  const results = (bytes, calls) => {
    const ex = instantiate(bytes, { memory: 64 }).exports
    return calls.map(([fn, a, expected]) => { let got; try { got = ex[fn](...a) } catch (e) { got = 'throws: ' + e.message } return { call: `${fn}(${a.map(x => JSON.stringify(x)).join(', ')})`, expected, got, ok: Object.is(got, expected) } })
  }
  const result = { gate, cases: [] }
  const record = (r) => ({ ms: r.ms, completed: r.completed, heap: r.heap, memoryBytes: r.memoryBytes, phasesDone: r.phasesDone, lastPhase: r.lastPhase, stages: r.stages, error: r.error, failurePhase: r.failurePhase })

  if (gate === 'functional') {
    const { programs, subgraphs } = corpus(size)
    for (const p of programs) for (const level of levels.map(Number)) {
      const r = compileOn(fresh(), p.src, { optimize: level })
      const c = { name: `${p.name} O${level}`, family: p.family, level, ...record(r) }
      if (r.bytes) {
        c.bytes = r.bytes.length; c.sha256 = sha(r.bytes)
        const native = compile(p.src, { optimize: level })
        c.native = { bytes: native.length, sha256: sha(native), identical: same(r.bytes, native) }
        try { c.results = results(r.bytes, p.calls) } catch (e) { c.error = 'instantiate: ' + e.message }
      }
      c.status = c.error || !c.native?.identical || !c.results?.every(x => x.ok) ? 'red' : 'green'
      result.cases.push(c)
    }
    for (const g of subgraphs) for (const level of levels.map(Number)) {
      const graph = resolveModuleGraph(g.entry, { resolveNode: true })
      const r = compileOn(fresh(), graph.code, { optimize: level, modules: graph.modules })
      const c = { name: `${g.name} O${level}`, family: g.family, level, modules: Object.keys(graph.modules).length, ...record(r) }
      if (r.bytes) {
        c.bytes = r.bytes.length; c.sha256 = sha(r.bytes)
        const native = compile(graph.code, { modules: graph.modules, optimize: level })
        c.native = { bytes: native.length, sha256: sha(native), identical: same(r.bytes, native) }
      }
      c.status = c.error || !c.native?.identical ? 'red' : 'green'
      result.cases.push(c)
    }
  }

  if (gate === 'sequences') {
    const A = 'export let main = () => 3 + 4 * 5', B = 'let inc = x => x + 1; export let main = () => { const v = inc(10); return v }'
    const k = fresh()
    const step = (name, src, check) => {
      const r = compileOn(k, src)
      const c = { name, level: 2, ...record(r), bytes: r.bytes?.length ?? null, sha256: r.bytes ? sha(r.bytes) : null }
      try { const v = check(r); c.status = v === true ? 'green' : 'red'; if (v !== true) c.why = v } catch (e) { c.status = 'red'; c.why = e.message }
      result.cases.push(c)
      return r
    }
    const empty1 = step('empty', '', r => r.bytes && typeof instantiate(r.bytes).exports.main === 'undefined' || 'no bytes or an entry appeared')
    step('empty again', '', r => same(r.bytes, empty1.bytes) || 'differs from the first empty')
    const a1 = step('A', A, r => r.bytes && instantiate(r.bytes).exports.main() === 23 || 'A does not run to 23')
    const a2 = step('A again', A, r => same(r.bytes, a1.bytes) || 'A → A differ')
    const b1 = step('B at once', B, r => r.bytes && instantiate(r.bytes).exports.main() === 11 || 'B does not run to 11')
    const freshB = compileOn(fresh(), B)
    result.cases.push({ name: 'B on a fresh instance', level: 2, ...record(freshB), bytes: freshB.bytes?.length ?? null, sha256: freshB.bytes ? sha(freshB.bytes) : null, status: same(freshB.bytes, b1.bytes) ? 'green' : 'red', why: same(freshB.bytes, b1.bytes) ? undefined : 'B after A differs from B first' })
    step('source error', 'export let f = (', r => !!r.error && !r.bytes || 'a parse error produced bytes')
    step('A after the error', A, r => same(r.bytes, a1.bytes) || 'A after an error differs')
    result.cases.push({ name: 'retained bytes execute after everything', status: [a1, a2, b1].every(r => r.bytes) && instantiate(a1.bytes).exports.main() === 23 && instantiate(a2.bytes).exports.main() === 23 && instantiate(b1.bytes).exports.main() === 11 ? 'green' : 'red' })
  }

  if (gate === 'recursive') {
    const profile = resolveSelfCompileBuild()
    const k = fresh(kernel, 65536)
    const inputBytes = Buffer.byteLength(profile.graph.code, 'utf8') + Object.values(profile.graph.modules).reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0)
    const r = compileOn(k, profile.graph.code, { optimize: profile.optimize, modules: profile.graph.modules, build: { memory: profile.memory, compactCollections: profile.compactCollections } })
    const c = { name: 'jz × jz', level: profile.optimize?.level ?? profile.optimize, modules: Object.keys(profile.graph.modules).length, inputBytes, ...record(r) }
    if (r.bytes) {
      c.bytes = r.bytes.length; c.sha256 = sha(r.bytes)
      c.headroom = 0x100000000 - r.heap
      try {
        const rec = instantiate(r.bytes, { memory: 65536, externref: false })
        const probe = rec.exports.default(rec.memory.String('export let f = x => x * 3 - 2'), 0, rec.memory.String('2'), 0, 0, 0, 0)
        const bytes = rec.memory.read(probe)
        c.probe = instantiate(new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))).exports.f(7)
      } catch (e) { c.error = 'the recursive compiler failed to compile the probe: ' + e.message }
    }
    c.status = c.error || c.probe !== 19 || c.headroom < 64 * 1024 * 1024 ? 'red' : 'green'
    result.cases.push(c)
  }

  if (gate === 'speed') {
    const other = flag('--baseline-kernel')
    const { programs } = corpus(size)
    const load = () => +loadavg()[0].toFixed(2)
    const incomplete = (why, extra = {}) => result.cases.push({ name: 'speed', status: 'incomplete', why, load: load(), loadLimit, ...extra })
    if (!other) incomplete('no --baseline-kernel')
    else if (load() >= loadLimit) incomplete(`1-minute load ${load()} on ${cpus().length} cpus, limit ${loadLimit}: not an unloaded machine`)
    else {
      const baseline = readFileSync(other)
      const level = 2
      for (const p of programs) {
        const c = { name: p.name, level, loadLimit, loadBefore: load() }
        // both kernels must compile the case to valid, correct output before either is timed
        const check = (bytes, label) => {
          const r = compileOn(fresh(bytes), p.src, { optimize: level })
          if (r.error) return `${label}: ${r.failurePhase ? `[${r.failurePhase}] ` : ''}${r.error}`
          const rs = results(r.bytes, p.calls)
          const bad = rs.filter(x => !x.ok)
          return bad.length ? `${label}: ${bad.map(x => `${x.call} → ${JSON.stringify(x.got)}`).join('; ')}` : null
        }
        const why = check(baseline, 'baseline') ?? check(kernel, 'candidate')
        if (why) { result.cases.push({ ...c, status: 'incomplete', why }); continue }
        const time = (bytes) => { const k = fresh(bytes); const t = performance.now(); k.exports.default(k.memory.String(p.src), 0, optJSON(k, level), 0, 0, 0, 0); return performance.now() - t }
        const a = [], b = []
        for (let round = 0; round < 4; round++) {   // A B B A, four rounds: neither kernel is always warm second
          if (round % 2 === 0) { a.push(time(baseline)); b.push(time(kernel)) } else { b.push(time(kernel)); a.push(time(baseline)) }
        }
        result.cases.push({ ...c, ...judgeSpeed({ baseline: a, candidate: b, tolerance: speedTolerance, loadBefore: c.loadBefore, loadAfter: load(), loadLimit }) })
      }
    }
  }

  result.status = deriveStatus(result.cases)
  result.peakRssMiB = +(process.resourceUsage().maxRSS / 1024).toFixed(1)
  process.stdout.write('\n' + JSON.stringify(result) + '\n')
  process.exit(0)
}

// ── driver: provenance, the kernel, the gates in their own processes, the manifest ──
if ([flag('--kernel') !== null, !!flag('--build'), !!flag('--dist')].filter(Boolean).length !== 1) usage('name the kernel exactly once: --kernel <file>, --build, or --dist')
const git = (...a) => { const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null }
const { resolveSelfCompileBuild } = await import('./build-profile.mjs')
const { privateBuild } = await import('./private-build.mjs')
const { corpus } = await import('./kernel-gate-corpus.js')

// The self graph by content, keyed by paths relative to this checkout (a module under
// node_modules by its package-relative path), so two checkouts of the same sources
// at different locations hash alike; the dependency's content the same way.
const profile = resolveSelfCompileBuild()
const relKey = (p) => { const i = p.indexOf('/node_modules/'); return i >= 0 ? p.slice(i + 1) : relative(ROOT, p) }
const contentHash = (entries) => sha(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}\0${Buffer.byteLength(v, 'utf8')}\0${v}`).join('\0'))
const graphEntries = [['scripts/self.js', profile.graph.code], ...Object.entries(profile.graph.modules).map(([p, s]) => [relKey(p), s])]
const graphSha256 = contentHash(graphEntries)
const watrEntries = graphEntries.filter(([k]) => k.startsWith('node_modules/watr/'))
const watrDir = join(ROOT, 'node_modules/watr')
const watrPkg = existsSync(join(watrDir, 'package.json')) ? JSON.parse(readFileSync(join(watrDir, 'package.json'), 'utf8')) : null
const watrGit = (() => { try { const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: watrDir, encoding: 'utf8' }); return r.status === 0 && existsSync(join(watrDir, '.git')) ? r.stdout.trim() : null } catch { return null } })()
const profileId = { optimize: profile.optimize?.level ?? profile.optimize, memory: profile.memory, compactCollections: profile.compactCollections, defines: profile.defines }
// The working tree: tracked changes (staged or not) and untracked files among the sources the self graph reads.
const SOURCE_ROOTS = ['src/', 'module/', 'jzify/', 'scripts/', 'index.js', 'interop.js', 'package.json']
const isSource = (p) => SOURCE_ROOTS.some(r => p === r || p.startsWith(r))
const porcelain = (git('status', '--porcelain', '--untracked-files=all') || '').split('\n').filter(Boolean)
const dirty = porcelain.map(l => ({ status: l.slice(0, 2), path: l.slice(3).split(' -> ').pop() })).filter(e => isSource(e.path))
const dirtyHash = dirty.length ? sha((git('diff', 'HEAD', '--') || '') + '\0' + dirty.filter(e => e.status.startsWith('??')).map(e => { try { return e.path + '\0' + readFileSync(join(ROOT, e.path), 'utf8') } catch { return e.path } }).join('\0')) : null
const runner = {
  head: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  dirtySources: dirty, dirtySha256: dirtyHash,
  graphSha256, graphModules: Object.keys(profile.graph.modules).length,
  watr: { version: watrPkg?.version ?? null, commit: watrGit, contentSha256: contentHash(watrEntries), files: watrEntries.length, path: relative(ROOT, watrDir) },
  profile: profileId, node: process.version,
}
const attestationOf = (kernelBytes) => ({ kernelSha256: sha(kernelBytes), kernelBytes: kernelBytes.length, graphSha256, watr: runner.watr, profile: profileId, jz: { head: runner.head, dirtySha256: dirtyHash }, node: process.version, builtAt: new Date().toISOString() })
const attestationMatches = (a) => a && a.graphSha256 === graphSha256 && a.watr?.contentSha256 === runner.watr.contentSha256 && JSON.stringify(a.profile) === JSON.stringify(profileId)

// The kernel and its attestation: a build here attests itself; a file is attested by
// its sidecar when the sidecar names these exact bytes; otherwise its origin is unknown.
const manifest = { runner: 'scripts/kernel-gate.mjs', at: new Date().toISOString(), machine: { cpus: cpus().length, load1: +loadavg()[0].toFixed(2), loadLimit }, runnerProvenance: runner, kernel: null, corpus: size, levels: levels.map(Number), gates: {}, status: {} }
const out = flag('--json')
const finish = (code) => { if (out) writeFileSync(resolve(out), JSON.stringify(manifest, null, 2)); process.exit(code) }
let kernelBytes, workDir = null
const sidecarFor = (path) => {
  const sc = path + '.build.json'
  if (!existsSync(sc)) return { attestation: null, why: `no sidecar ${relative(ROOT, sc)}` }
  try { const a = JSON.parse(readFileSync(sc, 'utf8')); return { attestation: a, sidecar: sc } } catch (e) { return { attestation: null, why: `unreadable sidecar: ${e.message}` } }
}
try {
  if (flag('--build')) {
    const t0 = Date.now()
    let built
    try { built = privateBuild(ROOT, 'scripts/self-compile-build.mjs', [], { label: 'self-compile build', prefix: 'jz-kernel-gate-build-' }) }
    catch (e) { manifest.kernel = { source: 'fresh', status: 'red', error: e.message.split('\n').slice(0, 12).join('\n'), buildMs: Date.now() - t0 }; manifest.status = { build: 'red' }; console.error(`kernel build failed: ${e.message.split('\n')[0]}`); finish(1) }
    kernelBytes = built.bytes
    manifest.kernel = { source: 'fresh', origin: 'attested', buildMs: built.ms, attestation: attestationOf(kernelBytes), matchesRunner: true }
    if (flag('--keep-kernel')) { const kp = resolve(flag('--keep-kernel')); writeFileSync(kp, kernelBytes); writeFileSync(kp + '.build.json', JSON.stringify(manifest.kernel.attestation, null, 2)); manifest.kernel.kept = kp }
  } else {
    const path = flag('--dist') ? join(ROOT, 'dist/jz.wasm') : resolve(flag('--kernel'))
    if (!existsSync(path)) usage(`no kernel at ${path}`)
    kernelBytes = readFileSync(path)
    if (!WebAssembly.validate(kernelBytes)) usage(`${path} is not valid wasm`)
    const { attestation, why, sidecar } = sidecarFor(path)
    const bytesMatch = attestation?.kernelSha256 === sha(kernelBytes)
    manifest.kernel = {
      source: flag('--dist') ? 'dist' : 'file', path, kernelSha256: sha(kernelBytes), kernelBytes: kernelBytes.length,
      origin: attestation ? (bytesMatch ? 'attested' : 'sidecar names other bytes') : 'unknown',
      attestation: attestation && bytesMatch ? attestation : null, sidecar: sidecar ?? null, why: attestation ? (bytesMatch ? undefined : 'the sidecar attests different bytes') : why,
      matchesRunner: !!(attestation && bytesMatch && attestationMatches(attestation)),
    }
    if (manifest.kernel.origin === 'attested' && !manifest.kernel.matchesRunner) manifest.kernel.why = 'attested for another graph, dependency or profile than this checkout'
  }
  // the workers read the kernel from a directory this runner owns
  workDir = mkdtempSync(join(tmpdir(), 'jz-kernel-gate-'))
  const kernelPath = join(workDir, 'kernel.wasm')
  writeFileSync(kernelPath, kernelBytes)
  // the baseline kernel for speed: attested, and built on the same corpus contract
  let baselineKernel = null
  if (gates.includes('speed') && flag('--baseline-kernel')) {
    const bp = resolve(flag('--baseline-kernel'))
    if (!existsSync(bp)) usage(`no baseline kernel at ${bp}`)
    const bb = readFileSync(bp)
    if (!WebAssembly.validate(bb)) usage(`${bp} is not valid wasm`)
    const { attestation, why } = sidecarFor(bp)
    baselineKernel = { path: bp, kernelSha256: sha(bb), attested: !!attestation && attestation.kernelSha256 === sha(bb), why }
  }
  manifest.baselineKernel = baselineKernel

  // Every case a gate must report, by name: a worker report missing one, naming one
  // twice or one unknown, or claiming a status its cases contradict, is malformed.
  const expectedCases = (g) => {
    if (g === 'functional') { const { programs, subgraphs } = corpus(size); return [...programs, ...subgraphs].flatMap(p => levels.map(l => `${p.name} O${l}`)) }
    if (g === 'sequences') return ['empty', 'empty again', 'A', 'A again', 'B at once', 'B on a fresh instance', 'source error', 'A after the error', 'retained bytes execute after everything']
    if (g === 'recursive') return ['jz × jz']
    if (g === 'speed') return null   // one row per program, or a single incomplete row
    return []
  }
  // JZ_KERNEL_GATE_WORKER names another worker script: test-only, for reports the real
  // worker would never produce; the manifest records it so such a run is never mistaken for a gate.
  const workerScript = process.env.JZ_KERNEL_GATE_WORKER || fileURLToPath(import.meta.url)
  if (process.env.JZ_KERNEL_GATE_WORKER) manifest.testOnlyWorker = process.env.JZ_KERNEL_GATE_WORKER
  for (const g of gates) {
    if (g === 'memory') continue   // derived from the other gates' cases below
    const t0 = Date.now()
    const r = spawnSync(process.execPath, [workerScript, '--worker', g, '--kernel', kernelPath, '--corpus', size, '--levels', levels.join(','),
      '--speed-tolerance', String(speedTolerance), '--load-limit', String(loadLimit), ...(baselineKernel ? ['--baseline-kernel', baselineKernel.path] : [])],
      { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 })
    const line = (r.stdout || '').trim().split('\n').pop()
    let parsed = null
    try { parsed = JSON.parse(line) } catch {}
    const elapsedMs = Date.now() - t0
    const stderr = (r.stderr || '').split('\n').filter(Boolean).slice(-8).join('\n')
    if (r.error?.code === 'ETIMEDOUT' || (r.signal === 'SIGTERM' && r.error)) manifest.gates[g] = { status: 'red', why: `timeout after ${timeoutMs} ms`, elapsedMs }
    else if (r.error || r.signal || r.status !== 0) manifest.gates[g] = { status: 'red', why: `worker ${r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`}${parsed ? ' (its report is not trusted)' : ''}`, stderr, elapsedMs }
    else if (!parsed) manifest.gates[g] = { status: 'red', why: 'no report from the worker', stderr, elapsedMs }
    else { const bad = validateReport(g, parsed, expectedCases(g)); manifest.gates[g] = bad ? { status: 'red', why: `malformed worker report: ${bad}`, report: parsed, elapsedMs } : { ...parsed, gate: undefined, elapsedMs } }
  }
  // Certification: a verdict against this checkout's native compile or its baseline is
  // a certification only for a kernel attested to match this checkout.
  const attested = !!manifest.kernel.matchesRunner
  for (const g of ['functional']) if (manifest.gates[g] && manifest.gates[g].status === 'green' && !attested) { manifest.gates[g].status = 'incomplete'; manifest.gates[g].why = `every case green, but the kernel's origin is ${manifest.kernel.origin}: ${manifest.kernel.why ?? 'not this checkout'}; not a certification` }
  if (manifest.gates.speed && baselineKernel && !(baselineKernel.attested && attested) && manifest.gates.speed.status === 'green') { manifest.gates.speed.status = 'incomplete'; manifest.gates.speed.why = `timed, but ${!attested ? 'the candidate' : 'the baseline kernel'} is not attested (${!attested ? manifest.kernel.origin : baselineKernel.why})` }
  if (gates.includes('memory')) {
    const rows = []
    for (const g of ['functional', 'sequences', 'recursive']) for (const c of manifest.gates[g]?.cases || []) if (c.heap != null) rows.push({ gate: g, name: c.name, level: c.level ?? null, completed: !!c.completed, heap: c.heap, memoryBytes: c.memoryBytes })
    const peaks = Object.fromEntries(Object.entries(manifest.gates).filter(([g]) => g !== 'memory').map(([g, v]) => [g, v.peakRssMiB ?? null]))
    let baseline = null, unreadable = null
    if (flag('--baseline')) { try { baseline = JSON.parse(readFileSync(flag('--baseline'), 'utf8')) } catch (e) { unreadable = `unreadable baseline: ${e.message}` } }
    const mem = judgeMemory({ rows, peaks, baseline, size, levels: levels.map(Number), profile: profileId, tolerance })
    if (unreadable) mem.why = unreadable
    mem.metrics = { heap: 'heap cursor after the compile (bytes)', memoryBytes: 'wasm memory size, address space; includes the reserved park lane after a checkpoint', peakRssMiB: 'peak resident set of the gate process, all its cases together' }
    manifest.gates.memory = mem
  }
} finally {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
}
manifest.status = Object.fromEntries(Object.entries(manifest.gates).map(([g, v]) => [g, v.status]))
manifest.certified = !!manifest.kernel.matchesRunner && Object.values(manifest.status).every(s => s === 'green')

const pad = (s, n) => String(s ?? '').padEnd(n)
const k = manifest.kernel
console.log(`kernel ${k.source} ${k.attestation?.kernelBytes ?? k.kernelBytes} B sha256 ${(k.attestation?.kernelSha256 ?? k.kernelSha256).slice(0, 12)} origin ${k.origin}${k.matchesRunner ? ', matches this checkout' : k.why ? `: ${k.why}` : ''} | runner jz ${runner.head?.slice(0, 8)}${dirty.length ? ` +${dirty.length} dirty` : ''} graph ${graphSha256.slice(0, 12)} watr ${runner.watr.version}${runner.watr.commit ? '@' + runner.watr.commit.slice(0, 7) : ''} src ${runner.watr.contentSha256.slice(0, 12)} | load ${manifest.machine.load1}`)
for (const [g, v] of Object.entries(manifest.gates)) {
  console.log(`${pad(g, 11)} ${pad(v.status.toUpperCase(), 10)} ${v.why || ''}${v.stderr ? ': ' + (v.stderr.split('\n').find(l => /Error|error/.test(l)) || v.stderr.split('\n').pop()) : ''}`)
  for (const c of v.cases || []) console.log(`  ${pad(c.status?.toUpperCase(), 10)} ${pad(c.name, 28)} ${c.bytes != null ? pad(c.bytes + ' B', 10) : pad('', 10)} ${c.native ? (c.native.identical ? 'native-identical' : 'DIFFERS from native') : ''} ${c.results ? c.results.filter(x => !x.ok).map(x => `${x.call} → ${JSON.stringify(x.got)} (expected ${JSON.stringify(x.expected)})`).join('; ') : ''} ${c.error ? `${c.failurePhase ? `[${c.failurePhase}] ` : ''}${c.error.split('\n')[0].slice(0, 100)}` : ''} ${c.why || ''} ${c.ratio ? `${c.baselineMs} → ${c.candidateMs} ms (${c.ratio}x)` : ''}`)
  for (const r of v.over || []) console.log(`  OVER       ${pad(r.case, 28)} ${r.metric} ${r.current} vs baseline ${r.baseline}`)
}
console.log(`certified: ${manifest.certified}`)
finish(Object.values(manifest.status).some(s => s === 'red') ? 1 : Object.values(manifest.status).some(s => s === 'incomplete') ? 3 : 0)
