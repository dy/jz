#!/usr/bin/env node
// Renders bench/bench.svg: an animated "speed demo" of the benchmark corpus,
// far more navigable than the big per-case table. Each engine is one lane with
// a single ball that runs back and forth horizontally between a start tick and
// a finish tick; the ball's TRAVERSAL SPEED is the metric. Fast engines zip
// across, slow ones crawl. Driven by the per-engine GEOMEAN of median runtimes
// across the corpus (one honest number per engine), printed as the "N×" label
// so the chart still reads when the animation is frozen.
//
// GitHub renders SMIL-animated SVG embedded via <img>, so the balls animate in
// the README; the labels + "N×" numbers carry the meaning when frozen.
//
// `bench/bench.mjs` calls renderBenchSvg() at the end of a full run with freshly
// measured geomeans; `node scripts/bench-svg.mjs` (no args) regenerates from the
// last committed snapshot so the artifact never goes stale between full runs.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SVG_PATH = join(ROOT, 'bench', 'bench.svg')

// Last measured snapshot (Apple Silicon, arm64). bench.mjs overwrites bench.svg
// on a full run; this is the offline fallback so the artifact regenerates
// deterministically between runs.
//   ratio = geomean(engine median / jz median) over the cases the engine ran
//           (lower = faster; jz is the 1.00× baseline). These reproduce from the
//           committed results. The wasm rivals are the apples-to-apples field;
//           native C is the speed-of-light reference and Porffor is the native
//           AOT floor requested by the product contract.
// SNAPSHOT_N = cases behind these geomeans; it drives BOTH the caption and the
// Porffor denominator, so the offline render is internally consistent. The live
// bench.mjs run passes its own current count (geoCases.length) instead.
export const SNAPSHOT_N = 52
export const SNAPSHOT = [
  { label: 'JZ', sub: '-O3', ratio: 1.00 },
  { label: 'native C', sub: 'clang -O3, ref', ratio: 0.96 },
  { label: 'C', sub: 'clang → wasm', ratio: 1.88 },
  { label: 'Rust', sub: 'rustc → wasm', ratio: 1.97 },
  { label: 'AssemblyScript', sub: 'asc -O3', ratio: 2.05 },
  { label: 'Zig', sub: 'zig → wasm', ratio: 2.13 },
  { label: 'V8', sub: 'Node (JS)', ratio: 2.16 },
  { label: 'MoonBit', sub: 'moonrun → wasm', ratio: 4.13 },
  { label: 'Go', sub: 'gc → wasm', ratio: 4.36 },
  { label: 'Porffor', sub: `native, runs 43 / ${SNAPSHOT_N}`, ratio: 21.72 },
]

// native C (clang -O3, native binary) is the speed-of-light reference. Porffor
// remains a measured native competitor rather than a REFERENCE fallback.
// Native C is always drawn: on a box without clang its committed SNAPSHOT ratio
// stands in. Rust/Go/C race here as wasm rivals (wasm32-wasi, run in V8), not as
// the reference. Per case, jz-w2c supplies the peer row for native toolchains.
// This corpus headline keeps native C as the ceiling; see
// bench/index.html.
export const REFERENCE = new Set(['native C'])

/** Complete nonempty selection plus one positive finite row per measured lane. */
export function completeBenchSvgRun(targets, selectedTargets, cases, selectedCases, rows) {
  if (!targets.length || !cases.length ||
      !targets.every(t => selectedTargets.includes(t.id)) ||
      !cases.every(id => selectedCases.includes(id))) return false
  if (rows == null) return true
  return targets.every(target => {
    const row = rows.find(candidate => candidate.label === target.label)
    return row ? row.ratio > 0 && Number.isFinite(row.ratio) : REFERENCE.has(target.label)
  })
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
// Transparent chart that blends into either theme: every mark is `currentColor`, so it
// inherits the host's text colour. The landing inlines it (→ follows the light/dark
// toggle), and standalone/README falls back to the system text colour via `color-scheme`.
// Opacity tiers replace the old fixed-gray hierarchy (jz = full ink, the one accent).
const INK = 'currentColor'
const O = { ball: 0.4, label: 0.82, sub: 0.46, num: 0.6, track: 0.1, tick: 0.3, scope: 0.72, cap: 0.5 }

/** Build the animated SVG string from rows `[{ label, sub?, ratio }]`.
 *  `cases` (optional) = number of bench cases behind each geomean, for the caption. */
export function benchSvg(rows, cases) {
  const W = 720, rowH = 50, top = 20, bottom = 54
  const H = top + rows.length * rowH + bottom

  const labelW = 156, numW = 54, pad = 16
  const trackX = labelW + 18
  const trackRight = W - numW - pad
  const ballR = 8

  const fmt = n => n.toFixed(2)
  // full left→right→left period ∝ ratio (slower engine → slower ball), clamped so
  // the fastest isn't a blur and the slowest still moves rather than looking stuck.
  const period = ratio => Math.min(10, Math.max(0.85, ratio * 1.6))
  const phase = i => i * 0.41   // deterministic per-lane desync (index-only)

  const lane = (r, i) => {
    const cy = top + i * rowH + rowH / 2
    const isJz = r.label === 'JZ'
    const ballO = isJz ? 1 : O.ball   // jz at full ink; every other ball is dimmed and labeled by substrate
    const dur = period(r.ratio)
    const bx0 = (trackX + ballR).toFixed(1)
    const bx1 = (trackRight - ballR).toFixed(1)
    const tickT = cy - 7, tickB = cy + 7
    const fw = isJz ? 700 : 500

    return `
  <g font-family="${FONT}">
    <rect x="${trackX}" y="${cy - 1.5}" width="${trackRight - trackX}" height="3" rx="1.5" fill="${INK}" fill-opacity="${O.track}"/>
    <line x1="${trackX}" y1="${tickT}" x2="${trackX}" y2="${tickB}" stroke="${INK}" stroke-opacity="${O.tick}" stroke-width="2"/>
    <line x1="${trackRight}" y1="${tickT}" x2="${trackRight}" y2="${tickB}" stroke="${INK}" stroke-opacity="${O.tick}" stroke-width="2"/>
    <text x="${labelW}" y="${cy - 4}" text-anchor="end" font-size="14" font-weight="${fw}" fill="${INK}" fill-opacity="${isJz ? 1 : O.label}">${r.label}</text>
    ${r.sub ? `<text x="${labelW}" y="${cy + 11}" text-anchor="end" font-size="10" fill="${INK}" fill-opacity="${O.sub}">${r.sub}</text>` : ''}
    <text x="${trackRight + 12}" y="${cy + 4}" font-size="13" font-weight="${fw}" fill="${INK}" fill-opacity="${isJz ? 1 : O.num}">${fmt(r.ratio)}×</text>
    <circle cx="${bx0}" cy="${cy}" r="${ballR}" fill="${INK}" fill-opacity="${ballO}">
      <animate attributeName="cx" dur="${dur}s" repeatCount="indefinite" calcMode="linear"
        keyTimes="0;0.5;1" values="${bx0};${bx1};${bx0}" begin="-${phase(i).toFixed(2)}s"/>
    </circle>
  </g>`
  }

  const caption = `geometric mean on the ${cases ? `${cases}-case benchmark corpus` : 'benchmark corpus'}; lower is faster, JZ = 1.00× baseline`
  const scope = `Wasm rivals run in V8; Porffor and native C are native targets`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="color-scheme:light dark" role="img" aria-label="JZ benchmark: ${scope}; ${caption}; each ball's speed is proportional to that engine's geometric-mean runtime across the corpus">
${rows.map(lane).join('')}
  <text x="${W / 2}" y="${H - 34}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${INK}" fill-opacity="${O.scope}">${scope}</text>
  <text x="${W / 2}" y="${H - 16}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${INK}" fill-opacity="${O.cap}">${caption}</text>
</svg>
`
}

/** Write bench/bench.svg from `rows` (defaults to the committed snapshot).
 *  `cases` = case count for the caption; defaults to the snapshot's own count. */
export function renderBenchSvg(rows = SNAPSHOT, cases = SNAPSHOT_N) {
  const sorted = withReference(rows).sort((a, b) => a.ratio - b.ratio)
  writeFileSync(SVG_PATH, benchSvg(sorted, cases))
  return SVG_PATH
}

/** Guarantee the native C reference row is present: a run that lacked clang
 *  drops it, so fall back to the committed SNAPSHOT ratio.
 *  Measured rows win; the fallback only fills genuine gaps. */
export function withReference(rows) {
  const have = new Set(rows.map(r => r.label))
  return [...rows, ...SNAPSHOT.filter(r => REFERENCE.has(r.label) && !have.has(r.label))]
}

if (import.meta.url === `file://${process.argv[1]}`) {
  renderBenchSvg()
  console.log('wrote', SVG_PATH)
}
