#!/usr/bin/env node
// The bench corpus's bytes against a base tree's: each case (the self-compile left out) at
// 'size' and 'speed', its bytes and a hash of them, here and in the tree of the base commit
// (`--base=<ref>`, the merge base with main unless named). What a change does to the output
// a landing reads here, case by case, before the bench workflow times it: a byte that moves
// where the change meant none to is the first sign of a pass that does more than it says
// (land-g's plasma lost a lift that only CI's integration suite showed). The base's hashes
// are kept in the temporary directory by commit, so landings on one base compute them once.
// Exits 1 when a case the base compiles fails to compile here; a moved byte is a report.
//
//   node scripts/bench-bytes.mjs [--base=<ref>] [--cases=a,b]   the report (--cases: those alone, the base not cached)
//   node scripts/bench-bytes.mjs --hash <root> <case>...        one JSON line a case (a worker)
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdtempSync, realpathSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runTasks } from './test-tasks.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const only = args.find(a => a.startsWith('--cases='))?.slice(8).split(',')

const cases = dir => readdirSync(join(dir, 'bench')).sort().filter(id => id !== 'jz' && existsSync(join(dir, 'bench', id, `${id}.js`)) && (!only || only.includes(id)))

async function hash(dir, ids) {
  const { compileJzAt } = await import(pathToFileURL(join(dir, 'bench/_lib/compile.js')))
  for (const id of ids) {
    const row = { id }
    for (const level of ['size', 'speed']) {
      try {
        const w = compileJzAt({ id, js: join(dir, 'bench', id, `${id}.js`) }, { level })
        row[level] = `${w.length}:${createHash('sha1').update(w).digest('hex').slice(0, 12)}`
      } catch (e) { row[level] = `ERR ${String(e.message).split('\n')[0].slice(0, 100)}` }
    }
    console.log(JSON.stringify(row))
  }
}

// Every case of `dir`, over JZ_TEST_JOBS worker processes: a Map of id to row.
async function corpus(dir, label) {
  const ids = cases(dir), jobs = Math.max(1, Math.min(Number(process.env.JZ_TEST_JOBS) || 1, ids.length))
  const parts = Array.from({ length: jobs }, (_, i) => ids.filter((_, k) => k % jobs === i))
  const logDir = mkdtempSync(join(tmpdir(), `jz-bench-bytes-${label}-`))
  const results = await runTasks(parts.map((p, i) => ({ name: `${label}-${i}`, args: [fileURLToPath(import.meta.url), '--hash', dir, ...p] })), { jobs, cwd: dir, logDir })
  const rows = new Map()
  for (const r of results) for (const line of readFileSync(r.log, 'utf8').split('\n')) if (line.startsWith('{')) { const row = JSON.parse(line); rows.set(row.id, row) }
  rmSync(logDir, { recursive: true, force: true })
  if (results.some(r => r.code)) throw new Error(`bench bytes: a ${label} worker failed`)
  return rows
}

const git = (...a) => {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

// The base commit's rows: from the cache, else hashed in a copy of its tree.
async function baseRows(ref) {
  const sha = git('rev-parse', ref), cache = join(tmpdir(), `jz-bench-bytes-${sha}.jsonl`)
  if (existsSync(cache) && !only) return { sha, rows: new Map(readFileSync(cache, 'utf8').trim().split('\n').map(l => JSON.parse(l)).map(r => [r.id, r])) }
  // (at its real path: bench/_lib/compile.js swaps the bench library into a case's module graph by its own real
  // path and the graph holds each file by the path it was entered through, so under a linked path, as the
  // system's temporary directory is on macOS, the swap misses and a case with a graph compiles to other bytes)
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'jz-bench-base-'))
  try {
    const tar = spawnSync('sh', ['-c', 'git archive "$1" | tar -x -C "$2"', 'sh', sha, dir], { cwd: root, encoding: 'utf8' })
    if (tar.status !== 0) throw new Error(`git archive ${sha}: ${tar.stderr}`)
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'))
    const rows = await corpus(dir, 'base')
    if (!only) writeFileSync(cache, [...rows.values()].map(r => JSON.stringify(r)).join('\n') + '\n')
    return { sha, rows }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const bytes = s => Number(String(s).split(':')[0])
const err = s => String(s).startsWith('ERR')

// Two corpora's rows (id to { size, speed }, each `<bytes>:<hash>` or `ERR ...`): the cases
// that moved, those that no longer compile, the byte sums of the cases both compile, a line each.
export function compareRows(base, here) {
  let moved = 0, broken = 0
  const sum = { size: [0, 0], speed: [0, 0] }, lines = []
  for (const [id, now] of here) {
    const was = base.get(id)
    if (!was) { lines.push(`${id}: a new case, size ${now.size}, speed ${now.speed}`); continue }
    for (const level of ['size', 'speed']) if (!err(was[level]) && !err(now[level])) { sum[level][0] += bytes(was[level]); sum[level][1] += bytes(now[level]) }
    if (was.size === now.size && was.speed === now.speed) continue
    moved++
    if ((err(now.size) && !err(was.size)) || (err(now.speed) && !err(was.speed))) broken++
    const d = level => err(now[level]) || err(was[level]) ? `${was[level]} -> ${now[level]}`
      : `${bytes(now[level]) - bytes(was[level]) >= 0 ? '+' : ''}${bytes(now[level]) - bytes(was[level])}${bytes(now[level]) === bytes(was[level]) && now[level] !== was[level] ? ' (same size, other bytes)' : ''}`
    lines.push(`${id}: size ${d('size')}, speed ${d('speed')}`)
  }
  return { moved, broken, sum, lines }
}

if (args[0] === '--hash') await hash(args[1], args.slice(2))
else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ref = args.find(a => a.startsWith('--base='))?.slice(7) || git('merge-base', 'HEAD', 'main')
  const t0 = performance.now()
  const { sha, rows: base } = await baseRows(ref), here = await corpus(root, 'head')
  const { moved, broken, sum, lines } = compareRows(base, here)
  console.log(`bench bytes against ${sha.slice(0, 9)} (${ref}): ${here.size} cases, moved ${moved}, ${broken} no longer compiling; size ${sum.size[0]} -> ${sum.size[1]} (${sum.size[1] - sum.size[0]}), speed ${sum.speed[0]} -> ${sum.speed[1]} (${sum.speed[1] - sum.speed[0]}); ${Math.round((performance.now() - t0) / 1000)} s`)
  for (const l of lines) console.log(`  ${l}`)
  process.exitCode = broken ? 1 : 0
}
