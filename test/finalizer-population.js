// A population of finalizers after a body that may throw, each answering what Node answers
// at every level. A finalizer is emitted once for each way out of its body: the normal way,
// the handler's and a `return`'s. The copies are the same source, so they read the same
// locals, and a value the optimizer keeps from one copy (a tag, an array's storage, an
// address, a load) is no value on a way that did not run it. `f(o, i, t)` runs a use of
// `o` in the finalizer; `main` calls it without a throw, with one, and without again, each
// with other arguments, so a value left over from another copy or another call shows.
//
// Guards the class "a block's end a `try_table`'s catch clause branches to is a join". The
// try population has finalizers too, of parameters of two kinds; here each parameter is of
// one kind, as the values the optimizer shares are.
import test from 'tst'
import { is } from 'tst/assert.js'
import { jz, oracle } from './util.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']
// [name, the three arguments, the use]
const TYPED = Array(3).fill(`new Float64Array([1, 2, 4, 8, 16, 32, 64, 128])`)
const LIST = Array(3).fill(`[1, 2, 4, 8, 16, 32, 64, 128]`)
const WORDS = Array(3).fill(`new Int32Array([0x01020304, 5, 0x0a0b0c0d, 6, 0x11121314, 7, 8, 9])`)
const USES = [
  ['a typed element read twice', TYPED, `sum += o[i] + o[i + 1]`],
  ['a typed element written and read', TYPED, `o[i] = o[i] + o[i + 1]; sum += o[i]`],
  ['an element read twice', LIST, `sum += o[i] * 2 + o[i + 1]`],
  ['an element written and read', LIST, `o[i] = o[i + 1] + 1; sum += o[i]`],
  ['a field read twice', [`{ x: 1, y: 2 }`, `{ x: 4, y: 8 }`, `{ x: 16, y: 32 }`], `sum += o.x + o.y * 2 + o.x`],
  ['a length read in a loop', [`[1, 2]`, `[4, 8, 16]`, `[32]`], `for (let j = 0; j < o.length; j++) sum += o[j]`],
  ['a tag tested twice', [`'a'`, `7`, `'b'`], `if (typeof o === 'string') sum += 1; else sum += 10; if (typeof o === 'number') sum += 100`],
  ['an array or a typed array', [`[1, 2]`, `new Float64Array([4, 8])`, `[16, 32]`], `if (Array.isArray(o)) sum += o[0]; else sum += o[1] * 2; if (o instanceof Float64Array) sum += 1000`],
  ['a string read', [`'abc'`, `'defg'`, `'hi'`], `sum += o.length + o.charCodeAt(i & 1)`],
  ['a closure called twice', [`(v) => v + 1`, `(v) => v * 2`, `(v) => v - 3`], `sum += o(i) + o(i + 1)`],
  ['a word read once', WORDS, `sum += o[i]`],
  ['the bytes of a word', WORDS, `sum += (o[i] & 255) + (o[i] >>> 8 & 255) + (o[i] >>> 24)`],
]
const FORMS = [
  ['a finalizer', (use) => `try { if (t) throw 1 } finally { ${use} }`],
  ['a finalizer of a body that returns', (use) => `try { if (t) throw 1; return 1 } finally { ${use} }`],
  ['a finalizer of a callee that throws', (use) => `try { thrower(t) } finally { ${use} }`],
  ['a finalizer of a body with the use', (use) => `try { ${use}; if (t) throw 1 } finally { ${use} }`],
  ['a finalizer after a handler that throws on', (use) => `try { try { if (t) throw 1 } catch (e) { sum += 0.5; throw e } } finally { ${use} }`],
  ['a handler and a finalizer', (use) => `try { if (t) throw 1 } catch (e) { ${use}; throw e } finally { ${use} }`],
  ['a finalizer in a loop', (use) => `for (let k = 0; k < 2; k++) { try { if (t && k) throw 1 } finally { ${use} } i += 1 }`],
]
// A module to a program: what the optimizer shares in a function turns on what its module
// inlines and what its callers pass (the one defect this population has caught showed in a
// module of one and not in a module of twelve).
const program = ([, [a, b, c], use], at) => `let sum = 0
let thrower = (t) => { if (t) throw 1; return 0 }
let f = (o, i, t) => { ${at(use)}; return 0 }
export let main = () => { sum = 0
  f(${a}, 0, 0)
  try { f(${b}, 2, 1) } catch (e) { sum += 0.25 }
  f(${c}, 4, 0)
  return sum }`

for (const [form, at] of FORMS) test(`finalizer population: ${form}, ${USES.length} uses, ${CONFIGS.length} configurations`, () => {
  for (const use of USES) {
    const src = program(use, at), want = String(oracle(src).main())
    for (const optimize of CONFIGS) {
      let got
      try { got = String(jz(src, { optimize }).exports.main()) } catch (e) { got = `throws: ${String(e.message).split('\n')[0]}` }
      // (one assertion per differing program)
      if (got !== want) is(got, want, `${use[0]} in ${form}, at ${JSON.stringify(optimize)}`)
    }
  }
  is(true, true, `${form}: ${USES.length} programs`)
})
