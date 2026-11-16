#!/usr/bin/env node
// The held-out lane's steps (bench/heldout/manifest.json; .github/workflows/heldout.yml
// runs them, in this order):
//
//   node scripts/heldout.mjs fetch <dir>               the pinned files, each checked against its blob id
//                                                      and against the sha256 the record first stored for it
//   node scripts/heldout.mjs generate <dir> <cases>    one driver a program, bench/<id>/<id>.js's shape, bundled
//                                                      by esbuild with nothing rewritten; <cases>/index.json lists them
//   node scripts/heldout.mjs check <cases> <dir>       V8 runs every driver and the set's own check (the dry run);
//                                                      exit 1 when a program does not pass it, or when one the
//                                                      manifest marks notMeasured does
//   node scripts/heldout.mjs registered <cases>        exit 1 when a program not yet measured was registered under
//                                                      a compiler that has changed since (a contact run refuses it)
//   node scripts/heldout.mjs record <cases> <bench.json>   append each program's entry to the record (the workflow's
//                                                      record job alone, on the latest main: --publish commits it)
//
// A program marked notMeasured (the manifest's header: a reason V8 alone shows, no result of
// jz's) keeps its driver for the check, under a name bench.mjs does not take, so no lane
// measures it and the record stores nothing of it.
//
// Options: --manifest=<path> (a fixture's), --sets=<id,…>, --record=<path>.
// The workflow is the only writer of the record and the only place a program is fetched:
// no step here is run by hand on a program of a set (the manifest's header says why).
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { mix } from '../bench/_lib/benchlib.js'
import { appendEntries, chainProblems, contactProblems, entryProblems, firstHashes, firstLine, LANES, MANIFEST, readJson, RECORD, registrationProblem, ROOT, rowOf, sha256 } from '../bench/heldout/lane.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const args = rest.filter(a => !a.startsWith('--'))
const opt = name => rest.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const manifestPath = resolve(ROOT, opt('manifest') ?? MANIFEST)
const recordPath = resolve(ROOT, opt('record') ?? RECORD)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const only = opt('sets')?.split(',')
const sets = manifest.sets.filter(s => !only || only.includes(s.id))
if (only) for (const id of only) if (!manifest.sets.some(s => s.id === id)) die(`no set ${id} in ${manifestPath}`)

function die(line) { console.error(line); process.exit(2) }
const say = line => {
  console.log(line)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
}
/** Git's id of a file's bytes: the manifest pins every file by it before any fetch. */
const blobOf = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
/** A set's files at its pinned commit: what a driver is made of and what checks it. */
const filesOf = set => [...set.programs.map(p => p.path), ...(set.support ?? []).map(f => f.path),
  ...(set.checks ?? []).map(f => f.path), ...(set.config ? [set.config.path] : [])]
const blobsOf = set => new Map([...set.programs, ...set.support ?? [], ...set.checks ?? [], ...set.config ? [set.config] : []].map(f => [f.path, f.blob]))
/** Where a set's files come from: its repository at its commit, or a fixture's directory. */
const origin = set => set.local ? `local:${set.local}` : set.repo
/** A program's driver: bench.mjs takes a case by <id>/<id>.js alone, and a program marked
 *  notMeasured is no case, so its driver, kept for the check, is named otherwise. */
const driverFile = (out, p) => join(out, p.id, p.notMeasured ? 'not-measured.js' : `${p.id}.js`)

// ── fetch ──
async function fetchSets(dir) {
  const known = firstHashes(readJson(recordPath, { entries: [] }).entries)
  const fetched = {}
  for (const set of sets) {
    const blobs = blobsOf(set)
    fetched[set.id] = {}
    for (const path of filesOf(set)) {
      let bytes
      if (set.local) bytes = readFileSync(join(ROOT, set.local, path))
      else {
        const url = `https://raw.githubusercontent.com/${set.repo}/${set.commit}/${path}`
        const res = await fetch(url)
        if (!res.ok) die(`${set.id}: ${url} answered ${res.status}`)
        bytes = Buffer.from(await res.arrayBuffer())
      }
      if (blobOf(bytes) !== blobs.get(path)) die(`${set.id}: ${path} is blob ${blobOf(bytes)}, the manifest pins ${blobs.get(path)}`)
      const h = sha256(bytes), first = known.get(`${origin(set)}:${path}`)
      if (first && first !== h) die(`${set.id}: ${path} hashes ${h}, the record first stored ${first}`)
      mkdirSync(dirname(join(dir, set.id, path)), { recursive: true })
      writeFileSync(join(dir, set.id, path), bytes)
      fetched[set.id][path] = h
    }
    say(`${set.id}: ${filesOf(set).length} files of ${origin(set)}${set.commit ? `@${set.commit.slice(0, 12)}` : ''}, each its pinned blob`)
  }
  writeFileSync(join(dir, 'fetched.json'), JSON.stringify(fetched, null, 2) + '\n')
}

// ── generate ──
const SHIM = join(ROOT, 'bench/heldout/shim.js')
const N_WARMUP = 1, N_RUNS = 5
/** The checksum of an AWFY driver whose every round verified: what V8 must print. */
const AWFY_VERIFIED = (() => { let h = 0x811c9dc5 | 0; for (let i = 0; i < N_WARMUP + N_RUNS; i++) h = mix(h, 1); return h >>> 0 })()

/** One bundle by esbuild (scripts/decode-cases.mjs's options; platform node, so a program
 *  that requires Node's own modules keeps them for the lanes that have them); the names its
 *  closing `export { … }` names bound in the program's scope. */
async function bundle(contents, root, resolveDir, extra = {}) {
  const { build } = await import('esbuild')
  const r = await build({
    stdin: { contents, resolveDir, loader: 'js', sourcefile: 'entry.js' },
    // paths in the bundle relative to the set's root: one driver on every machine
    absWorkingDir: root,
    bundle: true, format: 'esm', platform: 'node', target: 'es2020', write: false, minify: false,
    legalComments: 'none', logLevel: 'silent', ...extra,
  })
  const js = r.outputFiles[0].text
  const tail = js.match(/\nexport \{([^}]*)\};?\s*$/)
  if (!tail) throw Error('the bundle ends in no export list')
  const binds = tail[1].split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+as\s+/))
    .filter(([local, name = local]) => local !== name).map(([local, name]) => `const ${name} = ${local}`)
  // esbuild's require of a Node module in an ES module (its `__require` helper), given the host's
  const host = /^var __require = /m.test(js) ? `import { createRequire } from 'node:module'\nconst require = createRequire(import.meta.url)\n` : ''
  return { host, code: [js.slice(0, tail.index).trim(), ...binds].join('\n') }
}

const header = (set, p, what) => `// ${p.id}.js: ${what}, ${p.path} of ${set.name} (${origin(set)}${set.commit ? `@${set.commit}` : ''}),
// bundled by scripts/heldout.mjs: the program's own code, nothing rewritten. Generated
// in the held-out workflow from the pinned files; never edited, never committed.
import { medianUs, mix, printResult } from '../_lib/benchlib.js'
`

const DRIVERS = {
  // A program exports newInstance(), whose innerBenchmarkLoop(inner) answers whether every
  // result verified (benchmark.js): one instance, one call timed a round, every answer hashed.
  async awfy(set, p, dir) {
    const { host, code } = await bundle(`export const newInstance = require(${JSON.stringify(`./${basename(p.path)}`)}).newInstance`, dir, dirname(join(dir, p.path)))
    return { driver: header(set, p, `Are We Fast Yet's harness at ${p.inner} inner iterations`) + host + `
${code}

const N_WARMUP = ${N_WARMUP}
const N_RUNS = ${N_RUNS}
const INNER = ${p.inner}

const run = () => {
  const bench = newInstance()
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < N_WARMUP; i++) h = mix(h, bench.innerBenchmarkLoop(INNER) ? 1 : 0)
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    const verified = bench.innerBenchmarkLoop(INNER)
    samples[i] = performance.now() - t0
    h = mix(h, verified ? 1 : 0)
  }
  printResult(medianUs(samples), h >>> 0, INNER, 1, N_RUNS)
}

export { run as main }
`, expected: AWFY_VERIFIED }
  },
  // A program reads its size from process.argv[2] and prints its answer: its source is the
  // body of a function, a round one whole run, every character or byte it printed hashed.
  async clbg(set, p, dir) {
    const file = join(dir, p.path)
    const program = {
      name: 'heldout-program',
      setup(b) {
        b.onResolve({ filter: /^heldout:program$/ }, () => ({ path: p.path, namespace: 'heldout' }))
        b.onLoad({ filter: /.*/, namespace: 'heldout' }, () => ({ contents: `export function __program() {\n${readFileSync(file, 'utf8')}\n}\n`, resolveDir: dirname(file), loader: 'js' }))
      },
    }
    // the host beside the set's files, so the bundle names it by a path of no machine's
    const shim = join(dir, 'heldout-shim.js')
    copyFileSync(SHIM, shim)
    const { host, code } = await bundle(`export { __program } from 'heldout:program'\nexport { __heldout } from './heldout-shim.js'`, dir, dir, { inject: [shim], plugins: [program] })
    const driver = header(set, p, `the Benchmarks Game's command line at ${p.arg}`) + host + `
${code}

const N_WARMUP = ${N_WARMUP}
const N_RUNS = ${N_RUNS}
const ARG = ${JSON.stringify(String(p.arg))}

const run = () => {
  for (let i = 0; i < N_WARMUP; i++) { __heldout.start(ARG, false); __program() }
  const samples = new Float64Array(N_RUNS)
  let h = 0, same = 1
  for (let i = 0; i < N_RUNS; i++) {
    __heldout.start(ARG, false)
    const t0 = performance.now()
    __program()
    samples[i] = performance.now() - t0
    if (i === 0) h = __heldout.hash()
    else if (__heldout.hash() !== h) same = 0
  }
  printResult(medianUs(samples), same ? h : mix(h, 1), N_RUNS, 1, N_RUNS)
}

export { run as main }
`
    // the set's own check, V8 alone: the whole output at the size its <n>_out holds
    const check = `// ${p.id}'s check: its output at ${p.check.arg}, for ${p.check.path} (scripts/heldout.mjs check)\n${host}${code}\n\nexport const output = () => {\n  __heldout.start(${JSON.stringify(String(p.check.arg))}, true)\n  __program()\n  return __heldout.output()\n}\n`
    return { driver, check }
  },
}

async function generate(dir, out) {
  const fetched = readJson(join(dir, 'fetched.json'), null) ?? die(`${dir}: no fetched.json (run fetch first)`)
  mkdirSync(join(out, '_lib'), { recursive: true })
  copyFileSync(join(ROOT, 'bench/_lib/benchlib.js'), join(out, '_lib/benchlib.js'))
  const esbuild = JSON.parse(readFileSync(join(ROOT, 'node_modules/esbuild/package.json'), 'utf8')).version
  const index = { manifest: relative(ROOT, manifestPath), esbuild, programs: [] }
  for (const set of sets) {
    const make = DRIVERS[set.interface] ?? die(`${set.id}: no driver for the interface ${set.interface}`)
    const files = fetched[set.id] ?? die(`${set.id}: not fetched`)
    const shared = Object.fromEntries((set.support ?? []).map(f => [f.path, files[f.path]]))
    if (set.interface === 'clbg') shared['bench/heldout/shim.js'] = sha256(readFileSync(SHIM))
    for (const p of set.programs) {
      mkdirSync(join(out, p.id), { recursive: true })
      let made
      try { made = await make(set, p, join(dir, set.id)) }
      catch (e) {
        // a program esbuild cannot bundle is a row of every lane, not a program left out
        made = { error: String(e.message || e).split('\n').slice(0, 3).join(' ') }
        say(`${p.id}: not bundled: ${made.error}`)
      }
      if (made.driver) writeFileSync(driverFile(out, p), made.driver)
      if (made.check) writeFileSync(join(out, p.id, 'check.mjs'), made.check)
      index.programs.push({
        id: p.id, set: set.id, interface: set.interface, path: p.path, blob: p.blob, sha256: files[p.path],
        ...(p.notMeasured && { notMeasured: p.notMeasured }),
        // what its driver is made of and what checks it, each by the sha256 it was fetched at
        source: { repo: origin(set), commit: set.commit ?? null }, files: { ...shared, ...(p.check && { [p.check.path]: files[p.check.path] }) },
        ...(made.driver ? { driver: sha256(made.driver) } : { bundle: made.error }),
        ...(made.expected != null && { expected: made.expected }), ...(p.inner != null && { inner: p.inner }),
        ...(p.check && { check: p.check }),
      })
    }
  }
  writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  const marked = index.programs.filter(p => p.notMeasured).length
  say(`${index.programs.length} programs: ${index.programs.filter(p => p.driver).length} drivers in ${out}${marked ? `; ${marked} marked notMeasured, their drivers for the check alone` : ''}`)
}

// ── check (V8 alone) ──
const runV8 = (file, extra = []) => spawnSync(process.execPath, [...extra, join(ROOT, 'bench/_lib/run-v8.mjs'), file],
  { cwd: ROOT, encoding: 'utf8', timeout: 600_000, killSignal: 'SIGKILL' })
const metric = stdout => stdout?.match(/median_us=(\d+)\s+checksum=(\d+)/)
/** Why a run of V8 failed: the error's own line and where it was thrown (Node prints the
 *  place, the source line and a caret before it), else the output's first lines. */
const failureOf = r => {
  const lines = String(r.stderr || r.stdout || '').trim().split('\n')
  const error = lines.find(l => /^[A-Z]\w*( \[\w+\])?: /.test(l))
  const at = error && /:\d+$/.test(lines[0]) ? ` (${basename(lines[0])})` : ''
  return (error ? error + at : lines.slice(0, 2).join(' ') || String(r.signal || r.error?.message || 'no output')).slice(0, 300)
}

function checkPrograms(out, dir) {
  const index = readJson(join(out, 'index.json'), null) ?? die(`${out}: no index.json (run generate first)`)
  const results = {}
  let failed = 0, marked = 0
  for (const p of index.programs) {
    const verdict = (() => {
      if (!p.driver) return `not bundled: ${p.bundle}`
      const r = runV8(driverFile(out, p))
      const m = metric(r.stdout)
      if (!m) return `V8 did not run it: ${failureOf(r)}`
      const line = `V8 ${(m[1] / 1000).toFixed(1)} ms a round`
      if (p.interface === 'awfy') return +m[2] === p.expected ? `ok (${line})` : `V8 does not verify it at ${p.inner} inner iterations (${line}, checksum ${m[2]} where every round verified is ${p.expected})`
      if (p.interface === 'clbg') {
        const want = readFileSync(join(dir, p.set, p.check.path))
        const c = spawnSync(process.execPath, ['--input-type=module', '-e',
          `const { output } = await import(${JSON.stringify(pathToFileURL(join(out, p.id, 'check.mjs')).href)}); process.stdout.write(Buffer.from(output()))`],
        { cwd: ROOT, timeout: 600_000, killSignal: 'SIGKILL', maxBuffer: 1 << 28 })
        if (c.status !== 0) return `V8 did not run its check: ${failureOf(c)}`
        return Buffer.compare(c.stdout, want) === 0 ? `ok (${line}; ${p.check.path} matches byte for byte)` : `its output at ${p.check.arg} differs from ${p.check.path} (${c.stdout.length} bytes against ${want.length})`
      }
      return `no check for the interface ${p.interface}`
    })()
    const passes = verdict.startsWith('ok')
    // a program marked not measured must still fail: the mark ends when its reason does
    if (p.notMeasured && passes) {
      results[p.id] = `passes in V8 ${verdict.slice(3)}, where the manifest marks it notMeasured (${p.notMeasured}): the mark no longer holds`
      failed++
      say(`FAIL ${p.id}: ${results[p.id]}`)
    } else if (p.notMeasured) {
      results[p.id] = `not measured: ${p.notMeasured}`
      marked++
      say(`out  ${p.id}: not measured, as the manifest marks it (${p.notMeasured}); ${verdict}`)
    } else {
      results[p.id] = passes ? 'ok' : verdict
      if (!passes) failed++
      say(`${passes ? 'ok  ' : 'FAIL'} ${p.id}: ${verdict}`)
    }
  }
  // the inner iterations beside rebench.conf's lines that name each program (the manifest recalls them)
  for (const set of sets.filter(s => s.config)) {
    const conf = readFileSync(join(dir, set.id, set.config.path), 'utf8').split('\n')
    for (const p of set.programs) {
      const name = p.id.replace(`${set.id}-`, '')
      const lines = conf.filter(l => new RegExp(`\\b${name}\\b`, 'i').test(l)).map(l => l.trim()).slice(0, 4)
      console.log(`  ${p.id}: inner ${p.inner}; ${set.config.path}: ${lines.join(' | ') || 'no line names it'}`)
    }
  }
  writeFileSync(join(out, 'check.json'), JSON.stringify(results, null, 2) + '\n')
  const n = index.programs.length, also = marked ? `; ${marked} not measured (marked notMeasured, and failing in V8)` : ''
  say(failed ? `${failed} of ${n} programs do not pass the harness's check in V8${also}`
    : marked ? `${n - marked} of ${n} programs pass their check in V8${also}` : `every program of ${n} passes its check in V8`)
  return failed
}

// ── registered: a contact measures only what was registered under this compiler ──
function registered(out) {
  const index = readJson(join(out, 'index.json'), null) ?? die(`${out}: no index.json`)
  const contacted = new Set(readJson(recordPath, { entries: [] }).entries.filter(e => e.contact === 'first').map(e => e.program))
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const problems = index.programs.filter(p => !contacted.has(p.id) && !p.notMeasured)
    .map(p => registrationProblem(p.id, head, { manifest: relative(ROOT, manifestPath) }).problem).filter(Boolean)
  for (const line of problems) say(`refused: ${line}`)
  say(problems.length ? `${problems.length} programs refused: a first contact measures the compiler its program was registered under (the manifest's header)`
    : `every program not yet measured was registered under the compiler at ${head.slice(0, 9)}`)
  return problems.length
}

// ── record ──
function entriesFor(out, benchPath, record) {
  const index = readJson(join(out, 'index.json'), null) ?? die(`${out}: no index.json`)
  const checks = readJson(join(out, 'check.json'), {})
  const bench = JSON.parse(readFileSync(benchPath, 'utf8'))
  const compiler = execFileSync('git', ['rev-parse', bench.meta.commit], { cwd: ROOT, encoding: 'utf8' }).trim()
  const v = bench.meta.versions ?? {}
  const run = {
    id: process.env.GITHUB_RUN_ID ?? `local ${new Date().toISOString()}`,
    url: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    date: bench.meta.date, machine: bench.meta.host,
    versions: Object.fromEntries(['jz', 'watr', 'node', 'deno', 'bun', 'jsc', 'porffor'].filter(k => v[k]).map(k => [k, v[k]])
      .concat([['esbuild', index.esbuild]])),
  }
  const seen = new Set(record.entries.map(e => e.program))
  // a program marked not measured is no case and no lane runs it: a row of one means the
  // mark was not kept, and nothing of the run is recorded
  for (const p of index.programs.filter(p => p.notMeasured)) {
    if (bench.cases?.[p.id]) die(`${p.id}: ${benchPath} measured it, where the manifest marks it notMeasured (${p.notMeasured}): nothing is recorded`)
    say(`${p.id}: registered, not measured: ${p.notMeasured}`)
  }
  // a program the run did not reach stays unmeasured: no entry, no contact spent
  const reached = index.programs.filter(p => !p.notMeasured && (!p.driver || bench.cases?.[p.id]))
  for (const p of index.programs) if (!p.notMeasured && !reached.includes(p)) say(`${p.id}: no row in ${benchPath}, so not recorded`)
  return reached.map(p => {
    const c = bench.cases?.[p.id]
    const check = checks[p.id] ?? 'not checked'
    const oracleOk = check === 'ok' && c?.ref != null && (p.expected == null || c.ref === p.expected)
    const reg = registrationProblem(p.id, compiler, { manifest: index.manifest })
    const rows = Object.fromEntries(LANES.map(lane => [lane, !p.driver ? { result: 'compile', message: `esbuild could not bundle it: ${firstLine(p.bundle)}` }
      : rowOf(c?.targets?.[lane], oracleOk)]))
    return {
      program: p.id, set: p.set,
      source: { repo: p.source.repo, commit: p.source.commit, path: p.path, blob: p.blob, sha256: p.sha256 },
      files: p.files, driver: p.driver ?? null, compiler, registered: reg.registered ?? null,
      ...(!seen.has(p.id) && reg.problem && { refused: reg.problem }),
      contact: seen.has(p.id) ? 'tuned' : 'first', run,
      oracle: { checksum: c?.ref ?? null, check },
      rows, ...(c?.paired && { paired: c.paired }),
    }
  })
}

const ABOUT = 'The held-out lane\'s record (bench/heldout/manifest.json): append-only, written by .github/workflows/heldout.yml alone. Each entry is one program measured by one run, chained to the entry before it by its sha256 (bench/heldout/lane.mjs); a program\'s first contact is never replaced, a later measurement is stored beside it as tuned.'
const writeRecord = (path, record) => writeFileSync(path, `{\n  "about": ${JSON.stringify(record.about)},\n  "entries": [\n${record.entries.map(e => `    ${JSON.stringify(e)}`).join(',\n')}\n  ]\n}\n`)

function recordRun(out, benchPath) {
  const record = readJson(recordPath, { about: ABOUT, entries: [] })
  const problems = [...chainProblems(record.entries), ...contactProblems(record.entries)]
  if (problems.length) die(`${recordPath}: the record does not hold:\n${problems.join('\n')}`)
  const entries = entriesFor(out, benchPath, record)
  // a first contact of a compiler its program was not registered under is no first contact:
  // nothing is written (the contact run's precheck refuses it before measuring)
  const refused = entries.filter(e => e.refused)
  if (refused.length) die(`not recorded: first contacts of a compiler their programs were not registered under\n${refused.map(e => e.refused).join('\n')}`)
  const next = { ...record, entries: appendEntries(record.entries, entries) }
  const bad = [...entryProblems(next.entries.slice(record.entries.length), manifest)]
  if (bad.length) die(`not recorded:\n${bad.join('\n')}`)
  writeRecord(recordPath, next)
  for (const e of entries) say(`${e.contact === 'first' ? 'first contact' : 'tuned'} ${e.program}: ${LANES.map(l => `${l} ${e.rows[l].result}`).join(', ')}`)
  return entries
}

/** Each attempt from the latest main in a worktree of its own (scripts/bench-publish.mjs's way). */
function publish(out, benchPath) {
  const git = (a, o = {}) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim()
  const ok = a => { try { git(a); return true } catch { return false } }
  for (let n = 1; n <= 3; n++) {
    git(['fetch', '--quiet', 'origin', 'main'])
    const tree = mkdtempSync(join(tmpdir(), 'jz-heldout-publish-'))
    try {
      git(['worktree', 'add', '--quiet', '--detach', tree, 'origin/main'])
      const r = spawnSync(process.execPath, [join(tree, 'scripts/heldout.mjs'), 'record', out, benchPath, `--manifest=${relative(ROOT, manifestPath)}`], { cwd: tree, stdio: 'inherit' })
      if (r.status !== 0) die('the record was not written')
      git(['-C', tree, 'add', '--', RECORD])
      if (ok(['-C', tree, 'diff', '--cached', '--quiet'])) { say('the record is unchanged'); return }
      git(['-C', tree, 'commit', '--quiet', '-m', `Record the held-out lane's run ${process.env.GITHUB_RUN_ID ?? ''} at ${readJson(benchPath).meta.commit} [skip ci]`])
      if (ok(['-C', tree, 'push', '--quiet', 'origin', 'HEAD:main'])) { say(`published ${RECORD} as ${git(['-C', tree, 'rev-parse', '--short', 'HEAD'])}`); return }
      say(`push attempt ${n} rejected: main moved; recording on it again`)
    } finally {
      rmSync(tree, { recursive: true, force: true })
      ok(['worktree', 'prune'])
    }
  }
  die(`${RECORD} not published: 3 push attempts rejected`)
}

const usage = 'usage: heldout.mjs fetch <dir> | generate <dir> <cases> | check <cases> <dir> | registered <cases> | record <cases> <bench.json> [--publish]'
if (cmd === 'fetch' && args[0]) await fetchSets(resolve(args[0]))
// (the fetched files by their real path: esbuild names a file by it, relative to the set's root)
else if (cmd === 'generate' && args[1]) await generate(realpathSync(resolve(args[0])), resolve(args[1]))
else if (cmd === 'check' && args[1]) process.exit(checkPrograms(resolve(args[0]), resolve(args[1])) ? 1 : 0)
else if (cmd === 'registered' && args[0]) process.exit(registered(resolve(args[0])) ? 1 : 0)
else if (cmd === 'record' && args[1]) rest.includes('--publish') ? publish(resolve(args[0]), resolve(args[1])) : recordRun(resolve(args[0]), resolve(args[1]))
else die(usage)
