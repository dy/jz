// A receiver that is itself an element read whose one missing value is absence
// (`pts[i][0]`, `bones[i].start`: the array holds arrays or objects, never
// null) throws from that read's own bounds test; the check the receiver would
// have had after it is gone. An array that may hold null keeps its check, and a
// receiver whose only missing value is absence tests for undefined alone
// (module/array.js `throwAbsent`, module/core.js). The index is a counter: a
// key the host may pass as anything takes the keyed read, checks and all.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const fnText = (text, name) => funcWat(text, name + '$exp') || funcWat(text, name)

const src = `const pts = [[1, 2], [3, 4]], objs = [{ v: [5, 6] }, { v: [7, 8] }], mixed = [[1], null, [3]]
  export const x = (n) => { let s = 0; for (let i = 0; i < n; i++) s += pts[i][0] + objs[i].v[1]; return s }
  export const y = (n) => { let s = 0; for (let i = 0; i < n; i++) s += mixed[i][0]; return s }`

test('present receiver: in-range reads answer, a read past the end throws, as the host does', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(src), jz = run(src, { optimize })
    for (const n of [0, 1, 2]) is(jz.x(n), host.x(n), `x(${n}) at ${optimize}`)
    throws(() => jz.x(3), 'x(3): the element past the end has no [0]')
    throws(() => host.x(3))
    is(jz.y(1), host.y(1), `y(1) at ${optimize}`)
    throws(() => jz.y(2), 'y(2): a null element has no [0]')
    throws(() => host.y(2))
  }
})

test('present receiver: the bounds test is the only test, a null-holding array keeps its check', () => {
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  const x = fnText(text, 'x'), y = fnText(text, 'y')
  is((x.match(/i64\.eq/g) || []).length, 0, 'x compares no sentinel: its receivers throw from their bounds tests')
  ok(/call \$__throw_property_nullish/.test(x), 'the miss arm throws')
  ok(/i64\.eq/.test(y), 'y still tests the element it read: the array holds a null')
})
