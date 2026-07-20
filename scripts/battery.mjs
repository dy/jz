#!/usr/bin/env node
// Parallel landing battery: same legs as test:matrix + build/kernel/self/fuzz,
// run as a DAG instead of a serial chain — wall-clock ≈ the kernel leg alone
// (~3× faster than the serial form, identical coverage).
//
//   independent: native, O0, O3, wasi, fuzz
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
  run('wasi', ['test/index.js'], { JZ_TEST_HOST: 'wasi' }),
  run('fuzz', ['test/fuzz.js']),
]
if (!fast) legs.push(
  run('build', ['scripts/build-dist.mjs']).then(async (b) => {
    if (b.code !== 0) return [b, { name: 'kernel', code: -1 }, { name: 'self', code: -1 }]
    return [b, ...await Promise.all([
      run('kernel', ['test/index.js'], { JZ_TEST_TARGET: 'jz.wasm' }),
      run('self', ['test/selfhost.js']),
    ])]
  })
)

const results = (await Promise.all(legs)).flat(2)
const failed = results.filter(r => r.code !== 0)
console.log(`\n${failed.length === 0 ? 'BATTERY GREEN' : 'BATTERY RED: ' + failed.map(f => f.name).join(', ')} (${((performance.now() - t0) / 60000).toFixed(1)} min)`)
for (const f of failed) console.log(`\n── ${f.name} ──\n${(f.out || '').split('\n').filter(l => l.includes('✗') || l.includes('fail') || l.includes('Error')).slice(0, 20).join('\n')}`)
process.exit(failed.length ? 1 : 0)
