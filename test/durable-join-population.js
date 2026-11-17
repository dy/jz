// Small functions over records, dictionaries, arrays and tables a module makes as it starts,
// joined in one module with a delete anywhere, called in orders a seed picks, each answer
// against Node's at every level. No reset: a record's field that holds a number keeps it
// across one (README, Memory), where a fresh instance of Node's reads it as made; the reset's
// reading of the log is test/reset-population.js's. A store into storage older than the call logs, for the reset, what it
// changes (module/core/durable-log.js): a record, the bitmap of what was saved, the relocation
// buffer, each made in the running frame and named by a global. A frame that restored over one
// left the log naming memory the next call made again: alone, each function answered right;
// joined, a frame of one restored over the records another's calls linked to, and the walk of
// the log never ended or a bit landed in a string (test/frame-effects.js holds the two least
// modules). The delete matters as it routes every field store of a record through the dynamic
// store's arm, which saves the record's mask of deleted fields. Each level runs in a worker
// stopped at a limit (test/_bounded.js), so a hang is a failed assertion.
import test from 'tst'
import { is } from 'tst/assert.js'
import { bounded } from './_bounded.js'
import { oracle } from './util.js'
import { levels, onKernel, onWasi } from './_matrix.js'

const LEVELS = levels(0, 1, 2, 3, 'size', 'speed')
const LIMIT = 240000
// Each unit's names start with `$`, made its own as the units join.
const UNITS = {
  // fields of records made at start: numbers stored, read back
  recNum: `const $ps = []; for (let i = 0; i < 8; i++) $ps.push({ x: i, y: i * 2 })
export const $set = (k) => { for (let i = 0; i < 8; i++) $ps[i].x = i + k; return $ps[k & 7].x }
export const $sum = (k) => { let s = 0; for (const p of $ps) s += p.x + p.y; return s }`,
  // a field made a string, then an object, then a number again
  recStr: `const $qs = []; for (let i = 0; i < 8; i++) $qs.push({ x: i, y: 1 })
export const $str = (k) => { $qs[k & 7].x = 'x' + k; let h = ''; for (const q of $qs) h += q.x; return h }
export const $obj = (k) => { $qs[k & 7].y = { v: k }; const r = $qs[k & 7].y.v; $qs[k & 7].y = k; return r }`,
  // a record whose field a delete takes and a store gives back
  recDel: `const $rs = []; for (let i = 0; i < 4; i++) $rs.push({ a: i, b: i + 1 })
export const $del = (k) => { const w = k & 1 ? 'a' : 'b'; delete $rs[k & 3][w]; return Object.keys($rs[k & 3]).join() }
export const $back = (k) => { $rs[k & 3].a = k; $rs[k & 3].b = -k; return Object.keys($rs[k & 3]).join() + ($rs[k & 3].a - $rs[k & 3].b) }`,
  // a delete that never runs
  never: `const $os = [{ x: 1 }, { x: 2 }]
export const $touch = (k) => { const w = 'x' + (k > 1e9 ? '' : 'y'); if (k > 1e9) delete $os[k & 1][w]; $os[k & 1].x = k; return $os[0].x + $os[1].x }`,
  // a dictionary keyed at run time
  dict: `const $d = { a: 1 }
export const $put = (k) => { $d['k' + (k % 5)] = k; return Object.keys($d).length }
export const $drop = (k) => { delete $d['k' + (k % 5)]; return Object.keys($d).join() }`,
  // an array: an element stored, pushed past its room, cut back
  arr: `const $a = [1, 2, 3]
export const $push = (k) => { for (let i = 0; i < k % 9; i++) $a.push(k + i); return $a.length }
export const $cut = (k) => { $a.length = 3; $a[k % 3] = k; return $a.join() }`,
  // an array with room past its length, through the runtime's helpers: each saves it as it first writes
  ops: `const $x = []; for (let i = 0; i < 16; i++) $x.push(i); $x.length = 4
export const $fill = (k) => { $x.fill(k, 0, 2); return $x.join() }
export const $rev = (k) => { $x.reverse(); return $x.join() }
export const $splice = (k) => { $x.splice(1, 1, k); return $x.join() }
export const $unshift = (k) => { $x.unshift(k); $x.length = 4; return $x.join() }
export const $copy = (k) => { $x.copyWithin(0, 2); return $x.join() }
export const $shift = (k) => { $x.push(k); $x.shift(); return $x.join() }`,
  // a Map and a Set, and a Set grown past its room
  table: `const $m = new Map([[1, 1]]), $s = new Set([1]), $g = new Set()
export const $mset = (k) => { $m.set(k % 7, k); $s.add(k % 5); return $m.size * 10 + $s.size }
export const $mdel = (k) => { $m.delete(k % 7); $s.delete(k % 5); let t = 0; for (const [a, b] of $m) t += a * b; return t + $s.size }
export const $grow = (k) => { for (let i = 0; i < 12; i++) $g.add(k * 12 + i); return $g.size }`,
  // a string a module binding keeps, made over what a frame freed, read whole
  str: `let $t = ''
export const $add = (k) => { for (let i = 0; i < 20; i++) $t += 'w' + (i + k); if ($t.length > 3000) $t = ''; return $t.length }
export const $hash = (k) => { let h = 0; for (let i = 0; i < $t.length; i++) h = (h * 31 + $t.charCodeAt(i)) | 0; return h }`,
  // a call that allocates and keeps nothing: what it made goes as it returns
  churn: `export const $churn = (k) => { const t = []; for (let i = 0; i < 40; i++) t.push({ i, s: 'c' + i }); return t.length + t[k % 40].i + t[k % 40].s.length }`,
}
const units = Object.entries(UNITS).map(([u, text], j) => ({ u, src: text.replace(/\$(\w+)/g, `u${j}_$1`) }))
const src = units.map(u => u.src).join('\n')
const exported = [...src.matchAll(/export const (\w+)/g)].map(m => m[1])

// mulberry32: a seed's schedule, the same in both runs
const rng = (seed) => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8]
const CALLS = 160
const schedule = (seed) => {
  const r = rng(seed), run = []
  for (let c = 0; c < CALLS; c++) run.push([exported[Math.floor(r() * exported.length)], [Math.floor(r() * 20)]])
  return run
}
const runs = SEEDS.map(schedule)
// Node's answers: an instance of its own for each seed, as the worker's
const show = v => Object.is(v, -0) ? '-0' : String(v)
const want = runs.map(run => {
  const m = oracle(src)
  return run.map(([name, args]) => { try { return show(m[name](...args)) } catch (e) { return `throws: ${String(e?.message ?? e).split('\n')[0]}` } })
})

test(`durable join population: ${units.length} units, ${exported.length} functions, ${SEEDS.length} orders of ${CALLS} calls`, () => {
  if (onWasi() || onKernel()) return
  let checks = 0
  for (const optimize of LEVELS) {
    const out = bounded({ src, optimize, runs }, LIMIT)
    if (out.hung) { is(`no answer in ${LIMIT / 1000} s`, 'an answer', `seed ${SEEDS[out.hung[0]]} at its call ${out.hung[1]} (${runs[out.hung[0]][out.hung[1]]?.[0]}), at ${JSON.stringify(optimize)}`); continue }
    out.results.forEach((got, s) => {
      const at = got.findIndex((g, c) => g !== want[s][c])
      checks += got.length
      if (at >= 0) is(got[at], want[s][at], `seed ${SEEDS[s]} at its call ${at}, ${runs[s][at][0]}(${runs[s][at][1]}), at ${JSON.stringify(optimize)}; before it ${runs[s].slice(Math.max(0, at - 6), at).map(([n, a]) => `${n}(${a})`).join(' ')}`)
    })
  }
  is(true, true, `${checks} answers at ${LEVELS.length} levels`)
})
