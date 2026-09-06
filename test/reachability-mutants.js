// The reachability suite (test/reachability.js) under each compiler mutant of
// test/_mutations.js, in its own process with the mutant's edit applied as the
// module loads (test/_mutant.mjs). A mutant whose outcome is `fail` must make
// the suite fail, and must do so in the behavioral tests, not only in the
// ProgramIndex/output census: the gate holds without the census. The unmutated
// suite must pass in the same way.
//
// Run: node test/reachability-mutants.js   (or one mutant by hand:
//      JZ_MUTANT=root-export-alias node --import ./test/_mutant.mjs test/reachability.js)
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { MUTANTS } from './_mutations.js'
import { onKernel } from './_matrix.js'

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '')
const run = (env = {}, args = []) => {
  const r = spawnSync(process.execPath, [...args, new URL('./reachability.js', import.meta.url).pathname],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 300_000 })
  const out = strip(r.stdout + r.stderr)
  const failed = [...out.matchAll(/✗ (reachability(?: census)?: [^:\n]+)/g)].map(m => m[1])
  return { status: r.status, out, failed, behavioral: failed.filter(t => !t.startsWith('reachability census')), census: failed.filter(t => t.startsWith('reachability census')) }
}

test('mutants: the unmutated suite passes', () => {
  if (onKernel()) return
  const r = run()
  is(r.status, 0, r.status === 0 ? 'exit 0' : r.out.slice(-600))
  is(r.failed, [])
})

for (const [name, { outcome }] of Object.entries(MUTANTS)) test(`mutants: ${name} makes the suite ${outcome}`, () => {
  if (onKernel()) return
  const r = run({ JZ_MUTANT: name }, ['--import', './test/_mutant.mjs'])
  if (outcome === 'fail') {
    ok(r.status !== 0, `exit ${r.status}`)
    ok(r.behavioral.length > 0, `behavioral tests fail: ${r.behavioral.join(' | ') || '(none)'}`)
    ok(r.census.length > 0, `the census diagnostic agrees: ${r.census.join(' | ') || '(none)'}`)
  } else {
    is(r.status, 0, r.status === 0 ? 'exit 0' : r.out.slice(-600)); is(r.failed, [])
  }
})

test('mutants: an unknown mutant or an edit that does not apply rejects the run instead of testing the real compiler', () => {
  if (onKernel()) return
  const unknown = run({ JZ_MUTANT: 'no-such-mutant' }, ['--import', './test/_mutant.mjs'])
  ok(unknown.status !== 0 && unknown.out.includes('unknown mutant no-such-mutant'))
  const stale = run({ JZ_MUTANT_EDITS: JSON.stringify({ 'src/compile/program-index.js': [['this text is not in the module', 'x']] }) }, ['--import', './test/_mutant.mjs'])
  ok(stale.status !== 0 && stale.out.includes('contains "this text is not in the module" nowhere'), 'an edit that finds nothing rejects the load')
})
