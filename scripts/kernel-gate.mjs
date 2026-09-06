#!/usr/bin/env node
// The kernel gates, one runner, one manifest: the self-hosted compiler (a kernel)
// compiles a corpus and its own source, and every claim about it is recorded
// with what it was made of and on.
//
//   node scripts/kernel-gate.mjs --build [--gate functional,sequences,recursive,memory,speed] [--corpus small|medium] [--levels 1,2] [--json out.json]
//   node scripts/kernel-gate.mjs --kernel private.wasm ...      a kernel built elsewhere (review runs)
//   node scripts/kernel-gate.mjs --dist ...                     dist/jz.wasm, named explicitly; never a fallback
//   ... --baseline earlier.json [--tolerance 0.10]              memory against an earlier manifest
//   ... --baseline-kernel other.wasm                            speed: serial alternating runs against another kernel
//
// The gates are separate and each ends green, red or incomplete:
//   functional  the corpus (scripts/kernel-gate-corpus.js) through a fresh kernel instance per
//               case: valid output, the authored results, bytes identical to the native compile,
//               the compiler subgraphs likewise
//   sequences   one instance: empty, A, A again, B at once, B on a fresh instance, a source error,
//               A after it; retained bytes execute after everything
//   recursive   the complete compiler graph through the kernel, the output instantiated and
//               made to compile a probe; wasm32 headroom
//   memory      heap cursor, memory.buffer size and the process peak of every case above,
//               red only against a baseline manifest (nothing near the ceiling is blessed here)
//   speed       compile times, only on an unloaded machine (1-minute load under 2) and only against
//               --baseline-kernel; otherwise incomplete with the load recorded
// Missing or invalid output, a diagnostics ABI the reader rejects, a trap and a timeout
// all fail the gate they occur in. Each gate runs in its own process under a timeout.
//
// scripts/recursive-self-check.mjs is `--dist --gate recursive`.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const has = (name) => args.includes(name)
const GATES = ['functional', 'sequences', 'recursive', 'memory', 'speed']
const sha = (b) => createHash('sha256').update(b).digest('hex')
const git = (...a) => { const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null }

// ── worker: one gate in this process ─────────────────────────────────────────
if (has('--worker')) {
  const gate = flag('--worker'), kernelPath = flag('--kernel'), size = flag('--corpus') || 'medium'
  const { instantiate } = await import('../interop.js')
  const { readMarks } = await import('./kernel-marks.mjs')
  const { resolveSelfCompileBuild } = await import('./build-profile.mjs')
  const { resolveModuleGraph } = await import('../src/resolve.js')
  const { compile } = await import('../index.js')
  const { corpus } = await import('./kernel-gate-corpus.js')
  const kernel = readFileSync(kernelPath)
  const fresh = (pages = 8192) => {
    const k = instantiate(kernel, { memory: pages, externref: false })
    readMarks(k)   // a diagnostics ABI the reader rejects fails before any compile
    return k
  }
  const heap = (k) => k.instance.exports.__heap.value >>> 0
  const memBytes = (k) => k.instance.exports.memory.buffer.byteLength
  // One compile through a kernel: the bytes copied out at once, validated, with the
  // diagnostics after it (after a trap or a thrown error too) and the failure phase.
  const compileOn = (k, src, { optimize = 2, modules = null, build = null } = {}) => {
    const t0 = performance.now()
    const rec = { ms: 0, heap: 0, memoryBytes: 0, phasesDone: 0, lastPhase: null, stages: null }
    let bytes = null, error = null
    try {
      const out = k.exports.default(k.memory.String(src), 0, k.memory.String(JSON.stringify(typeof optimize === 'number' ? { level: optimize } : optimize)),
        modules ? k.memory.String(JSON.stringify(modules)) : 0, 0, 0, build ? k.memory.String(JSON.stringify(build)) : 0)
      const bin = k.memory.read(out)
      bytes = new Uint8Array(bin instanceof Uint8Array ? bin : new Uint8Array(bin))
      if (!WebAssembly.validate(bytes)) { error = 'output is not valid wasm'; bytes = null }
    } catch (e) { error = e.message }
    rec.ms = +(performance.now() - t0).toFixed(1)
    rec.heap = heap(k); rec.memoryBytes = memBytes(k)
    const m = readMarks(k)
    rec.phasesDone = m.phasesDone; rec.lastPhase = m.phases.length ? m.phases[m.phases.length - 1].name : null
    rec.stages = { front: m.heapFront, emit: m.heapEmit, optimize: m.heapOptimize, checkpoint: m.heapCheckpoint }
    // the stage the failure fell in: after the last completed stage mark, or after the last phase compileAst timed
    rec.failurePhase = error ? (m.heapCheckpoint ? 'encode' : m.heapOptimize ? 'checkpoint' : m.heapEmit ? 'watr' : m.heapFront ? `compileAst after ${rec.lastPhase ?? 'front'}` : 'front') : null
    return { bytes, error, ...rec }
  }
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i])
  const result = { gate, cases: [] }
  const status = () => result.cases.some(c => c.status === 'red') ? 'red' : result.cases.some(c => c.status === 'incomplete') ? 'incomplete' : 'green'

  if (gate === 'functional') {
    const { programs, subgraphs } = corpus(size)
    const levels = (flag('--levels') || '1,2').split(',').map(Number)
    for (const p of programs) for (const level of levels) {
      const k = fresh()
      const r = compileOn(k, p.src, { optimize: level })
      const c = { name: `${p.name} O${level}`, family: p.family, level, ms: r.ms, heap: r.heap, memoryBytes: r.memoryBytes, phasesDone: r.phasesDone, lastPhase: r.lastPhase, stages: r.stages, error: r.error, failurePhase: r.failurePhase }
      if (r.bytes) {
        c.bytes = r.bytes.length; c.sha256 = sha(r.bytes)
        const native = compile(p.src, { optimize: level })
        c.native = { bytes: native.length, sha256: sha(native), identical: same(r.bytes, native) }
        try {
          const ex = instantiate(r.bytes).exports
          c.results = p.calls.map(([fn, a, expected]) => { let got; try { got = ex[fn](...a) } catch (e) { got = 'throws: ' + e.message } return { call: `${fn}(${a.map(x => JSON.stringify(x)).join(', ')})`, expected, got, ok: Object.is(got, expected) } })
        } catch (e) { c.error = 'instantiate: ' + e.message }
      }
      c.status = c.error || !c.native?.identical || !c.results?.every(x => x.ok) ? 'red' : 'green'
      result.cases.push(c)
    }
    for (const g of subgraphs) for (const level of levels) {
      const graph = resolveModuleGraph(g.entry, { resolveNode: true })
      const k = fresh()
      const r = compileOn(k, graph.code, { optimize: level, modules: graph.modules })
      const c = { name: `${g.name} O${level}`, family: g.family, level, modules: Object.keys(graph.modules).length, ms: r.ms, heap: r.heap, memoryBytes: r.memoryBytes, phasesDone: r.phasesDone, lastPhase: r.lastPhase, stages: r.stages, error: r.error, failurePhase: r.failurePhase }
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
      const c = { name, ms: r.ms, heap: r.heap, memoryBytes: r.memoryBytes, phasesDone: r.phasesDone, lastPhase: r.lastPhase, error: r.error, failurePhase: r.failurePhase, bytes: r.bytes?.length ?? null, sha256: r.bytes ? sha(r.bytes) : null }
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
    result.cases.push({ name: 'B on a fresh instance', bytes: freshB.bytes?.length ?? null, sha256: freshB.bytes ? sha(freshB.bytes) : null, error: freshB.error, status: same(freshB.bytes, b1.bytes) ? 'green' : 'red', why: same(freshB.bytes, b1.bytes) ? undefined : 'B after A differs from B first' })
    step('source error', 'export let f = (', r => !!r.error && !r.bytes || 'a parse error produced bytes')
    step('A after the error', A, r => same(r.bytes, a1.bytes) || 'A after an error differs')
    result.cases.push({ name: 'retained bytes execute after everything', status: [a1, a2, b1].every(r => r.bytes) && instantiate(a1.bytes).exports.main() === 23 && instantiate(a2.bytes).exports.main() === 23 && instantiate(b1.bytes).exports.main() === 11 ? 'green' : 'red' })
  }

  if (gate === 'recursive') {
    const profile = resolveSelfCompileBuild()
    const k = fresh(65536)
    const inputBytes = profile.graph.code.length + Object.values(profile.graph.modules).reduce((n, s) => n + s.length, 0)
    const r = compileOn(k, profile.graph.code, { optimize: profile.optimize, modules: profile.graph.modules, build: { memory: profile.memory, compactCollections: profile.compactCollections } })
    const c = { name: 'jz × jz', modules: Object.keys(profile.graph.modules).length, inputBytes, ms: r.ms, heap: r.heap, memoryBytes: r.memoryBytes, phasesDone: r.phasesDone, lastPhase: r.lastPhase, stages: r.stages, error: r.error, failurePhase: r.failurePhase }
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
    const load = loadavg()[0]
    if (!other || load >= 2) {
      result.cases.push({ name: 'speed', status: 'incomplete', why: !other ? 'no --baseline-kernel' : `1-minute load ${load.toFixed(2)} on ${cpus().length} cpus: not an unloaded machine`, load })
    } else {
      const baseline = readFileSync(other)
      const time = (bytes, src) => { const k = instantiate(bytes, { memory: 8192, externref: false }); const t = performance.now(); k.exports.default(k.memory.String(src), 0, k.memory.String('{"level":2}'), 0, 0, 0, 0); return performance.now() - t }
      for (const p of programs) {
        const a = [], b = []
        for (let i = 0; i < 7; i++) { a.push(time(baseline, p.src)); b.push(time(kernel, p.src)) }   // serial, alternating
        const med = xs => [...xs].sort((x, y) => x - y)[xs.length >> 1]
        result.cases.push({ name: p.name, baselineMs: +med(a).toFixed(2), candidateMs: +med(b).toFixed(2), ratio: +(med(b) / med(a)).toFixed(3), load, status: 'green' })
      }
    }
  }

  result.status = status()
  result.maxRssMB = +(process.resourceUsage().maxRSS / 1024).toFixed(0)
  process.stdout.write('\n' + JSON.stringify(result) + '\n')
  process.exit(0)
}

// ── driver: the manifest and the gates in their own processes ────────────────
const gates = (flag('--gate') || 'functional,sequences,recursive,memory').split(',').filter(Boolean)
for (const g of gates) if (!GATES.includes(g)) { console.error(`unknown gate ${g}; gates: ${GATES.join(', ')}`); process.exit(2) }
const size = flag('--corpus') || 'medium'
const timeoutMs = Number(flag('--timeout') ?? 1_800_000)

// The kernel: named bytes, a fresh private build, or dist by name. Never dist by default.
let kernelPath, kernelSource, buildDir = null
if (flag('--kernel')) { kernelPath = resolve(flag('--kernel')); kernelSource = 'file' }
else if (has('--build')) {
  buildDir = mkdtempSync(join(tmpdir(), 'jz-kernel-gate-'))
  kernelPath = join(buildDir, 'jz.wasm'); kernelSource = 'fresh'
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/self-compile-build.mjs'), kernelPath], { cwd: ROOT, encoding: 'utf8', timeout: 1_200_000 })
  if (r.error || r.signal || r.status !== 0) { console.error(`kernel build failed: exit ${r.status}${r.signal ? ` (${r.signal})` : ''}\n${r.error?.message || ''}${r.stderr || ''}`); rmSync(buildDir, { recursive: true, force: true }); process.exit(2) }
} else if (has('--dist')) { kernelPath = join(ROOT, 'dist/jz.wasm'); kernelSource = 'dist' }
else { console.error('name the kernel: --kernel <file>, --build, or --dist'); process.exit(2) }
if (!existsSync(kernelPath)) { console.error(`no kernel at ${kernelPath}`); process.exit(2) }
const kernelBytes = readFileSync(kernelPath)
if (!WebAssembly.validate(kernelBytes)) { console.error(`${kernelPath} is not valid wasm`); process.exit(2) }

// What the kernel was made of: revisions, the working tree, the self graph, the dependency.
const { resolveSelfCompileBuild } = await import('./build-profile.mjs')
const profile = resolveSelfCompileBuild()
const graphHash = sha(profile.graph.code + '\0' + Object.keys(profile.graph.modules).sort().map(p => p + '\0' + profile.graph.modules[p]).join('\0'))
const dirtyFiles = (git('status', '--porcelain', '--untracked-files=no') || '').split('\n').filter(Boolean)
const watrDir = join(ROOT, 'node_modules/watr')
const watrPkg = existsSync(join(watrDir, 'package.json')) ? JSON.parse(readFileSync(join(watrDir, 'package.json'), 'utf8')) : null
const watrSrcHash = sha(Object.keys(profile.graph.modules).filter(p => p.includes('/node_modules/watr/')).sort().map(p => p + '\0' + profile.graph.modules[p]).join('\0'))
const manifest = {
  runner: 'scripts/kernel-gate.mjs', at: new Date().toISOString(), node: process.version,
  machine: { cpus: cpus().length, load1: +loadavg()[0].toFixed(2) },
  jz: { head: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirty: dirtyFiles.length, dirtyFiles, diffSha256: dirtyFiles.length ? sha(git('diff') || '') : null, graphSha256: graphHash, graphModules: Object.keys(profile.graph.modules).length },
  watr: { version: watrPkg?.version ?? null, srcSha256: watrSrcHash, path: relative(ROOT, watrDir) },
  build: { source: kernelSource, kernel: kernelPath, kernelBytes: kernelBytes.length, kernelSha256: sha(kernelBytes), profile: { optimize: profile.optimize?.level ?? profile.optimize, memory: profile.memory, compactCollections: profile.compactCollections, defines: profile.defines } },
  corpus: size, gates: {},
}
for (const g of gates) {
  if (g === 'memory') continue   // derived from the other gates' cases below
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', g, '--kernel', kernelPath, '--corpus', size, '--levels', flag('--levels') || '1,2', ...(flag('--baseline-kernel') ? ['--baseline-kernel', resolve(flag('--baseline-kernel'))] : [])],
    { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 })
  const line = (r.stdout || '').trim().split('\n').pop()
  let parsed = null
  try { parsed = JSON.parse(line) } catch {}
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM' && !parsed) manifest.gates[g] = { status: 'red', why: `timeout after ${timeoutMs} ms`, elapsedMs: Date.now() - t0 }
  else if (!parsed || r.status !== 0) manifest.gates[g] = { status: 'red', why: `worker exit ${r.status}${r.signal ? ` (${r.signal})` : ''}`, stderr: (r.stderr || '').split('\n').filter(Boolean).slice(-8).join('\n'), elapsedMs: Date.now() - t0 }
  else manifest.gates[g] = { ...parsed, gate: undefined, elapsedMs: Date.now() - t0 }
}
if (gates.includes('memory')) {
  const rows = []
  for (const g of ['functional', 'sequences', 'recursive']) for (const c of manifest.gates[g]?.cases || []) if (c.heap != null) rows.push({ gate: g, name: c.name, heap: c.heap, memoryBytes: c.memoryBytes })
  const mem = { status: 'incomplete', rows, peakRssMB: Object.fromEntries(Object.entries(manifest.gates).map(([g, v]) => [g, v.maxRssMB ?? null])) }
  const baselinePath = flag('--baseline'), tolerance = Number(flag('--tolerance') ?? 0.10)
  if (!rows.length) mem.why = 'no gate with heap figures ran'
  else if (!baselinePath) mem.why = 'no --baseline manifest: figures recorded, nothing judged'
  else {
    const base = JSON.parse(readFileSync(baselinePath, 'utf8'))
    const baseRows = new Map((base.gates?.memory?.rows || []).map(r => [`${r.gate}/${r.name}`, r]))
    mem.over = rows.filter(r => { const b = baseRows.get(`${r.gate}/${r.name}`); return b && r.heap > b.heap * (1 + tolerance) }).map(r => ({ ...r, baselineHeap: baseRows.get(`${r.gate}/${r.name}`).heap }))
    mem.compared = rows.filter(r => baseRows.has(`${r.gate}/${r.name}`)).length
    mem.status = mem.compared === 0 ? 'incomplete' : mem.over.length ? 'red' : 'green'
    if (mem.compared === 0) mem.why = 'the baseline manifest shares no case with this run'
  }
  manifest.gates.memory = mem
}
manifest.status = Object.fromEntries(Object.entries(manifest.gates).map(([g, v]) => [g, v.status]))
if (buildDir) rmSync(buildDir, { recursive: true, force: true })

const out = flag('--json')
if (out) writeFileSync(resolve(out), JSON.stringify(manifest, null, 2))
const pad = (s, n) => String(s ?? '').padEnd(n)
console.log(`kernel ${manifest.build.source} ${manifest.build.kernelBytes} B sha256 ${manifest.build.kernelSha256.slice(0, 12)} | jz ${manifest.jz.head?.slice(0, 8)}${manifest.jz.dirty ? ` +${manifest.jz.dirty} dirty` : ''} graph ${manifest.jz.graphSha256.slice(0, 12)} | watr ${manifest.watr.version} src ${manifest.watr.srcSha256.slice(0, 12)} | load ${manifest.machine.load1}`)
for (const [g, v] of Object.entries(manifest.gates)) {
  console.log(`${pad(g, 11)} ${pad(v.status.toUpperCase(), 10)} ${v.why || ''}${v.stderr ? ': ' + v.stderr.split('\n').find(l => /Error|error/.test(l)) || v.stderr.split('\n').pop() : ''}`)
  for (const c of v.cases || []) console.log(`  ${pad(c.status?.toUpperCase(), 10)} ${pad(c.name, 28)} ${c.bytes != null ? pad(c.bytes + ' B', 10) : pad('', 10)} ${c.native ? (c.native.identical ? 'native-identical' : 'DIFFERS from native') : ''} ${c.results ? c.results.filter(x => !x.ok).map(x => `${x.call} → ${JSON.stringify(x.got)} (expected ${JSON.stringify(x.expected)})`).join('; ') : ''} ${c.error ? `${c.failurePhase ? `[${c.failurePhase}] ` : ''}${c.error.split('\n')[0].slice(0, 100)}` : ''} ${c.why || ''} ${c.ratio ? `${c.baselineMs} → ${c.candidateMs} ms (${c.ratio}x)` : ''}`)
  for (const r of v.over || []) console.log(`  OVER       ${pad(r.gate + '/' + r.name, 28)} heap ${r.heap} vs baseline ${r.baselineHeap}`)
}
process.exit(Object.values(manifest.status).some(s => s === 'red') ? 1 : 0)
