#!/usr/bin/env node
// Parallel landing battery: same legs as test:matrix + build/kernel/self/fuzz,
// run as a DAG instead of a serial chain — wall-clock ≈ the kernel leg alone
// (~3× faster than the serial form, identical coverage).
//
//   independent: native, O0, O3, dbg (O3 + JZ_DEBUG_INVARIANTS), wasi, fuzz
//   build → kernel, self          (kernel/self run the dist the build wrote)
//
// Usage: node scripts/battery.mjs            all legs
//        node scripts/battery.mjs fast       skip kernel+self+build (pre-flight)
import { spawn } from 'node:child_process'

const t0 = performance.now()
const run = (name, cmd, env = {}) => new Promise((resolve) => {
  const p = spawn('node', cmd, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', d => out += d)
  p.stderr.on('data', d => out += d)
  p.on('close', code => {
    const tail = out.trimEnd().split('\n').slice(-2).join(' | ').replace(/\x1b\[[0-9;]*m/g, '')
    const secs = ((performance.now() - t0) / 1000).toFixed(0)
    console.log(`${code === 0 ? '✓' : '✗'} ${name.padEnd(7)} [${secs}s] ${tail}`)
    resolve({ name, code, out })
  })
})

const fast = process.argv[2] === 'fast'
const legs = [
  run('native', ['test/index.js']),
  run('O0', ['test/index.js'], { JZ_TEST_OPTIMIZE: '0' }),
  run('O3', ['test/index.js'], { JZ_TEST_OPTIMIZE: '3' }),
  // The invariant moat: FunctionPlan freeze (reps read-only during emission),
  // IR verify at optimizeFunc entry+exit, rep-field checks, phase asserts —
  // all live only under JZ_DEBUG_INVARIANTS, so a battery without this leg
  // never runs them. One armed leg keeps the guarantees load-bearing.
  run('dbg', ['test/index.js'], { JZ_TEST_OPTIMIZE: '3', JZ_DEBUG_INVARIANTS: '1' }),
  run('wasi', ['test/index.js'], { JZ_TEST_HOST: 'wasi' }),
  run('fuzz', ['test/fuzz.js']),
  // Tier-2 local-optimality: is jz's own output a fixpoint of jz's own rewrite
  // system (re-running watr, config-matched, removes nothing)? A non-fixpoint
  // is a rewrite jz's pipeline could have made but didn't — see the script header.
  run('fixpoint', ['scripts/audit-fixpoint.mjs']),
]
if (!fast) legs.push((async () => {
  // Skip the ~5-min dist rebuild when no compiler input changed since the last
  // build (pure test/bench edits): hash src/ module/ index.js layout.js.
  const { createHash } = await import('node:crypto')
  const { readFileSync, readdirSync, statSync, writeFileSync, existsSync } = await import('node:fs')
  const h = createHash('sha256')
  const walk = (d) => { for (const f of readdirSync(d).sort()) { const p = `${d}/${f}`; statSync(p).isDirectory() ? walk(p) : f.endsWith('.js') && h.update(readFileSync(p)) } }
  for (const d of ['src', 'module']) walk(d)
  for (const f of ['index.js', 'layout.js', 'interop.js', 'transform.js']) h.update(readFileSync(f))
  const digest = h.digest('hex')
  const stamp = 'dist/.build-hash'
  const fresh = existsSync(stamp) && existsSync('dist/jz.wasm') && readFileSync(stamp, 'utf8') === digest
  let b = { name: 'build', code: 0 }
  if (fresh) console.log(`✓ build   [0s] unchanged (dist reused, hash ${digest.slice(0, 8)})`)
  else {
    b = await run('build', ['scripts/build-dist.mjs'])
    if (b.code === 0) writeFileSync(stamp, digest)
  }
  if (b.code !== 0) return [b, { name: 'kernel', code: -1 }, { name: 'self', code: -1 }]
  return [b, ...await Promise.all([
    run('kernel', ['test/index.js'], { JZ_TEST_TARGET: 'jz.wasm' }),
    run('self', ['test/selfhost.js']),
  ])]
})())

const results = (await Promise.all(legs)).flat(2)
const failed = results.filter(r => r.code !== 0)
// verdict FIRST (callers may tail-truncate; the verdict must survive any cut)
console.log(`\n${failed.length === 0 ? 'BATTERY GREEN' : 'BATTERY RED: ' + failed.map(f => f.name).join(', ')} (${((performance.now() - t0) / 60000).toFixed(1)} min)`)
for (const f of failed) console.log(`\n── ${f.name} ──\n${(f.out || '').split('\n').filter(l => l.includes('✗') || l.includes('fail')).slice(0, 20).join('\n')}`)
process.exit(failed.length ? 1 : 0)
