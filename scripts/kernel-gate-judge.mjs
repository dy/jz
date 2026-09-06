// The kernel gate's verdicts as pure functions (scripts/kernel-gate.mjs applies
// them; test/kernel-gate.js drives them on synthetic reports, so a false green
// is caught without an unloaded machine or a slow build).

export const STATUSES = new Set(['green', 'red', 'incomplete'])
const finite = (v) => v == null || (typeof v === 'number' && Number.isFinite(v))
const METRICS = ['ms', 'heap', 'memoryBytes', 'phasesDone', 'bytes', 'ratio', 'baselineMs', 'candidateMs']

/** A gate's status from its cases: any red is red, else any incomplete is incomplete. */
export const deriveStatus = (cases) => cases.some(c => c.status === 'red') ? 'red' : cases.some(c => c.status === 'incomplete') ? 'incomplete' : 'green'

/**
 * Why a worker report cannot be trusted, or null. `expected` names every case the gate
 * must report (null for a gate whose case set is not fixed); a report missing one,
 * naming one twice or an unknown one, carrying a non-finite metric, or claiming a
 * status its cases contradict is malformed.
 */
export function validateReport(gate, report, expected) {
  if (!report || typeof report !== 'object' || report.gate !== gate || !Array.isArray(report.cases) || !STATUSES.has(report.status)) return 'not a gate report'
  if (!finite(report.peakRssMiB)) return 'non-finite peak'
  const names = report.cases.map(c => c?.name)
  if (names.some(n => typeof n !== 'string') || new Set(names).size !== names.length) return 'a case without a name, or named twice'
  for (const c of report.cases) {
    if (!STATUSES.has(c.status)) return `case ${c.name}: status ${JSON.stringify(c.status)}`
    for (const key of METRICS) if (!finite(c[key])) return `case ${c.name}: ${key} is not finite`
  }
  if (expected) {
    const missing = expected.filter(n => !names.includes(n)), extra = names.filter(n => !expected.includes(n))
    if (missing.length || extra.length) return `cases ${missing.length ? 'missing: ' + missing.join(', ') : ''}${extra.length ? ' unexpected: ' + extra.join(', ') : ''}`.trim()
  }
  const derived = deriveStatus(report.cases)
  if (report.status !== derived) return `status ${report.status} contradicts its cases (${derived})`
  return null
}

/** Timing medians (the mean of the two middle samples for an even count). */
export const median = (xs) => { const s = [...xs].sort((x, y) => x - y); return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 }

/**
 * One speed case: incomplete unless the load stayed under the limit before and
 * after; red past the tolerance; the ratio and both medians recorded.
 */
export function judgeSpeed({ baseline, candidate, tolerance, loadBefore, loadAfter, loadLimit }) {
  const c = { baselineMs: +median(baseline).toFixed(2), candidateMs: +median(candidate).toFixed(2), samples: baseline.length, loadBefore, loadAfter, loadLimit }
  c.ratio = +(median(candidate) / median(baseline)).toFixed(3)
  if (!(loadBefore < loadLimit) || !(loadAfter < loadLimit)) { c.status = 'incomplete'; c.why = `1-minute load ${Math.max(loadBefore, loadAfter)} around the case, limit ${loadLimit}` }
  else if (!Number.isFinite(c.ratio)) { c.status = 'incomplete'; c.why = 'no finite ratio' }
  else if (c.ratio > 1 + tolerance) { c.status = 'red'; c.why = `${c.ratio}x slower than the baseline, tolerance ${tolerance}` }
  else c.status = 'green'
  return c
}

/**
 * The memory verdict against a baseline manifest: the baseline's complete row set
 * must be present, compatible (corpus, levels, profile) and compiled to completion
 * on both sides; heap cursor, memory size and per-gate peak are judged separately.
 */
export function judgeMemory({ rows, peaks, baseline, size, levels, profile, tolerance }) {
  const mem = { status: 'incomplete', rows, peakRssMiB: peaks, tolerance }
  if (!rows.length) { mem.why = 'no gate with heap figures ran'; return mem }
  if (!baseline) { mem.why = 'no --baseline manifest: figures recorded, nothing judged'; return mem }
  const baseRows = baseline.gates?.memory?.rows
  if (!Array.isArray(baseRows) || !baseRows.length) { mem.why = 'the baseline manifest has no memory rows'; return mem }
  const key = r => `${r.gate}/${r.name}/${r.level}`
  const mine = new Map(rows.map(r => [key(r), r]))
  const compat = baseline.corpus === size && JSON.stringify(baseline.levels) === JSON.stringify(levels) && JSON.stringify(baseline.runnerProvenance?.profile) === JSON.stringify(profile)
  mem.unmatched = baseRows.filter(b => !mine.has(key(b))).map(key)
  mem.notCompleted = baseRows.filter(b => mine.has(key(b)) && !(b.completed && mine.get(key(b)).completed)).map(key)
  const compared = baseRows.filter(b => mine.has(key(b)) && b.completed && mine.get(key(b)).completed)
  mem.compared = compared.length
  const over = []
  for (const b of compared) { const m = mine.get(key(b)); for (const metric of ['heap', 'memoryBytes']) if (m[metric] > b[metric] * (1 + tolerance)) over.push({ case: key(b), metric, baseline: b[metric], current: m[metric] }) }
  for (const [g, p] of Object.entries(peaks)) { const bp = baseline.gates?.memory?.peakRssMiB?.[g]; if (p != null && bp != null && p > bp * (1 + tolerance)) over.push({ case: g, metric: 'peakRssMiB', baseline: bp, current: p }) }
  mem.over = over
  if (!compat) mem.why = 'the baseline was measured on another corpus, level set or build profile'
  else if (mem.unmatched.length || mem.notCompleted.length) mem.why = `${mem.unmatched.length} baseline cases absent from this run, ${mem.notCompleted.length} not compiled to completion on both sides: no complete comparison`
  else mem.status = over.length ? 'red' : 'green'
  return mem
}
