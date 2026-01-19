import test from 'tst'
import { is } from 'tst/assert.js'
import { evaluate } from './util.js'

const GC = { gc: false }

test('early return - simple', async () => {
  is(await evaluate('f = () => { if (1) return 42; return 0 }; f()'), 42)
})

test('early return - conditional', async () => {
  is(await evaluate('f = x => { if (x > 5) return 1; return 0 }; f(10)'), 1)
  is(await evaluate('f = x => { if (x > 5) return 1; return 0 }; f(3)'), 0)
})

test('early return - in loop', async () => {
  const code = `f = x => {
    for (let i = 0; i < 10; i = i + 1) {
      if (i === x) return i * 10
    }
    return -1
  }; f(5)`
  is(await evaluate(code), 50)
  const code2 = `f = x => {
    for (let i = 0; i < 10; i = i + 1) {
      if (i === x) return i * 10
    }
    return -1
  }; f(20)`
  is(await evaluate(code2), -1)
})

test('gc:false - early return', async () => {
  is(await evaluate('f = () => { if (1) return 42; return 0 }; f()', 0, GC), 42)
  is(await evaluate('f = x => { if (x > 5) return 1; return 0 }; f(10)', 0, GC), 1)
  is(await evaluate('f = x => { if (x > 5) return 1; return 0 }; f(3)', 0, GC), 0)
})

