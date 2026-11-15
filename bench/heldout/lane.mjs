// The held-out lane's record and what holds it (manifest.json says what the lane is):
// one definition for the workflow's writer (scripts/heldout.mjs), the gate
// (test/bench-claims.js) and the docs' figures (scripts/bench-readme.mjs).
//
// The record (bench/heldout.json) is { about, entries }, appended to by the workflow
// alone. An entry is one program measured by one run:
//   prev        sha256 of the entry before it (canon below), GENESIS for the first
//   program, set, source { repo, commit, path, blob, sha256 }
//   files       { path: sha256 } of every other file its driver is made of or checked by
//   driver      sha256 of the generated driver
//   compiler    the jz commit measured; registered, the program's registration (git)
//   contact     'first', or 'tuned' for a program measured before
//   run         { id, url, date, machine, versions }
//   oracle      { checksum, check }: V8's result of the unmodified source, and whether
//               V8 passes the set's own check ('ok', or why not)
//   rows        { lane: row } for every lane of LANES, a failure a row (RESULTS)
//   paired      the paired rounds' ratios, as bench.mjs writes them
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE_SCOPE } from '../claims.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
export const MANIFEST = 'bench/heldout/manifest.json'
export const RECORD = 'bench/heldout.json'
/** The lanes a contact run measures: jz at 'speed' and exact, the JIT engines, Porffor. */
export const LANES = ['jz', 'jz-exact', 'v8', 'deno', 'bun', 'jsc', 'porf-native']
/** A row's result: correct, or one way of failing. */
export const RESULTS = ['ok', 'wrong', 'compile', 'trap', 'timeout', 'unverified', 'absent']
export const GENESIS = '0'.repeat(64)

export const sha256 = data => createHash('sha256').update(data).digest('hex')
/** JSON with every object's keys in order: an entry's hash does not depend on how it was written. */
export const canon = v => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v ?? null)
export const entryHash = e => sha256(canon(e))

export const readJson = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback
export const programsOf = manifest => manifest.sets.flatMap(set => set.programs.map(p => ({ set, program: p })))

/** Each entry names the hash of the one before it. */
export const chainProblems = entries => entries.flatMap((e, i) => {
  const want = i ? entryHash(entries[i - 1]) : GENESIS
  return e.prev === want ? [] : [`entry ${i} (${e.program}): prev ${e.prev} is not ${i ? `the hash of entry ${i - 1}` : 'the genesis hash'}, ${want}`]
})

/** One first contact a program; a tuned measurement only after it. */
export const contactProblems = entries => {
  const first = new Map(), out = []
  entries.forEach((e, i) => {
    if (e.contact === 'first') {
      if (first.has(e.program)) out.push(`entry ${i}: a second first contact of ${e.program} (the first is entry ${first.get(e.program)})`)
      else first.set(e.program, i)
    } else if (e.contact === 'tuned') {
      if (!first.has(e.program)) out.push(`entry ${i}: ${e.program} is marked tuned with no first contact before it`)
    } else out.push(`entry ${i}: ${e.program}'s contact is ${JSON.stringify(e.contact)}, not 'first' or 'tuned'`)
  })
  return out
}

const HEX40 = /^[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/
/** An entry's fields: its program is the manifest's, at the manifest's blob, and every lane has a row. */
export const entryProblems = (entries, manifest) => {
  const programs = new Map(programsOf(manifest).map(x => [x.program.id, x]))
  return entries.flatMap((e, i) => {
    const at = `entry ${i} (${e.program})`, out = []
    const m = programs.get(e.program)
    if (!m) return [`${at}: no program of the manifest has this id`]
    if (e.set !== m.set.id) out.push(`${at}: set ${e.set}, the manifest's is ${m.set.id}`)
    if (e.source?.blob !== m.program.blob || e.source?.path !== m.program.path) out.push(`${at}: measured ${e.source?.path}@${e.source?.blob}, the manifest pins ${m.program.path}@${m.program.blob}`)
    if (!HEX64.test(e.source?.sha256 ?? '')) out.push(`${at}: the program's sha256 is required`)
    // a program esbuild could not bundle has no driver, and a compile row in every lane
    if (e.driver === null ? !LANES.every(l => e.rows?.[l]?.result === 'compile') : !HEX64.test(e.driver ?? '')) out.push(`${at}: the driver's sha256 is required`)
    if (!HEX40.test(e.compiler ?? '')) out.push(`${at}: compiler ${e.compiler} is not a full commit`)
    for (const k of ['id', 'date', 'machine', 'versions']) if (!e.run?.[k]) out.push(`${at}: the run's ${k} is missing`)
    for (const lane of LANES) {
      const row = e.rows?.[lane]
      if (!row || !RESULTS.includes(row.result)) out.push(`${at}: ${lane} has no row with a result of ${RESULTS.join('|')}`)
      else if (row.result !== 'ok' && row.result !== 'wrong' && !row.message) out.push(`${at}: ${lane}'s ${row.result} row says nothing of why`)
    }
    return out
  })
}

export const firstLine = s => String(s ?? '').trim().split('\n')[0].slice(0, 300)
/** A lane's row from bench.mjs's (bench/bench.mjs --json): a failure by its stage, a run by
 *  its parity against the oracle; `verified` is whether V8 passes the set's own check. */
export const rowOf = (t, verified) => {
  if (!t) return { result: 'absent', message: 'the lane did not run on this machine' }
  if (t.status === 'fail') return { result: t.stage === 'build' ? 'compile' : t.stage === 'timeout' ? 'timeout' : 'trap', message: firstLine(t.reason) }
  const timed = { medianUs: t.medianUs, ...(t.bytes != null && { bytes: t.bytes }), ...(t.memKb != null && { memKb: t.memKb }) }
  if (!verified) return { result: 'unverified', ...timed, message: 'V8 does not pass the set\'s own check, so no result is known right' }
  if (t.parity === 'ok' || t.parity === 'fma') return { result: 'ok', ...timed }
  if (t.parity === 'DIFF') return { result: 'wrong', ...timed }
  return { result: 'unverified', ...timed, message: `no oracle: V8 did not run the source (parity ${t.parity})` }
}

/** The record's entries with these after them, each chained to the one before. */
export const appendEntries = (entries, more) => {
  const all = [...entries]
  for (const e of more) all.push({ prev: all.length ? entryHash(all.at(-1)) : GENESIS, ...e })
  return all
}

/** The sha256 a path was first fetched at, from the record: every later fetch must match it. */
export const firstHashes = entries => {
  const out = new Map()
  for (const e of entries) for (const [path, h] of Object.entries({ ...e.files, [e.source?.path]: e.source?.sha256 }))
    if (path && h && !out.has(`${e.source?.repo}:${path}`)) out.set(`${e.source?.repo}:${path}`, h)
  return out
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim()

/** A program's registration at a commit: the last commit at or before it that changed the
 *  program's line of the manifest (git log -G), or null when the manifest named no such program. */
export const registrationOf = (id, commit, { cwd = ROOT, manifest = MANIFEST } = {}) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw Error(`invalid program id ${id}`)
  return git(cwd, ['log', '-1', '--format=%H', `-G"id":"${id}"`, commit, '--', manifest]) || null
}

/** Why a first contact does not measure the compiler of its program's registration, or null. */
export const registrationProblem = (id, commit, { cwd = ROOT, manifest = MANIFEST, scope = SOURCE_SCOPE } = {}) => {
  const reg = registrationOf(id, commit, { cwd, manifest })
  if (!reg) return { problem: `${id}: measured at ${commit.slice(0, 9)}, where the manifest does not register it` }
  const own = git(cwd, ['diff-tree', '--root', '--no-commit-id', '-r', '--name-only', reg, '--', ...scope])
  if (own) return { registered: reg, problem: `${id}: its registration ${reg.slice(0, 9)} changes compiler source (${own.split('\n').join(', ')})` }
  const since = git(cwd, ['log', '--format=%h %s', `${reg}..${commit}`, '--', ...scope])
  if (since) return { registered: reg, problem: `${id}: compiler source changed between its registration ${reg.slice(0, 9)} and the measured ${commit.slice(0, 9)}:\n${since.split('\n').slice(0, 4).map(l => `  ${l.slice(0, 100)}`).join('\n')}` }
  return { registered: reg, problem: null }
}

/** Every first contact measures the compiler its program was registered under. */
export const registrationProblems = (entries, opts) => entries.flatMap((e, i) => {
  if (e.contact !== 'first') return []
  const { registered, problem } = registrationProblem(e.program, e.compiler, opts)
  if (problem) return [`entry ${i}: ${problem}`]
  return registered === e.registered ? [] : [`entry ${i}: ${e.program} records its registration as ${e.registered}, git gives ${registered}`]
})

const geomean = a => Math.exp(a.reduce((s, x) => s + Math.log(x), 0) / a.length)
/** jz's time over V8's in one entry: the paired rounds' median where they ran, else the medians'. */
const jzOverV8 = e => e.paired?.['jz/v8']?.median ?? e.rows.jz.medianUs / e.rows.v8.medianUs

/** The lane's figures from first contacts alone, every program of a set in the denominator:
 *  `<set>-runs` the programs jz at 'speed' runs correctly, `<set>-exact-runs` the same of
 *  jz-exact, `<set>-v8` V8's time over jz's (a geomean over the programs both run
 *  correctly), each set alone and every set together. A set not yet run whole is unmeasured. */
export const heldoutFigures = (record, manifest) => {
  const firsts = new Map((record?.entries ?? []).filter(e => e.contact === 'first').map(e => [e.program, e]))
  const fig = {}
  const figuresOf = (key, programs) => {
    const run = programs.filter(p => firsts.has(p.id)).length, n = programs.length
    if (run < n) {
      const v = run ? `unmeasured (${run} of ${n} run)` : 'unmeasured'
      for (const k of ['runs', 'exact-runs', 'v8']) fig[`${key}-${k}`] = v
      return
    }
    const es = programs.map(p => firsts.get(p.id))
    const okOf = lane => es.filter(e => e.rows[lane]?.result === 'ok')
    fig[`${key}-runs`] = `${okOf('jz').length} of ${n}`
    fig[`${key}-exact-runs`] = `${okOf('jz-exact').length} of ${n}`
    const both = okOf('jz').filter(e => e.rows.v8?.result === 'ok')
    fig[`${key}-v8`] = both.length ? `${geomean(both.map(e => 1 / jzOverV8(e))).toFixed(2)}× over ${both.length} of ${n}` : `none of ${n}`
  }
  for (const set of manifest.sets) figuresOf(`heldout-${set.id}`, set.programs)
  figuresOf('heldout', manifest.sets.flatMap(s => s.programs))
  return fig
}
