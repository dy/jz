import('./index.js').then(async ({compile: jzCompile, instantiate}) => {
  const { compile: watrCompile } = await import('watr')
  const compile = (code, opts) => watrCompile(jzCompile(code, opts))

  console.log('=== Static vs Dynamic Array Allocation ===\n');

  // Static array - no heap allocation
  const staticCode = '[10, 20, 30, 40, 50].reduce((a, b) => a + b, 0)';
  const staticWasm = compile(staticCode, {gc: false});
  const staticM = await instantiate(staticWasm);
  console.log('Static array reduce:', staticM.main());

  // Test many iterations with static arrays
  let errors = 0;
  for (let i = 0; i < 100000; i++) {
    try {
      staticM.main();
    } catch(e) {
      errors++;
      break;
    }
  }
  console.log(`Static array: 100,000 iterations - ${errors === 0 ? 'SUCCESS (no memory issues)' : 'FAILED'}\n`);

  // Dynamic array - uses heap
  const dynamicCode = 'a = [1, 2, 3]; a[0] = 99; a[0]';
  const dynamicWasm = compile(dynamicCode, {gc: false});
  const dynamicM = await instantiate(dynamicWasm);
  console.log('Dynamic array modify:', dynamicM.main());

  // Test iterations until heap exhaustion
  let dynamicErrors = 0;
  for (let i = 0; i < 10000; i++) {
    try {
      dynamicM.main();
    } catch(e) {
      dynamicErrors = i;
      break;
    }
  }
  console.log(`Dynamic array: Failed at iteration ${dynamicErrors} (heap exhaustion after ~${dynamicErrors * 24} bytes allocated)\n`);
}).catch(console.error);
