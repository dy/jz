// Phase 1: Block bodies, control flow, statements
import test from 'tst'
import { is, ok, throws, almost } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import math from '../module/math.js'

function run(code, opts) {
  const wasm = compile(code, opts)
  const mod = new WebAssembly.Module(wasm)
  return new WebAssembly.Instance(mod).exports
}

function hasSection(wasm, code) {
  const bytes = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm)
  let i = 8
  const readU32 = () => {
    let value = 0, shift = 0
    while (i < bytes.length) {
      const b = bytes[i++]
      value |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) return value
      shift += 7
    }
    return value
  }
  while (i < bytes.length) {
    const id = bytes[i++]
    const size = readU32()
    if (id === code) return true
    i += size
  }
  return false
}

// === Block body with let/return ===

test('block: let + return', () => {
  is(run('export let f = (x) => { let y = x * 2; return y + 1 }').f(3), 7)
})

test('block: multiple lets', () => {
  is(run('export let f = (x) => { let a = x + 1; let b = a * 2; return b }').f(3), 8)
})

test('block: const in body', () => {
  is(run('export let f = (x) => { const y = x * x; return y + 1 }').f(4), 17)
})

// === Assignment operators ===

test('assignment: =', () => {
  is(run('export let f = (x) => { let y = 0; y = x * 2; return y }').f(5), 10)
})

test('assignment: +=', () => {
  is(run('export let f = (x) => { let y = 10; y += x; return y }').f(5), 15)
})

test('assignment: -=', () => {
  is(run('export let f = (x) => { let y = 10; y -= x; return y }').f(3), 7)
})

test('assignment: *=', () => {
  is(run('export let f = (x) => { let y = 3; y *= x; return y }').f(4), 12)
})

test('assignment: /=', () => {
  is(run('export let f = (x) => { let y = 20; y /= x; return y }').f(4), 5)
})

test('assignment: >>=', () => {
  is(run('export let f = () => { let a = 256; a >>= 4; return a }').f(), 16)
})

test('assignment: <<=', () => {
  is(run('export let f = () => { let a = 1; a <<= 4; return a }').f(), 16)
})

test('assignment: &=', () => {
  is(run('export let f = () => { let a = 255; a &= 0x0F; return a }').f(), 15)
})

test('assignment: |=', () => {
  is(run('export let f = () => { let a = 0; a |= 5; return a }').f(), 5)
})

test('assignment: ^=', () => {
  is(run('export let f = () => { let a = 0xFF; a ^= 0x0F; return a }').f(), 240)
})

test('assignment: >>>=', () => {
  is(run('export let f = () => { let a = -1; a >>>= 24; return a }').f(), 255)
})

test('assignment: ||= on falsy', () => {
  is(run('export let f = () => { let a = 0; a ||= 42; return a }').f(), 42)
})

test('assignment: ||= on truthy', () => {
  is(run('export let f = () => { let a = 5; a ||= 42; return a }').f(), 5)
})

test('assignment: ||= keeps truthy strings', () => {
  is(run(`export let f = () => { let a = '\n'; a ||= ''; return (a + '(').length }`).f(), 2)
})

test('assignment: &&= on truthy', () => {
  is(run('export let f = () => { let a = 5; a &&= 42; return a }').f(), 42)
})

test('assignment: &&= updates truthy strings', () => {
  is(run(`export let f = () => { let a = 'x'; a &&= 'ok'; return a.length }`).f(), 2)
})

test('assignment: &&= on falsy', () => {
  is(run('export let f = () => { let a = 0; a &&= 42; return a }').f(), 0)
})

test('assignment: ??= on uninitialized local', () => {
  is(run('export let f = () => { let a; a ??= 42; return a }').f(), 42)
})

test('assignment: ??= on null', () => {
  is(run('export let f = () => { let a = null; a ??= 42; return a }').f(), 42)
})

test('assignment: ??= leaves 0 alone (not nullish)', () => {
  is(run('export let f = () => { let a = 0; a ??= 42; return a }').f(), 0)
})

test('assignment: ??= leaves defined value alone', () => {
  is(run('export let f = () => { let a = 5; a ??= 42; return a }').f(), 5)
})

// === Comma operator ===

test('comma: returns last value', () => {
  is(run('export let f = () => { let a = (1, 2, 3); return a }').f(), 3)
})

test('comma: side effects', () => {
  is(run('export let f = () => { let i = 0; i++, i++; return i }').f(), 2)
})

// === BigInt ===

test('bigint: literal + Number()', () => {
  is(run('export let f = () => Number(7n)').f(), 7)
})

test('bigint: arithmetic', () => {
  is(run('export let f = () => Number(3n + 4n)').f(), 7)
  is(run('export let f = () => Number(10n - 3n)').f(), 7)
  is(run('export let f = () => Number(6n * 7n)').f(), 42)
  is(run('export let f = () => Number(42n / 6n)').f(), 7)
  is(run('export let f = () => Number(17n % 10n)').f(), 7)
})

test('bigint: BigInt64Array reads remain BigInt-typed', () => {
  is(jz(`export let f = () => {
    const buf = new ArrayBuffer(8)
    const arr = new BigInt64Array(buf)
    arr[0] = BigInt('0x7fffffffffffffff')
    return arr[0] === BigInt('0x7fffffffffffffff')
  }`).exports.f(), 1)
})

test('bigint: bitwise', () => {
  is(run('export let f = () => Number(255n & 0x7Fn)').f(), 127)
  is(run('export let f = () => Number(0n | 5n)').f(), 5)
  is(run('export let f = () => Number(256n >> 4n)').f(), 16)
  is(run('export let f = () => Number(1n << 7n)').f(), 128)
})

test('bigint: hex literal', () => {
  is(run('export let f = () => Number(0xFFn)').f(), 255)
})

test('bigint: negative literal', () => {
  is(run('export let f = () => Number(-1n)').f(), -1)
})

test('bigint: BigInt.asIntN', () => {
  is(run('export let f = () => Number(BigInt.asIntN(32, 0xFFFFFFFFn))').f(), -1)
})

test('bigint: BigInt.asUintN', () => {
  is(run('export let f = () => Number(BigInt.asUintN(32, -1n))').f(), 4294967295)
})

test('bigint: typeof recognizes BigInt values', () => {
  is(jz('export let f = () => typeof BigInt("1") === "bigint"').exports.f(), 1)
})

test('bigint: same-kind ternary preserves BigInt type', () => {
  is(jz('export let f = (x) => Number(x ? BigInt("1") : BigInt("2"))').exports.f(1), 1)
})

test('bigint: typeof guard works through internal function parameter', () => {
  is(jz('const isBig = n => typeof n === "bigint"; export let f = () => isBig(BigInt("1"))').exports.f(), 1)
})

test('bigint: compares full unsigned 64-bit bounds', () => {
  is(jz('export let f = () => 0x7fffffffffffffffn > 0xffffffffffffffffn').exports.f(), 0)
  is(jz('export let f = () => 0xffffffffffffffffn > 0x7fffffffffffffffn').exports.f(), 1)
  is(jz('export let f = () => -1n < 0n').exports.f(), 1)
})

// === Number/Error builtins ===

test('Number(): identity', () => {
  is(run('export let f = (x) => Number(x)').f(42), 42)
})

test('Error(): throw', () => {
  throws(() => run('export let f = () => { throw Error("test") }').f())
})

test('Error(): throw surfaces readable message', () => {
  let error
  try {
    jz('export let f = () => { throw Error("test") }').exports.f()
  } catch (caught) {
    error = caught
  }
  ok(error instanceof Error)
  is(error.message, 'test')
})

test('try/catch: catches thrown value', () => {
  is(run('export let f = (x) => { try { if (x < 0) throw -1; return x * 2 } catch (e) { return e + 100 } }').f(-1), 99)
})

test('try/catch: no throw takes normal path', () => {
  is(run('export let f = (x) => { try { if (x < 0) throw -1; return x * 2 } catch (e) { return e + 100 } }').f(5), 10)
})

test('try/catch: non-throwing body emits portable wasm', () => {
  const wasm = compile('export let f = () => { try { return 1 } catch (e) { return 2 } }', { host: 'wasi' })
  is(hasSection(wasm, 13), false)
  is(new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports.f(), 1)
})

test('try/catch: thrown string', () => {
  is(run('export let f = () => { try { throw \"err\" } catch (e) { return e.length } }').f(), 3)
})

test('try/catch: nested', () => {
  is(run('export let f = (x) => { try { try { if (x < 0) throw -1; return x } catch (e) { throw e + 10 } } catch (e2) { return e2 + 100 } }').f(-1), 109)
})

test('try/finally: normal completion runs cleanup', () => {
  is(run('export let f = () => { let x = 1; try { x += 2 } finally { x *= 10 }; return x }').f(), 30)
})

test('try/finally: non-throwing body emits portable wasm', () => {
  const wasm = compile('export let f = () => { let x = 1; try { x += 2 } finally { x *= 10 }; return x }', { host: 'wasi' })
  is(hasSection(wasm, 13), false)
  is(new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports.f(), 30)
})

test('try/finally: throw runs cleanup before catch', () => {
  is(run('export let f = () => { let x = 0; try { try { throw 2 } finally { x += 10 } } catch (e) { return x + e } }').f(), 12)
})

test('try/finally: return preserves returned value and runs cleanup', () => {
  is(run('export let f = () => { let x = 1; try { return x } finally { x = 9 } }').f(), 1)
})

test('try/finally: finally return overrides return', () => {
  is(run('export let f = () => { try { return 1 } finally { return 2 } }').f(), 2)
})

test('try/finally: finally throw overrides return', () => {
  is(run('export let f = () => { try { try { return 1 } finally { throw 2 } } catch (e) { return e } }').f(), 2)
})

test('try/catch/finally: cleanup runs after handled throw', () => {
  is(run('export let f = () => { let x = 0; try { throw 2 } catch (e) { x = e } finally { x += 10 }; return x }').f(), 12)
})

test('try/catch/finally: cleanup runs on normal completion', () => {
  is(run('export let f = () => { let x = 0; try { x = 5 } catch (e) { x = -1 } finally { x += 10 }; return x }').f(), 15)
})

test('try/finally: nested finally runs inner to outer', () => {
  is(run('export let f = () => { let x = 0; try { try { x += 1 } finally { x += 10 } } finally { x += 100 }; return x }').f(), 111)
})

test('try/finally: nested finally on throw runs all cleanups', () => {
  is(run('export let f = () => { let x = 0; try { try { throw 1 } finally { x += 10 } } catch (e) { x += e } finally { x += 100 }; return x }').f(), 111)
})

test('try/finally: break in finally', () => {
  is(run('export let f = () => { let s = 0; for (let i = 0; i < 5; i++) { try { s += i } finally { if (i === 2) break } }; return s }').f(), 3)
})

test('try/finally: continue in finally', () => {
  is(run('export let f = () => { let s = 0; for (let i = 0; i < 5; i++) { try { if (i === 2) continue; s += i } finally { s += 10 } }; return s }').f(), 58)
})

test('try/finally: finally with side effects on local', () => {
  is(run('export let f = (x) => { let r = 0; try { r = x * 2 } finally { r += 1 }; return r }').f(5), 11)
})

test('try/catch/finally: catch rethrow triggers finally', () => {
  is(run('export let f = () => { let x = 0; try { try { throw 1 } catch (e) { throw e + 10 } finally { x += 100 } } catch (e2) { return x + e2 } }').f(), 111)
})

test('try/finally: multiple returns — last finally wins', () => {
  is(run('export let f = () => { try { try { return 1 } finally { return 2 } } finally { return 3 } }').f(), 3)
})

test('try/catch/finally: error in catch still triggers finally', () => {
  let err
  try { run('export let f = () => { try { throw 1 } catch (e) { throw e + 10 } finally {} }').f() } catch (e) { err = e }
  ok(err != null, 'catch re-throw should propagate through finally')
})

// === Timers ===

test('setTimeout: callback fires', async () => {
  const result = jz(`
    export let start = () => {
      setTimeout(() => console.log('timer-fired'), 10)
      return 1
    }
  `)
  is(result.exports.start(), 1)
  await new Promise(r => setTimeout(r, 50))
})

test('setTimeout: returns timer ID', () => {
  const result = jz(`
    export let start = () => {
      let id = setTimeout(() => {}, 10)
      return id
    }
  `)
  const id = result.exports.start()
  ok(typeof id === 'number' && id > 0)
})

test('clearTimeout: prevents callback', async () => {
  const result = jz(`
    export let fired = 0
    export let start = () => {
      let id = setTimeout(() => { fired = 1 }, 10)
      clearTimeout(id)
      return 1
    }
  `)
  is(result.exports.start(), 1)
  await new Promise(r => setTimeout(r, 50))
  is(result.exports.fired.value, 0)
})

test('setInterval: returns timer ID', () => {
  const result = jz(`
    export let start = () => {
      let id = setInterval(() => {}, 10)
      clearInterval(id)
      return id
    }
  `)
  const id = result.exports.start()
  ok(typeof id === 'number' && id > 0)
})

test('clearInterval: stops interval', async () => {
  const result = jz(`
    export let count = 0
    export let start = () => {
      let id = setInterval(() => { count = count + 1 }, 20)
      setTimeout(() => { clearInterval(id) }, 70)
      return 1
    }
  `)
  is(result.exports.start(), 1)
  await new Promise(r => setTimeout(r, 120))
  // Interval fires at ~20, 40, 60ms; cleared at 70ms → 3 ticks
  is(result.exports.count.value, 3)
})

test('timer callback captures outer scope', async () => {
  const result = jz(`
    export let result = 0
    export let start = () => {
      let x = 41
      setTimeout(() => { result = x + 1 }, 10)
      return 1
    }
  `)
  is(result.exports.start(), 1)
  await new Promise(r => setTimeout(r, 50))
  is(result.exports.result.value, 42)
})

test('multiple simultaneous timers', async () => {
  const result = jz(`
    export let a = 0, b = 0
    export let start = () => {
      setTimeout(() => { a = 1 }, 10)
      setTimeout(() => { b = 2 }, 20)
      return 1
    }
  `)
  is(result.exports.start(), 1)
  await new Promise(r => setTimeout(r, 50))
  is(result.exports.a.value, 1)
  is(result.exports.b.value, 2)
})

// host: 'js' setTimeout/setInterval lower to env imports + __invoke_closure
// trampoline (no in-wasm queue). Lock the surface in.
test('host:js timers: env.setTimeout/clearTimeout imports, __invoke_closure export', () => {
  const wasm = compile(`
    setTimeout(() => {}, 10)
    setInterval(() => {}, 5)
    clearTimeout(1)
    clearInterval(1)
    export let f = () => 1
  `)
  const mod = new WebAssembly.Module(wasm)
  const imports = WebAssembly.Module.imports(mod).map(i => i.module + '.' + i.name).sort()
  const exports = WebAssembly.Module.exports(mod).map(e => e.name)
  ok(imports.includes('env.setTimeout'), `expected env.setTimeout: ${imports}`)
  ok(imports.includes('env.clearTimeout'), `expected env.clearTimeout: ${imports}`)
  ok(!imports.some(i => i.includes('clock_time_get')), `should not import clock_time_get: ${imports}`)
  ok(exports.includes('__invoke_closure'), `expected __invoke_closure export: ${exports}`)
  ok(!exports.includes('__timer_tick'), `should not export __timer_tick: ${exports}`)
})

test('host:js timers import only the requested host functions', () => {
  const timeoutMod = new WebAssembly.Module(compile(`setTimeout(() => {}, 10); export let f = () => 1`))
  const timeoutImports = WebAssembly.Module.imports(timeoutMod).map(i => i.module + '.' + i.name).sort()
  ok(timeoutImports.includes('env.setTimeout'), `expected env.setTimeout: ${timeoutImports}`)
  ok(!timeoutImports.includes('env.clearTimeout'), `setTimeout should not import env.clearTimeout: ${timeoutImports}`)

  const clearMod = new WebAssembly.Module(compile(`clearTimeout(1); export let f = () => 1`))
  const clearImports = WebAssembly.Module.imports(clearMod).map(i => i.module + '.' + i.name).sort()
  ok(clearImports.includes('env.clearTimeout'), `expected env.clearTimeout: ${clearImports}`)
  ok(!clearImports.includes('env.setTimeout'), `clearTimeout should not import env.setTimeout: ${clearImports}`)

  const clearOnly = jz(`clearTimeout(1); clearInterval(1); export let f = () => 1`)
  is(clearOnly.exports.f(), 1)
})

// === Auto-boxing: property assignment ===

test('fn.prop: auto-box write + read', () => {
  const { g } = run(`
    export let f = (x) => x
    f.loc = 42
    export let g = () => f.loc
  `)
  is(g(), 42)
})

test('fn.prop: auto-box write/read from functions', () => {
  const { set, get } = run(`
    export let err = (msg) => { throw msg }
    err.loc = 0
    export let set = (v) => { err.loc = v }
    export let get = () => err.loc
  `)
  is(get(), 0)
  set(42)
  is(get(), 42)
})

test('fn.prop: function still callable after boxing', () => {
  is(run(`
    export let f = (x) => x + 1
    f.tag = 0
    export let g = () => f(41)
  `).g(), 42)
})

test('fn.prop: arrow extraction + direct call', () => {
  is(run(`
    export let i32 = (n) => n + 1
    i32.parse = (s) => s * 2
    export let f = () => i32.parse(21)
  `).f(), 42)
})

test('auto-box: local array property', () => {
  is(run('export let f = () => { let a = [1, 2, 3]; a.x = 99; return a.x }').f(), 99)
})

test('auto-box: local array .length after boxing', () => {
  is(run('export let f = () => { let a = [10, 20, 30]; a.tag = 1; return a.length }').f(), 3)
})

test('auto-box: local array indexing after boxing', () => {
  is(run('export let f = () => { let a = [10, 20, 30]; a.tag = 1; return a[0] + a[1] + a[2] }').f(), 60)
})

test('auto-box: arrow property call (valueOf pattern)', () => {
  is(run('export let f = () => { let a = [1,2]; a.myFn = () => 99; return a.myFn() }').f(), 99)
})

// === If/else ===

test('if: early return', () => {
  const { f } = run('export let f = (x) => { if (x > 0) return x; return -x }')
  is(f(5), 5)
  is(f(-3), 3)
})

test('if-else: both branches return', () => {
  const { f } = run('export let f = (x) => { if (x > 0) return 1; else return -1 }')
  is(f(5), 1)
  is(f(-5), -1)
})

test('if: comparison ==', () => {
  const { f } = run('export let f = (x) => { if (x == 0) return 42; return x }')
  is(f(0), 42)
  is(f(7), 7)
})

// === Prefix/postfix increment ===

test('prefix ++i returns new', () => {
  is(run('export let f = () => { let i = 5; return ++i }').f(), 6)
})

test('postfix i++ returns old', () => {
  is(run('export let f = () => { let i = 5; return i++ }').f(), 5)
})

test('prefix --i returns new', () => {
  is(run('export let f = () => { let i = 5; return --i }').f(), 4)
})

test('postfix i-- returns old', () => {
  is(run('export let f = () => { let i = 5; return i-- }').f(), 5)
})

test('assign postfix: x = i++', () => {
  is(run('export let f = () => { let i = 5; let x = i++; return x }').f(), 5)
})

test('assign prefix: x = ++i', () => {
  is(run('export let f = () => { let i = 5; let x = ++i; return x }').f(), 6)
})

test('postfix increments side effect', () => {
  is(run('export let f = () => { let i = 5; i++; return i }').f(), 6)
})

test('array[i++] uses old index', () => {
  is(run('export let f = () => { let a = [10, 20, 30]; let i = 1; return a[i++] }').f(), 20)
})

// === NaN truthiness ===

test('if(NaN) is falsy', () => {
  is(run('export let f = (x) => { if (x) return 1; return 0 }').f(NaN), 0)
})

test('!NaN is true', () => {
  is(run('export let f = (x) => { if (!x) return 1; return 0 }').f(NaN), 1)
})

test('NaN && 1 returns NaN (falsy short-circuit)', () => {
  ok(isNaN(run('export let f = (x) => x && 1').f(NaN)))
})

test('NaN || 1 returns 1 (falsy fallthrough)', () => {
  is(run('export let f = (x) => x || 1').f(NaN), 1)
})

test('1 && NaN returns NaN (truthy passes through)', () => {
  ok(isNaN(run('export let f = (x) => 1 && x').f(NaN)))
})

test('1 || NaN returns 1 (truthy short-circuit)', () => {
  is(run('export let f = (x) => 1 || x').f(NaN), 1)
})

test('NaN ?: constant-folded correctly', () => {
  is(run('export let f = () => NaN ? 1 : 2').f(), 2)
})

test('if(NaN) constant-folded correctly', () => {
  is(run('export let f = () => { if (NaN) return 1; return 2 }').f(), 2)
})

test('void preserves side effects', () => {
  is(run('export let f = () => { let x = 0; void (x = 5); return x }').f(), 5)
})

test('void returns undefined', () => {
  is(jz('export let f = () => void 42').exports.f(), undefined)
})

test('strict mode prohibits void', () => {
  throws(() => run('export let f = () => void 42', { strict: true }), /strict mode: `void` is prohibited/)
})

// NOTE: subscript/jessie parses `undefined` as empty AST `[]`, so it never reaches
// prepare's strict-mode check. The behavior is correct (returns 0 / null).

// === null/undefined semantics ===

test('undefined keyword returns undefined', () => {
  const r = jz('export let f = () => undefined')
  is(r.exports.f(), undefined)
})

test('null keyword returns null', () => {
  const r = jz('export let f = () => null')
  is(r.exports.f(), null)
})

test('null and undefined are both nullish inside jz', () => {
  const r = jz('export let f = (x) => x == null')
  is(r.exports.f(null), 1)
  is(r.exports.f(undefined), 1)
  is(r.exports.f(0), 0)
})

test('null === undefined: both nullish, == and === treat them equal', () => {
  // jz merges === → ==; null and undefined are both nullish so compare equal
  const r = jz('export let f = () => null === undefined')
  is(r.exports.f(), 1)
})

test('?? triggers on null/undefined', () => {
  const r = jz('export let f = (x) => x ?? 42')
  is(r.exports.f(null), 42)
  is(r.exports.f(undefined), 42)
  is(r.exports.f(0), 0)
  is(r.exports.f(10), 10)
})

test('default params trigger only on undefined (per ES spec)', () => {
  const r = jz('export let f = (x = 99) => x')
  is(r.exports.f(), 99)
  is(r.exports.f(null), null)
  is(r.exports.f(undefined), 99)
  is(r.exports.f(5), 5)
})

test('host boundary: null and undefined preserve identity', () => {
  const r = jz('export let id = (x) => x')
  is(r.exports.id(null), null)
  is(r.exports.id(undefined), undefined)
  is(r.exports.id(42), 42)
})

test('host boundary: returning null vs undefined', () => {
  const r = jz('export let n = () => null; export let u = () => undefined')
  is(r.exports.n(), null)
  is(typeof r.exports.n(), 'object')
  is(r.exports.u(), undefined)
  is(typeof r.exports.u(), 'undefined')
})

// === for...of ===

test('for...of: sum array', () => {
  is(run('export let f = () => { let s = 0; for (let x of [1, 2, 3]) s += x; return s }').f(), 6)
})

test('for...of: named array', () => {
  is(run('export let f = () => { let a = [5, 10, 15]; let s = 0; for (let x of a) s += x; return s }').f(), 30)
})

test('for...of: early return', () => {
  is(run('export let f = () => { for (let x of [1, 2, 3]) { if (x > 1) return x }; return 0 }').f(), 2)
})

// === for...in ===

// === typeof string comparisons ===

test('typeof: number check', () => {
  is(run('export let f = (x) => typeof x === "number"').f(42), 1)
  is(run('export let f = () => typeof "hello" === "number"').f(), 0)
})

test('typeof: string check', () => {
  is(run('export let f = () => typeof "hello" === "string"').f(), 1)
  is(run('export let f = () => typeof 42 === "string"').f(), 0)
})

test('typeof: undefined check', () => {
  is(run('export let f = () => typeof null === "undefined"').f(), 1)
  is(run('export let f = () => typeof 1 === "undefined"').f(), 0)
})

test('=== alias for ==', () => {
  is(run('export let f = (a, b) => a === b').f(3, 3), 1)
  is(run('export let f = (a, b) => a !== b').f(3, 4), 1)
})

test('for...in: count keys', () => {
  is(run('export let f = () => { let o = {x: 1, y: 2, z: 3}; let c = 0; for (let k in o) c++; return c }').f(), 3)
})

test('if(0) still falsy', () => {
  is(run('export let f = (x) => { if (x) return 1; return 0 }').f(0), 0)
})

test('if(1) still truthy', () => {
  is(run('export let f = (x) => { if (x) return 1; return 0 }').f(1), 1)
})

// === Ternary ===

test('ternary: a ? b : c', () => {
  const { f } = run('export let f = (x) => x > 0 ? x : 0')
  is(f(5), 5)
  is(f(-3), 0)
})

// === For loop ===

test('for: sum 0..n', () => {
  const { f } = run(`export let f = (n) => {
    let s = 0
    for (let i = 0; i < n; i++) s += i
    return s
  }`)
  is(f(0), 0)
  is(f(1), 0)
  is(f(5), 10)  // 0+1+2+3+4
  is(f(10), 45)
})

test('for: factorial', () => {
  const { f } = run(`export let f = (n) => {
    let r = 1
    for (let i = 1; i <= n; i++) r *= i
    return r
  }`)
  is(f(0), 1)
  is(f(1), 1)
  is(f(5), 120)
})

test('for: nested', () => {
  // sum of i*j for i=0..a, j=0..b
  const { f } = run(`export let f = (a, b) => {
    let s = 0
    for (let i = 0; i < a; i++)
      for (let j = 0; j < b; j++)
        s += i * j
    return s
  }`)
  is(f(3, 3), 9)  // (0*0+0*1+0*2) + (1*0+1*1+1*2) + (2*0+2*1+2*2) = 0+3+6
})

// === Do-while loop (jzify lowers to for + once-flag) ===

test('do-while: basic', () => {
  const { f } = run(`export let f = (n) => {
    let s = 0, i = 0
    do { s += i; i++ } while (i < n)
    return s
  }`, { jzify: true })
  is(f(5), 10)
  is(f(0), 0)
})

test('do-while: executes body at least once', () => {
  is(run('export let f = () => { let x = 0; do { x++ } while (0); return x }', { jzify: true }).f(), 1)
})

test('do-while: break', () => {
  is(run('export let f = () => { let s = 0; do { s++; if (s == 3) break } while (1); return s }', { jzify: true }).f(), 3)
})

test('do-while: continue runs cond, not body', () => {
  // JS semantics: continue branches to cond test; body never runs again unless cond true.
  // The desugared form uses for(_once; _once||cond; _once=false), so continue → step → cond.
  const { f } = run(`export let f = () => {
    let s = 0, i = 0
    do { i++; if (i == 3) continue; s += i } while (i < 5)
    return s
  }`, { jzify: true })
  is(f(), 12)  // 1+2+4+5 = 12 (skip 3)
})

test('do-while: continue at terminating cond exits cleanly (no infinite loop)', () => {
  // Regression for the naive `loop { body; br_if loop cond }` shape:
  // continue would jump past the cond check, re-running body → infinite loop.
  const { f } = run(`export let f = () => {
    let count = 0
    do { count++; if (count >= 3) continue } while (count < 3)
    return count
  }`, { jzify: true })
  is(f(), 3)
})

test('do-while: nested', () => {
  const { f } = run(`export let f = () => {
    let s = 0, i = 0
    do {
      let j = 0
      do { s++; j++ } while (j < 3)
      i++
    } while (i < 2)
    return s
  }`, { jzify: true })
  is(f(), 6)  // 2 outer × 3 inner
})

test('break: exits loop', () => {
  is(run('export let f = () => { let s = 0; for (let i = 0; i < 5; i++) { if (i == 3) break; s += i } return s }').f(), 3)
})

test('continue: skips iteration', () => {
  is(run('export let f = () => { let s = 0; for (let i = 0; i < 5; i++) { if (i == 2) continue; s += i } return s }').f(), 8)
})

test('try/finally: break runs cleanup before exit', () => {
  is(run('export let f = () => { let s = 0; for (let i = 0; i < 5; i++) { try { if (i == 2) break; s += i } finally { s += 10 } } return s }').f(), 31)
})

test('try/finally: continue runs cleanup before next iteration', () => {
  is(run('export let f = () => { let s = 0; for (let i = 0; i < 3; i++) { try { if (i == 1) continue; s += i } finally { s += 10 } } return s }').f(), 32)
})

// === Logical operators ===

test('&&: short-circuit', () => {
  is(run('export let f = (a, b) => a && b').f(3, 5), 5)
  is(run('export let f = (a, b) => a && b').f(0, 5), 0)
})

test('||: short-circuit', () => {
  is(run('export let f = (a, b) => a || b').f(3, 5), 3)
  is(run('export let f = (a, b) => a || b').f(0, 5), 5)
})

test('&&: chained', () => {
  is(run('export let f = (a, b, c) => a && b && c').f(1, 2, 3), 3)
  is(run('export let f = (a, b, c) => a && b && c').f(1, 0, 3), 0)
})

test('||: chained', () => {
  is(run('export let f = (a, b, c) => a || b || c').f(0, 0, 3), 3)
  is(run('export let f = (a, b, c) => a || b || c').f(0, 2, 3), 2)
})

// === Combined patterns ===

test('abs via if', () => {
  const { f } = run('export let f = (x) => { if (x < 0) return -x; return x }')
  is(f(5), 5)
  is(f(-5), 5)
  is(f(0), 0)
})

test('clamp via if', () => {
  const { f } = run(`export let f = (x, lo, hi) => {
    if (x < lo) return lo
    if (x > hi) return hi
    return x
  }`)
  is(f(5, 0, 10), 5)
  is(f(-1, 0, 10), 0)
  is(f(15, 0, 10), 10)
})

test('power via loop', () => {
  // x^n via repeated multiplication
  const { f } = run(`export let f = (x, n) => {
    let r = 1
    for (let i = 0; i < n; i++) r *= x
    return r
  }`)
  is(f(2, 0), 1)
  is(f(2, 10), 1024)
  is(f(3, 4), 81)
})

test('with math module', () => {
  const { f } = run(`export let f = (x) => {
    let y = Math.abs(x)
    return Math.sqrt(y)
  }`, { modules: [math] })
  is(f(16), 4)
  is(f(-16), 4)
})

test('inter-function call from block body', () => {
  const { f } = run(`
    let square = x => x * x
    export let f = (x) => {
      let y = square(x)
      return y + 1
    }
  `)
  is(f(3), 10)
  is(f(5), 26)
})
