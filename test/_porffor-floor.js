import { correctBenchmarkRow, timedBenchmarkRow } from '../assets/headline.js'

// The Porffor the bench's `porf-native` lane measures: release alpha 4, the
// binary porffor.dev/install.sh installs (.github/workflows/bench.yml pins the
// same release). Its version text names the commit by its first seven
// characters; the evidence's `meta.versions.porffor` must carry them. The
// compiler-core adapter (scripts/porffor-core-adapter.mjs) pins its own
// source revision separately: it rewrites Porffor's source and checks its shape.
export const PORFFOR_REV = 'a415d194e74948f0ac32b9d608153ea8720c71fd'
export const PORFFOR_RELEASE = 'alpha 4'
export const porfforEvidenceMatches = version => !!version && version.includes(PORFFOR_REV.slice(0, 7))

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
