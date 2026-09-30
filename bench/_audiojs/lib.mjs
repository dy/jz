// Shared pieces of the audiojs lab: the compiler under test, the sibling checkouts,
// building an entry with its import graph, interleaved timing, the bench signal.
//
//   JZ_ROOT       compiler checkout to measure (default: this repo)
//   JZ_OPT        optimize level: speed | size | 0 (default: jz's own default, level 2)
//   AUDIO_ROOT    audiojs/audio checkout   (default: ../audio beside this repo)
//   AUDIO_FAMILY  @audio family checkouts  (default: ../@audio beside this repo)

import { mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '../..')
export const JZ_ROOT = resolve(process.env.JZ_ROOT || REPO)
export const AUDIO = resolve(process.env.AUDIO_ROOT || join(REPO, '../audio'))
export const FAMILY = resolve(process.env.AUDIO_FAMILY || join(REPO, '../@audio'))

for (const [name, dir] of [['AUDIO_ROOT', AUDIO], ['AUDIO_FAMILY', FAMILY]])
  if (!existsSync(dir)) throw new Error(`audiojs lab: ${dir} not found: set ${name}`)

const jzMod = await import(pathToFileURL(join(JZ_ROOT, 'index.js')))
export const { instantiate } = jzMod

/** The optimize level every compile of the lab runs at. */
export const OPT = process.env.JZ_OPT
const level = OPT === undefined ? {} : { optimize: OPT === '0' ? false : OPT }
export const compile = (src, opts = {}) => jzMod.compile(src, { ...level, ...opts })
export const jz = (src, opts = {}) => jzMod.default(src, { ...level, ...opts })
export const { resolveModuleGraph } = await import(pathToFileURL(join(JZ_ROOT, 'src/resolve.js')))

/** A scratch directory whose bare imports resolve like the audio checkout's own; removed at exit. */
const scratchDirs = new Set()
process.once('exit', () => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})
export function scratch(prefix = 'jz-audiojs-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.add(dir)
  symlinkSync(join(AUDIO, 'node_modules'), join(dir, 'node_modules'))
  return dir
}

/** Compile an entry source with its import graph; the same file is importable as plain JS. */
export function build(source, { name = 'entry.js', dir = scratch(), files = {}, ...opts } = {}) {
  for (const [f, src] of Object.entries(files)) writeFileSync(join(dir, f), src)
  const file = join(dir, name)
  writeFileSync(file, source)
  const { code, modules } = resolveModuleGraph(file, { resolveNode: true })
  const warnings = []
  const t = performance.now()
  const wasm = compile(code, { warnings: { entries: warnings }, ...(Object.keys(modules).length && { modules }), ...opts })
  return { file, wasm, warnings, compileMs: performance.now() - t, modules: Object.keys(modules).length }
}

/** Minimum over interleaved samples: on a busy machine it approaches the undisturbed time,
 *  and interleaving keeps drift from favouring one contender. */
export function measure(fns, { rounds = 40, warm = 8, inner = 1, budget = 8000 } = {}) {
  const names = Object.keys(fns), best = Object.fromEntries(names.map(k => [k, Infinity]))
  for (let w = 0; w < warm; w++) for (const k of names) fns[k]()
  const end = performance.now() + budget
  for (let r = 0; r < rounds && performance.now() < end; r++) for (const k of names) {
    const f = fns[k], t = performance.now()
    for (let i = 0; i < inner; i++) f()
    const d = (performance.now() - t) / inner
    if (d < best[k]) best[k] = d
  }
  return best
}

/** The signal audio/bench/fixtures.js writes: tone stack + shaped noise, a 120 bpm pulse on the right. */
export function signal(n, sr = 44100) {
  const L = new Float32Array(n), R = new Float32Array(n)
  let seed = 0x9e3779b9 >>> 0, lp = 0
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1 }
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const tone = 0.25 * Math.sin(2 * Math.PI * 220 * t) + 0.18 * Math.sin(2 * Math.PI * 440 * t) + 0.12 * Math.sin(2 * Math.PI * 880 * t)
    lp = lp * 0.96 + rand() * 0.04
    const noise = lp * 0.5, phase = (t * 2) % 1
    const kick = Math.exp(-phase * 40) * Math.sin(2 * Math.PI * 60 * t) * 0.6
    L[i] = tone + noise
    R[i] = 0.25 * Math.sin(2 * Math.PI * 221 * t) + 0.18 * Math.sin(2 * Math.PI * 442 * t) + noise + kick
  }
  return [L, R]
}

export { bitsEqual, agreement } from './compare.mjs'

export const us = ms => ms >= 1 ? `${ms.toFixed(2)} ms` : `${(ms * 1000).toFixed(0)} µs`
export const ratio = (js, wz) => `${(js / wz).toFixed(2)}×`

/** Print rows as a markdown table. */
export function table(head, rows) {
  console.log(`| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|`)
  for (const r of rows) console.log(`| ${r.join(' | ')} |`)
}

export const commit = async () => {
  const { execFileSync } = await import('node:child_process')
  const git = (dir, ...a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
  const head = git(JZ_ROOT, 'rev-parse', '--short', 'HEAD')
  const dirty = head && git(JZ_ROOT, 'status', '--porcelain', '--', 'src', 'module', 'jzify', 'index.js', 'interop.js')
  return { jz: (head ? head + (dirty ? ' + uncommitted changes' : '') : JZ_ROOT) + `, optimize ${OPT ?? 'default'}`, audio: git(AUDIO, 'rev-parse', '--short', 'HEAD') ?? AUDIO }
}
