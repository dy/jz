/**
 * Pins scripts/refactor-oracle.mjs's core determinism guarantee: snapshotting
 * the SAME sources twice, in two independent compile() passes, must produce
 * byte-identical hashes. Any nondeterminism in the compiler (Map/Set
 * iteration over unordered construction, Date, unseeded Math.random, a
 * host-dependent float fold) would show up here as a flaky assertion — that
 * is a compiler bug to fix, not a test to relax.
 *
 * Deliberately NOT registered in test/index.js: that file has uncommitted
 * changes owned by another in-flight session on this repo. Run standalone
 * until it's wired in:
 *   node test/refactor-oracle.js
 */
import test from 'tst'
import { is } from 'tst/assert.js'
import { compile } from '../index.js'
import { LEVELS, levelKey, runSpec, hashBuffer } from '../scripts/refactor-oracle.mjs'

// A tiny, self-contained 3-specimen corpus — deliberately independent of
// bench/examples/kernel-parity so this test has no directory-layout
// dependency and stays fast (a handful of ms per level).
const MINI_CORPUS = [
  { name: 'sum', code: `export let sum = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s }`, opts: {} },
  { name: 'dict', code: `export let count = (s) => { let d = {}; for (let i = 0; i < s.length; i++) { let c = s[i]; d[c] = (d[c] || 0) + 1 } return d['a'] || 0 }`, opts: {} },
  { name: 'arr', code: `export let rev = (n) => { let a = []; for (let i = 0; i < n; i++) a.push(i * 2); let s = 0; for (let i = a.length - 1; i >= 0; i--) s += a[i]; return s }`, opts: {} },
]

function snapshotMini() {
  const entries = {}
  for (const spec of MINI_CORPUS) {
    for (const level of LEVELS) {
      entries[`${spec.name}|${levelKey(level)}`] = runSpec(compile, spec, level)
    }
  }
  return entries
}

test('refactor-oracle: two consecutive snapshots of the same tree are byte-identical', () => {
  const a = snapshotMini()
  const b = snapshotMini()
  is(Object.keys(a).length, MINI_CORPUS.length * LEVELS.length, 'sanity: expected entry count')
  for (const key of Object.keys(a)) {
    const ea = a[key], eb = b[key]
    is(ea.ok, true, `${key}: expected a clean compile (${ea.ok ? '' : ea.errorClass + ': ' + ea.errorMessage})`)
    is(eb.ok, true, `${key}: expected a clean compile on the second pass`)
    is(ea.sha256, eb.sha256, `${key}: hash must be identical across two snapshots (bytes=${ea.bytes} vs ${eb.bytes})`)
    is(ea.bytes, eb.bytes, `${key}: byte length must be identical across two snapshots`)
  }
})

test('refactor-oracle: hashBuffer is a pure function of its bytes', () => {
  const buf = new Uint8Array([1, 2, 3, 4, 5])
  is(hashBuffer(buf), hashBuffer(new Uint8Array([1, 2, 3, 4, 5])), 'same bytes, same hash')
})
