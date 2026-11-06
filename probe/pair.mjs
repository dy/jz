// usage: node probe/pair.mjs ROUNDS name=path.wasm ...  (.c.wasm/.wasi.wasm/.rust.wasm → wasi runner, else jz host runner); ratios against the first
import { execFileSync } from 'node:child_process'
const R = +process.argv[2]
const lanes = process.argv.slice(3).map(s => s.split('='))
const LIB = process.cwd() + '/bench/_lib/'
const run = p => {
  const wasi = /\.c\.wasm|\.rust\.wasm|wasi/.test(p)
  const out = execFileSync('node', ['--no-warnings', LIB + (wasi ? 'run-wasi.mjs' : 'run-jz-host.mjs'), p], { encoding: 'utf8' })
  const m = /median_us=(\d+) checksum=(\d+)/.exec(out); return [+m[1], m[2]]
}
const res = Object.fromEntries(lanes.map(([k]) => [k, []])), cs = {}
for (let r = 0; r < R; r++) {
  const order = r % 2 ? [...lanes].reverse() : lanes
  for (const [k, p] of order) { const [us, c] = run(p); res[k].push(us); cs[k] = c }
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }
const ref = lanes[0][0]
for (const [k] of lanes) {
  const ratios = res[k].map((v, i) => v / res[ref][i])
  console.log(`${k.padEnd(12)} med ${String(med(res[k])).padStart(6)} µs  ×${ref} med ${med(ratios).toFixed(3)} [${ratios.map(x => x.toFixed(3)).sort().join(' ')}]  cs=${cs[k]}`)
}
