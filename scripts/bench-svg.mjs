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
// The chart is a function of a dataset: `node scripts/bench-svg.mjs [dataset]`
// (default bench/results.json) draws it from the committed evidence and refuses a
// dataset that leaves a lane without evidence; `bench/bench.mjs` draws it at the end
// of a complete live run from what it just measured. Either way the rows come from
// svgRows, so the chart reproduces its dataset.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LAB, timedBenchmarkRow } from '../assets/headline.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SVG_PATH = join(ROOT, 'bench', 'bench.svg')
export const RESULTS_PATH = join(ROOT, 'bench', 'results.json')

// The engines in the chart, the corpus headline: jz vs the WASM field (Rust/Go/C/Zig
// compiled to wasm, AssemblyScript, MoonBit: all run in V8, apples-to-apples with jz),
// V8 (plain JS), and the native AOT compilers of JS (Porffor, scriptc, Perry). native
// C is the lone reference row, a labeled speed-of-light ceiling, never a beat-claim.
// The per-case page labels each substrate and includes jz-w2c (jz → wasm2c → clang)
// as the peer for native toolchains.
export const SVG_TARGETS = [
  { id: 'jz', label: 'JZ', sub: '-O3' },
  { id: 'c-wasm', label: 'C', sub: 'clang → wasm' },
  { id: 'rust-wasm', label: 'Rust', sub: 'rustc → wasm' },
  { id: 'go-wasm', label: 'Go', sub: 'gc → wasm' },
  { id: 'zig-wasm', label: 'Zig', sub: 'zig → wasm' },
  { id: 'moonbit', label: 'MoonBit', sub: 'moonrun → wasm' },
  { id: 'as', label: 'AssemblyScript', sub: 'asc -O3' },
  { id: 'porf-native', label: 'Porffor', sub: 'JS → C, AOT' },
  { id: 'scriptc', label: 'scriptc', sub: 'JS → LLVM, AOT' },
  { id: 'perry', label: 'Perry', sub: 'JS → LLVM, AOT' },
  { id: 'v8', label: 'V8', sub: 'Node (JS)' },
  { id: 'nat', label: 'native C', sub: 'clang -O3, ref' },
]
// The native compilers of JS run a part of the corpus: their row names its coverage.
const COVERAGE = new Set(['porf-native', 'scriptc', 'perry'])

/** The chart rows of a dataset's cases ({ id: { targets } }): per lane, the geometric
 *  mean of lane ÷ JZ median over the non-lab cases where both have a timed row with an
 *  accepted checksum (lower = faster; JZ = 1.00×). `cases` = the non-lab cases, the
 *  caption's N and the coverage denominator. A lane with no such case has no row. */
export function svgRows(cases) {
  const ids = Object.keys(cases).filter(id => !LAB.has(id))
  const rows = []
  for (const t of SVG_TARGETS) {
    const logs = ids.flatMap(id => {
      const r = cases[id].targets ?? {}
      return timedBenchmarkRow(r.jz) && timedBenchmarkRow(r[t.id]) ? [Math.log(r[t.id].medianUs / r.jz.medianUs)] : []
    })
    // At the 2 decimals the chart prints, so the drawing reproduces from its numbers.
    if (logs.length) rows.push({ label: t.label, sub: COVERAGE.has(t.id) ? `native, runs ${logs.length} / ${ids.length}` : t.sub,
      ratio: +Math.exp(logs.reduce((s, x) => s + x, 0) / logs.length).toFixed(2) })
  }
  return { rows, cases: ids.length }
}

let committed
/** The chart of the committed reference dataset, bench/results.json. */
export const committedRows = () => committed ??= svgRows(JSON.parse(readFileSync(RESULTS_PATH, 'utf8')).cases)

// native C (clang -O3, native binary) is the speed-of-light reference. Porffor
// remains a measured native competitor rather than a REFERENCE fallback.
// Native C is always drawn: a live run on a box without clang takes its row from
// the committed dataset. Rust/Go/C race here as wasm rivals (wasm32-wasi, run in V8),
// not as the reference. Per case, jz-w2c supplies the peer row for native toolchains.
// This corpus headline keeps native C as the ceiling; see bench/index.html.
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
  const scope = `Wasm rivals run in V8; Porffor, scriptc, Perry and native C run natively`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="color-scheme:light dark" role="img" aria-label="JZ benchmark: ${scope}; ${caption}">
${rows.map(lane).join('')}
  <text x="${W / 2}" y="${H - 34}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${INK}" fill-opacity="${O.scope}">${scope}</text>
  <text x="${W / 2}" y="${H - 16}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${INK}" fill-opacity="${O.cap}">${caption}</text>
</svg>
`
}

/** Write bench/bench.svg from `rows`; `cases` = the case count for the caption. */
export function renderBenchSvg(rows, cases) {
  const sorted = withReference(rows).sort((a, b) => a.ratio - b.ratio)
  writeFileSync(SVG_PATH, benchSvg(sorted, cases))
  return SVG_PATH
}

/** Guarantee the native C reference row is present: a run that lacked clang
 *  drops it, so fall back to the committed dataset's ratio.
 *  Measured rows win; the fallback only fills genuine gaps. */
export function withReference(rows) {
  const have = new Set(rows.map(r => r.label))
  return [...rows, ...committedRows().rows.filter(r => REFERENCE.has(r.label) && !have.has(r.label))]
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const path = process.argv[2] || RESULTS_PATH
  const { rows, cases } = svgRows(JSON.parse(readFileSync(path, 'utf8')).cases)
  const absent = SVG_TARGETS.filter(t => !rows.some(r => r.label === t.label)).map(t => t.id)
  if (absent.length) {
    console.error(`${path}: no timed, checksum-accepted rows beside JZ for ${absent.join(', ')}; the chart would drop them. Not written.`)
    process.exit(1)
  }
  renderBenchSvg(rows, cases)
  console.log(`wrote ${SVG_PATH} from ${path}: ${rows.map(r => `${r.label} ${r.ratio.toFixed(2)}×`).join('  ')}`)
}
