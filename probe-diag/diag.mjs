// probe-diag/diag.mjs: time prebuilt jz variants beside c-wasm in alternating fresh
// processes on this machine, then dump V8's machine code for the hot functions.
import { execFileSync } from 'node:child_process'
import { readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const DIR = 'probe-diag', OUT = process.env.DIAG_OUT || join(DIR, 'out')
mkdirSync(OUT, { recursive: true })
const rounds = +(process.env.DIAG_ROUNDS || 8)
const cases = (process.env.DIAG_CASES || 'hsl,hwb,quatmul').split(',')
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }
const run = argv => execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 1 << 28 })
const host = 'bench/_lib/run-jz-host.mjs', wasi = 'bench/_lib/run-wasi.mjs'
const log = []
const say = s => { console.log(s); log.push(s) }
say(run(['sh', '-c', 'grep -m1 "model name" /proc/cpuinfo; node --version']).trim())
for (const id of cases) {
  const cw = join(OUT, `${id}.c.wasm`)
  execFileSync('zig', ['cc', '-target', 'wasm32-wasi', '-msimd128', '-O3', '-ffp-contract=off', '-o', cw, `bench/${id}/${id}.c`], { stdio: 'inherit' })
  const lanes = [{ label: 'c-wasm', argv: ['node', '--no-warnings', wasi, cw] }]
  for (const f of readdirSync(DIR).filter(f => f.startsWith(id + '-') && f.endsWith('.wasm')).sort())
    lanes.push({ label: f.slice(id.length + 1, -5), argv: ['node', host, join(DIR, f)] })
  for (const flags of (process.env[`DIAG_FLAGS_${id}`] || '').split(';').filter(Boolean)) {
    lanes.push({ label: `V0 ${flags}`, argv: ['node', ...flags.split(' '), host, join(DIR, `${id}-V0.wasm`)] })
    lanes.push({ label: `c-wasm ${flags}`, argv: ['node', ...flags.split(' '), '--no-warnings', wasi, cw] })
  }
  for (const l of lanes) l.t = []
  for (let r = 0; r < rounds; r++)
    for (const l of r % 2 ? [...lanes].reverse() : lanes) l.t.push(+run(l.argv).match(/median_us=([\d.]+)/)[1])
  say(`# ${id}: ${rounds} alternating rounds, ratio = per-round lane/c-wasm median`)
  for (const l of lanes) say(`${id} ${l.label.padEnd(28)} med ${String(med(l.t)).padStart(8)} us  /c-wasm ${med(l.t.map((t, i) => t / lanes[0].t[i])).toFixed(3)}  [${l.t.join(' ')}]`)
  // machine code of every lane's top tier
  for (const l of lanes.slice(0, 2)) {
    const file = join(OUT, `${id}-${l.label.replace(/\W+/g, '_')}.code.txt`)
    const argv = [l.argv[0], '--no-liftoff', '--print-wasm-code', '--code-comments', ...l.argv.slice(1)]
    try { writeFileSync(file, run(argv)) } catch (e) { writeFileSync(file, String(e.stdout || e)) }
  }
  for (const f of readdirSync(DIR).filter(f => f.startsWith(id + '-') && f.endsWith('.wasm'))) {
    const file = join(OUT, `${id}-${f.slice(id.length + 1, -5)}.code.txt`)
    if (existsSync(file)) continue
    try { writeFileSync(file, run(['node', '--no-liftoff', '--print-wasm-code', host, join(DIR, f)])) } catch (e) { writeFileSync(file, String(e.stdout || e)) }
  }
}
// per-sample times in one process (tier-up), jz's host lane
for (const id of cases) {
  for (const flags of [[], ['--no-liftoff']]) for (let k = 0; k < 3; k++) {
    try { say(`${id} trace ${flags.join(' ') || '(default)'}: ` + execFileSync('node', [...flags, '--trace-wasm-compilation-times', join(DIR, 'trace.mjs'), join(DIR, `${id}-V0.wasm`)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(l => /TurboFan|samples_us/.test(l)).map(l => l.replace(/Compiled function \S+/, '').replace(/max\/total bytes.*/, '')).join(' | ')) } catch (e) { say(`${id} trace failed ${e}`) }
  }
}
writeFileSync(join(OUT, 'diag.log'), log.join('\n') + '\n')
