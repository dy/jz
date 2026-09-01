// Canonical unmodified sources for the compact scalar-core gate. Production
// tests and the isolated prototype runner consume these records directly.

const makeCase = (id, name, source, calls = [], groups = []) => Object.freeze({
  id,
  name,
  source,
  calls: Object.freeze(calls.map(call => Object.freeze([
    call[0], Object.freeze(call[1].slice()), call[2],
  ]))),
  groups: Object.freeze(groups.slice()),
})

export const SCALAR_CORE_CASES = Object.freeze([
  makeCase('block-let-return', 'block: let + return',
    'export let f = (x) => { let y = x * 2; return y + 1 }',
    [['f', [3], 7]], ['statements']),
  makeCase('assignment-set', 'assignment: =',
    'export let f = (x) => { let y = 0; y = x * 2; return y }',
    [['f', [5], 10]], ['statements']),
  makeCase('assignment-sub', 'assignment: -=',
    'export let f = (x) => { let y = 10; y -= x; return y }',
    [['f', [3], 7]], ['statements']),
  makeCase('assignment-mul', 'assignment: *=',
    'export let f = (x) => { let y = 3; y *= x; return y }',
    [['f', [4], 12]], ['statements']),
  makeCase('assignment-div', 'assignment: /=',
    'export let f = (x) => { let y = 20; y /= x; return y }',
    [['f', [4], 5]], ['statements']),
  makeCase('if-else-return', 'if-else: both branches return',
    'export let f = (x) => { if (x > 0) return 1; else return -1 }',
    [['f', [5], 1], ['f', [-5], -1]], ['statements']),
  makeCase('if-nan-falsy', 'if(NaN) is falsy',
    'export let f = (x) => { if (x) return 1; return 0 }',
    [['f', [NaN], 0]], ['statements']),
  makeCase('if-zero-falsy', 'if(0) still falsy',
    'export let f = (x) => { if (x) return 1; return 0 }',
    [['f', [0], 0]], ['statements']),
  makeCase('if-one-truthy', 'if(1) still truthy',
    'export let f = (x) => { if (x) return 1; return 0 }',
    [['f', [1], 1]], ['statements']),
  makeCase('postfix-side-effect', 'postfix increments side effect',
    'export let f = () => { let i = 5; i++; return i }',
    [['f', [], 6]], ['statements']),
  makeCase('for-sum', 'for: sum 0..n', `export let f = (n) => {
    let s = 0
    for (let i = 0; i < n; i++) s += i
    return s
  }`, [['f', [0], 0], ['f', [1], 0], ['f', [5], 10], ['f', [10], 45]], ['statements']),
  makeCase('for-factorial', 'for: factorial', `export let f = (n) => {
    let r = 1
    for (let i = 1; i <= n; i++) r *= i
    return r
  }`, [['f', [0], 1], ['f', [1], 1], ['f', [5], 120]], ['statements']),
  makeCase('for-nested', 'for: nested', `export let f = (a, b) => {
    let s = 0
    for (let i = 0; i < a; i++)
      for (let j = 0; j < b; j++)
        s += i * j
    return s
  }`, [['f', [3, 3], 9]], ['statements']),
  makeCase('prefix-increment-value', 'prefix ++i returns new',
    'export let f = () => { let i = 5; return ++i }',
    [['f', [], 6]], ['statements', 'control']),
  makeCase('postfix-increment-value', 'postfix i++ returns old',
    'export let f = () => { let i = 5; return i++ }',
    [['f', [], 5]], ['statements', 'control']),
  makeCase('prefix-decrement-value', 'prefix --i returns new',
    'export let f = () => { let i = 5; return --i }',
    [['f', [], 4]], ['statements', 'control']),
  makeCase('postfix-decrement-value', 'postfix i-- returns old',
    'export let f = () => { let i = 5; return i-- }',
    [['f', [], 5]], ['statements', 'control']),
  makeCase('assign-postfix-value', 'assign postfix: x = i++',
    'export let f = () => { let i = 5; let x = i++; return x }',
    [['f', [], 5]], ['statements', 'control']),
  makeCase('assign-prefix-value', 'assign prefix: x = ++i',
    'export let f = () => { let i = 5; let x = ++i; return x }',
    [['f', [], 6]], ['statements', 'control']),
  makeCase('comma-last', 'comma: returns last value',
    'export let f = () => { let a = (1, 2, 3); return a }',
    [['f', [], 3]], ['statements', 'control']),
  makeCase('comma-effects', 'comma: side effects',
    'export let f = () => { let i = 0; i++, i++; return i }',
    [['f', [], 2]], ['statements', 'control']),
  makeCase('comma-grouped-call', 'comma: parenthesized comma-expression is one argument',
    'let g = (x) => x + 1; export let f = () => g((1, 2, 7))',
    [['f', [], 8]], ['statements', 'control']),
  makeCase('comma-grouped-nested-call', 'comma: nested parenthesized expression is one argument',
    'let g = (x) => x + 1; export let f = () => g(((1, 2, 7)))',
    [['f', [], 8]], ['statements', 'control']),
  makeCase('comma-grouped-second-arg', 'comma: grouped second argument remains distinct',
    'let g = (a, b) => a + b; export let f = () => g(100, (1, 2, 7))',
    [['f', [], 107]], ['statements', 'control']),
  makeCase('for-omitted-init-step', 'for: omitted init and step with condition', `export let f = () => {
    let i = 0
    for (; i < 4; ) i++
    return i
  }`, [['f', [], 4]], ['statements', 'control']),
  makeCase('for-infinite-return', 'for: omitted init condition and step', `export let f = () => {
    let i = 0
    for (;;) {
      i++
      if (i == 4) return i
    }
  }`, [['f', [], 4]], ['statements', 'control']),
  makeCase('do-basic', 'do-while: basic', `export let f = (n) => {
    let s = 0, i = 0
    do { s += i; i++ } while (i < n)
    return s
  }`, [['f', [5], 10], ['f', [0], 0]], ['statements', 'control']),
  makeCase('do-once', 'do-while: executes body at least once',
    'export let f = () => { let x = 0; do { x++ } while (0); return x }',
    [['f', [], 1]], ['statements', 'control']),
  makeCase('do-continue-condition', 'do-while: continue runs condition', `export let f = () => {
    let s = 0, i = 0
    do { i++; if (i == 3) continue; s += i } while (i < 5)
    return s
  }`, [['f', [], 12]], ['statements', 'control']),
  makeCase('do-strict', 'do-while: works in strict mode',
    'export let f = (n) => { let i = 0; do { i++ } while (i < n); return i }',
    [['f', [5], 5], ['f', [0], 1]], ['statements', 'control']),
  makeCase('do-break', 'do-while: break',
    'export let f = () => { let s = 0; do { s++; if (s == 3) break } while (1); return s }',
    [['f', [], 3]], ['statements', 'control']),
  makeCase('do-continue-exit', 'do-while: continue at terminating condition exits', `export let f = () => {
    let count = 0
    do { count++; if (count >= 3) continue } while (count < 3)
    return count
  }`, [['f', [], 3]], ['statements', 'control']),
  makeCase('do-nested', 'do-while: nested', `export let f = () => {
    let s = 0, i = 0
    do {
      let j = 0
      do { s++; j++ } while (j < 3)
      i++
    } while (i < 2)
    return s
  }`, [['f', [], 6]], ['statements', 'control']),
  makeCase('break-loop', 'break: exits loop',
    'export let f = () => { let s = 0; for (let i = 0; i < 5; i++) { if (i == 3) break; s += i } return s }',
    [['f', [], 3]], ['statements', 'control']),
  makeCase('break-labeled-if', 'break: exits labeled if statement',
    'export let f = (x) => { let s = 0; out: if (x) { s++; break out; s += 10 } return s }',
    [['f', [1], 1], ['f', [0], 0]], ['statements', 'control']),
  makeCase('break-labeled-outer', 'break: exits labeled outer loop from nested loop',
    'export let f = () => { let s = 0; outer: for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) { s++; if (i == 1 && j == 1) break outer } } return s }',
    [['f', [], 6]], ['statements', 'control']),
  makeCase('continue-labeled-outer', 'continue: labeled continue targets outer loop',
    'export let f = () => { let s = 0; outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j == 1) continue outer; s += 10 } } return s }',
    [['f', [], 30]], ['statements', 'control']),
  makeCase('continue-labeled-while', 'continue: labeled continue on while',
    'export let f = () => { let s = 0, i = 0; outer: while (i < 3) { i++; let j = 0; while (j < 3) { j++; if (j == 2) continue outer; s++ } } return s }',
    [['f', [], 3]], ['statements', 'control']),
  makeCase('continue-skip', 'continue: skips iteration',
    'export let f = () => { let s = 0; for (let i = 0; i < 5; i++) { if (i == 2) continue; s += i } return s }',
    [['f', [], 8]], ['statements', 'control']),
  makeCase('logical-and', '&&: short-circuit',
    'export let f = (a, b) => a && b',
    [['f', [3, 5], 5], ['f', [0, 5], 0], ['f', [NaN, 5], NaN]], ['statements', 'control']),
  makeCase('logical-or', '||: short-circuit',
    'export let f = (a, b) => a || b',
    [['f', [3, 5], 3], ['f', [0, 5], 5], ['f', [NaN, 5], 5]], ['statements', 'control']),
  makeCase('logical-and-chain', '&&: chained',
    'export let f = (a, b, c) => a && b && c',
    [['f', [1, 2, 3], 3], ['f', [1, 0, 3], 0]], ['statements', 'control']),
  makeCase('logical-or-chain', '||: chained',
    'export let f = (a, b, c) => a || b || c',
    [['f', [0, 0, 3], 3], ['f', [0, 2, 3], 2]], ['statements', 'control']),
  makeCase('preeval-numeric-chain', 'fold-fires: numeric chain -> literal, no arithmetic ops',
    'export let f = () => 1 + 2 * 3 - 4',
    [['f', [], 3]], ['preeval', 'wat-fold']),
  makeCase('preeval-dead-if', 'fold-fires: dead if-branch eliminated',
    'export let f = () => { if (1 < 2) { return 10 } else { return 20 } }',
    [['f', [], 10]], ['preeval', 'wat-fold']),
  makeCase('preeval-while-false', 'fold-fires: while(false) removed entirely',
    'export let f = () => { let x = 0; while (false) { x = x + 1 } return x }',
    [['f', [], 0]], ['preeval', 'wat-fold']),
  makeCase('preeval-constant-power', 'value: constant integer power',
    'export let f = () => 2 ** 10',
    [['f', [], 1024]], ['preeval']),
  makeCase('preeval-constant-remainder', 'value: constant remainder',
    'export let f = () => 7 % 3',
    [['f', [], 1]], ['preeval']),
  makeCase('unsigned-export-boundary', 'uint32: export boundary',
    'export let main = (x) => x >>> 0',
    [['main', [-1], 4294967295], ['main', [-2147483648], 2147483648],
      ['main', [0], 0], ['main', [2147483647], 2147483647]], ['unsigned', 'integer']),
  makeCase('unsigned-unit-interval', 'uint32: unit interval',
    'export let main = (x) => (x >>> 0) / 4294967296',
    [['main', [-1], 4294967295 / 4294967296], ['main', [0], 0]], ['unsigned', 'integer']),
  makeCase('unsigned-tail-helper', 'uint32: helper result',
    'let toU32 = (x) => x >>> 0; export let main = (x) => toU32(x)',
    [['main', [-1], 4294967295]], ['unsigned', 'integer']),
  makeCase('unsigned-tail-chain', 'uint32: two-call result chain', `
    let a = (x) => x >>> 0
    let b = (x) => a(x)
    export let main = (x) => b(x)
  `, [['main', [-1], 4294967295]], ['unsigned', 'integer']),
  makeCase('unsigned-call-arithmetic', 'uint32: arithmetic after helper',
    'let u = (x) => x >>> 0; export let main = (x) => u(x) + 1',
    [['main', [-1], 4294967296]], ['unsigned', 'integer']),
  makeCase('unsigned-mixed-return', 'uint32: mixed signed return tails',
    'export let main = (x) => { if (x < 0) return x | 0; return x >>> 0 }',
    [['main', [-1], -1], ['main', [5], 5]], ['unsigned', 'integer']),
  makeCase('unsigned-arithmetic', 'uint32: arithmetic widens',
    'export let main = (x) => (x >>> 0) + 1',
    [['main', [-1], 4294967296], ['main', [0], 1], ['main', [2147483648], 2147483649]], ['unsigned', 'integer']),
  makeCase('unsigned-local-return', 'uint32: local binding return',
    'export let main = (x) => { let u = x >>> 0; return u }',
    [['main', [-1], 4294967295]], ['unsigned', 'integer']),
  makeCase('unsigned-accumulator-wrap', 'uint32: accumulator wraps', `export let main = () => {
    let h = 0
    h = (h + 4294967290) >>> 0
    h = (h + 10) >>> 0
    return h
  }`, [['main', [], 4]], ['unsigned', 'integer']),
  makeCase('assignment-shr', 'assignment: >>=',
    'export let f = () => { let a = 256; a >>= 4; return a }',
    [['f', [], 16]], ['statements', 'integer']),
  makeCase('assignment-shl', 'assignment: <<=',
    'export let f = () => { let a = 1; a <<= 4; return a }',
    [['f', [], 16]], ['statements', 'integer']),
  makeCase('assignment-ushr', 'assignment: >>>=',
    'export let f = () => { let a = -1; a >>>= 24; return a }',
    [['f', [], 255]], ['statements', 'unsigned', 'integer']),
  makeCase('math-clz32', 'Math.clz32',
    'export let f = (x) => Math.clz32(x)',
    [['f', [1], 31], ['f', [2], 30], ['f', [4], 29], ['f', [256], 23], ['f', [0], 32]], ['math', 'integer']),
  makeCase('math-imul', 'Math.imul',
    'export let f = (a, b) => Math.imul(a, b)',
    [['f', [3, 4], 12], ['f', [5, 5], 25], ['f', [-1, 8], -8], ['f', [-1, 5], -5]], ['math', 'integer']),
  makeCase('differential-bitwise-mix', 'differential: bitwise mix',
    'export let f = (a, b) => { let x = (a|0) ^ ((b|0) << 5); x ^= x >>> 13; x = Math.imul(x, 16777619) + (b|0); return (x ^ (x >>> 16)) | 0 }',
    [['f', [12345.678, -98765.4321], -840720410], ['f', [-1, 2147483648], 1936225128],
      ['f', [NaN, Infinity], 0]], ['differential', 'integer']),
  makeCase('differential-imul-literals', 'differential: imul big literals',
    'export let f = (a) => { let h = Math.imul(a|0, 2654435761); h = Math.imul(h ^ (h >>> 15), 2246822519); return (h ^ (h >>> 13)) | 0 }',
    [['f', [1e20], -1324623214], ['f', [-1], -201062865], ['f', [2654435761], 774098401]], ['differential', 'integer']),
  makeCase('differential-fib-i32', 'differential: integer fibonacci',
    'export let f = (n) => { let k = (n|0) & 31; let a = 0; let b = 1; let i = 0; while (i < k) { let t = (a + b) | 0; a = b; b = t; i = i + 1 } return a }',
    [['f', [0], 0], ['f', [1], 1], ['f', [20], 6765], ['f', [31], 1346269]], ['differential', 'integer']),
  makeCase('differential-fnv-i32', 'differential: FNV hash',
    'export let f = (a, b, c) => { let h = 2166136261 | 0; h = Math.imul(h ^ (a|0), 16777619); h = Math.imul(h ^ (b|0), 16777619); h = Math.imul(h ^ (c|0), 16777619); return h >>> 8 }',
    [['f', [1, 2, 3], 5689143], ['f', [-1, 0, 2147483648], 16148564],
      ['f', [NaN, Infinity, -Infinity], 4894967]], ['differential', 'integer']),
  makeCase('abi-add', 'abi: scalar f64 addition',
    'export let add = (a, b) => a + b',
    [['add', [2, 3], 5], ['add', [-1.5, 0.5], -1]], ['abi', 'determinism']),
  makeCase('abi-square', 'abi: scalar f64 square',
    'export let sq = (x) => x * x',
    [['sq', [4], 16]], ['abi']),
  makeCase('minimal-numeric-fn', 'minimal: heap-free numeric fn',
    'export const f = (a, b) => a + b',
    [['f', [2, 3], 5]], ['minimal']),
  makeCase('minimal-pure-numeric', 'minimal: pure numeric module pulls no allocator',
    'export let f = (a, b) => a * b + 1',
    [['f', [3, 4], 13]], ['minimal']),
  makeCase('empty-module', 'minimal: empty program is an empty module',
    '', [], ['minimal']),
  makeCase('differential-loop-accumulate', 'differential: loop accumulate',
    'export let f = (a, b) => { let s = 0; let i = 0; while (i < 64) { s = s + a*i - b; i = i + 1 } return s }',
    [], ['differential']),
  makeCase('differential-newton-sqrt', 'differential: newton sqrt',
    'export let f = (a) => { let x = a < 0 ? -a : a; let y = x > 0 ? x : 1; let i = 0; while (i < 30) { y = (y + x/y) * 0.5; i = i + 1 } return y }',
    [], ['differential']),
  makeCase('determinism-poly', 'determinism: scalar polynomial loop',
    'export let poly = (a, b, c) => { let s = 0; for (let i = 0; i < 100; i++) s += a*i*i + b*i + c; return s }',
    [['poly', [2, 3, 4], 671950]], ['determinism']),
])

const byId = Object.create(null)
for (const entry of SCALAR_CORE_CASES) byId[entry.id] = entry

export function scalarCase(id) {
  const entry = byId[id]
  if (!entry) throw new Error(`unknown scalar-core case '${id}'`)
  return entry
}

export const scalarCasesIn = (group) => SCALAR_CORE_CASES.filter(entry => entry.groups.includes(group))
