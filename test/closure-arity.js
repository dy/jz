// Closure ABI: MAX_CLOSURE_ARITY boundary, static arity errors, argc-aware rest packing
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run } from './util.js'
import { compile } from '../index.js'
import { MAX_CLOSURE_ARITY } from '../src/compile.js'

const throws = (code, match, msg) => {
  let error
  try { compile(code) } catch (e) { error = e }
  ok(error && error.message.includes(match), `${msg}: expected "${match}", got "${error?.message}"`)
}

// ============================================================================
// Static errors: closure declaration exceeds MAX_CLOSURE_ARITY
// ============================================================================

test('arity err: closure with 9 fixed params', () => {
  throws(
    `export let f = () => {
      let g = (a,b,c,d,e,f,g,h,i) => a
      return g(1,2,3,4,5,6,7,8,9)
    }`,
    'MAX_CLOSURE_ARITY',
    'nested closure with 9 fixed params should error'
  )
})

test('arity err: closure with 8 fixed + rest has no slot', () => {
  throws(
    `export let f = () => {
      let g = (a,b,c,d,e,f,g,h,...r) => r.length
      return g()
    }`,
    'MAX_CLOSURE_ARITY',
    'closure with 8 fixed + rest should error (rest needs free slot)'
  )
})

// ============================================================================
// Static errors: call site exceeds MAX_CLOSURE_ARITY
// ============================================================================

test('arity err: closure call with 9 args', () => {
  throws(
    `export let f = () => {
      let g = (...r) => r.length
      return g(1,2,3,4,5,6,7,8,9)
    }`,
    'MAX_CLOSURE_ARITY',
    'closure call with 9 args should error'
  )
})

// ============================================================================
// Static errors: top-level function used as value
// ============================================================================

test('arity err: top-level func with 9 params used as value', () => {
  throws(
    `let big = (a,b,c,d,e,f,g,h,i) => a
    let apply = (fn) => fn(1,2,3,4,5,6,7,8)
    export let f = () => apply(big)`,
    'MAX_CLOSURE_ARITY',
    'top-level func with 9 params used as value should error'
  )
})

// ============================================================================
// Boundary: exactly MAX_CLOSURE_ARITY is OK
// ============================================================================

test('arity ok: closure with 8 fixed params (boundary)', () => {
  const { f } = run(`export let f = () => {
    let g = (a,b,c,d,e,f,g,h) => a + b + c + d + e + f + g + h
    return g(1,2,3,4,5,6,7,8)
  }`)
  is(f(), 36)
})

test('arity ok: closure with 7 fixed + rest (boundary)', () => {
  const { f } = run(`export let f = () => {
    let g = (a,b,c,d,e,f,g,...r) => a + b + c + d + e + f + g + r.length
    return g(1,2,3,4,5,6,7,8)
  }`)
  is(f(), 29)  // 28 + rest.length=1
})

test('arity ok: top-level func with 8 params used as value', () => {
  const { f } = run(`
    let big = (a,b,c,d,e,f,g,h) => a + b + c + d + e + f + g + h
    let apply = (fn) => fn(1,2,3,4,5,6,7,8)
    export let f = () => apply(big)
  `)
  is(f(), 36)
})

// ============================================================================
// argc-aware rest packing: runtime length reflects actual args passed
// ============================================================================

test('rest closure: argc=0', () => {
  const { f } = run(`export let f = () => {
    let g = (...r) => r.length
    return g()
  }`)
  is(f(), 0)
})

test('rest closure: argc=1', () => {
  const { f } = run(`export let f = () => {
    let g = (...r) => r.length
    return g(42)
  }`)
  is(f(), 1)
})

test('rest closure: argc=MAX_CLOSURE_ARITY', () => {
  const { f } = run(`export let f = () => {
    let g = (...r) => r.length
    return g(1,2,3,4,5,6,7,8)
  }`)
  is(f(), 8)
})

test('rest closure: sum of all args', () => {
  const { f } = run(`export let f = () => {
    let sum = (...nums) => {
      let s = 0
      for (let i = 0; i < nums.length; i++) s += nums[i]
      return s
    }
    return sum(1,2,3,4,5,6,7,8)
  }`)
  is(f(), 36)
})

test('rest closure: fixed + rest, rest.length reflects overflow only', () => {
  const { f } = run(`export let f = () => {
    let g = (a, b, ...r) => a + b + r.length
    return g(10, 20, 100, 200, 300)
  }`)
  is(f(), 33)  // 10+20+3
})

test('rest closure: fixed + rest, indexing into rest', () => {
  const { f } = run(`export let f = () => {
    let g = (a, ...r) => a + r[0] + r[1] + r[2]
    return g(100, 1, 2, 3)
  }`)
  is(f(), 106)
})

// ============================================================================
// Default params via UNDEF inline-slot padding
// ============================================================================

test('defaults closure: omit arg → default fires', () => {
  const { f } = run(`export let f = () => {
    let g = (x = 42) => x
    return g()
  }`)
  is(f(), 42)
})

test('defaults closure: provide arg → overrides default', () => {
  const { f } = run(`export let f = () => {
    let g = (x = 42) => x
    return g(7)
  }`)
  is(f(), 7)
})

test('defaults closure: partial args, some defaults fire', () => {
  const { f } = run(`export let f = () => {
    let g = (a, b = 10, c = 100) => a + b + c
    return g(1)
  }`)
  is(f(), 111)
})

test('defaults closure: all args provided', () => {
  const { f } = run(`export let f = () => {
    let g = (a, b = 10, c = 100) => a + b + c
    return g(1, 2, 3)
  }`)
  is(f(), 6)
})

test('defaults closure: default captured from outer', () => {
  const { f } = run(`export let f = () => {
    let d = 99
    let g = (x = d) => x
    return g()
  }`)
  is(f(), 99)
})

// ============================================================================
// Mixed fixed + rest + defaults
// ============================================================================

test('closure mixed: fixed + default + rest', () => {
  const { f } = run(`export let f = () => {
    let g = (a, b = 10, ...r) => a + b + r.length
    return g(1)
  }`)
  is(f(), 11)
})

test('closure mixed: fixed + default + rest with args', () => {
  const { f } = run(`export let f = () => {
    let g = (a, b = 10, ...r) => a + b + r.length
    return g(1, 20, 100, 200)
  }`)
  is(f(), 23)  // 1+20+2
})

// ============================================================================
// Spread path: prebuiltArray decode into inline slots
// ============================================================================

test('spread into closure: small array', () => {
  const { f } = run(`export let f = () => {
    let g = (a, b, c) => a + b + c
    let arr = [1, 2, 3]
    return g(...arr)
  }`)
  is(f(), 6)
})

test('spread into closure: rest consumes spread', () => {
  const { f } = run(`export let f = () => {
    let g = (...r) => r.length
    let arr = [1, 2, 3, 4, 5]
    return g(...arr)
  }`)
  is(f(), 5)
})

test('spread into closure: mixed literal + spread', () => {
  const { f } = run(`export let f = () => {
    let sum = (...n) => {
      let s = 0
      for (let i = 0; i < n.length; i++) s += n[i]
      return s
    }
    let arr = [2, 3]
    return sum(1, ...arr, 4)
  }`)
  is(f(), 10)
})

// ============================================================================
// HOF + spread combinations
// ============================================================================

test('HOF: callback with defaults', () => {
  const { f } = run(`
    let apply = (fn) => fn()
    export let f = () => {
      let g = (x = 7) => x * 2
      return apply(g)
    }
  `)
  is(f(), 14)
})

test('HOF: callback with rest receives correct count', () => {
  const { f } = run(`
    let apply3 = (fn) => fn(1, 2, 3)
    export let f = () => {
      let g = (...r) => r.length
      return apply3(g)
    }
  `)
  is(f(), 3)
})

test('HOF: top-level i32-param func used as value', () => {
  const { f } = run(`
    let twice = (n) => n * 2
    let apply = (fn, x) => fn(x)
    export let f = () => apply(twice, 21)
  `)
  is(f(), 42)
})

// ============================================================================
// Constant sanity check
// ============================================================================

test('MAX_CLOSURE_ARITY exported value', () => {
  is(MAX_CLOSURE_ARITY, 8)
})
