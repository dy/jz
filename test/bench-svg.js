// bench.svg renderer contract — the README's headline performance chart.
// Pure string assertions, no toolchain, so it runs in the default `npm test`.
// Guards the two ways the chart used to mislead (.work/todo.md): a bare ratio
// with no "geomean of N cases" caption, and jz labeled "→ wasm" (a pipeline)
// while every rival showed its optimization tier (clang/rustc/asc -O3). The
// corpus headline keeps native C as the lone reference row; per-case cards mix
// the measured substrates and sit outside this renderer contract.
import { readFileSync } from 'node:fs'
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { LAB, timedBenchmarkRow } from '../assets/headline.js'
import { benchSvg, completeBenchSvgRun, withReference, REFERENCE, SNAPSHOT, SNAPSHOT_N } from '../scripts/bench-svg.mjs'

const rows = [{ label: 'JZ', sub: '-O3', ratio: 1 }, { label: 'V8', sub: 'Node', ratio: 2.45 }]

test('bench-svg: caption names the geomean, case count, and execution substrates', () => {
  const svg = benchSvg(rows, 12)
  ok(/geometric mean on the 12-case benchmark corpus/.test(svg), 'caption must state geomean + corpus size')
  ok(svg.includes('lower is faster'), 'caption must state the direction')
  ok(/Wasm rivals run in V8/i.test(svg), 'chart names the apples-to-apples wasm field')
  ok(/Porffor and native C are native targets/i.test(svg), 'native targets are not mislabeled as wasm peers')
})

test('bench-svg: missing count degrades to corpus wording, never "undefined"', () => {
  const svg = benchSvg(rows, null)
  ok(/geometric mean on the benchmark corpus/.test(svg), 'null N → corpus wording')
  ok(!svg.includes('undefined'), 'no undefined leaks into the caption')
})

test('bench-svg: jz is labeled by optimization tier, not a pipeline', () => {
  // jz's sub is its -O tier (parallel to clang/rustc/asc -O3); the wasm framing now
  // lives in the chart's scope line + the rival subs, so jz's own label stays a tier.
  const svg = benchSvg(rows, 12)
  ok(svg.includes('>-O3<'), 'jz sub-label is -O3 (parallel to clang/rustc/asc -O3)')
  is(SNAPSHOT.find(r => r.label === 'JZ').sub, '-O3')
})

test('bench-svg: snapshot ratios reproduce committed accepted-checksum evidence', () => {
  const results = JSON.parse(readFileSync(new URL('../bench/results.json', import.meta.url), 'utf8'))
  const ids = Object.keys(results.cases).filter(id => !LAB.has(id))
  is(SNAPSHOT_N, ids.length, 'snapshot case count matches the non-lab corpus')
  const targetByLabel = new Map([
    ['JZ', 'jz'], ['native C', 'nat'], ['C', 'c-wasm'], ['Rust', 'rust-wasm'],
    ['AssemblyScript', 'as'], ['Zig', 'zig-wasm'], ['V8', 'v8'], ['Go', 'go-wasm'],
    ['MoonBit', 'moonbit'], ['Porffor', 'porf-native'],
  ])
  is(SNAPSHOT.map(r => r.label).sort().join(','), [...targetByLabel.keys()].sort().join(','),
    'offline snapshot includes every chart lane')
  for (const row of SNAPSHOT) {
    const target = targetByLabel.get(row.label)
    ok(target, `snapshot label ${row.label} has a results target`)
    const ratios = []
    for (const id of ids) {
      const c = results.cases[id]
      const jz = c.targets?.jz
      const rival = c.targets?.[target]
      if (timedBenchmarkRow(jz) && timedBenchmarkRow(rival))
        ratios.push(rival.medianUs / jz.medianUs)
    }
    ok(ratios.length > 0, `${row.label} has accepted-checksum evidence`)
    const geomean = Math.exp(ratios.reduce((sum, ratio) => sum + Math.log(ratio), 0) / ratios.length)
    is(row.ratio, +geomean.toFixed(2), `${row.label} snapshot ratio matches results.json`)
    if (row.label === 'Porffor') ok(row.sub.includes(`runs ${ratios.length} / ${ids.length}`), 'Porffor coverage label matches evidence')
  }
})

test('bench-svg: only a complete live run may replace the chart', () => {
  const targets = [
    { id: 'jz', label: 'JZ' },
    { id: 'porf-native', label: 'Porffor' },
    { id: 'nat', label: 'native C' },
  ]
  const targetIds = targets.map(t => t.id)
  const cases = ['a', 'b']
  const rows = [{ label: 'JZ', ratio: 1 }, { label: 'Porffor', ratio: 2 }]
  is(completeBenchSvgRun(targets, targetIds, cases, cases), true,
    'complete selection permits row aggregation before rows exist')
  is(completeBenchSvgRun(targets, targetIds, cases, cases, rows), true,
    'all selected cases and targets with every non-reference row are complete')
  is(completeBenchSvgRun(targets, ['jz', 'nat'], cases, cases, rows), false,
    'a target-filtered run is incomplete')
  is(completeBenchSvgRun(targets, targetIds, cases, ['a'], rows), false,
    'a case-filtered run is incomplete')
  is(completeBenchSvgRun(targets, targetIds, cases, cases, [{ label: 'JZ', ratio: 1 }]), false,
    'a selected non-reference target with no valid rows is incomplete')
  is(completeBenchSvgRun(targets, targetIds, cases, cases,
    [{ label: 'JZ', ratio: 1 }, { label: 'Porffor', ratio: 0 }]), false,
    'a zero ratio cannot replace the committed chart')
  is(completeBenchSvgRun(targets, targetIds, cases, cases,
    [{ label: 'JZ', ratio: 1 }, { label: 'Porffor', ratio: NaN }]), false,
    'a nonfinite ratio cannot replace the committed chart')
  is(completeBenchSvgRun(targets, targetIds, [], [], rows), false,
    'an empty corpus cannot replace the committed chart')
  is(completeBenchSvgRun(targets, targetIds, cases, cases,
    [{ label: 'JZ', ratio: 1 }, { label: 'Porffor', ratio: 2 }, { label: 'native C', ratio: 0.9 }]), true,
    'a positive measured reference row is complete')
})

test('bench-svg: snapshot render is internally consistent (caption N = Porffor denominator)', () => {
  // The crux of the fix — a reader must never see "12 cases" above a row reading
  // "runs 4 / 13". SNAPSHOT_N drives both the caption and the Porffor denominator,
  // so they can't disagree; the live bench.mjs path derives both from geoCases too.
  const svg = benchSvg([...SNAPSHOT].sort((a, b) => a.ratio - b.ratio), SNAPSHOT_N)
  const capN = svg.match(/on the (\d+)-case benchmark corpus/)?.[1]
  const porfDenom = svg.match(/runs \d+ \/ (\d+)/)?.[1]
  is(capN, String(SNAPSHOT_N), 'caption N = SNAPSHOT_N')
  is(porfDenom, String(SNAPSHOT_N), 'Porffor denominator = SNAPSHOT_N')
  is(capN, porfDenom, 'caption N and Porffor denominator must agree')
})

test('bench-svg: native C is always shown (the lone speed-of-light reference)', () => {
  // every reference label must have a SNAPSHOT row to fall back to, else the
  // guarantee is silently empty — a relabel in one file and not the other
  for (const label of REFERENCE) ok(SNAPSHOT.some(r => r.label === label), `SNAPSHOT has a "${label}" row to fall back to`)
  const out = withReference(rows)   // rows has no native C
  ok(out.map(r => r.label).includes('native C'), 'native C injected when missing')
  // a measured row wins — the fallback fills only genuine gaps, never duplicates
  const live = withReference([...rows, { label: 'native C', sub: 'clang -O3', ratio: 1.05 }])
  is(live.filter(r => r.label === 'native C').length, 1, 'measured native C not duplicated')
  is(live.find(r => r.label === 'native C').ratio, 1.05, 'measured native C ratio kept over snapshot')
})

test('bench-svg: transparent + currentColor — jz ball at full ink, every other ball uniformly dimmed', () => {
  const svg = benchSvg([{ label: 'JZ', sub: '-O3', ratio: 1 }, { label: 'native C', sub: 'clang -O3', ratio: 1.13 }], 12)
  ok(!/#fff(fff)?/i.test(svg) && !/<rect[^>]*\bwidth="720"/.test(svg), 'no opaque white background — the chart is transparent so it blends into the page')
  ok(!/#[0-9a-f]{6}/i.test(svg), 'no hardcoded colours — every mark is currentColor, inheriting the page text colour')
  ok(/<circle[^>]*fill="currentColor"[^>]*fill-opacity="1"/.test(svg), 'jz ball is full-ink currentColor')
  ok(/<circle[^>]*fill="currentColor"[^>]*fill-opacity="0\.4"/.test(svg), 'native C (and every non-jz ball) is currentColor at the same dimmed opacity')
})
