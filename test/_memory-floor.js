import { correctBenchmarkRow } from '../assets/headline.js'

// Allocation-heavy release controls, measured with the same Node host.
export const MEMORY_CASES = ['jessie', 'watr', 'webaudio']

export function memoryFloor(cases) {
  const missing = [], losses = [], rows = []
  for (const name of MEMORY_CASES) {
    const pair = ['jz', 'v8'].map(target => cases?.[name]?.targets?.[target])
    const valid = pair.every(row => correctBenchmarkRow(row) && Number.isFinite(row.memKb) && row.memKb > 0)
    if (!valid) { missing.push(name); continue }
    const [jz, v8] = pair.map(row => row.memKb)
    rows.push([name, jz, v8])
    if (jz > v8) losses.push([name, jz / v8])
  }
  return { missing, losses, rows }
}
