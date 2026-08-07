// machineState() — audit-#13 evidence-validity metadata (.work/todo.md
// §deletion-sweep hygiene item 2b). The WARM/MEMORY-FLOOR false-red campaign
// (.work/todo.md's "WARM + MEMORY-FLOOR reds RESOLVED as ENVIRONMENT" status,
// 2026-08-06) found LIVE that timing evidence recorded under swap pressure
// reads as a code regression until someone manually correlates it with
// `vm.swapusage` — captured into every timing write's meta.machineState so
// that correlation is automatic instead of an after-the-fact excavation, and
// checked by test/bench-claims.js's VALIDITY gate against a sane bound.
//
// Shared between bench/bench.mjs (the writer) and test/bench-claims.js (the
// gate, which probes the LIVE machine directly rather than trusting only the
// committed snapshot) — one probe, two consumers, no duplicated parsing.
//
// Best-effort: any probe that fails (non-darwin, missing binary) reports
// null for that field rather than throwing — this is validity CONTEXT, not
// a hard requirement by itself.
import { execFileSync } from 'node:child_process'
import { loadavg, uptime } from 'node:os'

export const machineState = () => {
  const swapUsedMB = (() => {
    if (process.platform !== 'darwin') return null
    try {
      const out = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' })
      const m = out.match(/used\s*=\s*([\d.]+)M/)
      return m ? +m[1] : null
    } catch { return null }
  })()
  const load1 = (() => {
    try { return +loadavg()[0].toFixed(2) } catch { return null }
  })()
  const uptimeDays = (() => {
    try { return +(uptime() / 86400).toFixed(2) } catch { return null }
  })()
  const powermode = (() => {
    if (process.platform !== 'darwin') return null
    try {
      const g = execFileSync('pmset', ['-g'], { encoding: 'utf8' })
      const low = /^\s*lowpowermode\s+1/m.test(g)
      const src = execFileSync('pmset', ['-g', 'ps'], { encoding: 'utf8' }).split('\n')[0] || ''
      const onAC = /AC Power/.test(src)
      return `${onAC ? 'AC' : 'Battery'}${low ? '+low-power-mode' : ''}`
    } catch { return null }
  })()
  return { swapUsedMB, uptimeDays, load1, powermode }
}
