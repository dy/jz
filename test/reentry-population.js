// Host imports that call an export back, each program answering what Node answers at levels 0
// to 3, size and speed. A host function is JavaScript: while it runs it may call an export that
// writes a global of the module or replaces what the global holds, so a copy of the global kept
// across the call (in a local, a typed array's base) reads stale. The write closure answered
// that a callee outside the module writes no global, wrong at the default level and at speed in
// released 1.0.0 to 1.0.3 (.work/architecture.md, "A host import that calls an export back";
// c835d2aac, then src/optimize/effects.js: a name outside the module is the host and does
// everything a function of the module can). The phase 7 scout's three reaches and its control
// (the export called directly), and re-entry through a closure the host is handed and calls: a
// captured local, an array element and its length, an object's fields, a typed array element,
// a module global, the closure's result read after. The programs share a module, each with its
// own names: what an import may write is every global of the module, the same for one program
// as for twelve.
//
// Beside them a generated population (the scratch reentrypop): one to four globals of seven
// kinds (numbers, Float64Array, Int32Array, an array, an object, a string), one to three exports
// that write or replace them, one or two imports each calling one export; `f(k)` reads the
// globals around the imports' calls, straight, in loops, under a test, behind a function of the
// module and beside a shim of the runtime's own (`Math.random()`, `Date.now()`: they call
// nothing back). 400 programs from each of three seeds, each called with 0 to 3. A seed's
// programs share one module and, for each argument, one instance, called in order: what one
// program's calls leave in the heap the next one's meet. That form, which no program alone can
// reach, found a hang at levels 2, 3 and speed in 1.0.3 too: a call's first in-place store of a
// number into an array made as the module started logged the round's undo record in its own
// frame and the frame gave it back at its return, so the log named freed memory and a later
// frame's walk of it (module/core/reach.js `__survive`) never ended (the snapshot,
// module/collection/durable.js durableArrSnapNode, now lowers the escape flag to the array as the
// record is made). Each seed runs in a worker the test stops at a limit, so a hang is a failed
// assertion (test/_bounded.js).
import test from 'tst'
import { is } from 'tst/assert.js'
import { instantiate } from '../interop.js'
import { compile } from './util.js'
import { bounded } from './_bounded.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']
const show = v => Object.is(v, -0) ? '-0' : String(v)
const call = (fn, ...a) => { try { return show(fn(...a)) } catch (e) { return `throws: ${String(e.message).split('\n')[0]}` } }

// ---- the generated programs (xorshift32, so a seed gives the same 400 programs on every run)
const generate = (seed, count) => {
  let state = seed >>> 0 || 1
  const rnd = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
  const KINDS = ['num', 'num', 'f64', 'i32', 'arr', 'obj', 'str']
  const decl = (k, n) => k === 'num' ? `let ${n} = ${pick([0, 1, 3, 0.5, -2])}`
    : k === 'f64' ? `let ${n} = new Float64Array([${int(1, 9)}, ${int(1, 9)}.5, ${int(1, 9)}, ${int(1, 9)}])`
    : k === 'i32' ? `let ${n} = new Int32Array([${int(1, 9)}, ${int(1, 9)}, ${int(1, 9)}, ${int(1, 9)}])`
    : k === 'arr' ? `let ${n} = [${int(1, 9)}, ${int(1, 9)}, ${int(1, 9)}]`
    : k === 'obj' ? `let ${n} = { a: ${int(1, 9)}, b: ${int(1, 9)} }`
    : `let ${n} = '${pick(['a', 'bc', 'def'])}'`
  const write = (k, n) => {
    const c = int(1, 7)
    return k === 'num' ? pick([`${n} = ${n} + ${c}`, `${n} = ${n} * 2 + 1`, `${n} += ${c}.5`])
      : k === 'f64' ? pick([`${n} = new Float64Array(4); ${n}[0] = ${c}`, `${n}[1] = ${n}[1] + ${c}`, `${n} = new Float64Array([${c}, ${c}, ${c}, ${c}, ${c}])`])
      : k === 'i32' ? pick([`${n} = new Int32Array(4); ${n}[2] = ${c}`, `${n}[0] = ${n}[0] + ${c}`, `${n} = new Int32Array([${c}, 2, 3, 4, 5, 6])`])
      : k === 'arr' ? pick([`${n} = [${c}, ${c + 1}, ${c + 2}]`, `${n}.push(${c})`, `${n}[0] = ${n}[0] + ${c}`])
      : k === 'obj' ? pick([`${n} = { a: ${c}, b: ${n}.b + 1 }`, `${n}.a = ${n}.a + ${c}`, `${n} = { a: ${n}.b, b: ${n}.a }`])
      : pick([`${n} = ${n} + 'x'`, `${n} = 'q${c}'`])
  }
  const read = (k, n) => k === 'num' ? pick([n, `${n} * 2`, `(${n} | 0)`])
    : k === 'f64' || k === 'i32' ? pick([`${n}[0]`, `${n}[1]`, `${n}[${int(0, 3)}]`, `${n}.length`, `${n}[0] + ${n}[1]`])
    : k === 'arr' ? pick([`${n}[0]`, `${n}.length`, `${n}[${int(0, 2)}]`, `${n}[0] + ${n}[1]`])
    : k === 'obj' ? pick([`${n}.a`, `${n}.b`, `${n}.a + ${n}.b`])
    : pick([`${n}.length`, `${n}.charCodeAt(0)`])
  const one = () => {
    const gs = []
    for (let i = 0, n = int(1, 4); i < n; i++) gs.push([pick(KINDS), `g${i}`])
    const muts = []
    for (let i = 0, n = int(1, 3); i < n; i++) {
      const body = []
      for (let j = 0, m = int(1, 2); j < m; j++) { const [k, name] = pick(gs); body.push(write(k, name)) }
      muts.push(`export let m${i} = () => { ${body.join('; ')}; return ${int(0, 3)} }`)
    }
    const ncb = int(1, 2), cbOf = []          // which export each import calls
    for (let i = 0; i < ncb; i++) cbOf.push(int(0, muts.length - 1))
    const helper = rnd() < 0.5 ? `let h = () => { ${rnd() < 0.5 ? `cb${int(0, ncb - 1)}()` : `m${int(0, muts.length - 1)}()`} }` : null
    const stmt = (depth) => {
      const r = rnd()
      const [k, name] = pick(gs)
      if (r < 0.38) return `s += ${read(k, name)}`
      // (a shim of the runtime's own between the reads: it calls nothing back)
      if (r < 0.42) return pick([`s += (Math.random() < 2 ? 1 : 0)`, `s += (Date.now() > 0 ? 2 : 0)`])
      if (r < 0.6) return `cb${int(0, ncb - 1)}()`
      if (r < 0.68) return `s += cb${int(0, ncb - 1)}()`
      if (r < 0.74 && helper) return `h()`
      if (r < 0.9 && depth < 2) {
        const body = []
        for (let i = 0, n = int(2, 4); i < n; i++) body.push(stmt(depth + 1))
        return `for (let i${depth} = 0; i${depth} < ${pick(['k', '3', '2', 'k + 1'])}; i${depth}++) { ${body.join('; ')} }`
      }
      if (depth < 2) return `if (${pick(['s > 5', 'k > 1', '(s | 0) % 2 === 0'])}) { ${stmt(depth + 1)}; ${stmt(depth + 1)} }`
      return `s += ${read(k, name)}`
    }
    const body = []
    for (let i = 0, n = int(3, 7); i < n; i++) body.push(stmt(0))
    const text = [...gs.map(([k, n]) => decl(k, n)), ...muts, helper, `export let f = (k) => { let s = 0; ${body.join('; ')}; return s }`].filter(Boolean).join('\n')
    return { text, cbOf }
  }
  return Array.from({ length: count }, one)
}

// (levels 0, 1, 3 and size agree too, 2026-11-15. The generated programs run at 2 and speed:
// with the import fix taken out levels 0 and 1 answer as Node over all 1,200 and level 2 does
// not; with the snapshot's taken out level 2 never returns. A seed's module is 400 programs, and
// the two levels of the three seeds took 251 s at load 20 to 31: the cost is the compile.)
const GENERATED = [2, 'speed']
const ARGS = [0, 1, 2, 3]
// A seed's compile and its four instances, in the worker, at most this long (a hang fails here).
const LIMIT = 240000
// A program's own names, numbered: its globals, exports, helper, `f` and imports.
const OWN = /\b(g\d|m\d|h|f|cb\d)\b/g

// A seed's programs as one module: Node evaluates it afresh for each argument, as jz
// instantiates it afresh, and calls every program in order; a program Node throws on is left
// out, as the scratch population did. One assertion a differing call, one a hang.
const population = (label, progs) => {
  const part = progs.map(({ text, cbOf }, j) => ({ j, text, src: text.replace(OWN, `$1_${j}`), cbs: cbOf.map((m, i) => [`cb${i}_${j}`, `m${m}_${j}`]) }))
  const cbs = part.flatMap(q => q.cbs)
  const body = part.map(q => q.src).join('\n')
  const node = () => new Function(`${cbs.map(([cb, m]) => `const ${cb} = () => ${m}()`).join('\n')}\n${body.replace(/export /g, '')}\nreturn { ${part.map(q => `f_${q.j}`).join(', ')} }`)()
  const want = ARGS.map(a => { const m = node(); return part.map(q => { try { return show(m[`f_${q.j}`](a)) } catch { return null } }) })
  const live = part.filter(q => want.every(w => w[q.j] !== null))
  const src = `import { ${cbs.map(([cb]) => cb).join(', ')} } from 'host'\n${body}`
  const runs = ARGS.map(a => live.map(q => [`f_${q.j}`, [a]]))
  let checks = 0, calls = 0
  for (const optimize of GENERATED) {
    const out = bounded({ src, optimize, calls: cbs, runs }, LIMIT)
    if (out.hung) {
      const q = live[out.hung[1]]
      is('no answer', 'an answer', `${label}: no answer in ${LIMIT / 1000} s at ${JSON.stringify(optimize)}, at f(${ARGS[out.hung[0]]}) of program ${q.j}, every program before it called on the same instance\n${q.text}`)
    }
    calls += out.calls
    out.results.forEach((row, ai) => row.forEach((got, i) => {
      const q = live[i], w = want[ai][q.j]
      checks++
      if (got !== w) is(got, w, `${label}, program ${q.j}: f(${ARGS[ai]}) at ${JSON.stringify(optimize)}\n${q.text}\n  imports call ${q.cbs.map(([, m]) => m.replace(/_\d+$/, ''))}`)
    }))
  }
  is(true, true, `${label}: ${live.length} programs (${part.length - live.length} Node throws on), ${checks} checks, ${calls} calls back`)
}

for (const seed of [1, 2, 3])
  test(`reentry population: seed ${seed}, 400 generated programs on one instance an argument, ${GENERATED.length} configurations`, () => population(`seed ${seed}`, generate(seed, 400)))

// The phase 7 scout's reaches: [name, the program, the export its import `cb` calls (none: the
// control, the export called directly), f's arguments].
const SCOUT = [
  ['a global read, the import bumps it, read again', `let g = 0
export let bump = () => { g = g + 1 }
export let f = (k) => { const a = g * k + g; cb(); const b = g * k + g; return a * 1000 + b }`, 'bump', [7]],
  ['a global typed array, the import replaces it inside a loop', `let x = new Float64Array(4)
export let reset = () => { x = new Float64Array(4); x[0] = 100 }
export let f = () => { let s = 0; for (let i = 0; i < 3; i++) { s += x[0] + x[1]; cb() } return s }`, 'reset', []],
  ['a global counter in a loop, the import adds to it', `let n = 0
export let add = () => { n += 5 }
export let f = (k) => { let s = 0; for (let i = 0; i < k; i++) { s += n; cb() } return s + n }`, 'add', [4]],
  ['control: the same, the bump called directly', `let g = 0
export let bump = () => { g = g + 1 }
export let f = (k) => { const a = g * k + g; bump(); const b = g * k + g; return a * 1000 + b }`, null, [7]],
]
// Re-entry through a closure the host is handed and calls (`call(fn)` runs `fn()`): [name, the program, f's arguments].
const HANDED = [
  ['a captured local written by a closure the host calls',
    `export let f = (k) => { let n = 1; const inc = () => { n = n + k }; const a = n * 2; call(inc); const b = n * 2; call(inc); return a * 100 + b * 10 + n }`, [3]],
  ['a captured local in a loop',
    `export let f = (k) => { let n = 0, s = 0; const inc = () => { n += 2 }; for (let i = 0; i < k; i++) { s += n; call(inc); s += n * 10 } return s }`, [4]],
  ['an array element the closure writes',
    `export let f = (k) => { const a = [1, 2, 3]; const w = () => { a[0] = a[0] + k }; let s = a[0]; call(w); s += a[0] * 10; call(w); return s + a[0] * 100 }`, [5]],
  ['an array the closure grows',
    `export let f = (k) => { const a = [1]; const w = () => { for (let i = 0; i < 40; i++) a.push(i + k) }; let s = a.length + a[0]; call(w); s += a.length * 10 + a[5]; call(w); return s + a.length * 1000 + a[50] }`, [5]],
  ['an object field the closure writes',
    `export let f = (k) => { const o = { x: 1, y: 2 }; const w = () => { o.x = o.x + k; o.y = o.y * 2 }; let s = o.x + o.y; call(w); s += (o.x + o.y) * 10; call(w); return s + (o.x + o.y) * 100 }`, [5]],
  ['a typed array element the closure writes, in a loop',
    `export let f = (k) => { const t = new Float64Array(4); const w = () => { t[1] = t[1] + k }; let s = 0; for (let i = 0; i < 3; i++) { s += t[1]; call(w); s += t[1] } return s }`, [2.5]],
  ['a module global the closure writes',
    `let g = 2\nexport let f = (k) => { const w = () => { g = g + k }; let s = g * 3 + g; call(w); s += g * 3 + g; call(w); return s * 100 + g }`, [4]],
  ['the closure returned from the host call and called later',
    `let g = 1\nexport let f = (k) => { const w = () => { g = g * k; return g }; const a = g + g + g; const r = call(w); return a * 100 + r * 10 + g + g + g }`, [3]],
]

// Fixed programs as one module, each with its own names (`own`), each answer Node's for the
// same text alone; `imports(host)` the host's functions, `host.ex` the instance's exports.
const fixed = (label, rows, own, head, imports) => {
  const src = head + rows.map(([, text], k) => text.replace(own, `$1_${k}`)).join('\n')
  for (const optimize of CONFIGS) {
    const host = {}
    const { exports } = instantiate(compile(src, { optimize, imports: imports(host) }), { imports: imports(host) })
    host.ex = exports
    rows.forEach(([name, , want, args], k) => {
      const got = call(exports[`f_${k}`], ...args)
      if (got !== want) is(got, want, `${label}: ${name} at ${JSON.stringify(optimize)}`)
    })
  }
  is(true, true, `${label}: ${rows.length} programs, ${CONFIGS.length} configurations`)
}

test('reentry population: the phase 7 scout\'s reaches, the import calling an export back', () => {
  const rows = SCOUT.map(([name, text, back, args]) =>
    [name, text, show(new Function(`${back ? `const cb = () => ${back}()\n` : ''}${text.replace(/export /g, '')}\nreturn f`)()(...args)), args, back])
  const used = rows.map(([, , , , back], k) => back && `cb_${k}`).filter(Boolean)
  fixed('scout', rows, /\b(g|x|n|bump|reset|add|f|cb)\b/g, `import { ${used.join(', ')} } from 'host'\n`,
    host => ({ host: Object.fromEntries(rows.flatMap(([, , , , back], k) => back ? [[`cb_${k}`, () => host.ex[`${back}_${k}`]()]] : [])) }))
})

test('reentry population: a closure the host is handed writes what the caller holds', () => {
  const rows = HANDED.map(([name, text, args]) => [name, text, show(new Function(`const call = (fn) => fn()\n${text.replace(/export /g, '')}\nreturn f`)()(...args)), args])
  fixed('handed', rows, /\b(g|f)\b/g, `import { call } from 'host'\n`, () => ({ host: { call: (fn) => fn() } }))
})
