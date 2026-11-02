// The sharded benchmark pipeline (bench/shards.mjs, scripts/bench-publish.mjs): how
// the corpus is split across CI jobs, how the shards merge into one dataset, and how
// that dataset reaches main. Pure functions and a local git fixture; no toolchain.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { BUDGET_S, caseCosts, CLAIM_LANES, LANES, MODES, mergeShards, planShards } from '../bench/shards.mjs'
import { CLAIM_RIVALS, JIT_RIVALS } from '../bench/claims.mjs'
import { SVG_TARGETS } from '../scripts/bench-svg.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('shards: the reference pairs every claim lane, jz first; both modes run every lane', () => {
  is(CLAIM_LANES[0], 'jz', 'the paired ratios are against jz')
  for (const rival of [...CLAIM_RIVALS, ...JIT_RIVALS, 'porf-native', 'jz-w2c']) ok(CLAIM_LANES.includes(rival), `${rival} is paired`)
  for (const t of SVG_TARGETS) ok(LANES.includes(t.id), `chart lane ${t.id} is measured`)
  is(new Set(LANES).size, LANES.length, 'no lane twice')
  is(MODES.ci.paired, 0, 'the CI view times each lane once')
  is(MODES.reference.paired, 6, 'the reference runs six paired rounds')
  is(MODES.reference.pairedTargets, CLAIM_LANES)
  is(MODES.ci.targets, LANES); is(MODES.reference.targets, LANES)
})

test('shards: costs come from a sharded run, then the seed, then the dearest known case', () => {
  const ids = ['a', 'b', 'c', 'd']
  const sharded = { meta: { shards: [] }, cases: { a: { wallMs: 120_000 }, b: { wallMs: 0 } } }
  is(caseCosts(ids, sharded, { a: 999, b: 30, c: 400 }), { a: 120, b: 30, c: 400, d: 400 }, 'own wall time, else seed, else the dearest')
  const local = { meta: {}, cases: { a: { wallMs: 1000 } } }
  is(caseCosts(['a'], local, { a: 500 }).a, 500, 'a non-sharded dataset (a local or merged refresh) is not a cost source')
  is(caseCosts(['x'], null, {}).x, 60, 'nothing known: a minute')
})

test('shards: plan packs whole cases, dearest first, into the fewest shards under the budget', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const costs = { a: 50, b: 40, c: 30, d: 30, e: 20, f: 10 }
  const plan = planShards(ids, costs, 100)
  is(plan.length, 2, '180 s of work in 100 s shards')
  is(plan.flatMap(s => s.cases).sort().join(), ids.join(), 'every case exactly once')
  for (const s of plan) ok(s.seconds <= 100, `shard ${s.index} fits: ${s.seconds}`)
  for (const s of plan) is(s.cases, [...s.cases].sort((x, y) => ids.indexOf(x) - ids.indexOf(y)), 'a shard runs its cases in corpus order')
  is(plan.map(s => s.index), [0, 1])
  is(planShards(ids, costs, 100), plan, 'deterministic')
  const huge = planShards(['big', 'x', 'y'], { big: 500, x: 10, y: 10 }, 100)
  is(huge.find(s => s.cases.includes('big')).cases, ['big'], 'a case over the budget runs alone')
  is(planShards([], {}, 100), [], 'nothing to plan')
  is(planShards(['a'], { a: 10 }).length, 1, `default budget ${BUDGET_S} s`)
})

test('shards: the committed seed plans the whole corpus under budget in both modes', () => {
  const seed = JSON.parse(readFileSync(join(root, 'bench/shard-costs.json'), 'utf8'))
  const ids = execFileSync(process.execPath, [join(root, 'bench/bench.mjs'), '--list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')
  for (const mode of Object.keys(MODES)) {
    is(Object.keys(seed[mode]).sort().join(), [...ids].sort().join(), `${mode}: a seed cost for every case`)
    const plan = planShards(ids, caseCosts(ids, null, seed[mode]))
    ok(plan.length > 1 && plan.length <= 20, `${mode}: ${plan.length} shards`)
    for (const s of plan) ok(s.seconds <= BUDGET_S || s.cases.length === 1, `${mode} shard ${s.index}: ${s.seconds} s`)
  }
})

const host = cpu => ({ platform: 'linux', arch: 'x64', cpu })
const shard = (cpu, cases, meta = {}) => ({
  meta: { date: '2026-11-02 10:00 UTC', commit: 'abc1234', host: host(cpu), versions: { node: 'v24', watr: '5.13.2' },
    invocations: Object.fromEntries(Object.values(cases).flatMap(c => Object.keys(c.targets)).map(t => [t, `run ${t}`])),
    memory: 'peak RSS', machineState: { swapUsedMB: 0, uptimeDays: 0.1, load1: 1, powermode: null }, ...meta },
  cases,
})
const row = medianUs => ({ medianUs, parity: 'ok' })

test('shards: merge assembles one dataset, each case with its own machine', () => {
  const a = shard('EPYC 7763', { alpha: { targets: { jz: row(1), v8: row(2) }, wallMs: 5 }, gamma: { targets: { jz: row(3) } } },
    { date: '2026-11-02 11:00 UTC', machineState: { swapUsedMB: 10, uptimeDays: 0.2, load1: 3, powermode: null } })
  const b = shard('EPYC 9V74', { beta: { targets: { jz: row(4), nat: row(1) } } })
  const merged = mergeShards([{ name: 'b', data: b }, { name: 'a', data: a }], ['alpha', 'beta', 'gamma'])
  is(Object.keys(merged.cases), ['alpha', 'beta', 'gamma'], 'corpus order, whatever the shard order')
  is(merged.cases.alpha.host.cpu, 'EPYC 7763'); is(merged.cases.beta.host.cpu, 'EPYC 9V74')
  is(merged.cases.alpha.targets, a.cases.alpha.targets, 'rows unchanged'); is(merged.cases.alpha.wallMs, 5)
  is(merged.meta.host, undefined, 'no single host: no meta.host')
  is(merged.meta.shards.map(s => [s.host.cpu, s.cases]), [['EPYC 7763', ['alpha', 'gamma']], ['EPYC 9V74', ['beta']]], 'shards in corpus order with their cases')
  is(merged.meta.machineState, { swapUsedMB: 10, uptimeDays: 0.2, load1: 3, powermode: null }, 'the worst state any shard ran under')
  is(merged.meta.date, '2026-11-02 11:00 UTC', 'dated when the last shard finished')
  is(Object.keys(merged.meta.invocations).sort(), ['jz', 'nat', 'v8'], 'invocations of every shard')
  is(merged.meta.partial, undefined, 'one commit, every lane: not partial')
  is(Object.keys(merged.meta), ['date', 'commit', 'host', 'versions', 'invocations', 'memory', 'machineState', 'shards'].filter(k => k !== 'host'), 'meta keeps the writer\'s key order')
  const same = mergeShards([{ name: 'a', data: shard('EPYC 7763', { alpha: { targets: {} } }) }, { name: 'b', data: shard('EPYC 7763', { beta: { targets: {} } }) }], ['alpha', 'beta'])
  is(same.meta.host, host('EPYC 7763'), 'one machine model: meta.host names it')
})

test('shards: merge refuses anything but one complete measurement of one commit and toolchain', () => {
  const a = () => shard('A', { alpha: { targets: {} } }), b = (meta = {}) => shard('B', { beta: { targets: {} } }, meta)
  const refuse = (inputs, expected, why) => throws(() => mergeShards(inputs.map((data, i) => ({ name: `s${i}`, data })), expected), why)
  refuse([a()], ['alpha', 'beta'], /missing cases.*beta/)
  refuse([a(), b()], ['alpha'], /unexpected cases: beta/)
  refuse([a(), a()], ['alpha'], /alpha measured by both s0 and s1/)
  refuse([a(), b({ commit: 'def5678' })], ['alpha', 'beta'], /meta\.commit differs/)
  refuse([a(), b({ versions: { node: 'v25', watr: '5.13.2' } })], ['alpha', 'beta'], /meta\.versions differs/)
  refuse([a(), b({ versions: { node: 'v24' } })], ['alpha', 'beta'], /meta\.versions differs/)
  refuse([a(), b({ partial: true })], ['alpha', 'beta'], /merged or anchored refresh/)
  refuse([a(), b({ contenders: 2 })], ['alpha', 'beta'], /meta\.contenders differs/)
  refuse([a(), { meta: null }], ['alpha'], /not a bench dataset/)
  const c = b(); c.meta.invocations.jz = 'other'; const d = a(); d.meta.invocations.jz = 'run jz'
  refuse([d, c], ['alpha', 'beta'], /invocations\.jz differs/)
  refuse([], [], /no shard datasets/)
})

// ── publication: a bare origin, a clone as the CI checkout, the real script ──
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-bench-publish-test-'))
  const origin = join(dir, 'origin.git'), work = join(dir, 'work')
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin)
  git(dir, 'clone', '--quiet', origin, work)
  for (const d of ['bench', 'scripts', 'assets']) mkdirSync(join(work, d), { recursive: true })
  for (const f of ['bench/shards.mjs', 'bench/claims.mjs', 'scripts/bench-publish.mjs', 'scripts/bench-svg.mjs', 'scripts/bench-readme.mjs', 'assets/headline.js'])
    copyFileSync(join(root, f), join(work, f))
  writeFileSync(join(work, 'package.json'), '{"type":"module"}')
  writeFileSync(join(work, 'bench/README.md'), '# bench\n')
  writeFileSync(join(work, 'bench/results.json'), '{"meta":{"commit":"none"},"cases":{}}')
  writeFileSync(join(work, 'bench/results-ci.json'), '{"meta":{"commit":"none"},"cases":{}}')
  writeFileSync(join(work, 'bench/bench.svg'), '<svg/>')
  const commit = msg => { git(work, 'add', '-A'); execFileSync('git', ['commit', '--quiet', '-m', msg], { cwd: work, env: { ...process.env, ...ENV } }); return git(work, 'rev-parse', '--short', 'HEAD') }
  const sha = commit('source')
  git(work, 'push', '--quiet', 'origin', 'main')
  const publish = (mode, dataset, env = {}) => {
    const path = join(dir, `${mode}.json`)
    writeFileSync(path, JSON.stringify(dataset))
    return spawnSync(process.execPath, [join(work, 'scripts/bench-publish.mjs'), `--mode=${mode}`, `--dataset=${path}`],
      { cwd: work, encoding: 'utf8', env: { ...process.env, ...ENV, GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), ...env } })
  }
  const onMain = f => execFileSync('git', ['--git-dir', origin, 'show', `main:${f}`], { encoding: 'utf8' })
  const mainLog = () => execFileSync('git', ['--git-dir', origin, 'log', '--format=%s', 'main'], { encoding: 'utf8' }).trim().split('\n')
  return { dir, work, origin, sha, commit, publish, onMain, mainLog, done: () => rmSync(dir, { recursive: true, force: true }) }
}
// Every chart lane timed on one case, so scripts/bench-svg.mjs can draw it.
const complete = commit => ({ meta: { commit }, cases: { mat4: { targets: Object.fromEntries(SVG_TARGETS.map((t, i) => [t.id, row(10 + i)])) } } })

test('shards: publishing the CI view commits results-ci.json on the latest main, never touching the checkout', () => {
  const f = fixture()
  try {
    const head = git(f.work, 'rev-parse', 'HEAD')
    writeFileSync(join(f.work, 'scratch.txt'), 'uncommitted work')
    const r = f.publish('ci', complete(f.sha))
    is(r.status, 0, r.stdout + r.stderr)
    ok(r.stdout.includes('published bench/results-ci.json'), r.stdout)
    is(JSON.parse(f.onMain('bench/results-ci.json')).meta.commit, f.sha, 'main holds the dataset')
    is(f.onMain('bench/results.json'), '{"meta":{"commit":"none"},"cases":{}}', 'the reference dataset is untouched')
    ok(f.mainLog()[0].endsWith('[skip ci]'), f.mainLog()[0])
    is(git(f.work, 'rev-parse', 'HEAD'), head, 'the caller\'s checkout stays where it was')
    is(readFileSync(join(f.work, 'scratch.txt'), 'utf8'), 'uncommitted work', 'and keeps its files')
    is(git(f.work, 'worktree', 'list').split('\n').length, 1, 'no worktree left behind')
    ok(readFileSync(join(f.dir, 'summary.md'), 'utf8').includes('published'), 'the outcome reaches the job summary')

    const again = f.publish('ci', complete(f.sha))
    is(again.status, 0); ok(again.stdout.includes('unchanged'), again.stdout)
    is(f.mainLog().length, 2, 'an unchanged dataset makes no commit')
  } finally { f.done() }
})

test('shards: a later commit\'s evidence on main is kept; a commit off main is refused', () => {
  const f = fixture()
  try {
    const older = f.sha
    writeFileSync(join(f.work, 'src.js'), '1'); const newer = f.commit('newer source'); git(f.work, 'push', '--quiet', 'origin', 'main')
    is(f.publish('ci', complete(newer)).status, 0)
    const stale = f.publish('ci', complete(older))
    is(stale.status, 0, 'superseded evidence is a stated no-op')
    ok(stale.stdout.includes(`::warning::bench/results-ci.json not published: main already holds evidence of ${newer}`), stale.stdout)
    is(JSON.parse(f.onMain('bench/results-ci.json')).meta.commit, newer, 'the newer evidence stays')
    git(f.work, 'checkout', '--quiet', '-b', 'side', older)
    writeFileSync(join(f.work, 'side.js'), '1'); const side = f.commit('off main')
    const off = f.publish('ci', complete(side))
    is(off.status, 1, 'evidence of a commit main does not hold is refused')
    ok(off.stdout.includes(`::error::bench/results-ci.json not published: the measured commit ${side} is not on main`), off.stdout)
    const none = f.publish('ci', { meta: {}, cases: {} })
    is(none.status, 1); ok(none.stdout.includes('no measured commit'), none.stdout)
  } finally { f.done() }
})

test('shards: publishing the reference redraws the chart and README tables, and refuses an incomplete chart', () => {
  const f = fixture()
  try {
    const partial = complete(f.sha)
    delete partial.cases.mat4.targets.moonbit
    const refused = f.publish('reference', partial)
    is(refused.status, 1, 'a chart lane without evidence blocks the publication')
    ok(refused.stderr.includes('moonbit') && refused.stdout.includes('could not draw bench/bench.svg'), refused.stdout + refused.stderr)
    is(f.mainLog().length, 1, 'nothing reached main')
    const r = f.publish('reference', complete(f.sha))
    is(r.status, 0, r.stdout + r.stderr)
    is(JSON.parse(f.onMain('bench/results.json')).meta.commit, f.sha)
    ok(f.onMain('bench/bench.svg').includes('MoonBit'), 'the chart is redrawn from the published dataset')
    ok(f.mainLog()[0].startsWith('Refresh bench/results.json, bench/bench.svg, bench/README.md from the sharded reference run'), f.mainLog()[0])
    is(f.onMain('bench/results-ci.json'), '{"meta":{"commit":"none"},"cases":{}}', 'the CI view is untouched')
  } finally { f.done() }
})

test('shards: a push lost to a concurrent commit is rebuilt on the new main', () => {
  const f = fixture()
  try {
    // The first push is rejected the way a race loses it: origin moved after the fetch.
    const hook = join(f.origin, 'hooks/pre-receive')
    writeFileSync(hook, `#!/bin/sh\nif [ ! -f "${join(f.dir, 'raced')}" ]; then touch "${join(f.dir, 'raced')}"; exit 1; fi\n`, { mode: 0o755 })
    const r = f.publish('ci', complete(f.sha))
    is(r.status, 0, r.stdout + r.stderr)
    ok(r.stdout.includes('push attempt 1 rejected'), r.stdout)
    is(JSON.parse(f.onMain('bench/results-ci.json')).meta.commit, f.sha, 'published on the second attempt')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const lost = f.publish('ci', { ...complete(f.sha), cases: {} })   // a new dataset, so not unchanged
    is(lost.status, 1, 'exhausted attempts fail')
    ok(lost.stdout.includes('3 push attempts rejected'), lost.stdout)
  } finally { f.done() }
})
