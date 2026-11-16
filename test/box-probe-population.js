// Probes of the box at the edges its population's grid does not reach, each program answering what
// Node answers at levels 0 to 3, size and speed (the integrator's, against
// src/compile/plan/integral-loops.js as read): what a held name enters with where the statement
// before the loop is not what it looks like, -0 among the names of the box, a parameter the loop
// writes, a loop with no braces, the state the copy hands over; a held name the declaring
// statement writes again; and a copy that leaves for the loop as written, which must start where
// the copy stopped (the DP row of test/integral-loops.js, its inner loop spelled six ways, alone
// and as a `for` whose init is an assignment). Each scratch population is a block of its own
// below, its names its own.
//
// One program meets a divergence the README documents ("Numeric export parameters": a parameter
// an exported function never uses as a string is compiled as a number and converted at the
// boundary, `add(1, '2')` is 3): `f(n, s, t)` called with strings, undefined, null and Booleans.
// Node runs it with n and t so converted; s, copied into the counter that indexes the array, is
// passed as it is (jz answers that at every level for all 210 argument lists, 2026-11-15).
import test from 'tst'
import { population } from './_population.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']

{
const P = []
const E31 = 2 ** 31, E30 = 2 ** 30, E29 = 2 ** 29
const NS = [0, 1, 7, 8, 40, 1000, 65536, E29 - 1, E29, E30 - 1, E30, E31 - 1, E31, 2 ** 32, 1e12, -1, -0, NaN, 0.5]
const SS = [0, 1, 2, 5, -1, -0, 3.5, E29, E30 - 1, E30, E31 - 1, E31, NaN]
const TS = [1, 2, 0, -0, -1, 0.5, E29, E30, NaN]
const cross = (...lists) => lists.reduce((acc, l) => acc.flatMap(a => l.map(v => [...a, v])), [[]])
const NUM = cross(NS, SS, TS)
const SUMX = 'x[0] + 2 * x[1] + 3 * x[2] + 4 * x[3] + 5 * x[4] + 6 * x[5] + 7 * x[6] + 8 * x[7]'
const prog = (name, decl, loop, names = 'i', args = NUM, pre = '') => P.push({ name, args, src: `${pre}\nexport let f = (n, s, t) => {
  const x = new Float64Array(8); for (let k = 0; k < 8; k++) x[k] = k + 1
  let c = 0, u = 0, sum = 0
  ${decl}
  ${loop}
  return [c, u, sum, ${names}, ${SUMX}]
}` })
const cap = 'if (++c > 44) break'
const round = 'x[i] = c; i = i * 2 + t'

// ---- the entry: the statement before the loop
prog('a swap before the loop', 'let i = 0, j = s\n  ;[i, j] = [j, i]', `while (i < n) { ${cap}; ${round} }`, 'i, j')
prog('a literal, then a write in an arm', 'let i = 0\n  if (s > 5) i = s', `while (i < n) { ${cap}; ${round} }`)
prog('a literal, then a write in a block', 'let i = 4\n  { i = s }', `while (i < n) { ${cap}; ${round} }`)
prog('a literal, then a write in an index', 'let i = 4\n  x[(i = s) % 8] = 9', `while (i < n) { ${cap}; ${round} }`)
prog('a literal, then a step in a loop', 'let i = 4\n  for (let k = 0; k < (s % 5); k++) i++', `while (i < n) { ${cap}; ${round} }`)
prog('a literal, then a conditional step', 'let i = 4\n  s > 3 && i++', `while (i < n) { ${cap}; ${round} }`)
prog('a literal, then a ternary write', 'let i = 4\n  s > 3 ? i = s : 0', `while (i < n) { ${cap}; ${round} }`)
prog('a literal declared outside a loop around', 'let i = 4', `for (let k = 0; k < 3; k++) { while (i < n) { ${cap}; ${round} }; i = i - s }`)
prog('a literal declared in a loop around, the loop after a write', 'let last = 0', `for (let k = 0; k < 3; k++) { let i = 4; i = i + s * k; while (i < n) { ${cap}; ${round} }; last += i }`, 'last')
prog('a word of a name written after', 'let q = s | 0, i = q << 1\n  q = q + 1', `while (i < n) { ${cap}; ${round} }`, 'i, q')
prog('a word of itself', 'let i = s\n  i = i << 1', `while (i < n) { ${cap}; ${round} }`)
prog('a word, unsigned, of a parameter', 'let i = s >>> 1', `while (i < n) { ${cap}; ${round} }`)
prog('a word past the box', 'let i = s | 1073741824', `while (i < n) { ${cap}; ${round} }`)
prog('a word that is negative', 'let i = s | -8', `while (i < n) { ${cap}; ${round} }`)
prog('a parameter written by the loop', '', `while (s < n) { ${cap}; x[s] = c; s = s * 2 + t }`, 's')
prog('the bound a parameter written before', 'let i = s\n  n = n * 2', `while (i < n) { ${cap}; ${round} }`, 'i, n')
prog('the stride a parameter written before', 'let i = s\n  t = t + 0.5', `while (i < n) { ${cap}; ${round} }`, 'i, t')
// ---- -0 among the names of the box
prog('a stride that is -0, a literal', 'let i = s\n  const z = -0', `while (i < n) { ${cap}; x[i] = c; i = (i + 1) * z }`, 'i, 1 / i')
prog('a stride that is -0, computed', 'let i = s\n  const z = 0 * -1', `while (i < n) { ${cap}; x[i] = c; i = (i + 1) * z }`, 'i, 1 / i')
prog('a stride that is the parameter, -0 among its values', 'let i = s', `while (i < n) { ${cap}; x[i] = c; i = (i + 1) * t }`, 'i, 1 / i')
prog('a difference times the bound', 'let i = s', `while (i < n) { ${cap}; x[i] = c; i = (i - t) * n }`, 'i, 1 / i')
prog('a negation of a difference', 'let i = s', `while (i < n) { ${cap}; x[i] = c; i = -(t - i) }`, 'i, 1 / i')
prog('zero less the name', 'let i = s', `while (i < n) { ${cap}; x[i] = c; i = 0 - i + t }`, 'i, 1 / i')
prog('a stride that is -0, a module constant', 'let i = s', `while (i < n) { ${cap}; x[i] = c; i = (i + 1) * Z }`, 'i, 1 / i', NUM, 'const Z = -0')
prog('a stride that is -0, a module binding never written', 'let i = s', `while (i < n) { ${cap}; x[i] = c; i = (i + 1) * Z }`, 'i, 1 / i', NUM, 'let Z = -0')
prog('a stride that is -0, a minimum of two zeros', 'let i = s\n  const z = Math.min(0, -0)', `while (i < n) { ${cap}; x[i] = c; i = (i + 1) * z }`, 'i, 1 / i')
prog('a stride that is -0 or five', 'let i = s\n  const z = t > 1 ? -0 : 5', `while (i < n) { ${cap}; x[i] = c; i = (i + 1) * z }`, 'i, 1 / i')
prog('a stride that is -0, a local of a local', 'let i = s\n  const z0 = -0, z = z0', `while (i < n) { ${cap}; x[i] = c; i = (i + 1) * z }`, 'i, 1 / i')
prog('a stride that is -0, a let assigned once more', 'let i = s\n  let z = 3\n  z = -0', `while (i < n) { ${cap}; x[i] = c; i = (i + 1) * z }`, 'i, 1 / i')
prog('a stride that is -0, an argument of every call', 'let i = 0', `sum = run(x, n, s, -0) + run(x, n, t, -0) * 3\n  i = run(x, n, s + 1, -0)`, 'i',
  NUM, 'const run = (x, n, s, z) => { const Z = z; let i = s, c = 0, w = 0; while (i < n) { if (++c > 30) break; x[i] = c; w += x[c % 8]; i = (i + 1) * Z }; return 1 / i + w }')
prog('a stride that is -0, a negated zero argument', 'let i = 0', `sum = run(x, n, s, -ZERO) + run(x, n, t, ZERO * -1) * 3\n  i = run(x, n, s + 1, -ZERO)`, 'i',
  NUM, 'const ZERO = 0\nconst run = (x, n, s, z) => { const Z = z; let i = s, c = 0, w = 0; while (i < n) { if (++c > 30) break; x[i] = c; w += x[c % 8]; i = (i + 1) * Z }; return 1 / i + w }')
prog('a bound that is -0', 'let i = s\n  const z = -0', `while (i <= z) { ${cap}; x[i] = c; i = (i + 1) * (z + t) }`, 'i, 1 / i')
prog('a held name entering as -0 from a literal', 'let i = -0', `while (i < n) { ${cap}; x[i] = c; i = i * 2 * t }`, 'i, 1 / i')
// ---- the loop's shape
prog('no braces', 'let i = s', 'while (i < n) i = i * 2 + 1 + (x[i] > 100 ? 1 : 0)', 'i', NUM.filter(([n, s]) => s >= 0 || Number.isNaN(s)))
prog('the test in parentheses', 'let i = s', `while ((i < n)) { ${cap}; ${round} }`)
prog('a constant test', 'let i = s', `while (1) { if (!(i < n)) break; ${cap}; ${round} }`)
prog('a constant test, true', 'let i = s', `while (true) { ${cap}; if (i >= n) break; ${round} }`)
prog('the cap after the write', 'let i = s', `while (i < n) { x[i] = c; i = i * 2 + t; if (++c > 44) break }`)
prog('the cap a statement', 'let i = s', `while (i < n) { c++; if (c > 44) break; ${round} }`)
prog('the cap in the test', 'let i = s', `while (i < n && c < 44) { c++; ${round} }`)
prog('a held name read after by an expression', 'let i = s', `while (i < n) { ${cap}; ${round} }\n  sum = sum + i * 0.5`, 'i')
prog('held names declared apart', 'let i = s\n  let id = 4\n  let w = 0', `while (i < n) { ${cap}; x[i] = c; w = i + id; i = 2 * (id - 1); id *= 4 }`, 'i, id, w')
prog('a held name written only in one round', 'let i = s, q = 1', `while (i < n) { ${cap}; x[i] = c; if (c === 3) q = q * 1000; i = i * 2 + q }`, 'i, q')
// ---- the loop the copy leaves to: its state
prog('a float sum across the hand-over', 'let i = s, w = 0.1', `while (i < n) { ${cap}; w = w * 1.25 + x[i % 8]; i = i * 2 + t }`, 'i, w')
prog('a store across the hand-over', 'let i = s', `while (i < n) { ${cap}; x[c % 8] = x[c % 8] * 1.5 + i; i = i * 2 + t }`)
prog('names declared in the round across the hand-over', 'let i = s, keep = 0', `while (i < n) { ${cap}; const a = i * 3, b = a + t; keep = keep + b % 7; x[i] = b; i = i * 2 + t }`, 'i, keep')
const ODD = cross([40, E31, '40', undefined, null, true], [0, 5, '5', undefined, null, true, false], [1, '2', undefined, null, true])
prog('arguments of other kinds', 'let i = s', `while (i < n) { ${cap}; ${round} }`, 'i', ODD)
prog('arguments of other kinds, a geometric pair', 'let ix = 0, id = s', `while (ix < n) { ${cap}; x[ix] = c; ix = 2 * (id - 1); id *= 4 }`, 'ix, id', ODD)
// (README, "Numeric export parameters": n and t converted at the boundary, s passed as it is)
P.find(p => p.name === 'arguments of other kinds').node = P.find(p => p.name === 'arguments of other kinds').src.replace('export let f = (n, s, t) => {', 'export let f = (n, s, t) => { n = +n; t = +t')
test(`box probe population: ${P.length} probes of the box's entry, -0 and shape, ${CONFIGS.length} configurations`, () =>
  population('box probe', P, { configs: CONFIGS, own: ['Z', 'ZERO', 'run'] }))
}

{
const P = []
const E31 = 2 ** 31, E30 = 2 ** 30, E29 = 2 ** 29
const NS = [0, 1, 7, 8, 40, 1000, 65536, E29, E30 - 1, E30, E31 - 1, E31, 2 ** 32, -1, NaN, 0.5]
const SS = [0, 1, 2, 5, 9, -1, -0, 3.5, E29, E30 - 1, E30, E31 - 1, E31, NaN]
const TS = [1, 2, 0, -1, 0.5, E29, NaN]
const cross = (...lists) => lists.reduce((acc, l) => acc.flatMap(a => l.map(v => [...a, v])), [[]])
const ARGS = cross(NS, SS, TS)
const SUMX = 'x[0] + 2 * x[1] + 3 * x[2] + 4 * x[3] + 5 * x[4] + 6 * x[5] + 7 * x[6] + 8 * x[7]'
const prog = (name, decl, loop = `while (i < n) { if (++c > 44) break; x[i] = c; i = i * 2 + t }`, names = 'i', pre = '') => P.push({ name, args: ARGS, src: `${pre}\nexport let f = (n, s, t) => {
  const x = new Float64Array(8); for (let k = 0; k < 8; k++) x[k] = k + 1
  let c = 0, u = 0, sum = 0
  ${decl}
  ${loop}
  return [c, u, sum, ${names}, ${SUMX}]
}` })
prog('a literal, written again in the same declaration', 'let i = 4, j = (i = s)', undefined, 'i, j')
prog('a literal, stepped in the same declaration', 'let i = 4, j = i++ + s', undefined, 'i, j')
prog('a literal, written by a later declarator\'s conditional', 'let i = 4, j = s > 2 ? (i = s) : 0', undefined, 'i, j')
prog('a word, written again in the same declaration', 'let i = s << 1, j = (i = s)', undefined, 'i, j')
prog('a word of a name the same declaration writes after', 'let q = s | 0, i = q << 1, j = (q = 5)', undefined, 'i, j, q')
prog('an assignment whose right side writes the name', 'let i = 0\n  i = (i = s, 4)', undefined)
prog('an assignment whose right side steps the name', 'let i = 3\n  i = 4 + 0 * i++', undefined)
prog('a literal assigned in a comma', 'let i = 0, j = 0\n  i = 4, j = (i = s)', undefined, 'i, j')
prog('a literal, then a compound write', 'let i = 4\n  i += s', undefined)
prog('a literal, then a step', 'let i = 4\n  i++', undefined)
prog('a literal, then a prefix step in an expression', 'let i = 4\n  sum = ++i + s', undefined)
prog('a literal, then a logical assignment', 'let i = 0\n  i ||= s', undefined)
prog('a literal, then a nullish assignment', 'let i = 4\n  i ??= s', undefined)
prog('a literal, then a write in a loop test', 'let i = 4, k = 0\n  while ((i = i + 1) < s && k < 3) k++', undefined, 'i, k')
prog('a literal, then a write in a for init', 'let i = 4, k = 0\n  for (i = s; k < 2; k++) sum += k', undefined, 'i, k')
prog('a literal, then a labelled block that writes', 'let i = 4\n  blk: { if (s > 1) break blk; i = s + 1 }', undefined)
prog('a literal, then a switch that writes', 'let i = 4\n  switch (s) { case 2: i = 9; break; case 5: i = s * 3 }', undefined)
prog('a literal, then a try that writes', 'let i = 4\n  try { i = s } finally { sum += 1 }', undefined)
prog('a literal declared twice over by blocks', 'let i = 4\n  { let i = s; sum += i }', undefined)
prog('a var declared after its use', 'i = s\n  var i', undefined)
prog('a literal behind a loop that does not write it', 'let i = 4\n  for (let k = 0; k < 3; k++) sum += k * s', undefined)
prog('the stride written between the word and the loop', 'let q = t | 0, i = q << 1\n  t = t + 1', undefined, 'i, q, t')
prog('a held pair, the second a word of the first', 'let i = s | 0, id = i << 1', 'while (i < n) { if (++c > 44) break; x[i] = c; i = i + id; id = id * 2 }', 'i, id')
prog('a held pair entering from literals out of the box', 'let i = 1073741824, id = 3', 'while (i < n) { if (++c > 44) break; x[i] = c; i = i + id; id = id * 2 }', 'i, id')
prog('a held pair, one literal below zero', 'let i = -3, id = 2', 'while (i < n) { if (++c > 44) break; x[i] = c; i = i + id; id = id * 2 }', 'i, id')
test(`box probe population: ${P.length} held names written again as declared, ${CONFIGS.length} configurations`, () =>
  population('box entry', P, { configs: CONFIGS }))
}

{
const INNER = {
  'for let': ['', 'for (let j = 1; j <= LB; j++) {', '}'],
  'for assigned init': ['let j = 0', 'for (j = 1; j <= LB; j++) {', '}'],
  'for no init': ['let j = 1', 'for (; j <= LB; j++) {', '}'],
  'for no init no step': ['let j = 1', 'for (; j <= LB;) {', 'j++ }'],
  'while': ['let j = 1', 'while (j <= LB) {', 'j++ }'],
  'for comma init': ['let j = 0, z = 0', 'for (j = 1, z = 5; j <= LB; j++) {', '}'],
}
const P = []
for (const [name, [decl, head, tail]] of Object.entries(INNER)) for (const outer of ['for', 'while']) {
  const o = outer === 'for' ? ['for (let i = 1; i <= n; i++) {', '}'] : ['let i = 1\n      while (i <= n) {', 'i++ }']
  P.push({ name: `${name}, outer ${outer}`, src: `const LB = 64
    const scan = (a, b, prev, n) => {
      ${o[0]}
        let diag = prev[0]
        prev[0] = i
        const ai = a[i - 1]
        ${decl}
        ${head}
          const up = prev[j]
          const sub = diag + (ai === b[j - 1] ? 0 : 1)
          let m = up + 1
          const ins = prev[j - 1] + 1
          if (ins < m) m = ins
          if (sub < m) m = sub
          diag = up
          prev[j] = m
        ${tail}
      ${o[1]}
      let h = 0
      for (let j = 0; j <= LB; j++) h = Math.imul(h ^ prev[j], 16777619)
      return h
    }
    export let f = (seed, big, every) => {
      const a = new Uint8Array(LB), b = new Uint8Array(LB), prev = new Int32Array(LB + 1)
      let s = seed | 0
      for (let i = 0; i < LB; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; a[i] = s & 3; b[i] = (s >> 3) & 3 }
      for (let j = 0; j <= LB; j++) prev[j] = big && j % every === 0 ? 2147483647 : j
      return scan(a, b, prev, LB)
    }`, args: [1, 7, 12345].flatMap(seed => [[seed, 0, 5], [seed, 1, 5], [seed, 1, 1], [seed, 1, 63], [seed, 1, 64], [seed, 1, 7]]) })
}
test(`box probe population: ${P.length} DP rows whose copy leaves for the loop as written, ${CONFIGS.length} configurations`, () =>
  population('box resume', P, { configs: CONFIGS, own: ['LB', 'scan'] }))
}

// ---- the row as one loop standing alone, left at the cell `at`
{
const LOOP = {
  'for let': ['', 'for (let j = 1; j <= LB; j++) {', '}', ''],
  'for assigned init': ['let j = 0', 'for (j = 1; j <= LB; j++) {', '}', ''],
  'for assigned init, j read after': ['let j = 0', 'for (j = 1; j <= LB; j++) {', '}', 'h += j'],
  'for no init': ['let j = 1', 'for (; j <= LB; j++) {', '}', ''],
  'for no init no step': ['let j = 1', 'for (; j <= LB;) {', 'j++ }', ''],
  'while': ['let j = 1', 'while (j <= LB) {', 'j++ }', ''],
  'while, j read after': ['let j = 1', 'while (j <= LB) {', 'j++ }', 'h += j'],
  'for init of another name': ['let j = 1, z = 0', 'for (z = 7; j <= LB; j++) {', 'z += 2 }', 'h += z'],
  'for init counts runs': ['let j = 1, z = 0', 'for (z++; j <= LB; j++) {', '}', 'h += z * 1000003'],
}
const P = []
for (const [name, [decl, head, tail, after]] of Object.entries(LOOP)) P.push({ name, src: `const LB = 64
    export let f = (seed, big, at) => {
      const b = new Uint8Array(LB), prev = new Int32Array(LB + 1)
      let s = seed | 0
      for (let i = 0; i < LB; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; b[i] = (s >> 3) & 3 }
      for (let k = 0; k <= LB; k++) prev[k] = big && k === at ? 2147483647 : k * 3
      const ai = seed & 3
      let diag = prev[0]
      ${decl}
      ${head}
        const up = prev[j]
        const sub = diag + (ai === b[j - 1] ? 0 : 1)
        let m = up + 1
        const ins = prev[j - 1] + 1
        if (ins < m) m = ins
        if (sub < m) m = sub
        diag = up
        prev[j] = m
      ${tail}
      let h = diag
      ${after}
      for (let k = 0; k <= LB; k++) h = Math.imul(h ^ prev[k], 16777619)
      return h
    }`, args: [1, 7, 12345].flatMap(seed => [[seed, 0, 5], [seed, 1, 0], [seed, 1, 1], [seed, 1, 2], [seed, 1, 5], [seed, 1, 33], [seed, 1, 63], [seed, 1, 64]]) })
test(`box probe population: ${P.length} single rows left at a cell, ${CONFIGS.length} configurations`, () =>
  population('box resume alone', P, { configs: CONFIGS, own: ['LB'] }))
}

{
const P = []
const prog = (name, decl, head, tail, after) => P.push({ name, src: `const LB = 16
export let f = (big, at, z0) => {
  const prev = new Int32Array(LB + 1)
  for (let k = 0; k <= LB; k++) prev[k] = big && k === at ? 2147483647 : k * 3
  let diag = prev[0], h = 0
  ${decl}
  ${head}
    const up = prev[j & 15]
    let m = up + 1
    const ins = diag + 1
    if (ins < m) m = ins
    diag = up
    prev[(j & 15) + 1] = m
  ${tail}
  ${after}
  for (let k = 0; k <= LB; k++) h = Math.imul(h ^ prev[k], 16777619)
  return [h, diag]
}`, args: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 2, 3], [1, 5, 1], [1, 9, 2], [1, 15, 0], [1, 16, 4]] })
prog('assigned init, counter read after', 'let j = 0', 'for (j = 1; j < 15; j++) {', '}', 'h = j')
prog('assigned init from a parameter', 'let j = 0', 'for (j = z0 & 3; j < 15; j++) {', '}', 'h = j')
prog('assigned init of another name', 'let j = 1, z = 0', 'for (z = 7; j < 15; j++) {', 'z += 2 }', 'h = z + j')
prog('assigned init of another name, counter a while\'s', 'let j = 1, z = 0', 'for (z = 7; j < 15;) {', 'z += 2; j = j + 1 }', 'h = z + j')
prog('compound init', 'let j = 1, z = z0 & 7', 'for (z += 5; j < 15; j++) {', 'z += 2 }', 'h = z + j')
prog('no init', 'let j = 1', 'for (; j < 15; j++) {', '}', 'h = j')
prog('no init, no step', 'let j = 1', 'for (; j < 15;) {', 'j = j + 1 }', 'h = j')
prog('while', 'let j = 1', 'while (j < 15) {', 'j = j + 1 }', 'h = j')
prog('while, stepped by ++', 'let j = 1', 'while (j < 15) {', 'j++ }', 'h = j')
test(`box probe population: ${P.length} for inits around a copy that leaves, ${CONFIGS.length} configurations`, () =>
  population('box init', P, { configs: CONFIGS, own: ['LB'] }))
}
