// NaN-boxing pointer encoding tests + multi-value threshold
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import compile from '../index.js'

function run(code, opts) {
  const wasm = compile(code, opts)
  const mod = new WebAssembly.Module(wasm)
  return new WebAssembly.Instance(mod).exports
}

// === Multi-value threshold ===

test('multi: vec2', () => {
  const r = run('export let f = (a, b) => [a, b]').f(1, 2)
  ok(Array.isArray(r))
  is(r[0], 1)
  is(r[1], 2)
})

test('multi: vec3', () => {
  const r = run('export let f = (a, b, c) => [a, b, c]').f(1, 2, 3)
  ok(Array.isArray(r))
  is(r.length, 3)
})

test('multi: vec4', () => {
  const r = run('export let f = (a, b, c, d) => [a, b, c, d]').f(1, 2, 3, 4)
  ok(Array.isArray(r))
  is(r[3], 4)
})

test('multi: vec8 (threshold)', () => {
  const r = run('export let f = (a, b) => [a, a+1, a+2, a+3, b, b+1, b+2, b+3]').f(10, 20)
  ok(Array.isArray(r))
  is(r.length, 8)
  is(r[0], 10)
  is(r[7], 23)
})

test('multi: >8 becomes pointer', () => {
  const { f, g } = run(`
    export let f = () => {
      let a = [1, 2, 3, 4, 5, 6, 7, 8, 9]
      return a
    }
    export let g = (a, i) => a[i]
  `)
  const ptr = f()
  ok(isNaN(ptr))
  is(g(ptr, 0), 1)
  is(g(ptr, 8), 9)
})

// === NaN-boxing: encode/decode for all pointer types ===
// Each test uses an array to auto-include memory module, then tests pointer helpers

test('nan-box: ATOM (type=0)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(0, 0, 0)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, a, o] = f()
  is(t, 0); is(a, 0); is(o, 0)
})

test('nan-box: ARRAY (type=1, inline len)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(1, 100, 2048)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, a, o] = f()
  is(t, 1); is(a, 100); is(o, 2048)
})

test('nan-box: ARRAY_HEAP (type=2)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(2, 0, 4096)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, _, o] = f()
  is(t, 2); is(o, 4096)
})

test('nan-box: TYPED (type=3)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(3, 7, 8192)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, a, o] = f()
  is(t, 3); is(a, 7); is(o, 8192)
})

test('nan-box: STRING (type=4)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(4, 5, 1024)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, a, o] = f()
  is(t, 4); is(a, 5); is(o, 1024)
})

test('nan-box: STRING_SSO (type=5)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_type(__mkptr(5, 0, 0))
  }`)
  is(f(), 5)
})

test('nan-box: OBJECT (type=6)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(6, 42, 3072)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, a, o] = f()
  is(t, 6); is(a, 42); is(o, 3072)
})

test('nan-box: HASH (type=7)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_type(__mkptr(7, 0, 5000))
  }`)
  is(f(), 7)
})

test('nan-box: SET (type=8)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_type(__mkptr(8, 0, 6000))
  }`)
  is(f(), 8)
})

test('nan-box: MAP (type=9)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_type(__mkptr(9, 0, 7000))
  }`)
  is(f(), 9)
})

test('nan-box: CLOSURE (type=10)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(10, 255, 8000)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, a, o] = f()
  is(t, 10); is(a, 255); is(o, 8000)
})

test('nan-box: REGEX (type=11)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_type(__mkptr(11, 67, 0))
  }`)
  is(f(), 11)
})

// === Limits ===

test('nan-box: max aux (32767)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_aux(__mkptr(1, 32767, 0))
  }`)
  is(f(), 32767)
})

test('nan-box: large offset', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_offset(__mkptr(1, 0, 1048576))
  }`)
  is(f(), 1048576)  // 1MB
})

test('nan-box: pointer is NaN in JS', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __mkptr(1, 3, 1024)
  }`)
  ok(isNaN(f()))
  ok(typeof f() === 'number')
})

test('nan-box: JS roundtrip preserves bits', () => {
  const { mk, pt, pa, po } = run(`
    export let mk = () => {
      let a = [0]
      return __mkptr(6, 42, 3072)
    }
    export let pt = (p) => { let a = [0]; return __ptr_type(p) }
    export let pa = (p) => { let a = [0]; return __ptr_aux(p) }
    export let po = (p) => { let a = [0]; return __ptr_offset(p) }
  `)
  const p = mk()
  is(pt(p), 6)
  is(pa(p), 42)
  is(po(p), 3072)
})
