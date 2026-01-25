// Benchmark: Array push/pop/shift/unshift performance
// Verifies O(1) operations and ring buffer advantages

import { compile as jzCompile, instantiate } from './index.js'
import { compile as watrCompile } from 'watr'
import { performance } from 'perf_hooks'

const compile = (code, opts) => watrCompile(jzCompile(code, opts))

async function bench(name, code, warmup = 3) {
  const wasm = compile(code)
  const instance = await instantiate(wasm)

  // Warmup
  for (let i = 0; i < warmup; i++) instance.run(0)

  const start = performance.now()
  const result = instance.run(0)
  const elapsed = performance.now() - start

  console.log(`  ${name.padEnd(35)} ${elapsed.toFixed(3)}ms`)
  return { elapsed, result }
}

async function run() {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗')
  console.log('║           Array Operations Performance Benchmark               ║')
  console.log('╚═══════════════════════════════════════════════════════════════╝\n')

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 1: push O(1) - repeated push should scale linearly with N
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('1️⃣  push - O(1) amortized (flat array)')
  console.log(`    Building array via repeated push\n`)

  const push100 = `
    a = [];
    for (let i = 0; i < 100; i = i + 1) a = a.push(i);
    a.length
  `
  const push1k = `
    a = [];
    for (let i = 0; i < 1000; i = i + 1) a = a.push(i);
    a.length
  `

  const p1 = await bench('push x100', push100)
  const p2 = await bench('push x1000', push1k)

  const pushRatio = p2.elapsed / p1.elapsed
  console.log(`\n  Scaling: 10x elements → ${pushRatio.toFixed(1)}x time`)
  console.log(`  ${pushRatio < 15 ? '✓ O(1) amortized confirmed' : '✗ NOT O(1) - scaling too high'}\n`)

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 2: pop O(1) - repeated pop should be constant time
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('2️⃣  pop - O(1) (flat array)')
  console.log(`    Popping all elements from array\n`)

  const pop100 = `
    a = [];
    for (let i = 0; i < 100; i = i + 1) a = a.push(i);
    for (let i = 0; i < 100; i = i + 1) a.pop();
    a.length
  `
  const pop1k = `
    a = [];
    for (let i = 0; i < 1000; i = i + 1) a = a.push(i);
    for (let i = 0; i < 1000; i = i + 1) a.pop();
    a.length
  `

  const po1 = await bench('pop x100', pop100)
  const po2 = await bench('pop x1000', pop1k)

  const popRatio = po2.elapsed / po1.elapsed
  console.log(`\n  Scaling: 10x elements → ${popRatio.toFixed(1)}x time`)
  console.log(`  ${popRatio < 15 ? '✓ O(1) confirmed' : '✗ NOT O(1) - scaling too high'}\n`)

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 3: shift - ring buffer vs naive (O(1) vs O(n))
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('3️⃣  shift - O(1) via ring buffer')
  console.log(`    Shifting all elements (converted to ring on first unshift)\n`)

  const shift100 = `
    a = [];
    for (let i = 0; i < 100; i = i + 1) a = a.push(i);
    a = a.unshift(0);
    for (let i = 0; i < 100; i = i + 1) a.shift();
    a.length
  `
  const shift1k = `
    a = [];
    for (let i = 0; i < 1000; i = i + 1) a = a.push(i);
    a = a.unshift(0);
    for (let i = 0; i < 1000; i = i + 1) a.shift();
    a.length
  `

  const s1 = await bench('shift x100 (ring)', shift100)
  const s2 = await bench('shift x1000 (ring)', shift1k)

  const shiftRatio = s2.elapsed / s1.elapsed
  console.log(`\n  Scaling: 10x elements → ${shiftRatio.toFixed(1)}x time`)
  console.log(`  ${shiftRatio < 15 ? '✓ O(1) ring buffer confirmed' : '✗ NOT O(1) - possible regression'}\n`)

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 4: unshift - ring buffer O(1)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('4️⃣  unshift - O(1) via ring buffer')
  console.log(`    Building array via repeated unshift\n`)

  const unshift100 = `
    a = [];
    for (let i = 0; i < 100; i = i + 1) a = a.unshift(i);
    a.length
  `
  const unshift1k = `
    a = [];
    for (let i = 0; i < 1000; i = i + 1) a = a.unshift(i);
    a.length
  `

  const u1 = await bench('unshift x100', unshift100)
  const u2 = await bench('unshift x1000', unshift1k)

  const unshiftRatio = u2.elapsed / u1.elapsed
  console.log(`\n  Scaling: 10x elements → ${unshiftRatio.toFixed(1)}x time`)
  console.log(`  ${unshiftRatio < 15 ? '✓ O(1) ring buffer confirmed' : '✗ NOT O(1) - possible regression'}\n`)

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 5: Mixed operations - queue pattern (push back, shift front)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('5️⃣  Queue pattern (push + shift)')
  console.log(`    FIFO queue: push to back, shift from front\n`)

  const queue100 = `
    a = [];
    a = a.unshift(0);
    for (let i = 0; i < 100; i = i + 1) {
      a = a.push(i);
      a.shift();
    }
    a.length
  `
  const queue1k = `
    a = [];
    a = a.unshift(0);
    for (let i = 0; i < 1000; i = i + 1) {
      a = a.push(i);
      a.shift();
    }
    a.length
  `

  const q1 = await bench('queue x100', queue100)
  const q2 = await bench('queue x1000', queue1k)

  const queueRatio = q2.elapsed / q1.elapsed
  console.log(`\n  Scaling: 10x operations → ${queueRatio.toFixed(1)}x time`)
  console.log(`  ${queueRatio < 15 ? '✓ O(1) queue operations confirmed' : '✗ NOT O(1)'}\n`)

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 6: Stack pattern (push + pop) - pure flat array
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('6️⃣  Stack pattern (push + pop)')
  console.log(`    LIFO stack: push and pop from same end\n`)

  const stack100 = `
    a = [];
    for (let i = 0; i < 100; i = i + 1) {
      a = a.push(i);
      a.pop();
    }
    a.length
  `
  const stack1k = `
    a = [];
    for (let i = 0; i < 1000; i = i + 1) {
      a = a.push(i);
      a.pop();
    }
    a.length
  `

  const st1 = await bench('stack x100 (flat)', stack100)
  const st2 = await bench('stack x1000 (flat)', stack1k)

  const stackRatio = st2.elapsed / st1.elapsed
  console.log(`\n  Scaling: 10x operations → ${stackRatio.toFixed(1)}x time`)
  console.log(`  ${stackRatio < 15 ? '✓ O(1) stack operations confirmed' : '✗ NOT O(1)'}\n`)

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('╔═══════════════════════════════════════════════════════════════╗')
  console.log('║                          Summary                              ║')
  console.log('╠═══════════════════════════════════════════════════════════════╣')
  console.log('║  Operation      Type          Expected   Measured             ║')
  console.log('╠═══════════════════════════════════════════════════════════════╣')
  console.log(`║  push           flat_array    O(1)*      ${pushRatio.toFixed(1)}x for 10x elements    ║`)
  console.log(`║  pop            flat_array    O(1)       ${popRatio.toFixed(1)}x for 10x elements    ║`)
  console.log(`║  shift          ring_array    O(1)       ${shiftRatio.toFixed(1)}x for 10x elements    ║`)
  console.log(`║  unshift        ring_array    O(1)*      ${unshiftRatio.toFixed(1)}x for 10x elements    ║`)
  console.log('╠═══════════════════════════════════════════════════════════════╣')
  console.log('║  * amortized (occasional reallocation)                        ║')
  console.log('║  Expected scaling for O(1): ~10x time for 10x operations      ║')
  console.log('║  O(n) would show ~100x time for 10x operations                ║')
  console.log('╚═══════════════════════════════════════════════════════════════╝\n')

  // Final pass/fail
  const allPassed = pushRatio < 15 && popRatio < 15 && shiftRatio < 15 && unshiftRatio < 15
  console.log(allPassed
    ? '✅ All operations verified O(1)'
    : '❌ Some operations may not be O(1)')
}

run().catch(console.error)
