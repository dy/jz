// Shared headline stats (assets/headline.js) — pins the figure CONTRACT so a refactor
// can't silently change the numbers the landing hero and the bench strip show. Pure
// function over a synthetic results.json (no jz compile), so it runs on every leg.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'tst'
import { is } from 'tst/assert.js'
import { benchmarkRatio, classifyBenchmarkChecksum, correctBenchmarkRow, headlineStats, timedBenchmarkRow } from '../assets/headline.js'

const C = (jz, rest) => ({ targets: { jz, ...rest } })

test('headline: ratios are geomean(target/jz), peak is max, sizes are median', () => {
  const r = { cases: {
    a: C({ medianUs: 100, bytes: 1000, parity: 'ok' },
      { v8: { medianUs: 200, parity: 'ok' }, as: { medianUs: 300, bytes: 900, parity: 'ok' }, 'rust-wasm': { medianUs:90, parity: 'ok' } }),
    b: C({ medianUs: 100, bytes: 2000, parity: 'ok' },
      { v8: { medianUs: 400, parity: 'ok' }, as: { medianUs: 300, bytes: 1000, parity: 'ok' }, 'rust-wasm': { medianUs:110, parity: 'ok' } }),
  } }
  const s = headlineStats(r)
  is(s.asspeed, '3×')    // geomean(300/100, 300/100) — the figure this test exists to pin
  is(s.v8, '2.8×')       // geomean(2, 4) = √8
  is(s.rust, '1×')       // geomean(0.9, 1.1) ≈ 0.995 → 1×
  is(s.peak, '4×')       // max V8/jz speedup, not a geomean
  is(s.assize, '1.6×')   // median(1000/900, 2000/1000) averages both middle values
})

test('headline: a WRONG-result (parity DIFF) run is excluded from the ratio', () => {
  const r = { cases: {
    a: C({ medianUs: 100, parity: 'ok' }, { as: { medianUs: 300, parity: 'ok' } }),
    b: C({ medianUs: 100, parity: 'ok' }, { as: { medianUs: 9999, parity: 'DIFF' } }),  // miscompiled → must not count
  } }
  is(headlineStats(r).asspeed, '3×')   // only case `a`; the DIFF run is dropped
})

test('headline: benchmark-row validity is exact and positive timing is a separate boundary', () => {
  is(classifyBenchmarkChecksum(7, 7), 'ok', 'an exact pinned checksum is accepted')
  is(classifyBenchmarkChecksum(8, 7), 'DIFF', 'a mismatch against a pinned checksum is rejected')
  is(classifyBenchmarkChecksum(8, 7, 8), 'fma', 'a documented FMA checksum is accepted')
  is(classifyBenchmarkChecksum(7, null), 'unclassified', 'a live result without a reference cannot certify itself')
  is(correctBenchmarkRow({ parity: 'ok' }), true, 'reference checksum is valid')
  is(correctBenchmarkRow({ parity: 'fma' }), true, 'documented FMA checksum is valid')
  is(correctBenchmarkRow(null), false, 'a missing row is not evidence')
  is(correctBenchmarkRow({ parity: 'DIFF' }), false, 'wrong checksum is invalid')
  is(correctBenchmarkRow({}), false, 'missing parity is not evidence')
  is(correctBenchmarkRow({ status: 'fail', parity: 'ok' }), false, 'a failed row cannot retain valid parity')
  is(correctBenchmarkRow({ status: 'pending', parity: 'ok' }), false, 'an unknown status fails closed')
  is(timedBenchmarkRow({ parity: 'fma', medianUs: 1 }), true, 'a positive FMA timing is comparable')
  for (const medianUs of [0, -1, Infinity, NaN])
    is(timedBenchmarkRow({ parity: 'ok', medianUs }), false, `${medianUs} is not a comparable timing`)
})

test('headline: a WRONG-result JZ row is excluded from speed, size, memory, and peak', () => {
  const r = { cases: {
    good: C({ medianUs: 100, bytes: 200, memKb: 100, parity: 'ok' }, { v8: { medianUs: 300, memKb: 300, parity: 'ok' }, as: { medianUs: 300, bytes: 100, parity: 'ok' } }),
    wrong: C({ medianUs: 1, bytes: 1, memKb: 1, parity: 'DIFF' }, { v8: { medianUs: 9999, memKb: 9999, parity: 'ok' }, as: { medianUs: 9999, bytes: 9999, parity: 'ok' } }),
  } }
  const stats = headlineStats(r)
  is(stats.asspeed, '3×', 'wrong JZ timing does not inflate speed')
  is(stats.peak, '3×', 'wrong JZ timing does not inflate peak')
  is(stats.assize, '2×', 'wrong JZ bytes do not shrink the size ratio')
  is(stats.v8mem, '0.33×', 'memory is the fraction of V8 RSS used by JZ')
})

test('benchmark ratios: paired positive finite measurements, independent columns and no retained state', () => {
  for (const metric of ['medianUs', 'memKb', 'bytes']) {
    const pair = (a, b) => C({ [metric]: a, parity: 'ok' }, { v8: { [metric]: b, parity: 'fma' } })
    const a = [pair(10, 20), pair(100, 800)]
    is(benchmarkRatio([], 'v8', metric), null, 'empty evidence')
    is(benchmarkRatio([pair(1, 1)], 'v8', metric), { geo: 1, n: 1 }, 'smallest sample, equal measurements')
    for (const invalid of [undefined, null, 0, -1, NaN, Infinity, -Infinity]) {
      is(benchmarkRatio([pair(invalid, 1), pair(1, invalid)], 'v8', metric), null, `${metric}: invalid on either side: ${invalid}`)
    }
    const first = benchmarkRatio(a, 'v8', metric)
    is(Math.round(first.geo * 100), 400, 'geomean of target/JZ: sqrt(2 × 8)')
    is(first.n, 2, 'paired coverage')
    is(benchmarkRatio(a, 'v8', metric), first, 'A → A')
    is(benchmarkRatio([pair(4, 1)], 'v8', metric), { geo: .25, n: 1 }, 'A → different B')
    is(benchmarkRatio(a, 'missing', metric), null, 'absent target')
    for (const bad of [{ parity: 'DIFF' }, { parity: undefined }, { status: 'fail' }, { status: 'pending' }]) {
      const j = pair(1, 1000), r = pair(1, 1000)
      Object.assign(j.targets.jz, bad); Object.assign(r.targets.v8, bad)
      is(benchmarkRatio([...a, j, r], 'v8', metric), first, 'invalid checksum/status cannot change value or coverage')
    }
  }
})

test('headline: hand-WAT coverage excludes invalid and lab cases; size median and RSS direction are explicit', () => {
  const pair = (bytes, memKb = 50) => C({ bytes, memKb, parity: 'ok' }, {
    wat: { bytes: 100, parity: 'ok' }, v8: { memKb: 100, parity: 'ok' },
  })
  const cases = { a: pair(100), b: pair(300), c: pair(900), jz: pair(99999), bad: pair(Infinity) }
  const s = headlineStats({ cases })
  is(s.watsize, '3×', 'odd median')
  is(s.watcases, 3, 'only valid finite sizes outside LAB count')
  is(s.v8mem, '0.50×', 'half the RSS reads as half of V8')
  delete cases.c
  is(headlineStats({ cases }).watsize, '2×', 'even median averages middle values')
  cases.a.targets.wat.parity = 'DIFF'
  is(headlineStats({ cases }).watcases, 1, 'wrong WAT excluded')
  is(headlineStats({ cases: {} }).watsize, null, 'empty size hidden')
  is(headlineStats({ cases: {} }).watcases, 0, 'empty coverage')
  is(headlineStats({ cases: {} }).v8mem, null, 'empty RSS hidden')
  is(headlineStats({ cases: { a: pair(100, 200) } }).v8mem, '2.00×', 'double RSS is not described as a saving')
})

test('headline: missing-parity and zero-time rows are excluded', () => {
  const r = { cases: {
    good: C({ medianUs: 100, parity: 'ok' }, { v8: { medianUs: 300, parity: 'ok' } }),
    unknown: C({ medianUs: 1 }, { v8: { medianUs: 9999, parity: 'ok' } }),
    zero: C({ medianUs: 0, parity: 'ok' }, { v8: { medianUs: 9999, parity: 'ok' } }),
  } }
  const stats = headlineStats(r)
  is(stats.v8, '3×', 'only positive rows with accepted checksums contribute')
  is(stats.peak, '3×', 'invalid zero-time rows cannot produce Infinity')
})

test('bench page: invalid rows stay outside corpus and per-case ratio bars', () => {
  const page = readFileSync(new URL('../bench/index.html', import.meta.url), 'utf8')
  is(page.includes('const jzRan = c => timedBenchmarkRow(c.targets.jz)'), true,
    'only a timed, correct JZ row enters the aggregate corpus')
  is(page.includes('for (const c of BENCHMARKS) if (timedBenchmarkRow(c.targets[tid]))'), true,
    'coverage keeps invalid-JZ cases in the denominator')
  is(page.includes('const ranked = measured.filter(timedBenchmarkRow)'), true,
    'per-case bars use the shared timing authority')
  is(page.includes('const unranked = measured.filter(r => !timedBenchmarkRow(r))'), true,
    'zero and invalid measurements remain visible outside the ranked set')
  is(page.includes("const unmeasured = entries.filter(r => r.status !== 'fail' && !Number.isFinite(r.medianUs))"), true,
    'an explicit pending or unknown status remains visible without a fabricated timing')
  is(page.includes("if (!ranked.length) return ''"), false,
    'a card with only invalid or failed rows remains visible')
  is(page.includes("<span class=\"bar\">${unranked ? '' :"), true,
    'an unranked measurement gets no relative bar')
  is(page.includes("r.parity = ref == null ? 'unclassified'"), true,
    'a live run without a reference cannot claim parity')
})

test('bench chart: tiny native RSS cannot clip hosted runtimes; missing memory sorts last', () => {
  const page = readFileSync(new URL('../bench/index.html', import.meta.url), 'utf8')
  const render = page.match(/const renderGeomean = \(\) => \{[\s\S]*?\n\}/)[0]
  const row = memKb => ({ medianUs: 1, bytes: 1, memKb, parity: 'ok' })
  const rendered = []
  runInNewContext(render + '\nrenderGeomean()', {
    COLS: [['speed', 'speed', 'medianUs'], ['mem', 'memory', 'memKb'], ['size', 'size', 'bytes']],
    TARGETS: Object.fromEntries(['jz', 'missing', 'large', 'small'].map(label => [label, { label, band: 'wasm' }]).concat([
      ['native', { label: 'native', band: 'native' }],
    ])),
    CORPUS: [{ targets: { jz: row(1000), missing: row(null), large: row(2000), small: row(500), native: row(1) } }],
    benchmarkRatio, sortBy: 'mem', BREAK: 12,
    BANDS: [['wasm', 'WASM'], ['native', 'native']], CLS_ICO: {}, DESC: {},
    localGeo: () => null, coverage: () => ({ ran: 1, attempted: 1 }),
    nCases: n => `${n} cases`, esc: String, fmtX: String, stripClassSub: label => label,
    $: () => ({}), rowHtml: r => { rendered.push(r); return '' },
  })
  is(rendered.map(r => r.label), ['small', 'jz', 'large', 'missing', 'native'], 'ascending within bands, missing last')
  is(rendered.map(r => Math.round(r.rel * 1000)), [500, 1000, 2000, 0, 1], 'bar inputs use target/JZ, not target/smallest')
  is(rendered.map(r => Math.round(r.maxLin)), [2, 2, 2, 2, 2], 'shared scale keeps all measured bars below the 12× cutoff')
})

test('headline: an attempted-but-failed run ({status:"fail"}) is excluded, never NaN', () => {
  const r = { cases: {
    a: C({ medianUs: 100, parity: 'ok' }, { 'porf-native': { medianUs: 300, parity: 'ok' } }),
    b: C({ medianUs: 100, parity: 'ok' }, { 'porf-native': { status: 'fail', reason: 'memory access out of bounds' } }),  // didn't run → must not count, must not NaN
  } }
  is(headlineStats(r).porf, '3×')   // only case `a`; the failed run is dropped, not pushed as undefined/jz
})

test('headline: null when a target is absent (never NaN/Infinity)', () => {
  const s = headlineStats({ cases: { a: C({ medianUs: 100, parity: 'ok' }, { v8: { medianUs: 200, parity: 'ok' } }) } })
  is(s.asspeed, null)    // no AssemblyScript target anywhere
  is(s.porf, null)
  is(s.assize, null)
})

test('bench README: aggregate geomeans exclude wrong and unclassified rows on either side', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-bench-readme-'))
  try {
    const results = join(dir, 'results.json')
    const readme = join(dir, 'README.md')
    writeFileSync(results, JSON.stringify({ cases: {
      good: C({ medianUs: 100, bytes: 100, parity: 'ok' }, {
        v8: { medianUs: 200, parity: 'ok' }, as: { medianUs: 200, bytes: 200, parity: 'ok' },
      }),
      wrongRival: C({ medianUs: 100, bytes: 100, parity: 'ok' }, {
        v8: { medianUs: 1, parity: 'DIFF' }, as: { medianUs: 1, bytes: 1, parity: 'DIFF' },
      }),
      unknownRival: C({ medianUs: 100, bytes: 100, parity: 'ok' }, {
        v8: { medianUs: 1 }, as: { medianUs: 1, bytes: 1 },
      }),
      wrongJz: C({ medianUs: 1, bytes: 1, parity: 'DIFF' }, {
        v8: { medianUs: 9999, parity: 'ok' }, as: { medianUs: 9999, bytes: 9999, parity: 'ok' },
      }),
      table: C({ medianUs: 100, bytes: 100, parity: 'ok' }, {
        v8: { medianUs: 1, bytes: 10 },
        as: { medianUs: 1, bytes: 10, parity: 'DIFF' },
        rust: { medianUs: 0, bytes: 10, parity: 'ok' },
        zig: { status: 'pending', medianUs: 1, bytes: 10, parity: 'ok' },
        go: { status: 'queued' },
        'porf-native': { status: 'fail', reason: 'compile failed' },
      }),
    } }))
    writeFileSync(readme, `### table – parity boundary

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **stale** | **stale** | **stale** | **stale** |
| V8 (node) raw JS | stale | stale | stale | stale |
| AssemblyScript (asc -O3) | stale | stale | stale | stale |
| Rust | stale | stale | stale | stale |
| Zig | stale | stale | stale | stale |
| Go | stale | stale | stale | stale |
| NumPy | retained | retained | retained | retained |
| Porffor | stale | stale | stale | stale |

| V8 (node) | **stale** | \u2014 |
| AssemblyScript | **stale** | **stale** |
`)
    execFileSync(process.execPath, ['scripts/bench-readme.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, JZ_BENCH_RESULTS_JSON: results, JZ_BENCH_README: readme },
    })
    const out = readFileSync(readme, 'utf8')
    is(out.includes('| V8 (node) | **0.50×** | – |'), true,
      'V8 aggregate uses valid evidence and migrates the legacy placeholder')
    is(out.includes('| AssemblyScript | **0.50×** | **0.50×** |'), true,
      'AssemblyScript speed and size aggregates use only the valid pair')
    is(out.includes('| **JZ → V8 wasm** | **0.10 ms** | **–** | **100 B** | **ok** |'), true,
      'an invalid V8 reference suppresses the per-case ratio')
    is(out.includes('| V8 (node) raw JS | 0.00 ms | – | 10 B | unclassified |'), true,
      'a row without parity is never labeled ok')
    is(out.includes('| AssemblyScript (asc -O3) | 0.00 ms | – | 10 B | DIFF |'), true,
      'a wrong target keeps its measurement and parity label but no ratio')
    is(out.includes('| Rust | 0.00 ms | – | 10 B | ok |'), true,
      'a zero timing remains visible but cannot produce a ratio')
    is(out.includes('Infinity'), false, 'a zero timing never prints an infinite ratio')
    is(out.includes('| Zig | 0.00 ms | – | 10 B | pending |'), true,
      'an unknown status remains visible and receives no ratio')
    is(out.includes('| Go | – | – | – | queued |'), true,
      'an explicit unmeasured status replaces stale cells')
    is(out.includes('| NumPy | retained | retained | retained | retained |'), true,
      'a target absent from the run retains earlier evidence')
    is(out.includes('| Porffor | – | – | – | fail |'), true,
      'an attempted failure replaces stale table measurements')

    writeFileSync(readme, '| V8 (node) | **0.50×** | – |\n| AssemblyScript | **0.50×** | **0.50×** |\n')
    writeFileSync(results, JSON.stringify({ cases: {
      wrong: C({ medianUs: 1, bytes: 1, parity: 'DIFF' }, {
        v8: { medianUs: 1, parity: 'ok' }, as: { medianUs: 1, bytes: 1, parity: 'ok' },
      }),
    } }))
    execFileSync(process.execPath, ['scripts/bench-readme.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, JZ_BENCH_RESULTS_JSON: results, JZ_BENCH_README: readme },
    })
    const empty = readFileSync(readme, 'utf8')
    is(empty.includes('NaN'), false, 'an empty evidence set never prints NaN')
    is(empty.includes('| V8 (node) | **–** | – |'), true, 'empty V8 evidence prints an explicit gap')
    is(empty.includes('| AssemblyScript | **–** | **–** |'), true,
      'empty AssemblyScript speed and size evidence prints explicit gaps')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
