import { correctBenchmarkRow, timedBenchmarkRow } from '../assets/headline.js'
import { PORFFOR_COMPAT_REV } from '../scripts/porffor-core-adapter.mjs'

export const PORFFOR_REV = PORFFOR_COMPAT_REV

const positive = value => value > 0 && Number.isFinite(value)
const geomean = rows => rows.length
  ? Math.exp(rows.reduce((sum, [, ratio]) => sum + Math.log(ratio), 0) / rows.length)
  : null

export const porfforFloor = cases => {
  const speed = []
  const size = []
  for (const [name, c] of Object.entries(cases)) {
    const jz = c.targets?.jz
    const porf = c.targets?.['porf-native']
    if (!correctBenchmarkRow(jz) || !correctBenchmarkRow(porf)) continue
    if (timedBenchmarkRow(jz) && timedBenchmarkRow(porf)) speed.push([name, porf.medianUs / jz.medianUs])
    if (positive(jz.bytes) && positive(porf.bytes)) size.push([name, porf.bytes / jz.bytes])
  }
  return {
    speed,
    size,
    speedLosses: speed.filter(([, ratio]) => ratio < 1),
    sizeLosses: size.filter(([, ratio]) => ratio < 1),
    speedGeomean: geomean(speed),
    sizeGeomean: geomean(size),
  }
}
