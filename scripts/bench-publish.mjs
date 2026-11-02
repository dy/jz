#!/usr/bin/env node
// Commit a merged benchmark dataset (bench/shards.mjs merge) to main.
//
//   node scripts/bench-publish.mjs --mode=ci|reference --dataset=<merged.json>
//
// ci writes bench/results-ci.json. reference writes bench/results.json and redraws what
// derives from it: bench/bench.svg (scripts/bench-svg.mjs, which refuses a dataset that
// leaves a chart lane without evidence) and bench/README.md's tables
// (scripts/bench-readme.mjs). Each attempt starts from the latest origin/main in a
// worktree of its own, so the caller's checkout is never touched and a concurrent
// commit is built on, never textually merged. Outcomes, every one stated in the log
// and the job summary:
//   published        exit 0
//   unchanged        exit 0: main already holds these bytes
//   superseded       exit 0, a warning: main holds evidence of a later commit
//   refused          exit 1: the measured commit is not on main, or a derived file
//                    cannot be drawn from the dataset
//   push failed      exit 1 after 3 attempts
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODES } from '../bench/shards.mjs'

const DERIVED = {
  ci: [],
  reference: [['scripts/bench-svg.mjs', 'bench/bench.svg'], ['scripts/bench-readme.mjs', 'bench/README.md']],
}
const ATTEMPTS = 3

const opt = name => process.argv.slice(2).find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const mode = opt('mode'), datasetPath = opt('dataset')
if (!MODES[mode] || !datasetPath) {
  console.error('usage: bench-publish.mjs --mode=ci|reference --dataset=<merged.json>')
  process.exit(2)
}
const file = `bench/${MODES[mode].file}`
const measured = JSON.parse(readFileSync(datasetPath, 'utf8')).meta?.commit

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
const ok = args => { try { git(args); return true } catch { return false } }
const say = (line, level) => {
  console.log(level ? `::${level}::${line}` : line)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
}

/** One attempt from the latest main: an outcome [exit code, line, level], or null to retry. */
const attempt = n => {
  git(['fetch', '--quiet', 'origin', 'main'])
  if (!ok(['merge-base', '--is-ancestor', measured, 'origin/main']))
    return [1, `${file} not published: the measured commit ${measured} is not on main (history rewritten?)`, 'error']
  let theirs = null
  try { theirs = JSON.parse(git(['show', `origin/main:${file}`])).meta?.commit } catch {}
  if (theirs && theirs !== measured && ok(['merge-base', '--is-ancestor', measured, theirs]))
    return [0, `${file} not published: main already holds evidence of ${theirs}, measured after ${measured}`, 'warning']
  const tree = mkdtempSync(join(tmpdir(), 'jz-bench-publish-'))
  try {
    git(['worktree', 'add', '--quiet', '--detach', tree, 'origin/main'])
    copyFileSync(datasetPath, join(tree, file))
    for (const [script, out] of DERIVED[mode]) {
      try { execFileSync(process.execPath, [join(tree, script)], { cwd: tree, stdio: 'inherit' }) }
      catch { return [1, `${file} not published: ${script} could not draw ${out} from the dataset`, 'error'] }
    }
    const paths = [file, ...DERIVED[mode].map(([, out]) => out)]
    git(['-C', tree, 'add', '--', ...paths])
    if (ok(['-C', tree, 'diff', '--cached', '--quiet'])) return [0, `${file} unchanged: main already holds this evidence of ${measured}`]
    git(['-C', tree, 'commit', '--quiet', '-m', `Refresh ${paths.join(', ')} from the sharded ${mode} run at ${measured} [skip ci]`])
    if (ok(['-C', tree, 'push', '--quiet', 'origin', 'HEAD:main']))
      return [0, `published ${paths.join(', ')} (measured at ${measured}) as ${git(['-C', tree, 'rev-parse', '--short', 'HEAD'])}`]
    say(`push attempt ${n} rejected: main moved; rebuilding on it`)
    return null
  } finally {
    rmSync(tree, { recursive: true, force: true })
    ok(['worktree', 'prune'])
  }
}

let outcome = /^[0-9a-f]{7,40}$/.test(measured ?? '') ? null : [1, `${datasetPath}: no measured commit (meta.commit ${measured})`, 'error']
for (let n = 1; !outcome && n <= ATTEMPTS; n++) outcome = attempt(n)
const [code, line, level] = outcome ?? [1, `${file} not published: ${ATTEMPTS} push attempts rejected`, 'error']
say(line, level)
process.exit(code)
