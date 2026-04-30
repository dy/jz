// Spread, destruct alias, TypedArrays, Set, Map
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'

const interp = { __ext_prop:()=>0, __ext_has:()=>0, __ext_set:()=>0, __ext_call:()=>0 }
function run(code) {
  return new WebAssembly.Instance(new WebAssembly.Module(compile(code)), { env: interp }).exports
}

// === Object destruct alias ===

test('destruct: {x: a, y: b} = obj', () => {
  is(run(`export let f = () => {
    let o = {x: 10, y: 20}
    let {x: a, y: b} = o
    return a + b
  }`).f(), 30)
})

// === Array spread ===

test('spread: [...a, ...b]', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    let b = [3, 4]
    let c = [...a, ...b]
    return c.length
  }`)
  is(f(), 4)
})

test('spread: [...a, ...b] values', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20]
    let b = [30, 40]
    let c = [...a, ...b]
    return c[0] + c[1] + c[2] + c[3]
  }`)
  is(f(), 100)
})

test('spread: [...a, 99]', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    let b = [...a, 99]
    return b[3]
  }`)
  is(f(), 99)
})

test('in: array numeric index exists', () => {
  const { f } = run(`export let f = () => {
    let list = [7]
    return 0 in list
  }`)
  is(f(), 1)
})

test('in: array alias table resolves numeric membership', () => {
  const { f } = run(`export let f = () => {
    let list = [7]
    list['$>'] = 0
    let n = list['$>']
    return n in list ? n : -1
  }`)
  is(f(), 0)
})

test('spread: preserves left-to-right evaluation order', () => {
  const { f } = run(`export let f = () => {
    let idx = "$>"
    let side = () => { idx = 0/0; return [] }
    let code = [[idx, [], []], ...side()]
    return code[0][0] === "$>"
  }`)
  is(f(), 1)
})

test('for-in: compile-time unroll clones body per key', () => {
  const { f } = run(`export let f = () => {
    let section = {tag: 13, code: 10}
    let ctx = []
    for (let kind in section) {
      ;(ctx[section[kind]] = ctx[kind] = []).name = kind
    }
    return (ctx.tag !== ctx.code) + (ctx.tag.name == "tag") + (ctx.code.name == "code")
  }`)
  is(f(), 3)
})

test('array methods: chained receiver evaluates once', () => {
  const { f } = run(`export let f = () => {
    let arr = [['func']]
    let a = 0, b = 0
    arr.filter((n) => {
      let kind = n[0]
      if (kind == 'func') a += 1
      if (kind == 'tag') a += 2
      return true
    }).forEach((n) => {
      let kind = n[0]
      if (kind == 'func') b += 1
      if (kind == 'tag') b += 2
    })
    return a * 10 + b
  }`)
  is(f(), 11)
})

test('callbacks: captured arrays keep dynamic properties', () => {
  const { f } = run(`export let f = () => {
    let section = {func: 3, code: 10, tag: 13}
    let ctx = []
    let seq = [['func']]
    let seen = 0
    for (let kind in section) (ctx[section[kind]] = ctx[kind] = []).name = kind
    seq.forEach((n) => {
      if (n[0] == 'func') seen += (ctx.code === ctx[10]) * 10 + (ctx.tag === ctx[13])
    })
    return seen
  }`)
  is(f(), 11)
})

test('callbacks: captured arrays support computed dynamic keys', () => {
  const { f } = run(`export let f = () => {
    let section = {func: 3, code: 10, tag: 13}
    let ctx = []
    let seq = [['func']]
    let seen = 0
    for (let kind in section) (ctx[section[kind]] = ctx[kind] = []).name = kind
    seq.forEach((n) => {
      let kind = n[0]
      let items = ctx[kind]
      items.push(1)
      seen += (ctx[3].length == 1) * 100 + (ctx.func.length == 1) * 10 + (items.length == 1)
    })
    return seen
  }`)
  is(f(), 111)
})

// === TypedArrays ===

test('Float64Array: create + length', () => {
  const { f } = run(`export let f = () => {
    let a = new Float64Array(10)
    return a
  }`)
  ok(isNaN(f()))  // NaN-boxed pointer
})

test('Int32Array: create', () => {
  const { f } = run(`export let f = () => {
    let a = new Int32Array(5)
    return a
  }`)
  ok(isNaN(f()))
})

// === Set ===

test('Set: create + add + has', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s = s.add(42)
    return s.has(42)
  }`)
  is(f(), 1)
})

test('Set: has missing', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s = s.add(1)
    return s.has(99)
  }`)
  is(f(), 0)
})

test('Set: size', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s = s.add(1)
    s = s.add(2)
    s = s.add(3)
    return s.size
  }`)
  is(f(), 3)
})

test('Set: no duplicates', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s = s.add(1)
    s = s.add(1)
    s = s.add(1)
    return s.size
  }`)
  is(f(), 1)
})

test('Set: delete returns 1 if found', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s = s.add(10)
    return s.delete(10) + s.has(10)
  }`)
  is(f(), 1)  // delete=1, has=0
})

// === Map ===

test('Map: set + get', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    m = m.set(1, 100)
    m = m.set(2, 200)
    return m.get(1) + m.get(2)
  }`)
  is(f(), 300)
})

test('Map: get missing returns nullish', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    m = m.set(1, 100)
    return m.get(99)
  }`)
  ok(Number.isNaN(f()))
})

test('Map: overwrite', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    m = m.set(1, 100)
    m = m.set(1, 999)
    return m.get(1)
  }`)
  is(f(), 999)
})

test('Map: size', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    m = m.set(1, 10)
    m = m.set(2, 20)
    m = m.set(3, 30)
    return m.size
  }`)
  is(f(), 3)
})

// === instanceof (jzify transforms to typeof / Array.isArray) ===

function runJzify(code) {
  return new WebAssembly.Instance(new WebAssembly.Module(compile(code, { jzify: true })), { env: interp }).exports
}

test('instanceof jzify: Array → Array.isArray', () => {
  const { f } = runJzify(`export let f = () => {
    let x = [1, 2, 3]
    return x instanceof Array
  }`)
  is(f(), 1)
})

test('instanceof jzify: Array.isArray rejects non-array', () => {
  const { f } = runJzify(`export let f = (x) => x instanceof Array`)
  is(f(42), 0)
  is(f('hello'), 0)
})

test('instanceof jzify: Object → typeof === object', () => {
  const { f } = runJzify(`export let f = () => {
    let x = {}
    return x instanceof Object
  }`)
  is(f(), 1)
})

test('instanceof jzify: Object rejects primitives', () => {
  const { f } = runJzify(`export let f = () => {
    return (1 instanceof Object) + ('hi' instanceof Object)
  }`)
  is(f(), 0)
})

test('instanceof jzify: Float64Array → typeof === object', () => {
  const { f } = runJzify(`export let f = () => {
    let x = new Float64Array(1)
    return x instanceof Float64Array
  }`)
  is(f(), 1)
})

test('instanceof jzify: unknown constructor falls back to typeof === object', () => {
  const { f } = runJzify(`export let f = (x) => x instanceof MyClass`)
  is(f({}), 1)
  is(f(42), 0)
})

test('instanceof jzify: nested expression', () => {
  const { f } = runJzify(`export let f = () => {
    let a = [1, 2]
    return (a instanceof Array) + (a instanceof Object)
  }`)
  is(f(), 2)
})
