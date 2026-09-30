// The vendored pmndrs/math workloads are fixed inputs. Correctness is always
// gated, including state carried between calls. JZ_MATH_PIN=1 additionally
// requires a per-case V8 win; run that on a quiet machine before release.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { join } from 'node:path'
import { instantiate } from '../interop.js'
import { compileJzAt } from '../bench/_lib/compile.js'

const ROOT = join(import.meta.dirname, '..')
const PIN = process.env.JZ_MATH_PIN === '1'
const CASES = { quatmul: 3862405384, fabrik: 2711562489, polytri: 84696351, worley: 4117862664 }
const median = xs => xs.toSorted((a, b) => a - b)[xs.length >> 1]

for (const [id, checksum] of Object.entries(CASES)) test(`pmath: ${id} agrees with Node across repeated calls`, async () => {
  const entry = join(ROOT, 'bench', id, `${id}.js`)
  const bytes = compileJzAt({ id, js: entry }, { level: 'speed' })
  let wa, js
  const { exports: wasm } = instantiate(bytes, { imports: {
    env: { logResult: (us, sum, samples, stages, runs) => { wa = [us, sum >>> 0, samples, stages, runs] } },
    performance: { now: () => performance.now() },
  } })
  const node = await import(entry)
  const runJS = () => {
    const log = console.log
    console.log = line => {
      const m = /^median_us=(\d+) checksum=(\d+) samples=(\d+) stages=(\d+) runs=(\d+)$/.exec(line)
      if (!m) throw Error(`unexpected bench output: ${line}`)
      js = m.slice(1).map(Number)
    }
    try { node.main() } finally { console.log = log }
  }
  const ratios = []
  for (let round = 0; round < 3; round++) {
    wa = js = null
    if (round & 1) { wasm.main(); runJS() }
    else { runJS(); wasm.main() }
    ok(wa && js, `round ${round}: both targets reported`)
    if (!wa || !js) continue
    if (!round) is(js[1], checksum, 'fixed workload checksum')
    is(wa.slice(1), js.slice(1), `round ${round}: checksum and workload agree`)
    ok(wa[0] > 0 && js[0] > 0, 'both medians are measured')
    ratios.push(wa[0] / js[0])
  }
  const ratio = median(ratios)
  console.log(`  ${id}: jz/V8 ${ratio.toFixed(3)}× (${PIN ? 'strict speed gate' : 'diagnostic; speed claim pending'})`)
  if (PIN) ok(ratio < 1, `${id}: jz/V8 ${ratio.toFixed(3)}× must be < 1`)
})
