// A population of the generated suite: programs over a grid, each answering what Node answers
// at every configuration. A program is `{ name, src, args }`: `src` exports `f`, and may export
// `pre`, called before `f` with the same arguments, and `g`, read after it; each argument list
// of `args` is one call of the three. The programs share a module, each with its own names (the
// population's `own`: every top-level binding a program declares), so a configuration costs one
// compile; Node evaluates the same module, as jz instantiates it once a configuration. Where the
// README documents a divergence a program meets, its `node` is the source Node runs in its
// place: the program as the README reads it.
import { is } from 'tst/assert.js'
import { jz, oracle } from './util.js'

// A value as both sides are compared: -0 and NaN told apart, an array or a typed array by its elements.
export const norm = x => typeof x === 'number' ? (Number.isNaN(x) ? 'NaN' : Object.is(x, -0) ? '-0' : String(x))
  : x === undefined ? 'undefined' : x === null ? 'null' : typeof x === 'bigint' ? x + 'n'
  : Array.isArray(x) || ArrayBuffer.isView(x) ? '[' + [...x].map(norm).join(',') + ']' : JSON.stringify(x)

// One call: `pre`, `f`, `g` of program `k` with the arguments `a`, as a string (a throw by its constructor's name).
const call = (m, k, a) => {
  try {
    m[`pre_${k}`]?.(...a)
    const g = m[`g_${k}`]
    return norm(m[`f_${k}`](...a)) + (g ? ' ' + norm(g(...a)) : '')
  } catch (e) { return `throws ${e?.constructor?.name ?? typeof e}` }
}

/** Every program of `progs` called with each of its argument lists at each of `configs`, against
 *  Node: one assertion a differing call, and one a population saying what it ran. `own` names the
 *  top-level bindings of a program (besides f, pre, g); `chunk` programs go to a module. */
export function population(label, progs, { configs, own = [], chunk = Infinity }) {
  const names = new RegExp(`\\b(${['f', 'pre', 'g', ...own].join('|')})\\b`, 'g')
  let checks = 0
  for (let c0 = 0; c0 < progs.length; c0 += chunk) {
    const part = progs.slice(c0, c0 + chunk)
    const src = part.map((p, j) => p.src.replace(names, `$1_${j}`)).join('\n')
    const want = oracle(part.map((p, j) => (p.node ?? p.src).replace(names, `$1_${j}`)).join('\n'))
    const expected = part.map((p, j) => p.args.map(a => call(want, j, a)))
    for (const optimize of configs) {
      const got = jz(src, { optimize }).exports
      part.forEach((p, j) => p.args.forEach((a, i) => {
        const r = call(got, j, a)
        checks++
        if (r !== expected[j][i]) is(r, expected[j][i], `${p.name} (${a.map(norm).join(', ')}) at ${JSON.stringify(optimize)}`)
      }))
    }
  }
  is(true, true, `${label}: ${progs.length} programs, ${checks} checks, ${configs.length} configurations`)
}
