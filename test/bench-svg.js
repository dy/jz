// bench.svg renderer contract — the README's headline performance chart.
// Pure string assertions, no toolchain, so it runs in the default `npm test`.
// Guards the two ways the chart used to mislead (.work/todo.md): a bare ratio
// with no "geomean of N cases" caption, and jz labeled "→ wasm" (a pipeline)
// while every rival showed its optimization tier (clang/rustc/asc -O3).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { benchSvg, withReference, REFERENCE, SNAPSHOT, SNAPSHOT_N } from '../scripts/bench-svg.mjs'

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

test('bench-svg: C and Rust are always shown (reference fallback when a run drops them)', () => {
  // every reference label must have a SNAPSHOT row to fall back to, else the
  // guarantee is silently empty — a relabel in one file and not the other
  for (const label of REFERENCE) ok(SNAPSHOT.some(r => r.label === label), `SNAPSHOT has a "${label}" row to fall back to`)
  const out = withReference(rows)   // rows has neither C nor Rust
  const labels = out.map(r => r.label)
  ok(labels.includes('native C') && labels.includes('Rust'), 'C and Rust injected when missing')
  // a measured row wins — the fallback fills only genuine gaps, never duplicates
  const live = withReference([...rows, { label: 'Rust', sub: 'rustc -O3', ratio: 1.05 }])
  is(live.filter(r => r.label === 'Rust').length, 1, 'measured Rust not duplicated')
  is(live.find(r => r.label === 'Rust').ratio, 1.05, 'measured Rust ratio kept over snapshot')
})

test('bench-svg: native C/Rust render the same gray ball as competitors; only jz is black', () => {
  const svg = benchSvg([{ label: 'jz', sub: '-O3', ratio: 1 }, { label: 'native C', sub: 'clang -O3', ratio: 1.13 }], 12)
  ok(!/fill="#ffffff"\s+stroke=/.test(svg), 'no hollow reference rings — every non-jz ball is the same gray')
  ok(/<circle[^>]*fill="#adb5bd"/.test(svg), 'native C drawn as the gray competitor ball')
  ok(/<circle[^>]*fill="#000000"/.test(svg), 'jz stays a solid black ball')
})
