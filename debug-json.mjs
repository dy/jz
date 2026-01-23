import { compile as jzCompile } from './index.js';

const code = `
  export function test() {
    let obj = { x: 1, y: 2 }
    return JSON.stringify(obj)
  }
`;

try {
  const wat = jzCompile(code, { text: true });
  console.log('=== Generated WAT (test function only) ===\n');

  const lines = wat.split('\n');
  let inFunc = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('(func $test')) {
      inFunc = true;
    }
    if (inFunc) {
      console.log((i+1).toString().padStart(4), lines[i]);
      // Stop at next function definition
      if (i > 0 && lines[i].match(/^  \(func \$/) && !lines[i].includes('$test')) {
        break;
      }
    }
  }
} catch(e) {
  console.error(e.message);
}
