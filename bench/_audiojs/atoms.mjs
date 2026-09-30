// Every atom of the @audio families through the entry @audio/compile-vst generates for it
// (module-owned buffers, setup/start/process), run as JavaScript under V8 and as jz wasm.
// Per atom: does it compile, does processing agree with JavaScript, does it allocate while
// processing (heapGrowth: over all blocks, a state made on the first block included;
// heapPerBlock: per block over the second half of them, what a long run keeps growing by),
// how fast is it. Streaming atoms process 256 blocks of 512 frames at their default
// parameters. Whole-render atoms (streaming: false, which compile-vst itself declines) render
// four blocks of 0.5 s with every number parameter halfway from its default to its maximum:
// their defaults are often the identity (stretch factor 1), which would time a copy.
//
//   node bench/_audiojs/atoms.mjs                     all atoms, summary
//   node bench/_audiojs/atoms.mjs effect dynamics     named families
//   node bench/_audiojs/atoms.mjs --one effect effect-gain gain     one atom, its record as JSON
//   CONC=3 (parallel atoms)   OUT=records.jsonl (keep the records; a rerun resumes from them)
//   SPEED=0 (no timing: agreement and memory only)
//
// Each atom runs in its own process: a trap or a hang stays contained.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FAMILY, compile, instantiate, resolveModuleGraph, table, commit } from './lib.mjs'

const SR = 48000
const SKIP = new Set(['compile', 'decode', 'encode', 'host', 'mic', 'speaker', 'neural'])   // codecs, hosts, device I/O, model runtimes
const first = e => String(e?.message ?? e).split('\n')[0].slice(0, 200)
const manifestOf = dir => { try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).audio } catch { return null } }

// ── one atom ────────────────────────────────────────────────────────────────────────────
async function one(fam, pkg, key) {
  const { toVst3 } = await import(pathToFileURL(join(FAMILY, 'compile/packages/compile-vst/vst3.js')))
  const { buildShim } = await import(pathToFileURL(join(FAMILY, 'compile/packages/compile-vst/shim.js')))
  const dir = join(FAMILY, fam, 'packages', pkg), rec = { atom: `${fam}/${pkg}:${key}` }
  const done = extra => { console.log(JSON.stringify({ ...rec, ...extra })); process.exit(0) }
  const at = stage => process.stderr.write(`stage ${stage}\n`)   // a run killed by the timeout is charged to its last stage

  let manifest, audio = manifestOf(dir), whole = false
  try {
    let factory = (await import(pathToFileURL(join(dir, audio))))[key]
    whole = factory.streaming === false
    // a whole-render atom is driven as one long block: the manifest is derived from a copy that streams
    if (whole) factory = Object.defineProperty(Object.assign((ctx) => 0, factory, { streaming: true }), 'name', { value: factory.name })
    manifest = toVst3(factory, { vendor: 'org.audiojs', export: key })
    for (const b of [...manifest.buses.inputs, ...manifest.buses.outputs]) if (b.channels !== 1 && b.channels !== 2) throw new Error('bus is not mono or stereo')
  } catch (e) { done({ stage: 'manifest', error: first(e) }) }

  // the generated entry beside a re-export of the atom: its imports resolve from its own package
  const tmp = mkdtempSync(join(tmpdir(), 'jz-atom-'))
  process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
  writeFileSync(join(tmp, 'atom.js'), `export * from '${join(dir, audio)}'\n`)
  writeFileSync(join(tmp, 'shim.js'), buildShim(manifest))

  const FRAMES = whole ? 24000 : 512, BLOCKS = whole ? 4 : 256, TIMED_BLOCKS = whole ? 2 : 48
  rec.blocks = BLOCKS
  rec.whole = whole
  const idx = list => list.flatMap((b, i) => Array.from({ length: b.channels }, (_, c) => i * 2 + c))
  const ins = idx(manifest.buses.inputs), outs = idx(manifest.buses.outputs)
  const drive = ins.map((_, j) => { const d = new Float32Array(FRAMES * BLOCKS); let r = (0x9e3779b9 + j * 7919) >>> 0; for (let i = 0; i < d.length; i++) { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; d[i] = 0.4 * Math.sin(i * 0.0576) + 0.2 * Math.sin(i * 0.31 + 1) + 0.1 * (r / 2147483648 - 1) } return d })
  const block = (j, b) => drive[j].subarray(b * FRAMES, (b + 1) * FRAMES)
  const numbers = manifest.paramSpecs.map((s, k) => [s, k]).filter(([s]) => s.type === 'number')
  const prime = x => {
    x.setup(FRAMES, SR)
    if (whole) for (const [s, k] of numbers) x.param(k)[0] = s.default + (s.max - s.default) / 2
    x.start()
  }
  const render = (x, after, each) => {
    prime(x)
    const mark = after?.()
    const res = outs.map(() => new Float32Array(FRAMES * BLOCKS))
    for (let b = 0; b < BLOCKS; b++) {
      ins.forEach((k, j) => x.input(k).set(block(j, b)))
      x.process(FRAMES)
      each?.()
      outs.forEach((k, j) => res[j].set(x.output(k).subarray(0, FRAMES), b * FRAMES))
    }
    return { res, mark }
  }

  at('javascript')
  let js, ref
  try { js = await import(pathToFileURL(join(tmp, 'shim.js'))); ref = render(js).res } catch (e) { done({ stage: 'javascript', error: first(e) }) }

  at('compile')
  let wasm
  const t0 = performance.now(), warnings = []
  try {
    const { code, modules } = resolveModuleGraph(join(tmp, 'shim.js'), { resolveNode: true })
    wasm = compile(code, { modules, warnings: { entries: warnings } })
  } catch (e) { done({ stage: 'compile', error: first(e) }) }
  rec.compileMs = Math.round(performance.now() - t0); rec.bytes = wasm.length
  rec.imports = WebAssembly.Module.imports(new WebAssembly.Module(wasm)).map(i => i.name)

  at('run')
  let got
  try {
    const { exports: wz, memory } = instantiate(wasm)
    const used = []
    const r = render(wz, () => [wz.__heap?.value ?? 0, memory?.buffer.byteLength ?? 0], () => used.push(wz.__heap?.value ?? 0))
    got = r.res
    rec.heapGrowth = (wz.__heap?.value ?? 0) - r.mark[0]
    rec.heapPerBlock = Math.round((used[BLOCKS - 1] - used[(BLOCKS >> 1) - 1]) / (BLOCKS - (BLOCKS >> 1)))
    rec.memoryGrowth = (memory?.buffer.byteLength ?? 0) - r.mark[1]
  } catch (e) { done({ stage: 'run', error: first(e) }) }

  let exact = true, peak = 0, err = 0, n = 0
  for (let c = 0; c < ref.length; c++) for (let i = 0; i < ref[c].length; i++) {
    const a = ref[c][i], b = got[c][i], d = a - b
    if (!Object.is(a, b)) exact = false
    err += d === d ? d * d : Infinity; n++
    if (Math.abs(a) > peak) peak = Math.abs(a)
  }
  rec.exact = exact
  rec.snr = exact ? null : +(20 * Math.log10((peak || 1e-30) / (Math.sqrt(err / (n || 1)) || 1e-300))).toFixed(1)

  if (process.env.SPEED !== '0') try {   // interleaved minimum of whole renders
    const { exports: wz, memory } = instantiate(wasm)
    prime(js); prime(wz)
    const jin = ins.map(k => js.input(k)), views = () => ins.map(k => wz.input(k))
    let win = views()
    const passJs = () => { for (let b = 0; b < TIMED_BLOCKS; b++) { for (let j = 0; j < jin.length; j++) jin[j].set(block(j, b)); js.process(FRAMES) } }
    const passWz = () => { for (let b = 0; b < TIMED_BLOCKS; b++) { if (win.length && win[0].buffer !== memory.buffer) win = views(); for (let j = 0; j < win.length; j++) win[j].set(block(j, b)); wz.process(FRAMES) } }
    for (let w = 0; w < (whole ? 2 : 6); w++) { passJs(); passWz() }
    let bj = Infinity, bw = Infinity
    for (let r = 0, end = performance.now() + (whole ? 12000 : 4000); r < 40 && performance.now() < end; r++) {
      let t = performance.now(); passJs(); bj = Math.min(bj, performance.now() - t)
      t = performance.now(); passWz(); bw = Math.min(bw, performance.now() - t)
    }
    rec.jsMs = +bj.toFixed(4); rec.jzMs = +bw.toFixed(4); rec.speed = +(bj / bw).toFixed(3)
  } catch (e) { rec.speedError = first(e) }
  done({ stage: 'ok' })
}

// ── all atoms ───────────────────────────────────────────────────────────────────────────
async function list(families) {
  const atoms = []
  for (const fam of readdirSync(FAMILY)) {
    if (SKIP.has(fam) || (families.length && !families.includes(fam)) || !existsSync(join(FAMILY, fam, 'packages'))) continue
    for (const pkg of readdirSync(join(FAMILY, fam, 'packages'))) {
      const dir = join(FAMILY, fam, 'packages', pkg), audio = !pkg.startsWith('_') && manifestOf(dir)
      if (!audio) continue
      let mod; try { mod = await import(pathToFileURL(join(dir, audio))) } catch { continue }
      for (const [key, m] of Object.entries(mod))
        if (typeof m === 'function' && typeof m.params === 'object') atoms.push({ fam, pkg, key, whole: m.streaming === false })
    }
  }
  return atoms
}

async function all(families) {
  const atoms = await list(families)
  const out = process.env.OUT || join(mkdtempSync(join(tmpdir(), 'jz-atoms-')), 'records.jsonl')
  const read = () => existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const seen = new Set(read().map(r => r.atom)), queue = atoms.filter(a => !seen.has(`${a.fam}/${a.pkg}:${a.key}`))
  const c = await commit()
  console.log(`jz ${c.jz}, node ${process.version}`)
  console.log(`${atoms.length} atoms: ${atoms.filter(a => !a.whole).length} streaming, ${atoms.filter(a => a.whole).length} whole-render`)
  await new Promise(resolve => {
    let active = 0, i = 0
    const next = () => {
      if (!active && i >= queue.length) return resolve()
      while (active < (+process.env.CONC || 3) && i < queue.length) {
        const a = queue[i++], id = `${a.fam}/${a.pkg}:${a.key}`; active++
        const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--one', a.fam, a.pkg, a.key], { stdio: ['ignore', 'pipe', 'pipe'] })
        let so = '', se = ''
        p.stdout.on('data', d => so += d); p.stderr.on('data', d => se += d)
        const timer = setTimeout(() => p.kill('SIGKILL'), 240_000)
        p.on('close', (code, sig) => {
          clearTimeout(timer)
          const line = so.trim().split('\n').filter(l => l.startsWith('{')).pop()
          const last = se.trim().split('\n').filter(l => l.startsWith('stage ')).pop()?.slice(6)
          const rec = line ? JSON.parse(line) : sig
            ? { atom: id, stage: last === 'javascript' ? 'javascript' : 'timeout', error: `no result in 240 s, stopped in ${last ?? 'setup'}` }
            : { atom: id, stage: 'crash', error: first(se.trim().split('\n').find(l => /Error/.test(l)) || `exit ${code}`) }
          appendFileSync(out, JSON.stringify(rec) + '\n')
          process.stderr.write(`${id}: ${rec.stage}${rec.speed ? ` ${rec.speed}×` : ''}${rec.error ? `: ${rec.error.slice(0, 90)}` : ''}\n`)
          active--; next()
        })
      }
    }
    next()
  })

  const rs = read(), ok = rs.filter(r => r.stage === 'ok'), speeds = ok.filter(r => r.speed).map(r => r.speed).sort((a, b) => a - b)
  const geo = a => Math.exp(a.reduce((s, v) => s + Math.log(v), 0) / a.length)
  const wrong = ok.filter(r => !r.exact && !(r.snr >= 100))
  console.log(`\nrecords: ${out}\n`)
  table(['', 'atoms'], [
    ['atoms', rs.length],
    ['no entry for them (unnamed export, ambisonic bus)', rs.filter(r => r.stage === 'manifest').length],
    ['the JavaScript reference fails or does not finish', rs.filter(r => r.stage === 'javascript').length],
    ['do not compile', rs.filter(r => r.stage === 'compile').length],
    ['fail at run, crash or hang', rs.filter(r => ['run', 'crash', 'timeout'].includes(r.stage)).length],
    ['run', ok.length],
    ['· output bit-exact with JavaScript', ok.filter(r => r.exact).length],
    ['· output within rounding (error below −100 dB)', ok.filter(r => !r.exact && r.snr >= 100).length],
    ['· output differs', wrong.length],
    ['· process without allocating', ok.filter(r => r.heapGrowth === 0 && r.memoryGrowth === 0).length],
    ['· keep growing the heap block after block', ok.filter(r => r.heapPerBlock > 0).length],
    ['· import host functions', ok.filter(r => r.imports.length).length],
    ['· faster than V8', speeds.filter(v => v > 1).length],
    ['· below half of V8', speeds.filter(v => v < 0.5).length],
  ])
  if (speeds.length) console.log(`\nspeed, jz over V8: geomean ${geo(speeds).toFixed(2)}×, median ${speeds[speeds.length >> 1]}×, from ${speeds[0]}× to ${speeds.at(-1)}×`)
  for (const [label, part] of [['streaming', ok.filter(r => !r.whole && r.speed)], ['whole-render', ok.filter(r => r.whole && r.speed)]])
    if (part.length) console.log(`  ${label}: ${part.length} atoms, geomean ${geo(part.map(r => r.speed)).toFixed(2)}×`)
  for (const r of rs.filter(r => r.error)) console.log(`  ${r.stage}: ${r.atom}: ${r.error}`)
  for (const r of wrong) console.log(`  differs: ${r.atom}: error ${r.snr} dB below the signal peak`)
  const fam = {}
  for (const r of ok) if (r.speed) (fam[r.atom.split('/')[0]] ??= []).push(r)
  console.log()
  table(['family', 'atoms', 'speed (geomean)', 'slowest', 'fastest'], Object.entries(fam).map(([f, a]) => {
    const s = a.slice().sort((x, y) => x.speed - y.speed), name = r => `${r.atom.split(':')[1]} ${r.speed}×`
    return [f, a.length, geo(a.map(r => r.speed)).toFixed(2) + '×', name(s[0]), name(s.at(-1))]
  }))
}

const args = process.argv.slice(2)
if (args[0] === '--one') await one(...args.slice(1))
else { await all(args); process.exit(0) }
