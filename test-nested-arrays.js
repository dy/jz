// Comprehensive nested array tests for both GC modes
import { strict as assert } from 'assert'
import { compile as jzCompile, instantiate } from './index.js'
import { compile as watrCompile } from 'watr'

// Helper: compile JS to WASM binary
const compile = (code, opts) => watrCompile(jzCompile(code, opts))

const tests = []
let passed = 0, failed = 0

async function test(name, code, expected, gc = true) {
  try {
    const wasm = compile(code, { gc })
    const m = await instantiate(wasm)
    const result = m.main()

    // For nested structures, just check type or basic equality
    if (typeof expected === 'number') {
      assert.strictEqual(result, expected, `${name} failed`)
    }
    console.log(`✓ ${name} (gc=${gc})`)
    passed++
  } catch(e) {
    console.error(`✗ ${name} (gc=${gc}): ${e.message}`)
    failed++
  }
}

async function run() {
  console.log('=== Nested Array Tests ===\n')

  // Test 1: Static nested numbers
  console.log('1️⃣  Static nested number arrays')
  await test('nested [1,2],[3,4] - access [0][0]', '[[1, 2], [3, 4]][0][0]', 1, true)
  await test('nested [1,2],[3,4] - access [0][0]', '[[1, 2], [3, 4]][0][0]', 1, false)
  await test('nested [1,2],[3,4] - access [1][1]', '[[1, 2], [3, 4]][1][1]', 4, true)
  await test('nested [1,2],[3,4] - access [1][1]', '[[1, 2], [3, 4]][1][1]', 4, false)

  // Test 2: Nested array reduce
  console.log('\n2️⃣  Nested array operations')
  await test('nested array map', '[[1, 2], [3, 4]].map(a => a[0]).reduce((a,b) => a+b, 0)', 4, true)
  await test('nested array map', '[[1, 2], [3, 4]].map(a => a[0]).reduce((a,b) => a+b, 0)', 4, false)

  // Test 3: Mixed types in nested arrays (strings with numbers)
  console.log('\n3️⃣  Mixed element types (strings + numbers)')
  await test('array of mixed ["a", 1, "b"]', '["a", 1, "b"].length', 3, true)
  await test('array of mixed ["a", 1, "b"]', '["a", 1, "b"].length', 3, false)

  // Test 4: Array with string access
  console.log('\n4️⃣  String + array combinations')
  await test('string access [0]', '"hello"[0].charCodeAt(0)', 104, true)  // 'h'
  await test('string access [0]', '"hello"[0].charCodeAt(0)', 104, false)

  // Test 5: Deeply nested (3 levels)
  console.log('\n5️⃣  Deeply nested arrays (3 levels)')
  await test('[[[1]]][0][0][0]', '[[[1]]][0][0][0]', 1, true)
  await test('[[[1]]][0][0][0]', '[[[1]]][0][0][0]', 1, false)

  // Test 6: Static nested arrays (compile-time)
  console.log('\n6️⃣  Static nested arrays (zero allocation)')
  await test('static [[10,20],[30,40]][1][0]', '[[10,20],[30,40]][1][0]', 30, true)
  await test('static [[10,20],[30,40]][1][0]', '[[10,20],[30,40]][1][0]', 30, false)

  // Test 7: Array length on nested
  console.log('\n7️⃣  Array length on nested arrays')
  await test('[[1,2],[3,4,5]].length', '[[1,2],[3,4,5]].length', 2, true)
  await test('[[1,2],[3,4,5]].length', '[[1,2],[3,4,5]].length', 2, false)
  await test('[[1,2],[3,4,5]][1].length', '[[1,2],[3,4,5]][1].length', 3, true)
  await test('[[1,2],[3,4,5]][1].length', '[[1,2],[3,4,5]][1].length', 3, false)

  // Test 8: Dynamic nested (with variables)
  console.log('\n8️⃣  Dynamic nested arrays (computed)')
  await test('a=[1,2]; b=[a]; b[0][0]', 'a=[1,2]; b=[a]; b[0][0]', 1, true)
  await test('a=[1,2]; b=[a]; b[0][0]', 'a=[1,2]; b=[a]; b[0][0]', 1, false)

  console.log(`\n════════════════════════════`)
  console.log(`Total: ${passed + failed} | Pass: ${passed} | Fail: ${failed}`)
  console.log(`════════════════════════════\n`)

  if (failed > 0) process.exit(1)
}

run().catch(console.error)
