/**
 * No node is compared or keyed by its JSON text. JSON writes NaN, the infinities,
 * null and undefined all as `null` and -0 as `0`: two nodes differing only there
 * were one node to every comparison that read their text (src/ast.js nodeEqual,
 * nodeKey). The check holds every JSON.stringify of the compiler to a reason; the
 * programs are the miscompiles such a comparison made.
 */
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { nodeEqual, nodeKey, constText } from '../src/ast.js'
import { jz, oracle, wat } from './util.js'
import { levels } from './_matrix.js'

const ROOT = join(import.meta.dirname, '..')

// Leaves JSON writes alike, each its own value, and nodes made of them.
const LEAVES = [null, undefined, NaN, Infinity, -Infinity, 0, -0, 1, '1', 'null', true, 5n]
const NODES = [
  ...LEAVES.map(v => [, v]), ...LEAVES.map(v => ['f64.const', v]), [], [null], [undefined, undefined],
  ['+', 'x', [, null]], ['+', 'x', [, Infinity]], ['+', 'x', [, undefined]], ['+', 'x', ['nan']],
  [['a', 'b'], 'c'], ['a', ['b', 'c']], ['v128.const', 'f64x2', 0, 1], ['v128.const', 'f64x2', -0, 1],
]

test('node keys: a node is one node only where every leaf is the same value', () => {
  for (let i = 0; i < NODES.length; i++) for (let j = 0; j < NODES.length; j++) {
    const a = NODES[i], b = NODES[j], same = i === j || (a.length === 2 && b.length === 2 && a[0] === undefined && b[0] === undefined && Object.is(a[1], b[1]))
    is(nodeEqual(a, b), same, `nodeEqual(${nodeKey(a)}, ${nodeKey(b)})`)
    is(nodeKey(a) === nodeKey(b), nodeEqual(a, b), `nodeKey(${nodeKey(a)}) against nodeKey(${nodeKey(b)})`)
  }
  for (const n of NODES) { const c = structuredClone(n); ok(nodeEqual(n, c) && nodeKey(n) === nodeKey(c), `a copy of ${nodeKey(n)} is it`) }
  // a literal's head is a hole or null, the literal either way
  ok(nodeEqual([, 1.5], [null, 1.5]) && nodeKey([, 1.5]) === nodeKey([null, 1.5]), 'a hole head and a null head are one literal')
  ok(!nodeEqual([1, null], [1, undefined]), 'past the head null is not undefined')
  // where no leaf is one JSON writes as another's, the key is the JSON text
  is(nodeKey(['i32.add', ['local.get', '$i'], ['i32.const', 4]]), JSON.stringify(['i32.add', ['local.get', '$i'], ['i32.const', 4]]))
  is(nodeKey([, null]), '[null,null]')
  is(nodeKey([, undefined]), '[null,undefined]')
  is(nodeKey(['f64.const', -0]), '["f64.const",-0]')
  // an object has no text of its own, and no node holds one: its key is refused, not shared
  throws(() => nodeKey(['+', 'x', {}]), /no text of its own/)
  ok(!nodeEqual(['+', 'x', {}], ['+', 'x', {}]), 'two objects are two leaves')
  // a constant's text is its value's: the spelling of a number aside, -0 and every lane kept
  is(constText(['i32.const', '2']), constText(['i32.const', 2]))
  ok(constText(['f64.const', -0]) !== constText(['f64.const', 0]), '-0 is not 0')
  ok(constText(['v128.const', 'i32x4', 0, 1, 2, 3]) !== constText(['v128.const', 'i32x4', 0, 1, 2, 4]), 'every lane')
})

// ---- the check: every JSON.stringify under src, module and jzify, and why it is no node's key ----
// [file, a fragment of its line, the reason]. A use matches the first entry of its file whose
// fragment its line holds; an entry no use matches is stale and fails too.
const MESSAGE = 'an error message shows the node'
const DEBUG = 'debug output'
const WHY = 'a `why` or warning message shows the node'
const ALLOWED = [
  ['src/ast.js', 'plainNode(n) ? JSON.stringify(n)', 'nodeKey: the JSON text of a node none of whose leaves JSON writes as another\'s'],
  ['src/ast.js', "if (typeof n === 'string') return JSON.stringify(n)", 'nodeKey: a string leaf, quoted'],
  ['src/ast.js', 'export const schemaKey', 'a key of a brand and property names, all strings'],
  ['src/source-literal.js', "if (typeof v === 'string') return JSON.stringify(v)", 'a string written as source text'],
  ['src/source-literal.js', 'JSON.stringify(key)', 'an object key written as source text'],
  ['src/compiler.js', 'JSON.stringify(map)', 'the source map, a JSON document'],
  ['src/ctx.js', "if (typeof v === 'string') return JSON.stringify(v)", 'a string leaf in an error message'],
  ['src/snapshot.js', 'JSON.stringify(startName)', 'a function\'s text searched for a name, which JSON writes quoted: no number leaf spells one'],
  ['src/snapshot.js', 'const startText = JSON.stringify(startFn)', 'the start function\'s text searched for a name'],
  ['src/snapshot.js', '.includes(\'"memory"\')', 'an import\'s text searched for a name'],
  ['src/optimize/devirt.js', 'console.error', DEBUG],
  ['src/optimize/unswitch.js', 'console.error', DEBUG],
  ['src/compile/loop-recurrence.js', 'console.error', DEBUG],
  ['src/compile/narrow/specialize.js', 'console.error', DEBUG],
  ['src/compile/index.js', "sec.customs.push(['@custom'", 'a custom section: the JSON of names and numbers the host reads'],
  ['src/compile/index.js', 'warn(', WHY],
  ['src/compile/index.js', 'whyNotRewind', WHY],
  ['src/compile/numeric-arrays.js', 'why.push', WHY],
  ['src/prepare/handlers.js', 'err(`', MESSAGE],
  ['src/compile/emit/assignment.js', 'err(`', MESSAGE],
  ['src/link/sections.js', 'encStr(out, JSON.stringify(p)', 'a property name\'s escaped text in a custom section'],
  ['src/link/sections.js', 'encStr(out, JSON.stringify(pattern))', 'a regular expression\'s pattern in a custom section'],
  ['src/link/sections.js', 'utf8.encode(JSON.stringify({ release', 'the release metadata section'],
  ['module/simd.js', 'err(`', MESSAGE],
  ['module/typedarray.js', 'err(`', MESSAGE],
  ['module/json.js', "JSON.stringify(k) + ':'", 'JSON.stringify folded at compile time: a key\'s JSON text, the program\'s output'],
  ['module/json.js', 'const s = JSON.stringify(v)', 'JSON.stringify folded at compile time: the program\'s output'],
  ['module/json.js', 'JSON.stringify(picked, null, sp)', 'JSON.stringify folded at compile time: the program\'s output'],
  ['module/json.js', 'JSON.stringify(shapeSignature(parsed))', 'a key of a JSON shape: type names and property names'],
  ['module/regex.js', "'RegExp:' + JSON.stringify([pattern, flags])", 'a schema brand of a pattern and its flags, strings'],
  ['jzify/classes.js', 'jzifyError(`', MESSAGE],
]

const jsFiles = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) jsFiles(p, out)
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}
// (a mention in a comment, a WAT template's `;;` comment among them, is no use)
const inComment = (line, at) => /^\s*(\*|\/\/|\/\*)/.test(line) || line.slice(0, at).includes('//') || line.slice(0, at).includes(';;')

test('node keys: every JSON.stringify of the compiler is of no node, by a reason it states', () => {
  const used = new Set(), unexplained = []
  for (const dir of ['src', 'module', 'jzify']) for (const file of jsFiles(join(ROOT, dir))) {
    const rel = relative(ROOT, file).split('\\').join('/')
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (let at = line.indexOf('JSON.stringify('); at >= 0; at = line.indexOf('JSON.stringify(', at + 1)) {
        if (inComment(line, at)) continue
        const entry = ALLOWED.find(([f, frag]) => f === rel && line.includes(frag))
        if (entry) used.add(entry)
        else unexplained.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`)
      }
    })
  }
  ok(!unexplained.length, `compare or key a node by nodeEqual or nodeKey (src/ast.js), or state here why the text is of no node:\n${unexplained.join('\n')}`)
  const stale = ALLOWED.filter(e => !used.has(e))
  ok(!stale.length, `entries no use matches:\n${stale.map(e => e.slice(0, 2).join(': ')).join('\n')}`)
})

// ---- what the comparisons took for one ----
const agree = (src, args, optimizes) => {
  const host = oracle(src)
  for (const optimize of optimizes) {
    const got = jz(src, { optimize }).exports
    for (const a of args) is(Object.is(got.f(...a), host.f(...a)) ? 'same' : `${got.f(...a)}`, 'same', `${src} for ${a} at ${optimize}: Node ${host.f(...a)}`)
  }
}

// Closure bodies were deduplicated by a hash and a comparison kept to the JSON key's
// classes: undefined, null, NaN and the infinities one leaf, -0 the leaf 0
// (wat/assemble/closure-table.js).
test('node keys: closures differing in a constant stay two closures', () => {
  for (const src of [
    `export let f = (k) => { const fs = [() => Infinity, () => -Infinity]; return fs[k & 1]() }`,
    `export let f = (k) => { const fs = [() => 0, () => -0]; return 1 / fs[k & 1]() }`,
    `export let f = (k) => { const fs = [(x) => x * Infinity, (x) => x * -Infinity, (x) => x * NaN, (x) => x * (0 / 0)]; return fs[k & 3](k + 1) }`,
  ]) agree(src, [[0], [1], [2], [3]], levels(0, 2, 'speed'))
})

// A counted loop's body written out by hand (`t[i] = …; t[i + 1] = …` stepping by 2)
// rolls back into one statement where its copies are one statement but their index:
// they were compared by their JSON text (plan/counted-loops.js `same`).
test('node keys: a loop written out twice keeps each copy its constant', () => {
  for (const src of [
    `export let f = (k) => { const t = new Float64Array(4); for (let i = 0; i < 4; i += 2) { t[i] = k + null; t[i + 1] = k + Infinity } return t[1] + t[2] * 10 }`,
    `export let f = (k) => { const t = new Float64Array(4); for (let i = 0; i < 4; i += 2) { t[i] = k * 0; t[i + 1] = k * -0 } return (1 / t[1] < 0 ? 1 : 0) + (1 / t[2] < 0 ? 10 : 0) }`,
  ]) agree(src, [[0], [1], [5]], levels(0, 2, 'speed'))
})

// Two arms that are one tree but for a zero's sign: optimize/select-arms.js compared
// leaves by ===, took the arms for one and left the branch as it was. The leaves
// differ, and the arms are the tree over a choice of them.
test('node keys: arms differing in a zero\'s sign choose between the two zeros', () => {
  const src = `export let f = (k) => { const v = k * 0.5; let r; if (k > 2) r = v + 0; else r = v + -0; return r }`
  agree(src, [[-0], [0], [3]], levels(0, 2, 'speed'))
  ok(/\(select\s+\(f64\.const 0\)\s+\(f64\.const -0\)/.test(wat(src, { optimize: 2 })), 'the choice is between 0 and -0')
})

// Hoisted constant arrays shared a segment by the text of their values, written by
// join, -0 as 0 (prepare/literals.js).
test('node keys: [0, 1] and [-0, 1] are two arrays', () => {
  for (const src of [
    `export let f = (i) => 1 / [0, 1][i & 1] + 10 / [-0, 1][i & 1]`,
    `export let f = (i) => 1 / [-0, 1][i & 1] + 10 / [0, 1][i & 1]`,
  ]) agree(src, [[0], [1]], levels(0, 2, 'speed'))
})
