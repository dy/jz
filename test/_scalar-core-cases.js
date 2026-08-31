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
