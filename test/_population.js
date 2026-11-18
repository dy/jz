// A population of the generated suite: programs over a grid, each answering what Node answers
// at every configuration. A program is `{ name, src, args }`: `src` exports `f`, and may export
// `pre`, called before `f` with the same arguments, and `g`, read after it; each argument list
// of `args` is one call of the three. The programs share a module, each with its own names (the
// population's `own`: every top-level binding a program declares), so a configuration costs one
// compile; Node evaluates the same module, as jz instantiates it once a configuration. Where the
// README documents a divergence a program meets, its `node` is the source Node runs in its
// place: the program as the README reads it.
//
// JZ_TEST_SAMPLE=<n> runs one program in n of every population: the same ones on every run,
// picked by SEED, and the sampled test's name says so. Unset, or 1, a population runs whole.
// A sweep that does not go through population() takes the same switch through sample().
import { is } from 'tst/assert.js'
import { jz, oracle } from './util.js'

const SEED = 1
const SAMPLE = (v => {
  if (v == null || v === '') return 1
  if (!/^[1-9]\d*$/.test(v)) throw new Error(`JZ_TEST_SAMPLE must be a whole number of 1 or more, not '${v}'`)
  return Number(v)
})(process.env.JZ_TEST_SAMPLE)

// A place's rank under the seed: FNV-1a over its key, the bits mixed by murmur3's finalizer,
// so the places kept do not follow a grid's strides.
const rank = key => {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193)
  h = Math.imul(h ^ h >>> 16, 0x85ebca6b)
  h = Math.imul(h ^ h >>> 13, 0xc2b2ae35)
  return (h ^ h >>> 16) >>> 0
}

/** The items of `list` this run keeps, in their order: all of them, or under JZ_TEST_SAMPLE=<n>
 *  the ceiling of one in n, the places that rank first under the seed. `label` names the list
 *  in its file, so two lists of one length keep different places. */
export const sample = (list, label) => {
  if (SAMPLE === 1) return list
  const kept = new Set(list.map((_, i) => [rank(`${SEED}:${label}:${i}`), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .slice(0, Math.ceil(list.length / SAMPLE)).map(([, i]) => i))
  return list.filter((_, i) => kept.has(i))
}

/** A sampled test's name: under JZ_TEST_SAMPLE, the sample it takes. */
export const sampled = name => SAMPLE === 1 ? name : `${name} (one program in ${SAMPLE}, seed ${SEED})`

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

/**
 * Every program of `all` (its sample, under JZ_TEST_SAMPLE) called with each of its argument
 *  lists at each of `configs`, against Node: one assertion a differing call, and one a
 *  population saying what it ran. The sample is taken before the programs are joined, so a
 *  population joined in chunks compiles fewer of them.
 */
export function population(label, all, { configs, own = [], chunk = Infinity }) {
  const progs = sample(all, label)
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
  is(true, true, `${label}: ${progs.length}${progs.length < all.length ? ` of ${all.length}` : ''} programs, ${checks} checks, ${configs.length} configurations`)
}
