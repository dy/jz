// bench.svg renderer contract — the README's headline performance chart.
// Pure string assertions, no toolchain, so it runs in the default `npm test`.
// Guards the two ways the chart used to mislead (.work/todo.md): a bare ratio
// with no "geomean of N cases" caption, and jz labeled "→ wasm" (a pipeline)
// while every rival showed its optimization tier (clang/rustc/asc -O3).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { benchSvg, SNAPSHOT, SNAPSHOT_N } from '../scripts/bench-svg.mjs'

const rows = [{ label: 'jz', sub: '-O3', ratio: 1 }, { label: 'V8', sub: 'Node', ratio: 2.45 }]

test('bench-svg: caption names the geomean and its case count', () => {
  const svg = benchSvg(rows, 12)
  ok(/geometric mean across 12 benchmark cases/.test(svg), 'caption must state geomean + N cases')
  ok(svg.includes('lower is faster'), 'caption must state the direction')
})

test('bench-svg: missing count degrades to corpus wording, never "undefined"', () => {
  const svg = benchSvg(rows, null)
  ok(/geometric mean across the bench corpus/.test(svg), 'null N → corpus wording')
  ok(!svg.includes('undefined'), 'no undefined leaks into the caption')
})

test('bench-svg: jz is labeled by optimization tier, not a pipeline', () => {
  const svg = benchSvg(rows, 12)
  ok(svg.includes('>-O3<'), 'jz sub-label is -O3 (parallel to clang/rustc/asc -O3)')
  ok(!/wasm/i.test(svg), 'no "→ wasm" pipeline label — it broke the O3-vs-O3 read')
  is(SNAPSHOT.find(r => r.label === 'jz').sub, '-O3')
})

test('bench-svg: snapshot render is internally consistent (caption N = Porffor denominator)', () => {
  // The crux of the fix — a reader must never see "12 cases" above a row reading
  // "runs 4 / 13". SNAPSHOT_N drives both the caption and the Porffor denominator,
  // so they can't disagree; the live bench.mjs path derives both from geoCases too.
  const svg = benchSvg([...SNAPSHOT].sort((a, b) => a.ratio - b.ratio), SNAPSHOT_N)
  const capN = svg.match(/across (\d+) benchmark cases/)?.[1]
  const porfDenom = svg.match(/runs \d+ \/ (\d+)/)?.[1]
  is(capN, String(SNAPSHOT_N), 'caption N = SNAPSHOT_N')
  is(porfDenom, String(SNAPSHOT_N), 'Porffor denominator = SNAPSHOT_N')
  is(capN, porfDenom, 'caption N and Porffor denominator must agree')
})
