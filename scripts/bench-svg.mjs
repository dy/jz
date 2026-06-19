#!/usr/bin/env node
// Renders bench/bench.svg — an animated "speed demo" of the benchmark corpus,
// far more navigable than the big per-case table. Each engine is one lane with
// a single ball that runs back and forth horizontally between a start tick and
// a finish tick; the ball's TRAVERSAL SPEED is the metric — fast engines zip
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
//           per-case table in README.md. native C is the lone non-wasm reference row.
// SNAPSHOT_N = cases behind these geomeans; it drives BOTH the caption and the
// Porffor denominator, so the offline render is internally consistent. The live
// bench.mjs run passes its own current count (geoCases.length) instead.
export const SNAPSHOT_N = 22
export const SNAPSHOT = [
  { label: 'jz', sub: '-O3', ratio: 1.00 },
  { label: 'native C', sub: 'clang -O3 · ref', ratio: 1.07 },
  { label: 'C', sub: 'zig cc → wasm', ratio: 2.43 },
  { label: 'Rust', sub: 'rustc → wasm', ratio: 2.63 },
  { label: 'V8', sub: 'Node (JS)', ratio: 2.69 },
  { label: 'AssemblyScript', sub: 'asc -O3', ratio: 2.80 },
  { label: 'Porffor', sub: `runs 3 / ${SNAPSHOT_N}`, ratio: 3.49 },
  { label: 'Go', sub: 'gc → wasm', ratio: 4.91 },
]

// native C (clang -O3, native binary) — the lone speed-of-light reference, the only
// non-wasm row on the chart. Always drawn: on a box without clang its committed SNAPSHOT
// ratio stands in (a stable ceiling, not a same-run measurement). Rust/Go/C race here as
// wasm rivals (compiled to wasm32-wasi, run in V8) — competitors, not the reference.
export const REFERENCE = new Set(['native C'])

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
const HERO = '#000000'   // jz — black accent (B&W identity)
const GRAY = '#adb5bd'   // every other ball — minimal, one accent

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
    const isJz = r.label === 'jz'
    const color = isJz ? HERO : GRAY   // jz black, every other ball gray (native C/Rust included — labels carry the "native" cue)
    const dur = period(r.ratio)
    const bx0 = (trackX + ballR).toFixed(1)
    const bx1 = (trackRight - ballR).toFixed(1)
    const tickT = cy - 7, tickB = cy + 7
    const fw = isJz ? 700 : 500

    return `
  <g font-family="${FONT}">
    <rect x="${trackX}" y="${cy - 1.5}" width="${trackRight - trackX}" height="3" rx="1.5" fill="#edf0f2"/>
    <line x1="${trackX}" y1="${tickT}" x2="${trackX}" y2="${tickB}" stroke="#ced4da" stroke-width="2"/>
    <line x1="${trackRight}" y1="${tickT}" x2="${trackRight}" y2="${tickB}" stroke="#ced4da" stroke-width="2"/>
    <text x="${labelW}" y="${cy - 4}" text-anchor="end" font-size="14" font-weight="${fw}" fill="${isJz ? HERO : '#343a40'}">${r.label}</text>
    ${r.sub ? `<text x="${labelW}" y="${cy + 11}" text-anchor="end" font-size="10" fill="#aeb4ba">${r.sub}</text>` : ''}
    <text x="${trackRight + 12}" y="${cy + 4}" font-size="13" font-weight="${fw}" fill="${isJz ? HERO : '#868e96'}">${fmt(r.ratio)}×</text>
    <circle cx="${bx0}" cy="${cy}" r="${ballR}" fill="${color}">
      <animate attributeName="cx" dur="${dur}s" repeatCount="indefinite" calcMode="linear"
        keyTimes="0;0.5;1" values="${bx0};${bx1};${bx0}" begin="-${phase(i).toFixed(2)}s"/>
    </circle>
  </g>`
  }

  const caption = `geometric mean across ${cases ? `${cases} benchmark cases` : 'the bench corpus'} · lower is faster, jz = 1.00× baseline`
  const scope = `every rival compiled to WebAssembly, run in V8 · native C = reference`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="jz benchmark — ${scope}; ${caption}; each ball's speed is proportional to that engine's geometric-mean runtime across the corpus">
  <rect width="${W}" height="${H}" rx="12" fill="#ffffff"/>
${rows.map(lane).join('')}
  <text x="${W / 2}" y="${H - 34}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#495057">${scope}</text>
  <text x="${W / 2}" y="${H - 16}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#868e96">${caption}</text>
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
 *  Measured rows win — the fallback only fills genuine gaps. */
export function withReference(rows) {
  const have = new Set(rows.map(r => r.label))
  return [...rows, ...SNAPSHOT.filter(r => REFERENCE.has(r.label) && !have.has(r.label))]
}

if (import.meta.url === `file://${process.argv[1]}`) {
  renderBenchSvg()
  console.log('wrote', SVG_PATH)
}
