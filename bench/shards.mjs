#!/usr/bin/env node
// Sharded benchmark runs: the corpus split by case across CI jobs, each job measuring
// every lane of its cases on one machine, then merged into one dataset. A case is
// never split, so every per-case ratio stays same-machine; the merged dataset names
// each case's machine (cases[id].host) and each job's provenance (meta.shards).
//
//   node bench/shards.mjs plan --mode=ci|reference [--cases=a,b] [--from=<dataset>] [--budget=<s>]
//   node bench/shards.mjs merge --out=<file> [--cases=a,b] <shard.json>…
//
// `plan` prints the shards as JSON for the workflow's matrix, sized from each case's
// measured wall time: the dataset's own cases[].wallMs when a sharded run wrote it,
// else bench/shard-costs.json. `merge` refuses anything but one complete measurement
// of one commit with one toolchain: a case missing, measured twice or unexpected, or
// any shard's metadata (commit, versions, memory method) differing from the others.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAIM_RIVALS, JIT_RIVALS } from './claims.mjs'

const BENCH_DIR = dirname(fileURLToPath(import.meta.url))

/** The lanes the claims gate decides on: paired in the reference protocol, jz first
 *  (the ratio base). jz-w2c answers the native-lowering bands. */
export const CLAIM_LANES = ['jz', ...CLAIM_RIVALS, 'porf-native', ...JIT_RIVALS, 'jz-w2c']
/** Every lane CI installs: the claim lanes, then the references the page and chart show. */
export const LANES = [...CLAIM_LANES, 'nat', 'moonbit', 'rust', 'zig', 'go', 'goose', 'perry', 'scriptc', 'tslang',
  'shermes', 'js2wasm', 'qjs-wasi', 'componentize-qjs', 'componentize-js', 'jz-wasmtime', 'wat', 'numpy']
/** ci: every lane timed once (the CI runner view, results-ci.json). reference: the
 *  claim lanes in 6 paired rounds, every other lane once (results.json, gated). */
export const MODES = {
  ci: { file: 'results-ci.json', targets: LANES, paired: 0, pairedTargets: [] },
  reference: { file: 'results.json', targets: LANES, paired: 6, pairedTargets: CLAIM_LANES },
}
/** Cases measured on a runner of their own. The self-compile case builds the compiler
 *  twice in an 8 GB heap and hands its 6.9 MB bundle to every compiler of JavaScript;
 *  sharing a runner, a lost runner there took 15 other cases' evidence with it
 *  (run 41508597936, shard 1). */
export const ALONE = new Set(['jz'])
/** Estimated measurement per shard: two hours against bench.yml's 340-minute job
 *  timeout, so a runner 2.5× slower than the one the costs came from still finishes. */
export const BUDGET_S = 7200

/** Seconds per case: the dataset's wall time when a sharded run wrote it, else the seed,
 *  else the dearest known case (a new case is planned as if it were the heaviest). */
export const caseCosts = (ids, dataset, seed = {}) => {
  const timed = dataset?.meta?.shards ? dataset.cases ?? {} : {}
  const known = ids.map(id => timed[id]?.wallMs > 0 ? timed[id].wallMs / 1000 : seed[id]).filter(s => s > 0)
  const fallback = Math.max(60, ...known)
  return Object.fromEntries(ids.map(id => [id, timed[id]?.wallMs > 0 ? timed[id].wallMs / 1000 : seed[id] > 0 ? seed[id] : fallback]))
}

/** Longest-first packing into the fewest shards whose estimate fits `budget`; a case
 *  dearer than the budget, or one of `alone`, gets a shard of its own. `ids` in corpus
 *  order; each shard lists its cases in that order. Deterministic for the same costs. */
export const planShards = (ids, costs, budget = BUDGET_S, alone = ALONE) => {
  const order = new Map(ids.map((id, i) => [id, i]))
  const packed = ids.filter(id => !alone.has(id))
  const single = ids.filter(id => alone.has(id)).map(id => ({ ids: [id], seconds: costs[id] }))
  const total = packed.reduce((s, id) => s + costs[id], 0)
  const byCost = packed.map((id, i) => [id, i]).sort((a, b) => costs[b[0]] - costs[a[0]] || a[1] - b[1])
  for (let n = Math.max(1, Math.ceil(total / budget)); ; n++) {
    const bins = Array.from({ length: n }, () => ({ ids: [], seconds: 0 }))
    for (const [id] of byCost) {
      const bin = bins.reduce((min, b) => b.seconds < min.seconds ? b : min)
      bin.ids.push(id)
      bin.seconds += costs[id]
    }
    if (n < packed.length && bins.some(b => b.seconds > budget && b.ids.length > 1)) continue
    return [...bins, ...single].filter(b => b.ids.length)
      .map(b => ({ cases: b.ids.sort((x, y) => order.get(x) - order.get(y)), seconds: Math.round(b.seconds) }))
      .sort((a, b) => order.get(a.cases[0]) - order.get(b.cases[0]))
      .map((b, index) => ({ index, ...b }))
  }
}

const canon = v => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x)
const sameHost = (a, b) => canon(a) === canon(b)

/** The worst machine state over the shards: the largest number per field (swap, load,
 *  uptime), a non-number kept only when every shard reports it alike. */
const worstState = states => {
  const keys = [...new Set(states.flatMap(s => Object.keys(s ?? {})))]
  return Object.fromEntries(keys.map(k => {
    const vals = states.map(s => s?.[k] ?? null)
    const nums = vals.filter(v => typeof v === 'number')
    return [k, nums.length ? Math.max(...nums) : vals.every(v => canon(v) === canon(vals[0])) ? vals[0] : null]
  }))
}

/** Merge shard datasets (`[{ name, data }]`) measured from one commit into one
 *  dataset over `expected` (case ids, corpus order). Throws with every problem found. */
export const mergeShards = (shards, expected) => {
  const errors = []
  if (!shards.length) throw Error('merge: no shard datasets')
  for (const { name, data } of shards)
    if (!data?.meta || !data.cases) errors.push(`${name}: not a bench dataset (no meta or cases)`)
    else if (data.meta.partial || data.meta.anchors) errors.push(`${name}: a merged or anchored refresh, not a fresh measurement`)
  if (errors.length) throw Error(errors.join('\n'))

  // Per shard: date, host, machine state. Unioned: invocations. Everything else must agree.
  const OWN = new Set(['date', 'host', 'machineState', 'invocations'])
  const keys = [...new Set(shards.flatMap(s => Object.keys(s.data.meta)))].filter(k => !OWN.has(k))
  for (const k of keys) {
    const vals = new Map()
    for (const { name, data } of shards) {
      const v = canon(data.meta[k])
      vals.set(v, [...vals.get(v) ?? [], name])
    }
    if (vals.size > 1) errors.push(`meta.${k} differs between shards: ${[...vals].map(([v, names]) => `${v ?? 'absent'} (${names.join(', ')})`).join('; ')}`)
  }
  const invocations = {}
  for (const { name, data } of shards) for (const [tid, cmd] of Object.entries(data.meta.invocations ?? {})) {
    if (tid in invocations && invocations[tid] !== cmd) errors.push(`meta.invocations.${tid} differs between shards (${name})`)
    invocations[tid] = cmd
  }

  const owner = new Map()
  for (const { name, data } of shards) for (const id of Object.keys(data.cases)) {
    if (owner.has(id)) errors.push(`case ${id} measured by both ${owner.get(id)} and ${name}`)
    else owner.set(id, name)
  }
  const want = new Set(expected)
  const missing = expected.filter(id => !owner.has(id))
  const extra = [...owner.keys()].filter(id => !want.has(id))
  if (missing.length) errors.push(`missing cases (no shard measured them): ${missing.join(', ')}`)
  if (extra.length) errors.push(`unexpected cases: ${extra.join(', ')}`)
  if (errors.length) throw Error(errors.join('\n'))

  const byName = new Map(shards.map(s => [s.name, s.data]))
  const order = new Map(expected.map((id, i) => [id, i]))
  const firstCase = data => Math.min(...Object.keys(data.cases).map(id => order.get(id)))
  const ordered = [...shards].filter(s => Object.keys(s.data.cases).length)
    .sort((a, b) => firstCase(a.data) - firstCase(b.data))
  const hosts = ordered.map(s => s.data.meta.host)
  const first = shards[0].data.meta
  const meta = {}
  for (const k of Object.keys(first)) {
    if (k === 'date') meta.date = shards.map(s => s.data.meta.date).sort().at(-1)
    else if (k === 'host') { if (hosts.every(h => sameHost(h, hosts[0]))) meta.host = hosts[0] }
    else if (k === 'machineState') meta.machineState = worstState(shards.map(s => s.data.meta.machineState))
    else if (k === 'invocations') meta.invocations = invocations
    else meta[k] = first[k]
  }
  meta.shards = ordered.map(({ data }) => ({
    host: data.meta.host, date: data.meta.date, machineState: data.meta.machineState,
    cases: Object.keys(data.cases).sort((a, b) => order.get(a) - order.get(b)),
  }))
  const cases = Object.fromEntries(expected.map(id => {
    const data = byName.get(owner.get(id))
    return [id, { ...data.cases[id], host: data.meta.host }]
  }))
  return { meta, cases }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const corpus = cases => execFileSync(process.execPath, [join(BENCH_DIR, 'bench.mjs'), '--list', ...(cases ? [`--cases=${cases}`] : [])],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim().split('\n').filter(Boolean)
const loadJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [cmd, ...args] = process.argv.slice(2)
  const opt = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const files = args.filter(a => !a.startsWith('--'))
  if (cmd === 'plan') {
    const mode = MODES[opt('mode')]
    if (!mode) throw Error(`plan: --mode=${Object.keys(MODES).join('|')}`)
    const ids = corpus(opt('cases'))
    const dataset = loadJson(resolve(opt('from') ?? join(BENCH_DIR, mode.file)))
    const seed = loadJson(join(BENCH_DIR, 'shard-costs.json'))?.[opt('mode')]
    const costs = caseCosts(ids, dataset, seed)
    const shards = planShards(ids, costs, +(opt('budget') ?? BUDGET_S))
    for (const s of shards) console.error(`shard ${s.index}: ${s.cases.length} case${s.cases.length === 1 ? '' : 's'}, ~${Math.round(s.seconds / 60)} min (${s.cases.join(' ')})`)
    console.log(JSON.stringify({
      targets: mode.targets.join(','), paired: mode.paired, pairedTargets: mode.pairedTargets.join(','),
      shards: shards.map(s => ({ kind: 'shard', index: s.index, cases: s.cases.join(','), minutes: Math.ceil(s.seconds / 60) })),
    }))
  } else if (cmd === 'merge' && opt('out') && files.length) {
    let merged
    try { merged = mergeShards(files.map(f => ({ name: f, data: loadJson(f) })), corpus(opt('cases'))) }
    catch (e) { console.error(`merge refused:\n${e.message}`); process.exit(1) }
    writeFileSync(opt('out'), JSON.stringify(merged, null, 1))
    const hosts = [...new Set(merged.meta.shards.map(s => s.host?.cpu))]
    console.log(`merged ${Object.keys(merged.cases).length} cases from ${merged.meta.shards.length} shards at ${merged.meta.commit} on ${hosts.join(', ')} → ${opt('out')}`)
  } else {
    console.error('usage: shards.mjs plan --mode=ci|reference [--cases=] [--from=] [--budget=] | merge --out=<file> [--cases=] <shard.json>…')
    process.exit(2)
  }
}
