// The optimizer's order is one table (src/optimize/pass-table.js): the module stage, each
// function's passes, link's and the tail's are walks of it, and a step run out of the order
// its entry states fails here. The sequences bind their runners where they load
// (pass-table.js `stage`): a stage whose runners and entries differ fails to load.
// What a step takes and makes of the compile's facts is held as it runs (_facts-guard.js).
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { PASSES, WALKS, checkOrder, on } from '../src/optimize/pass-table.js'
import { compile } from './util.js'
import { hold } from './_facts-guard.js'
import { PASS_NAMES, TUNING_KEYS } from '../src/optimize/index.js'
import '../src/wat/assemble/optimize-module.js'
import '../src/link/index.js'
import '../src/optimize/watr-tail.js'

const at = (id, table = PASSES) => table.findIndex(e => e.id === id)
/** The table with step `id` moved to stand at `to`. */
const moved = (id, to) => {
  const t = [...PASSES]
  const [e] = t.splice(at(id), 1)
  t.splice(to, 0, e)
  return t
}
const faults = (table, text) => checkOrder(table).filter(f => f.includes(text))

test('pass table: every step runs in the order its entry states', () => {
  is(checkOrder(), [])
})

test('pass table: a step out of its order fails the check', () => {
  // an `after` stated by the code's own comment
  ok(faults(moved('shiftRemainder', at('fusedRewrite')), `'shiftRemainder' runs before 'fusedRewrite'`).length, 'the quotient read before the fused walk')
  ok(faults(moved('narrowLoopBound', at('hoistInvariantLoop') + 1), `'hoistInvariantLoop' runs before 'narrowLoopBound'`).length, 'LICM before the snapped bound')
  ok(faults(moved('ringLaps', at('pointerExits') + 1), `'pointerExits' runs before 'ringLaps'`).length, 'a counter a pointer test before its laps')
  // a fact taken before the step that makes it
  ok(faults(moved('narrowInts', at('specializeLoops')), `takes 'copies' before 'specializeLoops' makes it`).length, 'the copies before they exist')
  ok(faults(moved('loopRewinds', at('quietCopies')), `takes 'quietLoops'`).length, 'the quiet loops before they are asked')
  // first and last of a stage
  ok(faults(moved('foldStaticArrReads', at('nanCanon')), `'foldStaticArrReads' runs first`).length, 'a pass ahead of the marks\' reader')
  ok(faults(moved('hoistVectorConsts', at('splitFuncs')), `'hoistVectorConsts' runs last`).length, 'a pass after the last tail step')
  // a mark dropped before its reader
  const table = PASSES.map(e => e.id === 'nanCanon' ? { ...e, drops: ['dvProp'] } : e)
  ok(faults(table, `'nanCanon' drops the mark 'dvProp' before 'devirtSchemaReads'`).length === 0, 'a reader that lists the mark as lost acts on those left')
  const strict = table.map(e => e.id === 'devirtSchemaReads' ? { ...e, lost: [] } : e)
  ok(faults(strict, `'nanCanon' drops the mark 'dvProp' before 'devirtSchemaReads' reads it`).length, 'a dropped mark its reader does not list')
  // twice
  ok(faults([...PASSES, PASSES[0]], 'twice').length, 'one entry a step')
})

test('pass table: a walked stage stands behind the step that walks it', () => {
  // A function's steps run where `optimizeFuncs` does: listed elsewhere, an order between
  // one of them and a module step would be read off the table and not be the run's.
  for (const id in WALKS) {
    const first = PASSES.find(e => e.at === WALKS[id]).id
    ok(faults(moved(first, 0), `the '${WALKS[id]}' steps stand right behind '${id}'`).length, `${WALKS[id]}: its first step listed ahead of the module`)
    ok(faults(moved(id, PASSES.length - 1), `the '${WALKS[id]}' steps stand right behind '${id}'`).length, `${WALKS[id]}: the step that walks it listed after`)
  }
  ok(faults(PASSES.filter(e => e.id !== 'optimizeFuncs'), `'optimizeFuncs' walks the stage 'func'`).length, 'a stage nothing walks')
})

// Programs that between them reach the steps that read the compile's facts: module typed
// arrays under a loop the vectorizer lifts; a table of arrows and objects read by field;
// strings and arrays made in a loop, a throw; a static table read by index.
const PROGRAMS = [
  `const a = new Float64Array(64), b = new Float64Array(64)
   export let f = (k) => { for (let i = 0; i < 64; i++) a[i] = b[i] * k + 1; return a[3] }`,
  `const ops = [(x) => x + 1, (x) => x * 2, (x) => x - 3]; const mk = (i) => ({ v: i, w: i * 2 })
   export let f = (k) => { let s = 0; for (let i = 0; i < 8; i++) { const o = mk(i); s += ops[i % 3](o.v + o.w) } return s + k }`,
  `export let f = (k) => { let s = ''; const xs = []; for (let i = 0; i < k; i++) { xs.push('' + i); s += xs[i] }
     if (k < 0) throw new Error('neg'); return s.length }`,
  `const T = [3, 1, 4, 1, 5, 9, 2, 6]
   export let f = (k) => { let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + T[i & 7] + k) | 0; return h }`,
]
const LEVELS = [{ optimize: 2 }, { optimize: 'speed' }, { optimize: 'size' }, { optimize: 'speed', host: 'wasi' }, { optimize: { level: 2, watr: false } }]

test('pass table: a step reads of the facts what its entry takes, and writes what it makes', () => {
  const free = hold()
  try {
    for (const src of PROGRAMS) for (const opts of LEVELS) ok(compile(src, opts).length > 8, `${JSON.stringify(opts)}: ${src.slice(0, 40)}`)
    // The hold has teeth: an entry that states less than its step reads or writes fails the compile.
    const without = (id, field, word, run) => {
      const e = PASSES.find(e => e.id === id), was = e[field]
      e[field] = was.filter(w => w !== word)
      try { run() } finally { e[field] = was }
    }
    without('fusedRewrite', 'takes', 'hasBigint', () =>
      throws(() => compile(PROGRAMS[0], { optimize: 2 }), /'fusedRewrite' reads the fact 'hasBigint', which its entry does not take/))
    without('optimizeFuncs', 'makes', 'headerSafeFuncs', () =>
      throws(() => compile(PROGRAMS[0], { optimize: 2 }), /'optimizeFuncs' writes the fact 'headerSafeFuncs', which its entry does not make/))
    without('treeshake', 'takes', 'userFuncs', () =>
      throws(() => compile(PROGRAMS[0], { optimize: 2 }), /'treeshake' reads the fact 'userFuncs'/))
    without('legalize', 'takes', 'targetProfile', () =>
      throws(() => compile(PROGRAMS[0], { optimize: 2 }), /'legalize' reads the fact 'targetProfile'/))
  } finally { free() }
})

test('pass table: every flag a step runs under is a registered optimize key', () => {
  const known = new Set([...PASS_NAMES, ...TUNING_KEYS])
  for (const e of PASSES) for (const alts of e.tests) for (const { name } of alts) ok(known.has(name), `${e.id} runs under '${name}'`)
  for (const e of PASSES) for (const id in e.after) ok(at(id) >= 0, `${e.id} follows '${id}'`)
})

test('pass table: a step runs under its flags as the config reads them', () => {
  const step = (o) => PASSES.find(e => e.on === o)
  // `x` runs unless the flag is false, `+x` only where it is true; an absent config runs every step but the opt-in ones
  is([on(step('fusedRewrite'), undefined), on(step('fusedRewrite'), {}), on(step('fusedRewrite'), { fusedRewrite: false })], [true, true, false])
  is([on(step('+sinkStores'), undefined), on(step('+sinkStores'), { sinkStores: 1 }), on(step('+sinkStores'), { sinkStores: true })], [false, false, true])
  // `?x` where truthy, `!x` where falsy, `a|b` either, and every test of a step
  is([on(step('?leanRuntime'), { leanRuntime: 1 }), on(step('?leanRuntime'), {})], [true, false])
  is([on(step('sortLocalsByUse !watr'), { watr: { profile: 'speed' } }), on(step('sortLocalsByUse !watr'), { watr: false })], [false, true])
  const either = step('hoistGlobalConstLoads|maskedSuffixGuard')
  is([on(either, { hoistGlobalConstLoads: false }), on(either, { hoistGlobalConstLoads: false, maskedSuffixGuard: false })], [true, false])
  is([on(step('intNarrow +specializeLoops'), { specializeLoops: true }), on(step('intNarrow +specializeLoops'), { specializeLoops: true, intNarrow: false })], [true, false])
})
