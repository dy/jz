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
import test from 'tst'
import { is } from 'tst/assert.js'
import { instantiate } from '../interop.js'
import { compile } from './util.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']
const show = v => Object.is(v, -0) ? '-0' : String(v)
const call = (fn, ...a) => { try { return show(fn(...a)) } catch (e) { return `throws: ${String(e.message).split('\n')[0]}` } }

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
