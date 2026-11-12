// The optimizer's order is one table (src/optimize/pass-table.js): the module stage, each
// function's passes, link's and the tail's are walks of it, and a step run out of the order
// its entry states fails here. The sequences bind their runners where they load
// (pass-table.js `stage`): a stage whose runners and entries differ fails to load.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { PASSES, checkOrder, on } from '../src/optimize/pass-table.js'
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
